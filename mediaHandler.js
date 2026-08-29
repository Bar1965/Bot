import { Sticker, StickerTypes, Exif } from 'wa-sticker-formatter';
import sharp from 'sharp';
import { createCanvas, loadImage } from '@napi-rs/canvas';
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

const httpsAgent = new https.Agent({ rejectUnauthorized: false, family: 4 });

import { isApiHealthy, reportApiSuccess, reportApiFailure, executeWithSelfHealing } from './src/utils/circuitBreaker.js';

// Set FFMPEG Path global agar wa-sticker-formatter & ffmpeg menggunakan binary asli
process.env.FFMPEG_PATH = ffmpegInstaller.path;
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
process.env.YTDL_NO_UPDATE = 'true';

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

export async function fetchBuffer(url) {
  if (!url) return null;
  try {
    const res = await axios.get(url, {
      httpsAgent,
      responseType: 'arraybuffer',
      timeout: 30000,
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
        'Referer': 'https://www.google.com/'
      }
    });
    if (res.data) {
      const buf = Buffer.from(res.data);
      if (buf.length > 3000) return buf;
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] fetchBuffer error:', err.message);
  }
  return null;
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
 * Bungkus ulang berkas ke MP4 H.264/AAC. Coba remux (-c copy, instan) dulu;
 * hanya transcode kalau codec-nya memang tidak didukung wadah MP4.
 */
