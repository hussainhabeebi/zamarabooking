"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, openFile, type Onboarding } from "../../../lib/api";
import { useMe } from "../Shell";

// First sign-in: upload the required KYC documents and sign the MOU.
interface Mou { accepted: boolean; html: string; version: string; ref?: string; hash?: string; acceptance?: { name: string; designation: string; acceptedAt: string } }

export default function OnboardingPage() {
  const { me, reload } = useMe();
  const [ob, setOb] = useState<Onboarding | null>(null);
  const [mou, setMou] = useState<Mou | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sign, setSign] = useState({ name: "", designation: "Owner", agree: false });
  const isAdmin = me?.user.role === "AGENT_ADMIN";

  const load = useCallback(() => {
    api<Onboarding>("/api/agent/onboarding").then(setOb).catch((e) => setError(e.message));
    api<Mou>("/api/agent/mou").then(setMou).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (me && !sign.name) setSign((s) => ({ ...s, name: me.agent.ownerName })); }, [me]); // eslint-disable-line react-hooks/exhaustive-deps

  async function upload(type: string, file: File | null) {
    if (!file) return;
    setBusy(type); setError(""); setNotice("");
    try {
      const form = new FormData(); form.append("file", file); form.append("docType", type);
      await api("/api/agent/documents", { method: "POST", body: form });
      setNotice("Document uploaded."); load();
    } catch (err) { setError(err instanceof Error ? err.message : "Upload failed"); } finally { setBusy(""); }
  }

  async function accept(e: FormEvent) {
    e.preventDefault();
    if (!mou?.hash) return;
    setBusy("mou"); setError(""); setNotice("");
    try {
      await api("/api/agent/mou/accept", { json: { name: sign.name.trim(), designation: sign.designation.trim(), agree: sign.agree, hash: mou.hash } });
      setNotice("MOU signed. A copy has been emailed to you."); load(); reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign the MOU");
      load();   // the MOU may have changed: show the latest version
    } finally { setBusy(""); }
  }

  const kycLeft = ob?.required.filter((r) => r.status === "MISSING").length ?? 0;
  const done = ob?.complete;

  return (
    <div style={{ maxWidth: 920 }}>
      <div className="page-head"><div>
        <h1>Welcome to FlyPoomas{me ? `, ${me.agent.businessName}` : ""}</h1>
        <p>Two quick steps to activate your agency: upload your KYC documents and sign the agency MOU.</p>
      </div></div>
      {notice && <div className="banner ok">{notice}</div>}
      {error && <div className="banner bad">{error}</div>}
      {!isAdmin && me && <div className="banner warn">Only your agency admin can upload documents and sign the MOU.</div>}

      {done && (
        <div className="card" style={{ textAlign: "center" }}>
          <h2 style={{ marginTop: 0 }}>✅ Your agency is set up</h2>
          <p className="muted">Documents uploaded and MOU signed. {me?.agent.status === "PENDING" ? "Our team will verify your documents and approve your agency shortly." : ""}</p>
          <a className="btn primary" href="/dashboard">Go to dashboard</a>
        </div>
      )}

      <section className="card stack">
        <div className="row between"><h2 style={{ margin: 0 }}>1. KYC documents</h2>
          <span className={`badge ${ob?.kycDone ? "b-green" : "b-amber"}`}>{ob?.kycDone ? "Done" : `${kycLeft} to upload`}</span></div>
        <p className="small muted" style={{ margin: 0 }}>Clear photo or PDF, up to 8 MB each. Verified documents are locked; you can replace unverified ones in Profile &amp; KYC.</p>
        {!ob ? <p className="muted">Loading…</p> : ob.required.map((r) => (
          <div key={r.type} className="row between" style={{ borderTop: "1px solid var(--line, #e5e7eb)", paddingTop: 10, flexWrap: "wrap", gap: 8 }}>
            <div><b>{r.label}</b><div className="small muted">{r.status === "VERIFIED" ? "Verified ✓" : r.status === "UPLOADED" ? "Uploaded — waiting for verification" : "Required"}</div></div>
            {r.status === "MISSING" ? (
              <label className="btn sm primary" style={{ cursor: isAdmin ? "pointer" : "not-allowed", opacity: isAdmin ? 1 : 0.5 }}>
                {busy === r.type ? "Uploading…" : "Upload"}
                <input type="file" hidden disabled={!isAdmin || !!busy} accept="image/*,application/pdf" onChange={(e) => upload(r.type, e.target.files?.[0] ?? null)} />
              </label>
            ) : <span className={`badge ${r.status === "VERIFIED" ? "b-green" : "b-grey"}`}>{r.status === "VERIFIED" ? "Verified" : "Uploaded"}</span>}
          </div>
        ))}
      </section>

      {ob?.mou.required !== false && (
        <section className="card stack">
          <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}><h2 style={{ margin: 0 }}>2. Agency MOU</h2>
            <span className="row" style={{ gap: 8 }}>
              <button className="btn sm" type="button" onClick={() => openFile("/api/agent/mou/print").catch((e) => setError(e.message))}>🖨 View / print</button>
              <span className={`badge ${mou?.accepted ? "b-green" : "b-amber"}`}>{mou?.accepted ? "Signed" : "To sign"}</span>
            </span></div>
          <p className="small muted" style={{ margin: 0 }}>Generated from your agency details. Read it, then sign below. You can download a copy any time from Profile &amp; KYC.</p>
          <div style={{ maxHeight: 420, overflow: "auto", border: "1px solid var(--line, #e5e7eb)", borderRadius: 10, padding: 16, background: "#fff" }}
            dangerouslySetInnerHTML={{ __html: mou?.html ?? "<p>Loading…</p>" }} />
          {mou && !mou.accepted && (
            <form onSubmit={accept} className="stack">
              <div className="grid g2">
                <label className="f">Your full name<input required minLength={3} value={sign.name} onChange={(e) => setSign((s) => ({ ...s, name: e.target.value }))} disabled={!isAdmin} /></label>
                <label className="f">Designation<input required value={sign.designation} onChange={(e) => setSign((s) => ({ ...s, designation: e.target.value }))} disabled={!isAdmin} /></label>
              </div>
              <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                <input type="checkbox" checked={sign.agree} onChange={(e) => setSign((s) => ({ ...s, agree: e.target.checked }))} disabled={!isAdmin} style={{ marginTop: 3 }} />
                <span className="small">I have read this MOU and accept it on behalf of <b>{me?.agent.businessName}</b>. I am authorised to sign for the agency.</span>
              </label>
              <button className="btn primary" disabled={!isAdmin || !sign.agree || busy === "mou"}>{busy === "mou" ? "Signing…" : "Sign MOU electronically"}</button>
            </form>
          )}
          {mou?.accepted && mou.acceptance && (
            <p className="small" style={{ margin: 0 }}>Signed by <b>{mou.acceptance.name}</b> ({mou.acceptance.designation}) on {new Date(mou.acceptance.acceptedAt).toLocaleString("en-GB")}.</p>
          )}
        </section>
      )}
    </div>
  );
}
