// CF Queue consumer — processes BOOKING_QUEUE and NOTIFY_QUEUE messages
// Handles: INITIATE_PAYMENT, PAYMENT_CAPTURED, NOTIFY_BOOKING_CONFIRMATION

import { emailBookingFailed } from "./lib/transactional-emails.js";
import type { Env } from "./types.js";
import { createDb } from "@poomas/db";
import {
  bookings, bookingPassengers, payments, walletAccounts, walletTransactions,
  tenants, tenantSupplierConfigs, leadvyneConfigs,
} from "@poomas/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { getBookableAdapter, TripjackClient } from "@poomas/suppliers";
import { normalizeBookingResponse } from "./lib/booking-response.js";
import { resolveFlightSuppliers } from "./routes/search.js";
import {
  acquireBookingLock, errorDetail, explainMissingPnr, isTestBooking, logBookingEvent, recordBookingError, recordQueueReceipt, releaseBookingLock,
} from "./lib/booking-recovery.js";
import { createRazorpayOrder, createNomodCheckout, createRefundRazorpay, RAZORPAY_ENABLED, refundNomodCharge, resolveNomodApiKey } from "./lib/payment-gateway.js";
import { creditBookingBonus, creditWallet } from "./lib/customer-wallet.js";
import { rewardReferral } from "./lib/referral.js";
import { agentWallet, creditAgentWallet, settleAgentBooking } from "./lib/agent-program.js";
import { collectExchanges, persistExchanges } from "./lib/api-exchanges.js";
import { renderETicketHtml, storeETicket } from "./lib/eticket.js";
import { renderItineraryHtml } from "./lib/itinerary.js";
import { parseBookingDetails } from "./lib/trips.js";
import { sendWhatsApp, buildBookingConfirmationMessage } from "./lib/notify.js";
import { emailLayout, sendMail } from "./lib/email.js";
import { escapeHtml, WEB_URL } from "./lib/customer-notify.js";

// ── Message type discriminated union ─────────────────────────────

interface InitiatePaymentMsg {
  type:      "INITIATE_PAYMENT";
  bookingId: string;
  tenantId:  string;
  method:    "GATEWAY" | "WALLET";
  agentId?:  string;
}

export interface PaymentCapturedMsg {
  type:             "PAYMENT_CAPTURED";
  gatewayPaymentId: string;
  orderId:          string;
  amount:           number;
}

interface NotifyBookingMsg {
  type:       "NOTIFY_BOOKING_CONFIRMATION";
  bookingId:  string;
  tenantId:   string;
  eticketKey: string;
}

interface NotifyOtpMsg {
  type:     "NOTIFY_OTP";
  phone:    string;
  otp:      string;
  tenantId: string;
}

type BookingQueueMsg   = InitiatePaymentMsg | PaymentCapturedMsg;
type NotifyQueueMsg    = NotifyBookingMsg | NotifyOtpMsg;

// ── Booking Queue consumer ────────────────────────────────────────

// Same connection as the HTTP API (tenant middleware). The Neon HTTP driver
// cannot use the Hyperdrive connection string: its host only resolves over
// Hyperdrive's TCP socket, so HTTP queries fail with 530 / error 1016 and paid
// bookings never reached TripJack.
function queueDb(env: Env) {
  return createDb(env.DATABASE_URL);
}

// Matches max_retries = 3 on the poomas-bookings consumer (1 try + 3 retries).
const BOOKING_MAX_ATTEMPTS = 4;

export async function handleBookingQueue(
  batch: MessageBatch<BookingQueueMsg>,
  env: Env,
): Promise<void> {
  const db = queueDb(env);

  for (const msg of batch.messages) {
    try {
      const data = msg.body;

      if (data.type === "INITIATE_PAYMENT") {
        await handleInitiatePayment(db, env, data);
      } else if (data.type === "PAYMENT_CAPTURED") {
        await recordQueueReceipt(env, data.orderId, msg.attempts);
        try {
          await handlePaymentCaptured(db, env, data, msg.attempts, msg.attempts >= BOOKING_MAX_ATTEMPTS);
        } catch (err) {
          await recordQueueReceipt(env, data.orderId, msg.attempts, err);
          throw err;
        }
      }

      msg.ack();
    } catch (err) {
      console.error(`[BookingQueue] Failed to process msg ${msg.id}:`, err);
      msg.retry();
    }
  }
}

// ── INITIATE_PAYMENT ─────────────────────────────────────────────

