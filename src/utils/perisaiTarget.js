/**
 * PERISAI SASARAN MODERASI — SIAPA YANG TIDAK BOLEH DI-KICK SIAPA
 *
 * `src/utils/botIdentity.js` menjawab "apakah sasaran ini bot sendiri". Berkas
 * ini menjawab pertanyaan berikutnya: "apakah sasaran ini orang yang tidak
 * berhak disentuh oleh yang menyuruh".
 *
 * MASALAHNYA. `.kick` dan `.demote` terbuka untuk siapa pun yang berstatus
 * admin di grup WhatsApp — bukan hanya Admin Toko, bukan hanya Owner. Artinya
 * admin grup mana pun bisa mengeluarkan Owner bot dari grupnya sendiri, atau
 * menurunkan Admin Toko, dengan satu perintah. Bot punya hak admin, jadi
 * permintaannya berhasil.
 *
 * TATA TINGKATNYA satu arah dan cuma tiga baris:
 *
 *     Owner        → boleh menyentuh siapa pun (kecuali bot sendiri)
 *     Admin Toko   → boleh menyentuh siapa pun KECUALI Owner
 *     Admin grup   → boleh menyentuh siapa pun KECUALI Owner & Admin Toko
 *
 * BIAS SAAT RAGU: **kalau identitas sasaran tidak bisa dipastikan, IZINKAN.**
 *
 * Terbalik dari `adalahJidBot`, dan itu disengaja. Penjaga bot memakai
 * perbandingan pasti terhadap identitas yang selalu ada di `sock.user`, jadi ia
 * mampu menolak dengan yakin. Di sini, resolusi @lid ke nomor HP bergantung
 * pada metadata grup dan peta LID yang terisi bertahap — menolak setiap kali
 * resolusi gagal akan membuat `.kick` berhenti bekerja untuk anggota biasa di
 * grup ber-LID, yaitu justru pemakaian normalnya. Perisai ini hanya menolak
 * saat ada kecocokan POSITIF.
 */

import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { isPhoneMatch, normalizePhoneDigits } from '../database/connection.js';

function rapikan(jid) {
  const s = String(jid || '').trim();
  if (!s) return '';
  try {
    return jidNormalizedUser(s) || s.toLowerCase();
  } catch (e) {
    return s.toLowerCase();
  }
}

const angka = (jid) => String(jid || '').split('@')[0].replace(/[^0-9]/g, '');

/**
 * Semua bentuk identitas sasaran yang bisa dibaca dari metadata grup.
 *
 * Murni — tidak menyentuh database — supaya bisa diuji tanpa perancah apa pun.
 *
 * @returns {{jid:string[], nomor:string|null, lid:string|null}}
 *          `nomor` hanya diisi kalau benar-benar ditemukan nomor HP; @lid TIDAK
 *          pernah dianggap nomor HP, karena angkanya tidak ada hubungannya sama
 *          sekali dan mencocokkannya sebagai nomor akan menghasilkan kecocokan
 *          palsu lewat aturan `endsWith` di `isPhoneMatch`.
 */
export function identitasTarget(targetJid, peserta = null) {
  const target = rapikan(targetJid);
  if (!target) return { jid: [], nomor: null, lid: null };

  const kumpulan = new Set([target]);
  let nomor = target.endsWith('@lid') ? null : (angka(target) || null);
  let lid = target.endsWith('@lid') ? target : null;

  if (Array.isArray(peserta)) {
    const baris = peserta.find(p => {
      const kandidat = [p?.id, p?.jid, p?.lid].map(rapikan).filter(Boolean);
      return kandidat.includes(target);
    });
    if (baris) {
      for (const k of [baris.id, baris.jid, baris.lid].map(rapikan).filter(Boolean)) {
        kumpulan.add(k);
        if (k.endsWith('@lid')) lid = lid || k;
        else nomor = nomor || (angka(k) || null);
      }
    }
  }

  if (nomor && nomor.length < 8) nomor = null;
  return { jid: [...kumpulan], nomor, lid };
}

/**
 * Keputusan murni: apakah sasaran dilindungi dari penyuruh?
 *
 * Dipisah dari pengambilan datanya supaya seluruh aturannya bisa diuji tanpa
 * database, soket, atau grup sungguhan.
 *
 * @param opts.identitas   hasil `identitasTarget`
 * @param opts.ownerNomor  digit nomor Owner dari pengaturan
 * @param opts.ownerJid    JID Owner yang tersimpan (bisa berupa @lid)
 * @param opts.adminNomor  daftar digit nomor Admin Toko
 * @param opts.peranDb     peran dari tabel customers: 'OWNER' | 'ADMIN' | null
 * @param opts.penyuruhOwner apakah yang mengetik perintah adalah Owner
 */
