/**
 * UJI JEBAKAN RUNTIME — BUG YANG LOLOS `node --check`
 *
 * Repo ini tidak punya linter dan tidak bisa dijalankan tanpa sesi WhatsApp,
 * jadi satu-satunya alat otomatis yang ada adalah `node --check`. Masalahnya,
 * `node --check` hanya memeriksa SINTAKS. Ada dua kesalahan yang sintaksnya sah
 * sempurna, lolos pemeriksaan itu, dan baru meledak saat pelanggan sungguhan
 * mengetik perintahnya — lalu mendarat di penangkap teratas bot.js yang cuma
 * console.error, sehingga PELANGGAN TIDAK MENDAPAT BALASAN APA PUN.
 *
 * Keduanya sudah pernah terjadi di toko ini, jadi keduanya dijaga di sini.
 *
 * ── Jebakan 1: backtick di dalam template literal ───────────────────────────
 *
 *     const pesan = `Masuk keranjang. Ketik `.checkout` untuk bayar.`;
 *
 * Mata manusia membaca satu kalimat. JavaScript membaca: template
 * `Masuk keranjang. Ketik `, lalu ambil properti `.checkout` dari string itu
 * (undefined), lalu panggil undefined sebagai fungsi tag untuk template
 * berikutnya -> TypeError.
 *
 * Pada 15 September 2026 ada 13 tempat seperti ini sekaligus — termasuk
 * balasan `.beli`, isi `.keranjang`, konfirmasi pilih paket, dan tiga pengingat
 * terjadwal. Artinya jalur belanja utama toko diam-diam mati.
 *
 * ── Jebakan 2: helper `const` dipanggil sebelum barisnya dieksekusi ─────────
 *
 *     if (sesuatu) return await kirim();        // baris 400
 *     const kirim = async () => { ... };        // baris 640
 *
 * `const` punya temporal dead zone: memanggilnya dari baris yang dieksekusi
 * lebih dulu melempar ReferenceError. customerHandler.js panjangnya 2.400 baris
 * dengan puluhan helper seperti ini, dan jebakan ini sudah dua kali kena.
 *
 * Pakai:
 *   node scripts/runtimeTrapTest.mjs
 *
 * Murni membaca berkas — tidak menyentuh database, jaringan, atau sesi WhatsApp.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const AKAR = path.resolve(import.meta.dirname, '..');
const require = createRequire(pathToFileURL(path.join(AKAR, 'package.json')));
const acorn = require('acorn');
const walk = require('acorn-walk');

// Tag template yang memang sengaja dipakai orang. Kalau suatu hari repo ini
// betul-betul memakai salah satunya, tambahkan di sini — jangan matikan ujinya.
const TAG_SAH = new Set(['String.raw', 'raw', 'sql', 'html', 'css', 'gql', 'dedent']);

const FUNGSI = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

// Berkas mati yang tidak pernah dijalankan (AGENTS.md §17).
const BERKAS_MATI = /^(bot_backup\.js|fix.*\.(js|cjs)|patch_.*\.(js|cjs)|update_.*\.cjs|cleanup\.cjs|restore_cust\.js)$/;
const FOLDER_DILEWATI = new Set(['node_modules', '.git', 'session', 'backups', 'temp', 'tmp', '.tmpd']);

function kumpulkanBerkas(dir, hasil = []) {
  for (const entri of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entri.isDirectory()) {
      if (FOLDER_DILEWATI.has(entri.name)) continue;
      kumpulkanBerkas(path.join(dir, entri.name), hasil);
      continue;
    }
    if (!/\.(js|mjs|cjs)$/.test(entri.name)) continue;
    if (BERKAS_MATI.test(entri.name)) continue;
    hasil.push(path.join(dir, entri.name));
  }
  return hasil;
}

let berkasDipindai = 0;
const gagal = [];

console.log('\n╔══════════════════════════════════════════════════════╗');
console.log('║  UJI JEBAKAN RUNTIME — LOLOS node --check            ║');
console.log('╚══════════════════════════════════════════════════════╝\n');

const berkas = kumpulkanBerkas(AKAR);
console.log(`Memindai ${berkas.length} berkas JavaScript...\n`);

const temuanTag = [];
const temuanTdz = [];

for (const absolut of berkas) {
  const relatif = path.relative(AKAR, absolut).replace(/\\/g, '/');
  const src = fs.readFileSync(absolut, 'utf8');

  let ast = null;
  for (const sourceType of ['module', 'script']) {
    try {
      ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType, locations: true });
      break;
    } catch { /* coba mode berikutnya */ }
  }

  berkasDipindai++;
  if (!ast) {
    gagal.push(`${relatif} — gagal diurai oleh parser`);
    continue;
  }

  const barisSumber = src.split('\n');

  // ── Jebakan 1 ─────────────────────────────────────────────────────────────
  walk.simple(ast, {
    TaggedTemplateExpression(node) {
      const tag = src.slice(node.tag.start, node.tag.end);
      if (TAG_SAH.has(tag)) return;
      temuanTag.push({
        berkas: relatif,
        baris: node.loc.start.line,
        cuplikan: (barisSumber[node.loc.start.line - 1] || '').trim().slice(0, 100)
      });
    }
  });

  // ── Jebakan 2 ─────────────────────────────────────────────────────────────
  walk.full(ast, (fn) => {
    if (!FUNGSI.has(fn.type)) return;
    const body = fn.body;
    if (!body || body.type !== 'BlockStatement') return;

    // Helper: const/let berisi fungsi, dideklarasikan langsung di badan ini.
    const helper = new Map();
    for (const st of body.body) {
      if (st.type !== 'VariableDeclaration' || st.kind === 'var') continue;
      for (const d of st.declarations) {
        if (d.id?.type !== 'Identifier') continue;
        if (!d.init || !FUNGSI.has(d.init.type)) continue;
        helper.set(d.id.name, { start: st.start, baris: st.loc.start.line, isi: d.init });
      }
    }
    if (helper.size === 0) return;

    // Helper apa saja yang disebut di dalam badan tiap helper.
    const rujukan = new Map();
    for (const [nama, info] of helper) {
      const set = new Set();
      walk.full(info.isi, (n) => {
        if (n.type === 'Identifier' && helper.has(n.name) && n.name !== nama) set.add(n.name);
      });
      rujukan.set(nama, set);
    }

    // Penutupan transitif: memanggil A yang memanggil B berarti B juga harus
    // sudah terinisialisasi saat baris itu jalan.
    const tutup = (nama, sudah = new Set()) => {
      if (sudah.has(nama)) return sudah;
      sudah.add(nama);
      for (const anak of rujukan.get(nama) || []) tutup(anak, sudah);
      return sudah;
    };

    for (const st of body.body) {
      // Deklarasi helper itu sendiri tidak dieksekusi isinya, jadi dilewati.
      if (st.type === 'VariableDeclaration' && st.declarations.some(d => d.init && FUNGSI.has(d.init.type))) continue;

      const langsung = new Set();
      walk.full(st, (n) => {
        if (n.type === 'Identifier' && helper.has(n.name)) langsung.add(n.name);
      });
      if (langsung.size === 0) continue;

      const semua = new Set();
      for (const n of langsung) for (const m of tutup(n)) semua.add(m);

      for (const nama of semua) {
        const info = helper.get(nama);
        if (info.start > st.start) {
          temuanTdz.push({
            berkas: relatif,
            baris: st.loc.start.line,
            nama,
            deklarasi: info.baris
          });
        }
      }
    }
  });
}

