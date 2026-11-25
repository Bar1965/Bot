import { Sticker, StickerTypes, Exif } from 'wa-sticker-formatter';
import sharp from 'sharp';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import igdl from 'instagram-url-direct';
import ytdl from '@distube/ytdl-core';
import fbDownloader from '@renpwn/fb-downloader';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';
import https from 'https';
import { spawn } from 'child_process';
import * as ab from 'ab-downloader';
import * as btch from 'btch-downloader';
import { snapsave } from 'snapsave-media-downloader';
import ruhend from 'ruhend-scraper';
import NodeID3 from 'node-id3';

const httpsAgent = new https.Agent({ rejectUnauthorized: false, family: 4 });

import { isApiHealthy, reportApiSuccess, reportApiFailure, executeWithSelfHealing } from './src/utils/circuitBreaker.js';

// Set FFMPEG Path global agar wa-sticker-formatter & ffmpeg menggunakan binary asli
process.env.FFMPEG_PATH = ffmpegInstaller.path;
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
process.env.YTDL_NO_UPDATE = 'true';

let fontCanvasTerdaftar = false;

/**
 * Daftarkan font Windows/Linux agar `@napi-rs/canvas` tidak jatuh ke fallback `sans-serif`
 * yang sempit dan merusak emoji pada stiker Quote (.qc) maupun Brat (.brat).
 */
function pastikanFontCanvasSiap() {
  if (fontCanvasTerdaftar) return;
  fontCanvasTerdaftar = true;
  const kandidatFont = [
    { paths: ['C:\\Windows\\Fonts\\ARIALN.TTF', '/usr/share/fonts/truetype/liberation/LiberationSansNarrow-Regular.ttf'], family: 'Arial Narrow' },
    { paths: ['C:\\Windows\\Fonts\\ARIALNB.TTF', '/usr/share/fonts/truetype/liberation/LiberationSansNarrow-Bold.ttf'], family: 'Arial Narrow Bold' },
    { paths: ['C:\\Windows\\Fonts\\seguiemj.ttf', '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf'], family: 'Segoe UI Emoji' },
    { paths: ['C:\\Windows\\Fonts\\segoeui.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'], family: 'Segoe UI' }
  ];
  for (const item of kandidatFont) {
    const adaSudah = GlobalFonts.families.some(f => f.family.toLowerCase() === item.family.toLowerCase());
    if (adaSudah) continue;
    for (const fontPath of item.paths) {
      try {
        if (fs.existsSync(fontPath)) {
          GlobalFonts.registerFromPath(fontPath, item.family);
          break;
        }
      } catch (_) {}
    }
  }
}

const FONT_STACK_QC = '"Segoe UI", "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", Arial, sans-serif';
const FONT_STACK_BRAT = '"Arial Narrow", Arial, "Segoe UI Emoji", sans-serif';

/**
 * Ekstraksi shortlink (vt.tiktok.com, vm.tiktok.com, pin.it, youtu.be, fb.watch, dll.)
 * ke URL kanonikal lengkap.
 */
export async function expandCanonicalUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  const isShortlink = /vt\.tiktok\.com|vm\.tiktok\.com|v\.tiktok\.com|tiktok\.com\/t\/|pin\.it|fb\.watch|youtu\.be|t\.co|bit\.ly|tinyurl\.com|s\.id|v\.gd|cutt\.ly|shorturl\.at|instagram\.com\/share/i.test(rawUrl);
  if (!isShortlink) return rawUrl;

  try {
    const res = await axios.get(rawUrl, {
      headers: { 'User-Agent': getRandomUserAgent() },
      maxRedirects: 8,
      timeout: 7000,
      validateStatus: () => true
    });
    const finalUrl = res.request?.res?.responseUrl || res.config?.url;
    if (finalUrl && finalUrl.startsWith('http') && finalUrl !== rawUrl) {
      console.log(`[URL_RESOLVER] 🔗 Berhasil ekspansi shortlink: ${rawUrl} -> ${finalUrl}`);
      return finalUrl;
    }
  } catch (err) {
    console.log(`[URL_RESOLVER] Gagal ekspansi shortlink ${rawUrl}:`, err.message);
  }
  return rawUrl;
}

/**
 * Bersihkan URL TikTok dari query parameter pelacak (_r=1, _t=..., utm_source, dll.)
 * agar scraper pihak ketiga menerima URL murni yang stabil.
 */
export function bersihkanUrlTiktok(url) {
  if (!url || typeof url !== 'string') return url;
  try {
    const u = new URL(url);
    if (u.hostname.includes('tiktok.com')) {
      if (/\/(?:video|photo)\/\d+/i.test(u.pathname)) {
        return `${u.origin}${u.pathname}`;
      }
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Auto-Update Engine untuk yt-dlp
 * Menjalankan background update python -m pip install -U yt-dlp secara mandiri.
 */
export async function autoUpdateYtdlp() {
  console.log('[AUTO_UPDATE] 🔄 Memeriksa & memperbarui dependensi yt-dlp di background...');
  runPythonProc(['-m', 'pip', 'install', '-U', 'yt-dlp'], 120000).then(res => {
    if (res && res.code === 0) {
      console.log('[AUTO_UPDATE] ✅ Engine yt-dlp berhasil diperbarui ke versi paling baru!');
    }
  }).catch(() => {});
}

// Jalankan pembaruan otomatis saat startup
autoUpdateYtdlp();


const DEFAULT_USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
  return DEFAULT_USER_AGENTS[Math.floor(Math.random() * DEFAULT_USER_AGENTS.length)];
}

/**
 * Helper eksekusi runner Python (Mencoba python -> py -> python3 secara fleksibel)
 *
 * Interpreter yang berhasil di-cache. Sebelumnya setiap pemanggilan memutar ulang
 * seluruh daftar runner selama exit code bukan 0 — artinya satu unduhan yt-dlp yang
 * gagal diulang TIGA kali penuh (3 x timeout) sebelum menyerah, dan hasil proses
 * dengan exit code bukan 0 dibuang walau berkasnya sebenarnya sudah jadi.
 */
let pythonRunnerCache = null;

function spawnProc(runner, args, timeout) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let proc;
    try {
      // PYTHONIOENCODING wajib: tanpa ini Python di Windows menulis stdout memakai
      // codepage konsol, jadi judul ber-Unicode (tanda kutip miring, emoji, aksara
      // non-Latin) sampai ke sini sebagai karakter rusak.
      proc = spawn(runner, args, {
        timeout,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      });
    } catch (err) {
      resolve(null);
      return;
    }

    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      resolve({ code, stdout, stderr, runner });
    });

    proc.on('error', () => {
      resolve(null);
    });
  });
}

async function resolvePythonRunner() {
  if (pythonRunnerCache) return pythonRunnerCache;
  for (const runner of ['python', 'py', 'python3']) {
    const probe = await spawnProc(runner, ['-c', 'import yt_dlp'], 20000);
    if (probe && probe.code === 0) {
      pythonRunnerCache = runner;
      return runner;
    }
  }
  // Tidak ada interpreter dengan yt_dlp: pakai `python` apa adanya supaya
  // `pip install -U yt-dlp` di autoUpdateYtdlp tetap punya kesempatan jalan.
  for (const runner of ['python', 'py', 'python3']) {
    const probe = await spawnProc(runner, ['-V'], 10000);
    if (probe && probe.code === 0) {
      pythonRunnerCache = runner;
      return runner;
    }
  }
  return null;
}

/**
 * Menjalankan perintah Python. Hasil dikembalikan APA ADANYA (termasuk exit code
 * bukan 0) supaya pemanggil bisa memeriksa stdout/berkas keluaran sendiri —
 * yt-dlp sering keluar dengan kode 1 padahal berkasnya sudah lengkap.
 */
async function runPythonProc(args, timeout = 45000) {
  const runner = await resolvePythonRunner();
  if (!runner) return null;

  const result = await spawnProc(runner, args, timeout);
  if (result) return result;

  // Runner cache basi (mis. Python dipindah/di-uninstall) — deteksi ulang sekali.
  pythonRunnerCache = null;
  const retryRunner = await resolvePythonRunner();
  if (!retryRunner || retryRunner === runner) return null;
  return await spawnProc(retryRunner, args, timeout);
}

/**
 * Universal Fetch Buffer — Menghindari 403 Forbidden pada CDN WhatsApp
 */
/** Batas keras satu berkas yang boleh ditarik ke memori (byte). */
export const BATAS_UNDUH_BYTE = 50 * 1024 * 1024;

export async function fetchBuffer(url, opsi = {}) {
  const hasil = await fetchMediaTervalidasi(url, opsi);
  return hasil ? hasil.buffer : null;
}

/**
 * Referer yang cocok per-CDN.
 *
 * pinimg, twimg, cdninstagram, dan tiktokcdn membalas HALAMAN HTML — bukan galat
 * HTTP — kalau Referer-nya asing. Dengan Referer google lama, isi balasan itu
 * tetap berstatus 200 dan panjangnya jauh di atas 3 KB.
 */
function refererUntuk(url) {
  try {
    const host = new URL(url).hostname;
    if (host.includes('pinimg')) return 'https://www.pinterest.com/';
    if (host.includes('cdninstagram')) return 'https://www.instagram.com/';
    if (host.includes('fbcdn')) return 'https://www.facebook.com/';
    if (host.includes('tiktok')) return 'https://www.tiktok.com/';
    if (host.includes('twimg')) return 'https://twitter.com/';
    if (host.includes('googlevideo') || host.includes('ytimg')) return 'https://www.youtube.com/';
    return 'https://www.google.com/';
  } catch {
    return 'https://www.google.com/';
  }
}

/**
 * Unduh SEKALIGUS pastikan yang terunduh memang berkas media.
 *
 * INI AKAR MASALAH "sudah terunduh tapi tidak bisa dibuka / tidak valid":
 * versi lama meloloskan apa pun yang panjangnya > 3000 byte. Halaman login
 * Instagram, halaman "video unavailable" TikTok, dan JSON galat dari API pihak
 * ketiga semuanya lolos, lalu diunggah ke WhatsApp sebagai video/foto. WhatsApp
 * tidak memeriksa isi — penerima mengunduh berkas HTML bernama .mp4 dan
 * pemutarnya bilang berkasnya rusak.
 */
export async function fetchMediaTervalidasi(url, opsi = {}) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  try {
    const res = await axios.get(url, {
      httpsAgent,
      responseType: 'arraybuffer',
      timeout: opsi.timeout || 60000,
      maxRedirects: 10,
      // `arraybuffer` menarik SELURUH isi respons ke memori. Tanpa dua batas ini
      // satu tautan ke berkas besar cukup untuk membengkakkan proses yang sama
      // yang memegang sesi WhatsApp - dan satu-satunya penjaga sebelumnya cuma
      // timeout 30 detik, yang di koneksi cepat justru berarti lebih banyak byte.
      // Jalur yt-dlp sudah dijaga --max-filesize; jalur inilah yang dipakai
      // TikTok, Instagram, Facebook, Twitter, dan Pinterest.
      maxContentLength: BATAS_UNDUH_BYTE,
      maxBodyLength: BATAS_UNDUH_BYTE,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
        'Referer': opsi.referer || refererUntuk(url)
      }
    });

    const buf = res.data ? Buffer.from(res.data) : null;
    if (!buf || buf.length < 1024) return null;

    const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
    if (/text\/html|application\/json|text\/plain|application\/xml/.test(contentType)) {
      console.log('[MEDIA_HANDLER] Ditolak: server membalas', contentType, '(bukan media) —', url.slice(0, 90));
      return null;
    }

    const jenis = deteksiJenisMedia(buf);
    if (!jenis) {
      console.log('[MEDIA_HANDLER] Ditolak: isi berkas bukan media yang dikenali —', url.slice(0, 90));
      return null;
    }
    return { buffer: buf, jenis };
  } catch (err) {
    console.log('[MEDIA_HANDLER] fetchBuffer error:', err.message);
    return null;
  }
}

/**
 * Ekstraksi Metadata Lengkap (Foto, Carousel, Video) via yt-dlp JSON Dump
 */
async function extractWithYtdlpJson(url) {
  const cookiesPath = path.join(process.cwd(), 'ig_cookies.txt');
  const hasCookies = fs.existsSync(cookiesPath);
  const args = [
    '-m', 'yt_dlp',
    '--dump-single-json',
    '--no-warnings',
    '--no-playlist',
    '--geo-bypass',
    ...(hasCookies ? ['--cookies', cookiesPath] : []),
    url
  ];

  const res = await runPythonProc(args, 25000);
  if (res && res.stdout) {
    try {
      const data = JSON.parse(res.stdout.trim());
      return data;
    } catch (e) {}
  }
  return null;
}

/**
 * Profil format ramah WhatsApp.
 *
 * PENTING: tanpa penyaring `vcodec`, urutan bawaan yt-dlp menaruh AV1 di atas VP9
 * di atas H.264 — jadi selektor lama (`bv*[height<=720][ext=mp4]`) memilih av01
 * karena YouTube memang menaruh AV1 di dalam wadah .mp4. Berkasnya terunduh utuh,
 * tapi WhatsApp tidak bisa memutar AV1/VP9/Opus: itulah "sudah didownload tapi
 * tidak bisa dibuka". Rantai di bawah memaksa H.264 (avc1) + AAC (mp4a) dulu,
 * baru turun ke pilihan lain sebagai jaring pengaman.
 */
const FORMAT_VIDEO_WA = [
  'bv*[vcodec^=avc1][height<=720][protocol^=http]+ba[acodec^=mp4a][protocol^=http]',
  'bv*[vcodec^=avc1][height<=720]+ba[acodec^=mp4a]',
  'bv*[vcodec^=avc1][height<=720]+ba',
  'b[vcodec^=avc1][height<=720]',
  'bv*[height<=720][ext=mp4]+ba[ext=m4a]',
  'b[ext=mp4]',
  'bv*[height<=720]+ba',
  'b'
].join('/');

// Audio: utamakan m4a/AAC asli agar konversi ke MP3 tidak melewati Opus.
const FORMAT_AUDIO_WA = 'ba[acodec^=mp4a]/ba[ext=m4a]/ba/b';

/**
 * Batas berkas yang masih aman dikirim ke WhatsApp.
 * `--max-filesize 48M` hanya berlaku PER format, jadi video 720p + audio yang
 * digabung bisa tembus dua kali lipat. Tanpa penjaga ini, hasil gabungan dikirim
 * apa adanya lalu ditolak diam-diam di sisi penerima.
 */
const BATAS_KIRIM_WA_BYTE = 48 * 1024 * 1024;

/** Tanda tangan wadah berkas, dibaca dari byte awal (tanpa perlu ffprobe). */
function deteksiWadah(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer.slice(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  if (buffer.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  if (buffer.slice(0, 4).toString('latin1') === 'OggS') return 'ogg';
  if (buffer.slice(0, 3).toString('latin1') === 'ID3') return 'mp3';
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'mp3';
  if (buffer.slice(0, 4).toString('latin1') === 'RIFF') return 'wav';
  return null;
}

/** Buang berkas sementara yt-dlp yang menumpuk (termasuk sisa .part saat gagal). */
function bersihkanSisaUnduhan(tmpDir, prefix) {
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      if (f.startsWith(prefix)) {
        try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
      }
    }
  } catch {}
}

/**
 * Tabel jenis media berdasarkan tanda tangan byte (magic number).
 * Isi berkaslah yang menentukan cara mengirim — BUKAN ekstensi di URL. URL CDN
 * Instagram/Facebook untuk video sering tidak mengandung ".mp4" sama sekali,
 * jadi tebakan lama `url.includes('.mp4')` mengirim video sebagai foto (dan
 * sebaliknya) — penerima dapat "foto" yang tidak bisa dibuka.
 */
const PROFIL_MEDIA = {
  jpg:  { kategori: 'image', mimetype: 'image/jpeg', ext: 'jpg' },
  png:  { kategori: 'image', mimetype: 'image/png', ext: 'png' },
  gif:  { kategori: 'image', mimetype: 'image/gif', ext: 'gif' },
  webp: { kategori: 'image', mimetype: 'image/webp', ext: 'webp' },
  bmp:  { kategori: 'image', mimetype: 'image/bmp', ext: 'bmp' },
  heic: { kategori: 'image', mimetype: 'image/heic', ext: 'heic' },
  mp4:  { kategori: 'video', mimetype: 'video/mp4', ext: 'mp4' },
  webm: { kategori: 'video', mimetype: 'video/webm', ext: 'webm' },
  avi:  { kategori: 'video', mimetype: 'video/x-msvideo', ext: 'avi' },
  flv:  { kategori: 'video', mimetype: 'video/x-flv', ext: 'flv' },
  mp3:  { kategori: 'audio', mimetype: 'audio/mpeg', ext: 'mp3' },
  m4a:  { kategori: 'audio', mimetype: 'audio/mp4', ext: 'm4a' },
  ogg:  { kategori: 'audio', mimetype: 'audio/ogg', ext: 'ogg' },
  wav:  { kategori: 'audio', mimetype: 'audio/wav', ext: 'wav' },
  flac: { kategori: 'audio', mimetype: 'audio/flac', ext: 'flac' }
};

