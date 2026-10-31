import test from "node:test";
import assert from "node:assert/strict";
import { bookingStopLabel, searchStopLabel, normalizedStopCount, resultStopLabel } from "../src/lib/log-stop-labels.js";
import { caseName } from "../src/lib/certification.js";

test("search archives label the selected filter, absent filter means all stops", () => {
  assert.deepEqual(["0", "1", "2", undefined].map(searchStopLabel), ["DIRECT", "1-STOP", "2PLUS-STOPS", "ALL-STOPS"]);
  assert.throws(() => searchStopLabel("invalid"));
});
test("individual results use actual normalized stops and never default missing data to direct", () => {
  assert.equal(resultStopLabel(normalizedStopCount({ stops: 0, stopDetails: [{airport: "BLR"}] })), "1-STOP");
  assert.equal(resultStopLabel(normalizedStopCount({ stops: 3 })), "3-STOPS");
  assert.equal(resultStopLabel(normalizedStopCount({})), "UNKNOWN-STOPS");
  assert.equal(resultStopLabel(normalizedStopCount({ stops: 0, stopsUnknown: true })), "UNKNOWN-STOPS");
  assert.equal(normalizedStopCount({ stops: -1 }), null);
});
const booking = (flightData: any, tripType = "ONEWAY"): any => ({ origin: "TRV", destination: "BOM", adultCount: 2, childCount: 2, infantCount: 2, tripType, flightData });
test("Akbar certification ZIP reads offline fare, not missing top-level stops or the UI filter", () => {
  assert.equal(caseName(booking({ stops: 0, stopsFilter: "0", offline: { fare: { stops: 1, stopDetails: [{airport: "BLR"}] } } })), "TRV-BOM-2A-2C-2I-CONNECTING");
  assert.equal(caseName(booking({ offline: { fare: { stops: 0 } } })), "TRV-BOM-2A-2C-2I-DIRECT");
  assert.equal(caseName(booking({})), "TRV-BOM-2A-2C-2I-UNKNOWN-STOPS");
});
test("journey exports use every saved leg and preserve multicity route", () => {
  const legs = [{ origin: "TRV", destination: "BOM", stops: 1 }, { origin: "BOM", destination: "DEL", stops: 1 }];
  assert.equal(caseName(booking({ offline: { legs } }, "MULTICITY")), "TRV-BOM-DEL-2A-2C-2I-CONNECTING");
  // Any connecting leg makes the journey CONNECTING, never DIRECT.
  assert.match(caseName(booking({ offline: { legs: [legs[0], {...legs[1], stops: 0}] } }, "ROUNDTRIP")), /-CONNECTING$/);
});

test("booking export labels: DIRECT only when every leg is verified non-stop", () => {
  assert.equal(bookingStopLabel([0]), "DIRECT");
  assert.equal(bookingStopLabel([0, 0]), "DIRECT");
  assert.equal(bookingStopLabel([1]), "CONNECTING");
  assert.equal(bookingStopLabel([0, 2]), "CONNECTING");
  assert.equal(bookingStopLabel([null, 1]), "CONNECTING");          // a verified connection wins
  assert.equal(bookingStopLabel([0, null]), "UNKNOWN-STOPS");       // never default the unknown leg to direct
  assert.equal(bookingStopLabel([]), "UNKNOWN-STOPS");
});
test("saved Akbar booking data from production: connection evidence in offline.fare or offline.legs", () => {
  // Shape bookOfflineFare saves: offline.fare = normalized Akbar fare without raw.
  const akbarFare = { supplier: "AKBAR", origin: "TRV", destination: "BOM", stops: 1, stopDetails: [{ airport: "COK", arrivalTime: "", departureTime: "", layoverMinutes: 95 }], flightNumber: "5382" };
  assert.equal(caseName(booking({ id: "AK|t|1", airline: "6E", offline: { supplier: "AKBAR", fare: akbarFare } })), "TRV-BOM-2A-2C-2I-CONNECTING");
  // Old Akbar normalizer: Stops 0 but a listed connection → still CONNECTING.
  assert.equal(caseName(booking({ offline: { fare: { ...akbarFare, stops: 0 } } })), "TRV-BOM-2A-2C-2I-CONNECTING");
  // Akbar gave no stop evidence at all → UNKNOWN-STOPS, not DIRECT.
  assert.equal(caseName(booking({ offline: { fare: { ...akbarFare, stops: 0, stopDetails: [], stopsUnknown: true } } })), "TRV-BOM-2A-2C-2I-UNKNOWN-STOPS");
  const legs = [{ origin: "TRV", destination: "BOM", stops: 0, stopDetails: [] }, { origin: "BOM", destination: "TRV", stops: 1, stopDetails: [{ airport: "COK" }] }];
  assert.equal(caseName(booking({ offline: { fare: legs[0], legs } }, "ROUNDTRIP")), "TRV-BOM-TRV-2A-2C-2I-CONNECTING");
});
