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
