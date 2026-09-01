/**
 * BANNER GACHA — KARTU UNGGULAN & SISTEM RATE ON/OFF
 *
 * ============================================================
 * KENAPA BANNER ADA
 * ============================================================
 * Sebelum ini `.tcg gacha` mengundi rata di seluruh rarity: kalau kamu dapat
 * Mythic, peluangnya sama besar untuk kelima-limanya. Artinya tidak ada satu pun
 * tarikan yang bisa DITUJU. Pemain yang mengejar satu kartu tertentu hanya bisa
 * berharap, dan harapan tanpa arah itu yang membuat gacha terasa hambar.
 *
 * Banner memberi arah: tiap 14 hari ada satu Mythic dan dua Legendary yang
 * peluangnya dinaikkan, dan pemain tahu persis apa yang sedang ia kejar.
 *
 * ============================================================
 * RATE ON / RATE OFF
 * ============================================================
 * "Rate ON" = kartu unggulan banner ini, peluangnya dinaikkan.
 * "Rate OFF" = kartu lain di rarity yang sama; TETAP BISA KELUAR, cuma tidak
 * dinaikkan. Ini penting dan sengaja: tidak ada satu kartu pun yang menjadi
 * mustahil didapat hanya karena bannernya sedang tidak tayang.
 *
 * Mekanismenya persis 50/50 yang sudah dikenal pemain gacha:
 *
 *   Dapat Mythic  ->  50% kartu unggulan
 *                 ->  50% Mythic lain, TAPI jaminan menyala
 *   Jaminan nyala ->  Mythic BERIKUTNYA pasti kartu unggulan
 *
 * Jadi paling buruk seorang pemain butuh dua Mythic untuk mendapat yang ia
 * kejar — tidak pernah lebih. Tanpa jaminan itu, seseorang bisa apes berkali-kali
 * berturut-turut dan berhenti main; itulah kenapa hampir semua gacha modern
 * memakainya.
 *
 * Legendary memakai aturan yang sama dengan jaminannya sendiri, terpisah dari
 * jaminan Mythic supaya satu tidak memakan yang lain.
 *
 * ============================================================
 * KENAPA DETERMINISTIK, BUKAN DISIMPAN DI BASIS DATA
 * ============================================================
 * Banner dihitung dari tanggal, sama seperti `dekAbadi`, `dekGauntlet`, dan
 * `bosPekan`. Tidak ada tabel jadwal, tidak ada penjadwal yang harus hidup, dan
 * tidak ada cara banner "lupa berganti" karena bot mati di jam pergantian.
 * `scheduler.js` tidak pernah menyentuh TCG sama sekali (lihat AGENTS.md §12v),
 * jadi apa pun yang harus berganti sendiri WAJIB dihitung dari waktu.
 */

import { KARTU, ELEMEN, getKartu } from './cards.js';

/** Panjang satu banner, dalam hari. */
export const BANNER_HARI = 14;

/** Peluang kartu unggulan saat rarity yang bersangkutan keluar. */
export const BANNER_PELUANG_MYTHIC = 0.50;
export const BANNER_PELUANG_LEGENDARY = 0.50;

/**
 * Nama banner ditulis tangan per Mythic, bukan dirakit dari daftar kata.
 *
 * Bandingkan dengan `namaLantaiAbadi` yang memang harus dirakit karena lantainya
 * tak terhingga — di sini jumlahnya cuma lima dan tidak akan pernah bertambah
 * tanpa kartu Mythic baru. Nama tulisan tangan jauh lebih bagus, dan tiap nama
 * sengaja menggemakan gelar Inggris kartunya (lihat GELAR di cards.js).
 */
