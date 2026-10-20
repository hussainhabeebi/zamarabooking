"use client";
import { useState } from "react";

interface Props {
  errorMessage?: string | null;
  requestSummary?: Record<string, unknown> | null;
  responseSnippet?: string | null;
  errorCode?: string | null;
}

export function LogDetail({ errorMessage, requestSummary, responseSnippet, errorCode }: Props) {
  const [copied, setCopied] = useState(false);

  const detailText = [
    requestSummary ? "--- request ---\n" + JSON.stringify(requestSummary, null, 2) : "",
    responseSnippet ? "--- response ---\n" + responseSnippet : "",
    errorMessage ? "--- error ---\n" + errorMessage : "",
  ].filter(Boolean).join("\n\n");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(detailText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  // Parse the reject reason out of the response snippet for prominent display.
  let rejectReason: string | undefined;
  if (errorCode === "BOOKING_REJECTED" && responseSnippet) {
    try {
      const raw = JSON.parse(responseSnippet);
      const msg =
        raw?.data?.order?.statusMessage ??
        raw?.data?.statusMessage ??
        raw?.status?.statusMessage ??
        raw?.order?.statusMessage;
      if (msg && String(msg).trim()) rejectReason = String(msg).trim();
    } catch {}
  }

  return (
    <div>
      {/* Full error message — no truncation */}
      {errorMessage && (
        <div style={{
          color: "#fca5a5", fontSize: 12, marginTop: 2,
          wordBreak: "break-word", lineHeight: 1.4,
        }}>
          {errorMessage}
        </div>
      )}

      {/* Parsed reject reason from TripJack response */}
      {rejectReason && rejectReason !== errorMessage && (
        <div style={{
          marginTop: 4, padding: "4px 8px",
          background: "rgba(239,68,68,.1)", borderLeft: "2px solid #ef4444",
          borderRadius: 3, color: "#f87171", fontSize: 11, lineHeight: 1.4,
        }}>
          <span style={{ fontWeight: 700, marginRight: 4 }}>TripJack:</span>{rejectReason}
        </div>
      )}

      {/* Details expand with copy */}
      {(requestSummary || responseSnippet) && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ color: "#475569", fontSize: 11, cursor: "pointer", userSelect: "none" }}>
            Details
          </summary>
          <div style={{ position: "relative", marginTop: 4 }}>
            <button
              onClick={handleCopy}
              style={{
                position: "absolute", top: 6, right: 6, zIndex: 1,
                background: copied ? "rgba(74,222,128,.15)" : "#1e293b",
                color: copied ? "#4ade80" : "#94a3b8",
                border: `1px solid ${copied ? "#4ade80" : "#334155"}`,
                borderRadius: 4, padding: "2px 10px", fontSize: 10,
                cursor: "pointer", transition: "all .15s",
              }}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <pre style={{
              fontFamily: "monospace", fontSize: 11, color: "#94a3b8",
              whiteSpace: "pre-wrap", wordBreak: "break-all",
              background: "#0f172a", padding: "8px 8px 8px 8px",
              borderRadius: 4, maxHeight: 200, overflow: "auto",
              margin: 0,
            }}>
              {requestSummary ? "--- request ---\n" + JSON.stringify(requestSummary, null, 2) : ""}
              {responseSnippet ? "\n\n--- response ---\n" + responseSnippet : ""}
            </pre>
          </div>
        </details>
      )}
    </div>
  );
}
