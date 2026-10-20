// Admin → TripSafe (TripJack travel insurance v2).
//
//   GET  /bookings                         TripSafe bookings (newest first)
//   GET  /bookings/:ref                    record + live TripJack booking detail
//   POST /bookings/:ref/issue              book with TripJack (production requests, or retry a failed one)
//   POST /bookings/:ref/refresh            Get Booking Detail now
//   POST /bookings/:ref/amendment/raise    cancellation / correction quote
//   POST /bookings/:ref/amendment/confirm  execute a raised amendment
//   GET  /bookings/:ref/certification.zip  summary + request / response JSON per call
//   POST /search                           test console: sends the search to TripJack without our
//                                          pre-checks (captures TripJack's own validation errors)
//   GET  /exchanges                        recent TripSafe API calls
//   GET  /exchanges.zip?ids=a,b            selected calls as request / response JSON files

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { tripsafeProblems } from "@poomas/suppliers";
import type { Env, Variables } from "../../types.js";
import { buildZip } from "../../lib/zip.js";
import {
  exchangesPack, issuePolicy, listRecords, loadRecord, recentExchanges, refreshDetails, runSearch, saveRecord,
  tripsafeClient, tripsafeErrorResponse, tripsafePack, tripsafeSettings, trackedCall,
} from "../../lib/tripsafe.js";
import { tripSchema } from "../insurance.js";

export const tripsafeAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

async function record(c: any) {
  const r = await loadRecord(c.env, c.get("tenantId"), c.req.param("ref"));
  if (!r) throw new HTTPException(404, { message: "TripSafe booking not found" });
  return r;
}

const fail = (c: any, err: unknown, fallback: string) => {
  const { status, body } = tripsafeErrorResponse(err, fallback);
  // Admin sees the full TripJack message.
  return c.json({ ...body, error: err instanceof Error ? err.message : String(err) }, status);
};

tripsafeAdminRoutes.get("/bookings", async (c) => {
  const rows = await listRecords(c.env, c.get("tenantId"), Math.min(Number(c.req.query("limit") ?? 100) || 100, 500));
  return c.json({ bookings: rows.map(({ accessKey: _a, ...r }) => r) });
});

tripsafeAdminRoutes.get("/bookings/:ref", async (c) => {
  const r = await record(c);
  const settings = await tripsafeSettings(c.env, c.get("tenantId"));
  let details = null;
  let detailError: string | undefined;
  if (r.tripjack?.bookingId) {
    try {
      details = await refreshDetails(c, tripsafeClient(c.env, settings), r, "admin view");
    } catch (err) {
      detailError = err instanceof Error ? err.message : String(err);
    }
  }
  const { accessKey, ...rest } = r;
  return c.json({ ...rest, customerLink: `/insurance/booking?ref=${r.reference}&key=${accessKey}`, details, detailError });
});

tripsafeAdminRoutes.post("/bookings/:ref/issue", async (c) => {
  const r = await record(c);
  if (r.tripjack?.bookingId) {
    return c.json({ error: `Already booked with TripJack (${r.tripjack.bookingId}, ${r.tripjack.status}). Refresh instead of booking again.` }, 409);
  }
  const settings = await tripsafeSettings(c.env, c.get("tenantId"));
  try {
    const after = await issuePolicy(c, settings, r);
    return c.json({ ok: true, status: after.tripjack?.status, bookingId: after.tripjack?.bookingId, warning: after.error });
  } catch (err) {
    return fail(c, err, "TripSafe booking failed");
  }
});

tripsafeAdminRoutes.post("/bookings/:ref/refresh", async (c) => {
  const r = await record(c);
  if (!r.tripjack?.bookingId) return c.json({ error: "Not booked with TripJack yet" }, 400);
  const settings = await tripsafeSettings(c.env, c.get("tenantId"));
  try {
    return c.json({ ok: true, details: await refreshDetails(c, tripsafeClient(c.env, settings), r, "admin refresh") });
  } catch (err) {
    return fail(c, err, "Could not load the TripSafe booking");
  }
});

