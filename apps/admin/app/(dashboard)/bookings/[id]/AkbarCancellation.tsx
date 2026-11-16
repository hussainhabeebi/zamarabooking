"use client";
import { useCallback, useEffect, useState } from "react";
import { API, apiHeaders } from "../../../../lib/api";

// Akbar API booking cancellation (API: routes/admin/akbar-cancellation.ts, rules: lib/akbar-cancellation.ts).
// Admins only. Review (RetrieveBooking, read-only) → explicit confirmation → one Cancel request.
// "Live cancellation" is ONE company-wide setting (Admin → Integrations → Akbar cancellation), not per booking:
// this panel only shows whether it is on and, if it is, a Cancel Booking action on eligible bookings.
// Cancellation, the Akbar deposit refund and the customer refund are tracked separately; nothing is
// refunded automatically.

type Pax = { id: number; name: string; type: string; tickets: string[] };
type Seg = { crsPnr: string; route: string; pax: { id: number; ticket: string; ticketStatus: string }[] };
type Target = { transactionId: number; legs: number[]; pnrs: string[]; tickets: string[]; eligible: boolean; reason: string | null };
type Rec = {
  transactionId: number; partial: boolean; selectedPaxIds: number[]; passengers: Pax[]; segments: Seg[]; reason: string;
  requestedBy: string | null; requestedAt: string; originalTui: string; requestTui: string; request?: unknown;
  response?: { code: string; messages: string[]; cancellationId: string; meaning: string; receivedAt: string };
  error?: { message: string; httpStatus: number | null; notSent: boolean };
  supplierRefund: { status: string; expectedAmount?: number | null; creditedAmount?: number | null; currency?: string | null; reference?: string | null; source?: string | null; verifiedAt?: string | null; getRefund?: { at: string; details: any; error?: string } | null };
  statusChecks: { at: string; ok: boolean; bookingStatus?: string; tickets?: { paxId: number; ticket: string; status: string; crsPnr: string }[]; error?: string }[];
  history: { at: string; by: string | null; event: string; from?: string; to?: string; note?: string }[];
};
type Cancellation = {
  id: string; status: string; createdAt: string; lastCheckedAt: string | null; akbarCode: string | null; cancellationId: string | null;
  amountPaid: string; currency: string; adminNote: string | null;
  customerRefund: { status: string; method: string; amount: string | null; reference: string | null; error: string | null; refundedAt: string | null };
  record: Rec | null;
};
type Settings = { liveCancellationEnabled: boolean; cancelPath: string; tuiSource: string; ticketField: string; partialPassengerCancellation: boolean; getRefundUatEnabled: boolean; updatedAt?: string | null };
type Panel = { bookingStatus: string; environment: string; settings: Settings; getRefund: { ok: boolean; reason?: string }; targets: Target[]; cancellations: Cancellation[]; note: string | null };
type Preview = { transactionId: number; pnrs: string[]; route: string; akbarStatus: string; passengers: Pax[]; segments: Seg[]; tui: string; tuiSource: string; planHash: string; partialAllowed: boolean; problems: string[]; requestPreview: unknown; liveCancellationEnabled: boolean };

