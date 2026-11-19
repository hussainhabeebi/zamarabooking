// Included baggage from Akbar: the combined "check-in,cabin" text read into two allowances, using the
// real texts Akbar sent (fixtures/akbar-baggage-samples.json). No live calls.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  akbarBaggage, allowanceLabel, baggageView, normalizeAllowance, normalizeAkbarJourney, splitAkbarBaggage, BAGGAGE_UNKNOWN_TEXT,
} from "@zamrabooking/suppliers";
import { eticketDocument, renderETicketPdf } from "../src/lib/eticket-pdf.js";
import { renderETicketHtml } from "../src/lib/eticket.js";

const samples = JSON.parse(readFileSync(new URL("./fixtures/akbar-baggage-samples.json", import.meta.url), "utf8"));

test("every real Akbar baggage text → separate check-in and cabin allowances", () => {
  for (const s of samples.search) {
    assert.deepEqual(akbarBaggage(s.baggage), { checked: s.checked, cabin: s.cabin, checkedStatus: s.checkedStatus, cabinStatus: s.cabinStatus },
      `${s.airline} ${s.fare}: ${JSON.stringify(s.baggage)}`);
  }
});

test("Akbar's SSR free-bag text uses the same order (check-in, cabin)", () => {
  for (const s of samples.ssrFreeBag) {
    const b = akbarBaggage(s.description);
    assert.equal(b.checked, s.checked, s.ptc);
    assert.equal(b.cabin, s.cabin, s.ptc);
  }
});

test("N, 0 Kg and 0Kg are no check-in bag — never an allowance", () => {
  for (const raw of ["N", "n", "0 Kg", "0Kg", "0 KG", "0", "Nil", "Not included", "No check-in bag"]) {
    assert.deepEqual(normalizeAllowance(raw, "checked"), { text: "No check-in bag", status: "NONE" }, raw);
  }
  // A number with a 0 in it is still an allowance.
  assert.deepEqual(normalizeAllowance("30", "checked"), { text: "30 kg", status: "INCLUDED" });
  assert.deepEqual(normalizeAllowance("20 Kg", "checked"), { text: "20 kg", status: "INCLUDED" });
});

test("missing or 'ask the airline' text is unknown, shown as 'Allowance not confirmed' (never 'As per airline')", () => {
  for (const raw of [null, undefined, "", "  ", "As per airline", "as per airline rules", "N/A"]) {
    const a = normalizeAllowance(raw, "checked");
    assert.deepEqual(a, { text: "", status: "UNKNOWN" }, String(raw));
    assert.equal(allowanceLabel(a), BAGGAGE_UNKNOWN_TEXT);
  }
  assert.equal(BAGGAGE_UNKNOWN_TEXT, "Allowance not confirmed");
});

test("restrictions are kept: personal item, piece weight limits; unreadable text is kept word for word", () => {
  assert.equal(normalizeAllowance("7 kg + Personal item(max 3 kg)", "cabin").text, "7 kg + Personal item (max 3 kg)");
  assert.equal(normalizeAllowance("2 Pc | UP TO 70 POUNDS/32 KILOGRAMS", "checked").text, "2 pieces, up to 32 kg each");
  const odd = normalizeAllowance("Subject to fare rules", "checked");
  assert.deepEqual(odd, { text: "Subject to fare rules", status: "UNKNOWN" });   // kept, but never counted as a bag
});

test("reading is stable: a cleaned allowance reads back the same (links, saved bookings)", () => {
  for (const s of samples.search) {
    for (const [kind, text] of [["checked", s.checked], ["cabin", s.cabin]] as const) {
      const again = normalizeAllowance(text, kind);
      assert.equal(again.text, text, `${kind} ${text}`);
      assert.equal(again.status, kind === "checked" ? s.checkedStatus : s.cabinStatus, `${kind} ${text}`);
    }
  }
});

test("split only at the first comma outside brackets", () => {
  assert.deepEqual(splitAkbarBaggage("2 Pc | UP TO 70 POUNDS/32 KILOGRAMS,1 Pc |UP TO 26 POUNDS/12 KILOGRAMS"),
    { checked: "2 Pc | UP TO 70 POUNDS/32 KILOGRAMS", cabin: "1 Pc |UP TO 26 POUNDS/12 KILOGRAMS" });
  assert.deepEqual(splitAkbarBaggage("N,7 kg + Personal item(max 3, kg)"), { checked: "N", cabin: "7 kg + Personal item(max 3, kg)" });
  assert.deepEqual(splitAkbarBaggage("30Kg"), { checked: "30Kg", cabin: "" });
});

