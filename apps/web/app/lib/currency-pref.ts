// One display currency for the whole visit: chosen once, kept for every search,
// result page and booking. Stored in a cookie (so server-rendered search pages
// read it too) and, when signed in, on the account so it follows the login.

import { API, readCustomerToken } from "./customer-api";
import { isDisplayCurrency, type DisplayCurrency } from "./fx";

export type PrefCurrency = DisplayCurrency;
export const CURRENCY_COOKIE = "fp_cur";
export const CURRENCY_EVENT = "poomas:currency";
const LEGACY_KEY = "pref_currency";

export const isPrefCurrency = (v: unknown): v is PrefCurrency => isDisplayCurrency(v);

export function readPrefCurrency(): PrefCurrency | null {
  try {
    const m = document.cookie.match(/(?:^|;\s*)fp_cur=([^;]+)/);
    if (m && isPrefCurrency(m[1])) return m[1];
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (isPrefCurrency(legacy)) return legacy;
  } catch {}
  return null;
}

function storeLocally(code: PrefCurrency) {
  try {
    document.cookie = `${CURRENCY_COOKIE}=${code}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    localStorage.setItem(LEGACY_KEY, code);
  } catch {}
  try { window.dispatchEvent(new CustomEvent(CURRENCY_EVENT, { detail: code })); } catch {}
}

function headers(token: string) {
  return { "Content-Type": "application/json", "x-tenant-slug": "poomas", Authorization: `Bearer ${token}` };
}

// The customer picked a currency: keep it everywhere (and on their account).
export function savePrefCurrency(code: PrefCurrency) {
  if (readPrefCurrency() === code) { storeLocally(code); return; }
  storeLocally(code);
  const token = readCustomerToken();
  if (token) {
    fetch(`${API}/api/session/preferences`, { method: "PUT", headers: headers(token), body: JSON.stringify({ currency: code }) }).catch(() => {});
  }
}

// After sign-in: the account's saved currency wins; otherwise save this browser's choice to it.
// Runs once per login per tab session.
export async function syncAccountCurrency() {
  const token = readCustomerToken();
  if (!token) return;
  const flag = `fp_cur_sync:${token.slice(-16)}`;
  try { if (sessionStorage.getItem(flag)) return; sessionStorage.setItem(flag, "1"); } catch {}
  try {
    const res = await fetch(`${API}/api/session/preferences`, { headers: headers(token) });
    const d = await res.json() as { currency?: string; saved?: boolean };
    if (d.saved && isPrefCurrency(d.currency)) {
      if (readPrefCurrency() !== d.currency) storeLocally(d.currency);
    } else {
      const local = readPrefCurrency();
      if (local) await fetch(`${API}/api/session/preferences`, { method: "PUT", headers: headers(token), body: JSON.stringify({ currency: local }) });
    }
  } catch {}
}
