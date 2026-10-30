"use client";

import { useEffect, useId, useRef, useState } from "react";
import { dateProblem, isCalendarDate, todayISO, type PassengerDateKind } from "../lib/passenger-dates";

export default function PassengerDateInput({ value, onChange, kind, required = false }: {
  value: string; onChange: (value: string) => void; kind: PassengerDateKind; required?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [error, setError] = useState("");
  const today = todayISO();
  const problem = dateProblem(value, kind, today);
  useEffect(() => { input.current?.setCustomValidity(problem ?? ""); }, [problem]);
  return <>
    <input ref={input} type="date" required={required}
      min={kind === "expiry" ? nextDay(today) : "0001-01-01"}
      max={kind === "birth" ? previousDay(today) : kind === "issue" ? today : "9999-12-31"}
      value={isCalendarDate(value) ? value : ""}
      aria-invalid={Boolean(error || problem)} aria-describedby={error ? errorId : undefined}
      onChange={(e) => {
        const field = e.currentTarget, next = field.value;
        if (next && !isCalendarDate(next)) {
          // Browsers allow typing a fifth/sixth year digit despite max/maxlength.
          // Restore the last value, never silently truncate to a different date.
          field.value = isCalendarDate(value) ? value : "";
          setError("Enter a valid date with a four-digit year.");
          return;
        }
        const issue = dateProblem(next, kind, today);
        field.setCustomValidity(issue ?? "");
        setError("");
        onChange(next);
      }}
      onBlur={(e) => {
        const issue = dateProblem(value, kind, today) ?? (e.currentTarget.validity.badInput ? "Enter a complete, valid date with a four-digit year." : "");
        e.currentTarget.setCustomValidity(issue);
        setError(issue);
      }}
      onInvalid={(e) => setError(problem ?? (e.currentTarget.validity.valueMissing ? "Enter a complete date with a four-digit year." : e.currentTarget.validationMessage))}
    />
    {error && <small id={errorId} role="alert" style={{ color: "#b42318", fontSize: 12 }}>{error}</small>}
  </>;
}
function shiftedDay(value: string, days: number) {
  const d = new Date(`${value}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function nextDay(value: string) { return shiftedDay(value, 1); }
function previousDay(value: string) { return shiftedDay(value, -1); }
