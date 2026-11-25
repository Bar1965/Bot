/**
 * UTILITAS STIKER BERSUARA (WHATSAPP SOUND STICKER — WAProto FIELD 26)
 *
 * Menambahkan dukungan encode/decode field `StickerMessage.audioMessage` (tag 26,
 * sesuai skema `WAProto.proto` terbaru untuk WhatsApp Beta 2.26.47.1+) secara
 * runtime tanpa menyentuh `node_modules/` maupun mengganti paket Baileys utama.
 *
 * Juga menyediakan konverter audio OGG Opus mono (`libopus` via `@ffmpeg-installer/ffmpeg`)
 * serta mode tandem (stiker + voice note berurutan) untuk perangkat yang belum
 * menerima rollout stiker bersuara native dari WhatsApp.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import net from 'net';
import dns from 'dns/promises';
import { spawn } from 'child_process';
import axios from 'axios';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import protobuf from 'protobufjs/minimal.js';
import { proto, prepareWAMessageMedia, downloadMediaMessage } from '@whiskeysockets/baileys';
import { Exif } from 'wa-sticker-formatter';
import * as db from '../../database.js';
import * as ent from '../../entertainmentHandler.js';

const TAG_AUDIO_DALAM_STIKER = 26;
const WIRE_TAG_AUDIO_DALAM_STIKER = (TAG_AUDIO_DALAM_STIKER << 3) | 2; // 210

/**
 * Menambal `proto.Message.StickerMessage` di memori agar mendukung
 * field `audioMessage` (field 26) saat encode, decode, fromObject, dan toObject.
 * Aman dipanggil berulang kali (idempoten).
 */
export function pasangDukunganStikerSuaraProto() {
  const StickerMessage = proto?.Message?.StickerMessage;
  const AudioMessage = proto?.Message?.AudioMessage;
  if (!StickerMessage || !AudioMessage) return false;
  if (StickerMessage.__stikerSuaraPatched) return true;

  if (!Object.prototype.hasOwnProperty.call(StickerMessage.prototype, 'audioMessage')) {
    StickerMessage.prototype.audioMessage = null;
  }

  const origEncode = StickerMessage.encode;
  const origDecode = StickerMessage.decode;
  const origFromObject = StickerMessage.fromObject;
  const origToObject = StickerMessage.toObject;

  StickerMessage.encode = function encode(message, writer) {
    const w = origEncode.call(this, message, writer);
    if (message && message.audioMessage != null && Object.prototype.hasOwnProperty.call(message, 'audioMessage')) {
      AudioMessage.encode(message.audioMessage, w.uint32(WIRE_TAG_AUDIO_DALAM_STIKER).fork()).ldelim();
    }
    return w;
  };

  StickerMessage.decode = function decode(reader, length) {
    const r = reader instanceof protobuf.Reader ? reader : protobuf.Reader.create(reader);
    const startPos = r.pos;
    const endPos = length === undefined ? r.len : r.pos + length;
    const message = origDecode.call(this, r, length);

    if (r.buf && endPos > startPos) {
      const r2 = protobuf.Reader.create(r.buf.subarray(startPos, endPos));
      while (r2.pos < r2.len) {
        const tag = r2.uint32();
        if ((tag >>> 3) === TAG_AUDIO_DALAM_STIKER && (tag & 7) === 2) {
          message.audioMessage = AudioMessage.decode(r2, r2.uint32());
        } else {
          r2.skipType(tag & 7);
        }
      }
    }
    return message;
  };

  StickerMessage.fromObject = function fromObject(object) {
    const msg = origFromObject.call(this, object);
    if (object && object.audioMessage != null) {
      msg.audioMessage = AudioMessage.fromObject(object.audioMessage);
    }
    return msg;
  };

  StickerMessage.toObject = function toObject(message, options) {
    const obj = origToObject.call(this, message, options);
    if (message && message.audioMessage != null && Object.prototype.hasOwnProperty.call(message, 'audioMessage')) {
      obj.audioMessage = AudioMessage.toObject(message.audioMessage, options);
    }
    return obj;
  };

  StickerMessage.__stikerSuaraPatched = true;
  return true;
}

