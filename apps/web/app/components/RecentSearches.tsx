"use client";
// "Recent searches" under the flight search form: the last 10 searches (account or this browser),
// each with "Search again", and "Clear". See lib/recent-searches.ts.
import { useEffect, useState } from "react";
import styles from "./recent-searches.module.css";
import {
  RECENT_SEARCHES_EVENT, clearRecentSearches, dateLabel, loadRecentSearches, paxLabel, routeLabel, searchDatePassed, tripLabel,
  type RecentSearch,
} from "../lib/recent-searches";

const CABIN: Record<RecentSearch["cabinClass"], string> = { ECONOMY: "Economy", PREMIUM_ECONOMY: "Premium Economy", BUSINESS: "Business", FIRST: "First" };

export default function RecentSearches({ onSearchAgain, busy }: { onSearchAgain: (s: RecentSearch) => void; busy?: boolean }) {
  const [list, setList] = useState<RecentSearch[]>([]);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => { void loadRecentSearches().then((l) => { if (alive) setList(l); }); };
    load();
    window.addEventListener(RECENT_SEARCHES_EVENT, load);
    window.addEventListener("zamrabooking:profile-updated", load);
    return () => { alive = false; window.removeEventListener(RECENT_SEARCHES_EVENT, load); window.removeEventListener("zamrabooking:profile-updated", load); };
  }, []);

  if (!list.length) return null;

  async function clear() {
    if (!confirm("Clear your recent searches?")) return;
    setClearing(true);
    try { await clearRecentSearches(); setList([]); } finally { setClearing(false); }
  }

  return (
    <section className={styles.wrap} aria-label="Recent searches">
      <div className={styles.head}>
        <h3>Recent searches</h3>
        <button type="button" className={styles.clear} onClick={clear} disabled={clearing}>{clearing ? "Clearing…" : "Clear"}</button>
      </div>
      <ul className={styles.list}>
        {list.map((s) => {
          const passed = searchDatePassed(s);
          return (
            <li key={`${s.searchedAt}-${routeLabel(s)}`} className={styles.item}>
              <div className={styles.info}>
                <strong className={styles.route}>{routeLabel(s)}</strong>
                <span className={styles.dates}>
                  {dateLabel(s.departureDate)}
                  {s.tripType === "ROUNDTRIP" && s.returnDate ? ` – ${dateLabel(s.returnDate)}` : ""}
                  {s.tripType === "MULTICITY" && s.legs?.length ? ` – ${dateLabel(s.legs[s.legs.length - 1].departureDate)}` : ""}
                </span>
                <span className={styles.meta}>{tripLabel(s)} · {paxLabel(s)} · {CABIN[s.cabinClass]}{s.fareType ? ` · ${s.fareType === "STUDENT" ? "Student" : "Senior citizen"}` : ""}</span>
                {passed && <span className={styles.passed}>Date has passed — pick a new date</span>}
              </div>
              <button type="button" className={styles.again} disabled={busy} onClick={() => onSearchAgain(s)}
                aria-label={`${passed ? "Change date for" : "Search again:"} ${routeLabel(s)}`}>
                {passed ? "Change date" : "Search again"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
