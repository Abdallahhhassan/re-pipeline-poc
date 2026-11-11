# Reverse engineering run: demo-wallet

Run at 2026-11-11T09:42:00.558Z.

| Measure | Value |
| --- | --- |
| Findings | 28 |
| Proven by a probe (Seen) | 27 |
| Claims refuted by their probe | 0 |
| Open unknowns for people | 5 |
| Rebuild parity | 48/49 match, 1 accepted, 0 open |

## Refuted claims (go back to analysis)
- none

## Unknowns (people decide)
- Can wallets be closed, renamed or have their currency changed? (wallets-U1)
- How does a pending_review transfer get approved or rejected? (transfers-U1)
- Is the fee refunded if a held transfer is rejected? (transfers-U2)
- Should the daily limit follow the UTC day or the customer's local day? (transfers-U3)
- Is returning the old transfer for a reused Idempotency-Key with a different body intended? (transfers-U4)

Details: out/spec/spec.md, out/verify/results.json, out/parity/report.md
