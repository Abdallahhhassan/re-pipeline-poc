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
- request: POST /transfers headers={"content-type":"application/json","Idempotency-Key":"flow-1"} body={"fromWalletId":"492e1500-f602-458e-8480-b98f00ed53a3","toWalletId":"6b5514c9-448c-44e4-8953-1caa040a6985","amount":100}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"f78954d3-521a-46ae-ac50-baebdc2ec1fc","fromWalletId":"492e1500-f602-458e-8480-b98f00ed53a3","toWalletId":"6b5514c9-448c-44e4-8953-1caa040a6985","amount":"100.00","fee":"1.00","status":"completed","createdAt":"2026-11-11T11:32:50.471Z"}
- route: /transfers
- sql:
    - SELECT * FROM transfers WHERE idempotency_key = $1  values=["flow-1"]
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"492e1500-f602-458e-8480-b98f00ed53a3\",\"6b5514c9-448c-44e4-8953-1caa040a6985\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["492e1500-f602-458e-8480-b98f00ed53a3"]
    - INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *  values=["492e1500-f602-458e-8480-b98f00ed53a3","6b5514c9-448c-44e4-8953-1caa040a6985","100","1","completed","flow-1"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)  values=["f78954d3-521a-46ae-ac50-baebdc2ec1fc","492e1500-f602-458e-8480-b98f00ed53a3","100","1"]
    - UPDATE wallets SET balance = balance - $2 WHERE id = $1  values=["492e1500-f602-458e-8480-b98f00ed53a3","101"]
    - UPDATE wallets SET balance = balance + $2 WHERE id = $1  values=["6b5514c9-448c-44e4-8953-1caa040a6985","100"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'credit', 'transfer', $3)  values=["f78954d3-521a-46ae-ac50-baebdc2ec1fc","6b5514c9-448c-44e4-8953-1caa040a6985","100"]
    - COMMIT

#### flow-006 (flow) retry the same request
- request: POST /transfers headers={"content-type":"application/json","Idempotency-Key":"flow-1"} body={"fromWalletId":"492e1500-f602-458e-8480-b98f00ed53a3","toWalletId":"6b5514c9-448c-44e4-8953-1caa040a6985","amount":100}
- response: 200 headers={"content-type":"application/json; charset=utf-8","idempotent-replay":"true"} body={"id":"f78954d3-521a-46ae-ac50-baebdc2ec1fc","fromWalletId":"492e1500-f602-458e-8480-b98f00ed53a3","toWalletId":"6b5514c9-448c-44e4-8953-1caa040a6985","amount":"100.00","fee":"1.00","status":"completed","createdAt":"2026-11-11T11:32:50.471Z"}
- route: /transfers
- sql:
    - SELECT * FROM transfers WHERE idempotency_key = $1  values=["flow-1"]

#### flow-007 (flow) view transfer
- request: GET /transfers/f78954d3-521a-46ae-ac50-baebdc2ec1fc headers={} body=null
- response: 200 headers={"content-type":"application/json; charset=utf-8"} body={"id":"f78954d3-521a-46ae-ac50-baebdc2ec1fc","fromWalletId":"492e1500-f602-458e-8480-b98f00ed53a3","toWalletId":"6b5514c9-448c-44e4-8953-1caa040a6985","amount":"100.00","fee":"1.00","status":"completed","createdAt":"2026-11-11T11:32:50.471Z"}
- route: /transfers/:id
- sql:
    - SELECT * FROM transfers WHERE id = $1  values=["f78954d3-521a-46ae-ac50-baebdc2ec1fc"]

#### flow-010 (flow) send to EUR wallet
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"492e1500-f602-458e-8480-b98f00ed53a3","toWalletId":"563b0876-2d5d-4875-b34b-caba771a40bf","amount":50}
- response: 422 headers={"content-type":"application/json; charset=utf-8"} body={"error":"CURRENCY_MISMATCH"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"492e1500-f602-458e-8480-b98f00ed53a3\",\"563b0876-2d5d-4875-b34b-caba771a40bf\"]"]
    - ROLLBACK

