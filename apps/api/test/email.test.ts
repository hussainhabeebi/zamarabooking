import test from "node:test";
import assert from "node:assert/strict";
import { emailLayout, htmlToText, sendMail } from "../src/lib/email.js";

function kv(init: Record<string, unknown> = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return { get: async (k: string, t?: string) => { const v = m.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; }, put: async (k: string, v: string) => { m.set(k, v); } } as any;
}
function fakeDb(logs: any[]) {
  return {
    insert: () => ({ values: async (v: any) => { logs.push(v); } }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ customDomain: null }] }) }) }),
  } as any;
}
async function withFetch(handler: (url: string, init: any) => Response, fn: (calls: { url: string; init: any }[]) => Promise<void>) {
  const real = globalThis.fetch;
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: string, init: any) => { calls.push({ url, init }); return handler(url, init); }) as any;
  try { await fn(calls); } finally { globalThis.fetch = real; }
}

test("sendMail posts to Resend with sender, reply-to, ops copy, idempotency and a text part", async () => {
  const logs: any[] = [];
  const env: any = { RESEND_API_KEY: "re_secret_123", TENANT_CACHE_KV: kv({ "admin_settings:t1:email": { fromName: "FlyPoomas Bookings", fromEmail: "bookings@flypoomas.com", replyTo: "help@flypoomas.com", bccOps: "ops@flypoomas.com" } }) };
  await withFetch(() => Response.json({ id: "em_1" }), async (calls) => {
    const r = await sendMail(env, fakeDb(logs), "t1", {
      to: "asha@example.com", subject: "Booking confirmed", html: '<p>Hi <a href="https://x.co/t">trip</a></p>', category: "booking",
      idempotencyKey: "booking-confirmed:b1", copyOps: true,
    });
    assert.deepEqual(r, { ok: true, id: "em_1" });
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.equal(calls[0].init.headers.Authorization, "Bearer re_secret_123");
    assert.equal(calls[0].init.headers["Idempotency-Key"], "booking-confirmed:b1");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.from, "FlyPoomas Bookings <bookings@flypoomas.com>");
    assert.deepEqual(body.to, ["asha@example.com"]);
    assert.equal(body.reply_to, "help@flypoomas.com");
    assert.deepEqual(body.bcc, ["ops@flypoomas.com"]);
    assert.match(body.text, /Hi trip \(https:\/\/x\.co\/t\)/);
    assert.deepEqual(body.tags, [{ name: "category", value: "booking" }]);
  });
  assert.equal(logs[0].status, "SENT");
  assert.equal(logs[0].providerId, "em_1");
});

test("sendMail skips without a key or when turned off, logs failures, never throws", async () => {
  const logs: any[] = [];
  await withFetch(() => new Response("{}", { status: 500 }), async (calls) => {
    let r = await sendMail({ TENANT_CACHE_KV: kv() } as any, fakeDb(logs), "t1", { to: "a@b.co", subject: "x", html: "<p>x</p>", category: "auth" });
    assert.equal(r.skipped, true);
    r = await sendMail({ RESEND_API_KEY: "re_k", TENANT_CACHE_KV: kv({ "admin_settings:t1:email": { enabled: false } }) } as any, fakeDb(logs), "t1", { to: "a@b.co", subject: "x", html: "x", category: "auth" });
    assert.match(r.error!, /turned off/);
    r = await sendMail({ RESEND_API_KEY: "re_k", TENANT_CACHE_KV: kv() } as any, fakeDb(logs), "t1", { to: "not-an-email", subject: "x", html: "x", category: "auth" });
    assert.match(r.error!, /recipient/);
    r = await sendMail({ RESEND_API_KEY: "re_k", TENANT_CACHE_KV: kv() } as any, fakeDb(logs), "t1", { to: "a@b.co", subject: "x", html: "x", category: "auth" });
    assert.equal(r.ok, false);
    assert.match(r.error!, /Resend 500/);
    assert.equal(calls.length, 1);                                         // only the last one reached Resend
  });
  assert.deepEqual(logs.map((l) => l.status), ["SKIPPED", "SKIPPED", "SKIPPED", "FAILED"]);
  // Admin-saved key wins over the worker secret; default sender when none is set.
  await withFetch(() => Response.json({ id: "em_2" }), async (calls) => {
    await sendMail({ RESEND_API_KEY: "re_secret", TENANT_CACHE_KV: kv({ "admin_settings:t1:email": { apiKey: "re_admin_key" } }) } as any, fakeDb([]), "t1", { to: "a@b.co", subject: "x", html: "x", category: "auth" });
    assert.equal(calls[0].init.headers.Authorization, "Bearer re_admin_key");
    assert.equal(JSON.parse(calls[0].init.body).from, "FlyPoomas <bookings@flypoomas.com>");
  });
});

test("layout escapes data and includes the call to action and a plain-text fallback", () => {
  const html = emailLayout({ title: "Hello <b>", body: "<p>Body</p>", rows: [["PNR", "AB<12"]], cta: { label: "Open", href: "https://flypoomas.com/trips?a=1&b=2" } });
  assert.match(html, /Hello &lt;b&gt;/);
  assert.match(html, /AB&lt;12/);
  assert.match(html, /href="https:\/\/flypoomas\.com\/trips\?a=1&amp;b=2"/);
  const text = htmlToText(html);
  assert.match(text, /Body/);
  assert.match(text, /Open \(https:\/\/flypoomas\.com\/trips\?a=1&b=2\)/);
});

test("plain-text rows read as label: value", () => {
  const text = htmlToText(emailLayout({ title: "T", body: "<p>x</p>", rows: [["Refund", "₹15,000.00"], ["PNR", "ZX7Q2P"]] }));
  assert.match(text, /Refund: ₹15,000\.00/);
  assert.match(text, /PNR: ZX7Q2P/);
});