async function remuxKeMp4(inputPath) {
  const outputPath = `${inputPath}.wa.mp4`;
  const dasar = ['-y', '-i', inputPath, '-movflags', '+faststart'];

  const percobaan = [
    [...dasar, '-c', 'copy', outputPath],
    [...dasar, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', outputPath]
  ];

  for (const args of percobaan) {
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    const res = await new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(ffmpegInstaller.path, args, { timeout: 240000, windowsHide: true });
      } catch { resolve(null); return; }
      proc.stderr?.on('data', () => {});
      proc.on('close', (code) => resolve({ code }));
      proc.on('error', () => resolve(null));
    });

    if (res && res.code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 5000) {
      return outputPath;
    }
  }
  try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
  return null;
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

  const formatArgs = isAudio ? [
    '-f', FORMAT_AUDIO_WA,
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '2'
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
  await runPythonProc(fileArgs, 180000);

  // Jangan bergantung pada exit code — yt-dlp sering keluar bukan 0 (mis. saat
  // --max-filesize memangkas satu format) padahal berkas akhirnya sudah jadi.
  let hasil = null;
  try {
    const urutanExt = isAudio
      ? ['.mp3', '.m4a', '.opus', '.ogg', '.webm', '.aac']
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

  return null;
}

/**
 * Download TikTok Video & Slide Foto tanpa watermark — Multi-Tier Failover (TikWM -> SSSTik -> Siputzx -> yt-dlp)
 */
export async function downloadTikTok(url) {
  // Method 1: TikWM API (Mendukung Video tanpa watermark & Slide Foto / Images)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios.post('https://www.tikwm.com/api/', new URLSearchParams({ url, hd: '1' }).toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': getRandomUserAgent(),
        },
        timeout: 10000
      });

      if (res.data) {
        if (res.data.code === 0 && res.data.data) {
          const d = res.data.data;
          const title = d.title || 'TikTok Media';
          const author = d.author?.nickname || 'TikTok Creator';

          // Cek jika postingan berisi slide foto (TikTok Photo Slideshow)
          if (Array.isArray(d.images) && d.images.length > 0) {
            const mediaList = d.images.map(imgUrl => ({ type: 'image', url: imgUrl }));
            return {
              success: true,
              media: mediaList,
              title,
              author,
              type: 'carousel'
            };
          }

          // Jika video
          const streamUrl = d.play || d.wmplay || d.hdplay;
          if (streamUrl) {
            const buf = await fetchBuffer(streamUrl);
            return {
              success: true,
              media: [{ type: 'video', url: streamUrl, buffer: buf || undefined }],
              buffer: buf || undefined,
              videoUrl: streamUrl,
              title,
              author,
              type: 'video'
            };
          }
        } else if (res.data.code === -1 && attempt === 1) {
          await new Promise(r => setTimeout(r, 1200));
          continue;
        }
      }
    } catch (err) {
      console.log(`[MEDIA_HANDLER] TikTok TikWM attempt ${attempt} failed:`, err.message);
    }
  }

  // Method 2: Siputzx TikTok API (Mendukung Foto & Video)
  try {
    const res = await axios.get(`https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(url)}`, {
      headers: { 'User-Agent': getRandomUserAgent() },
      timeout: 10000
    });
    if (res.data && res.data.data) {
      const d = res.data.data;
      if (Array.isArray(d.images) && d.images.length > 0) {
        const mediaList = d.images.map(imgUrl => ({ type: 'image', url: imgUrl }));
        return {
          success: true,
          media: mediaList,
          title: d.title || 'TikTok Photos',
          author: d.author || 'TikTok Creator',
          type: 'carousel'
        };
      }

      const streamUrl = d.urls?.[0] || d.video || d.play;
      if (streamUrl) {
        const buf = await fetchBuffer(streamUrl);
        return {
          success: true,
          media: [{ type: 'video', url: streamUrl, buffer: buf || undefined }],
          buffer: buf || undefined,
          videoUrl: streamUrl,
          title: d.title || 'TikTok Video',
          type: 'video'
        };
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] TikTok Method 2 (Siputzx) failed:', err.message);
  }

  // Method 3: SSSTik API
  try {
    const res = await axios.post('https://ssstik.io/abc?url=dl', `id=${encodeURIComponent(url)}&locale=en&tt=1`, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': getRandomUserAgent(),
        'Origin': 'https://ssstik.io',
        'Referer': 'https://ssstik.io/en'
      },
      timeout: 10000
    });
    if (res.data) {
      const match = res.data.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/i) || res.data.match(/href="(https:\/\/[^"]+tik-tok[^"]*)"/i);
      if (match) {
        const streamUrl = match[1];
        const buf = await fetchBuffer(streamUrl);
        return { 
          success: true, 
          media: [{ type: 'video', url: streamUrl, buffer: buf || undefined }],
          buffer: buf || undefined,
          videoUrl: streamUrl, 
          title: 'TikTok Video',
          type: 'video'
        };
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] TikTok Method 3 (SSSTik) failed:', err.message);
  }

  // Method 4: yt-dlp CLI fallback
  const ytdlpResult = await downloadWithYtdlp(url);
  if (ytdlpResult?.buffer || ytdlpResult?.videoUrl) {
    return {
      success: true,
      media: [{ type: 'video', url: ytdlpResult.videoUrl, buffer: ytdlpResult.buffer }],
      buffer: ytdlpResult.buffer,
      videoUrl: ytdlpResult.videoUrl,
      title: ytdlpResult.title || 'TikTok Video',
      type: 'video'
    };
  }

  return { success: false, message: '❌ Gagal mengunduh foto/video TikTok. Pastikan link valid dan akun bersifat publik.' };
}

/**
 * Ambil audio / sound TikTok (.ttmp3)
 *
 * Fungsi ini sebelumnya tidak pernah ada padahal bot.js sudah memanggilnya, jadi
 * `.ttmp3` selalu berakhir dengan TypeError "downloadTikTokAudio is not a function".
 */
