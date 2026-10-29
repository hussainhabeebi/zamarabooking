# PhonePe D1-only sandbox harness (no Neon)

`zamra-phonepe-sandbox` is a separate Worker (`apps/api/src/sandbox-harness.ts`, config `apps/api/wrangler.sandbox-harness.toml`). It runs the **production PhonePe code** against the **PhonePe sandbox**, using synthetic bookings stored in the staging D1 database `zamra-phonepe-staging`:
- same code: `PhonePeService`, `PhonePeClient`, `PhonePeD1Store`, `phonePeWebhook`, `reconcilePhonePe` and the release gates;
- no Neon, supplier, email, Nomod/Razorpay or production bindings;
- workers.dev only, with no custom domain, cron or queues.

It refuses every request unless `ENVIRONMENT=phonepe-sandbox-harness`, `PHONEPE_ENVIRONMENT=sandbox`, the tenant starts with `phonepe-sandbox`, `PHONEPE_PRODUCTION_APPROVED` is unset, the D1 binding exists and a 32+ character `HARNESS_TOKEN` secret is set. The production API (`src/index.ts`) never mounts it.

## What this covers

| Area | D1 harness (no Neon) | Needs the booking database (Neon) |
|---|---|---|
| PhonePe OAuth, create payment, hosted sandbox page | ✅ real sandbox | |
| Order status reconciliation, monotonic states, transaction evidence | ✅ real sandbox | |
| SHA webhooks (auth, merchant check, queued status read, forged-payload resistance) | ✅ real sandbox | |
| Partial/full refunds, replay idempotency, over-refund refusal, refund status | ✅ real sandbox | |
| One gateway per booking (PhonePe vs Nomod/Razorpay/wallet claims in D1) | ✅ claims only; Nomod/Razorpay are not called | Real Nomod/Razorpay/wallet checkout with the claim on |
| Payment never confirms the booking | ✅ synthetic booking stays `PAYMENT_PENDING` | Real booking/supplier state untouched |
| Ownership/payable checks on real bookings, checkout tokens, website return page and status polling | | ✅ |
| Admin booking/finance reports with real bookings, Nomod/Razorpay regression with claims on | | ✅ (local tests already cover with mocks) |

## 1. Deploy the harness from the Cloudflare Dashboard (no local Wrangler)

Cloudflare builds this one Worker from the GitHub branch. Production Workers are not touched. Dashboard labels change over time; look under **Workers & Pages** if a name differs.

1. **Workers & Pages → Create → Import a repository** (Workers Builds). Authorise the Cloudflare GitHub app for `hussainhabeebi/zamarabooking` if asked.
2. Settings:
   - **Project/Worker name:** `zamra-phonepe-sandbox`. It must match `name` in the config.
   - **Branch to deploy:** `feature/phonepe-pg-v2`. This is only this Worker's deploy branch; it doesn't change the real production Workers.
   - **Root directory:** `/` (repository root).
   - **Build command:** `pnpm install --frozen-lockfile --ignore-scripts`
   - **Deploy command:** `cd apps/api && npx wrangler deploy --config wrangler.sandbox-harness.toml`
   - Turn off builds for other branches / pull requests if offered.
3. Save and deploy. The first build creates `zamra-phonepe-sandbox` at `https://zamra-phonepe-sandbox.<your-subdomain>.workers.dev`.

Every new push to the branch redeploys this harness only. Secrets and dashboard variables are kept (`keep_vars = true`).

## 2. Secrets and settings (Dashboard → the Worker → Settings → Variables and Secrets)

Add each of these as type **Secret**, using sandbox values only:
- `HARNESS_TOKEN`: 40+ random characters from your password manager.
- `PHONEPE_CLIENT_ID`, `PHONEPE_CLIENT_SECRET`, `PHONEPE_CLIENT_VERSION`, `PHONEPE_MERCHANT_ID`: PhonePe **sandbox**, direct-merchant Standard Checkout (PG V2).
- `PHONEPE_WEBHOOK_USERNAME`, `PHONEPE_WEBHOOK_PASSWORD`: new values you generate for this sandbox only.

Add as type **Text**:
- `PHONEPE_RETURN_ORIGIN` = `https://zamra-phonepe-sandbox.<your-subdomain>.workers.dev` (origin only, no path).

Leave the gates unset for now. Check:

```bash
curl -s https://zamra-phonepe-sandbox.<your-subdomain>.workers.dev/health
```

Expected: `"env":"phonepe-sandbox-harness"`, `"phonePeEnvironment":"sandbox"`, `"configured":true`, `"gatesReady":false`, `"enabled":false`.

## 3. PhonePe sandbox dashboard

