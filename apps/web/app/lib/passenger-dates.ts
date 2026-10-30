export type PassengerDateKind = "birth" | "issue" | "expiry";

export function todayISO(now = new Date()): string {
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// Do not let Date's rollover rules turn e.g. 31 February into a different date.
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function dateOnly(value?: string | null): string {
  if (!value) return "";
  // Existing API dates can include a time; never truncate an oversized year.
  return /^\d{4}-\d{2}-\d{2}[T ]/.test(value) ? value.slice(0, 10) : value;
}

export function dateProblem(value: string, kind: PassengerDateKind, today = todayISO()): string | null {
  if (!value) return null; // requiredness is supplied by the fare/form.
  if (!isCalendarDate(value)) return "Enter a valid date with a four-digit year.";
  if (kind === "birth" && value >= today) return "Date of birth must be in the past.";
  if (kind === "issue" && value > today) return "Passport issue date cannot be in the future.";
  if (kind === "expiry" && value <= today) return "Passport expiry must be in the future.";
  return null;
}

export function passengerDatesProblem(p: { dob?: string | null; passportIssueDate?: string | null; passportExpiry?: string | null }, today = todayISO()): string | null {
  for (const [value, kind] of [[p.dob, "birth"], [p.passportIssueDate, "issue"], [p.passportExpiry, "expiry"]] as const) {
    const problem = dateProblem(dateOnly(value), kind, today);
    if (problem) return problem;
  }
  if (p.passportIssueDate && p.passportExpiry && dateOnly(p.passportIssueDate) >= dateOnly(p.passportExpiry)) return "Passport expiry must be after its issue date.";
  return null;
}
