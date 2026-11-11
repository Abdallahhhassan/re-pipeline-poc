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
- request: POST /transfers headers={"content-type":"application/json","Idempotency-Key":"flow-1"} body={"fromWalletId":"decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea","toWalletId":"fa43818e-91b1-4c7d-a552-2bb69c13229d","amount":100}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"78913a2d-b104-4d53-b713-7777c5028c5a","fromWalletId":"decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea","toWalletId":"fa43818e-91b1-4c7d-a552-2bb69c13229d","amount":"100.00","fee":"1.00","status":"completed","createdAt":"2026-11-11T09:07:18.594Z"}
- route: /transfers
- sql:
    - SELECT * FROM transfers WHERE idempotency_key = $1  values=["flow-1"]
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea\",\"fa43818e-91b1-4c7d-a552-2bb69c13229d\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea"]
    - INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *  values=["decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea","fa43818e-91b1-4c7d-a552-2bb69c13229d","100","1","completed","flow-1"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)  values=["78913a2d-b104-4d53-b713-7777c5028c5a","decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea","100","1"]
    - UPDATE wallets SET balance = balance - $2 WHERE id = $1  values=["decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea","101"]
    - UPDATE wallets SET balance = balance + $2 WHERE id = $1  values=["fa43818e-91b1-4c7d-a552-2bb69c13229d","100"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'credit', 'transfer', $3)  values=["78913a2d-b104-4d53-b713-7777c5028c5a","fa43818e-91b1-4c7d-a552-2bb69c13229d","100"]
    - COMMIT

#### flow-006 (flow) retry the same request
- request: POST /transfers headers={"content-type":"application/json","Idempotency-Key":"flow-1"} body={"fromWalletId":"decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea","toWalletId":"fa43818e-91b1-4c7d-a552-2bb69c13229d","amount":100}
- response: 200 headers={"content-type":"application/json; charset=utf-8","idempotent-replay":"true"} body={"id":"78913a2d-b104-4d53-b713-7777c5028c5a","fromWalletId":"decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea","toWalletId":"fa43818e-91b1-4c7d-a552-2bb69c13229d","amount":"100.00","fee":"1.00","status":"completed","createdAt":"2026-11-11T09:07:18.594Z"}
- route: /transfers
- sql:
    - SELECT * FROM transfers WHERE idempotency_key = $1  values=["flow-1"]

#### flow-007 (flow) view transfer
- request: GET /transfers/78913a2d-b104-4d53-b713-7777c5028c5a headers={} body=null
- response: 200 headers={"content-type":"application/json; charset=utf-8"} body={"id":"78913a2d-b104-4d53-b713-7777c5028c5a","fromWalletId":"decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea","toWalletId":"fa43818e-91b1-4c7d-a552-2bb69c13229d","amount":"100.00","fee":"1.00","status":"completed","createdAt":"2026-11-11T09:07:18.594Z"}
- route: /transfers/:id
- sql:
    - SELECT * FROM transfers WHERE id = $1  values=["78913a2d-b104-4d53-b713-7777c5028c5a"]

#### flow-010 (flow) send to EUR wallet
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea","toWalletId":"a8dc73ac-3b5b-4592-9e2f-863834fefe72","amount":50}
- response: 422 headers={"content-type":"application/json; charset=utf-8"} body={"error":"CURRENCY_MISMATCH"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea\",\"a8dc73ac-3b5b-4592-9e2f-863834fefe72\"]"]
    - ROLLBACK

