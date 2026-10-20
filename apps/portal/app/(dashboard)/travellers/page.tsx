"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, fmtDate } from "../../../lib/api";

interface T { id: string; type: string; firstName: string; lastName: string; dob: string | null; gender: string | null; nationality: string | null; passportNumber: string | null; passportExpiry: string | null; phone: string | null; email: string | null; groupName: string | null }
const empty = { type: "ADULT", firstName: "", lastName: "", dob: "", gender: "M", nationality: "IN", passportNumber: "", passportExpiry: "", phone: "", email: "", groupName: "" };

export default function TravellersPage() {
  const [rows, setRows] = useState<T[] | null>(null);
  const [q, setQ] = useState("");
  const [form, setForm] = useState<typeof empty & { id?: string }>(empty);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<{ travellers: T[] }>(`/api/agent/travellers${q ? `?q=${encodeURIComponent(q)}` : ""}`).then((d) => setRows(d.travellers)).catch((e) => setError(e.message));
  }, [q]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    const body = { ...form, dob: form.dob || null, passportNumber: form.passportNumber || null, passportExpiry: form.passportExpiry || null, phone: form.phone || null, email: form.email || null, groupName: form.groupName || null, nationality: form.nationality || null };
    try {
      if (form.id) await api(`/api/agent/travellers/${form.id}`, { method: "PUT", json: body });
      else await api("/api/agent/travellers", { json: body });
      setOpen(false); setForm(empty); load();
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't save"); } finally { setBusy(false); }
  }

  async function scan(f?: File) {
    if (!f) return;
    setScanning(true); setError("");
    try {
      const fd = new FormData(); fd.append("file", f);
      const d = await api<{ traveller: { firstName: string; lastName: string; dob: string | null; gender: string | null; nationality: string | null; documentNumber: string | null; expiryDate: string | null } }>("/api/ai/scan-document", { method: "POST", body: fd, auth: false });
      const t = d.traveller;
      setForm((x) => ({ ...x, firstName: t.firstName || x.firstName, lastName: t.lastName || x.lastName, dob: t.dob ?? x.dob, gender: t.gender ?? x.gender, nationality: t.nationality ?? x.nationality, passportNumber: t.documentNumber ?? x.passportNumber, passportExpiry: t.expiryDate ?? x.passportExpiry }));
      setOpen(true);
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't read the passport"); } finally { setScanning(false); }
  }

  const soon = (d: string | null) => d && new Date(d).getTime() < Date.now() + 183 * 86_400_000;

  return (
    <div>
      <div className="page-head"><div><h1>Travellers</h1><p>Your customers&apos; details — pick them at checkout instead of typing again.</p></div>
        <div className="row">
          <label className="btn" style={{ cursor: "pointer" }}>{scanning ? <><span className="spin" /> Reading…</> : "📷 Add from passport"}<input type="file" hidden accept="image/*,application/pdf" onChange={(e) => { void scan(e.target.files?.[0]); e.target.value = ""; }} /></label>
          <button className="btn primary" onClick={() => { setForm(empty); setOpen(true); }}>+ Add traveller</button>
        </div>
      </div>
      {error && <div className="banner bad">{error}</div>}
      {open && (
        <form className="card stack" onSubmit={save}>
          <h2>{form.id ? "Edit traveller" : "New traveller"}</h2>
          <div className="grid g4">
            <label className="f">First name<input required value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} /></label>
            <label className="f">Last name<input required value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} /></label>
            <label className="f">Type<select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}><option value="ADULT">Adult</option><option value="CHILD">Child</option><option value="INFANT">Infant</option></select></label>
            <label className="f">Gender<select value={form.gender} onChange={(e) => setForm((f) => ({ ...f, gender: e.target.value }))}><option value="M">Male</option><option value="F">Female</option></select></label>
            <label className="f">Date of birth<input type="date" value={form.dob} onChange={(e) => setForm((f) => ({ ...f, dob: e.target.value }))} /></label>
            <label className="f">Nationality<input maxLength={2} value={form.nationality} onChange={(e) => setForm((f) => ({ ...f, nationality: e.target.value.toUpperCase() }))} /></label>
            <label className="f">Passport no.<input value={form.passportNumber} onChange={(e) => setForm((f) => ({ ...f, passportNumber: e.target.value.toUpperCase() }))} /></label>
            <label className="f">Passport expiry<input type="date" value={form.passportExpiry} onChange={(e) => setForm((f) => ({ ...f, passportExpiry: e.target.value }))} /></label>
            <label className="f">Mobile<input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} /></label>
            <label className="f">Email<input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} /></label>
            <label className="f">Group / family<input value={form.groupName} placeholder="e.g. Nair family" onChange={(e) => setForm((f) => ({ ...f, groupName: e.target.value }))} /></label>
          </div>
          <div className="row"><button className="btn primary" disabled={busy}>Save</button><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button></div>
        </form>
      )}
      <input className="in" style={{ maxWidth: 320, marginBottom: 12 }} placeholder="Search name, group or phone" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="card flush">
        {!rows ? <p className="empty"><span className="spin" /> Loading…</p> : rows.length === 0 ? <p className="empty">No travellers saved yet. They&apos;re saved automatically when you book.</p> : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Name</th><th>Type</th><th>Passport</th><th>Contact</th><th>Group</th><th /></tr></thead>
            <tbody>{rows.map((t) => (
              <tr key={t.id}>
                <td><b>{t.firstName} {t.lastName}</b><div className="muted small">{t.dob ? `Born ${fmtDate(t.dob)}` : ""}</div></td>
                <td className="small">{t.type.toLowerCase()}</td>
                <td className="small">{t.passportNumber ?? "—"}{t.passportExpiry && <div className={soon(t.passportExpiry) ? "err" : "muted"}>exp {fmtDate(t.passportExpiry)}{soon(t.passportExpiry) ? " ⚠" : ""}</div>}</td>
                <td className="small">{t.phone}<div className="muted">{t.email}</div></td>
                <td className="small">{t.groupName}</td>
                <td className="num"><button className="btn sm" onClick={() => { setForm({ ...empty, ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v ?? ""])) as typeof empty, id: t.id }); setOpen(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Edit</button>{" "}
                  <button className="btn sm danger" onClick={async () => { if (confirm(`Delete ${t.firstName} ${t.lastName}?`)) { await api(`/api/agent/travellers/${t.id}`, { method: "DELETE" }).catch(() => {}); load(); } }}>Delete</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
