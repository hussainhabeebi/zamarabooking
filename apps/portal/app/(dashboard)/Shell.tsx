"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { loadMe, money, signOut, type Me } from "../../lib/api";

const NAV: { group: string; items: { href: string; label: string; icon: string; roles?: string[] }[] }[] = [
  { group: "Book", items: [
    { href: "/dashboard", label: "Home", icon: "🏠" },
    { href: "/search", label: "Flights", icon: "✈️" },
    { href: "/bookings", label: "Bookings", icon: "📋" },
    { href: "/requests", label: "Services & requests", icon: "🧳" },
    { href: "/import", label: "Offline booking", icon: "📥" },
  ] },
  { group: "Sell", items: [
    { href: "/quotes", label: "Quotes", icon: "📝" },
    { href: "/travellers", label: "Travellers", icon: "🧑‍🤝‍🧑" },
    { href: "/marketing", label: "Marketing kit", icon: "📣" },
  ] },
  { group: "Money", items: [
    { href: "/wallet", label: "Wallet & statement", icon: "💳" },
    { href: "/reports", label: "Reports", icon: "📊" },
  ] },
  { group: "Agency", items: [
    { href: "/sub-agents", label: "Sub-agents", icon: "🏢" },
    { href: "/team", label: "Team logins", icon: "👥" },
    { href: "/settings", label: "Profile, branding & KYC", icon: "⚙️" },
  ] },
];

const BOTTOM = ["/dashboard", "/search", "/bookings", "/wallet"];

const MeContext = createContext<{ me: Me | null; reload: () => void }>({ me: null, reload: () => {} });
export const useMe = () => useContext(MeContext);

export default function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname() ?? "";
  const [me, setMe] = useState<Me | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");

  const reload = () => { loadMe(true).then(setMe).catch((e) => setError(e.message)); };
  useEffect(() => { loadMe().then(setMe).catch((e) => setError(e.message)); }, []);
  useEffect(() => { setMore(false); }, [path]);
  // Agency admins finish onboarding (KYC documents + MOU) before using the portal.
  const mustOnboard = !!me?.onboarding && me.onboarding.enforce && !me.onboarding.complete;
  useEffect(() => {
    if (mustOnboard && me?.user.role === "AGENT_ADMIN" && path !== "/onboarding") window.location.replace("/onboarding");
  }, [mustOnboard, me, path]);

  const on = (href: string) => path === href || path.startsWith(href + "/");
  const items = NAV.flatMap((g) => g.items);
  const brand = me?.settings.displayName || me?.agent.businessName || "Agent portal";

  return (
    <MeContext.Provider value={{ me, reload }}>
      <div className="shell">
        <nav className="side" aria-label="Portal">
          <div className="side-brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={me?.settings.logoUrl || "/logo.png"} alt="" />
            <span>FlyPoomas Agent</span>
          </div>
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="side-group">{g.group}</div>
              {g.items.map((i) => (
                <a key={i.href} href={i.href} className={on(i.href) ? "on" : ""} aria-current={on(i.href) ? "page" : undefined}>
                  <span aria-hidden="true">{i.icon}</span>{i.label}
                </a>
              ))}
            </div>
          ))}
          <div style={{ marginTop: "auto", padding: "12px 0" }}>
            <a href="#" onClick={(e) => { e.preventDefault(); signOut(); }}><span aria-hidden="true">🚪</span>Sign out</a>
          </div>
        </nav>

        <div className="main">
          <header className="topbar">
            <span className="agency">{brand}</span>
            {me && <span className={`badge ${me.tier.name === "Platinum" ? "b-purple" : me.tier.name === "Gold" ? "b-amber" : "b-grey"}`}>{me.tier.name}</span>}
            <span className="spacer" />
            {me && (
              <a className="wallet-pill" href="/wallet" title="Available to book (balance + credit)">
                💳 {money(me.credit.available, me.agent.currency)}
              </a>
            )}
          </header>
          <div className="content">
            {error && <div className="banner bad">{error}</div>}
            {mustOnboard && me?.user.role !== "AGENT_ADMIN" && (
              <div className="banner warn"><b>Agency set-up isn&apos;t finished.</b> Your agency admin needs to upload the KYC documents and sign the MOU.</div>
            )}
            {me?.agent.status === "PENDING" && (
              <div className="banner warn"><b>Your agency is waiting for approval.</b> You can search fares and set up your profile. Upload your KYC documents in <a href="/settings">Profile & KYC</a> to speed it up.</div>
            )}
            {me && ["SUSPENDED", "REJECTED"].includes(me.agent.status) && (
              <div className="banner bad">Your agency is {me.agent.status.toLowerCase()}. Please contact FlyPoomas support.</div>
            )}
            {me?.settings.frozen && <div className="banner bad"><b>Bookings are paused.</b> {me.settings.frozenReason ?? "Please contact support."}</div>}
            {me?.credit.overdue && (
              <div className="banner bad"><b>Credit overdue:</b> {money(me.credit.creditUsed, me.agent.currency)} was due on {new Date(me.credit.dueAt!).toLocaleDateString("en-IN")}. <a href="/wallet">Top up</a> to continue booking.</div>
            )}
            {children}
          </div>
        </div>
      </div>

      <nav className="bottom-nav" aria-label="Portal">
        {items.filter((i) => BOTTOM.includes(i.href)).map((i) => (
          <a key={i.href} href={i.href} className={on(i.href) ? "on" : ""}><span aria-hidden="true">{i.icon}</span>{i.label.split(" ")[0]}</a>
        ))}
        <button onClick={() => setMore(true)} aria-expanded={more}><span aria-hidden="true">☰</span>More</button>
      </nav>
      {more && (
        <div className="more-sheet" onClick={() => setMore(false)} role="dialog" aria-label="More">
          <div onClick={(e) => e.stopPropagation()}>
            {items.filter((i) => !BOTTOM.includes(i.href)).map((i) => (
              <a key={i.href} href={i.href}><span aria-hidden="true">{i.icon}</span>{i.label}</a>
            ))}
            <a href="#" onClick={(e) => { e.preventDefault(); signOut(); }}><span aria-hidden="true">🚪</span>Sign out</a>
          </div>
        </div>
      )}
    </MeContext.Provider>
  );
}
