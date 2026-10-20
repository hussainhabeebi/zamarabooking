// TripSafe (TripJack travel insurance v2) service: settings, client, logging,
// booking records and the certification pack.
//
// Records live in KV (no schema change):
//   tripsafe:<tenant>:<ref>       one TripSafe booking (our reference TS-…)
//   tripsafe_index:<tenant>       newest-first list of references (admin list)
//   tripsafe_search:<tenant>:<searchId>  search context (SESSIONS_KV, 1 h)
//
// Every TripJack exchange is stored like flights (supplier_exchanges + R2
// request / response files) linked to the reference or the TripJack searchId,
// and summarised in Admin → Supplier logs.

import {
  TripjackInsuranceClient, parseTripsafeBooking, tripsafeSearchBody, normalizeTripsafeProduct,
  type TripsafeTripInput, type TripsafeTraveller, type TripsafeBookResult, type TripsafeBookingDetails,
} from "@poomas/suppliers";
import { supplierExchanges } from "@poomas/db/schema";
import { and, asc, desc, eq, inArray, like, or } from "drizzle-orm";
import type { Env, Variables } from "../types.js";
import { collectExchanges, persistExchanges } from "./api-exchanges.js";
import { logSupplierCall } from "./supplier-logger.js";
import { certificationRequest, tripjackHost, type PackFile } from "./certification.js";

type Db = Variables["db"];

// ── Settings ────────────────────────────────────────────────────────────────

export interface TripsafeSettings {
  enabled:     boolean;
  apiKey?:     string;
  environment: "UAT" | "PRODUCTION";
  payUserId?:  string;
}

export async function tripsafeSettings(env: Env, tenantId: string): Promise<TripsafeSettings> {
  let saved: Record<string, any> | null = null;
  try {
    saved = await env.TENANT_CACHE_KV.get(`admin_settings:${tenantId}:integration:tripjack`, "json") as Record<string, any> | null;
  } catch { /* treat as not configured */ }
  return {
    enabled:     saved?.tripsafeEnabled === true,
    apiKey:      saved?.apiKey || env.TRIPJACK_API_KEY,
    environment: saved?.environment === "PRODUCTION" ? "PRODUCTION" : "UAT",
    payUserId:   typeof saved?.tripsafePayUserId === "string" && saved.tripsafePayUserId.trim() ? saved.tripsafePayUserId.trim() : undefined,
  };
}

export function tripsafeClient(env: Env, settings: TripsafeSettings) {
  return new TripjackInsuranceClient({
    apiKey:   settings.apiKey,
    baseUrl:  env.TRIPJACK_API_BASE_URL,   // the Poomas TripJack gateway
    proxyKey: env.TRIPJACK_PROXY_KEY,
  });
}

// ── Logged call ─────────────────────────────────────────────────────────────

function errorHint(err: any): string {
  if (err?.statusCode === 404 && /UNSUPPORTED_TRIPJACK_ROUTE|HTTP_404/.test(String(err?.code))) {
    return " — route not found: redeploy the TripJack gateway (TripSafe /insurance/v2 routes)";
  }
  if (err?.statusCode === 401 || err?.statusCode === 403 || ["UNAUTHORIZED", "UNAUTHORIZED_APIKEY", "412"].includes(String(err?.code))) {
    return " — API key not enabled for TripSafe (select the insurance APIs under API Configuration in TripJack) or the gateway IP is not whitelisted";
  }
  return "";
}

// Runs one TripSafe call: stores the raw exchange(s) for certification logs and
// writes a Supplier logs row (INFO or ERROR with the full TripJack error).
export async function trackedCall<T>(
  c: any,
  client: TripjackInsuranceClient,
  endpoint: string,
  link: { bookingId?: string | null; searchId?: string | null; searchIdFrom?: (r: T) => string | undefined },
  summary: Record<string, unknown>,
  call: () => Promise<T>,
): Promise<T> {
  const tenantId = c.get("tenantId") as string;
  const db = c.get("db") as Db;
  const requestId = `tripsafe-${crypto.randomUUID()}`;
  const collector = collectExchanges();
  client.setRecorder(collector.recorder);
  const started = Date.now();
  const base = { tenantId, supplier: "TRIPJACK" as const, endpoint, requestId };
  const store = (searchId?: string | null) => persistExchanges(c.env, db, tenantId, collector.exchanges,
    { bookingId: link.bookingId ?? null, searchId: searchId ?? link.searchId ?? null, requestId });
  try {
    const result = await call();
    const searchId = link.searchIdFrom?.(result);
    await Promise.all([
      store(searchId),
      logSupplierCall(db, { ...base, level: "INFO", httpStatus: 200, durationMs: Date.now() - started,
        requestSummary: { ...summary, ...(searchId ? { searchId } : {}), ...(link.bookingId ? { reference: link.bookingId } : {}) } }),
    ]);
    return result;
  } catch (err: any) {
    console.error(`[tripsafe] ${endpoint} failed`, err);
    await Promise.all([
      store(),
      logSupplierCall(db, {
        ...base, level: "ERROR",
        httpStatus: typeof err?.statusCode === "number" ? err.statusCode : undefined,
        errorCode: String(err?.code ?? "TRIPSAFE_ERROR"),
        errorMessage: `${err instanceof Error ? err.message : String(err)}${errorHint(err)}`,
        responseSnippet: typeof err?.responseSnippet === "string" ? err.responseSnippet : String(err?.stack ?? err).slice(0, 800),
        requestSummary: { ...summary, tripjackEndpoint: err?.endpoint, ...(link.bookingId ? { reference: link.bookingId } : {}) },
        durationMs: Date.now() - started,
      }),
    ]);
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { requestId });
  } finally {
    client.setRecorder(undefined);
  }
}

