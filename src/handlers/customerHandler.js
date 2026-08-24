import * as db from '../../database.js';
import { config } from '../../config.js';
import { jidNormalizedUser, downloadMediaMessage, downloadContentFromMessage } from '@whiskeysockets/baileys';
import { createMidtransTransaction, botState } from '../../server.js';
import { buildCommandMenu } from '../../commandRegistry.js';
import * as mediaHandler from '../../mediaHandler.js';
import * as ent from '../../entertainmentHandler.js';
import { sendInteractiveButtons } from '../../bot.js';
import fs from 'fs';
import path from 'path';

// In-Memory Nav Session untuk Quick Dial Angka & Alur Belanja Cepat (TTL 10 Menit)
const userNavSessions = new Map();

// Auto-cleanup userNavSessions setiap 5 menit
setInterval(() => {
  const now = Date.now();
  for (const [userJid, session] of userNavSessions.entries()) {
    if (now - session.updatedAt > 10 * 60 * 1000) {
      userNavSessions.delete(userJid);
    }
  }
}, 5 * 60 * 1000);

function setUserNavSession(userJid, sessionData) {
  userNavSessions.set(userJid, {
    ...sessionData,
    updatedAt: Date.now()
  });
}

function getUserNavSession(userJid) {
  const session = userNavSessions.get(userJid);
  if (!session) return null;
  if (Date.now() - session.updatedAt > 10 * 60 * 1000) {
    userNavSessions.delete(userJid);
    return null;
  }
  return session;
}

