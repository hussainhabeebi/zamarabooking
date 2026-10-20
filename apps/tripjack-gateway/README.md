# Poomas TripJack Gateway

Dedicated fixed-egress gateway for the TripJack API. Deploy this directory from
the `main` branch as a Coolify Dockerfile application.

## Required Coolify variables

- `POOMAS_GATEWAY_KEY` — independent random secret shared only with the Poomas Worker
- `TRIPJACK_UPSTREAM` — `https://apitest.tripjack.com` for UAT (flights)

## Hotel API v3 hosts (optional — UAT defaults shown)

TripJack serves hotels from separate hosts. The gateway forwards `/hms/*`
(listing, pricing, review, static content, nationalities) and
`/oms/v3/hotel/*` (book, confirm, booking details, cancel, booking list):

- `TRIPJACK_HMS_UPSTREAM` — `https://apitest-hms.tripjack.com` (UAT) · `https://hms-search.tripjack.com` (production)
- `TRIPJACK_HOTEL_BOOKER_UPSTREAM` — `https://apitest-hotel-booker.tripjack.com` (UAT) · `https://hms-booker.tripjack.com` (production)

TripJack must whitelist the gateway IP for the hotel hosts too.

The Cloudflare Worker owns `TRIPJACK_API_KEY` and sends it to the gateway on
each authenticated request. It does not need to be stored in Coolify.
`TRIPJACK_API_KEY` remains supported in Coolify only as an optional fallback
for direct self-hosted callers.

Optional controls are documented in `src/gateway.mjs`. Configure port `3000`,
domain `proxy.flypoomas.com`, and health path `/health` in Coolify.

TripJack must whitelist the public outbound IP of the Coolify host. The gateway
never returns either secret and logs no request or response bodies.
