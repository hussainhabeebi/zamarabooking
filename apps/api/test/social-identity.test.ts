import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT } from "jose";
import { Hono } from "hono";
import { verifySocialIdentity, hashProof } from "../src/lib/social-identity.js";
import { socialAuthRoutes } from "../src/routes/social-auth.js";
import { authMiddleware } from "../src/middleware/auth.js";

test("social identity verifies signature, issuer, audience, expiry and nonce", async (t) => {
  const keys = await generateKeyPair("RS256");
  const appleKeys = await generateKeyPair("ES256");
  const resolver = async () => keys.publicKey;
  const appleResolver = async () => appleKeys.publicKey;
  async function token(overrides: Record<string, unknown> = {}, provider: "google" | "apple" = "google") {
    const signingKey = provider === "apple" ? appleKeys.privateKey : keys.privateKey;
    return new SignJWT({ sub: "provider-user", nonce: "nonce-1", email: "CUSTOMER@example.com", email_verified: true,
      iss: "https://accounts.google.com", aud: "client-1", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
      ...overrides }).setProtectedHeader({ alg: provider === "apple" ? "ES256" : "RS256" }).sign(signingKey);
  }
  await t.test("valid Google credential supplies verified email and stable subject", async () => {
    const identity = await verifySocialIdentity(await token(), "google", "client-1", "nonce-1", resolver);
    assert.equal(identity.email, "customer@example.com");
    assert.equal(identity.subject, "provider-user");
  });
  for (const [name, overrides] of Object.entries({
    issuer: { iss: "https://attacker.example" }, audience: { aud: "another-app" }, nonce: { nonce: "other-session" },
    expired: { exp: 1 }, missingExpiry: { exp: undefined }, oldToken: { iat: 1 }, missingSubject: { sub: undefined },
  })) await t.test(`rejects ${name}`, async () => {
    await assert.rejects(verifySocialIdentity(await token(overrides), "google", "client-1", "nonce-1", resolver));
  });
  await t.test("rejects forged signature", async () => {
    const attacker = await generateKeyPair("RS256");
    await assert.rejects(verifySocialIdentity(await token(), "google", "client-1", "nonce-1", async () => attacker.publicKey));
  });
  await t.test("unverified email is not used to create/link an account", async () => {
    assert.equal((await verifySocialIdentity(await token({ email_verified: false }), "google", "client-1", "nonce-1", resolver)).email, null);
  });
  await t.test("Apple returning identity may omit email", async () => {
    const identity = await verifySocialIdentity(await token({ iss: "https://appleid.apple.com", email: undefined }, "apple"), "apple", "client-1", "nonce-1", appleResolver);
    assert.equal(identity.subject, "provider-user"); assert.equal(identity.email, null);
  });
  await t.test("Apple RSA identity signatures are accepted", async () => {
    const identity = await verifySocialIdentity(await token({ iss: "https://appleid.apple.com" }), "apple", "client-1", "nonce-1", resolver);
    assert.equal(identity.subject, "provider-user");
  });
  await t.test("Apple verified relay email is accepted", async () => {
    const identity = await verifySocialIdentity(await token({ iss: "https://appleid.apple.com", email: "relay@privaterelay.appleid.com", email_verified: "true" }, "apple"), "apple", "client-1", "nonce-1", appleResolver);
    assert.equal(identity.email, "relay@privaterelay.appleid.com");
  });
});

test("social endpoint fails safely before database access when disabled or wrong origin", async () => {
  const app = new Hono(); app.route("/social", socialAuthRoutes);
  const providers = await app.request("/social/providers", {}, {});
  assert.deepEqual(await providers.json(), { google: false, apple: false });
  const body = JSON.stringify({ provider: "google", proofHash: await hashProof("browser-secret") });
  const denied = await app.request("/social/start", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body }, {});
  assert.equal(denied.status, 403);
  const disabled = await app.request("/social/start", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://flypoomas.com" }, body }, {});
  assert.equal(disabled.status, 503);
});

test("customer social token is tenant-bound and cannot reach agent/admin routes", async () => {
  const secret = "test-only-secret";
  const jwt = await new SignJWT({ userId: "u1", tenantId: "tenant-1", role: "CUSTOMER", scope: "customer-profile", sessionId: "session-1" })
    .setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode(secret));
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("tenantId" as never, (c.req.header("test-tenant") ?? "tenant-1") as never); await next(); });
  app.use("*", authMiddleware as any);
  app.get("*", (c) => c.json({ ok: true }));
  for (const route of ["/api/admin/settings", "/api/bookings/", "/api/wallet/", "/api/agents/"]) {
    const r = await app.request(route, { headers: { Authorization: `Bearer ${jwt}` } }, { JWT_SECRET: secret });
    assert.equal(r.status, 403, route);
  }
  const profile = await app.request("/api/profile/passengers", { headers: { Authorization: `Bearer ${jwt}` } }, { JWT_SECRET: secret, SESSIONS_KV: { get: async () => ({ sessionId: "session-1", tenantId: "tenant-1" }) } });
  assert.equal(profile.status, 200);
  const revoked = await app.request("/api/profile/passengers", { headers: { Authorization: `Bearer ${jwt}` } }, { JWT_SECRET: secret, SESSIONS_KV: { get: async () => null } });
  assert.equal(revoked.status, 401);
  const otherTenant = await app.request("/api/profile/passengers", { headers: { Authorization: `Bearer ${jwt}`, "test-tenant": "tenant-2" } }, { JWT_SECRET: secret });
  assert.equal(otherTenant.status, 403);
});
