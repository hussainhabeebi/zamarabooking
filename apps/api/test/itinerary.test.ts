import test from "node:test";
import assert from "node:assert/strict";
import { itineraryFileName, renderItineraryHtml } from "../src/lib/itinerary.js";

test("itinerary HTML shows airport-local times, tickets, and escapes supplier text", () => {
  const html = renderItineraryHtml({
    bookingId: "530cb1ec-f5d0-4c1e", pnr: null, status: "CONFIRMED", bookedAt: "2026-09-24T05:00:00Z",
    origin: "COK", destination: "DXB", totalAmount: 18250, currency: "INR", contactEmail: "a@example.com", contactPhone: null,
    itinerary: {
      pnr: "ABC123",
      segments: [{
        airline: "6E", airlineName: "IndiGo", flightNumber: "6E 1403",
        from: { code: "COK", city: "Kochi", terminal: "T1" }, to: { code: "DXB", city: "Dubai", terminal: "T1" },
        departure: "2026-10-02T06:15", arrival: "2026-10-02T09:05", durationMin: 260,
      }],
      travellers: [{ name: "Mr Ali <Khan>", type: "ADULT", pnr: "ABC123", ticketNumber: "3120000001" }],
    },
  });
  assert.match(html, /06:15/);
  assert.match(html, /Fri, 2 Oct 2026/);
  assert.match(html, /3120000001/);
  assert.match(html, /ABC123/);
  assert.match(html, /Mr Ali &lt;Khan&gt;/);
  assert.equal(itineraryFileName({ pnr: "ABC123", bookingId: "530cb1ec" }), "itinerary-ABC123.html");
  assert.equal(itineraryFileName({ pnr: null, bookingId: "530cb1ec-f5d0" }), "itinerary-530cb1ec.html");
});
