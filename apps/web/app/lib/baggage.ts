// Included baggage: one reading of the allowance text for every supplier and every page.
//
// Akbar sends the included allowance as ONE text, check-in first and cabin second:
//   "25 Kg,7 Kg"                                   → check-in 25 kg, cabin 7 kg
//   "N,7 kg + Personal item(max 3 kg)"             → no check-in bag, cabin 7 kg + personal item
//   "0 Kg,1 Pc |UP TO 15 POUNDS/7 KILOGRAMS"       → no check-in bag, cabin 1 piece up to 7 kg
//   "30Kg"                                         → check-in 30 kg, cabin not given
// The same order is used in Akbar's SSR answer for the free bag ("15 Kg, 7 Kg"; infants "0 Kg, 7 Kg").
//
// Status:
//   INCLUDED  the airline allowance is known and is more than nothing
//   NONE      the fare has no bag of this kind ("N", "0 Kg", "0Kg", "Not included")
//   UNKNOWN   the supplier sent nothing usable. Shown as BAGGAGE_UNKNOWN_TEXT, never as an allowance.
//
// COPY of packages/suppliers/src/baggage.ts (the website has no workspace packages). Change both
// together: apps/web/test/baggage.test.cjs checks the two give the same answers.

export type BaggageStatus = "INCLUDED" | "NONE" | "UNKNOWN";
export interface BaggageAllowance { text: string; status: BaggageStatus }
export interface BaggageView { checked: BaggageAllowance; cabin: BaggageAllowance }

export const BAGGAGE_UNKNOWN_TEXT = "Allowance not confirmed";
export const NO_CHECKED_BAG_TEXT = "No check-in bag";
export const NO_CABIN_BAG_TEXT = "No cabin bag";

type Kind = "checked" | "cabin";
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").replace(/\s+/g, " ").trim();
const noneText = (kind: Kind) => (kind === "checked" ? NO_CHECKED_BAG_TEXT : NO_CABIN_BAG_TEXT);
const pieces = (n: number) => `${n} piece${n === 1 ? "" : "s"}`;
// "1 piece, up to 7 kg" / "2 pieces, up to 23 kg each"
const piecesUpTo = (n: number, kg: number) => `${pieces(n)}, up to ${kg} kg${n > 1 ? " each" : ""}`;

// Texts that only say "ask the airline" — no allowance in them.
const UNKNOWN_RE = /^(as per (the )?airline( rules| policy| norms)?|as per fare rules?|n\/?a|not available|unknown|-+|allowance not confirmed|check(-| )?in not confirmed)$/i;
// No bag of this kind.
const NONE_RE = /^(n|nil|none|no|not included|no bags?|no baggage|no check-?in bag(gage)?|no cabin bag(gage)?|0+(\.0+)?\s*(kg|kgs|kilos?|kilograms?|pc|pcs|piece|pieces|p)?)$/i;

const KG = "(?:kg|kgs|kilos?|kilograms?)";
const PC = "(?:pc|pcs|piece|pieces)";