// What admins see. Akbar has documented one success code only, so an unclear answer and "Akbar is still
// processing it" both show as Pending verification (with the detail underneath).
const STATUS: Record<string, { label: string; color: string; help: string }> = {
  CANCELLATION_REQUESTED: { label: "Cancellation requested", color: "#fbbf24", help: "Recorded, not sent to Akbar yet." },
  CANCELLATION_PROCESSING: { label: "Processing", color: "#fbbf24", help: "Being sent to Akbar now. If this doesn't change, use Check latest status." },
  CANCELLED: { label: "Cancelled", color: "#4ade80", help: "Akbar confirmed the cancellation (or staff verified it on Akbar's portal). Refunds are separate steps below." },
  CANCELLATION_PENDING: { label: "Pending verification", color: "#fbbf24", help: "Akbar's portal shows the cancellation still in progress. Check again later." },
  MANUAL_VERIFICATION_REQUIRED: { label: "Pending verification", color: "#f87171", help: "Akbar's answer was missing or unclear, so the tickets may or may not be cancelled. Check the transaction on Akbar's portal and record what you find. Do not cancel again." },
  CANCELLATION_FAILED: { label: "Failed", color: "#f87171", help: "Not cancelled — nothing changed on Akbar. A new cancellation can be requested." },
};
const DEPOSIT: Record<string, { label: string; color: string }> = {
  NOT_APPLICABLE: { label: "—", color: "#64748b" }, REFUND_PENDING: { label: "Refund pending (not verified)", color: "#fbbf24" },
  REFUNDED: { label: "Credited to Akbar deposit (verified)", color: "#4ade80" }, REFUND_FAILED: { label: "Refund failed", color: "#f87171" },
};
const fmt = (s?: string | null) => (s ? new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—");

type BookingInfo = { totalAmount?: string | number; currency?: string; origin?: string; destination?: string; flightData?: Record<string, any> | null };
const money = (v: string | number | null | undefined, cur = "INR") => v === null || v === undefined || v === "" ? "—" : `${cur} ${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function AkbarCancellation({ bookingId, booking, onDone }: { bookingId: string; booking?: BookingInfo; onDone: (message: string) => void }) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [reason, setReason] = useState("");
  const [typedPnr, setTypedPnr] = useState("");
  const [ack, setAck] = useState(false);
  const [requestId, setRequestId] = useState("");

  const base = `${API}/api/admin/akbar-cancellation`;
  const call = useCallback(async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...apiHeaders(), "Content-Type": "application/json" } });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(d.error ?? d.message ?? `HTTP ${res.status}`), { status: res.status, data: d });
    return d;
  }, [base]);

  const load = useCallback(async () => {
    try { setPanel(await call(`/bookings/${bookingId}`)); }
    catch (e: any) { if (e.status === 403) setHidden(true); else setError(e.message); }
  }, [bookingId, call]);
  useEffect(() => { load(); }, [load]);

  if (hidden || !panel) return null;
  if (!panel.targets.length && !panel.cancellations.length) {
    return <div style={box}><div style={title}>Akbar cancellation</div><p style={muted}>{panel.note}</p></div>;
  }

  async function run(key: string, fn: () => Promise<string | void>) {
    setBusy(key); setError(""); setNotice("");
    try { const m = await fn(); if (m) setNotice(m); await load(); }
    catch (e: any) { setError(e.message); await load(); }
    finally { setBusy(""); }
  }

  const live = panel.settings.liveCancellationEnabled;
  const review = (transactionId: number) => run(`preview-${transactionId}`, async () => {
    if (!live) return;
    const p = await call(`/bookings/${bookingId}/preview`, { method: "POST", body: JSON.stringify({ transactionId }) }) as Preview;
    setPreview(p); setSelected(p.passengers.map((x) => x.id)); setReason(""); setTypedPnr(""); setAck(false);
    setRequestId(crypto.randomUUID());
  });

  const submit = () => run("submit", async () => {
    if (!preview) return;
    const d = await call(`/bookings/${bookingId}/submit`, { method: "POST", body: JSON.stringify({
      transactionId: preview.transactionId, paxIds: selected, planHash: preview.planHash, requestId, reason: reason.trim(), confirmPnr: typedPnr.trim(),
    }) });
    setPreview(null);
    onDone(d.message);
    return d.message;
  });

  const action = (a: Cancellation, body: Record<string, unknown>) => run(`${a.id}-${body.action}`, async () => {
    const d = await call(`/cancellations/${a.id}/action`, { method: "POST", body: JSON.stringify(body) });
    onDone(d.message);
    return d.message;
  });
  const ask = (q: string, min = 3) => { const v = prompt(q); return v && v.trim().length >= min ? v.trim() : null; };
  const askAmount = (q: string, def = "") => { const v = prompt(q, def); if (v === null) return null; const n = Number(v); if (!(n >= 0)) { alert("Enter a valid amount"); return null; } return n; };

  const partialAllowed = preview?.partialAllowed ?? false;
  const pnrs = preview ? [...preview.pnrs] : [];
  const canSubmit = !!preview && preview.liveCancellationEnabled && !preview.problems.length && selected.length > 0
    && (partialAllowed || selected.length === preview.passengers.length) && reason.trim().length >= 5
    && pnrs.map((p) => p.toUpperCase()).includes(typedPnr.trim().toUpperCase()) && ack && !busy;

  return (
    <div style={box}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <div style={title}>Akbar cancellation</div>
        <div style={{ fontSize: 12, color: "#94a3b8", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span>Akbar {panel.environment}</span>
          <span style={{ color: live ? "#4ade80" : "#f87171", fontWeight: 700 }}>Live cancellation {live ? "ON" : "OFF"} (all Akbar bookings)</span>
        </div>
      </div>
      {!live && panel.targets.some((t) => t.eligible) && (
        <div style={offBox}>
          Cancel Booking is disabled because Live cancellation is <b>OFF</b> for all Akbar bookings. A super admin can turn it on once in{" "}
          <a href="/integrations#akbar-cancellation" style={{ color: "#93c5fd" }}>Integrations → Akbar cancellation</a>. It is not set per booking.
        </div>
      )}

      <table style={tbl}>
        <thead><tr style={th}><th>Transaction</th><th>PNR</th><th>Tickets</th><th></th></tr></thead>
        <tbody>{panel.targets.map((t) => (
          <tr key={t.transactionId}><td style={mono}>{t.transactionId}</td><td>{t.pnrs.join(", ") || "—"}</td><td>{t.tickets.join(", ") || "—"}</td>
            <td style={{ textAlign: "right" }}>{!t.eligible
              ? <span style={{ ...muted, fontSize: 12 }}>{t.reason}</span>
              : <button disabled={!!busy || !live} title={live ? "Review the cancellation before anything is sent" : "Live cancellation is OFF for all Akbar bookings (Integrations → Akbar cancellation)"}
                  style={{ ...danger, ...(live ? {} : { opacity: 0.45, cursor: "not-allowed" }) }} onClick={() => review(t.transactionId)}>
                  {busy === `preview-${t.transactionId}` ? "Fetching latest booking from Akbar…" : "Cancel Booking"}</button>}</td></tr>
        ))}</tbody>
      </table>

      {preview && (
        <div style={confirmBox}>
          <div style={{ fontWeight: 800, color: "#fca5a5", marginBottom: 6 }}>Review cancellation — transaction {preview.transactionId}</div>
          <div style={{ ...muted, fontSize: 12, marginBottom: 6 }}>Fetched from Akbar just now (RetrieveBooking — read only, nothing cancelled yet). Akbar is asked again when you confirm, and nothing is sent if the booking changed.</div>
          <div style={{ fontSize: 13, color: "#cbd5e1", marginBottom: 8 }}>
            Route <b>{preview.route}</b> · PNR <b>{preview.pnrs.join(", ")}</b> · Akbar status <span style={mono}>{preview.akbarStatus || "—"}</span> · TUI from {preview.tuiSource === "ITINERARY" ? "the original booking" : "RetrieveBooking"}
          </div>
          <table style={tbl}>
            <thead><tr style={th}><th>Cancel</th><th>Passenger</th><th>Akbar Pax ID</th><th>Ticket(s)</th></tr></thead>
            <tbody>{preview.passengers.map((p) => (
              <tr key={p.id}>
                <td><input type="checkbox" checked={selected.includes(p.id)} disabled={!partialAllowed}
                  onChange={(e) => setSelected(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))} /></td>
                <td>{p.name || <span style={muted}>(name not in Akbar&apos;s answer)</span>} {p.type && <span style={muted}>· {p.type}</span>}</td>
                <td style={mono}>{p.id}</td><td style={mono}>{p.tickets.join(", ") || "—"}</td>
              </tr>
            ))}</tbody>
          </table>
          {!partialAllowed && <div style={{ ...muted, fontSize: 12, margin: "4px 0" }}>Akbar has not confirmed that single passengers can be cancelled, so every passenger on this transaction is cancelled together. To cancel only some passengers, use Akbar&apos;s portal.</div>}
          <table style={tbl}>
            <thead><tr style={th}><th>Segment PNR</th><th>Route</th><th>Passenger / ticket / Akbar ticket status</th></tr></thead>
            <tbody>{preview.segments.map((g, i) => (
              <tr key={i}><td style={mono}>{g.crsPnr}</td><td>{g.route || "—"}</td>
                <td style={mono}>{g.pax.map((p) => `${p.id} / ${p.ticket || "—"} / ${p.ticketStatus || "—"}${selected.includes(p.id) ? "" : " (kept)"}`).join(" · ")}</td></tr>
            ))}</tbody>
          </table>
          <RefundInfo booking={booking} transactionId={preview.transactionId} />
          {preview.problems.length > 0 && <div style={errBox}>Can&apos;t be sent: {preview.problems.join(" ")}</div>}
          {!preview.liveCancellationEnabled && <div style={errBox}>Live cancellation is OFF for all Akbar bookings (Integrations → Akbar cancellation) — nothing can be sent.</div>}
          <details style={{ margin: "6px 0", fontSize: 12, color: "#94a3b8" }}><summary>Request that will be sent</summary><pre style={pre}>{JSON.stringify(preview.requestPreview, null, 2)}</pre></details>
          <div style={{ display: "grid", gap: 6, maxWidth: 560 }}>
            <label style={lbl}>Reason (saved in the audit log)<textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={inp} /></label>
            <label style={lbl}>Type the PNR to confirm<input value={typedPnr} onChange={(e) => setTypedPnr(e.target.value)} style={inp} placeholder={preview.pnrs[0] ?? ""} /></label>
            <label style={{ ...lbl, display: "flex", gap: 6, alignItems: "flex-start" }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              I have checked with the customer. This asks Akbar to cancel the selected tickets now and can&apos;t be undone. It does not refund anyone: the Akbar deposit refund and the customer refund are separate steps.</label>
            <div style={{ display: "flex", gap: 8 }}>
              <button disabled={!canSubmit} onClick={submit} style={{ ...danger, opacity: canSubmit ? 1 : 0.5 }}>{busy === "submit" ? "Sending to Akbar…" : `Confirm — cancel ${selected.length} passenger(s) on Akbar`}</button>
              <button disabled={busy === "submit"} onClick={() => setPreview(null)} style={ghost}>Close</button>
            </div>
          </div>
        </div>
      )}

      {panel.cancellations.map((c) => <CancellationCard key={c.id} c={c} busy={busy} panel={panel} onCheck={() => run(`${c.id}-check`, async () => {
        const d = await call(`/cancellations/${c.id}/check-status`, { method: "POST" }); return d.error ?? "Latest status read from Akbar (RetrieveBooking).";
      })} onGetRefund={() => run(`${c.id}-getrefund`, async () => { await call(`/cancellations/${c.id}/get-refund`, { method: "POST" }); return "GetRefund answer stored (UAT)."; })}
        onAction={(body) => action(c, body)} ask={ask} askAmount={askAmount} />)}

      {notice && <div style={{ color: "#86efac", fontSize: 13, marginTop: 8 }}>{notice}</div>}
      {error && <div style={{ color: "#fca5a5", fontSize: 13, marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function CancellationCard({ c, busy, panel, onCheck, onGetRefund, onAction, ask, askAmount }: {
  c: Cancellation; busy: string; panel: Panel; onCheck: () => void; onGetRefund: () => void;
  onAction: (body: Record<string, unknown>) => void; ask: (q: string, min?: number) => string | null; askAmount: (q: string, def?: string) => number | null;
}) {
  const r = c.record;
  const st = STATUS[c.status] ?? { label: c.status, color: "#94a3b8", help: "" };
  const dep = DEPOSIT[r?.supplierRefund?.status ?? "NOT_APPLICABLE"] ?? DEPOSIT.NOT_APPLICABLE;
  const last = r?.statusChecks?.at(-1);
  const b = (key: string) => busy === `${c.id}-${key}`;
  const cr = c.customerRefund;
  const lines = r?.supplierRefund?.getRefund?.details?.trips?.flatMap((t: any) => t.lines) ?? [];
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div><b style={{ color: st.color }}>{st.label}</b> <span style={muted}>· transaction {r?.transactionId} · {r?.partial ? "some passengers" : "all passengers"} ({r?.selectedPaxIds.length})</span></div>
        <span style={{ ...muted, fontSize: 12 }}>requested {fmt(r?.requestedAt)}</span>
      </div>
      <div style={{ ...muted, fontSize: 12, margin: "4px 0" }}>{st.help}</div>
      <div style={{ fontSize: 12, color: "#cbd5e1", display: "grid", gap: 2 }}>
        <div>Passengers: {r?.passengers.filter((p) => r.selectedPaxIds.includes(p.id)).map((p) => `${p.name || p.id} (${p.tickets.join(", ") || "no ticket no."})`).join("; ")}</div>
        <div>Reason: {r?.reason}</div>
        {r?.response && <div>Akbar: Code <span style={mono}>{r.response.code || "—"}</span> {r.response.messages.join("; ")} · CancellationID <span style={mono}>{r.response.cancellationId || "—"}</span> — {r.response.meaning}</div>}
        {r?.error && <div style={{ color: "#fca5a5" }}>{r.error.notSent ? "Not sent" : "No clear answer"}: {r.error.message}</div>}
        {c.cancellationId && <div>Cancellation ID: <span style={mono}>{c.cancellationId}</span></div>}
        {last && <div>Last check {fmt(last.at)}: {last.ok ? <>Akbar booking status <span style={mono}>{last.bookingStatus || "—"}</span>; tickets {last.tickets?.map((t) => `${t.ticket || t.paxId} ${t.status || "—"}`).join(", ")} <span style={muted}>(Akbar&apos;s codes, shown as written)</span></> : <span style={{ color: "#fca5a5" }}>{last.error}</span>}</div>}
      </div>

      {c.status === "CANCELLED" && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 8, marginTop: 8 }}>
        <div style={sub}>
          <div style={{ fontWeight: 700, color: "#e2e8f0" }}>Akbar deposit refund</div>
          <div style={{ color: dep.color, fontWeight: 700, fontSize: 12 }}>{dep.label}</div>
          {r?.supplierRefund.expectedAmount != null && <div style={{ fontSize: 12 }}>Akbar shows {r.supplierRefund.currency} {r.supplierRefund.expectedAmount} ({r.supplierRefund.source})</div>}
          {r?.supplierRefund.creditedAmount != null && <div style={{ fontSize: 12 }}>Credited {r.supplierRefund.currency} {r.supplierRefund.creditedAmount} · ref {r.supplierRefund.reference} · {fmt(r.supplierRefund.verifiedAt)}</div>}
          {lines.length > 0 && <div style={{ fontSize: 11, color: "#94a3b8" }}>GetRefund (UAT): {lines.map((l: any) => `${l.from}-${l.to} ${l.paxType}: refund ${l.refundAmount}, charges ${l.cancellationCharge}`).join("; ")}{r?.supplierRefund.getRefund?.details?.transactionIdMatches === false ? " — answered for another transaction!" : ""}</div>}
          <div style={row}>
            {r?.supplierRefund.status === "REFUND_PENDING" && <button style={ghost} disabled={!!busy} onClick={() => {
              const amount = askAmount("Refund amount Akbar shows for this cancellation (as on Akbar's portal / statement):"); if (amount === null) return;
              const note = ask("Where you saw it (portal page, email, statement line):"); if (!note) return;
              onAction({ action: "RECORD_SUPPLIER_REFUND", amount, currency: "INR", source: "AKBAR_PORTAL", note });
            }}>Record Akbar refund amount</button>}
            {["REFUND_PENDING", "REFUND_FAILED"].includes(r?.supplierRefund.status ?? "") && <button style={btn} disabled={!!busy} onClick={() => {
              const amount = askAmount("Amount actually credited to the Akbar deposit (from Akbar's statement):", String(r?.supplierRefund.expectedAmount ?? "")); if (amount === null) return;
              const reference = ask("Akbar statement / ledger reference:"); if (!reference) return;
              const note = ask("Note:"); if (!note) return;
              onAction({ action: "MARK_DEPOSIT_CREDITED", amount, currency: "INR", reference, note });
            }}>Mark deposit credited (verified)</button>}
            {r?.supplierRefund.status === "REFUND_PENDING" && <button style={ghost} disabled={!!busy} onClick={() => { const note = ask("Why the Akbar refund failed:"); if (note) onAction({ action: "MARK_DEPOSIT_REFUND_FAILED", note }); }}>Mark failed</button>}
            {panel.getRefund.ok && <button style={ghost} disabled={!!busy} onClick={onGetRefund}>{b("getrefund") ? "Calling…" : "GetRefund (UAT)"}</button>}
          </div>
        </div>
        <div style={sub}>
          <div style={{ fontWeight: 700, color: "#e2e8f0" }}>Customer refund</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: cr.status === "DONE" ? "#4ade80" : cr.status === "NOT_STARTED" ? "#94a3b8" : "#fbbf24" }}>
            {cr.status === "NOT_STARTED" ? "Not started" : cr.status}{cr.amount ? ` · ${c.currency} ${cr.amount}` : ""}{cr.status !== "NOT_STARTED" ? ` · ${cr.method}` : ""}{cr.reference ? ` · ${cr.reference}` : ""}</div>
          {cr.error && <div style={{ fontSize: 12, color: "#fca5a5" }}>{cr.error}</div>}
          <div style={{ fontSize: 11, color: "#94a3b8" }}>Customer paid {c.currency} {c.amountPaid}</div>
          <div style={row}>
            {cr.status === "NOT_STARTED" && panel.bookingStatus === "CANCELLED" && <button style={btn} disabled={!!busy} onClick={() => {
              const amount = askAmount(`Amount to refund the customer (${c.currency}, max ${c.amountPaid}) — to their original payment method:`); if (amount === null || !(amount > 0)) return;
              const note = ask("Reason / how the amount was worked out:"); if (!note) return;
              if (confirm(`Refund ${c.currency} ${amount} to the customer's original payment method now?`)) onAction({ action: "REFUND_CUSTOMER", amount, note });
            }}>Refund customer…</button>}
            {cr.status === "FAILED" && <button style={btn} disabled={!!busy} onClick={() => { if (confirm("Retry the refund? Only if it was NOT already refunded in the provider's dashboard.")) onAction({ action: "RETRY_CUSTOMER_REFUND", note: "Admin retry" }); }}>Retry refund</button>}
            {["NOT_STARTED", "PENDING", "FAILED", "MANUAL_REQUIRED"].includes(cr.status) && <button style={ghost} disabled={!!busy} onClick={() => {
              const amount = askAmount("Amount refunded to the customer outside ZamraBooking:"); if (amount === null) return;
              const reference = ask("Refund reference:"); if (!reference) return;
              onAction({ action: "CUSTOMER_REFUNDED_MANUALLY", amount, reference, note: `Refunded manually (${reference})` });
            }}>Mark refunded manually</button>}
          </div>
        </div>
      </div>}

      <div style={row}>
        {c.status !== "CANCELLATION_FAILED" && c.status !== "CANCELLATION_REQUESTED" && <button style={ghost} disabled={!!busy} onClick={onCheck}>{b("check") ? "Checking…" : "Check latest status"}</button>}
        {c.status === "CANCELLATION_REQUESTED" && <button style={ghost} disabled={!!busy} onClick={() => { const note = ask("Why withdraw (it was never sent):"); if (note) onAction({ action: "WITHDRAW_REQUEST", note }); }}>Withdraw request</button>}
        {["MANUAL_VERIFICATION_REQUIRED", "CANCELLATION_PENDING"].includes(c.status) && <>
          <button style={btn} disabled={!!busy} onClick={() => {
            const note = ask("What Akbar's portal shows (cancelled — where / when):"); if (!note) return;
            const cancellationId = prompt("Akbar Cancellation ID, if shown (optional):") ?? "";
            onAction({ action: "VERIFIED_CANCELLED", note, ...(cancellationId.trim() ? { cancellationId: cancellationId.trim() } : {}) });
          }}>Verified: cancelled on Akbar</button>
          {c.status === "MANUAL_VERIFICATION_REQUIRED" && <button style={ghost} disabled={!!busy} onClick={() => { const note = ask("What Akbar shows (still in progress):"); if (note) onAction({ action: "VERIFIED_PENDING", note }); }}>Verified: still pending</button>}
          <button style={ghost} disabled={!!busy} onClick={() => { const note = ask("What Akbar's portal shows (tickets still active):"); if (note) onAction({ action: "VERIFIED_NOT_CANCELLED", note }); }}>Verified: NOT cancelled</button>
        </>}
      </div>
      <details style={{ fontSize: 11, color: "#94a3b8", marginTop: 6 }}><summary>History &amp; request</summary>
        {r?.history.map((h, i) => <div key={i}>{fmt(h.at)} · {h.event}{h.to ? ` → ${h.to}` : ""}{h.by ? ` · by ${h.by.slice(0, 8)}` : ""}{h.note ? ` · ${h.note}` : ""}</div>)}
        <div style={{ marginTop: 4 }}>Original TUI <span style={mono}>{r?.originalTui}</span> · sent TUI <span style={mono}>{r?.requestTui}</span></div>
        <pre style={pre}>{JSON.stringify(r?.request ?? null, null, 2)}</pre>
      </details>
    </div>
  );
}

