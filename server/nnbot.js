'use strict';
/* Neural bots for ranked play. Heads-up: the networks of ml/train.py (server/models.json).
 * Three or more players dealt in: the networks of ml/train_multi.py (public/nn.js), same names.
 * features() must stay in step with Env.obs() and card_feats() in ml/train.py. */
const path = require('path');
const G = require(path.join(__dirname, '..', 'public', 'game.js'));
const NN = require(path.join(__dirname, '..', 'public', 'nn.js'));
const DATA = NN.parse(require('./models.json'), 4);
const { LADDER } = require(path.join(__dirname, '..', 'public', 'ladder.js'));

const NETS = DATA.nets, STREETS = ['preflop', 'flop', 'turn', 'river'];

// Network input and legal-action mask for the seat on turn in a heads-up hand.
function features(table, seat, rng) {
  const hand = table.hand, me = hand.seats[seat], L = G.legal(table, seat), bb = hand.bb;
  const opp = hand.seats.find((s) => s.dealt && s.idx !== seat);
  const st = STREETS.indexOf(hand.street);
  const oppStack = table.seats[opp.idx].stack;
  const pot = hand.seats.reduce((n, s) => n + s.contributed, 0) / bb;
  const toCall = Math.min(L.toCall, L.stack) / bb;
  const eff = Math.max(0, Math.min(L.stack, oppStack + opp.bet - me.bet)) / bb;
  const raises = { me: [0, 0, 0, 0], opp: [0, 0, 0, 0] };
  hand.history.forEach((h) => {
    if (h.action === 'raise' || h.action === 'bet') raises[h.seat === seat ? 'me' : 'opp'][STREETS.indexOf(h.street)]++;
  });
  const nr = raises.me[st] + raises.opp[st];
  const x = NN.cardFeatures(me.cards, hand.board, rng, DATA.preflop).concat(
    STREETS.map((s, i) => (i === st ? 1 : 0)),
    [hand.btnIdx === seat ? 1 : 0, toCall / (pot + toCall), Math.min(toCall / pot, 2) / 2, Math.min(eff / pot, 10) / 10,
      Math.log1p(eff) / 5, Math.log1p(pot) / 5, Math.min(nr, 4) / 4, toCall > 0 ? 1 : 0],
    raises.me.map((n) => Math.min(n, 3) / 3), raises.opp.map((n) => Math.min(n, 3) / 3));
  const sized = L.canRaise && nr < 4;
  return { x, mask: [L.toCall > 0, true, sized, sized, L.canRaise], L };
}

// Action probabilities for the seat on turn.
function policy(table, seat, bot, rng) {
  rng = rng || Math.random;
  const L = G.legal(table, seat), multi = table.hand.m > 2;
  const f = multi ? NN.features(table, seat, L, rng, NN.data().preflop) : features(table, seat, rng);
  return { p: NN.probs(multi ? NN.data().nets[bot.tnet] : NETS[bot.net], f, multi ? bot.ttemp : bot.temp, multi ? bot.teps : bot.eps), L };
}

// Plays one action for the bot on turn and returns the engine event.
function step(table, seat, id, rng) {
  rng = rng || Math.random;
  const { p, L } = policy(table, seat, LADDER.find((b) => b.id === id), rng);
  const d = NN.draw(p, table, L, rng);
  return G.act(table, seat, d.action, d.amount);
}

module.exports = { LADDER, NETS, policy, step, features };
