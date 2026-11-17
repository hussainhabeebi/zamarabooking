// A signed-in customer's last 10 flight searches (website "Recent searches").
// Guests keep theirs in the browser; nothing here is used for searching, pricing or booking.
//
//   GET    /api/profile/recent-searches          { searches }   newest first
//   POST   /api/profile/recent-searches          { searches: [...] } → { searches }   adds (newest first), de-duplicated, max 10
//   DELETE /api/profile/recent-searches          clears them
//
// Stored with the login in SESSIONS_KV (like the account's currency preference): no database table.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import type { Env, Variables } from "../types.js";

export const RECENT_SEARCH_LIMIT = 10;
const TTL = 60 * 60 * 24 * 365;   // kept with the login, like the account's preferences

const code = z.string().regex(/^[A-Za-z]{3}$/).transform((s) => s.toUpperCase());
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const recentSearchSchema = z.object({
  tripType:      z.enum(["ONEWAY", "ROUNDTRIP", "MULTICITY"]),
  origin:        code,
  destination:   code,
  departureDate: day,
  returnDate:    day.optional(),
  legs:          z.array(z.object({ origin: code, destination: code, departureDate: day })).min(2).max(6).optional(),
  adults:        z.number().int().min(1).max(9),
  children:      z.number().int().min(0).max(9).default(0),
  infants:       z.number().int().min(0).max(4).default(0),
  cabinClass:    z.enum(["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"]).default("ECONOMY"),
  fareType:      z.enum(["STUDENT", "SENIOR_CITIZEN"]).optional(),
  searchedAt:    z.string().datetime(),
}).transform((s) => ({
  ...s,
  // Only what the trip type uses.
  returnDate: s.tripType === "ROUNDTRIP" ? s.returnDate : undefined,
  legs: s.tripType === "MULTICITY" ? s.legs : undefined,
}));
export type RecentSearch = z.infer<typeof recentSearchSchema>;

// Two searches are "the same" when they would search the same thing.
export const recentSearchKey = (s: RecentSearch) => JSON.stringify([
  s.tripType, s.origin, s.destination, s.departureDate, s.returnDate ?? "",
  (s.legs ?? []).map((l) => `${l.origin}-${l.destination}-${l.departureDate}`), s.adults, s.children, s.infants, s.cabinClass, s.fareType ?? "",
]);

// New searches first (the newest of each repeat wins), then the saved ones; max 10.
export function mergeRecentSearches(added: RecentSearch[], saved: RecentSearch[]): RecentSearch[] {
  const out: RecentSearch[] = [];
  const seen = new Set<string>();
  const newestFirst = [...added].sort((a, b) => b.searchedAt.localeCompare(a.searchedAt));
  for (const s of [...newestFirst, ...saved]) {
    const k = recentSearchKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= RECENT_SEARCH_LIMIT) break;
  }
  return out;
}

export const recentSearchRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

recentSearchRoutes.use("*", async (c, next) => {
  if (c.get("userRole") !== "CUSTOMER" || !c.get("userId")) throw new HTTPException(401, { message: "Sign in with a customer account" });
  return next();
});

const keyFor = (c: { get: (k: "tenantId" | "userId") => unknown }) => `recent_searches:${c.get("tenantId")}:${c.get("userId")}`;

async function load(env: Env, key: string): Promise<RecentSearch[]> {
  const raw = await env.SESSIONS_KV.get(key, "json").catch(() => null);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s) => { const p = recentSearchSchema.safeParse(s); return p.success ? [p.data] : []; }).slice(0, RECENT_SEARCH_LIMIT);
}

recentSearchRoutes.get("/", async (c) => c.json({ searches: await load(c.env, keyFor(c)) }, 200, { "Cache-Control": "no-store" }));

recentSearchRoutes.post("/", zValidator("json", z.object({ searches: z.array(recentSearchSchema).min(1).max(RECENT_SEARCH_LIMIT) })), async (c) => {
  const key = keyFor(c);
  const searches = mergeRecentSearches(c.req.valid("json").searches, await load(c.env, key));
  await c.env.SESSIONS_KV.put(key, JSON.stringify(searches), { expirationTtl: TTL });
  return c.json({ searches }, 200, { "Cache-Control": "no-store" });
});

recentSearchRoutes.delete("/", async (c) => {
  await c.env.SESSIONS_KV.delete(keyFor(c));
  return c.json({ searches: [] }, 200, { "Cache-Control": "no-store" });
});
