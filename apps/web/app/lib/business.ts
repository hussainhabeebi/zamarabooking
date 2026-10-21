// The business behind zamrabooking.com, shown on the legal, contact and about
// pages and in the footer. Payment gateways check these against the KYC details,
// so keep them identical to the registration documents (Malappuram Municipality
// IFTE & OS trade licence).
export const BUSINESS = {
  brand:        "ZamraBooking",
  legalName:    "Zamra Travels",
  proprietor:   "Mohammed Sahal V",            // sole proprietorship (licence: Individual)
  tradeLicence: "BFIF01-M100500-00326-2025",   // Malappuram Municipality IFTE & OS licence
  website:      "https://www.zamrabooking.com",
  email:        "support@zamrabooking.com",
  phone:        "+91 98466 06739",
  phoneHref:    "tel:+919846606739",
  whatsappHref: "https://wa.me/919846606739",
  hours:        "Monday to Saturday, 9:30 AM – 7:00 PM IST (email and WhatsApp monitored daily)",
  // Business address, exactly as on the trade licence. Lines are shown in order.
  address:      ["Building No. 25/282, Kizhakkethala, Down Hill", "Malappuram, Kerala 676505", "India"] as string[],
  jurisdiction: "Malappuram, Kerala",
  gstin:        "",   // not GST registered
  country:      "India",
  // Last time the policies changed (shown on each legal page).
  policiesUpdated: "21 October 2026",
} as const;