async function handleInitiatePayment(
  db: ReturnType<typeof createDb>,
  env: Env,
  data: InitiatePaymentMsg,
): Promise<void> {
  const [booking] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, data.bookingId), eq(bookings.tenantId, data.tenantId)))
    .limit(1);

  if (!booking) {
    throw new Error(`Booking ${data.bookingId} not found`);
  }

  if (booking.status !== "HELD") {
    console.warn(`Booking ${data.bookingId} is ${booking.status}, skipping payment initiation`);
    return;
  }

  const total   = Number(booking.totalAmount);
  const currency = booking.currency;

  if (data.method === "WALLET" && data.agentId) {
    // Deduct from agent wallet
    const [wallet] = await db
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.agentId, data.agentId))
      .limit(1);

    if (!wallet) throw new Error("Wallet not found for agent");

    const available = Number(wallet.balance) + Number(wallet.creditLimit ?? 0);
    if (available < total) {
      await db.update(bookings)
        .set({ status: "PAYMENT_FAILED", updatedAt: new Date() })
        .where(eq(bookings.id, data.bookingId));
      throw new Error("Insufficient wallet balance");
    }

    // Deduct wallet and record transaction
    await db.update(walletAccounts)
      .set({ balance: String(Number(wallet.balance) - total), updatedAt: new Date() })
      .where(eq(walletAccounts.id, wallet.id));

    await db.insert(walletTransactions).values({
      walletAccountId: wallet.id,
      type:            "BOOKING_DEBIT",
      amount:          String(total),
      balanceBefore:   String(wallet.balance),
      balanceAfter:    String(Number(wallet.balance) - total),
      bookingId:       data.bookingId,
      note:            `Payment for booking ${data.bookingId}`,
      performedById:   data.agentId,
    });

    // Insert a WALLET payment record and mark booking PAYMENT_PENDING (confirm below)
    await db.insert(payments).values({
      bookingId:       data.bookingId,
      gateway:         "WALLET",
      amount:          String(total),
      currency:        currency,
      status:          "SUCCESS",
      gatewayPaymentId: `wallet_${data.bookingId}`,
    });

    await db.update(bookings)
      .set({ status: "PAYMENT_PENDING", updatedAt: new Date() })
      .where(eq(bookings.id, data.bookingId));

    // Trigger booking confirmation immediately for wallet payments
    await env.BOOKING_QUEUE.send({
      type:             "PAYMENT_CAPTURED",
      gatewayPaymentId: `wallet_${data.bookingId}`,
      orderId:          `wallet_${data.bookingId}`,
      amount:           total,
    });

    return;
  }

  // Gateway payment — get tenant payment config
  const [tenant] = await db
    .select({
      paymentConfig: tenants.paymentConfig,
      slug:          tenants.slug,
    })
    .from(tenants)
    .where(eq(tenants.id, data.tenantId))
    .limit(1);

  if (!tenant) throw new Error(`Tenant ${data.tenantId} not found`);

  const paymentConfig = tenant.paymentConfig as {
    razorpay?: { keyId: string; keySecret: string };
    nomod?:    { apiKey: string; apiSecret: string };
  } | null;

  // Fall back to platform-level credentials if tenant hasn't set own
  const useRazorpay = RAZORPAY_ENABLED && currency === "INR";
  let gatewayResult;

  if (useRazorpay) {
    const keyId     = paymentConfig?.razorpay?.keyId     ?? env.RAZORPAY_KEY_ID;
    const keySecret = paymentConfig?.razorpay?.keySecret ?? env.RAZORPAY_KEY_SECRET;

    gatewayResult = await createRazorpayOrder(
      { keyId, keySecret },
      {
        amount:   total,
        currency: "INR",
        receipt:  `bk_${data.bookingId.slice(0, 20)}`,
        notes:    { bookingId: data.bookingId, tenantId: data.tenantId },
      },
    );
  } else {
    const apiKey    = paymentConfig?.nomod?.apiKey    ?? env.NOMOD_API_KEY;
    const apiSecret = paymentConfig?.nomod?.apiSecret ?? env.NOMOD_API_SECRET;

    gatewayResult = await createNomodCheckout(
      { apiKey, apiSecret },
      {
        amount:      total,
        currency:    currency,
        reference:   data.bookingId,
        redirectUrl: `https://${tenant.slug}.flypoomas.com/booking/${data.bookingId}/confirm`,
        description: `Flight booking ${data.bookingId}`,
      },
    );
  }

  // Store payment record
  await db.insert(payments).values({
    bookingId:      data.bookingId,
    gateway:        gatewayResult.gateway,
    gatewayOrderId: gatewayResult.orderId,
    amount:         String(total),
    currency:       currency,
    status:         "PENDING",
  });

  // Update booking to PAYMENT_PENDING
  await db.update(bookings)
    .set({ status: "PAYMENT_PENDING", updatedAt: new Date() })
    .where(eq(bookings.id, data.bookingId));

  // Store payment URL in KV for frontend to poll (60 min TTL)
  await env.SESSIONS_KV.put(
    `pay_url:${data.bookingId}`,
    JSON.stringify(gatewayResult),
    { expirationTtl: 3600 },
  );
}

// ── AUTO-REFUND ───────────────────────────────────────────────────

// Refund a customer wallet payment. The payment row is flipped SUCCESS → REFUNDED
// atomically first, so a retried queue message can't refund twice. Agent wallet
// payments (no customer debit on record) are left unchanged.
async function refundCustomerWalletPayment(db: ReturnType<typeof createDb>, bookingId: string): Promise<void> {
  const [debit] = await db
    .select({ walletAccountId: walletTransactions.walletAccountId, amount: walletTransactions.amount })
    .from(walletTransactions)
    .innerJoin(walletAccounts, eq(walletAccounts.id, walletTransactions.walletAccountId))
    .where(and(
      eq(walletTransactions.bookingId, bookingId),
      eq(walletTransactions.type, "BOOKING_DEBIT"),
      sql`${walletAccounts.userId} IS NOT NULL`,
    ))
    .limit(1);
  if (!debit) return;

  const [claimed] = await db.update(payments)
    .set({ status: "REFUNDED", refundCompletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(payments.bookingId, bookingId), eq(payments.gateway, "WALLET"), eq(payments.status, "SUCCESS")))
    .returning({ id: payments.id });
  if (!claimed) return;

  try {
    await creditWallet(db, debit.walletAccountId, Number(debit.amount), "REFUND_CREDIT", {
      bookingId, note: `Refund: booking ${bookingId.slice(0, 8)} could not be ticketed`,
    });
    console.info(`[autoRefund] wallet refund issued for booking ${bookingId}`);
  } catch (err) {
    console.error(`[autoRefund] wallet refund failed for booking ${bookingId}:`, err);
  }
}

