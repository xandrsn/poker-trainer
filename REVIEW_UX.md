# Game Review UX: design note

## What chess.com Game Review does (from its public help pages)
- Each move gets a classification (Brilliant, Great, Best, Excellent, Good, Book, Inaccuracy, Mistake, Miss, Blunder). Key moves carry a glyph next to them in the move list.
- The coach explanation belongs to the current move only; highlighted words in it point at the board.
- The board shows the position after each move, with previous/next/first/last controls and a move list to jump with.
- Summary: accuracy per side, key moments, and retry on a chosen mistake.
- Sources: https://support.chess.com/en/articles/8572705-how-are-moves-classified-what-is-a-blunder-or-brilliant-and-etc ; https://support.chess.com/en/articles/8572705-how-does-game-review-work ; https://support.chess.com/article/1135-what-is-accuracy-in-analysis-how-is-it-measured

No artwork or text is copied. The design below is original.

## Poker adaptation (as built in review-ui.js, renderGame)
- Table: the whole table replays each action of the hand (read-only). Step k = actions applied; step 0 = dealt.
- Panel: reviews only the current hero decision (rating, you played vs best, short text, "Show best move" ghost, full explanation, win chance / needed / EV loss).
- Win bar beside the table = hero's chance to win at the current step.
- Navigation: first, previous, next, last, previous/next decision, previous/next hand, autoplay (1 s steps). Keys: Left/Right step, Up/Down hand, Home/End, Space autoplay, Escape back.
- Timeline: one marker per step; hero decisions show their rating icon and jump to the step.
- Summary drawer (hidden by default): accuracy, counts by rating (jump to the first move of each rating), key moments, EV-loss bars.

## Data
- app.js rvReplayOf(session) attaches `replay` to each hand record: seats (start stacks in BB, cards, folded, dealt), board, button, showdown, and history (every action with street, seat, action, amount, chips put in). Attached in rvHandRecord and passed through rvGameReview.
- Text fields: text.headline / text.short / text.full ({en,es}). Falls back to the old {en,es} text when the new shape is absent.

## Layouts and tests
- Desktop (900px and wider, and 844x390 landscape): table left with the win bar, panel right. Phones (under 760px wide): table top, nav bar, timeline, panel as a bottom sheet (collapsed: headline, short text, result; More expands the full explanation). Landscape phones and short windows (max-height 520px) use a tighter table.
- Checked by test/e2e-review-ui.js in headless Chrome at 1920x1080, 1366x768, 1024x600, 844x390, 390x844, 360x640, EN and ES.
- test/e2e-review-flow.js plays a real Exam to the end and walks every hand of the review (timeline has one rated marker per hero decision).
- test/fixtures/review-demo.html carries a replay per hand. Its actions are the hero's decisions only (villain actions are not in the fixture data), so the fixture shows the table, cards, pot and the panel, not a full hand.

## Coach voice
Research (chess.com, June 2026): the public support pages (how moves are classified) list the thresholds
(Best 0, Excellent up to 0.02, Good up to 0.05, Inaccuracy up to 0.10, Mistake up to 0.20, Blunder above) and the rules for
Great, Brilliant and Miss. They do not quote coach wording. Third-party write-ups say Game Review gives a label and a number,
and that its explanations can be thin. An "Explain" button was added to the coach panel. So the exact tone could not be
copied from a source; the target below comes from the examples the user gave and the chess.com labels.

What we took from it:
- Lead with the verdict in plain words ("Best move: ...", "Book move: ...", "Mistake: ..."), then the reason.
- Short sentences in second person ("you", "your hand"), one idea each. No bullets.
- Name the better line and say what to do next time ("Try folding instead", "Raise next time you are this far ahead").
- Praise good play warmly and briefly ("Nice work", "Keep it"). Keep mistakes constructive, never condescending.
- Luck is separate from play: "Bad luck: you were 85% to win and the cards just didn't fall your way. Play it the same way next time."

Implementation (`public/review.js`, `EXPLAIN_TPL`, `explainCategory`, `buildExplain`):
- `text.explain = {en, es}`: 2 to 3 sentences, one paragraph: situation and price, numbers and verdict, one tip.
- Categories: forced, book, brilliant, great, best, good, call_good, fold_good, call_light, fold_tight, fold_free, bad, size (right action, wrong amount), miss_big (win 90%+), miss_ahead (70-90%). Each has 3 phrasings in EN and ES.
- Price check: call_good / fold_good are used only when the numbers agree (call: win >= needed; fold: win <= needed). Otherwise the plain good text is used.
- Verb forms come from the dictionary: noun ("calling"), imperative ("Next time, call here.", "La próxima vez, iguala aquí."), past ("you checked"). With nobody having bet, a raise reads as betting.
- The reason sentence for best, great and brilliant depends on the line: fold, call, check (free card when the win chance is under 25%, strong hand waiting for a bet at 85%+), or raise (takes the pot now or builds it with a good hand under 45%, builds while ahead above).
- What you hold is named in the text (made hand, draw, or hand with no pair and no draw), in both languages.
- Position is mentioned only when it matters (a bad move out of position, postflop).
- `text.full` is `[]` (deprecated bullets). `text.en` / `text.es` now equal the explain paragraph.
- Tests: sentences up to 22 words, paragraph of 2-4 sentences, no bullets, EN/ES placeholders and numbers match, no jargon, deterministic, no praise on blunder/mistake/inaccuracy/miss, no fault word on best/great/brilliant.

