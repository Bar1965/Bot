/**
 * SIMULATOR KESEIMBANGAN ARENA KARTU
 *
 * Komentar di cards.js sejak lama menyebut "turnamen 46 kartu" sebagai dasar
 * penyetelan angka, tapi skripnya tidak pernah ada di repo — jadi setiap kali
 * angka diubah, klaim keseimbangannya cuma bisa ditebak ulang. Berkas ini
 * menutup lubang itu.
 *
 * Ia memakai mesin `battle.js` yang ASLI, bukan tiruan, jadi hasilnya tidak
 * bisa melenceng dari yang dialami pemain.
 *
 * Pakai:
 *   node scripts/tcgBalance.mjs              turnamen penuh Lv.1
 *   node scripts/tcgBalance.mjs --n 300      300 duel per pasangan (default 120)
 *   node scripts/tcgBalance.mjs --lv 5       semua kartu di Lv.5
 *   node scripts/tcgBalance.mjs --dek        uji dek 3v3 lintas anggaran bintang
 *
 * Yang perlu diperhatikan saat membaca hasilnya:
 *   - Pita rarity harus TIDAK BERTINDIH terlalu jauh. Satu Epic yang duduk di
 *     atas beberapa Legendary artinya skill-nya kelebihan tenaga.
 *   - Sebaran dalam satu rarity harus rapat (idealnya <10 poin). Sebaran lebar
 *     berarti ada kartu yang tidak pernah punya alasan untuk dipakai.
 *   - "sudah ditentukan" adalah pecahan pertemuan yang salah satu sisinya
 *     menang >95%. Makin kecil makin baik; nol tidak mungkin dan tidak
 *     diinginkan (rarity memang harus berarti).
 */

import {
  KARTU, STAT_RARITY, statKartu, getPeran, SKILL, getKartu, costKartu, sinergiDek,
  periksaKeseimbangan, atkEfektif
} from '../src/games/tcg/cards.js';
import { simulate3v3 } from '../src/games/tcg/battle.js';