// Refunds a failed agency booking to the agency wallet, once (claims the payment first).
async function refundAgentWalletPayment(db: ReturnType<typeof createDb>, bookingId: string): Promise<void> {
  const [claimed] = await db.update(payments)
    .set({ status: "REFUNDED", refundCompletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(payments.bookingId, bookingId), eq(payments.gateway, "WALLET"), eq(payments.status, "SUCCESS"), sql`${payments.gatewayPaymentId} LIKE 'agentwallet_%'`))
    .returning({ amount: payments.amount });
  if (!claimed) return;
  const [bk] = await db.select({ agentId: bookings.agentId, tenantId: bookings.tenantId }).from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  if (!bk?.agentId) return;
  try {
    const wallet = await agentWallet(db, bk.tenantId, bk.agentId);
    if (wallet) await creditAgentWallet(db, wallet.id, Number(claimed.amount), "REFUND_CREDIT", {
      bookingId, note: `Refund: booking ${bookingId.slice(0, 8)} could not be ticketed`,
    });
    console.info(`[autoRefund] agency wallet refund issued for booking ${bookingId}`);
  } catch (err) {
    console.error(`[autoRefund] agency wallet refund failed for booking ${bookingId}:`, err);
  }
}

async function triggerAutoRefund(
  db: ReturnType<typeof createDb>,
  env: Env,
  bookingId: string,
  gatewayPaymentId: string,
  amount: number,
): Promise<void> {
  // Agency wallet payments (agent portal) go back to the agency wallet.
  if (gatewayPaymentId.startsWith("agentwallet_")) {
    await refundAgentWalletPayment(db, bookingId);
    return;
  }
  // Customer wallet payments go back to the customer's wallet.
  if (gatewayPaymentId.startsWith("wallet_")) {
    await refundCustomerWalletPayment(db, bookingId);
    return;
  }

  const [payment] = await db
    .select({ gateway: payments.gateway, gatewayOrderId: payments.gatewayOrderId, amount: payments.amount, currency: payments.currency })
    .from(payments)
    .where(eq(payments.bookingId, bookingId))
    .limit(1);

  if (!payment) {
    console.warn(`[autoRefund] No payment record for booking ${bookingId}`);
    return;
  }

  try {
    if (payment.gateway === "RAZORPAY") {
      const keyId     = env.RAZORPAY_KEY_ID;
      const keySecret = env.RAZORPAY_KEY_SECRET;
      if (!keyId || !keySecret) {
        console.error("[autoRefund] Razorpay credentials not configured");
        return;
      }
      const { refundId } = await createRefundRazorpay(
        { keyId, keySecret },
        { paymentId: gatewayPaymentId, amount, notes: { bookingId, reason: "booking_failed" } },
      );
      await db.update(payments).set({
        status:    "REFUNDED",
        updatedAt: new Date(),
      }).where(eq(payments.bookingId, bookingId));
      console.info(`[autoRefund] Razorpay refund ${refundId} issued for booking ${bookingId}`);
    } else if (payment.gateway === "NOMOD") {
      const [bk] = await db.select({ tenantId: bookings.tenantId }).from(bookings).where(eq(bookings.id, bookingId)).limit(1);
      const apiKey = bk ? await resolveNomodApiKey(env, bk.tenantId) : env.NOMOD_API_KEY;
      if (!apiKey) {
        console.error("[autoRefund] Nomod API key not configured; refund manually from the Nomod dashboard");
        return;
      }
      // Refund the full charge in the currency it was taken in (may be AED).
      const chargeAmount = Number(payment.amount);
      const outcome = await refundNomodCharge(apiKey, gatewayPaymentId, chargeAmount, "Booking could not be ticketed");
      if (!outcome.ok) {
        console.error(`[autoRefund] Nomod refund for booking ${bookingId} not confirmed: ${outcome.error}`);
        return;
      }
      await db.update(payments).set({
        status:           "REFUNDED",
        refundedAmount:   chargeAmount.toFixed(2),
        refundGatewayRef: `nomod:${outcome.refundId}`,
        refundCompletedAt: new Date(),
        updatedAt:        new Date(),
      }).where(eq(payments.bookingId, bookingId));
      console.info(`[autoRefund] Nomod refund ${outcome.refundId} issued for booking ${bookingId}`);
    }
  } catch (refundErr) {
    // Refund failure must never swallow the original booking failure — log and continue
    console.error(`[autoRefund] Refund attempt failed for booking ${bookingId}:`, refundErr);
  }
}

// ── PAYMENT_CAPTURED ──────────────────────────────────────────────

// Books a paid booking with the supplier. Used by the queue and, directly, by the
// Admin retry and the stalled-booking recovery on the customer's confirmation page.
export async function processPaidBooking(env: Env, data: PaymentCapturedMsg, attempt = 1): Promise<void> {
  const db = queueDb(env);
  await handlePaymentCaptured(db, env, data, attempt, false);
}

