"use client";
import { useCallback, useEffect, useState } from "react";
import { adminApi, openAdminFile } from "../../../../lib/files";
import { money, ui } from "../../../../lib/ui";

interface Overview {
  tier: { name: string; commissionPercent: number; suggestedCreditLimit: number; sales: number; next: { name: string; needed: number } | null };
  credit: { balance: number; creditLimit: number; available: number; creditUsed: number; dueAt: string | null; overdue: boolean };
  settings: { frozen?: boolean; frozenReason?: string; gstNumber?: string; slug?: string; displayName?: string };
  team: { id: string; name: string; email: string; role: string; isActive: boolean; lastLoginAt: string | null; hasPassword?: boolean }[];
  documents: { id: string; docType: string; fileName: string; uploadedAt: string; verifiedAt: string | null }[];
  subAgents: { id: string; businessName: string; status: string }[];
  walletCurrency: string;
  email: string;
  onboarding: {
    enforce: boolean; kycDone: boolean; complete: boolean;
    required: { type: string; label: string; status: "MISSING" | "UPLOADED" | "VERIFIED" }[];
    mou: { required: boolean; version: string; accepted: boolean; acceptedAt: string | null; acceptedBy: string | null };
  } | null;
}
type ResetResult = { email: string; link?: string; temporaryPassword?: string; created?: boolean };

