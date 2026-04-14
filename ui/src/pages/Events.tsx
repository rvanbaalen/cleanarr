import { useEffect, useState } from "react";
import { api, type EventRow } from "../lib/api.js";
import { fmtTime, outcomeClass } from "../lib/format.js";
import { useLive } from "../lib/useLive.js";

export function Events() {
  const [rows, setRows] = useState<EventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [outcome, setOutcome] = useState("all");
  const [itemType, setItemType] = useState("all");
  const [selected, setSelected] = useState<EventRow | null>(null);
  const limit = 50;

  const refresh = async () => {
    const res = await api.events({ limit, offset, outcome, itemType });
    setRows(res.rows);
    setTotal(res.total);
  };

  useEffect(() => {
    refresh();
  }, [offset, outcome, itemType]);

  // Push refresh on new events. Only re-run if the filter window is at offset 0,
  // so you don't yank pages out from under someone mid-paging.
  useLive({
    event_created: () => {
      if (offset === 0) refresh();
    },
  });

  return (
    <>
      <div className="toolbar">
        <select value={itemType} onChange={(e) => { setItemType(e.target.value); setOffset(0); }}>
          <option value="all">All types</option>
          <option value="Movie">Movie</option>
          <option value="Episode">Episode</option>
          <option value="Season">Season</option>
          <option value="Series">Series</option>
        </select>
        <select value={outcome} onChange={(e) => { setOutcome(e.target.value); setOffset(0); }}>
          <option value="all">All outcomes</option>
          <option value="ok">OK</option>
          <option value="dry_run">Dry run</option>
          <option value="skipped">Skipped</option>
          <option value="error">Error</option>
        </select>
        <div className="spacer" />
        <span className="dim">
          {total === 0 ? "0 events" : `${offset + 1}–${Math.min(offset + limit, total)} of ${total}`}
        </span>
        <button onClick={() => setOffset(Math.max(0, offset - limit))} disabled={offset === 0}>
          Prev
        </button>
        <button
          onClick={() => setOffset(offset + limit)}
          disabled={offset + limit >= total}
        >
          Next
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="empty">No events yet. Waiting for Jellyfin webhooks…</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Item</th>
              <th>Action</th>
              <th>Outcome</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => setSelected(r)}>
                <td className="nowrap mono">{fmtTime(r.ts)}</td>
                <td>{r.item_type}</td>
                <td>
                  <div>{r.name ?? <span className="dim">—</span>}</div>
                  {r.item_type === "Episode" && r.season_number !== null && (
                    <div className="dim mono">
                      S{String(r.season_number).padStart(2, "0")}E
                      {String(r.episode_number ?? 0).padStart(2, "0")}
                    </div>
                  )}
                </td>
                <td className="mono">{r.action}</td>
                <td>
                  <span className={`pill ${outcomeClass(r.outcome)}`}>{r.outcome}</span>
                </td>
                <td className="dim">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected && <PayloadModal row={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function PayloadModal({ row, onClose }: { row: EventRow; onClose: () => void }) {
  let pretty: string;
  try {
    pretty = JSON.stringify(JSON.parse(row.payload), null, 2);
  } catch {
    pretty = row.payload;
  }
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        zIndex: 10,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ maxWidth: 720, width: "100%", maxHeight: "80vh", overflow: "auto" }}
      >
        <div className="row" style={{ marginBottom: 12 }}>
          <strong>Payload</strong>
          <button onClick={onClose}>Close</button>
        </div>
        <pre
          className="mono"
          style={{
            background: "var(--surface-2)",
            padding: 12,
            borderRadius: 6,
            overflow: "auto",
            fontSize: 12,
            margin: 0,
          }}
        >
          {pretty}
        </pre>
      </div>
    </div>
  );
}
