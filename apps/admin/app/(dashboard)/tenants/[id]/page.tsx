"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { API, apiHeaders } from "../../../../lib/api";

interface Tenant {
  id: string; name: string; slug: string; customDomain: string | null; status: string; plan: string;
  region: string; defaultCurrency: string; companyName: string | null; tagline: string | null;
  logoUrl: string | null; primaryColor: string; secondaryColor: string; accentColor: string;
  supportEmail: string | null; supportPhone: string | null; showPoweredBy: boolean; createdAt: string;
}
interface Detail {
  tenant: Tenant;
  stats: { bookings: number; ticketed: number; agents: number };
  suppliers: Array<{ supplier: string; isEnabled: boolean; priority: number }>;
}

const STATUS_COLOR: Record<string, string> = { ACTIVE: "#10B981", ONBOARDING: "#F7941D", SUSPENDED: "#EF4444", TRIAL_EXPIRED: "#9CA3AF", CLOSED: "#6B7280" };

export default function TenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [branding, setBranding] = useState({ companyName: "", tagline: "", logoUrl: "", primaryColor: "", secondaryColor: "", accentColor: "" });

  async function load() {
    setError("");
    try {
      const res = await fetch(`${API}/api/admin/tenants/${id}`, { headers: apiHeaders() });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setData(body);
      const t: Tenant = body.tenant;
      setBranding({ companyName: t.companyName ?? "", tagline: t.tagline ?? "", logoUrl: t.logoUrl ?? "", primaryColor: t.primaryColor, secondaryColor: t.secondaryColor, accentColor: t.accentColor });
    } catch (e: any) { setError(e.message); }
  }
  useEffect(() => { load(); }, [id]);

  async function send(path: string, body: unknown, done: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const res = await fetch(`${API}/api/admin/tenants/${id}/${path}`, { method: "PATCH", headers: apiHeaders(), body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
      setNotice(done);
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  function setStatus(status: string) {
    if (!confirm(`Change ${data?.tenant.name} to ${status}?`)) return;
    send("status", { status }, `Status changed to ${status}`);
  }

  function saveBranding() {
    const body = Object.fromEntries(Object.entries(branding).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, v.trim()]));
    send("branding", body, "Branding saved");
  }

  if (error && !data) return <div><a href="/tenants" style={back}>← Tenants</a><div style={errBox}>{error}</div></div>;
  if (!data) return <p style={{ color: "#64748b" }}>Loading…</p>;
  const t = data.tenant;

  return (
    <div>
      <a href="/tenants" style={back}>← Tenants</a>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", margin: "8px 0 20px" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", margin: 0 }}>{t.name}</h1>
          <div style={{ color: "#94a3b8", fontSize: 13 }}>{t.slug}.flypoomas.com{t.customDomain ? ` · ${t.customDomain}` : ""}</div>
        </div>
        <span style={{ color: STATUS_COLOR[t.status] ?? "#9ca3af", fontWeight: 700 }}>● {t.status}</span>
      </div>

      {error && <div style={errBox}>{error}</div>}
      {notice && <div style={okBox}>{notice}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
        <Stat label="Bookings" value={data.stats.bookings} />
        <Stat label="Ticketed" value={data.stats.ticketed} />
        <Stat label="Agents" value={data.stats.agents} />
        <Stat label="Plan" value={t.plan} />
      </div>

      <div style={card}>
        <h2 style={h2}>Details</h2>
        <dl style={dl}>
          <Row k="Region" v={t.region} />
          <Row k="Currency" v={t.defaultCurrency} />
          <Row k="Support email" v={t.supportEmail ?? "—"} />
          <Row k="Support phone" v={t.supportPhone ?? "—"} />
          <Row k="Powered-by badge" v={t.showPoweredBy ? "Shown" : "Hidden"} />
          <Row k="Created" v={new Date(t.createdAt).toLocaleString("en-IN")} />
          <Row k="Tenant ID" v={t.id} />
        </dl>
      </div>

      <div style={card}>
        <h2 style={h2}>Status</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {["ACTIVE", "ONBOARDING", "SUSPENDED", "CLOSED"].filter((s) => s !== t.status).map((s) => (
            <button key={s} disabled={busy} onClick={() => setStatus(s)} style={s === "ACTIVE" ? btn : btnGhost}>
              {s === "ACTIVE" ? "Activate" : s === "SUSPENDED" ? "Suspend" : s === "CLOSED" ? "Close" : "Back to onboarding"}
            </button>
          ))}
        </div>
      </div>

      <div style={card}>
        <h2 style={h2}>Suppliers</h2>
        {data.suppliers.length === 0 ? <p style={{ color: "#64748b", fontSize: 13 }}>No supplier configs.</p> : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {data.suppliers.sort((a, b) => a.priority - b.priority).map((s) => (
              <span key={s.supplier} style={{ ...pill, color: s.isEnabled ? "#4ade80" : "#64748b" }}>{s.priority}. {s.supplier} · {s.isEnabled ? "on" : "off"}</span>
            ))}
          </div>
        )}
        <p style={{ color: "#64748b", fontSize: 12, marginTop: 8 }}>Manage supplier credentials on the <a href="/suppliers" style={{ color: "#E31E24" }}>Suppliers</a> page.</p>
      </div>

      <div style={card}>
        <h2 style={h2}>Branding</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          {([
            ["companyName", "Company name"], ["tagline", "Tagline"], ["logoUrl", "Logo URL"],
            ["primaryColor", "Primary colour"], ["secondaryColor", "Secondary colour"], ["accentColor", "Accent colour"],
          ] as const).map(([k, label]) => (
            <label key={k} style={lbl}>{label}
              <input value={branding[k]} onChange={(e) => setBranding({ ...branding, [k]: e.target.value })} style={input} />
            </label>
          ))}
        </div>
        <button disabled={busy} onClick={saveBranding} style={{ ...btn, marginTop: 12 }}>Save branding</button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div style={{ ...card, marginBottom: 0 }}><div style={{ color: "#64748b", fontSize: 12 }}>{label}</div><div style={{ color: "#f1f5f9", fontSize: 20, fontWeight: 700 }}>{value}</div></div>;
}
function Row({ k, v }: { k: string; v: string }) {
  return <><dt style={{ color: "#64748b" }}>{k}</dt><dd style={{ color: "#e2e8f0", margin: 0, wordBreak: "break-all" }}>{v}</dd></>;
}

