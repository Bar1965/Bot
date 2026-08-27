/**
 * UJI ASAP ARENA KARTU MONSTER
 *
 * AGENTS.md menyatakan proyek ini tidak bisa diuji tanpa sesi WhatsApp yang
 * tertaut. Untuk Arena Kartu itu ternyata tidak sepenuhnya benar: satu-satunya
 * yang dibutuhkan handleTcgCommand dari `sock` adalah `sendMessage`, dan
 * lapisan database memakai berkas SQLite biasa. Keduanya bisa dipalsukan.
 *
 * Berkas ini menjalankan SETIAP sub-perintah `.tcg` sungguhan — lewat router
 * yang sama yang dipakai pemain — di atas database sementara, lalu memeriksa
 * bahwa hasilnya benar-benar terjadi, bukan sekadar tidak melempar. Ditambah
 * uji perender kartu dan invarian mesin tempur.
 *
 * Pakai:
 *   node scripts/tcgSmokeTest.mjs
 *
 * KEAMANAN: skrip pindah ke direktori sementara SEBELUM memuat lapisan
 * database, karena `connection.js` membuka './shop.db' relatif terhadap
 * direktori kerja. Tanpa itu, menjalankan uji ini dari akar repo akan
 * menyuntikkan data uji ke database produksi pemilik bot.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';

const AKAR = path.resolve(import.meta.dirname, '..');
const REPO = pathToFileURL(AKAR).href + '/';

const kotakPasir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-uji-'));
process.chdir(kotakPasir);
console.log(`Kotak pasir: ${kotakPasir}`);

// Nilai boneka untuk variabel yang diwajibkan config.js.
//
// Sengaja TIDAK memuat `.env` sungguhan: uji ini tidak perlu satu pun kredensial
// asli, dan tidak memuatnya berarti tidak ada rahasia yang bisa bocor ke log
// atau ke database kotak pasir. Nilai di bawah hanya untuk melewati pemeriksaan
// wajib saat modul dimuat.
process.env.JWT_SECRET ||= 'uji-asap-bukan-rahasia-sungguhan';
process.env.ADMIN_USER ||= 'ujiasap';
process.env.ADMIN_PASSWORD_HASH ||= '$2b$10$0000000000000000000000000000000000000000000000000000';

// Impor HARUS sesudah chdir — lihat catatan keamanan di atas.
const db = await import(REPO + 'database.js');
const { handleTcgCommand } = await import(REPO + 'src/games/tcg/index.js');
const { cooldowns } = await import(REPO + 'src/games/helpers.js');
const {
  KARTU, statKartu, getKartu, PETA_COST, MAKS_LEVEL,
  periksaKeseimbangan, TOTAL_KARTU
} = await import(REPO + 'src/games/tcg/cards.js');
const { bufferKartu, bufferBanyakKartu } = await import(REPO + 'src/games/tcg/gambar.js');
const { simulate3v3, TOWER_FLOORS, getTowerFloor, dekAbadi } = await import(REPO + 'src/games/tcg/battle.js');

await db.openDb();
await db.initDb();

// ============================================================
// PERANCAH
// ============================================================

const terkirim = [];
const sock = {
  sendMessage: async (jid, isi) => {
    terkirim.push({ jid, teks: isi.text || isi.caption || '', gambar: !!isi.image });
    return { key: { id: 'uji' } };
  }
};

const GRUP = '120363000000000000@g.us';
const A = '628333333333@s.whatsapp.net';
const B = '628444444444@s.whatsapp.net';

const pesan = (nama, mention = null) => ({
  key: { remoteJid: GRUP, participant: A },
  pushName: nama,
  message: mention
    ? { extendedTextMessage: { contextInfo: { mentionedJid: [mention] } } }
    : { conversation: 'x' }
});

let perintah = 0;
let periksa = 0;
const gagal = [];
let diam = process.argv.includes('--ringkas');

async function jalankan(label, args, opts = {}) {
  const i = terkirim.length;
  // Router menolak perintah yang datang < 800ms sesudah yang sebelumnya.
  // Membersihkan peta cooldown jauh lebih baik daripada menaburkan sleep:
  // uji ini jadi hitungan detik, bukan menit.
  cooldowns.clear();
  try {
    const hasil = await handleTcgCommand({
      sock,
      jid: GRUP,
      senderNumber: opts.sebagai || A,
      messageObj: opts.messageObj || pesan('Penguji'),
      args,
      isFromGroup: opts.grup !== false,
      isAdmin: false,
      isOwner: !!opts.owner,
      isStoreAdmin: !!opts.owner
    });
    if (terkirim.length === i) {
      gagal.push({ label, err: 'tidak membalas apa pun' });
      console.log(`  🔇 ${label}`);
      return '';
    }
    if (hasil !== true) {
      gagal.push({ label, err: `mengembalikan ${hasil}, bukan true` });
      console.log(`  ⚠️  ${label}`);
      return '';
    }
    perintah++;
    const teks = terkirim.at(-1).teks;
    if (!diam) console.log(`  ✅ ${label.padEnd(36)} ${teks.split('\n')[0].slice(0, 46)}`);
    return teks;
  } catch (e) {
    gagal.push({ label, err: e?.stack || String(e) });
    console.log(`  ❌ ${label} — ${e?.message || e}`);
    return '';
  }
}

/** Membedakan "tidak melempar" dari "benar-benar melakukan sesuatu". */
function harus(label, teks, pola) {
  periksa++;
  const ok = pola instanceof RegExp ? pola.test(teks) : String(teks).includes(pola);
  if (!ok) {
    gagal.push({ label: `periksa: ${label}`, err: `tidak menemukan ${pola}\n--- pesan ---\n${String(teks).slice(0, 600)}` });
    console.log(`     ❌ ${label}`);
  } else if (!diam) {
    console.log(`     ✓ ${label}`);
  }
}

const benar = (label, syarat) => {
  periksa++;
  if (!syarat) {
    gagal.push({ label, err: 'syarat tidak terpenuhi' });
    console.log(`  ❌ ${label}`);
  }
};

// ============================================================
// 1. ALUR PEMAIN BARU
// ============================================================
console.log('\n════ 1. ALUR PEMAIN BARU ════');
let t = await jalankan('.tcg (menu kosong)', ['tcg']);
harus('mengajak mulai', t, '.tcg mulai');
t = await jalankan('.tcg mulai', ['tcg', 'mulai']);
harus('paket pemula diberikan', t, 'PAKET PEMULA DITERIMA');
harus('dek otomatis terpasang', t, /Dek 3v3 pemula sudah otomatis dipasang/);
t = await jalankan('.tcg mulai (ulang)', ['tcg', 'mulai']);
harus('menolak klaim kedua', t, 'sudah pernah mengambil');

