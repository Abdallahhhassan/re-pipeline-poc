<!-- system -->
You are a reverse engineering analyst for a web app's screens. You receive what a browser
crawl saw: each screen's structure (accessibility tree), fields, buttons, links and the API calls it made
on load; then form tries where one value was changed at a time, with the message shown, all visible
text after the click, and each API call with its backend route, status and SQL. You also get the
front-end source with line numbers.

Describe what a person sees and can do, as findings a developer could rebuild the screens from.

Rules:
- Every finding cites evidence: screens as "ui:screen-01", form tries as "ui:ui-003", source lines as
  "src:<file>:<line>".
- route is "UI <screen>", e.g. "UI /#/send/:id".
- Add a uiProbe to every finding a browser can test. The pipeline opens goto (fixture variables are
  available as {{name}}), fills fields by their visible label, clicks the button named in click
  (leave click out to test what shows while typing), then checks expect: text that must be visible,
  an API call that must happen ("POST /transfers 201"), or one that must not ("POST /transfers").
  Each probe runs from fresh data. Findings without a passing probe are capped at "Inferred".
- If a screen calls an API route, you may add a finding for that route with an HTTP "probe" in the
  API shape: { "request": { "method", "path", "body" }, "expect": { "status", "body" } }.
- Separate rules the screen enforces itself (no API call) from rules it only reports from the API.
- Look for places where the screen and the API disagree, for example a value the screen computes
  itself that the API then computes differently. Those go in findings and in unknowns.
- Reply with JSON only, in exactly this shape:
{
  "findings": [
    {
      "id": "F1",
      "route": "UI /#/send/:id",
      "kind": "screen | rule | flow | error",
      "claim": "One plain-language sentence about what the person sees or can do.",
      "tag": "Seen | Inferred | Unknown",
      "evidence": ["ui:ui-003", "ui:screen-02", "src:demo-target/public/app.js:71"],
      "uiProbe": {
        "setup": [ { "name": "optional API step before the page opens", "request": { "method": "POST", "path": "/x", "body": {} } } ],
        "goto": "/#/send/{{alice}}",
        "fill": { "Amount": "0" },
        "click": "Send money",
        "expect": { "text": ["Enter an amount above 0."], "request": "POST /transfers 201", "noRequest": "POST /transfers" }
      }
    }
  ],
  "unknowns": [ { "id": "U1", "question": "...", "why": "...", "evidence": ["src:..."] } ]
}

<!-- user -->
# Area: the UI

Screens: /#/wallets, /#/send/:id

## Fixture variables (available in probes)
- {{alice}}: saved by fixture "create wallet alice"
- {{bob}}: saved by fixture "create wallet bob"
- {{carol}}: saved by fixture "create EUR wallet carol"

## Screens
#### screen-01 /#/wallets: "Wallets"
- fields: none
- buttons: none
- API calls on load:
    - GET /wallets → 200 (route /wallets)
      sql: SELECT * FROM wallets ORDER BY created_at, id
- structure:
```
- main:
  - heading "Wallets" [level=1]
  - table:
    - rowgroup:
      - row "Owner Currency Balance On hold":
        - columnheader "Owner"
        - columnheader "Currency"
        - columnheader "Balance"
        - columnheader "On hold"
        - columnheader
    - rowgroup:
      - row "alice USD 20,000.00 USD 0.00 USD Send money":
        - cell "alice"
        - cell "USD"
        - cell "20,000.00 USD"
        - cell "0.00 USD"
        - cell "Send money":
          - link "Send money":
            - /url: "#/send/7540e47d-00f4-4abc-8642-557d965cbfe2"
      - row "bob USD 0.00 USD 0.00 USD Send money":
        - cell "bob"
        - cell "USD"
        - cell "0.00 USD"
        - cell "0.00 USD"
        - cell "Send money":
          - link "Send money":
            - /url: "#/send/f57ef874-f728-406f-bc45-f814b61f3b1a"
      - row "carol EUR 0.00 EUR 0.00 EUR Send money":
        - cell "carol"
        - cell "EUR"
        - cell "0.00 EUR"
        - cell "0.00 EUR"
        - cell "Send money":
          - link "Send money":
            - /url: "#/send/4c9c961f-c0fd-41e1-87d0-d485f8fe9999"
```

