/**
 * TCG ARENA — LAPISAN DATABASE TANTANGAN (GAUNTLET & BOS GRUP)
 *
 * Dua mode yang lahir dari satu keluhan yang sama: arena ini terlalu mudah
 * sesudah `.tcg autodek` menyelesaikan penyusunan dek secara matematis.
 *
 *   GAUNTLET — tiga pertarungan berurutan dalam satu pekan, kartu yang sudah
 *   bertarung tidak boleh dipakai lagi. Ini satu-satunya konten yang menuntut
 *   sembilan kartu terawat, bukan tiga.
 *
 *   BOS GRUP — satu kantong HP milik grup yang cuma tumbang kalau cukup banyak
 *   orang ikut memukul. Satu-satunya konten arena yang hasilnya ditentukan
 *   bersama; semua yang lain bisa dimainkan sendirian.
 *
 * Berkas ini sengaja dipisah dari `tcgDb.js` (ekonomi) dan `tcgMetaDb.js`
 * (retensi) dengan aturan impor searah yang sama: berkas ini boleh mengimpor
 * keduanya, keduanya TIDAK BOLEH mengimpor berkas ini. Di ESM, siklus impor
 * muncul sebagai `undefined` yang diam, bukan sebagai error.
 */

import { runQuery, getQuery, allQuery, withTransaction } from './connection.js';
import { tcgTanggalHariIni } from './tcgDb.js';
import { tcgSeninMinggu } from './tcgMetaDb.js';

// ============================================================
// TETAPAN
// ============================================================

/**
 * Percobaan Gauntlet per pekan. Kalah TIDAK mengunci kartu — kalau kalah pun
 * mengunci, satu kekalahan di tahap 1 bisa membuat sisa pekan mustahil
 * diselesaikan dan pemain berhenti mencoba sama sekali. Yang dijatah adalah
 * jumlah percobaannya, bukan hukuman atas kekalahannya.
 */
export const TCG_GAUNTLET_PERCOBAAN = 5;

export const TCG_GAUNTLET_HADIAH = [
  { keping: 150, serpihan: [{ rarity: 'RARE', jumlah: 3 }] },
  { keping: 300, serpihan: [{ rarity: 'EPIC', jumlah: 3 }] },
  { keping: 700, serpihan: [{ rarity: 'LEGENDARY', jumlah: 3 }] }
];

/** Bonus tuntas 3 tahap — dibayar sekali, di atas hadiah tahap ketiga. */
export const TCG_GAUNTLET_BONUS_TUNTAS = 500;

/**
 * Sisa hari pekan (1-7) terhitung hari ini, dari kunci pekan (tanggal Senin).
 * Dipakai untuk menakar HP yang dibawa penantang baru.
 */
export function tcgSisaHariPekan(minggu) {
  const senin = new Date(`${minggu}T00:00:00Z`).getTime();
  const kini = new Date(`${tcgTanggalHariIni()}T00:00:00Z`).getTime();
  if (!Number.isFinite(senin) || !Number.isFinite(kini)) return 7;
  const lewat = Math.floor((kini - senin) / 86400000);
  return Math.max(1, Math.min(7, 7 - lewat));
}

/**
 * HP bos tumbuh mengikuti jumlah penantang, bukan angka mati.
 *
 * Angka mati punya dua kegagalan sekaligus: di grup sepi bosnya tidak pernah
 * bisa tumbang (percuma dipasang), di grup ramai bosnya tumbang di hari pertama
 * (percuma dipasang juga). Menambah HP saat penantang BARU muncul membuat
 * keduanya masuk akal — dan penambahannya masuk ke HP sisa sekaligus HP maks,
 * jadi damage yang sudah disetor tidak pernah hangus.
 *
 * TAKARANNYA SEBANDING SISA PEKAN (lihat tcgSerangBos). Angka penuh untuk semua
 * orang terbukti merusak: yang bergabung hari Minggu hanya punya 3 serangan
 * tersisa dan harus menyetor 10.000 damage per serangan sekadar untuk membayar
 * HP yang ia bawa — di atas plafon dek terkuat. Dengan penakaran ini, titik
 * impas seorang penantang tetap ~1.429 damage/serangan kapan pun ia bergabung,
 * dan itu di bawah dek Common sekalipun (~2.010).
 *
 * Kalibrasi: satu serangan bernilai ~2.010 damage (dek Common Lv.1) sampai
 * ~6.900 (dek 10 bintang Lv.5 yang meng-counter elemen bos), jatah 3/hari.
 */