// ============================================================
// 2. SEMUA LAYAR INFORMASI
// ============================================================
console.log('\n════ 2. LAYAR INFORMASI ════');
for (const [label, args] of [
  ['.tcg menu', ['tcg']],
  ['.tcg bantuan', ['tcg', 'bantuan']],
  ['.tcg bantuan dasar', ['tcg', 'bantuan', 'dasar']],
  ['.tcg bantuan dek', ['tcg', 'bantuan', 'dek']],
  ['.tcg bantuan tarung', ['tcg', 'bantuan', 'tarung']],
  ['.tcg bantuan naik', ['tcg', 'bantuan', 'naik']],
  ['.tcg bantuan farming', ['tcg', 'bantuan', 'farming']],
  ['.tcg koleksi', ['tcg', 'koleksi']],
  ['.tcg koleksi rare', ['tcg', 'koleksi', 'rare']],
  ['.tcg koleksi api', ['tcg', 'koleksi', 'api']],
  ['.tcg rate', ['tcg', 'rate']],
  ['.tcg keping', ['tcg', 'keping']],
  ['.tcg sinergi', ['tcg', 'sinergi']],
  ['.tcg serpihan', ['tcg', 'serpihan']],
  ['.tcg ransum', ['tcg', 'ransum']],
  ['.tcg misi', ['tcg', 'misi']],
  ['.tcg spar', ['tcg', 'spar']],
  ['.tcg menara', ['tcg', 'menara']],
  ['.tcg gerbang', ['tcg', 'gerbang']],
  ['.tcg ekspedisi', ['tcg', 'ekspedisi']],
  ['.tcg dek', ['tcg', 'dek']]
]) await jalankan(label, args);

console.log('\n  -- pintasan angka menu --');
for (const n of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) {
  await jalankan(`.tcg ${n}`, ['tcg', n]);
}

// ============================================================
// 3. MENYIAPKAN PEMAIN KAYA
// ============================================================
console.log('\n════ 3. SUNTIK KARTU, KEPING, SERPIHAN ════');
for (const id of ['CMN07', 'CMN10', 'CMN05', 'CMN01', 'CMN18', 'RAR06', 'EPC03', 'LGD03', 'LGD06', 'MYT01']) {
  await db.tcgTambahKartu(A, id, 5);
}
for (const id of ['CMN03', 'CMN11', 'CMN15', 'RAR01']) await db.tcgTambahKartu(B, id, 3);
await db.tcgAddKeping(A, 50000, 'UJI');
await db.tcgAddKeping(B, 50000, 'UJI');
for (const r of db.TCG_RARITY) {
  await db.tcgTambahSerpihan(A, r, 60);
  await db.tcgTambahSerpihan(B, r, 60);
}
for (const it of Object.keys(db.TCG_RANSUM)) await db.tcgTambahItem(A, it, 3);
await db.tcgTandaiStarter(B);
await db.tcgCatatProfil(A, 'Penguji');
await db.tcgCatatProfil(B, 'Lawan');
for (const [s, id] of [[1, 'CMN07'], [2, 'CMN10'], [3, 'CMN05']]) await db.tcgSetDeckSlot(A, s, id, PETA_COST);
for (const [s, id] of [[1, 'CMN03'], [2, 'CMN11'], [3, 'CMN15']]) await db.tcgSetDeckSlot(B, s, id, PETA_COST);
console.log('  suntikan selesai');

// ============================================================
// 4. PRATINJAU & NAIK LEVEL
// ============================================================
console.log('\n════ 4. PRATINJAU & NAIK LEVEL ════');
t = await jalankan('.tcg kartu CMN07', ['tcg', 'kartu', 'CMN07']);
harus('tangga level tampil', t, 'TANGGA LEVEL');
harus('lima baris level', t, /Lv\.5\s+ATK/);
harus('level sekarang ditandai', t, '  <');
harus('KRIT tampil', t, /KRIT\s+\d+%/);
harus('CP tampil', t, /CP\s+\d/);
harus('pratinjau naik tampil', t, 'NAIK KE Lv.2');
harus('biaya serpihan tampil', t, /Serpihan Common: \*\d+\*/);
harus('biaya keping tampil', t, /Keping: \*[\d.]+\*/);
harus('saran counter elemen', t, 'Rugi melawan');

// Angka di tangga harus persis sama dengan statKartu — kalau tidak, pemain
// membayar berdasarkan angka yang salah.
const contoh = getKartu('CMN07');
for (let lv = 1; lv <= MAKS_LEVEL; lv++) {
  const s = statKartu(contoh, lv);
  harus(`tangga Lv.${lv} cocok statKartu`, t, new RegExp(`Lv\\.${lv}\\s+ATK\\s+${s.atk}\\s+HP\\s+${s.hp.toLocaleString('id-ID')}`));
}

t = await jalankan('.tcg naik (daftar)', ['tcg', 'naik']);
harus('mendaftar yang siap naik', t, 'SIAP NAIK LEVEL');
harus('menyebut kenaikan CP', t, /\+[\d.]+ CP/);

t = await jalankan('.tcg naik CMN07', ['tcg', 'naik', 'CMN07']);
harus('naik ke Level 2', t, 'naik ke *Level 2*');
harus('delta ATK tampil', t, /ATK\s+\d+ ➜ \*\d+\*\s+_\(\+\d+\)_/);
harus('delta HP tampil', t, /HP\s+[\d.]+ ➜ \*[\d.]+\*/);
harus('delta CP tampil', t, /CP\s+[\d.]+ ➜/);
harus('biaya terpakai dilaporkan', t, /Biaya: \d+ Serpihan \+ [\d.]+ Keping/);
harus('menawarkan level berikutnya', t, 'NAIK KE Lv.3');

for (const n of [3, 4, 5]) {
  t = await jalankan(`.tcg naik CMN07 (Lv.${n})`, ['tcg', 'naik', 'CMN07']);
  harus(`sampai Level ${n}`, t, `naik ke *Level ${n}*`);
}
t = await jalankan('.tcg naik CMN07 (maks)', ['tcg', 'naik', 'CMN07']);
harus('menolak di level maksimal', t, `level maksimal (${MAKS_LEVEL})`);

// ============================================================
// 5. DEK
// ============================================================
console.log('\n════ 5. DEK ════');
t = await jalankan('.tcg dek', ['tcg', 'dek']);
harus('total CP dek tampil', t, /Total CP: \*[\d.]+\*/);
harus('sinergi menyala', t, 'SINERGI AKTIF');
harus('Pasukan Ramping menyala', t, 'Pasukan Ramping');
harus('KRIT per kartu tampil', t, /KRIT \d+%/);

