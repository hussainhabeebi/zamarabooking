"use client";

// "Describe your trip" box above the regular flight search form. Sends the
// traveller's own words (English, Malayalam, Hindi, Arabic…) to
// /api/ai/trip-search and fills the form with the answer. The regular form
// stays fully usable; nothing is searched until the traveller presses Search.

import { FormEvent, useEffect, useState } from "react";

export type AiTripFields = {
  origin: { code: string; city: string } | null;
  destination: { code: string; city: string } | null;
  departureDate: string | null;
  returnDate: string | null;
  tripType: "ONEWAY" | "ROUNDTRIP";
  adults: number; children: number; infants: number;
  cabinClass: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
  fareType: "REGULAR" | "STUDENT" | "SENIOR_CITIZEN";
  directOnly: boolean; refundableOnly: boolean; withBaggage: boolean;
  sort: "best" | "price" | "duration" | "departure";
  currency: "INR" | "AED" | "USD" | null;
  language: string; summary: string;
  missing: ("origin" | "destination" | "departureDate" | "returnDate")[];
};

const EXAMPLES = [
  "Kochi to Dubai next Friday, 2 adults and a baby, back after a week, cheapest with baggage",
  "കോഴിക്കോട് നിന്ന് ദോഹയിലേക്ക് ഡിസംബർ 20, 2 പേർ",
  "दिल्ली से मुंबई कल सुबह, सबसे सस्ती फ्लाइट",
  "من دبي إلى كوتشي يوم الخميس القادم، شخصان",
];

const MISSING_LABEL: Record<string, string> = {
  origin: "where you’re flying from", destination: "where you’re going",
  departureDate: "your travel date", returnDate: "your return date",
};

export function AiTripSearch({ onApply, onSearchNow }: { onApply: (f: AiTripFields) => void; onSearchNow: () => void }) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
  const [enabled, setEnabled] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AiTripFields | null>(null);
  const [example, setExample] = useState(0);

  useEffect(() => {
    fetch(`${apiUrl}/api/ai/status`, { headers: { "x-tenant-slug": "poomas" } })
      .then((r) => r.json()).then((d) => setEnabled(Boolean(d?.tripSearch))).catch(() => setEnabled(false));
  }, [apiUrl]);

  // Rotate the placeholder through the four languages.
  useEffect(() => {
    if (text) return;
    const t = window.setInterval(() => setExample((i) => (i + 1) % EXAMPLES.length), 4000);
    return () => window.clearInterval(t);
  }, [text]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim().length < 3 || busy) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const timeZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })();
      const res = await fetch(`${apiUrl}/api/ai/trip-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": "poomas" },
        body: JSON.stringify({ text: text.trim(), ...(timeZone ? { timeZone } : {}) }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.fields) { setError(typeof d.error === "string" ? d.error : "We couldn't read that. Please use the search form below."); return; }
      setResult(d.fields);
      onApply(d.fields);
    } catch {
      setError("We couldn't reach the server. Please use the search form below.");
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) return null;
  const ready = result && result.missing.length === 0;

  return (
    <div className="ai-search">
      <form onSubmit={submit} className="ai-search-row">
        <span className="ai-search-icon" aria-hidden="true">✨</span>
        <input
          dir="auto"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={EXAMPLES[example]}
          aria-label="Describe your trip in your own words"
          maxLength={400}
          className="ai-search-input"
        />
        <button type="submit" className="ai-search-btn" disabled={busy || text.trim().length < 3}>
          {busy ? <><i className="search-spinner" aria-hidden="true" /> Reading…</> : "Fill search"}
        </button>
      </form>
      <p className="ai-search-hint">Type your trip in English, മലയാളം, हिन्दी or العربية — we’ll fill in the form for you.</p>
      {error && <p className="ai-search-error" role="alert">{error}</p>}
      {result && (
        <div className={ready ? "ai-search-result ai-search-ready" : "ai-search-result"} role="status">
          <div dir="auto">
            <b>{result.summary || "Search filled in"}</b>
            {result.missing.length > 0 && (
              <small>Please add {result.missing.map((m) => MISSING_LABEL[m]).join(" and ")} below.</small>
            )}
          </div>
          {ready && <button type="button" className="ai-search-go" onClick={onSearchNow}>Search now →</button>}
        </div>
      )}
    </div>
  );
}
