import { serverAuthHeaders } from "../../../lib/server";
import { LogDetail } from "./LogDetail";
import { RawApiCalls } from "./RawApiCalls";

const SERVER_API   = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
const SERVER_TOKEN = process.env.ADMIN_SERVICE_TOKEN ?? "";

interface LogEntry {
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
}

const LEVEL_COLOR: Record<string, string> = {
  INFO:  "#4ade80",
  WARN:  "#fbbf24",
  ERROR: "#f87171",
};

const ENDPOINT_LABEL: Record<string, string> = {
  "/fms/v1/review":               "Fare Review",
  "/oms/v1/air/book":             "Book",
  "flight-search":                "Flight Search",
  "/air-search-all/v2":           "Search",
  "/fms/v2/farerule":             "Fare Rules",
  "/oms/v1/booking-details":      "PNR Status",
  "/oms/v1/air/amendment/submit-amendment": "Cancel",
  "db:bookings:insert":           "DB Save",
  "/hms/v3/hotel/listing":        "Hotel Search",
  "/hms/v3/hotel/pricing":        "Hotel Detail",
  "/hms/v3/hotel/review":         "Hotel Review",
  "/oms/v3/hotel/book":           "Hotel Book",
  "/oms/v3/hotel/confirm-book":   "Hotel Confirm Hold",
  "/oms/v3/hotel/booking-details": "Hotel Booking Details",
  "/oms/v3/hotel/cancel-booking": "Hotel Cancel",
  "/oms/v1/hotel/bookings":       "Hotel Booking List",
  "/hms/v3/nationality-info":     "Hotel Nationalities",
  "/hms/v3/content/fetch-city-regionIds": "Hotel City Sync",
  "/hms/v3/hotel/static-detail":  "Hotel Static Detail",
  "/hms/v3/content/fetch-hotel-content": "Hotel Content",
  "hotel search":                 "Hotel Search (rejected)",
  "hotel detail":                 "Hotel Detail (rejected)",
  "hotel review":                 "Hotel Review (rejected)",
  "hotel book":                   "Hotel Book (rejected)",
  "/insurance/v2/search":         "TripSafe Search",
  "/insurance/v2/booking":        "TripSafe Booking / Detail",
  "/insurance/v2/amendment/raise": "TripSafe Raise Amendment",
  "/insurance/v2/amendment/confirm": "TripSafe Confirm Amendment",
};

