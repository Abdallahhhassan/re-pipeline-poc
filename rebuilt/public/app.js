// Rebuilt screens. Written from the spec's screen structure and UI rules, not from the original's code.
const view = document.getElementById("view");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Money: cents in, "1,234.50 USD" out.
const toCents = (v) => Math.round(Number(v) * 100);
const show = (cents, cur) =>
  `${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
const showAmount = (v, cur) => show(toCents(v), cur);

// Same integer rule as the server (0.5% half-up, at least 1.00), so the preview always equals the charge.
// Decision for ui-U1: the original's preview could be a cent below the charge.
const feeCents = (cents) => Math.max(100, Math.floor((cents * 5 + 500) / 1000));

const MESSAGES = {
  LIMIT_EXCEEDED: (b, cur) => `Daily limit reached. You can still send ${showAmount(b.remaining, cur)} today.`,
  INSUFFICIENT_FUNDS: () => "Not enough balance to cover the amount and the fee.",
  CURRENCY_MISMATCH: () => "Both wallets must use the same currency.",
  VALIDATION_ERROR: () => "Check the amount and try again.",
};

async function call(method, path, body, headers = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function walletsScreen() {
  document.title = "Wallets";
  const { body: list } = await call("GET", "/wallets");
  view.innerHTML = `<h1>Wallets</h1>
    <ul class="grid">${list
      .map(
        (w) => `<li class="wallet">
          <h2>${esc(w.owner)} <span class="cur">${w.currency}</span></h2>
          <p class="bal">${showAmount(w.balance, w.currency)}</p>
          <p class="hold">On hold: ${showAmount(w.held, w.currency)}</p>
          <a href="#/send/${w.id}">Send money</a>
        </li>`,
      )
      .join("")}</ul>`;
}

async function sendScreen(id) {
  document.title = "Send money";
  const [{ status, body: me }, { body: list }] = await Promise.all([call("GET", `/wallets/${id}`), call("GET", "/wallets")]);
  if (status !== 200) {
    view.innerHTML = `<h1>Wallet not found</h1><p><a href="#/wallets">Back to wallets</a></p>`;
    return;
  }
  const others = list.filter((w) => w.id !== id);
  view.innerHTML = `<p><a href="#/wallets">Back to wallets</a></p>
    <h1>Send money</h1>
    <div class="send">
      <form novalidate>
        <label for="payee">To</label>
        <select id="payee">${others.map((w) => `<option value="${w.id}">${esc(w.owner)} (${w.currency})</option>`).join("")}</select>
        <label for="how-much">Amount</label>
        <input id="how-much" inputmode="decimal" autocomplete="off" placeholder="0.00">
        <button type="submit">Send money</button>
        <div id="message" role="status" aria-live="polite"></div>
      </form>
      <aside>
        <p id="from">From ${esc(me.owner)}: ${showAmount(me.balance, me.currency)} available</p>
        <p id="fee" class="big">Fee: ${show(100, me.currency)}</p>
      </aside>
    </div>`;

  const amount = view.querySelector("#how-much");
  const payee = view.querySelector("#payee");
  const message = view.querySelector("#message");
  const say = (kind, text) => {
    message.className = kind;
    message.textContent = text;
  };

  // One key per attempt. Kept when no answer came back, so pressing Send again cannot pay twice
  // (decision for ui-U2); a fresh key once the server has answered or the inputs change.
  let key = crypto.randomUUID();
  const newAttempt = () => (key = crypto.randomUUID());
  payee.addEventListener("change", newAttempt);
  amount.addEventListener("input", () => {
    newAttempt();
    const cents = toCents(amount.value);
    view.querySelector("#fee").textContent = `Fee: ${show(cents > 0 ? feeCents(cents) : 100, me.currency)}`;
  });

  view.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const raw = amount.value.trim();
    if (!raw || !(Number(raw) > 0)) return say("error", "Enter an amount above 0.");
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) return say("error", "Use at most 2 decimals.");
    const to = others.find((w) => w.id === payee.value);
    const button = view.querySelector("button");
    button.disabled = true;
    let answer;
    try {
      answer = await call("POST", "/transfers", { fromWalletId: id, toWalletId: to.id, amount: Number(raw) }, { "Idempotency-Key": key });
    } catch {
      button.disabled = false;
      return say("error", "Something went wrong. Try again.");
    }
    button.disabled = false;
    newAttempt();
    const { status, body } = answer;
    if (status === 201 && body.status === "completed") {
      say("ok", `Sent ${showAmount(body.amount, me.currency)} to ${to.owner}. Fee ${showAmount(body.fee, me.currency)}.`);
    } else if (status === 201) {
      say("wait", `Transfer of ${showAmount(body.amount, me.currency)} to ${to.owner} is waiting for review. Fee ${showAmount(body.fee, me.currency)} was charged.`);
    } else {
      say("error", (MESSAGES[body?.error] ?? (() => "Something went wrong. Try again."))(body, me.currency));
    }
    const { body: now } = await call("GET", `/wallets/${id}`);
    view.querySelector("#from").textContent = `From ${now.owner}: ${showAmount(now.balance, now.currency)} available`;
  });
}

function route() {
  const hash = location.hash || "#/wallets";
  if (hash.startsWith("#/send/")) sendScreen(hash.slice("#/send/".length));
  else walletsScreen();
}
window.addEventListener("hashchange", route);
route();
