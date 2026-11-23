# Math review of public/engine.js

Each item: the formula, the check done, the result. Tests named here live in test/engine.test.js
(default run) or run with ENGINE_FULL=1 (heavy sweeps).

## Findings fixed

1. **Fold when checking is free (bug).** With toCall = 0 the EV of fold (0) could equal the EV of
   check (0 when the equity is 0), so fold could be "best", and a small EV gap rated fold "good".
   Fix: with nothing to call the best move is never fold, and a fold is rated at most "mistake"
   unless it is already a "blunder". Check: 2000 scenarios with toCall = 0
   (heavy sweep "checking is free") and 150 in the default run. Result: fold never best, never above check.

2. **Random seeds depended on the scenario id.** Equity, raise-fold draws and template choice were
   seeded from `S.id`, so the same situation with another id gave other numbers.
   Fix: all seeds come from `situationSeed(S)`, a hash of hero, board, street, pot, stacks, seats,
   actions and history. Check: default test "deterministic ... whatever the scenario id"; heavy
   sweep of 200 scenarios x 20 evaluations (deep equal in en and es); evaluate run with
   `Math.random` replaced by a throwing function. Result: pass.

3. **Raise on a medium hand against a strong range.** A one-pair or weak two-pair hand under 55%
   chance to win could be raised only because folds were likely. Fix: postflop, such a raise needs
   a weak narrowed villain range (wide label) or 55% chance to win. Text: "they rarely have much" is
   only used when the range is weak. Check: test "weak two pair ... does not claim strength" (40
   seeds, en and es). Result: pass.

## Checked, formula correct

4. **Hand evaluator** (`scoreCards`, `evaluateHand`). Category from rank and suit counts; kickers
   from the best five cards only. Check: 20000 random 7-card hands against brute force over all
   21 five-card subsets (default test). Result: identical.

5. **Chance to win vs random cards** (`randomWinPct`). Win + tie/(t+1) over all deals (t = number
   of opponents tied with the hero). Exact by enumeration for one opponent on the river (C(45,2) =
   990 deals) and turn (46 x 990 = 45540 deals). Otherwise a seeded Monte Carlo of 60000 deals,
   one standard error <= 0.20 points at 50% (95% interval about +-0.4 points).
   Check: independent loop over the 990 river deals for AA against one random hand gives 89.343%;
   the engine gives 89.3% (exact). Result: pass.

6. **Chance to win vs range** (`equityDetail`). Monte Carlo over villain range weights, 3000
   samples by default: one standard error about 0.9 points at 50% (95% about +-1.8). Check: AA vs
   KK about 82% (default test). Result: consistent with the standard error.

7. **Pot odds** = call / (pot + call). Check: a 5 BB call into a 10 BB pot shows 33%
   (default test). Result: pass. A covering all-in adds a 5-point stack-off margin (see 13).

8. **SPR** = effective stack / pot, where the effective stack is min(hero, live villains) of the
   chips still behind. Check: code review. Result: correct; it uses remaining stacks, not totals.

9. **Outs** (`drawInfo`). Each unseen card that raises the hand category is counted once, so a card
   that completes both a flush and a straight is not double counted. Hit chance over the cards to
   come: 1 - C(n-o, k)/C(n, k), exact for "at least one of the outs". Limits: it counts pair-
   improving cards too, and no discount is applied for a paired board or flush danger. Result:
   formula exact for the stated meaning; the discount is not implemented.

10. **Draw chance** (`drawChance`, Result.drawChance). Only flush and straight draws, completed by a
    single card (backdoor draws that need two cards are excluded, so they are understated).
    Hypergeometric, exact. Check: flush draw on the flop (Ah Kh on 2h 7h 9c): 9 outs,
    1 - C(38,2)/C(47,2) = 35.0% (default test). Rule of four gives 36% (overstates by 1.0 point);
    rule of two on the turn gives 18% against an exact 19.6% (understates by 1.6). Result: exact.

11. **Call EV** = E x realization x (pot + call) - call, with the call capped at the hero's stack.
    Realization 0.92 out of position is an assumption. Check: cap test (default). Result: formula
    correct; realization is a heuristic.

12. **Multiway raise EV** (`raiseEV`). Per deal: each villain folds with its fold probability; the
    callers pay min(raise - bet, stack); the hero wins w of pot + added chips and loses (1 - w) of
    the hero's extra chips. With all folding, the hero collects the pot. Check: derivation by hand
    (the hero's extra chips return when uncalled) and the premium-hand test (default in the heavy
    sweep). Result: consistent.

## Heuristics (stated, not exact)

13. **Fold equity** (`foldProb`): style and bet-size model. It decides raise EV directly. Example
    found: J7 offsuit preflop, passive player who has not acted, chart says fold but the EV model
    recommends a raise. The decision was left unchanged; the chart and the EV model disagree there.

14. **Covering all-in margin**: 5 points subtracted from realized chance when calling an all-in that
    covers the hero. A judgement value, not derived.

