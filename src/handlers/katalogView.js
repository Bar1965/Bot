/**
 * TAMPILAN KATALOG TOKO — PENYUSUN TEKS MURNI
 *
 * Berkas ini hanya menyusun teks dan daftar nomor. Ia TIDAK menyentuh database,
 * socket WhatsApp, atau keranjang. Semua yang butuh data sudah disiapkan oleh
 * pemanggilnya di customerHandler.js. Karena itu seluruh isinya bisa diuji
 * tanpa sesi WhatsApp — lihat scripts/katalogSmokeTest.mjs.
 *
 * Alur yang dilayani hanya dua layar, dan keduanya dinomori:
 *
 *   .list  ->  layar KATALOG   : satu baris per merek
 *   balas angka  ->  layar PRODUK : deskripsi + semua jenis/paket merek itu
 *   balas angka lagi  ->  masuk keranjang
 *
 * ── Kenapa nomornya menyimpan KODE, bukan nama merek ────────────────────────
 *
 * Versi lama menyimpan nama merek di sesi navigasi, lalu saat pelanggan membalas
 * angka ia MENCARI ULANG merek itu dengan LIKE '%merek%'. Artinya nomor yang
 * ditekan pelanggan tidak terikat pada barang yang baru saja ditampilkan: hasil
 * pencariannya bisa berbeda dari daftar yang tadi tampil, dan pada toko yang
 * punya merek bernama mirip ("OFFICE" juga cocok dengan "LIBREOFFICE") pelanggan
 * bisa membuka — lalu membeli — barang yang bukan nomor itu.
 *
 * Di sini setiap nomor membawa daftar KODE PRODUK persis yang barusan tampil.
 * Menekan angka berarti mengambil kode di indeks itu, bukan mencari ulang. Kalau
 * produknya keburu dihapus owner, kodenya tidak ketemu dan pelanggan diberi tahu
 * — bukan diam-diam digeser ke produk tetangganya.
 */

const MAKS_DESKRIPSI = 400;
const MAKS_PETUNJUK = 420;
const MAKS_ENTRI_KATALOG = 40;

/** Rp1.234.567 — satu-satunya tempat format rupiah katalog ditulis. */
export function rupiah(nilai) {
  const angka = Number(nilai);
  if (!Number.isFinite(angka)) return 'Rp0';
  return 'Rp' + Math.round(angka).toLocaleString('id-ID');
}

/**
 * Lencana stok. SATU fungsi dipakai layar katalog, layar produk, dan hasil
 * pencarian — dulu ketiganya punya aturan sendiri, sehingga produk yang sama
 * bisa tertulis "Ready" di satu layar dan "Sisa 2" di layar berikutnya.
 */
export function badgeStok(stok, batasTipis = 3) {
  const jumlah = Number.isFinite(Number(stok)) ? Math.max(0, Math.trunc(Number(stok))) : 0;
  const batas = Number.isFinite(Number(batasTipis)) ? Number(batasTipis) : 3;

  if (jumlah <= 0) return { ada: false, tipis: false, jumlah: 0, teks: '🔴 habis' };
  if (jumlah <= batas) return { ada: true, tipis: true, jumlah, teks: `🟡 sisa ${jumlah}` };
  return { ada: true, tipis: false, jumlah, teks: `🟢 ready ${jumlah}` };
}

/** "Rp30.000" bila seragam, "Rp30.000–Rp90.000" bila ada rentang. */
export function labelHarga(min, max) {
  if (!Number.isFinite(Number(min))) return rupiah(0);
  if (!Number.isFinite(Number(max)) || Number(max) === Number(min)) return rupiah(min);
  return `${rupiah(min)}–${rupiah(max)}`;
}

