// Shared TypeScript types — used by both API and frontend apps

export type Region   = "INDIA" | "GCC";
export type Currency = "INR" | "AED" | "USD";
export type TenantPlan   = "TRIAL" | "STARTER" | "PROFESSIONAL" | "ENTERPRISE";
export type TenantStatus = "ONBOARDING" | "ACTIVE" | "SUSPENDED" | "TRIAL_EXPIRED" | "CLOSED";
export type UserRole  = "SUPER_ADMIN" | "TENANT_ADMIN" | "AGENT_ADMIN" | "AGENT_STAFF" | "AGENT_ACCOUNTANT" | "CUSTOMER";
export type AgentStatus  = "PENDING" | "APPROVED" | "SUSPENDED" | "REJECTED";
export type BookingStatus = "SEARCHED" | "HELD" | "PAYMENT_PENDING" | "PAYMENT_FAILED" | "CONFIRMED" | "TICKETED" | "CANCELLED" | "REFUND_PENDING" | "REFUNDED" | "REISSUED";
export type BookingChannel = "B2C_WEB" | "B2B_PORTAL" | "WHATSAPP_BOT" | "OFFLINE";
export type SupplierName = "RIYA" | "TRIPJACK" | "GOOGLE_SERP";
export type CabinClass = "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
export type TripType = "ONEWAY" | "ROUNDTRIP" | "MULTICITY";

export interface TenantBranding {
  name:            string;
  logoUrl:         string | null;
  faviconUrl:      string | null;
  primaryColor:    string;
  secondaryColor:  string;
  accentColor:     string;
  fontFamily:      string;
  showPoweredBy:   boolean;
  tagline:         string | null;
  supportEmail:    string | null;
  supportWhatsApp: string | null;
}

export interface SearchRequest {
  origin:        string;
  destination:   string;
  departureDate: string;
  returnDate?:   string;
  adults:        number;
  children?:     number;
  infants?:      number;
  cabinClass:    CabinClass;
  tripType:      TripType;
  currency?:     Currency;
}

export interface FareResult {
  id:           string;
  supplier:     SupplierName;
  isBookable:   boolean;
  airline:      string;
  airlineName:  string;
  flightNumber: string;
  origin:       string;
  destination:  string;
  departureTime: string;
  arrivalTime:  string;
  duration:     number;
  stops:        number;
  cabinClass:   string;
  totalFare:    number;
  displayPrice: number;
  currency:     string;
  isRefundable: boolean;
  baggage:      { cabin: string; checked: string };
}

export interface ApiError {
  error:   string;
  details?: Record<string, string[]>;
}
