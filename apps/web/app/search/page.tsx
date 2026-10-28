import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import SearchResultControls, { ChangeDatesAction } from "./SearchResultControls";
import { FareTools } from "./FareTools";
import FareOptionsList from "./FareOptionsList";
import { altOptions, fareLabel, flightKey, groupFareOptions, optionPerks, optionPrice } from "../lib/fare-options";
import { convertInr, currencyMeta, fetchFxRates, formatIn, isDisplayCurrency, type FxRates } from "../lib/fx";

type SearchParams = {
  origin?: string; destination?: string; departureDate?: string;
  returnDate?: string; adults?: string; children?: string; infants?: string;
  cabinClass?: string; tripType?: string; currency?: string; all?: string;
  sort?: "price" | "duration" | "departure" | "best"; stops?: string;
  refundable?: string; baggage?: string; airlines?: string; depBand?: string;
  fareType?: string; legs?: string;
};

type SearchResult = {
  fares: unknown[];
  isIndicative: boolean;
  disclaimer?: string;
  usedSuppliers?: string[];
  availableSuppliers?: string[];
  credentialAvailability?: Record<string, boolean>;
  supplierErrors?: Record<string, string>;
  apiError?: string;
  validationError?: string;
  searchId?: string;
};

const CURRENCY_LOCALES: Record<string, string> = {
  INR: "en-IN", AED: "en-AE", USD: "en-US", GBP: "en-GB", EUR: "en-IE",
};

// Display labels for the nearby-airport options already offered by the filters.
const AIRPORT_CITIES: Record<string, string> = {
  COK: "Kochi", CCJ: "Kozhikode", CNN: "Kannur", TRV: "Thiruvananthapuram",
  DXB: "Dubai", DWC: "Dubai Al Maktoum", SHJ: "Sharjah", AUH: "Abu Dhabi",
  RKT: "Ras Al Khaimah", FJR: "Fujairah", AAN: "Al Ain",
};

function displaySearchDate(value?: string) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return value ?? "";
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

interface SearchPageProps { searchParams: Promise<SearchParams>; }

// Rates from the automatic exchange-rate tool (INR per 1 unit). No caching: a new rate applies to the very next search.
async function fetchRates(): Promise<FxRates> {
  return fetchFxRates(process.env.NEXT_PUBLIC_API_URL ?? "https://api.zamrabooking.com");
}

// Price in the currency the customer chose (rounded up like the payment API).
function inChosenCurrency(price: number, fareCurrency: string, chosen: string | null, rates: FxRates) {
  if (chosen && chosen !== fareCurrency && fareCurrency === "INR") {
    const amount = convertInr(price, chosen, rates);
    if (amount !== null) return { amount, currency: chosen, converted: true };
  }
  return { amount: price, currency: fareCurrency, converted: false };
}

