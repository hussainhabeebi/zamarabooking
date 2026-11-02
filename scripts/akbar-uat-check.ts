// Akbar UAT certification runner — run from a machine whose calls Akbar accepts
// (through apps/akbar-gateway, or directly from the whitelisted IP). Never touches
// Zamra's database or production Worker.
//
// READ-ONLY by default (no itinerary, no payment, no ticket):
//   Signature → ExpressSearch → GetExpSearch → SmartPricer (AS) → GetSPricer →
//   GetTravelCheckList → FareRule → SSR → SeatLayout
//
// Booking steps (CreateItinerary → StartPay → GetItineraryStatus → RetrieveBooking) run
// ONLY when AKBAR_ALLOW_BOOKING=I_APPROVE_UAT_BOOKING is set AND the hosts are Akbar's
// UAT hosts. This creates a real UAT booking paid from the UAT deposit.
//
// Every executed call is written as NN-<Step>-Request.json / NN-<Step>-Response.json
// (Akbar URL, Password / ApiKey / Key / token blanked, responses unmodified) plus
// mapping.json (what Zamra's parsers read from each response) and a ZIP of it all.
//
// Usage (repo root, after pnpm install):
//   AKBAR_UTILS_URL=https://b2bapiutils.benzyinfotech.com \
//   AKBAR_FLIGHTS_URL=https://b2bapiflights.benzyinfotech.com \
//   AKBAR_MERCHANT_ID=… AKBAR_API_KEY=… AKBAR_CLIENT_ID=… AKBAR_PASSWORD=… AKBAR_BROWSER_KEY=… \
//   [AKBAR_AGENT_CODE=…] [AKBAR_KEY=…] [AKBAR_GATEWAY_URL=https://akbar-proxy… AKBAR_GATEWAY_KEY=…] \
//   node --import ./packages/db/node_modules/tsx/dist/loader.mjs scripts/akbar-uat-check.ts BOM DEL 2026-12-15 [outDir]
//
// Booking run (only after approval) also needs AKBAR_TRAVELLER_JSON and AKBAR_CONTACT_JSON, e.g.
//   AKBAR_TRAVELLER_JSON='[{"type":"ADULT","firstName":"Test","lastName":"Passenger","gender":"M","dob":"1990-01-01"}]'
//   AKBAR_CONTACT_JSON='{"fName":"Test","lName":"Passenger","mobile":"9999999999","email":"ops@…","address":"…","city":"KOCHI","state":"Kerala","pin":"682001","countryCode":"IN"}'

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AkbarClient, akbarBookingRefs, akbarCode, akbarMessages, akbarNetAmount, akbarTransactionId, akbarTravelRequirements,
  itineraryFinalStatus, searchTui, type AkbarExchange,
} from "../packages/suppliers/src/index.js";
import { akbarJourneys } from "../packages/suppliers/src/akbar/adapter.js";
import { akbarTravellers } from "../apps/api/src/lib/akbar-booking.js";
import { buildZip } from "../apps/api/src/lib/zip.js";

const UAT_HOSTS = ["b2bapiutils.benzyinfotech.com", "b2bapiflights.benzyinfotech.com"];
const env = process.env;
const need = (k: string) => { const v = env[k]; if (!v) { console.error(`Missing ${k}`); process.exit(2); } return v; };

export const STEP_BY_PATH: Record<string, string> = {
  signature: "Signature", expresssearch: "ExpressSearch", getexpsearch: "GetExpSearch", smartpricer: "SmartPricer", getspricer: "GetSPricer",
  gettravelchecklist: "GetTravelCheckList", farerule: "FareRule", ssr: "SSR", seatlayout: "SeatLayout", createitinerary: "CreateItinerary",
  startpay: "StartPay", getitinerarystatus: "GetItineraryStatus", retrievebooking: "RetrieveBooking",
};
export const stepName = (endpoint: string) => STEP_BY_PATH[(endpoint.split("/").pop() ?? "").toLowerCase()] ?? endpoint;

// Recorded request → the request as Akbar received it (Akbar URL, no gateway key).
export function asSent(x: AkbarExchange, hosts: { utils: string; flights: string }) {
  const path = x.endpoint;
  const url = `${(path === "/Utils/Signature" ? hosts.utils : hosts.flights).replace(/\/+$/, "")}${path}`;
  return { url, method: x.method, headers: x.requestHeaders, body: JSON.parse(x.requestBody), sentAt: x.startedAt };
}

