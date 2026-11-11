# Rebuild decisions

Built from `out/spec/spec.md`, `out/spec/contract.json` and `out/verify/suite.json` only.

| Unknown | Decision for now |
| --- | --- |
| transfers-U1: how pending_review transfers are approved | Not built. Funds stay held, as observed. Needs a product decision. |
| transfers-U2: fee refund on rejection | Fee charged at creation, as observed. Revisit with U1. |
| transfers-U3: UTC vs local day for the limit | UTC, as observed. Flagged for product. |
| transfers-U4: reused key with a different body | Replays the first transfer, as observed. Consider 422 later. |
| wallets-U1: closing or editing wallets | Not built. |
| ui-U1: fee preview a cent below the charge | Fixed. The screen previews with the same integer rule as the API, so what you see is what you pay. Listed under `parity.accepted`. |
| ui-U2: retries and the Idempotency-Key | One key per attempt. Kept when no answer came back, so pressing Send again cannot pay twice. New key once the server answered or the inputs changed. |

## Quirks found by parity

| Quirk | Decision |
| --- | --- |
| Q1: original rejects some valid amounts such as 4.35 (floating point) | Not copied. Rebuild accepts them; listed under `parity.accepted`. |

Design choices that differ from the original on purpose: money stored as integer cents,
our own table names (`accounts`, `payments`, `journal`), fee computed with integer math.

Screens (`public/`): written from the spec's screen structure and UI rules, not the original's code.
Same addresses (`#/wallets`, `#/send/:id`), labels, button names and messages; our own layout
(wallet cards instead of a table, the fee and balance in a side panel).
