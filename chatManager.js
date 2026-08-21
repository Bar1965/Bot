import * as db from './database.js';
import { broadcastToAdmins } from './websocket.js';
import { botState } from './server.js';
import fs from 'fs';
import path from 'path';

// Semua media yang dikirim dari dashboard WAJIB berada di dalam folder ini. Tanpa pagar ini,
// mediaPath dari body request bisa menunjuk ke berkas mana pun di server (.env, session/creds.json)
// dan berkas itu akan dikirimkan lewat WhatsApp.
const CHAT_MEDIA_ROOT = path.resolve('./public/uploads/chat_media');

function resolveSafeMediaPath(mediaPath) {
  if (typeof mediaPath !== 'string' || !mediaPath.trim()) return null;
  const resolved = path.resolve(mediaPath.trim());
  if (resolved !== CHAT_MEDIA_ROOT && !resolved.startsWith(CHAT_MEDIA_ROOT + path.sep)) return null;
  return resolved;
}

// Antrean pesan keluar
let outgoingQueue = [];
let isProcessingQueue = false;

// --- LOGIKA SAVE PESAN ---

export async function saveIncomingMessage({ id, customerJid, messageType, message, mediaPath, quotedId, timestamp }) {
  const msgObj = {
    id,
    customerJid,
    sender: 'customer',
    messageType,
    message,
    mediaPath,
    quotedId,
    timestamp,
    status: 'sent'
  };

  // Simpan ke database
  await db.saveChatMessage(msgObj);

  // Ambil unread count terupdate secara dinamis
  const conv = await db.getOrCreateConversation(customerJid);
  const rows = await db.allQuery(
    "SELECT COUNT(*) as count FROM messages WHERE customer_jid = ? AND sender = 'customer' AND timestamp > ?",
    [customerJid, conv.last_read_at]
  );
  const unreadCount = rows[0]?.count || 0;

  // Siarkan ke semua admin melalui WebSocket
  broadcastToAdmins('incoming_message', {
    id,
    customer_jid: customerJid,
    sender: 'customer',
    message_type: messageType,
    message,
    media_path: mediaPath,
    quoted_id: quotedId,
    timestamp,
    status: 'sent',
    unread_count: unreadCount,
    conversation_state: conv.conversation_state,
    assigned_admin_id: conv.assigned_admin_id,
    last_message_text: conv.last_message_text || message,
    labels: conv.labels
  });

  return msgObj;
}

export async function saveOutgoingMessage({ id, customerJid, sender = 'admin', messageType, message, mediaPath, quotedId, timestamp, status = 'sent' }) {
  const msgObj = {
    id,
    customerJid,
    sender,
    messageType,
    message,
    mediaPath,
    quotedId,
    timestamp,
    status
  };

  // Simpan ke database
  await db.saveChatMessage(msgObj);

  // Siarkan ke semua admin melalui WebSocket
  broadcastToAdmins('outgoing_message', {
    id,
    customer_jid: customerJid,
    sender,
    message_type: messageType,
    message,
    media_path: mediaPath,
    quoted_id: quotedId,
    timestamp,
    status
  });

  // Hubungkan ulang percakapan agar dinilai aktif oleh admin
  const conv = await db.getOrCreateConversation(customerJid);
  broadcastToAdmins('conversation_updated', {
    customer_jid: customerJid,
    last_message_text: conv.last_message_text,
    last_activity: timestamp,
    unread_count: 0
  });

  return msgObj;
}

// --- LOGIKA MESSAGE QUEUE & WORKER ---

