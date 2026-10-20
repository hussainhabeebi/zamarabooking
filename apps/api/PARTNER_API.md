# FlyPoomas Partner API v1

Server-to-server API for partners such as LeadVyne.

## Authentication

Create a tenant API key in FlyPoomas Admin with the `search` scope. The raw
`pmsk_...` value is displayed only once. Store it only in the partner's
server-side secret manager.

Send either:

```http
Authorization: Bearer pmsk_...
```

or, for clients that cannot set bearer authentication:

```http
X-API-Key: pmsk_...
```

## Search flights

```http
POST https://api.flypoomas.com/api/partner/v1/search
Authorization: Bearer pmsk_...
Content-Type: application/json
```

```json
{
  "origin": "COK",
  "destination": "DXB",
  "departureDate": "2026-09-12",
  "adults": 1,
  "children": 0,
  "infants": 0,
  "cabinClass": "ECONOMY",
  "tripType": "ONEWAY",
  "currency": "AED"
}
```

A successful response contains `searchId`, `expiresAt`, and `offers`.
Each offer uses `offerId` instead of exposing the internal response envelope.
Raw supplier payloads and platform credential status are never returned.

Supplier failures are isolated. Working suppliers can still return offers while
`supplierErrors` identifies a failed supplier without exposing credentials.

## Errors

- `401 PARTNER_AUTHENTICATION_REQUIRED` - missing or malformed key
- `401 PARTNER_API_KEY_INVALID` - unknown, revoked, or inactive key
- `401 PARTNER_API_KEY_EXPIRED` - key expiry has passed
- `403 PARTNER_SCOPE_REQUIRED` - key does not include `search`
- `400` - invalid search payload
- `429` - tenant rate limit exceeded



## Reserve an offer

Requires the `booking` scope. Offers are opaque, partner-owned, and expire at
the `expiresAt` returned by search.

```http
POST /api/partner/v1/offers/{offerId}/reserve
Authorization: Bearer pmsk_...
Content-Type: application/json
```

```json
{
  "externalReference": "leadv-yne-order-123",
  "customer": {
    "email": "customer@example.com",
    "phone": "+971500000000"
  }
}
```

The response returns a logical `HELD` reservation. Supplier availability and
price must still be revalidated during the eventual supplier booking.

## Create a hosted checkout session

Requires the `booking` scope. Provide either `offerId` or `reservationId`,
never both. Passenger data is required before payment because the current hosted
checkout displays and charges an existing booking record.

```http
POST /api/partner/v1/checkout-sessions
Authorization: Bearer pmsk_...
Content-Type: application/json
```

```json
{
  "reservationId": "00000000-0000-0000-0000-000000000000",
  "externalReference": "leadv-yne-order-123",
  "customer": {
    "email": "customer@example.com",
    "phone": "+971500000000"
  },
  "passengers": [
    {
      "type": "ADULT",
      "title": "MR",
      "firstName": "Test",
      "lastName": "Traveller",
      "dob": "1990-01-01",
      "gender": "M",
      "nationality": "IN",
      "passportNumber": "P1234567",
      "passportExpiry": "2030-01-01",
      "passportCountry": "IN"
    }
  ],
  "returnUrl": "https://partner.example/flights/success",
  "cancelUrl": "https://partner.example/flights/cancel"
}
```

Redirect the customer to the returned `checkoutUrl`.

## Booking status

Requires the `booking` scope. The reference is the partner's
`externalReference` supplied during reservation or direct checkout creation.

```http
GET /api/partner/v1/bookings/leadv-yne-order-123
Authorization: Bearer pmsk_...
```

## Test webhook delivery

Requires the `webhook` scope. This endpoint sends only to an active webhook
already registered for the tenant; callers cannot supply an arbitrary URL.
Configure the webhook for `webhook.test` or `*`.

```http
POST /api/partner/v1/webhooks/test
Authorization: Bearer pmsk_...
Content-Type: application/json

{}
```

The receiver must verify `X-Poomas-Timestamp` and
`X-Poomas-Signature: sha256=<HMAC-SHA256(timestamp + "." + rawBody)>`.
