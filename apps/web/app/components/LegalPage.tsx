import { BUSINESS } from "../lib/business";
import styles from "./legal.module.css";

// Shared layout for the policy pages: title, last-updated date, a contents list
// that jumps to each section, and links to the other policies.
export const LEGAL_LINKS = [
  { href: "/about", label: "About us" },
  { href: "/contact", label: "Contact us" },
  { href: "/terms", label: "Terms & Conditions" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/refund-policy", label: "Cancellation & Refund Policy" },
  { href: "/shipping-policy", label: "Shipping & Delivery Policy" },
];

export interface LegalSection { id: string; title: string; body: React.ReactNode }

export function LegalPage({ title, intro, sections, current, updated = true }: {
  title: string; intro?: React.ReactNode; sections: LegalSection[]; current: string; updated?: boolean;
}) {
  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.kicker}>{BUSINESS.brand} · {BUSINESS.legalName}</p>
        <h1>{title}</h1>
        {updated && <p className={styles.updated}>Last updated: {BUSINESS.policiesUpdated}</p>}
        {intro && <div className={styles.intro}>{intro}</div>}
      </header>
      <div className={styles.layout}>
        {sections.length > 2 && (
          <nav className={styles.toc} aria-label="On this page">
            <p>On this page</p>
            <ol>{sections.map((s) => <li key={s.id}><a href={`#${s.id}`}>{s.title}</a></li>)}</ol>
          </nav>
        )}
        <article className={styles.article}>
          {sections.map((s, i) => (
            <section key={s.id} id={s.id} className={styles.section}>
              <h2>{sections.length > 2 ? `${i + 1}. ` : ""}{s.title}</h2>
              {s.body}
            </section>
          ))}
          <aside className={styles.related} aria-label="Policies">
            <h2>Related</h2>
            <ul>{LEGAL_LINKS.filter((l) => l.href !== current).map((l) => <li key={l.href}><a href={l.href}>{l.label}</a></li>)}</ul>
          </aside>
        </article>
      </div>
    </main>
  );
}

// Contact block used at the end of each policy.
export function ContactLines() {
  return (
    <ul className={styles.contact}>
      <li><b>Business:</b> {BUSINESS.legalName} (trading as {BUSINESS.brand})</li>
      <li><b>Email:</b> <a href={`mailto:${BUSINESS.email}`}>{BUSINESS.email}</a></li>
      <li><b>Phone / WhatsApp:</b> <a href={BUSINESS.phoneHref}>{BUSINESS.phone}</a></li>
      {BUSINESS.address.length > 0 && <li><b>Address:</b> {BUSINESS.address.join(", ")}</li>}
      <li><b>Hours:</b> {BUSINESS.hours}</li>
    </ul>
  );
}
