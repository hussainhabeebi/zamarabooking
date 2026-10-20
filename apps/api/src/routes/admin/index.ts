import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env, Variables } from "../../types.js";
import { requireRole } from "../../middleware/auth.js";
import { ADMIN_ROLES, loadAdminUser, staffCanOpen } from "../../lib/admin-access.js";
import { adminMeRoutes, adminUsersRoutes } from "./users.js";
import { tenantsAdminRoutes }  from "./tenants.js";
import { bookingsAdminRoutes } from "./bookings.js";
import { suppliersAdminRoutes } from "./suppliers.js";
import { agentsAdminRoutes }  from "./agents.js";
import { financeAdminRoutes } from "./finance.js";
import { settingsAdminRoutes }      from "./settings.js";
import { integrationsAdminRoutes } from "./integrations.js";
import { hotelsAdminRoutes }       from "./hotels.js";
import { tripsafeAdminRoutes }     from "./tripsafe.js";
import { apiKeysAdminRoutes }      from "./api-keys.js";
import { markupAdminRoutes }       from "./markup.js";
import { supplierLogsAdminRoutes } from "./supplier-logs.js";
import { customerWalletsAdminRoutes } from "./customer-wallets.js";
import { cancellationsAdminRoutes, supportAdminRoutes } from "./post-booking.js";
import { agentProgramAdminRoutes } from "./agent-program.js";
import { leadvyneAgentsAdminRoutes } from "./leadvyne-agents.js";

export const adminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// All /api/admin/* routes require an admin-panel user: full admins
// (SUPER_ADMIN, TENANT_ADMIN) or STAFF limited to the sections ticked for them.
// The role is re-read from the user row (cached 1 min), so deactivating or
// demoting someone takes effect at once. Super-admin-only sub-routes still
// enforce SUPER_ADMIN inside. Service-token calls carry no user and keep their role.
adminRoutes.use("*", async (c, next) => {
  const userId = c.get("userId");
  if (userId) {
    const u = await loadAdminUser(c.env, c.get("db"), userId);
    if (!u || !u.isActive) throw new HTTPException(401, { message: "Your admin access has been removed. Please sign in again." });
    c.set("userRole", u.role);
    if (u.role === "STAFF" && !staffCanOpen(c.req.path, u.permissions)) {
      throw new HTTPException(403, { message: "You don't have access to this section. Ask an admin to add it for you." });
    }
  }
  const role = c.get("userRole");
  if (!(ADMIN_ROLES as readonly string[]).includes(role ?? "")) {
    throw new HTTPException(403, { message: "Admin access required" });
  }
  return next();
});

adminRoutes.route("/me",        adminMeRoutes);
adminRoutes.route("/users",     adminUsersRoutes);

adminRoutes.route("/tenants",   tenantsAdminRoutes);
adminRoutes.route("/bookings",  bookingsAdminRoutes);
adminRoutes.route("/suppliers", suppliersAdminRoutes);
adminRoutes.route("/agents",    agentsAdminRoutes);
adminRoutes.route("/agent-program", agentProgramAdminRoutes);
adminRoutes.route("/leadvyne-agents", leadvyneAgentsAdminRoutes);
adminRoutes.route("/finance",   financeAdminRoutes);
adminRoutes.route("/settings",      settingsAdminRoutes);
adminRoutes.route("/integrations",  integrationsAdminRoutes);
adminRoutes.route("/hotels",        hotelsAdminRoutes);
adminRoutes.route("/tripsafe",      tripsafeAdminRoutes);
adminRoutes.route("/api-keys",       apiKeysAdminRoutes);
adminRoutes.route("/markup",         markupAdminRoutes);
adminRoutes.route("/supplier-logs",  supplierLogsAdminRoutes);
adminRoutes.route("/customer-wallets", customerWalletsAdminRoutes);
adminRoutes.route("/cancellations", cancellationsAdminRoutes);
adminRoutes.route("/support-requests", supportAdminRoutes);

// Platform-level dashboard stats (SUPER_ADMIN only)
adminRoutes.get("/dashboard", async (c) => {
  requireRole("SUPER_ADMIN")(c.get("userRole"));

  const db = c.get("db");
  const { bookings, tenants, agents } = await import("@poomas/db/schema");
  const { count, sql } = await import("drizzle-orm");

  const [bookingCount] = await db.select({ count: count() }).from(bookings);
  const [tenantCount]  = await db.select({ count: count() }).from(tenants);
  const [agentCount]   = await db.select({ count: count() }).from(agents);

  return c.json({
    bookings: bookingCount.count,
    tenants:  tenantCount.count,
    agents:   agentCount.count,
  });
});
