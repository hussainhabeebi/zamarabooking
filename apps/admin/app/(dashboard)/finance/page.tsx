import { serverAuthHeaders } from "../../../lib/server";
const SERVER_API   = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
const SERVER_TOKEN = process.env.ADMIN_SERVICE_TOKEN ?? "";

interface FinanceSummary {
  totalRevenue:        number;
  totalMarkup:         number;
  totalPlatformFees:   number;
  totalRefunds:        number;
  pendingRefunds:      number;
  bookingsThisMonth:   number;
  avgBookingValue:     number;
  currency:            string;
}

async function getFinanceSummary(): Promise<FinanceSummary | null> {
  try {
    const res = await fetch(`${SERVER_API}/api/admin/finance/summary`, {
      headers: await serverAuthHeaders(),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export default async function FinancePage() {
  const summary = await getFinanceSummary();
  const sym = "₹"; // INR default for platform view

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", marginBottom: 24 }}>Financial Control</h1>

      {/* KPI Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 32 }}>
        <MetricCard label="Total Revenue"      value={summary ? `${sym}${summary.totalRevenue.toLocaleString("en-IN")}` : "—"} color="#16a34a" />
        <MetricCard label="Markup Collected"   value={summary ? `${sym}${summary.totalMarkup.toLocaleString("en-IN")}` : "—"} color="#2563eb" />
        <MetricCard label="Platform Fees"      value={summary ? `${sym}${summary.totalPlatformFees.toLocaleString("en-IN")}` : "—"} color="#7c3aed" />
        <MetricCard label="Refunds Issued"     value={summary ? `${sym}${summary.totalRefunds.toLocaleString("en-IN")}` : "—"} color="#dc2626" />
        <MetricCard label="Pending Refunds"    value={summary ? `${sym}${summary.pendingRefunds.toLocaleString("en-IN")}` : "—"} color="#d97706" />
        <MetricCard label="Bookings This Month" value={summary ? summary.bookingsThisMonth.toString() : "—"} color="#0ea5e9" />
        <MetricCard label="Avg Booking Value"  value={summary ? `${sym}${summary.avgBookingValue.toLocaleString("en-IN")}` : "—"} color="#6366f1" />
      </div>

      {/* Quick Actions */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ background: "#1e293b", borderRadius: 12, padding: 24 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9", marginBottom: 16 }}>Pending Refunds</h2>
          <p style={{ color: "#64748b", fontSize: 13, marginBottom: 16 }}>
            Review and process cancellation refunds awaiting approval.
          </p>
          <a href="/cancellations" style={{ color: "#E31E24", fontSize: 13, textDecoration: "none", fontWeight: 600 }}>
            View Cancellations & Refunds →
          </a>
        </div>

        <div style={{ background: "#1e293b", borderRadius: 12, padding: 24 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9", marginBottom: 16 }}>Subscription Invoices</h2>
          <p style={{ color: "#64748b", fontSize: 13, marginBottom: 16 }}>
            Monthly invoices sent to tenants for platform usage.
          </p>
          <span style={{ color: "#64748b", fontSize: 13, fontWeight: 600 }}>Not set up yet</span>
        </div>

        <div style={{ background: "#1e293b", borderRadius: 12, padding: 24 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9", marginBottom: 16 }}>Commission Payouts</h2>
          <p style={{ color: "#64748b", fontSize: 13, marginBottom: 16 }}>
            Agent commission ledger and payout schedules.
          </p>
          <span style={{ color: "#64748b", fontSize: 13, fontWeight: 600 }}>Not set up yet</span>
        </div>

        <div style={{ background: "#1e293b", borderRadius: 12, padding: 24 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9", marginBottom: 16 }}>Wallet Topups</h2>
          <p style={{ color: "#64748b", fontSize: 13, marginBottom: 16 }}>
            Agent wallet topup requests and gateway reconciliation.
          </p>
          <a href="/customer-wallets" style={{ color: "#0ea5e9", fontSize: 13, textDecoration: "none", fontWeight: 600 }}>
            View Wallets →
          </a>
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: "#1e293b", borderRadius: 12, padding: 20, borderLeft: `4px solid ${color}` }}>
      <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 10 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: "#f1f5f9" }}>{value}</div>
    </div>
  );
}
