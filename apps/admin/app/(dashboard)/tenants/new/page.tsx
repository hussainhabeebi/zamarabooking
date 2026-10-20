"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { API, apiHeaders } from "../../../../lib/api";

export default function NewTenantPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", slug: "", customDomain: "", plan: "TRIAL", region: "INDIA", defaultCurrency: "INR", supportEmail: "", primaryColor: "#E31E24" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const v = e.target.value;
    setForm((f) => ({
      ...f, [k]: v,
      // Suggest a slug from the name until the admin edits the slug themselves.
      ...(k === "name" && (f.slug === "" || f.slug === slugify(f.name)) ? { slug: slugify(v) } : {}),
    }));
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, v.trim()]));
      const res = await fetch(`${API}/api/admin/tenants`, { method: "POST", headers: apiHeaders(), body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        const issue = out.error?.issues?.[0];
        throw new Error(typeof out.error === "string" ? out.error : issue ? `${issue.path?.join(".")}: ${issue.message}` : `HTTP ${res.status}`);
      }
      router.push(`/tenants/${out.tenantId}`);
    } catch (e: any) { setError(e.message); setBusy(false); }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <a href="/tenants" style={{ color: "#94a3b8", fontSize: 13, textDecoration: "none" }}>← Tenants</a>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", margin: "8px 0 20px" }}>New tenant</h1>
      {error && <div style={errBox}>{error}</div>}
      <form onSubmit={submit} style={{ background: "#1e293b", borderRadius: 12, padding: 20, border: "1px solid #334155", display: "grid", gap: 14 }}>
        <label style={lbl}>Agency name *<input required minLength={2} value={form.name} onChange={set("name")} style={input} /></label>
        <label style={lbl}>Slug * <span style={{ color: "#64748b" }}>({form.slug || "slug"}.flypoomas.com)</span>
          <input required minLength={2} pattern="[a-z0-9-]+" value={form.slug} onChange={set("slug")} style={input} />
        </label>
        <label style={lbl}>Custom domain<input value={form.customDomain} onChange={set("customDomain")} placeholder="flights.example.com" style={input} /></label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14 }}>
          <label style={lbl}>Plan<select value={form.plan} onChange={set("plan")} style={input}>{["TRIAL", "STARTER", "PROFESSIONAL", "ENTERPRISE"].map((p) => <option key={p}>{p}</option>)}</select></label>
          <label style={lbl}>Region<select value={form.region} onChange={set("region")} style={input}>{["INDIA", "GCC"].map((p) => <option key={p}>{p}</option>)}</select></label>
          <label style={lbl}>Currency<select value={form.defaultCurrency} onChange={set("defaultCurrency")} style={input}>{["INR", "AED", "USD"].map((p) => <option key={p}>{p}</option>)}</select></label>
        </div>
        <label style={lbl}>Support email<input type="email" value={form.supportEmail} onChange={set("supportEmail")} style={input} /></label>
        <label style={lbl}>Primary colour<input value={form.primaryColor} onChange={set("primaryColor")} style={input} /></label>
        <button disabled={busy} style={{ background: "#E31E24", color: "#fff", border: 0, borderRadius: 8, padding: "10px 16px", fontWeight: 700, cursor: "pointer" }}>
          {busy ? "Creating…" : "Create tenant"}
        </button>
      </form>
    </div>
  );
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

const lbl: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, color: "#94a3b8", fontSize: 12 };
const input: React.CSSProperties = { background: "#0f172a", border: "1px solid #334155", borderRadius: 8, padding: "8px 10px", color: "#f1f5f9", fontSize: 14 };
const errBox: React.CSSProperties = { background: "rgba(239,68,68,.1)", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 8, padding: "10px 12px", fontSize: 13, marginBottom: 12 };
