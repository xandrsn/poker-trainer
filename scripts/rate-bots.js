'use strict';
/* Rates neural bots against each other: node scripts/rate-bots.js [matches] [table] [net=temp,net=temp,...] [--write]
 * Without 'table' every pair plays that many heads-up matches (50 BB, blinds doubling every 12 hands, as a ranked match
 * does in about 2 minutes). With 'table': that many tables of six, where every bot plays each other one (who lasts
 * longer). Ratings are the Elo fit of the results with mean 1200. --write puts nets, temps and ratings into
 * public/ladder.js, weakest first (six bots). Without a list: the bots of the ladder. */
const fs = require('fs');
const path = require('path');
const G = require('../public/game.js');
const NN = require('../server/nnbot.js');

const args = process.argv.slice(2);
const games = Number(args[0]) || 400;
const table = args.indexOf('table') >= 0, write = args.indexOf('--write') >= 0;
const spec = args.find((a) => /^[a-e]=/.test(a));
if (spec) NN.LADDER.splice(0, NN.LADDER.length, ...spec.split(',').map((s) => {
  const net = s.split('=')[0], temp = Number(s.split('=')[1]) || 1;
  return { id: s, name: s, net, temp, tnet: net, ttemp: temp };
}));
const bots = NN.LADDER;

// One tournament of all bots in random seats: their indexes, last one standing first.
function tournament() {
  const t = G.newTable({ maxSeats: 9, seed: (Math.random() * 2 ** 31) | 0 });
  const order = bots.map((_, i) => i).sort(() => Math.random() - 0.5);
  let active = order.map((_, s) => s);
  active.forEach((s) => Object.assign(t.seats[s], { stack: 50000, busted: false }));
  t.cfg.sb = 500; t.cfg.bb = 1000;
  const out = [];
  for (let h = 1; ; h++) {
    const before = active.map((s) => t.seats[s].stack);
    const hand = G.startHand(t, { active });
    while (hand && !hand.over) NN.step(t, hand.toAct, bots[order[hand.toAct]].id);
    if (h % 12 === 0) { t.cfg.sb *= 2; t.cfg.bb *= 2; }
    // Out together: more chips before the hand places higher.
    const gone = active.filter((s) => t.seats[s].stack < t.cfg.bb).sort((a, b) => before[active.indexOf(a)] - before[active.indexOf(b)]);
    if (gone.length === active.length) gone.sort((a, b) => t.seats[a].stack - t.seats[b].stack);
    out.push(...gone);
    active = active.filter((s) => gone.indexOf(s) < 0);
    if (active.length < 2) return out.concat(active).reverse().map((s) => order[s]);
  }
}

// True when the first bot wins.
function match(a, b, flip) {
  const t = G.newTable({ maxSeats: 9, seed: (Math.random() * 2 ** 31) | 0 });
  const ids = flip ? [b.id, a.id] : [a.id, b.id];
  [0, 1].forEach((i) => Object.assign(t.seats[i], { stack: 50000, busted: false }));
  t.cfg.sb = 500; t.cfg.bb = 1000;
  for (let h = 1; ; h++) {
    const hand = G.startHand(t, { active: [0, 1] });
    if (!hand) return ids[t.seats[0].stack > t.seats[1].stack ? 0 : 1] === a.id; // less than a big blind is out
    while (!hand.over) NN.step(t, hand.toAct, ids[hand.toAct]);
    if (h % 12 === 0) { t.cfg.sb *= 2; t.cfg.bb *= 2; }
  }
}

const wins = bots.map(() => bots.map(() => 0));
for (let n = 0; table && n < games; n++) {
  const p = tournament();
  p.forEach((i, k) => p.slice(k + 1).forEach((j) => wins[i][j]++));
}
for (let i = 0; !table && i < bots.length; i++) {
  for (let j = i + 1; j < bots.length; j++) {
    for (let n = 0; n < games; n++) {
      if (match(bots[i], bots[j], n % 2)) wins[i][j]++;
      else wins[j][i]++;
    }
  }
}
// Bradley-Terry fit (the model behind Elo).
let g = bots.map(() => 1);
for (let k = 0; k < 500; k++) {
  g = g.map((_, i) => wins[i].reduce((x, y) => x + y, 0.5) /
    bots.reduce((s, _b, j) => (j === i ? s : s + games / (g[i] + g[j])), 0));
}
const elo = g.map((x) => 400 * Math.log10(x));
const mean = elo.reduce((x, y) => x + y, 0) / elo.length;
bots.forEach((b, i) => console.log(String(Math.round(1200 + elo[i] - mean)).padStart(5), b.name.padEnd(10),
  wins[i].map((w, j) => (i === j ? '   -' : (w / games * 100).toFixed(0).padStart(3) + '%')).join(' ')));
if (write) {
  if (bots.length !== 6) throw new Error('--write needs six bots');
  const rows = bots.map((b, i) => ({ net: table ? b.tnet : b.net, temp: table ? b.ttemp : b.temp, rating: Math.round(1200 + elo[i] - mean) }))
    .sort((x, y) => x.rating - y.rating);
  const file = path.join(__dirname, '..', 'public', 'ladder.js');
  const line = new RegExp('var ' + (table ? 'TABLE' : 'DUEL') + ' = .*');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(line, () => line.source.slice(0, -2) + JSON.stringify(rows) + ';'));
  console.log('written to public/ladder.js');
}