t = await jalankan('.tcg pasang 1 LGD03', ['tcg', 'pasang', '1', 'LGD03']);
harus('pasang berhasil', t, 'dipasang ke *Slot 1*');
t = await jalankan('.tcg pasang 2 MYT01 (pas 10★)', ['tcg', 'pasang', '2', 'MYT01']);
harus('menerima yang pas di batas', t, /dipasang ke \*Slot 2\*/);
harus('melaporkan 10/10', t, '10/10');
t = await jalankan('.tcg pasang 3 LGD06 (13★)', ['tcg', 'pasang', '3', 'LGD06']);
harus('menolak yang lewat anggaran', t, 'Melebihi Batas');
t = await jalankan('.tcg tukar 1 2', ['tcg', 'tukar', '1', '2']);
harus('tukar berhasil', t, '⇄');
await jalankan('.tcg pasang 1 CMN07', ['tcg', 'pasang', '1', 'CMN07']);
await jalankan('.tcg pasang 2 CMN10', ['tcg', 'pasang', '2', 'CMN10']);
await jalankan('.tcg pasang 3 CMN05', ['tcg', 'pasang', '3', 'CMN05']);

// ============================================================
// 6. BERTARUNG
// ============================================================
console.log('\n════ 6. BERTARUNG ════');
t = await jalankan('.tcg spar lawan', ['tcg', 'spar', 'lawan']);
harus('sparring benar-benar jalan', t, 'HASIL SPARRING');
harus('laporan ronde ada', t, 'RONDE 1');
harus('laporan sinergi ada', t, /🔹|🔻/);
harus('ada hasil', t, /KAMU MENANG|KAMU KALAH|SERI/);

for (let i = 1; i <= 3; i++) {
  t = await jalankan(`.tcg menara lawan (#${i})`, ['tcg', 'menara', 'lawan']);
  harus('menara bertarung', t, /KEMENANGAN DI LANTAI|KALAH DI LANTAI|Stamina Menara habis/);
}
t = await jalankan('.tcg ransum menara', ['tcg', 'ransum', 'menara']);
harus('ransum memulihkan energi', t, 'DIPAKAI');

const gerbangBuka = db.tcgGerbangHariIni();
t = await jalankan(`.tcg gerbang ${gerbangBuka[0]}`, ['tcg', 'gerbang', gerbangBuka[0].toLowerCase()]);
harus('gerbang bertarung', t, /MENANG|KALAH/);
harus('sisa energi dilaporkan', t, 'Sisa energi Gerbang');

// ============================================================
// 7. EKSPEDISI
// ============================================================
console.log('\n════ 7. EKSPEDISI ════');
t = await jalankan('.tcg ekspedisi CMN01 2', ['tcg', 'ekspedisi', 'CMN01', '2']);
harus('kartu berangkat', t, 'berangkat ekspedisi');
harus('perkiraan hasil tampil', t, 'Perkiraan hasil');
t = await jalankan('.tcg ekspedisi klaim (dini)', ['tcg', 'ekspedisi', 'klaim']);
harus('menolak klaim dini', t, 'Belum ada kartu yang pulang');
await db.runQuery("UPDATE tcg_ekspedisi SET selesai_at = ? WHERE owner_jid = ?", [Date.now() - 1000, A]);
t = await jalankan('.tcg ekspedisi klaim', ['tcg', 'ekspedisi', 'klaim']);
harus('klaim berhasil', t, 'EKSPEDISI PULANG');
harus('Keping masuk', t, /\+[\d.]+ Keping/);
harus('serpihan masuk', t, 'Serpihan');

await jalankan('.tcg ekspedisi CMN18 4', ['tcg', 'ekspedisi', 'CMN18', '4']);
await db.runQuery("DELETE FROM tcg_collection WHERE owner_jid = ? AND card_id = 'CMN18'", [A]);
await db.tcgTambahKartu(A, 'CMN18', 1);
t = await jalankan('.tcg pasang 3 CMN18 (sedang pergi)', ['tcg', 'pasang', '3', 'CMN18']);
harus('kartu bertugas tidak bisa dipasang', t, /sedang pergi ekspedisi|sedang bertugas/);

// ============================================================
// 8. DUEL & DROP
// ============================================================
console.log('\n════ 8. DUEL & DROP ════');
t = await jalankan('.tcg duel @B 100', ['tcg', 'duel', '@' + B.split('@')[0], '100'], { messageObj: pesan('Penguji', B) });
harus('tantangan terkirim', t, 'TANTANGAN DUEL');
harus('biaya dek penantang tampil', t, /dek \d+\/\d+★/);
t = await jalankan('B: .tcg gas', ['tcg', 'gas'], { sebagai: B, messageObj: pesan('Lawan') });
harus('duel selesai', t, 'HASIL PERTANDINGAN DUEL');
harus('pemenang diumumkan', t, 'PEMENANG:');
harus('taruhan diselesaikan', t, /pot taruhan|dikembalikan/);

await jalankan('.tcg duel @B 10', ['tcg', 'duel', '@' + B.split('@')[0], '10'], { messageObj: pesan('Penguji', B) });
t = await jalankan('B: .tcg tolak', ['tcg', 'tolak'], { sebagai: B, messageObj: pesan('Lawan') });
harus('tolak bekerja', t, 'ditolak');

await db.tcgBuatDrop(GRUP, ['CMN01', 'RAR01', 'EPC01'], 90);
t = await jalankan('.tcg ambil 2', ['tcg', 'ambil', '2']);
harus('kartu tersambar', t, 'DISAMBAR');
t = await jalankan('.tcg ambil 3 (sudah ambil)', ['tcg', 'ambil', '3']);
harus('satu orang satu kartu', t, 'sudah mengambil');
t = await jalankan('B: .tcg ambil 2', ['tcg', 'ambil', '2'], { sebagai: B, messageObj: pesan('Lawan') });
harus('kartu yang sama ditolak', t, 'keburu disambar');

