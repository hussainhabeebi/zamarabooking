# Live check of round-trip and multi-city flight SEARCH only (POST /api/search).
# Never holds, reviews, books or pays. Exit 1 when a journey has no bookable Akbar leg list.
import datetime, json, sys, urllib.error, urllib.request

API = sys.argv[1] if len(sys.argv) > 1 else "https://api.zamrabooking.com"
day = lambda n: (datetime.date.today() + datetime.timedelta(days=n)).isoformat()
pax = dict(adults=1, children=0, infants=0, cabinClass="ECONOMY", currency="INR")
cases = [
    ("ROUNDTRIP", dict(pax, tripType="ROUNDTRIP", origin="BOM", destination="DEL", departureDate=day(21), returnDate=day(28)), ["ONWARD", "RETURN"]),
    ("MULTICITY", dict(pax, tripType="MULTICITY", origin="BOM", destination="BLR", departureDate=day(21), legs=[
        dict(origin="BOM", destination="DEL", departureDate=day(21)), dict(origin="DEL", destination="BLR", departureDate=day(25))]), ["0", "1"]),
]
ok = True
for name, body, keys in cases:
    req = urllib.request.Request(f"{API}/api/search", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "x-tenant-slug": "zamra"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        print(json.dumps(dict(journey=name, httpStatus=e.code, body=e.read().decode()[:500])), flush=True)
        ok = False
        continue
    groups = {}
    for f in d.get("fares", []):
        k = f"{f.get('supplier')}:{f.get('tripKey')}"
        groups[k] = groups.get(k, 0) + 1
    akbar = {k: groups.get(f"AKBAR:{k}", 0) for k in keys}
    sample = next((f for f in d.get("fares", []) if f.get("supplier") == "AKBAR" and f.get("tripKey")), None)
    print(json.dumps(dict(
        journey=name, request={k: body[k] for k in ("origin", "destination", "departureDate") } | ({"returnDate": body["returnDate"]} if "returnDate" in body else {}) | ({"legs": body["legs"]} if "legs" in body else {}),
        searchId=d.get("searchId"), fromCache=d.get("fromCache", False), totalFares=len(d.get("fares", [])), groups=groups, akbarLegs=akbar,
        availableSuppliers=d.get("availableSuppliers"), usedSuppliers=d.get("usedSuppliers"), supplierErrors=d.get("supplierErrors"),
        sampleAkbarFare=sample and {k: sample.get(k) for k in ("tripKey", "airlineName", "flightNumber", "origin", "destination", "departureTime", "totalFare", "displayPrice")},
    )), flush=True)
    if not all(akbar.values()):
        ok = False
sys.exit(0 if ok else 1)
