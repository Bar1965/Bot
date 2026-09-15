/**
 * AUDIT MENU — perintah yang ada vs perintah yang diumumkan
 *
 * `.menu` disusun dari commandRegistry.js, dan daftar itu ditulis tangan.
 * Setiap perintah baru yang lupa didaftarkan akan hidup di kode tapi TIDAK
 * PERNAH dilihat siapa pun — dan setiap perintah yang dihapus tapi masih
 * tertulis di menu membuat pelanggan mengetik sesuatu yang dijawab dengan diam.
 *
 * Uji ini membandingkan dua sisi:
 *
 *   A. Perintah yang benar-benar ditangani handler (dibaca dari kodenya).
 *   B. Perintah yang diumumkan commandRegistry.js.
 *
 * Yang dilaporkan:
 *   • DIJANJIKAN TAPI TIDAK ADA — menu menyebutnya, tidak ada yang menangani.
 *     Ini yang paling merugikan: pelanggan menurut pada menu, lalu didiamkan.
 *   • ADA TAPI TIDAK DIUMUMKAN — hidup di kode, tidak ada yang tahu.
 *
 * Perintah internal (jawaban wizard, alias admin darurat) boleh sengaja tidak
 * masuk menu; daftar pengecualiannya ada di bawah dan harus beralasan.
 *
 * Pakai:
 *   node scripts/auditMenuTest.mjs
 *
 * Membaca berkas saja — tidak menyentuh database, jaringan, atau sesi WhatsApp.
 */
import fs from 'fs';
import path from 'path';

const AKAR = path.resolve(import.meta.dirname, '..');

const HANDLER = [
  'src/handlers/customerHandler.js',
  'src/handlers/groupAdminHandler.js',
  'src/handlers/saldoAdmin.js',
  'src/games/index.js',
  'funHandler.js',
  'mediaHandler.js',
  'premiumHandler.js',
  'entertainmentHandler.js',
  // Dua berkas ini sempat terlewat, dan akibatnya audit melaporkan .pdfmerge,
  // .img2pdf, .tovid, .getpp dan kawan-kawan sebagai perintah hantu padahal
  // semuanya ditangani di sini. Kalau menambah handler baru ke rantai router
  // di bot.js, tambahkan juga ke daftar ini.
  'src/handlers/pdfHandler.js',
  'src/commands/mediaRouter.js'
];

/**
 * Perintah yang SENGAJA tidak diumumkan di `.menu`, beserta alasannya.
 * Menambah baris ke sini harus disertai alasan yang masuk akal — daftar ini
 * gampang jadi tempat sembunyi untuk perintah yang sebenarnya cuma terlupa.
 */
const SENGAJA_TERSEMBUNYI = {
  eval: 'menjalankan kode apa pun di komputer owner',
  exec: 'menjalankan perintah shell di komputer owner',
  getjid: 'alat bantu setup, bukan fitur',
  saldook: 'kode konfirmasi internal, selalu disebut di pesan yang memintanya',
  setownerid: 'alat bantu setup sekali pakai',
  setowner: 'alat bantu setup sekali pakai',
  testupdate: 'alat uji internal',
  owner: 'selalu tersedia, disebut di banyak tempat lain'
};

let lulus = 0;
let gagal = 0;
function cek(nama, kondisi, detail = '') {
  if (kondisi) { lulus++; console.log(`  OK    ${nama}`); }
  else { gagal++; console.log(`  GAGAL ${nama}${detail !== '' ? ' -> ' + detail : ''}`); }
}

console.log('\n╔══════════════════════════════════════════════════════╗');
console.log('║  AUDIT MENU — yang ada vs yang diumumkan             ║');
console.log('╚══════════════════════════════════════════════════════╝');

