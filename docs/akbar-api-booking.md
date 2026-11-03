# Akbar Travels API booking (B2B Revamp Flight API)

Reference: Akbar's *B2B Revamp Flight API – Test* Postman collection and *B2B Flight API Demo* environment.

## Audit against the Postman collection

| Step | Endpoint (as called) | Before this change | Now |
|---|---|---|---|
| Signature | `{utils}/Utils/Signature` | ✅ implemented, token cached 47 h | unchanged |
| ExpressSearch | `{flights}/flights/ExpressSearch` | ✅ search (Mode `SY`; collection sample uses `AS` + extra `Parameters`) | unchanged on purpose (live search works) |
| GetExpSearch | `{flights}/flights/GetExpSearch` | ✅ polled until complete | unchanged |
| WebSettings | `{utils}/Utils/WebSettings` | ❌ | **new (Nov 2026, required by Akbar)**: `{ ClientID, TUI }` after each ExpressSearch; SSR / SeatLayout skipped when it turns them off |
| SmartPricer | `{flights}/flights/SmartPricer` | client only (Mode `SY`, Options `A`), never called | booking flow uses the collection's Mode `AS`, Options `""` |
| GetSPricer | `{flights}/flights/GetSPricer` | client only | called after SmartPricer, retried while NetAmount is missing; fare validated |
| GetTravelCheckList | `{flights}/Utils/GetTravelCheckList` | client only | called with the priced TUI; passport / DOB / nationality rules enforced |
| SeatLayout | `{flights}/flights/SeatLayout` | client only | read-only lookup in UAT runs (logged for certification) |
| SSR | `{flights}/flights/ssr` | client only | read-only lookup in UAT runs (logged for certification) |
| CreateItinerary | `{flights}/flights/CreateItinerary` | ❌ missing (allowed by the gateway, no client method) | **new**: every field of the collection's sample |
| StartPay | `{flights}/Payment/StartPay` | client sent 10 of the sample's 24 fields | **all sample fields** (deposit payment, no card data) |
| GetItineraryStatus | `{flights}/Payment/GetItineraryStatus` | client only | polled after StartPay |
| RetrieveBooking | `{flights}/Utils/RetrieveBooking` | client only | called after the status; PNR / tickets read from it |
| Cancel | `{flights}/flights/cancel` | client only | unchanged (not part of this booking flow) |

Other problems fixed:

- **Certification logs.** Akbar bookings were exported with the TripJack pack: Akbar request URLs were
  rewritten to `apitest.tripjack.com`, files were named after TripJack services and checked against
  TripJack's required steps. Akbar bookings now get their own pack (`lib/akbar-certification.ts`).
- Booking flow was staff-only ("offline"); there was no way to obtain a supplier PNR from Akbar.

## Flow

1. **Checkout (`POST /api/book`)**, when API booking is enabled: SmartPricer → GetSPricer for every leg,
   GetTravelCheckList, traveller checks. A higher live fare returns `FARE_CHANGED`, missing traveller
   details `BOOKING_DETAILS_INVALID`, any other pricing failure `FARE_EXPIRED`. The priced TUI is kept
   on the booking (`flight_data.akbarBooking`).
2. **Payment** is unchanged (PhonePe / Nomod / wallet). The booking becomes `CONFIRMED` as before.
3. **Booking** (AUTO right after payment, or Admin → Booking → *Book on Akbar API*):
   SmartPricer/GetSPricer again if the checkout price is older than 10 min → CreateItinerary →
   StartPay (deposit) → GetItineraryStatus → RetrieveBooking.
4. With Akbar's PNR the booking is `TICKETED`, the e-ticket is built and emailed (same code as the staff
   *Issue ticket* button). PNRs / ticket numbers are stored only when Akbar returned them.

Round trip / multi-city: Zamra searches each leg one-way, so each leg is its own Akbar itinerary,
booked in order; a leg is never started while the previous one is not booked.

## Safety

- `flight_data.akbarBooking` is saved before every irreversible call. A leg marked `PAYMENT_SENT` is
  never paid again; later runs and *Refresh from Akbar* only call GetItineraryStatus / RetrieveBooking.
  If that state can't be saved, StartPay is not sent.
- The booking lock (queue / Admin) prevents two runs at once.
- Failure before StartPay → `offline.ticketing = PENDING`: staff ticket on Akbar's portal exactly as today.
  Paid but unconfirmed / partial → `offline.ticketing = AKBAR_CHECK` and an error event for staff. The booking
  is `TICKETED` only when every leg has Akbar's PNR; customers see "Ticket being issued" (not "Confirmed") while a
  paid booking has no PNR.
- No database migration: state lives in the existing `flight_data` JSON column.

## Enabling (UAT first)

Admin → Integrations → Akbar Travels:

- **API booking**: `OFF` (default) / `MANUAL` (button on paid bookings) / `AUTO` (after payment).
- **Contact address / city / state / PIN / country**: sent as CreateItinerary `ContactInfo`.

With environment **Live**, API booking stays blocked until the Worker variable
`AKBAR_API_BOOKING_PRODUCTION=approved` is set — only after UAT certification and approval.

