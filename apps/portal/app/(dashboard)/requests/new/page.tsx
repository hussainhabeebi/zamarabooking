"use client";

import { FormEvent, useEffect, useState } from "react";
import { api, REQUEST_TYPES } from "../../../../lib/api";

type Field = { key: string; label: string; type?: "text" | "date" | "number" | "select" | "textarea"; options?: string[]; required?: boolean };

// What our team needs for each service.
const FIELDS: Record<string, Field[]> = {
  VISA: [
    { key: "country", label: "Visa for (country)", required: true, type: "select", options: ["UAE", "Saudi Arabia", "Oman", "Qatar", "Bahrain", "Kuwait", "Schengen", "UK", "USA", "Canada", "Singapore", "Malaysia", "Thailand", "Other"] },
    { key: "visaType", label: "Visa type", type: "select", options: ["Tourist 30 days", "Tourist 60 days", "Visit / family", "Business", "Transit", "Work / employment", "Umrah"] },
    { key: "travellers", label: "Number of applicants", type: "number", required: true },
    { key: "travelDate", label: "Travel date", type: "date" },
    { key: "nationality", label: "Passport nationality", required: true },
  ],
  UMRAH: [
    { key: "departureCity", label: "Departure city", required: true }, { key: "travelDate", label: "Travel date", type: "date", required: true },
    { key: "nights", label: "Nights (Makkah + Madinah)", type: "number" }, { key: "travellers", label: "Travellers", type: "number", required: true },
    { key: "hotelCategory", label: "Hotel category", type: "select", options: ["Economy", "3 star", "4 star", "5 star near Haram"] },
  ],
  PACKAGE: [
    { key: "destination", label: "Destination", required: true }, { key: "travelDate", label: "Travel date", type: "date" },
    { key: "nights", label: "Nights", type: "number" }, { key: "travellers", label: "Adults + children", required: true },
    { key: "budget", label: "Budget per person" }, { key: "includes", label: "Include", type: "select", options: ["Flights + hotel + tours", "Hotel + tours", "Hotel only"] },
  ],
  HOTEL: [
    { key: "city", label: "City", required: true }, { key: "checkIn", label: "Check-in", type: "date", required: true }, { key: "checkOut", label: "Check-out", type: "date", required: true },
    { key: "rooms", label: "Rooms", type: "number", required: true }, { key: "guests", label: "Guests", type: "number", required: true },
    { key: "hotel", label: "Preferred hotel / area" }, { key: "budget", label: "Budget per night" },
  ],
  INSURANCE: [
    { key: "destination", label: "Destination", required: true }, { key: "startDate", label: "Trip start", type: "date", required: true },
    { key: "endDate", label: "Trip end", type: "date", required: true }, { key: "travellers", label: "Travellers (names & ages)", type: "textarea", required: true },
  ],
  BUS: [
    { key: "from", label: "From city", required: true }, { key: "to", label: "To city", required: true }, { key: "date", label: "Date", type: "date", required: true },
    { key: "passengers", label: "Passengers", type: "number", required: true }, { key: "busType", label: "Bus type", type: "select", options: ["Any", "AC sleeper", "AC seater", "Non-AC"] },
  ],
  GROUP: [
    { key: "from", label: "From (airport code)", required: true }, { key: "to", label: "To (airport code)", required: true },
    { key: "date", label: "Departure date", type: "date", required: true }, { key: "returnDate", label: "Return date", type: "date" },
    { key: "pax", label: "Number of travellers", type: "number", required: true }, { key: "airline", label: "Preferred airline" },
  ],
  CHARTER: [
    { key: "from", label: "From", required: true }, { key: "to", label: "To", required: true }, { key: "date", label: "Date", type: "date", required: true },
    { key: "pax", label: "Passengers", type: "number", required: true }, { key: "aircraft", label: "Aircraft preference", type: "select", options: ["Any", "Light jet", "Midsize jet", "Heavy jet", "Turboprop"] },
  ],
  AMENDMENT: [{ key: "pnr", label: "PNR / booking ID", required: true }, { key: "change", label: "Change needed", type: "select", options: ["Date change", "Name correction", "Add baggage", "Meal / seat", "Reissue", "Refund", "Other"] }],
  OFFLINE_BOOKING: [{ key: "pnr", label: "PNR", required: true }, { key: "airline", label: "Airline" }, { key: "route", label: "Route" }, { key: "travelDate", label: "Travel date", type: "date" }],
  SUPPORT: [],
};

