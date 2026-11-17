// City names for airport codes shown on flight results ("Kochi (COK)"). Codes not listed show
// as the code alone — never a guessed name.
export const AIRPORT_CITY: Record<string, string> = {
  // India
  COK: "Kochi", CCJ: "Kozhikode", CNN: "Kannur", TRV: "Thiruvananthapuram", IXE: "Mangaluru",
  BOM: "Mumbai", DEL: "New Delhi", BLR: "Bengaluru", MAA: "Chennai", HYD: "Hyderabad", CCU: "Kolkata",
  AMD: "Ahmedabad", PNQ: "Pune", GOI: "Goa", GOX: "Goa Mopa", JAI: "Jaipur", LKO: "Lucknow", IXJ: "Jammu",
  SXR: "Srinagar", ATQ: "Amritsar", IXC: "Chandigarh", CJB: "Coimbatore", TRZ: "Tiruchirappalli", IXM: "Madurai",
  VTZ: "Visakhapatnam", BBI: "Bhubaneswar", GAU: "Guwahati", PAT: "Patna", NAG: "Nagpur", IDR: "Indore",
  VNS: "Varanasi", IXB: "Bagdogra", STV: "Surat", BDQ: "Vadodara", RPR: "Raipur", IXR: "Ranchi", TIR: "Tirupati",
  // UAE
  DXB: "Dubai", DWC: "Dubai Al Maktoum", SHJ: "Sharjah", AUH: "Abu Dhabi", RKT: "Ras Al Khaimah",
  FJR: "Fujairah", AAN: "Al Ain",
  // Gulf
  DOH: "Doha", MCT: "Muscat", SLL: "Salalah", BAH: "Bahrain", KWI: "Kuwait City",
  RUH: "Riyadh", JED: "Jeddah", DMM: "Dammam", MED: "Madinah", AHB: "Abha", TIF: "Taif", GIZ: "Jazan", TUU: "Tabuk",
  // Elsewhere
  CMB: "Colombo", MLE: "Malé", KTM: "Kathmandu", DAC: "Dhaka", KHI: "Karachi", IST: "Istanbul", CAI: "Cairo",
  LHR: "London Heathrow", LGW: "London Gatwick", MAN: "Manchester", CDG: "Paris", FRA: "Frankfurt", AMS: "Amsterdam",
  SIN: "Singapore", KUL: "Kuala Lumpur", BKK: "Bangkok", HKG: "Hong Kong", NRT: "Tokyo", ADD: "Addis Ababa",
  JFK: "New York", EWR: "Newark", ORD: "Chicago", LAX: "Los Angeles", YYZ: "Toronto", SYD: "Sydney", MEL: "Melbourne",
};

export const airportCity = (code: string | null | undefined) => AIRPORT_CITY[String(code ?? "").toUpperCase()] ?? "";
