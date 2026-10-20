// Downloadable flight itinerary, built from the live TripJack booking details
// (see liveItinerary) plus our own booking record.

import type { Itinerary } from "./trips.js";

export interface ItineraryDocData {
  bookingId:    string;
  pnr:          string | null;
  status:       string;
  bookedAt:     Date | string | null;
  origin:       string;
  destination:  string;
  totalAmount:  number;
  currency:     string;
  contactEmail: string | null;
  contactPhone: string | null;
  itinerary:    Itinerary;
  // "eticket" titles the same TripJack booking-details document as the e-ticket.
  docType?:     "itinerary" | "eticket";
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (ch) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!
));

// TripJack times are local airport times without an offset ("2026-10-02T06:15").
// Format them as written instead of shifting them through a timezone.
function fmtDateTime(s: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return { date: s, time: "" };
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const date = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return { date, time: `${m[4]}:${m[5]}` };
}

function money(n: number, currency: string) {
  try { return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(n); }
  catch { return `${currency} ${n.toFixed(2)}`; }
}

export function itineraryFileName(data: Pick<ItineraryDocData, "pnr" | "bookingId">) {
  return `itinerary-${(data.pnr ?? data.bookingId.slice(0, 8)).replace(/[^A-Za-z0-9-]/g, "")}.html`;
}

export function renderItineraryHtml(data: ItineraryDocData): string {
  const { itinerary } = data;
  const pnr = data.pnr ?? itinerary.pnr ?? "Pending";
  const docName = data.docType === "eticket" ? "E-ticket" : "Flight itinerary";
  const bookedAt = data.bookedAt ? new Date(data.bookedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";

  const segments = itinerary.segments.map((s) => {
    const dep = fmtDateTime(s.departure);
    const arr = fmtDateTime(s.arrival);
    const duration = s.durationMin ? `${Math.floor(s.durationMin / 60)}h ${s.durationMin % 60}m` : "";
    const baggage = [s.cabinBaggage && `Cabin ${s.cabinBaggage}`, s.checkedBaggage && `Check-in ${s.checkedBaggage}`].filter(Boolean).join(" · ");
    return `
    <div class="seg">
      <div class="seg-head"><strong>${esc(s.airlineName || s.airline)}</strong> · ${esc(s.flightNumber)}${duration ? ` · ${duration}` : ""}</div>
      <div class="seg-row">
        <div>
          <div class="time">${esc(dep.time)}</div>
          <div class="code">${esc(s.from.code)}${s.from.city ? ` · ${esc(s.from.city)}` : ""}</div>
          <div class="small">${esc(dep.date)}</div>
          <div class="small">${esc(s.from.name ?? "")}${s.from.terminal ? ` · ${esc(s.from.terminal)}` : ""}</div>
        </div>
        <div class="plane">✈</div>
        <div class="right">
          <div class="time">${esc(arr.time)}</div>
          <div class="code">${esc(s.to.code)}${s.to.city ? ` · ${esc(s.to.city)}` : ""}</div>
          <div class="small">${esc(arr.date)}</div>
          <div class="small">${esc(s.to.name ?? "")}${s.to.terminal ? ` · ${esc(s.to.terminal)}` : ""}</div>
        </div>
      </div>
      ${baggage ? `<div class="small bag">Baggage: ${esc(baggage)}</div>` : ""}
    </div>`;
  }).join("");

  const travellers = itinerary.travellers.map((t) => `
      <tr>
        <td>${esc(t.name)}</td>
        <td>${esc((t.type ?? "").toLowerCase())}</td>
        <td class="mono">${esc(t.pnr ?? pnr)}</td>
        <td class="mono">${esc(t.ticketNumber ?? "—")}</td>
      </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${data.docType === "eticket" ? "E-ticket" : "Itinerary"} — ${esc(pnr)} · ${esc(data.origin)} to ${esc(data.destination)}</title>
<style>
  body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background:#f1f5f9; color:#0f172a; }
  .doc { max-width:720px; margin:20px auto; background:#fff; border-radius:14px; overflow:hidden; border:1px solid #e2e8f0; }
  .head { background:#E31E24; color:#fff; padding:22px 24px; display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; }
  .head h1 { margin:0; font-size:20px; }
  .head .sub { opacity:.85; font-size:13px; margin-top:4px; }
  .pnr { text-align:right; }
  .pnr small { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.08em; opacity:.85; }
  .pnr strong { font-family:monospace; font-size:26px; letter-spacing:.12em; }
  .section { padding:18px 24px; border-top:1px solid #f1f5f9; }
  .title { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.08em; color:#64748b; margin-bottom:10px; }
  .seg { padding:12px 0; border-top:1px dashed #e2e8f0; }
  .seg:first-of-type { border-top:0; }
  .seg-head { font-size:13px; color:#475569; margin-bottom:8px; }
  .seg-row { display:grid; grid-template-columns:1fr auto 1fr; gap:10px; align-items:center; }
  .time { font-size:24px; font-weight:800; }
  .code { font-weight:700; }
  .small { font-size:12px; color:#64748b; }
  .bag { margin-top:6px; }
  .plane { color:#E31E24; font-size:20px; }
  .right { text-align:right; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; font-size:11px; text-transform:uppercase; color:#64748b; padding:6px 8px; border-bottom:2px solid #f1f5f9; }
  td { padding:8px; border-bottom:1px solid #f1f5f9; }
  .mono { font-family:monospace; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; font-size:13px; }
  .grid small { display:block; color:#64748b; }
  .foot { padding:16px 24px; font-size:11px; color:#64748b; background:#f8fafc; }
  @media print { body { background:#fff; } .doc { margin:0; border:0; } }
</style>
</head>
<body>
<div class="doc">
  <div class="head">
    <div>
      <h1>${docName} · ${esc(data.origin)} → ${esc(data.destination)}</h1>
      <div class="sub">POOMAS · flypoomas.com${bookedAt ? ` · Booked ${esc(bookedAt)}` : ""}</div>
    </div>
    <div class="pnr"><small>Airline PNR</small><strong>${esc(pnr)}</strong></div>
  </div>
  <div class="section">
    <div class="title">Flights</div>
    ${segments || `<div class="small">Flight details are not available yet.</div>`}
  </div>
  <div class="section">
    <div class="title">Travellers</div>
    <table>
      <thead><tr><th>Name</th><th>Type</th><th>PNR</th><th>Ticket no.</th></tr></thead>
      <tbody>${travellers}</tbody>
    </table>
  </div>
  <div class="section">
    <div class="grid">
      <div><small>Booking ID</small><strong class="mono">${esc(data.bookingId.slice(0, 8).toUpperCase())}</strong></div>
      <div><small>Status</small><strong>${esc(itinerary.supplierStatus ?? data.status)}</strong></div>
      <div><small>Total paid</small><strong>${esc(money(data.totalAmount, data.currency))}</strong></div>
      <div><small>Contact</small><strong>${esc(data.contactEmail ?? "")}</strong>${data.contactPhone ? `<div>${esc(data.contactPhone)}</div>` : ""}</div>
    </div>
  </div>
  <div class="foot">
    Times are local to each airport. Please reach the airport at least 3 hours before international and 2 hours before domestic departures,
    carry a valid photo ID / passport, and complete web check-in on the airline's website using your PNR and last name.
  </div>
</div>
</body>
</html>`;
}
