# Akbar Travels / Benzy integration preparation

Status: mock-only, NOT sandbox-connected or supplier-certified. No HTTP transport is included. No migrations, deployments or production configuration changes are required/performed in this PR. Live search refuses AKBAR even if a supplier config is manually enabled. No Akbar booking, hold, payment, ticketing, cancel or PNR operations exist on the adapter.

## Architecture reviewed

- `packages/suppliers/src/base.ts`: shared SupplierAdapter, SearchParams and NormalizedFare.
- `riya`, `tripjack`, `duffel`: independent clients/normalizers/adapters; booking follows the originating supplier through getBookableAdapter, hold/review/book/PNR/cancel. No existing adapter logic changes.
- `router.ts`: enabled suppliers sorted by priority then searched concurrently, bounded retries/time budget, deduplication by flight/date/cabin, price ordering and SERP fallback. Priority is not sequential provider failover. Current API configuration explicitly excludes RIYA, DUFFEL and GOOGLE_SERP temporarily; those settings and exclusions are preserved.
- `apps/api/src/routes/search.ts`: tenant/platform credential resolution, search orchestration, manual/Poomas supplemental results and fare storage. No Akbar is inserted here.
- Existing Admin Flight Sources settings use tenant KV. Akbar now advertises mock-only/unverified, search/booking/payment/ticketing disabled; saving enabled=true is rejected. Optional priority defaults to 100 for later registration. Legacy saved secrets are preserved; the new adapter does not read KV credentials or send secrets to browsers.
- The shared Akbar `search()` interface explicitly throws DISABLED. Only `searchAvailability()` and explicitly fixture-gated `priceSelectedOffers()` are available offline. Priced fixtures return `supplier=AKBAR`, `isBookable=false`, no opaque auth/raw provider payload. It is exported for offline tests only. The production router explicitly rejects it. The existing database supplier enum already includes AKBAR and needs no schema change; do not insert an AKBAR supplier row or persist mock offers.

## Official sources inspected (2026-10-22)

Authenticated WRC pages:
- https://wrc.benzyinfotech.com/home/b2b-revamp-flight/flight/
- https://wrc.benzyinfotech.com/home/b2b-revamp-flight/flight/signature/
- https://wrc.benzyinfotech.com/home/b2b-revamp-flight/flight/expresssearch/
- https://wrc.benzyinfotech.com/home/b2b-revamp-flight/flight/getexpsearch/
- https://wrc.benzyinfotech.com/home/b2b-revamp-flight/flight/smartpricer/
- https://wrc.benzyinfotech.com/home/b2b-revamp-flight/flight/getspricer/
- Official collection: https://wrc.benzyinfotech.com/wp-content/uploads/2025/06/flight_postman_collection.zip

The downloaded collection contains sample credentials/environment values; it is intentionally NOT committed. Tests use fabricated `mock-*` values, synthetic IndiGo flights and documented field names, not live responses. Documentation login credentials are unrelated to API account activation.

`Signature` is an API operation issuing a JWT, NOT local HMAC signature generation. Request fields: MerchantID, ApiKey, ClientID, Password, AgentCode, BrowserKey. Cache Token/encrypted ClientID under a hash of tenant, UAT, account, credential revision and credential values. Cache lifetime is at most 47h55m; an unverified JWT exp hint may only shorten it. Concurrent callers can share an injected bounded isolate-local cache; a caller deadline does not cancel another waiter. HTTP401 refreshes once; HTTP403 is ACCESS_DENIED and never refreshes. Unknown business token-expiry codes are not guessed. No full response or provider messages are logged. Non-200 Signature Code fails closed; never retry bad credentials (docs warn of account lockout).

Search: ExpressSearch -> TUI -> GetExpSearch polling using encrypted ClientID and bearer token. Completed is accepted as boolean or documented string. Start polling immediately; total mock search budget <=45s, below documented 50s first-poll limit. Result retrieval retries once only for transient HTTP5xx/transport errors; business failures and HTTP429 do not retry. Initiating operations never retry generic failures. Every request has an AbortSignal and <=5s timeout; polling and result sizes are bounded. Partial results fail closed as PENDING_UNVERIFIED unless an explicit mock contract selects snapshot or incremental semantics. Snapshot replaces earlier data; incremental merges by leg/provider/index with updated rows replacing stale versions. Nothing is returned before completion.

Availability search performs no pricing. Selected opaque references only: use Index/TUI/NetFare via SmartPricer -> pricing TUI -> GetSPricer; normalize segment Flight and Fares fields. GrossAmount remains the displayed total, TotalBaseFare and TotalTax remain distinct; charges/markup are recorded separately instead of mislabelling them taxes. Inclusions.Baggage is carried through; unknown cabin baggage stays “Not provided.” Never use NetFare as a retail gross total or assume each PTC fare is a party total. Combined RT mock fixture preserves both directions; no RS special-return combinations supported. Pricing requires an explicit fixture-only contract containing OrderIDs and segment-total semantics; it is disabled by default.