/**
 * Mengecek apakah buffer WebP berisi animasi (`ANIM` / `ANMF`).
 */
export function deteksiWebpAnimasi(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return false;
  const headerSlice = buffer.subarray(0, Math.min(buffer.length, 512));
  return headerSlice.includes('ANIM') || headerSlice.includes('ANMF');
}

/**
 * Menghitung durasi aktual animasi WebP (dalam milidetik) dengan menjumlahkan
 * durasi setiap chunk `ANMF`. Menjamin panjang audio persis sama dengan stiker.
 */
export function hitungDurasiWebpMs(webpBuffer) {
  if (!Buffer.isBuffer(webpBuffer) || webpBuffer.length < 16) {
    return { durasiMs: 0, jumlahFrame: 0, isAnimated: false };
  }
  if (webpBuffer.subarray(0, 4).toString('ascii') !== 'RIFF' || webpBuffer.subarray(8, 12).toString('ascii') !== 'WEBP') {
    return { durasiMs: 0, jumlahFrame: 0, isAnimated: deteksiWebpAnimasi(webpBuffer) };
  }

  let pos = 12;
  let jumlahFrame = 0;
  let durasiMs = 0;

  while (pos + 8 <= webpBuffer.length) {
    const tag = webpBuffer.subarray(pos, pos + 4).toString('ascii');
    const sz = webpBuffer.readUInt32LE(pos + 4);
    if (tag === 'ANMF' && pos + 24 <= webpBuffer.length) {
      const durasiFrame = webpBuffer[pos + 20] | (webpBuffer[pos + 21] << 8) | (webpBuffer[pos + 22] << 16);
      durasiMs += durasiFrame;
      jumlahFrame++;
    }
    const lanjut = pos + 8 + sz + (sz & 1);
    if (lanjut <= pos) break;
    pos = lanjut;
  }

  return {
    durasiMs,
    jumlahFrame,
    isAnimated: jumlahFrame > 1 || deteksiWebpAnimasi(webpBuffer)
  };
}

function buatPathSementara(awalan, ekstensi) {
  const tmpDir = path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const unik = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  return path.join(tmpDir, `${awalan}_${unik}.${ekstensi}`);
}

function jalankanFfmpeg(args, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let stderr = '';
    let proc;
    try {
      proc = spawn(ffmpegInstaller.path, args, { timeout: timeoutMs, windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stderr: err.message });
      return;
    }
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => resolve({ code, stderr }));
    proc.on('error', (err) => resolve({ code: -1, stderr: err.message }));
  });
}

/**
 * Memeriksa apakah berkas media (video/audio) memiliki trek audio beserta durasinya.
 */
export async function ambilInfoAudioProbe(buffer) {
  const inPath = buatPathSementara('probe_aud', 'bin');
  try {
    fs.writeFileSync(inPath, buffer);
    const { stderr } = await jalankanFfmpeg(['-hide_banner', '-i', inPath], 20000);
    const adaAudio = /\bAudio:\s+[A-Za-z0-9_]+/i.test(stderr);
    let durasiDetik = 0;
    const mDur = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
    if (mDur) {
      durasiDetik = (Number(mDur[1]) * 3600) + (Number(mDur[2]) * 60) + Number(mDur[3]);
    }
    return { adaAudio, durasiDetik: Number.isFinite(durasiDetik) ? durasiDetik : 0 };
  } finally {
    try {
      if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
    } catch (_) {}
  }
}

/**
 * Memeriksa apakah berkas media (video/audio) memiliki trek audio.
 */
export async function mediaPunyaTrekAudio(buffer) {
  const info = await ambilInfoAudioProbe(buffer);
  return info.adaAudio;
}

