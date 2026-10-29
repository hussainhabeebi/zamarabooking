import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { bookings, payments } from "@zamrabooking/db/schema";
import type { Env, Variables } from "../../types.js";
import { claimCheckoutGateway, PhonePeDbStore } from "./store.js";
import { PhonePeService } from "./service.js";
import {
  phonePeClient,
  phonePeReadiness,
  phonePeReturnOrigin,
} from "./config.js";
import { PhonePeError } from "./client.js";
import { signToken } from "../../routes/checkout.js";
export type PhonePeContext = Context<{ Bindings: Env; Variables: Variables }>;
export async function phonePeService(c: PhonePeContext, reconcile = false) {
  const tenantId = c.get("tenantId");
  const r = await phonePeReadiness(c.env, tenantId);
  return new PhonePeService(
    new PhonePeDbStore(c.get("db")),
    await phonePeClient(c.env, tenantId, reconcile),
    tenantId,
    r.environment,
  );
}
export async function ownedBooking(c: PhonePeContext, id: string) {
  const [b] = await c
    .get("db")
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, id), eq(bookings.tenantId, c.get("tenantId"))))
    .limit(1);
  if (!b) throw new PhonePeError("BOOKING_NOT_FOUND");
  const role = c.get("userRole");
  if (
    !(role === "CHECKOUT"
      ? c.get("checkoutBookingId") === id
      : ["TENANT_ADMIN", "SUPER_ADMIN"].includes(role ?? "") ||
        (c.get("userId") && b.userId === c.get("userId")) ||
        (c.get("agentId") && b.agentId === c.get("agentId")))
  )
    throw new PhonePeError("BOOKING_FORBIDDEN");
  return b;
}
export async function phonePeCheckout(
  c: PhonePeContext,
  bookingId: string,
  currency?: string,
) {
  const service = await phonePeService(c); // Gate before any new-schema access or provider request.
  const b = await ownedBooking(c, bookingId);
  if (b.supplier === "AKBAR") throw new PhonePeError("AKBAR_BOOKING_DISABLED");
  if (
    !["PAYMENT_PENDING", "HELD"].includes(b.status) ||
    (b.heldUntil && b.heldUntil.getTime() <= Date.now())
  )
    throw new PhonePeError("BOOKING_NOT_PAYABLE");
  if ((currency && currency !== b.currency) || b.currency !== "INR")
    throw new PhonePeError("INR_REQUIRED");
  const others = await c
    .get("db")
    .select()
    .from(payments)
    .where(eq(payments.bookingId, bookingId));
  if (
    others.some(
      (p) =>
        p.gateway !== "PHONEPE" &&
        ["PENDING", "SUCCESS", "REFUNDED", "PARTIAL_REFUND"].includes(p.status),
    )
  )
    throw new PhonePeError("OTHER_PAYMENT_EXISTS");
  await claimCheckoutGateway(
    c.get("db"),
    c.get("tenantId"),
    bookingId,
    "PHONEPE",
  );
  const now = Math.floor(Date.now() / 1000);
  const token = await signToken(
    { sub: bookingId, tenantId: b.tenantId, iat: now, exp: now + 7200 },
    c.env.JWT_SECRET,
  );
  const origin = phonePeReturnOrigin(c.env);
  if (!origin) throw new PhonePeError("RETURN_ORIGIN_REQUIRED");
  const url = `${origin}/checkout/payment-result?bookingId=${encodeURIComponent(bookingId)}&token=${encodeURIComponent(token)}&gateway=PHONEPE`;
  return service.checkout(b, url);
}