export default function NewRequestPage() {
  const [type, setType] = useState("");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [bookingId, setBookingId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("type") ?? "";
    if (REQUEST_TYPES.some((r) => r.type === t)) setType(t);
    if (t === "GROUP") setDetails({ from: q.get("from") ?? "", to: q.get("to") ?? "", date: q.get("date") ?? "", pax: q.get("pax") ?? "" });
    if (q.get("bookingId")) setBookingId(q.get("bookingId")!);
  }, []);

  const meta = REQUEST_TYPES.find((r) => r.type === type);
  const fields = FIELDS[type] ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const autoTitle = title.trim() || `${meta?.label}${details.country ? ` · ${details.country}` : details.destination ? ` · ${details.destination}` : details.city ? ` · ${details.city}` : details.from && details.to ? ` · ${details.from} → ${details.to}` : ""}`;
      const form = new FormData();
      form.append("type", type);
      form.append("title", autoTitle);
      form.append("details", JSON.stringify({ ...details, message: message.trim() }));
      if (bookingId) form.append("bookingId", bookingId);
      files.forEach((f) => form.append("files", f));
      const d = await api<{ request: { id: string } }>("/api/agent/requests/upload", { method: "POST", body: form });
      window.location.assign(`/requests/${d.request.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the request");
      setBusy(false);
    }
  }

  return (
    <div>
      <a href="/requests">← Requests</a>
      <div className="page-head" style={{ marginTop: 8 }}><div><h1>New request</h1><p>Our team replies in this thread and on WhatsApp.</p></div></div>
      <div className="service-grid" style={{ marginBottom: 16 }}>
        {REQUEST_TYPES.map((r) => (
          <button key={r.type} type="button" className={`service${type === r.type ? " on" : ""}`} onClick={() => setType(r.type)}>
            <span style={{ fontSize: 22 }}>{r.icon}</span><b>{r.label}</b><small>{r.hint}</small>
          </button>
        ))}
      </div>
      {type && (
        <form className="card stack" onSubmit={submit}>
          <h2>{meta?.icon} {meta?.label}</h2>
          {error && <div className="banner bad">{error}</div>}
          <label className="f">Title (optional)<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${meta?.label} request`} /></label>
          {fields.length > 0 && (
            <div className="grid g3">
              {fields.map((f) => (
                <label key={f.key} className="f" style={f.type === "textarea" ? { gridColumn: "1 / -1" } : undefined}>{f.label}{f.required ? "" : " (optional)"}
                  {f.type === "select" ? (
                    <select required={f.required} value={details[f.key] ?? ""} onChange={(e) => setDetails((d) => ({ ...d, [f.key]: e.target.value }))}>
                      <option value="">Choose…</option>{f.options!.map((o) => <option key={o}>{o}</option>)}
                    </select>
                  ) : f.type === "textarea" ? (
                    <textarea required={f.required} value={details[f.key] ?? ""} onChange={(e) => setDetails((d) => ({ ...d, [f.key]: e.target.value }))} />
                  ) : (
                    <input type={f.type ?? "text"} required={f.required} value={details[f.key] ?? ""} onChange={(e) => setDetails((d) => ({ ...d, [f.key]: e.target.value }))} />
                  )}
                </label>
              ))}
            </div>
          )}
          <label className="f">Message / notes<textarea value={message} required={type === "SUPPORT"} onChange={(e) => setMessage(e.target.value)} placeholder="Anything our team should know" /></label>
          <label className="f">Documents {type === "VISA" ? "(passport front & back, photo, ID)" : "(optional)"}
            <input type="file" multiple accept="image/*,application/pdf" onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 10))} />
          </label>
          {files.length > 0 && <p className="small muted" style={{ margin: 0 }}>{files.length} file(s): {files.map((f) => f.name).join(", ")}</p>}
          <button className="btn primary" disabled={busy} style={{ alignSelf: "flex-start" }}>{busy ? "Sending…" : "Send request"}</button>
        </form>
      )}
    </div>
  );
}
