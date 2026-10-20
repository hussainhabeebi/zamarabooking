"use client";

import { useEffect, useState, useCallback } from "react";

type LogEntry = {
  id: string;
  supplier: string;
  endpoint: string;
  httpStatus: number | null;
  level: string;
  requestId: string | null;
  requestSummary: Record<string, unknown> | null;
  responseSnippet: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
};

function getToken(): string {
  try {
    const m = document.cookie.match(/(?:^|;\s*)poomas_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  } catch { return ""; }
}

const LEVEL_COLOR: Record<string, string> = {
  INFO:  "#16a34a",
  WARN:  "#d97706",
  ERROR: "#dc2626",
};

const ENDPOINT_LABEL: Record<string, string> = {
  "/fms/v1/review":               "Fare Review",
  "/oms/v1/air/book":             "Book Flight",
  "/air-search-all/v2":           "Search",
  "/fms/v2/farerule":             "Fare Rules",
  "/oms/v1/booking-details":      "PNR Status",
  "/oms/v1/air/amendment/submit-amendment": "Cancel",
};

export default function SupplierLogsPage() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";

  const [logs, setLogs]           = useState<LogEntry[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState("");
  const [expanded, setExpanded]   = useState<string | null>(null);

  // Filters
  const [level,    setLevel]    = useState("");
  const [supplier, setSupplier] = useState("TRIPJACK");
  const [endpoint, setEndpoint] = useState("");
  const [from,     setFrom]     = useState("");
  const [to,       setTo]       = useState("");
  const [offset,   setOffset]   = useState(0);
  const limit = 50;

  const load = useCallback(async (off = 0) => {
    const token = getToken();
    if (!token) { setError("Not authenticated"); return; }
    setLoading(true);
    setError("");
    try {
      const q = new URLSearchParams({ limit: String(limit), offset: String(off) });
      if (level)    q.set("level", level);
      if (supplier) q.set("supplier", supplier);
      if (endpoint) q.set("endpoint", endpoint);
      if (from)     q.set("from", from);
      if (to)       q.set("to", to);
      const res = await fetch(`${apiUrl}/api/admin/supplier-logs?${q}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json() as { logs: LogEntry[] };
      setLogs(data.logs ?? []);
      setOffset(off);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, level, supplier, endpoint, from, to]);

  useEffect(() => { load(0); }, []);   // load on mount

  function fmt(iso: string) {
    try {
      return new Date(iso).toLocaleString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" });
    } catch { return iso; }
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 1100, margin: "0 auto", padding: "24px 16px" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>TripJack / Supplier API Logs</h1>
      <p style={{ color: "#6b7280", marginBottom: 20, fontSize: 14 }}>
        Every API call to the booking engine with timestamp, endpoint, HTTP status, and error detail.
      </p>

      {/* Filters */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 16 }}>
        <select value={supplier} onChange={(e) => setSupplier(e.target.value)}
          style={sel}>
          <option value="">All suppliers</option>
          <option value="TRIPJACK">TRIPJACK</option>
          <option value="RIYA">RIYA</option>
        </select>
        <select value={level} onChange={(e) => setLevel(e.target.value)}
          style={sel}>
          <option value="">All levels</option>
          <option value="INFO">INFO</option>
          <option value="WARN">WARN</option>
          <option value="ERROR">ERROR</option>
        </select>
        <select value={endpoint} onChange={(e) => setEndpoint(e.target.value)}
          style={sel}>
          <option value="">All endpoints</option>
          {Object.entries(ENDPOINT_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v} ({k})</option>
          ))}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
          style={inp} placeholder="From" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
          style={inp} placeholder="To" />
        <button onClick={() => load(0)} disabled={loading}
          style={{ padding: "6px 18px", background: "#2563eb", color: "#fff", border: "none",
            borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
          {loading ? "Loading…" : "Search"}
        </button>
      </div>

      {error && (
        <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 6,
          padding: "10px 14px", color: "#dc2626", marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* Table */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f3f4f6" }}>
              {["Timestamp (IST)", "Level", "Supplier", "Endpoint", "HTTP", "Duration", "Request ID", "Error"].map((h) => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 && !loading && (
              <tr><td colSpan={8} style={{ textAlign: "center", padding: 32, color: "#9ca3af" }}>No logs found</td></tr>
            )}
            {logs.map((log) => (
              <>
                <tr key={log.id} onClick={() => setExpanded(expanded === log.id ? null : log.id)}
                  style={{ borderBottom: "1px solid #e5e7eb", cursor: "pointer",
                    background: expanded === log.id ? "#f0f9ff" : "transparent" }}>
                  <td style={td}>{fmt(log.createdAt)}</td>
                  <td style={td}>
                    <span style={{ fontWeight: 700, color: LEVEL_COLOR[log.level] ?? "#374151" }}>
                      {log.level}
                    </span>
                  </td>
                  <td style={td}>{log.supplier}</td>
                  <td style={td}>
                    <span title={log.endpoint} style={{ fontFamily: "monospace" }}>
                      {ENDPOINT_LABEL[log.endpoint] ?? log.endpoint}
                    </span>
                  </td>
                  <td style={{ ...td, textAlign: "center" }}>
                    <span style={{
                      fontWeight: 600,
                      color: !log.httpStatus ? "#6b7280"
                        : log.httpStatus < 300 ? "#16a34a"
                        : log.httpStatus < 500 ? "#d97706" : "#dc2626",
                    }}>
                      {log.httpStatus ?? "—"}
                    </span>
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>{log.durationMs != null ? `${log.durationMs} ms` : "—"}</td>
                  <td style={{ ...td, fontFamily: "monospace", fontSize: 11, color: "#6b7280" }}>
                    {log.requestId ? log.requestId.slice(0, 13) + "…" : "—"}
                  </td>
                  <td style={td}>
                    {log.errorCode && (
                      <span style={{ color: "#dc2626", fontWeight: 600 }}>{log.errorCode}</span>
                    )}
                    {log.errorMessage && (
                      <span style={{ color: "#6b7280", marginLeft: 4 }}>— {log.errorMessage.slice(0, 60)}</span>
                    )}
                  </td>
                </tr>
                {expanded === log.id && (
                  <tr key={log.id + "-detail"}>
                    <td colSpan={8} style={{ padding: "12px 16px", background: "#f8fafc",
                      borderBottom: "2px solid #bfdbfe" }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                        <div>
                          <div style={label}>Request ID</div>
                          <code style={code}>{log.requestId ?? "—"}</code>

                          <div style={{ ...label, marginTop: 10 }}>Endpoint</div>
                          <code style={code}>{log.endpoint}</code>

                          <div style={{ ...label, marginTop: 10 }}>Timestamp (UTC)</div>
                          <code style={code}>{log.createdAt}</code>

                          {log.durationMs != null && <>
                            <div style={{ ...label, marginTop: 10 }}>Duration</div>
                            <code style={code}>{log.durationMs} ms</code>
                          </>}
                        </div>
                        <div>
                          {log.requestSummary && (
                            <>
                              <div style={label}>Request Summary</div>
                              <pre style={pre}>{JSON.stringify(log.requestSummary, null, 2)}</pre>
                            </>
                          )}
                          {log.errorMessage && (
                            <>
                              <div style={{ ...label, marginTop: 10 }}>Error Message</div>
                              <pre style={{ ...pre, color: "#dc2626" }}>{log.errorMessage}</pre>
                            </>
                          )}
                          {log.responseSnippet && (
                            <>
                              <div style={{ ...label, marginTop: 10 }}>Response Snippet</div>
                              <pre style={pre}>{log.responseSnippet}</pre>
                            </>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
        <button onClick={() => load(Math.max(0, offset - limit))} disabled={offset === 0 || loading}
          style={pgBtn}>← Prev</button>
        <span style={{ fontSize: 13, color: "#6b7280" }}>Showing {offset + 1}–{offset + logs.length}</span>
        <button onClick={() => load(offset + limit)} disabled={logs.length < limit || loading}
          style={pgBtn}>Next →</button>
      </div>
    </main>
  );
}

// Inline styles (kept minimal — no design system dependency)
const sel: React.CSSProperties = {
  padding: "5px 8px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, minWidth: 140,
};
const inp: React.CSSProperties = {
  padding: "5px 8px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13,
};
const th: React.CSSProperties = {
  textAlign: "left", padding: "8px 10px", fontSize: 12, fontWeight: 700,
  color: "#374151", borderBottom: "2px solid #e5e7eb", whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "8px 10px", verticalAlign: "top",
};
const label: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em",
};
const code: React.CSSProperties = {
  display: "block", fontFamily: "monospace", fontSize: 12, wordBreak: "break-all",
};
const pre: React.CSSProperties = {
  fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all",
  background: "#f1f5f9", padding: "8px", borderRadius: 4, margin: 0, maxHeight: 200, overflow: "auto",
};
const pgBtn: React.CSSProperties = {
  padding: "5px 14px", border: "1px solid #d1d5db", borderRadius: 6,
  background: "#fff", cursor: "pointer", fontSize: 13,
};
