import { jidNormalizedUser } from '@whiskeysockets/baileys';

/**
 * SATU-SATUNYA cara mendapatkan kunci pemain untuk semua tabel tcg_*.
 *
 * Sengaja identik dengan kunci game_profiles.customer_jid. Saat nanti
 * identitas @lid dimigrasi ke nomor asli, satu skrip migrasi akan membereskan
 * poin DAN kartu sekaligus. Kalau arena memakai kunci sendiri, kamu butuh
 * migrasi kedua yang lebih rumit, dan setiap ketidakcocokan di antara keduanya
 * berarti kartu pemain hilang.
 *
 * Aturan tim: tidak ada query ke tabel tcg_* yang boleh menerima jid mentah
 * dari pesan. Selalu lewat fungsi ini.
 */
export function tcgKey(senderJid) {
  return jidNormalizedUser(String(senderJid || '').trim());
}
