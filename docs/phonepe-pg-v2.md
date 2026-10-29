# PhonePe PG V2 Standard Checkout — disabled release preparation

No merchant credentials were used, provisioned, printed or committed. No provider requests, payments, refunds, production data/schema/configuration changes, merges or deployments were executed. Tests use local fixtures, mocks and a local in-memory D1 only.

## Architecture: PhonePe ledger in Cloudflare D1, bookings stay in Neon

| Data | Store | PhonePe access |
|---|---|---|
| Bookings, users, Nomod/Razorpay/wallet payments, suppliers | Neon PostgreSQL (unchanged) | Read only (ownership, status, INR amount) |
| PhonePe orders, refunds, refund reservations/totals | D1 `PHONEPE_DB` | Read/write |
| Shared one-gateway-per-booking claims | D1 `PHONEPE_DB` | Read/write (legacy gateways too, only when `PHONEPE_SCHEMA_READY=true`) |

- **No Neon schema change, migration or backfill.** `packages/db` is identical to `main`; CI fails if it changes. PhonePe never writes Neon, so there is no cross-database write to reconcile and no Neon enum value is needed.
- D1 migration: `apps/api/migrations/phonepe-d1/0001_phonepe_ledger.sql` (new tables only). Applied with `wrangler d1 migrations apply`, which runs it as one transaction.
- Atomicity: D1 runs each `batch()` as one transaction on a single writer. Refund reservation inserts only while the bound fits and adds exactly that amount in the same batch; a duplicate refund ID aborts the batch. CHECK constraints (`refund_reserved_minor <= amount_minor`, `refunded_minor <= refund_reserved_minor`) and a tenant-consistent refund foreign key back this up.
- Idempotency: one order per tenant/booking (`UNIQUE`), deterministic merchant order/refund IDs, `INSERT OR IGNORE … RETURNING` picks a single owner who may call PhonePe; unknown outcomes stay `UNKNOWN` and are never blindly retried.
- Reconciliation is monotonic: late `PENDING`/`FAILED` evidence never downgrades `COMPLETED`. Webhooks only queue an authenticated status read (`PHONEPE_RECONCILE`); webhook state/amount is never settlement evidence.
- Customer status: `GET /api/payments/:bookingId` returns the D1 ledger status (`SUCCESS`/`PARTIAL_REFUND`/`REFUNDED`/`FAILED`/`PENDING`) when Neon has no payment row and the schema gate is set. Admin → Settings → PhonePe lists recent D1 orders (read-only).
- **Payment never confirms a supplier booking.** No Neon booking update, supplier call, reward, confirmation notification or `PAYMENT_CAPTURED` message. Captured PhonePe bookings remain pending for a separately reviewed supplier operation. Akbar PhonePe checkout stays blocked.
- Legacy Nomod/Razorpay/wallet flows are unchanged while `PHONEPE_SCHEMA_READY` is unset. Once set, they first take the D1 gateway claim and fail closed (503) if the D1 binding is missing.

Official references reviewed 29 October 2026 (Standard Checkout website API): authorization, create-payment, order-status, webhook and refund pages under https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/. SHA username/password webhook mode only (not HMAC); direct merchant credentials only (no partner `X-MERCHANT-ID`).

## Configuration (names only)

Worker secrets (`wrangler secret put`, per environment, fresh values): `PHONEPE_CLIENT_ID`, `PHONEPE_CLIENT_SECRET`, `PHONEPE_CLIENT_VERSION`, `PHONEPE_MERCHANT_ID`, `PHONEPE_WEBHOOK_USERNAME`, `PHONEPE_WEBHOOK_PASSWORD`.

