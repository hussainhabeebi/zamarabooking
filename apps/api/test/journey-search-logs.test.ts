import test from "node:test";
import assert from "node:assert/strict";
import { journeyOutcome } from "../src/routes/search.js";

const ok = (fareCount: number) => ({ ok: true, fareCount, durationMs: 10 });

test("one-way searches are not journey-logged", () => {
  assert.equal(journeyOutcome({ tripType: "ONEWAY" }, [], {}), null);
});

test("round trip with no journey source searched is logged as an error", () => {
  const r = journeyOutcome({ tripType: "ROUNDTRIP", returnDate: "2026-12-10" }, [{ supplier: "POOMAS" }], { POOMAS: ok(1) })!;
  assert.equal(r.level, "ERROR");
  assert.equal(r.errorCode, "JOURNEY_NO_BOOKABLE_FARES");
  assert.match(r.errorMessage, /Neither Akbar nor TripJack was searched/);
  assert.deepEqual(r.summary.faresBySupplier, { POOMAS: 1 });
});

test("Akbar journey fares count as bookable; Akbar failures are logged against Akbar", () => {
  const params = { tripType: "ROUNDTRIP", returnDate: "2026-12-10" };
  assert.equal(journeyOutcome(params, [{ supplier: "AKBAR", tripKey: "ONWARD" }, { supplier: "AKBAR", tripKey: "RETURN" }], { AKBAR: ok(2) }), null);
  const failed = journeyOutcome(params, [], { AKBAR: { ok: false, fareCount: 0, durationMs: 5, errorMessage: "Akbar /flights/ExpressSearch failed (HTTP 500)" } })!;
  assert.equal(failed.supplier, "AKBAR");
  assert.match(failed.errorMessage, /Akbar failed: Akbar \/flights\/ExpressSearch failed \(HTTP 500\)/);
  // A leg from each source is not a bookable journey.
  const mixed = journeyOutcome(params, [{ supplier: "AKBAR", tripKey: "ONWARD" }, { supplier: "TRIPJACK", tripKey: "RETURN" }], { AKBAR: ok(1), TRIPJACK: ok(1) })!;
  assert.equal(mixed.errorCode, "JOURNEY_LEG_MISSING");
});

test("TripJack failure reason is carried into the journey log", () => {
  const r = journeyOutcome({ tripType: "MULTICITY", legs: [{}, {}] }, [], {
    TRIPJACK: { ok: false, fareCount: 0, durationMs: 5, errorCode: "SEARCH_REJECTED", errorMessage: "Invalid route" },
  })!;
  assert.match(r.errorMessage, /TripJack failed: Invalid route/);
});

test("a missing return leg is flagged; complete journeys are not", () => {
  const params = { tripType: "ROUNDTRIP", returnDate: "2026-12-10" };
  const onwardOnly = journeyOutcome(params, [{ supplier: "TRIPJACK", tripKey: "ONWARD" }], { TRIPJACK: ok(1) })!;
  assert.equal(onwardOnly.errorCode, "JOURNEY_LEG_MISSING");
  assert.deepEqual(onwardOnly.summary.missingLegs, ["RETURN"]);
  assert.equal(journeyOutcome(params, [{ supplier: "TRIPJACK", tripKey: "ONWARD" }, { supplier: "TRIPJACK", tripKey: "RETURN" }], { TRIPJACK: ok(2) }), null);
  assert.equal(journeyOutcome(params, [{ supplier: "TRIPJACK", tripKey: "COMBO" }], { TRIPJACK: ok(1) }), null);
});

test("domestic multi-city expects one indexed list per leg", () => {
  const r = journeyOutcome({ tripType: "MULTICITY", legs: [{}, {}, {}] }, [{ supplier: "TRIPJACK", tripKey: "0" }, { supplier: "TRIPJACK", tripKey: "1" }], { TRIPJACK: ok(2) })!;
  assert.deepEqual(r.summary.missingLegs, ["2"]);
});
