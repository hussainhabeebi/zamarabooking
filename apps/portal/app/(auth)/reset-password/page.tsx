"use client";
import { FormEvent, useEffect, useState } from "react";
import { api } from "../../../lib/api";

export default function ResetPasswordPage() {
  const [token, setTok] = useState("");
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token") ?? "";
    setTok(t);
    if (!t) { setError("This reset link is incomplete."); setChecking(false); return; }
    api<{ email: string }>(`/api/agent-public/password/reset/${encodeURIComponent(t)}`, { auth: false })
      .then((d) => setEmail(d.email)).catch((e) => setError(e.message)).finally(() => setChecking(false));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pass !== pass2) { setError("The two passwords don't match."); return; }
    setBusy(true); setError("");
    try {
      const d = await api<{ email: string }>(`/api/agent-public/password/reset/${encodeURIComponent(token)}`, { auth: false, json: { password: pass } });
      window.location.assign(`/login?reset=1&email=${encodeURIComponent(d.email ?? email)}`);
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't change the password"); setBusy(false); }
  }

  const valid = !checking && email;
  return (
    <main className="auth">
      <div className="auth-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="FlyPoomas" style={{ height: 40, margin: "0 auto 12px", display: "block" }} />
        <h1>Choose a new password</h1>
        {email && <p className="sub">For {email}</p>}
        {error && <div className="banner bad" role="alert">{error}</div>}
        {checking && <p className="muted">Checking the link…</p>}
        {valid && (
          <form onSubmit={submit} className="stack">
            <label className="f">New password<input type="password" required minLength={8} autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} /></label>
            <label className="f">Repeat new password<input type="password" required minLength={8} autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} /></label>
            <p className="small muted" style={{ margin: 0 }}>At least 8 characters.</p>
            <button className="btn primary" disabled={busy}>{busy ? "Saving…" : "Save new password"}</button>
          </form>
        )}
        <p className="muted small" style={{ textAlign: "center", marginTop: 18 }}>
          {error && !valid ? <a href="/forgot-password">Send a new reset link</a> : <a href="/login">Back to sign in</a>}
        </p>
      </div>
    </main>
  );
}
