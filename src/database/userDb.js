import bcrypt from 'bcryptjs';

import { runQuery, getQuery, allQuery, withTransaction, formatPhoneNumber, normalizePhoneDigits, isPhoneMatch } from './connection.js';

import { config } from '../../config.js';


// --- FUNGSI USERS / AKUN ---

export async function getUsers() {
  return await allQuery("SELECT username, role FROM users ORDER BY role DESC, username ASC");
}

export async function getUserByUsername(username) {
  return await getQuery("SELECT * FROM users WHERE username = ?", [username.toLowerCase()]);
}

export async function setTwoFactorSecret(username, secret) {
  return await runQuery(
    "UPDATE users SET two_factor_secret = ?, two_factor_enabled = 0 WHERE username = ?",
    [secret, username.toLowerCase()]
  );
}

export async function setTwoFactorEnabled(username, enabled) {
  return await runQuery(
    "UPDATE users SET two_factor_enabled = ? WHERE username = ?",
    [enabled ? 1 : 0, username.toLowerCase()]
  );
}

export async function disableTwoFactor(username) {
  return await runQuery(
    "UPDATE users SET two_factor_secret = NULL, two_factor_enabled = 0 WHERE username = ?",
    [username.toLowerCase()]
  );
}

export async function addUser(username, password, role) {
  const normalizedUsername = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,40}$/.test(normalizedUsername)) {
    throw new Error('Username harus 3-40 karakter dan hanya boleh berisi huruf, angka, garis bawah, atau tanda hubung.');
  }
  if (String(password || '').length < 8 || String(password || '').length > 200) {
    throw new Error('Password harus berisi 8-200 karakter.');
  }
  if (!['Owner', 'Admin', 'CS'].includes(role)) {
    throw new Error('Role pengguna tidak valid.');
  }
  const hash = bcrypt.hashSync(password, 10);
  const res = await runQuery(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    [normalizedUsername, hash, role]
  );
  await addLog("SYSTEM", `Akun pengguna baru ditambahkan: ${normalizedUsername} (${role})`);
  return res;
}

