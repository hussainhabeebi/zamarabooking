"use client";

import { useEffect, useState } from "react";

declare global {
  interface Window {
    Razorpay: new (opts: Record<string, unknown>) => { open(): void };
  }
}

interface Props {
  bookingId:      string;
  token:          string;
  totalAmount:    string;
  currency:       string;
  currencySymbol: string;
  contactEmail:   string;
  contactPhone:   string;
  whatsappPhone:  string;
}

type Gateway = "RAZORPAY" | "NOMOD";
type PaymentState = "idle" | "creating" | "paying" | "polling" | "success" | "failed";

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
const TENANT = "poomas";

export default function CheckoutClient({
  bookingId, token, totalAmount, currency, currencySymbol,
  contactEmail, contactPhone, whatsappPhone,
}: Props) {
  const [gateway,  setGateway]  = useState<Gateway>("NOMOD");
  const [available, setAvailable] = useState<Record<Gateway, boolean>>({ RAZORPAY: false, NOMOD: false });
  const [configLoading, setConfigLoading] = useState(true);
  const [state,    setState]    = useState<PaymentState>("idle");
  const [error,    setError]    = useState<string | null>(null);
  const [pnr,      setPnr]      = useState<string | null>(null);
  useEffect(() => {
    fetch(`${API}/api/payments/config`, {
      headers: { "x-tenant-slug": TENANT, "X-Checkout-Token": token },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("Unable to load payment methods");
        return res.json() as Promise<{ defaultGateway: Gateway | null; gateways: Record<Gateway, boolean> }>;
      })
      .then((config) => {
        setAvailable(config.gateways);
        if (config.defaultGateway) setGateway(config.defaultGateway);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setConfigLoading(false));
  }, [token]);

  async function ensureRazorpay() {
    if (window.Razorpay) return;
    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>('script[src*="checkout.razorpay.com"]');
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("Payment service failed to load")), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Payment service failed to load"));
      document.head.appendChild(script);
    });
  }


  async function initiatePayment() {
    setError(null);
    setState("creating");

    try {
      if (!available[gateway]) throw new Error("Selected payment method is not configured");
      // 1. Create payment order on the API
      const orderRes = await fetch(`${API}/api/payments/checkout`, {
        method:  "POST",
        headers: {
          "Content-Type":   "application/json",
          "x-tenant-slug":  TENANT,
          "X-Checkout-Token": token,
        },
        body: JSON.stringify({ bookingId, gateway, currency }),
      });

      if (!orderRes.ok) {
        const e = await orderRes.json() as { error?: string };
        throw new Error(e.error ?? `Failed to create order (${orderRes.status})`);
      }

      const order = await orderRes.json() as {
        orderId?:     string;
        keyId?:       string;
        paymentUrl?:  string;
        amount:       number;
        currency:     string;
      };

      if (gateway === "RAZORPAY" && order.orderId && order.keyId) {
        setState("paying");
        await ensureRazorpay();
        await openRazorpay(order.orderId, order.keyId, order.amount, order.currency);
      } else if (gateway === "NOMOD" && order.paymentUrl) {
        // NoMod: redirect to hosted payment page
        window.location.assign(order.paymentUrl);
      } else {
        throw new Error("Gateway returned unexpected response");
      }
    } catch (err: any) {
      setError(err.message);
      setState("idle");
    }
  }

  async function openRazorpay(orderId: string, keyId: string, amount: number, cur: string) {
    return new Promise<void>((resolve, reject) => {
      const rz = new window.Razorpay({
        key:         keyId,
        order_id:    orderId,
        amount,
        currency:    cur,
        name:        "POOMAS Flights",
        description: `Booking ${bookingId}`,
        image:       "/logo.png",
        prefill: {
          email: contactEmail,
          contact: contactPhone,
        },
        theme: { color: "#E31E24" },
        handler: async (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => {
          setState("polling");
          try {
            await verifyAndConfirm(response.razorpay_payment_id, response.razorpay_order_id, response.razorpay_signature);
            resolve();
          } catch (err: any) {
            setError(err.message);
            setState("failed");
            reject(err);
          }
        },
        modal: {
          ondismiss: () => {
            setState("idle");
            resolve();
          },
        },
      });
      rz.open();
    });
  }

  async function verifyAndConfirm(paymentId: string, orderId: string, signature: string) {
    const res = await fetch(`${API}/api/payments/verify`, {
      method:  "POST",
      headers: {
        "Content-Type":   "application/json",
        "x-tenant-slug":  TENANT,
        "X-Checkout-Token": token,
      },
      body: JSON.stringify({ bookingId, paymentId, orderId, signature, gateway: "RAZORPAY" }),
    });

    if (!res.ok) {
      const e = await res.json() as { error?: string };
      throw new Error(e.error ?? "Payment verification failed");
    }

    const result = await res.json() as { pnr?: string; status?: string };
    setPnr(result.pnr ?? null);
    setState("success");

    // Send e-ticket async (fire and forget)
    fetch(`${API}/api/eticket/${bookingId}/send`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "x-tenant-slug": TENANT, "X-Checkout-Token": token },
      body: JSON.stringify({
        channels:      whatsappPhone ? ["WHATSAPP", "EMAIL"] : ["EMAIL"],
        whatsappPhone: whatsappPhone || undefined,
        email:         contactEmail || undefined,
      }),
    }).catch(() => null);
  }

  // ── Render states ─────────────────────────────────────────────────────────

  if (state === "success") {
    return (
      <div style={{ ...card, textAlign: "center", padding: 40 }}>
        <div style={{ fontSize: 56, marginBottom: 16 }}>🎉</div>
        <h2 style={{ fontSize: 22, fontWeight: 800, color: "#16A34A", margin: "0 0 8px" }}>
          Booking Confirmed!
        </h2>
        {pnr && (
          <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a", margin: "0 0 8px" }}>
            PNR: <span style={{ color: "#E31E24" }}>{pnr}</span>
          </div>
        )}
        <p style={{ color: "#64748b", fontSize: 14, margin: "0 0 24px" }}>
          Your e-ticket has been sent to{whatsappPhone ? ` WhatsApp (${whatsappPhone})` : ""}
          {contactEmail ? ` and ${contactEmail}` : ""}.
        </p>
        <a href="/" style={{
          background: "#E31E24", color: "white", textDecoration: "none",
          padding: "12px 28px", borderRadius: 8, fontWeight: 700, display: "inline-block",
        }}>
          Back to Home
        </a>
      </div>
    );
  }

  if (state === "failed") {
    return (
      <div style={{ ...card, textAlign: "center", padding: 40 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>❌</div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: "#DC2626", margin: "0 0 8px" }}>
          Payment Failed
        </h2>
        <p style={{ color: "#64748b", margin: "0 0 24px" }}>{error ?? "Something went wrong."}</p>
        <button onClick={() => { setState("idle"); setError(null); }} style={primaryBtn}>
          Try Again
        </button>
      </div>
    );
  }

  const isProcessing = state === "creating" || state === "paying" || state === "polling";

  return (
    <div style={card}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase",
        letterSpacing: "0.05em", marginBottom: 14 }}>Payment</div>

      {/* Only show methods enabled by the administrator */}
      {configLoading ? (
        <div style={{ ...loadingBar, marginBottom: 20 }} />
      ) : (available.NOMOD || available.RAZORPAY) ? (
        <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
          {available.NOMOD && <GatewayOption
            id="NOMOD" label="Pay securely with Nomod"
            subtitle="Cards · Apple Pay · Google Pay · Tabby · Tamara"
            icon="⚡" active={gateway === "NOMOD"}
            onClick={() => setGateway("NOMOD")} />}
          {available.RAZORPAY && <GatewayOption
            id="RAZORPAY" label="Cards / UPI / Net Banking"
            subtitle="Razorpay secure checkout"
            icon="💳" active={gateway === "RAZORPAY"}
            onClick={() => setGateway("RAZORPAY")} />}
        </div>
      ) : (
        <div style={{ background: "#FEF2F2", color: "#B91C1C", border: "1px solid #FECACA", borderRadius: 10, padding: 13, marginBottom: 20, fontSize: 13 }}>
          Online payment is not configured. Please contact the booking agent.
        </div>
      )}

      {/* Summary line */}
      <div style={{
        background: "#F8FAFC", borderRadius: 8, padding: "12px 16px",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 20, border: "1px solid #E2E8F0",
      }}>
        <span style={{ fontSize: 14, color: "#64748b" }}>Total payable</span>
        <span style={{ fontSize: 20, fontWeight: 800, color: "#0f172a" }}>
          {currencySymbol}{parseFloat(totalAmount).toLocaleString("en-IN")}
          <span style={{ fontSize: 12, fontWeight: 400, color: "#94a3b8", marginLeft: 6 }}>{currency}</span>
        </span>
      </div>

      {error && (
        <div style={{
          background: "#FEF2F2", color: "#DC2626", border: "1px solid #FECACA",
          borderRadius: 8, padding: "10px 14px", fontSize: 13, marginBottom: 16,
        }}>
          {error}
        </div>
      )}

      <button
        onClick={initiatePayment}
        disabled={isProcessing || configLoading || !available[gateway]}
        style={{ ...primaryBtn, width: "100%", fontSize: 16, padding: "14px 24px", opacity: isProcessing ? 0.7 : 1 }}
      >
        {state === "creating" ? "Creating order…"
          : state === "paying"   ? "Opening payment…"
          : state === "polling"  ? "Confirming payment…"
          : `Pay now · ${currencySymbol}${parseFloat(totalAmount).toLocaleString("en-IN")}`}
      </button>

      <p style={{ fontSize: 12, color: "#94a3b8", textAlign: "center", margin: "12px 0 0" }}>
        🔒 Payments are secure and encrypted
      </p>
    </div>
  );
}

