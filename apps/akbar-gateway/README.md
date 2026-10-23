# Isolated Akbar gateway preparation — MOCK ONLY

No deployment, upstream connectivity, TLS certificate, DNS record, firewall rule or provider whitelist is created by this directory. The existing TripJack gateway is unchanged. This service cannot be enabled for real UAT merely by changing an environment variable: there is no HTTP provider transport. Startup rejects non-mock mode, network enablement and provider credential environment variables.

## Topology and suitability

Multiple Cloudflare Worker instances -> HTTPS reverse proxy -> **one** dedicated Akbar Node process/container -> future explicitly reviewed Akbar UAT transport. The single gateway process owns account-scoped sessions, authentication locks, token expiry and ephemeral offers. Existing supplier adapter code is compiled and reused; no second implementation of Signature/search/normalization exists.

Hostinger's VPS is a candidate because its documentation describes one dedicated IP per VPS. The actual server, Coolify deployment, network/NAT, capacity, security and outbound address have NOT been inspected. Do not claim a verified static outbound IP yet. Website DNS or Cloudflare IPs are not the gateway's egress identity. Provider whitelisting applies to the address observed on outgoing connections.

Production Worker, API schedules, queues, TripJack containers/routes/keys and existing DNS must remain untouched. The new image has no production credential values or application bindings.

## Implemented boundaries

- Only `POST /v1/akbar/search` and `POST /v1/akbar/price`; unauthenticated GET /health reports mock-only/network=false, never supplier connectivity.
- Search returns non-bookable availability with opaque references. Price is disabled unless the account's mock fixture explicitly supplies confirmed mock contract settings. Startup fixture returns only empty searches; no pricing contract is configured.
- Signature is gateway-internal; raw token/client ID responses cannot be proxied out. No raw provider path, URL, environment, tenant, credentials or account selector accepted from the request body. FlightInfo is not allowed until its contract is reviewed. No booking, CreateItinerary, StartPay, payment, ticketing, PNR or cancellation route exists.
- Internal operation allowlist: `/Utils/Signature`, `/flights/ExpressSearch`, `/flights/GetExpSearch`, `/Flights/SmartPricer`, `/Flights/GetSPricer`. Separate exact HTTPS utility/flight hosts must be allowlisted in a future transport. Never add a general proxy, caller-supplied upstream URL, redirects or DNS/IP bypass.
- Worker request signing uses HMAC-SHA256 over version, configured audience, key ID, timestamp, nonce, POST method, exact path and SHA256 of **raw body bytes**. Node and Worker WebCrypto implementations are tested for compatibility. `signedAkbarGatewayRequest` constructs a Request but never calls fetch; no cookie or authorization headers are attached, and redirects are set to error.
- Each key ID maps server-side to one UAT tenant/account/credential revision. Independent keys across tenants, no reused signing secret. Rotation may have two distinct signing keys for the same scope; rate/concurrency limits aggregate across them. Simultaneous conflicting credential revisions fail closed.
- 30-second clock-skew window, 65-second nonce retention, 10,000 replay entries; replay-capacity exhaustion rejects new work instead of evicting live nonces. NTP and monitoring are prerequisites.
- Default 30 inbound requests/minute per account scope, two in-flight per scope, sixteen global; upstream mock-operation limit 120/minute per account. No X-Forwarded-For trust. At most 100 owner accounts and 250 ephemeral offers per credential scope; one tenant cannot fill another tenant's offer cache. These conservative test limits need provider approval before UAT.
- 16 KiB streamed body limit (including chunked requests), JSON only, no Content-Encoding, 1 MiB response limit, 22-second envelope deadline, adapter 20-second budget/5-second operation timeouts. Header limit 8 KiB/5 seconds. Timed-out HTTP work retains its concurrency lease until underlying bounded service work stops.
- Structured logs contain server-generated request ID, fixed operation label, HTTP status and duration only. No request/response bodies, headers, signing keys, account names, tokens or provider error messages. Responses are no-store; unsafe auth fields are rejected before output.

## Shared ownership and limits

A single process is the session owner for every Worker instance. It reuses the hardened tenant/UAT/account/credential-revision/fingerprint cache and single-flight authentication. Principal mapping is immutable for the process lifetime; rotate/revoke by a separately approved controlled restart/config replacement. Never expose tenant/account choice directly to public callers.

Runtime requires `AKBAR_GATEWAY_LOCK_PATH`: an exclusive owner-lock file on a host-mounted directory shared by **all prospective instances**. Stale locks fail closed after crashes; an owner must verify the old process is stopped before removing one. Use one replica, no Node cluster/PM2 workers, no rolling overlap and no second host. A per-container private /tmp directory does not provide a cross-container lock. Tokens, replay state and offers are memory-only; restart invalidates offers/sessions. Before enabling networking, add the approved restart/replay strategy (for example durable nonce storage), confirm Akbar session revocation behavior, and explicitly manage any clock/restart acceptance window. Multi-host/HA requires a reviewed transactional session/replay/offer backend and distributed fencing, not a round-robin load balancer. None is provisioned here.

## Preparation and local tests only

From repository root, using Node 22 and repository-pinned pnpm:

```sh
pnpm install --frozen-lockfile
node apps/akbar-gateway/scripts/build.mjs
node --test apps/akbar-gateway/test/*.test.mjs
```