// Satu baris bisa memuat beberapa node bersarang — laporkan sekali saja.
function unikkan(daftar, kunciFn) {
  const hasil = [];
  const terlihat = new Set();
  for (const t of daftar) {
    const k = kunciFn(t);
    if (terlihat.has(k)) continue;
    terlihat.add(k);
    hasil.push(t);
  }
  return hasil;
}

console.log('== Jebakan 1: backtick tanpa escape di template literal ==');
const tagUnik = unikkan(temuanTag, t => `${t.berkas}:${t.baris}`);
if (tagUnik.length === 0) {
  console.log('  OK    tidak ada tagged template tak sengaja');
} else {
  for (const t of tagUnik) {
    console.log(`  GAGAL ${t.berkas}:${t.baris}`);
    console.log(`        ${t.cuplikan}`);
    gagal.push(`${t.berkas}:${t.baris} — backtick di dalam template literal belum di-escape`);
  }
  console.log('\n  Perbaikannya: escape backtick di dalam teksnya menjadi \\` ');
  console.log('  supaya nama perintah tetap tampil sebagai kode di WhatsApp.');
}

console.log('\n== Jebakan 2: helper const dipanggil sebelum dideklarasikan ==');
const tdzUnik = unikkan(temuanTdz, t => `${t.berkas}:${t.baris}:${t.nama}`);
if (tdzUnik.length === 0) {
  console.log('  OK    tidak ada helper yang dipanggil di dalam temporal dead zone');
} else {
  for (const t of tdzUnik) {
    console.log(`  GAGAL ${t.berkas}:${t.baris} memakai '${t.nama}' yang baru ada di baris ${t.deklarasi}`);
    gagal.push(`${t.berkas}:${t.baris} — '${t.nama}' dipanggil sebelum baris ${t.deklarasi} dieksekusi`);
  }
  console.log('\n  Perbaikannya: pindahkan deklarasi helper ke ATAS baris yang memanggilnya.');
}

console.log('\n════════════════════════════════════════');
console.log(`Berkas dipindai : ${berkasDipindai}`);
console.log(`Gagal           : ${gagal.length}`);
for (const g of gagal) console.log(`  - ${g}`);
console.log('════════════════════════════════════════');
process.exit(gagal.length ? 1 : 0);
