"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { adminApi, openAdminFile } from "../../../../lib/files";
import { money, REQUEST_TYPE_LABEL, STATUS_COLOR, ui } from "../../../../lib/ui";

type F = { key: string; name: string; type: string; size: number };
interface Data {
  request: { id: string; type: string; status: string; title: string; details: Record<string, unknown>; attachments: F[]; amount: number | null; currency: string | null; adminNote: string | null; bookingId: string | null; createdAt: string; dueAt: string | null; agentId: string };
  agent: { id: string; businessName: string; email: string; phone: string; currency: string } | null;
  messages: { id: string; fromStaff: boolean; message: string; attachments: F[]; createdAt: string }[];
}
const STATUSES = ["OPEN", "IN_PROGRESS", "QUOTED", "APPROVED", "DONE", "REJECTED", "CLOSED"];

export default function AgentRequestPage() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => adminApi<Data>(`/api/admin/agent-program/requests/${id}`).then((x) => { setD(x); setNote(x.request.adminNote ?? ""); setAmount(x.request.amount !== null ? String(x.request.amount) : ""); }).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); setNotice(ok); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Failed"); } finally { setBusy(false); }
  }

  if (!d) return <div><a href="/agent-requests" style={{ color: "#94a3b8", fontSize: 13 }}>← Agent requests</a>{error ? <div style={ui.err}>{error}</div> : <p style={ui.muted}>Loading…</p>}</div>;
  const r = d.request;
  const file = (f: F) => openAdminFile(`/api/admin/agent-program/requests/${r.id}/file?key=${encodeURIComponent(f.key)}`).catch((e) => setError(e.message));
  const details = Object.entries(r.details ?? {}).filter(([k, v]) => v !== "" && v !== null && v !== undefined && k !== "ticket" && k !== "file");

  return (
    <div>
      <a href="/agent-requests" style={{ color: "#94a3b8", fontSize: 13, textDecoration: "none" }}>← Agent requests</a>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", margin: "8px 0 16px" }}>
        <div><h1 style={ui.h1}>{r.title}</h1><div style={ui.muted}>{REQUEST_TYPE_LABEL[r.type] ?? r.type} · {d.agent?.businessName} · {new Date(r.createdAt).toLocaleString("en-IN")}{r.dueAt ? ` · reply due ${new Date(r.dueAt).toLocaleString("en-IN")}` : ""}</div></div>
        <span style={{ color: STATUS_COLOR[r.status] ?? "#94a3b8", fontWeight: 700 }}>● {r.status.replace("_", " ")}</span>
      </div>
      {error && <div style={ui.err}>{error}</div>}
      {notice && <div style={ui.ok}>{notice}</div>}

      {r.type === "DEPOSIT" && ["OPEN", "IN_PROGRESS"].includes(r.status) && (
        <div style={{ ...ui.card, borderColor: "#14532d" }}>
          <h2 style={ui.h2}>Approve deposit</h2>
          <p style={{ ...ui.text, marginTop: 0 }}>Check the money has arrived in the bank, then credit the agency wallet.</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input style={{ ...ui.input, width: 160 }} type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
            <button style={ui.btn} disabled={busy || !(Number(amount) > 0)} onClick={() => { if (confirm(`Credit ${money(Number(amount), d.agent?.currency)} to ${d.agent?.businessName}?`)) void run(() => adminApi(`/api/admin/agent-program/requests/${r.id}/approve-deposit`, { method: "POST", body: JSON.stringify({ amount: Number(amount) }) }), "Wallet credited and agency notified."); }}>Credit wallet</button>
            <button style={ui.ghost} disabled={busy} onClick={() => run(() => adminApi(`/api/admin/agent-program/requests/${r.id}`, { method: "PATCH", body: JSON.stringify({ status: "REJECTED", adminNote: note || "Payment not received" }) }), "Deposit rejected.")}>Reject</button>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <div style={ui.card}>
          <h2 style={ui.h2}>Details</h2>
          <dl style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: "6px 12px", margin: 0, ...ui.text }}>
            <dt style={{ color: "#64748b" }}>Agency</dt><dd style={{ margin: 0 }}><a href={`/agents/${r.agentId}`} style={{ color: "#93c5fd" }}>{d.agent?.businessName}</a> · {d.agent?.phone}</dd>
            {details.map(([k, v]) => <Fragment key={k}><dt style={{ color: "#64748b" }}>{k}</dt><dd style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd></Fragment>)}
            {r.bookingId && <><dt style={{ color: "#64748b" }}>Booking</dt><dd style={{ margin: 0 }}><a href={`/bookings/${r.bookingId}`} style={{ color: "#93c5fd" }}>{r.bookingId.slice(0, 8).toUpperCase()}</a></dd></>}
          </dl>
          {r.attachments.length > 0 && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>{r.attachments.map((f) => <button key={f.key} style={ui.ghost} onClick={() => file(f)}>📎 {f.name}</button>)}</div>}
          <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
            <label style={ui.label}>Status<select style={ui.input} defaultValue={r.status} onChange={(e) => run(() => adminApi(`/api/admin/agent-program/requests/${r.id}`, { method: "PATCH", body: JSON.stringify({ status: e.target.value }) }), "Status updated — agency notified.")}>{STATUSES.filter((s) => r.type !== "DEPOSIT" || s !== "APPROVED").map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></label>
            {r.type !== "DEPOSIT" && <label style={ui.label}>Quoted amount ({d.agent?.currency})<input style={ui.input} type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} /></label>}
            <label style={ui.label}>Note shown to the agency<textarea style={{ ...ui.input, minHeight: 60 }} value={note} onChange={(e) => setNote(e.target.value)} /></label>
            <button style={{ ...ui.ghost, justifySelf: "start" }} disabled={busy} onClick={() => run(() => adminApi(`/api/admin/agent-program/requests/${r.id}`, { method: "PATCH", body: JSON.stringify({ adminNote: note, ...(r.type !== "DEPOSIT" && amount !== "" ? { amount: Number(amount) } : {}) }) }), "Saved.")}>Save note / amount</button>
          </div>
        </div>
        <div style={ui.card}>
          <h2 style={ui.h2}>Conversation</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {d.messages.length === 0 && <p style={ui.muted}>No messages yet.</p>}
            {d.messages.map((m) => (
              <div key={m.id} style={{ alignSelf: m.fromStaff ? "flex-end" : "flex-start", maxWidth: "85%", background: m.fromStaff ? "#3b0d10" : "#0f172a", border: "1px solid #334155", borderRadius: 10, padding: "8px 10px", ...ui.text }}>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.message}</div>
                {m.attachments.map((f) => <button key={f.key} style={{ ...ui.ghost, padding: "4px 8px", marginTop: 6 }} onClick={() => file(f)}>📎 {f.name}</button>)}
                <div style={{ ...ui.muted, marginTop: 4 }}>{m.fromStaff ? "FlyPoomas" : "Agency"} · {new Date(m.createdAt).toLocaleString("en-IN")}</div>
              </div>
            ))}
          </div>
          <textarea style={{ ...ui.input, width: "100%", minHeight: 70, marginTop: 12 }} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply to the agency (sent on WhatsApp and email)" />
          <button style={{ ...ui.btn, marginTop: 8 }} disabled={busy || !reply.trim()} onClick={() => run(async () => { await adminApi(`/api/admin/agent-program/requests/${r.id}/messages`, { method: "POST", body: JSON.stringify({ message: reply.trim() }) }); setReply(""); }, "Reply sent.")}>Send reply</button>
        </div>
      </div>
    </div>
  );
}