/** Potong teks panjang di batas kata terdekat, bukan di tengah kata. */
export function potong(teks, maks) {
  const bersih = String(teks || '').trim().replace(/\s+\n/g, '\n');
  if (bersih.length <= maks) return bersih;
  const potongan = bersih.slice(0, maks);
  const spasi = potongan.lastIndexOf(' ');
  return (spasi > maks * 0.6 ? potongan.slice(0, spasi) : potongan).trimEnd() + '…';
}

/**
 * Mengelompokkan sekumpulan baris products menjadi bentuk yang sama dengan
 * keluaran db.getGroupedCatalog(), supaya hasil pencarian bisa ditampilkan
 * lewat penyusun layar yang persis sama dengan katalog utama.
 *
 * Aturan pengelompokannya disamakan dengan getGroupedCatalog: pakai
 * brand_category, dan kalau kosong pakai kata pertama nama produk.
 */
export function kelompokkanPencarian(produk, ambilIkon = () => '📦') {
  const peta = new Map();

  for (const p of Array.isArray(produk) ? produk : []) {
    if (!p) continue;
    let kunci = String(p.brand_category || '').trim();
    if (!kunci) kunci = String(p.nama || '').trim().split(/\s+/)[0] || String(p.kode || '');
    const kunciUpper = kunci.toUpperCase();

    if (!peta.has(kunciUpper)) {
      let ikon = '📦';
      try { ikon = ambilIkon(kunci) || '📦'; } catch { ikon = '📦'; }
      peta.set(kunciUpper, {
        brand: kunci,
        icon: ikon,
        variants: [],
        min_price: Number(p.harga) || 0,
        max_price: Number(p.harga) || 0,
        total_stock: 0
      });
    }

    const grup = peta.get(kunciUpper);
    grup.variants.push(p);
    grup.total_stock += Number(p.stok) || 0;
    const harga = Number(p.harga) || 0;
    if (harga < grup.min_price) grup.min_price = harga;
    if (harga > grup.max_price) grup.max_price = harga;
  }

  return Array.from(peta.values());
}

/**
 * Menyusun layar KATALOG dari hasil db.getGroupedCatalog().
 *
 * Mengembalikan:
 *   teks   — pesan siap kirim
 *   entri  — [{ nomor, brand, icon, kodes: [...] }] untuk disimpan di sesi
 */
export function susunKatalog(katalogMentah, opts = {}) {
  const batasTipis = opts.batasTipis ?? 3;
  const namaToko = String(opts.namaToko || '').trim();

  const semua = Array.isArray(katalogMentah) ? katalogMentah : [];
  const katalog = semua.slice(0, MAKS_ENTRI_KATALOG);
  const terpotong = semua.length - katalog.length;

  if (katalog.length === 0) {
    return {
      teks: '📦 *KATALOG TOKO*\n\nBelum ada produk yang terdaftar.\n\n_Cek lagi sebentar lagi ya._',
      entri: [],
      kosong: true
    };
  }

  const entri = [];
  const baris = [];

  katalog.forEach((grup, idx) => {
    const nomor = idx + 1;
    const icon = grup.icon || '📦';
    const brand = String(grup.brand || 'Produk').trim();
    const varian = Array.isArray(grup.variants) ? grup.variants : [];

    const badge = badgeStok(grup.total_stock, batasTipis);
    const harga = labelHarga(grup.min_price, grup.max_price);
    const jumlahPaket = varian.length;

    // Baris kedua menjawab dua pertanyaan pertama pembeli sekaligus: berapa
    // harganya, dan apakah barangnya ada. Rincian jenis paket sengaja TIDAK
    // ditulis di sini — itu isi layar berikutnya, dan menuliskannya di sini
    // membuat katalog 10 merek jadi pesan raksasa yang tidak ada yang baca.
    const ekor = jumlahPaket > 1 ? ` · ${jumlahPaket} paket` : '';
    baris.push(`*${nomor}.* ${icon} *${brand}*\n     ${harga} · ${badge.teks}${ekor}`);

    entri.push({
      nomor,
      brand,
      icon,
      kodes: varian.map(v => String(v.kode || '').toUpperCase()).filter(Boolean)
    });
  });

  const adaStok = katalog.some(g => badgeStok(g.total_stock, batasTipis).ada);
  const kepala = String(opts.judul || '').trim()
    || (namaToko ? `📦 *KATALOG ${namaToko.toUpperCase()}*` : '📦 *KATALOG TOKO*');

  // Dihitung dari jumlah paket, bukan jumlah merek: toko dengan 3 merek yang
  // masing-masing punya 4 paket menjual 12 barang, bukan 3.
  const jumlahPaket = katalog.reduce((n, g) => n + (Array.isArray(g.variants) ? g.variants.length : 1), 0);

  let teks = `${kepala}\n_${jumlahPaket} paket siap pesan_\n\n`;
  teks += baris.join('\n\n');
  teks += '\n\n━━━━━━━━━━━━━━━\n';
  teks += katalog.length === 1
    ? '💡 Balas *1* untuk lihat detail & pilihan paketnya.'
    : `💡 Balas *1*–*${katalog.length}* untuk lihat detail & pilihan paketnya.`;
  if (terpotong > 0) {
    // Memotong diam-diam berarti barang yang dibayar owner tidak pernah
    // ditawarkan, dan tidak ada yang tahu.
    teks += `\n📄 _${terpotong} merek lagi tidak muat di satu pesan. Ketik_ \`.cari <nama>\` _untuk menemukannya._`;
  }
  if (!adaStok) {
    teks += '\n\n⚠️ _Semua produk sedang kosong. Ketik_ `.notif <kode>` _supaya dikabari saat restok._';
  }

  return { teks, entri, kosong: false };
}

