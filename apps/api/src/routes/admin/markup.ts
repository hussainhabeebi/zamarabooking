// GET    /api/admin/markup        — list markup rules + agents/sub-agents they can be allocated to
// POST   /api/admin/markup        — create a markup rule
// PUT    /api/admin/markup/:id    — edit a markup rule
// DELETE /api/admin/markup/:id    — delete a markup rule
//
// agentId null = tenant-wide default. Set to an agent or sub-agent to allocate markup to them;
// a matching agent rule wins over the defaults (see lib/markup.ts). Sub-agents also pay any
// markup their parent agent sets in the portal (lib/agent-markup.ts).

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { agents, markupRules } from "@poomas/db/schema";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Env, Variables } from "../../types.js";

export const markupAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const optionalCode = z.string().trim().toUpperCase().transform((v) => v || null).nullable().optional();

const ruleSchema = z.object({
  name:        z.string().trim().min(1).max(120),
  agentId:     z.string().nullable().optional(),
  markupType:  z.enum(["FLAT", "PERCENTAGE"]),
  markupValue: z.number().min(0).max(1_000_000),
  airline:     optionalCode,
  origin:      optionalCode,
  destination: optionalCode,
  cabinClass:  z.enum(["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"]).nullable().optional(),
  supplier:    z.enum(["RIYA", "TRIPJACK", "GOOGLE_SERP", "DUFFEL"]).nullable().optional(),
  validFrom:   z.string().datetime({ offset: true }).nullable().optional(),
  validTo:     z.string().datetime({ offset: true }).nullable().optional(),
  isActive:    z.boolean().default(true),
  priority:    z.number().int().min(0).max(1000).default(0),
}).refine((r) => r.markupType !== "PERCENTAGE" || r.markupValue <= 100, {
  message: "Percentage markup cannot exceed 100", path: ["markupValue"],
});

type RuleInput = z.infer<typeof ruleSchema>;

async function assertAgentInTenant(db: Variables["db"], tenantId: string, agentId: string | null | undefined) {
  if (!agentId) return;
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new HTTPException(400, { message: "Agent not found in this tenant" });
}

function toRow(body: RuleInput) {
  return {
    name:        body.name,
    agentId:     body.agentId || null,
    markupType:  body.markupType,
    markupValue: String(body.markupValue),
    airline:     body.airline ?? null,
    origin:      body.origin ?? null,
    destination: body.destination ?? null,
    cabinClass:  body.cabinClass ?? null,
    supplier:    body.supplier ?? null,
    validFrom:   body.validFrom ? new Date(body.validFrom) : null,
    validTo:     body.validTo   ? new Date(body.validTo)   : null,
    isActive:    body.isActive,
    priority:    body.priority,
  };
}

markupAdminRoutes.get("/", async (c) => {
  const db       = c.get("db");
  const tenantId = c.get("tenantId");

  const [rules, agentRows] = await Promise.all([
    db.select().from(markupRules)
      .where(eq(markupRules.tenantId, tenantId))
      .orderBy(desc(markupRules.priority), asc(markupRules.createdAt)),
    db.select({
      id:            agents.id,
      businessName:  agents.businessName,
      parentAgentId: agents.parentAgentId,
      status:        agents.status,
    })
      .from(agents)
      .where(eq(agents.tenantId, tenantId))
      .orderBy(asc(agents.businessName)),
  ]);

  return c.json({ rules, agents: agentRows });
});

markupAdminRoutes.post("/", zValidator("json", ruleSchema), async (c) => {
  const db       = c.get("db");
  const tenantId = c.get("tenantId");
  const body     = c.req.valid("json");

  await assertAgentInTenant(db, tenantId, body.agentId);
  const [rule] = await db.insert(markupRules).values({ tenantId, ...toRow(body) }).returning();
  return c.json({ rule }, 201);
});

markupAdminRoutes.put("/:id", zValidator("json", ruleSchema), async (c) => {
  const db       = c.get("db");
  const tenantId = c.get("tenantId");
  const body     = c.req.valid("json");

  await assertAgentInTenant(db, tenantId, body.agentId);
  const [rule] = await db.update(markupRules)
    .set({ ...toRow(body), updatedAt: new Date() })
    .where(and(eq(markupRules.id, c.req.param("id")), eq(markupRules.tenantId, tenantId)))
    .returning();
  if (!rule) throw new HTTPException(404, { message: "Markup rule not found" });
  return c.json({ rule });
});

markupAdminRoutes.delete("/:id", async (c) => {
  const db       = c.get("db");
  const tenantId = c.get("tenantId");

  const [rule] = await db.delete(markupRules)
    .where(and(eq(markupRules.id, c.req.param("id")), eq(markupRules.tenantId, tenantId)))
    .returning({ id: markupRules.id });
  if (!rule) throw new HTTPException(404, { message: "Markup rule not found" });
  return c.json({ ok: true });
});
