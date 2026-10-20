"use client";
import { useEffect, useState, type FormEvent } from "react";
import { API, apiHeaders } from "../../../lib/api";

interface Customer { userId: string; name: string | null; email: string | null; phone: string | null; balance: number; createdAt: string }
interface Tx { id: string; type: string; amount: string; balanceAfter: string; bookingId: string | null; note: string | null; createdAt: string }
interface Detail { customer: { id: string; name: string | null; email: string | null; phone: string | null }; balance: number; currency: string; transactions: Tx[] }

const TX_LABEL: Record<string, string> = {
  BOOKING_BONUS: "Booking bonus", ADMIN_CREDIT: "Admin credit", BOOKING_DEBIT: "Booking payment",
  REFUND_CREDIT: "Refund", COUPON_DEBIT: "Coupon created", COUPON_CREDIT: "Coupon redeemed", COUPON_REFUND: "Coupon returned",
};
const DEBITS = new Set(["BOOKING_DEBIT", "COUPON_DEBIT"]);
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function CustomerWalletsPage() {
  const [q, setQ] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Detail | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function search(query = q) {
    setLoading(true); setError("");
    try {
      const res = await fetch(`${API}/api/admin/customer-wallets?q=${encodeURIComponent(query)}`, { headers: apiHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setCustomers(data.customers ?? []);
    } catch (err: any) { setError(err.message); } finally { setLoading(false); }
  }

  async function open(userId: string) {
    setMessage(""); setError("");
    const res = await fetch(`${API}/api/admin/customer-wallets/${userId}`, { headers: apiHeaders() });
    const data = await res.json();
    if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return; }
    setSelected(data);
  }

  async function credit(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const value = Number(amount);
    if (!(value > 0)) { setError("Enter an amount greater than 0"); return; }
    if (note.trim().length < 3) { setError("Add a short reason (min 3 characters)"); return; }
    if (!confirm(`Add ${inr(value)} to ${selected.customer.name ?? selected.customer.email}'s wallet?`)) return;
    setSaving(true); setError(""); setMessage("");
    try {
      const res = await fetch(`${API}/api/admin/customer-wallets/${selected.customer.id}/credit`, {
        method: "POST", headers: apiHeaders(), body: JSON.stringify({ amount: value, note: note.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setMessage(`Added ${inr(value)}. New balance ${inr(data.balance)}.`);
      setAmount(""); setNote("");
      await open(selected.customer.id);
      await search();
    } catch (err: any) { setError(err.message); } finally { setSaving(false); }
  }

  useEffect(() => { search(""); }, []);

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", marginBottom: 8 }}>Customer Wallets</h1>
      <p style={{ color: "#64748b", fontSize: 14, marginBottom: 20 }}>
        Find a customer, see their wallet history and add balance. Customers also earn ₹50 per confirmed booking.
      </p>

      <form onSubmit={(e) => { e.preventDefault(); search(); }} style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email or phone" style={{ ...input, flex: 1 }} />
        <button type="submit" style={btn}>Search</button>
      </form>

      {error && <div style={errBox}>{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <section style={card}>
          {loading ? <p style={muted}>Loading…</p> : customers.length === 0 ? <p style={muted}>No customers found.</p> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {customers.map((cu) => (
                <button key={cu.userId} onClick={() => open(cu.userId)} style={{
                  ...row, borderColor: selected?.customer.id === cu.userId ? "#E31E24" : "#334155",
                }}>
                  <span style={{ textAlign: "left", minWidth: 0 }}>
                    <strong style={{ color: "#f1f5f9", display: "block" }}>{cu.name ?? "—"}</strong>
                    <small style={{ color: "#94a3b8", wordBreak: "break-all" }}>{cu.email ?? ""}{cu.phone ? ` · ${cu.phone}` : ""}</small>
                  </span>
                  <span style={{ color: "#4ade80", fontWeight: 700, whiteSpace: "nowrap" }}>{inr(cu.balance)}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        {selected && (
          <section style={card}>
            <h2 style={{ color: "#f1f5f9", fontSize: 16, margin: "0 0 4px" }}>{selected.customer.name ?? selected.customer.email}</h2>
            <p style={{ ...muted, margin: "0 0 12px" }}>{selected.customer.email}{selected.customer.phone ? ` · ${selected.customer.phone}` : ""}</p>
            <p style={{ fontSize: 28, fontWeight: 800, color: "#4ade80", margin: "0 0 16px" }}>{inr(selected.balance)}</p>

            <form onSubmit={credit} style={{ display: "grid", gridTemplateColumns: "120px 1fr auto", gap: 8, marginBottom: 8 }}>
              <input type="number" min="1" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="₹ amount" style={input} />
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (e.g. goodwill for delay)" style={input} />
              <button type="submit" disabled={saving} style={{ ...btn, opacity: saving ? .7 : 1 }}>{saving ? "Adding…" : "Add balance"}</button>
            </form>
            {message && <p style={{ color: "#4ade80", fontSize: 13, margin: "0 0 12px" }}>{message}</p>}

            <h3 style={{ color: "#cbd5e1", fontSize: 13, margin: "16px 0 8px" }}>History</h3>
            {selected.transactions.length === 0 ? <p style={muted}>No transactions yet.</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {selected.transactions.map((t) => (
                  <div key={t.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "8px 0", borderTop: "1px solid #1e293b", fontSize: 13 }}>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ color: "#e2e8f0" }}>{TX_LABEL[t.type] ?? t.type}</span>
                      <small style={{ display: "block", color: "#64748b" }}>{new Date(t.createdAt).toLocaleString("en-IN")}{t.note ? ` · ${t.note}` : ""}</small>
                    </span>
                    <span style={{ color: DEBITS.has(t.type) ? "#f87171" : "#4ade80", fontWeight: 700, whiteSpace: "nowrap" }}>
                      {DEBITS.has(t.type) ? "−" : "+"}{inr(Number(t.amount))}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

const card: React.CSSProperties = { background: "#1e293b", borderRadius: 12, padding: 20, border: "1px solid #334155" };
const input: React.CSSProperties = { boxSizing: "border-box", padding: "10px 12px", background: "#0f172a", border: "1px solid #334155", borderRadius: 8, color: "#f1f5f9", fontSize: 14, minWidth: 0 };
const btn: React.CSSProperties = { background: "#E31E24", color: "white", border: "none", borderRadius: 8, padding: "10px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" };
const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "10px 12px", background: "#0f172a", border: "1px solid #334155", borderRadius: 8, cursor: "pointer", width: "100%" };
const muted: React.CSSProperties = { color: "#64748b", fontSize: 13 };
const errBox: React.CSSProperties = { background: "rgba(239,68,68,.1)", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 8, padding: "10px 12px", fontSize: 13, marginBottom: 16 };
