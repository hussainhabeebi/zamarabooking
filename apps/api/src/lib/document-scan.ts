// Passport / ID scan → traveller fields (Google Gemini vision, JSON schema).
//
// Gemini reads the document image; when the passport's machine-readable zone
// (the two "<<<" lines) is visible we parse it ourselves and verify its check
// digits. MRZ values that pass the checksum win over what the model read, so
// the passport number, date of birth and expiry are as reliable as the
// airline's own scanner. Nothing is stored.

import type { Env } from "../types.js";

export interface ScannedTraveller {
  documentType:   "PASSPORT" | "NATIONAL_ID" | "OTHER";
  firstName:      string;          // given names, as printed
  lastName:       string;          // surname, as printed
  dob:            string | null;   // YYYY-MM-DD
  gender:         "M" | "F" | null;
  nationality:    string | null;   // ISO 3166-1 alpha-2
  documentNumber: string | null;
  expiryDate:     string | null;
  issueDate:      string | null;
  issuingCountry: string | null;   // ISO alpha-2
  mrzVerified:    boolean;         // MRZ present and every check digit valid
  confidence:     number;          // 0–1 (1 when the MRZ verified)
  warnings:       string[];
}

export class ScanError extends Error {
  constructor(message: string, public code: string, public status = 502) { super(message); }
}

export const SCAN_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"];
export const SCAN_MAX_BYTES = 8 * 1024 * 1024;

// ISO 3166 alpha-3 → alpha-2 for the passports we see most (plus the ICAO "D" for Germany).
const A3: Record<string, string> = {
  IND: "IN", ARE: "AE", SAU: "SA", QAT: "QA", OMN: "OM", KWT: "KW", BHR: "BH", PAK: "PK", BGD: "BD", LKA: "LK", NPL: "NP",
  PHL: "PH", EGY: "EG", JOR: "JO", LBN: "LB", SYR: "SY", YEM: "YE", IRQ: "IQ", IRN: "IR", AFG: "AF", MDV: "MV", BTN: "BT",
  GBR: "GB", USA: "US", CAN: "CA", AUS: "AU", NZL: "NZ", DEU: "DE", D: "DE", FRA: "FR", ITA: "IT", ESP: "ES", NLD: "NL",
  BEL: "BE", CHE: "CH", AUT: "AT", SWE: "SE", NOR: "NO", DNK: "DK", FIN: "FI", IRL: "IE", PRT: "PT", POL: "PL", RUS: "RU",
  UKR: "UA", TUR: "TR", CHN: "CN", JPN: "JP", KOR: "KR", SGP: "SG", MYS: "MY", IDN: "ID", THA: "TH", VNM: "VN", HKG: "HK",
  NGA: "NG", KEN: "KE", ZAF: "ZA", ETH: "ET", SDN: "SD", MAR: "MA", DZA: "DZ", TUN: "TN", BRA: "BR", MEX: "MX", ARG: "AR",
};
const iso2 = (v: unknown): string | null => {
  const s = String(v ?? "").trim().toUpperCase().replace(/<+/g, "");
  if (/^[A-Z]{2}$/.test(s)) return s;
  return A3[s] ?? null;
};

// ── MRZ (ICAO 9303 TD3, two lines of 44) ───────────────────────────────────

const charValue = (ch: string) => (ch === "<" ? 0 : /\d/.test(ch) ? Number(ch) : ch.charCodeAt(0) - 55);
export function checkDigit(field: string): number {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < field.length; i++) sum += charValue(field[i]) * weights[i % 3];
  return sum % 10;
}

