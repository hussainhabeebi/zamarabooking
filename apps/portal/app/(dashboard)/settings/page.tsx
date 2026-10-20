"use client";

import { FormEvent, useEffect, useState } from "react";
import { api, fmtDate, money, openFile } from "../../../lib/api";
import { useMe } from "../Shell";

interface Doc { id: string; docType: string; fileName: string; uploadedAt: string; verifiedAt: string | null }
const DOC_LABEL: Record<string, string> = { GST_CERTIFICATE: "GST certificate", PAN: "PAN card", TRADE_LICENSE: "Trade licence", EMIRATES_ID: "Emirates ID", AADHAAR: "Aadhaar", IATA_CERT: "IATA certificate", BANK_PROOF: "Bank proof / cancelled cheque", OTHER: "Other" };

export default function SettingsPage() {
  const { me, reload } = useMe();
  const [f, setF] = useState({ displayName: "", brandColor: "#E31E24", contactPhone: "", contactEmail: "", whatsapp: "", address: "", gstNumber: "", slug: "", miniSite: true, markupType: "FLAT", markupValue: "" });
  const [docs, setDocs] = useState<Doc[]>([]);
  const [docType, setDocType] = useState("GST_CERTIFICATE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const admin = me?.user.role === "AGENT_ADMIN";

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("welcome")) setNotice("Welcome! Your agency is registered. Upload your KYC documents below so we can approve you quickly.");
    api<{ documents: Doc[] }>("/api/agent/documents").then((d) => setDocs(d.documents)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!me) return;
    const s = me.settings;
    setF({ displayName: s.displayName ?? "", brandColor: s.brandColor ?? "#E31E24", contactPhone: s.contactPhone ?? "", contactEmail: s.contactEmail ?? "", whatsapp: me.agent.whatsapp ?? "", address: s.address ?? "", gstNumber: s.gstNumber ?? "", slug: s.slug ?? "", miniSite: s.miniSite !== false, markupType: s.ownMarkup?.type ?? "FLAT", markupValue: s.ownMarkup ? String(s.ownMarkup.value) : "" });
  }, [me]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      await api("/api/agent/me/settings", { method: "PATCH", json: {
        displayName: f.displayName, brandColor: f.brandColor, contactPhone: f.contactPhone, contactEmail: f.contactEmail, whatsapp: f.whatsapp, address: f.address, gstNumber: f.gstNumber,
        slug: f.slug, miniSite: f.miniSite, ownMarkup: Number(f.markupValue) > 0 ? { type: f.markupType, value: Number(f.markupValue) } : null,
      } });
      setNotice("Saved."); reload();
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't save"); } finally { setBusy(false); }
  }

  async function uploadLogo(file?: File) {
    if (!file) return;
    setError("");
    try { const form = new FormData(); form.append("logo", file); await api("/api/agent/me/logo", { method: "POST", body: form }); reload(); setNotice("Logo updated."); }
    catch (err) { setError(err instanceof Error ? err.message : "Upload failed"); }
  }

  async function uploadDoc(file?: File) {
    if (!file) return;
    setError("");
    try {
      const form = new FormData(); form.append("file", file); form.append("docType", docType);
      const d = await api<{ document: Doc }>("/api/agent/documents", { method: "POST", body: form });
      setDocs((x) => [d.document, ...x]); setNotice("Document uploaded — our team will verify it.");
    } catch (err) { setError(err instanceof Error ? err.message : "Upload failed"); }
  }

  // Read after mount: the server render has no window (avoids a hydration mismatch).
  const [portal, setPortal] = useState("");
  useEffect(() => { setPortal(window.location.origin); }, []);
  const cur = me?.agent.currency ?? "INR";

  return (
    <div>
      <div className="page-head"><div><h1>Profile, branding & KYC</h1><p>Your logo and contacts appear on e-tickets, invoices, quotes and your agency page.</p></div></div>
      {notice && <div className="banner ok">{notice}</div>}
      {error && <div className="banner bad">{error}</div>}
      {me && (
        <div className="card">
          <dl className="kv">
            <dt>Agency</dt><dd>{me.agent.businessName} <span className="badge b-grey">{me.agent.status.toLowerCase()}</span></dd>
            <dt>Owner</dt><dd>{me.agent.ownerName}</dd>
            <dt>Login</dt><dd>{me.user.name} · {me.user.email} · {me.user.role.replace("AGENT_", "").toLowerCase()}</dd>
            {me.agent.parentName && <><dt>Parent agency</dt><dd>{me.agent.parentName}</dd></>}
            <dt>Tier</dt><dd>{me.tier.name} · {me.tier.commissionPercent}% commission</dd>
          </dl>
        </div>
      )}

      <form className="card stack" onSubmit={save}>
        <h2>Branding & contacts</h2>
        <div className="row">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {me?.settings.logoUrl ? <img src={me.settings.logoUrl} alt="Logo" style={{ height: 48, border: "1px solid #e5e7eb", borderRadius: 8, padding: 4 }} /> : <span className="muted small">No logo yet</span>}
          {admin && <label className="btn sm" style={{ cursor: "pointer" }}>Upload logo<input type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => { void uploadLogo(e.target.files?.[0]); e.target.value = ""; }} /></label>}
        </div>
        <div className="grid g3">
          <label className="f">Name on tickets<input value={f.displayName} placeholder={me?.agent.businessName} onChange={(e) => setF((x) => ({ ...x, displayName: e.target.value }))} /></label>
          <label className="f">Brand colour<input type="color" value={f.brandColor} onChange={(e) => setF((x) => ({ ...x, brandColor: e.target.value }))} style={{ height: 40, padding: 4 }} /></label>
          <label className="f">GSTIN / TRN<input value={f.gstNumber} onChange={(e) => setF((x) => ({ ...x, gstNumber: e.target.value.toUpperCase() }))} /></label>
          <label className="f">Customer phone<input value={f.contactPhone} onChange={(e) => setF((x) => ({ ...x, contactPhone: e.target.value }))} /></label>
          <label className="f">Customer email<input type="email" value={f.contactEmail} onChange={(e) => setF((x) => ({ ...x, contactEmail: e.target.value }))} /></label>
          <label className="f">WhatsApp (alerts from us)<input value={f.whatsapp} onChange={(e) => setF((x) => ({ ...x, whatsapp: e.target.value }))} /></label>
        </div>
        <label className="f">Address<input value={f.address} onChange={(e) => setF((x) => ({ ...x, address: e.target.value }))} /></label>

        <h2 style={{ marginTop: 8 }}>Your selling markup</h2>
        <p className="small muted" style={{ margin: 0 }}>Added on top of your net price to show your <b>selling price</b> in search, quotes and on your agency page. You still pay the net price.</p>
        <div className="row">
          <select className="in" style={{ width: 200 }} value={f.markupType} onChange={(e) => setF((x) => ({ ...x, markupType: e.target.value }))}><option value="FLAT">Flat per booking ({cur})</option><option value="PERCENTAGE">Percentage of fare</option></select>
          <input className="in" style={{ width: 140 }} type="number" min={0} step="0.01" value={f.markupValue} placeholder="0 = none" onChange={(e) => setF((x) => ({ ...x, markupValue: e.target.value }))} />
          {Number(f.markupValue) > 0 && <span className="small muted">e.g. net {money(10000, cur)} → sell {money(f.markupType === "FLAT" ? 10000 + Number(f.markupValue) : 10000 * (1 + Number(f.markupValue) / 100), cur)}</span>}
        </div>

        <h2 style={{ marginTop: 8 }}>Your agency page</h2>
        <p className="small muted" style={{ margin: 0 }}>A branded page where your customers search flights at your selling prices and send you enquiries on WhatsApp.</p>
        <div className="row">
          <span className="muted small">{portal}/a/</span>
          <input className="in" style={{ width: 220 }} value={f.slug} placeholder="your-agency" onChange={(e) => setF((x) => ({ ...x, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }))} />
          <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={f.miniSite} onChange={(e) => setF((x) => ({ ...x, miniSite: e.target.checked }))} /> Page on</label>
          {me?.settings.slug && f.miniSite && me.agent.status === "APPROVED" && <a className="btn sm" href={`/a/${me.settings.slug}`} target="_blank" rel="noopener">Open page ↗</a>}
        </div>
        {me?.agent.status !== "APPROVED" && <p className="small muted" style={{ margin: 0 }}>Your page goes live once your agency is approved.</p>}
        {admin ? <button className="btn primary" disabled={busy} style={{ alignSelf: "flex-start" }}>{busy ? "Saving…" : "Save settings"}</button> : <p className="small muted">Only the agency admin can change settings.</p>}
      </form>

      <div className="card">
        <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
          <h2 style={{ margin: 0 }}>Agency MOU</h2>
          <span className="row" style={{ gap: 8 }}>
            <button className="btn sm" onClick={() => openFile("/api/agent/mou/print").catch((e) => setError(e.message))}>🖨 View / download</button>
            {!me?.onboarding?.mou.accepted && <a className="btn sm primary" href="/onboarding">Review &amp; sign</a>}
          </span>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          {me?.onboarding?.mou.accepted
            ? `Signed by ${me.onboarding.mou.acceptedBy} on ${new Date(me.onboarding.mou.acceptedAt!).toLocaleDateString("en-GB")}.`
            : "Your Memorandum of Understanding with FlyPoomas is ready to review and sign."}
        </p>
      </div>

      <div className="card">
        <h2>KYC documents</h2>
        <p className="small muted">Upload your business registration (GST / trade licence), owner ID and bank proof. Verified documents are locked.</p>
        {admin && (
          <div className="row" style={{ marginBottom: 12 }}>
            <select className="in" style={{ width: 240 }} value={docType} onChange={(e) => setDocType(e.target.value)}>{Object.entries(DOC_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <label className="btn" style={{ cursor: "pointer" }}>Upload<input type="file" hidden accept="image/*,application/pdf" onChange={(e) => { void uploadDoc(e.target.files?.[0]); e.target.value = ""; }} /></label>
          </div>
        )}
        {docs.length === 0 ? <p className="muted small">No documents uploaded yet.</p> : (
          <div className="table-wrap"><table className="t"><tbody>{docs.map((d) => (
            <tr key={d.id}>
              <td><b>{DOC_LABEL[d.docType] ?? d.docType}</b><div className="muted small">{d.fileName}</div></td>
              <td className="small">{fmtDate(d.uploadedAt)}</td>
              <td>{d.verifiedAt ? <span className="badge b-green">Verified</span> : <span className="badge b-amber">Under review</span>}</td>
              <td className="num">{!d.verifiedAt && admin && <button className="btn sm danger" onClick={async () => { await api(`/api/agent/documents/${d.id}`, { method: "DELETE" }).catch((e) => setError(e.message)); setDocs((x) => x.filter((y) => y.id !== d.id)); }}>Remove</button>}</td>
            </tr>
          ))}</tbody></table></div>
        )}
      </div>
    </div>
  );
}
