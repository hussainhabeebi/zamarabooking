"use client";
import { useEffect, useState } from "react";
import { API, apiHeaders } from "../../../lib/api";

interface Row {
  id: string; status: string; supplierStatus: string | null; supplierAmendmentId: string | null;
  amountPaid: string; supplierCharges: string | null; refundAmount: string | null; currency: string;
  refundMethod: string; refundStatus: string; refundReference: string | null; refundError: string | null;
  refundedAt: string | null; adminNote: string | null; createdAt: string; lastCheckedAt: string | null;
  bookingId: string; pnr: string | null; origin: string; destination: string; departureDate: string | null;
  contactEmail: string | null; customerName: string | null;
}

const STATUS_COLOR: Record<string, string> = { SUBMITTED: "#fbbf24", PROCESSING: "#fbbf24", SUCCESS: "#4ade80", REJECTED: "#f87171", FAILED: "#f87171" };
const REFUND_STATUS: Record<string, { label: string; color: string }> = {
  PENDING: { label: "Refund pending", color: "#94a3b8" }, PROCESSING: { label: "Refund in progress", color: "#fbbf24" },
  DONE: { label: "Refunded", color: "#4ade80" }, FAILED: { label: "Refund failed — retry or refund manually", color: "#f87171" },
  MANUAL_REQUIRED: { label: "Refund manually (check provider first)", color: "#f87171" },
};
const METHOD: Record<string, string> = { WALLET: "wallet", NOMOD: "card via Nomod", MANUAL: "manual" };
const money = (v: string | null, cur: string) => v === null ? "—" : `${cur === "INR" ? "₹" : cur + " "}${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export default function CancellationsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  async function load() {
    setLoading(true); setError("");
    try {
      const res = await fetch(`${API}/api/admin/cancellations${status ? `?status=${status}` : ""}`, { headers: apiHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRows(data.cancellations ?? []);
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [status]);

  async function act(id: string, path: string, body?: unknown) {
    setBusyId(id); setError("");
    try {
      const res = await fetch(`${API}/api/admin/cancellations/${id}/${path}`, { method: "POST", headers: apiHeaders(), body: body ? JSON.stringify(body) : undefined });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusyId(""); }
  }

  function resolve(r: Row, action: "MARK_SUCCESS" | "MARK_REJECTED" | "MARK_REFUNDED_MANUALLY" | "RETRY_REFUND") {
    if (action === "RETRY_REFUND") {
      if (!confirm(`Retry the ${METHOD[r.refundMethod] ?? r.refundMethod} refund of ${money(r.refundAmount, r.currency)}? Only do this if it was NOT already refunded in the provider's dashboard.`)) return;
      act(r.id, "resolve", { action, note: "Admin retry" });
      return;
    }
    let refundAmount: number | undefined;
    if (action === "MARK_SUCCESS" || action === "MARK_REFUNDED_MANUALLY") {
      const v = prompt(action === "MARK_SUCCESS" ? "Refund amount confirmed by TripJack (₹):" : "Refund amount paid manually (₹, optional):", r.refundAmount ?? "");
      if (v === null) return;
      if (v.trim()) refundAmount = Number(v);
      if (refundAmount !== undefined && !(refundAmount >= 0)) { alert("Enter a valid amount"); return; }
    }
    const note = prompt("Reason / reference (required):");
    if (!note || note.trim().length < 3) return;
    act(r.id, "resolve", { action, refundAmount, note: note.trim() });
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", marginBottom: 8 }}>Cancellations</h1>
      <p style={{ color: "#64748b", fontSize: 14, marginBottom: 16 }}>
        Customer cancellations submitted to TripJack. Status is re-checked when the customer opens the booking or when you press Refresh. Successful cancellations are refunded automatically to the original payment method: wallet payments to the wallet, card payments through Nomod.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {["", "SUBMITTED", "PROCESSING", "SUCCESS", "REJECTED", "FAILED"].map((s) => (
          <button key={s} onClick={() => setStatus(s)} style={{ ...chip, background: status === s ? "#E31E24" : "#1e293b" }}>{s || "All"}</button>
        ))}
      </div>
      {error && <div style={errBox}>{error}</div>}
      {loading ? <p style={{ color: "#64748b" }}>Loading…</p> : rows.length === 0 ? <p style={{ color: "#64748b" }}>No cancellations.</p> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((r) => (
            <div key={r.id} style={card}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <strong style={{ color: "#f1f5f9" }}>{r.origin} → {r.destination}</strong>
                  <span style={{ color: "#94a3b8", fontSize: 13 }}> · {r.departureDate ? new Date(r.departureDate).toLocaleDateString("en-IN") : "—"} · PNR {r.pnr ?? "—"}</span>
                  <div style={{ color: "#94a3b8", fontSize: 12 }}>{r.customerName ?? "Guest"} · {r.contactEmail} · requested {new Date(r.createdAt).toLocaleString("en-IN")}</div>
                </div>
                <span style={{ color: STATUS_COLOR[r.status] ?? "#94a3b8", fontWeight: 800, fontSize: 13 }}>{r.status}{r.supplierStatus ? ` · TJ ${r.supplierStatus}` : ""}</span>
              </div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "10px 0", fontSize: 13, color: "#cbd5e1" }}>
                <span>Paid {money(r.amountPaid, r.currency)}</span>
                <span>Charges {money(r.supplierCharges, r.currency)}</span>
                <span>Refund {money(r.refundAmount, r.currency)}</span>
                {r.status === "SUCCESS" && (
                  <span style={{ color: REFUND_STATUS[r.refundStatus]?.color ?? "#94a3b8", fontWeight: 700 }}>
                    {REFUND_STATUS[r.refundStatus]?.label ?? r.refundStatus} · {METHOD[r.refundMethod] ?? r.refundMethod}
                    {r.refundedAt ? ` · ${new Date(r.refundedAt).toLocaleDateString("en-IN")}` : ""}
                  </span>
                )}
                <span style={{ color: "#64748b" }}>Amendment {r.supplierAmendmentId ?? "—"}</span>
              </div>
              {r.refundError && <div style={{ fontSize: 12, color: "#fca5a5", marginBottom: 6 }}>{r.refundError}</div>}
              {r.refundReference && <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6, fontFamily: "monospace" }}>Refund ref {r.refundReference}</div>}
              {r.adminNote && <div style={{ fontSize: 12, color: "#fbbf24", marginBottom: 8 }}>{r.adminNote}</div>}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {["SUBMITTED", "PROCESSING"].includes(r.status) && (
                  <button disabled={busyId === r.id} onClick={() => act(r.id, "refresh")} style={btn}>Refresh from TripJack</button>
                )}
                {["SUBMITTED", "PROCESSING"].includes(r.status) && <>
                  <button disabled={busyId === r.id} onClick={() => resolve(r, "MARK_SUCCESS")} style={btnGhost}>Mark cancelled + refund</button>
                  <button disabled={busyId === r.id} onClick={() => resolve(r, "MARK_REJECTED")} style={btnGhost}>Mark rejected</button>
                </>}
                {r.status === "SUCCESS" && ["PENDING", "FAILED"].includes(r.refundStatus) && (
                  <button disabled={busyId === r.id} onClick={() => resolve(r, "RETRY_REFUND")} style={btn}>Retry refund</button>
                )}
                {r.status === "SUCCESS" && ["PENDING", "FAILED", "MANUAL_REQUIRED"].includes(r.refundStatus) && (
                  <button disabled={busyId === r.id} onClick={() => resolve(r, "MARK_REFUNDED_MANUALLY")} style={btnGhost}>Mark refunded manually</button>
                )}
                <span style={{ color: "#64748b", fontSize: 11, alignSelf: "center", fontFamily: "monospace" }}>Booking {r.bookingId.slice(0, 8)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const card: React.CSSProperties = { background: "#1e293b", borderRadius: 12, padding: 16, border: "1px solid #334155" };
const chip: React.CSSProperties = { color: "#fff", border: "1px solid #334155", borderRadius: 20, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" };
const btn: React.CSSProperties = { background: "#E31E24", color: "#fff", border: 0, borderRadius: 8, padding: "8px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer" };
const btnGhost: React.CSSProperties = { ...btn, background: "#0f172a", border: "1px solid #334155", color: "#e2e8f0" };
const errBox: React.CSSProperties = { background: "rgba(239,68,68,.1)", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 8, padding: "10px 12px", fontSize: 13, marginBottom: 12 };