// What Zamra's parsers read from each response — to check the mapping against Akbar's real answers.
export function mapping(step: string, body: string | null) {
  let data: unknown = null;
  try { data = body == null ? null : JSON.parse(body); } catch { return { json: false }; }
  const top = data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data as object) : [];
  const out: Record<string, unknown> = { json: true, topLevelKeys: top, Code: akbarCode(data), Msg: akbarMessages(data) };
  if (["ExpressSearch", "GetExpSearch", "SmartPricer", "GetSPricer", "CreateItinerary"].includes(step)) out.TUI = searchTui(data);
  if (["GetSPricer", "CreateItinerary"].includes(step)) out.NetAmount = akbarNetAmount(data);
  if (step === "CreateItinerary" || step === "StartPay") out.TransactionID = akbarTransactionId(data);
  if (step === "GetTravelCheckList") { const { raw: _r, ...req } = akbarTravelRequirements(data); out.requirements = req; }
  if (step === "GetItineraryStatus") out.CurrentStatus = itineraryFinalStatus(data) || String((data as any)?.CurrentStatus ?? "");
  if (["GetItineraryStatus", "RetrieveBooking"].includes(step)) out.refs = akbarBookingRefs(data);
  if (step === "GetExpSearch" || step === "ExpressSearch") out.journeys = akbarJourneys(data, 0).length;
  return out;
}

async function main() {
  const [from, to, date, outArg] = process.argv.slice(2);
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) { console.error("Usage: … akbar-uat-check.ts FROM TO YYYY-MM-DD [outDir]"); process.exit(2); }
  const hosts = { utils: need("AKBAR_UTILS_URL"), flights: need("AKBAR_FLIGHTS_URL") };
  const isUat = [hosts.utils, hosts.flights].every((u) => UAT_HOSTS.includes(new URL(u).host));
  const booking = env.AKBAR_ALLOW_BOOKING === "I_APPROVE_UAT_BOOKING";
  if (booking && !isUat) { console.error("Booking steps are only allowed against Akbar's UAT hosts."); process.exit(2); }

  const exchanges: AkbarExchange[] = [];
  const client = new AkbarClient({
    utilsUrl: hosts.utils, flightsUrl: hosts.flights, merchantId: need("AKBAR_MERCHANT_ID"), apiKey: need("AKBAR_API_KEY"),
    clientId: need("AKBAR_CLIENT_ID"), password: need("AKBAR_PASSWORD"), agentCode: env.AKBAR_AGENT_CODE ?? "",
    browserKey: need("AKBAR_BROWSER_KEY"), key: env.AKBAR_KEY ?? "",
    gatewayUrl: env.AKBAR_GATEWAY_URL || undefined, gatewayKey: env.AKBAR_GATEWAY_KEY || undefined,
    recorder: (x) => { exchanges.push(x); console.log(`${String(exchanges.length).padStart(2, "0")} ${stepName(x.endpoint).padEnd(18)} HTTP ${x.status ?? "-"}${x.error ? ` ${x.error}` : ""} ${x.durationMs}ms`); },
  });
  const outDir = outArg ?? join("akbar-uat-logs", new Date().toISOString().replace(/[:.]/g, "-"));
  let stoppedAt = "";
  const note = (s: string) => { stoppedAt = s; console.log(`\n${s}`); };

  try {
    const auth = await client.signature();
    const params = { origin: from, destination: to, departureDate: date, adults: 1, children: 0, infants: 0, cabinClass: "ECONOMY" as const, tripType: "ONEWAY" as const, currency: "INR" as const };
    const search = await client.search(params, auth);
    const journeys = akbarJourneys(search.data, 0).filter((j) => Number(j.NetFare) > 0 && !(Number(j.ReturnIdentifier) > 0));
    if (!journeys.length) return note("Stopped: the search returned no bookable journeys.");
    const j = journeys.reduce((a, b) => (Number(b.NetFare) < Number(a.NetFare) ? b : a));
    const leg = { tui: searchTui(search.data), index: String(j.Index), orderId: (j.OrderID as number) ?? 1, netFare: Number(j.NetFare) };
    console.log(`Selected ${j.FlightNo ?? ""} ${j.DepartureTime ?? ""} NetFare ${leg.netFare} Index ${leg.index}`);
    const trip = { amount: leg.netFare, index: leg.index, orderId: leg.orderId, tui: leg.tui };

    const sp = await client.smartPricer([trip], "ON", auth, "AS", "");
    const spTui = searchTui(sp) || leg.tui;
    let priced: unknown = null;
    for (let i = 0; i < 4; i++) {
      if (i) await new Promise((r) => setTimeout(r, 2000));
      priced = await client.getSPricer(spTui, auth);
      if (akbarNetAmount(priced) != null || (akbarCode(priced) && akbarCode(priced) !== "200")) break;
    }
    const pricedTui = searchTui(priced) || spTui;
    const net = akbarNetAmount(priced);
    if (net == null) return note(`Stopped: GetSPricer returned no NetAmount (Code ${akbarCode(priced)} ${akbarMessages(priced)}).`);
    console.log(`Live fare ${net} (searched ${leg.netFare})`);

    const checklist = await client.getTravelCheckList(pricedTui, auth).catch((e) => (console.warn(`GetTravelCheckList: ${e.message}`), null));
    await client.fareRule([{ ...trip, tui: pricedTui }], auth).catch((e) => console.warn(`FareRule: ${e.message}`));
    await client.ssr({ tui: pricedTui, orderId: leg.orderId, index: "" }, false, auth).catch((e) => console.warn(`SSR: ${e.message}`));
    await client.seatLayout({ tui: pricedTui, orderId: leg.orderId }, auth).catch((e) => console.warn(`SeatLayout: ${e.message}`));

    if (!booking) return note("Read-only run complete — stopped before CreateItinerary (set AKBAR_ALLOW_BOOKING=I_APPROVE_UAT_BOOKING after approval).");
    if (net > leg.netFare + 1) return note(`Stopped: live fare ${net} is above the searched ${leg.netFare}.`);

    const pax = JSON.parse(need("AKBAR_TRAVELLER_JSON"));
    const { travellers, problems } = akbarTravellers(pax, date, checklist ? akbarTravelRequirements(checklist) : undefined);
    if (problems.length) return note(`Stopped: ${problems.join(" ")}`);
    const it = await client.createItinerary({ tui: pricedTui, netAmount: net, contact: JSON.parse(need("AKBAR_CONTACT_JSON")), travellers }, auth);
    const transactionId = akbarTransactionId(it);
    if (akbarCode(it) !== "200" || !transactionId) return note(`Stopped: CreateItinerary Code ${akbarCode(it)} ${akbarMessages(it)} (no StartPay sent).`);
    const itTui = searchTui(it) || pricedTui;
    const itNet = akbarNetAmount(it) ?? net;
    // StartPay is sent exactly once; on a timeout the status calls below tell what happened.
    await client.startPay({ transactionId, netAmount: itNet, tui: itTui }, auth).catch((e) => console.warn(`StartPay outcome unknown: ${e.message}`));
    const status = await client.waitForItinerary(transactionId, itTui, auth, { deadlineMs: 120_000 });
    const retrieved = await client.retrieveBooking(transactionId, auth, itTui).catch((e) => (console.warn(`RetrieveBooking: ${e.message}`), null));
    const refs = akbarBookingRefs(retrieved ?? status.data);
    note(`Booking run: TransactionID ${transactionId}, status "${status.status || "pending"}", PNR ${refs.pnrs.join(", ") || "(none returned)"}, tickets ${refs.tickets.join(", ") || "(none returned)"}`);
  } catch (err) {
    note(`Stopped on error: ${err instanceof Error ? err.message : String(err)}${(err as any)?.responseSnippet ? `\n${(err as any).responseSnippet}` : ""}`);
  } finally {
    write(outDir, exchanges, hosts, stoppedAt);
  }
}