#### screen-02 /#/send/:id: "Send money"
- fields: To (select: bob (USD), carol (EUR)); Amount (input text)
- buttons: Send money
- API calls on load:
    - GET /wallets/:id → 200 (route /wallets/:id)
      sql: SELECT * FROM wallets WHERE id = $1
    - GET /wallets → 200 (route /wallets)
      sql: SELECT * FROM wallets ORDER BY created_at, id
- structure:
```
- main:
  - link "Back to wallets":
    - /url: "#/wallets"
  - heading "Send money" [level=1]
  - paragraph: "From alice: 20,000.00 USD available"
  - text: To
  - combobox "To":
    - option "bob (USD)" [selected]
    - option "carol (EUR)"
  - text: Amount
  - textbox "Amount"
  - paragraph: "Fee: 1.00 USD"
  - button "Send money"
```

## Form tries (one value changed at a time, fresh data each time)
#### ui-001 send money
- typed: {"To":"bob","Amount":"100"}, then clicked "Send money" on /#/send/{{alice}}
- message: Sent 100.00 USD to bob. Fee 1.00 USD.
- API calls after the click:
    - POST /transfers → 201 (route /transfers)
      sql: SELECT * FROM transfers WHERE idempotency_key = $1 | SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE | SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' | INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING * | INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4) | UPDATE wallets SET balance = balance - $2 WHERE id = $1 | UPDATE wallets SET balance = balance + $2 WHERE id = $1 | INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'credit', 'transfer', $3)
    - GET /wallets/:id → 200 (route /wallets/:id)
      sql: SELECT * FROM wallets WHERE id = $1
- visible text after the click:
    > Back to wallets
    > Send money
    > 
    > From alice: 19,899.00 USD available
    > 
    > To
    > bob (USD)
    > carol (EUR)
    > Amount
    > 
    > Fee: 1.00 USD
    > 
    > Send money
    > Sent 100.00 USD to bob. Fee 1.00 USD.

#### ui-002 send money [Amount=""]
- typed: {"To":"bob","Amount":""}, then clicked "Send money" on /#/send/{{alice}}
- message: Enter an amount above 0.
- API calls after the click:
    - none
- visible text after the click:
    > Back to wallets
    > Send money
    > 
    > From alice: 20,000.00 USD available
    > 
    > To
    > bob (USD)
    > carol (EUR)
    > Amount
    > 
    > Fee: 1.00 USD
    > 
    > Send money
    > Enter an amount above 0.

#### ui-003 send money [Amount="0"]
- typed: {"To":"bob","Amount":"0"}, then clicked "Send money" on /#/send/{{alice}}
- message: Enter an amount above 0.
- API calls after the click:
    - none
- visible text after the click:
    > Back to wallets
    > Send money
    > 
    > From alice: 20,000.00 USD available
    > 
    > To
    > bob (USD)
    > carol (EUR)
    > Amount
    > 
    > Fee: 1.00 USD
    > 
    > Send money
    > Enter an amount above 0.

#### ui-004 send money [Amount="1.005"]
- typed: {"To":"bob","Amount":"1.005"}, then clicked "Send money" on /#/send/{{alice}}
- message: Use at most 2 decimals.
- API calls after the click:
    - none
- visible text after the click:
    > Back to wallets
    > Send money
    > 
    > From alice: 20,000.00 USD available
    > 
    > To
    > bob (USD)
    > carol (EUR)
    > Amount
    > 
    > Fee: 1.00 USD
    > 
    > Send money
    > Use at most 2 decimals.

#### ui-005 send money [Amount="4.35"]
- typed: {"To":"bob","Amount":"4.35"}, then clicked "Send money" on /#/send/{{alice}}
- message: Check the amount and try again.
- API calls after the click:
    - POST /transfers → 400 (route /transfers)
    - GET /wallets/:id → 200 (route /wallets/:id)
      sql: SELECT * FROM wallets WHERE id = $1
