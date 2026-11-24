/**
 * PENGUMUMAN "BOT ONLINE"
 *
 * Dipanggil dari handler `connection === 'open'` di bot.js.
 *
 * Dua aturan yang menentukan seluruh isi file ini:
 *
 * 1. **`connection: 'open'` menyala tiap kali koneksi WhatsApp tersambung
 *    ulang**, bukan cuma saat bot dinyalakan. Sinyal WA putus-nyambung itu
 *    normal. Karena itu ada dua kunci: `sudahDiumumkan` (sekali per proses)
 *    dan perbandingan versi (sekali per rilis).
 * 2. **Owner selalu dapat kabar, grup tidak.** Owner butuh tahu botnya hidup
 *    setiap kali; member grup cuma peduli kalau ada yang benar-benar baru.
 *    Menyiarkan "bot online" ke semua grup tiap restart itu spam.
 */

import * as db from '../../database.js';
import { config } from '../../config.js';
import { BOT_VERSION, VERSI_TERBARU, getSorotanUpdate } from './changelog.js';

const KUNCI_VERSI = 'lastAnnouncedVersion';
const KUNCI_AKTIF = 'updateAnnounceEnabled';
const JEDA_SIAR_MS = 1500;      // jeda antar grup supaya tidak kena rate limit
const TUNDA_MULAI_MS = 8000;    // beri waktu koneksi stabil dulu

let sudahDiumumkan = false;

function waktuSekarang() {
  return new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta', dateStyle: 'full', timeStyle: 'short'
  });
}

function kartuOwner({ versiBaru, jumlahGrup, disiarkan, versiLama }) {
  const v = VERSI_TERBARU;
  return `🟢 *BOT ONLINE — SIAP MELAYANI* 🤖
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🕒 *Waktu Nyala:* ${waktuSekarang()}
📌 *Versi:* ${v.versi} — ${v.nama}
📅 *Rilis:* ${v.tanggal}
👥 *Grup Terhubung:* ${jumlahGrup}

${versiBaru
    ? `🆕 *VERSI BARU TERPASANG!* _(sebelumnya ${versiLama || 'belum tercatat'})_\n\n📋 *Yang berubah di rilis ini:*\n${getSorotanUpdate()}`
    : `✅ *Tidak ada perubahan versi* — ini penyalaan ulang biasa di ${v.versi}.`}

${versiBaru
    ? (disiarkan > 0
      ? `📢 Pengumuman sudah disiarkan ke *${disiarkan} grup*.`
      : `🔕 Pengumuman ke grup *tidak dikirim* _(dimatikan lewat \`.update off\`, atau tidak ada grup yang memenuhi syarat)_.`)
    : `🔕 Pengumuman ke grup dilewati — versinya sama seperti pengumuman terakhir.`}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 \`.update\` rincian lengkap • \`.update broadcast\` siarkan ulang ke grup
💡 \`.update off\` / \`.update on\` matikan atau nyalakan pengumuman otomatis`;
}

function kartuGrup() {
  const v = VERSI_TERBARU;
  return `🚀 *BOT BARU SAJA DIPERBARUI!* ✨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 *Versi ${v.versi} — ${v.nama}*
📅 ${v.tanggal}

📋 *Yang baru:*
${getSorotanUpdate()}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 Ketik \`.update\` untuk rincian lengkapnya, atau \`.menu\` untuk semua perintah.`;
}

/**
 * Daftar grup yang layak dikirimi pengumuman: benar-benar masih diikuti bot,
 * DAN pernah dikonfigurasi (punya baris di group_settings). Grup yang cuma
 * numpang lewat tidak perlu dikirimi catatan rilis.
 */
export async function daftarGrupPengumuman(sock) {
  return await grupTujuan(sock);
}

