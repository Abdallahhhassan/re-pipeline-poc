// Demo wallet UI: a wallets list and a send-money screen, talking to the same API.
const view = document.getElementById("view");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (v, cur) =>
  `${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;

async function api(method, path, body, headers = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Same fee rule as the server, shown before sending: 0.5%, never below 1.00. */
const feeFor = (amount) => Math.max(1, Math.round(amount * 0.005 * 100) / 100);

async function showWallets() {
  document.title = "Wallets";
  const { body } = await api("GET", "/wallets");
  view.innerHTML = `<h1>Wallets</h1>
    <table>
      <thead><tr><th>Owner</th><th>Currency</th><th>Balance</th><th>On hold</th><th></th></tr></thead>
      <tbody>${body
        .map(
          (w) => `<tr><td>${esc(w.owner)}</td><td>${w.currency}</td><td>${money(w.balance, w.currency)}</td>
          <td>${money(w.held, w.currency)}</td><td><a href="#/send/${w.id}">Send money</a></td></tr>`,
        )
        .join("")}</tbody>
    </table>`;
}

async function showSend(id) {
  document.title = "Send money";
  const [{ body: from }, { body: all }] = await Promise.all([api("GET", `/wallets/${id}`), api("GET", "/wallets")]);
  if (!from || from.error) {
    view.innerHTML = `<h1>Wallet not found</h1><a href="#/wallets">Back to wallets</a>`;
    return;
  }
  const others = all.filter((w) => w.id !== id);
  view.innerHTML = `<a href="#/wallets">Back to wallets</a>
    <h1>Send money</h1>
    <p id="from">From ${esc(from.owner)}: ${money(from.balance, from.currency)} available</p>
    <form novalidate>
      <label for="to">To</label>
      <select id="to">${others.map((w) => `<option value="${w.id}">${esc(w.owner)} (${w.currency})</option>`).join("")}</select>
      <label for="amount">Amount</label>
      <input id="amount" inputmode="decimal" autocomplete="off">
      <p id="fee">Fee: 1.00 ${from.currency}</p>
      <button type="submit">Send money</button>
    </form>
    <div id="message" role="status" aria-live="polite"></div>`;

  const amount = document.getElementById("amount");
  const fee = document.getElementById("fee");
  const msg = document.getElementById("message");
  const say = (kind, text) => {
    msg.className = kind;
    msg.textContent = text;
  };

  amount.addEventListener("input", () => {
    const a = Number(amount.value);
    fee.textContent = `Fee: ${money(a > 0 ? feeFor(a) : 1, from.currency)}`;
  });

  view.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const raw = amount.value.trim();
    if (!raw || !(Number(raw) > 0)) return say("error", "Enter an amount above 0.");
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) return say("error", "Use at most 2 decimals.");
    const to = others.find((w) => w.id === document.getElementById("to").value);
    const button = view.querySelector("button");
    button.disabled = true;
    const { status, body } = await api(
      "POST",
      "/transfers",
      { fromWalletId: id, toWalletId: to.id, amount: Number(raw) },
      { "Idempotency-Key": crypto.randomUUID() },
    );
    button.disabled = false;
    if (status === 201 && body.status === "completed") {
      say("ok", `Sent ${money(body.amount, from.currency)} to ${to.owner}. Fee ${money(body.fee, from.currency)}.`);
    } else if (status === 201) {
      say("wait", `Transfer of ${money(body.amount, from.currency)} to ${to.owner} is waiting for review. Fee ${money(body.fee, from.currency)} was charged.`);
    } else if (body?.error === "LIMIT_EXCEEDED") {
      say("error", `Daily limit reached. You can still send ${money(body.remaining, from.currency)} today.`);
    } else if (body?.error === "INSUFFICIENT_FUNDS") {
      say("error", "Not enough balance to cover the amount and the fee.");
    } else if (body?.error === "CURRENCY_MISMATCH") {
      say("error", "Both wallets must use the same currency.");
    } else if (body?.error === "VALIDATION_ERROR") {
      say("error", "Check the amount and try again.");
    } else {
      say("error", "Something went wrong. Try again.");
    }
    const { body: fresh } = await api("GET", `/wallets/${id}`);
    document.getElementById("from").textContent = `From ${fresh.owner}: ${money(fresh.balance, fresh.currency)} available`;
  });
}

function route() {
  const hash = location.hash || "#/wallets";
  if (hash.startsWith("#/send/")) showSend(hash.slice("#/send/".length));
  else showWallets();
}
window.addEventListener("hashchange", route);
route();
