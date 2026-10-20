"use client";

// "Book this trip again" — searches the same route, cabin and travellers on a
// new date; the traveller details are filled in on the booking page.

import { FormEvent, useState } from "react";
import { apiCall } from "../lib/customer-api";

type RebookData = {
  origin: string; destination: string; tripType: "ONEWAY" | "ROUNDTRIP"; cabinClass: string; currency: string;
  adults: number; children: number; infants: number; lastDepartureDate: string | null;
  travellers: { type: string; firstName: string; lastName: string; dob: string | null; gender: string | null; nationality: string | null; passportNumber: string | null; passportExpiry: string | null }[];
};

const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export function Rebook({ tripId, origin, destination }: { tripId: string; origin: string; destination: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(addDays(today, 7));
  const [returnDate, setReturnDate] = useState("");
  const [roundTrip, setRoundTrip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function go(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const d = await apiCall<RebookData>(`/api/profile/trips/${tripId}/rebook`);
      try {
        sessionStorage.setItem("rebook_travellers", JSON.stringify({ origin: d.origin, destination: d.destination, at: Date.now(), travellers: d.travellers }));
      } catch { /* prefill is a convenience only */ }
      const rt = roundTrip && returnDate >= date;
      const q = new URLSearchParams({
        origin: d.origin, destination: d.destination, departureDate: date,
        adults: String(d.adults || 1), children: String(d.children), infants: String(d.infants),
        cabinClass: d.cabinClass || "ECONOMY", tripType: rt ? "ROUNDTRIP" : "ONEWAY", currency: d.currency || "INR",
        ...(rt ? { returnDate } : {}),
      });
      window.location.assign(`${rt ? "/search/journey" : "/search"}?${q}`);
    } catch (x: any) {
      setError(x?.message ?? "Couldn't load this trip.");
      setBusy(false);
    }
  }

  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} style={btn}>↻ Book this trip again</button>;
  }
  return (
    <form onSubmit={go} style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
      <b style={{ fontSize: 14 }}>Book {origin} → {destination} again — same travellers</b>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <label style={lbl}>Departure
          <input type="date" required min={today} value={date} onChange={(e) => { setDate(e.target.value); if (returnDate && returnDate < e.target.value) setReturnDate(""); }} style={inp} />
        </label>
        <label style={{ ...lbl, flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-end", paddingBottom: 10 }}>
          <input type="checkbox" checked={roundTrip} onChange={(e) => setRoundTrip(e.target.checked)} /> Return flight
        </label>
        {roundTrip && (
          <label style={lbl}>Return
            <input type="date" required min={date} value={returnDate} onChange={(e) => setReturnDate(e.target.value)} style={inp} />
          </label>
        )}
      </div>
      <small style={{ color: "#64748b" }}>Traveller names and saved passport details are filled in for you — please check them before paying.</small>
      {error && <small style={{ color: "#b91c1c" }}>{error}</small>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" disabled={busy} style={{ ...btn, background: "#E31E24", color: "#fff", borderColor: "#E31E24" }}>{busy ? "Searching…" : "Search flights"}</button>
        <button type="button" onClick={() => setOpen(false)} style={btn}>Cancel</button>
      </div>
    </form>
  );
}

const btn: React.CSSProperties = { border: "1px solid #cbd5e1", background: "#fff", color: "#0f172a", borderRadius: 10, padding: "10px 14px", fontWeight: 700, fontSize: 14, cursor: "pointer" };
const lbl: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 700, color: "#475569" };
const inp: React.CSSProperties = { height: 42, border: "1px solid #cbd5e1", borderRadius: 10, padding: "0 10px", fontSize: 15 };
