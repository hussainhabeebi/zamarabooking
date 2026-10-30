import test from "node:test";
import assert from "node:assert/strict";
import { journeyOutcome } from "../src/routes/search.js";

const ok = (fareCount: number) => ({ ok: true, fareCount, durationMs: 10 });

test("one-way searches are not journey-logged", () => {
  assert.equal(journeyOutcome({ tripType: "ONEWAY" }, [], {}), null);
});

test("round trip with TripJack switched off is logged as an error", () => {
  const r = journeyOutcome({ tripType: "ROUNDTRIP", returnDate: "2026-12-10" }, [{ supplier: "AKBAR" }], { AKBAR: ok(1) })!;
  assert.equal(r.level, "ERROR");
  assert.equal(r.errorCode, "JOURNEY_NO_BOOKABLE_FARES");
  assert.match(r.errorMessage, /TripJack was not searched/);
  assert.deepEqual(r.summary.faresBySupplier, { AKBAR: 1 });
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
