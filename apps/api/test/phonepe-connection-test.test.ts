import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import worker from "../src/index.js";

// Staging-only PhonePe connection diagnostic (POST /api/admin/settings/phonepe/connection-test).
// Drives the real Worker entry point. The tenant comes from a KV cache hit and the
// database is reached only through fetch, so any database access shows up as an
// extra fetch call (and the shared network guard rejects anything unmocked); KV writes and
// queue sends are recorded and must stay empty.
const HOST = "https://zamra-api-staging.example.workers.dev";
const PATH = `${HOST}/api/admin/settings/phonepe/connection-test`;
const SERVICE = "fixture-admin-service-token-0123456789abcdef";
const SECRET = "fixture-client-secret-must-not-leak";
const CLIENT = "FIXTURECLIENTID";
const TOKEN = "fixture-access-token-must-not-leak";
const SANDBOX_AUTH = "https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token";
const tenant = { id: "tenant-fixture", slug: "zamra", name: "Zamra", plan: "PRO", region: "IN", defaultCurrency: "INR", searchRpmLimit: 60, bookingRpmLimit: 30, supplierConfigs: [], paymentConfig: null, status: "ACTIVE" };

// A real, active full admin (cached as the admin lookup expects).
const adminUser = { id: "u1", role: "SUPER_ADMIN", isActive: true, permissions: [], name: "Fixture", email: "admin@example.invalid" };

function env(overrides: Record<string, unknown> = {}) {
  const writes: unknown[] = [];
  const kv = {
    get: async (key: string) =>
      key === `tenant:host:${new URL(HOST).hostname}` ? tenant : key === "admin_user:u1" ? adminUser : null,
    put: async (...a: unknown[]) => void writes.push(a),
    delete: async (...a: unknown[]) => void writes.push(a),
  };
  const e: any = {
    ENVIRONMENT: "staging",
    PLATFORM_TENANT_SLUG: "zamra",
    DATABASE_URL: "postgresql://fixture:fixture@fixture.invalid/fixture",
    JWT_SECRET: "fixture-jwt-secret-0123456789abcdef0123456789",
    ADMIN_SERVICE_TOKEN: SERVICE,
    PHONEPE_ENVIRONMENT: "sandbox",
    PHONEPE_TENANT_ID: "tenant-fixture",
    PHONEPE_CLIENT_ID: CLIENT,
    PHONEPE_CLIENT_SECRET: SECRET,
    PHONEPE_CLIENT_VERSION: "1",
    PHONEPE_MERCHANT_ID: "FIXTUREMERCHANT",
    TENANT_CACHE_KV: kv,
    SESSIONS_KV: kv,
    BOOKING_QUEUE: { send: async (m: unknown) => void writes.push(m) },
    NOTIFY_QUEUE: { send: async (m: unknown) => void writes.push(m) },
    ...overrides,
  };
  return { e, writes };
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as any;

type Call = { url: string; init: RequestInit };
function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const call = { url: typeof input === "string" ? input : input.url, init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}
const tokenResponse = (body: Record<string, unknown> = {}) =>
  Response.json({ access_token: TOKEN, token_type: "O-Bearer", expires_at: Math.floor(Date.now() / 1000) + 3600, ...body });

async function call(e: any, auth?: string, method = "POST") {
  const res = await worker.fetch(new Request(PATH, { method, headers: auth ? { authorization: auth } : {} }), e, ctx);
  const text = await res.text();
  return { status: res.status, text, data: JSON.parse(text) as any };
}
function assertNoSecrets(text: string) {
  for (const s of [TOKEN, SECRET, CLIENT, SERVICE, "access_token", "O-Bearer"]) assert.ok(!text.includes(s), `response leaked ${s}`);
}

test("success with release gates off: one sandbox OAuth request, sanitized response, no writes", async () => {
  const { e, writes } = env(); // no PHONEPE_SCHEMA_READY / MERCHANT_ACTIVE / RELEASE_APPROVED
  const m = mockFetch(() => tokenResponse());
  try {
    const r = await call(e, `Bearer ${SERVICE}`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.data).sort(), ["checkedAt", "environment", "ok"]);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.environment, "sandbox");
    assert.ok(Math.abs(Date.parse(r.data.checkedAt) - Date.now()) < 60000);
    assertNoSecrets(r.text);
    assert.equal(m.calls.length, 1);
    assert.equal(m.calls[0].url, SANDBOX_AUTH);
    assert.equal(m.calls[0].init.method, "POST");
    const form = new URLSearchParams(String(m.calls[0].init.body));
    assert.equal(form.get("grant_type"), "client_credentials");
    assert.equal(form.get("client_id"), CLIENT);
    assert.deepEqual(writes, []);
    // A second run requests a fresh token rather than reporting a cached one.
    assert.equal((await call(e, `Bearer ${SERVICE}`)).status, 200);
    assert.equal(m.calls.length, 2);
  } finally {
    m.restore();
  }
});

