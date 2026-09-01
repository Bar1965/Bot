import { runQuery, getQuery, allQuery, withTransaction, normalizePhoneDigits } from './connection.js';
import { config } from '../../config.js';

import { addLog, getOrCreateCustomer, getCustomerMembershipProfile, getSettings } from './userDb.js';


// --- FUNGSI GAME, XP, DAN REWARD HARIAN ---
const MAX_POINTS = 1_000_000; // Hard cap untuk mencegah nilai gila

export async function getGameProfile(customerJid) {
  await runQuery(
    "INSERT OR IGNORE INTO game_profiles (customer_jid, points, bank_points, xp, level, games_played, games_won, daily_streak) VALUES (?, 0, 0, 0, 1, 0, 0, 0)",
    [customerJid]
  );
  let profile = await getQuery("SELECT * FROM game_profiles WHERE customer_jid = ?", [customerJid]);
  if (!profile) {
    profile = { customer_jid: customerJid, points: 0, bank_points: 0, xp: 0, level: 1, games_played: 0, games_won: 0, daily_streak: 0 };
  }

  const rawPoints = Number(profile.points);
  const rawBank = Number(profile.bank_points);
  const safePoints = (!isFinite(rawPoints) || isNaN(rawPoints)) ? 0 : Math.max(0, Math.min(MAX_POINTS, Math.floor(rawPoints)));
  const safeBank = (!isFinite(rawBank) || isNaN(rawBank)) ? 0 : Math.max(0, Math.min(MAX_POINTS, Math.floor(rawBank)));
  const safeXp = Math.max(0, Math.floor(Number(profile.xp) || 0));
  const safeLevel = Math.max(1, Math.floor(Number(profile.level) || 1));
  const safePlayed = Math.max(0, Math.floor(Number(profile.games_played) || 0));
  const safeWon = Math.max(0, Math.floor(Number(profile.games_won) || 0));
  const safeStreak = Math.max(0, Math.floor(Number(profile.daily_streak) || 0));

  // Auto-heal DB jika ada data NULL/NaN/tak terbatas
  if (profile.points !== safePoints || profile.bank_points !== safeBank || profile.xp !== safeXp || profile.level !== safeLevel || 
      profile.games_played !== safePlayed || profile.games_won !== safeWon || profile.daily_streak !== safeStreak) {
    await runQuery(
      `UPDATE game_profiles SET points = ?, bank_points = ?, xp = ?, level = ?, games_played = ?, games_won = ?, daily_streak = ? WHERE customer_jid = ?`,
      [safePoints, safeBank, safeXp, safeLevel, safePlayed, safeWon, safeStreak, customerJid]
    );
    profile.points = safePoints;
    profile.bank_points = safeBank;
    profile.xp = safeXp;
    profile.level = safeLevel;
    profile.games_played = safePlayed;
    profile.games_won = safeWon;
    profile.daily_streak = safeStreak;
  }

  return profile;
}

export async function updateGameProfile(customerJid, data = {}) {
  await getGameProfile(customerJid);
  if (data.points !== undefined && data.points !== null) {
    const rawVal = Number(data.points);
    if (!isNaN(rawVal) && isFinite(rawVal)) {
      const safePoints = Math.max(0, Math.min(MAX_POINTS, Math.floor(rawVal)));
      await runQuery(
        "UPDATE game_profiles SET points = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_jid = ?",
        [safePoints, customerJid]
      );
    } else {
      console.warn(`[POINTS PROTECTION] Blocked invalid points update (${data.points}) for ${customerJid}`);
    }
  }
  if (data.xp !== undefined && data.xp !== null) {
    const rawVal = Number(data.xp);
    if (!isNaN(rawVal) && isFinite(rawVal)) {
      const safeXp = Math.max(0, Math.floor(rawVal));
      await runQuery(
        "UPDATE game_profiles SET xp = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_jid = ?",
        [safeXp, customerJid]
      );
    }
  }
  return await getGameProfile(customerJid);
}

export async function updateLastRobTime(customerJid) {
  await runQuery("UPDATE game_profiles SET last_rob_time = CURRENT_TIMESTAMP WHERE customer_jid = ?", [customerJid]);
}

export async function updateLastRobbedAt(customerJid) {
  await runQuery("UPDATE game_profiles SET last_robbed_at = CURRENT_TIMESTAMP WHERE customer_jid = ?", [customerJid]);
}

/**
 * EKONOMI BANK — tiga aturan yang saling mengunci. Jangan ubah satu tanpa
 * memikirkan dua lainnya.
 *
 * 1. **Menarik uang sendiri tidak dipajaki.** Dulu setor gratis tapi tarik kena
 *    2%, jadi setor 100 lalu tarik 100 cuma balik 98 — uang pas tidak pernah
 *    ada. Digabung dengan bunga 2%/hari, bank jadi katup satu arah: semua masuk,
 *    tidak ada yang keluar. Saat aturan ini ditulis, 95% kekayaan seluruh bot
 *    parkir di bank dan cuma 5.790 poin benar-benar beredar di 134 dompet.
 * 2. **Bunga bertingkat + batas keras.** Bunga hanya untuk `BANK_BUNGA_TIER`
 *    poin pertama dan tidak pernah lebih dari `BANK_BUNGA_CAP` per hari per
 *    akun. Sebelum ini, 93% bunga harian mengalir ke 3 akun saja.
 * 3. **Dana endap menggantikan pajak tarik sebagai rem.** Setoran baru belum
 *    kebal `.steal` selama `BANK_ENDAP_MS`. Tanpa ini, menghapus pajak tarik
 *    membuat bank jadi tameng sempurna dan `.steal` mati total.
 */
export const BANK_BUNGA_RATE = 0.02;
export const BANK_BUNGA_TIER = 5000;   // bunga hanya untuk saldo sampai angka ini
export const BANK_BUNGA_CAP = 50;      // maksimum poin bunga per akun per hari
// Cap sengaja DI BAWAH tier*rate (5000 x 2% = 100) supaya batas ini benar-benar
// menggigit. Kalau disamakan dengan 100, capnya tidak pernah aktif dan hasilnya
// identik dengan bunga bertingkat biasa.
export const BANK_ENDAP_MS = 10 * 60 * 1000;

/** Berapa poin korban yang masih bisa dijangkau `.steal`: dompet + dana endap. */
export async function getSaldoRawan(customerJid) {
  const prof = await getGameProfile(customerJid);
  const dompet = Math.max(0, Number(prof?.points) || 0);
  const masihEndap = (Date.now() - (Number(prof?.bank_pending_at) || 0)) < BANK_ENDAP_MS;
  const endap = masihEndap
    ? Math.min(Math.max(0, Number(prof?.bank_pending) || 0), Math.max(0, Number(prof?.bank_points) || 0))
    : 0;
  return { dompet, endap, rawan: dompet + endap, profile: prof };
}

/**
 * Ambil paksa dari korban `.steal`: dompet dulu, sisanya baru menggerus dana
 * yang belum mengendap. Saldo bank yang sudah mengendap tidak pernah tersentuh.
 */
export async function curiSaldoKorban(customerJid, jumlah) {
  const target = Math.max(0, Math.floor(Number(jumlah) || 0));
  if (target <= 0) return { success: false, diambil: 0 };

  return withTransaction(async () => {
    const s = await getSaldoRawan(customerJid);
    const diambil = Math.min(target, s.rawan);
    if (diambil <= 0) return { success: false, diambil: 0 };

    const dariDompet = Math.min(diambil, s.dompet);
    const dariEndap = diambil - dariDompet;

    await runQuery(
      `UPDATE game_profiles
       SET points = MAX(0, COALESCE(points, 0) - ?),
           bank_points = MAX(0, COALESCE(bank_points, 0) - ?),
           bank_pending = MAX(0, COALESCE(bank_pending, 0) - ?),
           updated_at = CURRENT_TIMESTAMP
       WHERE customer_jid = ?`,
      [dariDompet, dariEndap, dariEndap, customerJid]
    );
    return { success: true, diambil, dariDompet, dariEndap };
  });
}

/** Bunga harian yang akan diterima satu saldo tertentu — dipakai layar `.bank`. */
export function hitungBungaHarian(bankPoints) {
  const saldo = Math.max(0, Math.floor(Number(bankPoints) || 0));
  if (saldo < 25) return 0;
  return Math.min(BANK_BUNGA_CAP, Math.floor(Math.min(saldo, BANK_BUNGA_TIER) * BANK_BUNGA_RATE));
}

export async function bankDeposit(customerJid, amount) {
  const safeAmount = Math.max(0, Math.floor(Number(amount)));
  if (safeAmount <= 0) return { success: false, reason: 'INVALID_AMOUNT' };
  
  return withTransaction(async () => {
    const now = Date.now();
    const prof = await getQuery(
      "SELECT bank_pending, bank_pending_at FROM game_profiles WHERE customer_jid = ?", [customerJid]
    );
    // Setoran lama yang sudah mengendap tidak boleh ikut dihidupkan lagi.
    const masihEndap = prof && (now - (Number(prof.bank_pending_at) || 0)) < BANK_ENDAP_MS;
    const pendingBaru = (masihEndap ? Math.max(0, Number(prof.bank_pending) || 0) : 0) + safeAmount;

    const res = await runQuery(
      `UPDATE game_profiles
       SET points = points - ?,
           bank_points = COALESCE(bank_points, 0) + ?,
           bank_pending = ?,
           bank_pending_at = ?
       WHERE customer_jid = ? AND points >= ?`,
      [safeAmount, safeAmount, pendingBaru, now, customerJid, safeAmount]
    );
    if (res.changes === 0) {
      return { success: false, reason: 'INSUFFICIENT_FUNDS' };
    }
    return { success: true, pending: pendingBaru, endapSampai: now + BANK_ENDAP_MS };
  });
}

export async function bankWithdraw(customerJid, amount, taxRate = 0) {
  const safeAmount = Math.max(0, Math.floor(Number(amount)));
  if (safeAmount <= 0) return { success: false, reason: 'INVALID_AMOUNT' };
  
  const receivedAmount = Math.floor(safeAmount * (1 - taxRate));
  
  return withTransaction(async () => {
    const res = await runQuery(
      `UPDATE game_profiles SET bank_points = bank_points - ?, points = COALESCE(points, 0) + ? WHERE customer_jid = ? AND bank_points >= ?`,
      [safeAmount, receivedAmount, customerJid, safeAmount]
    );
    if (res.changes === 0) {
      return { success: false, reason: 'INSUFFICIENT_FUNDS' };
    }
    return { success: true, received: receivedAmount };
  });
}

export async function applyDailyBankInterest(
  interestRate = BANK_BUNGA_RATE,
  tier = BANK_BUNGA_TIER,
  cap = BANK_BUNGA_CAP
) {
  return withTransaction(async () => {
    // Bunga dihitung hanya dari `tier` poin pertama lalu dipotong `cap`.
    // Rumusnya ditulis di SQL supaya tetap satu pernyataan atomik untuk semua
    // nasabah, sama seperti versi sebelumnya.
    const res = await runQuery(
      `UPDATE game_profiles
       SET bank_points = MIN(${MAX_POINTS},
             bank_points + MIN(?, CAST(MIN(bank_points, ?) * ? AS INTEGER))),
           updated_at = CURRENT_TIMESTAMP
       WHERE bank_points >= 25`,
      [cap, tier, interestRate]
    );
    return res.changes || 0;
  });
}

export async function setGameJail(customerJid, durationMinutes = 30) {
  const jailExpiry = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
  await runQuery(
    "UPDATE game_profiles SET jailed_until = ? WHERE customer_jid = ?",
    [jailExpiry, customerJid]
  );
  return jailExpiry;
}

export async function isPlayerJailed(customerJid) {
  const row = await getQuery("SELECT jailed_until FROM game_profiles WHERE customer_jid = ?", [customerJid]);
  if (!row || !row.jailed_until) return { isJailed: false, remainingMinutes: 0 };
  const jailTime = new Date(row.jailed_until).getTime();
  const now = Date.now();
  if (jailTime > now) {
    const remainingMinutes = Math.ceil((jailTime - now) / 60000);
    return { isJailed: true, remainingMinutes };
  }
  return { isJailed: false, remainingMinutes: 0 };
}

export async function clearGameJail(customerJid) {
  const res = await runQuery(
    "UPDATE game_profiles SET jailed_until = NULL WHERE customer_jid = ?",
    [customerJid]
  );
  return res.changes > 0;
}

