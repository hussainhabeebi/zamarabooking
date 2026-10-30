# Three authorized public SEARCH requests only. Never bookings, reviews or payments.
import urllib.request,urllib.error,json
base=dict(origin='BOM',destination='DXB',departureDate='2026-11-18',adults=1,children=0,infants=0,cabinClass='ECONOMY',currency='INR')
cases=[dict(base,tripType='ONEWAY'),dict(base,tripType='ROUNDTRIP',returnDate='2026-11-25'),dict(base,tripType='MULTICITY',destination='SIN',legs=[dict(origin='BOM',destination='DXB',departureDate='2026-11-18'),dict(origin='DXB',destination='SIN',departureDate='2026-11-25')])]
for p in cases:
 try:
  req=urllib.request.Request('https://api.zamrabooking.com/api/search',data=json.dumps(p).encode(),headers={'Content-Type':'application/json','x-tenant-slug':'zamra'})
  with urllib.request.urlopen(req,timeout=40) as r:d=json.load(r)
  fares=d.get('fares',[]);groups={}
  for f in fares:
   key=f.get('supplier','unknown')+':'+str(f.get('tripKey'));groups[key]=groups.get(key,0)+1
  print(json.dumps(dict(tripType=p['tripType'],count=len(fares),groups=groups,availableSuppliers=d.get('availableSuppliers'),usedSuppliers=d.get('usedSuppliers'),failedSuppliers=list((d.get('supplierErrors') or {}).keys()),searchId=d.get('searchId'))),flush=True)
 except urllib.error.HTTPError as e:print(json.dumps(dict(tripType=p['tripType'],httpStatus=e.code)),flush=True)
 except Exception as e:print(json.dumps(dict(tripType=p['tripType'],failure=type(e).__name__)),flush=True)
