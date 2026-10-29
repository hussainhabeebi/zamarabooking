# PhonePe sandbox on isolated staging (Neon staging branch ledger)

Everything here is **staging + PhonePe sandbox only**. Production Workers, the production Neon branch and the production PhonePe account are not touched. The staging API keeps its PhonePe ledger in the Neon `phonepe-staging` branch, exactly like production will. The D1 database `zamra-phonepe-staging` belongs only to the separate sandbox harness (`docs/phonepe-d1-sandbox-harness.md`).

Never paste secrets into chat, files or the repo.

## 1. Cloudflare staging resources (already created)

These already exist: KV `zamra-staging-sessions`, `zamra-staging-tenant-cache`, `zamra-staging-fare-cache`, and queues `zamra-bookings-staging`, `zamra-notifications-staging`. Their ids are in `apps/api/wrangler.staging.toml`. The staging API has no D1 binding.

## 2. Neon `phonepe-staging` branch: schema, permissions, sandbox data

`phonepe-staging` is a **schema-only** branch: production's structure, no data. Open **Neon Console → SQL Editor** and set the **branch selector to `phonepe-staging`** before every script. The scripts are in `docs/migrations/`; open each on GitHub (PR #26 branch), copy the whole file, paste and **Run**.

| Step | Script | Writes? | Safety |
|---|---|---|---|
| 1 | `phonepe-staging-1-preflight.sql` | No | Shows role, row counts (all 0), dependencies, `phonepe_staging` privileges, schema fingerprint |
| 2 | `phonepe-staging-2-apply.sql` | Yes, once | One transaction; refuses on any branch containing tenants, bookings or payments; body is exactly `phonepe-pg-v2-proposed.sql` (CI-checked) |
| 3 | `phonepe-staging-3-verify.sql` | No | `PHONEPE` value, 3 empty tables, constraints/indexes, existing-schema fingerprint, app-role privileges |
| 4 | `phonepe-staging-4-grants-if-needed.sql` | Only if step 3 shows `false` | Grants the staging API role table access; refuses once any data exists |
| 5 | `phonepe-staging-5-seed-sandbox.sql` | Yes | `zamra` tenant (same insert as migration 0002) + 3 test bookings with no customer/contact/supplier booking; refuses any non-sandbox data |

The schema fingerprint lines from step 1 (`tables`, `columns`, `columns_md5`, `indexes`, `indexes_md5`) must be **identical** in step 3. That proves no existing table, column or index changed. If step 2 fails it rolls back completely; send me the error. Never run any of these on the production branch: steps 2, 4 and 5 refuse a branch with data, but select the branch carefully anyway.

Keep the `tenant_id` printed by step 5 for `PHONEPE_TENANT_ID`. Delete the branch after acceptance.

## 3. Staging secrets and settings

Secrets (each command prompts for the value):

```bash
wrangler secret put DATABASE_URL --config wrangler.staging.toml
```

Use the **phonepe-staging branch** connection string with the `phonepe_staging` role, never production. Then set a new staging-only `JWT_SECRET` and the PhonePe **sandbox** values:

```bash
wrangler secret put JWT_SECRET --config wrangler.staging.toml
```

```bash
wrangler secret put PHONEPE_CLIENT_ID --config wrangler.staging.toml
```

```bash
wrangler secret put PHONEPE_CLIENT_SECRET --config wrangler.staging.toml
```

```bash
wrangler secret put PHONEPE_CLIENT_VERSION --config wrangler.staging.toml
```

```bash
wrangler secret put PHONEPE_MERCHANT_ID --config wrangler.staging.toml
```

```bash
wrangler secret put PHONEPE_WEBHOOK_USERNAME --config wrangler.staging.toml
```

```bash
wrangler secret put PHONEPE_WEBHOOK_PASSWORD --config wrangler.staging.toml
```

Do **not** set email, WhatsApp, supplier, Nomod or Razorpay secrets on staging.

In `wrangler.staging.toml` `[vars]`, set `PHONEPE_TENANT_ID` (the tenant id above) and `PHONEPE_RETURN_ORIGIN` (the staging web origin, step 4). Leave the release gates commented until step 5.

## 4. Deploy staging Workers

```bash
wrangler deploy --config wrangler.staging.toml
```

Note the `https://zamra-api-staging.<subdomain>.workers.dev` URL. Check it reports staging:

```bash
curl -s https://zamra-api-staging.<subdomain>.workers.dev/health
```

Staging website (return page). From `apps/web`, build against the staging API and deploy under a separate name:

```bash
NEXT_PUBLIC_API_URL=https://zamra-api-staging.<subdomain>.workers.dev pnpm exec opennextjs-cloudflare build --dangerouslyUseUnsupportedNextVersion
```

