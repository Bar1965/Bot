/**
 * PEMBATAS LAJU — rem untuk perintah yang dipanggil bertubi-tubi.
 *
 * Unduhan sudah punya jatah harian sendiri (mediaDailyLimit) dan itu menahan
 * PEMBOROSAN. Yang tidak tertahan olehnya adalah SEMBURAN: perintah fun dan game
 * dipanggil dua puluh kali dalam setengah menit, tiap panggilan menghasilkan satu
 * balasan, dan grupnya tidak bisa dipakai bicara lagi. Jatah harian tidak
 * menolongnya — dua puluh panggilan masih jauh di bawah batas hari itu.
 *
 * Jendela geser, bukan ember per menit. Ember yang mengosongkan diri tiap menit
 * bulat bisa ditembus dua kali lipat hanya dengan menunggu pergantian menit:
 * habiskan jatah di detik ke-59, habiskan lagi di detik ke-61. Jendela geser
 * menghitung mundur dari sekarang, jadi celah itu tidak ada.
 *
 * Disimpan di memori dengan sengaja. Ini penahan keramaian sesaat; kalau bot
 * restart, semburan yang sedang berlangsung memang sudah berhenti sendiri.
 */

/** jid -> array stempel waktu (ms), selalu terurut naik. */
const jejak = new Map();

/** Siapa yang sudah diperingatkan, supaya peringatannya tidak jadi spam baru. */
const sudahDiperingatkan = new Map();

const JENDELA_MS = 60 * 1000;

/** Buang jejak yang sudah di luar jendela supaya Map tidak tumbuh selamanya. */
function bersihkan(sekarang) {
  for (const [jid, stempel] of jejak) {
    const hidup = stempel.filter(t => sekarang - t < JENDELA_MS);
    if (hidup.length === 0) jejak.delete(jid);
    else jejak.set(jid, hidup);
  }
  for (const [jid, t] of sudahDiperingatkan) {
    if (sekarang - t > JENDELA_MS) sudahDiperingatkan.delete(jid);
  }
}

let terakhirDibersihkan = 0;

/**
 * Catat satu pemakaian dan putuskan boleh atau tidak.
 *
 * Mengembalikan:
 *   { boleh: true,  sisa }                      — lanjutkan
 *   { boleh: false, tungguDetik, perluBeriTahu } — hentikan
 *
 * `perluBeriTahu` hanya true pada penolakan PERTAMA dalam satu jendela. Membalas
 * setiap perintah yang ditolak membuat rem ini sendiri jadi sumber keramaian —
 * persis yang sedang dicegah.
 */
export function periksaLaju(jid, batasPerMenit, sekarang = Date.now()) {
  if (!jid) return { boleh: true, sisa: Infinity };

  const batas = Number(batasPerMenit);
  if (!Number.isFinite(batas) || batas <= 0) return { boleh: true, sisa: Infinity };

  if (sekarang - terakhirDibersihkan > JENDELA_MS) {
    bersihkan(sekarang);
    terakhirDibersihkan = sekarang;
  }

  // Rumus jendelanya cuma satu di berkas ini — dipakai bersama rem unduhan
  // per jam, supaya tidak pernah ada dua cara menghitung "sudah berapa".
  const putusan = putusanJendela(jejak.get(jid), batas, JENDELA_MS, sekarang);
  const stempel = putusan.hidup;

  if (!putusan.boleh) {
    jejak.set(jid, stempel);
    const perluBeriTahu = !sudahDiperingatkan.has(jid);
    if (perluBeriTahu) sudahDiperingatkan.set(jid, sekarang);
    return { boleh: false, tungguDetik: putusan.tungguDetik, perluBeriTahu, dipakai: putusan.dipakai, batas };
  }

  stempel.push(sekarang);
  jejak.set(jid, stempel);
  sudahDiperingatkan.delete(jid);
  return { boleh: true, sisa: batas - stempel.length, dipakai: stempel.length, batas };
}

/**
 * Putusan jendela geser yang MURNI — tanpa memori, tanpa database.
 *
 * Dipisah karena rem unduhan per jam tidak boleh tinggal di memori: bot ini
 * kadang dinyalakan ulang, dan jatah yang hangus tiap restart bukan jatah.
 * Stempel waktunya disimpan di tabel `media_hourly_logs`, tapi hitung-hitungan
 * "sudah berapa, tunggu berapa lama lagi" tetap satu tempat dengan yang di atas
 * supaya tidak ada dua rumus jendela yang berbeda di bot ini.
 *
 * `stempel` boleh datang tidak terurut dan boleh berisi yang sudah kedaluwarsa.
 */
export function putusanJendela(stempel, batas, jendelaMs, sekarang = Date.now()) {
  const n = Number(batas);
  const lebar = Number(jendelaMs);
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(lebar) || lebar <= 0) {
    return { boleh: true, dipakai: 0, batas: Infinity, sisa: Infinity, tungguDetik: 0, hidup: [] };
  }

  const hidup = (Array.isArray(stempel) ? stempel : [])
    .map(Number)
    .filter(t => Number.isFinite(t) && sekarang - t < lebar)
    .sort((a, b) => a - b);

  if (hidup.length >= n) {
    const tertua = hidup[0];
    const tungguDetik = Math.max(1, Math.ceil((lebar - (sekarang - tertua)) / 1000));
    return { boleh: false, dipakai: hidup.length, batas: n, sisa: 0, tungguDetik, hidup };
  }
  return { boleh: true, dipakai: hidup.length, batas: n, sisa: n - hidup.length, tungguDetik: 0, hidup };
}

/**
 * "2340 detik" tidak berarti apa-apa buat orang yang membacanya di WhatsApp.
 * Jendela sejam bisa menghasilkan tunggu sampai satu jam penuh, jadi angkanya
 * harus diucapkan seperti orang bicara.
 */
export function formatTunggu(detik) {
  const d = Math.max(0, Math.ceil(Number(detik) || 0));
  if (d < 60) return `${d} detik`;
  const menit = Math.ceil(d / 60);
  if (menit < 60) return `${menit} menit`;
  const jam = Math.floor(menit / 60);
  const sisaMenit = menit % 60;
  return sisaMenit === 0 ? `${jam} jam` : `${jam} jam ${sisaMenit} menit`;
}

/** Hanya untuk uji. */
export function kosongkanJejak() {
  jejak.clear();
  sudahDiperingatkan.clear();
  terakhirDibersihkan = 0;
}

/** Untuk layar diagnosa owner. */
export function statistikLaju() {
  return { dipantau: jejak.size, diperingatkan: sudahDiperingatkan.size };
}
