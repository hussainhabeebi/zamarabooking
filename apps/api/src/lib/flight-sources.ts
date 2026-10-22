// Zamra's flight sources besides TripJack, all set up in Admin → Flight Sources:
//   • Akbar Travels API — settings only until Akbar's API documentation arrives.
//   • Poomas Partner API — live search; booked offline (staff ticket on Poomas).
//   • Manual fares — Admin table + Google Sheet sync; booked offline.
// "Offline" fares are paid on Zamra like any fare; the booking then waits in
// Admin until staff issue the ticket and enter the PNR.

import { and, eq, gte, sql } from "drizzle-orm";
import { manualFares, tenants } from "@zamrabooking/db/schema";
import type { Db } from "@zamrabooking/db";
import type { NormalizedFare, SearchParams } from "@zamrabooking/suppliers";
import type { Env } from "../types.js";
import { FOREIGN_CURRENCIES, getFx, type ForeignCurrency } from "./fx.js";

// ── Settings (TENANT_CACHE_KV, like the other Admin integrations) ────────────

export interface AkbarSettings {
  enabled:     boolean;
  priority?:   number; // Prepared only; Akbar is not registered with live search.
  environment: "UAT" | "PRODUCTION";
  baseUrl:     string;
  username:    string;
  password:    string;
  agencyCode:  string;
  apiKey:      string;
}

export interface PoomasSettings {
  enabled: boolean;
  apiKey:  string;
  baseUrl: string;
}

export interface SheetSyncResult {
  at:       string;
  ok:       boolean;
  imported: number;
  skipped:  number;
  errors:   string[];   // first few row problems, or why the sheet couldn't be read
}

export interface ManualSettings {
  enabled:   boolean;   // manual fares appear in search
  sheetUrl:  string;    // Google Sheet link (shared "anyone with the link") or a published CSV URL
  autoSync:  boolean;   // hourly sync from the sheet
  lastSync?: SheetSyncResult;
}

export const DEFAULT_AKBAR: AkbarSettings = { enabled: false, priority: 100, environment: "UAT", baseUrl: "", username: "", password: "", agencyCode: "", apiKey: "" };
export const DEFAULT_POOMAS: PoomasSettings = { enabled: false, apiKey: "", baseUrl: "https://api.flypoomas.com" };
export const DEFAULT_MANUAL: ManualSettings = { enabled: false, sheetUrl: "", autoSync: true };

type SourceKey = "akbar" | "poomas" | "manual";
const settingsKey = (tenantId: string, source: SourceKey) => `admin_settings:${tenantId}:integration:${source}`;

async function loadSettings<T extends object>(env: Env, tenantId: string, source: SourceKey, defaults: T): Promise<T> {
  const saved = await env.TENANT_CACHE_KV.get(settingsKey(tenantId, source), "json").catch(() => null) as Partial<T> | null;
  return { ...defaults, ...(saved ?? {}) };
}

async function saveSettings(env: Env, tenantId: string, source: SourceKey, value: object) {
  await env.TENANT_CACHE_KV.put(settingsKey(tenantId, source), JSON.stringify(value));
}

export const getAkbarSettings  = (env: Env, tenantId: string) => loadSettings(env, tenantId, "akbar", DEFAULT_AKBAR);
export const getPoomasSettings = (env: Env, tenantId: string) => loadSettings(env, tenantId, "poomas", DEFAULT_POOMAS);
export const getManualSettings = (env: Env, tenantId: string) => loadSettings(env, tenantId, "manual", DEFAULT_MANUAL);
export const saveAkbarSettings  = (env: Env, tenantId: string, s: AkbarSettings) => saveSettings(env, tenantId, "akbar", s);
export const savePoomasSettings = (env: Env, tenantId: string, s: PoomasSettings) => saveSettings(env, tenantId, "poomas", s);
export const saveManualSettings = (env: Env, tenantId: string, s: ManualSettings) => saveSettings(env, tenantId, "manual", s);

// ── Offline suppliers ────────────────────────────────────────────────────────