Worker settings: `PHONEPE_TENANT_ID` (exact tenant ID), `PHONEPE_ENVIRONMENT` (`sandbox`|`production`), `PHONEPE_RETURN_ORIGIN` (HTTPS origin only; production defaults to https://zamrabooking.com).

Binding: `PHONEPE_DB` (D1). Absent → PhonePe disabled.

Release gates (all default off; every one required):
- `PHONEPE_SCHEMA_READY=true` after the D1 migration is applied and verified for that environment.
- `PHONEPE_MERCHANT_ACTIVE=true` after PhonePe confirms activation for that environment.
- `PHONEPE_RELEASE_APPROVED=true` after release approval and sandbox acceptance.
- `PHONEPE_PRODUCTION_APPROVED=true` additionally for production. A production Worker cannot expose sandbox checkout.
- Admin must then enable PhonePe. Disabling it stops new checkout/refunds; reconciliation of existing orders continues.

## Routes

- `POST /api/payments/checkout` with `gateway=PHONEPE` (signed checkout token; server-owned INR amount).
- `POST /api/payments/phonepe/reconcile` `{bookingId}` (owner/checkout scope).
- `POST /webhooks/phonepe` (exact merchant + SHA authorization; queues status reads only).
- `GET/PUT /api/admin/settings/phonepe`, `GET /api/admin/settings/phonepe/orders`, `POST /api/admin/settings/phonepe/refunds` `{merchantOrderId, requestId (UUID), amountMinor}`, `POST /api/admin/settings/phonepe/refunds/:merchantRefundId/reconcile` (full admins).

## Tests (CI: `.github/workflows/phonepe-safety-ci.yml`, Node 22)

- `apps/api/test/phonepe-d1.test.ts`: production store against local workerd D1 (wrangler `getPlatformProxy`, in memory) with the production migration: atomic re-apply refusal, 16 concurrent checkouts → one owner, second order per booking refused, competing gateway claims, legacy claim no-op/fail-closed, 20 duplicate refunds → one debit, partial refunds bounded, refunds refused before completion, concurrent completions + stale events, monotonic payment events, overflow-safe limits, cross-tenant FK and CHECK constraints.
- `apps/api/test/phonepe.test.ts` (mocked provider): gates incl. D1 binding, Admin secrecy, exact paise, OAuth, SHA webhook, evidence checks, unknown outcomes, refunds, queue exclusion, D1 status endpoint, unchanged Nomod/Razorpay checkout.
- Local D1 is Cloudflare's workerd engine, not the hosted service; staging validates the hosted D1.

## Admin reporting

PhonePe payments exist once, in D1. Admin merges them at read time when `PHONEPE_SCHEMA_READY=true`; nothing is copied into Neon.
- **Bookings list:** a "PhonePe <status>" badge.
- **Booking detail:**
  - the Payments tab shows `PHONEPE (D1)` rows beside Neon gateway rows;
  - a banner for paid PhonePe bookings says supplier booking is manual;
  - "Retry airline booking" is refused (409) for PhonePe-paid bookings.
- **Finance:** PhonePe receipts/refunds for the configured environment are shown separately from booking-based revenue and never added to it.

If D1 can't be read, the pages say so instead of hiding payments silently. While the gate is off, no D1 read happens.

## Cloudflare staging (sandbox only)

Step-by-step commands and the sandbox acceptance script: `docs/phonepe-sandbox-staging.md`, `scripts/phonepe-sandbox-acceptance.mjs`. `apps/api/wrangler.staging.toml` defines `zamra-api-staging` on workers.dev with its own KV, queues and D1 `zamra-phonepe-staging`, no custom domain and no cron. `DATABASE_URL` must point at the Neon `phonepe-staging` branch. That branch contains copies of real customer data: give staging NO email, WhatsApp, supplier, Nomod or Razorpay credentials. A staging web Worker (separate name, `NEXT_PUBLIC_API_URL` = staging API URL) serves `PHONEPE_RETURN_ORIGIN`.

## Release and rollback

1. Sandbox acceptance on staging (payment success/failure/expiry, webhook retry/replay, reconciliation, partial/full refunds, unknown-outcome recovery).
2. Protect `main` (required checks, deployment approval). Merging triggers the automatic `zamra-web` deploy; the web change is backward compatible (PhonePe shows only when the API enables it).
3. Record current `zamra-api`/`zamra-admin`/`zamra-web` versions.
4. Create production D1 `zamra-phonepe`, apply its migration (separate approval), uncomment the binding in `wrangler.toml`.
5. Deploy API with all PhonePe gates off; verify Nomod/existing flows. Then Admin.
6. Set production secrets/gates after merchant activation; Admin opt-in; one approved small live transaction verified in the PhonePe dashboard, D1 (`wrangler d1 execute zamra-phonepe --remote --command "SELECT …"`) and Admin.

Rollback: disable PhonePe in Admin (or unset `PHONEPE_RELEASE_APPROVED`); reconciliation continues while the binding and secrets remain. Never delete the D1 database or ledger rows. Rolling the API back to a build without PhonePe is safe for Neon (PhonePe never wrote Neon) but stops reconciliation, so reconcile or record outstanding D1 orders/refunds first. Do not remove the D1 binding while orders are unsettled.

Outstanding before activation: Cloudflare staging resources, Neon staging branch, sandbox credentials and acceptance, merchant activation, branch protection, production D1 creation/migration approval, release approvals, and an approved pending-supplier-fulfillment and reconciliation-alert process. Production remains NO-GO until these pass.
