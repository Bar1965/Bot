// ─── 🏆 POKER & CAPSA HAND EVALUATOR MODULE ───────────────────────
import { FULL_RANK_NAMES } from './deck.js';

export const HAND_RANKS = {
  ROYAL_FLUSH: 9,
  STRAIGHT_FLUSH: 8,
  FOUR_OF_A_KIND: 7,
  FULL_HOUSE: 6,
  FLUSH: 5,
  STRAIGHT: 4,
  THREE_OF_A_KIND: 3,
  TWO_PAIR: 2,
  ONE_PAIR: 1,
  HIGH_CARD: 0
};

export const HAND_NAMES = {
  9: '👑 Royal Flush',
  8: '🔥 Straight Flush',
  7: '💣 Four of a Kind',
  6: '🏠 Full House',
  5: '🌊 Flush',
  4: '⚡ Straight',
  3: '🎯 Three of a Kind',
  2: '👥 Two Pair',
  1: '🤝 One Pair',
  0: '🃏 High Card'
};

/**
 * Evaluasi kombinasi 5 kartu standar
 * @param {Array} cards - 5 kartu [{ rank: 2..14, suit: 's'|'h'|'c'|'d', label }]
 * @returns {Object} { rank, name, score: number[], description }
 */
export function evaluate5Cards(cards) {
  if (!cards || cards.length !== 5) {
    throw new Error('evaluate5Cards butuh tepat 5 kartu!');
  }

  // Urutkan kartu dari rank tertinggi ke terendah
  const sorted = [...cards].sort((a, b) => b.rank - a.rank);
  const ranks = sorted.map(c => c.rank);
  const suits = sorted.map(c => c.suit);

  const isFlush = suits.every(s => s === suits[0]);

  // Cek Straight
  let isStraight = false;
  let straightHigh = 0;

  // Cek straight reguler
  if (
    ranks[0] - ranks[1] === 1 &&
    ranks[1] - ranks[2] === 1 &&
    ranks[2] - ranks[3] === 1 &&
    ranks[3] - ranks[4] === 1
  ) {
    isStraight = true;
    straightHigh = ranks[0];
  } else if (
    ranks[0] === 14 &&
    ranks[1] === 5 &&
    ranks[2] === 4 &&
    ranks[3] === 3 &&
    ranks[4] === 2
  ) {
    // Wheel Straight: A-2-3-4-5 (Ace bernilai 1)
    isStraight = true;
    straightHigh = 5;
  }

  // Hitung frekuensi tiap rank
  const counts = {};
  for (const r of ranks) {
    counts[r] = (counts[r] || 0) + 1;
  }

  // Kelompokkan berdasarkan jumlah kemunculan
  const groups = Object.entries(counts).map(([r, count]) => ({
    rank: Number(r),
    count
  }));
  groups.sort((a, b) => b.count - a.count || b.rank - a.rank);

  // 1. Royal Flush & Straight Flush
  if (isFlush && isStraight) {
    if (straightHigh === 14) {
      return {
        rank: HAND_RANKS.ROYAL_FLUSH,
        name: HAND_NAMES[9],
        score: [9, 14],
        cards: sorted,
        description: 'Royal Flush tertinggi'
      };
    }
    return {
      rank: HAND_RANKS.STRAIGHT_FLUSH,
      name: HAND_NAMES[8],
      score: [8, straightHigh],
      cards: sorted,
      description: `Straight Flush ${FULL_RANK_NAMES[straightHigh]} High`
    };
  }

  // 2. Four of a Kind
  if (groups[0].count === 4) {
    const quadRank = groups[0].rank;
    const kicker = groups[1].rank;
    return {
      rank: HAND_RANKS.FOUR_OF_A_KIND,
      name: HAND_NAMES[7],
      score: [7, quadRank, kicker],
      cards: sorted,
      description: `Four of a Kind (${FULL_RANK_NAMES[quadRank]})`
    };
  }

  // 3. Full House
  if (groups[0].count === 3 && groups[1].count === 2) {
    const tripRank = groups[0].rank;
    const pairRank = groups[1].rank;
    return {
      rank: HAND_RANKS.FULL_HOUSE,
      name: HAND_NAMES[6],
      score: [6, tripRank, pairRank],
      cards: sorted,
      description: `Full House (${FULL_RANK_NAMES[tripRank]} penuh ${FULL_RANK_NAMES[pairRank]})`
    };
  }

  // 4. Flush
  if (isFlush) {
    return {
      rank: HAND_RANKS.FLUSH,
      name: HAND_NAMES[5],
      score: [5, ...ranks],
      cards: sorted,
      description: `Flush ${FULL_RANK_NAMES[ranks[0]]} High`
    };
  }

  // 5. Straight
  if (isStraight) {
    return {
      rank: HAND_RANKS.STRAIGHT,
      name: HAND_NAMES[4],
      score: [4, straightHigh],
      cards: sorted,
      description: `Straight ${FULL_RANK_NAMES[straightHigh]} High`
    };
  }

  // 6. Three of a Kind
  if (groups[0].count === 3) {
    const tripRank = groups[0].rank;
    const kickers = [groups[1].rank, groups[2].rank];
    return {
      rank: HAND_RANKS.THREE_OF_A_KIND,
      name: HAND_NAMES[3],
      score: [3, tripRank, ...kickers],
      cards: sorted,
      description: `Three of a Kind (${FULL_RANK_NAMES[tripRank]})`
    };
  }

  // 7. Two Pair
  if (groups[0].count === 2 && groups[1].count === 2) {
    const highPair = Math.max(groups[0].rank, groups[1].rank);
    const lowPair = Math.min(groups[0].rank, groups[1].rank);
    const kicker = groups[2].rank;
    return {
      rank: HAND_RANKS.TWO_PAIR,
      name: HAND_NAMES[2],
      score: [2, highPair, lowPair, kicker],
      cards: sorted,
      description: `Two Pair (${FULL_RANK_NAMES[highPair]} & ${FULL_RANK_NAMES[lowPair]})`
    };
  }

  // 8. One Pair
  if (groups[0].count === 2) {
    const pairRank = groups[0].rank;
    const kickers = [groups[1].rank, groups[2].rank, groups[3].rank];
    return {
      rank: HAND_RANKS.ONE_PAIR,
      name: HAND_NAMES[1],
      score: [1, pairRank, ...kickers],
      cards: sorted,
      description: `One Pair (${FULL_RANK_NAMES[pairRank]})`
    };
  }

  // 9. High Card
  return {
    rank: HAND_RANKS.HIGH_CARD,
    name: HAND_NAMES[0],
    score: [0, ...ranks],
    cards: sorted,
    description: `High Card ${FULL_RANK_NAMES[ranks[0]]}`
  };
}

