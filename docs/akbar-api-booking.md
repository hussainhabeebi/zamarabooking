# Akbar Travels API booking (B2B Revamp Flight API)

Reference: Akbar's *B2B Revamp Flight API – Test* Postman collection and *B2B Flight API Demo* environment.

## Audit against the Postman collection

| Step | Endpoint (as called) | Before this change | Now |
|---|---|---|---|
| Signature | `{utils}/Utils/Signature` | ✅ implemented, token cached 47 h | unchanged |
| ExpressSearch | `{flights}/flights/ExpressSearch` | ✅ search (Mode `SY`; collection sample uses `AS` + extra `Parameters`) | unchanged on purpose (live search works) |
| GetExpSearch | `{flights}/flights/GetExpSearch` | ✅ polled until complete | unchanged |
| WebSettings | — | ❌ | ❌ **not in the collection**: no URL, request or response to implement |
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
  Paid but unconfirmed / partial → `offline.ticketing = AKBAR_CHECK` and an error event for staff.
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

## Open items for Akbar (blockers / undocumented)

1. **WebSettings**: not in the collection. Need the URL, request and response (and whether it is required).
2. **CreateItinerary SSR / seat items**: the sample sends `SSR: []`. Paid baggage, meals and seats need the
   SSR item format and how SSRAmount is computed; until then CreateItinerary sends no SSR and baggage stays
   a staff-handled request.
3. **Response samples** for GetSPricer, CreateItinerary, StartPay, GetItineraryStatus, RetrieveBooking and
   GetTravelCheckList (the collection has none). The parsers read `Code`, `Msg`, `TUI`, `NetAmount`,
   `TransactionID`, `CurrentStatus`, `CRSPNR` / `APNR` / `PNR` and `Ticket` / `TicketNumber`; confirm the names.
4. **Round-trip pricing**: the environment has OW/RT variables (`IndexOW`, `IndexRT`, …) suggesting a combined
   RT SmartPricer, but no sample. Zamra books legs as separate one-way itineraries.
5. **Deposit / permissions**: StartPay uses `DepositPayment: true`; confirm the UAT account has deposit
   balance and CreateItinerary / StartPay permission, and that the gateway's IP is whitelisted for them.
6. **GetSPricer polling** and **GetItineraryStatus** timing: confirm when to poll and the final status values.