export async function downloadTikTokAudio(url) {
  // Method 1: TikWM — punya URL sound asli (mime audio/mpeg)
  try {
    const res = await axios.post('https://www.tikwm.com/api/', new URLSearchParams({ url, hd: '1' }).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': getRandomUserAgent()
      },
      timeout: 12000
    });

    const d = res.data?.code === 0 ? res.data.data : null;
    if (d) {
      const musicUrl = d.music || d.music_info?.play;
      const title = d.music_info?.title || d.title || 'TikTok Audio';
      if (musicUrl) {
        const buf = await fetchBuffer(musicUrl);
        if (buf) {
          const wadah = deteksiWadah(buf);
          return {
            success: true,
            buffer: buf,
            title,
            mimetype: wadah === 'mp4' ? 'audio/mp4' : 'audio/mpeg',
            ext: wadah === 'mp4' ? 'm4a' : 'mp3'
          };
        }
        return { success: true, audioUrl: musicUrl, title, mimetype: 'audio/mpeg', ext: 'mp3' };
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] TikTok Audio Method 1 (TikWM) failed:', err.message);
  }

  // Method 2: unduh videonya lalu ekstrak jalur suaranya
  try {
    const videoRes = await downloadTikTok(url);
    let videoBuffer = videoRes?.buffer;
    if (!videoBuffer && videoRes?.videoUrl) videoBuffer = await fetchBuffer(videoRes.videoUrl);
    if (videoBuffer) {
      const audioBuffer = await convertVideoToAudio(videoBuffer, 'mp3');
      if (audioBuffer && audioBuffer.length > 5000) {
        return {
          success: true,
          buffer: audioBuffer,
          title: videoRes.title || 'TikTok Audio',
          mimetype: 'audio/mpeg',
          ext: 'mp3'
        };
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] TikTok Audio Method 2 (ekstrak video) failed:', err.message);
  }

  return { success: false, message: '❌ Gagal mengambil audio TikTok. Pastikan link valid dan akun bersifat publik.' };
}

/**
 * Download Instagram Reels / Posts / Single Photo / Multiple Photo Carousels — Multi-Tier Failover
 */