export const OFFLINE_SUPPLIERS = ["POOMAS", "MANUAL"] as const;
export type OfflineSupplier = (typeof OFFLINE_SUPPLIERS)[number];
export const isOfflineSupplier = (s: string | null | undefined): s is OfflineSupplier =>
  (OFFLINE_SUPPLIERS as readonly string[]).includes(s ?? "");

export interface Pax { adults: number; children: number; infants: number }

// Poomas fares are remembered at search time so a booking is charged the
// searched price, never a price sent by the browser.
const OFFLINE_FARE_TTL = 30 * 60;
const offlineFareKey = (tenantId: string, fareId: string) => `offline_fare:${tenantId}:${fareId}`;

export async function rememberOfflineFares(env: Env, tenantId: string, fares: NormalizedFare[], pax: Pax) {
  await Promise.all(fares.filter((f) => f.supplier === "POOMAS").map((f) =>
    env.FARE_CACHE_KV.put(offlineFareKey(tenantId, f.id), JSON.stringify({ fare: f, pax }), { expirationTtl: OFFLINE_FARE_TTL })));
}

// The fare a customer is booking, priced on the server. null = no longer available.
export async function quoteOfflineFare(env: Env, db: Db, tenantId: string, supplier: OfflineSupplier, fareId: string, pax: Pax): Promise<NormalizedFare | null> {
  if (supplier === "MANUAL") return quoteManualFare(env, db, tenantId, fareId, pax);
  const stored = await env.FARE_CACHE_KV.get(offlineFareKey(tenantId, fareId), "json").catch(() => null) as { fare: NormalizedFare; pax: Pax } | null;
  if (!stored) return null;
  // The Poomas price covers the party that was searched.
  const same = stored.pax.adults === pax.adults && stored.pax.children === pax.children && stored.pax.infants === pax.infants;
  return same ? stored.fare : null;
}

// ── Manual fares ─────────────────────────────────────────────────────────────

type ManualFareRow = typeof manualFares.$inferSelect;

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// INR per 1 unit of the fare's currency (null when no rate is available).
type ToInr = (amount: number, currency: string) => number | null;

async function inrConverter(env: Env, tenantId: string): Promise<ToInr> {
  const fx = await getFx(env, tenantId).catch(() => null);
  return (amount, currency) => {
    if (currency === "INR") return amount;
    if (!FOREIGN_CURRENCIES.includes(currency as ForeignCurrency)) return null;
    const rate = fx?.rates[currency as ForeignCurrency];
    return rate ? Math.round(amount * rate * 100) / 100 : null;
  };
}

export function manualFareToNormalized(row: ManualFareRow, pax: Pax, toInr: ToInr): NormalizedFare | null {
  const adult  = Number(row.adultFare);
  const child  = row.childFare != null ? Number(row.childFare) : adult;
  const infant = row.infantFare != null ? Number(row.infantFare) : 0;
  const total  = toInr(pax.adults * adult + pax.children * child + pax.infants * infant, row.currency);
  const perAdult = toInr(adult, row.currency);
  if (total == null || perAdult == null || total <= 0) return null;
  const arrivalDate = addDays(row.travelDate, row.arrivalDayOffset);
  const duration = row.durationMinutes
    ?? Math.max(0, minutesOf(row.arrivalTime) + row.arrivalDayOffset * 1440 - minutesOf(row.departureTime));
  return {
    id:            row.id,
    supplier:      "MANUAL",
    isBookable:    true,
    airline:       row.airline,
    airlineName:   row.airlineName || row.airline,
    flightNumber:  row.flightNumber,
    origin:        row.origin,
    destination:   row.destination,
    departureTime: `${row.travelDate}T${row.departureTime}:00`,
    arrivalTime:   `${arrivalDate}T${row.arrivalTime}:00`,
    duration,
    stops:         row.stops,
    stopDetails:   [],
    cabinClass:    row.cabinClass,
    baseFare:      total,
    taxes:         0,
    totalFare:     total,
    perAdultFare:  perAdult,
    currency:      "INR",
    isRefundable:  row.isRefundable,
    baggage:       { cabin: row.cabinBaggage || "As per airline", checked: row.checkedBaggage || "As per airline" },
    fareClass:     "",
    seatsLeft:     row.seatsAvailable,
    raw:           { manualFareId: row.id, source: row.source, notes: row.notes },
  };
}

