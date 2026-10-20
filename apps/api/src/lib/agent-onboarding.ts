// Agency onboarding after first sign-in: required KYC documents and an
// automatically generated MOU (Memorandum of Understanding) that the agency
// admin reviews and accepts electronically.
//
// Settings live in KV (agent_onboarding:<tenant>) so the agent-programme
// config form can't overwrite them. The accepted MOU is frozen: a copy of the
// exact signed HTML is kept in R2 together with its SHA-256 hash.

import { eq } from "drizzle-orm";
import { agentDocuments } from "@poomas/db/schema";
import type { Env, Variables } from "../types.js";
import { escapeHtml } from "./customer-notify.js";
import type { ProgramConfig } from "./agent-program.js";

type Db = Variables["db"];

export const DOC_TYPES = ["GST_CERTIFICATE", "PAN", "TRADE_LICENSE", "EMIRATES_ID", "AADHAAR", "IATA_CERT", "BANK_PROOF", "OTHER"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_LABEL: Record<DocType, string> = {
  GST_CERTIFICATE: "GST registration certificate",
  PAN: "Company / owner PAN card",
  TRADE_LICENSE: "Trade licence / commercial registration",
  EMIRATES_ID: "Owner ID (Emirates ID, Iqama or passport)",
  AADHAAR: "Owner Aadhaar",
  IATA_CERT: "IATA / TIDS certificate",
  BANK_PROOF: "Bank proof (cancelled cheque or bank letter)",
  OTHER: "Other document",
};

export interface OnboardingConfig {
  enforce: boolean;                                   // send agency admins to onboarding until done
  kycRequired: { INDIA: DocType[]; GCC: DocType[] };
  requireMou: boolean;
  mouVersion: string;                                 // bump to ask every agency to sign again
  company: { legalName: string; address: string; registration: string; email: string; phone: string; signatory: string; signatoryTitle: string };
  extraClauses: string;                               // added to the MOU as numbered clauses (one per line)
  governingLaw: { INDIA: string; GCC: string };       // e.g. "the laws of India, courts of Mumbai"
}

export const DEFAULT_ONBOARDING: OnboardingConfig = {
  enforce: true,
  kycRequired: { INDIA: ["PAN", "GST_CERTIFICATE"], GCC: ["TRADE_LICENSE", "EMIRATES_ID"] },
  requireMou: true,
  mouVersion: "1",
  company: { legalName: "", address: "", registration: "", email: "", phone: "", signatory: "", signatoryTitle: "" },
  extraClauses: "",
  governingLaw: { INDIA: "the laws of India", GCC: "the laws of the United Arab Emirates" },
};

const key = (tenantId: string) => `agent_onboarding:${tenantId}`;

export async function getOnboarding(env: Env, tenantId: string): Promise<OnboardingConfig> {
  const saved = await env.TENANT_CACHE_KV.get(key(tenantId), "json").catch(() => null) as Partial<OnboardingConfig> | null;
  return {
    ...DEFAULT_ONBOARDING, ...(saved ?? {}),
    kycRequired: { ...DEFAULT_ONBOARDING.kycRequired, ...(saved?.kycRequired ?? {}) },
    company: { ...DEFAULT_ONBOARDING.company, ...(saved?.company ?? {}) },
    governingLaw: { ...DEFAULT_ONBOARDING.governingLaw, ...(saved?.governingLaw ?? {}) },
  };
}

export async function saveOnboarding(env: Env, tenantId: string, cfg: OnboardingConfig) {
  await env.TENANT_CACHE_KV.put(key(tenantId), JSON.stringify(cfg));
}

export interface MouAcceptance {
  version: string; acceptedAt: string; name: string; designation: string;
  userId: string | null; email: string | null; ip: string | null; userAgent: string | null; hash: string; r2Key: string;
}

type AgentRow = {
  id: string; businessName: string; ownerName: string; email: string; phone: string; region: string; currency: string;
  agentNumber?: string | null; iataCode?: string | null; creditLimit?: string | null; settings?: unknown; createdAt?: Date;
};

export async function onboardingStatus(env: Env, db: Db, tenantId: string, agent: AgentRow, cfg?: OnboardingConfig) {
  const c = cfg ?? await getOnboarding(env, tenantId);
  const docs = await db.select({ docType: agentDocuments.docType, verifiedAt: agentDocuments.verifiedAt }).from(agentDocuments).where(eq(agentDocuments.agentId, agent.id));
  const needed = agent.region === "INDIA" ? c.kycRequired.INDIA : c.kycRequired.GCC;
  const required = needed.map((t) => {
    const mine = docs.filter((d: { docType: string }) => d.docType === t);
    return { type: t, label: DOC_LABEL[t] ?? t, status: mine.some((d: { verifiedAt: Date | null }) => d.verifiedAt) ? "VERIFIED" : mine.length ? "UPLOADED" : "MISSING" };
  });
  const mou = ((agent.settings ?? {}) as { mou?: MouAcceptance }).mou;
  const mouAccepted = Boolean(mou && mou.version === c.mouVersion);
  const kycDone = required.every((r) => r.status !== "MISSING");
  return {
    enforce: c.enforce,
    required,
    kycDone,
    mou: { required: c.requireMou, version: c.mouVersion, accepted: mouAccepted, acceptedAt: mouAccepted ? mou!.acceptedAt : null, acceptedBy: mouAccepted ? mou!.name : null },
    complete: kycDone && (!c.requireMou || mouAccepted),
  };
}

export async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const fmt = (n: number, cur: string) => {
  try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(n); } catch { return `${cur} ${n}`; }
};
const longDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// The MOU body (no signature block): what the agency reviews and its hash covers.
export function renderMou(opts: {
  cfg: OnboardingConfig; tenant: { name: string; companyName?: string | null; supportEmail?: string | null; supportPhone?: string | null };
  agent: AgentRow; program: ProgramConfig; date?: Date;
}) {
  const { cfg, tenant, agent, program } = opts;
  const s = (agent.settings ?? {}) as { address?: string; gstNumber?: string; country?: string; displayCurrency?: string };
  const date = opts.date ?? new Date();
  const co = cfg.company;
  const company = co.legalName || tenant.companyName || tenant.name || "FlyPoomas";
  const e = (v: unknown) => escapeHtml(String(v ?? ""));
  const india = agent.region === "INDIA";
  const law = india ? cfg.governingLaw.INDIA : cfg.governingLaw.GCC;
  const credit = Number(agent.creditLimit ?? 0);
  const ref = `MOU-${agent.agentNumber ?? agent.id.slice(0, 8).toUpperCase()}-v${cfg.mouVersion}`;
  const extras = cfg.extraClauses.split("\n").map((l) => l.trim()).filter(Boolean);

  const clauses: [string, string][] = [
    ["Purpose", `${e(company)} (“FlyPoomas”) appoints the Agency as a non-exclusive sub-agent to search, book and sell air tickets and related travel services through the FlyPoomas agency portal, API and connected channels (including Leadvyne). This MOU sets out how both parties work together.`],
    ["Agency account", `The Agency is registered as <b>${e(agent.businessName)}</b> with agent number <b>${e(agent.agentNumber ?? "to be assigned")}</b>. The Agency is responsible for every login it creates and for all bookings made with its credentials, and will keep passwords confidential.`],
    ["Prices and currency", `Fares, taxes and fees are those shown in the portal at the time of booking and may change until ticketed. The Agency's account currency is <b>${e(s.displayCurrency || agent.currency)}</b>; amounts in other currencies use FlyPoomas' published exchange rate on the day. The Agency may add its own service charge to its customers but must not misrepresent airline fares or taxes.`],
    ["Wallet, payment and credit", `Bookings are paid from the Agency's prepaid wallet, recharged by card (Nomod) or bank transfer to the accounts listed in the portal. Bank transfers are credited after FlyPoomas verifies the payment. ${credit > 0 ? `FlyPoomas grants a credit limit of <b>${fmt(credit, agent.currency)}</b>, to be repaid within <b>${program.creditDays} days</b>; overdue amounts may lead to suspension of booking.` : `No credit limit is granted unless agreed in writing; any credit granted is to be repaid within ${program.creditDays} days.`}`],
    ["Tickets, changes and refunds", "Tickets are issued under the airline's fare rules. Cancellations, date changes and refunds follow those rules plus FlyPoomas' service fee shown in the portal. Refunds are credited to the Agency wallet once received from the airline. No-shows and non-refundable fares are not refundable."],
    ["Agency obligations", "The Agency will enter passenger names and documents exactly as in the passport, check visa, transit and health requirements with its customers, collect payment from its customers at its own risk, and comply with airline, IATA and local regulations."],
    ["KYC and compliance", `The Agency has provided its business registration and owner identity documents and will inform FlyPoomas of any change. FlyPoomas may suspend an account for suspected fraud, chargebacks, misuse or unpaid dues. ${india ? "GST and TDS" : "VAT"} will be applied as required by law.`],
    ["Data protection", "Each party will use passenger personal data only to provide the travel service, keep it secure, and not sell or share it except with airlines, suppliers and authorities as required."],
    ["Term and termination", "This MOU starts on the date it is accepted and continues until ended by either party with 30 days' written notice (email is sufficient). Bookings made before termination remain payable and refundable under these terms; the wallet balance is refunded after outstanding dues are settled."],
    ["Liability", "FlyPoomas is not liable for airline schedule changes, cancellations, overbooking or denied boarding, but will help the Agency claim what the airline offers. Neither party is liable for indirect or consequential loss."],
    ...extras.map((x, i) => [`Additional term ${i + 1}`, e(x)] as [string, string]),
    ["Governing law", `This MOU is governed by ${e(law)}. Both parties will first try to settle any dispute amicably within 30 days.`],
    ["Electronic acceptance", "The Agency accepts this MOU electronically in the FlyPoomas portal. The acceptance record (name, designation, date and time, IP address and a SHA-256 fingerprint of this document) is binding as a signature."],
  ];

  const party = (rows: [string, string | null | undefined][]) => rows.filter(([, v]) => v).map(([k, v]) => `<tr><td class="k">${e(k)}</td><td>${e(v)}</td></tr>`).join("");
  const html = `<article class="mou">
<style>
.mou{font-family:Georgia,'Times New Roman',serif;color:#111827;line-height:1.55;font-size:14px;max-width:800px;margin:auto}
.mou h1{font-size:22px;text-align:center;margin:0 0 4px;letter-spacing:.02em}
.mou .ref{text-align:center;color:#6b7280;font-size:12px;margin:0 0 18px;font-family:Arial,sans-serif}
.mou h2{font-size:15px;margin:18px 0 6px}
.mou table.p{width:100%;border-collapse:collapse;margin:4px 0 10px;font-family:Arial,sans-serif;font-size:13px}
.mou table.p td{padding:3px 6px;vertical-align:top}.mou table.p td.k{color:#6b7280;width:38%}
.mou .parties{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:640px){.mou .parties{grid-template-columns:1fr}}
.mou ol{padding-left:20px}.mou li{margin:0 0 8px}
</style>
<h1>Memorandum of Understanding</h1>
<p class="ref">${e(ref)} · ${e(longDate(date))}</p>
<p>This Memorandum of Understanding is made between the following parties:</p>
<div class="parties">
<div><h2>FlyPoomas</h2><table class="p">${party([["Legal name", company], ["Address", co.address], ["Registration", co.registration], ["Email", co.email || tenant.supportEmail], ["Phone", co.phone || tenant.supportPhone]])}</table></div>
<div><h2>The Agency</h2><table class="p">${party([["Business name", agent.businessName], ["Agent number", agent.agentNumber], ["Owner", agent.ownerName], ["Email", agent.email], ["Phone", agent.phone], ["Address", s.address], [india ? "GSTIN" : "Tax / VAT no.", s.gstNumber], ["IATA code", agent.iataCode]])}</table></div>
</div>
<ol>${clauses.map(([t, body]) => `<li><b>${e(t)}.</b> ${body}</li>`).join("")}</ol>
</article>`;
  return { html, ref, company };
}

