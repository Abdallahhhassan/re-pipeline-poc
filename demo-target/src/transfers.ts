import { Router } from "express";
import { pool, inTx } from "./db";
import { ApiError, isUuid, parseAmount } from "./errors";
import { DAILY_LIMIT, computeFee, needsReview, sentToday } from "./policy";

const transferToJson = (t: any) => ({
  id: t.id,
  fromWalletId: t.from_wallet_id,
  toWalletId: t.to_wallet_id,
  amount: t.amount,
  fee: t.fee,
  status: t.status,
  createdAt: t.created_at,
});

export const transfers = Router();

transfers.post("/transfers", async (req, res) => {
  const { fromWalletId, toWalletId, amount: rawAmount } = req.body ?? {};
  if (!isUuid(fromWalletId)) throw new ApiError(400, "VALIDATION_ERROR", { field: "fromWalletId" });
  if (!isUuid(toWalletId)) throw new ApiError(400, "VALIDATION_ERROR", { field: "toWalletId" });
  const amount = parseAmount(rawAmount);
  if (fromWalletId === toWalletId) throw new ApiError(400, "SAME_WALLET");

  // Idempotency: a repeated key returns the original transfer, even if the body differs.
  const key = req.header("Idempotency-Key") ?? null;
  if (key) {
    const { rows } = await pool.query("SELECT * FROM transfers WHERE idempotency_key = $1", [key]);
    if (rows[0]) {
      res.setHeader("Idempotent-Replay", "true");
      res.status(200).json(transferToJson(rows[0]));
      return;
    }
  }

  const transfer = await inTx(async (c) => {
    const { rows: ws } = await c.query(
      "SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [[fromWalletId, toWalletId]],
    );
    const from = ws.find((w) => w.id === fromWalletId);
    const to = ws.find((w) => w.id === toWalletId);
    if (!from || !to) throw new ApiError(404, "WALLET_NOT_FOUND");
    if (from.currency !== to.currency) throw new ApiError(422, "CURRENCY_MISMATCH");

    const already = await sentToday(c, fromWalletId);
    if (already + amount > DAILY_LIMIT) {
      throw new ApiError(422, "LIMIT_EXCEEDED", { remaining: Math.max(0, DAILY_LIMIT - already) });
    }

    const fee = computeFee(amount);
    if (Number(from.balance) < amount + fee) throw new ApiError(409, "INSUFFICIENT_FUNDS");

    const status = needsReview(amount) ? "pending_review" : "completed";
    const { rows } = await c.query(
      `INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [fromWalletId, toWalletId, amount, fee, status, key],
    );
    const t = rows[0];

    await c.query(
      `INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount)
       VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)`,
      [t.id, fromWalletId, amount, fee],
    );
    if (status === "completed") {
      await c.query("UPDATE wallets SET balance = balance - $2 WHERE id = $1", [fromWalletId, amount + fee]);
      await c.query("UPDATE wallets SET balance = balance + $2 WHERE id = $1", [toWalletId, amount]);
      await c.query(
        `INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount)
         VALUES ($1, $2, 'credit', 'transfer', $3)`,
        [t.id, toWalletId, amount],
      );
    } else {
      // Held for review: sender pays now, receiver is credited only after approval.
      await c.query(
        "UPDATE wallets SET balance = balance - $2, held = held + $3 WHERE id = $1",
        [fromWalletId, amount + fee, amount],
      );
    }
    return t;
  });

  res.status(201).json(transferToJson(transfer));
});

transfers.get("/transfers/:id", async (req, res) => {
  if (!isUuid(req.params.id)) throw new ApiError(404, "TRANSFER_NOT_FOUND");
  const { rows } = await pool.query("SELECT * FROM transfers WHERE id = $1", [req.params.id]);
  if (!rows[0]) throw new ApiError(404, "TRANSFER_NOT_FOUND");
  res.json(transferToJson(rows[0]));
});