// ============================================================
// 9. EKONOMI
// ============================================================
console.log('\n════ 9. EKONOMI ════');
t = await jalankan('.tcg daily', ['tcg', 'daily']);
harus('harian terklaim', t, 'HADIAH HARIAN');
harus('beruntun hari ke-1 tampil', t, 'BERUNTUN HARI KE-1');
harus('umpan tonggak berikutnya', t, /tonggak hari ke-\d+/);
t = await jalankan('.tcg daily (ulang)', ['tcg', 'daily']);
harus('menolak klaim kedua', t, 'sudah diambil');
harus('beruntun tetap ditampilkan saat ditolak', t, /Beruntun: \*1 hari\*/);
t = await jalankan('.tcg gacha', ['tcg', 'gacha']);
harus('gacha jalan', t, 'TARIKAN KARTU');
t = await jalankan('.tcg gacha10', ['tcg', 'gacha10']);
harus('gacha10 jalan', t, /TARIKAN ×10|Jatah tarikan/);
t = await jalankan('.tcg serpih CMN10 2', ['tcg', 'serpih', 'CMN10', '2']);
harus('serpih berhasil', t, 'dipecah jadi');
t = await jalankan('.tcg jual CMN10 1', ['tcg', 'jual', 'CMN10', '1']);
harus('jual berhasil', t, 'terjual seharga');
t = await jalankan('.tcg lebur common', ['tcg', 'lebur', 'common']);
harus('lebur berhasil', t, 'dilebur jadi');
t = await jalankan('.tcg misi klaim', ['tcg', 'misi', 'klaim']);
harus('misi bisa diklaim', t, /HADIAH MISI TERKLAIM|Belum ada misi/);

// ============================================================
// 9b. LAPISAN RETENSI: BERUNTUN, PERINGKAT, GELAR, TONGGAK,
//     MISI MINGGUAN, MENARA ABADI, BARTER
// ============================================================
console.log('\n════ 9b. RETENSI ════');

// --- Beruntun harian: lanjut, putus, dan tonggak ---
{
  const hariIni = db.tcgTanggalHariIni();
  const kemarin = db.tcgHariSebelum(hariIni);

  // Beruntun disetel ke hari ke-2 kemarin, lalu klaim hari ini harus jadi 3
  // DAN memicu tonggak hari ke-3. Menggeser tanggal jauh lebih jujur daripada
  // memanggil fungsi internal: yang diuji adalah aturan kalendernya.
  await db.runQuery(
    "UPDATE tcg_pity SET gratis_tanggal = NULL WHERE owner_jid = ?", [A]);
  await db.runQuery(
    "UPDATE tcg_streak SET streak = 2, terpanjang = 2, tanggal_terakhir = ? WHERE owner_jid = ?",
    [kemarin, A]);

  t = await jalankan('.tcg daily (hari ke-3)', ['tcg', 'daily']);
  harus('beruntun lanjut ke 3', t, 'BERUNTUN HARI KE-3');
  harus('tonggak hari ke-3 dibayar', t, 'TONGGAK HARI KE-3');

  const s3 = await db.tcgGetStreak(A);
  benar('streak tersimpan 3', s3.streak === 3);
  benar('bonus beruntun hari ke-3 = 20', db.tcgBonusStreak(3) === 20);
  benar('bonus beruntun mentok di maks', db.tcgBonusStreak(999) === db.TCG_STREAK_BONUS_MAKS);

  // Melewatkan satu hari harus memutus beruntun, bukan melanjutkannya.
  await db.runQuery("UPDATE tcg_pity SET gratis_tanggal = NULL WHERE owner_jid = ?", [A]);
  await db.runQuery(
    "UPDATE tcg_streak SET tanggal_terakhir = ? WHERE owner_jid = ?",
    [db.tcgHariSebelum(db.tcgHariSebelum(kemarin)), A]);
  t = await jalankan('.tcg daily (bolong sehari)', ['tcg', 'daily']);
  harus('beruntun putus', t, 'terputus');
  const sPutus = await db.tcgGetStreak(A);
  benar('beruntun kembali ke 1', sPutus.streak === 1);
  benar('rekor terpanjang tidak ikut turun', sPutus.terpanjang >= 3);

  // Baca saja tidak boleh menulis: memanggil tcgGetStreak berkali-kali tidak
  // boleh menggeser tanggal terakhir.
  const sebelumBaca = await db.getQuery("SELECT tanggal_terakhir, streak FROM tcg_streak WHERE owner_jid = ?", [A]);
  await db.tcgGetStreak(A); await db.tcgGetStreak(A);
  const sesudahBaca = await db.getQuery("SELECT tanggal_terakhir, streak FROM tcg_streak WHERE owner_jid = ?", [A]);
  benar('membaca beruntun tidak mengubah apa pun',
    sebelumBaca.tanggal_terakhir === sesudahBaca.tanggal_terakhir && sebelumBaca.streak === sesudahBaca.streak);
}

// --- Misi harian diundi, bukan tetap ---
{
  const hariIni = db.tcgTanggalHariIni();
  const undian = db.tcgMisiHariIni(A, hariIni);
  benar('3 misi harian diundi', undian.length === 3);
  benar('undian stabil dalam satu hari',
    JSON.stringify(db.tcgMisiHariIni(A, hariIni)) === JSON.stringify(undian));
  benar('semua id misi ada di kolam',
    undian.every(m => db.TCG_MISI_POOL.some(x => x.id === m.id)));
  benar('tiga misi berbeda', new Set(undian.map(m => m.id)).size === 3);

  // Sepanjang 60 hari, tiap keranjang harus benar-benar berotasi dan slot
  // pertama harus selalu berisi misi yang bisa dikerjakan sendirian.
  const soloIds = new Set(['SPAR', 'SPAR_MAIN', 'GERBANG', 'EKSPEDISI', 'PANEN']);
  const variasi = [new Set(), new Set(), new Set()];
  let selaluAdaSolo = true;
  for (let d = 0; d < 60; d++) {
    const tgl = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
    const u = db.tcgMisiHariIni(A, tgl);
    u.forEach((m, i) => variasi[i].add(m.id));
    if (!u.some(m => soloIds.has(m.id))) selaluAdaSolo = false;
  }
  benar('keranjang 1 berotasi', variasi[0].size >= 3);
  benar('keranjang 2 berotasi', variasi[1].size >= 3);
  benar('keranjang 3 berotasi', variasi[2].size >= 3);
  benar('selalu ada satu misi jalur solo', selaluAdaSolo);

  // Aksi yang bukan misi hari ini diabaikan diam-diam, tidak melempar.
  const bukanHariIni = db.TCG_MISI_POOL.find(m => !undian.some(u => u.id === m.id));
  const r = await db.tcgCatatProgresMisi(A, bukanHariIni.id, 1);
  benar('aksi di luar undian diabaikan diam-diam', r.baruSelesai === false);
}

