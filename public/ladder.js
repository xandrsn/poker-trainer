/* The bots: neural networks known by their Elo, 300 to 3000, weakest first. Every level has several names, so a
 * table can seat nothing but bots of one Elo. Per level: net (which copy of the network), temp (above 1 flattens its
 * choices) and eps (the share of moves picked at random): both make it weaker. The Elo is the level's place on the
 * ladder, as with chess bots: each level beats the one below, but measured gaps are smaller than 300.
 * DUEL is heads-up play, TABLE everything else; scripts/rate-bots.js --write puts them here with `fit`, the
 * measured Elo (mean 1200) of the last rating run. Browser: window.PokerLadder. Node: module.exports. */
(function () {
  'use strict';

  var DUEL = [{"net":"a","temp":3,"eps":0.8,"fit":1104},{"net":"a","temp":3,"eps":0.6,"fit":1143},{"net":"a","temp":2,"eps":0.45,"fit":1151},{"net":"a","temp":1.5,"eps":0.3,"fit":1185},{"net":"b","temp":1.2,"eps":0.2,"fit":1194},{"net":"b","temp":1,"eps":0.1,"fit":1215},{"net":"c","temp":1,"eps":0.05,"fit":1222},{"net":"d","temp":1,"eps":0,"fit":1246},{"net":"e","temp":1,"eps":0,"fit":1258},{"net":"e","temp":0.6,"eps":0,"fit":1283}];
  var TABLE = [{"net":"a","temp":3,"eps":0.8,"fit":1047},{"net":"a","temp":3,"eps":0.6,"fit":1070},{"net":"a","temp":2,"eps":0.45,"fit":1106},{"net":"a","temp":1.5,"eps":0.3,"fit":1160},{"net":"b","temp":1.2,"eps":0.2,"fit":1189},{"net":"b","temp":1,"eps":0.1,"fit":1231},{"net":"c","temp":1,"eps":0.05,"fit":1250},{"net":"d","temp":1,"eps":0,"fit":1297},{"net":"e","temp":1,"eps":0,"fit":1322},{"net":"e","temp":0.6,"eps":0,"fit":1330}];
  var NAMES = [
    ['Donk Quixote', 'Limpy', 'Fishstick', 'Oops All-In', 'Captain Call', 'Wet Noodle', 'Miss Click', 'Chip Dip'],
    ['Foldilocks', 'Bad Beatrice', 'Turnip', 'Flopsy', 'Cold Toast', 'Chip Munk', 'Soggy Nuts', 'Muck Duck'],
    ['Calamity Cal', 'Sir Limps-a-Lot', 'Gutshot Gus', 'Tilty McTilt', 'Rainbow Rita', 'Lucky Lou', 'Pocket Lint', 'Blind Bob'],
    ['Bluffalo', 'Pot Roast', 'Nut Case', 'Kicker Kate', 'Sir Raisin', 'Queen Bean', 'Checkmate', 'Flusher'],
    ['Auntie Ante', 'Bluff Cheese', 'Shove Muffin', 'Quad Squad', 'River Dancer', 'Poker Farce', 'Tilt Machine', 'Deuce Goose'],
    ['Raise Cain', 'Set Mining Sam', 'Big Slick Rick', 'Card Shark Carl', 'Felt Tipp', 'Check Raisin', 'Nit Wit', 'Sharky'],
    ['Stackula', 'Val U. Bett', 'Moby Stack', 'Three Betty', 'Chip Happens', 'Polly Nomial', 'Slow Rollo', 'Float Goat'],
    ['The Grinder', 'Equity Edith', 'Bankroll Bill', 'Polar Bear', 'Overbet Olga', 'Barrel Baron', 'Max EV', 'Fold Equity'],
    ['Holdini', 'GTO Grandma', 'Baron Bluff', 'Neural Nora', 'The Nuts', 'Prof. Pot', 'All-Instein', 'Deep Stan'],
    ['Nash Potato', 'Solver Sally', 'The Oracle', 'Quantum Quads', 'Mind Reader', 'Robo Rounder', 'Iron Range', 'Lord of Rivers']
  ];
  var LADDER = NAMES.map(function (names, i) {
    var d = DUEL[i], t = TABLE[i], elo = 300 * (i + 1);
    return { id: 'lv' + (i + 1), name: names[0], names: names, rating: elo, table: elo,
      net: d.net, temp: d.temp, eps: d.eps, tnet: t.net, ttemp: t.temp, teps: t.eps };
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