export async function addGameJailDuration(customerJid, extraMinutes = 15) {
  const current = await isPlayerJailed(customerJid);
  const baseMinutes = current.isJailed ? current.remainingMinutes : 0;
  const newMinutes = baseMinutes + extraMinutes;
  return setGameJail(customerJid, newMinutes);
}

export async function transferPoints(senderJid, targetJid, amount, taxRate = 0.01) {
  const safeAmount = Math.max(0, Math.floor(Number(amount)));
  if (safeAmount <= 0) return { success: false, reason: 'INVALID_AMOUNT' };
  
  const receivedAmount = Math.floor(safeAmount * (1 - taxRate));
  
  await getGameProfile(senderJid);
  await getGameProfile(targetJid);

  return withTransaction(async () => {
    const deductRes = await runQuery(
      `UPDATE game_profiles SET points = points - ? WHERE customer_jid = ? AND points >= ?`,
      [safeAmount, senderJid, safeAmount]
    );
    if (deductRes.changes === 0) {
      return { success: false, reason: 'INSUFFICIENT_FUNDS' };
    }
    await runQuery(
      `UPDATE game_profiles SET points = COALESCE(points, 0) + ? WHERE customer_jid = ?`,
      [receivedAmount, targetJid]
    );
    return { success: true, received: receivedAmount };
  });
}


/**
 * Add points atomically to game_profile using a SQLite transaction.
 */
export async function addGamePoints(customerJid, amount) {
  const safeAmount = Math.floor(Number(amount));
  if (isNaN(safeAmount) || !isFinite(safeAmount) || safeAmount <= 0) {
    return await getGameProfile(customerJid);
  }
  return withTransaction(async () => {
    await getGameProfile(customerJid);
    await runQuery(
      `UPDATE game_profiles
       SET points = MIN(${MAX_POINTS}, COALESCE(points, 0) + ?), updated_at = CURRENT_TIMESTAMP
       WHERE customer_jid = ?`,
      [safeAmount, customerJid]
    );
    return await getGameProfile(customerJid);
  });
}

/**
 * Deduct points atomically from game_profile using a SQLite transaction.
 */
export async function deductGamePoints(customerJid, amount) {
  const safeAmount = Math.floor(Number(amount));
  if (isNaN(safeAmount) || !isFinite(safeAmount) || safeAmount <= 0) {
    return { success: false, reason: 'INVALID_AMOUNT' };
  }
  return withTransaction(async () => {
    // Attempt the atomic update directly first
    const updateResult = await runQuery(
      `UPDATE game_profiles
       SET points = points - ?, updated_at = CURRENT_TIMESTAMP
       WHERE customer_jid = ? AND points >= ?`,
      [safeAmount, customerJid, safeAmount]
    );

    const profile = await getGameProfile(customerJid);
    
    // If no rows were changed, either the profile didn't exist or points < safeAmount
    if (updateResult.changes === 0) {
      return { success: false, reason: 'INSUFFICIENT_POINTS', currentPoints: profile.points || 0 };
    }

    return { success: true, newPoints: profile.points, profile: profile };
  });
}

export async function awardGamePoints(customerJid, points, won = false) {
  const rawPts = Number.parseInt(points, 10);
  // Batas atas dipakai MAX_POINTS (sama seperti addGamePoints). Dulu di sini
  // ada batas keras 1.000 poin dari masa ketika hadiah terbesar cuma trivia
  // (~50 poin). Game baru (Mines cashout, Raid Boss prizepool, Mystery Auction)
  // rutin membayar di atas 1.000, sehingga batas lama memotong hadiah secara
  // diam-diam: pesan menampilkan hadiah penuh tapi dompet cuma nambah 1.000.
  // Batas ini murni penjaga nilai gila/overflow, bukan aturan ekonomi — nilai
  // hadiah tiap game diatur di modul game masing-masing.
  const safePoints = (!isFinite(rawPts) || isNaN(rawPts)) ? 0 : Math.max(0, Math.min(MAX_POINTS, rawPts));
  // XP Booster hanya mengalikan XP, tidak pernah poin — poin tetap 1:1 supaya
  // buff tidak bisa dipakai untuk menggandakan saldo poin.
  const xpBoost = await getBuffMultiplier(customerJid, 'XP_BOOST');
  const xpGain = Math.max(0, Math.round(safePoints * xpBoost));
  return withTransaction(async () => {
    await getGameProfile(customerJid);
    await runQuery(
      `UPDATE game_profiles
       SET points = COALESCE(points, 0) + ?, xp = COALESCE(xp, 0) + ?, games_played = COALESCE(games_played, 0) + 1,
           games_won = COALESCE(games_won, 0) + ?, updated_at = CURRENT_TIMESTAMP
       WHERE customer_jid = ?`,
      [safePoints, xpGain, won ? 1 : 0, customerJid]
    );
    const profile = await getGameProfile(customerJid);
    const level = Math.floor(profile.xp / 100) + 1;
    if (level !== profile.level) {
      await runQuery("UPDATE game_profiles SET level = ? WHERE customer_jid = ?", [level, customerJid]);
      profile.level = level;
    }
    return { ...profile, earned: safePoints };
  });
}

/**
 * Tanggal hari ini menurut WIB (UTC+7), format YYYY-MM-DD.
 *
 * `.daily` dulu memakai `new Date().toISOString()` yang selalu UTC, sehingga
 * "hari" pemain berganti jam 07:00 pagi WIB, bukan tengah malam. Pemain yang
 * main lewat tengah malam ditolak dengan "sudah diklaim hari ini" padahal bagi
 * mereka sudah hari baru. scheduler.js sudah memakai pergeseran +7 jam ini
 * untuk laporan harian dan bunga bank; `.daily` tertinggal.
 *
 * (`tcgTanggalHariIni()` di tcgDb.js adalah fungsi yang sama dengan nama khusus
 * TCG — jangan tambah versi ketiga.)
 */
