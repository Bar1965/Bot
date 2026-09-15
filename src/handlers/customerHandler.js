import * as db from '../../database.js';
import { config } from '../../config.js';
import { jidNormalizedUser, downloadMediaMessage, downloadContentFromMessage } from '@whiskeysockets/baileys';
import { createMidtransTransaction, botState } from '../../server.js';
import { buildCommandMenu, resolveCategoryId, kategoriDisembunyikanModeJualan } from '../../commandRegistry.js';
import { getSystemChangelog } from '../utils/changelog.js';
import { susunKatalog, susunHalamanProduk, kelompokkanPencarian, pesanNomorSalah, rupiah } from './katalogView.js';
import { uraiBalasanUlasan, susunTerimaKasihUlasan, susunDaftarTestimoni, barisRating } from './testimoni.js';
import { keWaktu, tanggalJamWib, tanggalWib, tanggalPanjangWib, jamWib, akhirHariWib } from '../utils/waktu.js';
import * as mediaHandler from '../../mediaHandler.js';
import * as ent from '../../entertainmentHandler.js';
import { sendInteractiveButtons } from '../../bot.js';
import fs from 'fs';
import path from 'path';

// In-Memory Nav Session untuk Quick Dial Angka & Alur Belanja Cepat (TTL 10 Menit)
const userNavSessions = new Map();