export const TCG_BOS_HP_DASAR = 60000;
export const TCG_BOS_HP_PER_PENANTANG = 30000;
export const TCG_BOS_JATAH_HARIAN = 3;

export const TCG_BOS_HADIAH_DASAR = 1500;
export const TCG_BOS_HADIAH_PER_PENANTANG = 800;
export const TCG_BOS_HADIAH_MIN = 100;
export const TCG_BOS_BONUS_PUNCAK = 500;

// ============================================================
// SKEMA
// ============================================================

export async function initTcgTantanganSchema() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_gauntlet (
      owner_jid      TEXT NOT NULL,
      minggu         TEXT NOT NULL,
      tahap          INTEGER NOT NULL DEFAULT 0 CHECK(tahap >= 0),
      percobaan      INTEGER NOT NULL DEFAULT 0 CHECK(percobaan >= 0),
      kartu_terpakai TEXT NOT NULL DEFAULT '[]',
      tuntas_at      DATETIME,
      updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (owner_jid, minggu)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_bos (
      grup_jid   TEXT NOT NULL,
      minggu     TEXT NOT NULL,
      nama       TEXT NOT NULL,
      elemen     TEXT NOT NULL,
      hp         INTEGER NOT NULL,
      hp_maks    INTEGER NOT NULL,
      status     TEXT NOT NULL DEFAULT 'HIDUP',
      hadiah_dibagi INTEGER NOT NULL DEFAULT 0,
      mulai_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      tumbang_at DATETIME,
      PRIMARY KEY (grup_jid, minggu)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_bos_kontribusi (
      grup_jid  TEXT NOT NULL,
      minggu    TEXT NOT NULL,
      owner_jid TEXT NOT NULL,
      damage    INTEGER NOT NULL DEFAULT 0,
      serangan  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (grup_jid, minggu, owner_jid)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS tcg_bos_jatah (
      owner_jid TEXT NOT NULL,
      tanggal   TEXT NOT NULL,
      dipakai   INTEGER NOT NULL DEFAULT 0 CHECK(dipakai >= 0),
      PRIMARY KEY (owner_jid, tanggal)
    )
  `);

  await runQuery("CREATE INDEX IF NOT EXISTS idx_bos_kontrib ON tcg_bos_kontribusi(grup_jid, minggu, damage DESC)");
}

// ============================================================
// PEMBAYAR HADIAH BERSAMA
// ============================================================

/**
 * Menambah Keping + serpihan dalam satu tempat.
 *
 * Sengaja ditulis ulang di sini alih-alih memanggil helper `tcgDb.js`: dua mode
 * di berkas ini membayar di TENGAH transaksi yang lebih besar (kemenangan
 * Gauntlet, tumbangnya bos), dan helper di sana membuka transaksinya sendiri.
 * Transaksi bersarang di sqlite3 bukan hal yang bisa diandalkan.
 */
async function bayarHadiah(ownerJid, keping = 0, serpihan = [], sumber = 'TANTANGAN', ref = '') {
  if (keping > 0) {
    await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [ownerJid]);
    await runQuery("UPDATE tcg_wallet SET keping = keping + ? WHERE owner_jid = ?", [keping, ownerJid]);
    await runQuery(
      "INSERT INTO tcg_ledger (owner_jid, delta, sumber, ref) VALUES (?, ?, ?, ?)",
      [ownerJid, keping, sumber, ref]
    );
  }
  for (const s of serpihan || []) {
    if (!s?.rarity || !(s.jumlah > 0)) continue;
    await runQuery(
      `INSERT INTO tcg_shards (owner_jid, rarity, jumlah) VALUES (?, ?, ?)
         ON CONFLICT(owner_jid, rarity) DO UPDATE SET jumlah = jumlah + ?`,
      [ownerJid, s.rarity, s.jumlah, s.jumlah]
    );
  }
}

// ============================================================
// GAUNTLET PEKANAN
// ============================================================

/** Kunci pekan (tanggal Senin WIB). Dipakai Gauntlet maupun bos grup. */
export function tcgKunciPekan() {
  return tcgSeninMinggu(tcgTanggalHariIni());
}

/**
 * Status Gauntlet pemain untuk pekan berjalan. Baris pekan lama sengaja tidak
 * dihapus — riwayatnya murah disimpan dan berguna kalau nanti ada papan
 * peringkat "berapa pekan tuntas berturut-turut".
 */
export async function tcgGetGauntlet(ownerJid) {
  const minggu = tcgKunciPekan();
  await runQuery(
    "INSERT OR IGNORE INTO tcg_gauntlet (owner_jid, minggu, tahap, percobaan) VALUES (?, ?, 0, 0)",
    [ownerJid, minggu]
  );
  const row = await getQuery(
    "SELECT * FROM tcg_gauntlet WHERE owner_jid = ? AND minggu = ?",
    [ownerJid, minggu]
  );

  let kartuTerpakai = [];
  try { kartuTerpakai = JSON.parse(row?.kartu_terpakai || '[]'); } catch { kartuTerpakai = []; }

  const tahap = Math.max(0, Number(row?.tahap) || 0);
  const percobaan = Math.max(0, Number(row?.percobaan) || 0);

  return {
    minggu,
    tahap,
    berikutnya: tahap + 1,
    tuntas: tahap >= TCG_GAUNTLET_HADIAH.length,
    percobaanTerpakai: percobaan,
    sisaPercobaan: Math.max(0, TCG_GAUNTLET_PERCOBAAN - percobaan),
    kartuTerpakai
  };
}

/** Satu percobaan terpakai, apa pun hasilnya. Dipanggil sebelum simulasi. */
export async function tcgPakaiPercobaanGauntlet(ownerJid) {
  const minggu = tcgKunciPekan();
  const res = await runQuery(
    `UPDATE tcg_gauntlet SET percobaan = percobaan + 1, updated_at = CURRENT_TIMESTAMP
       WHERE owner_jid = ? AND minggu = ? AND percobaan < ?`,
    [ownerJid, minggu, TCG_GAUNTLET_PERCOBAAN]
  );
  if (res.changes !== 1) return { success: false, reason: 'PERCOBAAN_HABIS' };
  const row = await getQuery(
    "SELECT percobaan FROM tcg_gauntlet WHERE owner_jid = ? AND minggu = ?",
    [ownerJid, minggu]
  );
  const dipakai = Number(row?.percobaan) || 0;
  return { success: true, sisa: Math.max(0, TCG_GAUNTLET_PERCOBAAN - dipakai) };
}

/**
 * Mencatat kemenangan satu tahap: kunci kartu yang dipakai, naikkan tahap,
 * bayar hadiahnya.
 *
 * `tahapDiharapkan` wajib dikirim pemanggil dan dicocokkan di dalam transaksi.
 * Tanpa itu, dua pesan `.tcg gauntlet lawan` yang datang beruntun bisa
 * dua-duanya membaca tahap 1 lalu dua-duanya membayar hadiah tahap 1.
 */
export async function tcgMenangGauntlet(ownerJid, tahapDiharapkan, kartuIds = []) {
  const minggu = tcgKunciPekan();

  return withTransaction(async () => {
    const row = await getQuery(
      "SELECT * FROM tcg_gauntlet WHERE owner_jid = ? AND minggu = ?",
      [ownerJid, minggu]
    );
    const tahapSekarang = Math.max(0, Number(row?.tahap) || 0);
    if (tahapSekarang + 1 !== Number(tahapDiharapkan)) {
      return { success: false, reason: 'TAHAP_BERUBAH', tahap: tahapSekarang };
    }

    let terpakai = [];
    try { terpakai = JSON.parse(row?.kartu_terpakai || '[]'); } catch { terpakai = []; }
    const gabungan = [...new Set([...terpakai, ...kartuIds])];

    const tahapBaru = tahapSekarang + 1;
    const tuntas = tahapBaru >= TCG_GAUNTLET_HADIAH.length;

    await runQuery(
      `UPDATE tcg_gauntlet
          SET tahap = ?, kartu_terpakai = ?, tuntas_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE owner_jid = ? AND minggu = ?`,
      [tahapBaru, JSON.stringify(gabungan), tuntas ? new Date().toISOString() : null, ownerJid, minggu]
    );

    const hadiah = TCG_GAUNTLET_HADIAH[tahapBaru - 1] || { keping: 0, serpihan: [] };
    const keping = hadiah.keping + (tuntas ? TCG_GAUNTLET_BONUS_TUNTAS : 0);
    await bayarHadiah(ownerJid, keping, hadiah.serpihan, 'GAUNTLET', `${minggu}_T${tahapBaru}`);

    const w = await getQuery("SELECT keping FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);

    return {
      success: true,
      tahap: tahapBaru,
      tuntas,
      keping,
      bonusTuntas: tuntas ? TCG_GAUNTLET_BONUS_TUNTAS : 0,
      serpihan: hadiah.serpihan,
      kartuTerpakai: gabungan,
      sisaKeping: w?.keping || 0
    };
  });
}

// ============================================================
// BOS ARENA GRUP
// ============================================================

/**
 * Ambil bos pekan ini untuk satu grup, buat kalau belum ada.
 *
 * Nama dan elemen bos DIKIRIM pemanggil, tidak dihitung di sini. Berkas ini
 * lapisan data; menaruh generator nama di sini berarti aturan permainan
 * tersebar di dua tempat dan cepat atau lambat keduanya akan beda.
 */
export async function tcgGetBos(grupJid, info = {}) {
  const minggu = tcgKunciPekan();
  const ada = await getQuery(
    "SELECT * FROM tcg_bos WHERE grup_jid = ? AND minggu = ?",
    [grupJid, minggu]
  );

  if (!ada) {
    if (!info?.nama || !info?.elemen) return null;
    await runQuery(
      `INSERT OR IGNORE INTO tcg_bos (grup_jid, minggu, nama, elemen, hp, hp_maks)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [grupJid, minggu, info.nama, info.elemen, TCG_BOS_HP_DASAR, TCG_BOS_HP_DASAR]
    );
  }

  const bos = await getQuery(
    "SELECT * FROM tcg_bos WHERE grup_jid = ? AND minggu = ?",
    [grupJid, minggu]
  );
  const stat = await getQuery(
    "SELECT COUNT(*) AS penantang, COALESCE(SUM(serangan), 0) AS serangan FROM tcg_bos_kontribusi WHERE grup_jid = ? AND minggu = ?",
    [grupJid, minggu]
  );

  return {
    ...bos,
    minggu,
    hidup: bos?.status === 'HIDUP',
    penantang: Number(stat?.penantang) || 0,
    totalSerangan: Number(stat?.serangan) || 0
  };
}

