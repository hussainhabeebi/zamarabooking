"use client";
import { useEffect, useState } from "react";
import { API, apiHeaders } from "@/lib/api";
import { HotelCitySync } from "./HotelCitySync";

type Env = "UAT" | "PRODUCTION";

/* ── Reference data ─────────────────────────────────────────────── */
const TRIPSAFE_APIS = [
  { name: "Search",           path: "POST /insurance/v2/search",            desc: "Plans for Standalone / Domestic / Student / AMT / Embedded" },
  { name: "Create Booking",   path: "POST /insurance/v2/booking",           desc: "Issue policies (WALLET with payUserId)" },
  { name: "Booking Detail",   path: "GET /insurance/v2/booking/{bookingId}", desc: "Policy IDs and COI links" },
  { name: "Raise Amendment",  path: "POST /insurance/v2/amendment/raise",   desc: "Cancellation / correction quote" },
  { name: "Confirm Amendment", path: "POST /insurance/v2/amendment/confirm", desc: "Execute the raised amendment" },
];

const CABS_APIS = [
  { name: "Location Search",   path: "/api/v1/cabs/location/search",   desc: "Smart pickup & drop search" },
  { name: "Lat/Long",          path: "/api/v1/cabs/location/latlng",   desc: "Geocoding for fare calculation" },
  { name: "Quotes",            path: "/api/v1/cabs/quotes",            desc: "Cab options and pricing" },
  { name: "Booking",           path: "/api/v1/cabs/booking",           desc: "Confirm bookings instantly" },
  { name: "Booking Details",   path: "/api/v1/cabs/booking/details",   desc: "Booking & live tracking link" },
  { name: "Amendment Charges", path: "/api/v1/cabs/amendment/charges", desc: "Retrieve modification charges" },
  { name: "Cancellation",      path: "/api/v1/cabs/cancellation",      desc: "Manage cancellations" },
];

const DUFFEL_APIS = [
  { name: "Offer Requests", path: "/air/offer_requests", desc: "Create a search session (POST)" },
  { name: "Offers",         path: "/air/offers",         desc: "Retrieve offers for a request (GET)" },
  { name: "Orders",         path: "/air/orders",         desc: "Create a confirmed booking (POST)" },
  { name: "Order Cancellations", path: "/air/order_cancellations", desc: "Cancel and refund an order" },
  { name: "Seat Maps",      path: "/air/seat_maps",      desc: "Seat selection (optional)" },
  { name: "Order Services", path: "/air/orders/{id}/services", desc: "Add ancillaries (baggage, meals)" },
];

const SERP_WIRING = [
  "1. Web middleware sets a 30-day sid cookie on every visitor",
  "2. Search page reads the sid cookie and sends it as X-Session-ID header to the API",
  "3. API checks SESSIONS_KV for serp_trials:<tenantId>:<sessionId> counter",
  "4. If counter < 2 AND SERP_API_KEY secret is set → injects GOOGLE_SERP supplier",
  "5. SERP runs in parallel with Riya/Tripjack; results marked isBookable: false",
  "6. WhatsApp channel always gets SERP fallback when bookable suppliers fail (X-Channel: WHATSAPP)",
];

