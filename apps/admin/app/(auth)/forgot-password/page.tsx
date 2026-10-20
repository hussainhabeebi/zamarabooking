"use client";
import { useEffect, useState } from "react";
import { API } from "../../../lib/api";
import AuthCard, { authButton, authInput, authNote } from "../AuthCard";

export default function AdminForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setEmail(new URLSearchParams(window.location.search).get("email") ?? ""); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const res = await fetch(`${API}/api/auth/staff/forgot`, { method: "POST", headers: { "Content-Type": "application/json", "x-tenant-slug": "poomas" }, body: JSON.stringify({ email: email.trim(), origin: window.location.origin }) });
      const d = await res.json().catch(() => ({})) as { message?: string; error?: string };
      if (!res.ok) throw new Error(d.error ?? "Couldn't send the link");
      setSent(d.message ?? "Check your email.");
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't send the link"); } finally { setBusy(false); }
  }

  return (
    <AuthCard title="Reset admin password">
      {error && <div style={authNote(false)} role="alert">{error}</div>}
      {sent ? <div style={authNote(true)} role="status">{sent} The link works for 1 hour.</div> : (
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <input type="email" placeholder="Admin email" required value={email} onChange={(e) => setEmail(e.target.value)} style={authInput} />
          <button disabled={busy} style={authButton(busy)}>{busy ? "Sending…" : "Send reset link"}</button>
        </form>
      )}
      <p style={{ textAlign: "center", marginTop: 16 }}><a href="/login" style={{ color: "#93c5fd", fontSize: 13 }}>Back to sign in</a></p>
    </AuthCard>
  );
}
