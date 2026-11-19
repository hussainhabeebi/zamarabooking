"use client";
// Baggage on a fare card that updates when Akbar's free SSR confirms it (lib/fare-baggage-store.ts).
// Until then, and whenever nothing is confirmed, it shows exactly what the server rendered.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { allowanceLabel, normalizeAllowance } from "../lib/baggage";
import { baggageFor, requestBaggage, subscribe } from "../lib/fare-baggage-store";

type Pax = { adults: number; children: number; infants: number };
type Props = { fareId: string; pax: Pax; initialChecked: string; initialCabin: string; needed: boolean };

function useFareBaggage(fareId: string) {
  return useSyncExternalStore(subscribe, () => baggageFor(fareId), () => undefined);
}

const confirmedText = (r: ReturnType<typeof baggageFor>, kind: "checked" | "cabin"): string | null => {
  if (!r) return null;
  if ((r.status === "CONFIRMED" || r.status === "SEARCH") && r.baggage) {
    const a = normalizeAllowance(r.baggage[kind], kind);
    return a.status === "UNKNOWN" ? null : a.text;
  }
  if (r.status === "VARIES" && r.segments?.length) {
    // Different allowances on the flights of this fare: listed per flight, never merged.
    return r.segments.map((s, i) => `Flight ${i + 1} (${s.airline}): ${allowanceLabel(normalizeAllowance(s[kind], kind))}`).join(" · ");
  }
  return null;
};

/** The 🧳 tag on the card. Asks for baggage straight away when `needed` and `auto`. */
export function LiveBaggageTag({ fareId, pax, initialChecked, needed, auto }: Props & { auto: boolean }) {
  const r = useFareBaggage(fareId);
  useEffect(() => { if (needed && auto) requestBaggage(fareId, pax); }, [fareId, needed, auto]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = confirmedText(r, "checked");
  const text = live ?? (normalizeAllowance(initialChecked, "checked").status === "UNKNOWN" ? null : initialChecked);
  if (!text) return null;
  return <span className="fare-card-v2-tag tag-baggage">🧳 {text}</span>;
}

/** Check-in or cabin in the card's details. Opening "Baggage & details" asks for it when needed. */
export function LiveBaggageText({ fareId, pax, initialChecked, initialCabin, needed, kind }: Props & { kind: "checked" | "cabin" }) {
  const r = useFareBaggage(fareId);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!needed) return;
    const details = ref.current?.closest("details");
    if (!details) return;
    const onToggle = () => { if (details.open) requestBaggage(fareId, pax); };
    details.addEventListener("toggle", onToggle);
    return () => details.removeEventListener("toggle", onToggle);
  }, [fareId, needed]); // eslint-disable-line react-hooks/exhaustive-deps
  const initial = kind === "checked" ? initialChecked : initialCabin;
  const live = confirmedText(r, kind);
  return <span ref={ref}>{live ?? allowanceLabel(normalizeAllowance(initial, kind))}</span>;
}

