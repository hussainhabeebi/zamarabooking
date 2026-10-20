"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { API, apiHeaders } from "../../lib/api";

const NAV_ITEMS = [
  { href: "/dashboard",    label: "Overview",      icon: "📊" },
  { href: "/tenants",      label: "Tenants",       icon: "🏢" },
  { href: "/bookings",     label: "Bookings",      icon: "📋" },
  { href: "/tripsafe",     label: "TripSafe",      icon: "🛡️" },
  { href: "/agents",       label: "Agents",        icon: "👥" },
  { href: "/leadvyne-agencies", label: "Leadvyne agencies", icon: "💬" },
  { href: "/agent-requests", label: "Agent requests", icon: "📨" },
  { href: "/wallet-recharges", label: "Wallet recharges", icon: "🏦" },
  { href: "/agent-program", label: "Agent programme", icon: "🏅" },
  { href: "/suppliers",    label: "Suppliers",     icon: "🔌" },
  { href: "/finance",      label: "Finance",       icon: "💰" },
  { href: "/markup",       label: "Markup",        icon: "🏷️" },
  { href: "/customer-wallets", label: "Wallets",   icon: "👛" },
  { href: "/cancellations", label: "Cancellations", icon: "↩️" },
  { href: "/support",      label: "Support",       icon: "🛟" },
  { href: "/integrations", label: "Integrations",  icon: "⚙️" },
  { href: "/api-keys",     label: "API Keys",      icon: "🔑" },
  { href: "/settings",     label: "Settings",      icon: "🔧" },
  { href: "/supplier-logs", label: "API Logs",     icon: "📡" },
  { href: "/users",        label: "Users & staff", icon: "🧑‍💼" },
];

// Staff see only the pages of the sections ticked for them (the API enforces it too).
const SECTION_OF: Record<string, string> = {
  "/bookings": "bookings", "/cancellations": "bookings", "/tripsafe": "bookings",
  "/agents": "agents", "/leadvyne-agencies": "agents",
  "/agent-requests": "agent_requests", "/wallet-recharges": "wallet_recharges",
  "/customer-wallets": "customer_wallets", "/support": "support", "/finance": "finance", "/supplier-logs": "logs",
};
type AdminMe = { user: { name: string | null; email: string | null }; role: string; roleLabel: string; fullAccess: boolean; sections: string[]; canManageUsers: boolean };