// Customer-facing message + HTTP status for a TripSafe error.
export function tripsafeErrorResponse(err: any, fallback: string): { status: 400 | 404 | 409 | 410 | 502 | 503; body: Record<string, unknown> } {
  const code = String(err?.code ?? "");
  const detail = err instanceof Error ? err.message.replace(/^TripSafe \S+ failed \([^)]*\):?\s*/, "") : "";
  const status = code === "NOT_CONFIGURED" ? 503
    : ["SEARCH_ID_NOT_FOUND", "879", "INVALID_SEARCH_ID", "850"].includes(code) ? 410
    : ["INS_8353", "PRODUCT_NOT_FOUND", "REGION_NOT_FOUND", "REGION_DOES_NOT_EXISTS"].includes(code) ? 404
    : ["INS_8312", "INS_AMENDMENT_NOT_ALLOWED", "2615", "PENDING_ORDER"].includes(code) ? 409
    : typeof err?.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 401 && err.statusCode !== 403 ? 400
    : 502;
  const message = status === 410 ? "Your insurance quote has expired. Please search again."
    : code === "INS_8353" ? "No insurance plans are available for this trip."
    : status === 400 || status === 404 || status === 409 ? (detail || fallback)
    : fallback;
  return { status, body: { error: message, code: code || undefined, requestId: err?.requestId } };
}

// ── Search context ──────────────────────────────────────────────────────────

export interface TripsafeSearchContext {
  searchId: string;
  input:    TripsafeTripInput;
  products: { productId: string; totalFare: number; planCoverage: string; insuranceProvider: string; regionName: string; planType: string }[];
  at:       string;
}

const searchKey = (tenantId: string, searchId: string) => `tripsafe_search:${tenantId}:${searchId}`;

export async function saveSearch(env: Env, tenantId: string, ctx: TripsafeSearchContext) {
  await env.SESSIONS_KV.put(searchKey(tenantId, ctx.searchId), JSON.stringify(ctx), { expirationTtl: 3600 });
}

export async function loadSearch(env: Env, tenantId: string, searchId: string): Promise<TripsafeSearchContext | null> {
  return await env.SESSIONS_KV.get(searchKey(tenantId, searchId), "json").catch(() => null) as TripsafeSearchContext | null;
}

// ── Booking records ─────────────────────────────────────────────────────────

export type TripsafeRecordStatus = "AWAITING_PAYMENT" | "BOOKED" | "FAILED";

export interface TripsafeAmendmentLog {
  amendmentId: string; type: string; status: string; amount?: number; refund?: number;
  remarks?: string; at: string; travellerIds?: number[];
}

export interface TripsafeRecord {
  reference:     string;
  tenantId:      string;
  accessKey:     string;
  customerId?:   string | null;
  createdAt:     string;
  updatedAt:     string;
  status:        TripsafeRecordStatus;
  environment:   "UAT" | "PRODUCTION";
  journey:       TripsafeTripInput["journey"];
  input:         TripsafeTripInput;
  searchIds:     string[];
  searchId:      string;
  productId:     string;
  product:       { planCoverage: string; insuranceProvider: string; regionName: string; planType: string; totalFare: number };
  currency:      string;
  travellers:    TripsafeTraveller[];
  contact:       { email: string; phone?: string };
  tripjack?:     { bookingId: string; status: string; tnc?: TripsafeBookResult["tnc"]; paymentResult?: TripsafeBookResult["paymentResult"] };
  policies?:     { travellerId: number | null; name: string; policyId?: string }[];
  error?:        string;
  amendments?:   TripsafeAmendmentLog[];
  flightBookingId?: string;
}

