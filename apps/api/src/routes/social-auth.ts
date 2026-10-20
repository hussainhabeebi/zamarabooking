import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { SignJWT } from "jose";
import { and, eq, gt, lt } from "drizzle-orm";
import { users, socialAuthChallenges } from "@poomas/db/schema";
import { hashProof, verifySocialIdentity, type SocialProvider } from "../lib/social-identity.js";
import type { Env, Variables } from "../types.js";

export const socialAuthRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
const providerSchema = z.enum(["google", "apple"]);

function configuration(env: Env, provider: SocialProvider) {
  if (provider === "google" && env.GOOGLE_CLIENT_ID) return { clientId: env.GOOGLE_CLIENT_ID };
  if (provider === "apple" && env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET && env.APPLE_REDIRECT_URI) {
    return { clientId: env.APPLE_CLIENT_ID, redirectUri: env.APPLE_REDIRECT_URI };
  }
  return null;
}

socialAuthRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const origin = c.req.header("Origin");
  const allowed = (c.env.SOCIAL_AUTH_ORIGINS ?? "https://flypoomas.com,https://www.flypoomas.com").split(",").map((x) => x.trim());
  if (c.req.method === "POST" && (!origin || !allowed.includes(origin))) {
    throw new HTTPException(403, { message: "Sign-in origin is not allowed" });
  }
  await next();
});

socialAuthRoutes.get("/providers", (c) => c.json({
  google: Boolean(configuration(c.env, "google")),
  apple: Boolean(configuration(c.env, "apple")),
}));

socialAuthRoutes.post("/start", zValidator("json", z.object({
  provider: providerSchema, proofHash: z.string().regex(/^[a-f0-9]{64}$/),
})), async (c) => {
  const { provider, proofHash } = c.req.valid("json");
  const config = configuration(c.env, provider);
  if (!config) throw new HTTPException(503, { message: "This sign-in option is not configured yet. Continue as a guest." });
  const id = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const db = c.get("db");
  await db.insert(socialAuthChallenges).values({
    id, tenantId: c.get("tenantId"), provider, nonce, proofHash,
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });
  c.executionCtx.waitUntil(db.delete(socialAuthChallenges).where(lt(socialAuthChallenges.expiresAt, new Date())).then(() => {}));
  return c.json({ challengeId: id, nonce, ...config });
});

socialAuthRoutes.post("/complete", zValidator("json", z.object({
  provider: providerSchema,
  challengeId: z.string().uuid(),
  proof: z.string().min(32).max(256),
  idToken: z.string().min(10).max(16384),
  code: z.string().max(4096).optional(),
  state: z.string().max(128).optional(),
  name: z.string().max(100).optional(),
})), async (c) => {
  const body = c.req.valid("json");
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const config = configuration(c.env, body.provider);
  if (!config) throw new HTTPException(503, { message: "Sign-in is not configured" });
  // Atomic DELETE ... RETURNING enforces single use, including concurrent replays.
  const [challenge] = await db.delete(socialAuthChallenges).where(and(
    eq(socialAuthChallenges.id, body.challengeId), eq(socialAuthChallenges.tenantId, tenantId),
    eq(socialAuthChallenges.provider, body.provider), eq(socialAuthChallenges.proofHash, await hashProof(body.proof)),
    gt(socialAuthChallenges.expiresAt, new Date()),
  )).returning();
  if (!challenge) throw new HTTPException(401, { message: "Sign-in session expired. Please try again." });

  let identity;
  try {
    identity = await verifySocialIdentity(body.idToken, body.provider, config.clientId, challenge.nonce);
    if (body.provider === "apple") {
      if (!body.code || body.state !== body.challengeId) throw new Error("Missing Apple code/state");
      const response = await fetch("https://appleid.apple.com/auth/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: c.env.APPLE_CLIENT_SECRET!,
          code: body.code, grant_type: "authorization_code", redirect_uri: c.env.APPLE_REDIRECT_URI! }),
        signal: AbortSignal.timeout(10000),
      });
      const tokens = await response.json() as { id_token?: string };
      if (!response.ok || !tokens.id_token) throw new Error("Apple code rejected");
      const exchanged = await verifySocialIdentity(tokens.id_token, "apple", config.clientId, challenge.nonce);
      if (exchanged.subject !== identity.subject) throw new Error("Apple identity mismatch");
    }
  } catch {
    // Do not log tokens, authorization codes or provider PII.
    throw new HTTPException(401, { message: "Could not verify your sign-in. Please try again or continue as a guest." });
  }

  const identityWhere = and(eq(users.tenantId, tenantId), eq(users.socialProvider, body.provider), eq(users.socialSubject, identity.subject));
  let [user] = await db.select().from(users).where(identityWhere).limit(1);
  if (!user) {
    if (!identity.email || !z.string().email().safeParse(identity.email).success) {
      throw new HTTPException(401, { message: "A verified email is required to create an account." });
    }
    // Never link an existing password/admin account merely because email matches.
    const inserted = await db.insert(users).values({
      tenantId, email: identity.email, name: identity.name ?? body.name ?? "Traveller",
      socialProvider: body.provider, socialSubject: identity.subject,
      role: "CUSTOMER", isActive: true, emailVerified: true,
    }).onConflictDoNothing().returning();
    user = inserted[0] ?? (await db.select().from(users).where(identityWhere).limit(1))[0];
    if (!user) throw new HTTPException(409, { message: "This email already has an account. Use your existing sign-in method or continue as a guest." });
  }
  if (!user.isActive || user.role !== "CUSTOMER") throw new HTTPException(403, { message: "Customer sign-in unavailable for this account." });

  const sessionId = crypto.randomUUID();
  const token = await new SignJWT({ userId: user.id, tenantId, role: "CUSTOMER", scope: "customer-profile", sessionId })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("24h")
    .sign(new TextEncoder().encode(c.env.JWT_SECRET));
  await c.env.SESSIONS_KV.put(`session:${user.id}`, JSON.stringify({ userId: user.id, tenantId, role: "CUSTOMER", sessionId }), { expirationTtl: 86400 });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  return c.json({ token, expiresIn: 86400, customer: { name: user.name, email: user.email } });
});