// --- Misi mingguan ---
{
  t = await jalankan('.tcg mingguan', ['tcg', 'mingguan']);
  harus('layar mingguan tampil', t, 'MISI MINGGUAN ARENA');
  harus('bonus tuntas mingguan tampil', t, 'Bonus Tuntas Mingguan');

  t = await jalankan('.tcg mingguan klaim (kosong)', ['tcg', 'mingguan', 'klaim']);
  harus('menolak klaim kosong', t, /Belum ada misi mingguan|HADIAH MISI MINGGUAN/);

  // Tuntaskan satu misi mingguan lewat pencatat aksi, lalu klaim.
  const def = db.TCG_MISI_MINGGUAN.find(m => m.id === 'M_TARIK');
  await db.tcgCatatMingguan(A, 'GACHA', def.target);
  const m1 = await db.tcgGetMisiMingguan(A);
  benar('progres mingguan terisi', m1.daftar.find(x => x.id === 'M_TARIK').selesai);
  t = await jalankan('.tcg mingguan klaim', ['tcg', 'mingguan', 'klaim']);
  harus('hadiah mingguan terbayar', t, 'HADIAH MISI MINGGUAN TERKLAIM');
  t = await jalankan('.tcg mingguan klaim (dobel)', ['tcg', 'mingguan', 'klaim']);
  harus('tidak bisa diklaim dua kali', t, 'Belum ada misi mingguan');

  benar('kunci minggu adalah hari Senin',
    new Date(`${db.tcgSeninMinggu()}T00:00:00Z`).getUTCDay() === 1);
}

// --- Peringkat & musim ---
{
  t = await jalankan('.tcg rank', ['tcg', 'rank']);
  harus('layar peringkat tampil', t, 'PERINGKAT ARENA');
  harus('tier tampil', t, /Perunggu|Perak|Emas|Platina|Diamond|Master|Legenda/);
  t = await jalankan('.tcg rank top', ['tcg', 'rank', 'top']);
  harus('papan peringkat tampil', t, /PERINGKAT ARENA — MUSIM \d+/);

  benar('tier naik seiring poin', db.tcgTier(1850).id === 'LEGENDA' && db.tcgTier(0).id === 'PERUNGGU');
  benar('reset lunak menahan lantai 800', db.tcgResetLunak(0) === 800);
  benar('reset lunak memotong separuh jarak', db.tcgResetLunak(1800) === 1400);
  benar('poin awal tidak bergeser saat reset', db.tcgResetLunak(1000) === 1000);

  const C = '628555555555@s.whatsapp.net';
  const sebelum = await db.tcgGetRank(A);
  const laga = await db.tcgCatatLaga(A, 1, { k: db.TCG_K_DUEL, lawanJid: C });
  benar('menang menaikkan poin', laga.berperingkat && laga.poin > sebelum.poin);
  benar('poin lawan turun sebesar yang sama', laga.lawan.delta === -laga.delta);

  // Batas pasangan: laga berperingkat melawan orang yang sama dibatasi per hari.
  for (let i = 1; i < db.TCG_RANK_MAKS_PASANGAN; i++) {
    await db.tcgCatatLaga(A, 1, { k: db.TCG_K_DUEL, lawanJid: C });
  }
  const lewat = await db.tcgCatatLaga(A, 1, { k: db.TCG_K_DUEL, lawanJid: C });
  benar('laga ke-N+1 dengan lawan sama tidak berperingkat',
    lewat.berperingkat === false && lewat.reason === 'BATAS_PASANGAN');

  // Sparring tidak boleh menurunkan poin pemilik dek bayangan.
  const bPoinSebelum = (await db.tcgGetRank(B)).poin;
  await db.tcgCatatLaga(A, 1, { k: db.TCG_K_SPAR, poinLawanTetap: bPoinSebelum });
  const bPoinSesudah = (await db.tcgGetRank(B)).poin;
  benar('dek bayangan tidak kehilangan poin', bPoinSebelum === bPoinSesudah);

  // Menang melawan pemain yang jauh lebih lemah tetap memberi minimal 1 poin.
  const D = '628666666666@s.whatsapp.net';
  await db.runQuery("UPDATE tcg_rank SET poin = 100 WHERE owner_jid = ? AND musim = ?",
    [D, db.tcgMusimSekarang().nomor]);
  await db.tcgGetRank(D);
  await db.runQuery("UPDATE tcg_rank SET poin = 100 WHERE owner_jid = ? AND musim = ?",
    [D, db.tcgMusimSekarang().nomor]);
  const lawanLemah = await db.tcgCatatLaga(A, 1, { k: db.TCG_K_DUEL, lawanJid: D });
  benar('menang selalu bernilai minimal +1', lawanLemah.delta >= 1);

  benar('musim berjalan minimal 1', db.tcgMusimSekarang().nomor >= 1);
  benar('hari musim di dalam rentang',
    db.tcgMusimSekarang().hariKe >= 1 && db.tcgMusimSekarang().hariKe <= db.TCG_MUSIM_HARI);
}

// --- Pergantian musim: hadiah dibayar malas, sekali saja ---
{
  const E = '628777777777@s.whatsapp.net';
  const musimIni = db.tcgMusimSekarang().nomor;
  await db.tcgCatatProfil(E, 'Juara Musim Lalu');
  // Baris musim sebelumnya, peringkat Master, hadiah belum diambil.
  await db.runQuery(
    `INSERT OR REPLACE INTO tcg_rank
       (owner_jid, musim, poin, tertinggi, menang, kalah, seri, beruntun, hadiah_diklaim)
     VALUES (?, ?, 1650, 1700, 20, 4, 1, 0, 0)`,
    [E, musimIni - 1]);

  const r1 = await db.tcgGetRank(E, { umumkan: true });
  benar('hadiah musim lalu dibayar saat pertama menyentuh peringkat', !!r1.hadiahMusimLalu);
  benar('tier akhir musim terbaca Master', r1.hadiahMusimLalu?.tier?.id === 'MASTER');
  benar('gelar musiman diberikan untuk Diamond ke atas', !!r1.hadiahMusimLalu?.gelar);
  benar('poin musim baru hasil reset lunak', r1.poin === db.tcgResetLunak(1650));

  const r2 = await db.tcgGetRank(E, { umumkan: true });
  benar('hadiah musim tidak diumumkan dua kali', r2.hadiahMusimLalu === null);
  benar('poin musim baru tidak berubah saat dibaca ulang', r2.poin === r1.poin);

  // Layar yang tidak mencetak apa pun soal musim tidak boleh menghabiskan
  // pengumumannya. Ini yang membuat hadiah 2.500 Keping terbayar diam-diam.
  const G = '628999999999@s.whatsapp.net';
  await db.runQuery(
    `INSERT OR REPLACE INTO tcg_rank
       (owner_jid, musim, poin, tertinggi, menang, kalah, seri, beruntun, hadiah_diklaim, hadiah_diumumkan)
     VALUES (?, ?, 1900, 1900, 30, 2, 0, 0, 0, 0)`,
    [G, musimIni - 1]);
  const diam1 = await db.tcgGetRank(G);                    // jalur senyap (mis. kartu duel)
  benar('jalur senyap tidak mengumumkan', diam1.hadiahMusimLalu === null);
  const dompetG = await db.tcgGetWallet(G);
  benar('jalur senyap tetap membayar hadiahnya', dompetG.keping >= db.TCG_HADIAH_MUSIM.LEGENDA.keping);
  const diam2 = await db.tcgGetRank(G, { umumkan: true }); // layar yang mencetak
  benar('pengumuman masih tersimpan untuk layar berikutnya', !!diam2.hadiahMusimLalu);
  benar('hadiah tidak dibayar dua kali',
    (await db.tcgGetWallet(G)).keping === dompetG.keping);

  const gelarE = await db.tcgPeriksaGelar(E, TOTAL_KARTU);
  benar('gelar musiman muncul di daftar gelar',
    gelarE.semua.some(g => g.musiman && /Master Musim/.test(g.nama)));

  // Peringkat rendah tetap dapat hadiah, tapi tanpa gelar.
  const F = '628888888888@s.whatsapp.net';
  await db.runQuery(
    `INSERT OR REPLACE INTO tcg_rank
       (owner_jid, musim, poin, tertinggi, menang, kalah, seri, beruntun, hadiah_diklaim)
     VALUES (?, ?, 900, 950, 2, 9, 0, 0, 0)`,
    [F, musimIni - 1]);
  const rF = await db.tcgGetRank(F, { umumkan: true });
  benar('tier rendah tetap dibayar', (rF.hadiahMusimLalu?.teks || []).length > 0);
  benar('tier rendah tidak dapat gelar musiman', !rF.hadiahMusimLalu?.gelar);
  benar('reset lunak menahan di lantai 800', rF.poin >= 800);
}