async function handlePaymentCaptured(
  db: ReturnType<typeof createDb>,
  env: Env,
  data: PaymentCapturedMsg,
  attempt = 1,
  finalAttempt = false,
): Promise<void> {
  // Find the booking from the payment record
  const [payment] = await db
    .select({ bookingId: payments.bookingId })
    .from(payments)
    .where(eq(payments.gatewayOrderId, data.orderId))
    .limit(1);

  if (!payment) {
    throw new Error(`Payment for order ${data.orderId} not found`);
  }

  const [booking] = await db
    .select()
    .from(bookings)
    .where(eq(bookings.id, payment.bookingId))
    .limit(1);

  if (!booking) throw new Error(`Booking ${payment.bookingId} not found`);

  if (booking.status === "TICKETED" || booking.status === "CONFIRMED") {
    console.warn(`Booking ${booking.id} already confirmed, skipping`);
    return;
  }
  if (booking.status !== "PAYMENT_PENDING" && booking.status !== "HELD") {
    console.warn(`Booking ${booking.id} is ${booking.status}, not booking with the supplier`);
    return;
  }

  // One supplier booking at a time per booking (queue retry + automatic re-send).
  if (!(await acquireBookingLock(env, booking.id))) {
    await logBookingEvent(env, booking.id, "QUEUE", "warn", "Skipped: another run is already booking this seat with the supplier");
    return;
  }
  try {
    await logBookingEvent(env, booking.id, "QUEUE", "info",
      `Payment confirmed — starting ${booking.supplier} booking (attempt ${attempt}${finalAttempt ? ", final" : ""})`,
      { orderId: data.orderId, gatewayPaymentId: data.gatewayPaymentId, amount: data.amount });
    await bookPaidBooking(db, env, data, booking, finalAttempt);
  } catch (err) {
    await recordBookingError(env, booking.id, err, attempt);
    await logBookingEvent(env, booking.id, "QUEUE", "error",
      `Attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`, errorDetail(err));
    throw err;
  } finally {
    await releaseBookingLock(env, booking.id);
  }
}

