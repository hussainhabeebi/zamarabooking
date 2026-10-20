import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import CheckoutFlow from "./CheckoutFlow";

interface CheckoutPageProps {
  params: Promise<{ token: string }>;
}

interface BookingContext {
  booking: {
    id:             string;
    status:         string;
    origin:         string;
    destination:    string;
    totalAmount:    string;
    currency:       string;
    heldUntil:      string | null;
    contactEmail:   string | null;
    contactPhone:   string | null;
    flightData:     Record<string, unknown>;
    adultCount:     number;
    childCount:     number;
    infantCount:    number;
  };
  passengers: Array<{
    id:            string;
    passengerType: string;
    firstName:     string;
    lastName:      string;
    gender:        string | null;
    nationality:   string | null;
    passportNumber: string | null;
    passportExpiry?: string | null;
    passportCountry?: string | null;
    dob?: string | null;
    title?: string | null;
  }>;
  meta: {
    whatsappPhone:  string | null;
    agentId:        string | null;
    tokenExpiresAt: string;
  };
}

async function fetchCheckoutContext(token: string): Promise<BookingContext | null> {
  try {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
    const res = await fetch(`${apiUrl}/api/checkout/session/${token}`, {
      headers: { "x-tenant-slug": "poomas" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json() as BookingContext;
  } catch {
    return null;
  }
}

const CURRENCY_SYMBOLS: Record<string, string> = { INR: "₹", AED: "د.إ", USD: "$" };

export default async function CheckoutPage({ params }: CheckoutPageProps) {
  const { token } = await params;
  const ctx = await fetchCheckoutContext(token);

  if (!ctx) return notFound();

  const { booking, passengers, meta } = ctx;
  const symbol   = CURRENCY_SYMBOLS[booking.currency] ?? booking.currency;
  const fd        = booking.flightData as Record<string, unknown>;
  const expiresAt = meta.tokenExpiresAt;

  return (
    <main style={{ minHeight: "100vh", background: "#f8fafc", padding: "24px 16px" }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 22 }}>✈️</span>
            <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0, color: "#0f172a" }}>
              Complete Your Booking
            </h1>
          </div>
          <p style={{ margin: 0, color: "#64748b", fontSize: 14 }}>
            {booking.origin} → {booking.destination}
          </p>
        </div>

        {/* Fare summary */}
        <div style={card}>
          <SectionTitle>Flight Summary</SectionTitle>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, color: "#0f172a" }}>
                {booking.origin} → {booking.destination}
              </div>
              {fd.airlineName != null && (
                <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>
                  {String(fd.airlineName)} · {fd.flightNumber ? String(fd.flightNumber) : ""}
                </div>
              )}
              <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>
                {booking.adultCount} adult{booking.adultCount !== 1 ? "s" : ""}
                {booking.childCount > 0 ? ` · ${booking.childCount} child` : ""}
                {booking.infantCount > 0 ? ` · ${booking.infantCount} infant` : ""}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: "#E31E24" }}>
                {symbol}{parseFloat(booking.totalAmount).toLocaleString("en-IN")}
              </div>
              <div style={{ fontSize: 12, color: "#94a3b8" }}>{booking.currency} · all-in</div>
            </div>
          </div>

          {booking.heldUntil && (
            <CheckoutTimer expiresAt={booking.heldUntil} tokenExpiresAt={expiresAt} />
          )}
        </div>

        <CheckoutFlow
          bookingId={booking.id}
          token={token}
          passengers={passengers}
          totalAmount={booking.totalAmount}
          currency={booking.currency}
          currencySymbol={symbol}
          contactEmail={booking.contactEmail ?? ""}
          contactPhone={booking.contactPhone ?? ""}
          whatsappPhone={meta.whatsappPhone ?? ""}
        />
      </div>
    </main>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase",
      letterSpacing: "0.05em", marginBottom: 14 }}>{children}</div>
  );
}

function CheckoutTimer({ expiresAt, tokenExpiresAt }: { expiresAt: string; tokenExpiresAt: string }) {
  const heldMs  = new Date(expiresAt).getTime() - Date.now();
  const tokenMs = new Date(tokenExpiresAt).getTime() - Date.now();
  const ms      = Math.min(heldMs, tokenMs);
  const mins    = Math.max(0, Math.floor(ms / 60000));
  const secs    = Math.max(0, Math.floor((ms % 60000) / 1000));
  const isLow   = ms < 5 * 60000;

  return (
    <div style={{
      marginTop: 14, background: isLow ? "#FEF2F2" : "#F0FDF4",
      border: `1px solid ${isLow ? "#FECACA" : "#BBF7D0"}`,
      borderRadius: 8, padding: "10px 14px", fontSize: 13,
      color: isLow ? "#DC2626" : "#16A34A", display: "flex", alignItems: "center", gap: 8,
    }}>
      <span>{isLow ? "⚠️" : "⏳"}</span>
      Seat held for {mins}m {String(secs).padStart(2, "0")}s —
      complete payment before it expires
    </div>
  );
}

const card: React.CSSProperties = {
  background: "white", borderRadius: 12, padding: 20, marginBottom: 16,
  boxShadow: "0 1px 3px rgba(0,0,0,.08)", border: "1px solid #e2e8f0",
};
