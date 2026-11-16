"use client";
// Akbar cancellation: ONE setting for the whole company (all Akbar bookings), shown in Admin →
// Integrations under Akbar Travels. Saved through /api/admin/akbar-cancellation/settings (super admin
// only; every change is audit-logged). Each booking only shows whether cancellation is available.
import { useEffect, useState } from "react";
import { API, apiHeaders } from "@/lib/api";

type Settings = {
  liveCancellationEnabled: boolean; cancelPath: string; tuiSource: string; ticketField: string;
  partialPassengerCancellation: boolean; getRefundUatEnabled: boolean; updatedAt?: string | null; updatedBy?: string | null;
};

async function call(method: "GET" | "PUT", body?: unknown) {
  const res = await fetch(`${API}/api/admin/akbar-cancellation/settings`, { method, headers: apiHeaders(), ...(body ? { body: JSON.stringify(body) } : {}) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error ?? d.message ?? `HTTP ${res.status}`);
  return d;
}

export function AkbarCancellationSettings() {
  const [v, setV] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [meta, setMeta] = useState<{ canEdit: boolean; environment: string; cancelPaths: string[] }>({ canEdit: false, environment: "", cancelPaths: [] });
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  const load = () => call("GET").then((d) => {
    setV(d.settings); setSaved(d.settings); setMeta({ canEdit: !!d.canEdit, environment: d.environment ?? "", cancelPaths: d.cancelPaths ?? [] });
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  if (error) return <section id="akbar-cancellation" style={card}><div style={errBox}>Akbar cancellation: {error}</div></section>;
  if (!v || !saved) return null;
  const edit = meta.canEdit;
  const changed = JSON.stringify(v) !== JSON.stringify(saved);

  async function save() {
    if (!v) return;
    if (v.liveCancellationEnabled && !saved!.liveCancellationEnabled
      && !confirm(`Turn Akbar cancellation ON for ALL Akbar API bookings${meta.environment ? ` (Akbar ${meta.environment})` : ""}?\n\nAdmins will then see "Cancel Booking" on eligible bookings and can cancel real tickets — each one still needs its own review and confirmation.`)) return;
    setBusy(true); setMsg(""); setError("");
    try {
      const { updatedAt: _a, updatedBy: _b, ...body } = v;
      const d = await call("PUT", body);
      setV(d.settings); setSaved(d.settings); setMsg("Saved — applies to every Akbar booking.");
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  }

  const flag = (k: "liveCancellationEnabled" | "partialPassengerCancellation" | "getRefundUatEnabled", label: string, help?: string) => (
    <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: "#e2e8f0", cursor: edit ? "pointer" : "default" }}>
      <input type="checkbox" disabled={!edit} checked={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.checked })} style={{ marginTop: 3 }} />
      <span>{label}{help && <span style={{ display: "block", fontSize: 12, color: "#94a3b8" }}>{help}</span>}</span>
    </label>
  );

  return (
    <section id="akbar-cancellation" style={{ ...card, marginTop: 16, scrollMarginTop: 80 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#ef4444" }} />
        <h2 style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9", margin: 0 }}>Akbar cancellation</h2>
        <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 20,
          background: saved.liveCancellationEnabled ? "#16a34a22" : "#ef444422", color: saved.liveCancellationEnabled ? "#4ade80" : "#f87171" }}>
          {saved.liveCancellationEnabled ? "ON for all Akbar bookings" : "OFF for all Akbar bookings"}
        </span>
      </div>
      <p style={hint}>
        One setting for every Akbar API booking. When it is ON, eligible bookings show <b style={{ color: "#cbd5e1" }}>Cancel Booking</b>;
        each cancellation is still reviewed and confirmed by an admin on the booking page. Nothing is ever cancelled automatically,
        and refunds stay separate steps. {edit ? "" : "Only a super admin can change this."}
      </p>
      <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
        {flag("liveCancellationEnabled", "Live cancellation ON", "Admins can send a cancellation to Akbar from an eligible booking, after reviewing and confirming it.")}
        <button type="button" onClick={() => setAdvanced(!advanced)} style={{ ...linkBtn, justifySelf: "start" }}>{advanced ? "▾" : "▸"} Advanced (points Akbar has not confirmed — change only after Akbar answers)</button>
        {advanced && <div style={{ display: "grid", gap: 10, padding: 12, borderRadius: 8, background: "#0f172a" }}>
          {flag("partialPassengerCancellation", "Allow cancelling some passengers only", "Akbar has not confirmed this. Off: every passenger on the transaction is cancelled together.")}
          {flag("getRefundUatEnabled", "Allow GetRefund on the UAT account", "Never runs on the production Akbar account.")}
          <label style={lbl}>Cancel path<select disabled={!edit} value={v.cancelPath} onChange={(e) => setV({ ...v, cancelPath: e.target.value })} style={input}>{(meta.cancelPaths.length ? meta.cancelPaths : [v.cancelPath]).map((p) => <option key={p}>{p}</option>)}</select></label>
          <label style={lbl}>TUI sent<select disabled={!edit} value={v.tuiSource} onChange={(e) => setV({ ...v, tuiSource: e.target.value })} style={input}><option value="ITINERARY">Original booking TUI (CreateItinerary)</option><option value="RETRIEVE_BOOKING">RetrieveBooking TUI</option></select></label>
          <label style={lbl}>Pax.Ticket<select disabled={!edit} value={v.ticketField} onChange={(e) => setV({ ...v, ticketField: e.target.value })} style={input}><option value="EMPTY">Empty, as in Akbar&apos;s sample</option><option value="TICKET_NUMBER">Ticket number</option></select></label>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>CancelType &quot;R&quot; and Isfullrefund false are fixed (the only values in Akbar&apos;s document).</div>
        </div>}
        {edit && <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button disabled={busy || !changed} onClick={save} style={{ ...btn, opacity: busy || !changed ? 0.6 : 1 }}>{busy ? "Saving…" : "Save"}</button>
          {msg && <span style={{ fontSize: 13, color: msg.startsWith("Saved") ? "#86efac" : "#fca5a5" }}>{msg}</span>}
        </div>}
        {saved.updatedAt && <div style={{ fontSize: 11, color: "#64748b" }}>Last changed {new Date(saved.updatedAt).toLocaleString("en-IN")}</div>}
      </div>
    </section>
  );
}

const card: React.CSSProperties = { background: "#1e293b", borderRadius: 12, padding: 20, border: "1px solid #334155" };
const hint: React.CSSProperties = { fontSize: 13, color: "#94a3b8", margin: 0, lineHeight: 1.6 };
const lbl: React.CSSProperties = { display: "grid", gap: 6, fontSize: 12, fontWeight: 600, color: "#94a3b8" };
const input: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "9px 12px", background: "#1e293b", border: "1.5px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 14 };
const btn: React.CSSProperties = { background: "#0D4B96", color: "white", border: "none", borderRadius: 8, padding: "9px 20px", fontWeight: 700, fontSize: 13, cursor: "pointer" };
const linkBtn: React.CSSProperties = { background: "none", border: 0, color: "#94a3b8", fontSize: 12, cursor: "pointer", padding: 0 };
const errBox: React.CSSProperties = { background: "rgba(239,68,68,.1)", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 8, padding: "10px 12px", fontSize: 13 };
