// Reads another agency's / airline's e-ticket (PDF or photo) with Gemini so an
// agent can register an offline booking. The result is only a draft the agent
// checks; staff verify it before it is linked to anything.

import type { Env } from "../types.js";
import { SCAN_MAX_BYTES, ScanError } from "./document-scan.js";

export interface ScannedTicket {
  pnr: string | null;
  airlineBookingRef: string | null;
  airline: string | null;
  passengers: { name: string; type: "ADULT" | "CHILD" | "INFANT"; ticketNumber: string | null }[];
  segments: { from: string; to: string; flightNumber: string | null; departure: string | null; arrival: string | null; cabin: string | null; baggage: string | null }[];
  totalAmount: number | null;
  currency: string | null;
  issuedBy: string | null;
}

const TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];

const PROMPT = `Read this flight e-ticket / itinerary (PDF or photo). Return the booking details exactly as printed.
- pnr: the airline PNR / booking reference (5–8 letters/digits). airlineBookingRef: any other agency booking id.
- passengers: full names as printed (SURNAME/GIVEN becomes "GIVEN SURNAME"), type ADULT/CHILD/INFANT (default ADULT), 13-digit ticket number if shown.
- segments: IATA airport codes, flight number like "EK 531", departure/arrival as YYYY-MM-DDTHH:MM local time, cabin, baggage allowance text.
- totalAmount + currency (ISO code) only if a fare total is printed.
- isTicket false if this is not a flight ticket or itinerary.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    isTicket: { type: "BOOLEAN" },
    pnr: { type: "STRING", nullable: true },
    airlineBookingRef: { type: "STRING", nullable: true },
    airline: { type: "STRING", nullable: true },
    passengers: { type: "ARRAY", items: { type: "OBJECT", properties: {
      name: { type: "STRING" }, type: { type: "STRING", enum: ["ADULT", "CHILD", "INFANT"] }, ticketNumber: { type: "STRING", nullable: true },
    }, required: ["name", "type", "ticketNumber"] } },
    segments: { type: "ARRAY", items: { type: "OBJECT", properties: {
      from: { type: "STRING" }, to: { type: "STRING" }, flightNumber: { type: "STRING", nullable: true },
      departure: { type: "STRING", nullable: true }, arrival: { type: "STRING", nullable: true },
      cabin: { type: "STRING", nullable: true }, baggage: { type: "STRING", nullable: true },
    }, required: ["from", "to", "flightNumber", "departure", "arrival", "cabin", "baggage"] } },
    totalAmount: { type: "NUMBER", nullable: true },
    currency: { type: "STRING", nullable: true },
    issuedBy: { type: "STRING", nullable: true },
  },
  required: ["isTicket", "pnr", "airlineBookingRef", "airline", "passengers", "segments", "totalAmount", "currency", "issuedBy"],
};

export function cleanTicket(raw: Record<string, any>): ScannedTicket {
  const str = (v: unknown, max = 80) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const iata = (v: unknown) => { const s = String(v ?? "").trim().toUpperCase(); return /^[A-Z]{3}$/.test(s) ? s : ""; };
  const pnr = str(raw.pnr, 12)?.toUpperCase().replace(/[^A-Z0-9]/g, "") ?? null;
  return {
    pnr: pnr && /^[A-Z0-9]{5,8}$/.test(pnr) ? pnr : null,
    airlineBookingRef: str(raw.airlineBookingRef, 40),
    airline: str(raw.airline, 60),
    passengers: (Array.isArray(raw.passengers) ? raw.passengers : []).slice(0, 18).map((p: any) => ({
      name: String(p?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      type: ["ADULT", "CHILD", "INFANT"].includes(p?.type) ? p.type : "ADULT",
      ticketNumber: str(p?.ticketNumber, 20)?.replace(/[^0-9-]/g, "") || null,
    })).filter((p: { name: string }) => p.name.length >= 2),
    segments: (Array.isArray(raw.segments) ? raw.segments : []).slice(0, 8).map((s: any) => ({
      from: iata(s?.from), to: iata(s?.to), flightNumber: str(s?.flightNumber, 10),
      departure: str(s?.departure, 25), arrival: str(s?.arrival, 25), cabin: str(s?.cabin, 30), baggage: str(s?.baggage, 60),
    })).filter((s: { from: string; to: string }) => s.from && s.to),
    totalAmount: typeof raw.totalAmount === "number" && raw.totalAmount > 0 ? Math.round(raw.totalAmount * 100) / 100 : null,
    currency: /^[A-Z]{3}$/.test(String(raw.currency ?? "")) ? String(raw.currency) : null,
    issuedBy: str(raw.issuedBy, 80),
  };
}

export async function scanTicket(env: Env, file: File): Promise<ScannedTicket> {
  if (!env.GEMINI_API_KEY) throw new ScanError("The ticket reader is not configured", "SCAN_UNAVAILABLE", 503);
  if (!TYPES.includes(file.type)) throw new ScanError("Upload the ticket as a PDF, JPG, PNG or WEBP", "SCAN_BAD_TYPE", 415);
  if (file.size > SCAN_MAX_BYTES) throw new ScanError("The file must be under 8 MB", "SCAN_TOO_LARGE", 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const model = env.GEMINI_SCAN_MODEL || env.GEMINI_MODEL || "gemini-2.5-flash";
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: PROMPT }, { inlineData: { mimeType: file.type, data: btoa(binary) } }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA },
      }),
      signal: AbortSignal.timeout(40_000),
    });
  } catch (err) {
    throw new ScanError(`Gemini unreachable: ${(err as Error)?.message ?? err}`, "SCAN_NETWORK_ERROR");
  }
  const body = await res.json().catch(() => null) as any;
  if (!res.ok) throw new ScanError(`Gemini ${res.status}: ${body?.error?.message ?? "request failed"}`, res.status === 429 ? "SCAN_RATE_LIMITED" : "SCAN_ERROR", res.status === 429 ? 429 : 502);
  let raw: Record<string, any>;
  try { raw = JSON.parse(body?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? ""); }
  catch { throw new ScanError("The ticket could not be read", "SCAN_UNREADABLE", 422); }
  if (raw.isTicket === false) throw new ScanError("That doesn't look like a flight ticket", "SCAN_NOT_A_TICKET", 422);
  return cleanTicket(raw);
}
