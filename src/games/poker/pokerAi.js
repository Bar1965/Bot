// ─── 🤖 POKER AI AGENT & STRATEGY ENGINE ─────────────────────────
import { evaluate7Cards, HAND_RANKS } from './evaluator.js';

export const BOT_NAMES = [
  { id: 'bot_akbar@ai', name: '🤖 Bot Akbar', personality: 'PRO' },
  { id: 'bot_sultan@ai', name: '🤖 Bot Sultan', personality: 'BLUFFER' },
  { id: 'bot_dealer@ai', name: '🤖 Bot Dealer', personality: 'PASSIVE' },
  { id: 'bot_yann@ai', name: '🤖 Bot Yann', personality: 'CALL_STATION' },
  { id: 'bot_gacor@ai', name: '🤖 Bot Gacor', personality: 'PRO' },
  { id: 'bot_botak@ai', name: '🤖 Bot Botak', personality: 'BLUFFER' },
  { id: 'bot_santai@ai', name: '🤖 Bot Santai', personality: 'PASSIVE' }
];

export function isAiPlayer(jid) {
  return String(jid).endsWith('@ai');
}

/**
 * Evaluasi kekuatan 2 kartu tangan Preflop
 * @returns {number} 0..100
 */
function scorePreflopHand(holeCards) {
  if (!holeCards || holeCards.length !== 2) return 0;
  const [c1, c2] = holeCards;
  const r1 = Math.max(c1.rank, c2.rank);
  const r2 = Math.min(c1.rank, c2.rank);
  const isPair = r1 === r2;
  const isSuited = c1.suit === c2.suit;
  const gap = r1 - r2;

  let score = 0;

  if (isPair) {
    // Pocket pairs: 22 (score 50) s/d AA (score 95)
    score = 50 + (r1 - 2) * 3.5;
  } else {
    // High cards: A=14, K=13, Q=12, J=11
    score = r1 * 2.5 + r2 * 1.5;
    if (isSuited) score += 10;
    if (gap === 1) score += 5; // Connected (e.g. 9-10)
    else if (gap === 2) score += 3; // 1-gapper
  }

  return Math.min(100, Math.max(0, score));
}

/**
 * Keputusan AI di fase Preflop
 */
export function decidePreflopAction(holeCards, currentBet, playerBet, pot, minRaise, personality = 'PRO') {
  const toCall = currentBet - playerBet;
  const handScore = scorePreflopHand(holeCards);
  const rand = Math.random();

  // 1. Bluffer Personality
  if (personality === 'BLUFFER') {
    if (rand < 0.25 && handScore >= 30) {
      return { action: 'RAISE', amount: minRaise };
    }
  }

  // 2. High Tier Cards (AA, KK, QQ, AK suited) -> handScore >= 75
  if (handScore >= 75) {
    if (rand < 0.65) {
      return { action: 'RAISE', amount: minRaise };
    }
    return { action: toCall > 0 ? 'CALL' : 'CHECK', amount: 0 };
  }

  // 3. Medium Tier Cards (JJ, TT, AQ, AJ, KQ, medium pairs) -> handScore >= 50
  if (handScore >= 50) {
    if (toCall <= minRaise * 2) {
      if (rand < 0.25 && toCall === 0) return { action: 'RAISE', amount: minRaise };
      return { action: toCall > 0 ? 'CALL' : 'CHECK', amount: 0 };
    }
    // Jika taruhan lawan terlalu besar
    if (personality === 'CALL_STATION' && rand < 0.7) {
      return { action: 'CALL', amount: 0 };
    }
    return rand < 0.4 ? { action: 'CALL', amount: 0 } : { action: 'FOLD', amount: 0 };
  }

  // 4. Low / Trash Cards -> handScore < 50
  if (toCall === 0) {
    return { action: 'CHECK', amount: 0 };
  }

  // Jika perlu bayar (toCall > 0)
  if (toCall <= Math.floor(minRaise * 0.5) && rand < 0.5) {
    return { action: 'CALL', amount: 0 };
  }

  // Bluffer sesekali pura-pura gertak
  if (personality === 'BLUFFER' && rand < 0.15) {
    return { action: 'RAISE', amount: minRaise };
  }

  return { action: 'FOLD', amount: 0 };
}

/**
 * Keputusan AI di fase Postflop (Flop, Turn, River)
 */
export function decidePostflopAction(holeCards, communityCards, currentBet, playerBet, pot, minRaise, roundPhase, personality = 'PRO') {
  const toCall = currentBet - playerBet;
  const allCards = [...holeCards, ...communityCards];
  const evaluated = evaluate7Cards(allCards);
  const handRank = evaluated.rank;
  const rand = Math.random();

  // Monster Hand: Full House, Four of a Kind, Straight Flush, Royal Flush (Rank >= 6)
  if (handRank >= HAND_RANKS.FULL_HOUSE) {
    if (rand < 0.35 && roundPhase === 'RIVER') {
      return { action: 'ALLIN', amount: 0 };
    }
    if (rand < 0.7) {
      return { action: 'RAISE', amount: minRaise * 2 };
    }
    return { action: toCall > 0 ? 'CALL' : 'CHECK', amount: 0 };
  }

  // Strong Hand: Straight, Flush, Three of a Kind (Rank 3..5)
  if (handRank >= HAND_RANKS.THREE_OF_A_KIND) {
    if (rand < 0.55) {
      return { action: 'RAISE', amount: minRaise };
    }
    return { action: toCall > 0 ? 'CALL' : 'CHECK', amount: 0 };
  }

  // Medium Hand: Two Pair, Strong One Pair (Rank 1..2)
  if (handRank >= HAND_RANKS.ONE_PAIR) {
    if (toCall === 0) {
      if (handRank === HAND_RANKS.TWO_PAIR && rand < 0.4) {
        return { action: 'RAISE', amount: minRaise };
      }
      return { action: 'CHECK', amount: 0 };
    }

    if (toCall <= minRaise * 2) {
      return { action: 'CALL', amount: 0 };
    }

    if (personality === 'CALL_STATION' || (personality === 'BLUFFER' && rand < 0.3)) {
      return { action: 'CALL', amount: 0 };
    }

    return rand < 0.45 ? { action: 'CALL', amount: 0 } : { action: 'FOLD', amount: 0 };
  }

  // Weak Hand: High Card (Rank 0)
  if (toCall === 0) {
    // Jika tidak perlu bayar, cek gratis
    if (personality === 'BLUFFER' && rand < 0.25) {
      return { action: 'RAISE', amount: minRaise };
    }
    return { action: 'CHECK', amount: 0 };
  }

  // Ada taruhan lawan dan kartu AI cuma High Card
  if (personality === 'BLUFFER' && rand < 0.15) {
    return { action: 'RAISE', amount: minRaise };
  }

  if (personality === 'CALL_STATION' && toCall <= minRaise && rand < 0.3) {
    return { action: 'CALL', amount: 0 };
  }

  return { action: 'FOLD', amount: 0 };
}
