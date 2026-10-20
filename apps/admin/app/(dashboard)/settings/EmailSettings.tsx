"use client";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "../../../lib/files";
import { ui } from "../../../lib/ui";

// Resend email: sender, reply-to, operations copy, API key, test send and log.
type Settings = { enabled: boolean; apiKey: string; fromName: string; fromEmail: string; replyTo: string; bccOps: string };
type Overview = { settings: Settings; apiKeyMasked: string; keySource: "admin" | "secret" | "none"; defaultFrom: string; last7Days: { sent: number; failed: number; skipped: number } };
type Log = { id: string; toEmail: string; subject: string; category: string; status: string; providerId: string | null; error: string | null; createdAt: string };

const STATUS_COLOR: Record<string, string> = { SENT: "#4ade80", FAILED: "#f87171", SKIPPED: "#fbbf24" };

export default function EmailSettings() {
  const [o, setO] = useState<Overview | null>(null);
  const [s, setS] = useState<Settings | null>(null);
  const [newKey, setNewKey] = useState("");
  const [testTo, setTestTo] = useState("");
  const [logs, setLogs] = useState<Log[] | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    adminApi<Overview>("/api/admin/settings/email").then((d) => { setO(d); setS(d.settings); }).catch((e) => setError(e.message));
    adminApi<{ logs: Log[] }>(`/api/admin/settings/email/logs${filter ? `?status=${filter}` : ""}`).then((d) => setLogs(d.logs)).catch(() => setLogs([]));
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  async function run(name: string, fn: () => Promise<unknown>, done: string) {
    setBusy(name); setError(""); setMsg("");
    try { await fn(); setMsg(done); load(); } catch (e) { setError(e instanceof Error ? e.message : "Failed"); } finally { setBusy(""); }
  }

  if (!o || !s) return error ? <div style={ui.err}>{error}</div> : <div style={{ color: "#64748b", fontSize: 13 }}>Loading…</div>;
  const field = (k: keyof Settings, label: string, placeholder: string, hint?: string) => (
    <label style={ui.label}>{label}
      <input style={ui.input} value={String(s[k])} placeholder={placeholder} onChange={(e) => setS({ ...s, [k]: e.target.value })} />
      {hint && <span style={{ ...ui.muted, fontWeight: 400 }}>{hint}</span>}
    </label>
  );

  return (
    <div>
      <div style={{ marginBottom: 14, padding: "10px 12px", borderRadius: 8, background: "rgba(14,165,233,.12)", border: "1px solid #0369a1", color: "#bae6fd", fontSize: 13, lineHeight: 1.6 }}>
        All emails go through <b>Resend</b>: booking confirmations with the e-ticket, failed-booking refunds, cancellations and refunds,
        password resets and invitations (customers, agencies, staff), agency approvals, wallet recharges, fare alerts and hold reminders.
        Last 7 days: <b>{o.last7Days.sent}</b> sent · <b style={{ color: o.last7Days.failed ? "#fca5a5" : undefined }}>{o.last7Days.failed}</b> failed · {o.last7Days.skipped} skipped.
      </div>

      <label style={{ ...ui.text, display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> Send emails
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        {field("fromName", "Sender name", "FlyPoomas")}
        {field("fromEmail", "Sender address", o.defaultFrom, "Must be on a domain verified in Resend (Resend → Domains).")}
        {field("replyTo", "Reply-to address", "support@flypoomas.com", "Where customers' replies go.")}
        {field("bccOps", "Copy booking & refund emails to", "ops@flypoomas.com", "Optional operations inbox (BCC).")}
        <label style={ui.label}>Resend API key
          <input style={ui.input} type="password" autoComplete="new-password" value={newKey} placeholder={o.apiKeyMasked || (o.keySource === "secret" ? "Using the RESEND_API_KEY secret" : "re_…")} onChange={(e) => setNewKey(e.target.value)} />
          <span style={{ ...ui.muted, fontWeight: 400 }}>
            {o.keySource === "admin" ? "Saved here. " : o.keySource === "secret" ? "Using the RESEND_API_KEY worker secret. " : "Not set — emails are skipped. "}
            Leave empty to keep it{o.keySource === "admin" ? "; " : "."}
            {o.keySource === "admin" && <button type="button" style={{ background: "none", border: 0, color: "#93c5fd", cursor: "pointer", padding: 0, fontSize: 12 }} onClick={() => setNewKey("-")}>remove saved key</button>}
          </span>
        </label>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
        <button style={ui.btn} disabled={!!busy} onClick={() => run("save", () => adminApi("/api/admin/settings/email", { method: "PUT", body: JSON.stringify({ ...s, apiKey: newKey || undefined }) }).then(() => setNewKey("")), "Email settings saved.")}>
          {busy === "save" ? "Saving…" : "Save email settings"}
        </button>
        <input style={{ ...ui.input, width: 240 }} type="email" placeholder="Send a test to…" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
        <button style={ui.ghost} disabled={!!busy || !testTo} onClick={() => run("test", () => adminApi("/api/admin/settings/email/test", { method: "POST", body: JSON.stringify({ to: testTo }) }), `Test email sent to ${testTo}. Check the inbox (and spam).`)}>
          {busy === "test" ? "Sending…" : "Send test email"}
        </button>
      </div>
      {error && <div style={ui.err}>{error}</div>}
      {msg && <div style={ui.ok}>{msg}</div>}

      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "20px 0 8px" }}>
        <b style={{ color: "#f1f5f9", fontSize: 14 }}>Recent emails</b>
        {["", "SENT", "FAILED", "SKIPPED"].map((f) => <button key={f || "all"} style={ui.chip(filter === f)} onClick={() => setFilter(f)}>{f ? f.toLowerCase() : "all"}</button>)}
      </div>
      <div style={{ overflowX: "auto", border: "1px solid #334155", borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{["When", "To", "Subject", "Type", "Status"].map((h) => <th key={h} style={ui.th}>{h}</th>)}</tr></thead>
          <tbody>
            {!logs && <tr><td style={ui.td} colSpan={5}>Loading…</td></tr>}
            {logs?.length === 0 && <tr><td style={ui.td} colSpan={5}>No emails yet.</td></tr>}
            {logs?.map((l) => (
              <tr key={l.id}>
                <td style={{ ...ui.td, whiteSpace: "nowrap" }}>{new Date(l.createdAt).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}</td>
                <td style={ui.td}>{l.toEmail}</td>
                <td style={ui.td}>{l.subject}{l.error && <div style={{ color: "#fca5a5", fontSize: 12 }}>{l.error}</div>}</td>
                <td style={ui.td}>{l.category}</td>
                <td style={{ ...ui.td, color: STATUS_COLOR[l.status] ?? "#e2e8f0", fontWeight: 700 }}>{l.status.toLowerCase()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
