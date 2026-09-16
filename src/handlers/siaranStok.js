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
 *   2. TIDAK menyiarkan restok yang stoknya memang masih banyak. Naik dari 20 ke
 *      25 bukan kabar; mengumumkannya cuma melatih orang untuk melewati pesan
 *      dari kanal ini — dan pengumuman yang benar-benar penting ikut terlewat.
 *      Yang diumumkan hanya yang tadinya berada di ambang menipis atau di bawah.
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

/** Ambang "hampir habis". Disamakan dengan lowStockLimit milik katalog. */
const AMBANG_BAWAAN = 3;

let sockRef = null;
let timer = null;
let jedaDetik = JEDA_BAWAAN_DETIK;
let ambangTipis = AMBANG_BAWAAN;

/** Antrean per kode produk, supaya `.addstock` dua kali tidak jadi dua baris. */
const antreanRestok = new Map();
const antreanTurunHarga = new Map();
const antreanProdukBaru = new Map();
const antreanMenipis = new Map();
const antreanSorotan = new Map();

/**
 * Kode yang peringatan menipisnya SUDAH tersiar.
 *
 * Tanpa ini, tiap penjualan berikutnya mengumumkan "tinggal sedikit" lagi —
 * produk dengan sisa 3 akan berteriak tiga kali sebelum habis. Ingatannya
 * dihapus begitu produknya direstok, jadi siklus berikutnya boleh berbunyi lagi.
 */
const sudahDiumumkanMenipis = new Set();

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

/** Ambang "hampir habis", disamakan dengan lowStockLimit. */
export function pasangAmbangTipis(n) {
  const x = Number(n);
  if (Number.isFinite(x) && x >= 0) ambangTipis = Math.floor(x);
}

// ============================================================
// PENYUSUN PESAN — murni teks, tidak menyentuh apa pun
// ============================================================

/**
 * Pengumuman gabungan. Memulangkan null kalau tidak ada yang layak diumumkan,
 * supaya pemanggil tidak pernah mengirim pesan kosong ke grup.
 */
export function susunSiaran({ restok = [], turunHarga = [], produkBaru = [], menipis = [], sorotan = [] } = {}) {
  const bagian = [];

  if (sorotan.length > 0) {
    // Pengumuman yang diketik owner sendiri lewat `.umumkan <KODE>`. Judulnya
    // netral dengan sengaja: dulu jalur ini menumpang antrean restok, sehingga
    // produk yang stoknya tidak pernah habis tetap diumumkan sebagai "STOK READY
    // KEMBALI" — kalimat yang tidak benar, di kanal yang gunanya dipercaya.
    let t = `📢 *INFO PRODUK*\n━━━━━━━━━━━━━━━\n`;
    for (const p of sorotan) {
      t += `📦 *${p.nama}* — ${rupiah(p.harga)}\n`;
      t += `   Stok siap: *${p.stok} pcs* · kode \`${p.kode}\`\n`;
      if (p.hargaLama && p.hargaLama !== p.harga) {
        t += p.hargaLama > p.harga
          ? `   _Turun dari ${rupiah(p.hargaLama)}_\n`
          : `   _Harga menyesuaikan dari ${rupiah(p.hargaLama)}_\n`;
      }
    }
    bagian.push(t.trimEnd());
  }

  if (produkBaru.length > 0) {
    let t = produkBaru.length === 1 ? `✨ *PRODUK BARU*\n` : `✨ *PRODUK BARU DI TOKO*\n`;
    t += `━━━━━━━━━━━━━━━\n`;
    for (const p of produkBaru) {
      t += `🆕 *${p.nama}* — ${rupiah(p.harga)}\n`;
      t += `   Stok siap: *${p.stok} pcs* · kode \`${p.kode}\`\n`;
    }
    bagian.push(t.trimEnd());
  }

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

  if (menipis.length > 0) {
    // "Tinggal sedikit", bukan "habis". Yang pertama mendorong orang bergerak;
    // yang kedua memberitahu mereka jangan datang. Produk yang benar-benar nol
    // tidak pernah sampai ke sini — antrekanStokMenipis menolaknya.
    let t = `⏳ *TINGGAL SEDIKIT*\n━━━━━━━━━━━━━━━\n`;
    for (const p of menipis) {
      t += `🟠 *${p.nama}* — ${rupiah(p.harga)}\n`;
      t += `   Sisa *${p.stok} pcs* · kode \`${p.kode}\`\n`;
    }
    bagian.push(t.trimEnd());
  }

  if (bagian.length === 0) return null;

  // Satu ajakan di akhir, bukan satu per produk. Tiga baris "ketik .beli" dalam
  // satu pesan terbaca sebagai iklan, bukan kabar.
  const kode = [...sorotan, ...produkBaru, ...restok, ...turunHarga, ...menipis][0]?.kode || 'KODE';
  return `${bagian.join('\n\n')}\n━━━━━━━━━━━━━━━\n🛒 Ketik \`.list\` untuk katalog, atau \`.beli ${kode} 1\` untuk pesan langsung.`;
}

