type Fetch = typeof fetch;

/** Official Webhook plugin GUID, from WebhookPlugin.cs. */
export const WEBHOOK_PLUGIN_ID = "71552a5a-5c5c-4350-a2ae-ebe451a30173";
export const WEBHOOK_PLUGIN_NAME = "Webhook";

export type PluginSummary = {
  Name: string;
  Id: string;
  Version: string;
  Status: string;
  ConfigurationFileName?: string;
};

/** Subset of GenericOption we write; other fields default on the server side. */
export type GenericOption = {
  WebhookName: string;
  WebhookUri: string;
  NotificationTypes: string[];
  EnableMovies: boolean;
  EnableEpisodes: boolean;
  EnableSeries: boolean;
  EnableSeasons: boolean;
  EnableAlbums: boolean;
  EnableSongs: boolean;
  EnableVideos: boolean;
  SendAllProperties: boolean;
  TrimWhitespace: boolean;
  SkipEmptyMessageBody: boolean;
  EnableWebhook: boolean;
  /** Base64-encoded Handlebars template. */
  Template: string;
  UserFilter: string[];
  Headers: Array<{ Key: string; Value: string }>;
  Fields: Array<{ Key: string; Value: string }>;
};

export type WebhookPluginConfig = {
  ServerUrl?: string;
  GenericOptions?: GenericOption[];
  // keep-through for other destination arrays so we don't clobber them
  [key: string]: unknown;
};