// Teks yang isinya cuma menyebut lama waktu: "12 Bulan", "1 Tahun", "30 hari".
const POLA_DURASI = /^\d+\s*(hari|hr|minggu|bulan|bln|tahun|thn|day|days|week|month|months|year|years)$/i;

/**
 * Judul satu paket, disusun dari jenis + durasinya — itulah dua hal yang
 * membedakan paket di toko ini (Sharing 30 Hari vs Private 30 Hari).
 *
 * Ada satu jebakan data yang sering terjadi: owner mengisi `variant_type`
 * dengan durasi juga. Produk OFFICE di toko ini bertipe "1 Tahun" dan
 * berdurasi "12 Bulan", sehingga judulnya terbaca "1 Tahun · 12 Bulan" —
 * dua kali menyebut hal yang sama dan terbaca seperti salah tulis. Kalau
 * jenisnya ternyata cuma durasi lagi, yang ditampilkan durasinya saja.
 */
export function judulPaket(produk) {
  const jenis = String(produk?.variant_type || '').trim();
  const durasi = String(produk?.duration || '').trim();

  if (jenis && durasi && POLA_DURASI.test(jenis)) return durasi;
  const bagian = [jenis, durasi].filter(Boolean);
  if (bagian.length > 0) return bagian.join(' · ');
  return String(produk?.nama || '').trim();
}

/**
 * Menyusun layar PRODUK: deskripsi merek + seluruh jenis/paketnya, dinomori.
 *
 * `varian` adalah baris products yang SUDAH diambil ulang dari database dengan
 * kode persis, jadi angka stok di layar ini selalu angka terkini.
 *
 * Mengembalikan:
 *   teks   — pesan siap kirim
 *   kodes  — kode per nomor, untuk disimpan di sesi
 */
