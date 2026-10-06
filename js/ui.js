/* =========================================================
   UI: отрисовка стола, панель действий, оверлеи, горячие клавиши
   ========================================================= */
(function (global) {
  'use strict';

  var Eval = global.NLHEval, Deck = global.NLHDeck, Table = global.NLHTable, Player = global.NLHPlayer, AI = global.NLHAI;

  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
  var fmtPot = function (n) {
    n = Math.round(n || 0);
    if (n >= 100000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return fmt(n);
  };

  var SB = 1000, BB = 2000, ANTE = 1000, START = 50000, REBUY = 50000;

  /* Флаги рисуем градиентами: эмодзи-флаги в Windows не отображаются */
  var FLAGS = {
    us: 'linear-gradient(#b22234 0 33%, #ffffff 33% 66%, #3c3b6e 66% 100%)',
    ua: 'linear-gradient(#0057b7 0 50%, #ffd700 50% 100%)',
    br: 'linear-gradient(#009c3b 0 33%, #ffdf00 33% 66%, #002776 66% 100%)',
    it: 'linear-gradient(90deg, #008c45 0 33%, #f4f5f0 33% 66%, #cd212a 66% 100%)',
    es: 'linear-gradient(#aa151b 0 25%, #f1bf00 25% 75%, #aa151b 75% 100%)',
    de: 'linear-gradient(#000 0 33%, #dd0000 33% 66%, #ffce00 66% 100%)'
  };
  function flagHtml(code) {
    if (!code || !FLAGS[code]) return '';
    return '<i class="flag" style="background:' + FLAGS[code] + '"></i>';
  }

  /* ------------------------------ Фишки ------------------------------ */
  // Палитра номиналов: тело / тёмные полосы торца / широкий вкладыш торца /
  // узкие вспышки торца. Тело — насыщенный цвет средней светлоты: на 16 px
  // тёмное тело сливается в бурое пятно, а слишком светлое теряет объём.
  // ca — вспышка торца, у каждого номинала своя, иначе зелёная фишка
  // получает красные зубцы от красной.
  var CHIP_COLORS = [
    { c: '#fb3524', cd: '#93172b', cw: '#ad91a5', ca: '#d1433f' }, // красный
    { c: '#2aa863', cd: '#0b5230', cw: '#8fa08f', ca: '#35c47a' }, // зелёный
    { c: '#2f5fb8', cd: '#14306b', cw: '#8c93a8', ca: '#3f7bd8' }, // синий
    { c: '#3a3f4d', cd: '#14161c', cw: '#7c7a86', ca: '#565e70' }, // чёрный
    { c: '#f0b62a', cd: '#7d5406', cw: '#b3a189', ca: '#ffc94d' }  // жёлтый
  ];
  var CHIP_BTN = { c: '#f4f2ea', cd: '#b6b2a2', cw: '#cfcabb', ca: '#ddd8c8' };

  // Цветовые переменные фишки: cw и ca — вкладыш и вспышка торца, у
  // каждого номинала свои (см. палитру выше)
  function chipOne(i, s, label) {
    return '<i class="ichip" style="--i:' + i + ';--c:' + s.c +
      ';--cd:' + s.cd + (s.cw ? ';--cw:' + s.cw : '') + (s.ca ? ';--ca:' + s.ca : '') + '">' +
      '<i class="side"></i><i class="face">' + (label ? '<b>' + label + '</b>' : '') + '</i></i>';
  }
  // Стопка из n фишек: чем больше сумма, тем выше стопка
  function pileHtml(n, size, from, label, style) {
    n = Math.max(1, Math.min(5, n | 0));
    var h = '<span class="pile ' + size + (style && style.cls ? ' ' + style.cls : '') +
      '" style="--n:' + n + '">';
    for (var i = 1; i <= n; i++) {
      h += chipOne(i, label ? CHIP_BTN : CHIP_COLORS[(from + i - 1) % CHIP_COLORS.length], label);
    }
    return h + '</span>';
  }
  var betChips = function (bet) { return Math.max(1, Math.min(3, 1 + Math.floor(bet / 7000))); };

  // Все садятся за стол с одинаковым банкроллом — как в референсе (50,000).
  // styleIdx задаёт тип бота (см. PERSONALITIES в js/ai.js):
  //   0 — агрессивный, 1 — осторожный, 2 — сбалансированный.
  var ROSTER = [
    { name: 'pp1398842', flag: 'us', avatar: '\u{1F464}', stack: START, isHero: true, styleIdx: 0 },
    { seatEmpty: true },
    { name: 'pica27', flag: 'ua', avatar: '\u{1F451}', stack: START, styleIdx: 1 },
    { name: 'foi em...', flag: 'br', avatar: '\u{270C}', stack: START, styleIdx: 2 },
    { name: 'Gabol ...', flag: 'it', avatar: '\u{1F3A9}', stack: START, styleIdx: 0 },
    { seatEmpty: true }
  ];

  var TAG_TEXT = { fold: 'Фолд', check: 'Чек', call: 'Колл', raise: 'Рейз', bet: 'Бет', allin: 'Олл-ин', sb: 'МБ', bb: 'ББ' };
  var TAG_CLASS = { fold: 'tg-fold', check: 'tg-check', call: 'tg-call', raise: 'tg-raise', bet: 'tg-raise', allin: 'tg-allin', sb: 'tg-sb', bb: 'tg-bb' };
  // Подпись характера бота (или «Вы» для героя) — первой строкой в табличке.
  var KIND_CLASS = { aggressive: 'kd-aggro', cautious: 'kd-careful', balanced: 'kd-balance' };
  function kindHtml(p) {
    if (!p || p.seatEmpty) return '';
    if (p.isHero) return '<i class="kind kd-hero">Вы</i>';
    var pers = AI.personalityOf(p.styleIdx);
    return '<i class="kind ' + (KIND_CLASS[pers.key] || '') + '" title="Тип бота: ' +
      pers.name + '">' + pers.name + '</i>';
  }
  var HAND_NAMES = ['Старшая карта', 'Пара', 'Две пары', 'Сет', 'Стрит', 'Флеш', 'Фулл-хаус', 'Каре', 'Стрит-флеш'];

  var table, turnSeat = null, raiseOpen = false, autoMode = false, timerId = null, timerLeft = 0, TURN_TIME = 10;
  // индикатор хода состоит из двух фаз по 5 секунд:
  //   1) дуга «протирается» по часовой стрелке от зелёного до красного;
  //   2) дуги уже нет — красный круг пульсирует раз в секунду, 5 ударов.
  var RING_CYCLE = 5000;    // фаза 1: протирание дуги
  var PULSE_CYCLE = 1000;   // один удар пульса — ровно секунда
  var PULSE_COUNT = 5;      // фаза 2: 5 ударов = 5 секунд
  var PULSE_DELAY = RING_CYCLE;   // пульс стартует ровно после дуги
  var thinkMs = 0;   // сколько бот думает в этом ходу (для инфо, если понадобится)
  var pendingNew = false, running = false, toastId = null;

  /* ------------------------------ Звук ------------------------------ */
  var actx = null, soundOn = true;
  function beep(freq, dur, type) {
    if (!soundOn) return;
    try {
      if (!actx) actx = new (global.AudioContext || global.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.05, actx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + (dur || 0.12));
      o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + (dur || 0.12) + 0.02);
    } catch (e) { /* звук недоступен */ }
  }

  /* ------------------------------ Инициализация ------------------------------ */
  function init() {
    var players = ROSTER.map(function (cfg, i) {
      var p = new Player({
        id: i, seat: i, name: cfg.name || 'Пусто', isHero: cfg.isHero,
        avatar: cfg.avatar || '', flag: cfg.flag || '', stack: cfg.stack || 0,
        styleIdx: cfg.styleIdx || 0, seatEmpty: !!cfg.seatEmpty
      });
      return p;
    });

    table = new Table({
      players: players, sb: SB, bb: BB, ante: ANTE,
      tableId: '261003185944-12769199-0000272' + (1 + Math.floor(Math.random() * 8)) + '-1'
    });

    $('tableId').textContent = 'ID: ' + table.tableId;
    $('blindsInfo').innerHTML = 'Блайнды: ' + fmt(SB) + '/' + fmt(BB) + ' &nbsp;ante: ' + fmt(ANTE);
    buildSeats();
    wire();
    hook();
    render();
    running = true;
    table.runForever();
  }

  function buildSeats() {
    var wrap = $('seats');
    wrap.innerHTML = '';
    table.players.forEach(function (p) {
      var el = document.createElement('div');
      el.className = 'seat seat-' + p.seat;
      el.dataset.seat = p.seat;
      wrap.appendChild(el);
      p.el = el;
    });
  }

  /* ------------------------------ Рендер ------------------------------ */
  function render() {
    table.players.forEach(function (p) { renderSeat(p); });
    renderBoard();
    var total = table.potTotal();
    var street = 0;
    table.players.forEach(function (p) { street += (p.bet || 0); });
    var shown = Math.max(0, total - street);
    $('potWrap').hidden = shown <= 0;
    $('potAmount').textContent = fmtPot(shown);
    renderPot(shown);
    $('bankAmount').textContent = fmtPot(total);
    var h = table.hero();
    if (h && h.stack < BB * 4 && h.state !== 'out') {
      h.stack += REBUY;
      toast('Докупка фишек: +' + fmt(REBUY));
    }
  }

  // Банк: стопка растёт вместе с суммой, пересобираем только при изменении
  var lastPot = -1;
  function renderPot(shown) {
    var box = $('potChips');
    if (!box) return;
    var n = Math.max(2, Math.min(5, 2 + Math.floor(shown / 9000)));
    if (shown === lastPot && box.childElementCount === n) return;
    var changed = shown !== lastPot;
    lastPot = shown;
    box.style.setProperty('--n', n);
    box.className = 'pile pile--md' + (changed ? ' drop' : '');
    box.innerHTML = '';
    for (var i = 1; i <= n; i++) box.innerHTML += chipOne(i, CHIP_COLORS[(n - i) % CHIP_COLORS.length]);
  }

  function renderSeat(p) {
    var el = p.el;
    if (!el) return;
    var cls = ['seat', 'seat-' + p.seat];
    if (p.state === 'folded') cls.push('folded');
    var onTurn = turnSeat === p.seat && running;
    if (onTurn) cls.push('is-turn');
    el.className = cls.join(' ');
    el.innerHTML = '';
    if (p.seatEmpty) {
      el.innerHTML = '<div class="empty-plate">Empty</div>';
      return;
    }
    if (p.state === 'out' && p.stack === 0 && !p.isHero) {
      el.innerHTML = '<div class="meta"><div class="avatar out"></div><div class="plate"><div class="name">Вышел</div><div class="stack">0</div></div></div>';
      return;
    }

    // карты
    var cd = document.createElement('div');
    cd.className = 'cards seat-cards';
    if (p.cards.length) {
      for (var i = 0; i < p.cards.length; i++) {
        cd.innerHTML += (p.hole || p.isHero) ? Deck.face(p.cards[i]) : Deck.back();
      }
    }
    el.appendChild(cd);

    // тэг силы руки героя (после флопа)
    if (p.isHero && p.cards.length === 2 && table.board.length >= 3) {
      try {
        var best = Eval.evaluate(p.cards.concat(table.board));
        if (best) {
          var ht = document.createElement('div');
          ht.className = 'hand-tag';
          ht.textContent = HAND_NAMES[best.cat] || best.name;
          cd.appendChild(ht);
        }
      } catch (e) { /* не критично */ }
    }

    // аватар + табличка
    var meta = document.createElement('div');
    meta.className = 'meta';
    var av = document.createElement('div');
    av.className = 'avatar' + (p.state === 'folded' || p.state === 'out' ? ' out' : '');
    av.textContent = p.avatar || p.name.charAt(0);
    // индикатор хода вокруг аватара: 5 с дуга по часовой (зелёный → красный),
    // затем 5 с красный круг пульсирует раз в секунду
    if (onTurn) {
      var ring = document.createElement('i');
      ring.className = 'ring';
      ring.innerHTML =
        '<svg viewBox="0 0 100 100" aria-hidden="true">' +
          '<circle class="trk" cx="50" cy="50" r="45" pathLength="100"></circle>' +
          '<circle class="bar" cx="50" cy="50" r="45" pathLength="100"></circle>' +
          '<circle class="pul" cx="50" cy="50" r="45" pathLength="100"></circle>' +
        '</svg>';
      ring.style.setProperty('--ring-dur', RING_CYCLE + 'ms');
      ring.style.setProperty('--pulse-dur', PULSE_CYCLE + 'ms');
      ring.style.setProperty('--pulse-delay', PULSE_DELAY + 'ms');
      ring.style.setProperty('--pulse-count', String(PULSE_COUNT));
      av.appendChild(ring);
    }
    meta.appendChild(av);

    var plate = document.createElement('div');
    plate.className = 'plate';
    plate.innerHTML = kindHtml(p) +
      '<div class="name">' + flagHtml(p.flag) + short(p.name) + '</div>' +
      '<div class="stack">' + fmt(p.stack) + '</div>';
    meta.appendChild(plate);
    el.appendChild(meta);

    // фишка кнопки дилера — изометрический чип с буквой D
    if (table.button === p.seat && running) {
      var b = document.createElement('div');
      b.className = 'btn-d pile pile--sm';
      b.style.setProperty('--n', 1);
      b.innerHTML = chipOne(1, CHIP_BTN, 'D');
      el.appendChild(b);
    }

    // подпись последнего действия
    if (p.lastAction && TAG_TEXT[p.lastAction]) {
      var t = document.createElement('div');
      t.className = 'act-tag ' + (TAG_CLASS[p.lastAction] || '');
      t.textContent = TAG_TEXT[p.lastAction];
      if (p.lastAction === 'sb' || p.lastAction === 'bb') t.className += ' tg-check';
      el.appendChild(t);
    }

    // ставка на столе — стопка фишек + сумма
    if (p.bet > 0) {
      var bet = document.createElement('div');
      bet.className = 'bet';
      var key = String(p.bet);
      var grew = el.dataset.bet !== key;
      el.dataset.bet = key;
      bet.innerHTML = pileHtml(betChips(p.bet), 'pile--sm', p.seat, null, grew ? { cls: 'drop' } : null);
      bet.innerHTML += '<span>' + fmt(p.bet) + '</span>';
      el.appendChild(bet);
    } else {
      el.dataset.bet = '0';
    }
  }

  function short(n) {
    return n.length > 6 ? n.slice(0, 5) + '…' : n;
  }

  function renderBoard() {
    var b = $('board');
    b.innerHTML = '';
    for (var i = 0; i < table.board.length; i++) {
      var el = document.createElement('div');
      el.innerHTML = Deck.face(table.board[i]);
      var node = el.firstChild;
      node.classList.add('place');
      node.style.animationDelay = (i * 60) + 'ms';
      b.appendChild(node);
    }
  }

  /* ------------------------------ Игровые события ------------------------------ */
  function hook() {
    table.on('state', function () { render(); });
    table.on('message', function (m) { toast(m); });
    table.on('street', function (s) { beep(520 + s.length * 40, 0.09, 'triangle'); render(); });
    table.on('bet', function (e) { if (e.amount > 0) beep(180, 0.05, 'square'); });

    table.on('turn', function (p) { turnSeat = p.seat; render(); });
    table.on('think', function (d) { thinkMs = d.ms; });   // рендер придёт следом от 'turn'

    table.on('hero-turn', function (ctx) {
      turnSeat = p_seat();
      showActionBar(ctx);
      render();
      beep(880, 0.07, 'sine');
      startTimer(ctx);
    });

    table.on('hero-turn-end', function () {
      hideActionBar();
      render();
    });

    table.on('pot-win', function (e) {
      var h = table.hero();
      var txt = '+' + fmt(e.amount);
      showWin(short(e.player.name) + '  ' + txt, e.hand || 'все вышли');
      beep(e.player.isHero ? 980 : 420, 0.18, 'sine');
    });

    table.on('hand-end', function () {
      stopTimer();
      turnSeat = null;
      render();
      setTimeout(function () { if (pendingNew) { pendingNew = false; } }, 10);
    });

    table.on('idle', function () {
      running = false;
      showWin('Соперников не осталось', 'нажмите «Новая раздача»');
      render();
    });
  }

  function p_seat() {
    var h = table.hero();
    return h ? h.seat : -1;
  }

  /* ------------------------------ Панель действий ------------------------------ */
  var ctxSave = null;

  function showActionBar(ctx) {
    ctxSave = ctx;
    var bar = $('actionbar');
    bar.hidden = false;
    raiseOpen = false;
    $('raiseRow').classList.remove('show');
    $('btnRaise').querySelector('span').textContent = 'Рейз';
    var callBtn = $('btnCall');
    if (ctx.toCall === 0) {
      callBtn.querySelector('span').textContent = 'Чек';
    } else if (ctx.toCall >= ctx.player.stack) {
      callBtn.querySelector('span').textContent = 'Колл все';
    } else {
      callBtn.querySelector('span').textContent = 'Колл ' + fmt(ctx.toCall);
    }
    $('actTurn').textContent = streetName(ctx.street) + ' · ваш ход';
    $('btnFold').disabled = false;
    // лимиты рейза
    var hero = table.hero();
    var minTotal = hero.bet + Math.max(ctx.minRaise, ctx.toCall || ctx.minRaise);
    var maxTotal = hero.bet + hero.stack;
    var sl = $('raiseSlider');
    sl.min = minTotal; sl.max = maxTotal; sl.step = Math.max(100, Math.floor(BB / 2));
    sl.value = Math.min(maxTotal, Math.max(minTotal, minTotal + ctx.pot));
    $('raiseMin').textContent = fmt(minTotal);
    $('raiseMax').textContent = fmt(maxTotal);
    $('raiseTo').textContent = fmt(+sl.value);
    updateRaiseLabel(+sl.value);
    updateCallLabel(+sl.value);
  }

  function updateRaiseLabel(v) {
    $('btnRaise').querySelector('span').textContent = raiseOpen ? 'Рейз ' + fmt(v) : 'Рейз';
  }

  function updateCallLabel(v) {
    var ctx = ctxSave; if (!ctx) return;
    var hero = table.hero();
    var callBtn = $('btnCall');
    var span = callBtn.querySelector('span');
    if (ctx.toCall === 0) { span.textContent = 'Чек'; return; }
    if (ctx.toCall >= hero.stack) { span.textContent = 'Колл все'; return; }
    var extra = (raiseOpen && typeof v === 'number') ? Math.max(0, v - hero.bet - ctx.toCall) : 0;
    span.textContent = 'Колл ' + fmt(ctx.toCall + extra);
  }

  function hideActionBar() {
    $('actionbar').hidden = true;
    ctxSave = null;
    stopTimer();
  }

  function streetName(s) {
    return { preflop: 'Префлоп', flop: 'Флоп', turn: 'Тёрн', river: 'Ривер', showdown: 'Шоудаун' }[s] || s;
  }

  function submit(type, amount) {
    stopTimer();
    table.submitHeroAction({ type: type, amount: amount });
    beep(type === 'fold' ? 160 : type === 'raise' ? 660 : 480, 0.09, 'square');
  }

  /* ------------------------------ Таймер хода ------------------------------ */
  function startTimer(ctx) {
    stopTimer();
    timerLeft = TURN_TIME;
    if (autoMode) { timerLeft = 1.2; }
    tick();
    timerId = setInterval(tick, 100);
    function tick() {
      var chip = $('turnChip');
      if (chip) {
        chip.hidden = false;
        $('turnSec').textContent = Math.ceil(Math.max(0.1, timerLeft));
      }
      timerLeft -= 0.1;
      if (timerLeft <= 0) {
        stopTimer();
        // авто-действие: чек/колл, иначе фолд
        var raiseWas = raiseOpen;
        if (raiseWas && autoMode) submit('raise', +$('raiseSlider').value);
        else if (ctx.toCall === 0) submit('check');
        else submit('call');
      }
    }
  }
  function stopTimer() {
    if (timerId) { clearInterval(timerId); timerId = null; }
    var chip = $('turnChip');
    if (chip) chip.hidden = true;
  }

  /* ------------------------------ Оверлеи ------------------------------ */
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    if (toastId) clearTimeout(toastId);
    toastId = setTimeout(function () { t.hidden = true; }, 1600);
  }

  function showWin(text, sub) {
    var b = $('winBanner');
    $('winText').textContent = text;
    $('winHand').textContent = sub || '';
    b.hidden = false;
    clearTimeout(b._t);
    b._t = setTimeout(function () { b.hidden = true; }, 2800);
  }

  function modal(title, html) {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = html;
    $('modal').hidden = false;
  }
  function closeModal() { $('modal').hidden = true; }

  /* ------------------------------ События интерфейса ------------------------------ */
  function wire() {
    $('btnFold').onclick = function () { submit('fold'); };
    $('btnCall').onclick = function () {
      var ctx = ctxSave; if (!ctx) return;
      submit(ctx.toCall === 0 ? 'check' : 'call');
    };
    $('btnRaise').onclick = function () {
      if (!raiseOpen) {
        raiseOpen = true;
        $('raiseRow').classList.add('show');
        updateRaiseLabel(+$('raiseSlider').value);
        beep(700, 0.05, 'sine');
      } else {
        submit('raise', +$('raiseSlider').value);
      }
    };

    var sl = $('raiseSlider');
    sl.oninput = function () {
      $('raiseTo').textContent = fmt(+sl.value);
      updateRaiseLabel(+sl.value);
      updateCallLabel(+sl.value);
    };

    document.querySelectorAll('.chip').forEach(function (ch) {
      ch.onclick = function () {
        var ctx = ctxSave; if (!ctx) return;
        var frac = parseFloat(ch.dataset.frac);
        var hero = table.hero();
        var minTotal = hero.bet + Math.max(ctx.minRaise, ctx.toCall || ctx.minRaise);
        var maxTotal = hero.bet + hero.stack;
        var v = frac >= 999 ? maxTotal : Math.round(ctx.toCall + table.currentBet + frac * ctx.pot);
        v = Math.max(minTotal, Math.min(maxTotal, v));
        sl.value = v;
        $('raiseTo').textContent = fmt(v);
        updateRaiseLabel(v);
        updateCallLabel(v);
      };
    });

    $('btnAuto').onclick = function () {
      autoMode = !autoMode;
      this.classList.toggle('on', autoMode);
      toast(autoMode ? 'AUTO: чек/колл' : 'AUTO выкл');
      if (autoMode && ctxSave) { startTimer(ctxSave); }
    };

    $('btnNewGame').onclick = function () {
      if (!running) { running = true; table.runForever(); toast('Новая раздача'); }
      else pendingNew = true;
      toast('Следующая раздача начнётся автоматически');
    };

    $('btnInfo').onclick = function () {
      modal('Правила стола',
        '<ul>' +
        '<li>Блайнды: <b>' + fmt(SB) + ' / ' + fmt(BB) + '</b>, анте <b>' + fmt(ANTE) + '</b> с каждого.</li>' +
        '<li>Формат — No-Limit Hold\'em, 5 общих карт, лучшая комбинация из 7.</li>' +
        '<li>Побеждает старшая комбинация; при равенстве банк делится поровну.</li>' +
        '<li>Незакрытая ставка возвращается игроку.</li>' +
        '</ul>' +
        '<p><b>Клавиши:</b> <kbd>F</kbd> фолд · <kbd>C</kbd> чек/колл · <kbd>R</kbd> рейз · ' +
        '<kbd>←</kbd><kbd>→</kbd> размер · <kbd>Enter</kbd> подтвердить</p>');
    };

    $('btnHistory').onclick = function () {
      var h = table.history;
      var body = h.length ? '<table><tr><th>Раздача</th><th>Доска</th><th>Победители</th></tr>' +
        h.map(function (r) {
          return '<tr><td>#' + r.hand + '</td><td class="dim">' + r.board.map(cardTxt).join(' ') + '</td>' +
            '<td class="win">' + r.winners.filter(function (w) { return w.won > 0; })
              .map(function (w) { return short(w.name) + ' +' + fmt(w.won); }).join(', ') + '</td></tr>';
        }).join('') + '</table>' : '<p class="dim">Пока пусто — сыграйте первую раздачу.</p>';
      modal('История раздач', body);
    };

    $('btnStats').onclick = $('btnHistory').onclick;
    $('btnSettings').onclick = function () {
      var h = table.hero();
      modal('Настройки',
        '<p><b>Игрок:</b> ' + h.name + ' ' + flagHtml(h.flag) + '</p>' +
        '<p><b>Фишки:</b> ' + fmt(h.stack) + '</p>' +
        '<p><b>Звук:</b> ' + (soundOn ? 'вкл' : 'выкл') + ' · <b>Авто-действие:</b> ' + (autoMode ? 'вкл' : 'выкл') + '</p>' +
        '<h4>Типы соперников</h4>' + botTypesHtml() +
        '<p class="dim">Чтобы занять пустое место, нажмите на метку «Empty» за столом.</p>');
    };

    $('btnChat').onclick = function () {
      modal('Чат',
        '<p><b>pica27:</b> gg</p>' +
        '<p><b>Gabol ...</b> удачи!</p>' +
        '<p><b>Диана:</b> удачной игры &#127903;</p>');
    };

    $('btnTips').onclick = function () {
      modal('FREE TIPS',
        '<ul><li>Не играй 3-бет с одной картой.</li><li>Смотри на текстуру: на мокрой доске реже плати.</li>' +
        '<li>Опозиция важнее карт: поздняя позиция — больше ставок.</li></ul>');
    };
    $('btnLucky').onclick = function () { modal('Lucky Draw', '<p class="dim">Колесо фортуны появится в следующей версии.</p>'); };
    $('btnNext').onclick = function () { $('btnNewGame').onclick(); };
    $('btnMenu').onclick = function () {
      modal('Меню',
        '<p><b>NLH Poker v1.0</b></p>' +
        '<p class="dim">Клон No-Limit Hold\'em клиента. Все фишки вымышленные.</p>' +
        '<h4>Соперники</h4>' + botTypesHtml() +
        '<p>Подсказка: пустое место за столом можно занять — нажмите на него.</p>');
    };
    $('btnSound').onclick = function () {
      soundOn = !soundOn;
      this.classList.toggle('muted', !soundOn);
      if (soundOn) beep(880, 0.08);
    };
    $('btnClose').onclick = function () { modal('Выход', '<p class="dim">Спасибо за игру! Закройте вкладку браузера.</p>'); };
    $('btnMin').onclick = function () { toast('Свернуть окно'); };
    $('btnMax').onclick = function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    };
    $('modalClose').onclick = closeModal;
    $('modal').onclick = function (e) { if (e.target === this) closeModal(); };

    // горячие клавиши
    document.addEventListener('keydown', function (e) {
      if (!ctxSave) return;
      var k = e.key.toLowerCase();
      if (k === 'f') { submit('fold'); e.preventDefault(); }
      else if (k === 'c') { $('btnCall').click(); e.preventDefault(); }
      else if (k === 'r') { $('btnRaise').click(); e.preventDefault(); }
      else if (k === 'enter') { if (raiseOpen) submit('raise', +$('raiseSlider').value); else $('btnCall').click(); e.preventDefault(); }
      else if (k === 'arrowleft' || k === 'arrowright') {
        var sl = $('raiseSlider');
        var d = (k === 'arrowleft' ? -1 : 1) * (+sl.step || BB / 2) * 4;
        sl.value = Math.max(+sl.min, Math.min(+sl.max, +sl.value + d));
        $('raiseTo').textContent = fmt(+sl.value);
        updateRaiseLabel(+sl.value);
        updateCallLabel(+sl.value);
        e.preventDefault();
      }
    });

    // занятие пустого места
    $('seats').addEventListener('click', function (e) {
      var seatEl = e.target.closest ? e.target.closest('.seat') : null;
      if (!seatEl) return;
      var p = table.players[+seatEl.dataset.seat];
      if (p && p.seatEmpty && p.stack === 0) {
        p.seatEmpty = false;
        p.name = 'Вы'; p.flag = ''; p.avatar = '\u{1F464}';
        p.stack = START; p.state = 'active';
        toast('Вы заняли свободное место');
        render();
      }
    });
  }

  /* Справка по трём типам ботов — общая для «Настроек» и «Меню» */
  var BOT_NOTES = {
    aggressive: 'много рейзов и блефов, широко входит в банк, ставит крупно',
    cautious:   'играет только сильные руки, почти не блефует, отвечает мелко',
    balanced:   'тайтово-агрессивно: ставки по силе руки и позиции'
  };
  function botTypesHtml() {
    return '<ul>' + AI.PERSONALITIES.map(function (t) {
      var cls = KIND_CLASS[t.key] || '';
      return '<li><i class="kind ' + cls + '" style="display:inline">' + t.name + '</i> — ' +
        (BOT_NOTES[t.key] || '') + '</li>';
    }).join('') + '</ul>';
  }

  function cardTxt(c) {
    var r = +String(c).slice(0, -1);
    var s = String(c).slice(-1);
    var R = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T' };
    var S = { s: '♠', h: '♥', d: '♦', c: '♣' };
    var t = (R[r] || r) + S[s];
    return '<span style="color:' + (s === 'h' || s === 'd' ? '#e01c31' : '#dfe9e6') + '">' + t + '</span>';
  }

  /* ------------------------------ Старт ------------------------------ */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.NLHUI = { get table() { return table; } };
})(window);
