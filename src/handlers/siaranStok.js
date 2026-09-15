/**
 * SIARAN STOK & HARGA — pengumuman otomatis ke grup pengumuman.
 *
 * Owner minta: begitu selesai restok atau turun harga, grup langsung dikabari.
 * Yang TIDAK dilakukan, dan alasannya, karena ini bagian yang menentukan apakah
 * kanalnya masih dibaca orang enam bulan lagi:
 *
 *   1. TIDAK menyiarkan setiap `.addstock`. Satu sesi restok biasanya beberapa
 *      perintah berturut-turut — grup akan menerima lima pesan dalam dua menit.
 *      Karena itu ada jeda: pengumuman baru dikirim setelah beberapa menit tanpa
 *      perubahan lagi, dan semua produk dalam sesi itu digabung jadi SATU pesan.
 *
 *   2. TIDAK menyiarkan restok yang stoknya tidak pernah habis. Naik dari 20 ke
 *      25 bukan kabar; mengumumkannya cuma melatih orang untuk melewati pesan
 *      dari kanal ini — dan pengumuman yang benar-benar penting ikut terlewat.
 *      Yang diumumkan hanya yang tadinya BENAR-BENAR nol.
 *
 *   3. TIDAK menyiarkan harga NAIK. Memberi tahu semua orang bahwa harga naik
 *      sama saja menyuruh mereka belanja di tempat lain. Kalau owner memang mau
 *      memakainya sebagai dorongan ("besok naik"), itu keputusan dagang yang
 *      harus diketik sendiri lewat `.umumkan`, bukan diputuskan bot.
 *
 *   4. TIDAK menyiarkan stok HABIS ke pembeli. Itu iklan negatif. Owner sudah
 *      diberi tahu lewat notifikasi penjualan (lihat susunNotifPenjualanOwner).
 *
 * Angka stok di sini WAJIB datang dari penghitung kredensial sungguhan, bukan
 * kolom `products.stok` yang cuma cache untuk produk AUTO (AGENTS.md §10l).
 * Angka yang melenceng di layar owner masih bisa dibetulkan; angka melenceng
 * yang sudah tersiar ke grup tidak bisa ditarik kembali.
 *
 * Modul ini TIDAK mengimpor bot.js — socket-nya dititipkan lewat
 * pasangSocketSiaran, sama seperti fulfillmentWorker (AGENTS.md §16).
 */

import { rupiah } from './katalogView.js';

/** Jeda hening sebelum antrean dikirim. Owner bisa mengubah lewat settings. */
const JEDA_BAWAAN_DETIK = 180;

let sockRef = null;
let timer = null;
let jedaDetik = JEDA_BAWAAN_DETIK;

/** Antrean per kode produk, supaya `.addstock` dua kali tidak jadi dua baris. */
const antreanRestok = new Map();
const antreanTurunHarga = new Map();

/** Disuntik saat uji supaya tidak perlu database maupun socket sungguhan. */
let bacaSettings = null;

export function pasangSocketSiaran(sock) {
  sockRef = sock;
}

export function pasangPembacaSettings(fn) {
  bacaSettings = fn;
}

/** Jeda hening sebelum antrean dikirim, dalam detik. Minimal 5 supaya uji cepat. */
export function pasangJedaSiaran(detik) {
  const n = Number(detik);
  if (Number.isFinite(n) && n >= 1) jedaDetik = Math.max(1, Math.floor(n));
}

// ============================================================
// PENYUSUN PESAN — murni teks, tidak menyentuh apa pun
// ============================================================

/**
 * Pengumuman gabungan. Memulangkan null kalau tidak ada yang layak diumumkan,
 * supaya pemanggil tidak pernah mengirim pesan kosong ke grup.
 */
export function susunSiaran({ restok = [], turunHarga = [] } = {}) {
  const bagian = [];

  if (restok.length > 0) {
    let t = restok.length === 1 ? `📦 *STOK READY KEMBALI*\n` : `📦 *RESTOK HARI INI*\n`;
    t += `━━━━━━━━━━━━━━━\n`;
    for (const p of restok) {
      t += `🟢 *${p.nama}* — ${rupiah(p.harga)}\n`;
      t += `   Stok siap: *${p.stok} pcs* · kode \`${p.kode}\`\n`;
    }
    bagian.push(t.trimEnd());
  }

  if (turunHarga.length > 0) {
    let t = `🏷️ *TURUN HARGA*\n━━━━━━━━━━━━━━━\n`;
    for (const p of turunHarga) {
      const hemat = Math.max(0, p.hargaLama - p.hargaBaru);
      const persen = p.hargaLama > 0 ? Math.round((hemat / p.hargaLama) * 100) : 0;
      t += `🔻 *${p.nama}* \`${p.kode}\`\n`;
      t += `   ~${rupiah(p.hargaLama)}~ → *${rupiah(p.hargaBaru)}*`;
      t += hemat > 0 ? ` _(hemat ${rupiah(hemat)}${persen > 0 ? ` · ${persen}%` : ''})_\n` : `\n`;
    }
    bagian.push(t.trimEnd());
  }

  if (bagian.length === 0) return null;

  // Satu ajakan di akhir, bukan satu per produk. Tiga baris "ketik .beli" dalam
  // satu pesan terbaca sebagai iklan, bukan kabar.
  const kode = [...restok, ...turunHarga][0]?.kode || 'KODE';
  return `${bagian.join('\n\n')}\n━━━━━━━━━━━━━━━\n🛒 Ketik \`.list\` untuk katalog, atau \`.beli ${kode} 1\` untuk pesan langsung.`;
}