Build emits ignored `apps/akbar-gateway/dist` containing existing Akbar code and Worker signing helper. No build step contacts Akbar, deploys, starts a service or runs database operations. The Dockerfile expects this output already built; it copies only gateway source and compiled modules, runs as non-root and has no secret-file COPY. Image build/start were not executed during preparation.

Configuration **names only**, not values:

- `AKBAR_GATEWAY_MODE=mock` required. Any attempted network mode fails.
- `AKBAR_GATEWAY_AUDIENCE`: fixed service-specific audience, same in Worker signing configuration.
- `AKBAR_GATEWAY_PRINCIPALS_JSON`: array of `{ keyId, signingKey, tenantId, accountId, credentialVersion, environment: "UAT" }`, injected as protected secret configuration; never committed or logged. No provider credentials accepted in this file or from the Worker body.
- `AKBAR_GATEWAY_LOCK_PATH`: explicit absolute path on the shared owner-lock mount.
- `AKBAR_GATEWAY_BIND`: defaults 127.0.0.1; 0.0.0.0 allowed only inside a private container network. `PORT` defaults 3002. Never publish that port publicly.

No environment file containing values is included. Native upstream host configuration is intentionally absent until provider confirmation and transport review.

## Future owner actions: outbound IP verification (not performed)

1. In Hostinger VPS Overview, record the dedicated address and confirm with Hostinger that it is stable for the existing server and what changes could replace it. Record server/region and backup/recovery plan; inspect current services without altering TripJack.
2. After separate infrastructure approval, check IPv4 routes and egress from the **actual proposed container/network namespace**, using an owner-approved HTTPS IP reflector. Repeat after a controlled container restart and compare with the VPS address. Inspect outbound NAT/proxies; a panel address alone is not sufficient evidence.
3. Do not call Akbar to discover the IP. Do not send keys or headers to an IP-reflection service. Do not infer egress from X-Forwarded-For or DNS. If IPv6 exists, either confirm its whitelist separately or deliberately enforce approved IPv4 in the future transport/network design.
4. Send only the verified outbound IPv4 and required account/environment identifiers to Akbar through the existing support channel. Ask them to confirm whitelisting for both utility/auth and flight UAT hosts. No email is sent by this code/task.
5. Before future outbound calls, preserve the network route/NAT that produces the approved IP. Region/server migration, failover or a new egress address requires re-verification and Akbar confirmation. A gateway program cannot guarantee infrastructure IP stability itself.

## Future TLS setup (not performed)

- Prefer an isolated service/domain behind the existing Coolify reverse proxy if the owner verifies it can be added without affecting current routes. Do not start another process on occupied ports 80/443. Caddy is an alternative, not a directive to replace the existing proxy.
- Obtain approval for a dedicated hostname. DNS/ACME, firewall and certificate provisioning are separate future changes, not implemented here. Public HTTPS should use a valid publicly trusted certificate, standard TLS verification and automatic renewal, with renewal/certificate-expiry monitoring. Caddy documents DNS/port and persistent certificate-store requirements.
- Keep Node's HTTP port loopback-only (host setup) or private-network-only (container setup). Only the TLS reverse proxy can reach it. Do not trust a client-supplied X-Forwarded-Proto value as proof of TLS. Restrict administrative access and run the container non-root with a read-only filesystem except the explicit lock mount, no Docker socket, bounded CPU/memory and dropped capabilities.
- HMAC authentication is mandatory behind TLS. Consider mTLS or authenticated Cloudflare Access service credentials as a second layer after reviewing compatibility. Do not expose keys to browsers. Store signing keys separately from Akbar provider secrets and rotate them independently.
- Verify trusted hostname/chain/renewal, rejection of wrong Host/SNI where configured, direct-port inaccessibility, failure on invalid signatures/replays, no credential-bearing access logs and no redirect following from the future Worker/provider transport.

Primary references:
- https://www.hostinger.com/support/5139756-how-to-find-your-vps-ip-address-at-hostinger/
- https://caddyserver.com/docs/automatic-https

## Gates before any real UAT API test

Written account activation; exact separate utility/flight UAT HTTPS hosts; approved static IPv4/IPv6 whitelist; account-specific credentials via secure channel; supported test routes/dates; polling snapshot/delta/rate limits; OrderID/Amount/Options, RT pairing and fare/segment aggregation; pending pricing schemas and token-expiry/whitelist Codes; timezone, baggage and TUI expiry rules. Multicity, RS, FlightInfo normalization and booking remain blocked.

A separately reviewed change must add an actual UAT-only HTTPS transport with host/path allowlists, redirect denial, response-size/decompression limits, TLS verification, verified egress enforcement, and gateway-owned provider secrets/tokens. It must never return Signature payloads to Workers. Mock transport injection is trusted test code, not a network sandbox. Extend tests before enabling that transport.

Safe staged sequence: review this draft -> provider confirmations -> infrastructure/replay/session-owner plan approval -> isolated mock gateway deployment with **no Akbar egress** -> verify IP/TLS/auth/rollback -> approve gated UAT transport -> one authorized Signature and read-only search/pricing sequence -> sanitized contract tests. No production routing, bookings, ticketing or payments become enabled at any stage without separate authorization.

## Preparation validation

Local Node 24 validation passed: gateway compilation, 22 gateway security tests with all fetch calls forbidden, 55 supplier tests, 16 API/integration tests, and supplier/API/Admin TypeScript checks. Pinned pnpm 9.12.0 frozen offline lockfile validation passed. The container targets Node 22; a Node 22 container build/runtime test remains required before deployment. No image build, server startup, deployment or provider connection was performed.
