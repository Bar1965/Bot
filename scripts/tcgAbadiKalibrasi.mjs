/**
 * KALIBRASI KURVA KESULITAN MENARA ABADI
 *
 * Menara Abadi tidak punya daftar lantai — penjaganya dibangkitkan dari nomor
 * lantai oleh `dekAbadi()`. Artinya tidak ada satu pun angka yang bisa dibaca
 * untuk tahu seberapa berat lantai 30, dan satu-satunya cara mengetahuinya
 * adalah dengan benar-benar memainkannya.
 *
 * Skrip ini melakukan itu. Untuk tiap lantai yang diminta, ia mencari dek
 * TERBAIK yang legal (3 kartu, maksimal `MAKS_BIAYA_DEK` bintang, semuanya
 * level 5) dari seluruh 31.390 kombinasi, lalu mengukur persentase menangnya.
 *
 * Angka yang keluar adalah BATAS ATAS: ia mengandaikan pemain mengganti dek
 * dengan counter elemen sempurna tiap lantai. Pemain sungguhan yang memakai
 * satu dek akan berhenti jauh lebih cepat.
 *
 * Pakai:
 *   node scripts/tcgAbadiKalibrasi.mjs
 *   node scripts/tcgAbadiKalibrasi.mjs 1,10,20,25,30,40,50
 *
 * Jalankan ulang setiap kali `ABADI_SKALA_AWAL`, `ABADI_SKALA_PER_LANTAI`,
 * `ABADI_LANTAI_PER_LEVEL`, kolam kartu elit, atau stat kartu mana pun diubah.
 * Angka rujukan yang tercatat di AGENTS.md §12s berasal dari sini.
 *
 * Skrip ini murni perhitungan — tidak menyentuh database sama sekali.
 */

import path from 'path';
import { pathToFileURL } from 'url';

const AKAR = path.resolve(import.meta.dirname, '..');
const REPO = pathToFileURL(AKAR).href + '/';

const {
  KARTU, ELEMEN, costKartu, statKartu, pengaliElemen, MAKS_BIAYA_DEK
} = await import(REPO + 'src/games/tcg/cards.js');
const {
  simulate3v3, dekAbadi, TOWER_FLOORS, getTowerFloor,
  ABADI_SKALA_AWAL, ABADI_SKALA_PER_LANTAI, ABADI_LANTAI_PER_LEVEL
} = await import(REPO + 'src/games/tcg/battle.js');

const LANTAI = (process.argv[2] || '1,5,10,15,20,25,30,35,40,50,60')
  .split(',').map(n => parseInt(n, 10)).filter(n => n > 0);

// Penyaringan dua tahap: sedikit simulasi untuk semua kandidat, lalu banyak
// simulasi untuk yang teratas. Menjalankan 400 simulasi × 31.390 dek × 11
// lantai butuh berjam-jam dan tidak menghasilkan angka yang lebih benar.
const SARING_KASAR = 14;
const SARING_HALUS = 400;
const KANDIDAT_PER_ELEMEN = 900;

const dek = (t) => ({
  1: { card_id: t[0], card_lv: 5 },
  2: { card_id: t[1], card_lv: 5 },
  3: { card_id: t[2], card_lv: 5 }
});

const ids = KARTU.map(k => k.id);
const semuaKombinasi = [];
for (let i = 0; i < ids.length; i++) {
  for (let j = i + 1; j < ids.length; j++) {
    for (let k = j + 1; k < ids.length; k++) {
      const t = [ids[i], ids[j], ids[k]];
      if (t.reduce((s, x) => s + costKartu(KARTU.find(c => c.id === x)), 0) <= MAKS_BIAYA_DEK) {
        semuaKombinasi.push(t);
      }
    }
  }
}

/**
 * Daya mentah satu dek, dipakai untuk menyaring kolam kandidat.
 *
 * Mengurutkan berdasarkan daya mentah saja akan membuang seluruh dek counter —
 * dan counter elemen justru cara utama pemain menembus lantai dalam. Bobot
 * elemennya dibuat kasar; penyaringan halus di bawah yang menentukan.
 */
