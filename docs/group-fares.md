# Group fares

Group fares are **manual fares** (Admin → Manual fares) with **Group fare (website)** ticked. They are
Zamra's own blocked seats: no supplier API is called. Customers book and pay online, and staff issue
the ticket and enter the PNR in Admin → Bookings, the same as any manual fare.

## Admin

- **Turn on on website** (top of Manual fares) is the switch for customers. It is off by default. While
  it is off, no group fare is listed, searchable or bookable.
- A fare is shown on the website when all of these are true:
  - **Group fare** is ticked.
  - **Published** is ticked.
  - **Show in search** (active) is ticked.
  - The **sale end** has not passed.
  - The flight has not departed.
- Price and detail changes show on the website immediately. Bookings already made keep the fare and
  price they were sold at (`bookings.flight_data.offline.fare`).
- **Seats left for sale** is the live count. When you edit a group fare, the count changes by the
  difference from what your form showed, so seats a customer took while you were editing aren't lost.
- The **Seats** column shows how many seats are sold and how many are held (customers still paying).
- A group fare that has bookings can't be deleted or turned back into an ordinary fare. Deactivate or
  unpublish it instead.
- Group fares are Admin-only. Google Sheet fares can't be group fares, because the hourly sync
  replaces sheet rows.
- Every create, update and delete, and every change to the website switch, is written to `audit_logs`.

## Seats (no overbooking)

| Step | What happens |
|---|---|
| Checkout (`POST /api/book`, MANUAL) | Takes the seats and records a `HELD` row in `manual_fare_seat_holds`, in **one** conditional SQL statement (`… WHERE seats_available >= n AND published AND active AND sale open`). Two checkouts can't both get the last seats. If there aren't enough seats, the customer gets `GROUP_FARE_SOLD_OUT` and no booking is created. |
| Payment confirmed (queue) | `HELD` → `SOLD`. If the hold had already been released, the seats are taken again when they're still free. Otherwise the hold becomes `OVERSOLD` and an error event on the booking asks staff to resolve it. |
| Hold expiry (30 min, hourly cron) | Unpaid holds go back on sale. A hold is never released while the booking is paid or ticketed, or while a payment started in the last 2 hours is still pending. |
| Booking cancelled or refunded (hourly cron) | Its seats go back on sale. |

## Website

- `/group-fares` lists every fare on sale.
- `/group-fares/<id>` shows the details and the price for the chosen travellers.
- **Book now** opens the normal booking page. The price is worked out again on the server at checkout.
- The **Group fares** menu link appears only while the switch is on and at least one fare is open.

## API

- `GET /api/group-fares/status`
- `GET /api/group-fares`
- `GET /api/group-fares/:id?adults=&children=&infants=`

All are public and uncached. Internal notes are never returned.

## Release

1. Migration `0014_group_fares.sql` (additive, idempotent).
2. API and Admin, using the `release-group-fares.yml` workflow with authorization
   `DEPLOY_GROUP_FARES_WITH_MIGRATION_0014`. The migration runs before the API is deployed.
3. The website deploys through `deploy-web.yml` when the PR is merged. Until the API is live it shows
   "No group fares are open right now".

**Rollback:** run the same workflow with `mode=rollback` and the version IDs printed as `ROLLBACK TARGET`.
The 0014 columns and table can stay, because the previous code ignores them. To roll back the website,
redeploy the previous commit.