## Certification logs

Admin → Bookings → booking → *Download Akbar certification logs (ZIP)*, or the multi-booking
`/api/admin/bookings/certification.zip?ids=…` (Akbar bookings go under `akbar/`). Each ZIP has
`BookingSummary.json` plus `NN-<Step>-Request.json` / `NN-<Step>-Response.json` for every Akbar call of
the booking and of its search, in order. Requests show Akbar's URL with Password, ApiKey, Key, the
Bearer token and the gateway key blanked; responses are unmodified. If the cached token's Signature
call is older than the booking, the tenant's latest Signature (within 48 h) is included.

## Certification log coverage (website booking, API booking on, Test environment)

| # | Akbar step | Logged when | Linked by |
|---|---|---|---|
| 1 | Signature | booking run (fresh token in Test) | booking |
| 2 | ExpressSearch | website search | search (`flight_data.searchId`) |
| 3 | GetExpSearch | website search — always called once while API booking is on | search |
| 4 | WebSettings | website search, right after ExpressSearch / GetExpSearch, once per search TUI (API booking on); the booking run reads it if the fare has none | search / booking |
| 5 | SmartPricer | checkout (before payment); again after payment if that price is over 10 min old | booking |
| 6 | GetSPricer | as SmartPricer | booking |
| 7 | GetTravelCheckList | as SmartPricer | booking |
| 8 | SeatLayout | booking run (read-only lookup) | booking |
| 9 | SSR | booking run (read-only lookup) | booking |
| 10 | CreateItinerary | booking run | booking |
| 11 | StartPay | booking run | booking |
| 12 | GetItineraryStatus | booking run (polled) | booking |
| 13 | RetrieveBooking | booking run | booking |

Wallet and gateway (PhonePe / Nomod) payments both end in `PAYMENT_CAPTURED` → `recordOfflinePayment`,
so the booking run is the same for either. `BookingSummary.json` lists each leg's search TUI, pricing TUI,
itinerary TUI, TransactionID, and the PNR / tickets exactly as Akbar returned them, plus any missing step.

## Open items for Akbar (blockers / undocumented)

1. **WebSettings** (implemented): response `Settings[]` of `{ Key, Value }`; `ShowSSR|SeatLayout|Baggage|Meals` +
   `Dom|Int` hold comma-separated airline codes, matched exactly against the fare's VAC / MAC / OAC for the
   flight's sector (both airports in India = Dom). Unknown sector, empty Value or no Settings never switches a
   feature off. Confirm with Akbar which carrier code (validating / marketing) the lists refer to.
2. **CreateItinerary SSR / seat items**: the sample sends `SSR: []`. Paid baggage, meals and seats need the
   SSR item format and how SSRAmount is computed; until then CreateItinerary sends no SSR and baggage stays
   a staff-handled request.
3. **Response samples** for GetSPricer, CreateItinerary, StartPay, GetItineraryStatus, RetrieveBooking and
   GetTravelCheckList (the collection has none). The parsers read `Code`, `Msg`, `TUI`, `NetAmount`,
   `TransactionID`, `CurrentStatus`, `CRSPNR` / `APNR` / `PNR` and `Ticket` / `TicketNumber`; confirm the names.
4. **Round trips in one search (RT / RS)** — see "Round-trip fares (RT / RS)" below. Remaining gaps listed there.
   UAT TransactionID 260151395 (CCJ–BLR, 1A 1C 1I): StartPay 6033, then CurrentStatus "Failed" with PaymentStatus
   "Success", RetrieveBooking Status "BO1", no PNR, no reason — Akbar to explain and confirm the deposit.
5. **Deposit / permissions**: StartPay uses `DepositPayment: true`; confirm the UAT account has deposit
   balance and CreateItinerary / StartPay permission, and that the gateway's IP is whitelisted for them.
6. **GetSPricer polling** and **GetItineraryStatus** timing: confirm when to poll and the final status values.

## Round-trip fares (RT / RS)

Admin → Integrations → Akbar → **Round-trip fares**: `OFF` (default) / `ON`. ON has an effect only while API booking
is Manual / Automatic (the fare must be priced with Akbar before payment). OFF = round trips are searched and booked
one way at a time (two Akbar itineraries, `TripType "ON"`), exactly as before.

Source: Akbar's sample payloads (RT: ExpressSearch, GetExpSearch, SmartPricer; RS: ExpressSearch, GetExpSearch, two
SmartPricer samples) and Akbar support (Nov 2026): *"CreateItinerary, GetSPricer, StartPay, GetItineraryStatus and
RetrieveBooking will be same for roundtrip and onward booking … give amount in different legs in case of smartpricer
… normal RT booking can combine different airlines or providers."*

