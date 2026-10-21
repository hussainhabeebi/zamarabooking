import type { Metadata } from "next";
import { ContactLines, LegalPage } from "../components/LegalPage";
import { BUSINESS } from "../lib/business";

export const metadata: Metadata = {
  title: "Privacy Policy | ZamraBooking",
  description: "How ZamraBooking collects, uses, shares and protects your personal information.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      current="/privacy"
      title="Privacy Policy"
      intro={<p>This policy explains how <b>{BUSINESS.legalName}</b> (&quot;{BUSINESS.brand}&quot;, &quot;we&quot;) collects, uses, shares and protects personal information when you use our website and services. We follow the Information Technology Act, 2000, its rules, and the Digital Personal Data Protection Act, 2023.</p>}
      sections={[
        { id: "collect", title: "Information we collect", body: <>
          <h3>Information you give us</h3>
          <ul>
            <li><b>Contact details:</b> name, email address and mobile number.</li>
            <li><b>Traveller details:</b> names, gender, date of birth, nationality, and passport or ID details where the airline or destination requires them. For some fares, PAN, GST, student or senior-citizen ID details.</li>
            <li><b>Account details:</b> your login, saved travellers, wallet and booking history.</li>
            <li><b>Documents you upload:</b> for example a passport or ticket image you choose to scan to fill in details.</li>
            <li><b>Messages:</b> what you send us by email, WhatsApp, phone or support requests.</li>
          </ul>
          <h3>Information collected automatically</h3>
          <ul>
            <li>Device and browser information, IP address, pages visited and searches made, used to run and secure the website.</li>
            <li>Cookies that keep you signed in, remember your currency and preferences, and keep your booking session.</li>
          </ul>
          <h3>Payment information</h3>
          <p>Card, UPI and bank details are entered on the secure pages of our payment partners and processed by them. We receive only the payment status and reference, never your full card number or CVV.</p>
        </> },
        { id: "use", title: "How we use your information", body: <ul>
          <li>To search, book, ticket and manage your flights, hotels and insurance.</li>
          <li>To send booking confirmations, e-tickets, schedule changes, payment receipts and refund updates by email, SMS or WhatsApp.</li>
          <li>To provide customer support and handle cancellations, changes and refunds.</li>
          <li>To prevent fraud, secure the website and meet legal, tax and regulatory obligations.</li>
          <li>To improve our services and, if you agree, send you offers. You can unsubscribe at any time.</li>
        </ul> },
        { id: "share", title: "Who we share it with", body: <>
          <p>We share only what is needed for each purpose:</p>
          <ul>
            <li><b>Airlines, hotels, insurers and their booking systems</b> (including travel technology partners and consolidators who issue tickets) — to make and manage your booking. They may also share details with immigration and security authorities as required by law.</li>
            <li><b>Payment partners</b> — to process payments and refunds.</li>
            <li><b>Service providers who work for us</b> — hosting, email and WhatsApp messaging, and customer-support tools — under confidentiality obligations.</li>
            <li><b>Travel agencies</b> — if you booked through a {BUSINESS.brand} partner agency, that agency can see the booking.</li>
            <li><b>Authorities</b> — when required by law, court order or to protect the rights and safety of our customers and business.</li>
          </ul>
          <p>We do not sell your personal information.</p>
        </> },
        { id: "international", title: "International transfers", body: <p>Travel involves other countries. Your details are shared with airlines, hotels and authorities in the countries you travel to, and some of our technology providers may process data outside India. We take reasonable steps to ensure it is protected.</p> },
        { id: "retention", title: "How long we keep it", body: <p>We keep booking and payment records for as long as needed to provide the service and to meet legal, tax and accounting requirements (generally up to 8 years). Uploaded document images are used only to fill in your details and are not kept longer than needed. You can ask us to delete your account at any time.</p> },
        { id: "security", title: "How we protect it", body: <p>The website uses encrypted (HTTPS) connections. Access to personal data is limited to staff and partners who need it, and accounts are protected by passwords. No system is completely secure, so please keep your login private and tell us at once if you suspect misuse.</p> },
        { id: "rights", title: "Your rights and choices", body: <ul>
          <li>See, correct or update your details in <a href="/account">My account</a>, or by asking us.</li>
          <li>Ask for a copy of your data, or ask us to delete your account and data (records we must keep by law are retained).</li>
          <li>Withdraw consent to marketing at any time using the unsubscribe link or by contacting us.</li>
          <li>Block or delete cookies in your browser; some features, such as staying signed in, will then not work.</li>
        </ul> },
        { id: "children", title: "Children", body: <p>Bookings must be made by adults. We collect a child&apos;s details only when an adult books travel for them.</p> },
        { id: "changes", title: "Changes to this policy", body: <p>We may update this policy. The date at the top shows the latest version; significant changes will be highlighted on the website.</p> },
        { id: "grievance", title: "Contact and grievance officer", body: <>
          <p>For privacy questions, requests or complaints, contact our Grievance Officer at <a href={`mailto:${BUSINESS.email}`}>{BUSINESS.email}</a> (subject: &quot;Privacy&quot;). We acknowledge complaints within 48 hours and resolve them within 30 days.</p>
          <ContactLines />
        </> },
      ]}
    />
  );
}
