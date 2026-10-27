# ZamraBooking Akbar Gateway

Fixed-egress gateway for the Akbar Travels (Benzy B2B) API. Akbar only accepts
calls from a whitelisted IP; the Cloudflare Worker has no fixed IP, so it sends
every Akbar call through this gateway. Deploy this directory from the `main`
branch as a Coolify Dockerfile application, on the same server as the TripJack
gateway (same outbound IP).

## Coolify

- Base directory `/apps/akbar-gateway`, build pack Dockerfile
- Port `3000`, health check path `/health`
- Domain, e.g. `akbar-proxy.zamrabooking.com`

## Variables

- `ZAMRA_GATEWAY_KEY` — random secret; the same value goes in the Worker
  secret `AKBAR_GATEWAY_KEY`
- `AKBAR_UTILS_UPSTREAM` — default `https://b2bapiutils.benzyinfotech.com` (test)
- `AKBAR_FLIGHTS_UPSTREAM` — default `https://b2bapiflights.benzyinfotech.com` (test)

Set Akbar's live hosts in the two upstream variables when moving to production.

## Paths

`/utils/<Akbar path>` goes to the utils host and `/flights/<Akbar path>` to the
flights host, for the documented Akbar calls only. `GET /egress-ip` (with the
gateway key) returns the public IP to send Akbar for whitelisting. The gateway
forwards the request body and Akbar's Bearer token unchanged and logs no
bodies.
