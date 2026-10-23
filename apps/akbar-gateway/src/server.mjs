import http from "node:http";
import { Readable } from "node:stream";
import { openSync, closeSync, unlinkSync } from "node:fs";
import { createHandler } from "./handler.mjs";
import { createMockService } from "./service.mjs";
import { SecurityBoundary, principalsFromConfig } from "./security.mjs";

// Deliberately no network/UAT transport. A toggle cannot enable real API access.
if (
  process.env.AKBAR_GATEWAY_MODE !== "mock" ||
  process.env.AKBAR_NETWORK_ENABLED === "true"
)
  throw new Error("Only explicit mock mode is implemented");
if (
  [
    "AKBAR_API_KEY",
    "AKBAR_PASSWORD",
    "AKBAR_CLIENT_ID",
    "AKBAR_MERCHANT_ID",
    "AKBAR_BROWSER_KEY",
  ].some((k) => process.env[k])
)
  throw new Error(
    "Do not supply provider credentials to this mock-only service",
  );
const principals = principalsFromConfig(
  JSON.parse(process.env.AKBAR_GATEWAY_PRINCIPALS_JSON ?? "null"),
);
const audience = process.env.AKBAR_GATEWAY_AUDIENCE;
const lockPath = process.env.AKBAR_GATEWAY_LOCK_PATH;
if (!lockPath?.startsWith("/") || lockPath.includes(".."))
  throw new Error("An explicit shared owner lock path is required");
const boundary = new SecurityBoundary({ principals, audience });
const lock = openSync(lockPath, "wx", 0o600); // Fail closed on competing owner or stale lock.
const service = createMockService({
  secretsFor: (scope) => ({
    merchantId: "mock-only",
    apiKey: "mock-only",
    clientId: "mock-only-" + scope.accountId,
    password: "mock-only",
    agentCode: "",
    browserKey: "mock-only",
  }),
  transportFor: () => ({
    kind: "mock",
    request: async (operation) => {
      if (operation === "Signature")
        return {
          status: 200,
          body: {
            Code: "200",
            Token: "mock-only-token",
            ClientID: "mock-only-client",
          },
        };
      if (operation === "ExpressSearch")
        return { status: 200, body: { Code: "200", TUI: "mock-only-search" } };
      if (operation === "GetExpSearch")
        return {
          status: 200,
          body: {
            Code: "200",
            TUI: "mock-only-search",
            Completed: true,
            CurrencyCode: "INR",
            Trips: [],
          },
        };
      throw new Error(
        "Pricing is disabled in the empty-result startup fixture",
      );
    },
  }),
});
const handler = createHandler({
  boundary,
  service,
  logger: (entry) => console.log(JSON.stringify(entry)),
});
const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
  if (
    !req.url ||
    /[\r\n%]/.test(req.url) ||
    req.url.includes("..") ||
    req.url.includes("//")
  ) {
    res.writeHead(400);
    res.end();
    return;
  }
  try {
    const controller = new AbortController();
    req.on("aborted", () => controller.abort());
    const request = new Request("http://gateway.internal" + req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.method === "POST"
        ? { body: Readable.toWeb(req), duplex: "half" }
        : {}),
      signal: controller.signal,
    });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch {
    res.writeHead(500, { "cache-control": "no-store" });
    res.end('{"error":"GATEWAY_FAILURE"}');
  }
});
server.headersTimeout = 5000;
server.requestTimeout = 25000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 30;
const host = process.env.AKBAR_GATEWAY_BIND ?? "127.0.0.1",
  port = Number(process.env.PORT ?? 3002);
if (
  !["127.0.0.1", "0.0.0.0"].includes(host) ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error("Invalid listen configuration");
server.listen(port, host);
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    closeSync(lock);
    unlinkSync(lockPath);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 30000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
