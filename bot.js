import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState, 
  downloadMediaMessage,
  jidNormalizedUser,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';

import { config } from './config.js';
import * as db from './database.js';
import { botState, createMidtransTransaction } from './server.js';

// Setup Logger
const logger = P({ level: 'info' });

let sock = null;
let botSettings = {};

// Helper universal memformat tampilan JID/nomor WA (+62 vs 🆔 LID:)
export function formatPhoneNumber(jid) {
  if (!jid) return '-';
  const clean = jid.trim();
  
  if (clean.endsWith('@lid') || clean.includes('@lid')) {
    const rawId = clean.split('@')[0];
    return `🆔 LID: ${rawId}`;
  }
  
  const rawNumber = clean.split('@')[0].replace(/[^0-9]/g, '');
  if (rawNumber.startsWith('62')) {
    const rest = rawNumber.slice(2);
    if (rest.length >= 8) {
      const part1 = rest.slice(0, 3);
      const part2 = rest.slice(3, 7);
      const part3 = rest.slice(7);
      return `+62 ${part1}-${part2}${part3 ? '-' + part3 : ''}`;
    }
    return `+${rawNumber}`;
  }
  
  return `+${rawNumber}`;
}

// Rate Limiter Storage: Map<senderJid, number[]>
const userMessageTimestamps = new Map();
// Storage penghitung pesan tidak dikenal per pelanggan: Map<senderNumber, number>
const unknownMessageCounter = new Map();

function extractTargetJid(m, args) {
  if (!m) return null;
  // 1. Tag / Mention dalam pesan
  const mentions = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || 
                   m.message?.conversation?.contextInfo?.mentionedJid || [];
  if (mentions.length > 0) return mentions[0];

  // 2. Quoted / Reply pesan seseorang
  const participant = m.message?.extendedTextMessage?.contextInfo?.participant;
  if (participant) return participant;

  // 3. Ketik nomor langsung di argumen 1 (misal /kick 6281234567890)
  if (args && args[1]) {
    let raw = args[1].replace(/[^0-9]/g, '');
    if (raw) return raw.endsWith('@s.whatsapp.net') ? raw : `${raw}@s.whatsapp.net`;
  }
  return null;
}

async function handleAntiSpamAndAntiLink(m, jid, senderNormalized, isGroup, msgText) {
  if (!isGroup) return false;

  const antiSpamOn = (botSettings.antiSpamEnabled || "true") === "true";
  const antiLinkOn = (botSettings.antiLinkEnabled || "true") === "true";
  const maxSpamMsgs = parseInt(botSettings.spamThreshold) || 5;
  const spamWindowMs = parseInt(botSettings.spamWindow) || 5000;
  const kickAfter = parseInt(botSettings.kickAfterWarnings) || 3;
  const blockedDomains = (botSettings.blockedDomains || "chat.whatsapp.com,bit.ly,tinyurl,t.me,discord.gg").split(',').map(d => d.trim().toLowerCase());
  const allowedDomains = (botSettings.allowedDomains || "tokopedia.com,shopee.co.id,bukalapak.com").split(',').map(d => d.trim().toLowerCase());

  // 1. Anti-Link Scan
  if (antiLinkOn && msgText) {
    const urlRegex = /(https?:\/\/[^\s]+|chat\.whatsapp\.com\/[^\s]+|t\.me\/[^\s]+|discord\.gg\/[^\s]+)/gi;
    const matches = msgText.match(urlRegex);

    if (matches && matches.length > 0) {
      let isViolation = false;
      for (const urlStr of matches) {
        const lowerUrl = urlStr.toLowerCase();
        const isAllowed = allowedDomains.some(dom => dom && lowerUrl.includes(dom));
        if (!isAllowed) {
          const isBlocked = blockedDomains.some(dom => dom && lowerUrl.includes(dom)) || lowerUrl.includes('chat.whatsapp.com');
          if (isBlocked) {
            isViolation = true;
            break;
          }
        }
      }

      if (isViolation) {
        const warnings = await db.addCustomerWarning(senderNormalized, "Pengiriman link terlarang / promosi grup di grup.");
        
        try {
          await sock.sendMessage(jid, { delete: m.key });
        } catch (e) {}

        if (warnings >= kickAfter) {
          await sock.sendMessage(jid, { text: `🚨 @${senderNormalized.split('@')[0]} telah di-KICK dari grup karena mencapai ${warnings}x peringatan (Link Terlarang).`, mentions: [senderNormalized] });
          try {
            await sock.groupParticipantsUpdate(jid, [senderNormalized], "remove");
          } catch (e) {
            console.error(`[ANTI_LINK] Gagal kick ${senderNormalized}:`, e.message);
          }
        } else {
          await sock.sendMessage(jid, { text: `⚠️ *PERINGATAN MODERASI (${warnings}/${kickAfter})*\n@${senderNormalized.split('@')[0]}, dilarang mengirimkan link promosi di grup ini!`, mentions: [senderNormalized] });
        }
        return true;
      }
    }
  }

  // 2. Anti-Spam Rate Limiter
  if (antiSpamOn) {
    const now = Date.now();
    let timestamps = userMessageTimestamps.get(senderNormalized) || [];
    timestamps = timestamps.filter(t => now - t < spamWindowMs);
    timestamps.push(now);
    userMessageTimestamps.set(senderNormalized, timestamps);

    if (timestamps.length >= maxSpamMsgs) {
      userMessageTimestamps.delete(senderNormalized);
      const warnings = await db.addCustomerWarning(senderNormalized, `Spamming ${timestamps.length} pesan dalam ${spamWindowMs / 1000} detik.`);

      if (warnings >= kickAfter) {
        await sock.sendMessage(jid, { text: `🚨 @${senderNormalized.split('@')[0]} telah di-KICK dari grup karena melakukan SPAM berturut-turut (${warnings}x peringatan).`, mentions: [senderNormalized] });
        try {
          await sock.groupParticipantsUpdate(jid, [senderNormalized], "remove");
        } catch (e) {
          console.error(`[ANTI_SPAM] Gagal kick ${senderNormalized}:`, e.message);
        }
      } else {
        await sock.sendMessage(jid, { text: `⚠️ *PERINGATAN SPAM (${warnings}/${kickAfter})*\n@${senderNormalized.split('@')[0]}, harap tenang dan jangan melakukan spam pesan!`, mentions: [senderNormalized] });
      }
      return true;
    }
  }

  return false;
}

// Asynchronous Restock Broadcast Worker Queue
export async function triggerRestockBroadcast(productCode) {
  try {
    const product = await db.getProductByKode(productCode);
    if (!product) return { success: false, message: "Produk tidak ditemukan." };

    const subscribers = await db.getSubscribers(productCode);
    const subscriberJids = Array.from(new Set(subscribers.map(s => s.customer_nomor)));

    const historyId = await db.createBroadcastHistory(productCode, subscriberJids.length);

    if (subscriberJids.length === 0) {
      await db.updateBroadcastHistory(historyId, 0, 0);
      return { success: true, count: 0, message: "Tidak ada pelanggan yang berlangganan notifikasi produk ini." };
    }

    console.log(`[RESTOCK_QUEUE] Memulai pengiriman siaran restok ${productCode} ke ${subscriberJids.length} pelanggan...`);
    await db.addLog("BROADCAST", `Memulai siaran restok ${productCode} ke ${subscriberJids.length} pelanggan.`);

    (async () => {
      let success = 0;
      let failed = 0;
      const delayMs = parseInt(botSettings.broadcastDelay) || 3000;

      for (const jid of subscriberJids) {
        try {
          const msg = `🔔 *KABAR GEMBIRA! PRODUK READY RESTOK!* 📦
          
Produk favorit Anda: *${product.nama}* (\`${product.kode}\`) kini sudah *READY KEMBALI* dengan stok: *${product.stok} pcs*!

💰 Harga: *Rp${product.harga.toLocaleString('id-ID')}*
📝 ${product.deskripsi || ''}

Ketik \`buy ${product.kode}\` atau langsung checkout untuk memesan sebelum kehabisan! 🛒`;

          if (sock && botState.whatsappConnected) {
            await sock.sendMessage(jid, { text: msg });
            success++;
          } else {
            failed++;
          }
        } catch (e) {
          failed++;
          console.error(`[RESTOCK_QUEUE] Gagal kirim ke ${jid}:`, e.message);
        }

        const jitter = Math.floor(Math.random() * 1000);
        await new Promise(r => setTimeout(r, delayMs + jitter));
      }

      await db.updateBroadcastHistory(historyId, success, failed);
      await db.addLog("BROADCAST", `🏁 Siaran restok ${productCode} selesai: ${success} terkirim, ${failed} gagal.`);
    })();

    return { success: true, count: subscriberJids.length, message: `Siaran restok untuk ${productCode} telah dimasukkan ke antrean (${subscriberJids.length} pelanggan).` };
  } catch (err) {
    console.error(`[RESTOCK_BROADCAST] Error:`, err.message);
    return { success: false, message: err.message };
  }
}