const NAMA_BANNER = {
  MYT01: 'Nyala Sang Penjaga',       // Barong Agni — Sacred Flame of the Guardian
  MYT04: 'Pasang Tanpa Dasar',       // Naga Baruna — Tide of the Endless Deep
  MYT05: 'Napas Badai Pertama',      // Sang Hyang Bayu — Breath of the First Storm
  MYT02: 'Langit Terbelah',          // Sang Hyang Petir — Fury of the Splitting Sky
  MYT03: 'Gerhana Menelan Langit',   // Kala Rau — The Eclipse Devourer
  MYT06: 'Balung Wesi',              // Gatotkaca — Sinews of Wire, Bones of Iron
  MYT07: 'Panen Emas',               // Dewi Sri — Mother of the Golden Harvest
  MYT08: 'Lilitan Dasar Bumi'        // Antaboga — The Serpent That Holds the World
};

// Urutan giliran banner. Ditulis eksplisit, bukan diambil dari urutan KARTU:
// menyisipkan kartu Mythic baru ke katalog tidak boleh diam-diam mengacak
// jadwal banner yang sedang berjalan.
//
// Urutannya juga bukan sembarang: TIDAK ADA dua banner berurutan yang
// Mythic-nya seelemen (termasuk saat memutar balik dari yang terakhir ke yang
// pertama). Dua banner Petir berturut-turut akan terasa seperti banner yang
// sama diulang, padahal kartunya beda.
const GILIRAN = [
  'MYT03', // Kala Rau        DARK
  'MYT01', // Barong Agni     API
  'MYT06', // Gatotkaca       PETIR
  'MYT07', // Dewi Sri        ANGIN
  'MYT04', // Naga Baruna     AIR
  'MYT08', // Antaboga        DARK
  'MYT02', // Sang Hyang Petir PETIR
  'MYT05'  // Sang Hyang Bayu ANGIN
];

