"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail]   = useState("");
  const [pass, setPass]     = useState("");
  const [error, setError]   = useState("");
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("ready")) setReady(true);
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/login`, {
        method:      "POST",
        credentials: "include",
        headers:     { "Content-Type": "application/json", "x-tenant-slug": "poomas" },
        body:        JSON.stringify({ email, password: pass }),
      });

      if (res.ok) {
        const { token, role } = await res.json() as { token: string; role?: string };
        if (!["SUPER_ADMIN", "TENANT_ADMIN", "STAFF"].includes(role ?? "")) {
          setError("This login doesn't have admin access. Agencies sign in at the agent portal.");
          return;
        }
        document.cookie = `poomas_admin_token=${token}; Path=/; SameSite=Lax; Secure`;
        router.push("/dashboard");
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string; message?: string };
        setError(data.message ?? data.error ?? "Login failed");
      }
    } catch (err) {
      setError("Network error — check API URL and CORS settings");
      console.error("[login]", err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#0f172a",
    }}>
      <div style={{
        background: "#1e293b", borderRadius: 12, padding: "40px 48px",
        border: "1px solid #334155", width: "100%", maxWidth: 420,
      }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="POOMAS Traveldays" height={36} style={{ display: "inline-block" }} />
          <div style={{ fontSize: 13, color: "#64748b", marginTop: 8 }}>Admin panel</div>
        </div>

        {ready && !error && (
          <div style={{ background: "rgba(34,197,94,.12)", color: "#86efac", padding: "10px 14px", borderRadius: 6, marginBottom: 20, fontSize: 14 }}>
            Password saved — sign in with your email and new password.
          </div>
        )}
        {error && (
          <div style={{
            background: "#450a0a", color: "#fca5a5", padding: "10px 14px",
            borderRadius: 6, marginBottom: 20, fontSize: 14,
          }}>
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <input
            type="email" placeholder="Admin email" value={email}
            onChange={(e) => setEmail(e.target.value)} required
            style={inputStyle}
          />
          <input
            type="password" placeholder="Password" value={pass}
            onChange={(e) => setPass(e.target.value)} required
            style={inputStyle}
          />
          <button
            type="submit" disabled={loading}
            style={{
              background: "#E31E24", color: "white",
              border: "none", borderRadius: 8, padding: "13px",
              fontWeight: 700, fontSize: 15, cursor: "pointer",
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? "Signing in…" : "Sign In"}
          </button>
          <a href={`/forgot-password${email ? `?email=${encodeURIComponent(email.trim())}` : ""}`} style={{ color: "#93c5fd", fontSize: 13, textAlign: "center" }}>Forgot password?</a>
        </form>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "12px 14px",
  border: "1.5px solid #334155",
  borderRadius: 8, fontSize: 15,
  width: "100%", boxSizing: "border-box",
  background: "#0f172a", color: "#e2e8f0",
};