/** Baca wadah berkas dari byte awal. null = bukan media (HTML, JSON, sampah). */
function bacaWadahMedia(buffer) {
  if (!buffer || buffer.length < 16) return null;
  const s = (a, b) => buffer.slice(a, b).toString('latin1');

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (s(1, 4) === 'PNG') return 'png';
  if (s(0, 3) === 'GIF') return 'gif';
  if (s(0, 4) === 'RIFF') {
    const sub = s(8, 12);
    if (sub === 'WEBP') return 'webp';
    if (sub === 'WAVE') return 'wav';
    if (sub === 'AVI ') return 'avi';
    return null;
  }
  if (s(0, 2) === 'BM' && buffer.length > 54) return 'bmp';
  if (s(4, 8) === 'ftyp') {
    const brand = s(8, 12);
    if (brand.startsWith('M4A') || brand.startsWith('M4B')) return 'm4a';
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) return 'heic';
    return 'mp4';
  }
  if (buffer.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  if (s(0, 4) === 'OggS') return 'ogg';
  if (s(0, 4) === 'fLaC') return 'flac';
  if (s(0, 3) === 'FLV') return 'flv';
  if (s(0, 3) === 'ID3') return 'mp3';
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'mp3';
  return null;
}

/** Playlist HLS (.m3u8) / manifes DASH (.mpd) — daftar segmen, bukan berkasnya. */
function adalahManifest(u) {
  return typeof u === 'string' && /\.(m3u8|mpd)(\?|$)/i.test(u);
}

/**
 * Pilih URL berkas LANGSUNG dari hasil dump-json yt-dlp.
 *
 * Versi lama mengambil `formats[formats.length - 1].url` — format TERAKHIR dalam
 * daftar. Di X/Twitter daftar itu berakhir di varian HLS: yang terunduh cuma
 * berkas teks 2 KB berisi daftar segmen, lalu dikirim sebagai .mp4. Persis
 * penyebab ".x" menghasilkan video rusak, padahal format progresif (http-2176,
 * 720p) ada di daftar yang sama.
 */
function pilihUrlLangsung(entry) {
  if (!entry) return null;
  const formats = Array.isArray(entry.formats) ? entry.formats : [];
  const langsung = formats.filter(f =>
    f && f.url &&
    !adalahManifest(f.url) &&
    /^https?$/i.test(String(f.protocol || 'https')) &&
    f.vcodec !== 'none' &&
    f.acodec !== 'none'
  );
  const nilai = (f) => (f.height || 0) * 100000 + (f.tbr || f.abr || 0);
  const terbaik = langsung.sort((a, b) => nilai(b) - nilai(a))[0];
  if (terbaik) return terbaik.url;
  if (entry.url && !adalahManifest(entry.url)) return entry.url;
  return null;
}

/** { wadah, kategori, mimetype, ext } atau null kalau isinya bukan media. */
function deteksiJenisMedia(buffer) {
  const wadah = bacaWadahMedia(buffer);
  if (!wadah || !PROFIL_MEDIA[wadah]) return null;
  return { wadah, ...PROFIL_MEDIA[wadah] };
}

