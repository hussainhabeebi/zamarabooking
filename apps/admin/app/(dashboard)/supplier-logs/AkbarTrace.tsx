"use client";
// Akbar request trace (read-only): paste a request ID from Supplier logs to see that request's Akbar
// calls (e.g. checkout SmartPricer, stored even when no booking was created) and the search they came
// from, field by field, with each pricing call checked against the search. Raw files: the existing
// ZIP download (secrets blanked when recorded). No passenger, contact or credential fields are shown.
import { useState } from "react";
import { API, apiHeaders } from "@/lib/api";

type Trip = { index: string | null; orderId: number | string | null; amount: number | null; channelCode: string | null; tui: string | null; from?: string; to?: string; onwardDate?: string; returnDate?: string };
type Call = {
  id: string; startedAt: string; endpoint: string; service: string; httpStatus: number | null; durationMs: number | null; error: string | null;
  searchId: string | null; requestId: string | null;
  request: { tui: string | null; fareType: string | null; mode: string | null; options: string | null; tripType: string | null; source: string | null; secType: string | null; clientId: string; netAmount: number | null; trips: Trip[] } | null;
  response: { code: string | null; messages: string[]; tui: string | null; netAmount: number | null; completed: string | null; journeysPerTrip: number[] } | null;
};
type Journey = { index: string; returnIdentifier: number | null; vac: string | null; provider: string | null; netFare: number | null; flightNo: string | null; departureTime: string | null };
type Check = {
  callId: string; service: string; tui: string | null; searchFound: boolean; secondsAfterSearch: number | null;
  trips: { orderId: number | string | null; index: string | null; amount: number | null; found: Journey | null; amountMatches: boolean | null }[];
  specialFarePair: { returnIdentifierEqual: boolean; vacEqual: boolean; providerEqual: boolean } | null;
};
type Trace = { requestId: string; searchIds: string[]; errors: { createdAt: string; endpoint: string; errorCode: string | null; errorMessage: string | null }[]; calls: Call[]; checks: Check[]; note?: string };

const t = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
const yes = (v: boolean | null | undefined) => (v == null ? "—" : v ? "✓" : "✗");
const q = (v: string | null | undefined) => (v == null ? "—" : v === "" ? '""' : v);

