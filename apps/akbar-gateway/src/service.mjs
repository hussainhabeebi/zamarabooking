import { AkbarClient, AkbarError } from "../dist/akbar/client.js";
import { AkbarAdapter } from "../dist/akbar/adapter.js";
import { AkbarSessionCache } from "../dist/akbar/session.js";
import { AkbarOfferStore } from "../dist/akbar/offers.js";
import { GatewayError } from "./security.mjs";
export const UAT_OPERATIONS = Object.freeze({
  Signature: "/Utils/Signature",
  ExpressSearch: "/flights/ExpressSearch",
  GetExpSearch: "/flights/GetExpSearch",
  SmartPricer: "/Flights/SmartPricer",
  GetSPricer: "/Flights/GetSPricer",
});
/** Exactly one service instance/process owns tokens and offers for all Worker callers. */
export function createMockService({
  transportFor,
  secretsFor,
  contractFor = () => undefined,
  now = Date.now,
  capacity = 100,
  upstreamPerMinute = 120,
}) {
  const sessions = new AkbarSessionCache(capacity),
    adapters = new Map(),
    rates = new Map();
  const accountRevision = new Map();
  async function adapter(principal) {
    const { tenantId, accountId, credentialVersion, environment } = principal;
    if (environment !== "UAT") throw new GatewayError("UAT_ONLY");
    const scope = { tenantId, accountId, credentialVersion, environment };
    const transport = transportFor(scope);
    if (transport?.kind !== "mock")
      throw new GatewayError("NETWORK_DISABLED", 503);
    const client = new AkbarClient(secretsFor(scope), transport, {
      scope,
      cache: sessions,
      now,
    });
    const key = await client.scopeKey(),
      pair = tenantId + ":" + accountId;
    // Key rotation may coexist, but concurrent conflicting account credential revisions
    // require an explicit restart/config replacement, not two independent sessions.
    if (
      accountRevision.has(pair) &&
      accountRevision.get(pair) !== credentialVersion
    )
      throw new GatewayError("REVISION_CONFLICT", 503);
    accountRevision.set(pair, credentialVersion);
    if (adapters.has(key)) return adapters.get(key);
    if (adapters.size >= capacity)
      throw new GatewayError("ACCOUNT_CAPACITY", 503);
    const limited = {
      kind: "mock",
      request: (operation, body, headers, signal) => {
        if (!Object.hasOwn(UAT_OPERATIONS, operation))
          throw new GatewayError("ROUTE_NOT_ALLOWED", 404);
        const minute = Math.floor(now() / 60000),
          r = rates.get(key);
        if (r?.minute === minute && r.count >= upstreamPerMinute)
          throw new AkbarError("RATE_LIMITED");
        rates.set(key, {
          minute,
          count: r?.minute === minute ? r.count + 1 : 1,
        });
        return transport.request(operation, body, headers, signal);
      },
    };
    const owned = new AkbarClient(secretsFor(scope), limited, {
      scope,
      cache: sessions,
      now,
    });
    const a = new AkbarAdapter(owned, {
      mode: "mock",
      contract: contractFor(scope),
      offers: new AkbarOfferStore(now, 250),
      now,
      budgetMs: 20000,
      pollMs: 250,
    });
    adapters.set(key, a);
    return a;
  }
  return {
    async execute(principal, operation, input) {
      const a = await adapter(principal);
      if (operation === "search") return a.searchAvailability(input);
      if (operation === "price") {
        if (
          !input ||
          Object.keys(input).length !== 1 ||
          !Array.isArray(input.references) ||
          !input.references.every(
            (s) =>
              typeof s === "string" && /^akbar_mock_[a-f0-9-]{36}$/.test(s),
          )
        )
          throw new GatewayError("INVALID_REFERENCES");
        return a.priceSelectedOffers(input.references);
      }
      throw new GatewayError("ROUTE_NOT_ALLOWED", 404);
    },
  };
}
