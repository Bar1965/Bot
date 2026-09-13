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
