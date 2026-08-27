/**
 * DROP KARTU DI GRUP
 *
 * Satu-satunya bagian arena yang tidak menunggu perintah. Kartu jatuh mengikuti
 * keramaian obrolan, lalu siapa pun boleh menyambar dengan `.tcg ambil <nomor>`.
 *
 * Pemicunya sengaja keramaian chat, bukan jadwal tetap: grup sepi tidak
 * dibanjiri kartu yang tidak ada yang mengambil, dan grup ramai dapat lebih
 * sering — jadi menghidupkan grup punya ganjaran langsung.
 *
 * Penghitungnya sengaja hanya di memori. Kalau bot restart, hitungan mulai dari
 * nol lagi; itu konsekuensi yang bisa diterima, dan jauh lebih murah daripada
 * menulis satu baris basis data untuk setiap pesan yang masuk ke setiap grup.
 */

import * as db from '../../../database.js';
import { getKartu, getKartuByRarity, ELEMEN, STAT_RARITY } from './cards.js';
import { bufferBanyakKartu } from './gambar.js';

const hitungGrup = new Map(); // jid -> { pesan, dropTerakhir }

function undiRarityDrop() {
  let r = Math.random();
  for (const [rarity, peluang] of db.TCG_DROP_PELUANG) {
    if (r < peluang) return rarity;
    r -= peluang;
  }
  return 'COMMON';
}

function undiKartuDrop() {
  const daftar = getKartuByRarity(undiRarityDrop());
  return daftar[Math.floor(Math.random() * daftar.length)];
}

function fmtSisa(ms) {
  return Math.max(0, Math.round(ms / 1000));
}

/**
 * Menjatuhkan satu drop ke grup. Dipanggil oleh pemicu keramaian, dan oleh
 * perintah admin `.tcg drop` untuk pengujian.
 */
export async function kirimDrop(sock, jid) {
  const kartu = [];
  const dipakai = new Set();
  for (let i = 0; i < db.TCG_DROP_JUMLAH; i++) {
    let k = undiKartuDrop();
    let coba = 0;
    while (k && dipakai.has(k.id) && coba < 8) {
      k = undiKartuDrop();
      coba++;
    }
    if (!k) continue;
    dipakai.add(k.id);
    kartu.push(k);
  }
  if (!kartu.length) return null;

  const drop = await db.tcgBuatDrop(jid, kartu.map(k => k.id), db.TCG_DROP_DETIK);

  const baris = kartu.map((k, i) =>
    `*${i + 1}️⃣* ${ELEMEN[k.elemen].emoji} *${k.nama}* — ${STAT_RARITY[k.rarity].label}`
  );

  // Caption memuat perintahnya lengkap: di koneksi lambat gambarnya belum tentu
  // termuat, dan orang tetap harus bisa ikut menyambar.
  const caption = [
    '🎴 *KARTU JATUH DI GRUP!*',
    '',
    ...baris,
    '',
    `⏱️ *${fmtSisa(db.TCG_DROP_DETIK * 1000)} detik* — siapa cepat dia dapat!`,
    'Ketik `.tcg ambil 1` (atau 2 / 3)',
    '_Satu orang satu kartu._'
  ].join('\n');

  try {
    const gambar = await bufferBanyakKartu(kartu);
    if (gambar) {
      await sock.sendMessage(jid, { image: gambar, caption });
    } else {
      await sock.sendMessage(jid, { text: caption });
    }
  } catch (e) {
    console.error('[TCG_DROP] Gagal mengirim gambar drop, jatuh ke teks:', e?.message || e);
    try {
      await sock.sendMessage(jid, { text: caption });
    } catch { /* grup mungkin sudah tidak bisa dikirimi */ }
  }

  return drop;
}

/**
 * Dipanggil untuk SETIAP pesan grup yang masuk.
 *
 * Harus murah dan tidak boleh pernah melempar — ini duduk di jalur panas
 * penerimaan pesan, dan kegagalan di sini tidak boleh menjatuhkan penanganan
 * pesan yang sesungguhnya.
 */
export async function tickPesanGrup(sock, jid) {
  try {
    if (!jid || !jid.endsWith('@g.us')) return;

    const setelan = await db.getGroupSettings(jid);
    const fitur = setelan?.features_config || {};
    // Sakelar game induk (`.mode game off`) mematikan drop juga — kalau tidak,
    // grup yang sudah mematikan game tetap kejatuhan kartu tiap kali ramai.
    if (fitur['game'] === false) return;
    if (fitur['tcg'] === false) return;

    const stat = hitungGrup.get(jid) || { pesan: 0, dropTerakhir: 0 };
    stat.pesan += 1;

    const cukupRamai = stat.pesan >= db.TCG_DROP_PESAN_PEMICU;
    const cukupJeda = Date.now() - stat.dropTerakhir >= db.TCG_DROP_JEDA_MS;

    if (!cukupRamai || !cukupJeda) {
      hitungGrup.set(jid, stat);
      return;
    }

    // Jangan menumpuk drop: kalau yang lama masih berjalan, tunggu selesai.
    const aktif = await db.tcgGetDropAktif(jid);
    if (aktif) {
      hitungGrup.set(jid, stat);
      return;
    }

    stat.pesan = 0;
    stat.dropTerakhir = Date.now();
    hitungGrup.set(jid, stat);

    await kirimDrop(sock, jid);
  } catch (e) {
    console.error('[TCG_DROP] tickPesanGrup gagal:', e?.message || e);
  }
}

/** Status penghitung, untuk perintah diagnosa pemilik. */
export function statusDrop(jid) {
  const stat = hitungGrup.get(jid) || { pesan: 0, dropTerakhir: 0 };
  return {
    pesan: stat.pesan,
    butuh: db.TCG_DROP_PESAN_PEMICU,
    sisaJedaMs: Math.max(0, db.TCG_DROP_JEDA_MS - (Date.now() - stat.dropTerakhir))
  };
}

/** Dipakai perintah uji owner supaya drop bisa dipaksa keluar sekarang. */
export function resetPenghitung(jid) {
  hitungGrup.set(jid, { pesan: 0, dropTerakhir: 0 });
}

export { getKartu };