// ============================================================
// ANTREAN
// ============================================================

/** Satu produk hanya boleh menempati SATU bagian dalam satu pengumuman. */
function lepaskanDariAntreanLain(kode, kecuali) {
  for (const [nama, peta] of Object.entries({
    restok: antreanRestok, produkBaru: antreanProdukBaru,
    menipis: antreanMenipis, sorotan: antreanSorotan
  })) {
    if (nama !== kecuali) peta.delete(kode);
  }
}

/**
 * Pengumuman manual `.umumkan <KODE>` — owner yang memutuskan, bukan bot.
 *
 * Satu-satunya jalur yang boleh melewati aturan otomatis: restok yang stoknya
 * tidak pernah habis, atau harga yang justru NAIK dan mau dipakai sebagai
 * dorongan ("besok naik, beli sekarang"). Keputusan dagang seperti itu memang
 * harus diketik manusia.
 *
 * Yang tetap ditolak: stok nol. Mengajak orang membeli barang yang tidak ada
 * merusak hal yang justru sedang dibangun kanal ini.
 */
export function antrekanSorotan({ kode, nama, harga, stok, hargaLama = null }) {
  if (!kode || !nama) return false;
  if (!(Number(stok) > 0)) return false;

  const K = String(kode).toUpperCase();
  lepaskanDariAntreanLain(K, 'sorotan');
  antreanSorotan.set(K, {
    kode: K, nama,
    harga: Number(harga) || 0,
    stok: Number(stok),
    hargaLama: Number(hargaLama) || null
  });
  jadwalkanKirim();
  return true;
}

/**
 * Restok DITERIMA kalau produknya tadinya sudah menipis atau habis.
 *
 * Aturan ini ditegakkan DI SINI, bukan di setiap pemanggil, supaya jalur baru
 * mana pun (dashboard, wizard, perintah yang belum ada) tidak bisa melewatinya.
 *
 * Ambangnya sama dengan ambang "hampir habis", dan itu disengaja: yang layak
 * diumumkan adalah produk yang memang sedang dinanti. Naik dari 20 ke 25 bukan
 * kabar — mengumumkannya cuma melatih orang melewati pesan dari kanal ini, dan
 * pengumuman yang benar-benar penting ikut terlewat.
 */
export function antrekanRestok({ kode, nama, harga, stokSebelum, stokSesudah }) {
  if (!kode || !nama) return false;
  const sebelum = Number(stokSebelum);
  const sesudah = Number(stokSesudah);
  if (!Number.isFinite(sebelum) || !(sesudah > 0)) return false;
  if (sebelum > ambangTipis) return false;
  if (sesudah <= sebelum) return false;

  const K = String(kode).toUpperCase();
  // Sudah direstok berarti tidak "tinggal sedikit" lagi; peringatan lamanya
  // dicabut, dan siklus menipis berikutnya boleh berbunyi lagi.
  sudahDiumumkanMenipis.delete(K);
  lepaskanDariAntreanLain(K, 'restok');

  antreanRestok.set(K, { kode: K, nama, harga: Number(harga) || 0, stok: sesudah });
  jadwalkanKirim();
  return true;
}

/** Produk yang baru dibuat. Tidak diumumkan kalau stoknya masih kosong. */
export function antrekanProdukBaru({ kode, nama, harga, stok }) {
  if (!kode || !nama) return false;
  if (!(Number(stok) > 0)) return false;

  const K = String(kode).toUpperCase();
  sudahDiumumkanMenipis.delete(K);
  lepaskanDariAntreanLain(K, 'produkBaru');

  antreanProdukBaru.set(K, { kode: K, nama, harga: Number(harga) || 0, stok: Number(stok) });
  jadwalkanKirim();
  return true;
}

