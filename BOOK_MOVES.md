# Book moves

A **Book** label means: the move is the best move (same action, EV loss under 0.05 BB) AND it is a standard,
chart-backed play AND it is not obvious. It is shown as `B` (square icon). It sits above Excellent and Good,
below Brilliant and Great.

Book is NOT given just because a decision is preflop, is the first move of the hand, or matches a chart that
is not the best line. A chart move that is not the best (wrong size, real EV loss) is Good or Excellent.

## 0. Criteria (Book, Best or Forced)

- **Best** requires the played action to be the engine's best action, with EV loss under 0.05 BB.
- **Obvious** (never Book, rated Best or Forced instead). A decision is obvious when either:
  - the EV gap between the best line and the second-best line is at least `min(1.0 BB, 25% of (pot + call))`
    (in practice a gap of this size already rates Great, see `rateDecision`), or
  - folding facing a bet with a chance to win of 35% or less (trash), or betting or calling with a chance to win of
    85% or more (a monster), i.e. `OBV_FOLD_WIN` and `OBV_RAISE_WIN` in `public/review.js`.
- **Book** = best + chart primary (or standard c-bet) + not obvious. Otherwise a best move is `best`.
- **Forced** = no chips left to act.
- **Non-obvious standard**: close decisions where the chart has a standard answer and the played line matches it
  with no EV loss. Example: SB raise with JcTs vs two limpers (raise 3 BB, EV loss 0).
- Blunders, mistakes, inaccuracies and misses are never Book.

Test coverage: `test/review.test.js` (book cases: positive book, chart move that is not best, non-chart move, obvious
72o fold is Best, never Book for bad ratings).

Code: `public/review.js` (`bookPreflop`, `isStandardCbet`, the `bookHit` flag in `rateDecision`).
Charts: `public/engine.js` (`chartFreq`, `getRangeChart`, `listChartSpots`), the same charts as the Ranges grid.

## 1. Preflop (chart primary recommendation)

Rule: a preflop decision is Book when

1. the hero's hand class (for example `AKs`) has a chart cell for the table size, position and spot;
2. the cell's primary action equals the action taken (`raise`, `call`/check, or `fold`); sizes are not compared;
3. the EV loss is within the "good" band (see `REVIEW_API.md`, thresholds: `max(0.3 BB, 5% of pot)`).

The chart lookup uses `ENG.getRangeChart(numPlayers, heroPosition, facing, { stackBB })`. The spot (`facing`) comes from the other seats' preflop roles:

| Other seats' roles | Facing (chart spot) |
|---|---|
| none (hero first in) | `open` |
| a `limp` | `vs_limp` |
| an `open` (hero not the opener) | `vs_raise` |
| a `3bet` or `4bet` | `vs_3bet` |

Charts are deterministic per cell (`raise`, `call` or `fold` at frequency 1), so the primary action is well defined.

### Chart coverage (computed, 169 hand classes per spot, stack 100 BB)

| Table | Spot | Raise | Call | Fold |
|---|---|---|---|---|
| 6-max | UTG open | 30 | 0 | 139 |
| 6-max | HJ open | 49 | 0 | 120 |
| 6-max | CO open | 61 | 0 | 108 |
| 6-max | BTN open | 89 | 0 | 80 |
| 6-max | SB open | 80 | 0 | 89 |
| 6-max | BTN vs limp | 89 | 11 | 69 |
| 6-max | CO vs limp | 61 | 39 | 69 |
| 6-max | BB vs limp | 44 | 125 | 0 |
| 6-max | BTN vs raise | 11 | 20 | 138 |
| 6-max | BB vs raise | 11 | 62 | 96 |
| 6-max | BTN vs 3-bet | 5 | 9 | 155 |
| 2-max | BTN open (SB) | 111 | 0 | 58 |
| 2-max | BB vs limp | 44 | 125 | 0 |

Observations that matter for the labels:

- **BB unopened (checking option) has no chart.** `getRangeChart` throws for `BB open`, so `bookPreflop` returns null: a check in an unopened pot is never Book by chart. It is graded by EV only (usually Best, Excellent or Forced).
- **Limps are called with a wide range** (`vs_limp` call cells), so a limp-call from BB or a late seat is Book when the EV agrees.
- **Stack depth changes the cuts.** `stackFactor` widens or narrows the cuts at 15 BB or less, 25 BB or less, and 100 BB or more. The rating uses the hero's stack, so the same hand can be Book at 100 BB and not at 12 BB.
- **Short stacks shove wider.** At 15 BB or less the raise cells grow; a shove that matches the chart is Book.
- **3-bet and 4-bet spots are narrow** (5 raise cells). Calling 3-bets is Book only for the small call set.

## 2. Flop standard continuation bet (postflop Book)

Rule: a flop bet is Book when all hold:

1. street is `flop` and nobody has bet yet (`toCall = 0`);
2. the hero was the last preflop raiser (last `raise`/`bet` in `history` with `street = preflop` is the hero's seat);
3. at most 2 opponents are still in the hand (heads-up or 3-way; multiway c-bets are not Book);
4. the bet is 25% to 80% of the pot (`amountBB / pot`), the usual sizes (1/3 to 2/3 pot);
5. EV loss is within the good band.

The turn and river have no Book rule: the code has no sound standard for barrels, so those are graded by EV only.

Why these limits: the continuation bet is the most common standard postflop play. Multiway pots and very large bets are not standard, so they are never Book by rule.

## 3. Things that are NOT Book (and why)

- Any postflop bet on the turn or river (no standard frequency in the code).
- Bets outside 25% to 80% of the pot.
- A preflop action that differs from the chart primary, even when it is the EV-best line (it is Best or Excellent instead). This is deliberate: the chart is the reference for "book", not the EV model.
- Preflop spots not in the chart (BB unopened, or a spot the table size does not have).

## 4. How the code decides (order)

`rateDecision` in `public/review.js`:

1. `bookHit` is computed (chart primary matches the action, or a standard c-bet) and must also be within the good band.
2. `forced`, `fold when checking is free` (always Blunder), then the best-move branch (played action = best, EV loss under 0.05).
3. In the best-move branch: Brilliant, then Great, then Book (only if `bookHit` and not `obvious`), else Best.
4. Outside the best-move branch, the rating is Excellent or Good by EV loss, never Book.

## 5. Open items

- Turn and river Book rules need a sound standard before adding; currently they are not added.
- The chart has no sizing; a Book raise with the wrong size is still Book (only the action is compared).
