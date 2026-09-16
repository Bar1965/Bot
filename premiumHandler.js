import * as db from './database.js';
import { sendInteractiveButtons } from './bot.js';

const aiContextMap = new Map();

// Bersihkan konteks AI yang tidak aktif lebih dari 30 menit setiap 10 menit
setInterval(() => {
  try {
    const now = Date.now();
    for (const [key, val] of aiContextMap.entries()) {
      if (val && val.lastActive && (now - val.lastActive > 30 * 60 * 1000)) {
        aiContextMap.delete(key);
      }
    }
  } catch (e) {}
}, 10 * 60 * 1000).unref?.();

// ============================================================
// KONFIGURASI TIER PREMIUM
// ============================================================
export const PREMIUM_TIERS = {
  // Tangga paling bawah, diminta owner: "kalau mau naik premium minimal 3k."
  //
  // Gunanya bukan menjual benefit besar, melainkan menurunkan ongkos masuk. Yang
  // kena batas gratisan sekarang menghadapi pilihan Rp3.000, bukan Rp5.000 —
  // selisih yang kecil buat toko tapi menentukan buat anak sekolah yang cuma mau
  // mengunduh beberapa video lagi.
  //
  // Sengaja TIDAK memberi diskon belanja maupun akses reseller: dua itu milik
  // Silver ke atas, supaya tangganya tetap punya arti dan Perunggu tidak
  // mematikan tier yang harganya dua kali lipat.
  Perunggu: {
    tier: 'Perunggu', emoji: '🥉',
    priceRp: 3000,
    days: 30,
    benefits: {
      aiDailyLimit: 5,
      funPerMinute: 12,
      mediaDailyLimit: 25,
      mediaCooldownSec: 15,
      dailyRewardMult: 1.2,
      rpgGoldMult: 1.2,
      rpgXpMult: 1.2,
      healCooldownMult: 0.9,
      slotMaxBet: 35000,
      shopDiscountPct: 0,
      resellerAccess: false,
      restockDmAlert: false,
      monthlyVoucherRp: 0,
      xpMult: 1.5,
      badge: '🥉 Perunggu'
    },
    description: '5x AI/hari, 25x unduhan/hari, jeda 15 dtk, 1.5x XP Booster. Paket masuk termurah.'
  },
  Silver: {
    tier: 'Silver', emoji: '🥈',
    priceRp: 5000,
    days: 30,
    benefits: {
      aiDailyLimit: 10,
      funPerMinute: 16,
      mediaDailyLimit: 30,
      mediaCooldownSec: 15,
      dailyRewardMult: 1.5,
      rpgGoldMult: 1.5,
      rpgXpMult: 1.5,
      healCooldownMult: 0.8,
      slotMaxBet: 50000,
      shopDiscountPct: 5,
      resellerAccess: true,
      restockDmAlert: false,
      monthlyVoucherRp: 0,
      xpMult: 2.0,
      badge: '🥈 Silver Member'
    },
    description: '10x AI/hari, 30x unduhan/hari, diskon 5%, Akses Lapak Reseller, 2x XP Booster.'
  },
  Gold: {
    tier: 'Gold', emoji: '🥇',
    priceRp: 10000,
    days: 30,
    benefits: {
      aiDailyLimit: 25,
      funPerMinute: 25,
      mediaDailyLimit: 60,
      mediaCooldownSec: 10,
      dailyRewardMult: 2.0,
      rpgGoldMult: 2.0,
      rpgXpMult: 2.0,
      healCooldownMult: 0.5,
      slotMaxBet: 100000,
      shopDiscountPct: 10,
      resellerAccess: true,
      restockDmAlert: true,
      monthlyVoucherRp: 0,
      xpMult: 3.0,
      badge: '🥇 Gold Member'
    },
    description: '25x AI/hari, 60x unduhan/hari, diskon 10%, Lapak Reseller + DM Restock Alert, 3x XP Booster.'
  },
  Diamond: {
    tier: 'Diamond', emoji: '💎',
    priceRp: 25000,
    days: 30,
    benefits: {
      aiDailyLimit: 50,
      funPerMinute: 40,
      mediaDailyLimit: 150,
      mediaCooldownSec: 5,
      dailyRewardMult: 3.0,
      rpgGoldMult: 3.0,
      rpgXpMult: 3.0,
      healCooldownMult: 0.2,
      slotMaxBet: 500000,
      shopDiscountPct: 15,
      resellerAccess: true,
      restockDmAlert: true,
      monthlyVoucherRp: 10000,
      xpMult: 5.0,
      badge: '💎 Diamond Member'
    },
    description: '50x AI/hari, 150x unduhan/hari, diskon 15%, Lapak Reseller, DM Restock Alert, Voucher Rp10k/bln, 5x XP Booster.'
  }
};

