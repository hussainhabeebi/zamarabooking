import { serverAuthHeaders } from "../../../lib/server";
import { SERVER_API, SERVER_TOKEN } from "../../../lib/api";

async function getTenants() {
  try {
    const res = await fetch(`${SERVER_API}/api/admin/tenants`, {
      headers: await serverAuthHeaders(),
      cache: "no-store",
    });
    if (res.ok) return res.json() as Promise<Array<{
      id: string; name: string; slug: string; plan: string;
      status: string; region: string; createdAt: string;
    }>>;
  } catch {}
  return [];
}

const STATUS_COLOR: Record<string, string> = {
  ACTIVE:      "#10B981",
  ONBOARDING:  "#F7941D",
  SUSPENDED:   "#EF4444",
  TRIAL_EXPIRED: "#9CA3AF",
  CLOSED:      "#6B7280",
};

export default async function TenantsPage() {
  const tenants = await getTenants();

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "white", margin: 0 }}>Tenants</h1>
        <a href="/tenants/new" style={{
          background: "#E31E24", color: "white", borderRadius: 8,
          padding: "10px 20px", textDecoration: "none", fontWeight: 600, fontSize: 14,
        }}>
          + New Tenant
        </a>
      </div>

      <div style={{ background: "#1e293b", borderRadius: 10, border: "1px solid #334155", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ background: "#0f172a" }}>
              {["Name", "Slug", "Plan", "Region", "Status", "Created", "Actions"].map((h) => (
                <th key={h} style={{
                  padding: "12px 20px", textAlign: "left",
                  color: "#64748b", fontWeight: 600, fontSize: 12, textTransform: "uppercase",
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tenants.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ padding: "40px", textAlign: "center", color: "#64748b" }}>
                  No tenants yet. Click "+ New Tenant" to onboard the first one.
                </td>
              </tr>
            ) : tenants.map((t) => (
              <tr key={t.id} style={{ borderTop: "1px solid #334155" }}>
                <td style={{ padding: "14px 20px", color: "white", fontWeight: 500 }}>{t.name}</td>
                <td style={{ padding: "14px 20px", color: "#94a3b8" }}>{t.slug}.flypoomas.com</td>
                <td style={{ padding: "14px 20px" }}>
                  <span style={{
                    background: "#1e40af22", color: "#60a5fa",
                    padding: "2px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                  }}>
                    {t.plan}
                  </span>
                </td>
                <td style={{ padding: "14px 20px", color: "#94a3b8" }}>{t.region}</td>
                <td style={{ padding: "14px 20px" }}>
                  <span style={{
                    color: STATUS_COLOR[t.status] ?? "#9ca3af",
                    fontWeight: 600, fontSize: 13,
                  }}>
                    ● {t.status}
                  </span>
                </td>
                <td style={{ padding: "14px 20px", color: "#64748b", fontSize: 13 }}>
                  {new Date(t.createdAt).toLocaleDateString("en-IN")}
                </td>
                <td style={{ padding: "14px 20px" }}>
                  <a href={`/tenants/${t.id}`} style={{ color: "#E31E24", fontSize: 13 }}>Manage →</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
