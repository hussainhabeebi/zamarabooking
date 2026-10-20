"use client";
import { FormEvent, useState } from "react";
import { api, setToken } from "../../../lib/api";

export default function RegisterPage() {
  const [f, setF] = useState({
    businessName: "", ownerName: "", email: "", phone: "", whatsapp: "", region: "INDIA", currency: "INR",
    iataCode: "", gstNumber: "", address: "", password: "", confirm: "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (f.password !== f.confirm) { setError("Passwords do not match"); return; }
    setLoading(true); setError("");
    try {
      const { confirm: _c, ...body } = f;
      const d = await api<{ token: string }>("/api/agent-public/register", {
        auth: false,
        json: Object.fromEntries(Object.entries(body).filter(([, v]) => v !== "")),
      });
      setToken(d.token);
      window.location.assign("/settings?welcome=1");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth-card wide">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="FlyPoomas" style={{ height: 40, margin: "0 auto 12px", display: "block" }} />
        <h1>Register your agency</h1>
        <p className="sub">Book flights at agent prices, earn commission, add sub-agents and staff. We approve new agencies after a quick KYC check.</p>
        {error && <div className="banner bad" role="alert">{error}</div>}
        <form onSubmit={submit} className="stack">
          <div className="grid g2">
            <label className="f">Agency / business name<input required value={f.businessName} onChange={set("businessName")} /></label>
            <label className="f">Owner name<input required value={f.ownerName} onChange={set("ownerName")} /></label>
            <label className="f">Email<input type="email" required value={f.email} onChange={set("email")} autoComplete="email" /></label>
            <label className="f">Mobile<input required value={f.phone} onChange={set("phone")} placeholder="+91 98765 43210" /></label>
            <label className="f">WhatsApp (optional)<input value={f.whatsapp} onChange={set("whatsapp")} /></label>
            <label className="f">IATA code (optional)<input value={f.iataCode} onChange={set("iataCode")} /></label>
            <label className="f">Region
              <select value={f.region} onChange={(e) => setF((s) => ({ ...s, region: e.target.value, currency: e.target.value === "GCC" ? "AED" : "INR" }))}>
                <option value="INDIA">India</option><option value="GCC">Gulf (GCC)</option>
              </select>
            </label>
            <label className="f">Wallet currency
              <select value={f.currency} onChange={set("currency")}><option value="INR">INR</option><option value="AED">AED</option><option value="USD">USD</option></select>
            </label>
            <label className="f">GSTIN / TRN (optional)<input value={f.gstNumber} onChange={set("gstNumber")} /></label>
            <label className="f">Address (optional)<input value={f.address} onChange={set("address")} /></label>
            <label className="f">Password<input type="password" required minLength={8} value={f.password} onChange={set("password")} autoComplete="new-password" /></label>
            <label className="f">Confirm password<input type="password" required minLength={8} value={f.confirm} onChange={set("confirm")} autoComplete="new-password" /></label>
          </div>
          <button className="btn primary" disabled={loading}>{loading ? "Creating your account…" : "Register agency"}</button>
        </form>
        <p className="muted small" style={{ textAlign: "center", marginTop: 18 }}>Already registered? <a href="/login">Sign in</a></p>
      </div>
    </main>
  );
}
