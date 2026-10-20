const PORTAL_URL = (process.env.NEXT_PUBLIC_PORTAL_URL ?? "https://portal.flypoomas.com").replace(/\/+$/, "");

const columns = [
  {
    title: "Book",
    links: [
      { label: "Flights", href: "/" },
      { label: "Hotels", href: "/hotels" },
      { label: "Travel insurance", href: "/insurance" },
      { label: "Baggage & visa check", href: "/travel-check" },
    ],
  },
  {
    title: "Manage",
    links: [
      { label: "My Trips", href: "/trips" },
      { label: "Find a booking", href: "/trips/find" },
      { label: "Wallet", href: "/wallet" },
      { label: "My account", href: "/account" },
    ],
  },
  {
    title: "For agents",
    links: [
      { label: "Register your agency", href: `${PORTAL_URL}/register` },
      { label: "Agent login", href: `${PORTAL_URL}/login` },
    ],
  },
];

const perks = ["Agent-only fares", "Commission on every booking", "Sub-agents & staff logins", "Wallet & credit limits"];

export default function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <section className="footer-agent-cta" aria-labelledby="footer-agent-title">
          <div className="footer-agent-copy">
            <span className="footer-agent-kicker">FlyPoomas for Agents</span>
            <h2 id="footer-agent-title">Run your travel agency on FlyPoomas</h2>
            <ul className="footer-agent-perks">
              {perks.map((perk) => (
                <li key={perk}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10" /></svg>
                  {perk}
                </li>
              ))}
            </ul>
          </div>
          <div className="footer-agent-actions">
            <a href={`${PORTAL_URL}/register`} className="footer-btn footer-btn-primary">
              Register as an agent
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
            </a>
            <a href={`${PORTAL_URL}/login`} className="footer-btn footer-btn-ghost">Agent login</a>
          </div>
        </section>

        <div className="footer-main">
          <div className="footer-brand">
            <a href="/" className="footer-logo-link">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="" height={32} />
              <span>FlyPoomas</span>
            </a>
            <p>Book flights, hotels and travel insurance at the best prices — India, the Gulf and beyond.</p>
            <div className="footer-trust">
              <span>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
                Secure payments
              </span>
              <span>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></svg>
                Instant e-tickets
              </span>
            </div>
          </div>

          <nav className="footer-columns" aria-label="Footer">
            {columns.map((column) => (
              <div key={column.title} className="footer-column">
                <h3>{column.title}</h3>
                <ul>
                  {column.links.map((link) => (
                    <li key={link.label}><a href={link.href}>{link.label}</a></li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <div className="footer-bottom">
          <span>© {year} FlyPoomas. All rights reserved.</span>
          <span className="footer-bottom-note">Fares are subject to availability until ticketed.</span>
          <span className="footer-credits">
            <span>Built by team <a href="https://aiingo.com" target="_blank" rel="noopener">aiingo.com</a></span>
            <span aria-hidden="true">·</span>
            <span>Powered by <a href="https://leadvyne.com" target="_blank" rel="noopener">leadvyne.com</a></span>
          </span>
        </div>
      </div>
    </footer>
  );
}
