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
const GAME_IMAGE_DIRECTORY = path.join(process.cwd(), 'public', 'game-images');
const GAME_IMAGE_HINTS = {
  anjing: 'Hewan peliharaan yang suka menggonggong.',
  apel: 'Buah yang sering berwarna merah atau hijau.',
  air: 'Sesuatu yang mengalir dan menyegarkan.',
  burung: 'Hewan yang umumnya memiliki sayap.',
  buah: 'Makanan segar yang tumbuh dari tanaman.',
  bunga: 'Tanaman yang biasanya memiliki warna dan aroma menarik.',
  bus: 'Kendaraan umum yang membawa banyak orang.',
  cokelat: 'Makanan manis berwarna cokelat.',
  danau: 'Perairan luas yang dikelilingi daratan.',
  es: 'Makanan atau minuman dingin.',
  gitar: 'Alat musik berdawai.',
  gereja: 'Bangunan tempat ibadah.',
  gunung: 'Daratan tinggi yang menjulang.',
  jam: 'Benda untuk melihat waktu.',
  jembatan: 'Bangunan untuk menghubungkan dua tempat.',
  kamera: 'Dipakai untuk mengambil foto.',
  kapal: 'Kendaraan yang berjalan di atas air.',
  kastil: 'Bangunan besar yang sering dikaitkan dengan kerajaan.',
  kereta: 'Kendaraan yang berjalan di atas rel.',
  kucing: 'Hewan peliharaan yang suka mengeong.',
  kuda: 'Hewan yang sering dipakai untuk ditunggangi.',
  kue: 'Makanan manis yang sering hadir saat perayaan.',
  kuil: 'Bangunan tempat ibadah atau sejarah.',
  komputer: 'Perangkat elektronik untuk mengolah data.',
  kopi: 'Minuman yang sering dinikmati saat pagi.',
  mobil: 'Kendaraan roda empat.',
  motor: 'Kendaraan roda dua dengan mesin.',
  nasi: 'Makanan pokok yang berasal dari beras.',
  pantai: 'Tempat dengan pasir dan laut.',
  pesawat: 'Kendaraan yang terbang di udara.',
  pisang: 'Buah berwarna kuning yang mudah dikupas.',
  pizza: 'Makanan bundar dengan topping.',
  radio: 'Perangkat untuk mendengarkan siaran suara.',
  roti: 'Makanan yang dibuat dari tepung dan dipanggang.',
  sapi: 'Hewan ternak yang menghasilkan susu.',
  sayur: 'Bahan makanan yang sering dimasak.',
  sepeda: 'Kendaraan yang dikayuh.',
  sungai: 'Aliran air yang bergerak menuju tempat lebih rendah.',
  telepon: 'Alat untuk berkomunikasi jarak jauh.',
  truk: 'Kendaraan besar untuk mengangkut barang.',
  waterfall: 'Aliran air yang jatuh dari tempat tinggi.'
};

const BASE_TEBAK_GAMBAR_DATABASE = [];

function loadLocalGameImages() {
  try {
    return fs.readdirSync(path.join(GAME_IMAGE_DIRECTORY, 'rebus'))
      .filter(file => /\.(jpe?g|png)$/i.test(file))
      .map(file => {
        const slug = file.replace(/\.(jpe?g|png)$/i, '').replace(/-\d+$/, '');
        const answer = slug.replace(/-/g, ' ').toUpperCase();
        const hintKey = slug.split('-')[0];
        return {
          image: path.join(GAME_IMAGE_DIRECTORY, 'rebus', file),
          answer,
          hint: GAME_IMAGE_HINTS[slug] || GAME_IMAGE_HINTS[hintKey] || 'Amati gambar baik-baik.'
        };
      });
  } catch (error) {
    console.error('[TEBAK_GAMBAR_ASSETS_ERR]', error.message);
    return [];
  }
}

const TEBAK_GAMBAR_DATABASE = [...BASE_TEBAK_GAMBAR_DATABASE, ...loadLocalGameImages()];

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

/**
 * 7. Peringatan Free Games (Semua Platform: Steam, Epic Games, GOG, Ubisoft, dll)
 */
