// E-ticket HTML generation and R2 storage
// Generates a self-contained HTML ticket for email embedding and PDF export.

import type { R2Bucket } from "@cloudflare/workers-types";

export interface ETicketData {
  bookingRef:    string;
  pnr:           string;
  ticketNumbers: string[];
  airline:       string;
  airlineName:   string;
  flightNumber:  string;
  origin:        string;
  destination:   string;
  departureTime: string;
  arrivalTime:   string;
  cabinClass:    string;
  passengers:    { name: string; type: string; ticketNumber?: string }[];
  totalAmount:   number;
  currency:      string;
  isRefundable:  boolean;
  baggage:       { cabin: string; checked: string };
  brandName:     string;
  brandLogo?:    string;
  primaryColor:  string;
  supportEmail?: string;
}

export function renderETicketHtml(data: ETicketData): string {
  const fmt = new Intl.DateTimeFormat("en-IN", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });

  const depDate  = fmt.format(new Date(data.departureTime));
  const arrDate  = fmt.format(new Date(data.arrivalTime));
  const color    = data.primaryColor ?? "#E31E24";
  const currSym  = data.currency === "INR" ? "₹" : data.currency === "AED" ? "د.إ" : "$";

  const passengerRows = data.passengers
    .map((p) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">${p.name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">${p.type}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-family:monospace;">${p.ticketNumber ?? "—"}</td>
      </tr>
    `).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>E-Ticket — ${data.pnr}</title>
<style>
  body { margin:0; font-family: system-ui, -apple-system, sans-serif; background:#f5f5f5; color:#1a1a1a; }
  .ticket { max-width:680px; margin:24px auto; background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 4px 20px rgba(0,0,0,.1); }
  .header { background:${color}; color:#fff; padding:28px 32px; display:flex; align-items:center; justify-content:space-between; }
  .header h1 { margin:0; font-size:22px; font-weight:700; }
  .header .pnr-box { text-align:right; }
  .header .pnr-label { font-size:11px; opacity:.8; text-transform:uppercase; letter-spacing:.06em; }
  .header .pnr { font-size:28px; font-weight:800; letter-spacing:.15em; font-family:monospace; }
  .route { padding:28px 32px; border-bottom:1px solid #f0f0f0; display:flex; align-items:center; gap:24px; }
  .airport { flex:1; }
  .airport .code { font-size:42px; font-weight:800; color:${color}; }
  .airport .time { font-size:13px; color:#555; margin-top:2px; }
  .mid { text-align:center; flex-shrink:0; }
  .mid .flight { font-size:13px; font-weight:600; color:#888; }
  .mid .arrow { font-size:24px; color:${color}; }
  .section { padding:20px 32px; border-bottom:1px solid #f0f0f0; }
  .section-title { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:#888; margin-bottom:12px; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; padding:8px 12px; font-size:11px; text-transform:uppercase; color:#888; border-bottom:2px solid #f0f0f0; }
  .meta-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; }
  .meta-item .label { font-size:11px; color:#888; text-transform:uppercase; letter-spacing:.06em; }
  .meta-item .value { font-size:14px; font-weight:600; margin-top:4px; }
  .footer { padding:20px 32px; text-align:center; font-size:12px; color:#888; }
  .total { font-size:20px; font-weight:800; color:${color}; }
</style>
</head>
<body>
<div class="ticket">
  <div class="header">
    <div>
      ${data.brandLogo ? `<img src="${data.brandLogo}" alt="${data.brandName}" style="height:36px;margin-bottom:8px;" /><br/>` : ""}
      <h1>${data.brandName}</h1>
      <div style="font-size:12px;opacity:.8;">Booking Confirmation</div>
    </div>
    <div class="pnr-box">
      <div class="pnr-label">PNR</div>
      <div class="pnr">${data.pnr}</div>
    </div>
  </div>

  <div class="route">
    <div class="airport">
      <div class="code">${data.origin}</div>
      <div class="time">${depDate}</div>
    </div>
    <div class="mid">
      <div class="flight">${data.airlineName} ${data.flightNumber}</div>
      <div class="arrow">→</div>
      <div style="font-size:11px;color:#888;">${data.cabinClass}</div>
    </div>
    <div class="airport" style="text-align:right;">
      <div class="code">${data.destination}</div>
      <div class="time">${arrDate}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Passengers</div>
    <table>
      <thead><tr>
        <th>Name</th><th>Type</th><th>Ticket No.</th>
      </tr></thead>
      <tbody>${passengerRows}</tbody>
    </table>
  </div>

  <div class="section">
    <div class="section-title">Flight Details</div>
    <div class="meta-grid">
      <div class="meta-item">
        <div class="label">Cabin Baggage</div>
        <div class="value">${data.baggage.cabin}</div>
      </div>
      <div class="meta-item">
        <div class="label">Check-in Baggage</div>
        <div class="value">${data.baggage.checked}</div>
      </div>
      <div class="meta-item">
        <div class="label">Refundable</div>
        <div class="value">${data.isRefundable ? "Yes" : "Non-refundable"}</div>
      </div>
    </div>
  </div>

  <div class="section" style="display:flex;align-items:center;justify-content:space-between;">
    <div>
      <div class="section-title">Booking Reference</div>
      <div style="font-family:monospace;font-size:15px;font-weight:700;">${data.bookingRef}</div>
    </div>
    <div style="text-align:right;">
      <div class="section-title">Total Paid</div>
      <div class="total">${currSym} ${data.totalAmount.toLocaleString("en-IN")}</div>
    </div>
  </div>

  <div class="footer">
    ${data.supportEmail ? `For support, email <a href="mailto:${data.supportEmail}" style="color:${color};">${data.supportEmail}</a> &nbsp;|&nbsp; ` : ""}
    This is your official e-ticket. Present this at the airport check-in counter.
  </div>
</div>
</body>
</html>`;
}

export async function storeETicket(
  r2: R2Bucket,
  bookingId: string,
  html: string,
): Promise<string> {
  const key = `etickets/${bookingId}.html`;
  await r2.put(key, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: { bookingId, generatedAt: new Date().toISOString() },
  });
  return key;
}
