"use client";
import { useCallback, useEffect, useState } from "react";
import { API, apiHeaders } from "@/lib/api";

type Fare = {
  id: string; source: "ADMIN" | "SHEET"; travelDate: string; origin: string; destination: string;
  airline: string; airlineName: string | null; flightNumber: string; departureTime: string; arrivalTime: string;
  arrivalDayOffset: number; durationMinutes: number | null; stops: number; cabinClass: string;
  adultFare: string; childFare: string | null; infantFare: string | null; currency: string; seatsAvailable: number;
  checkedBaggage: string | null; cabinBaggage: string | null; isRefundable: boolean; notes: string | null; isActive: boolean;
};

// Form fields use the Google Sheet column names (the API validates both the same way).
type Form = Record<string, string | boolean>;
const today = () => new Date().toISOString().slice(0, 10);
const blank = (): Form => ({
  date: today(), origin: "", destination: "", airline: "", airline_name: "", flight_number: "",
  departure_time: "", arrival_time: "", arrival_day_offset: "0", duration_minutes: "", stops: "0", cabin: "ECONOMY",
  adult_fare: "", child_fare: "", infant_fare: "", currency: "INR", seats: "9",
  checked_baggage: "", cabin_baggage: "", refundable: false, notes: "", active: true,
});
const toForm = (f: Fare): Form => ({
  date: f.travelDate, origin: f.origin, destination: f.destination, airline: f.airline, airline_name: f.airlineName ?? "",
  flight_number: f.flightNumber, departure_time: f.departureTime, arrival_time: f.arrivalTime,
  arrival_day_offset: String(f.arrivalDayOffset), duration_minutes: f.durationMinutes == null ? "" : String(f.durationMinutes),
  stops: String(f.stops), cabin: f.cabinClass, adult_fare: f.adultFare, child_fare: f.childFare ?? "", infant_fare: f.infantFare ?? "",
  currency: f.currency, seats: String(f.seatsAvailable), checked_baggage: f.checkedBaggage ?? "", cabin_baggage: f.cabinBaggage ?? "",
  refundable: f.isRefundable, notes: f.notes ?? "", active: f.isActive,
});
const CURRENCIES = ["INR", "AED", "SAR", "QAR", "OMR", "KWD", "BHD", "USD"];
const CABINS: [string, string][] = [["ECONOMY", "Economy"], ["PREMIUM_ECONOMY", "Premium economy"], ["BUSINESS", "Business"], ["FIRST", "First"]];
const price = (v: string | null, cur: string) => (v == null ? "—" : `${cur} ${Number(v).toLocaleString("en-IN")}`);

