import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { buildScanResult, checkDigit, parseTd3 } from "../src/lib/document-scan.js";
import { aiRoutes } from "../src/routes/ai.js";

// ICAO 9303 specimen passport.
const L1 = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<";
const L2 = "L898902C36UTO7408122F1204159ZE184226B<<<<<10";

test("MRZ check digits and TD3 parsing (ICAO specimen)", () => {
  assert.equal(checkDigit("L898902C3"), 6);
  assert.equal(checkDigit("740812"), 2);
  const m = parseTd3(L1, L2)!;
  assert.equal(m.valid, true);
  assert.equal(m.surname, "ERIKSSON");
  assert.equal(m.givenNames, "ANNA MARIA");
  assert.equal(m.documentNumber, "L898902C3");
  assert.equal(m.dob, "1974-08-12");
  assert.equal(m.expiryDate, "2012-04-15");
  assert.equal(m.gender, "F");
  assert.equal(parseTd3(L1, L2.replace("L898902C3", "L898902C4"))!.valid, false);   // one wrong digit fails
});

test("a verified MRZ overrides what the model read; warnings for expiry and one-name documents", () => {
  const r = buildScanResult({ documentType: "PASSPORT", surname: "ERIKSON", givenNames: "ANA MARIA", documentNumber: "L898902C8",
    dateOfBirth: "1974-08-21", gender: "F", nationality: "UTO", expiryDate: "2012-04-15", mrzLine1: L1, mrzLine2: L2, confidence: 0.6 }, "2026-10-01");
  assert.equal(r.mrzVerified, true);
  assert.equal(r.lastName, "ERIKSSON");
  assert.equal(r.firstName, "ANNA MARIA");
  assert.equal(r.documentNumber, "L898902C3");
  assert.equal(r.dob, "1974-08-12");
  assert.equal(r.confidence, 1);
  assert.ok(r.warnings.some((w) => /expired/.test(w)));

  const single = buildScanResult({ documentType: "PASSPORT", surname: "", givenNames: "Hussain", documentNumber: "z1234567",
    dateOfBirth: "1990-02-30", gender: "M", nationality: "IND", expiryDate: "2027-01-10", mrzLine1: "", mrzLine2: "", confidence: 0.9 }, "2026-10-01");
  assert.equal(single.mrzVerified, false);
  assert.equal(single.nationality, "IN");
  assert.equal(single.documentNumber, "Z1234567");
  assert.equal(single.dob, null);                       // impossible date dropped, not guessed
  assert.ok(single.warnings.some((w) => /one name/.test(w)));
  assert.ok(single.warnings.some((w) => /6 months/.test(w)));
});

test("POST /api/ai/scan-document sends the image to Gemini and returns traveller fields", async () => {
  const env: any = { GEMINI_API_KEY: "G", FARE_CACHE_KV: { get: async () => null, put: async () => {} } };
  const app = new Hono<any>();
  app.use("*", async (c, n) => { c.set("tenantId", "t"); await n(); });
  app.route("/api/ai", aiRoutes);
  const ctx: any = { waitUntil: (p: Promise<unknown>) => p, passThroughOnException() {} };
  let sent: any;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ isTravelDocument: true, documentType: "PASSPORT",
      surname: "ERIKSSON", givenNames: "ANNA MARIA", dateOfBirth: "1974-08-12", gender: "F", nationality: "", documentNumber: "L898902C3",
      issueDate: "", expiryDate: "2032-04-15", issuingCountry: "", mrzLine1: "", mrzLine2: "", confidence: 0.95 }) }] } }] }));
  }) as any;
  try {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "p.jpg", { type: "image/jpeg" }));
    const res = await app.fetch(new Request("http://x/api/ai/scan-document", { method: "POST", body: form }), env, ctx);
    const d: any = await res.json();
    assert.equal(res.status, 200, JSON.stringify(d));
    assert.equal(d.traveller.lastName, "ERIKSSON");
    assert.equal(d.stored, false);
    assert.equal(sent.contents[0].parts[1].inlineData.mimeType, "image/jpeg");
    assert.equal(sent.generationConfig.responseMimeType, "application/json");

    const bad = new FormData();
    bad.append("file", new File([new Uint8Array([1])], "a.txt", { type: "text/plain" }));
    const r2 = await app.fetch(new Request("http://x/api/ai/scan-document", { method: "POST", body: bad }), env, ctx);
    assert.equal(r2.status, 415);
  } finally { globalThis.fetch = realFetch; }
});
