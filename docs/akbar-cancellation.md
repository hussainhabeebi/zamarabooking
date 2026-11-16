# Akbar cancellation and refund tracking (Admin)

Admins can cancel Akbar **API** bookings from the booking page, then track two things separately:
the Akbar deposit refund, and the customer refund.

Code:
- `packages/suppliers/src/akbar/cancellation.ts`: Akbar request and response handling.
- `apps/api/src/lib/akbar-cancellation.ts`: rules, statuses and database steps.
- `apps/api/src/routes/admin/akbar-cancellation.ts`: Admin API.
- `apps/admin/app/(dashboard)/bookings/[id]/AkbarCancellation.tsx`: Admin screen.

## What Akbar documented (and nothing else is assumed)

### Cancel

The documented URL is `https://b2bapiflights.benzyinfotech.com/Flights//Flights/Cancel`.

Request:

```json
{
  "ClientID": "…", "ClientIP": "", "Remarks": "", "TUI": "…", "TransactionID": 240036938,
  "Trips": [{ "Journey": [{ "Segments": [{ "CRSPNR": "WP6SJY", "Pax": [{ "ID": 27693, "Ticket": "" }] }] }] }],
  "Isfullrefund": false, "CancelType": "R"
}
```

Response:

```json
{ "TUI": "…", "TransactionID": 240036938, "CancellationID": 240003849, "Code": "1903", "Msg": ["Auto Cancellation Success"] }
```

### GetRefund

The documented URL is `flightURL/Flights/GetRefund`.

Request:

```json
{ "TUI": "…", "TransactionId": 250702203, "CancelType": "R" }
```

Response: `{ TUI, transactionID, Code "200", Msg, Trips[] { destOrgin, travelType, refundable, fuId, Itineraries[] { … } } }`.
Each `Itineraries[]` line has:
- route: `from`, `to`
- `paxtype`
- charges: `cancellationCharge`, `providerCharge` (sent as a string), `atoCharge`, `K3Charge`, `rafCharge`, `stfCharge`, `VATONATOCancelCharges`
- amounts: `netAmount`, `refundAmount`

## Not confirmed by Akbar, and how each is handled

| # | Open question | What ZamraBooking does until Akbar answers |
|---|---|---|
| 1 | Path and letter case | Settings offer `/Flights/Cancel` (default), `/flights/cancel` and `/Flights//Flights/Cancel`. All three are on the gateway allowlist. Any other path is refused in code. |
| 2 | GetRefund timing, and whether it is read-only | It is treated as possibly state-changing. It is **never called on the production account** (blocked in code). On UAT it runs only when switched on, and only by an admin clicking. |
| 3 | `Isfullrefund` and `CancelType` values | Only the sample values are sent (`false`, `"R"`). They are not settings, so changing them needs a code change. |
| 4 | `Pax.ID` and `Ticket` | `ID` = RetrieveBooking `Pax[].ID`, which is the `TicketInfo[].PaxID` link seen in UAT. `Ticket` is `""` as in the sample. A setting can send the ticket number instead. |
| 5 | Partial cancellation | Off by default. Every passenger of the transaction must be selected. A smaller selection is refused, never widened. Segments are never split. |
| 6 | Which TUI to send | Default is the booking's own TUI (CreateItinerary). A setting can use the RetrieveBooking TUI instead. |
| 7 | Response codes | Only `1903` with a CancellationID, for the same transaction, counts as **CANCELLED**. Every other answer becomes **MANUAL_VERIFICATION_REQUIRED**. |
| 8 | How RetrieveBooking shows a cancellation | "Check latest status" stores Akbar's status codes exactly as written. It never changes our status from them. |
| 9 | Akbar deposit refund | Never assumed. It is marked **REFUNDED** only when an admin enters the amount actually credited and the Akbar statement reference. |
| 10 | GetRefund `transactionID` mismatch in the sample | Shown as "answered for another transaction". Amounts are never totalled, because per-passenger versus per-type is unknown. |
| 11 | UAT cancellation | The flow works on UAT test bookings once "Live cancellation" is switched on. Never use a customer booking to experiment. |

## Statuses

There are three separate status tracks.

**1. Cancellation** (`booking_amendments.status`, type `AKBAR_CANCELLATION`):

