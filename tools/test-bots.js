/* Замер характеров ботов: три типа (агрессивный / осторожный / сбалансированный)
   играют между собой, а мы считаем их реальную статистику.

   Смысл инструмента — поймать регрессию: если правка в js/ai.js сделает
   «осторожного» таким же агрессивным, как «агрессивного», или наоборот,
   прогон это покажет, хотя визуально боты выглядят одинаково.

   Метрики — покерные, как в трекере:
     VPIP — доля рук, в которых игрок добровольно вложил деньги (без блайндов);
     PFR  — доля рук, в которых игрок повышал на префлопе;
     агр  — доля агрессивных действий (бет/рейз/олл-ин) среди всех действий;
     фолд — доля пасов среди всех действий.

   Запуск: node tools\test-bots.js [раздач]
   'use strict';
*/
global.window = global;
require('../js/evaluator.js');
require('../js/deck.js');
require('../js/ai.js');
require('../js/engine.js');

var Table = global.NLHTable, Player = global.NLHPlayer, AI = global.NLHAI;

var N = +(process.argv[2] || 2000);
var SEATS = 6, TYPES = AI.PERSONALITIES.length;
var START = 2000000, REBUY_BELOW = 400000;

// По два бота каждого типа за столом: 0,1,2,0,1,2
var players = [];
for (var i = 0; i < SEATS; i++) {
  players.push(new Player({
    id: i, seat: i, name: AI.PERSONALITIES[i % TYPES].name, isHero: false,
    stack: START, styleIdx: i % TYPES
  }));
}
var table = new Table({ players: players, sb: 1000, bb: 2000, ante: 1000 });
table.pause = function () { return Promise.resolve(); };   // без анимаций

function blank() {
  return { acts: 0, aggro: 0, calls: 0, checks: 0, folds: 0, allin: 0,
           vpip: 0, pfr: 0, hands: 0, spent: 0, won: 0, sd: 0, sdWin: 0 };
}
var stat = {};
AI.PERSONALITIES.forEach(function (t) { stat[t.key] = blank(); });

var kindOf = {};                          // id игрока -> профиль
table.players.forEach(function (p) { kindOf[p.id] = AI.PERSONALITIES[p.styleIdx]; });

// В раздаче отмечаем, кто уже вложился добровольно (для VPIP/PFR)
var voluntary = {}, raised = {};

table.on('action', function (e) {
  var p = e.player, t = kindOf[p.id];
  if (!t) return;
  var s = stat[t.key], preflop = table.street === 'preflop';
  s.acts++;
  if (e.type === 'fold') s.folds++;
  else if (e.type === 'check') s.checks++;
  else if (e.type === 'call') { s.calls++; if (preflop) voluntary[p.id] = true; }
  else if (e.type === 'raise' || e.type === 'allin') {
    s.aggro++;
    if (e.type === 'allin') s.allin++;
    if (preflop) { voluntary[p.id] = true; raised[p.id] = true; }
  }
});

table.on('hand-end', function (d) {
  table.players.forEach(function (p) {
    var t = kindOf[p.id];
    if (!t) return;
    var s = stat[t.key];
    s.hands++;
    if (voluntary[p.id]) s.vpip++;
    if (raised[p.id]) s.pfr++;
    if (d.reason === 'showdown' && (p.state === 'active' || p.state === 'allin')) {
      s.sd++;
      if (p.won > 0) s.sdWin++;
    }
  });
  voluntary = {}; raised = {};
});

// Прогон. Блайнды и анте за тысячи раздач съедают любой стек, а нам нужен
// замер характеров, а не турнир на вылет: перед раздачей игроки с мелким
// стеком докупаются. Сохранность фишек проверяется внутри раздачи (см. ниже).
var total0 = null;
var idle = 0;
table.on('idle', function () { idle++; });
table.on('hand-start', function () {});

var chain = Promise.resolve();
for (var h = 0; h < N; h++) {
  chain = chain.then(function () {
    players.forEach(function (p) {
      if (p.stack < REBUY_BELOW) p.stack = START;         // ребай, чтобы не вылетали
    });
    var before = players.map(function (p) { return p.stack + p.bet; });
    total0 = before.reduce(function (s, x) { return s + x; }, 0);
    return table.playHand().then(function () {
      var total1 = players.reduce(function (s, p) { return s + p.stack + p.bet; }, 0);
      if (total1 !== total0) {
        console.error('FAIL: фишки не сохранились в раздаче #' + (h + 1) + ': ' + total1 + ' != ' + total0);
        process.exit(1);
      }
      players.forEach(function (p, i) {
        var t = kindOf[p.id], delta = (p.stack + p.bet) - before[i];
        if (t) { stat[t.key].won += delta; if (delta < 0) stat[t.key].spent -= delta; }
      });
    });
  });
}

