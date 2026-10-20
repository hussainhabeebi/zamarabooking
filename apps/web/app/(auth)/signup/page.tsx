"use client";
import { useState, type FormEvent } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";

export default function SignupPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    setLoading(true); setError("");
    try {
      const res = await fetch(`${API}/api/auth/customer/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": "poomas" },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password, ...(phone.trim() ? { phone: phone.trim() } : {}) }),
      });
      const data = await res.json().catch(() => ({})) as { token?: string; error?: string };
      if (!res.ok || !data.token) throw new Error(data.error ?? "Could not create your account. Please try again.");
      document.cookie = `poomas_token=${data.token}; Path=/; SameSite=Lax; Secure; Max-Age=86400`;
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.assign(next && next.startsWith("/") && !next.startsWith("//") ? next : "/wallet");
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  }

  return (
    <main style={{ minHeight: "calc(100vh - 64px)", display: "grid", placeItems: "center", padding: "24px 16px", background: "#f8fafc" }}>
      <section style={{ width: "100%", maxWidth: 420, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 18, padding: "28px 22px", boxShadow: "0 18px 45px rgba(15,23,42,.08)" }}>
        <h1 style={{ margin: "0 0 6px", fontSize: 24, fontWeight: 800, color: "#0f172a" }}>Create your account</h1>
        <p style={{ margin: "0 0 20px", color: "#64748b", fontSize: 14 }}>
          Earn <strong style={{ color: "#E31E24" }}>₹50 wallet bonus</strong> on every confirmed booking and pay with your wallet next time.
        </p>
        {error && <div style={{ background: "#FEE2E2", color: "#991B1B", padding: "10px 12px", borderRadius: 8, fontSize: 13, marginBottom: 14 }}>{error}</div>}
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Full name"><input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" style={inputStyle} /></Field>
          <Field label="Email"><input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" style={inputStyle} /></Field>
          <Field label="Mobile (optional)"><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" placeholder="+91…" style={inputStyle} /></Field>
          <Field label="Password"><input required type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder="At least 8 characters" style={inputStyle} /></Field>
          <button type="submit" disabled={loading} style={{ marginTop: 4, background: "#E31E24", color: "#fff", border: 0, borderRadius: 10, padding: 14, fontWeight: 800, fontSize: 15, cursor: loading ? "default" : "pointer", opacity: loading ? .7 : 1, fontFamily: "inherit" }}>
            {loading ? "Creating account…" : "Create account"}
          </button>
        </form>
        <p style={{ margin: "18px 0 0", textAlign: "center", fontSize: 14, color: "#64748b" }}>
          Already have an account? <a href="/login" style={{ color: "#E31E24", fontWeight: 700 }}>Sign in</a>
        </p>
      </section>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 13, fontWeight: 600, color: "#334155" }}>{label}{children}</label>;
}

const inputStyle: React.CSSProperties = {
  padding: "12px 14px", border: "1.5px solid #e2e8f0", borderRadius: 10, fontSize: 15,
  width: "100%", boxSizing: "border-box", outline: "none", fontFamily: "inherit", fontWeight: 400,
};