// What is known about money before cancelling. Akbar's refund / charges come only from GetRefund, which is not
// called on live bookings until Akbar confirms it doesn't change the booking — so nothing is estimated here.
function RefundInfo({ booking, transactionId }: { booking?: BookingInfo; transactionId: number }) {
  const legs = (booking?.flightData?.akbarBooking?.legs ?? []) as { transactionId?: number; itineraryNetAmount?: number; pricedNetAmount?: number }[];
  const leg = legs.find((l) => l.transactionId === transactionId);
  const net = leg?.itineraryNetAmount ?? leg?.pricedNetAmount;
  return (
    <div style={{ ...sub, margin: "6px 0" }}>
      <div style={{ fontWeight: 700, color: "#e2e8f0" }}>Refund information</div>
      <div style={{ fontSize: 12 }}>Customer paid: <b>{money(booking?.totalAmount, booking?.currency)}</b>{net != null && <> · Paid to Akbar for this transaction: <b>{money(net, "INR")}</b></>}</div>
      <div style={{ fontSize: 12, color: "#94a3b8" }}>
        Akbar&apos;s cancellation charges and refund amount are not available before cancelling: Akbar hasn&apos;t confirmed that GetRefund is safe to call on a live booking.
        After Akbar confirms the cancellation, record the refund amount from Akbar&apos;s portal; the deposit refund and the customer refund are separate steps and are never marked done automatically.
      </div>
    </div>
  );
}

