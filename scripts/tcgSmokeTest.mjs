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
  KARTU, statKartu, getKartu, PETA_COST, MAKS_LEVEL, GELAR, SKILL,
  skillEfektif, MAKS_REFINE, ringkasEfekSkill, tanggaRefine,
  periksaKeseimbangan, TOTAL_KARTU, ELEMEN, pengaliElemen, MAKS_BIAYA_DEK
} = await import(REPO + 'src/games/tcg/cards.js');
const { bufferKartu, bufferBanyakKartu } = await import(REPO + 'src/games/tcg/gambar.js');
const {
  bannerAktif, sisaHariBanner, undiKartuBanner, rateOn
} = await import(REPO + 'src/games/tcg/banner.js');
const {
  simulate3v3, TOWER_FLOORS, getTowerFloor, dekAbadi,
  modifierAbadi, periksaSyaratModifier, MODIFIER_ABADI, ABADI_MODIFIER_MULAI,
  dekGauntlet, bosPekan, hitungSeranganBos, saranCounter, elemenDek
} = await import(REPO + 'src/games/tcg/battle.js');

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
//
// Diuji dengan MEMBANDINGKAN ke perintah aslinya, bukan sekadar memastikan bot
// membalas. Pintasan yang salah sasaran tetap membalas sesuatu, jadi uji yang
// cuma memeriksa 'ada balasan' akan lulus sementara menunya berbohong ke
// pemain. Membandingkan baris pertama menangkapnya, dan tidak perlu diperbarui
// tiap kali kalimat sebuah layar diubah.
const PINTASAN = [
  ['1', 'banner'], ['2', 'koleksi'], ['3', 'dek'], ['4', 'naik'], ['5', 'refine'],
  ['6', 'spar'], ['7', 'menara'], ['8', 'rank'], ['9', 'gauntlet'], ['10', 'bos'],
  ['11', 'gerbang'], ['12', 'ekspedisi'], ['13', 'misi'], ['14', 'gelar'],
  ['15', 'barter'], ['0', 'bantuan']
];
for (const [nomor, tujuan] of PINTASAN) {
  const lewatAngka = await jalankan(`.tcg ${nomor}`, ['tcg', nomor]);
  const langsung = await jalankan(`.tcg ${tujuan}`, ['tcg', tujuan]);
  const kepala = (s) => String(s || '').split('\n')[0].trim();
  benar(`.tcg ${nomor} membuka layar .tcg ${tujuan}`,
    kepala(lewatAngka).length > 0 && kepala(lewatAngka) === kepala(langsung));
}

