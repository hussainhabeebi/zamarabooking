import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, resolveRoute, secretsEqual, upstreamUrl } from "../src/gateway.mjs";

test("loads the Akbar test hosts by default", () => {
  const config = loadConfig({ ZAMRA_GATEWAY_KEY: "internal" });
  assert.equal(config.utilsUpstream.origin, "https://b2bapiutils.benzyinfotech.com");
  assert.equal(config.flightsUpstream.origin, "https://b2bapiflights.benzyinfotech.com");
});

test("rejects a missing key and insecure upstreams", () => {
  assert.throws(() => loadConfig({}), /Missing required/);
  assert.throws(() => loadConfig({ ZAMRA_GATEWAY_KEY: "k", AKBAR_FLIGHTS_UPSTREAM: "http://x.test" }), /must use HTTPS/);
});

test("routes only Akbar's documented calls", () => {
  const config = loadConfig({ ZAMRA_GATEWAY_KEY: "internal" });
  assert.equal(upstreamUrl(config, resolveRoute("/utils/Utils/Signature")), "https://b2bapiutils.benzyinfotech.com/Utils/Signature");
  assert.equal(upstreamUrl(config, resolveRoute("/flights/flights/ExpressSearch")), "https://b2bapiflights.benzyinfotech.com/flights/ExpressSearch");
  assert.equal(upstreamUrl(config, resolveRoute("/flights/Payment/StartPay")), "https://b2bapiflights.benzyinfotech.com/Payment/StartPay");
  assert.equal(resolveRoute("/flights/Utils/Signature"), null);
  assert.equal(resolveRoute("/utils/flights/ExpressSearch"), null);
  assert.equal(resolveRoute("/flights/../admin"), null);
  assert.equal(resolveRoute("/other"), null);
});

test("compares gateway secrets safely", () => {
  assert.equal(secretsEqual("same", "same"), true);
  assert.equal(secretsEqual("nope", "same"), false);
  assert.equal(secretsEqual("", "same"), false);
});