const offBox: React.CSSProperties = { border: "1px solid #7f1d1d", background: "rgba(239,68,68,.08)", color: "#fecaca", borderRadius: 8, padding: "8px 10px", fontSize: 12, margin: "8px 0" };
const box: React.CSSProperties = { border: "1px solid #7f1d1d", borderRadius: 10, padding: 14, margin: "10px 0", background: "rgba(239,68,68,.04)" };
const confirmBox: React.CSSProperties = { border: "1px solid #b91c1c", borderRadius: 8, padding: 12, margin: "10px 0", background: "rgba(239,68,68,.08)" };
const card: React.CSSProperties = { border: "1px solid #334155", borderRadius: 8, padding: 10, marginTop: 10, color: "#cbd5e1" };
const sub: React.CSSProperties = { border: "1px solid #334155", borderRadius: 8, padding: 8, color: "#cbd5e1", display: "grid", gap: 4 };
const title: React.CSSProperties = { fontWeight: 800, color: "#fca5a5", fontSize: 14 };
const muted: React.CSSProperties = { color: "#94a3b8" };
const mono: React.CSSProperties = { fontFamily: "monospace", fontSize: 12 };
const row: React.CSSProperties = { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 };
const tbl: React.CSSProperties = { width: "100%", fontSize: 12, color: "#cbd5e1", borderCollapse: "collapse", margin: "6px 0" };
const th: React.CSSProperties = { color: "#94a3b8", textAlign: "left" };
const pre: React.CSSProperties = { background: "#0f172a", padding: 8, borderRadius: 6, overflowX: "auto", fontSize: 11 };
const lbl: React.CSSProperties = { color: "#94a3b8", fontSize: 12, display: "grid", gap: 4 };
const inp: React.CSSProperties = { background: "#0f172a", color: "#f1f5f9", border: "1px solid #334155", borderRadius: 6, padding: "6px 8px", fontSize: 13 };
const btn: React.CSSProperties = { background: "#0D4B96", color: "#fff", border: 0, borderRadius: 8, padding: "6px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer" };
const ghost: React.CSSProperties = { ...btn, background: "#0f172a", border: "1px solid #334155", color: "#e2e8f0" };
const danger: React.CSSProperties = { ...btn, background: "#b91c1c" };
const errBox: React.CSSProperties = { background: "rgba(239,68,68,.1)", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 8, padding: "8px 10px", fontSize: 12, margin: "6px 0" };
