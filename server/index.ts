import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { openDb, pruneOldEvents } from "./db.js";
import { RadarrClient } from "./radarr.js";
import { SonarrClient } from "./sonarr.js";
import { SeasonDebouncer } from "./debouncer.js";
import { registerWebhook, makeSeasonFlush, type WebhookDeps } from "./webhook.js";
import { registerApi, registerJellyfinApi } from "./api.js";
import { Bus } from "./bus.js";
import { JellyfinClient } from "./jellyfin.js";
import { getSetting } from "./db.js";

const config = loadConfig();
const db = openDb(config.DATA_DIR);
const startedAt = Date.now();

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } },
  },
  trustProxy: true,
  bodyLimit: 1024 * 1024, // 1MB — webhook payloads are tiny
});

const radarr = new RadarrClient(config.RADARR_URL, config.RADARR_API_KEY);
const sonarr = new SonarrClient(config.SONARR_URL, config.SONARR_API_KEY);
const bus = new Bus();

// Lazily wire debouncer + webhook so we can share the flush handler.
// The flush handler needs the same deps object, so construct in two steps.
const deps = {
  config,
  db,
  radarr,
  sonarr,
  bus,
  log: app.log,
} as Omit<WebhookDeps, "debouncer">;

const debouncer = new SeasonDebouncer(config.SEASON_DEBOUNCE_MS, async (k, ev) => {
  await flushHandler(k, ev);
  bus.emit("pending_changed");
});

const fullDeps: WebhookDeps = { ...deps, debouncer };
const flushHandler = makeSeasonFlush(fullDeps);

registerWebhook(app, fullDeps);
const apiDeps = { ...fullDeps, startedAt };
registerApi(app, apiDeps);
registerJellyfinApi(app, apiDeps);

// --- Static UI ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(__dirname, "../ui");
try {
  await app.register(fastifyStatic, {
    root: uiDir,
    prefix: "/",
    decorateReply: false,
  });

  // SPA fallback — any non-/api, non-/webhook GET serves index.html
  app.setNotFoundHandler((req, reply) => {
    if (
      req.method === "GET" &&
      !req.url.startsWith("/api") &&
      !req.url.startsWith("/webhook")
    ) {
      return reply.sendFile("index.html");
    }
    reply.code(404).send({ error: "not found" });
  });
} catch (err) {
  app.log.warn({ err }, "UI bundle not found — running headless");
}

// --- Retention job ---
setInterval(
  () => {
    const removed = pruneOldEvents(db, config.EVENTS_RETENTION_DAYS);
    if (removed > 0) app.log.info({ removed }, "pruned old events");
  },
  60 * 60 * 1000, // hourly
);

// --- Jellyfin drain-task poller ---
// The Webhook plugin queues ItemDeleted events and drains them via a scheduled
// task ("WebhookItemDeleted") that should fire every 30s. On some installs the
// interval trigger doesn't auto-run, so we nudge it from here.
let cachedDrainTaskId: string | null = null;
async function drainJellyfinWebhookQueue() {
  const url = getSetting(db, "jellyfin_url");
  const key = getSetting(db, "jellyfin_api_key");
  if (!url || !key) return;
  const client = new JellyfinClient(url, key);
  try {
    if (!cachedDrainTaskId) {
      cachedDrainTaskId = await client.findScheduledTaskId("WebhookItemDeleted");
      if (!cachedDrainTaskId) return;
    }
    await client.runScheduledTask(cachedDrainTaskId);
  } catch (err) {
    app.log.debug({ err }, "jellyfin drain task nudge failed");
    // Reset so a renamed task / restart resyncs next round.
    cachedDrainTaskId = null;
  }
}
setInterval(drainJellyfinWebhookQueue, 20_000);
// also fire one soon after boot
setTimeout(drainJellyfinWebhookQueue, 5_000);

// --- Graceful shutdown ---
async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  try {
    await debouncer.flushAll();
    await app.close();
    db.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

app.listen({ host: "0.0.0.0", port: config.PORT }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(
    { address, dryRun: config.DRY_RUN },
    "cleanarr listening",
  );
});