// --- Gelar ---
{
  t = await jalankan('.tcg gelar', ['tcg', 'gelar']);
  harus('layar gelar tampil', t, 'GELAR ARENA');
  harus('syarat gelar terkunci ditampilkan', t, '🔒');

  const g = await db.tcgPeriksaGelar(A, TOTAL_KARTU);
  const punya = g.semua.filter(x => x.punya);
  benar('setidaknya satu gelar terbuka', punya.length >= 1);

  t = await jalankan(`.tcg gelar ${punya[0].id.toLowerCase()}`, ['tcg', 'gelar', punya[0].id.toLowerCase()]);
  harus('gelar terpasang', t, 'Gelar terpasang');
  benar('gelar aktif terbaca', (await db.tcgGelarAktif(A)) === punya[0].nama);

  t = await jalankan('.tcg (menu dengan gelar)', ['tcg']);
  harus('gelar muncul di menu', t, punya[0].nama);

  t = await jalankan('.tcg gelar zzz', ['tcg', 'gelar', 'zzz']);
  harus('menolak gelar yang belum dimiliki', t, 'belum punya gelar');
  t = await jalankan('.tcg gelar lepas', ['tcg', 'gelar', 'lepas']);
  harus('gelar bisa dilepas', t, 'dilepas');
  benar('gelar aktif kosong sesudah dilepas', (await db.tcgGelarAktif(A)) === null);
}

// --- Tonggak koleksi ---
{
  t = await jalankan('.tcg tonggak', ['tcg', 'tonggak']);
  harus('layar tonggak tampil', t, 'TONGGAK KOLEKSI');
  harus('bar progres koleksi tampil', t, /[▰▱]/);

  const sebelum = await db.tcgGetTonggak(A);
  if (sebelum.adaKlaim) {
    t = await jalankan('.tcg tonggak klaim', ['tcg', 'tonggak', 'klaim']);
    harus('tonggak terbayar', t, 'TONGGAK KOLEKSI TERKLAIM');
    t = await jalankan('.tcg tonggak klaim (dobel)', ['tcg', 'tonggak', 'klaim']);
    harus('tidak bisa diklaim dua kali', t, 'Belum ada tonggak baru');
  } else {
    t = await jalankan('.tcg tonggak klaim (belum cukup)', ['tcg', 'tonggak', 'klaim']);
    harus('menolak klaim tanpa syarat', t, 'Belum ada tonggak baru');
  }
}

// --- Menara Abadi ---
{
  t = await jalankan('.tcg abadi (terkunci)', ['tcg', 'abadi']);
  harus('abadi tersegel sebelum lantai 30', t, 'tersegel');

  await db.runQuery("UPDATE tcg_tower SET highest_floor = ? WHERE owner_jid = ?", [TOWER_FLOORS.length, A]);
  await db.tcgTambahEnergi(A, { menara: 3 });

  t = await jalankan('.tcg abadi', ['tcg', 'abadi']);
  harus('layar abadi terbuka', t, 'MENARA ABADI');
  harus('lantai berikutnya tampil', t, /Lantai 1/);
  harus('elemen lantai diumumkan', t, 'condong');

  t = await jalankan('.tcg abadi lawan', ['tcg', 'abadi', 'lawan']);
  harus('pertarungan abadi berjalan', t, /LANTAI ABADI 1 DITEMBUS|GAGAL DI LANTAI ABADI 1/);

  // Menara habis juga harus tetap mengarahkan ke Abadi.
  t = await jalankan('.tcg menara', ['tcg', 'menara']);
  harus('menara tamat mengarah ke abadi', t, '.tcg abadi');

  // Maju satu lantai lewat lapisan data: hadiah dibayar dan lantai naik.
  const a0 = await db.tcgGetAbadi(A);
  const maju = await db.tcgMajuAbadi(A, a0.lantai + 1);
  benar('maju satu lantai berhasil', maju.success && maju.lantai === a0.lantai + 1);
  benar('lantai tidak bisa dilompati', (await db.tcgMajuAbadi(A, a0.lantai + 5)).success === false);

  // Lantai dibangkitkan, bukan disimpan: harus deterministik dan selalu valid.
  let rusak = 0;
  for (let l = 1; l <= 200; l++) {
    const d = dekAbadi(l);
    for (const s of [1, 2, 3]) if (!getKartu(d.deck[s]?.card_id)) rusak++;
    if (new Set([1, 2, 3].map(s => d.deck[s].card_id)).size !== 3) rusak++;
    if (!(d.skala > 0) || d.level < 1 || d.level > 5) rusak++;
  }
  benar('200 lantai abadi valid & tanpa kartu kembar', rusak === 0);
  benar('lantai abadi deterministik',
    JSON.stringify(dekAbadi(47)) === JSON.stringify(dekAbadi(47)));
  benar('nama lantai bervariasi',
    new Set(Array.from({ length: 40 }, (_, i) => dekAbadi(i + 1).nama)).size >= 15);
  benar('kekuatan penjaga naik seiring lantai', dekAbadi(50).skala > dekAbadi(1).skala);
  benar('hadiah abadi dibatasi atas',
    db.tcgHadiahAbadi(9999).keping === db.TCG_ABADI_KEPING_MAKS);
}

