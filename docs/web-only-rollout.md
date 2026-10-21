# Public website deployment safety

Review and merge the workflow-safety PR separately, before the homepage PR.
No merge or deployment is authorized by this document.

## Why the safety-only merge does not deploy

GitHub evaluates push workflows at the pushed ref. In the proposed merged tree,
`deploy.yml` has no push, pull-request, schedule, workflow-run, or repository-dispatch
trigger. It accepts only manual workflow_dispatch, on main, with the exact
DEPLOY_ALL_WITH_MIGRATIONS authorization input checked on every job. All legacy
steps, including migration steps, are preserved for a future separately authorized
full-platform release. Do not manually run or rerun the legacy workflow during this rollout.

`deploy-web.yml` push triggers match only apps/web/** or packages/ui/** on main.
The safety PR changes only workflow files and this document, so neither push
path matches. Opening either PR runs build checks without deployment credentials;
the sole deploy step also requires event_name=push and ref=refs/heads/main.
The safety PR must remain separate from all frontend changes.

| Event/change | Legacy full platform | Public website |
| --- | --- | --- |
| Safety-only PR opened | No run | Build checks only |
| Safety-only PR merged | No run | No run |
| Homepage PR opened | No run | Build checks only |
| Homepage PR merged after approval | No run | Build and zamra-web deployment |
| Admin/API/Portal/DB change pushed | No run | No run |
| Manual legacy dispatch, wrong branch/input | All jobs skipped | No run |
| Authorized legacy dispatch on main with exact phrase | Original full deployment | Legacy web job also runs |

The new workflow invokes OpenNext and Wrangler only in apps/web. The target guard
requires name=zamra-web, the existing OpenNext entrypoint, and no added database,
queue, service, storage, migration, route or environment bindings. Deployment uses
an explicit config path and --name zamra-web. No Worker config, DNS, secrets or
branch protection changes are included. GitHub token permissions are contents:read;
Cloudflare credentials are exposed only to the deploy step, never PR build steps.

## Verification before any future merge

1. Confirm main has not changed and the safety PR contains only its intended files.
2. Inspect all workflows again for added triggers and check for queued/in-progress
   legacy runs. Historical queued runs are not cancelled by changing a workflow;
   stop for owner review if any exist. Do not rerun old full-platform runs.
3. Confirm no external Cloudflare/GitHub integration auto-deploys this repository
   independently. That external account configuration is outside repository proof.
4. Require the normal PR reviews and checks; do not bypass protections. If a required
   deployment-named check blocks the change, stop for maintainer review.
5. After explicit approval, merge only the safety PR. Verify there is no production
   deployment/migration run from its merge SHA before proceeding.
6. Update the homepage branch with main, rerun frontend checks and review the final
   diff. Shared lockfile/workspace/dependency changes require separate release review;
   they are intentionally not automatic production triggers.
7. After separate deployment approval, merge the homepage PR normally. Monitor only
   the Public website checks and deployment workflow. It must target zamra-web.
8. Verify homepage, favicon/Apple/PWA icons, navigation, search URL parameters,
   mobile layouts and admin-login availability without submitting a booking or payment.

If independent external auto-deploy settings cannot be confirmed, do not merge:
ask the production owner to establish a controlled deployment window or review and
pause that specific independent trigger, then repeat the above checks. This is a
rollout prerequisite, not permission to change those settings.

## Local validation

- actionlint 1.7.7 with shellcheck/pyflakes disabled: both workflows pass.
- Policy checks: safety-only paths do not match deployment; PR deployment is gated;
  legacy job steps and needs are unchanged; every legacy job requires manual confirmation.
- Standard frontend type-check, Next build and browser regression checks run on the
  homepage branch. The homepage PR records its own results.

References: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
and https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