async function searchFlights(params: SearchParams, sessionId: string | null): Promise<SearchResult> {
  try {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "https://api.zamrabooking.com";
    const res = await fetch(`${apiUrl}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-tenant-slug": "zamra",
        ...(sessionId ? { "X-Session-ID": sessionId } : {}),
      },
      body: JSON.stringify({
        origin: params.origin,
        destination: params.destination,
        departureDate: params.departureDate,
        returnDate: params.returnDate,
        adults: parseInt(params.adults ?? "1"),
        children: parseInt(params.children ?? "0"),
        infants: parseInt(params.infants ?? "0"),
        cabinClass: params.cabinClass ?? "ECONOMY",
        tripType: "ONEWAY",
        ...(params.fareType ? { fareType: params.fareType } : {}),
        ...(params.currency ? { currency: params.currency } : {}),
      }),
      cache: "no-store",
      // Must outlast the API's 28s TripJack search budget.
      signal: AbortSignal.timeout(40_000),
    });

    const raw = await res.text();
    let data: SearchResult | { error?: string } | null = null;
    try { data = raw ? JSON.parse(raw) : null; } catch {}
    if (!res.ok) {
      // 400 = the search itself is invalid (e.g. more infants than adults): show why.
      const err = data && "error" in data ? (data as { error?: unknown }).error : undefined;
      const issue = (err as { issues?: { message?: string }[] } | undefined)?.issues?.[0]?.message;
      return {
        fares: [], isIndicative: false,
        searchId: data && "searchId" in data ? (data as SearchResult).searchId : undefined,
        apiError: (typeof err === "string" ? err : issue) ?? `${res.status} ${res.statusText}${raw ? ` — ${raw.slice(0, 180)}` : ""}`,
        ...(res.status === 400 && issue ? { validationError: issue } : {}),
      };
    }
    return (data as SearchResult) ?? { fares: [], isIndicative: false, apiError: "Search API returned an empty response" };
  } catch (err) {
    return { fares: [], isIndicative: false, apiError: err instanceof Error ? err.message : "Search API unavailable" };
  }
}

export default async function SearchResultsPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  // Round trips / multi-city choose a fare per leg on the journey page.
  if (params.tripType === "ROUNDTRIP" || params.tripType === "MULTICITY") {
    redirect(`/search/journey?${new URLSearchParams(Object.entries(params).filter(([, v]) => typeof v === "string") as [string, string][])}`);
  }
  let sessionId: string | null = null;
  let prefCurrency: string | null = null;
  try {
    const s = await cookies();
    sessionId = s.get("sid")?.value ?? null;
    const cur = s.get("fp_cur")?.value;
    if (isDisplayCurrency(cur)) prefCurrency = cur;
  } catch {}
  // The visitor's chosen currency stays fixed across searches, whatever the link says.
  if (prefCurrency) params.currency = prefCurrency as SearchParams["currency"];

  const [result, aedRate] = await Promise.all([searchFlights(params, sessionId), fetchRates()]);
  const requestedCurrency = params.currency ?? null;
  const failingSuppliers = Object.keys(result.supplierErrors ?? {});
  const missingCredentialSuppliers = Object.entries(result.credentialAvailability ?? {})
    .filter(([, ok]) => !ok).map(([name]) => name);
  const allFares = result.fares as any[];
  const filteredFares = filterAndSortFares(allFares, params);
  // One card per flight; the airline's fare options (Saver / Standard / Flexi…) inside it.
  const groups = groupFareOptions(filteredFares as any[]);
  const optionsByKey = new Map(groups.map((g) => [g.key, g.options]));
  const leadFares = groups.map((g) => g.lead);
  const displayFares = params.all === "1" || params.sort
    ? leadFares
    : recommendedFares(leadFares);
  const allQuery = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null) as [string, string][]);
  allQuery.set("all", "1");

  const sortParam = params.sort ?? "best";

  const sortTabs: { key: string; label: string }[] = [
    { key: "best",      label: "Best" },
    { key: "price",     label: "Cheapest" },
    { key: "duration",  label: "Fastest" },
    { key: "departure", label: "Earliest" },
  ];

  const adults  = Math.min(9, Math.max(1, parseInt(params.adults  ?? "1") || 1));
  const children = parseInt(params.children ?? "0") || 0;
  const infants  = parseInt(params.infants  ?? "0") || 0;
  const tripContext = [displaySearchDate(params.departureDate), `${adults} adult${adults > 1 ? "s" : ""}`, (params.cabinClass ?? "ECONOMY").replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()), requestedCurrency].filter(Boolean);

  return (
    <main className="page-container flight-results-page">
      {/* Route-neutral travel banner; all journey details come from search state. */}
      <div className="search-page-header">
        <div className="search-page-summary">
          <h1>
            {params.origin} → {params.destination}
          </h1>
          <p className="results-meta">
            {tripContext.join(" · ")}
          </p>
          <a href="/" className="search-page-modify-link"><span aria-hidden="true">✎</span> Modify search</a>
        </div>
      </div>

      <div className="search-results-layout">
        {/* Filter sidebar */}
        <SearchResultControls
          origin={params.origin ?? ""}
          destination={params.destination ?? ""}
          departureDate={params.departureDate ?? new Date().toISOString().slice(0, 10)}
          fares={allFares}
        />

        {/* Results column */}
        <div className="search-results-column">
          {requestedCurrency && requestedCurrency !== "INR" && !aedRate[requestedCurrency as keyof FxRates] && filteredFares.some((f) => String(f.currency ?? "INR") === "INR") && (
            <div style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", color: "#1E3A8A", borderRadius: 10, padding: "10px 14px", marginBottom: 14, fontSize: 13 }}>
              {requestedCurrency} prices aren't available right now, so fares are shown in Indian rupees (INR).
            </div>
          )}

          {result?.isIndicative && (
            <div style={{ background: "#FEF3C7", border: "1px solid #F59E0B", borderRadius: 10, padding: "12px 14px", marginBottom: 14, fontSize: 13 }}>
              ⚠️ {result.disclaimer}
            </div>
          )}

          {/* Price calendar, price alert, baggage checker */}
          {params.origin && params.destination && params.departureDate && (
            <FareTools
              origin={params.origin.toUpperCase()}
              destination={params.destination.toUpperCase()}
              departureDate={params.departureDate}
              currency={String(allFares[0]?.currency ?? "INR")}
              displayCurrency={requestedCurrency}
              rates={aedRate}
              cheapest={cheapestPerAdult(allFares, adults)}
              airline={filteredFares[0]?.airline}
              query={new URLSearchParams(Object.entries(params).filter(([, v]) => typeof v === "string") as [string, string][]).toString()}
            />
          )}

          {/* Sort tabs */}
          <div className="sort-tabs" role="tablist" aria-label="Sort results">
              {sortTabs.map(({ key, label }) => {
                const href = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null) as [string, string][]);
                href.set("sort", key);
                href.set("all", "1");
                return (
                  <a
                    key={key}
                    role="tab"
                    aria-selected={sortParam === key}
                    className={`sort-tab${sortParam === key ? " active" : ""}`}
                    href={`/search?${href.toString()}`}
                  >
                    {label}
                  </a>
                );
              })}
              <span className="results-count-badge">{groups.length} flight{groups.length === 1 ? "" : "s"}</span>
          </div>

          {filteredFares.length === 0 ? (
            <div className="no-results">
              <img className="no-results-illustration" src="/search/empty-flight.svg" alt="" aria-hidden="true" width="420" height="150" />
              <h2>No flights available right now</h2>
              <p>{result.validationError ? `${result.validationError}. Please change the passengers and search again.` : result.apiError || failingSuppliers.length > 0 ? "We're having trouble searching flights for this route. Please try again or choose different dates." : "Try different dates or a nearby airport."}</p>
              <div className="no-results-trip-card" aria-label="Searched journey">
                <div className="no-results-route">
                  <div className="no-results-airport"><strong>{AIRPORT_CITIES[params.origin ?? ""] ?? params.origin ?? "—"} ({params.origin ?? "—"})</strong><span>Origin airport</span></div>
                  <span className="no-results-route-icon" aria-hidden="true">✈ ──→</span>
                  <div className="no-results-airport"><strong>{AIRPORT_CITIES[params.destination ?? ""] ?? params.destination ?? "—"} ({params.destination ?? "—"})</strong><span>Destination airport</span></div>
                </div>
                <div className="no-results-trip-meta">{tripContext.map((item, i) => <span key={i}>{item}</span>)}</div>
              </div>
              <div className="no-results-actions">
                <a href="/" className="fare-card-book-btn no-results-action">Search again</a>
                <ChangeDatesAction />
                <a href="/#flight-search" className="no-results-secondary">Modify search</a>
              </div>
              {(result.apiError || failingSuppliers.length > 0) && result.searchId && (
                <p className="no-results-reference">Reference: {result.searchId.slice(0, 8)}</p>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {params.all !== "1" && (
                <div style={{ fontSize: 12, color: "#94a3b8", fontWeight: 700, marginBottom: 2 }}>Recommended for you</div>
              )}
              {displayFares.map((fare, i) => (
                <FareCard
                  key={`${fare.id ?? i}-${i}`}
                  fare={fare}
                  options={optionsByKey.get(flightKey(fare)) ?? [fare]}
                  requestedCurrency={requestedCurrency}
                  aedRate={aedRate}
                  searchId={result.searchId}
                  adults={adults}
                  children={children}
                  infants={infants}
                />
              ))}
              {params.all !== "1" && groups.length > displayFares.length && (
                <a
                  href={`/search?${allQuery.toString()}`}
                  style={{ textAlign: "center", padding: 14, border: "1.5px solid #e2e8f0", borderRadius: 14, color: "#0f172a", textDecoration: "none", fontWeight: 800, background: "#fff", fontSize: 14 }}
                >
                  View all {groups.length} flights →
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function filterAndSortFares(fares: any[], params: SearchParams): any[] {
  const airlineFilter = (params.airlines ?? "").split(",").filter(Boolean);
  const filtered = fares.filter((fare) => {
    if (params.stops === "0" && Number(fare.stops ?? 0) !== 0) return false;
    if (params.stops === "1" && Number(fare.stops ?? 0) !== 1) return false;
    if (params.refundable === "1" && !fare.isRefundable) return false;
    if (params.baggage === "1" && !fare.baggage?.checked) return false;
    if (airlineFilter.length > 0 && !airlineFilter.includes(fare.airlineName)) return false;
    if (params.depBand) {
      const dep = new Date(fare.departureTime);
      const hour = dep.getHours();
      const [start, end] = params.depBand.split("–").map(Number);
      if (hour < start || hour >= end) return false;
    }
    return true;
  });

  if (params.sort === "price") {
    return [...filtered].sort((a, b) => Number(a.displayPrice ?? a.totalFare ?? Infinity) - Number(b.displayPrice ?? b.totalFare ?? Infinity));
  }
  if (params.sort === "duration") {
    return [...filtered].sort((a, b) => Number(a.duration ?? Infinity) - Number(b.duration ?? Infinity));
  }
  if (params.sort === "departure") {
    return [...filtered].sort((a, b) => new Date(a.departureTime).getTime() - new Date(b.departureTime).getTime());
  }
  return filtered;
}

function recommendedFares(fares: any[]): any[] {
  if (fares.length <= 3) return fares;
  const bookable = fares.filter((f) => f.isBookable);
  const pool = bookable.length >= 3 ? bookable : fares;
  const prices = pool.map((f) => Number(f.displayPrice ?? f.totalFare ?? Infinity));
  const durations = pool.map((f) => Number(f.duration ?? Infinity));
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  const minD = Math.min(...durations), maxD = Math.max(...durations);
  const best = [...pool].sort((a, b) => {
    const score = (f: any) => ((Number(f.displayPrice ?? f.totalFare) - minP) / Math.max(1, maxP - minP)) * .62
      + ((Number(f.duration) - minD) / Math.max(1, maxD - minD)) * .28 + Number(f.stops ?? 0) * .1;
    return score(a) - score(b);
  })[0];
  const cheapest = [...pool].sort((a, b) => Number(a.displayPrice ?? a.totalFare) - Number(b.displayPrice ?? b.totalFare))[0];
  const fastest = [...pool].sort((a, b) => Number(a.duration) - Number(b.duration))[0];
  const picked: any[] = [];
  for (const [fare, badge] of [[best, "Best overall"], [cheapest, "Lowest fare"], [fastest, "Fastest"]] as const) {
    if (fare && !picked.some((x) => x.id === fare.id)) picked.push({ ...fare, __badge: badge });
  }
  for (const fare of pool) if (picked.length < 3 && !picked.some((x) => x.id === fare.id)) picked.push(fare);
  return picked.slice(0, 3);
}

function formatMoney(amount: number, currency: string): string {
  const code = (currency || "").toUpperCase();
  if (currencyMeta(code)) return formatIn(amount, code);
  const locale = CURRENCY_LOCALES[code] ?? "en-US";
  try { return new Intl.NumberFormat(locale, { style: "currency", currency: code || "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount); }
  catch { return `${code || ""} ${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`.trim(); }
}

function buildBookUrl(fare: any, fareCurrency: string, price: number, adults: number, children = 0, infants = 0, payCurrency?: string, searchId?: string, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams({
    fareId:   fare.id ?? "",
    adults:   String(adults),
    children: String(children),
    infants:  String(infants),
    supplier: fare.supplier ?? "",
    airline:  fare.airlineName ?? "",
    fn:       fare.flightNumber ?? "",
    from:     fare.origin ?? "",
    to:       fare.destination ?? "",
    dep:      fare.departureTime ?? "",
    arr:      fare.arrivalTime ?? "",
    dur:      String(fare.duration ?? 0),
    stops:    String(fare.stops ?? 0),
    price:    String(price),
    cur:      fareCurrency,
    ref:      fare.isRefundable ? "1" : "0",
    bag:      fare.baggage?.checked ?? "",
  });
  if (payCurrency) p.set("pc", payCurrency);
  if (searchId) p.set("sid", searchId);   // links the booking to this search's TripJack logs
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return `/book?${p.toString()}`;
}

// This option's own perks + the flight's other fare options, so the booking page
// can show what's included and offer a switch / upgrade.
function optionLinkParams(fare: any, options: any[]): Record<string, string> {
  const extra: Record<string, string> = { cab: fare.baggage?.cabin ?? "", fl: fareLabel(fare.fareIdentifier || fare.fareClass) };
  if (typeof fare.mealIncluded === "boolean") extra.meal = fare.mealIncluded ? "1" : "0";
  // A switch on the booking page keeps the supplier, so only offer the same supplier's fares.
  const alts = altOptions(options.filter((o) => o.supplier === fare.supplier), fare.id);
  if (alts.length) extra.alts = JSON.stringify(alts);
  return extra;
}

function FareCard({ fare, options, requestedCurrency, aedRate, searchId, adults, children = 0, infants = 0 }: { fare: any; options: any[]; requestedCurrency: string | null; aedRate: FxRates; searchId?: string; adults: number; children?: number; infants?: number }) {
  const dep = new Date(fare.departureTime);
  const arr = new Date(fare.arrivalTime);
  const fmt = (d: Date) => d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  const fareCurrency = String(fare.currency || requestedCurrency || "INR").toUpperCase();
  const price = Number(fare.displayPrice ?? fare.totalFare ?? 0);
  const shown = inChosenCurrency(price, fareCurrency, requestedCurrency, aedRate);
  const currencyDiffers = Boolean(requestedCurrency && shown.currency !== requestedCurrency);
  const isBookable = Boolean(fare.isBookable && fare.supplier !== "GOOGLE_SERP");
  const durationH = Math.floor(fare.duration / 60);
  const durationM = fare.duration % 60;
  const airlineCode = (fare.flightNumber ?? "").slice(0, 2).toUpperCase();
  const arrNextDay = dep.getUTCDate() !== arr.getUTCDate();

  const cabinLabel = String(fare.cabinClass ?? "ECONOMY").replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const badgeColor = fare.__badge === "Best overall" ? "#0D4B96" : fare.__badge === "Lowest fare" ? "#0f172a" : "#0369a1";

  return (
    <div className="fare-card-v2" style={{ position: "relative" }}>
      {fare.__badge && (
        <div className="fare-card-recommendation" style={{ background: badgeColor }}>
          {fare.__badge}
        </div>
      )}

      <div className="fare-card-v2-main" style={fare.__badge ? { paddingTop: 22 } : {}}>
        {/* Airline */}
        <div className="fare-card-v2-airline">
          <div className="fare-card-v2-airline-logo">{airlineCode}</div>
          <div className="fare-card-v2-airline-name">{fare.airlineName}</div>
          <div className="fare-card-v2-flight-num">{fare.flightNumber}</div>
        </div>

        {/* Times & duration bar */}
        <div className="fare-card-v2-times">
          <div className="fare-card-v2-time-row">
            <div>
              <div className="fare-card-v2-time">{fmt(dep)}</div>
              <div className="fare-card-v2-airport">{fare.origin}</div>
            </div>
            <div className="fare-card-v2-duration-bar">
              <div className="fare-card-v2-duration">{durationH}h {durationM}m</div>
              <div className="fare-card-v2-line" />
              <div className={`fare-card-v2-stops-label${fare.stops === 0 ? " nonstop" : ""}`}>
                {fare.stops === 0 ? "Nonstop" : `${fare.stops} stop${fare.stops > 1 ? "s" : ""}`}
              </div>
            </div>
            <div>
              <div className="fare-card-v2-time">
                {fmt(arr)}
                {arrNextDay && <sup style={{ fontSize: 10, color: "#f59e0b", marginLeft: 2 }}>+1</sup>}
              </div>
              <div className="fare-card-v2-airport">{fare.destination}</div>
            </div>
          </div>
          {fare.layoverAirports?.length > 0 && (
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>Via {fare.layoverAirports.join(" · ")}</div>
          )}
        </div>

        {/* Tags */}
        <div className="fare-card-v2-tags">
          {fare.isRefundable && <span className="fare-card-v2-tag tag-refundable">✓ Refundable</span>}
          {fare.fareIdentifier && fare.fareIdentifier !== "PUBLISHED" && (
            <span className="fare-card-v2-tag">{({ STUDENT: "Student fare", SENIOR_CITIZEN: "Senior citizen fare", TJ_FLEX: "Flex fare", SPECIAL_RETURN: "Special Return" } as Record<string, string>)[fare.fareIdentifier] ?? fareLabel(fare.fareIdentifier)}</span>
          )}
          {fare.baggage?.checked && <span className="fare-card-v2-tag tag-baggage">🧳 {fare.baggage.checked}</span>}
          {fare.seatsLeft > 0 && fare.seatsLeft <= 5 && (
            <span className="fare-card-v2-tag tag-seats">🔥 {fare.seatsLeft} left</span>
          )}
        </div>

        {/* Price + book */}
        <div className="fare-card-v2-price-col">
          <div className="fare-card-v2-price">{options.length > 1 && <small style={{ fontSize: 12, fontWeight: 700, color: "#64748b", marginRight: 4 }}>from</small>}{formatMoney(shown.amount, shown.currency)}</div>
          <div className="fare-card-v2-price-note">
            {shown.converted ? `≈ ${formatMoney(price, fareCurrency)}` : fareCurrency}
            {!fare.isBookable && " · indicative"}
            {adults + children + infants > 1 && ` · total for ${adults + children + infants} travellers`}
          </div>
          {isBookable && options.length > 1 ? null : isBookable ? (
            <a href={buildBookUrl(fare, fareCurrency, price, adults, children, infants, shown.converted ? shown.currency : undefined, searchId, optionLinkParams(fare, options))} className="fare-card-v2-book">
              Book Now
            </a>
          ) : (
            <span style={{ fontSize: 11, color: "#94a3b8" }}>Not bookable online</span>
          )}
        </div>
      </div>

      {isBookable && options.length > 1 && (
        <FareOptionsList
          seatsLeft={fare.seatsLeft}
          options={options.map((o: any) => {
            const perks = optionPerks(o);
            const op = optionPrice(o);
            const oShown = inChosenCurrency(op, fareCurrency, requestedCurrency, aedRate);
            const diff = op - price;
            return {
              id: o.id,
              supplier: o.supplier,
              label: fareLabel(o.fareIdentifier || o.fareClass),
              price: formatMoney(oShown.amount, oShown.currency),
              diff: diff > 0 ? formatMoney(inChosenCurrency(diff, fareCurrency, requestedCurrency, aedRate).amount, oShown.currency) : undefined,
              perks: [perks.refund, cabinLabel, perks.meal, perks.checked && `${perks.checked} check-in`, perks.cabin && `${perks.cabin} cabin`].filter(Boolean).join(" · "),
              bookUrl: buildBookUrl(o, fareCurrency, op, adults, children, infants, oShown.converted ? oShown.currency : undefined, searchId, optionLinkParams(o, options)),
            };
          })}
        />
      )}

      <details className="fare-card-v2-details">
        <summary className="fare-card-v2-expand-row">
          <span className="fare-card-v2-supplier">{fmtDate(dep)}</span>
          <span className="fare-card-v2-expand-btn">Details <span className="fare-card-v2-expand-indicator" aria-hidden="true">⌄</span></span>
        </summary>
        <div className="fare-card-v2-detail">
          <div className="fare-card-v2-detail-item">
            <label>Cabin baggage</label>
            <span>{fare.baggage?.cabin || "Cabin baggage allowance not provided"}</span>
          </div>
          <div className="fare-card-v2-detail-item">
            <label>Check-in baggage</label>
            <span>{fare.baggage?.checked || "Checked baggage allowance not provided"}</span>
          </div>
          <div className="fare-card-v2-detail-item">
            <label>Refundable</label>
            <span>{fare.isRefundable ? "Yes" : "No"}</span>
          </div>
          {fare.fareClass && (
            <div className="fare-card-v2-detail-item">
              <label>Fare class</label>
              <span>{fare.fareClass}</span>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

// One adult's price (with markup) of the cheapest fare, for the price alert default.
function cheapestPerAdult(fares: any[], adults: number): number | null {
  let best: number | null = null;
  for (const f of fares) {
    const total = Number(f?.totalFare);
    if (!(total > 0)) continue;
    const shown = Number(f?.displayPrice) > 0 ? Number(f.displayPrice) : total;
    const share = Number(f?.perAdultFare) > 0 ? Number(f.perAdultFare) / total : 1 / Math.max(1, adults);
    const price = Math.round(shown * Math.min(1, share));
    if (best === null || price < best) best = price;
  }
  return best;
}