export async function downloadInstagram(url) {
  // Method 1: yt-dlp dump-json (Mendukung single photo, video Reels, maupun Carousel/Album multiple photos)
  try {
    const data = await extractWithYtdlpJson(url);
    if (data) {
      const title = data.title || data.description || 'Instagram Media';
      if (Array.isArray(data.entries) && data.entries.length > 0) {
        const mediaList = [];
        for (const e of data.entries) {
          const isVideo = e.ext === 'mp4' || (e.vcodec && e.vcodec !== 'none');
          const itemUrl = e.url || e.formats?.[e.formats.length - 1]?.url || e.thumbnails?.[e.thumbnails.length - 1]?.url;
          if (itemUrl) {
            mediaList.push({ type: isVideo ? 'video' : 'image', url: itemUrl });
          }
        }
        if (mediaList.length > 0) {
          return { success: true, media: mediaList, title, type: 'carousel' };
        }
      } else if (data.url || data.thumbnails?.length > 0) {
        const isVideo = data.ext === 'mp4' || (data.vcodec && data.vcodec !== 'none') || (data.duration && data.duration > 0);
        const itemUrl = isVideo ? (data.url || data.formats?.[data.formats.length - 1]?.url) : (data.url || data.thumbnails?.[data.thumbnails.length - 1]?.url);
        if (itemUrl) {
          return {
            success: true,
            media: [{ type: isVideo ? 'video' : 'image', url: itemUrl }],
            type: isVideo ? 'video' : 'image',
            videoUrl: isVideo ? itemUrl : undefined,
            imageUrl: !isVideo ? itemUrl : undefined,
            title
          };
        }
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] IG Method 1 (yt-dlp JSON) failed:', err.message);
  }

  // Method 2: SSSInstagram API (Mendukung multiple photo & video)
  try {
    const res = await axios.post('https://sssinstagram.com/api/convert',
      JSON.stringify({ url }),
      {
        httpsAgent, timeout: 12000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': getRandomUserAgent(),
          'Referer': 'https://sssinstagram.com/',
          'Origin': 'https://sssinstagram.com'
        }
      }
    );
    if (res.data) {
      if (Array.isArray(res.data.data) && res.data.data.length > 0) {
        const mediaList = res.data.data.map(item => {
          const isVideo = item.type === 'video' || item.url?.includes('.mp4');
          return { type: isVideo ? 'video' : 'image', url: item.url };
        }).filter(item => Boolean(item.url));

        if (mediaList.length > 0) {
          return { success: true, media: mediaList, title: 'Instagram Media', type: mediaList.length > 1 ? 'carousel' : mediaList[0].type };
        }
      } else if (res.data.url) {
        const isVideo = res.data.url.includes('.mp4') || res.data.type === 'video';
        return {
          success: true,
          media: [{ type: isVideo ? 'video' : 'image', url: res.data.url }],
          videoUrl: isVideo ? res.data.url : undefined,
          imageUrl: !isVideo ? res.data.url : undefined,
          title: 'Instagram Media',
          type: isVideo ? 'video' : 'image'
        };
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] IG Method 2 (SSSInstagram) failed:', err.message);
  }

  // Method 3: Siputzx IG Downloader API (Mendukung foto slide & video)
  try {
    const res = await axios.get(`https://api.siputzx.my.id/api/d/igdl?url=${encodeURIComponent(url)}`, {
      headers: { 'User-Agent': getRandomUserAgent() },
      timeout: 12000
    });
    if (res.data && res.data.data) {
      const data = res.data.data;
      if (Array.isArray(data) && data.length > 0) {
        const mediaList = data.map(item => {
          const itemUrl = typeof item === 'string' ? item : (item.url || item.thumbnail);
          const isVideo = (typeof item === 'object' && item.type === 'video') || (itemUrl && itemUrl.includes('.mp4'));
          return { type: isVideo ? 'video' : 'image', url: itemUrl };
        }).filter(item => Boolean(item.url));

        if (mediaList.length > 0) {
          return { success: true, media: mediaList, title: 'Instagram Media', type: mediaList.length > 1 ? 'carousel' : mediaList[0].type };
        }
      } else if (typeof data === 'object' && data.url) {
        const isVideo = data.url.includes('.mp4') || data.type === 'video';
        return {
          success: true,
          media: [{ type: isVideo ? 'video' : 'image', url: data.url }],
          videoUrl: isVideo ? data.url : undefined,
          imageUrl: !isVideo ? data.url : undefined,
          title: 'Instagram Media',
          type: isVideo ? 'video' : 'image'
        };
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] IG Method 3 (Siputzx) failed:', err.message);
  }

  // Method 4: direct igdl package (Mengembalikan seluruh url_list foto & video)
  try {
    const fn = igdl.instagramGetUrl || igdl.default || igdl;
    const res = await fn(url);
    if (res && res.url_list && res.url_list.length > 0) {
      const mediaList = res.url_list.map(u => {
        const isVideo = u.includes('.mp4') || u.includes('/v/') || u.includes('video');
        return { type: isVideo ? 'video' : 'image', url: u };
      }).filter(item => Boolean(item.url));

      if (mediaList.length > 0) {
        return { success: true, media: mediaList, title: 'Instagram Media', type: mediaList.length > 1 ? 'carousel' : mediaList[0].type };
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] IG Method 4 (igdl) failed:', err.message);
  }

  // Method 5: SnapSave API
  try {
    const res = await axios.post('https://snapsave.app/action.php', `url=${encodeURIComponent(url)}`, {
      httpsAgent,
      timeout: 10000,
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
          const isVideo = cleanU.includes('.mp4');
          mediaList.push({ type: isVideo ? 'video' : 'image', url: cleanU });
        }
      }
      if (mediaList.length > 0) {
        return { success: true, media: mediaList, title: 'Instagram Media', type: mediaList.length > 1 ? 'carousel' : mediaList[0].type };
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] IG Method 5 (SnapSave) failed:', err.message);
  }

  return { 
    success: false, 
    message: '❌ Gagal mengunduh postingan/foto dari Instagram. Pastikan akun/postingan bersifat publik dan link valid.' 
  };
}

/**
 * Download YouTube Videos / Shorts — Multi-Tier Failover
 */
export async function downloadYouTube(url) {
  // Method 1: yt-dlp CLI Video
  const ytdlpResult = await downloadWithYtdlp(url, false);
  if (ytdlpResult?.terlaluBesar) {
    return { success: false, message: ytdlpResult.message };
  }
  if (ytdlpResult?.buffer) {
    return { success: true, buffer: ytdlpResult.buffer, title: ytdlpResult.title || 'YouTube Video', mimetype: 'video/mp4' };
  }
  if (ytdlpResult?.videoUrl) {
    const buf = await fetchBuffer(ytdlpResult.videoUrl);
    return { success: true, buffer: buf || undefined, videoUrl: ytdlpResult.videoUrl, title: ytdlpResult.title || 'YouTube Video', mimetype: 'video/mp4' };
  }

  // Method 2: @distube/ytdl-core
  // Hanya format gabungan (punya video DAN audio) yang boleh dipakai. Cadangan lama
  // jatuh ke `quality: 'highest'` yang di YouTube modern hampir selalu video-only —
  // hasilnya video bisu, atau berkas yang tidak bisa dibuka sama sekali.
  try {
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
        mimetype: 'video/mp4'
      };
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] YT Method 2 (ytdl-core) failed:', err.message);
  }

  return {
    success: false,
    message: '❌ Gagal mengunduh video YouTube. Pastikan link publik dan dapat diakses.'
  };
}

/**
 * Download YouTube Audio / MP3 — Multi-Tier Failover
 */
export async function downloadYouTubeAudio(url) {
  // Method 1: yt-dlp CLI Audio
  const ytdlpResult = await downloadWithYtdlp(url, true);
  if (ytdlpResult?.terlaluBesar) {
    return { success: false, message: ytdlpResult.message };
  }
  if (ytdlpResult?.buffer) {
    return {
      success: true,
      buffer: ytdlpResult.buffer,
      title: ytdlpResult.title || 'YouTube Audio',
      mimetype: ytdlpResult.mimetype || 'audio/mpeg',
      ext: ytdlpResult.ext || 'mp3'
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
      ext: ytdlpResult.ext || 'm4a'
    };
  }

  // Method 2: @distube/ytdl-core Audio
  // Utamakan trek m4a/AAC. `highestaudio` biasanya mengembalikan Opus/WebM yang
  // tidak bisa diputar WhatsApp sebagai pesan suara.
  try {
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
        ext: isM4a ? 'm4a' : 'ogg'
      };
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] YT Audio Method 2 failed:', err.message);
  }

  return {
    success: false,
    message: '❌ Gagal mengunduh audio YouTube. Pastikan link publik dan dapat diakses.'
  };
}

