# PhonePe PG V2 Standard Checkout — disabled release preparation

## Implemented scope

Prepared on `feature/phonepe-pg-v2` from main d05641ac9f8a9f3287cfb355f3b9e3eb50f0b360. No merchant credentials were used, provisioned, printed or committed. No provider requests, payments, refunds, production data/schema/configuration changes, merges or deployments were executed. Tests use local fixtures/mocks only.

- Direct-merchant PG V2 OAuth, hosted checkout, order status, refund and refund status endpoints. Production OAuth uses the identity-manager host; sandbox uses pg-sandbox. No V1 salt/X-VERIFY implementation.
- Environment/tenant/credential-isolated, expiry-aware memory token cache with coalesced authentication. Credentials/tokens never enter Admin/frontend, KV settings or logs. Fixed upstream HTTPS hosts, redirect rejection, timeouts, response/body limits and sanitized error codes.
- Server-owned INR amount converted exactly to paise; minimum ₹1, internal integer-column maximum ₹21,474,836.47. No currency relabelling/conversion, browser-supplied amounts or browser-supplied return URLs.
- Hosted checkout URL comes only from the authenticated PhonePe response, validated as HTTPS on a PhonePe subdomain. The redirect page never treats a URL result as authoritative PhonePe payment success.
- Durable one-order-per-booking reservation before the provider POST, stable merchant order ID and ledger linkage. Lost/malformed responses stay UNKNOWN; no blind creation retry. Repeated checkouts reuse the existing session or stay pending for reconciliation.
- Shared per-booking gateway choice prevents simultaneous hosted-gateway, queued legacy initiation and customer/agency wallet requests choosing different providers once the schema flag is approved. Claims are not automatically cleared. Existing legacy provider request bodies, default settings and refunds are unchanged. Prior pending/successful competing payments block new PhonePe checkout.
- SHA webhook verification using constant-work SHA256(username:password) comparison. The listener rejects unknown merchant/orders and queues only a status read on the existing booking queue. Webhook state/amount are NEVER settlement evidence. Duplicate notifications/queue deliveries are safe; late failure/pending responses cannot downgrade a completed payment.
- Authenticated reconciliation validates order, exact amount and successful payment transaction ID. Ledger payment success remains separate from supplier booking: no booking status update, supplier operation, reward, confirmation notification or PAYMENT_CAPTURED enqueue. Generic queue/recovery paths explicitly exclude PhonePe, including stalled customer-page recovery. Akbar PhonePe checkout is blocked independently of PR #25.
- Admin-only partial/full refund initiation with stable request IDs, one-statement PostgreSQL bounded reservations and duplicate-ID handling. Pending/unknown refunds are not labelled complete. Refund completion requires status retrieval with matching order, amount and real provider refund ID. Completed refunds roll up into the existing payment ledger. Failed/unknown reservations are conservatively retained pending owner review, not automatically released/retried.
- Full admins get a PhonePe readiness panel in Settings. It accepts only an enabled boolean; credential/approval fields from browser input are rejected. No connection-test button or network request runs merely by opening/saving Admin settings. Dedicated refund APIs are prepared; existing cancellation flows are not automatically connected to PhonePe refunds.

## Official documentation reviewed, 29 October 2026

All below are PhonePe's Standard Checkout website API references:
- https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/authorization
- https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/create-payment
- https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/order-status
- https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/webhook
- https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/refund

This implementation supports the documented **SHA username/password webhook mode**, not HMAC. PhonePe's HMAC description does not fully specify checksum encoding here; do not configure that mode against this listener without a separately verified implementation. Partner integrations requiring X-MERCHANT-ID delegation are outside scope: confirm these are direct merchant credentials before UAT.

## Backend configuration requirements (names only)

Provision fresh authorized environment-specific values in protected backend secret storage:
- PHONEPE_CLIENT_ID, PHONEPE_CLIENT_SECRET, PHONEPE_CLIENT_VERSION
- PHONEPE_MERCHANT_ID
- PHONEPE_WEBHOOK_USERNAME, PHONEPE_WEBHOOK_PASSWORD (separate strong webhook credentials; Dashboard SHA mode)

Explicit backend configuration:
- PHONEPE_TENANT_ID: exact server tenant ID, not slug or caller input.
- PHONEPE_ENVIRONMENT: sandbox or production, with no custom upstream host.
- PHONEPE_RETURN_ORIGIN: an approved HTTPS origin. Sandbox requires an explicit isolated preview origin; production defaults to https://zamrabooking.com. Only an origin with no credentials/path/query/hash is accepted.

