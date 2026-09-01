// ─── 🧪 POKER GAMES SUITE SMOKE TEST ──────────────────────────────
import { createDeck, shuffleDeck, formatCard, formatCards } from '../src/games/poker/deck.js';
import {
  evaluate5Cards,
  evaluate7Cards,
  evaluate3Cards,
  evaluateCapsaTop,
  validateCapsaArrangement,
  autoArrangeCapsa,
  compareScores,
  HAND_RANKS,
  FAST_HAND_RANKS
} from '../src/games/poker/evaluator.js';

console.log('🧪 MEMULAI POKER SUITE SMOKE TEST...\n');

// 1. Test Deck & Cards
const deck = createDeck();
if (deck.length !== 52) throw new Error(`Deck size harus 52, didapat: ${deck.length}`);
const shuffled = shuffleDeck(deck);
if (shuffled.length !== 52) throw new Error('Shuffled deck size salah!');
console.log('✅ 1. Deck Generator & Fisher-Yates Shuffle OK (52 kartu)');

// 2. Test 5-Card Poker Evaluator
const royalFlush = [
  { rank: 14, suit: 's', label: 'A♠' },
  { rank: 13, suit: 's', label: 'K♠' },
  { rank: 12, suit: 's', label: 'Q♠' },
  { rank: 11, suit: 's', label: 'J♠' },
  { rank: 10, suit: 's', label: '10♠' }
];
const rfEval = evaluate5Cards(royalFlush);
if (rfEval.rank !== HAND_RANKS.ROYAL_FLUSH) throw new Error('Royal Flush gagal dievaluasi!');

const straightFlush = [
  { rank: 9, suit: 'h', label: '9♥' },
  { rank: 8, suit: 'h', label: '8♥' },
  { rank: 7, suit: 'h', label: '7♥' },
  { rank: 6, suit: 'h', label: '6♥' },
  { rank: 5, suit: 'h', label: '5♥' }
];
const sfEval = evaluate5Cards(straightFlush);
if (sfEval.rank !== HAND_RANKS.STRAIGHT_FLUSH) throw new Error('Straight Flush gagal dievaluasi!');

const fourOfAKind = [
  { rank: 8, suit: 's', label: '8♠' },
  { rank: 8, suit: 'h', label: '8♥' },
  { rank: 8, suit: 'd', label: '8♦' },
  { rank: 8, suit: 'c', label: '8♣' },
  { rank: 14, suit: 's', label: 'A♠' }
];
const foakEval = evaluate5Cards(fourOfAKind);
if (foakEval.rank !== HAND_RANKS.FOUR_OF_A_KIND) throw new Error('Four of a Kind gagal dievaluasi!');

const fullHouse = [
  { rank: 10, suit: 's', label: '10♠' },
  { rank: 10, suit: 'h', label: '10♥' },
  { rank: 10, suit: 'd', label: '10♦' },
  { rank: 4, suit: 'c', label: '4♣' },
  { rank: 4, suit: 's', label: '4♠' }
];
const fhEval = evaluate5Cards(fullHouse);
if (fhEval.rank !== HAND_RANKS.FULL_HOUSE) throw new Error('Full House gagal dievaluasi!');

const flush = [
  { rank: 14, suit: 'c', label: 'A♣' },
  { rank: 10, suit: 'c', label: '10♣' },
  { rank: 7, suit: 'c', label: '7♣' },
  { rank: 6, suit: 'c', label: '6♣' },
  { rank: 2, suit: 'c', label: '2♣' }
];
const flEval = evaluate5Cards(flush);
if (flEval.rank !== HAND_RANKS.FLUSH) throw new Error('Flush gagal dievaluasi!');

const straight = [
  { rank: 10, suit: 's', label: '10♠' },
  { rank: 9, suit: 'h', label: '9♥' },
  { rank: 8, suit: 'd', label: '8♦' },
  { rank: 7, suit: 'c', label: '7♣' },
  { rank: 6, suit: 's', label: '6♠' }
];
const stEval = evaluate5Cards(straight);
if (stEval.rank !== HAND_RANKS.STRAIGHT) throw new Error('Straight gagal dievaluasi!');

const wheelStraight = [
  { rank: 14, suit: 's', label: 'A♠' },
  { rank: 5, suit: 'h', label: '5♥' },
  { rank: 4, suit: 'd', label: '4♦' },
  { rank: 3, suit: 'c', label: '3♣' },
  { rank: 2, suit: 's', label: '2♠' }
];
const wstEval = evaluate5Cards(wheelStraight);
if (wstEval.rank !== HAND_RANKS.STRAIGHT || wstEval.score[1] !== 5) throw new Error('Wheel Straight A-2-3-4-5 gagal dievaluasi!');

