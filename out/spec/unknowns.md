# Unknowns

- [ ] Can wallets be closed, renamed or have their currency changed? (wallets-U1)
- [ ] How does a pending_review transfer get approved or rejected? (transfers-U1)
- [ ] Is the fee refunded if a held transfer is rejected? (transfers-U2)
- [ ] Should the daily limit follow the UTC day or the customer's local day? (transfers-U3)
- [ ] Is returning the old transfer for a reused Idempotency-Key with a different body intended? (transfers-U4)
- [ ] Which fee is right when the preview and the charge disagree (205.00: 1.02 shown, 1.03 charged)? Should the screen ask the API for the fee instead of computing it? (ui-U1)
- [ ] Should a retry after a failed or lost response reuse the same Idempotency-Key? (ui-U2)
