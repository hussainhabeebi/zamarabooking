# Customer search tracking + Admin analytics (Phase 1)

Records customer flight searches and daily visits on the website. Admin reports cover sectors, airports, travel dates, search history, abandoned searches and checkouts, conversion and revenue, with CSV export.

**Ships OFF.** Nothing is recorded until a full admin turns on **Admin → Analytics → Search tracking**. Turning it off stops recording at once; the reports keep working.

## What changed and what did not

| Area | Change |
|---|---|
| Database | Migration `0015_search_analytics.sql` adds **two new tables**, `search_events` and `site_visits`. No existing table, column, index or enum is altered. There are no foreign keys, so the migration never locks live tables. |
| Search API | `routes/search.ts` is **unchanged**. A middleware runs around `POST /api/search` (`routes/analytics.ts`). After the answer, it records the search in the background and adds the response header `X-Search-Event-Id`. The body, prices, cache and timing are untouched. |
| Booking API | `routes/book.ts` is **unchanged**. A middleware runs around `POST /api/book`. After a booking is created, it links that booking to the search in the background, using the `searchEventId` the website sends; the booking's schema ignores the field. |
| Website | `middleware.ts` sets the visitor cookie and records one visit per browser per day. The results pages send a `tracking` body field and add `se` to the Book Now links. The booking page sends `searchEventId` and a "fare selected" call. Recent searches are untouched. |
| Admin | A new **Analytics** page and a new staff section, **Customer analytics & reports**. |
| Unchanged | Pricing, markup, Akbar / TripJack calls, payment, ticketing, cancellation, fare alerts (limits unchanged), the referral reward and wallet visibility, recent searches. |

The website sends tracking in the JSON body (`tracking: { client: "web", visitor, customer, device, country, bot, prefetch }`), not in headers. The live API's routes already ignore unknown body fields, so the website can go live before or after the API.

## What counts

- **One search**: one visitor, one exact itinerary (route, dates, passengers, cabin, fare type), on one day in India time.
  - Refreshes, going back to the results, currency changes, cache hits and repeated requests that day only raise `repeat_count`.
  - Supplier polling and retries happen inside one request and are never counted.
  - This holds even under concurrent requests: the table has a unique key on `(tenant_id, dedupe_key)` and writes use "insert or update".
- **Not counted**:
  - agency logins and agent-number searches
  - Partner API calls
  - bots and link prefetches
  - requests not marked by the website
  - the fare-alert background search
  - invalid (400) requests
- **Paid booking**: a booking with a `SUCCESS`, `PARTIAL_REFUND` or `REFUNDED` payment, in a post-payment status. This is the same rule `routes/payments.ts` uses. Bookings cancelled or refunded after payment still count as converted; they are shown separately and excluded from revenue.
- **Search status**:

  | Status | Meaning |
  |---|---|
  | `BOOKED` | A paid booking came from this search, or the same visitor or customer booked the same route and date within 24 h by another path. |
  | `CHECKOUT_UNPAID` | A booking was created (same rule) but not paid. |
  | `IN_PROGRESS` | Last seen less than 24 h ago and nothing booked yet. |
  | `ABANDONED` | Had results, is older than 24 h, and nothing was booked. |
  | `NO_AVAILABILITY` | No results or a supplier error. Never counted as abandoned. |

- **Abandoned checkout**: a website booking created more than 24 h ago and never paid. It is not counted if the same customer (account, email or phone) later paid for the same route and date.
- **Conversion**: distinct paid bookings divided by searches. Two searches that led to one booking count that booking once.
- **Money**: always shown per currency (INR and AED are never added together). Dates are India time.

## Privacy

