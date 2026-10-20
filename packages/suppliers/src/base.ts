// Supplier interface — every adapter implements this.
// Only RIYA and TRIPJACK implement book/PNR/cancel flows.
// GOOGLE_SERP implements search only and always returns isBookable: false.

export interface SearchParams {
  origin:       string;  // IATA code
  destination:  string;
  departureDate: string; // YYYY-MM-DD
  returnDate?:  string;
  adults:       number;
  children:     number;
  infants:      number;
  cabinClass:   "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
  tripType:     "ONEWAY" | "ROUNDTRIP" | "MULTICITY";
  currency:     "INR" | "AED" | "USD";
  sessionId?:   string;
  // Multi-city (2–6 legs). Round trips may use legs or origin/destination + returnDate.
  legs?:        { origin: string; destination: string; date: string }[];
  // TripJack passenger fare type (searchModifiers.pfts).
  fareType?:    "REGULAR" | "STUDENT" | "SENIOR_CITIZEN";
}

export interface FareSegment {
  id?:           string;   // TripJack segment id (SSR key)
  airline:       string;
  airlineName:   string;
  flightNumber:  string;
  origin:        string;
  destination:   string;
  departureTime: string;
  arrivalTime:   string;
  duration:      number;
  isReturn?:     boolean;
}

export interface NormalizedFare {
  id:            string;         // Supplier-specific fare key (used for hold/book)
  supplier:      "RIYA" | "TRIPJACK" | "GOOGLE_SERP" | "DUFFEL";
  isBookable:    boolean;        // false for SERP results
  airline:       string;         // IATA airline code
  airlineName:   string;
  flightNumber:  string;
  origin:        string;
  destination:   string;
  departureTime: string;         // ISO 8601
  arrivalTime:   string;
  duration:      number;         // minutes
  stops:         number;
  stopDetails:   StopDetail[];
  cabinClass:    string;
  baseFare:      number;
  taxes:         number;
  totalFare:     number;
  perAdultFare?: number;   // one adult's fare; totalFare covers every traveller searched
  currency:      string;
  isRefundable:  boolean;
  baggage:       BaggageInfo;
  fareClass:     string;
  seatsLeft?:    number;
  // Journey context (TripJack): which search leg this price belongs to.
  tripKey?:        string;    // ONWARD | RETURN | COMBO | "0".."5"
  legIndex?:       number;
  fareIdentifier?: string;    // PUBLISHED | SPECIAL_RETURN | TJ_FLEX | STUDENT | SENIOR_CITIZEN ...
  sri?:            string;    // Special Return id (onward)
  msri?:           string[];  // Special Return ids this price pairs with (return)
  refundableType?: number;    // 0 non-refundable, 1 refundable, 2 partial
  mealIncluded?:   boolean;   // TripJack fd.mI — free meal with this fare option
  segments?:       FareSegment[];
  fareRules?:    FareRule[];
  raw:           unknown;        // Original supplier response (kept for debugging)
}

export interface StopDetail {
  airport:      string;
  arrivalTime:  string;
  departureTime: string;
  layoverMinutes: number;
}

export interface BaggageInfo {
  cabin:   string;   // "7 KG" | "Hand bag only"
  checked: string;   // "15 KG" | "20 KG" | "Not included"
}

export interface FareRule {
  category:    string;
  description: string;
}

export interface HoldParams {
  fareId:    string;
  sessionId?: string;
  passengers: PassengerInfo[];
}

export interface PassengerInfo {
  type:          "ADULT" | "CHILD" | "INFANT";
  firstName:     string;
  lastName:      string;
  dob?:          string;
  gender?:       string;
  nationality?:  string;
  passportNumber?: string;
  passportExpiry?: string;
  passportIssueDate?: string;
  panNumber?:      string;
  documentId?:     string;   // Student / senior citizen fares (TripJack "di")
  frequentFlyer?:  Record<string, string>;
  ssr?: {
    baggage?: { key: string; code: string }[];
    meal?:    { key: string; code: string }[];
    seat?:    { key: string; code: string }[];
    extra?:   { key: string; code: string }[];
  };
}

export interface GstDetails {
  gstNumber:      string;
  registeredName: string;
  email?:         string;
  mobile?:        string;
  address?:       string;
}

export interface HoldResult {
  success:       boolean;
  holdId:        string;
  pnr?:          string;
  expiresAt:     string;   // ISO 8601
  fareSnapshot:  NormalizedFare;
}

export interface RevalidateResult {
  success:       boolean;
  fareId:        string;
  bookingId:     string;
  baseFare?:     number;
  taxes?:        number;
  totalFare?:    number;
  currency?:     string;
  raw:           unknown;
}

export interface BookParams extends HoldParams {
  holdId:         string;
  contactEmail:   string;
  contactPhone:   string;
  paymentRef:     string;
  paymentAmount?: number;  // Total fare from review — required for TripJack instant ticketing
  gstInfo?:       GstDetails;
  emergencyContact?: { name: string; email?: string; phone?: string };
  holdOnly?:      boolean; // TripJack: book without payment (ON_HOLD), confirmed later
}

export interface BookResult {
  success:       boolean;
  bookingRef:    string;
  pnr:           string;
  status:        "CONFIRMED" | "TICKETED" | "FAILED";
  ticketNumbers: string[];
  raw:           unknown;
}

export interface PNRStatusResult {
  pnr:          string;
  status:       string;
  passengers:   { name: string; ticketNumber: string; status: string }[];
  itinerary:    unknown;
  statusMessage?: string;  // Supplier's own status text (why a PNR/ticket is missing)
  raw?:         unknown;
}

export interface CancelResult {
  success:      boolean;
  refundAmount: number;
  penalty:      number;
  status:       string;
}

// Core supplier interface — every adapter implements search()
export interface SupplierAdapter {
  readonly name: "RIYA" | "TRIPJACK" | "GOOGLE_SERP" | "DUFFEL";

  search(params: SearchParams): Promise<NormalizedFare[]>;
  getFareRules?(fareId: string, sessionId?: string): Promise<FareRule[]>;
  revalidate?(fareId: string): Promise<RevalidateResult>;

  // Bookable suppliers only
  hold?(params: HoldParams): Promise<HoldResult>;
  book?(params: BookParams): Promise<BookResult>;
  getPNRStatus?(pnr: string): Promise<PNRStatusResult>;
  cancel?(bookingRef: string, pnr: string): Promise<CancelResult>;
  reissue?(bookingRef: string, params: unknown): Promise<unknown>;
}

export interface SupplierCredentials {
  apiKey?:    string;
  secretKey?: string;
  baseUrl?:   string;
  [key: string]: unknown;
}
