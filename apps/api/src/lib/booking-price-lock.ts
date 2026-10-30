import { sql } from "drizzle-orm";
import type { Db } from "@zamrabooking/db";
import { HTTPException } from "hono/http-exception";
// Both operations update the SAME booking row. PostgreSQL serializes competing
// writers and rechecks their predicates after waiting. No KV/distributed mutex.
export async function freezeBookingPrice(db:Db, tenantId:string, booking:{id:string;totalAmount:string;currency:string;flightData:unknown}) {
 const owner=crypto.randomUUID();
 const result=await db.execute(sql`UPDATE bookings SET flight_data=jsonb_set(jsonb_set(flight_data,'{paymentPriceFrozen}','true'::jsonb,true),'{paymentFreezeId}',to_jsonb(${owner}::text),true)
 WHERE id=${booking.id} AND tenant_id=${tenantId} AND status IN ('HELD','PAYMENT_PENDING')
 AND (held_until IS NULL OR held_until > now())
 AND COALESCE(flight_data->>'paymentPriceFrozen','false')='false'
 AND total_amount=${booking.totalAmount}::numeric AND currency=${booking.currency}
 AND flight_data=${JSON.stringify(booking.flightData)}::jsonb RETURNING id`);
 if(!result.rows.length)throw new HTTPException(409,{message:'Booking changed. Refresh checkout before paying.'});
 return owner;
 // Unknown outcomes remain frozen: a provider order may exist.
}
export async function applyBookingBaggage(db:Db,tenantId:string,booking:{id:string;totalAmount:string;currency:string;flightData:unknown},next:{total:string;baseFare:string;flightData:unknown;expiresAt:string}) {
 const result=await db.execute(sql`UPDATE bookings SET total_amount=${next.total}::numeric,base_fare=${next.baseFare}::numeric,
 flight_data=${JSON.stringify(next.flightData)}::jsonb,updated_at=now()
 WHERE id=${booking.id} AND tenant_id=${tenantId} AND status='PAYMENT_PENDING' AND currency='INR'
 AND now() < ${next.expiresAt}::timestamptz
 AND total_amount=${booking.totalAmount}::numeric AND flight_data=${JSON.stringify(booking.flightData)}::jsonb
 AND COALESCE(flight_data->>'paymentPriceFrozen','false')='false'
 AND flight_data->>'checkoutPriceProtocol'='1'
 AND NOT EXISTS(SELECT 1 FROM payments WHERE booking_id=${booking.id}) RETURNING id`);
 if(!result.rows.length)throw new HTTPException(409,{message:'Payment started or booking changed. Refresh checkout; baggage was not applied.'});
}

// Only for a confirmed no-debit wallet rejection after its pending ledger slot
// has been removed. Never use after a gateway request or an ambiguous exception.
export async function releaseRejectedWalletPrice(db:Db,tenantId:string,id:string,owner:string) {
 await db.execute(sql`UPDATE bookings SET flight_data=jsonb_set(flight_data - 'paymentFreezeId','{paymentPriceFrozen}','false'::jsonb,true)
 WHERE id=${id} AND tenant_id=${tenantId} AND flight_data->>'paymentFreezeId'=${owner}
 AND NOT EXISTS(SELECT 1 FROM payments WHERE booking_id=${id})`);
}
