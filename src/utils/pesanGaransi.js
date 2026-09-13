/**
 * TEKS GARANSI — satu sumber untuk semua jalur pengiriman.
 *
 * Pengiriman produk ditulis di lebih dari satu tempat: `fulfillmentWorker.js`
 * untuk pembayaran otomatis, dan `.paid` di `groupAdminHandler.js` untuk
 * konfirmasi tangan. Keduanya sama-sama memanggil `claimAndDeliverItems`, yang
 * menulis `orders.warranty_until` — jadi garansinya nyata di kedua jalur.
 *
 * Tapi teksnya dulu hanya ditulis di worker. Pembeli yang dilayani lewat `.paid`
 * tidak pernah diberi tahu garansinya ada, kapan habisnya, atau bahwa `.garansi`
 * bisa dipakai sendiri — mereka cuma disuruh "hubungi admin". Artinya setiap
 * klaim garansi kembali jadi pekerjaan tangan pemilik toko, padahal perintah
 * swalayannya sudah ada.
 *
 * Modul ini hanya mengimpor `waktu.js` — yang sendirinya tidak mengimpor apa pun
 * — jadi aman dipanggil dari mana saja tanpa menutup siklus (AGENTS.md §16).
 */

import { tanggalPanjangWib } from './waktu.js';

/**
 * Baris "garansi aktif hingga <tanggal>".
 * Mengembalikan string kosong kalau pesanannya memang tanpa garansi, supaya
 * pemanggil bisa menempelkannya tanpa perlu memeriksa dulu.
 */
export function barisGaransiAktif(warrantyUntil) {
  if (!warrantyUntil) return '';
  // Lewat helper WIB, bukan zona mesin: kalau bot suatu saat pindah ke server
  // UTC, tanggal garansi tidak boleh ikut bergeser di mata pelanggan.
  const teks = tanggalPanjangWib(warrantyUntil, '');
  if (!teks) return '';
  return `🛡️ *Garansi Aktif Hingga:* ${teks}\n`;
}

/**
 * Baris ajakan klaim mandiri. Sengaja menyebut perintahnya lengkap dengan Order
 * ID supaya pembeli tinggal menyalin, bukan disuruh mencari nomor pesanannya.
 */
export function barisKlaimGaransi(orderId) {
  if (!orderId) return '';
  return `🛡️ *Klaim Kendala / Garansi:* Ketik \`.garansi ${orderId}\`\n`;
}

/**
 * Penutup lengkap untuk pesan pengiriman: tanggal garansi + cara klaim.
 * Inilah yang seharusnya dipakai jalur pengiriman mana pun.
 */
export function penutupGaransi(orderId, warrantyUntil) {
  return barisGaransiAktif(warrantyUntil) + barisKlaimGaransi(orderId);
}

const HARI_MS = 24 * 60 * 60 * 1000;
const GARANSI_BAWAAN_HARI = 30;

/**
 * Ubah kolom `products.duration` ("7 Hari", "12 Bulan", "1 Tahun") menjadi masa
 * garansi dalam milidetik.
 *
 * MASALAH YANG DIPERBAIKI: versi lama mencocokkan POTONGAN TEKS, bukan angka:
 *
 *   if (d.includes('7'))                              -> 7 hari
 *   else if (d.includes('14'))                        -> 14 hari
 *   else if (d.includes('60') || d.includes('2 bulan')) -> 60 hari
 *   else if (d.includes('90') || d.includes('3 bulan')) -> 90 hari
 *   else if (d.includes('tahun') || d.includes('12 bulan')) -> 365 hari
 *   else                                              -> 30 hari
 *
 * Empat produk toko ini salah hitung karenanya:
 *
 *   OFFICE      "12 Bulan" -> cabang '2 bulan' menang lebih dulu ->  60 hari
 *   ADOBE       "12 Bulan" -> sama                               ->  60 hari
 *   APPLEMUSIC  "6 Bulan"  -> tak ada yang cocok                 ->  30 hari
 *   GEMINI      "18 Bulan" -> tak ada yang cocok                 ->  30 hari
 *
 * Cabang '12 bulan' yang seharusnya memberi 365 hari TIDAK PERNAH terjangkau,
 * karena "12 bulan" sudah mengandung "2 bulan". Jadi akun Office setahun hanya
 * bergaransi dua bulan: rusak di bulan kelima, `.garansi` menolak klaimnya, dan
 * pembeli yang sebenarnya berhak justru disuruh pergi.
 *
 * Sekarang angka dan satuannya dibaca utuh. Teks yang tidak mengandung pasangan
 * angka+satuan (kosong, "Lifetime", "Permanen") tetap jatuh ke 30 hari seperti
 * perilaku lama — itu keputusan kebijakan pemilik toko, bukan urusan perbaikan
 * ini.
 */
export function masaGaransiMs(duration) {
  const teks = String(duration || '').toLowerCase();

  // Ambil pasangan angka+satuan pertama: "12 bulan", "7hari", "1 tahun".
  const cocok = teks.match(/(\d+)\s*(hari|hr|minggu|mgg|bulan|bln|tahun|thn|year|month|week|day)/);
  if (!cocok) return GARANSI_BAWAAN_HARI * HARI_MS;

  const jumlah = Number(cocok[1]);
  if (!Number.isFinite(jumlah) || jumlah <= 0) return GARANSI_BAWAAN_HARI * HARI_MS;

  const satuan = cocok[2];
  let hari;
  if (satuan.startsWith('h') || satuan === 'day') hari = jumlah;
  else if (satuan.startsWith('m') && satuan !== 'month') hari = jumlah * 7;   // minggu/mgg
  else if (satuan === 'week') hari = jumlah * 7;
  else if (satuan.startsWith('b') || satuan === 'month') hari = jumlah * 30;  // bulan/bln
  else hari = jumlah * 365;                                                   // tahun/thn/year

  // Batas atas 10 tahun supaya salah ketik seperti "9999 bulan" tidak membuat
  // tanggal garansi yang tidak masuk akal.
  const AMAN = Math.min(hari, 3650);
  return AMAN * HARI_MS;
}