// Signature block appended to the frozen copy once the agency accepts.
export function signatureBlock(opts: { company: string; cfg: OnboardingConfig; acceptance: MouAcceptance; agentName: string }) {
  const { company, cfg, acceptance: a } = opts;
  const e = (v: unknown) => escapeHtml(String(v ?? ""));
  const when = new Date(a.acceptedAt).toUTCString();
  return `<section class="mou" style="font-family:Arial,sans-serif;font-size:13px;margin-top:24px;border-top:2px solid #111827;padding-top:12px">
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
<div><b>For FlyPoomas</b><br>${e(cfg.company.signatory || company)}${cfg.company.signatoryTitle ? `<br>${e(cfg.company.signatoryTitle)}` : ""}<br><span style="color:#6b7280">Issued electronically</span></div>
<div><b>For ${e(opts.agentName)}</b><br>${e(a.name)}<br>${e(a.designation)}<br><span style="color:#6b7280">Accepted electronically ${e(when)}${a.ip ? ` from IP ${e(a.ip)}` : ""}</span></div>
</div>
<p style="color:#6b7280;font-size:11px;margin-top:10px">Document fingerprint (SHA-256): ${e(a.hash)}</p>
</section>`;
}

export function printablePage(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;padding:24px;background:#fff}@media print{body{padding:0}}</style></head><body>${body}</body></html>`;
}
