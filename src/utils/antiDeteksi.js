/**
 * ANTI-DETEKSI & BEHAVIORAL EMULATION ENGINE
 * ==========================================
 * Modul ini menyediakan utilitas permanen untuk membuat lalu lintas bot
 * menyerupai perilaku manusia normal di WhatsApp Web:
 * 
 * 1. Zero-Width Text Entropy Injector (Anti-Hash Clustering)
 * 2. Gaussian Distribution Typing & Thinking Delays (WPM Model)
 * 3. Human Glancing/Reading Delays (Read-Receipt Pacing)
 * 4. WhatsApp Account Health Sentinel (Circuit Breaker Proteksi Akun)
 */

import * as crypto from 'crypto';

// Karakter tak kasat mata (Unicode Zero-Width)
const ZERO_WIDTH_CHARS = [
  '\u200B', // Zero-Width Space
  '\u200C', // Zero-Width Non-Joiner
  '\u200D', // Zero-Width Joiner
  '\uFEFF'  // Zero-Width No-Break Space
];

/**
 * Generator angka acak berbasis distribusi normal / Gaussian (Box-Muller Transform).
 * Manusia tidak bertindak dengan jeda acak datar (flat uniform), melainkan
 * membentuk kurva lonceng di sekitar rata-rata waktu respons alami.
 */
export function gaussianRandom(mean = 0, stdDev = 1) {
  let u1 = 0;
  let u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * stdDev;
}

/**
 * Menyisipkan karakter tak terlihat (Zero-Width) secara acak ke teks pesan.
 * 
 * Manfaat:
 * - Tampilan visual di layar WhatsApp pengguna 100% normal dan rapi.
 * - Nilai cryptographic hash (SHA-256 / MD5) dari setiap pesan SELALU UNIK.
 * - Menggagalkan algoritma deduplikasi Meta yang mendeteksi semburan pesan identik (.menu, .ping, struk, dll).
 */
export function injectTextEntropy(text) {
  if (typeof text !== 'string' || text.length === 0) return text;

  // Hasilkan kombinasi 2 hingga 4 karakter zero-width secara acak
  const entropyLength = 2 + Math.floor(Math.random() * 3);
  let entropyString = '';
  for (let i = 0; i < entropyLength; i++) {
    const idx = Math.floor(Math.random() * ZERO_WIDTH_CHARS.length);
    entropyString += ZERO_WIDTH_CHARS[idx];
  }

  // Sisipkan di ujung teks (atau sebelum whitespace akhir)
  return `${text.trimEnd()}${entropyString}`;
}

/**
 * Hitung jeda pengetikan (typing delay) proporsional dengan panjang karakter teks
 * menggunakan kurva Gaussian untuk meniru kecepatan ketik manusia (WPM model).
 * 
 * @param {number} charCount - Jumlah karakter pesan
 * @param {boolean} isAudio - Apakah pesan berupa voice note/audio
 * @returns {number} Durasi jeda dalam milidetik (ms)
 */
export function hitungJedaGaussian(charCount = 0, isAudio = false) {
  if (isAudio) {
    // Simulasi merekam audio suara: 1.0s - 2.2s
    const delay = Math.round(gaussianRandom(1400, 300));
    return Math.max(1000, Math.min(2200, delay));
  }

  // Base thinking time manusia yang responsif: ~320ms (stdDev 80ms)
  const thinkingTime = gaussianRandom(320, 80);

  // Waktu mengetik: ~5-8ms per karakter
  const typingSpeedPerChar = 5 + Math.random() * 3;
  const rawTypingTime = (charCount || 0) * typingSpeedPerChar;

  // Gaussian total dengan batasan wajar (clamp)
  const total = Math.round(thinkingTime + rawTypingTime);

  // Pesan pendek (<40 char): 400ms - 800ms
  // Pesan sedang (<150 char): 600ms - 1100ms
  // Pesan panjang (>=150 char): 900ms - 1600ms (maksimal 1.6 detik)
  if (charCount < 40) {
    return Math.max(400, Math.min(800, total));
  } else if (charCount < 150) {
    return Math.max(600, Math.min(1100, total));
  } else {
    return Math.max(900, Math.min(1600, total));
  }
}

/**
 * Jeda hening manusiawi sebelum menandai dibaca / mulai mengetik (80ms - 300ms).
 * Meniru waktu yang dibutuhkan mata manusia untuk melirik layar tanpa membuat bot terasa lambat.
 */