const recordKey = (tenantId: string, ref: string) => `tripsafe:${tenantId}:${ref}`;
const indexKey = (tenantId: string) => `tripsafe_index:${tenantId}`;

export function newReference() {
  const t = new Date();
  const ymd = `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`;
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `TS-${ymd}-${rand}`;
}

export function newAccessKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function loadRecord(env: Env, tenantId: string, ref: string): Promise<TripsafeRecord | null> {
  if (!/^TS-[0-9]{8}-[0-9A-F]{6}$/.test(ref)) return null;
  return await env.TENANT_CACHE_KV.get(recordKey(tenantId, ref), "json").catch(() => null) as TripsafeRecord | null;
}

export async function saveRecord(env: Env, record: TripsafeRecord, isNew = false) {
  record.updatedAt = new Date().toISOString();
  await env.TENANT_CACHE_KV.put(recordKey(record.tenantId, record.reference), JSON.stringify(record));
  if (isNew) {
    const index = (await env.TENANT_CACHE_KV.get(indexKey(record.tenantId), "json").catch(() => null) as string[] | null) ?? [];
    await env.TENANT_CACHE_KV.put(indexKey(record.tenantId), JSON.stringify([record.reference, ...index.filter((r) => r !== record.reference)].slice(0, 1000)));
  }
}

export async function listRecords(env: Env, tenantId: string, limit = 100): Promise<TripsafeRecord[]> {
  const index = (await env.TENANT_CACHE_KV.get(indexKey(tenantId), "json").catch(() => null) as string[] | null) ?? [];
  const rows = await Promise.all(index.slice(0, limit).map((ref) => loadRecord(env, tenantId, ref)));
  return rows.filter((r): r is TripsafeRecord => Boolean(r));
}

// Public view of a record (no access key / tenant).
export function publicRecord(r: TripsafeRecord) {
  const { accessKey: _a, tenantId: _t, ...rest } = r;
  return rest;
}

// Pulls Get Booking Detail and keeps the record's status / policy IDs current.
export async function refreshDetails(c: any, client: TripjackInsuranceClient, record: TripsafeRecord, reason: string): Promise<TripsafeBookingDetails | null> {
  if (!record.tripjack?.bookingId) return null;
  const raw = await trackedCall(c, client, "/insurance/v2/booking", { bookingId: record.reference },
    { bookingId: record.tripjack.bookingId, reason }, () => client.bookingDetail(record.tripjack!.bookingId));
  const details = parseTripsafeBooking(raw);
  const policies = details.travellers.map((t) => ({ travellerId: t.travellerId, name: t.name, policyId: t.policyId }));
  if (details.status !== record.tripjack.status || JSON.stringify(policies) !== JSON.stringify(record.policies ?? [])) {
    record.tripjack.status = details.status;
    record.policies = policies;
    await saveRecord(c.env, record);
  }
  return details;
}

// ── Certification logs ──────────────────────────────────────────────────────

// TripJack-style names: SearchRequest.json, BookingResponse.json, BookingDetailRequest.json …
const STEP: Record<string, string> = {
  "/insurance/v2/search": "Search",
  "/insurance/v2/booking": "Booking",
  "/insurance/v2/amendment/raise": "AmendmentRaise",
  "/insurance/v2/amendment/confirm": "AmendmentConfirm",
};

