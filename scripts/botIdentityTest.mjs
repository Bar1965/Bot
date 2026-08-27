/**
 * UJI PENJAGA IDENTITAS BOT
 *
 * Menjaga satu bug spesifik supaya tidak pernah kembali: `.kick @bot` membuat
 * bot mengeluarkan dirinya sendiri dari grup.
 *
 * Penyebabnya bukan penjaga yang hilang — penjaganya ADA, tapi hanya
 * membandingkan nomor HP (`sock.user.id`). Satu akun WhatsApp punya dua
 * identitas dengan angka yang sama sekali berbeda, dan men-tag bot di grup
 * ber-LID menghasilkan @lid. Nomor HP tidak ada di dalam angka LID, jadi
 * penjaganya lewat dan `groupParticipantsUpdate(..., 'remove')` benar-benar
 * dijalankan atas bot sendiri.
 *
 * Pakai:
 *   node scripts/botIdentityTest.mjs
 *
 * Murni perhitungan — tidak menyentuh database, jaringan, atau sesi WhatsApp.
 */

import path from 'path';
import { pathToFileURL } from 'url';

const AKAR = path.resolve(import.meta.dirname, '..');
const REPO = pathToFileURL(AKAR).href + '/';

const { adalahJidBot, identitasBot } = await import(REPO + 'src/utils/botIdentity.js');

let periksa = 0;
const gagal = [];

function benar(label, hasil, harap) {
  periksa++;
  if (hasil === harap) {
    console.log(`  ✓ ${label.padEnd(48)} ${hasil}`);
  } else {
    gagal.push(`${label} — dapat ${hasil}, harap ${harap}`);
    console.log(`  ✗ ${label.padEnd(48)} ${hasil} (harap ${harap})`);
  }
}

// Bentuk yang sama dengan sesi sungguhan: dua identitas, angka berbeda total.
const SOCK = {
  user: {
    id: '628123456789:12@s.whatsapp.net',
    lid: '199887766554433:12@lid'
  }
};

console.log('\n════ 1. IDENTITAS TERBACA LENGKAP ════');
const diri = identitasBot(SOCK);
benar('nomor HP terdaftar', diri.jid.includes('628123456789@s.whatsapp.net'), true);
benar('@lid terdaftar', diri.jid.includes('199887766554433@lid'), true);
benar('dua identitas, bukan satu', diri.jid.length, 2);

console.log('\n════ 2. SEMUA BENTUK JID BOT DITOLAK ════');
for (const [label, jid] of [
  ['@lid bot (BUG YANG DILAPORKAN)', '199887766554433@lid'],
  ['@lid bot + sufiks perangkat', '199887766554433:5@lid'],
  ['nomor HP bot', '628123456789@s.whatsapp.net'],
  ['nomor HP bot + sufiks perangkat', '628123456789:12@s.whatsapp.net'],
  ['nomor HP bot tanpa domain', '628123456789'],
  ['nomor HP bot domain lama @c.us', '628123456789@c.us']
]) {
  benar(label, adalahJidBot(SOCK, jid), true);
}

console.log('\n════ 3. ORANG LAIN TETAP BISA DI-KICK ════');
// Kalau bagian ini gagal, penjaganya berubah jadi kebalikan bugnya: admin
// kehilangan kemampuan mengeluarkan anggota sungguhan.
for (const [label, jid] of [
  ['anggota biasa', '628999888777@s.whatsapp.net'],
  ['@lid anggota lain', '123456789012345@lid'],
  ['nomor yang MEMUAT digit bot', '1628123456789@s.whatsapp.net'],
  ['nomor berawalan digit bot', '628123456789111@s.whatsapp.net'],
  ['JID grup', '120363000000000000@g.us']
]) {
  benar(label, adalahJidBot(SOCK, jid), false);
}

console.log('\n════ 4. MASUKAN CACAT TIDAK MELEMPAR ════');
for (const [label, jid] of [
  ['string kosong', ''], ['null', null], ['undefined', undefined],
  ['sampah', 'abc'], ['hanya @', '@'], ['angka nol', 0]
]) {
  benar(label, adalahJidBot(SOCK, jid), false);
}
benar('sock kosong', adalahJidBot({}, '628123456789@s.whatsapp.net'), false);
benar('sock null', adalahJidBot(null, '628123456789@s.whatsapp.net'), false);

console.log('\n════ 5. JARING PENGAMAN METADATA GRUP ════');
// Sesi lama yang creds-nya belum memuat `me.lid`.
const SOCK_LAMA = { user: { id: '628123456789:12@s.whatsapp.net' } };
const PESERTA = [
  { id: '199887766554433@lid', jid: '628123456789@s.whatsapp.net', admin: 'admin' },
  { id: '123456789012345@lid', jid: '628999888777@s.whatsapp.net' },
  { id: '628777666555@s.whatsapp.net' }
];
benar('tanpa metadata, @lid bot tidak dikenali',
  adalahJidBot(SOCK_LAMA, '199887766554433@lid'), false);
benar('dengan metadata, @lid bot dikenali',
  adalahJidBot(SOCK_LAMA, '199887766554433@lid', PESERTA), true);
benar('metadata tidak membuat anggota lain kebal',
  adalahJidBot(SOCK_LAMA, '123456789012345@lid', PESERTA), false);
benar('metadata kosong tidak melempar',
  adalahJidBot(SOCK_LAMA, '199887766554433@lid', []), false);
benar('metadata cacat tidak melempar',
  adalahJidBot(SOCK_LAMA, '199887766554433@lid', [null, {}, { id: null }]), false);

console.log('\n════ 6. PENJAGA TERPASANG DI JALUR YANG BERBAHAYA ════');
// Pembacaan sumber, bukan simulasi: mengimpor bot.js sungguhan akan menyalakan
// koneksi WhatsApp dan server Express. Yang diperiksa di sini cuma bahwa setiap
// pemanggilan `groupParticipantsUpdate(..., 'remove')` benar-benar berada di
// berkas yang memakai penjaga ini.
const fs = await import('fs');
const sumber = {
  'bot.js': fs.readFileSync(path.join(AKAR, 'bot.js'), 'utf8'),
  'src/handlers/groupAdminHandler.js': fs.readFileSync(path.join(AKAR, 'src/handlers/groupAdminHandler.js'), 'utf8'),
  'src/games/index.js': fs.readFileSync(path.join(AKAR, 'src/games/index.js'), 'utf8')
};

for (const [berkas, isi] of Object.entries(sumber)) {
  const menghapusPeserta = /groupParticipantsUpdate\(/.test(isi);
  if (!menghapusPeserta) continue;
  benar(`${berkas} memakai penjaga identitas`, /adalahJidBot\(/.test(isi), true);
}

benar('tidak ada lagi perbandingan includes(botId)',
  !Object.values(sumber).some(isi => /targetJid\.includes\(botId\)/.test(isi)), true);

const jumlahHapus = Object.values(sumber)
  .join('\n')
  .match(/groupParticipantsUpdate\([^)]*["']remove["']/g)?.length || 0;
benar('jumlah jalur pengeluaran peserta yang diketahui', jumlahHapus, 3);

console.log('\n════════════════════════════════════════');
console.log(`Pemeriksaan : ${periksa}`);
console.log(`Gagal       : ${gagal.length}`);
for (const g of gagal) console.log(`  - ${g}`);
console.log('════════════════════════════════════════');
process.exit(gagal.length ? 1 : 0);
