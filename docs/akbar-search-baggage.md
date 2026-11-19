# Akbar baggage from free SSR on search results

**Status:** built, **OFF by default**, not released. It is switched on in Admin → Integrations → Akbar → "Akbar baggage from free SSR".

## What Akbar confirmed (Nov 2026)

1. **L2B:** only availability counts towards the 100:1 look-to-book ratio.
2. **FlightInfo:** can be called before SmartPricer, but Akbar recommends free SSR for baggage. We do not use FlightInfo for baggage.
3. **SSR:** can be called before pricing, with the ExpressSearch result's Index.
4. **ExpressSearch baggage** depends on the provider. Use free SSR.
5. **AKB-SPCL** fares can be priced and booked through the API, and SSR gives their baggage.
6. **Rate limits:** Akbar asked for our API hits per minute (see below).

## Flow

```
ExpressSearch/GetExpSearch → results page (unchanged)
   └─ for Akbar fares without confirmed baggage (first 6 cards, or a card whose "Baggage & details" is opened):
      POST /api/fare-baggage → free SSR (search TUI + that fare's Index) → check-in / cabin on the card
customer picks a fare → SmartPricer → GetSPricer → booking (unchanged)
```

The search response, prices, markup, the "With baggage" filter, booking and payment are **unchanged**. The filter still uses the search's own baggage. The booking run's SSR call sends exactly what it sent before.

## Request and index mapping

Each search result (journey) is one **fare option** with its own `Index`. In UAT, IndiGo Saver is `"6E|1"` and Flexi Plus `"6E|2"` for the same flight. Zamra's fare id is `AK|<search TUI>|<Index>`. After every search the fare is kept in KV (`offline_fares:<tenant>:<tui>`) with `raw.tui`, `raw.index`, `raw.orderId` and `raw.carriers`.

```json
POST {flightsUrl}/flights/ssr
{ "ClientID": "…", "PaidSSR": false, "Source": "LV",
  "Trips": [{ "TUI": "<search TUI>", "Amount": 0, "OrderID": 1, "Index": "<that journey's Index>" }] }
```

- **OrderID**: search results have none, so we send `1`, as the booking flow does. Round-trip RT/RS fares send `1` (onward) or `2` (return), from `raw.orderId`.
- **Source**: `"LV"`, as the booking run. It can be changed in Admin once Akbar confirms (see questions).

## Response fields used

The answer is `Trips[].Journey[].Segments[]`, with these fields on each segment: `{ FUID, VAC, Index, SSR[] }`. The included allowance is the SSR item where:
- `Code` is `"BAG"`;
- `Charge` is `0`;
- `PTC` is `ADT`, `CHD` or `INF`.

Its `Description` reads **check-in, cabin**. Real UAT examples:

| Airline | Adult / child | Infant |
|---|---|---|
| IndiGo | `"15 Kg, 7 Kg"` | `"0 Kg, 7 Kg"` |
| Air India via Amadeus | `"15 Kg, 7 Kg"` | `"10 Kg, 0 Kg"` |

In those answers "AM" is the provider (Amadeus); the airline is in `VAC`.

The answer is used **only** when all of these hold:
- it holds exactly one journey;
- every flight's `VAC` is one of the fare's carriers;
- any `Index` Akbar echoes is the one we sent;
- each passenger type has exactly one free BAG item per flight.

Flights with different allowances are shown per flight (`VARIES`), never merged. Paid bags (`Charge > 0`) are never shown as the allowance. Anything else, such as Code 1025 "Unable to Fetch Store Response" or a timeout, means **"Allowance not confirmed"**.

## Limits, cache and failures

| Setting | Default | Range |
|---|---|---|
| SSR calls per minute (whole tenant; Durable Object `TENANT_RATE_LIMITER`, action `akbar-ssr`) | 30 | 1–120 |
| Fares per page request | 6 | 1–10 |
| Parallel SSR calls per request | 2 | 1–4 |
| Reuse a confirmed allowance for the same fare product | 6 h | 0–24 h |
| Timeout | 6 s | 2–15 s |

- **Over the minute limit**, a fare is answered `BUSY`. Nothing is queued, and the card is asked again only if the customer opens it.
- **Never asked:**
  - fares whose ExpressSearch baggage is already confirmed;
  - fares from other suppliers;
  - expired searches;
  - a fare already asked in this search. Each answer is kept 30 min under the exact `TUI + Index + OrderID`.
- **Fare-product cache.** The key covers:
  - provider and carriers
  - flight number
  - origin and destination
  - departure and arrival time
  - stops
  - fare type (FCType)
  - booking class (RBD)
  - cabin
  - round-trip side
  - which passenger types are present

  It **never includes the price**, so another fare option, flight, date or class is never served from it. Only `CONFIRMED` answers are stored there.
- **Failures:** every SSR call is logged in Admin → API logs (`supplier_exchanges`). Any failure means `UNKNOWN`. The page keeps the search's text, and booking is unaffected.
- **Off on the API** (or the API without the feature) means the first answer is `enabled:false` (or 404), and the page never asks again.

## API hits per minute (for Akbar)

### Per action, from the code

