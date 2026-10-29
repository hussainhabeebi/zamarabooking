import type { Env } from "../../types.js";
import { PhonePeClient, PhonePeError } from "./client.js";
export function phonePeReturnOrigin(env: Env): string | null {
  const value =
    env.PHONEPE_RETURN_ORIGIN ||
    (env.PHONEPE_ENVIRONMENT === "production"
      ? "https://zamrabooking.com"
      : "");
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash &&
      (!u.port || u.port === "443")
      ? u.origin
      : null;
  } catch {
    return null;
  }
}
export async function phonePeReadiness(env: Env, tenantId: string) {
  const raw = (await env.TENANT_CACHE_KV.get(
    `admin_settings:${tenantId}:phonepe`,
    "json",
  )) as { enabled?: boolean } | null;
  const configured = Boolean(
    phonePeReturnOrigin(env) &&
    env.PHONEPE_CLIENT_ID &&
    env.PHONEPE_CLIENT_SECRET &&
    env.PHONEPE_CLIENT_VERSION &&
    env.PHONEPE_MERCHANT_ID &&
    env.PHONEPE_WEBHOOK_USERNAME &&
    env.PHONEPE_WEBHOOK_PASSWORD &&
    env.PHONEPE_TENANT_ID === tenantId,
  );
  const environment =
    env.PHONEPE_ENVIRONMENT === "production" ? "production" : "sandbox";
  const gatesReady =
    (env.ENVIRONMENT !== "production" ||
      env.PHONEPE_ENVIRONMENT === "production") &&
    ["sandbox", "production"].includes(env.PHONEPE_ENVIRONMENT ?? "sandbox") &&
    configured &&
    env.PHONEPE_RELEASE_APPROVED === "true" &&
    env.PHONEPE_SCHEMA_READY === "true" &&
    env.PHONEPE_MERCHANT_ACTIVE === "true" &&
    (environment !== "production" ||
      env.PHONEPE_PRODUCTION_APPROVED === "true");
  return {
    enabled: raw?.enabled === true && gatesReady,
    requestedEnabled: raw?.enabled === true,
    configured,
    gatesReady,
    environment,
    connectionHealth: "NOT_VERIFIED",
    currency: "INR",
    webhookMode: "SHA256",
    supplierConfirmation: "SEPARATE",
  } as const;
}
export async function phonePeClient(
  env: Env,
  tenantId: string,
  reconcile = false,
) {
  const r = await phonePeReadiness(env, tenantId);
  if (!r.gatesReady || (!r.enabled && !reconcile))
    throw new PhonePeError("DISABLED");
  return new PhonePeClient({
    tenantId,
    environment: r.environment,
    clientId: env.PHONEPE_CLIENT_ID!,
    clientSecret: env.PHONEPE_CLIENT_SECRET!,
    clientVersion: env.PHONEPE_CLIENT_VERSION!,
  });
}
