"use client";
import { useEffect, useState } from "react";
import { API, apiHeaders } from "../../../lib/api";
type Readiness = {
  configured: boolean;
  gatesReady: boolean;
  enabled: boolean;
  requestedEnabled: boolean;
  environment: string;
  connectionHealth: string;
};
export function PhonePeSettings() {
  const [data, setData] = useState<Readiness | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch(`${API}/api/admin/settings/phonepe`, { headers: apiHeaders() })
      .then(async (r) => {
        if (!r.ok)
          throw new Error("PhonePe settings unavailable for this account");
        return r.json();
      })
      .then((d) => {
        setData(d);
        setEnabled(d.requestedEnabled);
      })
      .catch((e) => setNotice(e.message));
  }, []);
  async function save() {
    setBusy(true);
    setNotice("");
    try {
      const r = await fetch(`${API}/api/admin/settings/phonepe`, {
        method: "PUT",
        headers: apiHeaders(),
        body: JSON.stringify({ enabled }),
      });
      if (!r.ok)
        throw new Error(
          "PhonePe remains disabled until all release gates pass",
        );
      setNotice("PhonePe setting saved");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="PhonePe settings"
      style={{
        background: "#0f172a",
        border: "1px solid #334155",
        borderRadius: 10,
        padding: 16,
        marginBottom: 16,
      }}
    >
      <h3 style={{ color: "#e2e8f0", marginBottom: 8 }}>
        PhonePe PG V2 Standard Checkout
      </h3>
      <p style={{ color: "#94a3b8", fontSize: 13, lineHeight: 1.6 }}>
        Environment: {data?.environment ?? "sandbox"} · Currency: INR
        <br />
        Backend credentials:{" "}
        {data?.configured ? "Provisioned" : "Not provisioned"} · Connection:{" "}
        {data?.connectionHealth ?? "NOT_VERIFIED"}
        <br />
        Release gates:{" "}
        {data?.gatesReady
          ? "Passed"
          : "Pending schema, merchant activation and deployment approval"}
      </p>
      <p style={{ color: "#94a3b8", fontSize: 13, margin: "10px 0" }}>
        Credentials are managed in protected backend secrets. Payment success
        does not confirm a supplier booking.
      </p>
      <label style={{ color: "#e2e8f0", display: "block", margin: "10px 0" }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!data?.gatesReady || busy}
          onChange={(e) => setEnabled(e.target.checked)}
        />{" "}
        Enable PhonePe
      </label>
      <button
        type="button"
        disabled={!data || busy}
        onClick={save}
        style={{
          padding: "9px 14px",
          borderRadius: 8,
          color: "white",
          background: "#0D4B96",
          cursor: "pointer",
        }}
      >
        Save PhonePe setting
      </button>
      {notice && (
        <p role="status" style={{ color: "#cbd5e1", marginTop: 10 }}>
          {notice}
        </p>
      )}
    </section>
  );
}
