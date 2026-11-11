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
# Area: /transfers

Routes observed: /transfers, /transfers/:id

## Fixture variables (available in probes)
- {{alice}}: saved by fixture "create wallet alice"
- {{bob}}: saved by fixture "create wallet bob"
- {{carol}}: saved by fixture "create EUR wallet carol"

## Recorded requests
#### flow-005 (flow) send money
- request: POST /transfers headers={"content-type":"application/json","Idempotency-Key":"flow-1"} body={"fromWalletId":"10033d43-2075-48db-b2b1-cea295f29d0a","toWalletId":"7b86dd2e-7e8a-4428-8065-c5564ad2b7bf","amount":100}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"adec99b5-6351-4b19-852a-ad4be91fce86","fromWalletId":"10033d43-2075-48db-b2b1-cea295f29d0a","toWalletId":"7b86dd2e-7e8a-4428-8065-c5564ad2b7bf","amount":"100.00","fee":"1.00","status":"completed","createdAt":"2026-11-11T09:41:49.250Z"}
- route: /transfers
- sql:
    - SELECT * FROM transfers WHERE idempotency_key = $1  values=["flow-1"]
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"10033d43-2075-48db-b2b1-cea295f29d0a\",\"7b86dd2e-7e8a-4428-8065-c5564ad2b7bf\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["10033d43-2075-48db-b2b1-cea295f29d0a"]
    - INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *  values=["10033d43-2075-48db-b2b1-cea295f29d0a","7b86dd2e-7e8a-4428-8065-c5564ad2b7bf","100","1","completed","flow-1"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)  values=["adec99b5-6351-4b19-852a-ad4be91fce86","10033d43-2075-48db-b2b1-cea295f29d0a","100","1"]
    - UPDATE wallets SET balance = balance - $2 WHERE id = $1  values=["10033d43-2075-48db-b2b1-cea295f29d0a","101"]
    - UPDATE wallets SET balance = balance + $2 WHERE id = $1  values=["7b86dd2e-7e8a-4428-8065-c5564ad2b7bf","100"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'credit', 'transfer', $3)  values=["adec99b5-6351-4b19-852a-ad4be91fce86","7b86dd2e-7e8a-4428-8065-c5564ad2b7bf","100"]
    - COMMIT

#### flow-006 (flow) retry the same request
- request: POST /transfers headers={"content-type":"application/json","Idempotency-Key":"flow-1"} body={"fromWalletId":"10033d43-2075-48db-b2b1-cea295f29d0a","toWalletId":"7b86dd2e-7e8a-4428-8065-c5564ad2b7bf","amount":100}
- response: 200 headers={"content-type":"application/json; charset=utf-8","idempotent-replay":"true"} body={"id":"adec99b5-6351-4b19-852a-ad4be91fce86","fromWalletId":"10033d43-2075-48db-b2b1-cea295f29d0a","toWalletId":"7b86dd2e-7e8a-4428-8065-c5564ad2b7bf","amount":"100.00","fee":"1.00","status":"completed","createdAt":"2026-11-11T09:41:49.250Z"}
- route: /transfers
- sql:
    - SELECT * FROM transfers WHERE idempotency_key = $1  values=["flow-1"]

#### flow-007 (flow) view transfer
- request: GET /transfers/adec99b5-6351-4b19-852a-ad4be91fce86 headers={} body=null
- response: 200 headers={"content-type":"application/json; charset=utf-8"} body={"id":"adec99b5-6351-4b19-852a-ad4be91fce86","fromWalletId":"10033d43-2075-48db-b2b1-cea295f29d0a","toWalletId":"7b86dd2e-7e8a-4428-8065-c5564ad2b7bf","amount":"100.00","fee":"1.00","status":"completed","createdAt":"2026-11-11T09:41:49.250Z"}
- route: /transfers/:id
- sql:
    - SELECT * FROM transfers WHERE id = $1  values=["adec99b5-6351-4b19-852a-ad4be91fce86"]

