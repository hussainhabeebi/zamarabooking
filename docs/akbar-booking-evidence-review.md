# Akbar booking evidence review — 28 October 2026

## Scope and evidence limits

Reviewed main d05641ac9f8a9f3287cfb355f3b9e3eb50f0b360 and PR #13 head e990c1d1de8e2baccf76990e68e504371849575a. Production Worker revision and the individual booking record have NOT been independently retrieved: Admin redirects to login. No credentials, passenger records or production data were read or changed. No supplier calls, bookings, payments, ticketing, cancellations, deployments or migrations were performed.

The reported incident is internal booking 5f28b1eb-d965-4865-896e-522f594f482b, reported Paid/CONFIRMED with only ExpressSearch HTTP 200 in its API Logs. This is user-reported runtime evidence, not an independently downloaded exchange. Exact historical call counts/outcomes cannot be asserted from source alone. Missing logs do not prove a call never occurred through another tool or version. Do not resend a booking or payment to recover evidence.

## Source-proven cause

- main's `AkbarAdapter` implements search only; it has no `book`, `hold` or CreateItinerary operation. Comments explicitly describe staff ticketing on Akbar's portal. This is a different implementation from the still-open mock-only PR #13.
- Search resolves Akbar settings, authenticates through a KV token cache, calls ExpressSearch, and polls GetExpSearch only when no journeys are returned and completion is not indicated. A single ExpressSearch log is therefore possible. HTTP 200 does not establish an itinerary or booking.
- `/api/book` routes Akbar through `bookOfflineFare`: remembers a server-side fare, saves PAYMENT_PENDING, and returns checkout authorization. It does not call SmartPricer, SSR, SeatLayout or CreateItinerary for Akbar.
- The payment capture path dispatches PAYMENT_CAPTURED. The queue detects AKBAR as an offline supplier and calls `recordOfflinePayment`. This directly sets CONFIRMED, records payment success, stores `offline.ticketing=PENDING`, and asks staff to issue the ticket. No Akbar booking call occurs on that code path. Payment handling is unchanged by this patch.
- Thus CONFIRMED currently means a paid internal order in that path; it is not Akbar confirmation. The displayed PNR/TransactionId cannot be inferred from the internal UUID or search TUI.
- Booking API Logs and ZIP exports were built for TripJack. The booking file endpoint applied TripJack host/path rewriting even to Akbar requests. The generic Suppliers API Logs endpoint already had an Akbar request exception. Search authentication used a client created before the exchange collector, so Signature exchanges were not recorded with that search even when authentication occurred.
- The gateway allowlist contains `/flights/CreateItinerary`, but an allowed route is not an implementation or evidence that it was called.

## Prepared safety changes (not deployed)

- Akbar normalized fares are not bookable; direct Akbar checkout returns 409 before supplier, identity, booking database writes or payment work. Other suppliers retain their behavior. This is a proposed temporary safety restriction and requires release review.
- Booking detail exposes a separate supplierConfirmation object and shows Akbar confirmation unverified; legacy CONFIRMED/TICKETED values and manually entered references are not treated as API evidence. Existing database records, payment state, manual ticket records, customer/portal historical views and financial workflows are not rewritten. A coordinated lifecycle/status change across all consumers remains necessary.
- Manual Admin status override cannot assert CONFIRMED/TICKETED for Akbar. Staff ticket entry remains separate; manual evidence still does not establish API confirmation.
- Booking logs identify each supplier. Akbar individual downloads preserve the recorded URL instead of using a fabricated TripJack URL, and redact sensitive fields. Akbar cannot be exported through either TripJack certification ZIP route. No Akbar certification ZIP is implemented yet.
- Akbar exchange storage and download paths redact credential/passenger fields and withhold unstructured bodies. These are sanitized diagnostic copies, not byte-for-byte certification originals. Existing logs are not rewritten. A secure original-evidence archive/access/retention policy and complete provider-specific redaction review remain prerequisites for future passenger-bearing calls.
- Search Signature calls now share the recorder when actually performed. Cache hits do not generate a synthetic Signature exchange. No logs are manufactured for missing operations.

## Booking-specific read-only evidence still required

An authorized owner must provide a sanitized export of the booking's supplier/status, created/updated timestamps, searchId, offline metadata (excluding passenger/contact data), payment status and capture timestamps, booking event/queue receipt chronology, supplier exchange index with endpoint/time/HTTP/supplier/correlation, and any existing CreateItinerary response. Verify against the actually deployed API revision. Include linked-search exchanges; a cached Signature can predate the search. Do not use Retry airline booking, Record payment, Issue ticket or Fetch supplier details during this investigation. Preserve existing supplier/provider logs privately before retention expires. No production data correction until separately approved.