const arg = (nama, bawaan) => {
  const i = process.argv.indexOf(`--${nama}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : bawaan;
};
const ada = (nama) => process.argv.includes(`--${nama}`);

const N = Number(arg('n', 120));
const LV = Number(arg('lv', 1));
const URUT_RARITY = ['MYTHIC', 'LEGENDARY', 'EPIC', 'RARE', 'COMMON'];

const rata = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const pct = (x) => `${x.toFixed(1)}%`;

/** Satu slot lawan satu slot. Slot 2 dan 3 sengaja kosong di kedua sisi
 *  (dinilai seri), jadi hasil pertandingan = hasil slot 1 saja. */
function duel(idA, idB, lvA = LV, lvB = LV) {
  const r = simulate3v3(
    { 1: { card_id: idA, card_lv: lvA } },
    { 1: { card_id: idB, card_lv: lvB } },
    'A', 'B', { diam: true }
  );
  return r.matchWinner;
}

function turnamen() {
  const stat = new Map(KARTU.map(k => [k.id, { menang: 0, main: 0 }]));
  const bins = { pasti: 0, timpang: 0, seru: 0, total: 0 };
  const dalamRarity = new Map(URUT_RARITY.map(r => [r, { pasti: 0, seru: 0, total: 0 }]));

  for (let i = 0; i < KARTU.length; i++) {
    for (let j = i + 1; j < KARTU.length; j++) {
      const a = KARTU[i], b = KARTU[j];
      let mA = 0;
      for (let n = 0; n < N; n++) {
        const w = duel(a.id, b.id);
        if (w === 1) mA++; else if (w === 0) mA += 0.5;
      }
      stat.get(a.id).menang += mA; stat.get(a.id).main += N;
      stat.get(b.id).menang += (N - mA); stat.get(b.id).main += N;

      const p = mA / N * 100;
      bins.total++;
      if (p < 5 || p > 95) bins.pasti++;
      else if (p >= 35 && p <= 65) bins.seru++;
      else bins.timpang++;

      if (a.rarity === b.rarity) {
        const d = dalamRarity.get(a.rarity);
        d.total++;
        if (p < 5 || p > 95) d.pasti++;
        else if (p >= 35 && p <= 65) d.seru++;
      }
    }
  }

  const hasil = KARTU
    .map(k => ({ k, wr: stat.get(k.id).menang / stat.get(k.id).main * 100 }))
    .sort((x, y) => y.wr - x.wr);

  console.log(`\n=== TURNAMEN 1v1 SEMUA-LAWAN-SEMUA · Lv.${LV} · ${N} duel/pasangan ===\n`);
  let rarityTerakhir = null;
  for (const h of hasil) {
    if (h.k.rarity !== rarityTerakhir) rarityTerakhir = h.k.rarity;
    const s = statKartu(h.k, LV);
    console.log(
      `${pct(h.wr).padStart(6)}  ${h.k.id}  ${h.k.nama.padEnd(18)} ` +
      `${STAT_RARITY[h.k.rarity].label.padEnd(10)} ${getPeran(h.k).nama.padEnd(10)} ` +
      `${h.k.elemen.padEnd(6)} ${String(s.atk).padStart(4)}/${String(s.hp).padStart(4)} ` +
      `k${String(Math.round(h.k.kritis * 100)).padStart(2)}%  ${SKILL[h.k.skill]?.nama || '-'}`
    );
  }

  const kelompok = (fn, label) => {
    const m = new Map();
    for (const h of hasil) {
      const g = fn(h.k);
      if (!m.has(g)) m.set(g, []);
      m.get(g).push(h.wr);
    }
    console.log(`\n--- WR per ${label} ---`);
    const baris = [...m.entries()].sort((a, b) => rata(b[1]) - rata(a[1]));
    for (const [g, arr] of baris) {
      const min = Math.min(...arr), maks = Math.max(...arr);
      console.log(
        `${String(g).padEnd(12)} ${pct(rata(arr)).padStart(6)}   n=${String(arr.length).padStart(2)}   ` +
        `pita ${pct(min)}–${pct(maks)}   sebaran ${(maks - min).toFixed(1)} poin`
      );
    }
    return baris;
  };

  kelompok(k => k.rarity, 'RARITY');
  kelompok(k => getPeran(k).nama, 'PERAN');
  kelompok(k => k.elemen, 'ELEMEN');

  console.log('\n--- Kualitas pertemuan ---');
  console.log(`Sudah ditentukan (>95% sepihak) : ${bins.pasti}/${bins.total}  ${pct(bins.pasti / bins.total * 100)}`);
  console.log(`Timpang tapi belum pasti        : ${bins.timpang}/${bins.total}  ${pct(bins.timpang / bins.total * 100)}`);
  console.log(`Benar-benar seru (35–65%)       : ${bins.seru}/${bins.total}  ${pct(bins.seru / bins.total * 100)}`);

  console.log('\n--- Kualitas pertemuan DALAM rarity yang sama (yang paling penting) ---');
  for (const r of URUT_RARITY) {
    const d = dalamRarity.get(r);
    if (!d.total) continue;
    console.log(
      `${STAT_RARITY[r].label.padEnd(10)} n=${String(d.total).padStart(3)}   ` +
      `sudah ditentukan ${pct(d.pasti / d.total * 100).padStart(6)}   seru ${pct(d.seru / d.total * 100).padStart(6)}`
    );
  }

  // Kartu yang menembus pita rarity di atas/bawahnya — biang ketidakseimbangan.
  console.log('\n--- Kartu yang keluar dari pita rarity-nya ---');
  const pita = new Map();
  for (const r of URUT_RARITY) {
    const arr = hasil.filter(h => h.k.rarity === r).map(h => h.wr);
    if (arr.length) pita.set(r, { min: Math.min(...arr), maks: Math.max(...arr) });
  }
  let bocor = 0;
  for (let i = 0; i < URUT_RARITY.length - 1; i++) {
    const atas = URUT_RARITY[i], bawah = URUT_RARITY[i + 1];
    if (!pita.has(atas) || !pita.has(bawah)) continue;
    for (const h of hasil.filter(x => x.k.rarity === bawah)) {
      if (h.wr > pita.get(atas).min) {
        console.log(`  ⬆ ${h.k.id} ${h.k.nama.padEnd(18)} ${pct(h.wr)} — di atas ${STAT_RARITY[atas].label} terlemah (${pct(pita.get(atas).min)})`);
        bocor++;
      }
    }
  }
  if (!bocor) console.log('  (tidak ada — pita rarity rapi)');
}

function ujiDek() {
  const D = (a, b, c, lv = LV) => ({ 1: { card_id: a, card_lv: lv }, 2: { card_id: b, card_lv: lv }, 3: { card_id: c, card_lv: lv } });
  const biaya = (d) => [1, 2, 3].reduce((t, s) => t + costKartu(getKartu(d[s].card_id)), 0);
  const deks = {
    'common 3★':   D('CMN07', 'CMN10', 'CMN03'),
    'common tri':  D('CMN07', 'CMN05', 'CMN01'),
    'rare 6★':     D('RAR08', 'RAR09', 'RAR02'),
    'epic 9★':     D('EPC03', 'EPC05', 'EPC06'),
    'campur 7★':   D('EPC03', 'EPC05', 'CMN01'),
    'maks 10★ A':  D('MYT01', 'LGD02', 'CMN07'),
    'maks 10★ B':  D('MYT04', 'LGD03', 'CMN10')
  };
  console.log(`\n=== DEK 3v3 · Lv.${LV} · ${N} pertandingan/pasangan ===\n`);
  for (const [n, d] of Object.entries(deks)) {
    const s = sinergiDek(d);
    console.log(`${n.padEnd(13)} ${biaya(d)}★  sinergi ATK +${Math.round(s.atk * 100)}% / HP +${Math.round(s.hp * 100)}%`);
  }
  const nama = Object.keys(deks);
  console.log('\n' + ''.padEnd(14) + nama.map(n => n.padStart(12)).join(''));
  for (const a of nama) {
    const row = nama.map(b => {
      if (a === b) return '-';
      let m = 0;
      for (let i = 0; i < N; i++) {
        const r = simulate3v3(deks[a], deks[b], 'A', 'B', { diam: true });
        if (r.matchWinner === 1) m++; else if (r.matchWinner === 0) m += 0.5;
      }
      return pct(m / N * 100);
    });
    console.log(a.padEnd(14) + row.map(x => x.padStart(12)).join(''));
  }
}

// --- Penjaga anggaran daya: dijalankan selalu, murah, dan paling sering salah ---
const keluar = periksaKeseimbangan();
console.log('=== ANGGARAN DAYA ===');
console.log(`${KARTU.length} kartu · profil stat unik: ${new Set(KARTU.map(k => `${k.atk}/${k.hp}`)).size}`);
if (keluar.length) {
  for (const k of keluar) console.log(`  ⚠ ${k.id} ${k.nama} menyimpang ${(k.deviasi * 100).toFixed(1)}%`);
} else {
  console.log('  ✅ semua kartu di dalam anggaran rarity-nya');
}
const devMaks = Math.max(...KARTU.map(k =>
  Math.abs(atkEfektif(k.atk, k.kritis) * k.hp / STAT_RARITY[k.rarity].daya - 1)
));
console.log(`  deviasi terbesar: ${(devMaks * 100).toFixed(2)}%`);

if (ada('dek')) ujiDek();
else turnamen();
