# Akbar Test/UAT Admin-only release preparation

## Separated scope

This release branch starts at main 7182a9be41c5e8958990ddf49ad97b5cbb169499 and extracts the Admin metadata changes from PR #13/e990c1d. PR #13 is left unmerged and unchanged. No Akbar adapter, fixtures, token/session code, mock gateway, Dockerfile or lockfile importer is included. No new supplier transport is exported or registered. Only the SupplierName identifier and explicit router rejection guard are included to test/defend against an enabled AKBAR configuration. Other supplier implementations and the TripJack gateway remain unchanged.

The shared card appears on Suppliers, Integrations and Flight Sources. It permits only authenticated full admins to update tenant-scoped priority. Whitelist status for submitted IP 156.67.110.188 remains pending; connection health remains unverified; all search/booking/payment/ticketing operations remain disabled. There is no UAT connection-test endpoint or provider request. Credentials are not exposed or accepted by the Admin form. Existing legacy values are preserved but never used for connectivity.

No migration, new database supplier row, secret or new binding is required. Priority uses existing TENANT_CACHE_KV. The submitted IP does not prove actual VPS egress or whitelisting.

## Workflow safety

`.github/workflows/admin-api-release.yml` performs Node22/pnpm9.12.0 checks, local fixture tests and Admin Next/OpenNext builds. It has read-only contents permission, no secrets, no deploy commands, no migrations and no production network target. Pull requests run validation only. Manual dispatch validates and then deliberately fails the production gate. This is a build/preparation workflow, NOT an armed production workflow: production verification is inaccessible, so no executable promotion stage is approved yet.

The existing legacy full-platform workflow stays untouched and must NEVER be dispatched for this release. It runs migrations and deploys multiple Workers. The existing web workflow sees workflow changes but only builds on PRs; the release scope does not match its main push deployment paths (`apps/web/**`, `packages/ui/**`). Independent GitHub Apps/webhooks/external projects still require owner confirmation; source inspection cannot exclude them.

## Required owner evidence before merge or arming production

1. Confirm repository webhooks, installed Apps, external deployment projects and all Workers/Pages have no independent push/merge deployments or migrations. Four Workers were previously reported Git-disconnected; reconfirm current state and any additional projects.
2. Export/record current `zamra-api` and `zamra-admin` active deployment IDs, all version IDs and traffic percentages; identify usable previous code versions and verify they preserve current secrets/bindings. Record web/portal versions as unaffected baselines.
3. Compare API/Admin live bindings, variables (names/hash only), compatibility date/flags and code configuration with repository/generated build configuration. Record API custom domains/routes, cron schedules, queue producers/consumers and other script settings. Do not include secret values in evidence or logs. Stop on mismatch or missing access.
4. Confirm no competing production run/build is pending or active. Confirm deployment token scope, protected production environment reviewers, no self-approval/bypass and required GitHub checks. Current main metadata reports protection disabled; owner must establish/confirm the required release protections rather than bypassing them.
5. Confirm version upload/promotion supports the Workers' current bindings and assets without trigger/settings changes. Confirm API/Admin rollback version reachability and health. Version rollback cannot undo KV/data writes; no schema or data transformation is allowed in this release.

## Exact staged rollout after separate approval

1. Review this small release PR separately from #13. Obtain successful Node22 checks including Admin/OpenNext builds. Record approved immutable merge SHA. Do not merge either PR now.
2. After owner evidence and explicit deployment approval, review a separate manually dispatched promotion workflow. Use immutable SHA checkout and pinned tools, read-only GitHub contents, protected environment approval, production concurrency shared by API/Admin, and least-privilege Cloudflare token. Do not grant PR jobs production secrets or reuse root deploy scripts.
3. Build that SHA without supplier/network credentials. Check configs identify only `zamra-api` (`apps/api/wrangler.toml`) and `zamra-admin` (`apps/admin/wrangler.jsonc` or explicitly inspected generated config). Compare live settings/bindings and baseline versions again immediately before upload. Ensure no Wrangler generated-config redirect targets another Worker.
4. API first: from apps/api, use `pnpm exec wrangler versions upload --config wrangler.toml --name zamra-api --keep-vars`. Record new version; inspect it before promotion and compare bindings/compatibility/variables with baseline. Stop on any difference. Do NOT use `wrangler deploy`, `triggers deploy`, secret commands, SQL or migration commands.
5. In the approved GitHub job, promote only the inspected API version with `pnpm exec wrangler versions deploy <NEW_API_VERSION>@100% --config wrangler.toml --name zamra-api --yes`. Verify authenticated metadata GET, priority validation, disabled AKBAR routing, API health and unchanged cron/queues. No Akbar requests or booking/payment operations.
6. Admin second: after API verification succeeds, from apps/admin upload with `pnpm exec wrangler versions upload --config wrangler.jsonc --name zamra-admin --keep-vars`. Inspect effective/generated config and uploaded version; stop on mismatches. Promote using `pnpm exec wrangler versions deploy <NEW_ADMIN_VERSION>@100% --config wrangler.jsonc --name zamra-admin --yes` only after inspection/approval.
7. Verify live authorized Admin Suppliers/Integrations/Flight Sources, pending whitelist, unverified health, disabled test/search/booking/payment/ticketing and safe priority persistence for the intended tenant. Confirm existing suppliers, API routes/cron/queues and web/portal versions unchanged. Do not submit real bookings/payments. Live verification remains pending until release.

## Rollback (GitHub job only; not executed)

Stop the sequence immediately on unexpected behavior. If API failed before Admin promotion, restore only recorded API baseline. If both were promoted, restore Admin first, API second, using the exact recorded traffic allocation. For a single baseline version use `wrangler versions deploy <PREVIOUS_VERSION>@100% --name <EXACT_WORKER> --config <EXACT_CONFIG> --yes`; for split traffic restore every original version/percentage, not an invented 100% allocation. Verify rollback versions still exist before promotion; retain required secret/binding compatibility. Never run migrations, trigger deployment or secret writes as rollback. Recheck health and all unaffected Worker/trigger baselines. If baseline is unavailable, do not deploy.

## Current blockers

Cloudflare account, live configuration, version history/traffic and rollback capability cannot be read through the connected tools. GitHub deployment-record reads are rejected by the connector; webhook/App administration is unavailable. No production verification or approval can be inferred from previous screenshots or successful web deployments. The production gate remains locked. Owner evidence, required protections, successful fresh GitHub CI and separate deployment approval are prerequisites, not completed checks.