// Helper mengecek apakah pelanggan sudah bergabung ke grup resmi toko sebelum beli
async function checkIsUserInGroup(senderNumber) {
  const isRequire = (botSettings.requireGroupJoin || "true") === "true";
  if (!isRequire) return { isMember: true };

  const targetGroupId = botSettings.buyerGroupId || botSettings.transactionGroupId || botSettings.logGroupId || "";
  
  if (!targetGroupId) {
    return { isMember: true };
  }

  try {
    const groupMeta = await sock.groupMetadata(targetGroupId);
    const extractDigits = (s) => (s || '').replace(/[^0-9]/g, '');
    const senderDigits = extractDigits(senderNumber);

    const isMember = groupMeta.participants.some(p => {
      const pDigits = extractDigits(p.id);
      return pDigits.length > 6 && senderDigits.includes(pDigits);
    });

    let inviteLink = botSettings.groupInviteLink || "";
    if (!inviteLink) {
      try {
        const code = await sock.groupInviteCode(targetGroupId);
        inviteLink = `https://chat.whatsapp.com/${code}`;
      } catch (e) {}
    }

    return { isMember, inviteLink, groupName: groupMeta.subject || "Grup Resmi Toko" };
  } catch (err) {
    console.error(`[CHECK_GROUP_MEMBER] Gagal cek anggota grup ${targetGroupId}:`, err.message);
    return { isMember: true };
  }
}

// Fungsi untuk memuat ulang pengaturan bot dari SQLite
export async function reloadBotSettings() {
  try {
    botSettings = await db.getSettings();
    console.log("Pengaturan bot berhasil diperbarui dari database.");
  } catch (err) {
    console.error("Gagal memuat pengaturan bot dari DB:", err.message);
  }
}

// Fungsi Helper untuk mengirim log sistem (DB & Log Group WhatsApp)
async function logToSystem(type, text) {
  console.log(`[${type}] ${text}`);
  // Catat ke tabel log SQLite
  await db.addLog(type, text);

  // Jika WA terkoneksi dan ada Log Group terdaftar
  if (sock && botState.whatsappConnected && botSettings.logGroupId) {
    try {
      await sock.sendMessage(botSettings.logGroupId, { text: `📢 *LOG [${type}]:*\n${text}` });
    } catch (err) {
      console.error('Gagal mengirim log ke WhatsApp Log Group:', err.message);
    }
  }
}

