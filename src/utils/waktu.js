/**
 * WAKTU — satu tempat membaca stempel waktu dari database dan menampilkannya WIB.
 *
 * MASALAH YANG DIPERBAIKI: kolom seperti `orders.created_at` memakai
 * `CURRENT_TIMESTAMP` milik SQLite, yang menghasilkan string **UTC** berbentuk
 * "2026-09-13 03:55:38" — tanpa penanda zona apa pun. `new Date(string)` di V8
 * membaca bentuk itu sebagai waktu **lokal**, bukan UTC. Di mesin WIB (+7)
 * hasilnya meleset tepat 7 jam ke belakang: pesanan pukul 10.55 WIB ditampilkan
 * ke pelanggan sebagai 03.55. Untuk `toLocaleDateString` akibatnya lebih buruk —
 * pesanan dini hari mundur satu hari penuh.
 *
 * Modul ini tidak mengimpor apa pun, jadi aman dipanggil dari mana saja.
 */

const ZONA = 'Asia/Jakarta';

/**
 * Ubah nilai stempel waktu apa pun dari database menjadi Date yang benar.
 * Menerima: string SQLite UTC, epoch milidetik (angka atau string angka), dan
 * string ISO ber-zona. Mengembalikan null kalau tidak terbaca, supaya pemanggil
 * bisa menampilkan "-" alih-alih "Invalid Date".
 */
export function keWaktu(nilai) {
  if (nilai === null || nilai === undefined || nilai === '') return null;

  if (typeof nilai === 'number') {
    const d = new Date(nilai);
    return isNaN(d.getTime()) ? null : d;
  }

  const s = String(nilai).trim();
  if (!s) return null;

  // Epoch milidetik yang tersimpan sebagai string angka.
  if (/^\d+$/.test(s)) {
    const d = new Date(Number(s));
    return isNaN(d.getTime()) ? null : d;
  }

  // "YYYY-MM-DD HH:MM:SS" tanpa zona = keluaran CURRENT_TIMESTAMP SQLite, UTC.
  const tanpaZona = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s) && !/([Zz]|[+-]\d{2}:?\d{2})$/.test(s);
  if (tanpaZona) {
    const d = new Date(s.replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Tanggal + jam WIB, mis. "13/9/2026, 10.55.38". */
export function tanggalJamWib(nilai, fallback = '-') {
  const d = keWaktu(nilai);
  if (!d) return fallback;
  return d.toLocaleString('id-ID', { timeZone: ZONA });
}

/** Tanggal saja dalam WIB, mis. "13/9/2026". */
export function tanggalWib(nilai, fallback = '-') {
  const d = keWaktu(nilai);
  if (!d) return fallback;
  return d.toLocaleDateString('id-ID', { timeZone: ZONA });
}

/** Tanggal panjang WIB, mis. "Sabtu, 13 September 2026". Dipakai teks garansi. */
export function tanggalPanjangWib(nilai, fallback = '-') {
  const d = keWaktu(nilai);
  if (!d) return fallback;
  return d.toLocaleDateString('id-ID', { timeZone: ZONA, dateStyle: 'full' });
}

/**
 * Jam:menit WIB, mis. "17.40". Dipakai baris "Berlaku hingga ... WIB" pada
 * tagihan QRIS.
 *
 * Sebelumnya ketiga tempat itu memanggil `new Date(x).toLocaleTimeString('id-ID', ...)`
 * langsung. Dua cacatnya: nilai `expiredAt` dari Casaku berbentuk string API
 * yang tidak dijamin ber-zona (kalau tanpa zona, salah baca 7 jam persis seperti
 * kolom SQLite), dan hasilnya dirender memakai zona mesin walau labelnya sudah
 * terlanjur tertulis "WIB" — jadi begitu bot pindah ke VPS, tulisan WIB-nya
 * bohong. keWaktu menangani kedua bentuk, dan zona dipaku ke Asia/Jakarta.
 */
export function jamWib(nilai, fallback = '-') {
  const d = keWaktu(nilai);
  if (!d) return fallback;
  return d.toLocaleTimeString('id-ID', { timeZone: ZONA, hour: '2-digit', minute: '2-digit' });
}

/**
 * Batas akhir sebuah tanggal kedaluwarsa.
 *
 * Kolom seperti `coupons.expires_at` diisi tanggal POLOS — "2026-12-31" — dari
 * dua pintu: `.addcoupon ... | 2026-12-31` dan `<input type="date">` di
 * dashboard. `new Date("2026-12-31")` dibaca V8 sebagai tengah malam **UTC**,
 * yaitu pukul 07.00 WIB. Jadi kupon yang dimaksudkan owner berlaku "sampai 31
 * Desember" sebenarnya mati pukul tujuh pagi di hari itu, sementara dashboard
 * masih menampilkannya aktif.
 *
 * Yang dimaksud manusia saat menulis tanggal tanpa jam adalah AKHIR hari itu di
 * zona sendiri. WIB tidak mengenal DST, jadi "+07:00" cukup dan tepat.
 *
 * Nilai yang sudah membawa jam diteruskan apa adanya ke keWaktu.
 */
export function akhirHariWib(nilai, fallback = null) {
  if (nilai === null || nilai === undefined || nilai === '') return fallback;

  const s = String(nilai).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T23:59:59.999+07:00`);
    return isNaN(d.getTime()) ? fallback : d;
  }

  return keWaktu(s) || fallback;
}