- **Visitor cookie**: `zb_vid` is a random UUID kept for 12 months. It is stored only as an HMAC keyed with a server secret, so the database cannot be used to recognise or replay the cookie.
- **Not set** when the browser sends Global Privacy Control or Do Not Track, and never for bots. Searches from those browsers are still counted, but without a visitor.
- **Never stored**: IP address, user agent, URL query strings, or guest names, emails and phone numbers. Only the device class (mobile, tablet or desktop) and the Cloudflare country code are kept.
- **Signed-in customers** are linked by user id. The login token is read only by the analytics code, from the body field and never from `Authorization`, so search pricing can't change.
- **Retention**: a cron deletes analytics rows older than 13 months. It touches only the two analytics tables.
- **Customer names, emails and phone numbers** in reports and CSV are visible only to full admins, or to staff who have both the Analytics and Bookings sections. Every CSV export and every change to the switch is written to `audit_logs`.

**Draft privacy-policy paragraph (for legal approval):**

> To improve our service we record, on our own servers, the flight searches made on ZamraBooking.com (route, dates, number of travellers, cabin, the lowest fare shown) together with a random identifier stored in a first-party cookie ("zb_vid", kept for 12 months), the type of device and the country. We do not record your IP address or browser details, and we do not link searches to your name, email or phone unless you are signed in to your account. Browsers that send a "Global Privacy Control" or "Do Not Track" signal are not given the identifier. Search records are deleted after 13 months. We use them only to understand which routes and dates our customers look for and to improve our service.

## Release (separate approvals)

1. **Merge the PR.** The website deploys through `deploy-web.yml`. It behaves the same until the API is released, and records nothing until tracking is switched on.
2. **Take a database snapshot** (e.g. a Neon branch) and note its name.
3. **Run Actions → "Release - Search analytics (migration 0015 + API + Admin)"** with:

   | Input | Value |
   |---|---|
   | `mode` | `deploy` |
   | `api_base_sha` | The commit in the latest zamra-api deploy message ("… <sha> on …") |
   | `admin_files_base_sha` | The sha in the latest zamra-admin message ("Akbar-API-booking-admin-<sha>-on-…") |
   | `pr_base_sha`, `pr_head_sha` | This PR's base and head (the head must be on main) |
   | `database_snapshot` | The snapshot or branch name from step 2 |
   | `authorization` | `DEPLOY_SEARCH_ANALYTICS_WITH_MIGRATION_0015` |

   The run:
   - checks every file is on the allowlist, and that the migration only creates objects;
   - runs the tests on the live API tree;
   - applies **only** 0015 in one transaction, checking that no existing table changed shape;
   - deploys the API, then Admin;
   - prints the **ROLLBACK TARGET** versions.
4. **Admin → Analytics → Turn on** when ready.

## Rollback

| What | How |
|---|---|
| Stop recording | Admin → Analytics → **Turn off** (immediate). |
| Code | Run the same workflow with `mode=rollback`, the printed version IDs and `ROLLBACK_SEARCH_ANALYTICS`. Revert the website merge if wanted; it is harmless either way. The two tables stay, unused. |
| Analytics data | `mode=drop-analytics-tables` with `DROP_SEARCH_ANALYTICS_TABLES` runs `packages/db/drizzle/rollback/0015_search_analytics_down.sql`, which drops only the two analytics tables. That file lives outside `migrations/`, so no workflow ever applies it automatically. |

## Follow-up after the Admin release

The Akbar and Group fares release workflows rebuild Admin from fixed files, and accept only their own deploy messages. After this release they must also keep `apps/admin/app/(dashboard)/layout.tsx` and `analytics/page.tsx`, and accept the `Search-analytics-admin-…` message. This needs a small workflow-only change before the next Akbar or Group fares Admin release.

Group fare bookings (`/group-fares`) are matched to searches only by the signed-in customer; their Book links carry no `se`.

## Tests

- **`apps/api/test/search-analytics.test.ts`** (24 tests): real Postgres (PGlite) with migrations 0001–0015. Covers:
  - deduplication and concurrency
  - exclusions
  - the answer staying byte-for-byte the same
  - database and KV failures
  - booking links
  - statuses, conversion, sectors, revenue and abandoned checkouts
  - permissions and CSV
  - the audit log and retention
  - running the migration twice, and the rollback file
- **`apps/web/test/visitor.test.cjs`**: what the website sends, opt-out, bots and prefetch, and that no custom headers are used.