#### flow-011 (flow) bob sends more than he has
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"6b5514c9-448c-44e4-8953-1caa040a6985","toWalletId":"492e1500-f602-458e-8480-b98f00ed53a3","amount":500}
- response: 409 headers={"content-type":"application/json; charset=utf-8"} body={"error":"INSUFFICIENT_FUNDS"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"6b5514c9-448c-44e4-8953-1caa040a6985\",\"492e1500-f602-458e-8480-b98f00ed53a3\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["6b5514c9-448c-44e4-8953-1caa040a6985"]
    - ROLLBACK

#### probe-016 (probe) send money [amount=0]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"1c09de8a-22eb-4557-948e-6421829d53b5","toWalletId":"4d96d2b9-9145-4b2b-856e-ee59f25c56e1","amount":0}
- response: 400 headers={"content-type":"application/json; charset=utf-8"} body={"error":"VALIDATION_ERROR","field":"amount"}
- route: /transfers
- sql: none

#### probe-021 (probe) send money [amount=-5]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"403a7e1e-3334-4293-83e1-276d1701d72c","toWalletId":"5abafeff-747e-4327-ad32-dc6646ed5ba5","amount":-5}
- response: 400 headers={"content-type":"application/json; charset=utf-8"} body={"error":"VALIDATION_ERROR","field":"amount"}
- route: /transfers
- sql: none

#### probe-026 (probe) send money [amount=0.005]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"b401b4c9-95dc-4f2c-bfb9-0fb8e1f0c2a6","toWalletId":"4892e06d-4569-44f3-8186-99bfa2340c00","amount":0.005}
- response: 400 headers={"content-type":"application/json; charset=utf-8"} body={"error":"VALIDATION_ERROR","field":"amount","reason":"max 2 decimals"}
- route: /transfers
- sql: none

#### probe-031 (probe) send money [amount=1.5]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"2d027293-ee6d-40aa-bdbe-e3efa8dad59c","toWalletId":"fb4e136f-7dc2-4cb6-bf22-0ef1a5781823","amount":1.5}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"d031ad1b-00e2-410f-9615-ae64cce927de","fromWalletId":"2d027293-ee6d-40aa-bdbe-e3efa8dad59c","toWalletId":"fb4e136f-7dc2-4cb6-bf22-0ef1a5781823","amount":"1.50","fee":"1.00","status":"completed","createdAt":"2026-11-11T11:32:50.805Z"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"2d027293-ee6d-40aa-bdbe-e3efa8dad59c\",\"fb4e136f-7dc2-4cb6-bf22-0ef1a5781823\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["2d027293-ee6d-40aa-bdbe-e3efa8dad59c"]
    - INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *  values=["2d027293-ee6d-40aa-bdbe-e3efa8dad59c","fb4e136f-7dc2-4cb6-bf22-0ef1a5781823","1.5","1","completed","null"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)  values=["d031ad1b-00e2-410f-9615-ae64cce927de","2d027293-ee6d-40aa-bdbe-e3efa8dad59c","1.5","1"]
    - UPDATE wallets SET balance = balance - $2 WHERE id = $1  values=["2d027293-ee6d-40aa-bdbe-e3efa8dad59c","2.5"]
    - UPDATE wallets SET balance = balance + $2 WHERE id = $1  values=["fb4e136f-7dc2-4cb6-bf22-0ef1a5781823","1.5"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'credit', 'transfer', $3)  values=["d031ad1b-00e2-410f-9615-ae64cce927de","fb4e136f-7dc2-4cb6-bf22-0ef1a5781823","1.5"]
    - COMMIT

#### probe-036 (probe) send money [amount=199.99]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"a98f6158-0b39-4152-88a2-76a1b0510ea0","toWalletId":"e2d97c17-d1a7-4f41-ad6b-53b1218a3f17","amount":199.99}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"d57775d4-f1cc-4cf7-b9b3-42b5db3bf5c0","fromWalletId":"a98f6158-0b39-4152-88a2-76a1b0510ea0","toWalletId":"e2d97c17-d1a7-4f41-ad6b-53b1218a3f17","amount":"199.99","fee":"1.00","status":"completed","createdAt":"2026-11-11T11:32:50.878Z"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"a98f6158-0b39-4152-88a2-76a1b0510ea0\",\"e2d97c17-d1a7-4f41-ad6b-53b1218a3f17\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["a98f6158-0b39-4152-88a2-76a1b0510ea0"]
    - INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *  values=["a98f6158-0b39-4152-88a2-76a1b0510ea0","e2d97c17-d1a7-4f41-ad6b-53b1218a3f17","199.99","1","completed","null"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)  values=["d57775d4-f1cc-4cf7-b9b3-42b5db3bf5c0","a98f6158-0b39-4152-88a2-76a1b0510ea0","199.99","1"]
    - UPDATE wallets SET balance = balance - $2 WHERE id = $1  values=["a98f6158-0b39-4152-88a2-76a1b0510ea0","200.99"]
    - UPDATE wallets SET balance = balance + $2 WHERE id = $1  values=["e2d97c17-d1a7-4f41-ad6b-53b1218a3f17","199.99"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'credit', 'transfer', $3)  values=["d57775d4-f1cc-4cf7-b9b3-42b5db3bf5c0","e2d97c17-d1a7-4f41-ad6b-53b1218a3f17","199.99"]
    - COMMIT

#### probe-041 (probe) send money [amount=4999.99]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"8528ebf9-603c-4037-b85b-475fc209f681","toWalletId":"cdb33be7-1110-4414-8511-5ff47a096b0f","amount":4999.99}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"fc8d0905-c06f-4a42-a488-c7791f5c3ae9","fromWalletId":"8528ebf9-603c-4037-b85b-475fc209f681","toWalletId":"cdb33be7-1110-4414-8511-5ff47a096b0f","amount":"4999.99","fee":"25.00","status":"completed","createdAt":"2026-11-11T11:32:50.953Z"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"8528ebf9-603c-4037-b85b-475fc209f681\",\"cdb33be7-1110-4414-8511-5ff47a096b0f\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["8528ebf9-603c-4037-b85b-475fc209f681"]
    - INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *  values=["8528ebf9-603c-4037-b85b-475fc209f681","cdb33be7-1110-4414-8511-5ff47a096b0f","4999.99","25","completed","null"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)  values=["fc8d0905-c06f-4a42-a488-c7791f5c3ae9","8528ebf9-603c-4037-b85b-475fc209f681","4999.99","25"]
    - UPDATE wallets SET balance = balance - $2 WHERE id = $1  values=["8528ebf9-603c-4037-b85b-475fc209f681","5024.99"]
    - UPDATE wallets SET balance = balance + $2 WHERE id = $1  values=["cdb33be7-1110-4414-8511-5ff47a096b0f","4999.99"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'credit', 'transfer', $3)  values=["fc8d0905-c06f-4a42-a488-c7791f5c3ae9","cdb33be7-1110-4414-8511-5ff47a096b0f","4999.99"]
    - COMMIT

#### probe-046 (probe) send money [amount=5000]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"c4d70a98-3864-45ef-b4c2-1928565c08f0","toWalletId":"71df9195-b80c-4321-a90f-6b41a11585ba","amount":5000}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"bfa86aec-edb7-4489-becf-b24ccd43e863","fromWalletId":"c4d70a98-3864-45ef-b4c2-1928565c08f0","toWalletId":"71df9195-b80c-4321-a90f-6b41a11585ba","amount":"5000.00","fee":"25.00","status":"pending_review","createdAt":"2026-11-11T11:32:51.049Z"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"c4d70a98-3864-45ef-b4c2-1928565c08f0\",\"71df9195-b80c-4321-a90f-6b41a11585ba\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["c4d70a98-3864-45ef-b4c2-1928565c08f0"]
    - INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *  values=["c4d70a98-3864-45ef-b4c2-1928565c08f0","71df9195-b80c-4321-a90f-6b41a11585ba","5000","25","pending_review","null"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)  values=["bfa86aec-edb7-4489-becf-b24ccd43e863","c4d70a98-3864-45ef-b4c2-1928565c08f0","5000","25"]
    - UPDATE wallets SET balance = balance - $2, held = held + $3 WHERE id = $1  values=["c4d70a98-3864-45ef-b4c2-1928565c08f0","5025","5000"]
    - COMMIT

#### probe-051 (probe) send money [amount=10000]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"b976946c-71a6-4c41-9b1b-3013cdf68bb2","toWalletId":"6c1100cc-b8d9-47c4-b043-d3df7672b077","amount":10000}
- response: 201 headers={"content-type":"application/json; charset=utf-8"} body={"id":"e4aca8a8-5cc8-4d23-9243-70adad0aeec0","fromWalletId":"b976946c-71a6-4c41-9b1b-3013cdf68bb2","toWalletId":"6c1100cc-b8d9-47c4-b043-d3df7672b077","amount":"10000.00","fee":"50.00","status":"pending_review","createdAt":"2026-11-11T11:32:51.123Z"}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"b976946c-71a6-4c41-9b1b-3013cdf68bb2\",\"6c1100cc-b8d9-47c4-b043-d3df7672b077\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["b976946c-71a6-4c41-9b1b-3013cdf68bb2"]
    - INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *  values=["b976946c-71a6-4c41-9b1b-3013cdf68bb2","6c1100cc-b8d9-47c4-b043-d3df7672b077","10000","50","pending_review","null"]
    - INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4)  values=["e4aca8a8-5cc8-4d23-9243-70adad0aeec0","b976946c-71a6-4c41-9b1b-3013cdf68bb2","10000","50"]
    - UPDATE wallets SET balance = balance - $2, held = held + $3 WHERE id = $1  values=["b976946c-71a6-4c41-9b1b-3013cdf68bb2","10050","10000"]
    - COMMIT

