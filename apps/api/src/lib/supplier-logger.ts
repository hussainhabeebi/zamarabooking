import type { Db } from "@poomas/db";
import { supplierApiLogs } from "@poomas/db/schema";

export interface SupplierCallLog {
  tenantId:       string;
  supplier:       "TRIPJACK" | "RIYA" | "DUFFEL" | "GOOGLE_SERP";
  endpoint:       string;
  httpStatus?:    number;
  level:          "INFO" | "WARN" | "ERROR";
  requestId?:     string;
  requestSummary?: Record<string, unknown>;
  responseSnippet?: string;
  errorCode?:     string;
  errorMessage?:  string;
  durationMs?:    number;
}

export async function logSupplierCall(db: Db, entry: SupplierCallLog): Promise<void> {
  try {
    await db.insert(supplierApiLogs).values({
      tenantId:        entry.tenantId,
      supplier:        entry.supplier,
      endpoint:        entry.endpoint,
      httpStatus:      entry.httpStatus ?? null,
      level:           entry.level,
      requestId:       entry.requestId ?? null,
      requestSummary:  entry.requestSummary ?? null,
      responseSnippet: entry.responseSnippet ? entry.responseSnippet.slice(0, 800) : null,
      errorCode:       entry.errorCode ?? null,
      errorMessage:    entry.errorMessage ?? null,
      durationMs:      entry.durationMs ?? null,
    });
  } catch (err) {
    console.error("[supplier-logger] insert failed:", err instanceof Error ? err.message : String(err));
  }
}
