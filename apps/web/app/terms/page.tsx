import type { Metadata } from "next";
import { ContactLines, LegalPage } from "../components/LegalPage";
import { BUSINESS } from "../lib/business";

export const metadata: Metadata = {
  title: "Terms & Conditions | ZamraBooking",
  description: "The terms for booking flights, hotels and travel insurance on ZamraBooking.",
};

export default function TermsPage() {
  return (
    <LegalPage
      current="/terms"
      title="Terms & Conditions"
      intro={<p>These terms apply when you use {BUSINESS.website.replace("https://", "")} (the &quot;website&quot;) to search for or book flights, hotels, travel insurance or other travel services. The website is operated by <b>{BUSINESS.legalName}</b> (&quot;{BUSINESS.brand}&quot;, &quot;we&quot;, &quot;us&quot;). By making a booking you agree to these terms, our <a href="/privacy">Privacy Policy</a> and our <a href="/refund-policy">Cancellation &amp; Refund Policy</a>.</p>}
      sections={[
        { id: "role", title: "Our role", body: <>
          <p>{BUSINESS.brand} is a travel agent. We sell travel services that are provided by airlines, hotels, insurers and other suppliers (&quot;service providers&quot;). The service provider is responsible for delivering the service — operating the flight, providing the room or honouring the insurance policy — under its own conditions of carriage, booking rules and policy terms, which form part of your contract with it.</p>
          <p>We are responsible for taking your booking accurately, collecting the correct payment, issuing your tickets and documents, and helping you with changes, cancellations and refunds.</p>
        </> },
        { id: "eligibility", title: "Using the website", body: <ul>
          <li>You must be at least 18 years old and legally able to enter into a contract to make a booking.</li>
          <li>If you book for other travellers, you confirm that you have their permission to share their details with us and that they accept these terms.</li>
          <li>You agree not to make speculative, false or fraudulent bookings, and not to misuse, copy, scrape or interfere with the website.</li>
          <li>Keep your account login private. You are responsible for bookings made from your account.</li>
        </ul> },
        { id: "booking", title: "Bookings and traveller details", body: <>
          <ul>
            <li>Enter every traveller&apos;s name <b>exactly as it appears on their passport or government ID</b>. Airlines may refuse boarding, or charge for a name correction, if the names do not match.</li>
            <li>Make sure your email address and mobile number are correct. We send tickets, schedule changes and important updates to them.</li>
            <li>A booking is confirmed only when payment has been received and we have sent you a confirmation with the booking reference. For some fares our team issues the ticket after payment; you will receive the e-ticket and airline PNR by email shortly after.</li>
            <li>If a fare becomes unavailable or its price changes before ticketing, we will tell you before charging any difference, or refund you in full if you do not wish to continue.</li>
          </ul>
        </> },
        { id: "prices", title: "Prices and payment", body: <>
          <ul>
            <li>Prices are shown in Indian Rupees (INR) unless another currency is clearly shown. They include the airline or hotel fare, applicable taxes and our service fee.</li>
            <li>Fares are dynamic and are guaranteed only once the booking is ticketed. Seat, meal and baggage add-ons are charged at the price shown when you select them.</li>
            <li>Payments are processed securely by our payment partners. We do not see or store your full card details.</li>
            <li>For &quot;hold now, pay later&quot; fares, the hold is released by the airline if payment is not completed before the time shown.</li>
            <li>If a payment is debited but the booking cannot be confirmed, the full amount is refunded to the original payment method.</li>
          </ul>
        </> },
        { id: "travel-docs", title: "Passports, visas and health requirements", body: <p>You are responsible for holding a valid passport (usually valid for at least 6 months beyond travel), any visas, transit visas, permits and health documents required by every country you travel to or through. We can share general guidance, but airlines and immigration authorities make the final decision. We are not liable if you are refused boarding or entry because of missing or invalid documents.</p> },
        { id: "changes", title: "Changes, cancellations and refunds", body: <>
          <p>Changes and cancellations follow the fare rules of the airline or hotel and our <a href="/refund-policy">Cancellation &amp; Refund Policy</a>. In summary:</p>
          <ul>
            <li>Cancellation and change charges are set by the service provider and are shown to you before you confirm.</li>
            <li>Our service fee is non-refundable unless the cancellation is caused by us.</li>
            <li>Refunds are made after the service provider refunds us, to your {BUSINESS.brand} wallet or the original payment method.</li>
          </ul>
        </> },
        { id: "schedule", title: "Schedule changes and cancellations by the airline", body: <p>Airlines may change flight times, routes or aircraft, or cancel flights. We pass on these changes as soon as we receive them and help you choose a free alternative or a refund where the airline offers one. We are not responsible for the airline&apos;s changes, delays or cancellations, or for costs arising from them, but we will pursue any refund or compensation the airline grants on your behalf.</p> },
        { id: "check-in", title: "At the airport", body: <ul>
          <li>Check in online or at the airport within the airline&apos;s deadline. We recommend arriving 3 hours before international and 2 hours before domestic departures.</li>
          <li>Follow the airline&apos;s baggage allowances and restricted-items rules. Excess baggage is charged by the airline.</li>
          <li>If you do not travel on a booked flight (a &quot;no-show&quot;), the airline may cancel all later flights on the same booking and refund only taxes, if anything.</li>
        </ul> },
        { id: "insurance", title: "Travel insurance and other services", body: <p>Travel insurance is provided by the insurer named on your policy, and claims are handled by the insurer under the policy wording. Hotels, insurance and any other service you book are subject to the provider&apos;s own terms, which we show before you pay.</p> },
        { id: "wallet", title: "Wallet, referral credits and offers", body: <ul>
          <li>{BUSINESS.brand} wallet balances (refunds, bonuses and referral rewards) can be used for bookings on the website. Promotional credits have no cash value and may expire as shown when they are given.</li>
          <li>Offers and coupons are subject to their own conditions and may be withdrawn at any time. We may cancel bookings or credits obtained by misuse of an offer.</li>
        </ul> },
        { id: "liability", title: "Our liability", body: <>
          <p>We take reasonable care in providing our services. To the extent permitted by law:</p>
          <ul>
            <li>Our total liability for any booking is limited to the amount you paid us for that booking.</li>
            <li>We are not liable for indirect or consequential losses, or for the acts or omissions of service providers.</li>
            <li>We are not liable for failure or delay caused by events beyond our reasonable control, such as natural disasters, epidemics, government action, strikes, war, or failures of airline or payment systems.</li>
          </ul>
          <p>Nothing in these terms limits any right you have that cannot be limited under applicable law.</p>
        </> },
        { id: "ip", title: "Website content", body: <p>All content on the website — text, design, logos and software — belongs to {BUSINESS.legalName} or its licensors. You may use it only to search for and make personal bookings.</p> },
        { id: "law", title: "Governing law and disputes", body: <p>These terms are governed by the laws of India. Please contact us first so we can try to resolve any complaint quickly. Any dispute that cannot be resolved amicably will be subject to the exclusive jurisdiction of the courts at the place of our registered office in India.</p> },
        { id: "changes-to-terms", title: "Changes to these terms", body: <p>We may update these terms from time to time. The version in force when you make a booking applies to that booking. The date at the top shows when they were last updated.</p> },
        { id: "contact", title: "Contact us", body: <ContactLines /> },
      ]}
    />
  );
}
