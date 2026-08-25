import { runQuery, getQuery, allQuery, withTransaction, normalizePhoneDigits } from './connection.js';
import { config } from '../../config.js';
import { addLog } from './userDb.js';


// --- LOGIKA CHAT / PERCAKAPAN (LIVE CHAT) ---

export async function getOrCreateConversation(customerJid) {
  let customer = await getQuery("SELECT * FROM customers WHERE nomor = ?", [customerJid]);
  if (!customer) {
    const customerName = "Pelanggan";
    await runQuery("INSERT INTO customers (nomor, nama) VALUES (?, ?)", [customerJid, customerName]);
  }
  
  let conv = await getQuery("SELECT * FROM conversations WHERE customer_jid = ?", [customerJid]);
  if (!conv) {
    await runQuery(`
      INSERT INTO conversations (customer_jid, conversation_state, last_activity) 
      VALUES (?, 'BOT', ?)
    `, [customerJid, Date.now()]);
    conv = await getQuery("SELECT * FROM conversations WHERE customer_jid = ?", [customerJid]);
  }
  return conv;
}

export async function getConversationsList() {
  const sql = `
    SELECT 
      c.nomor as customer_jid,
      c.nama as customer_nama,
      cv.conversation_state,
      cv.assigned_admin_id,
      cv.last_read_message_id,
      cv.last_read_at,
      cv.last_message_text,
      cv.last_activity,
      cv.internal_notes,
      cv.labels,
      cv.is_pinned,
      cv.draft_text,
      (
        SELECT COUNT(*) FROM messages m 
        WHERE m.customer_jid = c.nomor 
          AND m.sender = 'customer' 
          AND m.timestamp > cv.last_read_at
      ) as unread_count
    FROM customers c
    JOIN conversations cv ON c.nomor = cv.customer_jid
    ORDER BY cv.is_pinned DESC, cv.last_activity DESC
  `;
  return await allQuery(sql);
}

export async function getConversationMessages(customerJid, limit = 100) {
  const sql = `
    SELECT * FROM messages 
    WHERE customer_jid = ? 
    ORDER BY timestamp ASC 
    LIMIT ?
  `;
  return await allQuery(sql, [customerJid, limit]);
}