export function tanggalWIB() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function claimGameDaily(customerJid, today, reward = 25) {
  return withTransaction(async () => {
    const profile = await getGameProfile(customerJid);
    if (profile.daily_claimed_at === today) {
      return { success: false, message: 'Hadiah harian sudah diklaim hari ini.', profile };
    }
    const yesterday = new Date(`${today}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const streak = profile.daily_claimed_at === yesterday.toISOString().slice(0, 10)
      ? Number(profile.daily_streak || 0) + 1
      : 1;
    const streakBonus = Math.min(50, Math.max(0, streak - 1) * 5);
    const safeReward = (!isFinite(Number(reward)) || isNaN(Number(reward))) ? 25 : Math.max(0, Math.floor(Number(reward)));
      const totalReward = safeReward + streakBonus;
    await runQuery(
      `UPDATE game_profiles
       SET points = COALESCE(points, 0) + ?, xp = COALESCE(xp, 0) + ?, daily_claimed_at = ?, daily_streak = ?, updated_at = CURRENT_TIMESTAMP
       WHERE customer_jid = ?`,
      [totalReward, totalReward, today, streak, customerJid]
    );
    const updated = await getGameProfile(customerJid);
    const level = Math.floor(updated.xp / 100) + 1;
    await runQuery("UPDATE game_profiles SET level = ? WHERE customer_jid = ?", [level, customerJid]);
    updated.level = level;
    return { success: true, reward: totalReward, streak, profile: updated };
  });
}


export async function getGameLeaderboard(limit = 10) {
  const safeLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
  let ownerDigits = '';
  try {
    const settings = await getSettings();
    const ownerJid = (settings?.ownerJid || '').trim();
    ownerDigits = normalizePhoneDigits(ownerJid);
  } catch (e) {}

  let rows = await allQuery(
    `SELECT g.customer_jid, COALESCE(g.points, 0) AS points, COALESCE(g.level, 1) AS level, COALESCE(g.games_won, 0) AS games_won, COALESCE(g.games_played, 0) AS games_played,
            COALESCE(c.nama, 'Member') AS customer_nama, c.role
     FROM game_profiles g
     INNER JOIN customers c ON c.nomor = g.customer_jid
     WHERE c.profile_completed = 1 AND UPPER(COALESCE(c.role, 'MEMBER')) != 'OWNER'
     ORDER BY COALESCE(g.points, 0) DESC, COALESCE(g.level, 1) DESC, COALESCE(g.games_won, 0) DESC
     LIMIT ?`,
    [safeLimit + 10]
  );

  // Filter out any row matching owner phone digits
  if (ownerDigits && ownerDigits.length > 5) {
    rows = rows.filter(r => {
      const rDigits = normalizePhoneDigits(r.customer_jid || '');
      return !rDigits.includes(ownerDigits) && !ownerDigits.includes(rDigits);
    });
  }

  return rows.slice(0, safeLimit);
}

/**
 * PAPAN PERINGKAT SERBAGUNA (dipakai `.lb <kategori>`)
 *
 * Semua mode memakai satu query yang sama; yang berbeda cuma ORDER BY. Daftar
 * mode adalah whitelist karena potongan SQL-nya digabung sebagai teks — nama
 * mode tidak boleh datang dari input pemain tanpa lewat peta ini.
 */
const PAPAN_PROFIL = {
  poin:   'COALESCE(g.points, 0) DESC, COALESCE(g.level, 1) DESC',
  level:  'COALESCE(g.level, 1) DESC, COALESCE(g.xp, 0) DESC',
  kaya:   '(COALESCE(g.points, 0) + COALESCE(g.bank_points, 0)) DESC, COALESCE(g.level, 1) DESC',
  menang: 'COALESCE(g.games_won, 0) DESC, COALESCE(g.games_played, 0) ASC',
  streak: 'COALESCE(g.daily_streak, 0) DESC, COALESCE(g.points, 0) DESC'
};

/**
 * Semua member terdaftar sebagai calon penerima bansos — **OWNER IKUT**.
 *
 * JANGAN pernah memakai `getProfileLeaderboard()` untuk daftar penerima. Fungsi
 * itu sengaja membuang owner DUA LAPIS (kolom `c.role` dan pencocokan digit
 * nomor) supaya papan peringkat tidak didominasi pemiliknya sendiri, dan diam-
 * diam memotong hasilnya di 100 baris lewat `Math.min(100, limit)`.
 *
 * Dipakai sebagai daftar penerima, dua sifat itu jadi bug: owner tidak pernah
 * kebagian bansosnya sendiri, dan begitu member terdaftar lewat 100 orang
 * sisanya ikut hilang tanpa pesan. Terbukti di produksi: 63 member terdaftar,
 * `bansos_log` mencatat 62 penerima dua kali berturut-turut — satu yang hilang
 * adalah owner.
 */
export async function getPenerimaBansos(limit = 1000) {
  const safeLimit = Math.max(1, Math.min(5000, Number.parseInt(limit, 10) || 1000));
  return allQuery(
    `SELECT g.customer_jid,
            COALESCE(c.nama, 'Member') AS customer_nama
     FROM game_profiles g
     INNER JOIN customers c ON c.nomor = g.customer_jid
     WHERE c.profile_completed = 1
     ORDER BY COALESCE(c.nama, '') COLLATE NOCASE ASC, g.customer_jid ASC
     LIMIT ?`,
    [safeLimit]
  );
}

export async function getProfileLeaderboard(mode = 'poin', limit = 10) {
  const kunci = Object.prototype.hasOwnProperty.call(PAPAN_PROFIL, mode) ? mode : 'poin';
  const safeLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 10));

  // Owner disaring dua lapis: lewat kolom role, dan lewat pencocokan digit
  // nomor. Lapis kedua perlu karena baris owner bisa saja tercatat sebagai
  // MEMBER kalau profilnya dibuat sebelum role-nya diatur.
  let ownerDigits = '';
  try {
    const settings = await getSettings();
    ownerDigits = normalizePhoneDigits(settings?.ownerNumber || config.defaults.ownerNumber || '');
  } catch (e) { /* biarkan tanpa filter digit */ }

  let rows = await allQuery(
    `SELECT g.customer_jid,
            COALESCE(g.points, 0) AS points,
            COALESCE(g.bank_points, 0) AS bank_points,
            COALESCE(g.points, 0) + COALESCE(g.bank_points, 0) AS total_harta,
            COALESCE(g.xp, 0) AS xp,
            COALESCE(g.level, 1) AS level,
            COALESCE(g.games_won, 0) AS games_won,
            COALESCE(g.games_played, 0) AS games_played,
            COALESCE(g.daily_streak, 0) AS daily_streak,
            COALESCE(c.nama, 'Member') AS customer_nama
     FROM game_profiles g
     INNER JOIN customers c ON c.nomor = g.customer_jid
     WHERE c.profile_completed = 1 AND UPPER(COALESCE(c.role, 'MEMBER')) != 'OWNER'
     ORDER BY ${PAPAN_PROFIL[kunci]}
     LIMIT ?`,
    [safeLimit + 10]
  );

  if (ownerDigits && ownerDigits.length > 5) {
    rows = rows.filter(r => {
      const d = normalizePhoneDigits(r.customer_jid || '');
      return !d.includes(ownerDigits) && !ownerDigits.includes(d);
    });
  }

  return rows.slice(0, safeLimit);
}

// ============================================================
// RIWAYAT BANSOS OWNER
// ============================================================

export async function catatBansos({ jenis, jumlah = 0, penerima = 0, alasan = null } = {}) {
  if (!jenis) return null;
  await runQuery(
    "INSERT INTO bansos_log (jenis, jumlah, penerima, alasan) VALUES (?, ?, ?, ?)",
    [String(jenis).slice(0, 32),
     Math.max(0, Math.floor(Number(jumlah) || 0)),
     Math.max(0, Math.floor(Number(penerima) || 0)),
     alasan ? String(alasan).slice(0, 500) : null]
  );
  return true;
}

export async function getBansosLog(limit = 15) {
  const safeLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 15));
  return await allQuery(
    "SELECT jenis, jumlah, penerima, alasan, created_at FROM bansos_log ORDER BY id DESC LIMIT ?",
    [safeLimit]
  );
}

/** Papan member paling cerewet di satu grup (dari group_chat_stats). */
export async function getChatLeaderboard(groupJid, limit = 10) {
  if (!groupJid) return [];
  const safeLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 10));
  return await allQuery(
    `SELECT s.participant_jid AS customer_jid,
            COALESCE(s.msg_count, 0) AS msg_count,
            COALESCE(c.nama, 'Member') AS customer_nama
     FROM group_chat_stats s
     LEFT JOIN customers c ON c.nomor = s.participant_jid
     WHERE s.group_jid = ? AND COALESCE(s.msg_count, 0) > 0
     ORDER BY COALESCE(s.msg_count, 0) DESC
     LIMIT ?`,
    [groupJid, safeLimit]
  );
}

/**
 * Hitung dampak reset SEBELUM dijalankan. Dipakai layar konfirmasi supaya
 * pemanggil melihat angka nyata, bukan kalimat abstrak.
 */
export async function pratinjauResetLeaderboard() {
  const belum = await getQuery(`
    SELECT COUNT(*) n FROM game_profiles
    WHERE customer_jid NOT IN (SELECT nomor FROM customers WHERE profile_completed = 1)
  `);
  const sudah = await getQuery(`
    SELECT COUNT(*) n,
           COALESCE(SUM(points), 0) poin,
           COALESCE(SUM(bank_points), 0) bank,
           COALESCE(SUM(xp), 0) xp
    FROM game_profiles
    WHERE customer_jid IN (SELECT nomor FROM customers WHERE profile_completed = 1)
  `);
  return {
    akanDihapus: Number(belum?.n) || 0,
    akanDinolkan: Number(sudah?.n) || 0,
    poinHilang: Number(sudah?.poin) || 0,
    xpHilang: Number(sudah?.xp) || 0,
    bankTetap: Number(sudah?.bank) || 0
  };
}

/**
 * Reset papan peringkat game.
 *
 * BAHAYA: mode `'total'` menjalankan UPDATE **tanpa klausa WHERE** yang menolkan
 * poin, XP, level, dan streak SELURUH member terdaftar sekaligus. Sebelumnya
 * fungsi ini tidak punya parameter apa pun, sehingga satu perintah tanpa
 * argumen dari admin grup WhatsApp mana pun langsung menghapus seluruh ekonomi
 * bot tanpa konfirmasi. Pemanggil WAJIB meminta konfirmasi eksplisit sebelum
 * memakai `'total'` — lihat `.resetleaderboard` di groupAdminHandler.js.
 *
 * - `'bersih'` (default): hanya menghapus profil milik user yang belum `.daftar`.
 *   Member terdaftar tidak tersentuh sama sekali.
 * - `'total'`: `'bersih'` + menolkan poin/XP/level/streak semua member terdaftar.
 *
 * Catatan: `bank_points` sengaja TIDAK ikut dinolkan, mengikuti perilaku lama.
 * Artinya "reset total" pun menyisakan saldo bank — disadari, bukan kelalaian.
 */
export async function resetGameLeaderboard(mode = 'bersih') {
  const modeAman = String(mode).toLowerCase() === 'total' ? 'total' : 'bersih';

  // 1. Hapus profil game milik user yang belum mendaftar (.daftar)
  const hapus = await runQuery(`
    DELETE FROM game_profiles
    WHERE customer_jid NOT IN (
      SELECT nomor FROM customers WHERE profile_completed = 1
    )
  `);
  const dihapus = hapus.changes || 0;

  if (modeAman === 'bersih') {
    await addLog("ADMIN", `Papan peringkat dibersihkan: ${dihapus} profil belum terdaftar dihapus. Member terdaftar tidak disentuh.`);
    return { success: true, mode: modeAman, dihapus, dinolkan: 0 };
  }

  // 2. Nolkan poin, XP, level, dan streak SEMUA member terdaftar.
  const result = await runQuery(`
    UPDATE game_profiles
    SET points = 0, xp = 0, level = 1, games_played = 0, games_won = 0,
        daily_streak = 0, daily_claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
  `);
  const dinolkan = result.changes || 0;

  await addLog("ADMIN", `RESET TOTAL papan peringkat: ${dihapus} profil dihapus, ${dinolkan} member terdaftar dinolkan.`);
  return { success: true, mode: modeAman, dihapus, dinolkan };
}


// --- FUNGSI MULTIPLAYER SUIT CHALLENGE ---
// ============================================================

export async function createSuitChallenge(challengerJid, challengedJid, groupJid, bet) {
  const safeBet = Math.max(0, Math.floor(Number(bet) || 0));
  return withTransaction(async () => {
    // Kurangi poin penantang jika ada taruhan
    await getGameProfile(challengerJid);
    if (safeBet > 0) {
      const deductRes = await runQuery(
        "UPDATE game_profiles SET points = points - ?, updated_at = CURRENT_TIMESTAMP WHERE customer_jid = ? AND points >= ?",
        [safeBet, challengerJid, safeBet]
      );
      if (deductRes.changes === 0) {
        throw new Error('INSUFFICIENT_POINTS');
      }
    }

    // Buat data tantangan
    const res = await runQuery(
      `INSERT INTO suit_challenges (challenger_jid, challenged_jid, group_jid, bet, status)
       VALUES (?, ?, ?, ?, 'PENDING')`,
      [challengerJid, challengedJid, groupJid, safeBet]
    );
    return res.lastID;
  });
}

export async function getSuitChallengeById(challengeId) {
  return await getQuery("SELECT * FROM suit_challenges WHERE id = ?", [challengeId]);
}

export async function getPendingSuitChallenge(userJid) {
  // Mencari tantangan aktif di mana pengguna terlibat dan belum menentukan pilihan
  return await getQuery(
    `SELECT * FROM suit_challenges 
     WHERE status = 'PENDING' 
       AND (
         (challenger_jid = ? AND challenger_choice IS NULL) OR 
         (challenged_jid = ? AND challenged_choice IS NULL)
       )
     ORDER BY created_at DESC LIMIT 1`,
    [userJid, userJid]
  );
}

export async function saveSuitChoice(challengeId, userJid, choice) {
  return withTransaction(async () => {
    const challenge = await getSuitChallengeById(challengeId);
    if (!challenge || challenge.status !== 'PENDING') return false;

    if (challenge.challenger_jid === userJid) {
      await runQuery("UPDATE suit_challenges SET challenger_choice = ? WHERE id = ?", [choice, challengeId]);
    } else if (challenge.challenged_jid === userJid) {
      // Kurangi poin penantang yang ditantang saat mengirim pilihan pertama kali (sebagai tanda menyetujui taruhan)
      if (challenge.challenged_choice === null) {
        const safeBet = Math.max(0, Math.floor(Number(challenge.bet) || 0));
        if (safeBet > 0) {
          const deductRes = await runQuery(
            "UPDATE game_profiles SET points = points - ?, updated_at = CURRENT_TIMESTAMP WHERE customer_jid = ? AND points >= ?",
            [safeBet, userJid, safeBet]
          );
          if (deductRes.changes === 0) {
            return { error: 'INSUFFICIENT_POINTS' };
          }
        }
      }
      await runQuery("UPDATE suit_challenges SET challenged_choice = ? WHERE id = ?", [choice, challengeId]);
    } else {
      return false;
    }
    return await getSuitChallengeById(challengeId);
  });
}

export async function completeSuitChallenge(challengeId, status) {
  await runQuery("UPDATE suit_challenges SET status = ? WHERE id = ?", [status, challengeId]);
}

export async function refundSuitChallenge(challengeId, refundChallenger = true, refundChallenged = true) {
  const challenge = await getSuitChallengeById(challengeId);
  if (!challenge) return;

  await withTransaction(async () => {
    const safeBet = Math.max(0, Math.floor(Number(challenge.bet) || 0));
    if (refundChallenger) {
      await runQuery(
        "UPDATE game_profiles SET points = COALESCE(points, 0) + ?, updated_at = CURRENT_TIMESTAMP WHERE customer_jid = ?",
        [safeBet, challenge.challenger_jid]
      );
    }
    if (refundChallenged && challenge.challenged_choice !== null) {
      await runQuery(
        "UPDATE game_profiles SET points = COALESCE(points, 0) + ?, updated_at = CURRENT_TIMESTAMP WHERE customer_jid = ?",
        [safeBet, challenge.challenged_jid]
      );
    }
    await runQuery("UPDATE suit_challenges SET status = 'REFUNDED' WHERE id = ?", [challengeId]);
  });
}


// --- AFK MANAGEMENT SYSTEM ---
export async function setAfk(jid, reason = 'Tanpa alasan') {
  const time = Date.now();
  await runQuery(
    "INSERT OR REPLACE INTO afk_users (jid, reason, time) VALUES (?, ?, ?)",
    [jid, reason, time]
  );
  return { jid, reason, time };
}

export async function getAfk(jid) {
  return await getQuery("SELECT * FROM afk_users WHERE jid = ?", [jid]);
}

export async function removeAfk(jid) {
  const afk = await getAfk(jid);
  if (afk) {
    await runQuery("DELETE FROM afk_users WHERE jid = ?", [jid]);
  }
  return afk;
}

// Memory Cooldown Map untuk Chat XP (+10 XP max per 30 detik per user)
const xpCooldowns = new Map();

/**
 * Mendapatkan gelar rank berdasarkan level
 */
export function getRankBadgeTitle(level) {
  if (level >= 50) return 'Sultan Legendaris 👑';
  if (level >= 30) return 'Penguasa Grup ⚔️';
  if (level >= 20) return 'Sepuh Kasepuhan 💎';
  if (level >= 15) return 'Bintang Grup 🌟';
  if (level >= 10) return 'Member Elit 🥇';
  if (level >= 5) return 'Member Aktif 🥈';
  return 'Warga Baru 🥉';
}

/**
 * Menambahkan XP secara atomik. **Ini yang harus dipakai semua modul game**
 * untuk memberi hadiah XP — jangan pakai `addMessageXp`.
 *
 * Dua bug diperbaiki di sini sekaligus:
 *
 * 1. *Hadiah XP hilang diam-diam.* 23 modul game dulu memanggil `addMessageXp`,
 *    yang punya cooldown 30 detik milik XP chat grup. Hook XP chat di bot.js
 *    berjalan SEBELUM perintah diproses, jadi jendela 30 detik pemain hampir
 *    selalu sudah terbakar oleh perintahnya sendiri (`.serang`, `.bid`, dst).
 *    Akibatnya angka "+100 XP" di pesan kemenangan sering tidak pernah masuk DB.
 *    Yang paling parah: blackjack, jailbreak, quizTournament, duelRoulette,
 *    umaDerby, dan loot XP lelang — di situ XP ini SATU-SATUNYA sumber XP.
 * 2. *Penulisan non-atomik.* Versi lama membaca XP lalu menulis balik nilai
 *    penuh (`SET xp = ?`) lewat query polos di luar transaksi. `withTransaction`
 *    hanya menyerialkan sesama transaksi, jadi tulisan itu bisa menimpa XP yang
 *    baru saja ditambahkan `awardGamePoints` — keduanya dipanggil berurutan
 *    untuk tiap anggota party di raidBoss.js.
 */
export async function grantXp(customerJid, xpAmount = 10) {
  const profile = await getGameProfile(customerJid);
  const oldLevel = Math.max(1, Number(profile.level) || 1);
  // Power-Up XP Booster dari toko poin `.tukar` dikalikan di sini.
  const xpBoost = await getBuffMultiplier(customerJid, 'XP_BOOST');
  const grantedXp = Math.max(0, Math.round((Number(xpAmount) || 0) * xpBoost));

  if (grantedXp <= 0) {
    return {
      leveledUp: false,
      oldLevel,
      newLevel: oldLevel,
      titleBadge: getRankBadgeTitle(oldLevel),
      xp: Math.max(0, Number(profile.xp) || 0),
      profile
    };
  }

  return withTransaction(async () => {
    await runQuery(
      "UPDATE game_profiles SET xp = COALESCE(xp, 0) + ?, updated_at = CURRENT_TIMESTAMP WHERE customer_jid = ?",
      [grantedXp, customerJid]
    );
    const segar = await getGameProfile(customerJid);
    const newXp = Math.max(0, Number(segar.xp) || 0);
    const newLevel = Math.floor(newXp / 100) + 1;
    if (newLevel !== segar.level) {
      await runQuery("UPDATE game_profiles SET level = ? WHERE customer_jid = ?", [newLevel, customerJid]);
    }
    return {
      leveledUp: newLevel > oldLevel,
      oldLevel,
      newLevel,
      titleBadge: getRankBadgeTitle(newLevel),
      xp: newXp,
      profile: { ...segar, xp: newXp, level: newLevel }
    };
  });
}

/**
 * XP dari mengetik di grup. **Khusus hook chat di bot.js** — cooldown 30 detik
 * di sini adalah rem anti-spam untuk XP chat, bukan aturan hadiah game.
 * Modul game harus memanggil `grantXp` langsung.
 */
export async function addMessageXp(customerJid, xpAmount = 10) {
  const now = Date.now();
  const lastXpTime = xpCooldowns.get(customerJid) || 0;
  if (now - lastXpTime < 30000) {
    return { leveledUp: false };
  }
  xpCooldowns.set(customerJid, now);
  return grantXp(customerJid, xpAmount);
}

// ============================================================
// CASAKU PAYMENT SYSTEM HELPER FUNCTIONS
// ============================================================

/**
 * Get the most recent order (WAITING_PAYMENT or CART) for a customer including items.
 */
export async function getLastOrderByCustomer(customerNomor) {
  const order = await getQuery(
    `SELECT o.*, c.nama as customer_nama
     FROM orders o
     JOIN customers c ON o.customer_nomor = c.nomor
     WHERE o.customer_nomor = ? AND o.status IN ('WAITING_PAYMENT', 'CART')
     ORDER BY o.created_at DESC LIMIT 1`,
    [customerNomor]
  );
  if (!order) return null;
  const items = await allQuery(
    `SELECT oi.*, p.nama as produk_nama, p.delivery_type
     FROM order_items oi
     JOIN products p ON oi.produk_kode = p.kode
     WHERE oi.order_id = ?`,
    [order.order_id]
  );
  return { ...order, items };
}

/**
 * Create a Casaku payment transaction record after generating a QRIS.
 * @param {string} orderId
 * @param {string} casakuTransactionId - provider_transaction_id from Casaku
 * @param {number} expectedAmount - total + unique code
 * @param {number} expiryMinutes
 */
export async function createCasakuTransaction(orderId, casakuTransactionId, expectedAmount, expiryMinutes = 15, qrString = null) {
  const now = Date.now();
  const expiredAt = now + expiryMinutes * 60 * 1000;
  const txId = `PT-${orderId}-${now}`;

  await withTransaction(async () => {
    await runQuery(
      `INSERT INTO payment_transactions (id, order_id, provider, provider_transaction_id, expected_amount, status, created_at, qr_string)
       VALUES (?, ?, 'casaku', ?, ?, 'PENDING', ?, ?)`,
      [txId, orderId, casakuTransactionId, expectedAmount, now, qrString]
    );
    await runQuery(
      `UPDATE orders SET payment_amount = ?, payment_status = 'PENDING', casaku_transaction_id = ?, expired_at = ?, status = 'WAITING_PAYMENT', qr_string = ? WHERE order_id = ?`,
      [expectedAmount, casakuTransactionId, expiredAt, qrString, orderId]
    );
  });

  return { txId, expiredAt };
}

/**
 * Mendapatkan data invoice publik untuk Web Checkout / Pay Page
 */
export async function getOrderPublicInvoice(orderId) {
  // Dynamic import: storeDb sudah mengimpor modul ini, jadi import statis akan
  // membentuk siklus storeDb <-> gamesDb.
  const { getOrderDetails } = await import('./storeDb.js');
  const order = await getOrderDetails(orderId);
  if (!order) return null;

  const casakuTx = await getQuery(
    "SELECT * FROM payment_transactions WHERE order_id = ? ORDER BY created_at DESC LIMIT 1",
    [orderId]
  );

  return {
    order_id: order.order_id,
    customer_nama: order.customer_nama || 'Pelanggan Setia',
    customer_nomor: order.customer_nomor ? (order.customer_nomor.replace(/[^0-9]/g, '').substring(0, 4) + '****' + order.customer_nomor.slice(-3)) : '',
    total: order.total,
    payment_amount: casakuTx ? casakuTx.expected_amount : (order.payment_amount || order.total),
    unique_code: (order.payment_amount && order.total && order.payment_amount > order.total) ? (order.payment_amount - order.total) : 0,
    status: order.status,
    payment_status: order.payment_status,
    fulfillment_status: order.fulfillment_status,
    created_at: order.created_at,
    expired_at: order.expired_at || (casakuTx ? casakuTx.created_at + 15 * 60 * 1000 : null),
    qr_string: order.qr_string || (casakuTx ? casakuTx.qr_string : null),
    warranty_until: order.warranty_until,
    items: (order.items || []).map(i => ({
      nama: i.produk_nama,
      kode: i.produk_kode,
      qty: i.qty || i.jumlah || 1,
      harga: i.harga_satuan,
      subtotal: i.subtotal || (i.harga_satuan * (i.qty || i.jumlah || 1)),
      delivery_type: i.delivery_type
    }))
  };
}

/**
 * Atomically mark an order as PAID. Returns true only if the order was transitioned
 * from PENDING to PAID (i.e. not already processed). Ensures idempotency.
 * @param {string} casakuTransactionId
 * @param {number} receivedAmount
 * @returns {{ success: boolean, orderId: string|null, customerNumber: string|null }}
 */
export async function markTransactionPaid(casakuTransactionId, receivedAmount) {
  return withTransaction(async () => {
    const tx = await getQuery(
      `SELECT pt.*, o.customer_nomor, o.payment_status, o.coupon_code, o.coupon_redeemed
       FROM payment_transactions pt
       JOIN orders o ON pt.order_id = o.order_id
       WHERE pt.provider_transaction_id = ? AND pt.provider = 'casaku'`,
      [casakuTransactionId]
    );

    if (!tx) return { success: false, reason: 'TRANSACTION_NOT_FOUND', orderId: null, customerNumber: null };
    if (tx.status === 'PAID') return { success: false, reason: 'ALREADY_PAID', orderId: tx.order_id, customerNumber: tx.customer_nomor };
    if (tx.expected_amount !== receivedAmount) return { success: false, reason: 'AMOUNT_MISMATCH', orderId: tx.order_id, customerNumber: tx.customer_nomor, expected: tx.expected_amount, received: receivedAmount };

    const now = Date.now();
    // Atomic PENDING → PAID using WHERE guard
    const result = await runQuery(
      `UPDATE orders SET payment_status = 'PAID', status = 'COMPLETED', updated_at = ? WHERE order_id = ? AND payment_status = 'PENDING'`,
      [now, tx.order_id]
    );

    if (result.changes === 0) return { success: false, reason: 'ALREADY_PAID', orderId: tx.order_id, customerNumber: tx.customer_nomor };

    await runQuery(
      `UPDATE payment_transactions SET status = 'PAID', received_amount = ?, paid_at = ? WHERE id = ?`,
      [receivedAmount, now, tx.id]
    );

    // Top-up deposit handling: credit customer balance
    if (tx.order_id.startsWith('DEP-')) {
      await addCustomerBalance(tx.customer_nomor, tx.expected_amount, 'DEPOSIT', `Top-up deposit via QRIS #${tx.order_id}`);
      await addLog('BALANCE', `💰 Auto-deposit Rp${tx.expected_amount.toLocaleString('id-ID')} berhasil via Casaku QRIS untuk ${tx.customer_nomor}`);
    } else {
      // Redim kupon jika ada
      if (tx.coupon_code && !tx.coupon_redeemed) {
        await runQuery(
          "UPDATE coupons SET used_count = used_count + 1 WHERE code = ? AND (max_uses = 0 OR used_count < max_uses)",
          [tx.coupon_code]
        );
        await runQuery("UPDATE orders SET coupon_redeemed = 1 WHERE order_id = ?", [tx.order_id]);
      }

      // Award 10 Poin per Rp10.000 spent for real product purchases
      const pointsAwarded = Math.floor(receivedAmount / 10000) * 10;
      if (pointsAwarded > 0) {
        await runQuery(
          `INSERT INTO game_profiles (customer_jid, points, xp) VALUES (?, ?, ?)
           ON CONFLICT(customer_jid) DO UPDATE SET points = points + ?, xp = xp + ?`,
          [tx.customer_nomor, pointsAwarded, pointsAwarded, pointsAwarded, pointsAwarded]
        );
        await runQuery(
          `INSERT INTO point_logs (customer_nomor, type, points, description) VALUES (?, 'EARN_PURCHASE', ?, ?)`,
          [tx.customer_nomor, pointsAwarded, `Poin dari belanja QRIS Order #${tx.order_id}`]
        );
      }
      // Unlock referral reward (50 Poin) if this is customer's first purchase >= Rp10.000
      try {
        await verifyAndRewardReferral(tx.customer_nomor, receivedAmount);
      } catch (refErr) {}
    }

    return { success: true, reason: 'PAID', orderId: tx.order_id, customerNumber: tx.customer_nomor, isDeposit: tx.order_id.startsWith('DEP-') };
  });
}



