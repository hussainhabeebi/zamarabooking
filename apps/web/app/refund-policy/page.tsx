import type { Metadata } from "next";
import { ContactLines, LegalPage } from "../components/LegalPage";
import { BUSINESS } from "../lib/business";
import styles from "../components/legal.module.css";

export const metadata: Metadata = {
  title: "Cancellation & Refund Policy | ZamraBooking",
  description: "How to cancel a ZamraBooking booking, what is refunded and how long refunds take.",
};

export default function RefundPolicyPage() {
  return (
    <LegalPage
      current="/refund-policy"
      title="Cancellation & Refund Policy"
      intro={<p>This policy explains how cancellations, changes and refunds work for bookings made on {BUSINESS.brand}. Each airline, hotel and insurer sets its own rules for its fares; we show them before you book and apply them exactly, adding only what is stated below.</p>}
      sections={[
        { id: "how", title: "How to cancel", body: <>
          <ul>
            <li><b>Online:</b> open <a href="/trips">My Trips</a> (or <a href="/trips/find">Find a booking</a> with your PNR and email), choose the booking and select <b>Cancel</b>. You see the refund amount before you confirm.</li>
            <li><b>By email or WhatsApp:</b> write to <a href={`mailto:${BUSINESS.email}`}>{BUSINESS.email}</a> or WhatsApp <a href={BUSINESS.whatsappHref}>{BUSINESS.phone}</a> with your booking ID or PNR. Some fares, including group and special fares, can only be cancelled this way.</li>
          </ul>
          <p>Flight cancellations must reach us at least <b>4 hours before departure</b> for domestic flights and <b>6 hours before departure</b> for international flights (or earlier if the airline requires). After that, the booking may be treated as a no-show.</p>
        </> },
        { id: "flights", title: "Flight cancellation charges", body: <>
          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th>Charge</th><th>Amount</th></tr></thead>
              <tbody>
                <tr><td>Airline cancellation fee</td><td>As per the airline&apos;s fare rules for your fare — shown on the booking page and in My Trips.</td></tr>
                <tr><td>{BUSINESS.brand} service fee</td><td>Non-refundable, unless the cancellation is caused by us.</td></tr>
                <tr><td>Non-refundable fares</td><td>Only the refundable taxes and fees the airline returns are refunded.</td></tr>
                <tr><td>No-show</td><td>Usually only part of the taxes is refundable, as decided by the airline.</td></tr>
              </tbody>
            </table>
          </div>
          <p>Refund amount = amount paid − airline cancellation fee − service fee. Seats, meals and baggage bought as add-ons are refunded only if the airline refunds them.</p>
        </> },
        { id: "changes", title: "Date, name and flight changes", body: <ul>
          <li>Date or flight changes are allowed where the fare permits. You pay the airline&apos;s change fee plus any difference in fare.</li>
          <li>Most airlines do not allow name changes. Minor spelling corrections may be possible for a fee; contact us before travel.</li>
          <li>Request changes by email or WhatsApp with your booking ID.</li>
        </ul> },
        { id: "airline-cancel", title: "If the airline cancels or reschedules", body: <p>If the airline cancels your flight or changes it significantly, you can accept the new flight, choose another flight the airline offers free of charge, or cancel for a refund. In these cases <b>no cancellation fee or service fee is deducted</b> for the affected flight, and we refund everything the airline returns. We will contact you with your options.</p> },
        { id: "failed", title: "Failed or unconfirmed bookings", body: <p>If your payment is successful but we cannot confirm the booking, the full amount is refunded automatically — to your wallet straight away, or to your original payment method within the times below. You will not be charged for a booking that was not issued.</p> },
        { id: "hotels", title: "Hotels", body: <p>Hotel cancellations follow the cancellation policy shown for the room you booked (for example, &quot;free cancellation until a given date&quot;). Non-refundable rates cannot be refunded. Early check-out or no-show is charged as per the hotel&apos;s policy.</p> },
        { id: "insurance", title: "Travel insurance", body: <p>Insurance policies can be cancelled before the start date of cover, subject to the insurer&apos;s terms. Once cover has started, or if a claim has been made, the premium is not refundable.</p> },
        { id: "timelines", title: "How and when refunds are paid", body: <>
          <p>Refunds are processed once the airline, hotel or insurer refunds us. You choose where the refund goes when you cancel:</p>
          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th>Refund to</th><th>Time</th></tr></thead>
              <tbody>
                <tr><td>{BUSINESS.brand} wallet</td><td>Instantly once the supplier confirms the refund.</td></tr>
                <tr><td>Original card, UPI or net banking</td><td>We initiate it within 1–2 working days of the supplier&apos;s confirmation; your bank usually credits it within 5–7 working days.</td></tr>
              </tbody>
            </table>
          </div>
          <p>Most airline refunds are confirmed within 7–15 working days, but some airlines take longer. You can follow every refund in <a href="/trips">My Trips</a>, and we email you when it is paid. Refunds are made in the currency and to the account used for payment.</p>
        </> },
        { id: "help", title: "Questions about a refund", body: <>
          <p>If your refund has not arrived within the times above, contact us with your booking ID and we will check it with the supplier and our payment partner.</p>
          <ContactLines />
        </> },
      ]}
    />
  );
}