export function hitungJedaMelihat() {
  const delay = Math.round(gaussianRandom(180, 50));
  return Math.max(80, Math.min(300, delay));
}

/**
 * ====================================================================
 * WHATSAPP ACCOUNT HEALTH SENTINEL (CIRCUIT BREAKER)
 * ====================================================================
 * Memantau telemetri respons server WhatsApp. Jika terdeteksi sinyal
 * bahaya (error 403 Forbidden, 429 Rate Limit, atau drop beruntun),
 * Sentinel otomatis membekukan lalu lintas non-esensial selama 15 menit
 * untuk membiarkan akun "dingin" sebelum Meta menjatuhkan penangguhan.
 */
class WhatsAppHealthSentinel {
  constructor() {
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
    this.isCircuitTripped = false;
    this.tripReason = '';
    this.tripExpiry = 0;
    this.totalOutboundSent = 0;
    this.totalInboundReceived = 0;
    this.COOL_DOWN_MS = 15 * 60 * 1000; // 15 Menit isolasi darurat
    this.resetTimer = null;
    this.onReset = null;
  }

  recordInbound() {
    this.totalInboundReceived += 1;
  }

  recordOutboundSuccess() {
    this.totalOutboundSent += 1;
    this.consecutiveFailures = 0;
    if (this.isCircuitTripped && Date.now() > this.tripExpiry) {
      this.isCircuitTripped = false;
      this.tripReason = '';
      if (this.resetTimer) {
        clearTimeout(this.resetTimer);
        this.resetTimer = null;
      }
      console.log('[HEALTH_SENTINEL] 🟢 Akun pulih: Circuit Breaker dinonaktifkan kembali.');
    }
  }

  recordOutboundFailure(error) {
    const errorMsg = String(error?.message || error || '');
    const statusCode = error?.output?.statusCode || error?.statusCode || 0;
    this.consecutiveFailures += 1;
    this.lastFailureTime = Date.now();

    // Deteksi sinyal bahaya Meta
    const isForbidden = statusCode === 403 || errorMsg.includes('forbidden') || errorMsg.includes('Forbidden');
    const isRateLimited = statusCode === 429 || errorMsg.includes('rate-overlimit');

    if (isForbidden || isRateLimited || this.consecutiveFailures >= 4) {
      this.isCircuitTripped = true;
      this.tripReason = isForbidden ? 'HTTP 403 (Akses Ditolak Server WA)' : 
                         isRateLimited ? 'HTTP 429 (Batas Laju Server WA)' : 
                         `${this.consecutiveFailures}x Kegagalan Kirim Berturut-turut`;
      this.tripExpiry = Date.now() + this.COOL_DOWN_MS;

      console.warn(`\n🚨 [HEALTH_SENTINEL] PERINGATAN DARURAT: Circuit Breaker AKTIF!`);
      console.warn(`Alasan: ${this.tripReason}`);
      console.warn(`Lalu lintas outbound dibekukan sementara selama 15 menit demi mencegah pemblokiran akun.`);

      if (this.resetTimer) clearTimeout(this.resetTimer);
      this.resetTimer = setTimeout(() => {
        this.isCircuitTripped = false;
        this.consecutiveFailures = 0;
        this.tripReason = '';
        this.resetTimer = null;
        console.log('[HEALTH_SENTINEL] 🟢 Masa pendinginan 15 menit selesai. Sirkuit diaktifkan kembali.');
        if (typeof this.onReset === 'function') {
          try { this.onReset(); } catch (_) {}
        }
      }, this.COOL_DOWN_MS);
    }
  }

  isSendingSafe() {
    if (!this.isCircuitTripped) return true;
    if (Date.now() > this.tripExpiry) {
      // Masa hening selesai, izinkan satu percobaan probe
      return true;
    }
    return false;
  }

  getStatus() {
    return {
      safe: this.isSendingSafe(),
      isTripped: this.isCircuitTripped,
      reason: this.tripReason,
      remainingCooldownMs: Math.max(0, this.tripExpiry - Date.now()),
      outboundCount: this.totalOutboundSent,
      inboundCount: this.totalInboundReceived,
      ratio: this.totalInboundReceived > 0 
        ? (this.totalOutboundSent / this.totalInboundReceived).toFixed(2) 
        : 'N/A'
    };
  }
}

export const healthSentinel = new WhatsAppHealthSentinel();
