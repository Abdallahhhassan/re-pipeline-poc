# Behavior spec: demo-wallet

Generated from captured traffic, traces, schema and source, then verified against the sandbox.
Seen = a probe passed. Inferred = concluded but not proven. Build from Seen; ask about the rest.

## GET /transfers/:id
Request fields: none

Statuses seen: 200. Tables written: none.

**Verified behavior (Seen)**
- **GET /transfers/:id returns the transfer as created; an unknown id returns 404 TRANSFER_NOT_FOUND.** _(Seen; transfers-F19)_

**Not yet proven (Inferred)**
- none

## GET /wallets/:id
Request fields: none

Statuses seen: 200. Tables written: none.

**Verified behavior (Seen)**
- **GET /wallets/:id returns the wallet with balance and held; a malformed or unknown id returns 404 WALLET_NOT_FOUND.** _(Seen; wallets-F8)_

**Not yet proven (Inferred)**
- none

## POST /transfers
Request fields: `fromWalletId`: string, `toWalletId`: string, `amount`: number | string
Request headers used: `Idempotency-Key`
Statuses seen: 200, 201, 400, 409, 422. Tables written: transfers, ledger_entries, wallets.

**Verified behavior (Seen)**
- **A transfer below the review threshold completes immediately: 201, status "completed", and money values come back as strings with two decimals.** _(Seen; transfers-F1)_
- **The fee is 0.5% of the amount, rounded to cents.** _(Seen; transfers-F2)_
- **The fee never goes below 1.00, so any transfer under 200.00 pays exactly 1.00.** _(Seen; transfers-F3)_
- **Transfers of 5,000.00 or more are not settled; they are created with status "pending_review". 4,999.99 still completes.** _(Seen; transfers-F4)_
- **A pending_review transfer charges the sender amount plus fee right away and moves the amount into the sender's "held" balance; the receiver is not credited.** _(Seen; transfers-F5)_
- **The receiver of a pending_review transfer sees no change to their balance.** _(Seen; transfers-F6)_
- **A completed transfer takes amount plus fee from the sender and gives the receiver the amount only.** _(Seen; transfers-F7)_
- **Each wallet can send at most 10,000.00 per UTC day. Going over returns 422 LIMIT_EXCEEDED with the amount still allowed in "remaining".** _(Seen; transfers-F8)_
- **Pending_review transfers count toward the daily limit.** _(Seen; transfers-F9)_
- **The daily limit is checked before the balance: a wallet with no money that asks for more than the limit gets LIMIT_EXCEEDED, not INSUFFICIENT_FUNDS.** _(Seen; transfers-F10)_
- **The sender must cover amount plus fee; otherwise 409 INSUFFICIENT_FUNDS. A balance of 100.99 cannot send 100.00.** _(Seen; transfers-F11)_
- **Repeating a request with the same Idempotency-Key returns the original transfer with 200 and the header Idempotent-Replay: true, without moving money again.** _(Seen; transfers-F12)_
- **A reused Idempotency-Key returns the original transfer even when the new request asks for a different amount.** _(Seen; transfers-F13)_
- **Sender and receiver must use the same currency; otherwise 422 CURRENCY_MISMATCH.** _(Seen; transfers-F14)_
- **Sending to the same wallet returns 400 SAME_WALLET.** _(Seen; transfers-F15)_
- **Amount must be a JSON number above 0 with at most 2 decimals; strings, zero, negatives and extra decimals return 400 VALIDATION_ERROR with field "amount".** _(Seen; transfers-F16)_
- **Wallet ids must be UUIDs; anything else returns 400 VALIDATION_ERROR naming the field.** _(Seen; transfers-F17)_
- **A well-formed wallet id that does not exist returns 404 WALLET_NOT_FOUND.** _(Seen; transfers-F18)_

**Not yet proven (Inferred)**
- **Each transfer writes ledger entries: a debit for the amount and a debit for the fee on the sender, plus a credit on the receiver only when completed.** _(Inferred; transfers-F20)_

## POST /wallets
Request fields: `owner`: string, `currency`: string

Statuses seen: 201. Tables written: wallets.

**Verified behavior (Seen)**
- **Creating a wallet returns 201 with the owner, currency USD by default, and balance and held both "0.00".** _(Seen; wallets-F1)_
- **Currency must be one of USD, EUR, EGP or AED; anything else returns 400 VALIDATION_ERROR with field "currency".** _(Seen; wallets-F2)_
- **Owner is required: a blank owner returns 400 VALIDATION_ERROR with field "owner".** _(Seen; wallets-F3)_
- **Owner names longer than 80 characters are rejected.** _(Seen; wallets-F4)_
- **Spaces around the owner name are trimmed before saving.** _(Seen; wallets-F5)_

**Not yet proven (Inferred)**
- none

## POST /wallets/:id/deposits
Request fields: `amount`: number

Statuses seen: 201. Tables written: wallets, ledger_entries.

**Verified behavior (Seen)**
- **A deposit adds the amount and returns 201 with the wallet id and the new balance as a two-decimal string.** _(Seen; wallets-F6)_
- **Deposits follow the same amount rules as transfers: zero returns 400 VALIDATION_ERROR.** _(Seen; wallets-F7)_

**Not yet proven (Inferred)**
- none

## Unknowns (people decide before the build)
- **Can wallets be closed, renamed or have their currency changed?** No endpoint for it was observed or found in the routes. _(wallets-U1)_
- **How does a pending_review transfer get approved or rejected?** Funds are held and the receiver is never credited, but no endpoint releases them. _(transfers-U1)_
- **Is the fee refunded if a held transfer is rejected?** The fee is charged at creation even for pending_review. _(transfers-U2)_
- **Should the daily limit follow the UTC day or the customer's local day?** The window starts at midnight UTC, which is 2am in Cairo. _(transfers-U3)_
- **Is returning the old transfer for a reused Idempotency-Key with a different body intended?** Many APIs reject that case with 422 instead. _(transfers-U4)_
