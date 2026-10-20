"use client";
import { useState, useRef, useEffect, type FormEvent } from "react";

type ChatMsg = {
  id: number;
  from: "bot" | "user";
  text: string;
  time: string;
};

type Step = "email" | "password" | "loading" | "done";

// Where to go after signing in: the page that sent the customer here (?next=/trips), else their account.
function afterLoginPath() {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/account";
}

function now() {
  return new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
}

export default function LoginPage() {

  const [messages, setMessages] = useState<ChatMsg[]>([
    { id: 1, from: "bot", text: "Hi! 👋 Welcome to FlyPoomas.", time: now() },
    { id: 2, from: "bot", text: "Please enter your email address to sign in.", time: now() },
  ]);
  const [step, setStep] = useState<Step>("email");
  const [input, setInput] = useState("");
  const [emailVal, setEmailVal] = useState("");
  const [showPwd, setShowPwd] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (step !== "loading" && step !== "done") {
      setTimeout(() => {
        if (inputRef.current?.getClientRects().length) inputRef.current.focus();
      }, 100);
    }
  }, [step]);

  function push(msg: Omit<ChatMsg, "id">) {
    setMessages((prev: ChatMsg[]) => [...prev, { ...msg, id: Date.now() + Math.random() }]);
  }

  function botSay(text: string, delay = 700): Promise<void> {
    return new Promise((res) =>
      setTimeout(() => {
        push({ from: "bot", text, time: now() });
        res();
      }, delay)
    );
  }

  async function send() {
    const val = input.trim();
    if (!val || step === "loading" || step === "done") return;
    setInput("");

    if (step === "email") {
      push({ from: "user", text: val, time: now() });
      setEmailVal(val);
      setStep("loading");
      await botSay("Got it ✅", 500);
      await botSay("Now enter your password 🔒", 400);
      setStep("password");
    } else if (step === "password") {
      push({ from: "user", text: "••••••••", time: now() });
      setStep("loading");
      await botSay("One moment…", 400);

      try {
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL}/api/auth/login`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: emailVal, password: val }),
          }
        );

        if (res.ok) {
          const { token } = (await res.json()) as { token: string };
          document.cookie = `poomas_token=${token}; Path=/; SameSite=Lax; Secure; Max-Age=86400`;
          setStep("done");
          await botSay("Welcome back! ✈️ You're all set.", 300);
          await botSay(afterLoginPath() === "/account" ? "Opening your account…" : "Taking you back…", 400);
          setTimeout(() => window.location.assign(afterLoginPath()), 900);
        } else {
          const data = (await res.json()) as { error?: string };
          setStep("email");
          await botSay(
            `Hmm, that didn't work. ${data.error ?? "Please try again."} 😕`,
            300
          );
          await botSay("Forgot your password? Use “Forgot password?” in the form below to get a reset link by email.", 400);
          await botSay("What's your email address?", 500);
          setEmailVal("");
        }
      } catch {
        setStep("email");
        await botSay("Connection error. Please try again. 🌐", 300);
        await botSay("What's your email address?", 500);
        setEmailVal("");
      }
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const isDisabled = step === "loading" || step === "done";

  return (
    <>
      {/* Mobile full-screen WhatsApp layout */}
      <div className="wa-screen">
        {/* Header */}
        <div className="wa-header">
          <a href="/" className="wa-back" aria-label="Back">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path
                d="M15 18l-6-6 6-6"
                stroke="white"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>
          <div className="wa-avatar">✈️</div>
          <div className="wa-header-info">
            <div className="wa-contact-name">FlyPoomas</div>
            <div className="wa-contact-status">Online</div>
          </div>
          <div className="wa-header-icons">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="5" r="1.5" fill="white" />
              <circle cx="12" cy="12" r="1.5" fill="white" />
              <circle cx="12" cy="19" r="1.5" fill="white" />
            </svg>
          </div>
        </div>

        {/* Encrypted label */}
        <div className="wa-encrypted-label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="11" width="18" height="11" rx="2" stroke="#8e8e8e" strokeWidth="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="#8e8e8e" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Messages are end-to-end encrypted
        </div>
        <a href="/signup" style={{ display: "block", textAlign: "center", fontSize: 13, fontWeight: 600, color: "#075E54", padding: "6px 0", background: "#fff" }}>
          New here? Create an account and earn ₹50 on every booking →
        </a>

        {/* Messages */}
        <div className="wa-messages">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`wa-msg-row ${msg.from === "user" ? "wa-msg-row--out" : ""}`}
            >
              <div
                className={`wa-bubble ${
                  msg.from === "user" ? "wa-bubble--out" : "wa-bubble--in"
                }`}
              >
                <span className="wa-bubble-text">{msg.text}</span>
                <span className="wa-bubble-meta">
                  <span className="wa-bubble-time">{msg.time}</span>
                  {msg.from === "user" && (
                    <span className="wa-ticks">
                      <svg width="16" height="11" viewBox="0 0 16 11" fill="none">
                        <path d="M1 5.5L4.5 9L10 3" stroke="#34B7F1" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M5 5.5L8.5 9L14 3" stroke="#34B7F1" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  )}
                </span>
              </div>
            </div>
          ))}

          {step === "loading" && (
            <div className="wa-msg-row">
              <div className="wa-bubble wa-bubble--in">
                <div className="wa-typing">
                  <span className="wa-dot" />
                  <span className="wa-dot" />
                  <span className="wa-dot" />
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div className="wa-input-bar">
          <div className="wa-input-pill">
            <input
              ref={inputRef}
              className="wa-input"
              type={step === "password" && !showPwd ? "password" : step === "email" ? "email" : "text"}
              placeholder={
                isDisabled
                  ? ""
                  : step === "password"
                  ? "Enter your password…"
                  : "Enter your email…"
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              disabled={isDisabled}
              autoComplete={step === "password" ? "current-password" : "email"}
            />
            {step === "password" && (
              <button
                className="wa-eye"
                type="button"
                onClick={() => setShowPwd((v) => !v)}
                aria-label={showPwd ? "Hide password" : "Show password"}
              >
                {showPwd ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" stroke="#8e8e8e" strokeWidth="2" strokeLinecap="round"/>
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" stroke="#8e8e8e" strokeWidth="2" strokeLinecap="round"/>
                    <line x1="1" y1="1" x2="23" y2="23" stroke="#8e8e8e" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="#8e8e8e" strokeWidth="2"/>
                    <circle cx="12" cy="12" r="3" stroke="#8e8e8e" strokeWidth="2"/>
                  </svg>
                )}
              </button>
            )}
          </div>
          <button
            className="wa-send"
            type="button"
            onClick={send}
            disabled={isDisabled || !input.trim()}
            aria-label="Send"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path
                d="M22 2L11 13M22 2L15 22L11 13M22 2L2 9L11 13"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Conventional login form at every viewport */}
      <div className="wa-desktop-fallback">
        <div className="wa-desktop-card">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="FlyPoomas" className="login-brand-logo" width="72" height="68" />
          <h1 className="login-title">Welcome back</h1>
          <p className="login-intro">Sign in to continue to your FlyPoomas account.</p>
          <DesktopLoginForm />
          <p className="login-signup-prompt">
            New to FlyPoomas? <a href="/signup">Create an account</a>
          </p>
        </div>
      </div>
    </>
  );
}

/* Desktop form reused independently */
function DesktopLoginForm() {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: pass }),
      });
      if (res.ok) {
        const { token } = (await res.json()) as { token: string };
        document.cookie = `poomas_token=${token}; Path=/; SameSite=Lax; Secure; Max-Age=86400`;
        window.location.assign(afterLoginPath());
      } else {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? "Login failed");
      }
    } catch {
      setError("Connection error. Please try again.");
    }
    setLoading(false);
  }

  return (
    <form onSubmit={submit} className="login-form">
      {error && (
        <div style={{ background: "#FEE2E2", color: "#991B1B", padding: "10px 14px", borderRadius: 6, fontSize: 13 }}>
          {error}
        </div>
      )}
      <label className="login-field">Email address
        <input type="email" name="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label className="login-field">Password
        <input type="password" name="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} required />
      </label>
      <a href={`/forgot-password${email ? `?email=${encodeURIComponent(email.trim())}` : ""}`} style={{ alignSelf: "flex-end", marginTop: -6, fontSize: 13, color: "#E31E24", fontWeight: 600 }}>Forgot password?</a>
      <button
        type="submit" disabled={loading} className="login-submit"
      >
        {loading ? "Signing in…" : "Sign In"}
      </button>
    </form>
  );
}
