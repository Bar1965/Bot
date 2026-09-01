/**
 * ARENA KARTU MONSTER — LAPISAN RETENSI (STREAK, PERINGKAT, GELAR, BARTER)
 *
 * `tcgDb.js` memegang ekonomi arena: Keping, kartu, serpihan, energi. Berkas ini
 * memegang alasan pemain kembali besok — hal-hal yang tidak menambah kekuatan
 * tempur tapi menambah cerita: beruntun harian, papan peringkat musiman, gelar
 * permanen, tonggak koleksi, Menara Abadi, dan barter duplikat antar pemain.
 *
 * Dipisah dari `tcgDb.js` karena berkas itu sudah 1600+ baris dan karena kedua
 * lapisan punya alasan berubah yang berbeda: yang satu diubah saat neraca
 * ekonomi digeser, yang satu saat kita menambah alasan untuk betah.
 *
 * ARAH IMPOR SATU JALUR: berkas ini boleh mengimpor `tcgDb.js`, tapi `tcgDb.js`
 * TIDAK BOLEH mengimpor berkas ini. Melanggarnya membuat lingkar impor yang di
 * ESM tampil sebagai `undefined` diam-diam, bukan sebagai galat.
 */

import { runQuery, getQuery, allQuery, withTransaction } from './connection.js';
import { tcgTanggalHariIni, TCG_RARITY, TCG_BONUS_HARIAN_KEPING, tcgGetRansumDef } from './tcgDb.js';

// ============================================================
// KALENDER
// ============================================================

/** YYYY-MM-DD sehari sebelum `tanggal`. Dipakai untuk menilai beruntun. */
export function tcgHariSebelum(tanggal) {
  const d = new Date(`${tanggal}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Jumlah hari penuh dari `a` ke `b` (bisa negatif). */
export function tcgSelisihHari(a, b) {
  const ms = new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`);
  return Math.floor(ms / 86400000);
}

/**
 * Tanggal Senin dari minggu yang memuat `tanggal`.
 *
 * Dipakai sebagai kunci misi mingguan. Sengaja memakai tanggal Senin, bukan
 * nomor minggu ISO: nomor minggu berganti tahun di tengah minggu dan urutannya
 * jadi tidak bisa dibandingkan sebagai teks, sedangkan tanggal selalu bisa.
 */
export function tcgSeninMinggu(tanggal = tcgTanggalHariIni()) {
  const d = new Date(`${tanggal}T00:00:00Z`);
  const mundur = (d.getUTCDay() + 6) % 7; // Senin = 0
  d.setUTCDate(d.getUTCDate() - mundur);
  return d.toISOString().slice(0, 10);
}

// ============================================================
// SKEMA
// ============================================================

export async function initTcgMetaSchema() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_streak (
      owner_jid        TEXT PRIMARY KEY,
      streak           INTEGER NOT NULL DEFAULT 0 CHECK(streak >= 0),
      terpanjang       INTEGER NOT NULL DEFAULT 0 CHECK(terpanjang >= 0),
      total_klaim      INTEGER NOT NULL DEFAULT 0 CHECK(total_klaim >= 0),
      tanggal_terakhir TEXT
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_misi_mingguan (
      owner_jid TEXT NOT NULL,
      minggu    TEXT NOT NULL,
      misi_id   TEXT NOT NULL,
      progres   INTEGER NOT NULL DEFAULT 0 CHECK(progres >= 0),
      diklaim   INTEGER NOT NULL DEFAULT 0 CHECK(diklaim IN (0, 1)),
      PRIMARY KEY (owner_jid, minggu, misi_id)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_rank (
      owner_jid      TEXT NOT NULL,
      musim          INTEGER NOT NULL,
      poin           INTEGER NOT NULL DEFAULT 1000 CHECK(poin >= 0),
      tertinggi      INTEGER NOT NULL DEFAULT 1000,
      menang         INTEGER NOT NULL DEFAULT 0,
      kalah          INTEGER NOT NULL DEFAULT 0,
      seri           INTEGER NOT NULL DEFAULT 0,
      beruntun       INTEGER NOT NULL DEFAULT 0,
      hadiah_diklaim INTEGER NOT NULL DEFAULT 0 CHECK(hadiah_diklaim IN (0, 1)),
      hadiah_diumumkan INTEGER NOT NULL DEFAULT 0 CHECK(hadiah_diumumkan IN (0, 1)),
      updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (owner_jid, musim)
    )
  `);

  // Penjaga akun kembar: dua orang yang saling menduel berkali-kali dalam sehari
  // hanya dihitung untuk beberapa laga pertama.
  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_rank_pasangan (
      musim   INTEGER NOT NULL,
      tanggal TEXT NOT NULL,
      a       TEXT NOT NULL,
      b       TEXT NOT NULL,
      jumlah  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (musim, tanggal, a, b)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_gelar (
      owner_jid TEXT NOT NULL,
      gelar_id  TEXT NOT NULL,
      nama      TEXT,
      at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (owner_jid, gelar_id)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_tonggak (
      owner_jid  TEXT NOT NULL,
      tonggak_id TEXT NOT NULL,
      at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (owner_jid, tonggak_id)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_abadi (
      owner_jid  TEXT PRIMARY KEY,
      lantai     INTEGER NOT NULL DEFAULT 0 CHECK(lantai >= 0),
      percobaan  INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_barter_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      a_jid      TEXT NOT NULL,
      b_jid      TEXT NOT NULL,
      kartu_a    TEXT NOT NULL,
      kartu_b    TEXT NOT NULL,
      tanggal    TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_barter_kuota (
      owner_jid TEXT NOT NULL,
      tanggal   TEXT NOT NULL,
      jumlah    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (owner_jid, tanggal)
    )
  `);

  // Gelar yang sedang dipajang. Kolom menyusul belakangan, jadi pakai pola
  // ALTER-dibungkus-try seperti bagian lain repo ini.
  try { await runQuery("ALTER TABLE tcg_profil ADD COLUMN gelar_aktif TEXT"); } catch (e) { /* sudah ada */ }

  // Terpisah dari `hadiah_diklaim` — lihat catatan panjang di `tcgGetRank`.
  try { await runQuery("ALTER TABLE tcg_rank ADD COLUMN hadiah_diumumkan INTEGER NOT NULL DEFAULT 0"); } catch (e) { /* sudah ada */ }

  await runQuery("CREATE INDEX IF NOT EXISTS idx_tcg_rank_musim ON tcg_rank(musim, poin DESC)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_tcg_barter_log ON tcg_barter_log(a_jid, tanggal)");
}

// ============================================================
// PEMBAYAR HADIAH BERSAMA
// ============================================================

/**
 * Satu-satunya jalur pemberian hadiah di berkas ini.
 *
 * Streak, misi mingguan, tonggak koleksi, akhir musim, dan Menara Abadi
 * membayar dengan bahan yang sama. Menyalin blok INSERT-nya lima kali adalah
 * cara paling mudah membuat salah satunya lupa mencatat ledger.
 *
 * Aman dipanggil di dalam transaksi lain — `withTransaction` bersarang.
 */
