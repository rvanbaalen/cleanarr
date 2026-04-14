import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { AppDb } from "./db.js";
import { insertEvent, getSetting } from "./db.js";
import type { RadarrClient } from "./radarr.js";
import type { SonarrClient } from "./sonarr.js";
import type { SeasonDebouncer, EpisodeEvent } from "./debouncer.js";
import type { Bus } from "./bus.js";
import { JellyfinClient } from "./jellyfin.js";

/**
 * Accept a fairly loose payload — Jellyfin's Handlebars templates vary across
 * plugin versions, and users may customize. We only hard-require `itemType`.
 * All IDs are string-coerced because Jellyfin sometimes emits them as strings
 * even when numeric.
 */
const payloadSchema = z
  .object({
    event: z.string().optional(),
    itemType: z.string(),
    name: z.string().optional().nullable(),
    year: z.union([z.number(), z.string()]).optional().nullable(),
    itemId: z.string().optional().nullable(),
    tmdbId: z.union([z.string(), z.number()]).optional().nullable(),
    imdbId: z.union([z.string(), z.number()]).optional().nullable(),
    tvdbId: z.union([z.string(), z.number()]).optional().nullable(),
    // For episodes only: Jellyfin GUID of the parent series. Bridge uses this
    // to fetch the series' TVDB id from Jellyfin at event time, since the
    // Webhook plugin doesn't expose series ProviderIds on ItemDeleted payloads.
    seriesId: z.string().optional().nullable(),
    seriesName: z.string().optional().nullable(),
    // Legacy field name we accept in case someone customized the template.
    seriesTvdbId: z.union([z.string(), z.number()]).optional().nullable(),
    seasonNumber: z.union([z.number(), z.string()]).optional().nullable(),
    episodeNumber: z.union([z.number(), z.string()]).optional().nullable(),
    path: z.string().optional().nullable(),
    utcTimestamp: z.string().optional(),
  })
  .passthrough();

type Payload = z.infer<typeof payloadSchema>;

