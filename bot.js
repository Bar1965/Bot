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
import { createCustomerHandler } from './src/handlers/customerHandler.js';
import { createGroupAdminHandler } from './src/handlers/groupAdminHandler.js';
import { handlePremiumCommand } from './premiumHandler.js';
import { handlePdfCommands, checkPdfMergeSession } from './src/handlers/pdfHandler.js';
import { buildCommandMenu } from './commandRegistry.js';
import { createWelcomeGoodbyeCard, createLevelUpCard } from './cardGenerator.js';




// Setup Logger
const logger = P({ level: 'info' });

let sock = null;
let botSettings = {};
const userPushNamesMap = new Map();

// Group Metadata Cache (TTL: 3 Menit)
const groupMetaCache = new Map();
const GROUP_META_TTL = 3 * 60 * 1000;

async function getCachedGroupMetadata(sockInstance, groupJid) {
  const cached = groupMetaCache.get(groupJid);
  if (cached && (Date.now() - cached.timestamp < GROUP_META_TTL)) {
    return cached.data;
  }
  try {
    const data = await sockInstance.groupMetadata(groupJid);
    groupMetaCache.set(groupJid, { data, timestamp: Date.now() });
    return data;
  } catch (e) {
    return cached?.data || null;
  }
}

// Helper parsing durasi waktu untuk ban sementara
export function parseDuration(argsList) {
  if (argsList.length === 0) {
    return { expiresAt: null, consumed: 0, durationText: 'Permanen' };
  }

  const firstArg = argsList[0].toLowerCase();
  
  // Kasus 1: Gabungan angka + huruf (misal: 1h, 30m, 2d, 10s)
  const combinedRegex = /^(\d+)([a-z]+)$/;
  const match = firstArg.match(combinedRegex);
  if (match) {
    const val = parseInt(match[1], 10);
    const unit = match[2];
    let ms = 0;
    let unitText = '';
    
    if (['s', 'detik', 'sec', 'second', 'seconds'].includes(unit)) {
      ms = val * 1000;
      unitText = 'detik';
    } else if (['m', 'menit', 'min', 'minute', 'minutes'].includes(unit)) {
      ms = val * 60 * 1000;
      unitText = 'menit';
    } else if (['h', 'jam', 'hr', 'hour', 'hours'].includes(unit)) {
      ms = val * 60 * 60 * 1000;
      unitText = 'jam';
    } else if (['d', 'hari', 'day', 'days'].includes(unit)) {
      ms = val * 24 * 60 * 60 * 1000;
      unitText = 'hari';
    }

    if (ms > 0) {
      return {
        expiresAt: Date.now() + ms,
        consumed: 1,
        durationText: `${val} ${unitText}`
      };
    }
  }

  // Kasus 2: Angka dipisah unit (misal: ["1", "jam"], ["30", "menit"])
  const numVal = parseInt(firstArg, 10);
  if (!isNaN(numVal) && argsList.length > 1) {
    const unit = argsList[1].toLowerCase();
    let ms = 0;
    let unitText = '';
    
    if (['s', 'detik', 'sec', 'second', 'seconds'].includes(unit)) {
      ms = numVal * 1000;
      unitText = 'detik';
    } else if (['m', 'menit', 'min', 'minute', 'minutes'].includes(unit)) {
      ms = numVal * 60 * 1000;
      unitText = 'menit';
    } else if (['h', 'jam', 'hr', 'hour', 'hours'].includes(unit)) {
      ms = numVal * 60 * 60 * 1000;
      unitText = 'jam';
    } else if (['d', 'hari', 'day', 'days'].includes(unit)) {
      ms = numVal * 24 * 60 * 60 * 1000;
      unitText = 'hari';
    }

    if (ms > 0) {
      return {
        expiresAt: Date.now() + ms,
        consumed: 2,
        durationText: `${numVal} ${unitText}`
      };
    }
  }

  if (['permanen', 'permanent', 'selamanya'].includes(firstArg)) {
    return {
      expiresAt: null,
      consumed: 1,
      durationText: 'Permanen'
    };
  }

  return { expiresAt: null, consumed: 0, durationText: 'Permanen' };
}

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
  let raw = '';

  // 1. Pesan teks langsung / caption media
  if (msg.conversation) raw = msg.conversation;
  else if (msg.extendedTextMessage?.text) raw = msg.extendedTextMessage.text;
  else if (msg.imageMessage?.caption) raw = msg.imageMessage.caption;
  else if (msg.videoMessage?.caption) raw = msg.videoMessage.caption;
  else if (msg.documentMessage?.caption) raw = msg.documentMessage.caption;

  // 2. Respons Tombol Standar / Quick Reply
  else if (msg.buttonsResponseMessage?.selectedButtonId) {
    raw = msg.buttonsResponseMessage.selectedButtonId;
  }
  else if (msg.buttonsResponseMessage?.selectedDisplayText) {
    raw = msg.buttonsResponseMessage.selectedDisplayText;
  }
  else if (msg.templateButtonReplyMessage?.selectedId) {
    raw = msg.templateButtonReplyMessage.selectedId;
  }

  // 3. Respons Dropdown List (Single Select)
  else if (msg.listResponseMessage?.singleSelectReply?.selectedRowId) {
    raw = msg.listResponseMessage.singleSelectReply.selectedRowId;
  }

  // 4. Respons Native Flow Interactive Message (Proto WhatsApp Terbaru)
  else if (msg.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
    try {
      const params = JSON.parse(msg.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
      raw = params.id || params.row_id || params.text || params.copy_code || '';
    } catch (e) {}
  }

  return (raw || '').replace(/[\u200B-\u200D\uFEFF\u2060-\u206F]/g, '');
}

/**
 * Helper terpusat untuk mengirim pesan interaktif dengan tombol (Native Flow / Quick Reply / List)
 */
