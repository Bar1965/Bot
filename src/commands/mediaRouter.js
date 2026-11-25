/**
 * ROUTER PERINTAH MEDIA
 *
 * Sebelumnya ini 1.736 baris yang bersarang di dalam startBot() di bot.js:
 * satu rantai `if` datar berisi 40 cabang. Isinya sudah lama melenceng dari
 * "media" — ada bank, transfer poin, slot, roulette, tebak-tebakan, menfess,
 * jadwal sholat, dan terjemahan di dalamnya.
 *
 * Perpindahan ini sengaja HANYA memindahkan, tanpa mengubah satu karakter pun
 * di dalam blok, supaya kalau ada yang rusak penyebabnya pasti bukan di sini.
 * Pemecahan per kategori menyusul di langkah berikutnya.
 *
 * Semua milik bot.js (sock, botSettings, helper) masuk lewat `ctx`; modul ini
 * tidak mengimpor bot.js langsung.
 */

import fs from 'fs';
import os from 'os';
import { downloadMediaMessage, jidNormalizedUser } from '@whiskeysockets/baileys';

import { config } from '../../config.js';
import * as db from '../../database.js';
import * as mediaHandler from '../../mediaHandler.js';
import * as ent from '../../entertainmentHandler.js';
import { getPremiumBenefits } from '../../premiumHandler.js';
import { formatTunggu } from '../utils/pembatasLaju.js';
import { createSpotifyLyricsCard, createSpotifyCanvasImage } from '../../cardGenerator.js';
import {
  pasangDukunganStikerSuaraProto,
  deteksiWebpAnimasi,
  hitungDurasiWebpMs,
  buatStikerVideoCepat,
  mediaPunyaTrekAudio,
  ambilInfoAudioProbe,
  siapkanAudioOpusStiker,
  kirimStikerBersuara,
  unboxPesanMedia,
  ambilKonteksQuoted,
  selesaikanAudioCustom,
  bukaSesiStikerSuara
} from '../utils/soundSticker.js';

/**
 * Bongkar pembungkus pesan WhatsApp (ephemeral, viewOnce, viewOnceV2, documentWithCaption)
 * agar media di dalamnya dapat diakses langsung.
 */
function unboxMessage(rawMsg) {
  if (!rawMsg) return null;
  let msg = rawMsg;
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
  return msg;
}

