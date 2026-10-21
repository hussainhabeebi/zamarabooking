import type { Metadata } from "next";
import { LegalPage } from "../components/LegalPage";
import { BUSINESS } from "../lib/business";
import styles from "../components/legal.module.css";

export const metadata: Metadata = {
  title: "Contact us | ZamraBooking",
  description: "Contact ZamraBooking by email, phone or WhatsApp for bookings, changes, cancellations and refunds.",
};

export default function ContactPage() {
  return (
    <LegalPage
      current="/contact"
      title="Contact us"
      updated={false}
      intro={<p>We&apos;re here to help with new bookings, changes, cancellations, refunds and anything else about your trip. Please have your booking ID or PNR ready.</p>}
      sections={[
        { id: "reach", title: "Get in touch", body: (
          <div className={styles.tableWrap}>
            <table>
              <tbody>
                <tr><th>Email</th><td><a href={`mailto:${BUSINESS.email}`}>{BUSINESS.email}</a></td></tr>
                <tr><th>Phone</th><td><a href={BUSINESS.phoneHref}>{BUSINESS.phone}</a></td></tr>
                <tr><th>WhatsApp</th><td><a href={BUSINESS.whatsappHref} target="_blank" rel="noopener">Chat on WhatsApp ({BUSINESS.phone})</a> — send &quot;Hi&quot; to start</td></tr>
                <tr><th>Hours</th><td>{BUSINESS.hours}</td></tr>
                <tr><th>Business</th><td>{BUSINESS.legalName} (trading as {BUSINESS.brand})</td></tr>
                <tr><th>Proprietor</th><td>{BUSINESS.proprietor}</td></tr>
                {BUSINESS.address.length > 0 && <tr><th>Address</th><td>{BUSINESS.address.map((l) => <span key={l} style={{ display: "block" }}>{l}</span>)}</td></tr>}
                <tr><th>Trade licence</th><td>{BUSINESS.tradeLicence} — Malappuram Municipality</td></tr>
                {BUSINESS.gstin && <tr><th>GSTIN</th><td>{BUSINESS.gstin}</td></tr>}
              </tbody>
            </table>
          </div>
        ) },
        { id: "self-service", title: "Manage your booking yourself", body: <ul>
          <li><a href="/trips">My Trips</a> — view, download or resend your e-ticket, cancel and track refunds.</li>
          <li><a href="/trips/find">Find a booking</a> — no account needed; use your PNR or booking reference and email.</li>
        </ul> },
        { id: "response", title: "Response times", body: <p>We reply to emails and WhatsApp messages within 24 hours. Requests about travel in the next 24 hours are handled first. Complaints are acknowledged within 48 hours and resolved within 30 days.</p> },
      ]}
    />
  );
}