// --- Barter duplikat ---
{
  t = await jalankan('.tcg barter (tanpa argumen)', ['tcg', 'barter']);
  harus('panduan barter tampil', t, 'BARTER KARTU');
  harus('aturan duplikat dijelaskan', t, 'duplikat');

  await db.tcgTambahKartu(A, 'CMN01', 3);
  await db.tcgTambahKartu(B, 'CMN03', 3);
  const aSebelum = (await db.tcgGetKartu(A, 'CMN01'))?.qty || 0;
  const bSebelum = (await db.tcgGetKartu(B, 'CMN03'))?.qty || 0;

  t = await jalankan('.tcg barter @B CMN01 CMN03',
    ['tcg', 'barter', '@' + B.split('@')[0], 'CMN01', 'CMN03'],
    { messageObj: pesan('Penguji', B) });
  harus('tawaran barter terkirim', t, 'TAWARAN BARTER');
  t = await jalankan('B: .tcg deal', ['tcg', 'deal'], { sebagai: B, messageObj: pesan('Lawan') });
  harus('barter berhasil', t, 'BARTER BERHASIL');

  benar('A kehilangan satu CMN01', ((await db.tcgGetKartu(A, 'CMN01'))?.qty || 0) === aSebelum - 1);
  benar('A menerima CMN03', ((await db.tcgGetKartu(A, 'CMN03'))?.qty || 0) >= 1);
  benar('B kehilangan satu CMN03', ((await db.tcgGetKartu(B, 'CMN03'))?.qty || 0) === bSebelum - 1);
  benar('B menerima CMN01', ((await db.tcgGetKartu(B, 'CMN01'))?.qty || 0) >= 1);

  // Kartu terakhir tidak boleh pernah berpindah.
  await db.runQuery("UPDATE tcg_collection SET qty = 1 WHERE owner_jid = ? AND card_id = 'LGD03'", [A]);
  const tunggal = await db.tcgPunyaDuplikat(A, 'LGD03');
  benar('salinan tunggal bukan duplikat', tunggal.bisa === false);
  t = await jalankan('.tcg barter kartu tunggal',
    ['tcg', 'barter', '@' + B.split('@')[0], 'LGD03', 'CMN03'],
    { messageObj: pesan('Penguji', B) });
  harus('menolak barter kartu terakhir', t, 'tidak punya *duplikat*');

  // Barter di DM ditolak.
  t = await jalankan('.tcg barter di DM', ['tcg', 'barter'], { grup: false });
  harus('barter hanya di grup', t, 'hanya bisa dilakukan di dalam grup');

  // Menolak tawaran.
  await jalankan('.tcg barter lagi',
    ['tcg', 'barter', '@' + B.split('@')[0], 'CMN01', 'CMN03'],
    { messageObj: pesan('Penguji', B) });
  t = await jalankan('B: .tcg batal', ['tcg', 'batal'], { sebagai: B, messageObj: pesan('Lawan') });
  harus('tawaran barter bisa ditolak', t, 'ditolak');

  // Kuota harian benar-benar mengikat.
  const sisa = await db.tcgSisaKuotaBarter(A);
  benar('kuota barter berkurang sesudah tukar', sisa < db.TCG_BARTER_KUOTA_HARIAN);
  await db.runQuery(
    `INSERT INTO tcg_barter_kuota (owner_jid, tanggal, jumlah) VALUES (?, ?, ?)
       ON CONFLICT(owner_jid, tanggal) DO UPDATE SET jumlah = ?`,
    [A, db.tcgTanggalHariIni(), db.TCG_BARTER_KUOTA_HARIAN, db.TCG_BARTER_KUOTA_HARIAN]);
  t = await jalankan('.tcg barter (kuota habis)',
    ['tcg', 'barter', '@' + B.split('@')[0], 'CMN01', 'CMN03'],
    { messageObj: pesan('Penguji', B) });
  harus('kuota habis menolak barter', t, 'Kuota barter harianmu habis');
}

// --- Layar yang menampilkan semuanya ---
{
  t = await jalankan('.tcg (menu penuh)', ['tcg']);
  harus('menu menampilkan peringkat', t, /Perunggu|Perak|Emas|Platina|Diamond|Master|Legenda/);
  harus('menu menampilkan beruntun', t, 'Beruntun');
  harus('menu punya pintasan barter', t, '.tcg barter');
  t = await jalankan('.tcg misi (dengan mingguan)', ['tcg', 'misi']);
  harus('misi menautkan mingguan', t, '.tcg mingguan');
  t = await jalankan('.tcg bantuan jangka', ['tcg', 'bantuan', 'jangka']);
  harus('topik bantuan jangka panjang ada', t, 'JANGKA PANJANG');
}

// ============================================================
// 10. INPUT SALAH & IZIN
// ============================================================
console.log('\n════ 10. INPUT SALAH & IZIN ════');
for (const [label, args, pola] of [
  ['.tcg zzzz', ['tcg', 'zzzz'], 'tidak dikenal'],
  ['.tcg kolesi (salah ketik)', ['tcg', 'kolesi'], 'Maksudmu'],
  ['.tcg pasang <1-3> <id>', ['tcg', 'pasang', '<1-3>', '<id>'], 'Format'],
  ['.tcg kartu xxx', ['tcg', 'kartu', 'xxx'], 'tidak ditemukan'],
  ['.tcg naik 999', ['tcg', 'naik', '999'], 'Format'],
  ['.tcg lebur xxx', ['tcg', 'lebur', 'xxx'], 'Format'],
  ['.tcg gerbang xxx', ['tcg', 'gerbang', 'xxx'], 'GERBANG ELEMEN'],
  ['.tcg ekspedisi xxx 2', ['tcg', 'ekspedisi', 'xxx', '2'], 'tidak dikenal'],
  ['.tcg tukar 1 1', ['tcg', 'tukar', '1', '1'], 'tidak bisa ditukar'],
  ['.tcg cek (bukan admin)', ['tcg', 'cek'], 'khusus'],
  ['.tcg give (bukan admin)', ['tcg', 'give'], 'khusus'],
  ['.tcg duel di DM', ['tcg', 'duel'], 'hanya bisa dimainkan di dalam grup']
]) {
  const teks = await jalankan(label, args, label.includes('DM') ? { grup: false } : {});
  harus(label, teks, pola);
}
t = await jalankan('.tcg cmn1 (ID pendek)', ['tcg', 'cmn1']);
harus('ID pendek dimaklumi', t, 'TIKUS BARA');
t = await jalankan('.tcg cek (owner)', ['tcg', 'cek', '@' + B.split('@')[0]], { owner: true, messageObj: pesan('Owner', B) });
harus('audit owner jalan', t, 'AUDIT ARENA');
t = await jalankan('.tcg give (owner)', ['tcg', 'give', '@' + B.split('@')[0], 'MYT01', '2'], { owner: true, messageObj: pesan('Owner', B) });
harus('give owner jalan', t, 'diberikan ke');

