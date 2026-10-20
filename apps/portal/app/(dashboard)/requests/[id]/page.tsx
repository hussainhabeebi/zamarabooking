"use client";

import { FormEvent, Fragment, useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, fmtDate, money, openFile, requestLabel, STATUS_STYLE } from "../../../../lib/api";

type File_ = { key: string; name: string; type: string; size: number };
interface Req { id: string; type: string; status: string; title: string; details: Record<string, unknown>; attachments: File_[]; amount: number | null; currency: string | null; adminNote: string | null; bookingId: string | null; createdAt: string; dueAt: string | null }
interface Msg { id: string; fromStaff: boolean; message: string; attachments: File_[]; createdAt: string }

const label = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

export default function RequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [r, setR] = useState<Req | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<{ request: Req; messages: Msg[] }>(`/api/agent/requests/${id}`).then((d) => { setR(d.request); setMsgs(d.messages); }).catch((e) => setError(e.message));
  }, [id]);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const form = new FormData();
      form.append("message", text);
      files.forEach((f) => form.append("files", f));
      await api(`/api/agent/requests/${id}/messages`, { method: "POST", body: form });
      setText(""); setFiles([]); load();
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't send"); } finally { setBusy(false); }
  }

  const open = (f: File_) => openFile(`/api/agent/requests/${id}/file?key=${encodeURIComponent(f.key)}`).catch((e) => setError(e.message));

  if (!r) return <div><a href="/requests">← Requests</a>{error ? <div className="banner bad" style={{ marginTop: 12 }}>{error}</div> : <p className="muted"><span className="spin" /> Loading…</p>}</div>;
  const st = STATUS_STYLE[r.status] ?? { label: r.status, cls: "b-grey" };
  const details = Object.entries(r.details ?? {}).filter(([k, v]) => v !== "" && v !== null && v !== undefined && k !== "message" && typeof v !== "object");
  const trip = (r.details as { trip?: Record<string, unknown> }).trip;

  return (
    <div>
      <a href="/requests">← Requests</a>
      <div className="page-head" style={{ marginTop: 8 }}>
        <div><h1>{r.title}</h1><p>{requestLabel(r.type)} · #{r.id.slice(0, 8).toUpperCase()} · {fmtDate(r.createdAt, true)}</p></div>
        <div className="row"><span className={`badge ${st.cls}`} style={{ fontSize: 13 }}>{r.type === "DEPOSIT" && r.status === "APPROVED" ? "Credited" : st.label}</span>
          {!["CLOSED", "DONE"].includes(r.status) && <button className="btn sm" onClick={async () => { await api(`/api/agent/requests/${id}/close`, { method: "POST" }).catch(() => {}); load(); }}>Close</button>}</div>
      </div>
      {error && <div className="banner bad">{error}</div>}
      <div className="grid g2">
        <div className="card">
          <h2>Details</h2>
          <dl className="kv">
            {details.map(([k, v]) => <Fragment key={k}><dt>{label(k)}</dt><dd>{String(v)}</dd></Fragment>)}
            {trip && Object.entries(trip).filter(([, v]) => typeof v !== "object").map(([k, v]) => <Fragment key={`t${k}`}><dt>{label(k)}</dt><dd>{String(v)}</dd></Fragment>)}
            {r.amount !== null && <><dt>Amount</dt><dd>{money(r.amount, r.currency ?? "INR")}</dd></>}
            {r.bookingId && <><dt>Booking</dt><dd><a href={`/bookings/${r.bookingId}`}>{r.bookingId.slice(0, 8).toUpperCase()}</a></dd></>}
          </dl>
          {typeof r.details.message === "string" && r.details.message && <p style={{ whiteSpace: "pre-wrap" }}>{r.details.message}</p>}
          {r.adminNote && <div className="banner info">Note from FlyPoomas: {r.adminNote}</div>}
          {r.attachments.length > 0 && <div className="row">{r.attachments.map((f) => <button key={f.key} className="btn sm" onClick={() => open(f)}>📎 {f.name}</button>)}</div>}
        </div>
        <div className="card">
          <h2>Conversation</h2>
          <div className="thread">
            {msgs.length === 0 && <p className="muted small">Our team will reply here. You'll also get a WhatsApp / email update.</p>}
            {msgs.map((m) => (
              <div key={m.id} className={`msg${m.fromStaff ? "" : " mine"}`}>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.message}</div>
                {m.attachments.map((f) => <button key={f.key} className="btn ghost sm" onClick={() => open(f)}>📎 {f.name}</button>)}
                <small>{m.fromStaff ? "FlyPoomas team" : "You"} · {fmtDate(m.createdAt, true)}</small>
              </div>
            ))}
          </div>
          <form onSubmit={send} className="stack" style={{ marginTop: 12 }}>
            <textarea className="in" value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a message…" />
            <div className="row between">
              <input type="file" multiple accept="image/*,application/pdf" onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 10))} />
              <button className="btn primary" disabled={busy || (!text.trim() && !files.length)}>Send</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
