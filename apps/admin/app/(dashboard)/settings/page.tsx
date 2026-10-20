"use client";
import { useState, useEffect } from "react";
import { API, apiHeaders } from "../../../lib/api";
import EmailSettings from "./EmailSettings";

/* ── Small shared UI ────────────────────────────────────────────── */
function Section({ color, title, badge, children }: {
  color: string; title: string; badge: string; children: React.ReactNode;
}) {
  return (
    <section style={{ ...card, marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: color, flexShrink: 0 }} />
        <h2 style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9", margin: 0 }}>{title}</h2>
        <span style={{
          marginLeft: "auto", fontSize: 11, fontWeight: 700, padding: "3px 10px",
          borderRadius: 20, background: `${color}22`, color, letterSpacing: ".04em",
        }}>{badge}</span>
      </div>
      {children}
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8", marginBottom: 6 }}>{children}</div>;
}

function Hint({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <p style={{ fontSize: 12, color: "#64748b", margin: "5px 0 0", ...style }}>{children}</p>;
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: "#450a0a", color: "#fca5a5", padding: "8px 12px", borderRadius: 6, marginTop: 10, fontSize: 13 }}>
      {children}
    </div>
  );
}

function Toggle({ label, description, checked, onChange, color }: {
  label: string; description: string; checked: boolean; onChange: (v: boolean) => void; color: string;
}) {
  return (
    <div onClick={() => onChange(!checked)} style={{
      background: checked ? `${color}22` : "#0f172a",
      border: `1px solid ${checked ? color : "#334155"}`,
      borderRadius: 10, padding: "12px 14px", cursor: "pointer", marginBottom: 16,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 600, color: checked ? "#f1f5f9" : "#94a3b8", fontSize: 13 }}>{label}</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 3 }}>{description}</div>
        </div>
        <div style={{ width: 34, height: 18, borderRadius: 9, background: checked ? color : "#334155", position: "relative", flexShrink: 0 }}>
          <div style={{ position: "absolute", top: 2, left: checked ? 16 : 2, width: 14, height: 14,
            borderRadius: "50%", background: "white", transition: "left .12s" }} />
        </div>
      </div>
    </div>
  );
}

function saveBtn(disabled: boolean): React.CSSProperties {
  return { background: "#E31E24", color: "white", border: "none", borderRadius: 8,
    padding: "9px 20px", fontWeight: 700, fontSize: 13, cursor: "pointer", opacity: disabled ? 0.7 : 1 };
}

