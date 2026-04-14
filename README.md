# cleanarr

[![release](https://github.com/rvanbaalen/cleanarr/actions/workflows/release.yml/badge.svg)](https://github.com/rvanbaalen/cleanarr/actions/workflows/release.yml)
[![ghcr](https://img.shields.io/badge/ghcr.io-rvanbaalen%2Fcleanarr-blue)](https://github.com/rvanbaalen/cleanarr/pkgs/container/cleanarr)

Small service that listens for Jellyfin `ItemDeleted` webhooks and deletes the
corresponding movie/episode from Radarr/Sonarr (removing files and stopping
future re-downloads). Includes a small web UI for live event monitoring,
dry-run toggling, and one-click Jellyfin webhook plugin auto-configuration.

## What it does

| Jellyfin event          | Action                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `Movie` deleted         | `DELETE /api/v3/movie/{id}?deleteFiles=true&addImportExclusion=false` in Radarr         |
| `Episode` deleted       | `DELETE /api/v3/episodefile/{id}` then `PUT /api/v3/episode/monitor` in Sonarr          |
| All episodes of a season gone (after debounce) | Unmonitor the season (or delete the whole series if every season is empty)   |

Exclusion flags default to `false` — deletions won't permanently blocklist
re-adds via import lists.

## Quick start

```yaml
# docker-compose.yml
services:
  cleanarr:
    image: ghcr.io/rvanbaalen/cleanarr:latest
    container_name: cleanarr
    environment:
      - TZ=Etc/UTC
      - RADARR_URL=http://host.docker.internal:7878
      - RADARR_API_KEY=${RADARR_API_KEY}
      - SONARR_URL=http://host.docker.internal:8989
      - SONARR_API_KEY=${SONARR_API_KEY}
      - WEBHOOK_SECRET=${WEBHOOK_SECRET}
      - DRY_RUN=${DRY_RUN:-true}
    volumes:
      - ./data:/app/data
    ports:
      - 3000:3000
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped
```

```bash
cp .env.example .env   # fill in the three keys
docker compose up -d
```

- **UI**: `http://<host>:3000/`
- **Webhook endpoint**: `http://<host>:3000/webhook`

## Jellyfin setup

The UI has a one-click installer:

1. Open the Settings tab in cleanarr.
2. Under **Jellyfin integration**, paste your Jellyfin URL and API key.
3. Click **Connect**, then **Install & configure webhook**.

That installs the Webhook plugin if missing, adds a Generic Destination
pointing at cleanarr, sets the correct Handlebars template, and restarts
Jellyfin. Takes ~30 seconds.

If you'd rather configure it manually, the template cleanarr expects is:

```handlebars
{
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
}
```

Notification type: `Item Deleted`. Item types: `Movies` and `Episodes`.
Header: `X-Webhook-Secret: <your WEBHOOK_SECRET>`.

## Going live

1. Trigger a test delete in Jellyfin.
2. Watch the **Events** tab — with SSE, rows appear live. Confirm the action
   line looks right (`radarr.delete(id=N)` / `sonarr.delete-episode(...)`).
3. Flip the dry-run switch off on the Dashboard (persists across restarts via
   SQLite; overrides the env default).

## How an Episode event is resolved

The Webhook plugin doesn't expose the parent series' TVDB ID on an Episode
payload — only the episode's own provider IDs, which are usually empty. So
cleanarr enriches: it takes the Jellyfin `seriesId` GUID from the payload and
fetches the series record via Jellyfin's API (`GET /Items?Ids=...&Fields=ProviderIds`)
to pull `ProviderIds.Tvdb`, then uses that against Sonarr.

## Why a drain-task poller

`ItemDeleted` events are queued internally by the Webhook plugin and drained by
a Jellyfin scheduled task every 30s. On some installs that interval trigger
doesn't auto-fire; cleanarr nudges the `WebhookItemDeleted` task every 20s via
the Jellyfin API as a belt-and-suspenders measure.

## Environment variables

| Variable                 | Default                                | Notes                                              |
| ------------------------ | -------------------------------------- | -------------------------------------------------- |
| `RADARR_URL`             | `http://host.docker.internal:7878`     | URL Radarr is reachable at **from the container**  |
| `RADARR_API_KEY`         | —                                       | required                                           |
| `SONARR_URL`             | `http://host.docker.internal:8989`     |                                                    |
| `SONARR_API_KEY`         | —                                       | required                                           |
| `WEBHOOK_SECRET`         | —                                       | required. `openssl rand -hex 24`                   |
| `DRY_RUN`                | `true`                                 | UI toggle overrides this                           |
| `PORT`                   | `3000`                                 |                                                    |
| `SEASON_DEBOUNCE_MS`     | `10000`                                | window for "whole season deleted" promotion        |
| `EVENTS_RETENTION_DAYS`  | `30`                                   | SQLite row retention                               |
| `LOG_LEVEL`              | `info`                                 | pino levels                                        |
| `TZ`                     | `Etc/UTC`                              |                                                    |

## Data

- SQLite at `./data/cleanarr.sqlite` (events + UI settings override).
- Events are pruned hourly past `EVENTS_RETENTION_DAYS`.
- Safe to delete `./data` for a fresh start.

## Webhook-loop safety

The bridge only reacts to Jellyfin `ItemDeleted`. It does not listen to
Radarr/Sonarr webhooks, so deleting via the bridge cannot loop back. Sonarr's
file delete does not re-trigger Jellyfin's `ItemDeleted`.

## Development

```bash
npm install
npm run dev:server   # terminal 1
npm run dev:ui       # terminal 2 — Vite dev server on :5173, proxies /api + /webhook
```

Build + production container locally:

```bash
docker compose -f docker-compose.dev.yml up --build
```

## Releases

Versioning is automated via [release-please](https://github.com/googleapis/release-please)
with Conventional Commits. Merges to `main` with `feat:`, `fix:`, etc. open a
release PR; merging it cuts a tag + publishes a multi-arch image to
`ghcr.io/rvanbaalen/cleanarr`.

## License

MIT — see [LICENSE](LICENSE).
