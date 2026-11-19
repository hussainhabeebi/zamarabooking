// Confirmed baggage for Akbar fares on the results page, from /api/fare-baggage (the API asks Akbar's free
// SSR, within strict limits — apps/api/src/lib/akbar-search-baggage.ts). Off on the API → the first answer
// says enabled:false and this page never asks again. Any failure leaves the server-rendered text.

import { API } from "./customer-api";
import type { StructuredBaggage } from "./baggage";

export type FareBaggage = {
  status: "SEARCH" | "CONFIRMED" | "VARIES" | "UNKNOWN" | "BUSY" | "EXPIRED" | "INVALID";
  baggage?: StructuredBaggage;
  segments?: { airline: string; checked: string; cabin: string; checkedStatus: string; cabinStatus: string }[];
};
type Pax = { adults: number; children: number; infants: number };

const MAX_PER_REQUEST = 6;
const results = new Map<string, FareBaggage>();
const asked = new Set<string>();
const listeners = new Set<() => void>();
let queue: { id: string; pax: Pax }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let disabled = false;

export const baggageFor = (fareId: string) => results.get(fareId);
export function subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
const notify = () => listeners.forEach((fn) => fn());

/** Ask once for this fare (batched; nothing when the API has the feature off). */
export function requestBaggage(fareId: string, pax: Pax, fetcher: typeof fetch = fetch) {
  if (disabled || asked.has(fareId) || !fareId.startsWith("AK|")) return;
  asked.add(fareId);
  queue.push({ id: fareId, pax });
  if (!timer) timer = setTimeout(() => { timer = null; void flush(fetcher); }, 150);
}

async function flush(fetcher: typeof fetch) {
  while (queue.length && !disabled) {
    const pax = queue[0].pax;
    const batch = queue.filter((q) => q.pax.adults === pax.adults && q.pax.children === pax.children && q.pax.infants === pax.infants).slice(0, MAX_PER_REQUEST);
    queue = queue.filter((q) => !batch.includes(q));
    try {
      const r = await fetcher(`${API}/api/fare-baggage`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-tenant-slug": "zamra" },
        body: JSON.stringify({ fareIds: batch.map((b) => b.id), ...pax }),
      });
      if (!r.ok) { if (r.status === 404) disabled = true; continue; }   // API without the feature yet
      const d = await r.json() as { enabled?: boolean; fares?: Record<string, FareBaggage> };
      if (d.enabled === false) { disabled = true; break; }
      for (const [id, v] of Object.entries(d.fares ?? {})) {
        results.set(id, v);
        if (v.status === "BUSY") asked.delete(id);   // may be asked again when the customer opens the card
      }
      notify();
    } catch { /* keep the page as it is */ }
  }
}

/** For tests. */
export function resetBaggageStore() { results.clear(); asked.clear(); queue = []; disabled = false; if (timer) clearTimeout(timer); timer = null; }
