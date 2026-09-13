/**
 * NOTIF OWNER — satu jalan bagi modul latar belakang untuk berteriak ke owner.
 *
 * Modul seperti paymentService berjalan dari scheduler, tidak memegang socket
 * WhatsApp, dan selama ini satu-satunya cara mereka melaporkan kegagalan adalah
 * console.error — yang tidak pernah dibaca siapa pun karena bot ini dijalankan
 * dari laptop rumah, bukan dari layar log yang ditunggui.
 *
 * fulfillmentWorker sudah punya versi privatnya sendiri. Modul ini
 * menjadikannya milik bersama supaya jalur uang yang lain bisa memakainya juga.
 *
 * Tidak mengimpor apa pun dari luar src/utils supaya tidak ada siklus impor
 * (AGENTS.md §16).
 */

let sockRef = null;
let getSettings = null;

/**
 * Dipasang sekali saat koneksi WhatsApp terbuka. `pembacaSettings` disuntik dari
 * luar (bukan diimpor) agar modul ini tetap bebas dari database.js.
 */
export function pasangSocketNotif(sock, pembacaSettings = null) {
  sockRef = sock;
  if (pembacaSettings) getSettings = pembacaSettings;
}

/** true kalau notifikasi benar-benar bisa dikirim sekarang. */
export function notifSiap() {
  return Boolean(sockRef && getSettings);
}

/**
 * Kirim pesan ke owner. Tidak pernah melempar: pemanggilnya berada di jalur uang,
 * dan gagal mengirim notifikasi tidak boleh menggagalkan pembayaran.
 */
export async function notifikasiOwner(pesan) {
  try {
    if (!sockRef || !getSettings) return false;
    const settings = await getSettings();
    const ownerJid = String(settings?.ownerJid || settings?.ownerNumber || '').trim();
    if (!ownerJid.includes('@')) return false;
    await sockRef.sendMessage(ownerJid, { text: pesan });
    return true;
  } catch (err) {
    console.error('[NOTIF_OWNER] Gagal mengirim notifikasi:', err.message);
    return false;
  }
}