/** Jalankan ffmpeg sekali; true kalau exit code 0. */
function jalankanFfmpeg(args, timeout = 240000) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(ffmpegInstaller.path, args, { timeout, windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    proc.stdout?.on('data', () => {});
    proc.stderr?.on('data', () => {});
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Baca codec berkas lewat `ffmpeg -i` tanpa keluaran (cepat, tidak men-decode).
 * ffmpeg memang keluar dengan kode bukan 0 di sini — info stream tetap tercetak.
 *
 * Wadah .mp4 SAJA tidak cukup: YouTube dan sebagian CDN menaruh AV1/VP9/Opus di
 * dalam wadah .mp4, dan WhatsApp tidak bisa memutarnya. Berkasnya terunduh utuh
 * tapi penerima melihatnya sebagai berkas rusak.
 */
async function probeCodecMedia(filePath) {
  const stderr = await new Promise((resolve) => {
    let teks = '';
    let proc;
    try {
      proc = spawn(ffmpegInstaller.path, ['-hide_banner', '-i', filePath], { timeout: 30000, windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    proc.stderr?.on('data', (d) => { teks += d.toString(); });
    proc.on('close', () => resolve(teks));
    proc.on('error', () => resolve(null));
  });
  if (!stderr) return null;

  const baris = stderr.split(/\r?\n/);
  // "attached pic" = sampul album di dalam berkas audio, bukan trek video.
  const barisVideo = baris.find(l => / Video: /.test(l) && !/attached pic/i.test(l));
  const barisAudio = baris.find(l => / Audio: /.test(l));
  const v = barisVideo && barisVideo.match(/ Video: ([A-Za-z0-9_]+)/);
  const a = barisAudio && barisAudio.match(/ Audio: ([A-Za-z0-9_]+)/);
  if (!v && !a) return null;
  return { vcodec: v ? v[1].toLowerCase() : null, acodec: a ? a[1].toLowerCase() : null };
}

/**
 * Bungkus ulang berkas ke MP4 H.264/AAC.
 *
 * Kalau codec-nya sudah diketahui (`kodek`), hanya trek yang bermasalah yang
 * disandi ulang — trek yang sudah ramah WhatsApp cukup disalin. `-c copy` buta
 * seperti versi lama justru berbahaya: Opus/AV1 disalin apa adanya ke dalam MP4,
 * wadahnya benar tapi isinya tetap tidak bisa diputar.
 */
async function remuxKeMp4(inputPath, kodek = null) {
  const outputPath = `${inputPath}.wa.mp4`;
  const dasar = ['-y', '-i', inputPath, '-movflags', '+faststart'];
  const sandiVideo = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'];

  const percobaan = [];
  if (kodek && (kodek.vcodec || kodek.acodec)) {
    const v = kodek.vcodec === 'h264' ? ['-c:v', 'copy'] : sandiVideo;
    const a = !kodek.acodec ? ['-an'] : (kodek.acodec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k']);
    percobaan.push([...dasar, ...v, ...a, outputPath]);
  } else {
    percobaan.push([...dasar, '-c', 'copy', outputPath]);
  }
  percobaan.push([...dasar, ...sandiVideo, '-c:a', 'aac', '-b:a', '128k', outputPath]);

  for (const args of percobaan) {
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    const ok = await jalankanFfmpeg(args);
    if (ok && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1024) {
      return outputPath;
    }
  }
  try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
  return null;
}

/** Pastikan buffer video benar-benar MP4 H.264/AAC yang bisa diputar WhatsApp. */
async function siapkanVideoMp4(buffer, extAwal = 'mp4') {
  const tmpDir = path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const prefix = `wa_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const inputPath = path.join(tmpDir, `${prefix}.${extAwal}`);

  try {
    fs.writeFileSync(inputPath, buffer);
    const kodek = await probeCodecMedia(inputPath);
    const terbaca = Boolean(kodek && (kodek.vcodec || kodek.acodec));

    // Ada trek audio tapi tidak ada trek video: ini berkas audio yang salah
    // dikira video. Mengirimnya sebagai video menghasilkan pesan video kosong.
    if (terbaca && !kodek.vcodec) return { alasan: 'isi-audio' };

    const wadahOk = extAwal === 'mp4';
    const videoOk = !terbaca || kodek.vcodec === 'h264';
    const audioOk = !terbaca || !kodek.acodec || kodek.acodec === 'aac';
    if (wadahOk && videoOk && audioOk) return { buffer };

    console.log(`[MEDIA_WA] Bungkus ulang ke MP4 H.264/AAC (wadah=${extAwal}, v=${kodek?.vcodec || '?'}, a=${kodek?.acodec || '-'})`);
    const outPath = await remuxKeMp4(inputPath, kodek);
    if (!outPath) return { alasan: 'konversi-video' };
    const hasil = fs.readFileSync(outPath);
    try { fs.unlinkSync(outPath); } catch {}
    return hasil.length > 1024 ? { buffer: hasil } : { alasan: 'konversi-video' };
  } catch (e) {
    console.error('[MEDIA_WA] siapkanVideoMp4 gagal:', e.message);
    return { alasan: 'konversi-video' };
  } finally {
    try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch {}
  }
}

/** GIF tidak didukung WhatsApp sebagai gambar — ubah ke MP4 bergaya GIF. */
async function konversiGifKeMp4(buffer) {
  const tmpDir = path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const prefix = `gif_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const inputPath = path.join(tmpDir, `${prefix}.gif`);
  const outputPath = path.join(tmpDir, `${prefix}.mp4`);

  try {
    fs.writeFileSync(inputPath, buffer);
    const ok = await jalankanFfmpeg([
      '-y', '-i', inputPath,
      '-movflags', '+faststart',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
      '-an', outputPath
    ], 120000);
    if (ok && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1024) {
      return fs.readFileSync(outputPath);
    }
    return null;
  } catch {
    return null;
  } finally {
    try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch {}
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
  }
}

/** WebP/BMP/HEIC bukan format foto WhatsApp — ubah ke JPEG dulu. */
async function keJpeg(buffer) {
  try {
    return await sharp(buffer).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
  } catch (e) {
    console.log('[MEDIA_WA] Konversi gambar ke JPEG gagal:', e.message);
    return null;
  }
}

/**
 * Gerbang tunggal sebelum media apa pun dikirim ke WhatsApp.
 *
 * Menerima { buffer?, url?, type? } dan mengembalikan
 *   { ok: true, kategori, buffer, mimetype, ext, gifPlayback? }  atau
 *   { ok: false, alasan, ukuranMb? }
 *
 * `type` cuma dipakai sebagai PETUNJUK untuk permintaan audio (berkas audio-only
 * kerap datang dalam wadah mp4/webm). Selebihnya isi berkas yang menentukan —
 * label dari API pihak ketiga terlalu sering salah.
 */
export async function siapkanMediaWA(item = {}) {
  const diminta = item.type;
  let buffer = Buffer.isBuffer(item.buffer) ? item.buffer : null;
  let jenis = buffer ? deteksiJenisMedia(buffer) : null;

  if (buffer && !jenis) {
    console.log('[MEDIA_WA] Buffer sumber bukan media yang dikenali — coba unduh ulang dari URL.');
    buffer = null;
  }
  if (!buffer && item.url) {
    const hasil = await fetchMediaTervalidasi(item.url);
    if (hasil) {
      buffer = hasil.buffer;
      jenis = hasil.jenis;
    }
  }
  if (!buffer || !jenis) return { ok: false, alasan: 'bukan-media' };

  if (buffer.length > BATAS_KIRIM_WA_BYTE) {
    return { ok: false, alasan: 'terlalu-besar', ukuranMb: (buffer.length / 1024 / 1024).toFixed(1) };
  }

  if (diminta === 'audio') {
    if (jenis.wadah === 'mp3' || jenis.wadah === 'm4a' || jenis.wadah === 'ogg') {
      return { ok: true, kategori: 'audio', buffer, mimetype: jenis.mimetype, ext: jenis.ext };
    }
    // Wadah mp4 tanpa trek video = m4a (YouTube DASH). Kirim sebagai audio/mp4,
    // bukan audio/mpeg: menandai data AAC sebagai MP3 membuat iOS menolaknya.
    if (jenis.wadah === 'mp4') {
      return { ok: true, kategori: 'audio', buffer, mimetype: 'audio/mp4', ext: 'm4a' };
    }
    const mp3 = await convertVideoToAudio(buffer, 'mp3').catch(() => null);
    if (mp3 && mp3.length > 5000) {
      return { ok: true, kategori: 'audio', buffer: mp3, mimetype: 'audio/mpeg', ext: 'mp3' };
    }
    return { ok: false, alasan: 'konversi-audio' };
  }

  if (jenis.kategori === 'image') {
    if (jenis.wadah === 'jpg' || jenis.wadah === 'png') {
      return { ok: true, kategori: 'image', buffer, mimetype: jenis.mimetype, ext: jenis.ext };
    }
    if (jenis.wadah === 'gif') {
      const mp4 = await konversiGifKeMp4(buffer);
      if (mp4) return { ok: true, kategori: 'video', buffer: mp4, mimetype: 'video/mp4', ext: 'mp4', gifPlayback: true };
    }
    const jpg = await keJpeg(buffer);
    if (jpg && jpg.length > 1024) {
      return { ok: true, kategori: 'image', buffer: jpg, mimetype: 'image/jpeg', ext: 'jpg' };
    }
    return { ok: false, alasan: 'konversi-gambar' };
  }

  if (jenis.kategori === 'audio') {
    // Diminta video/foto tapi isinya trek audio saja — persis berkas yang
    // "terunduh tapi tidak bisa dibuka" itu. Lebih baik gagal terang-terangan.
    return { ok: false, alasan: 'isi-audio' };
  }

  const video = await siapkanVideoMp4(buffer, jenis.ext);
  if (!video.buffer) return { ok: false, alasan: video.alasan || 'konversi-video' };
  if (video.buffer.length > BATAS_KIRIM_WA_BYTE) {
    return { ok: false, alasan: 'terlalu-besar', ukuranMb: (video.buffer.length / 1024 / 1024).toFixed(1) };
  }
  return { ok: true, kategori: 'video', buffer: video.buffer, mimetype: 'video/mp4', ext: 'mp4' };
}

/** Pesan gagal berbahasa manusia untuk tiap `alasan` dari siapkanMediaWA. */
export function pesanGagalMedia(hasil, konteks = 'Media') {
  switch (hasil?.alasan) {
    case 'terlalu-besar':
      return `❌ ${konteks} terlalu besar untuk dikirim lewat WhatsApp (${hasil.ukuranMb} MB, batas ±48 MB).`;
    case 'isi-audio':
      return '❌ Sumbernya hanya berisi jalur audio, bukan video utuh. Coba lagi atau pakai perintah audio.';
    case 'konversi-video':
    case 'konversi-gambar':
    case 'konversi-audio':
      return `❌ ${konteks} berhasil diunduh tapi gagal disiapkan untuk WhatsApp. Coba lagi beberapa saat lagi.`;
    default:
      return '❌ Server sumber tidak mengirim berkas media yang valid (biasanya link kedaluwarsa atau akun privat). Coba lagi dengan link yang baru.';
  }
}

/**
 * Download media via yt-dlp CLI — metode paling andal (disuntikkan FFmpeg location & format gabungan)
 */
async function downloadWithYtdlp(url, isAudio = false) {
  const cookiesPath = path.join(process.cwd(), 'ig_cookies.txt');
  const hasCookies = fs.existsSync(cookiesPath);
  const tmpDir = path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // Template pakai %(ext)s, bukan ekstensi yang dipaksa. Nama berkas yang dipaksa
  // ".mp4"/".mp3" membuat kita tidak pernah tahu wadah aslinya, dan berkas
  // perantara (.f136.mp4 / .part) ikut lolos pemeriksaan existsSync.
  const prefix = `ytdlp_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const outputTemplate = path.join(tmpDir, `${prefix}.%(ext)s`);

  // Dapatkan Judul
  let title = 'YouTube Media';
  try {
    const titleRes = await runPythonProc(['-m', 'yt_dlp', '--get-title', '--no-warnings', '--no-playlist', url], 20000);
    if (titleRes && titleRes.stdout.trim()) {
      title = titleRes.stdout.trim().split('\n')[0];
    }
  } catch (e) {}

  // `--audio-format best` berarti JANGAN konversi — simpan wadah aslinya.
  //
  // Sebelumnya di sini berdiri `--audio-format mp3 --audio-quality 2`, yang
  // mentranskode lossy ke lossy: AAC milik YouTube dibongkar lalu dikodekan ulang
  // jadi MP3. Itu tidak pernah menguntungkan, dan rusaknya ke dua arah — diukur
  // langsung dari dua unduhan nyata:
  //
  //   Klip sederhana 19 detik : AAC 127 kb/s -> MP3 VBR jatuh ke  68 kb/s
  //   Lagu 2 menit 10 detik   : AAC 127 kb/s -> MP3 VBR naik ke  172 kb/s,
  //                             berkasnya 35% LEBIH BESAR (2,0 MB -> 2,7 MB)
  //
  // Pada konten sederhana VBR menjatuhkan bitrate-nya sampai separuh; pada musik
  // ia justru membengkak, dan bit tambahannya dipakai menyimpan artefak kompresi
  // AAC, bukan musiknya. Dua-duanya lebih buruk dari sumbernya.
  //
  // `-x` tetap dipasang: selektor format punya `b` sebagai jaring pengaman
  // terakhir, yang bisa mengembalikan format gabungan (ada trek videonya). Kalau
  // itu terjadi, `-x` mengekstrak audionya — dan karena formatnya 'best',
  // ekstraksi itu tidak ikut mengodekan ulang kalau tidak perlu.
  const formatArgs = isAudio ? [
    '-f', FORMAT_AUDIO_WA,
    '-x',
    '--audio-format', 'best'
  ] : [
    '-f', FORMAT_VIDEO_WA,
    '--merge-output-format', 'mp4',
    // Pastikan atom moov ada di depan; tanpa ini WhatsApp sering hanya
    // menampilkan pemutar yang berputar tanpa pernah mulai.
    '--postprocessor-args', 'Merger+ffmpeg_o:-movflags +faststart'
  ];

  const fileArgs = [
    '-m', 'yt_dlp',
    '--no-warnings',
    '--no-playlist',
    '--geo-bypass',
    '--retries', '3',
    '--fragment-retries', '3',
    '--socket-timeout', '20',
    '--no-mtime',
    '--ffmpeg-location', ffmpegInstaller.path,
    ...formatArgs,
    '--max-filesize', '48M',
    '-o', outputTemplate,
    ...(hasCookies ? ['--cookies', cookiesPath] : []),
    url
  ];

  // 180 detik: 60 detik tidak cukup untuk berkas mendekati 48 MB, dan timeout
  // yang kepagian membuat unduhan yang sebenarnya sehat dianggap gagal.
  const procRes = await runPythonProc(fileArgs, 180000);

  // Jangan bergantung pada exit code — yt-dlp sering keluar bukan 0 (mis. saat
  // --max-filesize memangkas satu format) padahal berkas akhirnya sudah jadi.
  let hasil = null;
  try {
    const urutanExt = isAudio
      // .m4a didahulukan: sejak konversi MP3 dibuang, itulah wadah yang paling
      // sering keluar. .mp3 tetap dicari untuk berkas sisa dari versi lama.
      ? ['.m4a', '.mp3', '.opus', '.ogg', '.webm', '.aac']
      : ['.mp4', '.mkv', '.mov', '.webm'];

    const kandidat = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith(prefix) && !f.endsWith('.part') && !f.endsWith('.ytdl'))
      // Berkas perantara per-format (prefix.f136.mp4, prefix.f140.m4a) HARUS
      // dibuang. Kalau penggabungan gagal yang tersisa hanya trek video saja atau
      // audio saja — persis jenis berkas "terunduh tapi tidak bisa dibuka" itu.
      .filter(f => !/\.f\d+\./.test(f))
      .map(f => path.join(tmpDir, f))
      .filter(p => { try { return fs.statSync(p).size > 5000; } catch { return false; } })
      .sort((a, b) => {
        const ia = urutanExt.indexOf(path.extname(a).toLowerCase());
        const ib = urutanExt.indexOf(path.extname(b).toLowerCase());
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
    hasil = kandidat[0] || null;
  } catch (e) {
    console.error('[YTDLP_SCAN_ERR]', e.message);
  }

  if (hasil) {
    try {
      let berkas = hasil;
      let buffer = fs.readFileSync(berkas);
      const wadah = deteksiWadah(buffer);

      if (buffer.length > BATAS_KIRIM_WA_BYTE) {
        const mb = (buffer.length / 1024 / 1024).toFixed(1);
        return {
          success: false,
          terlaluBesar: true,
          message: `❌ Media terlalu besar untuk dikirim lewat WhatsApp (${mb} MB, batas ±48 MB).\n\n💡 Coba durasi yang lebih pendek${isAudio ? '' : ', atau pakai `.ytmp3` untuk mengambil audionya saja'}.`
        };
      }

      if (isAudio) {
        const mimetype = wadah === 'mp3' ? 'audio/mpeg'
          : wadah === 'mp4' ? 'audio/mp4'
          : wadah === 'ogg' ? 'audio/ogg'
          : 'audio/mpeg';
        return { success: true, buffer, title, mimetype, ext: wadah || 'mp3' };
      }

      // Video: WhatsApp hanya menerima MP4. Kalau yt-dlp terpaksa turun ke
      // webm/mkv, bungkus ulang dulu daripada mengirim berkas yang tidak bisa dibuka.
      if (wadah !== 'mp4') {
        const remuxed = await remuxKeMp4(berkas);
        if (!remuxed) {
          console.error('[YTDLP_REMUX_ERR] Wadah tidak didukung WhatsApp:', wadah);
          return null;
        }
        berkas = remuxed;
        buffer = fs.readFileSync(berkas);
      }

      return { success: true, buffer, title, mimetype: 'video/mp4', ext: 'mp4' };
    } catch (e) {
      console.error('[YTDLP_READ_ERR]', e.message);
    } finally {
      bersihkanSisaUnduhan(tmpDir, prefix);
    }
  }

  bersihkanSisaUnduhan(tmpDir, prefix);

  // Tier 2 Fallback: Direct Stream URL
  const urlArgs = [
    '-m', 'yt_dlp',
    '--get-url',
    '--get-title',
    '--no-warnings',
    '--no-playlist',
    '--geo-bypass',
    '--ffmpeg-location', ffmpegInstaller.path,
    // Selektor lama (`b/best[height<=720]/best`) hanya cocok dengan format
    // gabungan; YouTube modern sering tidak punya satu pun, jadi yt-dlp langsung
    // menjawab "Requested format is not available" dan seluruh perintah gagal.
    '-f', isAudio
      ? 'ba[acodec^=mp4a]/ba/b'
      : 'b[vcodec^=avc1][height<=720]/b[ext=mp4]/b/bv*[vcodec^=avc1][height<=720]',
    ...(hasCookies ? ['--cookies', cookiesPath] : []),
    url
  ];

  const procRes2 = await runPythonProc(urlArgs, 30000);
  if (procRes2 && procRes2.stdout.trim()) {
    const lines = procRes2.stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const urlLines = lines.filter(l => l.startsWith('http'));
    const titleLine = lines.find(l => !l.startsWith('http')) || title;

    // Lebih dari satu URL berarti yt-dlp memilih video-only + audio-only yang harus
    // digabung. Mengirim salah satunya menghasilkan media bisu / tidak bisa dibuka —
    // versi lama mengambil baris TERAKHIR, yang justru trek audio saja.
    if (urlLines.length === 1) {
      const urlLine = urlLines[0];
      const buf = await fetchBuffer(urlLine);
      return {
        success: true,
        buffer: buf || undefined,
        videoUrl: isAudio ? undefined : urlLine,
        audioUrl: isAudio ? urlLine : undefined,
        title: titleLine,
        mimetype: isAudio ? 'audio/mp4' : 'video/mp4',
        ext: isAudio ? 'm4a' : 'mp4'
      };
    }
    if (urlLines.length > 1) {
      console.log('[YTDLP_TIER2] Dilewati: format terpisah (video+audio), tidak bisa dikirim langsung.');
    }
  }

  const errOutput = `${procRes?.stderr || ''} ${procRes?.stdout || ''} ${procRes2?.stderr || ''}`;
  if (/permission to view this post|Log into an account|Private video|This video is private|requires login|login required|login_required/i.test(errOutput)) {
    return {
      success: false,
      privateOrRestricted: true,
      message: 'Konten ini bersifat pribadi (private) atau dibatasi oleh pemilik akun sehingga tidak dapat diunduh tanpa izin.'
    };
  }
  if (/Video unavailable|This video has been removed|post is unavailable/i.test(errOutput)) {
    return {
      success: false,
      unavailable: true,
      message: 'Media tidak ditemukan atau telah dihapus oleh pemiliknya.'
    };
  }

  return null;
}

/** Ekstrak judul & teks polos dari potongan HTML scraper. */
function bersihkanTeksHtml(teks) {
  return String(teks || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Bentuk payload standar hasil TikTok dari `ab.ttdl` / `ruhend.ttdl` / `btch.ttdl`. */
function bentukHasilTikTokPaket(res, defaultTitle = 'TikTok Media', engine = 'online', isPhotoHint = false) {
  if (!res) return null;
  const title = bersihkanTeksHtml(res.title) || defaultTitle;
  const audioUrl = Array.isArray(res.audio) && res.audio.length > 0 ? res.audio[0] : (typeof res.audio === 'string' ? res.audio : undefined);
  const audioTitle = bersihkanTeksHtml(res.title_audio) || undefined;

  if (Array.isArray(res.images) && res.images.length > 0) {
    return {
      success: true,
      media: res.images.map(img => ({ type: 'image', url: img })),
      audioUrl,
      audioTitle,
      title,
      type: 'carousel',
      engine
    };
  }
  if (Array.isArray(res.video) && res.video.length > 0 && res.video[0]) {
    const semuaFoto = isPhotoHint || res.video.every(u => /photomode|tplv-photomode|\.jpe?g\b|\.png\b|\.webp\b/i.test(String(u)));
    if (semuaFoto) {
      return {
        success: true,
        media: res.video.filter(Boolean).map(u => ({ type: 'image', url: u })),
        audioUrl,
        audioTitle,
        title,
        type: 'carousel',
        engine
      };
    }
    const streamUrl = res.video[0];
    return {
      success: true,
      media: [{ type: 'video', url: streamUrl }],
      videoUrl: streamUrl,
      audioUrl,
      audioTitle,
      title,
      type: 'video',
      engine
    };
  }
  return null;
}

/**
 * Download TikTok Video & Slide Foto tanpa watermark — Offline Utama + Online Backup
 * Untuk slide foto (`/photo/` / carousel), menyertakan `audioUrl` agar foto & audio bisa dikirim terpisah.
 */
export async function downloadTikTok(rawUrl) {
  const url = await expandCanonicalUrl(rawUrl);
  const cleanUrl = bersihkanUrlTiktok(url);
  const isPhoto = cleanUrl.includes('/photo/') || url.includes('/photo/');

  const offlineYtdlpProvider = {
    name: 'Offline TikTok yt-dlp',
    fn: async () => {
      if (isPhoto) return { success: false, message: 'yt-dlp dilewati untuk post foto/slide' };
      const ytdlpResult = await downloadWithYtdlp(cleanUrl, false);
      if (ytdlpResult?.terlaluBesar) return ytdlpResult;
      if (ytdlpResult?.buffer || ytdlpResult?.videoUrl) {
        return {
          success: true,
          media: [{ type: 'video', url: ytdlpResult.videoUrl, buffer: ytdlpResult.buffer }],
          buffer: ytdlpResult.buffer,
          videoUrl: ytdlpResult.videoUrl,
          title: ytdlpResult.title || 'TikTok Video',
          type: 'video',
          engine: 'offline:yt-dlp'
        };
      }
      return {
        success: false,
        privateOrRestricted: ytdlpResult?.privateOrRestricted,
        unavailable: ytdlpResult?.unavailable,
        message: ytdlpResult?.message || 'Offline yt-dlp gagal mengunduh TikTok'
      };
    }
  };

  const tikwmProvider = {
    name: 'Online TikWM API',
    fn: async () => {
      const res = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(cleanUrl)}&hd=1`, {
        headers: { 'User-Agent': getRandomUserAgent() },
        timeout: 12000
      });
      const d = res.data?.data;
      if (res.data?.code === 0 && d) {
        const title = d.title || 'TikTok Media';
        const author = d.author?.nickname || d.author?.unique_id || 'TikTok Creator';
        const audioUrl = d.music || d.music_info?.play || undefined;
        const audioTitle = d.music_info?.title
          ? (d.music_info?.author ? `${d.music_info.title} - ${d.music_info.author}` : d.music_info.title)
          : undefined;

        if (Array.isArray(d.images) && d.images.length > 0) {
          return {
            success: true,
            media: d.images.map(img => ({ type: 'image', url: img })),
            audioUrl,
            audioTitle,
            title,
            author,
            type: 'carousel',
            engine: 'online:tikwm'
          };
        }
        const streamUrl = d.hdplay || d.play || d.wmplay;
        if (streamUrl) {
          return {
            success: true,
            media: [{ type: 'video', url: streamUrl }],
            videoUrl: streamUrl,
            audioUrl,
            audioTitle,
            title,
            author,
            type: 'video',
            engine: 'online:tikwm'
          };
        }
      }
      return { success: false, message: res.data?.msg || 'TikWM tidak menemukan media' };
    }
  };

  const ssstikProvider = {
    name: 'Online SSSTik Scraper',
    fn: async () => {
      const res = await axios.post('https://ssstik.io/abc?url=dl', `id=${encodeURIComponent(cleanUrl)}&locale=en&tt=1`, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': getRandomUserAgent(),
          'Origin': 'https://ssstik.io',
          'Referer': 'https://ssstik.io/en'
        },
        timeout: 10000
      });
      if (res.data && typeof res.data === 'string') {
        const html = res.data;
        const titleMatch = html.match(/<p class="maintext"[^>]*>([\s\S]*?)<\/p>/i);
        const authorMatch = html.match(/<h2>([\s\S]*?)<\/h2>/i);
        const title = bersihkanTeksHtml(titleMatch?.[1]) || 'TikTok Media';
        const author = bersihkanTeksHtml(authorMatch?.[1]) || 'TikTok Creator';
        const audioMatch = html.match(/href="([^"]*(?:tikcdn\.io\/ssstik\/m\/|download_url)[^"]*)"/i) ||
                           html.match(/class="[^"]*music[^"]*"[^>]*href="([^"]+)"/i) ||
                           html.match(/href="([^"]+)"[^>]*class="[^"]*music[^"]*"/i);
        const audioUrl = audioMatch?.[1];

        const slideLinks = [];
        for (const match of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
          const href = match[1];
          const label = bersihkanTeksHtml(match[2]).toLowerCase();
          if (/^(?:download this slide|slide\s*\d+|download slide|slide)$/i.test(label)) {
            slideLinks.push(href);
          }
        }
        if (slideLinks.length > 0) {
          const mediaList = slideLinks.map(u => ({ type: 'image', url: u }));
          return {
            success: true,
            media: mediaList,
            audioUrl,
            title,
            author,
            type: 'carousel',
            engine: 'online:ssstik'
          };
        }

        const videoMatch = html.match(/<a[^>]+href="([^"]*tikcdn\.io\/ssstik\/[^"]*)"[^>]*>\s*(?:Without watermark|Download)/i) ||
                           html.match(/href="([^"]*tikcdn\.io\/ssstik\/\d+[^"]*)"/i) ||
                           html.match(/href="([^"]*tikcdn\.io\/ssstik\/[^"m\/][^"]*)"/i) ||
                           html.match(/href="([^"]*dl\.tiktokio\.com\/[^"]*)"/i) ||
                           html.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/i);
        if (videoMatch) {
          const streamUrl = videoMatch[1];
          if (isPhoto) {
            return {
              success: true,
              media: [{ type: 'image', url: streamUrl }],
              audioUrl,
              title,
              author,
              type: 'carousel',
              engine: 'online:ssstik'
            };
          }
          return {
            success: true,
            media: [{ type: 'video', url: streamUrl }],
            videoUrl: streamUrl,
            audioUrl,
            title,
            author,
            type: 'video',
            engine: 'online:ssstik'
          };
        }
      }
      return { success: false, message: 'SSSTik gagal parse media dari tautan ini' };
    }
  };

  const onlineBackups = [
    ssstikProvider,
    {
      name: 'Online Ab TikTokio',
      fn: async () => {
        const res = await ab.ttdl(cleanUrl);
        return bentukHasilTikTokPaket(res, 'TikTok Media', 'online:ab', isPhoto) || { success: false, message: res?.message || 'Ab TikTokio media kosong' };
      }
    },
    tikwmProvider,
    {
      name: 'Online Tikmate API',
      fn: async () => {
        if (isPhoto) return { success: false, message: 'Tikmate dilewati untuk post foto/slide' };
        const res = await axios.post('https://api.tikmate.app/api/lookup', new URLSearchParams({ url: cleanUrl }).toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': getRandomUserAgent()
          },
          timeout: 8000
        });
        if (res.data?.success && res.data?.token && res.data?.id) {
          const streamUrl = `https://tikmate.app/download/${res.data.token}/${res.data.id}.mp4`;
          return {
            success: true,
            media: [{ type: 'video', url: streamUrl }],
            videoUrl: streamUrl,
            title: res.data.desc || 'TikTok Video',
            author: res.data.author_name || res.data.author_id || 'TikTok Creator',
            type: 'video',
            engine: 'online:tikmate'
          };
        }
        return { success: false, message: 'Tikmate data tidak lengkap' };
      }
    },
    {
      name: 'Online Ruhend TTDL',
      fn: async () => {
        const res = await ruhend.ttdl(cleanUrl);
        return bentukHasilTikTokPaket(res, 'TikTok Media', 'online:ruhend', isPhoto) || { success: false, message: 'Ruhend media tidak ditemukan' };
      }
    },
    {
      name: 'Online Btch TTDL',
      fn: async () => {
        if (isPhoto) return { success: false, message: 'Btch dilewati untuk post foto/slide' };
        const res = await btch.ttdl(cleanUrl);
        if (res?.status) {
          return bentukHasilTikTokPaket(res, 'TikTok Video', 'online:btch', false) || { success: false, message: 'Btch video tidak ditemukan' };
        }
        return { success: false, message: 'Btch video tidak ditemukan' };
      }
    }
  ];

  // Offline (yt-dlp) jadi prioritas untuk video; khusus slide foto (`/photo/`)
  // yt-dlp belum mendukung galeri foto, jadi langsung pakai engine slide online.
  const providers = isPhoto ? onlineBackups : [offlineYtdlpProvider, ...onlineBackups];

  const result = await executeWithSelfHealing(providers, (p) => p.fn(), 30000);
  if (!result || !result.success) {
    if (url.includes('story_type=1') || url.includes('aweme_type=40') || url.includes('story_uid')) {
      return {
        success: false,
        message: '⚠️ Konten ini merupakan Cerita (TikTok Story) yang telah kedaluwarsa atau bersifat privat, sehingga tidak dapat diunduh.'
      };
    }
    return result;
  }

  // Pastikan slide foto selalu berusaha mengambil audio latar secara terpisah
  const isSlideFoto = result.type === 'carousel' || (Array.isArray(result.media) && result.media.some(m => m.type === 'image'));
  if (isSlideFoto && !result.audioUrl && !result.audioBuffer) {
    try {
      const audioRes = await downloadTikTokAudio(cleanUrl);
      if (audioRes?.success && (audioRes.audioUrl || audioRes.buffer)) {
        result.audioUrl = audioRes.audioUrl;
        result.audioBuffer = audioRes.buffer;
        result.audioTitle = result.audioTitle || audioRes.title;
      }
    } catch (_) {}
  }

  return result;
}