export type ManualSearch = Pick<SearchParams, "origin" | "destination" | "departureDate" | "cabinClass" | "tripType"> & Pax;

export async function searchManualFares(env: Env, db: Db, tenantId: string, params: ManualSearch): Promise<NormalizedFare[]> {
  if (params.tripType !== "ONEWAY") return [];
  const settings = await getManualSettings(env, tenantId);
  if (!settings.enabled) return [];
  const rows = await db.select().from(manualFares).where(and(
    eq(manualFares.tenantId, tenantId),
    eq(manualFares.isActive, true),
    eq(manualFares.origin, params.origin.toUpperCase()),
    eq(manualFares.destination, params.destination.toUpperCase()),
    eq(manualFares.travelDate, params.departureDate),
    eq(manualFares.cabinClass, params.cabinClass),
    gte(manualFares.seatsAvailable, params.adults + params.children),
  ));
  if (!rows.length) return [];
  const toInr = await inrConverter(env, tenantId);
  return rows.map((r) => manualFareToNormalized(r, params, toInr)).filter((f): f is NormalizedFare => f !== null);
}

async function quoteManualFare(env: Env, db: Db, tenantId: string, id: string, pax: Pax): Promise<NormalizedFare | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db.select().from(manualFares)
    .where(and(eq(manualFares.id, id), eq(manualFares.tenantId, tenantId), eq(manualFares.isActive, true))).limit(1);
  if (!row || row.seatsAvailable < pax.adults + pax.children) return null;
  if (!(await getManualSettings(env, tenantId)).enabled) return null;
  return manualFareToNormalized(row, pax, await inrConverter(env, tenantId));
}

// ── Google Sheet / CSV import ────────────────────────────────────────────────

// Header names accepted in the sheet (first row). Case, spaces and dashes don't matter.
export const SHEET_COLUMNS = [
  "date", "origin", "destination", "airline", "airline_name", "flight_number",
  "departure_time", "arrival_time", "arrival_day_offset", "duration_minutes", "stops", "cabin",
  "adult_fare", "child_fare", "infant_fare", "currency", "seats",
  "checked_baggage", "cabin_baggage", "refundable", "notes", "active",
] as const;
const REQUIRED_COLUMNS = ["date", "origin", "destination", "airline", "flight_number", "departure_time", "arrival_time", "adult_fare"] as const;

export type ManualFareInput = Omit<typeof manualFares.$inferInsert, "id" | "tenantId" | "createdAt" | "updatedAt">;

// RFC 4180 CSV: quoted fields, doubled quotes, commas and line breaks inside quotes.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

const CABINS = ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"];
const CURRENCIES = ["INR", ...FOREIGN_CURRENCIES] as string[];

// DD/MM/YYYY, DD-MM-YYYY or YYYY-MM-DD → YYYY-MM-DD.
function parseDate(v: string): string | null {
  const s = v.trim();
  let y: number, m: number, d: number;
  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date.toISOString().slice(0, 10) : null;
}