// YYMMDD → YYYY-MM-DD; birth dates can't be in the future, expiries are within 20 years ahead.
function mrzDate(yymmdd: string, kind: "birth" | "expiry", now = new Date()): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2)), mm = yymmdd.slice(2, 4), dd = yymmdd.slice(4, 6);
  const thisYY = now.getUTCFullYear() % 100;
  const century = kind === "birth" ? (yy > thisYY ? 1900 : 2000) : (yy < thisYY - 30 ? 2100 : 2000);
  const iso = `${century + yy}-${mm}-${dd}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

export interface MrzResult {
  valid: boolean;
  surname: string; givenNames: string;
  documentNumber: string; nationality: string | null; issuingCountry: string | null;
  dob: string | null; expiryDate: string | null; gender: "M" | "F" | null;
}

export function parseTd3(line1: string, line2: string): MrzResult | null {
  const l1 = line1.replace(/\s/g, "").toUpperCase().replace(/«/g, "<");
  const l2 = line2.replace(/\s/g, "").toUpperCase().replace(/«/g, "<");
  if (l1.length !== 44 || l2.length !== 44 || l1[0] !== "P") return null;
  const [surnamePart, givenPart = ""] = l1.slice(5).split("<<");
  const docNo = l2.slice(0, 9), docCd = l2[9];
  const dob = l2.slice(13, 19), dobCd = l2[19];
  const exp = l2.slice(21, 27), expCd = l2[27];
  const optional = l2.slice(28, 42), optCd = l2[42];
  const composite = l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, 43);
  const ok = (field: string, cd: string) => /\d/.test(cd) && checkDigit(field) === Number(cd);
  const valid = ok(docNo, docCd) && ok(dob, dobCd) && ok(exp, expCd)
    && (optCd === "<" ? /^<*$/.test(optional) : ok(optional, optCd)) && ok(composite, l2[43]);
  const sex = l2[20];
  return {
    valid,
    surname: surnamePart.replace(/</g, " ").trim(),
    givenNames: givenPart.replace(/</g, " ").replace(/\s+/g, " ").trim(),
    documentNumber: docNo.replace(/</g, ""),
    nationality: iso2(l2.slice(10, 13)),
    issuingCountry: iso2(l1.slice(2, 5)),
    dob: mrzDate(dob, "birth"),
    expiryDate: mrzDate(exp, "expiry"),
    gender: sex === "M" ? "M" : sex === "F" ? "F" : null,
  };
}

// ── Gemini ──────────────────────────────────────────────────────────────────

const PROMPT = `Read this travel document photo (passport identity page, national ID card such as Emirates ID / Aadhaar / Iqama / GCC ID, or a residence card).
Return only the requested JSON.
- Copy names exactly as printed in Latin letters (no translation, keep spelling). surname = family name / last name; givenNames = all given names. If the document shows only one name, put it in givenNames and leave surname empty.
- Dates as YYYY-MM-DD. Nationality and issuing country as ISO 3166 codes when clear.
- documentNumber: the passport / ID number exactly.
- If the passport's machine-readable zone (two lines of 44 characters with "<") is visible, copy both lines exactly into mrzLine1 and mrzLine2; otherwise leave them empty.
- Never guess: leave a field empty if it is not readable. confidence is your overall confidence 0 to 1.
- isTravelDocument false if the image is not an identity document.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    isTravelDocument: { type: "BOOLEAN" },
    documentType:     { type: "STRING", enum: ["PASSPORT", "NATIONAL_ID", "OTHER"] },
    surname:          { type: "STRING" },
    givenNames:       { type: "STRING" },
    dateOfBirth:      { type: "STRING" },
    gender:           { type: "STRING", enum: ["M", "F", "X", ""] },
    nationality:      { type: "STRING" },
    documentNumber:   { type: "STRING" },
    issueDate:        { type: "STRING" },
    expiryDate:       { type: "STRING" },
    issuingCountry:   { type: "STRING" },
    mrzLine1:         { type: "STRING" },
    mrzLine2:         { type: "STRING" },
    confidence:       { type: "NUMBER" },
  },
  required: ["isTravelDocument", "documentType", "surname", "givenNames", "dateOfBirth", "gender", "nationality",
    "documentNumber", "issueDate", "expiryDate", "issuingCountry", "mrzLine1", "mrzLine2", "confidence"],
};