function asString(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  return String(v);
}
function asNumber(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function extractSeriesTvdbId(p: Payload): string | null {
  // Fast paths: caller already set it on the template.
  return (
    asString(p.seriesTvdbId) ||
    // Fallback: if the user customized the template to route the series TVDB
    // id through `tvdbId` on episode events.
    (p.itemType?.toLowerCase() === "episode" ? asString(p.tvdbId) : null)
  );
}

/** Build a short-lived Jellyfin client from stored settings, or null. */
function makeJellyfinClient(d: {
  db: AppDb;
}): JellyfinClient | null {
  const url = getSetting(d.db, "jellyfin_url");
  const key = getSetting(d.db, "jellyfin_api_key");
  if (!url || !key) return null;
  return new JellyfinClient(url, key);
}

/**
 * Ask Jellyfin for the parent series' ProviderIds.Tvdb given its Jellyfin GUID.
 * Used to recover the series TVDB id which the Webhook plugin doesn't expose
 * directly on ItemDeleted payloads.
 */
async function resolveSeriesTvdbFromJellyfin(
  d: { db: AppDb },
  seriesId: string | null,
): Promise<string | null> {
  if (!seriesId) return null;
  const client = makeJellyfinClient(d);
  if (!client) return null;
  const item = await client.getItem(seriesId);
  const tvdb = item?.ProviderIds?.Tvdb;
  return tvdb ? String(tvdb) : null;
}

export type WebhookDeps = {
  config: Config;
  db: AppDb;
  radarr: RadarrClient;
  sonarr: SonarrClient;
  debouncer: SeasonDebouncer;
  bus: Bus;
  log: FastifyInstance["log"];
};

function isDryRun(db: AppDb, cfg: Config): boolean {
  const override = getSetting(db, "dry_run");
  if (override === undefined) return cfg.DRY_RUN;
  return override === "1";
}

/** Insert an event row and notify SSE subscribers. */
function logEvent(
  d: Pick<WebhookDeps, "db" | "bus">,
  row: Parameters<typeof insertEvent>[1],
) {
  insertEvent(d.db, row);
  d.bus.emit("event_created");
}

/** Queue an episode into the debouncer and notify SSE subscribers. */
function queueEpisode(
  d: Pick<WebhookDeps, "debouncer" | "bus">,
  ev: EpisodeEvent,
) {
  d.debouncer.add(ev);
  d.bus.emit("pending_changed");
}

export function registerWebhook(app: FastifyInstance, deps: WebhookDeps) {
  app.post("/webhook", async (req, reply) => {
    const secret =
      req.headers["x-webhook-secret"] ??
      req.headers["x-webhook-token"] ??
      req.headers["authorization"]?.toString().replace(/^Bearer\s+/i, "");

    if (!secret || secret !== deps.config.WEBHOOK_SECRET) {
      reply.code(401);
      return { error: "unauthorized" };
    }

    const parsed = payloadSchema.safeParse(req.body);
    if (!parsed.success) {
      deps.log.warn({ issues: parsed.error.issues }, "invalid webhook payload");
      reply.code(400);
      return { error: "invalid payload", issues: parsed.error.issues };
    }
    const p = parsed.data;
    const dryRun = isDryRun(deps.db, deps.config);
    const itemType = p.itemType.toLowerCase();

    try {
      if (itemType === "movie") {
        await handleMovie(p, deps, dryRun);
      } else if (itemType === "episode") {
        await handleEpisode(p, deps, dryRun);
      } else {
        // Season/Series/Other — we intentionally ignore parent-level deletions
        // since the Sonarr research flagged them as unreliable across plugin versions.
        logEvent(deps, {
          item_type: p.itemType,
          name: asString(p.name),
          year: asNumber(p.year),
          tmdb_id: asString(p.tmdbId),
          imdb_id: asString(p.imdbId),
          tvdb_id: asString(p.tvdbId),
          series_tvdb_id: extractSeriesTvdbId(p),
          season_number: asNumber(p.seasonNumber),
          episode_number: asNumber(p.episodeNumber),
          path: asString(p.path),
          action: "ignored",
          outcome: "skipped",
          detail: `ignored itemType=${p.itemType}`,
          payload: JSON.stringify(p),
        });
      }
    } catch (err) {
      deps.log.error({ err }, "webhook handler error");
      logEvent(deps, {
        item_type: p.itemType,
        name: asString(p.name),
        year: asNumber(p.year),
        tmdb_id: asString(p.tmdbId),
        imdb_id: asString(p.imdbId),
        tvdb_id: asString(p.tvdbId),
        series_tvdb_id: extractSeriesTvdbId(p),
        season_number: asNumber(p.seasonNumber),
        episode_number: asNumber(p.episodeNumber),
        path: asString(p.path),
        action: "error",
        outcome: "error",
        detail: (err as Error).message,
        payload: JSON.stringify(p),
      });
      reply.code(500);
      return { error: "handler error", message: (err as Error).message };
    }

    return { ok: true, dryRun };
  });
}

async function handleMovie(p: Payload, deps: WebhookDeps, dryRun: boolean) {
  const tmdbId = asString(p.tmdbId);
  const common = {
    item_type: "Movie",
    name: asString(p.name),
    year: asNumber(p.year),
    tmdb_id: tmdbId,
    imdb_id: asString(p.imdbId),
    tvdb_id: null,
    series_tvdb_id: null,
    season_number: null,
    episode_number: null,
    path: asString(p.path),
    payload: JSON.stringify(p),
  };

  if (!tmdbId) {
    logEvent(deps, {
      ...common,
      action: "radarr.delete",
      outcome: "skipped",
      detail: "no tmdbId on payload",
    });
    deps.log.warn({ name: p.name }, "movie event without tmdbId");
    return;
  }

  const id = await deps.radarr.findMovieByTmdbId(tmdbId);
  if (id === null) {
    logEvent(deps, {
      ...common,
      action: "radarr.delete",
      outcome: "skipped",
      detail: "not in Radarr library",
    });
    return;
  }

  if (dryRun) {
    logEvent(deps, {
      ...common,
      action: `radarr.delete(id=${id})`,
      outcome: "dry_run",
      detail: "would delete with deleteFiles=true, addImportExclusion=false",
    });
    return;
  }

  await deps.radarr.deleteMovie(id, {
    deleteFiles: true,
    addImportExclusion: false,
  });
  logEvent(deps, {
    ...common,
    action: `radarr.delete(id=${id})`,
    outcome: "ok",
    detail: "deleted with files",
  });
}

async function handleEpisode(p: Payload, deps: WebhookDeps, dryRun: boolean) {
  let seriesTvdbId = extractSeriesTvdbId(p);
  // Enrich from Jellyfin using SeriesId (Jellyfin GUID) when missing.
  if (!seriesTvdbId) {
    seriesTvdbId = await resolveSeriesTvdbFromJellyfin(deps, asString(p.seriesId));
  }
  const seasonNumber = asNumber(p.seasonNumber);
  const episodeNumber = asNumber(p.episodeNumber);

  const common = {
    item_type: "Episode",
    name: asString(p.name),
    year: asNumber(p.year),
    tmdb_id: null,
    imdb_id: asString(p.imdbId),
    tvdb_id: asString(p.tvdbId),
    series_tvdb_id: seriesTvdbId,
    season_number: seasonNumber,
    episode_number: episodeNumber,
    path: asString(p.path),
    payload: JSON.stringify(p),
  };

  if (!seriesTvdbId || seasonNumber === null || episodeNumber === null) {
    logEvent(deps, {
      ...common,
      action: "sonarr.delete-episode",
      outcome: "skipped",
      detail: "missing seriesTvdbId/seasonNumber/episodeNumber",
    });
    return;
  }

  const series = await deps.sonarr.findSeriesByTvdbId(seriesTvdbId);
  if (!series) {
    logEvent(deps, {
      ...common,
      action: "sonarr.delete-episode",
      outcome: "skipped",
      detail: "series not in Sonarr library",
    });
    return;
  }

  const episodes = await deps.sonarr.getEpisodes(series.id);
  const target = episodes.find(
    (e) => e.seasonNumber === seasonNumber && e.episodeNumber === episodeNumber,
  );
  if (!target) {
    logEvent(deps, {
      ...common,
      action: "sonarr.delete-episode",
      outcome: "skipped",
      detail: "episode not found in Sonarr",
    });
    return;
  }

  if (dryRun) {
    logEvent(deps, {
      ...common,
      action: `sonarr.delete-episode(series=${series.id}, ep=${target.id})`,
      outcome: "dry_run",
      detail: `would delete episodefile=${target.episodeFileId} and unmonitor`,
    });
    queueEpisode(deps, {
      seriesTvdbId,
      seasonNumber,
      episodeNumber,
      name: asString(p.name),
    });
    return;
  }

  await deps.sonarr.deleteEpisodeFile(target.episodeFileId);
  await deps.sonarr.unmonitorEpisodes([target.id]);

  logEvent(deps, {
    ...common,
    action: `sonarr.delete-episode(series=${series.id}, ep=${target.id})`,
    outcome: "ok",
    detail: `deleted episodefile=${target.episodeFileId}, unmonitored`,
  });

  queueEpisode(deps, {
    seriesTvdbId,
    seasonNumber,
    episodeNumber,
    name: asString(p.name),
  });
}

/**
 * Flush callback for the SeasonDebouncer. If, after debounce, every episode
 * of a season is file-less *and* not monitored, promote:
 *   - If all seasons are "empty" (or only specials remain), delete the series.
 *   - Else unmonitor the season.
 */
export function makeSeasonFlush(deps: WebhookDeps) {
  return async (key: string, events: EpisodeEvent[]) => {
    const [seriesTvdbId, seasonNumberStr] = key.split(":");
    const seasonNumber = Number(seasonNumberStr);
    if (!seriesTvdbId || !Number.isFinite(seasonNumber)) return;
    const dryRun = isDryRun(deps.db, deps.config);

    try {
      const series = await deps.sonarr.findSeriesByTvdbId(seriesTvdbId);
      if (!series) return;
      const episodes = await deps.sonarr.getEpisodes(series.id);

      const seasonEps = episodes.filter((e) => e.seasonNumber === seasonNumber);
      const allSeasonEmpty =
        seasonEps.length > 0 && seasonEps.every((e) => !e.hasFile);

      if (!allSeasonEmpty) return;

      // Every non-special season (seasonNumber > 0) is empty?
      const mainSeasons = series.seasons.filter((s) => s.seasonNumber > 0);
      const allSeriesEmpty =
        mainSeasons.length > 0 &&
        mainSeasons.every((s) => {
          const eps = episodes.filter((e) => e.seasonNumber === s.seasonNumber);
          return eps.length === 0 || eps.every((e) => !e.hasFile);
        });

      if (allSeriesEmpty) {
        if (dryRun) {
          logEvent(deps, {
            item_type: "Series",
            name: series.title,
            year: null,
            tmdb_id: null,
            imdb_id: null,
            tvdb_id: null,
            series_tvdb_id: seriesTvdbId,
            season_number: null,
            episode_number: null,
            path: null,
            action: `sonarr.delete-series(id=${series.id})`,
            outcome: "dry_run",
            detail: `would delete series with files=true, exclusion=false (flushed ${events.length} ep events)`,
            payload: JSON.stringify({ key, events }),
          });
          return;
        }
        await deps.sonarr.deleteSeries(series.id, {
          deleteFiles: true,
          addImportListExclusion: false,
        });
        logEvent(deps, {
          item_type: "Series",
          name: series.title,
          year: null,
          tmdb_id: null,
          imdb_id: null,
          tvdb_id: null,
          series_tvdb_id: seriesTvdbId,
          season_number: null,
          episode_number: null,
          path: null,
          action: `sonarr.delete-series(id=${series.id})`,
          outcome: "ok",
          detail: `all seasons empty after flush of ${events.length} ep events`,
          payload: JSON.stringify({ key, events }),
        });
        return;
      }

      // Otherwise just unmonitor the season
      if (dryRun) {
        logEvent(deps, {
          item_type: "Season",
          name: series.title,
          year: null,
          tmdb_id: null,
          imdb_id: null,
          tvdb_id: null,
          series_tvdb_id: seriesTvdbId,
          season_number: seasonNumber,
          episode_number: null,
          path: null,
          action: `sonarr.unmonitor-season(series=${series.id}, s=${seasonNumber})`,
          outcome: "dry_run",
          detail: `would unmonitor season (flushed ${events.length} ep events)`,
          payload: JSON.stringify({ key, events }),
        });
        return;
      }
      await deps.sonarr.setSeasonMonitored(series.id, seasonNumber, false);
      logEvent(deps, {
        item_type: "Season",
        name: series.title,
        year: null,
        tmdb_id: null,
        imdb_id: null,
        tvdb_id: null,
        series_tvdb_id: seriesTvdbId,
        season_number: seasonNumber,
        episode_number: null,
        path: null,
        action: `sonarr.unmonitor-season(series=${series.id}, s=${seasonNumber})`,
        outcome: "ok",
        detail: `season fully empty; unmonitored (${events.length} ep events)`,
        payload: JSON.stringify({ key, events }),
      });
    } catch (err) {
      deps.log.error({ err, key }, "season-flush error");
      logEvent(deps, {
        item_type: "Season",
        name: null,
        year: null,
        tmdb_id: null,
        imdb_id: null,
        tvdb_id: null,
        series_tvdb_id: seriesTvdbId,
        season_number: seasonNumber,
        episode_number: null,
        path: null,
        action: "sonarr.season-flush",
        outcome: "error",
        detail: (err as Error).message,
        payload: JSON.stringify({ key, events }),
      });
    }
  };
}
