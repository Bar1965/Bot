/**
 * SIARAN STOK & HARGA — pengumuman otomatis ke grup pengumuman.
 *
 * Owner memutuskan: "pokoknya setiap ada perubahan ada pengumuman." Mode bawaan
 * karena itu SEMUA — restok berapa pun, harga naik maupun turun, produk baru,
 * stok menipis, stok habis.
 *
 * Mode PENTING masih ada dan berisi pertimbangan yang saya ajukan sebelumnya:
 * restok 20→25 bukan kabar, mengumumkan kenaikan harga mendorong orang belanja di
 * tempat lain, dan mengumumkan stok habis adalah iklan negatif. Owner menimbang
 * itu lalu memilih sebaliknya — tokonya, keputusannya. `.siaran penting`
 * mengembalikan penyaringannya kapan pun dia berubah pikiran.
 *
 * DUA HAL YANG TETAP BERLAKU DI KEDUA MODE, karena keduanya bukan soal perubahan
 * mana yang layak diumumkan:
 *
 *   1. JEDA HENING. Satu sesi kerja biasanya beberapa perintah berturut-turut;
 *      tanpa jeda, grup menerima sepuluh pesan dalam dua menit. Justru di mode
 *      SEMUA inilah jeda itu paling menentukan — semuanya digabung jadi SATU
 *      pesan. Perubahannya tetap diumumkan semua, cuma tidak satu per satu.
 *
 *   2. PERINGATAN "TINGGAL SEDIKIT" TIDAK DIULANG sampai produknya direstok.
 *      Ini bukan menahan perubahan, melainkan menahan FAKTA YANG SAMA berbunyi
 *      berkali-kali: produk sisa 3 akan mengumumkan dirinya tiga kali sebelum
 *      habis, dengan kalimat yang nyaris sama persis.
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

/**
 * Mode siaran.
 *
 *   SEMUA   — setiap perubahan diumumkan: restok berapa pun, harga naik maupun
 *             turun, stok habis. Ini yang diminta owner secara tegas.
 *   PENTING — hanya yang layak jadi kabar: restok dari stok menipis, harga
 *             turun, produk baru, stok tinggal sedikit.
 *
 * Yang TIDAK berubah di mode mana pun: jeda hening. Justru di mode SEMUA jeda
 * itu yang menahan satu sesi kerja jadi satu pesan, bukan sepuluh.
 */
const MODE_BAWAAN = 'SEMUA';

let sockRef = null;
let timer = null;
let jedaDetik = JEDA_BAWAAN_DETIK;
let ambangTipis = AMBANG_BAWAAN;
let modeSiaran = MODE_BAWAAN;

const semuaPerubahan = () => modeSiaran === 'SEMUA';

/** Antrean per kode produk, supaya `.addstock` dua kali tidak jadi dua baris. */
const antreanRestok = new Map();
const antreanTurunHarga = new Map();
const antreanProdukBaru = new Map();
const antreanMenipis = new Map();
const antreanSorotan = new Map();
const antreanHabis = new Map();

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

/** 'SEMUA' (setiap perubahan) atau 'PENTING' (hanya yang layak jadi kabar). */
export function pasangModeSiaran(mode) {
  const m = String(mode || '').toUpperCase();
  if (m === 'SEMUA' || m === 'PENTING') modeSiaran = m;
}

export function modeSekarang() {
  return modeSiaran;
}

// ============================================================
// PENYUSUN PESAN — murni teks, tidak menyentuh apa pun
// ============================================================

/**
 * Pengumuman gabungan. Memulangkan null kalau tidak ada yang layak diumumkan,
 * supaya pemanggil tidak pernah mengirim pesan kosong ke grup.
 */
