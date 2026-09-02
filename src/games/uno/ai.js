/**
 * 🤖 UNO AI — PEMILIH KARTU
 *
 * Mengikuti konvensi bot yang sudah dipakai poker: JID bot selalu berakhiran
 * `@ai`. Itu bukan kosmetik — `recoverAndRefundStaleGameSessions` di gamesDb.js
 * melewati pemain ber-akhiran `@ai` saat refund, dan seluruh jalur poin di sini
 * juga memeriksanya. Bot tidak boleh punya saldo.
 *
 * Keputusannya murni (tidak menyentuh sesi, socket, atau database) supaya bisa
 * diuji langsung oleh smoke test.
 */

import {
  KODE_WARNA, isLiar, isAngka, AKSI_BERWARNA,
  kartuLegalDi, warnaTerbanyak
} from './kartu.js';

export const BOT_UNO = [
  { id: 'uno_bagas@ai', nama: '🤖 Bagas', gaya: 'Rapi. Menahan kartu liar sampai benar-benar butuh.' },
  { id: 'uno_cinta@ai', nama: '🤖 Cinta', gaya: 'Galak. Suka menimpuk +2 begitu lawan tinggal sedikit.' },
  { id: 'uno_dimas@ai', nama: '🤖 Dimas', gaya: 'Pengontrol warna. Berusaha menjaga warna favoritnya tetap aktif.' },
  { id: 'uno_elang@ai', nama: '🤖 Elang', gaya: 'Cepat habis. Selalu membuang kartu bernilai besar duluan.' },
  { id: 'uno_fitri@ai', nama: '🤖 Fitri', gaya: 'Santai. Main aman, jarang menyerang.' }
];

export function isBotUno(jid) {
  return String(jid || '').endsWith('@ai');
}

export function namaBot(jid) {
  return BOT_UNO.find(b => b.id === jid)?.nama || '🤖 Bot';
}

/** Jeda "berpikir" supaya bot tidak menjawab secepat kilat dan terasa palsu. */
export function waktuBerpikir(acak = Math.random) {
  return 1200 + Math.floor(acak() * 1600); // 1,2 - 2,8 detik
}

/**
 * Skor pemilihan kartu. Makin tinggi makin ingin dimainkan.
 *
 * Prinsipnya tiga:
 * 1. Kalau lawan berikutnya hampir habis, kartu serang (+2 / +4 / Skip) naik drastis.
 * 2. Kartu liar disimpan untuk keadaan terjepit — nilainya paling rendah kalau
 *    masih ada kartu biasa yang legal.
 * 3. Sisanya buang yang bernilai besar dulu, dan utamakan warna yang paling
 *    banyak dipegang supaya bot tidak kehilangan kendali warna.
 */
function skorKartu(kartu, konteks) {
  const { kartuLawanBerikut, warnaDominan } = konteks;
  const lawanKritis = kartuLawanBerikut <= 2;

  if (kartu.simbol === 'W4') return lawanKritis ? 95 : 5;
  if (kartu.simbol === 'W') return lawanKritis ? 60 : 8;

  let skor = 30;
  if (kartu.simbol === 'D2') skor = lawanKritis ? 90 : 55;
  else if (kartu.simbol === 'S') skor = lawanKritis ? 80 : 50;
  else if (kartu.simbol === 'R') skor = lawanKritis ? 70 : 45;
  else skor = 30 + (parseInt(kartu.simbol, 10) || 0); // buang angka besar dulu

  // Menjaga kendali warna: main di warna yang stoknya paling banyak.
  if (kartu.warna === warnaDominan) skor += 6;
  return skor;
}

/**
 * @returns {{aksi:'main'|'tarik', kartu?:object, indeks?:number, warna?:string}}
 */
export function putuskanLangkahBot(tangan, atas, warnaAktif, konteks = {}) {
  // Aturan penumpukan (opsional) mengunci pilihan: saat ada +2/+4 menumpuk di
  // meja, satu-satunya langkah sah adalah menimpanya dengan kartu sejenis.
  // Bot menimpa kalau bisa, dan menyerah menarik kalau tidak — persis sama
  // seperti pemain manusia.
  const legal = konteks.tumpukJenis
    ? (tangan || []).filter(k => k.simbol === konteks.tumpukJenis)
    : kartuLegalDi(tangan, atas, warnaAktif);

  if (legal.length === 0) return { aksi: 'tarik' };

  const info = {
    kartuLawanBerikut: konteks.kartuLawanBerikut ?? 7,
    warnaDominan: warnaTerbanyak(tangan, warnaAktif)
  };

  let pilihan = legal[0];
  let terbaik = -Infinity;
  for (const k of legal) {
    const s = skorKartu(k, info);
    if (s > terbaik) { terbaik = s; pilihan = k; }
  }

  const indeks = tangan.indexOf(pilihan);
  const hasil = { aksi: 'main', kartu: pilihan, indeks };

  if (isLiar(pilihan)) {
    // Warna dipilih dari sisa tangan SETELAH kartu liar itu dibuang, kalau
    // tidak bot bisa memilih warna yang cuma diwakili kartu liar itu sendiri.
    const sisa = tangan.filter((_, i) => i !== indeks);
    hasil.warna = pilihWarnaBot(sisa, warnaAktif);
  }

  return hasil;
}

/** Warna terbaik untuk kartu liar: yang paling banyak dipegang, seri → yang ada aksinya. */
export function pilihWarnaBot(sisaTangan, cadangan = 'M') {
  const hitung = { M: 0, K: 0, H: 0, B: 0 };
  const punyaAksi = { M: false, K: false, H: false, B: false };

  for (const k of sisaTangan || []) {
    if (!k.warna || hitung[k.warna] === undefined) continue;
    hitung[k.warna]++;
    if (AKSI_BERWARNA.includes(k.simbol)) punyaAksi[k.warna] = true;
  }

  let pilihan = null;
  let skor = -1;
  for (const w of KODE_WARNA) {
    const s = hitung[w] * 10 + (punyaAksi[w] ? 3 : 0);
    if (s > skor) { skor = s; pilihan = w; }
  }

  // Tangan sisa cuma kartu liar → tidak ada dasar memilih, pakai warna aktif.
  return skor > 0 ? pilihan : (cadangan || warnaTerbanyak(sisaTangan, 'M'));
}

/**
 * Dipakai juga oleh auto-main saat waktu giliran pemain manusia habis, supaya
 * pemain yang AFK tidak dihukum dengan langkah asal-asalan.
 */
export function langkahOtomatis(tangan, atas, warnaAktif, konteks = {}) {
  return putuskanLangkahBot(tangan, atas, warnaAktif, konteks);
}

export { isAngka };
