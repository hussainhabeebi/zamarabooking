export type DuffelBaggageService={id:string;type:string;total_amount:string;total_currency:string;maximum_quantity:number;passenger_ids:string[];segment_ids:string[];metadata?:unknown};
function minor(value:string):number {
 if(typeof value!=="string"||!/^\d+(\.\d{1,2})?$/.test(value))throw Error("Duffel: invalid service price");
 const amount=Math.round(Number(value)*100);if(!Number.isSafeInteger(amount))throw Error("Duffel: unsafe service price");return amount;
}
export function duffelBaggage(offer:{total_amount:string;total_currency:string;available_services?:unknown[];passengers?:{id:string}[];slices:{segments:{id?:string}[]}[]},picks:{id:string;quantity:number}[]){
 const services=(offer.available_services??[]) as DuffelBaggageService[],seen=new Set<string>();
 let amount=minor(offer.total_amount);
 const result=picks.map(p=>{
  const s=services.find(s=>s.id===p.id);
  if(seen.has(p.id)||!s||s.type!=="baggage"||!Number.isSafeInteger(p.quantity)||p.quantity<1||!Number.isSafeInteger(s.maximum_quantity)||p.quantity>s.maximum_quantity)throw Error("Duffel: unavailable baggage service/quantity");
  seen.add(p.id);
  if(s.total_currency!==offer.total_currency||!s.passenger_ids?.length||!s.segment_ids?.length||!s.passenger_ids.every(id=>offer.passengers?.some(p=>p.id===id))||!s.segment_ids.every(id=>offer.slices.some(sl=>sl.segments.some(seg=>seg.id===id))))throw Error("Duffel: baggage eligibility/currency mismatch");
  amount+=minor(s.total_amount)*p.quantity;if(!Number.isSafeInteger(amount))throw Error("Duffel: unsafe total");
  return {id:s.id,quantity:p.quantity};
 });
 return {services:result,amount:(amount/100).toFixed(2),currency:offer.total_currency};
}