/**
 * Create a fulfillment job after payment is confirmed.
 */
export async function createFulfillmentJob(orderId, customerNumber) {
  const now = Date.now();
  const jobId = `FJ-${orderId}-${now}`;
  await runQuery(
    `INSERT OR IGNORE INTO fulfillment_jobs (job_id, order_id, customer_number, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'PENDING', 0, ?, ?)`,
    [jobId, orderId, customerNumber, now, now]
  );
  return jobId;
}

/**
 * Job pengiriman yang perlu dikerjakan worker: PENDING, FAILED, dan PROCESSING
 * yang tersangkut.
 *
 * PROCESSING wajib ikut. Kalau bot mati atau restart tepat saat sebuah job
 * sedang dikirim, statusnya berhenti selamanya di PROCESSING dan sebelumnya
 * tidak pernah diambil worker mana pun — artinya order yang SUDAH DIBAYAR tidak
 * pernah terkirim dan tidak ada yang tahu. Mengulanginya aman karena
 * claimAndDeliverItems mencari item USED milik order ini lebih dulu sebelum
 * menyentuh stok baru, jadi tidak ada lisensi kedua yang terbakar.
 *
 * CAST dipakai karena baris lama bisa menyimpan updated_at sebagai teks tanggal;
 * hasil CAST-nya jadi angka kecil sehingga baris itu ikut dianggap stale — arah
 * yang aman (diproses ulang) ketimbang terlewat selamanya.
 */
export async function getPendingFulfillmentJobs(staleProcessingMs = 5 * 60 * 1000) {
  const ambang = Date.now() - Math.max(60_000, Number(staleProcessingMs) || 0);
  return allQuery(
    `SELECT fj.*, o.payment_amount, o.casaku_transaction_id
     FROM fulfillment_jobs fj
     JOIN orders o ON fj.order_id = o.order_id
     WHERE fj.status IN ('PENDING', 'FAILED')
        OR (fj.status = 'PROCESSING' AND CAST(fj.updated_at AS INTEGER) <= ?)
     ORDER BY fj.created_at ASC`
    , [ambang]
  );
}

/**
 * Set a fulfillment job status to PROCESSING without incrementing attempt count.
 */
export async function setFulfillmentJobProcessing(jobId) {
  await runQuery(
    `UPDATE fulfillment_jobs SET status = 'PROCESSING', updated_at = ? WHERE job_id = ?`,
    [Date.now(), jobId]
  );
}

