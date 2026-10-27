"use client";
import { useEffect, useState } from "react";
import { API, apiHeaders } from "@/lib/api";

type SyncResult = { at: string; ok: boolean; imported: number; skipped: number; errors: string[] };
type Sources = {
  poomas: { enabled: boolean; apiKey: string; baseUrl: string };
  manual: { enabled: boolean; sheetUrl: string; autoSync: boolean; lastSync?: SyncResult };
  sheetColumns: string[];
};

async function call(path: string, method: string, body?: unknown) {
  const res = await fetch(`${API}/api/admin/flight-sources${path}`, { method, headers: apiHeaders(), ...(body ? { body: JSON.stringify(body) } : {}) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok && !("ok" in d)) throw new Error(d.error ?? d.message ?? `HTTP ${res.status}`);
  return d;
}

const tomorrow = () => new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);

// Poomas and manual-fare settings, the lower half of Admin → Suppliers.
export function FlightSourceSettings() {
  const [data, setData] = useState<Sources | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState("");
  const [poomasKey, setPoomasKey] = useState("");
  const [test, setTest] = useState({ origin: "COK", destination: "DXB", departureDate: tomorrow() });

  const load = () => call("", "GET").then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key); setMsg((m) => ({ ...m, [key]: { ok: true, text: "" } }));
    try { const text = await fn(); setMsg((m) => ({ ...m, [key]: { ok: true, text } })); }
    catch (e: any) { setMsg((m) => ({ ...m, [key]: { ok: false, text: e.message } })); }
    finally { setBusy(""); }
  }

  if (error) return <div style={errBox}>{error}</div>;
  if (!data) return <p style={{ color: "#64748b" }}>Loading…</p>;
  const { poomas, manual } = data;
  const set = <K extends keyof Sources>(k: K, patch: Partial<Sources[K]>) => setData({ ...data, [k]: { ...(data[k] as object), ...patch } });

  return (
    <div>

      {/* ── Poomas ── */}
      <Section id="poomas" color="#E31E24" title="Poomas API" badge={poomas.enabled ? "live in search" : "off"}>
        <p style={hint}>
          Fares from Poomas (FlyPoomas Partner API). Ask Poomas for a partner API key with the <code style={code}>search</code> scope.
          The price shown is what Poomas charges you; your markup is added on top. One-way fares only. After payment, book the same
          flight on Poomas and enter the PNR on the booking.
        </p>
        <form onSubmit={(e) => { e.preventDefault(); run("poomas", async () => {
          await call("/poomas", "PUT", { enabled: poomas.enabled, apiKey: poomasKey, baseUrl: poomas.baseUrl });
          setPoomasKey(""); await load(); return "Saved.";
        }); }} style={formGrid}>
          <Toggle label="Show Poomas fares in search" checked={poomas.enabled} onChange={(v) => set("poomas", { enabled: v })} />
          <Field label="API URL"><input value={poomas.baseUrl} onChange={(e) => set("poomas", { baseUrl: e.target.value })} style={input} /></Field>
          <Field label={`Partner API key${poomas.apiKey ? ` (saved ${poomas.apiKey})` : ""}`}>
            <input type="password" value={poomasKey} onChange={(e) => setPoomasKey(e.target.value)} placeholder={poomas.apiKey ? "Leave blank to keep" : "pmsk_…"} autoComplete="off" style={input} />
          </Field>
          <Actions busy={busy === "poomas"} msg={msg.poomas} />
        </form>
        <div style={{ ...subCard, marginTop: 14 }}>
          <SubTitle>Test the connection (live search, 1 adult)</SubTitle>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
            <input value={test.origin} onChange={(e) => setTest({ ...test, origin: e.target.value.toUpperCase() })} maxLength={3} style={{ ...input, width: 80 }} aria-label="From" />
            <input value={test.destination} onChange={(e) => setTest({ ...test, destination: e.target.value.toUpperCase() })} maxLength={3} style={{ ...input, width: 80 }} aria-label="To" />
            <input type="date" value={test.departureDate} onChange={(e) => setTest({ ...test, departureDate: e.target.value })} style={{ ...input, width: 170 }} aria-label="Date" />
            <button type="button" disabled={!!busy || !poomas.apiKey} onClick={() => run("poomasTest", async () => {
              const r = await call("/poomas/test", "POST", test);
              if (!r.ok) throw new Error(r.error);
              return r.fares ? `${r.fares} fares in ${(r.durationMs / 1000).toFixed(1)}s — cheapest ₹${Number(r.cheapest).toLocaleString("en-IN")}` : `Connected, but no fares for this route/date (${(r.durationMs / 1000).toFixed(1)}s).`;
            })} style={btnGhost}>{busy === "poomasTest" ? "Searching…" : "Run test search"}</button>
          </div>
          {msg.poomasTest?.text && <Msg {...msg.poomasTest} />}
        </div>
      </Section>

      {/* ── Manual fares ── */}
      <Section id="manual" color="#22c55e" title="Manual fares" badge={manual.enabled ? "live in search" : "off"}>
        <p style={hint}>
          Your own price list: group fares, blocked seats, special deals. Keep it in a Google Sheet, in the <a href="/manual-fares" style={linkStyle}>Manual fares</a> table,
          or both. Seats sold online come off the seat count automatically.
        </p>
        <form onSubmit={(e) => { e.preventDefault(); run("manual", async () => {
          await call("/manual", "PUT", { enabled: manual.enabled, sheetUrl: manual.sheetUrl, autoSync: manual.autoSync });
          await load(); return "Saved.";
        }); }} style={formGrid}>
          <Toggle label="Show manual fares in search" checked={manual.enabled} onChange={(v) => set("manual", { enabled: v })} />
          <Toggle label="Sync the sheet every hour" checked={manual.autoSync} onChange={(v) => set("manual", { autoSync: v })} />
          <Field label="Google Sheet link" wide>
            <input value={manual.sheetUrl} onChange={(e) => set("manual", { sheetUrl: e.target.value })} placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0" style={input} />
          </Field>
          <Actions busy={busy === "manual"} msg={msg.manual}>
            <button type="button" disabled={!!busy || !manual.sheetUrl} onClick={() => run("sync", async () => {
              const r = await call("/manual/sync", "POST") as SyncResult;
              await load();
              if (!r.ok) throw new Error(r.errors.join(" · "));
              return `Imported ${r.imported} fare${r.imported === 1 ? "" : "s"}${r.skipped ? `, skipped ${r.skipped} row${r.skipped === 1 ? "" : "s"}` : ""}.`;
            })} style={btnGhost}>{busy === "sync" ? "Syncing…" : "Sync now"}</button>
          </Actions>
        </form>
        {msg.sync?.text && <Msg {...msg.sync} />}
        {manual.lastSync && (
          <div style={{ ...subCard, marginTop: 12 }}>
            <SubTitle>Last sync — {new Date(manual.lastSync.at).toLocaleString("en-IN")}</SubTitle>
            <div style={{ color: manual.lastSync.ok ? "#86efac" : "#fca5a5", fontSize: 13 }}>
              {manual.lastSync.ok ? `Imported ${manual.lastSync.imported}, skipped ${manual.lastSync.skipped}.` : "Failed — the fares from the previous sync are kept."}
            </div>
            {manual.lastSync.errors.length > 0 && (
              <ul style={{ margin: "8px 0 0 18px", color: "#fbbf24", fontSize: 12, lineHeight: 1.6 }}>
                {manual.lastSync.errors.map((er) => <li key={er}>{er}</li>)}
              </ul>
            )}
          </div>
        )}
        <details style={{ ...subCard, marginTop: 12 }}>
          <summary style={{ color: "#93c5fd", fontSize: 13, cursor: "pointer", fontWeight: 700 }}>How to set up the Google Sheet</summary>
          <ol style={{ color: "#cbd5e1", fontSize: 13, lineHeight: 1.7, margin: "10px 0 0 18px" }}>
            <li>Put these column names in the <b>first row</b> (order doesn't matter; <b>bold</b> ones are required):</li>
          </ol>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "8px 0 8px 18px" }}>
            {data.sheetColumns.map((c) => (
              <code key={c} style={{ ...code, fontWeight: REQUIRED.includes(c) ? 800 : 400, color: REQUIRED.includes(c) ? "#f1f5f9" : "#94a3b8" }}>{c}</code>
            ))}
          </div>
          <ol start={2} style={{ color: "#cbd5e1", fontSize: 13, lineHeight: 1.7, margin: "0 0 0 18px" }}>
            <li>One row per flight and date. Dates as <code style={code}>25/12/2026</code>, times as <code style={code}>21:30</code>, airline as its 2-letter code (<code style={code}>6E</code>).</li>
            <li><code style={code}>adult_fare</code> is the price per adult <b>including taxes</b>, in <code style={code}>currency</code> (INR, AED, SAR, QAR, OMR, KWD, BHD or USD; default INR). Blank <code style={code}>child_fare</code> = adult fare; blank <code style={code}>infant_fare</code> = free.</li>
            <li><code style={code}>arrival_day_offset</code> = 1 when the flight lands the next day. <code style={code}>active</code> = no hides a row.</li>
            <li>In Google Sheets: <b>Share → General access → Anyone with the link → Viewer</b>, copy the link and paste it above.</li>
            <li>Each sync replaces the sheet fares; fares typed in the Manual fares table are never touched.</li>
          </ol>
        </details>
      </Section>
    </div>
  );
}