/**
 * Ambil audio / sound TikTok (.ttmp3) — Offline Utama + Online Backup
 */
export async function downloadTikTokAudio(rawUrl) {
  const url = await expandCanonicalUrl(rawUrl);
  const cleanUrl = bersihkanUrlTiktok(url);

  const providers = [
    {
      name: 'Offline TikTok yt-dlp Audio',
      fn: async () => {
        const ytdlpResult = await downloadWithYtdlp(cleanUrl, true);
        if (ytdlpResult?.terlaluBesar) return ytdlpResult;
        if (ytdlpResult?.buffer) {
          return {
            success: true,
            buffer: ytdlpResult.buffer,
            title: ytdlpResult.title || 'TikTok Audio',
            mimetype: ytdlpResult.mimetype || 'audio/mpeg',
            ext: ytdlpResult.ext || 'mp3',
            engine: 'offline:yt-dlp'
          };
        }
        return {
          success: false,
          privateOrRestricted: ytdlpResult?.privateOrRestricted,
          unavailable: ytdlpResult?.unavailable,
          message: ytdlpResult?.message || 'Offline yt-dlp audio gagal'
        };
      }
    },
    {
      name: 'Online TikWM Audio',
      fn: async () => {
        const res = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(cleanUrl)}`, {
          headers: { 'User-Agent': getRandomUserAgent() },
          timeout: 12000
        });
        const d = res.data?.data;
        const audioUrl = d?.music || d?.music_info?.play;
        if (res.data?.code === 0 && audioUrl) {
          return {
            success: true,
            audioUrl,
            title: d.music_info?.title || d.title || 'TikTok Audio',
            mimetype: 'audio/mpeg',
            ext: 'mp3',
            engine: 'online:tikwm'
          };
        }
        return { success: false, message: 'TikWM audio tidak ditemukan' };
      }
    },
    {
      name: 'Online SSSTik Audio',
      fn: async () => {
        const res = await axios.post('https://ssstik.io/abc?url=dl', `id=${encodeURIComponent(cleanUrl)}&locale=en&tt=1`, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': getRandomUserAgent(),
            'Origin': 'https://ssstik.io',
            'Referer': 'https://ssstik.io/en'
          },
          timeout: 10000
        });
        if (res.data && typeof res.data === 'string') {
          const html = res.data;
          const audioMatch = html.match(/href="([^"]*(?:tikcdn\.io\/ssstik\/m\/|download_url)[^"]*)"/i) ||
                             html.match(/class="[^"]*music[^"]*"[^>]*href="([^"]+)"/i) ||
                             html.match(/href="([^"]+)"[^>]*class="[^"]*music[^"]*"/i);
          if (audioMatch) {
            const titleMatch = html.match(/<p class="maintext"[^>]*>([\s\S]*?)<\/p>/i);
            const title = bersihkanTeksHtml(titleMatch?.[1]) || 'TikTok Audio';
            return {
              success: true,
              audioUrl: audioMatch[1],
              title,
              mimetype: 'audio/mpeg',
              ext: 'mp3',
              engine: 'online:ssstik'
            };
          }
        }
        return { success: false, message: 'SSSTik audio tidak ditemukan' };
      }
    },
    {
      name: 'Online Ab TikTokio Audio',
      fn: async () => {
        const res = await ab.ttdl(cleanUrl);
        if (res && Array.isArray(res.audio) && res.audio.length > 0) {
          return {
            success: true,
            audioUrl: res.audio[0],
            title: res.title_audio || res.title || 'TikTok Audio',
            mimetype: 'audio/mpeg',
            ext: 'mp3',
            engine: 'online:ab'
          };
        }
        return { success: false, message: 'Ab audio tidak ditemukan' };
      }
    },
    {
      name: 'Online Ruhend Audio',
      fn: async () => {
        const res = await ruhend.ttdl(cleanUrl);
        if (res && Array.isArray(res.audio) && res.audio.length > 0) {
          return {
            success: true,
            audioUrl: res.audio[0],
            title: res.title_audio || res.title || 'TikTok Audio',
            mimetype: 'audio/mpeg',
            ext: 'mp3',
            engine: 'online:ruhend'
          };
        }
        return { success: false, message: 'Ruhend audio tidak ditemukan' };
      }
    },
    {
      name: 'Online Btch Audio',
      fn: async () => {
        const res = await btch.ttdl(cleanUrl);
        if (res?.status && Array.isArray(res.audio) && res.audio.length > 0) {
          return {
            success: true,
            audioUrl: res.audio[0],
            title: res.title_audio || res.title || 'TikTok Audio',
            mimetype: 'audio/mpeg',
            ext: 'mp3',
            engine: 'online:btch'
          };
        }
        return { success: false, message: 'Btch audio tidak ditemukan' };
      }
    }
  ];

  const result = await executeWithSelfHealing(providers, (p) => p.fn(), 25000);
  if (!result || !result.success) {
    if (url.includes('story_type=1') || url.includes('aweme_type=40') || url.includes('story_uid')) {
      return {
        success: false,
        message: '⚠️ Audio tidak dapat diunduh karena konten merupakan Cerita (TikTok Story) yang telah kedaluwarsa atau bersifat privat.'
      };
    }
  }
  return result;
}

/**
 * Ambil cookie untuk SATU domain dari berkas Netscape `ig_cookies.txt`.
 * Berkasnya menampung banyak situs (instagram, youtube, facebook, tiktok, x,
 * pinterest) — cookie satu situs tidak boleh ikut terkirim ke situs lain.
 */
function bacaCookieHeader(domainCocok) {
  try {
    const p = path.join(process.cwd(), 'ig_cookies.txt');
    if (!fs.existsSync(p)) return null;
    const pasangan = [];
    for (let baris of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      // Baris HttpOnly ditulis yt-dlp dengan awalan '#HttpOnly_' — tetap cookie sah.
      if (baris.startsWith('#HttpOnly_')) baris = baris.slice(10);
      if (!baris.trim() || baris.startsWith('#')) continue;
      const kolom = baris.split('\t');
      if (kolom.length < 7 || !kolom[5]) continue;
      const domain = kolom[0].replace(/^\./, '').toLowerCase();
      if (domain !== domainCocok && !domain.endsWith('.' + domainCocok)) continue;
      pasangan.push(kolom[5] + '=' + kolom[6]);
    }
    return pasangan.length ? pasangan.join('; ') : null;
  } catch {
    return null;
  }
}

/** Shortcode Instagram (DcltCFOgbxL) -> media_id numerik; base64 64-karakter. */
function shortcodeKeMediaId(shortcode) {
  const ABJAD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id = 0n;
  for (const c of shortcode) {
    const i = ABJAD.indexOf(c);
    if (i < 0) return null;
    id = id * 64n + BigInt(i);
  }
  return id.toString();
}

/** Ekstrak musik latar dari respons `/api/v1/media/{id}/info/` Instagram (carousel foto / reels). */
function ekstrakAudioInstagramItem(item) {
  const musicAsset = item?.music_metadata?.music_info?.music_asset_info || item?.clips_metadata?.music_info?.music_asset_info;
  const origSound = item?.music_metadata?.original_sound_info || item?.clips_metadata?.original_sound_info;
  const audioUrl =
    musicAsset?.progressive_download_url ||
    musicAsset?.fast_start_progressive_download_url ||
    origSound?.progressive_download_url ||
    undefined;
  const audioTitle = musicAsset?.title
    ? (musicAsset.display_artist ? `${musicAsset.title} - ${musicAsset.display_artist}` : musicAsset.title)
    : (origSound?.original_audio_title || undefined);
  return { audioUrl, audioTitle };
}

/** Bentuk payload standar hasil yt-dlp dump-json untuk IG / FB. */
function bentukHasilYtdlpDump(data, defaultTitle = 'Media') {
  if (!data) return null;
  const title = data.title || data.description || defaultTitle;
  if (Array.isArray(data.entries) && data.entries.length > 0) {
    const mediaList = [];
    for (const e of data.entries) {
      if (!e) continue;
      const isVideo = e.ext === 'mp4' || (e.vcodec && e.vcodec !== 'none');
      const itemUrl = pilihUrlLangsung(e) || e.thumbnails?.[e.thumbnails.length - 1]?.url;
      if (itemUrl) mediaList.push({ type: isVideo ? 'video' : 'image', url: itemUrl });
    }
    if (mediaList.length > 0) {
      return { success: true, media: mediaList, title, type: mediaList.length > 1 ? 'carousel' : mediaList[0].type, engine: 'offline:yt-dlp-json' };
    }
  } else if (data.url || data.thumbnails?.length > 0) {
    const isVideo = data.ext === 'mp4' || (data.vcodec && data.vcodec !== 'none') || Boolean(data.duration && data.duration > 0);
    const itemUrl = isVideo ? pilihUrlLangsung(data) : (data.url || data.thumbnails?.[data.thumbnails.length - 1]?.url);
    if (itemUrl) {
      return {
        success: true,
        media: [{ type: isVideo ? 'video' : 'image', url: itemUrl }],
        type: isVideo ? 'video' : 'image',
        videoUrl: isVideo ? itemUrl : undefined,
        imageUrl: !isVideo ? itemUrl : undefined,
        title,
        engine: 'offline:yt-dlp-json'
      };
    }
  }
  return null;
}

/**
 * Instagram Web API resmi (memakai sesi login di ig_cookies.txt).
 * Mengembalikan isi carousel secara utuh (foto + video) DAN musik latar (`audioUrl`) bila ada.
 */
async function downloadInstagramApi(url) {
  const cocok = url.match(/instagram\.com\/(?:[^/?#]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  if (!cocok) return null;
  const mediaId = shortcodeKeMediaId(cocok[1]);
  if (!mediaId) return null;
  const cookie = bacaCookieHeader('instagram.com');
  if (!cookie || !/\bsessionid=/.test(cookie)) return null;

  const res = await axios.get(`https://www.instagram.com/api/v1/media/${mediaId}/info/`, {
    httpsAgent,
    timeout: 12000,
    headers: {
      'User-Agent': getRandomUserAgent(),
      'X-IG-App-ID': '936619743392459',
      'Referer': 'https://www.instagram.com/',
      'Accept': '*/*',
      'Cookie': cookie
    }
  });

  const item = res.data?.items?.[0];
  if (!item) return null;

  const daftar = Array.isArray(item.carousel_media) && item.carousel_media.length > 0
    ? item.carousel_media
    : [item];

  const mediaList = [];
  for (const c of daftar) {
    const video = c.video_versions?.[0]?.url;
    const gambar = c.image_versions2?.candidates?.[0]?.url;
    if (video) mediaList.push({ type: 'video', url: video });
    else if (gambar) mediaList.push({ type: 'image', url: gambar });
  }
  if (mediaList.length === 0) return null;

  const { audioUrl, audioTitle } = ekstrakAudioInstagramItem(item);

  return {
    success: true,
    media: mediaList,
    audioUrl,
    audioTitle,
    title: item.caption?.text || 'Instagram Media',
    author: item.user?.username,
    type: mediaList.length > 1 ? 'carousel' : mediaList[0].type,
    engine: 'offline:ig-api'
  };
}

/**
 * Direct / Offline Instagram Embed Scraper (`embed/captioned/?cr=1&v=14`).
 * Mengambil carousel foto & video langsung dari Instagram CDN tanpa cookie login.
 */