test("an Akbar journey's fare carries the split baggage; price fields are untouched", () => {
  const journey = {
    Index: "1", From: "COK", To: "DXB", DepartureTime: "2026-12-20T10:00:00", ArrivalTime: "2026-12-20T12:45:00", VAC: "AI",
    AirlineName: "Air India", FlightNo: "933", NetFare: 15234.5, GrossFare: 15900, Stops: 0, Connections: [],
    Inclusions: { Baggage: "25 Kg,7 Kg", Meals: null, PieceDescription: null },
  };
  const fare = normalizeAkbarJourney(journey, "tui-1", "ECONOMY")!;
  assert.deepEqual(fare.baggage, { checked: "25 kg", cabin: "7 kg", checkedStatus: "INCLUDED", cabinStatus: "INCLUDED" });
  assert.equal(fare.totalFare, 15234.5);
  assert.equal(fare.baseFare, 15234.5);
  const noBag = normalizeAkbarJourney({ ...journey, VAC: "G9", Inclusions: { Baggage: "N,7 kg + Personal item(max 3 kg)" } }, "tui-1", "ECONOMY")!;
  assert.equal(noBag.baggage.checkedStatus, "NONE");
  const indigo = normalizeAkbarJourney({ ...journey, VAC: "6E", Inclusions: { Baggage: null } }, "tui-1", "ECONOMY")!;
  assert.deepEqual(indigo.baggage, { checked: "", cabin: "", checkedStatus: "UNKNOWN", cabinStatus: "UNKNOWN" });
});

test("bookings saved before the split (Akbar '25 Kg,7 Kg' in check-in, cabin 'As per airline') show correctly", () => {
  const old = { checked: "25 Kg,7 Kg", cabin: "As per airline" };
  const v = baggageView(old, { akbar: true });
  assert.deepEqual([v.checked.text, v.cabin.text], ["25 kg", "7 kg"]);
  // Other suppliers' text is never split the Akbar way.
  assert.equal(baggageView({ checked: "15 Kg, 1 piece" }, {}).checked.text, "15 kg, 1 piece");   // tidied, not split
});

const pax = [{ firstName: "Anand", lastName: "Kumar", passengerType: "ADULT" }];
const booking = (baggage: unknown) => ({
  id: "bk-0002", status: "TICKETED", supplier: "AKBAR", pnr: "88IZ5R", ticketNumbers: ["0987345536870"],
  origin: "COK", destination: "DXB", departureDate: new Date("2026-12-20T00:00:00Z"), cabinClass: "ECONOMY",
  totalAmount: "15900", currency: "INR", createdAt: new Date("2026-11-02T09:00:00Z"),
  flightData: { airline: "AI", airlineName: "Air India", flightNumber: "933", departureTime: "2026-12-20T10:00:00", arrivalTime: "2026-12-20T12:45:00", baggage },
}) as any;

test("e-ticket PDF: split allowances, no check-in bag, and unknown — same words as the website", () => {
  assert.deepEqual(eticketDocument(booking({ checked: "25 Kg,7 Kg", cabin: "As per airline" }), pax, null)!.baggage, { checked: "25 kg", cabin: "7 kg" });
  assert.deepEqual(eticketDocument(booking(akbarBaggage("N,7 kg + Personal item(max 3 kg)")), pax, null)!.baggage,
    { checked: "No check-in bag", cabin: "7 kg + Personal item (max 3 kg)" });
  const unknown = eticketDocument(booking(akbarBaggage(null)), pax, null)!;
  assert.deepEqual(unknown.baggage, { checked: "Allowance not confirmed", cabin: "Allowance not confirmed" });
  const pdf = Array.from(renderETicketPdf(unknown), (c) => String.fromCharCode(c)).join("");
  assert.ok(pdf.includes("(Allowance not confirmed)"));
  assert.ok(!pdf.includes("As per airline"));
});

test("e-ticket email (HTML): split allowances; supplier text is escaped", () => {
  const base = {
    bookingRef: "bk-0002", pnr: "88IZ5R", ticketNumbers: [], airline: "AI", airlineName: "Air India", flightNumber: "933",
    origin: "COK", destination: "DXB", departureTime: "2026-12-20T10:00:00", arrivalTime: "2026-12-20T12:45:00", cabinClass: "ECONOMY",
    passengers: [], totalAmount: 15900, currency: "INR", isRefundable: false, brandName: "Zamra Travels", primaryColor: "#0D4B96",
  };
  const html = renderETicketHtml({ ...base, baggage: { checked: "25 Kg,7 Kg", cabin: "As per airline" }, supplier: "AKBAR" });
  assert.match(html, /Cabin Baggage<\/div>\s*<div class="value">7 kg<\/div>/);
  assert.match(html, /Check-in Baggage<\/div>\s*<div class="value">25 kg<\/div>/);
  const none = renderETicketHtml({ ...base, baggage: { checked: "", cabin: "" } });
  assert.ok(none.includes("Allowance not confirmed") && !none.includes("As per airline"));
  const odd = renderETicketHtml({ ...base, baggage: { checked: "<b>x</b> 20 kg", cabin: "" } });
  assert.ok(odd.includes("&lt;b&gt;x&lt;/b&gt; 20 kg"));
});
