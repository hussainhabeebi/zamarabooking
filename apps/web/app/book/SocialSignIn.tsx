"use client";

import { useEffect, useRef, useState } from "react";

type Challenge = { challengeId: string; nonce: string; clientId: string; redirectUri?: string; proof: string };
type Result = { token: string; customer: { name: string | null; email: string | null } };
type AppleResponse = { authorization: { id_token: string; code: string; state: string }; user?: { name?: { firstName?: string; lastName?: string } } };
declare global {
  interface Window {
    google?: { accounts: { id: {
      initialize: (options: { client_id: string; nonce: string; callback: (result: { credential: string }) => void; auto_select: boolean }) => void;
      renderButton: (node: HTMLElement, options: { theme: string; size: string; text: string }) => void;
      cancel: () => void;
    } } };
    AppleID?: { auth: { init: (options: { clientId: string; scope: string; redirectURI: string; state: string; nonce: string; usePopup: boolean }) => void;
      signIn: () => Promise<AppleResponse> } };
  }
}
const scripts = new Map<string, Promise<void>>();
function loadScript(src: string) {
  if (!scripts.has(src)) scripts.set(src, new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src; script.async = true;
    const timer = window.setTimeout(() => { scripts.delete(src); reject(new Error("Sign-in took too long to load.")); }, 12000);
    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = () => { clearTimeout(timer); scripts.delete(src); script.remove(); reject(new Error("Sign-in could not load.")); };
    document.head.appendChild(script);
  }));
  return scripts.get(src)!;
}

export default function SocialSignIn({ apiUrl, onSuccess }: { apiUrl: string; onSuccess: (result: Result) => void }) {
  const googleButton = useRef<HTMLDivElement>(null);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const [apple, setApple] = useState<Challenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [available, setAvailable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const headers = { "Content-Type": "application/json", "x-tenant-slug": "poomas" };

  async function complete(provider: "google" | "apple", challenge: Challenge, idToken: string, extra: object = {}) {
    setBusy(true); setError("");
    try {
      const res = await fetch(`${apiUrl}/api/auth/social/complete`, {
        method: "POST", headers,
        body: JSON.stringify({ provider, challengeId: challenge.challengeId, proof: challenge.proof, idToken, ...extra }),
        signal: AbortSignal.timeout(20000),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Sign-in failed. Continue as a guest or retry.");
      onSuccessRef.current(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed. Your details are still here.");
      setAttempt((v) => v + 1);
    } finally { setBusy(false); }
  }

  useEffect(() => {
    let active = true;
    setApple(null);
    const prepare = async (provider: "google" | "apple") => {
      const proof = crypto.randomUUID() + crypto.randomUUID();
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof));
      const proofHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
      const res = await fetch(`${apiUrl}/api/auth/social/start`, {
        method: "POST", headers, body: JSON.stringify({ provider, proofHash }), signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error("Sign-in is unavailable. You can continue as a guest.");
      return { ...await res.json(), proof } as Challenge;
    };
    void (async () => {
      try {
        const response = await fetch(`${apiUrl}/api/auth/social/providers`, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) return;
        const providers = await response.json() as { google: boolean; apple: boolean };
        if (!active) return;
        setAvailable(providers.google || providers.apple);
        const results = await Promise.allSettled([
          providers.google ? (async () => {
            await loadScript("https://accounts.google.com/gsi/client");
            const challenge = await prepare("google");
            if (!active || !googleButton.current || !window.google) return;
            window.google.accounts.id.initialize({ client_id: challenge.clientId, nonce: challenge.nonce, auto_select: false,
              callback: (r) => { if (active) void complete("google", challenge, r.credential); } });
            googleButton.current.replaceChildren();
            window.google.accounts.id.renderButton(googleButton.current, { theme: "outline", size: "large", text: "continue_with" });
          })() : Promise.resolve(),
          providers.apple ? (async () => {
            await loadScript("https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js");
            const challenge = await prepare("apple");
            if (active) setApple(challenge);
          })() : Promise.resolve(),
        ]);
        if (active && results.some((r) => r.status === "rejected")) setError("One sign-in option couldn't load. Continue as a guest or retry.");
      } catch { /* Guest and email sign-in remain available if config lookup fails. */ }
    })();
    return () => { active = false; window.google?.accounts.id.cancel(); };
  }, [apiUrl, attempt]);

  async function signInApple() {
    if (!apple || !window.AppleID || busy) return;
    setBusy(true); setError("");
    try {
      window.AppleID.auth.init({ clientId: apple.clientId, scope: "name email", redirectURI: apple.redirectUri!,
        state: apple.challengeId, nonce: apple.nonce, usePopup: true });
      const result = await window.AppleID.auth.signIn();
      await complete("apple", apple, result.authorization.id_token, {
        code: result.authorization.code, state: result.authorization.state,
        name: [result.user?.name?.firstName, result.user?.name?.lastName].filter(Boolean).join(" ") || undefined,
      });
    } catch { setError("Apple sign-in wasn't completed. You can try again or continue as a guest."); setAttempt((v) => v + 1); }
    finally { setBusy(false); }
  }

  return (
    <div aria-busy={busy}>
      {available && <p className="signinNote">Sign in or create your customer account. No password needed.</p>}
      <div className="socialButtons" style={busy ? { pointerEvents: "none", opacity: .6 } : undefined}>
        <div ref={googleButton} />
        {apple && <button type="button" className="appleButton" onClick={signInApple} disabled={busy}>Continue with Apple</button>}
      </div>
      {busy && <p role="status">Signing in…</p>}
      {error && <p role="alert">{error} <button type="button" className="linkBtn" onClick={() => { setError(""); setAttempt((v) => v + 1); }}>Retry sign-in</button></p>}
    </div>
  );
}
