"use client";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "../../../lib/files";
import { ui } from "../../../lib/ui";

// Admin panel users: full admins and staff limited to chosen sections.
type Section = { key: string; label: string };
type AdminUser = {
  id: string; name: string | null; email: string | null; phone: string | null; role: string; isActive: boolean;
  permissions: string[]; lastLoginAt: string | null; createdAt: string; hasPassword: boolean;
};
type Result = { email: string; link?: string | null; temporaryPassword?: string | null };

const ROLE_LABEL: Record<string, string> = { SUPER_ADMIN: "Admin (full access)", TENANT_ADMIN: "Admin (limited)", STAFF: "Staff" };
const blank = { name: "", email: "", phone: "", role: "STAFF" as "STAFF" | "SUPER_ADMIN", permissions: ["bookings", "support"] as string[], delivery: "invite" as "invite" | "temporary" };

export default function UsersPage() {
  const [list, setList] = useState<AdminUser[] | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [form, setForm] = useState(blank);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editPerms, setEditPerms] = useState<string[]>([]);
  const [editRole, setEditRole] = useState("STAFF");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    adminApi<{ users: AdminUser[]; sections: Section[]; me: string | null }>("/api/admin/users")
      .then((d) => { setList(d.users); setSections(d.sections); setMeId(d.me); }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setError(""); setMsg("");
    try { await fn(); setMsg(done); load(); } catch (e) { setError(e instanceof Error ? e.message : "Failed"); } finally { setBusy(false); }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    await run(async () => {
      const r = await adminApi<Result>("/api/admin/users", { method: "POST", body: JSON.stringify({
        ...form, phone: form.phone || undefined, permissions: form.role === "STAFF" ? form.permissions : [], origin: window.location.origin,
      }) });
      setResult(r); setForm(blank); setShow(false);
    }, form.delivery === "invite" ? `Invitation emailed to ${form.email}.` : `${form.email} added with a temporary password.`);
  }

  async function reset(u: AdminUser, mode: "link" | "temporary") {
    if (mode === "temporary" && !confirm(`Set a new temporary password for ${u.email}? Their current password stops working.`)) return;
    setResult(null);
    await run(async () => {
      const r = await adminApi<Result>(`/api/admin/users/${u.id}/password-reset`, { method: "POST", body: JSON.stringify({ mode, origin: window.location.origin }) });
      setResult(r);
    }, mode === "link" ? `Reset link emailed to ${u.email}.` : `Temporary password set for ${u.email}.`);
  }

  const togglePerm = (list: string[], key: string) => list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
  const copy = (t: string) => { void navigator.clipboard?.writeText(t); setMsg("Copied."); };
  const sectionLabel = (k: string) => sections.find((s) => s.key === k)?.label ?? k;

  return (
    <div>
      <h1 style={ui.h1}>Users & staff</h1>
      <p style={ui.sub}>
        Give your team their own logins. <b>Admins</b> can do everything, including managing users.
        <b> Staff</b> only see the sections you tick — the rest of the admin panel is hidden and blocked for them.
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <button style={ui.btn} onClick={() => { setShow((v) => !v); setResult(null); }}>{show ? "Close" : "+ Add user"}</button>
      </div>
      {error && <div style={ui.err}>{error}</div>}
      {msg && <div style={ui.ok}>{msg}</div>}
      {result && (result.temporaryPassword || result.link) && (
        <div style={{ ...ui.card, borderColor: "#14532d", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", ...ui.text }}>
          {result.temporaryPassword ? (
            <>Temporary password for {result.email}: <b style={{ fontFamily: "monospace", fontSize: 16, color: "#4ade80" }}>{result.temporaryPassword}</b>
              <button style={ui.ghost} onClick={() => copy(result.temporaryPassword!)}>Copy</button>
              <span style={ui.muted}>Shown once. Share it securely; they can change it with “Forgot password?”.</span></>
          ) : (
            <>Link for {result.email}: <button style={ui.ghost} onClick={() => copy(result.link!)}>Copy link</button>
              <span style={ui.muted}>Also emailed. Invitations work for 7 days, reset links for 1 hour.</span></>
          )}
        </div>
      )}

      {show && (
        <form onSubmit={add} style={ui.card}>
          <h2 style={ui.h2}>Add a user</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <label style={ui.label}>Name<input style={ui.input} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label style={ui.label}>Email (login)<input style={ui.input} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label style={ui.label}>Phone (optional)<input style={ui.input} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
            <label style={ui.label}>Role
              <select style={ui.input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as "STAFF" | "SUPER_ADMIN" })}>
                <option value="STAFF">Staff — selected sections</option>
                <option value="SUPER_ADMIN">Admin — full access</option>
              </select>
            </label>
          </div>
          {form.role === "STAFF" && (
            <div style={{ marginTop: 12 }}>
              <div style={{ ...ui.muted, marginBottom: 6 }}>Sections this person can open</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {sections.map((s) => <button type="button" key={s.key} style={ui.chip(form.permissions.includes(s.key))} onClick={() => setForm({ ...form, permissions: togglePerm(form.permissions, s.key) })}>{s.label}</button>)}
              </div>
            </div>
          )}
          {form.role === "SUPER_ADMIN" && <p style={{ ...ui.muted, marginTop: 10 }}>Admins can change settings, integrations, payment and supplier keys, and manage other users.</p>}
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "12px 0", ...ui.text }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="radio" checked={form.delivery === "invite"} onChange={() => setForm({ ...form, delivery: "invite" })} /> Email an invitation (they choose the password)</label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="radio" checked={form.delivery === "temporary"} onChange={() => setForm({ ...form, delivery: "temporary" })} /> Create a temporary password now</label>
          </div>
          <button style={ui.btn} disabled={busy || (form.role === "STAFF" && form.permissions.length === 0)}>{busy ? "Adding…" : "Add user"}</button>
        </form>
      )}

      <div style={{ ...ui.card, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{["User", "Role & access", "Status", ""].map((h) => <th key={h} style={ui.th}>{h}</th>)}</tr></thead>
          <tbody>
            {!list && <tr><td style={ui.td} colSpan={4}>Loading…</td></tr>}
            {list?.map((u) => {
              const self = u.id === meId;
              const isEditing = editing === u.id;
              return (
                <tr key={u.id} style={{ opacity: u.isActive ? 1 : 0.55 }}>
                  <td style={ui.td}>
                    <b style={{ color: "#f1f5f9" }}>{u.name || "—"}</b>{self && <span style={{ color: "#93c5fd", fontSize: 11, marginLeft: 6 }}>YOU</span>}
                    <div style={ui.muted}>{u.email}</div>
                    <div style={ui.muted}>{!u.hasPassword ? "Invitation not accepted yet" : u.lastLoginAt ? `Last sign-in ${new Date(u.lastLoginAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}` : "Never signed in"}</div>
                  </td>
                  <td style={{ ...ui.td, maxWidth: 480 }}>
                    {isEditing ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <select style={{ ...ui.input, width: 220 }} value={editRole} onChange={(e) => setEditRole(e.target.value)}>
                          <option value="STAFF">Staff — selected sections</option>
                          <option value="SUPER_ADMIN">Admin — full access</option>
                        </select>
                        {editRole === "STAFF" && (
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {sections.map((s) => <button type="button" key={s.key} style={ui.chip(editPerms.includes(s.key))} onClick={() => setEditPerms(togglePerm(editPerms, s.key))}>{s.label}</button>)}
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 6 }}>
                          <button style={ui.btn} disabled={busy || (editRole === "STAFF" && !editPerms.length)} onClick={() => run(async () => {
                            await adminApi(`/api/admin/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ role: editRole, permissions: editRole === "STAFF" ? editPerms : [] }) });
                            setEditing(null);
                          }, "Access updated — it applies within a minute.")}>Save</button>
                          <button style={ui.ghost} onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <b style={{ color: u.role === "STAFF" ? "#93c5fd" : "#fbbf24" }}>{ROLE_LABEL[u.role] ?? u.role}</b>
                        {u.role === "STAFF" && <div style={{ ...ui.muted, marginTop: 4 }}>{u.permissions.map(sectionLabel).join(" · ") || "No sections"}</div>}
                      </>
                    )}
                  </td>
                  <td style={ui.td}>{u.isActive ? <span style={{ color: "#4ade80" }}>Active</span> : <span style={{ color: "#f87171" }}>Deactivated</span>}</td>
                  <td style={{ ...ui.td, whiteSpace: "nowrap" }}>
                    {!isEditing && u.role !== "TENANT_ADMIN" && !self && (
                      <button style={{ ...ui.ghost, padding: "4px 8px" }} onClick={() => { setEditing(u.id); setEditRole(u.role); setEditPerms(u.permissions); }}>Edit access</button>
                    )}{" "}
                    {u.isActive && <><button style={{ ...ui.ghost, padding: "4px 8px" }} disabled={busy} onClick={() => reset(u, "link")}>Email reset link</button>{" "}
                      <button style={{ ...ui.ghost, padding: "4px 8px" }} disabled={busy} onClick={() => reset(u, "temporary")}>Temp password</button>{" "}</>}
                    {!self && (u.isActive
                      ? <button style={{ ...ui.ghost, padding: "4px 8px", color: "#fca5a5" }} disabled={busy} onClick={() => { if (confirm(`Deactivate ${u.email}? They are signed out of the admin panel within a minute.`)) void run(() => adminApi(`/api/admin/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ isActive: false }) }), `${u.email} deactivated.`); }}>Deactivate</button>
                      : <button style={{ ...ui.ghost, padding: "4px 8px" }} disabled={busy} onClick={() => run(() => adminApi(`/api/admin/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ isActive: true }) }), `${u.email} reactivated.`)}>Reactivate</button>)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
