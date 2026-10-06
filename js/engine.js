/* =========================================================
   Движок No-Limit Hold'em: раздача, блайнды, ставки, банки, шоудаун
   ========================================================= */
(function (global) {
  'use strict';

  var Deck = global.NLHDeck, Eval = global.NLHEval, AI = global.NLHAI;

  /* ------------------------------ Игрок ------------------------------ */
  function Player(cfg) {
    this.id = cfg.id;
    this.seat = cfg.seat;
    this.name = cfg.name;
    this.isHero = !!cfg.isHero;
    this.avatar = cfg.avatar || '🙂';
    this.flag = cfg.flag || '';
    this.styleIdx = cfg.styleIdx || 0;
    this.stack = cfg.stack || 0;
    this.seatEmpty = !!cfg.seatEmpty;
    this.reset();
  }
  Player.prototype.reset = function () {
    this.cards = [];
    this.bet = 0;
    this.committed = 0;
    this.acted = false;
    this.hasOption = false;
    this.state = (this.seatEmpty || this.stack <= 0) ? 'out' : 'active';
    this.lastAction = null;
    this.hole = false;      // вскрывать карты
    this.won = 0;
    this.evalResult = null;
  };
  Player.prototype.betAmount = function () { return this.bet; };
  Player.prototype.canAct = function () { return this.state === 'active' && this.stack > 0; };

  /* ------------------------------ Стол ------------------------------ */
  function Table(cfg) {
    cfg = cfg || {};
    this.sb = cfg.sb || 1000;
    this.bb = cfg.bb || 2000;
    this.ante = cfg.ante || 0;
    this.players = cfg.players || [];
    this.handNo = 0;
    this.button = -1;
    this.board = [];
    this.street = 'preflop';
    this.currentBet = 0;
    this.minRaise = this.bb;
    this.lastAggressor = null;
    this.potCache = 0;
    this.tableId = cfg.tableId || '00000000-00000000-00000000-0';
    this.history = [];
    this._ls = {};
    this._heroResolve = null;
    this.speed = cfg.speed || 1;
  }

  /* --- события --- */
  Table.prototype.on = function (event, fn) {
    (this._ls[event] = this._ls[event] || []).push(fn);
    return this;
  };
  Table.prototype.emit = function (event, data) {
    var l = this._ls[event];
    if (l) for (var i = 0; i < l.length; i++) l[i](data);
  };
  Table.prototype.pause = function (ms) {
    return new Promise(function (res) { setTimeout(res, Math.max(0, ms / (1)) ); });
  };

  /* --- помощники --- */
  Table.prototype.hero = function () {
    for (var i = 0; i < this.players.length; i++) if (this.players[i].isHero) return this.players[i];
    return null;
  };
  Table.prototype.live = function () {
    return this.players.filter(function (p) { return !p.seatEmpty && p.stack > 0; });
  };
  Table.prototype.nextLive = function (fromSeat) {
    var n = this.players.length;
    for (var i = 1; i <= n; i++) {
      var idx = (((fromSeat + i) % n) + n) % n;
      if (!this.players[idx].seatEmpty && this.players[idx].stack > 0) return idx;
    }
    return fromSeat;
  };
  Table.prototype.contenders = function () {
    return this.players.filter(function (p) { return !p.seatEmpty && (p.state === 'active' || p.state === 'allin'); });
  };
  Table.prototype.contenderCount = function () { return this.contenders().length; };
  Table.prototype.potTotal = function () {
    var s = 0;
    for (var i = 0; i < this.players.length; i++) s += this.players[i].committed;
    return s;
  };

  Table.prototype.post = function (p, amount, isAnte) {
    amount = Math.max(0, Math.min(amount, p.stack));
    p.stack -= amount;
    if (!isAnte) p.bet += amount;   // анте — «мёртвые» деньги, не поднимают уровень ставки
    p.committed += amount;
    if (p.stack === 0 && p.state === 'active') p.state = 'allin';
    this.emit('bet', { player: p, amount: amount });
    return amount;
  };

  /* ------------------------------ Раздача ------------------------------ */
  Table.prototype.newHand = function () {
    this.handNo++;
    this.deck = Deck.create();
    this.board = [];
    this.street = 'preflop';
    this.currentBet = 0;
    this.minRaise = this.bb;
    this.lastAggressor = null;
    this.winners = [];
    for (var i = 0; i < this.players.length; i++) this.players[i].reset();

    var live = this.live();
    if (live.length < 2) { this.emit('message', 'Нужно минимум 2 игрока с фишками'); return false; }

    // кнопка дилера
    this.button = this.nextLive(this.button);
    this.sbSeat = this.nextLive(this.button);
    this.bbSeat = this.nextLive(this.sbSeat);

    // раздать карты (до блайндов: олл-ин по анте всё равно получает карты)
    var self2 = this;
    for (var r = 0; r < 2; r++) {
      var order = self2.live();
      for (var j = 0; j < order.length; j++) order[j].cards.push(self2.deck.pop());
    }

    // анте
    if (this.ante > 0) {
      var self = this;
      live.forEach(function (p) { if (p.state === 'active') self.post(p, Math.min(self.ante, p.stack), true); });
    }
    // блайнды
    this.post(this.players[this.sbSeat], this.sb);
    this.post(this.players[this.bbSeat], this.bb);
    this.currentBet = this.bb;
    this.minRaise = this.bb;
    this.players[this.sbSeat].lastAction = 'sb';
    this.players[this.bbSeat].lastAction = 'bb';
    this.players[this.bbSeat].hasOption = true;   // опция большого блайнда
    this.live().forEach(function (p) { p.acted = (p.bet === self2.currentBet && !p.hasOption); });

    this.emit('message', 'Раздача #' + this.handNo);
    this.emit('state');
    return true;
  };

  Table.prototype.resetStreet = function () {
    for (var i = 0; i < this.players.length; i++) { this.players[i].bet = 0; this.players[i].acted = false; this.players[i].hasOption = false; }
    this.currentBet = 0;
    this.minRaise = this.bb;
    this.lastAggressor = null;
  };

  Table.prototype.dealStreet = function (street) {
    this.street = street;
    if (street === 'flop') { this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop()); }
    else if (street === 'turn' || street === 'river') { this.board.push(this.deck.pop()); }
  };

  Table.prototype.nextStreet = function (s) {
    return s === 'preflop' ? 'flop' : s === 'flop' ? 'turn' : s === 'turn' ? 'river' : 'showdown';
  };

  /* ------------------------------ Раунд ставок ------------------------------ */
  Table.prototype.roundComplete = function () {
    var act = this.players.filter(function (p) { return p.state === 'active' && !p.seatEmpty; });
    for (var i = 0; i < act.length; i++) {
      if (act[i].hasOption) return false;
      if (!act[i].acted) return false;
      if (act[i].bet !== this.currentBet) return false;
    }
    return true;
  };

  Table.prototype.actionOrder = function (fromSeat) {
    var n = this.players.length, out = [];
    for (var i = 1; i <= n; i++) {
      var idx = (((fromSeat + i) % n) + n) % n;
      if (!this.players[idx].seatEmpty) out.push(idx);
    }
    return out;
  };

  Table.prototype.askHero = function (p, street) {
    var self = this;
    return new Promise(function (resolve) {
      self._heroResolve = resolve;
      self.emit('hero-turn', {
        player: p,
        street: street,
        toCall: Math.max(0, self.currentBet - p.bet),
        minRaise: self.minRaise,
        currentBet: self.currentBet,
        myBet: p.bet,
        pot: self.potTotal(),
        stack: p.stack
      });
    });
  };

  Table.prototype.submitHeroAction = function (action) {
    var r = this._heroResolve;
    if (!r) return false;
    this._heroResolve = null;
    this.emit('hero-turn-end');
    r(action);
    return true;
  };

  /* Время «размышления» бота — как у живого человека: зависит от улицы и ставки */
  Table.prototype.thinkTime = function (p, street) {
    var t = 750 + Math.random() * 1250;
    if (street !== 'preflop') t += 450 + Math.random() * 850;      // с флопом думают дольше
    var toCall = Math.max(0, this.currentBet - p.bet);
    if (toCall > 0 && toCall >= p.stack) t *= 0.55;                // решение об алл-ине быстрее
    if (toCall === 0) t *= 0.7;                                    // чек делается быстро
    return Math.round(t);
  };

  Table.prototype.botAction = function (p, street) {
    var live = this.contenders();
    var toCall = Math.max(0, this.currentBet - p.bet);
    var biggest = 0;
    this.players.forEach(function (q) { biggest = Math.max(biggest, q.stack); });
    var pos = this.actionOrder(this.button).indexOf(p.seat);
    var act = AI.decide(p, {
      toCall: toCall,
      pot: this.potTotal(),
      street: street,
      board: this.board,
      stack: p.stack,
      myBet: p.bet,
      minRaise: this.minRaise,
      biggest: biggest,
      live: live.length,
      position: pos >= 0 && pos < 3 ? 1 : 0
    });
    return act;
  };

  Table.prototype.applyAction = function (p, action) {
    var self = this;
    var toCall = Math.max(0, this.currentBet - p.bet);
    var minTotal = p.bet + Math.max(this.minRaise, toCall || this.minRaise);

    if (action.type === 'fold') {
      p.state = 'folded';
      p.lastAction = 'fold';
      p.hole = false;
    } else if (action.type === 'check') {
      if (toCall > 0) { p.state = 'folded'; p.lastAction = 'fold'; }   // нельзя чекать при ставке
      else { p.acted = true; p.lastAction = 'check'; }
    } else if (action.type === 'call') {
      if (toCall === 0) { p.acted = true; p.lastAction = 'check'; }
      else {
        var amt = this.post(p, toCall);
        p.acted = true;
        p.lastAction = (amt < toCall) ? 'allin' : 'call';
      }
    } else if (action.type === 'raise' || action.type === 'allin') {
      var want = (action.type === 'allin') ? p.stack + p.bet : (+action.amount);
      if (!isFinite(want)) want = minTotal;                       // мусорный ввод -> минимальный рейз
      var target = Math.max(want, minTotal);
      target = Math.min(target, p.stack + p.bet);
      if (target <= p.bet) { // безопасный фолбэк
        p.acted = true; p.lastAction = 'check';
      } else if (target <= this.currentBet) {
        this.post(p, target - p.bet);
        p.acted = true; p.lastAction = 'call';
      } else {
        var inc = target - this.currentBet;
        this.post(p, target - p.bet);
        if (inc >= this.minRaise) this.minRaise = inc;
        this.currentBet = target;
        this.lastAggressor = p;
        this.players.forEach(function (o) {
          if (o !== p && o.state === 'active') { o.acted = false; o.lastAction = null; }
        });
        p.acted = true;
        p.lastAction = (p.stack === 0) ? 'allin' : (p.lastAction === 'sb' || p.lastAction === 'bb' ? 'raise' : 'raise');
        if (p.stack === 0) p.state = 'allin';
      }
    }
    p.hasOption = false;
    this.emit('action', { player: p, type: p.lastAction, amount: p.bet, toCall: toCall });
    this.emit('state');
  };

  /**
   * Раунд ставок. Возвращает 'ok' или 'folded' (все вышли, остался один).
   */
  Table.prototype.bettingRound = function (street) {
    var self = this;
    if (street !== 'preflop') this.resetStreet();
    var firstToAct = (street === 'preflop') ? this.bbSeat : this.button;
    var order = this.actionOrder(firstToAct);
    var idx = -1, guard = 0;

    return (function loop() {
      return new Promise(function (resolve) {
        function step() {
          if (guard++ > 400) return resolve('ok');
          if (self.contenderCount() <= 1) return resolve('folded');
          if (self.roundComplete()) return resolve('ok');

          idx = (idx + 1) % order.length;
          var p = self.players[order[idx]];
          if (p.seatEmpty || p.state !== 'active' || p.stack <= 0) return next();
          var need = Math.max(0, self.currentBet - p.bet);
          if (p.acted && !p.hasOption && need <= 0) return next();

          var act;
          if (p.isHero) {
            self.emit('turn', p);
            self.askHero(p, street).then(function (a) { act = a; after(); });
          } else {
            // Бот «думает» как человек: событие хода (в UI загорается кольцо
            // ожидания вокруг аватара — зелёное, затем жёлтое и красное),
            // затем заметная пауза перед решением.
            var thinkMs = self.thinkTime(p, street);
            self.emit('think', { player: p, ms: thinkMs });
            self.emit('turn', p);
            self.pause(thinkMs).then(function () {
              act = self.botAction(p, street);
              // и короткая пауза после хода, чтобы боты не били очередью
              self.pause(320 + Math.random() * 420).then(after);
            });
          }

          function after() {
            p.hasOption = false;
            self.applyAction(p, act || { type: 'fold' });
            step();
          }
          function next() { setTimeout(step, 0); }
        }
        step();
      });
    })();
  };

  /* ------------------------------ Банки ------------------------------ */
  Table.prototype.refundUncalled = function () {
    var max = -1, second = -1, top = null;
    this.players.forEach(function (p) {
      if (p.committed > max) { second = max; max = p.committed; top = p; }
      else if (p.committed > second) { second = p.committed; }
    });
    if (top && max > second && top.state !== 'folded') {
      var back = max - second;
      top.committed -= back;
      top.bet = Math.max(0, top.bet - back);
      top.stack += back;
      this.emit('message', 'Незакрытая ставка возвращена: ' + back);
      return true;
    }
    return false;
  };

  Table.prototype.buildPots = function () {
    var contribs = this.players.filter(function (p) { return p.committed > 0; });
    var levels = contribs.map(function (p) { return p.committed; })
      .filter(function (v, i, a) { return a.indexOf(v) === i; })
      .sort(function (a, b) { return a - b; });
    var pots = [], prev = 0;
    for (var i = 0; i < levels.length; i++) {
      var lv = levels[i];
      var elig = contribs.filter(function (p) { return p.committed >= lv; });
      var amount = elig.length * (lv - prev);
      if (amount > 0) {
        var last = pots[pots.length - 1];
        var same = last && last.eligible.length === elig.length && last.eligible.every(function (p) { return elig.indexOf(p) >= 0; });
        if (same) last.amount += amount;
        else pots.push({ amount: amount, eligible: elig });
      }
      prev = lv;
    }
    return pots;
  };

  Table.prototype.awardPots = function (evaluate) {
    var self = this;
    var pots = this.buildPots();
    var result = [];
    pots.forEach(function (pot) {
      var elig = pot.eligible.filter(function (p) { return p.state !== 'folded'; });
      if (!elig.length) return;
      var scored = elig.map(function (p) {
        return { p: p, ev: evaluate(p) };
      });
      scored.sort(function (a, b) { return Eval.compare(b.ev, a.ev); });
      var winners = scored.filter(function (x) { return Eval.compare(x.ev, scored[0].ev) === 0; });
      var share = Math.floor(pot.amount / winners.length);
      var rem = pot.amount - share * winners.length;
      winners.forEach(function (w, i) {
        var gain = share + (i < rem ? 1 : 0);
        w.p.stack += gain;
        w.p.won += gain;
        if (result.indexOf(w.p) < 0) result.push(w.p);
      });
      winners.forEach(function (w) { self.emit('pot-win', { player: w.p, amount: share, hand: describeHand(w.ev), pot: pot.amount }); });
    });
    this.winners = result;
    return result;
  };

  function describeHand(ev) { return Eval.describe(ev); }

  /* ------------------------------ Итоги раздачи ------------------------------ */
  Table.prototype.clearBets = function () {
    this.players.forEach(function (p) { p.bet = 0; p.committed = 0; });
  };

  Table.prototype.finishByFold = function () {
    var winner = this.contenders()[0];
    if (!winner) { this.emit('state'); return; }
    var amount = this.potTotal();
    winner.stack += amount;
    winner.won += amount;
    this.winners = [winner];
    this.emit('pot-win', { player: winner, amount: amount, hand: null, uncontested: true });
    this.clearBets();
    this.emit('hand-end', { winners: [winner], reason: 'fold' });
    this.emit('state');
  };

  Table.prototype.showdown = function () {
    var self = this;
    this.street = 'showdown';
    this.contenders().forEach(function (p) { p.hole = true; p.evalResult = Eval.evaluate(p.cards.concat(this.board)); }, this);
    this.refundUncalled();
    var winners = this.awardPots(function (p) {
      if (!p.evalResult) p.evalResult = Eval.evaluate(p.cards.concat(self.board));
      return p.evalResult;
    });
    var rec = { hand: this.handNo, winners: [], board: this.board.map(function (c) { return c.r + c.s; }) };
    this.contenders().forEach(function (p) {
      rec.winners.push({ name: p.name, won: p.won, hand: p.evalResult ? Eval.describe(p.evalResult) : null });
    });
    this.history.unshift(rec);
    if (this.history.length > 30) this.history.pop();
    this.clearBets();
    this.emit('hand-end', { winners: winners, reason: 'showdown' });
    this.emit('state');
  };

  Table.prototype.record = function () { /* история ведётся в showdown */ };

  /* ------------------------------ Основной цикл ------------------------------ */
  Table.prototype.playHand = function () {
    var self = this;
    if (!this.newHand()) { this.emit('idle'); return Promise.resolve(); }
    return this.pause(500).then(function loop(street) {
      if (street === 'river') return self.runout().then(function () { return self.showdown(); });
      return self.bettingRound(street).then(function (res) {
        if (res === 'folded' || self.contenderCount() <= 1) { self.finishByFold(); return; }
        var next = self.nextStreet(street);
        self.emit('turn', { seat: null });
        if (next === 'showdown') { self.dealStreet('river'); self.emit('state'); return self.pause(700).then(function () { return self.showdown(); }); }
        self.dealStreet(next);
        self.emit('street', next);
        self.emit('state');
        return self.pause(850).then(function () { return loop(next); });
      });
    }.bind(null, 'preflop'));
  };

  Table.prototype.runout = function () {
    var self = this;
    this.emit('turn', { seat: null });
    while (this.board.length < 5) { this.dealStreet(this.board.length < 3 ? 'flop' : this.board.length < 4 ? 'turn' : 'river'); this.emit('street', this.street); }
    this.emit('state');
    return this.pause(700);
  };

  Table.prototype.runForever = function () {
    var self = this;
    function loop() {
      self.playHand().then(function () {
        return self.pause(2600);
      }).then(loop);
    }
    loop();
  };

  global.NLHTable = Table;
  global.NLHPlayer = Player;
})(window);
