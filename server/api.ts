import type { FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { AppDb } from "./db.js";
import { counts, getSetting, listEvents, setSetting } from "./db.js";
import type { RadarrClient } from "./radarr.js";
import type { SonarrClient } from "./sonarr.js";
import type { SeasonDebouncer } from "./debouncer.js";
import type { Bus, BusTopic } from "./bus.js";
import {
  JellyfinClient,
  WEBHOOK_PLUGIN_ID,
  buildGenericOption,
  upsertGenericOption,
  type GenericOption,
} from "./jellyfin.js";

export type ApiDeps = {
  config: Config;
  db: AppDb;
  radarr: RadarrClient;
  sonarr: SonarrClient;
  debouncer: SeasonDebouncer;
  bus: Bus;
  startedAt: number;
};

function effectiveDryRun(db: AppDb, cfg: Config): boolean {
  const override = getSetting(db, "dry_run");
  if (override === undefined) return cfg.DRY_RUN;
  return override === "1";
}

export function registerApi(app: FastifyInstance, deps: ApiDeps) {
  app.get("/api/status", async () => {
    const [radarr, sonarr] = await Promise.all([
      deps.radarr.ping(),
      deps.sonarr.ping(),
    ]);
    return {
      uptimeMs: Date.now() - deps.startedAt,
      dryRun: effectiveDryRun(deps.db, deps.config),
      dryRunSource:
        getSetting(deps.db, "dry_run") !== undefined ? "override" : "env",
      radarr,
      sonarr,
      counts: counts(deps.db),
      pendingBuckets: deps.debouncer.snapshot().length,
      debounceMs: deps.config.SEASON_DEBOUNCE_MS,
    };
  });

  app.get("/api/events", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = q.limit ? Number(q.limit) : 50;
    const offset = q.offset ? Number(q.offset) : 0;
    const outcome = q.outcome && q.outcome !== "all" ? q.outcome : undefined;
    const itemType =
      q.itemType && q.itemType !== "all" ? q.itemType : undefined;
    return listEvents(deps.db, { limit, offset, outcome, itemType });
  });

  app.get("/api/pending", async () => {
    return { buckets: deps.debouncer.snapshot() };
  });

  app.post("/api/dry-run", async (req, reply) => {
    const body = req.body as { enabled?: boolean } | undefined;
    if (typeof body?.enabled !== "boolean") {
      reply.code(400);
      return { error: "body must be { enabled: boolean }" };
    }
    setSetting(deps.db, "dry_run", body.enabled ? "1" : "0");
    deps.bus.emit("status_changed");
    return { ok: true, dryRun: body.enabled };
  });

  app.get("/api/stream", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (topic: BusTopic) => {
      reply.raw.write(`event: ${topic}\ndata: {}\n\n`);
    };

    // Greet + send initial ping so the client knows the stream is live
    reply.raw.write(`: connected\n\n`);

    const offs = [
      deps.bus.on("event_created", () => send("event_created")),
      deps.bus.on("status_changed", () => send("status_changed")),
      deps.bus.on("pending_changed", () => send("pending_changed")),
    ];

    // Heartbeat every 25s keeps proxies from closing idle connections.
    const heartbeat = setInterval(() => {
      reply.raw.write(`: heartbeat\n\n`);
    }, 25_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      offs.forEach((off) => off());
    });
  });

  app.get("/api/settings", async () => {
    return {
      port: deps.config.PORT,
      radarrUrl: deps.config.RADARR_URL,
      sonarrUrl: deps.config.SONARR_URL,
      radarrApiKeyPreview: maskKey(deps.config.RADARR_API_KEY),
      sonarrApiKeyPreview: maskKey(deps.config.SONARR_API_KEY),
      webhookSecretPreview: maskKey(deps.config.WEBHOOK_SECRET),
      dryRunEnv: deps.config.DRY_RUN,
      seasonDebounceMs: deps.config.SEASON_DEBOUNCE_MS,
      eventsRetentionDays: deps.config.EVENTS_RETENTION_DAYS,
      logLevel: deps.config.LOG_LEVEL,
    };
  });
}

function maskKey(k: string): string {
  if (k.length <= 8) return "•".repeat(k.length);
  return `${k.slice(0, 4)}${"•".repeat(Math.max(4, k.length - 8))}${k.slice(-4)}`;
}