function acak(a, b) {
  let h = (Math.imul(a, 2654435761) + Math.imul(b, 40503)) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Nomor periode 14 harian sejak epoch. Satu angka ini menentukan seluruh banner. */
export function periodeBanner(tanggal) {
  const ms = Date.parse(`${tanggal}T00:00:00Z`);
  if (!Number.isFinite(ms)) return 0;
  return Math.floor(ms / 86400000 / BANNER_HARI);
}

function tanggalDariHari(hari) {
  return new Date(hari * 86400000).toISOString().slice(0, 10);
}

/**
 * Banner yang sedang tayang pada sebuah tanggal (YYYY-MM-DD, WIB).
 *
 * Dua Legendary unggulan dipilih dengan aturan, bukan diundi bebas: satu
 * SEELEMEN dengan Mythic-nya dan satu BEDA elemen. Yang seelemen membuat banner
 * punya tema yang terbaca, yang beda elemen mencegah banner jadi jebakan bagi
 * pemain yang kebetulan lemah di elemen itu.
 */
/**
 * Dua Legendary unggulan untuk satu periode.
 *
 * Aturannya: satu SEELEMEN dengan Mythic-nya (supaya banner punya tema yang
 * terbaca) dan satu BEDA elemen (supaya banner tidak jadi jebakan bagi pemain
 * yang kebetulan lemah di elemen itu).
 *
 * `terlarang` berisi kartu yang tayang di banner sebelumnya.
 */
function pilihLegendary(p, mythic, terlarang = []) {
  const legend = KARTU.filter(k => k.rarity === 'LEGENDARY');
  const larang = new Set(terlarang.map(k => k.id));
  // Kalau larangan menghabiskan kolam, larangan MENGALAH. Banner tanpa kartu
  // unggulan jauh lebih buruk daripada banner yang mengulang satu kartu.
  const bebas = (daftar) => (daftar.filter(k => !larang.has(k.id)).length
    ? daftar.filter(k => !larang.has(k.id))
    : daftar);

  const pilih = [];
  const seelemen = bebas(legend.filter(k => k.elemen === mythic.elemen));
  if (seelemen.length) pilih.push(seelemen[((p % seelemen.length) + seelemen.length) % seelemen.length]);

  // Kartu kedua diambil dengan berjalan atas urutan Legendary yang UTUH dan
  // tetap, bukan atas kolam yang sudah disaring.
  //
  // Percobaan sebelumnya memberi indeks ke kolam hasil saringan, dan kolam itu
  // berubah isi tiap periode karena elemen yang dibuang ikut berubah. Akibatnya
  // indeks yang sama menunjuk kartu yang berbeda, dan polanya menumpuk: Naga
  // Krakatau tayang di 4 dari 8 banner pertama, sementara satu kartu lain cuma
  // 2 kali dalam tiga tahun. Berjalan di urutan yang tetap membuat langkah 3
  // benar-benar berarti 'geser tiga kartu', jadi kesepuluhnya terlewati sebelum
  // ada yang terulang.
  const urut = legend;
  const mulai = ((p * 3) % urut.length + urut.length) % urut.length;
  for (let langkah = 0; langkah < urut.length; langkah++) {
    const k = urut[(mulai + langkah) % urut.length];
    if (k.elemen === mythic.elemen) continue;
    if (larang.has(k.id)) continue;
    if (pilih.some(x => x.id === k.id)) continue;
    pilih.push(k);
    break;
  }

  while (pilih.length < 2 && pilih.length < legend.length) {
    const sisa = legend.filter(k => !pilih.some(x => x.id === k.id));
    pilih.push(sisa[acak(p, 307 + pilih.length) % sisa.length]);
  }
  return pilih;
}

function mythicPeriode(p) {
  const n = GILIRAN.length;
  return getKartu(GILIRAN[((p % n) + n) % n]);
}

/**
 * Panjang siklus jadwal. Kelipatan dari jumlah Mythic (8) supaya siklusnya
 * selalu berakhir tepat di ujung putaran Mythic, dan cukup panjang supaya
 * kesepuluh Legendary sempat tayang berkali-kali.
 */
const SIKLUS = GILIRAN.length * 5;

/**
 * Seluruh jadwal satu siklus, dihitung SEKALI saat modul dimuat.
 *
 * Ini menggantikan percobaan sebelumnya yang melarang kartu banner sebelumnya
 * dengan menghitungnya ulang saat itu juga. Cara itu tidak pernah bisa tepat:
 * untuk mengetahui pilihan periode p-1 kita perlu larangannya, yang butuh p-2,
 * yang butuh p-3 — mundur tanpa ujung. Menghitung satu lapis meninggalkan 3
 * tumpang tindih dari 23 pasangan; menghitung dua lapis justru memburuk jadi 10
 * dari 59, karena regresinya makin dalam bukan makin dangkal.
 *
 * Menghitung seluruh siklus dari depan menghapus masalahnya: tiap periode
 * melihat pilihan periode sebelumnya yang SUNGGUHAN, karena pilihan itu baru
 * saja dihitung. Sambungan dari periode terakhir kembali ke periode pertama
 * ikut diperiksa, jadi jadwalnya mulus juga saat siklus berulang.
 */
const JADWAL = (() => {
  const hasil = [];
  for (let i = 0; i < SIKLUS; i++) {
    const sebelumnya = i === 0 ? [] : hasil[i - 1];
    hasil.push(pilihLegendary(i, mythicPeriode(i), sebelumnya));
  }
  // Sambungan siklus: periode 0 tidak boleh berbagi kartu dengan periode
  // terakhir, kalau tidak jadwalnya tersendat sekali tiap putaran.
  const terakhir = new Set(hasil[SIKLUS - 1].map(k => k.id));
  if (hasil[0].some(k => terakhir.has(k.id))) {
    hasil[0] = pilihLegendary(0, mythicPeriode(0), hasil[SIKLUS - 1]);
  }
  return hasil;
})();

/**
 * Banner yang sedang tayang pada sebuah tanggal (YYYY-MM-DD, WIB).
 */
export function bannerAktif(tanggal) {
  const p = periodeBanner(tanggal);
  const mythic = mythicPeriode(p);
  const pilih = JADWAL[((p % SIKLUS) + SIKLUS) % SIKLUS];

  const hariMulai = p * BANNER_HARI;
  return {
    id: `B${p}`,
    nama: NAMA_BANNER[mythic.id] || mythic.nama,
    mythic,
    legendary: pilih,
    mulai: tanggalDariHari(hariMulai),
    selesai: tanggalDariHari(hariMulai + BANNER_HARI - 1)
  };
}
/** Sisa hari banner, terhitung hari ini (1 = hari terakhir). */
export function sisaHariBanner(tanggal) {
  const p = periodeBanner(tanggal);
  const ms = Date.parse(`${tanggal}T00:00:00Z`);
  const hari = Math.floor(ms / 86400000);
  return Math.max(1, (p + 1) * BANNER_HARI - hari);
}

/** Apakah kartu ini sedang rate ON di banner tersebut. */
export function rateOn(banner, cardId) {
  if (!banner) return false;
  return banner.mythic?.id === cardId || banner.legendary.some(k => k.id === cardId);
}

/**
 * Memilih kartu untuk satu tarikan, sesudah raritynya ditentukan.
 *
 * `status` adalah baris jaminan pemain di banner ini dan DIUBAH DI TEMPAT.
 * Pemanggilnya wajib menyimpannya kembali — lihat `prosesTarikan`.
 *
 * Rarity di bawah Legendary tidak punya kartu unggulan sama sekali dan diundi
 * rata seperti sebelumnya. Menaikkan rate Common tidak berarti apa-apa bagi
 * siapa pun, dan cuma akan membuat layar banner penuh angka yang tidak dibaca.
 */
export function undiKartuBanner(rarity, banner, status, daftarRarity) {
  const semua = daftarRarity(rarity);
  const rata = () => semua[Math.floor(Math.random() * semua.length)];
  if (!banner || !semua.length) return { kartu: rata(), unggulan: false, jaminanTerpakai: false };

  if (rarity === 'MYTHIC') {
    return pilihUnggulan(semua, [banner.mythic], status, 'kalah_mythic', BANNER_PELUANG_MYTHIC);
  }
  if (rarity === 'LEGENDARY') {
    return pilihUnggulan(semua, banner.legendary, status, 'kalah_legendary', BANNER_PELUANG_LEGENDARY);
  }
  return { kartu: rata(), unggulan: false, jaminanTerpakai: false };
}

function pilihUnggulan(semua, unggulan, status, kunci, peluang) {
  const daftarUnggulan = unggulan.filter(Boolean);
  const lain = semua.filter(k => !daftarUnggulan.some(u => u.id === k.id));
  const ambilUnggulan = () => daftarUnggulan[Math.floor(Math.random() * daftarUnggulan.length)];

  // Jaminan menyala: tarikan ini PASTI kartu unggulan, dan jaminannya padam.
  if (status && status[kunci]) {
    status[kunci] = 0;
    return { kartu: ambilUnggulan(), unggulan: true, jaminanTerpakai: true };
  }

  if (!lain.length || Math.random() < peluang) {
    return { kartu: ambilUnggulan(), unggulan: true, jaminanTerpakai: false };
  }

  // Kalah undian: kartu lain, tapi jaminan menyala untuk tarikan rarity ini
  // berikutnya. Ini yang membuat "apes berkali-kali berturut-turut" mustahil.
  if (status) status[kunci] = 1;
  return { kartu: lain[Math.floor(Math.random() * lain.length)], unggulan: false, jaminanTerpakai: false };
}

/** Baris ringkas kartu unggulan, dipakai layar banner dan hasil tarikan. */
export function barisUnggulan(kartu, bintang) {
  return `${ELEMEN[kartu.elemen].emoji} *${kartu.nama}* ${bintang}` +
    (kartu.gelar ? `\n     _${kartu.gelar}_` : '');
}
