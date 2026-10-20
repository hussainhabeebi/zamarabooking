import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type SocialProvider = "google" | "apple";
const keys = {
  google: createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs")),
  apple: createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys")),
};

export async function hashProof(proof: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifySocialIdentity(
  token: string, provider: SocialProvider, clientId: string, nonce: string,
  key: JWTVerifyGetKey = keys[provider],
) {
  const { payload } = await jwtVerify(token, key, {
    issuer: provider === "google" ? ["https://accounts.google.com", "accounts.google.com"] : "https://appleid.apple.com",
    audience: clientId,
    // Accept Apple's RSA and EC signatures only against Apple's trusted JWKS.
    algorithms: provider === "google" ? ["RS256"] : ["RS256", "ES256"],
    requiredClaims: ["sub", "iat", "exp", "nonce"],
    maxTokenAge: "10m",
  });
  if (!payload.sub || payload.sub.length > 255 || payload.nonce !== nonce) throw new Error("Identity session mismatch");
  // Email is optional on returning Apple logins; identify accounts by issuer/sub.
  const verified = payload.email_verified === true || payload.email_verified === "true";
  const email = verified && typeof payload.email === "string" && payload.email.length <= 254
    ? payload.email.trim().toLowerCase() : null;
  return { subject: payload.sub, email, name: typeof payload.name === "string" ? payload.name.slice(0, 100) : null };
}
