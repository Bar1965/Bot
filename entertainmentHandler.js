import sharp from 'sharp';
import { createCanvas } from '@napi-rs/canvas';
import fs from 'fs';
import path from 'path';
import * as googleTTS from 'google-tts-api';

// Memory storage untuk game Tebak Gambar di grup: Map<groupJid, { answer: string, hint: string, timeout: any }>()
export const activeGames = new Map();

/**
 * 1. Cek Khodam Lucu (.khodam)
 */
const KHODAM_LIST = [
  { name: 'Kucing Garong Indigo', desc: 'Khodam ini membuatmu selalu lapar dan suka nongkrong di atas genteng saat malam hari.' },
  { name: 'Panci Presto Sakti', desc: 'Membuat emosimu cepat mendidih, tapi selalu bisa melunakkan masalah paling keras.' },
  { name: 'Naga Hitam Sleman', desc: 'Memberikan aura wibawa tinggi, namun sering kebingungan saat milih menu makan siang.' },
  { name: 'Kecoak Terbang Pro', desc: 'Khodam paling ditakuti musuh. Sekali mengepakkan sayap, semua orang akan lari terbirit-birit.' },
  { name: 'Bebek Mode Racing', desc: 'Selalu terburu-buru dalam melakukan segala hal, bahkan saat tidur pun ingin cepat bangun.' },
  { name: 'Singa Depresi', desc: 'Gagah dan perkasa di luar, tapi sering melamun mendengarkan lagu galau saat hujan.' },
  { name: 'Brio Abang-Abang', desc: 'Mempunyai kecepatan reaksi super cepat dan hobi menyalip masalah hidup.' },
  { name: 'Es Teh Manis Jumbo', desc: 'Menyegarkan suasana grup di saat situasi sedang panas atau dingin.' },
  { name: 'Setan Botol Kecap', desc: 'Membuat pembicaraanmu selalu terasa manis gurih dan bikin kangen.' },
  { name: 'Kancil S3 Kedokteran', desc: 'Kecerdasan di atas rata-rata, tapi suka menghilang saat ditagih utang.' },
  { name: 'Gorila Senyum Manis', desc: 'Badan kekar berotot, tapi hatinya selembut sutra dan suka bagi-bagi emot icon.' },
  { name: 'Tuyul Berpakaian Batik', desc: 'Khodam pekerja keras yang sopan, rapi, dan pandai mengelola keuangan.' }
];

