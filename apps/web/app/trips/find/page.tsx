"use client";
import { useState, type FormEvent } from "react";
import { apiCall, saveGuestToken } from "../../lib/customer-api";

export default function FindBookingPage() {
  const [reference, setReference] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true); setError("");
    try {
      const r = await apiCall<{ token: string }>("/api/trips/lookup", {
        method: "POST", auth: "guest", body: JSON.stringify({ reference: reference.trim(), email: email.trim() }),
      });
      saveGuestToken(r.token);
      window.location.assign("/trips/guest");
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  }

  return (
    <main className="page-container" style={{ padding: "32px 16px", maxWidth: 480 }}>
      <section style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 16, padding: 22 }}>
        <h1 style={{ margin: "0 0 6px", fontSize: 22, fontWeight: 800 }}>Find your booking</h1>
        <p style={{ margin: "0 0 18px", color: "#64748b", fontSize: 14 }}>Enter your PNR or booking reference and the email used when booking.</p>
        {error && <div style={{ background: "#FEE2E2", color: "#991B1B", padding: "10px 12px", borderRadius: 8, fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={label}>PNR / booking reference
            <input required minLength={5} value={reference} onChange={(e) => setReference(e.target.value.toUpperCase())} placeholder="e.g. ABC123 or TJS1168…" style={input} />
          </label>
          <label style={label}>Email
            <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" style={input} />
          </label>
          <button type="submit" disabled={loading} style={{ background: "#E31E24", color: "#fff", border: 0, borderRadius: 10, padding: 13, fontWeight: 800, fontSize: 15, cursor: "pointer", opacity: loading ? .7 : 1, fontFamily: "inherit" }}>
            {loading ? "Looking up…" : "Find booking"}
          </button>
        </form>
        <p style={{ margin: "16px 0 0", fontSize: 13, color: "#64748b" }}>Have an account? <a href="/trips" style={{ color: "#E31E24", fontWeight: 700 }}>See all your trips</a></p>
      </section>
    </main>
  );
}

const label: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5, fontSize: 13, fontWeight: 600, color: "#334155" };
const input: React.CSSProperties = { padding: "12px 14px", border: "1.5px solid #e2e8f0", borderRadius: 10, fontSize: 15, fontFamily: "inherit", fontWeight: 400 };
