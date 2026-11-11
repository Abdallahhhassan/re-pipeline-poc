<!-- system -->
You are a reverse engineering analyst. You receive evidence about one area of a running system:
recorded HTTP requests and responses, the database statements each request ran (from traces),
the database schema, and the source files behind these routes with line numbers.

Describe how the system behaves, as findings a developer could rebuild it from.

Rules:
- Every finding cites evidence: recording ids (e.g. "probe-014"), traces as "trace:<recording id>",
  source lines as "src:<file>:<line>".
- tag: "Seen" if a recording directly shows it, "Inferred" if you concluded it from code or several
  observations, "Unknown" if the evidence cannot settle it.
- Add a probe to every finding that HTTP calls can test. The pipeline runs each probe on a fresh
  sandbox after the fixtures, so the fixture variables listed below are available as {{name}}.
  Findings without a passing probe are capped at "Inferred", so prefer testable claims.
- Cover edge cases the code reveals even if no recording hit them (thresholds, limits, states).
- Claims describe behavior in plain words: inputs, outputs, states, limits, errors. No code.
- Put open questions in "unknowns": behavior the code hints at that no endpoint or evidence settles.
- Reply with JSON only, in exactly this shape:
{
  "findings": [
    {
      "id": "F1",
      "route": "POST /transfers",
      "kind": "rule | flow | data | error | contract",
      "claim": "One plain-language sentence about behavior.",
      "tag": "Seen | Inferred | Unknown",
      "evidence": ["probe-014", "trace:flow-005", "src:demo-target/src/policy.ts:12"],
      "probe": {
        "setup": [ { "name": "optional extra step", "request": { "method": "POST", "path": "/x", "body": {} }, "save": { "var": "body.id" } } ],
        "request": { "method": "POST", "path": "/transfers", "headers": {}, "body": { "fromWalletId": "{{alice}}" } },
        "expect": { "status": 422, "body": { "error": "LIMIT_EXCEEDED" }, "headers": {} }
      }
    }
  ],
  "unknowns": [ { "id": "U1", "question": "...", "why": "...", "evidence": ["src:..."] } ]
}

<!-- user -->
# Area: /wallets

Routes observed: /wallets, /wallets/:id/deposits, /wallets/:id

## Fixture variables (available in probes)
- {{alice}}: saved by fixture "create wallet alice"
- {{bob}}: saved by fixture "create wallet bob"
- {{carol}}: saved by fixture "create EUR wallet carol"

## Recorded requests
#### fixture-001 (fixture) create wallet alice
- request: POST /wallets headers={"content-type":"application/json"} body={"owner":"alice"}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea","owner":"alice","currency":"USD","balance":"0.00","held":"0.00","createdAt":"2026-11-11T09:07:18.564Z"}
- route: /wallets
- sql:
    - INSERT INTO wallets (owner, currency) VALUES ($1, $2) RETURNING *  values=["alice","USD"]

#### fixture-002 (fixture) create wallet bob
- request: POST /wallets headers={"content-type":"application/json"} body={"owner":"bob"}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"fa43818e-91b1-4c7d-a552-2bb69c13229d","owner":"bob","currency":"USD","balance":"0.00","held":"0.00","createdAt":"2026-11-11T09:07:18.573Z"}
- route: /wallets
- sql:
    - INSERT INTO wallets (owner, currency) VALUES ($1, $2) RETURNING *  values=["bob","USD"]

#### fixture-003 (fixture) create EUR wallet carol
- request: POST /wallets headers={"content-type":"application/json"} body={"owner":"carol","currency":"EUR"}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"a8dc73ac-3b5b-4592-9e2f-863834fefe72","owner":"carol","currency":"EUR","balance":"0.00","held":"0.00","createdAt":"2026-11-11T09:07:18.578Z"}
- route: /wallets
- sql:
    - INSERT INTO wallets (owner, currency) VALUES ($1, $2) RETURNING *  values=["carol","EUR"]

#### fixture-004 (fixture) fund alice
- request: POST /wallets/decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea/deposits headers={"content-type":"application/json"} body={"amount":20000}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"walletId":"decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea","balance":"20000.00"}
- route: /wallets/:id/deposits
- sql:
    - BEGIN
    - UPDATE wallets SET balance = balance + $2 WHERE id = $1 RETURNING *  values=["decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea","20000"]
    - INSERT INTO ledger_entries (wallet_id, direction, kind, amount) VALUES ($1, 'credit', 'deposit', $2)  values=["decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea","20000"]
    - COMMIT

#### flow-008 (flow) view sender wallet
- request: GET /wallets/decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea headers={} body=null
- response: 200 headers={"content-type":"application/json; charset=utf-8"} body={"id":"decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea","owner":"alice","currency":"USD","balance":"19899.00","held":"0.00","createdAt":"2026-11-11T09:07:18.564Z"}
- route: /wallets/:id
- sql:
    - SELECT * FROM wallets WHERE id = $1  values=["decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea"]

#### flow-009 (flow) view receiver wallet
- request: GET /wallets/fa43818e-91b1-4c7d-a552-2bb69c13229d headers={} body=null
- response: 200 headers={"content-type":"application/json; charset=utf-8"} body={"id":"fa43818e-91b1-4c7d-a552-2bb69c13229d","owner":"bob","currency":"USD","balance":"100.00","held":"0.00","createdAt":"2026-11-11T09:07:18.573Z"}
- route: /wallets/:id
- sql:
    - SELECT * FROM wallets WHERE id = $1  values=["fa43818e-91b1-4c7d-a552-2bb69c13229d"]

## Database schema
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


## Source files
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
  33  wallets.get("/wallets/:id", async (req, res) => {
  34    if (!isUuid(req.params.id)) throw new ApiError(404, "WALLET_NOT_FOUND");
  35    const { rows } = await pool.query("SELECT * FROM wallets WHERE id = $1", [req.params.id]);
  36    if (!rows[0]) throw new ApiError(404, "WALLET_NOT_FOUND");
  37    res.json(walletToJson(rows[0]));
  38  });
  39  
  40  wallets.post("/wallets/:id/deposits", async (req, res) => {
  41    if (!isUuid(req.params.id)) throw new ApiError(404, "WALLET_NOT_FOUND");
  42    const amount = parseAmount(req.body?.amount);
  43    const wallet = await inTx(async (c) => {
  44      const { rows } = await c.query(
  45        "UPDATE wallets SET balance = balance + $2 WHERE id = $1 RETURNING *",
  46        [req.params.id, amount],
  47      );
  48      if (!rows[0]) throw new ApiError(404, "WALLET_NOT_FOUND");
  49      await c.query(
  50        "INSERT INTO ledger_entries (wallet_id, direction, kind, amount) VALUES ($1, 'credit', 'deposit', $2)",
  51        [req.params.id, amount],
  52      );
  53      return rows[0];
  54    });
  55    res.status(201).json({ walletId: wallet.id, balance: wallet.balance });
  56  });
  57  
```
