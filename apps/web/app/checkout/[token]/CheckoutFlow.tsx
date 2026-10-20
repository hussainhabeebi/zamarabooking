"use client";

import { useMemo, useState } from "react";
import CheckoutClient from "./CheckoutClient";

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";

export type CheckoutPassenger = {
  id: string;
  passengerType: string;
  firstName: string;
  lastName: string;
  title?: string | null;
  dob?: string | null;
  gender?: string | null;
  nationality?: string | null;
  passportNumber?: string | null;
  passportExpiry?: string | null;
  passportCountry?: string | null;
};

type Props = {
  bookingId: string;
  token: string;
  passengers: CheckoutPassenger[];
  totalAmount: string;
  currency: string;
  currencySymbol: string;
  contactEmail: string;
  contactPhone: string;
  whatsappPhone: string;
};

type Step = "passengers" | "review" | "payment";
type EditablePassenger = CheckoutPassenger & { confidence?: number; scanning?: boolean; scanError?: string };

export default function CheckoutFlow(props: Props) {
  const [step, setStep] = useState<Step>("passengers");
  const [email, setEmail] = useState(props.contactEmail);
  const [phone, setPhone] = useState(props.contactPhone || props.whatsappPhone);
  const [passengers, setPassengers] = useState<EditablePassenger[]>(props.passengers);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const stepNumber = step === "passengers" ? 2 : step === "review" ? 3 : 4;

  const valid = useMemo(() => passengers.length > 0 && passengers.every((p) =>
    p.firstName.trim() && p.lastName.trim() && p.passportNumber?.trim() &&
    p.nationality?.trim() && p.dob && p.passportExpiry
  ) && /\S+@\S+\.\S+/.test(email) && phone.replace(/\D/g, "").length >= 8, [passengers, email, phone]);

  function patch(id: string, values: Partial<EditablePassenger>) {
    setPassengers((all) => all.map((p) => p.id === id ? { ...p, ...values } : p));
  }

  async function scanPassport(id: string, file?: File) {
    if (!file) return;
    patch(id, { scanning: true, scanError: "" });
    const form = new FormData();
    form.append("passport", file);
    form.append("passengerId", id);
    try {
      const res = await fetch(`${API}/api/checkout/session/${props.token}/passport-extract`, {
        method: "POST",
        headers: { "x-tenant-slug": "poomas", "X-Checkout-Token": props.token },
        body: form,
      });
      const data = await res.json() as any;
      if (!res.ok) throw new Error(data.error || data.message || "Passport scan failed");
      const x = data.extracted || {};
      const confidence = Math.min(
        Number(x.confidence?.name ?? 0),
        Number(x.confidence?.passportNumber ?? 0),
        Number(x.confidence?.dateOfBirth ?? 0),
        Number(x.confidence?.expiryDate ?? 0),
      );
      patch(id, {
        firstName: x.givenNames || "",
        lastName: x.surname || "",
        dob: x.dateOfBirth || "",
        gender: x.gender || "",
        nationality: x.nationality || "",
        passportNumber: x.passportNumber || "",
        passportExpiry: x.expiryDate || "",
        passportCountry: x.countryOfIssue || "",
        confidence,
        scanning: false,
      });
    } catch (e: any) {
      patch(id, { scanning: false, scanError: e.message });
    }
  }

  async function saveAndReview() {
    if (!valid) {
      setError("Complete the contact and required passport fields for every passenger.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`${API}/api/checkout/session/${props.token}/passengers`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-slug": "poomas",
          "X-Checkout-Token": props.token,
        },
        body: JSON.stringify({
          contactEmail: email,
          contactPhone: phone,
          passengers: passengers.map(({ scanning, scanError, confidence, ...p }) => p),
        }),
      });
      const body = await res.json().catch(() => ({})) as any;
      if (!res.ok) throw new Error(body.error || body.message || "Passenger details could not be saved");
      setStep("review");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  return (
    <>
      <div className="steps" aria-label="Checkout progress">
        {["Flight", "Passengers", "Review", "Payment"].map((label, i) => (
          <div className={i + 1 <= stepNumber ? "step active" : "step"} key={label}>
            <span>{i + 1 < stepNumber ? "✓" : i + 1}</span><small>{label}</small>
          </div>
        ))}
      </div>

      {step === "passengers" && (
        <>
          <section className="panel">
            <div className="eyebrow">Contact details</div>
            <div className="grid">
              <Field label="Email">
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
              </Field>
              <Field label="Mobile / WhatsApp">
                <input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="971501234567" />
              </Field>
            </div>
          </section>

          {passengers.map((p, index) => (
            <section className="panel" key={p.id}>
              <div className="passengerHead">
                <div><div className="eyebrow">{p.passengerType} {index + 1}</div><strong>Passenger details</strong></div>
                <label className="scan">
                  {p.scanning ? "Reading passport…" : "📷 Scan passport"}
                  <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment"
                    disabled={p.scanning} onChange={(e) => scanPassport(p.id, e.target.files?.[0])} />
                </label>
              </div>
              <p className="privacy">Gemini fills the form. The passport file is processed securely and is not stored.</p>
              {p.scanError && <div className="error">{p.scanError}</div>}
              {p.confidence != null && (
                <div className={p.confidence < .75 ? "confidence warn" : "confidence"}>
                  {p.confidence < .75 ? "⚠ Check highlighted data carefully" : "✓ Passport details extracted"} · {Math.round(p.confidence * 100)}% confidence
                </div>
              )}
              <div className="grid">
                <Field label="Given names"><input value={p.firstName} onChange={(e) => patch(p.id, { firstName: e.target.value })} /></Field>
                <Field label="Surname"><input value={p.lastName} onChange={(e) => patch(p.id, { lastName: e.target.value })} /></Field>
                <Field label="Date of birth"><input type="date" value={dateValue(p.dob)} onChange={(e) => patch(p.id, { dob: e.target.value })} /></Field>
                <Field label="Gender"><select value={p.gender || ""} onChange={(e) => patch(p.id, { gender: e.target.value })}><option value="">Select</option><option value="M">Male</option><option value="F">Female</option><option value="X">Other</option></select></Field>
                <Field label="Passport number"><input value={p.passportNumber || ""} onChange={(e) => patch(p.id, { passportNumber: e.target.value.toUpperCase() })} /></Field>
                <Field label="Nationality"><input value={p.nationality || ""} maxLength={3} onChange={(e) => patch(p.id, { nationality: e.target.value.toUpperCase() })} placeholder="IND" /></Field>
                <Field label="Passport expiry"><input type="date" value={dateValue(p.passportExpiry)} onChange={(e) => patch(p.id, { passportExpiry: e.target.value })} /></Field>
                <Field label="Issuing country"><input value={p.passportCountry || ""} maxLength={3} onChange={(e) => patch(p.id, { passportCountry: e.target.value.toUpperCase() })} placeholder="IND" /></Field>
              </div>
            </section>
          ))}

          {error && <div className="error">{error}</div>}
          <button className="primary" disabled={saving} onClick={saveAndReview}>{saving ? "Saving…" : "Review booking →"}</button>
        </>
      )}

      {step === "review" && (
        <section className="panel">
          <div className="eyebrow">Review before payment</div>
          <h2>Confirm passenger details</h2>
          <p className="privacy">Names and passport numbers must exactly match the travel documents.</p>
          {passengers.map((p, i) => (
            <div className="review" key={p.id}>
              <div><strong>{i + 1}. {p.firstName.toUpperCase()} {p.lastName.toUpperCase()}</strong><small>{p.passengerType} · {p.nationality} · DOB {dateValue(p.dob)}</small></div>
              <div><strong>{maskPassport(p.passportNumber || "")}</strong><small>Expires {dateValue(p.passportExpiry)}</small></div>
            </div>
          ))}
          <div className="contactReview">{email} · {phone}</div>
          <label className="confirm"><input type="checkbox" id="exact-confirm" /> I confirm these details exactly match the passports.</label>
          <div className="actions">
            <button className="secondary" onClick={() => setStep("passengers")}>← Edit</button>
            <button className="primary" onClick={() => {
              const box = document.getElementById("exact-confirm") as HTMLInputElement;
              if (!box?.checked) { setError("Please confirm the passenger details."); return; }
              setError(""); setStep("payment"); window.scrollTo({ top: 0, behavior: "smooth" });
            }}>Continue to payment →</button>
          </div>
          {error && <div className="error">{error}</div>}
        </section>
      )}

      {step === "payment" && (
        <>
          <button className="backLink" onClick={() => setStep("review")}>← Back to review</button>
          <CheckoutClient {...props} contactEmail={email} contactPhone={phone} />
        </>
      )}

      <style jsx>{`
        .steps{display:flex;justify-content:space-between;position:relative;margin:0 0 18px;padding:0 8px}.steps:before{content:"";position:absolute;left:9%;right:9%;top:15px;height:2px;background:#e2e8f0}.step{z-index:1;text-align:center;color:#94a3b8}.step span{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:#e2e8f0;color:#64748b;font-weight:800;margin:auto}.step small{display:block;margin-top:5px;font-size:11px}.step.active span{background:#e31e24;color:#fff}.step.active small{color:#0f172a;font-weight:700}.panel{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:20px;margin-bottom:14px;box-shadow:0 8px 24px rgba(15,23,42,.05)}.eyebrow{text-transform:uppercase;letter-spacing:.08em;color:#64748b;font-size:11px;font-weight:800;margin-bottom:5px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}.passengerHead{display:flex;align-items:center;justify-content:space-between;gap:12px}.scan{background:#0f172a;color:#fff;padding:10px 14px;border-radius:10px;font-size:13px;font-weight:800;cursor:pointer}.scan input{display:none}.privacy{font-size:12px;color:#64748b;margin:8px 0 12px}.confidence{font-size:12px;padding:8px 10px;border-radius:8px;background:#ecfdf5;color:#047857}.confidence.warn{background:#fffbeb;color:#b45309}.error{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:10px;padding:11px 13px;font-size:13px;margin:10px 0}.primary,.secondary{border:0;border-radius:11px;padding:13px 18px;font-weight:800;font-size:14px;cursor:pointer}.primary{background:#e31e24;color:#fff}.primary:disabled{opacity:.6}.secondary{background:#e2e8f0;color:#334155}.actions{display:flex;justify-content:space-between;gap:10px;margin-top:18px}.review{display:flex;justify-content:space-between;gap:12px;padding:13px 0;border-bottom:1px solid #e2e8f0}.review small{display:block;color:#64748b;margin-top:4px}.contactReview{background:#f8fafc;border-radius:9px;padding:12px;margin:14px 0;font-size:13px;color:#475569}.confirm{display:flex;gap:9px;align-items:flex-start;font-size:13px;font-weight:600}.backLink{border:0;background:transparent;color:#475569;font-weight:700;margin:0 0 10px;cursor:pointer}@media(max-width:620px){.grid{grid-template-columns:1fr}.panel{padding:16px}.step small{font-size:9px}.review{flex-direction:column}.scan{padding:9px 11px}.actions .primary{flex:1}}`
      }</style>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}<style jsx>{`.field span{display:block;font-size:12px;font-weight:700;color:#475569;margin-bottom:5px}.field :global(input),.field :global(select){width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:10px;padding:11px 12px;background:#fff;color:#0f172a;font-size:14px;outline:none}.field :global(input:focus),.field :global(select:focus){border-color:#e31e24;box-shadow:0 0 0 3px #ffe4e6}`}</style></label>;
}

function dateValue(value?: string | null) {
  return value ? String(value).slice(0, 10) : "";
}
function maskPassport(value: string) {
  if (value.length <= 4) return value;
  return "••••" + value.slice(-4);
}
