import type { Metadata } from "next";
import { ContactLines, LegalPage } from "../components/LegalPage";
import { BUSINESS } from "../lib/business";

export const metadata: Metadata = {
  title: "About us | ZamraBooking",
  description: "ZamraBooking is the online booking site of Zamra Tours & Travels — flights, hotels and travel insurance for India and the Gulf.",
};

export default function AboutPage() {
  return (
    <LegalPage
      current="/about"
      title="About ZamraBooking"
      updated={false}
      intro={<p><b>{BUSINESS.brand}</b> is the online booking site of <b>{BUSINESS.legalName}</b>, a travel agency serving travellers and families between India and the Gulf.</p>}
      sections={[
        { id: "what", title: "What we do", body: <>
          <p>We help you book flights, hotels and travel insurance at fair prices, with real people to help before and after you travel.</p>
          <ul>
            <li><b>Flights</b> on domestic and international airlines, compared side by side with baggage and fare rules shown up front.</li>
            <li><b>Hotels</b> in India, the Gulf and beyond.</li>
            <li><b>Travel insurance</b> from licensed insurers.</li>
            <li><b>Group, family and special fares</b> arranged by our team.</li>
            <li><b>Travel agencies</b> can book on our platform through the <a href="https://portal.zamrabooking.com/register">agent portal</a>.</li>
          </ul>
        </> },
        { id: "how", title: "How booking works", body: <ol>
          <li>Search and compare fares; the price shown includes taxes and our service fee.</li>
          <li>Enter traveller details and pay securely online.</li>
          <li>Receive your e-ticket by email, and manage it any time in <a href="/trips">My Trips</a>.</li>
        </ol> },
        { id: "contact", title: "Contact", body: <ContactLines /> },
      ]}
    />
  );
}