export function AkbarTrace() {
  const [requestId, setRequestId] = useState("");
  const [trace, setTrace] = useState<Trace | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setBusy(true); setError(""); setTrace(null);
    try {
      const res = await fetch(`${API}/api/admin/supplier-logs/akbar-trace?requestId=${encodeURIComponent(requestId.trim())}`, { headers: apiHeaders() });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.message ?? d.error ?? `HTTP ${res.status}`);
      setTrace(d);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  async function zip() {
    if (!trace?.calls.length) return;
    const res = await fetch(`${API}/api/admin/supplier-logs/exchanges.zip?scope=akbar&ids=${trace.calls.map((c) => c.id).join(",")}&name=akbar-trace-${trace.requestId.slice(0, 8)}`, { headers: apiHeaders() });
    if (!res.ok) { setError(`ZIP: HTTP ${res.status}`); return; }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a"); a.href = url; a.download = `akbar-trace-${trace.requestId.slice(0, 8)}.zip`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  return (
    <section style={{ marginTop: 28, background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, padding: 16 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9", margin: "0 0 6px" }}>Akbar request trace</h2>
      <p style={{ color: "#64748b", fontSize: 12, margin: "0 0 10px" }}>
        Paste the request ID of an Akbar error (e.g. checkout SmartPricer). Shows that request&apos;s Akbar calls and its search, field by field. Read-only; no passenger, contact or credential data.
      </p>
      <form onSubmit={(e) => { e.preventDefault(); void load(); }} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input value={requestId} onChange={(e) => setRequestId(e.target.value)} placeholder="Request ID" style={{ ...input, minWidth: 320 }} />
        <button type="submit" disabled={busy || requestId.trim().length < 8} style={pill}>{busy ? "Loading…" : "Show trace"}</button>
        {trace?.calls.length ? <button type="button" style={pill} onClick={() => void zip()}>Download raw files (ZIP)</button> : null}
      </form>
      {error && <p style={{ color: "#fca5a5", fontSize: 13 }}>{error}</p>}
      {trace && (
        <div style={{ marginTop: 12, fontSize: 13, color: "#cbd5e1" }}>
          {trace.note && <p style={{ color: "#fbbf24" }}>{trace.note}</p>}
          {trace.errors.map((e, i) => <p key={i} style={{ color: "#fca5a5", margin: "2px 0" }}>{t(e.createdAt)} · {e.endpoint} · {e.errorCode ?? ""} — {e.errorMessage}</p>)}
          {trace.checks.map((c) => (
            <div key={c.callId} style={{ border: "1px solid #334155", borderRadius: 8, padding: 10, margin: "10px 0" }}>
              <b style={{ color: "#f1f5f9" }}>{c.service} vs its search</b>{" "}
              <span>· search TUI in this trace: {yes(c.searchFound)} · {c.secondsAfterSearch == null ? "" : `${Math.floor(c.secondsAfterSearch / 60)} min ${c.secondsAfterSearch % 60} s after ExpressSearch`}</span>
              <div style={{ color: "#94a3b8", fontSize: 12, wordBreak: "break-all" }}>TUI {q(c.tui)}</div>
              <table style={tbl}><thead><tr>{["OrderID", "Index", "Amount", "In search", "NetFare", "Amount = NetFare", "ReturnIdentifier", "VAC", "Provider", "Flight"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>{c.trips.map((x, i) => (
                  <tr key={i}><td style={td}>{x.orderId ?? "—"}</td><td style={td}>{q(x.index)}</td><td style={td}>{x.amount ?? "—"}</td><td style={td}>{yes(!!x.found)}</td>
                    <td style={td}>{x.found?.netFare ?? "—"}</td><td style={td}>{yes(x.amountMatches)}</td><td style={td}>{x.found?.returnIdentifier ?? "—"}</td>
                    <td style={td}>{q(x.found?.vac)}</td><td style={td}>{q(x.found?.provider)}</td><td style={td}>{x.found ? `${x.found.flightNo ?? ""} ${x.found.departureTime ?? ""}` : "—"}</td></tr>
                ))}</tbody></table>
              {c.specialFarePair && <div>Special Fare pair — ReturnIdentifier equal {yes(c.specialFarePair.returnIdentifierEqual)} · VAC equal {yes(c.specialFarePair.vacEqual)} · Provider equal {yes(c.specialFarePair.providerEqual)}</div>}
            </div>
          ))}
          <div style={{ overflowX: "auto" }}>
            <table style={tbl}><thead><tr>{["Time", "Call", "HTTP", "Request", "Response"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>{trace.calls.map((c) => (
                <tr key={c.id} style={{ borderTop: "1px solid #1e293b" }}>
                  <td style={td}>{t(c.startedAt)}<div style={{ color: "#475569", fontSize: 11 }}>{c.requestId ? "this request" : "search"}</div></td>
                  <td style={td}>{c.service}{c.error && <div style={{ color: "#fca5a5", fontSize: 12 }}>{c.error}</div>}</td>
                  <td style={td}>{c.httpStatus ?? "—"}</td>
                  <td style={{ ...td, fontSize: 12 }}>{c.request ? <>
                    {c.request.fareType && <>FareType {c.request.fareType} · </>}{c.request.mode && <>Mode {c.request.mode} · </>}
                    {c.request.options != null && <>Options {q(c.request.options)} · </>}{c.request.tripType && <>TripType {c.request.tripType} · </>}
                    {c.request.secType != null && <>SecType {q(c.request.secType)} · </>}ClientID {c.request.clientId}
                    {c.request.tui && <div style={{ wordBreak: "break-all" }}>TUI {c.request.tui}</div>}
                    {c.request.trips.map((x, i) => <div key={i}>{x.from ? `${x.from}→${x.to} ${x.onwardDate}${x.returnDate ? ` / ${x.returnDate}` : ""}` : `#${x.orderId ?? i + 1} ${q(x.index)} · Amount ${x.amount ?? "—"} · ChannelCode ${q(x.channelCode)}`}</div>)}
                  </> : "—"}</td>
                  <td style={{ ...td, fontSize: 12 }}>{c.response ? <>
                    Code {q(c.response.code)}{c.response.messages.length ? ` · ${c.response.messages.join("; ")}` : ""}
                    {c.response.netAmount != null && <> · NetAmount {c.response.netAmount}</>}{c.response.completed && <> · Completed {c.response.completed}</>}
                    {c.response.journeysPerTrip.length > 0 && <> · journeys {c.response.journeysPerTrip.join(" / ")}</>}
                    {c.response.tui && <div style={{ wordBreak: "break-all", color: "#94a3b8" }}>TUI {c.response.tui}</div>}
                  </> : "—"}</td>
                </tr>
              ))}</tbody></table>
          </div>
        </div>
      )}
    </section>
  );
}

const input: React.CSSProperties = { background: "#1e293b", color: "#f1f5f9", border: "1px solid #334155", borderRadius: 8, padding: "7px 10px", fontSize: 13 };
const pill: React.CSSProperties = { background: "#1e293b", color: "#f1f5f9", border: "1px solid #334155", borderRadius: 8, padding: "7px 12px", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const tbl: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 6 };
const th: React.CSSProperties = { padding: "6px 8px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "#475569", textTransform: "uppercase", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "6px 8px", verticalAlign: "top", color: "#cbd5e1" };
