"use client";
import { useEffect, useState, type FormEvent } from "react";
import styles from "./wallet.module.css";

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";

interface Tx { id: string; type: string; amount: string; note: string | null; createdAt: string }
interface Coupon { id: string; code: string; amount: string; status: string; expiresAt: string; redeemedAt: string | null }

const TX_LABEL: Record<string, string> = {
  BOOKING_BONUS: "Booking bonus", ADMIN_CREDIT: "Added by POOMAS", BOOKING_DEBIT: "Paid for booking",
  REFUND_CREDIT: "Refund", COUPON_DEBIT: "Coupon created", COUPON_CREDIT: "Coupon redeemed", COUPON_REFUND: "Coupon returned",
};
const DEBITS = new Set(["BOOKING_DEBIT", "COUPON_DEBIT"]);
interface Referral { code: string; reward: number; stats: { joined: number; rewarded: number; earned: number }; referredBy: { code: string; rewarded: boolean } | null }
const STATUS_LABEL: Record<string, string> = { ACTIVE: "Active", REDEEMED: "Used", CANCELLED: "Cancelled", EXPIRED: "Expired · refunded" };
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function WalletIcon({ kind }: { kind: "wallet" | "share" | "redeem" | "flight" | "credit" | "debit" }) {
  const paths: Record<typeof kind, React.ReactNode> = {
    wallet: <><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M3 9V5a2 2 0 0 1 2-2h13" /><path d="M16 13h5" /></>,
    share: <><circle cx="18" cy="5" r="2" /><circle cx="6" cy="12" r="2" /><circle cx="18" cy="19" r="2" /><path d="m8 11 8-5M8 13l8 5" /></>,
    redeem: <><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M12 6v14M3 11h18M12 6c-5 0-5-4-2-4 2 0 2 4 2 4Zm0 0c5 0 5-4 2-4-2 0-2 4-2 4Z" /></>,
    flight: <path d="m21 3-7 18-3-8-8-3 18-7ZM11 13l10-10" />,
    credit: <><circle cx="12" cy="12" r="9" /><path d="M12 8v8m-4-4h8" /></>,
    debit: <><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></>,
  };
  return <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

function transactionIcon(type: string) {
  if (type === "BOOKING_DEBIT" || type === "BOOKING_BONUS") return "flight";
  return DEBITS.has(type) ? "debit" : "credit";
}

function readToken() {
  const m = document.cookie.match(/(?:^|;\s*)poomas_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

export default function WalletPage() {
  const [token, setToken] = useState<string | null>(null);
  const [balance, setBalance] = useState(0);
  const [transactions, setTransactions] = useState<Tx[]>([]);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [couponAmount, setCouponAmount] = useState("");
  const [redeemCode, setRedeemCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [referral, setReferral] = useState<Referral | null>(null);
  const [friendCode, setFriendCode] = useState("");

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API}/api/profile/wallet${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "x-tenant-slug": "poomas", Authorization: `Bearer ${token ?? readToken()}` },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) { setToken(""); throw new Error("Please sign in again."); }
    if (!res.ok) throw new Error((data as any).error ?? `Something went wrong (${res.status})`);
    return data as T;
  }

  async function load() {
    try {
      const [w, cp] = await Promise.all([
        call<{ balance: number; transactions: Tx[] }>(""),
        call<{ coupons: Coupon[] }>("/coupons"),
      ]);
      setBalance(w.balance); setTransactions(w.transactions); setCoupons(cp.coupons);
      call<Referral>("/referral").then(setReferral).catch(() => {});
    } catch (err: any) { setError(err.message); } finally { setLoading(false); }
  }

  async function applyFriendCode(e: FormEvent) {
    e.preventDefault();
    if (!friendCode.trim()) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await call<{ message: string }>("/referral/apply", { method: "POST", body: JSON.stringify({ code: friendCode.trim() }) });
      setNotice(r.message);
      setFriendCode("");
      call<Referral>("/referral").then(setReferral).catch(() => {});
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }

  function shareReferral() {
    if (!referral) return;
    const text = `Join me on FlyPoomas! Use my code ${referral.code} in your wallet and we both get ₹${referral.reward} when you book your first flight: https://flypoomas.com/wallet`;
    if (navigator.share) navigator.share({ text }).catch(() => {});
    else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
  }

  useEffect(() => {
    const t = readToken();
    setToken(t);
    if (t) load(); else setLoading(false);
  }, []);

  async function createCoupon(e: FormEvent) {
    e.preventDefault();
    const amount = Number(couponAmount);
    if (!(amount >= 10)) { setError("Minimum coupon amount is ₹10."); return; }
    if (amount > balance) { setError("That's more than your wallet balance."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await call<{ coupon: { code: string } }>("/coupons", { method: "POST", body: JSON.stringify({ amount }) });
      setNotice(`Coupon ${r.coupon.code} created for ${inr(amount)}. Share it — it works once and expires in 30 days.`);
      setCouponAmount("");
      await load();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }

  async function cancelCoupon(c: Coupon) {
    if (!confirm(`Cancel coupon ${c.code}? ${inr(Number(c.amount))} goes back to your wallet.`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await call(`/coupons/${c.id}/cancel`, { method: "POST" });
      setNotice(`Coupon ${c.code} cancelled; ${inr(Number(c.amount))} returned to your wallet.`);
      await load();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }

  async function redeem(e: FormEvent) {
    e.preventDefault();
    if (!redeemCode.trim()) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await call<{ amount: number }>("/redeem", { method: "POST", body: JSON.stringify({ code: redeemCode.trim() }) });
      setNotice(`${inr(r.amount)} added to your wallet.`);
      setRedeemCode("");
      await load();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }

  function share(c: Coupon) {
    const text = `I've sent you ${inr(Number(c.amount))} on FlyPoomas! Redeem code ${c.code} at https://flypoomas.com/wallet before ${new Date(c.expiresAt).toLocaleDateString("en-IN")}.`;
    if (navigator.share) navigator.share({ text }).catch(() => {});
    else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
  }

  if (loading) return <main className={styles.page}><p className={styles.loading}>Loading wallet…</p></main>;

  if (!token) {
    return (
      <main className={styles.page}>
        <section className={styles.signInCard}>
          <span className={styles.sectionIcon}><WalletIcon kind="wallet" /></span>
          <h1>FlyPoomas Wallet</h1>
          <p>Sign in to see your balance. Every confirmed booking earns you ₹50, and you can pay for flights with your wallet.</p>
          <div className={styles.signInActions}>
            <a className={styles.primaryButton} href="/signup?next=/wallet">Create account</a>
            <a className={styles.secondaryButton} href="/login?next=/wallet">Sign in</a>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <section className={styles.balanceCard} aria-label="Wallet balance">
        <div className={styles.balanceContent}>
          <span className={styles.balanceEyebrow}><WalletIcon kind="wallet" /> Wallet balance</span>
          <p className={styles.balanceAmount}>{inr(balance)}</p>
          <p className={styles.balanceCaption}>Your available balance in INR</p>
          <div className={styles.balanceNote}>₹50 for every confirmed booking · Pay for an INR flight when your balance covers the full fare</div>
        </div>
      </section>

      {error && <div className={`${styles.message} ${styles.error}`} role="alert">{error}</div>}
      {notice && <div className={`${styles.message} ${styles.notice}`} role="status">{notice}</div>}

      <div className={styles.actionGrid}>
        <section className={styles.actionCard}>
          <div className={styles.cardTitle}><span className={styles.sectionIcon}><WalletIcon kind="share" /></span><div><h2>Share balance</h2><p>Turn part of your balance into a one-time code for a friend. Unused codes return to you after 30 days.</p></div></div>
          <form className={styles.actionForm} onSubmit={createCoupon}>
            <label className={styles.srOnly} htmlFor="wallet-share-amount">Amount to share in rupees</label>
            <input id="wallet-share-amount" type="number" min="10" step="1" inputMode="numeric" placeholder="₹ amount" value={couponAmount} onChange={(e) => setCouponAmount(e.target.value)} />
            <button className={styles.primaryButton} type="submit" disabled={busy || balance < 10}>Create code <span aria-hidden="true">→</span></button>
          </form>
        </section>
        <section className={styles.actionCard}>
          <div className={styles.cardTitle}><span className={styles.sectionIcon}><WalletIcon kind="redeem" /></span><div><h2>Redeem a code</h2><p>Got a FlyPoomas wallet code from someone? Add it here.</p></div></div>
          <form className={styles.actionForm} onSubmit={redeem}>
            <label className={styles.srOnly} htmlFor="wallet-redeem-code">Wallet code</label>
            <input id="wallet-redeem-code" placeholder="PM-XXXXX-XXXXX" value={redeemCode} onChange={(e) => setRedeemCode(e.target.value.toUpperCase())} style={{ textTransform: "uppercase" }} />
            <button className={styles.primaryButton} type="submit" disabled={busy}>Redeem <span aria-hidden="true">→</span></button>
          </form>
        </section>
        {referral && (
          <section className={styles.actionCard}>
            <div className={styles.cardTitle}><span className={styles.sectionIcon}><WalletIcon kind="share" /></span><div><h2>Refer a friend</h2><p>You both get {inr(referral.reward)} when your friend&apos;s first booking is confirmed.</p></div></div>
            <div className={styles.actionForm}>
              <strong className={styles.code} style={{ alignSelf: "center" }}>{referral.code}</strong>
              <button className={styles.primaryButton} type="button" onClick={shareReferral}>Share <span aria-hidden="true">→</span></button>
            </div>
            {referral.stats.joined > 0 && <p style={{ margin: "8px 0 0", fontSize: 13, color: "#64748b" }}>{referral.stats.joined} friend{referral.stats.joined === 1 ? "" : "s"} joined · {inr(referral.stats.earned)} earned</p>}
            {referral.referredBy
              ? <p style={{ margin: "8px 0 0", fontSize: 13, color: "#166534" }}>Friend code {referral.referredBy.code} applied{referral.referredBy.rewarded ? " — reward paid" : " — reward comes with your first confirmed booking"}.</p>
              : (
                <form className={styles.actionForm} onSubmit={applyFriendCode} style={{ marginTop: 10 }}>
                  <label className={styles.srOnly} htmlFor="wallet-friend-code">Friend&apos;s referral code</label>
                  <input id="wallet-friend-code" placeholder="Friend's code (FP…)" value={friendCode} onChange={(e) => setFriendCode(e.target.value.toUpperCase())} style={{ textTransform: "uppercase" }} />
                  <button className={styles.subtleButton} type="submit" disabled={busy}>Apply</button>
                </form>
              )}
          </section>
        )}
      </div>

      <section className={styles.infoStrip} aria-label="Wallet benefits">
        <span className={styles.infoIcon}><WalletIcon kind="wallet" /></span>
        <div><h2>Why use FlyPoomas Wallet?</h2><p>Earn ₹50 after a confirmed booking, pay for eligible INR flights with a sufficient balance, or share balance with a one-time code.</p></div>
      </section>

      {coupons.length > 0 && (
        <section className={styles.panel}>
          <div className={styles.panelHeading}><div><h2>Your codes</h2><p>Manage codes you have created from your wallet balance.</p></div></div>
          <div className={styles.list}>
            {coupons.map((c) => (
              <div key={c.id} className={styles.codeRow}>
                <div className={styles.codeDetails}>
                  <strong className={styles.code}>{c.code}</strong>
                  <span>{inr(Number(c.amount))} · {STATUS_LABEL[c.status] ?? c.status}{c.status === "ACTIVE" ? ` · expires ${new Date(c.expiresAt).toLocaleDateString("en-IN")}` : ""}</span>
                </div>
                {c.status === "ACTIVE" && <div className={styles.codeActions}>
                  <button className={styles.subtleButton} onClick={() => share(c)}>Share</button>
                  <button className={styles.cancelButton} onClick={() => cancelCoupon(c)} disabled={busy}>Cancel</button>
                </div>}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className={styles.panel}>
        <div className={styles.panelHeading}><div><h2>History</h2><p>Your recent wallet activity</p></div></div>
        {transactions.length === 0 ? <p className={styles.empty}>No activity yet. Book a flight to earn your first ₹50.</p> :
          <div className={styles.list}>{transactions.map((t) => (
            <div key={t.id} className={styles.transactionRow}>
              <span className={`${styles.transactionIcon} ${DEBITS.has(t.type) ? styles.debitIcon : styles.creditIcon}`}><WalletIcon kind={transactionIcon(t.type)} /></span>
              <div className={styles.transactionDetails}>
                <strong>{t.note?.startsWith("Referral reward") ? "Referral reward" : TX_LABEL[t.type] ?? t.type}</strong>
                <span>{new Date(t.createdAt).toLocaleString("en-IN")}{t.note ? ` · ${t.note}` : ""}</span>
              </div>
              <strong className={`${styles.transactionAmount} ${DEBITS.has(t.type) ? styles.debit : styles.credit}`}>
                {DEBITS.has(t.type) ? "−" : "+"}{inr(Number(t.amount))}
              </strong>
            </div>
          ))}</div>}
      </section>
    </main>
  );
}
