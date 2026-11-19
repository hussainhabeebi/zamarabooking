"use client";
// Akbar baggage from free SSR on the search results (apps/api/src/lib/akbar-search-baggage.ts).
// OFF by default. Full admins only; every change is audit-logged by the API.
import { useEffect, useState } from "react";
import { API, apiHeaders } from "@/lib/api";

type Settings = {
  enabled: boolean; perMinute: number; maxPerRequest: number; concurrency: number;
  productCacheHours: number; timeoutMs: number; source: "LV" | "CF"; updatedAt?: string;
};

async function call(method: "GET" | "PUT", body?: unknown): Promise<Settings> {
  const res = await fetch(`${API}/api/admin/akbar-search-baggage`, { method, headers: apiHeaders(), ...(body ? { body: JSON.stringify(body) } : {}) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error ?? d.message ?? `HTTP ${res.status}`);
  return d as Settings;
}

export function AkbarSearchBaggageSettings() {
  const [v, setV] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { call("GET").then((d) => { setV(d); setSaved(d); }).catch((e) => setError(e.message)); }, []);
  if (error) return <section style={{ ...card, marginTop: 16 }}><div style={errBox}>Akbar baggage from SSR: {error}</div></section>;
  if (!v || !saved) return null;
  const changed = JSON.stringify(v) !== JSON.stringify(saved);

  async function save() {
    if (!v) return;
    if (v.enabled && !saved!.enabled && !confirm(`Turn ON baggage from Akbar's free SSR on search results?\n\nAt most ${v.perMinute} SSR calls a minute for the whole website; each results page asks only for the first ${v.maxPerRequest} fares without confirmed baggage, or a fare whose details a customer opens.`)) return;
    setBusy(true); setMsg("");
    try {
      const { updatedAt: _u, ...body } = v;
      const d = await call("PUT", body);
      setV(d); setSaved(d); setMsg("Saved");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  const num = (k: keyof Settings, label: string, help: string) => (
    <label style={lbl}>{label}
      <input type="number" style={input} value={Number(v[k])} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} />
      <span style={{ fontSize: 11, color: "#64748b", fontWeight: 400 }}>{help}</span>
    </label>
  );

  return (
    <section id="akbar-search-baggage" style={{ ...card, marginTop: 16, scrollMarginTop: 80 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9", margin: 0 }}>Akbar baggage from free SSR</h2>
        <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 20, background: saved.enabled ? "rgba(34,197,94,.15)" : "rgba(148,163,184,.15)", color: saved.enabled ? "#86efac" : "#94a3b8" }}>
          {saved.enabled ? "ON" : "OFF"}
        </span>
      </div>
      <p style={hint}>
        Shows check-in and cabin baggage on search results for Akbar fares whose search result gave none (e.g. IndiGo, AKB-SPCL),
        using Akbar&apos;s free SSR with the fare&apos;s search Index — before pricing. Only availability counts towards Akbar&apos;s 100:1
        look-to-book ratio, but SSR calls are limited here so Akbar&apos;s rate limits are respected. Nothing confirmed → the page keeps
        &quot;Allowance not confirmed&quot;.
      </p>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: "#e2e8f0", margin: "12px 0" }}>
        <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} />
        Ask Akbar&apos;s free SSR for baggage on search results
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        {num("perMinute", "SSR calls per minute (whole site)", "1–120. Over it, fares stay “not confirmed”.")}
        {num("maxPerRequest", "Fares per results page", "1–10, first cards without baggage.")}
        {num("concurrency", "At the same time", "1–4 SSR calls in parallel per page.")}
        {num("productCacheHours", "Reuse for (hours)", "0–24. Same flight, time, fare type, class and cabin only.")}
        {num("timeoutMs", "Timeout (ms)", "2000–15000.")}
        <label style={lbl}>SSR Source
          <select style={input} value={v.source} onChange={(e) => setV({ ...v, source: e.target.value as "LV" | "CF" })}>
            <option value="LV">LV (as the booking run)</option><option value="CF">CF</option>
          </select>
          <span style={{ fontSize: 11, color: "#64748b", fontWeight: 400 }}>Confirm with Akbar before changing.</span>
        </label>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14 }}>
        <button type="button" style={btn} disabled={!changed || busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
        {msg && <span style={{ fontSize: 13, color: msg === "Saved" ? "#86efac" : "#fca5a5" }}>{msg}</span>}
        {saved.updatedAt && <span style={{ fontSize: 11, color: "#64748b", marginLeft: "auto" }}>Last changed {new Date(saved.updatedAt).toLocaleString("en-IN")}</span>}
      </div>
    </section>
  );
}

const card: React.CSSProperties = { background: "#1e293b", borderRadius: 12, padding: 20, border: "1px solid #334155" };
const hint: React.CSSProperties = { fontSize: 13, color: "#94a3b8", margin: 0, lineHeight: 1.6 };
const lbl: React.CSSProperties = { display: "grid", gap: 6, fontSize: 12, fontWeight: 600, color: "#94a3b8" };
const input: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "9px 12px", background: "#0f172a", border: "1.5px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 14 };
const btn: React.CSSProperties = { background: "#0D4B96", color: "white", border: "none", borderRadius: 8, padding: "9px 20px", fontWeight: 700, fontSize: 13, cursor: "pointer" };
const errBox: React.CSSProperties = { background: "rgba(239,68,68,.1)", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 8, padding: "10px 12px", fontSize: 13 };
