// ─── 🧪 POKER AI AGENTS & SIMULATION SMOKE TEST ──────────────────
import { createDeck, shuffleDeck } from '../src/games/poker/deck.js';
import { evaluate7Cards, compareScores } from '../src/games/poker/evaluator.js';
import { BOT_NAMES, isAiPlayer, decidePreflopAction, decidePostflopAction } from '../src/games/poker/pokerAi.js';

console.log('🤖 MEMULAI POKER AI SMOKE TEST...\n');

// 1. Test Bot Names & isAiPlayer
if (BOT_NAMES.length < 5) throw new Error('Jumlah AI Bot kurang dari 5!');
if (!isAiPlayer('bot_akbar@ai')) throw new Error('isAiPlayer gagal mengenali bot!');
if (isAiPlayer('628123456789@s.whatsapp.net')) throw new Error('isAiPlayer salah mendeteksi user nyata!');
console.log('✅ 1. AI Bot Profiles & JID Identifier OK');

// 2. Test Preflop Decisions for each personality
const pocketAces = [{ rank: 14, suit: 's' }, { rank: 14, suit: 'h' }];
const trash72 = [{ rank: 7, suit: 's' }, { rank: 2, suit: 'h' }];

const proActionAA = decidePreflopAction(pocketAces, 20, 0, 30, 10, 'PRO');
// ALLIN ikut sah: dengan stack 5 big blind, shove memang jawaban yang benar
// untuk Pocket Aces. Assertion lama hanya menerima RAISE/CALL.
if (!['RAISE', 'CALL', 'ALLIN'].includes(proActionAA.action)) throw new Error('AI Pro gagal bertindak pada Pocket Aces!');

const proAction72 = decidePreflopAction(trash72, 20, 0, 30, 10, 'PRO');
if (!['FOLD', 'CALL'].includes(proAction72.action)) throw new Error('AI Pro gagal menangani kartu sampah!');

const checkAction = decidePreflopAction(trash72, 0, 0, 30, 10, 'PRO');
if (checkAction.action !== 'CHECK') throw new Error('AI harus CHECK jika tidak ada taruhan aktif (toCall = 0)!');

console.log('✅ 2. AI Preflop Decision Engine OK');

// 3. Test Postflop Decisions
const communityBoard = [
  { rank: 14, suit: 'd' },
  { rank: 14, suit: 'c' },
  { rank: 7, suit: 'h' },
  { rank: 2, suit: 'd' },
  { rank: 9, suit: 's' }
]; // Pocket Aces + Board = Four of a Kind Aces!

const monsterAction = decidePostflopAction(pocketAces, communityBoard, 20, 0, 50, 10, 'RIVER', 'PRO');
if (!['RAISE', 'ALLIN', 'CALL'].includes(monsterAction.action)) throw new Error('AI gagal bertindak agresif saat dapat Four of a Kind!');

console.log('✅ 3. AI Postflop Decision Engine OK');

// 4. Simulate 100 Automated Texas Hold'em Hands between 4 AI Bots
console.log('🎲 Menjalankan simulasi 100 ronde Texas Hold\'em (4 AI Bots)...');
let showdownCount = 0;
let foldCount = 0;

for (let r = 0; r < 100; r++) {
  const deck = shuffleDeck(createDeck());
  const bots = BOT_NAMES.slice(0, 4);
  const holeCards = new Map();
  for (const b of bots) {
    holeCards.set(b.id, [deck.pop(), deck.pop()]);
  }

  // Preflop
  let currentBet = 20;
  let activeBots = [...bots];

  for (const b of bots) {
    const dec = decidePreflopAction(holeCards.get(b.id), currentBet, 0, 50, 10, b.personality);
    if (dec.action === 'FOLD') {
      activeBots = activeBots.filter(x => x.id !== b.id);
    }
  }

  if (activeBots.length <= 1) {
    foldCount++;
    continue;
  }

  // Flop + Turn + River
  const community = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];

  for (const b of [...activeBots]) {
    const dec = decidePostflopAction(holeCards.get(b.id), community, currentBet, 0, 100, 10, 'RIVER', b.personality);
    if (dec.action === 'FOLD') {
      activeBots = activeBots.filter(x => x.id !== b.id);
    }
  }

  if (activeBots.length <= 1) {
    foldCount++;
    continue;
  }

  // Showdown
  const evals = activeBots.map(b => ({
    bot: b.name,
    eval: evaluate7Cards([...holeCards.get(b.id), ...community])
  }));
  evals.sort((a, b) => compareScores(b.eval.score, a.eval.score));
  if (!evals[0] || !evals[0].eval.name) throw new Error('Evaluasi Showdown gagal!');
  showdownCount++;
}

console.log(`✅ 4. Simulasi 100 Ronde Selesai: Showdown ${showdownCount}x, Menang Fold ${foldCount}x`);
console.log('\n🎉 SEMUA POKER AI SMOKE TESTS 100% SUKSES!');
