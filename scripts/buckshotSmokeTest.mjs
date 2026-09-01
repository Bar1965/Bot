/**
 * Smoke Test for Buckshot Roulette 1v1
 *
 * Catatan: versi lama berkas ini MENULIS ULANG logika permainan di dalam test
 * (mis. `mockSession.p1Hp = Math.min(4, p1Hp + 1)`), lalu meng-assert hasil
 * tulisannya sendiri — jadi selalu hijau walaupun buckshotRoulette.js dikosongkan.
 * Sekarang test memanggil fungsi aslinya. HP kedua pemain sengaja dijaga tetap
 * penuh dan peluru dipilih BLANK supaya `finishBuckshotGame` (satu-satunya jalur
 * yang menulis ke database) tidak pernah tersentuh.
 */
import {
  generateMagazine,
  ITEMS,
  samaJid,
  resolveTurnAfterShot,
  executeShootAction,
  activeBuckshots
} from '../src/games/buckshotRoulette.js';
import assert from 'assert';

console.log('💥 MEMULAI SMOKE TEST BUCKSHOT ROULETTE 1V1...');

const P1 = '628111111111@s.whatsapp.net';
const P2 = '628222222222@s.whatsapp.net';
const GRUP = '120363888888888888@g.us';

/** Socket palsu: cukup merekam pesan supaya `send()` di helpers.js tidak meledak. */
function buatMockSock() {
  const terkirim = [];
  return {
    terkirim,
    sendMessage: async (tujuan, isi) => {
      terkirim.push({ tujuan, teks: (isi && isi.text) || '' });
      return { key: { id: 'mock' } };
    }
  };
}

function buatSesi(override = {}) {
  return {
    jid: GRUP,
    player1: P1,
    player2: P2,
    buyIn: 50,
    pot: 100,
    p1Hp: 4,
    p2Hp: 4,
    p1Items: [],
    p2Items: [],
    shells: ['BLANK'],
    activeTurn: P1,
    sawActive: false,
    handcuffedPlayer: null,
    status: 'PLAYING',
    busy: false,
    timer: null,
    createdAt: 0,
    ...override
  };
}

/** Pasang sesi, jalankan tembakan sungguhan, bersihkan timer & map setelahnya. */
async function tembak(sesi, penembak, sasaran) {
  const sock = buatMockSock();
  activeBuckshots.set(GRUP, sesi);
  try {
    await executeShootAction(sock, GRUP, penembak, sasaran);
  } finally {
    const hidup = activeBuckshots.get(GRUP);
    if (hidup && hidup.timer) clearTimeout(hidup.timer);
    activeBuckshots.delete(GRUP);
  }
  return sock.terkirim;
}

// ─── 1. Generator Magazen Peluru Shotgun (200x) ──────────────────────────
console.log('1. Menguji keabsahan pengisian peluru shotgun (200x)...');
for (let i = 0; i < 200; i++) {
  const mag = generateMagazine();
  assert.ok(mag.total >= 3 && mag.total <= 6, 'Total peluru harus antara 3 - 6');
  assert.ok(mag.liveCount >= 1, 'Minimal ada 1 peluru LIVE');
  assert.ok(mag.blankCount >= 1, 'Minimal ada 1 peluru BLANK (magazen full-LIVE tidak adil)');
  assert.strictEqual(mag.shells.length, mag.total, 'Jumlah shell harus sesuai total');
  assert.strictEqual(mag.shells.filter(s => s === 'LIVE').length, mag.liveCount, 'Hitungan LIVE harus tepat');
  assert.strictEqual(mag.shells.filter(s => s === 'BLANK').length, mag.blankCount, 'Hitungan BLANK harus tepat');
}
console.log('✅ 1. Generator peluru shotgun 100% valid');

// ─── 2. Definisi 5 Item Taktis ───────────────────────────────────────────
console.log('2. Memeriksa konfigurasi 5 item...');
assert.strictEqual(ITEMS.length, 5, 'Harus ada 5 item taktis');
for (const key of ['rokok', 'kaca', 'gergaji', 'bir', 'borgol']) {
  const item = ITEMS.find(it => it.key === key);
  assert.ok(item, `Item ${key} harus terdaftar`);
  assert.ok(item.icon, `Item ${key} harus memiliki icon`);
  assert.ok(item.aliases.length >= 2, `Item ${key} harus memiliki alias`);
}
console.log('✅ 2. Konfigurasi 5 item taktis 100% valid');

// ─── 3. Pencocokan JID Toleran Format ────────────────────────────────────
console.log('3. Menguji pencocokan identitas pemain lintas format JID...');
assert.ok(samaJid(P1, P1), 'JID identik harus cocok');
assert.ok(samaJid('628111111111@c.us', P1), 'Domain @c.us harus dianggap sama');
assert.ok(samaJid('628111111111:12@s.whatsapp.net', P1), 'Sufiks perangkat harus diabaikan');
assert.ok(samaJid('08111111111@s.whatsapp.net', P1), 'Awalan 0 harus disamakan dengan 62');
assert.ok(!samaJid(P1, P2), 'Dua pemain berbeda tidak boleh dianggap sama');
assert.ok(!samaJid(P1, null), 'JID kosong tidak boleh cocok');
console.log('✅ 3. Pencocokan JID 100% valid');