export class JellyfinClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private fetchFn: Fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private headers(extra?: Record<string, string>) {
    return {
      Authorization: `MediaBrowser Token="${this.apiKey}"`,
      ...(extra ?? {}),
    };
  }

  async systemInfo(): Promise<{ Version: string; Id: string } | null> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/System/Info`, {
        headers: this.headers(),
      });
      if (!res.ok) return null;
      return (await res.json()) as { Version: string; Id: string };
    } catch {
      return null;
    }
  }

  async getPlugins(): Promise<PluginSummary[]> {
    const res = await this.fetchFn(`${this.baseUrl}/Plugins`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Plugins list failed: HTTP ${res.status}`);
    return (await res.json()) as PluginSummary[];
  }

  async findWebhookPlugin(): Promise<PluginSummary | null> {
    const plugins = await this.getPlugins();
    // Match by GUID (case-insensitive; Jellyfin returns without dashes-lowercased
    // canonically but we compare defensively).
    const target = WEBHOOK_PLUGIN_ID.replace(/-/g, "").toLowerCase();
    return (
      plugins.find(
        (p) => p.Id.replace(/-/g, "").toLowerCase() === target,
      ) ?? null
    );
  }

  async installWebhookPlugin(): Promise<void> {
    const res = await this.fetchFn(
      `${this.baseUrl}/Packages/Installed/${encodeURIComponent(WEBHOOK_PLUGIN_NAME)}`,
      { method: "POST", headers: this.headers() },
    );
    if (!res.ok && res.status !== 204) {
      const text = await res.text().catch(() => "");
      throw new Error(`Install failed: HTTP ${res.status} ${text}`);
    }
  }

  async restart(): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/System/Restart`, {
      method: "POST",
      headers: this.headers(),
    });
    // 204 or 200 are both fine
    if (!res.ok && res.status !== 204) {
      const text = await res.text().catch(() => "");
      throw new Error(`Restart failed: HTTP ${res.status} ${text}`);
    }
  }

  /** Poll /System/Info until it responds or timeout. Returns true if back up. */
  async waitForOnline(timeoutMs = 90_000, pollMs = 1500): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, pollMs));
      const info = await this.systemInfo();
      if (info) return true;
    }
    return false;
  }

  async getPluginConfig(pluginId: string): Promise<WebhookPluginConfig> {
    const res = await this.fetchFn(
      `${this.baseUrl}/Plugins/${pluginId}/Configuration`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`Config GET failed: HTTP ${res.status}`);
    return (await res.json()) as WebhookPluginConfig;
  }

  async putPluginConfig(
    pluginId: string,
    config: WebhookPluginConfig,
  ): Promise<void> {
    const res = await this.fetchFn(
      `${this.baseUrl}/Plugins/${pluginId}/Configuration`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(config),
      },
    );
    if (!res.ok && res.status !== 204) {
      const text = await res.text().catch(() => "");
      throw new Error(`Config POST failed: HTTP ${res.status} ${text}`);
    }
  }

  /**
   * Fetch a single item (e.g. a series) to pull its ProviderIds.
   * Uses /Items?Ids=&Fields=ProviderIds because /Items/{id} requires a user
   * scope and returns 400 with just an API key.
   */
  async getItem(itemId: string): Promise<{
    ProviderIds?: Record<string, string>;
    Name?: string;
    Type?: string;
  } | null> {
    try {
      const qs = new URLSearchParams({
        Ids: itemId,
        Fields: "ProviderIds",
      });
      const res = await this.fetchFn(
        `${this.baseUrl}/Items?${qs.toString()}`,
        { headers: this.headers() },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        Items?: Array<{
          ProviderIds?: Record<string, string>;
          Name?: string;
          Type?: string;
        }>;
      };
      return data.Items?.[0] ?? null;
    } catch {
      return null;
    }
  }

  /** Look up a scheduled task id by its Key (e.g. "WebhookItemDeleted"). */
  async findScheduledTaskId(key: string): Promise<string | null> {
    const res = await this.fetchFn(`${this.baseUrl}/ScheduledTasks`, {
      headers: this.headers(),
    });
    if (!res.ok) return null;
    const tasks = (await res.json()) as Array<{ Id: string; Key: string }>;
    return tasks.find((t) => t.Key === key)?.Id ?? null;
  }

  /** Run a scheduled task immediately. */
  async runScheduledTask(taskId: string): Promise<void> {
    const res = await this.fetchFn(
      `${this.baseUrl}/ScheduledTasks/Running/${taskId}`,
      { method: "POST", headers: this.headers() },
    );
    // 204 on success, but tolerate other 2xx
    if (!res.ok && res.status !== 204) {
      throw new Error(`task trigger failed: HTTP ${res.status}`);
    }
  }
}

/** Base64 encode (UTF-8 safe) — Jellyfin Webhook plugin stores Template base64. */
export function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/**
 * Default payload template. Field names reflect what DataObjectHelpers
 * actually exposes for an ItemDeleted event:
 *   - Movies: Provider_tmdb/imdb/tvdb are the movie's IDs.
 *   - Episodes: Provider_* are the episode's own (often empty); the series'
 *     provider IDs are NOT exposed. We send SeriesId (Jellyfin GUID) instead
 *     and enrich to tvdbId in the bridge via /Items/{id}.
 *   - ItemPath and IndexNumber are not available on ItemDeleted payloads.
 */
export const DEFAULT_TEMPLATE = `{
  "event": "ItemDeleted",
  "itemType": "{{{ItemType}}}",
  "name": "{{{Name}}}",
  "year": {{#if Year}}{{{Year}}}{{else}}null{{/if}},
  "itemId": "{{{ItemId}}}",
  "tmdbId": "{{{Provider_tmdb}}}",
  "imdbId": "{{{Provider_imdb}}}",
  "tvdbId": "{{{Provider_tvdb}}}",
  "seriesId": "{{{SeriesId}}}",
  "seriesName": "{{{SeriesName}}}",
  "seasonNumber": {{#if SeasonNumber}}{{{SeasonNumber}}}{{else}}null{{/if}},
  "episodeNumber": {{#if EpisodeNumber}}{{{EpisodeNumber}}}{{else}}null{{/if}},
  "utcTimestamp": "{{{UtcTimestamp}}}"
}`;

/**
 * Build the GenericOption entry cleanarr writes into Jellyfin's webhook config.
 * Identified by WebhookName so we can upsert idempotently.
 */
export function buildGenericOption(opts: {
  webhookUri: string;
  secret: string;
  name?: string;
}): GenericOption {
  return {
    WebhookName: opts.name ?? "cleanarr",
    WebhookUri: opts.webhookUri,
    NotificationTypes: ["ItemDeleted"],
    EnableMovies: true,
    EnableEpisodes: true,
    EnableSeries: false,
    EnableSeasons: false,
    EnableAlbums: false,
    EnableSongs: false,
    EnableVideos: false,
    SendAllProperties: false,
    TrimWhitespace: true,
    SkipEmptyMessageBody: false,
    EnableWebhook: true,
    Template: b64(DEFAULT_TEMPLATE),
    UserFilter: [],
    Headers: [
      { Key: "X-Webhook-Secret", Value: opts.secret },
      { Key: "Content-Type", Value: "application/json" },
    ],
    Fields: [],
  };
}

/** Idempotent upsert: replace any existing entry with the same WebhookName. */
export function upsertGenericOption(
  config: WebhookPluginConfig,
  entry: GenericOption,
): WebhookPluginConfig {
  const existing = Array.isArray(config.GenericOptions)
    ? config.GenericOptions
    : [];
  const filtered = existing.filter((o) => o.WebhookName !== entry.WebhookName);
  return { ...config, GenericOptions: [...filtered, entry] };
}
