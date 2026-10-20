"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { API, apiHeaders } from "../../../../lib/api";

type Tab = "overview" | "errors" | "passengers" | "payments" | "logs" | "support";
const TABS: [Tab, string][] = [["overview", "Overview"], ["errors", "Booking error log"], ["passengers", "Passengers"], ["payments", "Payments & refunds"], ["logs", "API logs"], ["support", "Support"]];

const ENDPOINT_LABEL: Record<string, string> = {
  "/fms/v1/air-search-all": "Search", "/air-search-all/v2": "Search", "/fms/v1/review": "Fare review",
  "/oms/v1/air/book": "Book", "/oms/v1/booking-details": "Booking details", "/fms/v2/farerule": "Fare rules",
  "/oms/v1/air/amendment/amendment-charges": "Cancellation charges", "/oms/v1/air/amendment/submit-amendment": "Cancellation submit",
  "/oms/v1/air/amendment/amendment-details": "Cancellation status",
};
const STATUS_COLOR: Record<string, string> = {
  TICKETED: "#4ade80", CONFIRMED: "#4ade80", PAYMENT_PENDING: "#fbbf24", HELD: "#fbbf24", PAYMENT_FAILED: "#f87171",
  CANCELLED: "#94a3b8", REFUNDED: "#a78bfa", REFUND_PENDING: "#a5b4fc",
};

