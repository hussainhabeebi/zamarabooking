"use client";
// Website → Group fares: every published group fare on sale, with Admin's current price.
import { useEffect, useState } from "react";
import { CABIN, groupFaresUrl, HEADERS, inr, saleEnds, seatsText, travelDay, type GroupFare } from "./group-fares";
import styles from "./group-fares.module.css";

export default function GroupFaresList() {
  const [fares, setFares] = useState<GroupFare[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch(groupFaresUrl(), { headers: HEADERS, cache: "no-store" })
      // 404: the API doesn't offer group fares (yet) — same as none open.
      .then((r) => (r.ok ? r.json() : r.status === 404 ? { fares: [] } : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { fares: GroupFare[] }) => setFares(d.fares ?? []))
      .catch(() => { setFailed(true); setFares([]); });
  }, []);

  return (
    <main className={`page-container ${styles.page}`}>
      <h1 className={styles.title}>Group fares</h1>
      <p className={styles.lead}>Special fares on seats we have reserved with the airline. Pay online and we issue your ticket and send it by email.</p>

      {fares === null && <p className={styles.muted}>Loading group fares…</p>}
      {failed && <p className={styles.error}>We couldn&apos;t load group fares right now. Please try again in a moment.</p>}
      {fares && !failed && fares.length === 0 && (
        <div className={styles.empty}>
          <p><b>No group fares are open right now.</b></p>
          <p>Travelling as a group? <a href="/contact">Contact us</a> for a quote, or <a href="/#flight-search">search all flights</a>.</p>
        </div>
      )}

      <div className={styles.list}>
        {fares?.map((f) => {
          const soldOut = f.seatsLeft < Math.max(1, f.minPax);
          return (
            <a key={f.id} href={`/group-fares/${f.id}`} className={`fare-card ${styles.card}`} aria-label={`${f.title}, ${f.origin} to ${f.destination}, ${travelDay(f.travelDate)}`}>
              <div className="fare-card-airline-col">
                <div className="fare-card-airline">{f.airlineName}</div>
                <div className="fare-card-flight">{f.flightNumber} · {CABIN[f.cabinClass] ?? f.cabinClass}</div>
              </div>
              <div className="fare-card-times-col">
                <div className={styles.cardTitle}>{f.title}</div>
                <div className="fare-card-times">{f.origin} {f.departureTime} → {f.destination} {f.arrivalTime}{f.arrivalDayOffset ? <sup>+{f.arrivalDayOffset}</sup> : null}</div>
                <div className="fare-card-stops">{travelDay(f.travelDate)} · {f.stops ? `${f.stops} stop${f.stops > 1 ? "s" : ""}` : "Non-stop"} · Checked baggage {f.baggage.checked}</div>
              </div>
              <div className="fare-card-info-col">
                <div className={soldOut ? styles.soldOut : styles.seats}>{seatsText(f)}</div>
                {f.minPax > 1 && <div className="fare-card-stops">Min {f.minPax} travellers</div>}
                {f.saleEndsAt && <div className="fare-card-stops">Sale ends {saleEnds(f.saleEndsAt)}</div>}
              </div>
              <div className="fare-card-price-col">
                {f.pricePerAdult != null && <div className="fare-card-price">{inr(f.pricePerAdult)}</div>}
                <div className="fare-card-stops">per adult, taxes included</div>
                <span className={`fare-card-book-btn ${styles.cta}`}>{soldOut ? "View" : "View & book"}</span>
              </div>
            </a>
          );
        })}
      </div>
    </main>
  );
}
