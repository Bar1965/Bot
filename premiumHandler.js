import * as db from './database.js';
import { sendInteractiveButtons } from './bot.js';

const aiContextMap = new Map();

// Bersihkan konteks AI yang tidak aktif lebih dari 30 menit setiap 10 menit
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of aiContextMap.entries()) {
    if (val && val.lastActive && (now - val.lastActive > 30 * 60 * 1000)) {
      aiContextMap.delete(key);
    }
  }
}, 10 * 60 * 1000).unref?.();

// ============================================================
// KONFIGURASI TIER PREMIUM
// ============================================================
export const PREMIUM_TIERS = {
  Silver: {
    tier: 'Silver', emoji: '🥈',
    pricePoin: 300,
    days: 30,
    benefits: {
      aiDailyLimit: 10,
        dailyRewardMult: 1.5,
        rpgGoldMult: 1.5,
        rpgXpMult: 1.5,
        healCooldownMult: 0.8,
      shopDiscountPct: 5,
      resellerAccess: true,
      restockDmAlert: false,
      monthlyVoucherRp: 0,
      xpMult: 2.0,
      badge: '🥈 Silver Member'
    },
    description: '10x AI/hari, diskon 5%, Akses Lapak Reseller, 2x XP Booster.'
  },
  Gold: {
    tier: 'Gold', emoji: '🥇',
    pricePoin: 800,
    days: 30,
    benefits: {
      aiDailyLimit: 25,
        dailyRewardMult: 2.0,
        rpgGoldMult: 2.0,
        rpgXpMult: 2.0,
        healCooldownMult: 0.5,
      shopDiscountPct: 10,
      resellerAccess: true,
      restockDmAlert: true,
      monthlyVoucherRp: 0,
      xpMult: 3.0,
      badge: '🥇 Gold Member'
    },
    description: '25x AI/hari, diskon 10%, Lapak Reseller + DM Restock Alert, 3x XP Booster.'
  },
  Diamond: {
    tier: 'Diamond', emoji: '💎',
    pricePoin: 2000,
    days: 30,
    benefits: {
      aiDailyLimit: 50,
        dailyRewardMult: 3.0,
        rpgGoldMult: 3.0,
        rpgXpMult: 3.0,
        healCooldownMult: 0.2,
      shopDiscountPct: 15,
      resellerAccess: true,
      restockDmAlert: true,
      monthlyVoucherRp: 10000,
      xpMult: 5.0,
      badge: '💎 Diamond Member'
    },
    description: '50x AI/hari, diskon 15%, Lapak Reseller, DM Restock Alert, Voucher Rp10k/bln, 5x XP Booster.'
  }
};

export function getPremiumBenefits(tier) {
  return PREMIUM_TIERS[tier]?.benefits || {
    aiDailyLimit: 3,
      dailyRewardMult: 1.0,
      rpgGoldMult: 1.0,
      rpgXpMult: 1.0,
      healCooldownMult: 1.0,
    shopDiscountPct: 0,
    resellerAccess: false,
    restockDmAlert: false,
    monthlyVoucherRp: 0,
    xpMult: 1.0,
    badge: '🎮 Member'
  };
}


// ============================================================
// HELPER
// ============================================================
function formatExpiry(expiresAt) {
  if (!expiresAt) return '-';
  const d = new Date(expiresAt);
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function daysLeft(expiresAt) {
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((new Date(expiresAt) - Date.now()) / (1000 * 60 * 60 * 24)));
}

