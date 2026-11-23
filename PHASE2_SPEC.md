# Phase 2 spec (user feedback, 19 points) – read fully, then do ONLY your part

## HARD CONSTRAINTS (the user is using the PC for other things)
- LOW RAM: do NOT launch Chrome/Playwright/headless browsers, do NOT run `npm test`/`npm run audit`/e2e, do NOT start servers. Only `node --check <file>` and small targeted node tests of YOUR OWN module (each < 20 s, one process at a time). The heavy test phase comes later, run by the coordinator.
- Edit surgically (Edit tool); only files you own (table below). Never rewrite whole large files. Tell the coordinator in your report if you need a change in someone else's file (name the exact function/contract).
- Dark theme only. No word "equity"/"equidad" in anything user-visible. All text in ES + EN. No text under 12px. No scrolling of the page (100dvh layouts).
- Report in <= 150 words: what is done, what is not done, contracts others must follow.

## File ownership
- ENGINE: public/engine.js, test/engine.test.js
- GAME: public/game.js, public/bots.js, test/game.test.js
- UI-A: public/index.html, public/app.js, public/style.css, public/i18n.js, public/stats.js
- UI-B: public/theme.js, public/theme.css, public/help.js (new files; only add tiny hooks to index.html: link/script tags + a header button, via Edit)
- MP: public/mp.js, public/mp.css, server.js, server/*, MP_PROTOCOL.md, README.md

## The 19 points
1. Fold must never be rated better than check when check is free (toCall = 0). Fix the logic/EV: when nobody has bet, fold is dominated by check (EV 0 vs >= 0), never "best".
2. Comments/explanations must always talk about: table position, the hand, number of players, and opponents' play style.
3. The top bar takes too much space (e.g. exam shows "Exam · hand 10 of 50"): make the header thin (~44px), remove such status strips.
4. Main menu redesign (ugly now). Cards: **Manos rápidas** (a situation is shown, you decide, evaluation appears; next), **Práctica** (whole rounds from deal to showdown, random position and table, access to the range tables, evaluation after every move), **Examen** (same as practice but WITHOUT ranges and with no evaluation during the hand; evaluation only at the end: the average % of the game; once finished the user can open an analysis showing each decision of each hand with the correct move), **Multijugador**, **Reglas**, **Progreso**. Clicking a mode card reveals its settings and a Play button that is always visible without scrolling.
5. Remove "10/20/50 hands" in exam: the exam lasts as many hands as the user wants; the stats update live as they play; add a "Finish exam" button that shows the final summary/analysis.
6. In CPU games remove the left panel that lists seats and what each did (irrelevant); give the table the space (bigger table).
7. Settings: each player can have their own amount of money (equal / random varied / custom) and it influences how everybody bets and plays (all-in does not mean the same if it covers you or not). (Also in the engine's evaluation: effective stacks.)
8. Remove the two useless boxes in the central area: the yellow game-mode pill and the table-info title (e.g. "Big blind – 5 players").
9. When a player folds, their seat/card box on the table gets lower opacity (clearly distinguishable), in solo and multiplayer.
10. Settings: users choose background colour, table (felt) colour and border (rail) colour, PokerStars-like (presets + custom colour picker), and their own highlight colour (the outline around the player's own seat box showing "you + position"; CPUs default white). In multiplayer the highlight colour is visible to the other players (sent in profile). Persist in localStorage.
11. A "?" button in the header opens a simple, human, non-technical explanation of how the backend works: do opponents get real cards, how is the win percentage computed (simulation of many random deals), how ranges narrow with the opponents' actions, how the score 0-100 and the explanations are produced. ES + EN, short sections.
12. When viewing the ranges, also show a number: the objective win % assuming the opponents' cards and the missing board cards are RANDOM, given only what the hero knows (own cards + board so far), for the current number of opponents and street (e.g. ~50% to get a heart with 2 cards to come regardless of what others hold). Label it as a guide ("assuming random opponent cards"), not including betting. Must be exact or low-error and deterministic (see 16).
13. CPU "randomness" must NOT be a parameter. Behaviour depends on the personality types present. In settings the user chooses which personalities are enabled (tight, loose, aggressive, passive, balanced...), checkboxes; at least one must stay enabled.
14. Rigorous review of all maths in the backend (hand evaluation, equity, ranges, pot odds, EV, SPR, fold equity, multiway, stacks).
15. Deeply improve the evaluation messages: simple but effectively explaining why the decision is that: e.g. "with a flop of K♠ 7♦ 2♣ the chance of a pair or a flush is very high with 5 players", "from this position limping is better", mention hand, board texture, position, players, opponents' styles/actions, stack depth.
16. Deep review of the analysis and probability systems: must be 100% objective and DETERMINISTIC: the same situation always gives the same numbers, rating and message (seed any Monte Carlo from a hash of the situation; message template choice is also derived from that hash, never Math.random).
17. Camera/mic deep review for rooms of at most 6 players, maximum quality. If quality isn't achievable, the camera feature may be dropped in favour of an external tool (Discord etc.) while keeping multiplayer and profile photos. Add a text chat box in a bottom corner for multiplayer games.
18. Senior front-end QA pass on the existing UI: overlaps, alignment, overflow, broken states, layout shifts, responsive (320-480, 481-1024, 1025-1440, 1441+), console errors; fix with targeted changes, preserve the design language. (This phase: static code review only; real-browser verification comes later.)
19. Multiplayer: at the end of a hand everyone sees the winning hand if it went to showdown; additionally during the ~5 s between hands every player (including those who folded or won uncontested) can click "Show my hand" to reveal their cards to everyone (to brag about a bluff or show what they had).

## Contracts between parts (follow exactly)
- ENGINE exposes `PokerEngine.randomWinPct(heroCards, board, numOpponents) -> { pct: number (0-100, one decimal), exact: boolean, samples: number }` deterministic; chart/ranges UI shows it. Also `Result.winPctRandom` in evaluate() output. `PokerEngine.personalities = ['tight','loose','aggressive','passive','balanced']`.
- GAME/bots: `PokerGame` options: `personalities: string[]` (enabled types; bots pick among them), no `randomness` parameter (keep accepting and ignoring it for old callers); `stacks: 'equal'|'varied'|'custom'` with `customStacks` array; `noWalkover: true` in solo modes (the last opponent never folds a hand to an uncontested win, hero always gets a real decision).
- THEME: `window.PokerTheme = { get(), set(partial), apply(), onChange(fn) }` with fields `{ bg, felt, rail, highlight }` (hex strings); CSS variables `--bg-user`, `--felt-user`, `--rail-user`, `--hl-user` applied on :root; settings UI is rendered into a container `#theme-settings` provided by UI-A (UI-B fills it). MP sends `highlight` in the profile; seats of others use their own highlight colour.
- HELP: `window.PokerHelp.open()` opens the "?" modal; UI-A header has `<button id="btn-help">` calling it.
- MP: profile gets `highlight`; new messages `chat {text}` (<= 200 chars, rate-limited) broadcast as `{t:'chat', from, name, text, time}`; `showHand {}` allowed during the between-hands window (default 5 s) revealing that seat's cards to all (`state.hand.seats[].cards` + `shown:true`); the server sets `state.hand.showWindowMs`.