async function bookPaidBooking(
  db: ReturnType<typeof createDb>,
  env: Env,
  data: PaymentCapturedMsg,
  booking: typeof bookings.$inferSelect,
  finalAttempt: boolean,
): Promise<void> {

  // Resolve suppliers exactly like search / checkout: the tenant DB rows plus the
  // Admin-saved TripJack integration (key + toggle) and Worker secrets. Using the
  // DB rows alone left TripJack "not available" here whenever it was configured
  // from Admin or env only, so paid bookings never reached the airline.
  const supplierRows = await db
    .select()
    .from(tenantSupplierConfigs)
    .where(eq(tenantSupplierConfigs.tenantId, booking.tenantId));

  const { platformCredentials, supplierConfigs } = await resolveFlightSuppliers(
    env,
    { supplierConfigs: supplierRows.map((s) => ({
      supplier:    s.supplier,
      isEnabled:   s.isEnabled,
      priority:    s.priority,
      credentials: s.credentials as Record<string, string> | null,
      timeoutMs:   s.timeoutMs,
      maxRetries:  s.maxRetries,
    })) } as unknown as Parameters<typeof resolveFlightSuppliers>[1],
    booking.tenantId,
  );

  // Raw TripJack exchanges (review / book / booking-details) for certification logs.
  const collector = collectExchanges();
  const flightMeta = (booking.flightData ?? {}) as Record<string, unknown>;
  const saveLogs = () => persistExchanges(env, db, booking.tenantId, collector.exchanges.splice(0), {
    bookingId: booking.id, searchId: typeof flightMeta.searchId === "string" ? flightMeta.searchId : null,
  });
  for (const cfg of supplierConfigs) {
    if (cfg.name === "TRIPJACK") cfg.credentials = { ...(cfg.credentials ?? {}), recorder: collector.recorder } as any;
  }
  if (platformCredentials.TRIPJACK) {
    platformCredentials.TRIPJACK = { ...platformCredentials.TRIPJACK, recorder: collector.recorder } as any;
  }

  // Load passengers
  const paxRows = await db
    .select()
    .from(bookingPassengers)
    .where(eq(bookingPassengers.bookingId, booking.id));

  // Before the airline is called, a failure is safe to retry. On the last attempt
  // stop the traveller waiting forever: fail the booking and refund the payment.
  const failBeforeBooking = async (err: unknown) => {
    if (!finalAttempt) throw err;
    console.error(`[booking] ${booking.id} could not reach the supplier after ${BOOKING_MAX_ATTEMPTS} attempts:`, err);
    await logBookingEvent(env, booking.id, "REFUND", "error",
      `Gave up after ${BOOKING_MAX_ATTEMPTS} attempts without reaching the airline — booking failed, payment refund started`, errorDetail(err));
    await db.update(bookings)
      .set({ status: "PAYMENT_FAILED", updatedAt: new Date() })
      .where(eq(bookings.id, booking.id));
    await triggerAutoRefund(db, env, booking.id, data.gatewayPaymentId, Number(booking.totalAmount));
    await emailBookingFailed(env, db, booking.id, data.gatewayPaymentId).catch((e) => console.error("[email] booking failed", e));
    throw err;
  };

  // Call supplier book()
  let adapter: ReturnType<typeof getBookableAdapter>;
  try {
    adapter = getBookableAdapter(booking.supplier as "RIYA" | "TRIPJACK", supplierConfigs, platformCredentials);
  } catch (err) {
    await logBookingEvent(env, booking.id, "SUPPLIER_CONFIG", "error",
      `${booking.supplier} is not configured/enabled for this tenant — check Admin → Integrations and API secrets`, errorDetail(err));
    return failBeforeBooking(err);
  }

  if (!adapter.book) {
    throw new Error(`${booking.supplier} adapter does not implement book()`);
  }

  const flightData = booking.flightData as Record<string, unknown>;

  // TripJack requires a review step before booking to obtain a booking session ID.
  // The review step may have been skipped during reservation creation (partner/checkout
  // flows). If supplierBookingRef is not set, call review now to get the session ID.
  let tripjackHoldId = booking.supplierBookingRef ?? "";
  if (booking.supplier === "TRIPJACK" && !tripjackHoldId) {
    const fareId = (flightData.id as string) ?? booking.supplierSessionId ?? "";
    if (!fareId) return failBeforeBooking(new Error(`TripJack booking ${booking.id}: no fare ID to review`));
    if (!adapter.revalidate) throw new Error("TripJack adapter missing revalidate");
    let reviewed;
    try { reviewed = await adapter.revalidate(fareId); } catch (err) {
      await saveLogs();
      await logBookingEvent(env, booking.id, "REVIEW", "error",
        "TripJack fare review failed — the fare may have expired or changed since search", { fareId, ...errorDetail(err) });
      return failBeforeBooking(err);
    }
    await logBookingEvent(env, booking.id, "REVIEW", "info", `Fare reviewed — TripJack booking ID ${reviewed.bookingId}`, { totalFare: reviewed.totalFare });
    tripjackHoldId = reviewed.bookingId;
    // Persist so retries don't call review again
    await db.update(bookings)
      .set({ supplierBookingRef: tripjackHoldId, updatedAt: new Date() })
      .where(eq(bookings.id, booking.id));
  }

  const paymentAmount = Math.round((Number(booking.totalAmount) - Number(booking.markup ?? 0)) * 100) / 100;
  // Checkout extras saved with the booking (GST, emergency contact, PAN, student /
  // senior ID, passport issue date, meal / baggage SSR) — matched to passengers by name.
  const tjExtras = ((flightData.tripjack ?? {}) as {
    held?: boolean;
    gstInfo?: { gstNumber: string; registeredName: string; email?: string; mobile?: string; address?: string };
    emergencyContact?: { name: string; phone?: string; email?: string };
    pax?: { type: string; firstName: string; lastName: string; passportIssueDate?: string; panNumber?: string; documentId?: string; ssr?: any }[];
  });
  const paxExtras = [...(tjExtras.pax ?? [])];
  const extrasFor = (p: { passengerType: string; firstName: string; lastName: string }) => {
    const i = paxExtras.findIndex((x) => x.type === p.passengerType
      && x.firstName.toLowerCase() === p.firstName.trim().toLowerCase() && x.lastName.toLowerCase() === p.lastName.trim().toLowerCase());
    return i >= 0 ? paxExtras.splice(i, 1)[0] : undefined;
  };
  await logBookingEvent(env, booking.id, "BOOK", "info", `Sending book request to ${booking.supplier}`, {
    supplierBookingId: tripjackHoldId || booking.supplierBookingRef, paymentAmount, passengers: paxRows.length,
  });
  // A held fare (hold now, pay later) is already booked ON_HOLD: pay it with
  // confirm-book instead of booking again.
  const heldRef = booking.supplier === "TRIPJACK" && (tjExtras as { held?: boolean }).held === true ? booking.supplierBookingRef : null;
  let bookResult;
  try {
    if (heldRef) {
      const tjConfig = supplierConfigs.find((s) => s.name === "TRIPJACK");
      const client = new TripjackClient({ ...(platformCredentials.TRIPJACK ?? {}), ...(tjConfig?.credentials ?? {}), recorder: collector.recorder } as ConstructorParameters<typeof TripjackClient>[0]);
      await logBookingEvent(env, booking.id, "BOOK", "info", `Confirming held booking ${heldRef} with TripJack (confirm-book)`, { paymentAmount });
      bookResult = normalizeBookingResponse(await client.confirmHold(heldRef, paymentAmount), heldRef) as Awaited<ReturnType<NonNullable<typeof adapter.book>>>;
    } else bookResult = await adapter.book({
      fareId:        flightData.id as string,
      holdId:        booking.supplier === "TRIPJACK" ? tripjackHoldId : (booking.supplierBookingRef ?? ""),
      sessionId:     booking.supplierSessionId ?? undefined,
      contactEmail:  booking.contactEmail ?? "",
      contactPhone:  booking.contactPhone ?? "",
      paymentRef:    data.gatewayPaymentId,
      // TripJack must be paid its reviewed net fare; totalAmount includes our markup.
      paymentAmount,
      ...(tjExtras.gstInfo ? { gstInfo: tjExtras.gstInfo } : {}),
      ...(tjExtras.emergencyContact ? { emergencyContact: tjExtras.emergencyContact } : {}),
      passengers: paxRows.map((p) => ({
        ...(() => {
          const x = extrasFor(p);
          return x ? {
            ...(x.passportIssueDate ? { passportIssueDate: x.passportIssueDate } : {}),
            ...(x.panNumber ? { panNumber: x.panNumber } : {}),
            ...(x.documentId ? { documentId: x.documentId } : {}),
            ...(x.ssr ? { ssr: x.ssr } : {}),
          } : {};
        })(),
        type:           p.passengerType as "ADULT" | "CHILD" | "INFANT",
        firstName:      p.firstName,
        lastName:       p.lastName,
        dob:            p.dob?.toISOString().slice(0, 10),
        gender:         p.gender ?? undefined,
        nationality:    p.nationality ?? undefined,
        passportNumber: p.passportNumber  ?? undefined,
        passportExpiry: p.passportExpiry?.toISOString().slice(0, 10),
        passportCountry: p.passportCountry ?? undefined,
      })),
    });
  } catch (err) {
    await saveLogs();
    console.error(`Supplier book() failed for booking ${booking.id}:`, err);
    await logBookingEvent(env, booking.id, "BOOK", "error",
      `${booking.supplier} rejected the book request — no PNR issued; payment refund started`, errorDetail(err));
    await db.update(bookings)
      .set({ status: "PAYMENT_FAILED", updatedAt: new Date() })
      .where(eq(bookings.id, booking.id));
    await triggerAutoRefund(db, env, booking.id, data.gatewayPaymentId, Number(booking.totalAmount));
    await emailBookingFailed(env, db, booking.id, data.gatewayPaymentId).catch((e) => console.error("[email] booking failed", e));
    throw err;
  }

  if (!bookResult.success) {
    await saveLogs();
    await logBookingEvent(env, booking.id, "BOOK", "error",
      `${booking.supplier} did not confirm the booking — no PNR issued; payment refund started`,
      { status: bookResult.status, bookingRef: bookResult.bookingRef, supplierResponse: JSON.stringify(bookResult.raw ?? {}).slice(0, 1500) });
    await db.update(bookings)
      .set({ status: "PAYMENT_FAILED", updatedAt: new Date() })
      .where(eq(bookings.id, booking.id));
    await triggerAutoRefund(db, env, booking.id, data.gatewayPaymentId, Number(booking.totalAmount));
    await emailBookingFailed(env, db, booking.id, data.gatewayPaymentId).catch((e) => console.error("[email] booking failed", e));
    throw new Error(`Supplier booking failed: ${JSON.stringify(bookResult)}`);
  }

  await logBookingEvent(env, booking.id, "BOOK", "info",
    `${booking.supplier} accepted the booking${bookResult.pnr ? ` — PNR ${bookResult.pnr}` : " — PNR not in the book response, checking booking details"}`,
    { bookingRef: bookResult.bookingRef, status: bookResult.status, ticketNumbers: bookResult.ticketNumbers });

  let lastDetailsRaw: unknown = null;
  let finalPnr = bookResult.pnr;
  let finalTickets = bookResult.ticketNumbers.filter(Boolean);
  let finalStatus: "CONFIRMED" | "TICKETED" = bookResult.status === "TICKETED" ? "TICKETED" : "CONFIRMED";
  await db.update(bookings).set({
    status:            finalStatus,
    pnr:               finalPnr || null,
    ticketNumbers:     finalTickets,
    supplierBookingRef: bookResult.bookingRef,
    updatedAt:         new Date(),
  }).where(eq(bookings.id, booking.id));

  // TripJack issues the PNR and ticket numbers asynchronously: read booking
  // details a few times and log why they are missing when they are.
  if (booking.supplier === "TRIPJACK" && bookResult.bookingRef && adapter.getPNRStatus) {
    const delays = [0, 4000, 8000, 12000];
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await new Promise((resolve) => setTimeout(resolve, delays[i]));
      try {
        const details = await adapter.getPNRStatus(bookResult.bookingRef);
        lastDetailsRaw = details.raw ?? lastDetailsRaw;
        const tickets = details.passengers.map((p) => p.ticketNumber);
        const allTicketed = tickets.length > 0 && tickets.every(Boolean);
        if (details.pnr) finalPnr = details.pnr;
        if (tickets.some(Boolean)) finalTickets = tickets;
        if (allTicketed) finalStatus = "TICKETED";
        const reason = explainMissingPnr(details);
        const testBooking = isTestBooking(details.pnr);
        await logBookingEvent(env, booking.id, finalPnr && allTicketed ? "TICKET" : "BOOKING_DETAILS",
          finalPnr && allTicketed ? "info" : testBooking ? "info" : i === delays.length - 1 ? "error" : "warn",
          `Booking details check ${i + 1}/${delays.length}: ${reason}`,
          { orderStatus: details.status, statusMessage: details.statusMessage, pnr: details.pnr || null,
            tickets: details.passengers.map((p) => ({ name: p.name, ticketNumber: p.ticketNumber || null })) });
        if ((finalPnr && allTicketed) || testBooking) break;
        if (["FAILED", "ABORTED", "CANCELLED"].includes(details.status.toUpperCase())) break;
      } catch (err) {
        await logBookingEvent(env, booking.id, "BOOKING_DETAILS", i === delays.length - 1 ? "error" : "warn",
          `Booking details check ${i + 1}/${delays.length} failed: ${err instanceof Error ? err.message : String(err)}`, errorDetail(err));
      }
    }
    await db.update(bookings).set({
      status: finalStatus, pnr: finalPnr || null, ticketNumbers: finalTickets, updatedAt: new Date(),
    }).where(eq(bookings.id, booking.id));
    if (!finalPnr) {
      await logBookingEvent(env, booking.id, "PNR", "error",
        "Booking accepted by TripJack but no PNR yet — use \"Fetch booking details from TripJack\" later, or contact TripJack support with the booking ID",
        { bookingRef: bookResult.bookingRef });
    } else if (finalStatus !== "TICKETED" && !isTestBooking(finalPnr)) {
      await logBookingEvent(env, booking.id, "TICKET", "warn",
        `PNR ${finalPnr} issued but ticket numbers are not issued yet — the airline/TripJack is still ticketing`,
        { bookingRef: bookResult.bookingRef });
    }
  }
  await saveLogs();

  // Update payment record with gateway payment id
  await db.update(payments).set({
    gatewayPaymentId: data.gatewayPaymentId,
    status:           "SUCCESS",
    updatedAt:        new Date(),
  }).where(eq(payments.gatewayOrderId, data.orderId));

  // ₹50 wallet bonus for signed-in customers, once per confirmed booking.
  // Never let a bonus problem fail (and retry) an already-ticketed booking.
  try {
    if (await creditBookingBonus(db, booking.id)) console.info(`[wallet-bonus] credited for booking ${booking.id}`);
  } catch (err) {
    console.error(`[wallet-bonus] booking ${booking.id}:`, err);
  }
  // Agency booking: pay parent agencies their markup and the agency its commission.
  try {
    await settleAgentBooking(env, db, booking);
  } catch (err) {
    console.error(`[agent-settle] booking ${booking.id}:`, err);
  }
  // Refer-a-friend reward on the referred customer's first confirmed booking.
  try {
    if (await rewardReferral(env, db, booking)) console.info(`[referral] rewarded for booking ${booking.id}`);
  } catch (err) {
    console.error(`[referral] booking ${booking.id}:`, err);
  }

  // Generate e-ticket HTML
  const [tenantRow] = await db
    .select({
      name:         tenants.name,
      slug:         tenants.slug,
      customDomain: tenants.customDomain,
      logoUrl:      tenants.logoUrl,
      primaryColor: tenants.primaryColor,
      supportEmail: tenants.supportEmail,
    })
    .from(tenants)
    .where(eq(tenants.id, booking.tenantId))
    .limit(1);

  // E-ticket from TripJack's own booking details (flights, PNR, ticket numbers).
  // flightData from checkout only holds the fare ID, so it cannot build a ticket.
  let eticketKey = `etickets/${booking.id}.html`;
  try {
    const itinerary = lastDetailsRaw ? parseBookingDetails(lastDetailsRaw) : null;
    let eticketHtml: string;
    if (itinerary?.segments.length) {
      if (!itinerary.travellers.length) {
        itinerary.travellers = paxRows.map((p, i) => ({ name: `${p.firstName} ${p.lastName}`, type: p.passengerType, ticketNumber: finalTickets[i] || undefined }));
      }
      eticketHtml = renderItineraryHtml({
        bookingId: booking.id, pnr: finalPnr || null, status: finalStatus, bookedAt: booking.createdAt,
        origin: booking.origin, destination: booking.destination, totalAmount: Number(booking.totalAmount), currency: booking.currency,
        contactEmail: booking.contactEmail, contactPhone: booking.contactPhone, itinerary, docType: "eticket",
      });
    } else {
      const fd = flightData as {
        airline: string; airlineName: string; flightNumber: string;
        origin: string; destination: string;
        departureTime: string; arrivalTime: string;
        cabinClass: string; isRefundable: boolean;
        baggage: { cabin: string; checked: string };
      };
      const departureTime = fd.departureTime ?? booking.departureDate.toISOString();
      eticketHtml = renderETicketHtml({
        bookingRef:    booking.id,
        pnr:           finalPnr,
        ticketNumbers: finalTickets,
        airline:       fd.airline ?? "",
        airlineName:   fd.airlineName ?? fd.airline ?? "",
        flightNumber:  fd.flightNumber ?? "",
        origin:        booking.origin,
        destination:   booking.destination,
        departureTime,
        arrivalTime:   fd.arrivalTime ?? departureTime,
        cabinClass:    fd.cabinClass ?? booking.cabinClass,
        isRefundable:  fd.isRefundable ?? false,
        baggage:       fd.baggage ?? { cabin: "As per airline", checked: "As per airline" },
        passengers:    paxRows.map((p, i) => ({
          name:         `${p.firstName} ${p.lastName}`,
          type:         p.passengerType,
          ticketNumber: finalTickets[i],
        })),
        totalAmount:  Number(booking.totalAmount),
        currency:     booking.currency,
        brandName:    tenantRow?.name ?? "POOMAS Traveldays",
        brandLogo:    tenantRow?.logoUrl ?? undefined,
        primaryColor: tenantRow?.primaryColor ?? "#E31E24",
        supportEmail: tenantRow?.supportEmail ?? undefined,
      });
    }
    eticketKey = await storeETicket(env.DOCUMENTS_R2, booking.id, eticketHtml);
    await logBookingEvent(env, booking.id, "TICKET", "info",
      `E-ticket copy saved${itinerary?.segments.length ? " from TripJack booking details" : ""}`);
  } catch (err) {
    // Never fail (and retry) an already-booked seat over the ticket document.
    await logBookingEvent(env, booking.id, "TICKET", "error",
      "Could not create the e-ticket copy — it will be built from TripJack when the customer opens it", errorDetail(err));
  }

  // Queue notification
  await env.NOTIFY_QUEUE.send({
    type:       "NOTIFY_BOOKING_CONFIRMATION",
    bookingId:  booking.id,
    tenantId:   booking.tenantId,
    eticketKey,
  });
}

