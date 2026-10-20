// Price calendar + fare alerts, built from the fares our own searches already
// return (no extra supplier calls, except the fare-alert sweep in the cron).
//
//   pcal:<tenant>:<ORG>-<DST>:<YYYY-MM>:<CUR>      { "DD": { p, at } } — cheapest fare per adult seen
//   falert:<tenant>:<id>                             one fare alert
//   falert_route:<tenant>:<ORG>-<DST>:<date>:<CUR>   [alert ids] for that route + day
//
// Prices are one adult's economy one-way fare including our markup (what the
// customer sees on the results page), in the search currency.

import type { Env } from "../types.js";
import type { Db } from "@poomas/db";
import { API_URL, WEB_URL, emailShell, escapeHtml, money, notifyCustomer } from "./customer-notify.js";

type KV = Env["FARE_CACHE_KV"];

export interface CalendarDay { p: number; at: number }
export interface FareAlert {
  id: string; tenantId: string;
  origin: string; destination: string; date: string; currency: string;
  targetPrice: number;
  email: string | null; phone: string | null;
  createdAt: number;
  lastPrice: number | null;       // last price we told the customer about
  notifications: number;
}

const DAY_MS = 86_400_000;
const MAX_NOTIFICATIONS = 3;
export const MAX_ALERTS_PER_ROUTE = 50;

const calKey = (t: string, o: string, d: string, month: string, cur: string) => `pcal:${t}:${o}-${d}:${month}:${cur}`;
const alertKey = (t: string, id: string) => `falert:${t}:${id}`;
const routeKey = (t: string, o: string, d: string, date: string, cur: string) => `falert_route:${t}:${o}-${d}:${date}:${cur}`;

// KV expiry: a day after the travel date (KV needs ≥ 60 s).
const ttlUntil = (date: string, extraDays = 1) =>
  Math.max(120, Math.floor((Date.parse(`${date}T00:00:00Z`) + extraDays * DAY_MS - Date.now()) / 1000));

interface SearchedFare { totalFare: number; perAdultFare?: number; displayPrice?: number; currency?: string }
export interface SearchShape {
  origin: string; destination: string; departureDate: string; tripType: string; cabinClass: string;
  adults: number; legs?: unknown[]; fareType?: string; currency: string;
}

// Cheapest per-adult price (with markup) in a result set; null when nothing usable.
export function cheapestPerAdult(fares: SearchedFare[], adults: number): number | null {
  let best: number | null = null;
  for (const f of fares) {
    if (!(f.totalFare > 0)) continue;
    const shown = typeof f.displayPrice === "number" && f.displayPrice > 0 ? f.displayPrice : f.totalFare;
    const share = typeof f.perAdultFare === "number" && f.perAdultFare > 0 ? f.perAdultFare / f.totalFare : 1 / Math.max(1, adults);
    const price = Math.round(shown * Math.min(1, share));
    if (price > 0 && (best === null || price < best)) best = price;
  }
  return best;
}

// Plain economy one-way searches feed the calendar and alerts; others are skipped.
export function observable(s: SearchShape) {
  return s.tripType === "ONEWAY" && !s.legs?.length && s.cabinClass === "ECONOMY" && (!s.fareType || s.fareType === "REGULAR");
}

// Records the cheapest fare of a finished search; returns alerts to notify.
export async function recordFareObservation(kv: KV, tenantId: string, s: SearchShape, fares: SearchedFare[], now = Date.now()) {
  if (!observable(s)) return [];
  const price = cheapestPerAdult(fares, s.adults);
  if (price === null) return [];
  const month = s.departureDate.slice(0, 7);
  const day = s.departureDate.slice(8, 10);
  const key = calKey(tenantId, s.origin, s.destination, month, s.currency);
  const cal = (await kv.get(key, "json").catch(() => null) as Record<string, CalendarDay> | null) ?? {};
  const prev = cal[day];
  // Skip the write when nothing changed recently (KV writes are limited).
  if (!prev || prev.p !== price || now - prev.at > 3 * 3600_000) {
    cal[day] = { p: price, at: now };
    await kv.put(key, JSON.stringify(cal), { expirationTtl: ttlUntil(`${month}-28`, 10) }).catch(() => {});
  }
  return dueAlerts(kv, tenantId, s.origin, s.destination, s.departureDate, s.currency, price);
}