async function bayarHadiah(ownerJid, hadiah = {}, sumber = 'HADIAH', ref = null) {
  const keping = Math.max(0, Math.floor(Number(hadiah.keping) || 0));
  const teks = [];

  if (keping > 0) {
    await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [ownerJid]);
    await runQuery("UPDATE tcg_wallet SET keping = keping + ? WHERE owner_jid = ?", [keping, ownerJid]);
    await runQuery(
      "INSERT INTO tcg_ledger (owner_jid, delta, sumber, ref) VALUES (?, ?, ?, ?)",
      [ownerJid, keping, sumber, ref]
    );
    teks.push(`💠 +${keping} Keping`);
  }

  const daftarSerpihan = Array.isArray(hadiah.serpihan)
    ? hadiah.serpihan
    : (hadiah.serpihan ? [hadiah.serpihan] : []);
  for (const s of daftarSerpihan) {
    if (!TCG_RARITY.includes(s?.rarity)) continue;
    const n = Math.max(1, Math.floor(Number(s.jumlah) || 1));
    await runQuery(
      `INSERT INTO tcg_shards (owner_jid, rarity, jumlah) VALUES (?, ?, ?)
         ON CONFLICT(owner_jid, rarity) DO UPDATE SET jumlah = jumlah + ?`,
      [ownerJid, s.rarity, n, n]
    );
    teks.push(`✦ +${n} Serpihan ${s.rarity}`);
  }

  const daftarItem = Array.isArray(hadiah.item)
    ? hadiah.item
    : (hadiah.item ? [hadiah.item] : []);
  for (const it of daftarItem) {
    const def = tcgGetRansumDef(it?.id || it);
    if (!def) continue;
    const n = Math.max(1, Math.floor(Number(it?.jumlah) || 1));
    await runQuery(
      `INSERT INTO tcg_item (owner_jid, item_id, qty) VALUES (?, ?, ?)
         ON CONFLICT(owner_jid, item_id) DO UPDATE SET qty = qty + ?, updated_at = CURRENT_TIMESTAMP`,
      [ownerJid, def.id, n, n]
    );
    teks.push(`${def.nama} ×${n}`);
  }

  return { keping, teks };
}

/**
 * Ringkasan isi hadiah TANPA membayarnya.
 *
 * Dipakai layar yang perlu menampilkan hadiah yang sudah telanjur dibayar di
 * pemanggilan sebelumnya — lihat pemisahan "dibayar" vs "diumumkan" di
 * `tcgGetRank`.
 */
export function ringkasHadiah(hadiah = {}) {
  const teks = [];
  const keping = Math.max(0, Math.floor(Number(hadiah.keping) || 0));
  if (keping > 0) teks.push(`💠 +${keping} Keping`);
  for (const s of (Array.isArray(hadiah.serpihan) ? hadiah.serpihan : (hadiah.serpihan ? [hadiah.serpihan] : []))) {
    if (TCG_RARITY.includes(s?.rarity)) teks.push(`✦ +${Math.max(1, Math.floor(Number(s.jumlah) || 1))} Serpihan ${s.rarity}`);
  }
  for (const it of (Array.isArray(hadiah.item) ? hadiah.item : (hadiah.item ? [hadiah.item] : []))) {
    const def = tcgGetRansumDef(it?.id || it);
    if (def) teks.push(`${def.nama} ×${Math.max(1, Math.floor(Number(it?.jumlah) || 1))}`);
  }
  return teks;
}

// ============================================================
// 1. BERUNTUN HARIAN (STREAK)
// ============================================================

export const TCG_STREAK_BONUS_PER_HARI = 10;
export const TCG_STREAK_BONUS_MAKS = 100;

/**
 * Tonggak beruntun. Hari 30 sengaja berulang tiap kelipatan 30 supaya pemain
 * yang sudah lewat sebulan tetap punya sesuatu yang ditunggu, bukan garis datar.
 */
export const TCG_STREAK_TONGGAK = [
  { hari: 3,  keping: 60,  item: [{ id: 'RANSUM_MENARA', jumlah: 1 }] },
  { hari: 7,  keping: 150, item: [{ id: 'RANSUM_GERBANG', jumlah: 2 }], serpihan: [{ rarity: 'RARE', jumlah: 3 }] },
  { hari: 14, keping: 300, item: [{ id: 'RANSUM_AGUNG', jumlah: 1 }],   serpihan: [{ rarity: 'EPIC', jumlah: 2 }] },
  { hari: 30, keping: 800, item: [{ id: 'RANSUM_AGUNG', jumlah: 2 }],   serpihan: [{ rarity: 'LEGENDARY', jumlah: 3 }] }
];

export function tcgTonggakStreak(hari) {
  const tepat = TCG_STREAK_TONGGAK.find(t => t.hari === hari);
  if (tepat) return tepat;
  if (hari > 30 && hari % 30 === 0) return TCG_STREAK_TONGGAK[TCG_STREAK_TONGGAK.length - 1];
  return null;
}

/** Bonus Keping dari panjang beruntun, tanpa tonggak. Hari ke-1 = 0. */
export function tcgBonusStreak(streak) {
  const n = Math.max(1, Math.floor(Number(streak) || 1));
  return Math.min(TCG_STREAK_BONUS_MAKS, (n - 1) * TCG_STREAK_BONUS_PER_HARI);
}

/** Tonggak beruntun terdekat setelah `streak`, untuk ditampilkan sebagai umpan. */
export function tcgTonggakBerikutnya(streak) {
  const n = Math.max(0, Math.floor(Number(streak) || 0));
  const depan = TCG_STREAK_TONGGAK.find(t => t.hari > n);
  if (depan) return { hari: depan.hari, sisa: depan.hari - n };
  const berikut = (Math.floor(n / 30) + 1) * 30;
  return { hari: berikut, sisa: berikut - n };
}

export async function tcgGetStreak(ownerJid) {
  await runQuery("INSERT OR IGNORE INTO tcg_streak (owner_jid) VALUES (?)", [ownerJid]);
  const r = await getQuery(
    "SELECT streak, terpanjang, total_klaim, tanggal_terakhir FROM tcg_streak WHERE owner_jid = ?",
    [ownerJid]
  );
  const hariIni = tcgTanggalHariIni();
  const terakhir = r?.tanggal_terakhir || null;
  const tersimpan = r?.streak || 0;

  // Beruntun yang sudah basi ditampilkan sebagai 0 tanpa menulis apa pun.
  // Menulis di jalur baca berarti sekadar mengetik `.tcg` bisa memutus beruntun.
  const masihHidup = terakhir === hariIni || terakhir === tcgHariSebelum(hariIni);
  const streak = masihHidup ? tersimpan : 0;

  return {
    streak,
    terpanjang: r?.terpanjang || 0,
    totalKlaim: r?.total_klaim || 0,
    tanggalTerakhir: terakhir,
    sudahKlaimHariIni: terakhir === hariIni,
    bonusBerikutnya: tcgBonusStreak(streak + 1),
    tonggakBerikutnya: tcgTonggakBerikutnya(streak)
  };
}

/**
 * Klaim harian lengkap: penjaga sekali-sehari, Keping dasar, bonus beruntun,
 * dan hadiah tonggak — semuanya dalam SATU transaksi.
 *
 * Dulu ini `tcgKlaimGratis` yang hanya membayar Keping datar. Memisahkan
 * "catat beruntun" ke transaksi kedua pernah dipertimbangkan dan ditolak:
 * kalau transaksi kedua gagal, pemain kehilangan tonggak hari ke-30 tanpa cara
 * mengulanginya, karena penjaga hariannya sudah terpakai.
 */
export async function tcgKlaimHarian(ownerJid) {
  const hariIni = tcgTanggalHariIni();
  await runQuery("INSERT OR IGNORE INTO tcg_pity (owner_jid) VALUES (?)", [ownerJid]);
  await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [ownerJid]);
  await runQuery("INSERT OR IGNORE INTO tcg_streak (owner_jid) VALUES (?)", [ownerJid]);

  return withTransaction(async () => {
    const res = await runQuery(
      "UPDATE tcg_pity SET gratis_tanggal = ? WHERE owner_jid = ? AND (gratis_tanggal IS NULL OR gratis_tanggal != ?)",
      [hariIni, ownerJid, hariIni]
    );
    if (res.changes !== 1) return { success: false, reason: 'SUDAH_KLAIM' };

    const s = await getQuery(
      "SELECT streak, terpanjang, tanggal_terakhir FROM tcg_streak WHERE owner_jid = ?",
      [ownerJid]
    );
    const sebelum = s?.streak || 0;
    const lanjut = s?.tanggal_terakhir === tcgHariSebelum(hariIni);
    const streak = lanjut ? sebelum + 1 : 1;
    const putus = !lanjut && sebelum > 1;
    const terpanjang = Math.max(s?.terpanjang || 0, streak);

    await runQuery(
      `UPDATE tcg_streak SET streak = ?, terpanjang = ?, total_klaim = total_klaim + 1,
                             tanggal_terakhir = ?
        WHERE owner_jid = ?`,
      [streak, terpanjang, hariIni, ownerJid]
    );

    const bonus = tcgBonusStreak(streak);
    const dasar = await bayarHadiah(
      ownerJid,
      { keping: TCG_BONUS_HARIAN_KEPING + bonus },
      'DAILY_LOGIN',
      `${hariIni} streak${streak}`
    );

    const tonggakDef = tcgTonggakStreak(streak);
    let tonggak = null;
    if (tonggakDef) {
      const bayar = await bayarHadiah(ownerJid, tonggakDef, 'STREAK_TONGGAK', `hari${streak}`);
      tonggak = { hari: tonggakDef.hari, teks: bayar.teks };
    }

    const w = await getQuery("SELECT keping FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
    return {
      success: true,
      streak,
      streakSebelum: sebelum,
      putus,
      terpanjang,
      kepingDasar: TCG_BONUS_HARIAN_KEPING,
      bonusStreak: bonus,
      kepingDapat: dasar.keping,
      kepingTotal: w?.keping || 0,
      tonggak,
      bonusBesok: tcgBonusStreak(streak + 1),
      tonggakBerikutnya: tcgTonggakBerikutnya(streak)
    };
  });
}

