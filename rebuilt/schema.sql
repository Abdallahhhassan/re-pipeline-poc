-- Rebuilt service schema. Our own design: money in integer cents, our own table names.
DROP TABLE IF EXISTS journal;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS accounts;

CREATE TABLE accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holder           text NOT NULL,
  currency         char(3) NOT NULL,
  available_cents  bigint NOT NULL DEFAULT 0 CHECK (available_cents >= 0),
  on_hold_cents    bigint NOT NULL DEFAULT 0 CHECK (on_hold_cents >= 0),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id      uuid NOT NULL REFERENCES accounts(id),
  payee_id      uuid NOT NULL REFERENCES accounts(id),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  fee_cents     bigint NOT NULL CHECK (fee_cents >= 0),
  state         text NOT NULL CHECK (state IN ('completed', 'pending_review')),
  request_key   text UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_payer_day ON payments (payer_id, created_at);

CREATE TABLE journal (
  id          bigserial PRIMARY KEY,
  payment_id  uuid REFERENCES payments(id),
  account_id  uuid NOT NULL REFERENCES accounts(id),
  side        text NOT NULL CHECK (side IN ('debit', 'credit')),
  reason      text NOT NULL,
  cents       bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