export async function readCalendar(kv: KV, tenantId: string, origin: string, destination: string, month: string, currency: string) {
  const cal = (await kv.get(calKey(tenantId, origin, destination, month, currency), "json").catch(() => null) as Record<string, CalendarDay> | null) ?? {};
  return Object.entries(cal)
    .map(([day, v]) => ({ date: `${month}-${day}`, price: v.p, seenAt: new Date(v.at).toISOString() }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── Fare alerts ──────────────────────────────────────────────────────────────

export async function createAlert(kv: KV, a: Omit<FareAlert, "id" | "createdAt" | "lastPrice" | "notifications">): Promise<FareAlert | "ROUTE_FULL"> {
  const ids = (await kv.get(routeKey(a.tenantId, a.origin, a.destination, a.date, a.currency), "json").catch(() => null) as string[] | null) ?? [];
  if (ids.length >= MAX_ALERTS_PER_ROUTE) return "ROUTE_FULL";
  const alert: FareAlert = { ...a, id: crypto.randomUUID(), createdAt: Date.now(), lastPrice: null, notifications: 0 };
  const ttl = ttlUntil(a.date);
  await kv.put(alertKey(a.tenantId, alert.id), JSON.stringify(alert), { expirationTtl: ttl });
  await kv.put(routeKey(a.tenantId, a.origin, a.destination, a.date, a.currency), JSON.stringify([...ids, alert.id]), { expirationTtl: ttl });
  return alert;
}

export async function getAlert(kv: KV, tenantId: string, id: string) {
  return await kv.get(alertKey(tenantId, id), "json").catch(() => null) as FareAlert | null;
}

export async function deleteAlert(kv: KV, alert: FareAlert) {
  await kv.delete(alertKey(alert.tenantId, alert.id));
  const rk = routeKey(alert.tenantId, alert.origin, alert.destination, alert.date, alert.currency);
  const ids = ((await kv.get(rk, "json").catch(() => null) as string[] | null) ?? []).filter((x) => x !== alert.id);
  if (ids.length) await kv.put(rk, JSON.stringify(ids), { expirationTtl: ttlUntil(alert.date) });
  else await kv.delete(rk);
}

// Notify when the fare is at or under the target and lower than the last
// price we sent (by ≥ 3%), at most MAX_NOTIFICATIONS times per alert.
export function shouldNotify(alert: FareAlert, price: number) {
  if (price > alert.targetPrice) return false;
  if (alert.notifications >= MAX_NOTIFICATIONS) return false;
  return alert.lastPrice === null || price <= alert.lastPrice * 0.97;
}

async function dueAlerts(kv: KV, tenantId: string, origin: string, destination: string, date: string, currency: string, price: number) {
  const ids = (await kv.get(routeKey(tenantId, origin, destination, date, currency), "json").catch(() => null) as string[] | null) ?? [];
  const due: { alert: FareAlert; price: number }[] = [];
  for (const id of ids) {
    const alert = await getAlert(kv, tenantId, id);
    if (alert && shouldNotify(alert, price)) due.push({ alert, price });
  }
  return due;
}

export function alertSearchUrl(a: Pick<FareAlert, "origin" | "destination" | "date" | "currency">) {
  return `${WEB_URL}/search?${new URLSearchParams({
    origin: a.origin, destination: a.destination, departureDate: a.date, adults: "1", children: "0", infants: "0",
    cabinClass: "ECONOMY", tripType: "ONEWAY", currency: a.currency, sort: "price", all: "1",
  })}`;
}

// Sends the price-drop message and records it on the alert.
export async function sendFareAlerts(env: Env, db: Db, due: { alert: FareAlert; price: number }[]) {
  for (const { alert, price } of due) {
    const route = `${alert.origin} → ${alert.destination}`;
    const when = new Date(`${alert.date}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
    const book = alertSearchUrl(alert);
    const stop = `${API_URL}/api/fares/alerts/${alert.id}/stop`;
    const left = MAX_NOTIFICATIONS - alert.notifications - 1;
    // Mark first so a slow message can't be sent twice by parallel searches.
    const updated: FareAlert = { ...alert, lastPrice: price, notifications: alert.notifications + 1 };
    if (left <= 0) await deleteAlert(env.FARE_CACHE_KV, alert);
    else await env.FARE_CACHE_KV.put(`falert:${alert.tenantId}:${alert.id}`, JSON.stringify(updated), { expirationTtl: ttlUntil(alert.date) });
    await notifyCustomer(env, db, alert.tenantId, {
      email: alert.email, phone: alert.phone, category: "alert",
      subject: `Price drop: ${route} on ${when} — now ${money(price, alert.currency)}`,
      html: emailShell("Your fare alert: the price dropped", `<p><b>${escapeHtml(route)}</b> on ${escapeHtml(when)} is now <b>${escapeHtml(money(price, alert.currency))}</b> per adult (your alert: ${escapeHtml(money(alert.targetPrice, alert.currency))}).</p>
<p>Fares change quickly — book soon to lock it in.</p>
<p style="font-size:12px;color:#64748b"><a href="${stop}">Stop this alert</a></p>`, { label: "See flights", href: book }),
      whatsapp: `✈️ *Price drop* — ${route} on ${when}\nNow ${money(price, alert.currency)} per adult (your alert: ${money(alert.targetPrice, alert.currency)}).\nBook: ${book}\nStop alert: ${stop}`,
    });
  }
}