export async function getTcgStreakLeaderboard(limit = 10) {
  const n = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 10));
  const hariIni = tcgTanggalHariIni();
  const kemarin = tcgHariSebelum(hariIni);
  return await allQuery(
    `SELECT s.owner_jid AS customer_jid, s.streak, s.terpanjang, s.total_klaim,
            p.nama AS customer_nama
       FROM tcg_streak s
       LEFT JOIN tcg_profil p ON p.owner_jid = s.owner_jid
      WHERE s.tanggal_terakhir IN (?, ?) AND s.streak > 0
      ORDER BY s.streak DESC, s.terpanjang DESC
      LIMIT ?`,
    [hariIni, kemarin, n]
  );
}

// ============================================================
// 2. MISI MINGGUAN
// ============================================================

/**
 * Misi mingguan sengaja TIDAK dirotasi.
 *
 * Misi harian berganti tiap hari supaya tidak membosankan; misi mingguan justru
 * harus bisa direncanakan sejak Senin. Kalau isinya ikut berubah, pemain tidak
 * bisa menabung progres, dan seluruh gunanya hilang.
 */
export const TCG_MISI_MINGGUAN = [
  {
    id: 'M_TEMPUR', emoji: '⚔️', nama: 'Menangkan 12 pertarungan apa pun',
    target: 12, hadiah: { keping: 300, item: [{ id: 'RANSUM_AGUNG', jumlah: 1 }] },
    aksi: ['MENARA', 'DUEL', 'SPAR', 'GERBANG', 'ABADI', 'GAUNTLET']
  },
  {
    id: 'M_BOS', emoji: '👹', nama: 'Pukul Bos Arena grup 8 kali',
    target: 8, hadiah: { keping: 300, serpihan: [{ rarity: 'EPIC', jumlah: 2 }] },
    aksi: ['BOS']
  },
  {
    id: 'M_TARIK', emoji: '🎴', nama: 'Tarik 15 kartu',
    target: 15, hadiah: { keping: 350, serpihan: [{ rarity: 'EPIC', jumlah: 2 }] },
    aksi: ['GACHA']
  },
  {
    id: 'M_RAWAT', emoji: '🛠️', nama: 'Naikkan level kartu 3 kali',
    target: 3, hadiah: { keping: 250, serpihan: [{ rarity: 'RARE', jumlah: 4 }] },
    aksi: ['NAIK']
  }
];

export const TCG_MISI_MINGGUAN_BONUS_ID = 'M_BONUS';
export const TCG_MISI_MINGGUAN_BONUS = {
  keping: 500,
  item: [{ id: 'RANSUM_AGUNG', jumlah: 2 }],
  serpihan: [{ rarity: 'LEGENDARY', jumlah: 2 }]
};

export function getMisiMingguanDef(id) {
  return TCG_MISI_MINGGUAN.find(m => m.id === id) || null;
}

async function pastikanBarisMingguan(ownerJid, minggu) {
  await runQuery("DELETE FROM tcg_misi_mingguan WHERE owner_jid = ? AND minggu != ?", [ownerJid, minggu]);
  for (const m of [...TCG_MISI_MINGGUAN, { id: TCG_MISI_MINGGUAN_BONUS_ID }]) {
    await runQuery(
      "INSERT OR IGNORE INTO tcg_misi_mingguan (owner_jid, minggu, misi_id) VALUES (?, ?, ?)",
      [ownerJid, minggu, m.id]
    );
  }
}

export async function tcgGetMisiMingguan(ownerJid) {
  const minggu = tcgSeninMinggu();
  await pastikanBarisMingguan(ownerJid, minggu);

  const baris = await allQuery(
    "SELECT misi_id, progres, diklaim FROM tcg_misi_mingguan WHERE owner_jid = ? AND minggu = ?",
    [ownerJid, minggu]
  );
  const peta = new Map(baris.map(b => [b.misi_id, b]));

  const daftar = TCG_MISI_MINGGUAN.map(m => {
    const b = peta.get(m.id) || { progres: 0, diklaim: 0 };
    const progres = Math.min(m.target, b.progres || 0);
    return { ...m, progres, selesai: progres >= m.target, diklaim: !!b.diklaim };
  });

  const jumlahSelesai = daftar.filter(m => m.selesai).length;
  const bonusRow = peta.get(TCG_MISI_MINGGUAN_BONUS_ID) || { diklaim: 0 };
  const bonusSiap = jumlahSelesai >= TCG_MISI_MINGGUAN.length;
  const adaKlaim = daftar.some(m => m.selesai && !m.diklaim) || (bonusSiap && !bonusRow.diklaim);

  const sisaHari = 7 - tcgSelisihHari(minggu, tcgTanggalHariIni());

  return {
    minggu, daftar, jumlahSelesai, bonusSiap,
    bonusDiklaim: !!bonusRow.diklaim, adaKlaim, sisaHari
  };
}

/**
 * Menyalurkan satu aksi ke semua misi mingguan yang menghitungnya.
 *
 * Satu aksi bisa mengisi lebih dari satu misi — itu disengaja: memaksa pemain
 * memilih antara dua misi yang sama-sama menghitung "menang" hanya membuat
 * mingguan terasa seperti pajak.
 */
export async function tcgCatatMingguan(ownerJid, aksi, jumlah = 1) {
  const n = Math.max(1, Math.floor(Number(jumlah) || 1));
  const kena = TCG_MISI_MINGGUAN.filter(m => m.aksi.includes(aksi));
  if (!kena.length) return;

  const minggu = tcgSeninMinggu();
  await pastikanBarisMingguan(ownerJid, minggu);
  for (const m of kena) {
    await runQuery(
      `UPDATE tcg_misi_mingguan SET progres = MIN(?, progres + ?)
        WHERE owner_jid = ? AND minggu = ? AND misi_id = ? AND progres < ?`,
      [m.target, n, ownerJid, minggu, m.id, m.target]
    );
  }
}