IM/DM multicity search codes are documented, but country classification is never guessed. Explicit mock IM/DM configuration required. SmartPricer documents ON/RT only: adapter search rejects MULTICITY before authentication. Only its documented ExpressSearch request builder is prepared; multicity pricing needs provider confirmation before implementation. Request construction/mock support is not evidence of network compatibility.

### Contract issues requiring provider confirmation

- SmartPricer table calls Amount “Net Fare”; the collection has a generic Amount placeholder. Mock selects NetFare.
- OrderID example in the table is 1; collection example is 0; neither defines indexing. Mock uses zero-based Trips position. Confirm before adding any network transport.
- SmartPricer Options table requires A; collection shows empty. Mock follows the table.
- Search page prose says Complete; response schema uses Completed. Mock follows actual response schema.
- Verify RT response/selection pairing, IM/DM pricing support, timezone offsets on local datetime strings, charge totals per passenger/segment, currency negotiation, approved retry/rate limits, token-expired business Codes and whether GetSPricer has a pending status. Pending/error schemas are not invented. Missing pricing TUI/Trips produces PENDING_UNVERIFIED without polling. GetSPricer Code1500 or changed gross produces FARE_CHANGED and invalidates old references; no new fare is silently accepted.
- Availability comes from GetExpSearch and itinerary details from GetSPricer. FlightInfo path/request is prepared in the client operation allowlist only; full FlightInfo response normalization and RS pairing remain outside this mock milestone.

## Static outbound IP proposal (no infrastructure modified)

Akbar may permit only requests whose TCP source is an allowlisted public address. Website DNS/Cloudflare proxy IPs, visitor IPs and forwarded headers do not establish outbound identity. Do not whitelist all Cloudflare ranges or assume the ordinary Worker has a stable exclusive egress address. Cloudflare offers separate dedicated-egress products with plan/product restrictions; their availability for this account has not been verified.

Recommended candidate: a separate small Akbar gateway service/container on the existing Hostinger VPS, subject to owner verification of fixed public IPv4, actual outbound/NAT address, capacity, security patches, TLS, firewall and backups. Hostinger documents a dedicated IP per VPS; the specific server was NOT accessed or certified. Repository already has `apps/tripjack-gateway` (separate Coolify/VPS deployment); reuse its route-allowlist/timeout/auth design conceptually, not its supplier credentials, routes or running container.

Proposed flow: Worker -> HTTPS authenticated Akbar-only gateway -> exact Akbar UAT hosts. Use a dedicated rotatable Worker-to-gateway secret with constant-time verification, preferably mTLS or Cloudflare Access service authentication as a second control. Bind requests to method/path/body digest plus short timestamp and nonce/replay store if using HMAC. Reject redirects and arbitrary hosts/URLs; gateway is not a generic forward proxy. Only allow Signature, ExpressSearch, GetExpSearch, SmartPricer, GetSPricer and reviewed FlightInfo POST routes initially; deny CreateItinerary, StartPay and every booking/ticketing/payment route. Separate utility/flight upstream allowlists, certificate verification, body limits, rate limits, strict timeouts, no credential/body/passenger logs. Browser never talks directly to the gateway.

Choose a single secret owner before implementation: preferably gateway secret storage for Akbar credentials/token, Worker holds only gateway service credentials. The current mock client is server-side and env-configured; it does not prescribe copying supplier secrets into both systems. Never proxy returned Signature credentials to a public endpoint. Logs should contain correlation ID, operation, status, duration and safe error code only.

Ask Akbar to whitelist the gateway's VERIFIED outbound public IPv4 for both utility/auth and flight UAT hosts (and IPv6 only if deliberately supported). Verify actual IPv4 egress from inside the future container, not just the VPS panel. No requests were made to an API host. Whether UAT accepts pre-whitelist requests is unknown: wait for written confirmation, do not probe/bypass it. Do not change existing TripJack service, API schedules or queue consumers.

Primary infrastructure references:
- https://www.hostinger.com/support/5139756-how-to-find-your-vps-ip-address-at-hostinger/
- https://developers.cloudflare.com/cloudflare-one/traffic-controls/egress-policies/dedicated-egress-ips/
- https://developers.cloudflare.com/smart-shield/configuration/dedicated-egress-ips/other-products/

## Secret configuration (names only)

`akbarSecretsFromEnv` maps AKBAR_MERCHANT_ID, AKBAR_API_KEY, AKBAR_CLIENT_ID, AKBAR_PASSWORD, AKBAR_AGENT_CODE, AKBAR_BROWSER_KEY. No values, .env file, deployment bindings or production settings are supplied. All tests inject fabricated values. Confirm required AgentCode with Akbar. Utility and flight UAT base URLs must be confirmed separately before a transport is designed.

## After Akbar replies: separate sandbox approval required

