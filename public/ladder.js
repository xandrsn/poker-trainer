/* The bots: neural networks known by their Elo, weakest first. Every level has several names, so a table can seat
 * nothing but bots of one Elo. net: which copy of the network; temp > 1 flattens its choices, which makes it weaker.
 * DUEL and TABLE are written by scripts/rate-bots.js (--write); DUEL is heads-up ranked play, TABLE is everything else.
 * Browser: window.PokerLadder. Node: module.exports. */
(function () {
  'use strict';

  var DUEL = [{"net":"a","temp":6,"rating":1138},{"net":"a","temp":2,"rating":1171},{"net":"b","temp":1,"rating":1202},{"net":"c","temp":1,"rating":1214},{"net":"d","temp":1,"rating":1226},{"net":"e","temp":1,"rating":1248}];
  var TABLE = [{"net":"a","temp":6,"rating":1088},{"net":"a","temp":4,"rating":1122},{"net":"a","temp":2.5,"rating":1181},{"net":"a","temp":1.6,"rating":1235},{"net":"b","temp":1,"rating":1282},{"net":"c","temp":1,"rating":1291}];
  var NAMES = [
    ['Donk Quixote', 'Limpy', 'Fishstick', 'Oops All-In', 'Captain Call', 'Wet Noodle', 'Miss Click', 'Chip Dip'],
    ['Foldilocks', 'Bad Beatrice', 'Turnip', 'Flopsy', 'Cold Toast', 'Chip Munk', 'Soggy Nuts', 'Muck Duck'],
    ['Bluffalo', 'Pot Roast', 'Nut Case', 'Kicker Kate', 'Sir Raisin', 'Queen Bean', 'Checkmate', 'Flusher'],
    ['Auntie Ante', 'Bluff Cheese', 'Shove Muffin', 'Quad Squad', 'River Dancer', 'Poker Farce', 'Tilt Machine', 'Deuce Goose'],
    ['Stackula', 'Val U. Bett', 'Moby Stack', 'Three Betty', 'Chip Happens', 'Polly Nomial', 'Slow Rollo', 'Float Goat'],
    ['Holdini', 'GTO Grandma', 'Baron Bluff', 'Neural Nora', 'The Nuts', 'Prof. Pot', 'All-Instein', 'Deep Stan']
  ];
  var LADDER = NAMES.map(function (names, i) {
    return { id: 'lv' + (i + 1), name: names[0], names: names, net: DUEL[i].net, temp: DUEL[i].temp, rating: DUEL[i].rating,
      tnet: TABLE[i].net, ttemp: TABLE[i].temp, table: TABLE[i].rating };
  });

  function level(id) { return LADDER.filter(function (b) { return b.id === id; })[0] || null; }
  // A name of that level that nobody in `used` has.
  function pickName(id, used, rng) {
    var b = level(id);
    var free = b.names.filter(function (n) { return used.indexOf(n) < 0; });
    return free.length ? free[Math.floor((rng || Math.random)() * free.length)] : b.name;
  }
  // The seat's player model. Looseness and aggression only serve the rule-based stand-in (networks not loaded).
  function persona(id) { return { name: id, type: id, looseness: 'balanced', aggression: 'balanced' }; }

  var api = { LADDER: LADDER, level: level, pickName: pickName, persona: persona };
  if (typeof window !== 'undefined') window.PokerLadder = api;
  else module.exports = api;
})();
