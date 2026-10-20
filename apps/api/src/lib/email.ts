// All email goes through here: Resend (https://resend.com) with the sender
// set in Admin → Settings → Email, one branded layout, duplicate protection
// (Resend Idempotency-Key) and a log of every send in email_logs.
// Never throws — a failed email must not fail the request or job that sent it.

import { eq } from "drizzle-orm";
import { emailLogs, tenants } from "@poomas/db/schema";
import type { Env, Variables } from "../types.js";

type Db = Variables["db"];

export type EmailCategory = "auth" | "booking" | "refund" | "payment" | "agency" | "wallet" | "alert" | "admin" | "test" | "general";

export interface EmailSettings {
  enabled: boolean;
  apiKey: string;          // optional override of the RESEND_API_KEY secret
  fromName: string;
  fromEmail: string;       // must be on a domain verified in Resend
  replyTo: string;
  bccOps: string;          // optional copy of booking / refund emails to the operations inbox
}

export const DEFAULT_EMAIL_SETTINGS: EmailSettings = { enabled: true, apiKey: "", fromName: "FlyPoomas", fromEmail: "", replyTo: "", bccOps: "" };

const settingsKey = (tenantId: string) => `admin_settings:${tenantId}:email`;

export async function getEmailSettings(env: Env, tenantId: string): Promise<EmailSettings> {
  const saved = await env.TENANT_CACHE_KV.get(settingsKey(tenantId), "json").catch(() => null) as Partial<EmailSettings> | null;
  return { ...DEFAULT_EMAIL_SETTINGS, ...(saved ?? {}) };
}

export async function saveEmailSettings(env: Env, tenantId: string, s: EmailSettings) {
  await env.TENANT_CACHE_KV.put(settingsKey(tenantId), JSON.stringify(s));
}

export function resendKey(env: Env, s: EmailSettings) {
  return s.apiKey || env.RESEND_API_KEY || "";
}

export interface MailMessage {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  category: EmailCategory;
  idempotencyKey?: string;   // same key within 24 h → Resend sends once
  replyTo?: string;
  copyOps?: boolean;         // BCC the operations inbox (if set)
  attachments?: { filename: string; content: string }[];   // content base64
}

export interface MailResult { ok: boolean; id?: string; error?: string; skipped?: boolean }

const isEmail = (v: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v);

