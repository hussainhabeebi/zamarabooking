export type AkbarErrorCode =
  | "DISABLED"
  | "AUTH"
  | "ACCESS_DENIED"
  | "UNAUTHORIZED"
  | "EXPIRED_TOKEN"
  | "ACCOUNT_ACTION_REQUIRED"
  | "FARE_CHANGED"
  | "PENDING_UNVERIFIED"
  | "TIMEOUT"
  | "UPSTREAM"
  | "RATE_LIMITED"
  | "INVALID_RESPONSE"
  | "UNSUPPORTED"
  | "INVALID_REQUEST"
  | "CAPACITY"
  | "OFFER_EXPIRED"
  | "OFFER_NOT_FOUND";
export class AkbarError extends Error {
  constructor(
    readonly code: AkbarErrorCode,
    readonly retryable = false,
  ) {
    super(`Akbar ${code}`);
    this.name = "AkbarError";
  }
}
/** Only Codes verified in WRC Signature/GetSPricer pages are classified. */
export function classifyAkbarCode(operation: string, value: unknown): void {
  const code =
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (code === "200") return;
  if (operation === "GetSPricer" && code === "1500")
    throw new AkbarError("FARE_CHANGED");
  if (operation === "Signature") {
    if (["5501", "9003", "5086", "5073", "6039", "5087"].includes(code))
      throw new AkbarError("ACCOUNT_ACTION_REQUIRED");
    if (code === "5101") throw new AkbarError("AUTH");
    throw new AkbarError("AUTH");
  }
  // No undocumented “pending” or business token-expiry codes are guessed.
  throw new AkbarError("UPSTREAM");
}
