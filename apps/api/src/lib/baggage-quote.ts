import { ssrTotal, type ReviewSummary } from "@zamrabooking/suppliers";
export type BaggagePick = { passengerId: string; baggage: {key:string;code:string}[] };
// Client receives a preview only. Applying it requires the shared SQL CAS;
// gateways always read and freeze the authoritative persisted booking price.
export function quoteBaggage(input: {
  booking: {status:string;supplier:string;currency:string;totalAmount:string;updatedAt:Date;flightData:unknown};
  passengers: {id:string;passengerType:string;firstName:string;lastName:string}[];
  review: {summary:ReviewSummary;createdAt:string}; picks:BaggagePick[];
  hasPayments:boolean; now?:number;
}) {
  const {booking:b,review,picks,passengers}=input, now=input.now??Date.now();
  if(b.supplier!=="TRIPJACK" || b.status!=="PAYMENT_PENDING" || b.currency!=="INR") throw new Error("BAGGAGE_REPRICE_UNSUPPORTED");
  if((b.flightData as any)?.paymentPriceFrozen === true) throw new Error("PAYMENT_ALREADY_STARTED");
  if(input.hasPayments) throw new Error("PAYMENT_ALREADY_STARTED");
  const created=Date.parse(review.createdAt), seconds=Math.min(review.summary.conditions.sessionSeconds??900,900);
  const expires=created+seconds*1000;
  if(!Number.isFinite(created)||created>now||!Number.isFinite(seconds)||seconds<=0||now>=expires) throw new Error("REVIEW_EXPIRED");
  const fd=b.flightData as any, stored=fd?.tripjack;
  if(fd.checkoutPriceProtocol!==1) throw new Error("REPRICE_PROTOCOL_UNAVAILABLE_RESTART_BOOKING");
  if(stored?.held || stored?.reviewBookingId!==review.summary.bookingId || !Array.isArray(stored?.pax) || stored.pax.length!==passengers.length) throw new Error("REVIEW_BINDING_INVALID");
  const seen=new Set<string>();
  for(const p of picks){if(seen.has(p.passengerId)||!passengers.some(x=>x.id===p.passengerId)) throw new Error("PASSENGER_INVALID");seen.add(p.passengerId);}
  const identity=(p:{firstName:string;lastName:string})=>`${p.firstName.trim().toUpperCase()}\0${p.lastName.trim().toUpperCase()}`;
  const matched=new Set<string>();
  const selected=stored.pax.map((p:any)=>{
    const matches=passengers.filter(x=>(p.passengerId ? x.id===p.passengerId : identity(x)===identity(p))&&x.passengerType===p.type);
    if(matches.length!==1||matched.has(matches[0].id)) throw new Error("PASSENGER_BINDING_AMBIGUOUS");
    const passenger=matches[0];matched.add(passenger.id);
    const baggage=picks.find(x=>x.passengerId===passenger.id)?.baggage??[];
    if(passenger.passengerType==="INFANT"&&baggage.length)throw new Error("INFANT_BAGGAGE_UNSUPPORTED");
    return {...p,passengerId:passenger.id,ssr:{...p.ssr,baggage}};
  });
  // Validate preserved meals/extras too, and never remove their price from total.
  const original=ssrTotal(review.summary.segments,stored.pax), next=ssrTotal(review.summary.segments,selected);
  if(original.invalid.length||next.invalid.length)throw new Error("BAGGAGE_SELECTION_INVALID");
  const amount=Number(b.totalAmount), total=Math.round((amount-original.total+next.total)*100)/100;
  if(!Number.isFinite(amount)||amount<=0||!Number.isFinite(total)||total<=0) throw new Error("TOTAL_INVALID");
  return {currency:b.currency,originalTotal:amount,total,ancillaryDelta:Math.round((next.total-original.total)*100)/100,
    expiresAt:new Date(expires).toISOString(),bookingRevision:fd.baggageVersion ?? b.updatedAt.toISOString(),
    selected:selected.map((p:any)=>({passengerId:p.passengerId,type:p.type,ssr:p.ssr})),
    commitAllowed: !(fd.paymentPriceFrozen === true)};
}
