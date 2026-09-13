/**
 * SATU jawaban untuk kegagalan tak terduga di route dashboard.
 *
 * MASALAH YANG DIPERBAIKI: 57 penangkap di sembilan berkas route membalas
 * `res.status(500).json({ success: false, message: err.message })` — menyerahkan
 * pesan internal mentah ke klien. Pada `/api/login` klien itu BELUM login.
 *
 * Pemicunya tidak perlu kredensial apa pun: POST /api/login dengan
 * `Content-Type: text/plain` membuat Express tidak memasang parser mana pun,
 * `req.body` undefined, destrukturisasinya melempar, dan balasannya menjadi
 * "Cannot destructure property 'username' of 'req.body' as it is undefined."
 * Bentuk penangkap yang sama juga memulangkan pesan driver SQLite lengkap dengan
 * nama tabel dan kolom untuk kegagalan lapisan database apa pun.
 *
 * Sebabnya tetap dicatat di log server — yang memang tempatnya — sementara klien
 * hanya menerima kalimat netral.
 */
export function pesanErrorAman(err, konteks = 'API') {
  console.error(`[${konteks}]`, err?.stack || err?.message || err);
  return 'Terjadi kesalahan di server. Silakan coba lagi; rinciannya ada di log bot.';
}
