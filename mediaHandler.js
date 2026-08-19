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
 */
async function runPythonProc(args, timeout = 45000) {
  const runners = ['python', 'py', 'python3'];
  for (const runner of runners) {
    const result = await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let proc;
      try {
        proc = spawn(runner, args, { timeout });
      } catch (err) {
        resolve(null);
        return;
      }

      proc.stdout?.on('data', (d) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });

      proc.on('error', () => {
        resolve(null);
      });
    });

    if (result && result.code === 0) {
      return result;
    }
  }
  return null;
}

/**
 * Universal Fetch Buffer — Menghindari 403 Forbidden pada CDN WhatsApp
 */
export async function fetchBuffer(url) {
  if (!url) return null;
  try {
    const res = await axios.get(url, {
      httpsAgent,
      responseType: 'arraybuffer',
      timeout: 30000,
      maxRedirects: 10,
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
 * Download media via yt-dlp CLI — metode paling andal (disuntikkan FFmpeg location & format gabungan)
 */
async function downloadWithYtdlp(url) {
  const cookiesPath = path.join(process.cwd(), 'ig_cookies.txt');
  const hasCookies = fs.existsSync(cookiesPath);
  const tmpDir = path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `ytdlp_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`);

  const fileArgs = [
    '-m', 'yt_dlp',
    '--no-warnings',
    '--no-playlist',
    '--geo-bypass',
    '--ffmpeg-location', ffmpegInstaller.path,
    '--extractor-args', 'youtube:player_client=android,web',
    '-f', 'b/best[ext=mp4]/18/bestvideo[filesize<38M]+bestaudio/best',
    '--print', 'title',
    '-o', tmpFile,
    ...(hasCookies ? ['--cookies', cookiesPath] : []),
    url
  ];

  const procRes = await runPythonProc(fileArgs, 45000);
  if (procRes && fs.existsSync(tmpFile)) {
    const title = procRes.stdout.trim().split('\n')[0] || 'Media Video';
    const stats = fs.statSync(tmpFile);
    if (stats.size > 5000) {
      try {
        const buffer = fs.readFileSync(tmpFile);
        return { success: true, buffer, title };
      } catch (e) {
        console.error('[YTDLP_READ_ERR]', e.message);
      } finally {
        if (fs.existsSync(tmpFile)) {
          try { fs.unlinkSync(tmpFile); } catch {}
        }
      }
    }
    if (fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }

  // Tier 2 Fallback: Direct Stream URL
  const urlArgs = [
    '-m', 'yt_dlp',
    '--get-url',
    '--get-title',
    '--no-warnings',
    '--no-playlist',
    '--geo-bypass',
    '--ffmpeg-location', ffmpegInstaller.path,
    '-f', 'b/best[ext=mp4]/18/best',
    ...(hasCookies ? ['--cookies', cookiesPath] : []),
    url
  ];

  const procRes2 = await runPythonProc(urlArgs, 25000);
  if (procRes2 && procRes2.stdout.trim()) {
    const lines = procRes2.stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const urlLine = [...lines].reverse().find(l => l.startsWith('http'));
    const titleLine = lines.find(l => !l.startsWith('http'));
    if (urlLine) {
      const buf = await fetchBuffer(urlLine);
      return { success: true, buffer: buf || undefined, videoUrl: urlLine, title: titleLine || 'Media Video' };
    }
  }

  return null;
}

/**
 * Download TikTok Video tanpa watermark — Multi-Tier Failover (TikWM -> SSSTik -> Siputzx -> yt-dlp)
 */
export async function downloadTikTok(url) {
  // Method 1: TikWM API dengan penanganan Rate Limit (1 req/sec) & retry otomatis
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
          const streamUrl = res.data.data.play || res.data.data.wmplay;
          const title = res.data.data.title || 'TikTok Video';
          const author = res.data.data.author?.nickname || 'TikTok Creator';

          const buf = await fetchBuffer(streamUrl);
          return {
            success: true,
            buffer: buf || undefined,
            videoUrl: streamUrl,
            title,
            author
          };
        } else if (res.data.code === -1 && attempt === 1) {
          // Jeda 1.2 detik untuk melewati rate-limit 1 req/sec
          await new Promise(r => setTimeout(r, 1200));
          continue;
        }
      }
    } catch (err) {
      console.log(`[MEDIA_HANDLER] TikTok TikWM attempt ${attempt} failed:`, err.message);
    }
  }

  // Method 2: SSSTik API
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
        return { success: true, buffer: buf || undefined, videoUrl: streamUrl, title: 'TikTok Video' };
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] TikTok Method 2 (SSSTik) failed:', err.message);
  }

  // Method 3: Siputzx TikTok API
  try {
    const res = await axios.get(`https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(url)}`, {
      headers: { 'User-Agent': getRandomUserAgent() },
      timeout: 10000
    });
    if (res.data && res.data.data) {
      const streamUrl = res.data.data.urls?.[0] || res.data.data.video;
      if (streamUrl) {
        const buf = await fetchBuffer(streamUrl);
        return { success: true, buffer: buf || undefined, videoUrl: streamUrl, title: 'TikTok Video' };
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] TikTok Method 3 (Siputzx) failed:', err.message);
  }

  // Method 4: yt-dlp CLI fallback
  const ytdlpResult = await downloadWithYtdlp(url);
  if (ytdlpResult?.buffer || ytdlpResult?.videoUrl) {
    return { success: true, buffer: ytdlpResult.buffer, videoUrl: ytdlpResult.videoUrl, title: ytdlpResult.title || 'TikTok Video' };
  }

  return { success: false, message: '❌ Gagal mengunduh video TikTok. Pastikan link valid dan akun/video bersifat publik.' };
}