/**
 * Membandingkan dua skor hand 5-kartu
 * @returns {number} 1 jika a > b, -1 jika a < b, 0 jika seri (tie)
 */
export function compareScores(scoreA, scoreB) {
  const len = Math.max(scoreA.length, scoreB.length);
  for (let i = 0; i < len; i++) {
    const a = scoreA[i] || 0;
    const b = scoreB[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

/**
 * Menghasilkan semua kombinasi k elemen dari array
 */
function combinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [head, ...tail] = arr;
  const withHead = combinations(tail, k - 1).map(c => [head, ...c]);
  const withoutHead = combinations(tail, k);
  return [...withHead, ...withoutHead];
}

/**
 * Evaluasi 7 kartu (2 kartu tangan + 5 kartu komunitas Texas Hold'em)
 * Mencari kombinasi 5 kartu terbaik dari 7 kartu yang tersedia
 */
export function evaluate7Cards(cards7) {
  if (!cards7 || cards7.length < 5) {
    throw new Error('evaluate7Cards butuh minimal 5 kartu!');
  }
  if (cards7.length === 5) {
    return evaluate5Cards(cards7);
  }

  const allCombos = combinations(cards7, 5);
  let best = null;

  for (const combo of allCombos) {
    const evaluated = evaluate5Cards(combo);
    if (!best || compareScores(evaluated.score, best.score) > 0) {
      best = evaluated;
    }
  }

  return best;
}

// ─── ⚡ 3-CARD POKER EVALUATOR (FAST POKER) ──────────────────────
export const FAST_HAND_RANKS = {
  STRAIGHT_FLUSH: 5,
  THREE_OF_A_KIND: 4,
  STRAIGHT: 3,
  FLUSH: 2,
  PAIR: 1,
  HIGH_CARD: 0
};

export const FAST_HAND_NAMES = {
  5: '🔥 Straight Flush',
  4: '🎯 Three of a Kind',
  3: '⚡ Straight',
  2: '🌊 Flush',
  1: '🤝 One Pair',
  0: '🃏 High Card'
};

/**
 * Evaluasi kombinasi 3 kartu (Fast Poker)
 */
export function evaluate3Cards(cards3) {
  if (!cards3 || cards3.length !== 3) {
    throw new Error('evaluate3Cards butuh tepat 3 kartu!');
  }

  const sorted = [...cards3].sort((a, b) => b.rank - a.rank);
  const ranks = sorted.map(c => c.rank);
  const suits = sorted.map(c => c.suit);

  const isFlush = suits[0] === suits[1] && suits[1] === suits[2];

  let isStraight = false;
  let straightHigh = 0;
  if (ranks[0] - ranks[1] === 1 && ranks[1] - ranks[2] === 1) {
    isStraight = true;
    straightHigh = ranks[0];
  } else if (ranks[0] === 14 && ranks[1] === 3 && ranks[2] === 2) {
    // Wheel straight: A-2-3 (Ace=1)
    isStraight = true;
    straightHigh = 3;
  }

  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts).map(([r, c]) => ({ rank: Number(r), count: c }));
  groups.sort((a, b) => b.count - a.count || b.rank - a.rank);

  if (isFlush && isStraight) {
    return {
      rank: FAST_HAND_RANKS.STRAIGHT_FLUSH,
      name: FAST_HAND_NAMES[5],
      score: [5, straightHigh],
      cards: sorted,
      description: `Straight Flush ${FULL_RANK_NAMES[straightHigh]} High`
    };
  }

  if (groups[0].count === 3) {
    return {
      rank: FAST_HAND_RANKS.THREE_OF_A_KIND,
      name: FAST_HAND_NAMES[4],
      score: [4, groups[0].rank],
      cards: sorted,
      description: `Three of a Kind (${FULL_RANK_NAMES[groups[0].rank]})`
    };
  }

  if (isStraight) {
    return {
      rank: FAST_HAND_RANKS.STRAIGHT,
      name: FAST_HAND_NAMES[3],
      score: [3, straightHigh],
      cards: sorted,
      description: `Straight ${FULL_RANK_NAMES[straightHigh]} High`
    };
  }

  if (isFlush) {
    return {
      rank: FAST_HAND_RANKS.FLUSH,
      name: FAST_HAND_NAMES[2],
      score: [2, ...ranks],
      cards: sorted,
      description: `Flush ${FULL_RANK_NAMES[ranks[0]]} High`
    };
  }

  if (groups[0].count === 2) {
    return {
      rank: FAST_HAND_RANKS.PAIR,
      name: FAST_HAND_NAMES[1],
      score: [1, groups[0].rank, groups[1].rank],
      cards: sorted,
      description: `Pair (${FULL_RANK_NAMES[groups[0].rank]})`
    };
  }

  return {
    rank: FAST_HAND_RANKS.HIGH_CARD,
    name: FAST_HAND_NAMES[0],
    score: [0, ...ranks],
    cards: sorted,
    description: `High Card ${FULL_RANK_NAMES[ranks[0]]}`
  };
}

// ─── 🀄 CAPSA SUSUN EVALUATOR & SOLVER ───────────────────────────
/**
 * Evaluasi 3 kartu tingkat atas (Top Row) Capsa Susun
 * Tingkat atas hanya bisa: Three of a Kind, One Pair, High Card
 */
export function evaluateCapsaTop(cards3) {
  const sorted = [...cards3].sort((a, b) => b.rank - a.rank);
  const ranks = sorted.map(c => c.rank);
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts).map(([r, c]) => ({ rank: Number(r), count: c }));
  groups.sort((a, b) => b.count - a.count || b.rank - a.rank);

  if (groups[0].count === 3) {
    return {
      rank: 3,
      name: '🎯 Three of a Kind',
      score: [3, groups[0].rank],
      cards: sorted,
      description: `Tris ${FULL_RANK_NAMES[groups[0].rank]}`
    };
  }
  if (groups[0].count === 2) {
    return {
      rank: 1,
      name: '🤝 One Pair',
      score: [1, groups[0].rank, groups[1].rank],
      cards: sorted,
      description: `Pair ${FULL_RANK_NAMES[groups[0].rank]}`
    };
  }
  return {
    rank: 0,
    name: '🃏 High Card',
    score: [0, ...ranks],
    cards: sorted,
    description: `High Card ${FULL_RANK_NAMES[ranks[0]]}`
  };
}

