/** Normalise NZ phone numbers to E.164: "021 123 4567" -> "+64211234567". Returns null if invalid. */
export function normalizePhone(input: string): string | null {
  let s = input.replace(/[\s()-]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("0")) s = "+64" + s.slice(1);
  if (!s.startsWith("+")) s = "+64" + s;
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

export function isEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.trim()) && input.length <= 254;
}
