import { runQuery, getQuery, allQuery, withTransaction, normalizePhoneDigits } from './connection.js';

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

export async function bankDeposit(customerJid, amount) {
  const safeAmount = Math.max(0, Math.floor(Number(amount)));
  if (safeAmount <= 0) return { success: false, reason: 'INVALID_AMOUNT' };
  
  return withTransaction(async () => {
    const res = await runQuery(
      `UPDATE game_profiles SET points = points - ?, bank_points = COALESCE(bank_points, 0) + ? WHERE customer_jid = ? AND points >= ?`,
      [safeAmount, safeAmount, customerJid, safeAmount]
    );
    if (res.changes === 0) {
      return { success: false, reason: 'INSUFFICIENT_FUNDS' };
    }
    return { success: true };
  });
}

export async function bankWithdraw(customerJid, amount, taxRate = 0.02) {
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

export async function applyDailyBankInterest(interestRate = 0.02) {
  return withTransaction(async () => {
    const res = await runQuery(
      `UPDATE game_profiles
       SET bank_points = MIN(${MAX_POINTS}, CAST(ROUND(bank_points * (1 + ?)) AS INTEGER)),
           updated_at = CURRENT_TIMESTAMP
       WHERE bank_points >= 25`,
      [interestRate]
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
  const safePoints = (!isFinite(rawPts) || isNaN(rawPts)) ? 0 : Math.max(0, Math.min(1000, rawPts));
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

export async function resetGameLeaderboard() {
  // 1. Hapus profile game dari user yang belum mendaftar (.daftar)
  await runQuery(`
    DELETE FROM game_profiles
    WHERE customer_jid NOT IN (
      SELECT nomor FROM customers WHERE profile_completed = 1
    )
  `);

  // 2. Reset semua poin, XP, level, dan streak untuk member terdaftar
  const result = await runQuery(`
    UPDATE game_profiles
    SET points = 0, xp = 0, level = 1, games_played = 0, games_won = 0,
        daily_streak = 0, daily_claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
  `);

  await addLog("ADMIN", `Leaderboard game di-reset bersih (${result.changes} member di-reset).`);
  return { success: true, resetCount: result.changes };
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
 * Menambahkan XP per pesan di grup & mengecek peningkatan level
 */
export async function addMessageXp(customerJid, xpAmount = 10) {
  const now = Date.now();
  const lastXpTime = xpCooldowns.get(customerJid) || 0;
  if (now - lastXpTime < 30000) {
    return { leveledUp: false };
  }
  xpCooldowns.set(customerJid, now);

  const profile = await getGameProfile(customerJid);
  const oldXp = profile.xp || 0;
  const oldLevel = profile.level || 1;
  // Power-Up XP Booster dari toko poin `.tukar` dikalikan di sini — ini satu-satunya
  // tempat XP chat ditambahkan, jadi cukup satu hook.
  const xpBoost = await getBuffMultiplier(customerJid, 'XP_BOOST');
  const grantedXp = Math.max(0, Math.round(xpAmount * xpBoost));
  const newXp = oldXp + grantedXp;
  const newLevel = Math.floor(newXp / 100) + 1;

  await runQuery(
    "UPDATE game_profiles SET xp = ?, level = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_jid = ?",
    [newXp, newLevel, customerJid]
  );

  const titleBadge = getRankBadgeTitle(newLevel);
  const leveledUp = newLevel > oldLevel;

  return {
    leveledUp,
    oldLevel,
    newLevel,
    titleBadge,
    xp: newXp,
    profile: { ...profile, xp: newXp, level: newLevel }
  };
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
 * Get all PENDING or FAILED fulfillment jobs (for worker pickup and recovery after restart).
 */
export async function getPendingFulfillmentJobs() {
  return allQuery(
    `SELECT fj.*, o.payment_amount, o.casaku_transaction_id
     FROM fulfillment_jobs fj
     JOIN orders o ON fj.order_id = o.order_id
     WHERE fj.status IN ('PENDING', 'FAILED')
     ORDER BY fj.created_at ASC`
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
export async function getAiUsageToday(jid) {
  const todayStr = new Date().toISOString().split('T')[0];
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
  const todayStr = new Date().toISOString().split('T')[0];
  await runQuery(
    `INSERT INTO ai_usage_logs (jid, usage_date, count) VALUES (?, ?, 1)
     ON CONFLICT(jid, usage_date) DO UPDATE SET count = count + 1`,
    [jid, todayStr]
  );
  return await getAiUsageToday(jid);
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