/**
 * Download Instagram Reels / Posts / Photos — Multi-Tier Failover
 */
export async function downloadInstagram(url) {
  // Method 1: yt-dlp CLI (Paling stabil & diupdate komunitas aktif)
  const ytdlpResult = await downloadWithYtdlp(url);
  if (ytdlpResult?.buffer || ytdlpResult?.videoUrl) {
    return { success: true, buffer: ytdlpResult.buffer, videoUrl: ytdlpResult.videoUrl, title: ytdlpResult.title || 'Instagram Media' };
  }

  // Method 2: SSSInstagram API
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
    const mediaUrl = res.data?.url || res.data?.data?.[0]?.url || res.data?.media?.[0]?.url;
    if (mediaUrl) {
      const buf = await fetchBuffer(mediaUrl);
      return { success: true, buffer: buf || undefined, videoUrl: mediaUrl, title: 'Instagram Media' };
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] IG Method 2 (SSSInstagram) failed:', err.message);
  }

  // Method 3: SnapSave API
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
    const urlMatches = raw.match(/https?:\\?\/\\?\/[^\s"'\\]+\.mp4[^\s"'\\]*/gi) || 
                       raw.match(/https?:\\?\/\\?\/[^\s"'\\]+cdninstagram[^\s"'\\]*/gi);
    if (urlMatches && urlMatches.length > 0) {
      const cleanUrl = urlMatches[0].replace(/\\+\//g, '/').replace(/\\u0026/g, '&');
      const buf = await fetchBuffer(cleanUrl);
      return { success: true, buffer: buf || undefined, videoUrl: cleanUrl, title: 'Instagram Media' };
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] IG Method 3 (SnapSave) failed:', err.message);
  }

  // Method 4: direct igdl package
  try {
    const fn = igdl.instagramGetUrl || igdl.default || igdl;
    const res = await fn(url);
    if (res && res.url_list && res.url_list.length > 0) {
      const mediaUrl = res.url_list[0];
      const buf = await fetchBuffer(mediaUrl);
      return { success: true, buffer: buf || undefined, videoUrl: mediaUrl, title: 'Instagram Media' };
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] IG Method 4 (igdl) failed:', err.message);
  }

  return { 
    success: false, 
    message: '❌ Gagal mengunduh dari Instagram. Pastikan postingan bersifat publik dan link valid.' 
  };
}

/**
 * Download YouTube Videos / Shorts — Multi-Tier Failover
 */
export async function downloadYouTube(url) {
  // Method 1: yt-dlp CLI
  const ytdlpResult = await downloadWithYtdlp(url);
  if (ytdlpResult?.buffer) {
    return { success: true, buffer: ytdlpResult.buffer, title: ytdlpResult.title || 'YouTube Video' };
  }
  if (ytdlpResult?.videoUrl) {
    const buf = await fetchBuffer(ytdlpResult.videoUrl);
    return { success: true, buffer: buf || undefined, videoUrl: ytdlpResult.videoUrl, title: ytdlpResult.title || 'YouTube Video' };
  }

  // Method 2: @distube/ytdl-core
  try {
    const info = await ytdl.getInfo(url);
    const format = ytdl.chooseFormat(info.formats, { quality: 'highestvideo', filter: 'videoandaudio' }) ||
                   ytdl.chooseFormat(info.formats, { quality: 'highest' });
    if (format && format.url) {
      const buf = await fetchBuffer(format.url);
      return { 
        success: true, 
        buffer: buf || undefined,
        videoUrl: format.url, 
        title: info.videoDetails?.title || 'YouTube Video' 
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
 * Download Facebook Video / Reels — Multi-Tier Failover
 */
export async function downloadFacebook(url) {
  // Method 1: yt-dlp CLI
  const ytdlpResult = await downloadWithYtdlp(url);
  if (ytdlpResult?.buffer) {
    return { success: true, buffer: ytdlpResult.buffer, title: ytdlpResult.title || 'Facebook Video' };
  }
  if (ytdlpResult?.videoUrl) {
    const buf = await fetchBuffer(ytdlpResult.videoUrl);
    return { success: true, buffer: buf || undefined, videoUrl: ytdlpResult.videoUrl, title: ytdlpResult.title || 'Facebook Video' };
  }

  // Method 2: @renpwn/fb-downloader library
  try {
    const fn = fbDownloader.default || fbDownloader;
    const res = await fn(url);
    const streamUrl = res?.hd || res?.sd || res?.url || res?.stream;
    if (streamUrl) {
      const buf = await fetchBuffer(streamUrl);
      return { 
        success: true, 
        buffer: buf || undefined,
        videoUrl: streamUrl, 
        title: res?.title || 'Facebook Video' 
      };
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] FB Method 2 failed:', err.message);
  }

  // Method 3: Direct Open Graph / HTML Metadata Scraper
  try {
    const headers = { 'User-Agent': getRandomUserAgent() };
    const res = await fetch(url, { headers });
    if (res.ok) {
      const html = await res.text();
      const cleanUrl = (raw) => raw ? raw.replace(/\\/g, '').replace(/&amp;/g, '&') : null;

      const hdMatch = html.match(/"playable_url_quality_hd"\s*:\s*"([^"]+)"/) || html.match(/hd_src\s*:\s*"([^"]+)"/);
      const sdMatch = html.match(/"playable_url"\s*:\s*"([^"]+)"/) || html.match(/sd_src\s*:\s*"([^"]+)"/);
      const ogMatch = html.match(/<meta\s+property="og:video"\s+content="([^"]+)"/) || html.match(/<meta\s+property="og:video:secure_url"\s+content="([^"]+)"/);

      const streamUrl = cleanUrl(hdMatch?.[1]) || cleanUrl(sdMatch?.[1]) || cleanUrl(ogMatch?.[1]);
      if (streamUrl) {
        const buf = await fetchBuffer(streamUrl);
        return { success: true, buffer: buf || undefined, videoUrl: streamUrl, title: 'Facebook Video' };
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] FB Method 3 failed:', err.message);
  }

  return { 
    success: false, 
    message: 'Gagal mengunduh video Facebook. Pastikan postingan publik & dapat diakses.' 
  };
}

/**
 * Universal Downloader Fallback
 */
export async function downloadUniversalMedia(url) {
  if (url.includes('instagram.com')) return await downloadInstagram(url);
  if (url.includes('youtube.com') || url.includes('youtu.be')) return await downloadYouTube(url);
  if (url.includes('facebook.com') || url.includes('fb.watch') || url.includes('fb.com')) return await downloadFacebook(url);
  if (url.includes('tiktok.com')) return await downloadTikTok(url);
  
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
    '--ffmpeg-location', ffmpegInstaller.path,
    '--extractor-args', 'youtube:player_client=android,web',
    '-f', 'ba[filesize<15M]/bestaudio/best',
    '--extract-audio',
    '--audio-format', 'mp3',
    '-o', outputTemplate,
    `ytsearch1:${query}`
  ];

  const procRes = await runPythonProc(fileArgs, 60000);
  if (procRes && procRes.code === 0) {
    try {
      const files = fs.readdirSync(tmpDir);
      const matchedFile = files.find(f => f.startsWith(uniquePrefix) && f.endsWith('.mp3'));
      if (matchedFile) {
        const filePath = path.join(tmpDir, matchedFile);
        const buffer = fs.readFileSync(filePath);
        fs.unlinkSync(filePath);
        
        const title = matchedFile.substring(uniquePrefix.length, matchedFile.length - 4);
        return { success: true, buffer, title };
      }
    } catch (e) {
      return { success: false, message: e.message };
    }
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
