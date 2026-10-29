#!/usr/bin/env node
// Writes apps/<web|admin>/wrangler.staging.generated.jsonc for an isolated staging
// Worker (zamra-<app>-staging, workers.dev only) from that app's wrangler.jsonc.
// Used by the Cloudflare Workers Builds staging projects, before the Next build:
//   STAGING_API_URL=https://zamra-api-staging.<subdomain>.workers.dev
//   node scripts/staging-worker-config.mjs web
// Refuses unless STAGING_API_URL is the HTTPS staging API on workers.dev, so a
// staging site can never be built or run against the production API (the apps
// fall back to https://api.zamrabooking.com when the URL is missing).
import { readFileSync, writeFileSync } from "node:fs";

const app = process.argv[2];
const fail = (m) => {
  console.error(`staging-worker-config: ${m}`);
  process.exit(1);
};
if (!["web", "admin"].includes(app)) fail("usage: staging-worker-config.mjs <web|admin>");
let api;
try {
  api = new URL(process.env.STAGING_API_URL ?? "");
} catch {
  fail("set STAGING_API_URL (build variable) to https://zamra-api-staging.<subdomain>.workers.dev");
}
if (api.protocol !== "https:" || !/^zamra-api-staging\.[a-z0-9-]+\.workers\.dev$/.test(api.hostname) || api.pathname !== "/" || api.search || api.hash)
  fail(`STAGING_API_URL must be https://zamra-api-staging.<subdomain>.workers.dev (got ${api.href})`);

const base = JSON.parse(readFileSync(new URL(`../apps/${app}/wrangler.jsonc`, import.meta.url), "utf8"));
const forbidden = ["routes", "route", "d1_databases", "kv_namespaces", "r2_buckets", "queues", "services", "hyperdrive", "durable_objects", "triggers", "env"];
if (forbidden.some((k) => k in base)) fail(`apps/${app}/wrangler.jsonc gained bindings/routes; review staging isolation first`);
const origin = api.origin;
const config = {
  ...base,
  name: `zamra-${app}-staging`,
  workers_dev: true,
  vars: {
    ...(base.vars ?? {}),
    NEXT_PUBLIC_API_URL: origin,
    ...(app === "admin" ? { API_BASE_URL: origin } : {}),
    NEXT_PUBLIC_PORTAL_URL: origin, // no staging portal; never link to production
  },
};
writeFileSync(new URL(`../apps/${app}/wrangler.staging.generated.jsonc`, import.meta.url), `${JSON.stringify(config, null, 2)}\n`);
console.log(`staging-worker-config: ${config.name} → ${origin}`);
