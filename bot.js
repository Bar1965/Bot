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
import { handlePremiumCommand, getPremiumBenefits } from './premiumHandler.js';
import { handlePdfCommands, checkPdfMergeSession } from './src/handlers/pdfHandler.js';
import { buildCommandMenu } from './commandRegistry.js';
import { createWelcomeGoodbyeCard, createLevelUpCard } from './cardGenerator.js';
import { tickPesanGrup } from './src/games/tcg/drop.js';
import { adalahJidBot } from './src/utils/botIdentity.js';
import { createMediaRouter } from './src/commands/mediaRouter.js';




// Setup Logger
const logger = P({ level: 'info' });

let sock = null;
let botSettings = {};

// Penanda @lid yang pemetaan nomornya sudah ditulis di proses ini, supaya
// metadata grup yang dibaca berulang kali tidak menghasilkan tulisan berulang.
const petaLidTercatat = new Set();
const userPushNamesMap = new Map();

// Group Metadata Cache (TTL: 5 Menit)
const groupMetaCache = new Map();
const GROUP_META_TTL = 5 * 60 * 1000;

export async function getCachedGroupMetadata(sockInstance, groupJid) {
  if (!sockInstance || !groupJid) return null;
  const cached = groupMetaCache.get(groupJid);
  if (cached && (Date.now() - cached.timestamp < GROUP_META_TTL)) {
    return cached.data;
  }
  try {
    const fetchPromise = sockInstance.groupMetadata(groupJid);
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 1500));
    const data = await Promise.race([fetchPromise, timeoutPromise]);
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
  let msg = m.message;

  // Unbox wrapper messages (ephemeral, viewOnce, viewOnceV2, documentWithCaption)
  while (
    msg?.ephemeralMessage?.message ||
    msg?.viewOnceMessage?.message ||
    msg?.viewOnceMessageV2?.message ||
    msg?.viewOnceMessageV2Extension?.message ||
    msg?.documentWithCaptionMessage?.message
  ) {
    msg = msg.ephemeralMessage?.message ||
          msg.viewOnceMessage?.message ||
          msg.viewOnceMessageV2?.message ||
          msg.viewOnceMessageV2Extension?.message ||
          msg.documentWithCaptionMessage?.message;
  }
  if (!msg) return '';

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
export async function sendInteractiveButtons(...args) {
  let targetSock = sock;
  let targetJid = null;
  let options = {};

  for (const arg of args) {
    if (!arg) continue;
    if (typeof arg === 'string' && (arg.includes('@') || arg === 'status@broadcast')) {
      targetJid = arg;
    } else if (typeof arg === 'object') {
      if (typeof arg.sendMessage === 'function' || typeof arg.relayMessage === 'function') {
        targetSock = arg;
      } else if (arg.text !== undefined || arg.title !== undefined || arg.buttons !== undefined || arg.sections !== undefined) {
        options = arg;
      }
    }
  }

  const activeSock = targetSock || sock;
  if (!activeSock || !targetJid) {
    console.warn(`[INTERACTIVE MSG DROP] JID tidak valid: "${targetJid}"`);
    return false;
  }

  const { text, title, footer, buttons = [], sections = [], mentions = [], sendFallbackText = true, listTitle = '📋 Pilih Menu' } = options;
  const jid = targetJid;

  try {
    let fullText = '';
    if (title) fullText += `*${title}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    fullText += text || '';

    if (buttons && buttons.length > 0) {
      fullText += `\n\n📌 *PILIHAN / KONTROL:*`;
      buttons.forEach(b => {
        if (b.type === 'url') {
          fullText += `\n🔗 *${b.text}:* ${b.url}`;
        } else if (b.type === 'copy') {
          fullText += `\n📋 *${b.text}:* \`${b.copy_code || b.id || b.text}\``;
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

    // Kirimkan pesan teks terformat (100% kompatibel di semua versi WhatsApp Android, iOS, & Web)
    await activeSock.sendMessage(jid, {
      text: fullText,
      mentions: Array.isArray(mentions) && mentions.length > 0 ? mentions : undefined
    });

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
  try {
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
  } catch (err) {
    console.error('[RATE_LIMITER_SWEEP] Error:', err.message);
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

  // Bot tidak pernah memoderasi dirinya sendiri. Dua jalur di bawah berakhir di
  // `groupParticipantsUpdate(..., 'remove')` atas `senderNormalized`, dan bot
  // punya hak admin — artinya satu peringatan yang salah sasaran cukup untuk
  // membuatnya keluar dari grup sendiri. Lihat `src/utils/botIdentity.js`.
  if (adalahJidBot(sock, senderNormalized)) return false;

  const groupSettings = await db.getGroupSettings(jid);
  const groupAntiLinkActive = groupSettings ? Number(groupSettings.anti_link) === 1 : false;
  const globalAntiLinkActive = (botSettings.antiLinkEnabled || "true") === "true";
  
  // Anti-link aktif HANYA jika sakelar per-grup menyala (.antilink on) dan sakelar global on
  const antiLinkOn = globalAntiLinkActive && groupAntiLinkActive;

  const antiSpamOn = botSettings.antiSpamEnabled === true || botSettings.antiSpamEnabled === "true" || botSettings.antiSpamEnabled === undefined;
  const maxSpamMsgs = parseInt(botSettings.spamThreshold) || 5;
  const spamWindowMs = parseInt(botSettings.spamWindow) || 5000;
  const kickAfter = parseInt(botSettings.kickAfterWarnings) || 3;
  const blockedDomains = (botSettings.blockedDomains || "chat.whatsapp.com,bit.ly,tinyurl,t.me,discord.gg").split(',').map(d => d.trim().toLowerCase());
  const allowedDomains = (botSettings.allowedDomains || "tokopedia.com,shopee.co.id,bukalapak.com").split(',').map(d => d.trim().toLowerCase());

  // 1. Anti-Link Scan (Admin kebal anti-link)
  if (antiLinkOn && msgText && !isAdmin) {
    // Pola lama mewajibkan `http://` atau `https://` untuk link umum, padahal WhatsApp
    // tetap membuatnya bisa diklik tanpa itu. Cukup mengetik `bit.ly/promo-grup` -
    // tanpa skema - untuk lolos dari anti-link sepenuhnya. Sekarang skemanya opsional.
    const urlRegex = /(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s]*)?/gi;
    const matches = msgText.match(urlRegex);

    // Pencocokan domain harus per-LABEL, bukan `includes()` mentah. Dengan `includes()`,
    // entri blokir `t.me` ikut cocok pada kata biasa seperti "chat.mereka" dan pada URL
    // situs yang diizinkan yang kebetulan memuat potongan itu di jalurnya - member
    // kena kick karena mengetik kalimat yang sama sekali bukan link.
    const cocokDomain = (host, dom) => {
      if (!host || !dom) return false;
      if (host === dom || host.endsWith('.' + dom)) return true;
      // Entri tanpa titik (mis. "tinyurl") dianggap satu label utuh dari host.
      if (!dom.includes('.')) return host.split('.').includes(dom);
      return false;
    };

    if (matches && matches.length > 0) {
      let isViolation = false;
      for (const urlStr of matches) {
        const lowerUrl = urlStr.toLowerCase();
        // Ambil host saja: buang skema, jalur, query, port, dan kredensial.
        const host = lowerUrl
          .replace(/^https?:\/\//, '')
          .split(/[/?#]/)[0]
          .split('@').pop()
          .split(':')[0];
        const isAllowed = allowedDomains.some(dom => cocokDomain(host, dom));
        if (!isAllowed) {
          const isBlocked = blockedDomains.some(dom => cocokDomain(host, dom)) || cocokDomain(host, 'chat.whatsapp.com');
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
    const newSettings = await db.getSettings();
    Object.assign(botSettings, newSettings);
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
  
  if (!jid || typeof jid !== 'string' || (!jid.includes('@') && jid !== 'status@broadcast')) {
    console.warn(`[MSG_SEND_DROP] Mengabaikan pengiriman ke JID tidak valid: "${jid}"`);
    return Promise.resolve(null);
  }

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

    const isReaction = Boolean(item.content && item.content.react);
    const isAudio = Boolean(item.content && (item.content.audio || item.content.ptt));
    const isHumanDelayActive = (botSettings.humanDelayEnabled || config.defaults.humanDelayEnabled || 'true') !== 'false';

    // 🛡️ ANTI-BAN & LIGHT TYPING SIMULATION (Ringan & Cepat: 100ms - 250ms)
    if (!isReaction && isHumanDelayActive && botState.whatsappConnected && sock) {
      const presenceType = isAudio ? 'recording' : 'composing';
      sock.sendPresenceUpdate(presenceType, item.jid).catch(() => {});

      // Jeda ringan & responsif (100ms - 250ms) agar cepat namun tetap natural
      const lightDelay = 100 + Math.floor(Math.random() * 150);
      await new Promise(r => setTimeout(r, lightDelay));
    }

    try {
      const sendFn = sock.rawSendMessage ? sock.rawSendMessage : sock.sendMessage.bind(sock);
      const result = await sendFn(item.jid, item.content, item.options);
      console.log(`${logPrefix} SUCCESS (MessageID: ${result?.key?.id || 'N/A'})`);
      
      // Hentikan status mengetik di background
      if (!isReaction && isHumanDelayActive && botState.whatsappConnected && sock) {
        sock.sendPresenceUpdate('paused', item.jid).catch(() => {});
      }

      outgoingMessageQueue.shift();
      botState.pendingQueueCount = outgoingMessageQueue.length;
      item.resolve(result);

      // Jeda mini antar-pesan beruntun (50ms - 100ms)
      if (outgoingMessageQueue.length > 0) {
        const interMessageDelay = 50 + Math.floor(Math.random() * 50);
        await new Promise(r => setTimeout(r, interMessageDelay));
      }
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
    // Baileys dibungkam secara bawaan supaya log bot tidak tenggelam. Kalau bot
    // tersambung tapi tidak menerima pesan sama sekali, jalankan ulang dengan
    // WA_LOG_LEVEL=warn (atau debug) agar kegagalan dekripsi ikut terlihat.
    logger: P({ level: process.env.WA_LOG_LEVEL || 'silent' }),
    browser: ['Windows', 'Chrome', '110.0.5481.177'],
    markOnlineOnConnect: true,
    syncFullHistory: false,
    // Setiap kali Baileys mengirim pesan ke grup, dia butuh daftar peserta untuk
    // enkripsi. Tanpa opsi ini dia menanyakannya ke server WhatsApp SETIAP kali
    // kirim, dan saat sesi baru dibangun ulang, rentetan query itu dibalas 403
    // `forbidden` — pengiriman gagal 3x lalu menyerah, padahal bot masih anggota
    // grupnya. groupMetaCache di atas (TTL 5 menit) sudah menyimpan data yang
    // sama persis, jadi dipakai ulang di sini. Kalau cache kosong hasilnya null
    // dan Baileys tetap jatuh ke query bawaannya seperti semula.
    cachedGroupMetadata: async (groupJid) => await getCachedGroupMetadata(sock, groupJid)
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

      // Pulihkan sesi game Undercover yang sedang berjalan jika ada restart/update
      try {
        const { restoreUndercoverSessions } = await import('./src/games/undercover.js');
        await restoreUndercoverSessions(sock);
      } catch (recErr) {
        console.warn('[UNDERCOVER] Restore error:', recErr.message);
      }

      // Pulihkan pertempuran Raid World Boss yang sedang berjalan saat restart
      try {
        const { restoreRaidSessions } = await import('./src/games/raidBoss.js');
        await restoreRaidSessions(sock);
      } catch (raidErr) {
        console.warn('[RAID] Restore error:', raidErr.message);
      }

      // Pulihkan sesi Lelang Kotak Misteri. WAJIB: poin penawar tertinggi
      // sedang ditahan (escrow), jadi sesi yang hilang = poin pemain hangus.
      try {
        const { restoreAuctionSessions } = await import('./src/games/mysteryAuction.js');
        await restoreAuctionSessions(sock);
      } catch (aucErr) {
        console.warn('[LELANG] Restore error:', aucErr.message);
      }

      // Umumkan bot online + catatan rilis. Fungsinya sendiri yang menjaga
      // agar tidak berulang: sekali per proses, dan siaran ke grup hanya
      // dikirim kalau versinya memang berubah.
      try {
        const { umumkanBotOnline } = await import('./src/utils/startupAnnounce.js');
        await umumkanBotOnline(sock);
      } catch (annErr) {
        console.warn('[STARTUP ANNOUNCE] Tidak dijalankan:', annErr.message);
      }

      // Pemulihan & Auto-Refund game jika bot sempat restart/mati mendadak
      try {
        await db.recoverAndRefundStaleGameSessions(sock);
      } catch (recErr) {
        console.warn('[CRASH_RECOVERY] Error pemulihan game:', recErr.message);
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
      // Grup yang membisukan bot (`.mode off`) juga tidak boleh kejatuhan kartu
      // sambutan / perpisahan — itu tetap "bot bersuara" di grup itu.
      if ((gSettings.bot_mode || 'all') === 'off') return;

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




  // Create Context for handlers
  const ctx = {
      sock,
      botSettings,
      userPushNamesMap,
      messageCache,
      logger,
      extractTargetJid,
      formatPhoneNumber,
      checkIsUserInGroup,
      sendQris,
      logToSystem,
      sendInteractiveButtons: (...args) => sendInteractiveButtons(...args),
      react: async (jidOrEmoji, emojiOrKey, maybeKey) => {
        let targetJid = jidOrEmoji;
        let targetEmoji = emojiOrKey;
        let targetKey = maybeKey;
        if (typeof jidOrEmoji === 'string' && !jidOrEmoji.includes('@')) {
          targetEmoji = jidOrEmoji;
          targetKey = emojiOrKey;
          targetJid = null;
        }
        if (targetJid && targetEmoji && targetKey) {
          try { await sock.sendMessage(targetJid, { react: { text: targetEmoji, key: targetKey } }); } catch (e) {}
        }
      }
  };
  const handleCustomerMessage = createCustomerHandler(ctx);
  const handleGroupMessage = createGroupAdminHandler(ctx);
  const { handleMediaCommands } = createMediaRouter(ctx);

  async function dispatchBotMessagePipeline({ sock, m, senderNormalized, jid, msgText, isGroup, isAdmin, isOwnerSender, isPrefixCmd, isTakenOver, isFromMe, isStoreAdmin }) {
    const routerArgs = msgText.trim().split(/\s+/);
    const routerRawCmd = routerArgs[0].toLowerCase();
    const routerCleanCmd = routerRawCmd.replace(/^[./#]/, '');

    // Drop kartu TCG dipicu oleh keramaian grup, bukan oleh perintah. Karena itu
    // penghitungnya harus melihat SETIAP pesan, termasuk obrolan biasa, dan
    // dipasang sebelum rantai handler yang bisa menelan pesan lebih awal.
    // Sengaja tanpa await: ini tidak boleh menambah jeda pada jalur pesan, dan
    // kegagalannya tidak boleh menjatuhkan penanganan pesan yang sesungguhnya.
    if (isGroup && !isFromMe) {
      tickPesanGrup(sock, jid).catch(() => {});
    }

    const isPdfMergeFile = await checkPdfMergeSession(sock, m, senderNormalized, jid);
    if (isPdfMergeFile) return true;

    const isPlugin = await executePlugin(routerCleanCmd, { sock, jid, senderNumber: senderNormalized, m, msgText, args: routerArgs, cleanCmd: routerCleanCmd, isAdmin, isOwner: isOwnerSender });
    if (isPlugin) return true;

    const isPdfCmd = await handlePdfCommands(sock, m, senderNormalized, jid, routerCleanCmd, routerArgs, isGroup, null, isPrefixCmd, isAdmin, isOwnerSender);
    if (isPdfCmd) return true;

    const isPrem = await handlePremiumCommand({ sock, jid, senderNumber: senderNormalized, messageObj: m, args: routerArgs, cleanCmd: routerCleanCmd, isAdmin, isOwner: isOwnerSender, isStoreAdmin });
    if (isPrem) return true;

    const isFun = await handleFunCommand({ sock, jid, senderNumber: senderNormalized, messageObj: m, text: msgText, args: routerArgs, cleanCmd: routerCleanCmd, isFromGroup: isGroup, isAdmin, isOwner: isOwnerSender, isStoreAdmin });
    if (isFun) return true;

    const walletJid = (isFromMe && !isGroup && sock.user?.id) ? jidNormalizedUser(sock.user.id) : senderNormalized;
    const isMedia = await handleMediaCommands(jid, walletJid, m, msgText, isAdmin, isOwnerSender, isStoreAdmin);
    if (isMedia) return true;

    const isHandledAdmin = await handleGroupMessage(jid, senderNormalized, m, msgText, isAdmin, isPrefixCmd, { isAdmin, isOwner: isOwnerSender, isStoreAdmin });
    if (isHandledAdmin) return true;

    if (!isGroup && isTakenOver) {
      console.log(`[BOT] Percakapan dengan ${senderNormalized} sedang diambil alih admin. Auto-reply dinonaktifkan.`);
      return true;
    }

    await handleCustomerMessage(jid, senderNormalized, m, msgText, isGroup, { isAdmin, isOwner: isOwnerSender, isStoreAdmin });
    return true;
  }
            
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

        // Pesan grup WAJIB punya participant. Kalau kosong (pesan sistem/protokol),
        // jangan jatuh ke JID grup sebagai pengirim: grupnya akan terdaftar jadi
        // pelanggan, dapat XP, dan tercatat sebagai peserta dirinya sendiri di
        // group_chat_stats. Pesan seperti ini tidak pernah berisi perintah pengguna,
        // jadi aman dilewati. Anti-delete sudah diproses di atas.
        const rawParticipant = String(m.key.participant || '').trim();
        if (isGroup && (!rawParticipant || rawParticipant.endsWith('@g.us'))) {
          console.log(`[SKIP_NO_PARTICIPANT] Pesan grup tanpa pengirim jelas di ${jid}, dilewati.`);
          continue;
        }

        const sender = rawParticipant || jid;
        let senderNormalized = jidNormalizedUser(sender);
        const isFromMe = !!m.key.fromMe;
        const msgText = extractMessageText(m).trim();
        const isPrefixCmd = msgText.startsWith('.') || msgText.startsWith('/') || msgText.startsWith('#');

        if (isGroup && !isFromMe) {
          db.incrementGroupChatStats(jid, senderNormalized).catch(() => {});
        }

        if (m.pushName && senderNormalized) {
          userPushNamesMap.set(senderNormalized, m.pushName);
        }

        // Jika pesan dikirim dari akun bot sendiri (fromMe) tapi BUKAN perintah awalan bot, abaikan
        if (isFromMe && !isPrefixCmd) continue;

        // ====================================================================
        // DETEKSI OWNER & ADMIN — Sistem LID-Aware
        // Masalah: WhatsApp kini kirim pesan dari grup sebagai @lid (bukan nomor HP)
        // Solusi: cek fromMe + ownerJid yang tersimpan + mapping metadata grup + database role
        // ====================================================================
        let senderCleanJid = jidNormalizedUser(senderNormalized);
        const extractDigits = (s) => s ? String(s).replace(/[^0-9]/g, '') : '';
        const senderDigits = extractDigits(senderCleanJid);
        const ownerPhoneDigits = extractDigits(botSettings.ownerNumber || config.defaults.ownerNumber || '');
        const storedOwnerJid = jidNormalizedUser((botSettings.ownerJid || '').trim());
        const adminEntries = (botSettings.adminNumbers || config.defaults.adminNumbers || "").split(',').map(n => extractDigits(n)).filter(d => d.length > 6);

        // Cek apakah sender adalah Owner (by fromMe, stored JID exact match, atau phone digit match)
        let isOwnerSender = false;
        if (isFromMe) {
          isOwnerSender = true; // Pesan dari nomor bot/owner sendiri — 100% Owner
        } else if (storedOwnerJid && (senderCleanJid === storedOwnerJid || senderCleanJid.includes(storedOwnerJid.split('@')[0]) || storedOwnerJid.includes(senderCleanJid.split('@')[0]))) {
          isOwnerSender = true; // Exact JID match (handles @lid yang disimpan via .setownerid)
        } else if (ownerPhoneDigits && senderDigits && senderDigits.length > 6 && db.isPhoneMatch(senderCleanJid, ownerPhoneDigits)) {
          isOwnerSender = true; // Phone number match dengan toleransi kode negara (works in DM)
        }

        let isGroupAdmin = false;
        let isStoreAdmin = adminEntries.some(adm => senderDigits.length > 6 && (senderDigits === adm || senderDigits.endsWith(adm) || adm.endsWith(senderDigits)));

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
                // Baileys 6.7.x: di grup ber-LID, pMatch.id BERISI @lid dan nomor HP-nya ada di
                // pMatch.jid. Membaca .id saja membuat pencocokan owner/admin tidak pernah berhasil.
                const pPhone = extractDigits(pMatch.id);
                const pPhoneReal = extractDigits(pMatch.jid || '');
                const pPhones = [pPhone, pPhoneReal].filter(d => d && d.length > 6);

                // Rekam pasangan @lid <-> nomor HP selagi metadata grup memuat keduanya.
                // Inilah satu-satunya tempat kedua identitas itu pernah terlihat bersamaan;
                // tanpa dicatat, `.ban 628xxx` dan `.setpremium 628xxx` tidak punya cara
                // menemukan 191 pelanggan yang tersimpan sebagai @lid. Sengaja tanpa await
                // dan hanya sekali per @lid per proses, supaya tidak menambah beban tulis
                // pada jalur pesan.
                const lidTerlihat = pMatch.lid ? jidNormalizedUser(pMatch.lid) : (pMatch.id?.endsWith('@lid') ? jidNormalizedUser(pMatch.id) : null);
                if (lidTerlihat && pPhoneReal && pPhoneReal.length > 6 && !petaLidTercatat.has(lidTerlihat)) {
                  petaLidTercatat.add(lidTerlihat);
                  db.catatPetaLid(lidTerlihat, pPhoneReal).catch(() => {});
                }
                // Resolusi Owner jika pengirim memakai LID di grup
                if (ownerPhoneDigits && pPhones.some(d => d === ownerPhoneDigits || d.endsWith(ownerPhoneDigits) || ownerPhoneDigits.endsWith(d))) {
                  isOwnerSender = true;
                  if (pMatch.lid && (!botSettings.ownerJid || botSettings.ownerJid !== jidNormalizedUser(pMatch.lid))) {
                    botSettings.ownerJid = jidNormalizedUser(pMatch.lid);
                    db.updateSettings({ ownerJid: botSettings.ownerJid }).catch(() => {});
                  }
                }
                // Resolusi Admin Toko jika pengirim memakai LID di grup
                if (pPhones.some(d => adminEntries.some(adm => d === adm || d.endsWith(adm) || adm.endsWith(d)))) {
                  isStoreAdmin = true;
                }
              }
            }
          } catch (e) {
            // Silent fail jika tidak bisa ambil metadata grup
          }
        }

        // Database Role Fallback: jika role di DB adalah OWNER atau ADMIN.
        //
        // MODERATOR sengaja TIDAK ikut menaikkan isStoreAdmin. `.addmod` menjanjikan
        // "dia sekarang bisa menggunakan .ban dan .unban", tapi dulu baris di bawah
        // menyamakan moderator dengan Admin Toko - artinya satu `.addmod` diam-diam
        // memberi akses ke `.paid` (kirim lisensi Rp150.000 gratis, termasuk ke order
        // dirinya sendiri), `.price`, `.stock`, `.broadcast` ke seluruh pelanggan, dan
        // `.eval` yang menjalankan kode apa pun di komputer ini.
        //
        // Kewenangan ban moderator tidak lewat sini: groupAdminHandler memanggil
        // db.isModerator() sendiri di jalur `.ban`/`.unban`.
        if (!isOwnerSender || !isStoreAdmin) {
          try {
            const dbCustomer = await db.getQuery("SELECT role FROM customers WHERE nomor = ? OR nomor = ?", [senderCleanJid, senderNormalized]);
            if (dbCustomer?.role === 'OWNER') {
              isOwnerSender = true;
            } else if (dbCustomer?.role === 'ADMIN') {
              isStoreAdmin = true;
            }
          } catch (e) {}
        }

        // Owner dan Admin Toko SELALU memiliki akses Admin penuh di SEMUA grup (walaupun bukan admin di grup WA tersebut)
        let isAdmin = isOwnerSender || isGroupAdmin || isStoreAdmin;

        // Cek apakah user sedang di-banned (Owner/Admin tidak pernah kena ban)
        if (!isAdmin) {
          const isBanned = await db.isUserBanned(senderNormalized);
          if (isBanned) continue;
        }

        // ====================================================================
        // MODE OFF (`.mode off`) — BOT DIBISUKAN DI GRUP INI
        // --------------------------------------------------------------------
        // Nilai bot_mode = 'off' sudah lama bisa disimpan lewat `.mode off`,
        // tapi tidak pernah dibaca satu handler pun, jadi perintah itu praktis
        // tidak berefek. Gerbang ini sengaja dipasang PALING AWAL — sebelum
        // notifikasi AFK, kartu naik level, anti-link, auto-downloader, dan
        // seluruh rantai handler — supaya "mute" benar-benar berarti diam.
        // Satu-satunya jalan keluar: `.mode` dari Admin/Owner, agar bot masih
        // bisa dinyalakan kembali dari dalam grup itu sendiri.
        // ====================================================================
        if (isGroup) {
          let modeGrupIni = 'all';
          try {
            const gSetMute = await db.getGroupSettings(jid);
            modeGrupIni = gSetMute.bot_mode || 'all';
          } catch (_) { modeGrupIni = 'all'; }

          if (modeGrupIni === 'off') {
            const cmdMute = msgText.trim().split(/\s+/)[0].toLowerCase().replace(/^[./#]/, '');
            const bolehLolosSaatMute = isPrefixCmd
              && ['mode', 'setmode', 'botmode'].includes(cmdMute)
              && isAdmin;
            if (!bolehLolosSaatMute) {
              // XP tetap dikumpulkan diam-diam: yang dimatikan adalah suara bot,
              // bukan progres level member yang terlanjur aktif di grup itu.
              if (senderNormalized && !isFromMe) db.addMessageXp(senderNormalized, 10).catch(() => {});
              continue;
            }
          }
        }

        const mainBuyerGroupJid = botSettings.buyerGroupId || "";

        // ====================================================================
        // PROTEKSI WAJIB REGISTRASI MEMBER (.daftar <nama>) & ANTI-SPAM
        // ====================================================================
        const argsCheck = msgText.trim().split(/\s+/);
        const rawCmdCheck = argsCheck[0].toLowerCase();
        const cleanCmdCheck = rawCmdCheck.replace(/^[./#]/, '');
        const knownCmdList = [
          'daftar', 'register', 'registrasi', 'owner', 'kontakowner', 'menu', 'help', 'bantuan', 
          'produk', 'list', 'katalog', 'listproduk', 'p', 'detail', 'info', 'lihat', 'beli', 'checkout', 'keranjang', 'cart', 'status', 'riwayat', 'batal', 'cancel',
          'freegames', 'freegame', 'gamegratis', 'slot', 'slots', 'stiker', 'sticker', 's', 'gif',
          'tt', 'tiktok', 'ig', 'instagram', 'yt', 'youtube', 'fb', 'facebook', 'quiz', 'trivia',
          'tebakemoji', 'tebakkata', 'tebakgambar', 'zodiak', 'jodoh', 'khodam', 'truth', 'dare',
          'torebot', 'tochipmunk', 'todeep', 'toecho', 'ping', 'statusbot', 'daily', 'poin', 'rank',
          'song', 'play', 'tomp3', 'tovn', 'tr', 'translate', 'jadwalsholat', 'sholat', 'menfess', 'confess',
          'hd', 'remini', 'upscale', 'afk', 'ww', 'werewolf', 'pay', 'qris', 'pembayaran',
          'rampok', 'rob', 'steal', 'maling', 'copet', 'hack', 'bank', 'deposito', 'tarik', 'withdraw', 'transfer', 'susunkata', 'tebakangka', 'roulette',
          'premium', 'upgradepremium', 'cekpremium', 'ai', 'gemini', 'tanyaai', 'lapak', 'jual', 'claimvoucher', 'wishlist',
          // Perintah owner / admin

          'addpoint', 'addpoints', 'tambahpoin', 'setpoin', 'resetpoin', 'resetleaderboard', 'kurangpoin', 'kurangipoin', 'delpoint', 'delpoints', 'deductpoint', 'potongpoin', 'kirimpoin', 'transferpoin',
          'giveaway', 'setpoints', 'bagipoin', 'kompensasi', 'antidelete',
          'paid', 'done', 'broadcast', 'addcoupon', 'delcoupon', 'listcoupon',
          'addfaq', 'delfaq', 'listfaq', 'laporan', 'restock', 'stock', 'price',
          'out', 'ready', 'addproduct', 'takeover', 'release', 'stats', 'flashsale',
          'setname', 'setowner', 'setownerid', 'addmod', 'delmod', 'listmod',
          'ban', 'unban', 'unwarn', 'cekwarn', 'kick', 'add', 'promote', 'demote', 'tagall', 'hidetag',
          'everyone', 'all', 'semua', 'admins', 'mode', 'setmode', 'botmode', 'antilink',
          'welcome', 'setwelcome', 'link', 'getjid', 'backup', 'eval', 'join', 'levelup', 'autolevelup', 'globallevelup', 'setlevelup', 'autodl', 'autodownload', 'listfitur', 'fiturgrup', 'groupfeatures', 'tebaklagu', 'tebakbendera', 'tebaknegara', 'bendera', 'negara', 'flag', 'balasmenfess', 'menfessreply', 'stopmenfess', 'closemenfess'
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


        // Award XP & Check Level Up (Grup Only - Async non-blocking)
        if (isGroup && senderNormalized) {
          (async () => {
            try {
              const globalLevelUp = (botSettings.levelUpEnabled || "true") !== "false";
              const groupSettings = await db.getGroupSettings(jid);
              const isGroupLevelUpEnabled = globalLevelUp
                && (groupSettings.levelup_enabled !== 0)
                && (groupSettings.bot_mode || 'all') !== 'off';

              const xpResult = await db.addMessageXp(senderNormalized, 10);
              if (xpResult.leveledUp && isGroupLevelUpEnabled) {
                const userTag = `@${senderNormalized.split('@')[0]}`;
                const captionText = `🎉 *SELAMAT ${userTag}!* Kamu telah naik ke *Level ${xpResult.newLevel}*!\n🏆 *Rank:* ${xpResult.titleBadge}\n✨ *Total XP:* ${(xpResult.xp || 0).toLocaleString('id-ID')} XP`;

                let userAvatar = null;
                try {
                  const pfpPromise = sock.profilePictureUrl(senderNormalized, 'image');
                  const pfpTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 1000));
                  userAvatar = await Promise.race([pfpPromise, pfpTimeout]);
                } catch (e) {}

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
              }
            } catch (e) {}
          })().catch(() => {});
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
          // Dulu hanya 'sales' yang dikecualikan, sehingga grup ber-`.mode off`
          // tetap kejatuhan hasil unduhan otomatis. Sekarang auto-DL hanya
          // hidup di mode 'all'.
          if (gSettings.auto_dl_enabled !== 0 && (gSettings.bot_mode || 'all') === 'all') {
            const tiktokRegex = /https?:\/\/(?:www\.|vt\.|vm\.|v\.)?tiktok\.com\/[^\s]+/i;
            const igRegex = /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv|stories)\/[^\s]+/i;
            
            const tiktokMatch = msgText.match(tiktokRegex);
            const igMatch = msgText.match(igRegex);

            // Auto-DL adalah jalur PALING longgar di seluruh bot: terpicu oleh
            // tautan siapa pun tanpa perintah, tanpa cek registrasi, tanpa jeda,
            // dan sampai 10 berkas per tautan. Satu orang menempel dua puluh
            // tautan di grup 116 anggota berarti dua ratus kiriman media dari
            // kuota internet komputer ini, tanpa satu pun rem.
            //
            // Sekarang jalur ini memakai penjaga yang sama dengan perintah biasa,
            // ditambah jeda per GRUP supaya tempel-banyak-tautan tidak menjadi
            // longsoran walau tiap tautan datang dari orang yang berbeda.
            if (tiktokMatch || igMatch) {
              const belumDaftar = !isAdmin && !isOwnerSender && !(await db.isCustomerRegistered(senderNormalized));
              if (belumDaftar) continue;

              const jedaGrup = await db.getCooldownMs(jid, 'AUTODL');
              if (jedaGrup > 0) continue; // diam saja - memberi tahu tiap tautan justru jadi spam sendiri

              if (!isOwnerSender && !isStoreAdmin) {
                const tier = await db.getPremiumTier(senderNormalized);
                const benefit = getPremiumBenefits(tier);
                const batas = Number(benefit.mediaDailyLimit) || 15;
                const dipakai = await db.getMediaUsageToday(senderNormalized);
                if (dipakai >= batas) {
                  await sock.sendMessage(jid, {
                    text: `⚠️ @${senderNormalized.split('@')[0]} kuota unduhan harianmu sudah habis (${dipakai}/${batas}). Auto-download dilewati.

_Kuota berganti tengah malam WIB. Ketik *.premium* untuk jatah lebih besar._`,
                    mentions: [senderNormalized]
                  });
                  continue;
                }
                await db.incrementMediaUsage(senderNormalized);
              }
              await db.setCooldown(jid, 'AUTODL', 30 * 1000);
            }

            if (tiktokMatch) {
              const url = tiktokMatch[0];
              try {
                await sock.sendMessage(jid, { react: { text: '⏳', key: m.key } });
                const res = await mediaHandler.downloadTikTok(url);
                if (res && res.success) {
                  const mediaList = (Array.isArray(res.media) && res.media.length > 0) ? res.media : [
                    { type: res.type || (res.videoUrl ? 'video' : 'image'), buffer: res.buffer, url: res.videoUrl || res.imageUrl }
                  ];
                  const items = mediaList.slice(0, 10);
                  for (let i = 0; i < items.length; i++) {
                    const it = items[i];
                    const countInfo = items.length > 1 ? ` [${i + 1}/${items.length}]` : '';
                    const caption = i === 0 ? `✨ *AUTO-DOWNLOAD TIKTOK* ⚡\n\n📌 *Judul:* ${res.title || 'TikTok Media'}${res.author ? `\n👤 *Creator:* ${res.author}` : ''}\n✅ *Diproses via Akbar Store Bot*${countInfo}` : `📸 *TikTok Media*${countInfo}`;
                    const siap = await mediaHandler.siapkanMediaWA(it);
                    if (!siap?.ok) continue;
                    if (siap.kategori === 'image') {
                      await sock.sendMessage(jid, { image: siap.buffer, mimetype: siap.mimetype, caption }, { quoted: i === 0 ? m : undefined });
                    } else if (siap.kategori === 'audio') {
                      await sock.sendMessage(jid, { audio: siap.buffer, mimetype: siap.mimetype }, { quoted: i === 0 ? m : undefined });
                    } else {
                      await sock.sendMessage(jid, { video: siap.buffer, mimetype: 'video/mp4', gifPlayback: siap.gifPlayback || undefined, caption }, { quoted: i === 0 ? m : undefined });
                    }
                  }
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
                if (res && res.success) {
                  const mediaList = (Array.isArray(res.media) && res.media.length > 0) ? res.media : [
                    { type: res.type || (res.videoUrl ? 'video' : 'image'), buffer: res.buffer, url: res.videoUrl || res.imageUrl }
                  ];
                  const items = mediaList.slice(0, 10);
                  for (let i = 0; i < items.length; i++) {
                    const it = items[i];
                    const countInfo = items.length > 1 ? ` [${i + 1}/${items.length}]` : '';
                    const caption = i === 0 ? `✨ *AUTO-DOWNLOAD INSTAGRAM* ⚡\n\n📌 *Judul:* ${res.title || 'Instagram Media'}\n✅ *Diproses via Akbar Store Bot*${countInfo}` : `📸 *Instagram Media*${countInfo}`;
                    const siap = await mediaHandler.siapkanMediaWA(it);
                    if (!siap?.ok) continue;
                    if (siap.kategori === 'image') {
                      await sock.sendMessage(jid, { image: siap.buffer, mimetype: siap.mimetype, caption }, { quoted: i === 0 ? m : undefined });
                    } else if (siap.kategori === 'audio') {
                      await sock.sendMessage(jid, { audio: siap.buffer, mimetype: siap.mimetype }, { quoted: i === 0 ? m : undefined });
                    } else {
                      await sock.sendMessage(jid, { video: siap.buffer, mimetype: 'video/mp4', gifPlayback: siap.gifPlayback || undefined, caption }, { quoted: i === 0 ? m : undefined });
                    }
                  }
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
        // Di grup ber-LID, `contextInfo.participant` untuk pesan bot berisi @lid,
        // bukan nomor HP — perbandingan lama selalu bernilai false di sana.
        const isReplyToBot = adalahJidBot(sock, m.message?.extendedTextMessage?.contextInfo?.participant);

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
            if (!await db.isCustomerRegistered(senderNormalized) && !isAdmin && !isOwnerSender) {
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
            await sock.sendMessage(jid, { text: `🏳️ Permainan dihentikan!\n\nAngka yang benar adalah: *${game.target}*\nTotal Pot Tersimpan: *${game.pot || 200} Poin*` });
            continue;
          } else {
            const guess = parseInt(msgText.trim(), 10);
            if (!isNaN(guess) && guess >= 1 && guess <= 100) {
              const profile = await db.getGameProfile(senderNormalized);
              const currentPoints = profile?.points || 0;
              if (currentPoints < 10 && !isAdmin && !isOwnerSender) {
                await sock.sendMessage(jid, { text: `⚠️ Maaf @${senderNormalized.split('@')[0]}, kamu membutuhkan minimal *10 poin* untuk menebak di game Tebak Angka Pot Progresif (Poin kamu: *${currentPoints} poin*).`, mentions: [senderNormalized] }, { quoted: m });
                continue;
              }

              const deductRes = await db.deductGamePoints(senderNormalized, 10);
              if (!deductRes.success && !isAdmin && !isOwnerSender) {
                await sock.sendMessage(jid, { text: `❌ Poin kamu tidak cukup! Kamu membutuhkan minimal *10 poin* untuk menebak.`, mentions: [senderNormalized] }, { quoted: m });
                continue;
              }

              game.pot = (game.pot || 200) + 10;
              game.guesses = (game.guesses || 0) + 1;

              if (guess === game.target) {
                game.isAnswered = true;
                if (game.timeout) clearTimeout(game.timeout);
                ent.activeGames.delete(jid + '_angka');
                const winPot = game.pot;
                const winnerProfile = await db.addGamePoints(senderNormalized, winPot);
                const finalPoints = winnerProfile?.points || 0;
                await sock.sendMessage(jid, {
                  text: `🎉 *JACKPOT!!! TEBAKAN BENAR!* 🎉\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n👤 Pemenang: *@${senderNormalized.split('@')[0]}* (${m.pushName || 'Pelanggan'})\n🔢 Angka Rahasia: *${game.target}*\n💰 Hadiah Jackpot: *+${winPot} Poin*\n📉 Total Tebakan Grup: *${game.guesses} kali*\n🏆 Total Poin Kamu: *${finalPoints} Poin*`,
                  mentions: [senderNormalized]
                });
                await sock.sendMessage(jid, { react: { text: '🎉', key: m.key } });
                continue;
              } else {
                const diff = guess < game.target ? 'terlalu KECIL 📉' : 'terlalu BESAR 📈';
                await sock.sendMessage(jid, {
                  text: `❌ Tebakan *@${senderNormalized.split('@')[0]}* (*${guess}*) *${diff}*!\n\n💰 Pot Jackpot bertambah menjadi: *${game.pot} Poin*`,
                  mentions: [senderNormalized]
                });
                continue;
              }
            } else if (isReplyToBot && msgText.trim().length > 0) {
              await sock.sendMessage(jid, { text: `❌ Itu bukan angka yang valid (1-100)!` }, { quoted: m });
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
            if (!await db.isCustomerRegistered(senderNormalized) && !isAdmin && !isOwnerSender) {
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

          // Memproses Perintah Bot DM (Plugins, Media/Downloader, Admin/Group, Customer)
          await dispatchBotMessagePipeline({
            sock,
            m,
            senderNormalized,
            jid,
            msgText,
            isGroup: false,
            isAdmin,
            isOwnerSender,
            isPrefixCmd,
            isTakenOver,
            isFromMe,
            isStoreAdmin
          });
        } else {
          // Memproses Perintah Bot Group (Plugins, Media/Downloader, Admin/Group, Customer)
          await dispatchBotMessagePipeline({
            sock,
            m,
            senderNormalized,
            jid,
            msgText,
            isGroup: true,
            isAdmin,
            isOwnerSender,
            isPrefixCmd,
            isTakenOver: false,
            isFromMe,
            isStoreAdmin
          });
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
          let berhasilKeluar = false;
          // Kirim pesan pamit dulu, tapi kegagalannya TIDAK boleh menghalangi groupLeave.
          // Dulu sendMessage & groupLeave ada dalam satu try-catch: kalau sendMessage
          // throw (3 retry habis karena grup tidak bisa dikirim pesan), groupLeave
          // tidak pernah dipanggil sama sekali.
          try {
            await sock.sendMessage(rent.group_jid, { text: `Waktu sewa bot di grup ini telah habis. Hubungi owner untuk memperpanjang.\n\nBye! 👋` });
            await new Promise(r => setTimeout(r, 2000));
          } catch (eSend) {
            console.warn(`[GROUP RENTAL] Gagal kirim pesan pamit ke ${rent.group_jid} (diabaikan, tetap keluar):`, eSend.message);
          }
          try {
            await sock.groupLeave(rent.group_jid);
            berhasilKeluar = true;
          } catch (eLeave) {
            console.error(`[GROUP RENTAL] Gagal leave grup ${rent.group_jid}:`, eLeave.message);
          }

          // Baris sewa HANYA dihapus kalau bot benar-benar sudah keluar. Dulu
          // removeGroupRental dipanggil di luar try/catch, jadi satu kegagalan
          // groupLeave (koneksi putus, WhatsApp menolak, grup sedang dibekukan)
          // menghapus catatan sewanya sementara bot tetap di dalam grup - grup itu
          // lalu dilayani gratis selamanya, dan tidak ada satu pun catatan tersisa
          // yang bisa memberi tahu bahwa sewanya sudah habis.
          if (berhasilKeluar) {
            await db.removeGroupRental(rent.group_jid);
          } else {
            // Baris sewa dibiarkan supaya siklus berikutnya (1 jam lagi) mencoba lagi.
            await db.addLog('SYSTEM', `⚠️ Sewa grup ${rent.group_jid} sudah habis tapi bot GAGAL keluar. Baris sewa dipertahankan, akan dicoba lagi 1 jam lagi.`).catch(() => {});
            try {
              const ownerNotif = botSettings.ownerJid || botSettings.ownerNumber;
              if (ownerNotif) {
                await sock.sendMessage(ownerNotif, { text: `⚠️ *SEWA GRUP HABIS TAPI GAGAL KELUAR*\n\nGrup: \`${rent.group_jid}\`\n\nBot masih berada di dalam grup itu. Percobaan otomatis diulang tiap 1 jam. Kalau terus gagal, keluarkan bot secara manual dari grupnya.` });
              }
            } catch (_) {}
          }
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
