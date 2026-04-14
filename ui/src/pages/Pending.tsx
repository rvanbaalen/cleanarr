import { useEffect, useState } from "react";
import { api, type PendingBucket } from "../lib/api.js";
import { useLive } from "../lib/useLive.js";

export function Pending() {
  const [buckets, setBuckets] = useState<PendingBucket[]>([]);

  const refresh = async () => {
    const res = await api.pending();
    setBuckets(res.buckets);
  };

  useEffect(() => {
    refresh();
  }, []);

  useLive({ pending_changed: refresh });

  if (buckets.length === 0) {
    return (
      <div className="empty">
        No pending season-promotion buckets.
        <br />
        <span className="dim">
          When episode deletions arrive, they're buffered here for a few seconds
          before the bridge decides whether to escalate to a season/series
          operation.
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {buckets.map((b) => {
        const [tvdbId, seasonNumber] = b.key.split(":");
        return (
          <div key={b.key} className="card">
            <div className="row" style={{ marginBottom: 8 }}>
              <div>
                <div>
                  <strong>Series TVDB {tvdbId}</strong> · Season {seasonNumber}
                </div>
                <div className="sub">
                  {b.count} episode event{b.count === 1 ? "" : "s"} buffered
                </div>
              </div>
              <span className="pill warn">Pending</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>S/E</th>
                  <th>Name</th>
                </tr>
              </thead>
              <tbody>
                {b.events.map((e, i) => (
                  <tr key={i}>
                    <td className="mono">
                      S{String(e.seasonNumber).padStart(2, "0")}E
                      {String(e.episodeNumber).padStart(2, "0")}
                    </td>
                    <td>{e.name ?? <span className="dim">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
