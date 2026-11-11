### ledger_entries
| column | type | nullable | default |
| --- | --- | --- | --- |
| id | bigint | no | nextval('ledger_entries_id_seq'::regclass) |
| transfer_id | uuid | yes |  |
| wallet_id | uuid | no |  |
| direction | text | no |  |
| kind | text | no |  |
| amount | numeric | no |  |
| created_at | timestamp with time zone | no | now() |

- ledger_entries_direction_check: CHECK ((direction = ANY (ARRAY['debit'::text, 'credit'::text])))
- ledger_entries_pkey: PRIMARY KEY (id)
- ledger_entries_transfer_id_fkey: FOREIGN KEY (transfer_id) REFERENCES transfers(id)
- ledger_entries_wallet_id_fkey: FOREIGN KEY (wallet_id) REFERENCES wallets(id)

### transfers
| column | type | nullable | default |
| --- | --- | --- | --- |
| id | uuid | no | gen_random_uuid() |
| from_wallet_id | uuid | no |  |
| to_wallet_id | uuid | no |  |
| amount | numeric | no |  |
| fee | numeric | no |  |
| status | text | no |  |
| idempotency_key | text | yes |  |
| created_at | timestamp with time zone | no | now() |

- transfers_from_wallet_id_fkey: FOREIGN KEY (from_wallet_id) REFERENCES wallets(id)
- transfers_idempotency_key_key: UNIQUE (idempotency_key)
- transfers_pkey: PRIMARY KEY (id)
- transfers_to_wallet_id_fkey: FOREIGN KEY (to_wallet_id) REFERENCES wallets(id)

### wallets
| column | type | nullable | default |
| --- | --- | --- | --- |
| id | uuid | no | gen_random_uuid() |
| owner | text | no |  |
| currency | character | no | 'USD'::bpchar |
| balance | numeric | no | 0 |
| held | numeric | no | 0 |
| created_at | timestamp with time zone | no | now() |

- wallets_pkey: PRIMARY KEY (id)
