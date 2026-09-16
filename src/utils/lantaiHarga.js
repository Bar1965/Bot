/**
 * LANTAI HARGA — batas bawah yang tidak boleh ditembus oleh tumpukan diskon.
 *
 * Toko ini punya TIGA potongan yang bisa menempel pada satu pesanan sekaligus:
 *
 *   1. Flash sale  — mengganti harga satuan sebelum masuk keranjang
 *   2. Kupon       — persen atau nominal tetap
 *   3. Diskon premium — persen, menurut tier pelanggan
 *
 * Ketiganya dulu dijumlahkan tanpa batas bawah selain nol:
 *
 *     const finalTotal = Math.max(0, rawTotal - discount - diskonPremium);
 *
 * Kupon memang sudah dijepit agar tidak melebihi subtotal, tetapi diskon premium
 * dipotong LAGI di atasnya. Akibatnya ada dua, dan dua-duanya buruk:
 *
 *   • Pas Rp0 — checkout menolak dengan "Nilai pesanan tidak valid" dan QRIS
 *     diminta senilai nol. Pembeli tidak bisa menyelesaikan pesanan sama sekali,
 *     dengan pesan galat yang tidak menjelaskan apa pun.
 *   • Mendekati nol — Rp500 untuk barang Rp50.000 LOLOS, dan barangnya benar-
 *     benar terkirim.
 *
 * Yang dijaga di sini adalah harga KATALOG, bukan subtotal keranjang. Kalau
 * lantainya dihitung dari subtotal, flash sale lolos sepenuhnya: harga sudah
 * terlanjur dipangkas sebelum perhitungan ini berjalan, dan sisa jatah diskonnya
 * dihitung ulang dari angka yang sudah kecil.
 *
 * Yang TIDAK dilakukan: menggagalkan transaksi. Pembeli tidak pernah tahu ada
 * lantai harga, dan menolak pesanannya karena aturan internal toko membuatnya
 * pergi. Potongannya yang dipangkas, transaksinya tetap jalan.
 */

/** Sisa harga minimal yang harus tetap dibayar, dalam persen harga katalog. */
export const PERSEN_BAWAAN = 40;

/** Nominal minimal sekali transaksi. Di bawah ini QRIS tidak masuk akal. */
export const MINIMAL_BAWAAN = 1000;

function bulatAman(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0;
}

/**
 * Berapa rupiah paling sedikit yang masih harus dibayar untuk keranjang ini.
 *
 * `totalKatalog` adalah jumlah qty × harga katalog — harga sebelum flash sale.
 * `rawTotal` adalah subtotal keranjang yang sebenarnya (sesudah flash sale).
 *
 * Lantainya dihitung dari yang LEBIH BESAR di antara keduanya, supaya flash sale
 * ikut terhitung sebagai potongan yang memakan jatah, bukan sebagai harga baru
 * yang jatah diskonnya dimulai lagi dari awal.
 *
 * Lalu dijepit agar tidak pernah MELEBIHI rawTotal. Tanpa jepitan itu, flash
 * sale yang sengaja dipasang di bawah lantai justru akan menaikkan kembali total
 * yang dibayar pembeli — persis kebalikan dari yang owner maksud.
 */
export function hitungLantaiHarga({ totalKatalog = 0, rawTotal = 0, persenMinimal, minimalRupiah } = {}) {
  const subtotal = bulatAman(rawTotal);
  const dasar = Math.max(bulatAman(totalKatalog), subtotal);

  let persen = Number(persenMinimal);
  if (!Number.isFinite(persen)) persen = PERSEN_BAWAAN;
  persen = Math.min(100, Math.max(0, persen));

  let minimal = Number(minimalRupiah);
  if (!Number.isFinite(minimal)) minimal = MINIMAL_BAWAAN;
  minimal = Math.max(0, Math.floor(minimal));

  const lantai = Math.max(Math.ceil(dasar * persen / 100), minimal);
  return Math.min(lantai, subtotal);
}

/**
 * Terapkan lantainya, dengan memangkas potongan — bukan menolak pesanan.
 *
 * Urutan pemangkasan: KUPON dulu, premium belakangan. Diskon premium adalah
 * manfaat yang sudah DIBAYAR pelanggan; kupon adalah promo yang owner sebar
 * sendiri. Kalau salah satu harus mengalah, yang mengalah adalah promonya.
 *
 * Angka hasil pangkasan WAJIB ditulis balik ke kolomnya masing-masing oleh
 * pemanggil. Kalau tidak, layar keranjang mencetak potongan yang lebih besar
 * daripada yang benar-benar dipakai, dan baris-barisnya tidak akan pernah
 * menjumlah ke angka "Total Belanja" — persis keluhan yang sudah pernah
 * diperbaiki di getCartDetails.
 */
export function terapkanLantaiHarga({ rawTotal = 0, diskonKupon = 0, diskonPremium = 0, lantai = 0 } = {}) {
  const subtotal = bulatAman(rawTotal);
  const batas = Math.min(bulatAman(lantai), subtotal);

  let kupon = Math.min(bulatAman(diskonKupon), subtotal);
  let premium = Math.min(bulatAman(diskonPremium), subtotal);

  let total = subtotal - kupon - premium;
  if (total >= batas) {
    return {
      total: Math.max(0, total),
      diskonKupon: kupon,
      diskonPremium: premium,
      lantai: batas,
      kenaLantai: false,
      dipangkas: { kupon: 0, premium: 0 }
    };
  }

  let kelebihan = batas - total;

  const potongKupon = Math.min(kupon, kelebihan);
  kupon -= potongKupon;
  kelebihan -= potongKupon;

  const potongPremium = Math.min(premium, kelebihan);
  premium -= potongPremium;
  kelebihan -= potongPremium;

  // Karena batas <= subtotal, membuang seluruh potongan selalu cukup untuk
  // mencapainya. kelebihan pasti nol di titik ini.
  total = subtotal - kupon - premium;

  return {
    total: Math.max(0, total),
    diskonKupon: kupon,
    diskonPremium: premium,
    lantai: batas,
    kenaLantai: true,
    dipangkas: { kupon: potongKupon, premium: potongPremium }
  };
}
