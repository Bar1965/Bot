import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import * as db from '../../database.js';
import { config } from '../../config.js';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { createMidtransTransaction, botState } from '../../server.js';
import { buildCommandMenu } from '../../commandRegistry.js';
import * as mediaHandler from '../../mediaHandler.js';
import * as ent from '../../entertainmentHandler.js';
import { sendInteractiveButtons, extractTargetJid, parseDuration, logToSystem, broadcastTagAll, triggerRestockBroadcast, checkAndNotifySubscribers, getCachedGroupMetadata } from '../../bot.js';
import { backupDatabase } from '../../scheduler.js';
import { adalahJidBot } from '../utils/botIdentity.js';
import { perisaiTarget } from '../utils/perisaiTarget.js';
import { mulaiWizardProduk, simpanGambarProduk } from './storeWizard.js';
import { handleSaldoOwner } from './saldoAdmin.js';
import { penutupGaransi } from '../utils/pesanGaransi.js';
import { tanggalWib, jamWib } from '../utils/waktu.js';

export function createGroupAdminHandler(ctx) {
    const { sock, userPushNamesMap, messageCache, formatPhoneNumber, react, sendInteractiveButtons } = ctx;
    let botSettings = ctx.botSettings || {};

    return async function handleGroupMessage(jid, senderNumber, messageObj, text, isGroupAdminParam, isPrefixCmd, actor = {}) {
  // STRICT RULE: Semua perintah WAJIB diawali prefix . / # (TIDAK ADA perintah tanpa prefix)
  const isPrefix = isPrefixCmd !== undefined 
    ? isPrefixCmd 
    : (text?.trim().startsWith('.') || text?.trim().startsWith('/') || text?.trim().startsWith('#'));
  if (!isPrefix) return false;

  const isGroup = jid.endsWith('@g.us');
  const m = messageObj;
  const senderCleanJid = jidNormalizedUser(senderNumber);
  const senderNormalized = senderCleanJid;
  const args = (text || '').trim().split(/\s+/);
  const rawCmd = (args[0] || '').toLowerCase();
  const cleanCmd = rawCmd.replace(/^[./#]/, '');

  const adminStoreCommands = [
    // `acc`, `terima`, `konfirmasi` dan `selesai` sudah lama dirujuk di bawah
    // (baris ~1656 dan ~1770) tapi tidak pernah ada di daftar ini, sehingga
    // gerbang di baris 66 memulangkannya lebih dulu: keempatnya mati. Pesan
    // bantuan `.paid` sendiri menyuruh admin memakai `.acc`.
    //
    // `batal` SENGAJA tidak ditambahkan: itu perintah pelanggan untuk
    // membatalkan pesanannya sendiri, dan memasukkannya ke sini akan membajak
    // `.batal` milik owner saat ia berbelanja sebagai pelanggan biasa.
    'paid', 'acc', 'terima', 'konfirmasi', 'done', 'selesai', 'cancel', 'kirimulang', 'ulangkirim', 'retry', 'flashsale', 'stats', 'broadcast', 'addcoupon', 
    'delcoupon', 'listcoupon', 'addfaq', 'delfaq', 'listfaq', 'laporan', 
    'restock', 'stock', 'price', 'out', 'ready', 'addproduct', 'takeover', 
    'release', 'setname', 'setowner', 'eval', 'exec', 'backup', 'resetleaderboard',
    'addstock', 'tambahstok', 'cekstok', 'liststock', 'delstock', 'setdelivery', 'listproduk', 'katalogadmin', 'stokyatim',
    'addproduk', 'editproduk', 'ubahproduk', 'delproduk', 'hapusproduk', 'setgambar', 'tokobaru', 'produkbaru',
    // Saldo deposit — gerbang sesungguhnya ada di saldoAdmin.js dan HANYA owner
    // yang lolos. Didaftarkan di sini supaya perintahnya sampai ke handler;
    // kalau bukan owner, saldoAdmin yang menolaknya.
    'isisaldo', 'tambahsaldo', 'tariksaldo', 'ceksaldo', 'totalsaldo', 'saldook'
  ];

  const groupModerationCommands = [
    'add', 'kick', 'promote', 'demote', 'group', 'link', 'tagall', 'hidetag', 
    // 'all' dan 'semua' disebut di blok mention massal (:1481) tapi dulu tidak
    // pernah ada di daftar ini, jadi gerbang di :56 memulangkannya lebih dulu dan
    // keduanya mati untuk SEMUA ORANG termasuk admin. Kondisi yang menyebut sebuah
    // perintah tidak membuatnya bisa dijangkau.
    'everyone', 'all', 'semua', 'admins', 'mode', 'setmode', 'botmode', 'antilink', 'setantilink', 'globalantilink', 'welcome', 
    'autowelcomeswitch', 'setwelcome', 'setupdategroup', 'testupdate', 'autosholat', 'levelup', 'autolevelup',
    'globallevelup', 'setlevelup', 'fitur', 'open', 'close', 'del', 'delete', 'totalchat', 'ceksewabot', 'sponsor',
    'textwelcome', 'textleave',
    'autodl', 'autodownload', 'listfitur', 'fiturgrup', 'groupfeatures'
  ];

  const banCommands = ['ban', 'unban', 'unwarn', 'cekwarn', 'addmod', 'delmod', 'listmod', 'setownerid', 'join', 'antidelete'];

  // Perintah yang boleh dijalankan Moderator Bot (hasil `.addmod`) dan HANYA itu.
  // Daftar ini harus selalu cocok dengan janji yang ditulis `.addmod` ke layar.
  const perintahModerator = ['ban', 'unban', 'unwarn', 'cekwarn'];

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
  const storedOwnerJid = jidNormalizedUser((botSettings.ownerJid || '').trim());
  const senderDigits = cleanDigits(senderCleanJid);
  const jidDigits = cleanDigits(jid);

  // Cek Moderator dari DB
  const isMod = await db.isModerator(senderCleanJid);

  let isOwner = !!(actor && actor.isOwner) || !!m.key?.fromMe;
  let isGroupAdmin = !!(actor && actor.isAdmin) || !!isGroupAdminParam;

  if (isGroup && !isOwner) {
    try {
      const groupMeta = (typeof getCachedGroupMetadata === 'function' ? await getCachedGroupMetadata(sock, jid) : null) || await sock.groupMetadata(jid);
      const pMatch = groupMeta?.participants?.find(p => {
        const pCleanId = jidNormalizedUser(p.id);
        const pCleanLid = p.lid ? jidNormalizedUser(p.lid) : null;
        return pCleanId === senderCleanJid || pCleanLid === senderCleanJid ||
               (p.id && senderCleanJid.includes(p.id.split('@')[0])) ||
               (p.lid && senderCleanJid.includes(p.lid.split('@')[0]));
      });
      if (pMatch) {
        if (pMatch.admin === 'admin' || pMatch.admin === 'superadmin') {
          isGroupAdmin = true;
        }
        const pPhone = cleanDigits(pMatch.id);
        if (ownerPhoneNum && pPhone && (pPhone === ownerPhoneNum || pPhone.endsWith(ownerPhoneNum) || ownerPhoneNum.endsWith(pPhone))) {
          isOwner = true;
        }
      }
    } catch (e) {}
  }

  if (!isOwner) {
    isOwner = !!(storedOwnerJid && (senderCleanJid === storedOwnerJid || senderCleanJid.includes(storedOwnerJid.split('@')[0]) || storedOwnerJid.includes(senderCleanJid.split('@')[0]))) ||
              !!(ownerPhoneNum && senderDigits && (ownerPhoneNum === senderDigits || senderDigits.endsWith(ownerPhoneNum) || ownerPhoneNum.endsWith(senderDigits))) ||
              !!(!isGroup && ownerPhoneNum && jidDigits && (ownerPhoneNum === jidDigits || jidDigits.endsWith(ownerPhoneNum)));
  }

  const adminList = (botSettings.adminNumbers || config.defaults.adminNumbers || '').split(',').map(n => cleanDigits(n));

  // `isMod` sengaja TIDAK lagi ikut ke isAdminStore.
  //
  // `.addmod` menulis di layar: "Dia sekarang bisa menggunakan .ban dan .unban".
  // Kenyataannya baris ini dulu berbunyi `isOwner || isMod || adminList...`, jadi
  // satu `.addmod` diam-diam memberikan SELURUH wewenang Admin Toko: `.paid`
  // (mengirim lisensi Rp150.000 gratis — termasuk ke ordernya sendiri), `.price`,
  // `.stock`, `.broadcast` ke seluruh pelanggan, dan `.eval` yang menjalankan kode
  // apa pun di komputer ini. Moderator sekarang benar-benar hanya bisa perintah
  // moderasi yang dijanjikan.
  let isAdminStore = isOwner || adminList.some(adm => adm && (senderDigits === adm || senderDigits.endsWith(adm) || adm.endsWith(senderDigits)));
  let isModeratorBot = isMod;

  if (!isOwner || !isAdminStore) {
    try {
      const custRow = await db.getQuery("SELECT role FROM customers WHERE nomor = ? OR nomor = ?", [senderCleanJid, senderNormalized]);
      if (custRow?.role === 'OWNER') isOwner = true;
      else if (custRow?.role === 'ADMIN') isAdminStore = true;
      else if (custRow?.role === 'MODERATOR') isModeratorBot = true;
    } catch (e) {}
  }

  const isAdminUser = isAdminStore || isGroupAdmin || isOwner;

  // Jika bukan Admin/Owner, tolak perintah — kecuali Moderator Bot yang sedang
  // menjalankan salah satu perintah moderasi yang memang menjadi haknya.
  if (!isAdminUser && !isOwner && !(isModeratorBot && perintahModerator.includes(cleanCmd))) {
    return false;
  }

  // 🔒 Guard Grup Admin ACC khusus untuk perintah transaksi toko
  // Saldo ditangani paling awal di antara perintah toko: modulnya punya
  // pemeriksaan owner sendiri yang lebih ketat daripada `isOwner` di berkas ini
  // (yang melonggarkan diri dengan .includes() pada potongan JID — cukup untuk
  // membuka menu, tidak cukup untuk mencetak uang).
  if (['isisaldo', 'tambahsaldo', 'tariksaldo', 'ceksaldo', 'totalsaldo', 'saldook'].includes(cleanCmd)) {
    // extractTargetJid SENGAJA tidak dipakai di sini. Helper itu merakit
    // `<digit>@s.whatsapp.net` dari nomor yang diketik — bentuk yang tidak
    // dimiliki 231 dari 236 pelanggan toko ini, dan yang lolos begitu saja dari
    // resolveTargetJid karena string apa pun bermuatan '@' dianggap JID sah.
    // Digabung, itu berarti saldo bisa masuk ke akun hantu sambil bot membalas
    // "berhasil".
    //
    // Yang dipakai hanya JID yang datang LANGSUNG dari WhatsApp — participant
    // pesan yang dibalas, atau mention. Dua-duanya otoritatif, bukan tebakan.
    const konteksSaldo = m.message?.extendedTextMessage?.contextInfo;
    const jidOtoritatif = konteksSaldo?.participant
      || (Array.isArray(konteksSaldo?.mentionedJid) ? konteksSaldo.mentionedJid[0] : null);

    // Aturannya satu kalimat: kalau owner mengetik nomornya, itu yang dipakai;
    // kalau tidak, barulah JID dari balasan/mention. Tidak ada tebak-menebak.
    const adaTargetDiketik = Boolean(args[1]);
    const argsSaldo = adaTargetDiketik
      ? args
      : (jidOtoritatif ? [args[0], jidOtoritatif, ...args.slice(1)] : args);

    return await handleSaldoOwner({
      sock,
      jid,
      senderNumber: senderNormalized,
      args: argsSaldo,
      cleanCmd
    });
  }

  if (adminStoreCommands.includes(cleanCmd)) {
    // Perintah toko & uang (.paid, .price, .stock, .addproduct, .addcoupon, dll) wajib identitas
    // Admin Toko atau Owner. Status admin grup WhatsApp SAJA tidak cukup — kalau tidak, siapa pun
    // yang jadi admin di grup mana pun yang bot ikuti bisa mengirim produk gratis lewat .paid.
    // actor.isStoreAdmin berasal dari bot.js, yang sudah meresolusi pengirim @lid menjadi nomor HP
    // lewat metadata grup SEBELUM mencocokkannya ke adminNumbers. Perhitungan isAdminStore di file ini
    // tidak melakukan resolusi itu, jadi tanpa sinyal dari bot.js setiap Admin Toko yang mengirim
    // pesan sebagai @lid akan terkunci dari perintahnya sendiri.
    const isStoreAdminResolved = isAdminStore || !!(actor && actor.isStoreAdmin);
    if (!isStoreAdminResolved && !isOwner) {
      // 'cancel' juga milik handler pelanggan (batalkan order sendiri). Admin grup yang kebetulan
      // pelanggan biasa harus tetap bisa memakainya, jadi khusus itu diteruskan ke bawah.
      if (cleanCmd === 'cancel') return false;
      // Kirim penolakan tanpa await yang bisa menggagalkan seluruh batch pesan: sock.sendMessage
      // di sini adalah antrean safeSendMessage yang bisa reject setelah 3 kali gagal kirim.
      try {
        await sock.sendMessage(jid, { text: "❌ Perintah ini khusus *Admin Toko* atau *Owner*. Status admin grup WhatsApp saja tidak cukup." }, { quoted: m });
      } catch (e) {
        console.error('[ADMIN_GUARD] Gagal mengirim pesan penolakan:', e.message);
      }
      return true;
    }
    // CATATAN: transactionGroupId sengaja TIDAK dimasukkan ke rantai ini. Guard lokasi di bawah
    // berlaku untuk seluruh 27 adminStoreCommands — termasuk .eval/.backup/.broadcast/.stats —
    // sehingga mengaktifkannya akan membuat perintah Owner diam-diam mati di grup lain.
    const adminGroupId = botSettings.adminGroupId || botSettings.transactionLogGroupId || "";
    if (adminGroupId && isGroup && jid !== adminGroupId) {
      // Diam / tidak merespons perintah admin yang salah tempat agar tidak spam grup
      return true;
    }
  }

    if (cleanCmd === 'resetleaderboard') {
      // Perintah paling merusak di seluruh bot: mode `total` menolkan seluruh poin,
      // XP, level, dan streak setiap member terdaftar sekaligus.
      //
      // Gerbang lamanya `!isOwner && !isAdminUser`, sementara isAdminUser (:150)
      // bernilai `isAdminStore || isGroupAdmin || isOwner` — jadi ADMIN GRUP
      // WHATSAPP BIASA pun lolos. Penjaga lokasi di :183 juga mati karena membaca
      // `adminGroupId`/`transactionLogGroupId` yang tidak ada di tabel settings,
      // sehingga perintah ini hidup di semua grup. Sekarang: Owner saja, wajib
      // menyebut mode, dan wajib konfirmasi dengan token setelah melihat angkanya.
      if (!isOwner) {
        await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh *Owner* bot." });
        return true;
      }

      const modeMinta = (args[1] || '').toLowerCase();
      const konfirmasi = (args[2] || '').toUpperCase();
      const pra = await db.pratinjauResetLeaderboard();
      const fmt = (v) => Number(v || 0).toLocaleString('id-ID');

      if (modeMinta !== 'bersih' && modeMinta !== 'total') {
        await sock.sendMessage(jid, { text:
          `⚠️ *RESET PAPAN PERINGKAT — PILIH MODE DULU*\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `📊 *Kondisi sekarang:*\n` +
          `▫️ Profil belum \`.daftar\`: *${fmt(pra.akanDihapus)}*\n` +
          `▫️ Member terdaftar: *${fmt(pra.akanDinolkan)}*\n` +
          `▫️ Poin dompet member terdaftar: *${fmt(pra.poinHilang)}*\n` +
          `▫️ XP member terdaftar: *${fmt(pra.xpHilang)}*\n\n` +
          `*1. \`.resetleaderboard bersih YA\`*\n` +
          `Menghapus *${fmt(pra.akanDihapus)} profil* milik user yang belum \`.daftar\`. ` +
          `Member terdaftar TIDAK disentuh sama sekali.\n\n` +
          `*2. \`.resetleaderboard total YA\`* ☢️\n` +
          `Melakukan poin 1, LALU menolkan poin, XP, level, dan streak *${fmt(pra.akanDinolkan)} member terdaftar* ` +
          `— *${fmt(pra.poinHilang)} poin* dan *${fmt(pra.xpHilang)} XP* hilang permanen.\n` +
          `_Saldo bank (${fmt(pra.bankTetap)} poin) tidak ikut dinolkan._\n\n` +
          `❗ Tidak ada tombol undo. Ambil backup dulu dengan \`.backup\` kalau ragu.` });
        return true;
      }

      if (konfirmasi !== 'YA') {
        const ringkas = modeMinta === 'total'
          ? `menghapus *${fmt(pra.akanDihapus)} profil* DAN menolkan *${fmt(pra.akanDinolkan)} member terdaftar* (*${fmt(pra.poinHilang)} poin* + *${fmt(pra.xpHilang)} XP* hilang permanen)`
          : `menghapus *${fmt(pra.akanDihapus)} profil* milik user yang belum \`.daftar\``;
        await sock.sendMessage(jid, { text:
          `⚠️ *KONFIRMASI DIPERLUKAN*\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `Kamu akan ${ringkas}.\n\n` +
          `Kalau yakin, ketik ulang persis:\n\`.resetleaderboard ${modeMinta} YA\`` });
        return true;
      }

      const res = await db.resetGameLeaderboard(modeMinta);
      const teks = res.mode === 'total'
        ? `☢️ *RESET TOTAL SELESAI*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🗑️ Profil belum terdaftar dihapus: *${fmt(res.dihapus)}*\n♻️ Member terdaftar dinolkan: *${fmt(res.dinolkan)}*\n\n_Poin, XP, level, dan streak mereka kembali ke nol. Saldo bank tidak ikut dinolkan._`
        : `🧹 *PEMBERSIHAN SELESAI*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🗑️ Profil belum terdaftar dihapus: *${fmt(res.dihapus)}*\n\n_Poin dan level member terdaftar tidak disentuh. Hanya member yang sudah_ \`.daftar\` _yang bisa mengumpulkan poin dan masuk papan peringkat._`;
      await sock.sendMessage(jid, { text: teks });
      return true;
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
      
      // Murni mengecek apakah sender adalah Owner yang sah berdasarkan nomor di config.js (.env)
      if (!isOwner && !m.key?.fromMe) {
        await sock.sendMessage(jid, { text: `❌ Akses ditolak. Hanya nomor Owner di config.js yang dapat mengatur JID secara dinamis.` });
        return true;
      }

      await db.updateSettings({ ownerJid: senderNormalized });
      Object.assign(botSettings, await db.getSettings());
      await sock.sendMessage(jid, { text: `✅ *Owner JID Berhasil Didaftarkan!*

🆔 JID Tersimpan: \`${senderNormalized}\`

Sekarang Anda akan dikenali sebagai Owner di semua grup meskipun menggunakan sistem @lid WhatsApp terbaru. 🎉` });
      return true;
    }

    // .antidelete — Toggle fitur Rewind/Anti-Delete Pesan
    if (cleanCmd === 'antidelete') {
      if (!isOwner) {
        await sock.sendMessage(jid, { text: `❌ Akses ditolak. Hanya Owner yang bisa menggunakan fitur ini.` });
        return true;
      }
      
      const currentAntiDelete = botSettings.antiDelete === 'true' || botSettings.antiDelete === true;
      const newStatus = !currentAntiDelete;
      
      await db.updateSettings({ antiDelete: newStatus.toString() });
      Object.assign(botSettings, await db.getSettings()); // Reload config
      
      const statusText = newStatus ? "✅ *AKTIF*" : "❌ *NONAKTIF*";
      await sock.sendMessage(jid, { text: `Fitur *Anti-Delete (Rewind)* sekarang ${statusText}.\n\nJika aktif, bot akan menangkap pesan yang dihapus oleh pengirim dan menampilkannya kembali.` });
      return true;
    }

    // .join — Bergabung ke grup via link (Rental / Sewa bot)
    if (cleanCmd === 'join') {
      if (!isOwner) {
        await sock.sendMessage(jid, { text: `❌ Akses ditolak. Hanya Owner yang bisa menggunakan fitur ini.` });
        return true;
      }

      if (!args[1] || !args[2]) {
        await sock.sendMessage(jid, { text: `⚠️ Format: \`.join <link_grup> <durasi_hari>\`\nContoh: \`.join https://chat.whatsapp.com/xxx 7\`` });
        return true;
      }

      const link = args[1];
      const days = parseInt(args[2]);

      if (isNaN(days) || days <= 0) {
        await sock.sendMessage(jid, { text: `❌ Durasi hari harus berupa angka positif.` });
        return true;
      }

      const codeMatch = link.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
      if (!codeMatch) {
        await sock.sendMessage(jid, { text: `❌ Link grup tidak valid.` });
        return true;
      }

      const inviteCode = codeMatch[1];
      
      try {
        const joinedJid = await sock.groupAcceptInvite(inviteCode);
        const expiresAt = await db.addGroupRental(joinedJid, days, senderNormalized);
        await sock.sendMessage(jid, { text: `✅ Berhasil bergabung ke grup!\n\nID Grup: ${joinedJid}\nMasa Sewa: ${days} hari\nBerakhir Pada: ${new Date(expiresAt).toLocaleString('id-ID')}` });
        
        // Kirim salam perkenalan di grup baru
        await sock.sendMessage(joinedJid, { text: `Halo semuanya! 👋\n\nBot ini disewa untuk grup ini selama *${days} hari*.\nKetik \`.menu\` untuk melihat daftar fitur yang tersedia!` });
      } catch (err) {
        await sock.sendMessage(jid, { text: `❌ Gagal bergabung ke grup: mungkin bot sudah di-banned dari sana atau link sudah dicabut. (${err.message})` });
      }
      return true;
    }

    // .ban / .unban — Owner, Admin Toko, atau Moderator terdaftar
    if (cleanCmd === 'ban' || cleanCmd === 'unban') {
      if (!isOwner && !isAdminStore && !isModeratorBot) {
        return true; // Silent — bukan owner, admin toko, atau mod
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
        // Nomor HP mentah TIDAK boleh dirakit begitu saja jadi `628xxx@s.whatsapp.net`.
        // 191 dari 194 pelanggan tersimpan sebagai @lid, jadi JID rakitan itu tidak
        // cocok dengan siapa pun: bot membalas "🚫 USER DI-BAN" dengan meyakinkan,
        // sementara orangnya tetap memakai bot seolah tidak terjadi apa-apa.
        const hasil = await db.resolveTargetJid(args[1]);
        if (!hasil.ditemukan) {
          await sock.sendMessage(jid, {
            text: `❌ *NOMOR TIDAK DITEMUKAN*\n\nNomor \`${args[1]}\` tidak cocok dengan pelanggan mana pun di database.\n\n_Sejak WhatsApp memakai identitas @lid, nomor HP tidak selalu bisa dipetakan ke akun. Cara yang PASTI berhasil:_\n• \`.${cleanCmd} @user\` (mention di grup)\n• reply salah satu pesan orangnya lalu ketik \`.${cleanCmd}\``
          });
          return true;
        }
        targetJid = hasil.jid;
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
        // Tentukan argumen sisa setelah target di-parse
        let remainingArgs = [];
        if (mentionedList?.length > 0) {
          remainingArgs = args.slice(2);
        } else if (quotedParticipant) {
          remainingArgs = args.slice(1);
        } else if (args[1]) {
          remainingArgs = args.slice(2);
        }

        // Parsing durasi
        const parsed = parseDuration(remainingArgs);
        const reason = remainingArgs.slice(parsed.consumed).join(' ') || 'Tanpa alasan.';
        
        await db.banUser(targetJid, reason, senderNormalized, parsed.expiresAt);

        let confirmationMsg = `🚫 *USER DI-BAN*\n\n`;
        confirmationMsg += `👤 Target: @${targetJid.split('@')[0]}\n`;
        confirmationMsg += `⏱️ Durasi: *${parsed.durationText}*\n`;
        
        if (parsed.expiresAt) {
          const expiryDate = new Date(parsed.expiresAt);
          const formattedExpiry = expiryDate.toLocaleString('id-ID', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZoneName: 'short'
          });
          confirmationMsg += `⏳ Berlaku Sampai: _${formattedExpiry}_\n`;
        }
        
        confirmationMsg += `📝 Alasan: ${reason}\n`;
        confirmationMsg += `🔨 Oleh: ${m.pushName || senderNormalized}\n\n`;
        confirmationMsg += `Bot tidak akan merespons pesan dari user ini selama masa ban aktif.`;

        await sock.sendMessage(jid, {
          text: confirmationMsg,
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

🔓 *Yang dia dapat:*
\`.ban\` · \`.unban\` · \`.unwarn\` · \`.cekwarn\`

🔒 *Yang TIDAK dia dapat:*
\`.paid\`, \`.price\`, \`.stock\`, \`.broadcast\`, \`.eval\`, dan semua perintah toko lain.`,
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
        const modList = mods.map((mod, i) => `${i+1}. \`${mod.jid}\`\n   📅 ${tanggalWib(mod.created_at)}`).join('\n');
        await sock.sendMessage(jid, { text: `📋 *Daftar Moderator Bot* (${mods.length} orang)

${modList}

Moderator hanya dapat menggunakan \`.ban\`, \`.unban\`, \`.unwarn\`, dan \`.cekwarn\`.` });
      }
      return true;
    }

    // .cekwarn — Lihat peringatan moderasi (Owner / Admin Toko / Moderator)
    //
    // Sebelum ini tidak ada satu pun cara melihat siapa yang mendekati ambang kick.
    // Peringatan hanya muncul sekilas di chat grup lalu hilang ditelan pesan lain,
    // padahal ter-kick berarti kehilangan hak checkout (checkout mewajibkan member
    // berada di grup pembeli).
    if (cleanCmd === 'cekwarn') {
      if (!isOwner && !isAdminStore && !isModeratorBot) return true;

      const ambang = Number.parseInt(botSettings.kickAfterWarnings, 10) || 3;
      const mentionedList = m.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      const quotedParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
      let targetJid = mentionedList?.[0] || quotedParticipant || '';

      if (!targetJid && args[1]) {
        const hasil = await db.resolveTargetJid(args[1]);
        if (!hasil.ditemukan) {
          await sock.sendMessage(jid, { text: `❌ Nomor \`${args[1]}\` tidak cocok dengan pelanggan mana pun. Pakai mention atau reply pesannya.` });
          return true;
        }
        targetJid = hasil.jid;
      }

      // Tanpa target: tampilkan daftar pantauan siapa saja yang sudah mendekat.
      if (!targetJid) {
        const daftar = await db.getWarningWatchlist(2);
        if (!daftar.length) {
          await sock.sendMessage(jid, { text: `✅ *TIDAK ADA YANG MENDEKATI AMBANG*\n\nTak seorang pun punya 2 peringatan aktif atau lebih.\n\n_Cek satu orang:_ \`.cekwarn @user\`` });
          return true;
        }
        const baris = daftar.map((d, i) => {
          const tanda = d.aktif >= ambang ? '🚨' : (d.aktif === ambang - 1 ? '⚠️' : '•');
          return `${tanda} ${i + 1}. *${d.nama}* — *${d.aktif}/${ambang}*\n     \`${d.jid}\``;
        }).join('\n');
        await sock.sendMessage(jid, {
          text: `📋 *PANTAUAN PERINGATAN MODERASI*\n━━━━━━━━━━━━━━━━━━━━\nAmbang kick: *${ambang}x*\n\n${baris}\n\n_Maafkan seseorang:_ \`.unwarn @user\`\n_Cabut 1 peringatan saja:_ \`.unwarn @user 1\``
        });
        return true;
      }

      const detail = await db.getCustomerWarningsDetail(targetJid);
      const riwayat = detail.terakhir.length
        ? detail.terakhir.map(r => `• _${r.created_at}_\n  ${r.reason}`).join('\n')
        : '_(belum ada)_';
      await sock.sendMessage(jid, {
        text: `📋 *PERINGATAN MODERASI*\n━━━━━━━━━━━━━━━━━━━━\n👤 @${targetJid.split('@')[0]}\n\n🔥 Aktif: *${detail.aktif}/${ambang}* _(dalam ${detail.jendelaHari} hari terakhir)_\n📜 Seumur hidup: *${detail.seumurHidup}x*\n\n*3 terakhir:*\n${riwayat}\n\n_Maafkan semua:_ \`.unwarn @user\``,
        mentions: [targetJid]
      });
      return true;
    }

    // .unwarn — Maafkan peringatan moderasi (Owner / Admin Toko / Moderator)
    //
    // Pasangan yang hilang dari `addCustomerWarning`. Tanpa perintah ini peringatan
    // benar-benar tidak bisa dibatalkan: `clearCustomerWarnings()` sudah ada di
    // database sejak lama tapi tidak pernah dipanggil satu baris pun.
    if (cleanCmd === 'unwarn') {
      if (!isOwner && !isAdminStore && !isModeratorBot) return true;

      const mentionedList = m.message?.extendedTextMessage?.contextInfo?.mentionedJid;
      const quotedParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
      let targetJid = mentionedList?.[0] || quotedParticipant || '';
      let sisaArgs = mentionedList?.length ? args.slice(2) : (quotedParticipant ? args.slice(1) : args.slice(2));

      if (!targetJid && args[1]) {
        const hasil = await db.resolveTargetJid(args[1]);
        if (!hasil.ditemukan) {
          await sock.sendMessage(jid, { text: `❌ Nomor \`${args[1]}\` tidak cocok dengan pelanggan mana pun. Pakai mention atau reply pesannya.` });
          return true;
        }
        targetJid = hasil.jid;
      }

      if (!targetJid) {
        await sock.sendMessage(jid, {
          text: `⚠️ *Gunakan:*\n• \`.unwarn @user\` — hapus SEMUA peringatannya\n• \`.unwarn @user 1\` — cabut 1 peringatan terakhir saja\n\n_Lihat siapa yang mendekati ambang:_ \`.cekwarn\``
        });
        return true;
      }

      const satuSaja = String(sisaArgs?.[0] || '').trim() === '1';
      if (satuSaja) {
        const dihapus = await db.hapusPeringatanTerakhir(targetJid);
        const detail = await db.getCustomerWarningsDetail(targetJid);
        await sock.sendMessage(jid, {
          text: dihapus
            ? `✅ 1 peringatan terakhir @${targetJid.split('@')[0]} dicabut.\n🔥 Sisa aktif: *${detail.aktif}x*`
            : `⚠️ @${targetJid.split('@')[0]} tidak punya peringatan untuk dicabut.`,
          mentions: [targetJid]
        });
      } else {
        const dihapus = await db.clearCustomerWarnings(targetJid);
        await sock.sendMessage(jid, {
          text: dihapus
            ? `✅ *PERINGATAN DIBERSIHKAN*\n\n👤 @${targetJid.split('@')[0]}\n🧹 *${dihapus}* peringatan dihapus.\n\n_Dia mulai dari nol lagi._`
            : `⚠️ @${targetJid.split('@')[0]} memang tidak punya peringatan.`,
          mentions: [targetJid]
        });
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
      const backupFilePath = await backupDatabase();
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
      Object.assign(botSettings, await db.getSettings());
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
      Object.assign(botSettings, await db.getSettings());
      await sock.sendMessage(jid, { text: `✅ Nomor Owner utama berhasil diperbarui ke: *+${newNum}*` });
      return true;
    }

    if (cleanCmd === 'autosholat') {
      const isGroup = jid.endsWith('@g.us');
      if (!isGroup) {
        await sock.sendMessage(jid, { text: "⚠️ Perintah pengaturan mode grup hanya dapat dijalankan di dalam Grup WhatsApp!" });
        return true;
      }
      const state = args[1]?.toLowerCase();
      if (!state || !['on', 'off'].includes(state)) {
        const currentSettings = await db.getGroupSettings(jid);
        const status = (currentSettings.auto_sholat === 1 || currentSettings.auto_sholat === undefined) ? 'ON (Aktif)' : 'OFF (Mati)';
        await sock.sendMessage(jid, { text: `🕌 *PENGINGAT SHOLAT GRUP*\nStatus saat ini: *${status}*\n\nGunakan perintah:\n\`.autosholat on\` - Mengaktifkan pengingat\n\`.autosholat off\` - Mematikan pengingat di grup ini` });
        return true;
      }

      const isEnabled = state === 'on' ? 1 : 0;
      await db.updateGroupSettings(jid, { auto_sholat: isEnabled });
      await sock.sendMessage(jid, { text: `✅ Pengingat sholat di grup ini berhasil diubah menjadi: *${state.toUpperCase()}*` });
      return true;
    }

    if (['levelup', 'autolevelup'].includes(cleanCmd)) {
      const isGroup = jid.endsWith('@g.us');
      if (!isGroup) {
        await sock.sendMessage(jid, { text: "⚠️ Perintah pengaturan notifikasi level up per-grup hanya dapat dijalankan di dalam Grup WhatsApp!\n\n_Untuk mematikan level up di seluruh grup bot, Owner dapat menggunakan:_ \`.globallevelup off\`" });
        return true;
      }
      const rawState = args[1]?.toLowerCase();
      const isTurnOn = ['on', 'aktif', 'enable', '1', 'hidup', 'start'].includes(rawState);
      const isTurnOff = ['off', 'mati', 'nonaktif', 'disable', '0', 'stop'].includes(rawState);

      if (!isTurnOn && !isTurnOff) {
        const currentSettings = await db.getGroupSettings(jid);
        const globalStatus = (botSettings.levelUpEnabled || "true") !== "false";
        const groupStatus = (currentSettings.levelup_enabled === 1 || currentSettings.levelup_enabled === undefined);
        const isActuallyActive = groupStatus && globalStatus;

        let statusText = `📈 *PENGATURAN NOTIFIKASI LEVEL UP GRUP*\n`;
        statusText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        statusText += `• Status di grup ini: *${groupStatus ? '🟢 ON (Aktif)' : '🔴 OFF (Mati)'}*\n`;
        statusText += `• Status Master Bot: *${globalStatus ? '🟢 Aktif' : '🔴 Dimatikan oleh Owner (Global OFF)'}*\n`;
        statusText += `• Status Efektif: *${isActuallyActive ? '🟢 AKTIF (Kartu dikirim saat naik level)' : '🔴 NONAKTIF (Tidak ada spam kartu level)'}*\n`;
        statusText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        statusText += `💡 *Pilihan Pengaturan:*\n`;
        statusText += `• Ketik \`.levelup off\` untuk mematikan notifikasi di grup ini.\n`;
        statusText += `• Ketik \`.levelup on\` untuk mengaktifkan kembali.`;

        await sendInteractiveButtons(sock, jid, {
          text: statusText,
          title: '📈 LEVEL UP SETTINGS',
          footer: 'Moderasi fitur grup Akbar Store',
          buttons: [
            { type: 'reply', text: '🔴 Matikan Level Up (OFF)', id: '.levelup off' },
            { type: 'reply', text: '🟢 Aktifkan Level Up (ON)', id: '.levelup on' }
          ]
        });
        return true;
      }

      const isEnabled = isTurnOn ? 1 : 0;
      await db.updateGroupSettings(jid, { levelup_enabled: isEnabled });
      await sock.sendMessage(jid, { 
        text: `✅ Notifikasi naik level di grup ini berhasil diubah menjadi: *${isTurnOn ? '🟢 ON (Aktif)' : '🔴 OFF (Mati / Hening)'}*` 
      });
      return true;
    }

    if (['globallevelup', 'setlevelup'].includes(cleanCmd)) {
      if (!isOwner) {
        await sock.sendMessage(jid, { text: "❌ Perintah ini khusus untuk Pemilik (Owner) bot." });
        return true;
      }
      const rawState = args[1]?.toLowerCase();
      const isTurnOn = ['on', 'aktif', 'enable', '1', 'hidup'].includes(rawState);
      const isTurnOff = ['off', 'mati', 'nonaktif', 'disable', '0'].includes(rawState);

      if (!isTurnOn && !isTurnOff) {
        const globalStatus = (botSettings.levelUpEnabled || "true") !== "false";
        await sendInteractiveButtons(sock, jid, {
          text: `🌐 *PENGATURAN MASTER GLOBAL LEVEL UP*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nStatus Master: *${globalStatus ? '🟢 AKTIF DI SEMUA GRUP' : '🔴 DIMATIKAN GLOBAL (Semua grup hening)'}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n_Pilih aksi di bawah untuk mengatur semua grup sekaligus:_`,
          title: '🌐 GLOBAL LEVEL UP TOGGLE',
          footer: 'Pengaturan master bot',
          buttons: [
            { type: 'reply', text: '🔴 Matikan di Semua Grup', id: '.globallevelup off' },
            { type: 'reply', text: '🟢 Aktifkan di Semua Grup', id: '.globallevelup on' }
          ]
        });
        return true;
      }

      const newVal = isTurnOn ? "true" : "false";
      await db.updateSettings({ levelUpEnabled: newVal });
      botSettings.levelUpEnabled = newVal;
      await sock.sendMessage(jid, { 
        text: `✅ Notifikasi level up di *SELURUH GRUP BOT* berhasil diubah menjadi: *${isTurnOn ? '🟢 AKTIF GLOBAL' : '🔴 NONAKTIF GLOBAL (Semua grup hening)'}*` 
      });
      return true;
    }

    if (['autodl', 'autodownload'].includes(cleanCmd)) {
      const isGroup = jid.endsWith('@g.us');
      if (!isGroup) {
        await sock.sendMessage(jid, { text: "⚠️ Perintah pengaturan Auto-Downloader hanya dapat dijalankan di dalam Grup WhatsApp!" });
        return true;
      }
      const state = args[1]?.toLowerCase();
      if (!state || !['on', 'off'].includes(state)) {
        const currentSettings = await db.getGroupSettings(jid);
        const status = (currentSettings.auto_dl_enabled === 1 || currentSettings.auto_dl_enabled === undefined) ? 'ON (Aktif)' : 'OFF (Mati)';
        await sock.sendMessage(jid, { text: `⚡ *AUTO-DOWNLOADER SOSMED (TIKTOK & IG)*\nStatus saat ini: *${status}*\n\nGunakan perintah:\n\`.autodl on\` - Mengaktifkan auto-download link TikTok & IG tanpa command\n\`.autodl off\` - Mematikan auto-download link di grup ini` });
        return true;
      }

      const isEnabled = state === 'on' ? 1 : 0;
      await db.updateGroupSettings(jid, { auto_dl_enabled: isEnabled });
      await sock.sendMessage(jid, { text: `✅ Fitur Auto-Downloader di grup ini berhasil diubah menjadi: *${state.toUpperCase()}*` });
      return true;
    }

    if (['listfitur', 'fiturgrup', 'groupfeatures'].includes(cleanCmd)) {
      const isGroup = jid.endsWith('@g.us');
      if (!isGroup) {
        await sock.sendMessage(jid, { text: "⚠️ Perintah daftar fitur grup hanya dapat dijalankan di dalam Grup WhatsApp!" });
        return true;
      }

      const g = await db.getGroupSettings(jid);
      let groupName = "Grup Ini";
      try {
        const metadata = await sock.groupMetadata(jid);
        if (metadata && metadata.subject) groupName = metadata.subject;
      } catch (e) {}

      const autoDlStatus = (g.auto_dl_enabled !== 0) ? "🟢 *AKTIF (ON)*" : "🔴 *NONAKTIF (OFF)*";
      const levelUpStatus = (g.levelup_enabled !== 0) ? "🟢 *AKTIF (ON)*" : "🔴 *NONAKTIF (OFF)*";
      const antiLinkStatus = (g.anti_link === 1) ? "🟢 *AKTIF (ON)*" : "🔴 *NONAKTIF (OFF)*";
      const welcomeStatus = (g.welcome_enabled === 1) ? "🟢 *AKTIF (ON)*" : "🔴 *NONAKTIF (OFF)*";
      const autoSholatStatus = (g.auto_sholat !== 0) ? "🟢 *AKTIF (ON)*" : "🔴 *NONAKTIF (OFF)*";
      
      const gameStatus = ((g.features_config || {}).game !== false) ? "🟢 *AKTIF (ON)*" : "🔴 *NONAKTIF (OFF)*";

      let modeStatus = "🟢 *MODE ALL (Semua Fitur)*";
      if (g.bot_mode === 'sales') modeStatus = "🟡 *MODE SALES (Khusus Toko)*";
      else if (g.bot_mode === 'off') modeStatus = "🔴 *MODE OFF (Muted)*";

      const textOutput = 
`⚙️ *PENGATURAN FITUR GRUP* ⚙️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 *Grup:* ${groupName}

Berikut adalah daftar fitur bot yang dapat diaktifkan / dimatikan oleh Admin grup:

1. ⚡ *Auto-Downloader (TikTok & IG)*
   ├ Status: ${autoDlStatus}
   └ Ubah: \`.autodl on\` / \`.autodl off\`

2. 📈 *Notifikasi Naik Level (Level Up)*
   ├ Status: ${levelUpStatus}
   └ Ubah: \`.levelup on\` / \`.levelup off\`

3. 🛡️ *Anti-Link Protection*
   ├ Status: ${antiLinkStatus}
   └ Ubah: \`.antilink on\` / \`.antilink off\`

4. 👋 *Pesan Sambutan (Welcome Message)*
   ├ Status: ${welcomeStatus}
   └ Ubah: \`.welcome on\` / \`.welcome off\`

5. 🕌 *Pengingat Jadwal Sholat Otomatis*
   ├ Status: ${autoSholatStatus}
   └ Ubah: \`.autosholat on\` / \`.autosholat off\`

6. 🛍️ *Mode Respon Bot*
   ├ Status: ${modeStatus}
   └ Ubah: \`.mode all\` / \`.mode sales\` / \`.mode off\`

7. 🎮 *Game & Hiburan*
   ├ Status: ${gameStatus}
   └ Ubah: \`.mode game on\` / \`.mode game off\`

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 _Gunakan perintah di atas untuk mengaktifkan atau menonaktifkan fitur sesuai kebutuhan grup._`;

      await sock.sendMessage(jid, { text: textOutput });
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
      const fiturGrup = currentSettings.features_config || {};
      const gameAktif = fiturGrup.game !== false;

      const labelMode = (mode) => {
        if (mode === 'sales') return '🛍️ MODE JUALAN (Hanya Respon Produk & Toko)';
        if (mode === 'off') return '🔴 OFF / MUTE (Bot Dibisukan di Grup Ini)';
        return '🌐 MODE ALL (Respon Seluruh Fitur)';
      };
      const labelGame = gameAktif ? '🟢 AKTIF (ON)' : '🔴 MATI (OFF)';

      const panduanMode =
`💡 *Cara Mengubah Mode Respon Bot:*
• \`.mode all\` — Respon seluruh fitur & media
• \`.mode sales\` — Khusus jualan & transaksi
• \`.mode off\` — Bisukan bot sepenuhnya di grup ini

🎮 *Sakelar Game/Hiburan (fitur lain tetap jalan):*
• \`.mode game off\` — Matikan semua game di grup ini
• \`.mode game on\` — Nyalakan lagi
_(alias cepat: \`.mode nogame\`)_`;

      if (!newMode) {
        await sock.sendMessage(jid, {
          text: `⚙️ *STATUS MODE BOT GRUP INI*
━━━━━━━━━━━━━━━━━━━━
📡 Mode Respon  : *${labelMode(currentSettings.bot_mode)}*
🎮 Game/Hiburan : *${labelGame}*

${panduanMode}`
        });
        return true;
      }

      // Sakelar khusus GAME. Sengaja dipisah dari bot_mode supaya admin bisa
      // meredam keramaian game tanpa ikut mematikan downloader, AI, dan toko.
      // Nilainya disimpan di features_config.game — sumber kebenaran yang sama
      // dipakai `.fitur game on/off` dan gerbang di src/games/index.js.
      const aliasGame = ['game', 'games', 'gim', 'hiburan', 'fun'];
      const aliasMatikanGame = ['nogame', 'tanpagame', 'matigame', 'offgame'];
      if (aliasGame.includes(newMode) || aliasMatikanGame.includes(newMode)) {
        const aksi = aliasMatikanGame.includes(newMode) ? 'off' : (args[2]?.toLowerCase() || '');

        if (!['on', 'nyala', 'aktif', 'off', 'mati', 'matikan', 'nonaktif'].includes(aksi)) {
          await sock.sendMessage(jid, {
            text: `🎮 *SAKELAR GAME GRUP INI*\n━━━━━━━━━━━━━━━━━━━━\n📊 Status: *${labelGame}*\n\n• \`.mode game on\` — Aktifkan game\n• \`.mode game off\` — Matikan game\n\n_Saat game dimatikan, perintah seperti .quiz, .undercover, .slot, .tcg, .raid, dan .mines tidak akan direspons di grup ini. Perintah profil & ekonomi (.poin, .rank, .transfer, .bank) tetap jalan._`
          });
          return true;
        }

        const nyalakanGame = ['on', 'nyala', 'aktif'].includes(aksi);
        fiturGrup.game = nyalakanGame;
        await db.updateGroupSettings(jid, { features_config: fiturGrup });
        await sock.sendMessage(jid, {
          text: nyalakanGame
            ? "🎮 *GAME DIAKTIFKAN KEMBALI DI GRUP INI!* 🟢\n\nSemua perintah game & hiburan kini bisa dipakai lagi."
            : "🚫 *GAME DIMATIKAN DI GRUP INI!* 🔴\n\nBot tidak akan lagi merespons perintah game & hiburan (.quiz, .undercover, .slot, .tcg, .raid, .mines, dll) di grup ini.\nPerintah profil & ekonomi (.poin, .rank, .transfer, .bank) tetap aktif.\n\n_Nyalakan lagi dengan_ `.mode game on`"
        });
        await db.addLog("GROUP", `Game di grup ${jid} di-${nyalakanGame ? 'ON' : 'OFF'}-kan oleh ${senderNormalized}`);
        return true;
      }

      if (!['sales', 'jualan', 'toko', 'all', 'semua', 'full', 'off', 'mute', 'nonaktif'].includes(newMode)) {
        await sock.sendMessage(jid, { text: `⚠️ Mode tidak dikenal: *${newMode}*\n\n${panduanMode}` });
        return true;
      }

      let targetMode = 'all';
      if (['sales', 'jualan', 'toko'].includes(newMode)) {
        targetMode = 'sales';
      } else if (['off', 'mute', 'nonaktif'].includes(newMode)) {
        targetMode = 'off';
      }

      await db.updateGroupSettings(jid, { bot_mode: targetMode });

      let successMsg = "";
      if (targetMode === 'sales') {
        successMsg = "🛍️ *MODE JUALAN DIAKTIFKAN UNTUK GRUP INI!* 🛍️\n\nBot sekarang *HANYA AKAN MERESPONS* perintah produk, katalog, transaksi, dan stok toko di grup ini. Perintah media/downloader/game/hiburan diabaikan agar grup tetap tertib khusus jualan.";
      } else if (targetMode === 'off') {
        successMsg = "🔴 *BOT DIBISUKAN (MUTED) DI GRUP INI!* 🔴\n\nBot berhenti total di grup ini — perintah, sambutan, notifikasi naik level, auto-download, dan anti-link semuanya ikut mati.\n\n👉 Hanya Admin/Owner yang bisa menyalakannya kembali dengan `.mode all`.";
      } else {
        successMsg = "🌐 *MODE ALL DIAKTIFKAN UNTUK GRUP INI!* 🌐\n\nBot sekarang merespons seluruh fitur (Jualan, Transaksi, Media, Downloader, Game, dan AI) di grup ini.";
      }

      await sock.sendMessage(jid, { text: successMsg });
      await db.addLog("GROUP", `Mode bot grup ${jid} diubah ke ${targetMode} oleh ${senderNormalized}`);
      return true;
    }

    // MODERASI GRUP: Sakelar Proteksi Anti-Link (.antilink, .setantilink)
    if (['antilink', 'setantilink'].includes(cleanCmd)) {
      const param = args[1]?.toLowerCase();
      const currentGroup = await db.getGroupSettings(jid);
      const isCurrentlyActive = Number(currentGroup.anti_link) === 1;

      if (!['on', 'off', '1', '0', 'aktif', 'mati', 'matikan', 'status'].includes(param)) {
        const statusText = isCurrentlyActive ? 'AKTIF 🟢' : 'NONAKTIF 🔴';
        const helpText = `🛡️ *PENGATURAN ANTI-LINK GRUP*\n━━━━━━━━━━━━━━━━━━━━\n📊 *Status Grup Ini:* ${statusText}\n\n📌 *Cara Mengubah:*\n• Ketik \`.antilink on\` untuk Mengaktifkan\n• Ketik \`.antilink off\` untuk Mematikan\n\n_Catatan: Jika dinonaktifkan, member bebas mengirim link tanpa peringatan atau kick._`;
        await sock.sendMessage(jid, { text: helpText });
        return true;
      }
      if (param === 'status') {
        const statusText = isCurrentlyActive ? 'AKTIF 🟢' : 'NONAKTIF 🔴';
        await sock.sendMessage(jid, { text: `🛡️ Status Anti-Link di grup ini: *${statusText}*` });
        return true;
      }
      const isEnable = ['on', '1', 'aktif'].includes(param);
      await db.updateGroupSettings(jid, { anti_link: isEnable ? 1 : 0 });
      await sock.sendMessage(jid, { text: `🛡️ Fitur Anti-Link Grup berhasil *${isEnable ? 'DIAKTIFKAN 🟢' : 'DINONAKTIFKAN 🔴'}* di grup ini!\n\n${isEnable ? '_Pesan berisi link dari member akan otomatis dihapus dan diberi peringatan._' : '_Member sekarang bebas mengirim link di grup ini._'}` });
      return true;
    }

    // OWNER LEVEL: Sakelar Anti-Link Seluruh Bot (.globalantilink)
    if (cleanCmd === 'globalantilink') {
      if (!isOwner) {
        await sock.sendMessage(jid, { text: "❌ Perintah ini khusus untuk Pemilik (Owner) bot." });
        return true;
      }
      const param = args[1]?.toLowerCase();
      if (!['on', 'off', '1', '0', 'aktif', 'mati', 'matikan'].includes(param)) {
        const currentGlobal = (botSettings.antiLinkEnabled || "true") === "true" ? 'AKTIF 🟢' : 'NONAKTIF 🔴';
        await sock.sendMessage(jid, { text: `🛡️ Status Global Anti-Link Toko: *${currentGlobal}*\n\n📌 *Gunakan:* \`.globalantilink on\` atau \`.globalantilink off\`` });
        return true;
      }
      const isEnable = ['on', '1', 'aktif'].includes(param);
      botSettings.antiLinkEnabled = isEnable ? "true" : "false";
      await db.updateSettings({ antiLinkEnabled: botSettings.antiLinkEnabled });
      await sock.sendMessage(jid, { text: `🛡️ Sakelar Global Anti-Link berhasil *${isEnable ? 'DIAKTIFKAN 🟢' : 'DINONAKTIFKAN 🔴'}* untuk seluruh bot!` });
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
      // Pintu harga KETIGA. Dulu di sini berdiri `parseInt(args[2])` mentah,
      // jadi `.flashsale NET01 15.000` menjual produknya seharga *Rp15*, dan
      // `.flashsale NET01 15rb` seharga Rp15 juga — padahal `.price` dan wizard
      // `.tokobaru` sama-sama menerima bentuk itu dengan benar. Harga negatif
      // pun lolos (`-50000` bukan NaN) dan setFlashSale tidak memvalidasi apa
      // pun, sehingga subtotal keranjang bisa jadi minus dan menggratiskan
      // produk lain di keranjang yang sama.
      const cekFlash = db.validasiFieldProduk('harga', String(args[2] || ''));
      const hFlash = cekFlash.ok ? cekFlash.nilai : NaN;
      const dur = parseInt(args[3]) || 2;

      if (!pKode || !cekFlash.ok) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Gunakan `.flashsale <KODE_PRODUK> <HARGA_FLASH> [DURASI_JAM]`\n\n_Contoh:_ `.flashsale NET01 15000 2`" });
        return true;
      }

      const p = await db.getProductByKode(pKode);
      if (!p) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${pKode}* tidak ditemukan.` });
        return true;
      }

      if (dur <= 0 || dur > 720) {
        await sock.sendMessage(jid, { text: "\u26a0\ufe0f Durasi flash sale harus antara *1* dan *720* jam (30 hari)." });
        return true;
      }

      if (hFlash >= p.harga) {
        await sock.sendMessage(jid, { text: `\u26a0\ufe0f Harga flash sale (*Rp${hFlash.toLocaleString('id-ID')}*) tidak lebih murah dari harga normal (*Rp${p.harga.toLocaleString('id-ID')}*). Flash sale dibatalkan.` });
        return true;
      }

      const endTime = await db.setFlashSale(pKode, hFlash, dur);
      const endStr = jamWib(endTime);

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
      
      // Penjaga anti-tindakan-pada-diri-sendiri.
      //
      // Versi lama membandingkan `targetJid.includes(sock.user.id.split(':')[0])`
      // — hanya nomor HP. Di grup ber-LID, men-tag bot menghasilkan @lid yang
      // angkanya sama sekali bukan nomor HP, jadi penjaganya lewat dan
      // `.kick @bot` benar-benar mengeluarkan bot dari grup. Lihat
      // `src/utils/botIdentity.js`.
      //
      // Metadata grup ikut dikirim sebagai jaring pengaman untuk sesi lama yang
      // `creds.me.lid`-nya belum terisi. Gagal mengambilnya tidak boleh
      // membatalkan penjaganya — perbandingan creds saja sudah menutup kasus
      // yang dilaporkan.
      let pesertaGrup = null;
      try {
        pesertaGrup = (await getCachedGroupMetadata(sock, jid))?.participants || null;
      } catch (e) {
        pesertaGrup = null;
      }

      if (adalahJidBot(sock, targetJid, pesertaGrup)) {
        await sock.sendMessage(jid, { text: `⚠️ Ditolak: Saya tidak bisa melakukan ${cleanCmd} pada diri saya sendiri.` });
        return true;
      }

      // Perisai tata tingkat: Owner > Admin Toko > admin grup.
      //
      // `.kick` dan `.demote` terbuka untuk SIAPA PUN yang berstatus admin di
      // grup WhatsApp — bukan hanya Admin Toko. Tanpa perisai ini, admin grup
      // mana pun bisa mengeluarkan Owner bot dari grupnya sendiri dengan satu
      // perintah, dan bot yang punya hak admin akan menurutinya.
      //
      // Hanya `kick` dan `demote` yang dijaga: `promote` pada Owner tidak
      // merugikan, dan `add` sasarannya justru belum ada di grup.
      if (['kick', 'demote'].includes(cleanCmd)) {
        try {
          const perisai = await perisaiTarget({
            db,
            targetJid,
            peserta: pesertaGrup,
            botSettings,
            penyuruhOwner: isOwner,
            ownerBawaan: config.defaults.ownerNumber,
            adminBawaan: config.defaults.adminNumbers
          });
          if (perisai.dilindungi) {
            const sebutan = perisai.alasan === 'OWNER' ? '*Owner bot*' : '*Admin Toko*';
            await sock.sendMessage(jid, {
              text: `🛡️ Ditolak: @${targetJid.split('@')[0]} adalah ${sebutan}.\n\n` +
                    (perisai.alasan === 'OWNER'
                      ? '_Hanya Owner sendiri yang bisa melakukan ini._'
                      : '_Hanya Owner yang bisa melakukan ini pada Admin Toko._'),
              mentions: [targetJid]
            });
            return true;
          }
        } catch (e) {
          // Perisai yang melempar tidak boleh mematikan moderasi grup. Lihat
          // catatan "bias saat ragu" di src/utils/perisaiTarget.js.
          console.error('[MODERASI] Perisai sasaran gagal, perintah diteruskan:', e?.message || e);
        }
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

    if (isGroup && cleanCmd === 'fitur') {
      if (!isAdminUser && !isOwner) {
        await sock.sendMessage(jid, { text: '⚠️ Perintah ini hanya untuk admin grup.' });
        return true;
      }
      
      const featureName = args[1]?.toLowerCase();
      const action = args[2]?.toLowerCase();
      // 'game' memakai kunci yang sama dengan `.mode game on/off` supaya kedua
      // perintah tidak saling menimpa.
      const validFeatures = ['ai', 'lens', 'brat', 'totalchat', 'rvo', 'freegames', 'game'];
      
      const currentSettings = await db.getGroupSettings(jid);
      const featuresConfig = currentSettings.features_config || {};
      
      if (!featureName || !action || !validFeatures.includes(featureName) || !['on', 'off'].includes(action)) {
        let msg = `🛠️ *PENGATURAN FITUR GRUP* 🛠️\n\nGunakan perintah: \`.fitur <nama_fitur> <on/off>\`\n\n*Daftar Fitur:*\n`;
        validFeatures.forEach(f => {
            const status = featuresConfig[f] !== false ? '✅ (ON)' : '❌ (OFF)';
            msg += `- *${f}* : ${status}\n`;
        });
        msg += `\nContoh: \`.fitur ai off\`\n_(Pengaturan ini HANYA berlaku di grup ini)_`;
        
        await sock.sendMessage(jid, { text: msg });
        return true;
      }
      
      featuresConfig[featureName] = (action === 'on');
      await db.updateGroupSettings(jid, { features_config: featuresConfig });
      await sock.sendMessage(jid, { text: `✅ Fitur *${featureName.toUpperCase()}* berhasil di-${action.toUpperCase()}-kan untuk grup ini.` });
      return true;
    }

    if (isGroup && (cleanCmd === 'open' || cleanCmd === 'close')) {
      const option = cleanCmd;
      try {
        await sock.groupSettingUpdate(jid, option === 'open' ? 'not_announcement' : 'announcement');
        await sock.sendMessage(jid, { text: option === 'open' ? "🔓 Grup telah DIBUKA! Semua anggota sekarang dapat mengirim pesan." : "🔒 Grup telah DITUTUP! Hanya Admin yang dapat mengirim pesan." });
        await db.addLog("MODERATION", `Admin (${senderNormalized}) mengubah status grup ${jid} ke ${option}`);
      } catch (err) {
        await sock.sendMessage(jid, { text: `❌ Gagal mengubah status grup: ${err.message}. Pastikan bot adalah Admin di grup.` });
      }
      return true;
    }

    if (isGroup && (cleanCmd === 'del' || cleanCmd === 'delete')) {
      if (!m.message?.extendedTextMessage?.contextInfo?.stanzaId) {
        await sock.sendMessage(jid, { text: "⚠️ Reply/balas pesan yang ingin dihapus dengan perintah .del" });
        return true;
      }
      
      const contextInfo = m.message.extendedTextMessage.contextInfo;
      const key = {
        remoteJid: jid,
        // Di grup ber-LID, pesan bot dibalas dengan participant berisi @lid, jadi
        // perbandingan nomor HP selalu false dan `.del` salah mengambil jalur
        // "hapus pesan orang lain" untuk pesannya sendiri.
        fromMe: adalahJidBot(sock, contextInfo.participant),
        id: contextInfo.stanzaId,
        participant: contextInfo.participant
      };
      
      try {
        await sock.sendMessage(jid, { delete: key });
        await sock.sendMessage(jid, { text: "✅ Pesan berhasil dihapus." });
      } catch (err) {
        await sock.sendMessage(jid, { text: `❌ Gagal menghapus pesan: ${err.message}. Pastikan bot adalah admin.` });
      }
      return true;
    }

    if (isGroup && cleanCmd === 'totalchat') {
      try {
        const stats = await db.getTopGroupChatStats(jid, 10);
        if (!stats || stats.length === 0) {
          await sock.sendMessage(jid, { text: "📊 Belum ada data statistik chat di grup ini." });
          return true;
        }

        let textMsg = "🏆 *TOP 10 MEMBER PALING AKTIF* 🏆\n\n";
        for (let i = 0; i < stats.length; i++) {
          const s = stats[i];
          const pushName = userPushNamesMap.get(s.participant_jid) || 'Seseorang';
          const noHp = s.participant_jid.split('@')[0];
          textMsg += `${i + 1}. @${noHp} (${pushName}) - ${s.msg_count} pesan\n`;
        }
        
        await sock.sendMessage(jid, { 
          text: textMsg, 
          mentions: stats.map(s => s.participant_jid) 
        });
      } catch (err) {
        await sock.sendMessage(jid, { text: `❌ Gagal mengambil statistik: ${err.message}` });
      }
      return true;
    }
    
    if (isGroup && cleanCmd === 'ceksewabot') {
      try {
        const rental = await db.getGroupRental(jid);
        if (rental) {
          const expiresAt = new Date(rental.expires_at);
          const now = new Date();
          const diffMs = expiresAt - now;
          const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
          
          if (diffDays > 0) {
            await sock.sendMessage(jid, { text: `⏳ *INFO SEWA BOT* ⏳\n\nSewa bot di grup ini masih aktif hingga:\n*🗓️ ${expiresAt.toLocaleDateString('id-ID')}* (Sisa ${diffDays} hari)\n\n_Terima kasih telah menyewa bot kami!_` });
          } else {
            await sock.sendMessage(jid, { text: `⚠️ *SEWA BOT BERAKHIR* ⚠️\n\nMasa aktif sewa bot di grup ini telah berakhir hari ini. Segera hubungi owner untuk perpanjangan.` });
          }
        } else {
          await sock.sendMessage(jid, { text: `ℹ️ Bot ini tidak dalam status sewa khusus (mungkin grup gratis atau belum terdaftar).` });
        }
      } catch (err) {
        await sock.sendMessage(jid, { text: `❌ Gagal mengecek status sewa: ${err.message}` });
      }
      return true;
    }

    if (isGroup && cleanCmd === 'sponsor') {
      const promoMsg = `🚀 *PROMO & SPONSOR* 🚀\n\n🌟 *Diskon Spesial Hari Ini!*\nGunakan kode voucher *PROMO20* untuk diskon 20% di toko kami.\n\nIngin mempromosikan produk Anda di bot ini? Hubungi admin/owner (.owner) untuk sewa slot iklan.`;
      await sock.sendMessage(jid, { text: promoMsg });
      return true;
    }

    if (isGroup && cleanCmd === 'textwelcome') {
      const msg = args.slice(1).join(' ');
      if (!msg) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.textwelcome <pesan>`\nVariabel yang bisa digunakan: @user, @group, @desc" });
        return true;
      }
      
      try {
        await db.runQuery("INSERT INTO group_settings (jid, welcome_msg) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET welcome_msg = ?", [jid, msg, msg]);
        await sock.sendMessage(jid, { text: "✅ Pesan selamat datang (welcome) berhasil diatur untuk grup ini!" });
      } catch (err) {
        await sock.sendMessage(jid, { text: `❌ Gagal menyimpan pengaturan: ${err.message}` });
      }
      return true;
    }

    if (isGroup && cleanCmd === 'textleave') {
      const msg = args.slice(1).join(' ');
      if (!msg) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.textleave <pesan>`\nVariabel yang bisa digunakan: @user, @group" });
        return true;
      }
      
      try {
        await db.runQuery("INSERT INTO group_settings (jid, goodbye_msg) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET goodbye_msg = ?", [jid, msg, msg]);
        await sock.sendMessage(jid, { text: "✅ Pesan selamat tinggal (leave) berhasil diatur untuk grup ini!" });
      } catch (err) {
        await sock.sendMessage(jid, { text: `❌ Gagal menyimpan pengaturan: ${err.message}` });
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

    const hasAtMentionAll = (text || '').includes('@everyone') || (text || '').includes('@all') || (text || '').includes('@semua');
    if (isGroup && (cleanCmd === 'tagall' || cleanCmd === 'hidetag' || cleanCmd === 'everyone' || cleanCmd === 'all' || cleanCmd === 'semua' || hasAtMentionAll)) {
      // Penjaga kedua, sengaja diulang di sini.
      //
      // Gerbang utama ada ~1.300 baris di atas dan melindungi blok ini hanya
      // selama `tagall`/`hidetag` tetap terdaftar di groupModerationCommands.
      // Satu penghapusan tidak sengaja dari daftar itu akan membuka mention
      // massal untuk semua orang tanpa satu baris pun di blok ini berubah —
      // dan `hasAtMentionAll` bahkan bisa menyalakannya dari perintah LAIN yang
      // kebetulan teksnya memuat '@semua'. Untuk alat spam, jarak sejauh itu
      // antara aturan dan yang diaturnya terlalu berisiko.
      if (!isAdminUser && !isOwner) {
        await sock.sendMessage(jid, {
          text: '❌ Memanggil seluruh member hanya bisa dilakukan *Admin Grup* atau *Owner*.'
        });
        return true;
      }
      try {
        if (sock && m?.key) sock.sendMessage(jid, { react: { text: '📣', key: m.key } }).catch(() => {});
        const groupMeta = (typeof getCachedGroupMetadata === 'function' ? await getCachedGroupMetadata(sock, jid) : null) || await sock.groupMetadata(jid);
        if (!groupMeta || !groupMeta.participants || groupMeta.participants.length === 0) {
          throw new Error('Tidak dapat mengambil daftar peserta grup.');
        }
        const allMentions = [...new Set(groupMeta.participants.map(p => p.id || p.lid).filter(Boolean))];

        const isExplicitTagAll = (cleanCmd === 'tagall');
        const quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const quotedText = quoted?.conversation || quoted?.extendedTextMessage?.text || quoted?.imageMessage?.caption || quoted?.videoMessage?.caption || '';
        const extraMsg = args.slice(1).join(' ').trim() || quotedText;
        
        let tagMsg = '';
        if (isExplicitTagAll) {
          tagMsg = `📢 *PENGUMUMAN ANGGOTA (${groupMeta.subject})*\n`;
          if (extraMsg) {
            tagMsg += `💬 *Pesan:* ${extraMsg}\n\n`;
          } else {
            tagMsg += `\n`;
          }
          tagMsg += `👥 *Total Anggota (${groupMeta.participants.length}):*\n`;
          groupMeta.participants.forEach((p, idx) => {
            const displayId = (p.id || p.lid).split('@')[0];
            tagMsg += `${idx + 1}. @${displayId}\n`;
          });
        } else {
          // Hidetag / .everyone mode
          tagMsg = extraMsg || `📢 *PENGUMUMAN GRUP (${groupMeta.subject})*`;
        }

        await sock.sendMessage(jid, { text: tagMsg, mentions: allMentions });
        if (sock && m?.key) sock.sendMessage(jid, { react: { text: '✅', key: m.key } }).catch(() => {});
      } catch (err) {
        if (sock && m?.key) sock.sendMessage(jid, { react: { text: '❌', key: m.key } }).catch(() => {});
        console.error("[TAGALL_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal tagall: ${err.message}` });
      }
      return true;
    }

    if (isGroup && cleanCmd === 'admins') {
      try {
        const groupMeta = (typeof getCachedGroupMetadata === 'function' ? await getCachedGroupMetadata(sock, jid) : null) || await sock.groupMetadata(jid);
        if (!groupMeta || !groupMeta.participants) {
          throw new Error('Tidak dapat membaca daftar peserta grup.');
        }
        const adminParticipants = groupMeta.participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin');
        const adminMentions = [...new Set(adminParticipants.map(p => p.id || p.lid).filter(Boolean))];

        const extraMsg = args.slice(1).join(' ').trim();
        
        let adminMsg = `👑 *PANGGILAN ADMIN GRUP (${groupMeta.subject})*\n`;
        if (extraMsg) adminMsg += `💬 *Pesan:* ${extraMsg}\n\n`;
        else adminMsg += `\n`;
        
        adminParticipants.forEach((a, idx) => {
          const displayId = (a.id || a.lid).split('@')[0];
          adminMsg += `${idx + 1}. @${displayId} (${a.admin === 'superadmin' ? 'Pembuat Grup' : 'Admin'})\n`;
        });

        await sock.sendMessage(jid, { text: adminMsg, mentions: adminMentions });
      } catch (err) {
        console.error("[ADMINS_TAG_ERR]", err.message);
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
      // Nomor HP TIDAK boleh dirakit jadi JID (AGENTS §9a). Dulu baris ini
      // menulis `6281...@s.whatsapp.net`, sementara bot membaca status percakapan
      // memakai identitas pengirim yang untuk ~98% pelanggan berbentuk `@lid`.
      // Jadi bot terus membalas otomatis sementara balasannya berkata "chat telah
      // diambil alih" — pengambilalihannya tidak pernah benar-benar terjadi.
      const sasaran = await db.resolveTargetJid(targetNumber);
      if (!sasaran.ditemukan) {
        await sock.sendMessage(jid, { text: `❌ Nomor *${targetNumber}* belum pernah berinteraksi dengan bot, jadi identitasnya tidak bisa dipastikan.\n\n_Minta pelanggan mengirim satu pesan dulu, atau balas (reply) pesannya lalu ketik_ \`.takeover\`` });
        return true;
      }
      await db.updateConversationState(sasaran.jid, 'ADMIN');
      await sock.sendMessage(jid, { text: `✅ Chat dengan ${targetNumber} telah diambil alih. Bot tidak akan membalas otomatis pesannya.` });
      return true;
    }

    if (cleanCmd === 'release') {
      const targetNumber = args[1];
      if (!targetNumber) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.release [NOMOR]`\nContoh: `.release 6281234567890`" });
        return true;
      }
      // Kembaran `.takeover` ini ikut diperbaiki. Kalau hanya salah satunya yang
      // memakai resolveTargetJid, chat bisa diambil alih tapi TIDAK PERNAH bisa
      // dikembalikan: `.takeover` menulis status di bawah identitas @lid yang
      // benar, sementara `.release` mencari baris `628...@s.whatsapp.net` yang
      // tidak pernah ada.
      const sasaranRilis = await db.resolveTargetJid(targetNumber);
      if (!sasaranRilis.ditemukan) {
        await sock.sendMessage(jid, { text: `❌ Nomor *${targetNumber}* tidak dikenali. Balas (reply) pesan pelanggannya lalu ketik \`.release\`.` });
        return true;
      }
      await db.updateConversationState(sasaranRilis.jid, 'BOT');
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

    // Satu-satunya jalan keluar dari MANUAL_REVIEW.
    //
    // Worker menyerah setelah 6 percobaan dan menandai job MANUAL_REVIEW; sejak
    // itu getPendingFulfillmentJobs tidak pernah mengambilnya lagi. Owner dapat
    // DM "butuh penanganan manual" tapi tidak punya perintah apa pun untuk
    // menyuruh bot mencoba lagi: `.paid` menolak pesanan yang sudah lunas, dan
    // `.done` hanya menandai selesai tanpa mengirim kredensial.
    if (['kirimulang', 'ulangkirim', 'retry'].includes(cleanCmd)) {
      const orderId = extractOrderIdFromMessage(args, m);
      if (!orderId) {
        await sock.sendMessage(jid, { text: "⚠️ Gunakan: `.kirimulang <ORDER_ID>`\n\n_Atau balas (reply) pesan notifikasi pesanannya._" });
        return true;
      }

      const det = await db.getOrderDetails(orderId);
      if (!det) {
        await sock.sendMessage(jid, { text: `❌ Order *${orderId}* tidak ditemukan.` });
        return true;
      }
      if (det.payment_status !== 'PAID' && !['PAID', 'COMPLETED'].includes(det.status)) {
        await sock.sendMessage(jid, { text: `⚠️ Order *${orderId}* belum lunas (status: *${det.status}*). Kirim ulang hanya untuk pesanan yang sudah dibayar.\n\n_Untuk mengonfirmasi pembayaran, pakai_ \`.paid ${orderId}\`` });
        return true;
      }

      const hasil = await db.resetFulfillmentJob(orderId);
      if (!hasil.success) {
        await sock.sendMessage(jid, { text: `❌ Gagal mengantre ulang *${orderId}*: ${hasil.alasan}` });
        return true;
      }

      const keterangan = hasil.alasan === 'JOB_BARU'
        ? 'Pesanan ini belum punya job pengiriman sama sekali — job baru dibuat.'
        : `Job sebelumnya berstatus *${hasil.statusLama}* setelah ${hasil.percobaanLama} percobaan.`;

      await sock.sendMessage(jid, {
        text: `🔁 *PENGIRIMAN DIANTRE ULANG*\n\n🧾 Order: *${orderId}*\n👤 ${det.customer_nama || '-'}\n\n${keterangan}\n\n_Worker akan mencobanya lagi dalam beberapa detik. Mengulang aman: kredensial yang sudah terkirim untuk pesanan ini dipakai lagi, bukan diambil dari stok baru._`
      });
      await logToSystem('ORDER', `🔁 Pengiriman order *${orderId}* diantre ulang oleh admin (wa.me/${senderNumber.split('@')[0]})`);
      return true;
    }

    if (['paid', 'acc', 'terima', 'konfirmasi'].includes(cleanCmd)) {
      const orderId = extractOrderIdFromMessage(args, m);
      if (!orderId) {
        await sock.sendMessage(jid, { 
          text: "⚠️ *Gagal Deteksi Order ID:*\n\nSilakan **balas (reply)** pesan notifikasi pesanan dengan `.paid` atau `.acc`, atau ketik: `.paid <ORDER_ID>`" 
        });
        return true;
      }

      const det = await db.getOrderDetails(orderId);
      if (!det) {
        await sock.sendMessage(jid, { text: `❌ Order ID *${orderId}* tidak ditemukan.` });
        return true;
      }

      // Penjaga idempoten. updateOrderStatus tidak menolak PAID -> PAID, dan
      // awardPurchasePoints tidak mengenali order yang sudah pernah diberi poin,
      // jadi `.paid` yang diketik dua kali — kebiasaan admin yang sangat wajar —
      // mencetak Akbar Poin dan Poin Loyalty berulang kali, sekaligus menurunkan
      // kembali status order dari COMPLETED ke PAID. markTransactionPaid punya
      // `WHERE payment_status = 'PENDING'` justru untuk alasan ini; jalur `.paid`
      // tidak punya padanannya.
      if (det.payment_status === 'PAID' || ['PAID', 'COMPLETED'].includes(det.status)) {
        await sock.sendMessage(jid, {
          text: `ℹ️ Order *${orderId}* sudah berstatus *${det.status}* — tidak ada yang diubah.\n\n_Kalau produknya belum terkirim, pakai_ \`.done ${orderId}\` _setelah mengirim manual._`
        });
        return true;
      }

      // Top up saldo BUKAN pembelian. Dua jalur otomatis punya cabang `DEP-`
      // (markTransactionPaid dan fulfillmentWorker); `.paid` tidak punya, jadi
      // konfirmasi manual sebuah top-up memberi Akbar Poin, Poin Loyalty dan
      // hadiah referral — lalu TIDAK PERNAH menambah saldonya. Pelanggan dibilangi
      // "Pembayaran Anda telah DITERIMA" dengan saldo tetap nol.
      if (String(orderId).startsWith('DEP-')) {
        const nominal = det.total || 0;
        const berhasil = await db.settleDepositOrder(orderId, det.customer_nomor, nominal, 'manual_admin');
        if (!berhasil) {
          await sock.sendMessage(jid, { text: `❌ Gagal menambahkan saldo untuk *${orderId}*. Statusnya mungkin sudah berubah — cek dengan \`.cekorder ${orderId}\`.` });
          return true;
        }
        const profil = await db.getCustomerMembershipProfile(det.customer_nomor);
        await sock.sendMessage(jid, { text: `✅ Top up *${orderId}* dikonfirmasi. Saldo pelanggan sekarang *Rp${(profil?.balance || 0).toLocaleString('id-ID')}*.` });
        await sock.sendMessage(det.customer_nomor, {
          text: `🎉 *TOP UP SALDO DEPOSIT BERHASIL!* 🎉\n\n🆔 *Deposit ID:* ${orderId}\n💰 *Nominal:* Rp${nominal.toLocaleString('id-ID')}\n💳 *Total Saldo Sekarang:* Rp${(profil?.balance || 0).toLocaleString('id-ID')}\n\n_Saldo sudah bisa dipakai berbelanja. Terima kasih! 🙏_`
        });
        await logToSystem('PAYMENT', `💰 Top up ${orderId} dikonfirmasi manual oleh admin (wa.me/${senderNumber.split('@')[0]})`);
        return true;
      }

      const res = await db.updateOrderStatus(orderId, 'PAID');
      if (!res.success) {
        await sock.sendMessage(jid, { text: `❌ Gagal: ${res.message}` });
        return true;
      }

      await sock.sendMessage(jid, { text: `✅ Order ID *${orderId}* berhasil diubah ke status *PAID*. Memproses pengiriman otomatis...` });

      if (res.kuponHabis) {
        await sock.sendMessage(jid, { text: `⚠️ Catatan: kupon pada order ini ternyata sudah habis kuotanya, tetapi diskonnya sudah menempel pada total. Pesanan tetap dilunaskan.` });
      }

      // Pembeli jalur `.paid` dulu tidak menerima Akbar Poin sama sekali, dan
      // pengajaknya tidak pernah menerima hadiah referral, karena keduanya hanya
      // diberikan di markTransactionPaid (jalur QRIS). Padahal pembeli transfer
      // manual justru yang paling lama menunggu.
      //
      // sertakanLoyalty: false karena updateOrderStatus di atas SUDAH menambah
      // Poin Loyalty lewat transisi BELUM BAYAR -> SUDAH BAYAR.
      let poinBelanja = 0;
      try {
        poinBelanja = await db.awardPurchasePoints(
          res.customerNomor,
          det.payment_amount || det.total || 0,
          orderId,
          { sertakanLoyalty: false }
        );
      } catch (poinErr) {
        console.error('[PAID] Gagal memberi poin belanja:', poinErr.message);
      }

      // Notifikasi awal ke customer
      let notifCustomer = `🔔 *INFO PESANAN (Order: ${orderId})*

`;
      notifCustomer += `Pembayaran Anda telah *DITERIMA* dan diverifikasi oleh admin kami. Terima kasih!`;
      if (poinBelanja > 0) notifCustomer += `

🪙 *Bonus Poin:* +${poinBelanja} Akbar Poin`;
      await sock.sendMessage(res.customerNomor, { text: notifCustomer });
      await logToSystem('PAYMENT', `💸 Order ID *${orderId}* dikonfirmasi PAID oleh admin (wa.me/${senderNumber.split('@')[0]})`);

      // ══════════════════════════════════════════════════════════
      // AUTO-DELIVERY: Local Stock
      // ══════════════════════════════════════════════════════════
      try {
        // claimAndDeliverItems mengembalikan PEMBUNGKUS
        // { success, deliveredData, itemsText, manualItems, warrantyUntil } sejak
        // commit 0847227 (19 Agu). Baris ini tidak ikut disesuaikan, sehingga
        // Object.keys() menghasilkan 5 kunci meta dan iterasi pertama menabrak
        // `true.credentials.length` -> TypeError. Transaksi di dalam
        // claimAndDeliverItems sudah commit saat itu, jadi lisensinya SUDAH
        // ditandai USED dan stok sudah turun — pelanggan bayar penuh lalu tidak
        // menerima apa pun. Jalur Midtrans di server.js:223 sudah benar sejak awal.
        const claimRes = await db.claimAndDeliverItems(orderId);
        const deliveredData = claimRes?.deliveredData || {};
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

          // Dulu penutupnya cuma "Jika ada masalah, silakan hubungi admin" —
          // padahal claimAndDeliverItems sudah menulis orders.warranty_until dan
          // `.garansi` sudah ada. Akibatnya setiap klaim dari pembeli jalur
          // `.paid` kembali jadi pekerjaan tangan, sementara pembeli jalur
          // otomatis diberi tahu cara mengurusnya sendiri. Teksnya sekarang
          // diambil dari sumber yang sama dengan fulfillmentWorker.
          credMsg += `━━━━━━━━━━━━━━━━━━\n`;
          credMsg += `⚠️ _Harap simpan data ini dengan baik._\n`;
          credMsg += penutupGaransi(orderId, claimRes?.warrantyUntil);
          credMsg += `━━━━━━━━━━━━━━━━━━`;
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

    // ==========================================
    // MANAJEMEN STOK & PRODUK (PRIVATE MESSAGE / DM / ADMIN)
    // ==========================================

    if (['addstock', 'tambahstok'].includes(cleanCmd)) {
      // Dukung input multi-baris (copy-paste banyak akun) dan 1-baris
      const lines = (text || '').split('\n').map(l => l.trim()).filter(Boolean);
      const firstTokens = lines[0].split(/\s+/);
      const code = (firstTokens[1] || '').toUpperCase();

      if (!code) {
        const helpMsg = `📦 *PANDUAN TAMBAH STOK AKUN DIGITAL (DM / PM)*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
*Format 1: Multi-baris (Banyak akun sekaligus)*
\`.addstock [KODE_PRODUK]\`
akun1@gmail.com|pass1
akun2@gmail.com|pass2
akun3@gmail.com|pass3

*Format 2: Satu akun*
\`.addstock [KODE_PRODUK] akun@gmail.com|pass1\`

_Contoh:_
\`.addstock NET01\`
user1@gmail.com|pass123
user2@gmail.com|pass456

💡 _Ketik \`.listproduk\` untuk melihat daftar kode produk toko._`;
        await sock.sendMessage(jid, { text: helpMsg });
        return true;
      }

      const p = await db.getProductByKode(code);
      if (!p) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan. Ketik \`.listproduk\` untuk cek daftar produk.` });
        return true;
      }

      let rawItems = [];
      if (lines.length > 1) {
        rawItems = lines.slice(1);
      } else if (firstTokens.length > 2) {
        const itemContent = firstTokens.slice(2).join(' ');
        if (itemContent.trim()) rawItems = [itemContent.trim()];
      }

      if (rawItems.length === 0) {
        await sock.sendMessage(jid, {
          text: `⚠️ Tidak ada data kredensial/akun yang disertakan.\n\n_Contoh pemakaian:_\n\`.addstock ${code}\`\nakun1@gmail.com|pass123\nakun2@gmail.com|pass456`
        });
        return true;
      }

      const res = await db.addProductItemsBatch(code, rawItems);
      if (!res.success) {
        await sock.sendMessage(jid, { text: `❌ Gagal menambah stok: ${res.message}` });
        return true;
      }

      let successMsg = `✅ *BERHASIL MENAMBAH STOK DIGITAL!* 🎉\n`;
      successMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      successMsg += `📦 *Produk:* ${res.productName} (\`${code}\`)\n`;
      successMsg += `📥 *Akun Ditambahkan:* *+${res.addedCount} pcs*\n`;
      successMsg += `📊 *Total Stok Ready Sekarang:* *${res.readyCount} pcs*\n`;
      if (res.switchedToAuto) {
        successMsg += `🔄 _Mode pengiriman otomatis diaktifkan ke *AUTO*._\n`;
      }
      successMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      successMsg += `💡 _Ketik \`.cekstok ${code}\` untuk melihat rincian stok._`;

      await sock.sendMessage(jid, { text: successMsg });
      await logToSystem('SYSTEM', `📦 Admin menambah ${res.addedCount} stok digital untuk ${code} via PM. Total ready: ${res.readyCount} pcs.`);

      // Picu notifikasi stok ready jika stok baru > 0
      await checkAndNotifySubscribers(code, res.readyCount);
      return true;
    }

    if (['cekstok', 'liststock'].includes(cleanCmd)) {
      const code = args[1]?.toUpperCase();
      if (!code) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.cekstok [KODE_PRODUK]`\nContoh: `.cekstok NET01`\n\n_Ketik \`.listproduk\` untuk melihat ringkasan seluruh produk._" });
        return true;
      }

      const details = await db.getProductStockDetails(code);
      if (!details) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
        return true;
      }

      let msg = `📦 *RINCIAN STOK: ${details.product.nama.toUpperCase()}* (\`${code}\`)\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `🏷️ *Mode Kirim:* *${details.deliveryType}*\n`;
      msg += `💸 *Harga:* Rp${(details.product.harga || 0).toLocaleString('id-ID')}\n`;
      msg += `🟢 *Stok Siap Jual (READY):* *${details.ready} pcs*\n`;
      msg += `🟡 *Sedang di Checkout (RESERVED):* ${details.reserved} pcs\n`;
      msg += `⚪ *Sudah Terjual (USED):* ${details.used} pcs\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

      if (details.sampleReadyItems.length > 0) {
        msg += `🔑 *Akun Ready Siap Kirim (Hingga 10 teratas):*\n`;
        details.sampleReadyItems.forEach((it) => {
          msg += `[ID: \`${it.id}\`] \`\`\`${it.data_content}\`\`\`\n`;
        });
        msg += `\n💡 _Untuk menghapus akun rusak, ketik:_ \`.delstock <ID>\`\n`;
      } else {
        msg += `⚠️ _Belum ada akun digital ready untuk produk ini._\n💡 _Isi stok via:_ \`.addstock ${code}\`\n`;
      }

      msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      await sock.sendMessage(jid, { text: msg });
      return true;
    }

    if (cleanCmd === 'delstock') {
      const id = parseInt(args[1], 10);
      if (isNaN(id) || id <= 0) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.delstock [ID_ITEM]`\nContoh: `.delstock 15`\n\n_Cek ID item dengan perintah \`.cekstok [KODE]\`._" });
        return true;
      }

      const item = await db.getQuery("SELECT * FROM product_items WHERE id = ?", [id]);
      if (!item) {
        await sock.sendMessage(jid, { text: `❌ Item stok dengan ID #${id} tidak ditemukan.` });
        return true;
      }

      // Dulu perintah ini hanya memastikan barisnya ADA, bukan statusnya.
      //
      // RESERVED berarti kredensial itu sedang dikunci untuk pesanan yang
      // menunggu pembayaran. Menghapusnya membuat pelanggan membayar lalu
      // claimAndDeliverItems tidak menemukan apa pun.
      //
      // USED adalah satu-satunya catatan tentang apa yang pernah dikirim ke
      // pembeli — itulah acuan klaim `.garansi`. `.delproduk` sengaja menyimpan
      // baris USED justru karena itu (AGENTS §10c); `.delstock` malah menghapusnya
      // satu per satu.
      if (item.status === 'RESERVED') {
        await sock.sendMessage(jid, { text: `🚫 Item #${id} sedang *DIKUNCI* untuk pesanan \`${item.order_id || '-'}\` yang menunggu pembayaran.\n\nBatalkan dulu pesanannya dengan \`.cancel ${item.order_id || '<ORDER_ID>'}\`, baru item ini bisa dihapus.` });
        return true;
      }
      if (item.status === 'USED') {
        await sock.sendMessage(jid, { text: `🚫 Item #${id} sudah *TERKIRIM* ke pembeli (pesanan \`${item.order_id || '-'}\`).\n\nBarisnya sengaja disimpan sebagai bukti garansi — kalau dihapus, klaim \`.garansi\` pembeli itu tidak punya acuan lagi.` });
        return true;
      }

      await db.deleteProductItem(id);
      const newCount = await db.getAvailableItemsCount(item.produk_kode);
      await sock.sendMessage(jid, {
        text: `🗑️ *Item Stok #${id} Berhasil Dihapus!*\n📦 Produk: \`${item.produk_kode}\`\n📊 Sisa Stok Ready: *${newCount} pcs*`
      });
      await logToSystem('SYSTEM', `🗑️ Item stok #${id} (${item.produk_kode}) dihapus oleh admin.`);
      return true;
    }

    if (cleanCmd === 'setdelivery') {
      const code = args[1]?.toUpperCase();
      const mode = args[2]?.toUpperCase();

      if (!code || !['AUTO', 'MANUAL'].includes(mode)) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.setdelivery [KODE] [AUTO/MANUAL]`\nContoh: `.setdelivery NET01 AUTO`" });
        return true;
      }

      const res = await db.setProductDeliveryType(code, mode);
      if (!res.success) {
        await sock.sendMessage(jid, { text: `❌ ${res.message}` });
        return true;
      }

      await sock.sendMessage(jid, {
        text: `✅ *Mode Pengiriman Berhasil Diubah!*\n📦 Produk: *${res.productName}* (\`${code}\`)\n🚀 Mode Sekarang: *${res.deliveryType}*`
      });
      return true;
    }

    if (['listproduk', 'katalogadmin'].includes(cleanCmd)) {
      const prods = await db.getAllProductsSummary();
      if (!prods || prods.length === 0) {
        await sock.sendMessage(jid, { text: "📦 Belum ada produk di database toko." });
        return true;
      }

      let msg = `🏪 *KATALOG & STATUS STOK TOKO (ADMIN)*\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

      let currentCat = '';
      prods.forEach(p => {
        const cat = p.brand_category || 'PRODUK DIGITAL';
        if (cat !== currentCat) {
          msg += `📂 *${cat.toUpperCase()}*\n`;
          currentCat = cat;
        }
        const badge = p.delivery_type === 'AUTO' ? '⚡ [AUTO]' : '👨‍💼 [MANUAL]';
        msg += `• \`${p.kode}\` — *${p.nama}*\n`;
        msg += `  💸 Rp${(p.harga || 0).toLocaleString('id-ID')} | Stok: *${p.stok || 0}* | ${badge}\n\n`;
      });

      msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `⚙️ *Perintah Kelola via PM:*\n`;
      msg += `• \`.addstock <KODE>\` : Tambah akun/voucher\n`;
      msg += `• \`.cekstok <KODE>\` : Cek rincian akun\n`;
      msg += `• \`.price <KODE> <HARGA>\` : Ganti harga\n`;
      msg += `• \`.setdelivery <KODE> <AUTO/MANUAL>\` : Ganti mode kirim`;

      await sock.sendMessage(jid, { text: msg });
      return true;
    }

    // ── KREDENSIAL YATIM ──────────────────────────────────────────────────
    //
    // Akun yang sudah dibeli owner tapi produknya keburu dihapus. Tidak tampil
    // di layar mana pun dan tidak bisa dijual, jadi tanpa perintah ini uangnya
    // hilang tanpa jejak. Sekaligus jadi peringatan: kalau kodenya dibuat lagi,
    // kredensial lama itu langsung dianggap stok siap jual.
    if (cleanCmd === 'stokyatim') {
      const sub = (args[1] || '').toLowerCase();

      if (sub === 'hapus' || sub === 'buang') {
        const kode = (args[2] || '').toUpperCase();
        if (!kode) {
          await sock.sendMessage(jid, { text: '⚠️ Format: `.stokyatim hapus <KODE>`\n\nKetik `.stokyatim` dulu untuk melihat daftarnya.' });
          return true;
        }
        const hasil = await db.hapusStokYatim(kode);
        if (!hasil.success) {
          await sock.sendMessage(jid, { text: `❌ ${hasil.message}` });
          return true;
        }
        await sock.sendMessage(jid, {
          text: `🗑️ *${hasil.dihapus} kredensial yatim* kode \`${hasil.kode}\` dihapus permanen.`
        });
        return true;
      }

      const yatim = await db.getStokYatim();
      if (!yatim || yatim.length === 0) {
        await sock.sendMessage(jid, { text: '✅ Tidak ada kredensial yatim. Semua stok punya produknya.' });
        return true;
      }

      const total = yatim.reduce((a, b) => a + (b.jumlah || 0), 0);
      let msg = `👻 *KREDENSIAL YATIM — ${total} akun tanpa produk*\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `_Akun ini sudah dibeli, tapi produknya sudah dihapus. Tidak muncul di katalog dan tidak bisa dijual._\n\n`;

      for (const y of yatim) {
        msg += `• \`${y.kode}\` — *${y.jumlah} akun* (ready ${y.ready}, reserved ${y.reserved})\n`;
      }

      msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `⚠️ Kalau kode yang sama dibuat lagi, akun lama ini *langsung dianggap stok siap jual* — padahal bisa saja sudah mati.\n\n`;
      msg += `Pilihannya:\n`;
      msg += `• \`.addproduk <KODE> ...\` : hidupkan lagi produknya (cek dulu akunnya masih hidup)\n`;
      msg += `• \`.stokyatim hapus <KODE>\` : buang akunnya permanen`;

      await sock.sendMessage(jid, { text: msg });
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

      // Dulu blok ini menulis angka apa pun ke products.stok lalu, khusus produk
      // AUTO, menempelkan catatan "oh iya, isinya pakai .addstock ya". Angkanya
      // tetap masuk. Padahal addToCart dan checkoutCart membaca jumlah baris
      // product_items READY untuk produk AUTO, bukan kolom itu — jadi katalog
      // memajang "stok 10" yang langsung dibantah sendiri ("stok tidak
      // mencukupi") begitu pelanggan menekan beli. Sekarang ditolak di database.
      const hasilStok = await db.setManualStock(code, stock);
      if (!hasilStok.success) {
        if (hasilStok.alasan === 'PRODUK_AUTO') {
          await sock.sendMessage(jid, {
            text: `⚠️ *Stok produk AUTO tidak diisi manual.*\n\n${hasilStok.message}\n\n` +
                  `📥 *Tambah stok:*\n\`.addstock ${code}\`\nakun1|pass1\nakun2|pass2\n\n` +
                  `🗑️ *Kurangi stok:* \`.cekstok ${code}\` lalu \`.delstock <ID>\`\n` +
                  `🔁 *Mau benar-benar pakai stok angka?* Ubah dulu modenya: \`.setdelivery ${code} MANUAL\``
          });
          return true;
        }
        await sock.sendMessage(jid, { text: `❌ ${hasilStok.message}` });
        return true;
      }

      await sock.sendMessage(jid, { text: `📦 Stok *${p.nama}* (\`${code}\`) berhasil diperbarui menjadi *${stock}* pcs.` });
      await logToSystem('SYSTEM', `📦 Stok produk *${code}* diperbarui menjadi *${stock}* oleh admin.`);

      // Picu notifikasi stok ready jika stok baru > 0
      await checkAndNotifySubscribers(code, stock);
      return true;
    }

    if (cleanCmd === 'price') {
      const code = args[1]?.toUpperCase();

      if (!code || !args[2]) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `.price [KODE] [HARGA_BARU]`\nContoh: `.price NET01 50000` — boleh juga `50rb` atau `50.000`" });
        return true;
      }

      // Dulu `parseInt` saja, lalu langsung diteruskan ke updateProductPrice —
      // yang MELEMPAR error untuk harga negatif atau di atas 1 miliar. Tidak ada
      // try/catch di sini, jadi lemparannya berakhir di penangkap teratas bot.js
      // dan admin tidak menerima balasan apa pun: perintahnya seperti diabaikan.
      // Sekarang lewat validator yang sama dengan wizard dan `.editproduk`, jadi
      // `50rb` dan `50.000` juga diterima di sini.
      const cekHarga = db.validasiFieldProduk('harga', args.slice(2).join(' '));
      if (!cekHarga.ok) {
        await sock.sendMessage(jid, { text: `❌ ${cekHarga.message}` });
        return true;
      }
      const price = cekHarga.nilai;

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

      // Pada produk AUTO, menulis 0 ke products.stok tidak menghentikan penjualan
      // sama sekali: addToCart membaca jumlah product_items READY. Jadi perintah
      // ini hanya akan menghasilkan katalog yang bilang "habis" sambil tetap
      // melayani pembelian. Ditolak, dengan cara yang benar-benar bekerja.
      const hasilOut = await db.setManualStock(code, 0);
      if (!hasilOut.success) {
        if (hasilOut.alasan === 'PRODUK_AUTO') {
          await sock.sendMessage(jid, {
            text: `⚠️ *${p.nama}* (\`${code}\`) bertipe *AUTO*, jadi menandai habis lewat \`.out\` tidak akan menghentikan pembelian.\n\n` +
                  `Stok AUTO dihitung dari kredensial tersimpan (*${hasilOut.readyCount} pcs*).\n\n` +
                  `🔒 *Cara benar menutup penjualan:*\n` +
                  `• Kosongkan stoknya: \`.cekstok ${code}\` lalu \`.delstock <ID>\`\n` +
                  `• Atau hapus produknya: \`.delproduk ${code}\``
          });
          return true;
        }
        await sock.sendMessage(jid, { text: `❌ ${hasilOut.message}` });
        return true;
      }
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

      const hasilReady = await db.setManualStock(code, 10);
      if (!hasilReady.success) {
        if (hasilReady.alasan === 'PRODUK_AUTO') {
          await sock.sendMessage(jid, {
            text: `⚠️ *${p.nama}* (\`${code}\`) bertipe *AUTO*, stoknya tidak bisa "dinyalakan" dengan angka.\n\n` +
                  `${hasilReady.message}\n\n` +
                  `📥 Isi stok sungguhan dengan:\n\`.addstock ${code}\`\nakun1|pass1\nakun2|pass2`
          });
          return true;
        }
        await sock.sendMessage(jid, { text: `❌ ${hasilReady.message}` });
        return true;
      }
      await sock.sendMessage(jid, { text: `🟢 Produk *${p.nama}* (\`${code}\`) ditandai *Ready* kembali dengan isi stok standar (10 pcs).` });
      await logToSystem('SYSTEM', `🟢 Produk *${code}* diset ready (stok 10) oleh admin.`);

      // Picu notifikasi stok ready jika stok baru > 0
      await checkAndNotifySubscribers(code, 10);
      return true;
    }

    // `.tokobaru` — jalur termudah: bot yang bertanya, admin tinggal menjawab.
    if (['tokobaru', 'produkbaru'].includes(cleanCmd)) {
      await mulaiWizardProduk(sock, jid, senderNumber);
      return true;
    }

    if (['addproduct', 'addproduk'].includes(cleanCmd)) {
      const rawArgs = args.slice(1).join(' ');
      const parts = rawArgs.split('|').map(p => p.trim());

      if (parts.length < 5) {
        const errorHelp = `⚠️ *Format salah.* Pisahkan dengan tanda \`|\`:\n\n` +
          `\`.addproduk KODE | NAMA | HARGA | STOK | DESKRIPSI | MODE | KATEGORI | DURASI\`\n\n` +
          `Empat kolom terakhir *boleh dikosongkan*. MODE diisi \`AUTO\` atau \`MANUAL\` (bawaan MANUAL).\n\n` +
          `_Contoh singkat:_\n\`.addproduk NET02 | Netflix 2 Bulan | 85000 | 5 | Sharing 1 profil\`\n\n` +
          `_Contoh lengkap (siap kirim otomatis):_\n\`.addproduk NET03 | Netflix 3 Bulan | 120000 | 0 | Sharing 1 profil | AUTO | NETFLIX | 3 Bulan\`\n\n` +
          `😵 _Pusing hafal urutannya? Ketik \`.tokobaru\`, saya yang tanya satu per satu._`;
        await sock.sendMessage(jid, { text: errorHelp });
        return true;
      }

      const codePart = parts[0].split(' ');
      const cekKode = db.validasiKodeProduk(codePart[0]);
      if (!cekKode.ok) {
        await sock.sendMessage(jid, { text: `❌ ${cekKode.message}` });
        return true;
      }
      const code = cekKode.nilai;

      const nama = parts[1];
      // Harga lewat parser yang sama dengan wizard, supaya "85.000" dan "85rb"
      // sama-sama diterima di dua pintu masuk yang berbeda.
      const harga = db.parseHargaIndonesia(parts[2]);
      const deskripsi = parts[4] || '';
      const kategori = parts[6] || null;
      const durasi = parts[7] || null;

      const produkLama = await db.getProductByKode(code);

      // MODE yang dikosongkan tidak boleh membalik produk yang sudah ada.
      // Dulu defaultnya selalu 'MANUAL', jadi `.addproduk NET01 | ... | 85000 | 5`
      // tanpa kolom MODE mengubah produk AUTO berisi 20 kredensial menjadi MANUAL
      // diam-diam, dan stoknya diambil dari angka yang diketik.
      const modeDefault = produkLama?.delivery_type || 'MANUAL';
      const mode = (parts[5] || modeDefault).trim().toUpperCase() || modeDefault;

      // Stok diperiksa dengan batas yang SAMA dengan addProduct (0-1.000.000).
      // Dulu di sini hanya ada `isNaN(stok)`, sehingga `-5` dan `9999999` lolos —
      // lalu addProduct melempar "Stok produk tidak valid", dan panggilan itu
      // tidak dibungkus try/catch. Lemparannya berakhir di penangkap teratas
      // bot.js yang cuma console.error, jadi admin tidak menerima balasan apa
      // pun: perintahnya seperti diabaikan.
      //
      // `stok` sengaja bukan bagian dari FIELD_PRODUK — untuk produk AUTO angka
      // itu dihitung dari kredensial, bukan diketik — jadi divalidasi di sini.
      const stok = parseInt(String(parts[3] ?? '').trim(), 10);
      if (harga === null) {
        await sock.sendMessage(jid, { text: "❌ Gagal. Harga harus berupa angka/nominal, misalnya `85000`, `85.000`, atau `85rb`." });
        return true;
      }
      if (!Number.isInteger(stok) || stok < 0 || stok > 1_000_000) {
        await sock.sendMessage(jid, { text: "❌ Gagal. Stok harus bilangan bulat antara *0* dan *1.000.000*." });
        return true;
      }
      const cekNama = db.validasiFieldProduk('nama', nama);
      if (!cekNama.ok) {
        await sock.sendMessage(jid, { text: `❌ ${cekNama.message}` });
        return true;
      }
      if (!['AUTO', 'MANUAL'].includes(mode)) {
        await sock.sendMessage(jid, { text: "❌ Mode kirim hanya boleh *AUTO* atau *MANUAL*." });
        return true;
      }

      // Stok produk AUTO selalu dihitung ulang addProduct() dari kredensial yang
      // tersimpan, jadi angka stok yang diketik di sini memang diabaikan — bukan
      // dibuang diam-diam, tapi dikatakan ke admin di pesan balasan di bawah.
      //
      // gambar, petunjuk dan variant_type diambil dari produk lama kalau ada.
      // addProduct adalah INSERT OR REPLACE: kolom yang tidak dikirim ulang jadi
      // KOSONG. Dulu ketiganya dikirim sebagai "" / null, jadi `.addproduk` pada
      // kode yang sudah ada MENGHAPUS gambar hasil `.setgambar` dan seluruh teks
      // petunjuk pakai — padahal petunjuk itu ikut dikirim ke pembeli bersama
      // kredensialnya. Balasannya bahkan berbunyi "PRODUK DIPERBARUI" tanpa
      // menyebut dua kolom yang barusan dihapus. Lihat AGENTS §10c.
      await db.addProduct(
        code, cekNama.nilai, harga, mode === 'AUTO' ? 0 : stok, deskripsi,
        produkLama?.gambar || "", mode, "", produkLama?.petunjuk || "",
        kategori, produkLama?.variant_type || null, durasi
      );
      const produkBaru = await db.getProductByKode(code);

      let successText = produkLama
        ? `♻️ *PRODUK DIPERBARUI* (kode \`${code}\` sudah ada sebelumnya)\n`
        : `🆕 *PRODUK BARU BERHASIL DITAMBAHKAN!*\n`;
      successText += `━━━━━━━━━━━━━━━━━━━━\n`;
      successText += `• Kode: \`${code}\`\n`;
      successText += `• Nama: *${cekNama.nilai}*\n`;
      successText += `• Harga: Rp${harga.toLocaleString('id-ID')}\n`;
      successText += `• Stok: ${produkBaru?.stok ?? 0} pcs\n`;
      successText += `• Mode kirim: *${mode}*\n`;
      if (kategori) successText += `• Kategori: ${kategori}\n`;
      if (durasi) successText += `• Durasi: ${durasi}\n`;
      if (deskripsi) successText += `• Deskripsi: ${deskripsi}\n`;
      successText += `━━━━━━━━━━━━━━━━━━━━\n`;

      if (mode === 'AUTO') {
        successText += (produkBaru?.stok || 0) > 0
          ? `⚡ Produk siap dikirim otomatis begitu pembayaran lunas.\n`
          : `⚠️ Stok akun masih kosong, produk belum bisa dibeli. Isi dengan:\n\`.addstock ${code}\`\nakun1|pass1\nakun2|pass2\n`;
      }
      successText += `\n💡 _Ubah satu kolom saja:_ \`.editproduk ${code} harga 90000\`\n`;
      successText += `🖼️ _Pasang gambar:_ kirim foto dengan caption \`.setgambar ${code}\``;

      await sock.sendMessage(jid, { text: successText });
      await logToSystem('SYSTEM', `🆕 Produk ${produkLama ? 'diperbarui' : 'ditambahkan'} oleh admin: ${code} - ${cekNama.nilai} (${mode})`);

      // Picu notifikasi jika stok baru > 0
      await checkAndNotifySubscribers(code, produkBaru?.stok || 0);
      return true;
    }

    if (['editproduk', 'ubahproduk'].includes(cleanCmd)) {
      const code = args[1]?.toUpperCase();
      const field = args[2];
      // Nilainya sengaja diambil dari teks mentah, bukan args, supaya spasi dan
      // baris baru di deskripsi tidak diratakan jadi satu spasi.
      const nilai = (text || '').split(/\s+/).slice(3).join(' ').trim();

      const daftarField = Object.entries(db.FIELD_PRODUK)
        .map(([k, v]) => `• \`${k}\` — ${v.label}`)
        .join('\n');

      if (!code || !field) {
        await sock.sendMessage(jid, {
          text: `⚠️ *Format:* \`.editproduk <KODE> <FIELD> <NILAI BARU>\`\n\n` +
                `*Field yang bisa diubah:*\n${daftarField}\n\n` +
                `_Contoh:_\n\`.editproduk NET01 harga 55000\`\n\`.editproduk NET01 nama Netflix Premium 1 Bulan\`\n` +
                `\`.editproduk NET01 mode AUTO\`\n\n` +
                `_Kosongkan isi kolom opsional dengan:_ \`.editproduk NET01 durasi -\``
        });
        return true;
      }

      const fieldResolved = db.resolveFieldProduk(field);
      if (!fieldResolved) {
        await sock.sendMessage(jid, { text: `❌ Field *${field}* tidak dikenal.\n\n*Pilihan yang ada:*\n${daftarField}` });
        return true;
      }
      if (!nilai) {
        await sock.sendMessage(jid, { text: `⚠️ Nilai barunya belum diisi.\n\n_Contoh:_ \`.editproduk ${code} ${fieldResolved} <nilai>\`` });
        return true;
      }

      // Satu tanda hubung berarti "kosongkan", sesuai kata kunci `lewati` di wizard.
      const nilaiFinal = nilai === '-' ? '' : nilai;
      const hasil = await db.updateProductFields(code, { [fieldResolved]: nilaiFinal });
      if (!hasil.success) {
        await sock.sendMessage(jid, { text: `❌ ${hasil.message || 'Gagal menyunting produk.'}` });
        return true;
      }

      const ubah = hasil.perubahan[0];
      const tampil = (v) => (v === null || v === undefined || v === '' ? '_(kosong)_' : String(v));
      let pesan = `✏️ *PRODUK DIPERBARUI*\n━━━━━━━━━━━━━━━━━━━━\n`;
      pesan += `📦 *${hasil.product.nama}* (\`${hasil.product.kode}\`)\n\n`;
      pesan += `*${ubah.label}*\n`;
      pesan += `• Sebelum: ${tampil(ubah.lama)}\n`;
      pesan += `• Sesudah: ${tampil(ubah.baru)}\n`;
      pesan += `━━━━━━━━━━━━━━━━━━━━`;
      if (hasil.readyCount !== null && hasil.readyCount !== undefined) {
        pesan += `\n\n⚡ Mode *AUTO* aktif. Stok kini mengikuti kredensial tersimpan: *${hasil.readyCount} pcs*.`;
        if (hasil.readyCount === 0) pesan += `\n⚠️ Masih kosong — isi dengan \`.addstock ${hasil.product.kode}\`.`;
      }

      await sock.sendMessage(jid, { text: pesan });
      await logToSystem('SYSTEM', `✏️ Produk ${hasil.product.kode} disunting admin: ${ubah.label}.`);
      return true;
    }

    if (['delproduk', 'hapusproduk'].includes(cleanCmd)) {
      const code = args[1]?.toUpperCase();
      const konfirmasi = (args[2] || '').toUpperCase();

      if (!code) {
        await sock.sendMessage(jid, { text: "⚠️ *Format:* `.delproduk <KODE>`\n\n_Bot akan menampilkan dampaknya dulu sebelum benar-benar menghapus._" });
        return true;
      }

      const impact = await db.getProductDeleteImpact(code);
      if (!impact) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
        return true;
      }

      if (impact.reserved > 0 || impact.orderAktif.length > 0) {
        const daftarOrder = impact.orderAktif.slice(0, 5).map(o => `• \`${o.order_id}\` (${o.status})`).join('\n');
        await sock.sendMessage(jid, {
          text: `🚫 *Tidak bisa dihapus — masih ada transaksi berjalan.*\n━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 *${impact.product.nama}* (\`${code}\`)\n` +
                (impact.reserved > 0 ? `🟡 ${impact.reserved} akun sedang dikunci untuk checkout\n` : '') +
                (impact.orderAktif.length > 0 ? `🧾 ${impact.orderAktif.length} order belum selesai:\n${daftarOrder}\n` : '') +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `_Selesaikan atau batalkan order itu dulu (\`.paid\` / \`.cancel\`), baru produknya bisa dihapus._`
        });
        return true;
      }

      // Penghapusan produk memusnahkan kredensial yang belum terjual, jadi harus
      // ada langkah kedua yang disengaja — bukan sekali ketik seperti .delstock.
      if (konfirmasi !== 'YA') {
        await sock.sendMessage(jid, {
          text: `⚠️ *KONFIRMASI PENGHAPUSAN PRODUK*\n━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 *${impact.product.nama}* (\`${code}\`)\n` +
                `💸 Rp${(impact.product.harga || 0).toLocaleString('id-ID')}\n\n` +
                `*Yang akan ikut terhapus:*\n` +
                `• ${impact.ready} kredensial siap jual (hilang permanen)\n` +
                `• Langganan notifikasi & wishlist produk ini\n\n` +
                `*Yang tetap disimpan:*\n` +
                `• ${impact.used} kredensial yang sudah terkirim ke pembeli (bukti garansi)\n` +
                `• Riwayat order lama\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `Kalau yakin, ketik:\n\`.delproduk ${code} YA\``
        });
        return true;
      }

      const hasil = await db.deleteProductWithItems(code);
      if (!hasil.success) {
        await sock.sendMessage(jid, { text: `❌ ${hasil.message || 'Gagal menghapus produk.'}` });
        return true;
      }

      await sock.sendMessage(jid, {
        text: `🗑️ *Produk dihapus.*\n📦 *${impact.product.nama}* (\`${code}\`)\n🔑 ${impact.ready} kredensial siap jual ikut dihapus.\n📁 ${impact.used} kredensial terjual tetap tersimpan sebagai riwayat.`
      });
      await logToSystem('SYSTEM', `🗑️ Produk ${code} (${impact.product.nama}) dihapus oleh admin via WhatsApp.`);
      return true;
    }

    if (cleanCmd === 'setgambar') {
      const code = args[1]?.toUpperCase();
      if (!code) {
        await sock.sendMessage(jid, { text: "⚠️ *Format:* kirim foto produknya dengan caption `.setgambar <KODE>`\n\n_Atau balas (reply) foto yang sudah terkirim dengan perintah yang sama._" });
        return true;
      }

      const p = await db.getProductByKode(code);
      if (!p) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
        return true;
      }

      // Foto bisa datang dua cara: menempel pada pesan ini (caption), atau pesan
      // lama yang di-reply. Keduanya diterima supaya admin tidak perlu mengulang kirim.
      const quoted = m?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const pesanGambar = m?.message?.imageMessage
        ? m
        : (quoted?.imageMessage ? { ...m, message: quoted } : null);

      if (!pesanGambar) {
        await sock.sendMessage(jid, { text: `⚠️ Tidak ada foto yang terbaca.\n\nKirim fotonya dengan caption \`.setgambar ${code}\`, atau balas foto yang sudah ada dengan perintah itu.` });
        return true;
      }

      let pathGambar;
      try {
        pathGambar = await simpanGambarProduk(pesanGambar, code);
      } catch (err) {
        console.error('[SETGAMBAR] Gagal menyimpan gambar:', err.message);
        await sock.sendMessage(jid, { text: `❌ Gambar gagal disimpan: ${err.message}` });
        return true;
      }

      const hasil = await db.setProductImage(code, pathGambar);
      if (!hasil.success) {
        await sock.sendMessage(jid, { text: `❌ ${hasil.message || 'Gagal menyimpan gambar ke produk.'}` });
        return true;
      }

      await sock.sendMessage(jid, {
        text: `🖼️ *Gambar produk tersimpan.*\n📦 *${p.nama}* (\`${code}\`)\n📁 \`${pathGambar}\`\n\n_Gambar ini yang tampil di katalog dan di dashboard._`
      });
      await logToSystem('SYSTEM', `🖼️ Gambar produk ${code} diperbarui oleh admin via WhatsApp.`);
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
      // `getDailySalesReport` menyaring dengan `DATE(created_at, '+7 hours')` alias
      // tanggal WIB, tapi baris ini dulu mengirim tanggal UTC. Antara pukul 00:00
      // dan 07:00 WIB keduanya berbeda hari: judulnya menulis tanggal hari ini,
      // angkanya omzet KEMARIN — tanpa tanda apa pun bahwa itu salah.
      const today = db.tanggalWIB();
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
}
