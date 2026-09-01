/**
 * UJI IZIN MENTION MASSAL
 *
 * Mention massal adalah alat spam paling ampuh yang dimiliki bot ini: satu
 * perintah membunyikan notifikasi setiap orang di grup. Karena itu ia hanya
 * boleh dipegang Admin Grup, Admin Toko, atau Owner.
 *
 *     node scripts/tagallGuardTest.mjs
 *
 * Berkas ini lahir dari kebocoran sungguhan. `.tagall` dan `.hidetag` di
 * `groupAdminHandler.js` memang sudah dijaga sejak lama — tapi `.freegames tag`
 * di `src/games/index.js` melakukan hal yang sama persis TANPA satu pun
 * pemeriksaan izin, dan `.freegames` adalah perintah publik. Lebih buruk lagi,
 * pesan `.freegames` menempelkan tombol "📢 TagAll Group" sehingga siapa pun yang
 * melihatnya bisa memanggil seluruh grup dengan satu ketukan.
 *
 * Pelajarannya, dan alasan uji ini ada: menjaga SATU perintah tidak menjaga
 * KEMAMPUANNYA. Yang harus diuji adalah "apakah ada jalan bagi non-admin untuk
 * membuat bot me-mention banyak orang", bukan "apakah .tagall dijaga".
 *
 * Kalau nanti ada jalur mention massal baru, tambahkan ke DAFTAR_UJI di bawah.
 */

import path from 'path';
import { pathToFileURL } from 'url';

const REPO = pathToFileURL(path.resolve(process.cwd())).href + '/';
const { handleFunCommand } = await import(REPO + 'src/games/index.js');
const { createGroupAdminHandler } = await import(REPO + 'src/handlers/groupAdminHandler.js');
const { cooldowns } = await import(REPO + 'src/games/helpers.js');
const db = await import(REPO + 'database.js');
await db.initDb?.();

const GRUP = '120363000000000000@g.us';
const MEMBER = '628111111111@s.whatsapp.net';
const ADMIN = '628222222222@s.whatsapp.net';

const meta = {
  id: GRUP,
  subject: 'Grup Uji',
  participants: [
    { id: MEMBER, admin: null },
    { id: ADMIN, admin: 'admin' },
    { id: '628333333333@s.whatsapp.net', admin: null },
    { id: '628444444444@s.whatsapp.net', admin: null }
  ]
};

let kirim = [];
const sock = {
  user: { id: '628000000000@s.whatsapp.net' },
  sendMessage: async (_j, m) => { kirim.push({ teks: m.text, n: m.mentions?.length || 0 }); return {}; },
  groupMetadata: async () => meta
};

// Pemain terdaftar, supaya gerbang registrasi tidak menutupi penjaga izin yang
// sedang diuji. Kalau ia menutupi, ujinya akan "lulus" karena alasan yang salah
// dan tetap lulus di hari gerbang registrasi dilonggarkan.
try { await db.registerCustomer(MEMBER, 'Penguji'); } catch { /* sudah ada */ }

const handleGrup = createGroupAdminHandler({
  sock,
  botSettings: { ownerNumber: '628999999999', adminNumbers: '' },
  getCachedGroupMetadata: async () => meta,
  react: async () => {},
  sendInteractiveButtons: async () => {}
});

const pesan = (dari) => ({
  key: { remoteJid: GRUP, participant: dari, fromMe: false, id: 'X' + kirim.length + Math.random() },
  message: { conversation: '' },
  pushName: 'Penguji'
});

async function lewatGames(dari, args, cmd, isAdmin) {
  cooldowns.clear(); kirim = [];
  try {
    await handleFunCommand({
      sock, jid: GRUP, senderNumber: dari, messageObj: pesan(dari),
      text: '.' + args.join(' '), args, cleanCmd: cmd, isFromGroup: true,
      isAdmin, isOwner: false, isStoreAdmin: false, isPrefixCmd: true
    });
  } catch { /* fetch jaringan boleh gagal; yang diuji izinnya */ }
  return kirim;
}

async function lewatAdminHandler(dari, teks, isAdmin) {
  cooldowns.clear(); kirim = [];
  const cmd = teks.slice(1).split(' ')[0];
  await handleGrup(GRUP, dari, pesan(dari), teks, isAdmin, true, { isAdmin, isOwner: false, isStoreAdmin: false });
  return kirim;
}

// [label, cara menjalankan]
const DAFTAR_UJI = [
  ['.tagall',            (d, a) => lewatAdminHandler(d, '.tagall halo', a)],
  ['.hidetag',           (d, a) => lewatAdminHandler(d, '.hidetag halo', a)],
  ['.everyone',          (d, a) => lewatAdminHandler(d, '.everyone halo', a)],
  ['.all',               (d, a) => lewatAdminHandler(d, '.all halo', a)],
  ['.semua',             (d, a) => lewatAdminHandler(d, '.semua halo', a)],
  ['.freegames tag',     (d, a) => lewatGames(d, ['freegames', 'tag'], 'freegames', a)],
  ['.freegames tagall',  (d, a) => lewatGames(d, ['freegames', 'tagall'], 'freegames', a)],
  ['.freegamestag',      (d, a) => lewatGames(d, ['freegamestag'], 'freegamestag', a)]
];

const gagal = [];
console.log('════ MEMBER BIASA TIDAK BOLEH MENTION MASSAL ════\n');
for (const [label, jalankan] of DAFTAR_UJI) {
  const hasil = await jalankan(MEMBER, false);
  const massal = hasil.filter(x => x.n >= 2);
  const ok = massal.length === 0;
  if (!ok) gagal.push(`${label} — member biasa berhasil mention ${massal[0].n} orang`);
  console.log(`  ${ok ? '✅' : '🚨'} ${label.padEnd(20)} mention-massal: ${massal.length}`);
}

console.log('\n════ ADMIN GRUP HARUS TETAP BISA ════\n');
// Hanya jalur groupAdminHandler yang diperiksa di sini: jalur `.freegames`
// memanggil jaringan sungguhan, jadi kegagalannya tidak bisa dibedakan dari
// penolakan izin dan uji itu akan berkedip-kedip tanpa sebab.
for (const [label, jalankan] of DAFTAR_UJI.slice(0, 5)) {
  const hasil = await jalankan(ADMIN, true);
  const massal = hasil.filter(x => x.n >= 2);
  const ok = massal.length > 0;
  if (!ok) gagal.push(`${label} — ADMIN justru terblokir`);
  console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(20)} mention-massal: ${massal.length}`);
}

console.log('\n════════════════════════════════════════');
console.log(`Jalur diperiksa : ${DAFTAR_UJI.length}`);
console.log(`Gagal           : ${gagal.length}`);
if (gagal.length) { console.log('\nYANG GAGAL:'); for (const g of gagal) console.log('  🚨 ' + g); }
console.log('════════════════════════════════════════');
process.exit(gagal.length ? 1 : 0);