export async function tcgKlaimMisiMingguan(ownerJid) {
  const minggu = tcgSeninMinggu();
  await pastikanBarisMingguan(ownerJid, minggu);

  return withTransaction(async () => {
    const rincian = [];
    let totalKeping = 0;

    for (const m of TCG_MISI_MINGGUAN) {
      const res = await runQuery(
        `UPDATE tcg_misi_mingguan SET diklaim = 1
          WHERE owner_jid = ? AND minggu = ? AND misi_id = ? AND diklaim = 0 AND progres >= ?`,
        [ownerJid, minggu, m.id, m.target]
      );
      if (res.changes !== 1) continue;
      const bayar = await bayarHadiah(ownerJid, m.hadiah, 'MISI_MINGGUAN', m.id);
      totalKeping += bayar.keping;
      rincian.push({ nama: `${m.emoji} ${m.nama}`, teks: bayar.teks });
    }

    // Bonus dinilai dari progres, bukan dari status "sudah diklaim" di atas —
    // mengklaim satu per satu tidak boleh mengubah syarat bonusnya.
    const status = await tcgGetMisiMingguan(ownerJid);
    if (status.bonusSiap) {
      const res = await runQuery(
        `UPDATE tcg_misi_mingguan SET diklaim = 1
          WHERE owner_jid = ? AND minggu = ? AND misi_id = ? AND diklaim = 0`,
        [ownerJid, minggu, TCG_MISI_MINGGUAN_BONUS_ID]
      );
      if (res.changes === 1) {
        const bayar = await bayarHadiah(ownerJid, TCG_MISI_MINGGUAN_BONUS, 'MISI_MINGGUAN_BONUS', minggu);
        totalKeping += bayar.keping;
        rincian.push({ nama: '🏅 Bonus tuntas mingguan', teks: bayar.teks });
      }
    }

    if (!rincian.length) return { success: false, reason: 'TIDAK_ADA' };
    const w = await getQuery("SELECT keping FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
    return { success: true, rincian, totalKeping, kepingTotal: w?.keping || 0 };
  });
}

// ============================================================
// 3. PERINGKAT & MUSIM
// ============================================================

/** Senin. Musim ke-N dimulai `TCG_MUSIM_HARI * (N-1)` hari setelah tanggal ini. */
export const TCG_MUSIM_EPOCH = '2026-08-03';
export const TCG_MUSIM_HARI = 30;
export const TCG_POIN_AWAL = 1000;

/** Faktor K Elo. Duel PvP sungguhan bergerak dua kali lebih cepat dari sparring. */
export const TCG_K_DUEL = 28;
export const TCG_K_SPAR = 12;

/** Laga berperingkat maksimum melawan orang yang SAMA dalam satu hari. */
export const TCG_RANK_MAKS_PASANGAN = 3;
/** Sparring berperingkat per hari — sejalan dengan jatah hadiah penuh sparring. */
export const TCG_RANK_MAKS_SPAR = 5;

export const TCG_TIER = [
  { min: 1800, id: 'LEGENDA',  nama: 'Legenda',  emoji: '🔱' },
  { min: 1600, id: 'MASTER',   nama: 'Master',   emoji: '👑' },
  { min: 1450, id: 'DIAMOND',  nama: 'Diamond',  emoji: '💎' },
  { min: 1300, id: 'PLATINA',  nama: 'Platina',  emoji: '💠' },
  { min: 1150, id: 'EMAS',     nama: 'Emas',     emoji: '🥇' },
  { min: 1000, id: 'PERAK',    nama: 'Perak',    emoji: '🥈' },
  { min: 0,    id: 'PERUNGGU', nama: 'Perunggu', emoji: '🥉' }
];

export function tcgTier(poin) {
  const p = Math.max(0, Math.floor(Number(poin) || 0));
  return TCG_TIER.find(t => p >= t.min) || TCG_TIER[TCG_TIER.length - 1];
}

/** Tier tepat di atas `poin`, untuk menampilkan "kurang N poin lagi". */
export function tcgTierBerikutnya(poin) {
  const p = Math.max(0, Math.floor(Number(poin) || 0));
  const naik = [...TCG_TIER].reverse().find(t => t.min > p);
  return naik ? { ...naik, kurang: naik.min - p } : null;
}

export function tcgMusimSekarang(tanggal = tcgTanggalHariIni()) {
  const lewat = Math.max(0, tcgSelisihHari(TCG_MUSIM_EPOCH, tanggal));
  const nomor = Math.floor(lewat / TCG_MUSIM_HARI) + 1;
  const hariKe = (lewat % TCG_MUSIM_HARI) + 1;
  return { nomor, hariKe, sisaHari: TCG_MUSIM_HARI - hariKe + 1 };
}

/**
 * Hadiah akhir musim per tier. Dibayar malas — saat pemain pertama kali
 * menyentuh peringkat di musim baru, bukan lewat sapuan penjadwal.
 *
 * Alasannya sama dengan regen energi: bot ini bisa mati semalaman, dan sapuan
 * yang terlewat berarti seluruh grup kehilangan hadiah musimnya tanpa jejak.
 */
export const TCG_HADIAH_MUSIM = {
  LEGENDA:  { keping: 2500, serpihan: [{ rarity: 'MYTHIC', jumlah: 3 }],    item: [{ id: 'RANSUM_AGUNG', jumlah: 3 }] },
  MASTER:   { keping: 1500, serpihan: [{ rarity: 'LEGENDARY', jumlah: 4 }], item: [{ id: 'RANSUM_AGUNG', jumlah: 2 }] },
  DIAMOND:  { keping: 900,  serpihan: [{ rarity: 'LEGENDARY', jumlah: 2 }], item: [{ id: 'RANSUM_AGUNG', jumlah: 1 }] },
  PLATINA:  { keping: 600,  serpihan: [{ rarity: 'EPIC', jumlah: 3 }] },
  EMAS:     { keping: 400,  serpihan: [{ rarity: 'EPIC', jumlah: 2 }] },
  PERAK:    { keping: 250,  serpihan: [{ rarity: 'RARE', jumlah: 3 }] },
  PERUNGGU: { keping: 120,  serpihan: [{ rarity: 'COMMON', jumlah: 3 }] }
};

/**
 * Reset lunak antar musim: separuh jarak dari titik awal dibawa, tapi tidak
 * pernah turun di bawah 800.
 *
 * Reset total membuat pemain lama mulai dari nol tiap bulan dan itu terasa
 * seperti hukuman; tanpa reset sama sekali, papan peringkat beku setelah dua
 * musim dan pemain baru tidak punya alasan mencoba.
 */
export function tcgResetLunak(poinLama) {
  // `Number(x) || TCG_POIN_AWAL` TIDAK boleh dipakai di sini: poin 0 itu nilai
  // yang sah (pemain yang habis kalah terus), dan `0 || 1000` diam-diam
  // mengubahnya jadi 1000 — hadiah untuk musim terburuk yang mungkin.
  const n = Number(poinLama);
  const p = Number.isFinite(n) ? Math.floor(n) : TCG_POIN_AWAL;
  return Math.max(800, TCG_POIN_AWAL + Math.round((p - TCG_POIN_AWAL) * 0.5));
}

/**
 * Baca peringkat musim berjalan, sekalian membayar hadiah musim sebelumnya
 * kalau ada yang belum diklaim.
 *
 * "DIBAYAR" DAN "DIUMUMKAN" SENGAJA DUA HAL BERBEDA.
 *
 * Pembayaran harus terjadi di panggilan mana pun — kalau tidak, hadiah musim
 * baru masuk saat pemain kebetulan membuka layar yang tepat. Tapi fungsi ini
 * juga dipanggil dari tempat-tempat yang TIDAK mencetak apa pun tentang musim:
 * header menu, kartu tantangan duel, dan `tcgCatatLaga`. Kalau payload
 * pengumumannya ikut habis di sana, pemain dibayar 2.500 Keping tanpa pernah
 * diberi tahu — persis kelas bug yang paling sulit dilaporkan.
 *
 * Jadi: uang dibayar sekali (`hadiah_diklaim`), teks pengumumannya dipegang
 * sampai ada layar yang benar-benar mencetaknya (`hadiah_diumumkan`, hanya
 * dikonsumsi kalau pemanggil lewat `{ umumkan: true }`).
 *
 * @param {{umumkan?: boolean}} opts pemanggil yang PASTI mencetak `hadiahMusimLalu`
 * @returns {{musim:number, poin:number, tier:object, ..., hadiahMusimLalu:object|null}}
 */
export async function tcgGetRank(ownerJid, opts = {}) {
  const musim = tcgMusimSekarang();
  const umumkan = opts.umumkan === true;

  // --- 1. Bayar (jalur mana pun, sekali saja) ---
  const belumBayar = await getQuery(
    `SELECT musim, poin FROM tcg_rank
      WHERE owner_jid = ? AND musim < ? AND hadiah_diklaim = 0
      ORDER BY musim DESC LIMIT 1`,
    [ownerJid, musim.nomor]
  );

  if (belumBayar) {
    await withTransaction(async () => {
      const res = await runQuery(
        "UPDATE tcg_rank SET hadiah_diklaim = 1 WHERE owner_jid = ? AND musim = ? AND hadiah_diklaim = 0",
        [ownerJid, belumBayar.musim]
      );
      if (res.changes !== 1) return;

      const tier = tcgTier(belumBayar.poin);
      await bayarHadiah(
        ownerJid, TCG_HADIAH_MUSIM[tier.id] || {}, 'MUSIM_SELESAI', `musim${belumBayar.musim}`
      );

      // Gelar musiman: cuma untuk Diamond ke atas, supaya tetap berarti.
      if (['DIAMOND', 'MASTER', 'LEGENDA'].includes(tier.id)) {
        await runQuery(
          "INSERT OR IGNORE INTO tcg_gelar (owner_jid, gelar_id, nama) VALUES (?, ?, ?)",
          [ownerJid, `MUSIM${belumBayar.musim}_${tier.id}`, `${tier.emoji} ${tier.nama} Musim ${belumBayar.musim}`]
        );
      }

      // Baris musim baru dibuka dengan poin hasil reset lunak.
      const poinBaru = tcgResetLunak(belumBayar.poin);
      await runQuery(
        "INSERT OR IGNORE INTO tcg_rank (owner_jid, musim, poin, tertinggi) VALUES (?, ?, ?, ?)",
        [ownerJid, musim.nomor, poinBaru, poinBaru]
      );
    });
  }

  // --- 2. Umumkan (hanya dari layar yang benar-benar mencetaknya) ---
  let hadiahMusimLalu = null;
  if (umumkan) {
    const belumUmum = await getQuery(
      `SELECT musim, poin, menang, kalah, seri FROM tcg_rank
        WHERE owner_jid = ? AND musim < ? AND hadiah_diklaim = 1 AND hadiah_diumumkan = 0
        ORDER BY musim DESC LIMIT 1`,
      [ownerJid, musim.nomor]
    );
    if (belumUmum) {
      const res = await runQuery(
        `UPDATE tcg_rank SET hadiah_diumumkan = 1
          WHERE owner_jid = ? AND musim = ? AND hadiah_diumumkan = 0`,
        [ownerJid, belumUmum.musim]
      );
      if (res.changes === 1) {
        const tier = tcgTier(belumUmum.poin);
        const punyaGelar = ['DIAMOND', 'MASTER', 'LEGENDA'].includes(tier.id);
        hadiahMusimLalu = {
          musim: belumUmum.musim,
          poin: belumUmum.poin,
          tier,
          menang: belumUmum.menang,
          kalah: belumUmum.kalah,
          teks: ringkasHadiah(TCG_HADIAH_MUSIM[tier.id] || {}),
          gelar: punyaGelar ? `${tier.emoji} ${tier.nama} Musim ${belumUmum.musim}` : null,
          poinBaru: tcgResetLunak(belumUmum.poin)
        };
      }
    }
  }

  await runQuery(
    "INSERT OR IGNORE INTO tcg_rank (owner_jid, musim, poin, tertinggi) VALUES (?, ?, ?, ?)",
    [ownerJid, musim.nomor, TCG_POIN_AWAL, TCG_POIN_AWAL]
  );
  const r = await getQuery(
    "SELECT poin, tertinggi, menang, kalah, seri, beruntun FROM tcg_rank WHERE owner_jid = ? AND musim = ?",
    [ownerJid, musim.nomor]
  );

  const poin = r?.poin ?? TCG_POIN_AWAL;
  const main = (r?.menang || 0) + (r?.kalah || 0) + (r?.seri || 0);
  return {
    musim: musim.nomor,
    hariKe: musim.hariKe,
    sisaHari: musim.sisaHari,
    poin,
    tertinggi: r?.tertinggi ?? poin,
    menang: r?.menang || 0,
    kalah: r?.kalah || 0,
    seri: r?.seri || 0,
    beruntun: r?.beruntun || 0,
    main,
    winrate: main > 0 ? Math.round(((r?.menang || 0) / main) * 100) : 0,
    tier: tcgTier(poin),
    tierBerikutnya: tcgTierBerikutnya(poin),
    hadiahMusimLalu
  };
}

/** Peluang menang menurut Elo. Dipakai untuk besar perpindahan poin. */
function harapanElo(poinA, poinB) {
  return 1 / (1 + Math.pow(10, (poinB - poinA) / 400));
}

/**
 * Berapa laga berperingkat yang sudah terjadi antara dua orang hari ini.
 * Pasangan disimpan terurut supaya A-vs-B dan B-vs-A jadi satu baris.
 */
async function hitungPasangan(musim, a, b) {
  const [x, y] = [a, b].sort();
  const r = await getQuery(
    "SELECT jumlah FROM tcg_rank_pasangan WHERE musim = ? AND tanggal = ? AND a = ? AND b = ?",
    [musim, tcgTanggalHariIni(), x, y]
  );
  return r?.jumlah || 0;
}

async function catatPasangan(musim, a, b) {
  const [x, y] = [a, b].sort();
  await runQuery(
    `INSERT INTO tcg_rank_pasangan (musim, tanggal, a, b, jumlah) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(musim, tanggal, a, b) DO UPDATE SET jumlah = jumlah + 1`,
    [musim, tcgTanggalHariIni(), x, y]
  );
}

/**
 * Satu laga berperingkat.
 *
 * @param hasil  1 = `ownerJid` menang, 0 = kalah, 0.5 = seri
 * @param opts.k faktor K (duel vs sparring)
 * @param opts.lawanJid  kalau diisi, poin lawan ikut bergerak (duel PvP sungguhan)
 * @param opts.poinLawanTetap  rating acuan saat lawan tidak ikut bergerak (sparring)
 */
export async function tcgCatatLaga(ownerJid, hasil, opts = {}) {
  const musim = tcgMusimSekarang().nomor;
  const k = Math.max(1, Math.floor(Number(opts.k) || TCG_K_DUEL));
  const lawanJid = opts.lawanJid || null;

  await tcgGetRank(ownerJid);
  if (lawanJid) await tcgGetRank(lawanJid);

  if (lawanJid) {
    const sudah = await hitungPasangan(musim, ownerJid, lawanJid);
    if (sudah >= TCG_RANK_MAKS_PASANGAN) {
      return { berperingkat: false, reason: 'BATAS_PASANGAN', batas: TCG_RANK_MAKS_PASANGAN };
    }
  }

  return withTransaction(async () => {
    const a = await getQuery(
      "SELECT poin, tertinggi, beruntun FROM tcg_rank WHERE owner_jid = ? AND musim = ?",
      [ownerJid, musim]
    );
    const poinA = a?.poin ?? TCG_POIN_AWAL;

    // Sama seperti `tcgResetLunak`: rating acuan 0 itu sah dan tidak boleh
    // diam-diam naik jadi 1000 lewat `||`.
    const acuan = Number(opts.poinLawanTetap);
    let poinB = Math.max(0, Math.floor(Number.isFinite(acuan) ? acuan : TCG_POIN_AWAL));
    let b = null;
    if (lawanJid) {
      b = await getQuery(
        "SELECT poin, tertinggi, beruntun FROM tcg_rank WHERE owner_jid = ? AND musim = ?",
        [lawanJid, musim]
      );
      poinB = b?.poin ?? TCG_POIN_AWAL;
    }

    const harap = harapanElo(poinA, poinB);
    let delta = Math.round(k * (hasil - harap));
    // Menang wajib menambah, kalah wajib mengurangi. Tanpa lantai ini, menang
    // melawan pemain jauh di bawah menghasilkan 0 dan terasa seperti bug.
    if (hasil === 1 && delta < 1) delta = 1;
    if (hasil === 0 && delta > -1) delta = -1;

    const poinBaruA = Math.max(0, poinA + delta);
    const beruntunA = hasil === 1 ? (a?.beruntun || 0) + 1 : 0;
    await runQuery(
      `UPDATE tcg_rank
          SET poin = ?, tertinggi = MAX(tertinggi, ?), beruntun = ?,
              menang = menang + ?, kalah = kalah + ?, seri = seri + ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE owner_jid = ? AND musim = ?`,
      [
        poinBaruA, poinBaruA, beruntunA,
        hasil === 1 ? 1 : 0, hasil === 0 ? 1 : 0, hasil === 0.5 ? 1 : 0,
        ownerJid, musim
      ]
    );

    let deltaLawan = 0;
    let poinBaruB = poinB;
    if (lawanJid) {
      deltaLawan = -delta;
      poinBaruB = Math.max(0, poinB + deltaLawan);
      const hasilB = 1 - hasil;
      const beruntunB = hasilB === 1 ? (b?.beruntun || 0) + 1 : 0;
      await runQuery(
        `UPDATE tcg_rank
            SET poin = ?, tertinggi = MAX(tertinggi, ?), beruntun = ?,
                menang = menang + ?, kalah = kalah + ?, seri = seri + ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE owner_jid = ? AND musim = ?`,
        [
          poinBaruB, poinBaruB, beruntunB,
          hasilB === 1 ? 1 : 0, hasilB === 0 ? 1 : 0, hasilB === 0.5 ? 1 : 0,
          lawanJid, musim
        ]
      );
      await catatPasangan(musim, ownerJid, lawanJid);
    }

    return {
      berperingkat: true,
      musim,
      delta,
      poinLama: poinA,
      poin: poinBaruA,
      tierLama: tcgTier(poinA),
      tier: tcgTier(poinBaruA),
      naikTier: tcgTier(poinBaruA).min > tcgTier(poinA).min,
      turunTier: tcgTier(poinBaruA).min < tcgTier(poinA).min,
      beruntun: beruntunA,
      lawan: lawanJid ? { jid: lawanJid, delta: deltaLawan, poin: poinBaruB, tier: tcgTier(poinBaruB) } : null
    };
  });
}

/** Berapa sparring berperingkat yang sudah dipakai hari ini. */
export async function tcgSisaSparBerperingkat(ownerJid) {
  const musim = tcgMusimSekarang().nomor;
  const r = await getQuery(
    `SELECT SUM(jumlah) AS n FROM tcg_rank_pasangan
      WHERE musim = ? AND tanggal = ? AND (a = ? OR b = ?) AND (a = 'SPAR' OR b = 'SPAR')`,
    [musim, tcgTanggalHariIni(), ownerJid, ownerJid]
  );
  return Math.max(0, TCG_RANK_MAKS_SPAR - (r?.n || 0));
}

/** Menandai satu sparring berperingkat terpakai. Kunci 'SPAR' sengaja bukan JID. */
export async function tcgPakaiSparBerperingkat(ownerJid) {
  const musim = tcgMusimSekarang().nomor;
  await catatPasangan(musim, ownerJid, 'SPAR');
}

export async function getTcgRankLeaderboard(limit = 10) {
  const n = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 10));
  const musim = tcgMusimSekarang().nomor;
  return await allQuery(
    `SELECT r.owner_jid AS customer_jid, r.poin, r.menang, r.kalah, r.seri, r.beruntun,
            p.nama AS customer_nama
       FROM tcg_rank r
       LEFT JOIN tcg_profil p ON p.owner_jid = r.owner_jid
      WHERE r.musim = ? AND (r.menang + r.kalah + r.seri) > 0
      ORDER BY r.poin DESC, r.menang DESC
      LIMIT ?`,
    [musim, n]
  );
}