/**
 * Update a fulfillment job's status, attempts, and optional error.
 */
export async function updateFulfillmentJob(jobId, status, lastError = null) {
  await runQuery(
    `UPDATE fulfillment_jobs SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE job_id = ?`,
    [status, lastError, Date.now(), jobId]
  );
}

/**
 * Log a received webhook event for audit purposes.
 */
export async function logWebhookEvent(transactionId, signature, payload, processingStatus = 'RECEIVED') {
  const now = Date.now();
  const id = `WH-${transactionId}-${now}`;
  await runQuery(
    `INSERT INTO payment_webhooks (id, provider, transaction_id, signature, payload, received_at, processing_status)
     VALUES (?, 'casaku', ?, ?, ?, ?, ?)`,
    [id, transactionId || 'unknown', signature || '', JSON.stringify(payload), now, processingStatus]
  );
  return id;
}

/**
 * Update webhook log processing status after handling.
 */
export async function updateWebhookStatus(webhookLogId, processingStatus) {
  await runQuery(
    `UPDATE payment_webhooks SET processing_status = ?, processed_at = ? WHERE id = ?`,
    [processingStatus, Date.now(), webhookLogId]
  );
}

/**
 * Expire stale PENDING orders older than given minutes. Releases RESERVED product_items.
 */
export async function expireStaleOrders(expiryMinutes = 15) {
  const cutoff = Date.now() - expiryMinutes * 60 * 1000;
  const staleOrders = await allQuery(
    `SELECT order_id FROM orders WHERE payment_status = 'PENDING' AND status = 'WAITING_PAYMENT' AND expired_at < ?`,
    [Date.now()]
  );

  for (const order of staleOrders) {
    await withTransaction(async () => {
      // Release reserved product_items back to READY
      await runQuery(
        `UPDATE product_items SET status = 'READY', order_id = NULL WHERE order_id = ? AND status = 'RESERVED'`,
        [order.order_id]
      );
      // Restore manual stock items
      const manualItems = await allQuery(
        `SELECT oi.produk_kode, oi.qty FROM order_items oi WHERE oi.order_id = ? AND oi.stock_reserved = 1`,
        [order.order_id]
      );
      for (const item of manualItems) {
        await runQuery(`UPDATE products SET stok = stok + ? WHERE kode = ?`, [item.qty, item.produk_kode]);
      }
      await runQuery(
        `UPDATE order_items SET stock_reserved = 0 WHERE order_id = ?`,
        [order.order_id]
      );
      // Mark order expired
      await runQuery(
        `UPDATE orders SET payment_status = 'EXPIRED', status = 'CANCELLED', updated_at = ? WHERE order_id = ?`,
        [Date.now(), order.order_id]
      );
      await runQuery(
        `UPDATE payment_transactions SET status = 'EXPIRED' WHERE order_id = ? AND status = 'PENDING'`,
        [order.order_id]
      );
    });
  }

  return staleOrders.length;
}

/**
 * Get stale PENDING orders for reconciliation check (older than thresholdMinutes).
 */
export async function getStalePendingOrders(thresholdMinutes = 3) {
  const safeMinutes = Math.max(1, Math.floor(Number(thresholdMinutes) || 3));
  return allQuery(
    `SELECT o.order_id, o.casaku_transaction_id, o.customer_nomor, o.payment_amount, o.created_at
     FROM orders o
     WHERE o.payment_status = 'PENDING' AND o.status = 'WAITING_PAYMENT'
     AND o.casaku_transaction_id IS NOT NULL
     AND o.created_at <= datetime('now', '-' || ? || ' minutes')`,
    [safeMinutes]
  );
}

// ============================================================
// PREMIUM 2.0 & RESELLER HELPER FUNCTIONS
// ============================================================

/**
 * Get AI usage count today for a user.
 */
/**
 * Kuota AI harian memakai tanggal WIB, bukan UTC.
 *
 * `new Date().toISOString()` menghasilkan tanggal UTC, jadi kuotanya dulu berganti
 * pukul 07:00 WIB — bukan tengah malam. Dua akibatnya: pemain yang kuotanya habis
 * malam ini harus menunggu sampai pagi, dan siapa pun yang tahu polanya bisa
 * memakai jatah penuh pukul 06:59 lalu memakai jatah penuh lagi pukul 07:01,
 * yakni dua kali kuota berbayar dalam dua menit.
 */
export async function getAiUsageToday(jid) {
  const todayStr = tanggalWIB();
  const row = await getQuery(
    "SELECT count FROM ai_usage_logs WHERE jid = ? AND usage_date = ?",
    [jid, todayStr]
  );
  return row ? row.count : 0;
}

/**
 * Increment AI usage count today for a user.
 */
export async function incrementAiUsage(jid) {
  const todayStr = tanggalWIB();
  await runQuery(
    `INSERT INTO ai_usage_logs (jid, usage_date, count) VALUES (?, ?, 1)
     ON CONFLICT(jid, usage_date) DO UPDATE SET count = count + 1`,
    [jid, todayStr]
  );
  return await getAiUsageToday(jid);
}

// ============================================================
// KUOTA DOWNLOADER HARIAN
// ============================================================
/**
 * Memakai tanggal WIB, sama seperti kuota AI — supaya jatah berganti tengah
 * malam menurut jam pemain, bukan pukul 07:00 WIB seperti kalau memakai UTC.
 */
export async function getMediaUsageToday(jid) {
  const row = await getQuery(
    "SELECT count FROM media_usage_logs WHERE jid = ? AND usage_date = ?",
    [jid, tanggalWIB()]
  );
  return row ? row.count : 0;
}

export async function incrementMediaUsage(jid) {
  const todayStr = tanggalWIB();
  await runQuery(
    `INSERT INTO media_usage_logs (jid, usage_date, count) VALUES (?, ?, 1)
     ON CONFLICT(jid, usage_date) DO UPDATE SET count = count + 1`,
    [jid, todayStr]
  );
  return await getMediaUsageToday(jid);
}

/** Buang catatan pemakaian yang sudah lewat, dipanggil scheduler. */
export async function bersihkanPemakaianMediaLama(simpanHari = 7) {
  const batas = new Date(Date.now() + 7 * 60 * 60 * 1000 - simpanHari * 86400000)
    .toISOString().slice(0, 10);
  const res = await runQuery("DELETE FROM media_usage_logs WHERE usage_date < ?", [batas]);
  return res.changes || 0;
}


/**
 * Add product to user's wishlist.
 */
export async function addWishlist(jid, produkKode) {
  try {
    await runQuery(
      "INSERT INTO user_wishlists (jid, produk_kode) VALUES (?, ?)",
      [jid, produkKode.toUpperCase()]
    );
    return { success: true };
  } catch (err) {
    return { success: false, message: "Produk sudah ada di wishlist Anda." };
  }
}

/**
 * Remove product from user's wishlist.
 */
export async function removeWishlist(jid, produkKode) {
  const res = await runQuery(
    "DELETE FROM user_wishlists WHERE jid = ? AND produk_kode = ?",
    [jid, produkKode.toUpperCase()]
  );
  return { success: res.changes > 0 };
}

/**
 * Get all user JIDs who wishlisted a product.
 */
export async function getWishlistSubscribers(produkKode) {
  const rows = await allQuery(
    "SELECT jid FROM user_wishlists WHERE produk_kode = ?",
    [produkKode.toUpperCase()]
  );
  return rows.map(r => r.jid);
}

/**
 * Create a new reseller product listing.
 */
export async function createResellerProduct(sellerJid, sellerNama, nama, harga, stok, isiProduk) {
  const res = await runQuery(
    `INSERT INTO reseller_products (seller_jid, seller_nama, nama, harga, stok, isi_produk)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sellerJid, sellerNama, nama, harga, stok, isiProduk]
  );
  return { id: res.lastID, sellerJid, nama, harga, stok };
}

/**
 * Get active reseller products list.
 */
export async function getResellerProducts() {
  return await allQuery(
    "SELECT * FROM reseller_products WHERE status = 'ACTIVE' AND stok > 0 ORDER BY id DESC"
  );
}

/**
 * Buy a product from a reseller lapak. Transfers 98% of total amount to seller's balance (2% admin fee).
 */
export async function buyResellerProduct(buyerJid, lapakId) {
  return withTransaction(async () => {
    const item = await getQuery(
      "SELECT * FROM reseller_products WHERE id = ? AND status = 'ACTIVE' AND stok > 0",
      [lapakId]
    );

    if (!item) {
      return { success: false, message: "Produk lapak tidak ditemukan atau stok habis." };
    }

    if (item.seller_jid === buyerJid) {
      return { success: false, message: "Anda tidak bisa membeli produk dari lapak Anda sendiri." };
    }

    const buyer = await getCustomerMembershipProfile(buyerJid);
    if ((buyer?.balance || 0) < item.harga) {
      return { success: false, message: `Saldo Anda tidak cukup (Harga: Rp${item.harga.toLocaleString('id-ID')}, Saldo Anda: Rp${(buyer?.balance || 0).toLocaleString('id-ID')}). Ketik .deposit untuk isi saldo.` };
    }

    // Deduct buyer balance
    await runQuery("UPDATE customers SET balance = balance - ? WHERE nomor = ?", [item.harga, buyerJid]);

    // Calculate 98% seller payout (2% admin fee)
    const sellerPayout = Math.floor(item.harga * 0.98);
    await runQuery("UPDATE customers SET balance = balance + ? WHERE nomor = ?", [sellerPayout, item.seller_jid]);

    // Deduct stock
    const newStock = item.stok - 1;
    const newStatus = newStock <= 0 ? 'SOLD_OUT' : 'ACTIVE';
    await runQuery("UPDATE reseller_products SET stok = ?, status = ? WHERE id = ?", [newStock, newStatus, lapakId]);

    await addLog("RESELLER", `Lapak #${lapakId} (${item.nama}) dibeli oleh ${buyerJid}. Seller ${item.seller_jid} terima Rp${sellerPayout.toLocaleString('id-ID')}`);

    return {
      success: true,
      item,
      sellerPayout,
      isiProduk: item.isi_produk
    };
  });
}

/**
 * Claim monthly free voucher/bonus balance for premium users.
 */
export async function claimMonthlyVoucher(jid, amount = 10000) {
  const now = new Date();
  const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const existing = await getQuery(
    "SELECT id FROM premium_monthly_claims WHERE jid = ? AND claim_month = ?",
    [jid, monthStr]
  );

  if (existing) {
    return { success: false, message: `Anda sudah mengklaim voucher bulanan untuk bulan ${monthStr}.` };
  }

  await withTransaction(async () => {
    await runQuery(
      "INSERT INTO premium_monthly_claims (jid, claim_month) VALUES (?, ?)",
      [jid, monthStr]
    );
    await runQuery(
      "UPDATE customers SET balance = balance + ? WHERE nomor = ?",
      [amount, jid]
    );
    await addLog("PREMIUM", `Voucher bulanan Rp${amount.toLocaleString('id-ID')} diklaim oleh ${jid} (${monthStr})`);
  });

  return { success: true, amount, monthStr };
}

// ============================================================
// FINANCIAL & POINTS SECURITY ENGINE HELPER FUNCTIONS
// ============================================================

/**
 * Atomically deduct customer balance using SQLite WHERE guard.
 * Prevents double-spending & negative balance.
 */
export async function deductCustomerBalance(customerNomor, amount, description = 'PEMBELIAN_PRODUK') {
  const safeAmount = Math.floor(Number(amount));
  if (isNaN(safeAmount) || safeAmount <= 0 || !isFinite(safeAmount)) {
    return { success: false, reason: 'INVALID_AMOUNT', message: 'Nominal tidak valid.' };
  }

  return withTransaction(async () => {
    const result = await runQuery(
      `UPDATE customers SET balance = balance - ? WHERE nomor = ? AND balance >= ?`,
      [safeAmount, customerNomor, safeAmount]
    );

    if (result.changes === 0) {
      const cust = await getQuery("SELECT balance FROM customers WHERE nomor = ?", [customerNomor]);
      return {
        success: false,
        reason: 'INSUFFICIENT_BALANCE',
        currentBalance: cust?.balance || 0,
        message: `Saldo tidak cukup (Butuh: Rp${safeAmount.toLocaleString('id-ID')}, Saldo Anda: Rp${(cust?.balance || 0).toLocaleString('id-ID')}).`
      };
    }

    await runQuery(
      `INSERT INTO financial_logs (customer_nomor, type, amount, source, description) VALUES (?, 'PURCHASE', ?, 'SYSTEM', ?)`,
      [customerNomor, safeAmount, description]
    );

    const updated = await getQuery("SELECT balance FROM customers WHERE nomor = ?", [customerNomor]);
    return { success: true, newBalance: updated.balance };
  });
}