export function createMediaRouter(ctx) {
  pasangDukunganStikerSuaraProto();

  const {
    sock,
    botSettings,
    userPushNamesMap,
    logger,
    formatPhoneNumber,
    sendInteractiveButtons,
    extractTargetJid
  } = ctx;

  // ==========================================
  // FITUR MEDIA UTILITY (DOWNLOADER & CONVERTER)
  // ==========================================
  // ==========================================
  // REM PEMAKAIAN DOWNLOADER
  // ------------------------------------------
  // Sebelum ini tidak ada rem sama sekali: tanpa jeda, tanpa kuota, tanpa batas
  // paralel, dan tanpa batas ukuran berkas di jalur non-yt-dlp. Lima orang
  // mengetik `.yt` bersamaan berarti lima proses yt-dlp + ffmpeg hidup serentak
  // di satu PC yang juga memegang sesi WhatsApp.
  //
  // Hanya perintah yang BENAR-BENAR menarik data dari internet atau memutar
  // ffmpeg yang dibatasi. Stiker, quote, meme, khodam, cuaca, dan terjemahan
  // sengaja dibiarkan bebas supaya obrolan grup tidak ikut tersendat.
  const PERINTAH_MEDIA_BERAT = [
    // pengunduh
    'tt', 'tiktok', 'ttmp3', 'ttaudio', 'ig', 'instagram',
    'yt', 'youtube', 'ytmp3', 'ytmp4', 'fb', 'facebook',
    'pin', 'pinterest', 'tw', 'twitter', 'x', 'play', 'song',
    // pekerjaan berat lain
    'hd', 'remini', 'upscale', 'ssweb', 'ss', 'draw', 'aiimg',
    'tomp3', 'tovn', 'tovid', 'tovideo', 'togif'
  ];

  // Pembatas jumlah unduhan yang boleh berjalan BERSAMAAN. Yang keenam tidak
  // ditolak, hanya menunggu — pemain tetap dilayani, PC-nya saja yang tidak
  // dipaksa menjalankan enam ffmpeg sekaligus.
  const SLOT_UNDUH = { maks: 2, jalan: 0, antre: [] };

  function ambilSlotUnduh() {
    if (SLOT_UNDUH.jalan < SLOT_UNDUH.maks) {
      SLOT_UNDUH.jalan += 1;
      return Promise.resolve();
    }
    return new Promise(resolve => SLOT_UNDUH.antre.push(resolve));
  }

  function lepasSlotUnduh() {
    const berikutnya = SLOT_UNDUH.antre.shift();
    // Slot dioper langsung ke penunggu berikutnya, jadi `jalan` tidak berubah.
    if (berikutnya) berikutnya();
    else SLOT_UNDUH.jalan = Math.max(0, SLOT_UNDUH.jalan - 1);
  }

  const detikRapi = (ms) => Math.max(1, Math.ceil(ms / 1000));

  /**
   * Apakah orang ini masih punya jatah unduhan?
   *
   * Jatah dipotong SAAT PERMINTAAN DITERIMA, bukan saat unduhan berhasil.
   * Unduhan yang gagal tetap sudah menghabiskan kuota internet, RAM, dan waktu
   * CPU — persis sumber daya yang sedang dijatah — dan menggratiskan kegagalan
   * membuat tautan rusak bisa dipakai memutar mesin tanpa batas.
   */
  async function periksaJatahMedia(jid, walletJid, m, cleanCmd) {
    const tier = await db.getPremiumTier(walletJid);
    const benefit = getPremiumBenefits(tier);
    const batasHarian = Number(benefit.mediaDailyLimit) || 15;
    const jedaMs = (Number(benefit.mediaCooldownSec) || 20) * 1000;

    const sisaJeda = await db.getCooldownMs(walletJid, 'MEDIA');
    if (sisaJeda > 0) {
      await sock.sendMessage(jid, {
        text: `⏳ *Sabar sebentar* — tunggu *${detikRapi(sisaJeda)} detik* lagi sebelum unduhan berikutnya.\n\n_Jeda ini menjaga bot tetap responsif untuk semua orang._`
      }, { quoted: m });
      return false;
    }

    const dipakai = await db.getMediaUsageToday(walletJid);
    if (dipakai >= batasHarian) {
      await sock.sendMessage(jid, {
        text: `⚠️ *KUOTA UNDUHAN HARIAN HABIS* (${dipakai}/${batasHarian})\n\nTier kamu: *${tier}*\nKuota berganti otomatis tengah malam WIB.\n\n💎 Butuh lebih banyak? Ketik *.premium*\n🥉 Perunggu *Rp3.000* — 25x/hari\n🥈 Silver Rp5.000 — 30x · 🥇 Gold Rp10.000 — 60x · 💎 Diamond Rp25.000 — 150x`
      }, { quoted: m });
      return false;
    }

    // Jatah harian diperiksa DULU, baru jatah per jam. Kalau urutannya dibalik,
    // orang yang jatah hariannya sudah habis akan disuruh "tunggu 20 menit" lalu
    // kembali dan menabrak tembok yang sama sekali lain — dua kali ditolak untuk
    // satu keadaan.
    const perJam = await db.periksaKuotaMediaJam(walletJid, Number(benefit.mediaPerHour) || 0);
    if (!perJam.boleh) {
      await sock.sendMessage(jid, {
        text: `🕐 *BATAS UNDUHAN PER JAM* (${perJam.dipakai}/${perJam.batas})\n\n` +
          `Slot berikutnya terbuka *${formatTunggu(perJam.tungguDetik)}* lagi.\n` +
          `Sisa jatah hari ini masih *${batasHarian - dipakai}x* — cuma perlu diatur jaraknya.\n\n` +
          `_Tier kamu: ${tier}. Ketik_ \`.premium\` _untuk jatah per jam lebih besar — mulai Rp3.000 (6x/jam)._`
      }, { quoted: m });
      return false;
    }

    await db.incrementMediaUsage(walletJid);
    await db.setCooldown(walletJid, 'MEDIA', jedaMs);
    return true;
  }

  /**
   * Pembungkus tipis di depan handler media yang sebenarnya: memeriksa jatah,
   * lalu memegang satu slot unduhan sampai perintahnya benar-benar selesai.
   */
  async function handleMediaCommands(jid, senderNumber, m, msgText, isAdmin = false, isOwner = false, isStoreAdmin = false, senderNormalizedArg = null) {
    const teks = (msgText || '').trim();
    const isPrefixMedia = teks.startsWith('.') || teks.startsWith('/') || teks.startsWith('#');
    if (!isPrefixMedia) return false;

    const bagian = teks.split(/\s+/);
    const perintah = bagian[0].toLowerCase().replace(/^[./#]/, '');
    const teruskan = () => handleMediaCommandsInti(jid, senderNumber, m, msgText, isAdmin, isOwner, isStoreAdmin, senderNormalizedArg);

    // Owner & Admin Toko tidak dijatah — merekalah yang membayar internetnya.
    if (!PERINTAH_MEDIA_BERAT.includes(perintah) || isOwner || isStoreAdmin) return teruskan();

    // Perintah tanpa bahan apa pun pasti berujung balasan "format salah", jadi
    // jangan potong kuota untuk sesuatu yang tidak pernah mengunduh apa-apa.
    const adaBahan = Boolean(bagian[1])
      || Boolean(m.message?.extendedTextMessage?.contextInfo?.quotedMessage)
      || Boolean(m.message?.imageMessage || m.message?.videoMessage || m.message?.audioMessage);
    if (!adaBahan) return teruskan();

    if (!(await periksaJatahMedia(jid, senderNumber, m, perintah))) return true;

    await ambilSlotUnduh();
    try {
      return await teruskan();
    } finally {
      lepasSlotUnduh();
    }
  }

  async function handleMediaCommandsInti(jid, senderNumber, m, msgText, isAdmin = false, isOwner = false, isStoreAdmin = false, senderNormalizedArg = null) {
    const senderSesi = senderNormalizedArg || senderNumber;
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
        const allowedInSalesGroup = ['owner', 'kontakowner', 'invoice', 'struk'];
        if (!allowedInSalesGroup.includes(cleanCmd)) {
          return false;
        }
      }
    }

    // Gerbang: perintah di luar daftar ini tidak pernah sampai ke rantai di
    // bawah. Daftar ini masih ditulis tangan, jadi wajib ikut diperbarui
    // setiap kali ada cabang baru — sampai pemecahan per kategori nanti
    // membuatnya bisa diturunkan otomatis dari registry.
    const knownMediaCmds = [
      'hd', 'remini', 'upscale', 'stiker', 'sticker', 's', 'gif', 'sgif', 'toimg', 'unstick', 'toimage', 'tovideo', 'tovid', 'togif',
      'stikersuara', 'stickersuara', 'soundsticker', 'stikerbersuara', 'suarastiker', 'stikertandem',
      'addsound', 'simpansound', 'savesound', 'listsound', 'soundlist', 'delsound', 'hapussound',
      'getpp', 'colongpp', 'curipp', 'pp', 'ambilpp', 'stikerpp', 'stickerpp', 'spp',
      'qc', 'quote', 'brat', 'meme', 'smeme', 'draw', 'aiimg',
      'ssweb', 'ss', 'khodam', 'tts', 'shortlink', 'short', 'cuaca', 'invoice', 'struk',
      'tebakgambar', 'susunkata', 'roulette',
      'ping', 'statusbot', 'speed', 'owner', 'kontakowner',
      'tt', 'tiktok', 'ttmp3', 'ttaudio', 'ig', 'instagram', 'yt', 'youtube', 'ytmp3', 'ytmp4',
      'fb', 'facebook', 'pin', 'pinterest', 'tw', 'twitter', 'x', 'play', 'song', 'canvas', 'lirik', 'lyrics', 'tomp3', 'tovn',
      'tr', 'translate', 'jadwalsholat', 'sholat', 'menfess', 'confess', 'balasmenfess', 'menfessreply', 'replymenfess', 'stopmenfess', 'closemenfess', 'endmenfess'
    ];

    if (!knownMediaCmds.includes(cleanCmd)) {
      return false;
    }

    // REGISTRATION CHECK
    const exemptMediaCmds = ['owner', 'kontakowner', 'ping', 'statusbot', 'speed', 'invoice', 'struk'];
    if (!exemptMediaCmds.includes(cleanCmd) && !isAdmin && !isOwner) {
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

    /**
     * Helper universal pengirim media (Mendukung Foto Tunggal, Slide Foto/Carousel, dan Video)
     */
    const sendDownloadedMedia = async (res, defaultTitle = 'Media') => {
      if (!res || !res.success) {
        await react('❌');
        await sock.sendMessage(jid, { text: `❌ ${res?.message || 'Gagal mengunduh media dari link tersebut.'}` }, { quoted: m });
        return false;
      }

      let mediaList = [];
      if (Array.isArray(res.media) && res.media.length > 0) {
        mediaList = res.media;
      } else if (res.buffer || res.videoUrl || res.imageUrl || res.audioUrl) {
        const isAudio = Boolean(res.audioUrl);
        const isVideo = Boolean(res.videoUrl) || res.type === 'video';
        mediaList = [{
          type: isAudio ? 'audio' : (isVideo ? 'video' : 'image'),
          buffer: res.buffer,
          url: res.videoUrl || res.imageUrl || res.audioUrl
        }];
      }

      if (mediaList.length === 0) {
        await react('❌');
        await sock.sendMessage(jid, { text: `❌ Media tidak ditemukan pada postingan ini.` }, { quoted: m });
        return false;
      }

      // Batasi maksimal 10 file per permintaan agar tidak membanjiri antrean WA
      const itemsToSend = mediaList.slice(0, 10);
      const totalItems = itemsToSend.length;

      let terkirim = 0;
      const gagal = [];

      for (let i = 0; i < totalItems; i++) {
        const item = itemsToSend[i];
        const isFirst = terkirim === 0;
        const countInfo = totalItems > 1 ? ` 📸 [${i + 1}/${totalItems}]` : '';
        
        let caption = undefined;
        if (isFirst) {
          const title = res.title ? `📌 *${res.title}*\n` : '';
          const author = res.author ? `👤 *Creator:* ${res.author}\n` : '';
          caption = `${title}${author}✅ *Berhasil diunduh via Akbar Store Bot*${countInfo}`;
        } else if (totalItems > 1) {
          caption = `📸 *${defaultTitle}*${countInfo}`;
        }

        // Semua media disaring lewat gerbang siapkanMediaWA: isi berkas yang
        // menentukan cara kirim, bukan tebakan dari ekstensi URL, dan halaman
        // galat CDN tidak pernah lolos jadi "video" yang tidak bisa dibuka.
        const siap = await mediaHandler.siapkanMediaWA(item);
        if (!siap || !siap.ok) {
          gagal.push(siap);
          continue;
        }

        const kutip = terkirim === 0 ? { quoted: m } : {};
        if (siap.kategori === 'image') {
          await sock.sendMessage(jid, { image: siap.buffer, mimetype: siap.mimetype, caption }, kutip);
        } else if (siap.kategori === 'audio') {
          await sock.sendMessage(jid, { audio: siap.buffer, mimetype: siap.mimetype, fileName: `${defaultTitle}.${siap.ext}` }, kutip);
        } else {
          await sock.sendMessage(jid, {
            video: siap.buffer,
            mimetype: 'video/mp4',
            gifPlayback: siap.gifPlayback || undefined,
            caption
          }, kutip);
        }
        terkirim++;
      }

      // Dulu bot selalu bereaksi ✅ walau tidak satu pun berkas benar-benar
      // terkirim — pengguna mengira berhasil lalu menerima berkas rusak.
      if (terkirim === 0) {
        await react('❌');
        await sock.sendMessage(jid, {
          text: mediaHandler.pesanGagalMedia(gagal[0], defaultTitle)
        }, { quoted: m });
        return false;
      }

      if (gagal.length > 0) {
        await sock.sendMessage(jid, {
          text: `⚠️ ${gagal.length} dari ${totalItems} berkas dilewati karena tidak valid / gagal disiapkan.`
        });
      }

      await react('✅');
      return true;
    };

    // 0. HD Remini Image Upscaler
    if (['hd', 'remini', 'upscale'].includes(cleanCmd)) {
      const quoted = unboxMessage(m.message?.extendedTextMessage?.contextInfo?.quotedMessage);
      const direct = unboxMessage(m.message);

      const isQuotedImage = quoted?.imageMessage || (quoted?.documentMessage?.mimetype?.startsWith('image/'));
      const isDirectImage = direct?.imageMessage || (direct?.documentMessage?.mimetype?.startsWith('image/'));

      if (!isQuotedImage && !isDirectImage) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap kirim/reply foto dengan caption `.hd` atau `.remini` untuk meningkatkan kualitas foto." });
        return true;
      }

      await react('⏳');
      try {
        const targetMessage = isDirectImage ? m : {
          key: {
            remoteJid: jid,
            id: m.message?.extendedTextMessage?.contextInfo?.stanzaId,
            participant: m.message?.extendedTextMessage?.contextInfo?.participant
          },
          message: quoted?.imageMessage ? { imageMessage: quoted.imageMessage } : quoted
        };
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
    
    // 1. TikTok Downloader (.tt, .tiktok, .ttmp3, .ttaudio)
    if (['tt', 'tiktok', 'ttmp3', 'ttaudio'].includes(cleanCmd)) {
      const isAudio = ['ttmp3', 'ttaudio'].includes(cleanCmd);
      let rawUrl = args[1] || (msgText.match(/https?:\/\/[^\s]+/i)?.[0]);
      if (rawUrl) rawUrl = rawUrl.replace(/[)\]}>.,!]+$/, '');
      const url = await mediaHandler.expandCanonicalUrl(rawUrl);
      if (!url || (!url.includes('tiktok.com') && !url.includes('douyin.com'))) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap sertakan link TikTok yang valid.\n\n_Contoh:_ `.tt https://vt.tiktok.com/xxxx`" });
        return true;
      }
      await react('⏳');
      if (isAudio) {
        const res = await mediaHandler.downloadTikTokAudio(url);
        // Mimetype mengikuti ISI berkas, bukan tebakan: menandai data MP3 sebagai
        // `audio/mp4` membuat WhatsApp (terutama iOS) menolak memutarnya.
        const siap = res.success ? await mediaHandler.siapkanMediaWA({ buffer: res.buffer, url: res.audioUrl, type: 'audio' }) : null;
        if (siap?.ok) {
          await sock.sendMessage(jid, {
            audio: siap.buffer,
            mimetype: siap.mimetype,
            fileName: `TikTok_Audio.${siap.ext}`
          });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: res.success ? mediaHandler.pesanGagalMedia(siap, 'Audio TikTok') : `❌ ${res.message || 'Gagal mengambil audio TikTok.'}` });
        }
      } else {
        const res = await mediaHandler.downloadTikTok(url);
        await sendDownloadedMedia(res, 'TikTok Media');
      }
      return true;
    }

    // 2. Instagram Downloader (.ig, .instagram) — Mendukung Foto Tunggal, Slide/Carousel & Video Reels
    if (['ig', 'instagram'].includes(cleanCmd)) {
      let rawUrl = args[1] || (msgText.match(/https?:\/\/[^\s]+/i)?.[0]);
      if (rawUrl) rawUrl = rawUrl.replace(/[)\]}>.,!]+$/, '');
      const url = await mediaHandler.expandCanonicalUrl(rawUrl);
      if (!url || !url.includes('instagram.com')) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap sertakan link Instagram Reels/Post/Foto yang valid.\n\n_Contoh:_ `.ig https://www.instagram.com/p/xxxx`" });
        return true;
      }
      await react('⏳');
      const res = await mediaHandler.downloadInstagram(url);
      await sendDownloadedMedia(res, 'Instagram Media');
      return true;
    }

    // 3. YouTube / Shorts Downloader (.yt, .youtube, .ytmp4, .ytmp3)
    //
    // .play dan .song sengaja TIDAK di sini. Menu menjanjikan judul lagu,
    // sedangkan cabang ini menolak apa pun yang bukan tautan YouTube —
    // pemiliknya cabang pencarian lagu di bawah.
    if (['yt', 'youtube', 'ytmp4', 'ytmp3'].includes(cleanCmd)) {
      const isAudio = cleanCmd === 'ytmp3';
      let rawUrl = args[1] || (msgText.match(/https?:\/\/[^\s]+/i)?.[0]);
      if (rawUrl) rawUrl = rawUrl.replace(/[)\]}>.,!]+$/, '');
      const url = await mediaHandler.expandCanonicalUrl(rawUrl);
      if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
        const cmdExample = isAudio ? '.ytmp3' : '.yt';
        await sock.sendMessage(jid, { text: `⚠️ *Format Salah:* Harap sertakan link YouTube/Shorts yang valid.\n\n_Contoh:_ \`${cmdExample} https://youtu.be/xxxx\`` });
        return true;
      }
      await react('⏳');
      if (isAudio) {
        const res = await mediaHandler.downloadYouTubeAudio(url);
        const siap = res.success ? await mediaHandler.siapkanMediaWA({ buffer: res.buffer, url: res.audioUrl, type: 'audio' }) : null;
        if (siap?.ok) {
          const cleanTitle = (res.title || 'YouTube Audio').replace(/[/\\?%*:|"<>]/g, '');
          await sock.sendMessage(jid, {
            audio: siap.buffer,
            mimetype: siap.mimetype,
            fileName: `${cleanTitle}.${siap.ext}`
          });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: res.success ? mediaHandler.pesanGagalMedia(siap, 'Audio YouTube') : `❌ ${res.message || 'Gagal mengunduh audio YouTube.'}` });
        }
      } else {
        const res = await mediaHandler.downloadYouTube(url);
        // Verifikasi terakhir sebelum kirim: wadah MP4 + codec H.264/AAC. Berkas
        // AV1/VP9/Opus tetap "terunduh" di penerima tapi tidak bisa dibuka.
        const siap = res.success ? await mediaHandler.siapkanMediaWA({ buffer: res.buffer, url: res.videoUrl, type: 'video' }) : null;
        if (siap?.ok) {
          const cleanTitle = (res.title || 'YouTube Video').replace(/[/\\?%*:|"<>]/g, '');
          await sock.sendMessage(jid, {
            video: siap.buffer,
            mimetype: 'video/mp4',
            fileName: `${cleanTitle}.mp4`,
            caption: `🎬 *${res.title || 'YouTube Video'}*\n\n✅ *Berhasil diunduh via Akbar Store Bot*`
          });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: res.success ? mediaHandler.pesanGagalMedia(siap, 'Video YouTube') : `❌ ${res.message || 'Gagal mengunduh video YouTube.'}` });
        }
      }
      return true;
    }

    // 4. Facebook Downloader (.fb, .facebook) — Mendukung Foto & Video Reels
    if (['fb', 'facebook'].includes(cleanCmd)) {
      let rawUrl = args[1] || (msgText.match(/https?:\/\/[^\s]+/i)?.[0]);
      if (rawUrl) rawUrl = rawUrl.replace(/[)\]}>.,!]+$/, '');
      const url = await mediaHandler.expandCanonicalUrl(rawUrl);
      if (!url || (!url.includes('facebook.com') && !url.includes('fb.watch') && !url.includes('fb.com'))) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap sertakan link Facebook Video/Reels/Foto yang valid.\n\n_Contoh:_ `.fb https://fb.watch/xxxx`" });
        return true;
      }
      await react('⏳');
      const res = await mediaHandler.downloadFacebook(url);
      await sendDownloadedMedia(res, 'Facebook Media');
      return true;
    }

    // 5. Pinterest Downloader (.pin, .pinterest) — Mendukung Foto & Video Pinterest
    if (['pin', 'pinterest'].includes(cleanCmd)) {
      let rawUrl = args[1] || (msgText.match(/https?:\/\/[^\s]+/i)?.[0]);
      if (rawUrl) rawUrl = rawUrl.replace(/[)\]}>.,!]+$/, '');
      const url = await mediaHandler.expandCanonicalUrl(rawUrl);
      if (!url || (!url.includes('pinterest.com') && !url.includes('pin.it'))) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap sertakan link Pinterest yang valid.\n\n_Contoh:_ `.pin https://pin.it/xxxx`" });
        return true;
      }
      await react('⏳');
      const res = await mediaHandler.downloadPinterest(url);
      await sendDownloadedMedia(res, 'Pinterest Media');
      return true;
    }

    // 6. Twitter / X Downloader (.tw, .twitter, .x) — Mendukung Foto & Video
    if (['tw', 'twitter', 'x'].includes(cleanCmd)) {
      let rawUrl = args[1] || (msgText.match(/https?:\/\/[^\s]+/i)?.[0]);
      if (rawUrl) rawUrl = rawUrl.replace(/[)\]}>.,!]+$/, '');
      const url = await mediaHandler.expandCanonicalUrl(rawUrl);
      if (!url || (!url.includes('twitter.com') && !url.includes('x.com'))) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap sertakan link Twitter/X yang valid.\n\n_Contoh:_ `.tw https://x.com/username/status/xxxx`" });
        return true;
      }
      await react('⏳');
      const res = await mediaHandler.downloadTwitter(url);
      await sendDownloadedMedia(res, 'Twitter / X Media');
      return true;
    }

    // 5. Stiker / GIF Converter (.stiker, .sticker, .s, .gif, .sgif)
    if (['stiker', 'sticker', 's', 'gif', 'sgif'].includes(cleanCmd)) {
      const quoted = unboxMessage(m.message?.extendedTextMessage?.contextInfo?.quotedMessage);
      const direct = unboxMessage(m.message);

      const hasDirectImage = direct?.imageMessage || (direct?.documentMessage?.mimetype?.startsWith('image/'));
      const hasQuotedImage = quoted?.imageMessage || (quoted?.documentMessage?.mimetype?.startsWith('image/'));
      const hasDirectVideo = direct?.videoMessage;
      const hasQuotedVideo = quoted?.videoMessage;

      const hasImage = hasDirectImage || hasQuotedImage;
      const hasVideo = hasDirectVideo || hasQuotedVideo;
      
      if (!hasImage && !hasVideo) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap kirim foto/video dengan caption `.stiker` atau balas (reply) pesan foto/video dengan `.stiker`!" });
        return true;
      }

      try {
        await react('⏳');
        let targetMessage = m;
        if (!hasDirectImage && !hasDirectVideo && (hasQuotedImage || hasQuotedVideo)) {
          targetMessage = {
            key: {
              remoteJid: jid,
              id: m.message?.extendedTextMessage?.contextInfo?.stanzaId,
              participant: m.message?.extendedTextMessage?.contextInfo?.participant
            },
            message: hasQuotedVideo ? { videoMessage: quoted.videoMessage } : (quoted?.imageMessage ? { imageMessage: quoted.imageMessage } : quoted)
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

    // 5b. Stiker Bersuara / Sound Sticker (.stikersuara, .stickersuara, .soundsticker, .stikertandem)
    if (['stikersuara', 'stickersuara', 'soundsticker', 'stikerbersuara', 'suarastiker', 'stikertandem'].includes(cleanCmd)) {
      const direct = unboxPesanMedia(m.message);
      const { ctxInfo, quoted } = ambilKonteksQuoted(direct);

      const deteksiJenisVisual = (msg) => {
        if (!msg) return null;
        if (msg.videoMessage) return 'video';
        if (msg.imageMessage || msg.documentMessage?.mimetype?.startsWith('image/')) return 'image';
        if (msg.stickerMessage) return 'sticker';
        return null;
      };

      const deteksiSumberAudioMedia = (msg) => {
        if (!msg) return null;
        if (msg.audioMessage || msg.documentMessage?.mimetype?.startsWith('audio/')) return 'audio';
        if (msg.stickerMessage?.audioMessage) return 'sticker_audio';
        if (msg.videoMessage) return 'video';
        return null;
      };

      const buatObjekDownload = (msgObj, apakahDirect) => {
        if (apakahDirect) return m;
        return {
          key: {
            remoteJid: jid,
            id: ctxInfo?.stanzaId,
            participant: ctxInfo?.participant
          },
          message: msgObj
        };
      };

      const tokenArg = args.slice(1);
      const flagTandem = cleanCmd === 'stikertandem' || tokenArg.some(t => ['tandem', '--tandem', 'vn', '--vn'].includes(t.toLowerCase()));
      const modeKirim = flagTandem ? 'tandem' : 'native';
      const teksInput = tokenArg
        .filter(t => !['tandem', '--tandem', 'native', '--native', 'vn', '--vn'].includes(t.toLowerCase()))
        .join(' ')
        .trim();

      const visualDirect = deteksiJenisVisual(direct);
      const visualQuoted = deteksiJenisVisual(quoted);
      const sumberVisual = visualDirect ? { jenis: visualDirect, msg: direct, apakahDirect: true }
        : (visualQuoted ? { jenis: visualQuoted, msg: quoted, apakahDirect: false } : null);

      if (!sumberVisual) {
        await sock.sendMessage(jid, {
          text: "🔊 *CARA PAKAI STIKER BERSUARA* 🎨\n\n" +
            "1️⃣ *Mode Cepat (Video):* Kirim/balas video bersuara dengan `.stikersuara`\n" +
            "2️⃣ *Foto + VN/MP3 Custom:* Kirim/balas foto dengan `.stikersuara`, lalu kirim *Voice Note / MP3* Anda!\n" +
            "3️⃣ *Foto + Link Sound:* Balas foto dengan `.stikersuara https://www.myinstants.com/...` atau link `.mp3`\n" +
            "4️⃣ *Foto + Koleksi Sound:* Balas foto dengan `.stikersuara @nama` (simpan via `.addsound`)\n" +
            "5️⃣ *Foto + Suara Teks:* Balas foto dengan `.stikersuara halo semuanya`\n\n" +
            "💡 _Tips:_ Tambahkan `tandem` (`.stikersuara tandem`) bila HP penerima belum mendukung WhatsApp Sound Sticker native."
        });
        return true;
      }

      try {
        await react('⏳');

        const visualTarget = buatObjekDownload(
          sumberVisual.jenis === 'video' ? { videoMessage: sumberVisual.msg.videoMessage }
            : (sumberVisual.jenis === 'sticker' ? { stickerMessage: sumberVisual.msg.stickerMessage }
              : (sumberVisual.msg.imageMessage ? { imageMessage: sumberVisual.msg.imageMessage } : sumberVisual.msg)),
          sumberVisual.apakahDirect
        );
        const visualBuffer = await downloadMediaMessage(visualTarget, 'buffer', {});

        let stickerBuffer;
        let isAnimated = false;
        let durasiWebpMs = 0;
        if (sumberVisual.jenis === 'sticker') {
          stickerBuffer = visualBuffer;
          const infoStiker = hitungDurasiWebpMs(visualBuffer);
          durasiWebpMs = infoStiker.durasiMs;
          isAnimated = Boolean(sumberVisual.msg.stickerMessage?.isAnimated) || infoStiker.isAnimated;
        } else if (sumberVisual.jenis === 'video') {
          isAnimated = true;
          const stickerRes = await buatStikerVideoCepat(visualBuffer, 'Akbar Store', 'Sound Sticker', 5);
          if (!stickerRes.success || !stickerRes.buffer) {
            await react('❌');
            await sock.sendMessage(jid, { text: `❌ Gagal mengonversi video menjadi stiker: ${stickerRes.message || 'format tidak didukung'}` });
            return true;
          }
          stickerBuffer = stickerRes.buffer;
          durasiWebpMs = stickerRes.durasiMs || 0;
        } else {
          isAnimated = false;
          const stickerRes = await mediaHandler.createSticker(visualBuffer, 'Akbar Store', 'Sound Sticker', false);
          if (!stickerRes.success || !stickerRes.buffer) {
            await react('❌');
            await sock.sendMessage(jid, { text: `❌ Gagal mengonversi media menjadi stiker: ${stickerRes.message || 'format tidak didukung'}` });
            return true;
          }
          stickerBuffer = stickerRes.buffer;
        }

        // Hitung batas durasi audio selaras dengan visual WebP
        let maksDetik = isAnimated ? 5 : 10;
        if (sumberVisual.jenis === 'video' && durasiWebpMs > 0) {
          maksDetik = Math.min(5, durasiWebpMs / 1000);
        } else if (sumberVisual.jenis === 'sticker' && isAnimated && deteksiSumberAudioMedia(sumberVisual.apakahDirect ? quoted : direct) === 'video' && durasiWebpMs >= 1000) {
          maksDetik = Math.min(5, durasiWebpMs / 1000);
        }

        const audioDiPasangan = sumberVisual.apakahDirect
          ? deteksiSumberAudioMedia(quoted)
          : deteksiSumberAudioMedia(direct);

        let adaAudioDariVideoSama = false;
        if (!teksInput && !audioDiPasangan && sumberVisual.jenis === 'video') {
          adaAudioDariVideoSama = await mediaPunyaTrekAudio(visualBuffer);
        }

        const langsungAdaAudio = Boolean(teksInput || audioDiPasangan || adaAudioDariVideoSama);

        if (!langsungAdaAudio) {
          // Masuk ke Sesi 2 Langkah (kirim foto/stiker/GIF dulu -> tunggu VN/MP3/URL/@sound/TTS selama 90 detik)
          bukaSesiStikerSuara({
            jid,
            senderNormalized: senderSesi,
            stickerBuffer,
            isAnimated,
            durasiWebpMs,
            modeKirim,
            dariVideo: sumberVisual.jenis === 'video'
          });
          await react('🎙️');
          await sock.sendMessage(jid, {
            text: "✅ *Foto / Stiker Siap!* _(Menunggu 90 detik)_\n\n" +
              "Sekarang tinggal kirim atau rekam langsung:\n" +
              "• 🎙️ *Voice Note (VN)* / file *MP3 / Audio*\n" +
              "• 🔗 Link *MyInstants* atau link *.mp3*\n" +
              "• 🎵 Nama sound tersimpan (*@nama* — cek `.listsound`)\n" +
              "• 💬 *Teks* (diubah ke suara TTS)\n\n" +
              "_Ketik `batal` untuk membatalkan._"
          }, { quoted: m });
          return true;
        }

        const hasilAudio = await selesaikanAudioCustom({
          teksInput,
          m,
          direct,
          quoted,
          ctxInfo,
          jid,
          apakahVisualDariVideo: sumberVisual.jenis === 'video' && !audioDiPasangan,
          bufferVisualVideo: sumberVisual.jenis === 'video' ? visualBuffer : null,
          maksDetik
        });

        if (!hasilAudio) {
          await react('❌');
          await sock.sendMessage(jid, { text: '❌ Audio tidak ditemukan. Coba kirim foto dulu dengan `.stikersuara`, lalu balas dengan VN/MP3.' });
          return true;
        }

        await kirimStikerBersuara({
          sock,
          jid,
          stickerBuffer,
          oggBuffer: hasilAudio.oggBuffer,
          isAnimated,
          quoted: m,
          mode: modeKirim
        });

        await react('🔊');
      } catch (err) {
        await react('❌');
        console.error('[SOUND_STICKER_ERR]', err.message);
        await sock.sendMessage(jid, {
          text: `❌ Gagal membuat stiker bersuara: ${err.message}\n\n💡 Coba lagi atau pakai ".stikersuara tandem".`
        });
      }
      return true;
    }

    // 5c. Koleksi Sound Custom (.addsound, .listsound, .delsound)
    if (['addsound', 'simpansound', 'savesound'].includes(cleanCmd)) {
      const namaRaw = args[1];
      const sisaTeks = args.slice(2).join(' ').trim();
      const slug = db.normalisasiNamaSound(namaRaw);

      if (!slug) {
        await sock.sendMessage(jid, {
          text: "🎵 *CARA SIMPAN SOUND CUSTOM*\n\n" +
            "1️⃣ Balas VN / MP3 / Video dengan `.addsound nama`\n" +
            "2️⃣ Atau lewat link: `.addsound nama https://www.myinstants.com/...`\n" +
            "3️⃣ Atau teks TTS: `.addsound halo_bos Halo bosku selamat datang`\n\n" +
            "_Pakai ke foto: balas foto dengan `.stikersuara @nama`_"
        }, { quoted: m });
        return true;
      }

      const direct = unboxPesanMedia(m.message);
      const { ctxInfo, quoted } = ambilKonteksQuoted(direct);

      try {
        await react('⏳');
        const hasilAudio = await selesaikanAudioCustom({
          teksInput: sisaTeks,
          m,
          direct,
          quoted,
          ctxInfo,
          jid,
          maksDetik: 10
        });

        if (!hasilAudio) {
          await react('❌');
          await sock.sendMessage(jid, {
            text: "⚠️ Harap balas pesan VN/MP3/Video atau sertakan link MyInstants / teks TTS setelah nama sound!\n_Contoh:_ `.addsound kaget https://www.myinstants.com/...`"
          }, { quoted: m });
          return true;
        }

        const infoProbe = await ambilInfoAudioProbe(hasilAudio.oggBuffer);
        const simpanRes = await db.simpanSoundCustom({
          nama: slug,
          ownerJid: senderSesi,
          oggBuffer: hasilAudio.oggBuffer,
          durasiDetik: infoProbe.durasiDetik || 0,
          forceReplace: isOwner || isAdmin
        });

        if (!simpanRes.success) {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ ${simpanRes.message}` }, { quoted: m });
          return true;
        }

        await react('✅');
        const durasiStr = infoProbe.durasiDetik > 0 ? ` (${infoProbe.durasiDetik.toFixed(1)} dtk)` : '';
        await sock.sendMessage(jid, {
          text: `✅ *Sound Custom ${simpanRes.overwritten ? 'Diperbarui' : 'Tersimpan'}!*\n\n🎵 Nama: *@${simpanRes.nama}*${durasiStr}\n📌 Cara pakai: balas foto/stiker dengan \`.stikersuara @${simpanRes.nama}\``
        }, { quoted: m });
      } catch (err) {
        await react('❌');
        await sock.sendMessage(jid, { text: `❌ Gagal menyimpan sound: ${err.message}` }, { quoted: m });
      }
      return true;
    }

    if (['listsound', 'soundlist'].includes(cleanCmd)) {
      const daftar = await db.daftarSoundCustom(50);
      if (!daftar || daftar.length === 0) {
        await sock.sendMessage(jid, {
          text: "📂 *KOLEKSI SOUND CUSTOM KOSONG*\n\nSimpan sound pertamamu dengan membalas VN/MP3 lalu ketik `.addsound <nama>`!"
        }, { quoted: m });
        return true;
      }
      const baris = daftar.map((it, idx) => {
        const dur = Number(it.durasi_detik) > 0 ? ` (${Number(it.durasi_detik).toFixed(1)}s)` : '';
        return `${idx + 1}. \`@${it.nama}\`${dur}`;
      }).join('\n');

      await sock.sendMessage(jid, {
        text: `🎵 *KOLEKSI SOUND CUSTOM (${daftar.length})*\n\n${baris}\n\n📌 _Cara pakai:_ Balas foto/stiker dengan \`.stikersuara @nama\``
      }, { quoted: m });
      return true;
    }

    if (['delsound', 'hapussound'].includes(cleanCmd)) {
      const targetNama = args[1];
      if (!targetNama) {
        await sock.sendMessage(jid, { text: "⚠️ Gunakan `.delsound <nama>` untuk menghapus sound custom." }, { quoted: m });
        return true;
      }
      const delRes = await db.hapusSoundCustom(targetNama, senderSesi, isOwner || isAdmin);
      if (!delRes.success) {
        await sock.sendMessage(jid, { text: `❌ ${delRes.message}` }, { quoted: m });
        return true;
      }
      await sock.sendMessage(jid, { text: `🗑️ Sound custom *@${delRes.nama}* berhasil dihapus.` }, { quoted: m });
      return true;
    }

    // 5. Sticker to Image (.toimg, /toimg)
    if (['toimg', 'unstick', 'toimage'].includes(cleanCmd)) {
      const quoted = unboxMessage(m.message?.extendedTextMessage?.contextInfo?.quotedMessage);
      const direct = unboxMessage(m.message);
      const stickerMsg = quoted?.stickerMessage || direct?.stickerMessage;

      if (!stickerMsg) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap balas (reply) stiker WhatsApp yang ingin diubah menjadi gambar dengan perintah `.toimg`!" });
        return true;
      }

      try {
        await react('⏳');
        const targetMessage = direct?.stickerMessage ? m : {
          key: {
            remoteJid: jid,
            id: m.message?.extendedTextMessage?.contextInfo?.stanzaId,
            participant: m.message?.extendedTextMessage?.contextInfo?.participant
          },
          message: { stickerMessage: stickerMsg }
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
      let avatarUrl = null;

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

        try {
          avatarUrl = await sock.profilePictureUrl(normalizedParticipant, 'image');
        } catch (_) {}
      } else {
        textToQuote = args.slice(1).join(' ');
        senderName = m.pushName || 'Pelanggan';
        try {
          avatarUrl = await sock.profilePictureUrl(senderNumber, 'image');
        } catch (_) {}
      }

      if (!textToQuote) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Ketik `.qc [TEKS]` atau balas (reply) pesan orang lain dengan `.qc`!\n\n_Contoh:_ `.qc halo ini quote stiker 😂🔥`" });
        return true;
      }

      try {
        await react('⏳');
        const qcRes = await mediaHandler.generateQuoteSticker(senderName, textToQuote, avatarUrl);
        if (qcRes.success && qcRes.buffer) {
          await sock.sendMessage(jid, { sticker: qcRes.buffer });
          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ Gagal membuat quote sticker: ${qcRes.message || 'Terjadi kesalahan sistem'}` });
        }
      } catch (err) {
        await react('❌');
        console.error("[QC_ERR]", err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal membuat Stiker Quote.` });
      }
      return true;
    }

    // 8. Meme Generator (.meme, .smeme, /meme)
    if (['meme', 'smeme'].includes(cleanCmd)) {
      const quoted = unboxMessage(m.message?.extendedTextMessage?.contextInfo?.quotedMessage);
      const direct = unboxMessage(m.message);

      const isQuotedImage = quoted?.imageMessage || (quoted?.documentMessage?.mimetype?.startsWith('image/'));
      const isDirectImage = direct?.imageMessage || (direct?.documentMessage?.mimetype?.startsWith('image/'));

      if (!isQuotedImage && !isDirectImage) {
        await sock.sendMessage(jid, { text: `⚠️ *Format Salah:* Kirim foto dengan caption \`.${cleanCmd} TEKS ATAS | TEKS BAWAH\` atau balas foto orang lain dengan \`.${cleanCmd} TEKS ATAS | TEKS BAWAH\`!` });
        return true;
      }

      const textParam = args.slice(1).join(' ');
      const parts = textParam.split('|');
      const topText = parts[0]?.trim() || '';
      const bottomText = parts[1]?.trim() || '';

      try {
        await react('⏳');
        const targetMessage = isDirectImage ? m : {
          key: {
            remoteJid: jid,
            id: m.message?.extendedTextMessage?.contextInfo?.stanzaId,
            participant: m.message?.extendedTextMessage?.contextInfo?.participant
          },
          message: quoted?.imageMessage ? { imageMessage: quoted.imageMessage } : quoted
        };

        const imageBuffer = await downloadMediaMessage(targetMessage, 'buffer', {});
        const memeRes = await mediaHandler.generateMeme(imageBuffer, topText, bottomText);

        if (memeRes.success && memeRes.buffer) {
          if (cleanCmd === 'smeme') {
            const stickerRes = await mediaHandler.createSticker(memeRes.buffer, 'Sticker Meme', 'Akbar Store', false, false);
            if (stickerRes.success && stickerRes.buffer) {
              await sock.sendMessage(jid, { sticker: stickerRes.buffer });
              await react('✅');
            } else {
              await react('❌');
              await sock.sendMessage(jid, { text: `❌ Gagal mengubah meme ke stiker.` });
            }
          } else {
            await sock.sendMessage(jid, { image: memeRes.buffer, caption: "🎨 *Meme Generator by Akbar Store Bot*" });
            await react('✅');
          }
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

    if (['roulette'].includes(cleanCmd)) {
      const bet = parseInt(args[1]);
      const color = args[2]?.toLowerCase();
      if (!bet || isNaN(bet) || bet < 10 || !['merah', 'hitam', 'hijau'].includes(color)) {
        return await sock.sendMessage(jid, { text: "⚠️ Ketik: .roulette <taruhan> <merah/hitam/hijau>\nContoh: .roulette 50 merah\n\nHitam/Merah: 2x Lipat\nHijau: 10x Lipat" });
      }

      const prof = await db.getGameProfile(senderNumber);
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
        await db.awardGamePoints(senderNumber, winAmount - bet);
      } else {
        await db.deductCustomerPoints(senderNumber, bet, 'Roulette Kalah');
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
        targetJid = senderNumber;
      }

      // Jika di DM dan tidak ada argumen, targetnya adalah diri sendiri atau pengirim
      if (!targetJid && !isGroup) {
        targetJid = senderNumber;
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

    // 19.5. Cek Status & Kecepatan Respon Bot (.ping, .statusbot, .speed)
    if (['ping', 'statusbot', 'speed'].includes(cleanCmd)) {
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

    // 21. Cari & Download Lagu (.song, .play)
    // 21. Cari & Unduh Lagu / Spotify Offline Player (.play, .song, .canvas)
    if (['song', 'play', 'canvas'].includes(cleanCmd)) {
      let isVideoMode = cleanCmd === 'canvas';
      let isZipMode = false;
      let query = '';

      if (cleanCmd === 'canvas') {
        query = args.slice(1).join(' ').trim();
      } else {
        const sub = (args[1] || '').toLowerCase();
        if (sub === 'video' || sub === 'canvas') {
          isVideoMode = true;
          query = args.slice(2).join(' ').trim();
        } else if (sub === 'zip' || sub === 'bundle') {
          isZipMode = true;
          query = args.slice(2).join(' ').trim();
        } else {
          query = args.slice(1).join(' ').trim();
        }
      }

      if (!query) {
        await sock.sendMessage(jid, {
          text: `⚠️ *Format Perintah Kurang Lengkap!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📌 *Pilihan Penggunaan:*\n• \`.play <judul>\` — Unduh MP3 + Cover & Lirik tertanam di player\n• \`.play video <judul>\` atau \`.canvas <judul>\` — Video Vertikal 9:16 Spotify Canvas\n• \`.play zip <judul>\` — Paket lengkap ZIP (MP3 + LRC + Cover HD)\n\n_Contoh:_ \`.play Laskar Pelangi\` atau \`.play video Sheila On 7 - Dan\``
        });
        return true;
      }

      try {
        await react('⏳');

        // 1. Ambil preview info lagu dari YouTube
        const songInfo = await mediaHandler.getSongInfo(query);
        const infoTitle = (songInfo.success && songInfo.title) ? songInfo.title : query;
        const infoDuration = songInfo.duration || '-';
        const infoUrl = songInfo.url || (query.match(/https?:\/\/[^\s]+/i)?.[0] || '');
        const targetDownload = songInfo.url || query;

        // 2. Ambil lirik lagu secara cepat (maks 6 detik)
        let lyricsRes = null;
        try {
          const lrcSearchQuery = query.includes(' - ') ? query : `${infoTitle} ${songInfo.artist !== 'Artis' ? songInfo.artist : ''}`.trim();
          lyricsRes = await Promise.race([
            mediaHandler.getSongLyrics(lrcSearchQuery, songInfo.artist),
            new Promise(resolve => setTimeout(() => resolve(null), 6000))
          ]);
        } catch {}

        // 3. Tentukan Judul, Artis, dan Album Resmi:
        // Jika LRCLIB berhasil mencocokkan, metadata LRCLIB (katalog Spotify resmi) 100% otoritatif!
        const finalTitle = (lyricsRes?.title || songInfo.title || query).replace(/[/\\?%*:|"<>]/g, '').trim();
        const finalArtist = (lyricsRes?.artist || (songInfo.artist && songInfo.artist !== 'Artis' ? songInfo.artist : (query.includes(' - ') ? query.split(' - ')[0].trim() : 'Artis'))).replace(/[/\\?%*:|"<>]/g, '').trim();
        const finalAlbum = (lyricsRes?.album || finalTitle).replace(/[/\\?%*:|"<>]/g, '').trim();
        const coverBuf = lyricsRes?.coverBuffer || songInfo.thumbnailBuffer;

        const baseFileName = `${finalArtist} - ${finalTitle}`;
        const mp3FileName = `${baseFileName}.mp3`;
        const lrcFileName = `${baseFileName}.lrc`;

        // MODE A: VIDEO SPOTIFY CANVAS (9:16)
        if (isVideoMode) {
          const canvasImgBuf = await createSpotifyCanvasImage({
            title: finalTitle,
            artist: finalArtist,
            coverBuffer: coverBuf,
            lyricsLines: lyricsRes?.snippetLines || [],
            duration: infoDuration
          });

          const songRes = await mediaHandler.downloadSongBySearch(targetDownload);
          if (songRes.success && songRes.buffer) {
            const canvasVidBuf = await mediaHandler.generateSpotifyCanvasVideo({
              imageBuffer: canvasImgBuf,
              audioBuffer: songRes.buffer,
              duration: 25
            });

            if (canvasVidBuf) {
              await sock.sendMessage(jid, {
                video: canvasVidBuf,
                caption: `🟢 *SPOTIFY CANVAS VIDEO (9:16)* 🟢\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎵 *Judul*  : *${finalTitle}*\n👤 *Artis*  : ${finalArtist}\n⏱️ *Format* : Vertikal 9:16 (Layar Penuh HP / Status WA)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎧 _Spotify Canvas Engine • ${botSettings.botName || 'Akbar Store'}_`
              }, { quoted: m });
              await react('✅');
              return true;
            }
          }
          // Jika video gagal, lanjut fallback ke MP3
        }

        // MODE B: PAKET ZIP LENGKAP
        if (isZipMode) {
          const songRes = await mediaHandler.downloadSongBySearch(targetDownload);
          if (songRes.success && songRes.buffer) {
            const taggedMp3 = await mediaHandler.embedMetadataAndLyricsToMp3({
              audioBuffer: songRes.buffer,
              coverBuffer: coverBuf,
              lyrics: lyricsRes?.lyrics || '',
              syncedLyrics: lyricsRes?.syncedLyrics || '',
              title: finalTitle,
              artist: finalArtist,
              album: finalAlbum
            });

            let lrcContent = lyricsRes?.syncedLyrics || lyricsRes?.lyrics || '';
            if (lrcContent && !lrcContent.includes('[ti:')) {
              lrcContent = `[ti:${finalTitle}]\n[ar:${finalArtist}]\n[al:${finalAlbum}]\n\n${lrcContent}`;
            }

            const zipRes = await mediaHandler.createSongBundleZip({
              mp3Buffer: taggedMp3 || songRes.buffer,
              lrcText: lrcContent,
              coverBuffer: coverBuf,
              title: baseFileName,
              artist: finalArtist
            });

            if (zipRes?.buffer) {
              await sock.sendMessage(jid, {
                document: zipRes.buffer,
                mimetype: 'application/zip',
                fileName: zipRes.fileName,
                caption: `📦 *PAKET SPOTIFY OFFLINE PLAYER (.ZIP)* 📦\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎵 *${finalTitle}*\n👤 *${finalArtist}*\n💽 *${finalAlbum}*\n\n📁 *Isi Arsip Paket:*\n1. 🎧 \`${mp3FileName}\` (Lirik & Cover Tertanam)\n2. 📜 \`${lrcFileName}\` (File Lirik Sinkron untuk Pemutar HP)\n3. 🖼️ \`${baseFileName}_Cover.jpg\` (Cover Resolusi Tinggi)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 _Ekstrak file ini di smartphone Anda untuk pengalaman pemutar musik offline terbaik!_`
              }, { quoted: m });
              await react('✅');
              return true;
            }
          }
        }

        // MODE C: DEFAULT (AUDIO MP3 DENGAN LIRIK & COVER TERTANAM)
        // Render kartu lirik visual
        let spotifyCardBuf = null;
        if (lyricsRes?.success && lyricsRes?.snippetLines?.length) {
          try {
            spotifyCardBuf = await createSpotifyLyricsCard({
              title: finalTitle,
              artist: finalArtist,
              coverBuffer: coverBuf,
              lyricsLines: lyricsRes.snippetLines,
              duration: infoDuration
            });
          } catch {}
        }

        // Siapkan cuplikan lirik yang rapi di preview caption (maksimal 700 karakter)
        let lyricSnippetText = '';
        if (lyricsRes?.lyrics) {
          const rawLines = lyricsRes.lyrics.split('\n').filter(Boolean);
          const topLines = rawLines.slice(0, 8).join('\n');
          lyricSnippetText = topLines.length > 500 ? topLines.slice(0, 500) + '...' : topLines;
          if (rawLines.length > 8) {
            lyricSnippetText += '\n_...(Lirik lengkap sudah tertanam di pemutar musik HP)_';
          }
        }

        const previewText = `🟢 *SPOTIFY OFFLINE PLAYER* 🟢\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📌 *Judul*    : *${finalTitle}*\n👤 *Artis*    : ${finalArtist}\n💽 *Album*    : ${finalAlbum}\n⏱️ *Durasi*   : ${infoDuration}${infoUrl ? `\n🔗 *Sumber*   : ${infoUrl}` : ''}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${lyricSnippetText ? `📜 *LIRIK LAGU (SPOTIFY):*\n${lyricSnippetText}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` : ''}⏳ _Sedang memproses audio MP3 (Cover & Lirik Tertanam)..._`;

        const imageToSend = spotifyCardBuf || songInfo.thumbnailBuffer;
        if (imageToSend) {
          try {
            await sock.sendMessage(jid, {
              image: imageToSend,
              caption: previewText
            }, { quoted: m });
          } catch {
            await sock.sendMessage(jid, { text: previewText }, { quoted: m });
          }
        } else {
          await sock.sendMessage(jid, { text: previewText }, { quoted: m });
        }

        // Unduh lagu MP3
        const songRes = await mediaHandler.downloadSongBySearch(targetDownload);

        if (songRes.success && songRes.buffer) {
          // Tanamkan metadata ID3 Asli (Cover APIC, Lirik USLT & SYLT Sinkron) via NodeID3
          const taggedMp3 = await mediaHandler.embedMetadataAndLyricsToMp3({
            audioBuffer: songRes.buffer,
            coverBuffer: coverBuf,
            lyrics: lyricsRes?.lyrics || '',
            syncedLyrics: lyricsRes?.syncedLyrics || '',
            title: finalTitle,
            artist: finalArtist,
            album: finalAlbum
          });

          // Kirim berkas MP3 sebagai DOKUMEN agar WhatsApp mempertahankan nama file asli
          await sock.sendMessage(jid, {
            document: taggedMp3 || songRes.buffer,
            mimetype: 'audio/mpeg',
            fileName: mp3FileName,
            caption: `🎧 *${finalTitle}*\n👤 *Artis:* ${finalArtist}\n💽 *Album:* ${finalAlbum}\n✅ *Siap diputar di Offline Player HP!*\n\n✨ *Fitur Spotify Offline:*
• Cover album & lirik lagu (USLT & SYLT) sudah tertanam di dalam berkas.
• Kompatibel dengan Poweramp, Samsung Music, Musicolet, Retro Music, Oto Music, dll.

💡 *Tips Poweramp:*
Jika lirik belum muncul otomatis, di layar lirik Poweramp ketuk ikon roda gigi ⚙️ -> centang *Rescan Lyrics Tags* / *Search for embedded lyrics*, atau simpan file \`.lrc\` di folder yang sama dengan MP3.

💡 *Pilihan Format Lainnya:*
• Video Canvas 9:16: Ketik \`.play video ${finalTitle}\`
• Paket Lengkap ZIP: Ketik \`.play zip ${finalTitle}\``
          }, { quoted: m });

          // Kirim juga file lirik sinkron (.lrc) jika tersedia untuk pemutar musik HP
          if (lyricsRes?.syncedLyrics || lyricsRes?.lyrics) {
            try {
              let lrcContent = lyricsRes.syncedLyrics || lyricsRes.lyrics;
              if (lrcContent && !lrcContent.includes('[ti:')) {
                lrcContent = `[ti:${finalTitle}]\n[ar:${finalArtist}]\n[al:${finalAlbum}]\n\n${lrcContent}`;
              }
              const lrcBuffer = Buffer.from(lrcContent, 'utf-8');
              await sock.sendMessage(jid, {
                document: lrcBuffer,
                mimetype: 'text/plain',
                fileName: lrcFileName,
                caption: `📜 *File Lirik Sinkron (${lrcFileName})*\nSimpan di folder yang sama dengan file MP3 agar lirik berjalan otomatis baris demi baris di Poweramp / Musicolet / Retro Music!`
              }, { quoted: m });
            } catch (lrcErr) {
              console.warn('[LRC_SEND_WARN]', lrcErr.message);
            }
          }

          await react('✅');
        } else {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ ${songRes.message || 'Gagal mengunduh berkas audio lagu.'}` }, { quoted: m });
        }
      } catch (err) {
        await react('❌');
        console.error("[SONG_CMD_ERR]", err.message);
        await sock.sendMessage(jid, { text: "❌ Terjadi kesalahan saat memproses lagu." }, { quoted: m });
      }
      return true;
    }

    // 22. Cari Lirik Lagu Ala Spotify (.lirik, .lyrics)
    if (['lirik', 'lyrics'].includes(cleanCmd)) {
      const query = args.slice(1).join(' ').trim();
      if (!query) {
        await sock.sendMessage(jid, { text: "⚠️ *Format Salah:* Harap sertakan judul lagu.\n\n_Contoh:_ `.lirik Laskar Pelangi` atau `.lirik Nidji - Laskar Pelangi`" });
        return true;
      }
      try {
        await react('⏳');
        const lyricsRes = await mediaHandler.getSongLyrics(query);
        if (!lyricsRes.success || !lyricsRes.lyrics) {
          await react('❌');
          await sock.sendMessage(jid, { text: `❌ ${lyricsRes.message || 'Lirik lagu tidak ditemukan.'}` }, { quoted: m });
          return true;
        }

        let cardBuffer = null;
        try {
          cardBuffer = await createSpotifyLyricsCard({
            title: lyricsRes.title,
            artist: lyricsRes.artist,
            coverBuffer: lyricsRes.coverBuffer,
            lyricsLines: lyricsRes.snippetLines,
            duration: '03:45'
          });
        } catch (cardErr) {
          console.warn('[SPOTIFY_CARD_ERR]', cardErr.message);
        }

        const captionLyrics = `🟢 *SPOTIFY LYRICS* 🟢\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎵 *${lyricsRes.title}*\n👤 *${lyricsRes.artist}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${lyricsRes.lyrics}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎧 _Spotify Lyrics Engine • ${botSettings.botName || 'Akbar Store'}_`;

        if (cardBuffer) {
          await sock.sendMessage(jid, {
            image: cardBuffer,
            caption: captionLyrics
          }, { quoted: m });
        } else {
          await sock.sendMessage(jid, { text: captionLyrics }, { quoted: m });
        }
        await react('✅');
      } catch (err) {
        await react('❌');
        console.error('[LIRIK_CMD_ERR]', err.message);
        await sock.sendMessage(jid, { text: "❌ Terjadi kesalahan saat mencari lirik lagu." }, { quoted: m });
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
            // convertVideoToAudio menghasilkan MP3 sungguhan (libmp3lame),
            // jadi mimetype-nya harus audio/mpeg, bukan audio/mp4.
            mimetype: 'audio/mpeg',
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
    function isMenfessParticipant(session, userJid) {
      if (!session || !userJid) return false;
      const cleanUser = String(userJid).replace(/:[0-9]+@/, '@').trim();
      const cleanSender = String(session.sender_jid || '').replace(/:[0-9]+@/, '@').trim();
      const cleanTarget = String(session.target_jid || '').replace(/:[0-9]+@/, '@').trim();
      if (session.sender_jid === userJid || session.target_jid === userJid) return true;
      if (cleanSender === cleanUser || cleanTarget === cleanUser) return true;
      const digits = db.normalizePhoneDigits(userJid);
      const sDigits = db.normalizePhoneDigits(session.sender_jid);
      const tDigits = db.normalizePhoneDigits(session.target_jid);
      if (digits && digits.length >= 7) {
        if (db.isPhoneMatch(digits, sDigits) || db.isPhoneMatch(digits, tDigits)) return true;
      }
      return false;
    }

    function isMenfessTarget(session, userJid) {
      if (!session || !userJid) return false;
      const cleanUser = String(userJid).replace(/:[0-9]+@/, '@').trim();
      const cleanTarget = String(session.target_jid || '').replace(/:[0-9]+@/, '@').trim();
      if (session.target_jid === userJid || cleanTarget === cleanUser) return true;
      const digits = db.normalizePhoneDigits(userJid);
      const tDigits = db.normalizePhoneDigits(session.target_jid);
      if (digits && digits.length >= 7 && db.isPhoneMatch(digits, tDigits)) return true;
      return false;
    }

    if (['menfess', 'confess'].includes(cleanCmd)) {
      if (isGroup) {
        await sock.sendMessage(jid, { 
          text: "⚠️ *Fitur Menfess Anonim:*\nHarap kirimkan perintah menfess melalui **Chat Pribadi (DM) Bot** agar nomor tujuan dan pesan rahasia Anda tidak terlihat oleh anggota grup lain!" 
        }, { quoted: m });
        return true;
      }

      const fullText = (msgText || '').replace(/^[./#](menfess|confess)\s*/i, '').trim();
      let targetInput = '';
      let messageText = '';

      if (fullText.includes('|')) {
        const parts = fullText.split('|');
        targetInput = parts[0].trim();
        messageText = parts.slice(1).join('|').trim();
      } else if (fullText.includes('\n')) {
        const nlIdx = fullText.indexOf('\n');
        targetInput = fullText.slice(0, nlIdx).trim();
        messageText = fullText.slice(nlIdx + 1).trim();
      } else {
        const parts = fullText.split(/\s+/);
        if (parts.length >= 2) {
          const possibleNum = parts[0].replace(/[^0-9]/g, '');
          if (possibleNum.length >= 9) {
            targetInput = parts[0].trim();
            messageText = parts.slice(1).join(' ').trim();
          }
        }
      }

      if (!targetInput || !messageText) {
        await sendInteractiveButtons(sock, jid, {
          text: "⚠️ *Format Perintah Menfess Salah!*\n\n*Format yang Didukung:*\n▫️ `.menfess <nomor> | <pesan>`\n▫️ `.menfess <nomor>\n<pesan>`\n▫️ `.menfess <nomor> <pesan>`\n\n*Contoh:* `.menfess 08123456789 | Semangat belajarnya ya!`",
          buttons: [
            { type: 'copy', text: '📋 Salin Format Menfess', copy_code: '.menfess 08' }
          ]
        });
        return true;
      }

      let numOnly = targetInput.replace(/[^0-9]/g, '');
      if (numOnly.startsWith('0')) {
        numOnly = '62' + numOnly.slice(1);
      } else if (numOnly.startsWith('8')) {
        numOnly = '628' + numOnly.slice(1);
      }

      if (numOnly.length < 9 || numOnly.length > 16) {
        await sock.sendMessage(jid, { text: "❌ Nomor WhatsApp target tidak valid. Harap masukkan nomor yang benar (contoh: 08123456789 atau 628123456789)." });
        return true;
      }

      let targetJid = `${numOnly}@s.whatsapp.net`;
      try {
        const [waVerified] = await sock.onWhatsApp(targetJid).catch(() => []);
        if (waVerified?.jid) targetJid = waVerified.jid;
      } catch (e) {}

      if (db.isPhoneMatch(targetJid, senderNumber)) {
        await sock.sendMessage(jid, { text: "❌ Kamu tidak bisa mengirim menfess ke nomor kamu sendiri." });
        return true;
      }

      try {
        await react('⏳');
        const sessionId = `MFS-${Math.floor(1000 + Math.random() * 9000)}`;
        await db.createMenfessSession(sessionId, senderNumber, targetJid);

        let menfessMsg = `💌 *MENFESS / CONFESS (PESAN ANONIM)* 💌\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `Halo! Kamu menerima pesan rahasia dari seseorang:\n\n` +
          `💬 *"${messageText}"*\n\n` +
          `📌 *ID Sesi Menfess:* \`${sessionId}\`\n\n` +
          `_Kamu bisa membalas pesan rahasia ini secara anonim via bot!_\n` +
          `👉 *Cara Membalas:* Ketik \`.balasmenfess ${sessionId} <pesan kamu>\`\n` +
          `👉 *Akhiri Sesi:* Ketik \`.stopmenfess ${sessionId}\``;

        await sendInteractiveButtons(sock, targetJid, {
          text: menfessMsg,
          buttons: [
            { type: 'copy', text: `✍️ Balas Sesi ${sessionId}`, copy_code: `.balasmenfess ${sessionId} ` },
            { type: 'reply', text: `🛑 Akhiri Sesi`, id: `.stopmenfess ${sessionId}` }
          ]
        });

        await db.addLog("MODERATION", `Anonim (${senderNumber}) mengirim menfess [${sessionId}] ke ${targetJid}`);

        await sendInteractiveButtons(sock, jid, {
          text: `✅ *Menfess Berhasil Terkirim!* Pesan rahasia Anda telah disampaikan ke target secara anonim.\n\n📌 *ID Sesi Menfess:* \`${sessionId}\`\n_Jika penerima membalas, bot akan meneruskan balasannya ke chat ini secara rahasia._`,
          buttons: [
            { type: 'copy', text: `✍️ Kirim Pesan Tambahan`, copy_code: `.balasmenfess ${sessionId} ` },
            { type: 'reply', text: `🛑 Tutup Sesi`, id: `.stopmenfess ${sessionId}` }
          ]
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

      if (!isMenfessParticipant(session, senderNumber)) {
        await sock.sendMessage(jid, { text: `❌ Anda tidak terdaftar dalam sesi Menfess ini.` });
        return true;
      }

      const isReplyFromTarget = isMenfessTarget(session, senderNumber);
      const recipientJid = isReplyFromTarget ? session.sender_jid : session.target_jid;
      const senderLabel = isReplyFromTarget ? "Penerima Pesan" : "Pengirim Anonim";

      try {
        await react('⏳');
        const forwardMsg = `💌 *BALASAN PESAN MENFESS (${session.id})* 💌\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `Pesan balasan dari *${senderLabel}*:\n\n` +
          `💬 *"${replyMessage}"*\n\n` +
          `👉 *Balas kembali:* \`.balasmenfess ${session.id} <pesan>\`\n` +
          `👉 *Akhiri percakapan:* \`.stopmenfess ${session.id}\``;

        await sendInteractiveButtons(sock, recipientJid, {
          text: forwardMsg,
          buttons: [
            { type: 'copy', text: `✍️ Balas Sesi ${session.id}`, copy_code: `.balasmenfess ${session.id} ` },
            { type: 'reply', text: `🛑 Akhiri Sesi`, id: `.stopmenfess ${session.id}` }
          ]
        });

        await db.updateMenfessLastReply(session.id);
        await db.addLog("MODERATION", `Balasan Menfess [${session.id}] diteruskan ke ${recipientJid}`);

        await sendInteractiveButtons(sock, jid, {
          text: `✅ *Balasan Terkirim!* Pesan Anda telah diteruskan secara rahasia (Sesi: \`${session.id}\`).`,
          buttons: [
            { type: 'copy', text: `✍️ Balas Lagi`, copy_code: `.balasmenfess ${session.id} ` },
            { type: 'reply', text: `🛑 Tutup Sesi`, id: `.stopmenfess ${session.id}` }
          ]
        });
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

      if (!isMenfessParticipant(session, senderNumber)) {
        await sock.sendMessage(jid, { text: `❌ Anda tidak berhak menutup sesi Menfess ini.` });
        return true;
      }

      await db.closeMenfessSession(session.id);
      const isTargetEnding = isMenfessTarget(session, senderNumber);
      const otherPartyJid = isTargetEnding ? session.sender_jid : session.target_jid;

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

  return { handleMediaCommands };
}