#### probe-056 (probe) send money [amount=10000.01]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"0853a34b-7363-4cee-acb6-8ad58985b8aa","toWalletId":"641795b2-f83a-48f5-888a-eb902defac30","amount":10000.01}
- response: 422 headers={"content-type":"application/json; charset=utf-8"} body={"error":"LIMIT_EXCEEDED","remaining":10000}
- route: /transfers
- sql:
    - BEGIN
    - SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE  values=["[\"0853a34b-7363-4cee-acb6-8ad58985b8aa\",\"641795b2-f83a-48f5-888a-eb902defac30\"]"]
    - SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'  values=["0853a34b-7363-4cee-acb6-8ad58985b8aa"]
    - ROLLBACK

#### probe-061 (probe) send money [amount="100"]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"1e7642a3-76fa-4c0a-9185-3a6409a84e31","toWalletId":"06eef956-6f9d-4c02-8bd0-c79af9929cb3","amount":"100"}
- response: 400 headers={"content-type":"application/json; charset=utf-8"} body={"error":"VALIDATION_ERROR","field":"amount"}
- route: /transfers
- sql: none

#### probe-066 (probe) send money [amount=4.35]
- request: POST /transfers headers={"content-type":"application/json"} body={"fromWalletId":"bf164d8e-2e53-4ebf-8e86-271d0e79ce2f","toWalletId":"11a1fd05-198c-4443-89b4-a0d408b6c466","amount":4.35}
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
