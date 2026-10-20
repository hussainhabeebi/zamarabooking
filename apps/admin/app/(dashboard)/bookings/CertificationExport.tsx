"use client";
import { useState } from "react";
import { API, apiHeaders } from "@/lib/api";

// TripJack UAT certification: pick bookings → one ZIP with a folder per booking
// (summary + numbered request / response JSON files, as TripJack requires).
type Row = {
  id: string; status: string; supplier: string; origin: string; destination: string; tripType: string;
  pnr: string | null; departureDate: string; createdAt: string; adultCount: number; childCount: number; infantCount: number;
  gstNumber: string | null; flightData: any;
};

function tags(b: Row) {
  const tj = b.flightData?.tripjack ?? {};
  const fi: string[] = tj.fareIdentifiers ?? [];
  const out: string[] = [];
  if (b.tripType === "ROUNDTRIP") out.push("Return");
  if (b.tripType === "MULTICITY") out.push("Multi-city");
  if (fi.includes("SPECIAL_RETURN")) out.push("Special Return");
  if (fi.some((f) => f === "STUDENT" || f === "SENIOR_CITIZEN")) out.push("Student/Senior");
  if (tj.gstInfo || b.gstNumber) out.push("GST");
  if ((tj.pax ?? []).some((p: any) => p.ssr?.baggage?.length || p.ssr?.meal?.length)) out.push("SSR");
  return out;
}

export function CertificationExport() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setOpen(true); setError("");
    try {
      const res = await fetch(`${API}/api/admin/bookings?limit=200`, { headers: apiHeaders() });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      const list = ((d.bookings ?? d) as Row[]).filter((b) => b.supplier === "TRIPJACK");
      setRows(list);
      setPicked(new Set(list.filter((b) => ["CONFIRMED", "TICKETED"].includes(b.status)).map((b) => b.id)));
    } catch (e: any) { setError(e.message); }
  }

  async function download() {
    if (!picked.size) return;
    setBusy(true); setError("");
    try {
      const ids = (rows ?? []).filter((b) => picked.has(b.id)).map((b) => b.id);
      const res = await fetch(`${API}/api/admin/bookings/certification.zip?ids=${ids.join(",")}`, { headers: apiHeaders() });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.message ?? d.error ?? `HTTP ${res.status}`); }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "tripjack-certification.zip";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (!open) {
    return (
      <button type="button" onClick={load} style={{ background: "#2563eb", color: "#fff", border: 0, borderRadius: 8, padding: "10px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer", marginBottom: 16 }}>
        TripJack certification logs
      </button>
    );
  }

  return (
    <div style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 12, padding: 16, marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <b style={{ color: "#f1f5f9" }}>TripJack certification logs</b>
        <button type="button" onClick={() => setOpen(false)} style={{ background: "none", border: 0, color: "#94a3b8", cursor: "pointer" }}>Close</button>
      </div>
      <p style={{ color: "#94a3b8", fontSize: 13, margin: "0 0 12px", lineHeight: 1.5 }}>
        TripJack's layout: <code>oneway/DEL-BOM-1A-DIRECT/</code>, <code>roundtrip/…</code> (route, adults / children / infants, direct or connecting), each with <code>SearchRequest.json</code> / <code>SearchResponse.json</code>, <code>Review…</code>, <code>Booking…</code>,
        <code>BookingDetail…</code> (plus SeatMap etc. when used) and <code>BookingSummary.json</code> (case, passengers, fare type, GST / SSR / seat / passport, PNR,
        and any missing service) — TripJack URL and apikey in each request, responses exactly as received.
      </p>
      {error && <div style={{ color: "#fca5a5", fontSize: 13, marginBottom: 8 }}>{error}</div>}
      {!rows ? <p style={{ color: "#94a3b8" }}>Loading bookings…</p> : (
        <div style={{ maxHeight: 360, overflowY: "auto", display: "grid", gap: 6 }}>
          {rows.map((b) => (
            <label key={b.id} style={{ display: "flex", gap: 10, alignItems: "center", background: "#0f172a", borderRadius: 8, padding: "8px 10px", color: "#e2e8f0", fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={picked.has(b.id)} onChange={() => toggle(b.id)} />
              <span style={{ fontWeight: 700, minWidth: 90 }}>{b.origin} → {b.destination}</span>
              <span style={{ color: "#94a3b8" }}>{b.adultCount}A{b.childCount ? ` ${b.childCount}C` : ""}{b.infantCount ? ` ${b.infantCount}I` : ""}</span>
              <span style={{ fontFamily: "monospace", color: "#94a3b8" }}>{b.pnr ?? "no PNR"}</span>
              <span style={{ color: ["CONFIRMED", "TICKETED"].includes(b.status) ? "#4ade80" : "#fbbf24", fontSize: 11, fontWeight: 700 }}>{b.status}</span>
              <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {tags(b).map((t) => <span key={t} style={{ background: "#1e3a8a", color: "#bfdbfe", borderRadius: 5, padding: "1px 6px", fontSize: 11 }}>{t}</span>)}
              </span>
              <span style={{ marginLeft: "auto", color: "#64748b", fontSize: 11 }}>{new Date(b.createdAt).toLocaleString()}</span>
            </label>
          ))}
          {!rows.length && <p style={{ color: "#94a3b8" }}>No TripJack bookings yet.</p>}
        </div>
      )}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
        <button type="button" disabled={busy || !picked.size} onClick={download}
          style={{ background: "#E31E24", color: "#fff", border: 0, borderRadius: 8, padding: "10px 16px", fontWeight: 700, cursor: "pointer", opacity: busy || !picked.size ? .6 : 1 }}>
          {busy ? "Preparing ZIP…" : `Download ${picked.size} booking${picked.size === 1 ? "" : "s"} (ZIP)`}
        </button>
        <span style={{ color: "#64748b", fontSize: 12 }}>Up to 30 bookings per ZIP.</span>
      </div>
    </div>
  );
}
