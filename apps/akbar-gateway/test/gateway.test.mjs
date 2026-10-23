import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  SecurityBoundary,
  signRequest,
  principalsFromConfig,
} from "../src/security.mjs";
import { createHandler } from "../src/handler.mjs";
import { createMockService, UAT_OPERATIONS } from "../src/service.mjs";
import { signedAkbarGatewayRequest } from "../dist/akbar/gateway-auth.js";
const NOW = 1792666800000,
  KEY = "mock-only-signing-key-at-least-32-characters",
  AUD = "zamra-akbar-uat";
const principal = {
  keyId: "worker-a",
  signingKey: KEY,
  tenantId: "tenant-a",
  accountId: "account-a",
  credentialVersion: "v1",
  environment: "UAT",
};
const params = {
  origin: "COK",
  destination: "DXB",
  departureDate: "2027-01-10",
  adults: 1,
  children: 0,
  infants: 0,
  cabinClass: "ECONOMY",
  tripType: "ONEWAY",
  currency: "INR",
};
function setup(options = {}) {
  const principals = principalsFromConfig(options.principals ?? [principal]);
  const boundary = new SecurityBoundary({
    principals,
    audience: AUD,
    now: () => NOW,
    ...options.boundary,
  });
  let executions = 0;
  const logs = [];
  const service = options.service ?? {
    execute: async () => {
      executions++;
      return [];
    },
  };
  return {
    handler: createHandler({
      boundary,
      service,
      logger: (e) => logs.push(e),
      ...options.handler,
    }),
    boundary,
    logs,
    count: () => executions,
  };
}
function request(body = params, options = {}) {
  const method = options.method ?? "POST",
    path = options.path ?? "/v1/akbar/search",
    bytes = options.raw ?? JSON.stringify(body),
    keyId = options.keyId ?? "worker-a",
    timestamp = String(options.timestamp ?? NOW),
    nonce = options.nonce ?? randomUUID();
  const signature = signRequest(options.key ?? KEY, {
    audience: options.audience ?? AUD,
    keyId,
    timestamp,
    nonce,
    method,
    path,
    body: bytes,
  });
  return new Request("https://gateway.example" + path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-zamra-key-id": keyId,
      "x-zamra-timestamp": timestamp,
      "x-zamra-nonce": nonce,
      "x-zamra-signature": signature,
      ...options.headers,
    },
    ...(method === "POST" ? { body: bytes } : {}),
  });
}
const json = (r) => r.json();
test("gateway local security suite forbids all fetch calls", async (t) => {
  const previous = global.fetch;
  global.fetch = () => {
    throw Error("Real network forbidden");
  };
  t.after(() => {
    global.fetch = previous;
  });
  await t.test(
    "authenticated request and Worker WebCrypto signing match Node HMAC",
    async () => {
      const s = setup();
      const r = await signedAkbarGatewayRequest({
        origin: "https://gateway.example",
        audience: AUD,
        keyId: "worker-a",
        signingKey: KEY,
        operation: "search",
        body: params,
        now: NOW,
      });
      assert.equal(r.redirect, "error");
      assert.equal((await s.handler(r)).status, 200);
      assert.equal(s.count(), 1);
    },
  );
  await t.test(
    "missing auth, forged body, wrong audience/path/key/method fail closed",
    async () => {
      const s = setup();
      assert.equal(
        (
          await s.handler(
            new Request("https://gateway.example/v1/akbar/search", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            }),
          )
        ).status,
        401,
      );
      for (const options of [
        { key: "mock-wrong-key" },
        { audience: "other" },
        { keyId: "unknown" },
        { headers: { "x-zamra-signature": "a".repeat(64) } },
      ])
        assert.equal((await s.handler(request(params, options))).status, 401);
      const r = request();
      const forged = new Request(r.url, {
        method: "POST",
        headers: r.headers,
        body: '{"origin":"DEL"}',
      });
      assert.equal((await s.handler(forged)).status, 401);
      const p = request();
      const changed = new Request("https://gateway.example/v1/akbar/price", {
        method: "POST",
        headers: p.headers,
        body: JSON.stringify(params),
      });
      assert.equal((await s.handler(changed)).status, 401);
      assert.equal(s.count(), 0);
    },
  );
  await t.test(
    "timestamp skew, future requests, bad nonce/signature are rejected",
    async () => {
      const s = setup();
      for (const options of [
        { timestamp: NOW - 30001 },
        { timestamp: NOW + 30001 },
        { nonce: "short" },
        { headers: { "x-zamra-signature": "z".repeat(64) } },
      ])
        assert.equal((await s.handler(request(params, options))).status, 401);
    },
  );
  await t.test(
    "replay is rejected and replay storage fails closed at capacity",
    async () => {
      const s = setup({ boundary: { replayCapacity: 1 } }),
        nonce = randomUUID();
      assert.equal((await s.handler(request(params, { nonce }))).status, 200);
      assert.equal((await s.handler(request(params, { nonce }))).status, 409);
      assert.equal((await s.handler(request())).status, 503);
      assert.equal(s.count(), 1);
    },
  );
  await t.test(
    "provider auth, booking, payment, arbitrary URL/query and unknown routes are denied",
    async () => {
      const s = setup();
      for (const path of [
        "/Utils/Signature",
        "/Flights/CreateItinerary",
        "/Flights/StartPay",
        "/v1/akbar/search?url=https://evil.invalid",
        "/v1/akbar/unknown",
      ])
        assert.equal((await s.handler(request(params, { path }))).status, 404);
      assert.equal(
        (await s.handler(request(params, { method: "GET" }))).status,
        405,
      );
      assert.equal(s.count(), 0);
      assert(!Object.hasOwn(UAT_OPERATIONS, "StartPay"));
      assert(!Object.hasOwn(UAT_OPERATIONS, "FlightInfo"));
    },
  );
  await t.test(
    "scope, environment, target URL and provider credentials cannot come from request",
    async () => {
      for (const field of [
        "tenantId",
        "accountId",
        "environment",
        "credentialVersion",
        "url",
        "Token",
        "Password",
        "ApiKey",
      ]) {
        const s = setup();
        assert.equal(
          (await s.handler(request({ ...params, [field]: "forbidden" })))
            .status,
          400,
        );
        assert.equal(s.count(), 0);
      }
    },
  );
  await t.test(
    "body limits include chunked/no-length requests; encodings and wrong content types rejected",
    async () => {
      const s = setup({ handler: { maxBodyBytes: 100 } });
      assert.equal(
        (await s.handler(request({}, { raw: "x".repeat(101) }))).status,
        413,
      );
      assert.equal(
        (await s.handler(request({}, { headers: { "content-length": "101" } })))
          .status,
        413,
      );
      assert.equal(
        (
          await s.handler(
            request({}, { headers: { "content-encoding": "gzip" } }),
          )
        ).status,
        415,
      );
      assert.equal(
        (
          await s.handler(
            request({}, { headers: { "content-type": "text/plain" } }),
          )
        ).status,
        415,
      );
      assert.equal(s.count(), 0);
    },
  );
  await t.test(
    "malformed JSON and arrays are rejected only after authentication",
    async () => {
      for (const raw of ["{bad", "[]", "null"]) {
        const s = setup();
        assert.equal((await s.handler(request({}, { raw }))).status, 400);
        assert.equal(s.count(), 0);
      }
    },
  );
  await t.test(
    "rate limit aggregates by scope across signing key rotation; XFF cannot bypass",
    async () => {
      const rotated = {
        ...principal,
        keyId: "worker-new",
        signingKey: KEY + "new",
      };
      const s = setup({
        principals: [principal, rotated],
        boundary: { perMinute: 1 },
      });
      assert.equal((await s.handler(request())).status, 200);
      assert.equal(
        (
          await s.handler(
            request(params, {
              keyId: "worker-new",
              key: rotated.signingKey,
              headers: { "x-forwarded-for": "1.2.3.4" },
            }),
          )
        ).status,
        429,
      );
    },
  );
  await t.test(
    "concurrency limit holds leases even when HTTP deadline expires",
    async () => {
      let release;
      const pending = new Promise((r) => (release = r));
      const s = setup({
        handler: { timeoutMs: 15 },
        service: { execute: () => pending },
      });
      const a = s.handler(request()),
        b = s.handler(request());
      await new Promise((r) => setTimeout(r, 1));
      assert.equal((await s.handler(request())).status, 503);
      assert.equal((await a).status, 504);
      assert.equal((await b).status, 504);
      assert.equal((await s.handler(request())).status, 503);
      release([]);
      await new Promise((r) => setTimeout(r, 1));
      assert.equal((await s.handler(request())).status, 200);
    },
  );
  await t.test(
    "slow request bodies time out without executing service",
    async () => {
      const s = setup({ handler: { timeoutMs: 10 } });
      const stream = new ReadableStream({ start() {} });
      const r = new Request("https://gateway.example/v1/akbar/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
        duplex: "half",
      });
      assert.equal((await s.handler(r)).status, 408);
      assert.equal(s.count(), 0);
    },
  );
  await t.test(
    "oversized or credential-bearing responses cannot leave gateway",
    async () => {
      for (const body of [
        { Token: "mock-private" },
        { tui: "mock-private" },
        { Password: "mock-private" },
        { data: "a".repeat(500) },
      ]) {
        const s = setup({
          handler: { maxResponseBytes: 200 },
          service: { execute: async () => body },
        });
        assert.equal((await s.handler(request())).status, 502);
      }
    },
  );
  await t.test(
    "errors/logs never include input, credentials, tenant names or exception messages",
    async () => {
      const s = setup({
        service: {
          execute: async () => {
            throw Error("mock-private-provider-password");
          },
        },
      });
      const r = await s.handler(request());
      assert.equal(r.status, 502);
      assert(!JSON.stringify(await json(r)).includes("mock-private"));
      const logs = JSON.stringify(s.logs);
      assert(!logs.includes(KEY));
      assert(!logs.includes("mock-private"));
      assert(!logs.includes("tenant-a"));
      assert(!logs.includes("COK"));
      assert.equal(s.logs[0].operation, "search");
    },
  );
  await t.test(
    "health reveals only mock mode and does not call service",
    async () => {
      const s = setup();
      const r = await s.handler(new Request("https://gateway.example/health"));
      assert.deepEqual(await json(r), {
        status: "ok",
        mode: "mock-only",
        network: false,
      });
      assert.equal(s.count(), 0);
    },
  );
  await t.test(
    "invalid config, shared cross-tenant keys and conflicting account revisions fail startup",
    () => {
      for (const values of [
        [],
        [{ ...principal, environment: "PRODUCTION" }],
        [{ ...principal, signingKey: "short" }],
        [principal, { ...principal, keyId: "b", tenantId: "tenant-b" }],
        [
          principal,
          {
            ...principal,
            keyId: "b",
            signingKey: KEY + "new",
            credentialVersion: "v2",
          },
        ],
      ])
        assert.throws(() => principalsFromConfig(values));
      assert.throws(() => setup({ boundary: { perMinute: NaN } }));
    },
  );
  await t.test(
    "Worker signing rejects HTTP targets, userinfo, query/fragment/path injection",
    async () => {
      for (const origin of [
        "http://gateway.example",
        "https://user:pass@gateway.example",
        "https://gateway.example/path",
        "https://gateway.example?x=1",
        "https://gateway.example#x",
      ])
        await assert.rejects(
          signedAkbarGatewayRequest({
            origin,
            audience: AUD,
            keyId: "worker-a",
            signingKey: KEY,
            operation: "search",
            body: params,
            now: NOW,
          }),
        );
    },
  );
  await t.test(
    "one owner serves multiple Worker keys with one account-scoped auth session",
    async () => {
      const calls = [];
      const credentials = {
        merchantId: "mock",
        apiKey: "mock",
        clientId: "mock",
        password: "mock",
        agentCode: "",
        browserKey: "mock",
      };
      const service = createMockService({
        secretsFor: () => credentials,
        transportFor: () => ({
          kind: "mock",
          request: async (op) => {
            calls.push(op);
            if (op === "Signature") {
              await new Promise((r) => setTimeout(r, 10));
              return {
                status: 200,
                body: {
                  Code: "200",
                  Token: "mock-token",
                  ClientID: "mock-client",
                },
              };
            }
            return {
              status: 200,
              body:
                op === "ExpressSearch"
                  ? { Code: "200", TUI: "mock-search" }
                  : {
                      Code: "200",
                      TUI: "mock-search",
                      CurrencyCode: "INR",
                      Completed: true,
                      Trips: [],
                    },
            };
          },
        }),
      });
      const rotated = {
          ...principal,
          keyId: "worker-b",
          signingKey: KEY + "new",
        },
        s = setup({ principals: [principal, rotated], service });
      const results = await Promise.all([
        s.handler(request()),
        s.handler(
          request(params, { keyId: rotated.keyId, key: rotated.signingKey }),
        ),
      ]);
      assert(results.every((r) => r.status === 200));
      assert.equal(calls.filter((o) => o === "Signature").length, 1);
    },
  );
  await t.test(
    "owner rejects non-mock transports and account capacity overflow",
    async () => {
      const creds = {
        merchantId: "mock",
        apiKey: "mock",
        clientId: "mock",
        password: "mock",
        agentCode: "",
        browserKey: "mock",
      };
      const service = createMockService({
        secretsFor: () => creds,
        transportFor: () => ({ kind: "http" }),
        capacity: 1,
      });
      await assert.rejects(
        service.execute(principal, "search", params),
        /NETWORK_DISABLED/,
      );
    },
  );
  await t.test(
    "gateway-to-provider operation limit is independent from inbound rate limits",
    async () => {
      let calls = 0;
      const service = createMockService({
        upstreamPerMinute: 1,
        secretsFor: () => ({
          merchantId: "mock",
          apiKey: "mock",
          clientId: "mock",
          password: "mock",
          agentCode: "",
          browserKey: "mock",
        }),
        transportFor: () => ({
          kind: "mock",
          request: async () => {
            calls++;
            return {
              status: 200,
              body: { Code: "200", Token: "mock", ClientID: "mock" },
            };
          },
        }),
      });
      await assert.rejects(service.execute(principal, "search", params));
      assert.equal(calls, 1);
    },
  );
});

