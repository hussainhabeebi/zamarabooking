import http from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadConfig, resolveRoute, secretsEqual, upstreamFor, upstreamUrl } from "./gateway.mjs";

const config = loadConfig();
const rateBuckets = new Map();
let consecutiveFailures = 0;
let circuitOpenedAt = 0;

function json(res, status, body, requestId) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-request-id": requestId,
  });
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
    for (const [key, value] of rateBuckets) {
      if (value.minute !== minute) rateBuckets.delete(key);
    }
  }
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.minute !== minute) {
    rateBuckets.set(ip, { minute, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > config.rateLimitPerMinute;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.maxBodyBytes) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error("Request body must be a JSON object"), { status: 400 });
  }
}

function circuitOpen() {
  if (!circuitOpenedAt) return false;
  if (Date.now() - circuitOpenedAt >= config.circuitResetMs) {
    circuitOpenedAt = 0;
    consecutiveFailures = 0;
    return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const requestId = String(req.headers["x-request-id"] ?? randomUUID());
  const startedAt = performance.now();
  const url = new URL(req.url ?? "/", "http://gateway.local");

  if (url.pathname === "/health") return json(res, 200, { status: "ok", service: "tripjack-gateway" }, requestId);
  if (url.pathname === "/ready") {
    return json(res, circuitOpen() ? 503 : 200, {
      status: circuitOpen() ? "degraded" : "ready",
      upstreamHost: config.upstream.hostname,
      circuit: circuitOpen() ? "open" : "closed",
    }, requestId);
  }

  try {
    if (req.method !== "POST" && req.method !== "GET") return json(res, 405, { error: "METHOD_NOT_ALLOWED", requestId }, requestId);
    if (!secretsEqual(String(req.headers["x-poomas-gateway-key"] ?? ""), config.gatewayKey)) {
      return json(res, 401, { error: "GATEWAY_AUTHENTICATION_FAILED", requestId }, requestId);
    }
    if (rateLimited(clientIp(req))) return json(res, 429, { error: "GATEWAY_RATE_LIMITED", requestId }, requestId);
    if (circuitOpen()) return json(res, 503, { error: "TRIPJACK_CIRCUIT_OPEN", requestId }, requestId);

    const route = resolveRoute(url.pathname);
    if (!route) return json(res, 404, { error: "UNSUPPORTED_TRIPJACK_ROUTE", requestId }, requestId);
    if (req.method !== route.method) return json(res, 405, { error: "METHOD_NOT_ALLOWED", requestId }, requestId);

    const tripjackApiKey = String(req.headers["apikey"] ?? config.tripjackApiKey ?? "");
    if (!tripjackApiKey) {
      return json(res, 502, { error: "TRIPJACK_CREDENTIAL_MISSING", requestId }, requestId);
    }

    const body = route.method === "POST" ? await readJson(req) : undefined;
    const response = await fetch(upstreamUrl(upstreamFor(config, route.upstream), route.upstreamPath, route.method === "GET" ? url.search : ""), {
      method: route.method,
      headers: {
        "accept": "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        "apikey": tripjackApiKey,
        "x-request-id": requestId,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });

    if (response.status >= 500) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= config.circuitFailureThreshold) circuitOpenedAt = Date.now();
    } else {
      consecutiveFailures = 0;
    }

    res.writeHead(response.status, {
      "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": requestId,
      "x-tripjack-upstream-status": String(response.status),
    });
    if (response.body) await pipeline(Readable.fromWeb(response.body), res);
    else res.end();

    log("info", {
      event: "tripjack_request",
      requestId,
      route: url.pathname,
      upstreamHost: upstreamFor(config, route.upstream).hostname,
      upstreamStatus: response.status,
      durationMs: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    if (timeout || !error?.status) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= config.circuitFailureThreshold) circuitOpenedAt = Date.now();
    }
    const status = error?.status ?? (timeout ? 504 : 502);
    const code = error?.status === 413
      ? "REQUEST_TOO_LARGE"
      : error?.status === 400
        ? "INVALID_JSON"
        : timeout
          ? "TRIPJACK_TIMEOUT"
          : "TRIPJACK_GATEWAY_FAILURE";
    log("error", { event: "tripjack_error", requestId, route: url.pathname, code, message: error?.message });
    if (!res.headersSent) json(res, status, { error: code, requestId }, requestId);
    else res.destroy();
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = config.requestTimeoutMs + 5_000;

server.listen(config.port, "0.0.0.0", () => {
  log("info", { event: "gateway_started", port: config.port, upstreamHost: config.upstream.hostname });
});

function shutdown(signal) {
  log("info", { event: "gateway_stopping", signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