export default function ManualFaresPage() {
  const [fares, setFares] = useState<Fare[] | null>(null);
  const [filter, setFilter] = useState({ from: today(), to: "", origin: "", destination: "", source: "" });
  const [form, setForm] = useState<Form | null>(null);
  const [editing, setEditing] = useState<Fare | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v));
    try {
      const res = await fetch(`${API}/api/admin/flight-sources/manual/fares?${qs}`, { headers: apiHeaders() });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? d.message ?? `HTTP ${res.status}`);
      setFares(d.fares);
    } catch (e: any) { setError(e.message); }
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy("save"); setError(""); setNotice("");
    try {
      const res = await fetch(`${API}/api/admin/flight-sources/manual/fares${editing ? `/${editing.id}` : ""}`, {
        method: editing ? "PUT" : "POST", headers: apiHeaders(), body: JSON.stringify(form),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? d.message ?? `HTTP ${res.status}`);
      setNotice(editing ? "Fare updated." : "Fare added — it shows in search now (allow up to 5 minutes for cached searches).");
      setForm(null); setEditing(null); load();
    } catch (e: any) { setError(e.message); } finally { setBusy(""); }
  }

  async function remove(f: Fare) {
    if (!confirm(`Delete ${f.flightNumber} ${f.origin}→${f.destination} on ${f.travelDate}?`)) return;
    setBusy(f.id); setError(""); setNotice("");
    try {
      const res = await fetch(`${API}/api/admin/flight-sources/manual/fares/${f.id}`, { method: "DELETE", headers: apiHeaders() });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      load();
    } catch (e: any) { setError(e.message); } finally { setBusy(""); }
  }

  async function syncNow() {
    setBusy("sync"); setError(""); setNotice("");
    try {
      const res = await fetch(`${API}/api/admin/flight-sources/manual/sync`, { method: "POST", headers: apiHeaders() });
      const r = await res.json().catch(() => ({}));
      if (!r.ok) throw new Error(r.errors?.join(" · ") || r.error || r.message || `HTTP ${res.status}`);
      setNotice(`Google Sheet synced: imported ${r.imported}, skipped ${r.skipped}.${r.errors?.length ? ` ${r.errors.join(" · ")}` : ""}`);
      load();
    } catch (e: any) { setError(`Sheet sync failed: ${e.message}`); } finally { setBusy(""); }
  }

  const set = (k: string, v: string | boolean) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const txt = (k: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label style={lbl}>{label}<input value={String(form?.[k] ?? "")} onChange={(e) => set(k, props.maxLength === 3 || k === "airline" ? e.target.value.toUpperCase() : e.target.value)} style={input} {...props} /></label>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", margin: 0 }}>Manual fares</h1>
          <p style={{ color: "#64748b", fontSize: 14, margin: "6px 0 0", maxWidth: 680, lineHeight: 1.5 }}>
            Your own prices, shown in search next to TripJack and Poomas. Fares from the Google Sheet are marked <b style={{ color: "#cbd5e1" }}>Sheet</b> and
            are replaced on every sync, so change those in the sheet. Turn the source on and link the sheet in <a href="/suppliers#manual" style={{ color: "#93c5fd" }}>Suppliers</a>.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button disabled={!!busy} onClick={syncNow} style={btnGhost}>{busy === "sync" ? "Syncing…" : "Sync Google Sheet now"}</button>
          <button onClick={() => { setEditing(null); setForm(blank()); }} style={btn}>+ Add fare</button>
        </div>
      </div>

      {error && <div style={errBox}>{error}</div>}
      {notice && <div style={okBox}>{notice}</div>}

      {form && (
        <form onSubmit={save} style={{ ...card, marginBottom: 16 }}>
          <h2 style={{ fontSize: 15, color: "#f1f5f9", margin: "0 0 12px" }}>{editing ? `Edit ${editing.flightNumber} on ${editing.travelDate}` : "Add a fare"}</h2>
          {editing?.source === "SHEET" && <div style={{ ...errBox, borderColor: "#a16207", color: "#fde047", background: "rgba(234,179,8,.08)" }}>This fare came from the Google Sheet — the next sync will overwrite changes made here.</div>}
          <div style={grid}>
            <label style={lbl}>Date *<input type="date" required value={String(form.date)} onChange={(e) => set("date", e.target.value)} style={input} /></label>
            {txt("origin", "From (airport code) *", { required: true, maxLength: 3, placeholder: "COK" })}
            {txt("destination", "To (airport code) *", { required: true, maxLength: 3, placeholder: "DXB" })}
            {txt("airline", "Airline code *", { required: true, maxLength: 2, placeholder: "6E" })}
            {txt("airline_name", "Airline name", { placeholder: "IndiGo" })}
            {txt("flight_number", "Flight number *", { required: true, placeholder: "6E 1403" })}
            <label style={lbl}>Departs *<input type="time" required value={String(form.departure_time)} onChange={(e) => set("departure_time", e.target.value)} style={input} /></label>
            <label style={lbl}>Arrives *<input type="time" required value={String(form.arrival_time)} onChange={(e) => set("arrival_time", e.target.value)} style={input} /></label>
            <label style={lbl}>Arrival day<select value={String(form.arrival_day_offset)} onChange={(e) => set("arrival_day_offset", e.target.value)} style={input}><option value="0">Same day</option><option value="1">Next day (+1)</option><option value="2">+2 days</option></select></label>
            {txt("duration_minutes", "Flight time (minutes)", { inputMode: "numeric", placeholder: "Auto from times" })}
            <label style={lbl}>Stops<select value={String(form.stops)} onChange={(e) => set("stops", e.target.value)} style={input}><option value="0">Non-stop</option><option value="1">1 stop</option><option value="2">2 stops</option></select></label>
            <label style={lbl}>Cabin<select value={String(form.cabin)} onChange={(e) => set("cabin", e.target.value)} style={input}>{CABINS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            {txt("adult_fare", "Adult fare (incl. taxes) *", { required: true, inputMode: "decimal" })}
            {txt("child_fare", "Child fare", { inputMode: "decimal", placeholder: "Same as adult" })}
            {txt("infant_fare", "Infant fare", { inputMode: "decimal", placeholder: "Free" })}
            <label style={lbl}>Currency<select value={String(form.currency)} onChange={(e) => set("currency", e.target.value)} style={input}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></label>
            {txt("seats", "Seats available", { inputMode: "numeric" })}
            {txt("checked_baggage", "Checked baggage", { placeholder: "30 KG" })}
            {txt("cabin_baggage", "Cabin baggage", { placeholder: "7 KG" })}
            {txt("notes", "Internal notes")}
            <label style={{ ...lbl, flexDirection: "row", display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" checked={Boolean(form.refundable)} onChange={(e) => set("refundable", e.target.checked)} /> Refundable</label>
            <label style={{ ...lbl, flexDirection: "row", display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" checked={Boolean(form.active)} onChange={(e) => set("active", e.target.checked)} /> Show in search</label>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button disabled={busy === "save"} style={btn}>{busy === "save" ? "Saving…" : editing ? "Save changes" : "Add fare"}</button>
            <button type="button" onClick={() => { setForm(null); setEditing(null); }} style={btnGhost}>Cancel</button>
          </div>
        </form>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "end" }}>
        <label style={lbl}>From date<input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} style={input} /></label>
        <label style={lbl}>To date<input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} style={input} /></label>
        <label style={lbl}>From<input value={filter.origin} maxLength={3} onChange={(e) => setFilter({ ...filter, origin: e.target.value.toUpperCase() })} placeholder="Any" style={{ ...input, width: 90 }} /></label>
        <label style={lbl}>To<input value={filter.destination} maxLength={3} onChange={(e) => setFilter({ ...filter, destination: e.target.value.toUpperCase() })} placeholder="Any" style={{ ...input, width: 90 }} /></label>
        <label style={lbl}>Source<select value={filter.source} onChange={(e) => setFilter({ ...filter, source: e.target.value })} style={input}><option value="">All</option><option value="ADMIN">Added here</option><option value="SHEET">Google Sheet</option></select></label>
      </div>

      <div style={{ ...card, padding: 0, overflowX: "auto" }}>
        {!fares ? <p style={{ color: "#64748b", padding: 16 }}>Loading…</p> : fares.length === 0 ? (
          <p style={{ color: "#64748b", padding: 16, fontSize: 14 }}>No fares from {filter.from}. Add one, or link a Google Sheet in Flight sources.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr>{["Date", "Route", "Flight", "Times", "Cabin", "Adult", "Child / infant", "Seats", "Source", ""].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {fares.map((f) => (
                <tr key={f.id} style={{ opacity: f.isActive ? 1 : 0.5 }}>
                  <td style={td}>{new Date(`${f.travelDate}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</td>
                  <td style={td}><b>{f.origin} → {f.destination}</b>{f.stops ? <small style={{ display: "block", color: "#94a3b8" }}>{f.stops} stop</small> : null}</td>
                  <td style={td}>{f.flightNumber}<small style={{ display: "block", color: "#94a3b8" }}>{f.airlineName ?? f.airline}</small></td>
                  <td style={td}>{f.departureTime} – {f.arrivalTime}{f.arrivalDayOffset ? <sup style={{ color: "#fbbf24" }}>+{f.arrivalDayOffset}</sup> : null}</td>
                  <td style={td}>{CABINS.find(([v]) => v === f.cabinClass)?.[1] ?? f.cabinClass}</td>
                  <td style={td}><b>{price(f.adultFare, f.currency)}</b>{f.isRefundable ? <small style={{ display: "block", color: "#86efac" }}>Refundable</small> : null}</td>
                  <td style={td}>{f.childFare ? price(f.childFare, f.currency) : "Adult"} / {f.infantFare ? price(f.infantFare, f.currency) : "Free"}</td>
                  <td style={{ ...td, color: f.seatsAvailable === 0 ? "#f87171" : "#e2e8f0", fontWeight: 700 }}>{f.seatsAvailable === 0 ? "Sold out" : f.seatsAvailable}</td>
                  <td style={td}><span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: f.source === "SHEET" ? "#052e16" : "#172554", color: f.source === "SHEET" ? "#86efac" : "#93c5fd" }}>{f.source === "SHEET" ? "Sheet" : "Admin"}</span>{!f.isActive && <small style={{ display: "block", color: "#94a3b8" }}>Hidden</small>}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    <button onClick={() => { setEditing(f); setForm(toForm(f)); window.scrollTo({ top: 0, behavior: "smooth" }); }} style={small}>Edit</button>{" "}
                    <button disabled={busy === f.id} onClick={() => remove(f)} style={{ ...small, color: "#fca5a5" }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {fares?.length === 500 && <p style={{ color: "#64748b", fontSize: 12, marginTop: 8 }}>Showing the first 500 fares — narrow the dates or route to see the rest.</p>}
    </div>
  );
}

const card: React.CSSProperties = { background: "#1e293b", borderRadius: 12, padding: 18, border: "1px solid #334155" };
const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 };
const lbl: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5, fontSize: 12, fontWeight: 600, color: "#94a3b8" };
const input: React.CSSProperties = { padding: "8px 10px", background: "#0f172a", border: "1.5px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 14, minWidth: 0 };
const th: React.CSSProperties = { textAlign: "left", color: "#64748b", fontWeight: 600, padding: "10px 12px", borderBottom: "1px solid #334155", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "10px 12px", borderBottom: "1px solid #0f172a", color: "#e2e8f0", verticalAlign: "top" };
const btn: React.CSSProperties = { background: "#0D4B96", color: "white", border: "none", borderRadius: 8, padding: "9px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" };
const btnGhost: React.CSSProperties = { ...btn, background: "#0f172a", border: "1px solid #334155", color: "#e2e8f0" };
const small: React.CSSProperties = { background: "#0f172a", border: "1px solid #334155", color: "#e2e8f0", borderRadius: 6, padding: "4px 10px", fontWeight: 600, fontSize: 12, cursor: "pointer" };
const errBox: React.CSSProperties = { background: "rgba(239,68,68,.1)", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 8, padding: "10px 12px", fontSize: 13, margin: "0 0 12px" };
const okBox: React.CSSProperties = { background: "rgba(34,197,94,.1)", border: "1px solid #166534", color: "#86efac", borderRadius: 8, padding: "10px 12px", fontSize: 13, margin: "0 0 12px" };
