# Akbar Test/UAT Admin preparation

This change is prepared on PR #13, not deployed. Akbar is visible as a shared card on Suppliers, Integrations and Flight Sources. It is not a new live database supplier record. The existing adapter and gateway are reused unchanged; no duplicate implementation is introduced.

## Configuration and security

- Only full TENANT_ADMIN/SUPER_ADMIN users may read the dedicated configuration or save priority. Existing admin authentication and tenant resolution remain mandatory. Staff cannot change it.
- Priority is an integer 1–1000, default 100, stored in the existing tenant-specific TENANT_CACHE_KV integration key. No database migration, seed or new binding is required.
- Search/booking/ticketing/payments stay disabled in UI and backend. The generic supplier PATCH path rejects AKBAR. Existing public router and adapter protections remain intact.
- UAT is the only exposed environment. Submitted IP 156.67.110.188 is informational, NOT a verified egress address or whitelist confirmation. Status is always Pending confirmation until a future authorized change verifies it.
- Health is Not verified, no UAT test timestamp exists and real connection testing is unavailable. Refresh readiness performs metadata GET only. No mock result may mark it connected.
- No credential entry or credential fragments are returned. Historical KV settings remain untouched when priority is saved except forced disabled/UAT flags. They are never used as evidence of a configured/connected gateway. The previous password/API-key KV write path is rejected. Existing legacy credentials should later be inventoried/rotated through a separately authorized security task; do not migrate/delete them during this preparation.
- Future Akbar provider secrets belong in protected gateway backend secret storage; Worker holds only gateway signing credentials. No new secret provisioning or production configuration is performed here. No extra Worker environment variable is required for this metadata-only release.
- Provider errors cannot exist yet because no connection has been attempted. The UI shows explicit blockers and safe Admin loading/saving errors rather than a fabricated provider health result.

## Latest main and scope

Reviewed against main 7182a9be41c5e8958990ddf49ad97b5cbb169499, already an ancestor of the feature branch. Existing Riya, TripJack, Duffel/Poomas settings and source implementations are unchanged. PR #13 also includes the previously prepared supplier/gateway files: review the entire PR before release, not only this Admin increment.

## Safe release sequence — requires separate approval

1. Review this draft and tests/screenshots. Re-fetch main and compare full PR scope; stop on new changes. Do not merge/deploy during preparation.
2. Owner verifies GitHub webhooks/apps and external deployment projects still cannot independently deploy or migrate. Reconfirm Workers remain Git-disconnected. Record current API/Admin versions, traffic, routes, bindings, compatibility settings, API cron and queue configuration; establish usable rollback versions. Stop if access/evidence is missing.
3. Current `.github/workflows/deploy.yml` is manual-only but explicitly runs migrations and deploys multiple applications. **Never dispatch it for this release.** The existing web-only workflow only matches apps/web or packages/ui; these Admin/API changes do not match its push filters. No workflow was changed in this increment.
4. Before deployment, prepare and separately review a dedicated manual Admin/API-only GitHub workflow. It must check out an immutable approved SHA, use Node22/pinned pnpm, install frozen dependencies, run supplier/API/Admin checks and tests, and build Admin with OpenNext. It must contain no database commands, web/portal/gateway jobs, trigger changes, secret writes or route updates. Give it read-only contents permissions, protected production environment approval and serialized release concurrency. Do not use the root multi-app deploy script.
5. Inspect Cloudflare dry-run output and live configuration. Version uploads must target only `zamra-api` (apps/api/wrangler.toml) and `zamra-admin` (apps/admin/wrangler.jsonc), preserve existing variables and secrets, and leave live bindings/routes/cron/queues unchanged. The API config contains existing routes/queues/schedules: do not apply it blindly with full deploy. Use reviewed version upload/promotion steps; stop on any configuration mismatch or unsupported binding/version behavior.
6. After explicit release approval and successful Node22 CI, merge through normal protections. Upload/inspect API version, promote with recorded rollback, then upload/inspect/promote Admin version. No SQL or schema operations are necessary. API-first avoids a new Admin requesting an absent endpoint. If an endpoint fails or any unrelated production activity starts, stop and roll back affected code versions.
7. Verify authorized Admin → Suppliers, Integrations and Flight Sources; priority save/reload for the intended tenant only; pending IP and unverified health; disabled connection test and all live operations. Confirm existing suppliers/configurations and public search remain unchanged. No bookings/payments or Akbar calls are part of verification.
8. Compare API triggers/queues/routes and all other Worker versions against the recorded baseline. Keep gateway undeployed. Roll back Admin first and API second if required.

## Future UAT gates

Written Akbar activation and whitelist confirmation for verified VPS egress; exact utility/flight HTTPS hosts, secure credential provisioning, unresolved provider contracts, gateway TLS/allowlist/replay/session-owner plan and separately approved real UAT transport. Enabling a button or saving priority does not clear any gate.

## Validation completed locally

Node 24.19.0: Admin/API/supplier TypeScript checks; Next.js production Admin build; 19 API/integration tests; 55 supplier tests; 22 mock gateway security tests. Rendered Chromium QA used only local mock APIs and blocked external browser requests; all three Admin screens passed at 375, 390, 768, 1024 and 1440px. Verified priority save/reload, pending IP status, disabled UAT test, no credential inputs and no card overflow. Desktop/mobile review screenshots were produced. This is not live Admin/UAT verification. Node22 CI/container validation remains a release prerequisite.
