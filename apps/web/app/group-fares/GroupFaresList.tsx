"use client";
// Website → Group fares: every published group fare on sale, with Admin's current price.
import { useEffect, useState } from "react";
import { CABIN, groupFaresUrl, HEADERS, inr, saleEnds, seatsText, travelDay, type GroupFare } from "./group-fares";
import { Check } from "./Icons";
import styles from "./group-fares.module.css";

export function RouteLine({ f }: { f: Pick<GroupFare, "origin" | "destination" | "departureTime" | "arrivalTime" | "arrivalDayOffset" | "stops"> }) {
  return (
    <div className={styles.route}>
      <div className={styles.end}><strong>{f.departureTime}</strong><span>{f.origin}</span></div>
      <div className={styles.line}><span>{f.stops ? `${f.stops} stop${f.stops > 1 ? "s" : ""}` : "Non-stop"}</span></div>
      <div className={`${styles.end} ${styles.endRight}`}><strong>{f.arrivalTime}{f.arrivalDayOffset ? <sup>+{f.arrivalDayOffset}</sup> : null}</strong><span>{f.destination}</span></div>
    </div>
  );
}

export function seatsClass(f: Pick<GroupFare, "seatsLeft" | "minPax">) {
  if (f.seatsLeft < Math.max(1, f.minPax)) return `${styles.seats} ${styles.seatsOut}`;
  return f.seatsLeft <= 9 ? `${styles.seats} ${styles.seatsLow}` : styles.seats;
}

export function GroupFaresHero({ children }: { children?: React.ReactNode }) {
  return (
    <section className={styles.hero}>
      <p className={styles.eyebrow}>Zamra group fares</p>
      <h1 className={styles.title}>Group fares</h1>
      <p className={styles.lead}>Special prices on seats we have reserved with the airline. Book online in minutes. We issue your ticket and email it to you.</p>
      <ul className={styles.trust}>
        <li><Check /> Seats reserved with the airline</li>
        <li><Check /> Taxes included</li>
        <li><Check /> Secure online payment</li>
      </ul>
      {children}
    </section>
  );
}

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

  const open = fares?.filter((f) => f.seatsLeft >= Math.max(1, f.minPax)).length ?? 0;

  return (
    <main className={styles.page}>
      <GroupFaresHero />

      {fares === null && <p className={styles.muted}>Loading group fares…</p>}
      {failed && <p className={styles.error}>We couldn&apos;t load group fares right now. Please try again in a moment.</p>}
      {fares && !failed && fares.length === 0 && (
        <div className={styles.empty}>
          <p><b>No group fares are open right now.</b></p>
          <p>Travelling as a group? <a href="/contact" className={styles.link}>Contact us</a> for a quote, or <a href="/#flight-search" className={styles.link}>search all flights</a>.</p>
        </div>
      )}

      {fares && fares.length > 0 && <div className={styles.toolbar}><span>{open} group fare{open === 1 ? "" : "s"} open</span><span>Prices per adult in INR</span></div>}

      <div className={styles.list}>
        {fares?.map((f) => {
          const soldOut = f.seatsLeft < Math.max(1, f.minPax);
          return (
            <a key={f.id} href={`/group-fares/${f.id}`} className={`${styles.card} ${soldOut ? styles.cardSoldOut : ""}`}
              aria-label={`${f.title}, ${f.origin} to ${f.destination}, ${travelDay(f.travelDate)}${f.pricePerAdult != null ? `, ${inr(f.pricePerAdult)} per adult` : ""}`}>
              <div className={styles.airline}>
                <span className={styles.logo} aria-hidden="true">{f.airline}</span>
                <span><span className={styles.airlineName}>{f.airlineName}</span><span className={styles.airlineMeta}>{f.flightNumber} · {CABIN[f.cabinClass] ?? f.cabinClass}</span></span>
              </div>
              <div className={styles.main}>
                <div className={styles.titleRow}><span className={styles.pill}>Group fare</span><h2 className={styles.cardTitle}>{f.title}</h2></div>
                <RouteLine f={f} />
                <div className={styles.chips}>
                  <span className={styles.chip}>{travelDay(f.travelDate)}</span>
                  <span className={styles.chip}>Baggage {f.baggage.checked}</span>
                  {f.minPax > 1 && <span className={styles.chip}>Min {f.minPax} travellers</span>}
                  {f.isRefundable && <span className={`${styles.chip} ${styles.chipGood}`}>Refundable</span>}
                </div>
              </div>
              <div className={styles.side}>
                <span className={seatsClass(f)}>{seatsText(f)}</span>
                {f.pricePerAdult != null && <span className={styles.price}>{inr(f.pricePerAdult)}</span>}
                <span className={styles.priceNote}>per adult · taxes included</span>
                <span className={`${styles.cta} ${soldOut ? styles.ctaGhost : ""}`}>{soldOut ? "View details" : "View & book"}</span>
                {f.saleEndsAt && !soldOut && <span className={styles.saleEnds}>Sale ends {saleEnds(f.saleEndsAt)}</span>}
              </div>
            </a>
          );
        })}
      </div>
    </main>
  );
}