export async function updateUserPassword(username, newPassword) {
  if (String(newPassword || '').length < 8 || String(newPassword || '').length > 200) {
    throw new Error('Password harus berisi 8-200 karakter.');
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  const res = await runQuery(
    "UPDATE users SET password_hash = ? WHERE username = ?",
    [hash, username.toLowerCase()]
  );
  // Ganti password harus mencabut sesi lama, kalau tidak orang yang password-nya
  // baru saja diganti (misalnya karena dicurigai bocor) tetap bisa memakai token
  // 24 jamnya seolah tidak terjadi apa-apa.
  await bumpTokenEpoch(username);
  await addLog("SYSTEM", `Password untuk akun pengguna ${username.toLowerCase()} berhasil diganti.`);
  return res;
}

export async function deleteUser(username) {
  const res = await runQuery("DELETE FROM users WHERE username = ?", [username.toLowerCase()]);
  await bumpTokenEpoch(username);
  await addLog("SYSTEM", `Akun pengguna ${username.toLowerCase()} dihapus.`);
  return res;
}


// --- PETA LID <-> NOMOR HP ---

/** Catat pasangan @lid dan nomor HP yang terbaca dari metadata grup. */
export async function catatPetaLid(lidJid, phoneDigits) {
  const lid = String(lidJid || '').trim().toLowerCase();
  const digits = normalizePhoneDigits(phoneDigits);
  if (!lid.endsWith('@lid') || !digits || digits.length < 8) return false;
  await runQuery(
    `INSERT INTO lid_phone_map (lid_jid, phone_digits, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(lid_jid) DO UPDATE SET phone_digits = ?, updated_at = CURRENT_TIMESTAMP`,
    [lid, digits, digits]
  );
  return true;
}

/**
 * Arah sebaliknya dari `resolveTargetJid`: dari @lid ke nomor HP.
 *
 * Dibutuhkan saat yang kita pegang hanyalah @lid (dari mention di grup) dan
 * yang ingin diketahui adalah "nomor siapa ini" — misalnya untuk memeriksa
 * apakah sasaran `.kick` ternyata Owner. Metadata grup adalah sumber utamanya;
 * fungsi ini jaring pengaman saat baris pesertanya tidak memuat nomor HP.
 */
export async function cariNomorDariLid(lidJid) {
  const lid = String(lidJid || '').trim().toLowerCase().replace(/:[0-9]+@/, '@');
  if (!lid.endsWith('@lid')) return null;
  const row = await getQuery("SELECT phone_digits FROM lid_phone_map WHERE lid_jid = ?", [lid]);
  return row?.phone_digits || null;
}

/**
 * Ubah masukan mentah dari perintah admin menjadi JID yang BENAR-BENAR dipakai
 * orangnya, atau akui terus terang kalau tidak bisa.
 *
 * Sebelum ada fungsi ini, `.ban 628xxx` dan `.setpremium 628xxx` selalu merakit
 * `628xxx@s.whatsapp.net` begitu saja, lalu membalas "✅ berhasil" — padahal 191
 * dari 194 pelanggan tersimpan sebagai @lid, jadi baris yang ditulis tidak pernah
 * cocok dengan siapa pun. Uang premium diterima, tier tidak pernah naik; user
 * di-"ban" tetap bisa memakai bot seperti biasa. Tidak ada satu pun tanda gagal.
 *
 * Mengembalikan { jid, sumber, ditemukan }. `ditemukan: false` berarti pemanggil
 * WAJIB menolak perintahnya, bukan melanjutkan dengan tebakan.
 */
export async function resolveTargetJid(masukan) {
  const mentah = String(masukan || '').trim();
  if (!mentah) return { jid: null, sumber: 'kosong', ditemukan: false };

  // 1. Sudah berupa JID lengkap (dari mention / reply) — pakai apa adanya.
  if (mentah.includes('@')) {
    const bersih = mentah.replace(/:[0-9]+@/, '@').toLowerCase();
    return { jid: bersih, sumber: 'jid', ditemukan: true };
  }

  const digits = normalizePhoneDigits(mentah);
  if (!digits || digits.length < 8) return { jid: null, sumber: 'digit-pendek', ditemukan: false };

  // 2. Cocokkan ke baris customers yang tersimpan sebagai nomor HP.
  const semua = await allQuery("SELECT nomor FROM customers WHERE nomor LIKE '%@s.whatsapp.net'");
  for (const c of semua) {
    if (isPhoneMatch(c.nomor, digits)) {
      return { jid: c.nomor, sumber: 'customers', ditemukan: true };
    }
  }

  // 3. Cocokkan lewat peta LID yang terkumpul dari metadata grup.
  const peta = await allQuery("SELECT lid_jid, phone_digits FROM lid_phone_map");
  for (const p of peta) {
    if (isPhoneMatch(p.phone_digits, digits)) {
      return { jid: p.lid_jid, sumber: 'peta-lid', ditemukan: true };
    }
  }

  return { jid: null, sumber: 'tidak-ketemu', ditemukan: false };
}


// --- PENCABUTAN TOKEN DASHBOARD ---
//
// JWT dashboard tidak menyimpan status apa pun di server, jadi tanpa penanda ini
// "Logout", ganti password, dan hapus akun tidak mencabut apa pun: token yang
// sudah dipegang tetap sah sampai 24 jamnya habis. `valid_after` adalah MILIDETIK
// epoch — token dengan klaim `iatMs` lebih tua dari itu ditolak authenticateJWT.
//
// Satuannya milidetik, BUKAN detik, dan token membawa klaim `iatMs` sendiri alih-
// alih memakai `iat` bawaan jsonwebtoken. `iat` hanya berpresisi detik, sehingga
// token yang diterbitkan pada detik yang sama dengan pencabutan lolos begitu saja
// (`iat < valid_after` bernilai false saat keduanya sama) — logout lalu langsung
// mengakses ulang masih diterima. Diuji dan memang bocor; presisi milidetik
// menutupnya tanpa mengorbankan alur "logout lalu login lagi", karena login
// berikutnya selalu punya iatMs yang lebih besar.
//
// Efek samping yang disengaja: token lama yang diterbitkan SEBELUM perubahan ini
// tidak punya klaim iatMs, jadi dianggap 0 dan ditolak begitu akunnya pernah
// dicabut. Sesi dashboard yang sedang berjalan perlu login ulang sekali.

export async function getTokenEpoch(username) {
  const row = await getQuery(
    "SELECT valid_after FROM auth_token_epochs WHERE username = ?",
    [String(username || '').toLowerCase()]
  );
  return row ? Number(row.valid_after) || 0 : 0;
}

export async function bumpTokenEpoch(username) {
  const nama = String(username || '').toLowerCase();
  if (!nama) return 0;
  const milidetik = Date.now();
  await runQuery(
    `INSERT INTO auth_token_epochs (username, valid_after) VALUES (?, ?)
     ON CONFLICT(username) DO UPDATE SET valid_after = ?`,
    [nama, milidetik, milidetik]
  );
  return milidetik;
}


// --- FUNGSI LOGS ---

export async function addLog(type, message) {
  try {
    await runQuery("INSERT INTO logs (type, message) VALUES (?, ?)", [type.toUpperCase(), message]);
  } catch (err) {
    console.error("Gagal menambahkan log:", err.message);
  }
}

export async function getLogs(typeFilter = "") {
  if (typeFilter && typeFilter !== "ALL") {
    return await allQuery("SELECT * FROM logs WHERE type = ? ORDER BY timestamp DESC LIMIT 200", [typeFilter.toUpperCase()]);
  }
  return await allQuery("SELECT * FROM logs ORDER BY timestamp DESC LIMIT 200");
}


// --- FUNGSI SETTINGS ---

// Cache setelan. getSettings() berada di jalur panas: getOrCreateCustomer
// memanggilnya pada SETIAP pesan masuk, padahal isi tabel settings nyaris tak
// pernah berubah. Tanpa cache, tiap pesan memicu satu SELECT penuh.
// TTL pendek + invalidasi eksplisit saat ditulis, supaya perubahan dari
// dashboard tetap langsung terasa.
let settingsCache = null;
let settingsCacheAt = 0;
const SETTINGS_CACHE_TTL = 5000;

export function invalidateSettingsCache() {
  settingsCache = null;
  settingsCacheAt = 0;
}

export async function getSettings() {
  if (settingsCache && (Date.now() - settingsCacheAt) < SETTINGS_CACHE_TTL) {
    return { ...settingsCache };
  }

  const rows = await allQuery("SELECT * FROM settings");
  const settings = { ...config.defaults };
  rows.forEach(r => {
    if (r.value !== null && r.value !== undefined) {
      if (r.key === 'lowStockLimit' || r.key === 'broadcastDelay') {
        settings[r.key] = parseInt(r.value, 10) || 0;
      } else {
        settings[r.key] = r.value;
      }
    }
  });

  settingsCache = settings;
  settingsCacheAt = Date.now();
  // Kembalikan salinan: pemanggil tidak boleh bisa mengubah isi cache.
  return { ...settings };
}

export async function getSetting(key) {
  const row = await getQuery("SELECT value FROM settings WHERE key = ?", [key]);
  if (!row || row.value === null || row.value === undefined) {
    return config.defaults[key] ?? null;
  }
  if (key === 'lowStockLimit' || key === 'broadcastDelay') {
    return parseInt(row.value, 10) || 0;
  }
  return row.value;
}

export async function updateSettings(settingsObj) {
  for (const [key, val] of Object.entries(settingsObj)) {
    const safeVal = (val !== null && val !== undefined) ? String(val) : '';
    await runQuery("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, safeVal]);
  }

  invalidateSettingsCache();

  await addLog("SYSTEM", "Konfigurasi sistem diperbarui dari Dashboard Admin.");
  return true;
}


// --- FUNGSI PELANGGAN (TIER DINAMIS) ---

export async function getOrCreateCustomer(nomor, nama) {
  const clean = String(nomor || '').split(':')[0].replace(/@.*$/, '').trim();
  const fullClean = String(nomor || '').replace(/:[0-9]+@/, '@').trim();
  const digits = normalizePhoneDigits(nomor);

  let defaultRole = 'MEMBER';
  let defaultProfileCompleted = 0;

  try {
    const settings = await getSettings();
    const ownerDigits = normalizePhoneDigits(settings.ownerNumber || config.defaults.ownerNumber);
    const ownerJid = (settings.ownerJid || '').trim();
    const adminDigitsList = (settings.adminNumbers || config.defaults.adminNumbers || '')
      .split(',')
      .map(n => normalizePhoneDigits(n))
      .filter(d => d.length >= 7);

    const isOwner = (ownerJid && (nomor === ownerJid || fullClean === ownerJid || clean === ownerJid.split('@')[0] || (ownerJid.endsWith('@lid') && clean === ownerJid.replace(/@.*$/, '')))) ||
                    (ownerDigits && digits && isPhoneMatch(digits, ownerDigits));
    const isAdmin = adminDigitsList.some(adm => isPhoneMatch(digits, adm));

    if (isOwner) {
      defaultRole = 'OWNER';
      defaultProfileCompleted = 1;
    } else if (isAdmin) {
      defaultRole = 'ADMIN';
      defaultProfileCompleted = 1;
    }
  } catch (e) {}

  const existing = await getQuery("SELECT * FROM customers WHERE nomor = ?", [nomor]);
  if (existing) {
    // Jika user adalah Owner/Admin tapi di database masih terdata sebagai MEMBER / belum completed, otomatis update
    if ((defaultRole === 'OWNER' || defaultRole === 'ADMIN') && (existing.role !== defaultRole || Number(existing.profile_completed || 0) === 0)) {
      await runQuery("UPDATE customers SET role = ?, profile_completed = 1 WHERE nomor = ?", [defaultRole, nomor]);
    } else if (nama && existing.nama !== nama && Number(existing.profile_completed || 0) === 0) {
      await runQuery("UPDATE customers SET nama = ? WHERE nomor = ?", [nama, nomor]);
    }
    await runQuery("UPDATE customers SET last_seen_at = CURRENT_TIMESTAMP WHERE nomor = ?", [nomor]);
    return { nomor, nama: Number(existing.profile_completed || 0) === 1 ? existing.nama : (nama || existing.nama) };
  } else {
    await runQuery("INSERT INTO customers (nomor, nama, role, profile_completed, registered_at, last_seen_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)", [nomor, nama || (defaultRole === 'OWNER' ? 'Owner' : 'Pelanggan'), defaultRole, defaultProfileCompleted]);
    await addLog("SYSTEM", `Pelanggan baru terdaftar: ${nama || 'Pelanggan'} (${nomor})`);
    return { nomor, nama: nama || (defaultRole === 'OWNER' ? 'Owner' : 'Pelanggan') };
  }
}

function calculateCustomerTier(totalOrders) {
  if (totalOrders >= 15) return 'PLATINUM';
  if (totalOrders >= 7) return 'GOLD';
  if (totalOrders >= 3) return 'SILVER';
  return 'BRONZE';
}

export async function registerCustomer(nomor, nama) {
  const cleanName = String(nama || '').trim().replace(/\s+/g, ' ');
  if (cleanName.length < 2 || cleanName.length > 40) {
    throw new Error('Nama harus berisi 2-40 karakter.');
  }
  await getOrCreateCustomer(nomor, cleanName);
  await runQuery(`
    UPDATE customers
    SET nama = ?, profile_completed = 1, registered_at = COALESCE(registered_at, CURRENT_TIMESTAMP), last_seen_at = CURRENT_TIMESTAMP
    WHERE nomor = ?
  `, [cleanName, nomor]);
  await addLog('CUSTOMER', `Member mendaftar: ${cleanName} (${nomor})`);
  return getCustomerMembershipProfile(nomor);
}

export async function updateCustomerName(nomor, newName, actorNomor = null) {
  const cleanName = String(newName || '').trim().replace(/\s+/g, ' ');
  if (cleanName.length < 2 || cleanName.length > 40) {
    throw new Error('Nama baru harus berisi antara 2 sampai 40 karakter.');
  }

  const existing = await getQuery("SELECT * FROM customers WHERE nomor = ?", [nomor]);
  if (!existing) {
    throw new Error('Member belum terdaftar. Silakan daftar terlebih dahulu via .daftar <nama>.');
  }

  const oldName = existing.nama || 'Pelanggan';
  const result = await runQuery(
    "UPDATE customers SET nama = ?, profile_completed = 1, last_seen_at = CURRENT_TIMESTAMP WHERE nomor = ?",
    [cleanName, nomor]
  );
  if (!result.changes) {
    throw new Error('Gagal memperbarui nama member.');
  }

  const logMessage = (actorNomor && actorNomor !== nomor)
    ? `Nama member ${nomor} diubah oleh admin ${actorNomor} dari "${oldName}" menjadi "${cleanName}"`
    : `Member ${nomor} mengganti nama dari "${oldName}" menjadi "${cleanName}"`;
  await addLog('CUSTOMER', logMessage);

  return {
    nomor,
    oldName,
    newName: cleanName,
    profile: await getCustomerMembershipProfile(nomor)
  };
}

export async function isCustomerRegistered(nomor) {
  if (!nomor) return false;
  const clean = String(nomor).split(':')[0].replace(/@.*$/, '').trim();
  const fullClean = String(nomor).replace(/:[0-9]+@/, '@').trim();
  const digits = normalizePhoneDigits(nomor);

  // 0. Owner / Admin / Moderator SELALU terdaftar secara otomatis (tidak pernah disuruh registrasi)
  try {
    const settings = await getSettings();
    const ownerDigits = normalizePhoneDigits(settings.ownerNumber || config.defaults.ownerNumber);
    const ownerJid = (settings.ownerJid || '').trim();
    const adminDigitsList = (settings.adminNumbers || config.defaults.adminNumbers || '')
      .split(',')
      .map(n => normalizePhoneDigits(n))
      .filter(d => d.length >= 7);

    if (ownerJid && (nomor === ownerJid || fullClean === ownerJid || clean === ownerJid.split('@')[0] || (ownerJid.endsWith('@lid') && clean === ownerJid.replace(/@.*$/, '')))) {
      return true;
    }
    if (ownerDigits && digits && isPhoneMatch(digits, ownerDigits)) {
      return true;
    }
    if (adminDigitsList.some(adm => isPhoneMatch(digits, adm))) {
      return true;
    }
  } catch (e) {}

  // 1. Cek exact match full JID
  const rowExact = await getQuery("SELECT profile_completed, role FROM customers WHERE nomor = ? OR nomor = ?", [nomor, fullClean]);
  if (rowExact) {
    if (['OWNER', 'ADMIN', 'MODERATOR'].includes(rowExact.role)) return true;
    if (Number(rowExact.profile_completed) === 1) return true;
  }

  // 2. Cek by phone digits jika nomor memiliki setidaknya 7 digit
  if (digits && digits.length >= 7) {
    const allRegistered = await allQuery("SELECT nomor, profile_completed, role FROM customers WHERE profile_completed = 1 OR role IN ('OWNER', 'ADMIN', 'MODERATOR')");
    for (const r of allRegistered) {
      if (isPhoneMatch(r.nomor, digits)) return true;
    }
  }

  return false;
}

export async function getCustomerMembershipProfile(nomor) {
  let customer = await getQuery('SELECT * FROM customers WHERE nomor = ?', [nomor]);
  const cleanNomor = String(nomor || '').split(':')[0].trim();
  const digits = normalizePhoneDigits(nomor);

  let resolvedRole = (customer?.role && customer.role !== 'null') ? customer.role : 'MEMBER';
  try {
    const settings = await getSettings();
    const ownerDigits = normalizePhoneDigits(settings.ownerNumber || config.defaults.ownerNumber);
    const ownerJid = (settings.ownerJid || '').trim();
    const adminDigitsList = (settings.adminNumbers || config.defaults.adminNumbers || '')
      .split(',')
      .map(n => normalizePhoneDigits(n))
      .filter(d => d.length >= 7);

    const isOwner = (ownerJid && (cleanNomor === ownerJid || cleanNomor.includes(ownerJid.split('@')[0]))) ||
                    (ownerDigits && digits && isPhoneMatch(digits, ownerDigits));
    const isAdmin = adminDigitsList.some(adm => isPhoneMatch(digits, adm));

    if (isOwner) resolvedRole = 'OWNER';
    else if (isAdmin && resolvedRole !== 'OWNER') resolvedRole = 'ADMIN';
  } catch (e) {}

  if (!customer) {
    if (resolvedRole === 'OWNER' || resolvedRole === 'ADMIN') {
      await getOrCreateCustomer(nomor, resolvedRole === 'OWNER' ? 'Owner' : 'Admin');
      customer = await getQuery('SELECT * FROM customers WHERE nomor = ?', [nomor]);
    } else {
      return null;
    }
  }

  const [stats, gameProfile, loyalty] = await Promise.all([
    getQuery(`
      SELECT COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) AS total_orders,
             COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN total ELSE 0 END), 0) AS total_spend
      FROM orders WHERE customer_nomor = ?
    `, [nomor]),
    getQuery('SELECT * FROM game_profiles WHERE customer_jid = ?', [nomor]),
    getQuery('SELECT * FROM loyalty WHERE customer_nomor = ?', [nomor])
  ]);

  return {
    ...customer,
    role: resolvedRole,
    total_orders: stats?.total_orders || 0,
    total_spend: stats?.total_spend || 0,
    tier: calculateCustomerTier(stats?.total_orders || 0),
    game_points: gameProfile?.points || 0,
    game_xp: gameProfile?.xp || 0,
    game_level: gameProfile?.level || 1,
    game_streak: gameProfile?.daily_streak || 0,
    loyalty_points: loyalty?.points || 0
  };
}

export async function updateCustomerRole(nomor, role) {
  const normalizedRole = String(role || '').toUpperCase();
  if (!['MEMBER', 'ADMIN'].includes(normalizedRole)) {
    throw new Error('Role valid: MEMBER atau ADMIN. Role OWNER hanya diatur dari konfigurasi sistem.');
  }
  const result = await runQuery("UPDATE customers SET role = ? WHERE nomor = ?", [normalizedRole, nomor]);
  if (!result.changes) throw new Error('Member tidak ditemukan.');
  await addLog('CUSTOMER', `Role member ${nomor} diubah menjadi ${normalizedRole}`);
  return getCustomerMembershipProfile(nomor);
}

export async function updateCustomerAccountStatus(nomor, status) {
  const normalizedStatus = String(status || '').toUpperCase();
  if (!['ACTIVE', 'INACTIVE', 'BANNED'].includes(normalizedStatus)) {
    throw new Error('Status valid: ACTIVE, INACTIVE, atau BANNED.');
  }
  const result = await runQuery("UPDATE customers SET account_status = ? WHERE nomor = ?", [normalizedStatus, nomor]);
  if (!result.changes) throw new Error('Member tidak ditemukan.');
  await addLog('CUSTOMER', `Status member ${nomor} diubah menjadi ${normalizedStatus}`);
  return getCustomerMembershipProfile(nomor);
}

export async function getCustomersWithTiers() {
  const rows = await allQuery(`
    SELECT 
      c.nomor, 
      c.nama, 
      c.role,
      c.account_status,
      c.profile_completed,
      c.registered_at,
      COUNT(CASE WHEN o.status = 'COMPLETED' THEN 1 END) as total_orders,
      COALESCE(SUM(CASE WHEN o.status = 'COMPLETED' THEN o.total ELSE 0 END), 0) as total_spend
    FROM customers c
    LEFT JOIN orders o ON c.nomor = o.customer_nomor
    GROUP BY c.nomor
  `);

  return rows.map(r => {
    return {
      ...r,
      tier: calculateCustomerTier(r.total_orders || 0)
    };
  });
}

export async function getCustomerDetails(nomor) {
  const customer = await getQuery("SELECT * FROM customers WHERE nomor = ?", [nomor]);
  if (!customer) return null;

  const stats = await getQuery(`
    SELECT 
      COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as total_orders,
      COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN total ELSE 0 END), 0) as total_spend
    FROM orders
    WHERE customer_nomor = ?
  `, [nomor]);

  const tier = calculateCustomerTier(stats.total_orders || 0);

  const orders = await allQuery("SELECT * FROM orders WHERE customer_nomor = ? ORDER BY created_at DESC", [nomor]);

  return {
    ...customer,
    total_orders: stats.total_orders,
    total_spend: stats.total_spend,
    tier,
    orders
  };
}

export async function getCustomerVoucherHistory(customerNomor) {
  const orders = await allQuery(`
    SELECT order_id, total, status, created_at 
    FROM orders 
    WHERE customer_nomor = ? AND status IN ('COMPLETED', 'PAID')
    ORDER BY created_at DESC 
    LIMIT 10
  `, [customerNomor]);

  if (!orders || orders.length === 0) return [];

  const history = [];
  for (const order of orders) {
    const items = await allQuery(`
      SELECT oi.produk_kode, oi.qty, p.nama as produk_nama, p.petunjuk 
      FROM order_items oi 
      JOIN products p ON oi.produk_kode = p.kode 
      WHERE oi.order_id = ?
    `, [order.order_id]);

    const credentials = await allQuery(`
      SELECT produk_kode, data_content, used_at 
      FROM product_items 
      WHERE order_id = ?
    `, [order.order_id]);

    history.push({
      order_id: order.order_id,
      total: order.total,
      status: order.status,
      created_at: order.created_at,
      items,
      credentials
    });
  }

  return history;
}


// --- FUNGSI ANALYTICS & STATS ---

export async function getStats() {
  const prodCount = await getQuery("SELECT COUNT(*) as count FROM products");
  const custCount = await getQuery("SELECT COUNT(*) as count FROM customers");
  const pendingCount = await getQuery("SELECT COUNT(*) as count FROM orders WHERE status = 'WAITING_CONFIRMATION'");
  const completedCount = await getQuery("SELECT COUNT(*) as count FROM orders WHERE status = 'COMPLETED'");
  const revenue = await getQuery("SELECT SUM(total) as sum FROM orders WHERE status = 'COMPLETED'");
  
  return {
    products: prodCount.count,
    customers: custCount.count,
    pendingOrders: pendingCount.count,
    completedOrders: completedCount.count,
    totalRevenue: revenue.sum || 0
  };
}

export async function getAnalyticsData() {
  const revenueToday = await getQuery("SELECT SUM(total) as sum FROM orders WHERE status = 'COMPLETED' AND date(created_at) = date('now')");
  const revenueWeek = await getQuery("SELECT SUM(total) as sum FROM orders WHERE status = 'COMPLETED' AND date(created_at) >= date('now', '-7 days')");
  const revenueMonth = await getQuery("SELECT SUM(total) as sum FROM orders WHERE status = 'COMPLETED' AND date(created_at) >= date('now', '-30 days')");

  const topProducts = await allQuery(`
    SELECT p.nama, SUM(oi.qty) as total_sold
    FROM order_items oi
    JOIN products p ON oi.produk_kode = p.kode
    JOIN orders o ON oi.order_id = o.order_id
    WHERE o.status = 'COMPLETED'
    GROUP BY p.kode
    ORDER BY total_sold DESC
    LIMIT 5
  `);

  const peakHours = await allQuery(`
    SELECT strftime('%H', created_at) as hour, COUNT(*) as count
    FROM orders
    WHERE status = 'COMPLETED'
    GROUP BY hour
    ORDER BY hour ASC
  `);

  const dailyRevenue = await allQuery(`
    SELECT date(created_at) as date, SUM(total) as total
    FROM orders
    WHERE status = 'COMPLETED' AND date(created_at) >= date('now', '-7 days')
    GROUP BY date
    ORDER BY date ASC
  `);

  return {
    revenueToday: revenueToday.sum || 0,
    revenueWeek: revenueWeek.sum || 0,
    revenueMonth: revenueMonth.sum || 0,
    topProducts,
    peakHours,
    dailyRevenue
  };
}

export async function getAllCustomers() {
  return await allQuery("SELECT * FROM customers");
}

export function generateOrderId() {
  const date = new Date();
  const dateStr = date.getFullYear().toString() +
                  (date.getMonth() + 1).toString().padStart(2, '0') +
                  date.getDate().toString().padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `ORD-${dateStr}-${rand}`;
}


// --- FUNGSI REFERRAL ---
export async function generateReferralCode(customerNomor) {
  const existing = await getQuery("SELECT referral_code FROM customers WHERE nomor = ?", [customerNomor]);
  if (existing && existing.referral_code) return existing.referral_code;
  
  const code = 'REF-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  await runQuery("UPDATE customers SET referral_code = ? WHERE nomor = ?", [code, customerNomor]);
  return code;
}

export async function getReferralByCode(code) {
  return await getQuery("SELECT * FROM customers WHERE referral_code = ?", [code.toUpperCase()]);
}

export async function addReferral(referrerNomor, referredNomor) {
  try {
    await runQuery(
      "INSERT INTO referrals (referrer_nomor, referred_nomor) VALUES (?, ?)",
      [referrerNomor, referredNomor]
    );
    await addLog("REFERRAL", `Referral: ${referredNomor} direferensikan oleh ${referrerNomor}`);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

export async function getReferralStats(customerNomor) {
  const count = await getQuery(
    "SELECT COUNT(*) as total FROM referrals WHERE referrer_nomor = ?", [customerNomor]
  );
  const claimed = await getQuery(
    "SELECT COUNT(*) as total FROM referrals WHERE referrer_nomor = ? AND reward_claimed = 1", [customerNomor]
  );
  return { totalReferred: count?.total || 0, rewardsClaimed: claimed?.total || 0 };
}

export async function claimReferralRewardCount(referrerNomor, countToClaim) {
  const unclaimedList = await allQuery(
    "SELECT id FROM referrals WHERE referrer_nomor = ? AND reward_claimed = 0 LIMIT ?",
    [referrerNomor, countToClaim * 3]
  );
  for (const item of unclaimedList) {
    await runQuery("UPDATE referrals SET reward_claimed = 1 WHERE id = ?", [item.id]);
  }
}


// --- FUNGSI LOYALTY POINTS ---
export async function getLoyalty(customerNomor) {
  let row = await getQuery("SELECT * FROM loyalty WHERE customer_nomor = ?", [customerNomor]);
  if (!row) {
    await runQuery("INSERT INTO loyalty (customer_nomor, points, total_spent, tier) VALUES (?, 0, 0, 'Bronze')", [customerNomor]);
    row = { customer_nomor: customerNomor, points: 0, total_spent: 0, tier: 'Bronze' };
  }
  row.points = Math.max(0, Math.floor(Number(row.points) || 0));
  row.total_spent = Math.max(0, Math.floor(Number(row.total_spent) || 0));
  return row;
}

export async function addLoyaltyPoints(customerNomor, orderTotal) {
  const pointsEarned = Math.floor(orderTotal / 10000);
  await getLoyalty(customerNomor);
  await runQuery(
    "UPDATE loyalty SET points = COALESCE(points, 0) + ?, total_spent = COALESCE(total_spent, 0) + ? WHERE customer_nomor = ?",
    [pointsEarned, orderTotal, customerNomor]
  );
  
  // Update tier
  const updated = await getLoyalty(customerNomor);
  let newTier = 'Bronze';
  if (updated.points >= 151) newTier = 'Gold';
  else if (updated.points >= 51) newTier = 'Silver';
  
  if (newTier !== updated.tier) {
    await runQuery("UPDATE loyalty SET tier = ? WHERE customer_nomor = ?", [newTier, customerNomor]);
  }
  
  return { pointsEarned, totalPoints: updated.points, tier: newTier };
}

export async function redeemLoyaltyPoints(customerNomor, pointsToRedeem) {
  const loyalty = await getLoyalty(customerNomor);
  if (loyalty.points < pointsToRedeem) {
    return { success: false, message: `Poin tidak cukup. Saldo poin Anda: ${loyalty.points}` };
  }
  await runQuery(
    "UPDATE loyalty SET points = MAX(0, COALESCE(points, 0) - ?) WHERE customer_nomor = ?",
    [pointsToRedeem, customerNomor]
  );
  const discountValue = pointsToRedeem * 500; // 1 poin = Rp500
  return { success: true, discount: discountValue, remainingPoints: Math.max(0, loyalty.points - pointsToRedeem) };
}


// --- FUNGSI SALDO & DEPOSIT ---
export async function getCustomerBalance(customerNomor) {
  const row = await getQuery("SELECT balance FROM customers WHERE nomor = ?", [customerNomor]);
  return row ? (row.balance || 0) : 0;
}




// --- FUNGSI REFERRAL ---
export async function getOrCreateReferralCode(customerNomor, name = 'Pelanggan') {
  let customer = await getQuery("SELECT referral_code FROM customers WHERE nomor = ?", [customerNomor]);
  if (customer && customer.referral_code) {
    return customer.referral_code;
  }
  const cleanName = (name || 'USER').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 5) || 'USER';
  const randNum = Math.floor(100 + Math.random() * 900);
  const refCode = `REF-${cleanName}${randNum}`;
  await runQuery("UPDATE customers SET referral_code = ? WHERE nomor = ?", [refCode, customerNomor]);
  return refCode;
}

export async function getCustomerByReferral(code) {
  return await getQuery("SELECT * FROM customers WHERE UPPER(referral_code) = UPPER(?)", [(code || '').trim()]);
}


// --- FUNGSI ANALITIK LANJUTAN ---

/**
 * Data pendapatan per hari untuk grafik timeline
 * @param {number} days - Jumlah hari terakhir (default: 30)
 */
export async function getDailySalesTimeline(days = 30) {
  return await allQuery(`
    SELECT 
      date(created_at) as date, 
      SUM(total) as revenue,
      COUNT(*) as order_count
    FROM orders
    WHERE status = 'COMPLETED' 
      AND date(created_at) >= date('now', '-' || ? || ' days')
    GROUP BY date(created_at)
    ORDER BY date ASC
  `, [days]);
}

/**
 * Top produk berdasarkan qty terjual dan revenue
 * @param {number} limit
 */
export async function getTopProducts(limit = 10) {
  return await allQuery(`
    SELECT 
      p.kode,
      p.nama,
      SUM(oi.qty) as total_qty,
      SUM(oi.subtotal) as total_revenue,
      COUNT(DISTINCT oi.order_id) as order_count
    FROM order_items oi
    JOIN products p ON oi.produk_kode = p.kode
    JOIN orders o ON oi.order_id = o.order_id
    WHERE o.status = 'COMPLETED'
    GROUP BY p.kode
    ORDER BY total_revenue DESC
    LIMIT ?
  `, [limit]);
}

/**
 * Top pelanggan berdasarkan total belanja
 * @param {number} limit
 */
export async function getTopCustomers(limit = 10) {
  return await allQuery(`
    SELECT 
      c.nomor,
      c.nama,
      COUNT(o.order_id) as total_orders,
      SUM(o.total) as total_spent,
      MAX(o.created_at) as last_order_at
    FROM customers c
    JOIN orders o ON c.nomor = o.customer_nomor
    WHERE o.status = 'COMPLETED'
    GROUP BY c.nomor
    ORDER BY total_spent DESC
    LIMIT ?
  `, [limit]);
}

/**
 * KPI summary untuk analytics dashboard
 */
export async function getAnalyticsSummary() {
  const [omzetBulanIni, omzetBulanLalu, avgOrder, repeatBuyers, totalCompleted, totalCustomers] = await Promise.all([
    getQuery(`SELECT COALESCE(SUM(total), 0) as val FROM orders WHERE status='COMPLETED' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`),
    getQuery(`SELECT COALESCE(SUM(total), 0) as val FROM orders WHERE status='COMPLETED' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', date('now', '-1 month'))`),
    getQuery(`SELECT COALESCE(AVG(total), 0) as val FROM orders WHERE status='COMPLETED'`),
    getQuery(`SELECT COUNT(*) as val FROM (SELECT customer_nomor FROM orders WHERE status='COMPLETED' GROUP BY customer_nomor HAVING COUNT(*) > 1)`),
    getQuery(`SELECT COUNT(*) as val FROM orders WHERE status='COMPLETED'`),
    getQuery(`SELECT COUNT(*) as val FROM customers`),
  ]);

  const omzetIni = omzetBulanIni.val || 0;
  const omzetLalu = omzetBulanLalu.val || 0;
  const growthPct = omzetLalu > 0 ? ((omzetIni - omzetLalu) / omzetLalu * 100).toFixed(1) : null;

  return {
    omzetBulanIni: omzetIni,
    omzetBulanLalu: omzetLalu,
    growthPct,
    avgOrderValue: Math.round(avgOrder.val || 0),
    repeatBuyers: repeatBuyers.val || 0,
    totalCompleted: totalCompleted.val || 0,
    totalCustomers: totalCustomers.val || 0,
    repeatRate: totalCustomers.val > 0 ? ((repeatBuyers.val / totalCustomers.val) * 100).toFixed(1) : '0.0',
  };
}

/**
 * Data heatmap per hari dalam sebulan
 * @param {number} year
 * @param {number} month (1-12)
 */
export async function getSalesHeatmap(year, month) {
  const paddedMonth = String(month).padStart(2, '0');
  return await allQuery(`
    SELECT 
      date(created_at) as date,
      COUNT(*) as order_count,
      COALESCE(SUM(total), 0) as revenue
    FROM orders
    WHERE status = 'COMPLETED'
      AND strftime('%Y', created_at) = ?
      AND strftime('%m', created_at) = ?
    GROUP BY date(created_at)
    ORDER BY date ASC
  `, [String(year), paddedMonth]);
}

/**
 * Fitur Ban / Unban User
 */
export async function banUser(jid, reason = '', bannedBy = 'system', expiresAt = null) {
  if (!jid) return false;
  const clean = jid.trim();
  await runQuery(
    `INSERT OR REPLACE INTO banned_users (jid, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)`,
    [clean, reason, bannedBy, expiresAt]
  );
  return true;
}

export async function unbanUser(jid) {
  if (!jid) return false;
  const clean = jid.trim();
  const digits = clean.replace(/[^0-9]/g, '');
  await runQuery(
    `DELETE FROM banned_users WHERE jid = ? OR (length(?) > 6 AND jid LIKE '%' || ? || '%')`,
    [clean, digits, digits]
  );
  return true;
}

export async function isUserBanned(jid) {
  if (!jid) return false;
  const clean = jid.trim();
  const digits = clean.replace(/[^0-9]/g, '');
  const row = await getQuery(
    `SELECT * FROM banned_users WHERE jid = ? OR (length(?) > 6 AND jid LIKE '%' || ? || '%')`,
    [clean, digits, digits]
  );
  if (!row) return false;

  // Hapus otomatis jika ban sudah kedaluwarsa
  if (row.expires_at) {
    const expiresAt = Number(row.expires_at);
    if (Date.now() > expiresAt) {
      await runQuery(`DELETE FROM banned_users WHERE jid = ?`, [row.jid]);
      return false;
    }
  }
  return true;
}

/**
 * Moderator System — User yang diberi izin Owner untuk pakai .ban/.unban
 */
export async function addModerator(jid, addedBy = 'owner') {
  if (!jid) return false;
  await runQuery(
    `INSERT OR REPLACE INTO moderators (jid, added_by) VALUES (?, ?)`,
    [jid.trim(), addedBy]
  );
  return true;
}

export async function removeModerator(jid) {
  if (!jid) return false;
  const clean = jid.trim();
  const digits = clean.replace(/[^0-9]/g, '');
  await runQuery(
    `DELETE FROM moderators WHERE jid = ? OR (length(?) > 6 AND jid LIKE '%' || ? || '%')`,
    [clean, digits, digits]
  );
  return true;
}

export async function isModerator(jid) {
  if (!jid) return false;
  const clean = jid.trim();
  const digits = clean.replace(/[^0-9]/g, '');
  const row = await getQuery(
    `SELECT * FROM moderators WHERE jid = ? OR (length(?) > 6 AND jid LIKE '%' || ? || '%')`,
    [clean, digits, digits]
  );
  return row ? true : false;
}

export async function listModerators() {
  return await allQuery(`SELECT jid, added_by, created_at FROM moderators ORDER BY created_at ASC`);
}

// Memperbarui status terakhir (harga & stok) sebuah produk untuk notifikasi
export async function updateProductLastState(kode, lastPrice, lastStockStatus) {
  return await runQuery(
    `UPDATE products SET last_price = ?, last_stock_status = ? WHERE kode = ?`,
    [lastPrice, lastStockStatus, kode]
  );
}

// ============================================================

// --- FUNGSI PREMIUM USERS ---
// ============================================================

export async function getPremiumUser(jid) {
  const row = await getQuery(
    "SELECT * FROM premium_users WHERE jid = ? AND datetime(expires_at) > datetime('now')",
    [jid]
  );
  return row || null;
}

export async function getPremiumTier(jid) {
  const premium = await getPremiumUser(jid);
  return premium ? premium.tier : 'Free';
}

/**
 * @param {object} opsi
 * @param {boolean} opsi.mulaiDariSekarang Hitung masa aktif dari SEKARANG, bukan
 *   menumpuk di atas sisa masa aktif yang lama. Dipakai saat pemain naik tier:
 *   sisa hari tier lama sudah dikonversi jadi hari di tier baru oleh pemanggil,
 *   jadi kalau ditumpuk lagi hari yang sama akan terhitung dua kali.
 */
export async function grantPremium(jid, tier, days, activatedBy = 'ADMIN', opsi = {}) {
  const validTiers = ['Silver', 'Gold', 'Diamond'];
  if (!validTiers.includes(tier)) throw new Error(`Tier tidak valid: ${tier}`);
  const safeDays = Math.max(1, Math.min(365, Number.parseInt(days, 10) || 30));

  // Cek apakah sudah premium, extend dari waktu expire
  const existing = opsi.mulaiDariSekarang
    ? null
    : await getQuery("SELECT expires_at FROM premium_users WHERE jid = ?", [jid]);
  let newExpiry;
  if (existing && new Date(existing.expires_at) > new Date()) {
    newExpiry = new Date(existing.expires_at);
    newExpiry.setDate(newExpiry.getDate() + safeDays);
  } else {
    newExpiry = new Date();
    newExpiry.setDate(newExpiry.getDate() + safeDays);
  }

  await runQuery(
    `INSERT INTO premium_users (jid, tier, expires_at, activated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET tier = ?, expires_at = ?, activated_by = ?, activated_at = CURRENT_TIMESTAMP`,
    [jid, tier, newExpiry.toISOString(), activatedBy, tier, newExpiry.toISOString(), activatedBy]
  );
  return { tier, expiresAt: newExpiry, days: safeDays };
}

export async function revokePremium(jid) {
  const result = await runQuery("DELETE FROM premium_users WHERE jid = ?", [jid]);
  return result.changes > 0;
}

export async function listPremiumUsers() {
  return await allQuery(
    `SELECT p.jid, p.tier, p.expires_at, p.activated_at, p.activated_by,
            COALESCE(c.nama, 'Member') AS nama
     FROM premium_users p
     LEFT JOIN customers c ON c.nomor = p.jid
     WHERE p.expires_at > datetime('now')
     ORDER BY p.tier DESC, p.expires_at ASC`
  );
}

export async function logPremiumBenefit(jid, benefitType, value) {
  await runQuery(
    "INSERT INTO premium_benefits_log (jid, benefit_type, value) VALUES (?, ?, ?)",
    [jid, benefitType, String(value || '')]
  );
}

export async function cleanExpiredPremium() {
  const result = await runQuery(
    "DELETE FROM premium_users WHERE expires_at <= datetime('now')"
  );
  return result.changes;
}

// ============================================================