export async function enqueueOutgoingMessage({ customerJid, messageType, message, mediaPath, quotedId, adminUsername }) {
  // Kunci berkas media ke folder unggahan chat sebelum apa pun disimpan atau diantrekan.
  let safeMediaPath = null;
  if (messageType && messageType !== 'text') {
    safeMediaPath = resolveSafeMediaPath(mediaPath);
    if (!safeMediaPath) {
      throw new Error('Lokasi berkas media tidak sah. Unggah dulu berkasnya lewat tombol lampiran.');
    }
  }

  const msgId = `admin_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  const msgObj = {
    id: msgId,
    customerJid,
    messageType,
    message,
    mediaPath,
    quotedId,
    safeMediaPath,
    timestamp: Date.now(),
    adminUsername,
    retryCount: 0,
    status: 'sending' // tandai sedang dikirim
  };

  // Simpan status awal ke DB
  await saveOutgoingMessage({
    ...msgObj,
    sender: adminUsername || 'admin',
    status: 'sending'
  });

  // Posisikan di akhir antrean
  outgoingQueue.push(msgObj);

  // Jalankan pemroses antrean di background
  processQueue();

  return msgObj;
}

export async function processQueue() {
  if (isProcessingQueue) return;
  if (outgoingQueue.length === 0) return;

  isProcessingQueue = true;

  while (outgoingQueue.length > 0) {
    const msg = outgoingQueue[0];
    
    // Periksa status koneksi bot WhatsApp
    if (!botState.whatsappConnected || !botState.sock) {
      console.log("[QUEUE] WhatsApp tidak terhubung. Menunda pengiriman pesan antrean.");
      break;
    }

    try {
      const sock = botState.sock;
      let sendOptions = {};
      if (msg.quotedId) {
        // quotes parsing jika membalas pesan
        sendOptions.quoted = {
          key: {
            remoteJid: msg.customerJid,
            id: msg.quotedId
          },
          message: { conversation: "" } // minimal placeholder
        };
      }

      let payload = {};
      if (msg.messageType === 'text') {
        payload = { text: msg.message };
      } else if (msg.messageType === 'image') {
        payload = { 
          image: fs.readFileSync(msg.safeMediaPath || msg.mediaPath), 
          caption: msg.message 
        };
      } else if (msg.messageType === 'file') {
        const filename = msg.mediaPath.split(/[/\\]/).pop();
        payload = { 
          document: fs.readFileSync(msg.safeMediaPath || msg.mediaPath), 
          mimetype: getMimeTypeFromPath(msg.mediaPath), 
          fileName: filename,
          caption: msg.message 
        };
      } else if (msg.messageType === 'video') {
        payload = { 
          video: fs.readFileSync(msg.safeMediaPath || msg.mediaPath), 
          caption: msg.message 
        };
      } else if (msg.messageType === 'audio') {
        payload = { 
          audio: fs.readFileSync(msg.safeMediaPath || msg.mediaPath), 
          mimetype: 'audio/mp4',
          ptt: true // voice note style
        };
      }

      // Kirim pesan melalui Baileys
      const result = await sock.sendMessage(msg.customerJid, payload, sendOptions);
      const sentId = result.key.id;

      // Update ID & status asli dari WhatsApp di database
      await db.runQuery("UPDATE messages SET id = ?, status = 'sent' WHERE id = ?", [sentId, msg.id]);
      
      // Siarkan update status terkirim ke dashboard admin
      broadcastToAdmins('message_status_updated', {
        tempId: msg.id,
        realId: sentId,
        customerJid: msg.customerJid,
        status: 'sent'
      });

      console.log(`[QUEUE] Pesan berhasil dikirim ke ${msg.customerJid}. ID WhatsApp: ${sentId}`);

      // Hapus dari antrean
      outgoingQueue.shift();

      // Tambahkan audit log
      await db.addLog('CHAT', `Admin ${msg.adminUsername || 'admin'} mengirim pesan ${msg.messageType} ke ${msg.customerJid}`);

    } catch (err) {
      console.error(`[QUEUE] Gagal mengirim pesan antrean (Percobaan ke-${msg.retryCount}):`, err.message);
      msg.retryCount++;
      
      if (msg.retryCount > 3) {
        // Gagal permanen
        await db.runQuery("UPDATE messages SET status = 'failed' WHERE id = ?", [msg.id]);
        broadcastToAdmins('message_status_updated', {
          tempId: msg.id,
          customerJid: msg.customerJid,
          status: 'failed'
        });
        outgoingQueue.shift();
      } else {
        // Jeda sebentar sebelum retry jika koneksi membaik
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  isProcessingQueue = false;
}

// Fungsi pembantu menentukan mime-type berkas sederhana
function getMimeTypeFromPath(filepath) {
  const ext = filepath.split('.').pop().toLowerCase();
  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'zip': return 'application/zip';
    case 'apk': return 'application/vnd.android.package-archive';
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'mp4': return 'video/mp4';
    case 'mp3': return 'audio/mpeg';
    default: return 'application/octet-stream';
  }
}