/**
 * Memvalidasi susunan 13 kartu Capsa (Bawah 5, Tengah 5, Atas 3)
 * Syarat: Bawah >= Tengah >= Atas
 */
export function validateCapsaArrangement(bottom5, middle5, top3) {
  const bottomEval = evaluate5Cards(bottom5);
  const middleEval = evaluate5Cards(middle5);
  const topEval = evaluateCapsaTop(top3);

  // Bandingkan Bawah vs Tengah
  const compBottomMid = compareScores(bottomEval.score, middleEval.score);
  if (compBottomMid < 0) {
    return {
      valid: false,
      reason: 'Susunan Salah (Pajiu)! Tingkat Tengah lebih kuat dari Tingkat Bawah.',
      bottomEval,
      middleEval,
      topEval
    };
  }

  // Bandingkan Tengah vs Atas
  // Catatan: Hand rank Tengah (5-card) vs Atas (3-card)
  // Jika Tengah >= Three of a kind dan Atas Three of a kind, cek rank
  if (middleEval.rank < topEval.rank) {
    return {
      valid: false,
      reason: 'Susunan Salah (Pajiu)! Tingkat Atas lebih kuat dari Tingkat Tengah.',
      bottomEval,
      middleEval,
      topEval
    };
  }

  if (middleEval.rank === topEval.rank) {
    if (compareScores(middleEval.score, topEval.score) < 0) {
      return {
        valid: false,
        reason: 'Susunan Salah (Pajiu)! Tingkat Atas lebih kuat dari Tingkat Tengah.',
        bottomEval,
        middleEval,
        topEval
      };
    }
  }

  return {
    valid: true,
    bottomEval,
    middleEval,
    topEval
  };
}

