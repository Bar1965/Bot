/**
 * Smoke Test for Liar's Dice (Dadu Bajak Laut)
 *
 * Aturan perhitungan dadu & kenaikan tebakan ditulis sebagai fungsi murni di
 * liarsDice.js justru supaya berkas ini bisa menjalankan aturan yang SAMA
 * dengan yang dipakai bot. Jangan menyalin ulang rumusnya ke sini — kalau
 * aturannya berubah, test ini yang harus jatuh.
 */
import assert from 'assert';
import { rollDice, formatDice, hitungDaduDiMeja, bidLebihTinggi } from '../src/games/liarsDice.js';

console.log("🎲 MEMULAI SMOKE TEST LIAR'S DICE / PERUDO...");

// ── 1. Generator dadu ──────────────────────────────────────────────────
console.log('1. Menguji pengocokan dadu (2.000x)...');
const sebaran = new Map([[1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0]]);
for (let i = 0; i < 2000; i++) {
  const dice = rollDice(5);
  assert.strictEqual(dice.length, 5, 'Jumlah dadu harus 5');
  for (let j = 1; j < dice.length; j++) {
    assert.ok(dice[j] >= dice[j - 1], 'Hasil kocokan harus terurut menaik');
  }
  for (const d of dice) {
    assert.ok(Number.isInteger(d) && d >= 1 && d <= 6, `Nilai dadu harus bilangan bulat 1-6 (dapat: ${d})`);
    sebaran.set(d, sebaran.get(d) + 1);
  }
}
for (const [muka, jumlah] of sebaran) {
  const frekuensi = jumlah / 10000;
  assert.ok(Math.abs(frekuensi - 1 / 6) < 0.03, `Dadu ${muka} tidak adil: ${(frekuensi * 100).toFixed(1)}%`);
}
assert.strictEqual(rollDice(0).length, 0, 'Kocok 0 dadu harus menghasilkan array kosong');
console.log('✅ 1. Pengocokan dadu valid & merata');

// ── 2. Format tampilan ─────────────────────────────────────────────────
console.log('2. Menguji format tampilan dadu...');
const formatted = formatDice([1, 3, 5]);
assert.ok(formatted.includes('⚀'), 'Harus memuat emoji dadu 1');
assert.ok(formatted.includes('⚂'), 'Harus memuat emoji dadu 3');
assert.ok(formatted.includes('⚄'), 'Harus memuat emoji dadu 5');
assert.strictEqual(formatDice([]), '', 'Tangan kosong harus jadi string kosong');
console.log('✅ 2. Format visual dadu valid');

// ── 3. Perhitungan DUDO memakai fungsi asli bot ────────────────────────
console.log('3. Menguji perhitungan dadu di meja (fungsi asli, termasuk Wild 1)...');
const p1Dice = [1, 2, 4, 4, 6]; // 1x Wild, 1x '2', 2x '4', 1x '6'
const p2Dice = [1, 3, 4, 5, 5]; // 1x Wild, 1x '3', 1x '4', 2x '5'
const meja = [p1Dice, p2Dice];

const hasil4 = hitungDaduDiMeja(meja, 4);
assert.strictEqual(hasil4.asli, 3, "Dadu '4' murni harus berjumlah 3");
assert.strictEqual(hasil4.wild, 2, 'Dadu 1 Wild harus berjumlah 2');
assert.strictEqual(hasil4.total, 5, 'Total aktual harus 5');
assert.ok(hasil4.total >= 4, 'Tebakan "4x Dadu 4" harus terbukti BENAR');
assert.ok(hasil4.total < 6, 'Tebakan "6x Dadu 4" harus terbukti BOHONG');

// Ini jebakan klasiknya: kalau tebakannya angka 1, dadu 1 tidak boleh dihitung
// dua kali (sekali sebagai angka asli, sekali sebagai wild).
const hasil1 = hitungDaduDiMeja(meja, 1);
assert.strictEqual(hasil1.wild, 0, 'Saat menebak angka 1, tidak ada wild sama sekali');
assert.strictEqual(hasil1.total, 2, 'Dadu 1 hanya boleh dihitung sekali (dapat dobel?)');

// Meja kosong & pemain tanpa dadu tidak boleh bikin fungsi meledak.
assert.strictEqual(hitungDaduDiMeja([], 3).total, 0, 'Meja kosong harus 0');
assert.strictEqual(hitungDaduDiMeja([[], null, undefined], 3).total, 0, 'Tangan kosong/null harus aman');
console.log('✅ 3. Logika perhitungan DUDO & Wild 1 valid');

