"use client";
import { useEffect, useState, type FormEvent } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => { setEmail(new URLSearchParams(window.location.search).get("email") ?? ""); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true); setError("");
    try {
      const res = await fetch(`${API}/api/auth/customer/forgot`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email.trim() }) });
      const d = await res.json().catch(() => ({})) as { message?: string; error?: string };
      if (!res.ok) throw new Error(d.error ?? "Couldn't send the link. Please try again.");
      setSent(d.message ?? "Check your email.");
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't send the link."); } finally { setLoading(false); }
  }

  return (
    <div className="wa-desktop-fallback">
      <div className="wa-desktop-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="FlyPoomas" className="login-brand-logo" width="72" height="68" />
        <h1 className="login-title">Forgot your password?</h1>
        <p className="login-intro">Enter the email you use for FlyPoomas and we&apos;ll send you a link to choose a new one.</p>
        {sent ? (
          <div role="status" style={{ background: "#DCFCE7", color: "#166534", padding: "12px 14px", borderRadius: 8, fontSize: 14 }}>{sent} The link works for 1 hour.</div>
        ) : (
          <form onSubmit={submit} className="login-form">
            {error && <div role="alert" style={{ background: "#FEE2E2", color: "#991B1B", padding: "10px 14px", borderRadius: 6, fontSize: 13 }}>{error}</div>}
            <label className="login-field">Email address
              <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <button type="submit" disabled={loading} className="login-submit">{loading ? "Sending…" : "Send reset link"}</button>
          </form>
        )}
        <p className="login-signup-prompt"><a href="/login">Back to sign in</a></p>
      </div>
    </div>
  );
}
