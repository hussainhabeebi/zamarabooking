// Shared constants across all apps

export const PLATFORM_SLUG = "poomas";
export const PLATFORM_DOMAIN = "flypoomas.com";

// India-GCC corridor — default popular routes
export const POPULAR_ROUTES = [
  { origin: "COK", destination: "DXB", label: "Kochi → Dubai"         },
  { origin: "CCJ", destination: "AUH", label: "Kozhikode → Abu Dhabi" },
  { origin: "TRV", destination: "DXB", label: "Trivandrum → Dubai"    },
  { origin: "BOM", destination: "DXB", label: "Mumbai → Dubai"        },
  { origin: "MAA", destination: "DXB", label: "Chennai → Dubai"       },
  { origin: "DEL", destination: "DXB", label: "Delhi → Dubai"         },
  { origin: "HYD", destination: "SHJ", label: "Hyderabad → Sharjah"   },
  { origin: "COK", destination: "SHJ", label: "Kochi → Sharjah"       },
] as const;

// Supported currencies with metadata
export const CURRENCIES = {
  INR: { symbol: "₹", name: "Indian Rupee",  locale: "en-IN" },
  AED: { symbol: "د.إ", name: "UAE Dirham",  locale: "ar-AE" },
  USD: { symbol: "$", name: "US Dollar",      locale: "en-US" },
} as const;

// Plan feature matrix — drives showPoweredBy and other feature gating
export const PLAN_FEATURES = {
  TRIAL:        { customDomain: false, showPoweredBy: true,  ownWhatsApp: false, ownSupplier: false },
  STARTER:      { customDomain: false, showPoweredBy: true,  ownWhatsApp: false, ownSupplier: false },
  PROFESSIONAL: { customDomain: true,  showPoweredBy: false, ownWhatsApp: true,  ownSupplier: false },
  ENTERPRISE:   { customDomain: true,  showPoweredBy: false, ownWhatsApp: true,  ownSupplier: true  },
} as const;

// Booking status display labels
export const BOOKING_STATUS_LABELS: Record<string, string> = {
  SEARCHED:        "Searching",
  HELD:            "On Hold",
  PAYMENT_PENDING: "Awaiting Payment",
  PAYMENT_FAILED:  "Payment Failed",
  CONFIRMED:       "Confirmed",
  TICKETED:        "Ticketed",
  CANCELLED:       "Cancelled",
  REFUND_PENDING:  "Refund Pending",
  REFUNDED:        "Refunded",
  REISSUED:        "Reissued",
};