function pct(a, b) { return b ? (a * 100 / b) : 0; }
function f1(x) { return (Math.round(x * 10) / 10).toFixed(1); }
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

chain.then(function () {
  if (idle > 0) console.log('(раздач не стартовало: ' + idle + ')');

  console.log('=== Характеры ботов: ' + N + ' раздач, ' + SEATS + ' мест ===\n');
  console.log(pad('тип', 20) + pad('рук', 7) + pad('VPIP%', 8) + pad('PFR%', 7) +
    pad('агр%', 7) + pad('колл%', 7) + pad('чек%', 7) + pad('фолд%', 7) +
    pad('олл-ин', 8) + pad('вскрыт.', 9) + 'побед на вскрытии');
  AI.PERSONALITIES.forEach(function (t) {
    var s = stat[t.key];
    console.log(
      pad(t.name, 20) + pad(s.hands, 7) + pad(f1(pct(s.vpip, s.hands)), 8) +
      pad(f1(pct(s.pfr, s.hands)), 7) + pad(f1(pct(s.aggro, s.acts)), 7) +
      pad(f1(pct(s.calls, s.acts)), 7) + pad(f1(pct(s.checks, s.acts)), 7) +
      pad(f1(pct(s.folds, s.acts)), 7) + pad(s.allin, 8) + pad(s.sd, 9) +
      f1(pct(s.sdWin, s.sd)) + '%'
    );
  });
  console.log('');
  // --- типы обязаны отличаться в предсказуемую сторону ---
  var A = stat.aggressive, C = stat.cautious, B = stat.balanced;
  var agg = function (s) { return s.aggro / s.acts; };
  var fail = [];
  if (pct(A.vpip, A.hands) <= pct(C.vpip, C.hands)) fail.push('агрессивный входит в игру не чаще осторожного');
  if (agg(A) <= agg(C)) fail.push('агрессивный не агрессивнее осторожного по действиям');
  if (pct(A.pfr, A.hands) <= pct(C.pfr, C.hands)) fail.push('агрессивный реже повышает на префлопе, чем осторожный');
  if (pct(C.folds, C.acts) <= pct(A.folds, A.acts)) fail.push('осторожный пасует не чаще агрессивного');
  if (!(agg(C) < agg(B) && agg(B) < agg(A))) {
    fail.push('сбалансированный не лежит между осторожным и агрессивным: ' +
      f1(agg(C) * 100) + ' / ' + f1(agg(B) * 100) + ' / ' + f1(agg(A) * 100));
  }
  if (pct(B.vpip, B.hands) >= pct(A.vpip, A.hands)) fail.push('сбалансированный входит в игру не реже агрессивного');
  if (A.allin <= C.allin) fail.push('агрессивный реже идёт в олл-ин, чем осторожный');
  // Блеф и агрессия агрессивного не должны быть бесплатным пропуском на вскрытие:
  // он доходит до него с более слабыми руками. Проверяем именно это — что агрессор
  // на вскрытии слабее ОБОИХ тайтовых типов. Порядок между сбалансированным и
  // осторожным не фиксируем: на ~700-1000 вскрытий разница в 1-2 пункта лежит
  // внутри стандартной ошибки доли (±1.9%), и такая проверка была бы флаки.
  var sdA = pct(A.sdWin, A.sd), sdB = pct(B.sdWin, B.sd), sdC = pct(C.sdWin, C.sd);
  if (!(sdA < sdB && sdA < sdC)) {
    fail.push('агрессивный не слабее тайтовых на вскрытии: агрессивный ' + f1(sdA) +
      ', сбалансированный ' + f1(sdB) + ', осторожный ' + f1(sdC));
  }
  // VPIP и агрессия обязаны идти по возрастанию: осторожный < сбалансированный < агрессивный
  if (!(pct(C.vpip, C.hands) < pct(B.vpip, B.hands) && pct(B.vpip, B.hands) < pct(A.vpip, A.hands))) {
    fail.push('VPIP не растёт от осторожного к агрессивному: ' +
      f1(pct(C.vpip, C.hands)) + ' / ' + f1(pct(B.vpip, B.hands)) + ' / ' + f1(pct(A.vpip, A.hands)));
  }

  if (fail.length) {
    fail.forEach(function (m) { console.error('FAIL: ' + m); });
    process.exit(1);
  }
  console.log('OK — три типа различимы: агрессивный давит и блефует, осторожный пасует');
  console.log('     и ждёт сильных рук, сбалансированный держится между ними.');
}).catch(function (e) { console.error('ОШИБКА:', e && e.stack || e); process.exit(1); });
