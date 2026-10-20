// Plain-language flight search ("Kochi to Dubai next Friday, 2 adults and a
// baby, back after a week, cheapest with baggage") → the fields of the normal
// search form. Uses the Google Gemini API (REST, JSON-schema output); English,
// Malayalam, Hindi and Arabic. Every value is re-checked here before it is
// returned — the model only fills the form, the customer still presses Search.

import type { Env } from "../types.js";

export interface TripSearchFields {
  isFlightSearch: boolean;
  origin:         { code: string; city: string } | null;
  destination:    { code: string; city: string } | null;
  departureDate:  string | null;
  returnDate:     string | null;
  tripType:       "ONEWAY" | "ROUNDTRIP";
  adults:         number;
  children:       number;
  infants:        number;
  cabinClass:     "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
  fareType:       "REGULAR" | "STUDENT" | "SENIOR_CITIZEN";
  directOnly:     boolean;
  refundableOnly: boolean;
  withBaggage:    boolean;
  sort:           "best" | "price" | "duration" | "departure";
  currency:       "INR" | "AED" | "USD" | null;
  language:       string;
  summary:        string;
  missing:        ("origin" | "destination" | "departureDate" | "returnDate")[];
}

export class AiSearchError extends Error {
  constructor(message: string, public code: string, public status = 502) { super(message); }
}

const DEFAULT_MODEL = "gemini-2.5-flash";

const SYSTEM_PROMPT = `You turn a traveller's message into flight search fields for FlyPoomas, an online travel agency serving India and the Gulf (many travellers fly between Kerala and the GCC).

The message may be in English, Malayalam, Hindi, Arabic, or a mix (including Manglish / Hinglish written in Latin letters). Understand all of them.

Rules:
- origin / destination: the IATA airport code and the city name in English. Use the city's main international airport. Common ones: Kochi/Cochin/Ernakulam COK, Kozhikode/Calicut CCJ, Thiruvananthapuram/Trivandrum TRV, Kannur CNN, Mangalore IXE, Mumbai BOM, Delhi DEL, Bengaluru BLR, Chennai MAA, Hyderabad HYD, Kolkata CCU, Goa GOI, Ahmedabad AMD, Dubai DXB, Abu Dhabi AUH, Sharjah SHJ, Ras Al Khaimah RKT, Fujairah FJR, Al Ain AAN, Doha DOH, Muscat MCT, Salalah SLL, Riyadh RUH, Jeddah JED, Dammam DMM, Madinah MED, Kuwait KWI, Bahrain BAH, London LHR, Singapore SIN, Kuala Lumpur KUL, Bangkok BKK. If no origin is mentioned, leave it null — never guess a home city.
- Dates: resolve relative dates ("next Friday", "tomorrow", "15th", "after a week") against TODAY given in the message, as YYYY-MM-DD. A date without a year is the next upcoming one. "next <weekday>" means the first such weekday after today. "back after N days/a week" means returnDate = departureDate + N days (a week = 7).
- tripType ROUNDTRIP when a return is mentioned, otherwise ONEWAY (returnDate null).
- Passengers: adults are 12+, children 2–11 ("kid", "child", "son/daughter aged 5"), infants under 2 ("baby", "infant", "kunju", "बच्चा under 2", "رضيع"). "me and my wife" = 2 adults. Default 1 adult if nobody is mentioned.
- cabinClass: ECONOMY unless business / first / premium economy is asked for. fareType STUDENT or SENIOR_CITIZEN only when explicitly asked.
- Preferences: "cheapest/lowest" → sort price; "fastest/shortest" → sort duration; "earliest/morning first" → sort departure; otherwise best. "direct/non-stop" → directOnly. "refundable" → refundableOnly. "with baggage / check-in bag / luggage" → withBaggage.
- currency only if the traveller names one (₹/rupees INR, dirham AED, dollar USD), else null.
- missing: list origin, destination, departureDate (and returnDate for a round trip) when they are not given or cannot be resolved. Do not invent them.
- isFlightSearch false if the message is not about booking a flight.
- language: the language the traveller wrote in (e.g. "English", "Malayalam", "Hindi", "Arabic").
- summary: one short confirmation of the understood trip, written in the traveller's language.`;