// ============================================================
// 11. PERENDER KARTU
// ============================================================
console.log('\n════ 11. PERENDER KARTU ════');
let render = 0;
const t0 = Date.now();
for (const k of KARTU) {
  for (let lv = 1; lv <= MAKS_LEVEL; lv++) {
    try {
      const buf = await bufferKartu(k, lv);
      if (buf && buf.length > 1000) render++;
      else { gagal.push({ label: `render ${k.id} Lv.${lv}`, err: 'buffer kosong' }); }
    } catch (e) {
      gagal.push({ label: `render ${k.id} Lv.${lv}`, err: e?.message || String(e) });
    }
  }
}
periksa++;
console.log(`  ${render === KARTU.length * MAKS_LEVEL ? '✅' : '❌'} ${render}/${KARTU.length * MAKS_LEVEL} render (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
const gabung = await bufferBanyakKartu(KARTU.slice(0, 10).map(k => ({ kartu: k, level: 3 })));
benar('gambar gabungan 10 kartu', !!gabung && gabung.length > 5000);
console.log(`  ✅ gabungan 10 kartu: ${(gabung.length / 1024).toFixed(0)} KB`);

// ============================================================
// 12. INVARIAN STAT & MESIN TEMPUR
// ============================================================
console.log('\n════ 12. INVARIAN ════');
benar('semua kartu di dalam anggaran daya', periksaKeseimbangan().length === 0);
benar('ID kartu unik', new Set(KARTU.map(k => k.id)).size === TOTAL_KARTU);
benar('profil stat unik', new Set(KARTU.map(k => `${k.atk}/${k.hp}`)).size === TOTAL_KARTU);
console.log(`  ✅ ${TOTAL_KARTU} kartu · ${new Set(KARTU.map(k => `${k.atk}/${k.hp}`)).size} profil stat unik · anggaran daya aman`);

let statRusak = 0;
for (const k of KARTU) {
  for (let lv = 1; lv <= MAKS_LEVEL; lv++) {
    const s = statKartu(k, lv);
    if (!Number.isFinite(s.atk) || s.atk <= 0) statRusak++;
    if (!Number.isFinite(s.hp) || s.hp <= 0) statRusak++;
    if (!Number.isFinite(s.cp) || s.cp <= 0) statRusak++;
    if (lv > 1) {
      const p = statKartu(k, lv - 1);
      if (!(s.atk > p.atk && s.hp > p.hp && s.cp > p.cp)) statRusak++;
    }
  }
}
benar('stat naik monoton di tiap level', statRusak === 0);
for (const lv of [0, -5, 99, null, undefined, NaN, '3']) {
  const s = statKartu(KARTU[0], lv);
  benar(`level liar (${lv}) dijepit`, s.level >= 1 && s.level <= MAKS_LEVEL);
}
benar('statKartu(null) aman', statKartu(null, 1).atk > 0);
console.log('  ✅ stat monoton, level liar dijepit, input null aman');

const acakDek = () => ({
  1: { card_id: KARTU[Math.floor(Math.random() * KARTU.length)].id, card_lv: 1 + Math.floor(Math.random() * 5) },
  2: { card_id: KARTU[Math.floor(Math.random() * KARTU.length)].id, card_lv: 1 + Math.floor(Math.random() * 5) },
  3: { card_id: KARTU[Math.floor(Math.random() * KARTU.length)].id, card_lv: 1 + Math.floor(Math.random() * 5) }
});
let anomali = 0;
const t2 = Date.now();
for (let i = 0; i < 4000; i++) {
  const senyap = i % 4 !== 0;
  const r = simulate3v3(acakDek(), acakDek(), 'A', 'B', { diam: senyap });
  if (![0, 1, 2].includes(r.matchWinner)) anomali++;
  if (r.scoreA + r.scoreB > 3 || r.scoreA < 0 || r.scoreB < 0) anomali++;
  if (!senyap) {
    if (r.roundReports.length !== 3) anomali++;
    if (r.roundReports.some(x => /NaN|undefined|Infinity/.test(x))) anomali++;
  }
}
benar('4.000 pertandingan tanpa anomali', anomali === 0);
console.log(`  ✅ 4.000 pertandingan dalam ${((Date.now() - t2) / 1000).toFixed(1)}s — skor selalu 0-3, tanpa NaN`);

for (const [a, b] of [
  [{}, {}],
  [{ 1: { card_id: 'CMN01', card_lv: 1 } }, {}],
  [{ 1: { card_id: 'TIDAK_ADA', card_lv: 1 } }, { 1: { card_id: 'CMN01', card_lv: 1 } }],
  [{ 1: { card_id: 'CMN01', card_lv: 99 } }, { 1: { card_id: 'CMN01', card_lv: 0 } }]
]) {
  try {
    const r = simulate3v3(a, b, 'A', 'B', { diam: false });
    benar('dek cacat menghasilkan pemenang valid', [0, 1, 2].includes(r.matchWinner));
  } catch (e) {
    gagal.push({ label: 'dek cacat', err: e?.message || String(e) });
  }
}
console.log('  ✅ dek kosong / ID tidak dikenal / level liar ditangani tanpa melempar');

let lantaiRusak = 0;
for (const f of TOWER_FLOORS) {
  for (const s of [1, 2, 3]) {
    if (!getKartu(f.deck?.[s]?.card_id)) lantaiRusak++;
  }
}
benar('semua kartu penjaga menara ada di katalog', lantaiRusak === 0);
benar('getTowerFloor(1) ada', !!getTowerFloor(1));
benar('getTowerFloor(9999) null', !getTowerFloor(9999));
console.log(`  ✅ ${TOWER_FLOORS.length} lantai menara, semua ID kartu penjaga valid`);

// ============================================================
// HASIL
// ============================================================
console.log('\n════════════════════════════════════════');
console.log(`Perintah dijalankan : ${perintah}`);
console.log(`Pemeriksaan         : ${periksa}`);
console.log(`Gagal               : ${gagal.length}`);
for (const g of gagal) console.log(`\n--- ${g.label} ---\n${g.err}`);
console.log('════════════════════════════════════════');

try { fs.rmSync(kotakPasir, { recursive: true, force: true }); } catch { /* biar sistem yang bersihkan */ }
process.exit(gagal.length ? 1 : 0);