export async function fetchFreeGames() {
  try {
    const axios = (await import('axios')).default;
    const res = await axios.get('https://www.gamerpower.com/api/giveaways?platform=pc', {
      timeout: 10000
    });

    if (!res.data || !Array.isArray(res.data) || res.data.length === 0) {
      return { success: false, message: 'Saat ini belum ada promo game PC gratis 100% yang aktif.' };
    }

    // Ambil maksimal 8 game gratis teratas dari semua platform
    const activeGamesList = res.data.slice(0, 8);

    let msg = `🎮 *DAFTAR GAME PC GRATIS 100% (ALL PLATFORMS)* 🎁\n`;
    msg += `_Klaim sekarang & simpan selamanya di akun kamu!_\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    activeGamesList.forEach((game, i) => {
      const platformIcon = game.platforms?.includes('Steam') ? '🎮' :
                           game.platforms?.includes('Epic') ? '🎁' :
                           game.platforms?.includes('GOG') ? '🕹️' : '⚔️';
      
      const worthStr = game.worth && game.worth !== 'N/A' ? `~${game.worth}~ ➡️ *GRATIS (Rp0)*` : '*GRATIS (Rp0)*';
      const endDateStr = game.end_date && game.end_date !== 'N/A' ? game.end_date.split(' ')[0] : 'Selama persediaan ada';

      msg += `${i + 1}. ${platformIcon} *${game.title}*\n`;
      msg += `   💰 Harga Asli: ${worthStr}\n`;
      msg += `   🕹️ Platform: *${game.platforms || 'PC'}*\n`;
      msg += `   ⏳ Batas Klaim: *${endDateStr}*\n`;
      msg += `   🔗 *Klaim:* ${game.open_giveaway_url || game.gamerpower_url}\n\n`;
    });

    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 _Tips: Buka link di atas, login ke akun Steam/Epic/GOG kamu, lalu tekan 'Add to Account' / 'Get'._`;

    return { success: true, text: msg, games: activeGamesList };
  } catch (err) {
    console.error('[FREE_GAMES_ERR]', err.message);
    return { success: false, message: 'Gagal mengambil info Free Games dari GamerPower API.' };
  }
}

/**
 * 8. Game Slot Machine (.slot)
 */
export function playSlotMachine(bet = 10) {
  const symbols = ['🎰', '7️⃣', '💎', '🔔', '🍋', '🍒', '⭐'];

  // Weighted random spin
  const s1 = symbols[Math.floor(Math.random() * symbols.length)];
  const s2 = symbols[Math.floor(Math.random() * symbols.length)];
  const s3 = symbols[Math.floor(Math.random() * symbols.length)];

  let multiplier = 0;
  let winType = 'RUNGKAD';

  if (s1 === '💎' && s2 === '💎' && s3 === '💎') {
    multiplier = 10;
    winType = '💎 SUPER DIAMOND JACKPOT! (10x)';
  } else if (s1 === '7️⃣' && s2 === '7️⃣' && s3 === '7️⃣') {
    multiplier = 7;
    winType = '7️⃣ LUCKY SEVEN JACKPOT! (7x)';
  } else if (s1 === '🎰' && s2 === '🎰' && s3 === '🎰') {
    multiplier = 5;
    winType = '🎰 CASINO SLOT JACKPOT! (5x)';
  } else if (s1 === s2 && s2 === s3) {
    multiplier = 3;
    winType = '🎉 TRIPLE MATCH! (3x)';
  } else if (s1 === s2 || s2 === s3 || s1 === s3) {
    multiplier = 1.5;
    winType = '✨ DOUBLE MATCH! (1.5x)';
  }

  const winAmount = Math.floor(bet * multiplier);

  return {
    reels: [s1, s2, s3],
    multiplier,
    winType,
    winAmount,
    isWin: multiplier > 0
  };
}

/**
 * 9. Ramalan Zodiak Harian (.zodiak)
 */