async function downloadInstagramEmbed(url) {
  const cocok = url.match(/instagram\.com\/(?:[^/?#]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  if (!cocok) return null;
  const shortcode = cocok[1];

  const res = await axios.get(`https://www.instagram.com/p/${shortcode}/embed/captioned/?cr=1&v=14`, {
    httpsAgent,
    timeout: 10000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  const html = typeof res.data === 'string' ? res.data : '';
  const idx = html.indexOf('"contextJSON":');
  if (idx < 0) return null;

  const strMatch = html.slice(idx + 14).match(/^"((?:\\.|[^"\\])*)"/);
  if (!strMatch) return null;

  const data = JSON.parse(JSON.parse(strMatch[0]));
  const sm = data?.gql_data?.shortcode_media;
  if (!sm) return null;

  const edges = sm.edge_sidecar_to_children?.edges;
  const nodes = Array.isArray(edges) && edges.length > 0 ? edges.map(e => e.node).filter(Boolean) : [sm];

  const mediaList = [];
  for (const node of nodes) {
    if (node.is_video && node.video_url) {
      mediaList.push({ type: 'video', url: node.video_url });
    } else if (node.display_url) {
      mediaList.push({ type: 'image', url: node.display_url });
    }
  }
  if (mediaList.length === 0) return null;

  return {
    success: true,
    media: mediaList,
    title: sm.edge_media_to_caption?.edges?.[0]?.node?.text || 'Instagram Media',
    author: sm.owner?.username,
    type: mediaList.length > 1 ? 'carousel' : mediaList[0].type,
    engine: 'offline:ig-embed'
  };
}

/**
 * Download Instagram Reels / Posts / Single Photo / Multiple Photo Carousels
 * Offline / Lokal Utama + Online Backup, serta pemisahan foto & musik latar pada slide.
 */
export async function downloadInstagram(rawUrl) {
  const url = await expandCanonicalUrl(rawUrl);
  const igCookie = bacaCookieHeader('instagram.com') || '';
  const punyaSessionId = /\bsessionid=/.test(igCookie);

  const providers = [
    // --- OFFLINE / LOKAL UTAMA ---
    ...(punyaSessionId ? [{
      name: 'Offline IG Web API (Cookies)',
      fn: async () => (await downloadInstagramApi(url)) || { success: false, message: 'IG Web API tidak tersedia' }
    }] : []),
    {
      name: 'Offline IG Embed Direct',
      fn: async () => (await downloadInstagramEmbed(url)) || { success: false, message: 'IG Embed tidak menemukan media' }
    },
    {
      name: 'Offline IG yt-dlp JSON',
      fn: async () => {
        const data = await extractWithYtdlpJson(url);
        return bentukHasilYtdlpDump(data, 'Instagram Media') || { success: false, message: 'yt-dlp JSON IG kosong' };
      }
    },
    {
      name: 'Offline IG yt-dlp Video',
      fn: async () => {
        const ytdlpResult = await downloadWithYtdlp(url, false);
        if (ytdlpResult?.terlaluBesar) return ytdlpResult;
        if (ytdlpResult?.buffer || ytdlpResult?.videoUrl) {
          return {
            success: true,
            media: [{ type: 'video', url: ytdlpResult.videoUrl, buffer: ytdlpResult.buffer }],
            buffer: ytdlpResult.buffer,
            videoUrl: ytdlpResult.videoUrl,
            title: ytdlpResult.title || 'Instagram Video',
            type: 'video',
            engine: 'offline:yt-dlp'
          };
        }
        return {
          success: false,
          privateOrRestricted: ytdlpResult?.privateOrRestricted,
          unavailable: ytdlpResult?.unavailable,
          message: ytdlpResult?.message || 'Offline yt-dlp IG gagal'
        };
      }
    },
    // --- ONLINE BACKUP ---
    {
      name: 'Online Snapsave IG',
      fn: async () => {
        const snapRes = await snapsave(url);
        if (snapRes?.success && Array.isArray(snapRes?.data?.media) && snapRes.data.media.length > 0) {
          const mediaList = snapRes.data.media.map(m => {
            const isVideo = m.type === 'video' || (m.url && m.url.includes('.mp4'));
            return { type: isVideo ? 'video' : 'image', url: m.url };
          }).filter(m => Boolean(m.url));
          if (mediaList.length > 0) {
            return {
              success: true,
              media: mediaList,
              title: 'Instagram Media',
              type: mediaList.length > 1 ? 'carousel' : mediaList[0].type,
              engine: 'online:snapsave'
            };
          }
        }
        return { success: false, message: 'Snapsave IG kosong' };
      }
    },
    {
      name: 'Online Ruhend IGDL2',
      fn: async () => {
        const ruhendRes = await ruhend.igdl2(url);
        if (ruhendRes?.status && Array.isArray(ruhendRes?.data) && ruhendRes.data.length > 0) {
          const mediaList = ruhendRes.data.map(item => {
            const itemUrl = item.url || item.thumbnail;
            const isVideo = Boolean(itemUrl && (itemUrl.includes('.mp4') || itemUrl.includes('/v/')));
            return { type: isVideo ? 'video' : 'image', url: itemUrl };
          }).filter(m => Boolean(m.url));
          if (mediaList.length > 0) {
            return {
              success: true,
              media: mediaList,
              title: 'Instagram Media',
              type: mediaList.length > 1 ? 'carousel' : mediaList[0].type,
              engine: 'online:ruhend'
            };
          }
        }
        return { success: false, message: 'Ruhend IGDL2 kosong' };
      }
    },
    {
      name: 'Online SSSInstagram API',
      fn: async () => {
        const res = await axios.post('https://sssinstagram.com/api/convert', JSON.stringify({ url }), {
          httpsAgent, timeout: 12000,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': getRandomUserAgent(),
            'Referer': 'https://sssinstagram.com/',
            'Origin': 'https://sssinstagram.com'
          }
        });
        if (res.data) {
          if (Array.isArray(res.data.data) && res.data.data.length > 0) {
            const mediaList = res.data.data.map(item => ({
              type: (item.type === 'video' || item.url?.includes('.mp4')) ? 'video' : 'image',
              url: item.url
            })).filter(item => Boolean(item.url));
            if (mediaList.length > 0) {
              return { success: true, media: mediaList, title: 'Instagram Media', type: mediaList.length > 1 ? 'carousel' : mediaList[0].type, engine: 'online:sssinstagram' };
            }
          } else if (res.data.url) {
            const isVideo = res.data.url.includes('.mp4') || res.data.type === 'video';
            return {
              success: true,
              media: [{ type: isVideo ? 'video' : 'image', url: res.data.url }],
              videoUrl: isVideo ? res.data.url : undefined,
              imageUrl: !isVideo ? res.data.url : undefined,
              title: 'Instagram Media',
              type: isVideo ? 'video' : 'image',
              engine: 'online:sssinstagram'
            };
          }
        }
        return { success: false, message: 'SSSInstagram kosong' };
      }
    },
    {
      name: 'Online Siputzx IG',
      fn: async () => {
        const res = await axios.get(`https://api.siputzx.my.id/api/d/igdl?url=${encodeURIComponent(url)}`, {
          headers: { 'User-Agent': getRandomUserAgent() },
          timeout: 12000
        });
        const data = res.data?.data;
        if (Array.isArray(data) && data.length > 0) {
          const mediaList = data.map(item => {
            const itemUrl = typeof item === 'string' ? item : (item.url || item.thumbnail);
            const isVideo = (typeof item === 'object' && item.type === 'video') || Boolean(itemUrl && itemUrl.includes('.mp4'));
            return { type: isVideo ? 'video' : 'image', url: itemUrl };
          }).filter(item => Boolean(item.url));
          if (mediaList.length > 0) {
            return { success: true, media: mediaList, title: 'Instagram Media', type: mediaList.length > 1 ? 'carousel' : mediaList[0].type, engine: 'online:siputzx' };
          }
        } else if (data && typeof data === 'object' && data.url) {
          const isVideo = data.url.includes('.mp4') || data.type === 'video';
          return {
            success: true,
            media: [{ type: isVideo ? 'video' : 'image', url: data.url }],
            videoUrl: isVideo ? data.url : undefined,
            imageUrl: !isVideo ? data.url : undefined,
            title: 'Instagram Media',
            type: isVideo ? 'video' : 'image',
            engine: 'online:siputzx'
          };
        }
        return { success: false, message: 'Siputzx IG kosong' };
      }
    },
    {
      name: 'Online Ab IGDL',
      fn: async () => {
        const arr = await ab.igdl(url);
        if (Array.isArray(arr) && arr.length > 0) {
          const mediaList = arr.map(item => ({
            type: (item.url && item.url.includes('.mp4')) ? 'video' : 'image',
            url: item.url
          })).filter(m => Boolean(m.url));
          if (mediaList.length > 0) {
            return { success: true, media: mediaList, title: 'Instagram Media', type: mediaList.length > 1 ? 'carousel' : mediaList[0].type, engine: 'online:ab' };
          }
        }
        return { success: false, message: 'Ab IGDL kosong' };
      }
    },
    {
      name: 'Online Btch IGDL',
      fn: async () => {
        const res = await btch.igdl(url);
        if (res?.status && Array.isArray(res.result) && res.result.length > 0) {
          const mediaList = res.result.map(item => ({
            type: (item.url && item.url.includes('.mp4')) ? 'video' : 'image',
            url: item.url
          })).filter(m => Boolean(m.url));
          if (mediaList.length > 0) {
            return { success: true, media: mediaList, title: 'Instagram Media', type: mediaList.length > 1 ? 'carousel' : mediaList[0].type, engine: 'online:btch' };
          }
        }
        return { success: false, message: 'Btch IGDL kosong' };
      }
    },
    {
      name: 'Online Direct IGDL',
      fn: async () => {
        const fn = igdl.instagramGetUrl || igdl.default || igdl;
        const res = await fn(url);
        if (res?.url_list?.length > 0) {
          const mediaList = res.url_list.map(u => ({
            type: (u.includes('.mp4') || u.includes('/v/') || u.includes('video')) ? 'video' : 'image',
            url: u
          })).filter(item => Boolean(item.url));
          if (mediaList.length > 0) {
            return { success: true, media: mediaList, title: 'Instagram Media', type: mediaList.length > 1 ? 'carousel' : mediaList[0].type, engine: 'online:igdl' };
          }
        }
        return { success: false, message: 'igdl kosong' };
      }
    },
    {
      name: 'Online SnapSave Action',
      fn: async () => {
        const res = await axios.post('https://snapsave.app/action.php', `url=${encodeURIComponent(url)}`, {
          httpsAgent, timeout: 10000,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': getRandomUserAgent(),
            'Referer': 'https://snapsave.app/',
            'Origin': 'https://snapsave.app'
          }
        });
        const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        const urlMatches = raw.match(/https?:\\?\/\\?\/[^\s"'\\]+\.(?:mp4|jpg|jpeg|png|webp)[^\s"'\\]*/gi) ||
                           raw.match(/https?:\\?\/\\?\/[^\s"'\\]+cdninstagram[^\s"'\\]*/gi);
        if (urlMatches && urlMatches.length > 0) {
          const mediaList = [];
          const seen = new Set();
          for (const rawMatch of urlMatches) {
            const cleanU = rawMatch.replace(/\\+\//g, '/').replace(/\\u0026/g, '&').replace(/\\/g, '');
            if (!seen.has(cleanU)) {
              seen.add(cleanU);
              mediaList.push({ type: cleanU.includes('.mp4') ? 'video' : 'image', url: cleanU });
            }
          }
          if (mediaList.length > 0) {
            return { success: true, media: mediaList, title: 'Instagram Media', type: mediaList.length > 1 ? 'carousel' : mediaList[0].type, engine: 'online:snapsave-action' };
          }
        }
        return { success: false, message: 'SnapSave action kosong' };
      }
    }
  ];

  const result = await executeWithSelfHealing(providers, (p) => p.fn(), 25000);
  if (result?.success) {
    return result;
  }

  return {
    success: false,
    message: result?.message || '❌ Gagal mengunduh postingan/foto dari Instagram. Pastikan akun/postingan bersifat publik dan link valid.'
  };
}

/**
 * Ambil audio Instagram (.igmp3, .igaudio) — musik latar slide foto atau audio Reels/video.
 * Offline Utama (IG Web API + yt-dlp + ffmpeg) + Online Backup.
 */
export async function downloadInstagramAudio(rawUrl) {
  const url = await expandCanonicalUrl(rawUrl);

  // 1. Offline / Lokal: IG Web API (musik slide foto atau original audio Reels)
  try {
    const apiRes = await downloadInstagramApi(url);
    if (apiRes?.audioUrl) {
      return {
        success: true,
        audioUrl: apiRes.audioUrl,
        title: apiRes.audioTitle || apiRes.title || 'Instagram Audio',
        mimetype: 'audio/mp4',
        ext: 'm4a',
        engine: 'offline:ig-api'
      };
    }
  } catch (_) {}

  // 2. Offline: yt-dlp audio langsung
  try {
    const ytdlpRes = await downloadWithYtdlp(url, true);
    if (ytdlpRes?.terlaluBesar) return ytdlpRes;
    if (ytdlpRes?.buffer || ytdlpRes?.audioUrl) {
      return {
        success: true,
        buffer: ytdlpRes.buffer,
        audioUrl: ytdlpRes.audioUrl,
        title: ytdlpRes.title || 'Instagram Audio',
        mimetype: ytdlpRes.mimetype || 'audio/mp4',
        ext: ytdlpRes.ext || 'm4a',
        engine: 'offline:yt-dlp'
      };
    }
  } catch (_) {}

  // 3. Online backup: unduh post lalu ambil audioUrl (bila ada) atau ekstrak MP3 dari video
  const igRes = await downloadInstagram(url);
  if (igRes?.success) {
    if (igRes.audioUrl || igRes.audioBuffer) {
      return {
        success: true,
        buffer: igRes.audioBuffer,
        audioUrl: igRes.audioUrl,
        title: igRes.audioTitle || igRes.title || 'Instagram Audio',
        mimetype: 'audio/mp4',
        ext: 'm4a',
        engine: igRes.engine
      };
    }
    const videoItem = (igRes.media || []).find(m => m.type === 'video');
    if (videoItem) {
      const siapVideo = await siapkanMediaWA({ buffer: videoItem.buffer, url: videoItem.url, type: 'video' });
      if (siapVideo?.ok && siapVideo.buffer) {
        const mp3Buffer = await convertVideoToAudio(siapVideo.buffer, 'mp3').catch(() => null);
        if (mp3Buffer && mp3Buffer.length > 5000) {
          return {
            success: true,
            buffer: mp3Buffer,
            title: igRes.title || 'Instagram Audio',
            mimetype: 'audio/mpeg',
            ext: 'mp3',
            engine: `${igRes.engine || 'online'}+ffmpeg`
          };
        }
      }
    }
  }

  return {
    success: false,
    message: '❌ Audio tidak ditemukan pada postingan Instagram ini (postingan foto tanpa musik atau link privat).'
  };
}

/**
 * Download YouTube Videos / Shorts — Offline Utama + Online Backup
 */
export async function downloadYouTube(url) {
  const providers = [
    // --- OFFLINE UTAMA ---
    {
      name: 'Offline YT yt-dlp',
      fn: async () => {
        const ytdlpResult = await downloadWithYtdlp(url, false);
        if (ytdlpResult?.terlaluBesar) return ytdlpResult;
        if (ytdlpResult?.buffer) {
          return { success: true, buffer: ytdlpResult.buffer, title: ytdlpResult.title || 'YouTube Video', mimetype: 'video/mp4', engine: 'offline:yt-dlp' };
        }
        if (ytdlpResult?.videoUrl) {
          const buf = await fetchBuffer(ytdlpResult.videoUrl);
          if (buf || ytdlpResult.videoUrl) {
            return { success: true, buffer: buf || undefined, videoUrl: ytdlpResult.videoUrl, title: ytdlpResult.title || 'YouTube Video', mimetype: 'video/mp4', engine: 'offline:yt-dlp' };
          }
        }
        return {
          success: false,
          privateOrRestricted: ytdlpResult?.privateOrRestricted,
          unavailable: ytdlpResult?.unavailable,
          message: ytdlpResult?.message || 'Offline yt-dlp YouTube gagal'
        };
      }
    },
    {
      name: 'Offline YT ytdl-core',
      fn: async () => {
        const info = await ytdl.getInfo(url);
        const muxed = (info.formats || [])
          .filter(f => f.hasVideo && f.hasAudio && f.url)
          .filter(f => f.container === 'mp4' || String(f.mimeType || '').includes('mp4'))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        const format = muxed[0];
        if (format) {
          const buf = await fetchBuffer(format.url);
          return {
            success: true,
            buffer: buf || undefined,
            videoUrl: format.url,
            title: info.videoDetails?.title || 'YouTube Video',
            mimetype: 'video/mp4',
            engine: 'offline:ytdl-core'
          };
        }
        return { success: false, message: 'ytdl-core format gabungan kosong' };
      }
    },
    // --- ONLINE BACKUP ---
    {
      name: 'Online Siputzx YTMP4',
      fn: async () => {
        const res = await axios.get(`https://api.siputzx.my.id/api/d/ytmp4?url=${encodeURIComponent(url)}`, {
          headers: { 'User-Agent': getRandomUserAgent() },
          timeout: 20000
        });
        const d = res.data?.data;
        const streamUrl = d?.dl || d?.url || (typeof d === 'string' ? d : null);
        if (streamUrl) {
          return { success: true, videoUrl: streamUrl, title: d?.title || 'YouTube Video', mimetype: 'video/mp4', engine: 'online:siputzx' };
        }
        return { success: false, message: 'Siputzx YTMP4 kosong' };
      }
    },
    {
      name: 'Online Btch YouTube',
      fn: async () => {
        const res = await btch.youtube(url);
        if (res?.status && res?.mp4) {
          return { success: true, videoUrl: res.mp4, title: res.title || 'YouTube Video', author: res.author, mimetype: 'video/mp4', engine: 'online:btch' };
        }
        return { success: false, message: 'Btch YouTube MP4 kosong' };
      }
    },
    {
      name: 'Online Ab YouTube',
      fn: async () => {
        const res = await ab.youtube(url);
        if (res?.mp4) {
          return { success: true, videoUrl: res.mp4, title: res.title || 'YouTube Video', author: res.author, mimetype: 'video/mp4', engine: 'online:ab' };
        }
        return { success: false, message: 'Ab YouTube MP4 kosong' };
      }
    }
  ];

  const result = await executeWithSelfHealing(providers, (p) => p.fn(), 60000);
  return result?.success ? result : {
    success: false,
    message: result?.message || '❌ Gagal mengunduh video YouTube. Pastikan link publik dan dapat diakses.'
  };
}

/**
 * Download YouTube Audio / MP3 — Offline Utama + Online Backup
 */
export async function downloadYouTubeAudio(url) {
  const providers = [
    // --- OFFLINE UTAMA ---
    {
      name: 'Offline YT yt-dlp Audio',
      fn: async () => {
        const ytdlpResult = await downloadWithYtdlp(url, true);
        if (ytdlpResult?.terlaluBesar) return ytdlpResult;
        if (ytdlpResult?.buffer) {
          return {
            success: true,
            buffer: ytdlpResult.buffer,
            title: ytdlpResult.title || 'YouTube Audio',
            mimetype: ytdlpResult.mimetype || 'audio/mpeg',
            ext: ytdlpResult.ext || 'mp3',
            engine: 'offline:yt-dlp'
          };
        }
        if (ytdlpResult?.audioUrl) {
          const buf = await fetchBuffer(ytdlpResult.audioUrl);
          return {
            success: true,
            buffer: buf || undefined,
            audioUrl: ytdlpResult.audioUrl,
            title: ytdlpResult.title || 'YouTube Audio',
            mimetype: ytdlpResult.mimetype || 'audio/mp4',
            ext: ytdlpResult.ext || 'm4a',
            engine: 'offline:yt-dlp'
          };
        }
        return {
          success: false,
          privateOrRestricted: ytdlpResult?.privateOrRestricted,
          unavailable: ytdlpResult?.unavailable,
          message: ytdlpResult?.message || 'Offline yt-dlp audio gagal'
        };
      }
    },
    {
      name: 'Offline YT ytdl-core Audio',
      fn: async () => {
        const info = await ytdl.getInfo(url);
        const audioOnly = (info.formats || []).filter(f => f.hasAudio && !f.hasVideo && f.url);
        const m4a = audioOnly
          .filter(f => f.container === 'mp4' || String(f.audioCodec || '').includes('mp4a'))
          .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
        const format = m4a || audioOnly.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
        if (format) {
          const isM4a = format === m4a;
          const buf = await fetchBuffer(format.url);
          return {
            success: true,
            buffer: buf || undefined,
            audioUrl: format.url,
            title: info.videoDetails?.title || 'YouTube Audio',
            mimetype: isM4a ? 'audio/mp4' : 'audio/ogg; codecs=opus',
            ext: isM4a ? 'm4a' : 'ogg',
            engine: 'offline:ytdl-core'
          };
        }
        return { success: false, message: 'ytdl-core audio kosong' };
      }
    },
    // --- ONLINE BACKUP ---
    {
      name: 'Online Siputzx YTMP3',
      fn: async () => {
        const res = await axios.get(`https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(url)}`, {
          headers: { 'User-Agent': getRandomUserAgent() },
          timeout: 20000
        });
        const d = res.data?.data;
        const audioUrl = d?.dl || d?.url || (typeof d === 'string' ? d : null);
        if (audioUrl) {
          return { success: true, audioUrl, title: d?.title || 'YouTube Audio', mimetype: 'audio/mpeg', ext: 'mp3', engine: 'online:siputzx' };
        }
        return { success: false, message: 'Siputzx YTMP3 kosong' };
      }
    },
    {
      name: 'Online Btch YouTube MP3',
      fn: async () => {
        const res = await btch.youtube(url);
        if (res?.status && res?.mp3) {
          return { success: true, audioUrl: res.mp3, title: res.title || 'YouTube Audio', mimetype: 'audio/mpeg', ext: 'mp3', engine: 'online:btch' };
        }
        return { success: false, message: 'Btch YouTube MP3 kosong' };
      }
    },
    {
      name: 'Online Ab YouTube MP3',
      fn: async () => {
        const res = await ab.youtube(url);
        if (res?.mp3) {
          return { success: true, audioUrl: res.mp3, title: res.title || 'YouTube Audio', mimetype: 'audio/mpeg', ext: 'mp3', engine: 'online:ab' };
        }
        return { success: false, message: 'Ab YouTube MP3 kosong' };
      }
    }
  ];

  const result = await executeWithSelfHealing(providers, (p) => p.fn(), 60000);
  return result?.success ? result : {
    success: false,
    message: result?.message || '❌ Gagal mengunduh audio YouTube. Pastikan link publik dan dapat diakses.'
  };
}

/**
 * Download Facebook Video / Reels / Photos — Offline Utama + Online Backup
 */
export async function downloadFacebook(rawUrl) {
  const url = await expandCanonicalUrl(rawUrl);

  const providers = [
    // --- OFFLINE UTAMA ---
    {
      name: 'Offline FB yt-dlp JSON',
      fn: async () => {
        const data = await extractWithYtdlpJson(url);
        return bentukHasilYtdlpDump(data, 'Facebook Media') || { success: false, message: 'yt-dlp JSON FB kosong' };
      }
    },
    {
      name: 'Offline FB yt-dlp Video',
      fn: async () => {
        const hasil = await downloadWithYtdlp(url, false);
        if (hasil?.terlaluBesar) return hasil;
        if (hasil?.buffer || hasil?.videoUrl) {
          return {
            success: true,
            media: [{ type: 'video', url: hasil.videoUrl, buffer: hasil.buffer }],
            buffer: hasil.buffer,
            videoUrl: hasil.videoUrl,
            title: hasil.title || 'Facebook Video',
            type: 'video',
            engine: 'offline:yt-dlp'
          };
        }
        return { success: false, message: hasil?.message || 'Offline yt-dlp FB gagal' };
      }
    },
    {
      name: 'Offline FB HTML Scraper',
      fn: async () => {
        const res = await axios.get(url, {
          headers: {
            'User-Agent': getRandomUserAgent(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9,id;q=0.8'
          },
          timeout: 12000,
          maxRedirects: 5
        });
        if (res.data) {
          const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
          const cleanU = (raw) => raw ? raw.replace(/\\/g, '').replace(/&amp;/g, '&') : null;

          const hdMatch = html.match(/"playable_url_quality_hd"\s*:\s*"([^"]+)"/) || html.match(/hd_src\s*:\s*"([^"]+)"/);
          const sdMatch = html.match(/"playable_url"\s*:\s*"([^"]+)"/) || html.match(/sd_src\s*:\s*"([^"]+)"/);
          const ogVidMatch = html.match(/<meta\s+property="og:video"\s+content="([^"]+)"/i) || html.match(/<meta\s+property="og:video:secure_url"\s+content="([^"]+)"/i);
          const videoStream = cleanU(hdMatch?.[1]) || cleanU(sdMatch?.[1]) || cleanU(ogVidMatch?.[1]);

          if (videoStream) {
            const buf = await fetchBuffer(videoStream);
            return {
              success: true,
              media: [{ type: 'video', url: videoStream, buffer: buf || undefined }],
              videoUrl: videoStream,
              buffer: buf || undefined,
              title: 'Facebook Video',
              type: 'video',
              engine: 'offline:html'
            };
          }

          const ogImgMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) ||
                             html.match(/<meta\s+property="og:image:secure_url"\s+content="([^"]+)"/i);
          const scontentMatch = html.match(/https?:\/\/[^\s"'\\]*scontent[^\s"'\\]*\.fbcdn\.net[^\s"'\\]*/gi);

          const photoUrl = cleanU(ogImgMatch?.[1]) || cleanU(scontentMatch?.[0]);
          if (photoUrl && !photoUrl.includes('static.xx.fbcdn.net') && !photoUrl.includes('fb_icon_325x325')) {
            const buf = await fetchBuffer(photoUrl);
            if (buf && buf.length > 5000) {
              return {
                success: true,
                media: [{ type: 'image', url: photoUrl, buffer: buf }],
                imageUrl: photoUrl,
                buffer: buf,
                title: 'Facebook Photo',
                type: 'image',
                engine: 'offline:html'
              };
            }
          }
        }
        return { success: false, message: 'FB HTML scraper kosong' };
      }
    },
    // --- ONLINE BACKUP ---
    {
      name: 'Online Ruhend FBDL',
      fn: async () => {
        const fbRes = await ruhend.fbdl(url);
        const stream = fbRes?.video_hd || fbRes?.video_sd || (Array.isArray(fbRes?.data) ? fbRes.data[0]?.url : null);
        if (stream) {
          const buf = await fetchBuffer(stream);
          return {
            success: true,
            media: [{ type: 'video', url: stream, buffer: buf || undefined }],
            videoUrl: stream,
            buffer: buf || undefined,
            title: fbRes?.title || 'Facebook Video',
            type: 'video',
            engine: 'online:ruhend'
          };
        }
        return { success: false, message: 'Ruhend FBDL kosong' };
      }
    },
    {
      name: 'Online Siputzx FB',
      fn: async () => {
        const res = await axios.get(`https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(url)}`, {
          headers: { 'User-Agent': getRandomUserAgent() },
          timeout: 12000
        });
        const d = res.data?.data;
        const mediaUrl = d?.video_hd || d?.video_sd || d?.url || (Array.isArray(d) ? d[0]?.url : d?.image);
        if (mediaUrl) {
          const isVideo = mediaUrl.includes('.mp4') || Boolean(d.video_hd || d.video_sd);
          const buf = await fetchBuffer(mediaUrl);
          return {
            success: true,
            media: [{ type: isVideo ? 'video' : 'image', url: mediaUrl, buffer: buf || undefined }],
            videoUrl: isVideo ? mediaUrl : undefined,
            imageUrl: !isVideo ? mediaUrl : undefined,
            buffer: buf || undefined,
            title: d.title || 'Facebook Media',
            type: isVideo ? 'video' : 'image',
            engine: 'online:siputzx'
          };
        }
        return { success: false, message: 'Siputzx FB kosong' };
      }
    },
    {
      name: 'Online FBDownloader',
      fn: async () => {
        const fn = fbDownloader.default || fbDownloader;
        const res = await fn(url);
        const streamUrl = res?.hd || res?.sd || res?.url || res?.stream;
        if (streamUrl) {
          const buf = await fetchBuffer(streamUrl);
          return {
            success: true,
            media: [{ type: 'video', url: streamUrl, buffer: buf || undefined }],
            buffer: buf || undefined,
            videoUrl: streamUrl,
            title: res?.title || 'Facebook Video',
            type: 'video',
            engine: 'online:fbdownloader'
          };
        }
        return { success: false, message: 'fbDownloader kosong' };
      }
    },
    {
      name: 'Online Ab FBDown',
      fn: async () => {
        const res = await ab.fbdown(url);
        const streamUrl = res?.HD || res?.Normal_video;
        if (streamUrl) {
          const buf = await fetchBuffer(streamUrl);
          return {
            success: true,
            media: [{ type: 'video', url: streamUrl, buffer: buf || undefined }],
            buffer: buf || undefined,
            videoUrl: streamUrl,
            title: 'Facebook Video',
            type: 'video',
            engine: 'online:ab'
          };
        }
        return { success: false, message: 'Ab FBDown kosong' };
      }
    }
  ];

  const result = await executeWithSelfHealing(providers, (p) => p.fn(), 30000);
  return result?.success ? result : {
    success: false,
    message: result?.message || '❌ Gagal mengunduh foto/video dari Facebook. Pastikan postingan bersifat publik dan link valid.'
  };
}

/**
 * Download Twitter / X Video & Media — Offline Utama + Online Backup
 */
export async function downloadTwitter(rawUrl) {
  const url = await expandCanonicalUrl(rawUrl);

  const providers = [
    {
      name: 'Offline Twitter yt-dlp JSON',
      fn: async () => {
        const data = await extractWithYtdlpJson(url);
        return bentukHasilYtdlpDump(data, 'Twitter / X Media') || { success: false, message: 'yt-dlp JSON Twitter kosong' };
      }
    },
    {
      name: 'Offline Twitter yt-dlp Video',
      fn: async () => {
        const hasil = await downloadWithYtdlp(url, false);
        if (hasil?.terlaluBesar) return hasil;
        if (hasil?.buffer) {
          return {
            success: true,
            media: [{ type: 'video', buffer: hasil.buffer }],
            buffer: hasil.buffer,
            title: hasil.title || 'Twitter / X Media',
            type: 'video',
            engine: 'offline:yt-dlp'
          };
        }
        return { success: false, message: hasil?.message || 'Offline yt-dlp Twitter gagal' };
      }
    },
    {
      name: 'Online Siputzx Twitter',
      fn: async () => {
        const apiRes = await axios.get(`https://api.siputzx.my.id/api/d/twitter?url=${encodeURIComponent(url)}`, { timeout: 15000 });
        if (apiRes.data?.status && apiRes.data?.data) {
          const mediaData = apiRes.data.data;
          const downloadUrl = mediaData.video_sd || mediaData.video_hd || mediaData.url || (Array.isArray(mediaData) ? mediaData[0]?.url : null);
          if (downloadUrl) {
            const isVideo = downloadUrl.includes('.mp4');
            const buf = await fetchBuffer(downloadUrl);
            return {
              success: true,
              media: [{ type: isVideo ? 'video' : 'image', url: downloadUrl, buffer: buf || undefined }],
              buffer: buf || undefined,
              videoUrl: isVideo ? downloadUrl : undefined,
              imageUrl: !isVideo ? downloadUrl : undefined,
              title: mediaData.title || 'Twitter / X Media',
              type: isVideo ? 'video' : 'image',
              engine: 'online:siputzx'
            };
          }
        }
        return { success: false, message: 'Siputzx Twitter kosong' };
      }
    },
    {
      name: 'Online Btch Twitter',
      fn: async () => {
        const res = await btch.twitter(url);
        const downloadUrl = res?.url?.[0]?.hd || res?.url?.[0]?.sd || (typeof res?.url === 'string' ? res.url : null);
        if (res?.status && downloadUrl) {
          const buf = await fetchBuffer(downloadUrl);
          return {
            success: true,
            media: [{ type: 'video', url: downloadUrl, buffer: buf || undefined }],
            buffer: buf || undefined,
            videoUrl: downloadUrl,
            title: res.title || 'Twitter / X Media',
            type: 'video',
            engine: 'online:btch'
          };
        }
        return { success: false, message: 'Btch Twitter kosong' };
      }
    }
  ];

  const result = await executeWithSelfHealing(providers, (p) => p.fn(), 30000);
  return result?.success ? result : {
    success: false,
    message: result?.message || '❌ Gagal mengunduh media dari Twitter/X. Pastikan link publik dan tweet tidak dilindungi.'
  };
}

/**
 * Download Pinterest Photos & Videos — Offline Utama + Online Backup
 */
export async function downloadPinterest(url) {
  const providers = [
    {
      name: 'Offline Pinterest yt-dlp',
      fn: async () => {
        const data = await extractWithYtdlpJson(url);
        return bentukHasilYtdlpDump(data, 'Pinterest Media') || { success: false, message: 'yt-dlp Pinterest kosong' };
      }
    },
    {
      name: 'Offline Pinterest HTML Scraper',
      fn: async () => {
        const res = await axios.get(url, { headers: { 'User-Agent': getRandomUserAgent() }, timeout: 10000 });
        if (res.data) {
          const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
          const ogImg = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) ||
                        html.match(/<meta\s+name="og:image"\s+content="([^"]+)"/i) ||
                        html.match(/https?:\/\/i\.pinimg\.com\/originals\/[^\s"']+/i) ||
                        html.match(/https?:\/\/i\.pinimg\.com\/736x\/[^\s"']+/i);
          if (ogImg) {
            const imgUrl = (ogImg[1] || ogImg[0]).replace(/\\/g, '');
            const buf = await fetchBuffer(imgUrl);
            if (buf) {
              return {
                success: true,
                media: [{ type: 'image', url: imgUrl, buffer: buf }],
                buffer: buf,
                imageUrl: imgUrl,
                title: 'Pinterest Photo',
                type: 'image',
                engine: 'offline:html'
              };
            }
          }
        }
        return { success: false, message: 'HTML Pinterest kosong' };
      }
    },
    {
      name: 'Online Siputzx Pinterest',
      fn: async () => {
        const res = await axios.get(`https://api.siputzx.my.id/api/d/pinterest?url=${encodeURIComponent(url)}`, {
          headers: { 'User-Agent': getRandomUserAgent() },
          timeout: 10000
        });
        const d = res.data?.data;
        const mediaUrl = d?.url || d?.image || d?.video || (Array.isArray(d) ? d[0] : null);
        if (mediaUrl) {
          const isVideo = mediaUrl.includes('.mp4');
          const buf = await fetchBuffer(mediaUrl);
          return {
            success: true,
            media: [{ type: isVideo ? 'video' : 'image', url: mediaUrl, buffer: buf || undefined }],
            buffer: buf || undefined,
            videoUrl: isVideo ? mediaUrl : undefined,
            imageUrl: !isVideo ? mediaUrl : undefined,
            title: 'Pinterest Media',
            type: isVideo ? 'video' : 'image',
            engine: 'online:siputzx'
          };
        }
        return { success: false, message: 'Siputzx Pinterest kosong' };
      }
    },
    {
      name: 'Online Ab Pinterest',
      fn: async () => {
        const res = await ab.pinterest(url);
        const mediaUrl = res?.result?.url || res?.url;
        if (mediaUrl) {
          const isVideo = String(mediaUrl).includes('.mp4');
          const buf = await fetchBuffer(mediaUrl);
          return {
            success: true,
            media: [{ type: isVideo ? 'video' : 'image', url: mediaUrl, buffer: buf || undefined }],
            buffer: buf || undefined,
            videoUrl: isVideo ? mediaUrl : undefined,
            imageUrl: !isVideo ? mediaUrl : undefined,
            title: 'Pinterest Media',
            type: isVideo ? 'video' : 'image',
            engine: 'online:ab'
          };
        }
        return { success: false, message: 'Ab Pinterest kosong' };
      }
    }
  ];

  const result = await executeWithSelfHealing(providers, (p) => p.fn(), 25000);
  return result?.success ? result : {
    success: false,
    message: result?.message || '❌ Gagal mengunduh foto/video dari Pinterest.'
  };
}

/**
 * Universal Downloader Fallback
 */
export async function downloadUniversalMedia(url) {
  if (url.includes('instagram.com')) return await downloadInstagram(url);
  if (url.includes('youtube.com') || url.includes('youtu.be')) return await downloadYouTube(url);
  if (url.includes('facebook.com') || url.includes('fb.watch') || url.includes('fb.com')) return await downloadFacebook(url);
  if (url.includes('twitter.com') || url.includes('x.com')) return await downloadTwitter(url);
  if (url.includes('tiktok.com') || url.includes('douyin.com')) return await downloadTikTok(url);
  if (url.includes('pinterest.com') || url.includes('pin.it')) return await downloadPinterest(url);
  
  return { success: false, message: 'Platform media sosial ini belum didukung.' };
}

/**
 * Helper bersama pengirim hasil unduhan ke WhatsApp (dipakai mediaRouter.js & auto-download bot.js).
 * Mendukung foto tunggal, carousel/slide foto, video, dan otomatis mengirim audio latar terpisah
 * untuk slide foto TikTok / IG agar pengguna dapat menyimpan foto dan audionya masing-masing.
 */
export async function kirimHasilUnduhanWA({
  sock,
  jid,
  m,
  res,
  defaultTitle = 'Media',
  headerCaption = null,
  kirimAudioTerpisah = true,
  maxItems = 15
}) {
  if (!res || !res.success) {
    return { ok: false, terkirim: 0, gagal: [], pesanError: res?.message || 'Gagal mengunduh media dari link tersebut.' };
  }

  let mediaList = [];
  if (Array.isArray(res.media) && res.media.length > 0) {
    mediaList = res.media;
  } else if (res.buffer || res.videoUrl || res.imageUrl || res.audioUrl) {
    const isAudio = Boolean(res.audioUrl) && !res.videoUrl && !res.imageUrl;
    const isVideo = Boolean(res.videoUrl) || res.type === 'video';
    mediaList = [{
      type: isAudio ? 'audio' : (isVideo ? 'video' : 'image'),
      buffer: res.buffer,
      url: res.videoUrl || res.imageUrl || res.audioUrl
    }];
  }

  if (mediaList.length === 0) {
    return { ok: false, terkirim: 0, gagal: [], pesanError: 'Media tidak ditemukan pada postingan ini.' };
  }

  const itemsToSend = mediaList.slice(0, maxItems);
  const totalItems = itemsToSend.length;
  const punyaFotoSlide = itemsToSend.some(it => it.type === 'image') || res.type === 'carousel';
  const adaAudioSumber = Boolean(kirimAudioTerpisah && punyaFotoSlide && (res.audioUrl || res.audioBuffer));

  let terkirim = 0;
  let adaFotoTerkirim = false;
  const gagal = [];

  for (let i = 0; i < totalItems; i++) {
    const item = itemsToSend[i];
    const isFirst = terkirim === 0;
    const countInfo = totalItems > 1 ? ` 📸 [${i + 1}/${totalItems}]` : '';

    let caption;
    if (isFirst) {
      const barisJudul = res.title ? `📌 *${String(res.title).slice(0, 140)}*\n` : '';
      const barisAuthor = res.author ? `👤 *Creator:* ${res.author}\n` : '';
      const header = headerCaption ? `${headerCaption}\n\n` : '';
      const catatanAudio = adaAudioSumber ? '\n🎵 _Audio latar slide dikirim terpisah di bawah._' : '';
      caption = `${header}${barisJudul}${barisAuthor}✅ *Berhasil diunduh via Akbar Store Bot*${countInfo}${catatanAudio}`;
    } else if (totalItems > 1) {
      caption = `📸 *${defaultTitle}*${countInfo}`;
    }

    const siap = await siapkanMediaWA(item);
    if (!siap || !siap.ok) {
      gagal.push(siap);
      continue;
    }

    const kutip = terkirim === 0 ? { quoted: m } : {};
    if (siap.kategori === 'image') {
      adaFotoTerkirim = true;
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

  let audioTerkirim = false;
  const harusKirimAudioPisah = Boolean(kirimAudioTerpisah && (adaFotoTerkirim || punyaFotoSlide) && (res.audioUrl || res.audioBuffer));
  if (terkirim > 0 && harusKirimAudioPisah) {
    const siapAudio = await siapkanMediaWA({
      buffer: res.audioBuffer,
      url: res.audioUrl,
      type: 'audio'
    }).catch(() => null);

    if (siapAudio?.ok) {
      const namaDasar = String(res.audioTitle || res.title || `${defaultTitle}_Audio`)
        .replace(/[^a-zA-Z0-9 _.-]/g, '')
        .trim()
        .slice(0, 48) || 'Slide_Audio';
      await sock.sendMessage(jid, {
        audio: siapAudio.buffer,
        mimetype: siapAudio.mimetype,
        fileName: `${namaDasar}.${siapAudio.ext}`
      });
      audioTerkirim = true;
    }
  }

  if (terkirim > 0 && mediaList.length > maxItems) {
    await sock.sendMessage(jid, {
      text: `ℹ️ Menampilkan ${maxItems} dari ${mediaList.length} item slide agar tidak melebihi batas kirim sekaligus.`
    });
  }

  return {
    ok: terkirim > 0,
    terkirim,
    audioTerkirim,
    gagal,
    totalDipilih: totalItems
  };
}

/**
 * Konversi Gambar/Video Buffer ke Stiker WhatsApp (Statis / Animasi WebP)
 */
export async function createSticker(imageOrVideoBuffer, pack = 'Akbar Store Bot', author = 'Sales System', isVideo = false, stickerType = StickerTypes.CROPPED) {
  const tipeStikerAman = typeof stickerType === 'string' && Object.values(StickerTypes).includes(stickerType)
    ? stickerType
    : StickerTypes.CROPPED;
  try {
    if (isVideo) {
      const tmpDir = path.join(process.cwd(), 'tmp');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

      const inputPath = path.join(tmpDir, `in_${Date.now()}.mp4`);
      const outputPath = path.join(tmpDir, `out_${Date.now()}.webp`);

      fs.writeFileSync(inputPath, imageOrVideoBuffer);

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .inputOptions(['-t 4'])
          .outputOptions([
            '-vcodec libwebp',
            '-vf scale=512:512:flags=lanczos:force_original_aspect_ratio=decrease,fps=10,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
            '-lossless 0',
            '-compression_level 6',
            '-q:v 35',
            '-loop 0',
            '-an',
            '-vsync 0'
          ])
          .toFormat('webp')
          .on('end', resolve)
          .on('error', reject)
          .save(outputPath);
      });

      const rawWebpBuffer = fs.readFileSync(outputPath);

      try {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      } catch (e) {}

      const exif = new Exif({ pack, author });
      const finalBuffer = await exif.add(rawWebpBuffer);
      return { success: true, buffer: finalBuffer };
    }

    const sticker = new Sticker(imageOrVideoBuffer, {
      pack: pack,
      author: author,
      type: tipeStikerAman,
      quality: 75
    });

    const stickerBuffer = await sticker.toBuffer();
    return { success: true, buffer: stickerBuffer };
  } catch (err) {
    console.error('[MEDIA_HANDLER] Sticker Error:', err.message);
    try {
      const sticker = new Sticker(imageOrVideoBuffer, {
        pack: pack,
        author: author,
        type: tipeStikerAman,
        quality: 40
      });
      const stickerBuffer = await sticker.toBuffer();
      return { success: true, buffer: stickerBuffer };
    } catch (e) {
      return { success: false, message: err.message };
    }
  }
}

/**
 * Konversi Stiker WebP ke Gambar (JPG/PNG)
 */
export async function stickerToImage(webpBuffer) {
  try {
    const jpgBuffer = await sharp(webpBuffer)
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 95 })
      .toBuffer();
    return { success: true, buffer: jpgBuffer };
  } catch (err) {
    console.error('[MEDIA_HANDLER] ToImg Error:', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * Konversi Stiker WebP ke Video MP4
 */
export async function stickerToVideo(webpBuffer) {
  const tmpDir = path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const inputPath = path.join(tmpDir, `stk_${Date.now()}.webp`);
  const outputPath = path.join(tmpDir, `vid_${Date.now()}.mp4`);

  fs.writeFileSync(inputPath, webpBuffer);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-vcodec libx264',
          '-pix_fmt yuv420p',
          '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2'
        ])
        .toFormat('mp4')
        .on('end', resolve)
        .on('error', reject)
        .save(outputPath);
    });

    const videoBuffer = fs.readFileSync(outputPath);

    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    return { success: true, buffer: videoBuffer };
  } catch (err) {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    console.error('[MEDIA_HANDLER] ToVideo Error:', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * Helper Canvas Rounded Rect
 */
function drawRoundedRect(ctx, x, y, width, height, radius, fillStyle) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

/**
 * Pecah teks menjadi baris sesuai batas lebar piksel, menghormati newline (`\n`)
 * dan memotong kata yang terlalu panjang agar tidak keluar gelembung chat.
 */
function bungkusTeksCanvas(ctx, teks, maxWidth) {
  const paragraf = String(teks || '').split(/\r?\n/);
  const lines = [];
  for (const p of paragraf) {
    const words = p.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      if (lines.length > 0) lines.push(' ');
      continue;
    }
    let currentLine = '';
    for (const word of words) {
      if (ctx.measureText(word).width > maxWidth) {
        if (currentLine) {
          lines.push(currentLine);
          currentLine = '';
        }
        let potong = '';
        for (const ch of Array.from(word)) {
          if (ctx.measureText(potong + ch).width > maxWidth && potong) {
            lines.push(potong);
            potong = ch;
          } else {
            potong += ch;
          }
        }
        currentLine = potong;
        continue;
      }
      const testLine = (currentLine + ' ' + word).trim();
      if (ctx.measureText(testLine).width <= maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
  }
  return lines.length > 0 ? lines : [' '];
}

/**
 * Buat Stiker Quote Chat WhatsApp (QC) dengan font Segoe UI + Segoe UI Emoji
 */
export async function generateQuoteSticker(name, text, avatarUrl = null) {
  try {
    pastikanFontCanvasSiap();

    const canvasWidth = 600;
    const canvasHeight = 600;
    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    const maxTextWidth = 445;
    let bodyFontSize = 24;
    let lines = [];
    for (const ukuran of [24, 21, 18]) {
      bodyFontSize = ukuran;
      ctx.font = `400 ${bodyFontSize}px ${FONT_STACK_QC}`;
      lines = bungkusTeksCanvas(ctx, text, maxTextWidth);
      if (lines.length <= 12) break;
    }

    const lineHeight = Math.round(bodyFontSize * 1.42);
    ctx.font = `400 ${bodyFontSize}px ${FONT_STACK_QC}`;
    const textWidths = lines.map(l => ctx.measureText(l).width);

    ctx.font = `700 25px ${FONT_STACK_QC}`;
    const safeName = (name || 'Pelanggan').trim() || 'Pelanggan';
    const nameWidth = ctx.measureText(safeName).width;

    const bubbleWidth = Math.min(515, Math.max(260, Math.ceil(nameWidth) + 64, Math.ceil(Math.max(...textWidths)) + 58));
    const bubbleHeight = Math.min(540, Math.max(124, 78 + (lines.length * lineHeight)));

    const startX = 68;
    const startY = Math.floor((canvasHeight - bubbleHeight) / 2);

    ctx.save();
    let avatarDrawn = false;
    if (avatarUrl) {
      try {
        const avRes = await axios.get(avatarUrl, { responseType: 'arraybuffer', timeout: 3500 });
        if (avRes.status === 200 && avRes.data) {
          const avImg = await loadImage(Buffer.from(avRes.data));
          ctx.beginPath();
          ctx.arc(startX - 32, startY + 26, 22, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(avImg, startX - 54, startY + 4, 44, 44);
          avatarDrawn = true;
        }
      } catch (_) {}
    }

    if (!avatarDrawn) {
      ctx.fillStyle = '#00a884';
      ctx.beginPath();
      ctx.arc(startX - 32, startY + 26, 22, 0, Math.PI * 2);
      ctx.fill();

      const initial = (Array.from(safeName)[0] || 'P').toUpperCase();
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 21px ${FONT_STACK_QC}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initial, startX - 32, startY + 26);
    }
    ctx.restore();

    drawRoundedRect(ctx, startX, startY, bubbleWidth, bubbleHeight, 20, '#202c33');

    ctx.fillStyle = '#202c33';
    ctx.beginPath();
    ctx.moveTo(startX + 2, startY + 14);
    ctx.lineTo(startX - 13, startY + 22);
    ctx.lineTo(startX + 2, startY + 34);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#00a884';
    ctx.font = `700 25px ${FONT_STACK_QC}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(safeName, startX + 26, startY + 20);

    ctx.fillStyle = '#e9edef';
    ctx.font = `400 ${bodyFontSize}px ${FONT_STACK_QC}`;
    lines.forEach((line, index) => {
      ctx.fillText(line, startX + 26, startY + 60 + (index * lineHeight));
    });

    const rawPng = await canvas.encode('png');
    const trimmedBuffer = await sharp(rawPng)
      .trim()
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    return await createSticker(trimmedBuffer, 'Akbar Store Quote', safeName, false, StickerTypes.FULL);
  } catch (err) {
    console.error('[MEDIA_HANDLER] Quote Canvas Error:', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * Buat Gambar Meme
 */
export async function generateMeme(imageBuffer, topText = '', bottomText = '') {
  try {
    const baseImage = await loadImage(imageBuffer);
    const width = baseImage.width;
    const height = baseImage.height;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.drawImage(baseImage, 0, 0, width, height);

    const top = (topText || '').toUpperCase().trim();
    const bottom = (bottomText || '').toUpperCase().trim();

    const fontSize = Math.floor(width / 12);
    ctx.font = `900 ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = Math.max(3, Math.floor(fontSize / 10));

    if (top) {
      ctx.strokeText(top, width / 2, height * 0.15);
      ctx.fillText(top, width / 2, height * 0.15);
    }

    if (bottom) {
      ctx.strokeText(bottom, width / 2, height * 0.90);
      ctx.fillText(bottom, width / 2, height * 0.90);
    }

    const jpegBuffer = await canvas.encode('jpeg');
    return { success: true, buffer: jpegBuffer };
  } catch (err) {
    console.error('[MEDIA_HANDLER] Meme Canvas Error:', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * Screenshot Website URL (.ssweb)
 */
export async function screenshotWeb(url) {
  const cleanUrl = url.startsWith('http') ? url : `https://${url}`;

  try {
    const ssUrl = `https://image.thum.io/get/width/1000/crop/800/${cleanUrl}`;
    const res = await fetch(ssUrl);
    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > 5000) return { success: true, buffer: buffer };
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] SSWeb Provider 1 failed:', err.message);
  }

  try {
    const res2 = await fetch(`https://mini.s-shot.ru/1024x768/JPEG/1024/Z100/?${encodeURIComponent(cleanUrl)}`);
    if (res2.ok) {
      const buffer2 = Buffer.from(await res2.arrayBuffer());
      if (buffer2.length > 5000) return { success: true, buffer: buffer2 };
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] SSWeb Provider 2 failed:', err.message);
  }

  return { success: false, message: 'Gagal mengambil screenshot website. Pastikan link valid & dapat diakses.' };
}

/**
 * Buat Stiker Brat Generator (font Arial Narrow terdaftar resmi + efek low-res halus otentik)
 */
export async function generateBratSticker(text) {
  try {
    pastikanFontCanvasSiap();

    const canvasWidth = 512;
    const canvasHeight = 512;
    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const cleanText = (text || 'brat').toLowerCase().trim() || 'brat';

    // Skala horizontal ~92% meniru proporsi tipis sampul album Brat
    const skalaX = 0.92;
    const padX = 36;
    const maxLineWidth = (canvasWidth - padX * 2) / skalaX;
    const maxAreaHeight = canvasHeight - 72;

    let fontSize = 96;
    let lines = [];
    let lineHeight = 100;

    for (let size = 104; size >= 24; size -= 4) {
      ctx.font = `400 ${size}px ${FONT_STACK_BRAT}`;
      const kandidatBaris = bungkusTeksCanvas(ctx, cleanText, maxLineWidth);
      const kandidatLH = Math.round(size * 1.12);
      if (kandidatBaris.length * kandidatLH <= maxAreaHeight) {
        fontSize = size;
        lines = kandidatBaris;
        lineHeight = kandidatLH;
        break;
      }
      fontSize = size;
      lines = kandidatBaris;
      lineHeight = kandidatLH;
    }

    const totalHeight = lines.length * lineHeight;
    const startY = Math.max(36, Math.floor((canvasHeight - totalHeight) / 2));

    ctx.save();
    ctx.scale(skalaX, 1);
    ctx.fillStyle = '#000000';
    ctx.font = `400 ${fontSize}px ${FONT_STACK_BRAT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    const drawX = Math.round(padX / skalaX);
    lines.forEach((line, i) => {
      ctx.fillText(line, drawX, startY + (i * lineHeight));
    });
    ctx.restore();

    const rawPng = await canvas.encode('png');

    // Efek blur low-res halus otentik Brat tanpa piksel kotak patah
    const finalBuffer = await sharp(rawPng)
      .resize(280, 280, { kernel: 'cubic' })
      .blur(1.25)
      .resize(512, 512, { kernel: 'lanczos3' })
      .png()
      .toBuffer();

    return await createSticker(finalBuffer, 'Brat Generator', 'Akbar Store', false);
  } catch (err) {
    console.error('[MEDIA_HANDLER] Brat Error:', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * Download Lagu MP3 dari Judul / Kata Kunci Search
 */
export async function downloadSongBySearch(query) {
  const tmpDir = path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  
  const uniquePrefix = `song_${Date.now()}_${Math.floor(Math.random() * 1000)}_`;
  const outputTemplate = path.join(tmpDir, `${uniquePrefix}%(title)s.%(ext)s`);

  const fileArgs = [
    '-m', 'yt_dlp',
    '--no-warnings',
    '--no-playlist',
    '--geo-bypass',
    '--retries', '3',
    '--socket-timeout', '20',
    '--no-mtime',
    '--ffmpeg-location', ffmpegInstaller.path,
    // Selektor lama `ba[filesize<15M]/bestaudio/best` sering jatuh ke `best`
    // (format gabungan 360p) sehingga MP3-nya diekstrak dari audio 128k video.
    '-f', FORMAT_AUDIO_WA,
    '--max-filesize', '30M',
    // Lihat catatan di downloadWithYtdlp: 'best' = simpan wadah asli, jangan
    // kodekan ulang. Jalur inilah yang dipakai `.song <judul>` dan `.play`.
    '--extract-audio',
    '--audio-format', 'best',
    '-o', outputTemplate,
    `ytsearch1:${query}`
  ];

  // Exit code diabaikan: yt-dlp bisa keluar bukan 0 walau MP3-nya sudah jadi.
  await runPythonProc(fileArgs, 180000);
  try {
    const files = fs.readdirSync(tmpDir);
    // Ekstensi tidak lagi dipatok '.mp3'. Sejak konversi dibuang, berkasnya
    // keluar sebagai .m4a (atau .opus/.webm kalau jatuh ke format cadangan), dan
    // pencarian yang mengunci '.mp3' tidak akan menemukan apa pun — lagunya
    // terunduh utuh lalu dilaporkan gagal.
    const EKSTENSI_AUDIO = ['.m4a', '.mp3', '.opus', '.ogg', '.webm', '.aac', '.flac', '.wav'];
    const matchedFile = files.find(f =>
      f.startsWith(uniquePrefix) && EKSTENSI_AUDIO.some(e => f.toLowerCase().endsWith(e))
    );
    if (matchedFile) {
      const filePath = path.join(tmpDir, matchedFile);
      const buffer = fs.readFileSync(filePath);
      const ekstensi = path.extname(matchedFile);
      const title = matchedFile.substring(uniquePrefix.length, matchedFile.length - ekstensi.length);
      // Jenisnya dibaca dari ISI berkas, bukan dari namanya: mimetype yang salah
      // (menandai data AAC sebagai audio/mpeg) membuat iOS menolak memutarnya.
      const jenis = deteksiJenisMedia(buffer);
      bersihkanSisaUnduhan(tmpDir, uniquePrefix);
      if (buffer.length > 5000) {
        // m4a dan mp4 punya byte penanda yang SAMA ('ftyp'), jadi deteksi wadah
        // memulangkan 'mp4' untuk berkas yang sebenarnya audio saja. Unduhan ini
        // memang audio-only, jadi labelnya dibetulkan di sini — menandai data AAC
        // sebagai video/mp4 (atau audio/mpeg) membuat iOS menolak memutarnya.
        const audioMp4 = !jenis || jenis.wadah === 'mp4' || jenis.wadah === 'm4a';
        return {
          success: true,
          buffer,
          title,
          mimetype: audioMp4 ? 'audio/mp4' : jenis.mimetype,
          ext: audioMp4 ? 'm4a' : jenis.ext
        };
      }
    }
    bersihkanSisaUnduhan(tmpDir, uniquePrefix);
  } catch (e) {
    bersihkanSisaUnduhan(tmpDir, uniquePrefix);
    return { success: false, message: e.message };
  }

  return { success: false, message: 'Gagal mendownload lagu. Pastikan judul lagu benar atau coba beberapa saat lagi.' };
}

/**
 * Konversi Video Buffer ke MP3 / Voice Note Audio
 */
export async function convertVideoToAudio(inputBuffer, outputFormat = 'mp3') {
  return new Promise((resolve, reject) => {
    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    
    const inputPath = path.join(tmpDir, `input_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`);
    const outputPath = path.join(tmpDir, `output_${Date.now()}_${Math.floor(Math.random() * 1000)}.${outputFormat === 'vn' ? 'ogg' : outputFormat}`);
    
    fs.writeFileSync(inputPath, inputBuffer);
    
    let ff = ffmpeg(inputPath);
    if (outputFormat === 'vn' || outputFormat === 'ogg') {
      ff = ff.toFormat('ogg').audioCodec('libopus');
    } else {
      ff = ff.toFormat('mp3');
    }
    
    ff.on('end', () => {
      try {
        const outBuffer = fs.readFileSync(outputPath);
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        resolve(outBuffer);
      } catch (e) {
        reject(e);
      }
    })
    .on('error', (err) => {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      reject(err);
    })
    .save(outputPath);
  });
}

/**
 * Dapatkan Informasi Lagu dari YouTube / Query Pencarian
 */
export async function getSongInfo(query) {
  try {
    const isUrl = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(query);
    if (!isUrl) {
      try {
        const ytRes = await ruhend.ytsearch(query);
        const item = ytRes?.video?.[0];
        if (item) {
          const thumbBuf = item.thumbnail ? await fetchBuffer(item.thumbnail) : null;
          let artist = item.authorName || 'Artis';
          let title = item.title;
          if (title.includes(' - ')) {
            const parts = title.split(' - ');
            artist = parts[0].trim();
            title = parts.slice(1).join(' - ').trim();
          }
          title = title.replace(/\s*[([].*?(official|video|audio|lyric|lirik|remix|hd|4k|mv|music).*?[)\]]/gi, '').trim();
          return {
            success: true,
            title: title || item.title,
            artist,
            duration: item.duration || '03:30',
            url: item.url,
            thumbnailBuffer: thumbBuf
          };
        }
      } catch (e) {
        console.warn('[GET_SONG_INFO_RUHEND_WARN]', e.message);
      }
    }

    const ytdlpData = await extractWithYtdlpJson(query.startsWith('http') ? query : `ytsearch1:${query}`);
    if (ytdlpData) {
      const entry = (Array.isArray(ytdlpData.entries) && ytdlpData.entries[0]) || ytdlpData;
      let title = entry.title || query;
      let artist = entry.uploader || entry.channel || 'Artis';
      if (title.includes(' - ')) {
        const parts = title.split(' - ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
      }
      title = title.replace(/\s*[([].*?(official|video|audio|lyric|lirik|remix|hd|4k|mv|music).*?[)\]]/gi, '').trim();
      const thumbUrl = entry.thumbnail || entry.thumbnails?.[entry.thumbnails.length - 1]?.url;
      const thumbBuf = thumbUrl ? await fetchBuffer(thumbUrl) : null;
      const durSec = entry.duration || 210;
      const mins = Math.floor(durSec / 60);
      const secs = Math.floor(durSec % 60).toString().padStart(2, '0');
      return {
        success: true,
        title: title || entry.title,
        artist,
        duration: `${mins}:${secs}`,
        url: entry.webpage_url || entry.url || (entry.id ? `https://youtube.com/watch?v=${entry.id}` : query),
        thumbnailBuffer: thumbBuf
      };
    }
  } catch (err) {
    console.error('[GET_SONG_INFO_ERR]', err.message);
  }
  return { success: false, title: query, artist: 'Artis', duration: '03:30', url: '' };
}

/**
 * Cari Lirik Lagu Spotify (LRCLIB API) & Cover Album HD (iTunes Search API)
 */
export async function getSongLyrics(query, artist = '') {
  try {
    const cleanQ = query.replace(/\s*[([].*?[)\]]/g, '').trim();
    const lrcUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanQ)}`;
    const lrcRes = await axios.get(lrcUrl, {
      timeout: 7000,
      headers: { 'User-Agent': getRandomUserAgent() }
    }).catch(() => null);

    let match = null;
    if (Array.isArray(lrcRes?.data) && lrcRes.data.length > 0) {
      match = lrcRes.data[0];
      if (artist && artist !== 'Artis') {
        const found = lrcRes.data.find(d => (d.artistName || '').toLowerCase().includes(artist.toLowerCase()));
        if (found) match = found;
      }
    }

    const title = match?.trackName || query;
    const songArtist = match?.artistName || (artist && artist !== 'Artis' ? artist : 'Artis');
    const album = match?.albumName || title;
    const lyrics = match?.plainLyrics || match?.syncedLyrics || '';
    const syncedLyrics = match?.syncedLyrics || '';

    const rawLines = (lyrics || '').split('\n')
      .map(l => l.replace(/\[\d+:\d+\.\d+\]/, '').trim())
      .filter(l => l && !l.startsWith('['));
    const snippetLines = rawLines.slice(0, 4);

    let coverBuffer = null;
    try {
      const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(`${songArtist} ${title}`)}&entity=song&limit=1`;
      const itunesRes = await axios.get(itunesUrl, { timeout: 5000 }).catch(() => null);
      const itunesItem = itunesRes?.data?.results?.[0];
      if (itunesItem?.artworkUrl100) {
        const hdArtworkUrl = itunesItem.artworkUrl100.replace('100x100bb', '800x800bb');
        coverBuffer = await fetchBuffer(hdArtworkUrl);
      }
    } catch {}

    if (lyrics) {
      return {
        success: true,
        title,
        artist: songArtist,
        album,
        lyrics,
        syncedLyrics,
        snippetLines,
        coverBuffer
      };
    }
  } catch (err) {
    console.warn('[GET_SONG_LYRICS_WARN]', err.message);
  }
  return { success: false, message: 'Lirik lagu tidak ditemukan.' };
}

/**
 * Sematkan Tag ID3 (Cover, Lirik, Artis, Judul, Album) ke Berkas MP3
 */
export async function embedMetadataAndLyricsToMp3({
  audioBuffer,
  coverBuffer = null,
  lyrics = '',
  syncedLyrics = '',
  title = 'Lagu',
  artist = 'Artis',
  album = 'Album'
}) {
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer)) return audioBuffer;
  try {
    let mp3Buf = audioBuffer;
    const wadah = deteksiWadah(audioBuffer);
    if (wadah !== 'mp3') {
      const converted = await convertVideoToAudio(audioBuffer, 'mp3').catch(() => null);
      if (converted && converted.length > 5000) {
        mp3Buf = converted;
      }
    }

    const tags = {
      title,
      artist,
      album
    };

    if (lyrics) {
      tags.unsynchronisedLyrics = {
        language: 'ind',
        text: lyrics
      };
    }

    if (coverBuffer && Buffer.isBuffer(coverBuffer)) {
      tags.image = {
        mime: 'image/jpeg',
        type: { id: 3, name: 'front cover' },
        description: 'Cover Art',
        imageBuffer: coverBuffer
      };
    }

    const id3 = NodeID3.default || NodeID3;
    const tagged = id3.write(tags, mp3Buf);
    return tagged || mp3Buf;
  } catch (err) {
    console.warn('[EMBED_ID3_WARN]', err.message);
    return audioBuffer;
  }
}

/**
 * Buat Arsip Paket Lengkap ZIP (.mp3 + .lrc + Cover HD)
 */
export async function createSongBundleZip({
  mp3Buffer,
  lrcText = '',
  coverBuffer = null,
  title = 'Lagu',
  artist = 'Artis'
}) {
  const tmpDir = path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const cleanBaseName = `${artist} - ${title}`.replace(/[/\\?%*:|"<>]/g, '').trim() || 'Spotify_Offline';
  const bundleDir = path.join(tmpDir, `bundle_${Date.now()}_${Math.floor(Math.random() * 1000)}`);
  fs.mkdirSync(bundleDir, { recursive: true });

  const filesToAdd = [];

  const mp3Path = path.join(bundleDir, `${cleanBaseName}.mp3`);
  fs.writeFileSync(mp3Path, mp3Buffer);
  filesToAdd.push(mp3Path);

  if (lrcText) {
    const lrcPath = path.join(bundleDir, `${cleanBaseName}.lrc`);
    fs.writeFileSync(lrcPath, lrcText, 'utf8');
    filesToAdd.push(lrcPath);
  }

  if (coverBuffer && Buffer.isBuffer(coverBuffer)) {
    const coverPath = path.join(bundleDir, `${cleanBaseName}_Cover.jpg`);
    fs.writeFileSync(coverPath, coverBuffer);
    filesToAdd.push(coverPath);
  }

  const zipPath = path.join(tmpDir, `zip_${Date.now()}_${Math.floor(Math.random() * 1000)}.zip`);

  try {
    await runPythonProc(['-m', 'zipfile', '-c', zipPath, ...filesToAdd], 30000);
    if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 100) {
      const buffer = fs.readFileSync(zipPath);
      return {
        buffer,
        fileName: `${cleanBaseName}.zip`
      };
    }
  } catch (err) {
    console.error('[CREATE_ZIP_ERR]', err.message);
  } finally {
    try { fs.rmSync(bundleDir, { recursive: true, force: true }); } catch {}
    try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch {}
  }
  return null;
}

/**
 * Generate Video Vertikal 9:16 Spotify Canvas MP4
 */
export async function generateSpotifyCanvasVideo({
  imageBuffer,
  audioBuffer,
  duration = 25
}) {
  const tmpDir = path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const prefix = `canvas_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const inImgPath = path.join(tmpDir, `${prefix}_img.jpg`);
  const inAudPath = path.join(tmpDir, `${prefix}_aud.mp3`);
  const outVidPath = path.join(tmpDir, `${prefix}_out.mp4`);

  try {
    fs.writeFileSync(inImgPath, imageBuffer);
    fs.writeFileSync(inAudPath, audioBuffer);

    const args = [
      '-y',
      '-loop', '1',
      '-i', inImgPath,
      '-i', inAudPath,
      '-c:v', 'libx264',
      '-tune', 'stillimage',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-pix_fmt', 'yuv420p',
      '-t', String(duration || 25),
      '-shortest',
      '-movflags', '+faststart',
      outVidPath
    ];

    const ok = await jalankanFfmpeg(args, 60000);
    if (ok && fs.existsSync(outVidPath) && fs.statSync(outVidPath).size > 5000) {
      const buffer = fs.readFileSync(outVidPath);
      return buffer;
    }
  } catch (err) {
    console.error('[CANVAS_VIDEO_ERR]', err.message);
  } finally {
    try { if (fs.existsSync(inImgPath)) fs.unlinkSync(inImgPath); } catch {}
    try { if (fs.existsSync(inAudPath)) fs.unlinkSync(inAudPath); } catch {}
    try { if (fs.existsSync(outVidPath)) fs.unlinkSync(outVidPath); } catch {}
  }
  return null;
}

/**
 * Terjemah Teks via Google Translate
 */
export async function translateText(text, targetLang = 'id') {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await axios.get(url, {
      headers: { 'User-Agent': getRandomUserAgent() }
    });
    if (res.data && res.data[0]) {
      const translatedParts = res.data[0].map(part => part[0]).filter(Boolean);
      return translatedParts.join('');
    }
    throw new Error('Format respon tidak valid.');
  } catch (err) {
    console.error('[TRANSLATE ERROR]', err.message);
    return null;
  }
}

/**
 * Jadwal Sholat per Kota
 */
export async function getPrayerTimes(city) {
  try {
    const url = `https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(city)}&country=Indonesia`;
    const res = await axios.get(url);
    if (res.data && res.data.data && res.data.data.timings) {
      return {
        success: true,
        timings: res.data.data.timings,
        meta: res.data.data.meta
      };
    }
    return { success: false, message: 'Kota tidak ditemukan.' };
  } catch (err) {
    console.error('[PRAYER_TIMES_ERR]', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * Peningkatan Kualitas Foto HD (.hd / .remini)
 */
export async function enhanceImageHd(imageBuffer) {
  try {
    try {
      const base64Str = imageBuffer.toString('base64');
      const apiRes = await axios.post('https://api.siputzx.my.id/api/tools/remini', {
        image: `data:image/jpeg;base64,${base64Str}`
      }, { timeout: 3000 });

      if (apiRes.data && apiRes.data.status && apiRes.data.data) {
        const imgUrl = apiRes.data.data;
        const downloaded = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 5000 });
        return { success: true, buffer: Buffer.from(downloaded.data), provider: 'AI Remini Online' };
      }
    } catch (_) {
      // Siputzx remini API offline, proceed instantly to local Sharp HD engine
    }

    const meta = await sharp(imageBuffer).metadata();
    const origW = meta.width || 800;
    const origH = meta.height || 600;

    const scale = origW < 1200 ? 2.5 : 1.8;
    const targetW = Math.min(3200, Math.round(origW * scale));
    const targetH = Math.min(3200, Math.round(origH * scale));

    const processedBuffer = await sharp(imageBuffer)
      .resize(targetW, targetH, { kernel: 'lanczos3' })
      .sharpen({ sigma: 1.8, m1: 1.2, m2: 2.5 })
      .linear(1.12, -10)
      .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
      .toBuffer();

    return { success: true, buffer: processedBuffer, provider: 'Sharp HD Ultra' };
  } catch (err) {
    console.error('[ENHANCE_HD_ERR]', err.message);
    return { success: false, message: 'Gagal memproses peningkatan kualitas gambar: ' + err.message };
  }
}
