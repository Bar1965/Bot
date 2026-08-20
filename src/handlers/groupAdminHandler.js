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
    'paid', 'done', 'cancel', 'flashsale', 'stats', 'broadcast', 'addcoupon', 
    'delcoupon', 'listcoupon', 'addfaq', 'delfaq', 'listfaq', 'laporan', 
    'restock', 'stock', 'price', 'out', 'ready', 'addproduct', 'takeover', 
    'release', 'setname', 'setowner', 'eval', 'exec', 'backup', 'resetleaderboard'
  ];

  const groupModerationCommands = [
    'add', 'kick', 'promote', 'demote', 'group', 'link', 'tagall', 'hidetag', 
    'everyone', 'admins', 'mode', 'setmode', 'botmode', 'antilink', 'welcome', 
    'autowelcomeswitch', 'setwelcome', 'setupdategroup', 'testupdate', 'autosholat', 'levelup', 'autolevelup',
    'globallevelup', 'setlevelup', 'fitur', 'open', 'close', 'del', 'delete', 'totalchat', 'ceksewabot', 'sponsor',
    'textwelcome', 'textleave',
    'autodl', 'autodownload', 'listfitur', 'fiturgrup', 'groupfeatures'
  ];

  const banCommands = ['ban', 'unban', 'addmod', 'delmod', 'listmod', 'setownerid', 'join', 'antidelete'];

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
  let isAdminStore = isOwner || isMod || adminList.some(adm => adm && (senderDigits === adm || senderDigits.endsWith(adm) || adm.endsWith(senderDigits)));

  if (!isOwner || !isAdminStore) {
    try {
      const custRow = await db.getQuery("SELECT role FROM customers WHERE nomor = ? OR nomor = ?", [senderCleanJid, senderNormalized]);
      if (custRow?.role === 'OWNER') isOwner = true;
      else if (['ADMIN', 'MODERATOR'].includes(custRow?.role)) isAdminStore = true;
    } catch (e) {}
  }

  const isAdminUser = isAdminStore || isGroupAdmin || isOwner;

  // Jika bukan Admin/Owner, tolak perintah
  if (!isAdminUser && !isOwner) {
    return false;
  }

  // 🔒 Guard Grup Admin ACC khusus untuk perintah transaksi toko
  if (adminStoreCommands.includes(cleanCmd)) {
    const adminGroupId = botSettings.adminGroupId || botSettings.transactionLogGroupId || "";
    if (adminGroupId && isGroup && jid !== adminGroupId) {
      // Diam / tidak merespons perintah admin yang salah tempat agar tidak spam grup
      return true;
    }
  }

    if (cleanCmd === 'resetleaderboard') {
      if (!isOwner && !isAdminUser) {
        await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Admin atau Owner bot." });
        return true;
      }
      const res = await db.resetGameLeaderboard();
      await sock.sendMessage(jid, { text: `✅ *LEADERBOARD GAME DIRESET BERSIH!*\n\nSemua poin, level, dan streak game pengguna un-registered telah dibersihkan.\n\nSekarang hanya member terdaftar (.daftar <nama>) yang dapat mengumpulkan poin dan masuk ke leaderboard!` });
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
      
      if (!newMode) {
        let modeLabel = '🌐 MODE ALL (Respon Seluruh Fitur)';
        if (currentSettings.bot_mode === 'sales') {
          modeLabel = '🛍️ MODE JUALAN (Hanya Respon Produk & Toko)';
        } else if (currentSettings.bot_mode === 'off') {
          modeLabel = '🔴 OFF/MUTE (Bot Dinonaktifkan di Grup Ini)';
        }

        await sock.sendMessage(jid, { 
          text: `⚙️ *STATUS MODE BOT GRUP INI:*
          
Mode Saat Ini: *${modeLabel}*

💡 *Cara Mengubah Mode:*
• Ketik \`.mode jualan\` atau \`.mode sales\` (Khusus jualan & transaksi)
• Ketik \`.mode all\` or \`.mode semua\` (Respon seluruh fitur & media)
• Ketik \`.mode off\` atau \`.mode mute\` (Nonaktifkan respon bot sepenuhnya)` 
        });
        return true;
      }

      if (!['sales', 'jualan', 'toko', 'all', 'semua', 'full', 'off', 'mute', 'nonaktif'].includes(newMode)) {
        await sock.sendMessage(jid, { text: "⚠️ Mode tidak valid. Gunakan: `.mode jualan`, `.mode all`, atau `.mode off`" });
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
        successMsg = "🛍️ *MODE JUALAN DIAKTOKAN UNTUK GRUP INI!* 🛍️\n\nBot sekarang *HANYA AKAN MERESPONS* perintah produk, katalog, transaksi, dan stok toko di grup ini. Perintah media/downloader/game/hiburan diabaikan agar grup tetap tertib khusus jualan.";
      } else if (targetMode === 'off') {
        successMsg = "🔴 *BOT DINONAKTIFKAN (MUTED) DI GRUP INI!* 🔴\n\nBot tidak akan merespons perintah apapun lagi di grup ini kecuali perintah `.mode` untuk mengaktifkannya kembali.";
      } else {
        successMsg = "🌐 *MODE ALL DIAKTIFKAN UNTUK GRUP INI!* 🌐\n\nBot sekarang merespons seluruh fitur (Jualan, Transaksi, Media, Downloader, Game, dan AI) di grup ini.";
      }

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
      
      const botId = sock.user?.id?.split(':')[0];
      if (botId && targetJid.includes(botId)) {
        await sock.sendMessage(jid, { text: `⚠️ Ditolak: Saya tidak bisa melakukan ${cleanCmd} pada diri saya sendiri.` });
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

    if (isGroup && cleanCmd === 'fitur') {
      if (!isAdminUser && !isOwner) {
        await sock.sendMessage(jid, { text: '⚠️ Perintah ini hanya untuk admin grup.' });
        return true;
      }
      
      const featureName = args[1]?.toLowerCase();
      const action = args[2]?.toLowerCase();
      const validFeatures = ['ai', 'lens', 'brat', 'totalchat', 'rvo', 'freegames'];
      
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
        fromMe: contextInfo.participant === sock.user.id.split(':')[0] + '@s.whatsapp.net',
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
}