async function fromAddress(db: Db, tenantId: string | null, s: EmailSettings, env: Env) {
  let address = s.fromEmail || env.EMAIL_FROM || "";
  if (!address && tenantId) {
    // White-label tenants send from their own (Resend-verified) domain.
    const [t] = await db.select({ customDomain: tenants.customDomain }).from(tenants).where(eq(tenants.id, tenantId)).limit(1).catch(() => [] as { customDomain: string | null }[]);
    address = `bookings@${t?.customDomain ?? "flypoomas.com"}`;
  }
  address ||= "bookings@flypoomas.com";
  const name = (s.fromName || "FlyPoomas").replace(/["<>]/g, "");
  return `${name} <${address}>`;
}

export async function sendMail(env: Env, db: Db, tenantId: string | null, msg: MailMessage): Promise<MailResult> {
  const to = (Array.isArray(msg.to) ? msg.to : [msg.to]).map((x) => x.trim()).filter(isEmail);
  const s = tenantId ? await getEmailSettings(env, tenantId) : DEFAULT_EMAIL_SETTINGS;
  const key = resendKey(env, s);
  let result: MailResult;
  if (!to.length) result = { ok: false, skipped: true, error: "No valid recipient" };
  else if (!s.enabled) result = { ok: false, skipped: true, error: "Email is turned off in Admin → Settings → Email" };
  else if (!key) result = { ok: false, skipped: true, error: "RESEND_API_KEY is not set" };
  else {
    try {
      const replyTo = msg.replyTo || s.replyTo || env.EMAIL_REPLY_TO || "";
      const bcc = msg.copyOps && s.bccOps && isEmail(s.bccOps) ? [s.bccOps] : [];
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`, "Content-Type": "application/json",
          ...(msg.idempotencyKey ? { "Idempotency-Key": msg.idempotencyKey.slice(0, 256) } : {}),
        },
        body: JSON.stringify({
          from: await fromAddress(db, tenantId, s, env), to, subject: msg.subject.slice(0, 250), html: msg.html,
          text: msg.text ?? htmlToText(msg.html),
          ...(replyTo && isEmail(replyTo) ? { reply_to: replyTo } : {}),
          ...(bcc.length ? { bcc } : {}),
          ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
          tags: [{ name: "category", value: msg.category }],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.json().catch(() => ({})) as { id?: string; message?: string; name?: string };
      result = res.ok ? { ok: true, id: body.id } : { ok: false, error: `Resend ${res.status}: ${body.message ?? body.name ?? "error"}` };
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : "Email failed" };
    }
  }
  if (!result.ok) console.error(`[email] ${msg.category} "${msg.subject}" not sent:`, result.error);
  try {
    await db.insert(emailLogs).values({
      tenantId, toEmail: (to.length ? to : [String(msg.to)]).join(", ").slice(0, 300), subject: msg.subject.slice(0, 250), category: msg.category,
      status: result.ok ? "SENT" : result.skipped ? "SKIPPED" : "FAILED", providerId: result.id ?? null, error: result.error?.slice(0, 500) ?? null,
    });
  } catch (err) {
    console.error("[email] log failed", err);
  }
  return result;
}

// Plain-text part from the HTML (better deliverability than HTML-only mail).
export function htmlToText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/td>\s*<td[^>]*>/gi, ": ")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => `${label.replace(/<[^>]+>/g, "").trim()} (${href})`)
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr|\/li)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));

// Branded, email-client-safe layout (tables + inline styles).
export function emailLayout(opts: {
  title: string; body: string; cta?: { label: string; href: string }; rows?: [string, string][]; preheader?: string; footerNote?: string;
}) {
  const rows = opts.rows?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:16px 0;font-size:14px">${opts.rows.map(([k, v]) =>
      `<tr><td style="padding:8px 0;color:#64748b;border-bottom:1px solid #eef2f7;width:42%">${esc(k)}</td><td style="padding:8px 0;color:#0f172a;font-weight:600;border-bottom:1px solid #eef2f7">${esc(v)}</td></tr>`).join("")}</table>`
    : "";
  const cta = opts.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0"><tr><td style="border-radius:8px;background:#E31E24"><a href="${esc(opts.cta.href)}" style="display:inline-block;padding:12px 22px;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;border-radius:8px">${esc(opts.cta.label)}</a></td></tr></table>
<p style="font-size:12px;color:#94a3b8;margin:0 0 8px">If the button doesn't work, copy this link: <br><a href="${esc(opts.cta.href)}" style="color:#64748b;word-break:break-all">${esc(opts.cta.href)}</a></p>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title></head>
<body style="margin:0;padding:0;background:#f4f6fa">
${opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(opts.preheader)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<tr><td style="padding:20px 28px;border-bottom:3px solid #E31E24"><img src="https://flypoomas.com/logo.png" alt="FlyPoomas" height="32" style="display:block;height:32px"></td></tr>
<tr><td style="padding:26px 28px 8px">
<h1 style="font-size:21px;line-height:1.3;margin:0 0 14px;color:#0f172a">${esc(opts.title)}</h1>
<div style="font-size:15px;line-height:1.6;color:#334155">${opts.body}</div>
${rows}${cta}
</td></tr>
<tr><td style="padding:16px 28px 22px;border-top:1px solid #eef2f7;font-size:12px;line-height:1.6;color:#94a3b8">
${opts.footerNote ? `${esc(opts.footerNote)}<br>` : ""}FlyPoomas · <a href="https://flypoomas.com" style="color:#94a3b8">flypoomas.com</a> · Reply to this email if you need help.
</td></tr></table></td></tr></table></body></html>`;
}
