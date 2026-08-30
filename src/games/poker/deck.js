// ─── 🃏 DECK & CARD FORMATTER MODULE ──────────────────────────────
export const SUITS = [
  { key: 's', symbol: '♠', name: 'Sekop', color: 'black', rankOrder: 4 },
  { key: 'h', symbol: '♥', name: 'Hati', color: 'red', rankOrder: 3 },
  { key: 'c', symbol: '♣', name: 'Keriting', color: 'black', rankOrder: 2 },
  { key: 'd', symbol: '♦', name: 'Wajik', color: 'red', rankOrder: 1 }
];

export const SUIT_MAP = {
  s: { symbol: '♠', name: 'Sekop' },
  h: { symbol: '♥', name: 'Hati' },
  c: { symbol: '♣', name: 'Keriting' },
  d: { symbol: '♦', name: 'Wajik' }
};

export const RANK_NAMES = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A'
};

export const FULL_RANK_NAMES = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace'
};

/**
 * Membuat satu set 52 kartu standar
 * Setiap kartu: { rank: 2..14, suit: 's'|'h'|'c'|'d', label: 'A♠' }
 */
export function createDeck() {
  const deck = [];
  for (const rank of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
    for (const suit of ['s', 'h', 'c', 'd']) {
      const symbol = SUIT_MAP[suit].symbol;
      const rankLabel = RANK_NAMES[rank];
      deck.push({
        rank,
        suit,
        label: `${rankLabel}${symbol}`,
        id: `${rankLabel}${suit}`
      });
    }
  }
  return deck;
}

/**
 * Mengocok deck kartu menggunakan algoritma Fisher-Yates
 */
export function shuffleDeck(deck) {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Format satu kartu untuk tampilan chat WhatsApp
 */
export function formatCard(card) {
  if (!card) return '[ 🂠 ? ]';
  return `[ *${card.label}* ]`;
}

/**
 * Format sebaris kartu (misal Flop/Turn/River atau Hole Cards)
 */
export function formatCards(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return '_(Kosong)_';
  return cards.map(c => `[ *${c.label}* ]`).join(' ');
}

/**
 * Format kartu tertutup
 */
export function formatHiddenCards(count = 2) {
  return Array(count).fill('[ 🂠 *??* ]').join(' ');
}