const daya = (t) => t.reduce((s, x) => {
  const q = statKartu(KARTU.find(c => c.id === x), 5);
  return s + q.atk * q.hp;
}, 0);

const kandidat = new Set();
// Selain kolam per-elemen: dek terkuat secara mentah, tanpa pertimbangan
// counter. Kolam yang HANYA diberi bobot elemen pernah melewatkan dek terbaik
// sungguhan untuk bos lantai 30 dan melaporkan 29% padahal jawabannya 51%.
semuaKombinasi
  .map(t => ({ t, skor: daya(t) }))
  .sort((a, b) => b.skor - a.skor)
  .slice(0, KANDIDAT_PER_ELEMEN)
  .forEach(x => kandidat.add(x.t.join(',')));

for (const el of Object.keys(ELEMEN)) {
  semuaKombinasi
    .map(t => {
      const unggul = t.filter(x => pengaliElemen(KARTU.find(c => c.id === x).elemen, el) > 1).length;
      return { t, skor: daya(t) * (1 + unggul * 0.5) };
    })
    .sort((a, b) => b.skor - a.skor)
    .slice(0, KANDIDAT_PER_ELEMEN)
    .forEach(x => kandidat.add(x.t.join(',')));
}
const KANDIDAT = [...kandidat].map(s => s.split(','));

function menangPersen(dekPemain, dekLawan, n) {
  let w = 0;
  for (let i = 0; i < n; i++) {
    if (simulate3v3(dekPemain, dekLawan, 'A', 'B', { diam: true }).matchWinner === 1) w++;
  }
  return w / n;
}

function dekTerbaikLawan(dekLawan) {
  const kasar = KANDIDAT
    .map(t => ({ t, w: menangPersen(dek(t), dekLawan, SARING_KASAR) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 6);

  let terbaik = { t: kasar[0]?.t || null, p: 0 };
  for (const c of kasar) {
    const p = menangPersen(dek(c.t), dekLawan, SARING_HALUS);
    if (p > terbaik.p) terbaik = { t: c.t, p };
  }
  return terbaik;
}

console.log('KALIBRASI MENARA ABADI');
console.log(`Dek legal ≤${MAKS_BIAYA_DEK}★ : ${semuaKombinasi.length.toLocaleString('id-ID')}`);
console.log(`Kandidat diuji     : ${KANDIDAT.length.toLocaleString('id-ID')} (${KANDIDAT_PER_ELEMEN}/elemen + daya mentah)`);
console.log(`Tetapan            : awal ×${ABADI_SKALA_AWAL} · +${ABADI_SKALA_PER_LANTAI}/lantai · level naik tiap ${ABADI_LANTAI_PER_LEVEL} lantai`);
console.log('');

// Titik rujukan: bos akhir Menara Penjaga. Lantai Abadi hanya bisa dinilai
// relatif terhadap sesuatu yang sudah dimainkan orang.
const bos = getTowerFloor(TOWER_FLOORS.length);
const rujukan = dekTerbaikLawan(bos.deck);
console.log(`Rujukan — Menara lantai ${TOWER_FLOORS.length} (${bos.nama})`);
console.log(`   dek terbaik ${rujukan.t.join('/')} menang ${Math.round(rujukan.p * 100)}%`);
console.log('');

console.log('lantai   lv   skala   elemen   menang%   dek terbaik');
console.log('─────────────────────────────────────────────────────────────');
for (const l of LANTAI) {
  const g = dekAbadi(l);
  const r = dekTerbaikLawan(g.deck);
  console.log(
    `${String(l).padStart(6)}   ${g.level}   ${g.skala.toFixed(2).padStart(5)}   ` +
    `${g.elemen.padEnd(6)}   ${(Math.round(r.p * 100) + '%').padStart(7)}   ${r.t ? r.t.join('/') : '-'}`
  );
}
console.log('');
console.log('_Angka ini mengandaikan counter-pick sempurna tiap lantai — batas atas, bukan rata-rata._');
