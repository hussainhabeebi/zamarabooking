// TripSafe (travel insurance) shared helpers for the customer pages.

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
export const TENANT_HEADERS = { "x-tenant-slug": "poomas" };

// TripSafe v2 country catalogue (Myanmar, Iran and North Korea are not covered).
const CODES = "AF AX AL DZ AS AD AO AI AQ AG AR AM AW AC AU AT AZ BS BH BD BB BY BE BZ BJ BM BT BO BA BW BV BR IO VG BN BG BF BI KH CM CA CV KY CF TD CL CN CX CC CO KM CG CK CR HR CU CY CZ CD DK DG DJ DM DO EC EG SV GQ ER EE ET FK FO FJ FI FR GF PF TF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HM VA HN HK HU IS IN ID IQ IE IM IL IT CI JM JP JE JO KZ KE KI XK KW KG LA LV LB LS LR LY LI LT LU MO MK MG MW MY MV ML MT MH MQ MR MU YT MX FM MD MC MN ME MS MA MZ NA NR NP NL AN NC NZ NI NE NG NU NF MP NO OM PK PW PS PA PG PY PE PH PN PL PT PR QA RE RO RU RW BL SH KN LC MF PM VC WS SM ST SA SN RS SC SL SG SX SK SI SB SO ZA GS KR SS ES LK SD SR SJ SZ SE CH SY TW TJ TZ TH TL TG TK TO TT TN TR TM TC TV UG UA AE GB US UY VI UZ VU VE VN WF EH YE ZM ZW".split(" ");

let names: Intl.DisplayNames | null = null;
function countryName(code: string) {
  try {
    names ??= new Intl.DisplayNames(["en"], { type: "region" });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

export const COUNTRIES = CODES.map((code) => ({ code, name: countryName(code) }))
  .sort((a, b) => a.name.localeCompare(b.name));

export const nameOf = (code: string) => COUNTRIES.find((c) => c.code === code)?.name ?? code;

export function money(amount: number | undefined, currency = "INR") {
  if (typeof amount !== "number") return "—";
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount)}`;
  }
}

export function token(): string {
  try {
    const match = document.cookie.match(/(?:^|;\s*)poomas_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  } catch { return ""; }
}

export function authHeaders(): Record<string, string> {
  const t = token();
  return { ...TENANT_HEADERS, ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}
