import { Pool, PoolClient } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export type Db = Pool | PoolClient;
export const db: Db = pool;

export async function transaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const out = await work(tx);
    await tx.query("COMMIT");
    return out;
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}

export interface Account {
  id: string;
  holder: string;
  currency: string;
  available_cents: string;
  on_hold_cents: string;
  created_at: Date;
}

export interface Payment {
  id: string;
  payer_id: string;
  payee_id: string;
  amount_cents: string;
  fee_cents: string;
  state: string;
  created_at: Date;
}

export const accounts = {
  async create(holder: string, currency: string) {
    const { rows } = await db.query<Account>(
      "INSERT INTO accounts (holder, currency) VALUES ($1, $2) RETURNING *",
      [holder, currency],
    );
    return rows[0];
  },
  async find(id: string, tx: Db = db) {
    const { rows } = await tx.query<Account>("SELECT * FROM accounts WHERE id = $1", [id]);
    return rows[0];
  },
  async lockPair(tx: PoolClient, a: string, b: string) {
    const { rows } = await tx.query<Account>(
      "SELECT * FROM accounts WHERE id IN ($1, $2) ORDER BY id FOR UPDATE",
      [a, b],
    );
    return { first: rows.find((r) => r.id === a), second: rows.find((r) => r.id === b) };
  },
  async move(tx: PoolClient, id: string, availableDelta: number, holdDelta = 0) {
    const { rows } = await tx.query<Account>(
      `UPDATE accounts SET available_cents = available_cents + $2, on_hold_cents = on_hold_cents + $3
        WHERE id = $1 RETURNING *`,
      [id, availableDelta, holdDelta],
    );
    return rows[0];
  },
};

export const payments = {
  async byKey(key: string) {
    const { rows } = await db.query<Payment>("SELECT * FROM payments WHERE request_key = $1", [key]);
    return rows[0];
  },
  async find(id: string) {
    const { rows } = await db.query<Payment>("SELECT * FROM payments WHERE id = $1", [id]);
    return rows[0];
  },
  async sentTodayCents(tx: PoolClient, payerId: string) {
    const { rows } = await tx.query<{ cents: string }>(
      `SELECT COALESCE(SUM(amount_cents), 0)::text AS cents FROM payments
        WHERE payer_id = $1 AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
      [payerId],
    );
    return Number(rows[0].cents);
  },
  async insert(tx: PoolClient, p: { payer: string; payee: string; amount: number; fee: number; state: string; key: string | null }) {
    const { rows } = await tx.query<Payment>(
      `INSERT INTO payments (payer_id, payee_id, amount_cents, fee_cents, state, request_key)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [p.payer, p.payee, p.amount, p.fee, p.state, p.key],
    );
    return rows[0];
  },
};

export async function journal(tx: PoolClient, entries: { payment?: string; account: string; side: "debit" | "credit"; reason: string; cents: number }[]) {
  for (const e of entries) {
    await tx.query(
      "INSERT INTO journal (payment_id, account_id, side, reason, cents) VALUES ($1, $2, $3, $4, $5)",
      [e.payment ?? null, e.account, e.side, e.reason, e.cents],
    );
  }
}
