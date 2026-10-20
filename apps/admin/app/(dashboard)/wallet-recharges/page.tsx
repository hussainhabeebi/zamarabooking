"use client";
import { useCallback, useEffect, useState } from "react";
import { API, apiHeaders } from "../../../lib/api";
import { adminApi, openAdminFile } from "../../../lib/files";
import { money, ui } from "../../../lib/ui";

// Agency wallet recharges: approve bank-transfer deposits once after checking
// the uploaded screenshot, and manage the bank accounts agencies pay into.
// (Card top-ups through Nomod are credited automatically and don't appear here.)

type Attachment = { key: string; name: string; type: string; size: number };
type Recharge = {
  id: string; status: string; title: string; amount: number | null; currency: string | null; adminNote: string | null; createdAt: string; updatedAt: string;
  details: { method?: string; reference?: string; paidOn?: string | null; bankAccount?: { label: string; bankName: string; accountNumber: string; currency: string } };
  attachments: Attachment[];
  agent: { id: string; name: string; number: string | null; email: string; wallet: { balance: number; currency: string } | null };
};
type Bank = {
  id: string; label: string; bankName: string; accountName: string; accountNumber: string; iban: string; swift: string; ifsc: string;
  branch: string; currency: string; country: string; instructions: string; active: boolean;
};

const CURRENCIES = ["AED", "INR", "USD", "SAR", "QAR", "OMR", "KWD", "BHD"];
const blankBank = { label: "", bankName: "", accountName: "", accountNumber: "", iban: "", swift: "", ifsc: "", branch: "", currency: "AED", country: "AE", instructions: "", active: true };
const STATUS_LABEL: Record<string, string> = { OPEN: "Waiting", IN_PROGRESS: "Waiting", APPROVED: "Credited", REJECTED: "Rejected" };

export default function WalletRechargesPage() {
  const [tab, setTab] = useState<"PENDING" | "APPROVED" | "REJECTED" | "ALL" | "BANKS">("PENDING");
  const [rows, setRows] = useState<Recharge[] | null>(null);
  const [pending, setPending] = useState(0);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    setError("");
    if (tab === "BANKS") {
      adminApi<{ accounts: Bank[] }>("/api/admin/agent-program/bank-accounts").then((d) => setBanks(d.accounts)).catch((e) => setError(e.message));
      return;
    }
    setRows(null);
    adminApi<{ recharges: Recharge[]; pending: number }>(`/api/admin/agent-program/recharges?status=${tab}`)
      .then((d) => { setRows(d.recharges); setPending(d.pending); }).catch((e) => setError(e.message));
  }, [tab]);
  useEffect(() => { load(); }, [load]);

  async function act(fn: () => Promise<unknown>, done: string) {
    setError(""); setMsg("");
    try { await fn(); setMsg(done); load(); } catch (err: any) { setError(err.message); }
  }

  return (
    <div>
      <h1 style={ui.h1}>Wallet recharges</h1>
      <p style={ui.sub}>
        Agencies recharge by card (Nomod — credited automatically) or by bank transfer with a payment screenshot. Check each screenshot
        against your bank statement, then credit the wallet. Each deposit can be credited only once.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <button style={ui.chip(tab === "PENDING")} onClick={() => setTab("PENDING")}>Waiting{pending ? ` (${pending})` : ""}</button>
        <button style={ui.chip(tab === "APPROVED")} onClick={() => setTab("APPROVED")}>Credited</button>
        <button style={ui.chip(tab === "REJECTED")} onClick={() => setTab("REJECTED")}>Rejected</button>
        <button style={ui.chip(tab === "ALL")} onClick={() => setTab("ALL")}>All</button>
        <button style={{ ...ui.chip(tab === "BANKS"), marginLeft: "auto" }} onClick={() => setTab("BANKS")}>🏦 Bank accounts</button>
      </div>
      {error && <div style={ui.err}>{error}</div>}
      {msg && <div style={ui.ok}>{msg}</div>}

      {tab === "BANKS" ? <BankAccounts banks={banks} act={act} /> : (
        <>
          {!rows && <div style={ui.card}>Loading…</div>}
          {rows && rows.length === 0 && <div style={{ ...ui.card, ...ui.text }}>{tab === "PENDING" ? "No recharges waiting for approval." : "Nothing here yet."}</div>}
          {rows?.map((r) => <RechargeCard key={r.id} r={r} act={act} />)}
        </>
      )}
    </div>
  );
}