// Agency programme controls on the admin agency page.
export default function AgentControls({ agentId }: { agentId: string }) {
  const [o, setO] = useState<Overview | null>(null);
  const [credit, setCredit] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState<ResetResult | null>(null);

  const load = useCallback(() => adminApi<Overview>(`/api/admin/agent-program/agents/${agentId}`).then((d) => { setO(d); setCredit(String(d.credit.creditLimit)); }).catch((e) => setError(e.message)), [agentId]);
  useEffect(() => { load(); }, [load]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); setNotice(ok); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Failed"); } finally { setBusy(false); }
  }

  async function resetPassword(mode: "link" | "temporary", userId?: string) {
    if (mode === "temporary" && !confirm("Set a new temporary password? The current password stops working.")) return;
    setBusy(true); setError(""); setNotice(""); setReset(null);
    try {
      const r = await adminApi<ResetResult>(`/api/admin/agent-program/agents/${agentId}/password-reset`, { method: "POST", body: JSON.stringify({ mode, ...(userId ? { userId } : {}) }) });
      setReset(r);
      setNotice(mode === "link" ? `Reset link emailed to ${r.email}${r.created ? " (login created)" : ""}.` : `Temporary password set for ${r.email}${r.created ? " (login created)" : ""}.`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed"); } finally { setBusy(false); }
  }
  const copy = (t: string) => { void navigator.clipboard?.writeText(t); setNotice("Copied."); };

  if (!o) return error ? <div style={ui.err}>{error}</div> : null;
  const cur = o.walletCurrency;

  return (
    <>
      {error && <div style={ui.err}>{error}</div>}
      {notice && <div style={ui.ok}>{notice}</div>}
      <div style={ui.card}>
        <h2 style={ui.h2}>Wallet, credit & tier</h2>
        <dl style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: "8px 12px", fontSize: 13, margin: 0, color: "#e2e8f0" }}>
          <dt style={{ color: "#64748b" }}>Balance</dt><dd style={{ margin: 0, color: o.credit.balance < 0 ? "#f87171" : undefined }}>{money(o.credit.balance, cur)}</dd>
          <dt style={{ color: "#64748b" }}>Available to book</dt><dd style={{ margin: 0 }}>{money(o.credit.available, cur)}</dd>
          <dt style={{ color: "#64748b" }}>Credit used</dt><dd style={{ margin: 0, color: o.credit.overdue ? "#f87171" : undefined }}>{money(o.credit.creditUsed, cur)}{o.credit.dueAt ? ` · due ${new Date(o.credit.dueAt).toLocaleDateString("en-IN")}${o.credit.overdue ? " (OVERDUE — bookings blocked)" : ""}` : ""}</dd>
          <dt style={{ color: "#64748b" }}>Tier</dt><dd style={{ margin: 0 }}>{o.tier.name} · {o.tier.commissionPercent}% commission · sales {money(o.tier.sales, cur)}{o.tier.next ? ` · ${money(o.tier.next.needed, cur)} to ${o.tier.next.name}` : ""}</dd>
          {o.settings.gstNumber && <><dt style={{ color: "#64748b" }}>GSTIN / TRN</dt><dd style={{ margin: 0 }}>{o.settings.gstNumber}</dd></>}
          {o.settings.slug && <><dt style={{ color: "#64748b" }}>Agency page</dt><dd style={{ margin: 0 }}>/a/{o.settings.slug}</dd></>}
        </dl>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 14 }}>
          <label style={ui.label}>Credit limit ({cur}){o.tier.suggestedCreditLimit ? ` · tier suggests ${money(o.tier.suggestedCreditLimit, cur)}` : ""}
            <input style={{ ...ui.input, width: 180 }} type="number" min={0} value={credit} onChange={(e) => setCredit(e.target.value)} /></label>
          <button style={ui.btn} disabled={busy} onClick={() => run(() => adminApi(`/api/admin/agent-program/agents/${agentId}/credit`, { method: "PATCH", body: JSON.stringify({ creditLimit: Number(credit) || 0 }) }), "Credit limit saved.")}>Save credit limit</button>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 14 }}>
          {o.settings.frozen ? (
            <>
              <span style={{ color: "#f87171", fontWeight: 700, fontSize: 13 }}>Bookings frozen{o.settings.frozenReason ? `: ${o.settings.frozenReason}` : ""}</span>
              <button style={ui.ghost} disabled={busy} onClick={() => run(() => adminApi(`/api/admin/agent-program/agents/${agentId}/freeze`, { method: "PATCH", body: JSON.stringify({ frozen: false }) }), "Agency unfrozen.")}>Unfreeze</button>
            </>
          ) : (
            <>
              <label style={ui.label}>Freeze reason (shown to agency)<input style={{ ...ui.input, width: 260 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Overdue payment" /></label>
              <button style={ui.ghost} disabled={busy} onClick={() => { if (confirm("Freeze bookings for this agency?")) void run(() => adminApi(`/api/admin/agent-program/agents/${agentId}/freeze`, { method: "PATCH", body: JSON.stringify({ frozen: true, reason: reason || undefined }) }), "Agency frozen."); }}>Freeze bookings</button>
            </>
          )}
          <a href={`/agent-program?tab=audit&entityId=${agentId}`} style={{ color: "#93c5fd", fontSize: 13 }}>Audit trail →</a>
        </div>
      </div>

      {o.onboarding && (
        <div style={ui.card}>
          <h2 style={ui.h2}>Onboarding {o.onboarding.complete ? <span style={{ color: "#4ade80", fontSize: 12 }}>· complete</span> : <span style={{ color: "#fbbf24", fontSize: 12 }}>· not finished</span>}</h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            {o.onboarding.required.map((r) => (
              <span key={r.type} style={{ ...ui.text, fontSize: 12, padding: "4px 10px", borderRadius: 999, border: "1px solid #334155",
                color: r.status === "VERIFIED" ? "#4ade80" : r.status === "UPLOADED" ? "#93c5fd" : "#fca5a5" }}>
                {r.status === "VERIFIED" ? "✓" : r.status === "UPLOADED" ? "•" : "✗"} {r.label}
              </span>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", ...ui.text }}>
            <span>MOU v{o.onboarding.mou.version}: {o.onboarding.mou.accepted ? <b style={{ color: "#4ade80" }}>signed by {o.onboarding.mou.acceptedBy} on {new Date(o.onboarding.mou.acceptedAt!).toLocaleString("en-GB")}</b> : <b style={{ color: "#fbbf24" }}>not signed</b>}</span>
            <button style={ui.ghost} onClick={() => openAdminFile(`/api/admin/agent-program/agents/${agentId}/mou`).catch((e) => setError(e.message))}>{o.onboarding.mou.accepted ? "View signed MOU" : "Preview MOU"}</button>
            {o.onboarding.mou.accepted && <button style={ui.ghost} disabled={busy} onClick={() => { if (confirm("Ask this agency to review and sign the MOU again?")) void run(() => adminApi(`/api/admin/agent-program/agents/${agentId}/mou/reset`, { method: "POST" }), "The agency will be asked to sign again."); }}>Ask to sign again</button>}
          </div>
        </div>
      )}

      <div style={ui.card}>
        <h2 style={ui.h2}>KYC documents</h2>
        {o.documents.length === 0 ? <p style={ui.muted}>No documents uploaded yet.</p> : o.documents.map((d) => (
          <div key={d.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", padding: "6px 0", borderBottom: "1px solid #1f2a3c", ...ui.text }}>
            <span>{d.docType.replace(/_/g, " ").toLowerCase()} · {d.fileName}</span>
            <span style={{ display: "flex", gap: 6 }}>
              <button style={ui.ghost} onClick={() => openAdminFile(`/api/admin/agent-program/documents/${d.id}/file`).catch((e) => setError(e.message))}>View</button>
              <button style={d.verifiedAt ? ui.ghost : ui.btn} disabled={busy} onClick={() => run(() => adminApi(`/api/admin/agent-program/documents/${d.id}/verify`, { method: "PATCH", body: JSON.stringify({ verified: !d.verifiedAt }) }), d.verifiedAt ? "Marked unverified." : "Document verified.")}>{d.verifiedAt ? "✓ Verified" : "Verify"}</button>
            </span>
          </div>
        ))}
      </div>

      <div style={ui.card}>
        <h2 style={ui.h2}>Logins, passwords & sub-agents</h2>
        {o.team.map((u) => (
          <div key={u.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #1f2a3c" }}>
            <span style={ui.text}>{u.name} · {u.email} · {u.role.replace("AGENT_", "").toLowerCase()}{u.isActive ? "" : " (disabled)"}{" "}
              <span style={ui.muted}>{!u.hasPassword ? "no password set" : u.lastLoginAt ? `last in ${new Date(u.lastLoginAt).toLocaleDateString("en-IN")}` : "never signed in"}</span></span>
            <span style={{ display: "flex", gap: 6 }}>
              <button style={ui.ghost} disabled={busy} onClick={() => resetPassword("link", u.id)}>Email reset link</button>
              <button style={ui.ghost} disabled={busy} onClick={() => resetPassword("temporary", u.id)}>Set temporary password</button>
            </span>
          </div>
        ))}
        {o.team.length === 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={ui.muted}>No login yet (invitation not accepted). Create one for {o.email}:</span>
            <button style={ui.btn} disabled={busy} onClick={() => resetPassword("link")}>Create login & email link</button>
            <button style={ui.ghost} disabled={busy} onClick={() => resetPassword("temporary")}>Create login with temporary password</button>
          </div>
        )}
        {reset && (reset.temporaryPassword || reset.link) && (
          <div style={{ ...ui.ok, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {reset.temporaryPassword ? (
              <>Temporary password for {reset.email}: <b style={{ fontFamily: "monospace", fontSize: 15, color: "#f1f5f9" }}>{reset.temporaryPassword}</b>
                <button style={ui.ghost} onClick={() => copy(reset.temporaryPassword!)}>Copy</button>
                <span style={ui.muted}>Shown once — share it securely and ask them to change it (Forgot password).</span></>
            ) : (
              <>Reset link for {reset.email} (valid 1 hour): <button style={ui.ghost} onClick={() => copy(reset.link!)}>Copy link</button></>
            )}
          </div>
        )}
        {o.subAgents.length > 0 && <div style={{ marginTop: 10, ...ui.text }}>Sub-agents: {o.subAgents.map((s, i) => <span key={s.id}>{i ? ", " : ""}<a href={`/agents/${s.id}`} style={{ color: "#93c5fd" }}>{s.businessName}</a> ({s.status.toLowerCase()})</span>)}</div>}
      </div>
    </>
  );
}
