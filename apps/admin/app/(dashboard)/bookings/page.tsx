import { serverAuthHeaders } from "../../../lib/server";
import { CertificationExport } from "./CertificationExport";
const SERVER_API   = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
const SERVER_TOKEN = process.env.ADMIN_SERVICE_TOKEN ?? "";

const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  SEARCHED:        { bg: "#1e293b", color: "#64748b" },
  HELD:            { bg: "#422006", color: "#fbbf24" },
  PAYMENT_PENDING: { bg: "#422006", color: "#f59e0b" },
  PAYMENT_FAILED:  { bg: "#450a0a", color: "#f87171" },
  CONFIRMED:       { bg: "#052e16", color: "#4ade80" },
  TICKETED:        { bg: "#052e16", color: "#16a34a" },
  CANCELLED:       { bg: "#1e293b", color: "#94a3b8" },
  REFUND_PENDING:  { bg: "#1e1b4b", color: "#a5b4fc" },
  REFUNDED:        { bg: "#1e1b4b", color: "#8b5cf6" },
};

interface Booking {
  id:          string;
  tenantSlug:  string;
  status:      string;
  origin:      string;
  destination: string;
  departureDate: string;
  pnr:         string | null;
  supplier:    string;
  totalAmount: string;
  currency:    string;
  channel:     string;
  createdAt:   string;
}

async function getBookings(searchParams: Record<string, string>): Promise<{ bookings: Booking[]; total: number }> {
  try {
    const params = new URLSearchParams(searchParams).toString();
    const res = await fetch(`${SERVER_API}/api/admin/bookings?${params}`, {
      headers: await serverAuthHeaders(),
      cache: "no-store",
    });
    if (!res.ok) return { bookings: [], total: 0 };
    return res.json();
  } catch {
    return { bookings: [], total: 0 };
  }
}

export default async function AdminBookingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const sp = await searchParams;
  const { bookings, total } = await getBookings(sp);
  const statusFilter = sp.status ?? "";

  const currSym = (c: string) =>
    c === "INR" ? "₹" : c === "AED" ? "د.إ" : "$";

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9" }}>All Bookings</h1>
        <span style={{ color: "#64748b", fontSize: 14 }}>{total.toLocaleString()} total</span>
      </div>

      <CertificationExport />

      {/* Filters */}
      <form method="GET" style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        <select
          name="status"
          defaultValue={statusFilter}
          style={{ background: "#1e293b", color: "#f1f5f9", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", fontSize: 13 }}
        >
          <option value="">All Statuses</option>
          {Object.keys(STATUS_COLORS).map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
          ))}
        </select>

        <input
          name="tenantSlug"
          defaultValue={sp.tenantSlug ?? ""}
          placeholder="Tenant slug…"
          style={{ background: "#1e293b", color: "#f1f5f9", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", fontSize: 13, width: 160 }}
        />

        <input
          name="pnr"
          defaultValue={sp.pnr ?? ""}
          placeholder="PNR…"
          style={{ background: "#1e293b", color: "#f1f5f9", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", fontSize: 13, width: 140, fontFamily: "monospace" }}
        />

        <button
          type="submit"
          style={{ background: "#E31E24", color: "white", border: "none", borderRadius: 8, padding: "10px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
        >
          Filter
        </button>
      </form>

      {/* Table */}
      <div style={{ background: "#1e293b", borderRadius: 12, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#0f172a" }}>
              {["Route", "Tenant", "PNR", "Supplier", "Channel", "Status", "Amount", "Date", ""].map((h) => (
                <th key={h} style={{ textAlign: "left", padding: "12px 14px", fontSize: 11, textTransform: "uppercase", color: "#64748b", fontWeight: 700 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bookings.length === 0 && (
              <tr>
                <td colSpan={9} style={{ padding: "32px 16px", textAlign: "center", color: "#64748b" }}>No bookings found</td>
              </tr>
            )}
            {bookings.map((b) => {
              const sc = STATUS_COLORS[b.status] ?? { bg: "#1e293b", color: "#94a3b8" };
              return (
                <tr key={b.id} style={{ borderBottom: "1px solid #0f172a" }}>
                  <td style={{ padding: "12px 14px", color: "#f1f5f9", fontWeight: 600, fontSize: 14 }}>
                    {b.origin} → {b.destination}
                  </td>
                  <td style={{ padding: "12px 14px", color: "#94a3b8", fontSize: 13, fontFamily: "monospace" }}>{b.tenantSlug}</td>
                  <td style={{ padding: "12px 14px", color: "#e2e8f0", fontFamily: "monospace", fontSize: 13 }}>{b.pnr ?? "—"}</td>
                  <td style={{ padding: "12px 14px", color: "#94a3b8", fontSize: 13 }}>{b.supplier}</td>
                  <td style={{ padding: "12px 14px", color: "#94a3b8", fontSize: 12 }}>{b.channel.replace(/_/g, " ")}</td>
                  <td style={{ padding: "12px 14px" }}>
                    <span style={{ background: sc.bg, color: sc.color, borderRadius: 6, padding: "3px 8px", fontSize: 11, fontWeight: 700 }}>
                      {b.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td style={{ padding: "12px 14px", color: "#e2e8f0", fontWeight: 600, fontSize: 14 }}>
                    {currSym(b.currency)}{Number(b.totalAmount).toLocaleString("en-IN")}
                  </td>
                  <td style={{ padding: "12px 14px", color: "#64748b", fontSize: 12 }}>
                    {new Date(b.departureDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                  </td>
                  <td style={{ padding: "12px 14px" }}>
                    <a href={`/bookings/${b.id}`} style={{ color: "#6366f1", fontSize: 13, textDecoration: "none" }}>Details →</a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
