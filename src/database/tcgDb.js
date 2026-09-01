/**
 * TCG ARENA KARTU MONSTER — LAPISAN DATABASE (PURE 0 CLOSED ECONOMY)
 *
 * Mata uang arena (Keping) 100% mandiri dan terisolasi di dalam game arena.
 * Tidak ada konversi poin luar -> Keping untuk menjamin keadilan (Fair Play)
 * di mana semua pemain memulai dari titik awal yang sama.
 */

import { runQuery, getQuery, allQuery, withTransaction } from './connection.js';
import { MAKS_BIAYA_DEK, getKartu, statKartu, costKartu, hitungSinergi, pengaliElemen } from '../games/tcg/cards.js';

// --- Tetapan ekonomi arena (Pure 0) ---
export const TCG_HARGA_TARIK = 200;
export const TCG_HARGA_TARIK10 = 1800;
export const TCG_BATAS_TARIK_HARIAN = 20;

/**
 * Batas paling tinggi yang boleh dipasang Owner untuk sehari.
 *
 * Ada karena satu salah ketik — `.tcg batas 2000` alih-alih `200` — akan
 * membiarkan seluruh grup menguras Kepingnya dalam satu sore, dan tidak ada
 * cara membatalkannya sesudah kartunya keluar.
 */
export const TCG_BATAS_TARIK_MAKS = 200;
export const TCG_BONUS_HARIAN_KEPING = 50;
export const TCG_BONUS_STARTER_KEPING = 150;
// Picis di paket pemula bukan hiasan: tanpa ini pemain baru punya 0 Picis dan
// TIDAK BISA menaikkan level satu kali pun sampai ia menyelesaikan Gerbang
// atau Ekspedisi pertamanya. Uji asap menangkapnya persis begitu — seluruh
// rangkaian `.tcg naik` gagal dengan 'Butuh 250 Picis, kamu punya 0'.
export const TCG_BONUS_STARTER_PICIS = 2500;
// Diambil dari katalog kartu: validasi dek dan perhitungan sinergi Pasukan
// Ramping memakai angka yang sama, jadi keduanya tidak boleh pernah berbeda.
export const TCG_MAX_DECK_COST = MAKS_BIAYA_DEK;
/**
 * ENERGI DIPISAH PER AKTIVITAS.
 *
 * Dulu satu kolom `stamina` (5/hari) dipakai bareng oleh Menara dan Gerbang,
 * sementara Sparring punya jatah sendiri. Akibatnya persis seperti keluhan
 * pemain di grup: menyiapkan dek untuk menara pagi hari lalu sadar farming
 * gerbang memakan kantong yang sama. Dua aktivitas ini beda tujuan — menara
 * itu progres satu arah (30 lantai, ada ujungnya), gerbang itu farming harian
 * berulang — jadi tidak boleh berebut satu anggaran.
 *
 * Pengisian juga diganti dari "reset penuh jam 00:00" menjadi regen bertahap.
 * Reset harian membuat pemain menghabiskan semuanya pagi hari lalu bot mati
 * buat dia sampai besok; regen membuat arena hidup sepanjang hari.
 */
export const TCG_MAX_STAMINA_MENARA = 3;
export const TCG_REGEN_MENARA_MS = 6 * 60 * 60 * 1000;   // +1 tiap 6 jam
export const TCG_MAX_ENERGI_GERBANG = 5;
export const TCG_REGEN_GERBANG_MS = 4 * 60 * 60 * 1000;  // +1 tiap 4 jam

/** Alias lama; sekarang berarti kapasitas stamina Menara. */
export const TCG_MAX_STAMINA = TCG_MAX_STAMINA_MENARA;

export const TCG_RARITY = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'MYTHIC'];

export const TCG_HARGA_JUAL = {
  COMMON: 25,
  RARE: 60,
  EPIC: 150,
  LEGENDARY: 400,
  MYTHIC: 1000
};

/**
 * Biaya naik level dalam serpihan rarity yang sama. Indeks = level saat ini.
 *
 * ============================================================
 * KENAPA ANGKANYA DIPANGKAS
 * ============================================================
 * Sistem level praktis mati: 212 dari 218 baris koleksi di server masih Lv.1.
 * Diagnosis pertama menyalahkan biaya Keping-nya, dan itu SALAH — buku besar
 * mencatat `NAIK_LEVEL` cuma 1,3% dari peredaran Keping. Kalau orang benar-benar
 * memilih gacha ketimbang level, angkanya akan besar tapi kalah; 1,3% berarti
 * nyaris tidak ada yang pernah MENCOBA. Itu tanda tembok, bukan tanda
 * persaingan. (Memisahkan biaya level ke Picis tetap benar dan tetap ada, tapi
 * ia bukan yang membuka tembok ini.)
 *
 * Temboknya serpihan. Satu duplikat menghasilkan tepat SATU serpihan, jadi
 * dengan kurva lama menaikkan satu kartu Common ke Lv.5 menuntut 30 duplikat —
 * sekitar 15 hari farming gerbang untuk SATU kartu.
 *
 * Yang membuatnya benar-benar rusak adalah kedatangan refine: R1 ➜ R5 cuma
 * menuntut 4 duplikat di semua rarity. Dengan kurva lama, menaikkan level
 * berharga 7,5x lipat refine di Common dan 5,8x di Rare, padahal keduanya
 * memperebutkan duplikat yang sama. Pemain yang berpikir jernih akan selalu
 * memilih refine dan tidak pernah menaikkan level — sumbu lama mati untuk
 * kedua kalinya.
 *
 * Angka baru menahan perbandingan level:refine di kisaran 1,75x-2,75x untuk
 * SEMUA rarity. Cukup mahal supaya memilih terasa berarti, tidak cukup mahal
 * untuk jadi jebakan. Common ke Lv.5 turun dari ~15 hari jadi ~5,5 hari.
 *
 * Legendary dan Mythic sengaja TIDAK disentuh: keduanya sudah di 2,75x dan
 * 1,75x, dan serpihannya sudah mahal luar biasa lewat rantai lebur 5:1 (satu
 * serpihan Mythic setara 625 serpihan Common).
 *
 *   rarity      lama            baru           duplikat  vs refine
 *   COMMON      2,4,8,16 = 30   1,2,3,5 = 11   11        2,75x
 *   RARE        2,3,6,12 = 23   1,2,3,4 = 10   10        2,50x
 *   EPIC        1,2,4,8  = 15   1,1,2,4 =  8    8        2,00x
 *   LEGENDARY   1,2,3,5  = 11   (tetap)        11        2,75x
 *   MYTHIC      1,1,2,3  =  7   (tetap)         7        1,75x
 */
export const TCG_BIAYA_LEVEL = {
  COMMON:    { 1: 1, 2: 2, 3: 3, 4: 5 },
  RARE:      { 1: 1, 2: 2, 3: 3, 4: 4 },
  EPIC:      { 1: 1, 2: 1, 3: 2, 4: 4 },
  LEGENDARY: { 1: 1, 2: 2, 3: 3, 4: 5 },
  MYTHIC:    { 1: 1, 2: 1, 3: 2, 4: 3 }
};

export const TCG_SERPIHAN_PER_LEBUR = 5;

// ============================================================
// PICIS — MATA UANG KEDUA, KHUSUS MENAIKKAN LEVEL
// ============================================================
/**
 * Dulu naik level dibayar Keping, mata uang yang sama dengan gacha. Itu
 * memaksa pemain memilih antara MENARIK dan MENGUATKAN, dan datanya
 * menunjukkan siapa yang menang: 212 dari 218 baris koleksi di server masih
 * Lv.1. Sistem levelnya praktis mati.
 *
 * Picis memisahkan dua keputusan itu, persis seperti Mora di Genshin yang
 * tidak pernah berebut dengan Primogem. Sekarang:
 *
 *   Keping   -> gacha, dan HANYA gacha
 *   Picis    -> naik level (stat)
 *   Serpihan -> naik level (bahan, per rarity)
 *   Duplikat -> refine R1-R5 (skill)
 *
 * Empat sumber daya, empat tujuan, tidak ada yang saling memakan. Nama
 * "picis" dipilih karena artinya memang uang receh bernilai kecil (idiom
 * "picisan"): melimpah, satuannya kecil, dibelanjakan borongan. Nama lain
 * yang dipertimbangkan gugur karena tabrakan koreksi salah ketik — `kepeng`
 * berjarak 1 dari `keping`, `gobang` berjarak 2 dari `gerbang`, `wang`
 * berjarak 2 dari `rank`, `.bank`, dan `.ping`.
 */
export const TCG_BIAYA_LEVEL_PICIS = 250;

/** Picis untuk naik level: 250 x bintang kartu x level saat ini. */
export function tcgBiayaPicisLevel(bintang, levelSaatIni) {
  const b = Math.max(1, Math.min(5, Math.floor(bintang) || 1));
  const lv = Math.max(1, Math.min(4, Math.floor(levelSaatIni) || 1));
  return TCG_BIAYA_LEVEL_PICIS * b * lv;
}

// Sumber Picis. Sengaja ditaruh di dua lingkaran harian yang sudah ada supaya
// tidak perlu perintah baru: pemain yang main tiap hari otomatis mampu
// menaikkan level, dan yang tidak main tidak menumpuk apa-apa.
export const TCG_PICIS_GERBANG = 320;
export const TCG_PICIS_EKSPEDISI_PER_SLOT = 260;
// Jatah sekali seumur hidup untuk pemain yang sudah ada sebelum Picis lahir.
// Tanpa ini fitur level tetap mati di hari pertama karena saldo semua orang 0.
export const TCG_PICIS_WARISAN = 3000;

// ============================================================
// REFINE (R1-R5)
// ============================================================
/**
 * Satu duplikat menaikkan satu tingkat, jadi R5 menuntut 4 duplikat di luar
 * kartu aslinya — sama seperti refinement senjata di Genshin.
 *
 * Untuk Common itu ringan, dan itu memang tujuannya: Common akhirnya punya
 * alasan dikoleksi selain dipecah. Untuk Mythic itu brutal — di seluruh server
 * baru ada 3 keping Mythic yang pernah ada. Justru di situ letak "wajib
 * pull"-nya: R5 Mythic adalah kejaran jangka panjang, bukan sesuatu yang
 * selesai dalam sepekan.
 */
export const TCG_REFINE_DUP_PER_TINGKAT = 1;

// Dicerminkan dari MAKS_REFINE di cards.js. tcgDb.js sengaja tidak mengimpor
// katalog kartu — lapisan data tidak boleh bergantung pada lapisan permainan —
// jadi angka ini ditulis ulang di sini. Uji asap mengunci keduanya tetap sama.
export const TCG_MAKS_REFINE = 5;

/**
 * Biaya Keping untuk naik level, dikali bintang kartu dan level tujuan.
 *
 * Ada di sini sebagai penyeimbang: begitu Sparring, Ekspedisi, dan Gerbang
 * dibuka, pemasukan naik berkali lipat sementara satu-satunya pembuangan tetap
 * gacha. Tanpa lubang kedua yang ikut tumbuh, kelebihan Keping hanya memindah
 * temboknya, bukan menghapusnya. Menaikkan level adalah sink yang tepat karena
 * makin banyak kartu bagus yang dimiliki, makin besar yang ingin dinaikkan.
 */
export const TCG_BIAYA_LEVEL_KEPING = 40;

export function tcgBiayaKepingLevel(bintang, levelSaatIni) {
  const b = Math.max(1, Math.min(5, Math.floor(bintang) || 1));
  const lv = Math.max(1, Math.min(4, Math.floor(levelSaatIni) || 1));
  return TCG_BIAYA_LEVEL_KEPING * b * lv;
}

/**
 * Tanggal WIB dalam bentuk YYYY-MM-DD, dipakai untuk mereset batas harian.
 */
export function tcgTanggalHariIni() {
  const wib = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return wib.toISOString().slice(0, 10);
}

