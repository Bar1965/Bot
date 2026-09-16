/**
 * UJI REM UNDUHAN PER JAM
 *
 * Permintaan owner: "khusus downloader aja batesin jadi sekitar 3 per jam."
 *
 * Dua lapis yang diuji di sini:
 *   1. Logika jendelanya (murni, tanpa database).
 *   2. Jalur database yang SEBENARNYA — incrementMediaUsage & periksaKuotaMediaJam
 *      dijalankan di atas berkas sqlite sementara. Menyalin ulang SQL-nya ke
 *      dalam uji cuma akan menguji salinan itu, bukan kode yang dipakai bot.
 *
 * Database asli owner (./shop.db) TIDAK pernah disentuh: SHOP_DB_PATH diarahkan
 * ke berkas sementara sebelum modul database di-impor.
 *
 * Pakai:
 *   node scripts/kuotaUnduhJamTest.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const AKAR = path.resolve(import.meta.dirname, '..');
const REPO = pathToFileURL(AKAR).href + '/';

const DB_SEMENTARA = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'ujikuotajam-')),
  'uji.db'
);
process.env.SHOP_DB_PATH = DB_SEMENTARA;
process.env.JWT_SECRET ||= 'uji-asap-bukan-rahasia-sungguhan';
process.env.ADMIN_USER ||= 'ujiasap';
process.env.ADMIN_PASSWORD_HASH ||= '$2b$10$0000000000000000000000000000000000000000000000000000';

const L = await import(REPO + 'src/utils/pembatasLaju.js');
const { PREMIUM_TIERS, getPremiumBenefits } = await import(REPO + 'premiumHandler.js');

let lulus = 0, gagal = 0;
function cek(nama, kondisi, detail = '') {
  if (kondisi) { lulus++; console.log(`  OK    ${nama}`); }
  else { gagal++; console.log(`  GAGAL ${nama}${detail !== '' ? ' -> ' + detail : ''}`); }
}
const bagian = (j) => console.log(`\n== ${j} ==`);

const JAM = 3600_000;
const T0 = 1_700_000_000_000;

// ============================================================
bagian('1. Jendela sejam menahan pada hitungan yang benar');

cek('jejak kosong: boleh', L.putusanJendela([], 3, JAM, T0).boleh === true);
cek('2 dari 3: masih boleh', L.putusanJendela([T0 - 1000, T0 - 500], 3, JAM, T0).boleh === true);
const penuh = L.putusanJendela([T0 - 3000, T0 - 2000, T0 - 1000], 3, JAM, T0);
cek('3 dari 3: DITOLAK', penuh.boleh === false, JSON.stringify(penuh));
cek('dihitung 3 terpakai', penuh.dipakai === 3);
cek('sisanya nol', penuh.sisa === 0);

// ============================================================
bagian('2. Lama tunggunya dihitung dari yang TERTUA, bukan yang terakhir');

// Tiga unduhan: 50 menit lalu, 10 menit lalu, barusan.
// Slot pertama terbuka 10 menit lagi (sejam sesudah yang tertua) — BUKAN sejam.
const campur = L.putusanJendela([T0 - 50 * 60_000, T0 - 10 * 60_000, T0 - 1000], 3, JAM, T0);
cek('ditolak', campur.boleh === false);
cek('tunggu ~10 menit, bukan sejam', campur.tungguDetik > 590 && campur.tungguDetik <= 600,
  String(campur.tungguDetik));

// Kalau yang tertua baru saja, tunggunya memang hampir sejam penuh.
const barusan = L.putusanJendela([T0 - 1000, T0 - 900, T0 - 800], 3, JAM, T0);
cek('semua barusan: tunggu hampir sejam', barusan.tungguDetik > 3590 && barusan.tungguDetik <= 3600,
  String(barusan.tungguDetik));

// ============================================================
bagian('3. Yang sudah lewat sejam tidak ikut dihitung');

const lewat = L.putusanJendela([T0 - 2 * JAM, T0 - 90 * 60_000, T0 - 1000], 3, JAM, T0);
cek('dua stempel lama diabaikan', lewat.dipakai === 1, JSON.stringify(lewat));
cek('jadi masih boleh', lewat.boleh === true);
cek('sisa 2', lewat.sisa === 2);
cek('yang dikembalikan sudah bersih', lewat.hidup.length === 1);

// Tepat di batas jendela: 1 jam pas sudah DI LUAR (dipakai `<`, bukan `<=`).
cek('tepat 1 jam = sudah keluar jendela',
  L.putusanJendela([T0 - JAM, T0 - JAM, T0 - JAM], 3, JAM, T0).boleh === true);
cek('kurang 1 ms dari 1 jam = masih di dalam',
  L.putusanJendela([T0 - JAM + 1, T0 - JAM + 1, T0 - JAM + 1], 3, JAM, T0).boleh === false);

// ============================================================
bagian('4. Stempel acak-acakan tetap benar');

const acak = L.putusanJendela([T0 - 1000, T0 - 50 * 60_000, T0 - 10 * 60_000], 3, JAM, T0);
cek('urutan masuk tidak berpengaruh', acak.tungguDetik === campur.tungguDetik,
  `${acak.tungguDetik} vs ${campur.tungguDetik}`);
cek('null/NaN dibuang, tidak melempar',
  L.putusanJendela([null, NaN, undefined, T0 - 1000], 3, JAM, T0).dipakai === 1);
cek('bukan array = dianggap kosong', L.putusanJendela('banyak', 3, JAM, T0).boleh === true);

// ============================================================
bagian('5. Batas tidak masuk akal = tanpa rem, bukan terkunci');

for (const b of [0, -1, NaN, null, undefined, 'tiga']) {
  const p = L.putusanJendela([T0, T0, T0, T0, T0], b, JAM, T0);
  cek(`batas ${String(b)} = tanpa rem`, p.boleh === true && p.tungguDetik === 0);
}
cek('jendela 0 = tanpa rem', L.putusanJendela([T0, T0, T0], 3, 0, T0).boleh === true);

// ============================================================
bagian('6. Lama tunggu diucapkan seperti orang bicara');

cek('45 detik', L.formatTunggu(45) === '45 detik', L.formatTunggu(45));
cek('59 detik', L.formatTunggu(59) === '59 detik', L.formatTunggu(59));
cek('60 detik jadi 1 menit', L.formatTunggu(60) === '1 menit', L.formatTunggu(60));
cek('600 detik jadi 10 menit', L.formatTunggu(600) === '10 menit', L.formatTunggu(600));
cek('dibulatkan ke atas, jangan sampai menyuruh datang kecepatan',
  L.formatTunggu(601) === '11 menit', L.formatTunggu(601));
cek('3600 detik jadi 1 jam', L.formatTunggu(3600) === '1 jam', L.formatTunggu(3600));
cek('3900 detik jadi 1 jam 5 menit', L.formatTunggu(3900) === '1 jam 5 menit', L.formatTunggu(3900));
cek('0 tidak jadi teks aneh', L.formatTunggu(0) === '0 detik', L.formatTunggu(0));
cek('negatif tidak jadi teks aneh', L.formatTunggu(-5) === '0 detik', L.formatTunggu(-5));
cek('bukan angka tidak melempar', L.formatTunggu('x') === '0 detik', L.formatTunggu('x'));

// ============================================================
bagian('7. Angka tier: gratisan 3 per jam');

const gratis = getPremiumBenefits('Free');
cek('gratisan 3 unduhan per jam (angka permintaan owner)', gratis.mediaPerHour === 3,
  String(gratis.mediaPerHour));

const urut = ['Perunggu', 'Silver', 'Gold', 'Diamond'];
for (let i = 0; i < urut.length; i++) {
  const t = PREMIUM_TIERS[urut[i]].benefits;
  cek(`${urut[i]} punya mediaPerHour`, Number.isFinite(Number(t.mediaPerHour)), String(t.mediaPerHour));
  if (i > 0) {
    const bawah = PREMIUM_TIERS[urut[i - 1]].benefits;
    cek(`${urut[i]}: per jam lebih besar dari ${urut[i - 1]}`, t.mediaPerHour > bawah.mediaPerHour,
      `${bawah.mediaPerHour} vs ${t.mediaPerHour}`);
  }
  // Batas per jam yang lebih besar dari jatah harian tidak pernah menggigit —
  // itu angka hiasan, bukan rem.
  cek(`${urut[i]}: per jam tidak melebihi jatah harian`, t.mediaPerHour <= t.mediaDailyLimit,
    `${t.mediaPerHour}/jam vs ${t.mediaDailyLimit}/hari`);
  // Dan sebaliknya: kalau terlalu kecil, jatah harian yang sudah dibayar tidak
  // akan pernah bisa dihabiskan dalam satu hari.
  cek(`${urut[i]}: jatah harian masih bisa dihabiskan dalam sehari`,
    t.mediaPerHour * 24 >= t.mediaDailyLimit, `${t.mediaPerHour}*24 vs ${t.mediaDailyLimit}`);
}
cek('gratisan di bawah Perunggu', gratis.mediaPerHour < PREMIUM_TIERS.Perunggu.benefits.mediaPerHour);
cek('gratisan: per jam tidak melebihi jatah harian', gratis.mediaPerHour <= gratis.mediaDailyLimit);
cek('gratisan: jatah harian masih bisa dihabiskan dalam sehari',
  gratis.mediaPerHour * 24 >= gratis.mediaDailyLimit);
cek('tier tak dikenal jatuh ke angka gratisan',
  getPremiumBenefits('TierKarangan').mediaPerHour === gratis.mediaPerHour);

// ============================================================
bagian('8. Jalur database yang sebenarnya (berkas sementara)');

const { openDb, runQuery, allQuery } = await import(REPO + 'src/database/connection.js');
await openDb();
await runQuery(`
  CREATE TABLE IF NOT EXISTS media_usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL, usage_date TEXT NOT NULL, count INTEGER DEFAULT 0,
    UNIQUE(jid, usage_date))`);
await runQuery(`
  CREATE TABLE IF NOT EXISTS media_hourly_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, jid TEXT NOT NULL, ts INTEGER NOT NULL)`);

const G = await import(REPO + 'src/database/gamesDb.js');
const ORANG = '628111@s.whatsapp.net';
const LAIN = '628222@s.whatsapp.net';

cek('belum pernah unduh: boleh', (await G.periksaKuotaMediaJam(ORANG, 3)).boleh === true);

await G.incrementMediaUsage(ORANG);
await G.incrementMediaUsage(ORANG);
const duaKali = await G.periksaKuotaMediaJam(ORANG, 3);
cek('sesudah 2 unduhan: masih boleh', duaKali.boleh === true, JSON.stringify(duaKali));
cek('tercatat 2', duaKali.dipakai === 2);

await G.incrementMediaUsage(ORANG);
const tigaKali = await G.periksaKuotaMediaJam(ORANG, 3);
cek('sesudah 3 unduhan: DITOLAK', tigaKali.boleh === false, JSON.stringify(tigaKali));
cek('disuruh menunggu, dan tunggunya masuk akal',
  tigaKali.tungguDetik > 3500 && tigaKali.tungguDetik <= 3600, String(tigaKali.tungguDetik));

cek('jatah HARIAN ikut tercatat dari fungsi yang sama',
  (await G.getMediaUsageToday(ORANG)) === 3, String(await G.getMediaUsageToday(ORANG)));

cek('orang lain tidak ikut kena', (await G.periksaKuotaMediaJam(LAIN, 3)).boleh === true);

// Stempel yang sudah lewat sejam benar-benar tidak lagi menahan.
await runQuery("UPDATE media_hourly_logs SET ts = ? WHERE jid = ?", [Date.now() - 2 * 3600_000, ORANG]);
cek('sesudah lewat sejam: jatahnya kembali', (await G.periksaKuotaMediaJam(ORANG, 3)).boleh === true);

// Baris usang dibuang sendiri, tabelnya tidak tumbuh selamanya.
await G.bersihkanPemakaianMediaLama();
const tersisa = await allQuery("SELECT COUNT(*) AS n FROM media_hourly_logs WHERE jid = ?", [ORANG]);
cek('baris usang dibersihkan', tersisa[0].n <= 1, String(tersisa[0].n));

// Owner & admin toko lewat: batas 0 berarti tanpa rem.
for (let i = 0; i < 20; i++) await G.incrementMediaUsage(LAIN);
cek('batas 0 = tanpa rem walau 20 unduhan', (await G.periksaKuotaMediaJam(LAIN, 0)).boleh === true);
cek('tapi dengan batas 3 tetap tertahan', (await G.periksaKuotaMediaJam(LAIN, 3)).boleh === false);

cek('uji ini memang tidak menyentuh database asli', process.env.SHOP_DB_PATH === DB_SEMENTARA);

console.log(`\n${'='.repeat(50)}`);
console.log(`HASIL: ${lulus} lulus, ${gagal} gagal`);
console.log('='.repeat(50));

process.exit(gagal > 0 ? 1 : 0);