function GatewayOption({ id, label, subtitle, icon, active, onClick }: {
  id: string; label: string; subtitle: string; icon: string; active: boolean; onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        flex: 1, border: `2px solid ${active ? "#E31E24" : "#E2E8F0"}`,
        borderRadius: 10, padding: "12px 14px", cursor: "pointer",
        background: active ? "#FFF1F2" : "white", transition: "all .12s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 20 }}>{icon}</span>
        <div>
          <div style={{ fontWeight: 600, fontSize: 13, color: active ? "#9F1239" : "#0f172a" }}>{label}</div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 1 }}>{subtitle}</div>
        </div>
        <div style={{ marginLeft: "auto", width: 16, height: 16, borderRadius: "50%",
          border: `2px solid ${active ? "#E31E24" : "#CBD5E1"}`,
          background: active ? "#E31E24" : "white", flexShrink: 0 }} />
      </div>
    </div>
  );
}

const card: React.CSSProperties = {
  background: "white", borderRadius: 12, padding: 20, marginBottom: 16,
  boxShadow: "0 1px 3px rgba(0,0,0,.08)", border: "1px solid #e2e8f0",
};

const primaryBtn: React.CSSProperties = {
  background: "#E31E24", color: "white", border: "none", borderRadius: 8,
  padding: "12px 24px", fontWeight: 700, fontSize: 15, cursor: "pointer",
};

const loadingBar: React.CSSProperties = { height: 58, borderRadius: 10, background: "linear-gradient(90deg,#f1f5f9 25%,#fff 50%,#f1f5f9 75%)", backgroundSize: "200% 100%", animation: "pulse 1.2s infinite" };
