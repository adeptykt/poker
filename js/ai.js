/* =========================================================
   ИИ соперников: решение по силе руки, пот-оддсам и характеру
   ========================================================= */
(function (global) {
  'use strict';

  var Eval = global.NLHEval;

  /* Три типа ботов. Индекс в PERSONALITIES совпадает с полем styleIdx у
     игрока (см. ROSTER в js/ui.js), поэтому место за столом само определяет
     характер соперника.

     Настройки подобраны так, чтобы разница читалась за столом:
       aggressive  — много рейзов и блефов, играет широко, редко пасует;
       cautious    — тайтовый: входит только с сильными руками, почти не блефует;
       balanced    — середина: тайтово-агрессивно, ставки по ситуации.

     Поля:
       openTh   — порог силы, ниже которого рука не разыгрывается (тайтовость);
       aggro    — частота агрессии 0..1: рейзы вместо колла, ставки на чеке;
       bluff    — частота блефов 0..1;
       valueTh  — с какой силы рука превращается в «монстр» (рейз/олл-ин);
       chase    — склонность платить по дро и мусорным дро (лоуз-колл);
       size     — множитель размера ставки: агрессор ставит крупнее;
       noise    — разброс оценки, «человечность» решений; */
  var PERSONALITIES = [
    { key: 'aggressive', name: 'агрессивный',      openTh: 34, aggro: 0.88, bluff: 0.30, valueTh: 74, chase: 1.25, size: 1.20, noise: 14 },
    { key: 'cautious',   name: 'осторожный',       openTh: 52, aggro: 0.22, bluff: 0.03, valueTh: 86, chase: 0.72, size: 0.82, noise: 6  },
    { key: 'balanced',   name: 'сбалансированный', openTh: 44, aggro: 0.55, bluff: 0.12, valueTh: 80, chase: 1.00, size: 1.00, noise: 10 }
  ];

  /** Профиль бота по styleIdx (любое число приводится к трём типам) */
  function personalityOf(styleIdx) {
    var n = PERSONALITIES.length;
    var i = Math.abs(styleIdx | 0) % n;
    return PERSONALITIES[i];
  }

  /** Префлоп-оценка по Чен-формуле, нормированная в 0..100 */
  function preflopScore(cards) {
    if (cards.length < 2) return 40;
    var a = cards[0], b = cards[1];
    if (a.r < b.r) { var t = a; a = b; b = t; }
    var v = a.r === 14 ? 10 : a.r === 13 ? 8 : a.r === 12 ? 7 : a.r === 11 ? 6 : a.r / 2;
    if (a.r === b.r) v = Math.max(v * 2, 5);                 // пара: как в формуле Чена
    else {
      var gap = a.r - b.r - 1;
      if (gap === 0) v += -2;
      else if (gap === 1) v += -4;
      else if (gap === 2) v += -8;
      else if (gap === 3) v += -10;
      else if (gap >= 4) v -= 12;
      if (a.s === b.s) v += 2;                                 // одномастные
      if (gap <= 1 && a.r < 12) v += 1;
    }
    // Нормировка в 0..100: максимум формулы — AA (20), минус — мусор вроде 72o
    var pct = (v + 12) * 100 / 32;
    return Math.max(0, Math.min(100, pct));
  }

  /** Постфлоп: 0..100 — «уверенность» в связке карта/бет */
  function postflopScore(cards, board, pers) {
    var ev = Eval.evaluate(cards);
    var base = [4, 22, 40, 56, 70, 82, 91, 97, 100][ev.cat];
    var chase = pers ? pers.chase : 1;

    // текстура доски
    var pairs = {}, boardRanks = board.map(function (c) { return c.r; });
    var hasPairOnBoard = false;
    for (var i = 0; i < boardRanks.length; i++) {
      if (pairs[boardRanks[i]]) hasPairOnBoard = true;
      pairs[boardRanks[i]] = true;
    }
    var wet = 0, suits = {};
    for (var j = 0; j < board.length; j++) { suits[board[j].s] = (suits[board[j].s] || 0) + 1; }
    for (var k in suits) if (suits[k] >= 3) wet += 1;
    var hi = Math.max.apply(null, boardRanks);

    // Топ-пара с хорошим кикером — сильнее на низкой доске
    if (ev.cat === 1) base += (hi <= 10 ? 8 : 0);
    if (ev.cat === 0) base += (board.length >= 3 ? 6 : 0);
    if (ev.cat <= 2 && hasPairOnBoard) base -= 6;   // две пары на спаренной доске — слабо
    if (ev.cat <= 2 && hi >= 12) base -= 4;         // на высокой доске — слабее

    // Дрова: агрессивный переоценивает свои ауты, осторожный — недоеценивает
    var draw = drawBonus(cards, board, ev);
    base += draw * 0.9 * chase;
    if (wet && ev.cat <= 3) base += 4 * chase;

    return Math.max(0, Math.min(100, base));
  }

  /** Бонус за ауты (флеш-дро, стрит-дро) */
  function drawBonus(cards, board, ev) {
    if (ev.cat >= 5) return 0;
    var suits = {}, ranks = {};
    cards.concat(board).forEach(function (c) { suits[c.s] = (suits[c.s] || 0) + 1; ranks[c.r] = (ranks[c.r] || 0) + 1; });
    var mySuit = 0, allSuit = null;
    for (var s in suits) {
      var mine = cards.filter(function (c) { return c.s === s; }).length;
      if (suits[s] > mySuit) { mySuit = suits[s]; allSuit = s; }
    }
    var bonus = 0;
    if (mySuit === 4) bonus += 11;                                   // флеш-дро
    var mask = 0;
    for (var r in ranks) mask |= 1 << (+r);
    var openEnded = false, gutshot = false, hi, need, missing;
    for (hi = 14; hi >= 6 && !openEnded; hi--) {
      need = Eval.straightMask(hi);
      if ((mask & need) === need) {
        // открытое дро: есть карта с обоих концов
        if ((mask & (1 << (hi - 4))) || (hi + 1 <= 14 && (mask & (1 << (hi + 1))))) openEnded = true;
      }
    }
    if (!openEnded) {
      for (hi = 14; hi >= 5; hi--) {
        need = Eval.straightMask(hi);
        missing = need & ~mask;
        if (missing !== 0 && (missing & (missing - 1)) === 0) gutshot = true;   // не хватает ровно одной карты
      }
    }
    if (openEnded) bonus += 8;
    if (gutshot) bonus += 4;
    return bonus;
  }

  /**
   * Решение бота.
   * @param {object} p игрок (нужен p.styleIdx — тип характера)
   * @param {object} c контекст: {toCall,pot,street,board,stack,myBet,minRaise,biggest,live,position}
   * @returns {{type:string, amount?:number, tag:string}}
   */
  function decide(p, c) {
    var pers = personalityOf(p.styleIdx);
    var preflop = c.board.length === 0;
    var score = preflop ? preflopScore(p.cards) : postflopScore(p.cards, c.board, pers);
    score += (Math.random() - 0.5) * pers.noise;              // шум: бот не робот
    if (score > 100) score = 100;

    var toCall = c.toCall;
    var potOdds = toCall > 0 ? (toCall * 100) / (c.pot + toCall) : 0;
    var aggro = pers.aggro;
    // поздняя позиция — агрессивнее (осторожный выигрывает от неё меньше всех)
    if (c.position > 0) { score += 6; aggro = Math.min(1, aggro + 0.1); }
    // много живых соперников — осторожный сбавляет, агрессивный давит сильнее
    var live = c.live || 2;
    if (live > 2) score -= (live - 2) * (1 - pers.aggro) * 3;

    // префлоп: слишком дешёвая рука не разыгрывается вообще (тайтовость)
    if (preflop && score < pers.openTh && toCall > 0) {
      // исключение: дешёвый вход по большой pot-odds (колл 1 BB при анте)
      if (!(potOdds < 18 && score > pers.openTh - 10)) return { type: 'fold', tag: 'fold' };
    }

    if (toCall === 0) {
      // можно чекать: агрессор ставит часто и с любой зацепкой, осторожный — только с силой
      if (score > pers.valueTh && Math.random() < pers.aggro) {
        return { type: 'raise', amount: raiseAmount(c, p, pers, aggro), tag: 'bet' };
      }
      if (score > 52 && Math.random() < pers.aggro * 0.45) {
        return { type: 'raise', amount: raiseAmount(c, p, pers, aggro * 0.85), tag: 'bet' };
      }
      if (score < 45 && Math.random() < pers.bluff) {
        return { type: 'raise', amount: raiseAmount(c, p, pers, aggro * 0.7), tag: 'bet' };
      }
      return { type: 'check', tag: 'check' };
    }

    // очень сильная рука: агрессивный чаще идёт в олл-ин, осторожный — рейзит аккуратно
    if (score >= pers.valueTh && score >= 74) {
      var allin = Math.random() < pers.aggro * 0.55;
      if (allin && p.stack >= toCall * 2) return { type: 'allin', amount: p.stack, tag: 'allin' };
      return { type: 'raise', amount: raiseAmount(c, p, pers, aggro * 1.2), tag: 'raise' };
    }

    // рабочая зона: колл с учётом пот-оддсов; агрессор вместо колла часто рейзит.
    // На префлопе он открывает рейзом (а не лимпит), поэтому порог ниже.
    var callTh = Math.max(40, potOdds + 12 - (pers.chase - 1) * 8);
    if (score >= callTh) {
      var raiseNeed = preflop ? pers.openTh + 10 : 64;
      if (Math.random() < pers.aggro * (preflop ? 0.6 : 0.55) && score > raiseNeed) {
        return { type: 'raise', amount: raiseAmount(c, p, pers, aggro), tag: 'raise' };
      }
      return { type: 'call', tag: 'call' };
    }

    // блеф-рейз: только у агрессивных типов и только когда есть хоть какая-то зацепка
    if (Math.random() < pers.bluff * 0.4 && score > 40) {
      return { type: 'raise', amount: raiseAmount(c, p, pers, aggro), tag: 'raise' };
    }
    return { type: 'fold', tag: 'fold' };
  }

  /** Размер ставки: база — доля банка, pers.size двигает её вверх/вниз */
  function raiseAmount(c, p, pers, aggro) {
    var min = c.minRaise + c.myBet;
    var target = (c.pot * (0.45 + 0.45 * aggro) + c.toCall) * (pers ? pers.size : 1);
    var v = Math.max(min, Math.round(target));
    v = Math.min(v, p.stack + c.myBet);
    v = Math.max(v, min);
    return Math.min(v, p.stack);
  }

  global.NLHAI = {
    decide: decide,
    preflopScore: preflopScore,
    postflopScore: postflopScore,
    personalityOf: personalityOf,
    PERSONALITIES: PERSONALITIES
  };
})(window);
