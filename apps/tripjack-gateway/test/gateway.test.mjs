import test from "node:test";
import assert from "node:assert/strict";
import { ROUTES, loadConfig, resolveRoute, secretsEqual, upstreamFor, upstreamUrl } from "../src/gateway.mjs";

test("loads a secure UAT configuration", () => {
  const config = loadConfig({ POOMAS_GATEWAY_KEY: "internal" });
  assert.equal(config.upstream.origin, "https://apitest.tripjack.com");
  assert.equal(config.port, 3000);
  assert.equal(config.tripjackApiKey, "");
});

test("rejects missing secrets and insecure upstreams", () => {
  assert.throws(() => loadConfig({}), /Missing required/);
  assert.throws(() => loadConfig({
    POOMAS_GATEWAY_KEY: "internal",
    TRIPJACK_UPSTREAM: "http://apitest.tripjack.com",
  }), /must use HTTPS/);
});

test("compares gateway secrets without accepting length mismatches", () => {
  assert.equal(secretsEqual("same-secret", "same-secret"), true);
  assert.equal(secretsEqual("wrong", "same-secret"), false);
  assert.equal(secretsEqual("", "same-secret"), false);
});

test("constructs the TripJack URL without duplicating paths", () => {
  assert.equal(
    upstreamUrl(new URL("https://apitest.tripjack.com"), "/fms/v1/air-search-all"),
    "https://apitest.tripjack.com/fms/v1/air-search-all",
  );
});

test("routes fare review through the TripJack gateway", () => {
  assert.equal(ROUTES.get("/fms/v1/review"), "/fms/v1/review");
});


test("routes TripJack hotel v3 calls to the hotel hosts without changing flight routes", () => {
  const config = loadConfig({ POOMAS_GATEWAY_KEY: "internal" });
  assert.equal(config.hmsUpstream.origin, "https://apitest-hms.tripjack.com");
  assert.equal(config.hotelBookerUpstream.origin, "https://apitest-hotel-booker.tripjack.com");

  assert.deepEqual(resolveRoute("/fms/v1/review"), { upstreamPath: "/fms/v1/review", upstream: "main", method: "POST" });
  assert.deepEqual(resolveRoute("/hms/v3/hotel/listing"), { upstreamPath: "/hms/v3/hotel/listing", upstream: "hms", method: "POST" });
  assert.deepEqual(resolveRoute("/hms/v3/content/fetch-city-regionIds"), { upstreamPath: "/hms/v3/content/fetch-city-regionIds", upstream: "hms", method: "GET" });
  assert.deepEqual(resolveRoute("/oms/v3/hotel/book"), { upstreamPath: "/oms/v3/hotel/book", upstream: "booker", method: "POST" });
  assert.deepEqual(resolveRoute("/oms/v3/hotel/cancel-booking/TJS20990000003651"),
    { upstreamPath: "/oms/v3/hotel/cancel-booking/TJS20990000003651", upstream: "booker", method: "POST" });
  assert.equal(resolveRoute("/oms/v3/hotel/cancel-booking/"), null);
  assert.equal(resolveRoute("/oms/v3/hotel/cancel-booking/../x"), null);
  assert.deepEqual(resolveRoute("/tj-main/hms/v3/nationality-info"), { upstreamPath: "/hms/v3/nationality-info", upstream: "main", method: "GET" });
  assert.equal(resolveRoute("/hms/v3/unknown"), null);

  assert.equal(upstreamFor(config, "booker").hostname, "apitest-hotel-booker.tripjack.com");
  assert.equal(
    upstreamUrl(config.hmsUpstream, "/hms/v3/content/fetch-city-regionIds", "?limit=2000&cursor=MTAw"),
    "https://apitest-hms.tripjack.com/hms/v3/content/fetch-city-regionIds?limit=2000&cursor=MTAw",
  );
  assert.equal(ROUTES.get("/oms/v1/air/book"), "/oms/v1/air/book");
});

test("rejects insecure hotel upstreams", () => {
  assert.throws(() => loadConfig({ POOMAS_GATEWAY_KEY: "k", TRIPJACK_HMS_UPSTREAM: "http://apitest-hms.tripjack.com" }), /must use HTTPS/);
});

test("routes Flights v2 seat map, fare validation and hold endpoints", () => {
  for (const path of ["/fms/v1/seat", "/oms/v1/air/book/fare-validate", "/oms/v1/air/fare-validate", "/oms/v1/air/confirm-book", "/oms/v1/air/unhold"]) {
    assert.deepEqual(resolveRoute(path), { upstreamPath: path, upstream: "main", method: "POST" });
  }
  assert.deepEqual(resolveRoute("/ums/v1/user-detail"), { upstreamPath: "/ums/v1/user-detail", upstream: "main", method: "GET" });
});

test("routes TripSafe insurance v2 endpoints to the main host", () => {
  for (const path of ["/insurance/v2/search", "/insurance/v2/booking", "/insurance/v2/amendment/raise", "/insurance/v2/amendment/confirm"]) {
    assert.deepEqual(resolveRoute(path), { upstreamPath: path, upstream: "main", method: "POST" });
  }
  assert.deepEqual(resolveRoute("/insurance/v2/booking/TJS70360001517547"),
    { upstreamPath: "/insurance/v2/booking/TJS70360001517547", upstream: "main", method: "GET" });
  assert.equal(resolveRoute("/insurance/v2/booking/TJS1/../x"), null);
  assert.equal(resolveRoute("/insurance/v2/search/"), null);
});
