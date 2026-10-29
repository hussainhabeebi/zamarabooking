import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "admin.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 30000,
  reporter: [
    ["list"],
    ["html", { outputFolder: "phonepe-qa-report", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:5300",
    browserName: "chromium",
    serviceWorkers: "block",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "node apps/admin/node_modules/next/dist/bin/next start apps/admin -p 5300 -H 127.0.0.1",
    url: "http://127.0.0.1:5300/login",
    reuseExistingServer: false,
    timeout: 60000,
    cwd: "../..",
  },
});
