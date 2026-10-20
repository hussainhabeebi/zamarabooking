// Shared inline styles for admin pages (dark theme).
import type { CSSProperties } from "react";

export const ui = {
  h1: { fontSize: 22, fontWeight: 700, color: "#f1f5f9", margin: "0 0 6px" } as CSSProperties,
  sub: { color: "#64748b", fontSize: 14, margin: "0 0 16px" } as CSSProperties,
  card: { background: "#1e293b", borderRadius: 12, padding: 16, border: "1px solid #334155", marginBottom: 16 } as CSSProperties,
  h2: { fontSize: 15, fontWeight: 700, color: "#f1f5f9", margin: "0 0 12px" } as CSSProperties,
  text: { color: "#e2e8f0", fontSize: 13 } as CSSProperties,
  muted: { color: "#64748b", fontSize: 12 } as CSSProperties,
  btn: { background: "#E31E24", color: "#fff", border: 0, borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" } as CSSProperties,
  ghost: { background: "#0f172a", border: "1px solid #334155", color: "#e2e8f0", borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" } as CSSProperties,
  input: { background: "#0f172a", border: "1px solid #334155", color: "#e2e8f0", borderRadius: 8, padding: "8px 10px", fontSize: 13, minWidth: 0 } as CSSProperties,
  chip: (on: boolean): CSSProperties => ({ border: "1px solid #334155", color: "#e2e8f0", borderRadius: 999, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: on ? "#E31E24" : "#1e293b" }),
  err: { background: "rgba(239,68,68,.1)", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 8, padding: "10px 12px", fontSize: 13, margin: "12px 0" } as CSSProperties,
  ok: { background: "rgba(34,197,94,.1)", border: "1px solid #14532d", color: "#86efac", borderRadius: 8, padding: "10px 12px", fontSize: 13, margin: "12px 0" } as CSSProperties,
  th: { textAlign: "left", color: "#64748b", fontSize: 11, textTransform: "uppercase", padding: "8px 10px", borderBottom: "1px solid #334155", whiteSpace: "nowrap" } as CSSProperties,
  td: { color: "#e2e8f0", fontSize: 13, padding: "9px 10px", borderBottom: "1px solid #1f2a3c", verticalAlign: "top" } as CSSProperties,
  label: { display: "flex", flexDirection: "column", gap: 4, color: "#94a3b8", fontSize: 12, fontWeight: 600 } as CSSProperties,
};

export const STATUS_COLOR: Record<string, string> = {
  OPEN: "#f87171", IN_PROGRESS: "#fbbf24", QUOTED: "#60a5fa", APPROVED: "#4ade80", DONE: "#4ade80", REJECTED: "#94a3b8", CLOSED: "#94a3b8",
};

export function money(n: number | string | null | undefined, cur = "INR") {
  const v = Number(n ?? 0);
  try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(v); } catch { return `${cur} ${v}`; }
}

export const REQUEST_TYPE_LABEL: Record<string, string> = {
  DEPOSIT: "Deposit", VISA: "Visa", PACKAGE: "Holiday package", UMRAH: "Umrah", HOTEL: "Hotel", INSURANCE: "Insurance", BUS: "Bus",
  GROUP: "Group booking", CHARTER: "Charter", AMENDMENT: "Booking change", OFFLINE_BOOKING: "Offline booking", SUPPORT: "Support", LEAD: "Customer lead",
};
