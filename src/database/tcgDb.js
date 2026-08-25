/**
 * TCG ARENA KARTU MONSTER — LAPISAN DATABASE (PURE 0 CLOSED ECONOMY)
 *
 * Mata uang arena (Keping) 100% mandiri dan terisolasi di dalam game arena.
 * Tidak ada konversi poin luar -> Keping untuk menjamin keadilan (Fair Play)
 * di mana semua pemain memulai dari titik awal yang sama.
 */

import { runQuery, getQuery, allQuery, withTransaction } from './connection.js';

// --- Tetapan ekonomi arena (Pure 0) ---
export const TCG_HARGA_TARIK = 200;
export const TCG_HARGA_TARIK10 = 1800;
export const TCG_BATAS_TARIK_HARIAN = 20;
export const TCG_BONUS_HARIAN_KEPING = 50;
export const TCG_BONUS_STARTER_KEPING = 150;
export const TCG_MAX_DECK_COST = 10;
export const TCG_MAX_STAMINA = 5;

export const TCG_RARITY = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'MYTHIC'];

export const TCG_HARGA_JUAL = {
  COMMON: 25,
  RARE: 60,
  EPIC: 150,
  LEGENDARY: 400,
  MYTHIC: 1000
};

// Biaya naik level, dalam serpihan rarity yang sama. Indeks = level saat ini.
export const TCG_BIAYA_LEVEL = {
  COMMON:    { 1: 2, 2: 4, 3: 8, 4: 16 },
  RARE:      { 1: 2, 2: 3, 3: 6, 4: 12 },
  EPIC:      { 1: 1, 2: 2, 3: 4, 4: 8 },
  LEGENDARY: { 1: 1, 2: 2, 3: 3, 4: 5 },
  MYTHIC:    { 1: 1, 2: 1, 3: 2, 4: 3 }
};

