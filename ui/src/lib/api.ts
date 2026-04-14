export type Status = {
  uptimeMs: number;
  dryRun: boolean;
  dryRunSource: "env" | "override";
  radarr: { ok: boolean; version?: string; error?: string };
  sonarr: { ok: boolean; version?: string; error?: string };
  counts: { total: number; ok: number; error: number; skipped: number; dry_run: number };
  pendingBuckets: number;
  debounceMs: number;
};

export type EventRow = {
  id: number;
  ts: number;
  item_type: string;
  name: string | null;
  year: number | null;
  tmdb_id: string | null;
  imdb_id: string | null;
  tvdb_id: string | null;
  series_tvdb_id: string | null;
  season_number: number | null;
  episode_number: number | null;
  path: string | null;
  action: string;
  outcome: string;
  detail: string | null;
  payload: string;
};

export type PendingBucket = {
  key: string;
  count: number;
  events: Array<{
    seriesTvdbId: string;
    seasonNumber: number;
    episodeNumber: number;
    name?: string | null;
  }>;
};

export type Settings = {
  port: number;
  radarrUrl: string;
  sonarrUrl: string;
  radarrApiKeyPreview: string;
  sonarrApiKeyPreview: string;
  webhookSecretPreview: string;
  dryRunEnv: boolean;
  seasonDebounceMs: number;
  eventsRetentionDays: number;
  logLevel: string;
};

export type JellyfinStatus = {
  configured: boolean;
  url?: string;
  apiKeyPreview?: string;
  version?: string;
  serverId?: string;
  pluginInstalled?: boolean;
  pluginVersion?: string;
  pluginStatus?: string;
  destinationPresent?: boolean;
  templateMatches?: boolean;
  webhookUri?: string;
  reason?: string;
};

export type SetupStep = { step: string; ok: boolean; detail?: string };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  status: () => req<Status>("/api/status"),
  events: (p: { limit?: number; offset?: number; outcome?: string; itemType?: string }) => {
    const qs = new URLSearchParams();
    if (p.limit) qs.set("limit", String(p.limit));
    if (p.offset) qs.set("offset", String(p.offset));
    if (p.outcome) qs.set("outcome", p.outcome);
    if (p.itemType) qs.set("itemType", p.itemType);
    return req<{ rows: EventRow[]; total: number }>(`/api/events?${qs}`);
  },
  pending: () => req<{ buckets: PendingBucket[] }>("/api/pending"),
  setDryRun: (enabled: boolean) =>
    req<{ ok: true; dryRun: boolean }>("/api/dry-run", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  settings: () => req<Settings>("/api/settings"),

  jellyfinStatus: () => req<JellyfinStatus>("/api/jellyfin/status"),
  jellyfinConnect: (url: string, apiKey: string) =>
    req<{ ok: true; version: string; serverId: string }>(
      "/api/jellyfin/connect",
      { method: "POST", body: JSON.stringify({ url, apiKey }) },
    ),
  jellyfinSetup: (webhookUri?: string) =>
    req<{ ok: boolean; webhookUri: string; steps: SetupStep[] }>(
      "/api/jellyfin/setup",
      { method: "POST", body: JSON.stringify({ webhookUri }) },
    ),
  jellyfinDisconnect: () =>
    req<{ ok: true }>("/api/jellyfin/disconnect", { method: "POST" }),
};
