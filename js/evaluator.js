/* =========================================================
   Оценщик покерных комбинаций (7 карт -> лучшие 5)
   Канонический порядок: стрит-флеш(8) > каре(7) > фулл-хаус(6) >
   флеш(5) > стрит(4) > сет(3) > две пары(2) > пара(1) > хай-карты(0)
   ========================================================= */
(function (global) {
  'use strict';

  var NAMES = ['Хай-карты', 'Пара', 'Две пары', 'Сет', 'Стрит', 'Флеш', 'Фулл-хаус', 'Каре', 'Стрит-флеш'];
  var SUIT_ORDER = { c: 0, d: 1, h: 2, s: 3 };

  /** Старший ранг прямой по битовой маске рангов, либо null. Учитывает «колесо» A-2-3-4-5. */
  function straightHigh(mask) {
    for (var high = 14; high >= 6; high--) {
      var need = 0b11111 << (high - 4);
      if ((mask & need) === need) return high;
    }
    if ((mask & (1 << 14)) && (mask & 0b111100) === 0b111100) return 5; // A,2,3,4,5
    return null;
  }

  /** Битовая маска рангов прямой «от low до high» (в т.ч. колесо при high=5). */
  function straightMask(high) {
    return high === 5 ? 0b111100 : 0b11111 << (high - 4);
  }

  function top5(sortedDesc) { return sortedDesc.slice(0, 5); }

  /**
   * @param {Array<{r:number,s:string}>} cards — 5..7 карт
   * @returns {{cat:number, tie:number[], name:string, cards:Array, score:number}}
   */
  function evaluate(cards) {
    var counts = new Array(15).fill(0);
    var suitCards = { s: [], h: [], d: [], c: [] };
    var mask = 0;
    var i, card, j, tmp;
    for (i = 0; i < cards.length; i++) {
      card = cards[i];
      counts[card.r]++;
      suitCards[card.s].push(card);
      mask |= 1 << card.r;
    }

    // Сортировка рангов по убыванию
    var ranks = [];
    for (i = 14; i >= 2; i--) if (counts[i]) ranks.push(i);

    // Группировки: [кол-во, ранг]
    var groups = [];
    for (i = 0; i < ranks.length; i++) groups.push([counts[ranks[i]], ranks[i]]);
    groups.sort(function (a, b) { return (b[0] - a[0]) || (b[1] - a[1]); });

    // Масть с 5+ картами
    var flushSuit = null;
    for (var s in suitCards) if (suitCards[s].length >= 5) { flushSuit = s; break; }

    var str = straightHigh(mask);

    // 8 — стрит-флеш
    if (flushSuit && str) {
      var fmask = 0;
      for (i = 0; i < suitCards[flushSuit].length; i++) fmask |= 1 << suitCards[flushSuit][i].r;
      var sfHigh = straightHigh(fmask);
      if (sfHigh) return res(8, [sfHigh], cards, str);
    }
    // 7 — каре
    if (groups[0][0] === 4) {
      return res(7, [groups[0][1], groups[1][1]], cards, str);
    }
    // 6 — фулл-хаус
    if (groups[0][0] === 3 && groups[1] && groups[1][0] >= 2) {
      return res(6, [groups[0][1], groups[1][1]], cards, str);
    }
    // 5 — флеш
    if (flushSuit) {
      var fr = suitCards[flushSuit].map(function (c) { return c.r; }).sort(function (a, b) { return b - a; });
      return res(5, top5(fr), cards, str);
    }
    // 4 — стрит
    if (str) return res(4, [str], cards, str);
    // 3 — сет
    if (groups[0][0] === 3) {
      var kicks = ranks.filter(function (r) { return r !== groups[0][1]; }).slice(0, 2);
      return res(3, [groups[0][1]].concat(kicks), cards, str);
    }
    // 2 — две пары
    if (groups[0][0] === 2 && groups[1] && groups[1][0] === 2) {
      var kick = ranks.filter(function (r) { return r !== groups[0][1] && r !== groups[1][1]; })[0];
      return res(2, [groups[0][1], groups[1][1], kick], cards, str);
    }
    // 1 — пара
    if (groups[0][0] === 2) {
      var k2 = ranks.filter(function (r) { return r !== groups[0][1]; }).slice(0, 3);
      return res(1, [groups[0][1]].concat(k2), cards, str);
    }
    // 0 — хай-карты
    return res(0, top5(ranks), cards, str);
  }

  function res(cat, tie, cards, str) {
    // score — одно число для сравнения (используется ботами)
    var score = cat * 1e6;
    for (var i = 0; i < tie.length; i++) score += tie[i] * Math.pow(15, 5 - i);
    return { cat: cat, tie: tie, name: NAMES[cat], score: score, straight: str || 0 };
  }

  /** Сравнение двух оценок: >0 — первый лучше, 0 — равны (кикер решает) */
  function compare(a, b) {
    if (a.cat !== b.cat) return a.cat - b.cat;
    for (var i = 0; i < Math.max(a.tie.length, b.tie.length); i++) {
      var x = a.tie[i] || 0, y = b.tie[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  /** Человекочитаемое описание выигрышной комбинации */
  function describe(ev) {
    var t = ev.tie, n = ev.name;
    var R = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T' };
    function r(x) { return R[x] || String(x); }
    switch (ev.cat) {
      case 8: return 'Стрит-флеш: ' + (t[0] === 14 ? 'royal' : r(t[0]));
      case 7: return 'Каре ' + r(t[0]);
      case 6: return 'Фулл-хаус: ' + r(t[0]) + ' по ' + r(t[1]);
      case 5: return 'Флеш: ' + t.map(r).join('');
      case 4: return 'Стрит: ' + (t[0] === 14 ? 'A' : r(t[0]));
      case 3: return 'Сет ' + r(t[0]) + ' (' + t.slice(1).map(r).join(',') + ')';
      case 2: return 'Две пары: ' + r(t[0]) + ' и ' + r(t[1]) + ' (' + r(t[2]) + ')';
      case 1: return 'Пара ' + r(t[0]) + ' (' + t.slice(1).map(r).join(',') + ')';
      default: return 'Хай-карты: ' + t.map(r).join(',');
    }
  }

  global.NLHEval = { evaluate: evaluate, compare: compare, describe: describe, NAMES: NAMES, SUIT_ORDER: SUIT_ORDER, straightMask: straightMask };
})(window);