| Action | ExpressSearch (**availability, L2B**) | GetExpSearch (polls of that search) | WebSettings | SmartPricer | GetSPricer | GetTravelCheckList | SSR | SeatLayout | CreateItinerary / StartPay | GetItineraryStatus / RetrieveBooking |
|---|---|---|---|---|---|---|---|---|---|---|
| One-way search (5-min cache miss) | 1 | 4 typical (measured), **max ~16** (1 s polls for 12 s, then 2 s, until 22 s) | 1 (API booking on) | – | – | – | – | – | – | – |
| Round trip, "Round-trip fares" ON | 2 (RT + RS) | 2 × 4 (max 32) | 2 | – | – | – | – | – | – | – |
| Round trip OFF / multi-city (N legs) | N | N × 4 | N | – | – | – | – | – | – | – |
| Cached search (same search within 5 min) | 0 | 0 | 0 | – | – | – | – | – | – | – |
| **New:** search baggage (per results page) | – | – | – | – | – | – | ≤ 6 automatic + 1 per details opened; **≤ 30/min site-wide** | – | – | – |
| Checkout (passenger details submitted) | – | – | – | 1 per leg | 1–4 (2 s apart) | 1 per leg | – | – | – | – |
| Paid booking (booking run) | – | – | 0–1 | 0–1 (re-price if > 10 min) | 0–4 | 0–1 | 1 per leg | 1 per leg | 1 + 1 per leg | polls + 1 |
| Fare-alert background check (cron every 4 h) | ≤ 15 per run | ≤ 60 per run | ≤ 15 | – | – | – | – | – | – | – |
| Hourly auto-check (only paid bookings without PNR / tickets) | – | – | – | – | – | – | – | – | – | 2 per such booking |

The fare-alert check runs its searches one after another. Each takes about 9 s, so a run is about 2–3 min: about **6 ExpressSearch/min** while it runs, about **0.06/min** averaged over 4 h. It skips routes searched in the last 3 h, and its limits are unchanged.

### Estimate by traffic

Measured today, each search is ~4 GetExpSearch polls and 7–11 s. Every search waits for one Akbar call at a time (two for RT+RS), so **concurrent Akbar calls ≈ searches in progress ≈ searches per minute × 10 s / 60**.

| Customer searches / min (cache misses) | ExpressSearch / min (L2B) | GetExpSearch / min (typ / max) | WebSettings / min | SSR / min (new, capped) | Concurrent Akbar calls (typ) |
|---|---|---|---|---|---|
| 1 (quiet) | 1 | 4 / 16 | 1 | ≤ 6 | ~1 |
| 5 (busy) | 5 | 20 / 80 | 5 | ≤ 30 (cap) | 1–2 |
| 10 (peak) | 10 | 40 / 160 | 10 | ≤ 30 (cap) | 2–4 |
| + fare-alert run (every 4 h, ~3 min) | +6 | +24 | +6 | 0 | +1 |
| + checkouts (each) | 0 | 0 | 0 | 0 | SmartPricer 1, GetSPricer ≤ 4, TravelCheckList 1 |

These rows are **estimates**. For Akbar, send the **actual** numbers from our own logs. Every Akbar call is stored in `supplier_exchanges`, so this read-only query gives them (it needs approval to run on production):

```sql
-- Akbar calls per minute by endpoint, last 7 days: peak, 99th percentile, average.
WITH m AS (
  SELECT date_trunc('minute', started_at) AS minute, endpoint, count(*) AS hits
  FROM supplier_exchanges
  WHERE supplier = 'AKBAR' AND started_at > now() - interval '7 days'
  GROUP BY 1, 2)
SELECT endpoint, max(hits) AS peak_per_min,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY hits) AS p99_per_min,
       round(sum(hits)::numeric / (7 * 24 * 60), 2) AS avg_per_min
FROM m GROUP BY endpoint ORDER BY peak_per_min DESC;
```

## Questions for Akbar

1. **SSR before pricing, exact request:** use the TUI from ExpressSearch or from the last GetExpSearch? Should `OrderID` be `1` (search results return none)? Should `Amount` be `0` or the fare's NetFare? Should `Source` be `"LV"` or `"CF"`?
2. Can **one SSR request carry several Trips** (Indexes) to cut calls?
3. **L2B:** does each **GetExpSearch poll** count as availability, or only ExpressSearch?
4. **Rate limits:** what per-minute limit applies to SSR, SmartPricer and GetSPricer, and to ExpressSearch and GetExpSearch?
5. **Round-trip RT/RS (special return):** SSR per side with OrderID 1 and 2, or one call for the pair?
6. How long after the search does the **TUI stay valid** for SSR? We saw Code 1025 "Unable to Fetch Store Response".
7. Is the **free BAG item** always one per passenger type per flight, with Description "check-in, cabin"? Does it reflect the **fare option** (Saver vs Flexi) at availability?
8. For **AKB-SPCL** fares (providers such as "SP1" and "BNT"), does the free SSR give the airline's allowance for that fare?

## Release (separate approval)

- **API + Admin:** `release-akbar-booking.yml` (no migration). Use `pr_head_sha` = the API/Admin commit, because that workflow refuses website files in the range.
  - Set `keep_search_analytics_admin=true` only once the Search analytics Admin page is live.
- **Website:** deploys on merge. It asks nothing until the API has the feature **and** it is switched on.
- **Rollback:**
  - switch it off in Admin (immediate);
  - or roll back the API, Admin and website versions.
