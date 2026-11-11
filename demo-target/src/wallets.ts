import { Router } from "express";
import { pool, inTx } from "./db";
import { ApiError, isUuid, parseAmount } from "./errors";

const CURRENCIES = ["USD", "EUR", "EGP", "AED"];

export const walletToJson = (w: any) => ({
  id: w.id,
  owner: w.owner,
  currency: w.currency,
  balance: w.balance, // pg returns numeric as a string, e.g. "100.00"
  held: w.held,
  createdAt: w.created_at,
});

export const wallets = Router();

wallets.post("/wallets", async (req, res) => {
  const { owner, currency = "USD" } = req.body ?? {};
  if (typeof owner !== "string" || owner.trim() === "" || owner.length > 80) {
    throw new ApiError(400, "VALIDATION_ERROR", { field: "owner" });
  }
  if (!CURRENCIES.includes(currency)) {
    throw new ApiError(400, "VALIDATION_ERROR", { field: "currency" });
  }
  const { rows } = await pool.query(
    "INSERT INTO wallets (owner, currency) VALUES ($1, $2) RETURNING *",
    [owner.trim(), currency],
  );
  res.status(201).json(walletToJson(rows[0]));
});

wallets.get("/wallets", async (_req, res) => {
  const { rows } = await pool.query("SELECT * FROM wallets ORDER BY created_at, id");
  res.json(rows.map(walletToJson));
});

wallets.get("/wallets/:id", async (req, res) => {
  if (!isUuid(req.params.id)) throw new ApiError(404, "WALLET_NOT_FOUND");
  const { rows } = await pool.query("SELECT * FROM wallets WHERE id = $1", [req.params.id]);
  if (!rows[0]) throw new ApiError(404, "WALLET_NOT_FOUND");
  res.json(walletToJson(rows[0]));
});

wallets.post("/wallets/:id/deposits", async (req, res) => {
  if (!isUuid(req.params.id)) throw new ApiError(404, "WALLET_NOT_FOUND");
  const amount = parseAmount(req.body?.amount);
  const wallet = await inTx(async (c) => {
    const { rows } = await c.query(
      "UPDATE wallets SET balance = balance + $2 WHERE id = $1 RETURNING *",
      [req.params.id, amount],
    );
    if (!rows[0]) throw new ApiError(404, "WALLET_NOT_FOUND");
    await c.query(
      "INSERT INTO ledger_entries (wallet_id, direction, kind, amount) VALUES ($1, 'credit', 'deposit', $2)",
      [req.params.id, amount],
    );
    return rows[0];
  });
  res.status(201).json({ walletId: wallet.id, balance: wallet.balance });
});