export function susunSiaran({ restok = [], turunHarga = [], produkBaru = [], menipis = [], sorotan = [], habis = [] } = {}) {
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

  // Satu antrean harga, dua bagian. Turun dijual sebagai penghematan; naik
  // disampaikan apa adanya tanpa basa-basi — memoles kenaikan justru bikin
  // pembaca merasa dibohongi, dan itu ongkos yang jauh lebih mahal.
  const hargaTurun = turunHarga.filter(p => Number(p.hargaBaru) < Number(p.hargaLama));
  const hargaNaik = turunHarga.filter(p => Number(p.hargaBaru) > Number(p.hargaLama));

  if (hargaTurun.length > 0) {
    let t = `🏷️ *TURUN HARGA*\n━━━━━━━━━━━━━━━\n`;
    for (const p of hargaTurun) {
      const hemat = Math.max(0, p.hargaLama - p.hargaBaru);
      const persen = p.hargaLama > 0 ? Math.round((hemat / p.hargaLama) * 100) : 0;
      t += `🔻 *${p.nama}* \`${p.kode}\`\n`;
      t += `   ~${rupiah(p.hargaLama)}~ → *${rupiah(p.hargaBaru)}*`;
      t += hemat > 0 ? ` _(hemat ${rupiah(hemat)}${persen > 0 ? ` · ${persen}%` : ''})_\n` : `\n`;
    }
    bagian.push(t.trimEnd());
  }

  if (hargaNaik.length > 0) {
    let t = `📈 *PENYESUAIAN HARGA*\n━━━━━━━━━━━━━━━\n`;
    for (const p of hargaNaik) {
      t += `🔺 *${p.nama}* \`${p.kode}\`\n`;
      t += `   ${rupiah(p.hargaLama)} → *${rupiah(p.hargaBaru)}*\n`;
    }
    t += `_Harga baru berlaku mulai sekarang._`;
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

  if (habis.length > 0) {
    // Owner minta setiap perubahan diumumkan, termasuk yang ini. Bentuknya
    // dibuat sebagai AJAKAN, bukan pengumuman kekalahan: yang membaca diberi
    // satu hal untuk dilakukan, dan antrean `.notif` itu justru daftar orang
    // yang paling mungkin membeli begitu barangnya datang.
    let t = `🔴 *SEMENTARA KOSONG*\n━━━━━━━━━━━━━━━\n`;
    for (const p of habis) {
      t += `⚫ *${p.nama}* \`${p.kode}\`\n`;
    }
    t += `_Ketik_ \`.notif <KODE>\` _— kami japri begitu restok, sebelum diumumkan di sini._`;
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
    menipis: antreanMenipis, sorotan: antreanSorotan, habis: antreanHabis
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
  // Mode SEMUA: setiap penambahan stok adalah perubahan, jadi diumumkan.
  // Mode PENTING: hanya yang tadinya di ambang menipis atau di bawah.
  if (!semuaPerubahan() && sebelum > ambangTipis) return false;
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
  // Harga yang tidak berubah bukan perubahan, mode apa pun.
  if (baru === lama) return false;
  // Mode PENTING hanya menyiarkan penurunan; mode SEMUA menyiarkan dua-duanya.
  if (!semuaPerubahan() && baru > lama) return false;

  const K = String(kode).toUpperCase();
  // Kalau harga berubah dua kali sebelum terkirim, yang diumumkan adalah harga
  // AWAL sebelum sesi ini dibanding harga terakhir — bukan langkah terakhirnya
  // saja, yang akan membuat perubahannya terlihat jauh lebih kecil dari
  // kenyataan. Kalau ternyata kembali ke harga semula, barisnya dicabut: tidak
  // ada perubahan yang perlu dikabarkan.
  const sudahAda = antreanTurunHarga.get(K);
  const asli = sudahAda ? sudahAda.hargaLama : lama;
  if (asli === baru) {
    antreanTurunHarga.delete(K);
    return false;
  }

  antreanTurunHarga.set(K, { kode: K, nama, hargaLama: asli, hargaBaru: baru });
  jadwalkanKirim();
  return true;
}

/** Nama yang jujur untuk fungsi yang sekarang menangani dua arah. */
export const antrekanPerubahanHarga = antrekanTurunHarga;

/**
 * Stok habis. Hanya di mode SEMUA — owner minta setiap perubahan diumumkan.
 *
 * Bentuknya dibuat sebagai AJAKAN, bukan kabar kekalahan: pembaca diberi satu
 * hal untuk dilakukan (`.notif <KODE>`), dan antrean itu justru daftar orang
 * yang paling mungkin membeli begitu barangnya datang.
 */
export function antrekanStokHabis({ kode, nama }) {
  if (!kode || !nama) return false;
  if (!semuaPerubahan()) return false;

  const K = String(kode).toUpperCase();
  // Baru saja direstok atau baru dibuat — jangan mengaku habis di pesan yang sama.
  if (antreanRestok.has(K) || antreanProdukBaru.has(K)) return false;

  lepaskanDariAntreanLain(K, 'habis');
  antreanHabis.set(K, { kode: K, nama });
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
  const habis = [...antreanHabis.values()];
  const jumlah = restok.length + turunHarga.length + produkBaru.length + menipis.length + sorotan.length + habis.length;
  if (jumlah === 0) return { terkirim: false, alasan: 'KOSONG' };

  const kosongkan = () => {
    antreanRestok.clear();
    antreanTurunHarga.clear();
    antreanProdukBaru.clear();
    antreanMenipis.clear();
    antreanSorotan.clear();
    antreanHabis.clear();
  };

  const settings = bacaSettings ? await bacaSettings() : {};
  if (String(settings?.siaranOtomatis ?? 'ON').toUpperCase() === 'OFF') {
    kosongkan();
    return { terkirim: false, alasan: 'DIMATIKAN' };
  }

  const tujuan = settings?.updateGroupId || settings?.buyerGroupId || settings?.transactionGroupId;
  if (!tujuan) return { terkirim: false, alasan: 'GRUP_BELUM_DISET' };
  if (!sockRef) return { terkirim: false, alasan: 'SOCKET_BELUM_SIAP' };

  const teks = susunSiaran({ restok, turunHarga, produkBaru, menipis, sorotan, habis });
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
  console.log(`[SIARAN] Pengumuman terkirim ke ${tujuan} (${produkBaru.length} baru, ${restok.length} restok, ${turunHarga.length} turun harga, ${menipis.length} menipis, ${sorotan.length} sorotan, ${habis.length} habis).`);
  return {
    terkirim: true, tujuan, teks,
    restok: restok.length, turunHarga: turunHarga.length,
    produkBaru: produkBaru.length, menipis: menipis.length, sorotan: sorotan.length,
    habis: habis.length
  };
}

/** Isi antrean saat ini — dipakai `.siaran` untuk melaporkan apa yang tertunda. */
export function isiAntrean() {
  return {
    restok: [...antreanRestok.values()],
    turunHarga: [...antreanTurunHarga.values()],
    produkBaru: [...antreanProdukBaru.values()],
    menipis: [...antreanMenipis.values()],
    sorotan: [...antreanSorotan.values()],
    habis: [...antreanHabis.values()]
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
  antreanHabis.clear();
  sudahDiumumkanMenipis.clear();
}
