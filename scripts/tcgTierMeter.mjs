/**
 * PENGUKUR TIER & PENGAWAS REFINE
 *
 * Pemilik memutuskan: pemain sendiri yang menilai kartu mana yang layak dikejar,
 * bot tidak menempelkan label META atau LEWATI. Tugas kita cuma MENGAWASI supaya
 * tidak ada yang terlanjur terlalu kuat.
 *
 * Berkas ini alat pengawasnya. Ia tidak dipanggil bot saat berjalan; jalankan
 * tangan setiap kali angka skill, batas R, atau katalog kartu disentuh:
 *
 *     node scripts/tcgTierMeter.mjs            (ringkas, semua rarity)
 *     node scripts/tcgTierMeter.mjs --penuh    (per kartu, dengan skillnya)
 *
 * Empat hal diperiksa. TIGA bisa GAGAL dan mengembalikan kode keluar bukan-nol
 * supaya tidak bisa diabaikan diam-diam; yang keempat cuma peringatan:
 *
 *   1. R1 IDENTIK. `skillEfektif(kartu, 1)` wajib mengembalikan objek SKILL yang
 *      asli. Kalau ini bergeser, seluruh keseimbangan yang sudah diukur — kurva
 *      Menara Abadi, kalibrasi Gauntlet, HP Bos — ikut bergeser diam-diam.
 *   2. SEBARAN dalam rarity. Ketimpangan memang disengaja, tapi ada batasnya.
 *   3. NILAI R (peringatan saja). Kartu yang R-nya nyaris tidak berarti cuma
 *      dilaporkan, tidak menggagalkan. Pemain yang memutuskan kartu itu layak
 *      dikejar atau tidak — bot tidak menghakiminya.
 *   4. TANGGA RARITY. Ini yang paling penting: kartu R5 TIDAK BOLEH mengalahkan
 *      kartu satu tingkat rarity di atasnya secara konsisten. Kalau Epic R5
 *      rutin menumbangkan Legendary R1, alasan gacha lenyap.
 *
 * Elemen sengaja tidak dinetralkan tapi diukur dan dilaporkan: dalam adu penuh
 * sesama rarity, paparan elemen tiap kartu terbukti sama rata (1,009-1,010), jadi
 * selisih menang yang tersisa memang berasal dari stat dan skill.
 */

import path from 'path';
import { pathToFileURL } from 'url';

const REPO = pathToFileURL(path.resolve(process.cwd())).href + '/';
const {
  KARTU, SKILL, skillEfektif, pengaliElemen, STAT_RARITY, MAKS_REFINE, REFINE_SKALA
} = await import(REPO + 'src/games/tcg/cards.js');
const { simulate3v3 } = await import(REPO + 'src/games/tcg/battle.js');

const PENUH = process.argv.includes('--penuh');
const REP = Number(process.argv.find(a => a.startsWith('--rep='))?.slice(6)) || 40;

// --- Ambang pengawasan ---------------------------------------------------
// Sengaja longgar: tugasnya menangkap yang RUSAK, bukan memaksa semua kartu
// jadi sama. Ketimpangan yang terukur di bawah ambang ini justru yang bikin
// koleksi punya rasa.
const AMBANG_SEBARAN = 0.34;   // selisih menang terkuat-terlemah dalam 1 rarity
const AMBANG_NAIK_KELAS = 0.62; // menang kartu R5 lawan rarity di atasnya (R1)
const AMBANG_R_MANDUL = 0.02;   // kenaikan menang R1 -> R5 yang dianggap "nihil"

const RARITY = ['MYTHIC', 'LEGENDARY', 'EPIC', 'RARE', 'COMMON'];
const dek = (id, lv, r) => ({
  1: { card_id: id, card_lv: lv, refine: r },
  2: { card_id: id, card_lv: lv, refine: r },
  3: { card_id: id, card_lv: lv, refine: r }
});

function adu(idA, rA, idB, rB, rep = REP, lv = 3) {
  let menang = 0;
  for (let i = 0; i < rep; i++) {
    const h = simulate3v3(dek(idA, lv, rA), dek(idB, lv, rB), 'A', 'B');
    if (h.scoreA > h.scoreB) menang++;
    else if (h.scoreA === h.scoreB) menang += 0.5;
  }
  return menang / rep;
}

const pesan = [];
const gagal = [];
const lulus = (ok, teks) => { (ok ? pesan : gagal).push(`${ok ? '✅' : '❌'} ${teks}`); return ok; };

// ========================================================================
// 1. R1 WAJIB IDENTIK DENGAN HARI INI
// ========================================================================
console.log('════ 1. R1 IDENTIK DENGAN SEBELUM REFINE ADA ════');
let geser = 0;
for (const k of KARTU) {
  if (!k.skill) continue;
  if (skillEfektif(k, 1) !== SKILL[k.skill]) {
    geser++;
    console.log(`  ❌ ${k.nama} — skillEfektif(,1) bukan objek SKILL yang asli`);
  }
}
lulus(geser === 0, `${KARTU.length} kartu: R1 mengembalikan objek SKILL asli, nol pergeseran`);
console.log(`  ${geser === 0 ? '✅' : '❌'} ${KARTU.length} kartu diperiksa · ${geser} bergeser`);

// ========================================================================
// 2. SEBARAN DALAM RARITY + 3. NILAI R
// ========================================================================
const ringkasan = [];