#### flow-011 (flow) bob sends more than he has
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"fa43818e-91b1-4c7d-a552-2bb69c13229d","toWalletId":"decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea","amount":500}
- response: 409 headers={"content-type":"application/json; charset=utf-8"} body={"error":"INSUFFICIENT_FUNDS"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"fa43818e-91b1-4c7d-a552-2bb69c13229d\",\"decf4781-c3e0-49d6-9a4f-6b5b2a13c1ea\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["fa43818e-91b1-4c7d-a552-2bb69c13229d"]
    - ROLLBACK

#### probe-016 (probe) send money [amount=0]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"401f9773-a054-4821-adcc-c8a630cf56ad","toWalletId":"5efde300-2189-4f6f-a369-3c06120a78c1","amount":0}
- response: 400 headers={"content-type":"application/json; charset=utf-8"} body={"error":"VALIDATION_ERROR","field":"amount"}
- route: /transfers
- sql: none

#### probe-021 (probe) send money [amount=-5]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"950e742f-4761-4ba9-b4d3-752bda9abc23","toWalletId":"0784a0da-12bd-4e53-a78c-57dc7e277dbb","amount":-5}
- response: 400 headers={"content-type":"application/json; charset=utf-8"} body={"error":"VALIDATION_ERROR","field":"amount"}
- route: /transfers
- sql: none

#### probe-026 (probe) send money [amount=0.005]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"820f6eed-b578-43b4-9e79-b82aee4ffca3","toWalletId":"ae71101b-ba72-46c5-a3a4-1fa22339e69a","amount":0.005}
- response: 400 headers={"content-type":"application/json; charset=utf-8"} body={"error":"VALIDATION_ERROR","field":"amount","reason":"max 2 decimals"}
- route: /transfers
- sql: none

#### probe-031 (probe) send money [amount=1.5]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"98f09686-87a4-4e92-b1ee-8982c75a3738","toWalletId":"1220450b-10d0-4d38-9018-4a9cc13a9474","amount":1.5}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"aa587433-3b15-4459-a2c8-1722af69a895","fromWalletId":"98f09686-87a4-4e92-b1ee-8982c75a3738","toWalletId":"1220450b-10d0-4d38-9018-4a9cc13a9474","amount":"1.50","fee":"1.00","status":"completed","createdAt":"2026-11-11T09:07:18.909Z"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"98f09686-87a4-4e92-b1ee-8982c75a3738\",\"1220450b-10d0-4d38-9018-4a9cc13a9474\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["98f09686-87a4-4e92-b1ee-8982c75a3738"]
    - INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *  values=["98f09686-87a4-4e92-b1ee-8982c75a3738","1220450b-10d0-4d38-9018-4a9cc13a9474","1.5","1","completed","null"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)  values=["aa587433-3b15-4459-a2c8-1722af69a895","98f09686-87a4-4e92-b1ee-8982c75a3738","1.5","1"]
    - UPDATE wallets SET balance = balance - $2 WHERE id = $1  values=["98f09686-87a4-4e92-b1ee-8982c75a3738","2.5"]
    - UPDATE wallets SET balance = balance + $2 WHERE id = $1  values=["1220450b-10d0-4d38-9018-4a9cc13a9474","1.5"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'credit', 'transfer', $3)  values=["aa587433-3b15-4459-a2c8-1722af69a895","1220450b-10d0-4d38-9018-4a9cc13a9474","1.5"]
    - COMMIT

#### probe-036 (probe) send money [amount=199.99]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"28e4d0a8-1717-4369-8163-8ef275c7e58c","toWalletId":"4740c277-2f31-4436-934f-f3f771d1af69","amount":199.99}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"02cb0906-2f92-41fe-a95e-76ff91e4d277","fromWalletId":"28e4d0a8-1717-4369-8163-8ef275c7e58c","toWalletId":"4740c277-2f31-4436-934f-f3f771d1af69","amount":"199.99","fee":"1.00","status":"completed","createdAt":"2026-11-11T09:07:18.986Z"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"28e4d0a8-1717-4369-8163-8ef275c7e58c\",\"4740c277-2f31-4436-934f-f3f771d1af69\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["28e4d0a8-1717-4369-8163-8ef275c7e58c"]
    - INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *  values=["28e4d0a8-1717-4369-8163-8ef275c7e58c","4740c277-2f31-4436-934f-f3f771d1af69","199.99","1","completed","null"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)  values=["02cb0906-2f92-41fe-a95e-76ff91e4d277","28e4d0a8-1717-4369-8163-8ef275c7e58c","199.99","1"]
    - UPDATE wallets SET balance = balance - $2 WHERE id = $1  values=["28e4d0a8-1717-4369-8163-8ef275c7e58c","200.99"]
    - UPDATE wallets SET balance = balance + $2 WHERE id = $1  values=["4740c277-2f31-4436-934f-f3f771d1af69","199.99"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'credit', 'transfer', $3)  values=["02cb0906-2f92-41fe-a95e-76ff91e4d277","4740c277-2f31-4436-934f-f3f771d1af69","199.99"]
    - COMMIT

#### probe-041 (probe) send money [amount=4999.99]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"0941f34c-e21a-4c0a-93c4-9775b3db786a","toWalletId":"b52eb497-b816-4940-bdc4-f1c0fdc8ddc2","amount":4999.99}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"73347cd2-5689-4b75-88a3-bdf74b943c95","fromWalletId":"0941f34c-e21a-4c0a-93c4-9775b3db786a","toWalletId":"b52eb497-b816-4940-bdc4-f1c0fdc8ddc2","amount":"4999.99","fee":"25.00","status":"completed","createdAt":"2026-11-11T09:07:19.068Z"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"0941f34c-e21a-4c0a-93c4-9775b3db786a\",\"b52eb497-b816-4940-bdc4-f1c0fdc8ddc2\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["0941f34c-e21a-4c0a-93c4-9775b3db786a"]
    - INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *  values=["0941f34c-e21a-4c0a-93c4-9775b3db786a","b52eb497-b816-4940-bdc4-f1c0fdc8ddc2","4999.99","25","completed","null"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)  values=["73347cd2-5689-4b75-88a3-bdf74b943c95","0941f34c-e21a-4c0a-93c4-9775b3db786a","4999.99","25"]
    - UPDATE wallets SET balance = balance - $2 WHERE id = $1  values=["0941f34c-e21a-4c0a-93c4-9775b3db786a","5024.99"]
    - UPDATE wallets SET balance = balance + $2 WHERE id = $1  values=["b52eb497-b816-4940-bdc4-f1c0fdc8ddc2","4999.99"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'credit', 'transfer', $3)  values=["73347cd2-5689-4b75-88a3-bdf74b943c95","b52eb497-b816-4940-bdc4-f1c0fdc8ddc2","4999.99"]
    - COMMIT

#### probe-046 (probe) send money [amount=5000]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"c5d0f9ee-f283-4ae2-94d3-2388e23c235d","toWalletId":"302a6614-bc00-46ea-b5a0-79a125b71a83","amount":5000}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"98786e4e-298e-4893-b974-dab3cdbab5b9","fromWalletId":"c5d0f9ee-f283-4ae2-94d3-2388e23c235d","toWalletId":"302a6614-bc00-46ea-b5a0-79a125b71a83","amount":"5000.00","fee":"25.00","status":"pending_review","createdAt":"2026-11-11T09:07:19.152Z"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"c5d0f9ee-f283-4ae2-94d3-2388e23c235d\",\"302a6614-bc00-46ea-b5a0-79a125b71a83\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["c5d0f9ee-f283-4ae2-94d3-2388e23c235d"]
    - INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *  values=["c5d0f9ee-f283-4ae2-94d3-2388e23c235d","302a6614-bc00-46ea-b5a0-79a125b71a83","5000","25","pending_review","null"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)  values=["98786e4e-298e-4893-b974-dab3cdbab5b9","c5d0f9ee-f283-4ae2-94d3-2388e23c235d","5000","25"]
    - UPDATE wallets SET balance = balance - $2, held = held + $3 WHERE id = $1  values=["c5d0f9ee-f283-4ae2-94d3-2388e23c235d","5025","5000"]
    - COMMIT

#### probe-051 (probe) send money [amount=10000]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"626bc304-7923-44aa-8481-d54871fc3bd1","toWalletId":"9f2f3487-aa00-470c-b8c0-00adcbea551b","amount":10000}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"0997e031-e72c-4c55-87be-49054ea47a6d","fromWalletId":"626bc304-7923-44aa-8481-d54871fc3bd1","toWalletId":"9f2f3487-aa00-470c-b8c0-00adcbea551b","amount":"10000.00","fee":"50.00","status":"pending_review","createdAt":"2026-11-11T09:07:19.219Z"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"626bc304-7923-44aa-8481-d54871fc3bd1\",\"9f2f3487-aa00-470c-b8c0-00adcbea551b\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["626bc304-7923-44aa-8481-d54871fc3bd1"]
    - INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *  values=["626bc304-7923-44aa-8481-d54871fc3bd1","9f2f3487-aa00-470c-b8c0-00adcbea551b","10000","50","pending_review","null"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)  values=["0997e031-e72c-4c55-87be-49054ea47a6d","626bc304-7923-44aa-8481-d54871fc3bd1","10000","50"]
    - UPDATE wallets SET balance = balance - $2, held = held + $3 WHERE id = $1  values=["626bc304-7923-44aa-8481-d54871fc3bd1","10050","10000"]
    - COMMIT

#### probe-056 (probe) send money [amount=10000.01]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"6e20fcc2-c501-4308-a615-b6920bec9e6e","toWalletId":"e06911d3-5c3a-475a-ac64-19e7234f87a6","amount":10000.01}
- response: 422 headers={"content-type":"application/json; charset=utf-8"} body={"error":"LIMIT_EXCEEDED","remaining":10000}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"6e20fcc2-c501-4308-a615-b6920bec9e6e\",\"e06911d3-5c3a-475a-ac64-19e7234f87a6\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["6e20fcc2-c501-4308-a615-b6920bec9e6e"]
    - ROLLBACK

#### probe-061 (probe) send money [amount="100"]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"556fa0d2-785b-4471-8783-d0acb84e3f5d","toWalletId":"9fdc0e13-25c8-4fba-90d7-b3c32600c2d6","amount":"100"}
- response: 400 headers={"content-type":"application/json; charset=utf-8"} body={"error":"VALIDATION_ERROR","field":"amount"}
- route: /transfers
- sql: none

#### probe-066 (probe) send money [amount=4.35]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"e2142d3c-4092-45fe-86ba-27b79971695f","toWalletId":"0b2b91ba-fc04-4ddc-9707-e54784d73d83","amount":4.35}
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
