"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, fmtDate, money, openFile, STATUS_STYLE } from "../../../lib/api";
import { useMe } from "../Shell";

interface Statement {
  currency: string; from: string; to: string; openingBalance: number; closingBalance: number; totalCredits: number; totalDebits: number;
  transactions: { id: string; date: string; type: string; note: string | null; bookingId: string | null; credit: number; debit: number; balance: number }[];
}
interface Req { id: string; type: string; status: string; title: string; amount: number | null; currency: string | null; createdAt: string; adminNote: string | null; details?: { reference?: string; bankAccount?: { label: string } } }
interface Bank { id: string; label: string; bankName: string; accountName: string; accountNumber: string; iban: string; swift: string; ifsc: string; branch: string; currency: string; country: string; instructions: string }

const TX: Record<string, string> = { TOPUP: "Top-up", BOOKING_DEBIT: "Booking", REFUND_CREDIT: "Refund", COMMISSION_CREDIT: "Commission", ADJUSTMENT: "Transfer / adjustment" };
const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1)).toISOString().slice(0, 10); };

export default function WalletPage() {
  const { me, reload } = useMe();
  const [st, setSt] = useState<Statement | null>(null);
  const [deposits, setDeposits] = useState<Req[]>([]);
  const [range, setRange] = useState({ from: monthStart(), to: new Date().toISOString().slice(0, 10) });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [topup, setTopup] = useState("");
  const [dep, setDep] = useState({ amount: "", method: "BANK_TRANSFER", reference: "", paidOn: new Date().toISOString().slice(0, 10) });
  const [receipt, setReceipt] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [banks, setBanks] = useState<Bank[]>([]);
  const [bankId, setBankId] = useState("");
  const [online, setOnline] = useState(true);
  const [tab, setTab] = useState<"bank" | "card">("bank");
  const [copied, setCopied] = useState("");
  const [fileKey, setFileKey] = useState(0);   // remounts the file input so it clears after a submit
  const cur = me?.agent.currency ?? "INR";
  const canMoney = me ? ["AGENT_ADMIN", "AGENT_ACCOUNTANT"].includes(me.user.role) : false;

  const load = useCallback(() => {
    if (!canMoney) return;
    api<Statement>(`/api/agent/statement?from=${range.from}&to=${range.to}`).then(setSt).catch((e) => setError(e.message));
    api<{ requests: Req[] }>("/api/agent/requests?type=DEPOSIT").then((d) => setDeposits(d.requests)).catch(() => {});
    api<{ accounts: Bank[]; onlineTopup: boolean }>("/api/agent/wallet/bank-accounts").then((d) => {
      setBanks(d.accounts); setOnline(d.onlineTopup);
      setBankId((id) => id || d.accounts[0]?.id || "");
      if (!d.accounts.length && d.onlineTopup) setTab("card");
    }).catch(() => {});
  }, [range, canMoney]);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("topup") === "success") setNotice("Payment received — your wallet updates within a minute.");
    if (q.get("topup") === "failed") setError("The top-up payment didn't go through. You have not been charged.");
  }, []);
  useEffect(() => { load(); }, [load]);

  async function onlineTopup(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const d = await api<{ paymentUrl: string }>("/api/agent/wallet/topup", { json: { amount: Number(topup) } });
      window.location.assign(d.paymentUrl);
    } catch (err) { setError(err instanceof Error ? err.message : "Top-up failed"); setBusy(false); }
  }

  async function deposit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const form = new FormData();
      Object.entries(dep).forEach(([k, v]) => form.append(k, v));
      if (!receipt) throw new Error("Upload the payment screenshot");
      form.append("receipt", receipt);
      if (bankId && dep.method === "BANK_TRANSFER") form.append("bankAccountId", bankId);
      const d = await api<{ message: string }>("/api/agent/deposits", { method: "POST", body: form });
      setNotice(d.message); setDep((x) => ({ ...x, amount: "", reference: "" })); pickReceipt(null); setFileKey((k) => k + 1); load();
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't submit the deposit"); } finally { setBusy(false); }
  }

  function pickReceipt(f: File | null) {
    setReceipt(f);
    setPreview((old) => { if (old) URL.revokeObjectURL(old); return f && f.type.startsWith("image/") ? URL.createObjectURL(f) : ""; });
  }
  function copy(text: string, what: string) {
    void navigator.clipboard?.writeText(text);
    setCopied(what); setTimeout(() => setCopied(""), 1500);
  }
  const bank = banks.find((b) => b.id === bankId);
  const field = (k: string, v: string, mono = true) => v ? (
    <div className="row between" style={{ gap: 8, padding: "4px 0", borderBottom: "1px dashed var(--line, #e5e7eb)" }}>
      <span className="muted small">{k}</span>
      <span className="row" style={{ gap: 6 }}><b style={mono ? { fontFamily: "ui-monospace, monospace" } : undefined}>{v}</b>
        <button type="button" className="btn sm" onClick={() => copy(v, k)}>{copied === k ? "Copied" : "Copy"}</button></span>
    </div>
  ) : null;

  return (
    <div>
      <div className="page-head no-print"><div><h1>Wallet & statement</h1><p>Bookings are paid from your balance, then your credit limit.</p></div>
        <button className="btn" onClick={() => reload()}>↻ Refresh</button></div>
      {notice && <div className="banner ok no-print">{notice}</div>}
      {error && <div className="banner bad no-print">{error}</div>}

      {me && (
        <div className="grid g4 no-print" style={{ marginBottom: 16 }}>
          <div className="stat"><small>Available to book</small><b>{money(me.credit.available, cur)}</b></div>
          <div className="stat"><small>Balance</small><b style={{ color: me.credit.balance < 0 ? "var(--bad)" : undefined }}>{money(me.credit.balance, cur)}</b></div>
          <div className="stat"><small>Credit limit</small><b>{money(me.credit.creditLimit, cur)}</b><span>Repay within {me.program.creditDays} days</span></div>
          <div className="stat"><small>Credit used</small><b>{money(me.credit.creditUsed, cur)}</b><span>{me.credit.dueAt ? `Due ${fmtDate(me.credit.dueAt)}` : "Nothing due"}</span></div>
        </div>
      )}

      {canMoney ? (
        <>
          <div className="card no-print">
            <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
              <h2 style={{ margin: 0 }}>Recharge wallet</h2>
              <div className="row" role="tablist" style={{ gap: 6 }}>
                <button type="button" role="tab" aria-selected={tab === "bank"} className={`btn sm${tab === "bank" ? " primary" : ""}`} onClick={() => setTab("bank")}>🏦 Bank transfer</button>
                {online && <button type="button" role="tab" aria-selected={tab === "card"} className={`btn sm${tab === "card" ? " primary" : ""}`} onClick={() => setTab("card")}>💳 Card (Nomod)</button>}
              </div>
            </div>

            {tab === "card" && online && (
              <form className="stack" onSubmit={onlineTopup} style={{ marginTop: 12 }}>
                <p className="small muted" style={{ margin: 0 }}>Pay by card on Nomod&apos;s secure page. The amount is added to your wallet automatically once the payment completes.</p>
                <div className="row"><input className="in" style={{ flex: 1 }} type="number" min={100} required placeholder={`Amount (${cur})`} value={topup} onChange={(e) => setTopup(e.target.value)} />
                  <button className="btn primary" disabled={busy}>Pay {topup ? money(Number(topup), cur) : ""}</button></div>
              </form>
            )}

            {tab === "bank" && (
              <div className="grid g2" style={{ marginTop: 12, alignItems: "start" }}>
                <div className="stack">
                  <h3 style={{ margin: 0, fontSize: 15 }}>1. Transfer to our account</h3>
                  {banks.length === 0 ? <p className="small muted">Bank details aren&apos;t set up yet — contact FlyPoomas for transfer details.</p> : (
                    <>
                      {banks.length > 1 && (
                        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                          {banks.map((b) => (
                            <button type="button" key={b.id} className={`btn sm${b.id === bankId ? " primary" : ""}`} onClick={() => setBankId(b.id)}>
                              {b.label}{b.currency !== cur ? ` (${b.currency})` : ""}
                            </button>
                          ))}
                        </div>
                      )}
                      {bank && (
                        <div style={{ border: "1px solid var(--line, #e5e7eb)", borderRadius: 10, padding: "8px 12px" }}>
                          <div className="row between"><b>{bank.bankName}</b><span className="badge b-grey">{bank.currency}</span></div>
                          {field("Account name", bank.accountName, false)}
                          {field("Account number", bank.accountNumber)}
                          {field("IBAN", bank.iban)}
                          {field("SWIFT", bank.swift)}
                          {field("IFSC", bank.ifsc)}
                          {field("Branch", bank.branch, false)}
                          {me?.agent.agentNumber ? field("Reference to use", me.agent.agentNumber) : null}
                          {bank.instructions && <p className="small muted" style={{ margin: "8px 0 0" }}>{bank.instructions}</p>}
                          {bank.currency !== cur && <p className="small" style={{ margin: "8px 0 0", color: "var(--bad, #b42318)" }}>Your wallet is in {cur}; this account takes {bank.currency}. Enter the amount credited in {cur} after conversion.</p>}
                        </div>
                      )}
                    </>
                  )}
                </div>
                <form className="stack" onSubmit={deposit}>
                  <h3 style={{ margin: 0, fontSize: 15 }}>2. Upload the payment screenshot</h3>
                  <div className="grid g2">
                    <label className="f">Amount paid ({cur})<input type="number" min={1} step="0.01" required value={dep.amount} onChange={(e) => setDep((d) => ({ ...d, amount: e.target.value }))} /></label>
                    <label className="f">Method<select value={dep.method} onChange={(e) => setDep((d) => ({ ...d, method: e.target.value }))}><option value="BANK_TRANSFER">Bank transfer</option><option value="UPI">UPI</option><option value="CASH">Cash deposit</option><option value="CHEQUE">Cheque</option></select></label>
                    <label className="f">Transfer reference / UTR<input value={dep.reference} placeholder="Optional" onChange={(e) => setDep((d) => ({ ...d, reference: e.target.value }))} /></label>
                    <label className="f">Paid on<input type="date" value={dep.paidOn} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDep((d) => ({ ...d, paidOn: e.target.value }))} /></label>
                  </div>
                  <label className="f">Screenshot or receipt (photo / PDF, max 8 MB)
                    <input key={fileKey} type="file" required accept="image/*,application/pdf" onChange={(e) => pickReceipt(e.target.files?.[0] ?? null)} />
                  </label>
                  {preview && <img src={preview} alt="Payment screenshot preview" style={{ maxHeight: 180, maxWidth: "100%", objectFit: "contain", borderRadius: 8, border: "1px solid var(--line, #e5e7eb)" }} />}
                  {receipt && !preview && <p className="small muted" style={{ margin: 0 }}>📄 {receipt.name}</p>}
                  <button className="btn primary" disabled={busy}>{busy ? "Submitting…" : "Submit for approval"}</button>
                  <p className="small muted" style={{ margin: 0 }}>Our team checks the payment and credits your wallet once. You&apos;ll get an email / WhatsApp when it&apos;s done.</p>
                </form>
              </div>
            )}
          </div>

          {deposits.length > 0 && (
            <div className="card flush no-print">
              <div style={{ padding: "14px 16px 0" }}><h2>Recharge requests</h2></div>
              <div className="table-wrap"><table className="t"><tbody>{deposits.slice(0, 10).map((d) => (
                <tr key={d.id}><td><a href={`/requests/${d.id}`}>{d.title}</a><div className="muted small">{fmtDate(d.createdAt, true)}{d.details?.bankAccount ? ` · ${d.details.bankAccount.label}` : ""}{d.details?.reference ? ` · ref ${d.details.reference}` : ""}</div></td>
                  <td><span className={`badge ${STATUS_STYLE[d.status]?.cls ?? "b-grey"}`}>{d.status === "APPROVED" ? "Credited" : STATUS_STYLE[d.status]?.label ?? d.status}</span></td>
                  <td className="small" style={d.status === "REJECTED" ? { color: "var(--bad, #b42318)" } : { color: "var(--muted, #667085)" }}>{d.adminNote ?? (["OPEN", "IN_PROGRESS"].includes(d.status) ? "Waiting for approval" : "")}</td></tr>
              ))}</tbody></table></div>
            </div>
          )}

          <div className="card">
            <div className="row between no-print">
              <h2 style={{ margin: 0 }}>Statement</h2>
              <div className="row">
                <input className="in" type="date" style={{ width: 150 }} value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
                <span className="muted">to</span>
                <input className="in" type="date" style={{ width: 150 }} value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
                <button className="btn sm" onClick={() => openFile(`/api/agent/statement.csv?from=${range.from}&to=${range.to}`, `statement-${range.from}-${range.to}.csv`).catch((e) => setError(e.message))}>⬇ Excel (CSV)</button>
                <button className="btn sm" onClick={() => window.print()}>🖨 PDF</button>
              </div>
            </div>
            <div className="print-only"><h1>{me?.agent.businessName} — wallet statement</h1><p>{fmtDate(range.from)} to {fmtDate(range.to)}</p></div>
            {st && (
              <>
                <div className="grid g4" style={{ margin: "14px 0" }}>
                  <div><small className="muted">Opening</small><div><b>{money(st.openingBalance, st.currency)}</b></div></div>
                  <div><small className="muted">Credits</small><div><b className="ok-text">+{money(st.totalCredits, st.currency)}</b></div></div>
                  <div><small className="muted">Debits</small><div><b className="err">−{money(st.totalDebits, st.currency)}</b></div></div>
                  <div><small className="muted">Closing</small><div><b>{money(st.closingBalance, st.currency)}</b></div></div>
                </div>
                {st.transactions.length === 0 ? <p className="empty">No transactions in this period.</p> : (
                  <div className="table-wrap"><table className="t">
                    <thead><tr><th>Date</th><th>Type</th><th>Details</th><th className="num">Credit</th><th className="num">Debit</th><th className="num">Balance</th></tr></thead>
                    <tbody>{st.transactions.map((t) => (
                      <tr key={t.id}>
                        <td className="small">{fmtDate(t.date, true)}</td>
                        <td>{TX[t.type] ?? t.type}</td>
                        <td className="small">{t.note}{t.bookingId && <> · <a href={`/bookings/${t.bookingId}`}>{t.bookingId.slice(0, 8).toUpperCase()}</a></>}</td>
                        <td className="num ok-text">{t.credit ? money(t.credit, st.currency) : ""}</td>
                        <td className="num err">{t.debit ? money(t.debit, st.currency) : ""}</td>
                        <td className="num">{money(t.balance, st.currency)}</td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                )}
              </>
            )}
          </div>
        </>
      ) : <div className="card empty">Only the agency admin or accountant can see the statement and add money.</div>}
    </div>
  );
}
