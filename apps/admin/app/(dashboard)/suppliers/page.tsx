import { serverAuthHeaders } from "../../../lib/server";
const SERVER_API = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "https://api.zamrabooking.com";

interface SourceStatus {
  supplier:        string;
  live:            boolean;   // used by customer flight search right now
  note:            string;    // why it is off
  configure:       string | null;
  booking:         string;
  errorsThisMonth: number;
  lastError:       string | null;
}

async function getStatus(): Promise<SourceStatus[] | null> {
  try {
    const res = await fetch(`${SERVER_API}/api/admin/suppliers/status`, { headers: await serverAuthHeaders(), cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as { sources: SourceStatus[] }).sources ?? [];
  } catch {
    return null;
  }
}

const META: Record<string, { label: string; color: string }> = {
  TRIPJACK:    { label: "TripJack",            color: "#2563eb" },
  AKBAR:       { label: "Akbar Travels",       color: "#f59e0b" },
  POOMAS:      { label: "Poomas",              color: "#E31E24" },
  MANUAL:      { label: "Manual fares",        color: "#22c55e" },
  RIYA:        { label: "Riya Travel",         color: "#64748b" },
  DUFFEL:      { label: "Duffel",              color: "#64748b" },
  GOOGLE_SERP: { label: "Google Flights SERP", color: "#64748b" },
};

const CONFIGURE_LABEL: Record<string, string> = {
  "/integrations": "Integrations", "/flight-sources": "Flight sources", "/manual-fares": "Manual fares",
};

export default async function SuppliersPage() {
  const sources = await getStatus();

  return (
    <div style={{ maxWidth: 900 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", marginBottom: 8 }}>Suppliers</h1>
      <p style={{ color: "#64748b", fontSize: 14, marginBottom: 24, lineHeight: 1.6 }}>
        The flight sources customer search is using right now, worked out the same way search does. All live sources are searched
        together and shown cheapest first. Switch a source on or off where it says; errors are from{" "}
        <a href="/supplier-logs" style={{ color: "#93c5fd", fontWeight: 700 }}>API Logs</a>.
      </p>

      {sources === null && (
        <div style={{ background: "#1e293b", borderRadius: 12, padding: 32, textAlign: "center", color: "#fca5a5" }}>
          Couldn&apos;t load the supplier status from the API.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {sources?.map((s) => {
          const meta = META[s.supplier] ?? { label: s.supplier, color: "#6366f1" };
          return (
            <div key={s.supplier} style={{ background: "#1e293b", borderRadius: 12, padding: 20, border: "1px solid #334155", opacity: s.live || s.configure ? 1 : 0.6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: s.live ? "#16a34a" : "#64748b", flexShrink: 0 }} />
                    <h2 style={{ fontSize: 17, fontWeight: 700, color: "#f1f5f9", margin: 0 }}>{meta.label}</h2>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 20, background: s.live ? "#16a34a22" : "#33415588", color: s.live ? "#86efac" : "#94a3b8" }}>
                      {s.live ? "live in search" : "off"}
                    </span>
                  </div>
                  {s.booking && <p style={{ color: "#94a3b8", fontSize: 13, margin: "0 0 4px 20px" }}>{s.booking}</p>}
                  {s.note && <p style={{ color: "#64748b", fontSize: 13, margin: "0 0 0 20px" }}>{s.note}</p>}
                  <div style={{ display: "flex", gap: 24, margin: "12px 0 0 20px" }}>
                    <Metric label="Errors this month" value={s.errorsThisMonth.toLocaleString()} warn={s.errorsThisMonth > 0} />
                    <Metric label="Last error" value={s.lastError ? new Date(s.lastError).toLocaleString("en-IN") : "—"} />
                  </div>
                </div>
                {s.configure && (
                  <a href={s.configure} style={{ background: "#0f172a", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
                    {CONFIGURE_LABEL[s.configure] ?? "Configure"} →
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Metric({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: warn ? "#fca5a5" : "#e2e8f0" }}>{value}</div>
    </div>
  );
}
