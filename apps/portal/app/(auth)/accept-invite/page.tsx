"use client";
import { FormEvent, useEffect, useState } from "react";
import { api, setToken } from "../../../lib/api";

export default function AcceptInvitePage() {
  const [token, setTok] = useState("");
  const [invite, setInvite] = useState<{ email: string; name: string; role: string; businessName: string } | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [pass, setPass] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token") ?? "";
    setTok(t);
    if (!t) { setError("This invitation link is incomplete."); return; }
    api<{ email: string; name: string; role: string; businessName: string }>(`/api/agent-public/invite/${encodeURIComponent(t)}`, { auth: false })
      .then((d) => { setInvite(d); setName(d.name); })
      .catch((e) => setError(e.message));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const d = await api<{ token: string }>(`/api/agent-public/invite/${encodeURIComponent(token)}/accept`, { auth: false, json: { name, password: pass, ...(phone ? { phone } : {}) } });
      setToken(d.token);
      window.location.assign("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't accept the invitation");
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <h1>Join {invite?.businessName || "your agency"}</h1>
        <p className="sub">{invite ? `${invite.email} · ${invite.role.replace("AGENT_", "").toLowerCase()}` : "Set your password to start"}</p>
        {error && <div className="banner bad" role="alert">{error}</div>}
        {invite && (
          <form onSubmit={submit} className="stack">
            <label className="f">Your name<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="f">Mobile (optional)<input value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
            <label className="f">Choose a password<input type="password" required minLength={8} value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" /></label>
            <button className="btn primary" disabled={busy}>{busy ? "Setting up…" : "Create my login"}</button>
          </form>
        )}
      </div>
    </main>
  );
}
