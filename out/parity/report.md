# Parity report

71 of 75 cases match, 4 accepted, 0 open (diff rate 0.0%).

## Accepted differences (reviewed quirks)
- probe: send money [amount=4.35]: Original rejects some valid amounts (4.35 * 100 is not exact in floating point). Rebuild accepts them on purpose.
- claim ui-F13: The fee preview and the charged fee can disagree by a cent: for 205.00 the screen previews 1.02 but the API charges 1.03. The screen rounds 0.5% itself without the API's correction.: Original's fee preview can be a cent below the charge (205.00: 1.02 shown, 1.03 charged). Rebuild previews exactly what the API charges (decision for ui-U1).
- claim ui-F14: A valid amount like 4.35 passes the screen's checks but the API rejects it, so the person sees the generic "Check the amount and try again." This is the API's floating point bug showing through.: The claim describes the original's float bug through the screen. Not copied on purpose.
- ui: send money [Amount="4.35"]: Same quirk seen from the screen: the original shows "Check the amount and try again." for 4.35. The rebuild sends it.

## Open differences
No differences.
