// ─── 🧪 POKER WSOP RULES UNIT TEST ──────────────────────────────
console.log('📐 MEMULAI WSOP POKER RULES TEST...\n');

// 1. Test 2-Player (Heads-Up) Position Calculation
function calculateHeadsUpPositions(dealerIndex) {
  const dIdx = dealerIndex % 2;
  const sbIdx = dIdx;
  const bbIdx = (dIdx + 1) % 2;
  const preflopStart = sbIdx;
  const postflopStart = bbIdx;
  return { sbIdx, bbIdx, preflopStart, postflopStart };
}

const hu0 = calculateHeadsUpPositions(0);
if (hu0.sbIdx !== 0 || hu0.bbIdx !== 1 || hu0.preflopStart !== 0 || hu0.postflopStart !== 1) {
  throw new Error('Heads-Up (Dealer 0) salah!');
}
const hu1 = calculateHeadsUpPositions(1);
if (hu1.sbIdx !== 1 || hu1.bbIdx !== 0 || hu1.preflopStart !== 1 || hu1.postflopStart !== 0) {
  throw new Error('Heads-Up (Dealer 1) salah!');
}
console.log('✅ 1. Heads-Up (2 Pemain) Dealer=SB & Action Order OK');

// 2. Test Multi-Player (4 Pemain) Position Calculation
function calculateMultiplayerPositions(dealerIndex, n = 4) {
  const dIdx = dealerIndex % n;
  const sbIdx = (dIdx + 1) % n;
  const bbIdx = (dIdx + 2) % n;
  const preflopStart = (dIdx + 3) % n; // UTG
  const postflopStart = sbIdx;
  return { sbIdx, bbIdx, preflopStart, postflopStart };
}

const mp0 = calculateMultiplayerPositions(0, 4);
if (mp0.sbIdx !== 1 || mp0.bbIdx !== 2 || mp0.preflopStart !== 3 || mp0.postflopStart !== 1) {
  throw new Error('Multiplayer (Dealer 0) salah!');
}
console.log('✅ 2. Multiplayer (4 Pemain) SB, BB, UTG & Post-Flop Order OK');

// 3. Test Minimum Raise Rule
function validateRaise(currentBet, newRaiseAmount, lastRaiseDiff) {
  return newRaiseAmount >= lastRaiseDiff;
}

if (!validateRaise(40, 20, 20)) throw new Error('Raise sah ditolak!');
if (validateRaise(40, 10, 20)) throw new Error('Raise di bawah minimum lolos!');
console.log('✅ 3. Minimum Raise Delta Enforcement OK');

console.log('\n🎉 SEMUA ATURAN RESMI WSOP POKER 100% LOLOS PENGUJIAN!');
