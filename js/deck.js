/* =========================================================
   Колода и карты
   ========================================================= */
(function (global) {
  'use strict';

  var SUITS = [
    { s: 's', sym: '♠', color: 'black', name: 'пики' },
    { s: 'h', sym: '♥', color: 'red', name: 'черви' },
    { s: 'd', sym: '♦', color: 'red', name: 'бубны' },
    { s: 'c', sym: '♣', color: 'black', name: 'трефы' }
  ];
  var RANKS = [
    { r: 14, sym: 'A', name: 'туз' },
    { r: 13, sym: 'K', name: 'король' },
    { r: 12, sym: 'Q', name: 'дама' },
    { r: 11, sym: 'J', name: 'валет' },
    { r: 10, sym: '10', name: 'десятка' },
    { r: 9, sym: '9', name: 'девятка' },
    { r: 8, sym: '8', name: 'восемьёрка' },
    { r: 7, sym: '7', name: 'семёрка' },
    { r: 6, sym: '6', name: 'шестёрка' },
    { r: 5, sym: '5', name: 'пятёрка' },
    { r: 4, sym: '4', name: 'четвёрка' },
    { r: 3, sym: '3', name: 'тройка' },
    { r: 2, sym: '2', name: 'двойка' }
  ];

  function create() {
    var deck = [];
    for (var i = 0; i < SUITS.length; i++) {
      for (var j = 0; j < RANKS.length; j++) {
        deck.push({ r: RANKS[j].r, s: SUITS[i].s, sym: RANKS[j].sym, suit: SUITS[i].sym, color: SUITS[i].color });
      }
    }
    return shuffle(deck);
  }

  function shuffle(deck) {
    for (var i = deck.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    return deck;
  }

  /** HTML карты: открытая или рубашка.
   *  Лицо как в оригинальном клиенте: маленький индекс (ранг+масть) в левом
   *  верхнем углу и крупная масть в правом нижнем углу карты. */
  function face(card) {
    return '<div class="card ' + card.color + '">' +
      '<span class="r">' + card.sym + '</span>' +
      '<span class="s">' + card.suit + '</span>' +
      '<span class="p">' + card.suit + '</span>' +
      '</div>';
  }
  function back() {
    return '<div class="card back"></div>';
  }
  function key(card) { return card.r + card.s; }

  global.NLHDeck = { create: create, shuffle: shuffle, face: face, back: back, key: key, SUITS: SUITS, RANKS: RANKS };
})(window);
