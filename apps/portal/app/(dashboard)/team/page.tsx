"use client";

import { FormEvent, useEffect, useState } from "react";
import { api, fmtDate } from "../../../lib/api";
import { useMe } from "../Shell";

interface U { id: string; name: string; email: string; phone: string | null; role: string; isActive: boolean; lastLoginAt: string | null; createdAt: string }
const ROLES: Record<string, { label: string; hint: string }> = {
  AGENT_ADMIN: { label: "Admin", hint: "Everything, incl. team, settings and money" },
  AGENT_STAFF: { label: "Booking staff", hint: "Search, book, quotes, travellers, requests" },
  AGENT_ACCOUNTANT: { label: "Accountant", hint: "Wallet, top-ups, statements, plus booking" },
};

export default function TeamPage() {
  const { me } = useMe();
  const [users, setUsers] = useState<U[]>([]);
  const [form, setForm] = useState({ name: "", email: "", role: "AGENT_STAFF" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const admin = me?.user.role === "AGENT_ADMIN";

  const load = () => api<{ users: U[] }>("/api/agent/users").then((d) => setUsers(d.users)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function invite(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const d = await api<{ message: string; link: string }>("/api/agent/users/invite", { json: form });
      setNotice(`${d.message} You can also share this link: ${d.link}`);
      setForm({ name: "", email: "", role: "AGENT_STAFF" });
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't invite"); } finally { setBusy(false); }
  }

  async function update(u: U, patch: Partial<Pick<U, "isActive" | "role">>) {
    setError("");
    try { await api(`/api/agent/users/${u.id}`, { method: "PATCH", json: patch }); load(); } catch (err) { setError(err instanceof Error ? err.message : "Couldn't update"); }
  }

  return (
    <div>
      <div className="page-head"><div><h1>Team logins</h1><p>Give each staff member their own login with the right access.</p></div></div>
      {notice && <div className="banner ok" style={{ wordBreak: "break-all" }}>{notice}</div>}
      {error && <div className="banner bad">{error}</div>}
      {admin && (
        <form className="card stack" onSubmit={invite}>
          <h2>Invite a team member</h2>
          <div className="grid g3">
            <label className="f">Name<input required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></label>
            <label className="f">Email<input type="email" required value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} /></label>
            <label className="f">Access<select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v.label} — {v.hint}</option>)}</select></label>
          </div>
          <button className="btn primary" disabled={busy} style={{ alignSelf: "flex-start" }}>{busy ? "Sending…" : "Send invitation"}</button>
        </form>
      )}
      <div className="card flush">
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Name</th><th>Access</th><th>Last sign-in</th><th>Status</th><th /></tr></thead>
          <tbody>{users.map((u) => (
            <tr key={u.id}>
              <td><b>{u.name}</b><div className="muted small">{u.email}</div></td>
              <td>{admin && u.id !== me?.user.id
                ? <select className="in" style={{ width: 170 }} value={u.role} onChange={(e) => update(u, { role: e.target.value })}>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
                : ROLES[u.role]?.label ?? u.role}</td>
              <td className="small muted">{u.lastLoginAt ? fmtDate(u.lastLoginAt, true) : "Never"}</td>
              <td>{u.isActive ? <span className="badge b-green">Active</span> : <span className="badge b-grey">Disabled</span>}</td>
              <td className="num">{admin && u.id !== me?.user.id && <button className="btn sm" onClick={() => update(u, { isActive: !u.isActive })}>{u.isActive ? "Disable" : "Enable"}</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </div>
    </div>
  );
}
