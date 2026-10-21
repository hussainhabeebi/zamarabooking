import "./homepage.css";
import SearchWidget from "./components/SearchWidget";
import HeroBanner from "./components/HeroBanner";
import PopularRoutes from "./components/PopularRoutes";
import type { ReactNode } from "react";

const benefits = [
  { icon: "⚡", symbol: "fare", title: "Flight comparison", text: "Compare fares from connected flight suppliers." },
  { icon: "🧳", symbol: "baggage", title: "Baggage made clear", text: "See duration, stops and baggage before choosing." },
  { icon: "📷", symbol: "passport", title: "Scan your passport", text: "Scan your passport to prefill passenger details for review." },
  { icon: "💬", symbol: "updates", title: "WhatsApp updates", text: "Continue your booking and receive ticket updates in chat." },
];

function BenefitSymbol({ symbol }: { symbol: string }) {
  const paths: Record<string, ReactNode> = {
    fare: <><path d="M3 7h18M3 12h12M3 17h9" /><path d="m16 16 2 2 4-5" /></>,
    baggage: <><rect x="4" y="7" width="16" height="14" rx="2" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M9 11v6m6-6v6" /></>,
    passport: <><rect x="5" y="2" width="14" height="20" rx="2" /><circle cx="12" cy="11" r="3" /><path d="M9 11h6m-3-3v6M9 17h6" /></>,
    updates: <><path d="M20 11.5a8 8 0 0 1-8 8 8.5 8.5 0 0 1-3.5-.8L4 20l1.3-4.5A8 8 0 1 1 20 11.5Z" /><path d="M9 11h6m-6 3h4" /></>,
  };
  return <svg className="benefit-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[symbol]}</svg>;
}

const steps = [
  ["01", "Search", "Tell us your route and travel date."],
  ["02", "Compare", "Choose from the best, cheapest and fastest flights."],
  ["03", "Confirm", "Scan passports or enter passenger details manually."],
  ["04", "Pay & fly", "Pay securely and receive your ticket."],
];

export default function HomePage() {
  return (
    <main className="home-phase1">
      <HeroBanner banners={[]} />
      <section id="flight-search" className="home-shell search-overlap">
        <div className="section-kicker">LET’S FIND YOUR FLIGHT</div>
        <SearchWidget />
      </section>

      {/* Trust bar */}
      <div className="trust-bar" aria-label="Booking information">
        <div className="trust-item"><span className="trust-item-icon" aria-hidden="true">▣</span> Secure payments</div>
        <div className="trust-item"><span className="trust-item-icon" aria-hidden="true">✓</span> E-ticket delivery</div>
        <div className="trust-item"><span className="trust-item-icon" aria-hidden="true">◉</span> WhatsApp support</div>
        <div className="trust-item"><span className="trust-item-icon" aria-hidden="true">↻</span> Clear cancellation rules</div>

      </div>

      {/* Manage booking strip */}
      <div className="manage-strip">
        <div>
          <h3>Already booked?</h3>
          <p>Find your booking, view trip details and access your travel documents.</p>
        </div>
        <div className="manage-strip-actions">
          <a href="/trips/find" className="manage-btn manage-btn-primary">📋 Manage Booking</a>
        </div>
      </div>

      <section className="home-shell deal-cards-section">
        <div className="section-kicker">MORE WAYS TO GET AWAY</div>
        <h2 className="home-title">Where will your next chapter begin?</h2>
        <div className="zamra-offers">
          <a href="#flight-search" className="zamra-offer"><span className="offer-number">01 / HOMECOMINGS</span><h3>Back to the people<br />who feel like home.</h3><p>Explore flights between India and the Gulf.</p><span className="offer-link">Plan your journey <span aria-hidden="true">↗</span></span></a>
          <a href="/hotels" className="zamra-offer zamra-offer-light"><span className="offer-number">02 / NEW HORIZONS</span><h3>A change of scene.<br />A stay to remember.</h3><p>Find a place to settle in, wherever you land.</p><span className="offer-link">Explore hotels <span aria-hidden="true">↗</span></span></a>
        </div>
      </section>

      <section className="home-shell popular-routes-section">
        <div className="section-heading-row">
          <div>
            <div className="section-kicker">DESTINATION INSPIRATION</div>
            <h2 className="home-title">Familiar routes. Fresh possibilities.</h2>
          </div>
        </div>
        <PopularRoutes routes={[]} />
        <a href="#flight-search" className="text-link">Custom search →</a>
      </section>

      <section className="home-shell benefits-section">
        <div className="section-kicker">Built for easier booking</div>
        <h2 className="home-title">Less form-filling. More confidence.</h2>
        <div className="benefit-grid">
          {benefits.map((item) => (
            <article className="benefit-card" key={item.title}>
              <span className="benefit-icon">{item.icon}</span>
              <span className="benefit-icon-desktop"><BenefitSymbol symbol={item.symbol} /></span>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="journey-section">
        <div className="home-shell">
          <div className="section-kicker light">Simple from search to ticket</div>
          <h2 className="home-title light">Your booking, step by step</h2>
          <div className="journey-grid">
            {steps.map(([number, title, text]) => (
              <article className="journey-card" key={number}>
                <span>{number}</span><h3>{title}</h3><p>{text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="home-shell"><div className="wa-cta"><div><div className="section-kicker light">ALREADY PLANNING YOUR NEXT JOURNEY?</div><h2>Your next take-off starts here.</h2><p>Choose your route and dates. We’ll help you compare the options.</p></div><a href="#flight-search">Search flights <span aria-hidden="true">↗</span></a></div></section>
    </main>
  );
}
