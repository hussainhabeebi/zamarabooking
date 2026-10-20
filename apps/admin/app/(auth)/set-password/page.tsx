"use client";
import { useEffect, useState } from "react";
import { API } from "../../../lib/api";
import AuthCard, { authButton, authInput, authNote } from "../AuthCard";

// Invitation and password-reset links both land here.
export default function AdminSetPasswordPage() {
  const [token, setToken] = useState("");
  const [info, setInfo] = useState<{ email: string; name: string; kind: string } | null>(null);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const headers = { "Content-Type": "application/json", "x-tenant-slug": "poomas" };

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token") ?? "";
    setToken(t);
    if (!t) { setError("This link is incomplete."); return; }
    fetch(`${API}/api/auth/staff/password/${encodeURIComponent(t)}`, { headers })
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? "This link has expired."); setInfo(d); })
      .catch((e) => setError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pass !== pass2) { setError("The two passwords don't match."); return; }
    setBusy(true); setError("");
    try {
      const res = await fetch(`${API}/api/auth/staff/password/${encodeURIComponent(token)}`, { method: "POST", headers, body: JSON.stringify({ password: pass }) });
      const d = await res.json().catch(() => ({})) as { error?: string; email?: string };
      if (!res.ok) throw new Error(d.error ?? "Couldn't save the password");
      window.location.assign(`/login?ready=1`);
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't save the password"); setBusy(false); }
  }

  return (
    <AuthCard title={info?.kind === "invite" ? "Set up your admin login" : "Choose a new password"}>
      {info && <p style={{ textAlign: "center", color: "#94a3b8", fontSize: 14, margin: "-12px 0 16px" }}>{info.name ? `${info.name} · ` : ""}{info.email}</p>}
      {error && <div style={authNote(false)} role="alert">{error}</div>}
      {info && (
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <input type="password" placeholder="New password (10+ characters)" required minLength={10} autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} style={authInput} />
          <input type="password" placeholder="Repeat password" required minLength={10} autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} style={authInput} />
          <button disabled={busy} style={authButton(busy)}>{busy ? "Saving…" : "Save password"}</button>
        </form>
      )}
      <p style={{ textAlign: "center", marginTop: 16 }}><a href={info ? "/login" : "/forgot-password"} style={{ color: "#93c5fd", fontSize: 13 }}>{info ? "Back to sign in" : "Send a new reset link"}</a></p>
    </AuthCard>
  );
}
