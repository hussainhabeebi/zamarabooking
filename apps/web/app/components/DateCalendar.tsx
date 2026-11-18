"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Our own calendar for the search form's date fields (the browser's native picker was jumpy on
// phones, iOS Safari above all). Phones: a bottom sheet that slides up with months to scroll
// through. Wider screens: a popover under the field showing two months with ‹ › paging.
// Dates are "YYYY-MM-DD" strings throughout; all maths is in UTC so time zones never shift a day.

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MOBILE_MONTHS = 13;

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const parse = (s: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null; };
const addMonths = (y: number, m: number, n: number) => { const t = y * 12 + m + n; return { y: Math.floor(t / 12), m: t % 12 }; };
const monthName = (y: number, m: number) => new Date(Date.UTC(y, m, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const longDate = (s: string) => { const p = parse(s); return p ? new Date(Date.UTC(p.y, p.m, p.d)).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : ""; };

function useIsMobile() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

function Month({ y, m, value, min, rangeStart, today, onPick, weekdays }: {
  y: number; m: number; value: string; min: string; rangeStart?: string; today: string; onPick: (v: string) => void; weekdays?: boolean;
}) {
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7; // Monday first
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => iso(y, m, i + 1))];
  return (
    <div className="bf-cal-month" data-month={iso(y, m, 1).slice(0, 7)}>
      <div className="bf-cal-month-title">{monthName(y, m)}</div>
      {weekdays && <div className="bf-cal-weekdays">{WEEKDAYS.map((w) => <span key={w}>{w}</span>)}</div>}
      <div className="bf-cal-grid" role="grid">
        {cells.map((d, i) => {
          if (!d) return <span key={`e${i}`} className="bf-cal-empty" />;
          const disabled = d < min;
          const sel = d === value;
          const start = !!rangeStart && d === rangeStart;
          const inRange = !!rangeStart && !!value && d > rangeStart && d < value;
          const cls = ["bf-cal-day", sel && "is-sel", start && "is-start", inRange && "is-range", d === today && "is-today",
            rangeStart && value && start && value > rangeStart && "has-range-r", rangeStart && sel && value > rangeStart && "has-range-l"]
            .filter(Boolean).join(" ");
          return (
            <button key={d} type="button" className={cls} disabled={disabled} aria-pressed={sel}
              aria-label={longDate(d)} onClick={() => onPick(d)}>
              {+d.slice(8)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DateCalendar({ open, anchor, title, value, min, rangeStart, onPick, onClose }: {
  open: boolean; anchor: HTMLElement | null; title: string; value: string; min: string;
  rangeStart?: string; onPick: (v: string) => void; onClose: () => void;
}) {
  const mobile = useIsMobile();
  const [mounted, setMounted] = useState(false);   // in the DOM (stays during the closing animation)
  const [shown, setShown] = useState(false);       // animated in
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const today = new Date().toISOString().slice(0, 10);
  const base = parse(min) ?? parse(today)!;
  const focusMonth = parse(value) ?? parse(rangeStart ?? "") ?? base;
  const [page, setPage] = useState(0); // desktop: months shown start at base + page

  // Mount → next frame animate in; close → animate out → unmount.
  useEffect(() => {
    if (open) {
      setMounted(true);
      setPage(Math.max(0, (focusMonth.y - base.y) * 12 + focusMonth.m - base.m));
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(r);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Desktop popover sits under the field, kept inside the viewport.
  useLayoutEffect(() => {
    if (!mounted || mobile || !anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const w = Math.min(680, window.innerWidth - 24);
      setPos({ top: r.bottom + window.scrollY + 8, left: Math.max(12, Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - w - 12)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [mounted, mobile, anchor]);

  // Phone sheet: lock the page behind it and start at the selected month.
  useLayoutEffect(() => {
    if (!mounted || !mobile) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const key = `${focusMonth.y}-${pad(focusMonth.m + 1)}`;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-month="${key}"]`);
    if (el && scroller.current) scroller.current.scrollTop = el.offsetTop - scroller.current.offsetTop;
    return () => { document.body.style.overflow = prev; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, mobile]);

  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);

  if (!mounted || typeof document === "undefined") return null;

  const props = { value, min, rangeStart, today, onPick };
  const months = mobile
    ? Array.from({ length: MOBILE_MONTHS }, (_, i) => addMonths(base.y, base.m, i))
    : [0, 1].map((i) => addMonths(base.y, base.m, page + i));

  return createPortal(
    // Portal events still bubble through React's tree: keep them from re-opening the field.
    <div className={`bf-cal-root${mobile ? " is-sheet" : " is-pop"}${shown ? " is-shown" : ""}`}
      onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="bf-cal-backdrop" onClick={onClose} />
      <div className="bf-cal-panel" role="dialog" aria-modal="true" aria-label={title}
        style={!mobile && pos ? { top: pos.top, left: pos.left } : undefined}>
        <div className="bf-cal-head">
          <div>
            <div className="bf-cal-title">{title}</div>
            {rangeStart && <div className="bf-cal-sub">Departing {longDate(rangeStart)}</div>}
          </div>
          <button type="button" className="bf-cal-close" onClick={onClose} aria-label="Close calendar">✕</button>
        </div>
        {mobile ? (
          <>
            <div className="bf-cal-weekdays">{WEEKDAYS.map((w) => <span key={w}>{w}</span>)}</div>
            <div ref={scroller} className="bf-cal-scroll">
              {months.map(({ y, m }) => <Month key={`${y}-${m}`} y={y} m={m} {...props} />)}
            </div>
          </>
        ) : (
          <div className="bf-cal-pages">
            <button type="button" className="bf-cal-nav is-prev" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Previous month">‹</button>
            <button type="button" className="bf-cal-nav is-next" disabled={page >= MOBILE_MONTHS - 2} onClick={() => setPage((p) => p + 1)} aria-label="Next month">›</button>
            {months.map(({ y, m }) => (
              <Month key={`${y}-${m}`} y={y} m={m} weekdays {...props} />
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
