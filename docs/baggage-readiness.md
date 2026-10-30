# Baggage checkout readiness

## TripJack payment-link checkout

Signed-token endpoints GET baggage, POST baggage-quote and POST baggage-apply bind tenant, current unused session, passenger IDs, review ID/expiry, segment and supplier code. Client prices are rejected. Only new TripJack bookings stamped checkoutPriceProtocol=1 qualify; older bookings must be restarted because an unknown pre-upgrade gateway request cannot be ruled out from an empty ledger. An unpaid INR PAYMENT_PENDING booking is required. Infants, held bookings and expired reviews cannot add baggage. Included baggage remains the fare allowance; extra baggage uses supplier review prices only. Preserved meals/seats are not removed from the total. New SSR choices replace previous baggage charges rather than duplicating them.

Apply performs one PostgreSQL conditional UPDATE of total_amount, base_fare and flight_data (SSR metadata, stable passenger IDs, price version). It compares the old JSONB snapshot and amount, requires an unexpired quote, no existing payment record and no payment-price freeze. Payment paths (hosted Nomod/Razorpay, customer/agency wallets, queue initiation) atomically freeze that SAME booking row/snapshot BEFORE external requests or debits. Competing SQL writers recheck predicates after waiting; stale requests fail 409. No KV mutex or schema migration. Frozen/unknown outcomes never auto-expire/unlock. A known pending Nomod link is reused without creating a second order; unknown outcomes require status reconciliation/owner review. Do not manually clear the freeze while a payment may exist.

The browser requires baggage confirmation before review and blocks progression for dirty/unapplied selections. Applied totals refresh both checkout state and the page summary. Stored passenger IDs preserve SSR after name edits; the queue uses IDs with legacy name fallback. New code does not run suppliers or take payments during tests.

## Duffel

Adapter retrieves return_available_services=true, exposes validated baggage options, checks supplier service IDs, passenger/segment eligibility, maximum quantities and same currency, and includes services with the correctly increased balance amount in order creation. Changed amounts fail before POST. Returned order.services are exposed as ancillaryServices; EMDs are not flight ticket numbers. No requested service is represented as supplier-confirmed evidence.

This is adapter mapping, not activation of a new Duffel payment-link UI. Existing instant Duffel orders cannot be edited through TripJack repricing. Post-booking bags require Duffel's separate documented order-service flow; do not fabricate support through the TripJack endpoints.

## Contracts/certification

- TripJack: sanitized tests cover one-way/round-trip with/without baggage, passenger/segment payloads, pricing, duplicate/invalid selections, signed sessions and freeze/apply races. Genuine review/book/status baggage evidence still requires separately authorized UAT bookings.
- Duffel official contract: https://duffel.com/docs/guides/adding-extra-bags . Actual offer services/eligibility and merchant entitlement govern availability. Genuine booking/order-service evidence remains outstanding.
- Akbar: Revamp has SSR and baggage-enabled airline settings, but the exact account-specific SSR/CreateItinerary/returned-service mapping is not verified. Airline Connector docs are a different API and must not be copied. No new Akbar activation.
- Riya: https://apidocs.riya.travel/ requires authorized reference-manual access. Optional baggage is not assumed from marketing claims alone.

No real bookings, payments, cancellations, deployments, merges, migrations or production data/configuration changes. PhonePe PR26 and unrelated services remain untouched. API and web changes must eventually be released together through separately approved isolated workflows; never use the legacy full-platform/migration workflow.