/**
 * "Tinggal sedikit" — dan HANYA itu, tidak pernah "habis".
 *
 * Stok nol ditolak. Mengumumkan barang kosong ke grup pembeli adalah iklan
 * negatif: yang dibaca orang cuma "toko ini sering kosong". Owner sendiri sudah
 * dikabari lewat notifikasi penjualan.
 *
 * Sekali berbunyi, tidak berbunyi lagi sampai produknya direstok. Tanpa itu,
 * produk dengan sisa 3 akan mengumumkan dirinya tiga kali sebelum habis.
 */
export function antrekanStokMenipis({ kode, nama, harga, stok }) {
  if (!kode || !nama) return false;
  const sisa = Number(stok);
  if (!(sisa > 0 && sisa <= ambangTipis)) return false;

  const K = String(kode).toUpperCase();
  if (sudahDiumumkanMenipis.has(K)) return false;
  // Produk yang baru saja direstok atau baru dibuat tidak boleh langsung
  // diumumkan "tinggal sedikit" di pesan yang sama.
  if (antreanRestok.has(K) || antreanProdukBaru.has(K)) return false;

  sudahDiumumkanMenipis.add(K);
  antreanMenipis.set(K, { kode: K, nama, harga: Number(harga) || 0, stok: sisa });
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
  const produkBaru = [...antreanProdukBaru.values()];
  const menipis = [...antreanMenipis.values()];
  const sorotan = [...antreanSorotan.values()];
  const jumlah = restok.length + turunHarga.length + produkBaru.length + menipis.length + sorotan.length;
  if (jumlah === 0) return { terkirim: false, alasan: 'KOSONG' };

  const kosongkan = () => {
    antreanRestok.clear();
    antreanTurunHarga.clear();
    antreanProdukBaru.clear();
    antreanMenipis.clear();
    antreanSorotan.clear();
  };

  const settings = bacaSettings ? await bacaSettings() : {};
  if (String(settings?.siaranOtomatis ?? 'ON').toUpperCase() === 'OFF') {
    kosongkan();
    return { terkirim: false, alasan: 'DIMATIKAN' };
  }

  const tujuan = settings?.updateGroupId || settings?.buyerGroupId || settings?.transactionGroupId;
  if (!tujuan) return { terkirim: false, alasan: 'GRUP_BELUM_DISET' };
  if (!sockRef) return { terkirim: false, alasan: 'SOCKET_BELUM_SIAP' };

  const teks = susunSiaran({ restok, turunHarga, produkBaru, menipis, sorotan });
  if (!teks) return { terkirim: false, alasan: 'KOSONG' };

  try {
    // TEKS SAJA — tidak ada `mentions`, jadi tidak ada satu pun anggota grup
    // yang ter-tag. Owner minta tegas: pengumuman ini tidak boleh membunyikan
    // notifikasi semua orang seperti tagall. Jangan pernah menambahkan
    // `mentions` di sini; broadcastTagAll punya tempatnya sendiri.
    await sockRef.sendMessage(tujuan, { text: teks });
  } catch (err) {
    console.error('[SIARAN] Gagal mengirim pengumuman:', err.message);
    return { terkirim: false, alasan: 'GAGAL_KIRIM', pesan: err.message };
  }

  kosongkan();
  console.log(`[SIARAN] Pengumuman terkirim ke ${tujuan} (${produkBaru.length} baru, ${restok.length} restok, ${turunHarga.length} turun harga, ${menipis.length} menipis, ${sorotan.length} sorotan).`);
  return {
    terkirim: true, tujuan, teks,
    restok: restok.length, turunHarga: turunHarga.length,
    produkBaru: produkBaru.length, menipis: menipis.length, sorotan: sorotan.length
  };
}

/** Isi antrean saat ini — dipakai `.siaran` untuk melaporkan apa yang tertunda. */
export function isiAntrean() {
  return {
    restok: [...antreanRestok.values()],
    turunHarga: [...antreanTurunHarga.values()],
    produkBaru: [...antreanProdukBaru.values()],
    menipis: [...antreanMenipis.values()],
    sorotan: [...antreanSorotan.values()]
  };
}

/** Hanya untuk uji: kembalikan modul ke keadaan bersih. */
export function kosongkanAntrean() {
  if (timer) { clearTimeout(timer); timer = null; }
  antreanRestok.clear();
  antreanTurunHarga.clear();
  antreanProdukBaru.clear();
  antreanMenipis.clear();
  antreanSorotan.clear();
  sudahDiumumkanMenipis.clear();
}
