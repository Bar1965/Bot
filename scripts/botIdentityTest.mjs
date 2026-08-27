/**
 * UJI PENJAGA IDENTITAS BOT & PERISAI SASARAN MODERASI
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
const { identitasTarget, putusanPerisai, perisaiTarget } = await import(REPO + 'src/utils/perisaiTarget.js');

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

// ============================================================
// PERISAI SASARAN: OWNER > ADMIN TOKO > ADMIN GRUP
// ============================================================

const OWNER_HP = '628111222333';
const ADMIN_HP = '628444555666';
const OWNER_LID = '155566677788899@lid';

const PESERTA_GRUP = [
  { id: OWNER_LID, jid: `${OWNER_HP}@s.whatsapp.net`, admin: 'admin' },
  { id: '177788899900011@lid', jid: `${ADMIN_HP}@s.whatsapp.net` },
  { id: '133344455566677@lid', jid: '628777888999@s.whatsapp.net' },
  { id: '628123123123@s.whatsapp.net' }
];

const ATURAN = { ownerNomor: OWNER_HP, ownerJid: '', adminNomor: [ADMIN_HP] };

console.log('\n════ 7. @LID TIDAK PERNAH DIANGGAP NOMOR HP ════');
{
  const dariHp = identitasTarget(`${OWNER_HP}@s.whatsapp.net`);
  benar('JID nomor HP -> nomor terbaca', dariHp.nomor, OWNER_HP);
  benar('JID nomor HP -> bukan lid', dariHp.lid, null);

  const dariLid = identitasTarget(OWNER_LID);
  benar('@lid sendirian -> nomor TIDAK ditebak', dariLid.nomor, null);
  benar('@lid sendirian -> lid terbaca', dariLid.lid, OWNER_LID);

  const dariMeta = identitasTarget(OWNER_LID, PESERTA_GRUP);
  benar('@lid + metadata grup -> nomor terbaca', dariMeta.nomor, OWNER_HP);

  // Inti aturannya: angka LID kebetulan bisa berakhiran sama dengan nomor HP
  // seseorang. `isPhoneMatch` memakai endsWith, jadi memperlakukan LID sebagai
  // nomor akan melindungi orang yang sama sekali salah.
  const lidJebakan = `99999${OWNER_HP}@lid`;
  const jebakan = identitasTarget(lidJebakan);
  benar('@lid berakhiran nomor Owner -> tetap bukan nomor', jebakan.nomor, null);
  benar('@lid jebakan tidak terlindungi',
    putusanPerisai({ identitas: jebakan, ...ATURAN }).dilindungi, false);
}

console.log('\n════ 8. TATA TINGKAT DITEGAKKAN ════');
{
  const owner = identitasTarget(OWNER_LID, PESERTA_GRUP);
  const admin = identitasTarget('177788899900011@lid', PESERTA_GRUP);
  const biasa = identitasTarget('133344455566677@lid', PESERTA_GRUP);

  benar('admin grup TIDAK bisa kick Owner',
    putusanPerisai({ identitas: owner, ...ATURAN, penyuruhOwner: false }).dilindungi, true);
  benar('alasannya disebut OWNER',
    putusanPerisai({ identitas: owner, ...ATURAN, penyuruhOwner: false }).alasan, 'OWNER');
  benar('Owner BISA kick Owner (dirinya sendiri)',
    putusanPerisai({ identitas: owner, ...ATURAN, penyuruhOwner: true }).dilindungi, false);

  benar('admin grup TIDAK bisa kick Admin Toko',
    putusanPerisai({ identitas: admin, ...ATURAN, penyuruhOwner: false }).dilindungi, true);
  benar('alasannya disebut ADMIN_TOKO',
    putusanPerisai({ identitas: admin, ...ATURAN, penyuruhOwner: false }).alasan, 'ADMIN_TOKO');
  benar('Owner BISA kick Admin Toko',
    putusanPerisai({ identitas: admin, ...ATURAN, penyuruhOwner: true }).dilindungi, false);

  // Kalau bagian ini gagal, perisainya mematikan gunanya `.kick`.
  benar('anggota biasa TETAP bisa di-kick',
    putusanPerisai({ identitas: biasa, ...ATURAN, penyuruhOwner: false }).dilindungi, false);
  benar('nomor tak dikenal TETAP bisa di-kick',
    putusanPerisai({ identitas: identitasTarget('628999000111@s.whatsapp.net'), ...ATURAN }).dilindungi, false);

  benar('Owner dikenali lewat ownerJid @lid tersimpan',
    putusanPerisai({
      identitas: identitasTarget(OWNER_LID),
      ownerNomor: '', ownerJid: OWNER_LID, adminNomor: []
    }).dilindungi, true);
  benar('Owner dikenali lewat peran di tabel customers',
    putusanPerisai({
      identitas: identitasTarget('199999999999999@lid'),
      ...ATURAN, peranDb: 'OWNER'
    }).alasan, 'OWNER');
  benar('Admin Toko dikenali lewat peran di tabel customers',
    putusanPerisai({
      identitas: identitasTarget('199999999999999@lid'),
      ...ATURAN, peranDb: 'ADMIN'
    }).alasan, 'ADMIN_TOKO');

  benar('nomor 08xxx dicocokkan dengan 628xxx',
    putusanPerisai({
      identitas: identitasTarget('628111222333@s.whatsapp.net'),
      ownerNomor: '08111222333', ownerJid: '', adminNomor: []
    }).dilindungi, true);
}

console.log('\n════ 9. SAAT RAGU, JANGAN MEMATIKAN MODERASI ════');
{
  const setelan = { ownerNumber: OWNER_HP, adminNumbers: ADMIN_HP, ownerJid: '' };

  const dbPalsu = {
    cariNomorDariLid: async (lid) => (lid === OWNER_LID ? OWNER_HP : null),
    getQuery: async () => null
  };
  const lewatPetaLid = await perisaiTarget({
    db: dbPalsu, targetJid: OWNER_LID, peserta: null, botSettings: setelan
  });
  benar('peta LID menutup celah saat metadata tanpa nomor',
    lewatPetaLid.dilindungi, true);

  const dbPeran = {
    cariNomorDariLid: async () => null,
    getQuery: async () => ({ role: 'ADMIN' })
  };
  const lewatPeran = await perisaiTarget({
    db: dbPeran, targetJid: '188888888888888@lid', peserta: null, botSettings: setelan
  });
  benar('peran customers menutup celah', lewatPeran.alasan, 'ADMIN_TOKO');

  const dbRusak = {
    cariNomorDariLid: async () => { throw new Error('db mati'); },
    getQuery: async () => { throw new Error('db mati'); }
  };
  const saatRusak = await perisaiTarget({
    db: dbRusak, targetJid: '188888888888888@lid', peserta: null, botSettings: setelan
  });
  benar('database mati tidak melempar', typeof saatRusak.dilindungi, 'boolean');
  benar('database mati tidak memblokir moderasi', saatRusak.dilindungi, false);

  const tanpaDb = await perisaiTarget({ targetJid: '188888888888888@lid', botSettings: setelan });
  benar('tanpa db pun tidak melempar', tanpaDb.dilindungi, false);

  const buram = await perisaiTarget({
    db: { cariNomorDariLid: async () => null, getQuery: async () => null },
    targetJid: '199999999999999@lid', peserta: PESERTA_GRUP, botSettings: setelan
  });
  benar('identitas tak dikenal tetap boleh di-kick', buram.dilindungi, false);
}

console.log('\n════ 10. PERISAI TERPASANG DI HANDLER ════');
{
  const isiHandler = sumber['src/handlers/groupAdminHandler.js'];
  benar('handler memanggil perisaiTarget', /perisaiTarget\(/.test(isiHandler), true);
  benar('perisai hanya untuk kick & demote',
    /\['kick', 'demote'\]\.includes\(cleanCmd\)/.test(isiHandler), true);
  benar('perisai dibungkus try/catch', /Perisai sasaran gagal/.test(isiHandler), true);
}



console.log('\n════════════════════════════════════════');
console.log(`Pemeriksaan : ${periksa}`);
console.log(`Gagal       : ${gagal.length}`);
for (const g of gagal) console.log(`  - ${g}`);
console.log('════════════════════════════════════════');
process.exit(gagal.length ? 1 : 0);