// 9:05, 09:05, 21:30 or 9:05 PM → HH:MM.
function parseTime(v: string): string | null {
  const match = v.trim().toUpperCase().match(/^(\d{1,2})[:.](\d{2})\s*(AM|PM)?$/);
  if (!match) return null;
  let h = Number(match[1]);
  const m = Number(match[2]);
  if (match[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (match[3] === "PM" ? 12 : 0); }
  return h < 24 && m < 60 ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` : null;
}

const parseMoney = (v: string) => {
  const n = Number(v.replace(/[,\s₹]/g, ""));
  return v.trim() && Number.isFinite(n) && n >= 0 ? n : null;
};
const parseBool = (v: string, fallback: boolean) => {
  const s = v.trim().toLowerCase();
  if (!s) return fallback;
  return ["yes", "y", "true", "1", "refundable"].includes(s);
};

// Validates one fare (from the sheet or the Admin form). Returns the row or a problem.
export function validateManualFare(get: (col: (typeof SHEET_COLUMNS)[number]) => string): ManualFareInput | string {
  for (const col of REQUIRED_COLUMNS) if (!get(col).trim()) return `${col} is empty`;
  const travelDate = parseDate(get("date"));
  if (!travelDate) return `date "${get("date")}" is not a date (use DD/MM/YYYY)`;
  const origin = get("origin").trim().toUpperCase(), destination = get("destination").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination)) return "origin and destination must be 3-letter airport codes";
  if (origin === destination) return "origin and destination are the same";
  const airline = get("airline").trim().toUpperCase();
  if (!/^[A-Z0-9]{2}$/.test(airline)) return `airline "${get("airline")}" must be the 2-character airline code (e.g. 6E)`;
  const departureTime = parseTime(get("departure_time")), arrivalTime = parseTime(get("arrival_time"));
  if (!departureTime || !arrivalTime) return "departure_time and arrival_time must look like 14:30";
  const adultFare = parseMoney(get("adult_fare"));
  if (!adultFare) return `adult_fare "${get("adult_fare")}" is not a price`;
  const childFare = get("child_fare").trim() ? parseMoney(get("child_fare")) : null;
  const infantFare = get("infant_fare").trim() ? parseMoney(get("infant_fare")) : null;
  if ((get("child_fare").trim() && childFare == null) || (get("infant_fare").trim() && infantFare == null)) return "child_fare / infant_fare must be prices";
  const currency = (get("currency").trim() || "INR").toUpperCase();
  if (!CURRENCIES.includes(currency)) return `currency "${currency}" is not supported (${CURRENCIES.join(", ")})`;
  const cabinClass = (get("cabin").trim() || "ECONOMY").toUpperCase().replace(/[\s-]+/g, "_");
  if (!CABINS.includes(cabinClass)) return `cabin "${get("cabin")}" must be Economy, Premium Economy, Business or First`;
  const int = (col: (typeof SHEET_COLUMNS)[number], fallback: number | null, max: number) => {
    const raw = get(col).trim();
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= max ? n : undefined;
  };
  const seats = int("seats", 9, 999), stops = int("stops", 0, 5), offset = int("arrival_day_offset", 0, 2), duration = int("duration_minutes", null, 2880);
  if (seats === undefined || stops === undefined || offset === undefined || duration === undefined) return "seats, stops, arrival_day_offset and duration_minutes must be whole numbers";
  return {
    source: "ADMIN", travelDate, origin, destination, airline,
    airlineName: get("airline_name").trim() || null,
    flightNumber: get("flight_number").trim().toUpperCase().replace(/\s+/g, ""),
    departureTime, arrivalTime, arrivalDayOffset: offset ?? 0, durationMinutes: duration,
    stops: stops ?? 0, cabinClass,
    adultFare: String(adultFare), childFare: childFare != null ? String(childFare) : null, infantFare: infantFare != null ? String(infantFare) : null,
    currency, seatsAvailable: seats ?? 9,
    checkedBaggage: get("checked_baggage").trim() || null, cabinBaggage: get("cabin_baggage").trim() || null,
    isRefundable: parseBool(get("refundable"), false),
    notes: get("notes").trim() || null,
    isActive: parseBool(get("active"), true),
  };
}

const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, "_");

export function parseManualFaresCsv(text: string): { rows: ManualFareInput[]; skipped: number; errors: string[] } {
  const table = parseCsv(text.replace(/^﻿/, ""));
  if (!table.length) return { rows: [], skipped: 0, errors: ["The sheet is empty"] };
  const headers = table[0].map(normalizeHeader);
  const missing = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length) return { rows: [], skipped: 0, errors: [`Missing column(s) in the first row: ${missing.join(", ")}`] };
  const rows: ManualFareInput[] = [];
  const errors: string[] = [];
  let skipped = 0;
  for (const [i, cells] of table.slice(1).entries()) {
    const result = validateManualFare((col) => cells[headers.indexOf(col)] ?? "");
    if (typeof result === "string") {
      skipped++;
      if (errors.length < 20) errors.push(`Row ${i + 2}: ${result}`);
    } else rows.push({ ...result, source: "SHEET" });
  }
  return { rows, skipped, errors };
}

// Google Sheets "share" / "edit" links → their CSV export link. Published CSV links pass through.
export function sheetCsvUrl(input: string): string | null {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const m = url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (url.hostname === "docs.google.com" && m && m[1] !== "e") {
    const gid = url.searchParams.get("gid") ?? url.hash.match(/gid=(\d+)/)?.[1] ?? "0";
    return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
  }
  return url.toString();
}

// Replaces this tenant's SHEET fares with the sheet's current rows (one transaction).
// Admin-typed fares are never touched. A sheet that can't be read keeps the old fares.
export async function syncManualFaresSheet(env: Env, db: Db, tenantId: string, fetchImpl: typeof fetch = fetch): Promise<SheetSyncResult> {
  const settings = await getManualSettings(env, tenantId);
  const at = new Date().toISOString();
  const finish = async (result: SheetSyncResult) => {
    await saveManualSettings(env, tenantId, { ...settings, lastSync: result });
    return result;
  };
  const url = sheetCsvUrl(settings.sheetUrl);
  if (!url) return finish({ at, ok: false, imported: 0, skipped: 0, errors: ["Add a Google Sheet link first (https://docs.google.com/spreadsheets/…)"] });
  let text: string;
  try {
    const res = await fetchImpl(url, { redirect: "follow", headers: { Accept: "text/csv" } });
    text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (/^\s*<(!doctype|html)/i.test(text)) throw new Error("Google returned a web page, not CSV — share the sheet as \"Anyone with the link can view\"");
  } catch (err) {
    return finish({ at, ok: false, imported: 0, skipped: 0, errors: [`Couldn't read the sheet: ${err instanceof Error ? err.message : String(err)}`] });
  }
  const parsed = parseManualFaresCsv(text);
  if (!parsed.rows.length && parsed.errors.length) {
    return finish({ at, ok: false, imported: 0, skipped: parsed.skipped, errors: parsed.errors });
  }
  const deleteOld = db.delete(manualFares).where(and(eq(manualFares.tenantId, tenantId), eq(manualFares.source, "SHEET")));
  // Postgres allows 65,535 parameters per statement (~25 per fare): insert in chunks.
  const inserts = [];
  for (let i = 0; i < parsed.rows.length; i += 500) {
    inserts.push(db.insert(manualFares).values(parsed.rows.slice(i, i + 500).map((r) => ({ ...r, tenantId }))));
  }
  await db.batch([deleteOld, ...inserts]);
  return finish({ at, ok: true, imported: parsed.rows.length, skipped: parsed.skipped, errors: parsed.errors });
}

// Cron: sync every tenant whose sheet is set to sync automatically.
export async function syncAllManualFareSheets(env: Env, db: Db): Promise<Record<string, SheetSyncResult>> {
  const rows = await db.select({ id: tenants.id }).from(tenants);
  const out: Record<string, SheetSyncResult> = {};
  for (const { id } of rows) {
    const s = await getManualSettings(env, id);
    if (s.enabled && s.autoSync && s.sheetUrl) out[id] = await syncManualFaresSheet(env, db, id);
  }
  return out;
}

// Seats sold on a manual fare come off its allocation.
export async function takeManualSeats(db: Db, tenantId: string, fareId: string, seats: number) {
  await db.update(manualFares)
    .set({ seatsAvailable: sql`GREATEST(${manualFares.seatsAvailable} - ${seats}, 0)`, updatedAt: new Date() })
    .where(and(eq(manualFares.id, fareId), eq(manualFares.tenantId, tenantId)));
}