/** One allowance text (check-in or cabin) → a clean text and its status. Safe to run twice. */
export function normalizeAllowance(raw: unknown, kind: Kind): BaggageAllowance {
  const s = str(raw);
  if (!s || UNKNOWN_RE.test(s)) return { text: "", status: "UNKNOWN" };
  if (NONE_RE.test(s)) return { text: noneText(kind), status: "NONE" };
  let m: RegExpMatchArray | null;
  // "25 Kg", "30Kg", "30 KGS", "30" (Akbar gives bare numbers in kg)
  if ((m = s.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*${KG}?$`, "i")))) return { text: `${Number(m[1])} kg`, status: "INCLUDED" };
  // "1 Pc", "2 pieces"
  if ((m = s.match(new RegExp(`^(\\d+)\\s*${PC}$`, "i")))) return { text: pieces(Number(m[1])), status: "INCLUDED" };
  // "1 Pc |UP TO 15 POUNDS/7 KILOGRAMS", "2 Pc | UP TO 70 POUNDS/32 KILOGRAMS"
  if ((m = s.match(new RegExp(`^(\\d+)\\s*${PC}\\s*\\|?\\s*up to\\s*\\d+(?:\\.\\d+)?\\s*(?:pounds?|lbs?)\\s*/\\s*(\\d+(?:\\.\\d+)?)\\s*${KG}$`, "i")))) {
    return { text: piecesUpTo(Number(m[1]), Number(m[2])), status: "INCLUDED" };
  }
  // "1 Pc/1x7kg each" (same count both sides)
  if ((m = s.match(new RegExp(`^(\\d+)\\s*${PC}\\s*/\\s*(\\d+)\\s*x\\s*(\\d+(?:\\.\\d+)?)\\s*${KG}(?:\\s*each)?$`, "i"))) && m[1] === m[2]) {
    return { text: piecesUpTo(Number(m[1]), Number(m[3])), status: "INCLUDED" };
  }
  // "1 X 7KG"
  if ((m = s.match(new RegExp(`^(\\d+)\\s*x\\s*(\\d+(?:\\.\\d+)?)\\s*${KG}$`, "i")))) return { text: piecesUpTo(Number(m[1]), Number(m[2])), status: "INCLUDED" };
  // Already in our words: "1 piece, up to 7 kg", "2 pieces, up to 32 kg each"
  if ((m = s.match(/^(\d+) pieces?, up to (\d+(?:\.\d+)?) kg( each)?$/i))) return { text: piecesUpTo(Number(m[1]), Number(m[2])), status: "INCLUDED" };

  // Anything else is kept word for word (its restrictions matter), with tidy units and spacing:
  // "7 kg + Personal item(max 3 kg)" → "7 kg + Personal item (max 3 kg)".
  const text = s
    .replace(new RegExp(`(\\d)\\s*${KG}\\b`, "gi"), "$1 kg")
    .replace(/(\S)\(/g, "$1 (")
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s+/g, " ")
    .trim();
  // An allowance is only "included" when the text names a weight or piece count above zero.
  const counted = new RegExp(`(^|[^\\d.])([1-9]\\d*(?:\\.\\d+)?)\\s*(?:kg|${PC}\\b)`, "i").test(text);
  return { text, status: counted ? "INCLUDED" : "UNKNOWN" };
}

/** Akbar's combined text → its check-in part and cabin part, as sent (split at the first top-level comma). */
export function splitAkbarBaggage(raw: unknown): { checked: string; cabin: string } {
  const s = str(raw);
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) return { checked: s.slice(0, i).trim(), cabin: s.slice(i + 1).trim() };
  }
  return { checked: s, cabin: "" };
}

/** What a fare carries: clean texts ("" when unknown) plus the two statuses. */
export interface StructuredBaggage { checked: string; cabin: string; checkedStatus: BaggageStatus; cabinStatus: BaggageStatus }

/** Akbar Inclusions.Baggage → the fare's baggage. */
export function akbarBaggage(raw: unknown): StructuredBaggage {
  const parts = splitAkbarBaggage(raw);
  const checked = normalizeAllowance(parts.checked, "checked");
  const cabin = normalizeAllowance(parts.cabin, "cabin");
  return { checked: checked.text, cabin: cabin.text, checkedStatus: checked.status, cabinStatus: cabin.status };
}

/**
 * Any stored or supplier baggage → what to show. `akbar` marks an Akbar fare: a value saved before
 * this reading existed (no status, cabin empty or "As per airline", a comma in check-in) is split
 * the Akbar way first, so older search results and bookings show correctly too.
 */
export function baggageView(b: { checked?: unknown; cabin?: unknown; checkedStatus?: unknown } | null | undefined, opts: { akbar?: boolean } = {}): BaggageView {
  let checkedRaw = b?.checked;
  let cabinRaw = b?.cabin;
  if (opts.akbar && !b?.checkedStatus && normalizeAllowance(cabinRaw, "cabin").status === "UNKNOWN" && str(checkedRaw).includes(",")) {
    const parts = splitAkbarBaggage(checkedRaw);
    checkedRaw = parts.checked;
    cabinRaw = parts.cabin;
  }
  return { checked: normalizeAllowance(checkedRaw, "checked"), cabin: normalizeAllowance(cabinRaw, "cabin") };
}

/** The text for a page: the allowance, "No check-in bag", or BAGGAGE_UNKNOWN_TEXT. */
export const allowanceLabel = (a: BaggageAllowance) => (a.status === "UNKNOWN" && !a.text ? BAGGAGE_UNKNOWN_TEXT : a.text);

// ── Website only (not in the suppliers copy) ────────────────────────────────

/** A search / journey fare's baggage. Akbar fares from before the split reading are split too. */
export function fareBaggageView(f: { id?: string; supplier?: string; baggage?: { checked?: unknown; cabin?: unknown; checkedStatus?: unknown } | null } | null | undefined): BaggageView {
  return baggageView(f?.baggage, { akbar: f?.supplier === "AKBAR" || String(f?.id ?? "").startsWith("AK|") });
}

/** The cleaned baggage to carry to the next page (URL / session): known texts only, statuses kept. */
export function carriedBaggage(v: BaggageView): StructuredBaggage {
  return { checked: v.checked.text, cabin: v.cabin.text, checkedStatus: v.checked.status, cabinStatus: v.cabin.status };
}

/** Short check-in text for a card tag: "25 kg", "No check-in bag", or null when not confirmed. */
export const checkedTag = (v: BaggageView) => (v.checked.status === "UNKNOWN" ? null : v.checked.text);