// ============================================================
// 4. GELAR
// ============================================================

/**
 * Gelar permanen. `syarat(s)` menerima potret statistik dari `tcgPotretPemain`.
 *
 * Semuanya dinilai ulang tiap kali `.tcg gelar` dibuka — tidak ada pemicu yang
 * tersebar di seluruh kode, jadi tidak ada gelar yang bisa "terlewat" karena
 * satu jalur lupa memanggil pencatat.
 */
export const TCG_GELAR = [
  { id: 'PEMULA',      nama: '🌱 Perekrut Muda',     syarat: s => s.unik >= 5,        petunjuk: 'Punya 5 jenis kartu' },
  { id: 'KOLEKTOR',    nama: '📚 Kolektor',          syarat: s => s.unik >= 20,       petunjuk: 'Punya 20 jenis kartu' },
  { id: 'KURATOR',     nama: '🏛️ Kurator Nusantara', syarat: s => s.unik >= 40,       petunjuk: 'Punya 40 jenis kartu' },
  { id: 'PELENGKAP',   nama: '👑 Sang Pelengkap',    syarat: s => s.unik >= s.totalKartu, petunjuk: 'Punya SEMUA jenis kartu' },
  { id: 'PENDAKI',     nama: '🧗 Pendaki',           syarat: s => s.lantai >= 10,     petunjuk: 'Taklukkan lantai 10 Menara' },
  { id: 'PENAKLUK',    nama: '🏰 Penakluk Menara',   syarat: s => s.lantai >= 30,     petunjuk: 'Taklukkan lantai 30 Menara' },
  { id: 'PENEMBUS',    nama: '🌌 Penembus Kabut',    syarat: s => s.abadi >= 10,      petunjuk: 'Tembus lantai 10 Menara Abadi' },
  { id: 'PENJELAJAH',  nama: '🕳️ Penjelajah Void',   syarat: s => s.abadi >= 25,      petunjuk: 'Tembus lantai 25 Menara Abadi' },
  { id: 'RAJIN',       nama: '📅 Rajin Absen',       syarat: s => s.streakTerpanjang >= 7,   petunjuk: 'Beruntun harian 7 hari' },
  { id: 'SETIA',       nama: '🔥 Tak Pernah Absen',  syarat: s => s.streakTerpanjang >= 30,  petunjuk: 'Beruntun harian 30 hari' },
  { id: 'ABADI_HADIR', nama: '💯 Seratus Hari',      syarat: s => s.streakTerpanjang >= 100, petunjuk: 'Beruntun harian 100 hari' },
  { id: 'PEMBURU',     nama: '🌟 Pemburu Mitos',     syarat: s => s.mythic >= 1,      petunjuk: 'Miliki 1 kartu MYTHIC' },
  { id: 'RAJA_MITOS',  nama: '☄️ Raja Mitos',        syarat: s => s.mythic >= 5,      petunjuk: 'Miliki 5 jenis kartu MYTHIC' },
  { id: 'PANDAI_BESI', nama: '🔨 Pandai Besi',       syarat: s => s.levelMaks >= 3,   petunjuk: 'Punya 3 kartu di level 5' },
  { id: 'DUELIS',      nama: '⚔️ Duelis Ulung',      syarat: s => s.rankTertinggi >= 1300, petunjuk: 'Capai peringkat Platina' },
  { id: 'LEGENDA',     nama: '🔱 Legenda Arena',     syarat: s => s.rankTertinggi >= 1800, petunjuk: 'Capai peringkat Legenda' },
  { id: 'PEDAGANG',    nama: '🤝 Pedagang Ulung',    syarat: s => s.barter >= 10,     petunjuk: 'Selesaikan 10 barter' }
];