export function susunHalamanProduk(varian, opts = {}) {
  const batasTipis = opts.batasTipis ?? 3;
  const daftar = (Array.isArray(varian) ? varian : []).filter(Boolean);

  if (daftar.length === 0) {
    return {
      teks: '⚠️ Produk itu sudah tidak ada di katalog.\n\nKetik `.list` untuk melihat katalog terbaru.',
      kodes: [],
      kosong: true
    };
  }

  const icon = opts.icon || '📦';
  const brand = String(opts.brand || daftar[0].brand_category || daftar[0].nama || 'Produk').trim();

  // Deskripsi merek diambil dari varian yang punya deskripsi terpanjang. Toko
  // ini mengisi deskripsi hanya di salah satu paket, jadi memakai varian[0]
  // saja membuat halaman produk sering tampil tanpa penjelasan apa pun.
  const sumberDeskripsi = daftar.reduce((a, b) =>
    String(b.deskripsi || '').length > String(a.deskripsi || '').length ? b : a, daftar[0]);
  const deskripsi = potong(sumberDeskripsi.deskripsi, MAKS_DESKRIPSI);

  const sumberPetunjuk = daftar.reduce((a, b) =>
    String(b.petunjuk || '').length > String(a.petunjuk || '').length ? b : a, daftar[0]);
  const petunjuk = potong(sumberPetunjuk.petunjuk, MAKS_PETUNJUK);

  let teks = `${icon} *${brand.toUpperCase()}*\n`;
  teks += '━━━━━━━━━━━━━━━\n';
  if (deskripsi) teks += `${deskripsi}\n\n`;

  teks += daftar.length > 1 ? '📦 *PILIHAN PAKET*\n' : '📦 *PAKET*\n';

  const kodes = [];
  daftar.forEach((v, idx) => {
    const nomor = idx + 1;
    const kode = String(v.kode || '').toUpperCase();
    kodes.push(kode);

    const badge = badgeStok(v.stok, batasTipis);

    const judul = judulPaket(v) || kode;

    teks += `\n*${nomor}.* ${judul}\n`;
    teks += `     ${rupiah(v.harga)} · ${badge.teks}\n`;
  });

  const adaAuto = daftar.some(v => String(v.delivery_type || '').toUpperCase() === 'AUTO');
  const adaManual = daftar.some(v => String(v.delivery_type || '').toUpperCase() !== 'AUTO');

  teks += '\n🚀 *PENGIRIMAN*\n';
  if (adaAuto && !adaManual) teks += '⚡ Otomatis — akun dikirim 2–5 detik setelah bayar.\n';
  else if (!adaAuto && adaManual) teks += '👨‍💼 Dikirim manual oleh admin setelah bayar.\n';
  else teks += '⚡ Sebagian otomatis, sebagian dikirim admin setelah bayar.\n';

  if (petunjuk) teks += `\n📖 *CARA PAKAI & GARANSI*\n${petunjuk}\n`;

  const adaStok = daftar.some(v => badgeStok(v.stok, batasTipis).ada);
  teks += '\n━━━━━━━━━━━━━━━\n';
  if (adaStok) {
    teks += daftar.length === 1
      ? '💡 Balas *1* untuk masukkan ke keranjang.'
      : `💡 Balas *1*–*${daftar.length}* untuk masukkan ke keranjang.`;
  } else {
    teks += '🔴 Semua paket sedang kosong.\n';
    teks += `💡 Ketik \`.notif ${kodes[0]}\` supaya dikabari saat restok.`;
  }
  teks += '\n↩️ Ketik *0* atau `.list` untuk kembali ke katalog.';

  return { teks, kodes, kosong: false, adaStok };
}

/**
 * Pesan saat pelanggan membalas angka yang tidak ada di daftar.
 * Selalu menyebut jangkauan yang sah — nomor di luar jangkauan dulu tidak
 * dibalas sama sekali, jadi pelanggan mengira botnya mati.
 */
export function pesanNomorSalah(nomor, jumlah) {
  if (!Number.isFinite(Number(jumlah)) || Number(jumlah) <= 0) {
    return '⚠️ Daftarnya sudah kedaluwarsa. Ketik `.list` untuk membukanya lagi.';
  }
  return `⚠️ Nomor *${nomor}* tidak ada di daftar.\n\nBalas angka *1* sampai *${jumlah}*, atau ketik \`.list\` untuk membuka katalog lagi.`;
}
