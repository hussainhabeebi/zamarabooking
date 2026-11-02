// Customer e-ticket as a PDF (the email attachment), built only from the confirmed booking:
// the booking's own status, airline PNR and the ticket numbers stored when the supplier (or
// staff, for Poomas / Akbar / manual fares) issued them, the travellers, and the flights saved
// at booking. Nothing is generated: a missing ticket number prints as "Pending", and no PDF is
// produced at all without a confirmed booking and an airline PNR.
//
// Layout follows the HTML e-ticket (lib/eticket.ts): brand header with the PNR, route per
// flight, passengers with ticket numbers, baggage / refundability, booking reference and total.
// The PDF is written directly (PDF 1.4, A4, the standard Helvetica / Courier fonts), so it needs
// no library and runs in the Worker.

import { isOfflineSupplier } from "./flight-sources.js";

export interface ETicketSegment {
  airline: string; airlineName: string; flightNumber: string;
  origin: string; destination: string;
  departureTime: string; arrivalTime: string;
  cabinClass?: string;
}

export interface ETicketDocument {
  brandName:    string;
  primaryColor: string;
  supportEmail?: string;
  pnr:          string;
  bookingRef:   string;
  status:       string;
  bookedAt?:    string;
  segments:     ETicketSegment[];
  passengers:   { name: string; type: string; ticketNumber: string | null }[];
  baggage:      { cabin: string; checked: string };
  isRefundable: boolean;
  totalAmount:  number;
  currency:     string;
}

type BookingLike = {
  id: string; status: string; supplier: string | null; pnr: string | null; ticketNumbers: string[] | null;
  origin: string; destination: string; departureDate: Date | string; cabinClass?: string | null;
  totalAmount: string | number; currency: string; createdAt?: Date | string | null; flightData: unknown;
};
type PassengerLike = { firstName: string; lastName: string; passengerType: string };
type TenantLike = { name?: string | null; primaryColor?: string | null; supportEmail?: string | null } | null | undefined;

const str = (v: unknown) => (v == null ? "" : String(v).trim());
const iso = (v: Date | string | null | undefined) => (!v ? "" : v instanceof Date ? v.toISOString() : String(v));

// The flights saved at booking: TripJack review segments, Akbar journey legs, or the one fare.
function bookingSegments(b: BookingLike, fd: Record<string, any>): ETicketSegment[] {
  const seg = (s: Record<string, any>, fallback: Partial<ETicketSegment> = {}): ETicketSegment => ({
    airline: str(s.airline ?? fallback.airline), airlineName: str(s.airlineName ?? s.airline ?? fallback.airlineName),
    flightNumber: str(s.flightNumber ?? fallback.flightNumber),
    origin: str(s.origin ?? fallback.origin).toUpperCase(), destination: str(s.destination ?? fallback.destination).toUpperCase(),
    departureTime: str(s.departureTime ?? fallback.departureTime), arrivalTime: str(s.arrivalTime ?? fallback.arrivalTime),
    cabinClass: str(s.cabinClass ?? fallback.cabinClass) || undefined,
  });
  const cabin = str(fd.cabinClass ?? b.cabinClass);
  const list: Record<string, any>[] = Array.isArray(fd.tripjack?.segments) && fd.tripjack.segments.length ? fd.tripjack.segments
    : Array.isArray(fd.offline?.legs) && fd.offline.legs.length ? fd.offline.legs
    : [];
  const segments = list.length
    ? list.map((s) => seg(s, { cabinClass: cabin }))
    : [seg(fd, { origin: b.origin, destination: b.destination, departureTime: iso(b.departureDate), cabinClass: cabin })];
  return segments.filter((s) => /^[A-Z]{3}$/.test(s.origin) && /^[A-Z]{3}$/.test(s.destination) && s.departureTime);
}