export function getGelarDef(id) {
  return TCG_GELAR.find(g => g.id === id) || null;
}

/**
 * Potret statistik pemain, satu tempat, dipakai gelar dan `.tcg cek`.
 * `totalKartu` dikirim dari pemanggil supaya lapisan database tidak perlu
 * mengimpor katalog kartu.
 */
export async function tcgPotretPemain(ownerJid, totalKartu = 0) {
  const [koleksi, mythic, lv5, tower, abadi, streak, rank, barter] = await Promise.all([
    getQuery("SELECT COUNT(*) AS unik, SUM(qty) AS total FROM tcg_collection WHERE owner_jid = ? AND qty > 0", [ownerJid]),
    getQuery("SELECT COUNT(*) AS n FROM tcg_collection WHERE owner_jid = ? AND qty > 0 AND card_id LIKE 'MYT%'", [ownerJid]),
    getQuery("SELECT COUNT(*) AS n FROM tcg_collection WHERE owner_jid = ? AND qty > 0 AND card_lv >= 5", [ownerJid]),
    getQuery("SELECT highest_floor FROM tcg_tower WHERE owner_jid = ?", [ownerJid]),
    getQuery("SELECT lantai FROM tcg_abadi WHERE owner_jid = ?", [ownerJid]),
    getQuery("SELECT terpanjang FROM tcg_streak WHERE owner_jid = ?", [ownerJid]),
    getQuery("SELECT MAX(tertinggi) AS t FROM tcg_rank WHERE owner_jid = ?", [ownerJid]),
    getQuery("SELECT COUNT(*) AS n FROM tcg_barter_log WHERE a_jid = ? OR b_jid = ?", [ownerJid, ownerJid])
  ]);

  return {
    unik: koleksi?.unik || 0,
    totalKoleksi: koleksi?.total || 0,
    totalKartu,
    mythic: mythic?.n || 0,
    levelMaks: lv5?.n || 0,
    lantai: tower?.highest_floor || 0,
    abadi: abadi?.lantai || 0,
    streakTerpanjang: streak?.terpanjang || 0,
    rankTertinggi: rank?.t || 0,
    barter: barter?.n || 0
  };
}