export async function saveChatMessage({ id, customerJid, sender, messageType, message, mediaPath, quotedId, timestamp, status = 'sent' }) {
  await getOrCreateConversation(customerJid);

  await runQuery(`
    INSERT OR REPLACE INTO messages (id, customer_jid, sender, message_type, message, media_path, quoted_id, timestamp, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, customerJid, sender, messageType, message, mediaPath, quotedId, timestamp, status]);

  let lastMsgText = message;
  if (messageType === 'image') lastMsgText = '📷 Gambar';
  else if (messageType === 'video') lastMsgText = '🎥 Video';
  else if (messageType === 'audio') lastMsgText = '🎙️ Pesan Suara';
  else if (messageType === 'file') lastMsgText = '📄 Dokumen';

  await runQuery(`
    UPDATE conversations 
    SET last_message_text = ?, last_activity = ?
    WHERE customer_jid = ?
  `, [lastMsgText, timestamp, customerJid]);

  if (sender !== 'customer') {
    await runQuery(`
      UPDATE conversations 
      SET last_read_at = ?
      WHERE customer_jid = ?
    `, [timestamp, customerJid]);
  }
}

export async function updateConversationState(customerJid, state, adminId = null) {
  await getOrCreateConversation(customerJid);
  await runQuery(`
    UPDATE conversations 
    SET conversation_state = ?, assigned_admin_id = ?
    WHERE customer_jid = ?
  `, [state, adminId, customerJid]);
}

export async function updateConversationNotes(customerJid, notes) {
  await getOrCreateConversation(customerJid);
  await runQuery(`
    UPDATE conversations 
    SET internal_notes = ?
    WHERE customer_jid = ?
  `, [notes, customerJid]);
}

export async function updateConversationLabels(customerJid, labels) {
  await getOrCreateConversation(customerJid);
  await runQuery(`
    UPDATE conversations 
    SET labels = ?
    WHERE customer_jid = ?
  `, [labels, customerJid]);
}

export async function updateConversationPin(customerJid, isPinned) {
  await getOrCreateConversation(customerJid);
  await runQuery(`
    UPDATE conversations 
    SET is_pinned = ?
    WHERE customer_jid = ?
  `, [isPinned ? 1 : 0, customerJid]);
}

export async function updateConversationReadStatus(customerJid, timestamp = Date.now()) {
  await getOrCreateConversation(customerJid);
  await runQuery(`
    UPDATE conversations 
    SET last_read_at = ?
    WHERE customer_jid = ?
  `, [timestamp, customerJid]);
}

export async function updateMessageStatus(messageId, status) {
  await runQuery(`
    UPDATE messages 
    SET status = ?
    WHERE id = ?
  `, [status, messageId]);
}


// --- FUNGSI CLEANUP MEDIA CHAT ---

/**
 * Mengambil semua media_path yang aman untuk dihapus secara fisik.
 * Sebuah path dianggap aman jika:
 * 1. Pesan lebih tua dari cutoffMs
 * 2. Tidak ada pesan LAIN yang lebih baru dengan path yang sama
 * 3. Percakapan terkait bukan sedang dalam mode ADMIN takeover
 * 4. Percakapan sudah idle (last_activity < cutoffMs)
 */
export async function getOrphanedMediaPaths(cutoffMs) {
  const rows = await allQuery(`
    SELECT DISTINCT m.media_path
    FROM messages m
    JOIN conversations cv ON m.customer_jid = cv.customer_jid
    WHERE m.media_path IS NOT NULL
      AND m.media_path != ''
      AND m.timestamp < ?
      AND cv.conversation_state != 'ADMIN'
      AND cv.last_activity < ?
      AND m.media_path NOT IN (
        SELECT media_path FROM messages
        WHERE media_path IS NOT NULL
          AND media_path != ''
          AND timestamp >= ?
      )
  `, [cutoffMs, cutoffMs, cutoffMs]);
  return rows.map(r => r.media_path);
}

/**
 * Semua media_path yang MASIH dirujuk baris messages mana pun, tanpa memandang
 * umur atau status percakapan. Dipakai pembersih media untuk membedakan
 * "file yatim sungguhan" (tidak punya baris sama sekali) dari "file yang sengaja
 * dilindungi" (punya baris, tapi percakapannya ADMIN atau masih aktif).
 */
export async function getReferencedMediaPaths() {
  const rows = await allQuery(
    "SELECT DISTINCT media_path FROM messages WHERE media_path IS NOT NULL AND media_path != ''"
  );
  return rows.map(r => r.media_path);
}

/**
 * Set media_path = NULL untuk daftar path yang sudah dihapus secara fisik.
 * Mencegah dashboard menampilkan URL media yang sudah tidak ada (404).
 * Diproses dalam batch 50 untuk menghindari query terlalu panjang.
 */
export async function nullifyMediaPaths(pathList) {
  if (!Array.isArray(pathList) || pathList.length === 0) return 0;
  let total = 0;
  const BATCH = 50;
  for (let i = 0; i < pathList.length; i += BATCH) {
    const batch = pathList.slice(i, i + BATCH);
    const placeholders = batch.map(() => '?').join(',');
    const result = await runQuery(
      `UPDATE messages SET media_path = NULL WHERE media_path IN (${placeholders})`,
      batch
    );
    total += result.changes || 0;
  }
  return total;
}


// --- FUNGSI PERINGATAN MODERASI (CUSTOMER WARNINGS) ---

export async function addCustomerWarning(jid, reason) {
  await runQuery(
    "INSERT INTO customer_warnings (jid, reason) VALUES (?, ?)",
    [jid, reason]
  );
  const countObj = await getQuery("SELECT COUNT(*) as count FROM customer_warnings WHERE jid = ?", [jid]);
  const total = countObj ? countObj.count : 1;
  await addLog("MODERATION", `Peringatan (${total}x) diberikan kepada ${jid}: ${reason}`);
  return total;
}

export async function getCustomerWarningsCount(jid) {
  const row = await getQuery("SELECT COUNT(*) as count FROM customer_warnings WHERE jid = ?", [jid]);
  return row ? row.count : 0;
}

export async function clearCustomerWarnings(jid) {
  await runQuery("DELETE FROM customer_warnings WHERE jid = ?", [jid]);
  await addLog("MODERATION", `Peringatan untuk ${jid} berhasil dibersihkan.`);
}


// --- FUNGSI RIWAYAT BROADCAST RESTOK ---

export async function createBroadcastHistory(productCode, totalSubscribers) {
  const res = await runQuery(
    "INSERT INTO broadcast_history (product_code, total_subscribers, success_count, failed_count, started_at) VALUES (?, ?, 0, 0, CURRENT_TIMESTAMP)",
    [productCode, totalSubscribers]
  );
  return res.lastID;
}

export async function updateBroadcastHistory(id, successCount, failedCount) {
  await runQuery(
    "UPDATE broadcast_history SET success_count = ?, failed_count = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?",
    [successCount, failedCount, id]
  );
}

export async function getBroadcastHistoryList() {
  return await allQuery("SELECT * FROM broadcast_history ORDER BY started_at DESC LIMIT 50");
}


// --- FUNGSI PENGATURAN MODERASI PER-GRUP ---

/**
 * features_config disimpan sebagai teks JSON di SQLite, tapi seluruh kode
 * pemanggil memperlakukannya sebagai objek (`settings.features_config['tcg']`).
 * Dua fungsi kecil ini yang menjembatani keduanya.
 */
function parseFeaturesConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(raw);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch (_) {
    return {};
  }
}

function serializeFeaturesConfig(value) {
  try {
    return JSON.stringify(parseFeaturesConfig(value));
  } catch (_) {
    return '{}';
  }
}

export async function getGroupSettings(jid) {
  const row = await getQuery("SELECT * FROM group_settings WHERE jid = ?", [jid]);
  if (!row) {
    const defaults = config.defaults;
    return {
      jid,
      welcome_enabled: defaults.welcomeEnabled === "true" ? 1 : 0,
      welcome_msg: defaults.welcomeMessage,
      goodbye_enabled: defaults.goodbyeEnabled === "true" ? 1 : 0,
      goodbye_msg: defaults.goodbyeMessage,
      anti_link: 0,
      bot_mode: 'all',
      auto_sholat: 1,
      levelup_enabled: 1,
      auto_dl_enabled: 1,
      features_config: {}
    };
  }
  return {
    ...row,
    bot_mode: row.bot_mode || 'all',
    auto_sholat: row.auto_sholat !== undefined ? row.auto_sholat : 1,
    levelup_enabled: row.levelup_enabled !== undefined ? row.levelup_enabled : 1,
    auto_dl_enabled: row.auto_dl_enabled !== undefined ? row.auto_dl_enabled : 1,
    features_config: parseFeaturesConfig(row.features_config)
  };
}

export async function updateGroupSettings(jid, settingsObj) {
  const current = await getGroupSettings(jid);
  const updated = { ...current, ...settingsObj };
  await runQuery(
    "INSERT OR REPLACE INTO group_settings (jid, welcome_enabled, welcome_msg, goodbye_enabled, goodbye_msg, anti_link, bot_mode, auto_sholat, levelup_enabled, auto_dl_enabled, features_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      jid,
      updated.welcome_enabled ? 1 : 0,
      updated.welcome_msg,
      updated.goodbye_enabled ? 1 : 0,
      updated.goodbye_msg,
      updated.anti_link ? 1 : 0,
      updated.bot_mode || 'all',
      updated.auto_sholat !== undefined ? updated.auto_sholat : 1,
      updated.levelup_enabled !== undefined ? (updated.levelup_enabled ? 1 : 0) : 1,
      updated.auto_dl_enabled !== undefined ? (updated.auto_dl_enabled ? 1 : 0) : 1,
      serializeFeaturesConfig(updated.features_config)
    ]
  );
  await addLog("SYSTEM", `Pengaturan grup ${jid} diperbarui dari Web Dashboard/Bot.`);
}


// --- FUNGSI FAQ OTOMATIS ---
export async function addFaq(keywords, answer) {
  const res = await runQuery(
    "INSERT INTO faqs (keywords, answer) VALUES (?, ?)",
    [keywords.toLowerCase(), answer]
  );
  await addLog("SYSTEM", `FAQ baru ditambahkan: ${keywords}`);
  return res.lastID;
}

export async function deleteFaq(id) {
  const res = await runQuery("DELETE FROM faqs WHERE id = ?", [id]);
  return res.changes > 0;
}

export async function getAllFaqs() {
  return await allQuery("SELECT * FROM faqs ORDER BY id ASC");
}

export async function findFaqMatch(text) {
  const faqs = await allQuery("SELECT * FROM faqs");
  const textLower = text.toLowerCase();
  for (const faq of faqs) {
    const keywords = faq.keywords.split(',').map(k => k.trim());
    for (const keyword of keywords) {
      if (textLower.includes(keyword) && keyword.length >= 3) {
        return faq;
      }
    }
  }
  return null;
}


// --- FUNGSI SESI MENFESS 2-ARAH (ANONYMOUS CHAT) ---

export async function createMenfessSession(sessionId, senderJid, targetJid) {
  await runQuery(
    "INSERT INTO menfess_sessions (id, sender_jid, target_jid, status) VALUES (?, ?, ?, 'ACTIVE')",
    [sessionId, senderJid, targetJid]
  );
  return { id: sessionId, sender_jid: senderJid, target_jid: targetJid, status: 'ACTIVE' };
}

export async function getMenfessSession(sessionId) {
  return await getQuery("SELECT * FROM menfess_sessions WHERE id = ?", [sessionId]);
}

export async function getActiveMenfessByParticipant(userJid) {
  if (!userJid) return null;
  const cleanJid = String(userJid).replace(/:[0-9]+@/, '@').trim();
  const digits = normalizePhoneDigits(userJid);

  const exact = await getQuery(
    "SELECT * FROM menfess_sessions WHERE (sender_jid = ? OR target_jid = ? OR sender_jid = ? OR target_jid = ?) AND status = 'ACTIVE' ORDER BY last_reply_at DESC LIMIT 1",
    [userJid, userJid, cleanJid, cleanJid]
  );
  if (exact) return exact;

  if (digits && digits.length >= 7) {
    const digitMatch = await getQuery(
      "SELECT * FROM menfess_sessions WHERE (sender_jid LIKE ? OR target_jid LIKE ?) AND status = 'ACTIVE' ORDER BY last_reply_at DESC LIMIT 1",
      [`%${digits}%`, `%${digits}%`]
    );
    if (digitMatch) return digitMatch;
  }
  return null;
}

export async function updateMenfessLastReply(sessionId) {
  return await runQuery(
    "UPDATE menfess_sessions SET last_reply_at = CURRENT_TIMESTAMP WHERE id = ?",
    [sessionId]
  );
}

export async function closeMenfessSession(sessionId) {
  return await runQuery(
    "UPDATE menfess_sessions SET status = 'CLOSED' WHERE id = ?",
    [sessionId]
  );
}
