import type { Metadata } from "next";
import { ContactLines, LegalPage } from "../components/LegalPage";
import { BUSINESS } from "../lib/business";

export const metadata: Metadata = {
  title: "Shipping & Delivery Policy | ZamraBooking",
  description: "How and when ZamraBooking delivers your e-tickets, vouchers and insurance policies.",
};

export default function ShippingPolicyPage() {
  return (
    <LegalPage
      current="/shipping-policy"
      title="Shipping & Delivery Policy"
      intro={<p>{BUSINESS.brand} sells travel services only. <b>We do not ship any physical goods.</b> Everything you buy is delivered electronically to the email address (and, where provided, WhatsApp number) given at booking.</p>}
      sections={[
        { id: "what", title: "What we deliver", body: <ul>
          <li><b>Flights:</b> an e-ticket with the airline PNR and ticket numbers.</li>
          <li><b>Hotels:</b> a hotel confirmation voucher.</li>
          <li><b>Travel insurance:</b> the insurer&apos;s policy document / certificate of insurance.</li>
          <li><b>Payments:</b> a payment receipt for every successful payment.</li>
        </ul> },
        { id: "when", title: "When it is delivered", body: <ul>
          <li>Most bookings are confirmed instantly and documents are emailed within a few minutes of payment.</li>
          <li>Some fares (for example group or special fares) are ticketed by our team after payment. These are delivered within <b>2–4 hours</b> during business hours, and in any case at least 12 hours before departure.</li>
          <li>If a booking cannot be confirmed, we tell you and refund the full amount as described in our <a href="/refund-policy">Cancellation &amp; Refund Policy</a>.</li>
        </ul> },
        { id: "where", title: "Where to find your documents", body: <p>Your documents are always available in <a href="/trips">My Trips</a>, or via <a href="/trips/find">Find a booking</a> with your PNR or booking reference and email. You can view, print or download your e-ticket and itinerary there, and ask for them to be sent again.</p> },
        { id: "not-received", title: "Didn't receive it?", body: <>
          <p>Check your spam or promotions folder first. If you still can&apos;t find your documents, contact us with your booking ID and we will resend them.</p>
          <ContactLines />
        </> },
      ]}
    />
  );
}
