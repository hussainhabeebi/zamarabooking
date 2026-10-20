import { serverAuthHeaders } from "../../../lib/server";
const SERVER_API   = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
const SERVER_TOKEN = process.env.ADMIN_SERVICE_TOKEN ?? "";

interface SupplierConfig {
  supplier:    string;
  isEnabled:   boolean;
  priority:    number;
  timeoutMs:   number;
  maxRetries:  number;
  callsThisMonth: number;
}

async function getSuppliers(): Promise<SupplierConfig[]> {
  try {
    const res = await fetch(`${SERVER_API}/api/admin/suppliers`, {
      headers: await serverAuthHeaders(),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json() as { suppliers: SupplierConfig[] };
    return data.suppliers ?? [];
  } catch {
    return [];
  }
}

const SUPPLIER_LABELS: Record<string, { label: string; description: string; color: string }> = {
  RIYA:        { label: "Riya Travel",         description: "Primary GDS — India & Gulf routes. Full booking lifecycle.", color: "#16a34a" },
  TRIPJACK:    { label: "Tripjack",             description: "Secondary supplier. Fallback for Riya failures.",            color: "#2563eb" },
  DUFFEL:      { label: "Duffel",              description: "Global NDC aggregator. Test key: duffel_test_... Live: duffel_live_...", color: "#7c3aed" },
  GOOGLE_SERP: { label: "Google Flights SERP", description: "Indicative pricing only. Requires SERP_API_KEY secret on poomas-api Worker.", color: "#ea4335" },
};

export default async function SuppliersPage() {
  const suppliers = await getSuppliers();

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", marginBottom: 8 }}>Supplier Control</h1>
      <p style={{ color: "#64748b", fontSize: 14, marginBottom: 24 }}>
        Platform-level supplier configuration. Tenant-specific overrides are set per-tenant.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {suppliers.map((s) => {
          const meta = SUPPLIER_LABELS[s.supplier] ?? { label: s.supplier, description: "", color: "#6366f1" };
          return (
            <div key={s.supplier} style={{ background: "#1e293b", borderRadius: 12, padding: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
                    <div style={{
                      width: 10, height: 10, borderRadius: "50%",
                      background: s.isEnabled ? "#16a34a" : "#64748b",
                    }} />
                    <h2 style={{ fontSize: 18, fontWeight: 700, color: "#f1f5f9", margin: 0 }}>{meta.label}</h2>
                    <span style={{ fontSize: 12, color: "#64748b" }}>Priority {s.priority}</span>
                  </div>
                  <p style={{ color: "#64748b", fontSize: 13, margin: "0 0 16px 22px" }}>{meta.description}</p>

                  <div style={{ display: "flex", gap: 24, marginLeft: 22 }}>
                    <Metric label="Timeout" value={`${s.timeoutMs / 1000}s`} />
                    <Metric label="Max Retries" value={String(s.maxRetries)} />
                    <Metric label="Calls This Month" value={s.callsThisMonth.toLocaleString()} />
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <form method="POST" action={`/api/admin/suppliers/${s.supplier}/toggle`}>
                    <button
                      type="submit"
                      style={{
                        background: s.isEnabled ? "#0f172a" : "#16a34a",
                        color: s.isEnabled ? "#94a3b8" : "white",
                        border: `1px solid ${s.isEnabled ? "#334155" : "#16a34a"}`,
                        borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer",
                      }}
                    >
                      {s.isEnabled ? "Disable" : "Enable"}
                    </button>
                  </form>
                </div>
              </div>
            </div>
          );
        })}

        {suppliers.length === 0 && (
          <div style={{ background: "#1e293b", borderRadius: 12, padding: 48, textAlign: "center", color: "#64748b" }}>
            No supplier configurations found.
          </div>
        )}
      </div>

      <div style={{ background: "#1e293b", borderRadius: 12, padding: 24, marginTop: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9", marginBottom: 12 }}>Failover Logic</h2>
        <div style={{ color: "#64748b", fontSize: 13, lineHeight: 1.6 }}>
          <p style={{ margin: "0 0 8px" }}>1. Riya + Tripjack are searched <strong style={{ color: "#f1f5f9" }}>in parallel</strong> for all bookable requests.</p>
          <p style={{ margin: "0 0 8px" }}>2. Results are merged and deduplicated (same flight + cabin = keep cheapest).</p>
          <p style={{ margin: "0 0 8px" }}>3. Google SERP is used <strong style={{ color: "#f1f5f9" }}>only</strong> as WhatsApp bot fallback when both suppliers fail.</p>
          <p style={{ margin: 0 }}>4. SERP results are always marked <code style={{ background: "#0f172a", padding: "1px 6px", borderRadius: 4 }}>isBookable: false</code>.</p>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: "#e2e8f0" }}>{value}</div>
    </div>
  );
}
