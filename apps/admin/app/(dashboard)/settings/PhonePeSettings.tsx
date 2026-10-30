"use client";
import { useEffect, useState } from "react";
import { API, apiHeaders } from "../../../lib/api";
type Readiness = {
  configured: boolean;
  gatesReady: boolean;
  enabled: boolean;
  requestedEnabled: boolean;
  environment: string;
  connectionHealth: string;
};
type LedgerOrder = {
  merchantOrderId: string;
  bookingId: string;
  environment: string;
  amountMinor: number;
  refundedMinor: number;
  ledgerStatus: string;
  transactionId: string | null;
  updatedAt: string;
};
const rupees = (minor: number) => `₹${(minor / 100).toFixed(2)}`;
export function PhonePeSettings() {
  const [data, setData] = useState<Readiness | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [orders, setOrders] = useState<LedgerOrder[]>([]);
  useEffect(() => {
    // Read-only ledger view; empty until the PhonePe schema gate is set.
    fetch(`${API}/api/admin/settings/phonepe/orders`, { headers: apiHeaders() })
      .then((r) => (r.ok ? r.json() : { orders: [] }))
      .then((d) => setOrders(d.orders ?? []))
      .catch(() => setOrders([]));
  }, []);
  useEffect(() => {
    fetch(`${API}/api/admin/settings/phonepe`, { headers: apiHeaders() })
      .then(async (r) => {
        if (!r.ok)
          throw new Error("PhonePe settings unavailable for this account");
        return r.json();
      })
      .then((d) => {
        setData(d);
        setEnabled(d.requestedEnabled);
      })
      .catch((e) => setNotice(e.message));
  }, []);
  async function save() {
    setBusy(true);
    setNotice("");
    try {
      const r = await fetch(`${API}/api/admin/settings/phonepe`, {
        method: "PUT",
        headers: apiHeaders(),
        body: JSON.stringify({ enabled }),
      });
      if (!r.ok)
        throw new Error(
          "PhonePe remains disabled until all release gates pass",
        );
      setNotice("PhonePe setting saved");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="PhonePe settings"
      style={{
        background: "#0f172a",
        border: "1px solid #334155",
        borderRadius: 10,
        padding: 16,
        marginBottom: 16,
      }}
    >
      <h3 style={{ color: "#e2e8f0", marginBottom: 8 }}>
        PhonePe PG V2 Standard Checkout
      </h3>
      <p style={{ color: "#94a3b8", fontSize: 13, lineHeight: 1.6 }}>
        Environment: {data?.environment ?? "sandbox"} · Currency: INR
        <br />
        Backend credentials:{" "}
        {data?.configured ? "Provisioned" : "Not provisioned"} · Connection:{" "}
        {data?.connectionHealth ?? "NOT_VERIFIED"}
        <br />
        Release gates:{" "}
        {data?.gatesReady
          ? "Passed"
          : "Pending schema, merchant activation and deployment approval"}
      </p>
      <p style={{ color: "#94a3b8", fontSize: 13, margin: "10px 0" }}>
        Credentials are managed in protected backend secrets. Payment success
        does not confirm a supplier booking.
      </p>
      <label style={{ color: "#e2e8f0", display: "block", margin: "10px 0" }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!data?.gatesReady || busy}
          onChange={(e) => setEnabled(e.target.checked)}
        />{" "}
        Enable PhonePe
      </label>
      <button
        type="button"
        disabled={!data || busy}
        onClick={save}
        style={{
          padding: "9px 14px",
          borderRadius: 8,
          color: "white",
          background: "#0D4B96",
          cursor: "pointer",
        }}
      >
        Save PhonePe setting
      </button>
      {notice && (
        <p role="status" style={{ color: "#cbd5e1", marginTop: 10 }}>
          {notice}
        </p>
      )}
      {orders.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 14 }}>
          <table
            aria-label="PhonePe payments"
            style={{ width: "100%", fontSize: 12, color: "#cbd5e1", borderCollapse: "collapse" }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: "#94a3b8" }}>
                <th>Booking</th>
                <th>Order</th>
                <th>Amount</th>
                <th>Refunded</th>
                <th>Status</th>
                <th>Transaction</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.merchantOrderId} style={{ borderTop: "1px solid #334155" }}>
                  <td>{o.bookingId.slice(0, 8)}</td>
                  <td>{o.merchantOrderId.slice(0, 12)}…</td>
                  <td>{rupees(o.amountMinor)}</td>
                  <td>{rupees(o.refundedMinor)}</td>
                  <td>
                    {o.ledgerStatus}
                    {o.environment === "sandbox" ? " (sandbox)" : ""}
                  </td>
                  <td>{o.transactionId ?? "—"}</td>
                  <td>{new Date(o.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ color: "#94a3b8", fontSize: 12, marginTop: 6 }}>
            Supplier booking stays pending until confirmed separately.
          </p>
        </div>
      )}
    </section>
  );
}