async function getLogs(sp: Record<string, string>): Promise<{ logs: LogEntry[]; fetchError?: string }> {
  try {
    const q = new URLSearchParams();
    if (sp.level)    q.set("level", sp.level);
    if (sp.supplier) q.set("supplier", sp.supplier);
    if (sp.endpoint) q.set("endpoint", sp.endpoint);
    if (sp.scope)    q.set("scope", sp.scope);
    if (sp.from)     q.set("from", sp.from);
    if (sp.to)       q.set("to", sp.to);
    q.set("limit",  String(Math.min(parseInt(sp.limit ?? "100"), 500)));
    q.set("offset", sp.offset ?? "0");
    const headers = await serverAuthHeaders();
    if (headers.Authorization === "Bearer ") return { logs: [], fetchError: "Sign in again — no admin token found" };
    const res = await fetch(`${SERVER_API}/api/admin/supplier-logs?${q}`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { logs: [], fetchError: `API returned HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = await res.json() as any;
    if (data.error) return { logs: [], fetchError: `API error: ${data.error} — ${data.details ?? ""}` };
    return { logs: data.logs ?? [], ...data };
  } catch (err) {
    return { logs: [], fetchError: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function fmtTime(iso: string) {
  try {
    return new Date(iso).toLocaleString("en-IN", {
      hour12: false, timeZone: "Asia/Kolkata",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch { return iso; }
}

export default async function SupplierLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const sp = await searchParams;
  const { logs, fetchError } = await getLogs(sp);

  const offset  = parseInt(sp.offset ?? "0");
  const limit   = parseInt(sp.limit  ?? "100");

  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;

  function buildHref(overrides: Record<string, string>) {
    const p = new URLSearchParams({ ...sp, ...overrides });
    return `/supplier-logs?${p}`;
  }

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9" }}>Supplier API Logs</h1>
        <p style={{ color: "#64748b", fontSize: 13, marginTop: 4 }}>
          Every TripJack / Riya API call (flights and hotels) — timestamp, endpoint, HTTP status, error detail.
        </p>
      </div>

      {/* Error banner */}
      {fetchError && (
        <div style={{
          background: "rgba(239,68,68,.12)", border: "1px solid #ef4444",
          borderRadius: 8, padding: "12px 16px", marginBottom: 20,
          color: "#fca5a5", fontSize: 13, fontFamily: "monospace",
        }}>
          ⚠ {fetchError}
        </div>
      )}

      {/* Filters */}
      <form method="GET" style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 24 }}>
        <select name="supplier" defaultValue={sp.supplier ?? "TRIPJACK"} style={sel}>
          <option value="">All suppliers</option>
          <option value="TRIPJACK">TRIPJACK</option>
          <option value="RIYA">RIYA</option>
          <option value="DUFFEL">DUFFEL</option>
          <option value="GOOGLE_SERP">GOOGLE_SERP</option>
        </select>
        <select name="scope" defaultValue={sp.scope ?? ""} style={sel}>
          <option value="">Flights, hotels &amp; TripSafe</option>
          <option value="hotel">Hotels only</option>
        </select>
        <select name="level" defaultValue={sp.level ?? ""} style={sel}>
          <option value="">All levels</option>
          <option value="INFO">INFO</option>
          <option value="WARN">WARN</option>
          <option value="ERROR">ERROR</option>
        </select>
        <select name="endpoint" defaultValue={sp.endpoint ?? ""} style={sel}>
          <option value="">All endpoints</option>
          {Object.entries(ENDPOINT_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <input name="from" type="date" defaultValue={sp.from ?? ""} style={inp} />
        <input name="to"   type="date" defaultValue={sp.to   ?? ""} style={inp} />
        <button type="submit" style={btn}>Search</button>
      </form>

      {/* Table */}
      <div style={{ overflowX: "auto", borderRadius: 10, border: "1px solid #1e293b" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#1e293b" }}>
              {["Timestamp (IST)", "Level", "Supplier", "Endpoint", "HTTP", "ms", "Request ID", "Error"].map((h) => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 && (
              <tr>
                <td colSpan={8} style={{ textAlign: "center", padding: 40, color: "#475569" }}>
                  No logs found for these filters.
                </td>
              </tr>
            )}
            {logs.map((log, i) => (
              <tr key={log.id} style={{
                borderTop: i === 0 ? "none" : "1px solid #1e293b",
                background: log.level === "ERROR" ? "rgba(239,68,68,.04)" : "transparent",
              }}>
                <td style={td}><span style={{ fontFamily: "monospace", fontSize: 12 }}>{fmtTime(log.createdAt)}</span></td>
                <td style={td}>
                  <span style={{ fontWeight: 700, color: LEVEL_COLOR[log.level] ?? "#94a3b8", fontSize: 11 }}>
                    {log.level}
                  </span>
                </td>
                <td style={td}><span style={{ color: "#94a3b8" }}>{log.supplier}</span></td>
                <td style={td}>
                  <span style={{ color: "#e2e8f0" }}>{ENDPOINT_LABEL[log.endpoint] ?? log.endpoint}</span>
                  <span style={{ display: "block", fontFamily: "monospace", fontSize: 10, color: "#475569" }}>
                    {log.endpoint}
                  </span>
                </td>
                <td style={{ ...td, textAlign: "center" }}>
                  {log.httpStatus ? (
                    <span style={{
                      fontWeight: 700,
                      color: log.httpStatus < 300 ? "#4ade80"
                        : log.httpStatus < 500 ? "#fbbf24" : "#f87171",
                    }}>
                      {log.httpStatus}
                    </span>
                  ) : <span style={{ color: "#475569" }}>—</span>}
                </td>
                <td style={{ ...td, textAlign: "right", color: "#64748b" }}>
                  {log.durationMs != null ? log.durationMs : "—"}
                </td>
                <td style={{ ...td }}>
                  <span style={{ fontFamily: "monospace", fontSize: 11, color: "#475569" }}>
                    {log.requestId ? log.requestId.slice(0, 8) + "…" : "—"}
                  </span>
                </td>
                <td style={td}>
                  {log.errorCode && (
                    <span style={{ color: "#f87171", fontWeight: 600, fontSize: 12 }}>{log.errorCode}</span>
                  )}
                  <LogDetail
                    errorCode={log.errorCode}
                    errorMessage={log.errorMessage}
                    requestSummary={log.requestSummary}
                    responseSnippet={log.responseSnippet}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div style={{ display: "flex", gap: 10, marginTop: 16, alignItems: "center" }}>
        {offset > 0 && (
          <a href={buildHref({ offset: String(prevOffset) })} style={pgA}>← Prev</a>
        )}
        <span style={{ fontSize: 13, color: "#64748b" }}>
          Showing {offset + 1}–{offset + logs.length}
        </span>
        {logs.length === limit && (
          <a href={buildHref({ offset: String(nextOffset) })} style={pgA}>Next →</a>
        )}
      </div>

      <RawApiCalls initialScope="hotel" />
    </div>
  );
}

const sel: React.CSSProperties = {
  background: "#1e293b", color: "#f1f5f9", border: "1px solid #334155",
  borderRadius: 8, padding: "9px 12px", fontSize: 13,
};
const inp: React.CSSProperties = {
  background: "#1e293b", color: "#f1f5f9", border: "1px solid #334155",
  borderRadius: 8, padding: "9px 12px", fontSize: 13,
};
const btn: React.CSSProperties = {
  background: "#E31E24", color: "#fff", border: "none",
  borderRadius: 8, padding: "9px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer",
};
const th: React.CSSProperties = {
  padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 700,
  color: "#475569", textTransform: "uppercase", letterSpacing: "0.05em",
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "10px 14px", verticalAlign: "top", color: "#cbd5e1",
};
const pgA: React.CSSProperties = {
  padding: "6px 16px", border: "1px solid #334155", borderRadius: 6,
  background: "#1e293b", color: "#94a3b8", textDecoration: "none", fontSize: 13,
};