// The e-ticket for a booking, or null when the booking may not have one yet.
export function eticketDocument(b: BookingLike, pax: PassengerLike[], tenant: TenantLike): ETicketDocument | null {
  if (b.status !== "CONFIRMED" && b.status !== "TICKETED") return null;
  // Staff- or Akbar-API-ticketed fares carry a PNR only once the ticket is issued.
  if (isOfflineSupplier(b.supplier) && b.status !== "TICKETED") return null;
  const pnr = str(b.pnr);
  if (!pnr || !pax.length) return null;
  const fd = (b.flightData ?? {}) as Record<string, any>;
  const segments = bookingSegments(b, fd);
  if (!segments.length) return null;
  const legBaggage = Array.isArray(fd.offline?.legs) ? fd.offline.legs.find((l: any) => l?.baggage)?.baggage : undefined;
  const baggage = fd.baggage ?? legBaggage ?? {};
  const tickets = b.ticketNumbers ?? [];
  return {
    brandName: str(tenant?.name) || "Zamra Travels",
    primaryColor: /^#[0-9a-f]{6}$/i.test(str(tenant?.primaryColor)) ? str(tenant?.primaryColor) : "#0D4B96",
    ...(str(tenant?.supportEmail) ? { supportEmail: str(tenant?.supportEmail) } : {}),
    pnr, bookingRef: b.id, status: b.status, ...(b.createdAt ? { bookedAt: iso(b.createdAt) } : {}),
    segments,
    passengers: pax.map((p, i) => ({ name: `${str(p.firstName)} ${str(p.lastName)}`.trim(), type: str(p.passengerType), ticketNumber: str(tickets[i]) || null })),
    baggage: { cabin: str(baggage.cabin) || "As per airline", checked: str(baggage.checked) || "As per airline" },
    isRefundable: fd.isRefundable === true,
    totalAmount: Number(b.totalAmount) || 0,
    currency: str(b.currency) || "INR",
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Airline times are local to the airport: shown exactly as given, never shifted by a time zone.
export function flightTime(v: string): { date: string; time: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(v);
  if (!m) return { date: v, time: "" };
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return { date: `${DAYS[d.getUTCDay()]}, ${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`, time: m[4] ? `${m[4]}:${m[5]}` : "" };
}

const money = (amount: number, currency: string) =>
  `${currency} ${amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const flightLabel = (s: ETicketSegment) => {
  const no = s.flightNumber && s.airline && !s.flightNumber.toUpperCase().startsWith(s.airline.toUpperCase()) ? `${s.airline} ${s.flightNumber}` : s.flightNumber || s.airline;
  return [s.airlineName, no].filter(Boolean).join("  ·  ");
};

// ── Minimal PDF writer ───────────────────────────────────────────────────────

type Font = "F1" | "F2" | "F3" | "F4";   // Helvetica, Helvetica-Bold, Courier, Courier-Bold
const FONT_NAMES: Record<Font, string> = { F1: "Helvetica", F2: "Helvetica-Bold", F3: "Courier", F4: "Courier-Bold" };

// Standard Helvetica / Helvetica-Bold widths (1/1000 em) for ASCII 32–126.
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELV_B = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

// The standard fonts use WinAnsi (Latin-1): accents are kept, other characters are spelled
// out where possible ("→" → "->") or replaced with "?".
export function pdfText(v: string): string {
  return v.replace(/[→➜➔]/g, "->").replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/₹/g, "INR ")
    .replace(/·/g, "·")
    .normalize("NFC").split("").map((ch) => {
      const c = ch.charCodeAt(0);
      if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255)) return ch;
      const plain = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      return /^[\x20-\x7e]$/.test(plain) ? plain : "?";
    }).join("");
}

export function textWidth(text: string, font: Font, size: number): number {
  const t = pdfText(text);
  if (font === "F3" || font === "F4") return t.length * 0.6 * size;
  const table = font === "F2" ? HELV_B : HELV;
  let w = 0;
  for (const ch of t) { const c = ch.charCodeAt(0); w += c >= 32 && c <= 126 ? table[c - 32] : 556; }
  return (w / 1000) * size;
}

const esc = (t: string) => pdfText(t).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const rgb = (hex: string) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(" ");
const n = (v: number) => (Math.round(v * 100) / 100).toString();

class Page {
  ops: string[] = [];
  text(x: number, y: number, s: string, font: Font, size: number, color = "0.1 0.1 0.1", align: "left" | "right" | "center" = "left") {
    const w = textWidth(s, font, size);
    const x0 = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
    this.ops.push(`BT /${font} ${n(size)} Tf ${color} rg ${n(x0)} ${n(y)} Td (${esc(s)}) Tj ET`);
  }
  rect(x: number, y: number, w: number, h: number, color: string) { this.ops.push(`${color} rg ${n(x)} ${n(y)} ${n(w)} ${n(h)} re f`); }
  line(x1: number, y1: number, x2: number, y2: number, color = "0.9 0.9 0.9", width = 1) { this.ops.push(`${color} RG ${n(width)} w ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S`); }
}

// Fits text to a width by trimming with "...".
function fit(s: string, font: Font, size: number, max: number) {
  if (textWidth(s, font, size) <= max) return s;
  let t = s;
  while (t.length > 1 && textWidth(`${t}...`, font, size) > max) t = t.slice(0, -1);
  return `${t}...`;
}

export function renderETicketPdf(doc: ETicketDocument): Uint8Array {
  const W = 595.28, H = 841.89, L = 48, R = W - 48, color = rgb(doc.primaryColor);
  const GREY = "0.53 0.53 0.53", DARK = "0.1 0.1 0.1", WHITE = "1 1 1";
  const pages: Page[] = [];
  let p!: Page;
  let y = 0;
  const footer = (pg: Page, i: number) => {
    pg.line(L, 58, R, 58);
    const help = doc.supportEmail ? `For support, email ${doc.supportEmail}.  ` : "";
    pg.text(W / 2, 44, `${help}This is your official e-ticket. Present it with your passport / ID at airport check-in.`, "F1", 7.5, GREY, "center");
    pg.text(R, 30, `Page ${i + 1}`, "F1", 7, GREY, "right");
  };
  const newPage = () => {
    p = new Page();
    pages.push(p);
    // Header band: brand on the left, PNR on the right (as in the HTML e-ticket).
    p.rect(0, H - 96, W, 96, color);
    p.text(L, H - 44, fit(doc.brandName, "F2", 18, 300), "F2", 18, WHITE);
    p.text(L, H - 62, "E-Ticket  ·  Booking Confirmation", "F1", 9.5, WHITE);
    p.text(R, H - 34, "AIRLINE PNR", "F1", 7.5, WHITE, "right");
    p.text(R, H - 64, doc.pnr, "F4", 24, WHITE, "right");
    y = H - 124;
  };
  const room = (h: number) => { if (y - h < 76) newPage(); };
  const title = (t: string) => { room(28); p.text(L, y, t.toUpperCase(), "F2", 8, GREY); y -= 16; };

  newPage();

  // Flights
  title(doc.segments.length > 1 ? `Flights (${doc.segments.length})` : "Flight");
  for (const s of doc.segments) {
    room(84);
    const dep = flightTime(s.departureTime), arr = flightTime(s.arrivalTime);
    p.text(L, y, fit(flightLabel(s), "F2", 10, R - L - 120), "F2", 10, DARK);
    if (s.cabinClass) p.text(R, y, s.cabinClass.replace(/_/g, " "), "F1", 8.5, GREY, "right");
    y -= 34;
    p.text(L, y, s.origin, "F2", 30, color);
    p.text(R, y, s.destination, "F2", 30, color, "right");
    const mid = W / 2;
    p.line(mid - 70, y + 11, mid + 62, y + 11, color, 1.2);
    p.ops.push(`${color} rg ${n(mid + 62)} ${n(y + 15)} m ${n(mid + 70)} ${n(y + 11)} l ${n(mid + 62)} ${n(y + 7)} l f`);
    y -= 16;
    p.text(L, y, `${dep.time ? `${dep.time}  ` : ""}${dep.date}`, "F1", 9, DARK);
    if (s.arrivalTime) p.text(R, y, `${arr.time ? `${arr.time}  ` : ""}${arr.date}`, "F1", 9, DARK, "right");
    y -= 12;
    p.text(L, y, "Departure (local time)", "F1", 7.5, GREY);
    if (s.arrivalTime) p.text(R, y, "Arrival (local time)", "F1", 7.5, GREY, "right");
    y -= 14;
    p.line(L, y, R, y);
    y -= 18;
  }

  // Passengers
  title("Passengers");
  const cName = L, cType = L + 270, cTicket = L + 360;
  const head = () => {
    p.text(cName, y, "NAME", "F2", 7.5, GREY); p.text(cType, y, "TYPE", "F2", 7.5, GREY); p.text(cTicket, y, "TICKET NO.", "F2", 7.5, GREY);
    y -= 6; p.line(L, y, R, y, "0.85 0.85 0.85", 1.2); y -= 14;
  };
  head();
  for (const pax of doc.passengers) {
    if (y - 20 < 76) { newPage(); title("Passengers (continued)"); head(); }
    p.text(cName, y, fit(pax.name, "F1", 10, cType - cName - 10), "F1", 10, DARK);
    p.text(cType, y, pax.type.charAt(0) + pax.type.slice(1).toLowerCase(), "F1", 10, DARK);
    p.text(cTicket, y, pax.ticketNumber ?? "Pending", pax.ticketNumber ? "F3" : "F1", 10, pax.ticketNumber ? DARK : GREY);
    y -= 8; p.line(L, y, R, y); y -= 14;
  }
  y -= 6;

  // Flight details
  room(60);
  title("Flight details");
  const col = (R - L) / 3;
  [["Cabin baggage", doc.baggage.cabin], ["Check-in baggage", doc.baggage.checked], ["Refundable", doc.isRefundable ? "Yes" : "Non-refundable"]]
    .forEach(([label, value], i) => {
      p.text(L + col * i, y, label.toUpperCase(), "F1", 7.5, GREY);
      p.text(L + col * i, y - 14, fit(value, "F2", 10.5, col - 12), "F2", 10.5, DARK);
    });
  y -= 30; p.line(L, y, R, y); y -= 22;

  // Booking reference + total
  room(48);
  p.text(L, y, "BOOKING REFERENCE", "F2", 7.5, GREY);
  p.text(R, y, "TOTAL PAID", "F2", 7.5, GREY, "right");
  y -= 18;
  p.text(L, y, doc.bookingRef, "F4", 10, DARK);
  p.text(R, y, money(doc.totalAmount, doc.currency), "F2", 15, color, "right");
  y -= 14;
  const booked = doc.bookedAt ? flightTime(doc.bookedAt).date : "";
  p.text(L, y, `Status: ${doc.status === "TICKETED" ? "Ticketed" : "Confirmed"}${booked ? `  ·  Booked ${booked}` : ""}`, "F1", 8, GREY);

  pages.forEach((pg, i) => footer(pg, i));
  return writePdf(pages, `E-Ticket ${doc.pnr}`, W, H);
}

function writePdf(pages: Page[], title: string, W: number, H: number): Uint8Array {
  const objs: string[] = [];   // objs[i] is object i + 1
  const fontIds: Record<Font, number> = { F1: 3, F2: 4, F3: 5, F4: 6 };
  const firstPage = 8;
  objs[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[1] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${firstPage + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  for (const [f, id] of Object.entries(fontIds)) objs[id - 1] = `<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAMES[f as Font]} /Encoding /WinAnsiEncoding >>`;
  objs[6] = `<< /Title (${esc(title)}) /Producer (ZamraBooking) >>`;
  const resources = `<< /Font << ${Object.entries(fontIds).map(([f, id]) => `/${f} ${id} 0 R`).join(" ")} >> >>`;
  pages.forEach((pg, i) => {
    const content = pg.ops.join("\n");
    objs[firstPage - 1 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(W)} ${n(H)}] /Resources ${resources} /Contents ${firstPage + i * 2 + 1} 0 R >>`;
    objs[firstPage + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  // Every character is one byte (Latin-1), so string lengths are byte offsets.
  let out = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// "e-ticket-88IZ5R.pdf"; several PNRs (one per Akbar leg) become "e-ticket-ABC123-XYZ789.pdf".
export const eticketFileName = (pnr: string) => `e-ticket-${pnr.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "booking"}.pdf`;