## Complete UAT lifecycle design — disabled pending documentation

1. Obtain written UAT/whitelist permission and current official Postman collection/schema. The public documentation URL currently redirects to a sign-in page. Existing source comments/request builders are not sufficient certification authority.
2. Search (ExpressSearch; GetExpSearch when required). Store tenant/account/environment-scoped opaque offer references and expiry; do not trust browser prices or supplier identifiers. Confirm partial result, timeout and completion semantics.
3. Price only the selected itinerary using SmartPricer and GetSPricer when required by its mode. Validate fare, currency, passengers, segments, availability and expiry. Require explicit acceptance of a fare change. Fetch FlightInfo/FareRule and required traveller information according to the provider contract.
4. Query SSR and SeatLayout against the verified pricing context. Validate passenger/segment associations and choices server-side. Whether either call is mandatory when no optional service is selected requires provider confirmation; do not fabricate empty calls for certification.
5. CreateItinerary is NOT implemented. Confirm exact host/path, casing, mandatory passenger/contact/document/GST fields, itinerary/pricing references, SSR/seat payload, totals, hold semantics and response schema before adding it. No inferred payload is permitted.
6. On an authentic successful response, validate and persist the EXACT returned TransactionId (including documented field spelling/type and precision) immediately with the booking, tenant, environment, operation/correlation and recorded exchange. Do not derive it from search TUI, OrderID, session ID or internal UUID. Existing supplierBookingRef and flightData JSON may be reusable; decide storage/uniqueness/atomicity after schema confirmation, before proposing any migration.
7. Timeout after CreateItinerary is an UNKNOWN outcome. No automatic replay. Obtain provider-supported idempotency/reconciliation contract; query status/retrieve using genuine supplier references where available.
8. StartPay may debit the provider account and book/ticket. It must remain disabled until separate explicit transaction authorization, provider contract and reconciliation safeguards exist. Client helper presence does not make it an approved workflow.
9. Poll GetItineraryStatus and RetrieveBooking using provider-confirmed ordering/status semantics. HTTP 200/transaction creation/payment success alone cannot set supplier confirmation. Store pending/failed/unknown distinctly from payment state; only authoritative confirmation and validated required PNRs establish CONFIRMED. Ticket numbers/evidence for all required passengers/segments establish TICKETED.
10. Capture a genuine exchange for every attempted call and transport failure, with timestamp, endpoint, method, environment, HTTP and business codes, duration, request/response correlation and booking/search link. Store provider responses before state promotion; retain pending/unknown on evidence persistence failure. Secrets never enter exports/UI. Sensitive originals need protected encrypted storage, audited access and provider-approved delivery. Logs must distinguish local mocks, sandbox and production; mocks never qualify for certification.

## Provider confirmations

Request a current sanitized CreateItinerary request/response example; exact TransactionId field/type, success/error/PNR/ticket paths; utility/flight hosts and path casing; mandatory SSR/seat/traveller fields; pricing TUI/OrderID lifetimes and fare-change rules; UAT airline/case requirements; authentication expiry/403 classification; polling limits and status meanings; duplicate/idempotency/unknown-outcome recovery; StartPay/hold/ticketing boundaries; approved redactions/certification log format; and whitelist activation/static egress confirmation. Do not include credential values in the repository or chat.

## Validation and next safe action

Local mock tests cover evidence redaction, retained actual transaction fields, blocked new Akbar checkout, blocked manual confirmation, and existing Akbar search/TripJack pricing/certification regressions. No production claims follow from local tests. Typechecks and the Admin validation build are local only; the build deliberately uses 127.0.0.1:9 and must never deploy.

Review this safety patch separately from PR #13. Do not merge/deploy either without approval. First obtain read-only incident evidence and the official booking schema; then implement the disabled provider-specific lifecycle and tests. Any historical status/data repair, live UAT booking, payment or certification submission requires separate approval.

Validation result for the prepared patch: 53/53 selected local mock/regression tests passed (Akbar evidence/search, TripJack reviewed totals and certification). API/Admin/supplier TypeScript checks and Next.js Admin production-format validation build passed. Runtime: Node 24.22.1; dependency installation used pnpm 11.25.0 after pinned Corepack tooling was unavailable; repository lockfile and package metadata are unchanged. Node 22/pinned-pnpm release CI, rendered Admin QA and production incident verification remain outstanding. No assertion of full booking-lifecycle readiness is made.
