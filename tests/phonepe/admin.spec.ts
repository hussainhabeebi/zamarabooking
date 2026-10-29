import { test, expect, type BrowserContext } from "@playwright/test";
const base = "http://127.0.0.1:5300";
async function fixtures(
  context: BrowserContext,
  ready = false,
  denied = false,
) {
  const writes: { path: string; body: unknown }[] = [];
  const external: string[] = [];
  await context.addCookies([
    { name: "zamra_admin_token", value: "local-fixture-only", url: base },
  ]);
  await context.route("**/*", async (route) => {
    const req = route.request(),
      u = new URL(req.url());
    if (u.origin === "http://127.0.0.1:9") {
      const path = u.pathname;
      if (req.method() !== "GET") {
        writes.push({ path, body: req.postDataJSON() });
        return route.fulfill({ json: { ok: true } });
      }
      if (path === "/api/admin/me")
        return route.fulfill({
          json: {
            user: { name: "LOCAL MOCK QA" },
            role: "TENANT_ADMIN",
            roleLabel: "Local fixture",
            fullAccess: true,
            canManageUsers: false,
            sections: [],
          },
        });
      if (path === "/api/admin/settings/phonepe")
        return route.fulfill({
          status: denied ? 403 : 200,
          json: denied
            ? { error: "Full admin access required" }
            : {
                configured: ready,
                gatesReady: ready,
                enabled: false,
                requestedEnabled: false,
                environment: "sandbox",
                connectionHealth: "NOT_VERIFIED",
              },
        });
      if (path === "/api/admin/settings/payments")
        return route.fulfill({
          json: {
            defaultGateway: "NOMOD",
            nomod: { enabled: false },
            razorpay: { enabled: false },
          },
        });
      if (path === "/api/admin/settings/fx")
        return route.fulfill({
          json: {
            settings: { mode: "auto", marginPct: 0, manual: {} },
            auto: null,
            effective: {},
            sources: {},
            currencies: [],
          },
        });
      if (path.endsWith("/email/logs"))
        return route.fulfill({ json: { logs: [] } });
      if (path.endsWith("/email"))
        return route.fulfill({
          json: {
            settings: {
              enabled: false,
              apiKey: "",
              fromName: "Local QA",
              fromEmail: "fixture@example.test",
              replyTo: "",
              bccOps: "",
            },
            keySource: "none",
            last7Days: { sent: 0, failed: 0, skipped: 0 },
          },
        });
      return route.fulfill({ json: {} });
    }
    if (u.origin === base) return route.continue();
    // Existing Admin font stylesheet is mocked locally, never fetched externally.
    if (u.origin === "https://fonts.googleapis.com")
      return route.fulfill({ contentType: "text/css", body: "/* local QA fallback fonts */" });
    external.push(u.origin);
    return route.abort(); // never contact a real API/provider
  });
  return { writes, external };
}
for (const width of [375, 390, 768, 1024, 1440]) {
  test(`disabled PhonePe Admin controls and readable layout at ${width}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const f = await fixtures(context);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/settings");
    const region = page.getByRole("region", { name: "PhonePe settings" });
    await expect(
      region.getByRole("heading", { name: "PhonePe PG V2 Standard Checkout" }),
    ).toBeVisible();
    await expect(region.getByText(/Not provisioned/)).toBeVisible();
    await expect(
      region.getByRole("checkbox", { name: "Enable PhonePe" }),
    ).toBeDisabled();
    await expect(
      region.getByText(/Payment success does not confirm a supplier booking/),
    ).toBeVisible();
    expect(await region.getByRole("textbox").count()).toBe(0);
    await region.scrollIntoViewIfNeeded();
    const box = await region.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    await region.screenshot({
      path: `test-results/phonepe-admin-${width}.png`,
    });
    expect(f.writes).toHaveLength(0);
    expect(f.external).toHaveLength(0);
    expect(errors).toEqual([]);
  });
}
test("fixture-only enabled controls submit metadata only, without submitting the Nomod form", async ({
  page,
  context,
}) => {
  const f = await fixtures(context, true);
  await page.goto("/settings");
  const r = page.getByRole("region", { name: "PhonePe settings" });
  await expect(r.getByRole("checkbox")).toBeEnabled();
  await r.getByRole("checkbox").check();
  await r.getByRole("button", { name: "Save PhonePe setting" }).click();
  await expect(r.getByRole("status")).toHaveText("PhonePe setting saved");
  expect(f.writes).toEqual([
    { path: "/api/admin/settings/phonepe", body: { enabled: true } },
  ]);
  expect(f.external).toEqual([]);
});
test("API denial leaves PhonePe controls disabled", async ({
  page,
  context,
}) => {
  const f = await fixtures(context, false, true);
  await page.goto("/settings");
  const r = page.getByRole("region", { name: "PhonePe settings" });
  await expect(r.getByRole("status")).toHaveText(
    "PhonePe settings unavailable for this account",
  );
  await expect(r.getByRole("checkbox")).toBeDisabled();
  await expect(r.getByRole("button")).toBeDisabled();
  expect(f.writes).toEqual([]);
});
