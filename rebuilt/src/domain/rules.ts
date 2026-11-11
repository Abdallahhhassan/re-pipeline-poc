/** Business rules from the verified spec, in cents. */
export const SUPPORTED_CURRENCIES = new Set(["USD", "EUR", "EGP", "AED"]);
export const DAILY_SEND_LIMIT = 1_000_000; // 10,000.00 per wallet per UTC day, any state
export const REVIEW_FROM = 500_000; // 5,000.00 and above waits for review
export const MAX_OWNER_LENGTH = 80;

/** 0.5% rounded half-up to the cent, at least 1.00. Integer math avoids float rounding drift. */
export function feeFor(amountCents: number): number {
  const half = Math.floor((amountCents * 5 + 500) / 1000);
  return Math.max(100, half);
}

export const stateFor = (amountCents: number) => (amountCents >= REVIEW_FROM ? "pending_review" : "completed");
