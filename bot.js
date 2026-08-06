import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState, 
  downloadMediaMessage,
  jidNormalizedUser,
  fetchLatestBaileysVersion,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  proto
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';

import { config } from './config.js';
import * as db from './database.js';
import { botState, createMidtransTransaction } from './server.js';
import * as mediaHandler from './mediaHandler.js';
import * as ent from './entertainmentHandler.js';
import { backupDatabase } from './scheduler.js';
import { loadPlugins, executePlugin } from './pluginLoader.js';
import { handleFunCommand } from './funHandler.js';
import { buildCommandMenu } from './commandRegistry.js';


// Setup Logger
const logger = P({ level: 'info' });

let sock = null;
let botSettings = {};
const userPushNamesMap = new Map();

// Helper universal memformat tampilan JID/nomor WA (+62 vs Nama)
export function formatPhoneNumber(jid) {
  if (!jid) return '-';
  const clean = jid.trim();

  // Check if pushName cached in memory
  if (userPushNamesMap.has(clean)) {
    return userPushNamesMap.get(clean);
  }

  const rawNumber = clean.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  
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
  
  if (rawNumber.length > 0 && rawNumber.length <= 13) {
    return `+${rawNumber}`;
  }
  
  return 'Member WhatsApp';
}

/**
 * Helper terpusat untuk ekstraksi teks & tombol interaktif dari pesan WA
 */
export function extractMessageText(m) {
  if (!m || !m.message) return '';
  const msg = m.message;

  // 1. Pesan teks langsung / caption media
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage?.caption) return msg.imageMessage.caption;
  if (msg.videoMessage?.caption) return msg.videoMessage.caption;
  if (msg.documentMessage?.caption) return msg.documentMessage.caption;

  // 2. Respons Tombol Standar / Quick Reply
  if (msg.buttonsResponseMessage?.selectedButtonId) {
    return msg.buttonsResponseMessage.selectedButtonId;
  }
  if (msg.buttonsResponseMessage?.selectedDisplayText) {
    return msg.buttonsResponseMessage.selectedDisplayText;
  }
  if (msg.templateButtonReplyMessage?.selectedId) {
    return msg.templateButtonReplyMessage.selectedId;
  }

  // 3. Respons Dropdown List (Single Select)
  if (msg.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return msg.listResponseMessage.singleSelectReply.selectedRowId;
  }

  // 4. Respons Native Flow Interactive Message (Proto WhatsApp Terbaru)
  if (msg.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
    try {
      const params = JSON.parse(msg.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
      return params.id || params.row_id || params.text || params.copy_code || '';
    } catch (e) {}
  }

  return '';
}

/**
 * Helper terpusat untuk mengirim pesan interaktif dengan tombol (Native Flow / Quick Reply / List)
 */
export async function sendInteractiveButtons(targetSock, jid, { text, title, footer, buttons = [], sections = [] }) {
  const activeSock = targetSock || sock;
  if (!activeSock) return false;

  try {
    const nativeButtons = [];

    // 1. Tambahkan Section List/Dropdown jika ada
    if (sections && sections.length > 0) {
      nativeButtons.push({
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: '📋 Pilih Menu',
          sections: sections
        })
      });
    }

    // 2. Tambahkan tombol individual (Quick Reply, CTA URL, CTA Copy)
    if (buttons && buttons.length > 0) {
      for (const b of buttons) {
        if (b.type === 'url') {
          nativeButtons.push({
            name: 'cta_url',
            buttonParamsJson: JSON.stringify({
              display_text: b.text,
              url: b.url,
              merchant_url: b.url
            })
          });
        } else if (b.type === 'copy') {
          nativeButtons.push({
            name: 'cta_copy',
            buttonParamsJson: JSON.stringify({
              display_text: b.text,
              id: b.id || b.text,
              copy_code: b.copy_code || b.text
            })
          });
        } else {
          nativeButtons.push({
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({
              display_text: b.text,
              id: b.id || b.text
            })
          });
        }
      }
    }

    const interactiveMsg = {
      header: title ? { title, hasMediaAttachment: false } : undefined,
      body: { text: text || '' },
      footer: footer ? { text: footer } : undefined,
      nativeFlowMessage: {
        buttons: nativeButtons
      }
    };

    const waMsg = generateWAMessageFromContent(
      jid,
      {
        viewOnceMessage: {
          message: {
            interactiveMessage: interactiveMsg
          }
        }
      },
      { userJid: jid }
    );

    await activeSock.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id });
    return true;
  } catch (err) {
    console.error('[INTERACTIVE MSG ERROR] Gagal mengirim pesan tombol, menggunakan fallback teks:', err.message);
    let fallbackText = text;
    if (footer) fallbackText += `\n\n_${footer}_`;
    await activeSock.sendMessage(jid, { text: fallbackText });
    return false;
  }
}

