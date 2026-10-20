"use client";
import { useEffect, useState, type FormEvent } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";

export default function ResetPasswordPage() {
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token") ?? "";
    setToken(t);
    if (!t) { setError("This reset link is incomplete."); setChecking(false); return; }
    fetch(`${API}/api/auth/customer/reset/${encodeURIComponent(t)}`)
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? d.message ?? "This reset link has expired."); setEmail(d.email ?? ""); })
      .catch((e) => setError(e.message)).finally(() => setChecking(false));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pass !== pass2) { setError("The two passwords don't match."); return; }
    setLoading(true); setError("");
    try {
      const res = await fetch(`${API}/api/auth/customer/reset/${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pass }) });
      const d = await res.json().catch(() => ({})) as { token?: string; error?: string; message?: string };
      if (!res.ok || !d.token) throw new Error(d.error ?? d.message ?? "Couldn't change the password.");
      // Signed in with the new password.
      document.cookie = `poomas_token=${d.token}; Path=/; SameSite=Lax; Secure; Max-Age=86400`;
      window.location.assign("/account?password=reset");
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't change the password."); setLoading(false); }
  }

  const valid = !checking && !!email;
  return (
    <div className="wa-desktop-fallback">
      <div className="wa-desktop-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="FlyPoomas" className="login-brand-logo" width="72" height="68" />
        <h1 className="login-title">Choose a new password</h1>
        {email && <p className="login-intro">For {email}</p>}
        {checking && <p className="login-intro">Checking your link…</p>}
        {error && <div role="alert" style={{ background: "#FEE2E2", color: "#991B1B", padding: "10px 14px", borderRadius: 6, fontSize: 13, marginBottom: 12 }}>{error}</div>}
        {valid && (
          <form onSubmit={submit} className="login-form">
            <label className="login-field">New password
              <input type="password" autoComplete="new-password" required minLength={8} value={pass} onChange={(e) => setPass(e.target.value)} placeholder="At least 8 characters" />
            </label>
            <label className="login-field">Repeat new password
              <input type="password" autoComplete="new-password" required minLength={8} value={pass2} onChange={(e) => setPass2(e.target.value)} />
            </label>
            <button type="submit" disabled={loading} className="login-submit">{loading ? "Saving…" : "Save and sign in"}</button>
          </form>
        )}
        <p className="login-signup-prompt">{!valid && !checking ? <a href="/forgot-password">Send a new reset link</a> : <a href="/login">Back to sign in</a>}</p>
      </div>
    </div>
  );
}
