"use client";
import { useEffect, useState } from "react";
import { adminApi } from "../../../lib/files";
import { ui } from "../../../lib/ui";

// KYC documents each agency must upload after first sign-in, and the details
// printed on the automatically generated agency MOU.
interface Cfg {
  enforce: boolean;
  kycRequired: { INDIA: string[]; GCC: string[] };
  requireMou: boolean;
  mouVersion: string;
  company: { legalName: string; address: string; registration: string; email: string; phone: string; signatory: string; signatoryTitle: string };
  extraClauses: string;
  governingLaw: { INDIA: string; GCC: string };
}

export default function OnboardingSettings() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    adminApi<{ config: Cfg; docTypes: string[]; labels: Record<string, string> }>("/api/admin/agent-program/onboarding")
      .then((d) => { setCfg(d.config); setTypes(d.docTypes); setLabels(d.labels); }).catch((e) => setError(e.message));
  }, []);

  async function save(bumpVersion = false) {
    if (!cfg) return;
    setError(""); setNotice("");
    const next = bumpVersion ? { ...cfg, mouVersion: String((Number(cfg.mouVersion) || 1) + 1) } : cfg;
    if (bumpVersion && !confirm(`Publish MOU version ${next.mouVersion}? Every agency will be asked to sign again.`)) return;
    try {
      const d = await adminApi<{ config: Cfg }>("/api/admin/agent-program/onboarding", { method: "PUT", body: JSON.stringify(next) });
      setCfg(d.config); setNotice(bumpVersion ? `MOU version ${d.config.mouVersion} published.` : "Onboarding settings saved.");
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't save"); }
  }
  if (!cfg) return error ? <div style={ui.err}>{error}</div> : <div style={ui.card}>Loading…</div>;

  const toggleDoc = (region: "INDIA" | "GCC", t: string) => setCfg((c) => c && {
    ...c, kycRequired: { ...c.kycRequired, [region]: c.kycRequired[region].includes(t) ? c.kycRequired[region].filter((x) => x !== t) : [...c.kycRequired[region], t] },
  });
  const co = (k: keyof Cfg["company"], label: string, wide = false) => (
    <label style={{ ...ui.label, ...(wide ? { gridColumn: "1 / -1" } : {}) }}>{label}
      <input style={ui.input} value={cfg.company[k]} onChange={(e) => setCfg((c) => c && { ...c, company: { ...c.company, [k]: e.target.value } })} /></label>
  );

  return (
    <>
      {error && <div style={ui.err}>{error}</div>}
      {notice && <div style={ui.ok}>{notice}</div>}
      <div style={ui.card}>
        <h2 style={ui.h2}>After first sign-in</h2>
        <label style={{ ...ui.text, display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={cfg.enforce} onChange={(e) => setCfg({ ...cfg, enforce: e.target.checked })} />
          Send agency admins to the onboarding page until documents are uploaded and the MOU is signed
        </label>
        <label style={{ ...ui.text, display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <input type="checkbox" checked={cfg.requireMou} onChange={(e) => setCfg({ ...cfg, requireMou: e.target.checked })} />
          Agencies must sign the MOU
        </label>
        {(["INDIA", "GCC"] as const).map((region) => (
          <div key={region} style={{ marginTop: 14 }}>
            <div style={{ ...ui.muted, marginBottom: 6 }}>Required KYC documents — {region === "INDIA" ? "Indian agencies" : "GCC & other agencies"}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {types.filter((t) => t !== "OTHER").map((t) => (
                <button key={t} type="button" style={ui.chip(cfg.kycRequired[region].includes(t))} onClick={() => toggleDoc(region, t)}>{labels[t] ?? t}</button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div style={ui.card}>
        <h2 style={ui.h2}>MOU details <span style={ui.muted}>· current version {cfg.mouVersion}</span></h2>
        <p style={{ ...ui.muted, marginTop: 0 }}>The MOU is generated for each agency from its profile (name, agent number, currency, credit limit and terms) plus these details.</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          {co("legalName", "Company legal name")}
          {co("registration", "Trade licence / CIN / GSTIN")}
          {co("address", "Registered address", true)}
          {co("email", "Contact email")}
          {co("phone", "Contact phone")}
          {co("signatory", "Authorised signatory")}
          {co("signatoryTitle", "Signatory designation")}
          <label style={ui.label}>Governing law — Indian agencies
            <input style={ui.input} value={cfg.governingLaw.INDIA} onChange={(e) => setCfg({ ...cfg, governingLaw: { ...cfg.governingLaw, INDIA: e.target.value } })} /></label>
          <label style={ui.label}>Governing law — GCC agencies
            <input style={ui.input} value={cfg.governingLaw.GCC} onChange={(e) => setCfg({ ...cfg, governingLaw: { ...cfg.governingLaw, GCC: e.target.value } })} /></label>
        </div>
        <label style={{ ...ui.label, marginTop: 12 }}>Additional clauses (one per line)
          <textarea style={{ ...ui.input, minHeight: 90, fontFamily: "inherit" }} value={cfg.extraClauses} onChange={(e) => setCfg({ ...cfg, extraClauses: e.target.value })} /></label>
        <p style={ui.muted}>Have your legal adviser review the MOU wording before agencies sign it. Changing these details only affects agencies that haven&apos;t signed yet; publish a new version to ask everyone to sign again.</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={ui.btn} onClick={() => save(false)}>Save onboarding settings</button>
          <button style={ui.ghost} onClick={() => save(true)}>Save & publish new MOU version</button>
        </div>
      </div>
    </>
  );
}
