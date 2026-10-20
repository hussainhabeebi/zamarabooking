"use client";
// Admin → TripSafe (TripJack travel insurance v2): bookings, policy issue,
// cancellations / corrections, UAT test console and certification logs.
import { useCallback, useEffect, useState } from "react";
import { API, apiHeaders } from "@/lib/api";

type Destination = { key: string; type: string };
type Amendment = { amendmentId: string; type: string; status: string; amount?: number; refund?: number; remarks?: string; at: string; travellerIds?: number[] };
type Record_ = {
  reference: string; createdAt: string; status: string; environment: string; journey: string;
  input: { startDate: string; endDate?: string; coverageDuration?: number; destinations: Destination[]; travellerDobs: string[] };
  searchId: string; productId: string;
  product: { planCoverage: string; insuranceProvider: string; regionName: string; planType: string; totalFare: number };
  travellers: { firstName: string; lastName: string; dob: string }[];
  contact: { email: string; phone?: string };
  tripjack?: { bookingId: string; status: string; paymentResult?: { status?: string; errorCode?: string; errorMessage?: string } };
  policies?: { travellerId: number | null; name: string; policyId?: string }[];
  error?: string; amendments?: Amendment[];
};
type Detail = Record_ & {
  customerLink: string; detailError?: string;
  details?: { status: string; travellers: { travellerId: number | null; name: string; dob?: string; policyId?: string; coiUrl?: string; totalFare?: number }[]; totalAmount?: number } | null;
};
type Exchange = { id: string; endpoint: string; httpStatus: number | null; durationMs: number | null; error: string | null; bookingId: string | null; searchId: string | null; startedAt: string; hasResponse: boolean };

const card: React.CSSProperties = { background: "#1e293b", border: "1px solid #334155", borderRadius: 12, padding: 16, marginBottom: 16 };
const input: React.CSSProperties = { background: "#0f172a", border: "1px solid #334155", borderRadius: 8, color: "#f1f5f9", padding: "8px 10px", fontSize: 13, width: "100%", boxSizing: "border-box" };
const btn = (color = "#2563eb", disabled = false): React.CSSProperties => ({ background: color, color: "#fff", border: 0, borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1 });
const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", color: "#94a3b8", fontSize: 12, borderBottom: "1px solid #334155", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "8px 10px", color: "#e2e8f0", fontSize: 13, borderBottom: "1px solid #1e293b", verticalAlign: "top" };
const label: React.CSSProperties = { display: "block", color: "#94a3b8", fontSize: 12, marginBottom: 4 };

