import { serverAuthHeaders } from "../../../lib/server";
import DeleteAgentButton from "./DeleteAgentButton";
const SERVER_API   = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
const SERVER_TOKEN = process.env.ADMIN_SERVICE_TOKEN ?? "";

const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  PENDING:   { bg: "#fffbeb", color: "#92400e" },
  APPROVED:  { bg: "#ecfdf5", color: "#065f46" },
  SUSPENDED: { bg: "#fef2f2", color: "#b91c1c" },
  REJECTED:  { bg: "#f3f4f6", color: "#6b7280" },
};

interface Agent {
  id:           string;
  businessName: string;
  agentNumber?: string | null;
  contactEmail: string;
  status:       string;
  tenantSlug:   string;
  plan:         string;
  createdAt:    string;
}

async function getAgents(): Promise<Agent[]> {
  try {
    const res = await fetch(`${SERVER_API}/api/admin/agents`, {
      headers: await serverAuthHeaders(),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json() as { agents: Agent[] };
    return data.agents ?? [];
  } catch {
    return [];
  }
}

export default async function AgentsPage() {
  const agents = await getAgents();

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9" }}>Agent Management</h1>
        <div style={{ display: "flex", gap: 12 }}>
          <span style={{ padding: "8px 16px", background: "#1e293b", color: "#94a3b8", borderRadius: 8, fontSize: 13 }}>
            {agents.length} agents
          </span>
        </div>
      </div>

      <div style={{ background: "#1e293b", borderRadius: 12, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#0f172a" }}>
              {["Business", "Email", "Tenant", "Plan", "Status", "Joined", "Actions"].map((h) => (
                <th key={h} style={{ textAlign: "left", padding: "14px 16px", fontSize: 11, textTransform: "uppercase", color: "#64748b", fontWeight: 700 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {agents.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: "32px 16px", textAlign: "center", color: "#64748b" }}>No agents found</td>
              </tr>
            )}
            {agents.map((a) => {
              const sc = STATUS_COLORS[a.status] ?? { bg: "#1e293b", color: "#94a3b8" };
              return (
                <tr key={a.id} style={{ borderBottom: "1px solid #0f172a" }}>
                  <td style={{ padding: "14px 16px", color: "#f1f5f9", fontWeight: 600 }}>{a.businessName}{a.agentNumber ? <div style={{ color: "#93c5fd", fontSize: 11, fontWeight: 700 }}>{a.agentNumber}</div> : null}</td>
                  <td style={{ padding: "14px 16px", color: "#94a3b8", fontSize: 13 }}>{a.contactEmail}</td>
                  <td style={{ padding: "14px 16px", color: "#94a3b8", fontSize: 13, fontFamily: "monospace" }}>{a.tenantSlug}</td>
                  <td style={{ padding: "14px 16px" }}>
                    <span style={{ background: "#0f172a", color: "#6366f1", borderRadius: 6, padding: "3px 8px", fontSize: 12, fontWeight: 700 }}>
                      {a.plan}
                    </span>
                  </td>
                  <td style={{ padding: "14px 16px" }}>
                    <span style={{ background: sc.bg, color: sc.color, borderRadius: 6, padding: "3px 8px", fontSize: 12, fontWeight: 700 }}>
                      {a.status}
                    </span>
                  </td>
                  <td style={{ padding: "14px 16px", color: "#64748b", fontSize: 13 }}>
                    {new Date(a.createdAt).toLocaleDateString("en-IN")}
                  </td>
                  <td style={{ padding: "14px 16px" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <a href={`/agents/${a.id}`} style={{ color: "#6366f1", fontSize: 13, textDecoration: "none" }}>View →</a>
                      <DeleteAgentButton agentId={a.id} businessName={a.businessName} />
                    </div>
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
