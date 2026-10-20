// Display currencies and conversion from INR fares, using the rates from the
// automatic exchange-rate tool (/api/search/fx: INR per 1 unit).

export const CURRENCY_LIST = [
  { code: "INR", symbol: "₹",   name: "Indian rupee",   decimals: 2, locale: "en-IN" },
  { code: "AED", symbol: "AED", name: "UAE dirham",     decimals: 2, locale: "en-AE" },
  { code: "SAR", symbol: "SAR", name: "Saudi riyal",    decimals: 2, locale: "en-SA" },
  { code: "QAR", symbol: "QAR", name: "Qatari riyal",   decimals: 2, locale: "en-QA" },
  { code: "OMR", symbol: "OMR", name: "Omani rial",     decimals: 3, locale: "en-OM" },
  { code: "KWD", symbol: "KWD", name: "Kuwaiti dinar",  decimals: 3, locale: "en-KW" },
  { code: "BHD", symbol: "BHD", name: "Bahraini dinar", decimals: 3, locale: "en-BH" },
  { code: "USD", symbol: "$",   name: "US dollar",      decimals: 2, locale: "en-US" },
] as const;

export type DisplayCurrency = (typeof CURRENCY_LIST)[number]["code"];
export type FxRates = Partial<Record<DisplayCurrency, number | null>>;
export const GCC = ["AED", "SAR", "QAR", "OMR", "KWD", "BHD"] as const;

export const isDisplayCurrency = (v: unknown): v is DisplayCurrency => CURRENCY_LIST.some((c) => c.code === v);
export const currencyMeta = (code: string) => CURRENCY_LIST.find((c) => c.code === code);

// INR → chosen currency, rounded UP to the currency's smallest unit (like the payment API).
export function convertInr(inr: number, to: string, rates: FxRates | null | undefined): number | null {
  if (to === "INR") return inr;
  const rate = rates?.[to as DisplayCurrency];
  if (!rate || !(rate > 0)) return null;
  const f = 10 ** (currencyMeta(to)?.decimals ?? 2);
  return Math.ceil((inr / rate) * f - 1e-9) / f;
}

export function formatIn(amount: number, code: string): string {
  const m = currencyMeta(code);
  const d = m?.decimals ?? 2;
  try { return new Intl.NumberFormat(m?.locale ?? "en-US", { style: "currency", currency: code, minimumFractionDigits: d, maximumFractionDigits: d }).format(amount); }
  catch { return `${code} ${amount.toFixed(d)}`; }
}

// Reads the effective rates (browser or server).
export async function fetchFxRates(apiUrl: string, init: RequestInit = {}): Promise<FxRates> {
  try {
    const res = await fetch(`${apiUrl}/api/search/fx`, { headers: { "x-tenant-slug": "poomas" }, cache: "no-store", ...init });
    const d = await res.json() as { rates?: Record<string, unknown> };
    const out: FxRates = {};
    for (const [k, v] of Object.entries(d.rates ?? {})) {
      const n = Number(v);
      if (isDisplayCurrency(k) && Number.isFinite(n) && n > 0) out[k] = n;
    }
    return out;
  } catch { return {}; }
}