// Fungsi untuk mengirim pesan massal notifikasi stok saat produk ready kembali
export async function checkAndNotifySubscribers(kode, newStock) {
  try {
    if (newStock > 0) {
      const subscribers = await db.getAndClearSubscribers(kode);
      if (subscribers.length > 0) {
        const product = await db.getProductByKode(kode);
        const msg = `🎉 *STOK READY KEMBALI!*

Halo, produk *${product.nama}* (\`${kode.toUpperCase()}\`) yang Anda tunggu-tunggu saat ini sudah tersedia kembali!

Stok ready saat ini: *${newStock}* pcs.
Segera lakukan pemesanan dengan mengetik:
👉 *beli ${kode.toUpperCase()} 1*

Jangan sampai kehabisan lagi ya!`;

        // Kirim ke semua pelanggan yang berlangganan
        for (const num of subscribers) {
          if (sock && botState.whatsappConnected) {
            try {
              await sock.sendMessage(num, { text: msg });
              await logToSystem('SYSTEM', `Mengirimkan pemberitahuan stok ready ke ${num} untuk produk ${kode.toUpperCase()}`);
              // Tambahkan jeda 1 detik untuk menghindari pemblokiran WA
              await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (err) {
              console.error(`Gagal kirim notif stok ke ${num}:`, err.message);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("Gagal memproses notifikasi pelanggan:", err.message);
  }
}

// Fungsi Helper untuk mengirim QRIS dengan fallback dinamis
async function sendQris(jid, captionText) {
  try {
    const qrisPath = botSettings.qrisImagePath || config.defaults.qrisImagePath;
    if (fs.existsSync(qrisPath)) {
      await sock.sendMessage(jid, { 
        image: { url: qrisPath }, 
        caption: captionText 
      });
    } else {
      const warningText = `⚠️ *Gambar QRIS Toko belum disiapkan oleh Admin.*\n\n${captionText}\n\n${botSettings.paymentInstructions || config.defaults.paymentInstructions}`;
      await sock.sendMessage(jid, { text: warningText });
    }
  } catch (err) {
    console.error('Gagal mengirim gambar QRIS:', err);
    await sock.sendMessage(jid, { text: captionText });
  }
}

// --- ANTREAN PESAN KELUARAN & KELOLA LIFECYCLE SOCKET (Baileys Fix v2 - Phase 3 & Phase 4) ---
const outgoingMessageQueue = [];
let isQueueProcessing = false;

// Fungsi terpusat aman untuk mengirim pesan WA (Connection Guard & Retries & Queueing)
export async function safeSendMessage(jid, content, options = {}) {
  botState.lastSentTimestamp = Date.now();
  
  return new Promise((resolve, reject) => {
    const queueItem = {
      jid,
      content,
      options,
      retries: 0,
      maxRetries: 3,
      resolve,
      reject,
      enqueuedAt: Date.now()
    };
    
    outgoingMessageQueue.push(queueItem);
    botState.pendingQueueCount = outgoingMessageQueue.length;
    
    processOutgoingQueue();
  });
}

export async function processOutgoingQueue() {
  if (isQueueProcessing) return;
  isQueueProcessing = true;

  while (outgoingMessageQueue.length > 0) {
    botState.pendingQueueCount = outgoingMessageQueue.length;

    // Jika koneksi socket belum OPEN, tahan queue dan tunggu reconnect
    if (!sock || !botState.whatsappConnected) {
      console.log(`[QUEUE] Socket offline. Menunda pengiriman antrean (${outgoingMessageQueue.length} pesan terpending).`);
      break;
    }

    const item = outgoingMessageQueue[0];
    const logPrefix = `[MSG_SEND][ID: ${item.enqueuedAt}] JID: ${item.jid}`;

    console.log(`${logPrefix} SEND START (Retry: ${item.retries}/${item.maxRetries})`);

    try {
      const sendFn = sock.rawSendMessage ? sock.rawSendMessage : sock.sendMessage.bind(sock);
      const result = await sendFn(item.jid, item.content, item.options);
      console.log(`${logPrefix} SUCCESS (MessageID: ${result?.key?.id || 'N/A'})`);
      
      outgoingMessageQueue.shift();
      botState.pendingQueueCount = outgoingMessageQueue.length;
      item.resolve(result);
    } catch (err) {
      console.error(`${logPrefix} SEND FAILED (Reason: ${err.message})`);
      item.retries += 1;

      if (item.retries >= item.maxRetries) {
        console.error(`${logPrefix} Gagal total setelah ${item.maxRetries}x percobaan.`);
        outgoingMessageQueue.shift();
        botState.pendingQueueCount = outgoingMessageQueue.length;
        item.reject(err);
      } else {
        // Retry delay backoff: 1s, 3s, 5s
        const backoffMs = item.retries === 1 ? 1000 : (item.retries === 2 ? 3000 : 5000);
        console.log(`${logPrefix} Mencoba ulang dalam ${backoffMs}ms...`);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }

  isQueueProcessing = false;
}

// Inisialisasi koneksi WhatsApp (Diekspor untuk index.js)
export async function startBot(onSocketReady) {
  // Pastikan DB terinisialisasi
  await db.initDb();
  // Muat pengaturan toko awal dari DB
  await reloadBotSettings();

  // Folder sesi WA
  const sessionFolder = './session';
  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

  // Ambil versi terbaru WhatsApp Web dari Baileys, fallback ke versi stabil 2.3000.1035194821
  let waVersion = [2, 3000, 1035194821];
  try {
    const { version: latestVersion, isLatest } = await fetchLatestBaileysVersion();
    waVersion = latestVersion;
    console.log(`Menghubungkan menggunakan WA Web v${waVersion.join('.')}, Terkini: ${isLatest}`);
  } catch (err) {
    console.warn("Gagal mengambil versi WA Web terbaru, menggunakan versi fallback:", waVersion.join('.'));
  }

  // Single Socket Policy: Bersihkan socket lama secara menyeluruh sebelum reconnect (Phase 3)
  if (sock) {
    console.log("[SOCKET_LIFECYCLE] Membersihkan instansi socket lama secara penuh...");
    try {
      sock.ev.removeAllListeners();
      if (sock.ws) {
        try { sock.ws.close(); } catch (e) {}
      }
      try { sock.end(new Error("Reconnecting single socket policy...")); } catch(e) {}
    } catch (e) {
      console.warn("[SOCKET_LIFECYCLE] Cleanup socket lama:", e.message);
    }
    sock = null;
  }

  sock = makeWASocket({
    auth: state,
    version: waVersion,
    logger: P({ level: 'silent' }),
    browser: ['Windows', 'Chrome', '110.0.5481.177'],
    markOnlineOnConnect: true,
    syncFullHistory: false
  });

  // Alias sendMessage ke safeSendMessage untuk Connection Guard & Queueing & Retries
  const originalSendMessage = sock.sendMessage.bind(sock);
  sock.rawSendMessage = originalSendMessage;
  sock.sendMessage = async (jid, content, options) => {
    return await safeSendMessage(jid, content, options);
  };

  // Hubungkan event updates (Phase 1 & Phase 3)
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === 'connecting') {
      console.log('[SOCKET_STATE] Connecting to WhatsApp servers...');
      botState.status = 'CONNECTING';
    }

    if (qr) {
      botState.status = 'CONNECTING';
      botState.whatsappConnected = false;
      console.log('[SOCKET_STATE] QR Code generated. Scan required.');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      botState.status = 'OFFLINE';
      botState.whatsappConnected = false;
      botState.sock = null;
      botState.reconnectCount = (botState.reconnectCount || 0) + 1;

      const statusCode = lastDisconnect?.error instanceof Boom 
        ? lastDisconnect.error.output?.statusCode 
        : null;

      botState.lastDisconnectReason = statusCode;
        
      const shouldReconnect = 
        statusCode !== DisconnectReason.loggedOut && 
        statusCode !== DisconnectReason.connectionReplaced;
      
      console.log(`[SOCKET_STATE] Connection CLOSED. StatusCode: ${statusCode}, ShouldReconnect: ${shouldReconnect}`);
      
      if (shouldReconnect) {
        await logToSystem('SYSTEM', `[SOCKET] Terputus (${statusCode}). Reconnect #${botState.reconnectCount} dalam 5 detik...`);
        setTimeout(() => startBot(onSocketReady), 5000);
      } else {
        if (statusCode === DisconnectReason.connectionReplaced) {
          console.warn("⚠️ [SOCKET] Connection Replaced (405). Sesi dipasang di instance lain.");
          await logToSystem('SYSTEM', '⚠️ Connection Replaced (405). Pastikan hanya 1 bot running.');
        } else {
          console.warn("⚠️ [SOCKET] Logged Out (401). Sesi terputus permanen.");
          await logToSystem('SYSTEM', '⚠️ Sesi WA terputus permanen. Scan QR ulang melalui Web Dashboard.');
        }
      }
    } else if (connection === 'open') {
      botState.status = 'ONLINE';
      botState.whatsappConnected = true;
      botState.sock = sock;
      botState.lastReconnect = Date.now();

      console.log('[SOCKET_STATE] Connection OPEN. Session & Signal Keys synchronized.');
      await logToSystem('SYSTEM', '🟢 Bot WhatsApp Sales ONLINE & Signal Session Synchronized!');
      
      // Flush antrean pesan jika ada pesan terpending selama offline (Phase 4)
      processOutgoingQueue();

      if (onSocketReady) {
        onSocketReady(sock);
      }
    }
  });

  // Credential Update Logging (Phase 1 & Phase 2)
  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
      botState.lastCredUpdate = Date.now();
      botState.signalKeysOk = true;
      console.log(`[AUTH] Credentials & Signal Keys saved to ./session (Timestamp: ${new Date().toLocaleTimeString('id-ID')})`);
    } catch (e) {
      console.error("[AUTH] Gagal menyimpan credentials:", e.message);
      botState.signalKeysOk = false;
    }
  });

  // Monitor status online/mengetik dari customer
  sock.ev.on('presence.update', async (update) => {
    const { id, presences } = update;
    if (presences) {
      const keys = Object.keys(presences);
      if (keys.length > 0) {
        const presenceData = presences[keys[0]];
        const presenceStatus = presenceData?.lastKnownPresence;
        import('./websocket.js').then((ws) => {
          ws.broadcastToAdmins('customer_presence_updated', {
            customerJid: id,
            status: presenceStatus === 'available' ? 'online' : (presenceStatus === 'composing' ? 'typing' : 'offline'),
            lastSeen: Date.now()
          });
        }).catch(err => {});
      }
    }
  });

  // Monitor centang/status pesan terkirim (delivered/read)
  sock.ev.on('messages.update', async (updates) => {
    for (const u of updates) {
      if (u.update.status) {
        const statusMap = {
          2: 'delivered',
          3: 'read',
          4: 'read'
        };
        const newStatus = statusMap[u.update.status];
        if (newStatus) {
          await db.updateMessageStatus(u.key.id, newStatus);
          import('./websocket.js').then((ws) => {
            ws.broadcastToAdmins('message_status_updated', {
              realId: u.key.id,
              customerJid: jidNormalizedUser(u.key.remoteJid),
              status: newStatus
            });
          }).catch(err => {});
        }
      }
    }
  });

  // Monitor event anggota bergabung/keluar grup (Auto-Welcome & Goodbye)
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    try {
      const gSettings = await db.getGroupSettings(id);
      
      if (action === 'add' && gSettings.welcome_enabled) {
        const welcomeText = gSettings.welcome_msg || botSettings.welcomeMessage || "👋 Selamat datang di grup!";
        for (const p of participants) {
          const msg = `${welcomeText}\n\nSelamat bergabung @${p.split('@')[0]}! 🙏`;
          await sock.sendMessage(id, { text: msg, mentions: [p] });
          await db.addLog("GROUP", `Member baru @${p.split('@')[0]} bergabung ke grup ${id}`);
        }
      }

      if (action === 'remove' && gSettings.goodbye_enabled) {
        const goodbyeText = gSettings.goodbye_msg || botSettings.goodbyeMessage || "👋 Sampai jumpa!";
        for (const p of participants) {
          const msg = `${goodbyeText} @${p.split('@')[0]}`;
          await sock.sendMessage(id, { text: msg, mentions: [p] });
          await db.addLog("GROUP", `Member @${p.split('@')[0]} keluar dari grup ${id}`);
        }
      }
    } catch (err) {
      console.error(`[GROUP_PARTICIPANTS] Error:`, err.message);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (type !== 'notify') return;

      for (const m of messages) {
        if (!m.message) continue;

        const jid = m.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        const sender = m.key.participant || jid;
        const senderNormalized = jidNormalizedUser(sender);
        const isFromMe = m.key.fromMe;

        if (isFromMe) continue;

        const mainBuyerGroupJid = botSettings.buyerGroupId || "";

        const msgText = (
          m.message.conversation || 
          m.message.extendedTextMessage?.text || 
          m.message.imageMessage?.caption || 
          ""
        ).trim();

        // Deteksi admin menggunakan 2 metode:
        // 1. Di GRUP: gunakan groupMetadata (anti-LID) — cek apakah pengirim adalah admin/superadmin grup
        // 2. Di DM / Fallback: cocokkan angka nomor dari database (fuzzy match tanpa suffix @s.whatsapp.net/@lid)
        let isAdmin = false;
        
        if (isGroup) {
          try {
            const groupMeta = await sock.groupMetadata(jid);
            isAdmin = groupMeta.participants.some(
              p => (p.id === sender || p.id === senderNormalized) && 
                   (p.admin === 'admin' || p.admin === 'superadmin')
            );
          } catch (e) {
            console.error(`[ADMIN_CHECK] Gagal mengambil metadata grup ${jid}:`, e.message);
          }
        }
        
        // Fallback / DM: cocokkan angka nomor telepon dari database settings
        if (!isAdmin) {
          const adminEntries = (botSettings.adminNumbers || "").split(',').map(n => n.trim());
          // Ekstrak angka saja dari setiap entry admin dan dari senderNormalized
          const extractDigits = (s) => s.replace(/[^0-9]/g, '');
          const senderDigits = extractDigits(senderNormalized);
          isAdmin = adminEntries.some(entry => {
            const adminDigits = extractDigits(entry);
            return adminDigits.length > 6 && senderDigits.includes(adminDigits);
          });
        }

        console.log(`[DEBUG_MSG] Grup: ${isGroup} (${jid}), Pengirim: ${senderNormalized}, Text: "${msgText}", Admin: ${isAdmin}`);

        // Cek Anti-Spam & Anti-Link (Khusus pesan grup dari non-admin)
        if (isGroup && !isAdmin) {
          const isHandled = await handleAntiSpamAndAntiLink(m, jid, senderNormalized, isGroup, msgText);
          if (isHandled) continue;
        }

        // Ambil status percakapan (Take Over check)
        const conv = await db.getOrCreateConversation(senderNormalized);
        const isTakenOver = conv.conversation_state === 'ADMIN';

        if (!isGroup) {
          // Download media jika ada
          let mediaPath = '';
          if (m.message.imageMessage || m.message.videoMessage || m.message.documentMessage || m.message.audioMessage) {
            try {
              const buffer = await downloadMediaMessage(m, 'buffer', {});
              const mimeType = m.message.imageMessage?.mimetype || m.message.videoMessage?.mimetype || m.message.documentMessage?.mimetype || m.message.audioMessage?.mimetype || '';
              const ext = mimeType.split('/').pop().split(';')[0];
              const filename = `chat_recv_${Date.now()}_${Math.floor(1000 + Math.random()*9000)}.${ext === 'vnd.android.package-archive' ? 'apk' : ext}`;
              mediaPath = `./public/uploads/chat_media/${filename}`;
              fs.writeFileSync(mediaPath, buffer);
            } catch (err) {
              console.error("Gagal mendownload media pesan masuk:", err.message);
            }
          }

          const messageType = m.message.imageMessage ? 'image' : 
                              (m.message.videoMessage ? 'video' : 
                              (m.message.audioMessage ? 'audio' : 
                              (m.message.documentMessage ? 'file' : 'text')));

          const messageContent = m.message.conversation || 
                                 m.message.extendedTextMessage?.text || 
                                 m.message.imageMessage?.caption || 
                                 m.message.videoMessage?.caption || 
                                 m.message.documentMessage?.caption || 
                                 '';

          import('./chatManager.js').then(async (chat) => {
            await chat.saveIncomingMessage({
              id: m.key.id,
              customerJid: senderNormalized,
              messageType,
              message: messageContent,
              mediaPath,
              quotedId: m.message.extendedTextMessage?.contextInfo?.stanzaId || '',
              timestamp: (m.messageTimestamp * 1000) || Date.now()
            });
          }).catch(err => console.error("Gagal menyimpan pesan masuk ke DB:", err));

          // Jika pesan dimulai dengan '/' dan pengirim adalah Admin, proses sebagai perintah admin/owner (buka /getjid untuk semua)
          if (msgText.startsWith('/getjid')) {
            await handleGroupMessage(jid, senderNormalized, m, msgText, isAdmin);
          } else if (msgText.startsWith('/') && isAdmin) {
            await handleGroupMessage(jid, senderNormalized, m, msgText, isAdmin);
          } else {
            // Jika chat sedang diambil alih admin (Take Over), bot diam
            if (isTakenOver) {
              console.log(`[BOT] Percakapan dengan ${senderNormalized} sedang diambil alih admin. Auto-reply dinonaktifkan.`);
            } else {
              // Menangani Pesan DM Pelanggan
              await handleCustomerMessage(jid, senderNormalized, m, msgText, false);
            }
          }
        } else {
          // Menangani Pesan Grup (Grup Transaksi / Log / Grup Utama Pembeli)
          const isBuyerGroup = !mainBuyerGroupJid || jid === mainBuyerGroupJid;

          if (msgText.startsWith('/')) {
            // Perintah bertanda '/' (seperti /getjid, /kick, /paid, /stock, /add, /group)
            await handleGroupMessage(jid, senderNormalized, m, msgText, isAdmin);
          } else if (isBuyerGroup) {
            // Perintah pelanggan (list, menu, buy, checkout, dll) di grup pembeli (atau fallback jika belum di-set)
            await handleCustomerMessage(jid, senderNormalized, m, msgText, true);
          }
        }
      }
    } catch (err) {
      console.error('Error saat memproses pesan masuk:', err);
    }
  });
}