/** Sisa jatah serangan bos hari ini. Jatah bersifat per pemain, bukan per grup. */
export async function tcgSisaJatahBos(ownerJid) {
  const tanggal = tcgTanggalHariIni();
  const row = await getQuery(
    "SELECT dipakai FROM tcg_bos_jatah WHERE owner_jid = ? AND tanggal = ?",
    [ownerJid, tanggal]
  );
  const dipakai = Number(row?.dipakai) || 0;
  return { dipakai, sisa: Math.max(0, TCG_BOS_JATAH_HARIAN - dipakai) };
}

/**
 * Serangan ke bos, seluruhnya dalam satu transaksi.
 *
 * Jatah harian dipotong DI DALAM transaksi yang sama dengan pengurangan HP.
 * Kalau dipisah, dua serangan yang datang hampir bersamaan bisa dua-duanya
 * lolos pemeriksaan jatah sebelum salah satunya sempat menuliskan pemakaian.
 */
export async function tcgSerangBos(grupJid, ownerJid, damage) {
  const minggu = tcgKunciPekan();
  const tanggal = tcgTanggalHariIni();
  const dmg = Math.max(1, Math.floor(Number(damage) || 0));

  return withTransaction(async () => {
    const bos = await getQuery(
      "SELECT * FROM tcg_bos WHERE grup_jid = ? AND minggu = ?",
      [grupJid, minggu]
    );
    if (!bos) return { success: false, reason: 'BOS_TIDAK_ADA' };
    if (bos.status !== 'HIDUP') return { success: false, reason: 'SUDAH_TUMBANG' };

    await runQuery(
      "INSERT OR IGNORE INTO tcg_bos_jatah (owner_jid, tanggal, dipakai) VALUES (?, ?, 0)",
      [ownerJid, tanggal]
    );
    const pakai = await runQuery(
      "UPDATE tcg_bos_jatah SET dipakai = dipakai + 1 WHERE owner_jid = ? AND tanggal = ? AND dipakai < ?",
      [ownerJid, tanggal, TCG_BOS_JATAH_HARIAN]
    );
    if (pakai.changes !== 1) return { success: false, reason: 'JATAH_HABIS' };

    // Penantang baru menambah HP bos — masuk ke hp sisa DAN hp maks sekaligus,
    // supaya damage yang sudah disetor peserta lama tidak ikut terhapus.
    const sudahIkut = await getQuery(
      "SELECT damage FROM tcg_bos_kontribusi WHERE grup_jid = ? AND minggu = ? AND owner_jid = ?",
      [grupJid, minggu, ownerJid]
    );
    let hp = Number(bos.hp) || 0;
    let hpMaks = Number(bos.hp_maks) || 0;
    const penantangBaru = !sudahIkut;
    let tambahanHp = 0;
    if (penantangBaru) {
      // HP yang dibawa penantang baru DITAKAR dengan sisa pekan.
      //
      // Versi pertama menambah 30.000 penuh kapan pun orang bergabung. Dihitung:
      // yang bergabung hari Minggu hanya punya 3 serangan tersisa, jadi ia harus
      // menyetor 10.000 damage per serangan untuk sekadar membayar HP yang ia
      // bawa sendiri — di atas plafon dek terkuat (~6.900). Akibatnya tiap
      // pendatang akhir pekan membuat bos makin mustahil tumbang, dan karena
      // hadiah cuma dibayar oleh pukulan pematian, SELURUH grup dapat nol.
      tambahanHp = Math.round(TCG_BOS_HP_PER_PENANTANG * (tcgSisaHariPekan(minggu) / 7));
      hp += tambahanHp;
      hpMaks += tambahanHp;
    }

    const hpBaru = Math.max(0, hp - dmg);
    const tumbang = hpBaru <= 0;

    await runQuery(
      `UPDATE tcg_bos SET hp = ?, hp_maks = ?, status = ?, tumbang_at = ?
        WHERE grup_jid = ? AND minggu = ?`,
      [hpBaru, hpMaks, tumbang ? 'TUMBANG' : 'HIDUP', tumbang ? new Date().toISOString() : null, grupJid, minggu]
    );

    await runQuery(
      `INSERT INTO tcg_bos_kontribusi (grup_jid, minggu, owner_jid, damage, serangan)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(grup_jid, minggu, owner_jid)
       DO UPDATE SET damage = damage + ?, serangan = serangan + 1`,
      [grupJid, minggu, ownerJid, dmg, dmg]
    );

    const milikku = await getQuery(
      "SELECT damage, serangan FROM tcg_bos_kontribusi WHERE grup_jid = ? AND minggu = ? AND owner_jid = ?",
      [grupJid, minggu, ownerJid]
    );
    const stat = await getQuery(
      "SELECT COUNT(*) AS penantang FROM tcg_bos_kontribusi WHERE grup_jid = ? AND minggu = ?",
      [grupJid, minggu]
    );
    const jatah = await getQuery(
      "SELECT dipakai FROM tcg_bos_jatah WHERE owner_jid = ? AND tanggal = ?",
      [ownerJid, tanggal]
    );

    return {
      success: true,
      damage: dmg,
      hp: hpBaru,
      hpMaks,
      tumbang,
      penantangBaru,
      tambahanHp,
      penantang: Number(stat?.penantang) || 1,
      damageSaya: Number(milikku?.damage) || dmg,
      seranganSaya: Number(milikku?.serangan) || 1,
      sisaJatah: Math.max(0, TCG_BOS_JATAH_HARIAN - (Number(jatah?.dipakai) || 0)),
      nama: bos.nama,
      elemen: bos.elemen
    };
  });
}