const inr = (n?: number) => (typeof n === "number" ? `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : "—");
const statusColor = (s: string) => (["SUCCESS", "BOOKED"].includes(s) ? "#4ade80" : ["FAILED", "CANCELLED", "PAYMENT_FAILED", "REJECTED"].includes(s) ? "#f87171" : "#fbbf24");
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const dobForAge = (age: number) => { const d = new Date(); d.setFullYear(d.getFullYear() - age); d.setMonth(0, 15); return d.toISOString().slice(0, 10); };

async function call<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: apiHeaders() });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error ?? d.message ?? `HTTP ${res.status}`);
  return d as T;
}

async function downloadZip(path: string, fallback: string) {
  const res = await fetch(`${API}${path}`, { headers: apiHeaders() });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.message ?? d.error ?? `HTTP ${res.status}`); }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? fallback;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// TripSafe v2 UAT test cases (Go-Live → UAT Test Cases).
const PRESETS: { name: string; body: any }[] = [
  { name: "TC01 Standalone · Europe region · 30/65/12", body: { journey: "STANDALONE", startDate: day(5), endDate: day(15), destinations: [{ key: "EUR", type: "REGION" }], travellerDobs: [30, 65, 12].map(dobForAge) } },
  { name: "TC02 Standalone · US · +5→+180 · 6 pax", body: { journey: "STANDALONE", startDate: day(5), endDate: day(180), destinations: [{ key: "US", type: "COUNTRY" }], travellerDobs: [22, 5, 3, 45, 56, 67].map(dobForAge) } },
  { name: "Standalone · 3 countries · 5 days · 4 pax", body: { journey: "STANDALONE", startDate: day(5), endDate: day(9), destinations: ["FR", "DE", "IT"].map((key) => ({ key, type: "COUNTRY" })), travellerDobs: [34, 31, 8, 60].map(dobForAge) } },
  { name: "Standalone · 2 regions · 90 days · 10 pax", body: { journey: "STANDALONE", startDate: day(5), endDate: day(94), destinations: [{ key: "EUR", type: "REGION" }, { key: "ASI", type: "REGION" }], travellerDobs: [25, 28, 31, 34, 37, 40, 43, 46, 49, 52].map(dobForAge) } },
  { name: "TC03 Student · Malaysia · 90 days · 40/18", body: { journey: "STUDENT", startDate: day(5), coverageDuration: 90, destinations: [{ key: "MY", type: "COUNTRY" }], travellerDobs: [40, 18].map(dobForAge) } },
  { name: "Student · 1 country · 180 days · 2 pax", body: { journey: "STUDENT", startDate: day(5), coverageDuration: 180, destinations: [{ key: "US", type: "COUNTRY" }], travellerDobs: [21, 24].map(dobForAge) } },
  { name: "Student · 1 country · 365 days · 3 pax", body: { journey: "STUDENT", startDate: day(5), coverageDuration: 365, destinations: [{ key: "GB", type: "COUNTRY" }], travellerDobs: [19, 23, 30].map(dobForAge) } },
  { name: "AMT · 1 region · 30 days · 4 pax", body: { journey: "AMT", startDate: day(5), coverageDuration: 30, destinations: [{ key: "EUR", type: "POPULARREGION" }], travellerDobs: [35, 33, 10, 8].map(dobForAge) } },
  { name: "AMT · 1 region · 60 days · 8 pax", body: { journey: "AMT", startDate: day(5), coverageDuration: 60, destinations: [{ key: "USC", type: "POPULARREGION" }], travellerDobs: [30, 32, 34, 36, 38, 40, 42, 44].map(dobForAge) } },
  { name: "AMT negative · 50 days (must fail)", body: { journey: "AMT", startDate: day(5), coverageDuration: 50, destinations: [{ key: "EUR", type: "POPULARREGION" }], travellerDobs: [35].map(dobForAge) } },
  { name: "TC04 Embedded · Middle East · 35/40/60", body: { journey: "EMBEDDED", startDate: day(10), endDate: day(17), destinations: [{ key: "MDE", type: "REGION" }], travellerDobs: [35, 40, 60].map(dobForAge) } },
  { name: "Embedded one-way · departure +90 days", body: { journey: "EMBEDDED", startDate: day(10), endDate: day(100), destinations: [{ key: "AE", type: "COUNTRY" }], travellerDobs: [30].map(dobForAge) } },
  { name: "Domestic · India · 7 days", body: { journey: "DOMESTIC", startDate: day(5), endDate: day(11), destinations: [{ key: "IN", type: "COUNTRY" }], travellerDobs: [30].map(dobForAge) } },
];

export default function TripsafeAdminPage() {
  const [settings, setSettings] = useState<{ tripsafeEnabled?: boolean; environment?: string; tripsafePayUserId?: string } | null>(null);
  const [rows, setRows] = useState<Record_[] | null>(null);
  const [error, setError] = useState("");
  const [openRef, setOpenRef] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const [s, b] = await Promise.all([call("/api/admin/integrations/tripjack"), call<{ bookings: Record_[] }>("/api/admin/tripsafe/bookings")]);
      setSettings(s); setRows(b.bookings);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div style={{ padding: 24, maxWidth: 1300 }}>
      <h1 style={{ color: "#f1f5f9", fontSize: 22, margin: "0 0 4px" }}>TripSafe travel insurance</h1>
      <p style={{ color: "#94a3b8", fontSize: 13, margin: "0 0 16px" }}>
        TripJack Insurance API v2 · customer page <code>/insurance</code> · {settings ? <>
          {settings.tripsafeEnabled ? <b style={{ color: "#4ade80" }}>enabled</b> : <b style={{ color: "#f87171" }}>disabled (Integrations → TripJack → Enable TripSafe)</b>} · {settings.environment ?? "UAT"}
          {settings.tripsafeEnabled && !settings.tripsafePayUserId && <b style={{ color: "#fbbf24" }}> · no payUserId: bookings stay PAYMENT_PENDING</b>}
        </> : "…"}
      </p>
      {error && <div style={{ ...card, borderColor: "#7f1d1d", color: "#fca5a5" }}>{error}</div>}

      <section style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <b style={{ color: "#f1f5f9" }}>Bookings</b>
          <button type="button" style={btn("#334155")} onClick={() => void load()}>Reload</button>
        </div>
        {!rows ? <p style={{ color: "#94a3b8" }}>Loading…</p> : !rows.length ? <p style={{ color: "#94a3b8", fontSize: 13 }}>No TripSafe bookings yet.</p> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["Reference", "Created", "Journey", "Plan", "Trip", "Travellers", "Premium", "Status", "TripJack"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.reference} onClick={() => setOpenRef(openRef === r.reference ? null : r.reference)} style={{ cursor: "pointer", background: openRef === r.reference ? "#0f172a" : undefined }}>
                    <td style={td}><b>{r.reference}</b></td>
                    <td style={td}>{new Date(r.createdAt).toLocaleString()}</td>
                    <td style={td}>{r.journey}</td>
                    <td style={td}>{r.product.planCoverage} · {r.product.insuranceProvider}<div style={{ color: "#64748b", fontSize: 11 }}>{r.productId}</div></td>
                    <td style={td}>{r.input.startDate} → {r.input.endDate ?? `${r.input.coverageDuration}d`}<div style={{ color: "#64748b", fontSize: 11 }}>{r.input.destinations.map((d) => d.key).join(", ")}</div></td>
                    <td style={td}>{r.travellers.length}</td>
                    <td style={td}>{inr(r.product.totalFare)}</td>
                    <td style={{ ...td, color: statusColor(r.tripjack?.status ?? r.status), fontWeight: 700 }}>{r.tripjack?.status ?? r.status}</td>
                    <td style={td}>{r.tripjack?.bookingId ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {openRef && <BookingDetail key={openRef} reference={openRef} onChanged={load} />}
      <TestConsole />
      <ApiLogs />
    </div>
  );
}

function BookingDetail({ reference, onChanged }: { reference: string; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [cancelIds, setCancelIds] = useState<Set<number>>(new Set());
  const [remarks, setRemarks] = useState("");
  const [corr, setCorr] = useState({ mode: "traveller", id: 1, field: "lastName", value: "", startDate: "", endDate: "" });

  const load = useCallback(async () => {
    try { setD(await call<Detail>(`/api/admin/tripsafe/bookings/${reference}`)); } catch (e: any) { setMsg({ tone: "bad", text: e.message }); }
  }, [reference]);
  useEffect(() => { void load(); }, [load]);

  async function act(name: string, fn: () => Promise<any>, ok: (r: any) => string) {
    setBusy(name); setMsg(null);
    try { const r = await fn(); setMsg({ tone: "ok", text: ok(r) }); await load(); onChanged(); }
    catch (e: any) { setMsg({ tone: "bad", text: e.message }); }
    finally { setBusy(""); }
  }

  if (!d) return <section style={card}><p style={{ color: "#94a3b8" }}>Loading {reference}…</p>{msg && <p style={{ color: "#fca5a5" }}>{msg.text}</p>}</section>;
  const policies = d.details?.travellers ?? [];
  const booked = Boolean(d.tripjack?.bookingId);
  const pendingAmendments = (d.amendments ?? []).filter((a) => a.status === "REQUESTED");

  return (
    <section style={{ ...card, borderColor: "#6366f1" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <b style={{ color: "#f1f5f9" }}>{d.reference} · {d.tripjack?.bookingId ?? "not booked with TripJack"} · <span style={{ color: statusColor(d.details?.status ?? d.tripjack?.status ?? d.status) }}>{d.details?.status ?? d.tripjack?.status ?? d.status}</span></b>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {!booked && <button type="button" disabled={!!busy} style={btn("#16a34a", !!busy)} onClick={() => act("issue", () => call(`/api/admin/tripsafe/bookings/${reference}/issue`, { method: "POST" }), (r) => `Booked ${r.bookingId} (${r.status})${r.warning ? ` — ${r.warning}` : ""}`)}>{busy === "issue" ? "Issuing…" : "Issue policy (TripJack wallet)"}</button>}
          {booked && <button type="button" disabled={!!busy} style={btn("#334155", !!busy)} onClick={() => act("refresh", () => call(`/api/admin/tripsafe/bookings/${reference}/refresh`, { method: "POST" }), (r) => `Status ${r.details?.status}`)}>Refresh</button>}
          <button type="button" disabled={!!busy} style={btn("#2563eb", !!busy)} onClick={() => act("zip", () => downloadZip(`/api/admin/tripsafe/bookings/${reference}/certification.zip`, `tripsafe-${reference}-logs.zip`), () => "Certification logs downloaded")}>Certification logs (ZIP)</button>
          <a href={d.customerLink} target="_blank" rel="noreferrer" style={{ ...btn("#334155"), textDecoration: "none" }}>Customer page ↗</a>
        </div>
      </div>
      {msg && <div style={{ padding: "8px 10px", borderRadius: 8, marginBottom: 10, fontSize: 13, background: msg.tone === "ok" ? "#052e16" : "#450a0a", color: msg.tone === "ok" ? "#86efac" : "#fca5a5", whiteSpace: "pre-wrap" }}>{msg.text}</div>}
      {d.error && <div style={{ padding: "8px 10px", borderRadius: 8, marginBottom: 10, fontSize: 13, background: "#422006", color: "#fcd34d" }}>{d.error}</div>}
      {d.detailError && <div style={{ padding: "8px 10px", borderRadius: 8, marginBottom: 10, fontSize: 13, background: "#450a0a", color: "#fca5a5" }}>Booking detail: {d.detailError}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, fontSize: 13, color: "#cbd5e1", marginBottom: 12 }}>
        <div><span style={label}>Journey</span>{d.journey} · {d.environment}</div>
        <div><span style={label}>Plan</span>{d.product.planCoverage} · {d.product.insuranceProvider} · {d.product.regionName}</div>
        <div><span style={label}>Trip</span>{d.input.startDate} → {d.input.endDate ?? `${d.input.coverageDuration} days`} · {d.input.destinations.map((x) => `${x.key}/${x.type}`).join(", ")}</div>
        <div><span style={label}>Premium</span>{inr(d.details?.totalAmount ?? d.product.totalFare)}</div>
        <div><span style={label}>Contact</span>{d.contact.email}{d.contact.phone ? ` · ${d.contact.phone}` : ""}</div>
        <div><span style={label}>searchId / productId</span>{d.searchId} · {d.productId}</div>
        {d.tripjack?.paymentResult && <div><span style={label}>Payment</span>{d.tripjack.paymentResult.status}{d.tripjack.paymentResult.errorMessage ? ` — ${d.tripjack.paymentResult.errorCode}: ${d.tripjack.paymentResult.errorMessage}` : ""}</div>}
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
        <thead><tr>{["", "#", "Traveller", "DOB", "Policy", "Premium", "COI"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>
          {(policies.length ? policies : d.travellers.map((t, i) => ({ travellerId: i + 1, name: `${t.firstName} ${t.lastName}`, dob: t.dob } as any))).map((p: any, i: number) => (
            <tr key={i}>
              <td style={td}>{booked && p.travellerId != null && <input type="checkbox" aria-label={`Cancel traveller ${p.travellerId}`} checked={cancelIds.has(p.travellerId)} onChange={() => setCancelIds((s) => { const n = new Set(s); if (n.has(p.travellerId)) n.delete(p.travellerId); else n.add(p.travellerId); return n; })} />}</td>
              <td style={td}>{p.travellerId}</td>
              <td style={td}>{p.name}</td>
              <td style={td}>{p.dob ?? "—"}</td>
              <td style={td}>{p.policyId ?? "—"}</td>
              <td style={td}>{inr(p.totalFare)}</td>
              <td style={td}>{p.coiUrl ? <a href={p.coiUrl} target="_blank" rel="noreferrer" style={{ color: "#93c5fd" }}>Download</a> : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {booked && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
          <div style={{ border: "1px solid #334155", borderRadius: 10, padding: 12 }}>
            <b style={{ color: "#f1f5f9", fontSize: 13 }}>Cancellation</b>
            <p style={{ color: "#94a3b8", fontSize: 12, margin: "4px 0 8px" }}>Tick travellers above. Allowed up to 24 h before cover starts. Raise returns the refund quote; nothing changes until Confirm.</p>
            <input style={{ ...input, marginBottom: 8 }} placeholder="Remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            <button type="button" disabled={!!busy || !cancelIds.size} style={btn("#b91c1c", !!busy || !cancelIds.size)}
              onClick={() => act("raise-c", () => call(`/api/admin/tripsafe/bookings/${reference}/amendment/raise`, { method: "POST", body: JSON.stringify({ type: "CANCELLATION", travellerIds: [...cancelIds], remarks: remarks || undefined }) }),
                (r) => `Raised ${r.amendment?.amendmentId} — refund ${inr(r.refund ?? r.amendment?.amount)}. Confirm below to cancel.`)}>Raise cancellation ({cancelIds.size})</button>
          </div>
          <div style={{ border: "1px solid #334155", borderRadius: 10, padding: 12 }}>
            <b style={{ color: "#f1f5f9", fontSize: 13 }}>Correction</b>
            <div style={{ display: "flex", gap: 6, margin: "6px 0 8px" }}>
              <select style={input} value={corr.mode} onChange={(e) => setCorr((c) => ({ ...c, mode: e.target.value }))}>
                <option value="traveller">Traveller detail (name, nominee, passport, gender, DOB)</option>
                <option value="dates">Trip dates (financial)</option>
              </select>
            </div>
            {corr.mode === "traveller" ? (
              <div style={{ display: "grid", gridTemplateColumns: "70px 1fr 1fr", gap: 6, marginBottom: 8 }}>
                <input style={input} type="number" min={1} value={corr.id} onChange={(e) => setCorr((c) => ({ ...c, id: Number(e.target.value) }))} aria-label="Traveller #" />
                <select style={input} value={corr.field} onChange={(e) => setCorr((c) => ({ ...c, field: e.target.value }))}>
                  {["firstName", "lastName", "title", "gender", "passportNumber", "dob", "nomineeName"].map((f) => <option key={f}>{f}</option>)}
                </select>
                <input style={input} placeholder="New value" value={corr.value} onChange={(e) => setCorr((c) => ({ ...c, value: e.target.value }))} />
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
                <input style={input} type="date" value={corr.startDate} onChange={(e) => setCorr((c) => ({ ...c, startDate: e.target.value }))} aria-label="New start date" />
                <input style={input} type="date" value={corr.endDate} onChange={(e) => setCorr((c) => ({ ...c, endDate: e.target.value }))} aria-label="New end date" />
              </div>
            )}
            <button type="button" disabled={!!busy} style={btn("#7c3aed", !!busy)} onClick={() => act("raise-x", () => call(`/api/admin/tripsafe/bookings/${reference}/amendment/raise`, {
              method: "POST",
              body: JSON.stringify(corr.mode === "traveller"
                ? { type: "CORRECTION", remarks: remarks || undefined, traveller: { id: corr.id, changes: corr.field === "nomineeName" ? { nomineeInfo: [{ nomineeName: corr.value.toUpperCase(), nomineeRelationship: "LEGAL_HEIR" }] } : { [corr.field]: ["firstName", "lastName", "passportNumber", "title"].includes(corr.field) ? corr.value.toUpperCase() : corr.value } } }
                : { type: "CORRECTION", remarks: remarks || undefined, ...(corr.startDate ? { startDate: corr.startDate } : {}), ...(corr.endDate ? { endDate: corr.endDate } : {}) }),
            }), (r) => `Raised ${r.amendment?.amendmentId} — amount ${inr(r.amendment?.amount)}. Confirm below to apply.`)}>Raise correction</button>
          </div>
        </div>
      )}

      {(d.amendments ?? []).length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
          <thead><tr>{["Amendment", "Type", "Status", "Amount", "Refund", "Raised", ""].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {(d.amendments ?? []).map((a) => (
              <tr key={a.amendmentId}>
                <td style={td}>{a.amendmentId}</td>
                <td style={td}>{a.type}{a.travellerIds ? ` (${a.travellerIds.join(", ")})` : ""}</td>
                <td style={{ ...td, color: statusColor(a.status), fontWeight: 700 }}>{a.status}</td>
                <td style={td}>{inr(a.amount)}</td>
                <td style={td}>{inr(a.refund)}</td>
                <td style={td}>{new Date(a.at).toLocaleString()}</td>
                <td style={td}>{pendingAmendments.includes(a) && <button type="button" disabled={!!busy} style={btn("#16a34a", !!busy)} onClick={() => act("confirm", () => call(`/api/admin/tripsafe/bookings/${reference}/amendment/confirm`, { method: "POST", body: JSON.stringify({ amendmentId: a.amendmentId, remarks: remarks || undefined }) }), (r) => `Amendment ${r.amendment?.status ?? "sent"}`)}>Confirm</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function TestConsole() {
  const [body, setBody] = useState(JSON.stringify(PRESETS[0].body, null, 2));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  async function run() {
    setBusy(true); setResult(null);
    try {
      setResult(await call("/api/admin/tripsafe/search", { method: "POST", body }));
    } catch (e: any) { setResult({ ok: false, error: e.message }); } finally { setBusy(false); }
  }

  return (
    <section style={card}>
      <b style={{ color: "#f1f5f9" }}>UAT test console</b>
      <p style={{ color: "#94a3b8", fontSize: 12, margin: "4px 0 10px", lineHeight: 1.5 }}>
        Sends a search straight to TripJack (our own checks are shown as warnings but not enforced) so negative cases such as an invalid AMT duration
        are captured in the API logs below. To make a certification booking, run the same case on the customer page <code>/insurance</code> with real traveller names.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {PRESETS.map((p) => <button key={p.name} type="button" style={{ ...btn("#334155"), fontWeight: 600, fontSize: 12 }} onClick={() => setBody(JSON.stringify(p.body, null, 2))}>{p.name}</button>)}
      </div>
      <textarea style={{ ...input, fontFamily: "monospace", minHeight: 180 }} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Search request" />
      <div style={{ marginTop: 8 }}><button type="button" disabled={busy} style={btn("#2563eb", busy)} onClick={() => void run()}>{busy ? "Searching…" : "Run search"}</button></div>
      {result && (
        <div style={{ marginTop: 10, fontSize: 13, color: "#cbd5e1" }}>
          {result.warnings?.length > 0 && <div style={{ color: "#fcd34d", marginBottom: 6 }}>Our checks: {result.warnings.join(" · ")}</div>}
          {result.ok ? (
            <>
              <div style={{ color: "#86efac", marginBottom: 6 }}>searchId {result.searchId} · {result.products?.length ?? 0} plans</div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr>{["productId", "Cover", "Insurer", "Region", "Type", "Total"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>{(result.products ?? []).map((p: any) => (
                  <tr key={p.productId}><td style={td}>{p.productId}</td><td style={td}>{p.planCoverage}</td><td style={td}>{p.insuranceProvider}</td><td style={td}>{p.regionName}</td><td style={td}>{p.planType}</td><td style={td}>{inr(p.totalFare)}</td></tr>
                ))}</tbody>
              </table>
            </>
          ) : (
            <div style={{ color: "#fca5a5", whiteSpace: "pre-wrap" }}>{result.error}{result.response ? `\n\n${result.response}` : ""}</div>
          )}
        </div>
      )}
    </section>
  );
}

function ApiLogs() {
  const [rows, setRows] = useState<Exchange[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setRows((await call<{ exchanges: Exchange[] }>("/api/admin/tripsafe/exchanges")).exchanges); } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <section style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <b style={{ color: "#f1f5f9" }}>TripSafe API logs</b>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" style={btn("#334155")} onClick={() => void load()}>Reload</button>
          <button type="button" disabled={!picked.size} style={btn("#2563eb", !picked.size)} onClick={() => downloadZip(`/api/admin/tripsafe/exchanges.zip?ids=${[...picked].join(",")}`, "tripsafe-api-logs.zip").catch((e) => setError(e.message))}>Download selected ({picked.size})</button>
        </div>
      </div>
      <p style={{ color: "#94a3b8", fontSize: 12, margin: "0 0 8px" }}>Separate request / response JSON per call — TripJack URL and apikey in the request, response exactly as received.</p>
      {error && <p style={{ color: "#fca5a5", fontSize: 13 }}>{error}</p>}
      {!rows ? <p style={{ color: "#94a3b8" }}>Loading…</p> : (
        <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{["", "Time", "Endpoint", "HTTP", "ms", "Linked to", "Error"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.id}>
                  <td style={td}><input type="checkbox" checked={picked.has(x.id)} onChange={() => toggle(x.id)} aria-label="Select log" /></td>
                  <td style={td}>{new Date(x.startedAt).toLocaleString()}</td>
                  <td style={td}>{x.endpoint}</td>
                  <td style={{ ...td, color: x.httpStatus && x.httpStatus < 400 ? "#4ade80" : "#f87171" }}>{x.httpStatus ?? "—"}</td>
                  <td style={td}>{x.durationMs ?? "—"}</td>
                  <td style={td}>{x.bookingId ?? x.searchId ?? "—"}</td>
                  <td style={{ ...td, color: "#fca5a5" }}>{x.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