// ── Notification Queue consumer ───────────────────────────────────

export async function handleNotifyQueue(
  batch: MessageBatch<NotifyQueueMsg>,
  env: Env,
): Promise<void> {
  const db = queueDb(env);

  for (const msg of batch.messages) {
    try {
      const data = msg.body;
      if (data.type === "NOTIFY_BOOKING_CONFIRMATION") {
        await handleNotifyBookingConfirmation(db, env, data);
      } else if (data.type === "NOTIFY_OTP") {
        await handleNotifyOtp(db, env, data);
      }
      msg.ack();
    } catch (err) {
      console.error(`[NotifyQueue] Failed msg ${msg.id}:`, err);
      msg.retry();
    }
  }
}

async function handleNotifyOtp(
  db: ReturnType<typeof createDb>,
  env: Env,
  data: NotifyOtpMsg,
): Promise<void> {
  // Get tenant Leadvyne config for WhatsApp delivery
  const [leadvyne] = await db
    .select({
      chatwootBaseUrl:  leadvyneConfigs.chatwootBaseUrl,
      chatwootInboxId:  leadvyneConfigs.chatwootInboxId,
      chatwootApiToken: leadvyneConfigs.chatwootApiToken,
    })
    .from(leadvyneConfigs)
    .where(and(eq(leadvyneConfigs.tenantId, data.tenantId), eq(leadvyneConfigs.isActive, true)))
    .limit(1);

  if (leadvyne?.chatwootBaseUrl && leadvyne.chatwootInboxId && leadvyne.chatwootApiToken) {
    await sendWhatsApp({
      phone:            data.phone,
      message:          `Your POOMAS OTP is: *${data.otp}*\nValid for 10 minutes. Do not share this with anyone.`,
      chatwootBaseUrl:  leadvyne.chatwootBaseUrl,
      chatwootInboxId:  leadvyne.chatwootInboxId,
      chatwootApiToken: leadvyne.chatwootApiToken,
    });
  }
}