- visible text after the click:
    > Back to wallets
    > Send money
    > 
    > From alice: 20,000.00 USD available
    > 
    > To
    > bob (USD)
    > carol (EUR)
    > Amount
    > 
    > Fee: 1.00 USD
    > 
    > Send money
    > Check the amount and try again.

#### ui-006 send money [Amount="205"]
- typed: {"To":"bob","Amount":"205"}, then clicked "Send money" on /#/send/{{alice}}
- message: Sent 205.00 USD to bob. Fee 1.03 USD.
- API calls after the click:
    - POST /transfers → 201 (route /transfers)
      sql: SELECT * FROM transfers WHERE idempotency_key = $1 | SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE | SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' | INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING * | INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4) | UPDATE wallets SET balance = balance - $2 WHERE id = $1 | UPDATE wallets SET balance = balance + $2 WHERE id = $1 | INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'credit', 'transfer', $3)
    - GET /wallets/:id → 200 (route /wallets/:id)
      sql: SELECT * FROM wallets WHERE id = $1
- visible text after the click:
    > Back to wallets
    > Send money
    > 
    > From alice: 19,793.97 USD available
    > 
    > To
    > bob (USD)
    > carol (EUR)
    > Amount
    > 
    > Fee: 1.02 USD
    > 
    > Send money
    > Sent 205.00 USD to bob. Fee 1.03 USD.

#### ui-007 send money [Amount="5000"]
- typed: {"To":"bob","Amount":"5000"}, then clicked "Send money" on /#/send/{{alice}}
- message: Transfer of 5,000.00 USD to bob is waiting for review. Fee 25.00 USD was charged.
- API calls after the click:
    - POST /transfers → 201 (route /transfers)
      sql: SELECT * FROM transfers WHERE idempotency_key = $1 | SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE | SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' | INSERT INTO transfers (from_wallet_id, to_wallet_id, amount, fee, status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING * | INSERT INTO ledger_entries (transfer_id, wallet_id, direction, kind, amount) VALUES ($1, $2, 'debit', 'transfer', $3), ($1, $2, 'debit', 'fee', $4) | UPDATE wallets SET balance = balance - $2, held = held + $3 WHERE id = $1
    - GET /wallets/:id → 200 (route /wallets/:id)
      sql: SELECT * FROM wallets WHERE id = $1
- visible text after the click:
    > Back to wallets
    > Send money
    > 
    > From alice: 14,975.00 USD available
    > 
    > To
    > bob (USD)
    > carol (EUR)
    > Amount
    > 
    > Fee: 25.00 USD
    > 
    > Send money
    > Transfer of 5,000.00 USD to bob is waiting for review. Fee 25.00 USD was charged.

#### ui-008 send money [Amount="10000.01"]
- typed: {"To":"bob","Amount":"10000.01"}, then clicked "Send money" on /#/send/{{alice}}
- message: Daily limit reached. You can still send 10,000.00 USD today.
- API calls after the click:
    - POST /transfers → 422 (route /transfers)
      sql: SELECT * FROM transfers WHERE idempotency_key = $1 | SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE | SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE from_wallet_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' | ROLLBACK
    - GET /wallets/:id → 200 (route /wallets/:id)
      sql: SELECT * FROM wallets WHERE id = $1
- visible text after the click:
    > Back to wallets
    > Send money
    > 
    > From alice: 20,000.00 USD available
    > 
    > To
    > bob (USD)
    > carol (EUR)
    > Amount
    > 
    > Fee: 50.00 USD
    > 
    > Send money
    > Daily limit reached. You can still send 10,000.00 USD today.

#### ui-009 send to EUR wallet
- typed: {"To":"carol","Amount":"50"}, then clicked "Send money" on /#/send/{{alice}}
- message: Both wallets must use the same currency.
- API calls after the click:
    - POST /transfers → 422 (route /transfers)
      sql: SELECT * FROM transfers WHERE idempotency_key = $1 | SELECT * FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE | ROLLBACK
    - GET /wallets/:id → 200 (route /wallets/:id)
      sql: SELECT * FROM wallets WHERE id = $1
