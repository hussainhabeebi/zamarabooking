// Stores raw supplier API exchanges for certification logs.
//
// Each exchange becomes two separate R2 files:
//   <prefix>/<time>-<seq>-<endpoint>-request.json   exact URL, method, headers (incl. apikey) and body sent
//   <prefix>/<time>-<seq>-<endpoint>-response.json  exact response text received — never re-serialised
// (a non-JSON response keeps its raw text and gets a .txt name), plus an index row in
// supplier_exchanges so admin can list them per booking or search.

import type { ExchangeRecorder, SupplierExchange } from "@poomas/suppliers";
import { supplierExchanges } from "@poomas/db/schema";
import type { Env, Variables } from "../types.js";

export interface ExchangeCollector { recorder: ExchangeRecorder; exchanges: SupplierExchange[] }

export function collectExchanges(): ExchangeCollector {
  const exchanges: SupplierExchange[] = [];
  return { exchanges, recorder: (x) => { exchanges.push(x); } };
}

export async function persistExchanges(
  env: Pick<Env, "DOCUMENTS_R2">,
  db: Variables["db"],
  tenantId: string,
  exchanges: SupplierExchange[],
  link: { bookingId?: string | null; searchId?: string | null; requestId?: string | null },
): Promise<void> {
  if (!exchanges.length) return;
  const scope = link.bookingId ? `booking-${link.bookingId}` : link.searchId ? `search-${link.searchId}` : `request-${link.requestId ?? "unlinked"}`;
  const prefix = `api-logs/${tenantId}/${scope}`;
  for (const [i, x] of exchanges.entries()) {
    try {
      const stamp = x.startedAt.replace(/[:.]/g, "-");
      const slug = x.endpoint.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-");
      const base = `${prefix}/${stamp}-${String(i + 1).padStart(2, "0")}-${slug}`;

      let parsedRequest: unknown = x.requestBody;
      try { parsedRequest = JSON.parse(x.requestBody); } catch {}
      const requestKey = `${base}-request.json`;
      // The apikey stays (TripJack certification needs it); our gateway secret never does.
      const headers = Object.fromEntries(Object.entries(x.requestHeaders).filter(([k]) => k.toLowerCase() !== "x-poomas-gateway-key"));
      await env.DOCUMENTS_R2.put(requestKey, JSON.stringify({
        method: x.method, url: x.url, headers, body: parsedRequest, sentAt: x.startedAt,
      }, null, 2), { httpMetadata: { contentType: "application/json" } });

      let responseKey: string | null = null;
      if (x.responseBody !== null) {
        let isJson = true;
        try { JSON.parse(x.responseBody); } catch { isJson = false; }
        responseKey = `${base}-response.${isJson ? "json" : "txt"}`;
        await env.DOCUMENTS_R2.put(responseKey, x.responseBody, {
          httpMetadata: { contentType: isJson ? "application/json" : "text/plain; charset=utf-8" },
          customMetadata: { httpStatus: String(x.status ?? ""), responseHeaders: JSON.stringify(x.responseHeaders).slice(0, 1800) },
        });
      }

      await db.insert(supplierExchanges).values({
        tenantId, bookingId: link.bookingId ?? null, searchId: link.searchId ?? null, requestId: link.requestId ?? null,
        supplier: x.supplier, endpoint: x.endpoint, url: x.url, httpStatus: x.status, durationMs: x.durationMs,
        error: x.error ?? null, requestKey, responseKey, startedAt: new Date(x.startedAt),
      });
    } catch (err) {
      console.error(`[api-exchanges] failed to store ${x.endpoint} log`, err);
    }
  }
}

// Keeps the write alive after the response when a Worker execution context exists.
export function persistInBackground(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }, work: Promise<void>) {
  try { c.executionCtx.waitUntil(work); } catch { void work; }
}
