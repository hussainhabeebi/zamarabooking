import test from "node:test";
import assert from "node:assert/strict";
import { AkbarClient, akbarTransactionId, parseAkbarItineraryStatus, akbarAncillaryFeatures, webSettingsBody } from "@zamrabooking/suppliers";

test("verified WebSettings body and utility host use the existing genuine exchange recorder", async () => {
  const recorded: any[] = [];
  const client = new AkbarClient({ utilsUrl: "https://utils.example.test", recorder: (x) => recorded.push(x) } as any,
    async (url, init) => {
      assert.equal(url, "https://utils.example.test/Utils/WebSettings");
      assert.deepEqual(JSON.parse(String(init?.body)), { ClientID: "fixture", TUI: "pricing-context" });
      return Response.json({ Code: "200", Settings: [] });
    });
  assert.deepEqual(webSettingsBody("fixture"), { ClientID: "fixture", TUI: "" });
  await client.webSettings({ token: "fixture-token", clientId: "fixture" }, "pricing-context");
  assert.equal(recorded.length, 1); assert.equal(recorded[0].endpoint, "/Utils/WebSettings");
  assert.doesNotMatch(recorded[0].requestHeaders.Authorization, /fixture-token/);
});
test("SSR and SeatLayout capabilities are independent and region-specific", () => {
  const settings = { Code: "200", Settings: [{ Key: "ShowSSRDom", Value: "6E,SG" }, { Key: "ShowSeatLayoutInt", Value: ",6E,SG," }] };
  assert.deepEqual(akbarAncillaryFeatures(settings, "6E", "DOMESTIC"), { ssr: true, seatLayout: false });
  assert.deepEqual(akbarAncillaryFeatures(settings, "6E", "INTERNATIONAL"), { ssr: false, seatLayout: true });
  assert.deepEqual(akbarAncillaryFeatures(settings, "AI", "INTERNATIONAL"), { ssr: false, seatLayout: false });
});
test("conflicting duplicate/missing feature configuration never enables an ancillary", () => {
  assert.deepEqual(akbarAncillaryFeatures({ Code: "200", Settings: [{ Key: "ShowSSRDom", Value: "6E" }, { Key: "ShowSSRDom", Value: "SG" }] }, "6E", "DOMESTIC"), { ssr: false, seatLayout: false });
  assert.throws(() => akbarAncillaryFeatures({ Code: "403", Settings: [] }, "6E", "DOMESTIC"));
  assert.throws(() => akbarAncillaryFeatures({}, "6E", "DOMESTIC"));
});


test("documented status parsing binds the actual transaction without treating HTTP success as confirmation", () => {
  const id = "12345678901234567890";
  const out = parseAkbarItineraryStatus({ Code: "200", transactionID: id, CurrentStatus: "Success" }, id);
  assert.equal(out.transactionId, id); assert.equal(out.status, "Success");
  assert.throws(() => akbarTransactionId(Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => parseAkbarItineraryStatus({ Code: "200", transactionID: "2", CurrentStatus: "Success" }, "1"));
  assert.throws(() => parseAkbarItineraryStatus({ Code: "403", transactionID: "1", CurrentStatus: "Success" }, "1"));
  assert.equal(parseAkbarItineraryStatus({ Code: "200", transactionID: "1", CurrentStatus: "" }, "1").status, "");
});
