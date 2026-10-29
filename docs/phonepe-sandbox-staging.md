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

## 3. Deploy the staging API from the Cloudflare Dashboard (no local Wrangler)

**Workers & Pages → Create → Import a repository** (Workers Builds). Authorise the Cloudflare GitHub app for `hussainhabeebi/zamarabooking` if asked. Settings:
- **Worker name:** `zamra-api-staging` (must match the config)
- **Branch:** `feature/phonepe-pg-v2` (this Worker's deploy branch only)
- **Root directory:** `/`
- **Build command:** `pnpm install --frozen-lockfile --ignore-scripts`
- **Deploy command:** `cd apps/api && npx wrangler deploy --config wrangler.staging.toml`
- Turn **off** builds for other branches / pull requests if offered.

The first deploy has no secrets, so database routes return 503. That is expected and harmless.

## 4. Staging API secrets (Dashboard → `zamra-api-staging` → Settings → Variables and Secrets)

Add each as type **Secret**. Paste values straight from your password manager; never into chat or files.

| Name | Value |
|---|---|
| `DATABASE_URL` | Neon connection string for branch **`phonepe-staging`**, role **`phonepe_staging`** (Neon → Connect). Check the host is the staging branch endpoint, not production's |
| `JWT_SECRET` | New random 64+ characters, staging only |
| `ADMIN_SERVICE_TOKEN` | New random 40+ characters, staging only. Used as `STAGING_ADMIN_TOKEN` by the acceptance script (no admin users exist on the schema-only branch) |
| `PHONEPE_CLIENT_ID`, `PHONEPE_CLIENT_SECRET`, `PHONEPE_CLIENT_VERSION`, `PHONEPE_MERCHANT_ID` | PhonePe **sandbox** values only (direct merchant, Standard Checkout PG V2) |
| `PHONEPE_WEBHOOK_USERNAME`, `PHONEPE_WEBHOOK_PASSWORD` | New values you generate for staging; the same pair goes into PhonePe's sandbox webhook settings |

Do **not** add `RESEND_*`, `LEADVYNE_*`, `RIYA_*`, `TRIPJACK_*`, `AKBAR_*`, `NOMOD_*` or `RAZORPAY_*`. `PHONEPE_TENANT_ID` (`5e7acd7c-d40f-4ac3-ae93-a23a27f56d9d`) and `PHONEPE_ENVIRONMENT=sandbox` are already in `wrangler.staging.toml`. Dashboard variables and secrets survive redeploys (`keep_vars = true`).

Check (no secrets in the output):

```bash
curl -s https://zamra-api-staging.<subdomain>.workers.dev/health
```

Expected: `"env":"staging"`.

```bash
curl -s https://zamra-api-staging.<subdomain>.workers.dev/api/admin/settings/phonepe -H "Authorization: Bearer $STAGING_ADMIN_TOKEN" -H 'x-tenant-slug: zamra'
```

Expected: `"configured":true`, `"gatesReady":false`, `"enabled":false`, `"environment":"sandbox"`, `"ledger":"NEON"`. Resolving the `zamra` tenant proves the staging API reaches the Neon staging branch, and PhonePe stays disabled. `configured` is `false` until `PHONEPE_RETURN_ORIGIN` is set in step 4b. A 503 "Database connection is not configured" means `DATABASE_URL` is missing.

## 4b. Deploy the staging website (return page)

A second Workers Builds project, same repository and branch:
- **Worker name:** `zamra-web-staging`
- **Root directory:** `/`
- **Build variable:** `STAGING_API_URL` = `https://zamra-api-staging.<subdomain>.workers.dev`
- **Build command:** `pnpm install --frozen-lockfile && node scripts/staging-worker-config.mjs web && cd apps/web && NEXT_PUBLIC_API_URL="$STAGING_API_URL" pnpm exec opennextjs-cloudflare build --dangerouslyUseUnsupportedNextVersion`
- **Deploy command:** `cd apps/web && npx wrangler deploy --config wrangler.staging.generated.jsonc`

`scripts/staging-worker-config.mjs` refuses any URL that isn't `https://zamra-api-staging.<subdomain>.workers.dev`. The apps fall back to the production API when the URL is missing, so this guard prevents a staging site that talks to production.

Then, on **`zamra-api-staging`**, add the Text variable `PHONEPE_RETURN_ORIGIN` = `https://zamra-web-staging.<subdomain>.workers.dev` and redeploy (**Deployments → Retry/Deploy**, or push any commit).

A staging Admin UI is optional. The acceptance script uses the API and the Neon checks in step 7. If wanted, it's the same pattern with `staging-worker-config.mjs admin`, `apps/admin` and Worker name `zamra-admin-staging`.

## 5. PhonePe sandbox dashboard

- Confirm **direct merchant** Standard Checkout (PG V2) sandbox credentials.
- Webhook: URL `https://zamra-api-staging.<subdomain>.workers.dev/webhooks/phonepe`, **SHA256 (username/password)** mode, the same username/password as the staging secrets, events `checkout.order.completed`, `checkout.order.failed`, `pg.refund.completed`, `pg.refund.failed`.

Then, on **`zamra-api-staging`** only, add Text variables `PHONEPE_SCHEMA_READY`, `PHONEPE_MERCHANT_ACTIVE` and `PHONEPE_RELEASE_APPROVED`, each = `true`, and redeploy. Enable PhonePe for the staging tenant (the Admin opt-in):

```bash
curl -s -X PUT https://zamra-api-staging.<subdomain>.workers.dev/api/admin/settings/phonepe -H "Authorization: Bearer $STAGING_ADMIN_TOKEN" -H 'x-tenant-slug: zamra' -H 'content-type: application/json' -d '{"enabled":true}'
```

Expected: `{"ok":true}`. Re-running the readiness check above now shows `"gatesReady":true` and `"enabled":true`. To switch PhonePe off again, send `{"enabled":false}` or remove a gate variable.

## 6. Run the sandbox acceptance

From the repo root, in a shell where you export the staging values without echoing them (for example `read -rs STAGING_JWT_SECRET && export STAGING_JWT_SECRET`):
- `STAGING_API_URL`
- `STAGING_JWT_SECRET`: the staging `JWT_SECRET`
- `STAGING_ADMIN_TOKEN`: the staging `ADMIN_SERVICE_TOKEN`
- `STAGING_WEBHOOK_USERNAME`, `STAGING_WEBHOOK_PASSWORD`
- `TENANT_ID=5e7acd7c-d40f-4ac3-ae93-a23a27f56d9d`

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

Admin view through the API (same data the Admin pages show):

```bash
curl -s https://zamra-api-staging.<subdomain>.workers.dev/api/admin/bookings/phonepe-sbx-0001 -H "Authorization: Bearer $STAGING_ADMIN_TOKEN" -H 'x-tenant-slug: zamra'
```

Expected:
- `payments` has one `PHONEPE` row;
- `phonePePaid` is `true` and `paymentConfirmed` is `false`;
- `POST …/api/admin/bookings/phonepe-sbx-0001/retry-booking` returns 409.

Send me `phonepe-sandbox-report.json` and the four query outputs. They contain no secrets.
