// Baggage & visa checker data — static, general guidance (no AI, no API).
// Allowances vary by fare brand and route; the exact allowance of a booked
// fare is on the results card and the e-ticket. Keep these conservative.

export interface AirlineBaggage {
  code: string;
  name: string;
  cabin: string;
  domestic?: string;          // Indian domestic flights
  international: string;
  notes?: string;
}

export const AIRLINES: AirlineBaggage[] = [
  { code: "6E", name: "IndiGo", cabin: "1 bag up to 7 kg + 1 small personal item",
    domestic: "15 kg check-in on regular fares", international: "Usually 20–30 kg depending on route and fare; Gulf routes commonly 30 kg",
    notes: "Extra baggage is much cheaper pre-booked than at the airport." },
  { code: "AI", name: "Air India", cabin: "7 kg (economy)",
    domestic: "15–25 kg depending on fare (Comfort / Comfort Plus / Flex)", international: "Economy usually 25–35 kg depending on fare and route" },
  { code: "IX", name: "Air India Express", cabin: "7 kg",
    domestic: "15 kg on most fares; Xpress Lite fares are cabin-bag only", international: "Usually 20–30 kg on Gulf routes; Xpress Lite fares are cabin-bag only" },
  { code: "SG", name: "SpiceJet", cabin: "7 kg",
    domestic: "15 kg check-in", international: "Usually 20–30 kg depending on route" },
  { code: "QP", name: "Akasa Air", cabin: "7 kg",
    domestic: "15 kg check-in", international: "Usually 20 kg (varies by route)" },
  { code: "EK", name: "Emirates", cabin: "7 kg (economy)",
    international: "Economy usually 25–35 kg depending on fare brand (lowest fares carry less)" },
  { code: "FZ", name: "flydubai", cabin: "7 kg",
    international: "Lite: cabin bag only · Value: about 20 kg · Flex: about 30 kg" },
  { code: "QR", name: "Qatar Airways", cabin: "7 kg (economy)",
    international: "Economy usually 25–35 kg depending on fare brand" },
  { code: "EY", name: "Etihad Airways", cabin: "7 kg (economy)",
    international: "Economy usually 23–35 kg depending on fare brand; lowest fares may be cabin-bag only" },
  { code: "G9", name: "Air Arabia", cabin: "Cabin bag included (size and weight limits apply)",
    international: "Basic fares: cabin bag only · higher fares include 20 kg or more" },
  { code: "WY", name: "Oman Air", cabin: "7 kg (economy)",
    international: "Economy usually 23–30 kg depending on fare" },
  { code: "SV", name: "Saudia", cabin: "7 kg (economy)",
    international: "Economy usually 1–2 pieces of 23 kg depending on fare and route" },
  { code: "GF", name: "Gulf Air", cabin: "Cabin bag included (economy)",
    international: "Economy usually 25–35 kg depending on fare" },
  { code: "KU", name: "Kuwait Airways", cabin: "7 kg (economy)",
    international: "Economy usually 30 kg or 2 pieces depending on route" },
  { code: "J9", name: "Jazeera Airways", cabin: "7 kg",
    international: "Light fares: cabin bag only · higher fares include 20 kg or more" },
  { code: "XY", name: "flynas", cabin: "7 kg",
    international: "Simple fares: cabin bag only · higher fares include 20 kg or more" },
];

export const GENERAL_BAGGAGE_RULES = [
  "Power banks and spare lithium batteries: cabin bag only, never in check-in (usually up to 100 Wh).",
  "Liquids in the cabin on international flights: containers of 100 ml or less, in one clear 1-litre bag.",
  "India: dry coconut (copra) is not allowed in check-in baggage; e-cigarettes are banned.",
  "Infants usually get a 10 kg check-in allowance plus a collapsible stroller — confirm with the airline.",
  "Gulf countries (UAE, Saudi Arabia, Qatar and others) control some medicines (e.g. codeine and some sleeping or pain medicines): carry the prescription and check the country's rules before travel.",
  "Your exact allowance is shown on the flight results card and your e-ticket.",
];

export type VisaStatus = "VISA_FREE" | "ON_ARRIVAL" | "E_VISA" | "VISA_REQUIRED";

export interface VisaRule {
  country: string;           // ISO-2
  name: string;
  status: VisaStatus;
  summary: string;
  tips?: string[];
}

