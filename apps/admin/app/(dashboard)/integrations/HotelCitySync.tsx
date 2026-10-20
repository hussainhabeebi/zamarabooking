"use client";
import { useCallback, useEffect, useState } from "react";
import { API, apiHeaders } from "@/lib/api";

// TripJack Hotel v3 search takes hotel IDs, not cities. This builds the city →
// region index from TripJack's City Region IDs API (paged, a few pages per call).
export function HotelCitySync() {
  const [status, setStatus] = useState<{ ready: boolean; builtAt: string | null; cities: number; inProgress: boolean; pagesDone: number; regionsSoFar: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/admin/hotels/city-index`, { headers: apiHeaders() });
      if (res.ok) setStatus(await res.json());
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function sync(restart: boolean) {
    setRunning(true); setError(""); setProgress("Starting…");
    try {
      let first = true;
      for (let i = 0; i < 200; i++) {
        const res = await fetch(`${API}/api/admin/hotels/city-index/sync`, {
          method: "POST", headers: apiHeaders(), body: JSON.stringify({ restart: restart && first }),
        });
        first = false;
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`${d.error ?? `HTTP ${res.status}`}${d.errorCode ? ` (${d.errorCode})` : ""}${d.requestId ? ` · request ${d.requestId}` : ""}`);
        setProgress(`${d.pages} pages · ${Number(d.regions).toLocaleString()} regions`);
        if (d.done) { setProgress(`Done — ${Number(d.cities).toLocaleString()} cities`); break; }
      }
    } catch (e: any) {
      setError(`${e.message} — see Supplier logs for TripJack's full response`);
    } finally {
      setRunning(false); void load();
    }
  }

  return (
    <div style={{ border: "1px solid #334155", borderRadius: 10, padding: 14, margin: "16px 0" }}>
      <div style={{ fontWeight: 700, color: "#e2e8f0", marginBottom: 4 }}>Hotel city list (TripJack Hotel API v3)</div>
      <p style={{ color: "#94a3b8", fontSize: 13, margin: "0 0 10px", lineHeight: 1.5 }}>
        Hotel search needs TripJack&apos;s city → hotel ID list. Sync it once after setup, then about monthly.
        {status && (status.ready
          ? <> Current list: <b>{status.cities.toLocaleString()}</b> cities, synced {status.builtAt ? new Date(status.builtAt).toLocaleString() : ""}.</>
          : status.inProgress ? <> A sync is part-way ({status.pagesDone} pages) — press <b>Continue sync</b>.</>
          : <> <b style={{ color: "#fbbf24" }}>Not synced yet — hotel search will not work until it is.</b></>)}
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" disabled={running} onClick={() => sync(!status?.inProgress)}
          style={{ background: "#2563eb", color: "#fff", border: 0, borderRadius: 8, padding: "8px 14px", fontWeight: 700, cursor: "pointer" }}>
          {running ? "Syncing…" : status?.inProgress ? "Continue sync" : "Sync hotel cities"}
        </button>
        {progress && <span style={{ color: "#94a3b8", fontSize: 13 }}>{progress}</span>}
      </div>
      {error && <div style={{ color: "#fca5a5", fontSize: 13, marginTop: 8 }}>{error}</div>}
    </div>
  );
}
