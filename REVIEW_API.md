# Review API (`public/review.js`)

Pure logic, no DOM. Browser: `window.PokerReview` (needs `window.PokerEngine` loaded first). Node: `require('./public/review.js')`.
All amounts are in **big blinds (BB)**. Results are deterministic: the same situation gives the same numbers.
Text is returned in EN and ES from one set of parameters, so numbers match across languages.

Do not use the word "equity" in any user-visible text. Use "win chance" or "chance to win".

### Reading level (explanations)

Written for an average improving player: plain words, short sentences (max 14 words, tests allow 22), no jargon
(no equity, EV, GTO, range, blockers, SPR, MDF in headline or short). Each jargon term that stays is explained in one clause.
`text.explain` is a coach paragraph of 2-3 sentences: the situation and price (pot, amount to call), how likely you were to win vs the chance needed, the verdict, and one practical tip ("Next time, call here."). After a blunder or mistake it never praises the play, and the tip is phrased "Next time, ..." rather than "Try ...". A best, great or brilliant text never says mistake. For a free check it says why checking works (you see the next card at no cost). `text.explain` has 3 phrasings per situation category (`EXPLAIN_TPL` in `public/review.js`, exported); the variant is chosen by a hash of the situation, so the same situation always reads the same. EN and ES share the variant index and the same numbers. `text.short` has at most 3 numbers: your chance to win, the chance you needed (calls), and the BB lost. EN and ES always carry the same numbers.
Amounts are shown to one decimal in BB. `rating.*` names: Brilliant, Great, Best, Excellent, Good, Book, Inaccuracy, Mistake, Miss, Blunder, Forced.
Luck text: "Bad luck: you were 85% to win and the cards just didn't fall your way. Play it the same way next time." / "Lucky: ...". Each luck label has 3 phrasings; all start with the win chance.
`test/review.test.js` checks these rules.

## Ratings

| Rating (key) | EN name | ES name | Icon glyph | Meaning |
|---|---|---|---|---|
| `brilliant` | Brilliant | Brillante | `!!` (teal disc) | Best, and hard to find: a fold of a strong-looking hand, a bluff clearly best, or a thin value raise that beats calling by a clear margin. |
| `great` | Great | Genial | `!` (blue disc) | Best, and clearly better than the second-best line. |
| `best` | Best | Mejor | star (green) | The top EV line. |
| `excellent` | Excellent | Excelente | `✓+` (green disc) | Within half of the good band of the best line. |
| `good` | Good | Buena | `✓` (light green disc) | Within the good band, a small EV loss. |
| `book` | Book | Teoría | `B` (brown square) | Best move (no EV loss) that is the chart primary (or a standard flop c-bet), and not obvious. See `BOOK_MOVES.md`. |
| `inaccuracy` | Inaccuracy | Imprecisión | `?!` (yellow disc) | Larger than good, up to the inaccuracy limit. |
| `mistake` | Mistake | Error | `?` (orange disc) | Up to the mistake limit. |
| `miss` | Missed chance | Oportunidad perdida | `×` (red-orange disc) | Called or checked a strong hand (win chance 70% or more) when raising was best. |
| `blunder` | Blunder | Error grave | `??` (red disc) | Above the mistake limit, or folding when checking is free. |
| `forced` | Forced | Forzada | `–` (grey disc) | Only one legal sensible action, or no chips left to decide with. No EV loss, not scored. |

Icons are our own glyph + colour pairs (`ICONS` export). They are not copies of any other product's art.

### Thresholds (all in BB, scaled to the pot)

`scale = max(1, pot + amount to call)` (BB). `evLossBB = max(0, EV(best) - EV(your line))`.

| Band | Limit |
|---|---|
| good | `evLossBB <= max(0.3, 0.05 * scale)` (`excellent` if `<= half` of that) |
| inaccuracy | `<= max(0.8, 0.12 * scale)` |
| mistake | `<= max(2, 0.25 * scale)` |
| blunder | above the mistake limit |

Brilliant / Great rules (only when your line is the best and `evLossBB < 0.05`):
- Brilliant: best fold with win chance >= 45% and the alternatives lose >= `max(1, 0.1 * scale)`; or best raise with win chance < 45% and the same gap (bluff); or best raise with win chance 55% to 75%, not all-in, and the gap >= `max(0.5, 0.05 * scale)` (thin value).
- Great: best, and the gap to the second-best line >= `max(0.5, 0.05 * scale)`.

Special cases: fold when checking is free is always `blunder`. `miss` is checked before inaccuracy/mistake.