/**
 * Bangun argumen filter FFmpeg untuk mengonversi video menjadi kanvas stiker 512x512:
 * - 'blur' (default): latar video zoom+blur 512x512 + video utama utuh di tengah (hilangkan ruang kosong)
 * - 'crop'          : potong tengah penuh 512x512 (aspect ratio increase)
 * - 'full'          : video utuh dengan padding transparan 512x512
 */
export function bangunArgumenFilterStikerVideo({ fps = 10, mode = 'blur', scaleFlags = 'lanczos' } = {}) {
  const fpsAman = Math.max(5, Math.min(15, Number(fps) || 10));
  const modeAman = mode === 'crop' || mode === 'full' ? mode : 'blur';
  const flagsAman = scaleFlags === 'bilinear' ? 'bilinear' : 'lanczos';

  if (modeAman === 'crop') {
    return [
      '-vf',
      `fps=${fpsAman},scale=512:512:flags=${flagsAman}:force_original_aspect_ratio=increase,crop=512:512,setsar=1,format=rgba`
    ];
  }

  if (modeAman === 'full') {
    return [
      '-vf',
      `fps=${fpsAman},scale=512:512:flags=${flagsAman}:force_original_aspect_ratio=decrease,setsar=1,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000`
    ];
  }

  // Terapkan fps & trim pinggir tipis di awal sebelum split agar frame ekstra & garis border sumber hilang.
  // Latar blur memakai scale penuh 512x512 agar warna kiri-kanan/atas-bawah selaras dengan video utama,
  // sementara video utama diberi feather 28px pada sisi yang bertemu blur sehingga tidak muncul garis pemisah.
  const dy = 'min(Y,H-1-Y)/28';
  const dx = 'min(X,W-1-X)/28';
  const alphaExpr =
    `if(lt(H,508),if(lt(W,508),255*min(1,min(${dx},${dy})),255*min(1,${dy})),if(lt(W,508),255*min(1,${dx}),255))`;
  const amanCrop = 'crop=iw-min(4\\,trunc(iw/16)):ih-min(4\\,trunc(ih/16))';
  const filterComplex =
    `[0:v]fps=${fpsAman},${amanCrop},split=2[bg][fg];` +
    `[bg]scale=512:512:flags=bilinear,setsar=1,format=yuv420p,boxblur=28:2,eq=brightness=-0.03:saturation=0.92[bg_blur];` +
    `[fg]scale=512:512:flags=${flagsAman}:force_original_aspect_ratio=decrease,setsar=1,format=yuva444p,` +
    `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='${alphaExpr}'[fg_fit];` +
    `[bg_blur][fg_fit]overlay=(W-w)/2:(H-h)/2,format=rgba[outv]`;

  return ['-filter_complex', filterComplex, '-map', '[outv]'];
}

/**
 * Mengonversi video menjadi stiker WebP animasi 512x512 dengan cepat (~1 detik),
 * menggunakan frame rate konstan (`fps=10`, `-vsync cfr`) dari detik 0,
 * serta mengukur durasi aktual WebP agar audio dapat disinkronkan persis.
 */
