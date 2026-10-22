import { randomUUID } from "node:crypto";
import { GatewayError, ROUTES } from "./security.mjs";
const SAFE_CODES = new Set([
  "DISABLED",
  "AUTH",
  "UNAUTHORIZED",
  "ACCESS_DENIED",
  "EXPIRED_TOKEN",
  "ACCOUNT_ACTION_REQUIRED",
  "FARE_CHANGED",
  "PENDING_UNVERIFIED",
  "TIMEOUT",
  "UPSTREAM",
  "RATE_LIMITED",
  "INVALID_RESPONSE",
  "UNSUPPORTED",
  "INVALID_REQUEST",
  "CAPACITY",
  "OFFER_EXPIRED",
  "OFFER_NOT_FOUND",
]);
function json(body, status) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
async function bodyBytes(request, limit, signal) {
  if (request.headers.has("content-encoding"))
    throw new GatewayError("ENCODING_NOT_ALLOWED", 415);
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    throw new GatewayError("JSON_REQUIRED", 415);
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit))
    throw new GatewayError("REQUEST_TOO_LARGE", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new GatewayError("INVALID_JSON");
  let size = 0;
  const chunks = [];
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new GatewayError("REQUEST_TIMEOUT", 408);
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new GatewayError("REQUEST_TOO_LARGE", 413);
      chunks.push(value);
    }
    if (signal.aborted) throw new GatewayError("REQUEST_TIMEOUT", 408);
    return Buffer.concat(chunks.map((b) => Buffer.from(b)));
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
  }
}
export function createHandler({
  boundary,
  service,
  logger = () => {},
  timeoutMs = 22000,
  maxBodyBytes = 16384,
  maxResponseBytes = 1048576,
}) {
  return async (request) => {
    const requestId = randomUUID(),
      start = performance.now(),
      controller = new AbortController();
    let lease,
      work,
      operation = "rejected",
      status = 500,
      timer;
    try {
      const url = new URL(request.url);
      if (
        url.pathname === "/health" &&
        request.method === "GET" &&
        !url.search
      ) {
        status = 200;
        return json({ status: "ok", mode: "mock-only", network: false }, 200);
      }
      if (request.method !== "POST")
        throw new GatewayError("METHOD_NOT_ALLOWED", 405);
      if (url.search || !ROUTES.has(url.pathname) || request.url.includes("%"))
        throw new GatewayError("ROUTE_NOT_ALLOWED", 404);
      operation = ROUTES.get(url.pathname);
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const bytes = await bodyBytes(request, maxBodyBytes, controller.signal);
      lease = boundary.authorize(
        request.headers,
        request.method,
        url.pathname,
        bytes,
      );
      let input;
      try {
        input = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new GatewayError("INVALID_JSON");
      }
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new GatewayError("INVALID_JSON");
      if (
        Object.keys(input).some((k) =>
          [
            "tenantid",
            "accountid",
            "environment",
            "credentialversion",
            "clientid",
            "password",
            "apikey",
            "token",
            "authorization",
            "signingkey",
            "url",
            "upstream",
          ].includes(k.toLowerCase()),
        )
      )
        throw new GatewayError("CLIENT_SCOPE_OR_SECRET_NOT_ALLOWED");
      if (
        operation === "search" &&
        Object.keys(input).some(
          (k) =>
            ![
              "origin",
              "destination",
              "departureDate",
              "returnDate",
              "adults",
              "children",
              "infants",
              "cabinClass",
              "tripType",
              "currency",
              "legs",
              "fareType",
            ].includes(k),
        )
      )
        throw new GatewayError("UNKNOWN_SEARCH_FIELD");
      // Service budgets are shorter than the HTTP envelope. Do not release a lease
      // early while service work is still executing; the server handles disconnects.
      if (controller.signal.aborted)
        throw new GatewayError("REQUEST_TIMEOUT", 504);
      work = Promise.resolve().then(() =>
        service.execute(lease.principal, operation, input),
      );
      const timeout = new Promise((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new GatewayError("REQUEST_TIMEOUT", 504)),
          { once: true },
        );
      });
      const result = await Promise.race([work, timeout]);
      if (controller.signal.aborted)
        throw new GatewayError("REQUEST_TIMEOUT", 504);
      const output = JSON.stringify({ data: result, requestId });
      if (Buffer.byteLength(output) > maxResponseBytes)
        throw new GatewayError("RESPONSE_TOO_LARGE", 502);
      // Defense-in-depth: the gateway can never proxy Signature/token bodies.
      if (
        /"(?:token|password|apikey|clientid|authorization|tui|signature|signingkey)"\s*:/i.test(
          output,
        )
      )
        throw new GatewayError("UNSAFE_RESPONSE", 502);
      status = 200;
      return new Response(output, {
        status,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      const code =
        error instanceof GatewayError
          ? error.code
          : SAFE_CODES.has(error?.code)
            ? error.code
            : "GATEWAY_FAILURE";
      status =
        error instanceof GatewayError
          ? error.status
          : code === "TIMEOUT"
            ? 504
            : code === "RATE_LIMITED"
              ? 429
              : ["CAPACITY", "DISABLED"].includes(code)
                ? 503
                : ["OFFER_NOT_FOUND", "OFFER_EXPIRED"].includes(code)
                  ? 410
                  : code === "INVALID_REQUEST"
                    ? 400
                    : 502;
      return json({ error: code, requestId }, status);
    } finally {
      if (timer) clearTimeout(timer);
      if (work) {
        work.then(
          () => lease?.release(),
          () => lease?.release(),
        );
      } else lease?.release();
      try {
        logger({
          event: "akbar_gateway",
          requestId,
          operation,
          status,
          durationMs: Math.round(performance.now() - start),
        });
      } catch {}
    }
  };
}