const REQUIRED = ["date", "origin", "destination", "airline", "flight_number", "departure_time", "arrival_time", "adult_fare"];

function Section({ id, color, title, badge, children }: { id?: string; color: string; title: string; badge: string; children: React.ReactNode }) {
  return (
    <section id={id} style={{ ...card, marginTop: 16, scrollMarginTop: 80 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: color, flexShrink: 0 }} />
        <h2 style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9", margin: 0 }}>{title}</h2>
        <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 20, background: `${color}22`, color, letterSpacing: ".04em" }}>{badge}</span>
      </div>
      {children}
    </section>
  );
}
function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <label style={{ display: "grid", gap: 6, fontSize: 12, fontWeight: 600, color: "#94a3b8", ...(wide ? { gridColumn: "1 / -1" } : {}) }}>{label}{children}</label>;
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} style={{
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: checked ? "#0D4B9633" : "#0f172a",
      border: `1px solid ${checked ? "#1E88D9" : "#334155"}`, borderRadius: 10, padding: "10px 12px", cursor: "pointer", color: checked ? "#f1f5f9" : "#94a3b8", fontWeight: 600, fontSize: 13, textAlign: "left",
    }}>
      {label}
      <span style={{ width: 34, height: 18, borderRadius: 9, background: checked ? "#1E88D9" : "#334155", position: "relative", flexShrink: 0 }}>
        <span style={{ position: "absolute", top: 2, left: checked ? 16 : 2, width: 14, height: 14, borderRadius: "50%", background: "white", transition: "left .12s" }} />
      </span>
    </button>
  );
}
function Actions({ busy, msg, children }: { busy: boolean; msg?: { ok: boolean; text: string }; children?: React.ReactNode }) {
  return (
    <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <button disabled={busy} style={{ ...btn, opacity: busy ? 0.7 : 1 }}>{busy ? "Saving…" : "Save"}</button>
      {children}
      {msg?.text && <span style={{ fontSize: 13, color: msg.ok ? "#86efac" : "#fca5a5" }}>{msg.text}</span>}
    </div>
  );
}
function Msg({ ok, text }: { ok: boolean; text: string }) {
  return <div style={{ fontSize: 13, marginTop: 10, color: ok ? "#86efac" : "#fca5a5" }}>{text}</div>;
}
function SubTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 8 }}>{children}</div>;
}

const card: React.CSSProperties = { background: "#1e293b", borderRadius: 12, padding: 20, border: "1px solid #334155" };
const subCard: React.CSSProperties = { background: "#0f172a", borderRadius: 8, padding: 14 };
const formGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginTop: 12 };
const input: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "9px 12px", background: "#0f172a", border: "1.5px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 14 };
const hint: React.CSSProperties = { fontSize: 13, color: "#94a3b8", margin: 0, lineHeight: 1.6 };
const code: React.CSSProperties = { background: "#0f172a", padding: "1px 6px", borderRadius: 4, fontFamily: "monospace", fontSize: 12, color: "#94a3b8", border: "1px solid #334155" };
const btn: React.CSSProperties = { background: "#0D4B96", color: "white", border: "none", borderRadius: 8, padding: "9px 20px", fontWeight: 700, fontSize: 13, cursor: "pointer" };
const btnGhost: React.CSSProperties = { ...btn, background: "#0f172a", border: "1px solid #334155", color: "#e2e8f0" };
const linkStyle: React.CSSProperties = { color: "#93c5fd", fontWeight: 700 };
const errBox: React.CSSProperties = { background: "rgba(239,68,68,.1)", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 8, padding: "10px 12px", fontSize: 13 };
