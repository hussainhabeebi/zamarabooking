"use client";

import { FormEvent, Fragment, useEffect, useState } from "react";
import { api, fmtDate, money, STATUS_STYLE } from "../../../lib/api";
import { useMe } from "../Shell";

interface SubAgent {
  id: string; businessName: string; contactEmail: string; contactPhone: string; status: string; createdAt: string;
  walletBalance?: number; walletCurrency?: string | null; markup?: { type: "FLAT" | "PERCENTAGE"; value: number } | null;
}
type Panel = { id: string; kind: "markup" | "funds" } | null;

export default function SubAgentsPage() {
  const { me, reload: reloadMe } = useMe();
  const [agents, setAgents] = useState<SubAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ businessName: "", contactEmail: "", contactPhone: "" });
  const [panel, setPanel] = useState<Panel>(null);
  const [markupForm, setMarkupForm] = useState({ type: "FLAT" as "FLAT" | "PERCENTAGE", value: "" });
  const [fundsForm, setFundsForm] = useState({ direction: "TO_SUB" as "TO_SUB" | "TO_PARENT", amount: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const admin = me?.user.role === "AGENT_ADMIN";

  const reload = () => api<{ agents: SubAgent[] }>("/api/agents/sub-agents").then((d) => setAgents(d.agents ?? [])).catch((e) => setMsg({ ok: false, text: e.message }));
  useEffect(() => { reload().finally(() => setLoading(false)); }, []);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); setPanel(null); await reload(); reloadMe(); }
    catch (err) { setMsg({ ok: false, text: err instanceof Error ? err.message : "Failed" }); }
    finally { setBusy(false); }
  }

  async function invite(e: FormEvent) {
    e.preventDefault();
    await act(async () => {
      const d = await api<{ inviteLink?: string | null }>("/api/agents/sub-agents/invite", { json: form });
      setForm({ businessName: "", contactEmail: "", contactPhone: "" }); setShowForm(false);
      if (d.inviteLink) setTimeout(() => setMsg({ ok: true, text: `Sub-agent invited. They get an email to set their password. Link: ${d.inviteLink}` }), 0);
    }, "Sub-agent invited — FlyPoomas approves new agencies after a KYC check.");
  }

  return (
    <div>
      <div className="page-head">
        <div><h1>Sub-agents</h1><p>Your branches and partner agencies. Each has its own login, wallet and price markup that you set.</p></div>
        {admin && <button className="btn primary" onClick={() => setShowForm((v) => !v)}>+ Invite sub-agent</button>}
      </div>
      <div className="banner info small">How pricing works: a sub-agent pays your price (your net + the markup you set for them). You earn that markup in your wallet when their ticket is issued.</div>
      {msg && <div className={`banner ${msg.ok ? "ok" : "bad"}`} style={{ wordBreak: "break-all" }}>{msg.text}</div>}
      {showForm && (
        <form className="card stack" onSubmit={invite}>
          <h2>Invite a sub-agent</h2>
          <div className="grid g3">
            <label className="f">Business name<input required value={form.businessName} onChange={(e) => setForm((f) => ({ ...f, businessName: e.target.value }))} /></label>
            <label className="f">Email<input type="email" required value={form.contactEmail} onChange={(e) => setForm((f) => ({ ...f, contactEmail: e.target.value }))} /></label>
            <label className="f">Phone<input required value={form.contactPhone} onChange={(e) => setForm((f) => ({ ...f, contactPhone: e.target.value }))} /></label>
          </div>
          <div className="row"><button className="btn primary" disabled={busy}>{busy ? "Sending…" : "Send invitation"}</button><button type="button" className="btn" onClick={() => setShowForm(false)}>Cancel</button></div>
        </form>
      )}
      <div className="card flush">
        {loading ? <p className="empty"><span className="spin" /> Loading…</p> : agents.length === 0 ? <p className="empty">No sub-agents yet. Invite one to grow your network.</p> : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Agency</th><th>Status</th><th className="num">Wallet</th><th>Your markup</th><th>Joined</th><th /></tr></thead>
            <tbody>{agents.map((a) => {
              const open = panel?.id === a.id ? panel.kind : null;
              const st = STATUS_STYLE[a.status] ?? { label: a.status, cls: "b-grey" };
              return (
                <Fragment key={a.id}>
                  <tr>
                    <td><b>{a.businessName}</b><div className="muted small">{a.contactEmail} · {a.contactPhone}</div></td>
                    <td><span className={`badge ${st.cls}`}>{st.label}</span></td>
                    <td className="num">{money(a.walletBalance ?? 0, a.walletCurrency ?? "INR")}</td>
                    <td>{a.markup ? (a.markup.type === "PERCENTAGE" ? `${a.markup.value}%` : money(a.markup.value, a.walletCurrency ?? "INR")) : <span className="muted">None</span>}</td>
                    <td className="small muted">{fmtDate(a.createdAt)}</td>
                    <td className="num" style={{ whiteSpace: "nowrap" }}>{admin && <>
                      <button className="btn sm" onClick={() => { setMarkupForm({ type: a.markup?.type ?? "FLAT", value: a.markup ? String(a.markup.value) : "" }); setPanel(open === "markup" ? null : { id: a.id, kind: "markup" }); }}>Markup</button>{" "}
                      <button className="btn sm" onClick={() => { setFundsForm({ direction: "TO_SUB", amount: "" }); setPanel(open === "funds" ? null : { id: a.id, kind: "funds" }); }}>Funds</button>{" "}
                      {(a.status === "APPROVED" || a.status === "SUSPENDED") && (
                        <button className="btn sm" disabled={busy} onClick={() => act(() => api(`/api/agents/sub-agents/${a.id}/status`, { method: "PATCH", json: { status: a.status === "APPROVED" ? "SUSPENDED" : "APPROVED" } }), a.status === "APPROVED" ? "Sub-agent suspended" : "Sub-agent resumed")}>
                          {a.status === "APPROVED" ? "Suspend" : "Resume"}</button>
                      )}</>}
                    </td>
                  </tr>
                  {open && (
                    <tr><td colSpan={6} style={{ background: "#f8fafc" }}>
                      {open === "markup" ? (
                        <form className="row" onSubmit={(e) => { e.preventDefault(); void act(() => api(`/api/agents/sub-agents/${a.id}/markup`, { method: "PUT", json: { type: markupForm.type, value: Number(markupForm.value || 0) } }), "Markup saved"); }}>
                          <span className="small">Markup on {a.businessName}&apos;s fares:</span>
                          <select className="in" style={{ width: 190 }} value={markupForm.type} onChange={(e) => setMarkupForm((f) => ({ ...f, type: e.target.value as "FLAT" | "PERCENTAGE" }))}><option value="FLAT">Flat per booking</option><option value="PERCENTAGE">Percentage of fare</option></select>
                          <input className="in" style={{ width: 120 }} type="number" min={0} step="0.01" value={markupForm.value} placeholder={markupForm.type === "PERCENTAGE" ? "e.g. 2" : "e.g. 250"} onChange={(e) => setMarkupForm((f) => ({ ...f, value: e.target.value }))} />
                          <button className="btn primary sm" disabled={busy}>Save</button><span className="small muted">0 removes it</span>
                        </form>
                      ) : (
                        <form className="row" onSubmit={(e) => { e.preventDefault(); void act(() => api(`/api/agents/sub-agents/${a.id}/transfer`, { json: { direction: fundsForm.direction, amount: Number(fundsForm.amount) } }), fundsForm.direction === "TO_SUB" ? "Funds sent" : "Funds pulled back"); }}>
                          <select className="in" style={{ width: 280 }} value={fundsForm.direction} onChange={(e) => setFundsForm((f) => ({ ...f, direction: e.target.value as "TO_SUB" | "TO_PARENT" }))}>
                            <option value="TO_SUB">Send from my wallet to {a.businessName}</option><option value="TO_PARENT">Pull back from {a.businessName}</option>
                          </select>
                          <input className="in" style={{ width: 140 }} type="number" min={1} step="0.01" required placeholder="Amount" value={fundsForm.amount} onChange={(e) => setFundsForm((f) => ({ ...f, amount: e.target.value }))} />
                          <button className="btn primary sm" disabled={busy || !(Number(fundsForm.amount) > 0)}>Transfer</button>
                        </form>
                      )}
                    </td></tr>
                  )}
                </Fragment>
              );
            })}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
