// Company bank accounts that agencies pay into for wallet recharges
// (Admin → Wallet recharges → Bank accounts). Stored per tenant in KV.

import { z } from "zod";
import type { Env } from "../types.js";

export const bankAccountSchema = z.object({
  label:         z.string().trim().min(2).max(60),                 // e.g. "Emirates NBD · AED"
  bankName:      z.string().trim().min(2).max(80),
  accountName:   z.string().trim().min(2).max(120),
  accountNumber: z.string().trim().min(4).max(40),
  iban:          z.string().trim().max(40).optional().default(""),
  swift:         z.string().trim().max(15).optional().default(""),
  ifsc:          z.string().trim().max(15).optional().default(""),
  branch:        z.string().trim().max(120).optional().default(""),
  currency:      z.enum(["INR", "AED", "USD", "SAR", "QAR", "OMR", "KWD", "BHD"]),
  country:       z.string().trim().max(2).toUpperCase().optional().default(""),
  instructions:  z.string().trim().max(500).optional().default(""), // e.g. "Mention your agent number as reference"
  active:        z.boolean().default(true),
});

export type BankAccount = z.infer<typeof bankAccountSchema> & { id: string; createdAt: string; updatedAt: string };

const key = (tenantId: string) => `admin_settings:${tenantId}:bank_accounts`;

export async function getBankAccounts(env: Env, tenantId: string): Promise<BankAccount[]> {
  try {
    const list = await env.TENANT_CACHE_KV.get(key(tenantId), "json") as BankAccount[] | null;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function saveBankAccounts(env: Env, tenantId: string, list: BankAccount[]) {
  await env.TENANT_CACHE_KV.put(key(tenantId), JSON.stringify(list));
}

// What an agency sees: active accounts, its wallet currency first.
export function visibleAccounts(list: BankAccount[], walletCurrency: string) {
  return list.filter((a) => a.active)
    .sort((a, b) => Number(b.currency === walletCurrency) - Number(a.currency === walletCurrency))
    .map(({ createdAt: _c, updatedAt: _u, active: _a, ...rest }) => rest);
}