// ── A. Perintah yang ditangani handler ──────────────────────────────────────
//
// Dua pola yang dipakai di seluruh repo ini:
//   ['a','b'].includes(cleanCmd)      dan      cleanCmd === 'a'
// Ditambah regex perintah seperti /^(?:notify|notif|hubungi)\s+/.
function perintahDariKode(isi) {
  const set = new Set();

  for (const m of isi.matchAll(/\[([^\[\]]{0,900}?)\]\s*\.includes\(\s*(?:clean)?[Cc](?:md|ommand|leanCmd|leanText|leanTextLower)/g)) {
    for (const s of m[1].matchAll(/'([a-z0-9_]{2,24})'/gi)) set.add(s[1].toLowerCase());
  }
  for (const m of isi.matchAll(/(?:cleanCmd|cleanTextLower|command|cmd)\s*===\s*'([a-z0-9_]{2,24})'/gi)) {
    set.add(m[1].toLowerCase());
  }
  for (const m of isi.matchAll(/\/\^\[?\\?\.?[\/#\\.\]]*\]?\?\?\(\?:([a-z0-9|_]{2,120})\)/gi)) {
    for (const kata of m[1].split('|')) if (kata.length >= 2) set.add(kata.toLowerCase());
  }
  for (const m of isi.matchAll(/\/\^\(\?:([a-z0-9|_]{2,120})\)\\s/gi)) {
    for (const kata of m[1].split('|')) if (kata.length >= 2) set.add(kata.toLowerCase());
  }
  return set;
}

const adaDiKode = new Map();
for (const rel of HANDLER) {
  const p = path.join(AKAR, rel);
  if (!fs.existsSync(p)) continue;
  for (const c of perintahDariKode(fs.readFileSync(p, 'utf8'))) {
    if (!adaDiKode.has(c)) adaDiKode.set(c, rel);
  }
}

// ── B. Perintah yang diumumkan commandRegistry ──────────────────────────────
const reg = fs.readFileSync(path.join(AKAR, 'commandRegistry.js'), 'utf8');

const diMenu = new Set();
// Entri menu berbentuk ['.perintah / .alias <arg>', 'deskripsi'] dan juga
// daftar `inGame: ['.a', '.b']`, plus aliases kategori.
for (const m of reg.matchAll(/'([^']*?)'\s*,\s*'[^']*'\s*\]/g)) {
  for (const t of m[1].matchAll(/\.([a-z0-9_]{2,24})/gi)) diMenu.add(t[1].toLowerCase());
}
for (const m of reg.matchAll(/inGame:\s*\[([\s\S]{0,700}?)\]/g)) {
  for (const t of m[1].matchAll(/\.([a-z0-9_]{2,24})/gi)) diMenu.add(t[1].toLowerCase());
}
// aliases: SENGAJA tidak dihitung sebagai perintah yang dijanjikan. Isinya
// adalah argumen untuk `.menu <kategori>` (`.menu shop`, `.menu game`),
// bukan perintah yang berdiri sendiri — menghitungnya membuat audit ini
// melaporkan .shop, .store, .transaksi dan kawan-kawan sebagai perintah hantu
// padahal memang tidak pernah dimaksudkan ada.
const aliasKategori = new Set();
for (const m of reg.matchAll(/aliases:\s*\[([^\]]{0,300})\]/g)) {
  for (const t of m[1].matchAll(/'([a-z0-9_]{2,24})'/gi)) aliasKategori.add(t[1].toLowerCase());
}

console.log(`\nPerintah terdeteksi di handler : ${adaDiKode.size}`);
console.log(`Perintah diumumkan di menu     : ${diMenu.size}`);

// ── 1. Menu menjanjikan sesuatu yang tidak ada ──────────────────────────────
console.log('\n== 1. Dijanjikan menu tapi tidak ada yang menangani ==');

// Perintah yang ditangani di tempat lain (bot.js, plugin, route) tidak terbaca
// pemindai ini. Yang dilaporkan hanya yang benar-benar tidak ketemu di mana pun.
const semuaSumber = HANDLER.map(r => path.join(AKAR, r))
  .filter(p => fs.existsSync(p))
  .map(p => fs.readFileSync(p, 'utf8'))
  .join('\n') + fs.readFileSync(path.join(AKAR, 'bot.js'), 'utf8');

const hantu = [];
for (const c of diMenu) {
  if (adaDiKode.has(c)) continue;
  // Pemeriksaan kedua sengaja LONGGAR. Repo ini memakai banyak pola
  // pengiriman perintah: includes(), ===, regex literal, tabel plugin.
  // Pemindai di atas hanya mengenali dua yang pertama, jadi tanpa jaring ini
  // audit melaporkan .simpan, .ytmp3, .pdfmerge dan belasan lainnya sebagai
  // hantu padahal semuanya jalan. Alat yang berteriak palsu akan diabaikan
  // orang, dan temuan aslinya ikut tenggelam.
  if (new RegExp(`\\b${c}\\b`, 'i').test(semuaSumber)) continue;
  hantu.push(c);
}
hantu.sort();
if (hantu.length === 0) console.log('  OK    tidak ada perintah hantu di menu');
else for (const c of hantu) console.log(`  GAGAL .${c} diumumkan di menu tapi tidak ditemukan di kode`);
cek('menu tidak menjanjikan perintah yang tidak ada', hantu.length === 0, hantu.join(', '));

// ── 2. Ada di kode tapi tidak diumumkan ─────────────────────────────────────
console.log('\n== 2. Ada di kode tapi tidak diumumkan di menu ==');

const tersembunyi = [];
for (const [c, asal] of adaDiKode) {
  if (diMenu.has(c)) continue;
  if (SENGAJA_TERSEMBUNYI[c]) continue;
  tersembunyi.push([c, asal]);
}
tersembunyi.sort((a, b) => a[0].localeCompare(b[0]));

if (tersembunyi.length === 0) {
  console.log('  (tidak ada)');
} else {
  const perBerkas = new Map();
  for (const [c, asal] of tersembunyi) {
    if (!perBerkas.has(asal)) perBerkas.set(asal, []);
    perBerkas.get(asal).push(c);
  }
  for (const [asal, daftar] of perBerkas) {
    console.log(`\n  ${asal}  (${daftar.length})`);
    console.log(`    ${daftar.map(c => '.' + c).join('  ')}`);
  }
}

// ── 3. Perintah TOKO yang baru dibangun wajib ada di menu ───────────────────
console.log('\n== 3. Perintah toko yang baru dibangun ==');

const WAJIB_ADA = [
  ['testi', 'layar bukti anti-tipu'],
  ['list', 'katalog bernomor'],
  ['deposit', 'top up saldo'],
  ['saldo', 'cek saldo'],
  ['me', 'kartu singkat pelanggan'],
  ['dompet', 'rincian aset'],
  ['garansi', 'klaim garansi'],
  ['checkout', 'bayar'],
  ['keranjang', 'isi keranjang']
];
for (const [c, guna] of WAJIB_ADA) {
  cek(`.${c} (${guna}) ada di menu`, diMenu.has(c), 'belum terdaftar');
}

// ── 4. Perintah ADMIN baru wajib ada di panduan admin ───────────────────────
console.log('\n== 4. Perintah admin yang baru dibangun ==');

const ADMIN_BARU = [
  ['stokyatim', 'lihat & buang kredensial yatim'],
  ['sinkronstok', 'betulkan angka stok yang melenceng'],
  ['isisaldo', 'isi saldo pelanggan'],
  ['tariksaldo', 'tarik saldo pelanggan'],
  ['ceksaldo', 'cek saldo pelanggan'],
  ['totalsaldo', 'total saldo seluruh pelanggan'],
  ['kirimulang', 'kirim ulang pesanan yang macet'],
  ['flashsale', 'harga kilat berbatas waktu'],
  ['addcoupon', 'buat kupon diskon'],
  ['listcoupon', 'lihat kupon'],
  ['laporan', 'omzet hari ini'],
  ['broadcast', 'siarkan ke pelanggan'],
  ['takeover', 'ambil alih chat pelanggan'],
  ['notif', 'dikabari saat restok'],
  ['simpan', 'wishlist'],
  ['carapake', 'cara pakai produk'],
  ['ref', 'kode referral'],
  // Pengumuman restok & turun harga. `.setupdategroup` sudah lama menjanjikan
  // "Restock & Penurunan Harga" di pesan konfirmasinya, tetapi tidak satu pun
  // dari ketiganya pernah tercantum di menu.
  ['siaran', 'pengumuman otomatis on/off'],
  ['umumkan', 'kirim pengumuman sekarang'],
  ['restock', 'siarkan restok'],
  ['setupdategroup', 'set grup tujuan pengumuman']
];
for (const [c, guna] of ADMIN_BARU) {
  cek(`.${c} (${guna}) ada di menu`, diMenu.has(c), 'belum terdaftar');
}

console.log('\n════════════════════════════════════════');
console.log(`Pemeriksaan : ${lulus + gagal}`);
console.log(`Lulus       : ${lulus}`);
console.log(`Gagal       : ${gagal}`);
console.log('════════════════════════════════════════');
process.exit(gagal ? 1 : 0);