/**
 * Download Facebook Video / Reels / Photos — Multi-Tier Failover
 */
export async function downloadFacebook(url) {
  // Method 1: yt-dlp dump-json
  try {
    const data = await extractWithYtdlpJson(url);
    if (data) {
      const title = data.title || data.description || 'Facebook Media';
      if (Array.isArray(data.entries) && data.entries.length > 0) {
        const mediaList = [];
        for (const e of data.entries) {
          const isVideo = e.ext === 'mp4' || (e.vcodec && e.vcodec !== 'none');
          const itemUrl = e.url || e.formats?.[e.formats.length - 1]?.url || e.thumbnails?.[e.thumbnails.length - 1]?.url;
          if (itemUrl) mediaList.push({ type: isVideo ? 'video' : 'image', url: itemUrl });
        }
        if (mediaList.length > 0) {
          return { success: true, media: mediaList, title, type: 'carousel' };
        }
      } else if (data.url || data.thumbnails?.length > 0) {
        const isVideo = data.ext === 'mp4' || (data.vcodec && data.vcodec !== 'none');
        const itemUrl = isVideo ? (data.url || data.formats?.[data.formats.length - 1]?.url) : (data.url || data.thumbnails?.[data.thumbnails.length - 1]?.url);
        if (itemUrl) {
          return {
            success: true,
            media: [{ type: isVideo ? 'video' : 'image', url: itemUrl }],
            type: isVideo ? 'video' : 'image',
            videoUrl: isVideo ? itemUrl : undefined,
            imageUrl: !isVideo ? itemUrl : undefined,
            title
          };
        }
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] FB Method 1 (yt-dlp JSON) failed:', err.message);
  }

  // Method 2: Direct Open Graph & HTML Photo / Video Metadata Scraper
  try {
    const headers = {
      'User-Agent': getRandomUserAgent(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,id;q=0.8'
    };
    const res = await axios.get(url, { headers, timeout: 12000, maxRedirects: 5 });
    if (res.data) {
      const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      const cleanU = (raw) => raw ? raw.replace(/\\/g, '').replace(/&amp;/g, '&') : null;

      // Cek Video
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
          type: 'video'
        };
      }

      // Cek Foto / Gambar Postingan
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
            type: 'image'
          };
        }
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] FB Method 2 (HTML Scraper) failed:', err.message);
  }

  // Method 3: Siputzx Facebook API (Foto & Video)
  try {
    const res = await axios.get(`https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(url)}`, {
      headers: { 'User-Agent': getRandomUserAgent() },
      timeout: 12000
    });
    if (res.data && res.data.data) {
      const d = res.data.data;
      const mediaUrl = d.video_hd || d.video_sd || d.url || (Array.isArray(d) ? d[0]?.url : d.image);
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
          type: isVideo ? 'video' : 'image'
        };
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] FB Method 3 (Siputzx) failed:', err.message);
  }

  // Method 4: @renpwn/fb-downloader library
  try {
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
        type: 'video'
      };
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] FB Method 4 (fbDownloader) failed:', err.message);
  }

  return { 
    success: false, 
    message: '❌ Gagal mengunduh foto/video dari Facebook. Pastikan postingan bersifat publik dan link valid.' 
  };
}

