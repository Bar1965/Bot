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
import { buildCommandMenu } from './commandRegistry.js';
import { createWelcomeGoodbyeCard, createLevelUpCard } from './cardGenerator.js';




// Setup Logger
const logger = P({ level: 'info' });

let sock = null;
let botSettings = {};
const userPushNamesMap = new Map();

// Helper parsing durasi waktu untuk ban sementara
function parseDuration(argsList) {
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
      const amount = parseInt(argsCheck[1]);
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
      const amount = parseInt(argsCheck[1]);
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
      const targetStr = argsCheck[1];
      const amount = parseInt(argsCheck[2]);
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
      
      const targetStr = argsCheck[1];
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
      const bet = parseInt(argsCheck[1]);
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
      const bet = parseInt(argsCheck[1]);
      const color = argsCheck[2]?.toLowerCase();
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

    // 26. Menfess / Confess Pesan Anonim (.menfess, .confess)
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

      try {
        await react('⏳');
        
        let menfessMsg = `💌 *MENFESS / CONFESS (PESAN ANONIM)*\n\n`;
        menfessMsg += `Halo! Kamu menerima pesan rahasia dari seseorang:\n\n`;
        menfessMsg += `💬 *"${messageText}"*\n\n`;
        menfessMsg += `_Pesan ini dikirim secara anonim melalui Akbar Store Bot._`;

        await sock.sendMessage(targetJid, { text: menfessMsg });
        
        await db.addLog("MODERATION", `Anonim mengirim menfess ke ${targetJid}`);
        
        await sock.sendMessage(jid, { text: `✅ *Menfess Terkirim!* Pesan rahasia Anda telah dikirimkan secara anonim ke target.` });
        await react('💌');
      } catch (err) {
        await react('❌');
        console.error("[MENFESS_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal mengirim menfess: ${err.message}` });
      }
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

        // Cek apakah sender adalah Owner (by fromMe, stored JID exact match, atau phone digit match)
        let isOwnerSender = false;
        if (m.key?.fromMe) {
          isOwnerSender = true; // Pesan dari bot sendiri (linked device owner) — paling reliable
        } else if (storedOwnerJid && senderNormalized === storedOwnerJid) {
          isOwnerSender = true; // Exact JID match (handles @lid yang disimpan via .setownerid)
        } else if (ownerPhoneDigits && senderDigits && senderDigits.length > 6 && (senderDigits === ownerPhoneDigits || senderDigits.endsWith(ownerPhoneDigits) || ownerPhoneDigits.endsWith(senderDigits))) {
          isOwnerSender = true; // Phone number match dengan toleransi kode negara (works in DM)
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

        // ====================================================================
        // PROTEKSI WAJIB REGISTRASI MEMBER (.daftar <nama>) & ANTI-SPAM
        // ====================================================================
        const argsCheck = msgText.trim().split(/\s+/);
        const rawCmdCheck = argsCheck[0].toLowerCase();
        const cleanCmdCheck = rawCmdCheck.replace(/^[./#]/, '');

        const isPrefixCmd = msgText.startsWith('.') || msgText.startsWith('/') || msgText.startsWith('#');
        const knownCmdList = [
          'daftar', 'register', 'registrasi', 'owner', 'kontakowner', 'menu', 'help', 'bantuan', 
          'produk', 'beli', 'checkout', 'keranjang', 'cart', 'status', 'riwayat', 'batal', 'cancel',
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
          'welcome', 'setwelcome', 'link', 'getjid', 'backup', 'eval', 'join'
        ];


        const isBotCommand = isPrefixCmd || knownCmdList.includes(cleanCmdCheck);
        const exemptCommands = ['daftar', 'register', 'registrasi', 'owner', 'kontakowner', 'menu', 'help', 'bantuan', 'ping', 'statusbot'];

        if (isBotCommand && !exemptCommands.includes(cleanCmdCheck) && !isAdmin) {
          const isRegistered = await db.isCustomerRegistered(senderNormalized);
          if (!isRegistered) {
            const senderMention = senderNormalized.split('@')[0];
            const regNotice = `⚠️ *AKSES DITOLAK — REGISTRASI DIPERLUKAN* ⚠️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nHalo @${senderMention}! Untuk dapat menggunakan fitur bot kami & mencegah spam, Anda harus terdaftar sebagai member terlebih dahulu (100% Gratis).\n\n📌 *Cara Pendaftaran (Hanya 5 Detik):*\nKetik: \`.daftar Nama Kamu\`\n\n_Contoh:_ \`.daftar Budi Santoso\`\n\nSetelah terdaftar, Anda dapat langsung menikmati semua fitur katalog, transaksi, game, dan hiburan! 🙏`;
            
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
            const xpResult = await db.addMessageXp(senderNormalized, 10);
            if (xpResult.leveledUp) {
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

              const userTag = `@${senderNormalized.split('@')[0]}`;
              await sock.sendMessage(jid, {
                image: cardBuffer,
                caption: `🎉 *SELAMAT ${userTag}!* Kamu telah naik ke *Level ${xpResult.newLevel}*!\n🏆 *Rank:* ${xpResult.titleBadge}`,
                mentions: [senderNormalized]
              }, { quoted: m });
            }
          } catch (e) {
            console.error('[LEVEL_UP_ERR]', e.message);
          }
        }

        // Cek jika ini adalah perintah media utility (.tt, .ig, .yt, .stiker, .gif, .toimg, .hd)
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
          const isPlugin = await executePlugin(routerCleanCmd, { sock, jid, senderNumber: senderNormalized, m, msgText, args: routerArgs, cleanCmd: routerCleanCmd, isAdmin });
          
          if (!isPlugin) {
            const isPrem = await handlePremiumCommand({ sock, jid, senderNumber: senderNormalized, messageObj: m, args: routerArgs, cleanCmd: routerCleanCmd, isAdmin, isOwner: isOwnerSender });
            if (!isPrem) {
              const isFun = await handleFunCommand({ sock, jid, senderNumber: senderNormalized, messageObj: m, text: msgText, args: routerArgs, cleanCmd: routerCleanCmd, isFromGroup: false, isAdmin, isOwner: isOwnerSender });
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
          }
        } else {
          // Menangani Pesan Grup di SEMUA Grup tempat Bot bergabung
          const routerArgs = msgText.trim().split(/\s+/);
          const routerRawCmd = routerArgs[0].toLowerCase();
          const routerCleanCmd = routerRawCmd.replace(/^[./#]/, '');
          const isPlugin = await executePlugin(routerCleanCmd, { sock, jid, senderNumber: senderNormalized, m, msgText, args: routerArgs, cleanCmd: routerCleanCmd, isAdmin });

          if (!isPlugin) {
            const isPrem = await handlePremiumCommand({ sock, jid, senderNumber: senderNormalized, messageObj: m, args: routerArgs, cleanCmd: routerCleanCmd, isAdmin, isOwner: isOwnerSender });
            if (!isPrem) {
              const isFun = await handleFunCommand({ sock, jid, senderNumber: senderNormalized, messageObj: m, text: msgText, args: routerArgs, cleanCmd: routerCleanCmd, isFromGroup: true, isAdmin, isOwner: isOwnerSender });
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
      }
    } catch (err) {
      console.error('Error saat memproses pesan masuk:', err);
    }
  });

  // ==========================================
  // CRON JOB: GROUP RENTALS AUTO-LEAVE
  // ==========================================
  setInterval(async () => {
    try {
      const expiredGroups = await db.getExpiredGroupRentals();
      for (const rent of expiredGroups) {
        console.log(`[GROUP RENTAL] Waktu sewa habis untuk grup ${rent.group_jid}`);
        try {
          await sock.sendMessage(rent.group_jid, { text: `Waktu sewa bot di grup ini telah habis. Hubungi owner untuk memperpanjang.\n\nBye! 👋` });
          // Tunggu sebentar sebelum keluar agar pesan terkirim
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

// ==========================================
// LOGIKA PESAN PELANGGAN (DM & GRUP UTAMA)
// ==========================================
// [MOVED] async function handleCustomerMessage(jid, senderNumber, messageObj, text, isFromGroup = false, actor = {}) {
// [MOVED]   const textLower = text.toLowerCase();
// [MOVED]   const cleanTextLower = textLower.replace(/^[./#]/, '').trim();
// [MOVED]   const args = text.trim().split(/\s+/);
// [MOVED]   const rawCmd = args[0].toLowerCase();
// [MOVED]   const cleanCmd = rawCmd.replace(/^[./#]/, '');
// [MOVED] 
// [MOVED]   const customerName = messageObj.pushName || "Pelanggan";
// [MOVED]   await db.getOrCreateCustomer(senderNumber, customerName);
// [MOVED] 
// [MOVED]   const memberProfile = await db.getCustomerMembershipProfile(senderNumber);
// [MOVED]   const isPrivateCommand =
// [MOVED]     ['beli', 'buy'].includes(cleanCmd) ||
// [MOVED]     ['cart', 'keranjang', 'checkout', 'bayar', 'cancel', 'batal', 'status', 'riwayat', 'history'].includes(cleanCmd);
// [MOVED]   const responseJid = (isFromGroup && isPrivateCommand) ? senderNumber : jid;
// [MOVED] 
// [MOVED]   if (memberProfile?.account_status === 'BANNED' && !actor.isAdmin) {
// [MOVED]     await sock.sendMessage(jid, { text: '⛔ Akun kamu sedang diblokir dari layanan bot. Hubungi Owner jika merasa ini kesalahan.' });
// [MOVED]     return true;
// [MOVED]   }
// [MOVED] 
// [MOVED]   if (['daftar', 'register', 'registrasi'].includes(cleanCmd)) {
// [MOVED]     const requestedName = args.slice(1).join(' ').trim();
// [MOVED]     if (!requestedName) {
// [MOVED]       await sock.sendMessage(responseJid, { text: 'Format: `.daftar Nama Kamu`\nContoh: `.daftar Budi Santoso`' });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED]     try {
// [MOVED]       const profile = await db.registerCustomer(senderNumber, requestedName);
// [MOVED]       await sock.sendMessage(responseJid, { text: `✅ *Registrasi berhasil!*\n\nNama: *${profile.nama}*\nStatus: *${profile.account_status}*\nRole: *${actor.isOwner ? 'OWNER' : profile.role}*\nTier: *${profile.tier}*\n\nKetik *.profil* untuk melihat profil lengkap.` });
// [MOVED]     } catch (error) {
// [MOVED]       await sock.sendMessage(responseJid, { text: `❌ Registrasi gagal: ${error.message}` });
// [MOVED]     }
// [MOVED]     return true;
// [MOVED]   }
// [MOVED] 
// [MOVED]   const extractTargetMember = () => {
// [MOVED]     const mentioned = messageObj.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
// [MOVED]     const rawTarget = mentioned || args[1];
// [MOVED]     if (!rawTarget) return null;
// [MOVED]     if (rawTarget.includes('@')) return jidNormalizedUser(rawTarget);
// [MOVED]     const digits = rawTarget.replace(/\D/g, '');
// [MOVED]     return digits ? `${digits}@s.whatsapp.net` : null;
// [MOVED]   };
// [MOVED] 
// [MOVED]   if (['profil', 'akun', 'member', 'statusakun'].includes(cleanCmd)) {
// [MOVED]     const targetJid = extractTargetMember() || senderNumber;
// [MOVED]     const profile = await db.getCustomerMembershipProfile(targetJid);
// [MOVED]     const phoneNum = targetJid.split('@')[0];
// [MOVED] 
// [MOVED]     const formatWib = (dateStr) => {
// [MOVED]       if (!dateStr) return '-';
// [MOVED]       try {
// [MOVED]         const isoStr = dateStr.includes('Z') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
// [MOVED]         const d = new Date(isoStr);
// [MOVED]         if (isNaN(d.getTime())) return dateStr;
// [MOVED]         return d.toLocaleString('id-ID', {
// [MOVED]           timeZone: 'Asia/Jakarta',
// [MOVED]           day: '2-digit',
// [MOVED]           month: '2-digit',
// [MOVED]           year: 'numeric',
// [MOVED]           hour: '2-digit',
// [MOVED]           minute: '2-digit'
// [MOVED]         }) + ' WIB';
// [MOVED]       } catch (e) {
// [MOVED]         return dateStr;
// [MOVED]       }
// [MOVED]     };
// [MOVED] 
// [MOVED]     const role = (targetJid === senderNumber && actor.isOwner) ? 'OWNER' : (profile?.role || 'MEMBER');
// [MOVED]     const isRegistered = profile?.profile_completed === 1;
// [MOVED]     const regStatus = isRegistered ? '✅ Terdaftar' : '⚠️ Belum lengkap (ketik .daftar <nama>)';
// [MOVED]     const regDate = isRegistered ? formatWib(profile?.registered_at) : 'Belum pernah registrasi';
// [MOVED]     const lastSeen = formatWib(profile?.last_seen_at);
// [MOVED]     const isSelf = targetJid === senderNumber;
// [MOVED]     const headerTitle = isSelf ? '👤 *INFORMASI PROFIL SAYA*' : `👤 *INFORMASI PROFIL MEMBER* (@${phoneNum})`;
// [MOVED] 
// [MOVED]     let text = `${headerTitle}\n`;
// [MOVED]     text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
// [MOVED]     text += `📋 *DATA REGISTRASI*\n`;
// [MOVED]     text += `▫️ Nama Terdaftar: *${profile?.nama || customerName}*\n`;
// [MOVED]     text += `▫️ Nomor WA: *+${phoneNum}*\n`;
// [MOVED]     text += `▫️ Status Akun: *${profile?.account_status || 'ACTIVE'}*\n`;
// [MOVED]     text += `▫️ Role: *${role}*\n`;
// [MOVED]     text += `▫️ Status Registrasi: *${regStatus}*\n`;
// [MOVED]     text += `▫️ Tanggal Daftar: *${regDate}*\n`;
// [MOVED]     text += `▫️ Terakhir Aktif: *${lastSeen}*\n\n`;
// [MOVED] 
// [MOVED]     text += `💳 *KEUANGAN & KEANGGOTAAN*\n`;
// [MOVED]     text += `▫️ Tier Pelanggan: *${profile?.tier || 'BRONZE'}*\n`;
// [MOVED]     text += `▫️ Saldo Akun: *Rp${(profile?.balance || 0).toLocaleString('id-ID')}*\n`;
// [MOVED]     text += `▫️ Poin Loyalty: *${profile?.loyalty_points || 0} pts*\n`;
// [MOVED]     if (profile?.referral_code) {
// [MOVED]       text += `▫️ Kode Referral: *${profile.referral_code}*\n`;
// [MOVED]     }
// [MOVED]     if (profile?.referred_by) {
// [MOVED]       text += `▫️ Di-referral oleh: *${profile.referred_by}*\n`;
// [MOVED]     }
// [MOVED]     text += `\n`;
// [MOVED] 
// [MOVED]     text += `🛒 *STATISTIK TRANSAKSI*\n`;
// [MOVED]     text += `▫️ Total Pesanan: *${profile?.total_orders || 0} order*\n`;
// [MOVED]     text += `▫️ Total Belanja: *Rp${(profile?.total_spend || 0).toLocaleString('id-ID')}*\n\n`;
// [MOVED] 
// [MOVED]     text += `🎮 *STATISTIK GAME & POIN*\n`;
// [MOVED]     text += `▫️ Level Game: *Lv.${profile?.game_level || 1}* (${profile?.game_xp || 0} XP)\n`;
// [MOVED]     text += `▫️ Poin Game: *${profile?.game_points || 0} poin*\n`;
// [MOVED]     text += `▫️ Streak Daily: *${profile?.game_streak || 0} hari*`;
// [MOVED] 
// [MOVED]     await sock.sendMessage(responseJid, { 
// [MOVED]       text,
// [MOVED]       mentions: [targetJid]
// [MOVED]     });
// [MOVED]     return true;
// [MOVED]   }
// [MOVED] 
// [MOVED]   if (['setmemberrole', 'memberrole'].includes(cleanCmd)) {
// [MOVED]     if (!actor.isOwner) {
// [MOVED]       await sock.sendMessage(responseJid, { text: '⛔ Hanya Owner yang boleh mengubah role member.' });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED]     const target = extractTargetMember();
// [MOVED]     const role = args[2] || args[1];
// [MOVED]     if (!target || !role) {
// [MOVED]       await sock.sendMessage(responseJid, { text: 'Format: `.setmemberrole @member MEMBER|ADMIN`' });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED]     try {
// [MOVED]       const profile = await db.updateCustomerRole(target, role);
// [MOVED]       await sock.sendMessage(responseJid, { text: `✅ Role *${profile.nama}* diubah menjadi *${profile.role}*.` });
// [MOVED]     } catch (error) {
// [MOVED]       await sock.sendMessage(responseJid, { text: `❌ Gagal mengubah role: ${error.message}` });
// [MOVED]     }
// [MOVED]     return true;
// [MOVED]   }
// [MOVED] 
// [MOVED]   if (['setmemberstatus', 'memberstatus'].includes(cleanCmd)) {
// [MOVED]     if (!actor.isAdmin) {
// [MOVED]       await sock.sendMessage(responseJid, { text: '⛔ Hanya Admin atau Owner yang boleh mengubah status member.' });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED]     const target = extractTargetMember();
// [MOVED]     const status = args[2] || args[1];
// [MOVED]     if (!target || !status) {
// [MOVED]       await sock.sendMessage(responseJid, { text: 'Format: `.setmemberstatus @member ACTIVE|INACTIVE|BANNED`' });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED]     try {
// [MOVED]       const profile = await db.updateCustomerAccountStatus(target, status);
// [MOVED]       await sock.sendMessage(responseJid, { text: `✅ Status *${profile.nama}* diubah menjadi *${profile.account_status}*.` });
// [MOVED]     } catch (error) {
// [MOVED]       await sock.sendMessage(responseJid, { text: `❌ Gagal mengubah status: ${error.message}` });
// [MOVED]     }
// [MOVED]     return true;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // Fungsi kirim notifikasi redirect di grup pembeli
// [MOVED]   const sendRedirectNotice = async () => {
// [MOVED]     if (isFromGroup && isPrivateCommand) {
// [MOVED]       const mentionJid = senderNumber.split('@')[0];
// [MOVED]       await sock.sendMessage(jid, { 
// [MOVED]         text: `⚠️ *Keamanan Transaksi:* Halo @${mentionJid}, demi keamanan informasi belanja & link pembayaran Anda, rincian transaksi telah kami kirimkan langsung ke *Chat Pribadi (DM)* Anda. Silakan periksa pesan masuk dari nomor bot ini.`,
// [MOVED]         mentions: [senderNumber]
// [MOVED]       });
// [MOVED]     }
// [MOVED]   };
// [MOVED] 
// [MOVED]   // 🥚 EASTER EGG MEME: "Kapan Kapan yh sayang"
// [MOVED]   const cleanMemeText = text.toLowerCase().trim().replace(/[?!.,~_*-]+/g, '');
// [MOVED]   const kapanMemeRegex = /^(?:kapan|kpn|wen|wnn|kpnn+|kpann+|(?:kapan|kpn)[-\s]?2|kapankapan)\s*(?:yah+|ya+|y+|yh+|nih+|tuh+|dong+|dng+|dek+)?$/i;
// [MOVED]   if (kapanMemeRegex.test(cleanMemeText)) {
// [MOVED]     try {
// [MOVED]       await sock.sendMessage(jid, { react: { text: '😜', key: messageObj.key } });
// [MOVED]     } catch (e) {}
// [MOVED]     await sock.sendMessage(jid, { 
// [MOVED]       text: "✨ *Kapan Kapan yh sayang...* 🤪💖\n\n_~ Basa-basi dulu, keputusannya nanti-nanti aja deh! 🙈✨_" 
// [MOVED]     }, { quoted: messageObj });
// [MOVED]     return true;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // ==========================================
// [MOVED]   // LOGIKA NAVIGASI MENU TERKATEGORI (ASCII ART DESIGN)
// [MOVED]   // ==========================================
// [MOVED]   const menuMatch = cleanTextLower.match(/^(?:menu|help|bantuan)(?:\s+(1|2|3|4|5|6|jualan|produk|transaksi|bayar|downloader|media|hiburan|game|games|fun|promo|diskon|referral|poin|rank|reward|favorit|wishlist|admin|daftar|registrasi|profil|akun|setmemberrole|memberrole|setmemberstatus|memberstatus|all|semua))?$/i);
// [MOVED] 
// [MOVED]   if (menuMatch) {
// [MOVED]     const subCat = menuMatch[1] ? menuMatch[1].toLowerCase() : '';
// [MOVED] 
// [MOVED]     // Deteksi mode grup (Sales Mode vs All Mode)
// [MOVED]     let isSalesModeGroup = false;
// [MOVED]     if (isFromGroup) {
// [MOVED]       const gSettings = await db.getGroupSettings(jid);
// [MOVED]       if (gSettings.bot_mode === 'sales') {
// [MOVED]         isSalesModeGroup = true;
// [MOVED]       }
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (isSalesModeGroup && ['3', 'downloader', 'media', 'hiburan', '4', 'game', 'games', 'fun'].includes(subCat)) {
// [MOVED]       await sock.sendMessage(responseJid, { 
// [MOVED]         text: "🛍️ *MODE JUALAN AKTIF:* Grup ini berada dalam *Mode Jualan/Toko*. Fitur media, downloader, dan game tidak diaktifkan di grup ini agar grup tetap tertib khusus jualan." 
// [MOVED]       });
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     const organizedMenu = buildCommandMenu(subCat || 'all', { salesMode: isSalesModeGroup });
// [MOVED]     if (organizedMenu) {
// [MOVED]       await sock.sendMessage(responseJid, { text: organizedMenu });
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // Hitung Uptime
// [MOVED]     const uptimeSec = Math.floor(process.uptime());
// [MOVED]     const hours = Math.floor(uptimeSec / 3600);
// [MOVED]     const mins = Math.floor((uptimeSec % 3600) / 60);
// [MOVED]     const secs = uptimeSec % 60;
// [MOVED]     const uptimeStr = `${hours}j ${mins}m ${secs}d`;
// [MOVED]     const storeTitle = (botSettings.storeName || config.defaults.storeName).toUpperCase();
// [MOVED]     const modeBadge = isSalesModeGroup ? "🛍️ MODE JUALAN" : "🌐 MODE ALL";
// [MOVED] 
// [MOVED]     const headerCard = `📋 *MENU UTAMA TOKO*
// [MOVED] ━━━━━━━━━━━━━━━━━━━
// [MOVED] 👤 *User:* ${customerName}
// [MOVED] ⏱️ *Uptime:* ${uptimeStr}
// [MOVED] ⚙️ *Mode:* ${modeBadge}
// [MOVED] ⌨️ *Prefix:* \`.\` / \`/\` / \`#\`
// [MOVED] ━━━━━━━━━━━━━━━━━━━\n\n`;
// [MOVED] 
// [MOVED]     // Sub-Menu 1: Jualan & Produk
// [MOVED]     if (['1', 'jualan', 'produk'].includes(subCat)) {
// [MOVED]       const msg = headerCard + `🛍️ *PRODUK & JUALAN*
// [MOVED] ▫️ \`.produk\` — Katalog & sisa stok produk
// [MOVED] ▫️ \`.beli <kode> <qty>\` — Beli produk digital
// [MOVED] ▫️ \`.cari <kata kunci>\` — Cari produk toko
// [MOVED] ▫️ \`.bundle\` — Lihat paket hemat bundling
// [MOVED] 
// [MOVED] ━━━━━━━━━━━━━━━━━━━
// [MOVED] 💡 _Contoh penggunaan: .produk atau .beli NET01 1_`;
// [MOVED]       await sendInteractiveButtons(sock, responseJid, {
// [MOVED]         text: msg,
// [MOVED]         title: '🛍️ PRODUK & JUALAN',
// [MOVED]         footer: 'Pilih aksi di bawah atau ketik perintah langsung',
// [MOVED]         buttons: [
// [MOVED]           { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' },
// [MOVED]           { type: 'reply', text: '🛒 Keranjang Saya', id: '.keranjang' },
// [MOVED]           { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
// [MOVED]         ]
// [MOVED]       });
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // Sub-Menu 2: Transaksi & Pembayaran
// [MOVED]     if (['2', 'transaksi', 'bayar'].includes(subCat)) {
// [MOVED]       const msg = headerCard + `🛒 *TRANSAKSI & PEMBAYARAN*
// [MOVED] ▫️ \`.keranjang\` — Cek isi keranjang belanja
// [MOVED] ▫️ \`.checkout\` — Link pembayaran QRIS/Midtrans
// [MOVED] ▫️ \`.status\` — Cek status transaksi terbaru
// [MOVED] ▫️ \`.riwayat\` — 5 riwayat transaksi terakhir
// [MOVED] ▫️ \`.batal\` — Batalkan pesanan aktif
// [MOVED] 
// [MOVED] ━━━━━━━━━━━━━━━━━━━
// [MOVED] 💡 _Contoh penggunaan: .keranjang atau .status_`;
// [MOVED]       await sendInteractiveButtons(sock, responseJid, {
// [MOVED]         text: msg,
// [MOVED]         title: '🛒 TRANSAKSI & PEMBAYARAN',
// [MOVED]         footer: 'Pilih opsi transaksi di bawah ini',
// [MOVED]         buttons: [
// [MOVED]           { type: 'reply', text: '🛒 Keranjang', id: '.keranjang' },
// [MOVED]           { type: 'reply', text: '💳 Checkout', id: '.checkout' },
// [MOVED]           { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
// [MOVED]         ]
// [MOVED]       });
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // Sub-Menu 3: Downloader, Media & Hiburan
// [MOVED]     if (['3', 'downloader', 'media', 'hiburan', 'game'].includes(subCat)) {
// [MOVED]       const msg = headerCard + `📥 *DOWNLOADER & MEDIA*
// [MOVED] ▫️ \`.tt <link>\` — Download video TikTok
// [MOVED] ▫️ \`.ig <link>\` — Download Reels/Foto IG
// [MOVED] ▫️ \`.fb <link>\` — Download video Facebook
// [MOVED] ▫️ \`.yt <link>\` — Download MP3/MP4 YouTube
// [MOVED] ▫️ \`.stiker\` — Foto/Video ke Stiker WA
// [MOVED] ▫️ \`.toimg\` / \`.tovid\` — Stiker ke Foto/Video
// [MOVED] ▫️ \`.qc <teks>\` — Stiker Quote Chat
// [MOVED] ▫️ \`.brat <teks>\` — Stiker Brat Aesthetics
// [MOVED] ▫️ \`.draw <prompt>\` — Generate foto AI
// [MOVED] ▫️ \`.hd\` — Jernihkan foto buram
// [MOVED] ▫️ \`.tts <teks>\` — Ubah teks ke Voice Note
// [MOVED] 
// [MOVED] 🎮 *HIBURAN & GAME*
// [MOVED] ▫️ \`.khodam <nama>\` — Cek khodam lucu
// [MOVED] ▫️ \`.susunkata\` — Game anagram kata
// [MOVED] ▫️ \`.tebakangka\` — Game tebak angka 1-100
// [MOVED] ▫️ \`.tebakgambar\` — Game tebak gambar
// [MOVED] 
// [MOVED] ━━━━━━━━━━━━━━━━━━━
// [MOVED] 💡 _Contoh penggunaan: .brat kamu nanya? atau .tebakangka_`;
// [MOVED]       await sendInteractiveButtons(sock, responseJid, {
// [MOVED]         text: msg,
// [MOVED]         title: '📥 MEDIA & GAME',
// [MOVED]         footer: 'Pilih aksi cepat di bawah ini',
// [MOVED]         buttons: [
// [MOVED]           { type: 'reply', text: '💸 Bank & Ekonomi', id: '.menu bank' },
// [MOVED]           { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' },
// [MOVED]           { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
// [MOVED]         ]
// [MOVED]       });
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // Sub-Menu 4: Promo & Diskon
// [MOVED]     if (['4', 'promo', 'diskon', 'referral'].includes(subCat)) {
// [MOVED]       const msg = headerCard + `🎟️ *PROMO & REFERRAL*
// [MOVED] ▫️ \`.kupon <kode>\` — Gunakan kupon diskon
// [MOVED] ▫️ \`.referral\` — Ajak teman & dapatkan kupon 10%
// [MOVED] ▫️ \`.bundle\` — Lihat paket hemat bundling
// [MOVED] 
// [MOVED] ━━━━━━━━━━━━━━━━━━━
// [MOVED] 💡 _Contoh penggunaan: .kupon DISKON10_`;
// [MOVED]       await sendInteractiveButtons(sock, responseJid, {
// [MOVED]         text: msg,
// [MOVED]         title: '🎟️ PROMO & REFERRAL',
// [MOVED]         footer: 'Ajak teman & nikmati diskon',
// [MOVED]         buttons: [
// [MOVED]           { type: 'reply', text: '👥 Program Referral', id: '.referral' },
// [MOVED]           { type: 'reply', text: '📦 Paket Bundle', id: '.bundle' },
// [MOVED]           { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
// [MOVED]         ]
// [MOVED]       });
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // Sub-Menu 5: Wishlist & Notifikasi Stok
// [MOVED]     if (['5', 'favorit', 'wishlist'].includes(subCat)) {
// [MOVED]       const msg = headerCard + `💝 *FAVORIT & NOTIFIKASI*
// [MOVED] ▫️ \`.simpan <kode>\` — Simpan produk ke wishlist
// [MOVED] ▫️ \`.favorit\` — Lihat daftar produk favorit
// [MOVED] ▫️ \`.notify <kode>\` — Langganan notifikasi restok
// [MOVED] 
// [MOVED] ━━━━━━━━━━━━━━━━━━━
// [MOVED] 💡 _Contoh penggunaan: .favorit atau .notify NET01_`;
// [MOVED]       await sendInteractiveButtons(sock, responseJid, {
// [MOVED]         text: msg,
// [MOVED]         title: '💝 FAVORIT & WISHLIST',
// [MOVED]         footer: 'Kelola produk impian Anda',
// [MOVED]         buttons: [
// [MOVED]           { type: 'reply', text: '💝 Lihat Wishlist', id: '.favorit' },
// [MOVED]           { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' },
// [MOVED]           { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
// [MOVED]         ]
// [MOVED]       });
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // Sub-Menu 6: Admin & Owner
// [MOVED]     if (['6', 'admin'].includes(subCat)) {
// [MOVED]       const msg = headerCard + `👑 *ADMIN & OWNER*
// [MOVED] ▫️ \`.owner\` — Kontak resmi Pemilik Toko
// [MOVED] ▫️ \`.ping\` — Cek status & kecepatan respon
// [MOVED] ▫️ \`.mode <jualan/all>\` — Atur mode grup
// [MOVED] ▫️ \`.join <link> <hari>\` — Masukkan bot ke grup via link
// [MOVED] ▫️ \`.antidelete\` — Nyala/matikan fitur anti-hapus pesan
// [MOVED] ▫️ \`.autosholat <on/off>\` — Nyala/matikan fitur adzan per-grup
// [MOVED] ▫️ \`.paid <order_id>\` — Konfirmasi pembayaran
// [MOVED] ▫️ \`.done <order_id>\` — Pesanan selesai
// [MOVED] ▫️ \`.cancel <order_id>\` — Batalkan pesanan
// [MOVED] ▫️ \`.tagall <pesan>\` — Mention semua member
// [MOVED] 
// [MOVED] ━━━━━━━━━━━━━━━━━━━
// [MOVED] 💡 _Contoh penggunaan: .mode jualan atau .join linkgrup 7_`;
// [MOVED]       await sendInteractiveButtons(sock, responseJid, {
// [MOVED]         text: msg,
// [MOVED]         title: '👑 ADMIN & OWNER',
// [MOVED]         footer: 'Fitur khusus admin & pengelola',
// [MOVED]         buttons: [
// [MOVED]           { type: 'reply', text: '👑 Kontak Owner', id: '.owner' },
// [MOVED]           { type: 'reply', text: '⚡ Cek Status Ping', id: '.ping' },
// [MOVED]           { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
// [MOVED]         ]
// [MOVED]       });
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // Sub-Menu 7: Ekonomi & Perbankan
// [MOVED]     if (['7', 'bank', 'ekonomi', 'economy'].includes(subCat)) {
// [MOVED]       const msg = headerCard + `💸 *EKONOMI & PERBANKAN*
// [MOVED] ▫️ \`.bank <jumlah>\` — Simpan poin ke bank agar aman
// [MOVED] ▫️ \`.tarik <jumlah>\` — Tarik poin dari bank (pajak 2%)
// [MOVED] ▫️ \`.transfer <@user> <jml>\` — Transfer poin (pajak 1%)
// [MOVED] ▫️ \`.rampok <@user>\` — Rampok poin member (risiko ditangkap!)
// [MOVED] ▫️ \`.slot <taruhan>\` — Main mesin slot (min 10 poin)
// [MOVED] ▫️ \`.roulette <taruhan> <warna>\` — Kasino roulette (merah/hitam/hijau)
// [MOVED] 
// [MOVED] ━━━━━━━━━━━━━━━━━━━
// [MOVED] 💡 _Contoh penggunaan: .rampok @member atau .bank 500_`;
// [MOVED]       await sendInteractiveButtons(sock, responseJid, {
// [MOVED]         text: msg,
// [MOVED]         title: '💸 EKONOMI & BANK',
// [MOVED]         footer: 'Sistem ekonomi, bank & perampokan',
// [MOVED]         buttons: [
// [MOVED]           { type: 'reply', text: '🏆 Lihat Poin', id: '.poin' },
// [MOVED]           { type: 'reply', text: '🎁 Klaim Daily', id: '.daily' },
// [MOVED]           { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
// [MOVED]         ]
// [MOVED]       });
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // TAMPILAN MENU UTAMA KHUSUS MODE JUALAN / TOKO
// [MOVED]     const menuSections = [
// [MOVED]       {
// [MOVED]         title: '📂 Pilih Kategori Menu Toko',
// [MOVED]         rows: [
// [MOVED]           { title: '🛍️ Produk & Jualan', id: '.menu jualan', description: 'Katalog, sisa stok & paket hemat' },
// [MOVED]           { title: '🛒 Transaksi & Pembayaran', id: '.menu transaksi', description: 'Keranjang, checkout, status & riwayat' },
// [MOVED]           { title: '📥 Downloader & Media', id: '.menu media', description: 'TikTok, IG, YT, FB, stiker & AI draw' },
// [MOVED]           { title: '🎮 Hiburan & Game', id: '.menu hiburan', description: 'Susun kata, tebak angka/gambar, T-o-D' },
// [MOVED]           { title: '💸 Ekonomi & Bank', id: '.menu bank', description: 'Rampok, slot, roulette & transfer' },
// [MOVED]           { title: '🏆 Poin & Reward', id: '.menu reward', description: 'Daily claim, poin, rank & referral' },
// [MOVED]           { title: '👑 Admin & Owner', id: '.menu admin', description: 'Kontak owner, status bot & pengeluaran' }
// [MOVED]         ]
// [MOVED]       }
// [MOVED]     ];
// [MOVED] 
// [MOVED]     const menuQuickButtons = [
// [MOVED]       { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' },
// [MOVED]       { type: 'reply', text: '🛒 Keranjang Saya', id: '.keranjang' },
// [MOVED]       { type: 'reply', text: '🎁 Klaim Daily', id: '.daily' }
// [MOVED]     ];
// [MOVED] 
// [MOVED]     if (isSalesModeGroup) {
// [MOVED]       const salesMenu = headerCard + `🛍️ *PRODUK & JUALAN*
// [MOVED] ▫️ \`.produk\` — Katalog & sisa stok produk
// [MOVED] ▫️ \`.beli <kode> <qty>\` — Beli produk digital
// [MOVED] ▫️ \`.cari <kata kunci>\` — Cari produk toko
// [MOVED] ▫️ \`.bundle\` — Lihat paket hemat bundling
// [MOVED] 
// [MOVED] 🛒 *TRANSAKSI & PEMBAYARAN*
// [MOVED] ▫️ \`.keranjang\` — Cek isi keranjang belanja
// [MOVED] ▫️ \`.checkout\` — Link pembayaran QRIS/Midtrans
// [MOVED] ▫️ \`.status\` — Cek status transaksi terbaru
// [MOVED] ▫️ \`.riwayat\` — 5 riwayat transaksi terakhir
// [MOVED] ▫️ \`.batal\` — Batalkan pesanan aktif
// [MOVED] 
// [MOVED] 🎟️ *PROMO & REFERRAL*
// [MOVED] ▫️ \`.kupon <kode>\` — Gunakan kupon diskon
// [MOVED] ▫️ \`.referral\` — Ajak teman & dapatkan diskon
// [MOVED] 
// [MOVED] 👑 *ADMIN & OWNER*
// [MOVED] ▫️ \`.owner\`  •  \`.ping\`  •  \`.mode\`  •  \`.tagall\`
// [MOVED] 
// [MOVED] ━━━━━━━━━━━━━━━━━━━
// [MOVED] 💡 _Ketik perintah langsung di atas atau pilih menu interaktif di bawah_`;
// [MOVED] 
// [MOVED]       await sendInteractiveButtons(sock, responseJid, {
// [MOVED]         text: salesMenu,
// [MOVED]         title: '📋 MENU TOKO (MODE JUALAN)',
// [MOVED]         footer: 'Klik tombol atau daftar kategori di bawah ini',
// [MOVED]         buttons: menuQuickButtons,
// [MOVED]         sections: menuSections
// [MOVED]       });
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // TAMPILAN MENU UTAMA FULL (MODE ALL)
// [MOVED]     const fullMenu = headerCard + `🛍️ *PRODUK & JUALAN*
// [MOVED] ▫️ \`.produk\` — Katalog & sisa stok produk
// [MOVED] ▫️ \`.beli <kode> <qty>\` — Beli produk digital
// [MOVED] ▫️ \`.cari <kata kunci>\` — Cari produk toko
// [MOVED] ▫️ \`.bundle\` — Lihat paket hemat bundling
// [MOVED] 
// [MOVED] 🛒 *TRANSAKSI & PEMBAYARAN*
// [MOVED] ▫️ \`.keranjang\` — Cek isi keranjang belanja
// [MOVED] ▫️ \`.checkout\` — Link pembayaran QRIS/Midtrans
// [MOVED] ▫️ \`.status\` — Cek status transaksi terbaru
// [MOVED] ▫️ \`.riwayat\` — 5 riwayat transaksi terakhir
// [MOVED] ▫️ \`.batal\` — Batalkan pesanan aktif
// [MOVED] 
// [MOVED] 📥 *DOWNLOADER & MEDIA*
// [MOVED] ▫️ \`.tt <link>\` — Download video TikTok
// [MOVED] ▫️ \`.ig <link>\` — Download Reels/Foto IG
// [MOVED] ▫️ \`.fb <link>\` — Download video Facebook
// [MOVED] ▫️ \`.yt <link>\` — Download MP3/MP4 YouTube
// [MOVED] ▫️ \`.stiker\` — Foto/Video ke Stiker WA
// [MOVED] ▫️ \`.toimg\` / \`.tovid\` — Stiker ke Foto/Video
// [MOVED] ▫️ \`.qc <teks>\` — Stiker Quote Chat
// [MOVED] ▫️ \`.brat <teks>\` — Stiker Brat Aesthetics
// [MOVED] ▫️ \`.draw <prompt>\` — Generate foto AI
// [MOVED] ▫️ \`.hd\` — Jernihkan foto buram
// [MOVED] ▫️ \`.tts <teks>\` — Ubah teks ke Voice Note
// [MOVED] 
// [MOVED] 🎮 *HIBURAN & GAME*
// [MOVED] ▫️ \`.khodam <nama>\` — Cek khodam lucu
// [MOVED] ▫️ \`.susunkata\` — Game anagram kata
// [MOVED] ▫️ \`.tebakangka\` — Game tebak angka 1-100
// [MOVED] ▫️ \`.tebakgambar\` — Game tebak gambar
// [MOVED] 
// [MOVED] 💸 *EKONOMI & PERBANKAN*
// [MOVED] ▫️ \`.bank <jumlah>\` — Simpan poin ke bank agar aman
// [MOVED] ▫️ \`.tarik <jumlah>\` — Tarik poin dari bank (pajak 2%)
// [MOVED] ▫️ \`.transfer <@user> <jml>\` — Transfer poin (pajak 1%)
// [MOVED] ▫️ \`.rampok <@user>\` — Rampok poin member (risiko!)
// [MOVED] ▫️ \`.slot <taruhan>\` — Main mesin slot (min 10)
// [MOVED] ▫️ \`.roulette <taruhan> <warna>\` — Kasino roulette
// [MOVED] 
// [MOVED] 🎟️ *PROMO & REFERRAL*
// [MOVED] ▫️ \`.kupon <kode>\` — Gunakan kupon diskon
// [MOVED] ▫️ \`.referral\` — Kode referral ajak teman
// [MOVED] ▫️ \`.favorit\` — Lihat produk favorit/wishlist
// [MOVED] 
// [MOVED] 👑 *ADMIN & OWNER*
// [MOVED] ▫️ \`.owner\` — Kontak resmi Owner
// [MOVED] ▫️ \`.ping\` — Cek status & kecepatan respon
// [MOVED] ▫️ \`.mode <jualan/all>\` — Atur mode grup
// [MOVED] ▫️ \`.join <link> <hari>\` — Masuk grup via link
// [MOVED] ▫️ \`.antidelete\` — Nyala/matikan anti-hapus pesan
// [MOVED] ▫️ \`.autosholat <on/off>\` — Nyala/matikan fitur adzan per-grup
// [MOVED] ▫️ \`.tagall <pesan>\` — Mention semua member
// [MOVED] 
// [MOVED] ━━━━━━━━━━━━━━━━━━━
// [MOVED] 💡 _Ketik perintah langsung di atas atau pilih menu interaktif di bawah_`;
// [MOVED] 
// [MOVED]     await sendInteractiveButtons(sock, responseJid, {
// [MOVED]       text: fullMenu,
// [MOVED]       title: '📋 MENU UTAMA AKBAR STORE',
// [MOVED]       footer: 'Klik tombol cepat atau pilih kategori dari daftar menu',
// [MOVED]       buttons: menuQuickButtons,
// [MOVED]       sections: menuSections
// [MOVED]     });
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // 2. LIST / PRODUK
// [MOVED]   if (cleanTextLower === 'list' || cleanTextLower === 'produk') {
// [MOVED]     const products = await db.getProducts();
// [MOVED]     if (products.length === 0) {
// [MOVED]       await sock.sendMessage(responseJid, { text: "Saat ini belum ada produk yang terdaftar di toko kami." });
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// [MOVED] 📦 *KATALOG PRODUK TOKO*
// [MOVED] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
// [MOVED] 
// [MOVED]     const limit = botSettings.lowStockLimit || config.defaults.lowStockLimit;
// [MOVED]     for (const p of products) {
// [MOVED]       let stockStatus = "";
// [MOVED]       if (p.stok === 0) {
// [MOVED]         stockStatus = "🔴 *Stok Habis* (Ketik `notify " + p.kode + "` agar diingatkan via DM saat restok)";
// [MOVED]       } else if (p.stok <= limit) {
// [MOVED]         stockStatus = `🟡 *Stok Terbatas* (Sisa: ${p.stok} pcs)`;
// [MOVED]       } else {
// [MOVED]         stockStatus = `🟢 *Ready Stock* (Tersedia: ${p.stok} pcs)`;
// [MOVED]       }
// [MOVED] 
// [MOVED]       msg += `${stockStatus}
// [MOVED] 📌 *${p.nama}*
// [MOVED] • Kode Produk : \`${p.kode}\`
// [MOVED] • Harga       : *Rp${p.harga.toLocaleString('id-ID')}*
// [MOVED] • Deskripsi   : ${p.deskripsi || '-'}\n\n`;
// [MOVED]     }
// [MOVED] 
// [MOVED]     msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// [MOVED] 💡 *CARA MEMBELI:*
// [MOVED] Ketik: *beli [KODE] [JUMLAH]*
// [MOVED] _(Contoh: \`beli NET01 1\`)_
// [MOVED] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
// [MOVED] 
// [MOVED]     await sendInteractiveButtons(sock, responseJid, {
// [MOVED]       text: msg,
// [MOVED]       title: '📦 KATALOG PRODUK TOKO',
// [MOVED]       footer: 'Klik tombol di bawah untuk melihat keranjang atau ke menu utama',
// [MOVED]       buttons: [
// [MOVED]         { type: 'reply', text: '🛒 Keranjang Saya', id: '.keranjang' },
// [MOVED]         { type: 'reply', text: '💳 Checkout Pembayaran', id: '.checkout' },
// [MOVED]         { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
// [MOVED]       ]
// [MOVED]     });
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // 3. BELI [KODE] [JUMLAH]
// [MOVED]   const buyRegex = /^(beli|buy)\s+(\w+)(?:\s+(\d+))?$/i;
// [MOVED]   if (buyRegex.test(text)) {
// [MOVED]     const match = text.match(buyRegex);
// [MOVED]     const code = match[2].toUpperCase();
// [MOVED] 
// [MOVED]     // Cek apakah kode produk benar-benar terdaftar di database toko
// [MOVED]     const existingProduct = await db.getProductByKode(code);
// [MOVED]     if (!existingProduct) {
// [MOVED]       // Jika kode produk tidak terdaftar di database (misal: "lu kemaren beli itu kah"), anggap ini percakapan biasa -> Bot DIAM
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     // Validasi Wajib Join Grup sebelum beli
// [MOVED]     const groupCheck = await checkIsUserInGroup(senderNumber);
// [MOVED]     if (!groupCheck.isMember) {
// [MOVED]       const joinMsg = `⚠️ *PERSYARATAN PEMBELIAN: WAJIB JOIN GRUP*
// [MOVED]       
// [MOVED] Halo Kak! Untuk dapat memesan & membeli produk di toko kami, Anda diwajibkan untuk bergabung terlebih dahulu ke **Grup Pembeli Toko** kami.
// [MOVED] 
// [MOVED] 📢 *Grup:* ${groupCheck.groupName}
// [MOVED] 🔗 *Link Undangan Grup:*
// [MOVED] ${groupCheck.inviteLink || "Silakan minta link undangan grup ke Admin atau Owner."}
// [MOVED] 
// [MOVED] _Silakan klik link di atas untuk bergabung, kemudian ulangi perintah \`${text}\` kembali. Terima kasih!_ 🙏`;
// [MOVED] 
// [MOVED]       await sock.sendMessage(responseJid, { text: joinMsg });
// [MOVED]       await sendRedirectNotice();
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     const qty = match[3] ? parseInt(match[3]) : 1;
// [MOVED] 
// [MOVED]     if (qty <= 0) {
// [MOVED]       await sock.sendMessage(responseJid, { text: "⚠️ Jumlah produk yang dibeli minimal *1*." });
// [MOVED]       await sendRedirectNotice();
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     const res = await db.addToCart(senderNumber, code, qty);
// [MOVED]     if (!res.success) {
// [MOVED]       await sock.sendMessage(responseJid, { text: `❌ ${res.message}` });
// [MOVED]       await sendRedirectNotice();
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     const successMsg = `✅ *Berhasil ditambahkan ke keranjang!*
// [MOVED]     
// [MOVED] *${res.productName}*
// [MOVED] Jumlah: ${res.qty} pcs
// [MOVED] Subtotal: *Rp${res.subtotal.toLocaleString('id-ID')}*
// [MOVED] 
// [MOVED] Ketik *keranjang* atau *cart* untuk melihat detail belanjaan Anda, atau ketik *checkout* untuk langsung melakukan pembayaran.`;
// [MOVED] 
// [MOVED]     await sendInteractiveButtons(sock, responseJid, {
// [MOVED]       text: successMsg,
// [MOVED]       title: '✅ BERHASIL DITAMBAHKAN',
// [MOVED]       footer: 'Pilih langkah selanjutnya di bawah ini',
// [MOVED]       buttons: [
// [MOVED]         { type: 'reply', text: '🛒 Lihat Keranjang', id: '.keranjang' },
// [MOVED]         { type: 'reply', text: '💳 Checkout Pembayaran', id: '.checkout' },
// [MOVED]         { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' }
// [MOVED]       ]
// [MOVED]     });
// [MOVED]     await sendRedirectNotice();
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // 4. KERANJANG / CART
// [MOVED]   if (cleanTextLower === 'cart' || cleanTextLower === 'keranjang') {
// [MOVED]     const cart = await db.getCartDetails(senderNumber);
// [MOVED]     if (cart.items.length === 0) {
// [MOVED]       await sendInteractiveButtons(sock, responseJid, {
// [MOVED]         text: "🛒 *Keranjang belanja Anda masih kosong.*\nKetik *produk* untuk melihat produk yang tersedia.",
// [MOVED]         title: '🛒 KERANJANG KOSONG',
// [MOVED]         footer: 'Silakan pilih produk terlebih dahulu',
// [MOVED]         buttons: [
// [MOVED]           { type: 'reply', text: '🛍️ Lihat Katalog Produk', id: '.produk' },
// [MOVED]           { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
// [MOVED]         ]
// [MOVED]       });
// [MOVED]       await sendRedirectNotice();
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     let msg = `━━━━━━━━━━━━━━━━━━
// [MOVED] 🛒 *KERANJANG BELANJA*
// [MOVED] ━━━━━━━━━━━━━━━━━━
// [MOVED] Order ID: *${cart.order_id}*
// [MOVED] 
// [MOVED] `;
// [MOVED] 
// [MOVED]     cart.items.forEach((item, idx) => {
// [MOVED]       msg += `${idx + 1}. *${item.produk_nama}* (\`${item.produk_kode}\`)
// [MOVED]    ${item.qty} x Rp${item.harga.toLocaleString('id-ID')} = *Rp${item.subtotal.toLocaleString('id-ID')}*\n\n`;
// [MOVED]     });
// [MOVED] 
// [MOVED]     msg += `━━━━━━━━━━━━━━━━━━
// [MOVED] *Total Belanja:* *Rp${cart.total.toLocaleString('id-ID')}*
// [MOVED] ━━━━━━━━━━━━━━━━━━
// [MOVED] Ketik *checkout* untuk melanjutkan ke pembayaran, atau *batal* untuk mengosongkan keranjang.`;
// [MOVED] 
// [MOVED]     await sendInteractiveButtons(sock, responseJid, {
// [MOVED]       text: msg,
// [MOVED]       title: '🛒 KERANJANG BELANJA',
// [MOVED]       footer: 'Pilih aksi transaksi di bawah ini',
// [MOVED]       buttons: [
// [MOVED]         { type: 'reply', text: '💳 Checkout Pembayaran', id: '.checkout' },
// [MOVED]         { type: 'reply', text: '❌ Batalkan Pesanan', id: '.batal' },
// [MOVED]         { type: 'reply', text: '🛍️ Tambah Produk', id: '.produk' }
// [MOVED]       ]
// [MOVED]     });
// [MOVED]     await sendRedirectNotice();
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // PERINTAH INSTAN SCAN QRIS (.pay / .qris / .pembayaran)
// [MOVED]   if (['pay', 'qris', 'pembayaran'].includes(cleanCmd)) {
// [MOVED]     const lastOrder = await db.getLastOrderByCustomer(senderNumber);
// [MOVED] 
// [MOVED]     if (lastOrder && (lastOrder.status === 'WAITING_PAYMENT' || lastOrder.status === 'CART')) {
// [MOVED]       // Jika ada pesanan aktif, generate/tampilkan Dynamic QRIS otomatis
// [MOVED]       try {
// [MOVED]         const { createPayment } = await import('./src/payment/paymentService.js');
// [MOVED]         const casakuPayment = await createPayment(lastOrder.order_id, lastOrder.total);
// [MOVED] 
// [MOVED]         let qrImageBuffer = null;
// [MOVED]         try {
// [MOVED]           const QRCode = (await import('qrcode')).default;
// [MOVED]           qrImageBuffer = await QRCode.toBuffer(casakuPayment.qrString, {
// [MOVED]             type: 'png',
// [MOVED]             width: 400,
// [MOVED]             margin: 2,
// [MOVED]             color: { dark: '#000000', light: '#ffffff' }
// [MOVED]           });
// [MOVED]         } catch (qrErr) {}
// [MOVED] 
// [MOVED]         const expiredAt = new Date(casakuPayment.expiredAt);
// [MOVED]         const expiredStr = expiredAt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
// [MOVED]         const itemsText = (lastOrder.items || []).map(item => `- ${item.produk_nama} (x${item.qty})`).join('\n');
// [MOVED] 
// [MOVED]         const casakuInvoice = `━━━━━━━━━━━━━━━━━━━━
// [MOVED] 💳 *QRIS PEMBAYARAN TAGIHAN OTOMATIS*
// [MOVED] ━━━━━━━━━━━━━━━━━━━━
// [MOVED] 📦 *Order ID:* ${lastOrder.order_id}
// [MOVED] 👤 *Nama:* ${lastOrder.customer_nama}
// [MOVED] 
// [MOVED] *Rincian Belanja:*
// [MOVED] ${itemsText}
// [MOVED] 
// [MOVED] ━━━━━━━━━━━━━━━━━━━━
// [MOVED] 💸 *TOTAL YANG HARUS DIBAYAR:*
// [MOVED] 👉 *Rp${casakuPayment.totalAmount.toLocaleString('id-ID')}*
// [MOVED] ${casakuPayment.uniqueCode > 0 ? `_(Harga produk Rp${lastOrder.total.toLocaleString('id-ID')} + kode unik Rp${casakuPayment.uniqueCode})_\n` : ''}
// [MOVED] ⏰ *Berlaku hingga:* ${expiredStr} WIB
// [MOVED] ━━━━━━━━━━━━━━━━━━━━
// [MOVED] 
// [MOVED] 📱 *Scan QRIS di bawah untuk membayar:*
// [MOVED] ✅ DANA / GoPay / OVO / ShopeePay / BCA / BRI / Mandiri / dll.
// [MOVED] 
// [MOVED] 🔄 *Pembayaran diverifikasi OTOMATIS.*
// [MOVED] Tidak perlu kirim bukti transfer — produk langsung terkirim begitu bayar!`;
// [MOVED] 
// [MOVED]         if (qrImageBuffer) {
// [MOVED]           await sock.sendMessage(responseJid, { image: qrImageBuffer, caption: casakuInvoice, mimetype: 'image/png' });
// [MOVED]         } else {
// [MOVED]           await sock.sendMessage(responseJid, { text: casakuInvoice });
// [MOVED]         }
// [MOVED]       } catch (err) {
// [MOVED]         // Fallback jika API sedang tidak dapat dijangkau
// [MOVED]         const invoiceMsg = `━━━━━━━━━━━━━━━━━━\n💳 *TAGIHAN PEMBAYARAN*\n━━━━━━━━━━━━━━━━━━\nOrder ID: *${lastOrder.order_id}*\nNama: *${lastOrder.customer_nama}*\nTotal: *Rp${lastOrder.total.toLocaleString('id-ID')}*\n\n_Ketik \`checkout\` untuk memproses ulang pembayaran QRIS Otomatis._`;
// [MOVED]         await sock.sendMessage(responseJid, { text: invoiceMsg });
// [MOVED]       }
// [MOVED]     } else {
// [MOVED]       const qrisInfo = `━━━━━━━━━━━━━━━━━━
// [MOVED] 💳 *SISTEM PEMBAYARAN QRIS OTOMATIS*
// [MOVED] ━━━━━━━━━━━━━━━━━━
// [MOVED] 
// [MOVED] 📌 Pembayaran di toko kami menggunakan **QRIS Otomatis Real-Time**:
// [MOVED] • 100% Verifikasi otomatis tanpa perlu kirim bukti transfer.
// [MOVED] • Produk digital dikirim langsung 2–5 detik setelah scan berhasil.
// [MOVED] • Mendukung DANA, GoPay, OVO, ShopeePay, BCA, BRI, Mandiri, dll.
// [MOVED] 
// [MOVED] 💡 *Cara Belanja:*
// [MOVED] 1. Ketik *list* untuk melihat produk toko.
// [MOVED] 2. Ketik *beli [kode_produk]* untuk memilih produk.
// [MOVED] 3. Ketik *checkout* untuk memperoleh kode QRIS tagihan Anda!`;
// [MOVED]       await sendQris(responseJid, qrisInfo);
// [MOVED]     }
// [MOVED] 
// [MOVED]     await sendRedirectNotice();
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED] 
// [MOVED]   // 5. CHECKOUT / BAYAR
// [MOVED]   if (cleanTextLower === 'checkout' || cleanTextLower === 'bayar') {
// [MOVED] 
// [MOVED]     // Validasi Wajib Join Grup sebelum checkout
// [MOVED]     const groupCheck = await checkIsUserInGroup(senderNumber);
// [MOVED]     if (!groupCheck.isMember) {
// [MOVED]       const joinMsg = `⚠️ *PERSYARATAN PEMBELIAN: WAJIB JOIN GRUP*
// [MOVED]       
// [MOVED] Halo Kak! Untuk melanjutkan pembayaran & checkout pesanan Anda, Anda diwajibkan untuk bergabung terlebih dahulu ke **Grup Pembeli Toko** kami.
// [MOVED] 
// [MOVED] 📢 *Grup:* ${groupCheck.groupName}
// [MOVED] 🔗 *Link Undangan Grup:*
// [MOVED] ${groupCheck.inviteLink || "Silakan minta link undangan grup ke Admin atau Owner."}
// [MOVED] 
// [MOVED] _Silakan klik link di atas untuk bergabung, kemudian ulangi perintah \`checkout\` kembali. Terima kasih!_ 🙏`;
// [MOVED] 
// [MOVED]       await sock.sendMessage(responseJid, { text: joinMsg });
// [MOVED]       await sendRedirectNotice();
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     const res = await db.checkoutCart(senderNumber);
// [MOVED]     if (!res.success) {
// [MOVED]       await sock.sendMessage(responseJid, { text: `❌ ${res.message}` });
// [MOVED]       await sendRedirectNotice();
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     const order = res.order;
// [MOVED]     const itemsText = order.items.map(item => `- ${item.produk_nama} (x${item.qty})`).join('\n');
// [MOVED] 
// [MOVED]     // ================================================================
// [MOVED]     // INSTANT SALDO DEPOSIT CHECKOUT (Priority 1)
// [MOVED]     // Jika saldo deposit mencukupi, bayar instan tanpa perlu QRIS
// [MOVED]     // ================================================================
// [MOVED]     const custProfile = await db.getCustomerMembershipProfile(senderNumber);
// [MOVED]     if ((custProfile?.balance || 0) >= order.total) {
// [MOVED]       const deductRes = await db.deductCustomerBalance(senderNumber, order.total, `Pembelian Order #${order.order_id}`);
// [MOVED]       if (deductRes.success) {
// [MOVED]         const now = Date.now();
// [MOVED]         await db.runQuery(
// [MOVED]           "UPDATE orders SET payment_status = 'PAID', status = 'COMPLETED', updated_at = ? WHERE order_id = ?",
// [MOVED]           [now, order.order_id]
// [MOVED]         );
// [MOVED]         await db.createFulfillmentJob(order.order_id, senderNumber);
// [MOVED] 
// [MOVED]         // Award purchase points
// [MOVED]         const pts = await db.awardPurchasePoints(senderNumber, order.total);
// [MOVED] 
// [MOVED]         let successMsg = `✅ *PEMBAYARAN SALDO DEPOSIT BERHASIL!* ✅\n\n`;
// [MOVED]         successMsg += `📦 *Order ID:* ${order.order_id}\n`;
// [MOVED]         successMsg += `💸 *Total Dibayar:* Rp${order.total.toLocaleString('id-ID')}\n`;
// [MOVED]         successMsg += `💳 *Sisa Saldo Deposit:* Rp${deductRes.newBalance.toLocaleString('id-ID')}\n`;
// [MOVED]         if (pts > 0) successMsg += `🪙 *Bonus Poin:* +${pts} Akbar Poin\n\n`;
// [MOVED]         successMsg += `_Pesanan Anda berhasil dan produk digital sedang dikirimkan otomatis ke chat ini!_`;
// [MOVED] 
// [MOVED]         await sock.sendMessage(responseJid, { text: successMsg });
// [MOVED]         await db.addLog('ORDER', `🛍️ Order #${order.order_id} dibayar lunas via Saldo Deposit oleh ${senderNumber}`);
// [MOVED]         await sendRedirectNotice();
// [MOVED]         return;
// [MOVED]       }
// [MOVED]     }
// [MOVED] 
// [MOVED]     // ================================================================
// [MOVED]     // CASAKU QRIS OTOMATIS (Priority 2)
// [MOVED]     // ================================================================
// [MOVED] 
// [MOVED]     const { config: botConfig } = await import('./config.js');
// [MOVED]     const casakuKey = process.env.CASAKU_LICENSE_KEY || botConfig.casaku?.licenseKey || '';
// [MOVED]     const casakuQrisId = process.env.CASAKU_QRIS_ID || botConfig.casaku?.qrisId || '';
// [MOVED] 
// [MOVED]     if (casakuKey && casakuQrisId) {
// [MOVED]       // === CASAKU MODE: Dynamic QRIS Otomatis ===
// [MOVED]       let casakuPayment = null;
// [MOVED]       try {
// [MOVED]         const { createPayment } = await import('./src/payment/paymentService.js');
// [MOVED]         casakuPayment = await createPayment(order.order_id, order.total);
// [MOVED]       } catch (err) {
// [MOVED]         console.error('[BOT] Casaku QRIS generation failed:', err.message);
// [MOVED]         await sock.sendMessage(responseJid, {
// [MOVED]           text: `❌ *Gagal membuat QRIS Otomatis.*\n\nSilakan coba lagi dalam beberapa saat atau hubungi admin.\n\n_Error: ${err.message}_`
// [MOVED]         });
// [MOVED]         await sendRedirectNotice();
// [MOVED]         return;
// [MOVED]       }
// [MOVED] 
// [MOVED]       // Render qr_string → PNG Buffer menggunakan qrcode
// [MOVED]       let qrImageBuffer = null;
// [MOVED]       try {
// [MOVED]         const QRCode = (await import('qrcode')).default;
// [MOVED]         qrImageBuffer = await QRCode.toBuffer(casakuPayment.qrString, {
// [MOVED]           type: 'png',
// [MOVED]           width: 400,
// [MOVED]           margin: 2,
// [MOVED]           color: { dark: '#000000', light: '#ffffff' }
// [MOVED]         });
// [MOVED]       } catch (qrErr) {
// [MOVED]         console.error('[BOT] QR render error:', qrErr.message);
// [MOVED]       }
// [MOVED] 
// [MOVED]       const expiredAt = new Date(casakuPayment.expiredAt);
// [MOVED]       const expiredStr = expiredAt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
// [MOVED] 
// [MOVED]       const casakuInvoice = `━━━━━━━━━━━━━━━━━━━━
// [MOVED] 🧾 *TAGIHAN PEMBAYARAN OTOMATIS*
// [MOVED] ━━━━━━━━━━━━━━━━━━━━
// [MOVED] 📦 *Order ID:* ${order.order_id}
// [MOVED] 👤 *Nama:* ${order.customer_nama}
// [MOVED] 
// [MOVED] *Rincian Belanja:*
// [MOVED] ${itemsText}
// [MOVED] 
// [MOVED] ━━━━━━━━━━━━━━━━━━━━
// [MOVED] 💸 *TOTAL YANG HARUS DIBAYAR:*
// [MOVED] 👉 *Rp${casakuPayment.totalAmount.toLocaleString('id-ID')}*
// [MOVED] ${casakuPayment.uniqueCode > 0 ? `_(Harga produk Rp${order.total.toLocaleString('id-ID')} + kode unik Rp${casakuPayment.uniqueCode})_\n` : ''}
// [MOVED] ⏰ *Berlaku hingga:* ${expiredStr} WIB
// [MOVED] ━━━━━━━━━━━━━━━━━━━━
// [MOVED] 
// [MOVED] 📱 *Scan QRIS di bawah untuk membayar:*
// [MOVED] ✅ Bisa bayar dari DANA / GoPay / OVO / ShopeePay / BCA / BRI / Mandiri / dll.
// [MOVED] 
// [MOVED] 🔄 *Pembayaran diverifikasi otomatis.*
// [MOVED] Begitu Anda selesai bayar, produk langsung dikirim ke chat ini tanpa perlu konfirmasi manual.
// [MOVED] 
// [MOVED] ⚠️ *PENTING:* Pastikan nominal transfer PERSIS *Rp${casakuPayment.totalAmount.toLocaleString('id-ID')}* (termasuk kode unik).`;
// [MOVED] 
// [MOVED]       if (qrImageBuffer) {
// [MOVED]         await sock.sendMessage(responseJid, {
// [MOVED]           image: qrImageBuffer,
// [MOVED]           caption: casakuInvoice,
// [MOVED]           mimetype: 'image/png'
// [MOVED]         });
// [MOVED]       } else {
// [MOVED]         // Fallback teks jika QR gagal di-render
// [MOVED]         await sock.sendMessage(responseJid, { text: casakuInvoice + `\n\n_QRIS String (copy-paste ke aplikasi e-wallet):_\n\`\`\`${casakuPayment.qrString}\`\`\`` });
// [MOVED]       }
// [MOVED] 
// [MOVED]       await logToSystem('ORDER', `🛍️ Customer *${order.customer_nama}* checkout Order *${order.order_id}* — Rp${casakuPayment.totalAmount.toLocaleString('id-ID')} (Casaku QRIS Dynamic)`);
// [MOVED]       await sendRedirectNotice();
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // === FALLBACK: Midtrans atau Manual QRIS ===
// [MOVED]     let midtransRes = null;
// [MOVED]     try {
// [MOVED]       midtransRes = await createMidtransTransaction(order);
// [MOVED]     } catch (err) {
// [MOVED]       console.error("[BOT] Gagal memicu Midtrans, beralih ke manual QRIS:", err.message);
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (midtransRes && midtransRes.redirect_url) {
// [MOVED]       const invoiceMsg = `━━━━━━━━━━━━━━━━━━
// [MOVED] 🧾 *TAGIHAN PEMBAYARAN INSTAN*
// [MOVED] ━━━━━━━━━━━━━━━━━━
// [MOVED] Order ID: *${order.order_id}*
// [MOVED] Nama: *${order.customer_nama}*
// [MOVED] Status: *WAITING_PAYMENT*
// [MOVED] 
// [MOVED] *Rincian Belanja:*
// [MOVED] ${itemsText}
// [MOVED] 
// [MOVED] 💸 *TOTAL YANG HARUS DIBAYAR:*
// [MOVED] 👉 *Rp${order.total.toLocaleString('id-ID')}*
// [MOVED] 
// [MOVED] 🔗 *LINK PEMBAYARAN INSTAN (MIDTRANS):*
// [MOVED] ${midtransRes.redirect_url}
// [MOVED] 
// [MOVED] _Anda dapat membayar menggunakan QRIS, GoPay, ShopeePay, OVO, Virtual Account Bank (BCA, Mandiri, BNI, BRI), atau gerai ritel (Alfamart/Indomaret) melalui link di atas._
// [MOVED] 
// [MOVED] ⚠️ _Masa berlaku link pembayaran ini adalah *30 menit*. Setelah membayar, sistem akan memproses pesanan secara otomatis._
// [MOVED] ━━━━━━━━━━━━━━━━━━`;
// [MOVED]       await sendInteractiveButtons(sock, responseJid, {
// [MOVED]         text: invoiceMsg,
// [MOVED]         title: '🧾 TAGIHAN PEMBAYARAN INSTAN',
// [MOVED]         footer: 'Klik tombol di bawah ini untuk langsung membayar',
// [MOVED]         buttons: [
// [MOVED]           { type: 'url', text: '💳 Bayar Sekarang', url: midtransRes.redirect_url },
// [MOVED]           { type: 'reply', text: '🛒 Lihat Keranjang', id: '.keranjang' },
// [MOVED]           { type: 'reply', text: '❌ Batalkan Pesanan', id: '.batal' }
// [MOVED]         ]
// [MOVED]       });
// [MOVED]     } else {
// [MOVED]       const invoiceMsg = `━━━━━━━━━━━━━━━━━━
// [MOVED] 🧾 *TAGIHAN PEMBAYARAN MANUAL*
// [MOVED] ━━━━━━━━━━━━━━━━━━
// [MOVED] Order ID: *${order.order_id}*
// [MOVED] Nama: *${order.customer_nama}*
// [MOVED] Status: *WAITING_PAYMENT*
// [MOVED] 
// [MOVED] *Rincian Belanja:*
// [MOVED] ${itemsText}
// [MOVED] 
// [MOVED] 💸 *TOTAL YANG HARUS DIBAYAR:*
// [MOVED] 👉 *Rp${order.total.toLocaleString('id-ID')}*
// [MOVED] 
// [MOVED] *CARA PEMBAYARAN:*
// [MOVED] 1. Scan QRIS yang tertera di gambar atas.
// [MOVED] 2. Pastikan nominal transfer pas sebesar *Rp${order.total.toLocaleString('id-ID')}*.
// [MOVED] 3. Setelah transfer berhasil, harap kirimkan foto/screenshot *BUKTI TRANSFER* langsung ke chat ini.
// [MOVED] ━━━━━━━━━━━━━━━━━━`;
// [MOVED]       await sendQris(responseJid, invoiceMsg);
// [MOVED]       await sendInteractiveButtons(sock, responseJid, {
// [MOVED]         text: '📱 *TIPS PEMBAYARAN:*\nSetelah melakukan transfer via QRIS, harap kirimkan foto/screenshot *BUKTI TRANSFER* langsung ke chat ini.',
// [MOVED]         title: '🧾 PETUNJUK TRANSFER',
// [MOVED]         footer: 'Opsi transaksi',
// [MOVED]         buttons: [
// [MOVED]           { type: 'reply', text: '🛒 Lihat Keranjang', id: '.keranjang' },
// [MOVED]           { type: 'reply', text: '❌ Batalkan Pesanan', id: '.batal' }
// [MOVED]         ]
// [MOVED]       });
// [MOVED]     }
// [MOVED] 
// [MOVED]     await logToSystem('ORDER', `🛍️ Customer *${order.customer_nama}* (wa.me/${senderNumber.split('@')[0]}) melakukan checkout untuk Order ID *${order.order_id}* sebesar Rp${order.total.toLocaleString('id-ID')}`);
// [MOVED]     await sendRedirectNotice();
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // 6. CANCEL / BATAL
// [MOVED]   if (cleanTextLower === 'cancel' || cleanTextLower === 'batal') {
// [MOVED]     const activeOrder = await db.getLastOrderByCustomer(senderNumber);
// [MOVED]     if (activeOrder && activeOrder.casaku_transaction_id) {
// [MOVED]       try {
// [MOVED]         const { cancelPayment } = await import('./src/payment/paymentService.js');
// [MOVED]         await cancelPayment(activeOrder.order_id, activeOrder.casaku_transaction_id);
// [MOVED]       } catch (err) {}
// [MOVED]     }
// [MOVED] 
// [MOVED]     const res = await db.cancelActiveOrder(senderNumber);
// [MOVED]     if (!res.success) {
// [MOVED]       await sock.sendMessage(responseJid, { text: `⚠️ ${res.message}` });
// [MOVED]       await sendRedirectNotice();
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     await sock.sendMessage(responseJid, { text: `✅ *Pesanan Anda (${res.orderId}) berhasil dibatalkan.*\nKeranjang/tagihan telah dikosongkan dan stok dikembalikan.` });
// [MOVED]     await logToSystem('ORDER', `❌ Order ID *${res.orderId}* dibatalkan oleh customer.`);
// [MOVED]     await sendRedirectNotice();
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED] 
// [MOVED]   // 7. STATUS
// [MOVED]   if (cleanTextLower === 'status') {
// [MOVED]     const lastOrder = await db.getCustomerLastOrder(senderNumber);
// [MOVED]     if (!lastOrder) {
// [MOVED]       await sock.sendMessage(responseJid, { text: "Anda belum pernah melakukan pemesanan di toko kami." });
// [MOVED]       await sendRedirectNotice();
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     const details = await db.getOrderDetails(lastOrder.order_id);
// [MOVED]     let statusTranslate = details.status;
// [MOVED]     
// [MOVED]     switch (details.status) {
// [MOVED]       case 'CART': statusTranslate = '🛒 Keranjang Belanja'; break;
// [MOVED]       case 'WAITING_PAYMENT': statusTranslate = '⏳ Menunggu Pembayaran'; break;
// [MOVED]       case 'WAITING_CONFIRMATION': statusTranslate = '🔍 Menunggu Verifikasi Admin'; break;
// [MOVED]       case 'PAID': statusTranslate = '🟢 Pembayaran Diterima (Sedang Diproses)'; break;
// [MOVED]       case 'COMPLETED': statusTranslate = '✅ Selesai'; break;
// [MOVED]       case 'CANCELLED': statusTranslate = '❌ Dibatalkan'; break;
// [MOVED]     }
// [MOVED] 
// [MOVED]     let msg = `━━━━━━━━━━━━━━━━━━
// [MOVED] 📊 *STATUS PESANAN*
// [MOVED] ━━━━━━━━━━━━━━━━━━
// [MOVED] Order ID: *${details.order_id}*
// [MOVED] Tanggal: ${new Date(details.created_at).toLocaleString('id-ID')}
// [MOVED] Total: *Rp${details.total.toLocaleString('id-ID')}*
// [MOVED] Status: *${statusTranslate}*
// [MOVED] 
// [MOVED] *Item yang dipesan:*
// [MOVED] `;
// [MOVED] 
// [MOVED]     details.items.forEach(item => {
// [MOVED]       msg += `- ${item.produk_nama} (x${item.qty})\n`;
// [MOVED]     });
// [MOVED]     
// [MOVED]     msg += `━━━━━━━━━━━━━━━━━━`;
// [MOVED]     await sock.sendMessage(responseJid, { text: msg });
// [MOVED]     await sendRedirectNotice();
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // 8. NOTIFY [KODE] (BERLANGGANAN NOTIFIKASI STOK)
// [MOVED]   const notifyRegex = /^(notify|notif|hubungi)\s+(\w+)$/i;
// [MOVED]   if (notifyRegex.test(text)) {
// [MOVED]     const match = text.match(notifyRegex);
// [MOVED]     const code = match[2].toUpperCase();
// [MOVED]     const p = await db.getProductByKode(code);
// [MOVED]     if (!p) {
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     if (p.stok > 0) {
// [MOVED]       await sock.sendMessage(responseJid, { 
// [MOVED]         text: `🟢 Produk *${p.nama}* (\`${code}\`) saat ini sedang tersedia (Stok: ${p.stok} pcs).\nSilakan langsung pesan dengan mengetik:\n*beli ${code} 1*` 
// [MOVED]       });
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // Daftarkan ke subscriptions
// [MOVED]     await db.addSubscription(senderNumber, code);
// [MOVED]     const confirmMsg = `✅ *Pemberitahuan Stok Aktif!*
// [MOVED] 
// [MOVED] Kami akan otomatis mengirimkan pesan WhatsApp ke nomor ini begitu produk *${p.nama}* (\`${code}\`) sudah ready kembali. Terima kasih!`;
// [MOVED]     await sock.sendMessage(responseJid, { text: confirmMsg });
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // 9. RIWAYAT / HISTORY
// [MOVED]   if (cleanTextLower === 'riwayat' || cleanTextLower === 'history') {
// [MOVED]     const history = await db.getCustomerOrderHistory(senderNumber);
// [MOVED]     if (history.length === 0) {
// [MOVED]       await sock.sendMessage(responseJid, { text: "📜 Anda belum memiliki riwayat pesanan." });
// [MOVED]       await sendRedirectNotice();
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📜 *RIWAYAT 5 PESANAN TERAKHIR*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
// [MOVED]     for (const o of history) {
// [MOVED]       let statusEmoji = '🔄';
// [MOVED]       switch(o.status) {
// [MOVED]         case 'COMPLETED': statusEmoji = '✅'; break;
// [MOVED]         case 'CANCELLED': statusEmoji = '❌'; break;
// [MOVED]         case 'WAITING_PAYMENT': statusEmoji = '⏳'; break;
// [MOVED]         case 'PAID': statusEmoji = '🟢'; break;
// [MOVED]         case 'CART': statusEmoji = '🛒'; break;
// [MOVED]       }
// [MOVED]       msg += `${statusEmoji} *${o.order_id}*\n`;
// [MOVED]       msg += `   Total: Rp${o.total.toLocaleString('id-ID')}`;
// [MOVED]       if (o.discount_amount > 0) msg += ` (Diskon: -Rp${o.discount_amount.toLocaleString('id-ID')})`;
// [MOVED]       msg += `\n   Status: ${o.status}\n   Tanggal: ${new Date(o.created_at).toLocaleDateString('id-ID')}\n   Item: ${o.items_summary || '-'}\n\n`;
// [MOVED]     }
// [MOVED]     msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
// [MOVED]     await sock.sendMessage(responseJid, { text: msg });
// [MOVED]     await sendRedirectNotice();
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // 10. CARI PRODUK
// [MOVED]   const cariRegex = /^cari\s+(.+)$/i;
// [MOVED]   if (cariRegex.test(text)) {
// [MOVED]     const keyword = text.match(cariRegex)[1];
// [MOVED]     const results = await db.searchProducts(keyword);
// [MOVED]     if (results.length === 0) {
// [MOVED]       await sock.sendMessage(responseJid, { text: `🔎 Tidak ditemukan produk dengan kata kunci "*${keyword}*".\nKetik *produk* untuk melihat semua katalog.` });
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔎 *HASIL PENCARIAN:* "${keyword}"\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
// [MOVED]     for (const p of results) {
// [MOVED]       const stockLabel = p.stok === 0 ? '🔴 Habis' : p.stok <= 3 ? `🟡 Sisa ${p.stok}` : `🟢 ${p.stok} pcs`;
// [MOVED]       msg += `📌 *${p.nama}* (\`${p.kode}\`)\n   Harga: *Rp${p.harga.toLocaleString('id-ID')}* | Stok: ${stockLabel}\n\n`;
// [MOVED]     }
// [MOVED]     msg += `Ketik *beli [KODE] [JUMLAH]* untuk membeli.`;
// [MOVED]     await sock.sendMessage(responseJid, { text: msg });
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // 11. KUPON
// [MOVED]   const kuponRegex = /^kupon\s+(\w+)$/i;
// [MOVED]   if (kuponRegex.test(text)) {
// [MOVED]     const code = text.match(kuponRegex)[1].toUpperCase();
// [MOVED]     const coupon = await db.getCoupon(code);
// [MOVED]     if (!coupon) {
// [MOVED]       await sock.sendMessage(responseJid, { text: `❌ Kupon *${code}* tidak ditemukan atau sudah tidak berlaku.` });
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     // Validasi: cek expired
// [MOVED]     if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
// [MOVED]       await sock.sendMessage(responseJid, { text: `❌ Kupon *${code}* sudah kedaluwarsa.` });
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     // Validasi: cek max uses
// [MOVED]     if (coupon.max_uses > 0 && coupon.used_count >= coupon.max_uses) {
// [MOVED]       await sock.sendMessage(responseJid, { text: `❌ Kupon *${code}* sudah mencapai batas pemakaian.` });
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     // Cek ada order CART aktif
// [MOVED]     const lastOrder = await db.getCustomerLastOrder(senderNumber);
// [MOVED]     if (!lastOrder || lastOrder.status !== 'CART') {
// [MOVED]       await sock.sendMessage(responseJid, { text: `⚠️ Anda belum memiliki keranjang belanja aktif.\nSilakan tambah produk terlebih dahulu dengan *beli [KODE] [JUMLAH]*.` });
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     if (lastOrder.coupon_code) {
// [MOVED]       await sock.sendMessage(responseJid, { text: `Kupon *${lastOrder.coupon_code}* sudah diterapkan pada keranjang ini.` });
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     // Validasi: min order
// [MOVED]     if (coupon.min_order > 0 && lastOrder.total < coupon.min_order) {
// [MOVED]       await sock.sendMessage(responseJid, { text: `⚠️ Minimal belanja untuk kupon ini adalah *Rp${coupon.min_order.toLocaleString('id-ID')}*. Total belanja Anda saat ini: Rp${lastOrder.total.toLocaleString('id-ID')}.` });
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     // Hitung diskon
// [MOVED]     let discount = 0;
// [MOVED]     if (coupon.type === 'percent') {
// [MOVED]       discount = Math.floor(lastOrder.total * coupon.value / 100);
// [MOVED]     } else {
// [MOVED]       discount = coupon.value;
// [MOVED]     }
// [MOVED]     if (discount > lastOrder.total) discount = lastOrder.total;
// [MOVED]     
// [MOVED]     await db.applyCouponToOrder(lastOrder.order_id, code, discount);
// [MOVED]     const discountLabel = coupon.type === 'percent' ? `${coupon.value}%` : `Rp${coupon.value.toLocaleString('id-ID')}`;
// [MOVED]     await sock.sendMessage(responseJid, { text: `✅ *Kupon ${code} berhasil diterapkan!*\n\n🏷️ Diskon: ${discountLabel}\n💰 Potongan: *-Rp${discount.toLocaleString('id-ID')}*\n🧾 Total setelah diskon: *Rp${(lastOrder.total - discount).toLocaleString('id-ID')}*\n\nKetik *checkout* untuk melanjutkan pembayaran.` });
// [MOVED]     await sendRedirectNotice();
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // 12. REFERRAL (Ajak 3 Teman = Kupon Diskon 10%)
// [MOVED]   const refUseRegex = /^(?:referral|ref)\s+(REF-[\w]+)$/i;
// [MOVED]   if (refUseRegex.test(text)) {
// [MOVED]     const targetCode = text.match(refUseRegex)[1].toUpperCase();
// [MOVED]     const referrer = await db.getReferralByCode(targetCode);
// [MOVED]     if (!referrer) {
// [MOVED]       await sock.sendMessage(responseJid, { text: `❌ Kode referral *${targetCode}* tidak ditemukan.` });
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     if (referrer.nomor === senderNumber) {
// [MOVED]       await sock.sendMessage(responseJid, { text: `⚠️ Anda tidak dapat menggunakan kode referral sendiri.` });
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     const res = await db.addReferral(referrer.nomor, senderNumber);
// [MOVED]     if (res.success) {
// [MOVED]       await sock.sendMessage(responseJid, { text: `🎉 *Berhasil!* Anda mendaftar melalui referral *${referrer.nama || 'Pelanggan'}* (\`${targetCode}\`). Terima kasih!` });
// [MOVED]     } else {
// [MOVED]       await sock.sendMessage(responseJid, { text: `⚠️ Anda sudah pernah menggunakan kode referral sebelumnya.` });
// [MOVED]     }
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   if (cleanTextLower === 'referral' || cleanTextLower === 'ref') {
// [MOVED]     const refCode = await db.generateReferralCode(senderNumber);
// [MOVED]     const stats = await db.getReferralStats(senderNumber);
// [MOVED]     const total = stats.totalReferred;
// [MOVED]     const claimed = stats.rewardsClaimed;
// [MOVED]     const eligibleRewards = Math.floor(total / 3);
// [MOVED]     const unclaimed = eligibleRewards - claimed;
// [MOVED] 
// [MOVED]     let rewardStatusMsg = "";
// [MOVED]     if (unclaimed > 0) {
// [MOVED]       const newCouponCode = 'REF10-' + Math.random().toString(36).substring(2, 7).toUpperCase();
// [MOVED]       await db.addCoupon(newCouponCode, 'percent', 10, 0, 1, null);
// [MOVED]       await db.claimReferralRewardCount(senderNumber, unclaimed);
// [MOVED]       rewardStatusMsg = `🎉 *SELAMAT! Anda telah mengundang ${total} teman!*\n\n🏷️ *KUPON DISKON 10% ANDA:* \`${newCouponCode}\`\n💡 _Gunakan dengan mengetik:_ \`kupon ${newCouponCode}\` _saat checkout!_\n\n`;
// [MOVED]     } else {
// [MOVED]       const progress = total % 3;
// [MOVED]       const needed = 3 - progress;
// [MOVED]       rewardStatusMsg = `📊 Progres Hadiah: *${progress}/3 teman diajak*\n💡 Ajak *${needed} teman lagi* untuk mendapatkan Kupon Diskon 10%!\n\n`;
// [MOVED]     }
// [MOVED] 
// [MOVED]     const refMsg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// [MOVED] 🎁 *PROGRAM REFERRAL*
// [MOVED] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// [MOVED] 
// [MOVED] Kode Referral Anda: *${refCode}*
// [MOVED] 
// [MOVED] ${rewardStatusMsg}📋 *Detail Statistik:*
// [MOVED] • Total Teman Diajak: *${total}*
// [MOVED] • Kupon Diskon Diklaim: *${claimed + (unclaimed > 0 ? unclaimed : 0)}x Kupon 10%*
// [MOVED] 
// [MOVED] 💡 *Cara Menggunakan:*
// [MOVED] Ajak teman Anda untuk mengetik \`ref ${refCode}\` di chat ini. Setiap 3 teman yang diajak, Anda berhak mendapatkan 1 Kupon Diskon 10%!
// [MOVED] 
// [MOVED] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
// [MOVED]     await sock.sendMessage(responseJid, { text: refMsg });
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // 15. BUNDLE / PAKET
// [MOVED]   if (cleanTextLower === 'bundle' || cleanTextLower === 'paket') {
// [MOVED]     const bundles = await db.getActiveBundles();
// [MOVED]     if (bundles.length === 0) {
// [MOVED]       await sock.sendMessage(responseJid, { text: "📦 Saat ini belum ada paket bundling yang tersedia." });
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📦 *PAKET BUNDLING HEMAT*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
// [MOVED]     for (const b of bundles) {
// [MOVED]       const items = b.produk_list.map(p => `${p.kode} x${p.qty}`).join(', ');
// [MOVED]       msg += `🎁 *${b.nama}*\n   Isi: ${items}\n   Harga Paket: *Rp${b.harga_bundle.toLocaleString('id-ID')}*\n\n`;
// [MOVED]     }
// [MOVED]     msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n_Hubungi admin untuk memesan paket bundling._`;
// [MOVED]     await sock.sendMessage(responseJid, { text: msg });
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // 16. SIMPAN / ADD TO WISHLIST
// [MOVED]   const simpanRegex = /^simpan\s+(\w+)$/i;
// [MOVED]   if (simpanRegex.test(text)) {
// [MOVED]     const code = text.match(simpanRegex)[1].toUpperCase();
// [MOVED]     const p = await db.getProductByKode(code);
// [MOVED]     if (!p) {
// [MOVED]       await sock.sendMessage(responseJid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     await db.addToWishlist(senderNumber, code);
// [MOVED]     await sock.sendMessage(responseJid, { text: `💝 Produk *${p.nama}* (\`${code}\`) berhasil ditambahkan ke wishlist Anda!\nKetik *favorit* untuk melihat daftar wishlist.` });
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // 17. FAVORIT / WISHLIST
// [MOVED]   if (cleanTextLower === 'favorit' || cleanTextLower === 'wishlist') {
// [MOVED]     const items = await db.getWishlist(senderNumber);
// [MOVED]     if (items.length === 0) {
// [MOVED]       await sock.sendMessage(responseJid, { text: "💝 Wishlist Anda masih kosong.\nKetik *simpan [KODE]* untuk menambahkan produk favorit." });
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💝 *WISHLIST / FAVORIT ANDA*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
// [MOVED]     for (const item of items) {
// [MOVED]       const stockLabel = item.stok === 0 ? '🔴 Habis' : `🟢 ${item.stok} pcs`;
// [MOVED]       msg += `📌 *${item.nama}* (\`${item.produk_kode}\`)\n   Harga: *Rp${item.harga.toLocaleString('id-ID')}* | Stok: ${stockLabel}\n\n`;
// [MOVED]     }
// [MOVED]     msg += `Ketik *beli [KODE] [JUMLAH]* untuk memesan.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
// [MOVED]     await sock.sendMessage(responseJid, { text: msg });
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // 19. SALDO PELANGGAN (.saldo)
// [MOVED]   if (textLower === 'saldo' || textLower === '.saldo') {
// [MOVED]     const bal = await db.getCustomerBalance(senderNumber);
// [MOVED]     const msg = `💳 *SALDO DEPOSIT ANDA* 💳
// [MOVED] 
// [MOVED] 👤 Pengguna: *${m.pushName || 'Pelanggan'}*
// [MOVED] 💰 Sisa Saldo: *Rp${bal.toLocaleString('id-ID')}*
// [MOVED] 
// [MOVED] 💡 *Fungsi Saldo:*
// [MOVED] Saldo dapat digunakan untuk membeli produk secara instan tanpa perlu melakukan scan QRIS setiap kali belanja!
// [MOVED] 
// [MOVED] _Ketik \`.deposit [NOMINAL]\` untuk melakukan Top Up Saldo._`;
// [MOVED]     await sock.sendMessage(responseJid, { text: msg });
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // 20. DEPOSIT TOPUP SALDO (.deposit [NOMINAL])
// [MOVED]   const depositMatch = text.match(/^[\.\/]?deposit\s+(\d+)$/i);
// [MOVED]   if (depositMatch) {
// [MOVED]     const amount = parseInt(depositMatch[1]);
// [MOVED]     if (amount < 5000) {
// [MOVED]       await sock.sendMessage(responseJid, { text: "⚠️ *Nominal Minimal Deposit:* Rp5.000" });
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     try {
// [MOVED]       const depositOrderId = `DEP-${Date.now()}`;
// [MOVED]       await db.createDepositOrder(depositOrderId, senderNumber, amount);
// [MOVED] 
// [MOVED]       const { createPayment } = await import('./src/payment/paymentService.js');
// [MOVED]       const casakuPayment = await createPayment(depositOrderId, amount);
// [MOVED] 
// [MOVED]       let qrImageBuffer = null;
// [MOVED]       try {
// [MOVED]         const QRCode = (await import('qrcode')).default;
// [MOVED]         qrImageBuffer = await QRCode.toBuffer(casakuPayment.qrString, {
// [MOVED]           type: 'png',
// [MOVED]           width: 400,
// [MOVED]           margin: 2,
// [MOVED]           color: { dark: '#000000', light: '#ffffff' }
// [MOVED]         });
// [MOVED]       } catch (qrErr) {
// [MOVED]         console.error('[BOT] QR render error:', qrErr.message);
// [MOVED]       }
// [MOVED] 
// [MOVED]       const expiredAt = new Date(casakuPayment.expiredAt);
// [MOVED]       const expiredStr = expiredAt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
// [MOVED] 
// [MOVED]       const depInvoice = `━━━━━━━━━━━━━━━━━━━━
// [MOVED] 💳 *TOP UP SALDO DEPOSIT OTOMATIS*
// [MOVED] ━━━━━━━━━━━━━━━━━━━━
// [MOVED] 🆔 *Deposit ID:* ${depositOrderId}
// [MOVED] 👤 *Pelanggan:* ${m.pushName || 'Pelanggan'}
// [MOVED] 💸 *TOTAL YANG HARUS DIBAYAR:*
// [MOVED] 👉 *Rp${casakuPayment.totalAmount.toLocaleString('id-ID')}*
// [MOVED] ${casakuPayment.uniqueCode > 0 ? `_(Nominal top-up Rp${amount.toLocaleString('id-ID')} + kode unik Rp${casakuPayment.uniqueCode})_\n` : ''}
// [MOVED] ⏰ *Berlaku hingga:* ${expiredStr} WIB
// [MOVED] ━━━━━━━━━━━━━━━━━━━━
// [MOVED] 
// [MOVED] 📱 *Scan QRIS di bawah untuk membayar:*
// [MOVED] ✅ DANA / GoPay / OVO / ShopeePay / BCA / BRI / Mandiri / dll.
// [MOVED] 
// [MOVED] 🔄 *Saldo bertambah OTOMATIS setelah pembayaran terdeteksi.*
// [MOVED] ⚠️ *PENTING:* Transfer pas sebesar *Rp${casakuPayment.totalAmount.toLocaleString('id-ID')}*.`;
// [MOVED] 
// [MOVED]       if (qrImageBuffer) {
// [MOVED]         await sock.sendMessage(responseJid, {
// [MOVED]           image: qrImageBuffer,
// [MOVED]           caption: depInvoice,
// [MOVED]           mimetype: 'image/png'
// [MOVED]         });
// [MOVED]       } else {
// [MOVED]         await sock.sendMessage(responseJid, { text: depInvoice });
// [MOVED]       }
// [MOVED] 
// [MOVED]       await logToSystem('BALANCE', `💳 Top-up deposit Rp${amount.toLocaleString('id-ID')} diajukan oleh ${senderNumber} (${depositOrderId})`);
// [MOVED]     } catch (depErr) {
// [MOVED]       console.error('[DEPOSIT_ERR]', depErr.message);
// [MOVED]       await sock.sendMessage(responseJid, { text: `❌ Gagal membuat QRIS Top Up: ${depErr.message}` });
// [MOVED]     }
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED] 
// [MOVED]   // 21. REVIEW / ULASAN PRODUK (.review [ORDER_ID] [RATING 1-5] [ULASAN])
// [MOVED]   const reviewMatch = text.match(/^[\.\/]?review\s+(\S+)\s+([1-5])\s+(.+)$/i);
// [MOVED]   if (reviewMatch) {
// [MOVED]     const orderId = reviewMatch[1]; // Bug Fix: Order ID adalah string (ORD-xxx), bukan integer
// [MOVED]     const rating = parseInt(reviewMatch[2]);
// [MOVED]     const comment = reviewMatch[3].trim();
// [MOVED] 
// [MOVED]     const orderObj = await db.getOrderById(orderId);
// [MOVED]     if (!orderObj || orderObj.customer_nomor !== senderNumber) {
// [MOVED]       await sock.sendMessage(responseJid, { text: `❌ Transaksi #${orderId} tidak ditemukan pada akun Anda.` });
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     await db.addReview(orderId, senderNumber, rating, comment);
// [MOVED]     const stars = '⭐'.repeat(rating);
// [MOVED]     await sock.sendMessage(responseJid, { text: `🎉 *Terima Kasih Atas Ulasan Anda!*\n\nRating: ${stars} (${rating}/5)\nUlasan: "${comment}"` });
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // 22. PETUNJUK PENGGUNAAN PRODUK (.carapake [KODE] / .petunjuk [KODE])
// [MOVED]   if (['carapake', 'petunjuk', 'tutor', 'cara'].includes(cleanCmd)) {
// [MOVED]     const pKode = args[1]?.toUpperCase();
// [MOVED]     if (!pKode) {
// [MOVED]       await sock.sendMessage(responseJid, { text: "⚠️ Format salah. Gunakan: `.carapake <KODE_PRODUK>`\nContoh: `.carapake APM01`" });
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     const product = await db.getProductByKode(pKode);
// [MOVED]     if (!product) {
// [MOVED]       await sock.sendMessage(responseJid, { text: `❌ Produk dengan kode *${pKode}* tidak ditemukan.` });
// [MOVED]       return;
// [MOVED]     }
// [MOVED]     await sock.sendMessage(responseJid, { text: product.petunjuk });
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // 23. RIWAYAT VOUCHER & KREDENSIAL DIGITAL PELANGGAN (.voucherku / .riwayat / .history / .myvouchers)
// [MOVED]   if (['voucherku', 'myvouchers', 'riwayat', 'history', 'pesananku', 'myorders', 'akunku'].includes(cleanCmd)) {
// [MOVED]     const history = await db.getCustomerVoucherHistory(senderNumber);
// [MOVED] 
// [MOVED]     if (!history || history.length === 0) {
// [MOVED]       const emptyMsg = `ℹ️ Halo *${customerName}*, Anda belum memiliki riwayat pembelian produk digital yang selesai.
// [MOVED] 
// [MOVED] Ketik *.produk* untuk melihat daftar produk toko kami!`;
// [MOVED]       await sock.sendMessage(responseJid, { text: emptyMsg });
// [MOVED]       return;
// [MOVED]     }
// [MOVED] 
// [MOVED]     let msg = `━━━━━━━━━━━━━━━━━━━━
// [MOVED] 🔑 *RIWAYAT VOUCHER & PRODUK DIGITAL*
// [MOVED] ━━━━━━━━━━━━━━━━━━━━
// [MOVED] Halo *${customerName}*, berikut adalah daftar voucher / akun digital dari pesanan Anda sebelumnya:\n\n`;
// [MOVED] 
// [MOVED]     history.forEach((order, idx) => {
// [MOVED]       const dateStr = new Date(order.created_at).toLocaleString('id-ID');
// [MOVED]       msg += `📦 *[${idx + 1}] Order ID:* \`${order.order_id}\`
// [MOVED] ⏰ Waktu: ${dateStr}
// [MOVED] 💰 Total: Rp${order.total.toLocaleString('id-ID')}\n`;
// [MOVED] 
// [MOVED]       if (order.items && order.items.length > 0) {
// [MOVED]         order.items.forEach(item => {
// [MOVED]           msg += `   • *${item.produk_nama}* (\`${item.produk_kode}\`) x${item.qty}\n`;
// [MOVED]         });
// [MOVED]       }
// [MOVED] 
// [MOVED]       if (order.credentials && order.credentials.length > 0) {
// [MOVED]         msg += `   🔑 *Kredensial / Voucher:* \n`;
// [MOVED]         order.credentials.forEach((c, cIdx) => {
// [MOVED]           msg += `      ${cIdx + 1}. \`${c.data_content}\`\n`;
// [MOVED]         });
// [MOVED]       } else {
// [MOVED]         msg += `   ℹ️ *Item Manual / Diproses Admin*\n`;
// [MOVED]       }
// [MOVED]       msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
// [MOVED]     });
// [MOVED] 
// [MOVED]     msg += `💡 *Tips:* Ketik \`.carapake <KODE>\` jika Anda membutuhkan petunjuk penggunaan ulang produk (Contoh: \`.carapake APM01\`).`;
// [MOVED] 
// [MOVED]     if (isFromGroup) {
// [MOVED]       const mentionJid = senderNumber.split('@')[0];
// [MOVED]       await sock.sendMessage(jid, { 
// [MOVED]         text: `🔐 *Keamanan Akun:* Halo @${mentionJid}, demi menjaga kerahasiaan password & voucher Anda, daftar riwayat voucher belanja telah kami kirimkan ke *Chat Pribadi (DM)* Anda. Silakan periksa pesan masuk dari bot!`,
// [MOVED]         mentions: [senderNumber]
// [MOVED]       });
// [MOVED]       await sock.sendMessage(senderNumber, { text: msg });
// [MOVED]     } else {
// [MOVED]       await sock.sendMessage(jid, { text: msg });
// [MOVED]     }
// [MOVED]     return;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // 18. MENERIMA FOTO BUKTI TRANSFER (DISIMPAN SECARA BERTIKAT YYYY/MM)
// [MOVED]   if (messageObj.message.imageMessage) {
// [MOVED]     const lastOrder = await db.getCustomerLastOrder(senderNumber);
// [MOVED]     if (lastOrder && lastOrder.status === 'WAITING_PAYMENT') {
// [MOVED]       console.log('Bukti pembayaran terdeteksi. Mengunduh media...');
// [MOVED]       const buffer = await downloadMediaMessage(messageObj, 'buffer', {});
// [MOVED] 
// [MOVED]       // Buat struktur direktori bertingkat YYYY/MM
// [MOVED]       const date = new Date(lastOrder.created_at);
// [MOVED]       const year = date.getFullYear().toString();
// [MOVED]       const month = (date.getMonth() + 1).toString().padStart(2, '0');
// [MOVED]       const dirPath = `./public/receipts/${year}/${month}`;
// [MOVED]       
// [MOVED]       // Pastikan direktori folder YYYY/MM ada
// [MOVED]       if (!fs.existsSync(dirPath)) {
// [MOVED]         fs.mkdirSync(dirPath, { recursive: true });
// [MOVED]       }
// [MOVED] 
// [MOVED]       // Simpan bukti transfer secara lokal ke folder receipts/YYYY/MM/[ORDER_ID].jpg
// [MOVED]       const filePath = path.join(dirPath, `${lastOrder.order_id}.jpg`);
// [MOVED]       fs.writeFileSync(filePath, buffer);
// [MOVED]       console.log(`Bukti transfer berhasil disimpan di: ${filePath}`);
// [MOVED] 
// [MOVED]       // Ubah status order di DB menjadi WAITING_CONFIRMATION
// [MOVED]       await db.updateOrderStatus(lastOrder.order_id, 'WAITING_CONFIRMATION');
// [MOVED]       const orderDetails = await db.getOrderDetails(lastOrder.order_id);
// [MOVED] 
// [MOVED]       // Konfirmasi ke customer
// [MOVED]       const confirmText = `✅ *Bukti transfer Anda telah kami terima!*
// [MOVED]       
// [MOVED] Pembayaran untuk Order ID *${lastOrder.order_id}* sedang diverifikasi oleh admin. Kami akan memberikan notifikasi otomatis jika status pesanan berubah. Terima kasih!`;
// [MOVED]       await sock.sendMessage(jid, { text: confirmText });
// [MOVED] 
// [MOVED]       // Kirim info ke Grup Transaksi WhatsApp jika diatur
// [MOVED]       if (botSettings.transactionGroupId) {
// [MOVED]         const groupMsg = `━━━━━━━━━━━━━━━━━━
// [MOVED] 📥 *BUKTI PEMBAYARAN BARU*
// [MOVED] ━━━━━━━━━━━━━━━━━━
// [MOVED] Order ID: *${orderDetails.order_id}*
// [MOVED] Nama: *${orderDetails.customer_nama}*
// [MOVED] No WA: wa.me/${senderNumber.split('@')[0]}
// [MOVED] Total Belanja: *Rp${orderDetails.total.toLocaleString('id-ID')}*
// [MOVED] Status: *WAITING_CONFIRMATION*
// [MOVED] 
// [MOVED] *Item:*
// [MOVED] ${orderDetails.items.map(item => `- ${item.produk_nama} (\`${item.produk_kode}\`) x${item.qty}`).join('\n')}
// [MOVED] ━━━━━━━━━━━━━━━━━━
// [MOVED] ⚙️ *PERINTAH ADMIN (Balas di grup ini):*
// [MOVED] • \`/paid ${orderDetails.order_id}\` : Konfirmasi pembayaran
// [MOVED] • \`/done ${orderDetails.order_id}\` : Pesanan selesai diproses
// [MOVED] • \`/cancel ${orderDetails.order_id}\` : Batalkan pesanan
// [MOVED] ━━━━━━━━━━━━━━━━━━`;
// [MOVED] 
// [MOVED]         await sock.sendMessage(botSettings.transactionGroupId, { 
// [MOVED]           image: buffer, 
// [MOVED]           caption: groupMsg 
// [MOVED]         });
// [MOVED]       }
// [MOVED]       
// [MOVED]       await logToSystem('PAYMENT', `📸 Bukti transfer diterima untuk Order ID *${lastOrder.order_id}* dari customer *${orderDetails.customer_nama}*. Bukti disimpan secara lokal.`);
// [MOVED]       return;
// [MOVED]     }
// [MOVED]   }
// [MOVED] 
// [MOVED]   // FAQ OTOMATIS — cek kemiripan keyword sebelum balas 'tidak dikenal'
// [MOVED]   if (!isFromGroup && !textLower.startsWith('/')) {
// [MOVED]     const faqMatch = await db.findFaqMatch(text);
// [MOVED]     if (faqMatch) {
// [MOVED]       await sock.sendMessage(jid, { text: faqMatch.answer });
// [MOVED]       return;
// [MOVED]     }
// [MOVED]   }
// [MOVED] 
// [MOVED] }

// ==========================================
// LOGIKA PESAN GRUP (ADMIN GROUP / GET JID)
// ==========================================
// [MOVED] async function handleGroupMessage(jid, senderNumber, messageObj, text, isGroupAdminParam) {
// [MOVED]   const isGroup = jid.endsWith('@g.us');
// [MOVED]   const m = messageObj;
// [MOVED]   const senderNormalized = senderNumber;
// [MOVED]   const args = text.trim().split(/\s+/);
// [MOVED]   const rawCmd = args[0].toLowerCase();
// [MOVED]   const cleanCmd = rawCmd.replace(/^[./#]/, '');
// [MOVED] 
// [MOVED]   const adminStoreCommands = [
// [MOVED]     'paid', 'done', 'cancel', 'flashsale', 'stats', 'broadcast', 'addcoupon', 
// [MOVED]     'delcoupon', 'listcoupon', 'addfaq', 'delfaq', 'listfaq', 'laporan', 
// [MOVED]     'restock', 'stock', 'price', 'out', 'ready', 'addproduct', 'takeover', 
// [MOVED]     'release', 'setname', 'setowner', 'eval', 'exec', 'backup'
// [MOVED]   ];
// [MOVED] 
// [MOVED]   const groupModerationCommands = [
// [MOVED]     'add', 'kick', 'promote', 'demote', 'group', 'link', 'tagall', 'hidetag', 
// [MOVED]     'everyone', 'admins', 'mode', 'setmode', 'botmode', 'antilink', 'welcome', 
// [MOVED]     'autowelcomeswitch', 'setwelcome', 'setupdategroup', 'autosholat'
// [MOVED]   ];
// [MOVED] 
// [MOVED]   const banCommands = ['ban', 'unban', 'addmod', 'delmod', 'listmod', 'setownerid', 'join', 'antidelete'];
// [MOVED] 
// [MOVED]   // Jika bukan perintah admin/moderasi, lewati agar ditangani handler lain
// [MOVED]   if (!adminStoreCommands.includes(cleanCmd) && !groupModerationCommands.includes(cleanCmd) && !banCommands.includes(cleanCmd) && cleanCmd !== 'getjid' && cleanCmd !== 'owner') {
// [MOVED]     return false;
// [MOVED]   }
// [MOVED] 
// [MOVED]   if (cleanCmd === 'resetleaderboard') {
// [MOVED]     const res = await db.resetGameLeaderboard();
// [MOVED]     await sock.sendMessage(jid, { text: `✅ *LEADERBOARD GAME DIRESET BERSIH!*\n\nSemua poin, level, dan streak game pengguna un-registered telah dibersihkan.\n\nSekarang hanya member terdaftar (.daftar <nama>) yang dapat mengumpulkan poin dan masuk ke leaderboard!` });
// [MOVED]     return true;
// [MOVED]   }
// [MOVED] 
// [MOVED]   if (cleanCmd === 'getjid') {
// [MOVED]     await sock.sendMessage(jid, { 
// [MOVED]       text: `ID Chat/Grup ini adalah:\n\`${jid}\`\n\nID Anda adalah:\n\`${senderNumber}\`\n\nSilakan salin ID di atas dan masukkan ke pengaturan Web Dashboard jika ini adalah Grup Transaksi atau Grup Log.` 
// [MOVED]     });
// [MOVED]     return true;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // /owner diperbolehkan di mana saja
// [MOVED]   if (cleanCmd === 'owner') {
// [MOVED]     const ownerJid = botSettings.ownerNumber || config.defaults.ownerNumber;
// [MOVED]     const ownerNum = ownerJid.split('@')[0].replace(/[^0-9]/g, '');
// [MOVED]     const ownerName = `Owner ${botSettings.botName || 'Akbar Store'}`;
// [MOVED] 
// [MOVED]     const vcard = `BEGIN:VCARD
// [MOVED] VERSION:3.0
// [MOVED] FN:${ownerName}
// [MOVED] ORG:${botSettings.botName || 'Akbar Store'};
// [MOVED] TEL;type=CELL;type=VOICE;waid=${ownerNum}:+${ownerNum}
// [MOVED] END:VCARD`;
// [MOVED] 
// [MOVED]     try {
// [MOVED]       await sock.sendMessage(jid, { 
// [MOVED]         contacts: { 
// [MOVED]           displayName: ownerName, 
// [MOVED]           contacts: [{ vcard }] 
// [MOVED]         } 
// [MOVED]       });
// [MOVED] 
// [MOVED]       const infoMsg = `👑 *KONTAK PEMILIK (OWNER) TOKO* 👑
// [MOVED] 
// [MOVED] 👤 Nama Toko: *${botSettings.botName || 'Akbar Store'}*
// [MOVED] 📞 WhatsApp: *+${ownerNum}*
// [MOVED] 🔗 Chat Langsung: https://wa.me/${ownerNum}
// [MOVED] 
// [MOVED] _Silakan simpan kontak kartu di atas jika ada kendala khusus atau pertanyaan kerjasama._`;
// [MOVED] 
// [MOVED]       await sock.sendMessage(jid, { text: infoMsg });
// [MOVED]     } catch (err) {
// [MOVED]       console.error("[OWNER_CMD_ERR]", err.message);
// [MOVED]     }
// [MOVED]     return true;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // Normalisasi nomor HP untuk verifikasi Owner & Admin yang 100% Presisi
// [MOVED]   const cleanDigits = str => (str || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
// [MOVED]   const ownerPhoneNum = cleanDigits(botSettings.ownerNumber || config.defaults.ownerNumber);
// [MOVED]   const storedOwnerJid = (botSettings.ownerJid || '').trim();
// [MOVED]   const senderDigits = cleanDigits(senderNumber);
// [MOVED]   const jidDigits = cleanDigits(jid);
// [MOVED] 
// [MOVED]   // Cek Moderator dari DB
// [MOVED]   const isMod = await db.isModerator(senderNormalized);
// [MOVED] 
// [MOVED]   // Cek Owner: via m.key.fromMe, stored JID (handles @lid), phone digit match, atau JID DM match.
// [MOVED]   // PENTING: exact match saja (bukan .includes()) — substring match membuka celah bypass,
// [MOVED]   // contoh nomor "6283170183637000" akan lolos jika ownerPhoneNum "6283170183637" dicek dengan includes().
// [MOVED]   const isOwner = !!m.key?.fromMe ||
// [MOVED]                   !!(storedOwnerJid && senderNormalized === storedOwnerJid) ||
// [MOVED]                   !!(ownerPhoneNum && senderDigits && ownerPhoneNum === senderDigits) ||
// [MOVED]                   !!(!isGroup && ownerPhoneNum && jidDigits && ownerPhoneNum === jidDigits);
// [MOVED] 
// [MOVED] 
// [MOVED]   const adminList = (botSettings.adminNumbers || config.defaults.adminNumbers || '').split(',').map(n => cleanDigits(n));
// [MOVED]   const isAdminStore = isOwner || isMod || adminList.includes(senderDigits);
// [MOVED]   const isAdminUser = isAdminStore || isGroupAdminParam;
// [MOVED] 
// [MOVED]   // Jika bukan Admin/Owner dan mencoba perintah khusus Admin, diam
// [MOVED]   if (!isAdminUser) {
// [MOVED]     return true;
// [MOVED]   }
// [MOVED] 
// [MOVED]   // 🔒 Guard Grup Admin ACC khusus untuk perintah transaksi toko
// [MOVED]   if (adminStoreCommands.includes(cleanCmd)) {
// [MOVED]     const adminGroupId = botSettings.adminGroupId || botSettings.transactionLogGroupId || "";
// [MOVED]     if (adminGroupId && isGroup && jid !== adminGroupId) {
// [MOVED]       // Diam / tidak merespons perintah admin yang salah tempat agar tidak spam grup
// [MOVED]       return true;
// [MOVED]     }
// [MOVED]   }
// [MOVED] 
// [MOVED]     if (cleanCmd === 'stats') {
// [MOVED]       if (!isOwner) {
// [MOVED]         await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Pemilik (Owner) bot." });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       const stats = await db.getStats();
// [MOVED]       const statsText = `📊 *STATISTIK TOKO DIGITAL*
// [MOVED]       
// [MOVED] • Total Jenis Produk: *${stats.products}*
// [MOVED] • Total Pelanggan: *${stats.customers}*
// [MOVED] • Total Pesanan Selesai: *${stats.completedOrders}*
// [MOVED] • Total Omset Penjualan: *Rp${stats.totalRevenue.toLocaleString('id-ID')}*`;
// [MOVED]       await sock.sendMessage(jid, { text: statsText });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // .setupdategroup — Mengatur grup ini sebagai grup pengumuman (restock/price drop)
// [MOVED]     if (cleanCmd === 'setupdategroup') {
// [MOVED]       if (!isAdminUser) return true;
// [MOVED]       if (!isGroup) {
// [MOVED]         await sock.sendMessage(jid, { text: "❌ Perintah ini hanya bisa digunakan di dalam grup." });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       await db.updateSettings({ updateGroupId: jid });
// [MOVED]       // Update config lokal di memori agar terbaca cepat
// [MOVED]       botSettings.updateGroupId = jid; 
// [MOVED]       await sock.sendMessage(jid, { 
// [MOVED]         text: `✅ *Berhasil!* Grup ini (\`${jid}\`) telah ditetapkan sebagai grup untuk menerima notifikasi otomatis (Restock & Penurunan Harga).\n\nKetik \`.testupdate\` untuk uji coba kirim pesan tagall ke grup ini.` 
// [MOVED]       });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // .testupdate — Mengirimkan pesan uji coba tagall ke grup update
// [MOVED]     if (cleanCmd === 'testupdate') {
// [MOVED]       if (!isAdminUser) return true;
// [MOVED]       const targetGroup = botSettings.updateGroupId || (isGroup ? jid : null);
// [MOVED]       if (!targetGroup) {
// [MOVED]         await sock.sendMessage(jid, { text: `⚠️ Belum ada grup update yang diset. Jalankan \`.setupdategroup\` di grup pilihanmu terlebih dahulu.` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       const testMsg = `📣 *TEST NOTIFIKASI RESTOCK & HARGA TOKO* 📣\n\nHalo member! Ini adalah pesan uji coba sistem notifikasi otomatis toko.\n\n_Jika Anda menerima notifikasi ini dengan tag, berarti sistem bekerja dengan baik!_`;
// [MOVED]       const success = await broadcastTagAll(sock, targetGroup, testMsg);
// [MOVED]       if (success) {
// [MOVED]         await sock.sendMessage(jid, { text: `✅ Berhasil mengirimkan pesan tagall uji coba ke grup \`${targetGroup}\`!` });
// [MOVED]       } else {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Gagal mengirimkan pesan tagall ke grup \`${targetGroup}\`. Pastikan bot adalah anggota/admin di grup tersebut.` });
// [MOVED]       }
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // ===================================================================
// [MOVED]     // BAN SYSTEM — Owner-only by default, atau Moderator yang didaftarkan
// [MOVED]     // ===================================================================
// [MOVED] 
// [MOVED]     // .setownerid — Owner mendaftarkan JID aktifnya (handles @lid, HANYA dari DM)
// [MOVED]     if (cleanCmd === 'setownerid') {
// [MOVED]       if (isGroup) {
// [MOVED]         await sock.sendMessage(jid, { text: `⚠️ Perintah ini hanya bisa dipakai di *DM* (chat privat ke bot), bukan di grup.` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       
// [MOVED]       // Murni mengecek apakah sender adalah Owner yang sah berdasarkan nomor di config.js (.env)
// [MOVED]       if (!isOwner && !m.key?.fromMe) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Akses ditolak. Hanya nomor Owner di config.js yang dapat mengatur JID secara dinamis.` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       await db.updateSettings({ ownerJid: senderNormalized });
// [MOVED]       botSettings = await db.getSettings();
// [MOVED]       await sock.sendMessage(jid, { text: `✅ *Owner JID Berhasil Didaftarkan!*
// [MOVED] 
// [MOVED] 🆔 JID Tersimpan: \`${senderNormalized}\`
// [MOVED] 
// [MOVED] Sekarang Anda akan dikenali sebagai Owner di semua grup meskipun menggunakan sistem @lid WhatsApp terbaru. 🎉` });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // .antidelete — Toggle fitur Rewind/Anti-Delete Pesan
// [MOVED]     if (cleanCmd === 'antidelete') {
// [MOVED]       if (!isOwner) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Akses ditolak. Hanya Owner yang bisa menggunakan fitur ini.` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       
// [MOVED]       const currentAntiDelete = botSettings.antiDelete === 'true' || botSettings.antiDelete === true;
// [MOVED]       const newStatus = !currentAntiDelete;
// [MOVED]       
// [MOVED]       await db.updateSettings({ antiDelete: newStatus.toString() });
// [MOVED]       botSettings = await db.getSettings(); // Reload config
// [MOVED]       
// [MOVED]       const statusText = newStatus ? "✅ *AKTIF*" : "❌ *NONAKTIF*";
// [MOVED]       await sock.sendMessage(jid, { text: `Fitur *Anti-Delete (Rewind)* sekarang ${statusText}.\n\nJika aktif, bot akan menangkap pesan yang dihapus oleh pengirim dan menampilkannya kembali.` });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // .join — Bergabung ke grup via link (Rental / Sewa bot)
// [MOVED]     if (cleanCmd === 'join') {
// [MOVED]       if (!isOwner) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Akses ditolak. Hanya Owner yang bisa menggunakan fitur ini.` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       if (!args[1] || !args[2]) {
// [MOVED]         await sock.sendMessage(jid, { text: `⚠️ Format: \`.join <link_grup> <durasi_hari>\`\nContoh: \`.join https://chat.whatsapp.com/xxx 7\`` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       const link = args[1];
// [MOVED]       const days = parseInt(args[2]);
// [MOVED] 
// [MOVED]       if (isNaN(days) || days <= 0) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Durasi hari harus berupa angka positif.` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       const codeMatch = link.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
// [MOVED]       if (!codeMatch) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Link grup tidak valid.` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       const inviteCode = codeMatch[1];
// [MOVED]       
// [MOVED]       try {
// [MOVED]         const joinedJid = await sock.groupAcceptInvite(inviteCode);
// [MOVED]         const expiresAt = await db.addGroupRental(joinedJid, days, senderNormalized);
// [MOVED]         await sock.sendMessage(jid, { text: `✅ Berhasil bergabung ke grup!\n\nID Grup: ${joinedJid}\nMasa Sewa: ${days} hari\nBerakhir Pada: ${new Date(expiresAt).toLocaleString('id-ID')}` });
// [MOVED]         
// [MOVED]         // Kirim salam perkenalan di grup baru
// [MOVED]         await sock.sendMessage(joinedJid, { text: `Halo semuanya! 👋\n\nBot ini disewa untuk grup ini selama *${days} hari*.\nKetik \`.menu\` untuk melihat daftar fitur yang tersedia!` });
// [MOVED]       } catch (err) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Gagal bergabung ke grup: mungkin bot sudah di-banned dari sana atau link sudah dicabut. (${err.message})` });
// [MOVED]       }
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // .ban / .unban — Owner atau Moderator terdaftar
// [MOVED]     if (cleanCmd === 'ban' || cleanCmd === 'unban') {
// [MOVED]       const isMod = await db.isModerator(senderNormalized);
// [MOVED]       if (!isOwner && !isMod) {
// [MOVED]         return true; // Silent — bukan owner atau mod
// [MOVED]       }
// [MOVED] 
// [MOVED]       // Cari target JID dari mention, quote, atau angka manual
// [MOVED]       let targetJid = '';
// [MOVED]       const mentionedList = m.message?.extendedTextMessage?.contextInfo?.mentionedJid;
// [MOVED]       const quotedParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
// [MOVED]       if (mentionedList?.length > 0) {
// [MOVED]         targetJid = mentionedList[0];
// [MOVED]       } else if (quotedParticipant) {
// [MOVED]         targetJid = quotedParticipant;
// [MOVED]       } else if (args[1]) {
// [MOVED]         const numOnly = args[1].replace(/[^0-9]/g, '');
// [MOVED]         if (numOnly) targetJid = numOnly + '@s.whatsapp.net';
// [MOVED]       }
// [MOVED] 
// [MOVED]       if (!targetJid) {
// [MOVED]         await sock.sendMessage(jid, { text: `⚠️ Gunakan: \`.${cleanCmd} @user\`, reply pesan usernya, atau \`.${cleanCmd} 628xxx\`` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       // Proteksi: tidak bisa ban Owner atau Moderator lain
// [MOVED]       const targetDigitsCheck = cleanDigits(targetJid);
// [MOVED]       const isTargetOwner = (storedOwnerJid && targetJid === storedOwnerJid) || (ownerPhoneNum && targetDigitsCheck === ownerPhoneNum);
// [MOVED]       const isTargetMod = await db.isModerator(targetJid);
// [MOVED] 
// [MOVED]       if (cleanCmd === 'ban' && (isTargetOwner || isTargetMod)) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Tidak bisa mem-ban Owner atau Moderator.` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       if (cleanCmd === 'ban') {
// [MOVED]         // Tentukan argumen sisa setelah target di-parse
// [MOVED]         let remainingArgs = [];
// [MOVED]         if (mentionedList?.length > 0) {
// [MOVED]           remainingArgs = args.slice(2);
// [MOVED]         } else if (quotedParticipant) {
// [MOVED]           remainingArgs = args.slice(1);
// [MOVED]         } else if (args[1]) {
// [MOVED]           remainingArgs = args.slice(2);
// [MOVED]         }
// [MOVED] 
// [MOVED]         // Parsing durasi
// [MOVED]         const parsed = parseDuration(remainingArgs);
// [MOVED]         const reason = remainingArgs.slice(parsed.consumed).join(' ') || 'Tanpa alasan.';
// [MOVED]         
// [MOVED]         await db.banUser(targetJid, reason, senderNormalized, parsed.expiresAt);
// [MOVED] 
// [MOVED]         let confirmationMsg = `🚫 *USER DI-BAN*\n\n`;
// [MOVED]         confirmationMsg += `👤 Target: @${targetJid.split('@')[0]}\n`;
// [MOVED]         confirmationMsg += `⏱️ Durasi: *${parsed.durationText}*\n`;
// [MOVED]         
// [MOVED]         if (parsed.expiresAt) {
// [MOVED]           const expiryDate = new Date(parsed.expiresAt);
// [MOVED]           const formattedExpiry = expiryDate.toLocaleString('id-ID', {
// [MOVED]             weekday: 'long',
// [MOVED]             year: 'numeric',
// [MOVED]             month: 'long',
// [MOVED]             day: 'numeric',
// [MOVED]             hour: '2-digit',
// [MOVED]             minute: '2-digit',
// [MOVED]             timeZoneName: 'short'
// [MOVED]           });
// [MOVED]           confirmationMsg += `⏳ Berlaku Sampai: _${formattedExpiry}_\n`;
// [MOVED]         }
// [MOVED]         
// [MOVED]         confirmationMsg += `📝 Alasan: ${reason}\n`;
// [MOVED]         confirmationMsg += `🔨 Oleh: ${m.pushName || senderNormalized}\n\n`;
// [MOVED]         confirmationMsg += `Bot tidak akan merespons pesan dari user ini selama masa ban aktif.`;
// [MOVED] 
// [MOVED]         await sock.sendMessage(jid, {
// [MOVED]           text: confirmationMsg,
// [MOVED]           mentions: [targetJid]
// [MOVED]         });
// [MOVED]       } else {
// [MOVED]         await db.unbanUser(targetJid);
// [MOVED]         await sock.sendMessage(jid, {
// [MOVED]           text: `✅ *USER DI-UNBAN*
// [MOVED] 
// [MOVED] 👤 Target: @${targetJid.split('@')[0]}
// [MOVED] ✔️ Oleh: ${m.pushName || senderNormalized}
// [MOVED] 
// [MOVED] User ini sekarang bisa kembali berinteraksi dengan bot.`,
// [MOVED]           mentions: [targetJid]
// [MOVED]         });
// [MOVED]       }
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // .addmod — Daftarkan Moderator (Owner only)
// [MOVED]     if (cleanCmd === 'addmod') {
// [MOVED]       if (!isOwner) return true;
// [MOVED]       const mentionedJid = m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
// [MOVED]                            m.message?.extendedTextMessage?.contextInfo?.participant || '';
// [MOVED]       if (!mentionedJid) {
// [MOVED]         await sock.sendMessage(jid, { text: `⚠️ Gunakan: \`.addmod @user\`` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       await db.addModerator(mentionedJid, senderNormalized);
// [MOVED]       await sock.sendMessage(jid, {
// [MOVED]         text: `✅ @${mentionedJid.split('@')[0]} telah didaftarkan sebagai *Moderator Bot*.
// [MOVED] Dia sekarang bisa menggunakan perintah \`.ban\` dan \`.unban\`.`,
// [MOVED]         mentions: [mentionedJid]
// [MOVED]       });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // .delmod — Hapus Moderator (Owner only)
// [MOVED]     if (cleanCmd === 'delmod') {
// [MOVED]       if (!isOwner) return true;
// [MOVED]       const mentionedJid = m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
// [MOVED]                            m.message?.extendedTextMessage?.contextInfo?.participant || '';
// [MOVED]       if (!mentionedJid) {
// [MOVED]         await sock.sendMessage(jid, { text: `⚠️ Gunakan: \`.delmod @user\`` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       await db.removeModerator(mentionedJid);
// [MOVED]       await sock.sendMessage(jid, {
// [MOVED]         text: `✅ @${mentionedJid.split('@')[0]} telah dihapus dari daftar Moderator Bot.`,
// [MOVED]         mentions: [mentionedJid]
// [MOVED]       });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // .listmod — Lihat daftar Moderator (Owner only)
// [MOVED]     if (cleanCmd === 'listmod') {
// [MOVED]       if (!isOwner) return true;
// [MOVED]       const mods = await db.listModerators();
// [MOVED]       if (!mods || mods.length === 0) {
// [MOVED]         await sock.sendMessage(jid, { text: `📋 *Daftar Moderator Bot*
// [MOVED] 
// [MOVED] Belum ada moderator yang terdaftar.
// [MOVED] Gunakan \`.addmod @user\` untuk menambahkan.` });
// [MOVED]       } else {
// [MOVED]         const modList = mods.map((mod, i) => `${i+1}. \`${mod.jid}\`\n   📅 ${new Date(mod.created_at).toLocaleDateString('id-ID')}`).join('\n');
// [MOVED]         await sock.sendMessage(jid, { text: `📋 *Daftar Moderator Bot* (${mods.length} orang)
// [MOVED] 
// [MOVED] ${modList}
// [MOVED] 
// [MOVED] Moderataor dapat menggunakan \`.ban\` dan \`.unban\`.` });
// [MOVED]       }
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // OWNER SUITE: Backup Database Instan via DM/Chat WA (.backup)
// [MOVED]     if (cleanCmd === 'backup') {
// [MOVED]       if (!isOwner) {
// [MOVED]         await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Pemilik (Owner) bot." });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       await sock.sendMessage(jid, { text: "⏳ Sedang membuat file cadangan database SQLite..." });
// [MOVED]       const backupFilePath = backupDatabase();
// [MOVED]       if (backupFilePath && fs.existsSync(backupFilePath)) {
// [MOVED]         const dbBuffer = fs.readFileSync(backupFilePath);
// [MOVED]         await sock.sendMessage(jid, { 
// [MOVED]           document: dbBuffer, 
// [MOVED]           mimetype: 'application/x-sqlite3', 
// [MOVED]           fileName: path.basename(backupFilePath), 
// [MOVED]           caption: `💾 *BACKUP DATABASE BERHASIL!*\n\n📁 File: \`${path.basename(backupFilePath)}\`\n⏰ Waktu: ${new Date().toLocaleString('id-ID')}` 
// [MOVED]         });
// [MOVED]       } else {
// [MOVED]         await sock.sendMessage(jid, { text: "❌ Gagal membuat backup database." });
// [MOVED]       }
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // OWNER SUITE: Ubah Nama Toko / Bot (.setname)
// [MOVED]     if (cleanCmd === 'setname') {
// [MOVED]       if (!isOwner) {
// [MOVED]         await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Pemilik (Owner) bot." });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       const newName = args.slice(1).join(' ');
// [MOVED]       if (!newName) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Gunakan: `.setname [NAMA_TOKO_BARU]`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       await db.updateSettings({ storeName: newName, botName: newName });
// [MOVED]       botSettings = await db.getSettings(); // Bug Fix: was getBotSettings (tidak ada)
// [MOVED]       await sock.sendMessage(jid, { text: `✅ Nama Toko / Bot berhasil diperbarui menjadi: *${newName}*` });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // OWNER SUITE: Ubah Nomor Owner Utama (.setowner)
// [MOVED]     if (cleanCmd === 'setowner') {
// [MOVED]       if (!isOwner) {
// [MOVED]         await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Pemilik (Owner) bot." });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       let newNum = args[1]?.replace(/[^0-9]/g, '');
// [MOVED]       if (!newNum) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Gunakan: `.setowner [NOMOR_WA]`\nContoh: `.setowner 628123456789`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       const newOwnerJid = `${newNum}@s.whatsapp.net`;
// [MOVED]       await db.updateSettings({ ownerNumber: newOwnerJid });
// [MOVED]       botSettings = await db.getSettings(); // Bug Fix: was getBotSettings (tidak ada)
// [MOVED]       await sock.sendMessage(jid, { text: `✅ Nomor Owner utama berhasil diperbarui ke: *+${newNum}*` });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (cleanCmd === 'autosholat') {
// [MOVED]       const isGroup = jid.endsWith('@g.us');
// [MOVED]       if (!isGroup) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Perintah pengaturan mode grup hanya dapat dijalankan di dalam Grup WhatsApp!" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       const state = args[1]?.toLowerCase();
// [MOVED]       if (!state || !['on', 'off'].includes(state)) {
// [MOVED]         const currentSettings = await db.getGroupSettings(jid);
// [MOVED]         const status = (currentSettings.auto_sholat === 1 || currentSettings.auto_sholat === undefined) ? 'ON (Aktif)' : 'OFF (Mati)';
// [MOVED]         await sock.sendMessage(jid, { text: `🕌 *PENGINGAT SHOLAT GRUP*\nStatus saat ini: *${status}*\n\nGunakan perintah:\n\`.autosholat on\` - Mengaktifkan pengingat\n\`.autosholat off\` - Mematikan pengingat di grup ini` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       const isEnabled = state === 'on' ? 1 : 0;
// [MOVED]       await db.updateGroupSettings(jid, { auto_sholat: isEnabled });
// [MOVED]       await sock.sendMessage(jid, { text: `✅ Pengingat sholat di grup ini berhasil diubah menjadi: *${state.toUpperCase()}*` });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED]     if (['mode', 'setmode', 'botmode'].includes(cleanCmd)) {
// [MOVED]       const isGroup = jid.endsWith('@g.us');
// [MOVED]       if (!isGroup) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Perintah pengaturan mode grup hanya dapat dijalankan di dalam Grup WhatsApp!" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       const newMode = args[1]?.toLowerCase();
// [MOVED]       const currentSettings = await db.getGroupSettings(jid);
// [MOVED]       
// [MOVED]       if (!newMode) {
// [MOVED]         let modeLabel = '🌐 MODE ALL (Respon Seluruh Fitur)';
// [MOVED]         if (currentSettings.bot_mode === 'sales') {
// [MOVED]           modeLabel = '🛍️ MODE JUALAN (Hanya Respon Produk & Toko)';
// [MOVED]         } else if (currentSettings.bot_mode === 'off') {
// [MOVED]           modeLabel = '🔴 OFF/MUTE (Bot Dinonaktifkan di Grup Ini)';
// [MOVED]         }
// [MOVED] 
// [MOVED]         await sock.sendMessage(jid, { 
// [MOVED]           text: `⚙️ *STATUS MODE BOT GRUP INI:*
// [MOVED]           
// [MOVED] Mode Saat Ini: *${modeLabel}*
// [MOVED] 
// [MOVED] 💡 *Cara Mengubah Mode:*
// [MOVED] • Ketik \`.mode jualan\` atau \`.mode sales\` (Khusus jualan & transaksi)
// [MOVED] • Ketik \`.mode all\` or \`.mode semua\` (Respon seluruh fitur & media)
// [MOVED] • Ketik \`.mode off\` atau \`.mode mute\` (Nonaktifkan respon bot sepenuhnya)` 
// [MOVED]         });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       if (!['sales', 'jualan', 'toko', 'all', 'semua', 'full', 'off', 'mute', 'nonaktif'].includes(newMode)) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Mode tidak valid. Gunakan: `.mode jualan`, `.mode all`, atau `.mode off`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       let targetMode = 'all';
// [MOVED]       if (['sales', 'jualan', 'toko'].includes(newMode)) {
// [MOVED]         targetMode = 'sales';
// [MOVED]       } else if (['off', 'mute', 'nonaktif'].includes(newMode)) {
// [MOVED]         targetMode = 'off';
// [MOVED]       }
// [MOVED] 
// [MOVED]       await db.updateGroupSettings(jid, { bot_mode: targetMode });
// [MOVED]       
// [MOVED]       let successMsg = "";
// [MOVED]       if (targetMode === 'sales') {
// [MOVED]         successMsg = "🛍️ *MODE JUALAN DIAKTOKAN UNTUK GRUP INI!* 🛍️\n\nBot sekarang *HANYA AKAN MERESPONS* perintah produk, katalog, transaksi, dan stok toko di grup ini. Perintah media/downloader/game/hiburan diabaikan agar grup tetap tertib khusus jualan.";
// [MOVED]       } else if (targetMode === 'off') {
// [MOVED]         successMsg = "🔴 *BOT DINONAKTIFKAN (MUTED) DI GRUP INI!* 🔴\n\nBot tidak akan merespons perintah apapun lagi di grup ini kecuali perintah `.mode` untuk mengaktifkannya kembali.";
// [MOVED]       } else {
// [MOVED]         successMsg = "🌐 *MODE ALL DIAKTIFKAN UNTUK GRUP INI!* 🌐\n\nBot sekarang merespons seluruh fitur (Jualan, Transaksi, Media, Downloader, Game, dan AI) di grup ini.";
// [MOVED]       }
// [MOVED] 
// [MOVED]       await sock.sendMessage(jid, { text: successMsg });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // MODERASI GRUP: Sakelar Proteksi Anti-Link (.antilink)
// [MOVED]     if (cleanCmd === 'antilink') {
// [MOVED]       const param = args[1]?.toLowerCase();
// [MOVED]       if (!['on', 'off', '1', '0', 'aktif', 'matikan'].includes(param)) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Gunakan: `.antilink on` atau `.antilink off`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       const isEnable = ['on', '1', 'aktif'].includes(param);
// [MOVED]       await db.updateGroupSettings(jid, { anti_link: isEnable ? 1 : 0 });
// [MOVED]       await sock.sendMessage(jid, { text: `🛡️ Proteksi Anti-Link Grup berhasil *${isEnable ? 'DIAKTIFKAN 🟢' : 'DINONAKTIFKAN 🔴'}* di grup ini!` });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // MODERASI GRUP: Sakelar Auto-Welcome Member Baru (.welcome, .autowelcomeswitch)
// [MOVED]     if (['welcome', 'autowelcomeswitch'].includes(cleanCmd)) {
// [MOVED]       const param = args[1]?.toLowerCase();
// [MOVED]       if (!['on', 'off', '1', '0', 'aktif', 'matikan'].includes(param)) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Gunakan: `.welcome on` atau `.welcome off`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       const isEnable = ['on', '1', 'aktif'].includes(param);
// [MOVED]       await db.updateGroupSettings(jid, { welcome_enabled: isEnable ? 1 : 0 });
// [MOVED]       await sock.sendMessage(jid, { text: `👋 Ucapan Auto-Welcome Member Baru berhasil *${isEnable ? 'DIAKTIFKAN 🟢' : 'DINONAKTIFKAN 🔴'}* di grup ini!` });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // MODERASI GRUP: Kustomisasi Pesan Auto-Welcome (.setwelcome)
// [MOVED]     if (cleanCmd === 'setwelcome') {
// [MOVED]       const welcomeMsg = args.slice(1).join(' ');
// [MOVED]       if (!welcomeMsg) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Gunakan: `.setwelcome [TEKS_UCAPAN]`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       await db.updateGroupSettings(jid, { welcome_msg: welcomeMsg, welcome_enabled: 1 });
// [MOVED]       await sock.sendMessage(jid, { text: `✅ Teks Auto-Welcome grup berhasil diperbarui!` });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // OWNER SUITE: Evaluasi Kode JavaScript Direct (.eval)
// [MOVED]     if (cleanCmd === 'eval') {
// [MOVED]       if (!isOwner) {
// [MOVED]         await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Pemilik (Owner) bot." });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       const code = args.slice(1).join(' ');
// [MOVED]       if (!code) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Gunakan: `.eval [KODE_JAVASCRIPT]`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       try {
// [MOVED]         let result = eval(code);
// [MOVED]         if (typeof result !== 'string') {
// [MOVED]           result = await import('util').then(u => u.inspect(result));
// [MOVED]         }
// [MOVED]         await sock.sendMessage(jid, { text: `💻 *EVAL RESULT:*\n\`\`\`javascript\n${result}\n\`\`\`` });
// [MOVED]       } catch (err) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ *EVAL ERROR:*\n\`\`\`\n${err.message}\n\`\`\`` });
// [MOVED]       }
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // OWNER SUITE: Eksekusi Terminal Shell Direct (.exec)
// [MOVED]     if (cleanCmd === 'exec') {
// [MOVED]       if (!isOwner) {
// [MOVED]         await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Pemilik (Owner) bot." });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       const execCmd = args.slice(1).join(' ');
// [MOVED]       if (!execCmd) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Gunakan: `.exec [PERINTAH_TERMINAL]`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       exec(execCmd, (err, stdout, stderr) => {
// [MOVED]         if (err) {
// [MOVED]           sock.sendMessage(jid, { text: `❌ *EXEC ERROR:*\n\`\`\`\n${err.message}\n\`\`\`` });
// [MOVED]           return;
// [MOVED]         }
// [MOVED]         if (stderr) {
// [MOVED]           sock.sendMessage(jid, { text: `⚠️ *EXEC STDERR:*\n\`\`\`\n${stderr}\n\`\`\`` });
// [MOVED]           return;
// [MOVED]         }
// [MOVED]         sock.sendMessage(jid, { text: `💻 *EXEC STDOUT:*\n\`\`\`\n${stdout || 'Done (no output)'}\n\`\`\`` });
// [MOVED]       });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // PERINTAH ADMIN: .flashsale <KODE_PRODUK> <HARGA_FLASH> <DURASI_JAM>
// [MOVED]     if (cleanCmd === 'flashsale') {
// [MOVED]       const pKode = args[1]?.toUpperCase();
// [MOVED]       const hFlash = parseInt(args[2]);
// [MOVED]       const dur = parseInt(args[3]) || 2;
// [MOVED] 
// [MOVED]       if (!pKode || isNaN(hFlash)) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Gunakan `.flashsale <KODE_PRODUK> <HARGA_FLASH> [DURASI_JAM]`\n\n_Contoh:_ `.flashsale NET01 15000 2`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       const p = await db.getProductByKode(pKode);
// [MOVED]       if (!p) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${pKode}* tidak ditemukan.` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       const endTime = await db.setFlashSale(pKode, hFlash, dur);
// [MOVED]       const endStr = new Date(endTime).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
// [MOVED] 
// [MOVED]       await sock.sendMessage(jid, { 
// [MOVED]         text: `⚡ *FLASH SALE BERHASIL DIAKTIFKAN!* ⚡
// [MOVED] 
// [MOVED] 📦 Produk: *${p.nama}* (\`${pKode}\`)
// [MOVED] 💰 Harga Asli: ~Rp${p.harga.toLocaleString('id-ID')}~
// [MOVED] 🔥 Harga Flash Sale: *Rp${hFlash.toLocaleString('id-ID')}*
// [MOVED] ⏱️ Berlaku Hingga: *${endStr} WIB* (${dur} Jam)` 
// [MOVED]       });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (cleanCmd === 'broadcast') {
// [MOVED]       if (!isOwner) {
// [MOVED]         await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Pemilik (Owner) bot." });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       const broadcastMsg = args.slice(1).join(' ');
// [MOVED]       if (!broadcastMsg) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.broadcast [PESAN]`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       
// [MOVED]       const delayVal = botSettings.broadcastDelay || config.defaults.broadcastDelay;
// [MOVED]       
// [MOVED]       let targetGroupJids = [];
// [MOVED]       if (botSettings.buyerGroupId) {
// [MOVED]         targetGroupJids.push(botSettings.buyerGroupId);
// [MOVED]       } else {
// [MOVED]         try {
// [MOVED]           const groups = await sock.groupFetchAllParticipating();
// [MOVED]           targetGroupJids = Object.keys(groups);
// [MOVED]         } catch (e) {
// [MOVED]           console.error("Gagal mengambil daftar grup:", e.message);
// [MOVED]         }
// [MOVED]       }
// [MOVED] 
// [MOVED]       if (targetGroupJids.length === 0) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Bot belum dikonfigurasi ID Grup atau belum bergabung di grup manapun untuk siaran broadcast." });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       await sock.sendMessage(jid, { text: `📢 Memulai broadcast ke *${targetGroupJids.length}* Grup WhatsApp...` });
// [MOVED]       
// [MOVED]       let success = 0;
// [MOVED]       for (const gJid of targetGroupJids) {
// [MOVED]         if (botState.whatsappConnected && sock) {
// [MOVED]           try {
// [MOVED]             await sock.sendMessage(gJid, { text: `📢 *PENGUMUMAN RESMI TOKO:*\n\n${broadcastMsg}` });
// [MOVED]             success++;
// [MOVED]             
// [MOVED]             const randomDelay = Math.floor(Math.random() * 2000) + delayVal;
// [MOVED]             await new Promise(resolve => setTimeout(resolve, randomDelay)); 
// [MOVED]           } catch (err) {
// [MOVED]             console.error(`Gagal kirim broadcast grup ke ${gJid}:`, err.message);
// [MOVED]           }
// [MOVED]         } else {
// [MOVED]           break;
// [MOVED]         }
// [MOVED]       }
// [MOVED]       await sock.sendMessage(jid, { text: `✅ *Broadcast selesai!*\nBerhasil dikirim ke *${success}/${targetGroupJids.length}* Grup WhatsApp.` });
// [MOVED]       await logToSystem('BROADCAST', `📢 Siaran pesan selesai dikirim ke ${success}/${targetGroupJids.length} Grup WhatsApp oleh Owner.`);
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // ==========================================
// [MOVED]     // PERINTAH MODERASI GRUP & BOT MANAGEMENT (v2)
// [MOVED]     // ==========================================
// [MOVED]     if (isGroup && ['add', 'kick', 'promote', 'demote'].includes(cleanCmd)) {
// [MOVED]       const targetJid = extractTargetJid(m, args);
// [MOVED]       if (!targetJid) {
// [MOVED]         await sock.sendMessage(jid, { text: `⚠️ Format salah. Tag user atau masukkan nomor. Contoh: \`.${cleanCmd} @user\` atau \`.${cleanCmd} 628123456789\`` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       
// [MOVED]       const botId = sock.user?.id?.split(':')[0];
// [MOVED]       if (botId && targetJid.includes(botId)) {
// [MOVED]         await sock.sendMessage(jid, { text: `⚠️ Ditolak: Saya tidak bisa melakukan ${cleanCmd} pada diri saya sendiri.` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       try {
// [MOVED]         const actionMap = { 'add': 'add', 'kick': 'remove', 'promote': 'promote', 'demote': 'demote' };
// [MOVED]         const actNameMap = { 'add': 'ditambahkan', 'kick': 'dikeluarkan', 'promote': 'diangkat jadi admin', 'demote': 'diturunkan dari admin' };
// [MOVED]         
// [MOVED]         await sock.groupParticipantsUpdate(jid, [targetJid], actionMap[cleanCmd]);
// [MOVED]         await sock.sendMessage(jid, { text: `✅ Berhasil! Pengguna @${targetJid.split('@')[0]} telah ${actNameMap[cleanCmd]}.`, mentions: [targetJid] });
// [MOVED]         await db.addLog("MODERATION", `Admin (${senderNormalized}) menjalankan ${cleanCmd} pada ${targetJid} di grup ${jid}`);
// [MOVED]       } catch (err) {
// [MOVED]         await sock.sendMessage(jid, { 
// [MOVED]           text: `❌ Gagal menjalankan ${cleanCmd}: ${err.message}.\n\n💡 *PENTING:* Pastikan **nomor WhatsApp Bot sudah dijadikan ADMIN GRUP** di WhatsApp agar fitur moderasi (${cleanCmd}) dapat mengeksekusi tindakan.` 
// [MOVED]         });
// [MOVED]       }
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (isGroup && cleanCmd === 'group') {
// [MOVED]       const option = args[1]?.toLowerCase();
// [MOVED]       if (option !== 'open' && option !== 'close') {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.group open` (semua anggota) atau `.group close` (hanya admin)." });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       try {
// [MOVED]         await sock.groupSettingUpdate(jid, option === 'open' ? 'not_announcement' : 'announcement');
// [MOVED]         await sock.sendMessage(jid, { text: option === 'open' ? "🔓 Grup telah DIBUKA! Semua anggota sekarang dapat mengirim pesan." : "🔒 Grup telah DITUTUP! Hanya Admin yang dapat mengirim pesan." });
// [MOVED]         await db.addLog("MODERATION", `Admin (${senderNormalized}) mengubah status grup ${jid} ke ${option}`);
// [MOVED]       } catch (err) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Gagal mengubah status grup: ${err.message}. Pastikan bot adalah Admin di grup.` });
// [MOVED]       }
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (isGroup && cleanCmd === 'link') {
// [MOVED]       try {
// [MOVED]         const code = await sock.groupInviteCode(jid);
// [MOVED]         await sock.sendMessage(jid, { text: `🔗 *LINK UNDANGAN GRUP*\nhttps://chat.whatsapp.com/${code}` });
// [MOVED]       } catch (err) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Gagal mengambil link grup: ${err.message}. Pastikan bot adalah Admin.` });
// [MOVED]       }
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (isGroup && (cleanCmd === 'tagall' || cleanCmd === 'hidetag' || cleanCmd === 'everyone')) {
// [MOVED]       try {
// [MOVED]         const groupMeta = await sock.groupMetadata(jid);
// [MOVED]         const participants = groupMeta.participants.map(p => p.id);
// [MOVED]         const extraMsg = args.slice(1).join(' ');
// [MOVED]         
// [MOVED]         let tagMsg = `📢 *PENGUMUMAN GRUP (${groupMeta.subject})*\n${extraMsg ? extraMsg + '\n\n' : ''}`;
// [MOVED]         participants.forEach((pId, idx) => {
// [MOVED]           tagMsg += `${idx + 1}. @${pId.split('@')[0]}\n`;
// [MOVED]         });
// [MOVED] 
// [MOVED]         await sock.sendMessage(jid, { text: tagMsg, mentions: participants });
// [MOVED]       } catch (err) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Gagal tagall: ${err.message}` });
// [MOVED]       }
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (isGroup && cleanCmd === 'admins') {
// [MOVED]       try {
// [MOVED]         const groupMeta = await sock.groupMetadata(jid);
// [MOVED]         const admins = groupMeta.participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin').map(p => p.id);
// [MOVED]         const extraMsg = args.slice(1).join(' ');
// [MOVED]         
// [MOVED]         let adminMsg = `👑 *PANGGILAN ADMIN GRUP*\n${extraMsg ? extraMsg + '\n\n' : ''}`;
// [MOVED]         admins.forEach((aId, idx) => {
// [MOVED]           adminMsg += `${idx + 1}. @${aId.split('@')[0]}\n`;
// [MOVED]         });
// [MOVED] 
// [MOVED]         await sock.sendMessage(jid, { text: adminMsg, mentions: admins });
// [MOVED]       } catch (err) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Gagal panggil admin: ${err.message}` });
// [MOVED]       }
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (cleanCmd === 'restock') {
// [MOVED]       const code = args[1]?.toUpperCase();
// [MOVED]       if (!code) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.restock [KODE_PRODUK]`\nContoh: `.restock NET01`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       const p = await db.getProductByKode(code);
// [MOVED]       if (!p) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       await sock.sendMessage(jid, { text: `⏳ Memulai pengiriman siaran restok untuk *${p.nama}* (\`${code}\`)...` });
// [MOVED]       triggerRestockBroadcast(code);
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     // ==========================================
// [MOVED]     // PERINTAH ADMIN & TRANSAKSI
// [MOVED]     // ==========================================
// [MOVED]     if (cleanCmd === 'takeover') {
// [MOVED]       const targetNumber = args[1];
// [MOVED]       if (!targetNumber) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.takeover [NOMOR]`\nContoh: `.takeover 6281234567890`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       const targetJid = targetNumber.includes('@') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
// [MOVED]       await db.updateConversationState(targetJid, 'ADMIN');
// [MOVED]       await sock.sendMessage(jid, { text: `✅ Chat dengan ${targetNumber} telah diambil alih. Bot tidak akan membalas otomatis pesannya.` });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (cleanCmd === 'release') {
// [MOVED]       const targetNumber = args[1];
// [MOVED]       if (!targetNumber) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.release [NOMOR]`\nContoh: `.release 6281234567890`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       const targetJid = targetNumber.includes('@') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
// [MOVED]       await db.updateConversationState(targetJid, 'BOT');
// [MOVED]       await sock.sendMessage(jid, { text: `✅ Chat dengan ${targetNumber} telah dikembalikan ke Bot. Bot akan membalas otomatis kembali.` });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED] // Helper universal mengekstrak Order ID baik diketik langsung maupun dari membalas/reply pesan
// [MOVED] function extractOrderIdFromMessage(args, m) {
// [MOVED]   if (args && args[1]) {
// [MOVED]     return args[1].trim().toUpperCase();
// [MOVED]   }
// [MOVED] 
// [MOVED]   const contextInfo = m?.message?.extendedTextMessage?.contextInfo || 
// [MOVED]                       m?.message?.conversation?.contextInfo ||
// [MOVED]                       m?.message?.imageMessage?.contextInfo ||
// [MOVED]                       m?.message?.videoMessage?.contextInfo;
// [MOVED] 
// [MOVED]   if (contextInfo && contextInfo.quotedMessage) {
// [MOVED]     const qMsg = contextInfo.quotedMessage;
// [MOVED]     const quotedText = 
// [MOVED]       qMsg.conversation ||
// [MOVED]       qMsg.extendedTextMessage?.text ||
// [MOVED]       qMsg.imageMessage?.caption ||
// [MOVED]       qMsg.videoMessage?.caption ||
// [MOVED]       qMsg.documentMessage?.caption ||
// [MOVED]       '';
// [MOVED] 
// [MOVED]     if (quotedText) {
// [MOVED]       const m1 = quotedText.match(/Order\s*ID\s*:\s*\*?([A-Za-z0-9_-]+)\*?/i);
// [MOVED]       if (m1 && m1[1]) return m1[1].toUpperCase();
// [MOVED] 
// [MOVED]       const m2 = quotedText.match(/\b(ORD[-_]?[A-Za-z0-9]+)\b/i);
// [MOVED]       if (m2 && m2[1]) return m2[1].toUpperCase();
// [MOVED] 
// [MOVED]       const m3 = quotedText.match(/(?:Order|ID|Pesanan|Struk)?\s*:?\s*#?([A-Za-z0-9]{3,20})\b/i);
// [MOVED]       if (m3 && m3[1]) return m3[1].toUpperCase();
// [MOVED]     }
// [MOVED]   }
// [MOVED] 
// [MOVED]   return null;
// [MOVED] }
// [MOVED] 
// [MOVED]     if (['paid', 'acc', 'terima', 'konfirmasi'].includes(cleanCmd)) {
// [MOVED]       const orderId = extractOrderIdFromMessage(args, m);
// [MOVED]       if (!orderId) {
// [MOVED]         await sock.sendMessage(jid, { 
// [MOVED]           text: "⚠️ *Gagal Deteksi Order ID:*\n\nSilakan **balas (reply)** pesan notifikasi pesanan dengan `.paid` atau `.acc`, atau ketik: `.paid <ORDER_ID>`" 
// [MOVED]         });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       const res = await db.updateOrderStatus(orderId, 'PAID');
// [MOVED]       if (!res.success) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Gagal: ${res.message}` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       await sock.sendMessage(jid, { text: `✅ Order ID *${orderId}* berhasil diubah ke status *PAID*. Memproses pengiriman otomatis...` });
// [MOVED]       
// [MOVED]       // Notifikasi awal ke customer
// [MOVED]       const notifCustomer = `🔔 *INFO PESANAN (Order: ${orderId})*
// [MOVED]       
// [MOVED] Pembayaran Anda telah *DITERIMA* dan diverifikasi oleh admin kami. Terima kasih!`;
// [MOVED]       await sock.sendMessage(res.customerNomor, { text: notifCustomer });
// [MOVED]       await logToSystem('PAYMENT', `💸 Order ID *${orderId}* dikonfirmasi PAID oleh admin (wa.me/${senderNumber.split('@')[0]})`);
// [MOVED] 
// [MOVED]       // ══════════════════════════════════════════════════════════
// [MOVED]       // AUTO-DELIVERY: Local Stock
// [MOVED]       // ══════════════════════════════════════════════════════════
// [MOVED]       try {
// [MOVED]         const deliveredData = await db.claimAndDeliverItems(orderId);
// [MOVED]         const localKeys = Object.keys(deliveredData);
// [MOVED] 
// [MOVED]         if (localKeys.length > 0) {
// [MOVED]           let credMsg = `━━━━━━━━━━━━━━━━━━\n📦 *PENGIRIMAN PRODUK DIGITAL*\n━━━━━━━━━━━━━━━━━━\nOrder ID: *${orderId}*\n\nBerikut adalah detail akun/voucher Anda:\n\n`;
// [MOVED] 
// [MOVED]           // Local stock items
// [MOVED]           for (const [kode, info] of Object.entries(deliveredData)) {
// [MOVED]             credMsg += `🔑 *${info.produk_nama}* (\`${kode}\`):\n`;
// [MOVED]             if (info.credentials.length > 0) {
// [MOVED]               info.credentials.forEach((cred, i) => { credMsg += `   ${i + 1}. ${cred}\n`; });
// [MOVED]             } else {
// [MOVED]               credMsg += `   ⚠️ Stok habis, admin akan mengirim secara manual.\n`;
// [MOVED]             }
// [MOVED]             if (info.petunjuk) credMsg += `\n${info.petunjuk}\n`;
// [MOVED]             credMsg += `\n`;
// [MOVED]           }
// [MOVED] 
// [MOVED]           credMsg += `━━━━━━━━━━━━━━━━━━\n⚠️ _Harap simpan data ini dengan baik. Jika ada masalah, silakan hubungi admin._\n━━━━━━━━━━━━━━━━━━`;
// [MOVED]           await sock.sendMessage(res.customerNomor, { text: credMsg });
// [MOVED] 
// [MOVED]           // Cek apakah semua terkirim sempurna
// [MOVED]           const localAllOk = localKeys.every(k => deliveredData[k].credentials.length > 0);
// [MOVED] 
// [MOVED]           if (localAllOk) {
// [MOVED]             await db.updateOrderStatus(orderId, 'COMPLETED');
// [MOVED]             await sock.sendMessage(res.customerNomor, { text: `✅ Pesanan *${orderId}* telah *SELESAI*. Terima kasih telah berbelanja! 🙏` });
// [MOVED]             await sock.sendMessage(jid, { text: `✅ Order *${orderId}* otomatis *COMPLETED* — semua item berhasil dikirim ke pelanggan.` });
// [MOVED]             await logToSystem('ORDER', `✅ Order *${orderId}* auto-completed (Local: ${localKeys.length}).`);
// [MOVED]           } else {
// [MOVED]             await sock.sendMessage(jid, { text: `⚠️ Order *${orderId}*: Stok habis untuk sebagian item. Silakan kirim sisa item secara manual.` });
// [MOVED]           }
// [MOVED]         } else {
// [MOVED]           // Tidak ada item AUTO — semua MANUAL
// [MOVED]           await sock.sendMessage(jid, { text: `ℹ️ Order *${orderId}* tidak memiliki item bertipe AUTO. Silakan kirimkan produk secara manual ke pelanggan, lalu ketik \`.done\` setelah selesai.` });
// [MOVED]         }
// [MOVED]       } catch (deliveryErr) {
// [MOVED]         console.error(`[AUTO_DELIVERY] Gagal mengirim kredensial untuk ${orderId}:`, deliveryErr.message);
// [MOVED]         await sock.sendMessage(jid, { text: `⚠️ Error saat auto-delivery untuk Order *${orderId}*: ${deliveryErr.message}. Silakan kirim kredensial secara manual.` });
// [MOVED]       }
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (['done', 'selesai'].includes(cleanCmd)) {
// [MOVED]       const orderId = extractOrderIdFromMessage(args, m);
// [MOVED]       if (!orderId) {
// [MOVED]         await sock.sendMessage(jid, { 
// [MOVED]           text: "⚠️ *Gagal Deteksi Order ID:*\n\nSilakan **balas (reply)** pesan notifikasi pesanan dengan `.done` atau `.selesai`, atau ketik: `.done <ORDER_ID>`" 
// [MOVED]         });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       const res = await db.updateOrderStatus(orderId, 'COMPLETED');
// [MOVED]       if (!res.success) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Gagal: ${res.message}` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       await sock.sendMessage(jid, { text: `✅ Order ID *${orderId}* ditandai *COMPLETED*. Pelanggan telah dinotifikasi.` });
// [MOVED] 
// [MOVED]       const notifCustomer = `🔔 *INFO PESANAN (Order: ${orderId})*
// [MOVED]       
// [MOVED] Pesanan Anda telah *SELESAI* diproses / dikirimkan oleh admin!
// [MOVED] Silakan cek akun/detail pesanan Anda. Jika ada kendala, hubungi admin. Terima kasih telah berbelanja! 🙏`;
// [MOVED]       await sock.sendMessage(res.customerNomor, { text: notifCustomer });
// [MOVED]       await logToSystem('ORDER', `✅ Order ID *${orderId}* ditandai COMPLETED oleh admin.`);
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (['cancel', 'batal'].includes(cleanCmd)) {
// [MOVED]       const orderId = extractOrderIdFromMessage(args, m);
// [MOVED]       if (!orderId) {
// [MOVED]         await sock.sendMessage(jid, { 
// [MOVED]           text: "⚠️ *Gagal Deteksi Order ID:*\n\nSilakan **balas (reply)** pesan notifikasi pesanan dengan `.cancel` atau `.batal`, atau ketik: `.cancel <ORDER_ID>`" 
// [MOVED]         });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       const res = await db.updateOrderStatus(orderId, 'CANCELLED');
// [MOVED]       if (!res.success) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Gagal: ${res.message}` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       await sock.sendMessage(jid, { text: `✅ Order ID *${orderId}* berhasil dibatalkan dan stok produk telah dikembalikan.` });
// [MOVED] 
// [MOVED]       const notifCustomer = `🔔 *INFO PESANAN (Order: ${orderId})*
// [MOVED]       
// [MOVED] Mohon maaf, pesanan Anda dengan Order ID *${orderId}* telah *DIBATALKAN* oleh admin. Jika Anda sudah melakukan pembayaran, silakan hubungi admin di chat ini untuk konfirmasi manual.`;
// [MOVED]       await sock.sendMessage(res.customerNomor, { text: notifCustomer });
// [MOVED]       await logToSystem('ORDER', `❌ Order ID *${orderId}* dibatalkan oleh admin.`);
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (cleanCmd === 'stock') {
// [MOVED]       const code = args[1]?.toUpperCase();
// [MOVED]       const stock = parseInt(args[2]);
// [MOVED] 
// [MOVED]       if (!code || isNaN(stock)) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.stock [KODE] [STOK_BARU]`\nContoh: `.stock NET01 15`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       const p = await db.getProductByKode(code);
// [MOVED]       if (!p) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       await db.updateProductStock(code, stock);
// [MOVED]       await sock.sendMessage(jid, { text: `📦 Stok *${p.nama}* (\`${code}\`) berhasil diperbarui menjadi *${stock}* pcs.` });
// [MOVED]       await logToSystem('SYSTEM', `📦 Stok produk *${code}* diperbarui menjadi *${stock}* oleh admin.`);
// [MOVED]       
// [MOVED]       // Picu notifikasi stok ready jika stok baru > 0
// [MOVED]       await checkAndNotifySubscribers(code, stock);
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (cleanCmd === 'price') {
// [MOVED]       const code = args[1]?.toUpperCase();
// [MOVED]       const price = parseInt(args[2]);
// [MOVED] 
// [MOVED]       if (!code || isNaN(price)) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.price [KODE] [HARGA_BARU]`\nContoh: `.price NET01 50000`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       const p = await db.getProductByKode(code);
// [MOVED]       if (!p) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       await db.updateProductPrice(code, price);
// [MOVED]       await sock.sendMessage(jid, { text: `💸 Harga *${p.nama}* (\`${code}\`) berhasil diperbarui menjadi *Rp${price.toLocaleString('id-ID')}*.` });
// [MOVED]       await logToSystem('SYSTEM', `💸 Harga produk *${code}* diperbarui menjadi Rp${price} oleh admin.`);
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (cleanCmd === 'out') {
// [MOVED]       const code = args[1]?.toUpperCase();
// [MOVED]       if (!code) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.out [KODE]`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       const p = await db.getProductByKode(code);
// [MOVED]       if (!p) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       await db.updateProductStock(code, 0);
// [MOVED]       await sock.sendMessage(jid, { text: `🔴 Produk *${p.nama}* (\`${code}\`) ditandai sebagai *Habis* (stok diset ke 0).` });
// [MOVED]       await logToSystem('SYSTEM', `🔴 Produk *${code}* diset habis oleh admin.`);
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (cleanCmd === 'ready') {
// [MOVED]       const code = args[1]?.toUpperCase();
// [MOVED]       if (!code) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.ready [KODE]`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       const p = await db.getProductByKode(code);
// [MOVED]       if (!p) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       await db.updateProductStock(code, 10);
// [MOVED]       await sock.sendMessage(jid, { text: `🟢 Produk *${p.nama}* (\`${code}\`) ditandai *Ready* kembali dengan isi stok standar (10 pcs).` });
// [MOVED]       await logToSystem('SYSTEM', `🟢 Produk *${code}* diset ready (stok 10) oleh admin.`);
// [MOVED]       
// [MOVED]       // Picu notifikasi stok ready jika stok baru > 0
// [MOVED]       await checkAndNotifySubscribers(code, 10);
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (cleanCmd === 'addproduct') {
// [MOVED]       const rawArgs = args.slice(1).join(' ');
// [MOVED]       const parts = rawArgs.split('|').map(p => p.trim());
// [MOVED]       
// [MOVED]       if (parts.length < 5) {
// [MOVED]         const errorHelp = `⚠️ Format salah. Gunakan pemisah vertikal (\`|\`):\n\`.addproduct [KODE] | [NAMA_PRODUK] | [HARGA] | [STOK] | [DESKRIPSI]\`\n\n_Contoh:_\n\`.addproduct NET02 | Netflix 2 Bulan | 85000 | 5 | Sharing 1 Profil\``;
// [MOVED]         await sock.sendMessage(jid, { text: errorHelp });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       const codePart = parts[0].split(' ');
// [MOVED]       const code = codePart[0].toUpperCase();
// [MOVED]       
// [MOVED]       const nama = parts[1];
// [MOVED]       const harga = parseInt(parts[2]);
// [MOVED]       const stok = parseInt(parts[3]);
// [MOVED]       const deskripsi = parts[4];
// [MOVED] 
// [MOVED]       if (isNaN(harga) || isNaN(stok)) {
// [MOVED]         await sock.sendMessage(jid, { text: "❌ Gagal. Harga dan Stok harus berupa angka/nominal." });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED] 
// [MOVED]       await db.addProduct(code, nama, harga, stok, deskripsi, "");
// [MOVED]       const successText = `🆕 *PRODUK BARU BERHASIL DITAMBAHKAN!*
// [MOVED]       
// [MOVED] • Kode: \`${code}\`
// [MOVED] • Nama: *${nama}*
// [MOVED] • Harga: Rp${harga.toLocaleString('id-ID')}
// [MOVED] • Stok: ${stok} pcs
// [MOVED] • Deskripsi: ${deskripsi}`;
// [MOVED]       await sock.sendMessage(jid, { text: successText });
// [MOVED]       await logToSystem('SYSTEM', `🆕 Produk baru ditambahkan oleh admin: ${code} - ${nama}`);
// [MOVED]       
// [MOVED]       // Picu notifikasi jika stok baru > 0
// [MOVED]       await checkAndNotifySubscribers(code, stok);
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (cleanCmd === 'addcoupon') {
// [MOVED]       const rawArgs = args.slice(1).join(' ');
// [MOVED]       const parts = rawArgs.split('|').map(p => p.trim());
// [MOVED]       if (parts.length < 3) {
// [MOVED]         await sock.sendMessage(jid, { text: `⚠️ Format: \`.addcoupon [KODE] | [TIPE: percent/fixed] | [NILAI] | [MIN_ORDER] | [MAX_PAKAI] | [EXPIRED: YYYY-MM-DD]\`\n\n_Contoh:_ \`.addcoupon DISKON10 | percent | 10 | 50000 | 100 | 2026-12-31\`` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       const code = parts[0].toUpperCase();
// [MOVED]       const type = parts[1].toLowerCase();
// [MOVED]       const value = parseInt(parts[2]);
// [MOVED]       const minOrder = parts[3] ? parseInt(parts[3]) : 0;
// [MOVED]       const maxUses = parts[4] ? parseInt(parts[4]) : 0;
// [MOVED]       const expiresAt = parts[5] || null;
// [MOVED]       if (type !== 'percent' && type !== 'fixed') {
// [MOVED]         await sock.sendMessage(jid, { text: "❌ Tipe kupon harus *percent* atau *fixed*." });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       if (isNaN(value)) {
// [MOVED]         await sock.sendMessage(jid, { text: "❌ Nilai kupon harus berupa angka." });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       try {
// [MOVED]         await db.addCoupon(code, type, value, minOrder, maxUses, expiresAt);
// [MOVED]         await sock.sendMessage(jid, { text: `✅ Kupon *${code}* berhasil ditambahkan!\n• Tipe: ${type}\n• Nilai: ${type === 'percent' ? value + '%' : 'Rp' + value.toLocaleString('id-ID')}\n• Min. Order: Rp${minOrder.toLocaleString('id-ID')}\n• Max Pakai: ${maxUses || 'Unlimited'}` });
// [MOVED]       } catch (err) {
// [MOVED]         await sock.sendMessage(jid, { text: `❌ Gagal: ${err.message}` });
// [MOVED]       }
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (cleanCmd === 'delcoupon') {
// [MOVED]       const code = args[1]?.toUpperCase();
// [MOVED]       if (!code) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Format: \`.delcoupon [KODE]\`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       const deleted = await db.deleteCoupon(code);
// [MOVED]       await sock.sendMessage(jid, { text: deleted ? `✅ Kupon *${code}* berhasil dihapus.` : `❌ Kupon *${code}* tidak ditemukan.` });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (cleanCmd === 'listcoupon') {
// [MOVED]       const coupons = await db.getAllCoupons();
// [MOVED]       if (coupons.length === 0) {
// [MOVED]         await sock.sendMessage(jid, { text: "🏷️ Belum ada kupon yang terdaftar." });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏷️ *DAFTAR KUPON*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
// [MOVED]       for (const c of coupons) {
// [MOVED]         const valLabel = c.type === 'percent' ? `${c.value}%` : `Rp${c.value.toLocaleString('id-ID')}`;
// [MOVED]         msg += `• *${c.code}* — ${valLabel} | Terpakai: ${c.used_count}/${c.max_uses || '∞'} | ${c.is_active ? '🟢 Aktif' : '🔴 Nonaktif'}\n`;
// [MOVED]       }
// [MOVED]       msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
// [MOVED]       await sock.sendMessage(jid, { text: msg });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (cleanCmd === 'addfaq') {
// [MOVED]       const rawArgs = args.slice(1).join(' ');
// [MOVED]       const parts = rawArgs.split('|').map(p => p.trim());
// [MOVED]       if (parts.length < 2) {
// [MOVED]         await sock.sendMessage(jid, { text: `⚠️ Format: \`.addfaq [KEYWORDS dipisah koma] | [JAWABAN]\`\n\n_Contoh:_ \`.addfaq jam buka,jam operasional | Toko kami buka 24 jam dengan layanan bot otomatis!\`` });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       const id = await db.addFaq(parts[0], parts[1]);
// [MOVED]       await sock.sendMessage(jid, { text: `✅ FAQ #${id} berhasil ditambahkan!\n• Keywords: ${parts[0]}\n• Jawaban: ${parts[1]}` });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (cleanCmd === 'delfaq') {
// [MOVED]       const id = parseInt(args[1]);
// [MOVED]       if (isNaN(id)) {
// [MOVED]         await sock.sendMessage(jid, { text: "⚠️ Format: \`.delfaq [ID]\`" });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       const deleted = await db.deleteFaq(id);
// [MOVED]       await sock.sendMessage(jid, { text: deleted ? `✅ FAQ #${id} berhasil dihapus.` : `❌ FAQ #${id} tidak ditemukan.` });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (cleanCmd === 'listfaq') {
// [MOVED]       const faqs = await db.getAllFaqs();
// [MOVED]       if (faqs.length === 0) {
// [MOVED]         await sock.sendMessage(jid, { text: "💬 Belum ada FAQ yang terdaftar." });
// [MOVED]         return true;
// [MOVED]       }
// [MOVED]       let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💬 *DAFTAR FAQ*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
// [MOVED]       for (const f of faqs) {
// [MOVED]         msg += `#${f.id} — Keywords: *${f.keywords}*\n   Jawaban: ${f.answer}\n\n`;
// [MOVED]       }
// [MOVED]       msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
// [MOVED]       await sock.sendMessage(jid, { text: msg });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED] 
// [MOVED]     if (cleanCmd === 'laporan') {
// [MOVED]       const period = args[1]?.toLowerCase() || 'harian';
// [MOVED]       const today = new Date().toISOString().split('T')[0];
// [MOVED]       const report = await db.getDailySalesReport(today);
// [MOVED]       let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *LAPORAN PENJUALAN HARI INI*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📅 ${new Date().toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n\n`;
// [MOVED]       msg += `📦 Pesanan Selesai: *${report.total_orders}*\n`;
// [MOVED]       msg += `💰 Total Omzet: *Rp${report.total_revenue.toLocaleString('id-ID')}*\n\n`;
// [MOVED]       if (report.topProducts.length > 0) {
// [MOVED]         msg += `🏆 *Produk Terlaris:*\n`;
// [MOVED]         report.topProducts.forEach((p, i) => {
// [MOVED]           msg += `${i + 1}. ${p.nama} — ${p.total_qty} terjual\n`;
// [MOVED]         });
// [MOVED]         msg += `\n`;
// [MOVED]       }
// [MOVED]       if (report.lowStockProducts.length > 0) {
// [MOVED]         msg += `🟡 *Stok Menipis:*\n`;
// [MOVED]         report.lowStockProducts.forEach(p => {
// [MOVED]           msg += `• ${p.nama} (\`${p.kode}\`) — Sisa: ${p.stok}\n`;
// [MOVED]         });
// [MOVED]         msg += `\n`;
// [MOVED]       }
// [MOVED]       if (report.outOfStockProducts.length > 0) {
// [MOVED]         msg += `🔴 *Stok Habis:*\n`;
// [MOVED]         report.outOfStockProducts.forEach(p => {
// [MOVED]           msg += `• ${p.nama} (\`${p.kode}\`)\n`;
// [MOVED]         });
// [MOVED]       }
// [MOVED]       msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
// [MOVED]       await sock.sendMessage(jid, { text: msg });
// [MOVED]       return true;
// [MOVED]     }
// [MOVED]   return false;
// [MOVED] }

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
