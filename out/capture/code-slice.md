### demo-target/src/db.ts
```
   1  import { Pool, PoolClient } from "pg";
   2  
   3  export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
   4  
   5  export async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
   6    const client = await pool.connect();
   7    try {
   8      await client.query("BEGIN");
   9      const result = await fn(client);
  10      await client.query("COMMIT");
  11      return result;
  12    } catch (err) {
  13      await client.query("ROLLBACK");
  14      throw err;
  15    } finally {
  16      client.release();
  17    }
  18  }
  19  
```

### demo-target/src/errors.ts
```
   1  export class ApiError extends Error {
   2    constructor(
   3      public status: number,
   4      public code: string,
   5      public extra: Record<string, unknown> = {},
   6    ) {
   7      super(code);
   8    }
   9  }
  10  
  11  export const isUuid = (v: unknown): v is string =>
  12    typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  13  
  14  /** Money arrives as a JSON number with at most 2 decimals. */
  15  export function parseAmount(value: unknown, field = "amount"): number {
  16    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
  17      throw new ApiError(400, "VALIDATION_ERROR", { field });
  18    }
  19    if (Math.round(value * 100) !== value * 100) {
  20      throw new ApiError(400, "VALIDATION_ERROR", { field, reason: "max 2 decimals" });
  21    }
  22    return value;
  23  }
  24  
```

### demo-target/src/policy.ts
```
   1  import { PoolClient } from "pg";
   2  
   3  export const DAILY_LIMIT = 10000;
   4  export const REVIEW_THRESHOLD = 5000;
   5  const FEE_RATE = 0.005;
   6  const MIN_FEE = 1;
   7  
   8  /** 0.5% of the amount, never below 1.00, rounded half-up to cents. */
   9  export function computeFee(amount: number): number {
  10    const raw = Math.round(amount * FEE_RATE * 100 + 1e-9) / 100;
  11    return Math.max(MIN_FEE, raw);
  12  }
  13  
  14  /** Sum of today's outgoing transfer amounts (UTC day), any status. */
  15  export async function sentToday(client: PoolClient, walletId: string): Promise<number> {
  16    const { rows } = await client.query(
  17      `SELECT COALESCE(SUM(amount), 0) AS total
  18         FROM transfers
  19        WHERE from_wallet_id = $1
  20          AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
  21      [walletId],
  22    );
  23    return Number(rows[0].total);
  24  }
  25  
  26  /** Large transfers are held for manual review instead of settling. */
  27  export const needsReview = (amount: number) => amount >= REVIEW_THRESHOLD;
  28  