test("real mock service isolates references and account capacity across tenants", async () => {
  const previous = global.fetch;
  global.fetch = () => {
    throw Error("Network forbidden");
  };
  try {
    const calls = [];
    const config = {
      secretsFor: () => ({
        merchantId: "mock",
        apiKey: "mock",
        clientId: "mock",
        password: "mock",
        agentCode: "",
        browserKey: "mock",
      }),
      contractFor: () => ({
        pricing: { fixtureOnly: true, orderIds: [0], segmentTotals: true },
      }),
      transportFor: () => ({
        kind: "mock",
        request: async (op) => {
          calls.push(op);
          return {
            status: 200,
            body:
              op === "Signature"
                ? { Code: "200", Token: "mock-token", ClientID: "mock-client" }
                : op === "ExpressSearch"
                  ? { Code: "200", TUI: "mock-search" }
                  : {
                      Code: "200",
                      TUI: "mock-search",
                      Completed: true,
                      CurrencyCode: "INR",
                      Trips: [
                        {
                          Journey: [
                            {
                              Index: "6E|fixture",
                              Provider: "6E",
                              MAC: "6E",
                              FlightNo: "1234",
                              From: "COK",
                              To: "DXB",
                              DepartureTime: "2027-01-10T10:00:00",
                              ArrivalTime: "2027-01-10T14:00:00",
                              Cabin: "E",
                              NetFare: 5290,
                              GrossFare: 5421,
                              Inclusions: { Baggage: "15 Kg" },
                            },
                          ],
                        },
                      ],
                    },
          };
        },
      }),
    };
    const b = {
        ...principal,
        keyId: "tenant-b-key",
        tenantId: "tenant-b",
        signingKey: KEY + "tenant-b",
      },
      service = createMockService(config),
      s = setup({ principals: [principal, b], service });
    const first = await s.handler(request()),
      offer = (await first.json()).data[0];
    assert(offer.reference);
    const foreign = await s.handler(
      request(
        { references: [offer.reference] },
        { path: "/v1/akbar/price", keyId: b.keyId, key: b.signingKey },
      ),
    );
    assert.equal(foreign.status, 410);
    assert(!JSON.stringify(await foreign.json()).includes("mock-search"));
    const own = await s.handler(
      request(params, { keyId: b.keyId, key: b.signingKey }),
    );
    assert.equal(own.status, 200);
    assert.equal(calls.filter((c) => c === "Signature").length, 2);
    const small = createMockService({ ...config, capacity: 1 });
    await small.execute(principal, "search", params);
    await assert.rejects(
      small.execute(b, "search", params),
      /ACCOUNT_CAPACITY/,
    );
  } finally {
    global.fetch = previous;
  }
});

test("request and response secret field filters are case insensitive", async () => {
  for (const name of ["token", "APIKEY", "signingKey"]) {
    const s = setup();
    assert.equal(
      (await s.handler(request({ ...params, [name]: "mock-private" }))).status,
      400,
    );
  }
  const s = setup({
    service: { execute: async () => ({ token: "mock-private" }) },
  });
  assert.equal((await s.handler(request())).status, 502);
  const fields = setup();
  assert.equal(
    (await fields.handler(request({ ...params, unexpected: "extra" }))).status,
    400,
  );
});