// ==========================================
// LOGIKA PESAN PELANGGAN (DM & GRUP UTAMA)
// ==========================================
async function handleCustomerMessage(jid, senderNumber, messageObj, text, isFromGroup = false) {
  const textLower = text.toLowerCase();
  const customerName = messageObj.pushName || "Pelanggan";
  await db.getOrCreateCustomer(senderNumber, customerName);

  // Jika pesan dikenali sebagai perintah utama, reset penghitung pesan tidak dikenal
  if (textLower === 'help' || textLower === 'menu' || textLower === 'bantuan' || 
      textLower === 'list' || textLower === 'produk' || 
      textLower === 'cart' || textLower === 'keranjang' || 
      textLower === 'checkout' || textLower === 'bayar' || 
      textLower === 'cancel' || textLower === 'batal' || 
      textLower === 'status' || /^notify\s+/i.test(textLower) || 
      /^(beli|buy)\s+/i.test(textLower) || messageObj.message?.imageMessage) {
    unknownMessageCounter.set(senderNumber, 0);
  }

  // Periksa apakah perintah butuh privasi (transaksi personal)
  const isPrivateCommand = 
    /^(beli|buy)\s+/i.test(textLower) ||
    textLower === 'cart' || 
    textLower === 'keranjang' || 
    textLower === 'checkout' || 
    textLower === 'bayar' || 
    textLower === 'cancel' || 
    textLower === 'batal' || 
    textLower === 'status';

  const responseJid = (isFromGroup && isPrivateCommand) ? senderNumber : jid;

  // Fungsi kirim notifikasi redirect di grup pembeli
  const sendRedirectNotice = async () => {
    if (isFromGroup && isPrivateCommand) {
      const mentionJid = senderNumber.split('@')[0];
      await sock.sendMessage(jid, { 
        text: `⚠️ *Keamanan Transaksi:* Halo @${mentionJid}, demi keamanan informasi belanja & link pembayaran Anda, rincian transaksi telah kami kirimkan langsung ke *Chat Pribadi (DM)* Anda. Silakan periksa pesan masuk dari nomor bot ini.`,
        mentions: [senderNumber]
      });
    }
  };

  // 1. HELP / MENU / BANTUAN
  if (textLower === 'help' || textLower === 'menu' || textLower === 'bantuan') {
    const welcomeMessage = `━━━━━━━━━━━━━━━━━━
🏪 *SELAMAT DATANG DI ${botSettings.storeName || config.defaults.storeName}*
━━━━━━━━━━━━━━━━━━

Halo *${customerName}*, berikut adalah daftar perintah yang bisa Anda gunakan:

📌 *PERINTAH UTAMA:*
• *list* / *produk* : Melihat katalog produk & status stok kami.
• *beli [KODE] [JUMLAH]* : Memasukkan produk ke keranjang.
  _(Contoh: beli NET01 2)_
• *keranjang* / *cart* : Melihat isi keranjang belanja Anda saat ini.
• *checkout* / *bayar* : Melanjutkan ke pembayaran dengan QRIS.
• *status* : Mengecek status transaksi terakhir Anda.
• *batal* / *cancel* : Membatalkan pesanan yang sedang berjalan.
• *notify [KODE]* : Mendaftar notifikasi jika produk sedang habis.
• *bantuan* / *help* : Menampilkan menu petunjuk ini.

💡 _Setelah melakukan checkout, cukup kirim foto BUKTI TRANSFER langsung ke chat ini untuk konfirmasi pembayaran otomatis._
━━━━━━━━━━━━━━━━━━`;
    await sock.sendMessage(responseJid, { text: welcomeMessage });
    return;
  }

  // 2. LIST / PRODUK
  if (textLower === 'list' || textLower === 'produk') {
    const products = await db.getProducts();
    if (products.length === 0) {
      await sock.sendMessage(responseJid, { text: "Saat ini belum ada produk yang terdaftar di sistem." });
      return;
    }

    let msg = `━━━━━━━━━━━━━━━━━━
📦 *DAFTAR PRODUK*
━━━━━━━━━━━━━━━━━━\n\n`;

    const limit = botSettings.lowStockLimit || config.defaults.lowStockLimit;
    for (const p of products) {
      let stockStatus = "";
      if (p.stok === 0) {
        stockStatus = "🔴 *Habis* (Ketik `notify " + p.kode + "` untuk dikabari)";
      } else if (p.stok <= limit) {
        stockStatus = `🟡 *Hampir Habis* (Sisa: ${p.stok})`;
      } else {
        stockStatus = `🟢 *Ready* (Stok: ${p.stok})`;
      }

      msg += `${stockStatus} *${p.nama}*
Kode : \`${p.kode}\`
Harga : Rp${p.harga.toLocaleString('id-ID')}
Deskripsi : ${p.deskripsi || '-'}\n\n`;
    }

    msg += `━━━━━━━━━━━━━━━━━━
Ketik perintah berikut untuk membeli:
*beli [KODE] [JUMLAH]*
_(Contoh: beli NET01 1)_`;

    await sock.sendMessage(responseJid, { text: msg });
    return;
  }

  // 3. BELI [KODE] [JUMLAH]
  const buyRegex = /^(beli|buy)\s+(\w+)(?:\s+(\d+))?$/i;
  if (buyRegex.test(text)) {
    // Validasi Wajib Join Grup sebelum beli
    const groupCheck = await checkIsUserInGroup(senderNumber);
    if (!groupCheck.isMember) {
      const joinMsg = `⚠️ *PERSYARATAN PEMBELIAN: WAJIB JOIN GRUP*
      
Halo Kak! Untuk dapat memesan & membeli produk di toko kami, Anda diwajibkan untuk bergabung terlebih dahulu ke **Grup Pembeli Toko** kami.

📢 *Grup:* ${groupCheck.groupName}
🔗 *Link Undangan Grup:*
${groupCheck.inviteLink || "Silakan minta link undangan grup ke Admin Toko."}

_Silakan klik link di atas untuk bergabung, kemudian ulangi perintah \`${text}\` kembali. Terima kasih!_ 🙏`;

      await sock.sendMessage(responseJid, { text: joinMsg });
      await sendRedirectNotice();
      return;
    }

    const match = text.match(buyRegex);
    const code = match[2].toUpperCase();
    const qty = match[3] ? parseInt(match[3]) : 1;

    if (qty <= 0) {
      await sock.sendMessage(responseJid, { text: "⚠️ Jumlah produk yang dibeli minimal *1*." });
      await sendRedirectNotice();
      return;
    }

    const res = await db.addToCart(senderNumber, code, qty);
    if (!res.success) {
      await sock.sendMessage(responseJid, { text: `❌ ${res.message}` });
      await sendRedirectNotice();
      return;
    }

    const successMsg = `✅ *Berhasil ditambahkan ke keranjang!*
    
*${res.productName}*
Jumlah: ${res.qty} pcs
Subtotal: *Rp${res.subtotal.toLocaleString('id-ID')}*

Ketik *keranjang* atau *cart* untuk melihat detail belanjaan Anda, atau ketik *checkout* untuk langsung melakukan pembayaran.`;

    await sock.sendMessage(responseJid, { text: successMsg });
    await sendRedirectNotice();
    return;
  }

  // 4. KERANJANG / CART
  if (textLower === 'cart' || textLower === 'keranjang') {
    const cart = await db.getCartDetails(senderNumber);
    if (cart.items.length === 0) {
      await sock.sendMessage(responseJid, { text: "🛒 *Keranjang belanja Anda masih kosong.*\nKetik *produk* untuk melihat produk yang tersedia." });
      await sendRedirectNotice();
      return;
    }

    let msg = `━━━━━━━━━━━━━━━━━━
🛒 *KERANJANG BELANJA*
━━━━━━━━━━━━━━━━━━
Order ID: *${cart.order_id}*

`;

    cart.items.forEach((item, idx) => {
      msg += `${idx + 1}. *${item.produk_nama}* (\`${item.produk_kode}\`)
   ${item.qty} x Rp${item.harga.toLocaleString('id-ID')} = *Rp${item.subtotal.toLocaleString('id-ID')}*\n\n`;
    });

    msg += `━━━━━━━━━━━━━━━━━━
*Total Belanja:* *Rp${cart.total.toLocaleString('id-ID')}*
━━━━━━━━━━━━━━━━━━
Ketik *checkout* untuk melanjutkan ke pembayaran, atau *batal* untuk mengosongkan keranjang.`;

    await sock.sendMessage(responseJid, { text: msg });
    await sendRedirectNotice();
    return;
  }

  // 5. CHECKOUT / BAYAR
  if (textLower === 'checkout' || textLower === 'bayar') {
    // Validasi Wajib Join Grup sebelum checkout
    const groupCheck = await checkIsUserInGroup(senderNumber);
    if (!groupCheck.isMember) {
      const joinMsg = `⚠️ *PERSYARATAN PEMBELIAN: WAJIB JOIN GRUP*
      
Halo Kak! Untuk melanjutkan pembayaran & checkout pesanan Anda, Anda diwajibkan untuk bergabung terlebih dahulu ke **Grup Pembeli Toko** kami.

📢 *Grup:* ${groupCheck.groupName}
🔗 *Link Undangan Grup:*
${groupCheck.inviteLink || "Silakan minta link undangan grup ke Admin Toko."}

_Silakan klik link di atas untuk bergabung, kemudian ulangi perintah \`checkout\` kembali. Terima kasih!_ 🙏`;

      await sock.sendMessage(responseJid, { text: joinMsg });
      await sendRedirectNotice();
      return;
    }

    const res = await db.checkoutCart(senderNumber);
    if (!res.success) {
      await sock.sendMessage(responseJid, { text: `❌ ${res.message}` });
      await sendRedirectNotice();
      return;
    }

    const order = res.order;
    const itemsText = order.items.map(item => `- ${item.produk_nama} (x${item.qty})`).join('\n');

    // Coba buat transaksi Midtrans
    let midtransRes = null;
    try {
      midtransRes = await createMidtransTransaction(order);
    } catch (err) {
      console.error("[BOT] Gagal memicu Midtrans, beralih ke manual QRIS:", err.message);
    }

    if (midtransRes && midtransRes.redirect_url) {
      // Jika Midtrans aktif, kirim link pembayaran instan
      const invoiceMsg = `━━━━━━━━━━━━━━━━━━
🧾 *TAGIHAN PEMBAYARAN INSTAN*
━━━━━━━━━━━━━━━━━━
Order ID: *${order.order_id}*
Nama: *${order.customer_nama}*
Status: *WAITING_PAYMENT*

*Rincian Belanja:*
${itemsText}

💸 *TOTAL YANG HARUS DIBAYAR:*
👉 *Rp${order.total.toLocaleString('id-ID')}*

🔗 *LINK PEMBAYARAN INSTAN (MIDTRANS):*
${midtransRes.redirect_url}

_Anda dapat membayar menggunakan QRIS, GoPay, ShopeePay, OVO, Virtual Account Bank (BCA, Mandiri, BNI, BRI), atau gerai ritel (Alfamart/Indomaret) melalui link di atas._

⚠️ _Masa berlaku link pembayaran ini adalah *30 menit*. Setelah membayar, sistem akan memproses pesanan secara otomatis._
━━━━━━━━━━━━━━━━━━`;
      await sock.sendMessage(responseJid, { text: invoiceMsg });
    } else {
      // Fallback ke QRIS manual jika Midtrans Server Key belum diset
      const invoiceMsg = `━━━━━━━━━━━━━━━━━━
🧾 *TAGIHAN PEMBAYARAN MANUAL*
━━━━━━━━━━━━━━━━━━
Order ID: *${order.order_id}*
Nama: *${order.customer_nama}*
Status: *WAITING_PAYMENT*

*Rincian Belanja:*
${itemsText}

💸 *TOTAL YANG HARUS DIBAYAR:*
👉 *Rp${order.total.toLocaleString('id-ID')}*

*CARA PEMBAYARAN:*
1. Scan QRIS yang tertera di gambar atas.
2. Pastikan nominal transfer pas sebesar *Rp${order.total.toLocaleString('id-ID')}*.
3. Setelah transfer berhasil, harap kirimkan foto/screenshot *BUKTI TRANSFER* langsung ke chat ini.
━━━━━━━━━━━━━━━━━━`;
      await sendQris(responseJid, invoiceMsg);
    }

    await logToSystem('ORDER', `🛍️ Customer *${order.customer_nama}* (wa.me/${senderNumber.split('@')[0]}) melakukan checkout untuk Order ID *${order.order_id}* sebesar Rp${order.total.toLocaleString('id-ID')}`);
    await sendRedirectNotice();
    return;
  }

  // 6. CANCEL / BATAL
  if (textLower === 'cancel' || textLower === 'batal') {
    const res = await db.cancelActiveOrder(senderNumber);
    if (!res.success) {
      await sock.sendMessage(responseJid, { text: `⚠️ ${res.message}` });
      await sendRedirectNotice();
      return;
    }

    await sock.sendMessage(responseJid, { text: `✅ *Pesanan Anda (${res.orderId}) berhasil dibatalkan.*\nKeranjang/tagihan telah dikosongkan dan stok dikembalikan.` });
    await logToSystem('ORDER', `❌ Order ID *${res.orderId}* dibatalkan oleh customer.`);
    await sendRedirectNotice();
    return;
  }

  // 7. STATUS
  if (textLower === 'status') {
    const lastOrder = await db.getCustomerLastOrder(senderNumber);
    if (!lastOrder) {
      await sock.sendMessage(responseJid, { text: "Anda belum pernah melakukan pemesanan di toko kami." });
      await sendRedirectNotice();
      return;
    }

    const details = await db.getOrderDetails(lastOrder.order_id);
    let statusTranslate = details.status;
    
    switch (details.status) {
      case 'CART': statusTranslate = '🛒 Keranjang Belanja'; break;
      case 'WAITING_PAYMENT': statusTranslate = '⏳ Menunggu Pembayaran'; break;
      case 'WAITING_CONFIRMATION': statusTranslate = '🔍 Menunggu Verifikasi Admin'; break;
      case 'PAID': statusTranslate = '🟢 Pembayaran Diterima (Sedang Diproses)'; break;
      case 'COMPLETED': statusTranslate = '✅ Selesai'; break;
      case 'CANCELLED': statusTranslate = '❌ Dibatalkan'; break;
    }

    let msg = `━━━━━━━━━━━━━━━━━━
📊 *STATUS PESANAN*
━━━━━━━━━━━━━━━━━━
Order ID: *${details.order_id}*
Tanggal: ${new Date(details.created_at).toLocaleString('id-ID')}
Total: *Rp${details.total.toLocaleString('id-ID')}*
Status: *${statusTranslate}*

*Item yang dipesan:*
`;

    details.items.forEach(item => {
      msg += `- ${item.produk_nama} (x${item.qty})\n`;
    });
    
    msg += `━━━━━━━━━━━━━━━━━━`;
    await sock.sendMessage(responseJid, { text: msg });
    await sendRedirectNotice();
    return;
  }

  // 8. NOTIFY [KODE] (BERLANGGANAN NOTIFIKASI STOK)
  const notifyRegex = /^(notify|notif|hubungi)\s+(\w+)$/i;
  if (notifyRegex.test(text)) {
    const match = text.match(notifyRegex);
    const code = match[2].toUpperCase();
    const p = await db.getProductByKode(code);
    if (!p) {
      await sock.sendMessage(responseJid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
      return;
    }
    if (p.stok > 0) {
      await sock.sendMessage(responseJid, { 
        text: `🟢 Produk *${p.nama}* (\`${code}\`) saat ini sedang tersedia (Stok: ${p.stok} pcs).\nSilakan langsung pesan dengan mengetik:\n*beli ${code} 1*` 
      });
      return;
    }

    // Daftarkan ke subscriptions
    await db.addSubscription(senderNumber, code);
    const confirmMsg = `✅ *Pemberitahuan Stok Aktif!*

Kami akan otomatis mengirimkan pesan WhatsApp ke nomor ini begitu produk *${p.nama}* (\`${code}\`) sudah ready kembali. Terima kasih!`;
    await sock.sendMessage(responseJid, { text: confirmMsg });
    return;
  }

  // 9. MENERIMA FOTO BUKTI TRANSFER (DISIMPAN SECARA BERTIKAT YYYY/MM)
  if (messageObj.message.imageMessage) {
    const lastOrder = await db.getCustomerLastOrder(senderNumber);
    if (lastOrder && lastOrder.status === 'WAITING_PAYMENT') {
      console.log('Bukti pembayaran terdeteksi. Mengunduh media...');
      const buffer = await downloadMediaMessage(messageObj, 'buffer', {});

      // Buat struktur direktori bertingkat YYYY/MM
      const date = new Date(lastOrder.created_at);
      const year = date.getFullYear().toString();
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const dirPath = `./public/receipts/${year}/${month}`;
      
      // Pastikan direktori folder YYYY/MM ada
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      // Simpan bukti transfer secara lokal ke folder receipts/YYYY/MM/[ORDER_ID].jpg
      const filePath = path.join(dirPath, `${lastOrder.order_id}.jpg`);
      fs.writeFileSync(filePath, buffer);
      console.log(`Bukti transfer berhasil disimpan di: ${filePath}`);

      // Ubah status order di DB menjadi WAITING_CONFIRMATION
      await db.updateOrderStatus(lastOrder.order_id, 'WAITING_CONFIRMATION');
      const orderDetails = await db.getOrderDetails(lastOrder.order_id);

      // Konfirmasi ke customer
      const confirmText = `✅ *Bukti transfer Anda telah kami terima!*
      
Pembayaran untuk Order ID *${lastOrder.order_id}* sedang diverifikasi oleh admin. Kami akan memberikan notifikasi otomatis jika status pesanan berubah. Terima kasih!`;
      await sock.sendMessage(jid, { text: confirmText });

      // Kirim info ke Grup Transaksi WhatsApp jika diatur
      if (botSettings.transactionGroupId) {
        const groupMsg = `━━━━━━━━━━━━━━━━━━
📥 *BUKTI PEMBAYARAN BARU*
━━━━━━━━━━━━━━━━━━
Order ID: *${orderDetails.order_id}*
Nama: *${orderDetails.customer_nama}*
No WA: wa.me/${senderNumber.split('@')[0]}
Total Belanja: *Rp${orderDetails.total.toLocaleString('id-ID')}*
Status: *WAITING_CONFIRMATION*

*Item:*
${orderDetails.items.map(item => `- ${item.produk_nama} (\`${item.produk_kode}\`) x${item.qty}`).join('\n')}
━━━━━━━━━━━━━━━━━━
⚙️ *PERINTAH ADMIN (Balas di grup ini):*
• \`/paid ${orderDetails.order_id}\` : Konfirmasi pembayaran
• \`/done ${orderDetails.order_id}\` : Pesanan selesai diproses
• \`/cancel ${orderDetails.order_id}\` : Batalkan pesanan
━━━━━━━━━━━━━━━━━━`;

        await sock.sendMessage(botSettings.transactionGroupId, { 
          image: buffer, 
          caption: groupMsg 
        });
      }
      
      await logToSystem('PAYMENT', `📸 Bukti transfer diterima untuk Order ID *${lastOrder.order_id}* dari customer *${orderDetails.customer_nama}*. Bukti disimpan secara lokal.`);
      return;
    }
  }

  // Jika pesan tidak dikenali dan bukan command (hanya balas di DM agar tidak spam grup, max 1x per 5 pesan)
  if (!isFromGroup && !textLower.startsWith('/') && !buyRegex.test(text) && !notifyRegex.test(text)) {
    const count = (unknownMessageCounter.get(senderNumber) || 0) + 1;
    unknownMessageCounter.set(senderNumber, count);

    if (count % 5 === 1) {
      await sock.sendMessage(jid, { text: "Saya tidak memahami perintah tersebut. Silakan ketik *menu* atau *help* untuk petunjuk penggunaan." });
    }
  }
}