// ─── 4. Penentuan Giliran (fungsi murni) ─────────────────────────────────
console.log('4. Menguji aturan perpindahan giliran...');
{
  const s = buatSesi();
  const hasil = resolveTurnAfterShot(s, P1, P2, false);
  assert.strictEqual(s.activeTurn, P2, 'Tembakan normal harus memindahkan giliran ke lawan');
  assert.strictEqual(hasil.turnPassed, true, 'turnPassed harus true');
}
{
  const s = buatSesi();
  resolveTurnAfterShot(s, P1, P2, true);
  assert.strictEqual(s.activeTurn, P1, 'Tembak diri + BLANK harus mempertahankan giliran');
}
{
  const s = buatSesi({ handcuffedPlayer: P2 });
  const hasil = resolveTurnAfterShot(s, P1, P2, false);
  assert.strictEqual(s.activeTurn, P1, 'Lawan terborgol: giliran kembali ke penembak');
  assert.strictEqual(hasil.handcuffConsumed, true, 'Borgol harus tercatat terpakai');
  assert.strictEqual(s.handcuffedPlayer, null, 'Borgol harus lepas setelah 1x skip');

  resolveTurnAfterShot(s, P1, P2, false);
  assert.strictEqual(s.activeTurn, P2, 'Borgol hanya berlaku sekali, giliran berikutnya harus pindah');
}
console.log('✅ 4. Aturan perpindahan giliran 100% valid');

// ─── 5. Tembakan Sungguhan Lewat executeShootAction ──────────────────────
console.log('5. Menguji eksekusi tembakan (regresi: giliran setelah magazen habis)...');
{
  // Peluru terakhir ditembakkan ke lawan -> magazen diisi ulang.
  // Bug lama: blok reload `return` duluan, jadi penembak menahan giliran
  // sekaligus memanen 2 item ronde baru.
  const s = buatSesi({ shells: ['BLANK'] });
  await tembak(s, P1, 'lawan');
  assert.strictEqual(s.activeTurn, P2, 'Menghabiskan magazen tidak boleh mempertahankan giliran');
  assert.ok(s.shells.length >= 3, 'Magazen harus terisi ulang otomatis');
  assert.strictEqual(s.p1Items.length, 2, 'Penembak dapat 2 item baru');
  assert.strictEqual(s.p2Items.length, 2, 'Lawan juga dapat 2 item baru');
}
{
  // Tembak diri + BLANK di peluru terakhir: giliran memang tetap milik penembak.
  const s = buatSesi({ shells: ['BLANK'] });
  await tembak(s, P1, 'diri');
  assert.strictEqual(s.activeTurn, P1, 'Tembak diri + BLANK harus mempertahankan giliran walau reload');
  assert.ok(s.shells.length >= 3, 'Magazen harus terisi ulang otomatis');
}
{
  // Tembakan biasa di tengah magazen.
  const s = buatSesi({ shells: ['BLANK', 'BLANK', 'BLANK'] });
  await tembak(s, P1, 'lawan');
  assert.strictEqual(s.shells.length, 2, 'Tepat 1 peluru keluar per tembakan');
  assert.strictEqual(s.activeTurn, P2, 'Giliran harus pindah ke lawan');
  assert.strictEqual(s.p1Hp, 4, 'BLANK tidak boleh mengurangi HP');
  assert.strictEqual(s.p2Hp, 4, 'BLANK tidak boleh mengurangi HP');
}
{
  // Bukan peserta duel tidak boleh menembak.
  const s = buatSesi({ shells: ['BLANK', 'BLANK'] });
  await tembak(s, '628999999999@s.whatsapp.net', 'lawan');
  assert.strictEqual(s.shells.length, 2, 'Orang luar tidak boleh meletuskan peluru');
  assert.strictEqual(s.activeTurn, P1, 'Giliran tidak boleh berubah karena orang luar');
}
{
  // Damage gergaji 2x + reset laras setelah menembak.
  const s = buatSesi({ shells: ['LIVE', 'BLANK'], sawActive: true });
  await tembak(s, P1, 'lawan');
  assert.strictEqual(s.p2Hp, 2, 'Gergaji harus melipatgandakan damage jadi 2');
  assert.strictEqual(s.sawActive, false, 'Laras gergaji harus reset setelah 1 tembakan');
  assert.strictEqual(s.activeTurn, P2, 'Giliran harus pindah setelah menembak lawan');
}
console.log('✅ 5. Eksekusi tembakan, damage, dan reload 100% valid');

// ─── 6. Kunci Re-entrancy (anti dobel tembak) ────────────────────────────
console.log('6. Menguji kunci anti tembakan ganda...');
{
  const sock = buatMockSock();
  const s = buatSesi({ shells: ['BLANK', 'BLANK', 'BLANK', 'BLANK'] });
  activeBuckshots.set(GRUP, s);
  try {
    // Dua pesan `.tembak lawan` beruntun: yang kedua harus ditolak kunci busy.
    await Promise.all([
      executeShootAction(sock, GRUP, P1, 'lawan'),
      executeShootAction(sock, GRUP, P1, 'lawan')
    ]);
  } finally {
    const hidup = activeBuckshots.get(GRUP);
    if (hidup && hidup.timer) clearTimeout(hidup.timer);
    activeBuckshots.delete(GRUP);
  }
  assert.strictEqual(s.shells.length, 3, 'Hanya 1 peluru boleh meletus per giliran');
  assert.strictEqual(s.busy, false, 'Kunci harus dilepas setelah tembakan selesai');
}
console.log('✅ 6. Kunci anti tembakan ganda 100% valid');

console.log('\n🎉 SEMUA SMOKE TESTS BUCKSHOT ROULETTE 100% SUKSES!');

// buckshotRoulette.js -> helpers.js -> bot.js -> mediaHandler.js, dan mediaHandler
// menembakkan `pip install -U yt-dlp` (timeout 120 detik) saat di-import. Tanpa
// exit eksplisit, test yang sudah lulus tetap menggantung menunggu proses itu.
process.exit(0);
