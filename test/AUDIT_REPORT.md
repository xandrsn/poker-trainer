# Audit report: bots, scripted strategies, call EV

Scope: public/engine.js, public/bots.js, public/game.js, test/*. Time-boxed; items marked NOT DONE were not finished.

## Method

- Strategy grid (`node test/audit-grid.js`): seat 0 is the hero, 5 CPUs drawn from all personalities, 6-handed,
  100 BB. Equal and varied stacks. BB/100 with one standard error. Fixed strategies: always-raise, always-call,
  always-fold, premium-only (preflop top 10% raise, else check or fold). evaluation-best uses engine `evaluate` for each decision.
- Bot personality stats (`BOTS_HANDS=2000 node test/bots-stats.js`).
- Regression tests added for each fix (see below).

## Defects and fixes

**D1. Bets jammed on shallow SPR** (public/bots.js `sizedTo`, `equityChoice`)
- Cause: `sizedTo` returned `L.maxRaiseTo` whenever SPR <= 2.5, including for bets (no current bet).
  A second path, `shortEquity`, jammed bets too when an all-in opponent with a few chips made the
  effective stack short. In a sample seed a bot bet 109 BB into a 9.5 BB pot.
- Fix: `sizedTo(..., isRaise)` jams only raises. `shortEquity` shoves are capped at the effective stack (`st.eff`).
- Test: game.test.js "bot postflop bets are pot-sized" (no postflop bet above the pot unless it is 2 BB or less).
- Before: 5 of 3009 postflop bets in the test sample were over the pot. After: 0 (test passes).
  The task said about 15% of bets were all-ins; that was not re-measured on the full sample.

**D2. Aggressive bluffs with ~0% equity** (public/bots.js `equityChoice`, `BLUFF_FLOOR`)
- Cause: aggressive has `bluffMin: 0.00`, so a raise-bluff (`bluffRaise: 0.70`) was made with any equity.
- Fix: bluff bets and raises need at least `BLUFF_FLOOR = 0.13` equity (the larger of this and the trait's `bluffMin`).
- Effect on personality stats (2000 hands per type, targets as in bots-stats.js):

| type | VPIP before / after (target) | PFR before / after (target) | aggression before / after |
|---|---|---|---|
| tight | 15.0 / 14.6 (16) | 10.7 / 10.5 (12) | 1.09 / 1.12 |
| loose | 44.2 / 43.1 (42) | 12.8 / 12.5 (12) | 0.77 / 0.73 |
| aggressive | 31.4 / 31.3 (30) | 22.0 / 21.7 (24) | 2.65 / 2.29 (>= 2.5) |
| passive | 30.4 / 30.2 (30) | 4.9 / 4.8 (5) | 0.06 / 0.06 |
| balanced | 26.1 / 26.4 (23) | 16.8 / 16.7 (17) | 1.50 / 1.34 (~1.5) |

  VPIP and PFR stay within 1 point. The aggressive aggression ratio dropped below its 2.5 target; not re-tuned.
  The aggressive fold-to-flop-bet rate (audit: 9%, target 25-35%) was NOT re-measured.

**D3. Implied-odds bonus on calls only** (public/engine.js `evaluate`)
- Cause: `impliedBonus = 0.03 * (P+C) * E` for 100+ BB stacks not on the river was added to `callEV` only.
  Raise EV had no matching term, so calls were favoured in deep spots.
- Fix: bonus removed. `callEV` is pot odds only.
- Test: engine.test.js "deep-stack call EV is pot odds only" (checks call EV against win chance x (P+C) - C, with 100 BB forced, within 0.8% of the pot).
- test/audit.js expected formula updated to match (it had mirrored the bonus). Audit: 42 checks, 0 failures at AUDIT_SCALE=0.2.
- Grid, always-call (equal stacks): -1162 before, -883 after (2000 hands). The bias was costing calls about 280 BB/100.

## Strategy grid, before and after (BB/100, +/- 1 SE)

| strategy | stacks | before (2000 hands) | after (2000 hands) |
|---|---|---|---|
| always-raise | equal | -1427 +/- 141 | -1422 +/- 136 |
| always-raise | varied | -1652 +/- 152 | -1722 +/- 151 |
| always-call | equal | -1162 +/- 108 | -883 +/- 84 |
| always-call | varied | -1407 +/- 124 | -1139 +/- 89 |
| always-fold | equal | -22 +/- 1 | -22 +/- 1 |
| premium-only | equal | -76 +/- 17 | -64 +/- 20 |
| premium-only | varied | -79 +/- 20 | -83 +/- 20 |
| evaluation-best | equal | +128 +/- 30 (6000 hands) | +57 +/- 28 (6000 hands) |
| evaluation-best | varied | +54 +/- 32 (6000 hands) | +65 +/- 27 (6000 hands) |

- always-fold is still the best fixed strategy at -22. This is the blind cost of folding every hand (about 1/6 of hands pay a blind), so it is not a bug. The gap to premium-only is 42 BB/100.
- evaluation-best is positive but smaller than before the fix: +57 at equal stacks (1.9 SE), +65 at varied. The drop at equal stacks is consistent with removing the call bias (D3). Whether it is "clearly positive" depends on the bar.

## Known open issue (blocks the full test run)

- test/mp.test.js ("3 humans + 2 bots play 20 hands: chips conserved") FAILS with the current bots.js.
  It passes on the pre-change copy. Bisecting: the failure disappears when the D2 bluff floor is set back to the trait's `bluffMin`.
  The mp error is "chips 1200000 != 1199000 in hand 12", so a chip is lost in a room hand, which points at a path
  in server/room.js or game.js that a bot raise can reach. Not diagnosed. Bot-only game sessions (8951 hands) conserve chips.
- Next step: reproduce that hand with the same seed through server/room.js, find where the amount is applied, then decide between fixing that path and changing the floor.

## Not done (time)

- 3a: realised value by rating bucket from simulated hands. NOT DONE.
- 3b: independent brute-force win %, pot odds and EV for ~40 scenarios. NOT DONE.
- 3c: hand-read ~15 coach spots. NOT DONE.
- D4 (fold equity correlated with hand strength): NOT changed. Residual risk: raiseEV uses independent villain fold probabilities.
- D5 (preflop scenario mix, 54/73 fold-best): NOT changed. Generator weights untouched, so determinism is unaffected.
- Aggressive fold-to-flop-bet rate after the D2 change: NOT re-measured.
- The 15% jam share after D1: NOT re-measured on the full sample.

## Files touched

- public/bots.js: D1 (`sizedTo`, `shortEquity`), D2 (`BLUFF_FLOOR`, `equityChoice`).
- public/engine.js: D3 (`evaluate`, `callEV`).
- test/engine.test.js, test/game.test.js: regression tests.
- test/audit.js: call EV expectation aligned with D3.
- test/audit-grid.js (new): strategy grid (`GRID_ROOT` to compare against another copy).
- No change to app.js, mp.js, server/*, index.html, i18n.js, or user-visible strings.