/** Papan sumbangan damage satu bos. */
export async function tcgPapanBos(grupJid, minggu = null) {
  const mg = minggu || tcgKunciPekan();
  return await allQuery(
    `SELECT owner_jid, damage, serangan FROM tcg_bos_kontribusi
      WHERE grup_jid = ? AND minggu = ? ORDER BY damage DESC`,
    [grupJid, mg]
  ) || [];
}

/**
 * Membagi hadiah sesudah bos tumbang. Aman dipanggil berkali-kali: kolom
 * `hadiah_dibagi` dijadikan gerbang di dalam transaksi, jadi dua pesan yang
 * memicu tumbangnya bos bersamaan tidak akan membayar dua kali.
 */
/**
 * Bos yang hadiahnya belum dibereskan: sudah tumbang tapi belum dibayar (bot mati
 * di antara dua transaksi), atau pekannya sudah lewat sementara ia masih hidup.
 *
 * Tanpa ini, kedua keadaan itu berarti sumbangan seluruh grup hangus tanpa satu
 * Keping pun, dan tidak ada satu perintah pun yang bisa memanggil ulang
 * pembayarannya — hanya SQL manual.
 */
export async function tcgBosBelumDibereskan(grupJid) {
  const sekarang = tcgKunciPekan();
  return await allQuery(
    `SELECT * FROM tcg_bos
       WHERE grup_jid = ? AND hadiah_dibagi = 0
         AND (status = 'TUMBANG' OR minggu < ?)
       ORDER BY minggu ASC`,
    [grupJid, sekarang]
  ) || [];
}