// Gemini responseSchema (OpenAPI subset).
const place = { type: "OBJECT", nullable: true, properties: { code: { type: "STRING" }, city: { type: "STRING" } }, required: ["code", "city"] };
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    isFlightSearch: { type: "BOOLEAN" },
    origin:         place,
    destination:    place,
    departureDate:  { type: "STRING", nullable: true, description: "YYYY-MM-DD" },
    returnDate:     { type: "STRING", nullable: true, description: "YYYY-MM-DD" },
    tripType:       { type: "STRING", enum: ["ONEWAY", "ROUNDTRIP"] },
    adults:         { type: "INTEGER" },
    children:       { type: "INTEGER" },
    infants:        { type: "INTEGER" },
    cabinClass:     { type: "STRING", enum: ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"] },
    fareType:       { type: "STRING", enum: ["REGULAR", "STUDENT", "SENIOR_CITIZEN"] },
    directOnly:     { type: "BOOLEAN" },
    refundableOnly: { type: "BOOLEAN" },
    withBaggage:    { type: "BOOLEAN" },
    sort:           { type: "STRING", enum: ["best", "price", "duration", "departure"] },
    currency:       { type: "STRING", nullable: true, enum: ["INR", "AED", "USD"] },
    language:       { type: "STRING" },
    summary:        { type: "STRING" },
    missing:        { type: "ARRAY", items: { type: "STRING", enum: ["origin", "destination", "departureDate", "returnDate"] } },
  },
  required: ["isFlightSearch", "origin", "destination", "departureDate", "returnDate", "tripType", "adults", "children", "infants",
    "cabinClass", "fareType", "directOnly", "refundableOnly", "withBaggage", "sort", "currency", "language", "summary", "missing"],
};

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function todayIn(timeZone = "Asia/Kolkata", now = new Date()) {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return { date: ymd, weekday: WEEKDAY[new Date(`${ymd}T00:00:00Z`).getUTCDay()] };
}

// Strict: "2026-02-30" is rejected (Date would silently roll it into March).
const isoDate = (v: unknown) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const int = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T => (allowed.includes(v as T) ? (v as T) : dflt);

function airport(v: unknown): { code: string; city: string } | null {
  const o = v as { code?: unknown; city?: unknown } | null;
  const code = String(o?.code ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  return { code, city: String(o?.city ?? code).trim().slice(0, 60) || code };
}

// Re-checks the model's answer against the same rules as the search form.
export function normalizeTripFields(raw: Record<string, unknown>, today: string): TripSearchFields {
  const missing = new Set<TripSearchFields["missing"][number]>();
  const origin = airport(raw.origin);
  const destination = airport(raw.destination);
  if (!origin) missing.add("origin");
  if (!destination) missing.add("destination");
  if (origin && destination && origin.code === destination.code) missing.add("destination");

  let tripType = oneOf(raw.tripType, ["ONEWAY", "ROUNDTRIP"] as const, "ONEWAY");
  let departureDate = isoDate(raw.departureDate) ? String(raw.departureDate) : null;
  if (departureDate && departureDate < today) departureDate = null;   // never search the past
  if (!departureDate) missing.add("departureDate");
  let returnDate = isoDate(raw.returnDate) ? String(raw.returnDate) : null;
  if (returnDate) tripType = "ROUNDTRIP";
  if (tripType === "ROUNDTRIP") {
    if (!returnDate || returnDate < today || (departureDate && returnDate < departureDate)) { returnDate = null; missing.add("returnDate"); }
  } else {
    returnDate = null;
  }

  // Seats: adults + children ≤ 9; lap infants ≤ adults.
  const adults = int(raw.adults, 1, 9, 1);
  const children = int(raw.children, 0, Math.min(6, 9 - adults), 0);
  const infants = int(raw.infants, 0, Math.min(4, adults), 0);

  return {
    isFlightSearch: raw.isFlightSearch !== false,
    origin, destination, departureDate, returnDate, tripType,
    adults, children, infants,
    cabinClass:     oneOf(raw.cabinClass, ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"] as const, "ECONOMY"),
    fareType:       oneOf(raw.fareType, ["REGULAR", "STUDENT", "SENIOR_CITIZEN"] as const, "REGULAR"),
    directOnly:     raw.directOnly === true,
    refundableOnly: raw.refundableOnly === true,
    withBaggage:    raw.withBaggage === true,
    sort:           oneOf(raw.sort, ["best", "price", "duration", "departure"] as const, "best"),
    currency:       raw.currency === "INR" || raw.currency === "AED" || raw.currency === "USD" ? raw.currency : null,
    language:       String(raw.language ?? "English").slice(0, 30),
    summary:        String(raw.summary ?? "").slice(0, 300),
    missing:        [...missing],
  };
}

export async function parseTripQuery(env: Env, text: string, timeZone?: string): Promise<TripSearchFields> {
  if (!env.GEMINI_API_KEY) throw new AiSearchError("Smart search is not configured", "AI_SEARCH_UNAVAILABLE", 503);
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const today = todayIn(timeZone);
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: `TODAY: ${today.date} (${today.weekday})\n\nTraveller's message:\n${text}` }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new AiSearchError(`Gemini unreachable: ${(err as Error)?.message ?? err}`, (err as Error)?.name === "TimeoutError" ? "AI_TIMEOUT" : "AI_NETWORK_ERROR");
  }
  const body = await res.json().catch(() => null) as any;
  if (!res.ok) {
    throw new AiSearchError(`Gemini ${res.status}: ${body?.error?.message ?? "request failed"}`, res.status === 429 ? "AI_RATE_LIMITED" : "AI_ERROR", res.status === 429 ? 429 : 502);
  }
  if (body?.promptFeedback?.blockReason) throw new AiSearchError(`Gemini blocked the message (${body.promptFeedback.blockReason})`, "AI_BLOCKED", 422);
  const out = body?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(out); } catch { throw new AiSearchError(`Gemini returned no usable answer (${body?.candidates?.[0]?.finishReason ?? "empty"})`, "AI_BAD_OUTPUT"); }
  return normalizeTripFields(raw, today.date);
}