// ============================================================
// ANTREAN
// ============================================================

/**
 * Restok DITERIMA hanya kalau produknya tadinya benar-benar kosong. Aturan itu
 * ditegakkan DI SINI, bukan di setiap pemanggil, supaya jalur baru mana pun
 * (dashboard, wizard, perintah yang belum ada) tidak bisa melewatinya.
 */
export function antrekanRestok({ kode, nama, harga, stokSebelum, stokSesudah }) {
  if (!kode || !nama) return false;
  if (!(Number(stokSebelum) === 0 && Number(stokSesudah) > 0)) return false;

  antreanRestok.set(String(kode).toUpperCase(), {
    kode: String(kode).toUpperCase(),
    nama,
    harga: Number(harga) || 0,
    stok: Number(stokSesudah)
  });
  jadwalkanKirim();
  return true;
}

/** Hanya penurunan. Kenaikan harga sengaja tidak pernah masuk antrean. */
export function antrekanTurunHarga({ kode, nama, hargaLama, hargaBaru }) {
  if (!kode || !nama) return false;
  const lama = Number(hargaLama);
  const baru = Number(hargaBaru);
  if (!Number.isFinite(lama) || !Number.isFinite(baru)) return false;
  if (!(baru < lama)) return false;

  const K = String(kode).toUpperCase();
  // Kalau harga turun dua kali sebelum terkirim, yang diumumkan adalah harga
  // AWAL sebelum sesi ini dibanding harga terakhir — bukan potongan terakhirnya
  // saja, yang akan membuat diskonnya terlihat jauh lebih kecil dari kenyataan.
  const sudahAda = antreanTurunHarga.get(K);
  antreanTurunHarga.set(K, {
    kode: K,
    nama,
    hargaLama: sudahAda ? sudahAda.hargaLama : lama,
    hargaBaru: baru
  });
  jadwalkanKirim();
  return true;
}

function jadwalkanKirim() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { kirimSekarang().catch(() => {}); }, jedaDetik * 1000);
  // Jangan menahan proses tetap hidup hanya demi pengumuman.
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Kirim apa pun yang sedang mengantre, lalu kosongkan antrean.
 *
 * Antrean dikosongkan SETELAH pengiriman berhasil. Kalau WhatsApp sedang putus,
 * isinya dipertahankan dan dicoba lagi pada perubahan berikutnya — sama seperti
 * antrean langganan notifikasi, yang dulu kehilangan seluruh isinya saat bot
 * kebetulan sedang offline.
 */
export async function kirimSekarang() {
  if (timer) { clearTimeout(timer); timer = null; }

  const restok = [...antreanRestok.values()];
  const turunHarga = [...antreanTurunHarga.values()];
  if (restok.length === 0 && turunHarga.length === 0) return { terkirim: false, alasan: 'KOSONG' };

  const settings = bacaSettings ? await bacaSettings() : {};
  if (String(settings?.siaranOtomatis ?? 'ON').toUpperCase() === 'OFF') {
    antreanRestok.clear();
    antreanTurunHarga.clear();
    return { terkirim: false, alasan: 'DIMATIKAN' };
  }

  const tujuan = settings?.updateGroupId || settings?.buyerGroupId || settings?.transactionGroupId;
  if (!tujuan) return { terkirim: false, alasan: 'GRUP_BELUM_DISET' };
  if (!sockRef) return { terkirim: false, alasan: 'SOCKET_BELUM_SIAP' };

  const teks = susunSiaran({ restok, turunHarga });
  if (!teks) return { terkirim: false, alasan: 'KOSONG' };

  try {
    await sockRef.sendMessage(tujuan, { text: teks });
  } catch (err) {
    console.error('[SIARAN] Gagal mengirim pengumuman:', err.message);
    return { terkirim: false, alasan: 'GAGAL_KIRIM', pesan: err.message };
  }

  antreanRestok.clear();
  antreanTurunHarga.clear();
  console.log(`[SIARAN] Pengumuman terkirim ke ${tujuan} (${restok.length} restok, ${turunHarga.length} turun harga).`);
  return { terkirim: true, tujuan, restok: restok.length, turunHarga: turunHarga.length, teks };
}

/** Isi antrean saat ini — dipakai `.siaran` untuk melaporkan apa yang tertunda. */
export function isiAntrean() {
  return {
    restok: [...antreanRestok.values()],
    turunHarga: [...antreanTurunHarga.values()]
  };
}

/** Hanya untuk uji: kembalikan modul ke keadaan bersih. */
export function kosongkanAntrean() {
  if (timer) { clearTimeout(timer); timer = null; }
  antreanRestok.clear();
  antreanTurunHarga.clear();
}
