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
