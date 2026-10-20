"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { apiHeaders, API } from "@/lib/api";

interface Stats {
  bookings: number;
  tenants:  number;
  agents:   number;
}

export default function AdminDashboard() {
  const [stats,   setStats]   = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/api/admin/dashboard`, { headers: apiHeaders(), cache: "no-store" })
      .then((r) => r.ok ? r.json() as Promise<Stats> : null)
      .then((data) => setStats(data ?? { bookings: 0, tenants: 0, agents: 0 }))
      .catch(() => setStats({ bookings: 0, tenants: 0, agents: 0 }))
      .finally(() => setLoading(false));
  }, []);

  const STATS = [
    { label: "Total Bookings",    key: "bookings" as const, color: "#E31E24", icon: "📋" },
    { label: "Active Tenants",    key: "tenants"  as const, color: "#F7941D", icon: "🏢" },
    { label: "Registered Agents", key: "agents"   as const, color: "#6366f1", icon: "👥" },
  ];

  const QUICK_ACTIONS = [
    { href: "/tenants",      label: "Manage Tenants",    icon: "🏢", desc: "View and configure tenants" },
    { href: "/api-keys",     label: "API Keys",          icon: "🔑", desc: "Issue keys for integrations" },
    { href: "/bookings",     label: "All Bookings",      icon: "📋", desc: "Search and filter bookings" },
    { href: "/integrations", label: "Integrations",      icon: "⚙️", desc: "Manage supplier connections" },
    { href: "/finance",      label: "Finance",           icon: "💰", desc: "Revenue and reports" },
    { href: "/settings",     label: "Settings",          icon: "🔧", desc: "Payments, WhatsApp, e-ticket" },
  ];

  return (
    <div>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", marginBottom: 4 }}>
          Platform Overview
        </h1>
        <p style={{ color: "#64748b", fontSize: 13 }}>
          All tenants · All suppliers · All regions
        </p>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 16, marginBottom: 40 }}>
        {STATS.map(({ label, key, color, icon }) => (
          <div key={key} style={{
            background: "#1e293b",
            borderRadius: 12,
            padding: "20px 22px",
            border: "1px solid #334155",
            borderTop: `3px solid ${color}`,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: "#64748b", fontWeight: 500 }}>{label}</div>
              <span style={{ fontSize: 18 }}>{icon}</span>
            </div>
            <div style={{ fontSize: 30, fontWeight: 700, color: "#f1f5f9", lineHeight: 1 }}>
              {loading ? (
                <span style={{ fontSize: 20, color: "#334155" }}>—</span>
              ) : (
                (stats?.[key] ?? 0).toLocaleString()
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Quick actions */}
      <div style={{ marginBottom: 8 }}>
        <h2 style={{ fontSize: 11, fontWeight: 700, color: "#475569", marginBottom: 16, textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Quick Actions
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
          {QUICK_ACTIONS.map((a) => (
            <Link key={a.href} href={a.href} style={{
              display: "flex", alignItems: "center", gap: 14,
              background: "#1e293b", border: "1px solid #334155",
              borderRadius: 10, padding: "14px 16px",
              textDecoration: "none", transition: "border-color 0.15s, background 0.15s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.borderColor = "#E31E24";
              (e.currentTarget as HTMLAnchorElement).style.background = "rgba(227,30,36,.05)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.borderColor = "#334155";
              (e.currentTarget as HTMLAnchorElement).style.background = "#1e293b";
            }}
            >
              <span style={{ fontSize: 22, flexShrink: 0 }}>{a.icon}</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#f1f5f9" }}>{a.label}</div>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>{a.desc}</div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
