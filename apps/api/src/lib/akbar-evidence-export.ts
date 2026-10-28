import { HTTPException } from "hono/http-exception";
import { redactAkbarJson } from "./akbar-evidence.js";

type Row = { id: string; tenantId: string; supplier: string; bookingId: string | null; searchId: string | null;
  endpoint: string; httpStatus: number | null; durationMs: number | null; startedAt: Date;
  requestKey: string; responseKey: string | null };
type Booking = { id: string; tenantId: string; supplier: string | null; flightData: unknown };

// Reads existing evidence only. Never invokes a supplier, fills missing files, or
// treats a search-linked response as a booking operation. No inferred identifiers.
export async function akbarEvidencePack(
  bucket: Pick<R2Bucket, "get">, booking: Booking, rows: Row[],
) {
  if (booking.supplier !== "AKBAR") throw new HTTPException(400, { message: "Akbar booking required" });
  if (rows.length > 500) throw new HTTPException(413, { message: "Too many exchanges; narrow the evidence scope" });
  const searchId = (booking.flightData as { searchId?: unknown } | null)?.searchId;
  const files: { name: string; data: Uint8Array; date: Date }[] = [];
  const index: Record<string, unknown>[] = [];
  const enc = new TextEncoder();
  let total = 0;
  for (const [i, row] of rows.entries()) {
    // Defense in depth beyond the route's tenant/supplier/link predicate.
    if (row.tenantId !== booking.tenantId || row.supplier !== "AKBAR" ||
        !(row.bookingId === booking.id || (typeof searchId === "string" && row.searchId === searchId))) {
      throw new HTTPException(403, { message: "Exchange outside booking evidence scope" });
    }
    const prefix = `api-logs/${booking.tenantId}/`;
    const stem = `${String(i + 1).padStart(3, "0")}-${row.endpoint.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 90)}`;
    const parts: Record<string, unknown> = {};
    for (const [part, key] of [["request", row.requestKey], ["response", row.responseKey]] as const) {
      if (!key) { parts[part] = { present: false }; continue; }
      if (!key.startsWith(prefix)) throw new HTTPException(403, { message: "Storage object outside tenant scope" });
      const obj = await bucket.get(key);
      if (!obj) { parts[part] = { present: false, missingStoredObject: true }; continue; }
      if (obj.size > 2_097_152) throw new HTTPException(413, { message: "Evidence object exceeds size limit" });
      const data = enc.encode(redactAkbarJson(await obj.text()));
      total += data.length;
      if (total > 10_485_760) throw new HTTPException(413, { message: "Evidence archive exceeds size limit" });
      const name = `${stem}-${part}.json`;
      files.push({ name, data, date: row.startedAt });
      parts[part] = { present: true, file: name, sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data))).map((b) => b.toString(16).padStart(2, "0")).join("") };
    }
    index.push({ exchangeId: row.id, endpoint: row.endpoint, httpStatus: row.httpStatus,
      durationMs: row.durationMs, startedAt: row.startedAt,
      scope: row.bookingId === booking.id ? "booking" : "linked-search", ...parts });
  }
  const manifest = {
    supplier: "AKBAR", bookingId: booking.id, environment: "UNVERIFIED",
    certificationReady: false, format: "sanitized-existing-evidence-v1",
    warning: "Existing recorded exchanges only. Credentials and passenger fields are redacted; non-JSON bodies are withheld. This is not proof of successful UAT booking, complete coverage or provider certification. No missing supplier calls or identifiers are fabricated.",
    normalizedIdentifiers: null, identifierMapping: "Not normalized: inspect genuine supplier responses; CreateItinerary contract remains unverified.",
    exchanges: index,
  };
  files.unshift({ name: "AkbarEvidenceManifest.json", data: enc.encode(JSON.stringify(manifest, null, 2)), date: new Date() });
  return files;
}
