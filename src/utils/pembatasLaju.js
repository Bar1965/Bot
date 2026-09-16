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

  const stempel = (jejak.get(jid) || []).filter(t => sekarang - t < JENDELA_MS);

  if (stempel.length >= batas) {
    jejak.set(jid, stempel);
    const tertua = stempel[0];
    const tungguDetik = Math.max(1, Math.ceil((JENDELA_MS - (sekarang - tertua)) / 1000));
    const perluBeriTahu = !sudahDiperingatkan.has(jid);
    if (perluBeriTahu) sudahDiperingatkan.set(jid, sekarang);
    return { boleh: false, tungguDetik, perluBeriTahu, dipakai: stempel.length, batas };
  }

  stempel.push(sekarang);
  jejak.set(jid, stempel);
  sudahDiperingatkan.delete(jid);
  return { boleh: true, sisa: batas - stempel.length, dipakai: stempel.length, batas };
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