const raiseSchema = z.discriminatedUnion("type", [
  z.object({
    type:         z.literal("CANCELLATION"),
    travellerIds: z.array(z.number().int().positive()).min(1),
    remarks:      z.string().max(500).optional(),
  }),
  z.object({
    type:    z.literal("CORRECTION"),
    remarks: z.string().max(500).optional(),
    // Traveller-detail correction: traveller id + only the fields to change.
    traveller: z.object({ id: z.number().int().positive(), changes: z.record(z.unknown()) }).optional(),
    // Trip-date correction.
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
]);

tripsafeAdminRoutes.post("/bookings/:ref/amendment/raise", zValidator("json", raiseSchema), async (c) => {
  const r = await record(c);
  if (!r.tripjack?.bookingId) return c.json({ error: "Not booked with TripJack yet" }, 400);
  const body = c.req.valid("json");
  if (body.type === "CORRECTION" && Boolean(body.traveller) === Boolean(body.startDate || body.endDate)) {
    return c.json({ error: "Send either a traveller correction or new trip dates (one per request)" }, 400);
  }
  const settings = await tripsafeSettings(c.env, c.get("tenantId"));
  const client = tripsafeClient(c.env, settings);
  try {
    let request;
    if (body.type === "CANCELLATION") {
      // TripSafe can be cancelled up to 24 h before coverage starts.
      if (Date.parse(`${r.input.startDate}T00:00:00+05:30`) - Date.now() < 24 * 3600_000) {
        return c.json({ error: "TripSafe can only be cancelled at least 24 hours before coverage starts.", code: "INS_8312" }, 409);
      }
      request = {
        bookingId: r.tripjack.bookingId, type: "CANCELLATION" as const, remarks: body.remarks,
        travellerKeys: { [r.searchId]: { [r.productId]: body.travellerIds.map((id) => ({ id })) } },
      };
    } else if (body.traveller) {
      // TripJack wants the traveller's full record (incl. policyId) with only the corrected fields changed.
      const details = await refreshDetails(c, client, r, "before correction");
      const current = details?.travellers.find((t) => t.travellerId === body.traveller!.id);
      if (!current) return c.json({ error: `Traveller ${body.traveller.id} not found on the booking` }, 400);
      const { fareDetail: _f, coiFileName: _n, coiUrl: _u, ...base } = current.raw;
      request = {
        bookingId: r.tripjack.bookingId, type: "CORRECTION" as const, remarks: body.remarks,
        insuranceUpdateRequest: { amendedTravellerInfos: [{ ...base, ...body.traveller.changes, id: body.traveller.id, policyId: current.policyId }] },
      };
    } else {
      request = {
        bookingId: r.tripjack.bookingId, type: "CORRECTION" as const, remarks: body.remarks,
        insuranceUpdateRequest: { ...(body.startDate ? { startDate: body.startDate } : {}), ...(body.endDate ? { endDate: body.endDate } : {}) },
      };
    }
    const res = await trackedCall(c, client, "/insurance/v2/amendment/raise", { bookingId: r.reference },
      { bookingId: r.tripjack.bookingId, type: body.type }, () => client.raiseAmendment(request));
    const item = res.amendmentItems?.[0];
    if (item) {
      r.amendments = [...(r.amendments ?? []), {
        amendmentId: item.amendmentId, type: body.type, status: item.status, amount: item.amount,
        refund: res.insuranceCancellationResponse?.totalAmountToRefund, remarks: body.remarks, at: new Date().toISOString(),
        ...(body.type === "CANCELLATION" ? { travellerIds: body.travellerIds } : {}),
      }];
      await saveRecord(c.env, r);
    }
    return c.json({ ok: true, amendment: item, refund: res.insuranceCancellationResponse?.totalAmountToRefund, raw: res });
  } catch (err) {
    return fail(c, err, "Could not raise the amendment");
  }
});

const confirmSchema = z.object({
  amendmentId: z.string().min(1),
  remarks:     z.string().max(500).optional(),
});

tripsafeAdminRoutes.post("/bookings/:ref/amendment/confirm", zValidator("json", confirmSchema), async (c) => {
  const r = await record(c);
  if (!r.tripjack?.bookingId) return c.json({ error: "Not booked with TripJack yet" }, 400);
  const body = c.req.valid("json");
  const raised = r.amendments?.find((a) => a.amendmentId === body.amendmentId);
  if (!raised) return c.json({ error: "Raise the amendment first" }, 400);
  const settings = await tripsafeSettings(c.env, c.get("tenantId"));
  const client = tripsafeClient(c.env, settings);
  try {
    // A financial correction settles the quoted amount from the TripJack wallet.
    const charge = raised.type === "CORRECTION" && (raised.amount ?? 0) > 0;
    const res = await trackedCall(c, client, "/insurance/v2/amendment/confirm", { bookingId: r.reference },
      { bookingId: r.tripjack.bookingId, amendmentId: body.amendmentId, type: raised.type }, () => client.confirmAmendment({
        bookingId: r.tripjack!.bookingId, amendmentId: body.amendmentId, type: raised.type as "CANCELLATION" | "CORRECTION",
        ...(body.remarks ? { remarks: body.remarks } : {}),
        ...(charge ? { paymentRequests: [{ amount: raised.amount!, paymentMedium: "WALLET" as const }] } : {}),
      }));
    const item = res.amendmentItems?.[0];
    raised.status = item?.status ?? raised.status;
    await saveRecord(c.env, r);
    const details = await refreshDetails(c, client, r, "after amendment").catch(() => null);
    return c.json({ ok: item?.status !== "REJECTED", amendment: item, details, raw: res });
  } catch (err) {
    return fail(c, err, "Could not confirm the amendment");
  }
});

tripsafeAdminRoutes.get("/bookings/:ref/certification.zip", async (c) => {
  const r = await record(c);
  const files = await tripsafePack(c.env, c.get("db"), r);
  if (files.length <= 1) throw new HTTPException(404, { message: "No TripSafe API logs stored for this booking yet" });
  return new Response(buildZip(files), { headers: {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="tripsafe-${r.tripjack?.bookingId ?? r.reference}-logs.zip"`,
    "Cache-Control": "private, no-store",
  } });
});

tripsafeAdminRoutes.post("/search", zValidator("json", tripSchema), async (c) => {
  const input = c.req.valid("json");
  const settings = await tripsafeSettings(c.env, c.get("tenantId"));
  const warnings = tripsafeProblems(input);
  try {
    const res = await runSearch(c, tripsafeClient(c.env, settings), input, "admin test console");
    return c.json({ ok: true, warnings, ...res });
  } catch (err: any) {
    return c.json({ ok: false, warnings, error: err instanceof Error ? err.message : String(err), code: err?.code, response: err?.responseSnippet, requestId: err?.requestId }, 200);
  }
});

tripsafeAdminRoutes.get("/exchanges", async (c) => {
  const rows = await recentExchanges(c.get("db"), c.get("tenantId"));
  return c.json({ exchanges: rows.map((x) => ({ ...x, hasResponse: Boolean(x.hasResponse) })) });
});

tripsafeAdminRoutes.get("/exchanges.zip", async (c) => {
  const ids = (c.req.query("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100);
  const settings = await tripsafeSettings(c.env, c.get("tenantId"));
  const files = await exchangesPack(c.env, c.get("db"), c.get("tenantId"), ids, settings.environment);
  if (!files.length) throw new HTTPException(404, { message: "No TripSafe API logs selected" });
  return new Response(buildZip(files), { headers: {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="tripsafe-api-logs.zip"`,
    "Cache-Control": "private, no-store",
  } });
});