/**
 * Download Twitter / X Video & Media (Photos & Videos)
 */
export async function downloadTwitter(url) {
  // Method 1: yt-dlp CLI
  try {
    const data = await extractWithYtdlpJson(url);
    if (data) {
      const isVideo = data.ext === 'mp4' || (data.vcodec && data.vcodec !== 'none');
      const itemUrl = isVideo ? (data.url || data.formats?.[data.formats.length - 1]?.url) : (data.url || data.thumbnails?.[data.thumbnails.length - 1]?.url);
      if (itemUrl) {
        const buf = await fetchBuffer(itemUrl);
        return {
          success: true,
          media: [{ type: isVideo ? 'video' : 'image', url: itemUrl, buffer: buf || undefined }],
          buffer: buf || undefined,
          videoUrl: isVideo ? itemUrl : undefined,
          imageUrl: !isVideo ? itemUrl : undefined,
          title: data.title || data.description || 'Twitter / X Media',
          type: isVideo ? 'video' : 'image'
        };
      }
    }
  } catch (e) {}

  // Method 2: Third-party API fallback
  try {
    const apiRes = await axios.get(`https://api.siputzx.my.id/api/d/twitter?url=${encodeURIComponent(url)}`, { timeout: 15000 });
    if (apiRes.data && apiRes.data.status && apiRes.data.data) {
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
          type: isVideo ? 'video' : 'image'
        };
      }
    }
  } catch (apiErr) {
    console.log('[MEDIA_HANDLER] Twitter API fallback failed:', apiErr.message);
  }

  return {
    success: false,
    message: '❌ Gagal mengunduh media dari Twitter/X. Pastikan link publik dan tweet tidak dilindungi.'
  };
}

/**
 * Download Pinterest Photos & Videos
 */
