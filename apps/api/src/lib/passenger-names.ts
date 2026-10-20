// Passenger names must be real: airlines and TripJack reject (or fine) placeholder
// names, and certification logs must not contain TBA/Test bookings.
const PLACEHOLDERS = new Set([
  "TBA", "TBD", "TBC", "NA", "N/A", "NIL", "NONE", "NULL", "UNKNOWN", "TEST", "TESTING", "TESTER", "DUMMY",
  "SAMPLE", "DEMO", "FAKE", "XX", "XXX", "XXXX", "ABC", "ABCD", "ASDF", "QWERTY", "NAME", "FIRSTNAME",
  "LASTNAME", "SURNAME", "FIRST", "LAST", "PASSENGER", "PAX", "GUEST", "ADULT", "CHILD", "INFANT", "MR", "MRS", "MS",
]);

// Returns an error message, or null when the name looks real.
export function passengerNameProblem(name: string, label: string): string | null {
  const v = name.trim().replace(/\s+/g, " ");
  if (v.length < 2) return `${label} must have at least 2 letters`;
  if (v.length > 40) return `${label} is too long`;
  if (!/^[\p{L}][\p{L} .'-]*$/u.test(v)) return `${label} can contain only letters, spaces, apostrophes, dots and hyphens`;
  const compact = v.toUpperCase().replace(/[^\p{L}/]/gu, "");
  if (PLACEHOLDERS.has(v.toUpperCase()) || PLACEHOLDERS.has(compact) || v.toUpperCase().split(/[ .'-]+/).some((w) => ["TBA", "TBD", "TEST", "DUMMY"].includes(w))) {
    return `${label} "${v}" looks like a placeholder — enter the passenger's real name as on the passport`;
  }
  if (/^(\p{L})\1+$/u.test(compact) && compact.length >= 3) return `${label} "${v}" doesn't look like a real name`;
  return null;
}