```bash
pnpm exec wrangler deploy --config wrangler.jsonc --name zamra-web-staging --var NEXT_PUBLIC_API_URL:https://zamra-api-staging.<subdomain>.workers.dev
```

Its workers.dev URL is `PHONEPE_RETURN_ORIGIN`.

Staging Admin. From `apps/admin`, build against the staging API and deploy under a separate name:

```bash
NEXT_PUBLIC_API_URL=https://zamra-api-staging.<subdomain>.workers.dev API_BASE_URL=https://zamra-api-staging.<subdomain>.workers.dev pnpm exec opennextjs-cloudflare build
```

```bash
pnpm exec wrangler deploy --config wrangler.jsonc --name zamra-admin-staging
```

Log in with a staging-branch admin account. Copy the `zamra_admin_token` cookie value: that is `STAGING_ADMIN_TOKEN` for step 6.

## 5. PhonePe sandbox dashboard

- Confirm **direct merchant** Standard Checkout (PG V2) sandbox credentials.
- Webhook: URL `https://zamra-api-staging.<subdomain>.workers.dev/webhooks/phonepe`, **SHA256 (username/password)** mode, the same username/password as the staging secrets, events `checkout.order.completed`, `checkout.order.failed`, `pg.refund.completed`, `pg.refund.failed`.

Then turn on the staging gates in `wrangler.staging.toml` (`PHONEPE_SCHEMA_READY`, `PHONEPE_MERCHANT_ACTIVE`, `PHONEPE_RELEASE_APPROVED` = `"true"`), redeploy staging, and in **staging** Admin enable PhonePe (Settings → PhonePe).

## 6. Run the sandbox acceptance

From the repo root, in a shell where you export the staging values (`STAGING_API_URL`, `STAGING_JWT_SECRET`, `STAGING_ADMIN_TOKEN` from a staging Admin login, `STAGING_WEBHOOK_USERNAME`, `STAGING_WEBHOOK_PASSWORD`, `TENANT_ID`):

```bash
node scripts/phonepe-sandbox-acceptance.mjs preflight
```

```bash
node scripts/phonepe-sandbox-acceptance.mjs pay phonepe-sbx-0001
```

Open the printed PhonePe sandbox page and complete the payment with PhonePe's sandbox test instrument.

```bash
node scripts/phonepe-sandbox-acceptance.mjs refund phonepe-sbx-0001
```

```bash
node scripts/phonepe-sandbox-acceptance.mjs webhook phonepe-sbx-0001
```

```bash
node scripts/phonepe-sandbox-acceptance.mjs fail phonepe-sbx-0002
```

On the sandbox page for 0002, cancel or fail the payment.

The script checks:
- checkout idempotency (a repeat returns the same order);
- one gateway per booking (Nomod refused before and after the outcome);
- reconciled state, and the ledger status shown to the customer;
- that the supplier booking is **not** auto-confirmed;
- partial refund, replay of the same refund request (no second debit), over-refund refusal, full refund;
- webhook authentication and that a forged payload can't change the ledger.

Results go to `phonepe-sandbox-report.json` (ids and pass/fail only). Also confirm, in the PhonePe sandbox dashboard webhook log, that genuine deliveries for these orders returned HTTP 200.

## 7. Verify the ledger directly (Neon staging branch) and in Admin

In the Neon SQL editor with `phonepe-staging` selected:

```sql
SELECT o.booking_id, o.state, o.amount_minor, o.refund_reserved_minor, p.status, p.refunded_amount, o.transaction_id FROM phonepe_orders o JOIN payments p ON p.id = o.payment_id ORDER BY o.updated_at;
```

```sql
SELECT merchant_order_id, amount_minor, state, provider_refund_id FROM phonepe_refunds;
```

```sql
SELECT booking_id, gateway FROM payment_checkout_claims WHERE booking_id LIKE 'phonepe-sbx-%';
```

```sql
SELECT booking_id, count(*) FROM payments WHERE booking_id LIKE 'phonepe-sbx-%' GROUP BY booking_id;
```

Expected:
- 0001: order `COMPLETED`, payments `REFUNDED`, refunded `2.00`, two `COMPLETED` refunds.
- 0002: order `FAILED`, payments `FAILED`.
- Each test booking has exactly one claim (`PHONEPE`) and **one** payments row.

In staging Admin, open each booking:
- the Payments tab shows the `PHONEPE` payment once;
- the bookings list shows the PhonePe badge;
- Finance shows the sandbox receipts separately from revenue;
- "Retry airline booking" is not offered for the paid booking.

Send me `phonepe-sandbox-report.json` and the four query outputs. They contain no secrets.
