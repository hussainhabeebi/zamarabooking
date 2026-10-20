"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminApi } from "../../../lib/files";

// Permanently deletes an agency. The API refuses agencies with bookings,
// commissions or wallet movements (suspend those instead) and shows why.
export default function DeleteAgentButton({ agentId, businessName, apiPath = "/api/admin/agents", redirectTo, onDeleted, style }: {
  agentId: string; businessName: string; apiPath?: string; redirectTo?: string; onDeleted?: () => void; style?: React.CSSProperties;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!confirm(`Delete ${businessName} permanently?\n\nIts logins, wallet, documents, requests and agent number are removed. This can't be undone.`)) return;
    setBusy(true);
    try {
      await adminApi(`${apiPath}/${agentId}`, { method: "DELETE" });
      if (onDeleted) onDeleted();
      else if (redirectTo) router.push(redirectTo);
      else router.refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally { setBusy(false); }
  }

  return (
    <button type="button" disabled={busy} onClick={remove} style={{ ...danger, ...style }}>
      {busy ? "Deleting…" : "Delete"}
    </button>
  );
}

const danger: React.CSSProperties = {
  background: "rgba(239,68,68,.1)", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 8,
  padding: "4px 10px", fontWeight: 700, fontSize: 13, cursor: "pointer",
};