/**
 * Atomically add customer balance (for deposits/refunds/reseller payout).
 */
export async function addCustomerBalance(customerNomor, amount, source = 'DEPOSIT', description = 'Top Up Deposit Saldo') {
  const safeAmount = Math.floor(Number(amount));
  if (isNaN(safeAmount) || safeAmount <= 0 || !isFinite(safeAmount)) {
    return { success: false, reason: 'INVALID_AMOUNT' };
  }

  return withTransaction(async () => {
    // Ensure customer record exists
    await getOrCreateCustomer(customerNomor, 'Pelanggan');

    await runQuery(
      `UPDATE customers SET balance = balance + ? WHERE nomor = ?`,
      [safeAmount, customerNomor]
    );

    await runQuery(
      `INSERT INTO financial_logs (customer_nomor, type, amount, source, description) VALUES (?, ?, ?, ?, ?)`,
      [customerNomor, source, safeAmount, source, description]
    );

    const updated = await getQuery("SELECT balance FROM customers WHERE nomor = ?", [customerNomor]);
    return { success: true, newBalance: updated.balance };
  });
}

/**
 * Atomically deduct customer Akbar Poin.
 */
export async function deductCustomerPoints(customerNomor, pointsToDeduct, description = 'TUKAR_POIN') {
  const safePoints = Math.floor(Number(pointsToDeduct));
  if (isNaN(safePoints) || safePoints <= 0 || !isFinite(safePoints)) {
    return { success: false, reason: 'INVALID_POINTS' };
  }

  return withTransaction(async () => {
    await getGameProfile(customerNomor);
    const result = await runQuery(
      `UPDATE game_profiles SET points = MAX(0, COALESCE(points, 0) - ?) WHERE customer_jid = ? AND COALESCE(points, 0) >= ?`,
      [safePoints, customerNomor, safePoints]
    );

    if (result.changes === 0) {
      const prof = await getGameProfile(customerNomor);
      return { success: false, reason: 'INSUFFICIENT_POINTS', currentPoints: prof?.points || 0 };
    }

    await runQuery(
      `INSERT INTO point_logs (customer_nomor, type, points, description) VALUES (?, 'DEDUCT_REDEEM', ?, ?)`,
      [customerNomor, safePoints, description]
    );

    const updated = await getGameProfile(customerNomor);
    return { success: true, newPoints: updated.points };
  });
}

/**
 * Award Akbar Poin for real purchase (10 Poin / Rp10.000 spent via QRIS).
 */
export async function awardPurchasePoints(customerNomor, orderTotal) {
  const pointsEarned = Math.floor(orderTotal / 10000) * 10;
  if (pointsEarned <= 0) return 0;

  await withTransaction(async () => {
    await runQuery(
      `INSERT INTO game_profiles (customer_jid, points, xp) VALUES (?, ?, ?)
       ON CONFLICT(customer_jid) DO UPDATE SET points = COALESCE(points, 0) + ?, xp = COALESCE(xp, 0) + ?`,
      [customerNomor, pointsEarned, pointsEarned, pointsEarned, pointsEarned]
    );
    await runQuery(
      `INSERT INTO point_logs (customer_nomor, type, points, description) VALUES (?, 'EARN_PURCHASE', ?, ?)`,
      [customerNomor, pointsEarned, `Poin dari belanja Rp${orderTotal.toLocaleString('id-ID')}`]
    );
  });

  return pointsEarned;
}

/**
 * Register referral pair with first-purchase lock.
 */
export async function registerReferral(referrerNomor, referredNomor) {
  if (referrerNomor === referredNomor) return { success: false, message: 'Tidak bisa referral diri sendiri.' };
  try {
    await runQuery(
      `INSERT INTO referral_verifications (referrer_nomor, referred_nomor, status) VALUES (?, ?, 'PENDING_FIRST_PURCHASE')`,
      [referrerNomor, referredNomor]
    );
    return { success: true };
  } catch {
    return { success: false, message: 'Nomor ini sudah terdaftar referral.' };
  }
}

/**
 * Verify first purchase and unlock referral reward (50 Poin to referrer).
 */
export async function verifyAndRewardReferral(referredNomor, purchaseAmount) {
  if (purchaseAmount < 10000) return null; // Must be min Rp10.000 purchase

  return withTransaction(async () => {
    const ref = await getQuery(
      `SELECT * FROM referral_verifications WHERE referred_nomor = ? AND status = 'PENDING_FIRST_PURCHASE'`,
      [referredNomor]
    );

    if (!ref) return null;

    const rewardPoints = 50;
    await runQuery(
      `UPDATE referral_verifications SET status = 'UNLOCKED', points_awarded = ?, unlocked_at = CURRENT_TIMESTAMP WHERE referred_nomor = ?`,
      [rewardPoints, referredNomor]
    );

    await runQuery(
      `INSERT INTO game_profiles (customer_jid, points, xp) VALUES (?, ?, ?)
       ON CONFLICT(customer_jid) DO UPDATE SET points = COALESCE(points, 0) + ?, xp = COALESCE(xp, 0) + ?`,
      [ref.referrer_nomor, rewardPoints, rewardPoints, rewardPoints, rewardPoints]
    );

    await runQuery(
      `INSERT INTO point_logs (customer_nomor, type, points, description) VALUES (?, 'EARN_REFERRAL', ?, ?)`,
      [ref.referrer_nomor, rewardPoints, `Referral bonus dari ${referredNomor} (belanja pertama Rp${purchaseAmount.toLocaleString('id-ID')})`]
    );

    return { referrerNomor: ref.referrer_nomor, rewardPoints };
  });
}

/**
 * Redeem points for a discount coupon.
 *
 * ⚠️ DEAD CODE — TIDAK ADA PEMANGGILNYA, DAN MEMANG SENGAJA.
 * Fungsi ini memotong game_profiles.points (Akbar Poin hasil main game) lalu
 * mencetak kupon diskon yang berlaku di checkout — artinya poin jadi punya nilai
 * rupiah. Kebijakan ekonomi bot sekarang: Akbar Poin murni skor + power-up
 * (`.tukar`), dan semua yang bernilai uang (Premium, saldo) hanya dibeli dengan
 * uang asli lewat `.deposit`. Jangan wire fungsi ini ke command apa pun tanpa
 * persetujuan owner — itu membuka lagi jalur cetak-uang dari grinding game.
 */
export async function redeemPointsForCoupon(customerNomor, couponTier) {
  const couponConfig = {
    5: { points: 100, discountPct: 5, minOrder: 20000 },
    10: { points: 250, discountPct: 10, minOrder: 35000 },
    20: { points: 500, discountPct: 20, minOrder: 50000 }
  }[couponTier];

  if (!couponConfig) return { success: false, message: 'Pilihan kupon tidak valid. Pilih: 5, 10, atau 20.' };

  const deductRes = await deductCustomerPoints(customerNomor, couponConfig.points, `TUKAR_KUPON_${couponConfig.discountPct}%`);
  if (!deductRes.success) {
    return { success: false, message: `Poin Anda tidak cukup (Butuh: ${couponConfig.points} Poin).` };
  }

  // Generate unique coupon code
  const code = `POIN${couponConfig.discountPct}-${Math.floor(1000 + Math.random() * 9000)}`;
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await runQuery(
    `INSERT INTO coupons (code, type, value, min_order, max_uses, used_count, expires_at, is_active)
     VALUES (?, 'percent', ?, ?, 1, 0, ?, 1)`,
    [code, couponConfig.discountPct, couponConfig.minOrder, expiresAt]
  );

  return {
    success: true,
    code,
    discountPct: couponConfig.discountPct,
    minOrder: couponConfig.minOrder,
    remainingPoints: deductRes.newPoints
  };
}

// ==============================================================================
// 10. GROUP RENTALS (INVITED ONLY)
// ==============================================================================

export async function addGroupRental(groupJid, days, addedBy) {
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  await runQuery(
    "INSERT OR REPLACE INTO group_rentals (group_jid, expires_at, added_by) VALUES (?, ?, ?)",
    [groupJid, expiresAt, addedBy]
  );
  return expiresAt;
}

export async function getGroupRental(groupJid) {
  return await getQuery("SELECT * FROM group_rentals WHERE group_jid = ?", [groupJid]);
}

export async function getExpiredGroupRentals() {
  const now = new Date().toISOString();
  return await allQuery("SELECT * FROM group_rentals WHERE expires_at <= ?", [now]);
}

export async function removeGroupRental(groupJid) {
  return await runQuery("DELETE FROM group_rentals WHERE group_jid = ?", [groupJid]);
}
export async function incrementGroupChatStats(groupJid, participantJid) {
  const query = `
    INSERT INTO group_chat_stats (group_jid, participant_jid, msg_count)
    VALUES (?, ?, 1)
    ON CONFLICT(group_jid, participant_jid) DO UPDATE SET msg_count = msg_count + 1
  `;
  return await runQuery(query, [groupJid, participantJid]);
}

export async function getTopGroupChatStats(groupJid, limit = 10) {
  return await allQuery("SELECT participant_jid, msg_count FROM group_chat_stats WHERE group_jid = ? ORDER BY msg_count DESC LIMIT ?", [groupJid, limit]);
}



// --- STATISTIK GAME UNDERCOVER ---
// Kolom counter yang boleh dinaikkan lewat bumpUndercoverCounter (whitelist,
// supaya nama kolom tidak pernah datang dari input pemain).
const UNDERCOVER_COUNTERS = [
  'mrwhite_guess_win',
  'jester_win',
  'sheriff_kills',
  'assassin_kills',
  'detective_correct'
];

export async function getUndercoverStats(customerJid) {
  await runQuery("INSERT OR IGNORE INTO undercover_stats (customer_jid) VALUES (?)", [customerJid]);
  const row = await getQuery("SELECT * FROM undercover_stats WHERE customer_jid = ?", [customerJid]);
  if (!row) {
    return {
      customer_jid: customerJid,
      games_played: 0, games_won: 0,
      times_civilian: 0, wins_civilian: 0,
      times_impostor: 0, wins_impostor: 0,
      times_neutral: 0, wins_neutral: 0,
      mrwhite_guess_win: 0, jester_win: 0,
      sheriff_kills: 0, assassin_kills: 0, detective_correct: 0,
      win_streak: 0, best_streak: 0, points_won: 0
    };
  }
  for (const key of Object.keys(row)) {
    if (key === 'customer_jid' || key === 'last_played' || key === 'updated_at') continue;
    row[key] = Math.max(0, Math.floor(Number(row[key]) || 0));
  }
  return row;
}

/**
 * Catat hasil satu pertandingan Undercover untuk seorang pemain.
 * faction: 'CIVILIAN' | 'IMPOSTOR' | 'NEUTRAL'
 */
export async function recordUndercoverResult(customerJid, { faction = 'CIVILIAN', won = false, prize = 0 } = {}) {
  if (!customerJid) return null;
  const current = await getUndercoverStats(customerJid);

  const factionKey = ['CIVILIAN', 'IMPOSTOR', 'NEUTRAL'].includes(faction) ? faction : 'CIVILIAN';
  const timesCol = { CIVILIAN: 'times_civilian', IMPOSTOR: 'times_impostor', NEUTRAL: 'times_neutral' }[factionKey];
  const winsCol = { CIVILIAN: 'wins_civilian', IMPOSTOR: 'wins_impostor', NEUTRAL: 'wins_neutral' }[factionKey];

  const safePrize = Math.max(0, Math.floor(Number(prize) || 0));
  const newStreak = won ? (current.win_streak || 0) + 1 : 0;
  const bestStreak = Math.max(current.best_streak || 0, newStreak);

  await runQuery(
    `UPDATE undercover_stats SET
       games_played = games_played + 1,
       games_won = games_won + ?,
       ${timesCol} = ${timesCol} + 1,
       ${winsCol} = ${winsCol} + ?,
       win_streak = ?,
       best_streak = ?,
       points_won = points_won + ?,
       last_played = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP
     WHERE customer_jid = ?`,
    [won ? 1 : 0, won ? 1 : 0, newStreak, bestStreak, safePrize, customerJid]
  );

  return await getUndercoverStats(customerJid);
}