// Pintasan angka TIDAK BOLEH membelanjakan apa pun. Orang yang sedang
// menjelajahi menu tidak boleh tiba-tiba kehilangan serpihan atau duplikat.
{
  const dompetAwal = await db.tcgGetWallet(A);
  const serpihAwal = await db.tcgGetSerpihan(A);
  for (const [nomor] of PINTASAN) await jalankan(`.tcg ${nomor} (ulang)`, ['tcg', nomor], { diam: true });
  const dompetAkhir = await db.tcgGetWallet(A);
  const serpihAkhir = await db.tcgGetSerpihan(A);
  benar('pintasan angka tidak memakan Keping', dompetAkhir.keping === dompetAwal.keping);
  benar('pintasan angka tidak memakan Picis', (dompetAkhir.picis || 0) === (dompetAwal.picis || 0));
  benar('pintasan angka tidak memakan serpihan',
    db.TCG_RARITY.every(r => (serpihAkhir[r] || 0) === (serpihAwal[r] || 0)));
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
harus('biaya picis tampil', t, /Picis: \*[\d.]+\*/);
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
harus('biaya terpakai dilaporkan', t, /Biaya: \d+ Serpihan \+ [\d.]+ Picis/);
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
t = await jalankan('.tcg autodek', ['tcg', 'autodek']);
harus('autodek berhasil pasang 3 kartu', t, 'PEMASANGAN DEK OTOMATIS CERDAS');
harus('autodek melaporkan biaya bintang', t, /Total Biaya Bintang/);
harus('autodek melaporkan estimasi power', t, /Total Estimasi Power/);
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
// Picis ikut dibayar ekspedisi sejak v3.6 dan WAJIB terlihat: mata uang yang
// bertambah diam-diam sama saja dengan tidak ada.
harus('Picis masuk', t, /Picis: \*\+[\d.]+\*/);
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
t = await jalankan('.tcg ambil 1', ['tcg', 'ambil', '1']);
harus('kartu 1 tersambar', t, 'DISAMBAR');
harus('kartu 1 adalah CMN01', t, 'CMN01');
t = await jalankan('.tcg ambil 2 (sudah ambil)', ['tcg', 'ambil', '2']);
harus('satu orang satu kartu', t, 'sudah mengambil');
harus('nomor sebelumnya benar', t, '*1*');
t = await jalankan('B: .tcg ambil 1 (sudah diambil)', ['tcg', 'ambil', '1'], { sebagai: B, messageObj: pesan('Lawan') });
harus('kartu yang sama ditolak', t, 'keburu disambar');
t = await jalankan('B: .tcg ambil 2', ['tcg', 'ambil', '2'], { sebagai: B, messageObj: pesan('Lawan') });
harus('kartu 2 tersambar', t, 'DISAMBAR');
harus('kartu 2 adalah RAR01', t, 'RAR01');

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
t = await jalankan('.tcg jual CMN10 1', ['tcg', 'jual', 'CMN10', '1']);
harus('jual berhasil', t, 'terjual seharga');
t = await jalankan('.tcg serpih CMN10 1', ['tcg', 'serpih', 'CMN10', '1']);
harus('serpih berhasil', t, 'dipecah jadi');
t = await jalankan('.tcg serpihsemua common', ['tcg', 'serpihsemua', 'common']);
harus('serpihsemua berhasil', t, 'PEMBERSIHAN KARTU MASSAL');
t = await jalankan('.tcg jualsemua common', ['tcg', 'jualsemua', 'common']);
harus('jualsemua merespon aman', t, /PENJUALAN KARTU MASSAL|tidak memiliki kartu duplikat|Semua duplikat kartumu/);
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
// 9c. TANTANGAN BARU: MODIFIER ABADI, GAUNTLET, BOS GRUP
// ============================================================
console.log('\n════ 9c. TANTANGAN BARU ════');

// --- Modifier lantai Menara Abadi ---
{
  benar('lantai di bawah ambang bersih', modifierAbadi(ABADI_MODIFIER_MULAI - 1) === null);
  benar('lantai di ambang bermodifier', !!modifierAbadi(ABADI_MODIFIER_MULAI));

  // Deterministik: dua panggilan untuk lantai yang sama wajib identik. Kalau
  // tidak, pemain bisa mengulang sampai dapat aturan mudah dan angka lantai
  // di papan peringkat berhenti berarti apa-apa.
  const a = modifierAbadi(37);
  const b = modifierAbadi(37);
  benar('modifier deterministik', JSON.stringify(a) === JSON.stringify(b));

  let beruntun = 1, maks = 1, sebelumnya = null;
  const hitung = {};
  for (let n = ABADI_MODIFIER_MULAI; n < ABADI_MODIFIER_MULAI + 300; n++) {
    const m = modifierAbadi(n);
    hitung[m.id] = (hitung[m.id] || 0) + 1;
    if (m.id === sebelumnya) { beruntun++; maks = Math.max(maks, beruntun); } else beruntun = 1;
    sebelumnya = m.id;
  }
  benar('tidak ada dua lantai berturut-turut dengan modifier sama', maks === 1);
  benar('semua modifier terpakai', Object.keys(hitung).length === MODIFIER_ABADI.length);

  // Elemen yang disegel/diminta wajib ikut diselesaikan, bukan tersisa true.
  for (let n = ABADI_MODIFIER_MULAI; n < ABADI_MODIFIER_MULAI + 200; n++) {
    const m = modifierAbadi(n);
    if (m.efek.laranganElemen !== undefined) {
      benar('segel elemen berupa nama elemen', typeof m.efek.laranganElemen === 'string');
      break;
    }
  }

  // Syarat penyusunan harus benar-benar menolak, bukan cuma ada.
  const dekApi = { 1: { card_id: 'CMN01', card_lv: 1 } };
  const segel = { emoji: '🚫', nama: 'Segel', teks: '-', efek: { laranganElemen: getKartu('CMN01').elemen } };
  benar('segel elemen menolak dek yang melanggar', periksaSyaratModifier(dekApi, segel).boleh === false);
  benar('modifier tanpa syarat selalu meloloskan', periksaSyaratModifier(dekApi, null).boleh === true);
  const batas = { emoji: '💰', nama: 'Anggaran', teks: '-', efek: { batasBintang: 0 } };
  benar('batas bintang 0 tidak dianggap tanpa batas', periksaSyaratModifier(dekApi, batas).boleh === true);
}

// --- Autodek bersasaran ---
{
  t = await jalankan('.tcg autodek api', ['tcg', 'autodek', 'api']);
  harus('autodek menyebut sasaran elemen', t, 'Melawan');
  harus('autodek tetap memasang dek', t, 'Slot 1');

  t = await jalankan('.tcg autodek gelap (alias DARK)', ['tcg', 'autodek', 'gelap']);
  harus('alias elemen dimaklumi', t, 'Sasaran');

  t = await jalankan('.tcg autodek zzz', ['tcg', 'autodek', 'zzz']);
  harus('sasaran ngawur ditolak', t, 'tidak dikenal');

  t = await jalankan('.tcg autodek abadi', ['tcg', 'autodek', 'abadi']);
  harus('autodek abadi menyebut lantai', t, /Lantai Abadi \d+/);
}

// --- Gauntlet pekanan ---
{
  t = await jalankan('.tcg gauntlet', ['tcg', 'gauntlet']);
  harus('layar gauntlet tampil', t, 'GAUNTLET PEKANAN');
  harus('tahap berikutnya tampil', t, /TAHAP 1\/3/);
  harus('sisa percobaan tampil', t, 'Sisa percobaan');

  t = await jalankan('.tcg gauntlet dek', ['tcg', 'gauntlet', 'dek']);
  harus('dek gauntlet tersusun', t, 'DEK GAUNTLET');

  const sebelum = await db.tcgGetGauntlet(A);
  benar('gauntlet mulai dari tahap 0', sebelum.tahap === 0);
  benar('belum ada kartu terkunci', sebelum.kartuTerpakai.length === 0);

  t = await jalankan('.tcg gauntlet lawan', ['tcg', 'gauntlet', 'lawan']);
  harus('pertarungan gauntlet berjalan', t, /TAHAP 1\/3|RONDE/);
  const sesudah = await db.tcgGetGauntlet(A);
  benar('percobaan terpotong', sesudah.percobaanTerpakai === 1);

  // Kunci kartu diuji lewat DAO supaya hasilnya tidak bergantung menang/kalah.
  const dekSekarang = await db.tcgGetDeck(A);
  const idPertama = dekSekarang[1]?.card_id;
  await db.tcgMenangGauntlet(A, sesudah.tahap + 1, [idPertama]);
  const terkunci = await db.tcgGetGauntlet(A);
  benar('kartu pemenang terkunci', terkunci.kartuTerpakai.includes(idPertama));

  await db.tcgSetDeckSlot(A, 1, idPertama, PETA_COST);
  t = await jalankan('.tcg gauntlet lawan (kartu terkunci)', ['tcg', 'gauntlet', 'lawan']);
  harus('kartu terkunci ditolak', t, 'SUDAH TERPAKAI');
  const tetap = await db.tcgGetGauntlet(A);
  benar('penolakan tidak memakan percobaan', tetap.percobaanTerpakai === terkunci.percobaanTerpakai);

  // Autodek gauntlet wajib menghindari kartu yang sudah terkunci.
  const susun = await db.tcgAutoBuildDeck(A, { kecuali: tetap.kartuTerpakai });
  if (susun.success) {
    benar('autodek gauntlet menghindari kartu terkunci',
      susun.deck.every(k => !tetap.kartuTerpakai.includes(k.card_id)));
  }

  // Percobaan habis harus benar-benar menutup pintu.
  await db.runQuery(
    'UPDATE tcg_gauntlet SET percobaan = ?, tahap = 0 WHERE owner_jid = ? AND minggu = ?',
    [db.TCG_GAUNTLET_PERCOBAAN, A, tetap.minggu]);
  for (const [s, id] of [[1, 'CMN07'], [2, 'CMN10'], [3, 'CMN05']]) await db.tcgSetDeckSlot(A, s, id, PETA_COST);
  t = await jalankan('.tcg gauntlet lawan (percobaan habis)', ['tcg', 'gauntlet', 'lawan']);
  harus('percobaan habis menolak', t, 'habis');
  await db.runQuery(
    'UPDATE tcg_gauntlet SET percobaan = 0 WHERE owner_jid = ? AND minggu = ?', [A, tetap.minggu]);
}

// --- Bos Arena grup ---
{
  t = await jalankan('.tcg bos (di DM)', ['tcg', 'bos'], { grup: false });
  harus('bos menolak di DM', t, 'hanya hidup di dalam grup');

  t = await jalankan('.tcg bos', ['tcg', 'bos']);
  harus('layar bos tampil', t, 'Bos Arena pekan');
  harus('bar HP tampil', t, /\d+%/);
  harus('jatah harian tampil', t, 'Jatah seranganmu');

  const awal = await db.tcgGetBos(GRUP, bosPekan(db.tcgKunciPekan()));
  benar('bos lahir dengan HP penuh', awal.hp === awal.hp_maks);
  benar('bos lahir hidup', awal.hidup === true);

  t = await jalankan('.tcg bos serang', ['tcg', 'bos', 'serang']);
  harus('serangan menghasilkan damage', t, 'Total damage');
  const sesudah = await db.tcgGetBos(GRUP);
  benar('HP bos berkurang', sesudah.hp < sesudah.hp_maks);
  benar('penantang baru menambah HP maks', sesudah.hp_maks > awal.hp_maks);
  benar('bos mencatat penantang', sesudah.penantang === 1);

  const papan = await db.tcgPapanBos(GRUP);
  benar('papan sumbangan terisi', papan.length === 1 && papan[0].damage > 0);

  // Jatah harian: sisa dua serangan lagi, yang keempat wajib ditolak.
  await jalankan('.tcg bos serang (2)', ['tcg', 'bos', 'serang']);
  await jalankan('.tcg bos serang (3)', ['tcg', 'bos', 'serang']);
  t = await jalankan('.tcg bos serang (4, jatah habis)', ['tcg', 'bos', 'serang']);
  harus('jatah harian menutup serangan keempat', t, 'habis');

  // Bos tumbang: HP disisakan 1 lalu dipukul, hadiah wajib dibagi sekali saja.
  await db.runQuery(
    'UPDATE tcg_bos SET hp = 1 WHERE grup_jid = ? AND minggu = ?', [GRUP, sesudah.minggu]);
  await db.runQuery(
    'UPDATE tcg_bos_jatah SET dipakai = 0 WHERE owner_jid = ? AND tanggal = ?',
    [A, db.tcgTanggalHariIni()]);
  const kepingSebelum = (await db.tcgGetWallet(A))?.keping || 0;
  t = await jalankan('.tcg bos serang (pukulan terakhir)', ['tcg', 'bos', 'serang']);
  harus('bos tumbang diumumkan', t, 'TUMBANG');
  harus('hadiah dibagi', t, 'PEMBAGIAN HADIAH');
  const kepingSesudah = (await db.tcgGetWallet(A))?.keping || 0;
  benar('hadiah bos benar-benar masuk dompet', kepingSesudah > kepingSebelum);

  const ulang = await db.tcgBagiHadiahBos(GRUP, sesudah.minggu);
  benar('hadiah bos tidak bisa dibagi dua kali', ulang.success === false);

  t = await jalankan('.tcg bos serang (sudah tumbang)', ['tcg', 'bos', 'serang']);
  harus('bos tumbang menolak serangan', t, 'tumbang');

  t = await jalankan('.tcg bos (sesudah tumbang)', ['tcg', 'bos']);
  harus('layar bos tumbang menampilkan pemukul', t, 'PEMUKUL TERBESAR');
}


// ============================================================
// 9d. PERBAIKAN v3.3 — SARAN COUNTER, ANGGARAN GAUNTLET, TAKARAN BOS
// ============================================================
console.log('\n════ 9d. PERBAIKAN v3.3 ════');

// --- Saran counter tidak boleh menyarankan elemen yang merugikan ---
{
  const nilaiBersih = (deck, e) => {
    const kartu = [1, 2, 3].map(s => deck[s] && getKartu(deck[s].card_id)).filter(Boolean);
    const serang = kartu.reduce((t, k) => t + pengaliElemen(e, k.elemen), 0) / kartu.length;
    const terima = kartu.reduce((t, k) => t + pengaliElemen(k.elemen, e), 0) / kartu.length;
    return serang / terima;
  };

  let salahArah = 0, bukanTerbaik = 0, diperiksa = 0;
  for (let n = 1; n <= 120; n++) {
    const lantai = dekAbadi(n);
    const teks = saranCounter(lantai.deck);
    if (!teks) continue;
    diperiksa++;

    const peringkat = Object.keys(ELEMEN)
      .map(e => ({ e, v: nilaiBersih(lantai.deck, e) }))
      .sort((a, b) => b.v - a.v);
    const disarankan = peringkat.filter(p => teks.includes(ELEMEN[p.e].nama));

    // Cacat lama #1: elemen dengan nilai bersih di bawah 1 ikut disarankan.
    if (disarankan.some(p => p.v <= 1.001)) salahArah++;
    // Cacat lama #2: elemen terbaik justru dibuang dari daftar saran.
    if (!disarankan.some(p => p.e === peringkat[0].e)) bukanTerbaik++;
  }
  benar('saran counter diuji di banyak lantai', diperiksa >= 100);
  benar('tidak ada elemen merugikan yang disarankan', salahArah === 0);
  benar('elemen terbaik tidak pernah disembunyikan', bukanTerbaik === 0);

  // Menara Penjaga memakai fungsi yang sama, bukan salinan rumusnya sendiri.
  const l1 = getTowerFloor(1);
  benar('saran counter juga jalan untuk Menara Penjaga', typeof saranCounter(l1.deck) === 'string');
}

// --- Lawan Gauntlet patuh anggaran bintang yang sama dengan pemain ---
{
  let pelanggaran = 0, kurangKartu = 0;
  for (const pekan of ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-10-05']) {
    for (const t of [1, 2, 3]) {
      const g = dekGauntlet(pekan, t);
      const biaya = [1, 2, 3]
        .map(s => (g.deck[s] ? PETA_COST[getKartu(g.deck[s].card_id).rarity] : 0))
        .reduce((a, b) => a + b, 0);
      if (biaya > MAKS_BIAYA_DEK) pelanggaran++;
      if ([1, 2, 3].filter(s => g.deck[s]).length !== 3) kurangKartu++;
    }
  }
  benar('dek lawan Gauntlet tidak pernah melampaui anggaran pemain', pelanggaran === 0);
  benar('dek lawan Gauntlet selalu tiga kartu penuh', kurangKartu === 0);
}

// --- Gauntlet menolak dek yang tidak penuh ---
{
  const st = await db.tcgGetGauntlet(A);
  await db.runQuery(
    'UPDATE tcg_gauntlet SET percobaan = 0, tahap = 0, kartu_terpakai = \'[]\' WHERE owner_jid = ? AND minggu = ?',
    [A, st.minggu]);
  await db.runQuery('DELETE FROM tcg_deck WHERE owner_jid = ?', [A]);
  for (const [s, id] of [[1, 'CMN07'], [2, 'CMN10']]) await db.tcgSetDeckSlot(A, s, id, PETA_COST);
  t = await jalankan('.tcg gauntlet lawan (dek 2 kartu)', ['tcg', 'gauntlet', 'lawan']);
  harus('dek tidak penuh ditolak', t, /2\/3 slot/);
  const sesudah = await db.tcgGetGauntlet(A);
  benar('penolakan dek tidak penuh tidak memakan percobaan', sesudah.percobaanTerpakai === 0);
  for (const [s, id] of [[1, 'CMN07'], [2, 'CMN10'], [3, 'CMN05']]) await db.tcgSetDeckSlot(A, s, id, PETA_COST);
}

// --- autodek tidak boleh mengaku sukses saat melanggar wajibElemen ---
{
  // Elemen yang PASTI tidak dimiliki A: cari dari koleksi sungguhannya.
  const punya = await db.allQuery('SELECT card_id FROM tcg_collection WHERE owner_jid = ? AND qty > 0', [A]);
  const elemenPunya = new Set((punya || []).map(r => getKartu(r.card_id)).filter(Boolean).map(k => k.elemen));
  const elemenTidakPunya = Object.keys(ELEMEN).find(e => !elemenPunya.has(e));
  if (elemenTidakPunya) {
    const res = await db.tcgAutoBuildDeck(A, { wajibElemen: elemenTidakPunya });
    benar('autodek gagal jujur saat elemen wajib tidak dimiliki', res.success === false);
  } else {
    // Kalau A kebetulan punya semua elemen, uji lewat jalur batas bintang mustahil.
    const res = await db.tcgAutoBuildDeck(A, { batasBintang: 1, wajibElemen: 'MYTHIC_TIDAK_ADA' });
    benar('autodek gagal jujur saat syarat mustahil', res.success === false);
  }
}

// --- Takaran HP bos sebanding sisa pekan ---
{
  const sisa = db.tcgSisaHariPekan(db.tcgKunciPekan());
  benar('sisa hari pekan berada di rentang 1-7', sisa >= 1 && sisa <= 7);
  benar('sisa hari pekan bilangan bulat', Number.isInteger(sisa));
}

// --- Hadiah bos yang menggantung bisa dibereskan, dan parsial saat tidak tumbang ---
{
  const mgLalu = '2026-01-05';
  await db.runQuery(
    `INSERT OR REPLACE INTO tcg_bos (grup_jid, minggu, nama, elemen, hp, hp_maks, status, hadiah_dibagi)
     VALUES (?, ?, 'Bos Uji Lama', 'API', 40000, 100000, 'HIDUP', 0)`,
    [GRUP, mgLalu]);
  await db.runQuery(
    `INSERT OR REPLACE INTO tcg_bos_kontribusi (grup_jid, minggu, owner_jid, damage, serangan)
     VALUES (?, ?, ?, 60000, 10)`,
    [GRUP, mgLalu, A]);

  const tertunda = await db.tcgBosBelumDibereskan(GRUP);
  benar('bos pekan lewat yang belum dibayar terdeteksi', tertunda.some(x => x.minggu === mgLalu));

  const kepingSebelum = (await db.tcgGetWallet(A))?.keping || 0;
  const bagi = await db.tcgBagiHadiahBos(GRUP, mgLalu);
  benar('hadiah bos tertunda berhasil dibagi', bagi.success === true);
  benar('pembagian parsial ditandai tidak tumbang', bagi.tumbang === false);
  benar('porsi kerusakan dihitung dari HP terkikis', Math.abs(bagi.porsiKerusakan - 0.6) < 0.01);
  benar('kolam parsial lebih kecil dari kolam penuh', bagi.kolam < bagi.kolamPenuh);
  const kepingSesudah = (await db.tcgGetWallet(A))?.keping || 0;
  benar('hadiah parsial benar-benar masuk dompet', kepingSesudah > kepingSebelum);

  const ulang = await db.tcgBagiHadiahBos(GRUP, mgLalu);
  benar('hadiah tertunda tidak bisa dibagi dua kali', ulang.success === false);
  const sisaTertunda = await db.tcgBosBelumDibereskan(GRUP);
  benar('bos yang sudah dibereskan hilang dari daftar tertunda', !sisaTertunda.some(x => x.minggu === mgLalu));
}

// --- Misi mingguan benar-benar membaca aksi mode baru ---
{
  const aksiMingguan = new Set(db.TCG_MISI_MINGGUAN.flatMap(m => m.aksi));
  benar('aksi GAUNTLET terbaca misi mingguan', aksiMingguan.has('GAUNTLET'));
  benar('aksi BOS terbaca misi mingguan', aksiMingguan.has('BOS'));
}


// --- Kata yang benar-benar diketik pemain di grup produksi ---
// `.tcg copot` dan `.tcg lepas semua` dua-duanya tercatat di log dan dua-duanya
// ditolak; yang kedua memaksa pemain mengirim tiga pesan berturut-turut.
{
  for (const [s, id] of [[1, 'CMN07'], [2, 'CMN10'], [3, 'CMN05']]) await db.tcgSetDeckSlot(A, s, id, PETA_COST);
  t = await jalankan('.tcg copot 1 (kata pemain)', ['tcg', 'copot', '1']);
  harus('copot dikenali sebagai lepas', t, 'Slot 1');

  for (const [s, id] of [[1, 'CMN07'], [2, 'CMN10'], [3, 'CMN05']]) await db.tcgSetDeckSlot(A, s, id, PETA_COST);
  t = await jalankan('.tcg lepas semua', ['tcg', 'lepas', 'semua']);
  harus('lepas semua mengosongkan sekaligus', t, 'slot dikosongkan');
  const dek = await db.tcgGetDeck(A);
  benar('ketiga slot benar-benar kosong', ![1, 2, 3].some(s => dek[s]));

  t = await jalankan('.tcg lepas semua (dek sudah kosong)', ['tcg', 'lepas', 'semua']);
  harus('dek kosong dijawab ramah', t, 'sudah kosong');

  t = await jalankan('.tcg lepas xyz', ['tcg', 'lepas', 'xyz']);
  harus('format salah menyarankan lepas semua', t, 'lepas semua');

  for (const [s, id] of [[1, 'CMN07'], [2, 'CMN10'], [3, 'CMN05']]) await db.tcgSetDeckSlot(A, s, id, PETA_COST);
}

  // `.tcg raid` — kata yang dipakai pemain sungguhan untuk mencari Bos Arena.
  // Sebelum ini koreksi ejaan justru menyarankan `rate`/`naik`/`rank`.
  t = await jalankan('.tcg raid (kata pemain)', ['tcg', 'raid'], { grup: true });
  harus('raid membuka Bos Arena', t, /Bos Arena|BOS ARENA|TUMBANG/);

  // Menambah alias itu tidak boleh merusak koreksi salah ketik yang sudah benar.
  t = await jalankan('.tcg raik (salah ketik naik)', ['tcg', 'raik']);
  harus('salah ketik tetap diarahkan ke naik/rank', t, /Maksudmu/);

// --- Alias sehari-hari (hasil sapuan atas log pemain) ---
{
  for (const [s, id] of [[1, 'CMN07'], [2, 'CMN10'], [3, 'CMN05']]) await db.tcgSetDeckSlot(A, s, id, PETA_COST);

  // Alias yang cuma menampilkan — cukup dipastikan membuka layar yang benar.
  for (const [label, args, pola] of [
    ['.tcg tim', ['tcg', 'tim'], /DEK|Slot/],
    ['.tcg formasi', ['tcg', 'formasi'], /DEK|Slot/],
    ['.tcg kartuku', ['tcg', 'kartuku'], /KOLEKSI|koleksi/i],
    ['.tcg auto', ['tcg', 'auto'], /OTOMATIS|Slot 1/],
    ['.tcg absen', ['tcg', 'absen'], /HARIAN|harian|beruntun/i],
    ['.tcg liga', ['tcg', 'liga'], /PERINGKAT|peringkat|musim/i],
    ['.tcg portal', ['tcg', 'portal'], /GERBANG/],
    ['.tcg stamina', ['tcg', 'stamina'], /RANSUM|Ransum/],
    ['.tcg bosgrup', ['tcg', 'bosgrup'], /Bos Arena|BOS|TUMBANG/],
    ['.tcg gaunlet (salah ketik)', ['tcg', 'gaunlet'], /GAUNTLET/]
  ]) {
    t = await jalankan(label, args);
    harus(label + ' membuka layar yang benar', t, pola);
  }

  // INI YANG PALING RAWAN: alias dek DENGAN argumen. Kalau alias baru tidak ikut
  // masuk blok PEMAKLUMAN, `.tcg tim 1 <id>` akan MENAMPILKAN dek tanpa memasang
  // apa pun — gagal senyap, persis bug yang blok itu dibuat untuk menutupnya.
  for (const s of [1, 2, 3]) await db.tcgClearDeckSlot(A, s);
  t = await jalankan('.tcg tim 1 CMN07 (alias dek + argumen)', ['tcg', 'tim', '1', 'CMN07']);
  const dekTim = await db.tcgGetDeck(A);
  benar('alias dek dengan argumen benar-benar MEMASANG kartu', dekTim[1]?.card_id === 'CMN07');

  t = await jalankan('.tcg dekku 2 CMN10 (alias dek + argumen)', ['tcg', 'dekku', '2', 'CMN10']);
  const dekKu = await db.tcgGetDeck(A);
  benar('alias dekku dengan argumen memasang kartu', dekKu[2]?.card_id === 'CMN10');

  for (const [s, id] of [[1, 'CMN07'], [2, 'CMN10'], [3, 'CMN05']]) await db.tcgSetDeckSlot(A, s, id, PETA_COST);
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
// 9e. REFINE R1-R5 & PICIS (v3.6)
// ============================================================
console.log('\n════ 9e. REFINE & PICIS ════');

// --- R1 wajib identik dengan sebelum refine ada ---
// Kalau ini bergeser, SELURUH keseimbangan yang sudah diukur ikut bergeser
// diam-diam: kurva Menara Abadi, kalibrasi Gauntlet, dan HP Bos semuanya
// dihitung pada angka skill R1.
{
  const geser = KARTU.filter(k => k.skill && skillEfektif(k, 1) !== SKILL[k.skill]);
  benar('R1 mengembalikan objek SKILL yang asli (semua kartu)', geser.length === 0);
  benar('TCG_MAKS_REFINE cermin dari MAKS_REFINE', db.TCG_MAKS_REFINE === MAKS_REFINE);

  // R5 wajib benar-benar melipatduakan, dan tidak boleh melewati batasnya.
  const gerhana = getKartu('MYT03');
  benar('R5 melipatduakan koefisien skill',
    Math.abs(skillEfektif(gerhana, 5).bukaan - SKILL[gerhana.skill].bukaan * 2) < 1e-9);
  const semuaR5 = KARTU.filter(k => k.skill).map(k => skillEfektif(k, 5));
  benar('tidak ada koefisien R5 yang melewati batasnya',
    semuaR5.every(s => (s.hindar || 0) <= 0.30 && (s.tahan || 0) <= 0.40 && (s.ganda || 0) <= 0.50));
  // ATK dan HP TIDAK BOLEH ikut naik — itu janji yang menjaga anggaran daya.
  benar('R tidak menyentuh anggaran daya', periksaKeseimbangan().length === 0);
}

// --- Perintah refine ---
t = await jalankan('.tcg refine (panduan)', ['tcg', 'refine']);
harus('panduan refine tampil', t, 'REFINE');
harus('menyebut biaya duplikat', t, /duplikat/i);

await db.tcgTambahKartu(A, 'CMN02', 4);   // 1 asli + 4 salinan
t = await jalankan('.tcg refine CMN02', ['tcg', 'refine', 'CMN02']);
harus('naik ke R2', t, 'R2');
t = await jalankan('.tcg refine CMN02 (R3)', ['tcg', 'refine', 'CMN02']);
harus('naik ke R3', t, 'R3');

{
  const k = await db.tcgGetKartu(A, 'CMN02');
  benar('refine tersimpan di basis data', (k?.refine || 1) === 3);
  benar('duplikat benar-benar dimakan', k.qty < 5);
}

// Duplikat yang sedang bertugas di dek TIDAK boleh ikut dimakan; kalau ia
// dimakan, slot dek menunjuk kartu yang sudah tidak dimiliki pemain.
{
  await db.runQuery("UPDATE tcg_collection SET qty = 1 WHERE owner_jid = ? AND card_id = ?", [A, 'CMN02']);
  t = await jalankan('.tcg refine CMN02 (duplikat habis)', ['tcg', 'refine', 'CMN02']);
  harus('menolak tanpa duplikat berlebih', t, 'tidak cukup');
  const k = await db.tcgGetKartu(A, 'CMN02');
  benar('penolakan tidak memakan apa pun', k.qty === 1 && (k.refine || 1) === 3);
}

t = await jalankan('.tcg kartu CMN02 (R tampil)', ['tcg', 'kartu', 'CMN02']);
harus('R tampil di layar kartu', t, /R\s+3\/5/);

// --- Picis ---
t = await jalankan('.tcg keping (dompet dua mata uang)', ['tcg', 'keping']);
harus('Keping tampil', t, 'Keping');
harus('Picis tampil', t, 'Picis');
harus('menjelaskan keduanya terpisah', t, /tidak bisa ditukar/i);

{
  // Naik level HARUS memakan Picis dan TIDAK BOLEH menyentuh Keping — itu
  // seluruh alasan Picis ada.
  const sebelum = await db.tcgGetWallet(A);
  await db.tcgTambahKartu(A, 'CMN19', 1);
  for (const r of ['COMMON']) await db.tcgTambahSerpihan(A, r, 40);
  await jalankan('.tcg naik CMN19 (bayar Picis)', ['tcg', 'naik', 'CMN19']);
  const sesudah = await db.tcgGetWallet(A);
  benar('naik level memakan Picis', sesudah.picis < sebelum.picis);
  benar('naik level TIDAK menyentuh Keping', sesudah.keping === sebelum.keping);
}

// ============================================================
// 9f. BANNER & RATE ON/OFF (v3.6)
// ============================================================
console.log('\n════ 9f. BANNER ════');

{
  const hariIni = db.tcgTanggalHariIni();
  const b = bannerAktif(hariIni);

  benar('banner punya 1 Mythic unggulan', b.mythic?.rarity === 'MYTHIC');
  benar('banner punya 2 Legendary unggulan',
    b.legendary.length === 2 && b.legendary.every(k => k.rarity === 'LEGENDARY'));
  benar('Legendary unggulan tidak kembar', b.legendary[0].id !== b.legendary[1].id);
  benar('banner sama sepanjang hari yang sama', bannerAktif(hariIni).id === b.id);
  benar('rateOn mengenali kartu unggulan', rateOn(b, b.mythic.id) && rateOn(b, b.legendary[0].id));

  // Kartu yang TIDAK unggulan wajib tetap dikenali sebagai rate OFF. Kalau
  // fungsi ini pernah salah bilang 'on', layar banner berbohong ke pemain.
  const bukan = KARTU.find(k => k.rarity === 'MYTHIC' && k.id !== b.mythic.id);
  benar('rateOn menolak kartu di luar banner', !rateOn(b, bukan.id));

  // Satu putaran penuh wajib memakai SEMUA Mythic — kalau rotasinya macet,
  // ada kartu yang jadi mustahil dikejar selamanya.
  const ms = Date.parse(`${hariIni}T00:00:00Z`);
  const tgl = (n) => new Date(ms + n * 86400000).toISOString().slice(0, 10);
  const jmlMythic = KARTU.filter(k => k.rarity === 'MYTHIC').length;
  const putaran = [];
  for (let i = 0; i < jmlMythic; i++) putaran.push(bannerAktif(tgl(i * 14)));
  benar(`${jmlMythic} banner berturut-turut memakai ${jmlMythic} Mythic berbeda`,
    new Set(putaran.map(b => b.mythic.id)).size === jmlMythic);

  // Dua banner berurutan tidak boleh berbagi Legendary maupun elemen Mythic.
  // Kalau berbagi, dua banner yang kartunya beda terasa seperti banner yang
  // sama diulang — terukur 21% sebelum jadwalnya dihitung per siklus.
  const panjang = 40;
  const deret = [];
  for (let i = 0; i < panjang; i++) deret.push(bannerAktif(tgl(i * 14)));
  let tumpang = 0, elemenSama = 0;
  for (let i = 1; i < panjang; i++) {
    const sebelum = new Set(deret[i - 1].legendary.map(k => k.id));
    if (deret[i].legendary.some(k => sebelum.has(k.id))) tumpang++;
    if (deret[i].mythic.elemen === deret[i - 1].mythic.elemen) elemenSama++;
  }
  benar('tidak ada Legendary yang tayang dua banner berturut-turut', tumpang === 0);
  benar('tidak ada dua banner berurutan yang Mythic-nya seelemen', elemenSama === 0);

  // Tiap Legendary harus kebagian tayang; kalau ada yang tidak pernah, ia
  // tidak akan pernah bisa dikejar lewat banner.
  const tampil = new Set(deret.flatMap(b => b.legendary.map(k => k.id)));
  benar('semua Legendary kebagian tayang dalam satu siklus',
    tampil.size === KARTU.filter(k => k.rarity === 'LEGENDARY').length);
}

// --- Mekanika 50/50 ---
{
  const b = bannerAktif(db.tcgTanggalHariIni());
  const daftar = (r) => KARTU.filter(k => k.rarity === r);

  // Jaminan menyala WAJIB memaksa kartu unggulan, tanpa kecuali.
  let lolos = true;
  for (let i = 0; i < 200; i++) {
    const st = { kalah_mythic: 1, kalah_legendary: 0 };
    const h = undiKartuBanner('MYTHIC', b, st, daftar);
    if (h.kartu.id !== b.mythic.id || !h.jaminanTerpakai || st.kalah_mythic !== 0) lolos = false;
  }
  benar('jaminan menyala selalu memberi kartu unggulan dan padam sesudahnya', lolos);

  // Kalah undian WAJIB menyalakan jaminan. Tanpa ini pemain bisa apes
  // berkali-kali berturut-turut, dan itu yang membuat orang berhenti main.
  let kalahTanpaJaminan = 0;
  let unggulan = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const st = { kalah_mythic: 0, kalah_legendary: 0 };
    const h = undiKartuBanner('MYTHIC', b, st, daftar);
    if (h.unggulan) unggulan++;
    else if (!st.kalah_mythic) kalahTanpaJaminan++;
  }
  benar('kalah 50/50 SELALU menyalakan jaminan', kalahTanpaJaminan === 0);
  const rasio = unggulan / N;
  benar(`peluang unggulan ~50% (terukur ${Math.round(rasio * 100)}%)`, rasio > 0.45 && rasio < 0.55);

  // Paling buruk dua Mythic untuk mendapat yang dikejar — itu janji sistemnya.
  let terburuk = 0;
  for (let i = 0; i < 500; i++) {
    const st = { kalah_mythic: 0, kalah_legendary: 0 };
    let n = 0;
    while (n < 10) {
      n++;
      if (undiKartuBanner('MYTHIC', b, st, daftar).unggulan) break;
    }
    terburuk = Math.max(terburuk, n);
  }
  benar('tidak pernah butuh lebih dari 2 Mythic', terburuk <= 2);

  // Rarity di bawah Legendary tidak punya unggulan sama sekali.
  const st = { kalah_mythic: 0, kalah_legendary: 0 };
  benar('Common tidak pernah ditandai unggulan',
    !undiKartuBanner('COMMON', b, st, daftar).unggulan);
}

// --- Layar banner ---
t = await jalankan('.tcg banner', ['tcg', 'banner']);
harus('judul banner tampil', t, 'BANNER');
harus('RATE ON tampil', t, 'RATE ON');
harus('RATE OFF tampil', t, 'RATE OFF');
harus('menjelaskan rate off tetap bisa keluar', t, /tetap bisa keluar/i);
harus('status jaminan tampil', t, 'JAMINAN');
harus('sisa hari tampil', t, /hari/);
t = await jalankan('.tcg unggulan (alias)', ['tcg', 'unggulan']);
harus('alias banner jalan', t, 'RATE ON');

// Jaminan disimpan per banner dan benar-benar mengendap di basis data.
{
  const b = bannerAktif(db.tcgTanggalHariIni());
  await db.tcgSimpanBanner(A, b.id, { kalah_mythic: 1, kalah_legendary: 0, tambahTarikan: 3 });
  const st = await db.tcgGetBanner(A, b.id);
  benar('jaminan tersimpan', st.kalah_mythic === 1);
  benar('hitungan tarikan bertambah', st.tarikan >= 3);
  t = await jalankan('.tcg banner (jaminan aktif)', ['tcg', 'banner']);
  harus('jaminan aktif terlihat pemain', t, 'AKTIF');
  harus('menyebut nama kartu yang dijamin', t, b.mythic.nama);

  // Banner LAIN wajib punya jaminan sendiri yang masih kosong.
  const lain = await db.tcgGetBanner(A, 'B-uji-lain');
  benar('jaminan tidak terbawa ke banner lain', (lain.kalah_mythic || 0) === 0);
}

// ============================================================
// 9g. LAYAR KEPUTUSAN HARUS MEMUAT ANGKANYA
// ============================================================
//
// Layar banner adalah tempat orang memutuskan membakar 1.800 Keping. Layar
// refine adalah tempat orang membakar duplikat secara permanen. Keduanya
// sempat cuma menyebut NAMA kartunya — keputusannya jadi tebakan, bukan
// pilihan. Pemeriksaan di sini menjaga angkanya tidak pernah hilang lagi.
console.log('\n════ 9g. KELENGKAPAN LAYAR KEPUTUSAN ════');

{
  const b = bannerAktif(db.tcgTanggalHariIni());
  const m = b.mythic;
  t = await jalankan('.tcg banner (kelengkapan)', ['tcg', 'banner']);
  harus('menyebut nama Mythic unggulan', t, m.nama);
  harus('menampilkan ATK', t, /ATK \*[\d.]+\*/);
  harus('menampilkan HP', t, /HP \*[\d.]+\*/);
  harus('menampilkan KRIT', t, /KRIT \*\d+%\*/);
  harus('menampilkan CP', t, /CP \*[\d.]+\*/);
  harus('menampilkan biaya bintang', t, /\(\d★\)/);
  harus('menampilkan nama skill', t, SKILL[m.skill].nama);
  harus('menampilkan angka efek skill', t, /%/);
  harus('menampilkan status kepemilikan', t, /Punya|Belum kamu punya/);
  harus('menampilkan kemajuan pity', t, /tarikan lagi/);
  harus('menampilkan biaya tarikan', t, /Biaya:/);
  harus('menampilkan saldo pemain', t, /Saldomu:/);
}

{
  // Refine wajib menunjukkan SEBELUM dan SESUDAH. Duplikat yang dibakar tidak
  // bisa dikembalikan, jadi angkanya harus terlihat sebelum tombol ditekan.
  await db.tcgTambahKartu(A, 'MYT03', 3);
  t = await jalankan('.tcg refine (daftar berangka)', ['tcg', 'refine']);
  harus('daftar refine memuat tingkat tujuan', t, /R\d ➜ \*R\d\*/);
  harus('daftar refine memuat efek sesudahnya', t, /➜ \*.*%/);

  const kalaRau = getKartu('MYT03');
  benar('ringkasan efek R1 dan R2 berbeda',
    ringkasEfekSkill(kalaRau, 1) !== ringkasEfekSkill(kalaRau, 2));
  benar('semua kartu berskill punya ringkasan efek',
    KARTU.filter(k => k.skill).every(k => ringkasEfekSkill(k, 1).length > 0));
  // Kalau ada kartu yang R-nya tidak mengubah satu angka pun, duplikatnya
  // tidak layak disimpan dan itu cacat desain, bukan pilihan pemain.
  benar('R selalu mengubah angka untuk setiap kartu',
    KARTU.filter(k => k.skill).every(k => ringkasEfekSkill(k, 1) !== ringkasEfekSkill(k, 5)));

  t = await jalankan('.tcg refine MYT03', ['tcg', 'refine', 'MYT03']);
  harus('hasil refine menampilkan efek baru', t, /➜ \*/);
  harus('hasil refine menawarkan tingkat berikutnya', t, /R3/);
}

{
  t = await jalankan('.tcg kartu MYT03 (tangga R)', ['tcg', 'kartu', 'MYT03']);
  harus('layar kartu memuat TANGGA LEVEL', t, 'TANGGA LEVEL');
  harus('layar kartu memuat TANGGA R', t, 'TANGGA R');
  harus('tangga R memuat kelima tingkat', t, /R5\s+\S/);
  harus('tangga R menandai posisi sekarang', t, /R2 .*<|R2\s+.*  </);

  // Daftar koleksi harus menandai kartu yang SUDAH di-refine; tanpa itu pemain
  // tidak punya cara melihat R-nya selain membuka kartunya satu per satu.
  t = await jalankan('.tcg koleksi (tanda R)', ['tcg', 'koleksi']);
  harus('koleksi menandai kartu ber-R', t, /R2/);

  // Layar dek wajib menampilkan ANGKA skill, bukan cuma namanya: kartu ber-R
  // tinggi berperilaku sangat berbeda dari kartu yang sama di R1, dan tanpa
  // angkanya pemain tidak punya cara melihat bedanya.
  await jalankan('.tcg pasang 1 MYT03', ['tcg', 'pasang', '1', 'MYT03']);
  t = await jalankan('.tcg dek (angka skill)', ['tcg', 'dek']);
  harus('dek menampilkan angka efek skill', t, /⚡ .*%/);
  harus('dek menandai R kartu', t, /R2/);
}

{
  // Level dan refine memperebutkan DUPLIKAT yang sama, jadi ongkos keduanya
  // harus sebanding. Kalau salah satu jauh lebih murah, sumbu yang satunya
  // mati — dan itu persis yang terjadi sebelum kurva serpihan dipangkas:
  // menaikkan Common ke Lv.5 berharga 7,5x lipat me-refine-nya ke R5, jadi
  // tidak ada alasan rasional untuk pernah menaikkan level.
  const dupRefine = db.TCG_MAKS_REFINE - 1;
  const rasio = {};
  for (const r of db.TCG_RARITY) {
    let s = 0;
    for (let lv = 1; lv <= 4; lv++) s += db.TCG_BIAYA_LEVEL[r][lv];
    rasio[r] = s / dupRefine;
  }
  benar('ongkos level sebanding dengan ongkos refine di semua rarity',
    db.TCG_RARITY.every(r => rasio[r] >= 1.5 && rasio[r] <= 3.0));
  // Kurva serpihan wajib menaik: naik ke Lv.5 tidak boleh lebih murah daripada
  // naik ke Lv.2, kalau tidak pemain didorong menimbun level akhir lebih dulu.
  benar('kurva serpihan tiap rarity tidak pernah menurun',
    db.TCG_RARITY.every(r => [1, 2, 3].every(lv => db.TCG_BIAYA_LEVEL[r][lv] <= db.TCG_BIAYA_LEVEL[r][lv + 1])));
  console.log('  ✅ rasio level:refine — ' +
    db.TCG_RARITY.map(r => `${r[0]}${rasio[r].toFixed(2)}x`).join(' '));
}

// ============================================================
// 9h. BATAS TARIKAN HARIAN YANG BISA DINAIKKAN OWNER
// ============================================================
console.log('\n════ 9h. BATAS TARIKAN HARIAN ════');

{
  // Semua orang boleh MELIHAT batasnya; hanya Owner yang boleh mengubah.
  t = await jalankan('.tcg batas (pemain biasa)', ['tcg', 'batas']);
  harus('batas bisa dilihat siapa saja', t, 'BATAS TARIKAN HARIAN');
  t = await jalankan('.tcg batas 50 (bukan owner)', ['tcg', 'batas', '50']);
  harus('pemain biasa tidak boleh mengubah', t, 'khusus');
  benar('penolakan tidak mengubah batas',
    (await db.tcgStatusBatasTarik()).batas === db.TCG_BATAS_TARIK_HARIAN);

  t = await jalankan('.tcg batas 50 (owner)', ['tcg', 'batas', '50'], { owner: true });
  harus('owner berhasil menaikkan', t, /50/);
  harus('menyebut berlaku hari ini saja', t, /hari ini saja/i);
  const st = await db.tcgStatusBatasTarik();
  benar('batas benar-benar naik', st.batas === 50 && st.dinaikkan);

  // Yang paling penting: batas baru harus BENAR-BENAR dipakai penghitung jatah,
  // bukan cuma tampil di layar.
  const sisa = await db.tcgSisaTarikanHarian(B);
  benar('jatah pemain ikut naik', sisa > db.TCG_BATAS_TARIK_HARIAN);

  t = await jalankan('.tcg rate (batas naik terlihat)', ['tcg', 'rate']);
  harus('layar peluang menampilkan batas baru', t, /50/);
  t = await jalankan('.tcg (menu umumkan batas)', ['tcg']);
  harus('menu mengumumkan batas naik', t, /Batas gacha hari ini naik/i);

  // Batas atas menjaga satu salah ketik tidak menguras Keping seluruh grup.
  t = await jalankan('.tcg batas 9999', ['tcg', 'batas', '9999'], { owner: true });
  harus('menolak angka di atas batas atas', t, /Maksimal/);
  benar('penolakan tidak menggeser batas', (await db.tcgStatusBatasTarik()).batas === 50);
}

{
  // INTI RANCANGANNYA: aturan dikunci ke TANGGAL, jadi ia hangus sendiri.
  // Baris bertanggal kemarin TIDAK BOLEH berlaku hari ini — kalau ia berlaku,
  // batas yang dinaikkan sekali akan menetap selamanya dan tidak ada yang
  // menyadarinya sampai ekonominya rusak.
  await db.runQuery("DELETE FROM tcg_batas_tarik");
  await db.runQuery(
    "INSERT INTO tcg_batas_tarik (tanggal, batas, oleh) VALUES ('2020-01-01', 199, 'uji')"
  );
  const st = await db.tcgStatusBatasTarik();
  benar('aturan tanggal lama tidak berlaku hari ini',
    st.batas === db.TCG_BATAS_TARIK_HARIAN && !st.dinaikkan && !st.adaAturan);
  benar('jatah pemain kembali normal',
    (await db.tcgSisaTarikanHarian(B)) <= db.TCG_BATAS_TARIK_HARIAN);
}

{
  await jalankan('.tcg batas 35', ['tcg', 'batas', '35'], { owner: true });
  t = await jalankan('.tcg batas normal', ['tcg', 'batas', 'normal'], { owner: true });
  harus('bisa dibatalkan lebih awal', t, /dikembalikan/i);
  benar('pembatalan mengembalikan angka normal',
    (await db.tcgStatusBatasTarik()).batas === db.TCG_BATAS_TARIK_HARIAN);
}

// ============================================================
// 12. INVARIAN STAT & MESIN TEMPUR
// ============================================================
console.log('\n════ 12. INVARIAN ════');
benar('semua kartu di dalam anggaran daya', periksaKeseimbangan().length === 0);
benar('ID kartu unik', new Set(KARTU.map(k => k.id)).size === TOTAL_KARTU);
benar('profil stat unik', new Set(KARTU.map(k => `${k.atk}/${k.hp}`)).size === TOTAL_KARTU);
console.log(`  ✅ ${TOTAL_KARTU} kartu · ${new Set(KARTU.map(k => `${k.atk}/${k.hp}`)).size} profil stat unik · anggaran daya aman`);

// --- GELAR (v3.5) ---
// Gelar hanya boleh ada di Legendary dan Mythic: ketiadaannya di tier bawah
// adalah penanda tier, jadi kalau ia bocor ke Common dia berhenti berarti.
const TIER_BERGELAR = ['LEGENDARY', 'MYTHIC'];
const bergelar = KARTU.filter(k => k.gelar);
benar('gelar hanya di Legendary & Mythic',
  bergelar.every(k => TIER_BERGELAR.includes(k.rarity)));
benar('semua Legendary & Mythic punya gelar',
  KARTU.filter(k => TIER_BERGELAR.includes(k.rarity)).every(k => !!k.gelar));
benar('tidak ada id yatim di peta GELAR',
  Object.keys(GELAR).every(id => KARTU.some(k => k.id === id)));
benar('gelar unik antar kartu', new Set(bergelar.map(k => k.gelar)).size === bergelar.length);
// Kartu digambar 300px; gelar yang terlalu panjang akan diperkecil terus oleh
// tulisMuat sampai mentok 10px dan berubah jadi bubur. 34 huruf adalah batas
// aman yang terukur untuk font italic 12px di lebar 270px.
benar('tidak ada gelar yang kepanjangan untuk kartu',
  bergelar.every(k => k.gelar.length <= 34));
benar('MYT03 bernama Kala Rau, bukan Voidreaper', getKartu('MYT03').nama === 'Kala Rau');
console.log(`  ✅ ${bergelar.length} gelar · hanya Legendary/Mythic · MYT03 = ${getKartu('MYT03').nama}`);

// Gelar wajib benar-benar SAMPAI ke layar. Peta yang terisi tapi tidak pernah
// tercetak adalah persis jenis kegagalan senyap yang §12v catat.
const layarMythic = await jalankan('.tcg kartu MYT03 (gelar)', ['tcg', 'kartu', 'MYT03']);
benar('layar kartu memuat nama Kala Rau', layarMythic.includes('KALA RAU'));
benar('layar kartu memuat gelarnya', layarMythic.includes('The Eclipse Devourer'));
const layarCommon = await jalankan('.tcg kartu CMN01 (tanpa gelar)', ['tcg', 'kartu', 'CMN01']);
benar('kartu Common tidak mencetak baris gelar kosong', !layarCommon.includes('""'));
const layarNama = await jalankan('.tcg kartu kala rau (cari via nama)', ['tcg', 'kartu', 'kala', 'rau']);
benar('nama baru bisa dicari', layarNama.includes('KALA RAU'));

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
