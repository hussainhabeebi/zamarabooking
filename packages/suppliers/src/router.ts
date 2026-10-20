import type { NormalizedFare, SearchParams, SupplierAdapter, SupplierCredentials } from "./base.js";
import { RiyaAdapter }   from "./riya/adapter.js";
import { TripjackAdapter } from "./tripjack/adapter.js";
import { SerpAdapter }   from "./serp/adapter.js";
import { DuffelAdapter } from "./duffel/adapter.js";

export interface SupplierConfig {
  name:        "RIYA" | "TRIPJACK" | "GOOGLE_SERP" | "DUFFEL";
  isEnabled:   boolean;
  priority:    number;  // 1 = first, higher = later fallback
  credentials: SupplierCredentials | null;
  timeoutMs:   number;
  maxRetries:  number;
}

// Platform-level credential fallbacks (from Cloudflare Worker secrets).
// Tenant DB credentials always win; these fill the gap when a supplier is
// enabled but the tenant hasn't supplied their own API keys yet.
export interface PlatformCredentials {
  RIYA?:        { apiKey?: string; secretKey?: string; baseUrl?: string };
  TRIPJACK?:    { apiKey?: string; baseUrl?: string; omsBaseUrl?: string; proxyKey?: string };
  GOOGLE_SERP?: { apiKey?: string; baseUrl?: string };
  DUFFEL?:      { apiKey?: string };
}

export interface SearchResult {
  fares:          NormalizedFare[];
  usedSuppliers:  ("RIYA" | "TRIPJACK" | "GOOGLE_SERP" | "DUFFEL")[];
  isIndicative:   boolean;   // true if results came from SERP (non-bookable)
  errors:         Record<string, string>;
  // Diagnostic detail per supplier for operator logs (never shown to customers).
  diagnostics?:   Record<string, SupplierDiagnostic>;
}

export interface SupplierDiagnostic {
  ok:               boolean;
  fareCount:        number;
  durationMs:       number;
  endpoint?:        string;
  httpStatus?:      number;
  errorCode?:       string;
  errorMessage?:    string;
  responseSnippet?: string;
}

function diagnosticFromError(err: unknown, durationMs: number): SupplierDiagnostic {
  const e = (err ?? {}) as { message?: string; statusCode?: number; code?: string; endpoint?: string; responseSnippet?: string };
  const message = e.message ?? String(err);
  return {
    ok:              false,
    fareCount:       0,
    durationMs,
    endpoint:        e.endpoint,
    httpStatus:      typeof e.statusCode === "number" ? e.statusCode : undefined,
    errorCode:       e.code ?? (typeof e.statusCode === "number" ? `HTTP_${e.statusCode}` : /timed out/i.test(message) ? "TIMEOUT" : "SEARCH_FAILED"),
    errorMessage:    message,
    responseSnippet: e.responseSnippet,
  };
}

// Creates an adapter instance from config.
// Tenant DB credentials take priority; platform secrets fill any missing fields.
function buildAdapter(config: SupplierConfig, platform: PlatformCredentials = {}): SupplierAdapter {
  const platformFallback = (platform[config.name] ?? {}) as SupplierCredentials;
  const creds: SupplierCredentials = { ...platformFallback, ...(config.credentials ?? {}) };
  switch (config.name) {
    case "RIYA":        return new RiyaAdapter(creds);
    case "TRIPJACK":    return new TripjackAdapter(creds);
    case "GOOGLE_SERP": return new SerpAdapter(creds);
    case "DUFFEL":      return new DuffelAdapter(creds);
  }
}

