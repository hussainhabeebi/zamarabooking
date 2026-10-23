import { BUSINESS } from "../lib/business";
import { LEGAL_LINKS } from "./LegalPage";

const PORTAL_URL = (process.env.NEXT_PUBLIC_PORTAL_URL ?? "https://portal.zamrabooking.com").replace(/\/+$/, "");
const quickLinks = [
  ["Home", "/"], ["Flights", "/#flight-search"], ["Manage booking", "/trips/find"],
  ["My Trips", "/trips"], ["Agent Portal", `${PORTAL_URL}/login`], ["Contact", "/contact"],
];
const services = [
  ["Flight booking", "/#flight-search"], ["Hotels", "/hotels"],
  ["Travel assistance", "/travel-check"],
  ["My account", "/account"], ["Register your agency", `${PORTAL_URL}/register`],
];

export default function SiteFooter() {
  return (
    <footer className="site-footer zamra-footer">
      <div className="site-footer-inner">
        <div className="footer-horizon" aria-hidden="true"><span /><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="m22 2-7 20-4-9-9-4 20-7Z" /><path d="m22 2-11 11" /></svg><span /></div>
        <div className="footer-five-columns">
          <section className="footer-brand" aria-label="Zamra Travels">
            <a href="/" className="footer-logo-link"><img src="/logo.png" alt="Zamra Travels" width="44" height="44" /><span>ZamraBooking<small>India, the Gulf & beyond.</small></span></a>
            <p>Closer to home. Open to the world. Plan your next journey with Zamra Travels.</p>
            <a href={BUSINESS.whatsappHref} className="footer-social" aria-label="Contact Zamra Travels on WhatsApp"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M20 11.5a8.5 8.5 0 0 1-12.7 7.4L3 20l1.1-4.3A8.5 8.5 0 1 1 20 11.5Z" /><path d="M8 7c0 5 3 8 8 8l1-2-3-1-1 1-3-3 1-1-1-2H8Z" /></svg></a>
          </section>
          <nav className="footer-column" aria-label="Quick links"><h2>Quick links</h2><ul>{quickLinks.map(([label, href]) => <li key={label}><a href={href}>{label}</a></li>)}</ul></nav>
          <nav className="footer-column" aria-label="Travel services"><h2>Travel services</h2><ul>{services.map(([label, href]) => <li key={label}><a href={href}>{label}</a></li>)}</ul></nav>
          <section className="footer-column" aria-labelledby="footer-contact-title"><h2 id="footer-contact-title">Contact us</h2><address className="footer-contact"><a href={BUSINESS.phoneHref}>{BUSINESS.phone}</a><a href={`mailto:${BUSINESS.email}`}>{BUSINESS.email}</a><span>{BUSINESS.legalName}</span>{BUSINESS.address.length > 0 && <span>{BUSINESS.address.join(", ")}</span>}</address></section>
          <section className="footer-column footer-connect" aria-labelledby="footer-connect-title"><h2 id="footer-connect-title">Stay connected</h2><p>A question about your next trip? Our team is a message away.</p><a className="footer-contact-cta" href={BUSINESS.whatsappHref}>Chat with Zamra <span aria-hidden="true">↗</span></a><a className="footer-email-link" href={`mailto:${BUSINESS.email}`}>Or send us an email <span aria-hidden="true">↗</span></a></section>
        </div>
        <nav className="footer-legal" aria-label="Company and policies">{LEGAL_LINKS.map((link) => <a key={link.href} href={link.href}>{link.label}</a>)}</nav>
        <div className="footer-bottom"><span>© {new Date().getFullYear()} {BUSINESS.legalName}. All rights reserved.</span><span className="footer-bottom-note">Fares are subject to availability until ticketed.</span><span className="footer-credits"><span>Built by team <a href="https://aiingo.com" target="_blank" rel="noopener">aiingo.com</a></span><span aria-hidden="true">·</span><span>Powered by <a href="https://leadvyne.com" target="_blank" rel="noopener">leadvyne.com</a></span></span></div>
      </div>
    </footer>
  );
}
