import { useEffect, useState } from "react";
import {
  api,
  type Settings as SettingsT,
  type Status,
  type JellyfinStatus,
  type SetupStep,
} from "../lib/api.js";
import { useLive } from "../lib/useLive.js";

export function Settings() {
  const [settings, setSettings] = useState<SettingsT | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [testing, setTesting] = useState<null | "radarr" | "sonarr">(null);

  const refresh = async () => {
    const [s, st] = await Promise.all([api.settings(), api.status()]);
    setSettings(s);
    setStatus(st);
  };

  useEffect(() => {
    refresh();
  }, []);

  if (!settings || !status) return <div className="empty">Loading…</div>;

  const testConnection = async (target: "radarr" | "sonarr") => {
    setTesting(target);
    try {
      await api.status();
      await refresh();
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="card">
      <dl className="kv" style={{ marginBottom: 24 }}>
        <dt>Listen port</dt>
        <dd>
          <code>{settings.port}</code>
        </dd>

        <dt>Radarr URL</dt>
        <dd>
          <code>{settings.radarrUrl}</code>
          <button
            style={{ marginLeft: 8 }}
            onClick={() => testConnection("radarr")}
            disabled={testing === "radarr"}
          >
            {testing === "radarr" ? "Testing…" : "Test"}
          </button>
          <span
            className={`pill ${status.radarr.ok ? "ok" : "err"}`}
            style={{ marginLeft: 8 }}
          >
            {status.radarr.ok
              ? `OK v${status.radarr.version}`
              : status.radarr.error}
          </span>
        </dd>

        <dt>Radarr API key</dt>
        <dd>
          <code>{settings.radarrApiKeyPreview}</code>
        </dd>

        <dt>Sonarr URL</dt>
        <dd>
          <code>{settings.sonarrUrl}</code>
          <button
            style={{ marginLeft: 8 }}
            onClick={() => testConnection("sonarr")}
            disabled={testing === "sonarr"}
          >
            {testing === "sonarr" ? "Testing…" : "Test"}
          </button>
          <span
            className={`pill ${status.sonarr.ok ? "ok" : "err"}`}
            style={{ marginLeft: 8 }}
          >
            {status.sonarr.ok
              ? `OK v${status.sonarr.version}`
              : status.sonarr.error}
          </span>
        </dd>

        <dt>Sonarr API key</dt>
        <dd>
          <code>{settings.sonarrApiKeyPreview}</code>
        </dd>

        <dt>Webhook secret</dt>
        <dd>
          <code>{settings.webhookSecretPreview}</code>
          <span className="dim" style={{ marginLeft: 8 }}>
            send as <code>X-Webhook-Secret</code> header
          </span>
        </dd>

        <dt>Dry-run (env default)</dt>
        <dd>
          <code>{String(settings.dryRunEnv)}</code>
          <span className="dim" style={{ marginLeft: 8 }}>
            effective: <code>{String(status.dryRun)}</code>
            {status.dryRunSource === "override" && " (UI override)"}
          </span>
        </dd>

        <dt>Season debounce</dt>
        <dd>
          <code>{settings.seasonDebounceMs} ms</code>
        </dd>

        <dt>Events retention</dt>
        <dd>
          <code>{settings.eventsRetentionDays} days</code>
        </dd>

        <dt>Log level</dt>
        <dd>
          <code>{settings.logLevel}</code>
        </dd>
      </dl>

      <JellyfinIntegration />
    </div>
  );
}

function JellyfinIntegration() {
  const [status, setStatus] = useState<JellyfinStatus | null>(null);
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<null | "connect" | "setup" | "disconnect">(null);
  const [steps, setSteps] = useState<SetupStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const s = await api.jellyfinStatus();
      setStatus(s);
      if (s.url) setUrl(s.url);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  useLive({ status_changed: refresh });

  const onConnect = async () => {
    setError(null);
    setBusy("connect");
    try {
      await api.jellyfinConnect(url.trim(), apiKey.trim());
      setApiKey("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onSetup = async () => {
    setError(null);
    setSteps(null);
    setBusy("setup");
    try {
      const res = await api.jellyfinSetup();
      setSteps(res.steps);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onDisconnect = async () => {
    setBusy("disconnect");
    try {
      await api.jellyfinDisconnect();
      setApiKey("");
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const connected = !!status?.url && !!status?.version;

  return (
    <div style={{ marginTop: 32, paddingTop: 24, borderTop: "1px solid var(--border)" }}>
      <h3 style={{ marginBottom: 4 }}>Jellyfin integration</h3>
      <div className="dim" style={{ marginBottom: 16, fontSize: 13 }}>
        Auto-install the Webhook plugin and add a destination pointing at this service.
      </div>

      {!connected ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 520 }}>
          <label className="dim" style={{ fontSize: 12 }}>
            Jellyfin URL (must be reachable from cleanarr's container)
          </label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://host.docker.internal:8096"
          />
          <label className="dim" style={{ fontSize: 12, marginTop: 4 }}>
            API key (Dashboard → API Keys in Jellyfin)
          </label>
          <input
            type="text"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="…"
          />
          <div style={{ marginTop: 8 }}>
            <button onClick={onConnect} disabled={busy === "connect" || !url || !apiKey}>
              {busy === "connect" ? "Connecting…" : "Connect"}
            </button>
          </div>
          {status?.url && (
            <div className="dim" style={{ fontSize: 12 }}>
              Saved URL: <code>{status.url}</code> — last connect failed: {status.reason}
            </div>
          )}
        </div>
      ) : (
        <div>
          <dl className="kv" style={{ marginBottom: 16 }}>
            <dt>URL</dt>
            <dd><code>{status?.url}</code></dd>
            <dt>Version</dt>
            <dd>
              <span className="pill ok">v{status?.version}</span>
            </dd>
            <dt>API key</dt>
            <dd><code>{status?.apiKeyPreview}</code></dd>
            <dt>Webhook plugin</dt>
            <dd>
              {status?.pluginInstalled ? (
                <span className="pill ok">
                  Installed v{status.pluginVersion} ({status.pluginStatus})
                </span>
              ) : (
                <span className="pill warn">Not installed</span>
              )}
            </dd>
            <dt>cleanarr destination</dt>
            <dd>
              {status?.destinationPresent ? (
                <span className="pill ok">Configured</span>
              ) : (
                <span className="pill warn">Not configured</span>
              )}
            </dd>
            <dt>Webhook URL</dt>
            <dd><code>{status?.webhookUri}</code></dd>
          </dl>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onSetup} disabled={busy === "setup"}>
              {busy === "setup"
                ? "Working… (Jellyfin will restart)"
                : status?.destinationPresent
                  ? "Reconfigure webhook"
                  : "Install & configure webhook"}
            </button>
            <button onClick={onDisconnect} disabled={busy === "disconnect"}>
              Disconnect
            </button>
          </div>
          {busy === "setup" && (
            <div className="dim" style={{ marginTop: 8, fontSize: 12 }}>
              This installs the plugin if needed and restarts Jellyfin twice.
              May take 30–60s.
            </div>
          )}
          {steps && (
            <div className="card" style={{ marginTop: 16, background: "var(--surface-2)" }}>
              <div className="label">Setup log</div>
              <table>
                <tbody>
                  {steps.map((s, i) => (
                    <tr key={i}>
                      <td className="mono">{s.step}</td>
                      <td>
                        <span className={`pill ${s.ok ? "ok" : "err"}`}>
                          {s.ok ? "ok" : "fail"}
                        </span>
                      </td>
                      <td className="dim">{s.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {error && (
        <div
          className="card"
          style={{ marginTop: 12, borderColor: "var(--err)", color: "var(--err)" }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
