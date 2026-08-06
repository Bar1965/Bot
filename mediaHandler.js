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
import vm from 'vm';
import https from 'https';
import { execFile, spawn } from 'child_process';

const httpsAgent = new https.Agent({ rejectUnauthorized: false, family: 4 });

// Set FFMPEG Path global agar wa-sticker-formatter & ffmpeg menggunakan binary asli
process.env.FFMPEG_PATH = ffmpegInstaller.path;
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
process.env.YTDL_NO_UPDATE = 'true';

/**
 * Download media via yt-dlp CLI — method paling andal untuk Instagram (selalu diupdate komunitas)
 * Returns { videoUrl, title } or null on failure
 */
async function downloadWithYtdlp(url) {
  return new Promise((resolve) => {
    const cookiesPath = path.join(process.cwd(), 'ig_cookies.txt');
    const hasCookies = fs.existsSync(cookiesPath);
    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `ytdlp_${Date.now()}_${Math.floor(Math.random()*1000)}.mp4`);

    // Tier 1: Direct MP4 File Download via yt-dlp (Bypass 403 Forbidden on WhatsApp)
    const fileArgs = [
      '-m', 'yt_dlp',
      '--no-warnings',
      '--no-playlist',
      '--geo-bypass',
      '--extractor-args', 'youtube:player_client=android,web',
      '-f', 'b[filesize<48M]/bestvideo[filesize<38M]+bestaudio/b[ext=mp4]/best',
      '--print', 'title',
      '-o', tmpFile,
      ...(hasCookies ? ['--cookies', cookiesPath] : []),
      url
    ];

    let stdout = '';
    let stderr = '';
    const proc = spawn('python', fileArgs, { timeout: 45000 });

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      const title = stdout.trim().split('\n')[0] || 'Media Video';

      if (code === 0 && fs.existsSync(tmpFile)) {
        const stats = fs.statSync(tmpFile);
        if (stats.size > 5000) {
          try {
            const buffer = fs.readFileSync(tmpFile);
            fs.unlinkSync(tmpFile);
            resolve({ success: true, buffer, title });
            return;
          } catch (e) {}
        }
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      }

      // Tier 2 Fallback: Get Direct URL stream if direct file download failed
      console.log('[MEDIA_HANDLER] yt-dlp direct file download fallback to URL mode:', stderr.slice(0, 150));
      const urlArgs = [
        '-m', 'yt_dlp',
        '--get-url',
        '--get-title',
        '--no-warnings',
        '--no-playlist',
        '--geo-bypass',
        '-f', 'best[ext=mp4]/best',
        ...(hasCookies ? ['--cookies', cookiesPath] : []),
        url
      ];

      let stdout2 = '';
      const proc2 = spawn('python', urlArgs, { timeout: 20000 });
      proc2.stdout.on('data', (d) => { stdout2 += d.toString(); });
      proc2.on('close', (code2) => {
        if (code2 === 0 && stdout2.trim()) {
          const lines = stdout2.trim().split('\n').map(l => l.trim()).filter(Boolean);
          const urlLine = [...lines].reverse().find(l => l.startsWith('http'));
          const titleLine = lines.find(l => !l.startsWith('http'));
          if (urlLine) {
            resolve({ success: true, videoUrl: urlLine, title: titleLine || title });
            return;
          }
        }
        resolve(null);
      });
      proc2.on('error', () => resolve(null));
    });

    proc.on('error', (err) => {
      console.log('[MEDIA_HANDLER] yt-dlp spawn error:', err.message);
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      resolve(null);
    });
  });
}

/**
 * Download TikTok Video tanpa watermark via multi-tier API
 */
export async function downloadTikTok(url) {
  // Method 1: SSSTik API (Direct Watermark-free MP4)
  try {
    const res = await axios.post('https://ssstik.io/abc?url=dl', `id=${encodeURIComponent(url)}&locale=en&tt=1`, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Origin': 'https://ssstik.io',
        'Referer': 'https://ssstik.io/en'
      },
      timeout: 10000
    });
    if (res.data) {
      const match = res.data.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/i) || res.data.match(/href="(https:\/\/[^"]+tik-tok[^"]*)"/i);
      if (match) {
        return { success: true, videoUrl: match[1], title: 'TikTok Video' };
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] TikTok Method 1 (SSSTik) failed:', err.message);
  }

  // Method 2: TikWM API (no watermark)
  try {
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' }
    });
    if (res.ok) {
      const json = await res.json();
      if (json.code === 0 && json.data) {
        return {
          success: true,
          videoUrl: json.data.play || json.data.wmplay,
          title: json.data.title || 'TikTok Video',
          author: json.data.author?.nickname || 'TikTok Creator',
        };
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] TikTok Method 2 (TikWM) failed:', err.message);
  }

  // Method 3: yt-dlp CLI fallback
  const ytdlpResult = await downloadWithYtdlp(url);
  if (ytdlpResult?.buffer || ytdlpResult?.videoUrl) {
    return { success: true, buffer: ytdlpResult.buffer, videoUrl: ytdlpResult.videoUrl, title: ytdlpResult.title || 'TikTok Video' };
  }

  return { success: false, message: '❌ Gagal mengunduh video TikTok. Pastikan link valid dan akun tidak privat.' };
}