function stepName(endpoint: string, method: string | undefined) {
  if (endpoint.startsWith("/insurance/v2/booking/") || (endpoint === "/insurance/v2/booking" && method === "GET")) return "BookingDetail";
  return STEP[endpoint] ?? endpoint.replace(/^\//, "").split(/[^a-zA-Z0-9]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

const enc = new TextEncoder();

async function exchangeFiles(env: Env, rows: (typeof supplierExchanges.$inferSelect)[], host: string, folder: string): Promise<PackFile[]> {
  const files: PackFile[] = [];
  const used = new Map<string, number>();
  for (const x of rows) {
    let stored: Record<string, any> = {};
    if (x.requestKey) {
      const obj = await env.DOCUMENTS_R2.get(x.requestKey);
      if (obj) { try { stored = JSON.parse(await obj.text()); } catch { /* keep empty */ } }
    }
    const step = stepName(new URL(x.url).pathname, stored.method);
    // A second call of the same service (e.g. two amendments) gets a _2 suffix.
    const n = (used.get(step) ?? 0) + 1;
    used.set(step, n);
    const suffix = n > 1 ? `_${n}` : "";
    if (x.requestKey) {
      const req = certificationRequest(stored, host);
      // A GET has no body — keep the request file exactly as sent.
      const body = stored.method === "GET" ? { url: req.url, method: "GET", headers: { ...(req.headers.apikey ? { apikey: req.headers.apikey } : {}) } } : req;
      files.push({ name: `${folder}${step}Request${suffix}.json`, data: enc.encode(JSON.stringify(body, null, 2)), date: x.startedAt });
    }
    if (x.responseKey) {
      const obj = await env.DOCUMENTS_R2.get(x.responseKey);
      if (obj) files.push({ name: `${folder}${step}Response${suffix}.${x.responseKey.endsWith(".txt") ? "txt" : "json"}`, data: new Uint8Array(await obj.arrayBuffer()), date: x.startedAt });
    }
  }
  return files;
}

// Summary + request / response files (TripJack names) for one TripSafe booking.
export async function tripsafePack(env: Env, db: Db, record: TripsafeRecord, folder = ""): Promise<PackFile[]> {
  const host = tripjackHost(record.environment);
  const all = await db.select().from(supplierExchanges).where(and(
    eq(supplierExchanges.tenantId, record.tenantId),
    like(supplierExchanges.endpoint, "/insurance/%"),
    record.searchIds.length
      ? or(eq(supplierExchanges.bookingId, record.reference), inArray(supplierExchanges.searchId, record.searchIds))
      : eq(supplierExchanges.bookingId, record.reference),
  )).orderBy(asc(supplierExchanges.startedAt));
  // One Search (the one the booking used), the Booking, every amendment, and
  // only the final Booking Detail call.
  const searches = all.filter((x) => x.endpoint === "/insurance/v2/search");
  const search = searches.filter((x) => x.searchId === record.searchId).pop() ?? searches.pop();
  const details = all.filter((x) => x.endpoint.startsWith("/insurance/v2/booking/"));
  const lastDetail = details[details.length - 1];
  const books = all.filter((x) => x.endpoint === "/insurance/v2/booking");
  const book = books[books.length - 1];
  const rows = all.filter((x) => x === search || x === book || x === lastDetail || x.endpoint.startsWith("/insurance/v2/amendment/"));
  const summary = {
    reference:          record.reference,
    tripjackBookingId:  record.tripjack?.bookingId ?? null,
    status:             record.tripjack?.status ?? record.status,
    journey:            record.journey,
    searchIds:          record.searchIds,
    productId:          record.productId,
    plan:               record.product,
    trip:               { startDate: record.input.startDate, endDate: record.input.endDate, coverageDuration: record.input.coverageDuration, destinations: record.input.destinations },
    travellers:         record.travellers.map((t) => ({ name: `${t.firstName} ${t.lastName}`, dob: t.dob })),
    policies:           record.policies ?? [],
    amendments:         record.amendments ?? [],
    createdAt:          record.createdAt,
    ...(() => {
      const missing = [search ? "" : "Search", book ? "" : "Booking", lastDetail ? "" : "BookingDetail"].filter(Boolean);
      return missing.length ? { missingServices: missing } : {};
    })(),
  };
  return [
    { name: `${folder}BookingSummary.json`, data: enc.encode(JSON.stringify(summary, null, 2)), date: new Date(record.createdAt) },
    ...await exchangeFiles(env, rows, host, folder),
  ];
}

// Any TripSafe exchanges by ID (e.g. the negative validation case, which never becomes a booking).
export async function exchangesPack(env: Env, db: Db, tenantId: string, ids: string[], environment: "UAT" | "PRODUCTION"): Promise<PackFile[]> {
  if (!ids.length) return [];
  const rows = await db.select().from(supplierExchanges).where(and(
    eq(supplierExchanges.tenantId, tenantId), like(supplierExchanges.endpoint, "/insurance/%"), inArray(supplierExchanges.id, ids),
  )).orderBy(asc(supplierExchanges.startedAt));
  return exchangeFiles(env, rows, tripjackHost(environment), "");
}

export async function recentExchanges(db: Db, tenantId: string, limit = 200) {
  return db.select({
    id: supplierExchanges.id, endpoint: supplierExchanges.endpoint, httpStatus: supplierExchanges.httpStatus,
    durationMs: supplierExchanges.durationMs, error: supplierExchanges.error, bookingId: supplierExchanges.bookingId,
    searchId: supplierExchanges.searchId, startedAt: supplierExchanges.startedAt, hasResponse: supplierExchanges.responseKey,
  }).from(supplierExchanges)
    .where(and(eq(supplierExchanges.tenantId, tenantId), like(supplierExchanges.endpoint, "/insurance/%")))
    .orderBy(desc(supplierExchanges.startedAt)).limit(limit);
}

// ── Search / issue (shared by the public and admin routes) ─────────────────

export async function runSearch(c: any, client: TripjackInsuranceClient, input: TripsafeTripInput, reason: string) {
  const body = tripsafeSearchBody(input);
  const data = await trackedCall(c, client, "/insurance/v2/search", { searchIdFrom: (r) => r?.searchId },
    { journey: input.journey, reason, destinations: input.destinations.map((d) => `${d.key}/${d.type}`).join(","), travellers: input.travellerDobs.length, startDate: input.startDate, endDate: input.endDate, coverageDuration: input.coverageDuration },
    () => client.search(body));
  const products = (Array.isArray(data?.productInfo) ? data.productInfo : []).map(normalizeTripsafeProduct).filter((p) => p.productId);
  const searchId = String(data?.searchId ?? "");
  if (searchId) {
    await saveSearch(c.env, c.get("tenantId"), {
      searchId, input, at: new Date().toISOString(),
      products: products.map((p) => ({ productId: p.productId, totalFare: p.totalFare, planCoverage: p.planCoverage, insuranceProvider: p.insuranceProvider, regionName: p.regionName, planType: p.planType })),
    });
  }
  return { searchId, products, request: body };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Books the record's plan with TripJack (re-searching if the searchId expired)
// and pulls the policy IDs. Payment: WALLET with the configured payUserId;
// without one TripJack leaves the booking PAYMENT_PENDING.
export async function issuePolicy(c: any, settings: TripsafeSettings, record: TripsafeRecord): Promise<TripsafeRecord> {
  const client = tripsafeClient(c.env, settings);
  const tenantId = c.get("tenantId") as string;
  try {
    let ctx = await loadSearch(c.env, tenantId, record.searchId);
    if (!ctx) {
      const fresh = await runSearch(c, client, record.input, `re-search before booking ${record.reference}`);
      const same = fresh.products.find((p) => p.productId === record.productId);
      if (!fresh.searchId || !same) throw Object.assign(new Error("The selected plan is no longer available for this trip — search again"), { code: "PRODUCT_NOT_FOUND" });
      record.searchId = fresh.searchId;
      record.searchIds = [...new Set([...record.searchIds, fresh.searchId])];
      record.product.totalFare = same.totalFare;
      ctx = await loadSearch(c.env, tenantId, fresh.searchId);
    }
    const res = await trackedCall(c, client, "/insurance/v2/booking", { bookingId: record.reference },
      { productId: record.productId, searchId: record.searchId, travellers: record.travellers.length, inlinePayment: Boolean(settings.payUserId) },
      () => client.book({
        searchId: record.searchId,
        productId: record.productId,
        travellerInfos: record.travellers.map((t, i) => ({ ...t, id: i + 1, isInsuranceOpted: true })),
        deliveryInfo: { emails: [record.contact.email], ...(record.contact.phone ? { contacts: [record.contact.phone] } : {}) },
        ...(settings.payUserId ? { paymentOptions: { payUserId: settings.payUserId, paymentMedium: "WALLET" as const } } : {}),
      }));
    if (!res?.bookingId) throw Object.assign(new Error("TripSafe booking returned no bookingId"), { code: "INVALID_RESPONSE" });
    record.tripjack = { bookingId: res.bookingId, status: res.status ?? "UNKNOWN", tnc: res.tnc, paymentResult: res.paymentResult };
    record.status = "BOOKED";
    record.error = res.paymentResult?.status === "FAILED"
      ? `TripJack payment failed (${res.paymentResult.errorCode ?? "?"}): ${res.paymentResult.errorMessage ?? ""} — top up the TripJack wallet; the booking stays PAYMENT_PENDING`
      : !settings.payUserId ? "No TripJack payUserId configured (Admin → Integrations → TripSafe) — booking created as PAYMENT_PENDING" : undefined;
    await saveRecord(c.env, record);
  } catch (err: any) {
    record.status = record.tripjack?.bookingId ? "BOOKED" : "FAILED";
    record.error = err instanceof Error ? err.message : String(err);
    await saveRecord(c.env, record);
    throw err;
  }
  // Policy IDs / COI are generated right after a successful booking.
  for (let i = 0; i < 3; i++) {
    try {
      const d = await refreshDetails(c, client, record, "post-booking");
      if (d && (d.status !== "SUCCESS" || d.travellers.every((t) => t.policyId))) break;
    } catch { break; }
    await wait(2000);
  }
  return record;
}