Webhook URL: `https://zamra-phonepe-sandbox.<your-subdomain>.workers.dev/webhooks/phonepe`. Settings:
- mode: **SHA256 username/password**, with the same username and password as the secrets;
- events: `checkout.order.completed`, `checkout.order.failed`, `pg.refund.completed`, `pg.refund.failed`.

## 4. Turn on the sandbox gates (this harness only)

Add Text variables `PHONEPE_SCHEMA_READY`, `PHONEPE_MERCHANT_ACTIVE`, `PHONEPE_RELEASE_APPROVED`, each = `true`, then **Deploy** (or redeploy). `/health` should show `"gatesReady":true`.

In a terminal, load the URL and token without echoing the token:

```bash
H=https://zamra-phonepe-sandbox.<your-subdomain>.workers.dev; read -rs T
```

```bash
curl -s -X PUT "$H/settings/phonepe" -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"enabled":true}'
```

## 5. Sandbox tests

**A. Successful payment (₹2 synthetic booking).**

```bash
curl -s -X POST "$H/bookings" -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"amountMinor":200}'
```

Copy `bookingId` into `B`:

```bash
B=<bookingId>
```

```bash
curl -s -X POST "$H/bookings/$B/checkout" -H "Authorization: Bearer $T"
```

Run it again. The `orderId` must be the same (no second order). Open `paymentUrl` and pay with a PhonePe **sandbox** test instrument from PhonePe's developer documentation.

```bash
curl -s -X POST "$H/bookings/$B/claim/NOMOD" -H "Authorization: Bearer $T"
```

Expected: HTTP 409 `CHECKOUT_GATEWAY_ALREADY_RESERVED`.

Wait about 30 seconds for the webhook, then:

```bash
curl -s "$H/bookings/$B" -H "Authorization: Bearer $T"
```

Expected: `order.state` `COMPLETED`, `ledgerStatus` `SUCCESS`, a `transactionId`, `booking.status` still `PAYMENT_PENDING`, `claim` `PHONEPE`. If the state is still `PENDING`, the webhook didn't arrive: check PhonePe's webhook log, then run `curl -s -X POST "$H/bookings/$B/reconcile" -H "Authorization: Bearer $T"`.

**B. Refunds.**

```bash
R=$(uuidgen); curl -s -X POST "$H/refunds" -H "Authorization: Bearer $T" -H 'content-type: application/json' -d "{\"bookingId\":\"$B\",\"requestId\":\"$R\",\"amountMinor\":100}"
```

Run the same command again **without** regenerating `R`. It must return the same `merchantRefundId` (no second refund).

```bash
curl -s -X POST "$H/refunds" -H "Authorization: Bearer $T" -H 'content-type: application/json' -d "{\"bookingId\":\"$B\",\"requestId\":\"$(uuidgen)\",\"amountMinor\":200}"
```

Expected: refused (`REFUND_LIMIT_EXCEEDED`), because only ₹1 remains.

After PhonePe's refund webhook, or with `curl -s -X POST "$H/refunds/<merchantRefundId>/reconcile" -H "Authorization: Bearer $T"`, the booking shows `PARTIAL_REFUND`. Refund the remaining ₹1 with a new `uuidgen` and `amountMinor` 100. The booking should end `REFUNDED` with `refundedMinor` 200.

**C. Failed payment.** Create a new ₹2 booking, start checkout and **cancel** on the PhonePe page. The order should become `FAILED`, and `claim/RAZORPAY` should still be refused (409).

**D. Legacy gateway first.** Create a booking, `claim/WALLET` it (200), then checkout must be refused with `CHECKOUT_GATEWAY_ALREADY_RESERVED`.

## 6. Verify in the D1 Console (`zamra-phonepe-staging`)

```sql
SELECT booking_id, state, amount_minor, refund_reserved_minor, refunded_minor, transaction_id FROM phonepe_orders ORDER BY updated_at;
```

```sql
SELECT merchant_order_id, amount_minor, state, provider_refund_id FROM phonepe_refunds;
```

```sql
SELECT booking_id, gateway FROM payment_checkout_claims;
```

```sql
SELECT DISTINCT tenant_id FROM phonepe_orders;
```

The last query must return only `phonepe-sandbox-tenant`. Send these outputs, plus the PhonePe sandbox webhook log status codes. None of them contain secrets.

## Turning it off

Remove the gate variables (or `PUT /settings/phonepe {"enabled":false}`), or delete the `zamra-phonepe-sandbox` Worker. Synthetic data lives only in `zamra-phonepe-staging` (`sandbox_bookings`, and orders under `phonepe-sandbox-tenant`).