/**
 * Download Instagram Reels / Posts — 4 metode fallback aktif
 */
export async function downloadInstagram(url) {
  // Method 1: yt-dlp CLI — paling andal karena diupdate komunitas secara aktif mengikuti perubahan Instagram
  const ytdlpResult = await downloadWithYtdlp(url);
  if (ytdlpResult?.videoUrl) {
    return { success: true, videoUrl: ytdlpResult.videoUrl, title: ytdlpResult.title };
  }

  // Method 2: SSSInstagram API (200 OK)
  try {
    const res = await axios.post('https://sssinstagram.com/api/convert',
      JSON.stringify({ url }),
      {
        httpsAgent, timeout: 12000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://sssinstagram.com/',
          'Origin': 'https://sssinstagram.com'
        }
      }
    );
    const mediaUrl = res.data?.url || res.data?.data?.[0]?.url || res.data?.media?.[0]?.url;
    if (mediaUrl) {
      return { success: true, videoUrl: mediaUrl, title: 'Instagram Media' };
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] IG Method 2 (SSSInstagram) failed:', err.message);
  }

  // Method 3: SnapSave (200 OK)
  try {
    const res = await axios.post('https://snapsave.app/action.php', `url=${encodeURIComponent(url)}`, {
      httpsAgent,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': 'https://snapsave.app/',
        'Origin': 'https://snapsave.app'
      }
    });
    const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const urlMatches = raw.match(/https?:\\?\/\\?\/[^\s"'\\]+\.mp4[^\s"'\\]*/gi) || 
                       raw.match(/https?:\\?\/\\?\/[^\s"'\\]+cdninstagram[^\s"'\\]*/gi);
    if (urlMatches && urlMatches.length > 0) {
      const cleanUrl = urlMatches[0].replace(/\\+\//g, '/').replace(/\\u0026/g, '&');
      return { success: true, videoUrl: cleanUrl, title: 'Instagram Media' };
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] IG Method 3 (SnapSave) failed:', err.message);
  }

  // Method 4: Direct Embed Scraper
  try {
    const code = url.match(/(?:p|reel|reels|stories)\/([A-Za-z0-9_-]+)/)?.[1];
    if (code) {
      const embedUrl = `https://www.instagram.com/p/${code}/embed/captioned/`;
      const res = await axios.get(embedUrl, {
        httpsAgent, timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      const html = res.data;
      const videoMatch = html.match(/"video_url":"([^"]+)"/) || html.match(/src="([^"]+\.mp4[^"]*)"/);
      const imgMatch = html.match(/"display_url":"([^"]+)"/) || html.match(/class="EmbeddedMediaImage"\s+src="([^"]+)"/);

      if (videoMatch) {
        const cleanVideo = videoMatch[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
        return { success: true, videoUrl: cleanVideo, title: 'Instagram Video' };
      } else if (imgMatch) {
        const cleanImg = imgMatch[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
        return { success: true, videoUrl: cleanImg, title: 'Instagram Photo' };
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] IG Method 4 (Embed) failed:', err.message);
  }

  // Method 5: instagram-url-direct package
  try {
    const fn = igdl.instagramGetUrl || igdl.default || igdl;
    const res = await fn(url);
    if (res && res.url_list && res.url_list.length > 0) {
      return { success: true, videoUrl: res.url_list[0], title: 'Instagram Video' };
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] IG Method 5 (igdl) failed:', err.message);
  }

  return { 
    success: false, 
    message: '❌ Gagal mengunduh dari Instagram. Kemungkinan penyebab:\n• Akun atau postingan diprivat\n• Link sudah tidak valid\n• Instagram sedang melakukan pembatasan akses\n\nCoba lagi beberapa menit kemudian atau pastikan postingan bersifat publik.' 
  };
}


export async function fetchBuffer(url) {
  if (!url) return null;
  try {
    const res = await axios.get(url, {
      httpsAgent,
      responseType: 'arraybuffer',
      timeout: 25000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': '*/*'
      }
    });
    if (res.data) {
      const buf = Buffer.from(res.data);
      if (buf.length > 5000) return buf;
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] fetchBuffer error:', err.message);
  }
  return null;
}


/**
 * Download YouTube Shorts / Videos — metode fallback aktif
 */
export async function downloadYouTube(url) {
  // Method 1: yt-dlp CLI (Paling stabil & diupdate terus)
  const ytdlpResult = await downloadWithYtdlp(url);
  if (ytdlpResult?.buffer) {
    return { success: true, buffer: ytdlpResult.buffer, title: ytdlpResult.title || 'YouTube Video' };
  }
  if (ytdlpResult?.videoUrl) {
    const buf = await fetchBuffer(ytdlpResult.videoUrl);
    if (buf) {
      return { success: true, buffer: buf, title: ytdlpResult.title || 'YouTube Video' };
    }
    return { success: true, videoUrl: ytdlpResult.videoUrl, title: ytdlpResult.title || 'YouTube Video' };
  }

  // Method 2: @distube/ytdl-core (langsung dari YouTube CDN)
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
    message: '❌ Gagal mengunduh video YouTube. Pastikan link YouTube valid dan video dapat diakses publik.' 
  };
}


/**
 * Download Facebook Video / Reels — 3 metode fallback aktif
 */
export async function downloadFacebook(url) {
  // Method 1: yt-dlp CLI (Paling stabil)
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
    const videoUrl = res?.hd || res?.sd || res?.url || res?.stream;
    if (videoUrl) {
      const buf = await fetchBuffer(videoUrl);
      return { 
        success: true, 
        buffer: buf || undefined,
        videoUrl: videoUrl, 
        title: res?.title || 'Facebook Video' 
      };
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] FB Method 2 failed:', err.message);
  }

  // Method 3: Direct Open Graph / HTML Metadata Scraper
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    };
    const res = await fetch(url, { headers });
    if (res.ok) {
      const html = await res.text();
      const cleanUrl = (raw) => raw ? raw.replace(/\\/g, '').replace(/&amp;/g, '&') : null;

      const hdMatch = html.match(/"playable_url_quality_hd"\s*:\s*"([^"]+)"/) || html.match(/hd_src\s*:\s*"([^"]+)"/);
      const sdMatch = html.match(/"playable_url"\s*:\s*"([^"]+)"/) || html.match(/sd_src\s*:\s*"([^"]+)"/);
      const ogMatch = html.match(/<meta\s+property="og:video"\s+content="([^"]+)"/) || html.match(/<meta\s+property="og:video:secure_url"\s+content="([^"]+)"/);

      const videoUrl = cleanUrl(hdMatch?.[1]) || cleanUrl(sdMatch?.[1]) || cleanUrl(ogMatch?.[1]);
      if (videoUrl) {
        const buf = await fetchBuffer(videoUrl);
        return { success: true, buffer: buf || undefined, videoUrl, title: 'Facebook Video' };
      }
    }
  } catch (err) {
    console.log('[MEDIA_HANDLER] FB Method 3 failed:', err.message);
  }

  return { 
    success: false, 
    message: 'Gagal mengunduh video Facebook. Pastikan link publik & dapat diakses tanpa login.' 
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
      // Pembuatan Stiker Animasi via FFmpeg native + Exif metadata chunk langsung (Mencegah double encoding & file size > 500KB)
      const tmpDir = path.join(process.cwd(), 'tmp');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

      const inputPath = path.join(tmpDir, `in_${Date.now()}.mp4`);
      const outputPath = path.join(tmpDir, `out_${Date.now()}.webp`);

      fs.writeFileSync(inputPath, imageOrVideoBuffer);

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .inputOptions(['-t 5']) // Maksimal 5 detik standar WhatsApp
          .outputOptions([
            '-vcodec libwebp',
            '-vf scale=512:512:flags=lanczos:force_original_aspect_ratio=decrease,fps=12,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
            '-lossless 0',
            '-compression_level 6',
            '-q:v 50',
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

      // Bersihkan file sementara
      try {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      } catch (e) {}

      // Injeksikan Exif Metadata tanpa melakukan re-encode (Ukuran file tetap < 500KB, jernih & dapat diunduh di HP)
      const exif = new Exif({ pack, author });
      const finalBuffer = await exif.add(rawWebpBuffer);

      return { success: true, buffer: finalBuffer };
    }

    // Pembuatan Stiker Statis (Gambar)
    const sticker = new Sticker(imageOrVideoBuffer, {
      pack: pack,
      author: author,
      type: StickerTypes.FULL,
      quality: 85
    });

    const stickerBuffer = await sticker.toBuffer();
    return { success: true, buffer: stickerBuffer };
  } catch (err) {
    console.error('[MEDIA_HANDLER] Sticker Error:', err.message);
    try {
      const sticker = new Sticker(imageOrVideoBuffer, {
        pack: pack,
        author: author,
        type: StickerTypes.FULL,
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
 * Konversi Stiker WebP ke Gambar (JPG/PNG) menggunakan Sharp
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
 * Konversi Stiker WebP (Statis / Animasi) ke Video MP4 menggunakan FFmpeg
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
 * Helper pembagi baris teks (Multiline Wrapping)
 */
function wrapText(text, maxCharsPerLine = 30) {
  const words = (text || '').trim().split(/\s+/);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    if ((currentLine + ' ' + word).trim().length <= maxCharsPerLine) {
      currentLine = (currentLine + ' ' + word).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.length > 0 ? lines : [' '];
}

/**
 * Helper menggambar rounded rectangle di Canvas 2D
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
 * Buat Stiker Quote Chat WhatsApp (QC / Quote Sticker) via Skia 2D Canvas Engine
 */
/**
 * Buat Stiker Quote Chat WhatsApp (QC / Quote Sticker) via Skia 2D Canvas Engine
 */
export async function generateQuoteSticker(name, text) {
  try {
    const canvasWidth = 600;
    const canvasHeight = 600;
    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    // Font setup (Ukuran Besar & Jernih)
    ctx.font = '24px sans-serif';
    const maxTextWidth = 450;
    
    // Line wrapping calculation
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

    // 1. Draw Avatar Icon Circle
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

    // 2. Draw Chat Bubble Background (#202c33)
    drawRoundedRect(ctx, startX, startY, bubbleWidth, bubbleHeight, 20, '#202c33');

    // Draw Tail Triangle
    ctx.fillStyle = '#202c33';
    ctx.beginPath();
    ctx.moveTo(startX, startY + 20);
    ctx.lineTo(startX - 14, startY + 30);
    ctx.lineTo(startX, startY + 40);
    ctx.closePath();
    ctx.fill();

    // 3. Draw Sender Name (#00a884)
    ctx.fillStyle = '#00a884';
    ctx.font = 'bold 25px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(name || 'Pelanggan', startX + 28, startY + 22);

    // 4. Draw Message Text (#e9edef)
    ctx.fillStyle = '#e9edef';
    ctx.font = '23px sans-serif';
    lines.forEach((line, index) => {
      ctx.fillText(line, startX + 28, startY + 65 + (index * lineHeight));
    });

    const rawPng = await canvas.encode('png');

    // Pangkas margin transparan agar stiker memenuhi bingkai & berukuran besar di WA
    const trimmedBuffer = await sharp(rawPng).trim().toBuffer();

    return await createSticker(trimmedBuffer, 'Akbar Store Quote', name || 'Pelanggan', false);
  } catch (err) {
    console.error('[MEDIA_HANDLER] Quote Canvas Error:', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * Buat Gambar Meme dengan Teks Atas & Teks Bawah via Skia 2D Canvas Engine
 */
export async function generateMeme(imageBuffer, topText = '', bottomText = '') {
  try {
    const baseImage = await loadImage(imageBuffer);
    const width = baseImage.width;
    const height = baseImage.height;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Draw original image
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

  // Provider 1: Thum.io
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

  // Provider 2: s-shot.ru
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
 * Buat Stiker Brat Generator (Autentik Arial Narrow Regular & Low-Res Blur)
 */
export async function generateBratSticker(text) {
  try {
    const canvasWidth = 512;
    const canvasHeight = 512;
    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    // 1. Fill Solid White Background (#FFFFFF)
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // 2. Text Processing (lowercase, Arial Narrow Regular font style)
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

    // 3. Draw Black Text Left-Aligned (Regular Weight)
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'left';

    lines.forEach((line, i) => {
      ctx.fillText(line, startX, startY + (i * lineHeight));
    });

    const rawPng = await canvas.encode('png');

    // 4. Low-resolution upscale (150px -> 512px) with blur for authentic Brat low-res aesthetic
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