export function createCustomerHandler(ctx = {}) {
  const { 
    sock, 
    botSettings = {}, 
    userPushNamesMap = new Map(), 
    messageCache = new Map(), 
    formatPhoneNumber = (n) => n, 
    react = async () => {}, 
    sendInteractiveButtons = async () => {}, 
    checkIsUserInGroup = async () => ({ isMember: true }), 
    sendQris = async (j, text) => sock.sendMessage(j, { text }), 
    logToSystem = async (type, msg) => db.addLog(type, msg) 
  } = ctx;

  // Helper cerdas pencocokan pesanan bahasa santai (Natural Language Order Matcher)
  const matchNaturalOrder = async (textQuery) => {
    const q = (textQuery || '').toLowerCase().trim();
    if (!/^(?:beli|buy|order|pesan|mau|ambil|tolong)\s+/i.test(q)) {
      return null;
    }
    const cleanQ = q.replace(/^(?:beli|buy|order|pesan|mau|ambil|tolong)\s+/i, '').trim();
    if (!cleanQ || cleanQ.length < 3) return null;

    // Cek kata kunci durasi
    let targetDuration = null;
    if (/7\s*(?:hari|day|h|d)\b/i.test(cleanQ)) targetDuration = '7 Hari';
    else if (/14\s*(?:hari|day|h|d)\b/i.test(cleanQ)) targetDuration = '14 Hari';
    else if (/(?:30\s*(?:hari|day|h|d)|1\s*(?:bulan|bln|month|m)|sebulan)\b/i.test(cleanQ)) targetDuration = '30 Hari';
    else if (/(?:60\s*(?:hari|day|h|d)|2\s*(?:bulan|bln|month|m))\b/i.test(cleanQ)) targetDuration = '2 Bulan';
    else if (/(?:90\s*(?:hari|day|h|d)|3\s*(?:bulan|bln|month|m))\b/i.test(cleanQ)) targetDuration = '3 Bulan';
    else if (/(?:6\s*(?:bulan|bln|month|m))\b/i.test(cleanQ)) targetDuration = '6 Bulan';
    else if (/(?:12\s*(?:bulan|bln|month|m)|1\s*(?:tahun|thn|year|y)|setahun)\b/i.test(cleanQ)) targetDuration = '1 Tahun';

    // Cek tipe (sharing / private)
    let targetType = null;
    if (/\b(?:sharing|shared|sh|1\s*profil|profil)\b/i.test(cleanQ)) targetType = 'Sharing';
    if (/\b(?:private|privat|pv|full|5\s*profil)\b/i.test(cleanQ)) targetType = 'Private';

    const allProducts = await db.getProducts();
    let matchedProducts = [];

    for (const p of allProducts) {
      const pBrand = (p.brand_category || '').toLowerCase();
      const pName = (p.nama || '').toLowerCase();
      const pSku = (p.kode || '').toLowerCase();

      const isBrandMatch = (pBrand && cleanQ.includes(pBrand)) || 
                           cleanQ.includes(pSku) || 
                           pName.split(/\s+/).some(word => word.length > 3 && cleanQ.includes(word));
      if (isBrandMatch) {
        matchedProducts.push(p);
      }
    }

    if (matchedProducts.length === 0) return null;

    let filtered = matchedProducts;
    if (targetType) {
      const byType = filtered.filter(p => (p.variant_type || '').toLowerCase().includes(targetType.toLowerCase()));
      if (byType.length > 0) filtered = byType;
    }
    if (targetDuration) {
      const byDur = filtered.filter(p => {
        const dur = (p.duration || '').toLowerCase();
        const nama = (p.nama || '').toLowerCase();
        if (targetDuration === '30 Hari') return /\b30\b/i.test(dur) || /\b1\s*(?:bulan|bln|month|m)\b/i.test(dur) || /\b30\b/i.test(nama) || /\b1\s*(?:bulan|bln|month|m)\b/i.test(nama) || /sebulan/i.test(nama);
        if (targetDuration === '7 Hari') return /\b7\b/i.test(dur) || /\b7\b/i.test(nama);
        if (targetDuration === '14 Hari') return /\b14\b/i.test(dur) || /\b14\b/i.test(nama);
        if (targetDuration === '2 Bulan') return /\b2\s*(?:bulan|bln|month|m)\b/i.test(dur) || /\b60\b/i.test(dur) || /\b2\s*(?:bulan|bln|month|m)\b/i.test(nama);
        if (targetDuration === '3 Bulan') return /\b3\s*(?:bulan|bln|month|m)\b/i.test(dur) || /\b90\b/i.test(dur) || /\b3\s*(?:bulan|bln|month|m)\b/i.test(nama);
        if (targetDuration === '6 Bulan') return /\b6\s*(?:bulan|bln|month|m)\b/i.test(dur) || /\b6\s*(?:bulan|bln|month|m)\b/i.test(nama);
        if (targetDuration === '1 Tahun') return /\b(?:12|1\s*tahun|setahun)\b/i.test(dur) || /\b(?:12|1\s*tahun|setahun)\b/i.test(nama);
        return false;
      });
      if (byDur.length > 0) filtered = byDur;
    }

    return {
      bestMatch: filtered[0] || matchedProducts[0],
      matches: filtered,
      allBrandVariants: matchedProducts
    };
  };

  return async function handleCustomerMessage(jid, senderNumber, messageObj, text, isFromGroup = false, actor = {}) {
    try { fs.appendFileSync('./tmp/trace.log', new Date().toISOString() + '  A-customerHandler-masuk  ' + JSON.stringify({ teks: text, adaGambar: !!messageObj?.message?.imageMessage }) + '\n'); } catch (_) {}
    const textLower = (text || '').toLowerCase();
    const cleanText = (text || '').replace(/^[./#]/, '').trim();
    const cleanTextLower = textLower.replace(/^[./#]/, '').trim();
    const args = (text || '').trim().split(/\s+/);
    const rawCmd = args[0]?.toLowerCase() || '';
    const cleanCmd = rawCmd.replace(/^[./#]/, '');

    const customerName = messageObj?.pushName || "Pelanggan";
    await db.getOrCreateCustomer(senderNumber, customerName);

    // 🥚 EASTER EGG MEME: "Kapan Kapan yh sayang" (Boleh trigger tanpa prefix)
    const cleanMemeText = (text || '').toLowerCase().trim().replace(/[?!.,~_*-]+/g, '');
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

    // Cek apakah pesan menggunakan prefix (. / #) ATAU merupakan navigasi angka cepat saat sesi aktif
    const isPrefix = actor?.isPrefixCmd !== undefined 
      ? actor.isPrefixCmd 
      : ((text || '').trim().startsWith('.') || (text || '').trim().startsWith('/') || (text || '').trim().startsWith('#'));

    const isNumericDial = /^[1-9]\d?$/.test(cleanText);
    const hasNavSession = Boolean(getUserNavSession(senderNumber));

    // STRICT PREFIX RULE: Hanya perbolehkan pesan ber-prefix atau angka dial saat sesi navigasi aktif
    if (!isPrefix && !(isNumericDial && hasNavSession)) {
      return false;
    }

    // REGISTRATION CHECK
    const exemptCustomerCmds = [
      'daftar', 'register', 'registrasi', 'owner', 'kontakowner', 'menu', 'help', 'bantuan',
      'list', 'produk', 'katalog', 'listproduk', 'p', 'detail', 'info', 'lihat'
    ];

    if (!exemptCustomerCmds.includes(cleanCmd) && !actor.isAdmin && !actor.isOwner) {
      const isReg = await db.isCustomerRegistered(senderNumber);
      if (!isReg) {
        const senderMention = senderNumber.split('@')[0];
        const regNotice = `⚠️ *AKSES DITOLAK — REGISTRASI DIPERLUKAN* ⚠️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nHalo @${senderMention}! Anda harus terdaftar sebagai member terlebih dahulu untuk melakukan transaksi / menggunakan fitur ini (100% Gratis & Cepat).\n\n📌 *Cara Pendaftaran (Hanya 5 Detik):*\nKetik: \`.daftar Nama Kamu\`\n\n_Contoh:_ \`.daftar Budi Santoso\`\n\nSetelah terdaftar, Anda dapat langsung berbelanja dan menikmati seluruh fitur bot! 🙏`;
        await sendInteractiveButtons(sock, jid, {
          text: regNotice,
          buttons: [
            { type: 'copy', text: '📋 Salin Format .daftar', copy_code: '.daftar ' }
          ]
        });
        return true;
      }
    }

    const memberProfile = await db.getCustomerMembershipProfile(senderNumber);
    const isPrivateCommand =
      ['beli', 'buy'].includes(cleanCmd) ||
      ['cart', 'keranjang', 'checkout', 'bayar', 'cancel', 'batal', 'status', 'riwayat', 'history'].includes(cleanCmd);
    const responseJid = (isFromGroup && isPrivateCommand) ? senderNumber : jid;

    if (memberProfile?.account_status === 'BANNED' && !actor.isAdmin && !actor.isOwner) {
      await sock.sendMessage(jid, { text: '⛔ Akun kamu sedang diblokir dari layanan bot. Hubungi Owner jika merasa ini kesalahan.' });
      return true;
    }

    // Helper render menu grup varian (misal: Netflix Sharing vs Private dengan durasi 7H, 14H, 30H)
    const handleVariantGroupView = async (brandName, variants) => {
      const icon = db.getBrandEmoji ? db.getBrandEmoji(brandName) : '🎬';
      const limit = botSettings.lowStockLimit || config.defaults.lowStockLimit;

      // Kelompokkan varian berdasarkan variant_type (misal: 'Sharing', 'Private', 'Individual')
      const typeGroups = new Map();
      const allNumberedVariants = [];

      for (const v of variants) {
        const typeKey = v.variant_type || 'PILIHAN PAKET';
        if (!typeGroups.has(typeKey)) {
          typeGroups.set(typeKey, []);
        }
        typeGroups.get(typeKey).push(v);
      }

      let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${icon} *${brandName.toUpperCase()} — PILIHAN PAKET & VARIAN*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n_Balas nomor paket atau pilih dari menu di bawah:_\n\n`;

      const variantRows = [];
      const quickBuyButtons = [];

      let itemCounter = 1;
      for (const [typeKey, items] of typeGroups.entries()) {
        msg += `📌 *${typeKey.toUpperCase()}:*\n`;
        for (const item of items) {
          let stockBadge = "🟢 Ready";
          if (item.stok === 0) {
            stockBadge = "🔴 Habis";
          } else if (item.stok <= limit) {
            stockBadge = `🟡 Sisa ${item.stok}`;
          }

          const durLabel = item.duration || item.nama;
          msg += `[${itemCounter}] *${durLabel}* — *Rp${item.harga.toLocaleString('id-ID')}*\n`;
          if (item.deskripsi) {
            msg += `    • Ket: ${item.deskripsi}\n`;
          }
          msg += `    • Kode: \`${item.kode}\` | [${stockBadge}]\n\n`;

          allNumberedVariants.push(item);

          variantRows.push({
            title: `[${itemCounter}] ${durLabel}`,
            description: `Rp${item.harga.toLocaleString('id-ID')} • [${stockBadge}] • ${item.kode}`,
            id: `.beli ${item.kode} 1`
          });

          if (quickBuyButtons.length < 2 && item.stok > 0) {
            quickBuyButtons.push({
              type: 'reply',
              text: `🛒 Beli [${itemCounter}] ${durLabel.length > 12 ? durLabel.substring(0, 10) + '..' : durLabel}`,
              id: `.beli ${item.kode} 1`
            });
          }

          itemCounter++;
        }
      }

      // Simpan sesi navigasi varian untuk user
      setUserNavSession(senderNumber, {
        type: 'VARIANT_LIST',
        brand: brandName,
        items: allNumberedVariants
      });

      msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 *CARA SUPER CEPAT:*\nBalas angka: *1* s/d *${allNumberedVariants.length}* untuk langsung beli!\nAtau klik salah satu tombol varian di bawah.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

      const sections = variantRows.length > 0 ? [
        {
          title: `🛍️ PILIH VARIAN ${brandName.toUpperCase()}`,
          rows: variantRows.slice(0, 10)
        }
      ] : [];

      quickBuyButtons.push({ type: 'reply', text: '💝 Wishlist', id: `.simpan ${variants[0]?.kode}` });
      quickBuyButtons.push({ type: 'reply', text: '📦 Katalog Utama', id: '.list' });

      await sendInteractiveButtons(sock, responseJid, {
        text: msg,
        title: `${icon} ${brandName.toUpperCase()} — PILIHAN VARIAN`,
        footer: 'Balas nomor pilihan Anda atau klik menu dropdown di bawah',
        buttons: quickBuyButtons,
        sections
      });
      return true;
    };

    // Helper render detail produk lengkap saat SKU spesifik dipilih
    const handleProductDetail = async (product) => {
      const limit = botSettings.lowStockLimit || config.defaults.lowStockLimit;
      let stockStatus = "";
      if (product.stok === 0) {
        stockStatus = "🔴 *Stok Habis* (Restok segera / klik tombol notifikasi)";
      } else if (product.stok <= limit) {
        stockStatus = `🟡 *Stok Terbatas* (Tersisa: ${product.stok} pcs)`;
      } else {
        stockStatus = `🟢 *Ready Stock* (Tersedia: ${product.stok} pcs)`;
      }

      const deliveryBadge = product.delivery_type === 'AUTO'
        ? '⚡ *Otomatis (Instant Delivery)*\n_(Akun/voucher dikirim otomatis dalam 2–5 detik setelah konfirmasi bayar)_'
        : '👨‍💼 *Manual oleh Admin Toko*';

      let detailMsg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛍️ *DETAIL & SPESIFIKASI PRODUK*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📌 *Nama Produk:* *${product.nama}*\n🔑 *Kode Produk:* \`${product.kode}\`\n💰 *Harga Satuan:* *Rp${product.harga.toLocaleString('id-ID')}*\n📦 *Status Stok:* ${stockStatus}\n🚀 *Sistem Pengiriman:* ${deliveryBadge}`;

      if (product.duration) {
        detailMsg += `\n⏳ *Durasi Masa Aktif:* ${product.duration}`;
      }
      if (product.variant_type) {
        detailMsg += `\n🏷️ *Jenis Paket:* ${product.variant_type}`;
      }

      detailMsg += `\n\n📝 *DESKRIPSI & FITUR:*\n${product.deskripsi ? product.deskripsi.trim() : '_Tidak ada deskripsi tambahan._'}`;

      if (product.petunjuk && product.petunjuk.trim()) {
        detailMsg += `\n\n📖 *PETUNJUK PENGGUNAAN / INFO GARANSI:*\n${product.petunjuk.trim()}`;
      }

      detailMsg += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 *CARA MEMBELI LANGSUNG:*\nKetik: *.beli ${product.kode} 1*\n_(Bisa tambah jumlah, contoh: \`.beli ${product.kode} 2\`)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

      const detailButtons = [];
      if (product.stok > 0) {
        detailButtons.push({ type: 'reply', text: `🛒 Beli Sekarang`, id: `.beli ${product.kode} 1` });
        detailButtons.push({ type: 'reply', text: `💳 Bayar QRIS`, id: `.beli ${product.kode} 1` });
      } else {
        detailButtons.push({ type: 'reply', text: `🔔 Notif Restok`, id: `.notify ${product.kode}` });
      }
      detailButtons.push({ type: 'reply', text: `💝 Wishlist`, id: `.simpan ${product.kode}` });
      detailButtons.push({ type: 'reply', text: `📦 Kembali ke List`, id: '.list' });

      await sendInteractiveButtons(sock, responseJid, {
        text: detailMsg,
        title: `🛍️ ${product.nama}`,
        footer: 'Gunakan tombol di bawah untuk pesan langsung atau kembali ke katalog',
        buttons: detailButtons
      });
      return true;
    };

    // ====================================================================
    // 🔢 QUICK DIAL / NAVIGASI BALAS ANGKA CEPAT (1, 2, 3...)
    // ====================================================================
    if (isNumericDial) {
      const dialNum = parseInt(cleanText, 10);
      const navSession = getUserNavSession(senderNumber);

      if (navSession) {
        // Kasus 1: Sesi Memilih Brand Kategori ([1] Netflix, [2] Spotify, dll)
        if (navSession.type === 'BRAND_LIST') {
          const selectedItem = navSession.items[dialNum - 1];
          if (selectedItem) {
            if (selectedItem.isMulti) {
              const variantData = await db.getProductVariants(selectedItem.brand);
              return await handleVariantGroupView(selectedItem.brand, variantData.variants);
            } else {
              const prod = await db.getProductByKode(selectedItem.targetId);
              if (prod) return await handleProductDetail(prod);
            }
          }
        }

        // Kasus 2: Sesi Memilih Varian Paket ([1] 7 Hari, [2] 14 Hari, [3] 30 Hari, dll)
        if (navSession.type === 'VARIANT_LIST') {
          const selectedVariant = navSession.items[dialNum - 1];
          if (selectedVariant) {
            const addRes = await db.addToCart(senderNumber, selectedVariant.kode, 1);
            if (!addRes.success) {
              await sock.sendMessage(responseJid, { text: `❌ ${addRes.message}` });
              return true;
            }

            setUserNavSession(senderNumber, {
              type: 'ORDER_READY',
              selectedSku: selectedVariant.kode,
              productName: selectedVariant.nama,
              price: selectedVariant.harga
            });

            const durLabel = selectedVariant.duration || selectedVariant.nama;
            const confirmMsg = `✅ *PILIHAN BERHASIL DITAMBAHKAN!*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛍️ *Paket:* ${selectedVariant.nama}
🔑 *Kode SKU:* \`${selectedVariant.kode}\`
💰 *Harga:* *Rp${selectedVariant.harga.toLocaleString('id-ID')}*
📦 *Status:* Ready Stock (Siap Kirim)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💡 *Langkah Selanjutnya:*
Ketik *bayar* atau klik tombol *Bayar QRIS Langsung* di bawah untuk langsung memperoleh kode QRIS tagihan Anda!`;

            await sendInteractiveButtons(sock, responseJid, {
              text: confirmMsg,
              title: `✅ ${selectedVariant.nama.toUpperCase()}`,
              footer: 'Pilih Bayar QRIS Langsung untuk transaksi instan',
              buttons: [
                { type: 'reply', text: '💳 Bayar QRIS Langsung', id: '.checkout' },
                { type: 'reply', text: '🛒 Lihat Keranjang', id: '.keranjang' },
                { type: 'reply', text: '📦 Katalog Utama', id: '.list' }
              ]
            });
            return true;
          }
        }
      }
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

    // --- FITUR GANTI NAMA (.gantinama / .ubahnama / .setname / .rename) ---
    if (['gantinama', 'ubahnama', 'setname', 'rename'].includes(cleanCmd)) {
      const mentioned = messageObj.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      const isTargetOther = Boolean(mentioned) || (args[1] && args[1].startsWith('62') && args.length > 2);

      let targetJid = senderNumber;
      let requestedName = '';

      if (isTargetOther && (actor.isAdmin || actor.isOwner)) {
        targetJid = mentioned || (args[1].includes('@') ? jidNormalizedUser(args[1]) : `${args[1].replace(/\D/g, '')}@s.whatsapp.net`);
        requestedName = args.slice(2).join(' ').trim();
      } else {
        requestedName = args.slice(1).join(' ').trim();
      }

      if (!requestedName) {
        const adminExample = (actor.isAdmin || actor.isOwner) ? '\n_Khusus Admin/Owner:_ `.gantinama @user <Nama Baru>`' : '';
        await sock.sendMessage(responseJid, {
          text: `📌 *PANDUAN GANTI NAMA PROFIL*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n👉 *Format:* \`.gantinama <Nama Baru Kamu>\`\n_Contoh:_ \`.gantinama Akbar Pratama\`${adminExample}`
        });
        return true;
      }

      try {
        const result = await db.updateCustomerName(targetJid, requestedName, senderNumber);
        const isSelf = targetJid === senderNumber;
        const targetMention = targetJid.split('@')[0];

        const replyText = isSelf
          ? `✅ *NAMA PROFIL BERHASIL DIUBAH!* ✨\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🏷️ Nama Lama: *${result.oldName}*\n✨ Nama Baru: *${result.newName}*\n📱 Nomor: *@${targetMention}*\n🏆 Tier Member: *${result.profile.tier}*\n\n_Ketik \`.profil\` untuk melihat profil lengkap kamu._`
          : `✅ *NAMA MEMBER BERHASIL DIUBAH OLEH ADMIN!* ✨\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n👤 Member: *@${targetMention}*\n🏷️ Nama Lama: *${result.oldName}*\n✨ Nama Baru: *${result.newName}*\n🏆 Tier: *${result.profile.tier}*`;

        await sock.sendMessage(responseJid, {
          text: replyText,
          mentions: [targetJid]
        });
      } catch (error) {
        await sock.sendMessage(responseJid, { text: `❌ Gagal mengubah nama: ${error.message}` });
      }
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

  if (['profil', 'akun', 'member', 'statusakun'].includes(cleanCmd)) {
    const targetJid = extractTargetMember() || senderNumber;
    const isSelf = targetJid === senderNumber;
    const profile = await db.getCustomerMembershipProfile(targetJid);
    const phoneNum = targetJid.split('@')[0];

    const formatWib = (dateStr) => {
      if (!dateStr) return '-';
      try {
        const isoStr = dateStr.includes('Z') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
        const d = new Date(isoStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleString('id-ID', {
          timeZone: 'Asia/Jakarta',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        }) + ' WIB';
      } catch (e) {
        return dateStr;
      }
    };

    const role = (targetJid === senderNumber && actor.isOwner) ? 'OWNER' : (profile?.role || 'MEMBER');
    const isRegistered = profile?.profile_completed === 1;
    const regStatus = isRegistered ? '✅ Terdaftar' : '⚠️ Belum lengkap (ketik .daftar <nama>)';
    const regDate = isRegistered ? formatWib(profile?.registered_at) : 'Belum pernah registrasi';
    const lastSeen = formatWib(profile?.last_seen_at);
    const custNick = profile?.nama ? `*${profile.nama}* (@${phoneNum})` : `@${phoneNum}`;
    const headerTitle = isSelf ? `👤 *INFORMASI PROFIL SAYA* (${custNick})` : `👤 *INFORMASI PROFIL MEMBER* (${custNick})`;

    let text = `${headerTitle}\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `📋 *DATA REGISTRASI*\n`;
    text += `▫️ Nama / Nick: *${profile?.nama || customerName}*\n`;
    text += `▫️ WhatsApp: @${phoneNum}\n`;
    text += `▫️ Status Akun: *${profile?.account_status || 'ACTIVE'}*\n`;
    text += `▫️ Role: *${role}*\n`;
    text += `▫️ Status Registrasi: *${regStatus}*\n`;
    text += `▫️ Tanggal Daftar: *${regDate}*\n`;
    text += `▫️ Terakhir Aktif: *${lastSeen}*\n\n`;

    text += `💳 *KEUANGAN & KEANGGOTAAN*\n`;
    text += `▫️ Tier Pelanggan: *${profile?.tier || 'BRONZE'}*\n`;
    text += `▫️ Saldo Akun: *Rp${(profile?.balance || 0).toLocaleString('id-ID')}*\n`;
    text += `▫️ Poin Loyalty: *${profile?.loyalty_points || 0} pts*\n`;
    if (profile?.referral_code) {
      text += `▫️ Kode Referral: *${profile.referral_code}*\n`;
    }
    if (profile?.referred_by) {
      text += `▫️ Di-referral oleh: *${profile.referred_by}*\n`;
    }
    text += `\n`;

    text += `🛒 *STATISTIK TRANSAKSI*\n`;
    text += `▫️ Total Pesanan: *${profile?.total_orders || 0} order*\n`;
    text += `▫️ Total Belanja: *Rp${(profile?.total_spend || 0).toLocaleString('id-ID')}*\n\n`;

    text += `🎮 *STATISTIK GAME & POIN*\n`;
    text += `▫️ Level Game: *Lv.${profile?.game_level || 1}* (${profile?.game_xp || 0} XP)\n`;
    text += `▫️ Poin Game: *${profile?.game_points || 0} poin*\n`;
    text += `▫️ Streak Daily: *${profile?.game_streak || 0} hari*`;

    await sock.sendMessage(responseJid, { 
      text,
      mentions: [targetJid]
    });
    return true;
  }

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



  // ==========================================
  // LOGIKA NAVIGASI MENU TERKATEGORI (ASCII ART DESIGN)
  // ==========================================
  const menuMatch = cleanTextLower.match(/^(?:menu|help|bantuan)(?:\s+(1|2|3|4|5|6|jualan|produk|transaksi|bayar|downloader|media|hiburan|game|games|fun|promo|diskon|referral|poin|rank|reward|favorit|wishlist|admin|daftar|registrasi|profil|akun|setmemberrole|memberrole|setmemberstatus|memberstatus|all|semua))?$/i);

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
      return true;
    }

    const organizedMenu = buildCommandMenu(subCat || 'all', { salesMode: isSalesModeGroup });
    if (organizedMenu) {
      await sock.sendMessage(responseJid, { text: organizedMenu });
      return true;
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
    if (['1', 'jualan', 'produk', 'list'].includes(subCat)) {
      const msg = headerCard + `🛍️ *PRODUK & JUALAN*
▫️ \`.list\` / \`.produk\` — Katalog produk ringkas & status stok
▫️ \`.p <kode>\` / \`.detail <kode>\` — Detail spesifikasi & deskripsi produk
▫️ \`.beli <kode> <qty>\` — Beli produk digital
▫️ \`.cari <kata kunci>\` — Cari produk toko
▫️ \`.bundle\` — Lihat paket hemat bundling

━━━━━━━━━━━━━━━━━━━
💡 _Contoh: Ketik .list untuk lihat katalog atau .p NET01 untuk detail_`;
      await sendInteractiveButtons(sock, responseJid, {
        text: msg,
        title: '🛍️ PRODUK & JUALAN',
        footer: 'Pilih aksi di bawah atau ketik perintah langsung',
        buttons: [
          { type: 'reply', text: '🛍️ Katalog Produk', id: '.list' },
          { type: 'reply', text: '🛒 Keranjang Saya', id: '.keranjang' },
          { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
        ]
      });
      return true;
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
      return true;
    }

    // Sub-Menu 3: Downloader, Media & Hiburan
    if (['3', 'downloader', 'media', 'hiburan', 'game'].includes(subCat)) {
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
▫️ \`.tts <teks>\` — Ubah teks ke Voice Note

🎮 *HIBURAN & GAME*
▫️ \`.tebakbendera\` — Game tebak bendera negara
▫️ \`.tebaklagu\` — Game kuis tebak audio lagu
▫️ \`.tebakgambar\` — Game tebak gambar visual
▫️ \`.tebakangka\` — Game tebak angka 1-100
▫️ \`.susunkata\` — Game anagram susun kata
▫️ \`.ww\` — Main Werewolf multiplayer
▫️ \`.khodam <nama>\` — Cek khodam lucu

━━━━━━━━━━━━━━━━━━━
💡 _Contoh penggunaan: .brat kamu nanya? atau .tebakbendera_`;
      await sendInteractiveButtons(sock, responseJid, {
        text: msg,
        title: '📥 MEDIA & GAME',
        footer: 'Pilih aksi cepat di bawah ini',
        buttons: [
          { type: 'reply', text: '💸 Bank & Ekonomi', id: '.menu bank' },
          { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' },
          { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
        ]
      });
      return true;
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
      return true;
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
      return true;
    }

    // Sub-Menu 6: Admin & Owner
    if (['6', 'admin'].includes(subCat)) {
      const msg = headerCard + `👑 *ADMIN & OWNER*
▫️ \`.owner\` — Kontak resmi Pemilik Toko
▫️ \`.ping\` — Cek status & kecepatan respon
▫️ \`.mode <jualan/all>\` — Atur mode grup
▫️ \`.join <link> <hari>\` — Masukkan bot ke grup via link
▫️ \`.antidelete\` — Nyala/matikan fitur anti-hapus pesan
▫️ \`.autosholat <on/off>\` — Nyala/matikan fitur adzan per-grup
▫️ \`.paid <order_id>\` — Konfirmasi pembayaran
▫️ \`.done <order_id>\` — Pesanan selesai
▫️ \`.cancel <order_id>\` — Batalkan pesanan
▫️ \`.tagall <pesan>\` — Mention semua member

━━━━━━━━━━━━━━━━━━━
💡 _Contoh penggunaan: .mode jualan atau .join linkgrup 7_`;
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
      return true;
    }

    // Sub-Menu 7: Ekonomi & Perbankan
    if (['7', 'bank', 'ekonomi', 'economy'].includes(subCat)) {
      const msg = headerCard + `💸 *EKONOMI & PERBANKAN*
▫️ \`.bank <jumlah>\` — Simpan poin ke bank agar aman
▫️ \`.tarik <jumlah>\` — Tarik poin dari bank (pajak 2%)
▫️ \`.transfer <@user> <jml>\` — Transfer poin (pajak 1%)
▫️ \`.rampok <@user>\` — Rampok poin member (risiko ditangkap!)
▫️ \`.slot <taruhan>\` — Main mesin slot (min 10 poin)
▫️ \`.roulette <taruhan> <warna>\` — Kasino roulette (merah/hitam/hijau)

━━━━━━━━━━━━━━━━━━━
💡 _Contoh penggunaan: .rampok @member atau .bank 500_`;
      await sendInteractiveButtons(sock, responseJid, {
        text: msg,
        title: '💸 EKONOMI & BANK',
        footer: 'Sistem ekonomi, bank & perampokan',
        buttons: [
          { type: 'reply', text: '🏆 Lihat Poin', id: '.poin' },
          { type: 'reply', text: '🎁 Klaim Daily', id: '.daily' },
          { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
        ]
      });
      return true;
    }

    // TAMPILAN MENU UTAMA KHUSUS MODE JUALAN / TOKO
    const menuSections = [
      {
        title: '📂 Pilih Kategori Menu Toko',
        rows: [
          { title: '🛍️ Produk & Jualan', id: '.menu jualan', description: 'Katalog, sisa stok & paket hemat' },
          { title: '🛒 Transaksi & Pembayaran', id: '.menu transaksi', description: 'Keranjang, checkout, status & riwayat' },
          { title: '📥 Downloader & Media', id: '.menu media', description: 'TikTok, IG, YT, FB, stiker & AI draw' },
          { title: '🎮 Hiburan & Game', id: '.menu hiburan', description: 'Susun kata, tebak angka/gambar, T-o-D' },
          { title: '💸 Ekonomi & Bank', id: '.menu bank', description: 'Rampok, slot, roulette & transfer' },
          { title: '🏆 Poin & Reward', id: '.menu reward', description: 'Daily claim, poin, rank & referral' },
          { title: '👑 Admin & Owner', id: '.menu admin', description: 'Kontak owner, status bot & pengeluaran' }
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
▫️ \`.list\` / \`.produk\` — Katalog produk ringkas
▫️ \`.p <kode>\` — Detail spesifikasi & deskripsi produk
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
      return true;
    }

    // TAMPILAN MENU UTAMA FULL (MODE ALL)
    const fullMenu = headerCard + `🛍️ *PRODUK & JUALAN*
▫️ \`.list\` / \`.produk\` — Katalog produk ringkas
▫️ \`.p <kode>\` — Detail spesifikasi & deskripsi produk
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
▫️ \`.tw <link>\` — Download media Twitter/X
▫️ \`.yt <link>\` — Download MP3/MP4 YouTube
▫️ \`.getpp <@user>\` — Ambil foto profil HD
▫️ \`.stikerpp <@user>\` — Colong PP jadi stiker
▫️ \`.stiker\` — Foto/Video ke Stiker WA
▫️ \`.toimg\` / \`.tovid\` — Stiker ke Foto/Video
▫️ \`.qc <teks>\` — Stiker Quote Chat
▫️ \`.brat <teks>\` — Stiker Brat Aesthetics
▫️ \`.draw <prompt>\` — Generate foto AI
▫️ \`.hd\` — Jernihkan foto buram
▫️ \`.tts <teks>\` — Ubah teks ke Voice Note

🎮 *HIBURAN & GAME*
▫️ \`.tebakbendera\` — Game tebak bendera negara
▫️ \`.tebaklagu\` — Game kuis tebak audio lagu
▫️ \`.tebakgambar\` — Game tebak gambar visual
▫️ \`.tebakangka\` — Game tebak angka 1-100
▫️ \`.susunkata\` — Game anagram susun kata
▫️ \`.ww\` — Main Werewolf multiplayer
▫️ \`.khodam <nama>\` — Cek khodam lucu

💸 *EKONOMI & PERBANKAN*
▫️ \`.bank <jumlah>\` — Simpan poin ke bank agar aman
▫️ \`.tarik <jumlah>\` — Tarik poin dari bank (pajak 2%)
▫️ \`.transfer <@user> <jml>\` — Transfer poin (pajak 1%)
▫️ \`.rampok <@user>\` — Rampok poin member (risiko!)
▫️ \`.slot <taruhan>\` — Main mesin slot (min 10)
▫️ \`.roulette <taruhan> <warna>\` — Kasino roulette

🎟️ *PROMO & REFERRAL*
▫️ \`.kupon <kode>\` — Gunakan kupon diskon
▫️ \`.referral\` — Kode referral ajak teman
▫️ \`.favorit\` — Lihat produk favorit/wishlist

👑 *ADMIN & OWNER*
▫️ \`.owner\` — Kontak resmi Owner
▫️ \`.ping\` — Cek status & kecepatan respon
▫️ \`.mode <jualan/all>\` — Atur mode grup
▫️ \`.join <link> <hari>\` — Masuk grup via link
▫️ \`.antidelete\` — Nyala/matikan anti-hapus pesan
▫️ \`.autosholat <on/off>\` — Nyala/matikan fitur adzan per-grup
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
    return true;
  }

  // 2A. DETAIL & VARIAN PRODUK (Jika memilih/mengetik brand atau kode, misal: .p netflix, .detail netflix, .p NET-SH-7D, .p SPOTIFY)
  const isDetailCmd = ['p', 'detail', 'info', 'lihat'].includes(cleanCmd) || 
    (['list', 'produk', 'katalog'].includes(cleanCmd) && args.length > 1);

  if (isDetailCmd) {
    const rawTarget = ['p', 'detail', 'info', 'lihat'].includes(cleanCmd) ? (args.slice(1).join(' ').trim() || '') : args.slice(1).join(' ').trim();
    const targetQuery = rawTarget.trim();

    if (targetQuery && !['ALL', 'PRODUK', 'BARANG', 'LIST', 'SEMUA'].includes(targetQuery.toUpperCase())) {
      const variantData = await db.getProductVariants(targetQuery);

      // Jika user mengetik kode SKU eksak dan bukan kata kunci brand umum
      if (variantData.exactProduct && variantData.variants.length <= 1) {
        return await handleProductDetail(variantData.exactProduct);
      }

      // Jika ditemukan beberapa varian dari brand/kategori tersebut
      if (variantData.variants && variantData.variants.length > 1) {
        const brandTitle = variantData.variants[0].brand_category || targetQuery;
        return await handleVariantGroupView(brandTitle, variantData.variants);
      }

      // Jika hanya ditemukan 1 varian produk
      if (variantData.variants && variantData.variants.length === 1) {
        return await handleProductDetail(variantData.variants[0]);
      }

      // Jika tidak ditemukan via getProductVariants, coba searchProducts
      const searchMatches = await db.searchProducts(targetQuery);
      if (searchMatches && searchMatches.length > 1) {
        return await handleVariantGroupView(targetQuery, searchMatches);
      } else if (searchMatches && searchMatches.length === 1) {
        return await handleProductDetail(searchMatches[0]);
      }

      await sock.sendMessage(responseJid, { 
        text: `❌ Produk/Layanan dengan kata kunci *${targetQuery}* tidak ditemukan.\n\nKetik \`.list\` untuk melihat katalog semua layanan yang tersedia.` 
      });
      return true;
    }
  }

  // 2B. LIST / PRODUK (KATALOG RINGKAS BERDASARKAN BRAND & KATEGORI)
  if (
    cleanCmd === 'list' || 
    cleanCmd === 'produk' || 
    cleanCmd === 'katalog' || 
    cleanCmd === 'catalog' || 
    cleanCmd === 'listproduk' || 
    cleanCmd === 'daftarproduk' ||
    cleanCmd === 'p' ||
    cleanCmd === 'detail' ||
    cleanCmd === 'info' ||
    cleanCmd === 'lihat' ||
    cleanTextLower === 'list' || 
    cleanTextLower === 'produk' || 
    cleanTextLower === 'katalog' || 
    cleanTextLower === 'list produk' || 
    cleanTextLower === 'list all' || 
    cleanTextLower === 'list barang'
  ) {
    const catalog = await db.getGroupedCatalog();
    if (catalog.length === 0) {
      await sock.sendMessage(responseJid, { text: "Saat ini belum ada produk yang terdaftar di toko kami." });
      return true;
    }

    // Simpan sesi navigasi katalog brand untuk user
    setUserNavSession(senderNumber, {
      type: 'BRAND_LIST',
      items: catalog.map(cat => ({
        brand: cat.brand,
        targetId: cat.is_multi ? cat.brand.toLowerCase() : cat.variants[0].kode,
        isMulti: cat.is_multi
      }))
    });

    let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 *KATALOG PRODUK & LAYANAN*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Pilih nomor layanan atau gunakan menu dropdown di bawah:_\n\n`;

    const productRows = [];

    catalog.forEach((cat, idx) => {
      const icon = cat.icon || '📦';
      const stockBadge = cat.total_stock === 0 ? '🔴 Habis' : `🟢 Ready (${cat.total_stock})`;
      const priceText = cat.min_price === cat.max_price
        ? `*Rp${cat.min_price.toLocaleString('id-ID')}*`
        : `Mulai *Rp${cat.min_price.toLocaleString('id-ID')}*`;

      let optionSummary = "";
      if (cat.types && cat.types.length > 0) {
        optionSummary += cat.types.join(' & ');
      }
      if (cat.durations && cat.durations.length > 0) {
        optionSummary += (optionSummary ? ' • ' : '') + cat.durations.join(', ');
      }

      msg += `[${idx + 1}] ${icon} *${cat.brand.toUpperCase()}* [${stockBadge}]\n`;
      if (optionSummary) {
        msg += `    • Pilihan: ${optionSummary}\n`;
      }
      msg += `    • Harga: ${priceText}\n\n`;
      
      const targetId = cat.is_multi ? `.p ${cat.brand.toLowerCase()}` : `.p ${cat.variants[0].kode}`;

      productRows.push({
        title: `[${idx + 1}] ${icon} ${cat.brand}`,
        description: `${priceText.replace(/\*/g, '')} • [${stockBadge}]`,
        id: targetId
      });
    });

    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 *CARA SUPER CEPAT:*
Balas angka: *1* s/d *${catalog.length}* untuk membuka paket!
Contoh: Cukup ketik *1* untuk membuka Netflix.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    const sections = productRows.length > 0 ? [
      {
        title: '🛍️ PILIH LAYANAN (LIHAT VARIAN & HARGA)',
        rows: productRows.slice(0, 10)
      }
    ] : [];

    await sendInteractiveButtons(sock, responseJid, {
      text: msg,
      title: '📦 KATALOG PRODUK & LAYANAN',
      footer: 'Balas nomor pilihan Anda atau klik menu dropdown di bawah',
      buttons: [
        { type: 'reply', text: '🛒 Keranjang Saya', id: '.keranjang' },
        { type: 'reply', text: '💳 Checkout Pembayaran', id: '.checkout' },
        { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
      ],
      sections
    });
    return true;
  }

  // 2C. SMART NATURAL LANGUAGE ORDERING (Deteksi Pembelian Bahasa Santai)
  const naturalOrderMatch = await matchNaturalOrder(cleanText);
  if (naturalOrderMatch && naturalOrderMatch.bestMatch && !isPrefix && cleanCmd !== 'cari') {
    const item = naturalOrderMatch.bestMatch;
    
    const addRes = await db.addToCart(senderNumber, item.kode, 1);
    if (addRes.success) {
      setUserNavSession(senderNumber, {
        type: 'ORDER_READY',
        selectedSku: item.kode,
        productName: item.nama,
        price: item.harga
      });

      const confirmMsg = `✅ *PESANAN TERDETEKSI & DITAMBAHKAN!*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛍️ *Paket:* ${item.nama}
🔑 *Kode SKU:* \`${item.kode}\`
💰 *Harga:* *Rp${item.harga.toLocaleString('id-ID')}*
📦 *Status Stok:* Ready Stock (Siap Kirim)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💡 *Langkah Selanjutnya:*
Ketik *bayar* atau klik tombol *Bayar QRIS Langsung* di bawah untuk langsung memperoleh kode QRIS tagihan Anda!`;

      await sendInteractiveButtons(sock, responseJid, {
        text: confirmMsg,
        title: `✅ ${item.nama.toUpperCase()}`,
        footer: 'Pilih Bayar QRIS Langsung untuk transaksi instan',
        buttons: [
          { type: 'reply', text: '💳 Bayar QRIS Langsung', id: '.checkout' },
          { type: 'reply', text: '🛒 Lihat Keranjang', id: '.keranjang' },
          { type: 'reply', text: '📦 Katalog Produk', id: '.list' }
        ]
      });
      return true;
    }
  }

  // 3. BELI [KODE] [JUMLAH]
  const buyRegex = /^(?:beli|buy)\s+([a-zA-Z0-9_-]+)(?:\s+(\d+))?$/i;
  if (buyRegex.test(cleanText)) {
    const match = cleanText.match(buyRegex);
    const code = match[1].toUpperCase();

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

    const qty = match[2] ? parseInt(match[2], 10) : 1;

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
  if (cleanTextLower === 'cart' || cleanTextLower === 'keranjang') {
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

  // PERINTAH INSTAN SCAN QRIS (.pay / .qris / .pembayaran)
  if (['pay', 'qris', 'pembayaran'].includes(cleanCmd)) {
    const lastOrder = await db.getLastOrderByCustomer(senderNumber);

    if (lastOrder && (lastOrder.status === 'WAITING_PAYMENT' || lastOrder.status === 'CART')) {
      // Jika ada pesanan aktif, generate/tampilkan Dynamic QRIS otomatis
      try {
        const { createPayment } = await import('../payment/paymentService.js');
        const casakuPayment = await createPayment(lastOrder.order_id, lastOrder.total);

        let qrImageBuffer = null;
        try {
          const QRCode = (await import('qrcode')).default;
          qrImageBuffer = await QRCode.toBuffer(casakuPayment.qrString, {
            type: 'png',
            width: 400,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' }
          });
        } catch (qrErr) {}

        const expiredAt = new Date(casakuPayment.expiredAt);
        const expiredStr = expiredAt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        const itemsText = (lastOrder.items || []).map(item => `- ${item.produk_nama} (x${item.qty})`).join('\n');

        const casakuInvoice = `━━━━━━━━━━━━━━━━━━━━
💳 *QRIS PEMBAYARAN TAGIHAN OTOMATIS*
━━━━━━━━━━━━━━━━━━━━
📦 *Order ID:* ${lastOrder.order_id}
👤 *Nama:* ${lastOrder.customer_nama}

*Rincian Belanja:*
${itemsText}

━━━━━━━━━━━━━━━━━━━━
💸 *TOTAL YANG HARUS DIBAYAR:*
👉 *Rp${casakuPayment.totalAmount.toLocaleString('id-ID')}*
${casakuPayment.uniqueCode > 0 ? `_(Harga produk Rp${lastOrder.total.toLocaleString('id-ID')} + kode unik Rp${casakuPayment.uniqueCode})_\n` : ''}
⏰ *Berlaku hingga:* ${expiredStr} WIB
━━━━━━━━━━━━━━━━━━━━

📱 *Scan QRIS di atas untuk membayar:*
✅ DANA / GoPay / OVO / ShopeePay / BCA / BRI / Mandiri / dll.

🌐 *Invoice & Checkout Online:*
http://localhost:3000/pay/${lastOrder.order_id}

🔄 *Pembayaran diverifikasi OTOMATIS.*
Tidak perlu kirim bukti transfer — produk langsung terkirim begitu bayar!`;

        if (qrImageBuffer) {
          await sock.sendMessage(responseJid, { image: qrImageBuffer, caption: casakuInvoice, mimetype: 'image/png' });
        } else {
          await sock.sendMessage(responseJid, { text: casakuInvoice });
        }
      } catch (err) {
        // Fallback jika API sedang tidak dapat dijangkau
        const invoiceMsg = `━━━━━━━━━━━━━━━━━━\n💳 *TAGIHAN PEMBAYARAN*\n━━━━━━━━━━━━━━━━━━\nOrder ID: *${lastOrder.order_id}*\nNama: *${lastOrder.customer_nama}*\nTotal: *Rp${lastOrder.total.toLocaleString('id-ID')}*\n\n_Ketik \`checkout\` untuk memproses ulang pembayaran QRIS Otomatis._`;
        await sock.sendMessage(responseJid, { text: invoiceMsg });
      }
    } else {
      const qrisInfo = `━━━━━━━━━━━━━━━━━━
💳 *SISTEM PEMBAYARAN QRIS OTOMATIS*
━━━━━━━━━━━━━━━━━━

📌 Pembayaran di toko kami menggunakan **QRIS Otomatis Real-Time**:
• 100% Verifikasi otomatis tanpa perlu kirim bukti transfer.
• Produk digital dikirim langsung 2–5 detik setelah scan berhasil.
• Mendukung DANA, GoPay, OVO, ShopeePay, BCA, BRI, Mandiri, dll.

💡 *Cara Belanja:*
1. Ketik *list* untuk melihat produk toko.
2. Ketik *beli [kode_produk]* untuk memilih produk.
3. Ketik *checkout* untuk memperoleh kode QRIS tagihan Anda!`;
      await sendQris(responseJid, qrisInfo);
    }

    await sendRedirectNotice();
    return;
  }


  // 5. CHECKOUT / BAYAR
  if (cleanTextLower === 'checkout' || cleanTextLower === 'bayar') {

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

    // ================================================================
    // INSTANT SALDO DEPOSIT CHECKOUT (Priority 1)
    // Jika saldo deposit mencukupi, bayar instan tanpa perlu QRIS
    // ================================================================
    const custProfile = await db.getCustomerMembershipProfile(senderNumber);
    if ((custProfile?.balance || 0) >= order.total) {
      const deductRes = await db.deductCustomerBalance(senderNumber, order.total, `Pembelian Order #${order.order_id}`);
      if (deductRes.success) {
        const now = Date.now();
        await db.runQuery(
          "UPDATE orders SET payment_status = 'PAID', status = 'COMPLETED', updated_at = ? WHERE order_id = ?",
          [now, order.order_id]
        );
        await db.createFulfillmentJob(order.order_id, senderNumber);

        // Award purchase points
        const pts = await db.awardPurchasePoints(senderNumber, order.total);

        let successMsg = `✅ *PEMBAYARAN SALDO DEPOSIT BERHASIL!* ✅\n\n`;
        successMsg += `📦 *Order ID:* ${order.order_id}\n`;
        successMsg += `💸 *Total Dibayar:* Rp${order.total.toLocaleString('id-ID')}\n`;
        successMsg += `💳 *Sisa Saldo Deposit:* Rp${deductRes.newBalance.toLocaleString('id-ID')}\n`;
        if (pts > 0) successMsg += `🪙 *Bonus Poin:* +${pts} Akbar Poin\n\n`;
        successMsg += `_Pesanan Anda berhasil dan produk digital sedang dikirimkan otomatis ke chat ini!_`;

        await sock.sendMessage(responseJid, { text: successMsg });
        await db.addLog('ORDER', `🛍️ Order #${order.order_id} dibayar lunas via Saldo Deposit oleh ${senderNumber}`);
        await sendRedirectNotice();
        return;
      }
    }

    // ================================================================
    // CASAKU QRIS OTOMATIS (Priority 2)
    // ================================================================

    const { config: botConfig } = await import('../../config.js');
    const casakuKey = process.env.CASAKU_LICENSE_KEY || botConfig.casaku?.licenseKey || '';
    const casakuQrisId = process.env.CASAKU_QRIS_ID || botConfig.casaku?.qrisId || '';

    if (casakuKey && casakuQrisId) {
      // === CASAKU MODE: Dynamic QRIS Otomatis ===
      let casakuPayment = null;
      try {
        const { createPayment } = await import('../payment/paymentService.js');
        casakuPayment = await createPayment(order.order_id, order.total);
      } catch (err) {
        console.error('[BOT] Casaku QRIS generation failed:', err.message);
        await sock.sendMessage(responseJid, {
          text: `❌ *Gagal membuat QRIS Otomatis.*\n\nSilakan coba lagi dalam beberapa saat atau hubungi admin.\n\n_Error: ${err.message}_`
        });
        await sendRedirectNotice();
        return;
      }

      // Render qr_string → PNG Buffer menggunakan qrcode
      let qrImageBuffer = null;
      try {
        const QRCode = (await import('qrcode')).default;
        qrImageBuffer = await QRCode.toBuffer(casakuPayment.qrString, {
          type: 'png',
          width: 400,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' }
        });
      } catch (qrErr) {
        console.error('[BOT] QR render error:', qrErr.message);
      }

      const expiredAt = new Date(casakuPayment.expiredAt);
      const expiredStr = expiredAt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

      const casakuInvoice = `━━━━━━━━━━━━━━━━━━━━
🧾 *TAGIHAN PEMBAYARAN OTOMATIS*
━━━━━━━━━━━━━━━━━━━━
📦 *Order ID:* ${order.order_id}
👤 *Nama:* ${order.customer_nama}

*Rincian Belanja:*
${itemsText}

━━━━━━━━━━━━━━━━━━━━
💸 *TOTAL YANG HARUS DIBAYAR:*
👉 *Rp${casakuPayment.totalAmount.toLocaleString('id-ID')}*
${casakuPayment.uniqueCode > 0 ? `_(Harga produk Rp${order.total.toLocaleString('id-ID')} + kode unik Rp${casakuPayment.uniqueCode})_\n` : ''}
⏰ *Berlaku hingga:* ${expiredStr} WIB
━━━━━━━━━━━━━━━━━━━━

📱 *Scan QRIS di atas untuk membayar:*
✅ Bisa bayar dari DANA / GoPay / OVO / ShopeePay / BCA / BRI / Mandiri / dll.

🌐 *Invoice & Checkout Online:*
http://localhost:3000/pay/${order.order_id}

🔄 *Pembayaran diverifikasi otomatis.*
Begitu Anda selesai bayar, produk langsung dikirim ke chat ini tanpa perlu konfirmasi manual.

⚠️ *PENTING:* Pastikan nominal transfer PERSIS *Rp${casakuPayment.totalAmount.toLocaleString('id-ID')}* (termasuk kode unik).`;

      if (qrImageBuffer) {
        await sock.sendMessage(responseJid, {
          image: qrImageBuffer,
          caption: casakuInvoice,
          mimetype: 'image/png'
        });
      } else {
        // Fallback teks jika QR gagal di-render
        await sock.sendMessage(responseJid, { text: casakuInvoice + `\n\n_QRIS String (copy-paste ke aplikasi e-wallet):_\n\`\`\`${casakuPayment.qrString}\`\`\`` });
      }

      await logToSystem('ORDER', `🛍️ Customer *${order.customer_nama}* checkout Order *${order.order_id}* — Rp${casakuPayment.totalAmount.toLocaleString('id-ID')} (Casaku QRIS Dynamic)`);
      await sendRedirectNotice();
      return;
    }

    // === FALLBACK: Midtrans atau Manual QRIS ===
    let midtransRes = null;
    try {
      midtransRes = await createMidtransTransaction(order);
    } catch (err) {
      console.error("[BOT] Gagal memicu Midtrans, beralih ke manual QRIS:", err.message);
    }

    if (midtransRes && midtransRes.redirect_url) {
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
  if (cleanTextLower === 'cancel' || cleanTextLower === 'batal') {
    const activeOrder = await db.getLastOrderByCustomer(senderNumber);
    if (activeOrder && activeOrder.casaku_transaction_id) {
      try {
        const { cancelPayment } = await import('../payment/paymentService.js');
        await cancelPayment(activeOrder.order_id, activeOrder.casaku_transaction_id);
      } catch (err) {}
    }

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
  if (cleanTextLower === 'status') {
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
      msg += `- ${item.produk_nama} (x${item.qty || item.jumlah || 1})\n`;
    });
    
    msg += `━━━━━━━━━━━━━━━━━━\n🌐 *Invoice Web:* http://localhost:3000/pay/${details.order_id}\n━━━━━━━━━━━━━━━━━━`;
    await sock.sendMessage(responseJid, { text: msg });
    await sendRedirectNotice();
    return;
  }

  // 7B. GARANSI & KLAIM KENDALA AKUN (.garansi [orderId])
  if (['garansi', 'klaim', 'claim', 'warranty', 'bantuanakun'].includes(cleanCmd)) {
    const targetOrderId = args[1] ? args[1].trim().toUpperCase() : '';
    let targetOrder = null;

    if (targetOrderId) {
      targetOrder = await db.getOrderDetails(targetOrderId);
    } else {
      targetOrder = await db.getCustomerLastOrder(senderNumber);
    }

    if (!targetOrder || (targetOrder.customer_nomor !== senderNumber && !actor.isAdmin && !actor.isOwner)) {
      await sock.sendMessage(responseJid, {
        text: `❌ Tidak ditemukan riwayat pembelian untuk nomor Anda.\n\nKetik \`.list\` untuk berbelanja produk digital.`
      });
      return true;
    }

    const isOrderPaid = ['PAID', 'COMPLETED'].includes(targetOrder.status) || targetOrder.payment_status === 'PAID';
    if (!isOrderPaid) {
      await sock.sendMessage(responseJid, {
        text: `⚠️ Garansi belum aktif karena pesanan *${targetOrder.order_id}* belum berstatus lunas / telah dibatalkan.`
      });
      return true;
    }

    const now = Date.now();
    const wUntil = targetOrder.warranty_until ? Number(targetOrder.warranty_until) : (targetOrder.created_at ? new Date(targetOrder.created_at).getTime() + 30 * 24 * 60 * 60 * 1000 : null);
    const isExpired = wUntil ? (now > wUntil) : false;
    const wDateStr = wUntil ? new Date(wUntil).toLocaleDateString('id-ID', { dateStyle: 'full' }) : '30 Hari sejak pembelian';

    let warrantyMsg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛡️ *STATUS GARANSI & LAYANAN PURNA JUAL*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 *Order ID:* \`${targetOrder.order_id}\`
🛍️ *Status Pesanan:* ${targetOrder.status}
⏱️ *Masa Garansi Hingga:* ${wDateStr}
🛡️ *Status Garansi:* ${isExpired ? '🔴 *Kedaluwarsa*' : '🟢 *Aktif & Bergaransi*'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (isExpired) {
      warrantyMsg += `⚠️ Masa garansi untuk pesanan ini telah selesai. Jika Anda membutuhkan perpanjangan akun baru, ketik \`.list\` untuk memesan kembali.`;
    } else {
      warrantyMsg += `💡 *Klaim Kendala Akun:*
Jika Anda mengalami masalah (akun logout, batas layar, kredensial salah), silakan hubungi tim Admin kami dengan mengklik tombol di bawah atau ketik langsung keluhan Anda di chat ini.`;
    }

    await sendInteractiveButtons(sock, responseJid, {
      text: warrantyMsg,
      title: '🛡️ GARANSI AKBAR STORE',
      footer: 'Layanan purna jual resmi Akbar Store',
      buttons: [
        { type: 'reply', text: '👨‍💼 Hubungi Admin', id: '.owner' },
        { type: 'reply', text: '📦 Katalog Utama', id: '.list' }
      ]
    });
    return true;
  }

  // 8. NOTIFY [KODE] (BERLANGGANAN NOTIFIKASI STOK)
  const notifyRegex = /^(?:notify|notif|hubungi)\s+([a-zA-Z0-9_-]+)$/i;
  if (notifyRegex.test(cleanText)) {
    const match = cleanText.match(notifyRegex);
    const code = match[1].toUpperCase();
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
  if (cleanTextLower === 'riwayat' || cleanTextLower === 'history') {
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
  if (cariRegex.test(cleanText)) {
    const keyword = cleanText.match(cariRegex)[1];
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
  const kuponRegex = /^kupon\s+([a-zA-Z0-9_-]+)$/i;
  if (kuponRegex.test(cleanText)) {
    const code = cleanText.match(kuponRegex)[1].toUpperCase();
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
  if (refUseRegex.test(cleanText)) {
    const targetCode = cleanText.match(refUseRegex)[1].toUpperCase();
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

  if (cleanTextLower === 'referral' || cleanTextLower === 'ref') {
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
  if (cleanTextLower === 'bundle' || cleanTextLower === 'paket') {
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
  if (simpanRegex.test(cleanText)) {
    const code = cleanText.match(simpanRegex)[1].toUpperCase();
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
  if (cleanTextLower === 'favorit' || cleanTextLower === 'wishlist') {
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

👤 Pengguna: *${customerName || messageObj?.pushName || 'Pelanggan'}*
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
      const depositOrderId = `DEP-${Date.now()}`;
      await db.createDepositOrder(depositOrderId, senderNumber, amount);

      const { createPayment } = await import('../payment/paymentService.js');
      const casakuPayment = await createPayment(depositOrderId, amount);

      let qrImageBuffer = null;
      try {
        const QRCode = (await import('qrcode')).default;
        qrImageBuffer = await QRCode.toBuffer(casakuPayment.qrString, {
          type: 'png',
          width: 400,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' }
        });
      } catch (qrErr) {
        console.error('[BOT] QR render error:', qrErr.message);
      }

      const expiredAt = new Date(casakuPayment.expiredAt);
      const expiredStr = expiredAt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

      const depInvoice = `━━━━━━━━━━━━━━━━━━━━
💳 *TOP UP SALDO DEPOSIT OTOMATIS*
━━━━━━━━━━━━━━━━━━━━
🆔 *Deposit ID:* ${depositOrderId}
👤 *Pelanggan:* ${customerName || messageObj?.pushName || 'Pelanggan'}
💸 *TOTAL YANG HARUS DIBAYAR:*
👉 *Rp${casakuPayment.totalAmount.toLocaleString('id-ID')}*
${casakuPayment.uniqueCode > 0 ? `_(Nominal top-up Rp${amount.toLocaleString('id-ID')} + kode unik Rp${casakuPayment.uniqueCode})_\n` : ''}
⏰ *Berlaku hingga:* ${expiredStr} WIB
━━━━━━━━━━━━━━━━━━━━

📱 *Scan QRIS di bawah untuk membayar:*
✅ DANA / GoPay / OVO / ShopeePay / BCA / BRI / Mandiri / dll.

🔄 *Saldo bertambah OTOMATIS setelah pembayaran terdeteksi.*
⚠️ *PENTING:* Transfer pas sebesar *Rp${casakuPayment.totalAmount.toLocaleString('id-ID')}*.`;

      if (qrImageBuffer) {
        await sock.sendMessage(responseJid, {
          image: qrImageBuffer,
          caption: depInvoice,
          mimetype: 'image/png'
        });
      } else {
        await sock.sendMessage(responseJid, { text: depInvoice });
      }

      await logToSystem('BALANCE', `💳 Top-up deposit Rp${amount.toLocaleString('id-ID')} diajukan oleh ${senderNumber} (${depositOrderId})`);
    } catch (depErr) {
      console.error('[DEPOSIT_ERR]', depErr.message);
      await sock.sendMessage(responseJid, { text: `❌ Gagal membuat QRIS Top Up: ${depErr.message}` });
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

Ketik *.list* atau *.produk* untuk melihat daftar produk toko kami!`;
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
  try { fs.appendFileSync('./tmp/trace.log', new Date().toISOString() + '  B-sampai-bagian-18  ' + JSON.stringify({ adaGambar: !!messageObj.message.imageMessage }) + '\n'); } catch (_) {}
  if (messageObj.message.imageMessage) {
    const lastOrder = await db.getCustomerLastOrder(senderNumber);
    try { fs.appendFileSync('./tmp/trace.log', new Date().toISOString() + '  C-lastOrder  ' + JSON.stringify({ order: lastOrder?.order_id || null, status: lastOrder?.status || null }) + '\n'); } catch (_) {}
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
// ==========================================
// LOGIKA PESAN GRUP (ADMIN GROUP / GET JID)

  // ==========================================
  // UTILITY & BUSINESS COMMANDS
  // ==========================================
    const groupSettings = isFromGroup ? await db.getGroupSettings(jid) : {};
  if (isFromGroup && (cleanCmd === 'rvo' || cleanCmd === 'readviewonce' || cleanCmd === 'viewonce') && groupSettings.features_config && groupSettings.features_config.rvo === false) return;
if (cleanCmd === 'rvo' || cleanCmd === 'readviewonce' || cleanCmd === 'viewonce') {
    const quotedMsg = messageObj.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quotedMsg) {
      await sock.sendMessage(jid, { text: '⚠️ Silakan balas (reply) pesan View Once dengan perintah .rvo' });
      return;
    }
    
    const viewOnceMsg = quotedMsg.viewOnceMessageV2?.message || quotedMsg.viewOnceMessageV2Extension?.message;
    if (!viewOnceMsg) {
      await sock.sendMessage(jid, { text: '⚠️ Pesan yang dibalas bukan pesan View Once (Sekali Lihat).' });
      return;
    }

    await react('⏳');
    try {
      const isImage = !!viewOnceMsg.imageMessage;
      const mediaMsg = isImage ? viewOnceMsg.imageMessage : viewOnceMsg.videoMessage;
      const stream = await downloadContentFromMessage(mediaMsg, isImage ? 'image' : 'video');
      
      let buffer = Buffer.from([]);
      for await(const chunk of stream) {
          buffer = Buffer.concat([buffer, chunk]);
      }

      const caption = mediaMsg.caption ? `📝 *Caption Asli:*\n${mediaMsg.caption}` : '';
      await sock.sendMessage(jid, 
        isImage ? { image: buffer, caption } : { video: buffer, caption }, 
        { quoted: messageObj }
      );
      await react('✅');
    } catch (err) {
      await sock.sendMessage(jid, { text: `❌ Gagal mengambil pesan View Once: ${err.message}` });
      await react('❌');
    }
    return;
  }

  if (cleanCmd === 'cekresi') {
    const kurir = args[1];
    const resi = args[2];
    if (!kurir || !resi) {
      await sock.sendMessage(jid, { text: '⚠️ Format salah. Gunakan: `.cekresi <kurir> <nomor_resi>`\nContoh: `.cekresi jnt JP1234567890`' });
      return;
    }
    await react('⏳');
    setTimeout(async () => {
      await sock.sendMessage(jid, { text: `📦 *STATUS PENGIRIMAN (MOCK)*\n\n*Kurir:* ${kurir.toUpperCase()}\n*Resi:* ${resi}\n*Status:* DELIVERED\n*Penerima:* Yth. Bp/Ibu\n*Tanggal:* ${new Date().toLocaleString('id-ID')}\n\n*(Catatan: Ini adalah data simulasi karena API Key asli belum dikonfigurasi)*` });
      await react('✅');
    }, 1500);
    return;
  }

  if (cleanCmd === 'removebg' || cleanCmd === 'rbg') {
    await react('⏳');
    setTimeout(async () => {
      await sock.sendMessage(jid, { text: `⚠️ *Fitur Belum Aktif*\nFitur hapus background membutuhkan konfigurasi API Key remove.bg. Hubungi owner untuk mengaktifkannya.` });
      await react('❌');
    }, 1000);
    return;
  }

  if (cleanCmd === 'tourl') {
    await react('⏳');
    setTimeout(async () => {
      await sock.sendMessage(jid, { text: `⚠️ *Fitur Belum Aktif*\nFitur ini sedang dalam penyesuaian API upload (Telegra.ph / ImgBB).` });
      await react('❌');
    }, 1000);
    return;
  }

    if (isFromGroup && (cleanCmd === 'lens' || cleanCmd === 'imagesearch') && groupSettings.features_config && groupSettings.features_config.lens === false) return;
if (cleanCmd === 'lens' || cleanCmd === 'imagesearch') {
    const quotedMedia = messageObj.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
    const directMedia = messageObj.message?.imageMessage;
    const hasImage = !!(quotedMedia || directMedia);

    if (!hasImage) {
      await sock.sendMessage(jid, { text: '⚠️ Kirim foto dengan caption `.lens` atau balas/reply sebuah foto dengan perintah `.lens` untuk mencari produk.' });
      return;
    }
    
    await react('⏳');
    setTimeout(async () => {
      await sock.sendMessage(jid, { text: `🔍 *HASIL PENCARIAN GOOGLE LENS (MOCK)*\n\nIni sepertinya adalah barang dari katalog kami: *Produk Terkait*\nJika Anda ingin membelinya, silakan ketik '.beli produk'\n\n_(Catatan: Fitur ini menggunakan MOCK karena API Key Lens belum tersedia)` }, { quoted: messageObj });
      await react('✅');
    }, 1500);
    return;
  }

    if (isFromGroup && cleanCmd === 'brat' && groupSettings.features_config && groupSettings.features_config.brat === false) return;
if (cleanCmd === 'brat') {
    const textToBrat = args.slice(1).join(' ');
    if (!textToBrat) {
      await sock.sendMessage(jid, { text: '⚠️ Format salah. Gunakan: `.brat <teks>`' });
      return;
    }
    await react('⏳');
    try {
      const { createCanvas } = await import('@napi-rs/canvas');
      const canvas = createCanvas(500, 500);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#8bc34a'; // brat green
      ctx.fillRect(0, 0, 500, 500);
      ctx.fillStyle = 'black';
      ctx.font = 'bold 50px "Arial"';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      const words = textToBrat.split(' ');
      let line = '';
      const lines = [];
      for (let i = 0; i < words.length; i++) {
        const testLine = line + words[i] + ' ';
        const metrics = ctx.measureText(testLine);
        if (metrics.width > 400 && i > 0) {
          lines.push(line);
          line = words[i] + ' ';
        } else {
          line = testLine;
        }
      }
      lines.push(line);
      
      const lineHeight = 60;
      const totalHeight = lines.length * lineHeight;
      let startY = (500 - totalHeight) / 2 + (lineHeight / 2);
      
      for (const l of lines) {
        ctx.fillText(l.trim(), 250, startY);
        startY += lineHeight;
      }
      
      const buffer = await canvas.encode('png');
      await sock.sendMessage(jid, { image: buffer, caption: 'Brat Summer ✨' }, { quoted: messageObj });
      await react('✅');
    } catch (err) {
      await sock.sendMessage(jid, { text: `⚠️ *Fitur Brat Gagal:* ${err.message}\n\nPastikan @napi-rs/canvas terinstall atau API generator brat aktif.` });
      await react('❌');
    }
    return;
  }

}

}
}