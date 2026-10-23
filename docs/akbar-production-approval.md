# Akbar Admin release / rollback workflow review

Status: NO-GO. These templates are deliberately stored under docs/workflows, NOT .github/workflows. Both retain a hard failure before any Cloudflare operation; neither references production credentials. They are review artifacts, not finished production workflows. Existing validation workflow remains locked. No settings, secrets, traffic, migrations or Worker versions were changed.

## Confirmed owner-recorded baseline

| Worker | Primary rollback version | Allocation |
| --- | --- | --- |
| zamra-api | 59904189-01bf-44b6-bbb0-33eb8cc77fc2 | 100% |
| zamra-admin | e4870e28-6fab-4958-8456-900e9dbd54eb | 100% |

The user requests publication of the disabled metadata UI. This does not waive preflight gates or authorize ignoring failed protection checks. Conditional rollback authorization must identify these exact targets. Older versions are secondary candidates only.

## Unresolved gates — do not replace the template hard lock yet

1. Main currently reports protected=false and repository rulesets=[]; detailed protection read returns403. Owner must confirm/establish required reviewed merge/check safeguards. Do not treat empty required checks as deployment approval.
2. Owner must configure/verify a production-admin-api environment with required reviewers, prevent self-review, admin bypass disabled and protected-branch-only deployment. No environment is created during this task. Governance API errors fail closed; if GITHUB_TOKEN cannot read environment metadata, a separately authorized read-only governance credential or revised verifiable mechanism is required, not a bypass.
3. Cloudflare account access is signed out; current deployment token policy, version metadata and rollback compatibility are unverified. Owner must verify account/Worker scope and deployment permission for API/Admin using token policy metadata; successful historical deployments are not proof of the current token's permissions. Do not disclose token values or try a deployment as a permission test.
4. Read baseline version metadata with authorized read-only access. Check versions, bindings/resource identity, secret/variable compatibility, assets, compatibility settings, existing Durable Object v1 namespace/class/lifecycle and traffic100%. Confirm resources remain available; no lifecycle or migration change is permitted. A history entry alone is insufficient.
5. Owner confirms no webhooks, Apps, external projects, Cloudflare Builds or other processes independently deploy/migrate on pushes/merges. Confirm API schedules, queues, routes and other Worker versions remain the reported baseline.
6. Owner approval must cover an immutable release SHA, API then Admin, candidate inspection before each promotion, exact baseline rollback authorization and no supplier activation. Required Node22 CI must pass on the final reviewed code.

## Required follow-up before arming executable workflows

After all evidence is recorded and reviewed, complete live preflight implementation and tests: verify exact Cloudflare account, active versions/traffic and candidate/baseline configuration comparisons without printing secrets; reject drift, secret incompatibility or Durable Object lifecycle changes. Verify required GitHub checks/approvals and no competing deployments. Revalidate immediately before each write. Read calls do not prove write permission; pair them with owner-reviewed token policy.

Keep the production token confined to protected production jobs after governance passes; least privilege for API/Admin and necessary asset operations. Never grant it to PR/build jobs. Do not copy a repository token into a new environment or alter permissions without owner authorization.

Templates show separate manual phases so each candidate is inspected and approved before promotion. Owner-controlled approval metadata must be tied to the exact immutable SHA and current baseline; variables in the template are additional locks, NOT substitutes for evidence. Do not set them now. A phase's presence is not proof it has been verified.

## Build and release requirements

- Fresh checkout and Node22/pnpm9.12.0. Admin upload phase rebuilds with NEXT_PUBLIC_API_URL and API_BASE_URL=https://api.zamrabooking.com. It deletes only local generated .next/.open-next, rejects loopback validation URL and checks the production URL appears. Never reuse validation output.
- API candidate upload only, preserve variables and existing configuration. Inspect version metadata before separately approved promotion. No full deploy, trigger deploy, migration or secret commands.
- Verify API authenticated Akbar metadata/priority guard, other suppliers, API health and unchanged schedules/queues. No Akbar calls, real bookings or payments. Owner must complete checks before approving Admin upload/promotion.
- Upload freshly built Admin; inspect ASSETS and compatibility before separately approved promotion. Verify live normal login, Suppliers/Integrations/Flight Sources, pending whitelist, unverified connection and disabled operations; verify existing supplier screens and navigation. Confirm API/Admin100% traffic and other Workers unchanged.
- Use production-wide shared concurrency with the legacy workflow; never dispatch the legacy workflow. Stop/cancel failed competing release before an approved rollback, without cancelling arbitrary production operations blindly.

## Conditional rollback requirements

API failure before Admin promotion: restore API baseline only. Failure after both promotions: Admin baseline first, then API baseline, each at recorded100%. No rebuild/upload/force/migration/secret/trigger operation. Confirm compatibility before any write. Verify restored traffic, health, authentication, existing supplier screens and unchanged queue/cron/routes. A code rollback does not reverse stored KV/data writes; no data transformation is allowed here.

Commands for a future reviewed GitHub job (NOT executed):

```sh
# apps/admin, only if it was promoted
pnpm exec wrangler versions deploy e4870e28-6fab-4958-8456-900e9dbd54eb@100% --config wrangler.jsonc --name zamra-admin --yes
# apps/api
pnpm exec wrangler versions deploy 59904189-01bf-44b6-bbb0-33eb8cc77fc2@100% --config wrangler.toml --name zamra-api --yes
```

Current task stops before installing executable production steps, merging or dispatching. Owner must resolve gates1–6; then complete/review the live-preflight and promotion implementation. The templates do not claim deployment-token or rollback compatibility verification.
