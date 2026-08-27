/**
 * IDENTITAS BOT — SATU-SATUNYA CARA MENJAWAB "APAKAH INI BOT SENDIRI?"
 *
 * MASALAH YANG DIPERBAIKI BERKAS INI
 *
 * `.kick @bot` membuat bot mengeluarkan DIRINYA SENDIRI dari grup, padahal
 * penjaga anti-kick-diri-sendiri sudah ada di `groupAdminHandler.js`. Penjaga
 * itu berbunyi:
 *
 *     const botId = sock.user?.id?.split(':')[0];      // "628xxxxxxxxx"
 *     if (botId && targetJid.includes(botId)) tolak;
 *
 * Yang tidak dilihatnya: satu akun WhatsApp sekarang punya DUA identitas yang
 * angkanya sama sekali berbeda. Dibaca langsung dari sesi bot ini:
 *
 *     me.id  = 628xxxxxxxxx:NN@s.whatsapp.net   ← nomor HP
 *     me.lid = NNNNNNNNNNNNNN:NN@lid            ← angka lain, bukan nomornya
 *
 * Di grup ber-LID, men-tag bot menghasilkan `mentionedJid` berisi **@lid**.
 * Angka LID tidak memuat nomor HP di dalamnya, jadi `targetJid.includes(botId)`
 * bernilai false, penjaganya lewat, dan `groupParticipantsUpdate(..., 'remove')`
 * dijalankan atas JID bot sendiri. Bot punya hak admin, jadi permintaannya
 * berhasil — bot keluar dari grup.
 *
 * DUA ATURAN YANG DIPEGANG BERKAS INI
 *
 * 1. **Bandingkan SEMUA identitas bot, bukan satu.** `sock.user.id` dan
 *    `sock.user.lid` dua-duanya adalah bot. Kalau metadata grup tersedia,
 *    peserta yang cocok dengan salah satunya menyumbang identitas ketiga
 *    (`participant.jid`) — jaring pengaman untuk sesi lama yang `creds.me.lid`
 *    -nya belum terisi.
 *
 * 2. **Cocokkan PERSIS, jangan `includes()`.** Selain gagal lintas identitas,
 *    `includes` juga salah ke arah sebaliknya: nomor anggota lain yang kebetulan
 *    memuat digit nomor bot (`+62 812…` di dalam `+1 62812…`) ikut kebal di-kick.
 *    Satu baris, dua bug, dua arah.
 */

import { jidNormalizedUser } from '@whiskeysockets/baileys';

/**
 * Normalisasi aman: buang sufiks perangkat (`:12`), jangan pernah melempar.
 *
 * `jidNormalizedUser('628123456789')` mengembalikan STRING KOSONG untuk nomor
 * telanjang tanpa domain, bukan melempar. Tanpa jaring di bawah, nomor yang
 * diketik tanpa `@s.whatsapp.net` akan lolos dari penjaga ini tanpa suara.
 */
function rapikan(jid) {
  const s = String(jid || '').trim();
  if (!s) return '';
  let hasil = '';
  try {
    hasil = jidNormalizedUser(s) || '';
  } catch (e) {
    hasil = '';
  }
  if (hasil) return hasil;
  // Bukan JID utuh: pertahankan bentuk aslinya supaya perbandingan angka
  // di bawah tetap punya bahan.
  return s.toLowerCase();
}

/** Angka murni dari bagian pengguna sebuah JID. */
function angka(jid) {
  return String(jid || '').split('@')[0].replace(/[^0-9]/g, '');
}

/**
 * Semua identitas yang dimiliki bot: nomor HP dan @lid.
 * @returns {{jid:string[], angka:string[]}}
 */
export function identitasBot(sock) {
  const jid = [sock?.user?.id, sock?.user?.lid]
    .map(rapikan)
    .filter(Boolean);
  return {
    jid: [...new Set(jid)],
    // LID panjangnya belasan digit dan nomor HP paling pendek 8 — ambang 6
    // cukup untuk membuang sisa parsing yang tidak masuk akal.
    angka: [...new Set(jid.map(angka).filter(d => d.length >= 6))]
  };
}

/**
 * Apakah `targetJid` menunjuk ke bot itu sendiri?
 *
 * @param sock      soket Baileys (dibaca `user.id` dan `user.lid`)
 * @param targetJid JID yang mau diperiksa — boleh @s.whatsapp.net, @lid, atau
 *                  dengan sufiks perangkat
 * @param peserta   opsional, `groupMetadata.participants`. Dipakai sebagai
 *                  jaring pengaman kalau `sock.user.lid` kosong: peserta yang
 *                  cocok dengan salah satu identitas bot ikut menyumbangkan
 *                  `id`/`jid`/`lid`-nya sebagai identitas bot.
 */
export function adalahJidBot(sock, targetJid, peserta = null) {
  const target = rapikan(targetJid);
  if (!target) return false;

  const diri = identitasBot(sock);
  if (diri.jid.includes(target)) return true;

  const targetAngka = angka(target);
  if (targetAngka.length >= 6 && diri.angka.includes(targetAngka)) return true;

  if (!Array.isArray(peserta) || peserta.length === 0) return false;

  // Jaring pengaman lewat metadata grup. Baris peserta memuat @lid dan nomor HP
  // bersamaan — satu-satunya tempat keduanya pernah terlihat sekaligus.
  const barisBot = peserta.find(p => {
    const kandidat = [p?.id, p?.jid, p?.lid].map(rapikan).filter(Boolean);
    return kandidat.some(k => diri.jid.includes(k)) ||
           kandidat.some(k => { const d = angka(k); return d.length >= 6 && diri.angka.includes(d); });
  });
  if (!barisBot) return false;

  return [barisBot.id, barisBot.jid, barisBot.lid]
    .map(rapikan)
    .filter(Boolean)
    .some(k => k === target || (angka(k).length >= 6 && angka(k) === targetAngka));
}
