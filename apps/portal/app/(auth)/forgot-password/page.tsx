"use client";
import { FormEvent, useEffect, useState } from "react";
import { api } from "../../../lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { setEmail(new URLSearchParams(window.location.search).get("email") ?? ""); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const d = await api<{ message: string }>("/api/agent-public/password/forgot", { auth: false, json: { email: email.trim() } });
      setSent(d.message);
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't send the link"); } finally { setBusy(false); }
  }

  return (
    <main className="auth">
      <div className="auth-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="FlyPoomas" style={{ height: 40, margin: "0 auto 12px", display: "block" }} />
        <h1>Reset password</h1>
        <p className="sub">Enter your agency login email. We&apos;ll send a link to choose a new password.</p>
        {error && <div className="banner bad" role="alert">{error}</div>}
        {sent ? (
          <div className="banner ok" role="status">{sent} The link works for 1 hour.</div>
        ) : (
          <form onSubmit={submit} className="stack">
            <label className="f">Email<input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <button className="btn primary" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
          </form>
        )}
        <p className="muted small" style={{ textAlign: "center", marginTop: 18 }}>
          Haven&apos;t set up your login yet? Use the same form — we&apos;ll send a new invitation. <br /><a href="/login">Back to sign in</a>
        </p>
      </div>
    </main>
  );
}
