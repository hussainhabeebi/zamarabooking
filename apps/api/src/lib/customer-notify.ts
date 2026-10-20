// Customer / agency / staff messages: email via Resend (lib/email.ts) and
// WhatsApp via the tenant's Leadvyne/Chatwoot inbox, whichever is available.
// Never throws — a failed message must not fail the request or job that sent it.

import { leadvyneConfigs, tenants } from "@poomas/db/schema";
import { and, eq } from "drizzle-orm";
import type { Db } from "@poomas/db";
import type { Env } from "../types.js";
import { sendWhatsApp } from "./notify.js";
import { emailLayout, sendMail, type EmailCategory } from "./email.js";

export const WEB_URL = "https://flypoomas.com";
export const API_URL = "https://api.flypoomas.com";

export interface CustomerMessage {
  email?: string | null;
  phone?: string | null;
  subject: string;
  html: string;
  whatsapp: string;
  category?: EmailCategory;
  idempotencyKey?: string;   // Resend sends once per key within 24 h
  copyOps?: boolean;         // BCC the operations inbox
}

export async function notifyCustomer(env: Env, db: Db, tenantId: string, msg: CustomerMessage): Promise<{ email: boolean; whatsapp: boolean }> {
  const sent = { email: false, whatsapp: false };
  if (msg.email) {
    const r = await sendMail(env, db, tenantId, {
      to: msg.email, subject: msg.subject, html: msg.html, category: msg.category ?? "general",
      ...(msg.idempotencyKey ? { idempotencyKey: msg.idempotencyKey } : {}), ...(msg.copyOps ? { copyOps: true } : {}),
    });
    sent.email = r.ok;
  }
  if (msg.phone) {
    try {
      const [wa] = await db.select({
        chatwootBaseUrl: leadvyneConfigs.chatwootBaseUrl,
        chatwootInboxId: leadvyneConfigs.chatwootInboxId,
        chatwootApiToken: leadvyneConfigs.chatwootApiToken,
      }).from(leadvyneConfigs)
        .where(and(eq(leadvyneConfigs.tenantId, tenantId), eq(leadvyneConfigs.isActive, true))).limit(1);
      if (wa?.chatwootBaseUrl && wa.chatwootInboxId && wa.chatwootApiToken) {
        await sendWhatsApp({
          phone: msg.phone, message: msg.whatsapp,
          chatwootBaseUrl: wa.chatwootBaseUrl, chatwootInboxId: wa.chatwootInboxId, chatwootApiToken: wa.chatwootApiToken,
        });
        sent.whatsapp = true;
      }
    } catch (err) {
      console.error("[customer-notify] WhatsApp failed", err);
    }
  }
  return sent;
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));

export function money(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount)}`;
  }
}

// Branded email: every message uses the shared Resend layout (lib/email.ts).
export function emailShell(title: string, bodyHtml: string, cta?: { label: string; href: string }) {
  return emailLayout({ title, body: bodyHtml, ...(cta ? { cta } : {}) });
}