for (const rarity of RARITY) {
  const pool = KARTU.filter(k => k.rarity === rarity);
  if (pool.length < 2) continue;

  console.log(`\n════ ${rarity} — ${pool.length} kartu · anggaran daya ${STAT_RARITY[rarity].daya} ════`);

  const baris = [];
  for (const a of pool) {
    let m1 = 0, m5 = 0, el = 0, n = 0;
    for (const b of pool) {
      if (a.id === b.id) continue;
      // R1 lawan R1 -> peringkat dasar. R5 lawan R1 -> nilai sebenarnya dari R.
      m1 += adu(a.id, 1, b.id, 1);
      m5 += adu(a.id, MAKS_REFINE, b.id, 1);
      el += pengaliElemen(a.elemen, b.elemen);
      n++;
    }
    baris.push({ k: a, wr1: m1 / n, wr5: m5 / n, el: el / n });
  }
  baris.sort((x, y) => y.wr1 - x.wr1);

  for (const b of baris) {
    const naik = b.wr5 - b.wr1;
    const tanda = naik < AMBANG_R_MANDUL ? ' ⚠️ R nyaris tidak berarti' : '';
    console.log(
      `  ${b.k.nama.padEnd(19)} R1 ${String(Math.round(b.wr1 * 100)).padStart(3)}%` +
      `  ➜ R5 ${String(Math.round(b.wr5 * 100)).padStart(3)}%` +
      `  (${naik >= 0 ? '+' : ''}${Math.round(naik * 100)})  el${b.el.toFixed(3)}${tanda}`
    );
    if (PENUH) console.log(`      ${SKILL[b.k.skill].nama} — ${SKILL[b.k.skill].teks}`);
  }

  const w1 = baris.map(b => b.wr1);
  const sebaran = Math.max(...w1) - Math.min(...w1);
  const mandul = baris.filter(b => b.wr5 - b.wr1 < AMBANG_R_MANDUL);

  console.log(`  ➜ sebaran R1: ${Math.round(sebaran * 100)} poin` +
    `  ·  rata kenaikan R5: +${Math.round((baris.reduce((t, b) => t + (b.wr5 - b.wr1), 0) / baris.length) * 100)} poin`);

  lulus(sebaran <= AMBANG_SEBARAN,
    `${rarity}: sebaran ${Math.round(sebaran * 100)} poin (ambang ${Math.round(AMBANG_SEBARAN * 100)})`);
  // SENGAJA cuma peringatan, bukan kegagalan. Pemilik memutuskan pemain sendiri
  // yang menilai kartu mana yang layak dikejar; tugas pengawas ini hanya
  // menangkap yang TERLALU KUAT. Kartu yang R-nya lemah adalah pilihan pemain,
  // bukan cacat yang harus menghentikan rilis.
  if (mandul.length) {
    console.log(`  ⚠️  R nyaris tidak berarti untuk: ${mandul.map(m => m.k.nama).join(', ')}`);
    console.log('     (peringatan saja — pemain yang menilai, bukan bot)');
  }

  ringkasan.push({ rarity, baris, sebaran });
}

// ========================================================================
// 4. TANGGA RARITY — R5 TIDAK BOLEH MENGALAHKAN RARITY DI ATASNYA
// ========================================================================
console.log('\n════ 4. TANGGA RARITY: R5 vs RARITY DI ATASNYA (R1) ════');
console.log('   Kalau ini jebol, gacha kehilangan alasannya: pemain cukup me-refine');
console.log('   kartu murah dan tidak perlu mengejar yang langka.\n');

for (let i = RARITY.length - 1; i > 0; i--) {
  const bawah = KARTU.filter(k => k.rarity === RARITY[i]);
  const atas = KARTU.filter(k => k.rarity === RARITY[i - 1]);
  if (!bawah.length || !atas.length) continue;

  let total = 0, n = 0, puncak = { wr: -1 };
  for (const a of bawah) {
    let m = 0;
    for (const b of atas) { const wr = adu(a.id, MAKS_REFINE, b.id, 1); m += wr; total += wr; n++; }
    const rata = m / atas.length;
    if (rata > puncak.wr) puncak = { wr: rata, nama: a.nama };
  }
  const rata = total / n;
  const ok = puncak.wr <= AMBANG_NAIK_KELAS;
  console.log(
    `  ${ok ? '✅' : '❌'} ${RARITY[i]} R5 vs ${RARITY[i - 1]} R1: rata ${Math.round(rata * 100)}%` +
    `  ·  terkuat ${puncak.nama} ${Math.round(puncak.wr * 100)}%  (ambang ${Math.round(AMBANG_NAIK_KELAS * 100)}%)`
  );
  lulus(ok, `${RARITY[i]} R5 tidak melampaui ${RARITY[i - 1]} R1 (terkuat ${Math.round(puncak.wr * 100)}%)`);
}

// ========================================================================
console.log('\n════════════════════════════════════════');
console.log(`Skala R yang dipakai : ${REFINE_SKALA.map((s, i) => `R${i + 1}=x${s.toFixed(2)}`).join('  ')}`);
console.log(`Ulangan per pasangan : ${REP}`);
console.log(`Lulus                : ${pesan.length}`);
console.log(`Gagal                : ${gagal.length}`);
if (gagal.length) {
  console.log('\nYANG GAGAL:');
  for (const g of gagal) console.log('  ' + g);
}
console.log('════════════════════════════════════════');
process.exit(gagal.length ? 1 : 0);