/** Register Jellyfin integration endpoints on an already-initialized Fastify instance. */
export function registerJellyfinApi(
  app: FastifyInstance,
  deps: ApiDeps,
) {
  function getStoredJellyfin(): { url: string | null; apiKey: string | null } {
    return {
      url: getSetting(deps.db, "jellyfin_url") ?? null,
      apiKey: getSetting(deps.db, "jellyfin_api_key") ?? null,
    };
  }

  function makeClient(): JellyfinClient | null {
    const { url, apiKey } = getStoredJellyfin();
    if (!url || !apiKey) return null;
    return new JellyfinClient(url, apiKey);
  }

  function defaultWebhookUri(): string {
    // Jellyfin container reaches the host (and thus cleanarr's bound port) via
    // host.docker.internal on Docker Desktop. Callers can override.
    return `http://host.docker.internal:${deps.config.PORT}/webhook`;
  }

  app.get("/api/jellyfin/status", async () => {
    const { url, apiKey } = getStoredJellyfin();
    if (!url || !apiKey) {
      return { configured: false, reason: "no url/key saved" };
    }
    const client = new JellyfinClient(url, apiKey);
    const info = await client.systemInfo();
    if (!info) {
      return {
        configured: false,
        url,
        apiKeyPreview: maskKey(apiKey),
        reason: "could not connect",
      };
    }
    let plugin = null;
    let destinationPresent = false;
    let templateMatches = false;
    try {
      plugin = await client.findWebhookPlugin();
      if (plugin) {
        const cfg = await client.getPluginConfig(plugin.Id);
        const ours = (cfg.GenericOptions ?? []).find(
          (o: GenericOption) => o.WebhookName === "cleanarr",
        );
        destinationPresent = !!ours;
        templateMatches =
          !!ours && ours.WebhookUri === defaultWebhookUri();
      }
    } catch {
      // probe errors are non-fatal; surface them as "not configured"
    }
    return {
      configured: destinationPresent && !!plugin,
      url,
      apiKeyPreview: maskKey(apiKey),
      version: info.Version,
      serverId: info.Id,
      pluginInstalled: !!plugin,
      pluginVersion: plugin?.Version,
      pluginStatus: plugin?.Status,
      destinationPresent,
      templateMatches,
      webhookUri: defaultWebhookUri(),
    };
  });

  app.post("/api/jellyfin/connect", async (req, reply) => {
    const body = req.body as { url?: string; apiKey?: string } | undefined;
    if (!body?.url || !body?.apiKey) {
      reply.code(400);
      return { error: "body must be { url, apiKey }" };
    }
    const url = body.url.replace(/\/$/, "");
    const client = new JellyfinClient(url, body.apiKey);
    const info = await client.systemInfo();
    if (!info) {
      reply.code(502);
      return {
        error:
          "could not reach Jellyfin — check that cleanarr's container can resolve this URL (try http://host.docker.internal:8096)",
      };
    }
    setSetting(deps.db, "jellyfin_url", url);
    setSetting(deps.db, "jellyfin_api_key", body.apiKey);
    deps.bus.emit("status_changed");
    return { ok: true, version: info.Version, serverId: info.Id };
  });

  app.post("/api/jellyfin/setup", async (req, reply) => {
    const client = makeClient();
    if (!client) {
      reply.code(400);
      return { error: "Jellyfin URL/key not configured — call /connect first" };
    }

    const body = req.body as { webhookUri?: string } | undefined;
    const webhookUri = (body?.webhookUri ?? defaultWebhookUri()).replace(/\/$/, "");
    const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];

    // 1. Ensure plugin installed
    let plugin = await client.findWebhookPlugin();
    if (!plugin) {
      try {
        await client.installWebhookPlugin();
        steps.push({ step: "install", ok: true });
      } catch (err) {
        steps.push({
          step: "install",
          ok: false,
          detail: (err as Error).message,
        });
        reply.code(502);
        return { ok: false, steps };
      }

      // 2. Restart to load the plugin
      try {
        await client.restart();
        steps.push({ step: "restart-post-install", ok: true });
      } catch (err) {
        steps.push({
          step: "restart-post-install",
          ok: false,
          detail: (err as Error).message,
        });
        reply.code(502);
        return { ok: false, steps };
      }

      // 3. Wait for Jellyfin to come back
      const online = await client.waitForOnline();
      steps.push({
        step: "wait-online",
        ok: online,
        detail: online ? undefined : "timed out after 90s",
      });
      if (!online) {
        reply.code(502);
        return { ok: false, steps };
      }

      plugin = await client.findWebhookPlugin();
      if (!plugin) {
        steps.push({
          step: "locate-plugin",
          ok: false,
          detail: "plugin not found after install+restart",
        });
        reply.code(502);
        return { ok: false, steps };
      }
    } else {
      steps.push({ step: "install", ok: true, detail: "already installed" });
    }

    // 4. Read + upsert + write configuration
    let cfg;
    try {
      cfg = await client.getPluginConfig(plugin.Id);
      steps.push({ step: "fetch-config", ok: true });
    } catch (err) {
      steps.push({
        step: "fetch-config",
        ok: false,
        detail: (err as Error).message,
      });
      reply.code(502);
      return { ok: false, steps };
    }

    const entry = buildGenericOption({
      webhookUri,
      secret: deps.config.WEBHOOK_SECRET,
    });
    const updated = upsertGenericOption(cfg, entry);

    try {
      await client.putPluginConfig(plugin.Id, updated);
      steps.push({ step: "write-config", ok: true });
    } catch (err) {
      steps.push({
        step: "write-config",
        ok: false,
        detail: (err as Error).message,
      });
      reply.code(502);
      return { ok: false, steps };
    }

    // 5. Final restart so the plugin picks up the new destination reliably.
    try {
      await client.restart();
      steps.push({ step: "restart-post-config", ok: true });
      const online = await client.waitForOnline();
      steps.push({
        step: "wait-online",
        ok: online,
        detail: online ? undefined : "timed out after 90s",
      });
    } catch (err) {
      steps.push({
        step: "restart-post-config",
        ok: false,
        detail: (err as Error).message,
      });
    }

    deps.bus.emit("status_changed");
    return { ok: true, webhookUri, steps };
  });

  app.post("/api/jellyfin/disconnect", async () => {
    setSetting(deps.db, "jellyfin_url", "");
    setSetting(deps.db, "jellyfin_api_key", "");
    deps.bus.emit("status_changed");
    return { ok: true };
  });
}