## Player controls (hero-only player, current build)
Research (chess.com Game Review support pages, Nov 2026): classification per move with an icon on the board and in the move list;
a coach bubble with the explanation of the selected move; bottom arrows (first, previous, next, last) and keyboard arrows; autoplay of the
moves; key moments; accuracy header. Sources: https://support.chess.com/en/articles/8584089 , https://support.chess.com/article/364-how-does-the-game-report-analysis-work
Design taken from it (original artwork, no copied text): the rating icon lands on the moved piece (here: the hero seat); the controls sit in one centred bar at the bottom.
- Stops: only the hero decisions, plus one hand-end card after the last move of each hand. Villain actions are applied silently.
- Each decision stop has two phases: before (table shows the spot, hero to act, "Your move" panel with win chance / needed / pot) and after (the hero action lands, rating pops on the hero seat, analysis panel).
- Controls (48px+): previous hand, previous move, play/pause (2.5 s per hero move, end card waits longer, runs across hands), next move, next hand.
- Keys: Left/Right move, Up/Down or PageUp/PageDown hand, Space play/pause, Home/End first/last stop, Escape back.
- Timeline: one marker per hero move across the exam, grouped by hand; click jumps. Header shows "Move i of n · Hand h/H" and a hand selector.
- Panel: rating icon and badge, headline, "You played / Best", chips (win chance, needed, pot, BB lost only when > 0), explanation text.explain (fallback text.short), optional "More detail" from text.full only.
- Summary drawer: accuracy, rating counts (each click jumps to the next move with that rating), key moments, BB-lost bars.
- Phone: table on top, panel as a bottom sheet that scrolls inside, controls fixed at the bottom.

## Analysis screen redesign: design brief (Nov 2026)

What the player does on this screen, in order of importance:
1. Steps through their own decisions (previous or next move, previous or next hand, play/pause, keyboard).
2. Understands what they did wrong: a rating badge, one line ("You played X - best was Y"), then one paragraph of reasons.
3. Sees the better line: "Show best move" puts the best action on their seat.
4. Reads the three numbers that decide the spot, each big and labelled: Chance to win (vs their likely hands), Needed to call, BB lost (Pot on the table and before the rating).
5. Gets the overall picture without a menu: accuracy ring and rating counts always in the header (a click jumps to the next move with that rating), and a timeline with one dot per hero move, grouped by hand.

Layout:
- Desktop (760px and wider): two columns. Left: the table (board, pot, hero cards, the hero's action bubble and rating on the hero's seat), the timeline under it, the controls under that. Right: the coach card.
- Phone portrait: header, table (compact), coach sheet, timeline, controls fixed at the bottom. The sheet never covers the controls.
- Short landscape: the desktop columns, tighter; the table switches to compact seats when it is short.
- Rating counts show icon and number from 1000px wide, icon, name and number from 1500px; they are hidden on narrower screens (the timeline dots carry the same information there).
- Nothing on the page scrolls. Only the coach body (and the timeline row) scroll inside themselves, and only when the text does not fit.

Coach card:
- Badge (icon and rating name) and one-line verdict, then the stat tiles: Chance to win as a big number with a tiny bar (fill = chance, tick = chance needed to call; green when it reaches the tick), Needed to call, BB lost (before the rating: Pot).
- Win-chance note: when the same street shows the same board as an earlier decision in the hand and an opponent bet or raised in between, one line says why the chance moved, with the real before and after values (review.js chanceShift; EN and ES come from the same numbers). Their range narrows toward stronger hands after a bigger bet, so the chance can drop with no new card.
- Then the explanation paragraph (text.explain), no bullets. More detail (text.full) only if present.
- End of hand: the result (won or lost BB), showdown note, net and hand accuracy tiles, luck badge.

Motion: 150-250 ms fades and slides between moves; the win-chance bar grows; the rating pops onto the hero seat. All motion is off under prefers-reduced-motion.

Colour and type: text and surfaces use the page tokens, so a light page keeps dark text. The felt and seats are always dark with their own light text. Rating colours only fill icons, dots and bars, never text. Numbers are 20px or more.

Removed from the old screen: the summary drawer (its content is now the header), the EV bar graph and key-moment chips (the timeline and rating counts replace them), the old side panel layout.

Data: review.js reviewHand adds prevWinChance and chanceShift to each decision. Ratings are unchanged. The demo fixture (test/fixtures/review-demo.html) has a 13th hand with two decisions on one flop (a check, then a call of a bet) to show the win-chance note.

Checks: test/e2e-review-ui.js (6 sizes, EN and ES), test/e2e-review-flow.js, test/e2e-noscroll.js, test/review.test.js.