// Auto-cleanup userNavSessions setiap 5 menit
setInterval(() => {
  try {
    const now = Date.now();
    for (const [userJid, session] of userNavSessions.entries()) {
      if (now - session.updatedAt > 10 * 60 * 1000) {
        userNavSessions.delete(userJid);
      }
    }
  } catch (e) {}
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

/**
 * Membuang sesi navigasi. Dipanggil saat layar yang barusan dinomori ternyata
 * kosong — membiarkan sesi lama hidup berarti angka berikutnya yang diketik
 * pelanggan menunjuk daftar yang sudah tidak ada lagi.
 */
function hapusNavSession(userJid) {
  userNavSessions.delete(userJid);
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
    const textLower = (text || '').toLowerCase();
    const cleanText = (text || '').replace(/^[./#]/, '').trim();
    // `let`, bukan `const`: jalur pembelian instan (.buynow / `.beli KODE 1
    // langsung`) menugaskan ulang variabel ini menjadi 'checkout' supaya QRIS
    // langsung dibuat. Selama ini deklarasinya `const`, jadi baris itu SELALU
    // melempar "Assignment to constant variable" — dan melemparnya SESUDAH
    // addToCart berhasil. Barangnya masuk keranjang, lemparannya mendarat di
    // penangkap teratas bot.js yang cuma console.error, dan pelanggan tidak
    // menerima apa pun: tanpa QRIS, tanpa konfirmasi, tanpa pesan gagal.
    let cleanTextLower = textLower.replace(/^[./#]/, '').trim();
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
    // "0" berarti kembali ke katalog. Hanya berlaku saat sesi navigasi hidup,
    // supaya angka nol di percakapan biasa tetap diabaikan bot.
    const isBackDial = cleanText === '0';
    const hasNavSession = Boolean(getUserNavSession(senderNumber));

    // Foto tanpa caption dari pelanggan yang sedang punya tagihan adalah BUKTI
    // TRANSFER, dan gerbang prefix di bawah membuangnya.
    //
    // Bot sendiri yang menyuruhnya: pesan tagihan QRIS manual berbunyi "harap
    // kirimkan foto/screenshot *BUKTI TRANSFER* langsung ke chat ini". Pelanggan
    // menurut, mengirim tangkapan layar tanpa menulis apa-apa — dan karena
    // pesannya tidak diawali titik, handler ini pulang di baris berikutnya.
    // Bukti tidak tersimpan, pelanggan tidak dibalas, owner tidak diberi tahu,
    // dan blok penerima bukti di bawah tidak pernah tersentuh sekali pun.
    //
    // Pemeriksaan database hanya dijalankan untuk pesan bergambar tanpa perintah,
    // jadi tidak menambah beban pada percakapan biasa.
    // Balasan bintang untuk permintaan ulasan sesudah barang sampai: "5" atau
    // "5 cepet banget". Tiga pembatas sengaja dipasang ketat:
    //
    //   • hanya di JAPRI — angka telanjang di grup itu percakapan biasa, bukan
    //     rating, dan permintaan ulasannya memang dikirim ke japri;
    //   • hanya kalau TIDAK ada sesi navigasi katalog — saat pelanggan sedang
    //     membuka katalog, "1" berarti produk nomor satu;
    //   • hanya kalau memang ada pesanan terkirim yang belum diulas.
    //
    // Pemeriksaan database baru dijalankan sesudah dua syarat pertama lolos,
    // jadi obrolan biasa tidak menambah beban query.
    let pesananUntukDiulas = null;
    const bentukUlasan = !isPrefix && !isFromGroup && !hasNavSession
      && /^[1-5](?:[.,\s]+\S[\s\S]*)?$/.test(cleanText);
    if (bentukUlasan) {
      try {
        pesananUntukDiulas = await db.getPesananMenungguUlasan(senderNumber);
      } catch (_) {}
    }

    let fotoBuktiBayar = false;
    if (!isPrefix && messageObj?.message?.imageMessage) {
      try {
        const pesananTerakhir = await db.getCustomerLastOrder(senderNumber);
        fotoBuktiBayar = Boolean(pesananTerakhir && pesananTerakhir.status === 'WAITING_PAYMENT');
      } catch (_) {}
    }

    // STRICT PREFIX RULE: Hanya perbolehkan pesan ber-prefix atau angka dial saat sesi navigasi aktif
    if (!isPrefix && !((isNumericDial || isBackDial) && hasNavSession) && !fotoBuktiBayar && !pesananUntukDiulas) {
      return false;
    }

    // REGISTRATION CHECK
    const exemptCustomerCmds = [
      'daftar', 'register', 'registrasi', 'owner', 'kontakowner', 'menu', 'help', 'bantuan',
      'list', 'produk', 'katalog', 'listproduk', 'p', 'detail', 'info', 'lihat',
      // Testimoni boleh dibaca sebelum daftar: ini justru yang meyakinkan orang
      // untuk mendaftar, jadi mengunci layarnya di balik registrasi terbalik.
      'testi', 'testimoni', 'ulasan', 'rating',
      'update', 'changelog', 'patchnotes', 'whatsnew', 'pembaruan'
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
    // Perintah yang balasannya dikirim ke DM walau diketik di grup.
    //
    // Layar bersaldo WAJIB ada di sini. `.saldo` selama ini tidak terdaftar,
    // jadi mengetiknya di grup mencetak sisa saldo orang itu ke semua anggota —
    // begitu juga profil, yang memuat saldo, total belanja dan kode referralnya.
    // Itu informasi keuangan pribadi, bukan bahan obrolan grup.
    const isPrivateCommand =
      ['beli', 'buy', 'buynow'].includes(cleanCmd) ||
      ['cart', 'keranjang', 'checkout', 'bayar', 'cancel', 'batal', 'status', 'cekbayar', 'sudahbayar', 'riwayat', 'history'].includes(cleanCmd) ||
      ['me', 'aku', 'saya', 'saldo', 'profil', 'profile', 'akun', 'member', 'statusakun', 'deposit'].includes(cleanCmd);
    const responseJid = (isFromGroup && isPrivateCommand) ? senderNumber : jid;

    // Pemberitahuan "cek DM" untuk perintah yang balasannya dialihkan ke japri.
    //
    // Definisinya WAJIB berada di atas seluruh blok yang memanggilnya. `const`
    // punya temporal dead zone: memanggilnya dari baris yang dieksekusi lebih
    // dulu melempar ReferenceError, dan `node --check` tidak melihat apa pun
    // yang salah. Blok katalog di bawah memanggil fungsi ini, dan dulu ia
    // didefinisikan 270 baris lebih ke bawah.
    const sendRedirectNotice = async () => {
      if (isFromGroup && isPrivateCommand) {
        const mentionJid = senderNumber.split('@')[0];
        await sock.sendMessage(jid, {
          text: `⚠️ *Keamanan Transaksi:* Halo @${mentionJid}, demi keamanan informasi belanja & link pembayaran Anda, rincian transaksi telah kami kirimkan langsung ke *Chat Pribadi (DM)* Anda. Silakan periksa pesan masuk dari nomor bot ini.`,
          mentions: [senderNumber]
        });
      }
    };

    if (memberProfile?.account_status === 'BANNED' && !actor.isAdmin && !actor.isOwner) {
      await sock.sendMessage(jid, { text: '⛔ Akun kamu sedang diblokir dari layanan bot. Hubungi Owner jika merasa ini kesalahan.' });
      return true;
    }

    // ====================================================================
    // ⭐ BALASAN BINTANG — ULASAN SESUDAH BARANG SAMPAI
    // ====================================================================
    //
    // Ditangani SEBELUM blok katalog. Syaratnya sudah disaring di gerbang atas
    // (japri, tanpa sesi katalog, ada pesanan terkirim yang belum diulas), jadi
    // di sini tinggal menyimpannya.
    if (pesananUntukDiulas) {
      const urai = uraiBalasanUlasan(cleanText);
      if (urai) {
        try {
          await db.addReview(
            pesananUntukDiulas.order_id,
            senderNumber,
            urai.rating,
            urai.komentar,
            pesananUntukDiulas.produk_kode
          );
          await sock.sendMessage(responseJid, {
            text: susunTerimaKasihUlasan({ rating: urai.rating, komentar: urai.komentar })
          });

          // Rating rendah dikabarkan ke owner saat itu juga. Menunggu owner
          // membuka `.testi` sendiri berarti keluhan baru terbaca berhari-hari
          // kemudian, saat pembelinya sudah pergi.
          if (urai.rating <= 2) {
            try {
              const ownerJid = botSettings?.ownerJid || botSettings?.ownerNumber;
              if (ownerJid) {
                await sock.sendMessage(ownerJid, {
                  text: `⚠️ *ULASAN RENDAH*\n\n${'⭐'.repeat(urai.rating)} (${urai.rating}/5)\n📦 ${pesananUntukDiulas.nama_produk || pesananUntukDiulas.produk_kode || '-'}\n🧾 \`${pesananUntukDiulas.order_id}\`\n👤 ${senderNumber}\n${urai.komentar ? `\n_"${urai.komentar}"_` : ''}`
                });
              }
            } catch (_) {}
          }
        } catch (e) {
          await sock.sendMessage(responseJid, {
            text: '⚠️ Ulasannya gagal disimpan. Coba lagi sebentar lagi ya.'
          });
        }
        return true;
      }
    }

    // ====================================================================
    // 📦 KATALOG BERNOMOR
    // ====================================================================
    //
    // Dua layar saja, keduanya dinomori:
    //
    //   .list        -> layar KATALOG : satu baris per merek
    //   balas angka  -> layar PRODUK  : deskripsi + semua jenis/paket merek itu
    //   balas angka  -> masuk keranjang
    //   balas 0      -> kembali ke katalog
    //
    // Penyusun teksnya ada di katalogView.js supaya bisa diuji tanpa sesi
    // WhatsApp — lihat scripts/katalogSmokeTest.mjs.
    //
    // Yang berubah dari versi lama dan kenapa: dulu sesi navigasi menyimpan
    // NAMA MEREK, lalu balasan angka mencari ulang merek itu dengan
    // LIKE '%merek%'. Nomor yang ditekan pelanggan karena itu tidak terikat
    // pada barang yang barusan tampil — pencarian ulangnya bisa memulangkan
    // kumpulan yang berbeda. Sekarang sesi menyimpan KODE PRODUK persis, dan
    // menekan angka berarti mengambil kode di indeks itu.

    const batasStokTipis = botSettings.lowStockLimit || config.defaults.lowStockLimit;

    const emojiMerek = (merek) => {
      try {
        return (db.getBrandEmoji && merek) ? db.getBrandEmoji(merek) : '📦';
      } catch {
        return '📦';
      }
    };

    /** Layar 1 — daftar merek, satu baris masing-masing. */
    const tampilkanKatalog = async () => {
      const katalog = await db.getGroupedCatalog();
      const layar = susunKatalog(katalog, { batasTipis: batasStokTipis });

      if (layar.kosong) {
        hapusNavSession(senderNumber);
        await sock.sendMessage(responseJid, { text: layar.teks });
        return true;
      }

      setUserNavSession(senderNumber, { type: 'KATALOG', entri: layar.entri });

      await sendInteractiveButtons(sock, responseJid, {
        text: layar.teks,
        footer: 'Balas nomornya, atau ketik nama produk yang dicari',
        buttons: [
          { type: 'reply', text: 'Keranjang', id: '.keranjang' },
          { type: 'reply', text: 'Checkout', id: '.checkout' },
          { type: 'reply', text: 'Menu', id: '.menu' }
        ]
      });
      return true;
    };

    /** Layar 2 — deskripsi merek + seluruh jenis/paketnya, dinomori. */
    const tampilkanHalamanProduk = async (kodes, opts = {}) => {
      // Diambil ulang dari database supaya angka stoknya angka detik ini, bukan
      // angka saat katalog tadi disusun.
      const varian = await db.getProductsByKodes(kodes);
      const merek = String(opts.brand || varian[0]?.brand_category || varian[0]?.nama || '').trim();
      const ikon = opts.icon || emojiMerek(merek);

      // Rating merek ini, digabung dari seluruh paketnya. Gagalnya tidak boleh
      // membuat halaman produk ikut mati — tanpa bintang orang masih bisa belanja.
      let barisBintang = '';
      try {
        const peta = await db.getRatingProduk(varian.map(v => v.kode));
        let jumlah = 0;
        let bobot = 0;
        for (const nilai of peta.values()) {
          jumlah += nilai.jumlah;
          bobot += nilai.rataRata * nilai.jumlah;
        }
        if (jumlah > 0) barisBintang = barisRating(bobot / jumlah, jumlah);
      } catch (_) {}

      const layar = susunHalamanProduk(varian, {
        batasTipis: batasStokTipis,
        brand: merek,
        icon: ikon,
        barisRating: barisBintang
      });

      if (layar.kosong) {
        hapusNavSession(senderNumber);
        await sock.sendMessage(responseJid, { text: layar.teks });
        return true;
      }

      setUserNavSession(senderNumber, {
        type: 'PRODUK',
        brand: merek,
        icon: ikon,
        kodes: layar.kodes
      });

      const tombol = [];
      if (layar.adaStok) {
        tombol.push({ type: 'reply', text: 'Keranjang', id: '.keranjang' });
      } else {
        tombol.push({ type: 'reply', text: 'Notif restok', id: `.notif ${layar.kodes[0]}` });
      }
      tombol.push({ type: 'reply', text: 'Katalog', id: '.list' });

      await sendInteractiveButtons(sock, responseJid, {
        text: layar.teks,
        buttons: tombol
      });
      return true;
    };

    /** Masukkan satu kode ke keranjang, lalu balas konfirmasi pendek. */
    const masukkanKeKeranjang = async (kode) => {
      const hasil = await db.addToCart(senderNumber, kode, 1);
      if (!hasil.success) {
        await sock.sendMessage(responseJid, { text: `❌ ${hasil.message}` });
        await sendRedirectNotice();
        return true;
      }

      const labelFlash = hasil.isFlashSale ? ' _(harga flash sale)_' : '';
      const teks = `✅ *Masuk keranjang*\n🛍️ ${hasil.productName}\n💰 ${rupiah(hasil.subtotal)}${labelFlash}\n\n💡 Ketik \`.checkout\` untuk bayar sekarang.`;

      await sendInteractiveButtons(sock, responseJid, {
        text: teks,
        footer: 'Ketik checkout untuk langsung ke pembayaran',
        buttons: [
          { type: 'reply', text: 'Checkout', id: '.checkout' },
          { type: 'reply', text: 'Keranjang', id: '.keranjang' },
          { type: 'reply', text: 'Katalog', id: '.list' }
        ]
      });
      await sendRedirectNotice();
      return true;
    };

    // ====================================================================
    // 🔢 BALASAN ANGKA (1, 2, 3… dan 0 untuk kembali)
    // ====================================================================
    if (isNumericDial || isBackDial) {
      const navSession = getUserNavSession(senderNumber);

      if (navSession) {
        // "0" berarti kembali ke katalog, dari layar mana pun.
        if (isBackDial) return await tampilkanKatalog();

        const dialNum = parseInt(cleanText, 10);

        if (navSession.type === 'KATALOG') {
          const entri = Array.isArray(navSession.entri) ? navSession.entri : [];
          if (dialNum < 1 || dialNum > entri.length) {
            await sock.sendMessage(responseJid, { text: pesanNomorSalah(dialNum, entri.length) });
            return true;
          }
          const pilihan = entri[dialNum - 1];
          return await tampilkanHalamanProduk(pilihan.kodes, {
            brand: pilihan.brand,
            icon: pilihan.icon
          });
        }

        if (navSession.type === 'PRODUK') {
          const kodes = Array.isArray(navSession.kodes) ? navSession.kodes : [];
          if (dialNum < 1 || dialNum > kodes.length) {
            await sock.sendMessage(responseJid, { text: pesanNomorSalah(dialNum, kodes.length) });
            return true;
          }

          // Kodenya diambil dari indeks yang DISIMPAN, bukan dari hasil query
          // baru. Kalau owner menghapus produk lain selagi layar ini terbuka,
          // nomor yang ditekan pelanggan tetap menunjuk barang yang sama.
          const kode = kodes[dialNum - 1];
          const produk = await db.getProductByKode(kode);
          if (!produk) {
            await sock.sendMessage(responseJid, {
              text: `⚠️ Paket nomor *${dialNum}* sudah tidak tersedia.\n\nKetik \`.list\` untuk melihat katalog terbaru.`
            });
            return true;
          }
          return await masukkanKeKeranjang(produk.kode);
        }
      }
    }

    // --- FITUR CHANGELOG / CATATAN PEMBARUAN SISTEM ---
    if (['update', 'changelog', 'patchnotes', 'whatsnew', 'pembaruan'].includes(cleanCmd)) {
      await sock.sendMessage(responseJid, { text: getSystemChangelog() });
      return true;
    }

    if (['daftar', 'register', 'registrasi'].includes(cleanCmd)) {
      const requestedName = args.slice(1).join(' ').trim();
      if (!requestedName) {
        await sock.sendMessage(responseJid, { text: 'Format: `.daftar Nama Kamu`\nContoh: `.daftar Budi Santoso`' });
        return true;
      }

      // Cek apakah member sudah terdaftar sebelumnya
      const existingCustomer = await db.getCustomerMembershipProfile(senderNumber);
      const isAlreadyRegistered = existingCustomer && (
        Number(existingCustomer.profile_completed || 0) === 1 || 
        ['OWNER', 'ADMIN', 'MODERATOR'].includes(existingCustomer.role)
      );

      if (isAlreadyRegistered) {
        const senderMention = senderNumber.split('@')[0];
        const currentName = existingCustomer.nama || 'Pelanggan';
        const alreadyRegisteredMsg = `⚠️ *AKUN SUDAH TERDAFTAR* ⚠️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nHalo @${senderMention}! Anda sudah terdaftar sebagai member dengan nama: *${currentName}*.\n\nJika ingin mengubah nama profil Anda, silakan gunakan perintah:\n👉 \`.gantinama ${requestedName}\`\n\n_Contoh:_ \`.gantinama ${requestedName}\`\n_Atau ketik \`.profil\` untuk melihat profil akun kamu._`;
        
        await sendInteractiveButtons(sock, responseJid, {
          text: alreadyRegisteredMsg,
          mentions: [senderNumber],
          buttons: [
            { type: 'copy', text: `📋 Salin .gantinama ${requestedName}`, copy_code: `.gantinama ${requestedName}` },
            { id: '.profil', text: '👤 Lihat Profil' }
          ]
        });
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

  // `profile` digabung ke sini. Dulu `.profil` dan `.profile` adalah DUA layar
  // berbeda di dua berkas berbeda — beda satu huruf, beda isi — jadi pelanggan
  // yang mengetik `.profile` mengira melihat profil tokonya padahal mendapat
  // profil game.
  if (['profil', 'profile', 'akun', 'member', 'statusakun'].includes(cleanCmd)) {
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
    // Status BANNED memutus akses seseorang ke seluruh bot: dia tidak bisa lagi
    // membuka katalog, checkout, atau membalas apa pun. Gerbang lamanya cuma
    // `actor.isAdmin`, dan isAdmin bernilai `isOwner || isGroupAdmin || isStoreAdmin`
    // — jadi admin di grup WhatsApp MANA PUN yang bot ikuti, termasuk tiga grup
    // sewaan milik orang lain, bisa mem-BANNED akun pelanggan toko ini. Wewenang
    // atas data pelanggan harus datang dari toko, bukan dari status admin grup.
    if (!actor.isStoreAdmin && !actor.isOwner) {
      await sock.sendMessage(responseJid, { text: '⛔ Hanya *Admin Toko* atau *Owner* yang boleh mengubah status member. Status admin grup WhatsApp saja tidak cukup.' });
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

  // ==========================================
  // KARTU SINGKAT PELANGGAN (.me)
  // ==========================================
  // Layar yang paling sering diketik orang, jadi tugasnya satu: menjawab
  // "berapa uangku" dalam satu layar HP tanpa perlu di-scroll.
  //
  // Sebelumnya `.me` adalah alias `.poin` di src/games/index.js dan TIDAK
  // menampilkan rupiah sama sekali — pelanggan yang ingin mengecek depositnya
  // justru disuguhi level dan XP. Rinciannya tetap ada di `.dompet` (semua aset)
  // dan `.profil` (riwayat lengkap); yang ini sengaja dibuat pendek.
  if (['me', 'aku', 'saya'].includes(cleanCmd)) {
    const profil = await db.getCustomerMembershipProfile(senderNumber);
    const saldo = profil?.balance || 0;

    let tierPremium = null;
    try {
      tierPremium = await db.getPremiumTier(senderNumber);
    } catch (_) {}

    let kartu = `👤 *${customerName || messageObj?.pushName || 'Pelanggan'}*\n`;
    kartu += `━━━━━━━━━━━━━━━━━━\n`;
    kartu += `💳 *Saldo: Rp${saldo.toLocaleString('id-ID')}*\n`;

    const badgeTier = `🏅 Member ${profil?.tier || 'BRONZE'}`;
    kartu += tierPremium && tierPremium !== 'Free'
      ? `${badgeTier} · 👑 Premium ${tierPremium}\n`
      : `${badgeTier}\n`;

    // Pesanan yang masih menggantung ditampilkan di sini karena inilah yang
    // sebenarnya dicari orang saat membuka profilnya: "pesananku sampai mana".
    const pesanan = await db.getCustomerLastOrder(senderNumber);
    if (pesanan && ['CART', 'WAITING_PAYMENT', 'WAITING_CONFIRMATION', 'PAID'].includes(pesanan.status)) {
      const labelStatus = {
        CART: '🛒 Masih di keranjang',
        WAITING_PAYMENT: '⏳ Menunggu pembayaran',
        WAITING_CONFIRMATION: '🔍 Menunggu verifikasi admin',
        PAID: '📦 Sedang disiapkan'
      }[pesanan.status];
      kartu += `\n${labelStatus}\n`;
      kartu += `   \`${pesanan.order_id}\` — Rp${(pesanan.total || 0).toLocaleString('id-ID')}\n`;
    }

    kartu += `\n🪙 Akbar Poin: *${profil?.game_points || 0}*  ·  🎖️ Loyalty: *${profil?.loyalty_points || 0}*\n`;
    if (profil?.referral_code) {
      kartu += `🎁 Kode referral: \`${profil.referral_code}\`\n`;
    }
    kartu += `━━━━━━━━━━━━━━━━━━\n`;
    kartu += saldo > 0
      ? `_Saldo bisa langsung dipakai belanja — checkout tanpa scan QRIS._\n`
      : `_Isi saldo dengan_ \`.deposit 50rb\` _supaya checkout tidak perlu scan QRIS._\n`;
    kartu += `_Rincian lengkap:_ \`.dompet\`  ·  _Riwayat:_ \`.riwayat\``;

    await sock.sendMessage(responseJid, { text: kartu });
    await sendRedirectNotice();
    return;
  }



  // ==========================================
  // LOGIKA NAVIGASI MENU TERKATEGORI (ASCII ART DESIGN)
  // ==========================================
  // Daftar kategori yang sah dimiliki commandRegistry, BUKAN regex ini. Versi
  // lama menuliskan ulang alias-nya di sini dan ketinggalan: registry punya 9
  // kategori (1-9) tapi regex hanya menerima 1-6, sehingga `.menu 7` (pdf),
  // `.menu 8` (hiburan), `.menu 9` (admin), dan `.menu full` tidak cocok sama
  // sekali -> tidak ada balasan apa pun, padahal beranda menu sendiri
  // menyarankan nomor-nomor itu. Sekarang sufiks apa pun ditangkap dan
  // `resolveCategory` yang memutuskan; sufiks tak dikenal jatuh ke beranda menu.
  const menuMatch = cleanTextLower.match(/^(?:menu|help|bantuan)(?:\s+([a-z0-9]+))?$/i);

  if (menuMatch) {
    const subCat = menuMatch[1] ? menuMatch[1].toLowerCase() : '';

    // Deteksi mode grup (Sales Mode vs All Mode) + sakelar game per-grup
    let isSalesModeGroup = false;
    let gameDimatikan = false;
    if (isFromGroup) {
      const gSettings = await db.getGroupSettings(jid);
      if (gSettings.bot_mode === 'sales') {
        isSalesModeGroup = true;
      }
      gameDimatikan = (gSettings.features_config || {}).game === false;
    }

    // Percuma menampilkan katalog game kalau perintahnya memang sedang dikunci
    // admin lewat `.mode game off` — jelaskan sekalian cara menyalakannya.
    //
    // Kategorinya ditanyakan ke registry, TIDAK ditulis ulang di sini. Versi lama
    // menyalin daftar aliasnya sendiri dan ketinggalan: registry mengenal
    // 'gaming', 'arcade', 'play', 'mabar' dan 'permainan' sebagai alias game,
    // sementara salinan di sini cuma punya sebagian. Lihat AGENTS.md §12l.
    const kategoriDiminta = resolveCategoryId(subCat);

    if (gameDimatikan && kategoriDiminta === 'game') {
      await sock.sendMessage(responseJid, {
        text: "🚫 *GAME DIMATIKAN DI GRUP INI*\n\nAdmin grup sedang mematikan seluruh fitur game & hiburan di sini.\n\n_Admin dapat menyalakannya lagi dengan_ `.mode game on`"
      });
      return true;
    }

    // Daftar alias yang dulu berdiri di sini melenceng jauh lebih parah: ia
    // melewatkan 'gaming', 'arcade', 'play', 'mabar', 'permainan', 'tools',
    // 'download', 'alat', 'vip', 'ai', 'gemini', 'dokumen' dan 'ocr'. Mengetik
    // `.menu gaming` di grup jualan lolos dari penjaga ini, lalu buildCommandMenu
    // mengembalikan null karena kategorinya memang disembunyikan — dan bot
    // menjatuhkan pelanggan ke menu warisan yang tampilannya sama sekali berbeda.
    if (isSalesModeGroup && kategoriDisembunyikanModeJualan(kategoriDiminta)) {
      await sock.sendMessage(responseJid, { 
        text: "🛍️ *MODE JUALAN AKTIF:* Grup ini berada dalam *Mode Jualan/Toko*. Fitur media, downloader, dan game tidak diaktifkan di grup ini agar grup tetap tertib khusus jualan." 
      });
      return true;
    }

    const organizedMenu = buildCommandMenu(subCat || 'all', { salesMode: isSalesModeGroup });
    if (organizedMenu) {
      // Tombol navigasi disaring supaya tidak menawarkan kategori yang sedang
      // dibuka, dan saat berada di dalam kategori tombol pertama jadi jalan
      // pulang ke beranda menu.
      const kategoriAktif = kategoriDiminta;
      let quickButtons;

      if (isSalesModeGroup) {
        quickButtons = [
          { type: 'reply', text: '🛍️ Katalog Produk', id: '.list' },
          { type: 'reply', text: '🛒 Keranjang Saya', id: '.keranjang' },
          { type: 'reply', text: '🏆 Hadiah Harian', id: '.daily' }
        ];
      } else {
        const navigasi = [
          { type: 'reply', text: '🛍️ Produk', id: '.menu jualan', kategori: 'jualan' },
          { type: 'reply', text: '🎮 Game', id: '.menu game', kategori: 'game' },
          { type: 'reply', text: '📥 Media', id: '.menu media', kategori: 'media' },
          { type: 'reply', text: '🏆 Poin', id: '.menu reward', kategori: 'reward' }
        ].filter(b => b.kategori !== kategoriAktif);

        quickButtons = kategoriAktif
          ? [{ type: 'reply', text: '🏠 Menu Utama', id: '.menu' }, ...navigasi.slice(0, 2)]
          : navigasi.slice(0, 3);
      }

      await sendInteractiveButtons(sock, responseJid, {
        text: organizedMenu,
        buttons: quickButtons.map(({ type, text, id }) => ({ type, text, id }))
      });
      return true;
    }

    // Sampai di sini artinya buildCommandMenu mengembalikan null: sufiksnya
    // mengurai ke kategori yang tidak tampil di mode sekarang. Dua penjaga di
    // atas sudah menangkap kasus itu lewat registry, jadi baris ini tinggal
    // jaring pengaman — tampilkan beranda menu, jangan diam.
    //
    // Dulu di titik ini berdiri 333 baris menu tulisan tangan: beranda sendiri,
    // sembilan sub-menu, satu "MENU TOKO (MODE JUALAN)" dan satu "MENU FULL" —
    // salinan kedua dari seluruh daftar perintah toko, lengkap dengan daftar
    // aliasnya sendiri. Blok itu hanya bisa tampil lewat celah alias yang baru
    // ditutup di atas, tapi tetap ikut disunting tiap kali ada perintah baru,
    // dan isinya sudah lama berbeda dari commandRegistry: ia masih menjanjikan
    // `.checkout` sebagai "Link pembayaran QRIS/Midtrans" padahal sekarang yang
    // dikirim gambar QRIS Casaku. AGENTS.md §12l: registry satu-satunya pemilik
    // daftar perintah beserta aliasnya.
    await sendInteractiveButtons(sock, responseJid, {
      text: buildCommandMenu('all', { salesMode: isSalesModeGroup }),
      buttons: [
        { type: 'reply', text: '🛍️ Katalog Produk', id: '.list' },
        { type: 'reply', text: '🛒 Keranjang Saya', id: '.keranjang' },
        { type: 'reply', text: '🏆 Hadiah Harian', id: '.daily' }
      ]
    });
    return true;
  }

  // ====================================================================
  // 2A. CARI PRODUK LEWAT KATA KUNCI (.p netflix, .detail NET-SH-7D)
  // ====================================================================
  //
  // Pencariannya boleh kabur — orang mengetik "netflix", bukan kodenya. Tapi
  // hasilnya SELALU berakhir di layar yang sama dengan layar yang dibuka lewat
  // nomor, jadi bentuk layar toko cuma ada satu dan pelanggan tidak perlu
  // belajar dua cara membaca.
  const isDetailCmd = ['p', 'detail', 'info', 'lihat'].includes(cleanCmd) ||
    (['list', 'produk', 'katalog'].includes(cleanCmd) && args.length > 1);

  if (isDetailCmd) {
    const targetQuery = args.slice(1).join(' ').trim();

    if (targetQuery && !['ALL', 'PRODUK', 'BARANG', 'LIST', 'SEMUA'].includes(targetQuery.toUpperCase())) {
      const hasilVarian = await db.getProductVariants(targetQuery);
      let temuan = [];

      if (hasilVarian.exactProduct) {
        // Kode SKU persis. Yang ditampilkan tetap SELURUH paket satu mereknya,
        // supaya pelanggan yang cuma hafal satu kode tetap melihat pilihan
        // durasi dan jenis lain yang dijual toko.
        const sekeluarga = await db.getProductsByBrand(hasilVarian.exactProduct.brand_category);
        temuan = sekeluarga.length > 0 ? sekeluarga : [hasilVarian.exactProduct];
        if (!temuan.some(v => String(v.kode).toUpperCase() === String(hasilVarian.exactProduct.kode).toUpperCase())) {
          temuan = [hasilVarian.exactProduct, ...temuan];
        }
      } else if ((hasilVarian.variants || []).length > 0) {
        temuan = hasilVarian.variants;
      } else {
        temuan = (await db.searchProducts(targetQuery)) || [];
      }

      if (temuan.length > 0) {
        const grup = kelompokkanPencarian(temuan, db.getBrandEmoji);

        // Satu merek -> langsung buka halaman produknya. Beberapa merek ->
        // tampilkan daftar bernomor dulu, bukan menumpuk deskripsi merek yang
        // berbeda-beda dalam satu pesan.
        if (grup.length === 1) {
          return await tampilkanHalamanProduk(
            grup[0].variants.map(v => v.kode),
            { brand: grup[0].brand, icon: grup[0].icon }
          );
        }

        const layar = susunKatalog(grup, {
          batasTipis: batasStokTipis,
          judul: `🔎 *HASIL PENCARIAN "${targetQuery}"*`
        });
        setUserNavSession(senderNumber, { type: 'KATALOG', entri: layar.entri });
        await sendInteractiveButtons(sock, responseJid, {
          text: layar.teks,
          buttons: [
            { type: 'reply', text: 'Katalog', id: '.list' },
            { type: 'reply', text: 'Keranjang', id: '.keranjang' }
          ]
        });
        return true;
      }

      await sock.sendMessage(responseJid, {
        text: `❌ Tidak ada produk dengan kata kunci *${targetQuery}*.\n\nKetik \`.list\` untuk melihat katalog lengkap toko.`
      });
      return true;
    }
  }

  // ====================================================================
  // 2B. KATALOG (.list / .produk / .katalog)
  // ====================================================================
  if (
    ['list', 'produk', 'katalog', 'catalog', 'listproduk', 'daftarproduk', 'p', 'detail', 'info', 'lihat'].includes(cleanCmd) ||
    ['list', 'produk', 'katalog', 'list produk', 'list all', 'list barang'].includes(cleanTextLower)
  ) {
    return await tampilkanKatalog();
  }

  // ====================================================================
  // 2C. TESTIMONI (.testi / .ulasan / .review tanpa argumen)
  // ====================================================================
  //
  // Sengaja BUKAN perintah japri: ini bukti sosial, gunanya justru dibaca
  // ramai-ramai di grup. Yang tampil hanya ulasan yang betul-betul ditulis
  // pembeli — tidak ada satu baris pun yang dikarang bot.
  if (['testi', 'testimoni', 'ulasan', 'rating'].includes(cleanCmd)) {
    const [daftar, ringkas] = await Promise.all([
      db.getTestimoniTerbaru(10),
      db.getRingkasanTestimoni()
    ]);

    await sendInteractiveButtons(sock, responseJid, {
      text: susunDaftarTestimoni(daftar, { total: ringkas.jumlah, rataRata: ringkas.rataRata }),
      buttons: [
        { type: 'reply', text: 'Katalog', id: '.list' },
        { type: 'reply', text: 'Keranjang', id: '.keranjang' }
      ]
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

      const confirmMsg = `✅ *Masuk keranjang*
🛍️ ${item.nama}
💰 *Rp${item.harga.toLocaleString('id-ID')}* · kode \`${item.kode}\`

💡 Ketik \`.bayar\` untuk dapat QRIS tagihannya.`;

      await sendInteractiveButtons(sock, responseJid, {
        text: confirmMsg,
        // `title` dilepas: `confirmMsg` sudah membuka dengan kepalanya sendiri,
        // dan mengisi keduanya menumpuk dua kepala di satu pesan pendek.
        footer: 'Ketik bayar untuk langsung ke pembayaran',
        buttons: [
          { type: 'reply', text: 'Bayar', id: '.checkout' },
          { type: 'reply', text: 'Keranjang', id: '.keranjang' },
          { type: 'reply', text: 'Katalog', id: '.list' }
        ]
      });
      return true;
    }
  }

  // 3. BELI [KODE] [JUMLAH] / BUYNOW [KODE] [JUMLAH] (Beli Langsung 1-Klik)
  const buyRegex = /^(?:beli|buy|buynow)\s+([a-zA-Z0-9_-]+)(?:\s+(\d+))?(?:\s+(langsung|instant|now|fast))?$/i;
  if (buyRegex.test(cleanText)) {
    const match = cleanText.match(buyRegex);
    const code = match[1].toUpperCase();
    const isInstantCheckout = (cleanCmd === 'buynow' || !!match[3]);

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

    if (!isInstantCheckout) {
      const successMsg = `✅ *Masuk keranjang*
🛍️ ${res.productName} × ${res.qty}
💰 Subtotal *Rp${res.subtotal.toLocaleString('id-ID')}*

💡 Ketik \`.checkout\` untuk bayar sekarang.`;

      await sendInteractiveButtons(sock, responseJid, {
        text: successMsg,
        footer: 'Ketik checkout untuk langsung ke pembayaran',
        buttons: [
          { type: 'reply', text: 'Checkout', id: '.checkout' },
          { type: 'reply', text: 'Keranjang', id: '.keranjang' },
          { type: 'reply', text: 'Katalog', id: '.produk' }
        ]
      });
      await sendRedirectNotice();
      return;
    }

    // Jika isInstantCheckout = true, ubah cleanTextLower menjadi 'checkout' agar langsung mengeksekusi pembuatan QRIS!
    cleanTextLower = 'checkout';
  }

  // 4. KERANJANG / CART
  if (cleanTextLower === 'cart' || cleanTextLower === 'keranjang') {
    const cart = await db.getCartDetails(senderNumber);
    if (cart.items.length === 0) {
      await sendInteractiveButtons(sock, responseJid, {
        text: "🛒 *Keranjang belanja Anda masih kosong.*\nKetik `.produk` untuk melihat produk yang tersedia.",
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

    msg += `━━━━━━━━━━━━━━━━━━\n`;
    // Potongan HARUS terlihat. Tanpa baris-baris ini, jumlah item di atas tidak
    // pernah cocok dengan "Total Belanja" begitu ada kupon atau diskon premium,
    // dan pelanggan tidak punya cara tahu kenapa.
    if (cart.diskonKupon > 0 || cart.diskonPremium > 0) {
      msg += `Subtotal: Rp${cart.subtotal.toLocaleString('id-ID')}\n`;
      if (cart.diskonKupon > 0) {
        msg += `Kupon ${cart.kodeKupon || ''}: -Rp${cart.diskonKupon.toLocaleString('id-ID')}\n`;
      }
      if (cart.diskonPremium > 0) {
        msg += `Diskon premium: -Rp${cart.diskonPremium.toLocaleString('id-ID')}\n`;
      }
    }
    msg += `*Total Belanja:* *Rp${cart.total.toLocaleString('id-ID')}*
━━━━━━━━━━━━━━━━━━
Ketik \`.checkout\` untuk melanjutkan ke pembayaran, atau \`.batal\` untuk mengosongkan keranjang.`;

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

    // `.pay` pada keranjang yang BELUM di-checkout dulu langsung mencetak QRIS.
    // Itu melompati checkoutCart sepenuhnya: stok tidak pernah dipesan, diskon
    // premium dan kupon tidak pernah dihitung — padahal createCasakuTransaction
    // tetap menaikkan status order jadi WAITING_PAYMENT. Pembeli jadi membayar
    // barang yang stoknya tidak pernah disisihkan untuk dia.
    if (lastOrder && lastOrder.status === 'CART') {
      await sock.sendMessage(responseJid, {
        text: `🛒 *Keranjangmu belum di-checkout.*\n\nKetik \`checkout\` dulu — stok dikunci untukmu dan diskon dihitung di situ. QRIS tagihannya langsung muncul sesudahnya.`
      });
      await sendRedirectNotice();
      return;
    }

    if (lastOrder && lastOrder.status === 'WAITING_PAYMENT') {
      try {
        // Order ini mungkin SUDAH punya QRIS yang hidup. Dulu baris ini selalu
        // mencetak yang baru, dan itu menyisipkan baris payment_transactions
        // kedua sambil menelantarkan yang pertama. Karena setiap QRIS punya kode
        // uniknya sendiri (Rp1.127 vs Rp1.456), pembeli yang terlanjur men-scan
        // QR lama membayar nominal yang tidak lagi dicari rekonsiliasi: uangnya
        // keluar, ordernya tidak pernah lunas. Mengetik `.pay` dua kali adalah
        // hal paling wajar yang dilakukan pembeli yang menunggu.
        const masihHidup = lastOrder.casaku_transaction_id
          && lastOrder.qr_string
          && lastOrder.expired_at
          && Number(lastOrder.expired_at) > Date.now();

        let casakuPayment;
        if (masihHidup) {
          casakuPayment = {
            qrString: lastOrder.qr_string,
            totalAmount: lastOrder.payment_amount || lastOrder.total,
            uniqueCode: Math.max(0, (lastOrder.payment_amount || 0) - (lastOrder.total || 0)),
            expiredAt: Number(lastOrder.expired_at)
          };
        } else {
          const { createPayment } = await import('../payment/paymentService.js');
          casakuPayment = await createPayment(lastOrder.order_id, lastOrder.total);
        }

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

        const expiredStr = jamWib(casakuPayment.expiredAt);
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
${process.env.APP_URL ? `\n🌐 *Invoice & Checkout Online:*\n${process.env.APP_URL}/pay/${lastOrder.order_id}\n` : ''}
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
1. Ketik \`.list\` untuk melihat produk toko.
2. Ketik \`.beli [kode_produk]\` untuk memilih produk.
3. Ketik \`.checkout\` untuk memperoleh kode QRIS tagihan Anda!`;
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

    // Diskon premium harus TERLIHAT. Kalau potongannya diam-diam masuk ke total,
    // pelanggan yang membayar untuk benefit ini tidak punya cara tahu dia menerimanya.
    if (res.diskonPremium?.rupiah > 0) {
      await sock.sendMessage(responseJid, {
        text: `👑 *DISKON PREMIUM ${res.diskonPremium.tier.toUpperCase()} DIPAKAI*\n\n🏷️ Potongan *${res.diskonPremium.persen}%* — hemat *Rp${res.diskonPremium.rupiah.toLocaleString('id-ID')}*\n💸 Total setelah diskon: *Rp${order.total.toLocaleString('id-ID')}*`
      });
    }

    // ================================================================
    // INSTANT SALDO DEPOSIT CHECKOUT (Priority 1)
    // Jika saldo deposit mencukupi, bayar instan tanpa perlu QRIS
    // ================================================================
    // Potong saldo, tandai lunas, tebus kupon, buat job kirim dan beri poin —
    // SEMUANYA di satu transaksi di dalam settleOrderWithBalance. Dulu blok ini
    // melakukannya sendiri dalam TIGA transaksi terpisah, dan melewatkan
    // penebusan kupon sama sekali sehingga kupon sekali-pakai bisa dipakai tanpa
    // batas lewat jalur saldo.
    const custProfile = await db.getCustomerMembershipProfile(senderNumber);
    if ((custProfile?.balance || 0) >= order.total) {
      const lunas = await db.settleOrderWithBalance(senderNumber, order.order_id);
      if (lunas.success) {
        let successMsg = `✅ *PEMBAYARAN SALDO DEPOSIT BERHASIL!* ✅\n\n`;
        successMsg += `📦 *Order ID:* ${order.order_id}\n`;
        successMsg += `💸 *Total Dibayar:* Rp${lunas.total.toLocaleString('id-ID')}\n`;
        successMsg += `💳 *Sisa Saldo Deposit:* Rp${lunas.newBalance.toLocaleString('id-ID')}\n`;
        if (lunas.poin > 0) successMsg += `🪙 *Bonus Poin:* +${lunas.poin} Akbar Poin\n`;
        successMsg += `\n_Pesanan Anda berhasil dan produk digital sedang dikirimkan otomatis ke chat ini!_`;

        await sock.sendMessage(responseJid, { text: successMsg });
        await db.addLog('ORDER', `🛍️ Order #${order.order_id} dibayar lunas via Saldo Deposit oleh ${senderNumber}`);

        if (lunas.kuponHabis) {
          await db.addLog('ORDER', `⚠️ Kupon ${lunas.kuponKode} pada order ${order.order_id} ternyata sudah habis kuotanya, tetapi diskonnya sudah menempel pada total.`);
        }

        await sendRedirectNotice();
        return;
      }

      // Gagal melunaskan lewat saldo bukan alasan mendiamkan pelanggan. Dulu
      // blok ini hanya `if (deductRes.success)` tanpa cabang lain, jadi
      // kegagalannya jatuh diam-diam ke jalur QRIS tanpa satu pun catatan.
      await db.addLog('ORDER', `⚠️ Pelunasan saldo gagal untuk order ${order.order_id}: ${lunas.message}`);
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

        // Jalur ini jadi sering dilewati sejak opsi "Wajibkan Aplikasi Aktif"
        // dinyalakan di dashboard Casaku: begitu perangkat listener offline,
        // Casaku MENOLAK membuat transaksi. Itu perilaku yang benar — pembeli
        // tidak jadi mengirim uang yang tak akan pernah terdeteksi — tapi
        // penanganannya di sini dulu meninggalkan tiga masalah.
        //
        // (1) checkoutCart sudah berjalan sebelum baris ini, jadi stok SUDAH
        // dipesan dan order sudah WAITING_PAYMENT. Yang mengisi `expired_at`
        // adalah createCasakuTransaction — yang barusan gagal — sehingga kolom
        // itu NULL, dan penyapu 15 menit (`expired_at < ?`) tidak pernah cocok
        // dengan NULL. Stok baru bebas lewat penyapu 24 jam. Satu kredensial
        // AUTO terkunci sehari penuh hanya karena HP listener sempat mati.
        try {
          await db.updateOrderStatus(order.order_id, 'CANCELLED');
        } catch (batalErr) {
          console.error('[BOT] Gagal melepas order setelah QRIS gagal:', batalErr.message);
        }

        // (2) err.message dulu ditempelkan mentah ke pesan pembeli. Isinya
        // keadaan infrastruktur toko ("listener device offline"), bukan urusan
        // pembeli, dan tidak memberitahu dia hal yang benar-benar ingin dia tahu:
        // uangnya aman.
        await sock.sendMessage(responseJid, {
          text: `❌ *Pembayaran otomatis sedang tidak tersedia.*\n\nPesananmu belum jadi dan *tidak ada uang yang terpotong*. Stok sudah kami kembalikan.\n\n📌 Coba checkout lagi beberapa saat lagi, atau hubungi admin kalau tetap gagal.`
        });

        // (3) Owner tidak diberi tahu apa pun. Pembeli melihat pesan gagal,
        // owner mengira toko baik-baik saja, dan penjualan berhenti total tanpa
        // satu pun tanda — persis pola yang sudah pernah terjadi pada `.deposit`.
        try {
          const ownerJid = botSettings?.ownerJid || botSettings?.ownerNumber;
          if (ownerJid) {
            await sock.sendMessage(ownerJid, {
              text: `⚠️ *QRIS OTOMATIS GAGAL DIBUAT*\n\n` +
                    `🧾 Order: ${order.order_id}\n` +
                    `👤 Pelanggan: ${senderNumber}\n` +
                    `💸 Nominal: Rp${(order.total || 0).toLocaleString('id-ID')}\n\n` +
                    `Sebab: ${err.message}\n\n` +
                    `💡 Kalau sebabnya perangkat listener offline, buka aplikasi Casaku di HP dan pastikan tetap online.\n\n` +
                    `_Pesanan ini sudah dibatalkan otomatis dan stoknya dikembalikan, jadi tidak ada kredensial yang terkunci._`
            });
          }
        } catch (_) {}

        await logToSystem('PAYMENT', `❌ Gagal membuat QRIS Casaku untuk order ${order.order_id}: ${err.message}`);
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

      const expiredStr = jamWib(casakuPayment.expiredAt);

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
${process.env.APP_URL ? `\n🌐 *Invoice & Checkout Online:*\n${process.env.APP_URL}/pay/${order.order_id}\n` : ''}
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
        footer: 'Buka link pembayaran di atas untuk menyelesaikan transaksi',
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
    // Pemilih order yang SAMA dipakai di dua langkah ini. Dulu baris pertama
    // memakai getLastOrderByCustomer (pesanan terbaru) sedangkan
    // cancelActiveOrder memilih tanpa ORDER BY (biasanya yang terlama) — jadi
    // QRIS yang dibatalkan ke Casaku dan order yang dibatalkan di database bisa
    // berlainan, meninggalkan QRIS hidup untuk order yang sudah CANCELLED.
    const activeOrder = await db.getOrderUntukDibatalkan(senderNumber);
    let qrisMungkinHidup = false;
    if (activeOrder && activeOrder.casaku_transaction_id) {
      try {
        const { cancelPayment } = await import('../payment/paymentService.js');
        const hasilBatal = await cancelPayment(activeOrder.order_id, activeOrder.casaku_transaction_id);
        qrisMungkinHidup = hasilBatal && hasilBatal.ok === false;
      } catch (err) {
        qrisMungkinHidup = true;
      }
    }

    const res = await db.cancelActiveOrder(senderNumber);
    if (!res.success) {
      await sock.sendMessage(responseJid, { text: `⚠️ ${res.message}` });
      await sendRedirectNotice();
      return;
    }

    let pesanBatal = `✅ *Pesanan Anda (${res.orderId}) berhasil dibatalkan.*\nKeranjang/tagihan telah dikosongkan dan stok dikembalikan.`;
    // Kalau pembatalan ke Casaku gagal, QRIS lamanya mungkin MASIH bisa dibayar
    // dan uang itu tidak akan terdeteksi jalur mana pun. Pembeli harus tahu,
    // bukan cuma diberi tanda centang hijau.
    if (qrisMungkinHidup) {
      pesanBatal += `\n\n⚠️ *PENTING:* Kode QRIS lama Anda mungkin masih aktif. *Jangan* men-scan QR dari pesan sebelumnya — pembayarannya tidak akan terhubung ke pesanan ini. Silakan checkout ulang untuk mendapat QRIS baru.`;
    }
    await sock.sendMessage(responseJid, { text: pesanBatal });
    await logToSystem('ORDER', `❌ Order ID *${res.orderId}* dibatalkan oleh customer.`);
    await sendRedirectNotice();
    return;
  }


  // 7. STATUS & VERIFIKASI PEMBAYARAN INSTAN (.status / .cekbayar / .sudahbayar)
  if (['status', 'cekbayar', 'sudahbayar', 'cekstatus', 'konfirmasi'].includes(cleanCmd) || cleanTextLower === 'status') {
    const lastOrder = await db.getCustomerLastOrder(senderNumber);
    if (!lastOrder) {
      await sock.sendMessage(responseJid, { text: "Anda belum pernah melakukan pemesanan di toko kami." });
      await sendRedirectNotice();
      return;
    }

    // ⚡ ON-DEMAND RECONCILIATION:
    // Jika order masih menunggu pembayaran dan menggunakan Casaku QRIS, cek status bank secara real-time detik ini juga!
    let justConfirmedPaid = false;
    if (lastOrder.casaku_transaction_id && ['WAITING_PAYMENT', 'PENDING'].includes(lastOrder.status)) {
      try {
        const { reconcileSingleOrder } = await import('../payment/paymentService.js');
        const recResult = await reconcileSingleOrder(lastOrder.order_id);
        if (recResult.success && recResult.status === 'paid') {
          justConfirmedPaid = true;
          lastOrder.status = 'COMPLETED';
          lastOrder.payment_status = 'PAID';
        }
      } catch (recErr) {
        console.error('[STATUS_CHECK] Reconcile error:', recErr.message);
      }
    }

    const details = await db.getOrderDetails(lastOrder.order_id);
    let statusTranslate = details.status;
    
    switch (details.status) {
      case 'CART': statusTranslate = '🛒 Keranjang Belanja'; break;
      case 'WAITING_PAYMENT': statusTranslate = '⏳ Menunggu Pembayaran (Scan QRIS)'; break;
      case 'WAITING_CONFIRMATION': statusTranslate = '🔍 Menunggu Verifikasi Admin'; break;
      case 'PAID': statusTranslate = '🟢 Pembayaran Diterima (Sedang Mengirim Akun)'; break;
      case 'COMPLETED': statusTranslate = '✅ Selesai (Produk Terkirim)'; break;
      case 'CANCELLED': statusTranslate = '❌ Dibatalkan'; break;
    }

    let msg = `━━━━━━━━━━━━━━━━━━\n`;
    if (justConfirmedPaid) {
      msg += `🎉 *PEMBAYARAN TERDETEKSI & LUNAS!* 🎉\n`;
      msg += `Dana Anda telah berhasil diverifikasi oleh sistem. Kredensial digital Anda sedang dikirimkan ke chat ini!\n━━━━━━━━━━━━━━━━━━\n`;
    }
    msg += `📊 *STATUS PESANAN*\n━━━━━━━━━━━━━━━━━━\n`;
    msg += `Order ID: *${details.order_id}*\n`;
    msg += `Tanggal: ${tanggalJamWib(details.created_at)}\n`;
    msg += `Total: *Rp${details.total.toLocaleString('id-ID')}*\n`;
    msg += `Status: *${statusTranslate}*\n\n`;
    msg += `*Item yang dipesan:*\n`;

    details.items.forEach(item => {
      msg += `- ${item.produk_nama} (x${item.qty || item.jumlah || 1})\n`;
    });
    
    msg += `━━━━━━━━━━━━━━━━━━`;
    if (process.env.APP_URL) {
      msg += `\n🌐 *Invoice Web:* ${process.env.APP_URL}/pay/${details.order_id}\n━━━━━━━━━━━━━━━━━━`;
    }

    if (details.status === 'WAITING_PAYMENT') {
      msg += `\n\n💡 _Setelah transfer QRIS, sistem otomatis mendeteksi dalam hitungan detik. Untuk cek ulang status bank, ketik:_ \`.cekbayar\``;
    }

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

    // Perbandingan `!==` di sini dulu menolak pemilik pesanan yang sah. Mayoritas
    // baris `orders` tersimpan dengan JID `@lid` (pembeli menulis dari grup),
    // sementara pengirim yang sama di DM datang sebagai `628xxx@s.whatsapp.net`.
    // Dan pesan pengirimannya sendiri menyuruh mereka mengetik `.garansi <ORDER_ID>`
    // — jalur yang justru paling sering kena.
    const pemilikSah = targetOrder && await db.samaOrangnya(targetOrder.customer_nomor, senderNumber);
    if (!targetOrder || (!pemilikSah && !actor.isAdmin && !actor.isOwner)) {
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
    // Cadangan 30 hari dihitung dari created_at, yang tersimpan UTC tanpa penanda
    // zona — dibaca `new Date()` mentah, masa garansinya meleset 7 jam.
    const dibuatPada = keWaktu(targetOrder.created_at);
    const wUntil = targetOrder.warranty_until
      ? Number(targetOrder.warranty_until)
      : (dibuatPada ? dibuatPada.getTime() + 30 * 24 * 60 * 60 * 1000 : null);
    const isExpired = wUntil ? (now > wUntil) : false;
    const wDateStr = wUntil ? tanggalPanjangWib(wUntil) : "30 Hari sejak pembelian";

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
Jika Anda mengalami masalah (akun logout, batas layar, kredensial salah), silakan ketik langsung keluhan Anda di chat ini.`;
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
      msg += `\n   Status: ${o.status}\n   Tanggal: ${tanggalWib(o.created_at)}\n   Item: ${o.items_summary || '-'}\n\n`;
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
      await sock.sendMessage(responseJid, { text: `🔎 Tidak ditemukan produk dengan kata kunci "*${keyword}*".\nKetik \`.produk\` untuk melihat semua katalog.` });
      return;
    }
    let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔎 *HASIL PENCARIAN:* "${keyword}"\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    for (const p of results) {
      const stockLabel = p.stok === 0 ? '🔴 Habis' : p.stok <= 3 ? `🟡 Sisa ${p.stok}` : `🟢 ${p.stok} pcs`;
      msg += `📌 *${p.nama}* (\`${p.kode}\`)\n   Harga: *Rp${p.harga.toLocaleString('id-ID')}* | Stok: ${stockLabel}\n\n`;
    }
    msg += `Ketik \`.beli [KODE] [JUMLAH]\` untuk membeli.`;
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
    // keWaktu, bukan new Date() mentah. `coupons.expires_at` diisi sebagai
    // tanggal polos ("2026-12-31") dari `.addcoupon` maupun dari <input
    // type="date"> di dashboard, dan V8 membaca bentuk itu sebagai tengah malam
    // UTC — yaitu pukul 07.00 WIB. Kupon yang owner set berlaku "sampai 31 Des"
    // mati pukul 7 pagi di hari itu, sementara dashboard masih menampilkannya
    // aktif.
    const habisPada = akhirHariWib(coupon.expires_at);
    if (habisPada && habisPada.getTime() < Date.now()) {
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
    await sock.sendMessage(responseJid, { text: `✅ *Kupon ${code} berhasil diterapkan!*\n\n🏷️ Diskon: ${discountLabel}\n💰 Potongan: *-Rp${discount.toLocaleString('id-ID')}*\n🧾 Total setelah diskon: *Rp${(lastOrder.total - discount).toLocaleString('id-ID')}*\n\nKetik \`.checkout\` untuk melanjutkan pembayaran.` });
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
    // samaOrangnya, bukan ===. Orang yang sama tersimpan sebagai `@lid` saat
    // menulis di grup dan `628...@s.whatsapp.net` saat menulis di DM (AGENTS §9a:
    // 231 dari 236 pelanggan ber-@lid). Dengan perbandingan huruf, siapa pun bisa
    // mengambil kodenya sendiri lewat `.referral` di DM lalu memakainya di grup —
    // hitungan temannya naik untuk dirinya sendiri, dan tiap 3 hitungan
    // menerbitkan kupon diskon 10% yang asli.
    if (await db.samaOrangnya(referrer.nomor, senderNumber)) {
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

    // `stats.rewardsClaimed` menghitung BARIS REFERRAL yang sudah ditandai — yaitu
    // jumlah TEMAN, bukan jumlah kupon. Dulu angka itu langsung dikurangkan dari
    // `Math.floor(total / 3)` yang satuannya KUPON, jadi dua satuan berbeda diadu:
    //
    //   3 teman  -> berhak 1, tertandai 0 -> 1 kupon. claimReferralRewardCount
    //               lalu menandai 1 x 3 = 3 baris, sehingga claimed menjadi 3.
    //   6 teman  -> berhak 2, "claimed" 3 -> -1  -> TIDAK DAPAT APA-APA.
    //   9 teman  -> berhak 3, "claimed" 3 ->  0  -> TIDAK DAPAT APA-APA.
    //  12 teman  -> berhak 4, "claimed" 3 ->  1  -> baru dapat kupon kedua.
    //
    // Jadi janjinya "setiap 3 teman", kenyataannya kupon turun di teman ke-3, lalu
    // ke-12, lalu ke-21: satu kupon per SEMBILAN teman setelah yang pertama.
    // Diperbaiki dengan menyamakan satuan lebih dulu.
    const kuponSudahDiklaim = Math.floor(stats.rewardsClaimed / 3);
    const eligibleRewards = Math.floor(total / 3);
    const unclaimed = Math.max(0, eligibleRewards - kuponSudahDiklaim);

    let rewardStatusMsg = "";
    if (unclaimed > 0) {
      // Kalau seseorang berhak atas beberapa kupon sekaligus (misalnya baru
      // mengecek setelah mengajak 9 teman), semuanya diterbitkan — bukan satu saja.
      const kodeBaru = [];
      for (let i = 0; i < unclaimed; i++) {
        const kode = 'REF10-' + Math.random().toString(36).substring(2, 7).toUpperCase() + i;
        await db.addCoupon(kode, 'percent', 10, 0, 1, null);
        kodeBaru.push(kode);
      }
      await db.claimReferralRewardCount(senderNumber, unclaimed);
      const daftarKode = kodeBaru.map(k => `\`${k}\``).join('\n');
      rewardStatusMsg = `🎉 *SELAMAT! Anda telah mengundang ${total} teman!*\n\n🏷️ *KUPON DISKON 10% ANDA (${kodeBaru.length}x):*\n${daftarKode}\n💡 _Gunakan dengan mengetik:_ \`kupon <kode>\` _saat checkout!_\n\n`;
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
• Kupon Diskon Diklaim: *${kuponSudahDiklaim + unclaimed}x Kupon 10%*

💡 *Cara Menggunakan:*
Ajak teman Anda untuk mengetik \`.ref ${refCode}\` di chat ini. Setiap 3 teman yang diajak, Anda berhak mendapatkan 1 Kupon Diskon 10%!

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
    await sock.sendMessage(responseJid, { text: `💝 Produk *${p.nama}* (\`${code}\`) berhasil ditambahkan ke wishlist Anda!\nKetik \`.favorit\` untuk melihat daftar wishlist.` });
    return;
  }

  // 17. FAVORIT / WISHLIST
  if (cleanTextLower === 'favorit' || cleanTextLower === 'wishlist') {
    const items = await db.getWishlist(senderNumber);
    if (items.length === 0) {
      await sock.sendMessage(responseJid, { text: "💝 Wishlist Anda masih kosong.\nKetik `.simpan [KODE]` untuk menambahkan produk favorit." });
      return;
    }
    let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💝 *WISHLIST / FAVORIT ANDA*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    for (const item of items) {
      const stockLabel = item.stok === 0 ? '🔴 Habis' : `🟢 ${item.stok} pcs`;
      msg += `📌 *${item.nama}* (\`${item.produk_kode}\`)\n   Harga: *Rp${item.harga.toLocaleString('id-ID')}* | Stok: ${stockLabel}\n\n`;
    }
    msg += `Ketik \`.beli [KODE] [JUMLAH]\` untuk memesan.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
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
  // Polanya dulu `(\d+)`, jadi `.deposit 50rb` dan `.deposit 50.000` DITOLAK —
  // padahal `.price`, wizard `.tokobaru`, dan `.isisaldo` sama-sama menerima
  // bentuk itu. Satu toko tidak boleh punya dua aturan tentang cara menulis
  // rupiah. Sekarang teks nominalnya diambil utuh lalu diurai parser yang sama.
  const depositMatch = text.match(/^[\.\/#]?deposit\s+(.+)$/i);
  if (depositMatch) {
    const amount = db.parseHargaIndonesia(depositMatch[1]);
    if (amount === null) {
      await sock.sendMessage(responseJid, {
        text: "⚠️ *Nominal tidak terbaca.*\n\nBoleh ditulis `50000`, `50.000`, atau `50rb`.\n\n_Contoh:_ `.deposit 50rb`"
      });
      return;
    }
    if (amount < 5000) {
      await sock.sendMessage(responseJid, { text: "⚠️ *Nominal Minimal Deposit:* Rp5.000" });
      return;
    }
    // Dulu hanya ada batas bawah. Pola `(\d+)` menerima angka sepanjang apa pun,
    // jadi `.deposit 99999999999999999999` lolos: parseInt memulangkan 1e20 —
    // bukan bilangan bulat aman lagi — lalu nilai itu ditulis ke tabel orders
    // dan dikirim ke Casaku sebagai nominal QRIS. Batas atasnya disamakan dengan
    // yang sudah dipakai addProduct untuk harga produk, supaya satu toko tidak
    // punya dua aturan tentang berapa rupiah yang masuk akal.
    if (!Number.isSafeInteger(amount) || amount > 1_000_000_000) {
      await sock.sendMessage(responseJid, {
        text: "⚠️ *Nominal deposit terlalu besar.*\n\nMaksimal *Rp1.000.000.000* sekali top up. Kalau memang butuh lebih, hubungi admin."
      });
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

      const expiredStr = jamWib(casakuPayment.expiredAt);

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
      // Pesan mentahnya membocorkan urusan dalam ke chat pelanggan. Saat Casaku
      // belum dikonfigurasi, casakuProvider melempar teks yang menyebut nama
      // variabel .env apa adanya ("CASAKU_LICENSE_KEY atau CASAKU_QRIS_ID belum
      // dikonfigurasi di .env") — pelanggan melihat isi perut sistem, dan tetap
      // tidak tahu harus berbuat apa. Detail lengkapnya tetap masuk console+log.
      console.error('[DEPOSIT_ERR]', depErr.message);
      try {
        await db.addLog('ERROR', `Gagal membuat QRIS deposit untuk ${senderNumber}: ${depErr.message}`);
      } catch (_) {}
      await sock.sendMessage(responseJid, {
        text: `❌ *TOP UP SALDO BELUM BISA DIPROSES*\n\nPembayaran otomatis sedang tidak tersedia.\n\n📌 Silakan hubungi admin untuk top up manual, atau langsung *checkout* pesananmu — pembayaran QRIS manual tetap berjalan normal.`
      });

      // Owner harus tahu fitur ini mati; tanpa notifikasi, `.deposit` bisa gagal
      // 100% berbulan-bulan tanpa satu pun tanda.
      try {
        const ownerJid = botSettings?.ownerJid || botSettings?.ownerNumber;
        if (ownerJid) {
          await sock.sendMessage(ownerJid, {
            text: `⚠️ *FITUR .deposit GAGAL*\n\nPelanggan: ${senderNumber}\nNominal: Rp${amount.toLocaleString('id-ID')}\n\nSebab: ${depErr.message}`
          });
        }
      } catch (_) {}
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
    // Sama seperti `.garansi`: pembeli yang pesanannya tercatat sebagai `@lid`
    // tidak akan pernah lolos perbandingan huruf-per-huruf saat menulis dari DM.
    if (!orderObj || !(await db.samaOrangnya(orderObj.customer_nomor, senderNumber))) {
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
      const dateStr = tanggalJamWib(order.created_at);
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
      // ⚡ Jika pesanan dibuat menggunakan Casaku QRIS Dinamis, cek real-time terlebih dahulu!
      if (lastOrder.casaku_transaction_id) {
        try {
          const { reconcileSingleOrder } = await import('../payment/paymentService.js');
          const rec = await reconcileSingleOrder(lastOrder.order_id);
          if (rec.success && rec.status === 'paid') {
            await sock.sendMessage(jid, {
              text: `✅ *PEMBAYARAN QRIS TERDETEKSI & TERVERIFIKASI OTOMATIS!* 🎉\n\nDana Anda sudah terkonfirmasi di sistem bank. Pesanan *${lastOrder.order_id}* sedang diproses dan produk digital akan segera dikirimkan ke chat ini.`
            });
            return;
          }
        } catch (e) {
          console.error('[RECEIPT_CHECK] Error checking Casaku status on image receipt:', e.message);
        }
      }

      console.log('Bukti pembayaran terdeteksi. Mengunduh media...');
      const buffer = await downloadMediaMessage(messageObj, 'buffer', {});

      // Buat struktur direktori bertingkat YYYY/MM. Dibaca lewat keWaktu supaya
      // bukti transfer pesanan dini hari tidak jatuh ke folder bulan sebelumnya
      // (created_at tersimpan UTC, dan pergeseran 7 jam melewati batas bulan).
      const date = keWaktu(lastOrder.created_at) || new Date();
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