/* ── Payment Section ────────────────────────────────────────────── */
function PaymentSettings() {
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [error,   setError]   = useState("");
  const [nomodStatus, setNomodStatus] = useState<"idle" | "testing" | "connected" | "failed">("idle");
  const [s, setS] = useState({
    defaultGateway: "NOMOD" as "RAZORPAY" | "NOMOD",
    razorpay: { enabled: false, keyId: "", keySecret: "", webhookSecret: "" },
    nomod:    { enabled: false, apiKey: "", apiSecret: "", webhookSecret: "", environment: "production" as "sandbox" | "production", allowTabby: true, allowTamara: true, configured: false, aedRate: null as number | null },
  });

  useEffect(() => {
    fetch(`${API}/api/admin/settings/payments`, { headers: apiHeaders() })
      .then((r) => r.json())
      .then((d: any) => { setS((p) => ({ ...p, ...d })); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(""); setSaved(false);
    try {
      const res = await fetch(`${API}/api/admin/settings/payments`, {
        method: "PUT",
        headers: apiHeaders(),
        body: JSON.stringify(s),
      });
      if (!res.ok) throw new Error("Save failed");
      setSaved(true);
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function testNomod() {
    setNomodStatus("testing"); setError("");
    try {
      const saveRes = await fetch(`${API}/api/admin/settings/payments`, {
        method: "PUT", headers: apiHeaders(), body: JSON.stringify(s),
      });
      if (!saveRes.ok) throw new Error("Save the Nomod settings first");
      const res = await fetch(`${API}/api/admin/settings/payments/test-nomod`, {
        method: "POST", headers: apiHeaders(),
      });
      const data = await res.json() as { ok?: boolean; message?: string; mode?: string };
      if (!res.ok || !data.ok) throw new Error(data.message || "Nomod connection failed");
      setNomodStatus("connected");
      setS((p) => ({ ...p, nomod: { ...p.nomod, configured: true } }));
    } catch (err: any) {
      setNomodStatus("failed"); setError(err.message);
    }
  }

  if (loading) return <div style={{ color: "#64748b", fontSize: 13 }}>Loading…</div>;

  return (
    <form onSubmit={save}>
      <div style={{ marginBottom: 16, padding: "10px 12px", borderRadius: 8, background: "rgba(124,58,237,.12)", border: "1px solid #5b21b6", color: "#c4b5fd", fontSize: 13 }}>
        Nomod is the only active payment gateway. Razorpay is disabled for new payments; refunds on earlier Razorpay payments still work.
      </div>

      {/* Nomod */}
      <div style={{ background: "#0f172a", borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <Toggle label="Enable Nomod" description="Fast hosted checkout with cards, Apple Pay, Google Pay, Tabby and Tamara"
          checked={s.nomod.enabled} onChange={(v) => setS((p) => ({ ...p, nomod: { ...p.nomod, enabled: v } }))} color="#7c3aed" />
        {s.nomod.enabled && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ gridColumn: "span 2" }}>
                <Label>Nomod API Key</Label>
                <input type="password"
                  placeholder={s.nomod.configured ? "Saved — enter only to replace" : "sk_test_… or live API key"}
                  value={s.nomod.apiKey}
                  onChange={(e) => setS((p) => ({ ...p, nomod: { ...p.nomod, apiKey: e.target.value } }))}
                  style={inputStyle} autoComplete="new-password" />
                <Hint>Nomod Dashboard → Settings → Tools & customisations → Apps & APIs → Nomod API. The key stays on the server.</Hint>
              </div>
              <div>
                <Label>Mode</Label>
                <select value={s.nomod.environment}
                  onChange={(e) => setS((p) => ({ ...p, nomod: { ...p.nomod, environment: e.target.value as "sandbox" | "production" } }))}
                  style={inputStyle}>
                  <option value="sandbox">Test key</option>
                  <option value="production">Live payments</option>
                </select>
              </div>
              <div>
                <Label>Payment methods</Label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <label style={checkStyle}><input type="checkbox" checked={s.nomod.allowTabby} onChange={(e) => setS((p) => ({ ...p, nomod: { ...p.nomod, allowTabby: e.target.checked } }))} /> Tabby</label>
                  <label style={checkStyle}><input type="checkbox" checked={s.nomod.allowTamara} onChange={(e) => setS((p) => ({ ...p, nomod: { ...p.nomod, allowTamara: e.target.checked } }))} /> Tamara</label>
                </div>
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <Label>Manual AED rate — fallback (INR per 1 AED)</Label>
                <input type="number" min="1" step="0.0001" placeholder="e.g. 23.95 — leave empty to accept INR only"
                  value={s.nomod.aedRate ?? ""}
                  onChange={(e) => setS((p) => ({ ...p, nomod: { ...p.nomod, aedRate: e.target.value === "" ? null : Number(e.target.value) } }))}
                  style={inputStyle} />
                <Hint>
                  AED prices now use the automatic exchange rate (see Exchange Rates below). This manual rate is used only when
                  live rates are unavailable, or in manual mode.
                  {s.nomod.aedRate ? ` Example: ₹10,000 → AED ${(Math.ceil((10000 / s.nomod.aedRate) * 100) / 100).toFixed(2)}.` : ""}
                </Hint>
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <Label>Webhook Secret</Label>
                <input type="password" placeholder="Optional until Nomod webhook is configured" value={s.nomod.webhookSecret}
                  onChange={(e) => setS((p) => ({ ...p, nomod: { ...p.nomod, webhookSecret: e.target.value } }))}
                  style={inputStyle} autoComplete="new-password" />
                <Hint>Webhook URL: <code style={codeStyle}>https://api.flypoomas.com/webhooks/nomod</code></Hint>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
              <button type="button" onClick={testNomod} disabled={nomodStatus === "testing"}
                style={{ ...saveBtn(nomodStatus === "testing"), background: "#7c3aed" }}>
                {nomodStatus === "testing" ? "Testing…" : "Save & Test Nomod"}
              </button>
              {nomodStatus === "connected" && <span style={{ color: "#4ade80", fontSize: 13 }}>✓ Connected</span>}
              {nomodStatus === "failed" && <span style={{ color: "#f87171", fontSize: 13 }}>✗ Connection failed</span>}
            </div>
          </>
        )}
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="submit" disabled={saving} style={saveBtn(saving)}>
          {saving ? "Saving…" : "Save Payment Settings"}
        </button>
        {saved && <span style={{ color: "#4ade80", fontSize: 13 }}>✓ Saved</span>}
      </div>
    </form>
  );
}

/* ── Exchange rates (automatic exchange-rate tool) ─────────────── */
const FX_NAMES: Record<string, string> = { AED: "UAE dirham", SAR: "Saudi riyal", QAR: "Qatari riyal", OMR: "Omani rial", KWD: "Kuwaiti dinar", BHD: "Bahraini dinar", USD: "US dollar" };
type FxOverview = {
  settings: { mode: "auto" | "manual"; marginPct: number; manual: Record<string, number> };
  auto: { inrPer: Record<string, number>; source: string; fetchedAt: string } | null;
  effective: Record<string, number | null>;
  sources: Record<string, "auto" | "manual" | null>;
  currencies: string[];
};

function ExchangeRateSettings() {
  const [d, setD] = useState<FxOverview | null>(null);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [margin, setMargin] = useState("0");
  const [manual, setManual] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"" | "save" | "refresh">("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  function apply(o: FxOverview) {
    setD(o); setMode(o.settings.mode); setMargin(String(o.settings.marginPct));
    setManual(Object.fromEntries(o.currencies.map((c) => [c, o.settings.manual[c] ? String(o.settings.manual[c]) : ""])));
  }
  useEffect(() => {
    fetch(`${API}/api/admin/settings/fx`, { headers: apiHeaders() }).then((r) => r.json()).then(apply).catch(() => setError("Could not load exchange rates"));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy("save"); setError(""); setMsg("");
    try {
      const body = { mode, marginPct: Number(margin) || 0, manual: Object.fromEntries(Object.entries(manual).map(([c, v]) => [c, v === "" ? null : Number(v)])) };
      const res = await fetch(`${API}/api/admin/settings/fx`, { method: "PUT", headers: apiHeaders(), body: JSON.stringify(body) });
      const out = await res.json();
      if (!res.ok) throw new Error("Save failed — margin must be 0–10%, rates positive");
      apply(out); setMsg("Saved. New prices apply to the next search.");
    } catch (err: any) { setError(err.message); } finally { setBusy(""); }
  }

  async function refresh(force = false) {
    setBusy("refresh"); setError(""); setMsg("");
    try {
      const res = await fetch(`${API}/api/admin/settings/fx/refresh${force ? "?force=1" : ""}`, { method: "POST", headers: apiHeaders() });
      const out = await res.json();
      apply(out);
      if (!out.ok) throw new Error(`Live rates not updated: ${out.error ?? "feeds unavailable"}`);
      setMsg(`Live rates updated from ${out.rates.source}.`);
    } catch (err: any) { setError(err.message); } finally { setBusy(""); }
  }

  if (!d) return error ? <ErrorBanner>{error}</ErrorBanner> : <div style={{ color: "#64748b", fontSize: 13 }}>Loading…</div>;
  const age = d.auto ? Math.round((Date.now() - Date.parse(d.auto.fetchedAt)) / 60000) : null;
  const ageText = age === null ? "never" : age < 60 ? `${age} min ago` : age < 2880 ? `${Math.round(age / 60)} h ago` : `${Math.round(age / 1440)} days ago`;
  const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", color: "#94a3b8", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", borderBottom: "1px solid #334155" };
  const td: React.CSSProperties = { padding: "8px 10px", color: "#e2e8f0", fontSize: 13, borderBottom: "1px solid #1e293b" };

  return (
    <form onSubmit={save}>
      <div style={{ marginBottom: 16, padding: "10px 12px", borderRadius: 8, background: "rgba(14,165,233,.12)", border: "1px solid #0369a1", color: "#bae6fd", fontSize: 13 }}>
        Live market rates are fetched automatically every few hours and used for prices shown in AED, SAR, QAR, OMR, KWD, BHD and USD, and for AED payments.
        Last update: <b>{ageText}</b>{d.auto ? ` · ${d.auto.source}` : ""}.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
        <div>
          <Label>Rate source</Label>
          <select value={mode} onChange={(e) => setMode(e.target.value as "auto" | "manual")} style={inputStyle}>
            <option value="auto">Automatic (live rates) — manual rates as fallback</option>
            <option value="manual">Manual rates — live rates where none is set</option>
          </select>
        </div>
        <div>
          <Label>FX margin on live rates (%)</Label>
          <input type="number" min="0" max="10" step="0.1" value={margin} onChange={(e) => setMargin(e.target.value)} style={inputStyle} />
          <Hint>Customers paying in another currency pay this much more than the market rate (0–10%).</Hint>
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>Currency</th><th style={th}>Live (₹ per 1)</th><th style={th}>Manual (₹ per 1)</th><th style={th}>In use</th></tr></thead>
          <tbody>
            {d.currencies.map((c) => (
              <tr key={c}>
                <td style={td}><b>{c}</b> <span style={{ color: "#64748b", fontSize: 12 }}>{FX_NAMES[c] ?? ""}</span></td>
                <td style={td}>{d.auto?.inrPer[c] ? `₹${d.auto.inrPer[c].toFixed(4)}` : "—"}</td>
                <td style={td}>
                  <input type="number" min="0" step="0.0001" placeholder="optional" value={manual[c] ?? ""}
                    onChange={(e) => setManual((m) => ({ ...m, [c]: e.target.value }))} style={{ ...inputStyle, padding: "6px 10px", maxWidth: 140 }} />
                </td>
                <td style={td}>
                  {d.effective[c] ? <>₹{d.effective[c]!.toFixed(4)} <span style={{ fontSize: 11, fontWeight: 700, color: d.sources[c] === "auto" ? "#38bdf8" : "#fbbf24" }}>{d.sources[c] === "auto" ? "LIVE" : "MANUAL"}</span></> : <span style={{ color: "#f87171" }}>Not offered</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <div style={{ marginTop: 12 }}><ErrorBanner>{error}</ErrorBanner></div>}
      {msg && <div style={{ marginTop: 12, color: "#4ade80", fontSize: 13 }}>{msg}</div>}
      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
        <button type="submit" disabled={!!busy} style={saveBtn(busy === "save")}>{busy === "save" ? "Saving…" : "Save exchange rates"}</button>
        <button type="button" disabled={!!busy} onClick={() => refresh()} style={{ ...saveBtn(busy === "refresh"), background: "#0284c7" }}>{busy === "refresh" ? "Updating…" : "Update live rates now"}</button>
        {error.includes("sanity") && (
          <button type="button" disabled={!!busy} onClick={() => { if (confirm("Accept live rates even though they moved more than 10% since the last update?")) void refresh(true); }}
            style={{ ...saveBtn(false), background: "#475569" }}>Accept big move</button>
        )}
      </div>
    </form>
  );
}

/* ── WhatsApp Section ───────────────────────────────────────────── */
function WhatsAppSettings() {
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [error,   setError]   = useState("");
  const [status,  setStatus]  = useState<"unknown" | "connected" | "error">("unknown");
  const [s, setS] = useState({
    enabled:  false,
    provider: "LEADVYNE" as "LEADVYNE" | "WABA_DIRECT",
    leadvyne: { apiKey: "", apiSecret: "", instanceId: "", baseUrl: "https://api.leadvyne.com" },
    defaultCountryCode: "91",
    eticketTemplate: "poomas_eticket_v1",
    bookingConfirmTemplate: "poomas_booking_confirm_v1",
    webhookSecret: "",
  });

  useEffect(() => {
    fetch(`${API}/api/admin/settings/whatsapp`, { headers: apiHeaders() })
      .then((r) => r.json())
      .then((d: any) => { setS((p) => ({ ...p, ...d })); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  async function testConnection() {
    setStatus("unknown");
    try {
      const saveRes = await fetch(`${API}/api/admin/settings/whatsapp`, {
        method: "PUT",
        headers: apiHeaders(),
        body: JSON.stringify(s),
      });
      if (!saveRes.ok) throw new Error("Unable to save WhatsApp settings");
      const res = await fetch(`${API}/api/whatsapp/status`, { headers: apiHeaders() });
      const d = await res.json() as { configured?: boolean; status?: string };
      setStatus(res.ok && d.configured && d.status !== "error" ? "connected" : "error");
    } catch { setStatus("error"); }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(""); setSaved(false);
    try {
      const res = await fetch(`${API}/api/admin/settings/whatsapp`, {
        method: "PUT",
        headers: apiHeaders(),
        body: JSON.stringify(s),
      });
      if (!res.ok) throw new Error("Save failed");
      setSaved(true);
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  if (loading) return <div style={{ color: "#64748b", fontSize: 13 }}>Loading…</div>;

  return (
    <form onSubmit={save}>
      <Toggle label="Enable WhatsApp Messaging" description="Send booking confirmations and e-tickets via WhatsApp"
        checked={s.enabled} onChange={(v) => setS((p) => ({ ...p, enabled: v }))} color="#25D366" />

      {s.enabled && (
        <>
          <div style={{ background: "#0f172a", borderRadius: 10, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase",
              letterSpacing: ".05em", marginBottom: 12 }}>Leadvyne Configuration</div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <Label>API Key</Label>
                <input type="password" placeholder="lv_live_••••" value={s.leadvyne.apiKey}
                  onChange={(e) => setS((p) => ({ ...p, leadvyne: { ...p.leadvyne, apiKey: e.target.value } }))}
                  style={inputStyle} />
              </div>
              <div>
                <Label>Instance ID</Label>
                <input type="text" placeholder="inst_••••" value={s.leadvyne.instanceId}
                  onChange={(e) => setS((p) => ({ ...p, leadvyne: { ...p.leadvyne, instanceId: e.target.value } }))}
                  style={inputStyle} />
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <Label>API Base URL</Label>
                <input type="url" placeholder="https://api.leadvyne.com" value={s.leadvyne.baseUrl}
                  onChange={(e) => setS((p) => ({ ...p, leadvyne: { ...p.leadvyne, baseUrl: e.target.value } }))}
                  style={inputStyle} />
                <Hint>Webhook inbound URL: <code style={codeStyle}>https://api.flypoomas.com/webhooks/leadvyne</code></Hint>
              </div>
              <div>
                <Label>Webhook Secret</Label>
                <input type="password" placeholder="••••••••" value={s.webhookSecret}
                  onChange={(e) => setS((p) => ({ ...p, webhookSecret: e.target.value }))}
                  style={inputStyle} />
                <Hint>Used to verify inbound webhooks from Leadvyne</Hint>
              </div>
              <div>
                <Label>Default Country Code</Label>
                <input type="text" placeholder="91" value={s.defaultCountryCode}
                  onChange={(e) => setS((p) => ({ ...p, defaultCountryCode: e.target.value }))}
                  style={inputStyle} />
                <Hint>For normalizing phone numbers (91 = India, 971 = UAE)</Hint>
              </div>
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 12, alignItems: "center" }}>
              <button type="button" onClick={testConnection} style={{
                background: "#0f172a", color: "#94a3b8", border: "1px solid #334155",
                borderRadius: 8, padding: "7px 16px", fontWeight: 600, fontSize: 12, cursor: "pointer",
              }}>
                Test Connection
              </button>
              {status === "connected" && <span style={{ color: "#4ade80", fontSize: 13 }}>✓ Connected</span>}
              {status === "error"     && <span style={{ color: "#f87171", fontSize: 13 }}>✗ Connection failed</span>}
            </div>
          </div>

          <div style={{ background: "#0f172a", borderRadius: 10, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase",
              letterSpacing: ".05em", marginBottom: 12 }}>Message Templates</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <Label>Booking Confirmation Template</Label>
                <input type="text" value={s.bookingConfirmTemplate}
                  onChange={(e) => setS((p) => ({ ...p, bookingConfirmTemplate: e.target.value }))}
                  style={inputStyle} />
              </div>
              <div>
                <Label>E-Ticket Template</Label>
                <input type="text" value={s.eticketTemplate}
                  onChange={(e) => setS((p) => ({ ...p, eticketTemplate: e.target.value }))}
                  style={inputStyle} />
              </div>
            </div>
            <Hint style={{ marginTop: 8 }}>
              Template names must match approved Meta WhatsApp Business templates in your Leadvyne account.
            </Hint>
          </div>
        </>
      )}

      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="submit" disabled={saving} style={saveBtn(saving)}>
          {saving ? "Saving…" : "Save WhatsApp Settings"}
        </button>
        {saved && <span style={{ color: "#4ade80", fontSize: 13 }}>✓ Saved</span>}
      </div>
    </form>
  );
}

/* ── E-ticket Section ───────────────────────────────────────────── */
function EticketSettings() {
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [error,   setError]   = useState("");
  const [s, setS] = useState({
    autoSendOnConfirm:  true,
    channels:           ["WHATSAPP", "EMAIL"] as Array<"WHATSAPP" | "EMAIL">,
    emailFrom:          "tickets@flypoomas.com",
    emailFromName:      "POOMAS Flights",
    includeItinerary:   true,
    includeBaggage:     true,
    includeCheckinLink: false,
  });

  useEffect(() => {
    fetch(`${API}/api/admin/settings/eticket`, { headers: apiHeaders() })
      .then((r) => r.json())
      .then((d: any) => { setS((p) => ({ ...p, ...d })); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  function toggleChannel(ch: "WHATSAPP" | "EMAIL") {
    setS((p) => ({
      ...p,
      channels: p.channels.includes(ch)
        ? p.channels.filter((c) => c !== ch)
        : [...p.channels, ch],
    }));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(""); setSaved(false);
    try {
      const res = await fetch(`${API}/api/admin/settings/eticket`, {
        method: "PUT",
        headers: apiHeaders(),
        body: JSON.stringify(s),
      });
      if (!res.ok) throw new Error("Save failed");
      setSaved(true);
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  if (loading) return <div style={{ color: "#64748b", fontSize: 13 }}>Loading…</div>;

  return (
    <form onSubmit={save}>
      <Toggle label="Auto-send on confirmation" description="Automatically deliver e-ticket when booking is confirmed"
        checked={s.autoSendOnConfirm} onChange={(v) => setS((p) => ({ ...p, autoSendOnConfirm: v }))} color="#E31E24" />

      <div style={{ marginBottom: 16 }}>
        <Label>Delivery Channels</Label>
        <div style={{ display: "flex", gap: 10 }}>
          {(["WHATSAPP", "EMAIL"] as const).map((ch) => (
            <div key={ch} onClick={() => toggleChannel(ch)} style={{
              border: `2px solid ${s.channels.includes(ch) ? "#E31E24" : "#334155"}`,
              borderRadius: 8, padding: "10px 16px", cursor: "pointer",
              background: s.channels.includes(ch) ? "#1a0a0a" : "#0f172a",
              color: s.channels.includes(ch) ? "#f1f5f9" : "#94a3b8",
              fontWeight: 600, fontSize: 13,
            }}>
              {ch === "WHATSAPP" ? "📱 WhatsApp" : "✉️ Email"}
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <div>
          <Label>From Email Address</Label>
          <input type="email" value={s.emailFrom}
            onChange={(e) => setS((p) => ({ ...p, emailFrom: e.target.value }))}
            style={inputStyle} />
        </div>
        <div>
          <Label>From Name</Label>
          <input type="text" value={s.emailFromName}
            onChange={(e) => setS((p) => ({ ...p, emailFromName: e.target.value }))}
            style={inputStyle} />
        </div>
      </div>

      <div style={{ background: "#0f172a", borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase",
          letterSpacing: ".05em", marginBottom: 12 }}>E-ticket Content</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[
            { key: "includeItinerary",   label: "Include full itinerary" },
            { key: "includeBaggage",     label: "Include baggage allowance" },
            { key: "includeCheckinLink", label: "Include web check-in link" },
          ].map(({ key, label }) => (
            <label key={key} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", color: "#cbd5e1", fontSize: 13 }}>
              <input type="checkbox" checked={(s as any)[key]}
                onChange={(e) => setS((p) => ({ ...p, [key]: e.target.checked }))}
                style={{ width: 16, height: 16 }} />
              {label}
            </label>
          ))}
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="submit" disabled={saving} style={saveBtn(saving)}>
          {saving ? "Saving…" : "Save E-ticket Settings"}
        </button>
        {saved && <span style={{ color: "#4ade80", fontSize: 13 }}>✓ Saved</span>}
      </div>
    </form>
  );
}

/* ── Main page ──────────────────────────────────────────────────── */
export default function SettingsPage() {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", marginBottom: 8 }}>Settings</h1>
      <p style={{ color: "#64748b", fontSize: 14, marginBottom: 4 }}>
        Payment gateways, WhatsApp messaging, and e-ticket delivery configuration.
      </p>

      <Section color="#E31E24" title="Payment Gateways" badge="NoMod">
        <PaymentSettings />
      </Section>

      <Section color="#0EA5E9" title="Exchange Rates" badge="Auto · GCC + USD">
        <ExchangeRateSettings />
      </Section>

      <Section color="#F59E0B" title="Email" badge="Resend">
        <EmailSettings />
      </Section>

      <Section color="#25D366" title="WhatsApp Messaging" badge="Leadvyne · WABA">
        <WhatsAppSettings />
      </Section>

      <Section color="#6366F1" title="E-Ticket Delivery" badge="WhatsApp + Email">
        <EticketSettings />
      </Section>

      {/* Secrets cheatsheet */}
      <section style={{ ...card, marginTop: 16, borderColor: "#854d0e", background: "#1c1100" }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, color: "#fbbf24", margin: "0 0 12px" }}>
          Worker Secrets (set via <code style={codeStyle}>wrangler secret put</code>)
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[
            ["NOMOD_API_KEY",           "NoMod API key"],
            ["NOMOD_API_SECRET",        "NoMod API secret"],
            ["NOMOD_WEBHOOK_SECRET",    "NoMod webhook signing secret"],
            ["LEADVYNE_API_KEY",        "Leadvyne API key"],
            ["LEADVYNE_API_SECRET",     "Leadvyne API secret"],
            ["LEADVYNE_BASE_URL",       "Leadvyne base URL (e.g. https://api.leadvyne.com)"],
            ["LEADVYNE_INSTANCE_ID",    "Leadvyne WhatsApp instance ID"],
            ["LEADVYNE_WEBHOOK_SECRET", "Leadvyne inbound webhook secret"],
            ["RESEND_API_KEY",          "Resend API key for email delivery"],
          ].map(([k, d]) => (
            <div key={k} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <code style={{ ...codeStyle, minWidth: 240, flexShrink: 0, fontSize: 11 }}>{k}</code>
              <span style={{ fontSize: 12, color: "#64748b" }}>{d}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

const card: React.CSSProperties = { background: "#1e293b", borderRadius: 12, padding: 24, border: "1px solid #334155" };
const inputStyle: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "10px 14px",
  background: "#0f172a", border: "1.5px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 14 };
const codeStyle: React.CSSProperties = { background: "#0f172a", padding: "1px 6px", borderRadius: 4,
  fontFamily: "monospace", fontSize: 12, color: "#94a3b8" };

const checkStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, color: "#cbd5e1", fontSize: 12, fontWeight: 600, border: "1px solid #334155", borderRadius: 8, padding: "9px 11px" };
