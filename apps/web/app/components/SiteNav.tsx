"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { apiCall, readCustomerToken } from "../lib/customer-api";
import { CURRENCY_EVENT, isPrefCurrency, readPrefCurrency, savePrefCurrency, syncAccountCurrency, type PrefCurrency } from "../lib/currency-pref";
import { CURRENCY_LIST } from "../lib/fx";

function flightSearchUrl() { return "/#flight-search"; }

export default function SiteNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [accountName, setAccountName] = useState("");
  // One currency for the whole visit; a signed-in customer's saved choice follows their login.
  const [currency, setCurrency] = useState<PrefCurrency>("INR");
  useEffect(() => {
    const c = readPrefCurrency(); if (c) setCurrency(c);
    const onChange = (e: Event) => { const code = (e as CustomEvent).detail; if (isPrefCurrency(code)) setCurrency(code); };
    window.addEventListener(CURRENCY_EVENT, onChange);
    return () => window.removeEventListener(CURRENCY_EVENT, onChange);
  }, []);
  useEffect(() => {
    const before = readPrefCurrency();
    void syncAccountCurrency().then(() => {
      const after = readPrefCurrency();
      if (after && after !== before && (pathname === "/search" || pathname.startsWith("/search/"))) router.refresh();
    });
  }, [pathname, accountName]); // eslint-disable-line react-hooks/exhaustive-deps

  function changeCurrency(code: PrefCurrency) {
    setCurrency(code);
    savePrefCurrency(code);
    // Server-rendered results read the saved currency: show them again in the new one.
    if (pathname === "/search") router.refresh();
    else if (pathname.startsWith("/search/")) window.location.reload();
  }

  useEffect(() => {
    let cancelled = false;
    async function loadAccountName() {
      const token = readCustomerToken();
      if (!token) { setAccountName(""); return; }
      try {
        const { account } = await apiCall<{ account: { name: string | null } }>("/api/profile/account");
        if (!cancelled && readCustomerToken() === token) setAccountName(account.name?.trim() ?? "");
      } catch {
        if (!cancelled) setAccountName("");
      }
    }
    void loadAccountName();
    window.addEventListener("zamrabooking:profile-updated", loadAccountName);
    return () => { cancelled = true; window.removeEventListener("zamrabooking:profile-updated", loadAccountName); };
  }, [pathname]);

  // Keep existing fixed payment and journey actions unobstructed.
  const showMobileTabs = !["/book", "/checkout", "/search/journey", "/hotels/book", "/insurance/booking", "/pay"].some((route) => pathname === route || pathname.startsWith(`${route}/`));
  const accountLabel = accountName || "Account";
  const active = pathname === "/search" || pathname.startsWith("/search/") || pathname === "/book" || pathname.startsWith("/book/") || pathname === "/checkout" || pathname.startsWith("/checkout/")
    ? "flights"
    : pathname === "/hotels" || pathname.startsWith("/hotels/")
      ? "hotels"
      : pathname === "/insurance" || pathname.startsWith("/insurance/")
        ? "insurance"
      : pathname === "/trips" || pathname.startsWith("/trips/")
        ? "trips"
        : pathname === "/wallet" || pathname.startsWith("/wallet/")
          ? "wallet"
          : null;

  function navClass(item: string) {
    return active === item ? "nav-link nav-link-active" : "nav-link";
  }

  const accountIcon = (
    <svg className="site-account-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
    </svg>
  );

  const navItems = [
    { key: "flights", label: "Flights", href: flightSearchUrl(), icon: <><path d="m3 21 8-8-6-2-2 2-2-1 3-4 9 1 6-6a2 2 0 0 1 3 3l-6 6 1 9-4 3-1-2 2-2-2-6-8 8Z" /></> },
    { key: "hotels", label: "Hotels", href: "/hotels", icon: <><path d="M4 21V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16M2 21h20M9 21v-5h6v5M8 7h1m6 0h1M8 11h1m6 0h1" /></> },
    { key: "insurance", label: "Insurance", href: "/insurance", icon: <><path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></> },
    { key: "trips", label: "My Trips", href: "/trips", icon: <><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18m-10 0v2h2v-2" /></> },
    { key: "wallet", label: "Wallet", href: "/wallet", icon: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 9h18m-5 6h2" /></> },
  ];

  const portalUrl = (process.env.NEXT_PUBLIC_PORTAL_URL ?? "https://portal.zamrabooking.com").replace(/\/+$/, "");
  const primaryItems = [{ key: "home", label: "Home", href: "/" }, ...navItems.filter(({ key }) => ["flights", "hotels", "trips"].includes(key))];
  function isActive(key: string) { return key === "home" ? pathname === "/" : active === key; }
  const secondaryItems = [
    ...navItems.filter(({ key }) => ["hotels", "insurance", "wallet"].includes(key)),
    { key: "assistance", label: "Travel assistance", href: "/travel-check" },
    { key: "agents", label: "Agent Portal", href: `${portalUrl}/login` },
    { key: "register", label: "Register your agency", href: `${portalUrl}/register` },
    { key: "contact", label: "Contact & support", href: "/contact" },
  ];

  return (
    <nav className="site-nav" aria-label="Main navigation">
      {showMobileTabs && <div className="mobile-tab-bar" role="group" aria-label="Quick navigation">
        <Link prefetch={false} href="/" aria-current={pathname === "/" ? "page" : undefined}><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m3 10 9-7 9 7v11h-6v-7H9v7H3Z" /></svg><span>Home</span></Link>
        <Link prefetch={false} href="/#flight-search" aria-current={active === "flights" ? "page" : undefined}><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></svg><span>Search</span></Link>
        {navItems.filter(({ key }) => key === "trips" || key === "wallet").map(({ key, label, href, icon }) => <Link prefetch={false} key={key} href={href} aria-current={active === key ? "page" : undefined}><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{icon}</svg><span>{label}</span></Link>)}
        <Link prefetch={false} href="/account" aria-current={pathname.startsWith("/account") ? "page" : undefined}>{accountIcon}<span>Account</span></Link>
      </div>}
      <div className="site-nav-links">
        {primaryItems.map(({ key, label, href }) => <a key={key} href={href} className={navClass(key)} aria-current={isActive(key) ? "page" : undefined}>{label}</a>)}
      </div>
      <div className="header-actions">
      <a href="/#flight-search" className="header-icon header-search" aria-label="Find flights"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></svg></a>
      <label className="nav-currency" title="Prices are shown in this currency on every search">
        <span className="sr-only">Currency</span>
        <select value={currency} onChange={(e) => { if (isPrefCurrency(e.target.value)) changeCurrency(e.target.value); }} aria-label="Currency">
          {CURRENCY_LIST.map((c) => <option key={c.code} value={c.code}>{c.code === "INR" ? "₹ INR" : c.code === "USD" ? "$ USD" : c.code}</option>)}
        </select>
      </label>
      <a href="/account" aria-label={accountLabel} className="nav-link home-account-link"><span className="site-account-icon-wrap">{accountIcon}</span><span className="site-account-label" title={accountLabel}>{accountLabel}</span></a>
      <details className="home-mobile-menu header-more" onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
        <summary aria-label="More navigation"><span className="header-more-label">More</span><span className="home-mobile-menu-icon" aria-hidden="true"><i /><i /><i /></span></summary>
        <div className="home-mobile-menu-panel" onClick={(event) => { if ((event.target as HTMLElement).closest("a")) event.currentTarget.closest("details")?.removeAttribute("open"); }}>
          <span className="header-menu-heading">Explore Zamra</span>
          {secondaryItems.map(({ key, label, href }) => <a key={key} href={href} className={`nav-link secondary-${key}`} aria-current={active === key ? "page" : undefined}>{label}</a>)}
          {!showMobileTabs && <a href="/account" className="nav-link mobile-account-fallback">{accountLabel}</a>}
        </div>
      </details>
      </div>
    </nav>
  );
}
