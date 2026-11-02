import test from "node:test";
import assert from "node:assert/strict";
import { eticketDocument, eticketFileName, flightTime, pdfText, renderETicketPdf, bytesToBase64 } from "../src/lib/eticket-pdf.js";

const pax = [
  { firstName: "Anand", lastName: "Kumar", passengerType: "ADULT" },
  { firstName: "Zoë", lastName: "Kumar", passengerType: "CHILD" },
];
const tenant = { name: "Zamra Travels", primaryColor: "#0D4B96", supportEmail: "help@zamrabooking.com" };
const akbar = (over: Record<string, unknown> = {}) => ({
  id: "bk-0001", status: "TICKETED", supplier: "AKBAR", pnr: "88IZ5R", ticketNumbers: ["0987345536870"],
  origin: "BOM", destination: "DEL", departureDate: new Date("2026-12-15T00:00:00Z"), cabinClass: "ECONOMY",
  totalAmount: "10450.50", currency: "INR", createdAt: new Date("2026-11-02T09:00:00Z"),
  flightData: {
    airline: "6E", airlineName: "IndiGo", flightNumber: "2101", departureTime: "2026-12-15T06:00:00", arrivalTime: "2026-12-15T08:10:00",
    cabinClass: "ECONOMY", isRefundable: false, baggage: { cabin: "7 Kg", checked: "15 Kg" },
    offline: { supplier: "AKBAR", ticketing: "ISSUED" },
  },
  ...over,
}) as any;

const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

test("the PDF carries the booking's PNR, travellers, flight and only the issued ticket numbers", () => {
  const doc = eticketDocument(akbar(), pax, tenant)!;
  assert.deepEqual(doc.passengers, [
    { name: "Anand Kumar", type: "ADULT", ticketNumber: "0987345536870" },
    { name: "Zoë Kumar", type: "CHILD", ticketNumber: null },          // not issued → no number invented
  ]);
  const pdf = latin1(renderETicketPdf(doc));
  assert.ok(pdf.startsWith("%PDF-1.4"));
  assert.ok(pdf.trimEnd().endsWith("%%EOF"));
  for (const s of ["(88IZ5R)", "(Anand Kumar)", "(Zoë Kumar)", "(0987345536870)", "(Pending)", "(BOM)", "(DEL)",
    "(IndiGo  ·  6E 2101)", "(06:00  Tue, 15 Dec 2026)", "(08:10  Tue, 15 Dec 2026)", "(7 Kg)", "(15 Kg)", "(Non-refundable)",
    "(INR 10,450.50)", "(bk-0001)", "(Zamra Travels)"]) {
    assert.ok(pdf.includes(s), `missing ${s}`);
  }
});

test("the PDF structure is valid: xref offsets point at each object, stream lengths are exact", () => {
  const bytes = renderETicketPdf(eticketDocument(akbar(), pax, tenant)!);
  const pdf = latin1(bytes);
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(pdf)![1]);
  assert.equal(pdf.slice(startxref, startxref + 4), "xref");
  const [, count] = /xref\n0 (\d+)\n/.exec(pdf.slice(startxref))!;
  const entries = pdf.slice(startxref).split("\n").slice(3, 2 + Number(count));
  entries.forEach((e, i) => assert.equal(pdf.slice(Number(e.slice(0, 10)), Number(e.slice(0, 10)) + String(i + 1).length + 6), `${i + 1} 0 obj`));
  for (const m of pdf.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index! + m[0].length;
    assert.equal(pdf.slice(start + Number(m[1]), start + Number(m[1]) + 10), "\nendstream");
  }
  assert.equal(Buffer.from(bytesToBase64(bytes), "base64").length, bytes.length);
});

