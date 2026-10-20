"use client";
import { useState, useEffect } from "react";
import { API, apiHeaders } from "../../../lib/api";

const SCOPES = [
  { id: "search",   label: "Search",   desc: "Call POST /api/search — flight availability" },
  { id: "booking",  label: "Booking",  desc: "Create / hold bookings" },
  { id: "eticket",  label: "E-ticket", desc: "Fetch and send e-tickets" },
  { id: "webhook",  label: "Webhook",  desc: "Receive inbound webhook events" },
] as const;
type Scope = typeof SCOPES[number]["id"];

interface ApiKey {
  id:         string;
  name:       string;
  keyPrefix:  string;
  scopes:     string[];
  isActive:   boolean;
  lastUsedAt: string | null;
  expiresAt:  string | null;
  createdAt:  string;
  key?:       string;    // Present only at creation time
}

function headers() {
  return apiHeaders();
}

export default function ApiKeysPage() {
  const [keys,    setKeys]    = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKey,  setNewKey]  = useState<ApiKey | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", scopes: ["search"] as Scope[], expiresAt: "" });

  async function load() {
    setLoading(true);
    try {
      const res  = await fetch(`${API}/api/admin/api-keys`, { headers: headers() });
      if (!res.ok) throw new Error(`Unable to load API keys (${res.status})`);
      const data = await res.json();
      setKeys(Array.isArray(data) ? data as ApiKey[] : []);
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  function toggleScope(scope: Scope) {
    setForm((f) => ({
      ...f,
      scopes: f.scopes.includes(scope)
        ? f.scopes.filter((s) => s !== scope)
        : [...f.scopes, scope],
    }));
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res  = await fetch(`${API}/api/admin/api-keys`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          name:      form.name,
          scopes:    form.scopes,
          ...(form.expiresAt ? { expiresAt: new Date(form.expiresAt).toISOString() } : {}),
        }),
      });
      const created = await res.json() as ApiKey;
      setNewKey(created);
      setForm({ name: "", scopes: ["search"], expiresAt: "" });
      await load();
    } finally { setCreating(false); }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this API key? All bots using it will lose access immediately.")) return;
    await fetch(`${API}/api/admin/api-keys/${id}`, { method: "DELETE", headers: headers() });
    await load();
  }

  async function toggle(id: string, isActive: boolean) {
    await fetch(`${API}/api/admin/api-keys/${id}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ isActive }),
    });
    await load();
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", marginBottom: 8 }}>API Keys</h1>
      <p style={{ color: "#64748b", fontSize: 14, marginBottom: 24 }}>
        Issue API keys to your WhatsApp bot, third-party integrations, or test clients.
        Each key grants access to the scopes you select.
      </p>

      {/* ── Usage instructions ──────────────────────────────────────── */}
      <div style={{ ...card, marginBottom: 20, background: "#0f172a", border: "1px solid #1e3a5f" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#38bdf8", textTransform: "uppercase",
          letterSpacing: "0.05em", marginBottom: 12 }}>How to use your API key</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <CodeBlock label="Search flights (WhatsApp bot / any client)" code={`POST https://api.flypoomas.com/api/search
X-API-Key: pmsk_••••••••••••••
Content-Type: application/json

{
  "origin": "DXB",
  "destination": "BOM",
  "departureDate": "2025-02-15",
  "adults": 1,
  "cabinClass": "ECONOMY",
  "tripType": "ONEWAY"
}`} />
          <CodeBlock label="Get checkout token (after collecting passengers)" code={`POST https://api.flypoomas.com/api/checkout/session
X-API-Key: pmsk_••••••••••••••
Content-Type: application/json

{
  "bookingId": "<id from booking API>",
  "whatsappPhone": "971501234567"
}

→ Returns { token, checkoutUrl }  — send checkoutUrl to the customer on WhatsApp`} />
        </div>
      </div>

      {/* ── New key revealed ────────────────────────────────────────── */}
      {newKey && (
        <div style={{
          ...card, marginBottom: 20,
          background: "#052e16", border: "2px solid #16a34a",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#4ade80", marginBottom: 4 }}>
                ✓ API key created — copy it now, it won&apos;t be shown again
              </div>
              <div style={{ fontSize: 11, color: "#86efac" }}>Name: {newKey.name}</div>
            </div>
            <button onClick={() => setNewKey(null)} style={{
              background: "none", border: "none", color: "#4ade80", fontSize: 18, cursor: "pointer",
            }}>×</button>
          </div>
          <div style={{
            fontFamily: "monospace", fontSize: 14, color: "#f0fdf4",
            background: "#14532d", borderRadius: 8, padding: "12px 16px",
            marginTop: 12, wordBreak: "break-all", letterSpacing: "0.03em",
          }}>
            {newKey.key}
          </div>
          <button onClick={() => navigator.clipboard.writeText(newKey.key ?? "")}
            style={{ ...secondaryBtn, marginTop: 10 }}>
            Copy to clipboard
          </button>
        </div>
      )}

      {/* ── Create form ─────────────────────────────────────────────── */}
      <div style={{ ...card, marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#f1f5f9", marginBottom: 16 }}>
          Create new API key
        </div>
        <form onSubmit={create} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <Label>Key name</Label>
            <input type="text" required placeholder="e.g. WhatsApp Bot · Production"
              value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              style={inputStyle} />
          </div>

          <div>
            <Label>Scopes</Label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {SCOPES.map((s) => (
                <div key={s.id} onClick={() => toggleScope(s.id)}
                  style={{
                    border: `1.5px solid ${form.scopes.includes(s.id) ? "#E31E24" : "#334155"}`,
                    borderRadius: 8, padding: "10px 12px", cursor: "pointer",
                    background: form.scopes.includes(s.id) ? "#1a0a0a" : "#0f172a",
                    display: "flex", alignItems: "flex-start", gap: 10,
                  }}>
                  <div style={{
                    width: 16, height: 16, borderRadius: 4, marginTop: 1, flexShrink: 0,
                    background: form.scopes.includes(s.id) ? "#E31E24" : "transparent",
                    border: `2px solid ${form.scopes.includes(s.id) ? "#E31E24" : "#475569"}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {form.scopes.includes(s.id) && <span style={{ color: "white", fontSize: 10, fontWeight: 900 }}>✓</span>}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: form.scopes.includes(s.id) ? "#f1f5f9" : "#94a3b8" }}>
                      {s.label}
                    </div>
                    <div style={{ fontSize: 11, color: "#64748b" }}>{s.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <Label>Expiry date <span style={{ color: "#64748b", fontWeight: 400 }}>(optional — leave blank for no expiry)</span></Label>
            <input type="date" value={form.expiresAt}
              onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
              style={{ ...inputStyle, maxWidth: 220 }} />
          </div>

          <div>
            <button type="submit" disabled={creating || form.scopes.length === 0} style={{ ...primaryBtn, opacity: creating ? 0.7 : 1 }}>
              {creating ? "Creating…" : "Create API key"}
            </button>
          </div>
        </form>
      </div>

      {/* ── Key list ────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#f1f5f9", marginBottom: 16 }}>
          {loading ? "Loading…" : `${keys.length} API key${keys.length !== 1 ? "s" : ""}`}
        </div>

        {!loading && keys.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px 0", color: "#64748b", fontSize: 14 }}>
            No API keys yet — create one above.
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {keys.map((k) => (
            <div key={k.id} style={{
              background: "#0f172a", borderRadius: 10, padding: "14px 16px",
              border: `1px solid ${k.isActive ? "#1e3a5f" : "#334155"}`,
              opacity: k.isActive ? 1 : 0.6,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: "#f1f5f9" }}>{k.name}</span>
                    {!k.isActive && (
                      <span style={{ fontSize: 10, fontWeight: 700, background: "#450a0a", color: "#f87171",
                        padding: "2px 8px", borderRadius: 20 }}>REVOKED</span>
                    )}
                  </div>
                  <div style={{ fontFamily: "monospace", fontSize: 12, color: "#60a5fa" }}>
                    {k.keyPrefix}••••••••••••••••••••
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                    {k.scopes.map((s) => (
                      <span key={s} style={{ fontSize: 11, background: "#1e293b", color: "#94a3b8",
                        padding: "2px 8px", borderRadius: 20 }}>{s}</span>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>
                    Created {new Date(k.createdAt).toLocaleDateString()}
                    {k.lastUsedAt ? ` · Last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : " · Never used"}
                    {k.expiresAt ? ` · Expires ${new Date(k.expiresAt).toLocaleDateString()}` : ""}
                  </div>
                </div>
                {k.isActive && (
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button onClick={() => revoke(k.id)} style={{
                      background: "#450a0a", color: "#f87171", border: "1px solid #7f1d1d",
                      borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer",
                    }}>
                      Revoke
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>{label}</div>
      <div style={{ position: "relative" }}>
        <pre style={{
          fontFamily: "monospace", fontSize: 12, color: "#94a3b8", background: "#0f172a",
          border: "1px solid #1e293b", borderRadius: 8, padding: "12px 14px",
          margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all",
        }}>
          {code}
        </pre>
        <button onClick={copy} style={{
          position: "absolute", top: 8, right: 8,
          background: "#1e293b", color: "#94a3b8", border: "none",
          borderRadius: 4, padding: "4px 10px", fontSize: 11, cursor: "pointer",
        }}>
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8", marginBottom: 6 }}>{children}</div>;
}

const card: React.CSSProperties = {
  background: "#1e293b", borderRadius: 12, padding: 20, border: "1px solid #334155",
};
const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "10px 14px",
  background: "#0f172a", border: "1.5px solid #334155", borderRadius: 8,
  color: "#e2e8f0", fontSize: 14,
};
const primaryBtn: React.CSSProperties = {
  background: "#E31E24", color: "white", border: "none", borderRadius: 8,
  padding: "10px 20px", fontWeight: 700, fontSize: 13, cursor: "pointer",
};
const secondaryBtn: React.CSSProperties = {
  background: "#1e293b", color: "#94a3b8", border: "1px solid #334155",
  borderRadius: 8, padding: "8px 16px", fontWeight: 600, fontSize: 12, cursor: "pointer",
};