1. Obtain written UAT activation, account-specific credentials through a secure channel, exact utility/flight URLs, whitelist scope, confirmed static egress IPv4 and the contract clarifications above. Ask for approved IndiGo, one-way, RT/multicity test routes/dates and limits; no ticketing permission implied.
2. Review/approve gateway design and infrastructure independently. Establish rollback and verify existing services remain unchanged. Provision only a UAT-only, search/pricing allowlist service after separate authorization.
3. Add an explicitly gated sandbox transport; it is deliberately absent from this PR. Capture sanitized sandbox contract fixtures and compare them to these synthetic mocks. Correct OrderID, gross/base/tax aggregation, timezones, token error Codes, partial polling and RT/multicity behavior before certification. Disable request-body logging.
4. Run one authorized Signature and approved read-only search/pricing sequence from the allowlisted address; no CreateItinerary/StartPay/booking/ticketing/payment. Review sanitized health/latency/error evidence, then expire the session.
5. Keep production search and booking disabled. Production router registration, registry implications, pricing certification and health activation require a later reviewed PR and explicit approval; this PR cannot be enabled merely by toggling Admin.

## Validation commands

- `pnpm --filter @zamrabooking/suppliers exec tsc --noEmit`
- `node --test packages/suppliers/test/*.test.cjs`
- `pnpm --filter @zamrabooking/api typecheck`
- `pnpm --filter @zamrabooking/admin typecheck`

No new dependency, database schema/migration, workflow, production Worker, schedule, queue or frontend homepage file changes.

The current hardening validation results are recorded in PR #13. Supplier/API/Admin TypeScript and targeted offline regression suites are required after each change. No external API, booking, ticketing or payment requests were sent. Mock suite replaces global fetch with a rejecting function.


## Hardening update — still mock-only

- Added bounded injectable session and offer caches. Tenant/environment/account/credential revision/credential fingerprint isolation prevents cross-tenant token reuse even with shared caches. Production environment scopes are rejected. `AkbarSessionCache` is **isolate-local**, not a distributed or durable implementation: a separately approved UAT gateway session owner must provide process/distributed locking, revocation and account isolation before networking. No KV/DO/database/Worker binding is added.
- Session lifetime never exceeds the documented 48-hour maximum. JWT payload parsing is only a conservative expiry hint, not signature verification or authorization. HTTP403 is access denial, HTTP401 is at-most-one refresh, HTTP429 is not retried. Verified Signature Codes 5501/9003/5086/5073/6039/5087 require account action; 5101 is authentication failure. Provider Msg values are never logged or returned.
- Availability returns a separate non-public type containing opaque random references, not fabricated base/tax values. Search no longer prices a Cartesian product or fails at twenty combinations. Up to 500 validated availability rows may be retained; no pricing is initiated until explicit selection. Shared `search()` remains disabled in addition to the production router guard.
- `AkbarOfferStore` retains a deep-cloned request, leg/provider/index/TUI and quote server-side for at most five minutes, partitioned by the full credential scope. Foreign references are indistinguishable from missing references; expiry, capacity, stale quotes and malformed references fail closed. References are rechecked after pricing. Current storage is ephemeral: restart/eviction requires a fresh search. Lifetime is an internal maximum, not proof of provider offer validity; provider TUI validity still needs confirmation.
- Selected pricing accepts only one one-way offer or two compatible round-trip offers from the same search/request, in leg order. OrderID and fare aggregation are explicit **fixture-only** gates; no default indexing assumption remains. Missing/pending pricing bodies fail closed without invented completion fields or retry loops. Price change invalidates references and demands fresh selection, never automatic acceptance.
- Response correlation covers pricing TUI, currency, ADT/CHD/INF, FareType, route, departure date, cabin and provider. Nested segment counts, numeric fares, timestamps and connections are validated. Unknown airport-local offsets remain unchanged; UTC is not fabricated. Offsetless timezone/DST behavior must still be certified.
- Base/tax sums are allowed only by the fixture segment-total gate. Charges are kept separate. Search baggage is labelled `availability-unverified`; priced SSR BAG descriptions are preserved with PTC/FUID, not split by comma into guessed checked/cabin entitlements. Refundability and connecting segments are preserved. FlightInfo normalization and final fare-rule certification remain blocked/outstanding.
- Mocks are not network isolation by themselves: an injected `kind: mock` transport is trusted test code. The production router and disabled public search interface are the application barriers. No HTTP transport, production registration, booking/ticketing/payment methods, infrastructure or secret changes are introduced.

### Provider-dependent gates remaining

1. Confirm full snapshots vs deltas and how trips/legs are represented in partial polls, including first-poll and rate limits.
2. Confirm OrderID values/type, net vs gross Amount, Options, RT pairing and pending SmartPricer/GetSPricer schemas. Confirm segment/party aggregation, currency rounding and TUI lifespan.
3. Confirm JWT/session revocation and business token-expiry/whitelist failure codes. Never classify arbitrary codes as expired credentials.
4. Confirm local datetime timezone/offsets, baggage per passenger/segment, FlightInfo request/response and fare-rule mapping; multicity and RS remain disabled.
5. Written UAT activation, exact two upstream URLs, approved test routes, account permissions and verified static egress whitelist are required. An approved UAT-only transport/gateway and secure shared session owner are still absent.

Hardening validation: 55 supplier tests (including 30 Akbar subtests) and 16 API/integration tests passed; supplier/API/Admin TypeScript checks passed. Riya and TripJack source directories are byte-for-byte unchanged from the original PR head. No public routing, gateway, database, deployment workflow or secret configuration changes are part of this hardening commit.