export async function downloadPinterest(url) {
  // Method 1: yt-dlp
  try {
    const data = await extractWithYtdlpJson(url);
    if (data) {
      const isVideo = data.ext === 'mp4' || (data.vcodec && data.vcodec !== 'none');
      const itemUrl = isVideo ? (data.url || data.formats?.[data.formats.length - 1]?.url) : (data.url || data.thumbnails?.[data.thumbnails.length - 1]?.url);
      if (itemUrl) {
        const buf = await fetchBuffer(itemUrl);
        return {
          success: true,
          media: [{ type: isVideo ? 'video' : 'image', url: itemUrl, buffer: buf || undefined }],
          buffer: buf || undefined,
          videoUrl: isVideo ? itemUrl : undefined,
          imageUrl: !isVideo ? itemUrl : undefined,
          title: data.title || 'Pinterest Media',
          type: isVideo ? 'video' : 'image'
        };
      }
    }
  } catch (e) {}

  // Method 2: Siputzx Pinterest API
  try {
    const res = await axios.get(`https://api.siputzx.my.id/api/d/pinterest?url=${encodeURIComponent(url)}`, {
      headers: { 'User-Agent': getRandomUserAgent() },
      timeout: 10000
    });
    if (res.data && res.data.data) {
      const d = res.data.data;
      const mediaUrl = d.url || d.image || d.video || (Array.isArray(d) ? d[0] : null);
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
          type: isVideo ? 'video' : 'image'
        };
      }
    }
  } catch (e) {}

  // Method 3: Direct HTML Open Graph Scraper
  try {
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
            type: 'image'
          };
        }
      }
    }
  } catch (e) {}

  return { success: false, message: '❌ Gagal mengunduh foto/video dari Pinterest.' };
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
 * Konversi Gambar/Video Buffer ke Stiker WhatsApp (Statis / Animasi WebP)
 */