/**
 * Menilai ulang semua gelar dan menyimpan yang baru terbuka.
 * @returns {{semua:Array, baru:Array, aktif:string|null}}
 */
export async function tcgPeriksaGelar(ownerJid, totalKartu = 0) {
  const potret = await tcgPotretPemain(ownerJid, totalKartu);
  const punya = await allQuery("SELECT gelar_id, nama FROM tcg_gelar WHERE owner_jid = ?", [ownerJid]);
  const petaPunya = new Map(punya.map(g => [g.gelar_id, g.nama]));

  const baru = [];
  for (const g of TCG_GELAR) {
    if (petaPunya.has(g.id)) continue;
    let lolos = false;
    try { lolos = !!g.syarat(potret); } catch (e) { lolos = false; }
    if (!lolos) continue;
    await runQuery(
      "INSERT OR IGNORE INTO tcg_gelar (owner_jid, gelar_id, nama) VALUES (?, ?, ?)",
      [ownerJid, g.id, g.nama]
    );
    petaPunya.set(g.id, g.nama);
    baru.push(g);
  }

  const profil = await getQuery("SELECT gelar_aktif FROM tcg_profil WHERE owner_jid = ?", [ownerJid]);

  const semua = [
    ...TCG_GELAR.map(g => ({ ...g, punya: petaPunya.has(g.id), musiman: false })),
    // Gelar musiman tidak ada di katalog statis — namanya disimpan di baris.
    ...punya
      .filter(g => !getGelarDef(g.gelar_id))
      .map(g => ({ id: g.gelar_id, nama: g.nama || g.gelar_id, punya: true, musiman: true, petunjuk: 'Hadiah akhir musim' }))
  ];

  return { semua, baru, aktif: profil?.gelar_aktif || null, potret };
}

/** Nama gelar yang sedang dipajang, atau null. Murah — dipanggil di banyak layar. */
export async function tcgGelarAktif(ownerJid) {
  const r = await getQuery("SELECT gelar_aktif FROM tcg_profil WHERE owner_jid = ?", [ownerJid]);
  if (!r?.gelar_aktif) return null;
  const def = getGelarDef(r.gelar_aktif);
  if (def) return def.nama;
  const baris = await getQuery(
    "SELECT nama FROM tcg_gelar WHERE owner_jid = ? AND gelar_id = ?",
    [ownerJid, r.gelar_aktif]
  );
  return baris?.nama || null;
}

export async function tcgPasangGelar(ownerJid, gelarId) {
  const id = String(gelarId || '').toUpperCase();
  await runQuery("INSERT OR IGNORE INTO tcg_profil (owner_jid) VALUES (?)", [ownerJid]);

  if (!id || id === 'LEPAS' || id === 'NONE') {
    await runQuery("UPDATE tcg_profil SET gelar_aktif = NULL WHERE owner_jid = ?", [ownerJid]);
    return { success: true, dilepas: true };
  }

  const baris = await getQuery(
    "SELECT gelar_id, nama FROM tcg_gelar WHERE owner_jid = ? AND gelar_id = ?",
    [ownerJid, id]
  );
  if (!baris) return { success: false, reason: 'BELUM_PUNYA' };

  await runQuery("UPDATE tcg_profil SET gelar_aktif = ? WHERE owner_jid = ?", [id, ownerJid]);
  return { success: true, nama: baris.nama || getGelarDef(id)?.nama || id };
}

// ============================================================
// 5. TONGGAK KOLEKSI
// ============================================================

/**
 * Hadiah sekali-seumur-hidup untuk jumlah jenis kartu.
 *
 * Gacha memberi kejutan tapi tidak memberi arah. Tonggak memberi angka yang
 * bisa dikejar: "tinggal 3 jenis lagi" adalah kalimat yang membuat orang
 * menarik satu kali lagi besok.
 */
export const TCG_TONGGAK_KOLEKSI = [
  { id: 'K10', unik: 10, keping: 150, item: [{ id: 'RANSUM_MENARA', jumlah: 1 }] },
  { id: 'K20', unik: 20, keping: 300, serpihan: [{ rarity: 'RARE', jumlah: 4 }] },
  { id: 'K30', unik: 30, keping: 500, serpihan: [{ rarity: 'EPIC', jumlah: 3 }], item: [{ id: 'RANSUM_AGUNG', jumlah: 1 }] },
  { id: 'K40', unik: 40, keping: 800, serpihan: [{ rarity: 'EPIC', jumlah: 5 }] },
  { id: 'K50', unik: 50, keping: 1200, serpihan: [{ rarity: 'LEGENDARY', jumlah: 4 }], item: [{ id: 'RANSUM_AGUNG', jumlah: 2 }] },
  { id: 'K60', unik: 60, keping: 2500, serpihan: [{ rarity: 'MYTHIC', jumlah: 3 }], item: [{ id: 'RANSUM_AGUNG', jumlah: 3 }] }
];

export async function tcgGetTonggak(ownerJid) {
  const koleksi = await getQuery(
    "SELECT COUNT(*) AS unik FROM tcg_collection WHERE owner_jid = ? AND qty > 0",
    [ownerJid]
  );
  const unik = koleksi?.unik || 0;
  const sudah = await allQuery("SELECT tonggak_id FROM tcg_tonggak WHERE owner_jid = ?", [ownerJid]);
  const set = new Set(sudah.map(r => r.tonggak_id));

  const daftar = TCG_TONGGAK_KOLEKSI.map(t => ({
    ...t,
    tercapai: unik >= t.unik,
    diklaim: set.has(t.id)
  }));
  return {
    unik,
    daftar,
    adaKlaim: daftar.some(t => t.tercapai && !t.diklaim),
    berikutnya: daftar.find(t => !t.tercapai) || null
  };
}