export async function sendInteractiveButtons(targetSock, jid, { text, title, footer, buttons = [], sections = [] }) {
  const activeSock = targetSock || sock;
  if (!activeSock) return false;

  try {
    let fullText = '';
    if (title) fullText += `*${title}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    fullText += text || '';

    if (buttons && buttons.length > 0) {
      fullText += `\n\n📌 *PILIHAN / KONTROL:*`;
      buttons.forEach(b => {
        if (b.type === 'url') {
          fullText += `\n🔗 *${b.text}:* ${b.url}`;
        } else {
          fullText += `\n▶️ *${b.text}* (Ketik \`${b.id || b.text}\`)`;
        }
      });
    }

    if (sections && sections.length > 0) {
      fullText += `\n\n📋 *MENU PILIHAN:*`;
      sections.forEach(s => {
        if (s.title) fullText += `\n*${s.title}*`;
        if (s.rows && s.rows.length > 0) {
          s.rows.forEach(r => {
            fullText += `\n• *${r.title}* ${r.description ? `— ${r.description}` : ''} (Ketik \`${r.id || r.title}\`)`;
          });
        }
      });
    }

    if (footer) fullText += `\n\n_${footer}_`;

    // 1. Kirimkan pesan teks terformat secara langsung (100% terbukti dapat diterima di semua grup & HP)
    await activeSock.sendMessage(jid, { text: fullText });

    // 2. Coba kirimkan tombol interaktif tambahan untuk WhatsApp client yang mendukung
    try {
      const nativeButtons = [];
      if (sections && sections.length > 0) {
        nativeButtons.push({
          name: 'single_select',
          buttonParamsJson: JSON.stringify({ title: '📋 Pilih Menu', sections })
        });
      }
      if (buttons && buttons.length > 0) {
        for (const b of buttons) {
          if (b.type === 'url') {
            nativeButtons.push({ name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: b.text, url: b.url, merchant_url: b.url }) });
          } else if (b.type === 'copy') {
            nativeButtons.push({ name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.id || b.text, copy_code: b.copy_code || b.text }) });
          } else {
            nativeButtons.push({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.id || b.text }) });
          }
        }
      }

      const waMsg = generateWAMessageFromContent(
        jid,
        {
          interactiveMessage: {
            header: title ? { title, hasMediaAttachment: false } : undefined,
            body: { text: text || '' },
            footer: footer ? { text: footer } : undefined,
            nativeFlowMessage: { buttons: nativeButtons }
          }
        },
        { userJid: jid }
      );
      await activeSock.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id });
    } catch (btnErr) {}

    return true;
  } catch (err) {
    console.error('[INTERACTIVE MSG ERROR]', err.message);
    try {
      await activeSock.sendMessage(jid, { text: text || 'Terjadi kesalahan pengiriman pesan.' });
    } catch (e) {}
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
const MAX_RATE_LIMITER_ENTRIES = 5000;

// Periodic Sweep setiap 10 menit untuk membersihkan data rate limiter usang
setInterval(() => {
  const now = Date.now();
  for (const [jid, timestamps] of userMessageTimestamps.entries()) {
    const valid = (timestamps || []).filter(t => now - t < 10000);
    if (valid.length === 0) {
      userMessageTimestamps.delete(jid);
    } else {
      userMessageTimestamps.set(jid, valid);
    }
  }
  if (userMessageTimestamps.size > MAX_RATE_LIMITER_ENTRIES) {
    const keysToDelete = Array.from(userMessageTimestamps.keys()).slice(0, 1000);
    keysToDelete.forEach(k => userMessageTimestamps.delete(k));
  }
}, 10 * 60 * 1000);

export function extractTargetJid(m, args) {
  if (!m) return null;
  // 1. Tag / Mention dalam pesan
  const mentions = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
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

  const antiSpamOn = botSettings.antiSpamEnabled === true || botSettings.antiSpamEnabled === "true" || botSettings.antiSpamEnabled === undefined;
  const antiLinkOn = botSettings.antiLinkEnabled === true || botSettings.antiLinkEnabled === "true" || botSettings.antiLinkEnabled === undefined;
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
      const pLidDigits = p.lid ? extractDigits(p.lid) : '';
      return (pDigits.length > 6 && (pDigits === senderDigits || pDigits.endsWith(senderDigits) || senderDigits.endsWith(pDigits))) ||
             (pLidDigits.length > 6 && (pLidDigits === senderDigits || pLidDigits.endsWith(senderDigits) || senderDigits.endsWith(pLidDigits)));
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
export async function logToSystem(type, text) {
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

// --- ANTI DELETE CACHE ---
const messageCache = new Map();
const MAX_CACHE_SIZE = 1000;


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

  // Ambil versi terbaru WhatsApp Web dari Baileys, fallback ke versi stabil 2.3000.1043857760
  let waVersion = [2, 3000, 1043857760];
  try {
    const fetchVersionPromise = fetchLatestBaileysVersion();
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout fetch version')), 3500));
    const { version: latestVersion, isLatest } = await Promise.race([fetchVersionPromise, timeoutPromise]);
    waVersion = latestVersion;
    console.log(`Menghubungkan menggunakan WA Web v${waVersion.join('.')}, Terkini: ${isLatest}`);
  } catch (err) {
    console.log(`Menghubungkan menggunakan WA Web v${waVersion.join('.')}, Terkini: true`);
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

      // Hentikan Fulfillment Worker saat offline agar tidak membuang kuota retry
      try {
        const { stopFulfillmentWorker } = await import('./src/payment/fulfillmentWorker.js');
        stopFulfillmentWorker();
      } catch (e) {}

      const statusCode = lastDisconnect?.error?.output?.statusCode || 
                         lastDisconnect?.error?.statusCode || 
                         (lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : null);

      botState.lastDisconnectReason = statusCode;
        
      const shouldReconnect = 
        statusCode !== DisconnectReason.loggedOut && 
        statusCode !== DisconnectReason.connectionReplaced;
      
      console.log(`[SOCKET_STATE] Connection CLOSED. StatusCode: ${statusCode}, ShouldReconnect: ${shouldReconnect}`);
      
      if (shouldReconnect) {
        if (!botState.isReconnecting) {
          botState.isReconnecting = true;
          const delayMs = statusCode === DisconnectReason.restartRequired ? 1000 : 5000;
          await logToSystem('SYSTEM', `[SOCKET] Terputus (${statusCode}). Reconnect #${botState.reconnectCount} dalam ${delayMs / 1000}s...`);
          setTimeout(async () => {
            botState.isReconnecting = false;
            await startBot(onSocketReady);
          }, delayMs);
        }
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
      botState.reconnectCount = 0;
      botState.isReconnecting = false;

      console.log('[SOCKET_STATE] Connection OPEN. Session & Signal Keys synchronized.');
      await logToSystem('SYSTEM', '🟢 Bot WhatsApp Sales ONLINE & Signal Session Synchronized!');
      
      // Flush antrean pesan jika ada pesan terpending selama offline (Phase 4)
      processOutgoingQueue();

      // Start Casaku Fulfillment Worker (auto delivery setelah QRIS terbayar)
      try {
        const { startFulfillmentWorker } = await import('./src/payment/fulfillmentWorker.js');
        startFulfillmentWorker(sock);
        console.log('[CASAKU] Fulfillment Worker started (auto product delivery active).');
      } catch (fwErr) {
        console.warn('[CASAKU] Fulfillment Worker not started:', fwErr.message);
      }

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

  // Monitor centang/status pesan terkirim (delivered/read) & Anti-Delete
  sock.ev.on('messages.update', async (updates) => {
    for (const u of updates) {
      // --- ANTI DELETE (Ditangkap via update) ---
      if (u.update.message === null || u.update.messageStubType === 1 || u.update.message?.protocolMessage?.type === 0) {
        const isAntiDeleteEnabled = botSettings.antiDelete === 'true' || botSettings.antiDelete === true;
        if (isAntiDeleteEnabled) {
          const deletedMsgId = u.key.id;
          const originalMsg = messageCache.get(deletedMsgId);
          if (originalMsg && !originalMsg.key.fromMe) {
            const deletedSender = originalMsg.key.participant || originalMsg.key.remoteJid;
            const normDeletedSender = jidNormalizedUser(deletedSender);
            const deletedName = userPushNamesMap.get(normDeletedSender) || 'Seseorang';
            const warningMsg = `⚠️ *Pesan Dihapus Terdeteksi (Rewind)* ⚠️\n\nPengirim: @${normDeletedSender.split('@')[0]} (${deletedName})\nWaktu: ${new Date().toLocaleTimeString('id-ID')}\n\n_Bot mengamankan pesan berikut:_`;
            
            await sock.sendMessage(u.key.remoteJid, { text: warningMsg, mentions: [normDeletedSender] });
            await sock.sendMessage(u.key.remoteJid, { forward: originalMsg });
            
            // Hapus dari cache agar tidak berulang
            messageCache.delete(deletedMsgId);
          }
        }
      }

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

  // Monitor event anggota bergabung/keluar grup (Auto-Welcome & Goodbye dengan Canvas Card)
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    try {
      const gSettings = await db.getGroupSettings(id);
      let gMeta = null;
      try { gMeta = await sock.groupMetadata(id); } catch (e) {}
      const groupName = gMeta ? gMeta.subject : 'WhatsApp Group';
      const memberCount = gMeta ? gMeta.participants.length : 1;
      
      if (action === 'add' && gSettings.welcome_enabled) {
        const welcomeText = gSettings.welcome_msg || botSettings.welcomeMessage || "👋 Selamat datang di grup!";
        for (const p of participants) {
          const userTag = `@${p.split('@')[0]}`;
          let avatarUrl = null;
          try { avatarUrl = await sock.profilePictureUrl(p, 'image'); } catch (e) {}

          const cardBuffer = await createWelcomeGoodbyeCard({
            avatarUrl,
            username: userTag,
            groupName,
            memberCount,
            type: 'welcome'
          });

          const msg = `${welcomeText}\n\nSelamat bergabung ${userTag}! 🙏`;
          await sock.sendMessage(id, { image: cardBuffer, caption: msg, mentions: [p] });
          await db.addLog("GROUP", `Member baru ${userTag} bergabung ke grup ${id}`);
        }
      }

      if (action === 'remove' && gSettings.goodbye_enabled) {
        const goodbyeText = gSettings.goodbye_msg || botSettings.goodbyeMessage || "👋 Sampai jumpa!";
        for (const p of participants) {
          const userTag = `@${p.split('@')[0]}`;
          let avatarUrl = null;
          try { avatarUrl = await sock.profilePictureUrl(p, 'image'); } catch (e) {}

          const cardBuffer = await createWelcomeGoodbyeCard({
            avatarUrl,
            username: userTag,
            groupName,
            memberCount,
            type: 'goodbye'
          });

          const msg = `${goodbyeText} ${userTag}`;
          await sock.sendMessage(id, { image: cardBuffer, caption: msg, mentions: [p] });
          await db.addLog("GROUP", `Member ${userTag} keluar dari grup ${id}`);
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
    const textTrim = (msgText || '').trim();
    if (!textTrim) return false;
    const isPrefix = textTrim.startsWith('.') || textTrim.startsWith('/') || textTrim.startsWith('#');
    if (!isPrefix) return false;

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

    const knownMediaCmds = [
      'hd', 'remini', 'upscale', 'stiker', 'sticker', 's', 'gif', 'sgif', 'toimg', 'unstick', 'toimage', 'tovideo', 'tovid', 'togif',
      'getpp', 'colongpp', 'curipp', 'pp', 'ambilpp', 'stikerpp', 'stickerpp', 'spp',
      'qc', 'quote', 'brat', 'meme', 'draw', 'aiimg', 'dalle', 'editfoto', 'removebg', 'nobg',
      'ssweb', 'ss', 'khodam', 'tod', 'truth', 'dare', 'tts', 'shortlink', 'short', 'cuaca', 'invoice', 'struk',
      'tebakgambar', 'tebakangka', 'susunkata', 'bank', 'deposito', 'tarik', 'withdraw', 'transfer', 'rampok', 'rob', 'slot', 'roulette',
      'ping', 'p', 'statusbot', 'owner', 'kontakowner', 'tagall', 'hidetag', 'everyone',
      'tt', 'tiktok', 'ttmp3', 'ig', 'instagram', 'igstory', 'yt', 'youtube', 'ytmp3', 'ytmp4',
      'fb', 'facebook', 'tw', 'twitter', 'x', 'spotify', 'play', 'song', 'tomp3', 'tovn',
      'tr', 'translate', 'jadwalsholat', 'sholat', 'menfess', 'confess', 'balasmenfess', 'menfessreply', 'replymenfess', 'stopmenfess', 'closemenfess', 'endmenfess',
      'bass', 'blown', 'deep', 'earrape', 'fast', 'fat', 'nightcore', 'reverse', 'robot', 'slow', 'smooth', 'tupai', 'chipmunk', 'echo'
    ];

    if (!knownMediaCmds.includes(cleanCmd)) {
      return false;
    }

    // REGISTRATION CHECK
    const exemptMediaCmds = ['owner', 'kontakowner', 'ping', 'p', 'statusbot', 'invoice', 'struk', 'tagall', 'hidetag', 'everyone'];
    if (!exemptMediaCmds.includes(cleanCmd)) {
      const isReg = await db.isCustomerRegistered(senderNumber);
      if (!isReg) {
        const senderMention = senderNumber.split('@')[0];
        const regNotice = `⚠️ *AKSES DITOLAK — REGISTRASI DIPERLUKAN* ⚠️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nHalo @${senderMention}! Anda harus terdaftar sebagai member terlebih dahulu untuk menggunakan fitur media & downloader ini (100% Gratis & Cepat).\n\n📌 *Cara Pendaftaran (Hanya 5 Detik):*\nKetik: \`.daftar Nama Kamu\`\n\n_Contoh:_ \`.daftar Budi Santoso\`\n\nSetelah terdaftar, Anda dapat langsung menikmati semua fitur bot! 🙏`;
        await sendInteractiveButtons(sock, jid, {
          text: regNotice,
          buttons: [
            { type: 'copy', text: '📋 Salin Format .daftar', copy_code: '.daftar ' }
          ]
        });
        return true;
      }
    }

    const react = async (emoji) => {
      try {
        await sock.sendMessage(jid, { react: { text: emoji, key: m.key } });
      } catch (e) {}
    };

    // 0. HD Remini Image Upscaler
    if (['hd', 'remini', 'upscale'].includes(cleanCmd)) {
      const quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const isQuotedImage = quoted?.imageMessage;
      const isDirectImage = m.message?.imageMessage;

      if (!isQuotedImage && !isDirectImage) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap kirim/reply foto dengan caption `.hd` atau `.remini` untuk meningkatkan kualitas foto." });
        return true;
      }

      await react('⏳');
      try {
        const targetMessage = isDirectImage ? m : { message: quoted };
        const imageBuffer = await downloadMediaMessage(
          targetMessage,
          'buffer',
          {},
          { logger: logger, reuploadRequest: sock.updateMediaMessage }
        );

        const res = await mediaHandler.enhanceImageHd(imageBuffer);
        if (res.success && res.buffer) {
          await sock.sendMessage(jid, {
            image: res.buffer,
            caption: `✨ *FOTO BERHASIL DITINGKATKAN MENJADI HD!*\n\n🛠️ *Engine:* ${res.provider}\n✅ *Diproses via Akbar Store Bot*`
          });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ ${res.message || 'Gagal memproses foto HD.'}` });
        }
      } catch (err) {
        console.error('[HD_CMD_ERR]', err.message);
        await react('❌');
        await sock.sendMessage(jid, { text: '❌ Terjadi kesalahan saat mengunduh/memproses gambar.' });
      }
      return true;
    }
    
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

    // Twitter / X Downloader (.tw, .twitter, .x)
    if (['tw', 'twitter', 'x'].includes(cleanCmd)) {
      const url = args[1] || (msgText.match(/https?:\/\/[^\s]+/i)?.[0]);
      if (!url || (!url.includes('twitter.com') && !url.includes('x.com'))) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap sertakan link Twitter/X yang valid.\n\n_Contoh:_ `.tw https://x.com/username/status/xxxx`" });
        return true;
      }
      await react('⏳');
      const res = await mediaHandler.downloadTwitter(url);
      if (res.success && (res.buffer || res.videoUrl)) {
        await sock.sendMessage(jid, { 
          video: res.buffer || { url: res.videoUrl }, 
          caption: `🐦 *${res.title || 'Twitter / X Media'}*\n\n✅ *Berhasil diunduh via Akbar Store Bot*` 
        });
        await react('✅');
      } else {
        await react('❌');
        await sock.sendMessage(jid, { text: `❌ ${res.message || 'Gagal mengunduh media Twitter/X.'}` });
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
      if (!q || !q.answer || !q.image) {
        return await sock.sendMessage(jid, { text: "❌ Soal tebak gambar sedang tidak tersedia di server saat ini." });
      }
      ent.activeGames.set(jid, {
        answer: q.answer.toUpperCase(),
        hint: q.hint,
        points: 50,
        startTime: Date.now(),
        isAnswered: false,
        timeout: setTimeout(async () => {
          const activeGame = ent.activeGames.get(jid);
          if (!activeGame || activeGame.isAnswered) return;
          ent.activeGames.delete(jid);
          await sock.sendMessage(jid, {
            text: `WAKTU TEBAK GAMBAR HABIS!\n\nJawaban yang benar: *${activeGame.answer}*\nKetik .tebakgambar untuk bermain lagi.`
          });
        }, 90 * 1000)
      });

      const pointsGameCaption = `TEBAK GAMBAR\n\nPetunjuk: ${q.hint}\nHadiah: +50 poin game\nWaktu menjawab: 90 detik\n\nGabungkan arti gambar lalu ketik jawabannya langsung di chat.`;
      const imagePayload = q.image.startsWith('http') ? { url: q.image } : fs.readFileSync(q.image);
      await sock.sendMessage(jid, { image: imagePayload, caption: pointsGameCaption });
      return true;
    }

    // 19.0. Game Tebak Angka (.tebakangka) & Susun Kata (.susunkata)
    if (['tebakangka'].includes(cleanCmd)) {
      if (ent.activeGames.has(jid + '_angka')) {
        return await sock.sendMessage(jid, { text: "⚠️ Masih ada permainan Tebak Angka yang sedang berlangsung di chat ini!" });
      }
      const targetNumber = Math.floor(Math.random() * 100) + 1;
      ent.activeGames.set(jid + '_angka', {
        answer: targetNumber.toString(),
        target: targetNumber,
        type: 'tebakangka',
        points: 40,
        startTime: Date.now(),
        isAnswered: false,
        timeout: setTimeout(async () => {
          const game = ent.activeGames.get(jid + '_angka');
          if (!game || game.isAnswered) return;
          ent.activeGames.delete(jid + '_angka');
          await sock.sendMessage(jid, { text: `WAKTU HABIS!\n\nAngka yang benar adalah *${targetNumber}*.\nKetik .tebakangka untuk bermain lagi.` });
        }, 60 * 1000)
      });
      return await sock.sendMessage(jid, { text: `🔢 *TEBAK ANGKA*\n\nBot telah memikirkan sebuah angka dari 1 sampai 100.\nTebak angkanya langsung di chat ini!\n\nHadiah: +40 Poin\nWaktu: 60 Detik` });
    }

    if (['susunkata'].includes(cleanCmd)) {
      if (ent.activeGames.has(jid + '_susunkata')) {
        return await sock.sendMessage(jid, { text: "⚠️ Masih ada permainan Susun Kata yang sedang berlangsung di chat ini!" });
      }
      const words = [
        { word: 'PERAMPOKAN', hint: 'Kejahatan mengambil paksa' },
        { word: 'EKONOMI', hint: 'Berkaitan dengan uang/perdagangan' },
        { word: 'KASINO', hint: 'Tempat perjudian' },
        { word: 'PELANGGAN', hint: 'Orang yang membeli produk' },
        { word: 'DEPOSITO', hint: 'Simpanan uang di bank' }
      ];
      const selected = words[Math.floor(Math.random() * words.length)];
      if (!selected.word) selected.word = 'BANKIR'; 
      const scrambled = selected.word.split('').sort(() => 0.5 - Math.random()).join(' ');

      ent.activeGames.set(jid + '_susunkata', {
        answer: selected.word,
        type: 'susunkata',
        points: 30,
        startTime: Date.now(),
        isAnswered: false,
        timeout: setTimeout(async () => {
          const game = ent.activeGames.get(jid + '_susunkata');
          if (!game || game.isAnswered) return;
          ent.activeGames.delete(jid + '_susunkata');
          await sock.sendMessage(jid, { text: `WAKTU HABIS!\n\nJawaban yang benar adalah *${selected.word}*.\nKetik .susunkata untuk bermain lagi.` });
        }, 60 * 1000)
      });
      return await sock.sendMessage(jid, { text: `🔠 *SUSUN KATA*\n\nSusun huruf berikut menjadi kata yang benar:\n*${scrambled}*\n\nPetunjuk: ${selected.hint}\nHadiah: +30 Poin\nWaktu: 60 Detik` });
    }

    // 19.1. Fitur Perbankan & Economy
    if (['bank', 'deposito'].includes(cleanCmd)) {
      const amount = parseInt(args[1]);
      if (!amount || isNaN(amount) || amount <= 0) {
        return await sock.sendMessage(jid, { text: "⚠️ Format salah!\nKetik: .bank <jumlah>\n\nUang di bank aman dari perampokan." });
      }
      const res = await db.bankDeposit(senderNormalized, amount);
      if (res.success) {
        return await sock.sendMessage(jid, { text: `✅ Berhasil menabung ${amount} poin ke Bank.\nUang kamu sekarang aman dari rampok.` });
      } else {
        return await sock.sendMessage(jid, { text: "❌ Saldo poin di tangan tidak mencukupi untuk deposit." });
      }
    }

    if (['tarik', 'withdraw'].includes(cleanCmd)) {
      const amount = parseInt(args[1]);
      if (!amount || isNaN(amount) || amount <= 0) {
        return await sock.sendMessage(jid, { text: "⚠️ Format salah!\nKetik: .tarik <jumlah>\n\nPajak penarikan: 2%" });
      }
      const res = await db.bankWithdraw(senderNormalized, amount);
      if (res.success) {
        return await sock.sendMessage(jid, { text: `✅ Berhasil menarik ${amount} poin dari Bank.\nPajak 2% dipotong, kamu menerima ${res.received} poin di tangan.` });
      } else {
        return await sock.sendMessage(jid, { text: "❌ Saldo di bank tidak mencukupi." });
      }
    }

    if (['transfer'].includes(cleanCmd)) {
      const targetStr = args[1];
      const amount = parseInt(args[2]);
      if (!targetStr || !amount || isNaN(amount) || amount <= 0) {
        return await sock.sendMessage(jid, { text: "⚠️ Format salah!\nKetik: .transfer <@tag_user> <jumlah>" });
      }
      const targetJid = targetStr.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
      if (targetJid === senderNormalized) return await sock.sendMessage(jid, { text: "❌ Tidak bisa transfer ke diri sendiri." });

      const res = await db.transferPoints(senderNormalized, targetJid, amount);
      if (res.success) {
        return await sock.sendMessage(jid, { text: `✅ Berhasil mentransfer ${amount} poin ke @${targetJid.split('@')[0]}.\nPajak 1% dipotong, target menerima ${res.received} poin.`, mentions: [targetJid] });
      } else {
        return await sock.sendMessage(jid, { text: "❌ Saldo poin di tangan tidak mencukupi." });
      }
    }

    if (['rampok', 'rob'].includes(cleanCmd)) {
      if (!isGroup) return await sock.sendMessage(jid, { text: "❌ Fitur ini hanya bisa digunakan di dalam grup!" });
      
      const targetStr = args[1];
      if (!targetStr) return await sock.sendMessage(jid, { text: "⚠️ Format salah!\nKetik: .rampok <@tag_user>" });
      
      const targetJid = targetStr.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
      if (targetJid === senderNormalized) return await sock.sendMessage(jid, { text: "❌ Ngapain ngerampok diri sendiri?" });
      if (targetJid.includes('bot')) return await sock.sendMessage(jid, { text: "❌ Kamu tidak bisa merampok bot!" });

      const robberProf = await db.getGameProfile(senderNormalized);
      const targetProf = await db.getGameProfile(targetJid);

      // Cooldown 1 jam
      if (robberProf.last_rob_time) {
        const lastRob = new Date(robberProf.last_rob_time).getTime();
        const now = Date.now();
        const cooldown = 60 * 60 * 1000;
        if (now - lastRob < cooldown) {
          const sisa = Math.ceil((cooldown - (now - lastRob)) / 1000 / 60);
          return await sock.sendMessage(jid, { text: `⏳ Kamu sedang kelelahan setelah merampok!\nTunggu ${sisa} menit lagi.` });
        }
      }

      // Safe zone 2 jam
      if (targetProf.last_robbed_at) {
        const lastRobbed = new Date(targetProf.last_robbed_at).getTime();
        const now = Date.now();
        const safezone = 2 * 60 * 60 * 1000;
        if (now - lastRobbed < safezone) {
          const sisa = Math.ceil((safezone - (now - lastRobbed)) / 1000 / 60);
          return await sock.sendMessage(jid, { text: `🛡️ Target sedang dalam masa perlindungan polisi (Safe Zone).\nTunggu ${sisa} menit lagi.` });
        }
      }

      if (targetProf.points < 50) {
        return await sock.sendMessage(jid, { text: `❌ Kasian, saldonya kurang dari 50 poin. Cari target lain yang lebih kaya!` });
      }

      if (robberProf.points < 50) {
        return await sock.sendMessage(jid, { text: `❌ Modal kamu kurang! Butuh minimal 50 poin di tangan sebagai jaminan kalau tertangkap.` });
      }

      await db.updateLastRobTime(senderNormalized);

      // 40% success rate
      const isSuccess = Math.random() < 0.40;
      
      if (isSuccess) {
        const stolen = Math.floor(targetProf.points * (Math.random() * 0.10 + 0.05)); // 5-15% of target's points
        await db.deductCustomerPoints(targetJid, stolen, 'Dirampok');
        await db.awardGamePoints(senderNormalized, stolen);
        await db.updateLastRobbedAt(targetJid);
        
        return await sock.sendMessage(jid, { text: `💰 *PERAMPOKAN BERHASIL!* 💰\n\nKamu menyelinap masuk dan mencuri *${stolen} poin* dari @${targetJid.split('@')[0]}!`, mentions: [targetJid] });
      } else {
        const fine = Math.floor(robberProf.points * (Math.random() * 0.10 + 0.10)); // 10-20% fine
        await db.deductCustomerPoints(senderNormalized, fine, 'Denda Rampok');
        await db.awardGamePoints(targetJid, Math.floor(fine * 0.5)); // 50% denda masuk ke target sebagai kompensasi
        
        return await sock.sendMessage(jid, { text: `🚨 *TERTANGKAP POLISI!* 🚨\n\nUsahamu merampok @${targetJid.split('@')[0]} gagal dan kamu tertangkap!\nKamu didenda *${fine} poin* (sebagian diberikan ke target).`, mentions: [targetJid] });
      }
    }

    if (['slot'].includes(cleanCmd)) {
      const bet = parseInt(args[1]);
      if (!bet || isNaN(bet) || bet < 10) return await sock.sendMessage(jid, { text: "⚠️ Ketik: .slot <taruhan>\nMinimal taruhan 10 poin." });
      
      const prof = await db.getGameProfile(senderNormalized);
      if (prof.points < bet) return await sock.sendMessage(jid, { text: "❌ Poin di tangan tidak mencukupi untuk taruhan ini." });

      const emojis = ['🍒', '🍎', '🍇', '🍉', '⭐', '💎'];
      const s1 = emojis[Math.floor(Math.random() * emojis.length)];
      const s2 = emojis[Math.floor(Math.random() * emojis.length)];
      const s3 = emojis[Math.floor(Math.random() * emojis.length)];

      let winAmount = 0;
      if (s1 === s2 && s2 === s3) winAmount = bet * 5;
      else if (s1 === s2 || s2 === s3 || s1 === s3) winAmount = Math.floor(bet * 1.5);
      
      if (winAmount > 0) {
        await db.awardGamePoints(senderNormalized, winAmount - bet);
      } else {
        await db.deductCustomerPoints(senderNormalized, bet, 'Slot Kalah');
      }

      const resultText = `🎰 *SLOT MACHINE* 🎰\n\n[ ${s1} | ${s2} | ${s3} ]\n\n${winAmount > 0 ? `🎉 MENANG! +${winAmount} Poin!` : `💥 KALAH! -${bet} Poin`}`;
      return await sock.sendMessage(jid, { text: resultText });
    }

    if (['roulette'].includes(cleanCmd)) {
      const bet = parseInt(args[1]);
      const color = args[2]?.toLowerCase();
      if (!bet || isNaN(bet) || bet < 10 || !['merah', 'hitam', 'hijau'].includes(color)) {
        return await sock.sendMessage(jid, { text: "⚠️ Ketik: .roulette <taruhan> <merah/hitam/hijau>\nContoh: .roulette 50 merah\n\nHitam/Merah: 2x Lipat\nHijau: 10x Lipat" });
      }

      const prof = await db.getGameProfile(senderNormalized);
      if (prof.points < bet) return await sock.sendMessage(jid, { text: "❌ Poin di tangan tidak mencukupi untuk taruhan ini." });

      // Roll 0-36 (0 is Green, 1-18 is Red, 19-36 is Black)
      const roll = Math.floor(Math.random() * 37);
      let resultColor = 'hijau';
      if (roll >= 1 && roll <= 18) resultColor = 'merah';
      else if (roll >= 19) resultColor = 'hitam';

      let isWin = false;
      let winAmount = 0;

      if (color === resultColor) {
        isWin = true;
        winAmount = color === 'hijau' ? bet * 10 : bet * 2;
        await db.awardGamePoints(senderNormalized, winAmount - bet);
      } else {
        await db.deductCustomerPoints(senderNormalized, bet, 'Roulette Kalah');
      }

      return await sock.sendMessage(jid, { text: `🎲 *ROULETTE* 🎲\n\nBola berputar dan berhenti di angka *${roll}* (*${resultColor.toUpperCase()}*)!\n\n${isWin ? `🎉 MENANG! Kamu dapat +${winAmount} poin!` : `💥 KALAH! Kamu kehilangan -${bet} poin.`}` });
    }

    // 19.3. Colong / Ambil Foto Profil (PP) Target (.getpp, .colongpp, .curipp, .pp, .ambilpp, .stikerpp, .stickerpp, .spp)
    if (['getpp', 'colongpp', 'curipp', 'pp', 'ambilpp', 'stikerpp', 'stickerpp', 'spp'].includes(cleanCmd)) {
      let targetJid = null;

      // Prioritas 1: Tag/Mention atau Quote/Reply pesan seseorang
      targetJid = extractTargetJid(m, args);

      // Prioritas 2: Kata kunci khusus
      const argTarget = (args[1] || '').toLowerCase().trim();
      if (argTarget === 'grup' || argTarget === 'group') {
        targetJid = isGroup ? jid : null;
      } else if (argTarget === 'bot') {
        targetJid = sock.user?.id ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : null;
      } else if (argTarget === 'me' || argTarget === 'saya') {
        targetJid = senderNormalized;
      }

      // Jika di DM dan tidak ada argumen, targetnya adalah diri sendiri atau pengirim
      if (!targetJid && !isGroup) {
        targetJid = senderNormalized;
      }

      if (!targetJid) {
        await sock.sendMessage(jid, {
          text: `⚠️ *Format Perintah Kurang Lengkap!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📌 *Cara Pakai:*\n• \`.getpp @user\` — Ambil PP orang yang di-tag\n• Reply pesan seseorang lalu ketik \`.getpp\`\n• \`.getpp 628123456789\` — Ambil PP via nomor HP\n• \`.getpp grup\` — Ambil foto profil grup\n• \`.stikerpp @user\` — Colong PP langsung jadi Stiker WA! 🎭`
        }, { quoted: m });
        return true;
      }

      // Normalisasi format JID
      if (!targetJid.includes('@')) {
        targetJid = targetJid.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
      }

      try {
        await react('⏳');
        let avatarUrl = null;
        try {
          avatarUrl = await sock.profilePictureUrl(targetJid, 'image');
        } catch (e) {
          try {
            avatarUrl = await sock.profilePictureUrl(targetJid, 'preview');
          } catch (e2) {
            avatarUrl = null;
          }
        }

        if (!avatarUrl) {
          await react('❌');
          const isTargetGroup = targetJid.endsWith('@g.us');
          const errorMsg = isTargetGroup
            ? `❌ Grup ini tidak memasang foto profil ikon grup.`
            : `❌ Target @${targetJid.split('@')[0]} tidak memasang foto profil atau menyembunyikan privasi foto profilnya.`;
          await sock.sendMessage(jid, { text: errorMsg, mentions: [targetJid] }, { quoted: m });
          return true;
        }

        const axios = (await import('axios')).default;
        const imgRes = await axios.get(avatarUrl, { responseType: 'arraybuffer', timeout: 15000 });
        const imgBuffer = Buffer.from(imgRes.data);

        // Jika perintahnya adalah membuat stiker dari PP target
        if (['stikerpp', 'stickerpp', 'spp'].includes(cleanCmd)) {
          const stickerRes = await mediaHandler.createSticker(imgBuffer, 'Colong PP', `@${targetJid.split('@')[0]}`, false);
          if (stickerRes.success && stickerRes.buffer) {
            await sock.sendMessage(jid, { sticker: stickerRes.buffer }, { quoted: m });
            await react('✅');
          } else {
            await sock.sendMessage(jid, {
              image: imgBuffer,
              caption: `🎭 *STIKER PP TARGET*\n\n_(Stiker gagal di-generate, menampilkan gambar asli)_ @${targetJid.split('@')[0]}`,
              mentions: [targetJid]
            }, { quoted: m });
            await react('✅');
          }
          return true;
        }

        // Tampilkan sebagai foto HD
        const isTargetGroup = targetJid.endsWith('@g.us');
        const caption = isTargetGroup
          ? `📸 *FOTO PROFIL GRUP TERTANGKAP!* 📸\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👥 *Grup ID:* \`${targetJid}\`\n✨ Resolusi: *High Definition (HD)*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n_Foto ikon grup berhasil diunduh!_ 🕵️‍♂️`
          : `📸 *FOTO PROFIL TARGET TERTANGKAP!* 📸\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎯 *Target:* @${targetJid.split('@')[0]}\n🆔 *JID:* \`${targetJid}\`\n✨ Resolusi: *High Definition (HD)*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n_Foto profil berhasil dicolong! Ketik \`.stikerpp @user\` untuk mengubahnya jadi stiker._ 🎭`;

        await sock.sendMessage(jid, {
          image: imgBuffer,
          caption,
          mentions: [targetJid]
        }, { quoted: m });
        await react('✅');
      } catch (err) {
        await react('❌');
        console.error('[GETPP_ERR]', err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal mengambil foto profil: ${err.message}` }, { quoted: m });
      }
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

    // 22. Cari & Download Lagu (.song, .play)
    if (['song', 'play'].includes(cleanCmd)) {
      const query = args.slice(1).join(' ');
      if (!query) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap sertakan judul lagu.\n\n_Contoh:_ `.song Laskar Pelangi`" });
        return true;
      }
      try {
        await react('⏳');
        const songRes = await mediaHandler.downloadSongBySearch(query);
        if (songRes.success && songRes.buffer) {
          await sock.sendMessage(jid, { 
            audio: songRes.buffer, 
            mimetype: 'audio/mp4',
            fileName: `${songRes.title}.mp3`
          });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ ${songRes.message || 'Gagal mencari/mendownload lagu.'}` });
        }
      } catch (err) {
        await react('❌');
        console.error("[SONG_CMD_ERR]", err.message);
        await sock.sendMessage(jid, { text: "❌ Terjadi kesalahan saat mencari lagu." });
      }
      return true;
    }

    // 23. Ekstrak Suara Video ke MP3 / VN (.tomp3, .tovn)
    if (['tomp3', 'tovn'].includes(cleanCmd)) {
      const quotedMsg = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const targetMessage = quotedMsg ? { message: quotedMsg, key: { id: m.message.extendedTextMessage.contextInfo.stanzaId } } : m;
      
      const isVideo = targetMessage.message?.videoMessage;
      if (!isVideo) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap reply pesan video yang ingin diekstrak suaranya." });
        return true;
      }

      try {
        await react('⏳');
        const videoBuffer = await downloadMediaMessage(targetMessage, 'buffer', {});
        const outputFormat = cleanCmd === 'tovn' ? 'vn' : 'mp3';
        const audioBuffer = await mediaHandler.convertVideoToAudio(videoBuffer, outputFormat);
        
        if (outputFormat === 'vn') {
          await sock.sendMessage(jid, { 
            audio: audioBuffer, 
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true
          });
        } else {
          await sock.sendMessage(jid, { 
            audio: audioBuffer, 
            mimetype: 'audio/mp4',
            fileName: 'audio.mp3'
          });
        }
        await react('✅');
      } catch (err) {
        await react('❌');
        console.error("[TOAUDIO_CMD_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal mengekstrak suara dari video: ${err.message}` });
      }
      return true;
    }

    // 24. Penerjemah Bahasa (.tr, .translate)
    if (['tr', 'translate'].includes(cleanCmd)) {
      const quotedMsg = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || '';
      
      let targetLang = 'id';
      let textToTranslate = '';

      if (quotedText) {
        targetLang = args[1] || 'id';
        textToTranslate = quotedText;
      } else {
        targetLang = args[1] || 'id';
        textToTranslate = args.slice(2).join(' ');
      }

      if (!textToTranslate) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap masukkan teks yang ingin diterjemahkan atau reply sebuah pesan.\n\n_Contoh:_ `.tr en Halo selamat pagi` atau reply pesan lalu ketik `.tr en`" });
        return true;
      }

      try {
        await react('⏳');
        const translated = await mediaHandler.translateText(textToTranslate, targetLang);
        if (translated) {
          await sock.sendMessage(jid, { text: `🔤 *TERJEMAHAN (${targetLang.toUpperCase()}):*\n\n${translated}` });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: "❌ Gagal menerjemahkan teks." });
        }
      } catch (err) {
        await react('❌');
        console.error("[TRANSLATE_CMD_ERR]", err.message);
        await sock.sendMessage(jid, { text: "❌ Terjadi kesalahan saat menerjemahkan." });
      }
      return true;
    }

    // 25. Jadwal Sholat (.jadwalsholat, .sholat)
    if (['jadwalsholat', 'sholat'].includes(cleanCmd)) {
      const city = args.slice(1).join(' ') || 'Jakarta';
      try {
        await react('🕌');
        const res = await mediaHandler.getPrayerTimes(city);
        if (res.success && res.timings) {
          const t = res.timings;
          let msg = `🕌 *JADWAL SHOLAT WILAYAH ${city.toUpperCase()}* 🕌\n`;
          msg += `📅 Tanggal: *${res.meta.date.gregorian.date}* (${res.meta.date.hijri.date} ${res.meta.date.hijri.month.en})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
          msg += `🌅 Subuh (Fajr): *${t.Fajr}*\n`;
          msg += `☀️ Terbit (Sunrise): *${t.Sunrise}*\n`;
          msg += `🕛 Dzuhur (Dhuhr): *${t.Dhuhr}*\n`;
          msg += `🕒 Ashar (Asr): *${t.Asr}*\n`;
          msg += `🌇 Maghrib (Maghrib): *${t.Maghrib}*\n`;
          msg += `🌃 Isya (Isha): *${t.Isha}*\n\n`;
          msg += `_Sumber: AlAdhan API (Metode ${res.meta.method.name})_`;

          await sock.sendMessage(jid, { text: msg });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ ${res.message || 'Kota tidak ditemukan.'}` });
        }
      } catch (err) {
        await react('❌');
        console.error("[SHOLAT_CMD_ERR]", err.message);
        await sock.sendMessage(jid, { text: "❌ Terjadi kesalahan saat mengambil jadwal sholat." });
      }
      return true;
    }

    // 26. Menfess / Confess Pesan Anonim 2-Arah (.menfess, .confess, .balasmenfess, .stopmenfess)
    if (['menfess', 'confess'].includes(cleanCmd)) {
      const rawText = args.slice(1).join(' ');
      const parts = rawText.split('|');
      if (parts.length < 2) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Gunakan format: `.menfess nomor | pesan`\n\n_Contoh:_ `.menfess 08123456789 | Semangat belajarnya ya!`" });
        return true;
      }

      const targetInput = parts[0].trim();
      const messageText = parts[1].trim();

      const numOnly = targetInput.replace(/[^0-9]/g, '');
      if (!numOnly || numOnly.length < 9) {
        await sock.sendMessage(jid, { text: "❌ Nomor target tidak valid. Harap masukkan nomor WhatsApp yang benar." });
        return true;
      }

      let targetJid = numOnly;
      if (targetJid.startsWith('0')) {
        targetJid = '62' + targetJid.slice(1);
      }
      targetJid += '@s.whatsapp.net';

      if (targetJid === senderNumber) {
        await sock.sendMessage(jid, { text: "❌ Kamu tidak bisa mengirim menfess ke nomor kamu sendiri." });
        return true;
      }

      try {
        await react('⏳');
        const sessionId = `MFS-${Math.floor(1000 + Math.random() * 9000)}`;
        await db.createMenfessSession(sessionId, senderNumber, targetJid);
        
        let menfessMsg = `💌 *MENFESS / CONFESS (PESAN ANONIM)* 💌\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        menfessMsg += `Halo! Kamu menerima pesan rahasia dari seseorang:\n\n`;
        menfessMsg += `💬 *"${messageText}"*\n\n`;
        menfessMsg += `📌 *ID Sesi Menfess:* \`${sessionId}\`\n\n`;
        menfessMsg += `_Kamu bisa membalas pesan rahasia ini secara anonim via bot!_\n`;
        menfessMsg += `👉 *Cara Membalas:* Ketik \`.balasmenfess ${sessionId} <pesan kamu>\`\n`;
        menfessMsg += `👉 *Akhiri Sesi:* Ketik \`.stopmenfess ${sessionId}\``;

        await sock.sendMessage(targetJid, { text: menfessMsg });
        
        await db.addLog("MODERATION", `Anonim (${senderNumber}) mengirim menfess [${sessionId}] ke ${targetJid}`);
        
        await sock.sendMessage(jid, { 
          text: `✅ *Menfess Terkirim!* Pesan rahasia Anda telah dikirimkan ke target.\n\n📌 *ID Sesi Menfess:* \`${sessionId}\`\n_Jika penerima membalas, bot akan meneruskan balasannya ke DM Anda secara rahasia._` 
        });
        await react('💌');
      } catch (err) {
        await react('❌');
        console.error("[MENFESS_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal mengirim menfess: ${err.message}` });
      }
      return true;
    }

    if (['balasmenfess', 'menfessreply', 'replymenfess'].includes(cleanCmd)) {
      let targetSessionId = args[1]?.toUpperCase();
      let replyMessage = '';

      if (targetSessionId && targetSessionId.startsWith('MFS-')) {
        replyMessage = args.slice(2).join(' ').trim();
      } else {
        const activeSess = await db.getActiveMenfessByParticipant(senderNumber);
        if (activeSess) {
          targetSessionId = activeSess.id;
          replyMessage = args.slice(1).join(' ').trim();
        }
      }

      if (!targetSessionId || !replyMessage) {
        await sock.sendMessage(jid, { 
          text: `⚠️ *Format Balas Menfess:* \`.balasmenfess <ID_SESI> <pesan kamu>\`\n_Contoh:_ \`.balasmenfess MFS-1234 Makasih ya, ini siapa?\`` 
        });
        return true;
      }

      const session = await db.getMenfessSession(targetSessionId);
      if (!session || session.status !== 'ACTIVE') {
        await sock.sendMessage(jid, { text: `❌ Sesi Menfess \`${targetSessionId}\` tidak ditemukan atau sudah ditutup.` });
        return true;
      }

      if (session.sender_jid !== senderNumber && session.target_jid !== senderNumber) {
        await sock.sendMessage(jid, { text: `❌ Anda tidak terdaftar dalam sesi Menfess ini.` });
        return true;
      }

      const recipientJid = (senderNumber === session.sender_jid) ? session.target_jid : session.sender_jid;
      const isReplyFromTarget = (senderNumber === session.target_jid);
      const senderLabel = isReplyFromTarget ? "Penerima Pesan" : "Pengirim Anonim";

      try {
        await react('⏳');
        const forwardMsg = `💌 *BALASAN PESAN MENFESS (${session.id})* 💌\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `Pesan balasan dari *${senderLabel}*:\n\n` +
          `💬 *"${replyMessage}"*\n\n` +
          `👉 *Balas kembali:* \`.balasmenfess ${session.id} <pesan>\`\n` +
          `👉 *Akhiri percakapan:* \`.stopmenfess ${session.id}\``;

        await sock.sendMessage(recipientJid, { text: forwardMsg });
        await db.updateMenfessLastReply(session.id);
        await db.addLog("MODERATION", `Balasan Menfess [${session.id}] diteruskan ke ${recipientJid}`);

        await sock.sendMessage(jid, { text: `✅ *Balasan Terkirim!* Pesan Anda telah diteruskan secara rahasia (Sesi: \`${session.id}\`).` });
        await react('✅');
      } catch (err) {
        await react('❌');
        await sock.sendMessage(jid, { text: `❌ Gagal meneruskan balasan: ${err.message}` });
      }
      return true;
    }

    if (['stopmenfess', 'closemenfess', 'endmenfess'].includes(cleanCmd)) {
      let targetSessionId = args[1]?.toUpperCase();
      if (!targetSessionId || !targetSessionId.startsWith('MFS-')) {
        const activeSess = await db.getActiveMenfessByParticipant(senderNumber);
        if (activeSess) targetSessionId = activeSess.id;
      }

      if (!targetSessionId) {
        await sock.sendMessage(jid, { text: `⚠️ Gunakan: \`.stopmenfess <ID_SESI>\`\n_Contoh:_ \`.stopmenfess MFS-1234\`` });
        return true;
      }

      const session = await db.getMenfessSession(targetSessionId);
      if (!session || session.status !== 'ACTIVE') {
        await sock.sendMessage(jid, { text: `❌ Sesi Menfess \`${targetSessionId}\` sudah tidak aktif.` });
        return true;
      }

      if (session.sender_jid !== senderNumber && session.target_jid !== senderNumber) {
        await sock.sendMessage(jid, { text: `❌ Anda tidak berhak menutup sesi Menfess ini.` });
        return true;
      }

      await db.closeMenfessSession(session.id);
      const otherPartyJid = (senderNumber === session.sender_jid) ? session.target_jid : session.sender_jid;

      await sock.sendMessage(jid, { text: `🛑 Sesi percakapan Menfess \`${session.id}\` berhasil diakhiri.` });
      try {
        await sock.sendMessage(otherPartyJid, { 
          text: `🛑 *SESI MENFESS DIAKHIRI*\n\nTeman percakapan anonim Anda telah mengakhiri sesi Menfess (\`${session.id}\`). Terima kasih telah menggunakan fitur Menfess!` 
        });
      } catch (e) {}
      return true;
    }

    return false;
  }


  // Create Context for handlers
  const ctx = {
      sock,
      botSettings,
      userPushNamesMap,
      messageCache,
      formatPhoneNumber,
      checkIsUserInGroup,
      sendQris,
      logToSystem,
      sendInteractiveButtons: (...args) => sendInteractiveButtons(sock, ...args),
      react: async (jid, emoji, key) => { await sock.sendMessage(jid, { react: { text: emoji, key: key } }) }
  };
  const handleCustomerMessage = createCustomerHandler(ctx);
  const handleGroupMessage = createGroupAdminHandler(ctx);
            
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (type !== 'notify') return;

      for (const m of messages) {
        if (!m.message) continue;

        // --- ANTI-DELETE: Simpan pesan ke cache ---
        if (m.key && m.key.id && !m.key.fromMe) {
          messageCache.set(m.key.id, m);
          if (messageCache.size > MAX_CACHE_SIZE) {
            const firstKey = messageCache.keys().next().value;
            messageCache.delete(firstKey);
          }
        }

        // --- ANTI-DELETE: Tangkap event revoke (hapus pesan) via upsert ---
        if (m.message.protocolMessage && m.message.protocolMessage.type === 0) {
          const isAntiDeleteEnabled = botSettings.antiDelete === 'true' || botSettings.antiDelete === true;
          if (isAntiDeleteEnabled) {
            const deletedMsgKey = m.message.protocolMessage.key;
            if (deletedMsgKey && deletedMsgKey.id) {
              const originalMsg = messageCache.get(deletedMsgKey.id);
              if (originalMsg && !originalMsg.key.fromMe) {
                const deletedSender = originalMsg.key.participant || originalMsg.key.remoteJid;
                const normDeletedSender = jidNormalizedUser(deletedSender);
                const deletedName = userPushNamesMap.get(normDeletedSender) || 'Seseorang';
                const warningMsg = `⚠️ *Pesan Dihapus Terdeteksi (Rewind)* ⚠️\n\nPengirim: @${normDeletedSender.split('@')[0]} (${deletedName})\nWaktu: ${new Date().toLocaleTimeString('id-ID')}\n\n_Bot mengamankan pesan berikut:_`;
                
                await sock.sendMessage(m.key.remoteJid, { text: warningMsg, mentions: [normDeletedSender] });
                await sock.sendMessage(m.key.remoteJid, { forward: originalMsg });
                
                messageCache.delete(deletedMsgKey.id);
              }
            }
          }
        }

        const jid = m.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        const sender = m.key.participant || jid;
        let senderNormalized = jidNormalizedUser(sender);
        const isFromMe = m.key.fromMe;
        
        if (isGroup && !isFromMe) {
          await db.incrementGroupChatStats(jid, senderNormalized);
        }

        if (m.pushName && senderNormalized) {
          userPushNamesMap.set(senderNormalized, m.pushName);
        }

        if (isFromMe) continue;

        // ====================================================================
        // DETEKSI OWNER & ADMIN — Sistem LID-Aware
        // Masalah: WhatsApp kini kirim pesan dari grup sebagai @lid (bukan nomor HP)
        // Solusi: cek ownerJid yang tersimpan + mapping metadata grup
        // ====================================================================
        let senderCleanJid = jidNormalizedUser(senderNormalized);
        const extractDigits = (s) => s ? String(s).replace(/[^0-9]/g, '') : '';
        const senderDigits = extractDigits(senderCleanJid);
        const ownerPhoneDigits = extractDigits(botSettings.ownerNumber || config.defaults.ownerNumber || '');
        const storedOwnerJid = jidNormalizedUser((botSettings.ownerJid || '').trim());
        const adminEntries = (botSettings.adminNumbers || config.defaults.adminNumbers || "").split(',').map(n => extractDigits(n)).filter(d => d.length > 6);

        // Cek apakah sender adalah Owner (by fromMe, stored JID exact match, atau phone digit match)
        let isOwnerSender = false;
        if (m.key?.fromMe) {
          isOwnerSender = true; // Pesan dari bot sendiri (linked device owner) — paling reliable
        } else if (storedOwnerJid && (senderCleanJid === storedOwnerJid || senderCleanJid.includes(storedOwnerJid.split('@')[0]) || storedOwnerJid.includes(senderCleanJid.split('@')[0]))) {
          isOwnerSender = true; // Exact JID match (handles @lid yang disimpan via .setownerid)
        } else if (ownerPhoneDigits && senderDigits && senderDigits.length > 6 && (senderDigits === ownerPhoneDigits || senderDigits.endsWith(ownerPhoneDigits) || ownerPhoneDigits.endsWith(senderDigits))) {
          isOwnerSender = true; // Phone number match dengan toleransi kode negara (works in DM)
        }

        let isGroupAdmin = false;
        let isStoreAdmin = adminEntries.some(adm => senderDigits.length > 6 && (senderDigits === adm || senderDigits.endsWith(adm) || adm.endsWith(senderDigits)));
        let isAdmin = isOwnerSender || isStoreAdmin;

        // Di GRUP: cek status admin grup via groupMetadata & resolusi LID -> Phone Owner/Admin/Customer
        if (isGroup) {
          try {
            const groupMeta = await getCachedGroupMetadata(sock, jid);
            if (groupMeta && groupMeta.participants) {
              const pMatch = groupMeta.participants.find(p => {
                const pCleanId = jidNormalizedUser(p.id);
                const pCleanLid = p.lid ? jidNormalizedUser(p.lid) : null;
                return pCleanId === senderCleanJid || pCleanLid === senderCleanJid ||
                       (p.id && senderCleanJid.includes(p.id.split('@')[0])) ||
                       (p.lid && senderCleanJid.includes(p.lid.split('@')[0]));
              });
              if (pMatch) {
                // Resolusi LID ke Phone JID (@s.whatsapp.net) jika tersedia
                if (pMatch.id && pMatch.id.endsWith('@s.whatsapp.net')) {
                  senderNormalized = jidNormalizedUser(pMatch.id);
                  senderCleanJid = senderNormalized;
                }

                if (pMatch.admin === 'admin' || pMatch.admin === 'superadmin') {
                  isGroupAdmin = true;
                }
                const pPhone = extractDigits(pMatch.id);
                // Resolusi Owner jika pengirim memakai LID di grup
                if (ownerPhoneDigits && pPhone && (pPhone === ownerPhoneDigits || pPhone.endsWith(ownerPhoneDigits) || ownerPhoneDigits.endsWith(pPhone))) {
                  isOwnerSender = true;
                  if (pMatch.lid && (!botSettings.ownerJid || botSettings.ownerJid !== jidNormalizedUser(pMatch.lid))) {
                    botSettings.ownerJid = jidNormalizedUser(pMatch.lid);
                    db.updateSettings({ ownerJid: botSettings.ownerJid }).catch(() => {});
                  }
                }
                // Resolusi Admin Toko jika pengirim memakai LID di grup
                if (pPhone && adminEntries.some(adm => pPhone === adm || pPhone.endsWith(adm) || adm.endsWith(pPhone))) {
                  isStoreAdmin = true;
                }
              }
            }
          } catch (e) {
            // Silent fail jika tidak bisa ambil metadata grup
          }
        }

        // Owner dan Admin Toko SELALU memiliki akses Admin penuh di SEMUA grup (walaupun bukan admin di grup WA tersebut)
        isAdmin = isOwnerSender || isGroupAdmin || isStoreAdmin;

        // Cek apakah user sedang di-banned (Owner/Admin tidak pernah kena ban)
        if (!isAdmin) {
          const isBanned = await db.isUserBanned(senderNormalized);
          if (isBanned) continue;
        }

        const mainBuyerGroupJid = botSettings.buyerGroupId || "";

        const msgText = extractMessageText(m).trim();

        // ====================================================================
        // PROTEKSI WAJIB REGISTRASI MEMBER (.daftar <nama>) & ANTI-SPAM
        // ====================================================================
        const argsCheck = msgText.trim().split(/\s+/);
        const rawCmdCheck = argsCheck[0].toLowerCase();
        const cleanCmdCheck = rawCmdCheck.replace(/^[./#]/, '');

        const isPrefixCmd = msgText.startsWith('.') || msgText.startsWith('/') || msgText.startsWith('#');
        const knownCmdList = [
          'daftar', 'register', 'registrasi', 'owner', 'kontakowner', 'menu', 'help', 'bantuan', 
          'produk', 'list', 'katalog', 'listproduk', 'p', 'detail', 'info', 'lihat', 'beli', 'checkout', 'keranjang', 'cart', 'status', 'riwayat', 'batal', 'cancel',
          'freegames', 'freegame', 'gamegratis', 'slot', 'slots', 'stiker', 'sticker', 's', 'gif',
          'tt', 'tiktok', 'ig', 'instagram', 'yt', 'youtube', 'fb', 'facebook', 'quiz', 'trivia',
          'tebakemoji', 'tebakkata', 'tebakgambar', 'zodiak', 'jodoh', 'khodam', 'truth', 'dare',
          'torebot', 'tochipmunk', 'todeep', 'toecho', 'ping', 'statusbot', 'daily', 'poin', 'rank',
          'song', 'play', 'tomp3', 'tovn', 'tr', 'translate', 'jadwalsholat', 'sholat', 'menfess', 'confess',
          'hd', 'remini', 'upscale', 'afk', 'ww', 'werewolf', 'pay', 'qris', 'pembayaran',
          'rampok', 'rob', 'bank', 'deposito', 'tarik', 'withdraw', 'transfer', 'susunkata', 'tebakangka', 'roulette',
          'premium', 'upgradepremium', 'cekpremium', 'ai', 'gemini', 'tanyaai', 'lapak', 'jual', 'claimvoucher', 'wishlist',
          // Perintah owner / admin

          'addpoint', 'addpoints', 'tambahpoin', 'setpoin', 'resetpoin', 'resetleaderboard',
          'giveaway', 'setpoints', 'bagipoin', 'kompensasi', 'antidelete',
          'paid', 'done', 'broadcast', 'addcoupon', 'delcoupon', 'listcoupon',
          'addfaq', 'delfaq', 'listfaq', 'laporan', 'restock', 'stock', 'price',
          'out', 'ready', 'addproduct', 'takeover', 'release', 'stats', 'flashsale',
          'setname', 'setowner', 'setownerid', 'addmod', 'delmod', 'listmod',
          'ban', 'unban', 'kick', 'add', 'promote', 'demote', 'tagall', 'hidetag',
          'everyone', 'admins', 'mode', 'setmode', 'botmode', 'antilink',
          'welcome', 'setwelcome', 'link', 'getjid', 'backup', 'eval', 'join', 'levelup', 'autolevelup', 'globallevelup', 'setlevelup', 'autodl', 'autodownload', 'listfitur', 'fiturgrup', 'groupfeatures', 'tebaklagu', 'balasmenfess', 'menfessreply', 'stopmenfess', 'closemenfess'
        ];


        const isBotCommand = isPrefixCmd;
        const exemptCommands = ['daftar', 'register', 'registrasi', 'owner', 'kontakowner', 'menu', 'help', 'bantuan', 'ping', 'statusbot'];

        if (isBotCommand && !exemptCommands.includes(cleanCmdCheck) && !isAdmin) {
          const isRegistered = await db.isCustomerRegistered(senderNormalized);
          if (!isRegistered) {
            const senderMention = senderNormalized.split('@')[0];
            const regNotice = `⚠️ *AKSES DITOLAK — REGISTRASI DIPERLUKAN* ⚠️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nHalo @${senderMention}! Untuk dapat menggunakan fitur bot kami & mencegah spam, Anda harus terdaftar sebagai member terlebih dahulu (100% Gratis & Cepat).\n\n📌 *Cara Pendaftaran (Hanya 5 Detik):*\nKetik: \`.daftar Nama Kamu\`\n\n_Contoh:_ \`.daftar Budi Santoso\`\n\nSetelah terdaftar, Anda dapat langsung menikmati semua fitur katalog, transaksi, game, dan hiburan! 🙏`;
            
            await sendInteractiveButtons(sock, jid, {
              text: regNotice,
              buttons: [
                { type: 'copy', text: '📋 Salin Format .daftar', copy_code: '.daftar ' }
              ]
            });
            continue;
          }
        }

        // AFK System: Cek jika sender sebelumnya sedang AFK
        if (!isBotCommand) {
          const afkData = await db.removeAfk(senderNormalized);
          if (afkData) {
            const durationSec = Math.floor((Date.now() - afkData.time) / 1000);
            const minutes = Math.floor(durationSec / 60);
            const seconds = durationSec % 60;
            const durStr = minutes > 0 ? `${minutes} menit ${seconds} detik` : `${seconds} detik`;

            let senderDisplayName = m.pushName;
            if (!senderDisplayName || senderDisplayName === 'Pelanggan') {
              const cust = await db.getQuery("SELECT nama FROM customers WHERE nomor = ?", [senderNormalized]);
              senderDisplayName = cust?.nama && cust.nama !== 'Pelanggan' ? cust.nama : `@${senderNormalized.split('@')[0]}`;
            }

            await sock.sendMessage(jid, {
              text: `👋 Selamat kembali *${senderDisplayName}*! Status AFK kamu telah dicabut.\n📝 *Alasan sebelumnya:* ${afkData.reason}\n⏰ *Lama AFK:* ${durStr}`,
              mentions: [senderNormalized]
            }, { quoted: m });
          }
        }

        // AFK System: Cek jika ada user yang di-mention di pesan yang sedang AFK
        const mentionedJids = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const repliedJid = m.message?.extendedTextMessage?.contextInfo?.participant;
        
        const afkTargets = new Set(mentionedJids);
        if (repliedJid) afkTargets.add(repliedJid);

        if (afkTargets.size > 0) {
          for (const targetJid of afkTargets) {
            if (targetJid === senderNormalized) continue;
            const targetAfk = await db.getAfk(targetJid);
            if (targetAfk) {
              const durationSec = Math.floor((Date.now() - targetAfk.time) / 1000);
              const minutes = Math.floor(durationSec / 60);
              const seconds = durationSec % 60;
              const durStr = minutes > 0 ? `${minutes} menit ${seconds} detik` : `${seconds} detik`;

              let targetDisplayName = userPushNamesMap.get(targetJid);
              if (!targetDisplayName || targetDisplayName === 'Pelanggan') {
                const cust = await db.getQuery("SELECT nama FROM customers WHERE nomor = ?", [targetJid]);
                targetDisplayName = cust?.nama && cust.nama !== 'Pelanggan' ? cust.nama : `@${targetJid.split('@')[0]}`;
              }

              await sock.sendMessage(jid, {
                text: `⚠️ *USER SEDANG AFK!*\n\nMember *${targetDisplayName}* (@${targetJid.split('@')[0]}) sedang AFK.\n📝 *Alasan:* ${targetAfk.reason}\n⏰ *Sejak:* ${durStr} yang lalu`,
                mentions: [targetJid]
              }, { quoted: m });
            }
          }
        }


        // Award XP & Check Level Up (Grup Only)
        if (isGroup && senderNormalized) {
          try {
            const globalLevelUp = (botSettings.levelUpEnabled || "true") !== "false";
            const groupSettings = await db.getGroupSettings(jid);
            const isGroupLevelUpEnabled = globalLevelUp && (groupSettings.levelup_enabled !== 0);

            const xpResult = await db.addMessageXp(senderNormalized, 10);
            if (xpResult.leveledUp && isGroupLevelUpEnabled) {
              const userTag = `@${senderNormalized.split('@')[0]}`;
              const captionText = `🎉 *SELAMAT ${userTag}!* Kamu telah naik ke *Level ${xpResult.newLevel}*!\n🏆 *Rank:* ${xpResult.titleBadge}\n✨ *Total XP:* ${(xpResult.xp || 0).toLocaleString('id-ID')} XP`;

              try {
                let userAvatar = null;
                try { userAvatar = await sock.profilePictureUrl(senderNormalized, 'image'); } catch (e) {}

                const senderName = m.pushName || senderNormalized.split('@')[0];
                const cardBuffer = await createLevelUpCard({
                  avatarUrl: userAvatar,
                  username: senderName,
                  oldLevel: xpResult.oldLevel,
                  newLevel: xpResult.newLevel,
                  titleBadge: xpResult.titleBadge,
                  xp: xpResult.xp
                });

                await sock.sendMessage(jid, {
                  image: cardBuffer,
                  caption: captionText,
                  mentions: [senderNormalized]
                }, { quoted: m });
              } catch (canvasErr) {
                console.warn('[LEVEL_UP_CARD_FAIL] Mengirim fallback teks:', canvasErr.message);
                await sock.sendMessage(jid, {
                  text: captionText,
                  mentions: [senderNormalized]
                }, { quoted: m });
              }
            }
          } catch (e) {
            console.error('[LEVEL_UP_ERR]', e.message);
          }
        }


        console.log(`[DEBUG_MSG] Grup: ${isGroup} (${jid}), Pengirim: ${senderNormalized}, Text: "${msgText}", Admin: ${isAdmin}, Owner: ${isOwnerSender}`);

        // Cek Anti-Spam & Anti-Link (Semua pengirim dicek, namun admin tidak akan di-kick)
        if (isGroup) {
          const isHandled = await handleAntiSpamAndAntiLink(m, jid, senderNormalized, isGroup, msgText, isAdmin);
          if (isHandled) continue;
        }

        // ⚡ AUTO-DOWNLOADER SOSMED (TIKTOK & INSTAGRAM TANPA COMMAND DI GRUP)
        if (isGroup && !isPrefixCmd) {
          const gSettings = await db.getGroupSettings(jid);
          if (gSettings.auto_dl_enabled !== 0 && gSettings.bot_mode !== 'sales') {
            const tiktokRegex = /https?:\/\/(?:www\.|vt\.|vm\.|v\.)?tiktok\.com\/[^\s]+/i;
            const igRegex = /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv|stories)\/[^\s]+/i;
            
            const tiktokMatch = msgText.match(tiktokRegex);
            const igMatch = msgText.match(igRegex);

            if (tiktokMatch) {
              const url = tiktokMatch[0];
              try {
                await sock.sendMessage(jid, { react: { text: '⏳', key: m.key } });
                const res = await mediaHandler.downloadTikTok(url);
                if (res && res.success && (res.buffer || res.videoUrl)) {
                  const mediaPayload = res.buffer ? { video: res.buffer } : { video: { url: res.videoUrl } };
                  await sock.sendMessage(jid, {
                    ...mediaPayload,
                    caption: `✨ *AUTO-DOWNLOAD TIKTOK* ⚡\n\n📌 *Judul:* ${res.title || 'TikTok Video'}\n✅ *Diproses via Akbar Store Bot*`
                  }, { quoted: m });
                  await sock.sendMessage(jid, { react: { text: '✅', key: m.key } });
                  continue;
                }
              } catch (e) {
                console.error('[AUTO_DL_TT_ERR]', e.message);
              }
            } else if (igMatch) {
              const url = igMatch[0];
              try {
                await sock.sendMessage(jid, { react: { text: '⏳', key: m.key } });
                const res = await mediaHandler.downloadInstagram(url);
                if (res && res.success && (res.buffer || res.videoUrl)) {
                  const mediaPayload = res.buffer ? { video: res.buffer } : { video: { url: res.videoUrl } };
                  await sock.sendMessage(jid, {
                    ...mediaPayload,
                    caption: `✨ *AUTO-DOWNLOAD INSTAGRAM* ⚡\n\n📌 *Judul:* ${res.title || 'Instagram Reels'}\n✅ *Diproses via Akbar Store Bot*`
                  }, { quoted: m });
                  await sock.sendMessage(jid, { react: { text: '✅', key: m.key } });
                  continue;
                }
              } catch (e) {
                console.error('[AUTO_DL_IG_ERR]', e.message);
              }
            }
          }
        }

        // Ambil status percakapan (Take Over check)
        const conv = await db.getOrCreateConversation(senderNormalized);
        const isTakenOver = conv.conversation_state === 'ADMIN';

        const isGameCommand = ['nyerah', '.nyerah'].includes(msgText.toLowerCase().trim());
        const botJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
        const isReplyToBot = m.message?.extendedTextMessage?.contextInfo?.participant === botJid;

        // 🎮 Cek jika ada game Tebak Gambar aktif di chat/grup ini
        if (ent.activeGames.has(jid)) {
          const game = ent.activeGames.get(jid);
          if (isGameCommand) {
            game.isAnswered = true;
            if (game.timeout) clearTimeout(game.timeout);
            ent.activeGames.delete(jid);
            await sock.sendMessage(jid, { text: `🏳️ Kamu menyerah!\n\nJawaban yang benar adalah: *${game.answer}*` });
            continue;
          } else if (msgText.toUpperCase().trim() === game.answer) {
            if (!await db.isCustomerRegistered(senderNormalized)) {
              await sock.sendMessage(jid, { text: `⚠️ Maaf @${senderNormalized.split('@')[0]}, kamu harus terdaftar (.daftar <nama>) untuk mendapatkan poin dari mini-games!`, mentions: [senderNormalized] }, { quoted: m });
              continue;
            }
            
            game.isAnswered = true;
            if (game.timeout) clearTimeout(game.timeout);
            ent.activeGames.delete(jid);
            const timeTaken = ((Date.now() - game.startTime) / 1000).toFixed(1);
            const pointsProfile = await db.awardGamePoints(senderNormalized, game.points || 50, true);
            const safeGamePoints = Math.max(0, Math.floor(Number(pointsProfile?.points) || 0));
            await sock.sendMessage(jid, {
              text: `SELAMAT! TEBAKAN BENAR!\n\nPemenang: *@${senderNormalized.split('@')[0]}* (${m.pushName || 'Pelanggan'})\nJawaban: *${game.answer}*\nWaktu menjawab: *${timeTaken} detik*\nHadiah: *+${game.points || 50} poin game*\nTotal poin: *${safeGamePoints}*`,
              mentions: [senderNormalized]
            });
            await sock.sendMessage(jid, { react: { text: '🎉', key: m.key } });
            continue;
          } else if (isReplyToBot && msgText.trim().length > 0) {
            await sock.sendMessage(jid, { text: `❌ Tebakan *${msgText.trim()}* salah!` }, { quoted: m });
          }
        }

        // 🎮 Cek jika ada game Tebak Angka aktif
        if (ent.activeGames.has(jid + '_angka')) {
          const game = ent.activeGames.get(jid + '_angka');
          if (isGameCommand) {
            game.isAnswered = true;
            if (game.timeout) clearTimeout(game.timeout);
            ent.activeGames.delete(jid + '_angka');
            await sock.sendMessage(jid, { text: `🏳️ Kamu menyerah!\n\nAngka yang benar adalah: *${game.target}*` });
            continue;
          } else {
            const guess = parseInt(msgText.trim());
            if (!isNaN(guess)) {
              if (guess === game.target) {
                if (!await db.isCustomerRegistered(senderNormalized)) {
                  await sock.sendMessage(jid, { text: `⚠️ Maaf @${senderNormalized.split('@')[0]}, kamu harus terdaftar (.daftar <nama>) untuk mendapatkan poin dari mini-games!`, mentions: [senderNormalized] }, { quoted: m });
                } else {
                  game.isAnswered = true;
                  if (game.timeout) clearTimeout(game.timeout);
                  ent.activeGames.delete(jid + '_angka');
                  const timeTaken = ((Date.now() - game.startTime) / 1000).toFixed(1);
                  const pointsProfile = await db.awardGamePoints(senderNormalized, game.points || 40, true);
                  const safeGamePoints = Math.max(0, Math.floor(Number(pointsProfile?.points) || 0));
                  await sock.sendMessage(jid, {
                    text: `SELAMAT! TEBAKAN BENAR!\n\nPemenang: *@${senderNormalized.split('@')[0]}* (${m.pushName || 'Pelanggan'})\nAngka: *${game.answer}*\nWaktu menjawab: *${timeTaken} detik*\nHadiah: *+${game.points || 40} poin game*\nTotal poin: *${safeGamePoints}*`,
                    mentions: [senderNormalized]
                  });
                  await sock.sendMessage(jid, { react: { text: '🎉', key: m.key } });
                }
                continue;
              } else {
                // Beri petunjuk Lebih Besar/Lebih Kecil (dengan batas 3 detik sekali agar tidak spam)
                const now = Date.now();
                if (!game.lastHint || now - game.lastHint > 3000) {
                  game.lastHint = now;
                  const hint = guess < game.target ? 'Lebih Besar ⬆️' : 'Lebih Kecil ⬇️';
                  await sock.sendMessage(jid, { text: `Tebakan *${guess}* salah!\nPetunjuk: ${hint}` });
                }
              }
            } else if (isReplyToBot && msgText.trim().length > 0) {
              await sock.sendMessage(jid, { text: `❌ Itu bukan angka yang valid!` }, { quoted: m });
            }
          }
        }

        // 🎮 Cek jika ada game Susun Kata aktif
        if (ent.activeGames.has(jid + '_susunkata')) {
          const game = ent.activeGames.get(jid + '_susunkata');
          if (isGameCommand) {
            game.isAnswered = true;
            if (game.timeout) clearTimeout(game.timeout);
            ent.activeGames.delete(jid + '_susunkata');
            await sock.sendMessage(jid, { text: `🏳️ Kamu menyerah!\n\nKata yang benar adalah: *${game.answer}*` });
            continue;
          } else if (msgText.toUpperCase().trim() === game.answer) {
            if (!await db.isCustomerRegistered(senderNormalized)) {
              await sock.sendMessage(jid, { text: `⚠️ Maaf @${senderNormalized.split('@')[0]}, kamu harus terdaftar (.daftar <nama>) untuk mendapatkan poin dari mini-games!`, mentions: [senderNormalized] }, { quoted: m });
              continue;
            }
            
            game.isAnswered = true;
            if (game.timeout) clearTimeout(game.timeout);
            ent.activeGames.delete(jid + '_susunkata');
            const timeTaken = ((Date.now() - game.startTime) / 1000).toFixed(1);
            const pointsProfile = await db.awardGamePoints(senderNormalized, game.points || 30, true);
            const safeGamePoints = Math.max(0, Math.floor(Number(pointsProfile?.points) || 0));
            await sock.sendMessage(jid, {
              text: `SELAMAT! SUSUNAN KATA BENAR!\n\nPemenang: *@${senderNormalized.split('@')[0]}* (${m.pushName || 'Pelanggan'})\nKata: *${game.answer}*\nWaktu menjawab: *${timeTaken} detik*\nHadiah: *+${game.points || 30} poin game*\nTotal poin: *${safeGamePoints}*`,
              mentions: [senderNormalized]
            });
            await sock.sendMessage(jid, { react: { text: '🎉', key: m.key } });
            continue;
          } else if (isReplyToBot && msgText.trim().length > 0) {
            await sock.sendMessage(jid, { text: `❌ Tebakan *${msgText.trim()}* salah!` }, { quoted: m });
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
          
          const isPdfMergeFile = await checkPdfMergeSession(sock, m, senderNormalized, jid);
          if (isPdfMergeFile) continue;

          const isPlugin = await executePlugin(routerCleanCmd, { sock, jid, senderNumber: senderNormalized, m, msgText, args: routerArgs, cleanCmd: routerCleanCmd, isAdmin });
          
          if (!isPlugin) {
            const isPdfCmd = await handlePdfCommands(sock, m, senderNormalized, jid, routerCleanCmd, routerArgs, isGroup, null);
            if (isPdfCmd) continue;

            const isPrem = await handlePremiumCommand({ sock, jid, senderNumber: senderNormalized, messageObj: m, args: routerArgs, cleanCmd: routerCleanCmd, isAdmin, isOwner: isOwnerSender });
            if (!isPrem) {
              const isFun = await handleFunCommand({ sock, jid, senderNumber: senderNormalized, messageObj: m, text: msgText, args: routerArgs, cleanCmd: routerCleanCmd, isFromGroup: false, isAdmin, isOwner: isOwnerSender });
              if (!isFun) {
                const isMedia = await handleMediaCommands(jid, senderNormalized, m, msgText);
                if (isMedia) continue;
                const isHandledAdmin = await handleGroupMessage(jid, senderNormalized, m, msgText, isAdmin, isPrefixCmd, { isAdmin, isOwner: isOwnerSender });
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
          }
        } else {
          // Menangani Pesan Grup di SEMUA Grup tempat Bot bergabung
          const routerArgs = msgText.trim().split(/\s+/);
          const routerRawCmd = routerArgs[0].toLowerCase();
          const routerCleanCmd = routerRawCmd.replace(/^[./#]/, '');

          // Check sesi penggabungan PDF aktif di grup
          const isPdfMergeFile = await checkPdfMergeSession(sock, m, senderNormalized, jid);
          if (isPdfMergeFile) continue;

          const isPlugin = await executePlugin(routerCleanCmd, { sock, jid, senderNumber: senderNormalized, m, msgText, args: routerArgs, cleanCmd: routerCleanCmd, isAdmin });

          if (!isPlugin) {
            // Check perintah PDF di grup (.pdf, .pdfmerge, .topdf, dll)
            const isPdfCmd = await handlePdfCommands(sock, m, senderNormalized, jid, routerCleanCmd, routerArgs, true, null);
            if (isPdfCmd) continue;

            const isPrem = await handlePremiumCommand({ sock, jid, senderNumber: senderNormalized, messageObj: m, args: routerArgs, cleanCmd: routerCleanCmd, isAdmin, isOwner: isOwnerSender });
            if (!isPrem) {
              const isFun = await handleFunCommand({ sock, jid, senderNumber: senderNormalized, messageObj: m, text: msgText, args: routerArgs, cleanCmd: routerCleanCmd, isFromGroup: true, isAdmin, isOwner: isOwnerSender });
              if (!isFun) {
                const isMedia = await handleMediaCommands(jid, senderNormalized, m, msgText);
                if (isMedia) continue;
                const isHandledAdmin = await handleGroupMessage(jid, senderNormalized, m, msgText, isAdmin, isPrefixCmd, { isAdmin, isOwner: isOwnerSender });
                if (!isHandledAdmin) {
                  // Perintah pelanggan (list, menu, buy, checkout, status, dll) di grup
                  await handleCustomerMessage(jid, senderNormalized, m, msgText, true, { isAdmin, isOwner: isOwnerSender });
                }
              }
            }
          }

        }
      }
    } catch (err) {
      console.error('Error saat memproses pesan masuk:', err);
    }
  });

  // ==========================================
  // CRON JOB: GROUP RENTALS AUTO-LEAVE (SINGLETON)
  // ==========================================
  if (!global.groupRentalCronStarted) {
    global.groupRentalCronStarted = true;
    setInterval(async () => {
      try {
        if (!sock || !botState.whatsappConnected) return;
        const expiredGroups = await db.getExpiredGroupRentals();
        for (const rent of expiredGroups) {
          console.log(`[GROUP RENTAL] Waktu sewa habis untuk grup ${rent.group_jid}`);
          try {
            await sock.sendMessage(rent.group_jid, { text: `Waktu sewa bot di grup ini telah habis. Hubungi owner untuk memperpanjang.\n\nBye! 👋` });
            await new Promise(r => setTimeout(r, 2000));
            await sock.groupLeave(rent.group_jid);
          } catch (e) {
            console.error(`[GROUP RENTAL] Gagal leave grup ${rent.group_jid}:`, e.message);
          }
          await db.removeGroupRental(rent.group_jid);
        }
      } catch (err) {
        console.error('[GROUP RENTAL CRON] Error:', err.message);
      }
    }, 60 * 60 * 1000); // Berjalan setiap 1 jam
  }

}

// ==========================================
// LOGIKA PESAN PELANGGAN (DM & GRUP UTAMA)
// ==========================================

// ==========================================
// LOGIKA PESAN GRUP (ADMIN GROUP / GET JID)
// ==========================================

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