/* ── Page ───────────────────────────────────────────────────────── */
export default function IntegrationsPage() {
  const [tj, setTj] = useState({ apiKey: "", configured: false, env: "UAT" as Env, enabled: false, tripsafe: false, payUserId: "", cabs: false, saving: false, saved: false, error: "" });
  const [duffel, setDuffel] = useState({ apiKey: "", env: "test" as "test" | "live", enabled: false, saving: false, saved: false, error: "" });
  const [serp, setSerp] = useState({ apiKey: "", saving: false, saved: false, error: "" });

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${API}/api/admin/integrations/tripjack`, { headers: apiHeaders() });
        if (!res.ok) throw new Error(`Unable to load TripJack configuration (${res.status})`);
        const data = await res.json() as {
          enabled?: boolean; apiKey?: string; environment?: Env;
          tripsafeEnabled?: boolean; cabsEnabled?: boolean; tripsafePayUserId?: string;
        };
        setTj((s) => ({
          ...s,
          configured: Boolean(data.apiKey),
          enabled: data.enabled === true,
          env: data.environment ?? "UAT",
          tripsafe: data.tripsafeEnabled === true,
          payUserId: data.tripsafePayUserId ?? "",
          cabs: data.cabsEnabled === true,
        }));
      } catch (err) {
        setTj((s) => ({ ...s, error: err instanceof Error ? err.message : "Unable to load TripJack configuration" }));
      }
    })();
  }, []);

  async function saveTj(e: React.FormEvent) {
    e.preventDefault();
    setTj((s) => ({ ...s, saving: true, error: "", saved: false }));
    try {
      const res = await fetch(`${API}/api/admin/integrations/tripjack`, {
        method: "POST", headers: apiHeaders(),
        body: JSON.stringify({ enabled: tj.enabled, apiKey: tj.apiKey, environment: tj.env, tripsafeEnabled: tj.tripsafe, tripsafePayUserId: tj.payUserId.trim(), cabsEnabled: tj.cabs }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string; message?: string };
        throw new Error(data.message ?? data.error ?? `Failed to save TripJack configuration (${res.status})`);
      }
      setTj((s) => ({ ...s, configured: s.configured || Boolean(s.apiKey), apiKey: "", saved: true }));
    } catch (e: any) { setTj((s) => ({ ...s, error: e.message })); }
    finally { setTj((s) => ({ ...s, saving: false })); }
  }

  async function saveDuffel(e: React.FormEvent) {
    e.preventDefault();
    setDuffel((s) => ({ ...s, saving: true, error: "", saved: false }));
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/admin/integrations/duffel`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: duffel.apiKey, environment: duffel.env, enabled: duffel.enabled }),
      });
      if (!res.ok) throw new Error("Failed — check API connectivity");
      setDuffel((s) => ({ ...s, saved: true }));
    } catch (e: any) { setDuffel((s) => ({ ...s, error: e.message })); }
    finally { setDuffel((s) => ({ ...s, saving: false })); }
  }

  async function saveSerp(e: React.FormEvent) {
    e.preventDefault();
    setSerp((s) => ({ ...s, saving: true, error: "", saved: false }));
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/admin/integrations/serp`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: serp.apiKey }),
      });
      if (!res.ok) throw new Error("Failed — check API connectivity");
      setSerp((s) => ({ ...s, saved: true }));
    } catch (e: any) { setSerp((s) => ({ ...s, error: e.message })); }
    finally { setSerp((s) => ({ ...s, saving: false })); }
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", marginBottom: 8 }}>Integrations</h1>
      <p style={{ color: "#64748b", fontSize: 14, marginBottom: 28 }}>
        Configure external API suppliers: TripJack (insurance + cabs), Duffel (flights), and Google Flights SERP.
      </p>

      {/* ── SERP ──────────────────────────────────────────────────── */}
      <Section color="#ea4335" title="Google Flights SERP" badge="serpapi.com · indicative only">
        <p style={{ color: "#64748b", fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
          Indicative Google Flights pricing via SerpAPI. Auto-injected for the first 2 anonymous
          searches per session. Results are always <code style={codeStyle}>isBookable: false</code>.
          Get your API key at <strong style={{ color: "#e2e8f0" }}>serpapi.com</strong>.
        </p>

        <div style={{ background: "#0f172a", borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <SubTitle>How SERP is wired</SubTitle>
          <ol style={{ margin: 0, padding: "0 0 0 16px", display: "flex", flexDirection: "column", gap: 4 }}>
            {SERP_WIRING.map((step) => (
              <li key={step} style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.5 }}>{step}</li>
            ))}
          </ol>
        </div>

        <form onSubmit={saveSerp} style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <Label>SerpAPI Key</Label>
            <input type="password" placeholder="Paste your serpapi.com API key"
              value={serp.apiKey} onChange={(e) => setSerp((s) => ({ ...s, apiKey: e.target.value }))}
              style={inputStyle} />
            <p style={hint}>Also set as <code style={codeStyle}>SERP_API_KEY</code> secret on the poomas-api Worker.</p>
          </div>
          <div>
            <button type="submit" disabled={serp.saving} style={saveBtn(serp.saving)}>
              {serp.saving ? "Saving…" : "Save"}
            </button>
          </div>
          {serp.saved && <span style={{ color: "#4ade80", fontSize: 13 }}>✓ Saved</span>}
        </form>
        {serp.error && <ErrorBanner>{serp.error}</ErrorBanner>}
      </Section>

      {/* ── Duffel ───────────────────────────────────────────────── */}
      <Section color="#7c3aed" title="Duffel — Flight Bookings" badge="Global NDC aggregator">
        <p style={{ color: "#64748b", fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
          Direct airline NDC content via Duffel. Supports search, seat selection, ancillary services,
          and full booking lifecycle. Test key format: <code style={codeStyle}>duffel_test_...</code>
          — same base URL, no real charges.
          Sign up free at <strong style={{ color: "#e2e8f0" }}>app.duffel.com</strong>.
        </p>

        <form onSubmit={saveDuffel}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            <div>
              <Label>Duffel API Key</Label>
              <input type="password" placeholder="duffel_test_... or duffel_live_..."
                value={duffel.apiKey} onChange={(e) => setDuffel((s) => ({ ...s, apiKey: e.target.value }))}
                style={inputStyle} />
              <p style={hint}>Set as <code style={codeStyle}>DUFFEL_API_KEY</code> secret on poomas-api Worker.</p>
            </div>
            <div>
              <Label>Environment</Label>
              <select value={duffel.env} onChange={(e) => setDuffel((s) => ({ ...s, env: e.target.value as "test" | "live" }))} style={inputStyle}>
                <option value="test">Test (sandbox — duffel_test_...)</option>
                <option value="live">Live (production — duffel_live_...)</option>
              </select>
              <p style={hint}>Both environments use <code style={codeStyle}>https://api.duffel.com</code>.</p>
            </div>
          </div>

          <Toggle label="Enable Duffel supplier" description="Run alongside Riya & Tripjack for flight search"
            checked={duffel.enabled} onChange={(v) => setDuffel((s) => ({ ...s, enabled: v }))} color="#7c3aed" />

          {duffel.error && <ErrorBanner>{duffel.error}</ErrorBanner>}
          <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12 }}>
            <button type="submit" disabled={duffel.saving} style={saveBtn(duffel.saving)}>
              {duffel.saving ? "Saving…" : "Save Duffel Config"}
            </button>
            {duffel.saved && <span style={{ color: "#4ade80", fontSize: 13 }}>✓ Saved</span>}
          </div>
        </form>

        <div style={{ marginTop: 20 }}>
          <SubTitle>Endpoints (base: https://api.duffel.com · header: Duffel-Version: v2)</SubTitle>
          <ApiTable apis={DUFFEL_APIS} color="#a78bfa" />
        </div>
      </Section>

      {/* ── TripJack ─────────────────────────────────────────────── */}
      <Section color="#2563eb" title="TripJack — Flights, TripSafe & Cabs" badge="TripJack partner API">
        <p style={{ color: "#64748b", fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
          Flight search, TripSafe travel insurance (Aditya Birla Health Insurance), and Cabs ground transfers.
          Both use a shared <code style={codeStyle}>apiKey</code> header.
          Generate your key via TripJack partner portal → User Details → API Configuration → IP whitelist.
        </p>

        <form onSubmit={saveTj}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            <div>
              <Label>TripJack API Key</Label>
              <input type="password" placeholder={tj.configured ? "Configured — leave blank to keep existing key" : "Your TripJack API key"}
                value={tj.apiKey} onChange={(e) => setTj((s) => ({ ...s, apiKey: e.target.value }))}
                style={inputStyle} />
              <p style={hint}>{tj.configured ? "An API key is saved for this tenant." : <>Set as <code style={codeStyle}>TRIPJACK_API_KEY</code> on poomas-api.</>}</p>
            </div>
            <div>
              <Label>Environment</Label>
              <select value={tj.env} onChange={(e) => setTj((s) => ({ ...s, env: e.target.value as Env }))} style={inputStyle}>
                <option value="UAT">UAT (Sandbox) — uat.tripjack.com</option>
                <option value="PRODUCTION">Production — api.tripjack.com</option>
              </select>
              <p style={hint}>Switch to Production after UAT certification.</p>
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <Toggle label="Enable TripJack flight search" description="Search TripJack flights alongside the other enabled suppliers"
              checked={tj.enabled} onChange={(v) => setTj((s) => ({ ...s, enabled: v }))} color="#2563eb" />
          </div>

          <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
            <Toggle label="Enable TripSafe" description="Travel insurance at /insurance (manage in Admin → TripSafe)"
              checked={tj.tripsafe} onChange={(v) => setTj((s) => ({ ...s, tripsafe: v }))} color="#6366f1" />
            <Toggle label="Enable Cabs" description="Ground transfers linked to itineraries"
              checked={tj.cabs} onChange={(v) => setTj((s) => ({ ...s, cabs: v }))} color="#0ea5e9" />
          </div>

          {tj.tripsafe && (
            <div style={{ marginBottom: 16, maxWidth: 420 }}>
              <Label>TripSafe payUserId (TripJack user ID)</Label>
              <input value={tj.payUserId} inputMode="numeric" placeholder="e.g. 614507"
                onChange={(e) => setTj((s) => ({ ...s, payUserId: e.target.value.replace(/[^0-9]/g, "") }))} style={inputStyle} />
              <p style={hint}>Policies are paid from this TripJack wallet. Without it TripJack leaves bookings PAYMENT_PENDING. UAT issues policies instantly; in Production customer requests wait for “Issue policy” in Admin → TripSafe.</p>
            </div>
          )}

          <HotelCitySync />

          {tj.error && <ErrorBanner>{tj.error}</ErrorBanner>}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button type="submit" disabled={tj.saving} style={saveBtn(tj.saving)}>
              {tj.saving ? "Saving…" : "Save TripJack Config"}
            </button>
            {tj.saved && <span style={{ color: "#4ade80", fontSize: 13 }}>✓ Saved</span>}
          </div>
        </form>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginTop: 24 }}>
          <div>
            <SubTitle>TripSafe Endpoints</SubTitle>
            <ApiTable apis={TRIPSAFE_APIS} color="#818cf8" />
          </div>
          <div>
            <SubTitle>Cabs Endpoints</SubTitle>
            <ApiTable apis={CABS_APIS} color="#38bdf8" />
          </div>
        </div>
      </Section>

      {/* ── Secrets cheatsheet ───────────────────────────────────── */}
      <section style={{ ...card, marginTop: 16, borderColor: "#854d0e", background: "#1c1100" }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, color: "#fbbf24", margin: "0 0 12px" }}>
          Cloudflare poomas-api Worker Secrets
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {[
            ["SERP_API_KEY",       "serpapi.com key — enables Google Flights trial for anonymous users"],
            ["DUFFEL_API_KEY",     "duffel_test_... for sandbox · duffel_live_... for production"],
            ["TRIPJACK_API_KEY",   "TripJack partner API key (shared for TripSafe + Cabs)"],
            ["TRIPJACK_API_BASE_URL", "https://uat.tripjack.com (UAT) or https://api.tripjack.com (Prod)"],
          ].map(([k, d]) => (
            <div key={k} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <code style={{ ...codeStyle, minWidth: 220, flexShrink: 0 }}>{k}</code>
              <span style={{ fontSize: 12, color: "#64748b" }}>{d}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ── Small shared components ────────────────────────────────────── */
function Section({ color, title, badge, children }: {
  color: string; title: string; badge: string; children: React.ReactNode;
}) {
  return (
    <section style={{ ...card, marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
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

function ApiTable({ apis, color }: { apis: { name: string; path: string; desc: string }[]; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {apis.map((a) => (
        <div key={a.name} style={{ background: "#0f172a", borderRadius: 6, padding: "8px 12px" }}>
          <div style={{ fontWeight: 600, fontSize: 12, color: "#e2e8f0" }}>{a.name}</div>
          <div style={{ fontSize: 11, color: "#64748b" }}>{a.desc}</div>
          <code style={{ fontSize: 11, color, marginTop: 1, display: "block" }}>{a.path}</code>
        </div>
      ))}
    </div>
  );
}

function SubTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase",
      letterSpacing: ".05em", marginBottom: 8 }}>{children}</div>
  );
}
function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8", marginBottom: 6 }}>{children}</div>;
}
function Toggle({ label, description, checked, onChange, color }: {
  label: string; description: string; checked: boolean; onChange: (v: boolean) => void; color: string;
}) {
  return (
    <div onClick={() => onChange(!checked)} style={{
      flex: 1, background: checked ? `${color}22` : "#0f172a",
      border: `1px solid ${checked ? color : "#334155"}`,
      borderRadius: 10, padding: "12px 14px", cursor: "pointer",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontWeight: 600, color: checked ? "#f1f5f9" : "#94a3b8", fontSize: 13 }}>{label}</div>
        <div style={{ width: 34, height: 18, borderRadius: 9, background: checked ? color : "#334155", position: "relative" }}>
          <div style={{ position: "absolute", top: 2, left: checked ? 16 : 2, width: 14, height: 14,
            borderRadius: "50%", background: "white", transition: "left .12s" }} />
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#64748b", marginTop: 3 }}>{description}</div>
    </div>
  );
}
function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: "#450a0a", color: "#fca5a5", padding: "8px 12px", borderRadius: 6, marginTop: 10, fontSize: 13 }}>
      {children}
    </div>
  );
}
function saveBtn(disabled: boolean): React.CSSProperties {
  return { background: "#E31E24", color: "white", border: "none", borderRadius: 8,
    padding: "9px 20px", fontWeight: 700, fontSize: 13, cursor: "pointer", opacity: disabled ? 0.7 : 1 };
}

const card: React.CSSProperties = { background: "#1e293b", borderRadius: 12, padding: 24, border: "1px solid #334155" };
const inputStyle: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "10px 14px",
  background: "#0f172a", border: "1.5px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 14 };
const hint: React.CSSProperties = { fontSize: 12, color: "#64748b", margin: "5px 0 0" };
const codeStyle: React.CSSProperties = { background: "#0f172a", padding: "1px 6px", borderRadius: 4,
  fontFamily: "monospace", fontSize: 12, color: "#94a3b8" };

