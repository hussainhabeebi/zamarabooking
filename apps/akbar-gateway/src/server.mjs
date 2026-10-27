import http from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadConfig, resolveRoute, secretsEqual, upstreamUrl } from "./gateway.mjs";

// Fixed-egress gateway for Akbar Travels: Akbar only accepts calls from a
// whitelisted IP, and the Cloudflare Worker has none. The Worker sends each
// call here with X-Zamra-Gateway-Key; the gateway forwards the JSON body and
// Akbar's Bearer token unchanged and streams the answer back.

const config = loadConfig();
const rateBuckets = new Map();

function json(res, status, body, requestId) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-request-id": requestId });
  res.end(JSON.stringify(body));
}

function log(level, fields) {
  console[level](JSON.stringify({ timestamp: new Date().toISOString(), ...fields }));
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();
}

function rateLimited(ip) {
  const minute = Math.floor(Date.now() / 60000);
  if (rateBuckets.size > 10_000) {
    for (const [key, value] of rateBuckets) if (value.minute !== minute) rateBuckets.delete(key);
  }
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.minute !== minute) {
    rateBuckets.set(ip, { minute, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > config.rateLimitPerMinute;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.maxBodyBytes) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try { JSON.parse(text || "{}"); } catch { throw Object.assign(new Error("Request body must be JSON"), { status: 400 }); }
  return text || "{}";
}

const server = http.createServer(async (req, res) => {
  const requestId = String(req.headers["x-request-id"] ?? randomUUID());
  const startedAt = performance.now();
  const url = new URL(req.url ?? "/", "http://gateway.local");

  if (url.pathname === "/health") return json(res, 200, { status: "ok", service: "akbar-gateway" }, requestId);

  // The IP to give Akbar for whitelisting: this server's public outbound address.
  if (url.pathname === "/egress-ip") {
    if (!secretsEqual(String(req.headers["x-zamra-gateway-key"] ?? ""), config.gatewayKey)) {
      return json(res, 401, { error: "GATEWAY_AUTHENTICATION_FAILED", requestId }, requestId);
    }
    try {
      const ip = (await (await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(5000) })).text()).trim();
      return json(res, 200, { ip }, requestId);
    } catch {
      return json(res, 502, { error: "IP_LOOKUP_FAILED", requestId }, requestId);
    }
  }

  try {
    if (req.method !== "POST") return json(res, 405, { error: "METHOD_NOT_ALLOWED", requestId }, requestId);
    if (!secretsEqual(String(req.headers["x-zamra-gateway-key"] ?? ""), config.gatewayKey)) {
      return json(res, 401, { error: "GATEWAY_AUTHENTICATION_FAILED", requestId }, requestId);
    }
    if (rateLimited(clientIp(req))) return json(res, 429, { error: "GATEWAY_RATE_LIMITED", requestId }, requestId);

    const route = resolveRoute(url.pathname);
    if (!route) return json(res, 404, { error: "UNSUPPORTED_AKBAR_ROUTE", requestId }, requestId);

    const body = await readBody(req);
    const authorization = req.headers["authorization"];
    const response = await fetch(upstreamUrl(config, route), {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        ...(authorization ? { authorization: String(authorization) } : {}),
      },
      body,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });

    res.writeHead(response.status, {
      "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": requestId,
      "x-akbar-upstream-status": String(response.status),
    });
    if (response.body) await pipeline(Readable.fromWeb(response.body), res);
    else res.end();

    log("info", { event: "akbar_request", requestId, route: url.pathname, upstreamStatus: response.status, durationMs: Math.round(performance.now() - startedAt) });
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    const status = error?.status ?? (timeout ? 504 : 502);
    const code = error?.status === 413 ? "REQUEST_TOO_LARGE" : error?.status === 400 ? "INVALID_JSON" : timeout ? "AKBAR_TIMEOUT" : "AKBAR_GATEWAY_FAILURE";
    log("error", { event: "akbar_error", requestId, route: url.pathname, code, message: error?.message });
    if (!res.headersSent) json(res, status, { error: code, requestId }, requestId);
    else res.destroy();
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = config.requestTimeoutMs + 5_000;

server.listen(config.port, "0.0.0.0", () => {
  log("info", { event: "gateway_started", port: config.port, utils: config.utilsUpstream.hostname, flights: config.flightsUpstream.hostname });
});

function shutdown(signal) {
  log("info", { event: "gateway_stopping", signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