const ZODIAK_DATA = {
  aries: { icon: '♈', name: 'Aries (21 Mar - 19 Apr)', ramalan: 'Energi positifmu melimpah hari ini. Waktu yang tepat untuk memulai project baru!', asmara: 'Ada pesan manis dari seseorang yang tak terduga.', keuangan: 'Stabil, namun hindari belanja impulsif.', angka: '7, 14, 21' },
  taurus: { icon: '♉', name: 'Taurus (20 Apr - 20 Mei)', ramalan: 'Kekuatanmu ada pada kesabaran. Tetap fokus pada tujuan jangka panjang.', asmara: 'Pasangan butuh lebih banyak perhatian dan waktu luangmu.', keuangan: 'Rezeki tidak terduga akan datang di akhir minggu.', angka: '5, 18, 33' },
  gemini: { icon: '♊', name: 'Gemini (21 Mei - 20 Jun)', ramalan: 'Komunikasimu sangat persuasif hari ini. Manfaatkan untuk bernegosiasi.', asmara: 'Coba lebih jujur dengan perasaanmu sendiri.', keuangan: 'Pengeluaran untuk hobi sedikit meningkat.', angka: '3, 12, 29' },
  cancer: { icon: '♋', name: 'Cancer (21 Jun - 22 Jul)', ramalan: 'Intuisi hatimu sangat tajam. Dengarkan kata hatimu saat mengambil keputusan.', asmara: 'Suasana romantis menyelimuti harimu.', keuangan: 'Ada peluang investasi menarik.', angka: '2, 11, 24' },
  leo: { icon: '♌', name: 'Leo (23 Jul - 22 Ags)', ramalan: 'Karisma kepemimpinanmu terpancar kuat. Semua orang mengagumi idemu.', asmara: 'Waktunya mengambil langkah berani.', keuangan: 'Bonus atau komisi menantimu.', angka: '1, 9, 19' },
  virgo: { icon: '♍', name: 'Virgo (23 Ags - 22 Sep)', ramalan: 'Ketelitianmu menyelamatkan tim dari kesalahan besar.', asmara: 'Hindari terlalu kritis pada hal-hal kecil.', keuangan: 'Tabunganmu berkembang dengan baik.', angka: '4, 16, 28' },
  libra: { icon: '♎', name: 'Libra (23 Sep - 22 Okt)', ramalan: 'Keseimbangan hidupmu kembali terjaga. Pikiran terasa tenang.', asmara: 'Hubungan asmara semakin harmonis.', keuangan: 'Arus kas lancar jaya.', angka: '6, 15, 27' },
  scorpio: { icon: '♏', name: 'Scorpio (23 Okt - 21 Nov)', ramalan: 'Semangat pantang menyerahmu membuahkan hasil nyata.', asmara: 'Daya tarikmu sangat kuat hari ini.', keuangan: 'Hindari meminjamkan uang tanpa jaminan.', angka: '8, 13, 30' },
  sagittarius: { icon: '♐', name: 'Sagittarius (22 Nov - 21 Des)', ramalan: 'Petualangan baru sudah di depan mata. Siapkan energimu!', asmara: 'Siap-siap berkenalan dengan orang baru.', keuangan: 'Keuangan aman terkendali.', angka: '10, 22, 35' },
  capricorn: { icon: '♑', name: 'Capricorn (22 Des - 19 Jan)', ramalan: 'Kerja kerasmu diakui oleh atasan / klien.', asmara: 'Luangkan waktu untuk dinner santai.', keuangan: 'Peningkatan pendapatan terasa nyata.', angka: '17, 25, 31' },
  aquarius: { icon: '♒', name: 'Aquarius (20 Jan - 18 Feb)', ramalan: 'Ide-ide kreatifmu menginspirasi banyak orang di sekitarmu.', asmara: 'Teman lama bisa jadi cinta baru.', keuangan: 'Ada pemasukan dari sumber sekunder.', angka: '11, 23, 34' },
  pisces: { icon: '♓', name: 'Pisces (19 Feb - 20 Mar)', ramalan: 'Empatimu membuat suasana hati orang lain kembali hangat.', asmara: 'Momen manis bersama doi siap diukir.', keuangan: 'Bijaklah dalam membagi anggaran harian.', angka: '3, 18, 26' }
};