export async function buatStikerVideoCepat(videoBuffer, pack = 'Akbar Store', author = 'Sound Sticker', maksDetik = 5, modeVideo = 'blur') {
  if (!Buffer.isBuffer(videoBuffer) || videoBuffer.length === 0) {
    return { success: false, message: 'Buffer video kosong.' };
  }

  const batasDetik = Math.max(1, Math.min(5, Number(maksDetik) || 5)).toFixed(3);
  const inPath = buatPathSementara('ss_vid_in', 'mp4');
  const outPath = buatPathSementara('ss_vid_out', 'webp');

  const jalankanEncodeWebp = async (fps, kualitas, compressionLevel, mode = modeVideo) => {
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
    const filterArgs = bangunArgumenFilterStikerVideo({ fps, mode, scaleFlags: 'bilinear' });
    const args = [
      '-y',
      '-ss', '0',
      '-t', batasDetik,
      '-i', inPath,
      '-t', batasDetik,
      '-vcodec', 'libwebp',
      ...filterArgs,
      '-lossless', '0',
      '-compression_level', String(compressionLevel),
      '-q:v', String(kualitas),
      '-loop', '0',
      '-an',
      '-vsync', 'cfr',
      outPath
    ];
    return await jalankanFfmpeg(args, 45000);
  };

  try {
    fs.writeFileSync(inPath, videoBuffer);

    let resEncode = await jalankanEncodeWebp(10, 35, 2, modeVideo);
    if ((resEncode.code !== 0 || !fs.existsSync(outPath)) && modeVideo === 'blur') {
      resEncode = await jalankanEncodeWebp(10, 35, 2, 'full');
    }
    if (resEncode.code !== 0 || !fs.existsSync(outPath)) {
      const barisAkhir = resEncode.stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
      return { success: false, message: `Konversi stiker video gagal (${barisAkhir || `kode ${resEncode.code}`}).` };
    }

    let rawWebp = fs.readFileSync(outPath);
    // Jaga ukuran WebP animasi tetap di bawah ~920 KB agar tidak ditolak server WhatsApp
    if (rawWebp.length > 920 * 1024) {
      const resKecil = await jalankanEncodeWebp(8, 22, 2);
      if (resKecil.code === 0 && fs.existsSync(outPath)) {
        const kecil = fs.readFileSync(outPath);
        if (kecil.length > 0 && kecil.length < rawWebp.length) {
          rawWebp = kecil;
        }
      }
    }

    const exif = new Exif({ pack, author });
    const finalBuffer = await exif.add(rawWebp);
    const infoWebp = hitungDurasiWebpMs(finalBuffer);

    return {
      success: true,
      buffer: finalBuffer,
      durasiMs: infoWebp.durasiMs,
      jumlahFrame: infoWebp.jumlahFrame
    };
  } catch (err) {
    return { success: false, message: err.message };
  } finally {
    try { if (fs.existsSync(inPath)) fs.unlinkSync(inPath); } catch (_) {}
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
  }
}

/**
 * Mengonversi buffer video/audio apa pun menjadi OGG Opus mono siap WhatsApp
 * dengan durasi pecahan (milidetik presisi) agar persis sama dengan durasi video stiker.
 */
export async function siapkanAudioOpusStiker(audioBuffer, maksDetik = 10) {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw new Error('Buffer audio kosong.');
  }
  const durasiAman = Math.max(0.3, Math.min(10, Number(maksDetik) || 10));
  const durasiStr = durasiAman.toFixed(3);
  const inPath = buatPathSementara('ss_in', 'bin');
  const outPath = buatPathSementara('ss_out', 'ogg');

  try {
    fs.writeFileSync(inPath, audioBuffer);
    const args = [
      '-y',
      '-ss', '0',
      '-t', durasiStr,
      '-i', inPath,
      '-vn',
      '-t', durasiStr,
      ...(durasiAman >= 0.8 ? ['-af', `afade=t=out:st=${Math.max(0, durasiAman - 0.05).toFixed(3)}:d=0.05`] : []),
      '-c:a', 'libopus',
      '-b:a', '48k',
      '-ac', '1',
      '-ar', '48000',
      '-avoid_negative_ts', 'make_zero',
      '-f', 'ogg',
      outPath
    ];

    const { code, stderr } = await jalankanFfmpeg(args, 45000);
    if (code !== 0 || !fs.existsSync(outPath)) {
      const barisAkhir = stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
      throw new Error(`Konversi audio OGG Opus gagal (${barisAkhir || `kode ${code}`}).`);
    }

    const oggBuffer = fs.readFileSync(outPath);
    if (!oggBuffer || oggBuffer.length < 64) {
      throw new Error('Hasil konversi audio kosong atau terlalu pendek.');
    }
    return oggBuffer;
  } finally {
    try {
      if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
    } catch (_) {}
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch (_) {}
  }
}

