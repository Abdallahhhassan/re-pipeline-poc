import { Fail } from "../http/fail";

/** Money is kept as integer cents internally and shown as a two-decimal string. */
export const formatCents = (cents: number | string) => (Number(cents) / 100).toFixed(2);

/** Accepts a JSON number above 0 with at most two decimals, and returns it in cents. */
export function toCents(value: unknown, field = "amount"): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Fail(400, "VALIDATION_ERROR", { field });
  }
  const cents = Math.round(value * 100);
  if (Math.abs(cents - value * 100) > 1e-6) {
    throw new Fail(400, "VALIDATION_ERROR", { field, reason: "max 2 decimals" });
  }
  return cents;
}