Accuracy per decision (0..100, one decimal): `100 * exp(-4 * min(1, evLossBB / scale))`. It is 100 for `best`, `great`, `brilliant`, `book`, and `forced` is not scored.

## Input: situation (engine scenario)

`rateDecision` takes the scenario object the engine and game use, unchanged. It is what `game.js` stores as `hand.heroDecisions[i].scenario`, and what app.js keeps as `exam.records[i].scn`. Fields read: `numPlayers`, `street`, `hero` (e.g. `["As","Ks"]`), `board` (e.g. `["Qs","Js","Ts"]`), `pot`, `toCall`, `heroStack`, `heroPosition`, `inPosition`, `lastRaise`, `seats` (with `isHero`, `folded`, `position`, `stack`, `bet`, `contributed`, `preflopRole`, `style`, `lastActionKind`), `history` (list of `{street, seat, action, amount, betFraction}`).

## Action

`'fold' | 'call' | 'check' | 'raise'` or `{ action, amountBB }` (`bet` is read as `raise`). `amountBB` is the raise-to total for the street, in BB.

## `PokerReview.rateDecision(situation, action, opts?)`

Returns:

```
{
  street, action,              // 'fold'|'call'|'raise' as graded (check = call; raise may be downgraded by the engine)
  amountBB,                    // raise-to (null otherwise)
  rating,                      // key from the table above
  ratingName: {en, es},
  icon: {glyph, color, shape},
  accuracy,                    // 0..100
  evLossBB,                    // EV of best line minus EV of your line (BB, >= 0)
  evUserBB, evBestBB,          // EV of your line and of the best line (BB)
  gainBB,                      // how much better the best line is than the second-best (BB)
  winChance,                   // hero's win share vs the narrowed villain range, 0..1 (0.634 = 63%)
  potOddsNeededPct,            // % of pot odds needed to call (null when checking is free)
  best: { action, amountBB },  // best line; 'check' for a free call; amountBB only for raises
  book: boolean,               // rating === 'book'
  bookAction,                  // chart primary action preflop (or 'raise' for a standard c-bet), else null
  tags: [...],                 // 'preflop'|'postflop', 'fold_free', 'all_in', 'cbet', 'hard_to_find', 'bluff', 'thin_value', 'book_move'
  why: [{ key, params }],      // explanation parts (see Keys below); render with format(key, params, lang)
  text: {                      // simple three-tier explanation (plain words, see "Reading level" below)
    en, es,                    // = text.explain (coach paragraph) for one-box UIs
    headline: {en, es},        // max 8 words, e.g. "Great: folding", "Mistake: next time, fold.", "Miss: raise instead."
    short: {en, es},           // 1-2 sentences: what happened and what to do instead (max 3 numbers)
    explain: {en, es},         // coach paragraph: 2-3 sentences, one paragraph, no bullets (the UI shows this)
    full: []                   // deprecated (old bullets); always empty now
  },
  headline: {en, es},          // same as text.headline
  correct: boolean             // rating is one of brilliant, great, best, excellent, good, book, forced
}
```

## `PokerReview.reviewHand(handRecord, opts?)`

Hand record (BB, what a finished hand gives you):

```
{
  decisions: [                 // hero's decisions in order
    { scenario, action, amountBB?, winChance? }   // winChance (0..1) optional: a known win chance for luck only
  ],
  heroNetBB,                   // hero's result for the hand (+ won, - lost), BB
  potBB,                       // total pot contested at the end (uncalled bets excluded), BB
  heroInvestedBB,              // hero's total chips put in, BB
  showdown                     // true if the hand reached showdown
}
```

`potBB`, `heroInvestedBB` and `heroNetBB` are needed for luck. Without them, `luck.label` is `'unknown'`.

Returns:

```
{
  decisions: [ rateDecision result + index ],
  counts: { brilliant:0, great:0, ... },     // every rating key, always present
  accuracy,                                   // hand accuracy (0..100, one decimal), null if no scored decision
  netBB,                                      // heroNetBB echoed (null if absent)
  luck: {
    label,                 // 'bad_luck' | 'lucky' | 'none' | 'unknown'
    resultVsPlay,          // 'good_bad' | 'bad_good' | 'good_good' | 'bad_bad' | 'unknown'
    expectedBB, actualBB, luckBB,   // expected = winChance * potBB - heroInvestedBB; luckBB = actual - expected
    winChance,             // win chance at the last decision (or winChance you supplied)
    playedWell,            // no inaccuracy, mistake, miss or blunder in the hand
    text: {en, es}, resultText: {en, es}
  }
}
```