15. **Implied odds bonus**: 3% of (pot + call) x chance, only with 100 BB or more and not on the
    river. A judgement value, not derived.

## Board sentences (board odds)

16. **Chance that an opponent improves on this board** (`boardOdds`). Random hole cards for each
    opponent, random remaining board cards, seeded Monte Carlo of 1500 deals (cached per board and
    opponent count). A pair counts only when a hole card pairs the board or the hole cards are a pocket
    pair; flush means category 5 or better; straight means category 4 (per deal, any opponent).
    Standard error at most 1.3 points at 50%. Thresholds for the words (both languages):
    >= 75% very high / muy alta, >= 50% high / alta, >= 25% medium / media, otherwise low / baja.
    Check: tests "board sentence uses suit symbols ..." checks that the words match the printed
    percentage. Result: pass. Preflop sentences state the table size (`numPlayers`) and the chart
    action (limp, raise, fold).

## Calibration (raise sizes, fold equity, ratings, street mix)

17. **Raise size.** One standard size per situation, the amount the Raise button applies (`raiseSize`, shown
    as `bestRaiseAmount`): preflop open 2.5 BB + 1 BB per limper; facing an open 3x (late seats) or 4x (out of
    position); facing a 3-bet 2.2x; postflop bet 2/3 pot, facing a bet raise to 3x. A shove replaces it when the
    size would commit 70%+ of the remaining stack or the stack is 15 BB or less. The verdict compares fold, call
    and this size only. Check: tests "raise: the verdict uses one standard size ..." and "all-in only when ...".
    Result: all-in best moves on 600 seeds fell from 98 to 12.

18. **Fold probability** (`foldProb`): 0.22 + 0.28 x bet/pot (cap 1.25), x style multiplier, x (1.15 - 0.5 x
    narrowed range strength), x0.9 if the villain raised or bet, capped at 10% for a villain who already called
    or limped (committed), and 0 for a shove against a covering villain with a strong range; clamped to
    [2%, 70%] per villain. Multiway: the product over villains, as before.

19. **Preflop gate.** Facing an open or a 3-bet, a raise needs a raise cell in the range chart or at least 45%
    chance to win. Without either, the raise rests on fold equity alone, which trash hands are not given.
    Check: test "no trash hand ... raises facing an open or a 3-bet"; heavy sweep over 2000 spots.
    Result: raise rate facing a raise 22.5% -> 6.7%; premium share of those raises 30.6% -> 62.2%.

20. **Medium postflop gate.** Unchanged in logic: a one-pair or weak two-pair raise under 55% chance to win needs a
    weak narrowed villain range. `Result.raiseGated` reports when a gate blocked a raise with higher EV.

21. **Ratings** (BB, relative to the pot): best if the action is the best and loses under 0.05 BB; good within
    max(0.3, 5% of pot); mistake up to max(1.5, 20% of pot); blunder above that. Score: best 100; good 80-96;
    mistake 40-79; blunder 0-39 (0 only at twice the blunder threshold or more). A free-check fold is capped at
    mistake (40). Check: test "ratings follow the score bands"; 19 of 600 zero scores were all large losses.

22. **Street mix.** The target street is drawn once per scenario (uniform over four streets); retries only
    re-simulate the hand until the hero decides on that street. Check: heavy test over 1000 seeds (each street
    between 20% and 30%). Result: preflop 26.8%, flop 25.0%, turn 23.5%, river 24.7%.

23. **Board odds** (item 16): the Monte Carlo sample count is 800 (standard error about 1.8 points at 50%).

### Before and after (600 seeds 5000+i, action 'call')

| measure | before | after |
|---|---|---|
| best move = raise | 309 (51.5%) | 225 (37.5%) |
| raise to near all-in | 98 (16.3%) | 12 (2.0%) |
| call rated blunder | 256 (42.7%) | 113 (18.8%) |
| preflop share | 505 (84.2%) | 141 (23.5%) |

Facing a raise, 2000 preflop seeds: raise rate 22.5% -> 6.7%; premium share 30.6% -> 62.2%.
First-in agreement with `getRangeChart` (raise cell): 82.4%, unchanged.

**Target not met:** the call-blunder rate is 18.8% on the mixed street set (11.8% preflop only). Most of
these are calls with clearly negative EV (for example a preflop call of a hand the chart folds, or a losing
postflop call), which the rating correctly marks as blunders. The 8% target would need the random hero hands
or the thresholds to change, which the rating rules do not allow.

Audit (AUDIT_SCALE=0.2): 42 checks, 0 failures. Audit expectations updated: toCall capped at the hero stack;
one standard raise size with an all-in only when flagged; the call EV includes the stack-off margin and the
implied-odds term; the chart verdict uses the scenario's stack depth; a gated raise is not the verdict; premium
folds are judged by pot odds.

## Limits

- Chance numbers are exact only for the enumerated cases above; other cases are Monte Carlo with
  the error stated.
- Outs stats count pair-improving cards; the draw chance counts only flush and straight outs.
