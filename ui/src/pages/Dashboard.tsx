import { useEffect, useState } from "react";
import { api, type Status } from "../lib/api.js";
import { fmtUptime } from "../lib/format.js";
import { useLive } from "../lib/useLive.js";

export function Dashboard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      setStatus(await api.status());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  useLive({
    event_created: refresh,
    status_changed: refresh,
    pending_changed: refresh,
  });

  const toggleDryRun = async () => {
    if (!status) return;
    setBusy(true);
    try {
      await api.setDryRun(!status.dryRun);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (err && !status) return <div className="empty">Error: {err}</div>;
  if (!status) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="grid" style={{ marginBottom: 24 }}>
        <div className="card">
          <div className="label">Radarr</div>
          <div className="row">
            <span className={`pill ${status.radarr.ok ? "ok" : "err"}`}>
              {status.radarr.ok ? "Connected" : "Down"}
            </span>
            {status.radarr.version && (
              <span className="sub mono">v{status.radarr.version}</span>
            )}
          </div>
          {!status.radarr.ok && status.radarr.error && (
            <div className="sub" style={{ color: "var(--err)" }}>
              {status.radarr.error}
            </div>
          )}
        </div>

        <div className="card">
          <div className="label">Sonarr</div>
          <div className="row">
            <span className={`pill ${status.sonarr.ok ? "ok" : "err"}`}>
              {status.sonarr.ok ? "Connected" : "Down"}
            </span>
            {status.sonarr.version && (
              <span className="sub mono">v{status.sonarr.version}</span>
            )}
          </div>
          {!status.sonarr.ok && status.sonarr.error && (
            <div className="sub" style={{ color: "var(--err)" }}>
              {status.sonarr.error}
            </div>
          )}
        </div>

        <div className="card">
          <div className="label">Dry run</div>
          <div className="row">
            <label className="switch">
              <input
                type="checkbox"
                checked={status.dryRun}
                onChange={toggleDryRun}
                disabled={busy}
              />
              <span className="switch-slider" />
            </label>
            <span className={`pill ${status.dryRun ? "dry" : "ok"}`}>
              {status.dryRun ? "Simulating" : "Live"}
            </span>
          </div>
          <div className="sub">
            source: {status.dryRunSource === "env" ? "env var" : "UI override"}
          </div>
        </div>

        <div className="card">
          <div className="label">Uptime</div>
          <div className="value">{fmtUptime(status.uptimeMs)}</div>
          <div className="sub">
            debounce {Math.round(status.debounceMs / 1000)}s · pending buckets:{" "}
            {status.pendingBuckets}
          </div>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <div className="label">Events total</div>
          <div className="value">{status.counts.total ?? 0}</div>
        </div>
        <div className="card">
          <div className="label">Actions executed</div>
          <div className="value" style={{ color: "var(--ok)" }}>
            {status.counts.ok ?? 0}
          </div>
        </div>
        <div className="card">
          <div className="label">Dry-run logged</div>
          <div className="value" style={{ color: "var(--accent)" }}>
            {status.counts.dry_run ?? 0}
          </div>
        </div>
        <div className="card">
          <div className="label">Skipped</div>
          <div className="value" style={{ color: "var(--text-dim)" }}>
            {status.counts.skipped ?? 0}
          </div>
        </div>
        <div className="card">
          <div className="label">Errors</div>
          <div className="value" style={{ color: "var(--err)" }}>
            {status.counts.error ?? 0}
          </div>
        </div>
      </div>
    </>
  );
}