// Wraps a supplier search with retries inside one strict interactive-search budget.
// Promise.race is intentional: not every supplier adapter accepts an AbortSignal, so
// an unresponsive upstream can never keep the entire results page waiting forever.
async function searchWithTimeout(
  adapter: SupplierAdapter,
  params: SearchParams,
  timeoutMs: number,
  maxRetries: number,
): Promise<NormalizedFare[]> {
  let lastError: Error | null = null;
  const totalBudgetMs = Math.min(Math.max(timeoutMs || 4_000, 2_500), 30_000);
  const deadline = Date.now() + totalBudgetMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Supplier timed out after ${totalBudgetMs}ms`)),
          remainingMs,
        );
      });
      return await Promise.race([adapter.search(params), timeout]);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const retryDelay = Math.min(500 * (attempt + 1), Math.max(0, deadline - Date.now()));
      if (attempt < maxRetries && retryDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw lastError ?? new Error(`Supplier timed out after ${totalBudgetMs}ms`);
}

// Deduplicates by flight number + departure time (same physical flight from both suppliers)
function deduplicate(fares: NormalizedFare[]): NormalizedFare[] {
  const seen = new Map<string, NormalizedFare>();

  for (const fare of fares) {
    // Journey (round trip / multi-city) fares keep one price per leg and fare type:
    // Special Return pairing needs both the SPECIAL_RETURN and PUBLISHED prices.
    const journey = fare.tripKey
      ? `${fare.tripKey}_${fare.fareIdentifier ?? ""}_${fare.sri ?? ""}_${fare.msri?.join("|") ?? ""}_${fare.segments?.map((s) => s.flightNumber).join("-") ?? ""}_`
      : "";
    const key = `${journey}${fare.flightNumber}_${fare.departureTime}_${fare.cabinClass}`;
    const existing = seen.get(key);

    if (!existing || fare.totalFare < existing.totalFare) {
      seen.set(key, fare);  // Keep cheapest when same flight appears from both suppliers
    }
  }

  return Array.from(seen.values()).sort((a, b) => a.totalFare - b.totalFare);
}

// Primary search router: runs ALL enabled suppliers concurrently ("available supplier wins").
//
// Priority rules:
//   • All bookable suppliers (Riya, TripJack, Duffel) run in parallel.
//   • SERP runs in parallel whenever it has credentials.
//   • If a supplier fails, we log the error and continue with the rest.
//   • Bookable results are deduplicated (cheapest wins per flight) then sorted by price.
//   • SERP fares that have no bookable equivalent are appended (labelled indicative).
//   • If ALL bookable suppliers return nothing, SERP results are used (isIndicative=true).
//   • "No flights found" is only returned after every available supplier has been checked.
export async function searchFares(
  params: SearchParams,
  supplierConfigs: SupplierConfig[],
  options: {
    platformCredentials?: PlatformCredentials;
    // Deprecated flags kept for backwards-compat; behaviour is now always "fan-out + fallback"
    allowSerpFallback?:    boolean;
    includeSerpParallel?:  boolean;
  } = {},
): Promise<SearchResult> {
  const platform = options.platformCredentials ?? {};

  const sorted = supplierConfigs
    .filter((c) => c.isEnabled)
    .sort((a, b) => a.priority - b.priority);

  const bookableConfigs = sorted.filter((c) => c.name !== "GOOGLE_SERP");
  const serpConfig      = sorted.find((c)  => c.name === "GOOGLE_SERP");

  const allFares: NormalizedFare[]                   = [];
  const usedSuppliers: SearchResult["usedSuppliers"] = [];
  const errors: Record<string, string>               = {};
  const diagnostics: Record<string, SupplierDiagnostic> = {};

  // Run SERP concurrently with bookable suppliers (whenever it has credentials)
  const serpFaresPromise = serpConfig
    ? (async () => {
        const startedAt = Date.now();
        try {
          const adapter = buildAdapter(serpConfig, platform);
          const fares = await searchWithTimeout(adapter, params, serpConfig.timeoutMs, 1);
          diagnostics["GOOGLE_SERP"] = { ok: true, fareCount: fares.length, durationMs: Date.now() - startedAt };
          return fares;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors["GOOGLE_SERP"] = msg;
          diagnostics["GOOGLE_SERP"] = diagnosticFromError(err, Date.now() - startedAt);
          console.error(`[search] GOOGLE_SERP failed: ${msg}`);
          return [] as NormalizedFare[];
        }
      })()
    : Promise.resolve([] as NormalizedFare[]);

  // All bookable suppliers run in parallel — one failure must not block the others
  const settled = await Promise.allSettled(
    bookableConfigs.map(async (config) => {
      const startedAt = Date.now();
      try {
        const adapter = buildAdapter(config, platform);
        const fares   = await searchWithTimeout(adapter, params, config.timeoutMs, config.maxRetries);
        diagnostics[config.name] = { ok: true, fareCount: fares.length, durationMs: Date.now() - startedAt };
        return { supplier: config.name, fares };
      } catch (err) {
        diagnostics[config.name] = diagnosticFromError(err, Date.now() - startedAt);
        throw err;
      }
    }),
  );

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === "fulfilled") {
      allFares.push(...result.value.fares);
      usedSuppliers.push(result.value.supplier as SearchResult["usedSuppliers"][number]);
    } else {
      const name = bookableConfigs[i].name;
      const msg  = result.reason?.message ?? "Unknown error";
      errors[name] = msg;
      console.error(`[search] ${name} failed: ${msg}`);
    }
  }

  const serpFares = await serpFaresPromise;

  // ── Bookable results exist ──────────────────────────────────────────────
  if (allFares.length > 0) {
    const deduped = deduplicate(allFares);

    if (serpFares.length > 0) {
      // Append SERP fares that have no bookable equivalent (unique routes/flights)
      const bookableKeys = new Set(deduped.map((f) => `${f.flightNumber}_${f.departureTime}`));
      const serpOnly     = serpFares.filter((f) => !bookableKeys.has(`${f.flightNumber}_${f.departureTime}`));

      if (serpOnly.length > 0) usedSuppliers.push("GOOGLE_SERP");

      return {
        fares:        [...deduped, ...serpOnly].sort((a, b) => a.totalFare - b.totalFare),
        usedSuppliers,
        isIndicative: serpOnly.length > 0,
        errors,
        diagnostics,
      };
    }

    return { fares: deduped, usedSuppliers, isIndicative: false, errors, diagnostics };
  }

  // ── No bookable results — use SERP (parallel results already in hand, or retry) ──
  if (serpFares.length > 0) {
    return {
      fares:         serpFares.sort((a, b) => a.totalFare - b.totalFare),
      usedSuppliers: ["GOOGLE_SERP"],
      isIndicative:  true,
      errors,
      diagnostics,
    };
  }

  // If SERP wasn't already running in parallel, try it now as a last-resort fallback
  if (!serpConfig && options.allowSerpFallback) {
    // No SERP config at all — nothing more to try
  } else if (serpConfig && serpFares.length === 0 && !errors["GOOGLE_SERP"]) {
    // SERP ran but returned 0 fares — already captured above
  }

  return { fares: [], usedSuppliers: [], isIndicative: false, errors, diagnostics };
}

// Gets the right bookable adapter for post-search operations (hold, book, cancel)
// Always uses the supplier that generated the fare (stored in fare.supplier)
export function getBookableAdapter(
  supplierName: "RIYA" | "TRIPJACK" | "DUFFEL",
  configs: SupplierConfig[],
  platform: PlatformCredentials = {},
): SupplierAdapter {
  const config = configs.find((c) => c.name === supplierName && c.isEnabled);
  if (!config) throw new Error(`Supplier ${supplierName} not available`);
  return buildAdapter(config, platform);
}