// Strict: "1990-02-30" is rejected (Date would silently roll it into March).
const realDate = (v: string) => { const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; };
const isoDate = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && realDate(v) ? v : null);
const cleanName = (v: unknown) => String(v ?? "").toUpperCase().replace(/[^A-Z' -]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

export function buildScanResult(raw: Record<string, any>, today = new Date().toISOString().slice(0, 10)): ScannedTraveller {
  const warnings: string[] = [];
  const mrz = raw.mrzLine1 && raw.mrzLine2 ? parseTd3(String(raw.mrzLine1), String(raw.mrzLine2)) : null;
  const useMrz = Boolean(mrz?.valid);
  if (mrz && !mrz.valid) warnings.push("The passport’s machine-readable lines didn’t verify — please double-check the passport number and dates.");

  const firstName = cleanName(useMrz ? mrz!.givenNames || raw.givenNames : raw.givenNames);
  const lastName = cleanName(useMrz ? mrz!.surname || raw.surname : raw.surname);
  const dob = useMrz ? mrz!.dob : isoDate(raw.dateOfBirth);
  const expiryDate = useMrz ? mrz!.expiryDate : isoDate(raw.expiryDate);
  const result: ScannedTraveller = {
    documentType: ["PASSPORT", "NATIONAL_ID"].includes(raw.documentType) ? raw.documentType : (useMrz ? "PASSPORT" : "OTHER"),
    firstName, lastName, dob,
    gender: useMrz ? mrz!.gender : raw.gender === "M" || raw.gender === "F" ? raw.gender : null,
    nationality: (useMrz ? mrz!.nationality : null) ?? iso2(raw.nationality),
    documentNumber: (useMrz ? mrz!.documentNumber : String(raw.documentNumber ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")) || null,
    expiryDate,
    issueDate: isoDate(raw.issueDate),
    issuingCountry: (useMrz ? mrz!.issuingCountry : null) ?? iso2(raw.issuingCountry),
    mrzVerified: useMrz,
    confidence: useMrz ? 1 : Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
    warnings,
  };
  if (!firstName && !lastName) warnings.push("We couldn’t read the name — please type it exactly as on the document.");
  if (firstName && !lastName) warnings.push("Only one name is printed on this document. Airlines usually need it as both first and last name — check with your ticket rules.");
  if (expiryDate && expiryDate < today) warnings.push("This document has expired.");
  else if (expiryDate && Date.parse(`${expiryDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`) < 183 * 86_400_000) {
    warnings.push("This passport expires within 6 months — many countries won’t allow entry.");
  }
  if (!useMrz && result.confidence < 0.7) warnings.push("The photo was hard to read — please check every field.");
  return result;
}

export async function scanDocument(env: Env, file: File): Promise<ScannedTraveller> {
  if (!env.GEMINI_API_KEY) throw new ScanError("Document scanner is not configured", "SCAN_UNAVAILABLE", 503);
  if (!SCAN_TYPES.includes(file.type)) throw new ScanError("Use a JPG, PNG, WEBP, HEIC photo or a PDF", "SCAN_BAD_TYPE", 415);
  if (file.size > SCAN_MAX_BYTES) throw new ScanError("The file must be under 8 MB", "SCAN_TOO_LARGE", 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: PROMPT }, { inlineData: { mimeType: file.type, data: btoa(binary) } }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new ScanError(`Gemini unreachable: ${(err as Error)?.message ?? err}`, (err as Error)?.name === "TimeoutError" ? "SCAN_TIMEOUT" : "SCAN_NETWORK_ERROR");
  }
  const body = await res.json().catch(() => null) as any;
  if (!res.ok) throw new ScanError(`Gemini ${res.status}: ${body?.error?.message ?? "request failed"}`, res.status === 429 ? "SCAN_RATE_LIMITED" : "SCAN_ERROR", res.status === 429 ? 429 : 502);
  const text = body?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  let raw: Record<string, any>;
  try { raw = JSON.parse(text); } catch { throw new ScanError("The document could not be read", "SCAN_UNREADABLE", 422); }
  if (raw.isTravelDocument === false) throw new ScanError("That doesn’t look like a passport or ID card", "SCAN_NOT_A_DOCUMENT", 422);
  return buildScanResult(raw);
}