export async function createSticker(imageOrVideoBuffer, pack = 'Akbar Store Bot', author = 'Sales System', isVideo = false) {
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
      type: StickerTypes.CROPPED,
      quality: 70
    });

    const stickerBuffer = await sticker.toBuffer();
    return { success: true, buffer: stickerBuffer };
  } catch (err) {
    console.error('[MEDIA_HANDLER] Sticker Error:', err.message);
    try {
      const sticker = new Sticker(imageOrVideoBuffer, {
        pack: pack,
        author: author,
        type: StickerTypes.CROPPED,
        quality: 35
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
    const pngBuffer = await sharp(webpBuffer)
      .toFormat('jpg')
      .toBuffer();
    return { success: true, buffer: pngBuffer };
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
 * Buat Stiker Quote Chat WhatsApp (QC)
 */
export async function generateQuoteSticker(name, text) {
  try {
    const canvasWidth = 600;
    const canvasHeight = 600;
    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    ctx.font = '24px sans-serif';
    const maxTextWidth = 450;
    
    const words = (text || '').trim().split(/\s+/);
    const lines = [];
    let currentLine = '';
    for (const word of words) {
      const testLine = (currentLine + ' ' + word).trim();
      if (ctx.measureText(testLine).width <= maxTextWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
    if (lines.length === 0) lines.push(' ');

    const lineHeight = 34;
    const textWidths = lines.map(l => ctx.measureText(l).width);
    const nameWidth = ctx.measureText(name || 'Pelanggan').width;
    const bubbleWidth = Math.min(520, Math.max(280, nameWidth + 70, Math.max(...textWidths) + 60));
    const bubbleHeight = Math.min(520, Math.max(130, 75 + (lines.length * lineHeight)));

    const startX = 65;
    const startY = Math.floor((canvasHeight - bubbleHeight) / 2);

    ctx.save();
    ctx.fillStyle = '#00a884';
    ctx.beginPath();
    ctx.arc(startX - 30, startY + 35, 22, 0, Math.PI * 2);
    ctx.fill();

    const initial = ((name || 'P').charAt(0)).toUpperCase();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initial, startX - 30, startY + 35);
    ctx.restore();

    drawRoundedRect(ctx, startX, startY, bubbleWidth, bubbleHeight, 20, '#202c33');

    ctx.fillStyle = '#202c33';
    ctx.beginPath();
    ctx.moveTo(startX, startY + 20);
    ctx.lineTo(startX - 14, startY + 30);
    ctx.lineTo(startX, startY + 40);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#00a884';
    ctx.font = 'bold 25px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(name || 'Pelanggan', startX + 28, startY + 22);

    ctx.fillStyle = '#e9edef';
    ctx.font = '23px sans-serif';
    lines.forEach((line, index) => {
      ctx.fillText(line, startX + 28, startY + 65 + (index * lineHeight));
    });

    const rawPng = await canvas.encode('png');
    const trimmedBuffer = await sharp(rawPng).trim().toBuffer();
    return await createSticker(trimmedBuffer, 'Akbar Store Quote', name || 'Pelanggan', false);
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
 * Buat Stiker Brat Generator
 */
export async function generateBratSticker(text) {
  try {
    const canvasWidth = 512;
    const canvasHeight = 512;
    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const cleanText = (text || 'brat').toLowerCase().trim();
    
    let fontSize = 90;
    if (cleanText.length > 8) fontSize = 65;
    if (cleanText.length > 20) fontSize = 50;
    if (cleanText.length > 40) fontSize = 38;
    if (cleanText.length > 80) fontSize = 28;

    ctx.font = `${fontSize}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;

    const words = cleanText.split(/\s+/);
    const lines = [];
    let currentLine = '';
    const maxLineWidth = 440;

    for (const word of words) {
      const testLine = (currentLine + ' ' + word).trim();
      if (ctx.measureText(testLine).width <= maxLineWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
    if (lines.length === 0) lines.push('brat');

    const lineHeight = Math.floor(fontSize * 1.12);
    const totalHeight = lines.length * lineHeight;
    const startX = 35;
    const startY = lines.length === 1 ? Math.floor(fontSize * 1.1) : Math.floor((canvasHeight - totalHeight) / 2) + Math.floor(fontSize * 0.75);

    ctx.fillStyle = '#000000';
    ctx.textAlign = 'left';

    lines.forEach((line, i) => {
      ctx.fillText(line, startX, startY + (i * lineHeight));
    });

    const rawPng = await canvas.encode('png');

    const finalBuffer = await sharp(rawPng)
      .resize(150, 150, { kernel: 'nearest' })
      .blur(1.4)
      .resize(512, 512, { kernel: 'nearest' })
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
    '--extract-audio',
    '--audio-format', 'mp3',
    '--audio-quality', '2',
    '-o', outputTemplate,
    `ytsearch1:${query}`
  ];

  // Exit code diabaikan: yt-dlp bisa keluar bukan 0 walau MP3-nya sudah jadi.
  await runPythonProc(fileArgs, 180000);
  try {
    const files = fs.readdirSync(tmpDir);
    const matchedFile = files.find(f => f.startsWith(uniquePrefix) && f.endsWith('.mp3'));
    if (matchedFile) {
      const filePath = path.join(tmpDir, matchedFile);
      const buffer = fs.readFileSync(filePath);
      const title = matchedFile.substring(uniquePrefix.length, matchedFile.length - 4);
      bersihkanSisaUnduhan(tmpDir, uniquePrefix);
      if (buffer.length > 5000) {
        return { success: true, buffer, title, mimetype: 'audio/mpeg', ext: 'mp3' };
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
      }, { timeout: 12000 });

      if (apiRes.data && apiRes.data.status && apiRes.data.data) {
        const imgUrl = apiRes.data.data;
        const downloaded = await axios.get(imgUrl, { responseType: 'arraybuffer' });
        return { success: true, buffer: Buffer.from(downloaded.data), provider: 'AI Remini' };
      }
    } catch (e) {
      console.warn('[REMINI_API] Primary online API bypass to local sharp pipeline:', e.message);
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

    return { success: true, buffer: processedBuffer, provider: 'Sharp HD Engine' };
  } catch (err) {
    console.error('[ENHANCE_HD_ERR]', err.message);
    return { success: false, message: 'Gagal memproses peningkatan kualitas gambar: ' + err.message };
  }
}