async function grupTujuan(sock) {
  let ikut = [];
  try {
    const semua = await sock.groupFetchAllParticipating();
    ikut = Object.keys(semua || {});
  } catch (err) {
    console.warn('[STARTUP ANNOUNCE] Gagal mengambil daftar grup:', err.message);
    return { tujuan: [], totalGrup: 0 };
  }

  let terkonfigurasi = [];
  try {
    terkonfigurasi = await db.getConfiguredGroupJids();
  } catch { terkonfigurasi = []; }

  const set = new Set(terkonfigurasi);
  const tujuan = [];
  for (const jid of ikut) {
    if (!set.has(jid)) continue;
    try {
      const s = await db.getGroupSettings(jid);
      // Nilai bot_mode yang dipakai `.mode` cuma 'all' | 'sales' | 'off'.
      // Sebelumnya di sini dicek 'self' yang tidak pernah ada, jadi grup yang
      // sudah membisukan bot tetap kebagian siaran catatan rilis.
      if (s?.bot_mode === 'off') continue;   // bot memang dibisukan di grup itu
    } catch { /* pakai default: ikut dikirimi */ }
    tujuan.push(jid);
  }
  return { tujuan, totalGrup: ikut.length };
}

async function siarkanKeGrup(sock, daftar) {
  const teks = kartuGrup();
  let sukses = 0;
  for (const jid of daftar) {
    try {
      await sock.sendMessage(jid, { text: teks });
      sukses++;
    } catch (err) {
      console.warn(`[STARTUP ANNOUNCE] Gagal kirim ke ${jid}:`, err.message);
    }
    await new Promise(r => setTimeout(r, JEDA_SIAR_MS));
  }
  return sukses;
}

/**
 * Umumkan bot online. Aman dipanggil berkali-kali — hanya berjalan sekali
 * per proses.
 */
export async function umumkanBotOnline(sock) {
  if (sudahDiumumkan) return;
  sudahDiumumkan = true;

  // Ditunda sebentar: saat koneksi baru terbuka, antrean pesan offline sedang
  // dibanjir-proses dan pengumuman bisa tenggelam atau kena rate limit.
  setTimeout(() => {
    jalankanPengumuman(sock).catch(err =>
      console.error('[STARTUP ANNOUNCE] Gagal:', err.message));
  }, TUNDA_MULAI_MS);
}

async function jalankanPengumuman(sock) {
  const versiLama = await db.getSetting(KUNCI_VERSI);
  const aktif = String(await db.getSetting(KUNCI_AKTIF) ?? 'on').toLowerCase() !== 'off';
  const versiBaru = versiLama !== BOT_VERSION;

  const { tujuan, totalGrup } = await grupTujuan(sock);

  let disiarkan = 0;
  if (versiBaru && aktif && tujuan.length > 0) {
    disiarkan = await siarkanKeGrup(sock, tujuan);
  }

  if (versiBaru) {
    await db.updateSettings({ [KUNCI_VERSI]: BOT_VERSION });
  }

  // Nomor owner bisa diubah lewat Dashboard, jadi baca dari settings dulu dan
  // baru jatuh ke config.defaults — pola yang sama dipakai bot.js & userDb.js.
  let ownerJid = config.defaults.ownerNumber;
  try {
    const settings = await db.getSettings();
    ownerJid = settings.ownerNumber || config.defaults.ownerNumber;
  } catch { /* pakai default */ }

  if (ownerJid) {
    try {
      await sock.sendMessage(ownerJid, {
        text: kartuOwner({ versiBaru, jumlahGrup: totalGrup, disiarkan, versiLama })
      });
    } catch (err) {
      console.warn('[STARTUP ANNOUNCE] Gagal kirim laporan ke owner:', err.message);
    }
  }

  console.log(`[STARTUP ANNOUNCE] Versi ${BOT_VERSION}${versiBaru ? ' (BARU)' : ''} — disiarkan ke ${disiarkan}/${tujuan.length} grup dari ${totalGrup} grup terhubung.`);
}

/** Siaran manual lewat `.update broadcast` (owner). */
export async function siarkanUpdateManual(sock) {
  const { tujuan, totalGrup } = await grupTujuan(sock);
  if (tujuan.length === 0) return { sukses: 0, tujuan: 0, totalGrup };
  const sukses = await siarkanKeGrup(sock, tujuan);
  await db.updateSettings({ [KUNCI_VERSI]: BOT_VERSION });
  return { sukses, tujuan: tujuan.length, totalGrup };
}

export async function setPengumumanOtomatis(nyala) {
  await db.updateSettings({ [KUNCI_AKTIF]: nyala ? 'on' : 'off' });
  return nyala;
}

export async function statusPengumumanOtomatis() {
  return String(await db.getSetting(KUNCI_AKTIF) ?? 'on').toLowerCase() !== 'off';
}
