import { PoolClient } from "pg";

export const DAILY_LIMIT = 10000;
export const REVIEW_THRESHOLD = 5000;
const FEE_RATE = 0.005;
const MIN_FEE = 1;

/** 0.5% of the amount, never below 1.00, rounded half-up to cents. */
export function computeFee(amount: number): number {
  const raw = Math.round(amount * FEE_RATE * 100 + 1e-9) / 100;
  return Math.max(MIN_FEE, raw);
}

/** Sum of today's outgoing transfer amounts (UTC day), any status. */
export async function sentToday(client: PoolClient, walletId: string): Promise<number> {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
       FROM transfers
      WHERE from_wallet_id = $1
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [walletId],
  );
  return Number(rows[0].total);
}

/** Large transfers are held for manual review instead of settling. */
export const needsReview = (amount: number) => amount >= REVIEW_THRESHOLD;
