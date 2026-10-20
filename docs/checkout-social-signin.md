# Checkout and customer sign-in

Checkout opens directly to traveller details, without an automatic fare-review blocker. Guests can continue without an account. The customer reviews details before submitting; the API still requests a TripJack booking session immediately before booking. A failed request is not evidence of expiry: route, authentication, timeout and supplier-response errors have separate diagnostic codes and request IDs. The existing displayed price calculation is unchanged.

## Deployment

The API deployment requires GitHub Actions `DATABASE_URL` and a successful `0003_customer_social_signin.sql` migration. The migration adds optional social identity columns and a short-lived challenge table. It must finish before deploying the API, including when enabling no social providers.

Configure these API Worker secrets/settings to enable customer sign-in:

- Google: `GOOGLE_CLIENT_ID`, with the checkout origin registered in Google Identity Services.
- Apple: `APPLE_CLIENT_ID` (web Services ID), `APPLE_CLIENT_SECRET` (developer-generated client-secret JWT, rotated before expiry), and `APPLE_REDIRECT_URI` (registered HTTPS return URL).
- `SOCIAL_AUTH_ORIGINS`: optional comma-separated exact origins; defaults to `https://flypoomas.com,https://www.flypoomas.com`.

Unconfigured providers remain hidden. Provider credentials are verified on the server using trusted public keys, issuer, audience, expiry, nonce and a single-use challenge. Apple authorization codes are exchanged server-side. Existing email accounts are not automatically linked. Social customer sessions are limited to customer profile endpoints and honor logout revocation.

Before enabling providers, test fresh and returning accounts, Apple private relay, cancellation and retry, and preservation of entered traveller details. Actual provider sign-in has not been tested without production credentials.

## TripJack investigation and remaining verification

Search and review now resolve the same configured credentials and gateway. The implemented review request is `POST /fms/v1/review` with `priceIds`, requiring a returned `bookingId`. Tests cover request/response handling, not certification of the supplier contract.

The public TripJack documentation inspected at https://tripjack.com/page/api-doc describes hotel APIs; it does not establish the flight review and booking contract. Confirm both endpoints and schemas against the account's AIR integration documentation. Do not substitute hotel verification routes. The separately hosted TripJack gateway must also contain the review route; this repository's Cloudflare deployment does not deploy that gateway.

Use the review diagnostic request ID to correlate API failures. Route errors indicate the gateway/upstream path needs checking; authentication errors require checking credentials and IP allowlisting. Only explicit supplier fare-expiry responses should be presented as expired. Successful live booking is not established by the local tests.

Identity references: https://developers.google.com/identity/gsi/web/guides/verify-google-id-token and https://developer.apple.com/documentation/signinwithapple/verifying-a-user.