test("only the exact ADMIN_SERVICE_TOKEN may run it; admin sessions and wrong tokens are refused without a provider call", async () => {
  const m = mockFetch(() => tokenResponse());
  try {
    const { e, writes } = env();
    const adminJwt = await new SignJWT({ userId: "u1", tenantId: "tenant-fixture", role: "SUPER_ADMIN" })
      .setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m").sign(new TextEncoder().encode(e.JWT_SECRET));
    for (const [auth, status] of [
      [undefined, 401],
      ["Bearer wrong-token", 401],
      [`Bearer ${SERVICE}x`, 401],
      [`Bearer ${SERVICE.slice(0, -1)}`, 401],
      [`Basic ${SERVICE}`, 401],
      [SERVICE, 401],
      [`Bearer ${adminJwt}`, 403], // a real full-admin session is not enough
    ] as const) {
      const r = await call(e, auth);
      assert.equal(r.status, status, `${String(auth).slice(0, 20)} → ${r.text}`);
      assert.notEqual(r.data.ok, true);
      assertNoSecrets(r.text);
    }
    // No service token configured: refused even for an admin session.
    const none = env({ ADMIN_SERVICE_TOKEN: undefined });
    const r = await call(none.e, `Bearer ${adminJwt}`);
    assert.equal(r.status, 403);
    assert.equal(r.data.error, "SERVICE_TOKEN_REQUIRED");
    assert.equal(m.calls.length, 0);
    assert.deepEqual([...writes, ...none.writes], []);
    // Only POST is routed.
    assert.equal((await call(e, `Bearer ${SERVICE}`, "GET")).status, 404);
    assert.equal(m.calls.length, 0);
  } finally {
    m.restore();
  }
});

test("refused in production or with a non-sandbox PhonePe environment, before any provider call", async () => {
  const m = mockFetch(() => tokenResponse());
  try {
    for (const o of [
      { ENVIRONMENT: "production" },
      { ENVIRONMENT: "production", PHONEPE_ENVIRONMENT: "sandbox" },
      { PHONEPE_ENVIRONMENT: "production" },
      { PHONEPE_ENVIRONMENT: undefined },
    ]) {
      const { e, writes } = env(o);
      const r = await call(e, `Bearer ${SERVICE}`);
      assert.equal(r.status, 404, JSON.stringify(o));
      assert.deepEqual(r.data, { ok: false, error: "STAGING_SANDBOX_ONLY" });
      assert.deepEqual(writes, []);
    }
    assert.equal(m.calls.length, 0);
  } finally {
    m.restore();
  }
});

test("provider failures return only a sanitized error code", async () => {
  const leaky = `{"error":"invalid_client","client_secret":"${SECRET}","access_token":"${TOKEN}"}`;
  for (const [respond, status, error, httpStatus] of [
    [() => new Response(leaky, { status: 401 }), 502, "HTTP_ERROR", 401],
    [() => new Response(leaky, { status: 500 }), 502, "HTTP_ERROR", 500],
    [() => tokenResponse({ token_type: "Bearer" }), 502, "INVALID_AUTH_RESPONSE", undefined],
    [() => tokenResponse({ access_token: "" }), 502, "INVALID_AUTH_RESPONSE", undefined],
    [() => tokenResponse({ expires_at: 1 }), 502, "INVALID_AUTH_RESPONSE", undefined],
    [() => new Response(`not json ${SECRET}`), 502, "INVALID_RESPONSE", undefined],
    [() => { throw new Error(`socket ${SECRET}`); }, 502, "TRANSPORT_UNKNOWN", undefined],
    [() => { throw new DOMException(`slow ${SECRET}`, "TimeoutError"); }, 502, "TRANSPORT_UNKNOWN", undefined],
  ] as const) {
    const { e, writes } = env();
    const m = mockFetch(respond as () => Response);
    const logged: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    try {
      const r = await call(e, `Bearer ${SERVICE}`);
      console.log = log;
      // Safe diagnostics: one line with category, elapsed ms and status/error class only.
      const diag = logged.filter((l) => l.startsWith("[phonepe]"));
      assert.equal(diag.length, error === "INVALID_AUTH_RESPONSE" ? 2 : 1, logged.join("\n"));
      if (error === "INVALID_AUTH_RESPONSE") assert.match(diag[1], /"category":"INVALID_AUTH_RESPONSE","invalid":\["(token_missing|expiry_past|token_kind)"\]/);
      if (httpStatus === 401) assert.match(diag[0], /"bodyKind":"json","providerCode":"invalid_client"/);
      assert.match(diag[0], /"op":"oauth","environment":"sandbox","category":"(OK|HTTP_ERROR|FETCH_ERROR|TIMEOUT)","ms":\d+/);
      assertNoSecrets(logged.join("\n"));
      assert.ok(!/socket|slow/.test(logged.join("\n")));
      if (error === "TRANSPORT_UNKNOWN") assert.match(diag[0], /"category":"(FETCH_ERROR|TIMEOUT)","ms":\d+,"errorName":"(Error|TimeoutError)"/);
      assert.equal(r.status, status, r.text);
      assert.equal(r.data.ok, false);
      assert.equal(r.data.error, error);
      assert.equal(r.data.httpStatus, httpStatus);
      assert.equal(r.data.environment, "sandbox");
      assert.deepEqual(Object.keys(r.data).filter((k) => !["ok", "environment", "checkedAt", "error", "httpStatus"].includes(k)), []);
      assertNoSecrets(r.text);
      assert.ok(!r.text.includes("invalid_client"));
      assert.equal(m.calls.length, 1);
      assert.deepEqual(writes, []);
    } finally {
      console.log = log;
      m.restore();
    }
  }
});

test("missing or malformed credentials are reported without contacting PhonePe", async () => {
  const m = mockFetch(() => tokenResponse());
  try {
    for (const o of [{ PHONEPE_CLIENT_ID: undefined }, { PHONEPE_CLIENT_SECRET: undefined }, { PHONEPE_CLIENT_VERSION: "v1" }, { PHONEPE_TENANT_ID: undefined }]) {
      const { e } = env(o);
      const r = await call(e, `Bearer ${SERVICE}`);
      assert.equal(r.status, 503, JSON.stringify(o));
      assert.equal(r.data.error, "CREDENTIALS_MISSING");
      assertNoSecrets(r.text);
    }
    assert.equal(m.calls.length, 0);
  } finally {
    m.restore();
  }
});
