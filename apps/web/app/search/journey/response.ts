type Fare={supplier?:string;tripKey?:string};
export function journeyResponse<T extends Fare>(data:{fares?:T[];availableSuppliers?:string[];usedSuppliers?:string[];supplierErrors?:Record<string,string>;searchId?:string}){
 if(!Array.isArray(data.fares))throw Error('Flight search returned an invalid response. Please try again.');
 const fares=data.fares.filter(f=>f.supplier==='TRIPJACK'&&typeof f.tripKey==='string'&&f.tripKey.length>0);
 let code='',message='';
 if(!fares.length){
  if(data.supplierErrors?.TRIPJACK){code='JOURNEY_SUPPLIER_FAILED';message='The flight supplier could not complete this journey search. Please retry or contact support with the search reference.';}
  else if(data.availableSuppliers&&!data.availableSuppliers.includes('TRIPJACK')){code='JOURNEY_SUPPLIER_UNAVAILABLE';message='Round-trip and multi-city flight search is currently unavailable from the configured flight sources. Please contact support.';}
  else if(data.fares.some(f=>f.supplier==='TRIPJACK')){code='JOURNEY_RESPONSE_INVALID';message='The flight search server returned fares without the required journey details. Please contact support.';}
  else if(data.fares.length){code='JOURNEY_SOURCE_UNSUPPORTED';message='The available flight source does not support booking this complete journey online. Please contact support.';}
  else if(Object.keys(data.supplierErrors??{}).length){code='JOURNEY_SEARCH_FAILED';message='Flight sources failed to complete this search. Please try again or contact support.';}
 }
 return {fares,code,message,diagnostic:{searchId:data.searchId,totalFares:data.fares.length,journeyFares:fares.length,availableSuppliers:data.availableSuppliers,usedSuppliers:data.usedSuppliers,failedSuppliers:Object.keys(data.supplierErrors??{}),code:code||'JOURNEY_EMPTY'}};
}
