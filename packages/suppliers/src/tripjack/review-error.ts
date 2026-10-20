import { SupplierError } from "../riya/client.js";

export type ReviewErrorCode = "REVIEW_ROUTE_UNAVAILABLE" | "REVIEW_AUTH_FAILED" | "REVIEW_RATE_LIMITED" | "REVIEW_TIMEOUT" | "REVIEW_UNAVAILABLE" | "REVIEW_REJECTED" | "REVIEW_INVALID_RESPONSE" | "FARE_EXPIRED";

export class TripjackReviewError extends SupplierError {
  // TripJack's own error text/codes (bounded), for operator logs only.
  supplierMessage?: string;
  supplierErrorCodes?: string[];
  constructor(public code: ReviewErrorCode, status: number, public requestId: string) {
    super("TRIPJACK", status, code === "FARE_EXPIRED" ? "Fare has expired" : "Unable to verify this fare right now");
  }
}

export function reviewFailure(status: number, body: unknown, requestId: string): TripjackReviewError {
  const data = body as { errors?: Array<{ errCode?: unknown; message?: unknown }>; status?: { statusMessage?: unknown } } | null;
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  // Log only bounded error codes, never API keys, passengers or raw response bodies.
  const codes = errors.map((e) => String(e?.errCode ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)).filter(Boolean).slice(0, 5);
  const messages = [data?.status?.statusMessage, ...errors.map((e) => e?.message)].filter((v) => typeof v === "string").join(" ");
  const explicitExpiry = /\b(?:fare|price|booking session)\s+(?:has\s+|is\s+)?expired\b|\bfare\s+(?:is\s+)?no longer available\b|\bsold[ -]?out\b/i.test(messages);
  // A 404 that carries TripJack's JSON error body means TripJack no longer knows
  // this priceId (already reviewed or stale), not that the route is missing.
  const supplierAnswered = errors.length > 0 || (!!data?.status && typeof data.status === "object");
  const code: ReviewErrorCode = status === 404 ? (supplierAnswered ? "FARE_EXPIRED" : "REVIEW_ROUTE_UNAVAILABLE")
    : status === 401 || status === 403 ? "REVIEW_AUTH_FAILED"
    : status === 429 ? "REVIEW_RATE_LIMITED"
    : status === 408 || status === 504 ? "REVIEW_TIMEOUT"
    : status >= 500 ? "REVIEW_UNAVAILABLE"
    : explicitExpiry ? "FARE_EXPIRED" : "REVIEW_REJECTED";
  console.error("[tripjack-review]", JSON.stringify({ requestId, httpStatus: status, code, supplierErrorCodes: codes }));
  const err = new TripjackReviewError(code, status, requestId);
  err.supplierMessage = messages.slice(0, 300) || undefined;
  err.supplierErrorCodes = codes.length ? codes : undefined;
  return err;
}
