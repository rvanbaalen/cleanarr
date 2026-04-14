import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

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

export type Settings = {
  dry_run: number; // 0 | 1
};

export function openDb(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "cleanarr.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      item_type TEXT NOT NULL,
      name TEXT,
      year INTEGER,
      tmdb_id TEXT,
      imdb_id TEXT,
      tvdb_id TEXT,
      series_tvdb_id TEXT,
      season_number INTEGER,
      episode_number INTEGER,
      path TEXT,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      detail TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_events_outcome ON events(outcome);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return db;
}

export type AppDb = ReturnType<typeof openDb>;

export function getSetting(db: AppDb, key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(db: AppDb, key: string, value: string) {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function insertEvent(
  db: AppDb,
  e: Omit<EventRow, "id" | "ts"> & { ts?: number },
) {
  const stmt = db.prepare(`
    INSERT INTO events (
      ts, item_type, name, year, tmdb_id, imdb_id, tvdb_id,
      series_tvdb_id, season_number, episode_number, path,
      action, outcome, detail, payload
    ) VALUES (
      @ts, @item_type, @name, @year, @tmdb_id, @imdb_id, @tvdb_id,
      @series_tvdb_id, @season_number, @episode_number, @path,
      @action, @outcome, @detail, @payload
    )
  `);
  const info = stmt.run({ ...e, ts: e.ts ?? Date.now() });
  return info.lastInsertRowid as number;
}

export function listEvents(
  db: AppDb,
  opts: { limit?: number; offset?: number; outcome?: string; itemType?: string } = {},
): { rows: EventRow[]; total: number } {
  const limit = Math.min(opts.limit ?? 50, 500);
  const offset = opts.offset ?? 0;
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.outcome) {
    where.push("outcome = @outcome");
    params.outcome = opts.outcome;
  }
  if (opts.itemType) {
    where.push("item_type = @itemType");
    params.itemType = opts.itemType;
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT * FROM events ${whereSql} ORDER BY ts DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as EventRow[];
  const total = (
    db.prepare(`SELECT COUNT(*) as c FROM events ${whereSql}`).get(params) as {
      c: number;
    }
  ).c;
  return { rows, total };
}

export function pruneOldEvents(db: AppDb, retentionDays: number) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const info = db.prepare("DELETE FROM events WHERE ts < ?").run(cutoff);
  return info.changes;
}

export function counts(db: AppDb) {
  const row = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS error,
        SUM(CASE WHEN outcome = 'skipped' THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN outcome = 'dry_run' THEN 1 ELSE 0 END) AS dry_run
      FROM events`,
    )
    .get() as { total: number; ok: number; error: number; skipped: number; dry_run: number };
  return row;
}