### Luck rules (per hand)

Luck is only measured when the hand reached showdown or someone was all-in (`showdown` or a decision tagged `all_in`), and the money fields are present.

- `expected = winChance * potBB - heroInvestedBB`, with `winChance` at the hero's **last** decision (the all-in or river point).
- Gate: `|luckBB| >= max(1, 0.1 * potBB)`, so small swings are not labelled.
- `bad_luck`: win chance >= 80% and the hero lost, and the gate passes. The label is set only when the play was correct (`playedWell`). A bad play that lost as a favourite is `none`, with `resultVsPlay: bad_bad`. Good play that lost is `good_bad`, separated from the result.
- `lucky`: win chance <= 20% and the hero won, and the gate passes. Set regardless of play; `resultVsPlay: bad_good` shows a bad play that was rescued by the cards.
- `resultVsPlay` is always set (if the luck inputs exist): `good_good`, `good_bad` (resulting-aware: good play, bad result), `bad_good`, `bad_bad`.

## `PokerReview.reviewGame(handRecords, opts?)`

```
{
  handCount, decisionCount,
  accuracy,                                   // chess.com-like: mean decision accuracy (forced excluded), one decimal, null if none
  counts: { ...all ratings },
  perStreet: { preflop, flop, turn, river } -> { decisions, accuracy, evLossBB, mistakes },
  keyMoments: {
    biggestBlunder: { hand, index, street, rating, evLossBB, text } | null,   // largest loss among blunder/mistake/miss
    bestMove: { hand, index, street, rating, gainBB, text } | null            // largest gain among brilliant/great
  },
  net: {
    actualBB,            // sum of heroNetBB over hands that have it
    expectedBB,          // sum of expected over hands with luck data
    luckBB,              // actual - expected over hands with luck data
    luckLabel,           // 'lucky' | 'unlucky' | 'none' | 'unknown'
    luckThresholdBB,     // max(5 BB, 10% of the total potBB): the luck factor must reach it to count
    badLuckHands, luckyHands, handsWithLuck
  },
  luckText: {en, es},
  suggestions: [ { key, params, text: {en, es} } ],   // up to 4, rule-based (see keys)
  hands: [ reviewHand results ]
}
```

Per-street accuracy uses the same decision accuracy.

## Adapters

- `PokerReview.handRecordFromGame(session)`: takes a `game.js` session right after a hand ends (`session.hand.results` set). Converts chips to BB and fills `decisions`, `heroNetBB`, `potBB`, `heroInvestedBB`, `showdown`. Returns null if the hand has no results.
- `PokerReview.handRecordsFromExam(records, netsByHand?)`: takes app.js `exam.records` (one entry per decision; `records[i].hand` is the hand number). Each decision uses `scn` as the scenario, `action` and `amount` (raise-to BB). `netsByHand` (`{ [handNumber]: netBB }`) is optional; without it, no luck is computed. The app does not store the final pot per hand today. For full luck in the exam, the UI must add `potBB`, `heroInvestedBB` and `showdown` (or use `handRecordFromGame` in the live table path).

## Keys and params (for the UI)

`why` and `suggestions` hold `{key, params}`. `format(key, params, lang)` returns the localized text (`lang` is `'en'` or `'es'`). Params may be numbers (formatted with a decimal comma in ES), strings, or `{ "$t": key, ...params }` for a nested phrase (e.g. `action`, `amt`, `rating`). Keys are listed in `PokerReview.DICT`.

Examples: `why.price` (`call`, `total`, `need`, `win`), `why.free`, `why.villains` (`n`, `strength`, `pct`), `why.outs` (`outs`, `hit`), `why.spr` (`spr`, `stack`), `why.size` (`size`, `best`), `why.chart` (`pos`, `action`, `n`), `ev.line` (`user`, `best`, `loss`), `luck.bad`, `luck.lucky`, `sugg.calls`.

## Consumer checklist (UI agent)

1. Call `rateDecision` once per hero decision, when it is made (the app already has the scenario and action), or `reviewHand` at hand end. It takes a few milliseconds per decision (Monte Carlo, seeded).
2. Show `rating`, `icon`, `text[lang]`. Use `format` for any `why` item you want as a bullet.
3. Build the game review with `reviewGame(handRecords)`: `accuracy`, `counts`, `keyMoments`, `net`, `suggestions`.
4. Luck text: `luck.text` per hand; `luckText` per game.
