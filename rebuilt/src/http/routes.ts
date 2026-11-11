import { Router } from "express";
import { Account, accounts, journal, Payment, payments, transaction } from "../store";
import { Fail, looksLikeId } from "./fail";
import { formatCents, toCents } from "../domain/money";
import { DAILY_SEND_LIMIT, feeFor, MAX_OWNER_LENGTH, stateFor, SUPPORTED_CURRENCIES } from "../domain/rules";

const showAccount = (a: Account) => ({
  id: a.id,
  owner: a.holder,
  currency: a.currency,
  balance: formatCents(a.available_cents),
  held: formatCents(a.on_hold_cents),
  createdAt: a.created_at,
});

const showPayment = (p: Payment) => ({
  id: p.id,
  fromWalletId: p.payer_id,
  toWalletId: p.payee_id,
  amount: formatCents(p.amount_cents),
  fee: formatCents(p.fee_cents),
  status: p.state,
  createdAt: p.created_at,
});

export const routes = Router();

routes.post("/wallets", async (req, res) => {
  const owner = typeof req.body?.owner === "string" ? req.body.owner.trim() : "";
  if (!owner || owner.length > MAX_OWNER_LENGTH) throw new Fail(400, "VALIDATION_ERROR", { field: "owner" });
  const currency = req.body?.currency ?? "USD";
  if (!SUPPORTED_CURRENCIES.has(currency)) throw new Fail(400, "VALIDATION_ERROR", { field: "currency" });
  res.status(201).json(showAccount(await accounts.create(owner, currency)));
});

// Found by the browser crawl: the wallets screen lists everything, oldest first.
routes.get("/wallets", async (_req, res) => {
  res.json((await accounts.all()).map(showAccount));
});

routes.get("/wallets/:id", async (req, res) => {
  const account = looksLikeId(req.params.id) ? await accounts.find(req.params.id) : undefined;
  if (!account) throw new Fail(404, "WALLET_NOT_FOUND");
  res.json(showAccount(account));
});

routes.post("/wallets/:id/deposits", async (req, res) => {
  if (!looksLikeId(req.params.id)) throw new Fail(404, "WALLET_NOT_FOUND");
  const cents = toCents(req.body?.amount);
  const account = await transaction(async (tx) => {
    const updated = await accounts.move(tx, req.params.id, cents);
    if (!updated) throw new Fail(404, "WALLET_NOT_FOUND");
    await journal(tx, [{ account: updated.id, side: "credit", reason: "deposit", cents }]);
    return updated;
  });
  res.status(201).json({ walletId: account.id, balance: formatCents(account.available_cents) });
});

routes.post("/transfers", async (req, res) => {
  const { fromWalletId, toWalletId, amount } = req.body ?? {};
  if (!looksLikeId(fromWalletId)) throw new Fail(400, "VALIDATION_ERROR", { field: "fromWalletId" });
  if (!looksLikeId(toWalletId)) throw new Fail(400, "VALIDATION_ERROR", { field: "toWalletId" });
  const cents = toCents(amount);
  if (fromWalletId === toWalletId) throw new Fail(400, "SAME_WALLET");

  // Decision U4: a reused key replays the first payment, whatever the new body says (matches the original).
  const key = req.get("Idempotency-Key") ?? null;
  if (key) {
    const earlier = await payments.byKey(key);
    if (earlier) {
      res.set("Idempotent-Replay", "true").status(200).json(showPayment(earlier));
      return;
    }
  }

  const payment = await transaction(async (tx) => {
    const { first: payer, second: payee } = await accounts.lockPair(tx, fromWalletId, toWalletId);
    if (!payer || !payee) throw new Fail(404, "WALLET_NOT_FOUND");
    if (payer.currency !== payee.currency) throw new Fail(422, "CURRENCY_MISMATCH");

    const sent = await payments.sentTodayCents(tx, payer.id);
    if (sent + cents > DAILY_SEND_LIMIT) {
      throw new Fail(422, "LIMIT_EXCEEDED", { remaining: Math.max(0, DAILY_SEND_LIMIT - sent) / 100 });
    }
    const fee = feeFor(cents);
    if (Number(payer.available_cents) < cents + fee) throw new Fail(409, "INSUFFICIENT_FUNDS");

    const state = stateFor(cents);
    const p = await payments.insert(tx, { payer: payer.id, payee: payee.id, amount: cents, fee, state, key });
    const entries: Parameters<typeof journal>[1] = [
      { payment: p.id, account: payer.id, side: "debit", reason: "transfer", cents },
      { payment: p.id, account: payer.id, side: "debit", reason: "fee", cents: fee },
    ];
    if (state === "completed") {
      await accounts.move(tx, payer.id, -(cents + fee));
      await accounts.move(tx, payee.id, cents);
      entries.push({ payment: p.id, account: payee.id, side: "credit", reason: "transfer", cents });
    } else {
      // Decision U1/U2: held until a review flow exists; fee is charged now, as observed.
      await accounts.move(tx, payer.id, -(cents + fee), cents);
    }
    await journal(tx, entries);
    return p;
  });
  res.status(201).json(showPayment(payment));
});

routes.get("/transfers/:id", async (req, res) => {
  const payment = looksLikeId(req.params.id) ? await payments.find(req.params.id) : undefined;
  if (!payment) throw new Fail(404, "TRANSFER_NOT_FOUND");
  res.json(showPayment(payment));
});