const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—");
const money = (v: string | number | null | undefined, cur: string) => v === null || v === undefined ? "—" : `${cur} ${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function BookingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [viewer, setViewer] = useState<{ title: string; name: string; text: string; pretty: boolean } | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/admin/bookings/${id}`, { headers: apiHeaders() });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setData(d);
    } catch (e: any) { setError(e.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function fetchFile(path: string, fallbackName: string) {
    const res = await fetch(`${API}/api/admin/bookings/${id}/${path}`, { headers: apiHeaders() });
    if (!res.ok) { const t = await res.text(); throw new Error(safeError(t) ?? `HTTP ${res.status}`); }
    const cd = res.headers.get("content-disposition") ?? "";
    const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
    return { res, name };
  }

  async function view(x: any, part: "request" | "response") {
    setBusy(`${x.id}-${part}`); setError("");
    try {
      const { res, name } = await fetchFile(`exchanges/${x.id}/${part}`, `${part}.json`);
      setViewer({ title: `${ENDPOINT_LABEL[x.endpoint] ?? x.endpoint} — ${part}`, name, text: await res.text(), pretty: false });
    } catch (e: any) { setError(e.message); } finally { setBusy(""); }
  }

  async function download(path: string, key: string) {
    setBusy(key); setError("");
    try {
      const { res, name } = await fetchFile(path,
        path.endsWith(".zip") ? `booking-${String(id).slice(0, 8)}-tripjack-logs.zip` : `${path.replace(/[^a-z0-9]+/gi, "-")}.json`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a"); a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e: any) { setError(e.message); } finally { setBusy(""); }
  }

  async function refreshDetails() {
    setBusy("refresh"); setError(""); setNotice("");
    try {
      const res = await fetch(`${API}/api/admin/bookings/${id}/refresh-details`, { method: "POST", headers: apiHeaders() });
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setNotice(`Booking details fetched from TripJack${d.details?.pnr ? ` · PNR ${d.details.pnr}` : ""}. ${d.reason ?? ""} Details are in the Booking error log.`);
      setTimeout(load, 1500);
    } catch (e: any) { setError(e.message); } finally { setBusy(""); }
  }

  async function retryBooking() {
    if (!confirm("Book this paid booking with TripJack now?")) return;
    setBusy("retry"); setError(""); setNotice("");
    try {
      const res = await fetch(`${API}/api/admin/bookings/${id}/retry-booking`, { method: "POST", headers: apiHeaders() });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) throw new Error(d.message ?? d.error ?? `HTTP ${res.status}`);
      setNotice(`TripJack booking done — status ${d.status}${d.pnr ? ` · PNR ${d.pnr}` : ""}.`);
    } catch (e: any) { setError(`TripJack booking failed: ${e.message}`); } finally { setBusy(""); load(); }
  }

  if (error && !data) return <div><a href="/bookings" style={backLink}>← Bookings</a><div style={errBox}>{error}</div></div>;
  if (!data) return <p style={{ color: "#64748b" }}>Loading booking…</p>;

  const b = data.booking;
  const fd = (b.flightData ?? {}) as Record<string, unknown>;

  return (
    <div>
      <a href="/bookings" style={backLink}>← Bookings</a>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", margin: "10px 0 16px" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", margin: 0 }}>{b.origin} → {b.destination}</h1>
          <div style={{ color: "#94a3b8", fontSize: 13, marginTop: 4 }}>
            {fmtDate(b.departureDate)} · PNR <strong style={{ color: "#e2e8f0" }}>{b.pnr ?? "—"}</strong> · {b.supplier} {b.supplierBookingRef ?? ""} · <span style={{ fontFamily: "monospace" }}>{b.id}</span>
          </div>
        </div>
        <span style={{ color: STATUS_COLOR[b.status] ?? "#94a3b8", fontWeight: 800, fontSize: 13, border: "1px solid #334155", borderRadius: 20, padding: "5px 12px" }}>{b.status}</span>
      </div>

      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #334155", marginBottom: 16, overflowX: "auto" }}>
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            background: "none", border: 0, borderBottom: `2px solid ${tab === k ? "#E31E24" : "transparent"}`, color: tab === k ? "#f1f5f9" : "#94a3b8",
            padding: "10px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap",
          }}>{label}{k === "errors" ? ` (${(data.events ?? []).filter((e: any) => e.level === "error").length})` : k === "logs" ? ` (${data.exchanges.length})` : k === "support" ? ` (${data.supportRequests.length})` : ""}</button>
        ))}
      </div>

      {error && <div style={errBox}>{error}</div>}
      {b.status === "PAYMENT_PENDING" && (
        <div style={{ ...errBox, display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          <span>
            {data.paymentConfirmed
              ? "Paid, but the airline booking has not completed. The customer is waiting on the confirmation page."
              : "Waiting for payment — no successful payment has been recorded from the gateway yet."}
            {data.paymentConfirmed && <><br />Background job: {data.queueReceipt
              ? `received (attempt ${data.queueReceipt.attempt}, ${new Date(data.queueReceipt.at).toLocaleString()})${data.queueReceipt.error ? ` — failed: ${data.queueReceipt.error}` : ""}`
              : "never received this booking"}</>}
            {data.queueError && <><br /><b>Last error (attempt {data.queueError.attempt}, {new Date(data.queueError.at).toLocaleString()}):</b> {data.queueError.message}</>}
          </span>
          <button disabled={!!busy} onClick={retryBooking} style={btn}>{busy === "retry" ? "Booking with TripJack…" : "Retry airline booking"}</button>
        </div>
      )}
      {(() => {
        const lastError = [...(data.events ?? [])].reverse().find((e: any) => e.level === "error");
        const missing = ["CONFIRMED", "TICKETED", "PAYMENT_PENDING", "PAYMENT_FAILED"].includes(b.status) && (!b.pnr || b.status !== "TICKETED");
        return missing && lastError ? (
          <div style={errBox}>
            <b>Why the PNR / ticket is missing ({lastError.step.replace(/_/g, " ").toLowerCase()}, {new Date(lastError.at).toLocaleString()}):</b> {lastError.message}
            {" "}<button onClick={() => setTab("errors")} style={linkBtn}>See full error log →</button>
          </div>
        ) : null;
      })()}
      {b.status === "PAYMENT_FAILED" && data.queueError && (
        <div style={errBox}><b>Airline booking failed:</b> {data.queueError.message}</div>
      )}
      {notice && <div style={okBox}>{notice}</div>}

      {tab === "overview" && (
        <div style={grid}>
          <Card title="Booking">
            <Row k="Status" v={b.status} /><Row k="Channel" v={b.channel} /><Row k="Trip" v={`${b.tripType} · ${b.cabinClass}`} />
            <Row k="Travellers" v={`${b.adultCount} adult · ${b.childCount} child · ${b.infantCount} infant`} />
            <Row k="Booked" v={fmtDate(b.createdAt)} /><Row k="Updated" v={fmtDate(b.updatedAt)} />
            <Row k="Ticket numbers" v={(b.ticketNumbers ?? []).join(", ") || "—"} />
          </Card>
          <Card title="Supplier">
            <Row k="Supplier" v={b.supplier} /><Row k="Booking ref" v={b.supplierBookingRef ?? "—"} mono />
            <Row k="Fare ID" v={String(fd.id ?? "—")} mono /><Row k="Search ID" v={String(fd.searchId ?? "—")} mono />
          </Card>
          <Card title="Amounts">
            <Row k="Supplier fare" v={money(b.baseFare, b.currency)} /><Row k="Markup" v={money(b.markup, b.currency)} />
            <Row k="Total charged" v={money(b.totalAmount, b.currency)} />
          </Card>
          <Card title="Customer">
            <Row k="Account" v={data.customer ? `${data.customer.name ?? ""} (${data.customer.email ?? ""})` : "Guest"} />
            <Row k="Contact email" v={b.contactEmail ?? "—"} /><Row k="Contact phone" v={b.contactPhone ?? "—"} />
          </Card>
        </div>
      )}

      {tab === "passengers" && (
        <Card title={`Passengers (${data.passengers.length})`}>
          <Table head={["#", "Type", "Name", "Gender", "DOB", "Nationality", "Passport", "Expiry"]}
            rows={data.passengers.map((p: any, i: number) => [i + 1, p.passengerType, `${p.title ? p.title + " " : ""}${p.firstName} ${p.lastName}`, p.gender ?? "—",
              p.dob ? new Date(p.dob).toLocaleDateString("en-IN") : "—", p.nationality ?? "—", p.passportNumber ?? "—",
              p.passportExpiry ? new Date(p.passportExpiry).toLocaleDateString("en-IN") : "—"])} />
        </Card>
      )}

      {tab === "payments" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Card title="Payments">
            <Table head={["Created", "Gateway", "Amount", "Status", "Order / payment ref", "Refunded"]}
              rows={data.payments.map((p: any) => [fmtDate(p.createdAt), p.gateway, money(p.amount, p.currency), p.status,
                `${p.gatewayOrderId ?? "—"} / ${p.gatewayPaymentId ?? "—"}`, p.refundedAmount ? `${money(p.refundedAmount, p.currency)} ${p.refundGatewayRef ?? ""}` : "—"])} />
          </Card>
          <Card title="Cancellations">
            <Table head={["Requested", "Status", "Charges", "Refund", "Method", "Refund status", "Amendment"]}
              rows={data.cancellations.map((a: any) => [fmtDate(a.createdAt), `${a.status}${a.supplierStatus ? ` (${a.supplierStatus})` : ""}`, money(a.supplierCharges, a.currency),
                money(a.refundAmount, a.currency), a.refundMethod, `${a.refundStatus}${a.refundError ? ` — ${a.refundError}` : ""}`, a.supplierAmendmentId ?? "—"])} />
          </Card>
          <Card title="Wallet entries">
            <Table head={["Time", "Type", "Amount", "Balance after", "Note"]}
              rows={data.walletTransactions.map((t: any) => [fmtDate(t.createdAt), t.type, t.amount, t.balanceAfter, t.note ?? ""])} />
          </Card>
        </div>
      )}

      {tab === "errors" && (
        <Card title="Booking error log — why the PNR / ticket was or wasn't issued">
          <p style={{ color: "#94a3b8", fontSize: 13, margin: "0 0 12px" }}>
            Every step after payment: booking with TripJack, booking-details checks for the PNR and ticket numbers, and any refund. Errors include TripJack's own response.
          </p>
          {b.supplier === "TRIPJACK" && b.supplierBookingRef && (
            <div style={{ marginBottom: 12 }}>
              <button disabled={!!busy} onClick={refreshDetails} style={btnGhost}>{busy === "refresh" ? "Fetching…" : "Fetch booking details from TripJack"}</button>
            </div>
          )}
          {data.queueReceipt?.error && (
            <div style={errBox}><b>Background job ({new Date(data.queueReceipt.at).toLocaleString()}, attempt {data.queueReceipt.attempt}):</b> {data.queueReceipt.error}</div>
          )}
          {!(data.events ?? []).length ? (
            <p style={{ color: "#64748b", fontSize: 13 }}>No booking steps recorded yet. Steps are recorded for bookings processed after this log was added — press <b>Retry airline booking</b> or <b>Fetch booking details from TripJack</b> to record them.</p>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {[...data.events].reverse().map((e: any, i: number) => (
                <div key={i} style={{ border: `1px solid ${e.level === "error" ? "#7f1d1d" : e.level === "warn" ? "#78350f" : "#334155"}`, borderRadius: 8, padding: "10px 12px", background: e.level === "error" ? "rgba(239,68,68,.08)" : e.level === "warn" ? "rgba(245,158,11,.08)" : "transparent" }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 12, color: "#94a3b8", marginBottom: 4 }}>
                    <span style={{ fontWeight: 800, color: e.level === "error" ? "#f87171" : e.level === "warn" ? "#fbbf24" : "#4ade80" }}>{e.level.toUpperCase()}</span>
                    <span style={{ fontFamily: "monospace" }}>{e.step}</span>
                    <span>{new Date(e.at).toLocaleString()}</span>
                    {e.repeat > 1 && <span style={{ color: "#fbbf24" }}>×{e.repeat} since {new Date(e.firstAt).toLocaleString()}</span>}
                    {e.detail?.source && <span>· {e.detail.source}</span>}
                  </div>
                  <div style={{ color: "#e2e8f0", fontSize: 13, lineHeight: 1.5 }}>{e.message}</div>
                  {e.detail && (
                    <details style={{ marginTop: 6 }}>
                      <summary style={{ color: "#93c5fd", fontSize: 12, cursor: "pointer" }}>Technical details</summary>
                      <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 11, color: "#cbd5e1", background: "#0f172a", borderRadius: 6, padding: 8, margin: "6px 0 0" }}>{JSON.stringify(e.detail, null, 2)}</pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === "logs" && (
        <Card title="Supplier API request / response logs">
          <p style={{ color: "#94a3b8", fontSize: 13, margin: "0 0 12px" }}>
            Every TripJack call for this booking (and the search it was booked from). Each request and response is a separate JSON file.
            Requests include the exact URL, headers (with the API key) and body sent; responses are stored exactly as received, unmodified.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <button disabled={!!busy || !data.exchanges.length} onClick={() => download("exchanges.zip", "zip")} style={btn}>{busy === "zip" ? "Preparing…" : "Download TripJack certification logs (ZIP)"}</button>
            {b.supplier === "TRIPJACK" && b.supplierBookingRef && (
              <button disabled={!!busy} onClick={refreshDetails} style={btnGhost}>{busy === "refresh" ? "Fetching…" : "Fetch booking details from TripJack"}</button>
            )}
          </div>
          {Array.isArray(data.certification) && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12, fontSize: 13 }}>
              <span style={{ color: "#94a3b8" }}>TripJack certification set:</span>
              {data.certification.map((s: { service: string; logged: boolean }) => (
                <span key={s.service} title={s.logged ? `${s.service}Request.json + ${s.service}Response.json` : `${s.service} call not logged for this booking`}
                  style={{ padding: "3px 10px", borderRadius: 999, fontWeight: 700, background: s.logged ? "#052e16" : "#450a0a", color: s.logged ? "#86efac" : "#fca5a5" }}>
                  {s.logged ? "✓" : "✗"} {s.service}
                </span>
              ))}
            </div>
          )}
          {data.exchanges.length === 0 ? (
            <p style={{ color: "#64748b", fontSize: 13 }}>No raw API logs for this booking yet. Logs are recorded for bookings made after this feature was deployed.</p>
          ) : (
            <Table head={["Time", "Call", "HTTP", "ms", "Request", "Response"]}
              rows={data.exchanges.map((x: any) => [
                fmtDate(x.startedAt),
                <span key="c"><strong>{ENDPOINT_LABEL[x.endpoint] ?? x.endpoint}</strong><small style={{ display: "block", color: "#64748b", fontFamily: "monospace" }}>{x.endpoint}{x.searchId && !x.bookingId ? " · search" : ""}</small></span>,
                <span key="h" style={{ color: x.httpStatus && x.httpStatus < 300 ? "#4ade80" : "#f87171", fontWeight: 700 }}>{x.httpStatus ?? (x.error ? "ERR" : "—")}</span>,
                x.durationMs ?? "—",
                <span key="rq" style={{ display: "flex", gap: 6 }}>
                  <button disabled={!!busy} onClick={() => view(x, "request")} style={small}>View</button>
                  <button disabled={!!busy} onClick={() => download(`exchanges/${x.id}/request`, `${x.id}-rq`)} style={small}>Download</button>
                </span>,
                x.hasResponse ? (
                  <span key="rs" style={{ display: "flex", gap: 6 }}>
                    <button disabled={!!busy} onClick={() => view(x, "response")} style={small}>View</button>
                    <button disabled={!!busy} onClick={() => download(`exchanges/${x.id}/response`, `${x.id}-rs`)} style={small}>Download</button>
                  </span>
                ) : <span key="rs" style={{ color: "#f87171", fontSize: 12 }}>{x.error ?? "No response"}</span>,
              ])} />
          )}
        </Card>
      )}

      {tab === "support" && (
        <Card title="Support requests">
          {data.supportRequests.length === 0 ? <p style={{ color: "#64748b", fontSize: 13 }}>No requests for this booking.</p> : (
            <Table head={["Created", "Type", "Message", "Status", "Reply"]}
              rows={data.supportRequests.map((r: any) => [fmtDate(r.createdAt), r.type, r.message, r.status, r.adminNote ?? "—"])} />
          )}
          <a href="/support" style={{ ...backLink, display: "inline-block", marginTop: 10 }}>Manage in Support →</a>
        </Card>
      )}

      {viewer && (
        <div onClick={() => setViewer(null)} style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,.75)", zIndex: 50, display: "grid", placeItems: "center", padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: "min(1000px, 100%)", maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
              <div><strong style={{ color: "#f1f5f9" }}>{viewer.title}</strong><small style={{ display: "block", color: "#64748b", fontFamily: "monospace" }}>{viewer.name}</small></div>
              <span style={{ display: "flex", gap: 6 }}>
                <button onClick={() => setViewer({ ...viewer, pretty: !viewer.pretty })} style={small}>{viewer.pretty ? "Show raw" : "Pretty print (view only)"}</button>
                <button onClick={() => navigator.clipboard?.writeText(viewer.text)} style={small}>Copy raw</button>
                <button onClick={() => setViewer(null)} style={small}>Close</button>
              </span>
            </div>
            <pre style={{ margin: 0, overflow: "auto", background: "#020617", color: "#e2e8f0", padding: 12, borderRadius: 8, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {viewer.pretty ? prettyOrRaw(viewer.text) : viewer.text}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function prettyOrRaw(text: string) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}
function safeError(text: string) {
  try { return JSON.parse(text).error as string | undefined; } catch { return undefined; }
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <section style={card}><h2 style={{ fontSize: 14, color: "#cbd5e1", margin: "0 0 10px", fontWeight: 700 }}>{title}</h2>{children}</section>;
}
function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderTop: "1px solid #1e293b", fontSize: 13 }}>
      <span style={{ color: "#94a3b8" }}>{k}</span>
      <span style={{ color: "#e2e8f0", textAlign: "right", wordBreak: "break-all", fontFamily: mono ? "monospace" : "inherit" }}>{v}</span>
    </div>
  );
}
function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  if (!rows.length) return <p style={{ color: "#64748b", fontSize: 13, margin: 0 }}>None.</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead><tr>{head.map((h) => <th key={h} style={{ textAlign: "left", color: "#64748b", fontWeight: 600, padding: "6px 8px", borderBottom: "1px solid #334155", whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j} style={{ padding: "8px", borderBottom: "1px solid #1e293b", color: "#e2e8f0", verticalAlign: "top" }}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

const card: React.CSSProperties = { background: "#1e293b", borderRadius: 12, padding: 16, border: "1px solid #334155" };
const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 };
const backLink: React.CSSProperties = { color: "#94a3b8", fontSize: 13, textDecoration: "none" };
const btn: React.CSSProperties = { background: "#E31E24", color: "#fff", border: 0, borderRadius: 8, padding: "8px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer" };
const btnGhost: React.CSSProperties = { ...btn, background: "#0f172a", border: "1px solid #334155", color: "#e2e8f0" };
const small: React.CSSProperties = { background: "#0f172a", border: "1px solid #334155", color: "#e2e8f0", borderRadius: 6, padding: "4px 8px", fontWeight: 600, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" };
const errBox: React.CSSProperties = { background: "rgba(239,68,68,.1)", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 8, padding: "10px 12px", fontSize: 13, margin: "10px 0" };
const linkBtn: React.CSSProperties = { background: "none", border: 0, color: "#93c5fd", fontWeight: 700, fontSize: 13, cursor: "pointer", padding: 0 };
const okBox: React.CSSProperties = { background: "rgba(34,197,94,.1)", border: "1px solid #166534", color: "#86efac", borderRadius: 8, padding: "10px 12px", fontSize: 13, margin: "10px 0" };
