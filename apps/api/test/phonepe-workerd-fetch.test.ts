import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

// Regression for the staging connection test returning TRANSPORT_UNKNOWN: the
// Workers runtime rejects fetch(..., { redirect: "error" }) with a TypeError
// before any I/O, so every PhonePe call failed on Cloudflare while Node-based
// mocks passed. This runs the real PhonePeClient inside the workerd binary that
// wrangler deploys with (same compatibility date and flags as the API), with all
// outbound traffic sent to a local mock instead of PhonePe. No network, no secrets.
const fromWrangler = createRequire(createRequire(import.meta.url).resolve("wrangler"));
const workerdPath: string = fromWrangler("workerd").default;
const esbuild = fromWrangler("esbuild");

const SECRET = "fixture-client-secret-must-not-leak";
const CLIENT = "FIXTURECLIENTID";
const TOKEN = "fixture-access-token-must-not-leak";
const ENTRY = `
import { PhonePeClient, PhonePeError } from ${JSON.stringify(new URL("../src/lib/phonepe/client.ts", import.meta.url).pathname)};
export default {
  async fetch() {
    try {
      await new PhonePeClient({ tenantId: "tenant-fixture", environment: "sandbox", clientId: ${JSON.stringify(CLIENT)}, clientSecret: ${JSON.stringify(SECRET)}, clientVersion: "1" }).verifyAuthentication();
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ ok: false, error: e instanceof PhonePeError ? e.code : "UNEXPECTED", httpStatus: e?.httpStatus });
    }
  },
};`;

type Seen = { method?: string; host?: string; url?: string; body: string };
let respond: (res: http.ServerResponse) => void;
const seen: Seen[] = [];
let mock: http.Server;
let workerd: ChildProcess;
let output = "";
let port = 0;
let dir = "";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
// node:http, not fetch: the test network guard blocks fetch in this process.
const get = () =>
  new Promise<any>((resolve, reject) =>
    http
      .get({ host: "127.0.0.1", port, path: "/" }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c)).on("end", () => resolve(JSON.parse(b)));
      })
      .on("error", reject),
  );

before(async () => {
  mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      seen.push({ method: req.method, host: req.headers.host, url: req.url, body });
      respond(res);
    });
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  port = await freePort();
  dir = mkdtempSync(join(tmpdir(), "phonepe-workerd-"));
  writeFileSync(join(dir, "entry.ts"), ENTRY);
  await esbuild.build({ entryPoints: [join(dir, "entry.ts")], bundle: true, format: "esm", platform: "neutral", outfile: join(dir, "worker.mjs"), logLevel: "silent" });
  writeFileSync(
    join(dir, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .w),
    (name = "mock", external = (address = "127.0.0.1:${(mock.address() as AddressInfo).port}", http = ())),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ],
);
const w :Workerd.Worker = (
  modules = [ (name = "worker.mjs", esModule = embed "worker.mjs") ],
  compatibilityDate = "2024-11-01",
  compatibilityFlags = ["nodejs_compat"],
  globalOutbound = "mock",
);`,
  );
  workerd = spawn(workerdPath, ["serve", "config.capnp", "--experimental"], { cwd: dir });
  workerd.stdout!.on("data", (d) => (output += d));
  workerd.stderr!.on("data", (d) => (output += d));
  for (let i = 0; ; i++) {
    try {
      respond = (res) => res.end("{}");
      await get();
      break;
    } catch {
      if (i > 100) throw new Error(`workerd did not start: ${output}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  seen.length = 0;
  output = "";
});
after(() => {
  workerd?.kill();
  mock?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("in the Workers runtime the sandbox OAuth request is actually sent and succeeds", async () => {
  seen.length = 0;
  respond = (res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ access_token: TOKEN, token_type: "O-Bearer", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  };
  assert.deepEqual(await get(), { ok: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].host, "api-preprod.phonepe.com");
  assert.equal(seen[0].url, "/apis/pg-sandbox/v1/oauth/token");
  assert.equal(new URLSearchParams(seen[0].body).get("grant_type"), "client_credentials");
});

test("a redirect is not followed and fails as HTTP_ERROR", async () => {
  seen.length = 0;
  respond = (res) => {
    res.statusCode = 302;
    res.setHeader("location", "https://elsewhere.example/steal");
    res.end();
  };
  assert.deepEqual(await get(), { ok: false, error: "HTTP_ERROR", httpStatus: 302 });
  assert.equal(seen.length, 1);
});

test("diagnostic logs carry category, elapsed time and status only", async () => {
  await new Promise((r) => setTimeout(r, 200));
  const lines = output.split("\n").filter((l) => l.includes("[phonepe]"));
  assert.ok(lines.some((l) => /"op":"oauth","environment":"sandbox","category":"OK","ms":\d+,"status":200/.test(l)), output);
  assert.ok(lines.some((l) => l.includes('"category":"HTTP_ERROR"') && l.includes('"status":302')), output);
  for (const s of [SECRET, CLIENT, TOKEN, "client_secret", "access_token", "oauth/token", "elsewhere"]) assert.ok(!output.includes(s), `log leaked ${s}`);
});