// Helper untuk mengirim broadcast tag-all ke grup
export async function broadcastTagAll(sock, groupId, messageText) {
  if (!sock || !groupId) return false;
  try {
    const groupMeta = await sock.groupMetadata(groupId);
    const participants = groupMeta.participants.map(p => p.id);
    await sock.sendMessage(groupId, {
      text: messageText,
      mentions: participants
    });
    return true;
  } catch (err) {
    console.error(`[BROADCAST ERROR] Gagal mengirim tag-all ke grup ${groupId}:`, err.message);
    return false;
  }
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

async function handleAntiSpamAndAntiLink(m, jid, senderNormalized, isGroup, msgText, isAdmin) {
  if (!isGroup) return false;

  const antiSpamOn = (botSettings.antiSpamEnabled || "true") === "true";
  const antiLinkOn = (botSettings.antiLinkEnabled || "true") === "true";
  const maxSpamMsgs = parseInt(botSettings.spamThreshold) || 5;
  const spamWindowMs = parseInt(botSettings.spamWindow) || 5000;
  const kickAfter = parseInt(botSettings.kickAfterWarnings) || 3;
  const blockedDomains = (botSettings.blockedDomains || "chat.whatsapp.com,bit.ly,tinyurl,t.me,discord.gg").split(',').map(d => d.trim().toLowerCase());
  const allowedDomains = (botSettings.allowedDomains || "tokopedia.com,shopee.co.id,bukalapak.com").split(',').map(d => d.trim().toLowerCase());

  // 1. Anti-Link Scan (Admin kebal anti-link)
  if (antiLinkOn && msgText && !isAdmin) {
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

  // 2. Anti-Spam Rate Limiter (Admin tetap dapat peringatan, tapi tidak di-kick)
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
        if (isAdmin) {
          await sock.sendMessage(jid, { text: `⚠️ *PERINGATAN SPAM ADMIN*\n@${senderNormalized.split('@')[0]}, harap jangan melakukan spam pesan di grup! (Admin tidak di-kick)`, mentions: [senderNormalized] });
        } else {
          await sock.sendMessage(jid, { text: `🚨 @${senderNormalized.split('@')[0]} telah di-KICK dari grup karena melakukan SPAM berturut-turut (${warnings}x peringatan).`, mentions: [senderNormalized] });
          try {
            await sock.groupParticipantsUpdate(jid, [senderNormalized], "remove");
          } catch (e) {
            console.error(`[ANTI_SPAM] Gagal kick ${senderNormalized}:`, e.message);
          }
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

    // 1. Ambil pelanggan yang daftar pengingat stok perorang (notify [KODE])
    const subscribers = await db.getSubscribers(productCode);
    const subscriberJids = Array.from(new Set(subscribers.map(s => s.customer_nomor)));

    const historyId = await db.createBroadcastHistory(productCode, subscriberJids.length);

    console.log(`[RESTOCK_QUEUE] Memulai pengiriman siaran restok ${productCode}... (${subscriberJids.length} peminta notifikasi perorang)`);
    await db.addLog("BROADCAST", `Memulai siaran restok ${productCode} ke ${subscriberJids.length} peminta notifikasi perorang & grup.`);

    (async () => {
      let success = 0;
      let failed = 0;
      const delayMs = parseInt(botSettings.broadcastDelay) || 3000;

      // Kirim DM HANYA ke peminta notifikasi perorang (notify [KODE])
      for (const jid of subscriberJids) {
        try {
          const msg = `🔔 *PENGINGAT STOK PRODUK!* 📦\n\n` +
            `Halo Kak! Produk *${product.nama}* (\`${product.kode}\`) yang pernah Anda minta ingatkan saat ini *SUDAH READY / RESTOK*!\n\n` +
            `• Stok Tersedia: *${product.stok} pcs*\n` +
            `• Harga: *Rp${product.harga.toLocaleString('id-ID')}*\n` +
            (product.deskripsi ? `• Deskripsi: ${product.deskripsi}\n\n` : `\n`) +
            `Silakan ketik:\n` +
            `*beli ${product.kode} 1*\n` +
            `di chat ini untuk memesan sekarang sebelum kehabisan! Terima kasih. 🙏`;

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

      // Bersihkan antrean berlangganan untuk produk ini
      await db.getAndClearSubscribers(productCode);
      await db.updateBroadcastHistory(historyId, success, failed);
      await db.addLog("BROADCAST", `🏁 Siaran restok perorang ${productCode} selesai: ${success} terkirim, ${failed} gagal.`);

      // 2. Siarkan Pengumuman Restok ke GRUP WHATSAPP
      if (sock && botState.whatsappConnected) {
        const groupMsg = `📢 *PENGUMUMAN RESTOK PRODUK DI GRUP* 📦\n\n` +
          `Kabar gembira! Produk *${product.nama}* (\`${product.kode}\`) telah di-restok!\n\n` +
          `• Stok Tersedia: *${product.stok} pcs*\n` +
          `• Harga: *Rp${product.harga.toLocaleString('id-ID')}*\n` +
          (product.deskripsi ? `• Deskripsi: ${product.deskripsi}\n\n` : `\n`) +
          `Silakan chat Bot & ketik *beli ${product.kode} 1* untuk memesan sekarang! 🛒`;

        const targetGroupId = botSettings.buyerGroupId || botSettings.transactionGroupId;
        if (targetGroupId) {
          try {
            await sock.sendMessage(targetGroupId, { text: groupMsg });
            console.log(`[RESTOCK_BROADCAST] Pengumuman restok terkirim ke grup ${targetGroupId}`);
          } catch (err) {
            console.error(`[RESTOCK_BROADCAST] Gagal kirim ke grup ${targetGroupId}:`, err.message);
          }
        } else {
          try {
            const groups = await sock.groupFetchAllParticipating();
            for (const gId of Object.keys(groups)) {
              await sock.sendMessage(gId, { text: groupMsg });
            }
          } catch (err) {
            console.error(`[RESTOCK_BROADCAST] Gagal kirim ke grup:`, err.message);
          }
        }
      }
    })();

    return { 
      success: true, 
      count: subscriberJids.length, 
      message: `Siaran restok ${productCode} berhasil diproses untuk ${subscriberJids.length} peminta perorang & disiarkan di grup.` 
    };
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

// Fungsi Helper untuk mengirim log sistem (DB & Log Group WhatsApp jika terpisah)
async function logToSystem(type, text) {
  console.log(`[${type}] ${text}`);
  // Catat ke tabel log SQLite (bisa dilihat via Web Dashboard -> Tab Bot Status -> Log Aktivitas Bot)
  await db.addLog(type, text);

  // Kirim ke WhatsApp Log Group HANYA jika logGroupId diisi & merupakan grup terpisah dari grup transaksi/pembeli
  if (sock && botState.whatsappConnected && botSettings.logGroupId) {
    const isDedicatedLogGroup = botSettings.logGroupId !== botSettings.transactionGroupId && 
                                botSettings.logGroupId !== botSettings.buyerGroupId;
    if (isDedicatedLogGroup) {
      try {
        await sock.sendMessage(botSettings.logGroupId, { text: `📢 *LOG [${type}]:*\n${text}` });
      } catch (err) {
        console.error('Gagal mengirim log ke WhatsApp Log Group:', err.message);
      }
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
  // Muat plugin modular
  await loadPlugins();

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

  // Dukungan Pairing Code jika dikonfigurasi via ENV
  if (!sock.authState.creds.registered && process.env.PAIRING_NUMBER) {
    const pairingNum = process.env.PAIRING_NUMBER.replace(/[^0-9]/g, '');
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(pairingNum);
        console.log(`\n=========================================`);
        console.log(`🔑 WA PAIRING CODE: ${code}`);
        console.log(`=========================================\n`);
      } catch (err) {
        console.error("Gagal meminta Pairing Code:", err.message);
      }
    }, 4000);
  }

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

  // ==========================================
  // FITUR MEDIA UTILITY (DOWNLOADER & CONVERTER)
  // ==========================================
  async function handleMediaCommands(jid, senderNumber, m, msgText) {
    const textTrim = msgText.trim();
    if (!textTrim) return false;
    const args = textTrim.split(/\s+/);
    const rawCmd = args[0].toLowerCase();
    const cleanCmd = rawCmd.replace(/^[./#]/, '');

    const isGroup = jid.endsWith('@g.us');
    if (isGroup) {
      const gSettings = await db.getGroupSettings(jid);
      if (gSettings.bot_mode === 'sales') {
        const allowedInSalesGroup = ['owner', 'kontakowner', 'invoice', 'struk', 'tagall', 'hidetag', 'everyone'];
        if (!allowedInSalesGroup.includes(cleanCmd)) {
          return false;
        }
      }
    }

    const react = async (emoji) => {
      try {
        await sock.sendMessage(jid, { react: { text: emoji, key: m.key } });
      } catch (e) {}
    };
    
    // 1. TikTok Downloader
    if (['tt', 'tiktok'].includes(cleanCmd)) {
      const url = args[1] || (msgText.match(/https?:\/\/[^\s]+/i)?.[0]);
      if (!url || !url.includes('tiktok.com')) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap sertakan link TikTok yang valid.\n\n_Contoh:_ `.tt https://vt.tiktok.com/xxxx`" });
        return true;
      }
      await react('⏳');
      const res = await mediaHandler.downloadTikTok(url);
      if (res.success && (res.buffer || res.videoUrl)) {
        await sock.sendMessage(jid, { 
          video: res.buffer || { url: res.videoUrl }, 
          caption: `📹 *${res.title || 'TikTok Video'}*${res.author ? `\n👤 Creator: *${res.author}*` : ''}\n\n✅ *Berhasil diunduh via Akbar Store Bot*` 
        });
        await react('✅');
      } else {
        await react('❌');
        await sock.sendMessage(jid, { text: `❌ ${res.message || 'Gagal mengambil video TikTok.'}` });
      }
      return true;
    }

    // 2. Instagram Downloader
    if (['ig', 'instagram'].includes(cleanCmd)) {
      const url = args[1] || (msgText.match(/https?:\/\/[^\s]+/i)?.[0]);
      if (!url || !url.includes('instagram.com')) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap sertakan link Instagram Reels/Post yang valid.\n\n_Contoh:_ `.ig https://www.instagram.com/reel/xxxx`" });
        return true;
      }
      await react('⏳');
      const res = await mediaHandler.downloadInstagram(url);
      if (res.success && (res.buffer || res.videoUrl)) {
        await sock.sendMessage(jid, { 
          video: res.buffer || { url: res.videoUrl }, 
          caption: `📸 *${res.title || 'Instagram Video'}*\n\n✅ *Berhasil diunduh via Akbar Store Bot*` 
        });
        await react('✅');
      } else {
        await react('❌');
        await sock.sendMessage(jid, { text: `❌ ${res.message || 'Gagal mengunduh media Instagram.'}` });
      }
      return true;
    }

    // 3. YouTube / Shorts Downloader
    if (['yt', 'youtube'].includes(cleanCmd)) {
      const url = args[1] || (msgText.match(/https?:\/\/[^\s]+/i)?.[0]);
      if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap sertakan link YouTube/Shorts yang valid.\n\n_Contoh:_ `.yt https://youtube.com/shorts/xxxx`" });
        return true;
      }
      await react('⏳');
      const res = await mediaHandler.downloadYouTube(url);
      if (res.success && (res.buffer || res.videoUrl)) {
        await sock.sendMessage(jid, { 
          video: res.buffer || { url: res.videoUrl }, 
          caption: `🎬 *${res.title || 'YouTube Video'}*\n\n✅ *Berhasil diunduh via Akbar Store Bot*` 
        });
        await react('✅');
      } else {
        await react('❌');
        await sock.sendMessage(jid, { text: `❌ ${res.message || 'Gagal mengunduh video YouTube.'}` });
      }
      return true;
    }

    // 4. Facebook Downloader
    if (['fb', 'facebook'].includes(cleanCmd)) {
      const url = args[1] || (msgText.match(/https?:\/\/[^\s]+/i)?.[0]);
      if (!url || (!url.includes('facebook.com') && !url.includes('fb.watch') && !url.includes('fb.com'))) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap sertakan link Facebook Video/Reels yang valid.\n\n_Contoh:_ `.fb https://fb.watch/xxxx`" });
        return true;
      }
      await react('⏳');
      const res = await mediaHandler.downloadFacebook(url);
      if (res.success && (res.buffer || res.videoUrl)) {
        await sock.sendMessage(jid, { 
          video: res.buffer || { url: res.videoUrl }, 
          caption: `📘 *${res.title || 'Facebook Video'}*\n\n✅ *Berhasil diunduh via Akbar Store Bot*` 
        });
        await react('✅');
      } else {
        await react('❌');
        await sock.sendMessage(jid, { text: `❌ ${res.message || 'Gagal mengunduh video Facebook.'}` });
      }
      return true;
    }

    // 5. Stiker / GIF Converter (.stiker, .sticker, .s, .gif, .sgif)
    if (['stiker', 'sticker', 's', 'gif', 'sgif'].includes(cleanCmd)) {
      const hasImage = m.message?.imageMessage || m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
      const hasVideo = m.message?.videoMessage || m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.videoMessage;
      
      if (!hasImage && !hasVideo) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap kirim foto/video dengan caption `.stiker` atau balas (reply) pesan foto/video dengan `.stiker`!" });
        return true;
      }

      try {
        await react('⏳');
        let targetMessage = m;
        if (m.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
          targetMessage = {
            key: {
              remoteJid: jid,
              id: m.message.extendedTextMessage.contextInfo.stanzaId,
              participant: m.message.extendedTextMessage.contextInfo.participant
            },
            message: m.message.extendedTextMessage.contextInfo.quotedMessage
          };
        }

        const isVideo = !!hasVideo;
        const buffer = await downloadMediaMessage(targetMessage, 'buffer', {});
        const stickerRes = await mediaHandler.createSticker(buffer, 'Akbar Store', 'WhatsApp Bot', isVideo);
        
        if (stickerRes.success && stickerRes.buffer) {
          await sock.sendMessage(jid, { sticker: stickerRes.buffer });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ Gagal membuat stiker: ${stickerRes.message}` });
        }
      } catch (err) {
        await react('❌');
        console.error("[STICKER_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal membuat stiker. Pastikan file media tidak rusak.` });
      }
      return true;
    }

    // 5. Sticker to Image (.toimg, /toimg)
    if (['toimg', 'unstick', 'toimage'].includes(cleanCmd)) {
      const quotedSticker = m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.stickerMessage;
      if (!quotedSticker) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap balas (reply) stiker WhatsApp yang ingin diubah menjadi gambar dengan perintah `.toimg`!" });
        return true;
      }

      try {
        await react('⏳');
        const targetMessage = {
          key: {
            remoteJid: jid,
            id: m.message.extendedTextMessage.contextInfo.stanzaId
          },
          message: m.message.extendedTextMessage.contextInfo.quotedMessage
        };

        const stickerBuffer = await downloadMediaMessage(targetMessage, 'buffer', {});
        const imageRes = await mediaHandler.stickerToImage(stickerBuffer);

        if (imageRes.success && imageRes.buffer) {
          await sock.sendMessage(jid, { image: imageRes.buffer, caption: "✅ *Berhasil diubah dari Stiker ke Gambar (JPG)*" });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ Gagal mengonversi stiker: ${imageRes.message}` });
        }
      } catch (err) {
        await react('❌');
        console.error("[TOIMG_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal mengonversi stiker ke gambar.` });
      }
      return true;
    }

    // 6. Sticker to Video (.tovid, .tovideo, .togif)
    if (['tovid', 'tovideo', 'togif'].includes(cleanCmd)) {
      const quotedSticker = m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.stickerMessage;
      if (!quotedSticker) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap balas (reply) stiker WhatsApp yang ingin diubah menjadi video MP4 dengan perintah `.tovid`!" });
        return true;
      }

      try {
        await react('⏳');
        const targetMessage = {
          key: {
            remoteJid: jid,
            id: m.message.extendedTextMessage.contextInfo.stanzaId
          },
          message: m.message.extendedTextMessage.contextInfo.quotedMessage
        };

        const stickerBuffer = await downloadMediaMessage(targetMessage, 'buffer', {});
        const videoRes = await mediaHandler.stickerToVideo(stickerBuffer);

        if (videoRes.success && videoRes.buffer) {
          await sock.sendMessage(jid, { video: videoRes.buffer, caption: "✅ *Berhasil diubah dari Stiker ke Video (MP4)*" });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ Gagal mengonversi stiker ke video: ${videoRes.message}` });
        }
      } catch (err) {
        await react('❌');
        console.error("[TOVID_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal mengonversi stiker ke video.` });
      }
      return true;
    }

    // 7. Quote Sticker Generator (.qc, .quote, /qc)
    if (['qc', 'quote'].includes(cleanCmd)) {
      const isQuoted = !!m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      let textToQuote = '';
      let senderName = '';

      if (isQuoted) {
        const contextInfo = m.message.extendedTextMessage.contextInfo;
        const quotedMsg = contextInfo.quotedMessage;
        textToQuote = quotedMsg.conversation || 
                      quotedMsg.extendedTextMessage?.text || 
                      quotedMsg.imageMessage?.caption || 
                      quotedMsg.videoMessage?.caption || 
                      args.slice(1).join(' ');

        const quotedParticipant = contextInfo.participant || contextInfo.remoteJid;
        const normalizedParticipant = jidNormalizedUser(quotedParticipant);

        if (userPushNamesMap.has(normalizedParticipant)) {
          senderName = userPushNamesMap.get(normalizedParticipant);
        } else {
          try {
            const customerObj = await db.getCustomer(normalizedParticipant);
            if (customerObj && customerObj.name && customerObj.name !== 'Pelanggan') {
              senderName = customerObj.name;
            } else {
              senderName = formatPhoneNumber(normalizedParticipant);
            }
          } catch (e) {
            senderName = formatPhoneNumber(normalizedParticipant);
          }
        }
      } else {
        textToQuote = args.slice(1).join(' ');
        senderName = m.pushName || 'Pelanggan';
      }

      if (!textToQuote) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Ketik `.qc [TEKS]` atau balas (reply) pesan orang lain dengan `.qc`!\n\n_Contoh:_ `.qc halo ini quote stiker`" });
        return true;
      }

      try {
        await react('⏳');
        const qcRes = await mediaHandler.generateQuoteSticker(senderName, textToQuote);
        if (qcRes.success && qcRes.buffer) {
          await sock.sendMessage(jid, { sticker: qcRes.buffer });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ Gagal membuat quote sticker.` });
        }
      } catch (err) {
        await react('❌');
        console.error("[QC_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal membuat Stiker Quote.` });
      }
      return true;
    }

    // 8. Meme Generator (.meme, /meme)
    if (['meme'].includes(cleanCmd)) {
      const hasImage = m.message?.imageMessage || m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
      if (!hasImage) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Kirim foto dengan caption `.meme TEKS ATAS | TEKS BAWAH` atau balas foto orang lain dengan `.meme TEKS ATAS | TEKS BAWAH`!" });
        return true;
      }

      const textParam = args.slice(1).join(' ');
      const parts = textParam.split('|');
      const topText = parts[0]?.trim() || '';
      const bottomText = parts[1]?.trim() || '';

      try {
        await react('⏳');
        let targetMessage = m;
        if (m.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
          targetMessage = {
            key: {
              remoteJid: jid,
              id: m.message.extendedTextMessage.contextInfo.stanzaId,
              participant: m.message.extendedTextMessage.contextInfo.participant
            },
            message: m.message.extendedTextMessage.contextInfo.quotedMessage
          };
        }

        const imageBuffer = await downloadMediaMessage(targetMessage, 'buffer', {});
        const memeRes = await mediaHandler.generateMeme(imageBuffer, topText, bottomText);

        if (memeRes.success && memeRes.buffer) {
          await sock.sendMessage(jid, { image: memeRes.buffer, caption: "🎨 *Meme Generator by Akbar Store Bot*" });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ Gagal membuat meme.` });
        }
      } catch (err) {
        await react('❌');
        console.error("[MEME_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal membuat meme.` });
      }
      return true;
    }

    // 9. Website Screenshot (.ssweb, /ssweb)
    if (['ssweb', 'ss'].includes(cleanCmd)) {
      const url = args[1];
      if (!url) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap sertakan URL website.\n\n_Contoh:_ `.ssweb google.com`" });
        return true;
      }

      try {
        await react('⏳');
        const ssRes = await mediaHandler.screenshotWeb(url);
        if (ssRes.success && ssRes.buffer) {
          await sock.sendMessage(jid, { image: ssRes.buffer, caption: `📸 *Screenshot Website:* ${url}` });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ ${ssRes.message || 'Gagal mengambil screenshot.'}` });
        }
      } catch (err) {
        await react('❌');
        console.error("[SSWEB_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal mengambil screenshot website.` });
      }
      return true;
    }

    // 10. Cek Khodam Lucu (.khodam)
    if (['khodam'].includes(cleanCmd)) {
      const name = args.slice(1).join(' ') || m.pushName || 'Pelanggan';
      await react('🔮');
      const khodamRes = ent.getKhodam(name);
      const msg = `🔮 *CEK KHODAM PENDAMPING* 🔮

👤 *Nama:* ${khodamRes.user}
👻 *Khodam:* *${khodamRes.khodam}*

📜 *Penjelasan:*
_${khodamRes.desc}_`;
      await sock.sendMessage(jid, { text: msg });
      return true;
    }

    // 11. Truth or Dare (.tod, .truth, .dare)
    if (['tod', 'truth', 'dare'].includes(cleanCmd)) {
      await react('🎯');
      const todRes = ent.getTruthOrDare(cleanCmd);
      await sock.sendMessage(jid, { text: todRes });
      return true;
    }

    // 12. Text-to-Speech Voice Note (.tts)
    if (['tts'].includes(cleanCmd)) {
      const ttsText = args.slice(1).join(' ');
      if (!ttsText) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Ketik `.tts [TEKS]`!\n\n_Contoh:_ `.tts halo selamat datang di toko kami`" });
        return true;
      }

      try {
        await react('⏳');
        const ttsRes = await ent.generateTTS(ttsText, 'id');
        if (ttsRes.success && ttsRes.buffer) {
          await sock.sendMessage(jid, { audio: ttsRes.buffer, ptt: true, mimetype: 'audio/mp4' });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ ${ttsRes.message}` });
        }
      } catch (err) {
        await react('❌');
        console.error("[TTS_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal membuat suara TTS.` });
      }
      return true;
    }

    // 13. AI Image Generator (.draw, .aiimg)
    if (['draw', 'aiimg'].includes(cleanCmd)) {
      const prompt = args.slice(1).join(' ');
      if (!prompt) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Ketik `.draw [DESKRIPSI GAMBAR]`!\n\n_Contoh:_ `.draw kucing memakai kacamata hitam di pantai`" });
        return true;
      }

      try {
        await react('⏳');
        const aiRes = await ent.generateAIImage(prompt);
        if (aiRes.success && aiRes.buffer) {
          await sock.sendMessage(jid, { image: aiRes.buffer, caption: `🎨 *AI Image Generator:* "${prompt}"` });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ ${aiRes.message}` });
        }
      } catch (err) {
        await react('❌');
        console.error("[AI_DRAW_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal memproses gambar AI.` });
      }
      return true;
    }

    // 14. Shortlink (.shortlink, .short)
    if (['shortlink', 'short'].includes(cleanCmd)) {
      const targetUrl = args[1];
      if (!targetUrl) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Ketik `.shortlink [URL]`!\n\n_Contoh:_ `.shortlink https://google.com`" });
        return true;
      }

      try {
        await react('⏳');
        const shortRes = await ent.createShortLink(targetUrl);
        if (shortRes.success && shortRes.shortUrl) {
          await sock.sendMessage(jid, { text: `🔗 *Link Pendek Berhasil Dibuat:*\n\n${shortRes.shortUrl}` });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ ${shortRes.message}` });
        }
      } catch (err) {
        await react('❌');
        console.error("[SHORTLINK_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal memperpendek link.` });
      }
      return true;
    }

    // 15. Informasi Cuaca (.cuaca)
    if (['cuaca'].includes(cleanCmd)) {
      const city = args.slice(1).join(' ');
      if (!city) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Ketik `.cuaca [NAMA_KOTA]`!\n\n_Contoh:_ `.cuaca Jakarta` atau `.cuaca Bandung`" });
        return true;
      }

      try {
        await react('⏳');
        const wRes = await ent.getWeather(city);
        await sock.sendMessage(jid, { text: wRes.text || wRes.message });
        await react('🌤️');
      } catch (err) {
        await react('❌');
        console.error("[WEATHER_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal mengambil informasi cuaca.` });
      }
      return true;
    }

    // 16. Enhance Image HD (.hd, .remini)
    if (['hd', 'remini'].includes(cleanCmd)) {
      const hasImage = m.message?.imageMessage || m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
      if (!hasImage) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Kirim foto dengan caption `.hd` atau balas foto dengan `.hd` untuk menjernihkan gambar!" });
        return true;
      }

      try {
        await react('⏳');
        let targetMessage = m;
        if (m.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
          targetMessage = {
            key: {
              remoteJid: jid,
              id: m.message.extendedTextMessage.contextInfo.stanzaId
            },
            message: m.message.extendedTextMessage.contextInfo.quotedMessage
          };
        }

        const imgBuf = await downloadMediaMessage(targetMessage, 'buffer', {});
        const hdRes = await ent.enhanceImageHD(imgBuf);
        if (hdRes.success && hdRes.buffer) {
          await sock.sendMessage(jid, { image: hdRes.buffer, caption: "✨ *Foto Berhasil Ditingkatkan ke Kualitas HD!*" });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ Gagal menjernihkan foto.` });
        }
      } catch (err) {
        await react('❌');
        console.error("[HD_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal menjernihkan foto.` });
      }
      return true;
    }

    // 17. Brat Sticker Aesthetics Generator (.brat)
    if (['brat'].includes(cleanCmd)) {
      const bratText = args.slice(1).join(' ') || (m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation || m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text);
      if (!bratText) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Ketik `.brat [TEKS]` atau balas chat dengan `.brat`!\n\n_Contoh:_ `.brat kamu nanya?`" });
        return true;
      }

      try {
        await react('⏳');
        const bratRes = await mediaHandler.generateBratSticker(bratText);
        if (bratRes.success && bratRes.buffer) {
          await sock.sendMessage(jid, { sticker: bratRes.buffer });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ Gagal membuat stiker Brat.` });
        }
      } catch (err) {
        await react('❌');
        console.error("[BRAT_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal membuat Stiker Brat.` });
      }
      return true;
    }

    // 18. Invoice / Struk Resmi Transaksi (.invoice, .struk)
    if (['invoice', 'struk'].includes(cleanCmd)) {
      const orderIdStr = args[1]?.replace('#', '');
      if (!orderIdStr) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Ketik `.invoice [ORDER_ID]`!\n\n_Contoh:_ `.invoice ORD-20260730-1001`" });
        return true;
      }
      try {
        await react('⏳');
        const orderObj = await db.getOrderById(orderIdStr); // Bug Fix: Order ID adalah string, bukan integer
        if (!orderObj) {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ Transaksi dengan Order ID *#${orderIdStr}* tidak ditemukan.` });
          return true;
        }
        const invRes = await ent.generateInvoiceImage(orderObj);
        if (invRes.success && invRes.buffer) {
          await sock.sendMessage(jid, { image: invRes.buffer, caption: `📄 *Invoice Resmi Transaksi #${orderObj.id}*\nStatus: *${orderObj.status}*\nTotal: *Rp${(orderObj.total_harga || 0).toLocaleString('id-ID')}*` });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ Gagal memuat invoice transaksi.` });
        }
      } catch (err) {
        await react('❌');
        console.error("[INVOICE_CMD_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Terjadi kesalahan saat memuat invoice.` });
      }
      return true;
    }

    // 19. Game Tebak Gambar Berhadiah Poin (.tebakgambar)
    if (['tebakgambar'].includes(cleanCmd)) {
      if (ent.activeGames.has(jid)) {
        await sock.sendMessage(jid, { text: "⚠️ Masih ada sesi permainan Tebak Gambar yang sedang berlangsung di chat ini!" });
        return true;
      }

      const q = ent.getTebakGambarQuestion();
      ent.activeGames.set(jid, {
        answer: q.answer.toUpperCase(),
        hint: q.hint,
        points: 50,
        timeout: setTimeout(async () => {
          const activeGame = ent.activeGames.get(jid);
          if (!activeGame) return;
          ent.activeGames.delete(jid);
          await sock.sendMessage(jid, {
            text: `WAKTU TEBAK GAMBAR HABIS!\n\nJawaban yang benar: *${activeGame.answer}*\nKetik .tebakgambar untuk bermain lagi.`
          });
        }, 90 * 1000).unref()
      });

      const pointsGameCaption = `TEBAK GAMBAR\n\nPetunjuk: ${q.hint}\nHadiah: +50 poin game\nWaktu menjawab: 90 detik\n\nGabungkan arti gambar lalu ketik jawabannya langsung di chat.`;
      await sock.sendMessage(jid, { image: fs.readFileSync(q.image), caption: pointsGameCaption });
      return true;
    }

    // 19.5. Cek Status & Kecepatan Respon Bot (.ping, .p, .statusbot)
    if (['ping', 'p', 'statusbot'].includes(cleanCmd)) {
      const startTime = Date.now();
      await react('⚡');
      const latencySec = ((Date.now() - startTime) / 1000).toFixed(4);

      const fmtUptime = (seconds) => {
        const d = Math.floor(seconds / (3600 * 24));
        const h = Math.floor((seconds % (3600 * 24)) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const parts = [];
        if (d > 0) parts.push(`${d} day${d > 1 ? 's' : ''}`);
        if (h > 0) parts.push(`${h} hour${h > 1 ? 's' : ''}`);
        if (m > 0) parts.push(`${m} minute${m > 1 ? 's' : ''}`);
        parts.push(`${s} second${s > 1 ? 's' : ''}`);
        return parts.join(', ');
      };

      const botUptime = fmtUptime(process.uptime());
      const serverUptime = fmtUptime(os.uptime());

      // RAM Calculation
      const totalMemGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
      const usedMemGB = ((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024).toFixed(2);

      // CPU Usage Calculation
      const cpus = os.cpus();
      let totalIdle = 0, totalTick = 0;
      cpus.forEach(cpu => {
        for (const type in cpu.times) totalTick += cpu.times[type];
        totalIdle += cpu.times.idle;
      });
      const cpuUsagePct = (100 - (totalIdle / totalTick) * 100).toFixed(2);

      const cpuModel = (cpus[0]?.model || 'Generic CPU').trim();
      const cpuSpeed = cpus[0]?.speed || 0;
      const cpuCores = cpus.length;
      const osInfo = `${os.type()} ${os.release()} ${os.arch()}`;

      const pingMsg = `🏎️🟀 *Ping:* ${latencySec} Second

*Runtime BOT :* ${botUptime}

*Runtime Server :* ${serverUptime}

💻 *Info Server*

*OS :* ${osInfo}

*RAM:* ${usedMemGB} GB / ${totalMemGB} GB

*CPU USAGE:* ${cpuUsagePct}%

*CPU:* ${cpuModel} (${cpuSpeed} MHZ) ${cpuCores} Core(s) CPU`;

      await sendInteractiveButtons(sock, jid, {
        text: pingMsg,
        title: '⚡ STATUS BOT & SERVER',
        footer: 'Akbar Store WhatsApp Sales System',
        buttons: [
          { type: 'reply', text: '⚡ Refresh Status', id: '.ping' },
          { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' },
          { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
        ]
      });
      return true;
    }

    // 20. Kontak Owner / Pemilik Bot (.owner, .kontakowner, /owner)
    if (['owner', 'kontakowner'].includes(cleanCmd) || textTrim.toLowerCase().includes('kontak owner')) {
      const ownerJid = botSettings.ownerNumber || config.defaults.ownerNumber;
      const ownerNum = ownerJid.split('@')[0];
      const ownerName = `Owner ${botSettings.botName || 'Akbar Store'}`;

      const vcard = `BEGIN:VCARD
VERSION:3.0
FN:${ownerName}
ORG:${botSettings.botName || 'Akbar Store'};
TEL;type=CELL;type=VOICE;waid=${ownerNum}:+${ownerNum}
END:VCARD`;

      try {
        await react('👑');
        await sock.sendMessage(jid, { 
          contacts: { 
            displayName: ownerName, 
            contacts: [{ vcard }] 
          } 
        });

        const infoMsg = `👑 *KONTAK PEMILIK (OWNER) TOKO* 👑

👤 Nama Toko: *${botSettings.botName || 'Akbar Store'}*
📞 WhatsApp: *+${ownerNum}*
🔗 Chat Langsung: https://wa.me/${ownerNum}

_Silakan simpan kontak kartu di atas jika ada kendala khusus atau pertanyaan kerjasama._`;

        await sendInteractiveButtons(sock, jid, {
          text: infoMsg,
          title: '👑 KONTAK OWNER TOKO',
          footer: 'Tim Dukungan Akbar Store',
          buttons: [
            { type: 'url', text: '💬 Chat Owner (WA)', url: `https://wa.me/${ownerNum}` },
            { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' },
            { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
          ]
        });
      } catch (err) {
        console.error("[OWNER_CMD_ERR]", err.message);
      }
      return true;
    }

    // 21. Tag All / Hidetag Anggota Grup (.tagall, .hidetag, /tagall, /hidetag)
    if (['tagall', 'hidetag', 'everyone'].includes(cleanCmd)) {
      const isGroup = jid.endsWith('@g.us');
      if (!isGroup) {
        await sock.sendMessage(jid, { text: "⚠️ Perintah ini hanya dapat dijalankan di dalam Grup WhatsApp!" });
        return true;
      }

      // Cek apakah pengirim admin toko/admin grup
      const isGroupAdmin = isGroup ? (async () => {
        try {
          const groupMeta = await sock.groupMetadata(jid);
          const participant = groupMeta.participants.find(p => jidNormalizedUser(p.id) === senderNumber);
          return participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
        } catch (e) { return false; }
      })() : false;

      const isAdminUser = senderNumber === botSettings.ownerNumber || (await isGroupAdmin);
      if (!isAdminUser) {
        await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Admin atau Owner." });
        return true;
      }

      try {
        await react('📣');
        const groupMeta = await sock.groupMetadata(jid);
        const participants = groupMeta.participants || [];
        const mentions = participants.map(p => p.id);
        const annText = args.slice(1).join(' ') || (m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation || m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text) || 'Pengumuman untuk seluruh anggota grup!';

        let tagMsg = `📣 *PENGUMUMAN GRUP (${groupMeta.subject})* 📣\n\n📌 *Pesan:* ${annText}\n\n👥 *Anggota (${participants.length}):*\n`;
        participants.forEach((p, idx) => {
          tagMsg += `${idx + 1}. @${p.id.split('@')[0]}\n`;
        });

        await sock.sendMessage(jid, { text: tagMsg, mentions });
        await react('✅');
      } catch (err) {
        await react('❌');
        console.error("[TAGALL_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal melakukan Tag All: ${err.message}` });
      }
      return true;
    }

    return false;
  }

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

        if (m.pushName && senderNormalized) {
          userPushNamesMap.set(senderNormalized, m.pushName);
        }

        if (isFromMe) continue;

        // ====================================================================
        // DETEKSI OWNER & ADMIN — Sistem LID-Aware
        // Masalah: WhatsApp kini kirim pesan dari grup sebagai @lid (bukan nomor HP)
        // Solusi: cek ownerJid yang tersimpan (registrasi sekali via .setownerid di DM)
        //         + fallback ke phone digit match (untuk DM)
        // ====================================================================
        const extractDigits = (s) => s ? String(s).replace(/[^0-9]/g, '') : '';
        const senderDigits = extractDigits(senderNormalized);
        const ownerPhoneDigits = extractDigits(botSettings.ownerNumber || config.defaults.ownerNumber || '');
        const storedOwnerJid = (botSettings.ownerJid || '').trim(); // JID (bisa @lid) yang disimpan via .setownerid
        const adminEntries = (botSettings.adminNumbers || config.defaults.adminNumbers || "").split(',').map(n => extractDigits(n)).filter(d => d.length > 6);

        // Cek apakah sender adalah Owner (by stored JID exact match, atau phone digit match)
        let isOwnerSender = false;
        if (storedOwnerJid && senderNormalized === storedOwnerJid) {
          isOwnerSender = true; // Exact JID match (handles @lid)
        } else if (ownerPhoneDigits && senderDigits && senderDigits.length > 6 && senderDigits.includes(ownerPhoneDigits)) {
          isOwnerSender = true; // Phone number match (works in DM)
        }

        let isAdmin = isOwnerSender;

        // Cek admin entries dari settings
        if (!isAdmin && adminEntries.some(adm => senderDigits.length > 6 && senderDigits.includes(adm))) {
          isAdmin = true;
        }

        // Di GRUP: cek status admin grup via groupMetadata (untuk fitur grup seperti anti-link)
        if (!isAdmin && isGroup) {
          try {
            const groupMeta = await sock.groupMetadata(jid);
            const pMatch = groupMeta.participants.find(p =>
              p.id === sender || p.id === senderNormalized ||
              p.lid === sender || p.lid === senderNormalized
            );
            if (pMatch && (pMatch.admin === 'admin' || pMatch.admin === 'superadmin')) {
              isAdmin = true;
            }
          } catch (e) {
            // Silent fail jika tidak bisa ambil metadata grup
          }
        }

        // Cek apakah user sedang di-banned (Owner/Admin tidak pernah kena ban)
        if (!isAdmin) {
          const isBanned = await db.isUserBanned(senderNormalized);
          if (isBanned) continue;
        }

        const mainBuyerGroupJid = botSettings.buyerGroupId || "";

        const msgText = extractMessageText(m).trim();

        // Cek jika ini adalah perintah media utility (.tt, .ig, .yt, .stiker, .gif, .toimg)
        const isMediaHandled = await handleMediaCommands(jid, senderNormalized, m, msgText);
        if (isMediaHandled) continue;

        console.log(`[DEBUG_MSG] Grup: ${isGroup} (${jid}), Pengirim: ${senderNormalized}, Text: "${msgText}", Admin: ${isAdmin}, Owner: ${isOwnerSender}`);

        // Cek Anti-Spam & Anti-Link (Semua pengirim dicek, namun admin tidak akan di-kick)
        if (isGroup) {
          const isHandled = await handleAntiSpamAndAntiLink(m, jid, senderNormalized, isGroup, msgText, isAdmin);
          if (isHandled) continue;
        }

        // Ambil status percakapan (Take Over check)
        const conv = await db.getOrCreateConversation(senderNormalized);
        const isTakenOver = conv.conversation_state === 'ADMIN';

        // 🎮 Cek jika ada game Tebak Gambar aktif di chat/grup ini
        if (ent.activeGames.has(jid)) {
          const game = ent.activeGames.get(jid);
          if (msgText.toUpperCase().trim() === game.answer) {
            if (game.timeout) clearTimeout(game.timeout);
            ent.activeGames.delete(jid);
            const pointsProfile = await db.awardGamePoints(senderNormalized, game.points || 50, true);
            await sock.sendMessage(jid, {
              text: `SELAMAT! TEBAKAN BENAR!\n\nPemenang: *@${senderNormalized.split('@')[0]}* (${m.pushName || 'Pelanggan'})\nJawaban: *${game.answer}*\nHadiah: *+${game.points || 50} poin game*\nTotal poin: *${pointsProfile.points}*`,
              mentions: [senderNormalized]
            });
            await sock.sendMessage(jid, { react: { text: '🎉', key: m.key } });
            continue;
          }

        }

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

          const messageContent = extractMessageText(m);

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

          // Memproses Perintah Bot (Plugins, Media/Downloader, Admin/Group, Customer)
          const routerArgs = msgText.trim().split(/\s+/);
          const routerRawCmd = routerArgs[0].toLowerCase();
          const routerCleanCmd = routerRawCmd.replace(/^[./#]/, '');
          const isPlugin = await executePlugin(routerCleanCmd, { sock, jid, senderNumber: senderNormalized, m, msgText, args: routerArgs, cleanCmd: routerCleanCmd, isAdmin });
          
          if (!isPlugin) {
            const isFun = await handleFunCommand({ sock, jid, senderNumber: senderNormalized, messageObj: m, text: msgText, args: routerArgs, cleanCmd: routerCleanCmd, isFromGroup: false });
            if (!isFun) {
              const isMedia = await handleMediaCommands(jid, senderNormalized, m, msgText);
              if (isMedia) continue;
              const isHandledAdmin = await handleGroupMessage(jid, senderNormalized, m, msgText, isAdmin);
              if (!isHandledAdmin) {
                if (isTakenOver) {
                  console.log(`[BOT] Percakapan dengan ${senderNormalized} sedang diambil alih admin. Auto-reply dinonaktifkan.`);
                } else {
                  // Menangani Pesan DM Pelanggan
                  await handleCustomerMessage(jid, senderNormalized, m, msgText, false, { isAdmin, isOwner: isOwnerSender });
                }
              }
            }
          }
        } else {
          // Menangani Pesan Grup di SEMUA Grup tempat Bot bergabung
          const routerArgs = msgText.trim().split(/\s+/);
          const routerRawCmd = routerArgs[0].toLowerCase();
          const routerCleanCmd = routerRawCmd.replace(/^[./#]/, '');
          const isPlugin = await executePlugin(routerCleanCmd, { sock, jid, senderNumber: senderNormalized, m, msgText, args: routerArgs, cleanCmd: routerCleanCmd, isAdmin });

          if (!isPlugin) {
            const isFun = await handleFunCommand({ sock, jid, senderNumber: senderNormalized, messageObj: m, text: msgText, args: routerArgs, cleanCmd: routerCleanCmd, isFromGroup: true });
            if (!isFun) {
              const isMedia = await handleMediaCommands(jid, senderNormalized, m, msgText);
              if (isMedia) continue;
              const isHandledAdmin = await handleGroupMessage(jid, senderNormalized, m, msgText, isAdmin);
              if (!isHandledAdmin) {
                // Perintah pelanggan (list, menu, buy, checkout, status, dll) di grup
                await handleCustomerMessage(jid, senderNormalized, m, msgText, true, { isAdmin, isOwner: isOwnerSender });
              }
            }
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
async function handleCustomerMessage(jid, senderNumber, messageObj, text, isFromGroup = false, actor = {}) {
  const textLower = text.toLowerCase();
  const args = text.trim().split(/\s+/);
  const rawCmd = args[0].toLowerCase();
  const cleanCmd = rawCmd.replace(/^[./#]/, '');

  const customerName = messageObj.pushName || "Pelanggan";
  await db.getOrCreateCustomer(senderNumber, customerName);

  const memberProfile = await db.getCustomerMembershipProfile(senderNumber);
  const isPrivateCommand =
    ['beli', 'buy'].includes(cleanCmd) ||
    ['cart', 'keranjang', 'checkout', 'bayar', 'cancel', 'batal', 'status', 'riwayat', 'history'].includes(cleanCmd);
  const responseJid = (isFromGroup && isPrivateCommand) ? senderNumber : jid;

  if (memberProfile?.account_status === 'BANNED' && !actor.isAdmin) {
    await sock.sendMessage(jid, { text: '⛔ Akun kamu sedang diblokir dari layanan bot. Hubungi Owner jika merasa ini kesalahan.' });
    return true;
  }

  if (['daftar', 'register', 'registrasi'].includes(cleanCmd)) {
    const requestedName = args.slice(1).join(' ').trim();
    if (!requestedName) {
      await sock.sendMessage(responseJid, { text: 'Format: `.daftar Nama Kamu`\nContoh: `.daftar Budi Santoso`' });
      return true;
    }
    try {
      const profile = await db.registerCustomer(senderNumber, requestedName);
      await sock.sendMessage(responseJid, { text: `✅ *Registrasi berhasil!*\n\nNama: *${profile.nama}*\nStatus: *${profile.account_status}*\nRole: *${actor.isOwner ? 'OWNER' : profile.role}*\nTier: *${profile.tier}*\n\nKetik *.profil* untuk melihat profil lengkap.` });
    } catch (error) {
      await sock.sendMessage(responseJid, { text: `❌ Registrasi gagal: ${error.message}` });
    }
    return true;
  }

  if (['profil', 'akun', 'member', 'statusakun'].includes(cleanCmd)) {
    const profile = await db.getCustomerMembershipProfile(senderNumber);
    const role = actor.isOwner ? 'OWNER' : (profile?.role || 'MEMBER');
    const registration = profile?.profile_completed ? 'Sudah terdaftar' : 'Belum lengkap — ketik .daftar <nama>';
    await sock.sendMessage(responseJid, { text: `👤 *PROFIL MEMBER*\n\nNama: *${profile?.nama || customerName}*\nRole: *${role}*\nStatus: *${profile?.account_status || 'ACTIVE'}*\nTier pelanggan: *${profile?.tier || 'BRONZE'}*\nRegistrasi: *${registration}*\n\n🛒 Transaksi selesai: *${profile?.total_orders || 0}*\n💰 Total belanja: *Rp${(profile?.total_spend || 0).toLocaleString('id-ID')}*\n🎮 Level game: *${profile?.game_level || 1}* (${profile?.game_xp || 0} XP)\n🏆 Poin game: *${profile?.game_points || 0}*\n🔥 Streak: *${profile?.game_streak || 0} hari*` });
    return true;
  }

  const extractTargetMember = () => {
    const mentioned = messageObj.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    const rawTarget = mentioned || args[1];
    if (!rawTarget) return null;
    if (rawTarget.includes('@')) return jidNormalizedUser(rawTarget);
    const digits = rawTarget.replace(/\D/g, '');
    return digits ? `${digits}@s.whatsapp.net` : null;
  };

  if (['setmemberrole', 'memberrole'].includes(cleanCmd)) {
    if (!actor.isOwner) {
      await sock.sendMessage(responseJid, { text: '⛔ Hanya Owner yang boleh mengubah role member.' });
      return true;
    }
    const target = extractTargetMember();
    const role = args[2] || args[1];
    if (!target || !role) {
      await sock.sendMessage(responseJid, { text: 'Format: `.setmemberrole @member MEMBER|ADMIN`' });
      return true;
    }
    try {
      const profile = await db.updateCustomerRole(target, role);
      await sock.sendMessage(responseJid, { text: `✅ Role *${profile.nama}* diubah menjadi *${profile.role}*.` });
    } catch (error) {
      await sock.sendMessage(responseJid, { text: `❌ Gagal mengubah role: ${error.message}` });
    }
    return true;
  }

  if (['setmemberstatus', 'memberstatus'].includes(cleanCmd)) {
    if (!actor.isAdmin) {
      await sock.sendMessage(responseJid, { text: '⛔ Hanya Admin atau Owner yang boleh mengubah status member.' });
      return true;
    }
    const target = extractTargetMember();
    const status = args[2] || args[1];
    if (!target || !status) {
      await sock.sendMessage(responseJid, { text: 'Format: `.setmemberstatus @member ACTIVE|INACTIVE|BANNED`' });
      return true;
    }
    try {
      const profile = await db.updateCustomerAccountStatus(target, status);
      await sock.sendMessage(responseJid, { text: `✅ Status *${profile.nama}* diubah menjadi *${profile.account_status}*.` });
    } catch (error) {
      await sock.sendMessage(responseJid, { text: `❌ Gagal mengubah status: ${error.message}` });
    }
    return true;
  }

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

  // 🥚 EASTER EGG MEME: "Kapan Kapan yh sayang"
  const cleanMemeText = text.toLowerCase().trim().replace(/[?!.,~_*-]+/g, '');
  const kapanMemeRegex = /^(?:kapan|kpn|wen|wnn|kpnn+|kpann+|(?:kapan|kpn)[-\s]?2|kapankapan)\s*(?:yah+|ya+|y+|yh+|nih+|tuh+|dong+|dng+|dek+)?$/i;
  if (kapanMemeRegex.test(cleanMemeText)) {
    try {
      await sock.sendMessage(jid, { react: { text: '😜', key: messageObj.key } });
    } catch (e) {}
    await sock.sendMessage(jid, { 
      text: "✨ *Kapan Kapan yh sayang...* 🤪💖\n\n_~ Basa-basi dulu, keputusannya nanti-nanti aja deh! 🙈✨_" 
    }, { quoted: messageObj });
    return true;
  }

  // ==========================================
  // LOGIKA NAVIGASI MENU TERKATEGORI (ASCII ART DESIGN)
  // ==========================================
  const menuMatch = textLower.match(/^(?:menu|help|bantuan)(?:\s+(1|2|3|4|5|6|jualan|produk|transaksi|bayar|downloader|media|hiburan|game|games|fun|promo|diskon|referral|poin|rank|reward|favorit|wishlist|admin|daftar|registrasi|profil|akun|setmemberrole|memberrole|setmemberstatus|memberstatus|all|semua))?$/i);

  if (menuMatch) {
    const subCat = menuMatch[1] ? menuMatch[1].toLowerCase() : '';

    // Deteksi mode grup (Sales Mode vs All Mode)
    let isSalesModeGroup = false;
    if (isFromGroup) {
      const gSettings = await db.getGroupSettings(jid);
      if (gSettings.bot_mode === 'sales') {
        isSalesModeGroup = true;
      }
    }

    if (isSalesModeGroup && ['3', 'downloader', 'media', 'hiburan', '4', 'game', 'games', 'fun'].includes(subCat)) {
      await sock.sendMessage(responseJid, { 
        text: "🛍️ *MODE JUALAN AKTIF:* Grup ini berada dalam *Mode Jualan/Toko*. Fitur media, downloader, dan game tidak diaktifkan di grup ini agar grup tetap tertib khusus jualan." 
      });
      return;
    }

    const organizedMenu = buildCommandMenu(subCat || 'all', { salesMode: isSalesModeGroup });
    if (organizedMenu) {
      await sock.sendMessage(responseJid, { text: organizedMenu });
      return;
    }

    // Hitung Uptime
    const uptimeSec = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const secs = uptimeSec % 60;
    const uptimeStr = `${hours}j ${mins}m ${secs}d`;
    const storeTitle = (botSettings.storeName || config.defaults.storeName).toUpperCase();
    const modeBadge = isSalesModeGroup ? "🛍️ MODE JUALAN" : "🌐 MODE ALL";

    const headerCard = `📋 *MENU UTAMA TOKO*
━━━━━━━━━━━━━━━━━━━
👤 *User:* ${customerName}
⏱️ *Uptime:* ${uptimeStr}
⚙️ *Mode:* ${modeBadge}
⌨️ *Prefix:* \`.\` / \`/\` / \`#\`
━━━━━━━━━━━━━━━━━━━\n\n`;

    // Sub-Menu 1: Jualan & Produk
    if (['1', 'jualan', 'produk'].includes(subCat)) {
      const msg = headerCard + `🛍️ *PRODUK & JUALAN*
▫️ \`.produk\` — Katalog & sisa stok produk
▫️ \`.beli <kode> <qty>\` — Beli produk digital
▫️ \`.cari <kata kunci>\` — Cari produk toko
▫️ \`.bundle\` — Lihat paket hemat bundling

━━━━━━━━━━━━━━━━━━━
💡 _Contoh penggunaan: .produk atau .beli NET01 1_`;
      await sendInteractiveButtons(sock, responseJid, {
        text: msg,
        title: '🛍️ PRODUK & JUALAN',
        footer: 'Pilih aksi di bawah atau ketik perintah langsung',
        buttons: [
          { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' },
          { type: 'reply', text: '🛒 Keranjang Saya', id: '.keranjang' },
          { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
        ]
      });
      return;
    }

    // Sub-Menu 2: Transaksi & Pembayaran
    if (['2', 'transaksi', 'bayar'].includes(subCat)) {
      const msg = headerCard + `🛒 *TRANSAKSI & PEMBAYARAN*
▫️ \`.keranjang\` — Cek isi keranjang belanja
▫️ \`.checkout\` — Link pembayaran QRIS/Midtrans
▫️ \`.status\` — Cek status transaksi terbaru
▫️ \`.riwayat\` — 5 riwayat transaksi terakhir
▫️ \`.batal\` — Batalkan pesanan aktif

━━━━━━━━━━━━━━━━━━━
💡 _Contoh penggunaan: .keranjang atau .status_`;
      await sendInteractiveButtons(sock, responseJid, {
        text: msg,
        title: '🛒 TRANSAKSI & PEMBAYARAN',
        footer: 'Pilih opsi transaksi di bawah ini',
        buttons: [
          { type: 'reply', text: '🛒 Keranjang', id: '.keranjang' },
          { type: 'reply', text: '💳 Checkout', id: '.checkout' },
          { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
        ]
      });
      return;
    }

    // Sub-Menu 3: Downloader, Media & Hiburan
    if (['3', 'downloader', 'media', 'hiburan'].includes(subCat)) {
      const msg = headerCard + `📥 *DOWNLOADER & MEDIA*
▫️ \`.tt <link>\` — Download video TikTok
▫️ \`.ig <link>\` — Download Reels/Foto IG
▫️ \`.fb <link>\` — Download video Facebook
▫️ \`.yt <link>\` — Download MP3/MP4 YouTube
▫️ \`.stiker\` — Foto/Video ke Stiker WA
▫️ \`.toimg\` / \`.tovid\` — Stiker ke Foto/Video
▫️ \`.qc <teks>\` — Stiker Quote Chat
▫️ \`.brat <teks>\` — Stiker Brat Aesthetics
▫️ \`.draw <prompt>\` — Generate foto AI
▫️ \`.hd\` — Jernihkan foto buram
▫️ \`.khodam <nama>\` — Cek khodam lucu
▫️ \`.tts <teks>\` — Ubah teks ke Voice Note

━━━━━━━━━━━━━━━━━━━
💡 _Contoh penggunaan: .brat kamu nanya? atau .khodam Budi_`;
      await sendInteractiveButtons(sock, responseJid, {
        text: msg,
        title: '📥 MEDIA & CREATIVE',
        footer: 'Pilih aksi cepat di bawah ini',
        buttons: [
          { type: 'reply', text: '🎮 Game & Quiz', id: '.menu hiburan' },
          { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' },
          { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
        ]
      });
      return;
    }

    // Sub-Menu 4: Promo & Diskon
    if (['4', 'promo', 'diskon', 'referral'].includes(subCat)) {
      const msg = headerCard + `🎟️ *PROMO & REFERRAL*
▫️ \`.kupon <kode>\` — Gunakan kupon diskon
▫️ \`.referral\` — Ajak teman & dapatkan kupon 10%
▫️ \`.bundle\` — Lihat paket hemat bundling

━━━━━━━━━━━━━━━━━━━
💡 _Contoh penggunaan: .kupon DISKON10_`;
      await sendInteractiveButtons(sock, responseJid, {
        text: msg,
        title: '🎟️ PROMO & REFERRAL',
        footer: 'Ajak teman & nikmati diskon',
        buttons: [
          { type: 'reply', text: '👥 Program Referral', id: '.referral' },
          { type: 'reply', text: '📦 Paket Bundle', id: '.bundle' },
          { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
        ]
      });
      return;
    }

    // Sub-Menu 5: Wishlist & Notifikasi Stok
    if (['5', 'favorit', 'wishlist'].includes(subCat)) {
      const msg = headerCard + `💝 *FAVORIT & NOTIFIKASI*
▫️ \`.simpan <kode>\` — Simpan produk ke wishlist
▫️ \`.favorit\` — Lihat daftar produk favorit
▫️ \`.notify <kode>\` — Langganan notifikasi restok

━━━━━━━━━━━━━━━━━━━
💡 _Contoh penggunaan: .favorit atau .notify NET01_`;
      await sendInteractiveButtons(sock, responseJid, {
        text: msg,
        title: '💝 FAVORIT & WISHLIST',
        footer: 'Kelola produk impian Anda',
        buttons: [
          { type: 'reply', text: '💝 Lihat Wishlist', id: '.favorit' },
          { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' },
          { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
        ]
      });
      return;
    }

    // Sub-Menu 6: Admin & Owner
    if (['6', 'admin'].includes(subCat)) {
      const msg = headerCard + `👑 *ADMIN & OWNER*
▫️ \`.owner\` — Kontak resmi Pemilik Toko
▫️ \`.ping\` — Cek status & kecepatan respon
▫️ \`.mode <jualan/all>\` — Atur mode grup
▫️ \`.paid <order_id>\` — Konfirmasi pembayaran
▫️ \`.done <order_id>\` — Pesanan selesai
▫️ \`.cancel <order_id>\` — Batalkan pesanan
▫️ \`.tagall <pesan>\` — Mention semua member

━━━━━━━━━━━━━━━━━━━
💡 _Contoh penggunaan: .mode jualan atau .ping_`;
      await sendInteractiveButtons(sock, responseJid, {
        text: msg,
        title: '👑 ADMIN & OWNER',
        footer: 'Fitur khusus admin & pengelola',
        buttons: [
          { type: 'reply', text: '👑 Kontak Owner', id: '.owner' },
          { type: 'reply', text: '⚡ Cek Status Ping', id: '.ping' },
          { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
        ]
      });
      return;
    }

    // TAMPILAN MENU UTAMA KHUSUS MODE JUALAN / TOKO
    const menuSections = [
      {
        title: '📂 Pilih Kategori Menu Toko',
        rows: [
          { title: '🛍️ Produk & Jualan', rowId: '.menu jualan', description: 'Katalog, sisa stok & paket hemat' },
          { title: '🛒 Transaksi & Pembayaran', rowId: '.menu transaksi', description: 'Keranjang, checkout, status & riwayat' },
          { title: '📥 Downloader & Media', rowId: '.menu media', description: 'TikTok, IG, YT, FB, stiker & AI draw' },
          { title: '🎮 Hiburan & Game', rowId: '.menu hiburan', description: 'Kuis, tebak gambar, khodam & T-o-D' },
          { title: '🏆 Poin & Reward', rowId: '.menu reward', description: 'Daily claim, poin, rank & referral' },
          { title: '👑 Admin & Owner', rowId: '.menu admin', description: 'Kontak owner, status bot & pengeluaran' }
        ]
      }
    ];

    const menuQuickButtons = [
      { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' },
      { type: 'reply', text: '🛒 Keranjang Saya', id: '.keranjang' },
      { type: 'reply', text: '🎁 Klaim Daily', id: '.daily' }
    ];

    if (isSalesModeGroup) {
      const salesMenu = headerCard + `🛍️ *PRODUK & JUALAN*
▫️ \`.produk\` — Katalog & sisa stok produk
▫️ \`.beli <kode> <qty>\` — Beli produk digital
▫️ \`.cari <kata kunci>\` — Cari produk toko
▫️ \`.bundle\` — Lihat paket hemat bundling

🛒 *TRANSAKSI & PEMBAYARAN*
▫️ \`.keranjang\` — Cek isi keranjang belanja
▫️ \`.checkout\` — Link pembayaran QRIS/Midtrans
▫️ \`.status\` — Cek status transaksi terbaru
▫️ \`.riwayat\` — 5 riwayat transaksi terakhir
▫️ \`.batal\` — Batalkan pesanan aktif

🎟️ *PROMO & REFERRAL*
▫️ \`.kupon <kode>\` — Gunakan kupon diskon
▫️ \`.referral\` — Ajak teman & dapatkan diskon

👑 *ADMIN & OWNER*
▫️ \`.owner\`  •  \`.ping\`  •  \`.mode\`  •  \`.tagall\`

━━━━━━━━━━━━━━━━━━━
💡 _Ketik perintah langsung di atas atau pilih menu interaktif di bawah_`;

      await sendInteractiveButtons(sock, responseJid, {
        text: salesMenu,
        title: '📋 MENU TOKO (MODE JUALAN)',
        footer: 'Klik tombol atau daftar kategori di bawah ini',
        buttons: menuQuickButtons,
        sections: menuSections
      });
      return;
    }

    // TAMPILAN MENU UTAMA FULL (MODE ALL)
    const fullMenu = headerCard + `🛍️ *PRODUK & JUALAN*
▫️ \`.produk\` — Katalog & sisa stok produk
▫️ \`.beli <kode> <qty>\` — Beli produk digital
▫️ \`.cari <kata kunci>\` — Cari produk toko
▫️ \`.bundle\` — Lihat paket hemat bundling

🛒 *TRANSAKSI & PEMBAYARAN*
▫️ \`.keranjang\` — Cek isi keranjang belanja
▫️ \`.checkout\` — Link pembayaran QRIS/Midtrans
▫️ \`.status\` — Cek status transaksi terbaru
▫️ \`.riwayat\` — 5 riwayat transaksi terakhir
▫️ \`.batal\` — Batalkan pesanan aktif

📥 *DOWNLOADER & MEDIA*
▫️ \`.tt <link>\` — Download video TikTok
▫️ \`.ig <link>\` — Download Reels/Foto IG
▫️ \`.fb <link>\` — Download video Facebook
▫️ \`.yt <link>\` — Download MP3/MP4 YouTube
▫️ \`.stiker\` — Foto/Video ke Stiker WA
▫️ \`.toimg\` / \`.tovid\` — Stiker ke Foto/Video
▫️ \`.qc <teks>\` — Stiker Quote Chat
▫️ \`.brat <teks>\` — Stiker Brat Aesthetics
▫️ \`.draw <prompt>\` — Generate foto AI
▫️ \`.hd\` — Jernihkan foto buram
▫️ \`.khodam <nama>\` — Cek khodam lucu
▫️ \`.tts <teks>\` — Ubah teks ke Voice Note

🎟️ *PROMO & REFERRAL*
▫️ \`.kupon <kode>\` — Gunakan kupon diskon
▫️ \`.referral\` — Kode referral ajak teman
▫️ \`.favorit\` — Lihat produk favorit/wishlist

👑 *ADMIN & OWNER*
▫️ \`.owner\` — Kontak resmi Owner
▫️ \`.ping\` — Cek status & kecepatan respon
▫️ \`.mode <jualan/all>\` — Atur mode grup
▫️ \`.tagall <pesan>\` — Mention semua member

━━━━━━━━━━━━━━━━━━━
💡 _Ketik perintah langsung di atas atau pilih menu interaktif di bawah_`;

    await sendInteractiveButtons(sock, responseJid, {
      text: fullMenu,
      title: '📋 MENU UTAMA AKBAR STORE',
      footer: 'Klik tombol cepat atau pilih kategori dari daftar menu',
      buttons: menuQuickButtons,
      sections: menuSections
    });
    return;
  }

  // 2. LIST / PRODUK
  if (textLower === 'list' || textLower === 'produk') {
    const products = await db.getProducts();
    if (products.length === 0) {
      await sock.sendMessage(responseJid, { text: "Saat ini belum ada produk yang terdaftar di toko kami." });
      return;
    }

    let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 *KATALOG PRODUK TOKO*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    const limit = botSettings.lowStockLimit || config.defaults.lowStockLimit;
    for (const p of products) {
      let stockStatus = "";
      if (p.stok === 0) {
        stockStatus = "🔴 *Stok Habis* (Ketik `notify " + p.kode + "` agar diingatkan via DM saat restok)";
      } else if (p.stok <= limit) {
        stockStatus = `🟡 *Stok Terbatas* (Sisa: ${p.stok} pcs)`;
      } else {
        stockStatus = `🟢 *Ready Stock* (Tersedia: ${p.stok} pcs)`;
      }

      msg += `${stockStatus}
📌 *${p.nama}*
• Kode Produk : \`${p.kode}\`
• Harga       : *Rp${p.harga.toLocaleString('id-ID')}*
• Deskripsi   : ${p.deskripsi || '-'}\n\n`;
    }

    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 *CARA MEMBELI:*
Ketik: *beli [KODE] [JUMLAH]*
_(Contoh: \`beli NET01 1\`)_
━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    await sendInteractiveButtons(sock, responseJid, {
      text: msg,
      title: '📦 KATALOG PRODUK TOKO',
      footer: 'Klik tombol di bawah untuk melihat keranjang atau ke menu utama',
      buttons: [
        { type: 'reply', text: '🛒 Keranjang Saya', id: '.keranjang' },
        { type: 'reply', text: '💳 Checkout Pembayaran', id: '.checkout' },
        { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
      ]
    });
    return;
  }

  // 3. BELI [KODE] [JUMLAH]
  const buyRegex = /^(beli|buy)\s+(\w+)(?:\s+(\d+))?$/i;
  if (buyRegex.test(text)) {
    const match = text.match(buyRegex);
    const code = match[2].toUpperCase();

    // Cek apakah kode produk benar-benar terdaftar di database toko
    const existingProduct = await db.getProductByKode(code);
    if (!existingProduct) {
      // Jika kode produk tidak terdaftar di database (misal: "lu kemaren beli itu kah"), anggap ini percakapan biasa -> Bot DIAM
      return;
    }
    // Validasi Wajib Join Grup sebelum beli
    const groupCheck = await checkIsUserInGroup(senderNumber);
    if (!groupCheck.isMember) {
      const joinMsg = `⚠️ *PERSYARATAN PEMBELIAN: WAJIB JOIN GRUP*
      
Halo Kak! Untuk dapat memesan & membeli produk di toko kami, Anda diwajibkan untuk bergabung terlebih dahulu ke **Grup Pembeli Toko** kami.

📢 *Grup:* ${groupCheck.groupName}
🔗 *Link Undangan Grup:*
${groupCheck.inviteLink || "Silakan minta link undangan grup ke Admin atau Owner."}

_Silakan klik link di atas untuk bergabung, kemudian ulangi perintah \`${text}\` kembali. Terima kasih!_ 🙏`;

      await sock.sendMessage(responseJid, { text: joinMsg });
      await sendRedirectNotice();
      return;
    }

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

    await sendInteractiveButtons(sock, responseJid, {
      text: successMsg,
      title: '✅ BERHASIL DITAMBAHKAN',
      footer: 'Pilih langkah selanjutnya di bawah ini',
      buttons: [
        { type: 'reply', text: '🛒 Lihat Keranjang', id: '.keranjang' },
        { type: 'reply', text: '💳 Checkout Pembayaran', id: '.checkout' },
        { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' }
      ]
    });
    await sendRedirectNotice();
    return;
  }

  // 4. KERANJANG / CART
  if (textLower === 'cart' || textLower === 'keranjang') {
    const cart = await db.getCartDetails(senderNumber);
    if (cart.items.length === 0) {
      await sendInteractiveButtons(sock, responseJid, {
        text: "🛒 *Keranjang belanja Anda masih kosong.*\nKetik *produk* untuk melihat produk yang tersedia.",
        title: '🛒 KERANJANG KOSONG',
        footer: 'Silakan pilih produk terlebih dahulu',
        buttons: [
          { type: 'reply', text: '🛍️ Lihat Katalog Produk', id: '.produk' },
          { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
        ]
      });
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

    await sendInteractiveButtons(sock, responseJid, {
      text: msg,
      title: '🛒 KERANJANG BELANJA',
      footer: 'Pilih aksi transaksi di bawah ini',
      buttons: [
        { type: 'reply', text: '💳 Checkout Pembayaran', id: '.checkout' },
        { type: 'reply', text: '❌ Batalkan Pesanan', id: '.batal' },
        { type: 'reply', text: '🛍️ Tambah Produk', id: '.produk' }
      ]
    });
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
${groupCheck.inviteLink || "Silakan minta link undangan grup ke Admin atau Owner."}

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
      await sendInteractiveButtons(sock, responseJid, {
        text: invoiceMsg,
        title: '🧾 TAGIHAN PEMBAYARAN INSTAN',
        footer: 'Klik tombol di bawah ini untuk langsung membayar',
        buttons: [
          { type: 'url', text: '💳 Bayar Sekarang', url: midtransRes.redirect_url },
          { type: 'reply', text: '🛒 Lihat Keranjang', id: '.keranjang' },
          { type: 'reply', text: '❌ Batalkan Pesanan', id: '.batal' }
        ]
      });
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
      await sendInteractiveButtons(sock, responseJid, {
        text: '📱 *TIPS PEMBAYARAN:*\nSetelah melakukan transfer via QRIS, harap kirimkan foto/screenshot *BUKTI TRANSFER* langsung ke chat ini.',
        title: '🧾 PETUNJUK TRANSFER',
        footer: 'Opsi transaksi',
        buttons: [
          { type: 'reply', text: '🛒 Lihat Keranjang', id: '.keranjang' },
          { type: 'reply', text: '❌ Batalkan Pesanan', id: '.batal' }
        ]
      });
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

  // 9. RIWAYAT / HISTORY
  if (textLower === 'riwayat' || textLower === 'history') {
    const history = await db.getCustomerOrderHistory(senderNumber);
    if (history.length === 0) {
      await sock.sendMessage(responseJid, { text: "📜 Anda belum memiliki riwayat pesanan." });
      await sendRedirectNotice();
      return;
    }
    let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📜 *RIWAYAT 5 PESANAN TERAKHIR*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    for (const o of history) {
      let statusEmoji = '🔄';
      switch(o.status) {
        case 'COMPLETED': statusEmoji = '✅'; break;
        case 'CANCELLED': statusEmoji = '❌'; break;
        case 'WAITING_PAYMENT': statusEmoji = '⏳'; break;
        case 'PAID': statusEmoji = '🟢'; break;
        case 'CART': statusEmoji = '🛒'; break;
      }
      msg += `${statusEmoji} *${o.order_id}*\n`;
      msg += `   Total: Rp${o.total.toLocaleString('id-ID')}`;
      if (o.discount_amount > 0) msg += ` (Diskon: -Rp${o.discount_amount.toLocaleString('id-ID')})`;
      msg += `\n   Status: ${o.status}\n   Tanggal: ${new Date(o.created_at).toLocaleDateString('id-ID')}\n   Item: ${o.items_summary || '-'}\n\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    await sock.sendMessage(responseJid, { text: msg });
    await sendRedirectNotice();
    return;
  }

  // 10. CARI PRODUK
  const cariRegex = /^cari\s+(.+)$/i;
  if (cariRegex.test(text)) {
    const keyword = text.match(cariRegex)[1];
    const results = await db.searchProducts(keyword);
    if (results.length === 0) {
      await sock.sendMessage(responseJid, { text: `🔎 Tidak ditemukan produk dengan kata kunci "*${keyword}*".\nKetik *produk* untuk melihat semua katalog.` });
      return;
    }
    let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔎 *HASIL PENCARIAN:* "${keyword}"\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    for (const p of results) {
      const stockLabel = p.stok === 0 ? '🔴 Habis' : p.stok <= 3 ? `🟡 Sisa ${p.stok}` : `🟢 ${p.stok} pcs`;
      msg += `📌 *${p.nama}* (\`${p.kode}\`)\n   Harga: *Rp${p.harga.toLocaleString('id-ID')}* | Stok: ${stockLabel}\n\n`;
    }
    msg += `Ketik *beli [KODE] [JUMLAH]* untuk membeli.`;
    await sock.sendMessage(responseJid, { text: msg });
    return;
  }

  // 11. KUPON
  const kuponRegex = /^kupon\s+(\w+)$/i;
  if (kuponRegex.test(text)) {
    const code = text.match(kuponRegex)[1].toUpperCase();
    const coupon = await db.getCoupon(code);
    if (!coupon) {
      await sock.sendMessage(responseJid, { text: `❌ Kupon *${code}* tidak ditemukan atau sudah tidak berlaku.` });
      return;
    }
    // Validasi: cek expired
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      await sock.sendMessage(responseJid, { text: `❌ Kupon *${code}* sudah kedaluwarsa.` });
      return;
    }
    // Validasi: cek max uses
    if (coupon.max_uses > 0 && coupon.used_count >= coupon.max_uses) {
      await sock.sendMessage(responseJid, { text: `❌ Kupon *${code}* sudah mencapai batas pemakaian.` });
      return;
    }
    // Cek ada order CART aktif
    const lastOrder = await db.getCustomerLastOrder(senderNumber);
    if (!lastOrder || lastOrder.status !== 'CART') {
      await sock.sendMessage(responseJid, { text: `⚠️ Anda belum memiliki keranjang belanja aktif.\nSilakan tambah produk terlebih dahulu dengan *beli [KODE] [JUMLAH]*.` });
      return;
    }
    if (lastOrder.coupon_code) {
      await sock.sendMessage(responseJid, { text: `Kupon *${lastOrder.coupon_code}* sudah diterapkan pada keranjang ini.` });
      return;
    }
    // Validasi: min order
    if (coupon.min_order > 0 && lastOrder.total < coupon.min_order) {
      await sock.sendMessage(responseJid, { text: `⚠️ Minimal belanja untuk kupon ini adalah *Rp${coupon.min_order.toLocaleString('id-ID')}*. Total belanja Anda saat ini: Rp${lastOrder.total.toLocaleString('id-ID')}.` });
      return;
    }
    // Hitung diskon
    let discount = 0;
    if (coupon.type === 'percent') {
      discount = Math.floor(lastOrder.total * coupon.value / 100);
    } else {
      discount = coupon.value;
    }
    if (discount > lastOrder.total) discount = lastOrder.total;
    
    await db.applyCouponToOrder(lastOrder.order_id, code, discount);
    const discountLabel = coupon.type === 'percent' ? `${coupon.value}%` : `Rp${coupon.value.toLocaleString('id-ID')}`;
    await sock.sendMessage(responseJid, { text: `✅ *Kupon ${code} berhasil diterapkan!*\n\n🏷️ Diskon: ${discountLabel}\n💰 Potongan: *-Rp${discount.toLocaleString('id-ID')}*\n🧾 Total setelah diskon: *Rp${(lastOrder.total - discount).toLocaleString('id-ID')}*\n\nKetik *checkout* untuk melanjutkan pembayaran.` });
    await sendRedirectNotice();
    return;
  }

  // 12. REFERRAL (Ajak 3 Teman = Kupon Diskon 10%)
  const refUseRegex = /^(?:referral|ref)\s+(REF-[\w]+)$/i;
  if (refUseRegex.test(text)) {
    const targetCode = text.match(refUseRegex)[1].toUpperCase();
    const referrer = await db.getReferralByCode(targetCode);
    if (!referrer) {
      await sock.sendMessage(responseJid, { text: `❌ Kode referral *${targetCode}* tidak ditemukan.` });
      return;
    }
    if (referrer.nomor === senderNumber) {
      await sock.sendMessage(responseJid, { text: `⚠️ Anda tidak dapat menggunakan kode referral sendiri.` });
      return;
    }
    const res = await db.addReferral(referrer.nomor, senderNumber);
    if (res.success) {
      await sock.sendMessage(responseJid, { text: `🎉 *Berhasil!* Anda mendaftar melalui referral *${referrer.nama || 'Pelanggan'}* (\`${targetCode}\`). Terima kasih!` });
    } else {
      await sock.sendMessage(responseJid, { text: `⚠️ Anda sudah pernah menggunakan kode referral sebelumnya.` });
    }
    return;
  }

  if (textLower === 'referral' || textLower === 'ref') {
    const refCode = await db.generateReferralCode(senderNumber);
    const stats = await db.getReferralStats(senderNumber);
    const total = stats.totalReferred;
    const claimed = stats.rewardsClaimed;
    const eligibleRewards = Math.floor(total / 3);
    const unclaimed = eligibleRewards - claimed;

    let rewardStatusMsg = "";
    if (unclaimed > 0) {
      const newCouponCode = 'REF10-' + Math.random().toString(36).substring(2, 7).toUpperCase();
      await db.addCoupon(newCouponCode, 'percent', 10, 0, 1, null);
      await db.claimReferralRewardCount(senderNumber, unclaimed);
      rewardStatusMsg = `🎉 *SELAMAT! Anda telah mengundang ${total} teman!*\n\n🏷️ *KUPON DISKON 10% ANDA:* \`${newCouponCode}\`\n💡 _Gunakan dengan mengetik:_ \`kupon ${newCouponCode}\` _saat checkout!_\n\n`;
    } else {
      const progress = total % 3;
      const needed = 3 - progress;
      rewardStatusMsg = `📊 Progres Hadiah: *${progress}/3 teman diajak*\n💡 Ajak *${needed} teman lagi* untuk mendapatkan Kupon Diskon 10%!\n\n`;
    }

    const refMsg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎁 *PROGRAM REFERRAL*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Kode Referral Anda: *${refCode}*

${rewardStatusMsg}📋 *Detail Statistik:*
• Total Teman Diajak: *${total}*
• Kupon Diskon Diklaim: *${claimed + (unclaimed > 0 ? unclaimed : 0)}x Kupon 10%*

💡 *Cara Menggunakan:*
Ajak teman Anda untuk mengetik \`ref ${refCode}\` di chat ini. Setiap 3 teman yang diajak, Anda berhak mendapatkan 1 Kupon Diskon 10%!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    await sock.sendMessage(responseJid, { text: refMsg });
    return;
  }

  // 15. BUNDLE / PAKET
  if (textLower === 'bundle' || textLower === 'paket') {
    const bundles = await db.getActiveBundles();
    if (bundles.length === 0) {
      await sock.sendMessage(responseJid, { text: "📦 Saat ini belum ada paket bundling yang tersedia." });
      return;
    }
    let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📦 *PAKET BUNDLING HEMAT*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    for (const b of bundles) {
      const items = b.produk_list.map(p => `${p.kode} x${p.qty}`).join(', ');
      msg += `🎁 *${b.nama}*\n   Isi: ${items}\n   Harga Paket: *Rp${b.harga_bundle.toLocaleString('id-ID')}*\n\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n_Hubungi admin untuk memesan paket bundling._`;
    await sock.sendMessage(responseJid, { text: msg });
    return;
  }

  // 16. SIMPAN / ADD TO WISHLIST
  const simpanRegex = /^simpan\s+(\w+)$/i;
  if (simpanRegex.test(text)) {
    const code = text.match(simpanRegex)[1].toUpperCase();
    const p = await db.getProductByKode(code);
    if (!p) {
      await sock.sendMessage(responseJid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
      return;
    }
    await db.addToWishlist(senderNumber, code);
    await sock.sendMessage(responseJid, { text: `💝 Produk *${p.nama}* (\`${code}\`) berhasil ditambahkan ke wishlist Anda!\nKetik *favorit* untuk melihat daftar wishlist.` });
    return;
  }

  // 17. FAVORIT / WISHLIST
  if (textLower === 'favorit' || textLower === 'wishlist') {
    const items = await db.getWishlist(senderNumber);
    if (items.length === 0) {
      await sock.sendMessage(responseJid, { text: "💝 Wishlist Anda masih kosong.\nKetik *simpan [KODE]* untuk menambahkan produk favorit." });
      return;
    }
    let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💝 *WISHLIST / FAVORIT ANDA*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    for (const item of items) {
      const stockLabel = item.stok === 0 ? '🔴 Habis' : `🟢 ${item.stok} pcs`;
      msg += `📌 *${item.nama}* (\`${item.produk_kode}\`)\n   Harga: *Rp${item.harga.toLocaleString('id-ID')}* | Stok: ${stockLabel}\n\n`;
    }
    msg += `Ketik *beli [KODE] [JUMLAH]* untuk memesan.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    await sock.sendMessage(responseJid, { text: msg });
    return;
  }

  // 19. SALDO PELANGGAN (.saldo)
  if (textLower === 'saldo' || textLower === '.saldo') {
    const bal = await db.getCustomerBalance(senderNumber);
    const msg = `💳 *SALDO DEPOSIT ANDA* 💳

👤 Pengguna: *${m.pushName || 'Pelanggan'}*
💰 Sisa Saldo: *Rp${bal.toLocaleString('id-ID')}*

💡 *Fungsi Saldo:*
Saldo dapat digunakan untuk membeli produk secara instan tanpa perlu melakukan scan QRIS setiap kali belanja!

_Ketik \`.deposit [NOMINAL]\` untuk melakukan Top Up Saldo._`;
    await sock.sendMessage(responseJid, { text: msg });
    return;
  }

  // 20. DEPOSIT TOPUP SALDO (.deposit [NOMINAL])
  const depositMatch = text.match(/^[\.\/]?deposit\s+(\d+)$/i);
  if (depositMatch) {
    const amount = parseInt(depositMatch[1]);
    if (amount < 5000) {
      await sock.sendMessage(responseJid, { text: "⚠️ *Nominal Minimal Deposit:* Rp5.000" });
      return;
    }
    try {
      // Build a deposit order object compatible with createMidtransTransaction
      const depositOrderId = `DEP-${Date.now()}`;
      const depositOrder = {
        order_id: depositOrderId,
        total: amount,
        customer_nomor: senderNumber,
        customer_nama: m.pushName || 'Pelanggan',
      };
      const qrisRes = await createMidtransTransaction(depositOrder);
      if (qrisRes && qrisRes.redirect_url) {
        let qrisMsg = `💳 *TOP UP SALDO DEPOSIT* 💳\n\n📌 Nominal Deposit: *Rp${amount.toLocaleString('id-ID')}*\n👤 Pelanggan: *${m.pushName || 'Pelanggan'}*\n\nSilakan lakukan pembayaran melalui link berikut:\n🔗 ${qrisRes.redirect_url}\n\n_Setelah pembayaran berhasil, saldo akan otomatis bertambah ke akun Anda!_`;
        await sock.sendMessage(responseJid, { text: qrisMsg });
      } else {
        await sock.sendMessage(responseJid, { text: `❌ Gagal membuat link pembayaran deposit. Pastikan Midtrans sudah dikonfigurasi di pengaturan toko.` });
      }
    } catch (depErr) {
      console.error('[DEPOSIT_ERR]', depErr.message);
      await sock.sendMessage(responseJid, { text: `❌ Gagal membuat QRIS Top Up. Hubungi admin untuk bantuan.` });
    }
    return;
  }

  // 21. REVIEW / ULASAN PRODUK (.review [ORDER_ID] [RATING 1-5] [ULASAN])
  const reviewMatch = text.match(/^[\.\/]?review\s+(\S+)\s+([1-5])\s+(.+)$/i);
  if (reviewMatch) {
    const orderId = reviewMatch[1]; // Bug Fix: Order ID adalah string (ORD-xxx), bukan integer
    const rating = parseInt(reviewMatch[2]);
    const comment = reviewMatch[3].trim();

    const orderObj = await db.getOrderById(orderId);
    if (!orderObj || orderObj.customer_nomor !== senderNumber) {
      await sock.sendMessage(responseJid, { text: `❌ Transaksi #${orderId} tidak ditemukan pada akun Anda.` });
      return;
    }
    await db.addReview(orderId, senderNumber, rating, comment);
    const stars = '⭐'.repeat(rating);
    await sock.sendMessage(responseJid, { text: `🎉 *Terima Kasih Atas Ulasan Anda!*\n\nRating: ${stars} (${rating}/5)\nUlasan: "${comment}"` });
    return;
  }

  // 22. PETUNJUK PENGGUNAAN PRODUK (.carapake [KODE] / .petunjuk [KODE])
  if (['carapake', 'petunjuk', 'tutor', 'cara'].includes(cleanCmd)) {
    const pKode = args[1]?.toUpperCase();
    if (!pKode) {
      await sock.sendMessage(responseJid, { text: "⚠️ Format salah. Gunakan: `.carapake <KODE_PRODUK>`\nContoh: `.carapake APM01`" });
      return;
    }
    const product = await db.getProductByKode(pKode);
    if (!product) {
      await sock.sendMessage(responseJid, { text: `❌ Produk dengan kode *${pKode}* tidak ditemukan.` });
      return;
    }
    await sock.sendMessage(responseJid, { text: product.petunjuk });
    return;
  }

  // 23. RIWAYAT VOUCHER & KREDENSIAL DIGITAL PELANGGAN (.voucherku / .riwayat / .history / .myvouchers)
  if (['voucherku', 'myvouchers', 'riwayat', 'history', 'pesananku', 'myorders', 'akunku'].includes(cleanCmd)) {
    const history = await db.getCustomerVoucherHistory(senderNumber);

    if (!history || history.length === 0) {
      const emptyMsg = `ℹ️ Halo *${customerName}*, Anda belum memiliki riwayat pembelian produk digital yang selesai.

Ketik *.produk* untuk melihat daftar produk toko kami!`;
      await sock.sendMessage(responseJid, { text: emptyMsg });
      return;
    }

    let msg = `━━━━━━━━━━━━━━━━━━━━
🔑 *RIWAYAT VOUCHER & PRODUK DIGITAL*
━━━━━━━━━━━━━━━━━━━━
Halo *${customerName}*, berikut adalah daftar voucher / akun digital dari pesanan Anda sebelumnya:\n\n`;

    history.forEach((order, idx) => {
      const dateStr = new Date(order.created_at).toLocaleString('id-ID');
      msg += `📦 *[${idx + 1}] Order ID:* \`${order.order_id}\`
⏰ Waktu: ${dateStr}
💰 Total: Rp${order.total.toLocaleString('id-ID')}\n`;

      if (order.items && order.items.length > 0) {
        order.items.forEach(item => {
          msg += `   • *${item.produk_nama}* (\`${item.produk_kode}\`) x${item.qty}\n`;
        });
      }

      if (order.credentials && order.credentials.length > 0) {
        msg += `   🔑 *Kredensial / Voucher:* \n`;
        order.credentials.forEach((c, cIdx) => {
          msg += `      ${cIdx + 1}. \`${c.data_content}\`\n`;
        });
      } else {
        msg += `   ℹ️ *Item Manual / Diproses Admin*\n`;
      }
      msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    });

    msg += `💡 *Tips:* Ketik \`.carapake <KODE>\` jika Anda membutuhkan petunjuk penggunaan ulang produk (Contoh: \`.carapake APM01\`).`;

    if (isFromGroup) {
      const mentionJid = senderNumber.split('@')[0];
      await sock.sendMessage(jid, { 
        text: `🔐 *Keamanan Akun:* Halo @${mentionJid}, demi menjaga kerahasiaan password & voucher Anda, daftar riwayat voucher belanja telah kami kirimkan ke *Chat Pribadi (DM)* Anda. Silakan periksa pesan masuk dari bot!`,
        mentions: [senderNumber]
      });
      await sock.sendMessage(senderNumber, { text: msg });
    } else {
      await sock.sendMessage(jid, { text: msg });
    }
    return;
  }

  // 18. MENERIMA FOTO BUKTI TRANSFER (DISIMPAN SECARA BERTIKAT YYYY/MM)
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

  // FAQ OTOMATIS — cek kemiripan keyword sebelum balas 'tidak dikenal'
  if (!isFromGroup && !textLower.startsWith('/')) {
    const faqMatch = await db.findFaqMatch(text);
    if (faqMatch) {
      await sock.sendMessage(jid, { text: faqMatch.answer });
      return;
    }
  }

}

// ==========================================
// LOGIKA PESAN GRUP (ADMIN GROUP / GET JID)
// ==========================================
async function handleGroupMessage(jid, senderNumber, messageObj, text, isGroupAdminParam) {
  const isGroup = jid.endsWith('@g.us');
  const m = messageObj;
  const senderNormalized = senderNumber;
  const args = text.trim().split(/\s+/);
  const rawCmd = args[0].toLowerCase();
  const cleanCmd = rawCmd.replace(/^[./#]/, '');

  const adminStoreCommands = [
    'paid', 'done', 'cancel', 'flashsale', 'stats', 'broadcast', 'addcoupon', 
    'delcoupon', 'listcoupon', 'addfaq', 'delfaq', 'listfaq', 'laporan', 
    'restock', 'stock', 'price', 'out', 'ready', 'addproduct', 'takeover', 
    'release', 'setname', 'setowner', 'eval', 'exec', 'backup'
  ];

  const groupModerationCommands = [
    'add', 'kick', 'promote', 'demote', 'group', 'link', 'tagall', 'hidetag', 
    'everyone', 'admins', 'mode', 'setmode', 'botmode', 'antilink', 'welcome', 
    'autowelcomeswitch', 'setwelcome', 'setupdategroup'
  ];

  const banCommands = ['ban', 'unban', 'addmod', 'delmod', 'listmod', 'setownerid'];

  // Jika bukan perintah admin/moderasi, lewati agar ditangani handler lain
  if (!adminStoreCommands.includes(cleanCmd) && !groupModerationCommands.includes(cleanCmd) && !banCommands.includes(cleanCmd) && cleanCmd !== 'getjid' && cleanCmd !== 'owner') {
    return false;
  }

  if (cleanCmd === 'getjid') {
    await sock.sendMessage(jid, { 
      text: `ID Chat/Grup ini adalah:\n\`${jid}\`\n\nID Anda adalah:\n\`${senderNumber}\`\n\nSilakan salin ID di atas dan masukkan ke pengaturan Web Dashboard jika ini adalah Grup Transaksi atau Grup Log.` 
    });
    return true;
  }

  // /owner diperbolehkan di mana saja
  if (cleanCmd === 'owner') {
    const ownerJid = botSettings.ownerNumber || config.defaults.ownerNumber;
    const ownerNum = ownerJid.split('@')[0].replace(/[^0-9]/g, '');
    const ownerName = `Owner ${botSettings.botName || 'Akbar Store'}`;

    const vcard = `BEGIN:VCARD
VERSION:3.0
FN:${ownerName}
ORG:${botSettings.botName || 'Akbar Store'};
TEL;type=CELL;type=VOICE;waid=${ownerNum}:+${ownerNum}
END:VCARD`;

    try {
      await sock.sendMessage(jid, { 
        contacts: { 
          displayName: ownerName, 
          contacts: [{ vcard }] 
        } 
      });

      const infoMsg = `👑 *KONTAK PEMILIK (OWNER) TOKO* 👑

👤 Nama Toko: *${botSettings.botName || 'Akbar Store'}*
📞 WhatsApp: *+${ownerNum}*
🔗 Chat Langsung: https://wa.me/${ownerNum}

_Silakan simpan kontak kartu di atas jika ada kendala khusus atau pertanyaan kerjasama._`;

      await sock.sendMessage(jid, { text: infoMsg });
    } catch (err) {
      console.error("[OWNER_CMD_ERR]", err.message);
    }
    return true;
  }

  // Normalisasi nomor HP untuk verifikasi Owner & Admin yang 100% Presisi
  const cleanDigits = str => (str || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  const ownerPhoneNum = cleanDigits(botSettings.ownerNumber || config.defaults.ownerNumber);
  const storedOwnerJid = (botSettings.ownerJid || '').trim();
  const senderDigits = cleanDigits(senderNumber);
  const jidDigits = cleanDigits(jid);

  // Cek Moderator dari DB
  const isMod = await db.isModerator(senderNormalized);

  // Cek Owner: via m.key.fromMe, stored JID (handles @lid), phone digit match, atau JID DM match.
  // PENTING: exact match saja (bukan .includes()) — substring match membuka celah bypass,
  // contoh nomor "6283170183637000" akan lolos jika ownerPhoneNum "6283170183637" dicek dengan includes().
  const isOwner = !!m.key?.fromMe ||
                  !!(storedOwnerJid && senderNormalized === storedOwnerJid) ||
                  !!(ownerPhoneNum && senderDigits && ownerPhoneNum === senderDigits) ||
                  !!(!isGroup && ownerPhoneNum && jidDigits && ownerPhoneNum === jidDigits);


  const adminList = (botSettings.adminNumbers || config.defaults.adminNumbers || '').split(',').map(n => cleanDigits(n));
  const isAdminStore = isOwner || isMod || adminList.includes(senderDigits);
  const isAdminUser = isAdminStore || isGroupAdminParam;

  // Jika bukan Admin/Owner dan mencoba perintah khusus Admin, diam (kecuali setownerid)
  if (!isAdminUser && cleanCmd !== 'setownerid') {
    return true;
  }

  // 🔒 Guard Grup Admin ACC khusus untuk perintah transaksi toko
  if (adminStoreCommands.includes(cleanCmd)) {
    const adminGroupId = botSettings.adminGroupId || botSettings.transactionLogGroupId || "";
    if (adminGroupId && isGroup && jid !== adminGroupId) {
      // Diam / tidak merespons perintah admin yang salah tempat agar tidak spam grup
      return true;
    }
  }

    if (cleanCmd === 'stats') {
      if (!isOwner) {
        await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Pemilik (Owner) bot." });
        return true;
      }
      const stats = await db.getStats();
      const statsText = `📊 *STATISTIK TOKO DIGITAL*
      
• Total Jenis Produk: *${stats.products}*
• Total Pelanggan: *${stats.customers}*
• Total Pesanan Selesai: *${stats.completedOrders}*
• Total Omset Penjualan: *Rp${stats.totalRevenue.toLocaleString('id-ID')}*`;
      await sock.sendMessage(jid, { text: statsText });
      return true;
    }

    // .setupdategroup — Mengatur grup ini sebagai grup pengumuman (restock/price drop)
    if (cleanCmd === 'setupdategroup') {
      if (!isAdminUser) return true;
      if (!isGroup) {
        await sock.sendMessage(jid, { text: "❌ Perintah ini hanya bisa digunakan di dalam grup." });
        return true;
      }
      await db.updateSettings({ updateGroupId: jid });
      // Update config lokal di memori agar terbaca cepat
      botSettings.updateGroupId = jid; 
      await sock.sendMessage(jid, { 
        text: `✅ *Berhasil!* Grup ini (\`${jid}\`) telah ditetapkan sebagai grup untuk menerima notifikasi otomatis (Restock & Penurunan Harga).\n\nKetik \`.testupdate\` untuk uji coba kirim pesan tagall ke grup ini.` 
      });
      return true;
    }

    // .testupdate — Mengirimkan pesan uji coba tagall ke grup update
    if (cleanCmd === 'testupdate') {
      if (!isAdminUser) return true;
      const targetGroup = botSettings.updateGroupId || (isGroup ? jid : null);
      if (!targetGroup) {
        await sock.sendMessage(jid, { text: `⚠️ Belum ada grup update yang diset. Jalankan \`.setupdategroup\` di grup pilihanmu terlebih dahulu.` });
        return true;
      }
      const testMsg = `📣 *TEST NOTIFIKASI RESTOCK & HARGA TOKO* 📣\n\nHalo member! Ini adalah pesan uji coba sistem notifikasi otomatis toko.\n\n_Jika Anda menerima notifikasi ini dengan tag, berarti sistem bekerja dengan baik!_`;
      const success = await broadcastTagAll(sock, targetGroup, testMsg);
      if (success) {
        await sock.sendMessage(jid, { text: `✅ Berhasil mengirimkan pesan tagall uji coba ke grup \`${targetGroup}\`!` });
      } else {
        await sock.sendMessage(jid, { text: `❌ Gagal mengirimkan pesan tagall ke grup \`${targetGroup}\`. Pastikan bot adalah anggota/admin di grup tersebut.` });
      }
      return true;
    }

    // ===================================================================
    // BAN SYSTEM — Owner-only by default, atau Moderator yang didaftarkan
    // ===================================================================

    // .setownerid — Owner mendaftarkan JID aktifnya (handles @lid, HANYA dari DM)
    if (cleanCmd === 'setownerid') {
      if (isGroup) {
        await sock.sendMessage(jid, { text: `⚠️ Perintah ini hanya bisa dipakai di *DM* (chat privat ke bot), bukan di grup.` });
        return true;
      }
      
      // Jika ownerJid sudah ada, dan pengirim bukan owner & bukan dari nomor bot sendiri
      if (storedOwnerJid && !isOwner && !m.key?.fromMe) {
        await sock.sendMessage(jid, { text: `❌ Anda tidak memiliki izin untuk mengubah Owner JID.` });
        return true;
      }

      await db.updateSettings({ ownerJid: senderNormalized });
      botSettings = await db.getSettings();
      await sock.sendMessage(jid, { text: `✅ *Owner JID Berhasil Didaftarkan!*

🆔 JID Tersimpan: \`${senderNormalized}\`

Sekarang Anda akan dikenali sebagai Owner di semua grup meskipun menggunakan sistem @lid WhatsApp terbaru. 🎉` });
      return true;
    }

    // .ban / .unban — Owner atau Moderator terdaftar
    if (cleanCmd === 'ban' || cleanCmd === 'unban') {
      const isMod = await db.isModerator(senderNormalized);
      if (!isOwner && !isMod) {
        return true; // Silent — bukan owner atau mod
      }

      // Cari target JID dari mention, quote, atau angka manual
      let targetJid = '';
      const mentionedList = m.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      const quotedParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
      if (mentionedList?.length > 0) {
        targetJid = mentionedList[0];
      } else if (quotedParticipant) {
        targetJid = quotedParticipant;
      } else if (args[1]) {
        const numOnly = args[1].replace(/[^0-9]/g, '');
        if (numOnly) targetJid = numOnly + '@s.whatsapp.net';
      }

      if (!targetJid) {
        await sock.sendMessage(jid, { text: `⚠️ Gunakan: \`.${cleanCmd} @user\`, reply pesan usernya, atau \`.${cleanCmd} 628xxx\`` });
        return true;
      }

      // Proteksi: tidak bisa ban Owner atau Moderator lain
      const targetDigitsCheck = cleanDigits(targetJid);
      const isTargetOwner = (storedOwnerJid && targetJid === storedOwnerJid) || (ownerPhoneNum && targetDigitsCheck === ownerPhoneNum);
      const isTargetMod = await db.isModerator(targetJid);

      if (cleanCmd === 'ban' && (isTargetOwner || isTargetMod)) {
        await sock.sendMessage(jid, { text: `❌ Tidak bisa mem-ban Owner atau Moderator.` });
        return true;
      }

      if (cleanCmd === 'ban') {
        const reason = args.slice(2).join(' ') || 'Tanpa alasan.';
        await db.banUser(targetJid, reason, senderNormalized);
        await sock.sendMessage(jid, {
          text: `🚫 *USER DI-BAN*

👤 Target: @${targetJid.split('@')[0]}
📝 Alasan: ${reason}
🔨 Oleh: ${m.pushName || senderNormalized}

Bot tidak akan merespons pesan dari user ini.`,
          mentions: [targetJid]
        });
      } else {
        await db.unbanUser(targetJid);
        await sock.sendMessage(jid, {
          text: `✅ *USER DI-UNBAN*

👤 Target: @${targetJid.split('@')[0]}
✔️ Oleh: ${m.pushName || senderNormalized}

User ini sekarang bisa kembali berinteraksi dengan bot.`,
          mentions: [targetJid]
        });
      }
      return true;
    }

    // .addmod — Daftarkan Moderator (Owner only)
    if (cleanCmd === 'addmod') {
      if (!isOwner) return true;
      const mentionedJid = m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
                           m.message?.extendedTextMessage?.contextInfo?.participant || '';
      if (!mentionedJid) {
        await sock.sendMessage(jid, { text: `⚠️ Gunakan: \`.addmod @user\`` });
        return true;
      }
      await db.addModerator(mentionedJid, senderNormalized);
      await sock.sendMessage(jid, {
        text: `✅ @${mentionedJid.split('@')[0]} telah didaftarkan sebagai *Moderator Bot*.
Dia sekarang bisa menggunakan perintah \`.ban\` dan \`.unban\`.`,
        mentions: [mentionedJid]
      });
      return true;
    }

    // .delmod — Hapus Moderator (Owner only)
    if (cleanCmd === 'delmod') {
      if (!isOwner) return true;
      const mentionedJid = m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
                           m.message?.extendedTextMessage?.contextInfo?.participant || '';
      if (!mentionedJid) {
        await sock.sendMessage(jid, { text: `⚠️ Gunakan: \`.delmod @user\`` });
        return true;
      }
      await db.removeModerator(mentionedJid);
      await sock.sendMessage(jid, {
        text: `✅ @${mentionedJid.split('@')[0]} telah dihapus dari daftar Moderator Bot.`,
        mentions: [mentionedJid]
      });
      return true;
    }

    // .listmod — Lihat daftar Moderator (Owner only)
    if (cleanCmd === 'listmod') {
      if (!isOwner) return true;
      const mods = await db.listModerators();
      if (!mods || mods.length === 0) {
        await sock.sendMessage(jid, { text: `📋 *Daftar Moderator Bot*

Belum ada moderator yang terdaftar.
Gunakan \`.addmod @user\` untuk menambahkan.` });
      } else {
        const modList = mods.map((mod, i) => `${i+1}. \`${mod.jid}\`\n   📅 ${new Date(mod.created_at).toLocaleDateString('id-ID')}`).join('\n');
        await sock.sendMessage(jid, { text: `📋 *Daftar Moderator Bot* (${mods.length} orang)

${modList}

Moderataor dapat menggunakan \`.ban\` dan \`.unban\`.` });
      }
      return true;
    }

    // OWNER SUITE: Backup Database Instan via DM/Chat WA (.backup)
    if (cleanCmd === 'backup') {
      if (!isOwner) {
        await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Pemilik (Owner) bot." });
        return true;
      }
      await sock.sendMessage(jid, { text: "⏳ Sedang membuat file cadangan database SQLite..." });
      const backupFilePath = backupDatabase();
      if (backupFilePath && fs.existsSync(backupFilePath)) {
        const dbBuffer = fs.readFileSync(backupFilePath);
        await sock.sendMessage(jid, { 
          document: dbBuffer, 
          mimetype: 'application/x-sqlite3', 
          fileName: path.basename(backupFilePath), 
          caption: `💾 *BACKUP DATABASE BERHASIL!*\n\n📁 File: \`${path.basename(backupFilePath)}\`\n⏰ Waktu: ${new Date().toLocaleString('id-ID')}` 
        });
      } else {
        await sock.sendMessage(jid, { text: "❌ Gagal membuat backup database." });
      }
      return true;
    }

    // OWNER SUITE: Ubah Nama Toko / Bot (.setname)
    if (cleanCmd === 'setname') {
      if (!isOwner) {
        await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Pemilik (Owner) bot." });
        return true;
      }
      const newName = args.slice(1).join(' ');
      if (!newName) {
        await sock.sendMessage(jid, { text: "⚠️ Gunakan: `.setname [NAMA_TOKO_BARU]`" });
        return true;
      }
      await db.updateSettings({ storeName: newName, botName: newName });
      botSettings = await db.getSettings(); // Bug Fix: was getBotSettings (tidak ada)
      await sock.sendMessage(jid, { text: `✅ Nama Toko / Bot berhasil diperbarui menjadi: *${newName}*` });
      return true;
    }

    // OWNER SUITE: Ubah Nomor Owner Utama (.setowner)
    if (cleanCmd === 'setowner') {
      if (!isOwner) {
        await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Pemilik (Owner) bot." });
        return true;
      }
      let newNum = args[1]?.replace(/[^0-9]/g, '');
      if (!newNum) {
        await sock.sendMessage(jid, { text: "⚠️ Gunakan: `.setowner [NOMOR_WA]`\nContoh: `.setowner 628123456789`" });
        return true;
      }
      const newOwnerJid = `${newNum}@s.whatsapp.net`;
      await db.updateSettings({ ownerNumber: newOwnerJid });
      botSettings = await db.getSettings(); // Bug Fix: was getBotSettings (tidak ada)
      await sock.sendMessage(jid, { text: `✅ Nomor Owner utama berhasil diperbarui ke: *+${newNum}*` });
      return true;
    }
    if (['mode', 'setmode', 'botmode'].includes(cleanCmd)) {
      const isGroup = jid.endsWith('@g.us');
      if (!isGroup) {
        await sock.sendMessage(jid, { text: "⚠️ Perintah pengaturan mode grup hanya dapat dijalankan di dalam Grup WhatsApp!" });
        return true;
      }
      const newMode = args[1]?.toLowerCase();
      const currentSettings = await db.getGroupSettings(jid);
      
      if (!newMode) {
        const modeLabel = currentSettings.bot_mode === 'sales' ? '🛍️ MODE JUALAN (Respon Produk & Transaksi Toko Sahaja)' : '🌐 MODE ALL (Respon Seluruh Fitur, Media & Entertainment)';
        await sock.sendMessage(jid, { 
          text: `⚙️ *STATUS MODE BOT GRUP INI:*
          
Mode Saat Ini: *${modeLabel}*

💡 *Cara Mengubah Mode:*
• Ketik \`.mode jualan\` atau \`.mode sales\` (Khusus jualan & transaksi saja)
• Ketik \`.mode all\` atau \`.mode semua\` (Respon seluruh fitur & media)` 
        });
        return true;
      }

      if (!['sales', 'jualan', 'toko', 'all', 'semua', 'full'].includes(newMode)) {
        await sock.sendMessage(jid, { text: "⚠️ Mode tidak valid. Gunakan: `.mode jualan` atau `.mode all`" });
        return true;
      }

      const targetMode = ['sales', 'jualan', 'toko'].includes(newMode) ? 'sales' : 'all';
      await db.updateGroupSettings(jid, { bot_mode: targetMode });
      
      const successMsg = targetMode === 'sales' 
        ? "🛍️ *MODE JUALAN DIAKTIFKAN UNTUK GRUP INI!* 🛍️\n\nBot sekarang *HANYA AKAN MERESPONS* perintah produk, katalog, transaksi, dan stok toko di grup ini. Perintah media/downloader/game/hiburan diabaikan agar grup tetap tertib khusus jualan." 
        : "🌐 *MODE ALL DIAKTIFKAN UNTUK GRUP INI!* 🌐\n\nBot sekarang merespons seluruh fitur (Jualan, Transaksi, Media, Downloader, Game, dan AI) di grup ini.";

      await sock.sendMessage(jid, { text: successMsg });
      return true;
    }

    // MODERASI GRUP: Sakelar Proteksi Anti-Link (.antilink)
    if (cleanCmd === 'antilink') {
      const param = args[1]?.toLowerCase();
      if (!['on', 'off', '1', '0', 'aktif', 'matikan'].includes(param)) {
        await sock.sendMessage(jid, { text: "⚠️ Gunakan: `.antilink on` atau `.antilink off`" });
        return true;
      }
      const isEnable = ['on', '1', 'aktif'].includes(param);
      await db.updateGroupSettings(jid, { anti_link: isEnable ? 1 : 0 });
      await sock.sendMessage(jid, { text: `🛡️ Proteksi Anti-Link Grup berhasil *${isEnable ? 'DIAKTIFKAN 🟢' : 'DINONAKTIFKAN 🔴'}* di grup ini!` });
      return true;
    }

    // MODERASI GRUP: Sakelar Auto-Welcome Member Baru (.welcome, .autowelcomeswitch)
    if (['welcome', 'autowelcomeswitch'].includes(cleanCmd)) {
      const param = args[1]?.toLowerCase();
      if (!['on', 'off', '1', '0', 'aktif', 'matikan'].includes(param)) {
        await sock.sendMessage(jid, { text: "⚠️ Gunakan: `.welcome on` atau `.welcome off`" });
        return true;
      }
      const isEnable = ['on', '1', 'aktif'].includes(param);
      await db.updateGroupSettings(jid, { welcome_enabled: isEnable ? 1 : 0 });
      await sock.sendMessage(jid, { text: `👋 Ucapan Auto-Welcome Member Baru berhasil *${isEnable ? 'DIAKTIFKAN 🟢' : 'DINONAKTIFKAN 🔴'}* di grup ini!` });
      return true;
    }

    // MODERASI GRUP: Kustomisasi Pesan Auto-Welcome (.setwelcome)
    if (cleanCmd === 'setwelcome') {
      const welcomeMsg = args.slice(1).join(' ');
      if (!welcomeMsg) {
        await sock.sendMessage(jid, { text: "⚠️ Gunakan: `.setwelcome [TEKS_UCAPAN]`" });
        return true;
      }
      await db.updateGroupSettings(jid, { welcome_msg: welcomeMsg, welcome_enabled: 1 });
      await sock.sendMessage(jid, { text: `✅ Teks Auto-Welcome grup berhasil diperbarui!` });
      return true;
    }

    // OWNER SUITE: Evaluasi Kode JavaScript Direct (.eval)
    if (cleanCmd === 'eval') {
      if (!isOwner) {
        await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Pemilik (Owner) bot." });
        return true;
      }
      const code = args.slice(1).join(' ');
      if (!code) {
        await sock.sendMessage(jid, { text: "⚠️ Gunakan: `.eval [KODE_JAVASCRIPT]`" });
        return true;
      }
      try {
        let result = eval(code);
        if (typeof result !== 'string') {
          result = await import('util').then(u => u.inspect(result));
        }
        await sock.sendMessage(jid, { text: `💻 *EVAL RESULT:*\n\`\`\`javascript\n${result}\n\`\`\`` });
      } catch (err) {
        await sock.sendMessage(jid, { text: `❌ *EVAL ERROR:*\n\`\`\`\n${err.message}\n\`\`\`` });
      }
      return true;
    }

    // OWNER SUITE: Eksekusi Terminal Shell Direct (.exec)
    if (cleanCmd === 'exec') {
      if (!isOwner) {
        await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Pemilik (Owner) bot." });
        return true;
      }
      const execCmd = args.slice(1).join(' ');
      if (!execCmd) {
        await sock.sendMessage(jid, { text: "⚠️ Gunakan: `.exec [PERINTAH_TERMINAL]`" });
        return true;
      }
      exec(execCmd, (err, stdout, stderr) => {
        if (err) {
          sock.sendMessage(jid, { text: `❌ *EXEC ERROR:*\n\`\`\`\n${err.message}\n\`\`\`` });
          return;
        }
        if (stderr) {
          sock.sendMessage(jid, { text: `⚠️ *EXEC STDERR:*\n\`\`\`\n${stderr}\n\`\`\`` });
          return;
        }
        sock.sendMessage(jid, { text: `💻 *EXEC STDOUT:*\n\`\`\`\n${stdout || 'Done (no output)'}\n\`\`\`` });
      });
      return true;
    }

    // PERINTAH ADMIN: .flashsale <KODE_PRODUK> <HARGA_FLASH> <DURASI_JAM>
    if (cleanCmd === 'flashsale') {
      const pKode = args[1]?.toUpperCase();
      const hFlash = parseInt(args[2]);
      const dur = parseInt(args[3]) || 2;

      if (!pKode || isNaN(hFlash)) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Gunakan `.flashsale <KODE_PRODUK> <HARGA_FLASH> [DURASI_JAM]`\n\n_Contoh:_ `.flashsale NET01 15000 2`" });
        return true;
      }

      const p = await db.getProductByKode(pKode);
      if (!p) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${pKode}* tidak ditemukan.` });
        return true;
      }

      const endTime = await db.setFlashSale(pKode, hFlash, dur);
      const endStr = new Date(endTime).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

      await sock.sendMessage(jid, { 
        text: `⚡ *FLASH SALE BERHASIL DIAKTIFKAN!* ⚡

📦 Produk: *${p.nama}* (\`${pKode}\`)
💰 Harga Asli: ~Rp${p.harga.toLocaleString('id-ID')}~
🔥 Harga Flash Sale: *Rp${hFlash.toLocaleString('id-ID')}*
⏱️ Berlaku Hingga: *${endStr} WIB* (${dur} Jam)` 
      });
      return true;
    }

    if (cleanCmd === 'broadcast') {
      if (!isOwner) {
        await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Pemilik (Owner) bot." });
        return true;
      }
      const broadcastMsg = args.slice(1).join(' ');
      if (!broadcastMsg) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.broadcast [PESAN]`" });
        return true;
      }
      
      const delayVal = botSettings.broadcastDelay || config.defaults.broadcastDelay;
      
      let targetGroupJids = [];
      if (botSettings.buyerGroupId) {
        targetGroupJids.push(botSettings.buyerGroupId);
      } else {
        try {
          const groups = await sock.groupFetchAllParticipating();
          targetGroupJids = Object.keys(groups);
        } catch (e) {
          console.error("Gagal mengambil daftar grup:", e.message);
        }
      }

      if (targetGroupJids.length === 0) {
        await sock.sendMessage(jid, { text: "⚠️ Bot belum dikonfigurasi ID Grup atau belum bergabung di grup manapun untuk siaran broadcast." });
        return true;
      }

      await sock.sendMessage(jid, { text: `📢 Memulai broadcast ke *${targetGroupJids.length}* Grup WhatsApp...` });
      
      let success = 0;
      for (const gJid of targetGroupJids) {
        if (botState.whatsappConnected && sock) {
          try {
            await sock.sendMessage(gJid, { text: `📢 *PENGUMUMAN RESMI TOKO:*\n\n${broadcastMsg}` });
            success++;
            
            const randomDelay = Math.floor(Math.random() * 2000) + delayVal;
            await new Promise(resolve => setTimeout(resolve, randomDelay)); 
          } catch (err) {
            console.error(`Gagal kirim broadcast grup ke ${gJid}:`, err.message);
          }
        } else {
          break;
        }
      }
      await sock.sendMessage(jid, { text: `✅ *Broadcast selesai!*\nBerhasil dikirim ke *${success}/${targetGroupJids.length}* Grup WhatsApp.` });
      await logToSystem('BROADCAST', `📢 Siaran pesan selesai dikirim ke ${success}/${targetGroupJids.length} Grup WhatsApp oleh Owner.`);
      return true;
    }

    // ==========================================
    // PERINTAH MODERASI GRUP & BOT MANAGEMENT (v2)
    // ==========================================
    if (isGroup && ['add', 'kick', 'promote', 'demote'].includes(cleanCmd)) {
      const targetJid = extractTargetJid(m, args);
      if (!targetJid) {
        await sock.sendMessage(jid, { text: `⚠️ Format salah. Tag user atau masukkan nomor. Contoh: \`.${cleanCmd} @user\` atau \`.${cleanCmd} 628123456789\`` });
        return true;
      }

      try {
        const actionMap = { 'add': 'add', 'kick': 'remove', 'promote': 'promote', 'demote': 'demote' };
        const actNameMap = { 'add': 'ditambahkan', 'kick': 'dikeluarkan', 'promote': 'diangkat jadi admin', 'demote': 'diturunkan dari admin' };
        
        await sock.groupParticipantsUpdate(jid, [targetJid], actionMap[cleanCmd]);
        await sock.sendMessage(jid, { text: `✅ Berhasil! Pengguna @${targetJid.split('@')[0]} telah ${actNameMap[cleanCmd]}.`, mentions: [targetJid] });
        await db.addLog("MODERATION", `Admin (${senderNormalized}) menjalankan ${cleanCmd} pada ${targetJid} di grup ${jid}`);
      } catch (err) {
        await sock.sendMessage(jid, { 
          text: `❌ Gagal menjalankan ${cleanCmd}: ${err.message}.\n\n💡 *PENTING:* Pastikan **nomor WhatsApp Bot sudah dijadikan ADMIN GRUP** di WhatsApp agar fitur moderasi (${cleanCmd}) dapat mengeksekusi tindakan.` 
        });
      }
      return true;
    }

    if (isGroup && cleanCmd === 'group') {
      const option = args[1]?.toLowerCase();
      if (option !== 'open' && option !== 'close') {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.group open` (semua anggota) atau `.group close` (hanya admin)." });
        return true;
      }

      try {
        await sock.groupSettingUpdate(jid, option === 'open' ? 'not_announcement' : 'announcement');
        await sock.sendMessage(jid, { text: option === 'open' ? "🔓 Grup telah DIBUKA! Semua anggota sekarang dapat mengirim pesan." : "🔒 Grup telah DITUTUP! Hanya Admin yang dapat mengirim pesan." });
        await db.addLog("MODERATION", `Admin (${senderNormalized}) mengubah status grup ${jid} ke ${option}`);
      } catch (err) {
        await sock.sendMessage(jid, { text: `❌ Gagal mengubah status grup: ${err.message}. Pastikan bot adalah Admin di grup.` });
      }
      return true;
    }

    if (isGroup && cleanCmd === 'link') {
      try {
        const code = await sock.groupInviteCode(jid);
        await sock.sendMessage(jid, { text: `🔗 *LINK UNDANGAN GRUP*\nhttps://chat.whatsapp.com/${code}` });
      } catch (err) {
        await sock.sendMessage(jid, { text: `❌ Gagal mengambil link grup: ${err.message}. Pastikan bot adalah Admin.` });
      }
      return true;
    }

    if (isGroup && (cleanCmd === 'tagall' || cleanCmd === 'hidetag' || cleanCmd === 'everyone')) {
      try {
        const groupMeta = await sock.groupMetadata(jid);
        const participants = groupMeta.participants.map(p => p.id);
        const extraMsg = args.slice(1).join(' ');
        
        let tagMsg = `📢 *PENGUMUMAN GRUP (${groupMeta.subject})*\n${extraMsg ? extraMsg + '\n\n' : ''}`;
        participants.forEach((pId, idx) => {
          tagMsg += `${idx + 1}. @${pId.split('@')[0]}\n`;
        });

        await sock.sendMessage(jid, { text: tagMsg, mentions: participants });
      } catch (err) {
        await sock.sendMessage(jid, { text: `❌ Gagal tagall: ${err.message}` });
      }
      return true;
    }

    if (isGroup && cleanCmd === 'admins') {
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
      return true;
    }

    if (cleanCmd === 'restock') {
      const code = args[1]?.toUpperCase();
      if (!code) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.restock [KODE_PRODUK]`\nContoh: `.restock NET01`" });
        return true;
      }

      const p = await db.getProductByKode(code);
      if (!p) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
        return true;
      }

      await sock.sendMessage(jid, { text: `⏳ Memulai pengiriman siaran restok untuk *${p.nama}* (\`${code}\`)...` });
      triggerRestockBroadcast(code);
      return true;
    }

    // ==========================================
    // PERINTAH ADMIN & TRANSAKSI
    // ==========================================
    if (cleanCmd === 'takeover') {
      const targetNumber = args[1];
      if (!targetNumber) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.takeover [NOMOR]`\nContoh: `.takeover 6281234567890`" });
        return true;
      }
      const targetJid = targetNumber.includes('@') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
      await db.updateConversationState(targetJid, 'ADMIN');
      await sock.sendMessage(jid, { text: `✅ Chat dengan ${targetNumber} telah diambil alih. Bot tidak akan membalas otomatis pesannya.` });
      return true;
    }

    if (cleanCmd === 'release') {
      const targetNumber = args[1];
      if (!targetNumber) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.release [NOMOR]`\nContoh: `.release 6281234567890`" });
        return true;
      }
      const targetJid = targetNumber.includes('@') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
      await db.updateConversationState(targetJid, 'BOT');
      await sock.sendMessage(jid, { text: `✅ Chat dengan ${targetNumber} telah dikembalikan ke Bot. Bot akan membalas otomatis kembali.` });
      return true;
    }

// Helper universal mengekstrak Order ID baik diketik langsung maupun dari membalas/reply pesan
function extractOrderIdFromMessage(args, m) {
  if (args && args[1]) {
    return args[1].trim().toUpperCase();
  }

  const contextInfo = m?.message?.extendedTextMessage?.contextInfo || 
                      m?.message?.conversation?.contextInfo ||
                      m?.message?.imageMessage?.contextInfo ||
                      m?.message?.videoMessage?.contextInfo;

  if (contextInfo && contextInfo.quotedMessage) {
    const qMsg = contextInfo.quotedMessage;
    const quotedText = 
      qMsg.conversation ||
      qMsg.extendedTextMessage?.text ||
      qMsg.imageMessage?.caption ||
      qMsg.videoMessage?.caption ||
      qMsg.documentMessage?.caption ||
      '';

    if (quotedText) {
      const m1 = quotedText.match(/Order\s*ID\s*:\s*\*?([A-Za-z0-9_-]+)\*?/i);
      if (m1 && m1[1]) return m1[1].toUpperCase();

      const m2 = quotedText.match(/\b(ORD[-_]?[A-Za-z0-9]+)\b/i);
      if (m2 && m2[1]) return m2[1].toUpperCase();

      const m3 = quotedText.match(/(?:Order|ID|Pesanan|Struk)?\s*:?\s*#?([A-Za-z0-9]{3,20})\b/i);
      if (m3 && m3[1]) return m3[1].toUpperCase();
    }
  }

  return null;
}

    if (['paid', 'acc', 'terima', 'konfirmasi'].includes(cleanCmd)) {
      const orderId = extractOrderIdFromMessage(args, m);
      if (!orderId) {
        await sock.sendMessage(jid, { 
          text: "⚠️ *Gagal Deteksi Order ID:*\n\nSilakan **balas (reply)** pesan notifikasi pesanan dengan `.paid` atau `.acc`, atau ketik: `.paid <ORDER_ID>`" 
        });
        return true;
      }

      const res = await db.updateOrderStatus(orderId, 'PAID');
      if (!res.success) {
        await sock.sendMessage(jid, { text: `❌ Gagal: ${res.message}` });
        return true;
      }

      await sock.sendMessage(jid, { text: `✅ Order ID *${orderId}* berhasil diubah ke status *PAID*. Memproses pengiriman otomatis...` });
      
      // Notifikasi awal ke customer
      const notifCustomer = `🔔 *INFO PESANAN (Order: ${orderId})*
      
Pembayaran Anda telah *DITERIMA* dan diverifikasi oleh admin kami. Terima kasih!`;
      await sock.sendMessage(res.customerNomor, { text: notifCustomer });
      await logToSystem('PAYMENT', `💸 Order ID *${orderId}* dikonfirmasi PAID oleh admin (wa.me/${senderNumber.split('@')[0]})`);

      // ══════════════════════════════════════════════════════════
      // AUTO-DELIVERY: Local Stock
      // ══════════════════════════════════════════════════════════
      try {
        const deliveredData = await db.claimAndDeliverItems(orderId);
        const localKeys = Object.keys(deliveredData);

        if (localKeys.length > 0) {
          let credMsg = `━━━━━━━━━━━━━━━━━━\n📦 *PENGIRIMAN PRODUK DIGITAL*\n━━━━━━━━━━━━━━━━━━\nOrder ID: *${orderId}*\n\nBerikut adalah detail akun/voucher Anda:\n\n`;

          // Local stock items
          for (const [kode, info] of Object.entries(deliveredData)) {
            credMsg += `🔑 *${info.produk_nama}* (\`${kode}\`):\n`;
            if (info.credentials.length > 0) {
              info.credentials.forEach((cred, i) => { credMsg += `   ${i + 1}. ${cred}\n`; });
            } else {
              credMsg += `   ⚠️ Stok habis, admin akan mengirim secara manual.\n`;
            }
            if (info.petunjuk) credMsg += `\n${info.petunjuk}\n`;
            credMsg += `\n`;
          }

          credMsg += `━━━━━━━━━━━━━━━━━━\n⚠️ _Harap simpan data ini dengan baik. Jika ada masalah, silakan hubungi admin._\n━━━━━━━━━━━━━━━━━━`;
          await sock.sendMessage(res.customerNomor, { text: credMsg });

          // Cek apakah semua terkirim sempurna
          const localAllOk = localKeys.every(k => deliveredData[k].credentials.length > 0);

          if (localAllOk) {
            await db.updateOrderStatus(orderId, 'COMPLETED');
            await sock.sendMessage(res.customerNomor, { text: `✅ Pesanan *${orderId}* telah *SELESAI*. Terima kasih telah berbelanja! 🙏` });
            await sock.sendMessage(jid, { text: `✅ Order *${orderId}* otomatis *COMPLETED* — semua item berhasil dikirim ke pelanggan.` });
            await logToSystem('ORDER', `✅ Order *${orderId}* auto-completed (Local: ${localKeys.length}).`);
          } else {
            await sock.sendMessage(jid, { text: `⚠️ Order *${orderId}*: Stok habis untuk sebagian item. Silakan kirim sisa item secara manual.` });
          }
        } else {
          // Tidak ada item AUTO — semua MANUAL
          await sock.sendMessage(jid, { text: `ℹ️ Order *${orderId}* tidak memiliki item bertipe AUTO. Silakan kirimkan produk secara manual ke pelanggan, lalu ketik \`.done\` setelah selesai.` });
        }
      } catch (deliveryErr) {
        console.error(`[AUTO_DELIVERY] Gagal mengirim kredensial untuk ${orderId}:`, deliveryErr.message);
        await sock.sendMessage(jid, { text: `⚠️ Error saat auto-delivery untuk Order *${orderId}*: ${deliveryErr.message}. Silakan kirim kredensial secara manual.` });
      }
      return true;
    }

    if (['done', 'selesai'].includes(cleanCmd)) {
      const orderId = extractOrderIdFromMessage(args, m);
      if (!orderId) {
        await sock.sendMessage(jid, { 
          text: "⚠️ *Gagal Deteksi Order ID:*\n\nSilakan **balas (reply)** pesan notifikasi pesanan dengan `.done` atau `.selesai`, atau ketik: `.done <ORDER_ID>`" 
        });
        return true;
      }

      const res = await db.updateOrderStatus(orderId, 'COMPLETED');
      if (!res.success) {
        await sock.sendMessage(jid, { text: `❌ Gagal: ${res.message}` });
        return true;
      }

      await sock.sendMessage(jid, { text: `✅ Order ID *${orderId}* ditandai *COMPLETED*. Pelanggan telah dinotifikasi.` });

      const notifCustomer = `🔔 *INFO PESANAN (Order: ${orderId})*
      
Pesanan Anda telah *SELESAI* diproses / dikirimkan oleh admin!
Silakan cek akun/detail pesanan Anda. Jika ada kendala, hubungi admin. Terima kasih telah berbelanja! 🙏`;
      await sock.sendMessage(res.customerNomor, { text: notifCustomer });
      await logToSystem('ORDER', `✅ Order ID *${orderId}* ditandai COMPLETED oleh admin.`);
      return true;
    }

    if (['cancel', 'batal'].includes(cleanCmd)) {
      const orderId = extractOrderIdFromMessage(args, m);
      if (!orderId) {
        await sock.sendMessage(jid, { 
          text: "⚠️ *Gagal Deteksi Order ID:*\n\nSilakan **balas (reply)** pesan notifikasi pesanan dengan `.cancel` atau `.batal`, atau ketik: `.cancel <ORDER_ID>`" 
        });
        return true;
      }

      const res = await db.updateOrderStatus(orderId, 'CANCELLED');
      if (!res.success) {
        await sock.sendMessage(jid, { text: `❌ Gagal: ${res.message}` });
        return true;
      }

      await sock.sendMessage(jid, { text: `✅ Order ID *${orderId}* berhasil dibatalkan dan stok produk telah dikembalikan.` });

      const notifCustomer = `🔔 *INFO PESANAN (Order: ${orderId})*
      
Mohon maaf, pesanan Anda dengan Order ID *${orderId}* telah *DIBATALKAN* oleh admin. Jika Anda sudah melakukan pembayaran, silakan hubungi admin di chat ini untuk konfirmasi manual.`;
      await sock.sendMessage(res.customerNomor, { text: notifCustomer });
      await logToSystem('ORDER', `❌ Order ID *${orderId}* dibatalkan oleh admin.`);
      return true;
    }

    if (cleanCmd === 'stock') {
      const code = args[1]?.toUpperCase();
      const stock = parseInt(args[2]);

      if (!code || isNaN(stock)) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.stock [KODE] [STOK_BARU]`\nContoh: `.stock NET01 15`" });
        return true;
      }

      const p = await db.getProductByKode(code);
      if (!p) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
        return true;
      }

      await db.updateProductStock(code, stock);
      await sock.sendMessage(jid, { text: `📦 Stok *${p.nama}* (\`${code}\`) berhasil diperbarui menjadi *${stock}* pcs.` });
      await logToSystem('SYSTEM', `📦 Stok produk *${code}* diperbarui menjadi *${stock}* oleh admin.`);
      
      // Picu notifikasi stok ready jika stok baru > 0
      await checkAndNotifySubscribers(code, stock);
      return true;
    }

    if (cleanCmd === 'price') {
      const code = args[1]?.toUpperCase();
      const price = parseInt(args[2]);

      if (!code || isNaN(price)) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.price [KODE] [HARGA_BARU]`\nContoh: `.price NET01 50000`" });
        return true;
      }

      const p = await db.getProductByKode(code);
      if (!p) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
        return true;
      }

      await db.updateProductPrice(code, price);
      await sock.sendMessage(jid, { text: `💸 Harga *${p.nama}* (\`${code}\`) berhasil diperbarui menjadi *Rp${price.toLocaleString('id-ID')}*.` });
      await logToSystem('SYSTEM', `💸 Harga produk *${code}* diperbarui menjadi Rp${price} oleh admin.`);
      return true;
    }

    if (cleanCmd === 'out') {
      const code = args[1]?.toUpperCase();
      if (!code) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.out [KODE]`" });
        return true;
      }

      const p = await db.getProductByKode(code);
      if (!p) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
        return true;
      }

      await db.updateProductStock(code, 0);
      await sock.sendMessage(jid, { text: `🔴 Produk *${p.nama}* (\`${code}\`) ditandai sebagai *Habis* (stok diset ke 0).` });
      await logToSystem('SYSTEM', `🔴 Produk *${code}* diset habis oleh admin.`);
      return true;
    }

    if (cleanCmd === 'ready') {
      const code = args[1]?.toUpperCase();
      if (!code) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.ready [KODE]`" });
        return true;
      }

      const p = await db.getProductByKode(code);
      if (!p) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
        return true;
      }

      await db.updateProductStock(code, 10);
      await sock.sendMessage(jid, { text: `🟢 Produk *${p.nama}* (\`${code}\`) ditandai *Ready* kembali dengan isi stok standar (10 pcs).` });
      await logToSystem('SYSTEM', `🟢 Produk *${code}* diset ready (stok 10) oleh admin.`);
      
      // Picu notifikasi stok ready jika stok baru > 0
      await checkAndNotifySubscribers(code, 10);
      return true;
    }

    if (cleanCmd === 'addproduct') {
      const rawArgs = args.slice(1).join(' ');
      const parts = rawArgs.split('|').map(p => p.trim());
      
      if (parts.length < 5) {
        const errorHelp = `⚠️ Format salah. Gunakan pemisah vertikal (\`|\`):\n\`.addproduct [KODE] | [NAMA_PRODUK] | [HARGA] | [STOK] | [DESKRIPSI]\`\n\n_Contoh:_\n\`.addproduct NET02 | Netflix 2 Bulan | 85000 | 5 | Sharing 1 Profil\``;
        await sock.sendMessage(jid, { text: errorHelp });
        return true;
      }

      const codePart = parts[0].split(' ');
      const code = codePart[0].toUpperCase();
      
      const nama = parts[1];
      const harga = parseInt(parts[2]);
      const stok = parseInt(parts[3]);
      const deskripsi = parts[4];

      if (isNaN(harga) || isNaN(stok)) {
        await sock.sendMessage(jid, { text: "❌ Gagal. Harga dan Stok harus berupa angka/nominal." });
        return true;
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
      return true;
    }

    if (cleanCmd === 'addcoupon') {
      const rawArgs = args.slice(1).join(' ');
      const parts = rawArgs.split('|').map(p => p.trim());
      if (parts.length < 3) {
        await sock.sendMessage(jid, { text: `⚠️ Format: \`.addcoupon [KODE] | [TIPE: percent/fixed] | [NILAI] | [MIN_ORDER] | [MAX_PAKAI] | [EXPIRED: YYYY-MM-DD]\`\n\n_Contoh:_ \`.addcoupon DISKON10 | percent | 10 | 50000 | 100 | 2026-12-31\`` });
        return true;
      }
      const code = parts[0].toUpperCase();
      const type = parts[1].toLowerCase();
      const value = parseInt(parts[2]);
      const minOrder = parts[3] ? parseInt(parts[3]) : 0;
      const maxUses = parts[4] ? parseInt(parts[4]) : 0;
      const expiresAt = parts[5] || null;
      if (type !== 'percent' && type !== 'fixed') {
        await sock.sendMessage(jid, { text: "❌ Tipe kupon harus *percent* atau *fixed*." });
        return true;
      }
      if (isNaN(value)) {
        await sock.sendMessage(jid, { text: "❌ Nilai kupon harus berupa angka." });
        return true;
      }
      try {
        await db.addCoupon(code, type, value, minOrder, maxUses, expiresAt);
        await sock.sendMessage(jid, { text: `✅ Kupon *${code}* berhasil ditambahkan!\n• Tipe: ${type}\n• Nilai: ${type === 'percent' ? value + '%' : 'Rp' + value.toLocaleString('id-ID')}\n• Min. Order: Rp${minOrder.toLocaleString('id-ID')}\n• Max Pakai: ${maxUses || 'Unlimited'}` });
      } catch (err) {
        await sock.sendMessage(jid, { text: `❌ Gagal: ${err.message}` });
      }
      return true;
    }

    if (cleanCmd === 'delcoupon') {
      const code = args[1]?.toUpperCase();
      if (!code) {
        await sock.sendMessage(jid, { text: "⚠️ Format: \`.delcoupon [KODE]\`" });
        return true;
      }
      const deleted = await db.deleteCoupon(code);
      await sock.sendMessage(jid, { text: deleted ? `✅ Kupon *${code}* berhasil dihapus.` : `❌ Kupon *${code}* tidak ditemukan.` });
      return true;
    }

    if (cleanCmd === 'listcoupon') {
      const coupons = await db.getAllCoupons();
      if (coupons.length === 0) {
        await sock.sendMessage(jid, { text: "🏷️ Belum ada kupon yang terdaftar." });
        return true;
      }
      let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏷️ *DAFTAR KUPON*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      for (const c of coupons) {
        const valLabel = c.type === 'percent' ? `${c.value}%` : `Rp${c.value.toLocaleString('id-ID')}`;
        msg += `• *${c.code}* — ${valLabel} | Terpakai: ${c.used_count}/${c.max_uses || '∞'} | ${c.is_active ? '🟢 Aktif' : '🔴 Nonaktif'}\n`;
      }
      msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      await sock.sendMessage(jid, { text: msg });
      return true;
    }

    if (cleanCmd === 'addfaq') {
      const rawArgs = args.slice(1).join(' ');
      const parts = rawArgs.split('|').map(p => p.trim());
      if (parts.length < 2) {
        await sock.sendMessage(jid, { text: `⚠️ Format: \`.addfaq [KEYWORDS dipisah koma] | [JAWABAN]\`\n\n_Contoh:_ \`.addfaq jam buka,jam operasional | Toko kami buka 24 jam dengan layanan bot otomatis!\`` });
        return true;
      }
      const id = await db.addFaq(parts[0], parts[1]);
      await sock.sendMessage(jid, { text: `✅ FAQ #${id} berhasil ditambahkan!\n• Keywords: ${parts[0]}\n• Jawaban: ${parts[1]}` });
      return true;
    }

    if (cleanCmd === 'delfaq') {
      const id = parseInt(args[1]);
      if (isNaN(id)) {
        await sock.sendMessage(jid, { text: "⚠️ Format: \`.delfaq [ID]\`" });
        return true;
      }
      const deleted = await db.deleteFaq(id);
      await sock.sendMessage(jid, { text: deleted ? `✅ FAQ #${id} berhasil dihapus.` : `❌ FAQ #${id} tidak ditemukan.` });
      return true;
    }

    if (cleanCmd === 'listfaq') {
      const faqs = await db.getAllFaqs();
      if (faqs.length === 0) {
        await sock.sendMessage(jid, { text: "💬 Belum ada FAQ yang terdaftar." });
        return true;
      }
      let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💬 *DAFTAR FAQ*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      for (const f of faqs) {
        msg += `#${f.id} — Keywords: *${f.keywords}*\n   Jawaban: ${f.answer}\n\n`;
      }
      msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      await sock.sendMessage(jid, { text: msg });
      return true;
    }

    if (cleanCmd === 'laporan') {
      const period = args[1]?.toLowerCase() || 'harian';
      const today = new Date().toISOString().split('T')[0];
      const report = await db.getDailySalesReport(today);
      let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *LAPORAN PENJUALAN HARI INI*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📅 ${new Date().toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n\n`;
      msg += `📦 Pesanan Selesai: *${report.total_orders}*\n`;
      msg += `💰 Total Omzet: *Rp${report.total_revenue.toLocaleString('id-ID')}*\n\n`;
      if (report.topProducts.length > 0) {
        msg += `🏆 *Produk Terlaris:*\n`;
        report.topProducts.forEach((p, i) => {
          msg += `${i + 1}. ${p.nama} — ${p.total_qty} terjual\n`;
        });
        msg += `\n`;
      }
      if (report.lowStockProducts.length > 0) {
        msg += `🟡 *Stok Menipis:*\n`;
        report.lowStockProducts.forEach(p => {
          msg += `• ${p.nama} (\`${p.kode}\`) — Sisa: ${p.stok}\n`;
        });
        msg += `\n`;
      }
      if (report.outOfStockProducts.length > 0) {
        msg += `🔴 *Stok Habis:*\n`;
        report.outOfStockProducts.forEach(p => {
          msg += `• ${p.nama} (\`${p.kode}\`)\n`;
        });
      }
      msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      await sock.sendMessage(jid, { text: msg });
      return true;
    }
  return false;
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
