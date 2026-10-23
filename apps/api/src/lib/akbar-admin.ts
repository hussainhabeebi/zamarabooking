// Metadata only. Never returns legacy KV credentials or contacts Akbar/the gateway.
import type { Env } from "../types.js";
import { getAkbarSettings, saveAkbarSettings } from "./flight-sources.js";

export async function akbarAdminStatus(env: Env, tenantId: string) {
  const saved = await getAkbarSettings(env, tenantId);
  return {
    supplier: "AKBAR",
    name: "Akbar Travels / Benzy Infotech",
    environment: "UAT",
    authentication: "Signature + Bearer Token",
    mode: "MOCK_ONLY",
    priority:
      Number.isInteger(saved.priority) &&
      saved.priority! >= 1 &&
      saved.priority! <= 1000
        ? saved.priority!
        : 100,
    configured: false,
    configurationStatus: "GATEWAY_NOT_CONFIGURED",
    submittedIp: "156.67.110.188",
    whitelistingStatus: "PENDING_CONFIRMATION",
    connected: false,
    health: "NOT_VERIFIED",
    lastTestAt: null,
    connectionTestSupported: false,
    blockers: [
      "Whitelisting and UAT approval pending",
      "Secure gateway connectivity is not configured",
      "Real UAT transport is not implemented",
    ],
    enabled: false,
    searchStatus: "DISABLED",
    bookingEnabled: false,
    ticketingEnabled: false,
    paymentEnabled: false,
  };
}

export async function saveAkbarPriority(
  env: Env,
  tenantId: string,
  priority: number,
) {
  const saved = await getAkbarSettings(env, tenantId);
  // Preserve legacy configuration without treating it as a usable secret store.
  await saveAkbarSettings(env, tenantId, {
    ...saved,
    enabled: false,
    environment: "UAT",
    priority,
  });
}