// ============================================================
// COMMAND HANDLER
// ============================================================
export async function handlePremiumCommand({ sock, jid, senderNumber, messageObj, args, cleanCmd, isAdmin, isOwner, isStoreAdmin = false, isPrefixCmd }) {
  const isPrefix = isPrefixCmd !== undefined 
    ? isPrefixCmd 
    : (args?.[0]?.startsWith('.') || args?.[0]?.startsWith('/') || args?.[0]?.startsWith('#'));
  if (!isPrefix) return false;

  const cmd = String(cleanCmd || '').toLowerCase();

  const knownPremCmds = [
    'ocr', 'ai', 'gemini', 'tanyaai', 'askai', 'resetai',
    'lapak', 'jual', 'claimvoucher', 'klaimvoucher', 'vouchergobay',
    'wishlist', 'ingatkan', 'premium', 'upgradepremium', 'buypremium',
    'cekpremium', 'checkpremium', 'statuspremium', 'myplan',
    'premiumbenefit', 'benefits', 'keuntunganpremium',
    'setpremium', 'revokepremium', 'listpremium'
  ];
  if (!knownPremCmds.includes(cmd)) return false;

  // REGISTRATION CHECK
  const isReg = await db.isCustomerRegistered(senderNumber);
  if (!isReg && !isAdmin && !isOwner) {
    const senderMention = senderNumber.split('@')[0];
    const regNotice = `⚠️ *AKSES DITOLAK — REGISTRASI DIPERLUKAN* ⚠️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nHalo @${senderMention}! Anda harus terdaftar sebagai member terlebih dahulu untuk menggunakan fitur AI & Premium (100% Gratis & Cepat).\n\n📌 *Cara Pendaftaran (Hanya 5 Detik):*\nKetik: \`.daftar Nama Kamu\`\n\n_Contoh:_ \`.daftar Budi Santoso\`\n\nSetelah terdaftar, Anda dapat langsung menikmati semua fitur bot! 🙏`;
    await sendInteractiveButtons(sock, jid, {
      text: regNotice,
      buttons: [
        { type: 'copy', text: '📋 Salin Format .daftar', copy_code: '.daftar ' }
      ]
    });
    return true;
  }

  // ─── .ai / .gemini / .tanyaai — AI Assistant & Vision ───────
    const isFromGroup = jid.endsWith('@g.us');
    const groupSettings = isFromGroup ? await db.getGroupSettings(jid) : {};
    if (isFromGroup && groupSettings.features_config && groupSettings.features_config.ai === false) return false;
    if (['ocr', 'ai', 'gemini', 'tanyaai', 'askai'].includes(cmd)) {

    const isOcr = cmd === 'ocr';
    const promptText = args.slice(1).join(' ').trim();
    const quotedMedia = messageObj?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage || messageObj?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.documentMessage;
    const directMedia = messageObj?.message?.imageMessage || messageObj?.message?.documentMessage;
    const hasImage = !!(quotedMedia || directMedia);

    if (isOcr) {
      if (!hasImage) {
        await sock.sendMessage(jid, {
          text: '💡 *CARA PAKAI OCR (Premium)* 💡\n\nReply gambar atau dokumen PDF dengan perintah `.ocr` untuk mengekstrak teks di dalamnya.'
        }, { quoted: messageObj });
        return true;
      }
      
      const premiumTier = await db.getPremiumTier(senderNumber);
      if (premiumTier === 'Free' && !isAdmin && !isOwner) {
        await sock.sendMessage(jid, {
          text: '🚫 *FITUR KHUSUS PREMIUM*\n\nFitur `.ocr` untuk ekstrak teks dari gambar/PDF hanya tersedia bagi pengguna *Silver, Gold, dan Diamond*.\n\n💸 Ketik `.premium` untuk melihat info paket.'
        }, { quoted: messageObj });
        return true;
      }
    }

    if (!isOcr && !promptText && !hasImage) {
      await sock.sendMessage(jid, {
        text: '🤖 *AI ASSISTANT GEMINI* 🤖\n\n💡 *Cara Pakai:*\n• Ketik `.ai [pertanyaan]` untuk tanya AI.\n• Reply foto/PDF dengan `.ai [instruksi]` untuk analisis.\n\n*Contoh:* `.ai jelaskan hukum newton secara ringkas`'
      }, { quoted: messageObj });
      return true;
    }

    // Check daily quota limit
    const premiumTier = await db.getPremiumTier(senderNumber);
    const benefits = getPremiumBenefits(premiumTier);
    const usedCount = await db.getAiUsageToday(senderNumber);

    if (!isAdmin && !isOwner && usedCount >= benefits.aiDailyLimit) {
      await sock.sendMessage(jid, {
        text: `⚠️ *KUOTA AI HARIAN HABIS* (${usedCount}/${benefits.aiDailyLimit})\n\nKuotamu untuk tier *${premiumTier}* telah terpakai semua hari ini.\n\n💸 Upgrade ke *Gold* / *Diamond* untuk kuota AI lebih banyak!\nKetik *.premium* untuk info paket.`
      }, { quoted: messageObj });
      return true;
    }

    await sock.sendMessage(jid, { text: isOcr ? '💡 _Sedang mengekstrak teks (OCR)..._' : '🤖 _Sedang berpikir..._' }, { quoted: messageObj });

    try {
      const { askGeminiText, askGeminiVision, askGeminiOCR } = await import('./src/ai/geminiService.js');
      let aiResponse = '';

      if (hasImage) {
        const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
        const mediaObj = quotedMedia || directMedia;
        
        let imgBuffer;
        try {
          const type = mediaObj.mimetype?.includes('pdf') || mediaObj.mimetype?.includes('document') ? 'document' : 'image';
          const stream = await downloadContentFromMessage(mediaObj, type);
          let buffer = Buffer.from([]);
          for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
          }
          imgBuffer = buffer;
        } catch (e) {
          console.error('[AI_ERR_DL]', e);
          throw new Error('Gambar/PDF tidak ditemukan atau tidak dapat diunduh oleh sistem. (Log: ' + e.message + ')');
        }

        const mimeType = mediaObj.mimetype || 'image/jpeg';
        
        if (isOcr) {
           const isPdf = mimeType.includes('pdf') || imgBuffer.toString('utf8', 0, 4) === '%PDF';
           if (isPdf) {
              const { createRequire } = await import('module');
              const require = createRequire(import.meta.url);
              const pdfParse = require('pdf-parse');
              
              let extractedText = '';
              try {
                const res = await pdfParse(imgBuffer);
                extractedText = (res.text || '').replace(/-- \d+ of \d+ --/g, '').trim();
              } catch (pdfErr) {
                console.error('[PDF_PARSE_ERR]', pdfErr);
              }

              if (extractedText.length > 5) {
                aiResponse = extractedText;
              }

              if (!aiResponse || !aiResponse.trim()) {
                aiResponse = "❌ *Gagal Mengunduh / Membaca Teks PDF*\n\nPDF tidak memuat teks yang dapat dibaca atau proteksi file aktif. Silakan kirimkan berupa tangkapan layar (screenshot) gambar.";
              }
           } else {
              const { createRequire } = await import('module');
              const require = createRequire(import.meta.url);
              const Tesseract = require('tesseract.js');
              
              const worker = await Tesseract.createWorker('eng');
              const { data: { text } } = await worker.recognize(imgBuffer);
              await worker.terminate();
              aiResponse = text;
           }
        } else {
           aiResponse = await askGeminiVision({
             prompt: promptText || 'Analisis dan jelaskan isi dokumen/gambar ini dengan jelas dan ringkas.',
             imageBuffer: imgBuffer,
             mimeType
           });
        }
      } else {
        // Conversational AI context
        const session = aiContextMap.get(senderNumber) || { messages: [], lastActive: Date.now() };
        const context = session.messages || [];
        
        let contextualPrompt = "";
        if (context.length > 0) {
          contextualPrompt += "Konteks percakapan sebelumnya:\n";
          context.forEach(msg => {
             contextualPrompt += `User: ${msg.user}\nAI: ${msg.bot}\n`;
          });
          contextualPrompt += "\nSekarang jawab pertanyaan berikut dari User:\nUser: " + promptText;
        } else {
          contextualPrompt = promptText;
        }

        aiResponse = await askGeminiText({ prompt: contextualPrompt });
        
        // Save history
        context.push({ user: promptText, bot: aiResponse });
        if (context.length > 5) {
          context.shift();
        }
        aiContextMap.set(senderNumber, { messages: context, lastActive: Date.now() });
      }

      await db.incrementAiUsage(senderNumber);
      const remaining = benefits.aiDailyLimit - (usedCount + 1);

      const formattedReply = `🤖 *GEMINI AI RESPONSE*\n━━━━━━━━━━━━━━━━━━━━\n\n${aiResponse}\n\n━━━━━━━━━━━━━━━━━━━━\n💡 _Sisa kuota AI hari ini: ${remaining}/${benefits.aiDailyLimit}_`;
      await sock.sendMessage(jid, { text: formattedReply }, { quoted: messageObj });
    } catch (err) {
      console.error('[AI_ERR]', err.stack);
      if (isOcr) {
        await sock.sendMessage(jid, {
          text: `❌ *Gagal mengekstrak teks (OCR lokal):* ${err.message}`
        }, { quoted: messageObj });
      } else {
        await sock.sendMessage(jid, {
          text: `❌ *Gagal menghubungi AI:* ${err.message}\n\n_Pastikan GEMINI_API_KEY sudah terpasang di .env._`
        }, { quoted: messageObj });
      }
    }
    return true;
  }

  // ─── .resetai — Reset AI Context ───────
  if (cmd === 'resetai') {
    if (aiContextMap.has(senderNumber)) {
      aiContextMap.delete(senderNumber);
      await sock.sendMessage(jid, { text: "✅ Ingatan percakapan AI telah dihapus. Mari mulai dari awal!" }, { quoted: messageObj });
    } else {
      await sock.sendMessage(jid, { text: "⚠️ Kamu belum memiliki percakapan dengan AI." }, { quoted: messageObj });
    }
    return true;
  }

  // ─── .lapak — Reseller Lapak Komunitas ───────────────────────
  if (['lapak', 'jual'].includes(cmd)) {
    const { handleLapakCommand } = await import('./src/reseller/resellerService.js');
    const isPrem = (await db.getPremiumTier(senderNumber)) !== 'Free';
    return await handleLapakCommand({ sock, jid, senderNumber, messageObj, args, cleanCmd, isPremium: isPrem, premiumTier: await db.getPremiumTier(senderNumber) });
  }

  // ─── .claimvoucher — Klaim voucher bulanan (Diamond) ────────
  if (['claimvoucher', 'klaimvoucher', 'vouchergobay'].includes(cmd)) {
    const tier = await db.getPremiumTier(senderNumber);
    const benefits = getPremiumBenefits(tier);

    if (benefits.monthlyVoucherRp <= 0) {
      await sock.sendMessage(jid, {
        text: `⚠️ *AKSES DITOLAK*\n\nVoucher bulanan gratis Rp10.000 khusus untuk Member 💎 *Diamond*.\nStatus kamu saat ini: *${tier}*.\n\n👑 Ketik *.premium* untuk upgrade ke Diamond!`
      }, { quoted: messageObj });
      return true;
    }

    const claimRes = await db.claimMonthlyVoucher(senderNumber, benefits.monthlyVoucherRp);
    if (!claimRes.success) {
      await sock.sendMessage(jid, { text: `⚠️ ${claimRes.message}` }, { quoted: messageObj });
      return true;
    }

    await sock.sendMessage(jid, {
      text: `🎉 *VOUCHER BULANAN BERHASIL DIKLAIM!* 🎉\n\n🎁 Bonus Saldo Toko: *+Rp${claimRes.amount.toLocaleString('id-ID')}*\n📅 Periode: *${claimRes.monthStr}*\n\n_Saldo sudah otomatis masuk ke akun Anda dan bisa langsung digunakan untuk berbelanja produk!_`
    }, { quoted: messageObj });
    return true;
  }

  // ─── .wishlist — Restock DM Notification ─────────────────────
  if (['wishlist', 'ingatkan'].includes(cmd)) {
    const sub = (args[1] || '').toLowerCase();
    const produkKode = (args[2] || '').toUpperCase();

    if (sub === 'add' && produkKode) {
      const res = await db.addWishlist(senderNumber, produkKode);
      if (!res.success) {
        await sock.sendMessage(jid, { text: `⚠️ ${res.message}` }, { quoted: messageObj });
      } else {
        await sock.sendMessage(jid, { text: `✅ Produk *${produkKode}* ditambahkan ke wishlist Anda!\n\n_Bot akan otomatis mengirimkan DM WhatsApp saat produk ini di-restock parah admin._` }, { quoted: messageObj });
      }
      return true;
    }

    if (sub === 'del' && produkKode) {
      await db.removeWishlist(senderNumber, produkKode);
      await sock.sendMessage(jid, { text: `✅ Produk *${produkKode}* dihapus dari wishlist.` }, { quoted: messageObj });
      return true;
    }

    await sock.sendMessage(jid, {
      text: `⚡ *RESTOCK DM ALERT (WISHLIST)*\n\n📌 *Cara Pakai:*\n• \`.wishlist add [KODE_PRODUK]\` — Pasang notifikasi DM saat stok di-restock\n• \`.wishlist del [KODE_PRODUK]\` — Hapus notifikasi\n\n*Contoh:* \`.wishlist add NET01\``
    }, { quoted: messageObj });
    return true;
  }

  // ─── .premium — Info paket ───────────────────────────────────
  if (cmd === 'premium') {
    const current = await db.getPremiumUser(senderNumber);
    const currentTierLabel = current
      ? `\n\n✅ *Status kamu:* ${PREMIUM_TIERS[current.tier]?.emoji} *${current.tier}*\n📅 Aktif hingga: *${formatExpiry(current.expires_at)}* (${daysLeft(current.expires_at)} hari lagi)`
      : '\n\n📌 Kamu saat ini di tier *Free*.';

    const tierList = Object.entries(PREMIUM_TIERS).map(([key, t]) => {
      const b = t.benefits;
      return [
        `${t.emoji} *${key}* — ${t.pricePoin} Poin / ${t.days} hari`,
        `  • AI Gemini: *${b.aiDailyLimit}x / hari*`,
        `  • Diskon belanja: *${b.shopDiscountPct}%*`,
        `  • Reseller Lapak: *${b.resellerAccess ? '✅ Aktif' : '❌'}*`,
        `  • DM Restock Alert: *${b.restockDmAlert ? '✅ Aktif' : '❌'}*`,
        `  • Voucher Bulanan: *${b.monthlyVoucherRp > 0 ? `Rp${b.monthlyVoucherRp.toLocaleString('id-ID')}` : '❌'}*`,
        `  • XP Booster: *${b.xpMult}x*`
      ].join('\n');
    }).join('\n\n');

    await sock.sendMessage(jid, {
      text: [
        `👑 *PREMIUM MEMBERSHIP 2.0 — AKBAR STORE*`,
        ``,
        tierList,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        currentTierLabel,
        ``,
        `_Ketik *.upgradepremium silver/gold/diamond* untuk upgrade!_`
      ].join('\n')
    }, { quoted: messageObj });
    return true;
  }


  // ─── .upgradepremium TIER — Beli premium dengan poin ─────────
  if (['upgradepremium', 'buypremium', 'premium buy'].includes(cmd)) {
    const tierArg = args[1];
    const tierKey = tierArg ? tierArg.charAt(0).toUpperCase() + tierArg.slice(1).toLowerCase() : null;

    if (!tierKey || !PREMIUM_TIERS[tierKey]) {
      await sock.sendMessage(jid, {
        text: `❌ Tier tidak valid!\nPilih: *silver*, *gold*, atau *diamond*\n\nContoh: *.upgradepremium gold*\n\nLihat info paket: *.premium*`
      }, { quoted: messageObj });
      return true;
    }

    const tierInfo = PREMIUM_TIERS[tierKey];
    const profile = await db.getGameProfile(senderNumber);
    const currentPoints = (typeof profile?.points === 'number' && isFinite(profile.points)) ? Math.max(0, Math.floor(profile.points)) : 0;

    if (currentPoints < tierInfo.pricePoin) {
      await sock.sendMessage(jid, {
        text: `❌ Poin tidak cukup!\n\n${tierInfo.emoji} ${tierKey} butuh: *${tierInfo.pricePoin} poin*\nPoin kamu: *${currentPoints}*\nKurang: *${tierInfo.pricePoin - currentPoints} poin*\n\n💡 Main game untuk kumpulkan poin!\n*.daily* *.quiz* *.slot* *.dungeon*`
      }, { quoted: messageObj });
      return true;
    }

    // Cek kalau sudah premium tier yang sama atau lebih tinggi
    const current = await db.getPremiumUser(senderNumber);
    const tierOrder = { Silver: 1, Gold: 2, Diamond: 3 };
    if (current && tierOrder[current.tier] >= tierOrder[tierKey]) {
      await sock.sendMessage(jid, {
        text: `⚠️ Kamu sudah punya tier *${current.tier}* yang setara/lebih tinggi!\nMasa aktif: ${daysLeft(current.expires_at)} hari lagi.\n\nUpgrade ke tier lebih tinggi atau perpanjang nanti.`
      }, { quoted: messageObj });
      return true;
    }

    // Konfirmasi sebelum deduct
    if (args[2]?.toLowerCase() !== 'confirm') {
      await sock.sendMessage(jid, {
        text: [
          `${tierInfo.emoji} *KONFIRMASI UPGRADE PREMIUM*`,
          ``,
          `Paket: *${tierKey}* (${tierInfo.days} hari)`,
          `Harga: *${tierInfo.pricePoin} poin*`,
          `Poin kamu: *${currentPoints}*`,
          `Sisa setelah: *${currentPoints - tierInfo.pricePoin} poin*`,
          ``,
          `*Benefit yang didapat:*`,
          `• Daily reward *${tierInfo.benefits.dailyRewardMult}x*`,
          `• Diskon belanja *${tierInfo.benefits.shopDiscountPct}%*`,
          `• RPG Gold & XP Boost`,
          ``,
          `_Ketik *.upgradepremium ${tierKey.toLowerCase()} confirm* untuk lanjut!_`
        ].join('\n')
      }, { quoted: messageObj });
      return true;
    }

    // Kurangi poin secara atomik & grant premium
    const deductRes = await db.deductGamePoints(senderNumber, tierInfo.pricePoin);
    if (!deductRes.success) {
      await sock.sendMessage(jid, { text: `❌ Poin kamu tidak mencukupi untuk upgrade ke ${tierKey}!` }, { quoted: messageObj });
      return true;
    }
    const newPoints = deductRes.newPoints;
    const result = await db.grantPremium(senderNumber, tierKey, tierInfo.days, 'SELF');
    await db.logPremiumBenefit(senderNumber, 'UPGRADE', `${tierKey} for ${tierInfo.days} days`);

    await sock.sendMessage(jid, {
      text: [
        `🎉 *SELAMAT! PREMIUM AKTIF!*`,
        ``,
        `${tierInfo.emoji} Tier: *${tierKey}*`,
        `📅 Aktif hingga: *${formatExpiry(result.expiresAt)}*`,
        `⭐ Sisa poin: *${newPoints}*`,
        ``,
        `*Benefit aktif sekarang:*`,
        `✅ Daily reward *${tierInfo.benefits.dailyRewardMult}x*`,
        `✅ Diskon belanja *${tierInfo.benefits.shopDiscountPct}%*`,
        `✅ RPG Gold Boost *${tierInfo.benefits.rpgGoldMult}x*`,
        `✅ RPG XP Boost *${tierInfo.benefits.rpgXpMult}x*`,
        ``,
        `Ketik *.daily* untuk klaim reward pertamamu!`
      ].join('\n')
    }, { quoted: messageObj });
    return true;
  }

  // ─── .cekpremium — Cek status premium ─────────────────────────
  if (['cekpremium', 'checkpremium', 'statuspremium', 'myplan'].includes(cmd)) {
    const current = await db.getPremiumUser(senderNumber);
    const profile = await db.getGameProfile(senderNumber);

    if (!current) {
      const nextCheapest = PREMIUM_TIERS.Silver;
      const poin = profile?.points || 0;
      await sock.sendMessage(jid, {
        text: [
          `📊 *STATUS PREMIUM KAMU*`,
          ``,
          `🎮 Tier: *Free*`,
          `💰 Poin kamu: *${poin}*`,
          ``,
          `Untuk upgrade ke 🥈 Silver butuh: *${nextCheapest.pricePoin} poin*`,
          `Kurang: *${Math.max(0, nextCheapest.pricePoin - poin)} poin*`,
          ``,
          `Lihat info lengkap: *.premium*`
        ].join('\n')
      }, { quoted: messageObj });
      return true;
    }

    const tierInfo = PREMIUM_TIERS[current.tier];
    const benefits = tierInfo.benefits;
    const remaining = daysLeft(current.expires_at);

    await sock.sendMessage(jid, {
      text: [
        `👑 *STATUS PREMIUM KAMU*`,
        ``,
        `${tierInfo.emoji} Tier: *${current.tier}*`,
        `📅 Aktif hingga: *${formatExpiry(current.expires_at)}*`,
        `⏳ Sisa: *${remaining} hari*`,
        ``,
        `*Benefit aktif:*`,
        `• Daily reward: *${benefits.dailyRewardMult}x*`,
        `• Diskon belanja: *${benefits.shopDiscountPct}%*`,
        `• RPG Gold Boost: *${benefits.rpgGoldMult}x*`,
        `• RPG XP Boost: *${benefits.rpgXpMult}x*`,
        `• Heal cooldown: *${Math.round(benefits.healCooldownMult * 100)}%*`,
        ``,
        remaining <= 5 ? `⚠️ *Premium hampir habis!* Segera perpanjang dengan *.upgradepremium ${current.tier.toLowerCase()}*` : `_Ketik *.premium* untuk lihat info paket lain._`
      ].join('\n')
    }, { quoted: messageObj });
    return true;
  }

  // ─── .premiumbenefit — Detail semua benefit ───────────────────
  if (['premiumbenefit', 'benefits', 'keuntunganpremium'].includes(cmd)) {
    const current = await db.getPremiumUser(senderNumber);
    const activeTier = current?.tier || 'Free';

    const rows = ['Free', 'Silver', 'Gold', 'Diamond'].map(tier => {
      const t = PREMIUM_TIERS[tier];
      const b = t ? t.benefits : { dailyRewardMult: 1, shopDiscountPct: 0, rpgGoldMult: 1, rpgXpMult: 1 };
      const active = tier === activeTier ? ' ← *KAMU*' : '';
      const emoji = t?.emoji || '🎮';
      return `${emoji} *${tier}*${active}\n  Daily: ${b.dailyRewardMult}x | Diskon: ${b.shopDiscountPct}% | RPG: Gold ${b.rpgGoldMult}x / XP ${b.rpgXpMult}x`;
    });

    await sock.sendMessage(jid, {
      text: `📋 *TABEL BENEFIT PREMIUM*\n\n${rows.join('\n\n')}\n\n_Ketik *.upgradepremium tier* untuk upgrade_`
    }, { quoted: messageObj });
    return true;
  }

  // ─── ADMIN: .setpremium / .revokepremium / .listpremium ─────────
  if (['setpremium', 'revokepremium', 'listpremium'].includes(cmd)) {
    // Memberi tier premium bernilai uang, jadi wajib Admin Toko — bukan sekadar admin grup WA.
    if (!isStoreAdmin && !isOwner) {
      await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh *Admin Toko* atau *Owner*. Status admin grup WhatsApp saja tidak cukup." }, { quoted: messageObj });
      return true;
    }

    if (cmd === 'setpremium') {
      const mentions = messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const targetJid = mentions[0] || (args[1] ? args[1].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
      const tierArg = args[2];
      const daysArg = parseInt(args[3]) || 30;

      if (!targetJid || !tierArg) {
        await sock.sendMessage(jid, {
          text: `❌ Format: *.setpremium @user TIER HARI*\nContoh: *.setpremium @user gold 30*`
        }, { quoted: messageObj });
        return true;
      }

      const tierKey = tierArg.charAt(0).toUpperCase() + tierArg.slice(1).toLowerCase();
      if (!PREMIUM_TIERS[tierKey]) {
        await sock.sendMessage(jid, { text: `❌ Tier tidak valid: *${tierArg}*. Pilih: silver, gold, diamond` }, { quoted: messageObj });
        return true;
      }

      try {
        const result = await db.grantPremium(targetJid, tierKey, daysArg, 'ADMIN');
        const phone = targetJid.split('@')[0];
        await sock.sendMessage(jid, {
          text: `✅ Premium berhasil diberikan!\n\n📱 User: *+${phone}*\n${PREMIUM_TIERS[tierKey].emoji} Tier: *${tierKey}*\n📅 Sampai: *${formatExpiry(result.expiresAt)}*\n⏳ Durasi: *${daysArg} hari*`
        }, { quoted: messageObj });
      } catch (e) {
        await sock.sendMessage(jid, { text: `❌ Gagal: ${e.message}` }, { quoted: messageObj });
      }
      return true;
    }

    if (cmd === 'revokepremium') {
      const mentions = messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const targetJid = mentions[0] || (args[1] ? args[1].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);

      if (!targetJid) {
        await sock.sendMessage(jid, { text: `❌ Format: *.revokepremium @user*` }, { quoted: messageObj });
        return true;
      }

      const removed = await db.revokePremium(targetJid);
      const phone = targetJid.split('@')[0];
      await sock.sendMessage(jid, {
        text: removed
          ? `✅ Premium user *+${phone}* berhasil dicabut.`
          : `⚠️ User *+${phone}* tidak memiliki premium aktif.`
      }, { quoted: messageObj });
      return true;
    }

    if (cmd === 'listpremium') {
      const rows = await db.listPremiumUsers();
      if (rows.length === 0) {
        await sock.sendMessage(jid, { text: `📋 Tidak ada premium user aktif saat ini.` }, { quoted: messageObj });
        return true;
      }

      const lines = rows.map((r, i) => {
        const tierInfo = PREMIUM_TIERS[r.tier];
        const phone = r.jid.split('@')[0];
        return `${i+1}. ${tierInfo?.emoji || '👑'} *${r.nama}* (+${phone})\n   Tier: ${r.tier} | Sisa: ${daysLeft(r.expires_at)} hari`;
      });

      await sock.sendMessage(jid, {
        text: `📋 *PREMIUM USERS AKTIF* (${rows.length})\n\n${lines.join('\n\n')}`
      }, { quoted: messageObj });
      return true;
    }
  }

  return false;
}
