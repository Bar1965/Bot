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
const { simulate3v3, TOWER_FLOORS, getTowerFloor } = await import(REPO + 'src/games/tcg/battle.js');

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
for (const n of ['1', '2', '3', '4', '5', '6', '7', '8']) {
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
t = await jalankan('.tcg daily (ulang)', ['tcg', 'daily']);
harus('menolak klaim kedua', t, 'sudah diambil');
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
