import test from "node:test";
import assert from "node:assert/strict";
import { journeyLegsMatch } from "../src/routes/book.js";

const leg = (origin: string, destination: string, departureTime: string) => ({ origin, destination, departureTime });

test("Akbar round trip legs must go out and come back, in order", () => {
  assert.equal(journeyLegsMatch([leg("BOM", "DEL", "2026-12-01T06:00"), leg("DEL", "BOM", "2026-12-05T06:00")], "ROUNDTRIP"), true);
  assert.equal(journeyLegsMatch([leg("BOM", "DEL", "2026-12-01T06:00"), leg("DEL", "BLR", "2026-12-05T06:00")], "ROUNDTRIP"), false);
  assert.equal(journeyLegsMatch([leg("BOM", "DEL", "2026-12-05T06:00"), leg("DEL", "BOM", "2026-12-01T06:00")], "ROUNDTRIP"), false);
  assert.equal(journeyLegsMatch([leg("BOM", "DEL", "2026-12-01T06:00")], "ROUNDTRIP"), false);
});

test("Akbar multi-city legs must be in travel order", () => {
  const legs = [leg("BOM", "DEL", "2026-12-01T06:00"), leg("DEL", "BLR", "2026-12-04T06:00"), leg("BLR", "BOM", "2026-12-08T06:00")];
  assert.equal(journeyLegsMatch(legs, "MULTICITY"), true);
  assert.equal(journeyLegsMatch([legs[1], legs[0]], "MULTICITY"), false);
});