// ==========================================
// LOGIKA PESAN GRUP (ADMIN GROUP / GET JID)
// ==========================================
async function handleGroupMessage(jid, senderNumber, messageObj, text, isAdmin) {
  const isGroup = jid.endsWith('@g.us');
  const m = messageObj;
  const senderNormalized = senderNumber;

  if (text.startsWith('/getjid')) {
    await sock.sendMessage(jid, { 
      text: `ID Chat/Grup ini adalah:\n\`${jid}\`\n\nID Anda adalah:\n\`${senderNumber}\`\n\nSilakan salin ID di atas dan masukkan ke pengaturan Web Dashboard jika ini adalah Grup Transaksi atau Grup Log.` 
    });
    return;
  }

  if (text.startsWith('/')) {
    if (!isAdmin) {
      await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Admin Toko atau Admin Grup." });
      return;
    }

    const isOwner = senderNumber === botSettings.ownerNumber;
    const args = text.split(' ');
    const cmd = args[0].toLowerCase();

    // ==========================================
    // PERINTAH KHUSUS OWNER
    // ==========================================
    if (cmd === '/owner') {
      await sock.sendMessage(jid, { text: `👑 *PEMILIK BOT:*\nPemilik bot utama adalah wa.me/${(botSettings.ownerNumber || '').split('@')[0]}` });
      return;
    }

    if (cmd === '/stats') {
      if (!isOwner) {
        await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Pemilik (Owner) bot." });
        return;
      }
      const stats = await db.getStats();
      const statsText = `📊 *STATISTIK TOKO DIGITAL*
      
• Total Jenis Produk: *${stats.products}*
• Total Pelanggan: *${stats.customers}*
• Total Pesanan Selesai: *${stats.completedOrders}*
• Total Omset Penjualan: *Rp${stats.totalRevenue.toLocaleString('id-ID')}*`;
      await sock.sendMessage(jid, { text: statsText });
      return;
    }

    if (cmd === '/broadcast') {
      if (!isOwner) {
        await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Pemilik (Owner) bot." });
        return;
      }
      const broadcastMsg = args.slice(1).join(' ');
      if (!broadcastMsg) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `/broadcast [PESAN]`" });
        return;
      }
      
      const delayVal = botSettings.broadcastDelay || config.defaults.broadcastDelay;
      const customers = await db.getAllCustomers();
      await sock.sendMessage(jid, { text: `📢 Memulai broadcast ke *${customers.length}* pelanggan dengan jeda acak...` });
      
      let success = 0;
      for (const c of customers) {
        if (botState.whatsappConnected && sock) {
          try {
            await sock.sendMessage(c.nomor, { text: `📢 *PENGUMUMAN TOKO:*\n\n${broadcastMsg}` });
            success++;
            
            // Hitung delay acak
            const randomDelay = Math.floor(Math.random() * 4001) + delayVal;
            await new Promise(resolve => setTimeout(resolve, randomDelay)); 
          } catch (err) {
            console.error(`Gagal kirim broadcast ke ${c.nomor}:`, err.message);
          }
        } else {
          break;
        }
      }
      await sock.sendMessage(jid, { text: `✅ *Broadcast selesai!*\nBerhasil dikirim ke *${success}/${customers.length}* pelanggan.` });
      await logToSystem('BROADCAST', `📢 Siaran pesan selesai dikirim ke ${success}/${customers.length} pelanggan oleh Owner.`);
      return;
    }

    // ==========================================
    // PERINTAH MODERASI GRUP & BOT MANAGEMENT (v2)
    // ==========================================
    if (isGroup && (cmd === '/add' || cmd === '/kick' || cmd === '/promote' || cmd === '/demote')) {
      const targetJid = extractTargetJid(m, args);
      if (!targetJid) {
        await sock.sendMessage(jid, { text: `⚠️ Format salah. Tag user atau masukkan nomor. Contoh: \`${cmd} @user\` atau \`${cmd} 628123456789\`` });
        return;
      }

      try {
        const actionMap = { '/add': 'add', '/kick': 'remove', '/promote': 'promote', '/demote': 'demote' };
        const actNameMap = { '/add': 'ditambahkan', '/kick': 'dikeluarkan', '/promote': 'diangkat jadi admin', '/demote': 'diturunkan dari admin' };
        
        await sock.groupParticipantsUpdate(jid, [targetJid], actionMap[cmd]);
        await sock.sendMessage(jid, { text: `✅ Berhasil! Pengguna @${targetJid.split('@')[0]} telah ${actNameMap[cmd]}.`, mentions: [targetJid] });
        await db.addLog("MODERATION", `Admin (${senderNormalized}) menjalankan ${cmd} pada ${targetJid} di grup ${jid}`);
      } catch (err) {
        await sock.sendMessage(jid, { 
          text: `❌ Gagal menjalankan ${cmd}: ${err.message}.\n\n💡 *PENTING:* Pastikan **nomor WhatsApp Bot sudah dijadikan ADMIN GRUP** di WhatsApp agar fitur moderasi (${cmd}, /add, /promote, /demote) dapat mengeksekusi tindakan.` 
        });
      }
      return;
    }

    if (isGroup && cmd === '/group') {
      const option = args[1]?.toLowerCase();
      if (option !== 'open' && option !== 'close') {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `/group open` (semua anggota) atau `/group close` (hanya admin)." });
        return;
      }

      try {
        await sock.groupSettingUpdate(jid, option === 'open' ? 'not_announcement' : 'announcement');
        await sock.sendMessage(jid, { text: option === 'open' ? "🔓 Grup telah DIBUKA! Semua anggota sekarang dapat mengirim pesan." : "🔒 Grup telah DITUTUP! Hanya Admin yang dapat mengirim pesan." });
        await db.addLog("MODERATION", `Admin (${senderNormalized}) mengubah status grup ${jid} ke ${option}`);
      } catch (err) {
        await sock.sendMessage(jid, { text: `❌ Gagal mengubah status grup: ${err.message}. Pastikan bot adalah Admin di grup.` });
      }
      return;
    }

    if (isGroup && cmd === '/link') {
      try {
        const code = await sock.groupInviteCode(jid);
        await sock.sendMessage(jid, { text: `🔗 *LINK UNDANGAN GRUP*\nhttps://chat.whatsapp.com/${code}` });
      } catch (err) {
        await sock.sendMessage(jid, { text: `❌ Gagal mengambil link grup: ${err.message}. Pastikan bot adalah Admin.` });
      }
      return;
    }

    if (isGroup && (cmd === '/tagall' || cmd === '/hidetag')) {
      try {
        const groupMeta = await sock.groupMetadata(jid);
        const participants = groupMeta.participants.map(p => p.id);
        const extraMsg = args.slice(1).join(' ');
        
        let tagMsg = `📢 *PENGUMUMAN GRUP*\n${extraMsg ? extraMsg + '\n\n' : ''}`;
        participants.forEach((pId, idx) => {
          tagMsg += `${idx + 1}. @${pId.split('@')[0]}\n`;
        });

        await sock.sendMessage(jid, { text: tagMsg, mentions: participants });
      } catch (err) {
        await sock.sendMessage(jid, { text: `❌ Gagal tagall: ${err.message}` });
      }
      return;
    }

    if (isGroup && cmd === '/admins') {
      try {
        const groupMeta = await sock.groupMetadata(jid);
        const admins = groupMeta.participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin').map(p => p.id);
        const extraMsg = args.slice(1).join(' ');
        
        let adminMsg = `👑 *PANGGILAN ADMIN GRUP*\n${extraMsg ? extraMsg + '\n\n' : ''}`;
        admins.forEach((aId, idx) => {
          adminMsg += `${idx + 1}. @${aId.split('@')[0]}\n`;
        });

        await sock.sendMessage(jid, { text: adminMsg, mentions: admins });
      } catch (err) {
        await sock.sendMessage(jid, { text: `❌ Gagal panggil admin: ${err.message}` });
      }
      return;
    }

    if (cmd === '/restock') {
      const code = args[1]?.toUpperCase();
      if (!code) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `/restock [KODE_PRODUK]`\nContoh: `/restock NET01`" });
        return;
      }

      const p = await db.getProductByKode(code);
      if (!p) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
        return;
      }

      await sock.sendMessage(jid, { text: `⏳ Memulai pengiriman siaran restok untuk *${p.nama}* (\`${code}\`)...` });
      triggerRestockBroadcast(code);
      return;
    }

    // ==========================================
    // PERINTAH ADMIN & TRANSAKSI
    // ==========================================
    if (cmd === '/paid') {
      const orderId = args[1]?.toUpperCase();
      if (!orderId) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `/paid ORD-YYYYMMDD-XXXX`" });
        return;
      }

      const res = await db.updateOrderStatus(orderId, 'PAID');
      if (!res.success) {
        await sock.sendMessage(jid, { text: `❌ Gagal: ${res.message}` });
        return;
      }

      await sock.sendMessage(jid, { text: `✅ Order ID *${orderId}* berhasil diubah ke status *PAID*. Memproses pengiriman otomatis...` });
      
      // Notifikasi awal ke customer
      const notifCustomer = `🔔 *INFO PESANAN (Order: ${orderId})*
      
Pembayaran Anda telah *DITERIMA* dan diverifikasi oleh admin kami. Terima kasih!`;
      await sock.sendMessage(res.customerNomor, { text: notifCustomer });
      await logToSystem('PAYMENT', `💸 Order ID *${orderId}* dikonfirmasi PAID oleh admin (wa.me/${senderNumber.split('@')[0]})`);

      // AUTO-DELIVERY: Kirim kredensial digital secara otomatis
      try {
        const deliveredData = await db.claimAndDeliverItems(orderId);
        const deliveredKeys = Object.keys(deliveredData);

        if (deliveredKeys.length > 0) {
          let credMsg = `━━━━━━━━━━━━━━━━━━
📦 *PENGIRIMAN PRODUK DIGITAL*
━━━━━━━━━━━━━━━━━━
Order ID: *${orderId}*

Berikut adalah detail akun/voucher Anda:\n\n`;

          for (const [kode, info] of Object.entries(deliveredData)) {
            credMsg += `🔑 *${info.produk_nama}* (\`${kode}\`):\n`;
            if (info.credentials.length > 0) {
              info.credentials.forEach((cred, i) => {
                credMsg += `   ${i + 1}. ${cred}\n`;
              });
            } else {
              credMsg += `   ⚠️ Stok kredensial habis, admin akan mengirimkan secara manual.\n`;
            }
            credMsg += `\n`;
          }

          credMsg += `━━━━━━━━━━━━━━━━━━
⚠️ _Harap simpan data ini dengan baik. Jika ada masalah, silakan hubungi admin._
━━━━━━━━━━━━━━━━━━`;
          await sock.sendMessage(res.customerNomor, { text: credMsg });

          // Otomatis tandai COMPLETED jika semua item berhasil dikirim
          const allDelivered = deliveredKeys.every(k => deliveredData[k].credentials.length > 0);
          if (allDelivered) {
            await db.updateOrderStatus(orderId, 'COMPLETED');
            await sock.sendMessage(res.customerNomor, { text: `✅ Pesanan *${orderId}* telah *SELESAI*. Terima kasih telah berbelanja! 🙏` });
            await sock.sendMessage(jid, { text: `✅ Order *${orderId}* otomatis ditandai *COMPLETED* — semua kredensial digital berhasil dikirim ke pelanggan.` });
            await logToSystem('ORDER', `✅ Order *${orderId}* auto-completed setelah pengiriman kredensial digital.`);
          } else {
            await sock.sendMessage(jid, { text: `⚠️ Order *${orderId}*: Sebagian kredensial digital berhasil dikirim, tetapi ada item yang stok kredensialnya habis. Silakan kirim secara manual.` });
          }
        } else {
          // Tidak ada item AUTO, semua MANUAL — beri tahu admin
          await sock.sendMessage(jid, { text: `ℹ️ Order *${orderId}* tidak memiliki item bertipe AUTO. Silakan kirimkan produk secara manual ke pelanggan, lalu ketik \`/done ${orderId}\` setelah selesai.` });
        }
      } catch (deliveryErr) {
        console.error(`[AUTO_DELIVERY] Gagal mengirim kredensial untuk ${orderId}:`, deliveryErr.message);
        await sock.sendMessage(jid, { text: `⚠️ Terjadi error saat auto-delivery untuk Order *${orderId}*: ${deliveryErr.message}. Silakan kirim kredensial secara manual.` });
      }
      return;
    }

    if (cmd === '/done') {
      const orderId = args[1]?.toUpperCase();
      if (!orderId) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `/done ORD-YYYYMMDD-XXXX`" });
        return;
      }

      const res = await db.updateOrderStatus(orderId, 'COMPLETED');
      if (!res.success) {
        await sock.sendMessage(jid, { text: `❌ Gagal: ${res.message}` });
        return;
      }

      await sock.sendMessage(jid, { text: `✅ Order ID *${orderId}* ditandai *COMPLETED*. Pelanggan telah dinotifikasi.` });

      const notifCustomer = `🔔 *INFO PESANAN (Order: ${orderId})*
      
Pesanan Anda telah *SELESAI* diproses / dikirimkan oleh admin!
Silakan cek akun/detail pesanan Anda. Jika ada kendala, hubungi admin. Terima kasih telah berbelanja! 🙏`;
      await sock.sendMessage(res.customerNomor, { text: notifCustomer });
      await logToSystem('ORDER', `✅ Order ID *${orderId}* ditandai COMPLETED oleh admin.`);
      return;
    }

    if (cmd === '/cancel') {
      const orderId = args[1]?.toUpperCase();
      if (!orderId) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `/cancel ORD-YYYYMMDD-XXXX`" });
        return;
      }

      const res = await db.updateOrderStatus(orderId, 'CANCELLED');
      if (!res.success) {
        await sock.sendMessage(jid, { text: `❌ Gagal: ${res.message}` });
        return;
      }

      await sock.sendMessage(jid, { text: `✅ Order ID *${orderId}* berhasil dibatalkan dan stok produk telah dikembalikan.` });

      const notifCustomer = `🔔 *INFO PESANAN (Order: ${orderId})*
      
Mohon maaf, pesanan Anda dengan Order ID *${orderId}* telah *DIBATALKAN* oleh admin. Jika Anda sudah melakukan pembayaran, silakan hubungi admin di chat ini untuk konfirmasi manual.`;
      await sock.sendMessage(res.customerNomor, { text: notifCustomer });
      await logToSystem('ORDER', `❌ Order ID *${orderId}* dibatalkan oleh admin.`);
      return;
    }

    if (cmd === '/stock') {
      const code = args[1]?.toUpperCase();
      const stock = parseInt(args[2]);

      if (!code || isNaN(stock)) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `/stock [KODE] [STOK_BARU]`\nContoh: `/stock NET01 15`" });
        return;
      }

      const p = await db.getProductByKode(code);
      if (!p) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
        return;
      }

      await db.updateProductStock(code, stock);
      await sock.sendMessage(jid, { text: `📦 Stok *${p.nama}* (\`${code}\`) berhasil diperbarui menjadi *${stock}* pcs.` });
      await logToSystem('SYSTEM', `📦 Stok produk *${code}* diperbarui menjadi *${stock}* oleh admin.`);
      
      // Picu notifikasi stok ready jika stok baru > 0
      await checkAndNotifySubscribers(code, stock);
      return;
    }

    if (cmd === '/price') {
      const code = args[1]?.toUpperCase();
      const price = parseInt(args[2]);

      if (!code || isNaN(price)) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `/price [KODE] [HARGA_BARU]`\nContoh: `/price NET01 50000`" });
        return;
      }

      const p = await db.getProductByKode(code);
      if (!p) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
        return;
      }

      await db.updateProductPrice(code, price);
      await sock.sendMessage(jid, { text: `💸 Harga *${p.nama}* (\`${code}\`) berhasil diperbarui menjadi *Rp${price.toLocaleString('id-ID')}*.` });
      await logToSystem('SYSTEM', `💸 Harga produk *${code}* diperbarui menjadi Rp${price} oleh admin.`);
      return;
    }

    if (cmd === '/out') {
      const code = args[1]?.toUpperCase();
      if (!code) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `/out [KODE]`" });
        return;
      }

      const p = await db.getProductByKode(code);
      if (!p) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
        return;
      }

      await db.updateProductStock(code, 0);
      await sock.sendMessage(jid, { text: `🔴 Produk *${p.nama}* (\`${code}\`) ditandai sebagai *Habis* (stok diset ke 0).` });
      await logToSystem('SYSTEM', `🔴 Produk *${code}* diset habis oleh admin.`);
      return;
    }

    if (cmd === '/ready') {
      const code = args[1]?.toUpperCase();
      if (!code) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `/ready [KODE]`" });
        return;
      }

      const p = await db.getProductByKode(code);
      if (!p) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
        return;
      }

      await db.updateProductStock(code, 10);
      await sock.sendMessage(jid, { text: `🟢 Produk *${p.nama}* (\`${code}\`) ditandai *Ready* kembali dengan isi stok standar (10 pcs).` });
      await logToSystem('SYSTEM', `🟢 Produk *${code}* diset ready (stok 10) oleh admin.`);
      
      // Picu notifikasi stok ready jika stok baru > 0
      await checkAndNotifySubscribers(code, 10);
      return;
    }

    if (cmd === '/addproduct') {
      const rawArgs = args.slice(1).join(' ');
      const parts = rawArgs.split('|').map(p => p.trim());
      
      if (parts.length < 5) {
        const errorHelp = `⚠️ Format salah. Gunakan pemisah vertikal (\`|\`):\n\`/addproduct [KODE] | [NAMA_PRODUK] | [HARGA] | [STOK] | [DESKRIPSI]\`\n\n_Contoh:_\n\`/addproduct NET02 | Netflix 2 Bulan | 85000 | 5 | Sharing 1 Profil\``;
        await sock.sendMessage(jid, { text: errorHelp });
        return;
      }

      const codePart = parts[0].split(' ');
      const code = codePart[0].toUpperCase();
      
      const nama = parts[1];
      const harga = parseInt(parts[2]);
      const stok = parseInt(parts[3]);
      const deskripsi = parts[4];

      if (isNaN(harga) || isNaN(stok)) {
        await sock.sendMessage(jid, { text: "❌ Gagal. Harga dan Stok harus berupa angka/nominal." });
        return;
      }

      await db.addProduct(code, nama, harga, stok, deskripsi, "");
      const successText = `🆕 *PRODUK BARU BERHASIL DITAMBAHKAN!*
      
• Kode: \`${code}\`
• Nama: *${nama}*
• Harga: Rp${harga.toLocaleString('id-ID')}
• Stok: ${stok} pcs
• Deskripsi: ${deskripsi}`;
      await sock.sendMessage(jid, { text: successText });
      await logToSystem('SYSTEM', `🆕 Produk baru ditambahkan oleh admin: ${code} - ${nama}`);
      
      // Picu notifikasi jika stok baru > 0
      await checkAndNotifySubscribers(code, stok);
      return;
    }
  }
}

// Fungsi eksternal untuk memicu status online/mengetik di WhatsApp
export async function triggerPresenceUpdate(jid, presence) {
  if (botState.whatsappConnected && sock) {
    try {
      await sock.sendPresenceUpdate(presence, jid);
    } catch (err) {
      console.error(`[BOT] Gagal mengirim presence update ke ${jid}:`, err.message);
    }
  }
}
