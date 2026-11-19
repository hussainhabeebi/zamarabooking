# ZamraBooking — requirements status (audited 2026-11-19 against `main` at `f7059fb`)

Checked against the code, the merged PRs and the GitHub Actions deploy history, not against earlier discussion.

**Live** means deployed to production (a deploy run succeeded). **Merged, not live** means it is in `main` but its release workflow has not been run.

## What is live right now

| Component | Live build | How it is deployed |
|---|---|---|
| Website | `main` at `f7059fb` (includes PR #92's website part) | Automatically, by `deploy-web.yml`, on every merge that touches `apps/web` |
| API (`zamra-api`) | "Akbar API booking `ea0d133` on `053fa95`", version `481d30cb…` (19 Nov, PR #90) | Manually, through a release workflow |
| Admin (`zamra-admin`) | Most likely `Akbar-API-booking-admin-8cf5d98…-on-1402e86…` (16 Nov, PR #77). `mode=validate` confirms this. | Manually, through a release workflow |
| Database | Postgres on Neon; migrations up to **0014** | Only through release workflows |

## Requirement areas

| Area | Status | Notes |
|---|---|---|
| **A. Search tracking and analytics (Phase 1)** | **Merged, not live.** The website part is live, but it sends data the live API ignores. | Migration 0015, API and Admin need the release workflow. Tracking ships OFF. |
| A. Consent / privacy | Done in code | Random cookie stored as a keyed hash; no IP or user agent; GPC / DNT respected; 13-month purge. The privacy-policy paragraph is a draft and needs legal approval before tracking is turned on. |
| **B. Fare alerts** | **Live (most of it)** | Customers create alerts (stored in KV). Notifications go by email and WhatsApp (Chatwoot), at most 3 per alert, only after a further drop of 3% or more. The "See flights" link runs a fresh live search; the booking page re-prices before payment. |
| B. Background re-checks | **Live — Akbar L2B impact to review** | The API runs a cron **every 4 hours** that re-searches up to **15** alert routes not searched in the last 3 hours. That is **up to 90 live supplier searches a day** with no booking behind them. Not changed in this PR; it needs a decision once Akbar's L2B terms are confirmed. |
| B. Fare history | Partial | A per-route price calendar is kept in KV (the cheapest fare seen per day). There is no long-term history table. |
| B. Admin view of alerts | **Missing** | Admin has no list of alert subscribers or sent notifications. Alerts live only in KV. |
| **C. WhatsApp** | Partial | It goes through Leadvyne/Chatwoot (`lib/customer-notify.ts`, `lib/notify.ts`) and is used for: booking received, fare on hold, fare-drop alerts, agency messages. |
| C. Payment confirmation / ticket issued | Partial | E-ticket emails (PDF) exist. WhatsApp coverage of every status change has not been verified. |
| C. Travel reminders, abandoned booking messages | **Missing** | There is no reminder or abandoned-booking sender. |
| C. Official WhatsApp Cloud API templates | **Not started — blocked** | Needs the credentials, number, approved templates, consent wording and pricing from the client. Nothing is invented. |
| **D. GA4 / GTM, Meta Pixel + CAPI, Google Ads** | **Not started — blocked** | No tracking scripts and no consent banner on the website. Needs the IDs, a consent banner, and privacy-policy review first. |
| **E. Referral** | **Live (customer side)** | Each customer has a code; both sides get ₹100 in the wallet after the referred customer's first booking (max 25 per referrer, 30-day window). The amounts were not changed. |
| E. Referral reporting in Admin | **Missing** | Stats are in KV, per customer; there is no Admin report. The wallet is hidden on the website (`9a940f6`), so customers can't see the rewards. This needs a client decision. |
| **F. Admin reports** | Merged, not live (Phase 1 Analytics) | Traffic, searches, sectors, airports, travel dates, conversion, abandoned searches and checkouts, revenue, CSV, permissions. Fare-alert reporting is still missing (see B). |
| **G. Full journey test** | Not run | It needs live Akbar searches. The no-booking check `live-journey-check.yml` exists. Real booking and payment are not tested without your approval. |
| Baggage display, Stage 1 | **Live** | PRs #90 (API, released 19 Nov) and #91 (website). Unknown allowance shows as "Allowance not confirmed". |
| Baggage, Stage 2 (SSR lookup before payment) | Not started | It needs Akbar to confirm support and the L2B impact. No per-result calls were added. |
| Airline logos / airport names | Live | `AirlineLogo.tsx` falls back when a logo is missing. |
| Search completeness (lost Akbar batches) | Live | PR #80 (released 17 Nov). |
| Search speed | Live | PRs #83 and #84 (released 18 Nov). No two-second promise is made. |
| Markup / fare lookup in parallel | Live | PR #84 (released 18 Nov). |
| Recent searches | Live | PRs #81 and #87 (last 4; "Search again" runs a fresh live search). |
| Direct flights only + minimum ₹700 per passenger markup for one client | **Not found** | Markup per passenger exists (`FLAT_PER_PAX`). There is no "direct only" tenant setting and no minimum-markup rule. It needs the client name and approval before it is built, per tenant, not globally. |
| WhatsApp booking bot (live flights → portal link) | Not verified | There is a Leadvyne webhook route. The bot flow itself was not found in this repo; it may live in Leadvyne. |
| Live Akbar cancellation | Kept OFF | It is a global Admin switch, off by default; the customer refund stays separate from the supplier refund. |
| Group fares | Live, manual | Published manual fares with seat holds; not auto-booked on Akbar. |
| SeatLayout / SSR | Kept restricted | Greyed out for production bookings (PR #70). |

## Old open draft PRs

| PR | Branch | Assessment |
|---|---|---|
| #13 | `feature/akbar-flight-api` | Superseded by the Akbar booking work released through `release-akbar-booking.yml`. Conflicts with `main`. |
| #14 | `release/akbar-admin-uat` | Superseded: the Akbar Admin and UAT runner are in `main`. Conflicts with `main`. |
| #25 | `fix/akbar-booking-evidence` | Superseded by later Akbar booking and status work. Conflicts with `main`. |
| #26 | `feature/phonepe-pg-v2` | Superseded: PhonePe is in `main` (`b058ce1`, migration 0013). Conflicts with `main`. |
| #49 | `fix/akbar-failure-reason` | Superseded by `2ed23ef` ("Akbar: real failure reasons…"). Conflicts with `main`. |

None of them should be merged. Close them once you agree; closing deletes nothing.