#### flow-010 (flow) send to EUR wallet
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"10033d43-2075-48db-b2b1-cea295f29d0a","toWalletId":"b8d9a559-70b7-409a-81ce-dbe70a9ed374","amount":50}
- response: 422 headers={"content-type":"application/json; charset=utf-8"} body={"error":"CURRENCY_MISMATCH"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"10033d43-2075-48db-b2b1-cea295f29d0a\",\"b8d9a559-70b7-409a-81ce-dbe70a9ed374\"]"]
    - ROLLBACK

#### flow-011 (flow) bob sends more than he has
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"7b86dd2e-7e8a-4428-8065-c5564ad2b7bf","toWalletId":"10033d43-2075-48db-b2b1-cea295f29d0a","amount":500}
- response: 409 headers={"content-type":"application/json; charset=utf-8"} body={"error":"INSUFFICIENT_FUNDS"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"7b86dd2e-7e8a-4428-8065-c5564ad2b7bf\",\"10033d43-2075-48db-b2b1-cea295f29d0a\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["7b86dd2e-7e8a-4428-8065-c5564ad2b7bf"]
    - ROLLBACK

#### probe-016 (probe) send money [amount=0]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"d9bed69c-ff5e-4024-8cb3-f90167b3d5ad","toWalletId":"c8458d30-fc8b-4722-abbe-4691fd4d6d43","amount":0}
- response: 400 headers={"content-type":"application/json; charset=utf-8"} body={"error":"VALIDATION_ERROR","field":"amount"}
- route: /transfers
- sql: none

#### probe-021 (probe) send money [amount=-5]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"959bb7a8-01b6-4f9c-b289-72c9744c7581","toWalletId":"06261ff2-dc64-4b55-b84e-294c41390ff6","amount":-5}
- response: 400 headers={"content-type":"application/json; charset=utf-8"} body={"error":"VALIDATION_ERROR","field":"amount"}
- route: /transfers
- sql: none

#### probe-026 (probe) send money [amount=0.005]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"a31f1795-7a31-4ed0-aa72-6a8a6bd412c6","toWalletId":"10096bb5-6df4-4534-9fb5-ef22072bff06","amount":0.005}
- response: 400 headers={"content-type":"application/json; charset=utf-8"} body={"error":"VALIDATION_ERROR","field":"amount","reason":"max 2 decimals"}
- route: /transfers
- sql: none

#### probe-031 (probe) send money [amount=1.5]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"60f50e6c-1e32-4fd5-aa80-25e31369d7d8","toWalletId":"6c81dd93-b645-4cf8-b650-a839aa78c5f6","amount":1.5}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"fc0a4b36-f400-4ac4-a18b-add83cdfca7a","fromWalletId":"60f50e6c-1e32-4fd5-aa80-25e31369d7d8","toWalletId":"6c81dd93-b645-4cf8-b650-a839aa78c5f6","amount":"1.50","fee":"1.00","status":"completed","createdAt":"2026-11-11T09:41:49.675Z"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"60f50e6c-1e32-4fd5-aa80-25e31369d7d8\",\"6c81dd93-b645-4cf8-b650-a839aa78c5f6\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["60f50e6c-1e32-4fd5-aa80-25e31369d7d8"]
    - INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *  values=["60f50e6c-1e32-4fd5-aa80-25e31369d7d8","6c81dd93-b645-4cf8-b650-a839aa78c5f6","1.5","1","completed","null"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)  values=["fc0a4b36-f400-4ac4-a18b-add83cdfca7a","60f50e6c-1e32-4fd5-aa80-25e31369d7d8","1.5","1"]
    - UPDATE wallets SET balance = balance - $2 WHERE id = $1  values=["60f50e6c-1e32-4fd5-aa80-25e31369d7d8","2.5"]
    - UPDATE wallets SET balance = balance + $2 WHERE id = $1  values=["6c81dd93-b645-4cf8-b650-a839aa78c5f6","1.5"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'credit', 'transfer', $3)  values=["fc0a4b36-f400-4ac4-a18b-add83cdfca7a","6c81dd93-b645-4cf8-b650-a839aa78c5f6","1.5"]
    - COMMIT

#### probe-036 (probe) send money [amount=199.99]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"71e029e7-0a97-48e0-b8eb-9f703cbebbf6","toWalletId":"05182c67-db5b-4dd2-b429-b5cc6fce25e9","amount":199.99}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"5dfdc495-436c-4e9f-b0a1-79ed3bb738e0","fromWalletId":"71e029e7-0a97-48e0-b8eb-9f703cbebbf6","toWalletId":"05182c67-db5b-4dd2-b429-b5cc6fce25e9","amount":"199.99","fee":"1.00","status":"completed","createdAt":"2026-11-11T09:41:49.777Z"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"71e029e7-0a97-48e0-b8eb-9f703cbebbf6\",\"05182c67-db5b-4dd2-b429-b5cc6fce25e9\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["71e029e7-0a97-48e0-b8eb-9f703cbebbf6"]
    - INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *  values=["71e029e7-0a97-48e0-b8eb-9f703cbebbf6","05182c67-db5b-4dd2-b429-b5cc6fce25e9","199.99","1","completed","null"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)  values=["5dfdc495-436c-4e9f-b0a1-79ed3bb738e0","71e029e7-0a97-48e0-b8eb-9f703cbebbf6","199.99","1"]
    - UPDATE wallets SET balance = balance - $2 WHERE id = $1  values=["71e029e7-0a97-48e0-b8eb-9f703cbebbf6","200.99"]
    - UPDATE wallets SET balance = balance + $2 WHERE id = $1  values=["05182c67-db5b-4dd2-b429-b5cc6fce25e9","199.99"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'credit', 'transfer', $3)  values=["5dfdc495-436c-4e9f-b0a1-79ed3bb738e0","05182c67-db5b-4dd2-b429-b5cc6fce25e9","199.99"]
    - COMMIT

#### probe-041 (probe) send money [amount=4999.99]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"7252c155-38bf-4d03-a6eb-987ce879fff0","toWalletId":"60ad4517-83c2-490a-81f3-4057f2f50b62","amount":4999.99}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"ac06acd6-0763-4166-8664-31129dd38bdf","fromWalletId":"7252c155-38bf-4d03-a6eb-987ce879fff0","toWalletId":"60ad4517-83c2-490a-81f3-4057f2f50b62","amount":"4999.99","fee":"25.00","status":"completed","createdAt":"2026-11-11T09:41:49.882Z"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"7252c155-38bf-4d03-a6eb-987ce879fff0\",\"60ad4517-83c2-490a-81f3-4057f2f50b62\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["7252c155-38bf-4d03-a6eb-987ce879fff0"]
    - INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *  values=["7252c155-38bf-4d03-a6eb-987ce879fff0","60ad4517-83c2-490a-81f3-4057f2f50b62","4999.99","25","completed","null"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)  values=["ac06acd6-0763-4166-8664-31129dd38bdf","7252c155-38bf-4d03-a6eb-987ce879fff0","4999.99","25"]
    - UPDATE wallets SET balance = balance - $2 WHERE id = $1  values=["7252c155-38bf-4d03-a6eb-987ce879fff0","5024.99"]
    - UPDATE wallets SET balance = balance + $2 WHERE id = $1  values=["60ad4517-83c2-490a-81f3-4057f2f50b62","4999.99"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'credit', 'transfer', $3)  values=["ac06acd6-0763-4166-8664-31129dd38bdf","60ad4517-83c2-490a-81f3-4057f2f50b62","4999.99"]
    - COMMIT

#### probe-046 (probe) send money [amount=5000]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"6fb04686-1819-46b6-81d5-f9d1b2faa2be","toWalletId":"ce532132-8ede-49b2-b857-ae334e2d6123","amount":5000}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"3e26fa79-ff3a-499c-83f6-aa054bfe2e9b","fromWalletId":"6fb04686-1819-46b6-81d5-f9d1b2faa2be","toWalletId":"ce532132-8ede-49b2-b857-ae334e2d6123","amount":"5000.00","fee":"25.00","status":"pending_review","createdAt":"2026-11-11T09:41:49.983Z"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"6fb04686-1819-46b6-81d5-f9d1b2faa2be\",\"ce532132-8ede-49b2-b857-ae334e2d6123\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["6fb04686-1819-46b6-81d5-f9d1b2faa2be"]
    - INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *  values=["6fb04686-1819-46b6-81d5-f9d1b2faa2be","ce532132-8ede-49b2-b857-ae334e2d6123","5000","25","pending_review","null"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)  values=["3e26fa79-ff3a-499c-83f6-aa054bfe2e9b","6fb04686-1819-46b6-81d5-f9d1b2faa2be","5000","25"]
    - UPDATE wallets SET balance = balance - $2, held = held + $3 WHERE id = $1  values=["6fb04686-1819-46b6-81d5-f9d1b2faa2be","5025","5000"]
    - COMMIT

#### probe-051 (probe) send money [amount=10000]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"be282d86-56ef-49e3-9ee1-6b1f9876ea60","toWalletId":"c0bff80f-2148-4eae-815d-433c2af0a812","amount":10000}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"4088b401-dfbd-4500-b2e5-13e2313dc812","fromWalletId":"be282d86-56ef-49e3-9ee1-6b1f9876ea60","toWalletId":"c0bff80f-2148-4eae-815d-433c2af0a812","amount":"10000.00","fee":"50.00","status":"pending_review","createdAt":"2026-11-11T09:41:50.081Z"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"be282d86-56ef-49e3-9ee1-6b1f9876ea60\",\"c0bff80f-2148-4eae-815d-433c2af0a812\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["be282d86-56ef-49e3-9ee1-6b1f9876ea60"]
    - INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *  values=["be282d86-56ef-49e3-9ee1-6b1f9876ea60","c0bff80f-2148-4eae-815d-433c2af0a812","10000","50","pending_review","null"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)  values=["4088b401-dfbd-4500-b2e5-13e2313dc812","be282d86-56ef-49e3-9ee1-6b1f9876ea60","10000","50"]
    - UPDATE wallets SET balance = balance - $2, held = held + $3 WHERE id = $1  values=["be282d86-56ef-49e3-9ee1-6b1f9876ea60","10050","10000"]
    - COMMIT

#### probe-056 (probe) send money [amount=10000.01]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"5f5931ad-ed9a-4536-bbb1-d0dc3d4da5db","toWalletId":"6ae9d6a7-6a37-48cf-9059-be4f114af865","amount":10000.01}
- response: 422 headers={"content-type":"application/json; charset=utf-8"} body={"error":"LIMIT_EXCEEDED","remaining":10000}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"5f5931ad-ed9a-4536-bbb1-d0dc3d4da5db\",\"6ae9d6a7-6a37-48cf-9059-be4f114af865\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["5f5931ad-ed9a-4536-bbb1-d0dc3d4da5db"]
    - ROLLBACK

#### probe-061 (probe) send money [amount="100"]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"70202b41-cd81-4fa7-a1ce-6b307b851a38","toWalletId":"8a85e4f8-9e05-44b5-9c6f-27323ffaeba8","amount":"100"}
- response: 400 headers={"content-type":"application/json; charset=utf-8"} body={"error":"VALIDATION_ERROR","field":"amount"}
- route: /transfers
- sql: none

#### probe-066 (probe) send money [amount=4.35]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"4ce3932e-1551-465b-a294-34a5f4704f92","toWalletId":"2e54d343-329d-463a-81e8-50dc45dbdb17","amount":4.35}
- response: 400 headers={"content-type":"application/json; charset=utf-8"} body={"error":"VALIDATION_ERROR","field":"amount","reason":"max 2 decimals"}
- route: /transfers
- sql: none

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