- visible text after the click:
    > Back to wallets
    > Send money
    > 
    > From alice: 20,000.00 USD available
    > 
    > To
    > bob (USD)
    > carol (EUR)
    > Amount
    > 
    > Fee: 1.00 USD
    > 
    > Send money
    > Both wallets must use the same currency.

## Front-end source
### demo-target/public/app.js
```
   1  // Demo wallet UI: a wallets list and a send-money screen, talking to the same API.
   2  const view = document.getElementById("view");
   3  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
   4  const money = (v, cur) =>
   5    `${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
   6  
   7  async function api(method, path, body, headers = {}) {
   8    const res = await fetch(path, {
   9      method,
  10      headers: body ? { "content-type": "application/json", ...headers } : headers,
  11      body: body ? JSON.stringify(body) : undefined,
  12    });
  13    return { status: res.status, body: await res.json().catch(() => null) };
  14  }
  15  
  16  /** Same fee rule as the server, shown before sending: 0.5%, never below 1.00. */
  17  const feeFor = (amount) => Math.max(1, Math.round(amount * 0.005 * 100) / 100);
  18  
  19  async function showWallets() {
  20    document.title = "Wallets";
  21    const { body } = await api("GET", "/wallets");
  22    view.innerHTML = `<h1>Wallets</h1>
  23      <table>
  24        <thead><tr><th>Owner</th><th>Currency</th><th>Balance</th><th>On hold</th><th></th></tr></thead>
  25        <tbody>${body
  26          .map(
  27            (w) => `<tr><td>${esc(w.owner)}</td><td>${w.currency}</td><td>${money(w.balance, w.currency)}</td>
  28            <td>${money(w.held, w.currency)}</td><td><a href="#/send/${w.id}">Send money</a></td></tr>`,
  29          )
  30          .join("")}</tbody>
  31      </table>`;
  32  }
  33  
  34  async function showSend(id) {
  35    document.title = "Send money";
  36    const [{ body: from }, { body: all }] = await Promise.all([api("GET", `/wallets/${id}`), api("GET", "/wallets")]);
  37    if (!from || from.error) {
  38      view.innerHTML = `<h1>Wallet not found</h1><a href="#/wallets">Back to wallets</a>`;
  39      return;
  40    }
  41    const others = all.filter((w) => w.id !== id);
  42    view.innerHTML = `<a href="#/wallets">Back to wallets</a>
  43      <h1>Send money</h1>
  44      <p id="from">From ${esc(from.owner)}: ${money(from.balance, from.currency)} available</p>
  45      <form novalidate>
  46        <label for="to">To</label>
  47        <select id="to">${others.map((w) => `<option value="${w.id}">${esc(w.owner)} (${w.currency})</option>`).join("")}</select>
  48        <label for="amount">Amount</label>
  49        <input id="amount" inputmode="decimal" autocomplete="off">
  50        <p id="fee">Fee: 1.00 ${from.currency}</p>
  51        <button type="submit">Send money</button>
  52      </form>
  53      <div id="message" role="status" aria-live="polite"></div>`;
  54  
  55    const amount = document.getElementById("amount");
  56    const fee = document.getElementById("fee");
  57    const msg = document.getElementById("message");
  58    const say = (kind, text) => {
  59      msg.className = kind;
  60      msg.textContent = text;
  61    };
  62  
  63    amount.addEventListener("input", () => {
  64      const a = Number(amount.value);
  65      fee.textContent = `Fee: ${money(a > 0 ? feeFor(a) : 1, from.currency)}`;
  66    });
  67  
  68    view.querySelector("form").addEventListener("submit", async (e) => {
  69      e.preventDefault();
  70      const raw = amount.value.trim();
  71      if (!raw || !(Number(raw) > 0)) return say("error", "Enter an amount above 0.");
  72      if (!/^\d+(\.\d{1,2})?$/.test(raw)) return say("error", "Use at most 2 decimals.");
  73      const to = others.find((w) => w.id === document.getElementById("to").value);
  74      const button = view.querySelector("button");
  75      button.disabled = true;
  76      const { status, body } = await api(
  77        "POST",
  78        "/transfers",
  79        { fromWalletId: id, toWalletId: to.id, amount: Number(raw) },
  80        { "Idempotency-Key": crypto.randomUUID() },
  81      );
  82      button.disabled = false;
  83      if (status === 201 && body.status === "completed") {
  84        say("ok", `Sent ${money(body.amount, from.currency)} to ${to.owner}. Fee ${money(body.fee, from.currency)}.`);
  85      } else if (status === 201) {
  86        say("wait", `Transfer of ${money(body.amount, from.currency)} to ${to.owner} is waiting for review. Fee ${money(body.fee, from.currency)} was charged.`);
  87      } else if (body?.error === "LIMIT_EXCEEDED") {
  88        say("error", `Daily limit reached. You can still send ${money(body.remaining, from.currency)} today.`);
  89      } else if (body?.error === "INSUFFICIENT_FUNDS") {
  90        say("error", "Not enough balance to cover the amount and the fee.");
  91      } else if (body?.error === "CURRENCY_MISMATCH") {
  92        say("error", "Both wallets must use the same currency.");
  93      } else if (body?.error === "VALIDATION_ERROR") {
  94        say("error", "Check the amount and try again.");
  95      } else {
  96        say("error", "Something went wrong. Try again.");
  97      }
  98      const { body: fresh } = await api("GET", `/wallets/${id}`);
  99      document.getElementById("from").textContent = `From ${fresh.owner}: ${money(fresh.balance, fresh.currency)} available`;
 100    });
 101  }
 102  
 103  function route() {
 104    const hash = location.hash || "#/wallets";
 105    if (hash.startsWith("#/send/")) showSend(hash.slice("#/send/".length));
 106    else showWallets();
 107  }
 108  window.addEventListener("hashchange", route);
 109  route();
 110  
```

### demo-target/public/index.html
```
   1  <!DOCTYPE html>
   2  <html lang="en">
   3  <head>
   4  <meta charset="utf-8">
   5  <meta name="viewport" content="width=device-width, initial-scale=1">
   6  <title>Wallets</title>
   7  <style>
   8    /* The original app's look: a plain internal tool. */
   9    body { font: 14px/1.45 Tahoma, Verdana, sans-serif; margin: 0; background: #eceff1; color: #222; }
  10    header { background: #37474f; color: #fff; padding: 10px 18px; font-weight: bold; }
  11    main { max-width: 760px; margin: 18px auto; background: #fff; border: 1px solid #c5ccd0; padding: 18px 22px; }
  12    h1 { font-size: 20px; margin: 4px 0 14px; }
  13    table { border-collapse: collapse; width: 100%; }
  14    th, td { border: 1px solid #c5ccd0; padding: 6px 8px; text-align: left; }
  15    th { background: #f3f5f6; }
  16    form { display: grid; grid-template-columns: 90px 260px; gap: 10px 12px; align-items: center; margin: 14px 0; }
  17    input, select { font: inherit; padding: 4px 6px; }
  18    button { grid-column: 2; font: inherit; padding: 6px 12px; background: #1565c0; color: #fff; border: 0; cursor: pointer; justify-self: start; }
  19    button[disabled] { background: #90a4ae; }
  20    #fee { grid-column: 2; margin: 0; color: #555; }
  21    #message { min-height: 22px; padding: 8px 10px; }
  22    #message.ok { background: #e8f5e9; border: 1px solid #a5d6a7; }
  23    #message.wait { background: #fff8e1; border: 1px solid #ffe082; }
  24    #message.error { background: #ffebee; border: 1px solid #ef9a9a; }
  25    #message:empty { display: none; }
  26  </style>
  27  </head>
  28  <body>
  29  <header>Wallet Admin</header>
  30  <main id="view">Loading…</main>
  31  <script src="app.js"></script>
  32  </body>
  33  </html>
  34  
```
