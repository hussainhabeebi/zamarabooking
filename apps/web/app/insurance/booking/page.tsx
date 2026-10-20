"use client";

// TripSafe booking: status, policy numbers and certificate (COI) downloads.
// Opened with ?ref=TS-…&key=… (the link we return after booking).

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import "../insurance.css";
import { API_URL, authHeaders, money, nameOf } from "../shared";

type Policy = { travellerId: number | null; name: string; dob?: string; policyId?: string; coiUrl?: string; totalFare?: number };
type Tnc = { assistance?: string; insurance?: string; tripjack?: string };
type Booking = {
  reference: string; status: string; pending: boolean; failed: boolean; journey: string; createdAt: string;
  input: { startDate: string; endDate?: string; coverageDuration?: number; destinations: { key: string; type: string }[] };
  product: { planCoverage: string; insuranceProvider: string; regionName: string; totalFare: number };
  currency: string;
  travellers: { firstName: string; lastName: string; dob: string }[];
  tripjack?: { bookingId: string; status: string; tnc?: Tnc };
  details?: { status: string; startDate?: string; endDate?: string; productIdentifier?: string; totalAmount?: number; travellers: Policy[]; tnc?: Tnc };
  detailError?: string;
};

const JOURNEY_LABEL: Record<string, string> = {
  STANDALONE: "Single trip", DOMESTIC: "Within India", STUDENT: "Student", AMT: "Annual multi-trip", EMBEDDED: "Flight cover",
};

function tone(status: string) {
  if (["SUCCESS", "PAYMENT_SUCCESS", "UPDATED"].includes(status)) return "ok";
  if (["CANCELLED", "ABORTED", "PAYMENT_FAILED", "UNCONFIRMED", "FAILED"].includes(status)) return "bad";
  return "wait";
}

function label(status: string) {
  return ({
    SUCCESS: "Policy issued", AWAITING_PAYMENT: "Awaiting payment", PAYMENT_PENDING: "Payment pending",
    IN_PROGRESS: "Issuing", CANCELLED: "Cancelled", FAILED: "Not issued",
  } as Record<string, string>)[status] ?? status.replace(/_/g, " ").toLowerCase();
}

function BookingInner() {
  const qs = useSearchParams();
  const ref = qs.get("ref") ?? "";
  const key = qs.get("key") ?? "";
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!ref) { setError("Booking reference missing."); return; }
    let cancelled = false;
    let tries = 0;
    async function load() {
      try {
        const res = await fetch(`${API_URL}/api/insurance/bookings/${encodeURIComponent(ref)}?key=${encodeURIComponent(key)}`, { headers: authHeaders() });
        const d = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) { setError(d.error ?? "Insurance booking not found."); return; }
        setBooking(d);
        // Poll while TripJack is still issuing (not while waiting for our team).
        if (d.pending && d.status !== "AWAITING_PAYMENT" && tries++ < 24) setTimeout(load, 5000);
      } catch {
        if (!cancelled) setError("We couldn't reach the server. Please refresh.");
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [ref, key]);

  if (error) return <main className="ts-page"><div className="ts-error">{error}</div></main>;
  if (!booking) return <main className="ts-page"><p style={{ color: "#64748b" }}>Loading your policy…</p></main>;

  const status = booking.status;
  const policies = booking.details?.travellers ?? [];
  const tnc = booking.details?.tnc ?? booking.tripjack?.tnc;
  const dest = booking.input.destinations.map((d) => (d.type === "COUNTRY" ? nameOf(d.key) : d.key)).join(", ") || "India";

  return (
    <main className="ts-page">
      <div className="ts-hero">
        <div>
          <h1>Travel insurance</h1>
          <p>Reference {booking.reference}{booking.tripjack?.bookingId ? ` · TripSafe booking ${booking.tripjack.bookingId}` : ""}</p>
        </div>
        <span className="ts-status" data-tone={tone(status)}>{label(status)}</span>
      </div>

      {status === "SUCCESS" && <div className="ts-ok" style={{ marginBottom: 14 }}>Your policy is issued. Certificates are also emailed to you.</div>}
      {status === "AWAITING_PAYMENT" && <div className="ts-note" style={{ marginTop: 0, marginBottom: 14 }}>Your plan is reserved. We’ll issue the policy as soon as your payment is received.</div>}
      {booking.failed && <div className="ts-error" style={{ marginTop: 0, marginBottom: 14 }}>We couldn’t issue this policy. Our team has been notified — please contact support with reference {booking.reference}.</div>}
      {booking.pending && status !== "AWAITING_PAYMENT" && !booking.failed && <div className="ts-note" style={{ marginTop: 0, marginBottom: 14 }}>Your policy is being issued — this page updates automatically.</div>}

      <section className="ts-card">
        <h2>{booking.product.planCoverage} cover{booking.details?.productIdentifier ? ` · ${booking.details.productIdentifier}` : ""}</h2>
        <div className="ts-summary">
          <div><span>Plan type</span><strong>{JOURNEY_LABEL[booking.journey] ?? booking.journey}</strong></div>
          <div><span>Destination</span><strong>{dest}</strong></div>
          <div><span>Cover</span><strong>{booking.details?.startDate ?? booking.input.startDate} → {booking.details?.endDate ?? booking.input.endDate ?? `${booking.input.coverageDuration} days`}</strong></div>
          <div><span>Insurer</span><strong>{booking.product.insuranceProvider || "—"}</strong></div>
          <div><span>Premium</span><strong>{money(booking.details?.totalAmount ?? booking.product.totalFare, booking.currency)}</strong></div>
        </div>
      </section>

      <section className="ts-card">
        <h2>Travellers</h2>
        <table className="ts-table">
          <thead><tr><th>Traveller</th><th>Policy number</th><th>Certificate</th></tr></thead>
          <tbody>
            {(policies.length ? policies : booking.travellers.map((t, i) => ({ travellerId: i + 1, name: `${t.firstName} ${t.lastName}`, dob: t.dob } as Policy))).map((p, i) => (
              <tr key={i}>
                <td><strong>{p.name}</strong>{p.dob ? <div style={{ color: "#64748b", fontSize: 12 }}>Born {p.dob}</div> : null}</td>
                <td>{p.policyId ?? <span style={{ color: "#64748b" }}>{status === "SUCCESS" ? "Generating…" : "—"}</span>}</td>
                <td>{p.coiUrl ? <a className="ts-btn ts-btn-small" style={{ display: "inline-block", textDecoration: "none" }} href={p.coiUrl} target="_blank" rel="noopener noreferrer">Download</a> : <span style={{ color: "#64748b" }}>—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {booking.detailError && <div className="ts-error">{booking.detailError}</div>}
      </section>

      {tnc && (
        <section className="ts-card">
          <h2>Terms &amp; conditions</h2>
          <div className="ts-links">
            {tnc.insurance && <a href={tnc.insurance} target="_blank" rel="noopener noreferrer">Insurance terms</a>}
            {tnc.assistance && <a href={tnc.assistance} target="_blank" rel="noopener noreferrer">Travel assistance terms</a>}
            {tnc.tripjack && <a href={tnc.tripjack} target="_blank" rel="noopener noreferrer">TripSafe terms</a>}
          </div>
        </section>
      )}
    </main>
  );
}

export default function InsuranceBookingPage() {
  return <Suspense fallback={<main className="ts-page"><p style={{ color: "#64748b" }}>Loading…</p></main>}><BookingInner /></Suspense>;
}