export const TCG_SERPIHAN_PER_LEBUR = 5;

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
      last_clear_at   DATETIME
    )
  `);

  await runQuery("CREATE INDEX IF NOT EXISTS idx_tcg_coll_owner ON tcg_collection(owner_jid)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_tcg_ledger_own ON tcg_ledger(owner_jid, created_at)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_tcg_deck_owner ON tcg_deck(owner_jid)");
}

// ============================================================
// DOMPET KEPING
// ============================================================

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
    const w = await getQuery("SELECT keping FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
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
      const w = await getQuery("SELECT keping FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
      return { success: false, reason: 'KEPING_KURANG', keping: w?.keping || 0 };
    }
    await runQuery(
      "INSERT INTO tcg_ledger (owner_jid, delta, sumber, ref) VALUES (?, ?, ?, ?)",
      [ownerJid, -n, sumber, ref]
    );
    const w = await getQuery("SELECT keping FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
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

export async function tcgSisaTarikanHarian(ownerJid) {
  const p = await tcgGetPity(ownerJid);
  return Math.max(0, TCG_BATAS_TARIK_HARIAN - (p.pull_hari_ini || 0));
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
export async function tcgKlaimGratis(ownerJid) {
  const hariIni = tcgTanggalHariIni();
  await runQuery("INSERT OR IGNORE INTO tcg_pity (owner_jid) VALUES (?)", [ownerJid]);
  await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [ownerJid]);

  return withTransaction(async () => {
    const res = await runQuery(
      "UPDATE tcg_pity SET gratis_tanggal = ? WHERE owner_jid = ? AND (gratis_tanggal IS NULL OR gratis_tanggal != ?)",
      [hariIni, ownerJid, hariIni]
    );
    if (res.changes !== 1) {
      return { success: false, reason: 'SUDAH_KLAIM' };
    }

    await runQuery(
      "UPDATE tcg_wallet SET keping = keping + ? WHERE owner_jid = ?",
      [TCG_BONUS_HARIAN_KEPING, ownerJid]
    );
    await runQuery(
      "INSERT INTO tcg_ledger (owner_jid, delta, sumber, ref) VALUES (?, ?, 'DAILY_LOGIN', ?)",
      [ownerJid, TCG_BONUS_HARIAN_KEPING, hariIni]
    );

    const w = await getQuery("SELECT keping FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
    return { success: true, kepingDapat: TCG_BONUS_HARIAN_KEPING, kepingTotal: w?.keping || 0 };
  });
}

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

export async function tcgGetKoleksi(ownerJid) {
  return await allQuery(
    "SELECT card_id, qty, card_lv FROM tcg_collection WHERE owner_jid = ? AND qty > 0 ORDER BY card_id",
    [ownerJid]
  );
}

export async function tcgGetKartu(ownerJid, cardId) {
  return await getQuery(
    "SELECT card_id, qty, card_lv FROM tcg_collection WHERE owner_jid = ? AND card_id = ?",
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
      const owned = await getQuery("SELECT card_lv, qty FROM tcg_collection WHERE owner_jid = ? AND card_id = ? AND qty > 0", [ownerJid, r.card_id]);
      if (owned) {
        deck[r.slot] = { card_id: r.card_id, card_lv: owned.card_lv };
      }
    }
  }
  return deck;
}

export async function tcgSetDeckSlot(ownerJid, slot, cardId, cardCostMap = {}) {
  const s = parseInt(slot, 10);
  if (![1, 2, 3].includes(s)) return { success: false, reason: 'SLOT_TIDAK_VALID' };

  // Pastikan punya kartunya
  const punya = await getQuery("SELECT card_lv, qty FROM tcg_collection WHERE owner_jid = ? AND card_id = ? AND qty > 0", [ownerJid, cardId]);
  if (!punya) return { success: false, reason: 'TIDAK_PUNYA' };

  // Hitung total cost jika kartu ini dipasang
  const currentDeck = await tcgGetDeck(ownerJid);
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

// ============================================================
// PVE: MENARA MONSTER (TOWER / DUNGEON)
// ============================================================

export async function tcgGetTower(ownerJid) {
  const hariIni = tcgTanggalHariIni();
  await runQuery(
    "INSERT OR IGNORE INTO tcg_tower (owner_jid, highest_floor, stamina, stamina_tanggal) VALUES (?, 0, ?, ?)",
    [ownerJid, TCG_MAX_STAMINA, hariIni]
  );
  const t = await getQuery("SELECT * FROM tcg_tower WHERE owner_jid = ?", [ownerJid]);
  if (t && t.stamina_tanggal !== hariIni) {
    await runQuery(
      "UPDATE tcg_tower SET stamina = ?, stamina_tanggal = ? WHERE owner_jid = ?",
      [TCG_MAX_STAMINA, hariIni, ownerJid]
    );
    t.stamina = TCG_MAX_STAMINA;
    t.stamina_tanggal = hariIni;
  }
  return t || { owner_jid: ownerJid, highest_floor: 0, stamina: TCG_MAX_STAMINA, stamina_tanggal: hariIni };
}

export async function tcgProgressTower(ownerJid, floor, rewardKeping = 0, rewardShards = null) {
  return withTransaction(async () => {
    const t = await tcgGetTower(ownerJid);
    if (t.stamina <= 0) {
      return { success: false, reason: 'STAMINA_HABIS' };
    }

    await runQuery(
      `UPDATE tcg_tower SET
         stamina = stamina - 1,
         highest_floor = MAX(highest_floor, ?),
         last_clear_at = CURRENT_TIMESTAMP
       WHERE owner_jid = ?`,
      [floor, ownerJid]
    );

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

    const baru = await tcgGetTower(ownerJid);
    const w = await getQuery("SELECT keping FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
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
    const res = await runQuery(
      "UPDATE tcg_collection SET qty = qty - ? WHERE owner_jid = ? AND card_id = ? AND qty > ?",
      [n, ownerJid, cardId, n]
    );
    if (res.changes !== 1) {
      const punya = await getQuery(
        "SELECT qty FROM tcg_collection WHERE owner_jid = ? AND card_id = ?",
        [ownerJid, cardId]
      );
      return { success: false, reason: 'DUPLIKAT_KURANG', qty: punya?.qty || 0 };
    }
    const total = hargaSatuan * n;
    await runQuery("INSERT OR IGNORE INTO tcg_wallet (owner_jid, keping) VALUES (?, 0)", [ownerJid]);
    await runQuery("UPDATE tcg_wallet SET keping = keping + ? WHERE owner_jid = ?", [total, ownerJid]);
    await runQuery(
      "INSERT INTO tcg_ledger (owner_jid, delta, sumber, ref) VALUES (?, ?, 'JUAL_KARTU', ?)",
      [ownerJid, total, `${cardId}x${n}`]
    );
    const w = await getQuery("SELECT keping FROM tcg_wallet WHERE owner_jid = ?", [ownerJid]);
    return { success: true, dapat: total, keping: w.keping };
  });
}

export async function tcgSerpihKartu(ownerJid, cardId, rarity, jumlah = 1) {
  const n = Math.max(1, Math.floor(Number(jumlah) || 1));
  if (!TCG_RARITY.includes(rarity)) return { success: false, reason: 'RARITY_TIDAK_VALID' };

  return withTransaction(async () => {
    const res = await runQuery(
      "UPDATE tcg_collection SET qty = qty - ? WHERE owner_jid = ? AND card_id = ? AND qty > ?",
      [n, ownerJid, cardId, n]
    );
    if (res.changes !== 1) {
      const punya = await getQuery(
        "SELECT qty FROM tcg_collection WHERE owner_jid = ? AND card_id = ?",
        [ownerJid, cardId]
      );
      return { success: false, reason: 'DUPLIKAT_KURANG', qty: punya?.qty || 0 };
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

export async function tcgNaikLevel(ownerJid, cardId, rarity) {
  return withTransaction(async () => {
    const kartu = await getQuery(
      "SELECT qty, card_lv FROM tcg_collection WHERE owner_jid = ? AND card_id = ? AND qty > 0",
      [ownerJid, cardId]
    );
    if (!kartu) return { success: false, reason: 'TIDAK_PUNYA' };
    if (kartu.card_lv >= 5) return { success: false, reason: 'SUDAH_MAKS' };

    const biaya = (TCG_BIAYA_LEVEL[rarity] || {})[kartu.card_lv];
    if (!biaya) return { success: false, reason: 'RARITY_TIDAK_VALID' };

    const res = await runQuery(
      "UPDATE tcg_shards SET jumlah = jumlah - ? WHERE owner_jid = ? AND rarity = ? AND jumlah >= ?",
      [biaya, ownerJid, rarity, biaya]
    );
    if (res.changes !== 1) {
      const s = await getQuery(
        "SELECT jumlah FROM tcg_shards WHERE owner_jid = ? AND rarity = ?",
        [ownerJid, rarity]
      );
      return { success: false, reason: 'SERPIHAN_KURANG', butuh: biaya, punya: s?.jumlah || 0 };
    }

    await runQuery(
      "UPDATE tcg_collection SET card_lv = card_lv + 1 WHERE owner_jid = ? AND card_id = ?",
      [ownerJid, cardId]
    );
    return { success: true, levelBaru: kartu.card_lv + 1, biaya };
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