/**
 * Auto-Solver Capsa Susun: Mencari susunan terkuat yang valid secara otomatis
 */
export function autoArrangeCapsa(cards13) {
  if (!cards13 || cards13.length !== 13) {
    throw new Error('autoArrangeCapsa butuh tepat 13 kartu!');
  }

  const all5Combos = combinations(cards13, 5);
  let bestArrangement = null;
  let bestTotalScore = -Infinity;

  // Evaluasi semua kombinasi untuk tingkat bawah
  for (const bCombo of all5Combos) {
    const bEval = evaluate5Cards(bCombo);
    const remaining8 = cards13.filter(c => !bCombo.some(bc => bc.id === c.id));
    const allMidCombos = combinations(remaining8, 5);

    for (const mCombo of allMidCombos) {
      const mEval = evaluate5Cards(mCombo);
      if (compareScores(bEval.score, mEval.score) < 0) continue;

      const tCombo = remaining8.filter(c => !mCombo.some(mc => mc.id === c.id));
      const tEval = evaluateCapsaTop(tCombo);

      // Cek validitas Tengah vs Atas
      if (mEval.rank < tEval.rank) continue;
      if (mEval.rank === tEval.rank && compareScores(mEval.score, tEval.score) < 0) continue;

      // Hitung bobot nilai susunan
      const bScore = bEval.rank * 10000 + (bEval.score[1] || 0) * 100;
      const mScore = mEval.rank * 1000 + (mEval.score[1] || 0) * 10;
      const tScore = tEval.rank * 100 + (tEval.score[1] || 0);
      const totalScore = bScore + mScore + tScore;

      if (totalScore > bestTotalScore) {
        bestTotalScore = totalScore;
        bestArrangement = {
          bottom: bCombo,
          middle: mCombo,
          top: tCombo,
          bottomEval: bEval,
          middleEval: mEval,
          topEval: tEval
        };
      }
    }
  }

  return bestArrangement;
}
