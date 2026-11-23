# Poker Trainer – shared contract

Stack: static webapp, zero dependencies. `server.js` (Node 20, http module) serves `public/` on `PORT` (default 3000).
Files in `public/`: `engine.js` (exposes `window.PokerEngine`, also `module.exports` when run in Node for testing),
`index.html`, `style.css`, `app.js`. Load order: engine.js then app.js. Cards are strings like `"As"`, `"Td"`, `"7h"` (rank 2-9TJQKA, suit s/h/d/c).

## PokerEngine API

### `generateScenario(opts?) -> Scenario`
opts: `{ players?: 2..9, street?: 'preflop'|'flop'|'turn'|'river'|'any', seed? }` (defaults: random).
Scenarios must be varied: 2–9 players; hero in any position (UTG, UTG+1, MP, LJ, HJ, CO, BTN, SB, BB – names appropriate to table size);
streets; unopened pots, facing a raise, facing 3-bet, limpers, multiway, facing small/large/overbet bets, checked-to-hero, hero in/out of position;
villains with differing behaviors (tight/loose, aggressive/passive) that are reflected in the action log.

```
Scenario {
  id: string,
  numPlayers: number,              // players still dealt in at start of hand
  street: 'preflop'|'flop'|'turn'|'river',
  hero: [card, card],
  board: card[],                   // 0,3,4,5 cards
  blinds: { sb, bb },              // in big blinds units: sb 0.5, bb 1
  pot: number,                     // in BB, includes all bets already made, including current street bets
  toCall: number,                  // 0 => hero may check
  heroStack: number,               // remaining behind, in BB
  heroPosition: string,            // e.g. 'BTN'
  heroSeat: number,
  buttonSeat: number,
  inPosition: boolean,
  seats: [{ seat, position, name, stack, bet, folded, isHero, style: 'tight'|'loose'|'aggressive'|'passive'|'balanced', lastAction: string }], // length = numPlayers, in seat order
  actionLog: string[],             // human-readable e.g. "UTG folds", "CO raises to 3 BB"
  raiseOptions: [{ label, amount }], // sensible total raise-to sizes in BB (min raise, 1/2 pot, 2/3, pot, all-in as applicable); amount = total bet hero puts in this street
  situation: string                // one line summary, e.g. "Facing a 3-bet on the button, 6-handed"
}
```

### `evaluate(scenario, action, raiseAmount?) -> Result`
action: `'fold'|'call'|'raise'` (`'call'` also means check when toCall = 0).
```
Result {
  best: 'fold'|'call'|'raise',
  bestRaiseAmount: number|null,
  rating: 'best'|'good'|'mistake'|'blunder',
  correct: boolean,                // rating is best or good
  ev: { fold: 0, call: number, raise: number },   // in BB, approximate
  score: number,                   // 0..100 for this decision
  summary: string,                 // one-line verdict, e.g. "Raise is best – you are ahead of villain's range"
  explanation: string[],           // 3–7 bullet paragraphs: hand strength, equity vs range, pot odds, position, SPR, villain tendencies, why alternatives are worse
  stats: [{ label, value, hint }]  // table of statistics (see below)
}
```
Stats rows must include at least: Hand / Made hand, Equity vs range, Pot odds (required equity), Outs (post-flop), Position, Players, Pot, To call, Stack-to-pot ratio, Villain range estimate, EV of fold/call/raise, Board texture (post-flop), Hand percentile or preflop chart tier (preflop).
Engine computes equity via Monte Carlo (≈2000–4000 samples, must finish < 150 ms) against a range estimate derived from villain actions/positions.
Also export `evaluateHand(cards) -> {rank, name}` helper, `equity(hero, board, rangeOrNumOpponents)`.

## App (UI) requirements
Table-centric view with oval felt, seats around it with position badges (BTN/SB/BB dealer button), stacks, current bets as chips, pot in centre, community cards, hero cards large.
Three big buttons: **Fold**, **Check/Call X**, **Raise** with a size selector (preset chips from `raiseOptions` + slider/input). Keyboard shortcuts F / C / R, N or Enter for next hand.
After answering: result banner (rating colour), explanation bullets, statistics table (from `stats`), "Next hand".
Session stats panel: hands played, accuracy %, streak, score, accuracy by position and by street (persist in localStorage). Settings: number of players (2–9 or random), street filter, reset stats.
Look: dark modern, green felt, smooth animations (card deal, chip slide, fade), responsive.