export async function tcgKlaimTonggak(ownerJid) {
  const status = await tcgGetTonggak(ownerJid);
  if (!status.adaKlaim) return { success: false, reason: 'TIDAK_ADA', unik: status.unik };

  return withTransaction(async () => {
    const rincian = [];
    let totalKeping = 0;
    for (const t of status.daftar) {
      if (!t.tercapai || t.diklaim) continue;
      const res = await runQuery(
        "INSERT OR IGNORE INTO tcg_tonggak (owner_jid, tonggak_id) VALUES (?, ?)",
        [ownerJid, t.id]
      );
      if (!res.changes) continue;
      const bayar = await bayarHadiah(ownerJid, t, 'TONGGAK_KOLEKSI', t.id);
      totalKeping += bayar.keping;
      rincian.push({ unik: t.unik, teks: bayar.teks });
    }
    if (!rincian.length) return { success: false, reason: 'TIDAK_ADA', unik: status.unik };
    const w = await getQuery("SELECT keping FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
    return { success: true, rincian, totalKeping, kepingTotal: w?.keping || 0, unik: status.unik };
  });
}

// ============================================================
// 6. MENARA ABADI
// ============================================================

/**
 * Hadiah Keping Menara Abadi sengaja DIBATASI ATAS.
 *
 * Lantai tidak punya ujung, jadi hadiah yang tumbuh linear akan jadi keran
 * Keping tak terbatas begitu ada satu pemain yang cukup kuat. Yang tumbuh tanpa
 * batas di sini adalah angka lantainya — itu yang dipajang di papan peringkat,
 * dan itu yang sebenarnya dikejar orang.
 */
export const TCG_ABADI_KEPING_DASAR = 70;
export const TCG_ABADI_KEPING_PER_LANTAI = 5;
export const TCG_ABADI_KEPING_MAKS = 220;

export function tcgHadiahAbadi(lantai) {
  const n = Math.max(1, Math.floor(Number(lantai) || 1));
  const keping = Math.min(
    TCG_ABADI_KEPING_MAKS,
    TCG_ABADI_KEPING_DASAR + n * TCG_ABADI_KEPING_PER_LANTAI
  );
  const serpihan = [];
  if (n % 10 === 0) serpihan.push({ rarity: 'MYTHIC', jumlah: 1 });
  else if (n % 5 === 0) serpihan.push({ rarity: 'LEGENDARY', jumlah: 2 });
  else if (n % 2 === 0) serpihan.push({ rarity: 'EPIC', jumlah: 2 });
  return { keping, serpihan };
}

export async function tcgGetAbadi(ownerJid) {
  await runQuery("INSERT OR IGNORE INTO tcg_abadi (owner_jid) VALUES (?)", [ownerJid]);
  const r = await getQuery("SELECT lantai, percobaan FROM tcg_abadi WHERE owner_jid = ?", [ownerJid]);
  const lantai = r?.lantai || 0;
  return { lantai, percobaan: r?.percobaan || 0, berikutnya: lantai + 1 };
}

export async function tcgMajuAbadi(ownerJid, lantai) {
  const n = Math.max(1, Math.floor(Number(lantai) || 1));
  const hadiah = tcgHadiahAbadi(n);
  return withTransaction(async () => {
    const res = await runQuery(
      "UPDATE tcg_abadi SET lantai = ?, percobaan = percobaan + 1, updated_at = CURRENT_TIMESTAMP WHERE owner_jid = ? AND lantai = ?",
      [n, ownerJid, n - 1]
    );
    if (res.changes !== 1) return { success: false, reason: 'LANTAI_TIDAK_COCOK' };
    const bayar = await bayarHadiah(ownerJid, hadiah, 'ABADI', `lantai${n}`);
    const w = await getQuery("SELECT keping FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
    return { success: true, lantai: n, hadiah, teks: bayar.teks, kepingTotal: w?.keping || 0 };
  });
}

export async function tcgCatatGagalAbadi(ownerJid) {
  await runQuery(
    "UPDATE tcg_abadi SET percobaan = percobaan + 1, updated_at = CURRENT_TIMESTAMP WHERE owner_jid = ?",
    [ownerJid]
  );
}

export async function getTcgAbadiLeaderboard(limit = 10) {
  const n = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 10));
  return await allQuery(
    `SELECT a.owner_jid AS customer_jid, a.lantai, a.percobaan, p.nama AS customer_nama
       FROM tcg_abadi a
       LEFT JOIN tcg_profil p ON p.owner_jid = a.owner_jid
      WHERE a.lantai > 0
      ORDER BY a.lantai DESC, a.percobaan ASC
      LIMIT ?`,
    [n]
  );
}

// ============================================================
// 7. BARTER DUPLIKAT
// ============================================================

/**
 * Barter mengikuti aturan yang sama dengan `.tcg jual` dan `.tcg serpih`:
 * HANYA duplikat yang boleh berpindah (`qty > 1`).
 *
 * Itu bukan sekadar konsistensi. Aturan ini membuat barter tidak bisa dipakai
 * untuk mengosongkan koleksi ke akun lain, tidak pernah merusak dek yang sedang
 * terpasang, dan mengubah duplikat — yang selama ini hanya bisa dijual atau
 * dileburkan — menjadi alasan untuk bicara dengan orang lain di grup.
 */
export const TCG_BARTER_KUOTA_HARIAN = 3;

export async function tcgSisaKuotaBarter(ownerJid) {
  const hariIni = tcgTanggalHariIni();
  const r = await getQuery(
    "SELECT jumlah FROM tcg_barter_kuota WHERE owner_jid = ? AND tanggal = ?",
    [ownerJid, hariIni]
  );
  return Math.max(0, TCG_BARTER_KUOTA_HARIAN - (r?.jumlah || 0));
}

/** Duplikat yang boleh dibarterkan: qty > 1. */
export async function tcgPunyaDuplikat(ownerJid, cardId) {
  const r = await getQuery(
    "SELECT qty, card_lv FROM tcg_collection WHERE owner_jid = ? AND card_id = ?",
    [ownerJid, cardId]
  );
  return { qty: r?.qty || 0, level: r?.card_lv || 1, bisa: (r?.qty || 0) > 1 };
}

/**
 * Menukar satu duplikat milik A dengan satu duplikat milik B, atomik.
 *
 * Level TIDAK ikut pindah: level adalah investasi serpihan milik pemiliknya,
 * dan memindahkannya akan membuat barter jadi jalur pintas untuk memindahkan
 * hasil grinding, bukan sekadar kartunya.
 */
export async function tcgTukarKartu(aJid, kartuA, bJid, kartuB) {
  const hariIni = tcgTanggalHariIni();

  return withTransaction(async () => {
    for (const [jid, kartu] of [[aJid, kartuA], [bJid, kartuB]]) {
      const deckRows = await allQuery(
        "SELECT slot FROM tcg_deck WHERE owner_jid = ? AND card_id = ?",
        [jid, kartu]
      );
      const ekspedisiRows = await allQuery(
        "SELECT slot FROM tcg_ekspedisi WHERE owner_jid = ? AND card_id = ?",
        [jid, kartu]
      );
      const inUse = (deckRows?.length || 0) + (ekspedisiRows?.length || 0);
      const minSisa = Math.max(1, inUse);

      const res = await runQuery(
        "UPDATE tcg_collection SET qty = qty - 1 WHERE owner_jid = ? AND card_id = ? AND (qty - 1) >= ?",
        [jid, kartu, minSisa]
      );
      if (res.changes !== 1) {
        return { success: false, reason: 'DUPLIKAT_HABIS', jid, kartu, terpakai: inUse };
      }
    }

    for (const [jid, kartu] of [[aJid, kartuB], [bJid, kartuA]]) {
      await runQuery(
        `INSERT INTO tcg_collection (owner_jid, card_id, qty) VALUES (?, ?, 1)
           ON CONFLICT(owner_jid, card_id) DO UPDATE SET qty = qty + 1`,
        [jid, kartu]
      );
    }

    for (const jid of [aJid, bJid]) {
      await runQuery(
        `INSERT INTO tcg_barter_kuota (owner_jid, tanggal, jumlah) VALUES (?, ?, 1)
           ON CONFLICT(owner_jid, tanggal) DO UPDATE SET jumlah = jumlah + 1`,
        [jid, hariIni]
      );
    }

    await runQuery(
      "INSERT INTO tcg_barter_log (a_jid, b_jid, kartu_a, kartu_b, tanggal) VALUES (?, ?, ?, ?, ?)",
      [aJid, bJid, kartuA, kartuB, hariIni]
    );

    return { success: true };
  });
}

export async function tcgRiwayatBarter(ownerJid, limit = 10) {
  const n = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
  return await allQuery(
    `SELECT a_jid, b_jid, kartu_a, kartu_b, created_at
       FROM tcg_barter_log
      WHERE a_jid = ? OR b_jid = ?
      ORDER BY id DESC LIMIT ?`,
    [ownerJid, ownerJid, n]
  );
}
