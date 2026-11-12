// One Special Group Fare in the flight results: its own card and its own "Book Group Fare" action,
// which opens the normal booking page for the MANUAL group fare (seats held at checkout).
import { groupFareBookUrl, groupFareDetailsUrl, type SearchGroupFare } from "./group-fare-results";
import styles from "./group-fare-card.module.css";

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const CABIN: Record<string, string> = { ECONOMY: "Economy", PREMIUM_ECONOMY: "Premium economy", BUSINESS: "Business", FIRST: "First" };

export default function GroupFareResultCard({ fare, sameFlightAsAbove, payCurrency }: { fare: SearchGroupFare; sameFlightAsAbove?: boolean; payCurrency?: string | null }) {
  const travellers = fare.quote.pax.adults + fare.quote.pax.children + fare.quote.pax.infants;
  const low = fare.seatsLeft <= 9;
  return (
    <article className={`${styles.card} ${sameFlightAsAbove ? styles.attached : ""}`} aria-label={`Special Group Fare ${fare.airlineName} ${fare.flightNumber}`}>
      <div className={styles.head}>
        <span className={styles.badge}>★ Special Group Fare</span>
        {sameFlightAsAbove && <span className={styles.note}>Same flight as above, from our reserved seats</span>}
        <span className={`${styles.seats} ${low ? styles.seatsLow : ""}`}>{low ? `Only ${fare.seatsLeft} seat${fare.seatsLeft === 1 ? "" : "s"} left` : `${fare.seatsLeft} seats left`}</span>
      </div>
      <div className={styles.body}>
        <div className={styles.airline}>
          <span className={styles.logo} aria-hidden="true">{fare.airline}</span>
          <span><b>{fare.airlineName}</b><small>{fare.flightNumber} · {CABIN[fare.cabinClass] ?? fare.cabinClass}</small></span>
        </div>
        <div className={styles.route}>
          <div><strong>{fare.departureTime}</strong><span>{fare.origin}</span></div>
          <div className={styles.line}><span>{fare.stops ? `${fare.stops} stop${fare.stops > 1 ? "s" : ""}` : "Non-stop"}</span></div>
          <div className={styles.right}><strong>{fare.arrivalTime}{fare.arrivalDayOffset ? <sup>+{fare.arrivalDayOffset}</sup> : null}</strong><span>{fare.destination}</span></div>
        </div>
        <div className={styles.priceCol}>
          <div className={styles.price}>{inr(fare.quote.total)}</div>
          <div className={styles.priceNote}>
            {travellers > 1 ? `total for ${travellers} travellers` : "per adult"} · INR{fare.pricePerAdult != null && travellers > 1 ? ` · ${inr(fare.pricePerAdult)}/adult` : ""}
          </div>
          {fare.quote.problem
            ? <a href={groupFareDetailsUrl(fare)} className={`${styles.book} ${styles.bookGhost}`}>View group fare</a>
            : <a href={groupFareBookUrl(fare)} className={styles.book}>Book Group Fare</a>}
        </div>
      </div>
      <div className={styles.foot}>
        <span className={styles.title}>{fare.title}</span>
        <span className={styles.chip}>🧳 {fare.baggage.checked}</span>
        {fare.isRefundable && <span className={styles.chip}>✓ Refundable</span>}
        {fare.minPax > 1 && <span className={styles.chip}>Min {fare.minPax} travellers</span>}
        {payCurrency && payCurrency !== "INR" && <span className={styles.chip}>Paid in INR</span>}
        <a href={groupFareDetailsUrl(fare)} className={styles.details}>Fare details</a>
      </div>
      {fare.quote.problem && <p className={styles.problem}>{fare.quote.problem} Change the travellers on the fare page.</p>}
    </article>
  );
}