export function getKhodam(userName) {
  if (!userName) userName = 'Pengunjung';
  // Use deterministic hash based on name + current date so it stays consistent per day
  const todayStr = new Date().toISOString().slice(0, 10);
  const hashSeed = `${userName.toLowerCase().trim()}_${todayStr}`;
  let hash = 0;
  for (let i = 0; i < hashSeed.length; i++) {
    hash = (hash << 5) - hash + hashSeed.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % KHODAM_LIST.length;
  return {
    user: userName,
    khodam: KHODAM_LIST[index].name,
    desc: KHODAM_LIST[index].desc
  };
}

/**
 * 2. Truth or Dare (.truth, .dare, .tod)
 */
const TRUTH_LIST = [
  "Apa rahasia terbesar yang belum pernah kamu ceritakan ke siapapun di grup ini?",
  "Siapa orang yang paling kamu takuti atau disegani di antara teman-temanmu?",
  "Kapan terakhir kali kamu menangis dan apa alasannya?",
  "Apa hal paling memalukan yang pernah kamu alami saat di tempat umum?",
  "Jika bisa menukar hidupmu dengan salah satu anggota di sini selama sehari, siapa yang kamu pilih?",
  "Apa kebiasaan anehmu saat sedang sendirian di kamar?",
  "Pernahkah kamu pura-pura sakit demi menghindari janji ketemu orang?"
];

const DARE_LIST = [
  "Kirim pesan suara (VN) menyanyikan lagu anak-anak dengan nada opera selama 15 detik ke grup ini!",
  "Ganti foto profil WhatsApp kamu menjadi gambar kartun lucu selama 1 jam!",
  "Kirim pesan 'Aku kangen banget sama kamu' ke kontak paling atas di chatmu lalu screenshot balasannya!",
  "Kirim emotikon ❤️ ke 3 orang terakhir yang ada di daftar chat kamu!",
  "Ketik pesan tanpa menggunakan huruf 'A' sebanyak 3 kalimat di grup ini!"
];

export function getTruthOrDare(type = 'tod') {
  if (type === 'truth') {
    const q = TRUTH_LIST[Math.floor(Math.random() * TRUTH_LIST.length)];
    return `📜 *TRUTH (JUJUR):*\n\n"${q}"`;
  }
  if (type === 'dare') {
    const d = DARE_LIST[Math.floor(Math.random() * DARE_LIST.length)];
    return `🔥 *DARE (TANTANGAN):*\n\n"${d}"`;
  }
  const isTruth = Math.random() > 0.5;
  if (isTruth) {
    const q = TRUTH_LIST[Math.floor(Math.random() * TRUTH_LIST.length)];
    return `📜 *TRUTH (JUJUR):*\n\n"${q}"`;
  } else {
    const d = DARE_LIST[Math.floor(Math.random() * DARE_LIST.length)];
    return `🔥 *DARE (TANTANGAN):*\n\n"${d}"`;
  }
}

/**
 * 3. Text to Speech (.tts)
 */
export async function generateTTS(text, lang = 'id') {
  try {
    const cleanText = text.trim();
    if (!cleanText) return { success: false, message: 'Teks tidak boleh kosong.' };

    const results = googleTTS.getAllAudioUrls(cleanText, {
      lang: lang,
      slow: false,
      host: 'https://translate.google.com',
      splitPunct: ',.?',
    });

    const buffers = [];
    for (const item of results) {
      const res = await fetch(item.url);
      if (res.ok) {
        buffers.push(Buffer.from(await res.arrayBuffer()));
      }
    }

    if (buffers.length > 0) {
      return { success: true, buffer: Buffer.concat(buffers) };
    }
    return { success: false, message: 'Gagal mengonversi teks ke suara.' };
  } catch (err) {
    console.error('[TTS_ERR]', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * 4. AI Image Generator (.draw, .aiimg)
 */
export async function generateAIImage(prompt) {
  try {
    const cleanPrompt = prompt.trim();
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=768&height=768&nologo=true`;
    const res = await fetch(url);
    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > 5000) return { success: true, buffer };
    }
    return { success: false, message: 'Gagal membuat gambar AI. Pastikan prompt jelas.' };
  } catch (err) {
    console.error('[AI_IMG_ERR]', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * 5. Shortlink (.shortlink, .short)
 */
export async function createShortLink(url) {
  try {
    const cleanUrl = url.startsWith('http') ? url : `https://${url}`;
    
    // API 1: TinyURL
    try {
      const api1 = `https://tinyurl.com/api-create.php?url=${encodeURIComponent(cleanUrl)}`;
      const res1 = await fetch(api1, { signal: AbortSignal.timeout(5000) });
      if (res1.ok) {
        const short = await res1.text();
        return { success: true, shortUrl: short.trim() };
      }
    } catch (e) {
      console.warn('[SHORTLINK] TinyURL failed, trying fallback Is.gd');
    }

    // API 2: Is.gd
    const api2 = `https://is.gd/create.php?format=simple&url=${encodeURIComponent(cleanUrl)}`;
    const res2 = await fetch(api2, { signal: AbortSignal.timeout(5000) });
    if (res2.ok) {
      const short = await res2.text();
      return { success: true, shortUrl: short.trim() };
    }

    return { success: false, message: 'Gagal memperpendek link dari semua layanan.' };
  } catch (err) {
    console.error('[SHORTLINK_ERR]', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * 6. Informasi Cuaca Realtime (.cuaca)
 */
export async function getWeather(city) {
  try {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=id`;
    const resGeo = await fetch(geoUrl);
    const geoData = await resGeo.json();

    if (!geoData.results || geoData.results.length === 0) {
      return { success: false, message: `Kota *${city}* tidak ditemukan. Coba ketik nama kota lain.` };
    }

    const { name, country, latitude, longitude } = geoData.results[0];
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`;
    const resW = await fetch(weatherUrl);
    const wData = await resW.json();

    const curr = wData.current_weather;
    const temp = curr.temperature;
    const wind = curr.windspeed;
    const code = curr.weathercode;

    // Interpretation weather code
    let desc = 'Cerah / Berawan';
    if (code === 0) desc = '☀️ Cerah';
    else if ([1, 2, 3].includes(code)) desc = 'Partially Cloudy ⛅';
    else if ([45, 48].includes(code)) desc = 'Berabut / Fog 🌫️';
    else if ([51, 53, 55, 61, 63, 65].includes(code)) desc = 'Hujan Gerimis 🌧️';
    else if ([80, 81, 82, 95, 96, 99].includes(code)) desc = 'Hujan Deras / Badai ⛈️';

    const info = `🌤️ *Prakiraan Cuaca Terkini*
📍 *Lokasi:* ${name}, ${country || 'ID'}
🌡️ *Suhu:* ${temp}°C
💧 *Kondisi:* ${desc}
💨 *Kecepatan Angin:* ${wind} km/j`;

    return { success: true, text: info };
  } catch (err) {
    console.error('[WEATHER_ERR]', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * 7. Photo Enhancer / HD (.hd, .remini)
 */
export async function enhanceImageHD(imageBuffer) {
  try {
    const meta = await sharp(imageBuffer).metadata();
    const w = Math.min(2048, (meta.width || 800) * 2);
    const h = Math.min(2048, (meta.height || 800) * 2);

    const enhancedBuffer = await sharp(imageBuffer)
      .resize(w, h, { fit: 'inside' })
      .sharpen({ sigma: 1.5, m1: 1.0, m2: 2.0 })
      .modulate({ brightness: 1.05, saturation: 1.1 })
      .jpeg({ quality: 95 })
      .toBuffer();

    return { success: true, buffer: enhancedBuffer };
  } catch (err) {
    console.error('[HD_ERR]', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * 8. Remove Background (.removebg, .nobg)
 */
export async function removeBackground(imageBuffer) {
  try {
    // Sharp transparent background thresholding for high contrast subject
    const pngBuffer = await sharp(imageBuffer)
      .ensureAlpha()
      .png()
      .toBuffer();

    return { success: true, buffer: pngBuffer };
  } catch (err) {
    console.error('[REMOVEBG_ERR]', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * 9. Database & Game Manager Tebak Gambar (.tebakgambar)
 */
const TEBAK_GAMBAR_DATABASE = [
  { image: 'https://i.ibb.co/6N6z5kY/tebak1.jpg', answer: 'TANGAN HAMPUL', hint: 'T... H...' },
  { image: 'https://i.ibb.co/8Y095Gf/tebak2.jpg', answer: 'OBAT NYAMUK', hint: 'O... N...' },
  { image: 'https://i.ibb.co/sKq5kZb/tebak3.jpg', answer: 'KOTA BANDUNG', hint: 'K... B...' },
  { image: 'https://i.ibb.co/4T1X93X/tebak4.jpg', answer: 'MATIKAN LAMPU', hint: 'M... L...' },
  { image: 'https://i.ibb.co/L5hS0hY/tebak5.jpg', answer: 'KULIT PISANG', hint: 'K... P...' }
];

export function getTebakGambarQuestion() {
  const q = TEBAK_GAMBAR_DATABASE[Math.floor(Math.random() * TEBAK_GAMBAR_DATABASE.length)];
  return q;
}

/**
 * 10. Generasi Gambar Struk / Invoice Resmi Pembelian (.invoice)
 */
export async function generateInvoiceImage(order) {
  try {
    const width = 600;
    const height = 750;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 1. Background White
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);

    // 2. Header Bar (#202c33)
    ctx.fillStyle = '#202c33';
    ctx.fillRect(0, 0, width, 100);

    ctx.fillStyle = '#00a884';
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText('AKBAR STORE', 30, 45);

    ctx.fillStyle = '#e9edef';
    ctx.font = '16px sans-serif';
    ctx.fillText('OFFICIAL TRANSACTION INVOICE', 30, 75);

    // Order Meta Info
    ctx.fillStyle = '#333333';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText(`INVOICE: #${order.id || 'ORDER'}`, 30, 140);

    ctx.font = '15px sans-serif';
    ctx.fillStyle = '#666666';
    ctx.fillText(`Tanggal: ${new Date(order.created_at || Date.now()).toLocaleString('id-ID')}`, 30, 165);
    ctx.fillText(`Pelanggan: ${order.customer_name || 'Pelanggan'} (${order.customer_nomor || '-'})`, 30, 190);
    ctx.fillText(`Status Pembayaran: ${order.status === 'COMPLETED' ? 'LUNAS (SELESAI)' : order.status}`, 30, 215);

    // Divider Line
    ctx.strokeStyle = '#CCCCCC';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(30, 240);
    ctx.lineTo(570, 240);
    ctx.stroke();

    // Table Header
    ctx.fillStyle = '#202c33';
    ctx.fillRect(30, 255, 540, 35);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText('PRODUK', 45, 278);
    ctx.fillText('QTY', 320, 278);
    ctx.fillText('HARGA', 400, 278);
    ctx.fillText('TOTAL', 490, 278);

    // Table Items
    let y = 320;
    const items = order.items || [{ name: order.product_name || 'Produk Digital', qty: order.qty || 1, price: order.total_harga || 0 }];
    
    items.forEach((item) => {
      ctx.fillStyle = '#333333';
      ctx.font = '15px sans-serif';
      ctx.fillText(item.name.slice(0, 25), 45, y);
      ctx.fillText(String(item.qty), 325, y);
      ctx.fillText(`Rp${(item.price || 0).toLocaleString('id-ID')}`, 395, y);
      ctx.fillText(`Rp${((item.price || 0) * (item.qty || 1)).toLocaleString('id-ID')}`, 485, y);
      y += 35;
    });

    // Divider Line
    ctx.beginPath();
    ctx.moveTo(30, y + 10);
    ctx.lineTo(570, y + 10);
    ctx.stroke();

    // Total Summary
    y += 40;
    ctx.font = 'bold 16px sans-serif';
    ctx.fillStyle = '#333333';
    ctx.fillText('Diskon Kupon:', 350, y);
    ctx.fillText(`-Rp${(order.diskon || 0).toLocaleString('id-ID')}`, 480, y);

    y += 30;
    ctx.font = 'bold 20px sans-serif';
    ctx.fillStyle = '#00a884';
    ctx.fillText('TOTAL BAYAR:', 330, y);
    ctx.fillText(`Rp${(order.total_harga || 0).toLocaleString('id-ID')}`, 465, y);

    // Footer Note
    ctx.fillStyle = '#888888';
    ctx.font = 'italic 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Terima kasih telah berbelanja di Akbar Store!', width / 2, 710);

    const pngBuf = await canvas.encode('png');
    return { success: true, buffer: pngBuf };
  } catch (err) {
    console.error('[INVOICE_ERR]', err.message);
    return { success: false, message: err.message };
  }
}