export function getZodiakInfo(zodiakInput) {
  if (!zodiakInput) return null;
  const key = zodiakInput.toLowerCase().trim();
  const zData = ZODIAK_DATA[key];
  if (!zData) return null;

  let msg = `✨ *RAMALAN ZODIAK ${zData.icon}* ✨\n`;
  msg += `*${zData.name}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `🌟 *Ramalan Hari Ini:*\n${zData.ramalan}\n\n`;
  msg += `💖 *Asmara:*\n${zData.asmara}\n\n`;
  msg += `💰 *Keuangan:*\n${zData.keuangan}\n\n`;
  msg += `🎯 *Angka Keberuntungan:* ${zData.angka}`;

  return msg;
}

/**
 * 10. Calculator Kecocokan Jodoh (.jodoh)
 */
export function getJodohInfo(name1, name2) {
  if (!name1 || !name2) return null;

  const pair = `${name1.toLowerCase().trim()}_${name2.toLowerCase().trim()}`;
  let hash = 0;
  for (let i = 0; i < pair.length; i++) {
    hash = (hash << 5) - hash + pair.charCodeAt(i);
    hash |= 0;
  }

  const percentage = (Math.abs(hash) % 71) + 30; // 30% - 100%

  let status = '';
  let desc = '';

  if (percentage >= 90) {
    status = '💖 JODOH SEJATI (SOULMATE 99%)';
    desc = 'Pasangan idaman! Kalian saling melengkapi dan punya chemistry yang sangat kuat. Hubungan ini berpotensi awet sampai kakek nenek!';
  } else if (percentage >= 75) {
    status = '💞 COCOK BANGET!';
    desc = 'Tingkat keserasian kalian sangat tinggi. Ada sedikit perbedaan sifat tapi justru itu yang bikin hubungan kalian berwarna!';
  } else if (percentage >= 60) {
    status = '💗 CUKUP HARMONIS';
    desc = 'Kalian berdua bisa saling memahami. Asalkan saling komunikasi dengan jujur, hubungan akan tetap langgeng.';
  } else if (percentage >= 45) {
    status = '💛 BUTUH PERJUANGAN';
    desc = 'Tingkat kecocokan sedang. Kadang sering beda pendapat, tapi kalau sama-sama mau mengalah bisa jadi pasangan seru!';
  } else {
    status = '💔 HUBUNGAN COMPLICATED';
    desc = 'Banyak tantangan dan drama! Tapi tenang, ujian adalah bumbu cinta. Tetap sabar dan saling mengerti ya!';
  }

  let msg = `💘 *TES KECOCOKAN JODOH* 💘\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `👨 *${name1}*  ❤️  👩 *${name2}*\n\n`;
  msg += `📊 *Tingkat Kecocokan:* *${percentage}%*\n`;
  msg += `🏷️ *Status:* *${status}*\n\n`;
  msg += `💬 *Analisis Ramalan:*\n"${desc}"`;

  return msg;
}

/**
 * 11. Voice Changer VN Audio Effects (.torebot, .tochipmunk, .todeep, .toecho)
 */
export async function convertVoiceEffect(audioBuffer, effectType = 'torebot') {
  try {
    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const inputPath = path.join(tmpDir, `voice_in_${Date.now()}.mp3`);
    const outputPath = path.join(tmpDir, `voice_out_${Date.now()}.mp3`);

    fs.writeFileSync(inputPath, audioBuffer);

    let afFilter = 'asetrate=44100*1.2,atempo=0.85'; // Default

    if (effectType === 'torebot' || effectType === 'robot') {
      afFilter = 'asetrate=44100*0.8,atempo=1.25,flanger=delay=2:depth=5';
    } else if (effectType === 'tochipmunk' || effectType === 'tupai') {
      afFilter = 'asetrate=44100*1.5,atempo=0.75';
    } else if (effectType === 'todeep' || effectType === 'berat') {
      afFilter = 'asetrate=44100*0.7,atempo=1.43';
    } else if (effectType === 'toecho' || effectType === 'gema') {
      afFilter = 'aecho=0.8:0.88:60:0.4';
    }

    const ffmpeg = (await import('fluent-ffmpeg')).default;
    const ffmpegInstaller = (await import('@ffmpeg-installer/ffmpeg')).default;
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioFilters(afFilter)
        .toFormat('mp3')
        .on('end', resolve)
        .on('error', reject)
        .save(outputPath);
    });

    const outBuf = fs.readFileSync(outputPath);

    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch (e) {}

    return { success: true, buffer: outBuf };
  } catch (err) {
    console.error('[VOICE_EFFECT_ERR]', err.message);
    return { success: false, message: err.message };
  }
}

