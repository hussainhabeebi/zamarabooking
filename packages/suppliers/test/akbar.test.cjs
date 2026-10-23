const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  ts = require("typescript");
const urls = new Map();
function moduleUrl(file) {
  const full = path.join(__dirname, file);
  if (urls.has(full)) return urls.get(full);
  const source = ts.transpileModule(fs.readFileSync(full, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const url =
    "data:text/javascript;base64," +
    Buffer.from(
      source.replace(
        /from ['"](\.[^'"]+\.js)['"]/g,
        (_, d) =>
          "from " +
          JSON.stringify(
            moduleUrl(path.join(path.dirname(file), d.replace(/\.js$/, ".ts"))),
          ),
      ),
    ).toString("base64");
  urls.set(full, url);
  return url;
}
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
const secrets = {
  merchantId: "mock-merchant",
  apiKey: "mock-key",
  clientId: "mock-user",
  password: "mock-password",
  agentCode: "",
  browserKey: "mock-browser",
};
const scope = {
  tenantId: "tenant-a",
  environment: "UAT",
  accountId: "account-a",
  credentialVersion: "v1",
};
function row(back = false, index = "6E|mock-1") {
  return {
    Index: index,
    Provider: "6E",
    MAC: "6E",
    FlightNo: "1234",
    From: back ? "DXB" : "COK",
    To: back ? "COK" : "DXB",
    DepartureTime: back ? "2027-01-20T10:00:00" : "2027-01-10T10:00:00",
    ArrivalTime: back ? "2027-01-20T14:00:00" : "2027-01-10T14:00:00",
    Cabin: "E",
    NetFare: 5290,
    GrossFare: 5421,
    Inclusions: { Baggage: "15 Kg" },
  };
}
function priced(round = false) {
  const trip = (back = false) => ({
    Journey: [
      {
        Provider: "6E",
        Duration: "04h 00m ",
        Stops: 0,
        Segments: [
          {
            Flight: {
              MAC: "6E",
              Airline: "IndiGo|IndiGo|IndiGo",
              FlightNo: "1234",
              DepartureCode: back ? "DXB" : "COK",
              ArrivalCode: back ? "COK" : "DXB",
              DepartureTime: back
                ? "2027-01-20T10:00:00"
                : "2027-01-10T10:00:00",
              ArrivalTime: back ? "2027-01-20T14:00:00" : "2027-01-10T14:00:00",
              Duration: "04h 00m ",
              Cabin: "E",
              Refundable: "N",
              FareClass: "R",
            },
            Fares: { TotalBaseFare: 4500, TotalTax: 831 },
          },
        ],
      },
    ],
  });
  return {
    Code: "200",
    TUI: "mock-price",
    CurrencyCode: "INR",
    ADT: 1,
    CHD: 0,
    INF: 0,
    FareType: round ? "RT" : "ON",
    GrossAmount: round ? 10842 : 5421,
    Trips: round ? [trip(), trip(true)] : [trip()],
    SSR: [{ Code: "BAG", PTC: "ADT", FUID: "1", Description: "15 Kg, 7 Kg" }],
  };
}
const pricing = { fixtureOnly: true, orderIds: [0], segmentTotals: true };
function harness(overrides = {}, round = false) {
  const calls = [];
  let count = 0;
  const transport = {
    kind: "mock",
    request: async (op, body, headers, signal) => {
      calls.push({ op, body, headers, signal });
      if (overrides[op]) return overrides[op](body, headers, calls);
      return {
        status: 200,
        body:
          op === "Signature"
            ? {
                Code: "200",
                Token: "mock-token-" + ++count,
                ClientID: "mock-encrypted-client",
              }
            : op === "ExpressSearch"
              ? { Code: "200", TUI: "mock-search" }
              : op === "GetExpSearch"
                ? {
                    Code: "200",
                    TUI: "mock-search",
                    CurrencyCode: "INR",
                    Completed: true,
                    Trips: round
                      ? [
                          { Journey: [row()] },
                          { Journey: [row(true, "6E|mock-2")] },
                        ]
                      : [{ Journey: [row()] }],
                  }
                : op === "SmartPricer"
                  ? { Code: "200", TUI: "mock-price" }
                  : priced(round),
      };
    },
  };
  return { calls, transport };
}
test("Akbar hardened offline contract", async (t) => {
  const previous = global.fetch;
  global.fetch = () => {
    throw Error("Network forbidden");
  };
  t.after(() => {
    global.fetch = previous;
  });
  const { AkbarClient, akbarSecretsFromEnv } = await import(
    moduleUrl("../src/akbar/client.ts")
  );
  const { AkbarSessionCache } = await import(
    moduleUrl("../src/akbar/session.ts")
  );
  const { AkbarOfferStore } = await import(moduleUrl("../src/akbar/offers.ts"));
  const { AkbarAdapter, akbarSearchBody } = await import(
    moduleUrl("../src/akbar/adapter.ts")
  );
  const client = (h, o = {}) =>
    new AkbarClient(secrets, h.transport, { scope, ...o });
  const adapter = (h, o = {}, co = {}) =>
    new AkbarAdapter(client(h, co), { mode: "mock", pollMs: 0, ...o });
  const available = async (a, p = params) => await a.searchAvailability(p);
  await t.test(
    "environment names only; no default/shared tenant or production scope",
    () => {
      assert.throws(() => akbarSecretsFromEnv({}), /AUTH/);
      assert.throws(
        () => new AkbarClient(secrets, harness().transport, {}),
        /DISABLED/,
      );
      assert.throws(
        () =>
          client(harness(), { scope: { ...scope, environment: "PRODUCTION" } }),
        /DISABLED/,
      );
    },
  );
  await t.test(
    "availability sends documented request and bearer, no pricing fanout or secret payload",
    async () => {
      const h = harness(),
        a = adapter(h);
      const f = await available(a);
      assert.equal(h.calls[0].op, "Signature");
      assert.equal(h.calls[1].body.ClientID, "mock-encrypted-client");
      assert.equal(h.calls[1].headers.Authorization, "Bearer mock-token-1");
      assert.equal(h.calls[1].body.FareType, "ON");
      assert.equal(h.calls.length, 3);
      assert.equal(f[0].isBookable, false);
      assert(!JSON.stringify(f).includes("TUI"));
      assert(!JSON.stringify(f).includes("mock-token"));
      assert(!JSON.stringify(f).includes("mock-key"));
    },
  );
  await t.test(
    "many offers no longer create Cartesian pricing or reject at 20",
    async () => {
      const h = harness({
        GetExpSearch: () => ({
          status: 200,
          body: {
            Code: "200",
            TUI: "mock-search",
            CurrencyCode: "INR",
            Completed: true,
            Trips: [
              {
                Journey: Array.from({ length: 60 }, (_, i) =>
                  row(false, "6E|" + i),
                ),
              },
            ],
          },
        }),
      });
      assert.equal((await available(adapter(h))).length, 60);
      assert.equal(h.calls.length, 3);
    },
  );
  await t.test(
    "pricing is disabled without explicit fixture-only contract",
    async () => {
      const a = adapter(harness());
      const [f] = await available(a);
      await assert.rejects(a.priceSelectedOffers([f.reference]), /DISABLED/);
    },
  );
  await t.test(
    "selected one-way pricing normalizes totals, fees and non-invented baggage",
    async () => {
      const h = harness(),
        a = adapter(h, { contract: { pricing } }),
        [f] = await available(a),
        d = await a.priceSelectedOffers([f.reference]);
      assert.equal(d.baseFare, 4500);
      assert.equal(d.taxes, 831);
      assert.equal(d.totalFare, 5421);
      assert.equal(d.raw.chargesAndMarkup, 90);
      assert.equal(d.baggage.cabin, "Not provided");
      assert.equal(d.baggage.checked, "15 Kg");
      assert.equal(d.fareRules[0].description, "ADT / 1: 15 Kg, 7 Kg");
      assert.equal(d.isBookable, false);
      assert.equal(d.airlineName, "IndiGo");
      assert.equal(h.calls.at(-2).body.Trips[0].Amount, 5290);
      assert.equal(h.calls.at(-2).body.Options, "A");
    },
  );
  await t.test(
    "selected RT has both legs, correct destination and combined amount",
    async () => {
      const h = harness({}, true),
        a = adapter(h, {
          contract: { pricing: { ...pricing, orderIds: [0, 1] } },
        });
      const f = await available(a, {
          ...params,
          tripType: "ROUNDTRIP",
          returnDate: "2027-01-20",
        }),
        d = await a.priceSelectedOffers(f.map((x) => x.reference));
      assert.equal(d.tripKey, "COMBO");
      assert.equal(d.totalFare, 10842);
      assert.equal(d.destination, "DXB");
      assert.equal(d.segments[1].isReturn, true);
      assert.equal(h.calls.at(-2).body.Trips.length, 2);
    },
  );
  await t.test(
    "concurrent clients share authentication only within tenant/account/credential scope",
    async () => {
      const h = harness(),
        cache = new AkbarSessionCache(),
        a = client(h, { cache }),
        b = client(h, { cache });
      await Promise.all([
        a.call("ExpressSearch", {}, Date.now() + 2000),
        b.call("ExpressSearch", {}, Date.now() + 2000),
      ]);
      assert.equal(h.calls.filter((c) => c.op === "Signature").length, 1);
      await client(h, {
        cache,
        scope: { ...scope, tenantId: "tenant-b" },
      }).call("ExpressSearch", {}, Date.now() + 2000);
      await client(h, {
        cache,
        scope: { ...scope, accountId: "account-b" },
      }).call("ExpressSearch", {}, Date.now() + 2000);
      await client(h, {
        cache,
        scope: { ...scope, credentialVersion: "v2" },
      }).call("ExpressSearch", {}, Date.now() + 2000);
      assert.equal(h.calls.filter((c) => c.op === "Signature").length, 4);
    },
  );
  await t.test(
    "changed credentials cannot reuse a token even if revision is unchanged",
    async () => {
      const h = harness(),
        cache = new AkbarSessionCache();
      await client(h, { cache }).call("ExpressSearch", {}, Date.now() + 2000);
      await new AkbarClient(
        { ...secrets, password: "mock-other" },
        h.transport,
        { scope, cache },
      ).call("ExpressSearch", {}, Date.now() + 2000);
      assert.equal(h.calls.filter((c) => c.op === "Signature").length, 2);
    },
  );
  await t.test(
    "HTTP403 never refreshes credentials; HTTP401 refreshes once",
    async () => {
      const h = harness({ ExpressSearch: () => ({ status: 403, body: {} }) });
      await assert.rejects(
        client(h).call("ExpressSearch", {}, Date.now() + 2000),
        /ACCESS_DENIED/,
      );
      assert.equal(h.calls.filter((c) => c.op === "Signature").length, 1);
      const e = harness({ ExpressSearch: () => ({ status: 401, body: {} }) });
      await assert.rejects(
        client(e).call("ExpressSearch", {}, Date.now() + 2000),
        /UNAUTHORIZED/,
      );
      assert.equal(e.calls.filter((c) => c.op === "Signature").length, 2);
    },
  );
  await t.test(
    "documented signature account actions do not retry or leak Msg",
    async () => {
      for (const code of ["5501", "9003", "5086", "5073", "6039", "5087"]) {
        const h = harness({
          Signature: () => ({
            status: 200,
            body: { Code: code, Msg: ["private data"] },
          }),
        });
        await assert.rejects(
          client(h).call("ExpressSearch", {}, Date.now() + 2000),
          (e) =>
            e.code === "ACCOUNT_ACTION_REQUIRED" &&
            !e.message.includes("private"),
        );
        assert.equal(h.calls.length, 1);
      }
    },
  );
  await t.test(
    "unknown business codes and throttling do not retry",
    async () => {
      for (const response of [
        { status: 200, body: { Code: "unknown" } },
        { status: 429, body: {} },
      ]) {
        const h = harness({ GetExpSearch: () => response });
        await assert.rejects(available(adapter(h)));
        assert.equal(h.calls.filter((c) => c.op === "GetExpSearch").length, 1);
      }
    },
  );
  await t.test(
    "transient retrieval retries once, initiation never retries",
    async () => {
      let n = 0;
      const h = harness({
        GetExpSearch: () => ({
          status: ++n === 1 ? 503 : 200,
          body: {
            Code: "200",
            TUI: "mock-search",
            CurrencyCode: "INR",
            Completed: true,
            Trips: [],
          },
        }),
      });
      assert.deepEqual(await available(adapter(h)), []);
      assert.equal(n, 2);
      const e = harness({ ExpressSearch: () => ({ status: 500, body: {} }) });
      await assert.rejects(available(adapter(e)), /UPSTREAM/);
      assert.equal(e.calls.length, 2);
    },
  );
  await t.test(
    "documented lifetime expires cache; JWT hint only shortens expiry",
    async () => {
      let now = 0;
      const h = harness(),
        c = client(h, { now: () => now });
      await c.call("ExpressSearch", {}, 5000);
      now = 48 * 3600000;
      await c.call("ExpressSearch", {}, now + 5000);
      assert.equal(h.calls.filter((c) => c.op === "Signature").length, 2);
      const token =
        "e30." +
        Buffer.from(JSON.stringify({ exp: 120 })).toString("base64url") +
        ".mock";
      const j = harness({
          Signature: () => ({
            status: 200,
            body: {
              Code: "200",
              ClientID: "mock",
              Token:
                "e30." +
                Buffer.from(
                  JSON.stringify({ exp: Math.floor(now / 1000) + 120 }),
                ).toString("base64url") +
                ".mock",
            },
          }),
        }),
        jc = client(j, { now: () => now });
      now = 0;
      await jc.call("ExpressSearch", {}, 5000);
      now = 61000;
      await jc.call("ExpressSearch", {}, now + 5000);
      assert.equal(j.calls.filter((c) => c.op === "Signature").length, 2);
    },
  );
  await t.test(
    "expired or malformed JWT never reaches a search call",
    async () => {
      for (const token of [
        "e30." + Buffer.from('{"exp":1}').toString("base64url") + ".mock",
        "x.invalid.x",
        "mock\r\ninjection",
      ]) {
        const h = harness({
          Signature: () => ({
            status: 200,
            body: { Code: "200", ClientID: "mock", Token: token },
          }),
        });
        await assert.rejects(
          client(h).call("ExpressSearch", {}, Date.now() + 2000),
        );
        assert.equal(h.calls.length, 1);
      }
    },
  );
  await t.test(
    "short concurrent caller times out independently of shared auth",
    async () => {
      const h = harness({
          Signature: async () => {
            await new Promise((r) => setTimeout(r, 30));
            return {
              status: 200,
              body: { Code: "200", Token: "mock", ClientID: "mock" },
            };
          },
        }),
        cache = new AkbarSessionCache(),
        a = client(h, { cache }),
        b = client(h, { cache });
      const short = a.call("ExpressSearch", {}, Date.now() + 10);
      const long = b.call("ExpressSearch", {}, Date.now() + 2000);
      await assert.rejects(short, /TIMEOUT/);
      await long;
      assert.equal(h.calls.filter((c) => c.op === "Signature").length, 1);
    },
  );
  await t.test(
    "hung result times out and aborts, without further requests",
    async () => {
      const h = harness({ GetExpSearch: () => new Promise(() => {}) });
      await assert.rejects(available(adapter(h, { budgetMs: 25 })), /TIMEOUT/);
      assert.equal(h.calls.at(-1).signal.aborted, true);
      assert.equal(h.calls.length, 3);
    },
  );
  await t.test(
    "partial semantics default closed; snapshots replace and deltas deduplicate/update",
    async () => {
      const run = async (mode) => {
        let n = 0;
        const h = harness({
          GetExpSearch: () => ({
            status: 200,
            body: {
              Code: "200",
              TUI: "mock-search",
              CurrencyCode: "INR",
              Completed: ++n === 2,
              Trips: [
                {
                  Journey:
                    n === 1 ? [row(false, "first")] : [row(false, "second")],
                },
              ],
            },
          }),
        });
        return available(
          adapter(h, { contract: mode ? { partialResults: mode } : undefined }),
        );
      };
      await assert.rejects(run(), /PENDING_UNVERIFIED/);
      assert.equal((await run("snapshot")).length, 1);
      assert.equal((await run("incremental")).length, 2);
    },
  );
  await t.test(
    "incremental repeated index replaces stale price, not duplicate fares",
    async () => {
      let n = 0;
      const h = harness({
        GetExpSearch: () => ({
          status: 200,
          body: {
            Code: "200",
            TUI: "mock-search",
            CurrencyCode: "INR",
            Completed: ++n === 2,
            Trips: [
              { Journey: [{ ...row(), GrossFare: n === 1 ? 5421 : 5500 }] },
            ],
          },
        }),
      });
      const f = await available(
        adapter(h, { contract: { partialResults: "incremental" } }),
      );
      assert.equal(f.length, 1);
      assert.equal(f[0].totalFare, 5500);
    },
  );
  await t.test("polling never completing is bounded", async () => {
    const h = harness({
      GetExpSearch: () => ({
        status: 200,
        body: {
          Code: "200",
          TUI: "mock-search",
          CurrencyCode: "INR",
          Completed: false,
          Trips: [],
        },
      }),
    });
    await assert.rejects(
      available(
        adapter(h, {
          budgetMs: 30,
          pollMs: 5,
          contract: { partialResults: "snapshot" },
        }),
      ),
      /TIMEOUT/,
    );
  });
  await t.test(
    "wrong TUI, currency, route, date, cabin, negative/string/NaN fares fail closed",
    async () => {
      for (const change of [
        { From: "DEL" },
        { DepartureTime: "2027-01-11T10:00:00" },
        { Cabin: "B" },
        { GrossFare: -1 },
        { GrossFare: "5421" },
        { GrossFare: NaN },
      ]) {
        const h = harness({
          GetExpSearch: () => ({
            status: 200,
            body: {
              Code: "200",
              TUI: "mock-search",
              CurrencyCode: "INR",
              Completed: true,
              Trips: [{ Journey: [{ ...row(), ...change }] }],
            },
          }),
        });
        await assert.rejects(available(adapter(h)), /INVALID_RESPONSE/);
      }
      for (const change of [
        { TUI: "wrong" },
        { CurrencyCode: "AED" },
        { Completed: "maybe" },
      ]) {
        const h = harness({
          GetExpSearch: () => ({
            status: 200,
            body: {
              Code: "200",
              TUI: "mock-search",
              CurrencyCode: "INR",
              Completed: true,
              Trips: [],
              ...change,
            },
          }),
        });
        await assert.rejects(available(adapter(h)), /INVALID_RESPONSE/);
      }
    },
  );
  await t.test(
    "opaque references enforce tenant/account ownership, expiration, capacity and cloning",
    () => {
      let now = 0;
      const s = new AkbarOfferStore(() => now, 1),
        v = {
          leg: 0,
          tui: "private",
          index: "index",
          provider: "6E",
          net: 1,
          gross: 2,
          baggage: "",
          params,
        };
      const id = s.put("a", v, 10);
      assert(!id.includes("private"));
      assert.throws(() => s.read("b", id), /OFFER_NOT_FOUND/);
      const copy = s.read("a", id);
      copy.params.origin = "DEL";
      assert.equal(s.read("a", id).params.origin, "COK");
      assert.throws(() => s.put("b", v), /CAPACITY/);
      now = 11;
      assert.throws(() => s.read("a", id), /OFFER_EXPIRED/);
    },
  );
  await t.test(
    "references cannot cross tenant adapters sharing store",
    async () => {
      const store = new AkbarOfferStore(),
        h = harness(),
        a = adapter(h, { offers: store, contract: { pricing } }),
        b = adapter(
          h,
          { offers: store, contract: { pricing } },
          { scope: { ...scope, tenantId: "tenant-b" } },
        ),
        [f] = await available(a);
      await assert.rejects(
        b.priceSelectedOffers([f.reference]),
        /OFFER_NOT_FOUND/,
      );
    },
  );
  await t.test(
    "SmartPricer pending and GetSPricer pending are explicitly unverified, not guessed polling",
    async () => {
      for (const op of ["SmartPricer", "GetSPricer"]) {
        const h = harness({
            [op]: () => ({ status: 200, body: { Code: "200" } }),
          }),
          a = adapter(h, { contract: { pricing } }),
          [f] = await available(a);
        await assert.rejects(
          a.priceSelectedOffers([f.reference]),
          /PENDING_UNVERIFIED/,
        );
        assert.equal(h.calls.filter((c) => c.op === op).length, 1);
      }
    },
  );
  await t.test(
    "documented fare-change code and changed gross invalidate stale offer",
    async () => {
      for (const d of [{ Code: "1500" }, { ...priced(), GrossAmount: 5500 }]) {
        const h = harness({ GetSPricer: () => ({ status: 200, body: d }) }),
          a = adapter(h, { contract: { pricing } }),
          [f] = await available(a);
        await assert.rejects(
          a.priceSelectedOffers([f.reference]),
          /FARE_CHANGED/,
        );
        await assert.rejects(
          a.priceSelectedOffers([f.reference]),
          /OFFER_NOT_FOUND/,
        );
      }
    },
  );
  await t.test(
    "priced response must match TUI, pax, route, date, cabin and finite fare fields",
    async () => {
      for (const mutate of [
        (d) => (d.TUI = "other"),
        (d) => (d.ADT = 2),
        (d) => (d.CurrencyCode = "USD"),
        (d) => (d.Trips[0].Journey[0].Segments[0].Flight.ArrivalCode = "DEL"),
        (d) => (d.Trips[0].Journey[0].Segments[0].Flight.Cabin = "B"),
        (d) =>
          (d.Trips[0].Journey[0].Segments[0].Flight.DepartureTime =
            "2027-01-11T10:00:00"),
        (d) => (d.Trips[0].Journey[0].Segments[0].Fares.TotalTax = NaN),
      ]) {
        const d = priced();
        mutate(d);
        const h = harness({ GetSPricer: () => ({ status: 200, body: d }) }),
          a = adapter(h, { contract: { pricing } }),
          [f] = await available(a);
        await assert.rejects(
          a.priceSelectedOffers([f.reference]),
          /INVALID_RESPONSE/,
        );
      }
    },
  );
  await t.test(
    "unsupported multicity, invalid request and ambiguous legs fail before authentication",
    async () => {
      for (const p of [
        { ...params, currency: "AED" },
        { ...params, adults: 0 },
        { ...params, departureDate: "2027-02-30" },
        { ...params, legs: [] },
      ])
        assert.throws(() => akbarSearchBody(p));
      const h = harness();
      await assert.rejects(
        available(adapter(h), { ...params, tripType: "MULTICITY" }),
        /UNSUPPORTED/,
      );
      assert.equal(h.calls.length, 0);
    },
  );
  await t.test(
    "public supplier interface and runtime booking operations are disabled",
    async () => {
      const h = harness(),
        a = adapter(h);
      await assert.rejects(a.search(params), /DISABLED/);
      await assert.rejects(
        client(h).call("CreateItinerary", {}, Date.now() + 1000),
        /DISABLED/,
      );
      for (const method of [
        "book",
        "hold",
        "cancel",
        "revalidate",
        "getPNRStatus",
      ])
        assert.equal(a[method], undefined);
      assert.equal(h.calls.length, 0);
    },
  );
  await t.test(
    "simultaneous expired-token responses perform one shared refresh",
    async () => {
      const h = harness({
        ExpressSearch: (_body, headers) => ({
          status: headers.Authorization === "Bearer mock-token-1" ? 401 : 200,
          body: { Code: "200", TUI: "mock-search" },
        }),
      });
      const cache = new AkbarSessionCache();
      const a = client(h, { cache }),
        b = client(h, { cache });
      await Promise.all([
        a.call("ExpressSearch", {}, Date.now() + 2000),
        b.call("ExpressSearch", {}, Date.now() + 2000),
      ]);
      assert.equal(h.calls.filter((c) => c.op === "Signature").length, 2);
    },
  );
  await t.test(
    "an offer expiring during pricing cannot produce a priced fare",
    async () => {
      let now = 0;
      const h = harness({
        GetSPricer: () => {
          now = 300001;
          return { status: 200, body: priced() };
        },
      });
      const a = adapter(
        h,
        { now: () => now, contract: { pricing } },
        { now: () => now },
      );
      const [offer] = await available(a);
      await assert.rejects(
        a.priceSelectedOffers([offer.reference]),
        /OFFER_EXPIRED/,
      );
    },
  );
  await t.test(
    "unrelated RT references and duplicate selections fail before pricing",
    async () => {
      const h = harness({}, true),
        a = adapter(h, {
          contract: { pricing: { ...pricing, orderIds: [0, 1] } },
        });
      const offers = await available(a, {
        ...params,
        tripType: "ROUNDTRIP",
        returnDate: "2027-01-20",
      });
      await assert.rejects(
        a.priceSelectedOffers([offers[0].reference, offers[0].reference]),
        /INVALID_REQUEST/,
      );
      await assert.rejects(
        a.priceSelectedOffers([offers[0].reference]),
        /INVALID_REQUEST/,
      );
      assert.equal(h.calls.filter((c) => c.op === "SmartPricer").length, 0);
    },
  );
});
