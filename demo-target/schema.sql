-- Demo target schema: a small wallet service.
-- Stands in for "our own system" until real access is granted.
DROP TABLE IF EXISTS ledger_entries;
DROP TABLE IF EXISTS transfers;
DROP TABLE IF EXISTS wallets;

CREATE TABLE wallets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner       text NOT NULL,
  currency    char(3) NOT NULL DEFAULT 'USD',
  balance     numeric(14,2) NOT NULL DEFAULT 0,
  held        numeric(14,2) NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transfers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_wallet_id   uuid NOT NULL REFERENCES wallets(id),
  to_wallet_id     uuid NOT NULL REFERENCES wallets(id),
  amount           numeric(14,2) NOT NULL,
  fee              numeric(14,2) NOT NULL,
  status           text NOT NULL,
  idempotency_key  text UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id           bigserial PRIMARY KEY,
  transfer_id  uuid REFERENCES transfers(id),
  wallet_id    uuid NOT NULL REFERENCES wallets(id),
  direction    text NOT NULL CHECK (direction IN ('debit', 'credit')),
  kind         text NOT NULL,
  amount       numeric(14,2) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