// For Indian passport holders. General guidance only — confirm with the embassy
// or official portal before travel.
export const VISA_FOR_INDIANS: VisaRule[] = [
  { country: "AE", name: "United Arab Emirates", status: "VISA_REQUIRED",
    summary: "A visa is needed before you fly (tourist visa through an airline, agency or UAE sponsor).",
    tips: ["Visa on arrival (14 days) if you hold a valid US visa or green card, or a UK / EU residence permit.", "Residents with a valid UAE residence visa don't need a new visa."] },
  { country: "QA", name: "Qatar", status: "VISA_FREE",
    summary: "Visa-free stay (up to 30 days) under Qatar's visa waiver.",
    tips: ["Usually needs a confirmed hotel booking (via Discover Qatar), a return ticket and 6 months' passport validity."] },
  { country: "OM", name: "Oman", status: "E_VISA",
    summary: "Apply for an Oman e-visa before travel.",
    tips: ["Visa-free (14 days) may apply if you hold a valid visa / residence of the US, Canada, Australia, UK, Japan or a Schengen country."] },
  { country: "SA", name: "Saudi Arabia", status: "VISA_REQUIRED",
    summary: "A visa is needed (work, family visit, Umrah or tourist).",
    tips: ["Holders of a valid US, UK or Schengen visa can usually get a tourist e-visa or visa on arrival."] },
  { country: "KW", name: "Kuwait", status: "VISA_REQUIRED",
    summary: "A visa is needed before travel (sponsored / e-visa where eligible)." },
  { country: "BH", name: "Bahrain", status: "E_VISA",
    summary: "Apply for a Bahrain e-visa before travel.",
    tips: ["Visa on arrival if you hold a valid US, UK, Schengen, Canada or Australia visa."] },
  { country: "MY", name: "Malaysia", status: "VISA_FREE",
    summary: "Visa-free up to 30 days under Malaysia's current scheme for Indians.",
    tips: ["Fill the Malaysia Digital Arrival Card (MDAC) within 3 days before arrival."] },
  { country: "TH", name: "Thailand", status: "VISA_FREE",
    summary: "Visa-free entry for tourism (the allowed stay has changed recently — check before travel).",
    tips: ["Complete the Thailand Digital Arrival Card (TDAC) before arrival."] },
  { country: "SG", name: "Singapore", status: "VISA_REQUIRED",
    summary: "Visa needed — apply through an authorised agent before travel.",
    tips: ["Submit the SG Arrival Card within 3 days before arrival."] },
  { country: "LK", name: "Sri Lanka", status: "E_VISA",
    summary: "Get an ETA (electronic travel authorisation) online before travel." },
  { country: "MV", name: "Maldives", status: "ON_ARRIVAL",
    summary: "Free visa on arrival (up to 30 days).",
    tips: ["Submit the IMUGA traveller declaration within 96 hours before arrival.", "Carry a return ticket and hotel booking."] },
  { country: "NP", name: "Nepal", status: "VISA_FREE",
    summary: "No visa needed. A valid Indian passport or voter ID card is accepted." },
  { country: "BT", name: "Bhutan", status: "VISA_FREE",
    summary: "No visa needed; an entry permit is issued with a passport or voter ID. A daily Sustainable Development Fee applies." },
  { country: "ID", name: "Indonesia", status: "ON_ARRIVAL",
    summary: "Paid visa on arrival / e-VOA (up to 30 days)." },
  { country: "VN", name: "Vietnam", status: "E_VISA",
    summary: "Apply for an e-visa online before travel." },
  { country: "GB", name: "United Kingdom", status: "VISA_REQUIRED",
    summary: "A UK visa is required before travel." },
  { country: "US", name: "United States", status: "VISA_REQUIRED",
    summary: "A US visa is required before travel." },
  { country: "CA", name: "Canada", status: "VISA_REQUIRED",
    summary: "A Canadian visa is required before travel." },
  { country: "AU", name: "Australia", status: "E_VISA",
    summary: "Apply for an Australian visa online before travel." },
  { country: "SCHENGEN", name: "Schengen area (France, Germany, Italy…)", status: "VISA_REQUIRED",
    summary: "A Schengen visa is required before travel; also check transit rules when connecting in Europe." },
];

export const VISA_GENERAL = [
  "Most countries need at least 6 months' passport validity from your arrival date.",
  "Going to a Gulf country for work on an ECR passport? Emigration clearance (eMigrate) is needed before you fly.",
  "Transit through a third country may need a transit visa — especially in Europe, the UK and the US.",
  "Visiting India on a non-Indian passport: most nationalities need an Indian e-Visa; OCI cardholders don't.",
];

export const STATUS_LABEL: Record<VisaStatus, { label: string; color: string; bg: string }> = {
  VISA_FREE:     { label: "Visa-free",        color: "#166534", bg: "#dcfce7" },
  ON_ARRIVAL:    { label: "Visa on arrival",  color: "#1e40af", bg: "#dbeafe" },
  E_VISA:        { label: "e-Visa / online",  color: "#92400e", bg: "#fef3c7" },
  VISA_REQUIRED: { label: "Visa required",    color: "#b91c1c", bg: "#fee2e2" },
};

// Airport → country (for "From / To" lookups on the checker).
export const AIRPORT_COUNTRY: Record<string, string> = {
  BOM: "IN", DEL: "IN", CCJ: "IN", COK: "IN", TRV: "IN", CNN: "IN", MAA: "IN", BLR: "IN", HYD: "IN", AMD: "IN",
  PNQ: "IN", GOI: "IN", GOX: "IN", CCU: "IN", LKO: "IN", IXE: "IN", ATQ: "IN", JAI: "IN", IXC: "IN", TRZ: "IN",
  DXB: "AE", DWC: "AE", AUH: "AE", SHJ: "AE", RKT: "AE", FJR: "AE", AAN: "AE",
  DOH: "QA", MCT: "OM", SLL: "OM", BAH: "BH", KWI: "KW",
  RUH: "SA", JED: "SA", DMM: "SA", MED: "SA",
  KUL: "MY", BKK: "TH", HKT: "TH", SIN: "SG", CMB: "LK", MLE: "MV", KTM: "NP", PBH: "BT", DPS: "ID", CGK: "ID",
  SGN: "VN", HAN: "VN", LHR: "GB", LGW: "GB", MAN: "GB", JFK: "US", EWR: "US", SFO: "US", ORD: "US", IAD: "US",
  YYZ: "CA", YVR: "CA", SYD: "AU", MEL: "AU",
  CDG: "SCHENGEN", FRA: "SCHENGEN", MUC: "SCHENGEN", AMS: "SCHENGEN", FCO: "SCHENGEN", MXP: "SCHENGEN", MAD: "SCHENGEN", ZRH: "SCHENGEN",
};
