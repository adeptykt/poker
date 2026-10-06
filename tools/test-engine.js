/* Headless-тест движка: играем тысячи раздач и проверяем инварианты. */
'use strict';
global.window = global;
require('../js/evaluator.js');
require('../js/deck.js');
require('../js/ai.js');
require('../js/engine.js');

var Table = global.NLHTable, Player = global.NLHPlayer, Eval = global.NLHEval;

function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } }

// --- проверка оценщика ---
var E = function (str) {
  return str.split(' ').map(function (t) {
    var s = t.charAt(t.length - 1), r = t.slice(0, -1);
    var v = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
    return { r: v[r] || +r, s: s };
  });
};
var tests = [
  ['As Ks Qs Js Ts 2h 3d', 8, 'Стрит-флеш'],
  ['Ah Kh Qh Jh Th 2c 3d', 8, 'Стрит-флеш'],
  ['9c 9d 9h 9s Kd 2c 3h', 7, 'Каре'],
  ['9c 9d 9h Kc Ks 2c 3h', 6, 'Фулл-хаус'],
  ['Ah Kh 9h 5h 2h 3d 7s', 5, 'Флеш'],
  ['As 2h 3d 4c 5h Kd Qs', 4, 'Стрит (колесо)'],
  ['As 2h 3d 4c 6h Kd Qs', 0, 'Хай-карты'],
  ['9c 9d 9h 2s 7c 3h 4s', 3, 'Сет'],
  ['9c 9d 2h 2s 7c 3h 4s', 2, 'Две пары'],
  ['9c 9d 2h 4s 7c 3h 5s', 1, 'Пара'],
  ['Ah 9c 9h 2h 7c 3h 5s', 1, 'Пара на доске (9)']
];
tests.forEach(function (t) {
  var ev = Eval.evaluate(E(t[0]));
  assert(ev.cat === t[1], t[0] + ' -> cat=' + ev.cat + ' (' + ev.name + '), ожидалось ' + t[1]);
});
// сравнение
var a = Eval.evaluate(E('As Ah Kd Qh Jc 2d 3s'));
var b = Eval.evaluate(E('Ks Kh Qd Jh 9c 2d 3s'));
assert(Eval.compare(a, b) > 0, 'AA должен быть лучше KK');
var c1 = Eval.evaluate(E('Ah Kh Qh Jh 9s 2d 3c'));
var c2 = Eval.evaluate(E('Ah Kh Qh Jh 8s 2d 3c'));
assert(Eval.compare(c1, c2) > 0, 'кикер сравнивается');

// --- прогон раздач ---
var N = +(process.argv[2] || 300);
var players = [];
for (var i = 0; i < 6; i++) {
  players.push(new Player({
    id: i, seat: i, name: 'p' + i, isHero: i === 0, stack: 100000, styleIdx: i
  }));
}
var table = new Table({ players: players, sb: 1000, bb: 2000, ante: 1000 });
table.pause = function () { return Promise.resolve(); };   // мгновенный прогон без анимаций
var total0 = players.reduce(function (s, p) { return s + p.stack; }, 0);
var hands = 0, showdowns = 0, folds = 0, guard = 0;

function heroStep(ctx) {
  // герой: случайный, но не совсем бездушный выбор
  var r = Math.random();
  if (r < 0.15 && ctx.toCall > 0) table.submitHeroAction({ type: 'fold' });
  else if (r < 0.8) table.submitHeroAction({ type: ctx.toCall === 0 ? 'check' : 'call' });
  else table.submitHeroAction({ type: 'raise', amount: ctx.myBet + ctx.minRaise + ctx.toCall });
}

table.on('hero-turn', function (ctx) { heroStep(ctx); });
table.on('hand-end', function (d) {
  hands++;
  if (d.reason === 'showdown') showdowns++; else folds++;
  // кнопка дилера и блайнды (проверяем, когда все игроки в игре)
  var allLive = table.players.every(function (p) { return !p.seatEmpty && p.stack > 0; });
  if (allLive) {
    assert(table.sbSeat === table.nextLive(table.button),
      'SB не следует за кнопкой дилера (раздача ' + table.handNo + ')');
    assert(table.bbSeat === table.nextLive(table.sbSeat),
      'BB не следует за малым блайндом (раздача ' + table.handNo + ')');
  }
  // инварианты
  var total = table.players.reduce(function (s, p) { return s + p.stack + p.committed; }, 0);
  assert(total === total0, 'расклад фишек нарушен: ' + total + ' != ' + total0 + ' (раздача ' + table.handNo + ')');
  table.players.forEach(function (p) {
    assert(p.stack >= 0, 'отрицательный стек у ' + p.name);
    assert(p.committed >= 0, 'отрицательный вклад у ' + p.name);
    assert(p.cards.length <= 2, 'больше 2 карт у ' + p.name);
  });
  assert(table.board.length <= 5, 'больше 5 общих карт');
  assert(table.contenderCount() >= 1, 'не осталось участников');
  table.players.forEach(function (p) { p.stack += 100000; });   // рефинанс, чтобы хватило на N раздач
  total0 = table.players.reduce(function (s, p) { return s + p.stack + p.committed; }, 0);
});

var chain = Promise.resolve();
for (var h = 0; h < N; h++) chain = chain.then(function () { return table.playHand(); });
chain.then(function () {
  console.log('Раздач сыграно: ' + hands + ' (шоудаунов: ' + showdowns + ', фолдов: ' + folds + ')');
  assert(hands === N, 'сыграно меньше раздач, чем запущено: ' + hands + '/' + N);

  // --- кнопка дилера обязана ходить по кругу ---
  var bp = [];
  for (var i = 0; i < 6; i++) {
    bp.push(new Player({ id: i, seat: i, name: 'b' + i, isHero: i === 0, stack: 1000000, styleIdx: i }));
  }
  var bt = new Table({ players: bp, sb: 1000, bb: 2000, ante: 1000 });
  var seats = [];
  for (var h = 0; h < 14; h++) {
    bp.forEach(function (p) { p.stack += 1000000; });   // никто не выбывает
    assert(bt.newHand() !== false, 'раздача ' + (h + 1) + ' не началась');
    seats.push(bt.button);
  }
  for (var k = 1; k < seats.length; k++) {
    assert(seats[k] === (seats[k - 1] + 1) % 6,
      'кнопка дилера стоит на месте: место ' + seats[k] + ' сразу после ' + seats[k - 1]);
  }
  // с пустыми местами кнопка всё равно ходит по живым
  var sp = [];
  [0, 2, 3, 4].forEach(function (s, i) {
    sp.push(new Player({ id: s, seat: s, name: 's' + s, isHero: s === 0, stack: 1000000, styleIdx: i }));
  });
  var st = new Table({ players: sp, sb: 1000, bb: 2000, ante: 1000 });
  var seq = [];
  for (var h2 = 0; h2 < 12; h2++) {
    sp.forEach(function (p) { p.stack += 1000000; });
    st.newHand();
    seq.push(st.button);
  }
  assert(new Set(seq).size === 4, 'кнопка дилера не обходит живых игроков: ' + seq.join(','));
  console.log('Кнопка дилера: ' + seats.slice(0, 7).join(' → ') + ' … | с пустыми местами: ' + seq.join(' → '));
  console.log('OK — все инварианты выдержаны.');
}).catch(function (e) { console.error('ОШИБКА:', e && e.stack || e); process.exit(1); });