function RechargeCard({ r, act }: { r: Recharge; act: (fn: () => Promise<unknown>, done: string) => Promise<void> }) {
  const [amount, setAmount] = useState(String(r.amount ?? ""));
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const open = ["OPEN", "IN_PROGRESS"].includes(r.status);
  const cur = r.agent.wallet?.currency ?? r.currency ?? "INR";
  const fileUrl = (a: Attachment) => `/api/admin/agent-program/requests/${r.id}/file?key=${encodeURIComponent(a.key)}`;

  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    for (const a of r.attachments.filter((x) => x.type.startsWith("image/"))) {
      fetch(`${API}${fileUrl(a)}`, { headers: apiHeaders() }).then((res) => (res.ok ? res.blob() : null)).then((b) => {
        if (!b || !alive) return;
        const u = URL.createObjectURL(b); urls.push(u);
        setThumbs((t) => ({ ...t, [a.key]: u }));
      }).catch(() => {});
    }
    return () => { alive = false; urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, [r.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const d = r.details ?? {};
  return (
    <div style={{ ...ui.card, display: "grid", gridTemplateColumns: "minmax(0, 1fr) 220px", gap: 16 }}>
      <div>
        <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
          <b style={{ color: "#f1f5f9", fontSize: 20 }}>{money(r.amount ?? 0, cur)}</b>
          <span style={{ ...ui.text, fontWeight: 700 }}>{r.agent.name}</span>
          {r.agent.number && <span style={{ color: "#93c5fd", fontSize: 12, fontWeight: 700 }}>{r.agent.number}</span>}
          <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999,
            background: r.status === "APPROVED" ? "rgba(34,197,94,.15)" : r.status === "REJECTED" ? "rgba(239,68,68,.15)" : "rgba(251,191,36,.15)",
            color: r.status === "APPROVED" ? "#4ade80" : r.status === "REJECTED" ? "#f87171" : "#fbbf24" }}>{STATUS_LABEL[r.status] ?? r.status}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "6px 16px", marginTop: 10, ...ui.text }}>
          <div><span style={ui.muted}>Method</span><br />{(d.method ?? "BANK_TRANSFER").replace("_", " ").toLowerCase()}</div>
          <div><span style={ui.muted}>Paid into</span><br />{d.bankAccount ? `${d.bankAccount.label} · …${d.bankAccount.accountNumber.slice(-4)}` : "—"}</div>
          <div><span style={ui.muted}>Reference</span><br />{d.reference || "—"}</div>
          <div><span style={ui.muted}>Paid on</span><br />{d.paidOn ?? "—"}</div>
          <div><span style={ui.muted}>Submitted</span><br />{new Date(r.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</div>
          <div><span style={ui.muted}>Wallet now</span><br />{r.agent.wallet ? money(r.agent.wallet.balance, r.agent.wallet.currency) : "—"}</div>
        </div>
        {r.adminNote && <div style={{ ...ui.muted, marginTop: 8 }}>Note: {r.adminNote}</div>}
        {open && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginTop: 14 }}>
            <label style={ui.label}>Amount to credit ({cur})
              <input style={{ ...ui.input, width: 150 }} type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <button style={ui.btn} disabled={!(Number(amount) > 0)} onClick={() => {
              if (confirm(`Credit ${money(Number(amount), cur)} to ${r.agent.name}'s wallet? This can't be undone.`)) {
                void act(() => adminApi(`/api/admin/agent-program/requests/${r.id}/approve-deposit`, { method: "POST", body: JSON.stringify({ amount: Number(amount) }) }), `${money(Number(amount), cur)} credited to ${r.agent.name}.`);
              }
            }}>✓ Approve &amp; credit</button>
            {!rejecting ? <button style={ui.ghost} onClick={() => setRejecting(true)}>Reject…</button> : (
              <>
                <input style={{ ...ui.input, flex: 1, minWidth: 200 }} placeholder="Reason shown to the agency (e.g. payment not received)" value={reason} onChange={(e) => setReason(e.target.value)} />
                <button style={{ ...ui.ghost, borderColor: "#7f1d1d", color: "#fca5a5" }} disabled={reason.trim().length < 3}
                  onClick={() => act(() => adminApi(`/api/admin/agent-program/requests/${r.id}/reject-deposit`, { method: "POST", body: JSON.stringify({ reason }) }), "Deposit rejected; the agency was told why.")}>Reject</button>
                <button style={ui.ghost} onClick={() => setRejecting(false)}>Cancel</button>
              </>
            )}
            <a href={`/agent-requests/${r.id}`} style={{ color: "#93c5fd", fontSize: 13, marginLeft: "auto" }}>Messages →</a>
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {r.attachments.length === 0 && <div style={ui.muted}>No screenshot</div>}
        {r.attachments.map((a) => (
          <button key={a.key} onClick={() => openAdminFile(fileUrl(a)).catch(() => {})} title="Open full size"
            style={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8, padding: 4, cursor: "zoom-in", color: "#e2e8f0", fontSize: 12 }}>
            {thumbs[a.key]
              ? <img src={thumbs[a.key]} alt={a.name} style={{ width: "100%", maxHeight: 220, objectFit: "contain", display: "block" }} />
              : <span style={{ display: "block", padding: 18 }}>📄 {a.name}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function BankAccounts({ banks, act }: { banks: Bank[]; act: (fn: () => Promise<unknown>, done: string) => Promise<void> }) {
  const [form, setForm] = useState<typeof blankBank>(blankBank);
  const [editing, setEditing] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const set = (k: keyof typeof blankBank, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  function edit(b: Bank) {
    const { id: _id, ...rest } = b;
    setForm({ ...blankBank, ...rest }); setEditing(b.id); setShowForm(true);
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    await act(() => editing
      ? adminApi(`/api/admin/agent-program/bank-accounts/${editing}`, { method: "PATCH", body: JSON.stringify(form) })
      : adminApi("/api/admin/agent-program/bank-accounts", { method: "POST", body: JSON.stringify(form) }),
      editing ? "Bank account updated." : "Bank account added — agencies see it on their wallet page.");
    setForm(blankBank); setEditing(null); setShowForm(false);
  }
  const input = (k: keyof typeof blankBank, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label style={ui.label}>{label}<input style={ui.input} value={String(form[k])} onChange={(e) => set(k, e.target.value)} {...props} /></label>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={ui.muted}>Active accounts are shown to agencies on their wallet page, matching their wallet currency first.</span>
        <button style={ui.btn} onClick={() => { setShowForm((v) => !v); setForm(blankBank); setEditing(null); }}>{showForm ? "Close" : "+ Add bank account"}</button>
      </div>
      {showForm && (
        <form onSubmit={save} style={ui.card}>
          <h2 style={ui.h2}>{editing ? "Edit bank account" : "Add bank account"}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
            {input("label", "Label (shown to agencies)", { required: true, placeholder: "Emirates NBD · AED" })}
            {input("bankName", "Bank name", { required: true })}
            {input("accountName", "Account holder name", { required: true })}
            {input("accountNumber", "Account number", { required: true })}
            {input("iban", "IBAN")}
            {input("swift", "SWIFT / BIC")}
            {input("ifsc", "IFSC (India)")}
            {input("branch", "Branch")}
            <label style={ui.label}>Currency
              <select style={ui.input} value={form.currency} onChange={(e) => set("currency", e.target.value)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
            </label>
            {input("country", "Country (2 letters)", { maxLength: 2, placeholder: "AE" })}
          </div>
          <label style={{ ...ui.label, marginTop: 12 }}>Instructions for agencies
            <input style={ui.input} placeholder="e.g. Use your agent number as the transfer reference" value={form.instructions} onChange={(e) => set("instructions", e.target.value)} />
          </label>
          <label style={{ ...ui.text, display: "flex", gap: 8, alignItems: "center", margin: "12px 0" }}>
            <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} /> Show to agencies
          </label>
          <button style={ui.btn}>{editing ? "Save changes" : "Add account"}</button>
        </form>
      )}
      {banks.length === 0 && !showForm && <div style={{ ...ui.card, ...ui.text }}>No bank accounts yet. Add one so agencies know where to transfer.</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
        {banks.map((b) => (
          <div key={b.id} style={{ ...ui.card, marginBottom: 0, opacity: b.active ? 1 : 0.6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <b style={{ color: "#f1f5f9" }}>{b.label}</b>
              <span style={{ fontSize: 11, fontWeight: 700, color: b.active ? "#4ade80" : "#94a3b8" }}>{b.active ? "SHOWN" : "HIDDEN"} · {b.currency}</span>
            </div>
            <div style={{ ...ui.text, marginTop: 8, lineHeight: 1.7 }}>
              {b.bankName}<br />{b.accountName}<br /><span style={{ fontFamily: "monospace" }}>{b.accountNumber}</span>
              {b.iban && <><br /><span style={ui.muted}>IBAN</span> <span style={{ fontFamily: "monospace" }}>{b.iban}</span></>}
              {b.swift && <><br /><span style={ui.muted}>SWIFT</span> {b.swift}</>}
              {b.ifsc && <><br /><span style={ui.muted}>IFSC</span> {b.ifsc}</>}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button style={ui.ghost} onClick={() => edit(b)}>Edit</button>
              <button style={ui.ghost} onClick={() => act(() => adminApi(`/api/admin/agent-program/bank-accounts/${b.id}`, { method: "PATCH", body: JSON.stringify({ active: !b.active }) }), b.active ? "Hidden from agencies." : "Shown to agencies.")}>{b.active ? "Hide" : "Show"}</button>
              <button style={{ ...ui.ghost, color: "#fca5a5" }} onClick={() => { if (confirm(`Remove ${b.label}? Past deposits keep their details.`)) void act(() => adminApi(`/api/admin/agent-program/bank-accounts/${b.id}`, { method: "DELETE" }), "Bank account removed."); }}>Remove</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