export default function AdminDashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router   = useRouter();
  const [me, setMe] = useState<AdminMe | null>(null);

  useEffect(() => {
    fetch(`${API}/api/admin/me`, { headers: apiHeaders() })
      .then(async (r) => { if (r.status === 401) { signOut(); return null; } return r.ok ? r.json() as Promise<AdminMe> : null; })
      .then((d) => d && setMe(d)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const allowed = (href: string) => !me || me.fullAccess
    ? href !== "/users" || !me || me.canManageUsers
    : !!SECTION_OF[href] && me.sections.includes(SECTION_OF[href]);
  const navItems = NAV_ITEMS.filter((i) => allowed(i.href));
  const current = NAV_ITEMS.find((n) => pathname === n.href || pathname.startsWith(n.href + "/"));
  const blocked = !!me && !!current && !allowed(current.href);

  // Staff land on their first section instead of the overview.
  useEffect(() => {
    if (me && !me.fullAccess && (pathname === "/dashboard" || pathname === "/")) {
      const first = NAV_ITEMS.find((i) => allowed(i.href));
      if (first) router.replace(first.href);
    }
  }, [me, pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  function signOut() {
    document.cookie = "poomas_admin_token=; Path=/; Max-Age=0; SameSite=Lax";
    router.push("/login");
  }

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0f172a; }

        .admin-shell   { display: flex; min-height: 100vh; }

        .admin-sidebar {
          width: 240px;
          background: #1e293b;
          border-right: 1px solid #334155;
          display: flex;
          flex-direction: column;
          padding: 0;
          flex-shrink: 0;
          position: sticky;
          top: 0;
          height: 100vh;
          overflow-y: auto;
        }

        .admin-sidebar-header {
          padding: 20px 20px 16px;
          border-bottom: 1px solid #334155;
        }
        .admin-sidebar-header img { height: 28px; width: auto; }
        .admin-sidebar-header .role-badge {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 10px;
          font-weight: 600;
          color: #64748b;
          margin-top: 8px;
          background: #0f172a;
          padding: 3px 8px;
          border-radius: 20px;
          border: 1px solid #334155;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .admin-sidebar-header .role-badge::before {
          content: "";
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #22c55e;
          display: inline-block;
        }

        .admin-nav { flex: 1; padding: 12px 0; }
        .admin-nav-section-title {
          padding: 16px 20px 6px;
          font-size: 10px;
          font-weight: 700;
          color: #475569;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }

        .admin-nav-link {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 9px 20px;
          color: #94a3b8;
          text-decoration: none;
          font-size: 13.5px;
          font-weight: 500;
          border-left: 3px solid transparent;
          transition: background 0.12s, color 0.12s;
          border-radius: 0;
          position: relative;
        }
        .admin-nav-link:hover {
          background: rgba(255,255,255,.05);
          color: #e2e8f0;
        }
        .admin-nav-link.active {
          background: rgba(227,30,36,.08);
          color: #f1f5f9;
          border-left-color: #E31E24;
          font-weight: 600;
        }
        .admin-nav-link-icon { font-size: 15px; width: 20px; text-align: center; flex-shrink: 0; }

        .admin-sidebar-footer {
          border-top: 1px solid #334155;
          padding: 12px 0;
        }

        .admin-main {
          flex: 1;
          background: #0f172a;
          overflow-y: auto;
          min-width: 0;
          display: flex;
          flex-direction: column;
        }

        .admin-topbar {
          background: #0f172a;
          border-bottom: 1px solid #1e293b;
          padding: 0 28px;
          height: 56px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-shrink: 0;
          position: sticky;
          top: 0;
          z-index: 10;
        }

        .admin-content { padding: 28px; flex: 1; }

        .admin-bottom-nav {
          display: none;
          position: fixed;
          bottom: 0; left: 0; right: 0;
          background: #1e293b;
          border-top: 1px solid #334155;
          z-index: 100;
          padding-bottom: env(safe-area-inset-bottom, 0);
          overflow-x: auto;
        }
        .admin-bottom-nav-inner {
          display: flex;
          align-items: stretch;
          min-width: max-content;
          width: 100%;
        }
        .admin-bottom-nav-link {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 2px;
          padding: 10px 8px;
          text-decoration: none;
          color: #64748b;
          font-size: 10px;
          font-weight: 500;
          min-height: 56px;
          white-space: nowrap;
          transition: color 0.15s;
        }
        .admin-bottom-nav-link.active { color: #E31E24; }
        .admin-bottom-nav-icon { font-size: 18px; line-height: 1; }

        @media (max-width: 767px) {
          .admin-sidebar    { display: none; }
          .admin-bottom-nav { display: block; }
          .admin-content    { padding: 16px 16px 76px; }
          .admin-topbar     { padding: 0 16px; }
        }
      `}</style>

      <div className="admin-shell">
        {/* Desktop sidebar */}
        <nav className="admin-sidebar">
          <div className="admin-sidebar-header">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="POOMAS Admin" />
            <div className="role-badge">{me ? me.roleLabel : "Admin"}</div>
            {me?.user.name && <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 6 }}>{me.user.name}</div>}
          </div>

          <div className="admin-nav">
            <div className="admin-nav-section-title">Platform</div>
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`admin-nav-link${isActive(item.href) ? " active" : ""}`}
              >
                <span className="admin-nav-link-icon">{item.icon}</span>
                {item.label}
              </Link>
            ))}
          </div>

          <div className="admin-sidebar-footer">
            <button
              onClick={signOut}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "9px 20px", color: "#64748b", background: "none",
                border: "none", cursor: "pointer", width: "100%",
                fontSize: "13.5px", fontWeight: 500,
                borderLeft: "3px solid transparent",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#f87171"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#64748b"; }}
            >
              <span style={{ fontSize: 15, width: 20, textAlign: "center" }}>🚪</span>
              Sign Out
            </button>
          </div>
        </nav>

        {/* Main area */}
        <div className="admin-main">
          <header className="admin-topbar">
            <div style={{ fontSize: 13, color: "#475569", fontWeight: 500 }}>
              {NAV_ITEMS.find((n) => isActive(n.href))?.label ?? "Admin"}
            </div>
            <button
              onClick={signOut}
              style={{
                background: "none", border: "1px solid #334155", color: "#64748b",
                borderRadius: 6, padding: "5px 12px", fontSize: 12, cursor: "pointer",
                fontWeight: 500,
              }}
            >
              Sign out
            </button>
          </header>

          <main className="admin-content">
            {blocked ? (
              <div style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 12, padding: 24, color: "#e2e8f0" }}>
                <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>No access to this section</h1>
                <p style={{ color: "#94a3b8", fontSize: 14 }}>Your account can open: {navItems.map((i) => i.label).join(", ") || "nothing yet"}. Ask an admin if you need more.</p>
              </div>
            ) : children}
          </main>
        </div>
      </div>

      {/* Mobile bottom nav */}
      <nav className="admin-bottom-nav">
        <div className="admin-bottom-nav-inner">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`admin-bottom-nav-link${isActive(item.href) ? " active" : ""}`}
            >
              <span className="admin-bottom-nav-icon">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </div>
      </nav>
    </>
  );
}
