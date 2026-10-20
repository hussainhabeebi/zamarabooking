"use client";
import { useEffect, useState } from "react";
import { adminApi } from "../../../lib/files";
import { money, ui } from "../../../lib/ui";
import OnboardingSettings from "./OnboardingSettings";

interface Tier { name: string; minMonthlySales: number; commissionPercent: number; suggestedCreditLimit: number }
interface Config { tiers: Tier[]; creditDays: number; maxBookingsPerHour: number; blockDuplicates: boolean; lowBalanceAlert: number; supportSlaHours: number }
interface Analytics { agents: { agentId: string; name: string; status: string; bookings: number; sales: number; margin: number; cancelled: number; failed: number; cancellationRate: number }[]; topRoutes: { origin: string; destination: string; n: number; sales: number }[] }
interface Audit { id: string; action: string; entity: string; entityId: string | null; before: unknown; after: unknown; createdAt: string; userName: string | null; userEmail: string | null; ipAddress: string | null }

const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1)).toISOString().slice(0, 10); };

export default function AgentProgramPage() {
  const [tab, setTab] = useState<"settings" | "analytics" | "audit" | "onboarding">("analytics");
  const [cfg, setCfg] = useState<Config | null>(null);
  const [an, setAn] = useState<Analytics | null>(null);
  const [audit, setAudit] = useState<Audit[] | null>(null);
  const [range, setRange] = useState({ from: monthStart(), to: new Date().toISOString().slice(0, 10) });
  const [auditFilter, setAuditFilter] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("tab") === "audit") { setTab("audit"); setAuditFilter(q.get("entityId") ?? ""); }
    if (q.get("tab") === "onboarding") setTab("onboarding");
    adminApi<{ config: Config }>("/api/admin/agent-program/config").then((d) => setCfg(d.config)).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { if (tab === "analytics") { setAn(null); adminApi<Analytics>(`/api/admin/agent-program/analytics?from=${range.from}&to=${range.to}`).then(setAn).catch((e) => setError(e.message)); } }, [tab, range]);
  useEffect(() => { if (tab === "audit") { setAudit(null); adminApi<{ entries: Audit[] }>(`/api/admin/agent-program/audit${auditFilter ? `?entityId=${encodeURIComponent(auditFilter)}` : ""}`).then((d) => setAudit(d.entries)).catch((e) => setError(e.message)); } }, [tab, auditFilter]);

  async function save() {
    if (!cfg) return;
    setError(""); setNotice("");
    try { const d = await adminApi<{ config: Config }>("/api/admin/agent-program/config", { method: "PUT", body: JSON.stringify(cfg) }); setCfg(d.config); setNotice("Programme saved."); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't save"); }
  }
  const setTier = (i: number, patch: Partial<Tier>) => setCfg((c) => c && { ...c, tiers: c.tiers.map((t, n) => n === i ? { ...t, ...patch } : t) });

  return (
    <div>
      <h1 style={ui.h1}>Agent programme</h1>
      <p style={ui.sub}>Tiers and commission, credit terms, risk limits, agency performance and the audit trail.</p>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {(["analytics", "settings", "onboarding", "audit"] as const).map((t) => <button key={t} style={ui.chip(tab === t)} onClick={() => setTab(t)}>{t === "analytics" ? "Performance" : t === "settings" ? "Settings" : t === "onboarding" ? "KYC & MOU" : "Audit trail"}</button>)}
      </div>
      {error && <div style={ui.err}>{error}</div>}
      {notice && <div style={ui.ok}>{notice}</div>}

      {tab === "onboarding" && <OnboardingSettings />}

      {tab === "settings" && cfg && (
        <>
          <div style={ui.card}>
            <h2 style={ui.h2}>Tiers (by monthly confirmed sales)</h2>
            <p style={{ ...ui.muted, marginTop: 0 }}>An agency&apos;s tier uses the higher of this or last month&apos;s sales. Commission is a % of the supplier fare, paid to the agency wallet when the ticket is issued.</p>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={ui.th}>Name</th><th style={ui.th}>From monthly sales (₹)</th><th style={ui.th}>Commission %</th><th style={ui.th}>Suggested credit limit</th><th style={ui.th} /></tr></thead>
              <tbody>{cfg.tiers.map((t, i) => (
                <tr key={i}>
                  <td style={ui.td}><input style={ui.input} value={t.name} onChange={(e) => setTier(i, { name: e.target.value })} /></td>
                  <td style={ui.td}><input style={ui.input} type="number" min={0} value={t.minMonthlySales} onChange={(e) => setTier(i, { minMonthlySales: Number(e.target.value) })} /></td>
                  <td style={ui.td}><input style={{ ...ui.input, width: 90 }} type="number" min={0} max={10} step="0.05" value={t.commissionPercent} onChange={(e) => setTier(i, { commissionPercent: Number(e.target.value) })} /></td>
                  <td style={ui.td}><input style={ui.input} type="number" min={0} value={t.suggestedCreditLimit} onChange={(e) => setTier(i, { suggestedCreditLimit: Number(e.target.value) })} /></td>
                  <td style={ui.td}>{cfg.tiers.length > 1 && <button style={ui.ghost} onClick={() => setCfg((c) => c && { ...c, tiers: c.tiers.filter((_, n) => n !== i) })}>Remove</button>}</td>
                </tr>
              ))}</tbody>
            </table>
            {cfg.tiers.length < 8 && <button style={{ ...ui.ghost, marginTop: 10 }} onClick={() => setCfg((c) => c && { ...c, tiers: [...c.tiers, { name: "New tier", minMonthlySales: (c.tiers.at(-1)?.minMonthlySales ?? 0) + 1_000_000, commissionPercent: 0, suggestedCreditLimit: 0 }] })}>+ Add tier</button>}
          </div>
          <div style={ui.card}>
            <h2 style={ui.h2}>Credit & risk</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
              <label style={ui.label}>Credit to be repaid within (days)<input style={ui.input} type="number" min={1} value={cfg.creditDays} onChange={(e) => setCfg({ ...cfg, creditDays: Number(e.target.value) })} /></label>
              <label style={ui.label}>Max bookings per agency per hour<input style={ui.input} type="number" min={1} value={cfg.maxBookingsPerHour} onChange={(e) => setCfg({ ...cfg, maxBookingsPerHour: Number(e.target.value) })} /></label>
              <label style={ui.label}>Low-balance alert below (₹)<input style={ui.input} type="number" min={0} value={cfg.lowBalanceAlert} onChange={(e) => setCfg({ ...cfg, lowBalanceAlert: Number(e.target.value) })} /></label>
              <label style={ui.label}>Reply target for requests (hours)<input style={ui.input} type="number" min={1} value={cfg.supportSlaHours} onChange={(e) => setCfg({ ...cfg, supportSlaHours: Number(e.target.value) })} /></label>
              <label style={{ ...ui.label, flexDirection: "row", alignItems: "center", gap: 8 }}><input type="checkbox" checked={cfg.blockDuplicates} onChange={(e) => setCfg({ ...cfg, blockDuplicates: e.target.checked })} /> Block duplicate bookings (same traveller, route and date within 24 h)</label>
            </div>
          </div>
          <button style={ui.btn} onClick={save}>Save programme</button>
        </>
      )}

      {tab === "analytics" && (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
            <input style={ui.input} type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
            <span style={ui.muted}>to</span>
            <input style={ui.input} type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
          </div>
          {!an ? <p style={ui.muted}>Loading…</p> : (
            <>
              <div style={{ ...ui.card, padding: 0, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr><th style={ui.th}>Agency</th><th style={ui.th}>Bookings</th><th style={ui.th}>Sales</th><th style={ui.th}>Our margin</th><th style={ui.th}>Cancelled</th><th style={ui.th}>Failed</th></tr></thead>
                  <tbody>{an.agents.length === 0 ? <tr><td style={ui.td} colSpan={6}>No agency bookings in this period.</td></tr> : an.agents.map((a) => (
                    <tr key={a.agentId}>
                      <td style={ui.td}><a href={`/agents/${a.agentId}`} style={{ color: "#f1f5f9", fontWeight: 700 }}>{a.name}</a> <span style={ui.muted}>{a.status.toLowerCase()}</span></td>
                      <td style={ui.td}>{a.bookings}</td><td style={ui.td}>{money(a.sales)}</td><td style={ui.td}>{money(a.margin)}</td>
                      <td style={{ ...ui.td, color: a.cancellationRate > 20 ? "#f87171" : ui.td.color }}>{a.cancelled} ({a.cancellationRate}%)</td>
                      <td style={{ ...ui.td, color: a.failed ? "#fbbf24" : ui.td.color }}>{a.failed}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <div style={ui.card}>
                <h2 style={ui.h2}>Top agency routes</h2>
                {an.topRoutes.map((r) => <div key={`${r.origin}${r.destination}`} style={{ ...ui.text, display: "flex", justifyContent: "space-between", padding: "4px 0" }}><span>{r.origin} → {r.destination}</span><span>{r.n} · {money(r.sales)}</span></div>)}
              </div>
            </>
          )}
        </>
      )}

      {tab === "audit" && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input style={{ ...ui.input, width: 320 }} placeholder="Filter by agency / entity id" value={auditFilter} onChange={(e) => setAuditFilter(e.target.value.trim())} />
          </div>
          <div style={{ ...ui.card, padding: 0, overflowX: "auto" }}>
            {!audit ? <p style={{ ...ui.muted, padding: 16 }}>Loading…</p> : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={ui.th}>When</th><th style={ui.th}>Who</th><th style={ui.th}>Action</th><th style={ui.th}>Entity</th><th style={ui.th}>Change</th></tr></thead>
                <tbody>{audit.map((e) => (
                  <tr key={e.id}>
                    <td style={{ ...ui.td, whiteSpace: "nowrap" }}>{new Date(e.createdAt).toLocaleString("en-IN")}</td>
                    <td style={ui.td}>{e.userName ?? "System / service"}<div style={ui.muted}>{e.userEmail ?? ""}{e.ipAddress ? ` · ${e.ipAddress}` : ""}</div></td>
                    <td style={ui.td}>{e.action.replace(/_/g, " ").toLowerCase()}</td>
                    <td style={ui.td}>{e.entity}<div style={ui.muted}>{e.entityId?.slice(0, 8)}</div></td>
                    <td style={{ ...ui.td, fontFamily: "monospace", fontSize: 11, maxWidth: 360, wordBreak: "break-word" }}>{e.before ? `${JSON.stringify(e.before)} → ` : ""}{JSON.stringify(e.after)}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
