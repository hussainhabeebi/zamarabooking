"use client";
import { FormEvent, useEffect, useState } from "react";
import { api, setToken } from "../../../lib/api";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("registered")) setNote("Account created — please sign in.");
    if (q.get("reset")) setNote("Password changed — sign in with your new password.");
    if (q.get("email")) setEmail(q.get("email") ?? "");
  }, []);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setLoading(true); setError("");
    try {
      const d = await api<{ token: string; role: string }>("/api/auth/login", { json: { email: email.trim(), password: pass }, auth: false });
      if (!d.role?.startsWith("AGENT_")) { setError("This is the agency portal. Customers sign in at flypoomas.com."); return; }
      setToken(d.token);
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.assign(next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="FlyPoomas" style={{ height: 40, margin: "0 auto 12px", display: "block" }} />
        <h1>Agent portal</h1>
        <p className="sub">Sign in to book flights and manage your agency</p>
        {note && <div className="banner ok">{note}</div>}
        {error && <div className="banner bad" role="alert">{error}</div>}
        <form onSubmit={handleLogin} className="stack">
          <label className="f">Email<input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="f">Password<input type="password" required autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} /></label>
          <a href={`/forgot-password${email ? `?email=${encodeURIComponent(email.trim())}` : ""}`} className="small" style={{ alignSelf: "flex-end", marginTop: -4 }}>Forgot password?</a>
          <button className="btn primary" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</button>
        </form>
        <p className="muted small" style={{ textAlign: "center", marginTop: 18 }}>New agency? <a href="/register">Register your agency</a></p>
      </div>
    </main>
  );
}
