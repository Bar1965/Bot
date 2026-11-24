import { sendInteractiveButtons } from '../../bot.js';

export const cooldowns = new Map();

export function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

export function normalizeAnswer(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function scopeKey(jid, senderNumber, isFromGroup) {
  return isFromGroup ? jid : senderNumber;
}

export function isOnCooldown(key, duration = 3000) {
  const now = Date.now();
  const last = cooldowns.get(key) || 0;
  if (now - last < duration) return true;
  cooldowns.set(key, now);
  return false;
}

export async function send(sock, jid, messageObj, text, options = {}) {
  const mentions = Array.isArray(options) ? options : (options.mentions || []);
  if (options && (options.buttons || options.sections)) {
    return await sendInteractiveButtons(sock, jid, {
      text,
      title: options.title,
      footer: options.footer || 'Akbar Store Bot',
      buttons: options.buttons,
      sections: options.sections,
      // Tanpa ini setiap pesan bertombol kehilangan mention-nya: pemain yang
      // namanya ditulis @nomor (belum terdaftar) tidak pernah tertag.
      mentions
    });
  } else {
    return await sock.sendMessage(jid, { text, mentions: mentions.length > 0 ? mentions : undefined }, messageObj ? { quoted: messageObj } : undefined);
  }
}

// ─── PAPAN HIDUP (satu pesan yang diperbarui di tempat) ──────────────
//
// Masalah yang diselesaikan: hampir semua game giliran di repo ini mengirim
// DUA pesan setiap giliran — satu narasi aksi, satu papan penuh — sambil
// men-tag seluruh pemain di keduanya. Satu pertandingan Battleship bisa 40
// giliran; artinya 80 pesan panjang dan 80 dering di HP setiap orang. Game-nya
// jalan, tapi duduk di grupnya menyiksa.
//
// Polanya sudah terbukti di `umaDerby.js` lalu dirapikan di `uno/index.js`:
// kirim papan SEKALI, simpan `key`-nya, sesudah itu `edit: key`. Mengedit pesan
// tidak memicu notifikasi, jadi grup cuma berdering saat ada yang benar-benar
// perlu didengar (mulai, ronde selesai, pemenang).
//
// UNO memakai salinannya sendiri karena papannya terikat pada `sesi.riwayat`
// dan `mentionsManusia`; jangan disatukan paksa. Game lain memakai helper ini.

/** Sesudah sekian pembaruan, papan dikirim ulang supaya tidak terkubur obrolan. */
const JANGKAR_ULANG_TIAP = 12;

/**
 * Catat satu baris jejak aksi di sesi. Jejak inilah pengganti pesan narasi
 * per giliran: satu langkah = satu baris, bukan satu pesan.
 */
export function catatJejak(sesi, baris, maks = 3) {
  if (!sesi || !baris) return;
  sesi.jejak = [...(sesi.jejak || []), baris].slice(-maks);
}

export function renderJejak(sesi, judul = '') {
  const baris = sesi?.jejak || [];
  if (baris.length === 0) return '';
  return `${judul}\n${baris.map(r => `▸ ${r}`).join('\n')}`;
}

/**
 * Perbarui papan hidup milik `sesi`. `render()` mengembalikan teks papan.
 *
 * Menyimpan `sesi.papanKey` & `sesi.papanUmur`. Kalau WhatsApp menolak edit
 * (pesan lebih tua dari ~15 menit — normal di ronde yang pemainnya berpikir
 * lama), papan otomatis dikirim ulang sebagai pesan baru.
 *
 * `mentions` tetap dibawa di setiap edit: papan menulis pemain sebagai @tag,
 * dan tanpa daftar ini tagnya tampil sebagai deretan angka mentah. Ini tidak
 * menambah dering — hanya pesan baru yang memicu notifikasi.
 */
export async function perbaruiPapan(sock, jid, sesi, render, opsi = {}) {
  if (!sesi) return false;
  const teks = typeof render === 'function' ? render(sesi) : String(render || '');
  if (!teks) return false;
  const mentions = opsi.mentions || [];

  const kirimBaru = async () => {
    try {
      const msg = await send(sock, jid, null, teks, { mentions });
      sesi.papanKey = msg?.key || null;
      sesi.papanUmur = 0;
      return true;
    } catch (e) {
      console.error('[PAPAN_HIDUP_ERR]', e?.message || e);
      sesi.papanKey = null;
      return false;
    }
  };

  // Belum ada papan, sudah terlalu lama di atas, atau pemanggil minta pesan
  // baru (misalnya momen yang memang harus berdering).
  if (!sesi.papanKey || opsi.paksaBaru || (sesi.papanUmur || 0) >= JANGKAR_ULANG_TIAP) {
    return await kirimBaru();
  }

  try {
    await sock.sendMessage(jid, { text: teks, edit: sesi.papanKey, mentions });
    sesi.papanUmur = (sesi.papanUmur || 0) + 1;
    return true;
  } catch (e) {
    return await kirimBaru();
  }
}

/** Tutup papan supaya babak berikutnya mendapat papan barunya sendiri. */
export function lepasPapan(sesi) {
  if (!sesi) return;
  sesi.papanKey = null;
  sesi.papanUmur = 0;
  sesi.jejak = [];
}

export function generateStealChallenge() {
  const challengeTypes = ['math', 'reverse_pin', 'code_word', 'wire_cut'];
  const type = challengeTypes[Math.floor(Math.random() * challengeTypes.length)];

  if (type === 'math') {
    const a = Math.floor(Math.random() * 30) + 10;
    const b = Math.floor(Math.random() * 20) + 5;
    const c = Math.floor(Math.random() * 5) + 2;
    const answer = String((a + b) * c);
    return {
      type: 'math',
      title: '🔐 Kode PIN Matematika Brankas',
      instruction: `Hitung cepat kode PIN brankas:\n👉 *(${a} + ${b}) × ${c}* = ?`,
      answer: answer,
      hint: `Ketik angka hasil perhitungannya.`
    };
  }

  if (type === 'reverse_pin') {
    const pin = String(Math.floor(Math.random() * 90000) + 10000);
    const answer = pin.split('').reverse().join('');
    return {
      type: 'reverse_pin',
      title: '📡 Bypass Firewall CCTV (Reverse PIN)',
      instruction: `Ketik terbalik 5 digit kode keamanan ini:\n👉 *${pin}* (dari digit paling belakang ke depan)`,
      answer: answer,
      hint: `Contoh: 12345 menjadi 54321`
    };
  }

  if (type === 'code_word') {
    const words = [
      { clue: 'Ketik cepat kata sandi pembobolan', word: 'HACKER' },
      { clue: 'Ketik cepat kata sandi pembobolan', word: 'BRANKAS' },
      { clue: 'Ketik cepat kata sandi pembobolan', word: 'BURONAN' },
      { clue: 'Ketik cepat kata sandi pembobolan', word: 'RAHASIA' },
      { clue: 'Ketik cepat kata sandi pembobolan', word: 'DIAMOND' },
      { clue: 'Ketik cepat kata sandi pembobolan', word: 'MALING' },
      { clue: 'Ketik cepat kata sandi pembobolan', word: 'HEIST' },
      { clue: 'Ketik cepat kata sandi pembobolan', word: 'CYBER' }
    ];
    const picked = words[Math.floor(Math.random() * words.length)];
    return {
      type: 'code_word',
      title: '🎙️ Bypass Voice Recognition Alarm',
      instruction: `${picked.clue}:\n👉 *${picked.word}*`,
      answer: picked.word,
      hint: `Ketik kata persis sama.`
    };
  }

  const wires = [
    { color: 'MERAH', clue: 'Potong kabel yang sewarna dengan DARAH / API (Pilihan: MERAH / BIRU / HIJAU / KUNING)' },
    { color: 'BIRU', clue: 'Potong kabel yang sewarna dengan LAUT / LANGIT (Pilihan: MERAH / BIRU / HIJAU / KUNING)' },
    { color: 'HIJAU', clue: 'Potong kabel yang sewarna dengan DAUN / RUMPUT (Pilihan: MERAH / BIRU / HIJAU / KUNING)' },
    { color: 'KUNING', clue: 'Potong kabel yang sewarna dengan PISANG / MATAHARI (Pilihan: MERAH / BIRU / HIJAU / KUNING)' }
  ];
  const pickedWire = wires[Math.floor(Math.random() * wires.length)];
  return {
    type: 'wire_cut',
    title: '✂️ Nonaktifkan Sensor Laser Alarm',
    instruction: `Putuskan kabel yang tepat:\n👉 ${pickedWire.clue}`,
    answer: pickedWire.color,
    hint: `Ketik salah satu nama warna.`
  };
}
