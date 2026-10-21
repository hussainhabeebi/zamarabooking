// The business behind zamrabooking.com, shown on the legal, contact and about
// pages and in the footer. Payment gateways check these against the KYC details,
// so keep them identical to the registration documents.
export const BUSINESS = {
  brand:        "ZamraBooking",
  legalName:    "Zamra Tours & Travels",
  website:      "https://www.zamrabooking.com",
  email:        "support@zamrabooking.com",
  phone:        "+91 98466 06739",
  phoneHref:    "tel:+919846606739",
  whatsappHref: "https://wa.me/919846606739",
  hours:        "Monday to Saturday, 9:30 AM – 7:00 PM IST (email and WhatsApp monitored daily)",
  // Registered business address, exactly as on the GST / trade licence. Lines are
  // shown in order; leave empty until confirmed (pages then omit it).
  address:      [] as string[],
  gstin:        "",
  country:      "India",
  // Last time the policies changed (shown on each legal page).
  policiesUpdated: "21 October 2026",
} as const;
