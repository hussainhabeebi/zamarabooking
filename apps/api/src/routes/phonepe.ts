import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { Env, Variables } from "../types.js";
import { ownedBooking, phonePeService } from "../lib/phonepe/http.js";
import { PhonePeError } from "../lib/phonepe/client.js";
import { digest } from "../lib/phonepe/client.js";
export const phonePeRoutes = new Hono<{
  Bindings: Env;
  Variables: Variables;
}>();
phonePeRoutes.onError((e, c) =>
  c.json(
    {
      error:
        e instanceof PhonePeError ? e.message : "PhonePe operation unavailable",
    },
    503,
  ),
);
phonePeRoutes.post(
  "/reconcile",
  zValidator(
    "json",
    z.object({ bookingId: z.string().min(1).max(100) }).strict(),
  ),
  async (c) => {
    const b = await ownedBooking(c, c.req.valid("json").bookingId);
    const service = await phonePeService(c, true);
    const id = `ZP${(await digest(`${c.get("tenantId")}\0${b.id}`)).slice(0, 40)}`;
    return c.json(await service.reconcile(id));
  },
);
