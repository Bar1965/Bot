// ─── 🧪 GAME CRASH RECOVERY & AUTO-REFUND TEST ───────────────────
import * as db from '../database.js';

console.log('🛡️ MEMULAI CRASH RECOVERY & AUTO-REFUND TEST...\n');

await db.initDb();

const testUser1 = '628999999901@s.whatsapp.net';
const testUser2 = '628999999902@s.whatsapp.net';
const testGroup = '120363000000000001@g.us';

// 1. Catat saldo awal
const p1Before = await db.getGameProfile(testUser1);
const p2Before = await db.getGameProfile(testUser2);

const initialPoints1 = p1Before.points;
const initialPoints2 = p2Before.points;

console.log(`Saldo Awal User 1: ${initialPoints1} Poin`);
console.log(`Saldo Awal User 2: ${initialPoints2} Poin`);

// 2. Simulasikan pembuatan sesi game aktif yang terputus (crash)
const testSessionId = `test_crash_${Date.now()}`;
await db.createActiveGameSession({
  id: testSessionId,
  gameType: "Texas Hold'em Poker (Simulation)",
  jid: testGroup,
  host: testUser1,
  buyIn: 150,
  pot: 300,
  players: [
    { jid: testUser1, points: 150 },
    { jid: testUser2, points: 150 }
  ]
});

console.log('✅ Sesi game simulasi berhasil disimpan ke tabel active_game_sessions.');

// 3. Jalankan Recovery & Auto-Refund (seperti saat bot baru menyala)
const recoveryResult = await db.recoverAndRefundStaleGameSessions(null);
console.log(`Hasil Recovery: Sesi dipulihkan = ${recoveryResult.recovered}, Total Poin Direfund = ${recoveryResult.totalRefundedPoints}`);

if (recoveryResult.recovered < 1) {
  throw new Error('Sesi game tertunda gagal dideteksi saat recovery!');
}

// 4. Verifikasi saldo bertambah 150 poin untuk masing-masing pemain
const p1After = await db.getGameProfile(testUser1);
const p2After = await db.getGameProfile(testUser2);

if (p1After.points !== initialPoints1 + 150) {
  throw new Error(`Poin User 1 tidak bertambah 150! (Sebelum: ${initialPoints1}, Sesudah: ${p1After.points})`);
}
if (p2After.points !== initialPoints2 + 150) {
  throw new Error(`Poin User 2 tidak bertambah 150! (Sebelum: ${initialPoints2}, Sesudah: ${p2After.points})`);
}

// 5. Verifikasi status di database sudah menjadi REFUNDED_ON_RESTART
const sessInDb = await db.getActiveGameSession(testSessionId);
if (sessInDb.status !== 'REFUNDED_ON_RESTART') {
  throw new Error(`Status sesi salah: ${sessInDb.status}`);
}

console.log('✅ 100% Poin berhasil dikembalikan ke profil seluruh pemain!');
console.log('\n🎉 CRASH RECOVERY & AUTO-REFUND TEST 100% SUKSES!');