const back: React.CSSProperties = { color: "#94a3b8", fontSize: 13, textDecoration: "none" };
const card: React.CSSProperties = { background: "#1e293b", borderRadius: 12, padding: 16, border: "1px solid #334155", marginBottom: 16 };
const h2: React.CSSProperties = { fontSize: 15, fontWeight: 700, color: "#f1f5f9", margin: "0 0 12px" };
const dl: React.CSSProperties = { display: "grid", gridTemplateColumns: "160px 1fr", gap: "8px 12px", fontSize: 13, margin: 0 };
const pill: React.CSSProperties = { background: "#0f172a", border: "1px solid #334155", borderRadius: 20, padding: "4px 10px", fontSize: 12, fontWeight: 700 };
const lbl: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, color: "#94a3b8", fontSize: 12 };
const input: React.CSSProperties = { background: "#0f172a", border: "1px solid #334155", borderRadius: 8, padding: "8px 10px", color: "#f1f5f9", fontSize: 14 };
const btn: React.CSSProperties = { background: "#E31E24", color: "#fff", border: 0, borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" };
const btnGhost: React.CSSProperties = { ...btn, background: "#0f172a", border: "1px solid #334155", color: "#e2e8f0" };
const errBox: React.CSSProperties = { background: "rgba(239,68,68,.1)", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 8, padding: "10px 12px", fontSize: 13, margin: "12px 0" };
const okBox: React.CSSProperties = { ...errBox, background: "rgba(74,222,128,.1)", border: "1px solid #166534", color: "#86efac" };