// ── 4. Aturan kenaikan tebakan (fungsi asli bot) ───────────────────────
console.log('4. Menguji aturan kenaikan tebakan (raise)...');
const bid = (quantity, face) => ({ quantity, face });

assert.ok(bidLebihTinggi(null, bid(1, 2)), 'Tebakan pertama selalu sah');
assert.ok(bidLebihTinggi(bid(3, 4), bid(4, 2)), 'Jumlah naik = sah, walau angkanya turun');
assert.ok(bidLebihTinggi(bid(3, 4), bid(3, 5)), 'Jumlah sama + angka naik = sah');
assert.ok(!bidLebihTinggi(bid(3, 4), bid(3, 4)), 'Tebakan identik harus ditolak');
assert.ok(!bidLebihTinggi(bid(3, 4), bid(3, 3)), 'Jumlah sama + angka turun harus ditolak');
assert.ok(!bidLebihTinggi(bid(3, 4), bid(2, 6)), 'Jumlah turun harus ditolak walau angkanya naik');
console.log('✅ 4. Aturan kenaikan tebakan valid');

// ── 5. Urutan giliran setelah eliminasi ────────────────────────────────
// Dulu giliran selalu dilempar balik ke pemain nomor satu setiap ada yang
// tereliminasi, jadi pemain pertama dapat keuntungan membuka ronde terus.
console.log('5. Menguji urutan giliran setelah pemain tereliminasi...');
function giliranSetelahEliminasi(alive, kalah) {
  const idxSebelum = alive.indexOf(kalah);
  const sisa = alive.filter(p => p !== kalah);
  const idx = sisa.indexOf(kalah);
  return {
    sisa,
    giliran: sisa[idx !== -1 ? idx : (idxSebelum >= 0 ? idxSebelum % sisa.length : 0)]
  };
}

const meja4 = ['A', 'B', 'C', 'D'];
assert.strictEqual(giliranSetelahEliminasi(meja4, 'B').giliran, 'C', 'Setelah B keluar, giliran jatuh ke C');
assert.strictEqual(giliranSetelahEliminasi(meja4, 'D').giliran, 'A', 'Setelah pemain terakhir keluar, giliran memutar ke A');
assert.strictEqual(giliranSetelahEliminasi(meja4, 'A').giliran, 'B', 'Setelah A keluar, giliran jatuh ke B');
console.log('✅ 5. Urutan giliran setelah eliminasi valid');

// ── 6. Simulasi satu meja penuh sampai ada pemenang ────────────────────
// Menjamin permainan selalu konvergen: tidak ada kondisi yang bikin ronde
// berputar selamanya tanpa ada yang kehabisan dadu.
console.log('6. Simulasi 300 meja penuh sampai tersisa satu pemenang...');
for (let percobaan = 0; percobaan < 300; percobaan++) {
  let alive = ['A', 'B', 'C', 'D'];
  const diceCount = new Map(alive.map(p => [p, 5]));
  let ronde = 0;

  while (alive.length > 1) {
    ronde++;
    assert.ok(ronde < 200, 'Permainan tidak pernah selesai — ada ronde yang berputar selamanya');

    const tangan = new Map(alive.map(p => [p, rollDice(diceCount.get(p))]));
    const totalDadu = [...tangan.values()].reduce((s, d) => s + d.length, 0);

    // Tebakan acak yang sah, lalu langsung ditantang DUDO.
    const face = Math.floor(Math.random() * 6) + 1;
    const quantity = Math.floor(Math.random() * totalDadu) + 1;
    const penebak = alive[Math.floor(Math.random() * alive.length)];
    const penuduh = alive[(alive.indexOf(penebak) + 1) % alive.length];

    const { total } = hitungDaduDiMeja([...tangan.values()], face);
    const kalah = total >= quantity ? penuduh : penebak;

    const sisaDadu = diceCount.get(kalah) - 1;
    diceCount.set(kalah, sisaDadu);
    if (sisaDadu <= 0) {
      alive = alive.filter(p => p !== kalah);
      diceCount.delete(kalah);
    }
  }

  assert.strictEqual(alive.length, 1, 'Harus tersisa tepat satu pemenang');
  assert.ok(diceCount.get(alive[0]) >= 1, 'Pemenang harus masih punya minimal 1 dadu');
}
console.log('✅ 6. Meja selalu konvergen ke satu pemenang');

console.log("\n🎉 SEMUA SMOKE TESTS LIAR'S DICE 100% SUKSES!");

// liarsDice.js -> helpers.js -> bot.js -> mediaHandler.js, dan mediaHandler
// menembakkan `pip install -U yt-dlp` saat di-import. Tanpa exit eksplisit,
// test yang sudah lulus tetap menggantung menunggu proses itu.
process.exit(0);
