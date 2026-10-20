"use client";

// "📷 Scan passport / ID" — photograph or upload a passport or ID card and the
// traveller's details fill in (read by Gemini on our API; nothing is stored).
// Large phone photos are shrunk in the browser before upload.

import { useEffect, useRef, useState } from "react";

export type ScannedTraveller = {
  documentType: "PASSPORT" | "NATIONAL_ID" | "OTHER";
  firstName: string; lastName: string;
  dob: string | null; gender: "M" | "F" | null; nationality: string | null;
  documentNumber: string | null; expiryDate: string | null; issueDate: string | null;
  issuingCountry: string | null; mrzVerified: boolean; confidence: number; warnings: string[];
};

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
let statusPromise: Promise<boolean> | null = null;
function scanEnabled() {
  statusPromise ??= fetch(`${API}/api/ai/status`, { headers: { "x-tenant-slug": "poomas" } })
    .then((r) => r.json()).then((d) => Boolean(d?.documentScan)).catch(() => false);
  return statusPromise;
}

// Re-encode big photos as JPEG ≤ 1800 px (PDFs and HEIC go as they are).
async function shrink(file: File): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 900_000) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.88));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

export function ScanDocument({ onScanned, label = "📷 Scan passport / ID" }: { onScanned: (t: ScannedTraveller) => void; label?: string }) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState<{ ok: string; warnings: string[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { void scanEnabled().then(setEnabled); }, []);

  async function scan(file?: File) {
    if (!file) return;
    setBusy(true); setError(""); setNote(null);
    try {
      const blob = await shrink(file);
      const form = new FormData();
      form.append("file", blob, blob === file ? file.name : "document.jpg");
      const res = await fetch(`${API}/api/ai/scan-document`, { method: "POST", headers: { "x-tenant-slug": "poomas" }, body: form });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.traveller) { setError(typeof d.error === "string" ? d.error : "We couldn't read the document. Please type the details."); return; }
      const t = d.traveller as ScannedTraveller;
      onScanned(t);
      setNote({
        ok: t.mrzVerified ? "Filled from your passport — verified against its machine-readable lines." : "Filled from your document — please check every field.",
        warnings: t.warnings ?? [],
      });
    } catch {
      setError("We couldn't reach the server. Please type the details.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  if (!enabled) return null;
  return (
    <div className="scanDoc">
      <label className={busy ? "scanDocBtn scanDocBusy" : "scanDocBtn"}>
        {busy ? <><i className="scanDocSpin" aria-hidden="true" /> Reading document…</> : label}
        <input ref={inputRef} type="file" accept="image/*,application/pdf" disabled={busy}
          onChange={(e) => void scan(e.target.files?.[0])} />
      </label>
      {error && <p className="scanDocErr" role="alert">{error}</p>}
      {note && (
        <div className="scanDocNote" role="status">
          <b>✓ {note.ok}</b>
          {note.warnings.map((w) => <span key={w}>⚠ {w}</span>)}
        </div>
      )}
      <style>{`.scanDoc{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}.scanDocBtn{align-self:flex-start;display:inline-flex;align-items:center;gap:8px;background:#0f172a;color:#fff;border-radius:10px;padding:9px 13px;font-size:13px;font-weight:800;cursor:pointer}.scanDocBtn input{display:none}.scanDocBusy{opacity:.75;cursor:progress}.scanDocSpin{width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:scanDocSpin .7s linear infinite}@keyframes scanDocSpin{to{transform:rotate(360deg)}}.scanDocErr{margin:0;font-size:12px;color:#b91c1c}.scanDocNote{display:flex;flex-direction:column;gap:3px;font-size:12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:8px 10px;color:#166534}.scanDocNote span{color:#b45309}@media(prefers-reduced-motion:reduce){.scanDocSpin{animation:none}}`}</style>
    </div>
  );
}