export async function bumpUndercoverCounter(customerJid, field, amount = 1) {
  if (!customerJid || !UNDERCOVER_COUNTERS.includes(field)) return null;
  const safeAmount = Math.max(1, Math.floor(Number(amount) || 1));
  await runQuery("INSERT OR IGNORE INTO undercover_stats (customer_jid) VALUES (?)", [customerJid]);
  await runQuery(
    `UPDATE undercover_stats SET ${field} = ${field} + ?, updated_at = CURRENT_TIMESTAMP WHERE customer_jid = ?`,
    [safeAmount, customerJid]
  );
  return true;
}

export async function getUndercoverLeaderboard(limit = 10, minGames = 3) {
  const safeLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
  const safeMin = Math.max(1, Number.parseInt(minGames, 10) || 3);
  return await allQuery(
    `SELECT u.customer_jid,
            COALESCE(u.games_played, 0) AS games_played,
            COALESCE(u.games_won, 0) AS games_won,
            COALESCE(u.best_streak, 0) AS best_streak,
            COALESCE(u.points_won, 0) AS points_won,
            COALESCE(c.nama, 'Member') AS customer_nama
     FROM undercover_stats u
     LEFT JOIN customers c ON c.nomor = u.customer_jid
     WHERE COALESCE(u.games_played, 0) >= ?
     ORDER BY COALESCE(u.games_won, 0) DESC,
              (COALESCE(u.games_won, 0) * 1.0 / COALESCE(u.games_played, 1)) DESC,
              COALESCE(u.best_streak, 0) DESC
     LIMIT ?`,
    [safeMin, safeLimit]
  );
}


// ============================================================
// STATISTIK RAID WORLD BOSS
// ============================================================
// Dua tabel: `raid_stats` per pemain (untuk `.raidstats` & `.raidtop`) dan
// `raid_group_progress` per grup (untuk membuka Nightmare Mode dan menampilkan
// rekor grup di `.raid list`).

const RAID_BOSS_IDS = ['ignis', 'malakor', 'raijin', 'leviathan', 'erebus'];

export async function getRaidStats(customerJid) {
  if (!customerJid) return null;
  await runQuery("INSERT OR IGNORE INTO raid_stats (customer_jid) VALUES (?)", [customerJid]);
  const row = await getQuery("SELECT * FROM raid_stats WHERE customer_jid = ?", [customerJid]);
  if (!row) return null;

  for (const key of Object.keys(row)) {
    if (key === 'customer_jid' || key === 'last_played' || key === 'updated_at') continue;
    row[key] = Math.max(0, Math.floor(Number(row[key]) || 0));
  }
  return row;
}

/**
 * Catat hasil satu raid untuk seorang pemain.
 * `bossId` harus salah satu dari RAID_BOSS_IDS — nama kolom tidak boleh datang
 * dari input bebas.
 */
export async function recordRaidResult(customerJid, {
  won = false, bossId = null, damage = 0, healing = 0, absorbed = 0,
  mvpDamage = false, mvpSupport = false, ko = 0, prize = 0
} = {}) {
  if (!customerJid) return null;
  await runQuery("INSERT OR IGNORE INTO raid_stats (customer_jid) VALUES (?)", [customerJid]);

  const dmg = Math.max(0, Math.floor(Number(damage) || 0));
  const heal = Math.max(0, Math.floor(Number(healing) || 0));
  const abs = Math.max(0, Math.floor(Number(absorbed) || 0));
  const koCount = Math.max(0, Math.floor(Number(ko) || 0));
  const poin = Math.max(0, Math.floor(Number(prize) || 0));

  const kolomBoss = (won && RAID_BOSS_IDS.includes(bossId)) ? `kill_${bossId}` : null;

  await runQuery(
    `UPDATE raid_stats SET
       raids_joined = raids_joined + 1,
       raids_won = raids_won + ?,
       total_damage = total_damage + ?,
       total_healing = total_healing + ?,
       total_absorbed = total_absorbed + ?,
       best_damage = MAX(COALESCE(best_damage, 0), ?),
       mvp_damage = mvp_damage + ?,
       mvp_support = mvp_support + ?,
       times_ko = times_ko + ?,
       points_won = points_won + ?,
       ${kolomBoss ? `${kolomBoss} = ${kolomBoss} + 1,` : ''}
       last_played = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP
     WHERE customer_jid = ?`,
    [won ? 1 : 0, dmg, heal, abs, dmg, mvpDamage ? 1 : 0, mvpSupport ? 1 : 0, koCount, poin, customerJid]
  );

  return true;
}

export async function getRaidLeaderboard(limit = 10, minRaids = 1) {
  const safeLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
  const safeMin = Math.max(1, Number.parseInt(minRaids, 10) || 1);
  return await allQuery(
    `SELECT r.customer_jid,
            COALESCE(r.raids_joined, 0) AS raids_joined,
            COALESCE(r.raids_won, 0) AS raids_won,
            COALESCE(r.total_damage, 0) AS total_damage,
            COALESCE(r.mvp_damage, 0) AS mvp_damage,
            COALESCE(r.mvp_support, 0) AS mvp_support,
            COALESCE(c.nama, 'Member') AS customer_nama
     FROM raid_stats r
     LEFT JOIN customers c ON c.nomor = r.customer_jid
     WHERE COALESCE(r.raids_joined, 0) >= ?
     ORDER BY COALESCE(r.raids_won, 0) DESC,
              COALESCE(r.total_damage, 0) DESC,
              COALESCE(r.mvp_damage, 0) DESC
     LIMIT ?`,
    [safeMin, safeLimit]
  );
}

export async function getRaidGroupProgress(groupJid) {
  if (!groupJid) return null;
  await runQuery("INSERT OR IGNORE INTO raid_group_progress (group_jid) VALUES (?)", [groupJid]);
  const row = await getQuery("SELECT * FROM raid_group_progress WHERE group_jid = ?", [groupJid]);
  if (!row) return null;

  for (const key of Object.keys(row)) {
    if (key === 'group_jid' || key === 'updated_at') continue;
    row[key] = Math.max(0, Math.floor(Number(row[key]) || 0));
  }
  return row;
}

/** Catat satu boss yang berhasil ditumbangkan grup, plus rekor ronde tercepat. */
export async function recordRaidGroupKill(groupJid, bossId, rounds = 0) {
  if (!groupJid || !RAID_BOSS_IDS.includes(bossId)) return null;
  const ronde = Math.max(1, Math.floor(Number(rounds) || 1));

  await runQuery("INSERT OR IGNORE INTO raid_group_progress (group_jid) VALUES (?)", [groupJid]);
  await runQuery(
    `UPDATE raid_group_progress SET
       kills_total = kills_total + 1,
       kill_${bossId} = kill_${bossId} + 1,
       best_round = CASE
         WHEN COALESCE(best_round, 0) = 0 THEN ?
         ELSE MIN(best_round, ?)
       END,
       updated_at = CURRENT_TIMESTAMP
     WHERE group_jid = ?`,
    [ronde, ronde, groupJid]
  );
  return true;
}


// ============================================================
// STATISTIK LELANG KOTAK MISTERI
// ============================================================
// Untung bersih sengaja tidak disimpan sebagai kolom: nilainya bisa negatif,
// sementara semua kolom di sini dibersihkan ke >= 0 saat dibaca. Profit
// dihitung di query dan di layar tampilan.

const AUCTION_KATEGORI = { jackpot: 'jackpot_count', trap: 'trap_count', zonk: 'zonk_count' };

export async function getAuctionStats(customerJid) {
  if (!customerJid) return null;
  await runQuery("INSERT OR IGNORE INTO auction_stats (customer_jid) VALUES (?)", [customerJid]);
  const row = await getQuery("SELECT * FROM auction_stats WHERE customer_jid = ?", [customerJid]);
  if (!row) return null;

  for (const key of Object.keys(row)) {
    if (key === 'customer_jid' || key === 'last_played' || key === 'updated_at') continue;
    row[key] = Math.max(0, Math.floor(Number(row[key]) || 0));
  }
  return row;
}

/**
 * Catat hasil satu lelang untuk seorang peserta.
 * `kategori` dibatasi whitelist karena namanya jadi nama kolom.
 */
export async function recordAuctionResult(customerJid, {
  won = false, paid = 0, reward = 0, denda = 0, boardFee = 0, bid = 0, kategori = 'lain'
} = {}) {
  if (!customerJid) return null;
  await runQuery("INSERT OR IGNORE INTO auction_stats (customer_jid) VALUES (?)", [customerJid]);

  const dibayar = Math.max(0, Math.floor(Number(paid) || 0));
  const hadiah = Math.max(0, Math.floor(Number(reward) || 0));
  const kutukan = Math.max(0, Math.floor(Number(denda) || 0));
  const papan = Math.max(0, Math.floor(Number(boardFee) || 0));
  const tawaran = Math.max(0, Math.floor(Number(bid) || 0));
  const kolomKategori = AUCTION_KATEGORI[kategori] || null;

  await runQuery(
    `UPDATE auction_stats SET
       lelang_diikuti = lelang_diikuti + 1,
       lelang_menang = lelang_menang + ?,
       total_bid_dibayar = total_bid_dibayar + ?,
       total_hadiah = total_hadiah + ?,
       total_denda = total_denda + ?,
       total_biaya_papan = total_biaya_papan + ?,
       bid_tertinggi = MAX(COALESCE(bid_tertinggi, 0), ?),
       ${kolomKategori ? `${kolomKategori} = ${kolomKategori} + 1,` : ''}
       last_played = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP
     WHERE customer_jid = ?`,
    [won ? 1 : 0, dibayar, hadiah, kutukan, papan, tawaran, customerJid]
  );

  return true;
}

export async function getAuctionLeaderboard(limit = 10, minLelang = 1) {
  const safeLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
  const safeMin = Math.max(1, Number.parseInt(minLelang, 10) || 1);
  return await allQuery(
    `SELECT a.customer_jid,
            COALESCE(a.lelang_diikuti, 0) AS lelang_diikuti,
            COALESCE(a.lelang_menang, 0) AS lelang_menang,
            COALESCE(a.jackpot_count, 0) AS jackpot_count,
            COALESCE(a.trap_count, 0) AS trap_count,
            COALESCE(a.zonk_count, 0) AS zonk_count,
            COALESCE(a.bid_tertinggi, 0) AS bid_tertinggi,
            (COALESCE(a.total_hadiah, 0) - COALESCE(a.total_bid_dibayar, 0)
             - COALESCE(a.total_denda, 0) - COALESCE(a.total_biaya_papan, 0)) AS profit,
            COALESCE(c.nama, 'Member') AS customer_nama
     FROM auction_stats a
     LEFT JOIN customers c ON c.nomor = a.customer_jid
     WHERE COALESCE(a.lelang_diikuti, 0) >= ?
     ORDER BY profit DESC,
              COALESCE(a.lelang_menang, 0) DESC,
              COALESCE(a.jackpot_count, 0) DESC
     LIMIT ?`,
    [safeMin, safeLimit]
  );
}


// ============================================================
// POWER-UP / BUFF PEMAIN (dibeli dengan Akbar Poin lewat `.tukar`)
// ============================================================
// Buff berbasis waktu memakai kolom expires_at (epoch ms), buff sekali pakai
// memakai uses_left. Keduanya duduk di tabel yang sama supaya pengecekan di
// jalur game cukup satu query. Sebuah baris dianggap aktif selama masih punya
// sisa waktu ATAU masih punya sisa jatah pakai.

export async function grantUserBuff(jid, buffType, { multiplier = 1, durationMs = 0, uses = 0 } = {}) {
  const now = Date.now();
  const existing = await getActiveBuff(jid, buffType);

  // Beli ulang saat buff masih aktif = perpanjang dari sisa waktu, bukan reset.
  const baseExpiry = (existing && existing.expires_at && Number(existing.expires_at) > now)
    ? Number(existing.expires_at)
    : now;
  const expiresAt = durationMs > 0 ? baseExpiry + durationMs : null;
  const usesLeft = uses > 0 ? (Math.max(0, Number(existing?.uses_left) || 0) + uses) : 0;

  await runQuery(
    `INSERT INTO user_buffs (jid, buff_type, multiplier, uses_left, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(jid, buff_type) DO UPDATE SET
       multiplier = excluded.multiplier,
       uses_left = excluded.uses_left,
       expires_at = excluded.expires_at,
       created_at = CURRENT_TIMESTAMP`,
    [jid, buffType, multiplier, usesLeft, expiresAt]
  );

  return { success: true, buffType, multiplier, usesLeft, expiresAt };
}