export async function tcgBagiHadiahBos(grupJid, minggu = null) {
  const mg = minggu || tcgKunciPekan();

  return withTransaction(async () => {
    // Gerbang tidak lagi menuntut status TUMBANG. Bos yang pekannya sudah lewat
    // tapi tak pernah tumbang tetap dibereskan — hadiahnya dipotong sebanding
    // kerusakan yang berhasil ditimbun grup. Sistem yang membayar nol untuk
    // usaha sepekan penuh adalah sistem yang tidak akan dimainkan dua kali.
    const gerbang = await runQuery(
      "UPDATE tcg_bos SET hadiah_dibagi = 1 WHERE grup_jid = ? AND minggu = ? AND hadiah_dibagi = 0",
      [grupJid, mg]
    );
    if (gerbang.changes !== 1) return { success: false, reason: 'SUDAH_DIBAGI' };

    const bos = await getQuery(
      "SELECT status, hp, hp_maks, nama FROM tcg_bos WHERE grup_jid = ? AND minggu = ?",
      [grupJid, mg]
    );
    const tumbang = bos?.status === 'TUMBANG';
    const hpMaks = Math.max(1, Number(bos?.hp_maks) || 1);
    const porsiKerusakan = tumbang
      ? 1
      : Math.max(0, Math.min(1, (hpMaks - (Number(bos?.hp) || 0)) / hpMaks));

    const kontrib = await allQuery(
      `SELECT owner_jid, damage FROM tcg_bos_kontribusi
        WHERE grup_jid = ? AND minggu = ? ORDER BY damage DESC`,
      [grupJid, mg]
    ) || [];
    if (!kontrib.length) return { success: false, reason: 'TANPA_PENANTANG' };

    const totalDamage = kontrib.reduce((t, k) => t + (Number(k.damage) || 0), 0) || 1;
    const kolamPenuh = TCG_BOS_HADIAH_DASAR + TCG_BOS_HADIAH_PER_PENANTANG * kontrib.length;
    const kolam = Math.round(kolamPenuh * porsiKerusakan);

    const bagian = [];
    for (let i = 0; i < kontrib.length; i++) {
      const k = kontrib[i];
      const porsi = (Number(k.damage) || 0) / totalDamage;
      // Lantai minimum ikut dipotong porsi kerusakan, kalau tidak grup yang cuma
      // menggores 5% HP tetap dibayar penuh lantainya dan Keping tercetak di luar
      // anggaran kolam yang diumumkan.
      const lantai = Math.max(1, Math.round(TCG_BOS_HADIAH_MIN * porsiKerusakan));
      let keping = Math.max(lantai, Math.round(kolam * porsi));
      const puncak = i === 0;
      if (puncak) keping += Math.round(TCG_BOS_BONUS_PUNCAK * porsiKerusakan);

      // Semua penantang dapat serpihan Epic; pemukul terbesar naik ke Legendary.
      // Serpihan sengaja dibagi rata (tidak menurut porsi): yang membedakan
      // sudah Keping, dan serpihan pecahan kecil tidak berarti apa-apa.
      const serpihan = tumbang
        ? (puncak
            ? [{ rarity: 'LEGENDARY', jumlah: 3 }, { rarity: 'EPIC', jumlah: 3 }]
            : [{ rarity: 'EPIC', jumlah: 2 }])
        // Bos yang tidak tumbang tidak menjatuhkan serpihan Legendary — itu
        // hadiah untuk menuntaskan, bukan untuk mencoba.
        : (puncak
            ? [{ rarity: 'EPIC', jumlah: 2 }, { rarity: 'RARE', jumlah: 3 }]
            : [{ rarity: 'RARE', jumlah: 2 }]);

      await bayarHadiah(k.owner_jid, keping, serpihan, 'BOS_ARENA', `${mg}_${grupJid}`);
      bagian.push({ ownerJid: k.owner_jid, damage: Number(k.damage) || 0, porsi, keping, serpihan, puncak });
    }

    return { success: true, kolam, kolamPenuh, porsiKerusakan, tumbang, nama: bos?.nama || '', totalDamage, bagian };
  });
}
