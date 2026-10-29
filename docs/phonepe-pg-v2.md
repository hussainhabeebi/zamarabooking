# PhonePe PG V2 Standard Checkout — disabled release preparation

No merchant credentials were used, provisioned, printed or committed. No provider requests, payments, refunds, production data/schema/configuration changes, merges or deployments were executed. Tests use mocks, disposable PostgreSQL and in-memory D1 only.

## Architecture (approved Phase 1): Neon is the single production ledger; D1 is sandbox-only

| Data | Store | Notes |
|---|---|---|
| Bookings, Nomod/Razorpay/wallet payments, suppliers | Neon (unchanged) | Existing rows are never modified by the PhonePe schema |
| PhonePe payment | Neon `payments` (gateway `PHONEPE`) | **Exactly one row per PhonePe order**; cancellations, trips, Admin and finance see it with no special path |
| PhonePe provider state and idempotency | Neon `phonepe_orders` (1:1 with that payments row) | Provider ids/state only; the money figure is the payments row |
| PhonePe refunds | Neon `phonepe_refunds` | Refund caps and `payments.refunded_amount` updated in the **same transaction** |
| One gateway per booking | Neon `payment_checkout_claims` | Same database as legacy payment rows; no extra dependency for Nomod/Razorpay/wallet |
| Sandbox harness, synthetic bookings | D1 `zamra-phonepe-staging` | `zamra-phonepe-sandbox` Worker only; never production data |

One code path, two stores: `PhonePeService`, `PhonePeClient`, the webhook verifier and `reconcilePhonePe` are shared. Behind the `PhonePeStore` contract (`lib/phonepe/store.ts`):
- the production API constructs only `PhonePeNeonStore` (`store-neon.ts`);
- the harness constructs only `PhonePeD1Store` (`store-d1.ts`).

Nothing is written to both stores, and production has no D1 binding.

- **Atomicity:** every PhonePe write is one Neon batch, which is one transaction with the neon-http driver. Refund completion locks the order row first, so concurrent completions can't lose an aggregate.
- **Idempotency:** stable merchant order/refund IDs and one order per booking. `INSERT … ON CONFLICT DO NOTHING RETURNING` picks a single owner who may call PhonePe. Unknown outcomes stay `UNKNOWN` and are never blindly retried.
- **Reconciliation:** monotonic, so late `PENDING`/`FAILED` evidence never downgrades `COMPLETED`. Webhooks only queue an authenticated status read (`PHONEPE_RECONCILE`), and the webhook payload is never settlement evidence.
- **Supplier separation:** a PhonePe payment never confirms a booking or starts a supplier booking. The generic `PAYMENT_CAPTURED` path, paid-booking recovery and the Admin "Retry airline booking" action all refuse PhonePe payments. Akbar PhonePe checkout stays blocked.

### Double-refund protections
- A cancellation of a PhonePe-paid booking gets refund method `PHONEPE` and `MANUAL_REQUIRED`: "refund it in Admin → Settings → PhonePe refunds". It is never a wallet credit or an untracked manual refund. This also holds for an already partly refunded payment (status `PARTIAL_REFUND`).
- Admin "Mark refunded manually" is refused (409) for a PhonePe payment unless PhonePe-confirmed refunds (`phonepe_refunds` `COMPLETED`) already cover the amount. Once allowed, it does not touch the PhonePe `payments` row, which only confirmed PhonePe refunds update.
- PhonePe refunds are capped at the captured amount by a row-serialized reservation, use stable IDs, and are completed only from PhonePe's status response.
- Refunds made outside ZamraBooking (for example directly in the PhonePe dashboard) can't be seen here; operate refunds only through Admin.

## Neon schema (development and staging only until separately approved)

`docs/migrations/phonepe-pg-v2-proposed.sql` adds `PHONEPE` to `payment_gateway` and creates the three tables above. It is deliberately outside `packages/db/drizzle/migrations`, so no automatic migration can apply it; CI fails if an automatic migration is added. CI applies it on top of migrations 0001–0012 in a disposable database. It must change only the enum list, it is atomic, and a second run fails without changes. **Approved for development and Neon staging validation, not production.** Before production:
- take a Neon restore point;
- get separate approval.

`ALTER TYPE … ADD VALUE` can't be removed. Rollback keeps the schema and disables PhonePe.

## Configuration (names only)

Worker secrets (fresh per environment): `PHONEPE_CLIENT_ID`, `PHONEPE_CLIENT_SECRET`, `PHONEPE_CLIENT_VERSION`, `PHONEPE_MERCHANT_ID`, `PHONEPE_WEBHOOK_USERNAME`, `PHONEPE_WEBHOOK_PASSWORD`.

