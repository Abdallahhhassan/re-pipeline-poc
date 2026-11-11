# Reverse engineering run: demo-wallet

Run at 2026-11-11T11:34:23.492Z.

| Measure | Value |
| --- | --- |
| Findings | 44 |
| Proven by a probe (Seen) | 42 |
| Claims refuted by their probe | 1 |
| Open unknowns for people | 7 |
| Rebuild parity | 71/75 match, 4 accepted, 0 open |

## Refuted claims (go back to analysis)
- ui-F16: The amount field accepts thousands separators, the same way the screen shows money ("1,000" sends 1,000.00).

## Unknowns (people decide)
- Can wallets be closed, renamed or have their currency changed? (wallets-U1)
- How does a pending_review transfer get approved or rejected? (transfers-U1)
- Is the fee refunded if a held transfer is rejected? (transfers-U2)
- Should the daily limit follow the UTC day or the customer's local day? (transfers-U3)
- Is returning the old transfer for a reused Idempotency-Key with a different body intended? (transfers-U4)
- Which fee is right when the preview and the charge disagree (205.00: 1.02 shown, 1.03 charged)? Should the screen ask the API for the fee instead of computing it? (ui-U1)
- Should a retry after a failed or lost response reuse the same Idempotency-Key? (ui-U2)

Details: out/spec/spec.md, out/verify/results.json, out/parity/report.md