| Step | ON (unchanged) | RT / RS (one itinerary) |
|---|---|---|
| ExpressSearch | one per leg, `FareType "ON"` | one RT and one RS search at once: `FareType "RT"` / `"RS"`, one Trip with `OnwardDate` + `ReturnDate`, `SecType` D / I (`akbarRoundTripSearchBody`) |
| GetExpSearch | `Trips[0]` | `Trips[0]` = onward, `Trips[1]` = return (`normalizeAkbarRoundTrip`) |
| Fare ids | `AK|<TUI>|<Index>` | `AK|<TUI>|<Index>|ONWARD|RETURN` — the two sides share the TUI and reuse the Index |
| Pairing | — | RT: any onward + any return of the search (airlines may differ). RS: `ReturnIdentifier` > 0 and equal, same `VAC`, same `Provider` (Index may differ); shown as Special Return, the journey page offers only the partner |
| SmartPricer | `TripType "ON"`, Mode AS | both legs, one search TUI, OrderID 1 / 2, each leg's own NetFare as Amount, Mode SS; RT: ChannelCode null, ClientID, Options "A"; RS: ChannelCode "", ClientID "", Options "" |
| GetSPricer → CreateItinerary → StartPay → GetItineraryStatus → RetrieveBooking | per leg | once, same calls as ON (Akbar) — one TransactionID for both legs |
| Price check | priced ≤ searched leg + ₹1 | GetSPricer NetAmount ≤ onward + return searched amounts + ₹1, else stopped before CreateItinerary |
| Supplier amount / markup | sum of legs, markup per leg | the same sum (= the itinerary's searched total, paid once by StartPay) |

Checkout (`POST /api/book`) refuses an RT / RS fare unless Round-trip fares is ON and API booking is allowed, and only as
the onward + return pair of one search that passes the rules above (`akbarBookingUnits`); anything else asks the
customer to search again. The booking state has one entry for the itinerary; RetrieveBooking PNRs of both legs are kept.

Tests: `apps/api/test/akbar-roundtrip.test.ts` — each request against Akbar's samples; invalid ReturnIdentifier / VAC /
Provider / Index / amounts; and a mocked search → selection → checkout → booking → status run for RT and RS.

**Still not confirmed by Akbar (ask before switching ON in UAT):**
1. **GetSPricer for RS:** Akbar's guidance said "the first leg's NetAmount already includes the combined fare". No RT /
   RS GetSPricer response sample. Zamra accepts a priced total up to the sum of the two legs' amounts; a lower total is
   accepted and the customer pays the searched price (as for one-way fares). Confirm the GetSPricer NetAmount for an RS
   pair (e.g. SG|2005: 6123 + 6320).
2. **CreateItinerary / StartPay / GetItineraryStatus / RetrieveBooking responses for RT / RS:** "same as onward"; no
   sample. RetrieveBooking is read for every PNR / ticket it lists (both legs).
3. **RS SmartPricer `ChannelCode`:** the first RS sample sent `null`, the latest `""` (followed); RS samples send
   `ClientID ""`, the RT sample the agency ClientID (followed).
4. **No UAT RT / RS booking has been made yet** — run one RT and one RS UAT booking for the certification logs.

## Release (API + Admin only) and rollback

Workflow: **Actions → "Release - Akbar API booking (API + Admin only, no migrations)"**
(`.github/workflows/release-akbar-booking.yml`, manual only, runs from `main`).

Baselines checked on 2026-11-02:

| Worker | Live build | Evidence |
|---|---|---|
| `zamra-api` | `main` @ `be140d6` (= PR #45 base) | latest deployment message "Akbar journey search be140d6… on 7850c9f…"; 7850c9f→be140d6 only changed API release files plus web/scripts/workflows |
| `zamra-admin` | `1402e86` | last full-platform deploy (run 17, 2026-10-30); `main` has one later Admin change (`RawApiCalls.tsx`) that this release does **not** ship |

No automatic deploy on merge: `deploy-web.yml` deploys only on `apps/web/**` / `packages/ui/**`
pushes (PR #45 touches neither); every other deploy workflow is manual; Cloudflare's only
Git-connected build is `zamra-api-staging` (a separate Worker, not production).

The Akbar gateway (`apps/akbar-gateway`, Coolify) must allow `/utils/Utils/WebSettings`; it is not deployed by
this workflow — redeploy it on Coolify from `main` before testing.

What it does: verifies the PR diff is limited to the allowlisted Akbar files (fails on anything
under `packages/db`, `apps/web`, `apps/portal`, or PhonePe / Nomod / wallet / checkout), builds
`zamra-api` from the live tree + the 15 Akbar API files, runs typecheck and the Akbar, PhonePe,
wallet, baggage and certification tests, refuses to deploy if the live `zamra-api` is no longer the
expected baseline, prints the rollback version, deploys; then builds `zamra-admin` from its live
tree + the 3 Admin files, prints its rollback version, deploys. No migrations.

Akbar API booking ships **Off**; nothing changes for customers until Admin sets it to Manual / Automatic.

**Rollback:** Admin → Integrations → Akbar → API booking **Off** stops the feature immediately. To restore
the previous code, run the same workflow with `mode = rollback`, the version IDs printed as
"ROLLBACK TARGET" in the deploy run, and authorization `ROLLBACK_AKBAR_BOOKING`.