All release gates default off:
- PHONEPE_SCHEMA_READY=true only after the separately approved proposal has been reviewed/applied/verified.
- PHONEPE_MERCHANT_ACTIVE=true only after provider activation/entitlement confirmation for the selected environment.
- PHONEPE_RELEASE_APPROVED=true only after release approval and test gates pass.
- PHONEPE_PRODUCTION_APPROVED=true additionally required for production PhonePe.
- A production application Worker cannot expose sandbox checkout.
- Admin must explicitly enable PhonePe after all backend gates pass.

Disabling the Admin switch stops new checkout/refund requests. Existing-order reconciliation/webhooks can continue while the backend release/schema/merchant gates and secrets remain valid. No production secrets or flags were configured by this task.

## Proposed schema — separate approval required

`docs/migrations/phonepe-pg-v2-proposed.sql` is deliberately OUTSIDE `packages/db/drizzle/migrations`, so the legacy migration glob cannot apply it accidentally. It adds PHONEPE to payment_gateway and creates phonepe_orders, phonepe_refunds and payment_checkout_claims. Drizzle schema is prepared. No existing production rows are backfilled or changed here. Do not run db:push/generate/migrate or the legacy full-platform workflow as part of reviewing this PR.

Durability depends on this schema; KV alone is not used as a money/idempotency lock. Before release, validate the proposal and repository queries against an isolated PostgreSQL/Neon database, including concurrent duplicate requests, rollback after unique violations, refund reservation limits and partial-write recovery. Current mock tests do not establish cross-session database isolation. Existing applications may run with PhonePe disabled before schema approval: the legacy recovery filter compares gateway::text, avoiding an enum-value error before PHONEPE exists in the database.

A booking chooses one gateway while this feature is active. To switch gateways after a failure/expiry, reconcile all original provider orders first and use a separately reviewed owner procedure or a new booking. No automatic unlock/delete endpoint is supplied. Unknown checkout/refund outcomes retain their references/reservations. Automated scheduled polling is not added; webhooks, signed-customer return polling and authorized Admin reconciliation are the prepared recovery paths. Review a reconciliation sweep/dead-letter alert process before production activation.

## Prepared routes

- POST /api/payments/checkout with gateway=PHONEPE uses the existing signed checkout token/ownership check and database amount.
- POST /api/payments/phonepe/reconcile with bookingId: authenticated owner/checkout scope only.
- POST /webhooks/phonepe: exact configured merchant and SHA authentication; queue status reads only.
- GET/PUT /api/admin/settings/phonepe: full admins, metadata/enable only.
- POST /api/admin/settings/phonepe/refunds with merchantOrderId, requestId (UUID), amountMinor (integer paise): full admins, gates enforced.
- POST /api/admin/settings/phonepe/refunds/:merchantRefundId/reconcile: full admins.

Do not invoke transaction endpoints against real services under this preparation authorization. PhonePe's refund webhook samples vary in wrapping/correlation fields; uncorrelated/unsigned/mismatched events are rejected. Confirm the account's actual configured event shape during separately authorized sandbox testing. Admin status reconciliation is the fallback; never guess a missing reference.

## Supplier and rollback safety

PhonePe only records funds. Supplier fulfillment remains pending until a separately reviewed supplier operation establishes confirmation/PNRs/tickets. This intentionally does not reuse the unsafe payment-to-confirmation path. Nomod/Razorpay behavior and supplier adapters are preserved. PR #25 is separate and remains unmerged; this PR does not claim to repair historical Akbar/Nomod records or all existing supplier lifecycle defects.

Rollback must retain the PhonePe queue/recovery exclusion guards while any PhonePe ledger rows exist. Do NOT roll API back to a legacy build that can consume PhonePe payments as generic PAYMENT_CAPTURED jobs. Stop new checkout via Admin, retain status reconciliation and inspect outstanding orders/refunds. Additive schema and ledger data must remain; do not drop the enum/tables or delete financial records. Record compatible API/Admin/Web versions and review this rollback plan before release. No production rollback was executed.

## Validation / outstanding release blockers

Local Node 22 mock tests cover gates, secret-safe Admin settings, exact paise, token handling, webhook verification, amount/reference mismatch, duplicate/concurrent checkout, unknown outcomes, refund limits/replays, gateway-choice conflicts, generic supplier-queue exclusion and unchanged Nomod request behavior. Supplier regressions, API/Admin/Web/DB TypeScript and Admin/Web production-format validation builds are run. Builds use 127.0.0.1:9 and must never deploy. PR-only CI has no secrets, migrations or deployment commands.

Outstanding: isolated PostgreSQL concurrency/integration validation; sandbox merchant activation and environment/credentials confirmation; approved SHA webhook registration and event-shape validation; approved preview/return origin; authorized sandbox payment/refund exercises and rendered checkout/Admin QA; operations reconciliation/dead-letter/rollback review; separate schema and deployment approval. Production remains NO-GO. No real transactions were executed to clear these gates.