test("no e-ticket without a confirmed booking and an airline PNR", () => {
  assert.equal(eticketDocument(akbar({ pnr: null }), pax, tenant), null);
  assert.equal(eticketDocument(akbar({ pnr: "  " }), pax, tenant), null);
  assert.equal(eticketDocument(akbar({ status: "PAYMENT_PENDING" }), pax, tenant), null);
  assert.equal(eticketDocument(akbar({ status: "CANCELLED" }), pax, tenant), null);
  // Staff / Akbar-API ticketed fares: only once TICKETED.
  assert.equal(eticketDocument(akbar({ status: "CONFIRMED" }), pax, tenant), null);
  assert.equal(eticketDocument(akbar(), [], tenant), null);
  // TripJack: a confirmed booking with its PNR is enough (ticket numbers may still be pending).
  assert.ok(eticketDocument(akbar({ supplier: "TRIPJACK", status: "CONFIRMED", flightData: { tripjack: { segments: [
    { airline: "AI", airlineName: "Air India", flightNumber: "865", origin: "BOM", destination: "DEL", departureTime: "2026-12-15T06:00", arrivalTime: "2026-12-15T08:10" },
  ] } } }), pax, tenant));
});

test("flights come from the booking: TripJack segments, Akbar journey legs, or the single fare", () => {
  const tj = eticketDocument(akbar({ supplier: "TRIPJACK", flightData: { tripjack: { segments: [
    { airline: "AI", airlineName: "Air India", flightNumber: "865", origin: "BOM", destination: "DXB", departureTime: "2026-12-15T06:00", arrivalTime: "2026-12-15T08:10" },
    { airline: "AI", airlineName: "Air India", flightNumber: "866", origin: "DXB", destination: "BOM", departureTime: "2026-12-20T10:00", arrivalTime: "2026-12-20T14:30", isReturn: true },
  ] } } }), pax, tenant)!;
  assert.deepEqual(tj.segments.map((s) => `${s.origin}-${s.destination} ${s.flightNumber}`), ["BOM-DXB 865", "DXB-BOM 866"]);
  const legs = eticketDocument(akbar({ pnr: "ABC123/XYZ789", flightData: { offline: { legs: [
    { airline: "6E", airlineName: "IndiGo", flightNumber: "2101", origin: "BOM", destination: "DEL", departureTime: "2026-12-15T06:00:00", arrivalTime: "2026-12-15T08:10:00", baggage: { cabin: "7 Kg", checked: "15 Kg" } },
    { airline: "6E", airlineName: "IndiGo", flightNumber: "2102", origin: "DEL", destination: "BOM", departureTime: "2026-12-20T19:00:00", arrivalTime: "2026-12-20T21:10:00" },
  ] } } }), pax, tenant)!;
  assert.equal(legs.segments.length, 2);
  assert.deepEqual(legs.baggage, { cabin: "7 Kg", checked: "15 Kg" });
  assert.equal(eticketFileName(legs.pnr), "e-ticket-ABC123-XYZ789.pdf");
  assert.equal(eticketFileName("88iz5r"), "e-ticket-88IZ5R.pdf");
  // Many travellers / legs still render (continues on a new page).
  const many = Array.from({ length: 18 }, (_, i) => ({ firstName: `Traveller${i}`, lastName: "Test", passengerType: "ADULT" }));
  const big = latin1(renderETicketPdf({ ...legs, passengers: eticketDocument(akbar(), many, tenant)!.passengers }));
  assert.ok(/\/Count [2-9]/.test(big));
});

test("airline times are shown as local times, and text is safe for the PDF fonts", () => {
  assert.deepEqual(flightTime("2026-12-15T06:00:00"), { date: "Tue, 15 Dec 2026", time: "06:00" });
  assert.deepEqual(flightTime("2026-12-15T23:45:00Z"), { date: "Tue, 15 Dec 2026", time: "23:45" });   // never shifted
  assert.equal(pdfText("BOM → DEL ₹100 Zoë 你好"), "BOM -> DEL INR 100 Zoë ??");
  const pdf = latin1(renderETicketPdf({ ...eticketDocument(akbar(), pax, tenant)!, brandName: "Zamra (Travels) \\ Co" }));
  assert.ok(pdf.includes("(Zamra \\(Travels\\) \\\\ Co)"));
});