```

### demo-target/src/transfers.ts
```
   1  import { Router } from "express";
   2  import { pool, inTx } from "./db";
   3  import { ApiError, isUuid, parseAmount } from "./errors";
   4  import { DAILY_LIMIT, computeFee, needsReview, sentToday } from "./policy";
   5  
   6  const transferToJson = (t: any) => ({
   7    id: t.id,
   8    fromWalletId: t.from_wallet_id,
   9    toWalletId: t.to_wallet_id,
  10    amount: t.amount,
  11    fee: t.fee,
  12    status: t.status,
  13    createdAt: t.created_at,
  14  });
  15  
  16  export const transfers = Router();
  17  
  18  transfers.post("/transfers", async (req, res) => {
  19    const { fromWalletId, toWalletId, amount: rawAmount } = req.body ?? {};
  20    if (!isUuid(fromWalletId)) throw new ApiError(400, "VALIDATION_ERROR", { field: "fromWalletId" });
  21    if (!isUuid(toWalletId)) throw new ApiError(400, "VALIDATION_ERROR", { field: "toWalletId" });
  22    const amount = parseAmount(rawAmount);
  23    if (fromWalletId === toWalletId) throw new ApiError(400, "SAME_WALLET");
  24  
  25    // Idempotency: a repeated key returns the original transfer, even if the body differs.
  26    const key = req.header("Idempotency-Key") ?? null;
  27    if (key) {
  28      const { rows } = await pool.query("SELECT * FROM transfers WHERE idempotency_key = $1", [key]);
  29      if (rows[0]) {
  30        res.setHeader("Idempotent-Replay", "true");
  31        res.status(200).json(transferToJson(rows[0]));
  32        return;
  33      }
  34    }
  35  
  36    const transfer = await inTx(async (c) => {
  37      const { rows: ws } = await c.query(
  38        "SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
  39        [[fromWalletId, toWalletId]],
  40      );
  41      const from = ws.find((w) => w.id === fromWalletId);
  42      const to = ws.find((w) => w.id === toWalletId);
  43      if (!from || !to) throw new ApiError(404, "WALLET_NOT_FOUND");
  44      if (from.currency !== to.currency) throw new ApiError(422, "CURRENCY_MISMATCH");
  45  
  46      const already = await sentToday(c, fromWalletId);
  47      if (already + amount > DAILY_LIMIT) {
  48        throw new ApiError(422, "LIMIT_EXCEEDED", { remaining: Math.max(0, DAILY_LIMIT - already) });
  49      }
  50  
  51      const fee = computeFee(amount);
  52      if (Number(from.balance) < amount + fee) throw new ApiError(409, "INSUFFICIENT_FUNDS");
  53  
  54      const status = needsReview(amount) ? "pending_review" : "completed";
  55      const { rows } = await c.query(
  56        `INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key)
  57         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
  58        [fromWalletId, toWalletId, amount, fee, status, key],
  59      );
  60      const t = rows[0];
  61  
  62      await c.query(
  63        `INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount)
  64         VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)`,
  65        [t.id, fromWalletId, amount, fee],
  66      );
  67      if (status === "completed") {
  68        await c.query("UPDATE wallets SET balance = balance - $2 WHERE id = $1", [fromWalletId, amount + fee]);
  69        await c.query("UPDATE wallets SET balance = balance + $2 WHERE id = $1", [toWalletId, amount]);
  70        await c.query(
  71          `INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount)
  72           VALUES ($1, $2, 'credit', 'transfer', $3)`,
  73          [t.id, toWalletId, amount],
  74        );
  75      } else {
  76        // Held for review: sender pays now, receiver is credited only after approval.
  77        await c.query(
  78          "UPDATE wallets SET balance = balance - $2, held = held + $3 WHERE id = $1",
  79          [fromWalletId, amount + fee, amount],
  80        );
  81      }
  82      return t;
  83    });
  84  
  85    res.status(201).json(transferToJson(transfer));
  86  });
  87  
  88  transfers.get("/transfers/:id", async (req, res) => {
  89    if (!isUuid(req.params.id)) throw new ApiError(404, "TRANSFER_NOT_FOUND");
  90    const { rows } = await pool.query("SELECT * FROM transfers WHERE id = $1", [req.params.id]);
  91    if (!rows[0]) throw new ApiError(404, "TRANSFER_NOT_FOUND");
  92    res.json(transferToJson(rows[0]));
  93  });
  94  
```

### demo-target/src/wallets.ts
```
   1  import { Router } from "express";
   2  import { pool, inTx } from "./db";
   3  import { ApiError, isUuid, parseAmount } from "./errors";
   4  
   5  const CURRENCIES = ["USD", "EUR", "EGP", "AED"];
   6  
   7  export const walletToJson = (w: any) => ({
   8    id: w.id,
   9    owner: w.owner,
  10    currency: w.currency,
  11    balance: w.balance, // pg returns numeric as a string, e.g. "100.00"
  12    held: w.held,
  13    createdAt: w.created_at,
  14  });
  15  
  16  export const wallets = Router();
  17  
  18  wallets.post("/wallets", async (req, res) => {
  19    const { owner, currency = "USD" } = req.body ?? {};
  20    if (typeof owner !== "string" || owner.trim() === "" || owner.length > 80) {
  21      throw new ApiError(400, "VALIDATION_ERROR", { field: "owner" });
  22    }
  23    if (!CURRENCIES.includes(currency)) {
  24      throw new ApiError(400, "VALIDATION_ERROR", { field: "currency" });
  25    }
  26    const { rows } = await pool.query(
  27      "INSERT INTO wallets (owner, currency) VALUES ($1, $2) RETURNING *",
  28      [owner.trim(), currency],
  29    );
  30    res.status(201).json(walletToJson(rows[0]));
  31  });
  32  
  33  wallets.get("/wallets", async (_req, res) => {
  34    const { rows } = await pool.query("SELECT * FROM wallets ORDER BY created_at, id");
  35    res.json(rows.map(walletToJson));
  36  });
  37  
  38  wallets.get("/wallets/:id", async (req, res) => {
  39    if (!isUuid(req.params.id)) throw new ApiError(404, "WALLET_NOT_FOUND");
  40    const { rows } = await pool.query("SELECT * FROM wallets WHERE id = $1", [req.params.id]);
  41    if (!rows[0]) throw new ApiError(404, "WALLET_NOT_FOUND");
  42    res.json(walletToJson(rows[0]));
  43  });
  44  
  45  wallets.post("/wallets/:id/deposits", async (req, res) => {
  46    if (!isUuid(req.params.id)) throw new ApiError(404, "WALLET_NOT_FOUND");
  47    const amount = parseAmount(req.body?.amount);
  48    const wallet = await inTx(async (c) => {
  49      const { rows } = await c.query(
  50        "UPDATE wallets SET balance = balance + $2 WHERE id = $1 RETURNING *",
  51        [req.params.id, amount],
  52      );
  53      if (!rows[0]) throw new ApiError(404, "WALLET_NOT_FOUND");
  54      await c.query(
  55        "INSERT INTO ledger_entries (wallet_id, direction, kind, amount) VALUES ($1, 'credit', 'deposit', $2)",
  56        [req.params.id, amount],
  57      );
  58      return rows[0];
  59    });
  60    res.status(201).json({ walletId: wallet.id, balance: wallet.balance });
  61  });
  62  
```
