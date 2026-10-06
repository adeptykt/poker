/* Калибровка порога входа: распределение префлоп-оценки по всем 1326 стартовым
   рукам. Нужна, чтобы порог openTh в js/ai.js ставить по факту, а не на глаз.

   Ориентиры для 6-макс (VPIP человека):
     агрессивный ~30-35%, сбалансированный ~20-25%, осторожный ~12-15%.

   Запуск: node tools\calib-preflop.js
   'use strict';
*/
global.window = global;
require('../js/ai.js');
var AI = global.NLHAI;

var SUITS = ['s', 'h', 'd', 'c'];
var R = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
function rank(r) { return String(R[r] || r); }
function name(a, b, suited) {
  var hi = rank(a) + rank(b);
  return a === b ? hi : hi + (suited ? 's' : 'o');
}

// Все стартовые руки = все пары из 52 карт: C(52,2) = 1326
var deck = [];
for (var r = 2; r <= 14; r++) {
  for (var s = 0; s < SUITS.length; s++) deck.push({ r: r, s: SUITS[s] });
}
var list = [];
for (var i = 0; i < deck.length; i++) {
  for (var j = i + 1; j < deck.length; j++) {
    var x = deck[i], y = deck[j];
    var hi = x.r >= y.r ? x : y, lo = x.r >= y.r ? y : x;
    list.push({
      cards: [hi, lo],
      key: name(hi.r, lo.r, hi.s === lo.s)
    });
  }
}
list.forEach(function (h) { h.score = AI.preflopScore(h.cards); });

console.log('Всего комбинаций: ' + list.length + ' (должно быть 1326)\n');

function pctOf(th) {
  return list.filter(function (h) { return h.score >= th; }).length * 100 / list.length;
}
console.log('Порог  рук%   границы спектра входа');
[0, 20, 25, 30, 34, 38, 42, 44, 46, 50, 52, 58, 66, 75].forEach(function (th) {
  var inside = list.filter(function (h) { return h.score >= th; })
    .sort(function (x, y) { return y.score - x.score; });
  var top = inside.slice(0, 5).map(function (h) { return h.key; }).join(' ');
  var bottom = inside.slice(-5).map(function (h) { return h.key; }).join(' ');
  console.log(pad(String(th), 6) + pad(pctOf(th).toFixed(1), 7) + pad(top, 22) + '… ' + bottom);
});

console.log('\nПороги из js/ai.js:');
AI.PERSONALITIES.forEach(function (t) {
  console.log('  ' + pad(t.name, 20) + 'openTh=' + pad(t.openTh, 4) +
    '→ входит с ' + pctOf(t.openTh).toFixed(1) + '% лучших рук');
});

console.log('\nКлючевые руки:');
var CHECK = [['AA', 14, 14, false], ['KK', 13, 13, false], ['QQ', 12, 12, false], ['22', 2, 2, false],
  ['AKs', 14, 13, true], ['AKo', 14, 13, false], ['AQs', 14, 12, true], ['AJs', 14, 11, true],
  ['ATs', 14, 10, true], ['A9s', 14, 9, true], ['KQs', 13, 12, true], ['KJs', 13, 11, true],
  ['QJs', 12, 11, true], ['JTs', 11, 10, true], ['T9s', 10, 9, true], ['98s', 9, 8, true],
  ['KQo', 13, 12, false], ['QJo', 12, 11, false], ['A2s', 14, 2, true], ['72o', 7, 2, false]];
CHECK.forEach(function (t) {
  var cards = t[1] === t[2]
    ? [{ r: t[1], s: 's' }, { r: t[2], s: 'h' }]
    : [{ r: t[1], s: 's' }, { r: t[2], s: t[3] ? 's' : 'h' }];
  console.log('  ' + pad(t[0], 5) + AI.preflopScore(cards).toFixed(1));
});

function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
