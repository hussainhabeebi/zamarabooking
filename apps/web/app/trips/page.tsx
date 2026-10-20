"use client";

import { useEffect, useState } from "react";
import { apiCall, inr, readCustomerToken, STATUS_LABEL } from "../lib/customer-api";
import styles from "./trips.module.css";

interface TripRow {
  id: string; status: string; pnr: string | null; origin: string; destination: string;
  departureDate: string | null; totalAmount: number; currency: string;
  adultCount: number; childCount: number; infantCount: number; createdAt: string;
}
type Filter = "all" | "upcoming" | "payment" | "past" | "cancelled";
const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "All" }, { id: "upcoming", label: "Upcoming" },
  { id: "payment", label: "Awaiting Payment" }, { id: "past", label: "Past departures" },
  { id: "cancelled", label: "Cancelled" },
];
const confirmed = ["CONFIRMED", "TICKETED", "REISSUED"];
function dateValue(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
function matches(trip: TripRow, filter: Filter, today: number) {
  if (filter === "all") return true;
  if (filter === "payment") return trip.status === "PAYMENT_PENDING";
  if (filter === "cancelled") return ["CANCELLED", "REFUNDED"].includes(trip.status);
  const day = dateValue(trip.departureDate);
  if (day === null || !confirmed.includes(trip.status)) return false;
  return filter === "upcoming" ? day >= today : day < today;
}
function dateLabel(value: string | null) {
  const date = dateValue(value);
  return date === null ? "Date pending" : new Date(date).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

export default function TripsPage() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState("");
  useEffect(() => {
    const ok = Boolean(readCustomerToken());
    setSignedIn(ok);
    if (!ok) { setLoading(false); return; }
    apiCall<{ trips: TripRow[] }>("/api/profile/trips").then((data) => setTrips(data.trips))
      .catch((e) => { if (e.status === 401 || e.status === 403) setSignedIn(false); else setError(e.message); })
      .finally(() => setLoading(false));
  }, []);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const visible = trips.filter((trip) => matches(trip, filter, today));
  const counts = Object.fromEntries(filters.map(({ id }) => [id, trips.filter((trip) => matches(trip, id, today)).length])) as Record<Filter, number>;

  return <main className={styles.page}><div className={styles.container}>
    <header className={styles.hero}>
      <img className={styles.heroImage} src="/trips/airplane-wing-clouds.webp" alt="" width="2048" height="694" fetchPriority="high" />
      <div className={styles.heroContent}><h1>My Trips</h1><p>Manage your bookings and travel details</p></div>
    </header>
    {signedIn === null || (loading && signedIn) ? <div className={styles.message} role="status">Loading your bookings…</div>
      : !signedIn ? <section className={styles.message}>
        <h2>Sign in to see your trips</h2><p>Bookings made with your account will appear here.</p>
        <div className={styles.actions}>
          <a className={styles.primaryAction} href="/login?next=/trips">Sign in</a>
          <a className={styles.secondaryAction} href="/signup?next=/trips">Create account</a>
        </div>
        <p className={styles.guest}>Booked as a guest? <a href="/trips/find">Find your booking with PNR + email</a></p>
      </section> : <>
        <nav className={styles.filters} aria-label="Filter bookings">
          {filters.map(({ id, label }) => <button key={id} type="button"
            className={`${styles.filter} ${filter === id ? styles.selected : ""}`}
            aria-pressed={filter === id} onClick={() => setFilter(id)}>{label} <span className={styles.count}>{counts[id]}</span></button>)}
        </nav>
        {error ? <div className={styles.error} role="alert">{error}</div>
          : visible.length ? <div className={styles.list}>{visible.map((trip) => <TripCard key={trip.id} trip={trip} />)}</div>
            : <section className={styles.message}>
              <span className={styles.emptyIcon} aria-hidden="true">✈</span>
              <h2>{trips.length ? "No bookings in this view" : "No bookings yet"}</h2>
              <p>{trips.length ? "Try another filter to see your other bookings." : "Your bookings will appear here after you book while signed in."}</p>
              {trips.length ? <button type="button" className={styles.secondaryAction} onClick={() => setFilter("all")}>View all bookings</button>
                : <a className={styles.primaryAction} href="/">Search flights</a>}
            </section>}
      </>}
  </div></main>;
}

function TripCard({ trip }: { trip: TripRow }) {
  const status = STATUS_LABEL[trip.status] ?? { label: trip.status.replaceAll("_", " ").toLowerCase(), color: "#334155", bg: "#f1f5f9" };
  const passengers = trip.adultCount + trip.childCount + trip.infantCount;
  return <article className={styles.card}>
    <div className={styles.cardHead}><div><span className={styles.cardEyebrow}><span aria-hidden="true">✈</span> Flight booking</span>
      <h2>{trip.origin} <span aria-hidden="true">→</span> {trip.destination}</h2></div>
      <span className={styles.status} style={{ color: status.color, backgroundColor: status.bg }}>{status.label}</span>
    </div>
    <p className={styles.summary}>{dateLabel(trip.departureDate)} <span aria-hidden="true">·</span> {passengers} traveller{passengers === 1 ? "" : "s"}</p>
    <div className={styles.journey} aria-label={`${trip.origin} to ${trip.destination}`}>
      <div><small>From</small><strong>{trip.origin}</strong></div>
      <span className={styles.routeLine} aria-hidden="true"><span>✈</span></span>
      <div className={styles.destination}><small>To</small><strong>{trip.destination}</strong></div>
    </div>
    <div className={styles.cardFoot}>
      <div className={styles.facts}>
        <span><small>Booking ID</small><strong>{trip.id.slice(0, 8).toUpperCase()}</strong></span>
        {trip.pnr && <span><small>Airline PNR</small><strong>{trip.pnr}</strong></span>}
        <span><small>Total amount</small><strong>{inr(trip.totalAmount, trip.currency)}</strong></span>
      </div>
      <a className={styles.secondaryAction} href={`/trips/${trip.id}`}>View booking <span aria-hidden="true">→</span></a>
    </div>
  </article>;
}
