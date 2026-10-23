import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env, Variables } from "../../types.js";
import { akbarAdminStatus, saveAkbarPriority } from "../../lib/akbar-admin.js";

export const akbarAdminRoutes = new Hono<{
  Bindings: Env;
  Variables: Variables;
}>();
akbarAdminRoutes.use("*", async (c, next) => {
  if (!["TENANT_ADMIN", "SUPER_ADMIN"].includes(c.get("userRole") ?? ""))
    throw new HTTPException(403, {
      message: "Full admin access required for Akbar configuration.",
    });
  await next();
});
akbarAdminRoutes.get("/", async (c) =>
  c.json(await akbarAdminStatus(c.env, c.get("tenantId"))),
);
akbarAdminRoutes.post(
  "/",
  zValidator(
    "json",
    z.object({ priority: z.number().int().min(1).max(1000) }).strict(),
  ),
  async (c) => {
    await saveAkbarPriority(
      c.env,
      c.get("tenantId"),
      c.req.valid("json").priority,
    );
    return c.json({ ok: true });
  },
);
// Read-only readiness. Deliberately no /test route, fetch, gateway calls or health claims.