export async function getActiveBuff(jid, buffType) {
  const row = await getQuery("SELECT * FROM user_buffs WHERE jid = ? AND buff_type = ?", [jid, buffType]);
  if (!row) return null;

  const now = Date.now();
  const hasTime = row.expires_at !== null && row.expires_at !== undefined && Number(row.expires_at) > now;
  const hasUses = Number(row.uses_left) > 0;

  if (!hasTime && !hasUses) {
    await runQuery("DELETE FROM user_buffs WHERE jid = ? AND buff_type = ?", [jid, buffType]);
    return null;
  }
  return row;
}

export async function getBuffMultiplier(jid, buffType) {
  const row = await getActiveBuff(jid, buffType);
  if (!row) return 1;
  const mult = Number(row.multiplier);
  return (isFinite(mult) && mult > 0) ? mult : 1;
}

// Pakai satu jatah buff sekali pakai. Mengembalikan null kalau tidak ada jatah,
// jadi pemanggil bisa membedakan "buff dipakai" vs "tidak punya buff".
export async function consumeBuffUse(jid, buffType) {
  const row = await getActiveBuff(jid, buffType);
  if (!row || Number(row.uses_left) <= 0) return null;

  const remaining = Number(row.uses_left) - 1;
  if (remaining <= 0) {
    await runQuery("DELETE FROM user_buffs WHERE jid = ? AND buff_type = ?", [jid, buffType]);
  } else {
    await runQuery("UPDATE user_buffs SET uses_left = ? WHERE jid = ? AND buff_type = ?", [remaining, jid, buffType]);
  }

  const mult = Number(row.multiplier);
  return { multiplier: (isFinite(mult) && mult > 0) ? mult : 1, remaining: Math.max(0, remaining) };
}

export async function listActiveBuffs(jid) {
  await runQuery(
    "DELETE FROM user_buffs WHERE (expires_at IS NULL OR expires_at <= ?) AND COALESCE(uses_left, 0) <= 0",
    [Date.now()]
  );
  return allQuery("SELECT * FROM user_buffs WHERE jid = ? ORDER BY buff_type ASC", [jid]);
}


// ============================================================
// COOLDOWN TAHAN RESTART
// ============================================================
// `scope` bisa JID pemain (cooldown personal) atau JID grup (cooldown per grup,
// misalnya bank yang baru dirampok). `kind` adalah label bebas seperti 'STEAL',
// 'STEAL_IMMUNITY', atau 'HEIST:2'. Semuanya menyimpan waktu kedaluwarsa absolut
// supaya restart bot tidak pernah menghapus hukuman atau perlindungan siapa pun.

export async function setCooldown(scope, kind, durationMs) {
  const durasi = Math.max(0, Math.floor(Number(durationMs) || 0));
  if (!scope || !kind || durasi <= 0) return { success: false };

  const expiresAt = Date.now() + durasi;
  await runQuery(
    `INSERT INTO user_cooldowns (scope, kind, expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT(scope, kind) DO UPDATE SET
       expires_at = excluded.expires_at,
       created_at = CURRENT_TIMESTAMP`,
    [scope, kind, expiresAt]
  );
  return { success: true, expiresAt };
}

/** Sisa cooldown dalam milidetik. 0 berarti sudah bebas. */
export async function getCooldownMs(scope, kind) {
  if (!scope || !kind) return 0;
  const row = await getQuery(
    "SELECT expires_at FROM user_cooldowns WHERE scope = ? AND kind = ?",
    [scope, kind]
  );
  if (!row) return 0;

  const sisa = Number(row.expires_at) - Date.now();
  if (!isFinite(sisa) || sisa <= 0) {
    await runQuery("DELETE FROM user_cooldowns WHERE scope = ? AND kind = ?", [scope, kind]);
    return 0;
  }
  return sisa;
}

export async function clearCooldown(scope, kind) {
  if (!scope || !kind) return;
  await runQuery("DELETE FROM user_cooldowns WHERE scope = ? AND kind = ?", [scope, kind]);
}

/**
 * Semua cooldown aktif milik satu scope, dalam bentuk Map kind -> expires_at.
 * Dipakai layar daftar (misalnya daftar target bank) supaya tidak menembak satu
 * query per baris.
 */
export async function listCooldowns(scope) {
  const hasil = new Map();
  if (!scope) return hasil;

  await runQuery("DELETE FROM user_cooldowns WHERE expires_at <= ?", [Date.now()]);
  const rows = await allQuery(
    "SELECT kind, expires_at FROM user_cooldowns WHERE scope = ?",
    [scope]
  );
  for (const r of rows) hasil.set(r.kind, Number(r.expires_at) || 0);
  return hasil;
}

/**
 * Ringkasan seluruh aset dan profil finansial terpadu pemain (Unified Multi-Asset Wallet).
 */
export async function getUnifiedWalletData(jid) {
  const todayStr = tanggalWIB();
  const [cust, gp, prem, tcgWallet, tcgShards, tcgCol, tcgProf, aiRow, mediaRow] = await Promise.all([
    getQuery("SELECT nomor, nama, balance, role, account_status, registered_at FROM customers WHERE nomor = ?", [jid]),
    getQuery("SELECT points, bank_points, bank_pending, xp, level, daily_streak, jailed_until FROM game_profiles WHERE customer_jid = ?", [jid]),
    getQuery("SELECT tier, expires_at FROM premium_users WHERE jid = ?", [jid]),
    getQuery("SELECT keping FROM tcg_wallet WHERE owner_jid = ?", [jid]),
    allQuery("SELECT rarity, jumlah FROM tcg_shards WHERE owner_jid = ?", [jid]),
    getQuery("SELECT COUNT(*) as unique_cards, COALESCE(SUM(qty), 0) as total_cards FROM tcg_collection WHERE owner_jid = ? AND qty > 0", [jid]),
    getQuery("SELECT gelar_aktif FROM tcg_profil WHERE owner_jid = ?", [jid]),
    getQuery("SELECT count FROM ai_usage_logs WHERE jid = ? AND usage_date = ?", [jid, todayStr]),
    getQuery("SELECT count FROM media_usage_logs WHERE jid = ? AND usage_date = ?", [jid, todayStr])
  ]);

  const isPremActive = prem && (prem.expires_at === 0 || prem.expires_at > Date.now());
  const tier = isPremActive ? (prem.tier || 'Free') : 'Free';

  const shardMap = { COMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0, MYTHIC: 0 };
  for (const s of (tcgShards || [])) {
    if (s.rarity) shardMap[s.rarity.toUpperCase()] = s.jumlah || 0;
  }

  return {
    jid,
    customer: {
      nama: cust?.nama || 'Member',
      balance: cust?.balance || 0,
      role: cust?.role || 'USER',
      status: cust?.account_status || 'ACTIVE',
      terdaftar: !!cust
    },
    game: {
      points: gp?.points || 0,
      bankPoints: gp?.bank_points || 0,
      bankPending: gp?.bank_pending || 0,
      totalWealth: (gp?.points || 0) + (gp?.bank_points || 0) + (gp?.bank_pending || 0),
      xp: gp?.xp || 0,
      level: gp?.level || 1,
      dailyStreak: gp?.daily_streak || 0,
      isJailed: gp?.jailed_until && gp.jailed_until > Date.now()
    },
    premium: {
      tier,
      expiresAt: prem?.expires_at || null,
      isActive: isPremActive
    },
    tcg: {
      keping: tcgWallet?.keping || 0,
      uniqueCards: tcgCol?.unique_cards || 0,
      totalCards: tcgCol?.total_cards || 0,
      shards: shardMap,
      activeTitle: tcgProf?.gelar_aktif || null
    },
    quota: {
      aiUsed: aiRow?.count || 0,
      mediaUsed: mediaRow?.count || 0
    }
  };
}

// ─── 🛡️ ACTIVE GAME SESSIONS & CRASH RECOVERY DAOs ─────────────────

/**
 * Menyimpan sesi game aktif ke database untuk proteksi crash/restart
 */
export async function createActiveGameSession({ id, gameType, jid, host, buyIn = 0, pot = 0, players = [], state = {} }) {
  try {
    const playersJson = JSON.stringify(players);
    const stateJson = JSON.stringify(state);
    await runQuery(
      `INSERT OR REPLACE INTO active_game_sessions 
       (id, game_type, jid, host, status, buy_in, pot, players_json, state_json, updated_at) 
       VALUES (?, ?, ?, ?, 'PLAYING', ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [id, gameType, jid, host, buyIn, pot, playersJson, stateJson]
    );
    return true;
  } catch (err) {
    console.error('[CREATE_GAME_SESSION_ERROR]', err);
    return false;
  }
}

/**
 * Update data sesi game aktif
 */
export async function updateActiveGameSession(id, updates = {}) {
  try {
    const sets = [];
    const params = [];
    if (updates.status !== undefined) { sets.push("status = ?"); params.push(updates.status); }
    if (updates.pot !== undefined) { sets.push("pot = ?"); params.push(updates.pot); }
    if (updates.players !== undefined) { sets.push("players_json = ?"); params.push(JSON.stringify(updates.players)); }
    if (updates.state !== undefined) { sets.push("state_json = ?"); params.push(JSON.stringify(updates.state)); }
    
    if (sets.length === 0) return true;
    sets.push("updated_at = CURRENT_TIMESTAMP");
    params.push(id);

    await runQuery(`UPDATE active_game_sessions SET ${sets.join(', ')} WHERE id = ?`, params);
    return true;
  } catch (err) {
    console.error('[UPDATE_GAME_SESSION_ERROR]', err);
    return false;
  }
}

/**
 * Tandai sesi game telah selesai normal atau dibatalkan
 */
export async function finishActiveGameSession(id, status = 'COMPLETED') {
  try {
    await runQuery(
      "UPDATE active_game_sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [status, id]
    );
    return true;
  } catch (err) {
    console.error('[FINISH_GAME_SESSION_ERROR]', err);
    return false;
  }
}

/**
 * Mengambil data sesi game aktif berdasarkan id
 */
export async function getActiveGameSession(id) {
  try {
    return await getQuery("SELECT * FROM active_game_sessions WHERE id = ?", [id]);
  } catch (_) {
    return null;
  }
}

/**
 * Pemulihan & Auto-Refund saat Bot Startup:
 * Mengembalikan 100% poin taruhan yang tertahan jika bot mati mendadak saat game berlangsung.
 */
export async function recoverAndRefundStaleGameSessions(sock = null) {
  try {
    const staleSessions = await allQuery(
      "SELECT * FROM active_game_sessions WHERE status IN ('LOBBY', 'PLAYING')"
    );
    if (!staleSessions || staleSessions.length === 0) return { recovered: 0, totalRefundedPoints: 0 };

    let recoveredCount = 0;
    let totalPoints = 0;

    for (const session of staleSessions) {
      let players = [];
      try {
        players = JSON.parse(session.players_json || '[]');
      } catch (_) {}

      let sessionRefundedPoints = 0;
      for (const p of players) {
        const pJid = typeof p === 'string' ? p : p?.jid;
        const pPoints = typeof p === 'string' ? (session.buy_in || 0) : (p?.points || session.buy_in || 0);

        if (pJid && !pJid.endsWith('@ai') && pPoints > 0) {
          await addGamePoints(pJid, pPoints);
          sessionRefundedPoints += pPoints;
          totalPoints += pPoints;
        }
      }

      await runQuery(
        "UPDATE active_game_sessions SET status = 'REFUNDED_ON_RESTART', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [session.id]
      );
      recoveredCount++;

      // Kirim pengumuman ke grup jika koneksi socket siap
      if (sock && session.jid && sessionRefundedPoints > 0) {
        try {
          const gameTitle = session.game_type || 'Game';
          const msg = `⚠️ *[SYSTEM RECOVERY]* Bot baru saja dimulai ulang (restart).\nTaruhan sesi *${gameTitle}* sebesar *${sessionRefundedPoints} Poin* telah dikembalikan 100% ke saldo masing-masing pemain.`;
          await sock.sendMessage(session.jid, { text: msg });
        } catch (_) {}
      }
    }

    if (recoveredCount > 0) {
      await addLog('SYSTEM', `[CRASH_RECOVERY] Berhasil merefund ${recoveredCount} sesi game tertunda (${totalPoints} poin dikembalikan).`);
      console.log(`[CRASH_RECOVERY] ✅ Berhasil merefund ${recoveredCount} sesi game tertunda (${totalPoints} poin dikembalikan).`);
    }

    return { recovered: recoveredCount, totalRefundedPoints: totalPoints };
  } catch (err) {
    console.error('[CRASH_RECOVERY_ERROR]', err);
    return { recovered: 0, totalRefundedPoints: 0 };
  }
}