/**
 * Mengirim stiker bersuara ke WhatsApp dalam mode `native` (embedded `audioMessage`
 * pada `StickerMessage` field 26) atau mode `tandem` (stiker + voice note berurutan).
 */
export async function kirimStikerBersuara({
  sock,
  jid,
  stickerBuffer,
  oggBuffer,
  isAnimated = false,
  quoted = null,
  mode = 'native'
}) {
  if (!sock || !jid) throw new Error('Socket atau JID tujuan tidak valid.');
  if (!Buffer.isBuffer(stickerBuffer) || !Buffer.isBuffer(oggBuffer)) {
    throw new Error('Buffer stiker atau audio tidak valid.');
  }

  pasangDukunganStikerSuaraProto();

  const sendOptions = quoted ? { quoted } : {};

  if (mode === 'tandem') {
    await sock.sendMessage(jid, {
      sticker: stickerBuffer,
      isAnimated: Boolean(isAnimated)
    }, sendOptions);

    await sock.sendMessage(jid, {
      audio: oggBuffer,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true
    });

    return { mode: 'tandem' };
  }

  // Upload audio OGG Opus terlebih dahulu untuk mendapatkan url, mediaKey, sha256, seconds, & waveform
  const preparedAudio = await prepareWAMessageMedia(
    {
      audio: oggBuffer,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true
    },
    { upload: sock.waUploadToServer }
  );

  const audioMsg = preparedAudio?.audioMessage;
  if (!audioMsg) {
    throw new Error('Gagal menyiapkan payload AudioMessage untuk stiker bersuara.');
  }

  const result = await sock.sendMessage(jid, {
    sticker: stickerBuffer,
    isAnimated: Boolean(isAnimated),
    audioMessage: audioMsg
  }, sendOptions);

  return {
    mode: 'native',
    seconds: audioMsg.seconds || null,
    messageId: result?.key?.id || null
  };
}

/**
 * Membuka pembungkus ephemeral / viewOnce / documentWithCaption pesan WhatsApp.
 */
export function unboxPesanMedia(rawMsg) {
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

/**
 * Mengambil contextInfo & pesan quoted dari segala jenis pesan WhatsApp.
 */
export function ambilKonteksQuoted(directMsg) {
  const ctxInfo = directMsg?.extendedTextMessage?.contextInfo ||
                  directMsg?.imageMessage?.contextInfo ||
                  directMsg?.videoMessage?.contextInfo ||
                  directMsg?.documentMessage?.contextInfo ||
                  directMsg?.audioMessage?.contextInfo ||
                  directMsg?.stickerMessage?.contextInfo ||
                  null;
  return {
    ctxInfo,
    quoted: unboxPesanMedia(ctxInfo?.quotedMessage)
  };
}

function apakahIpPrivat(ip) {
  if (!ip) return true;
  const clean = String(ip).replace(/^::ffff:/i, '');
  if (clean === '127.0.0.1' || clean === '::1' || clean === '0.0.0.0') return true;
  if (net.isIPv4(clean)) {
    const parts = clean.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 0) return true;
    return false;
  }
  if (net.isIPv6(clean)) {
    const lower = clean.toLowerCase();
    return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80') || lower === '::';
  }
  return true;
}

async function validasiUrlPublik(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('Format link audio tidak valid.');
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('Hanya link http:// atau https:// yang didukung.');
  }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Alamat host internal tidak diizinkan.');
  }
  if (net.isIP(host)) {
    if (apakahIpPrivat(host)) throw new Error('Alamat IP lokal/privat tidak diizinkan.');
    return u;
  }
  const resolved = await dns.lookup(host).catch(() => null);
  if (!resolved?.address || apakahIpPrivat(resolved.address)) {
    throw new Error('Host tujuan tidak dapat diakses secara publik.');
  }
  return u;
}

/**
 * Mengunduh file audio langsung dari link MP3/OGG/WAV atau halaman MyInstants.
 */