export function putusanPerisai(opts = {}) {
  const {
    identitas = { jid: [], nomor: null, lid: null },
    ownerNomor = '',
    ownerJid = '',
    adminNomor = [],
    peranDb = null,
    penyuruhOwner = false
  } = opts;

  const ownerJidRapi = rapikan(ownerJid);
  const nomor = identitas.nomor;

  let sasaranOwner = false;
  if (peranDb === 'OWNER') sasaranOwner = true;
  if (ownerJidRapi && identitas.jid.includes(ownerJidRapi)) sasaranOwner = true;
  if (nomor && ownerNomor && isPhoneMatch(nomor, normalizePhoneDigits(ownerNomor))) sasaranOwner = true;

  let sasaranAdmin = false;
  if (peranDb === 'ADMIN') sasaranAdmin = true;
  if (nomor) {
    for (const a of adminNomor) {
      const d = normalizePhoneDigits(a);
      if (d && d.length >= 8 && isPhoneMatch(nomor, d)) { sasaranAdmin = true; break; }
    }
  }

  // Owner boleh melakukan apa pun. Termasuk pada dirinya sendiri: kalau Owner
  // memang ingin mengeluarkan dirinya lewat bot, itu keputusannya.
  if (penyuruhOwner) return { dilindungi: false, sasaranOwner, sasaranAdmin, alasan: null };

  if (sasaranOwner) {
    return { dilindungi: true, sasaranOwner, sasaranAdmin, alasan: 'OWNER' };
  }
  if (sasaranAdmin) {
    return { dilindungi: true, sasaranOwner, sasaranAdmin, alasan: 'ADMIN_TOKO' };
  }
  return { dilindungi: false, sasaranOwner, sasaranAdmin, alasan: null };
}

/**
 * Bungkus lengkap: kumpulkan identitas sasaran (metadata grup → peta LID →
 * tabel customers), lalu putuskan.
 *
 * Setiap pembacaan dibungkus try/catch. Perisai yang melempar akan menggagalkan
 * SELURUH perintah moderasi, dan itu kerusakan yang lebih besar daripada
 * lubang yang ditutupnya.
 */
export async function perisaiTarget({ db, targetJid, peserta = null, botSettings = {}, penyuruhOwner = false, ownerBawaan = '', adminBawaan = '' }) {
  const identitas = identitasTarget(targetJid, peserta);

  // Metadata grup tidak selalu memuat nomor HP di baris pesertanya. Peta LID
  // yang terkumpul dari pesan-pesan sebelumnya adalah cadangannya.
  if (!identitas.nomor && identitas.lid && db?.cariNomorDariLid) {
    try {
      const nomor = await db.cariNomorDariLid(identitas.lid);
      if (nomor && String(nomor).length >= 8) identitas.nomor = String(nomor);
    } catch (e) { /* biarkan tidak diketahui — lihat bias saat ragu di atas */ }
  }

  let peranDb = null;
  if (db?.getQuery && identitas.jid.length) {
    try {
      const tanda = identitas.jid.map(() => '?').join(',');
      // OWNER harus menang kalau seseorang punya lebih dari satu baris.
      // `ORDER BY role` biasa akan mendahulukan 'ADMIN' secara alfabet.
      const row = await db.getQuery(
        `SELECT role FROM customers WHERE nomor IN (${tanda}) AND role IN ('OWNER','ADMIN')
          ORDER BY CASE role WHEN 'OWNER' THEN 0 ELSE 1 END LIMIT 1`,
        identitas.jid
      );
      peranDb = row?.role || null;
    } catch (e) { /* peran tidak diketahui */ }
  }

  const adminNomor = String(botSettings.adminNumbers || adminBawaan || '')
    .split(',').map(n => normalizePhoneDigits(n)).filter(d => d && d.length >= 8);

  return {
    ...putusanPerisai({
      identitas,
      ownerNomor: botSettings.ownerNumber || ownerBawaan || '',
      ownerJid: botSettings.ownerJid || '',
      adminNomor,
      peranDb,
      penyuruhOwner
    }),
    identitas
  };
}