```
CANCELLATION_REQUESTED → CANCELLATION_PROCESSING → CANCELLED                        (Code 1903)
                                                 → MANUAL_VERIFICATION_REQUIRED     (timeout, network error, HTTP error, unknown code)
                                                 → CANCELLATION_FAILED              (refused by our gateway before forwarding: certainly not sent)
MANUAL_VERIFICATION_REQUIRED → CANCELLED / CANCELLATION_PENDING / CANCELLATION_FAILED   (staff, after checking Akbar's portal)
CANCELLATION_PENDING         → CANCELLED / CANCELLATION_FAILED
CANCELLATION_REQUESTED       → CANCELLATION_FAILED   (withdrawn; it was never sent)
```

**2. Akbar deposit refund** (`quote.supplierRefund.status`), which starts only once the booking is CANCELLED:

```
REFUND_PENDING → REFUNDED       (admin verified the credit: amount + statement reference)
               → REFUND_FAILED  → REFUNDED (a late credit)
```

**3. Customer refund** (`booking_amendments.refundStatus`):

```
NOT_STARTED → (admin "Refund customer", whole booking cancelled) PENDING → PROCESSING → DONE | FAILED | MANUAL_REQUIRED
```

This uses the existing refund engine (`settleRefund`), back to the original payment method. "Mark refunded manually" is available for refunds paid outside ZamraBooking.

The booking becomes **CANCELLED** only when every Akbar transaction on it is fully cancelled. Partial cancellations leave it TICKETED. The PNR, tickets, payment rows and Akbar booking state are never changed.

## Where the setting lives

"Live cancellation" is **one company-wide setting** for every Akbar API booking. It is stored once per tenant in KV, under `admin_settings:<tenant>:integration:akbar-cancellation`.

- **Where to change it:** Admin → Integrations → **Akbar cancellation**. Super admin only, and every change is audit-logged.
- **On each booking page:** the panel only shows whether it is ON or OFF. When it is ON, eligible bookings show **Cancel Booking**. When it is OFF, the button is disabled and the panel explains why, with a link to the setting.

## Safeguards

- **Off by default.** "Live cancellation" is a super-admin setting. While it is off, nothing is sent and nothing is recorded.
- **Admins only.** SUPER_ADMIN and TENANT_ADMIN. Staff cannot open these routes.
- **Review first.** RetrieveBooking (read-only) shows the PNR, passengers, ticket numbers, route and the exact request.
- **Explicit confirmation.** The admin types the PNR, ticks an acknowledgement and gives a reason.
- **What is sent is what was reviewed.** RetrieveBooking is read again at submit. A fingerprint of the transaction, TUI, segments, passengers and tickets must match the review, otherwise the request is refused.
- **Only once.**
  - Each Akbar transaction is claimed on the booking row in a single conditional UPDATE.
  - Each confirmation screen has its own request id, and a repeated request returns the first result.
  - The booking lock is also held.
  - Akbar runs, "Refresh from Akbar" and "Issue ticket" are blocked while a cancellation holds the booking.
- **Never retried.** Any unclear outcome is MANUAL_VERIFICATION_REQUIRED, with the message "check Akbar's portal; do not cancel again". A send that never recorded an answer becomes manual after 2 minutes.
- **Audit trail.**
  - Every Akbar request and response is stored in Admin → API logs (credentials redacted).
  - The amendment keeps the original and sent TUI, the passenger and ticket IDs, the request, the response, the history and the status checks.
  - `audit_logs` records every action with the admin's user id.
  - Booking events are logged under step `CANCEL`.
- **Not eligible:** Group fare and manual bookings, departed flights, failed-booking refunds and rebookings, and bookings ticketed on Akbar's portal (which have no API transaction).

## Deploying

- **API and Admin:** `release-akbar-booking.yml`, which has the new files in its allowlists. No database migration.
- **Gateway:** `apps/akbar-gateway/src/gateway.mjs` gains the cancellation paths and needs a Coolify redeploy. Until then, a Cancel is refused by the gateway (`UNSUPPORTED_AKBAR_ROUTE`). That is recorded as CANCELLATION_FAILED ("not sent"), so nothing is cancelled.
- **After deploying:** "Live cancellation" stays **OFF** until a super admin switches it on.

## Rollback

1. Run `release-akbar-booking.yml` with `mode: rollback` and the previous API and Admin version IDs.
2. Cancellations already recorded stay in `booking_amendments`, and their `akbarCancellation` claims stay on the booking. The old code ignores both.
3. In practice, turning "Live cancellation" OFF stops any new send without a rollback.