export function getPremiumBenefits(tier) {
  return PREMIUM_TIERS[tier]?.benefits || {
    aiDailyLimit: 3,
    // Jatah unduhan pemain gratisan.
    //
    // Diturunkan dari 15 ke 10 pada 16 September 2026 atas permintaan owner
    // ("banyak spam"). Angka 15 dipilih tanpa data dan ternyata TIDAK PERNAH
    // tersentuh: pemakaian tertinggi yang pernah tercatat 12 kali sehari, satu
    // orang, satu kali; sehari-harinya 4-7. Batas yang tidak pernah kena bukan
    // batas, cuma angka di layar.
    //
    // Pada 10, pemakai terberat mulai menyentuhnya beberapa kali sebulan — cukup
    // untuk menahan pemborongan dan untuk membuat Perunggu Rp3.000 punya alasan
    // dibeli, tanpa mengganggu orang yang cuma unduh sesekali.
    mediaDailyLimit: 10,
    mediaCooldownSec: 30,
    // Rem semburan untuk perintah fun & game — lihat src/utils/pembatasLaju.js.
    // Delapan perintah per menit itu lebih cepat daripada siapa pun yang benar-
    // benar sedang bermain, dan jauh lebih lambat daripada orang yang sedang
    // membanjiri grup.
    funPerMinute: 8,
    dailyRewardMult: 1.0,
    rpgGoldMult: 1.0,
    rpgXpMult: 1.0,
    healCooldownMult: 1.0,
    slotMaxBet: 25000,
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
              } else {
                try {
                  aiResponse = await askGeminiOCR({ imageBuffer: imgBuffer, mimeType: 'application/pdf' });
                } catch (_) {}
              }

              if (!aiResponse || !aiResponse.trim()) {
                aiResponse = "❌ *Gagal Mengunduh / Membaca Teks PDF*\n\nPDF tidak memuat teks yang dapat dibaca atau proteksi file aktif. Silakan kirimkan berupa tangkapan layar (screenshot) gambar.";
              }
           } else {
              try {
                const { createRequire } = await import('module');
                const require = createRequire(import.meta.url);
                const Tesseract = require('tesseract.js');
                
                const worker = await Tesseract.createWorker('eng');
                const { data: { text } } = await worker.recognize(imgBuffer);
                await worker.terminate();
                if (text && text.trim().length > 3) {
                  aiResponse = text.trim();
                }
              } catch (tessErr) {
                console.warn('[TESSERACT_OCR_WARN]', tessErr.message);
              }

              // Fallback ke Gemini Vision OCR jika Tesseract kosong / gagal
              if (!aiResponse || aiResponse.trim().length < 3) {
                aiResponse = await askGeminiOCR({ imageBuffer: imgBuffer, mimeType });
              }
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

      const header = isOcr ? '📄 *HASIL EKSTRAK TEKS (OCR)*' : '🤖 *AI ASSISTANT RESPONSE*';
      const formattedReply = `${header}\n━━━━━━━━━━━━━━━━━━━━\n\n${aiResponse}\n\n━━━━━━━━━━━━━━━━━━━━\n💡 _Sisa kuota AI hari ini: ${remaining}/${benefits.aiDailyLimit}_`;
      await sock.sendMessage(jid, { text: formattedReply }, { quoted: messageObj });
    } catch (err) {
      console.error('[AI_ERR]', err.stack);
      // Pesan mentah dari Google bisa memuat detail endpoint, status kuota, dan
      // potongan konfigurasi — tidak boleh sampai ke customer. Admin/Owner tetap
      // menerima detailnya supaya tetap bisa mendiagnosis.
      const detailAdmin = (isAdmin || isOwner) ? `\n\n_Detail (admin):_ ${err.message}` : '';
      if (isOcr) {
        await sock.sendMessage(jid, {
          text: `❌ *Gagal Membaca Teks (OCR)*\n\nDokumen atau gambarnya tidak terbaca. Coba kirim ulang dengan foto yang lebih jelas dan tidak miring.${detailAdmin}`
        }, { quoted: messageObj });
      } else {
        const koneksiLambat = /timeout|tidak merespons|ETIMEDOUT|ECONNRESET|socket hang up|EAI_AGAIN/i.test(String(err.message || ''));
        const pesanRamah = koneksiLambat
          ? 'Server AI sedang lambat merespons, jadi permintaanmu dihentikan otomatis. Coba lagi sebentar lagi.'
          : 'Layanan AI sedang bermasalah. Coba lagi beberapa saat lagi.';
        await sock.sendMessage(jid, {
          text: `❌ *AI Tidak Bisa Dihubungi*\n\n${pesanRamah}${detailAdmin}`
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
        `${t.emoji} *${key}* — Rp${t.priceRp.toLocaleString('id-ID')} / ${t.days} hari`,
        `  • AI Gemini: *${b.aiDailyLimit}x / hari*`,
        `  • Downloader: *${b.mediaDailyLimit}x / hari* _(jeda ${b.mediaCooldownSec} dtk)_`,
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
        `💳 Premium dibayar dengan *saldo deposit* (uang asli), bukan Akbar Poin.`,
        `Top up: *.deposit <nominal>*   |   Cek saldo: *.saldo*`,
        ``,
        `_Ketik *.upgradepremium silver/gold/diamond* untuk upgrade!_`
      ].join('\n')
    }, { quoted: messageObj });
    return true;
  }


  // ─── .upgradepremium TIER — Beli premium dengan saldo deposit ───
  // Premium adalah produk berbayar: hanya bisa dibeli dengan uang asli lewat
  // saldo deposit (`.deposit` → QRIS Casaku). Akbar Poin tidak pernah bisa
  // membelinya, supaya poin hasil main game tidak punya nilai rupiah.
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
    const currentBalance = await db.getCustomerBalance(senderNumber);

    if (currentBalance < tierInfo.priceRp) {
      const kurang = tierInfo.priceRp - currentBalance;
      const saranTopUp = Math.max(5000, Math.ceil(kurang / 1000) * 1000);
      await sock.sendMessage(jid, {
        text: `❌ *SALDO DEPOSIT TIDAK CUKUP*\n\n${tierInfo.emoji} ${tierKey} (${tierInfo.days} hari): *Rp${tierInfo.priceRp.toLocaleString('id-ID')}*\n💳 Saldo kamu: *Rp${currentBalance.toLocaleString('id-ID')}*\n📉 Kurang: *Rp${kurang.toLocaleString('id-ID')}*\n\n💡 Premium hanya bisa dibeli dengan uang asli lewat saldo deposit.\n\n📥 Top up: *.deposit ${saranTopUp}*\n💰 Cek saldo: *.saldo*`
      }, { quoted: messageObj });
      return true;
    }

    // Cek kalau sudah premium di tier yang LEBIH TINGGI — itu saja yang ditolak.
    //
    // Dulu syaratnya `>=`, jadi pemilik Gold tidak bisa membeli Gold lagi. Padahal
    // `.cekpremium` sendiri menyuruh: "Premium hampir habis! Segera perpanjang
    // dengan .upgradepremium gold" — perintah yang persis itu selalu ditolak.
    // Pelanggan yang sedang siap membayar Rp10.000-25.000 untuk bulan berikutnya
    // justru dihentikan tepat di detik dia mau membayar.
    const current = await db.getPremiumUser(senderNumber);
    const tierOrder = { Perunggu: 1, Silver: 2, Gold: 3, Diamond: 4 };
    const masihAktif = current && new Date(current.expires_at) > new Date();

    if (masihAktif && tierOrder[current.tier] > tierOrder[tierKey]) {
      await sock.sendMessage(jid, {
        text: `⚠️ Kamu sudah punya tier *${current.tier}* yang lebih tinggi dari *${tierKey}*!\nMasa aktif: ${daysLeft(current.expires_at)} hari lagi.\n\n_Perpanjang tier yang sekarang:_ *.upgradepremium ${current.tier.toLowerCase()}*`
      }, { quoted: messageObj });
      return true;
    }

    const naikTier = masihAktif && tierOrder[current.tier] < tierOrder[tierKey];
    const perpanjangan = masihAktif && current.tier === tierKey;

    // Naik tier: sisa hari di tier lama TIDAK dibawa apa adanya ke tier baru.
    // Kalau dibawa, siapa pun bisa menimbun hari murah di Silver (Rp5.000/30 hari)
    // lalu menaikkan seluruh timbunan itu jadi Diamond (Rp25.000/30 hari) dengan
    // sekali bayar. Sisa hari dikonversi menurut nilai rupiahnya.
    let hariBonus = 0;
    if (naikTier) {
      const lama = PREMIUM_TIERS[current.tier];
      const sisaHari = Math.max(0, daysLeft(current.expires_at));
      const nilaiSisa = sisaHari * (lama.priceRp / lama.days);
      hariBonus = Math.floor(nilaiSisa / (tierInfo.priceRp / tierInfo.days));
    }

    // Konfirmasi sebelum deduct
    if (args[2]?.toLowerCase() !== 'confirm') {
      await sock.sendMessage(jid, {
        text: [
          `${tierInfo.emoji} *KONFIRMASI ${perpanjangan ? 'PERPANJANGAN' : 'UPGRADE'} PREMIUM*`,
          ``,
          `Paket: *${tierKey}* (${tierInfo.days} hari)`,
          ...(perpanjangan ? [`Ditambahkan ke sisa masa aktifmu (${daysLeft(current.expires_at)} hari).`] : []),
          ...(naikTier ? [`Sisa ${daysLeft(current.expires_at)} hari *${current.tier}* dikonversi jadi *+${hariBonus} hari ${tierKey}*.`] : []),
          `Harga: *Rp${tierInfo.priceRp.toLocaleString('id-ID')}* (dipotong dari saldo deposit)`,
          `Saldo kamu: *Rp${currentBalance.toLocaleString('id-ID')}*`,
          `Sisa setelah: *Rp${(currentBalance - tierInfo.priceRp).toLocaleString('id-ID')}*`,
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

    // Potong saldo deposit secara atomik — deductCustomerBalance memakai guard
    // `balance >= ?` di dalam transaksi, jadi aman dari double-spend.
    const deductRes = await db.deductCustomerBalance(
      senderNumber,
      tierInfo.priceRp,
      `Pembelian Premium ${tierKey} ${tierInfo.days} hari`
    );
    if (!deductRes.success) {
      await sock.sendMessage(jid, {
        text: `❌ ${deductRes.message || `Saldo deposit tidak cukup untuk membeli Premium ${tierKey}.`}`
      }, { quoted: messageObj });
      return true;
    }
    const newBalance = deductRes.newBalance;
    const result = naikTier
      // Naik tier: mulai hitung dari sekarang, karena hariBonus SUDAH memuat sisa
      // masa aktif tier lama yang dikonversi. Menumpuknya di atas expiry lama akan
      // menghitung hari yang sama dua kali.
      ? await db.grantPremium(senderNumber, tierKey, tierInfo.days + hariBonus, 'SELF', { mulaiDariSekarang: true })
      // Baru / perpanjangan tier yang sama: ditumpuk di atas masa aktif yang ada.
      : await db.grantPremium(senderNumber, tierKey, tierInfo.days, 'SELF');
    await db.logPremiumBenefit(senderNumber, 'UPGRADE', `${tierKey} for ${tierInfo.days} days`);

    await sock.sendMessage(jid, {
      text: [
        `🎉 *SELAMAT! PREMIUM ${perpanjangan ? 'DIPERPANJANG' : 'AKTIF'}!*`,
        ``,
        `${tierInfo.emoji} Tier: *${tierKey}*`,
        ...(naikTier && hariBonus > 0 ? [`🔁 Sisa *${current.tier}* dikonversi: *+${hariBonus} hari*`] : []),
        `📅 Aktif hingga: *${formatExpiry(result.expiresAt)}*`,
        `💳 Sisa saldo deposit: *Rp${(newBalance || 0).toLocaleString('id-ID')}*`,
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
      const nextCheapest = PREMIUM_TIERS.Perunggu;
      const saldo = await db.getCustomerBalance(senderNumber);
      await sock.sendMessage(jid, {
        text: [
          `📊 *STATUS PREMIUM KAMU*`,
          ``,
          `🎮 Tier: *Free*`,
          `💳 Saldo deposit: *Rp${saldo.toLocaleString('id-ID')}*`,
          ``,
          `Untuk upgrade ke 🥈 Silver butuh: *Rp${nextCheapest.priceRp.toLocaleString('id-ID')}*`,
          `Kurang: *Rp${Math.max(0, nextCheapest.priceRp - saldo).toLocaleString('id-ID')}*`,
          ``,
          `Top up saldo: *.deposit <nominal>*`,
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

    const rows = ['Free', 'Perunggu', 'Silver', 'Gold', 'Diamond'].map(tier => {
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
      // Nomor mentah TIDAK boleh dirakit jadi `628xxx@s.whatsapp.net` begitu saja:
      // 191 dari 194 pelanggan tersimpan sebagai @lid, jadi baris premium yang
      // ditulis tidak akan pernah cocok dengan siapa pun. Bot tetap membalas
      // "✅ Premium berhasil diberikan!" — uangnya diterima, tier tidak pernah naik.
      let targetJid = mentions[0] || null;
      if (!targetJid && args[1]) {
        const hasil = await db.resolveTargetJid(args[1]);
        if (!hasil.ditemukan) {
          await sock.sendMessage(jid, {
            text: `❌ *NOMOR TIDAK DITEMUKAN*\n\nNomor \`${args[1]}\` tidak cocok dengan pelanggan mana pun di database.\n\n_Pakai mention supaya pasti tepat sasaran:_\n*.setpremium @user ${args[2] || 'gold'} ${args[3] || 30}*`
          }, { quoted: messageObj });
          return true;
        }
        targetJid = hasil.jid;
      }
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
      let targetJid = mentions[0] || null;
      if (!targetJid && args[1]) {
        const hasil = await db.resolveTargetJid(args[1]);
        if (!hasil.ditemukan) {
          await sock.sendMessage(jid, {
            text: `❌ Nomor \`${args[1]}\` tidak cocok dengan pelanggan mana pun. Pakai mention: *.revokepremium @user*`
          }, { quoted: messageObj });
          return true;
        }
        targetJid = hasil.jid;
      }

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