function write(outDir: string, exchanges: AkbarExchange[], hosts: { utils: string; flights: string }, stoppedAt: string) {
  if (!exchanges.length) return;
  mkdirSync(outDir, { recursive: true });
  const enc = new TextEncoder();
  const files: { name: string; data: Uint8Array; date: Date }[] = [];
  const map: Record<string, unknown>[] = [];
  exchanges.forEach((x, i) => {
    const n = String(i + 1).padStart(2, "0");
    const step = stepName(x.endpoint);
    const at = new Date(x.startedAt);
    files.push({ name: `${n}-${step}-Request.json`, data: enc.encode(JSON.stringify(asSent(x, hosts), null, 2)), date: at });
    if (x.responseBody != null) {
      let isJson = true; try { JSON.parse(x.responseBody); } catch { isJson = false; }
      files.push({ name: `${n}-${step}-Response.${isJson ? "json" : "txt"}`, data: enc.encode(x.responseBody), date: at });
    } else files.push({ name: `${n}-${step}-Error.json`, data: enc.encode(JSON.stringify({ httpStatus: x.status, error: x.error }, null, 2)), date: at });
    map.push({ n, step, httpStatus: x.status, durationMs: x.durationMs, ...(x.error ? { error: x.error } : {}), ...mapping(step, x.responseBody) });
  });
  files.unshift({ name: "mapping.json", data: enc.encode(JSON.stringify({ stoppedAt, calls: map }, null, 2)), date: new Date() });
  for (const f of files) writeFileSync(join(outDir, f.name), f.data);
  writeFileSync(`${outDir}.zip`, buildZip(files));
  console.log(`\n${files.length} files in ${outDir}/ and ${outDir}.zip`);
}

if (process.argv[1]?.endsWith("akbar-uat-check.ts")) void main();
