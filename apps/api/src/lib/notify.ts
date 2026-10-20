// WhatsApp dispatch via Leadvyne/Chatwoot. Email lives in lib/email.ts (Resend).

export interface WhatsAppPayload {
  phone:   string;     // E.164 format e.g. +919876543210
  message: string;
  chatwootBaseUrl: string;
  chatwootInboxId: number;
  chatwootApiToken: string;
}

// Send WhatsApp message via Chatwoot (Leadvyne integration)
export async function sendWhatsApp(payload: WhatsAppPayload): Promise<void> {
  // Look up or create contact in Chatwoot by phone number
  const contactRes = await fetch(
    `${payload.chatwootBaseUrl}/api/v1/profile`,
    { headers: { api_access_token: payload.chatwootApiToken } },
  );
  if (!contactRes.ok) {
    throw new Error("Chatwoot auth failed");
  }

  // Create/search contact
  const searchRes = await fetch(
    `${payload.chatwootBaseUrl}/api/v1/contacts/search?q=${encodeURIComponent(payload.phone)}&include_contacts=true`,
    { headers: { api_access_token: payload.chatwootApiToken } },
  );
  const searchData = await searchRes.json() as { payload: { id: string }[] };

  let contactId: string;
  if (searchData.payload?.length > 0) {
    contactId = searchData.payload[0].id;
  } else {
    // Create new contact
    const createRes = await fetch(
      `${payload.chatwootBaseUrl}/api/v1/contacts`,
      {
        method: "POST",
        headers: {
          "Content-Type":       "application/json",
          api_access_token: payload.chatwootApiToken,
        },
        body: JSON.stringify({ phone_number: payload.phone }),
      },
    );
    const created = await createRes.json() as { id: string };
    contactId = created.id;
  }

  // Get or create conversation for this contact on the WhatsApp inbox
  const convRes = await fetch(
    `${payload.chatwootBaseUrl}/api/v1/contacts/${contactId}/conversations`,
    { headers: { api_access_token: payload.chatwootApiToken } },
  );
  const convData = await convRes.json() as { payload: { id: string; inbox_id: number }[] };

  let conversationId: string;
  const existing = convData.payload?.find((c) => c.inbox_id === payload.chatwootInboxId);

  if (existing) {
    conversationId = existing.id;
  } else {
    const newConv = await fetch(
      `${payload.chatwootBaseUrl}/api/v1/conversations`,
      {
        method: "POST",
        headers: {
          "Content-Type":   "application/json",
          api_access_token: payload.chatwootApiToken,
        },
        body: JSON.stringify({
          inbox_id:   payload.chatwootInboxId,
          contact_id: contactId,
        }),
      },
    );
    const created = await newConv.json() as { id: string };
    conversationId = created.id;
  }

  // Send message
  await fetch(
    `${payload.chatwootBaseUrl}/api/v1/conversations/${conversationId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type":   "application/json",
        api_access_token: payload.chatwootApiToken,
      },
      body: JSON.stringify({
        content:      payload.message,
        message_type: "outgoing",
        private:      false,
      }),
    },
  );
}

// Build booking confirmation message for WhatsApp
export function buildBookingConfirmationMessage(params: {
  brandName:   string;
  pnr:         string;
  origin:      string;
  destination: string;
  departureTime: string;
  passengerNames: string[];
  totalAmount: number;
  currency:    string;
}): string {
  const currSym = params.currency === "INR" ? "₹" : params.currency === "AED" ? "د.إ" : "$";
  const depDate = new Date(params.departureTime).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });

  return [
    `✅ *Booking Confirmed — ${params.brandName}*`,
    "",
    `*PNR:* ${params.pnr}`,
    `*Route:* ${params.origin} → ${params.destination}`,
    `*Date:* ${depDate}`,
    `*Passengers:* ${params.passengerNames.join(", ")}`,
    `*Total Paid:* ${currSym}${params.totalAmount.toLocaleString("en-IN")}`,
    "",
    "Your e-ticket has been sent to your email. Safe travels! ✈️",
  ].join("\n");
}