// Verifikasi hierarki
if (compareScores(rfEval.score, sfEval.score) <= 0) throw new Error('Royal Flush harus menang lawan Straight Flush!');
if (compareScores(sfEval.score, foakEval.score) <= 0) throw new Error('Straight Flush harus menang lawan 4 of a Kind!');
if (compareScores(foakEval.score, fhEval.score) <= 0) throw new Error('4 of a Kind harus menang lawan Full House!');
if (compareScores(fhEval.score, flEval.score) <= 0) throw new Error('Full House harus menang lawan Flush!');
if (compareScores(flEval.score, stEval.score) <= 0) throw new Error('Flush harus menang lawan Straight!');

console.log('✅ 2. 5-Card Poker Evaluator & Hierarki Ranking OK');

// 3. Test 7-Card Texas Hold'em Best Hand Selection (Flop, Turn, River)
const holeCards = [
  { rank: 14, suit: 's', label: 'A♠', id: 'As' },
  { rank: 13, suit: 's', label: 'K♠', id: 'Ks' }
];
const flopCards = [
  { rank: 12, suit: 's', label: 'Q♠', id: 'Qs' },
  { rank: 11, suit: 's', label: 'J♠', id: 'Js' },
  { rank: 10, suit: 's', label: '10♠', id: '10s' }
];
const bestFlop = evaluate7Cards([...holeCards, ...flopCards]);
if (bestFlop.rank !== HAND_RANKS.ROYAL_FLUSH) throw new Error('Flop 5-card evaluation gagal!');

const turnCards = [...flopCards, { rank: 2, suit: 'h', label: '2♥', id: '2h' }];
const bestTurn = evaluate7Cards([...holeCards, ...turnCards]);
if (bestTurn.rank !== HAND_RANKS.ROYAL_FLUSH) throw new Error('Turn 6-card evaluation gagal!');

const communityCards = [
  ...turnCards,
  { rank: 3, suit: 'd', label: '3♦', id: '3d' }
];
const best7 = evaluate7Cards([...holeCards, ...communityCards]);
if (best7.rank !== HAND_RANKS.ROYAL_FLUSH) throw new Error('7-Card best hand gagal mendeteksi Royal Flush!');
console.log('✅ 3. Texas Hold\'em Multi-Street (Flop 5, Turn 6, River 7) Evaluator OK');

// 4. Test 3-Card Fast Poker Evaluator
const fastSF = [
  { rank: 14, suit: 'h', label: 'A♥' },
  { rank: 13, suit: 'h', label: 'K♥' },
  { rank: 12, suit: 'h', label: 'Q♥' }
];
const fastTrips = [
  { rank: 7, suit: 's', label: '7♠' },
  { rank: 7, suit: 'h', label: '7♥' },
  { rank: 7, suit: 'd', label: '7♦' }
];
const fastPair = [
  { rank: 10, suit: 's', label: '10♠' },
  { rank: 10, suit: 'h', label: '10♥' },
  { rank: 4, suit: 'd', label: '4♦' }
];

const f1 = evaluate3Cards(fastSF);
const f2 = evaluate3Cards(fastTrips);
const f3 = evaluate3Cards(fastPair);

if (f1.rank !== FAST_HAND_RANKS.STRAIGHT_FLUSH) throw new Error('Fast Straight Flush gagal!');
if (f2.rank !== FAST_HAND_RANKS.THREE_OF_A_KIND) throw new Error('Fast Trips gagal!');
if (f3.rank !== FAST_HAND_RANKS.PAIR) throw new Error('Fast Pair gagal!');
if (compareScores(f1.score, f2.score) <= 0) throw new Error('Fast SF harus menang lawan Trips!');
if (compareScores(f2.score, f3.score) <= 0) throw new Error('Fast Trips harus menang lawan Pair!');
console.log('✅ 4. Fast 3-Card Poker Evaluator OK');

// 5. Test Capsa Susun Auto-Arranger & Validator
const testDeck = shuffleDeck(createDeck());
const hand13 = testDeck.slice(0, 13);
const arranged = autoArrangeCapsa(hand13);

if (!arranged || !arranged.bottom || !arranged.middle || !arranged.top) {
  throw new Error('Auto-arrange Capsa gagal menghasilkan susunan!');
}
if (arranged.bottom.length !== 5 || arranged.middle.length !== 5 || arranged.top.length !== 3) {
  throw new Error('Ukuran baris Capsa salah!');
}

const validation = validateCapsaArrangement(arranged.bottom, arranged.middle, arranged.top);
if (!validation.valid) {
  throw new Error(`Auto-arranged Capsa tidak valid: ${validation.reason}`);
}

console.log('✅ 5. Capsa Susun 13-Card Auto-Solver & Validator OK');
console.log(`   Top:    ${arranged.topEval.name}`);
console.log(`   Middle: ${arranged.middleEval.name}`);
console.log(`   Bottom: ${arranged.bottomEval.name}`);

console.log('\n🎉 SEMUA POKER SMOKE TESTS BERHASIL DENGAN NILAI 100%!');
