"use client";
// Raw TripJack request / response files per call (hotels, flights, TripSafe):
// list, filter to errors, download one file or a ZIP of the selected calls.
import { useCallback, useEffect, useState } from "react";
import { API, apiHeaders } from "@/lib/api";

type Scope = "hotel" | "flight" | "tripsafe";
type Call = {
  id: string; endpoint: string; service: string; httpStatus: number | null; durationMs: number | null; error: string | null;
  bookingId: string | null; searchId: string | null; requestId: string | null; startedAt: string; hasResponse: boolean;
};

const SCOPES: { key: Scope; label: string }[] = [
  { key: "hotel", label: "Hotels" }, { key: "flight", label: "Flights" }, { key: "tripsafe", label: "TripSafe" },
];

async function download(path: string, fallback: string) {
  const res = await fetch(`${API}${path}`, { headers: apiHeaders() });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.message ?? d.error ?? `HTTP ${res.status}`); }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? fallback;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function RawApiCalls({ initialScope = "hotel" }: { initialScope?: Scope }) {
  const [scope, setScope] = useState<Scope>(initialScope);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [rows, setRows] = useState<Call[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setRows(null); setError(""); setPicked(new Set());
    try {
      const res = await fetch(`${API}/api/admin/supplier-logs/exchanges?scope=${scope}&limit=150${errorsOnly ? "&errors=1" : ""}`, { headers: apiHeaders() });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? d.message ?? `HTTP ${res.status}`);
      setRows(d.exchanges);
    } catch (e: any) { setError(e.message); setRows([]); }
  }, [scope, errorsOnly]);
  useEffect(() => { void load(); }, [load]);

  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const failed = (x: Call) => Boolean(x.error) || !x.httpStatus || x.httpStatus >= 400;

  return (
    <section style={{ marginTop: 28, background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9", margin: 0 }}>Request / response files</h2>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {SCOPES.map((s) => (
            <button key={s.key} type="button" onClick={() => setScope(s.key)}
              style={{ ...pill, background: scope === s.key ? "#E31E24" : "#1e293b", borderColor: scope === s.key ? "#E31E24" : "#334155" }}>{s.label}</button>
          ))}
          <label style={{ color: "#94a3b8", fontSize: 13, display: "flex", gap: 6, alignItems: "center", marginLeft: 6 }}>
            <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> Errors only
          </label>
          <button type="button" style={pill} onClick={() => void load()}>Reload</button>
          <button type="button" disabled={!picked.size} style={{ ...pill, background: picked.size ? "#2563eb" : "#1e293b", opacity: picked.size ? 1 : 0.6 }}
            onClick={() => download(`/api/admin/supplier-logs/exchanges.zip?ids=${[...picked].join(",")}&name=${scope}-api-logs`, `${scope}-api-logs.zip`).catch((e) => setError(e.message))}>
            Download selected ({picked.size})
          </button>
        </div>
      </div>
      <p style={{ color: "#64748b", fontSize: 12, margin: "0 0 12px" }}>
        Every TripJack call with its exact request (TripJack URL and apikey) and the response exactly as received. Failed calls are red — open the response to see TripJack&apos;s reason.
      </p>
      {error && <p style={{ color: "#fca5a5", fontSize: 13 }}>{error}</p>}
      {!rows ? <p style={{ color: "#64748b", fontSize: 13 }}>Loading…</p> : !rows.length ? (
        <p style={{ color: "#64748b", fontSize: 13 }}>No {errorsOnly ? "failed " : ""}calls recorded yet{scope === "hotel" ? " — hotel calls are recorded from this release on" : ""}.</p>
      ) : (
        <div style={{ overflowX: "auto", maxHeight: 480, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ background: "#1e293b" }}>{["", "Time", "Service", "HTTP", "ms", "Linked to", "Files"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.id} style={{ borderTop: "1px solid #1e293b", background: failed(x) ? "rgba(239,68,68,.06)" : undefined }}>
                  <td style={td}><input type="checkbox" checked={picked.has(x.id)} onChange={() => toggle(x.id)} aria-label="Select call" /></td>
                  <td style={td}>{new Date(x.startedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</td>
                  <td style={td}><span style={{ color: "#e2e8f0" }}>{x.service}</span><div style={{ color: "#475569", fontSize: 11 }}>{x.endpoint}</div>{x.error && <div style={{ color: "#fca5a5", fontSize: 12 }}>{x.error}</div>}</td>
                  <td style={{ ...td, color: failed(x) ? "#f87171" : "#4ade80", fontWeight: 700 }}>{x.httpStatus ?? "—"}</td>
                  <td style={td}>{x.durationMs ?? "—"}</td>
                  <td style={{ ...td, fontSize: 12, color: "#94a3b8" }}>{x.bookingId ? `Booking ${x.bookingId}` : x.searchId ? `Search ${x.searchId.slice(0, 12)}` : x.requestId?.slice(0, 18) ?? "—"}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    <button type="button" style={small} onClick={() => download(`/api/admin/supplier-logs/exchanges/${x.id}/request`, `${x.service}Request.json`).catch((e) => setError(e.message))}>Request</button>{" "}
                    {x.hasResponse && <button type="button" style={small} onClick={() => download(`/api/admin/supplier-logs/exchanges/${x.id}/response`, `${x.service}Response.json`).catch((e) => setError(e.message))}>Response</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const pill: React.CSSProperties = { background: "#1e293b", color: "#f1f5f9", border: "1px solid #334155", borderRadius: 8, padding: "7px 12px", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const small: React.CSSProperties = { background: "#1e293b", color: "#93c5fd", border: "1px solid #334155", borderRadius: 6, padding: "4px 8px", fontSize: 12, cursor: "pointer" };
const th: React.CSSProperties = { padding: "8px 12px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "#475569", textTransform: "uppercase", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "8px 12px", verticalAlign: "top", color: "#cbd5e1" };
