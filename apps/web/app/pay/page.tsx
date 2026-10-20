"use client";

// Pay for a held fare (hold now, pay later). Opened from the hold email /
// WhatsApp link: /pay?b=<bookingId>&t=<checkout token>.

import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";

type Held = {
  id: string; status: string; origin: string; destination: string; departureDate: string | null; pnr: string | null;
  heldUntil: string | null; totalAmount: number; currency: string; adultCount: number; childCount: number; infantCount: number; expired: boolean;
};

export default function PayHeldFarePage() {
  const [ids, setIds] = useState<{ b: string; t: string } | null>(null);
  const [held, setHeld] = useState<Held | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const b = q.get("b") ?? "", t = q.get("t") ?? "";
    if (!b || !t) { setError("This payment link is incomplete."); return; }
    setIds({ b, t });
    fetch(`${API}/api/book/held/${encodeURIComponent(b)}`, { headers: { "x-tenant-slug": "poomas", "X-Checkout-Token": t } })
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? "This payment link is no longer valid."); return d.booking as Held; })
      .then(setHeld)
      .catch((e) => setError(e.message));
  }, []);

  async function pay() {
    if (!ids) return;
    setBusy(true); setError("");
    try {
      const res = await fetch(`${API}/api/payments/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": "poomas", "X-Checkout-Token": ids.t },
        body: JSON.stringify({ bookingId: ids.b, gateway: "NOMOD" }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.paymentUrl) throw new Error(d.error ?? "The payment page couldn't open. You have not been charged.");
      window.location.assign(d.paymentUrl);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  const money = (n: number, cur: string) => { try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(n); } catch { return `${cur} ${n}`; } };
  const pax = held ? held.adultCount + held.childCount + held.infantCount : 0;
  const payable = held && held.status === "HELD" && !held.expired;

  return (
    <main className="page-container" style={{ maxWidth: 520, padding: "36px 16px 48px" }}>
      <h1 style={{ margin: "0 0 6px", fontSize: 24 }}>Pay for your held fare</h1>
      {!held && !error && <p style={{ color: "#64748b" }}>Loading…</p>}
      {held && (
        <section style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 16, padding: 18, margin: "14px 0" }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>{held.origin} → {held.destination}</h2>
          <p style={{ color: "#64748b", margin: "4px 0 12px" }}>
            {held.departureDate ? new Date(held.departureDate).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : ""} · {pax} traveller{pax === 1 ? "" : "s"}
            {held.pnr ? <> · PNR <b>{held.pnr}</b></> : null}
          </p>
          <p style={{ fontSize: 22, fontWeight: 800, margin: "0 0 8px" }}>{money(held.totalAmount, held.currency)}</p>
          {payable && held.heldUntil && (
            <p style={{ margin: 0, color: "#92400e" }}>Pay before {new Date(held.heldUntil).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: true })} — after that the airline releases the seats.</p>
          )}
          {held.expired && <p style={{ margin: 0, color: "#b91c1c" }}>This hold has expired and the seats were released. Please search again.</p>}
          {!payable && !held.expired && <p style={{ margin: 0, color: "#475569" }}>This booking is {held.status.toLowerCase().replace("_", " ")} — no payment is needed here.</p>}
        </section>
      )}
      {error && <p role="alert" style={{ color: "#b91c1c" }}>{error}</p>}
      {payable && (
        <button type="button" onClick={pay} disabled={busy}
          style={{ width: "100%", height: 52, border: 0, borderRadius: 14, background: "#E31E24", color: "#fff", fontSize: 16, fontWeight: 800, cursor: "pointer", opacity: busy ? .7 : 1 }}>
          {busy ? "Opening payment…" : "Pay now"}
        </button>
      )}
      <p style={{ marginTop: 18 }}><a href="/" style={{ color: "#E31E24", fontWeight: 700, textDecoration: "none" }}>← Search flights</a></p>
    </main>
  );
}
