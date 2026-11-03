// Akbar WebSettings: which optional supplier services are offered, per airline and sector.
//
// Response (Akbar documentation, verified by Zamra, Nov 2026):
//   { "TUI": "…", "Code": "200", "Msg": ["Success"],
//     "Settings": [ { "Key": "ShowSSRDom", "Value": "6E,SG,AI" }, { "Key": "ShowSeatLayoutInt", "Value": "AI,EK" }, … ] }
// Many Values are comma-separated airline codes. The feature keys used here:
//   ShowSSRDom / ShowSSRInt, ShowSeatLayoutDom / ShowSeatLayoutInt,
//   ShowBaggageDom / ShowBaggageInt, ShowMealsDom / ShowMealsInt
// Every other key (IsSeatMandatory, MealIncluded, …) is ignored: it is not about availability.
//
// Rules (never switch a feature off on a guess):
//   • exact airline-code match against the fare's carriers (validating / marketing / operating);
//   • Dom keys for flights between Indian airports, Int keys when an airport is known to be outside
//     India; if the sector can't be told, a feature is on when either list allows it;
//   • "ALL" / "*" / true → on for every airline; false → off; an empty or missing Value → unknown.
//   • SSR (the call returns baggage and meals too) is skipped only when ShowSSR, ShowBaggage and
//     ShowMeals all exclude the airline; unknown → called as before.

export type WebSettingsMap = Record<string, string>;
export interface AkbarFeatures { ssr: boolean | null; seatLayout: boolean | null }
export interface FareScope { carriers: string[]; origin: string; destination: string }

const FEATURE_KEYS = ["ShowSSRDom", "ShowSSRInt", "ShowSeatLayoutDom", "ShowSeatLayoutInt", "ShowBaggageDom", "ShowBaggageInt", "ShowMealsDom", "ShowMealsInt"];
const CANONICAL = new Map(FEATURE_KEYS.map((k) => [k.toLowerCase(), k]));

// The feature settings of a WebSettings response, as Akbar sent them (Key → Value). null when the
// response has no Settings list at all.
export function akbarWebSettings(data: unknown): WebSettingsMap | null {
  const list = data && typeof data === "object" ? (data as Record<string, unknown>).Settings : undefined;
  if (!Array.isArray(list)) return null;
  const out: WebSettingsMap = {};
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const key = CANONICAL.get(String((item as Record<string, unknown>).Key ?? "").trim().toLowerCase());
    const value = (item as Record<string, unknown>).Value;
    if (key && value != null && typeof value !== "object") out[key] = String(value);
  }
  return out;
}

// Indian airports (domestic sector). An airport missing here only makes the sector "unknown",
// which never disables a feature.
const INDIA = new Set(("AGR AGX AIP AJL AKD AMD ATQ AYJ BBI BDQ BEK BEP BHJ BHO BHU BKB BLR BOM BUP CBD CCJ CCU CDP CJB CNN COH COK " +
  "DAE DBR DED DEL DEP DGH DHM DIB DIU DMU GAU GAY GBI GDB GOI GOP GOX GUX GWL HBX HDO HGI HJR HSR HSS HYD IDR IMF ISK " +
  "IXA IXB IXC IXD IXE IXG IXH IXI IXJ IXK IXL IXM IXN IXP IXQ IXR IXS IXT IXU IXV IXW IXY IXZ JAI JDH JGA JGB JLR JRG JRH JSA " +
  "KBK KJB KLH KNU KQH KUU LDA LKO LUH MAA MOH MYQ MZA MZU NAG NDC NMB NMI NVY PAB PAT PBD PGH PNQ PNY PYB PYG RAJ RDP REW RGH " +
  "RJA RMD RPR RQY RRK RUP SAG SDW SHL SLV SSE STV SXR SXV TCR TEI TEZ TIR TJV TNI TRV TRZ UDR VDY VGA VNS VTZ WGC ZER").split(" "));
// Airports known to be outside India (Zamra's international routes).
const ABROAD = new Set(("DXB DWC AUH SHJ RKT FJR AAN DOH MCT SLL BAH KWI RUH JED DMM MED TIF AHB ELQ GIZ TUU YNB " +
  "KUL PEN BKK DMK HKT SIN CMB MLE KTM PBH DAC CGP DPS CGK SGN HAN HKG CAN PVG PEK ICN NRT HND MNL " +
  "LHR LGW MAN BHX EDI JFK EWR SFO ORD IAD LAX ATL DFW IAH YYZ YVR SYD MEL PER BNE AKL " +
  "CDG FRA MUC AMS FCO MXP MAD BCN ZRH VIE BRU CPH ARN OSL HEL IST CAI ADD NBO JNB MRU SEZ").split(" "));

export function akbarSector(origin: string, destination: string): "Dom" | "Int" | null {
  const o = origin.toUpperCase(), d = destination.toUpperCase();
  if (INDIA.has(o) && INDIA.has(d)) return "Dom";
  if (ABROAD.has(o) || ABROAD.has(d)) return "Int";
  return null;
}

// One setting for this fare: true / false / null (unknown).
function allows(value: string | undefined, carriers: string[]): boolean | null {
  if (value == null) return null;
  const v = value.trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  if (["all", "*", "true", "y", "yes"].includes(lower)) return true;
  if (["false", "n", "no", "none"].includes(lower)) return false;
  const codes = v.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (!codes.length) return null;
  return carriers.some((c) => codes.includes(c));
}

const combine = (xs: (boolean | null)[]) => (xs.includes(true) ? true : xs.includes(false) ? false : null);

export function akbarFeaturesFor(settings: WebSettingsMap | null | undefined, scope: FareScope): AkbarFeatures {
  if (!settings) return { ssr: null, seatLayout: null };
  const carriers = [...new Set(scope.carriers.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  const sector = akbarSector(scope.origin, scope.destination);
  const sectors = sector ? [sector] : (["Dom", "Int"] as const);
  const feature = (name: string) => combine(sectors.map((s) => allows(settings[`Show${name}${s}`], carriers)));
  return { seatLayout: feature("SeatLayout"), ssr: combine([feature("SSR"), feature("Baggage"), feature("Meals")]) };
}