export async function initTcgSchema() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_collection (
      owner_jid TEXT NOT NULL,
      card_id   TEXT NOT NULL,
      qty       INTEGER NOT NULL DEFAULT 0 CHECK(qty >= 0),
      card_lv   INTEGER NOT NULL DEFAULT 1 CHECK(card_lv BETWEEN 1 AND 5),
      first_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (owner_jid, card_id)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_shards (
      owner_jid TEXT NOT NULL,
      rarity    TEXT NOT NULL,
      jumlah    INTEGER NOT NULL DEFAULT 0 CHECK(jumlah >= 0),
      PRIMARY KEY (owner_jid, rarity)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_wallet (
      owner_jid      TEXT PRIMARY KEY,
      keping         INTEGER NOT NULL DEFAULT 0 CHECK(keping >= 0),
      starter_at     DATETIME
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_pity (
      owner_jid         TEXT PRIMARY KEY,
      sejak_legendary   INTEGER NOT NULL DEFAULT 0,
      sejak_mythic      INTEGER NOT NULL DEFAULT 0,
      total_pull        INTEGER NOT NULL DEFAULT 0,
      pull_hari_ini     INTEGER NOT NULL DEFAULT 0,
      tanggal_hari_ini  TEXT,
      gratis_tanggal    TEXT
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_ledger (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_jid  TEXT NOT NULL,
      delta      INTEGER NOT NULL,
      sumber     TEXT NOT NULL,
      ref        TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_deck (
      owner_jid TEXT NOT NULL,
      slot      INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 3),
      card_id   TEXT NOT NULL,
      PRIMARY KEY (owner_jid, slot)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_tower (
      owner_jid       TEXT PRIMARY KEY,
      highest_floor   INTEGER NOT NULL DEFAULT 0,
      stamina         INTEGER NOT NULL DEFAULT 5,
      stamina_tanggal TEXT,
      stamina_at      INTEGER,
      energi_gerbang  INTEGER DEFAULT 5,
      energi_at       INTEGER,
      last_clear_at   DATETIME
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_misi (
      owner_jid TEXT NOT NULL,
      tanggal   TEXT NOT NULL,
      misi_id   TEXT NOT NULL,
      progres   INTEGER NOT NULL DEFAULT 0 CHECK(progres >= 0),
      diklaim   INTEGER NOT NULL DEFAULT 0 CHECK(diklaim IN (0, 1)),
      PRIMARY KEY (owner_jid, tanggal, misi_id)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_batas_tarik (
      tanggal   TEXT PRIMARY KEY,
      batas     INTEGER NOT NULL CHECK(batas > 0),
      oleh      TEXT,
      dibuat_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_banner (
      owner_jid       TEXT NOT NULL,
      banner_id       TEXT NOT NULL,
      kalah_mythic    INTEGER NOT NULL DEFAULT 0 CHECK(kalah_mythic IN (0, 1)),
      kalah_legendary INTEGER NOT NULL DEFAULT 0 CHECK(kalah_legendary IN (0, 1)),
      tarikan         INTEGER NOT NULL DEFAULT 0,
      dapat_mythic    INTEGER NOT NULL DEFAULT 0,
      dapat_legendary INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (owner_jid, banner_id)
    )
  `);

  await runQuery("CREATE INDEX IF NOT EXISTS idx_tcg_coll_owner ON tcg_collection(owner_jid)");

  // --- Migrasi kolom (aman dijalankan berulang) ---
  //
  // Pola `try/catch` kosong dipakai konsisten di schema.js: SQLite tidak punya
  // ADD COLUMN IF NOT EXISTS, jadi percobaan kedua melempar dan itu memang
  // hasil yang diinginkan.
  try {
    await runQuery(
      "ALTER TABLE tcg_collection ADD COLUMN refine INTEGER NOT NULL DEFAULT 1"
    );
  } catch (e) { /* sudah ada */ }

  try {
    await runQuery("ALTER TABLE tcg_wallet ADD COLUMN picis INTEGER NOT NULL DEFAULT 0");
    // HANYA berjalan pada migrasi pertama, karena ALTER kedua kalinya melempar
    // sebelum baris ini tercapai. Itu yang membuat jatah warisan tidak mungkin
    // dibagikan dua kali.
    await runQuery("UPDATE tcg_wallet SET picis = ?", [TCG_PICIS_WARISAN]);
    await runQuery(
      "INSERT INTO tcg_ledger (owner_jid, delta, sumber, ref) " +
      "SELECT owner_jid, 0, 'PICIS_WARISAN', ? FROM tcg_wallet",
      [String(TCG_PICIS_WARISAN)]
    );
  } catch (e) { /* sudah ada */ }
  await runQuery("CREATE INDEX IF NOT EXISTS idx_tcg_ledger_own ON tcg_ledger(owner_jid, created_at)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_tcg_deck_owner ON tcg_deck(owner_jid)");

  await initTcgFarmSchema();
  await initTcgDropSchema();
}

// ============================================================
// DOMPET KEPING
// ============================================================

// ============================================================
// BANNER — JAMINAN 50/50 PER PEMAIN, PER BANNER
// ============================================================
/**
 * Barisnya dikunci ke `banner_id`, jadi jaminan yang belum terpakai TIDAK
 * terbawa ke banner berikutnya.
 *
 * Itu keputusan yang disengaja dan perlu diketahui pemain. Membawa jaminan
 * antar banner terdengar lebih murah hati, tapi ia menghapus seluruh urgensi
 * banner: tidak ada bedanya menarik sekarang atau bulan depan. Yang penting,
 * pity global (`tcg_pity`) TIDAK ikut direset — kemajuan menuju Mythic yang
 * sudah dikumpulkan pemain selama ini tetap utuh, cuma undian 50/50-nya yang
 * mulai dari nol tiap banner.
 */
export async function tcgGetBanner(ownerJid, bannerId) {
  await runQuery(
    "INSERT OR IGNORE INTO tcg_banner (owner_jid, banner_id) VALUES (?, ?)",
    [ownerJid, bannerId]
  );
  const row = await getQuery(
    "SELECT * FROM tcg_banner WHERE owner_jid = ? AND banner_id = ?",
    [ownerJid, bannerId]
  );
  return row || {
    owner_jid: ownerJid, banner_id: bannerId,
    kalah_mythic: 0, kalah_legendary: 0, tarikan: 0, dapat_mythic: 0, dapat_legendary: 0
  };
}

/** Menyimpan kembali status jaminan sesudah satu rangkaian tarikan. */
export async function tcgSimpanBanner(ownerJid, bannerId, status) {
  await runQuery(
    "INSERT OR IGNORE INTO tcg_banner (owner_jid, banner_id) VALUES (?, ?)",
    [ownerJid, bannerId]
  );
  await runQuery(
    "UPDATE tcg_banner SET kalah_mythic = ?, kalah_legendary = ?, " +
    "tarikan = tarikan + ?, dapat_mythic = dapat_mythic + ?, dapat_legendary = dapat_legendary + ? " +
    "WHERE owner_jid = ? AND banner_id = ?",
    [
      status.kalah_mythic ? 1 : 0,
      status.kalah_legendary ? 1 : 0,
      Math.max(0, Math.floor(status.tambahTarikan || 0)),
      Math.max(0, Math.floor(status.tambahMythic || 0)),
      Math.max(0, Math.floor(status.tambahLegendary || 0)),
      ownerJid, bannerId
    ]
  );
}

export async function tcgGetWallet(ownerJid) {
  await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [ownerJid]);
  const w = await getQuery("SELECT * FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
  return w || { owner_jid: ownerJid, keping: 0, starter_at: null };
}

/**
 * Tambah Keping + catat di buku besar. Selalu satu transaksi supaya saldo
 * dan buku besar tidak pernah berbeda.
 */
export async function tcgAddKeping(ownerJid, jumlah, sumber, ref = null) {
  const n = Math.floor(Number(jumlah));
  if (!isFinite(n) || n <= 0) return { success: false, reason: 'JUMLAH_TIDAK_VALID' };

  return withTransaction(async () => {
    await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [ownerJid]);
    await runQuery("UPDATE tcg_wallet SET keping = keping + ? WHERE owner_jid = ?", [n, ownerJid]);
    await runQuery(
      "INSERT INTO tcg_ledger (owner_jid, delta, sumber, ref) VALUES (?, ?, ?, ?)",
      [ownerJid, n, sumber, ref]
    );
    const w = await getQuery("SELECT keping, picis FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
    return { success: true, keping: w.keping };
  });
}

/**
 * Kurangi Keping dengan syarat menyatu di satu perintah SQL.
 */
export async function tcgSpendKeping(ownerJid, jumlah, sumber, ref = null) {
  const n = Math.floor(Number(jumlah));
  if (!isFinite(n) || n <= 0) return { success: false, reason: 'JUMLAH_TIDAK_VALID' };

  return withTransaction(async () => {
    await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [ownerJid]);
    const res = await runQuery(
      "UPDATE tcg_wallet SET keping = keping - ? WHERE owner_jid = ? AND keping >= ?",
      [n, ownerJid, n]
    );
    if (res.changes !== 1) {
      const w = await getQuery("SELECT keping, picis FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
      return { success: false, reason: 'KEPING_KURANG', keping: w?.keping || 0 };
    }
    await runQuery(
      "INSERT INTO tcg_ledger (owner_jid, delta, sumber, ref) VALUES (?, ?, ?, ?)",
      [ownerJid, -n, sumber, ref]
    );
    const w = await getQuery("SELECT keping, picis FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
    return { success: true, keping: w.keping };
  });
}

// ============================================================
// PITY & BATAS TARIKAN
// ============================================================

export async function tcgGetPity(ownerJid) {
  await runQuery("INSERT OR IGNORE INTO tcg_pity (owner_jid) VALUES (?)", [ownerJid]);
  const p = await getQuery("SELECT * FROM tcg_pity WHERE owner_jid = ?", [ownerJid]);
  const hariIni = tcgTanggalHariIni();
  if (p && p.tanggal_hari_ini !== hariIni) {
    await runQuery(
      "UPDATE tcg_pity SET pull_hari_ini = 0, tanggal_hari_ini = ? WHERE owner_jid = ?",
      [hariIni, ownerJid]
    );
    p.pull_hari_ini = 0;
    p.tanggal_hari_ini = hariIni;
  }
  return p;
}

/**
 * BATAS TARIKAN HARIAN YANG BISA DINAIKKAN OWNER — UNTUK SEHARI SAJA
 *
 * Barisnya dikunci ke TANGGAL, bukan ke sebuah saklar menyala/mati. Itu yang
 * membuatnya mustahil lupa dimatikan: besok tanggalnya berganti, barisnya tidak
 * cocok lagi, dan batasnya kembali ke angka normal dengan sendirinya.
 *
 * Pola yang sama dipakai `dekAbadi`, `bosPekan`, dan jadwal banner, dan alasannya
 * sama: `scheduler.js` tidak pernah menyentuh TCG sama sekali (AGENTS.md §12v),
 * jadi apa pun yang harus berakhir sendiri WAJIB diturunkan dari waktu. Saklar
 * biasa akan tetap menyala kalau bot kebetulan mati di tengah malam.
 *
 * Baris tanggal lama sengaja tidak dihapus — murah disimpan dan berguna kalau
 * nanti pemilik ingin melihat kapan saja batasnya pernah dinaikkan.
 */
export async function tcgBatasTarikHariIni() {
  const row = await getQuery(
    "SELECT batas FROM tcg_batas_tarik WHERE tanggal = ?",
    [tcgTanggalHariIni()]
  );
  const n = Math.floor(Number(row?.batas));
  if (!Number.isFinite(n) || n <= 0) return TCG_BATAS_TARIK_HARIAN;
  return Math.min(TCG_BATAS_TARIK_MAKS, n);
}

/** Status lengkap, untuk layar yang perlu tahu ini batas normal atau bukan. */
export async function tcgStatusBatasTarik() {
  const hariIni = tcgTanggalHariIni();
  const row = await getQuery(
    "SELECT batas, oleh FROM tcg_batas_tarik WHERE tanggal = ?",
    [hariIni]
  );
  const batas = await tcgBatasTarikHariIni();
  return {
    batas,
    normal: TCG_BATAS_TARIK_HARIAN,
    dinaikkan: batas > TCG_BATAS_TARIK_HARIAN,
    diturunkan: batas < TCG_BATAS_TARIK_HARIAN,
    adaAturan: !!row,
    oleh: row?.oleh || null,
    tanggal: hariIni
  };
}

export async function tcgSetBatasTarikHariIni(batas, oleh = null) {
  const n = Math.floor(Number(batas));
  if (!Number.isFinite(n) || n < 1) return { success: false, reason: 'TIDAK_VALID' };
  if (n > TCG_BATAS_TARIK_MAKS) {
    return { success: false, reason: 'TERLALU_TINGGI', maks: TCG_BATAS_TARIK_MAKS };
  }
  await runQuery(
    `INSERT INTO tcg_batas_tarik (tanggal, batas, oleh) VALUES (?, ?, ?)
       ON CONFLICT(tanggal) DO UPDATE SET batas = ?, oleh = ?, dibuat_at = CURRENT_TIMESTAMP`,
    [tcgTanggalHariIni(), n, oleh, n, oleh]
  );
  return { success: true, batas: n, normal: TCG_BATAS_TARIK_HARIAN };
}

export async function tcgHapusBatasTarikHariIni() {
  const res = await runQuery(
    "DELETE FROM tcg_batas_tarik WHERE tanggal = ?",
    [tcgTanggalHariIni()]
  );
  return { success: true, adaSebelumnya: res.changes > 0, batas: TCG_BATAS_TARIK_HARIAN };
}

export async function tcgSisaTarikanHarian(ownerJid) {
  const [p, batas] = await Promise.all([tcgGetPity(ownerJid), tcgBatasTarikHariIni()]);
  return Math.max(0, batas - (p.pull_hari_ini || 0));
}

/**
 * Catat hasil satu tarikan: perbarui penghitung pity dan jatah harian.
 */
export async function tcgCatatTarikan(ownerJid, rarity, gratis = false) {
  const hariIni = tcgTanggalHariIni();
  await withTransaction(async () => {
    await runQuery("INSERT OR IGNORE INTO tcg_pity (owner_jid) VALUES (?)", [ownerJid]);
    await runQuery(
      `UPDATE tcg_pity SET
         sejak_legendary  = CASE WHEN ? IN ('LEGENDARY','MYTHIC') THEN 0 ELSE sejak_legendary + 1 END,
         sejak_mythic     = CASE WHEN ? = 'MYTHIC' THEN 0 ELSE sejak_mythic + 1 END,
         total_pull       = total_pull + 1,
         pull_hari_ini    = CASE WHEN tanggal_hari_ini = ? THEN pull_hari_ini + ? ELSE ? END,
         tanggal_hari_ini = ?
       WHERE owner_jid = ?`,
      [rarity, rarity, hariIni, gratis ? 0 : 1, gratis ? 0 : 1, hariIni, ownerJid]
    );
  });
}

/**
 * Klaim hadiah harian: 1 Tarikan Gacha Gratis + 50 Keping Harian.
 */
/**
 * Klaim harian sekarang tinggal di `tcgMetaDb.js` sebagai `tcgKlaimHarian`.
 *
 * Dipindahkan karena hadiahnya bukan lagi angka datar: ia harus menaikkan
 * beruntun dan membayar tonggak beruntun DI DALAM transaksi yang sama dengan
 * penjaga sekali-seharinya. Menyisakan versi lama di sini hanya menyediakan
 * jalur kedua yang membayar lebih sedikit dan diam-diam memutus beruntun.
 */

// ============================================================
// KOLEKSI KARTU
// ============================================================

export async function tcgTambahKartu(ownerJid, cardId, jumlah = 1) {
  const n = Math.max(1, Math.floor(Number(jumlah) || 1));
  await runQuery(
    `INSERT INTO tcg_collection (owner_jid, card_id, qty) VALUES (?, ?, ?)
       ON CONFLICT(owner_jid, card_id) DO UPDATE SET qty = qty + ?`,
    [ownerJid, cardId, n, n]
  );
}

/**
 * Papan peringkat Arena Kartu untuk `.lb tcg`.
 * Urutan: jenis kartu unik dulu (kolektor), baru lantai menara tertinggi.
 */
export async function getTcgLeaderboard(limit = 10) {
  const safeLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 10));
  return await allQuery(
    `SELECT k.owner_jid AS customer_jid,
            COUNT(DISTINCT k.card_id) AS jenis_kartu,
            COALESCE(SUM(k.qty), 0) AS total_kartu,
            COALESCE(MAX(t.highest_floor), 0) AS lantai,
            COALESCE(MAX(p.nama), MAX(c.nama), 'Member') AS customer_nama
     FROM tcg_collection k
     LEFT JOIN tcg_tower t ON t.owner_jid = k.owner_jid
     LEFT JOIN tcg_profil p ON p.owner_jid = k.owner_jid
     LEFT JOIN customers c ON c.nomor = k.owner_jid
     WHERE k.qty > 0
     GROUP BY k.owner_jid
     ORDER BY jenis_kartu DESC, lantai DESC, total_kartu DESC
     LIMIT ?`,
    [safeLimit]
  );
}

export async function tcgGetKoleksi(ownerJid) {
  return await allQuery(
    "SELECT card_id, qty, card_lv, refine FROM tcg_collection WHERE owner_jid = ? AND qty > 0 ORDER BY card_id",
    [ownerJid]
  );
}

export async function tcgGetKartu(ownerJid, cardId) {
  return await getQuery(
    "SELECT card_id, qty, card_lv, refine FROM tcg_collection WHERE owner_jid = ? AND card_id = ?",
    [ownerJid, cardId]
  );
}

export async function tcgHitungKoleksi(ownerJid) {
  const r = await getQuery(
    "SELECT COUNT(*) unik, COALESCE(SUM(qty),0) total FROM tcg_collection WHERE owner_jid = ? AND qty > 0",
    [ownerJid]
  );
  return { unik: r?.unik || 0, total: r?.total || 0 };
}

// ============================================================
// DEK 3 KARTU (MAKS 10 BINTANG / COST)
// ============================================================

export async function tcgGetDeck(ownerJid) {
  const rows = await allQuery("SELECT slot, card_id FROM tcg_deck WHERE owner_jid = ? ORDER BY slot ASC", [ownerJid]);
  const deck = { 1: null, 2: null, 3: null };
  for (const r of rows) {
    if (r.slot >= 1 && r.slot <= 3) {
      const owned = await getQuery("SELECT card_lv, refine, qty FROM tcg_collection WHERE owner_jid = ? AND card_id = ? AND qty > 0", [ownerJid, r.card_id]);
      if (owned) {
        // `refine` ikut dibawa ke mesin tempur lewat objek ini, sama seperti
        // `card_lv`. Baris lama di basis data bisa saja NULL sebelum migrasi
        // sempat berjalan, jadi selalu jatuh ke 1.
        deck[r.slot] = { card_id: r.card_id, card_lv: owned.card_lv, refine: owned.refine || 1 };
      }
    }
  }
  return deck;
}

export async function tcgSetDeckSlot(ownerJid, slot, cardId, cardCostMap = {}) {
  const s = parseInt(slot, 10);
  if (![1, 2, 3].includes(s)) return { success: false, reason: 'SLOT_TIDAK_VALID' };

  // Pastikan punya kartunya
  const punya = await getQuery("SELECT card_lv, refine, qty FROM tcg_collection WHERE owner_jid = ? AND card_id = ? AND qty > 0", [ownerJid, cardId]);
  if (!punya) return { success: false, reason: 'TIDAK_PUNYA' };

  // Hitung total cost jika kartu ini dipasang
  const currentDeck = await tcgGetDeck(ownerJid);

  // Satu keping kartu hanya boleh berdiri di satu slot.
  //
  // Tanpa cek ini, `qty > 0` saja sudah cukup untuk memasang kartu yang SAMA di
  // beberapa slot sekaligus: pemilik satu Legendary bisa menurunkannya dua kali
  // (4+4 = 8★, masih di bawah anggaran) tanpa pernah menarik salinan kedua.
  // Itu meruntuhkan alasan mengoleksi duplikat sekaligus seluruh nilai gacha.
  const dipakaiDiSlotLain = [1, 2, 3]
    .filter(i => i !== s && currentDeck[i]?.card_id === cardId).length;

  // Kartu yang sedang pergi ekspedisi juga sedang bertugas, jadi ikut dihitung.
  const pergi = await allQuery(
    "SELECT card_id FROM tcg_ekspedisi WHERE owner_jid = ? AND card_id = ?",
    [ownerJid, cardId]
  );

  if (punya.qty <= dipakaiDiSlotLain + pergi.length) {
    return {
      success: false,
      reason: 'SALINAN_TIDAK_CUKUP',
      punya: punya.qty,
      dipakai: dipakaiDiSlotLain,
      ekspedisi: pergi.length
    };
  }
  let totalCost = 0;
  for (let i = 1; i <= 3; i++) {
    const cId = (i === s) ? cardId : currentDeck[i]?.card_id;
    if (cId) {
      const cost = cardCostMap[cId] || 1;
      totalCost += cost;
    }
  }

  if (totalCost > TCG_MAX_DECK_COST) {
    return { success: false, reason: 'COST_MELEBIHI_BATAS', totalCost, maxCost: TCG_MAX_DECK_COST };
  }

  await runQuery(
    `INSERT INTO tcg_deck (owner_jid, slot, card_id) VALUES (?, ?, ?)
       ON CONFLICT(owner_jid, slot) DO UPDATE SET card_id = ?`,
    [ownerJid, s, cardId, cardId]
  );

  return { success: true, slot: s, cardId, cardLv: punya.card_lv, totalCost, maxCost: TCG_MAX_DECK_COST };
}

export async function tcgClearDeckSlot(ownerJid, slot) {
  const s = parseInt(slot, 10);
  if (![1, 2, 3].includes(s)) return { success: false, reason: 'SLOT_TIDAK_VALID' };
  await runQuery("DELETE FROM tcg_deck WHERE owner_jid = ? AND slot = ?", [ownerJid, s]);
  return { success: true, slot: s };
}

/**
 * Otomatis menyusun dan memasang 3 kartu terbaik pemain ke dalam dek.
 * Mengoptimalkan Battle Power (HP + ATK*2.2 + Kritis + Sinergi) dalam batas bintang (TCG_MAX_DECK_COST).
 */
export async function tcgAutoBuildDeck(ownerJid, opts = {}) {
  // Tiga opsi ini yang membuat autodek tetap berguna sesudah tantangan baru
  // masuk. Tanpa mereka, autodek cuma punya satu jawaban untuk seluruh game:
  //   lawanElemen  — susun dek yang UNGGUL melawan elemen tertentu, bukan yang
  //                  paling kuat secara mentah. Ini mengembalikan keputusan
  //                  "mau meng-counter apa" ke tangan pemain.
  //   kecuali      — kartu yang tidak boleh dipakai (Gauntlet melarang kartu
  //                  yang sudah bertarung di tahap sebelumnya).
  //   batasBintang — anggaran bintang lebih ketat dari biasanya (modifier
  //                  lantai Menara Abadi).
  const lawanElemen = opts.lawanElemen || null;
  const laranganElemen = opts.laranganElemen || null;
  const wajibElemen = opts.wajibElemen || null;
  const kecuali = new Set(Array.isArray(opts.kecuali) ? opts.kecuali : []);
  const batasBintang = Number(opts.batasBintang) > 0
    ? Math.floor(Number(opts.batasBintang))
    : TCG_MAX_DECK_COST;

  return withTransaction(async () => {
    const owned = await allQuery(
      "SELECT card_id, qty, card_lv FROM tcg_collection WHERE owner_jid = ? AND qty > 0",
      [ownerJid]
    );
    if (!owned || owned.length < 1) {
      return { success: false, reason: 'KOLEKSI_KOSONG' };
    }

    // Periksa kartu yang sedang di ekspedisi
    const ekspedisiRows = await allQuery(
      "SELECT card_id FROM tcg_ekspedisi WHERE owner_jid = ?",
      [ownerJid]
    );
    const ekspedisiMap = {};
    for (const e of ekspedisiRows || []) {
      ekspedisiMap[e.card_id] = (ekspedisiMap[e.card_id] || 0) + 1;
    }

    // Filter kartu yang tersedia (qty > ekspedisi)
    const availableCards = [];
    for (const o of owned) {
      if (kecuali.has(o.card_id)) continue;
      if (laranganElemen && getKartu(o.card_id)?.elemen === laranganElemen) continue;
      const busy = ekspedisiMap[o.card_id] || 0;
      if (o.qty > busy) {
        const cardDef = getKartu(o.card_id);
        if (!cardDef) continue;
        const stat = statKartu(cardDef, o.card_lv || 1);
        const cost = costKartu(cardDef);
        const power = Math.round((stat.atk * 2.2) + (stat.hp * 0.9) + ((stat.kritis || 0) * 500));
        // Nilai tanding: daya mentah dikali keunggulan elemen atas sasaran.
        // Dipisah dari `power` supaya angka yang ditampilkan ke pemain tetap
        // daya sebenarnya, bukan angka yang sudah dibumbui.
        const nilai = lawanElemen
          ? power * pengaliElemen(cardDef.elemen, lawanElemen)
          : power;
        availableCards.push({
          card_id: o.card_id,
          nama: cardDef.nama,
          rarity: cardDef.rarity,
          elemen: cardDef.elemen,
          bintang: cost,
          level: o.card_lv || 1,
          stat,
          cost,
          power,
          nilai
        });
      }
    }

    if (availableCards.length === 0) {
      // Dua sebab yang terasa sangat berbeda bagi pemain: kartunya sedang pergi,
      // atau kartunya sudah habis terpakai di tahap Gauntlet sebelumnya.
      return {
        success: false,
        reason: kecuali.size > 0 ? 'KARTU_TERSISA_HABIS' : 'SEMUA_KARTU_EKSPEDISI'
      };
    }

    let bestTrio = null;
    let bestScore = -1;

    // Jika kartu yang tersedia <= 3 buah
    if (availableCards.length <= 3) {
      const costSum = availableCards.reduce((acc, c) => acc + c.cost, 0);
      const penuhiWajibPintas = !wajibElemen || availableCards.some(c => c.elemen === wajibElemen);
      if (costSum <= batasBintang && penuhiWajibPintas) {
        bestTrio = availableCards;
        bestScore = availableCards.reduce((acc, c) => acc + c.nilai, 0);
      }
    }

    // Cari kombinasi 3 kartu terbaik dengan total cost <= TCG_MAX_DECK_COST
    if (!bestTrio) {
      availableCards.sort((a, b) => b.nilai - a.nilai);
      const n = availableCards.length;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          for (let k = j + 1; k < n; k++) {
            const trio = [availableCards[i], availableCards[j], availableCards[k]];
            const totalCost = trio[0].cost + trio[1].cost + trio[2].cost;
            const penuhiWajib = !wajibElemen || trio.some(t => t.elemen === wajibElemen);
            if (totalCost <= batasBintang && penuhiWajib) {
              const basePower = trio[0].nilai + trio[1].nilai + trio[2].nilai;
              const sinergi = hitungSinergi(trio.map(t => getKartu(t.card_id)));
              let synergyMultiplier = 1.0;
              if (sinergi?.aktif?.length > 0) {
                synergyMultiplier += (sinergi.aktif.length * 0.08);
              }
              const score = basePower * synergyMultiplier;
              if (score > bestScore) {
                bestScore = score;
                bestTrio = trio;
              }
            }
          }
        }
      }
    }

    // Fallback: ambil kartu dengan cost terkecil yang muat
    if (!bestTrio) {
      const byCost = [...availableCards].sort((a, b) => a.cost - b.cost || b.nilai - a.nilai);
      const chosen = [];
      let curCost = 0;

      // Kalau lantainya menuntut satu elemen, kartu itu dipilih DULU. Kalau
      // menunggu giliran urutan biasa, syaratnya cuma terpenuhi kalau kebetulan
      // kartu wajibnya juga yang termurah.
      if (wajibElemen) {
        const wajib = byCost.find(c => c.elemen === wajibElemen && c.cost <= batasBintang);
        if (wajib) { chosen.push(wajib); curCost += wajib.cost; }
      }

      for (const c of byCost) {
        if (chosen.includes(c)) continue;
        if (chosen.length < 3 && (curCost + c.cost) <= batasBintang) {
          chosen.push(c);
          curCost += c.cost;
        }
      }
      // Jalur cadangan tidak boleh melaporkan sukses untuk dek yang melanggar
      // syarat. Lebih baik gagal dengan jujur di sini daripada memasang dek yang
      // pasti ditolak lagi oleh periksaSyaratModifier beberapa detik kemudian.
      const penuhiWajibCadangan = !wajibElemen || chosen.some(c => c.elemen === wajibElemen);
      if (chosen.length > 0 && penuhiWajibCadangan) {
        bestTrio = chosen;
      }
    }

    if (!bestTrio || bestTrio.length === 0) {
      return { success: false, reason: 'TIDAK_DAPAT_DISUSUN' };
    }

    // Pasang ke tcg_deck
    await runQuery("DELETE FROM tcg_deck WHERE owner_jid = ?", [ownerJid]);
    for (let slot = 1; slot <= bestTrio.length; slot++) {
      await runQuery(
        "INSERT INTO tcg_deck (owner_jid, slot, card_id) VALUES (?, ?, ?)",
        [ownerJid, slot, bestTrio[slot - 1].card_id]
      );
    }

    const totalCost = bestTrio.reduce((acc, c) => acc + c.cost, 0);
    const totalPower = bestTrio.reduce((acc, c) => acc + c.power, 0);

    return {
      success: true,
      deck: bestTrio.map((c, idx) => ({
        slot: idx + 1,
        card_id: c.card_id,
        nama: c.nama,
        level: c.level,
        rarity: c.rarity,
        elemen: c.elemen,
        cost: c.cost,
        power: c.power
      })),
      totalCost,
      maxCost: batasBintang,
      totalPower,
      lawanElemen,
      laranganElemen,
      wajibElemen
    };
  });
}

// ============================================================
// PVE: MENARA MONSTER (TOWER / DUNGEON)
// ============================================================

/**
 * Hitung regen tanpa perlu timer di memori.
 *
 * Sisa waktu sengaja TIDAK dibuang: kalau sudah lewat 7 jam dari interval 6
 * jam, yang dicatat terpakai cuma 6 jam dan sisa 1 jam tetap berjalan menuju
 * poin berikutnya. Tanpa ini pemain kehilangan progres tiap kali mengecek
 * statusnya.
 */
function hitungRegen(nilai, sejak, cap, intervalMs, now) {
  const punya = Math.max(0, Math.min(cap, Math.floor(Number(nilai) || 0)));
  if (punya >= cap) return { nilai: cap, sejak: now };

  const mulai = Number(sejak) || now;
  const lewat = Math.max(0, now - mulai);
  const tambah = Math.floor(lewat / intervalMs);
  if (tambah <= 0) return { nilai: punya, sejak: mulai };

  const baru = Math.min(cap, punya + tambah);
  return { nilai: baru, sejak: baru >= cap ? now : mulai + tambah * intervalMs };
}

export async function tcgGetTower(ownerJid) {
  const now = Date.now();
  await runQuery(
    `INSERT OR IGNORE INTO tcg_tower (owner_jid, highest_floor, stamina, stamina_tanggal, stamina_at, energi_gerbang, energi_at)
     VALUES (?, 0, ?, ?, ?, ?, ?)`,
    [ownerJid, TCG_MAX_STAMINA_MENARA, tcgTanggalHariIni(), now, TCG_MAX_ENERGI_GERBANG, now]
  );

  const t = await getQuery("SELECT * FROM tcg_tower WHERE owner_jid = ?", [ownerJid]);
  if (!t) {
    return {
      owner_jid: ownerJid, highest_floor: 0,
      stamina: TCG_MAX_STAMINA_MENARA, stamina_at: now,
      energi_gerbang: TCG_MAX_ENERGI_GERBANG, energi_at: now
    };
  }

  // Baris lama (dari sebelum energi dipisah) belum punya stempel waktu; diberi
  // nilai awal penuh sekali saja supaya tidak ada yang merasa dirampok.
  //
  // `perluTulis` WAJIB ada. Tambalan di bawah ini cuma mengubah objek di memori;
  // tanpa memaksa UPDATE, kolom NULL tetap NULL di DB, jadi tiap panggilan
  // berikutnya menambal ulang `stamina_at = now` -> hitungRegen menerima
  // sejak=now -> lewat=0 -> tidak pernah regen. Pemain yang habis staminanya
  // terkunci di 0 selamanya (dan memang itu yang terjadi di produksi).
  let perluTulis = false;
  if (t.energi_gerbang === null || t.energi_gerbang === undefined) { t.energi_gerbang = TCG_MAX_ENERGI_GERBANG; perluTulis = true; }
  if (!t.stamina_at) { t.stamina_at = now; perluTulis = true; }
  if (!t.energi_at) { t.energi_at = now; perluTulis = true; }
  if (t.stamina > TCG_MAX_STAMINA_MENARA) { t.stamina = TCG_MAX_STAMINA_MENARA; perluTulis = true; }

  const m = hitungRegen(t.stamina, t.stamina_at, TCG_MAX_STAMINA_MENARA, TCG_REGEN_MENARA_MS, now);
  const g = hitungRegen(t.energi_gerbang, t.energi_at, TCG_MAX_ENERGI_GERBANG, TCG_REGEN_GERBANG_MS, now);

  if (perluTulis || m.nilai !== t.stamina || g.nilai !== t.energi_gerbang || m.sejak !== t.stamina_at || g.sejak !== t.energi_at) {
    await runQuery(
      "UPDATE tcg_tower SET stamina = ?, stamina_at = ?, energi_gerbang = ?, energi_at = ? WHERE owner_jid = ?",
      [m.nilai, m.sejak, g.nilai, g.sejak, ownerJid]
    );
    t.stamina = m.nilai; t.stamina_at = m.sejak;
    t.energi_gerbang = g.nilai; t.energi_at = g.sejak;
  }
  return t;
}

// ============================================================
// RANSUM & ITEM KONSUMABEL
// ============================================================
// Energi tidak dijual langsung dengan poin. Ransum didapat dari bermain
// (misi harian, klaim harian, loot Raid) atau dibagikan owner lewat `.bansos`,
// sehingga tambahan energi selalu berasal dari aktivitas, bukan dari saldo.

export const TCG_RANSUM = {
  RANSUM_MENARA: {
    id: 'RANSUM_MENARA',
    nama: '🍖 Ransum Pendaki',
    efek: { menara: 1 },
    desc: 'Memulihkan *1 Stamina Menara*'
  },
  RANSUM_GERBANG: {
    id: 'RANSUM_GERBANG',
    nama: '🧃 Tonik Penjelajah',
    efek: { gerbang: 1 },
    desc: 'Memulihkan *1 Energi Gerbang*'
  },
  RANSUM_AGUNG: {
    id: 'RANSUM_AGUNG',
    nama: '🍱 Bekal Agung',
    efek: { menara: 1, gerbang: 2 },
    desc: 'Memulihkan *1 Stamina Menara* & *2 Energi Gerbang*'
  }
};

export function tcgGetRansumDef(itemId) {
  const kunci = String(itemId || '').toUpperCase();
  return TCG_RANSUM[kunci] || null;
}

export async function tcgTambahItem(ownerJid, itemId, jumlah = 1) {
  const def = tcgGetRansumDef(itemId);
  if (!ownerJid || !def) return { success: false, reason: 'ITEM_TIDAK_DIKENAL' };
  const n = Math.max(1, Math.floor(Number(jumlah) || 1));
  await runQuery(
    `INSERT INTO tcg_item (owner_jid, item_id, qty) VALUES (?, ?, ?)
     ON CONFLICT(owner_jid, item_id) DO UPDATE SET qty = qty + ?, updated_at = CURRENT_TIMESTAMP`,
    [ownerJid, def.id, n, n]
  );
  return { success: true, itemId: def.id, jumlah: n };
}

export async function tcgGetItem(ownerJid) {
  const rows = await allQuery(
    "SELECT item_id, qty FROM tcg_item WHERE owner_jid = ? AND qty > 0 ORDER BY item_id",
    [ownerJid]
  );
  return (rows || []).map(r => ({ ...r, def: tcgGetRansumDef(r.item_id) })).filter(r => r.def);
}

/** Pakai satu ransum. Penguranganya atomik supaya tidak bisa dipakai dua kali. */
export async function tcgPakaiItem(ownerJid, itemId, jumlah = 1) {
  const def = tcgGetRansumDef(itemId);
  if (!def) return { success: false, reason: 'ITEM_TIDAK_DIKENAL' };
  const n = Math.max(1, Math.floor(Number(jumlah) || 1));

  const res = await runQuery(
    "UPDATE tcg_item SET qty = qty - ?, updated_at = CURRENT_TIMESTAMP WHERE owner_jid = ? AND item_id = ? AND qty >= ?",
    [n, ownerJid, def.id, n]
  );
  if (res.changes !== 1) return { success: false, reason: 'ITEM_HABIS' };

  const efekScaled = {};
  for (const [k, v] of Object.entries(def.efek || {})) {
    efekScaled[k] = v * n;
  }
  const energi = await tcgTambahEnergi(ownerJid, efekScaled);
  return { success: true, def, energi, jumlah: n };
}

/** Ringkasan energi untuk layar status, lengkap dengan sisa waktu regen. */
export async function tcgGetEnergi(ownerJid) {
  const t = await tcgGetTower(ownerJid);
  const now = Date.now();
  const sisa = (nilai, sejak, cap, interval) =>
    nilai >= cap ? 0 : Math.max(0, interval - ((now - (Number(sejak) || now)) % interval));

  return {
    menara: t.stamina,
    menaraMax: TCG_MAX_STAMINA_MENARA,
    menaraNextMs: sisa(t.stamina, t.stamina_at, TCG_MAX_STAMINA_MENARA, TCG_REGEN_MENARA_MS),
    gerbang: t.energi_gerbang,
    gerbangMax: TCG_MAX_ENERGI_GERBANG,
    gerbangNextMs: sisa(t.energi_gerbang, t.energi_at, TCG_MAX_ENERGI_GERBANG, TCG_REGEN_GERBANG_MS)
  };
}

/** Pakai energi gerbang (farming). Terpisah total dari stamina menara. */
export async function tcgPakaiEnergiGerbang(ownerJid, jumlah = 1) {
  await tcgGetTower(ownerJid);
  const now = Date.now();
  const res = await runQuery(
    `UPDATE tcg_tower
     SET energi_gerbang = energi_gerbang - ?,
         energi_at = CASE WHEN energi_gerbang >= ? THEN ? ELSE energi_at END
     WHERE owner_jid = ? AND energi_gerbang >= ?`,
    [jumlah, TCG_MAX_ENERGI_GERBANG, now, ownerJid, jumlah]
  );
  const t = await getQuery("SELECT energi_gerbang FROM tcg_tower WHERE owner_jid = ?", [ownerJid]);
  if (res.changes !== 1) {
    return { success: false, reason: 'ENERGI_HABIS', energi: t?.energi_gerbang || 0 };
  }
  return { success: true, sisaEnergi: t?.energi_gerbang || 0 };
}

/** Tambah energi dari ransum atau bansos owner. Tidak pernah melewati kapasitas. */
export async function tcgTambahEnergi(ownerJid, { menara = 0, gerbang = 0 } = {}) {
  await tcgGetTower(ownerJid);
  const m = Math.max(0, Math.floor(Number(menara) || 0));
  const g = Math.max(0, Math.floor(Number(gerbang) || 0));
  if (m === 0 && g === 0) return await tcgGetEnergi(ownerJid);

  await runQuery(
    `UPDATE tcg_tower
     SET stamina = MIN(?, stamina + ?),
         energi_gerbang = MIN(?, energi_gerbang + ?)
     WHERE owner_jid = ?`,
    [TCG_MAX_STAMINA_MENARA, m, TCG_MAX_ENERGI_GERBANG, g, ownerJid]
  );
  return await tcgGetEnergi(ownerJid);
}

export async function tcgProgressTower(ownerJid, floor, rewardKeping = 0, rewardShards = null) {
  return withTransaction(async () => {
    const t = await tcgGetTower(ownerJid);
    if (t.stamina <= 0) {
      return { success: false, reason: 'STAMINA_HABIS' };
    }

    const baruLantai = (t.highest_floor || 0) < floor;

    await runQuery(
      `UPDATE tcg_tower SET
         stamina = stamina - 1,
         highest_floor = MAX(highest_floor, ?),
         last_clear_at = CURRENT_TIMESTAMP
       WHERE owner_jid = ?`,
      [floor, ownerJid]
    );

    if (baruLantai) {
      if (rewardKeping > 0) {
        await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [ownerJid]);
        await runQuery("UPDATE tcg_wallet SET keping = keping + ? WHERE owner_jid = ?", [rewardKeping, ownerJid]);
        await runQuery(
          "INSERT INTO tcg_ledger (owner_jid, delta, sumber, ref) VALUES (?, ?, 'TOWER_REWARD', ?)",
          [ownerJid, rewardKeping, `Lantai ${floor}`]
        );
      }

      if (rewardShards && rewardShards.rarity && rewardShards.jumlah > 0) {
        await tcgTambahSerpihan(ownerJid, rewardShards.rarity, rewardShards.jumlah);
      }
    }

    const baru = await tcgGetTower(ownerJid);
    const w = await getQuery("SELECT keping, picis FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
    return {
      success: true,
      highestFloor: baru.highest_floor,
      sisaStamina: baru.stamina,
      keping: w?.keping || 0
    };
  });
}

// ============================================================
// SERPIHAN & LEVEL UP
// ============================================================

export async function tcgTambahSerpihan(ownerJid, rarity, jumlah = 1) {
  const n = Math.max(1, Math.floor(Number(jumlah) || 1));
  await runQuery(
    `INSERT INTO tcg_shards (owner_jid, rarity, jumlah) VALUES (?, ?, ?)
       ON CONFLICT(owner_jid, rarity) DO UPDATE SET jumlah = jumlah + ?`,
    [ownerJid, rarity, n, n]
  );
}

export async function tcgGetSerpihan(ownerJid) {
  const rows = await allQuery("SELECT rarity, jumlah FROM tcg_shards WHERE owner_jid = ?", [ownerJid]);
  const out = {};
  for (const r of TCG_RARITY) out[r] = 0;
  for (const row of rows) out[row.rarity] = row.jumlah;
  return out;
}

export async function tcgJualKartu(ownerJid, cardId, rarity, jumlah = 1) {
  const n = Math.max(1, Math.floor(Number(jumlah) || 1));
  const hargaSatuan = TCG_HARGA_JUAL[rarity] || 0;
  if (hargaSatuan <= 0) return { success: false, reason: 'RARITY_TIDAK_VALID' };

  return withTransaction(async () => {
    const deckRows = await allQuery(
      "SELECT slot FROM tcg_deck WHERE owner_jid = ? AND card_id = ?",
      [ownerJid, cardId]
    );
    const ekspedisiRows = await allQuery(
      "SELECT slot FROM tcg_ekspedisi WHERE owner_jid = ? AND card_id = ?",
      [ownerJid, cardId]
    );
    const inUse = (deckRows?.length || 0) + (ekspedisiRows?.length || 0);
    const minSisa = Math.max(1, inUse);

    const res = await runQuery(
      "UPDATE tcg_collection SET qty = qty - ? WHERE owner_jid = ? AND card_id = ? AND (qty - ?) >= ?",
      [n, ownerJid, cardId, n, minSisa]
    );
    if (res.changes !== 1) {
      const punya = await getQuery(
        "SELECT qty FROM tcg_collection WHERE owner_jid = ? AND card_id = ?",
        [ownerJid, cardId]
      );
      return { success: false, reason: 'DUPLIKAT_KURANG', qty: punya?.qty || 0, terpakai: inUse };
    }
    const total = hargaSatuan * n;
    await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [ownerJid]);
    await runQuery("UPDATE tcg_wallet SET keping = keping + ? WHERE owner_jid = ?", [total, ownerJid]);
    await runQuery(
      "INSERT INTO tcg_ledger (owner_jid, delta, sumber, ref) VALUES (?, ?, 'JUAL_KARTU', ?)",
      [ownerJid, total, `${cardId}x${n}`]
    );
    const w = await getQuery("SELECT keping, picis FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
    return { success: true, dapat: total, keping: w.keping };
  });
}

export async function tcgSerpihKartu(ownerJid, cardId, rarity, jumlah = 1) {
  const n = Math.max(1, Math.floor(Number(jumlah) || 1));
  if (!TCG_RARITY.includes(rarity)) return { success: false, reason: 'RARITY_TIDAK_VALID' };

  return withTransaction(async () => {
    const deckRows = await allQuery(
      "SELECT slot FROM tcg_deck WHERE owner_jid = ? AND card_id = ?",
      [ownerJid, cardId]
    );
    const ekspedisiRows = await allQuery(
      "SELECT slot FROM tcg_ekspedisi WHERE owner_jid = ? AND card_id = ?",
      [ownerJid, cardId]
    );
    const inUse = (deckRows?.length || 0) + (ekspedisiRows?.length || 0);
    const minSisa = Math.max(1, inUse);

    const res = await runQuery(
      "UPDATE tcg_collection SET qty = qty - ? WHERE owner_jid = ? AND card_id = ? AND (qty - ?) >= ?",
      [n, ownerJid, cardId, n, minSisa]
    );
    if (res.changes !== 1) {
      const punya = await getQuery(
        "SELECT qty FROM tcg_collection WHERE owner_jid = ? AND card_id = ?",
        [ownerJid, cardId]
      );
      return { success: false, reason: 'DUPLIKAT_KURANG', qty: punya?.qty || 0, terpakai: inUse };
    }
    await runQuery(
      `INSERT INTO tcg_shards (owner_jid, rarity, jumlah) VALUES (?, ?, ?)
         ON CONFLICT(owner_jid, rarity) DO UPDATE SET jumlah = jumlah + ?`,
      [ownerJid, rarity, n, n]
    );
    const s = await getQuery(
      "SELECT jumlah FROM tcg_shards WHERE owner_jid = ? AND rarity = ?",
      [ownerJid, rarity]
    );
    return { success: true, dapat: n, totalSerpihan: s?.jumlah || n };
  });
}

/**
 * Pecah semua kartu duplikat pemain menjadi serpihan (Bulk Salvage).
 * Selalu menyisakan minimal 1 kartu di koleksi dan menjaga kartu aktif (dek/ekspedisi).
 */
export async function tcgSerpihSemua(ownerJid, rarityFilter = null) {
  const rf = rarityFilter ? String(rarityFilter).toUpperCase().trim() : null;
  if (rf && rf !== 'ALL' && rf !== 'SEMUA' && !TCG_RARITY.includes(rf)) {
    return { success: false, reason: 'RARITY_TIDAK_VALID' };
  }
  const isAll = !rf || rf === 'ALL' || rf === 'SEMUA';

  return withTransaction(async () => {
    const cards = await allQuery(
      "SELECT card_id, qty, card_lv FROM tcg_collection WHERE owner_jid = ? AND qty > 1",
      [ownerJid]
    );
    if (!cards || cards.length === 0) {
      return { success: false, reason: 'TIDAK_ADA_DUPLIKAT', totalDiproses: 0 };
    }

    const deckRows = await allQuery(
      "SELECT card_id FROM tcg_deck WHERE owner_jid = ?",
      [ownerJid]
    );
    const ekspedisiRows = await allQuery(
      "SELECT card_id FROM tcg_ekspedisi WHERE owner_jid = ?",
      [ownerJid]
    );

    const inUseCounts = {};
    for (const d of deckRows || []) {
      inUseCounts[d.card_id] = (inUseCounts[d.card_id] || 0) + 1;
    }
    for (const e of ekspedisiRows || []) {
      inUseCounts[e.card_id] = (inUseCounts[e.card_id] || 0) + 1;
    }

    let totalDiproses = 0;
    let totalKartuUnik = 0;
    const dapatSerpihPerRarity = {};

    for (const c of cards) {
      const cardDef = getKartu(c.card_id);
      if (!cardDef) continue;
      const r = cardDef.rarity.toUpperCase();
      if (!isAll && r !== rf) continue;

      const inUse = inUseCounts[c.card_id] || 0;
      const minSisa = Math.max(1, inUse);
      const n = c.qty - minSisa;

      if (n > 0) {
        await runQuery(
          "UPDATE tcg_collection SET qty = qty - ? WHERE owner_jid = ? AND card_id = ?",
          [n, ownerJid, c.card_id]
        );
        await runQuery(
          `INSERT INTO tcg_shards (owner_jid, rarity, jumlah) VALUES (?, ?, ?)
             ON CONFLICT(owner_jid, rarity) DO UPDATE SET jumlah = jumlah + ?`,
          [ownerJid, r, n, n]
        );
        totalDiproses += n;
        totalKartuUnik += 1;
        dapatSerpihPerRarity[r] = (dapatSerpihPerRarity[r] || 0) + n;
      }
    }

    if (totalDiproses === 0) {
      return { success: false, reason: 'TIDAK_ADA_DUPLIKAT_BEBAS', totalDiproses: 0 };
    }

    return {
      success: true,
      totalDiproses,
      totalKartuUnik,
      dapatSerpih: dapatSerpihPerRarity
    };
  });
}

/**
 * Jual semua kartu duplikat pemain untuk mendapatkan Keping Arena (Bulk Sell).
 * Selalu menyisakan minimal 1 kartu di koleksi dan menjaga kartu aktif.
 */
export async function tcgJualSemua(ownerJid, rarityFilter = null) {
  const rf = rarityFilter ? String(rarityFilter).toUpperCase().trim() : null;
  if (rf && rf !== 'ALL' && rf !== 'SEMUA' && !TCG_RARITY.includes(rf)) {
    return { success: false, reason: 'RARITY_TIDAK_VALID' };
  }
  const isAll = !rf || rf === 'ALL' || rf === 'SEMUA';

  return withTransaction(async () => {
    const cards = await allQuery(
      "SELECT card_id, qty, card_lv FROM tcg_collection WHERE owner_jid = ? AND qty > 1",
      [ownerJid]
    );
    if (!cards || cards.length === 0) {
      return { success: false, reason: 'TIDAK_ADA_DUPLIKAT', totalDiproses: 0 };
    }

    const deckRows = await allQuery(
      "SELECT card_id FROM tcg_deck WHERE owner_jid = ?",
      [ownerJid]
    );
    const ekspedisiRows = await allQuery(
      "SELECT card_id FROM tcg_ekspedisi WHERE owner_jid = ?",
      [ownerJid]
    );

    const inUseCounts = {};
    for (const d of deckRows || []) {
      inUseCounts[d.card_id] = (inUseCounts[d.card_id] || 0) + 1;
    }
    for (const e of ekspedisiRows || []) {
      inUseCounts[e.card_id] = (inUseCounts[e.card_id] || 0) + 1;
    }

    let totalDiproses = 0;
    let totalKartuUnik = 0;
    let totalKeping = 0;

    for (const c of cards) {
      const cardDef = getKartu(c.card_id);
      if (!cardDef) continue;
      const r = cardDef.rarity.toUpperCase();
      if (!isAll && r !== rf) continue;

      const inUse = inUseCounts[c.card_id] || 0;
      const minSisa = Math.max(1, inUse);
      const n = c.qty - minSisa;

      if (n > 0) {
        const hargaSatuan = TCG_HARGA_JUAL[r] || 25;
        const subtotal = hargaSatuan * n;
        await runQuery(
          "UPDATE tcg_collection SET qty = qty - ? WHERE owner_jid = ? AND card_id = ?",
          [n, ownerJid, c.card_id]
        );
        totalDiproses += n;
        totalKartuUnik += 1;
        totalKeping += subtotal;
      }
    }

    if (totalDiproses === 0) {
      return { success: false, reason: 'TIDAK_ADA_DUPLIKAT_BEBAS', totalDiproses: 0 };
    }

    await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [ownerJid]);
    await runQuery("UPDATE tcg_wallet SET keping = keping + ? WHERE owner_jid = ?", [totalKeping, ownerJid]);
    await runQuery(
      "INSERT INTO tcg_ledger (owner_jid, delta, sumber, ref) VALUES (?, ?, 'JUAL_SEMUA', ?)",
      [ownerJid, totalKeping, `BULK_${totalDiproses}_CARDS`]
    );

    const w = await getQuery("SELECT keping, picis FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);

    return {
      success: true,
      totalDiproses,
      totalKartuUnik,
      totalKepingDapat: totalKeping,
      sisaKeping: w?.keping || totalKeping
    };
  });
}

/**
 * Menyisipkan satu duplikat untuk menaikkan R kartu.
 *
 * Duplikat yang dipakai HARUS benar-benar berlebih. Sebuah kartu bisa sedang
 * berdiri di slot dek dan sedang pergi ekspedisi sekaligus, dan keduanya
 * menahan satu keping masing-masing (lihat aturan di `tcgSetDeckSlot`). Kalau
 * pemeriksaan ini cuma melihat `qty > 1`, me-refine bisa mencuri kartu dari
 * bawah kaki dek pemain dan meninggalkan slot yang menunjuk kartu yang sudah
 * tidak ia punya.
 */
/**
 * Menambah Picis ke dompet pemain.
 *
 * Picis TIDAK ditulis ke kolom `delta` buku besar. Buku besar itu buku besar
 * KEPING — `delta` dijumlahkan di layar audit untuk menghitung peredaran
 * Keping, jadi menuliskan angka Picis ke sana akan meracuni hitungannya.
 * Yang dicatat cuma jejaknya, dengan delta nol.
 */
export async function tcgAddPicis(ownerJid, jumlah, sumber, ref = null) {
  const n = Math.floor(Number(jumlah));
  if (!isFinite(n) || n <= 0) return { success: false, reason: 'JUMLAH_TIDAK_VALID' };
  return withTransaction(async () => {
    await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [ownerJid]);
    await runQuery("UPDATE tcg_wallet SET picis = picis + ? WHERE owner_jid = ?", [n, ownerJid]);
    await runQuery(
      "INSERT INTO tcg_ledger (owner_jid, delta, sumber, ref) VALUES (?, 0, ?, ?)",
      [ownerJid, sumber, ref ? `${ref} +${n} picis` : `+${n} picis`]
    );
    const w = await getQuery("SELECT picis FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
    return { success: true, picis: w?.picis || 0, ditambah: n };
  });
}

export async function tcgRefineKartu(ownerJid, cardId) {
  return withTransaction(async () => {
    const kartu = await getQuery(
      "SELECT qty, card_lv, refine FROM tcg_collection WHERE owner_jid = ? AND card_id = ? AND qty > 0",
      [ownerJid, cardId]
    );
    if (!kartu) return { success: false, reason: 'TIDAK_PUNYA' };

    const rSekarang = kartu.refine || 1;
    if (rSekarang >= 5) return { success: false, reason: 'SUDAH_MAKS' };

    const diDek = await allQuery(
      "SELECT slot FROM tcg_deck WHERE owner_jid = ? AND card_id = ?",
      [ownerJid, cardId]
    );
    const diEkspedisi = await allQuery(
      "SELECT slot FROM tcg_ekspedisi WHERE owner_jid = ? AND card_id = ?",
      [ownerJid, cardId]
    );
    const bertugas = diDek.length + diEkspedisi.length;
    // Sesudah dipakai harus tersisa minimal satu keping, dan cukup untuk semua
    // tugas yang sedang berjalan.
    const sisaSesudah = kartu.qty - TCG_REFINE_DUP_PER_TINGKAT;
    if (sisaSesudah < Math.max(1, bertugas)) {
      return {
        success: false,
        reason: 'DUPLIKAT_KURANG',
        punya: kartu.qty,
        butuh: Math.max(1, bertugas) + TCG_REFINE_DUP_PER_TINGKAT,
        bertugas,
        refine: rSekarang
      };
    }

    const res = await runQuery(
      "UPDATE tcg_collection SET qty = qty - ?, refine = refine + 1 " +
      "WHERE owner_jid = ? AND card_id = ? AND qty - ? >= ? AND refine < 5",
      [TCG_REFINE_DUP_PER_TINGKAT, ownerJid, cardId, TCG_REFINE_DUP_PER_TINGKAT, Math.max(1, bertugas)]
    );
    if (res.changes !== 1) return { success: false, reason: 'GAGAL_BERSAING' };

    return {
      success: true,
      refineBaru: rSekarang + 1,
      sisaKeping: sisaSesudah,
      dipakai: TCG_REFINE_DUP_PER_TINGKAT
    };
  });
}

export async function tcgNaikLevel(ownerJid, cardId, rarity, bintang = 1) {
  return withTransaction(async () => {
    const kartu = await getQuery(
      "SELECT qty, card_lv FROM tcg_collection WHERE owner_jid = ? AND card_id = ? AND qty > 0",
      [ownerJid, cardId]
    );
    if (!kartu) return { success: false, reason: 'TIDAK_PUNYA' };
    if (kartu.card_lv >= 5) return { success: false, reason: 'SUDAH_MAKS' };

    const biaya = (TCG_BIAYA_LEVEL[rarity] || {})[kartu.card_lv];
    if (!biaya) return { success: false, reason: 'RARITY_TIDAK_VALID' };

    // Dibayar PICIS, bukan Keping. Lihat catatan di atas TCG_BIAYA_LEVEL_PICIS:
    // selama biaya level memakai mata uang yang sama dengan gacha, menaikkan
    // level selalu kalah bersaing melawan menarik kartu baru.
    const biayaPicis = tcgBiayaPicisLevel(bintang, kartu.card_lv);

    const res = await runQuery(
      "UPDATE tcg_shards SET jumlah = jumlah - ? WHERE owner_jid = ? AND rarity = ? AND jumlah >= ?",
      [biaya, ownerJid, rarity, biaya]
    );
    if (res.changes !== 1) {
      const s = await getQuery(
        "SELECT jumlah FROM tcg_shards WHERE owner_jid = ? AND rarity = ?",
        [ownerJid, rarity]
      );
      return { success: false, reason: 'SERPIHAN_KURANG', butuh: biaya, punya: s?.jumlah || 0, butuhPicis: biayaPicis };
    }

    await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [ownerJid]);
    const bayar = await runQuery(
      "UPDATE tcg_wallet SET picis = picis - ? WHERE owner_jid = ? AND picis >= ?",
      [biayaPicis, ownerJid, biayaPicis]
    );
    if (bayar.changes !== 1) {
      // Serpihan sudah dipotong di atas; transaksi ini dibatalkan seluruhnya
      // dengan melempar, jadi tidak ada yang hilang separuh jalan.
      const w = await getQuery("SELECT picis FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
      const err = new Error('PICIS_KURANG');
      err.hasil = { success: false, reason: 'PICIS_KURANG', butuhPicis: biayaPicis, punyaPicis: w?.picis || 0, butuh: biaya };
      throw err;
    }

    await runQuery(
      "INSERT INTO tcg_ledger (owner_jid, delta, sumber, ref) VALUES (?, 0, 'NAIK_LEVEL', ?)",
      [ownerJid, `${cardId} -${biayaPicis} picis`]
    );
    await runQuery(
      "UPDATE tcg_collection SET card_lv = card_lv + 1 WHERE owner_jid = ? AND card_id = ?",
      [ownerJid, cardId]
    );
    return { success: true, levelBaru: kartu.card_lv + 1, biaya, biayaPicis };
  });
}

export async function tcgLeburSerpihan(ownerJid, rarityAsal) {
  const idx = TCG_RARITY.indexOf(rarityAsal);
  if (idx < 0) return { success: false, reason: 'RARITY_TIDAK_VALID' };
  if (idx >= TCG_RARITY.length - 1) return { success: false, reason: 'SUDAH_TERTINGGI' };
  const rarityTujuan = TCG_RARITY[idx + 1];

  return withTransaction(async () => {
    const res = await runQuery(
      "UPDATE tcg_shards SET jumlah = jumlah - ? WHERE owner_jid = ? AND rarity = ? AND jumlah >= ?",
      [TCG_SERPIHAN_PER_LEBUR, ownerJid, rarityAsal, TCG_SERPIHAN_PER_LEBUR]
    );
    if (res.changes !== 1) {
      const s = await getQuery(
        "SELECT jumlah FROM tcg_shards WHERE owner_jid = ? AND rarity = ?",
        [ownerJid, rarityAsal]
      );
      return { success: false, reason: 'SERPIHAN_KURANG', butuh: TCG_SERPIHAN_PER_LEBUR, punya: s?.jumlah || 0 };
    }
    await runQuery(
      `INSERT INTO tcg_shards (owner_jid, rarity, jumlah) VALUES (?, ?, 1)
         ON CONFLICT(owner_jid, rarity) DO UPDATE SET jumlah = jumlah + 1`,
      [ownerJid, rarityTujuan]
    );
    return { success: true, rarityTujuan };
  });
}

// ============================================================
// PAKET PEMULA
// ============================================================

export async function tcgSudahAmbilStarter(ownerJid) {
  const w = await tcgGetWallet(ownerJid);
  return !!w.starter_at;
}

export async function tcgTandaiStarter(ownerJid) {
  await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [ownerJid]);
  const res = await runQuery(
    "UPDATE tcg_wallet SET starter_at = CURRENT_TIMESTAMP WHERE owner_jid = ? AND starter_at IS NULL",
    [ownerJid]
  );
  return res.changes === 1;
}

// ============================================================
// AUDIT & ADMIN
// ============================================================

export async function tcgGetLedger(ownerJid, limit = 15) {
  return await allQuery(
    "SELECT delta, sumber, ref, created_at FROM tcg_ledger WHERE owner_jid = ? ORDER BY id DESC LIMIT ?",
    [ownerJid, Math.max(1, Math.min(50, Math.floor(limit)))]
  );
}

export async function tcgRingkasLedger(ownerJid) {
  return await allQuery(
    "SELECT sumber, COUNT(*) n, SUM(delta) total FROM tcg_ledger WHERE owner_jid = ? GROUP BY sumber ORDER BY total DESC",
    [ownerJid]
  );
}

// ============================================================
// MISI HARIAN
// ============================================================
/**
 * Misi harian ada untuk satu alasan: memberi pemain alasan membuka bot besok.
 * Karena itu satu dari tiga misi selalu bisa diselesaikan sendirian — kalau
 * semuanya butuh lawan hidup, pemain di grup sepi tidak akan pernah tuntas.
 *
 * Misi DUEL sengaja mensyaratkan MENANG, bukan sekadar ikut. Dua akun yang
 * saling menduel hanya menghasilkan satu pemenang, jadi Keping yang keluar
 * tidak bisa digandakan dengan akun kembar.
 *
 * Baris misi kemarin tidak pernah dipakai lagi dan dihapus saat pemain
 * membuka misi hari ini, jadi tabel ini tidak tumbuh seiring waktu.
 *
 * MISI DIROTASI, TIDAK TETAP. Sebelumnya ketiganya persis sama tiap hari
 * selamanya, dan salah satunya — "menangkan 1 pertarungan Menara" — berubah
 * menjadi MUSTAHIL begitu pemain menamatkan lantai 30, karena tidak ada lantai
 * berikutnya untuk dimenangkan. Pemain paling rajin justru yang paling dirugikan.
 * Sekarang tiga misi diundi tiap hari dari tiga keranjang berbeda, dan
 * kemenangan Menara Abadi ikut menghitung misi MENARA (lihat `index.js`).
 */
const MISI_KERANJANG = [
  // Keranjang 1 — selalu bisa dikerjakan sendirian, tanpa Keping, tanpa lawan.
  [
    { id: 'SPAR',       emoji: '🥊', nama: 'Menangkan 2 sparring',            target: 2, hadiah: 45 },
    { id: 'SPAR_MAIN',  emoji: '🤺', nama: 'Ikut 3 sparring',                 target: 3, hadiah: 35 },
    { id: 'GERBANG',    emoji: '🌀', nama: 'Tembus Gerbang 2 kali',           target: 2, hadiah: 45 },
    { id: 'EKSPEDISI',  emoji: '🧭', nama: 'Kirim 2 ekspedisi',               target: 2, hadiah: 35 },
    { id: 'PANEN',      emoji: '📦', nama: 'Panen 1 ekspedisi',               target: 1, hadiah: 35 }
  ],
  // Keranjang 2 — tempur & sosial.
  [
    { id: 'MENARA',     emoji: '🏰', nama: 'Menangkan 1 pertarungan Menara',  target: 1, hadiah: 50 },
    { id: 'DUEL',       emoji: '⚔️', nama: 'Menangkan 1 duel PvP',            target: 1, hadiah: 40 },
    { id: 'AMBIL',      emoji: '🫳', nama: 'Sambar 1 kartu drop di grup',     target: 1, hadiah: 40 },
    { id: 'BARTER',     emoji: '🤝', nama: 'Selesaikan 1 barter kartu',       target: 1, hadiah: 50 }
  ],
  // Keranjang 3 — koleksi & perawatan kartu.
  [
    { id: 'GACHA',      emoji: '🎴', nama: 'Tarik 1 kartu',                   target: 1, hadiah: 30 },
    { id: 'GACHA3',     emoji: '🎰', nama: 'Tarik 3 kartu',                   target: 3, hadiah: 60 },
    { id: 'NAIK',       emoji: '⬆️', nama: 'Naikkan level 1 kartu',           target: 1, hadiah: 50 },
    { id: 'LEBUR',      emoji: '♻️', nama: 'Lebur serpihan 1 kali',           target: 1, hadiah: 30 }
  ]
];

/** Semua misi yang mungkin muncul, untuk pencarian definisi per id. */
export const TCG_MISI_POOL = MISI_KERANJANG.flat();

/**
 * Undian misi harian: sama untuk pemain yang sama sepanjang hari, berbeda antar
 * pemain, dan tidak butuh kolom baru di database.
 *
 * Menyimpan hasil undian ke tabel pernah dipertimbangkan dan tidak perlu —
 * fungsi ini murni, jadi baris `tcg_misi` cukup menyimpan progresnya saja.
 */
function acakStabil(teks) {
  let h = 5381;
  for (let i = 0; i < teks.length; i++) h = ((h << 5) + h + teks.charCodeAt(i)) >>> 0;
  return h;
}

export function tcgMisiHariIni(ownerJid, tanggal = tcgTanggalHariIni()) {
  return MISI_KERANJANG.map((keranjang, i) => {
    const n = acakStabil(`${ownerJid}|${tanggal}|${i}`) % keranjang.length;
    return keranjang[n];
  });
}


/** Bonus tuntas cukup 2 dari 3, supaya jalur solo tetap bisa mendapatkannya. */
export const TCG_MISI_BONUS_AMBANG = 2;
export const TCG_MISI_BONUS_KEPING = 40;
export const TCG_MISI_BONUS_ID = 'BONUS';

export function getMisiDef(misiId) {
  return TCG_MISI_POOL.find(m => m.id === misiId) || null;
}

async function pastikanBarisMisi(ownerJid, hariIni) {
  await runQuery("DELETE FROM tcg_misi WHERE owner_jid = ? AND tanggal != ?", [ownerJid, hariIni]);
  for (const m of tcgMisiHariIni(ownerJid, hariIni)) {
    await runQuery(
      "INSERT OR IGNORE INTO tcg_misi (owner_jid, tanggal, misi_id) VALUES (?, ?, ?)",
      [ownerJid, hariIni, m.id]
    );
  }
  await runQuery(
    "INSERT OR IGNORE INTO tcg_misi (owner_jid, tanggal, misi_id) VALUES (?, ?, ?)",
    [ownerJid, hariIni, TCG_MISI_BONUS_ID]
  );
}

/**
 * Status seluruh misi hari ini.
 * @returns {{tanggal:string, daftar:Array, jumlahSelesai:number,
 *            bonusSiap:boolean, bonusDiklaim:boolean, kepingSiapKlaim:number}}
 */
export async function tcgGetMisi(ownerJid) {
  const hariIni = tcgTanggalHariIni();
  await pastikanBarisMisi(ownerJid, hariIni);

  const baris = await allQuery(
    "SELECT misi_id, progres, diklaim FROM tcg_misi WHERE owner_jid = ? AND tanggal = ?",
    [ownerJid, hariIni]
  );
  const peta = new Map(baris.map(b => [b.misi_id, b]));

  const daftar = tcgMisiHariIni(ownerJid, hariIni).map(m => {
    const b = peta.get(m.id) || { progres: 0, diklaim: 0 };
    const progres = Math.min(m.target, b.progres || 0);
    return { ...m, progres, selesai: progres >= m.target, diklaim: !!b.diklaim };
  });

  const jumlahSelesai = daftar.filter(m => m.selesai).length;
  const bonusRow = peta.get(TCG_MISI_BONUS_ID) || { diklaim: 0 };
  const bonusDiklaim = !!bonusRow.diklaim;
  const bonusSiap = jumlahSelesai >= TCG_MISI_BONUS_AMBANG;

  let kepingSiapKlaim = daftar
    .filter(m => m.selesai && !m.diklaim)
    .reduce((t, m) => t + m.hadiah, 0);
  if (bonusSiap && !bonusDiklaim) kepingSiapKlaim += TCG_MISI_BONUS_KEPING;

  return { tanggal: hariIni, daftar, jumlahSelesai, bonusSiap, bonusDiklaim, kepingSiapKlaim };
}

/**
 * Menambah progres satu misi. Aman dipanggil berkali-kali: progres di-clamp ke
 * target, jadi memanggilnya lagi setelah selesai tidak mengubah apa pun.
 * @returns {{baruSelesai:boolean, def:object|null}}
 */
export async function tcgCatatProgresMisi(ownerJid, misiId, jumlah = 1) {
  const def = getMisiDef(misiId);
  if (!def || jumlah <= 0) return { baruSelesai: false, def: null };

  const hariIni = tcgTanggalHariIni();

  // Misi diundi per hari, jadi aksi yang tidak sedang jadi misi hari ini tidak
  // punya baris untuk diisi. Diam-diam mengabaikannya adalah perilaku yang
  // benar: pemanggil di `index.js` melapor setiap aksi tanpa perlu tahu misi
  // apa yang sedang aktif.
  const aktif = tcgMisiHariIni(ownerJid, hariIni).some(m => m.id === misiId);
  if (!aktif) return { baruSelesai: false, def: null };

  await pastikanBarisMisi(ownerJid, hariIni);

  const sebelum = await getQuery(
    "SELECT progres FROM tcg_misi WHERE owner_jid = ? AND tanggal = ? AND misi_id = ?",
    [ownerJid, hariIni, misiId]
  );
  const lama = Math.min(def.target, sebelum?.progres || 0);
  if (lama >= def.target) return { baruSelesai: false, def };

  const baru = Math.min(def.target, lama + jumlah);
  await runQuery(
    "UPDATE tcg_misi SET progres = ? WHERE owner_jid = ? AND tanggal = ? AND misi_id = ?",
    [baru, ownerJid, hariIni, misiId]
  );

  return { baruSelesai: baru >= def.target, def };
}

/**
 * Mengklaim SEMUA misi yang sudah selesai sekaligus, plus bonus tuntas kalau
 * ambangnya tercapai. Sekali klaim untuk semuanya — di WhatsApp, meminta pemain
 * mengetik satu perintah per misi hanya menambah gesekan tanpa menambah apa pun.
 */
export async function tcgKlaimMisi(ownerJid) {
  const hariIni = tcgTanggalHariIni();
  await pastikanBarisMisi(ownerJid, hariIni);
  await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [ownerJid]);

  const misiHariIni = tcgMisiHariIni(ownerJid, hariIni);

  return withTransaction(async () => {
    const rincian = [];
    let total = 0;

    for (const m of misiHariIni) {
      const res = await runQuery(
        `UPDATE tcg_misi SET diklaim = 1
          WHERE owner_jid = ? AND tanggal = ? AND misi_id = ?
            AND diklaim = 0 AND progres >= ?`,
        [ownerJid, hariIni, m.id, m.target]
      );
      if (res.changes === 1) {
        rincian.push({ nama: m.nama, emoji: m.emoji, hadiah: m.hadiah });
        total += m.hadiah;
      }
    }

    // Hitung misi yang selesai di JavaScript: target tiap misi hanya ada di
    // definisinya, dan menyalinnya ke dalam SQL berarti dua sumber kebenaran.
    const semua = await allQuery(
      "SELECT misi_id, progres FROM tcg_misi WHERE owner_jid = ? AND tanggal = ?",
      [ownerJid, hariIni]
    );
    const progresPer = new Map(semua.map(b => [b.misi_id, b.progres || 0]));
    const jumlahSelesai = misiHariIni
      .filter(m => (progresPer.get(m.id) || 0) >= m.target).length;

    if (jumlahSelesai >= TCG_MISI_BONUS_AMBANG) {
      const resBonus = await runQuery(
        "UPDATE tcg_misi SET diklaim = 1 WHERE owner_jid = ? AND tanggal = ? AND misi_id = ? AND diklaim = 0",
        [ownerJid, hariIni, TCG_MISI_BONUS_ID]
      );
      if (resBonus.changes === 1) {
        rincian.push({ nama: `Bonus tuntas (${TCG_MISI_BONUS_AMBANG} misi)`, emoji: '🎁', hadiah: TCG_MISI_BONUS_KEPING });
        total += TCG_MISI_BONUS_KEPING;
      }
    }

    if (total <= 0) {
      return { success: false, reason: 'TIDAK_ADA_YANG_BISA_DIKLAIM' };
    }

    await runQuery("UPDATE tcg_wallet SET keping = keping + ? WHERE owner_jid = ?", [total, ownerJid]);
    await runQuery(
      "INSERT INTO tcg_ledger (owner_jid, delta, sumber, ref) VALUES (?, ?, 'MISI_HARIAN', ?)",
      [ownerJid, total, hariIni]
    );

    const w = await getQuery("SELECT keping, picis FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
    return { success: true, total, rincian, kepingTotal: w?.keping || 0 };
  });
}

/**
 * Menukar isi dua slot dek.
 *
 * Tanpa ini, menukar slot 1 dan 3 memaksa pemain mengetik tujuh perintah:
 * lepas tiga slot lalu pasang ulang satu per satu. Itu benar-benar terjadi di
 * log — dan itulah keluhan "repot amat ganti deck".
 *
 * Total bintang dek tidak berubah karena isinya cuma dipindah, jadi tidak perlu
 * memeriksa ulang anggaran. Kedua slot dihapus lebih dulu supaya penjagaan
 * "satu kartu satu slot" tidak salah menuduh saat keadaan setengah jadi.
 */
export async function tcgTukarSlotDek(ownerJid, slotA, slotB) {
  const a = parseInt(slotA, 10);
  const b = parseInt(slotB, 10);
  if (![1, 2, 3].includes(a) || ![1, 2, 3].includes(b)) {
    return { success: false, reason: 'SLOT_TIDAK_VALID' };
  }
  if (a === b) return { success: false, reason: 'SLOT_SAMA' };

  return withTransaction(async () => {
    const rows = await allQuery(
      "SELECT slot, card_id FROM tcg_deck WHERE owner_jid = ? AND slot IN (?, ?)",
      [ownerJid, a, b]
    );
    const isi = new Map(rows.map(r => [r.slot, r.card_id]));
    const kartuA = isi.get(a) || null;
    const kartuB = isi.get(b) || null;

    if (!kartuA && !kartuB) {
      return { success: false, reason: 'KEDUANYA_KOSONG' };
    }

    await runQuery("DELETE FROM tcg_deck WHERE owner_jid = ? AND slot IN (?, ?)", [ownerJid, a, b]);
    if (kartuB) {
      await runQuery("INSERT INTO tcg_deck (owner_jid, slot, card_id) VALUES (?, ?, ?)", [ownerJid, a, kartuB]);
    }
    if (kartuA) {
      await runQuery("INSERT INTO tcg_deck (owner_jid, slot, card_id) VALUES (?, ?, ?)", [ownerJid, b, kartuA]);
    }

    return { success: true, slotA: a, slotB: b, kartuBaruDiA: kartuB, kartuBaruDiB: kartuA };
  });
}

// ============================================================
// KERAN PENDAPATAN: SPARRING, EKSPEDISI, GERBANG ELEMEN
// ============================================================
/**
 * Sebelum ini arena praktis tidak punya tempat farm: satu-satunya pemasukan
 * berulang adalah hadiah harian dan misi (~210 Keping/hari, sekitar satu
 * tarikan), sementara Menara hanya membayar sekali per lantai dan lantai yang
 * sudah dikuasai tidak bisa diulang.
 *
 * Tiga keran di bawah ini sengaja dibuat berbeda ritme dan berbeda hasil,
 * supaya tidak terasa seperti satu tombol yang disalin tiga kali:
 *
 *   Sparring   kapan saja, hasil menurun setelah jatah harian  -> Keping
 *   Ekspedisi  menunggu jam nyata, memakai kartu cadangan      -> Keping + serpihan
 *   Gerbang    rotasi harian, memakai stamina                  -> serpihan + Keping
 */

// --- Sparring ---
export const TCG_SPAR_HADIAH = 60;
export const TCG_SPAR_JATAH_PENUH = 5;      // kemenangan berhadiah penuh per hari
export const TCG_SPAR_RASIO_SISA = 0.25;    // sesudah jatah habis
export const TCG_SPAR_HADIAH_BERTAHAN = 15; // untuk pemilik dek yang berhasil bertahan
export const TCG_SPAR_JEDA_MS = 15000;

// --- Ekspedisi ---
export const TCG_EKSPEDISI_SLOT = 3;
export const TCG_EKSPEDISI_DURASI = [2, 4, 8]; // jam
export const TCG_EKSPEDISI_PER_JAM = 6;        // dikali bintang kartu

// --- Gerbang Elemen ---
export const TCG_GERBANG_KEPING = 35;
export const TCG_GERBANG_SERPIHAN = 2;

/**
 * Rotasi gerbang per hari. Meniru pola domain Genshin: tiap hari hanya sebagian
 * yang terbuka, supaya ada alasan datang di hari tertentu dan tidak semua
 * material bisa dibanjiri di hari yang sama. Minggu semuanya dibuka.
 */
export const TCG_GERBANG_ROTASI = {
  0: ['API', 'AIR', 'ANGIN', 'PETIR', 'DARK'], // Minggu
  1: ['API', 'AIR'],
  2: ['ANGIN', 'PETIR'],
  3: ['DARK', 'API'],
  4: ['AIR', 'ANGIN'],
  5: ['PETIR', 'DARK'],
  6: ['API', 'PETIR']
};

/** Hari WIB (0 = Minggu), dipakai untuk rotasi gerbang. */
export function tcgHariWib() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).getUTCDay();
}

export function tcgGerbangHariIni() {
  return TCG_GERBANG_ROTASI[tcgHariWib()] || [];
}

export async function initTcgFarmSchema() {
  // Migrasi energi terpisah. Kolom ditambahkan belakangan, jadi pakai pola
  // ALTER-dibungkus-try seperti bagian lain repo ini.
  try { await runQuery("ALTER TABLE tcg_tower ADD COLUMN stamina_at INTEGER"); } catch (e) { /* sudah ada */ }
  try { await runQuery("ALTER TABLE tcg_tower ADD COLUMN energi_gerbang INTEGER DEFAULT 5"); } catch (e) { /* sudah ada */ }
  try { await runQuery("ALTER TABLE tcg_tower ADD COLUMN energi_at INTEGER"); } catch (e) { /* sudah ada */ }

  // Ransum & item konsumabel Arena Kartu.
  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_item (
      owner_jid  TEXT NOT NULL,
      item_id    TEXT NOT NULL,
      qty        INTEGER NOT NULL DEFAULT 0 CHECK(qty >= 0),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (owner_jid, item_id)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_profil (
      owner_jid   TEXT PRIMARY KEY,
      nama        TEXT,
      gelar_aktif TEXT,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_spar (
      owner_jid    TEXT NOT NULL,
      tanggal      TEXT NOT NULL,
      menang_penuh INTEGER NOT NULL DEFAULT 0 CHECK(menang_penuh >= 0),
      total_main   INTEGER NOT NULL DEFAULT 0 CHECK(total_main >= 0),
      PRIMARY KEY (owner_jid, tanggal)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_ekspedisi (
      owner_jid  TEXT NOT NULL,
      slot       INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 3),
      card_id    TEXT NOT NULL,
      jam        INTEGER NOT NULL,
      selesai_at INTEGER NOT NULL,
      PRIMARY KEY (owner_jid, slot)
    )
  `);

  await runQuery("CREATE INDEX IF NOT EXISTS idx_tcg_eksp_owner ON tcg_ekspedisi(owner_jid)");
}

// ============================================================
// PROFIL (nama untuk lawan bayangan)
// ============================================================

export async function tcgCatatProfil(ownerJid, nama) {
  const n = String(nama || '').trim().slice(0, 40);
  if (!n) return;
  await runQuery(
    `INSERT INTO tcg_profil (owner_jid, nama) VALUES (?, ?)
       ON CONFLICT(owner_jid) DO UPDATE SET nama = ?, updated_at = CURRENT_TIMESTAMP`,
    [ownerJid, n, n]
  );
}

export async function tcgGetNama(ownerJid) {
  const r = await getQuery("SELECT nama FROM tcg_profil WHERE owner_jid = ?", [ownerJid]);
  return r?.nama || String(ownerJid).split('@')[0];
}

// ============================================================
// SPARRING LAWAN BAYANGAN
// ============================================================

/**
 * Mencari dek pemain lain yang ketiga slotnya terisi.
 *
 * Deknya dibaca langsung, bukan dari salinan beku: dengan begitu lawannya
 * selalu dek yang benar-benar dipakai orang itu sekarang, dan tidak ada tabel
 * kedua yang bisa basi. Kalau belum ada pemain lain yang siap, pemanggil
 * bertanggung jawab menyusun lawan buatan.
 */
export async function tcgCariLawanBayangan(ownerJid) {
  const baris = await allQuery(
    `SELECT owner_jid FROM tcg_deck
      WHERE owner_jid != ?
      GROUP BY owner_jid
     HAVING COUNT(DISTINCT slot) = 3
     ORDER BY RANDOM() LIMIT 1`,
    [ownerJid]
  );
  if (!baris.length) return null;

  const lawanJid = baris[0].owner_jid;
  const deck = await tcgGetDeck(lawanJid);
  if (!deck[1] || !deck[2] || !deck[3]) return null;

  return { ownerJid: lawanJid, nama: await tcgGetNama(lawanJid), deck };
}

export async function tcgSparStatus(ownerJid) {
  const hariIni = tcgTanggalHariIni();
  await runQuery("DELETE FROM tcg_spar WHERE owner_jid = ? AND tanggal != ?", [ownerJid, hariIni]);
  await runQuery(
    "INSERT OR IGNORE INTO tcg_spar (owner_jid, tanggal) VALUES (?, ?)",
    [ownerJid, hariIni]
  );
  const r = await getQuery(
    "SELECT menang_penuh, total_main FROM tcg_spar WHERE owner_jid = ? AND tanggal = ?",
    [ownerJid, hariIni]
  );
  const menangPenuh = r?.menang_penuh || 0;
  return {
    tanggal: hariIni,
    menangPenuh,
    totalMain: r?.total_main || 0,
    sisaJatahPenuh: Math.max(0, TCG_SPAR_JATAH_PENUH - menangPenuh),
    hadiahBerikutnya: menangPenuh < TCG_SPAR_JATAH_PENUH
      ? TCG_SPAR_HADIAH
      : Math.round(TCG_SPAR_HADIAH * TCG_SPAR_RASIO_SISA)
  };
}

/**
 * Mencatat satu hasil sparring dan membayar hadiahnya.
 *
 * Hasil menurun setelah jatah harian habis. Tanpa itu, sparring adalah mesin
 * cetak Keping tak terbatas — dan seluruh harga gacha kehilangan artinya.
 */
export async function tcgCatatHasilSpar(ownerJid, menang, lawanJid = null) {
  const hariIni = tcgTanggalHariIni();
  await tcgSparStatus(ownerJid);

  return withTransaction(async () => {
    const r = await getQuery(
      "SELECT menang_penuh FROM tcg_spar WHERE owner_jid = ? AND tanggal = ?",
      [ownerJid, hariIni]
    );
    const menangPenuh = r?.menang_penuh || 0;

    let hadiah = 0;
    let penuh = false;
    if (menang) {
      penuh = menangPenuh < TCG_SPAR_JATAH_PENUH;
      hadiah = penuh ? TCG_SPAR_HADIAH : Math.round(TCG_SPAR_HADIAH * TCG_SPAR_RASIO_SISA);
    }

    await runQuery(
      `UPDATE tcg_spar SET total_main = total_main + 1,
                           menang_penuh = menang_penuh + ?
        WHERE owner_jid = ? AND tanggal = ?`,
      [penuh ? 1 : 0, ownerJid, hariIni]
    );

    if (hadiah > 0) {
      await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [ownerJid]);
      await runQuery("UPDATE tcg_wallet SET keping = keping + ? WHERE owner_jid = ?", [hadiah, ownerJid]);
      await runQuery(
        "INSERT INTO tcg_ledger (owner_jid, delta, sumber, ref) VALUES (?, ?, 'SPAR_MENANG', ?)",
        [ownerJid, hadiah, lawanJid]
      );
    }

    // Pemilik dek yang berhasil bertahan ikut dibayar kecil: itu membuat
    // merawat dek punya nilai walau pemiliknya sedang tidak main.
    let hadiahBertahan = 0;
    if (!menang && lawanJid) {
      hadiahBertahan = TCG_SPAR_HADIAH_BERTAHAN;
      await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [lawanJid]);
      await runQuery("UPDATE tcg_wallet SET keping = keping + ? WHERE owner_jid = ?", [hadiahBertahan, lawanJid]);
      await runQuery(
        "INSERT INTO tcg_ledger (owner_jid, delta, sumber, ref) VALUES (?, ?, 'SPAR_BERTAHAN', ?)",
        [lawanJid, hadiahBertahan, ownerJid]
      );
    }

    const w = await getQuery("SELECT keping, picis FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
    return { hadiah, penuh, hadiahBertahan, kepingTotal: w?.keping || 0 };
  });
}

// ============================================================
// EKSPEDISI
// ============================================================

/** Hasil satu ekspedisi: makin lama dan makin tinggi bintangnya, makin besar. */
export function tcgHasilEkspedisi(jam, bintang) {
  const j = Math.max(1, Math.floor(jam) || 1);
  const b = Math.max(1, Math.min(5, Math.floor(bintang) || 1));
  return {
    keping: j * TCG_EKSPEDISI_PER_JAM * b,
    serpihan: Math.max(1, Math.floor(j / 2))
  };
}

export async function tcgGetEkspedisi(ownerJid) {
  const rows = await allQuery(
    "SELECT slot, card_id, jam, selesai_at FROM tcg_ekspedisi WHERE owner_jid = ? ORDER BY slot",
    [ownerJid]
  );
  const sekarang = Date.now();
  const peta = { 1: null, 2: null, 3: null };
  for (const r of rows) {
    peta[r.slot] = {
      slot: r.slot,
      cardId: r.card_id,
      jam: r.jam,
      selesaiAt: r.selesai_at,
      selesai: sekarang >= r.selesai_at,
      sisaMs: Math.max(0, r.selesai_at - sekarang)
    };
  }
  return peta;
}

/** Kartu yang sedang pergi tidak boleh dipasang ke dek, dan sebaliknya. */
export async function tcgKartuSedangEkspedisi(ownerJid) {
  const rows = await allQuery("SELECT card_id FROM tcg_ekspedisi WHERE owner_jid = ?", [ownerJid]);
  return new Set(rows.map(r => r.card_id));
}

export async function tcgKirimEkspedisi(ownerJid, slot, cardId, jam, cardBintangMap = {}) {
  const s = parseInt(slot, 10);
  const j = parseInt(jam, 10);
  if (![1, 2, 3].includes(s)) return { success: false, reason: 'SLOT_TIDAK_VALID' };
  if (!TCG_EKSPEDISI_DURASI.includes(j)) return { success: false, reason: 'DURASI_TIDAK_VALID' };

  const punya = await getQuery(
    "SELECT qty FROM tcg_collection WHERE owner_jid = ? AND card_id = ? AND qty > 0",
    [ownerJid, cardId]
  );
  if (!punya) return { success: false, reason: 'TIDAK_PUNYA' };

  const terpakai = await getQuery(
    "SELECT slot FROM tcg_ekspedisi WHERE owner_jid = ? AND slot = ?",
    [ownerJid, s]
  );
  if (terpakai) return { success: false, reason: 'SLOT_TERPAKAI' };

  const deck = await tcgGetDeck(ownerJid);
  const diDek = [1, 2, 3].filter(i => deck[i]?.card_id === cardId).length;
  const diEkspedisi = await allQuery(
    "SELECT card_id FROM tcg_ekspedisi WHERE owner_jid = ? AND card_id = ?",
    [ownerJid, cardId]
  );
  // Satu keping kartu satu tugas: yang sedang bertugas di dek atau sedang
  // pergi tidak boleh dihitung dua kali.
  if (punya.qty <= diDek + diEkspedisi.length) {
    return { success: false, reason: 'SEDANG_BERTUGAS', punya: punya.qty, diDek, diEkspedisi: diEkspedisi.length };
  }

  const selesaiAt = Date.now() + j * 60 * 60 * 1000;
  await runQuery(
    "INSERT INTO tcg_ekspedisi (owner_jid, slot, card_id, jam, selesai_at) VALUES (?, ?, ?, ?, ?)",
    [ownerJid, s, cardId, j, selesaiAt]
  );

  const hasil = tcgHasilEkspedisi(j, cardBintangMap[cardId] || 1);
  return { success: true, slot: s, cardId, jam: j, selesaiAt, perkiraan: hasil };
}

export async function tcgKlaimEkspedisi(ownerJid, cardRarityMap = {}, cardBintangMap = {}) {
  const sekarang = Date.now();
  return withTransaction(async () => {
    const rows = await allQuery(
      "SELECT slot, card_id, jam FROM tcg_ekspedisi WHERE owner_jid = ? AND selesai_at <= ?",
      [ownerJid, sekarang]
    );
    if (!rows.length) return { success: false, reason: 'BELUM_ADA_YANG_PULANG' };

    let totalKeping = 0;
    const rincian = [];

    for (const r of rows) {
      const del = await runQuery(
        "DELETE FROM tcg_ekspedisi WHERE owner_jid = ? AND slot = ?",
        [ownerJid, r.slot]
      );
      if (del.changes !== 1) continue;

      const hasil = tcgHasilEkspedisi(r.jam, cardBintangMap[r.card_id] || 1);
      const rarity = cardRarityMap[r.card_id] || 'COMMON';
      totalKeping += hasil.keping;

      await runQuery(
        `INSERT INTO tcg_shards (owner_jid, rarity, jumlah) VALUES (?, ?, ?)
           ON CONFLICT(owner_jid, rarity) DO UPDATE SET jumlah = jumlah + ?`,
        [ownerJid, rarity, hasil.serpihan, hasil.serpihan]
      );

      rincian.push({ slot: r.slot, cardId: r.card_id, jam: r.jam, rarity, ...hasil });
    }

    if (!rincian.length) {
      return { success: false, reason: 'BELUM_ADA_YANG_PULANG' };
    }

    // Picis dibayar per slot yang pulang, bukan sekali per klaim: itu membuat
    // memberangkatkan tiga kartu tiga kali lebih berarti daripada satu.
    const totalPicis = rincian.length * TCG_PICIS_EKSPEDISI_PER_SLOT;
    if (totalKeping > 0 || totalPicis > 0) {
      await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [ownerJid]);
      await runQuery("UPDATE tcg_wallet SET keping = keping + ?, picis = picis + ? WHERE owner_jid = ?", [totalKeping, totalPicis, ownerJid]);
      await runQuery(
        "INSERT INTO tcg_ledger (owner_jid, delta, sumber, ref) VALUES (?, ?, 'EKSPEDISI', ?)",
        [ownerJid, totalKeping, `${rincian.length} slot`]
      );
    }

    const w = await getQuery("SELECT keping, picis FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
    return { success: true, totalKeping, totalPicis, rincian, kepingTotal: w?.keping || 0, picisTotal: w?.picis || 0 };
  });
}

// ============================================================
// GERBANG ELEMEN
// ============================================================

/**
 * Memakai 1 stamina dari jatah Menara. Sengaja satu kolam yang sama: stamina
 * jadi anggaran yang harus dibagi antara mendaki menara dan mengumpulkan
 * material, bukan angka yang cuma menghitung kegagalan.
 */
export async function tcgPakaiStamina(ownerJid, jumlah = 1) {
  await tcgGetTower(ownerJid); // memastikan baris ada & stamina ter-reset harian
  const res = await runQuery(
    "UPDATE tcg_tower SET stamina = stamina - ? WHERE owner_jid = ? AND stamina >= ?",
    [jumlah, ownerJid, jumlah]
  );
  if (res.changes !== 1) {
    const t = await getQuery("SELECT stamina FROM tcg_tower WHERE owner_jid = ?", [ownerJid]);
    return { success: false, reason: 'STAMINA_HABIS', stamina: t?.stamina || 0 };
  }
  const t = await getQuery("SELECT stamina FROM tcg_tower WHERE owner_jid = ?", [ownerJid]);
  return { success: true, sisaStamina: t?.stamina || 0 };
}

export async function tcgHadiahGerbang(ownerJid, rarity, jumlahSerpihan = TCG_GERBANG_SERPIHAN, keping = TCG_GERBANG_KEPING, picis = TCG_PICIS_GERBANG) {
  return withTransaction(async () => {
    await runQuery(
      `INSERT INTO tcg_shards (owner_jid, rarity, jumlah) VALUES (?, ?, ?)
         ON CONFLICT(owner_jid, rarity) DO UPDATE SET jumlah = jumlah + ?`,
      [ownerJid, rarity, jumlahSerpihan, jumlahSerpihan]
    );
    await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [ownerJid]);
    await runQuery("UPDATE tcg_wallet SET keping = keping + ?, picis = picis + ? WHERE owner_jid = ?", [keping, picis, ownerJid]);
    await runQuery(
      "INSERT INTO tcg_ledger (owner_jid, delta, sumber, ref) VALUES (?, ?, 'GERBANG', ?)",
      [ownerJid, keping, rarity]
    );
    const w = await getQuery("SELECT keping, picis FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
    return { keping, picis, serpihan: jumlahSerpihan, rarity, kepingTotal: w?.keping || 0, picisTotal: w?.picis || 0 };
  });
}

// ============================================================
// DROP KARTU DI GRUP
// ============================================================
/**
 * Drop adalah satu-satunya bagian arena yang tidak menunggu diketik siapa pun:
 * kartu jatuh sendiri ke grup mengikuti keramaian obrolan, dan siapa pun boleh
 * menyambar. Itu yang mengubah TCG dari permainan yang dimainkan DI DALAM grup
 * jadi permainan yang dimainkan OLEH grup.
 *
 * Peluangnya sengaja dicondongkan ke bawah dan Mythic tidak pernah keluar.
 * Kartu gratis bersaing langsung dengan gacha — satu-satunya lubang pembuangan
 * Keping — jadi drop bertugas memberi bahan serpihan dan momen ramai, bukan
 * menggantikan gacha sebagai jalan mendapat kartu terbaik.
 */
export const TCG_DROP_JUMLAH = 3;
export const TCG_DROP_DETIK = 90;
export const TCG_DROP_PESAN_PEMICU = 40;
export const TCG_DROP_JEDA_MS = 15 * 60 * 1000;

export const TCG_DROP_PELUANG = [
  ['LEGENDARY', 0.008],
  ['EPIC',      0.072],
  ['RARE',      0.300],
  ['COMMON',    0.620]
];

export async function initTcgDropSchema() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_drop (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      jid            TEXT NOT NULL,
      kartu_json     TEXT NOT NULL,
      dibuat_at      INTEGER NOT NULL,
      kedaluwarsa_at INTEGER NOT NULL,
      aktif          INTEGER NOT NULL DEFAULT 1 CHECK(aktif IN (0, 1))
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_drop_ambil (
      drop_id   INTEGER NOT NULL,
      owner_jid TEXT NOT NULL,
      idx       INTEGER NOT NULL,
      diambil_at INTEGER NOT NULL,
      PRIMARY KEY (drop_id, owner_jid)
    )
  `);

  // Satu kartu dalam satu drop hanya boleh jatuh ke satu orang. Dijamin oleh
  // indeks unik, bukan oleh pemeriksaan di kode — dua orang yang mengetik pada
  // milidetik yang sama tetap tidak bisa mendapat kartu yang sama.
  await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS idx_tcg_drop_kartu ON tcg_drop_ambil(drop_id, idx)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_tcg_drop_jid ON tcg_drop(jid, aktif)");
}

export async function tcgBuatDrop(jid, kartuIds, detik = TCG_DROP_DETIK) {
  const sekarang = Date.now();
  await runQuery("UPDATE tcg_drop SET aktif = 0 WHERE jid = ? AND aktif = 1", [jid]);
  const res = await runQuery(
    "INSERT INTO tcg_drop (jid, kartu_json, dibuat_at, kedaluwarsa_at) VALUES (?, ?, ?, ?)",
    [jid, JSON.stringify(kartuIds), sekarang, sekarang + detik * 1000]
  );
  return { id: res.lastID, kartuIds, kedaluwarsaAt: sekarang + detik * 1000 };
}

export async function tcgGetDropAktif(jid) {
  const d = await getQuery(
    "SELECT * FROM tcg_drop WHERE jid = ? AND aktif = 1 ORDER BY id DESC LIMIT 1",
    [jid]
  );
  if (!d) return null;
  if (Date.now() > d.kedaluwarsa_at) {
    await runQuery("UPDATE tcg_drop SET aktif = 0 WHERE id = ?", [d.id]);
    return null;
  }
  const diambil = await allQuery(
    "SELECT owner_jid, idx FROM tcg_drop_ambil WHERE drop_id = ?",
    [d.id]
  );
  let kartuIds = [];
  try { kartuIds = JSON.parse(d.kartu_json); } catch { kartuIds = []; }

  return {
    id: d.id,
    jid: d.jid,
    kartuIds,
    kedaluwarsaAt: d.kedaluwarsa_at,
    sisaMs: Math.max(0, d.kedaluwarsa_at - Date.now()),
    diambil: diambil.map(r => ({ ownerJid: r.owner_jid, idx: r.idx }))
  };
}

/**
 * Menyambar satu kartu dari drop yang sedang berjalan.
 *
 * Dua aturannya ditegakkan oleh kunci basis data, bukan oleh urutan pengecekan:
 * kunci utama (drop_id, owner_jid) membuat satu orang hanya bisa dapat satu
 * kartu, dan indeks unik (drop_id, idx) membuat satu kartu hanya bisa jatuh ke
 * satu orang. Yang kalah cepat menerima penolakan, bukan salinan kedua.
 */
export async function tcgAmbilKartuDrop(dropId, ownerJid, idx) {
  const d = await getQuery("SELECT * FROM tcg_drop WHERE id = ? AND aktif = 1", [dropId]);
  if (!d) return { success: false, reason: 'DROP_TIDAK_AKTIF' };
  if (Date.now() > d.kedaluwarsa_at) {
    await runQuery("UPDATE tcg_drop SET aktif = 0 WHERE id = ?", [dropId]);
    return { success: false, reason: 'KEDALUWARSA' };
  }

  let kartuIds = [];
  try { kartuIds = JSON.parse(d.kartu_json); } catch { kartuIds = []; }
  const i = parseInt(idx, 10);
  if (!(i >= 1 && i <= kartuIds.length)) {
    return { success: false, reason: 'NOMOR_TIDAK_VALID', jumlah: kartuIds.length };
  }

  const sudah = await getQuery(
    "SELECT idx FROM tcg_drop_ambil WHERE drop_id = ? AND owner_jid = ?",
    [dropId, ownerJid]
  );
  if (sudah) return { success: false, reason: 'SUDAH_AMBIL', idxSebelumnya: sudah.idx };

  try {
    await runQuery(
      "INSERT INTO tcg_drop_ambil (drop_id, owner_jid, idx, diambil_at) VALUES (?, ?, ?, ?)",
      [dropId, ownerJid, i, Date.now()]
    );
  } catch (e) {
    // Pelanggaran indeks unik = kalah cepat. Ini jalur normal, bukan kerusakan.
    const pemilik = await getQuery(
      "SELECT owner_jid FROM tcg_drop_ambil WHERE drop_id = ? AND idx = ?",
      [dropId, i]
    );
    return { success: false, reason: 'SUDAH_DIAMBIL_ORANG', olehJid: pemilik?.owner_jid || null };
  }

  const cardId = kartuIds[i - 1];
  const sebelum = await tcgGetKartu(ownerJid, cardId);
  const baru = !sebelum || sebelum.qty === 0;
  await tcgTambahKartu(ownerJid, cardId, 1);

  const semua = await allQuery("SELECT idx FROM tcg_drop_ambil WHERE drop_id = ?", [dropId]);
  if (semua.length >= kartuIds.length) {
    await runQuery("UPDATE tcg_drop SET aktif = 0 WHERE id = ?", [dropId]);
  }

  return { success: true, cardId, idx: i, habis: semua.length >= kartuIds.length, baru };
}

/** Membersihkan drop lama supaya tabel tidak tumbuh selamanya. */
export async function tcgBersihkanDropLama(umurJam = 24) {
  const batas = Date.now() - umurJam * 60 * 60 * 1000;
  await runQuery("DELETE FROM tcg_drop_ambil WHERE drop_id IN (SELECT id FROM tcg_drop WHERE dibuat_at < ?)", [batas]);
  const res = await runQuery("DELETE FROM tcg_drop WHERE dibuat_at < ?", [batas]);
  return res.changes || 0;
}