async function handleNotifyBookingConfirmation(
  db: ReturnType<typeof createDb>,
  env: Env,
  data: NotifyBookingMsg,
): Promise<void> {
  const [booking] = await db
    .select()
    .from(bookings)
    .where(eq(bookings.id, data.bookingId))
    .limit(1);

  if (!booking) return;

  const paxRows = await db
    .select()
    .from(bookingPassengers)
    .where(eq(bookingPassengers.bookingId, data.bookingId));

  const [tenantRow] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, data.tenantId))
    .limit(1);

  const [leadvyne] = await db
    .select({
      chatwootBaseUrl:  leadvyneConfigs.chatwootBaseUrl,
      chatwootInboxId:  leadvyneConfigs.chatwootInboxId,
      chatwootApiToken: leadvyneConfigs.chatwootApiToken,
    })
    .from(leadvyneConfigs)
    .where(and(eq(leadvyneConfigs.tenantId, data.tenantId), eq(leadvyneConfigs.isActive, true)))
    .limit(1);

  const fd = booking.flightData as Record<string, unknown>;
  const passengerNames = paxRows.map((p) => `${p.firstName} ${p.lastName}`);

  // Retrieve e-ticket HTML from R2
  let eticketHtml = "";
  const r2obj = await env.DOCUMENTS_R2.get(data.eticketKey);
  if (r2obj) {
    eticketHtml = await r2obj.text();
  }

  // Send email confirmation (once per booking — Resend Idempotency-Key)
  if (booking.contactEmail) {
    const dep = String(fd.departureTime ?? booking.departureDate?.toISOString?.() ?? "");
    await sendMail(env, db, data.tenantId, {
      to: booking.contactEmail, category: "booking", idempotencyKey: `booking-confirmed:${booking.id}`, copyOps: true,
      subject: `Booking confirmed — PNR ${booking.pnr ?? ""} · ${booking.origin} → ${booking.destination}`,
      html: emailLayout({
        title: "Your booking is confirmed ✈️", preheader: `PNR ${booking.pnr ?? ""} · ${booking.origin} → ${booking.destination}`,
        body: `<p>Thank you for booking with ${escapeHtml(tenantRow?.name ?? "FlyPoomas")}. Your e-ticket is attached — keep it handy at the airport with your passport / ID.</p>`,
        rows: [
          ["PNR (airline reference)", booking.pnr ?? "—"],
          ["Route", `${booking.origin} → ${booking.destination}`],
          ...(dep ? [["Departure", formatDeparture(dep)] as [string, string]] : []),
          ["Travellers", passengerNames.join(", ")],
          ["Total paid", `${booking.currency} ${Number(booking.totalAmount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`],
        ],
        cta: { label: "Manage my booking", href: `${WEB_URL}/trips` },
        footerNote: "Check in online 48–24 hours before departure. Arrive at the airport 3 hours before international flights.",
      }),
      ...(eticketHtml ? { attachments: [{ filename: `e-ticket-${booking.pnr ?? booking.id.slice(0, 8)}.html`, content: base64(eticketHtml) }] } : {}),
    });
  }

  // Send WhatsApp via Leadvyne/Chatwoot
  if (booking.contactPhone && leadvyne?.chatwootBaseUrl && leadvyne.chatwootInboxId && leadvyne.chatwootApiToken) {
    try {
      const waMessage = buildBookingConfirmationMessage({
        brandName:    tenantRow?.name ?? "POOMAS",
        pnr:          booking.pnr ?? "",
        origin:       fd.origin as string,
        destination:  fd.destination as string,
        departureTime: fd.departureTime as string,
        passengerNames,
        totalAmount:  Number(booking.totalAmount),
        currency:     booking.currency,
      });

      await sendWhatsApp({
        phone:             booking.contactPhone,
        message:           waMessage,
        chatwootBaseUrl:   leadvyne.chatwootBaseUrl,
        chatwootInboxId:   leadvyne.chatwootInboxId,
        chatwootApiToken:  leadvyne.chatwootApiToken,
      });
    } catch (err) {
      console.error("WhatsApp send failed (non-fatal):", err);
    }
  }
}

function base64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function formatDeparture(iso: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return m[4] ? `${day}, ${m[4]}:${m[5]} (local time)` : day;
}
