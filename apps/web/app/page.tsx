import SearchWidget from "./components/SearchWidget";
import HeroBanner from "./components/HeroBanner";
import PopularRoutes from "./components/PopularRoutes";
import type { ReactNode } from "react";

const benefits = [
  { icon: "⚡", symbol: "fare", title: "Live fare comparison", text: "Compare bookable fares from connected airline suppliers." },
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

const DEAL_ROUTES = [
  { from: "COK", to: "DXB", label: "Kochi → Dubai",       price: "₹9,499", note: "From Oct 2026" },
  { from: "CCJ", to: "DXB", label: "Kozhikode → Dubai",   price: "₹8,999", note: "From Oct 2026" },
  { from: "DEL", to: "DXB", label: "Delhi → Dubai",       price: "₹10,299", note: "From Oct 2026" },
  { from: "BOM", to: "DXB", label: "Mumbai → Dubai",      price: "₹11,499", note: "From Oct 2026" },
  { from: "COK", to: "DOH", label: "Kochi → Doha",        price: "₹8,799", note: "From Oct 2026" },
  { from: "BLR", to: "SIN", label: "Bangalore → Singapore", price: "₹13,999", note: "From Oct 2026" },
];

const AIRLINE_LOGOS = [
  { code: "AI", name: "Air India",       icon: "🇮🇳" },
  { code: "EK", name: "Emirates",        icon: "🇦🇪" },
  { code: "QR", name: "Qatar Airways",   icon: "🇶🇦" },
  { code: "EY", name: "Etihad",          icon: "🇦🇪" },
  { code: "6E", name: "IndiGo",          icon: "✈" },
  { code: "SG", name: "SpiceJet",        icon: "🌶" },
  { code: "G8", name: "Go First",        icon: "✈" },
  { code: "UK", name: "Vistara",         icon: "✈" },
];

export default function HomePage() {
  return (
    <main className="home-phase1">
      <HeroBanner banners={[]} />
      <section id="flight-search" className="home-shell search-overlap">
        <div className="section-kicker">Live flight search</div>
        <SearchWidget />
      </section>

      {/* Trust bar */}
      <div className="trust-bar" aria-label="Booking information">
        <div className="trust-item"><span className="trust-item-icon" aria-hidden="true">▣</span> Secure payments</div>
        <div className="trust-item"><span className="trust-item-icon" aria-hidden="true">✓</span> E-ticket delivery</div>
        <div className="trust-item"><span className="trust-item-icon" aria-hidden="true">◉</span> WhatsApp support</div>
        <div className="trust-item"><span className="trust-item-icon" aria-hidden="true">↻</span> Clear cancellation rules</div>
        <div className="trust-item"><span className="trust-item-icon" aria-hidden="true">✈</span> 50+ airlines</div>
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

      {/* Deals section */}
      <section className="home-shell deal-cards-section" style={{ paddingTop: 48 }}>
        <div className="section-heading-row">
          <div>
            <div className="section-kicker">Today&apos;s deals</div>
            <h2 className="home-title">Hot fares, live prices</h2>
          </div>
          <a href="#flight-search" className="text-link">Search all routes →</a>
        </div>
        <div className="deal-cards-grid">
          {DEAL_ROUTES.map((r) => (
            <a
              key={`${r.from}-${r.to}`}
              href={`/search?origin=${r.from}&destination=${r.to}&departureDate=${new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)}&adults=1&cabinClass=ECONOMY&tripType=ONEWAY`}
              className="deal-card"
            >
              <div className="deal-card-route">{r.label}</div>
              <div className="deal-card-price">{r.price}</div>
              <div className="deal-card-note">{r.note}</div>
            </a>
          ))}
        </div>
      </section>

      <section className="home-shell popular-routes-section">
        <div className="section-heading-row">
          <div>
            <div className="section-kicker">Popular now</div>
            <h2 className="home-title">Routes travellers are checking</h2>
          </div>
        </div>
        <PopularRoutes routes={[]} />
        <a href="#flight-search" className="text-link">Custom search →</a>
      </section>

      {/* Airline partners */}
      <section className="home-shell airline-logos-section" style={{ paddingTop: 0 }}>
        <div className="section-kicker">Our airline partners</div>
        <h2 className="home-title">Flights from 50+ airlines</h2>
        <div className="airline-logos-grid">
          {AIRLINE_LOGOS.map((a) => (
            <div key={a.code} className="airline-logo-chip">
              <span className="airline-logo-icon">{a.icon}</span>
              {a.name}
            </div>
          ))}
        </div>
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

      <section className="home-shell">
        <div className="wa-cta">
          <div>
            <div className="section-kicker light">Need help choosing?</div>
            <h2>Continue with our travel assistant</h2>
            <p>Share your route on WhatsApp and move directly from flight selection to secure checkout.</p>
          </div>
          <a href="https://wa.me/" aria-label="Continue on WhatsApp">Continue on WhatsApp <span>→</span></a>
        </div>
      </section>

      {/* Floating WhatsApp */}
      <a href="https://wa.me/" className="wa-float" aria-label="Chat on WhatsApp">
        <span className="wa-float-icon">💬</span>
        <span className="wa-float-label">Need help?</span>
      </a>
    </main>
  );
}
