import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Exercises scripts/phonepe-sandbox-acceptance.mjs against a simulated staging API.
// No network: the mock replaces fetch. Values below are local fixtures only.
const script = fileURLToPath(new URL("../../../scripts/phonepe-sandbox-acceptance.mjs", import.meta.url));
const mock = fileURLToPath(new URL("./phonepe/sandbox-api-mock.mjs", import.meta.url));
const base = {
  PATH: process.env.PATH ?? "",
  STAGING_API_URL: "https://zamra-api-staging.example.workers.dev",
  STAGING_JWT_SECRET: "local-fixture-secret",
  STAGING_ADMIN_TOKEN: "local-fixture-admin",
  STAGING_WEBHOOK_USERNAME: "fixture",
  STAGING_WEBHOOK_PASSWORD: "fixture-password",
  TENANT_ID: "fixture-tenant",
};
function run(args: string[], env: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "phonepe-sbx-"));
  try {
    const r = spawnSync(process.execPath, ["--import", mock, script, ...args], { cwd, env: { ...base, ...env }, encoding: "utf8" });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
const booking = "phonepe-sbx-0001";

test("refuses production hosts, plain HTTP and a non-staging API", () => {
  assert.equal(run(["preflight"], { STAGING_API_URL: "https://api.zamrabooking.com" }).code, 2);
  assert.equal(run(["preflight"], { STAGING_API_URL: "http://zamra-api-staging.example.workers.dev" }).code, 2);
  const prod = run(["preflight"], { MOCK_BREAK: "health" });
  assert.equal(prod.code, 2);
  assert.match(prod.out, /expected "staging"/);
});
test("payment, refund and webhook steps pass against a correct API and never print secrets", () => {
  for (const step of ["pay", "refund", "webhook"]) {
    const r = run([step, booking]);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /FAIL/);
    for (const secret of [base.STAGING_JWT_SECRET, base.STAGING_ADMIN_TOKEN, base.STAGING_WEBHOOK_PASSWORD])
      assert.equal(r.out.includes(secret), false);
  }
  assert.equal(run(["fail", booking], { MOCK_OUTCOME: "FAILED" }).code, 0);
});
test("each broken API behavior is reported as FAIL", () => {
  const cases: [string, string, RegExp][] = [
    ["pay", "claims", /FAIL\s+second gateway \(Nomod\) refused/],
    ["pay", "idempotency", /FAIL\s+repeat checkout reuses/],
    ["pay", "supplier", /FAIL\s+supplier booking NOT confirmed/],
    ["refund", "replay", /FAIL\s+replayed refund request/],
    ["refund", "overrefund", /FAIL\s+over-refund beyond captured amount refused/],
    ["webhook", "webhook", /FAIL\s+unauthenticated webhook rejected/],
  ];
  for (const [step, brk, expected] of cases) {
    const r = run([step, booking], { MOCK_BREAK: brk });
    assert.equal(r.code, 1, `${brk}: ${r.out}`);
    assert.match(r.out, expected);
  }
});
