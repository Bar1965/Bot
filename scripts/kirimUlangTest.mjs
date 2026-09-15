/**
 * UJI SIMPANAN PESAN KELUAR (PERBAIKAN "MENUNGGU PESAN INI")
 *
 * Di WhatsApp multi-device, perangkat penerima kadang gagal mendekripsi sebuah
 * pesan. Itu normal. Yang tidak normal adalah kalau kegagalan itu tidak pernah
 * pulih — dan itulah yang terjadi di bot ini sampai 15 September 2026.
 *
 * Pemulihannya begini: perangkat penerima mengirim "retry receipt", lalu
 * Baileys memanggil `getMessage(key)` untuk menyusun ulang isi pesannya dan
 * mengirimnya lagi dengan sesi baru. Isi Baileys 6.7.23, messages-recv.js:
 *
 *     const msgs = await Promise.all(ids.map(id => getMessage({ ...key, id })));
 *     for (const [i, msg] of msgs.entries()) { if (msg) { ...kirim ulang... } }
 *
 * Bawaan `getMessage` adalah `async () => undefined`, dan bot.js tidak pernah
 * menggantinya. Jadi `msg` selalu undefined, `if (msg)` tidak pernah masuk, dan
 * TIDAK ADA yang dikirim ulang. Penerima tertinggal pada "Menunggu pesan ini"
 * selamanya, sementara di sisi bot pengiriman tercatat SUCCESS.
 *
 * Uji ini menjaga tiga hal:
 *   1. bot.js benar-benar memasang getMessage ke makeWASocket;
 *   2. pesan yang barusan dikirim bisa ditemukan lagi lewat id-nya;
 *   3. simpanannya tidak tumbuh tanpa batas.
 *
 * Pakai:
 *   node scripts/kirimUlangTest.mjs
 *
 * Tidak menyentuh jaringan, database, atau sesi WhatsApp — bot.js TIDAK diimpor
 * (mengimpornya akan menyalakan koneksi WhatsApp sungguhan).
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const AKAR = path.resolve(import.meta.dirname, '..');
const require = createRequire(pathToFileURL(path.join(AKAR, 'package.json')));
const acorn = require('acorn');
const walk = require('acorn-walk');

let lulus = 0;
let gagal = 0;
function cek(nama, kondisi, detail = '') {
  if (kondisi) { lulus++; console.log(`  OK    ${nama}`); }
  else { gagal++; console.log(`  GAGAL ${nama}${detail !== '' ? ' -> ' + detail : ''}`); }
}
const bagian = (j) => console.log(`\n== ${j} ==`);

console.log('\n╔══════════════════════════════════════════════════════╗');
console.log('║  UJI PERBAIKAN "MENUNGGU PESAN INI"                  ║');
console.log('╚══════════════════════════════════════════════════════╝');

// ============================================================
bagian('1. Baileys memang memanggil getMessage saat diminta kirim ulang');

const recvPath = path.join(AKAR, 'node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js');
cek('berkas messages-recv.js Baileys ada', fs.existsSync(recvPath), recvPath);

if (fs.existsSync(recvPath)) {
  const recv = fs.readFileSync(recvPath, 'utf8');
  cek('sendMessagesAgain memanggil getMessage',
    /sendMessagesAgain[\s\S]{0,400}getMessage\(/.test(recv));
  cek('hasilnya dijaga oleh `if (msg)` — undefined berarti tidak dikirim',
    /for \(const \[i, msg\] of msgs\.entries\(\)\)[\s\S]{0,80}if \(msg\)/.test(recv));

  const defaultsPath = path.join(AKAR, 'node_modules/@whiskeysockets/baileys/lib/Defaults/index.js');
  if (fs.existsSync(defaultsPath)) {
    cek('bawaan Baileys memang mengembalikan undefined',
      /getMessage:\s*async\s*\(\)\s*=>\s*undefined/.test(fs.readFileSync(defaultsPath, 'utf8')));
  }
}

// ============================================================
bagian('2. bot.js memasang getMessage ke makeWASocket');

const src = fs.readFileSync(path.join(AKAR, 'bot.js'), 'utf8');
const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });

let opsiSocket = null;
walk.simple(ast, {
  CallExpression(node) {
    if (node.callee?.name !== 'makeWASocket') return;
    if (node.arguments[0]?.type === 'ObjectExpression') opsiSocket = node.arguments[0];
  }
});

cek('makeWASocket dipanggil dengan objek opsi', Boolean(opsiSocket));
const namaOpsi = (opsiSocket?.properties || [])
  .filter(p => p.key)
  .map(p => p.key.name || p.key.value);
cek('opsi getMessage terpasang', namaOpsi.includes('getMessage'), namaOpsi.join(', '));
cek('opsi auth tetap ada', namaOpsi.includes('auth'));

cek('pesan keluar disimpan di jalur kirim yang berhasil',
  /SUCCESS \(MessageID[\s\S]{0,400}simpanPesanKeluar\(result\)/.test(src));
cek('penyimpanan terjadi sebelum antrean digeser',
  src.indexOf('simpanPesanKeluar(result)') < src.indexOf('outgoingMessageQueue.shift()'));

// ============================================================
bagian('3. Perilaku simpanan: temu-kembali & batas');

// Salin logika simpanan apa adanya dari bot.js supaya bisa diuji tanpa
// mengimpor bot.js (impor bot.js menyalakan koneksi WhatsApp sungguhan).
const MAKS = 500;
const cache = new Map();
function simpan(result) {
  const id = result?.key?.id;
  if (!id || !result?.message) return;
  if (cache.has(id)) cache.delete(id);
  cache.set(id, result.message);
  while (cache.size > MAKS) cache.delete(cache.keys().next().value);
}
async function ambil(key) {
  const id = key?.id;
  return id && cache.has(id) ? cache.get(id) : undefined;
}

simpan({ key: { id: 'ABC123' }, message: { conversation: 'halo kak' } });
cek('pesan yang dikirim bisa ditemukan lagi',
  (await ambil({ id: 'ABC123' }))?.conversation === 'halo kak');
cek('yang dikembalikan adalah isi proto, bukan { text }',
  Object.keys((await ambil({ id: 'ABC123' })) || {})[0] === 'conversation');
cek('id yang tidak dikenal mengembalikan undefined', (await ambil({ id: 'TIDAK-ADA' })) === undefined);
cek('key tanpa id tidak melempar', (await ambil({})) === undefined);
cek('key null tidak melempar', (await ambil(null)) === undefined);

simpan({ key: { id: 'TANPA-ISI' } });
cek('hasil kirim tanpa message tidak disimpan', !cache.has('TANPA-ISI'));
simpan(null);
cek('hasil kirim null tidak melempar', true);

// Batas atas: yang tertua dibuang, yang terbaru bertahan.
for (let i = 0; i < MAKS + 120; i++) {
  simpan({ key: { id: `ID-${i}` }, message: { conversation: `pesan ${i}` } });
}
cek('simpanan tidak tumbuh tanpa batas', cache.size === MAKS, String(cache.size));
cek('pesan terbaru masih ada', cache.has(`ID-${MAKS + 119}`));
cek('pesan tertua sudah dibuang', !cache.has('ID-0'));
cek('pesan sebelum ambang juga dibuang', !cache.has('ABC123'));

// Mengirim ulang id yang sama tidak menggandakan barisnya.
const sebelum = cache.size;
simpan({ key: { id: `ID-${MAKS + 119}` }, message: { conversation: 'diperbarui' } });
cek('id yang sama tidak menggandakan entri', cache.size === sebelum, String(cache.size));
cek('isinya diperbarui ke yang terbaru',
  (await ambil({ id: `ID-${MAKS + 119}` }))?.conversation === 'diperbarui');

console.log('\n════════════════════════════════════════');
console.log(`Pemeriksaan : ${lulus + gagal}`);
console.log(`Lulus       : ${lulus}`);
console.log(`Gagal       : ${gagal}`);
console.log('════════════════════════════════════════');
process.exit(gagal ? 1 : 0);