Settings:
- `PHONEPE_TENANT_ID` (exact tenant ID);
- `PHONEPE_ENVIRONMENT` (`sandbox`|`production`);
- `PHONEPE_RETURN_ORIGIN` (HTTPS origin only; production defaults to https://zamrabooking.com).

Release gates (all default off; every one required):
- `PHONEPE_SCHEMA_READY=true`: the Neon schema above is applied and verified for that environment. Until then, Nomod/Razorpay/wallet behave exactly as before and touch no new table.
- `PHONEPE_MERCHANT_ACTIVE`, `PHONEPE_RELEASE_APPROVED`, and `PHONEPE_PRODUCTION_APPROVED` (production).
- Then Admin opt-in. A production Worker can't expose sandbox checkout.

## Routes
- **`POST /api/payments/checkout` with `gateway=PHONEPE`:** checkout for the booking.
- **`POST /api/payments/phonepe/reconcile` `{bookingId}`:** status check for the booking owner.
- **`POST /webhooks/phonepe`:** PhonePe webhook (SHA username/password).
- **Admin, full admins only:**
  - `GET/PUT /api/admin/settings/phonepe` and `GET /api/admin/settings/phonepe/orders`;
  - `POST /api/admin/settings/phonepe/refunds` `{merchantOrderId, requestId (UUID), amountMinor}`;
  - `POST /api/admin/settings/phonepe/refunds/:merchantRefundId/reconcile`.

Admin reporting reads only Neon:
- the bookings list shows a "PhonePe <status>" badge;
- booking detail shows the single PhonePe payments row and a "paid with PhonePe — supplier booking is manual" banner;
- Finance shows PhonePe receipts/refunds separately and never adds them to booking revenue.

## Tests (CI: `.github/workflows/phonepe-safety-ci.yml`, Node 22)
- **`phonepe-postgres.test.ts`:** production Neon store on disposable PostgreSQL 16, run twice (node-postgres, then the production `drizzle-orm/neon-http` client through an in-process shim). Covers:
  - concurrent checkouts → one owner/order/payments row, and atomic rollback;
  - competing gateway claims, and the legacy claim (no-op when off, blocks a live PhonePe payment);
  - duplicate and partial refunds, concurrent completions and stale events;
  - monotonic events, overflow limits, tenant constraints;
  - the one-payments-row invariant, and the completed-refund total used by the guard.
- **Migration chain check:** the additive DDL on 0001–0012.
- **`phonepe-refund-guards.test.ts`:**
  - the PhonePe cancellation refund method, and the "mark refunded manually" guard;
  - legacy manual refunds unchanged;
  - Admin list/detail/retry and Finance from Neon.
- **`phonepe.test.ts`** (mocked provider): gates, Admin secrecy, exact paise, OAuth, SHA webhook, evidence, unknown outcomes, refunds, queue exclusion, unchanged Nomod/Razorpay checkout.
- **`phonepe-d1.test.ts`, `phonepe-sandbox-harness.test.ts`:** the sandbox store and harness on local workerd D1.

## Sandbox and staging
- **D1-only sandbox harness, no Neon:** `docs/phonepe-d1-sandbox-harness.md`. Genuine PhonePe sandbox payments, webhooks, reconciliation, refunds and claims with synthetic bookings.
- **Full staging with real booking checks:** `docs/phonepe-sandbox-staging.md`. Neon branch `phonepe-staging` with the schema applied, a staging API (`wrangler.staging.toml`, no D1), staging web/Admin, and `scripts/phonepe-sandbox-acceptance.mjs`. The branch holds copies of real customer data: give staging no email, WhatsApp, supplier, Nomod or Razorpay credentials.

## Release and rollback (each step needs separate approval)
1. Pass sandbox acceptance on staging, and agree the pending-supplier-fulfillment and reconciliation-alert process.
2. Protect `main` (required checks, deployment approval). Merging auto-deploys `zamra-web`, which is backward compatible.
3. Record current `zamra-api`/`zamra-admin`/`zamra-web` versions.
4. Take a Neon restore point, then apply the additive schema in production.
5. Deploy the API with PhonePe gates off and verify existing gateways. Then deploy Admin.
6. Merchant activation, production secrets/gates, Admin opt-in.
7. One approved small live transaction, verified in the PhonePe dashboard, Neon `payments`/`phonepe_orders`, and Admin.

**Rollback:** disable PhonePe in Admin (or unset `PHONEPE_RELEASE_APPROVED`). Reconciliation continues while secrets remain. Never drop the PhonePe tables or delete ledger rows. Never roll the API back to a build that lacks the PhonePe exclusions while PhonePe payments exist.

Production remains NO-GO until these pass.
