"use client";
import { useEffect, useState, type FormEvent } from "react";
import { apiCall, readCustomerToken, signOut } from "../lib/customer-api";

interface Account { name: string | null; email: string | null; phone: string | null; whatsappOptIn: boolean; hasPassword: boolean; socialProvider: string | null }
interface SavedPax { id: string; firstName: string; lastName: string; dob: string | null; nationality: string | null; passportNumber: string | null }

export default function AccountPage() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [whatsapp, setWhatsapp] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pax, setPax] = useState<SavedPax[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("password") === "reset") setNotice("Your password has been changed and you're signed in.");
  }, []);

  async function load() {
    try {
      const [a, p] = await Promise.all([
        apiCall<{ account: Account }>("/api/profile/account"),
        apiCall<{ passengers?: SavedPax[] } | SavedPax[]>("/api/profile/passengers").catch(() => []),
      ]);
      setAccount(a.account); setName(a.account.name ?? ""); setPhone(a.account.phone ?? ""); setWhatsapp(a.account.whatsappOptIn);
      setPax(Array.isArray(p) ? p : p.passengers ?? []);
    } catch (e: any) {
      if (e.status === 401 || e.status === 403) setSignedIn(false); else setError(e.message);
    }
  }

  useEffect(() => {
    const ok = Boolean(readCustomerToken());
    setSignedIn(ok);
    if (ok) load();
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  if (signedIn === false) {
    return (
      <main className="account-entry-page">
        <section className="account-entry-card" aria-labelledby="account-entry-title">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="account-entry-logo" src="/logo.png" alt="" width="64" height="60" />
          <p className="account-entry-eyebrow">WELCOME TO FLYPOOMAS</p>
          <h1 id="account-entry-title">Your FlyPoomas account</h1>
          <p className="account-entry-intro">Manage your bookings, saved travellers, wallet and travel details in one place.</p>
          <div className="account-entry-actions"><a href="/login?next=/account" className="account-entry-primary">Sign in</a><a href="/signup?next=/account" className="account-entry-secondary">Create account</a></div>
          <div className="account-entry-benefits" aria-label="Your account can help you">
            <span>Manage your trips</span>
            <span>Save traveller details</span>
            <span>Access your wallet</span>
          </div>
        </section>
      </main>
    );
  }
  if (!account) return <main className="page-container" style={{ padding: "32px 16px" }}>{error || "Loading…"}</main>;

  return (
    <main className="page-container" style={{ padding: "24px 16px 48px", maxWidth: 720 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Hi{account.name ? `, ${account.name.split(" ")[0]}` : ""}</h1>
        <button onClick={() => { signOut(); window.location.assign("/"); }} style={{ ...btn2, cursor: "pointer" }}>Sign out</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10, marginBottom: 14 }}>
        <a href="/trips" style={tile}>✈️ <strong>My Trips</strong><small>Bookings, e-tickets, cancellations</small></a>
        <a href="/wallet" style={tile}>👛 <strong>Wallet</strong><small>Balance, bonus & coupons</small></a>
        <a href="/trips/find" style={tile}>🔎 <strong>Find a booking</strong><small>Guest booking by PNR</small></a>
      </div>

      {error && <div style={{ ...box, background: "#FEE2E2", color: "#991B1B" }}>{error}</div>}
      {notice && <div style={{ ...box, background: "#DCFCE7", color: "#166534" }}>{notice}</div>}

      <section style={card}>
        <h2 style={h2}>Profile</h2>
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); run(async () => {
          await apiCall("/api/profile/account", { method: "PUT", body: JSON.stringify({ name: name.trim(), phone: phone.trim() || null, whatsappOptIn: whatsapp }) });
          setNotice("Profile saved."); await load(); window.dispatchEvent(new Event("poomas:profile-updated"));
        }); }} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={label}>Email<input value={account.email ?? ""} disabled style={{ ...input, background: "#f8fafc" }} /></label>
          <label style={label}>Full name<input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} style={input} /></label>
          <label style={label}>Mobile<input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91…" style={input} /></label>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
            <input type="checkbox" checked={whatsapp} onChange={(e) => setWhatsapp(e.target.checked)} /> Send booking updates on WhatsApp
          </label>
          <button type="submit" disabled={busy} style={{ ...btn, alignSelf: "flex-start", border: 0, cursor: "pointer" }}>Save profile</button>
        </form>
      </section>

      <section style={{ ...card, marginTop: 12 }}>
        <h2 style={h2}>{account.hasPassword ? "Change password" : "Set a password"}</h2>
        {!account.hasPassword && <p style={muted}>You signed in with {account.socialProvider ?? "a social account"}. Set a password to also sign in with email.</p>}
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); run(async () => {
          await apiCall("/api/profile/account/password", { method: "POST", body: JSON.stringify({ currentPassword: currentPw || undefined, newPassword: newPw }) });
          setCurrentPw(""); setNewPw(""); setNotice("Password updated."); await load();
        }); }} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {account.hasPassword && <label style={label}>Current password<input required type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} autoComplete="current-password" style={input} /></label>}
          <label style={label}>New password<input required type="password" minLength={8} value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" placeholder="At least 8 characters" style={input} /></label>
          <button type="submit" disabled={busy} style={{ ...btn, alignSelf: "flex-start", border: 0, cursor: "pointer" }}>Update password</button>
        </form>
      </section>

      <section style={{ ...card, marginTop: 12 }}>
        <h2 style={h2}>Saved travellers</h2>
        <p style={muted}>Tick "save traveller details" when booking to fill forms faster next time.</p>
        {pax.length === 0 ? <p style={muted}>No saved travellers yet.</p> : pax.map((p) => (
          <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "9px 0", borderTop: "1px solid #f1f5f9" }}>
            <span><strong>{p.firstName} {p.lastName}</strong><small style={{ display: "block", color: "#64748b" }}>{[p.nationality, p.passportNumber ? `Passport ••••${p.passportNumber.slice(-4)}` : null].filter(Boolean).join(" · ")}</small></span>
            <button disabled={busy} onClick={() => { if (confirm(`Remove ${p.firstName} ${p.lastName}?`)) run(async () => { await apiCall(`/api/profile/passengers/${p.id}`, { method: "DELETE" }); await load(); }); }}
              style={{ background: "#f1f5f9", border: 0, borderRadius: 8, padding: "7px 10px", fontWeight: 700, fontSize: 12, color: "#991b1b", cursor: "pointer" }}>Remove</button>
          </div>
        ))}
      </section>
    </main>
  );
}

const card: React.CSSProperties = { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 16, padding: 16 };
const h2: React.CSSProperties = { margin: "0 0 10px", fontSize: 16, fontWeight: 800 };
const muted: React.CSSProperties = { margin: "0 0 10px", color: "#64748b", fontSize: 13 };
const label: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5, fontSize: 13, fontWeight: 600, color: "#334155" };
const input: React.CSSProperties = { padding: "11px 12px", border: "1.5px solid #e2e8f0", borderRadius: 10, fontSize: 15, fontFamily: "inherit", fontWeight: 400 };
const btn: React.CSSProperties = { display: "inline-block", background: "#E31E24", color: "#fff", borderRadius: 10, padding: "10px 14px", fontWeight: 800, fontSize: 14, textDecoration: "none", fontFamily: "inherit" };
const btn2: React.CSSProperties = { ...btn, background: "#fff", color: "#0f172a", border: "1.5px solid #e2e8f0" };
const tile: React.CSSProperties = { ...card, display: "flex", flexDirection: "column", gap: 2, textDecoration: "none", color: "#0f172a", fontSize: 14 };
const box: React.CSSProperties = { padding: "10px 14px", borderRadius: 10, fontSize: 14, marginBottom: 12 };
