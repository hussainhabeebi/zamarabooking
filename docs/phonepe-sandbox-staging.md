# PhonePe sandbox on isolated Cloudflare D1 staging

Everything here is **staging + PhonePe sandbox only**. Production Workers, the production Neon branch, production D1 and the production PhonePe account are not touched. Run commands from `apps/api` on your own machine, logged in with `wrangler login`. Never paste secrets into chat, files or the repo: `wrangler secret put` prompts for them.

## 1. Cloudflare staging resources

```bash
wrangler d1 create zamra-phonepe-staging
```

```bash
wrangler kv namespace create zamra-staging-sessions
```

```bash
wrangler kv namespace create zamra-staging-tenant-cache
```

```bash
wrangler kv namespace create zamra-staging-fare-cache
```

```bash
wrangler queues create zamra-bookings-staging
```

```bash
wrangler queues create zamra-notifications-staging
```

Put the printed D1 and KV ids into `wrangler.staging.toml` (replace each `<...>`). Then apply the D1 migration to the **staging** database and confirm the tables:

```bash
wrangler d1 migrations apply zamra-phonepe-staging --remote --config wrangler.staging.toml
```

```bash
wrangler d1 execute zamra-phonepe-staging --remote --config wrangler.staging.toml --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Expected: `d1_migrations`, `payment_checkout_claims`, `phonepe_orders`, `phonepe_refunds`.

## 2. Neon staging branch and test bookings

In the Neon Console create branch `phonepe-staging` from production (current point in time). With **that branch selected** in the SQL editor, look up the tenant id:

```sql
SELECT id FROM tenants WHERE slug = 'zamra';
```

Create three ₹2 test bookings (MANUAL supplier, no contact details, so nothing can email a customer or book a supplier):

```sql
INSERT INTO bookings (id, tenant_id, channel, status, trip_type, origin, destination, departure_date,
  flight_data, base_fare, taxes, total_amount, currency, supplier)
SELECT 'phonepe-sbx-000' || n, t.id, 'B2C_WEB', 'PAYMENT_PENDING', 'ONEWAY', 'COK', 'DXB',
  now() + interval '30 days', '{"phonepeSandboxTest": true}', 2.00, 0, 2.00, 'INR', 'MANUAL'
FROM tenants t, generate_series(1, 3) AS n WHERE t.slug = 'zamra';
```

Bookings: `phonepe-sbx-0001` (successful payment + refunds), `phonepe-sbx-0002` (failed/cancelled payment), `phonepe-sbx-0003` (spare, e.g. expiry). Delete the branch after acceptance.

## 3. Staging secrets and settings

Secrets (each command prompts for the value):

```bash
wrangler secret put DATABASE_URL --config wrangler.staging.toml
```

Use the **phonepe-staging branch** connection string here, never production. Then set a new staging-only `JWT_SECRET` and the PhonePe **sandbox** values:

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
- reconciled state, and the D1 status shown to the customer;
- that the supplier booking is **not** auto-confirmed;
- partial refund, replay of the same refund request (no second debit), over-refund refusal, full refund;
- webhook authentication and that a forged payload can't change the ledger.

Results go to `phonepe-sandbox-report.json` (ids and pass/fail only). Also confirm, in the PhonePe sandbox dashboard webhook log, that genuine deliveries for these orders returned HTTP 200.

## 7. Verify the ledger directly (D1) and in Admin

```bash
wrangler d1 execute zamra-phonepe-staging --remote --config wrangler.staging.toml --command "SELECT booking_id, state, amount_minor, refund_reserved_minor, refunded_minor, transaction_id FROM phonepe_orders ORDER BY updated_at"
```

```bash
wrangler d1 execute zamra-phonepe-staging --remote --config wrangler.staging.toml --command "SELECT merchant_order_id, amount_minor, state, provider_refund_id FROM phonepe_refunds"
```

```bash
wrangler d1 execute zamra-phonepe-staging --remote --config wrangler.staging.toml --command "SELECT booking_id, gateway FROM payment_checkout_claims"
```

Expected:
- 0001: `COMPLETED`, 200 reserved, 200 refunded, two `COMPLETED` refunds.
- 0002: `FAILED`.
- Each test booking has exactly one claim, and it is `PHONEPE`.

In staging Admin, open each booking:
- the Payments tab shows `PHONEPE (D1, sandbox)` once;
- the bookings list shows the PhonePe badge;
- Finance shows the sandbox receipts separately from revenue;
- "Retry airline booking" is not offered for the paid booking.

Send me `phonepe-sandbox-report.json` and the three query outputs. They contain no secrets.
