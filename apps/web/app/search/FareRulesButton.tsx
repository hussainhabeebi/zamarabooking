"use client";

// "Fare rules" for one fare option: cancellation / date-change charges from the
// airline (TripJack fare rules), loaded only when tapped.
import { useState } from "react";

type Rule = { category: string; description: string };
const LABEL: Record<string, string> = { CANCELLATION: "Cancellation", DATECHANGE: "Date change", NO_SHOW: "No-show", SEAT_CHARGEABLE: "Seats" };

export default function FareRulesButton({ fareId }: { fareId: string }) {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState("");

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || rules) return;
    try {
      const api = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
      const res = await fetch(`${api}/api/search/fare-rules/${encodeURIComponent(fareId)}?supplier=TRIPJACK`, { headers: { "x-tenant-slug": "poomas" } });
      const d = await res.json().catch(() => ({})) as { fareRules?: Rule[]; error?: string };
      setRules(d.fareRules ?? []);
      if (d.error) setError(d.error);
    } catch {
      setError("Couldn't load the fare rules.");
      setRules([]);
    }
  }

  return (
    <div className="fare-rules">
      <button type="button" onClick={toggle} aria-expanded={open}>{open ? "Hide fare rules" : "Fare rules"}</button>
      {open && (
        <div className="fare-rules-box">
          {!rules && !error && <span>Loading…</span>}
          {error && <span>{error}</span>}
          {rules?.length === 0 && !error && <span>The airline hasn&apos;t published rules for this fare. Charges apply as per airline policy.</span>}
          {rules?.slice(0, 8).map((r, i) => (
            <div key={i}><b>{LABEL[r.category] ?? r.category.replace(/_/g, " ").toLowerCase()}:</b> {r.description}</div>
          ))}
        </div>
      )}
    </div>
  );
}
