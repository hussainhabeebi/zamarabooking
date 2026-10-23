"use client";
import { useEffect, useState } from "react";
import { API, apiHeaders } from "../lib/api";

type Status = {
  priority: number;
  environment: string;
  configured: boolean;
  connected: boolean;
  submittedIp: string;
  whitelistingStatus: string;
  blockers: string[];
};
const endpoint = `${API}/api/admin/integrations/akbar`;
const field = {
  background: "#0f172a",
  border: "1px solid #475569",
  color: "#f1f5f9",
  borderRadius: 8,
  padding: "10px 12px",
  width: "100%",
  minHeight: 44,
};
export function AkbarSupplierCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [priority, setPriority] = useState(100);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    setError("");
    try {
      const res = await fetch(endpoint, {
        headers: apiHeaders(),
        cache: "no-store",
      });
      if (!res.ok)
        throw new Error(
          res.status === 403
            ? "Full admin access is required."
            : "Unable to load Akbar configuration. Check API deployment and access.",
        );
      const data = (await res.json()) as Status;
      setStatus(data);
      setPriority(data.priority);
    } catch (e) {
      setStatus(null);
      setError(
        e instanceof Error ? e.message : "Unable to load Akbar configuration.",
      );
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ priority }),
      });
      if (!res.ok)
        throw new Error(
          res.status === 403
            ? "Full admin access is required."
            : "Priority was not saved. Enter a whole number from 1 to 1000.",
        );
      setStatus((s) => (s ? { ...s, priority } : s));
      setMessage("Priority saved. All live operations remain disabled.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save priority.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-labelledby="akbar-title"
      style={{
        background: "#1e293b",
        border: "1px solid #334155",
        borderRadius: 16,
        padding: 24,
        marginBottom: 24,
        color: "#e2e8f0",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <p
            style={{
              color: "#7dd3fc",
              fontSize: 12,
              letterSpacing: ".08em",
              margin: "0 0 6px",
            }}
          >
            FLIGHT SUPPLIER · TEST / UAT
          </p>
          <h2
            id="akbar-title"
            style={{ fontSize: 20, fontWeight: 700, margin: 0 }}
          >
            Akbar Travels / Benzy Infotech
          </h2>
        </div>
        <span
          style={{
            color: "#fde68a",
            background: "#422006",
            padding: "7px 12px",
            borderRadius: 999,
            fontSize: 12,
          }}
        >
          Mock-only · Not connected
        </span>
      </div>
      <p style={{ color: "#cbd5e1", lineHeight: 1.65, fontSize: 14 }}>
        Signature + Bearer Token authentication. Prepared for UAT; no live
        provider requests are enabled.
      </p>
      {status && (
        <>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
              gap: 16,
              margin: "20px 0",
            }}
          >
            <div>
              <dt style={{ color: "#94a3b8", fontSize: 12 }}>
                API configuration
              </dt>
              <dd style={{ margin: "5px 0 0" }}>
                Secure gateway not configured
              </dd>
            </div>
            <div>
              <dt style={{ color: "#94a3b8", fontSize: 12 }}>
                IP submitted for whitelisting
              </dt>
              <dd style={{ margin: "5px 0 0", fontFamily: "monospace" }}>
                {status.submittedIp}
              </dd>
            </div>
            <div>
              <dt style={{ color: "#94a3b8", fontSize: 12 }}>Whitelisting</dt>
              <dd style={{ margin: "5px 0 0", color: "#fde68a" }}>
                Pending confirmation
              </dd>
            </div>
            <div>
              <dt style={{ color: "#94a3b8", fontSize: 12 }}>
                Connection health
              </dt>
              <dd style={{ margin: "5px 0 0" }}>
                Not verified · No UAT test performed
              </dd>
            </div>
          </dl>
          <div
            style={{
              background: "#0f172a",
              borderRadius: 10,
              padding: 16,
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            <strong>UAT connection blockers</strong>
            <ul style={{ paddingLeft: 20, margin: "8px 0 0" }}>
              {status.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
          <form
            onSubmit={save}
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
              alignItems: "end",
              marginTop: 20,
            }}
          >
            <label
              style={{
                display: "grid",
                gap: 8,
                flex: "1 1 180px",
                maxWidth: 280,
                fontSize: 13,
              }}
            >
              Supplier priority (prepared only)
              <input
                aria-label="Akbar supplier priority"
                type="number"
                required
                min={1}
                max={1000}
                step={1}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                style={field}
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              style={{
                ...field,
                width: "auto",
                background: "#0D4B96",
                cursor: busy ? "wait" : "pointer",
              }}
            >
              {busy ? "Saving…" : "Save priority"}
            </button>
          </form>
          <p style={{ color: "#94a3b8", fontSize: 12, lineHeight: 1.6 }}>
            Priority has no effect on public search while Akbar is disabled.
            Credentials must be provisioned through protected backend secret
            storage after separate approval; no credential entry or retrieval is
            available here.
          </p>
        </>
      )}
      {!status && !error && <p role="status">Loading configuration…</p>}
      <div
        style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "18px 0" }}
      >
        {["Search", "Booking", "Ticketing", "Payments"].map((op) => (
          <span
            key={op}
            style={{
              fontSize: 12,
              color: "#cbd5e1",
              border: "1px solid #475569",
              borderRadius: 8,
              padding: "7px 10px",
            }}
          >
            {op}: Disabled
          </span>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <button
          disabled
          aria-describedby="akbar-test-help"
          style={{ ...field, width: "auto", opacity: 0.6 }}
        >
          Test UAT connection — unavailable
        </button>
        <button
          type="button"
          onClick={() => {
            void load();
          }}
          disabled={busy}
          style={{ ...field, width: "auto", cursor: "pointer" }}
        >
          Refresh readiness
        </button>
      </div>
      <p
        id="akbar-test-help"
        style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.6 }}
      >
        Refresh reads saved readiness metadata only. It does not contact Akbar
        or test the gateway.
      </p>
      {error && (
        <p role="alert" style={{ color: "#fca5a5" }}>
          {error}
        </p>
      )}
      {message && (
        <p role="status" style={{ color: "#86efac" }}>
          {message}
        </p>
      )}
    </section>
  );
}
