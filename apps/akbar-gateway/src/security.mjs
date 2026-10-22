import { createHash, createHmac, timingSafeEqual } from "node:crypto";
export const ROUTES = new Map([
  ["/v1/akbar/search", "search"],
  ["/v1/akbar/price", "price"],
]);
export class GatewayError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export function canonical({
  audience,
  keyId,
  timestamp,
  nonce,
  method,
  path,
  body,
}) {
  return [
    "zamra-akbar-v1",
    audience,
    keyId,
    timestamp,
    nonce,
    method,
    path,
    createHash("sha256").update(body).digest("hex"),
  ].join("\n");
}
export function signRequest(key, fields) {
  return createHmac("sha256", key).update(canonical(fields)).digest("hex");
}
export function principalsFromConfig(values) {
  if (!Array.isArray(values) || !values.length || values.length > 100)
    throw new GatewayError("INVALID_CONFIG");
  const result = new Map(),
    usedKeys = new Set(),
    revisions = new Map();
  for (const item of values) {
    if (
      !item ||
      !["keyId", "tenantId", "accountId", "credentialVersion"].every(
        (k) =>
          typeof item[k] === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(item[k]),
      ) ||
      item.environment !== "UAT" ||
      typeof item.signingKey !== "string" ||
      item.signingKey.length < 32 ||
      result.has(item.keyId)
    )
      throw new GatewayError("INVALID_CONFIG");
    const scope = item.tenantId + ":" + item.accountId;
    if (
      usedKeys.has(item.signingKey) ||
      (revisions.has(scope) && revisions.get(scope) !== item.credentialVersion)
    )
      throw new GatewayError("INVALID_CONFIG");
    usedKeys.add(item.signingKey);
    revisions.set(scope, item.credentialVersion);
    result.set(item.keyId, { ...item });
  }
  return result;
}
export class SecurityBoundary {
  constructor({
    principals,
    audience,
    now = Date.now,
    replayCapacity = 10000,
    perMinute = 30,
    maxInFlight = 16,
  }) {
    if (
      !/^[A-Za-z0-9_.:-]{1,200}$/.test(audience) ||
      !(principals instanceof Map) ||
      principals.size < 1
    )
      throw new GatewayError("INVALID_CONFIG");
    if (
      ![replayCapacity, perMinute, maxInFlight].every(
        (n) => Number.isInteger(n) && n > 0,
      )
    )
      throw new GatewayError("INVALID_CONFIG");
    this.principals = principals;
    this.audience = audience;
    this.now = now;
    this.replayCapacity = replayCapacity;
    this.perMinute = perMinute;
    this.maxInFlight = maxInFlight;
    this.nonces = new Map();
    this.rates = new Map();
    this.active = new Map();
    this.inFlight = 0;
  }
  authorize(headers, method, path, body) {
    const keyId = headers.get("x-zamra-key-id") ?? "",
      timestamp = headers.get("x-zamra-timestamp") ?? "",
      nonce = headers.get("x-zamra-nonce") ?? "",
      signature = headers.get("x-zamra-signature") ?? "";
    const p = this.principals.get(keyId);
    if (
      !p ||
      !/^\d{13}$/.test(timestamp) ||
      Math.abs(this.now() - Number(timestamp)) > 30000 ||
      !/^[A-Za-z0-9_-]{20,100}$/.test(nonce) ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      throw new GatewayError("AUTHENTICATION_FAILED", 401);
    const expected = signRequest(p.signingKey, {
      audience: this.audience,
      keyId,
      timestamp,
      nonce,
      method,
      path,
      body,
    });
    if (
      !timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(expected, "hex"),
      )
    )
      throw new GatewayError("AUTHENTICATION_FAILED", 401);
    for (const [id, expiry] of this.nonces)
      if (expiry <= this.now()) this.nonces.delete(id);
    const replayKey = keyId + ":" + nonce;
    if (this.nonces.has(replayKey))
      throw new GatewayError("REPLAY_REJECTED", 409);
    if (this.nonces.size >= this.replayCapacity)
      throw new GatewayError("REPLAY_CAPACITY", 503);
    this.nonces.set(replayKey, this.now() + 65000);
    // Rate/concurrency limits aggregate across signing-key rotation for one scope.
    const scope = [p.tenantId, p.accountId, p.credentialVersion].join(":");
    const minute = Math.floor(this.now() / 60000),
      rate = this.rates.get(scope);
    if (rate?.minute === minute && rate.count >= this.perMinute)
      throw new GatewayError("RATE_LIMITED", 429);
    this.rates.set(scope, {
      minute,
      count: rate?.minute === minute ? rate.count + 1 : 1,
    });
    if (this.inFlight >= this.maxInFlight || (this.active.get(scope) ?? 0) >= 2)
      throw new GatewayError("BUSY", 503);
    this.inFlight++;
    this.active.set(scope, (this.active.get(scope) ?? 0) + 1);
    let released = false;
    return {
      principal: p,
      release: () => {
        if (!released) {
          released = true;
          this.inFlight--;
          this.active.set(scope, this.active.get(scope) - 1);
        }
      },
    };
  }
}