export async function ambilAudioDariUrlAtauMyInstants(rawUrl) {
  const u = await validasiUrlPublik(rawUrl);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  };

  if (u.hostname.toLowerCase().includes('myinstants.com')) {
    const htmlRes = await axios.get(u.toString(), {
      headers,
      timeout: 10000,
      maxContentLength: 2 * 1024 * 1024,
      responseType: 'text'
    });
    const html = String(htmlRes.data || '');
    const mPlay = html.match(/play\(\s*['"]([^'"]+\.(?:mp3|ogg|wav|m4a))['"]/i) ||
                  html.match(/(['"])(\/media\/sounds\/[^'"]+\.(?:mp3|ogg|wav|m4a))\1/i) ||
                  html.match(/https?:\/\/(?:www\.)?myinstants\.com\/media\/sounds\/[^\s"'<>]+?\.(?:mp3|ogg|wav|m4a)/i);
    if (!mPlay) {
      throw new Error('File audio MyInstants tidak ditemukan pada tautan tersebut.');
    }
    const relPath = mPlay[2] || mPlay[1] || mPlay[0];
    const audioUrl = new URL(relPath, 'https://www.myinstants.com').toString();
    await validasiUrlPublik(audioUrl);

    const audRes = await axios.get(audioUrl, {
      headers,
      timeout: 12000,
      maxContentLength: 5 * 1024 * 1024,
      responseType: 'arraybuffer'
    });
    const buf = Buffer.from(audRes.data);
    if (buf.length < 256) throw new Error('Audio dari MyInstants kosong.');
    return { buffer: buf, sumber: 'MyInstants' };
  }

  const res = await axios.get(u.toString(), {
    headers,
    timeout: 15000,
    maxContentLength: 15 * 1024 * 1024,
    responseType: 'arraybuffer'
  });
  const ct = String(res.headers?.['content-type'] || '').toLowerCase();
  if (ct.includes('text/html')) {
    throw new Error('Tautan mengarah ke halaman web, bukan berkas audio langsung (.mp3/.ogg) atau MyInstants.');
  }
  const buf = Buffer.from(res.data);
  const probe = await ambilInfoAudioProbe(buf);
  if (!probe.adaAudio) {
    throw new Error('Tautan tidak berisi trek audio yang dapat diproses.');
  }
  return { buffer: buf, sumber: u.hostname };
}

/**
 * Mengambil sumber audio custom dari teks perintah (link, @nama_sound, atau TTS)
 * maupun dari media audio/video pada pesan saat ini atau pesan yang dibalas.
 */
export async function selesaikanAudioCustom({
  teksInput = '',
  m,
  direct,
  quoted,
  ctxInfo,
  jid,
  apakahVisualDariVideo = false,
  bufferVisualVideo = null,
  maksDetik = 10
}) {
  const bersih = String(teksInput || '').trim();

  // 1. Jika ada input teks dari pengguna (@nama, URL, nama sound tersimpan, atau TTS)
  if (bersih) {
    if (bersih.startsWith('@')) {
      const saved = await db.ambilSoundCustom(bersih);
      if (!saved) {
        throw new Error(`Sound "${bersih}" tidak ditemukan di koleksi. Ketik .listsound untuk melihat daftar.`);
      }
      const oggBuffer = await siapkanAudioOpusStiker(saved.oggBuffer, maksDetik);
      return { oggBuffer, label: `@${saved.nama}` };
    }

    const urlMatch = bersih.match(/^https?:\/\/\S+/i);
    if (urlMatch) {
      const urlData = await ambilAudioDariUrlAtauMyInstants(urlMatch[0]);
      const oggBuffer = await siapkanAudioOpusStiker(urlData.buffer, maksDetik);
      return { oggBuffer, label: urlData.sumber };
    }

    // Jika kata tunggal cocok persis dengan koleksi sound tersimpan, pakai sound itu
    if (!/\s/.test(bersih)) {
      const savedSingkat = await db.ambilSoundCustom(bersih);
      if (savedSingkat) {
        const oggBuffer = await siapkanAudioOpusStiker(savedSingkat.oggBuffer, maksDetik);
        return { oggBuffer, label: `@${savedSingkat.nama}` };
      }
    }

    const ttsRes = await ent.generateTTS(bersih, 'id');
    if (!ttsRes.success || !ttsRes.buffer) {
      throw new Error(ttsRes.message || 'Gagal membuat suara TTS.');
    }
    const oggBuffer = await siapkanAudioOpusStiker(ttsRes.buffer, maksDetik);
    return { oggBuffer, label: 'TTS' };
  }

  // 2. Jika tidak ada teks, cari media audio dari direct atau quoted
  const deteksiAudio = (msg) => {
    if (!msg) return null;
    if (msg.audioMessage || msg.documentMessage?.mimetype?.startsWith('audio/')) return 'audio';
    if (msg.stickerMessage?.audioMessage) return 'sticker_audio';
    if (msg.videoMessage) return 'video';
    return null;
  };

  const jDirect = deteksiAudio(direct);
  const jQuoted = deteksiAudio(quoted);
  const pilihQuoted = Boolean(jQuoted && (!jDirect || apakahVisualDariVideo));
  const jenis = pilihQuoted ? jQuoted : jDirect;
  const msgSrc = pilihQuoted ? quoted : direct;

  if (!jenis || !msgSrc) return null;

  let rawBuf = null;
  if (!pilihQuoted && apakahVisualDariVideo && Buffer.isBuffer(bufferVisualVideo)) {
    rawBuf = bufferVisualVideo;
  } else {
    const payload = jenis === 'sticker_audio'
      ? { audioMessage: msgSrc.stickerMessage.audioMessage }
      : (jenis === 'video'
        ? { videoMessage: msgSrc.videoMessage }
        : (msgSrc.audioMessage ? { audioMessage: msgSrc.audioMessage } : msgSrc));
    const targetObj = (!pilihQuoted && jenis !== 'sticker_audio')
      ? m
      : {
          key: {
            remoteJid: jid,
            id: ctxInfo?.stanzaId,
            participant: ctxInfo?.participant
          },
          message: payload
        };
    rawBuf = await downloadMediaMessage(targetObj, 'buffer', {});
  }

  if (jenis === 'video') {
    const info = await ambilInfoAudioProbe(rawBuf);
    if (!info.adaAudio) {
      throw new Error('Video tidak memiliki trek audio.');
    }
  }

  const oggBuffer = await siapkanAudioOpusStiker(rawBuf, maksDetik);
  return { oggBuffer, label: jenis };
}

// --- SESI INTERAKTIF 2 LANGKAH (.stikersuara di foto -> kirim VN/MP3/URL/@sound/TTS) ---
const stikerSuaraSesiMap = new Map();
const TTL_SESI_STIKER_SUARA_MS = 90 * 1000;

function kunciSesiStikerSuara(jid, senderNormalized) {
  return `${jid}::${senderNormalized}`;
}

export function adaSesiStikerSuaraDiChat(jid) {
  if (stikerSuaraSesiMap.size === 0 || !jid) return false;
  const prefiks = `${jid}::`;
  for (const k of stikerSuaraSesiMap.keys()) {
    if (k.startsWith(prefiks)) return true;
  }
  return false;
}

export function bukaSesiStikerSuara({
  jid,
  senderNormalized,
  stickerBuffer,
  isAnimated = false,
  durasiWebpMs = 0,
  modeKirim = 'native',
  dariVideo = false
}) {
  const key = kunciSesiStikerSuara(jid, senderNormalized);
  const lama = stikerSuaraSesiMap.get(key);
  if (lama?.timeout) clearTimeout(lama.timeout);

  const timeout = setTimeout(() => {
    stikerSuaraSesiMap.delete(key);
  }, TTL_SESI_STIKER_SUARA_MS);

  stikerSuaraSesiMap.set(key, {
    jid,
    senderNormalized,
    stickerBuffer,
    isAnimated: Boolean(isAnimated),
    durasiWebpMs: Number(durasiWebpMs) || 0,
    modeKirim,
    dariVideo: Boolean(dariVideo),
    createdAt: Date.now(),
    timeout
  });
}

function tutupSesiStikerSuara(key) {
  const s = stikerSuaraSesiMap.get(key);
  if (s?.timeout) clearTimeout(s.timeout);
  stikerSuaraSesiMap.delete(key);
}

/**
 * Pencegat sesi langkah ke-2 untuk `.stikersuara`.
 * Langsung mengembalikan `false` bila tidak ada sesi terbuka (nol beban tambahan).
 */
export async function cekSesiStikerSuara(sock, m, senderNormalized, jid, msgText = '') {
  if (stikerSuaraSesiMap.size === 0) return false;

  const key = kunciSesiStikerSuara(jid, senderNormalized);
  const sesi = stikerSuaraSesiMap.get(key);
  if (!sesi) return false;

  const teks = String(msgText || '').trim();
  if (/^[./#]?(batal|cancel|stop)$/i.test(teks)) {
    tutupSesiStikerSuara(key);
    await sock.sendMessage(jid, { text: '✅ Pembuatan stiker bersuara dibatalkan.' }, { quoted: m });
    return true;
  }

  // Biarkan perintah ber-prefix lain (misal .menu atau .stikersuara baru) diproses router normal
  if (/^[./#]/.test(teks)) {
    return false;
  }

  const direct = unboxPesanMedia(m.message);
  const { ctxInfo, quoted } = ambilKonteksQuoted(direct);
  const adaAudioMedia = Boolean(
    direct?.audioMessage ||
    direct?.videoMessage ||
    direct?.documentMessage?.mimetype?.startsWith('audio/') ||
    direct?.stickerMessage?.audioMessage ||
    quoted?.audioMessage ||
    quoted?.videoMessage ||
    quoted?.documentMessage?.mimetype?.startsWith('audio/') ||
    quoted?.stickerMessage?.audioMessage
  );

  // Jika tidak ada media audio dan tidak ada teks, abaikan (misal user cuma kirim stiker lain)
  if (!adaAudioMedia && !teks) {
    return false;
  }

  const react = async (emoji) => {
    try { await sock.sendMessage(jid, { react: { text: emoji, key: m.key } }); } catch (_) {}
  };

  try {
    await react('⏳');

    let maksDetik = sesi.isAnimated ? 5 : 10;
    if (sesi.dariVideo && sesi.durasiWebpMs > 0) {
      maksDetik = Math.min(5, sesi.durasiWebpMs / 1000);
    }

    const hasilAudio = await selesaikanAudioCustom({
      teksInput: adaAudioMedia ? '' : teks,
      m,
      direct,
      quoted,
      ctxInfo,
      jid,
      apakahVisualDariVideo: false,
      maksDetik
    });

    if (!hasilAudio) {
      await react('❌');
      await sock.sendMessage(jid, {
        text: '⚠️ Format suara tidak terbaca. Kirim VN/MP3, link MyInstants, `@nama`, atau teks TTS (ketik `batal` untuk membatalkan).'
      }, { quoted: m });
      return true;
    }

    tutupSesiStikerSuara(key);

    await kirimStikerBersuara({
      sock,
      jid,
      stickerBuffer: sesi.stickerBuffer,
      oggBuffer: hasilAudio.oggBuffer,
      isAnimated: sesi.isAnimated,
      quoted: m,
      mode: sesi.modeKirim
    });

    await react('🔊');
  } catch (err) {
    await react('❌');
    await sock.sendMessage(jid, {
      text: `❌ Gagal memproses sound custom: ${err.message}\n\n_Kirim audio/VN lain atau ketik "batal" untuk keluar._`
    }, { quoted: m });
  }
  return true;
}
