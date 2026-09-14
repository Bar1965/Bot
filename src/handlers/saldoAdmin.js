/**
 * SALDO ADMIN — perintah owner untuk menyentuh saldo deposit pelanggan.
 *
 * Modul ini berdiri sendiri, bukan disisipkan ke groupAdminHandler, karena
 * isinya satu-satunya jalur di seluruh bot yang bisa MENCETAK saldo dari nol.
 * Semua yang lain hanya memindahkan uang yang sudah ada: `.paid` melunaskan
 * tagihan yang nominalnya sudah tercatat, checkout memotong saldo yang sudah
 * dimiliki. `.isisaldo` berbeda sifatnya — bot cuma percaya bahwa owner sudah
 * menerima uangnya di dunia nyata.
 *
 * Karena itu ada tiga pengaman, ketiganya diminta owner sendiri:
 *
 *   1. OWNER SAJA. Admin toko — termasuk nomor kedua yang terdaftar di
 *      `adminNumbers` — tidak bisa menjalankannya. Mereka tetap bisa `.paid`,
 *      yang hanya mengonfirmasi tagihan yang memang sudah ada.
 *
 *   2. SELALU KONFIRMASI, berapa pun nominalnya. Bukan lewat "YA" melainkan
 *      lewat kode sekali pakai yang tercetak di dalam pesan rincian. Kenapa
 *      begitu: "YA" bisa terketik karena kebiasaan pada layar yang salah, dan
 *      tidak memaksa siapa pun membaca nama yang sudah diresolusi. Kode acak
 *      memaksa mata melewati baris nama dan nominal sebelum bisa menyalinnya,
 *      dan tidak bisa dipakai ulang.
 *
 *   3. IDENTITAS DIRESOLUSI, TIDAK DIRAKIT. Nomor HP tidak pernah diubah jadi
 *      `<digit>@s.whatsapp.net` — 231 dari 236 pelanggan toko ini tersimpan
 *      sebagai `@lid` (AGENTS.md §9a). Merakit JID akan membuat saldo masuk ke
 *      baris hantu yang tidak dimiliki siapa pun, dan bot tetap membalas
 *      "berhasil". Kalau identitasnya tidak bisa dipastikan, perintahnya
 *      DITOLAK.
 *
 * Tidak mengimpor bot.js, jadi bebas dari siklus impor (AGENTS.md §16).
 */

import crypto from 'crypto';
import * as db from '../../database.js';
import { tanggalJamWib } from '../utils/waktu.js';

/** Batas nominal sekali jalan, disamakan dengan batas harga produk & deposit. */
const NOMINAL_MAKS = 1_000_000_000;

/** Konfirmasi kedaluwarsa cepat: ini uang, bukan formulir. */
const KEDALUWARSA_MS = 2 * 60 * 1000;

/**
 * Satu permintaan tertunda per owner. Disimpan di memori dengan sengaja — kalau
 * bot mati sebelum dikonfirmasi, permintaannya HILANG. Itu perilaku yang
 * diinginkan: konfirmasi yang selamat melewati restart berarti saldo bisa
 * bertambah karena perintah yang sudah dilupakan orangnya.
 */
const tertunda = new Map();

function buatKode() {
  // Tanpa huruf/angka yang gampang tertukar (0/O, 1/I) supaya tidak salah ketik.
  const abjad = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const acak = crypto.randomBytes(5);
  return Array.from(acak).map(b => abjad[b % abjad.length]).join('');
}

function bersihkanKedaluwarsa() {
  const sekarang = Date.now();
  for (const [kunci, nilai] of tertunda) {
    if (sekarang - nilai.dibuat > KEDALUWARSA_MS) tertunda.delete(kunci);
  }
}

/**
 * Pemeriksaan owner yang KETAT, terpisah dari `isOwner` milik groupAdminHandler.
 *
 * Pemeriksaan di sana melonggarkan diri dengan `.includes()` pada potongan JID
 * (`senderCleanJid.includes(storedOwnerJid.split('@')[0])`). Untuk membuka menu
 * itu tidak apa-apa; untuk mencetak uang tidak. Di sini identitas dibandingkan
 * lewat samaOrangnya, yang menerjemahkan @lid lewat peta nomor dan menolak
 * menebak saat pemetaannya tidak ada.
 */
async function benarBenarOwner(senderNumber) {
  if (!senderNumber) return false;
  try {
    const s = await db.getSettings();
    const kandidat = [s?.ownerJid, s?.ownerNumber].filter(Boolean);
    if (kandidat.length === 0) return false;
    for (const o of kandidat) {
      if (await db.samaOrangnya(senderNumber, o)) return true;
    }
  } catch (err) {
    console.error('[SALDO_ADMIN] Gagal memeriksa owner:', err.message);
  }
  return false;
}

function rupiah(n) {
  return `Rp${Number(n || 0).toLocaleString('id-ID')}`;
}

/**
 * Perintah saldo milik owner. Mengembalikan true kalau pesannya sudah ditangani.
 */
export async function handleSaldoOwner({ sock, jid, senderNumber, args, cleanCmd }) {
  const PERINTAH = ['isisaldo', 'tambahsaldo', 'tariksaldo', 'ceksaldo', 'totalsaldo', 'saldook'];
  if (!PERINTAH.includes(cleanCmd)) return false;

  // Gerbang pertama dan terakhir. Sengaja tidak memberi tahu perintahnya ada —
  // yang bukan owner tidak perlu tahu ada jalur pencetak saldo.
  if (!(await benarBenarOwner(senderNumber))) {
    await sock.sendMessage(jid, {
      text: '❌ Perintah ini hanya untuk *Owner*.'
    });
    return true;
  }

  bersihkanKedaluwarsa();

  // ── .totalsaldo — berapa uang pelanggan yang sedang dipegang toko ──────────
  if (cleanCmd === 'totalsaldo') {
    const ringkas = await db.totalSaldoPelanggan();
    let teks = `💰 *SALDO PELANGGAN YANG DIPEGANG TOKO*\n`;
    teks += `━━━━━━━━━━━━━━━━━━━━\n`;
    teks += `Total: *${rupiah(ringkas.total)}*\n`;
    teks += `Pemilik saldo: *${ringkas.jumlahPemilik} orang*\n`;
    teks += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    if (ringkas.teratas.length) {
      teks += `*Saldo terbesar:*\n`;
      ringkas.teratas.forEach((c, i) => {
        teks += `${i + 1}. ${c.nama || 'Pelanggan'} — ${rupiah(c.balance)}\n`;
      });
      teks += `\n`;
    }
    teks += `_Angka ini adalah UTANG toko, bukan pendapatan: uang pelanggan yang belum mereka belanjakan._`;
    await sock.sendMessage(jid, { text: teks });
    return true;
  }

  // ── .saldook <kode> — eksekusi permintaan yang tertunda ────────────────────
  if (cleanCmd === 'saldook') {
    const kode = String(args[1] || '').trim().toUpperCase();
    const minta = tertunda.get(senderNumber);

    if (!minta) {
      await sock.sendMessage(jid, { text: '⚠️ Tidak ada permintaan saldo yang menunggu konfirmasi.\n\n_Mungkin sudah lewat 2 menit dan dibatalkan otomatis._' });
      return true;
    }
    if (!kode || kode !== minta.kode) {
      await sock.sendMessage(jid, { text: `❌ Kode konfirmasi salah.\n\nKode yang benar ada di pesan rincian sebelumnya. Ketik \`.saldook ${'<kode>'}\` persis seperti tertulis di sana.` });
      return true;
    }

    // Sekali pakai: dihapus SEBELUM dieksekusi, supaya kode yang sama tidak bisa
    // dijalankan dua kali kalau pesannya terkirim ganda.
    tertunda.delete(senderNumber);

    if (minta.aksi === 'isi') {
      const hasil = await db.addCustomerBalance(
        minta.jid,
        minta.nominal,
        'DEPOSIT_MANUAL',
        `Top up manual oleh owner${minta.catatan ? ` — ${minta.catatan}` : ''}`
      );
      if (!hasil.success) {
        await sock.sendMessage(jid, { text: `❌ Gagal menambah saldo: ${hasil.reason || 'tidak diketahui'}` });
        return true;
      }

      await sock.sendMessage(jid, {
        text: `✅ *SALDO DITAMBAHKAN*\n\n` +
              `👤 ${minta.nama}\n` +
              `➕ ${rupiah(minta.nominal)}\n` +
              `💳 Saldo sekarang: *${rupiah(hasil.newBalance)}*\n` +
              (minta.catatan ? `📝 ${minta.catatan}\n` : '') +
              `\n_Pelanggan sudah diberi tahu._`
      });

      try {
        await sock.sendMessage(minta.jid, {
          text: `💰 *SALDO DEPOSIT ANDA BERTAMBAH*\n\n` +
                `➕ ${rupiah(minta.nominal)}\n` +
                `💳 Saldo sekarang: *${rupiah(hasil.newBalance)}*\n` +
                (minta.catatan ? `📝 Keterangan: ${minta.catatan}\n` : '') +
                `\nSaldo bisa langsung dipakai belanja — checkout tidak perlu scan QRIS lagi.\n\n` +
                `_Cek kapan saja dengan_ \`.saldo\``
        });
      } catch (err) {
        await sock.sendMessage(jid, { text: `⚠️ Saldo sudah masuk, tapi pemberitahuan ke pelanggan gagal terkirim: ${err.message}` });
      }

      await db.addLog('BALANCE', `💰 Owner menambah saldo ${rupiah(minta.nominal)} untuk ${minta.jid} (saldo jadi ${rupiah(hasil.newBalance)})`);
      return true;
    }

    // aksi === 'tarik'
    const hasil = await db.tarikSaldoOwner(minta.jid, minta.nominal, minta.catatan, senderNumber);
    if (!hasil.success) {
      await sock.sendMessage(jid, { text: `❌ ${hasil.message || 'Gagal menarik saldo.'}` });
      return true;
    }

    await sock.sendMessage(jid, {
      text: `✅ *SALDO DITARIK*\n\n` +
            `👤 ${minta.nama}\n` +
            `➖ ${rupiah(minta.nominal)}\n` +
            `💳 Saldo sekarang: *${rupiah(hasil.newBalance)}*\n` +
            `📝 Alasan: ${minta.catatan}\n\n` +
            `_Pelanggan sudah diberi tahu._`
    });

    try {
      await sock.sendMessage(minta.jid, {
        text: `⚠️ *KOREKSI SALDO DEPOSIT*\n\n` +
              `➖ ${rupiah(minta.nominal)}\n` +
              `💳 Saldo sekarang: *${rupiah(hasil.newBalance)}*\n` +
              `📝 Alasan: ${minta.catatan}\n\n` +
              `_Kalau menurut Anda ini keliru, langsung balas pesan ini._`
      });
    } catch (err) {
      await sock.sendMessage(jid, { text: `⚠️ Saldo sudah ditarik, tapi pemberitahuan ke pelanggan gagal terkirim: ${err.message}` });
    }

    await db.addLog('BALANCE', `⚠️ Owner menarik saldo ${rupiah(minta.nominal)} dari ${minta.jid} — ${minta.catatan}`);
    return true;
  }

  // ── Sisanya butuh nomor tujuan ────────────────────────────────────────────
  const targetMentah = args[1];
  if (!targetMentah) {
    const contoh = cleanCmd === 'ceksaldo'
      ? '`.ceksaldo 628123456789`'
      : cleanCmd === 'tariksaldo'
        ? '`.tariksaldo 628123456789 50rb salah kirim`'
        : '`.isisaldo 628123456789 50rb`';
    await sock.sendMessage(jid, { text: `⚠️ Sertakan nomor pelanggannya.\n\n_Contoh:_ ${contoh}\n\n_Atau balas (reply) pesan pelanggannya._` });
    return true;
  }

  const sasaran = await db.resolveTargetJid(targetMentah);
  if (!sasaran.ditemukan) {
    await sock.sendMessage(jid, {
      text: `❌ Nomor *${targetMentah}* tidak dikenali.\n\n` +
            `Bot tidak akan menebak identitas untuk perintah yang menyentuh uang — saldo bisa masuk ke akun yang tidak dimiliki siapa pun.\n\n` +
            `💡 Minta pelanggannya mengirim satu pesan dulu, atau *balas (reply)* pesannya lalu ketik perintahnya.`
    });
    return true;
  }

  // Pelanggannya HARUS sudah ada. Dua alasan:
  //
  // 1. resolveTargetJid memulangkan `ditemukan: true` untuk string APA PUN yang
  //    memuat '@' — ia tidak memeriksa apakah akunnya benar-benar ada. Salah
  //    ketik seperti `.isisaldo 628xx@lid 500rb` akan lolos.
  // 2. addCustomerBalance memanggil getOrCreateCustomer, jadi ia dengan senang
  //    hati MEMBUAT baris pelanggan baru dan mengisinya saldo. Uangnya masuk ke
  //    akun yang tidak dimiliki siapa pun, dan bot membalas "berhasil".
  //
  // Saldo hanya boleh diberikan kepada orang yang memang sudah pernah memakai
  // bot ini.
  const barisPelanggan = await db.getQuery(
    "SELECT nomor, nama FROM customers WHERE nomor = ?",
    [sasaran.jid]
  );
  if (!barisPelanggan) {
    await sock.sendMessage(jid, {
      text: `❌ *${sasaran.jid}* belum terdaftar sebagai pelanggan.\n\n` +
            `Bot tidak akan membuat akun baru hanya untuk menampung saldo — uangnya bisa masuk ke akun yang tidak dimiliki siapa pun.\n\n` +
            `💡 Minta orangnya mengetik \`.daftar Nama\` dulu, lalu ulangi perintah ini.`
    });
    return true;
  }

  const profil = await db.getCustomerMembershipProfile(sasaran.jid);
  const saldoKini = await db.getCustomerBalance(sasaran.jid);
  const namaTarget = profil?.nama || barisPelanggan.nama || 'Pelanggan';

  // ── .ceksaldo — lihat saldo + riwayatnya ──────────────────────────────────
  if (cleanCmd === 'ceksaldo') {
    const riwayat = await db.riwayatSaldo(sasaran.jid, 10);
    let teks = `💳 *SALDO PELANGGAN*\n━━━━━━━━━━━━━━━━━━━━\n`;
    teks += `👤 ${namaTarget}\n`;
    teks += `📱 ${sasaran.jid}\n`;
    teks += `💰 Saldo: *${rupiah(saldoKini)}*\n`;
    teks += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    if (riwayat.length === 0) {
      teks += `_Belum ada riwayat perubahan saldo._`;
    } else {
      teks += `*10 perubahan terakhir:*\n`;
      for (const r of riwayat) {
        const tanda = ['PURCHASE', 'ADJUSTMENT'].includes(r.type) ? '➖' : '➕';
        teks += `${tanda} ${rupiah(r.amount)} · ${r.type}\n`;
        teks += `   _${tanggalJamWib(r.created_at)}_\n`;
        if (r.description) teks += `   ${String(r.description).slice(0, 80)}\n`;
      }
    }
    await sock.sendMessage(jid, { text: teks });
    return true;
  }

  // ── .isisaldo / .tariksaldo — siapkan konfirmasi ──────────────────────────
  const nominal = db.parseHargaIndonesia(args[2]);
  if (nominal === null || nominal <= 0) {
    await sock.sendMessage(jid, { text: `⚠️ Nominal tidak terbaca.\n\nBoleh ditulis \`50000\`, \`50.000\`, atau \`50rb\`.` });
    return true;
  }
  if (nominal > NOMINAL_MAKS) {
    await sock.sendMessage(jid, { text: `⚠️ Nominal terlalu besar. Maksimal *${rupiah(NOMINAL_MAKS)}* sekali jalan.` });
    return true;
  }

  const catatan = args.slice(3).join(' ').trim();
  const aksi = cleanCmd === 'tariksaldo' ? 'tarik' : 'isi';

  // Penarikan WAJIB beralasan: catatan itu ikut dikirim ke pelanggan, dan
  // pengurangan saldo tanpa penjelasan adalah cara tercepat kehilangan pembeli.
  if (aksi === 'tarik' && !catatan) {
    await sock.sendMessage(jid, {
      text: `⚠️ Penarikan saldo wajib disertai alasan — alasannya ikut dikirim ke pelanggan.\n\n_Contoh:_ \`.tariksaldo ${targetMentah} ${args[2]} salah input nominal\``
    });
    return true;
  }

  if (aksi === 'tarik' && nominal > saldoKini) {
    await sock.sendMessage(jid, {
      text: `❌ Saldo ${namaTarget} cuma *${rupiah(saldoKini)}*, tidak cukup untuk ditarik ${rupiah(nominal)}.\n\n_Saldo tidak boleh jadi minus._`
    });
    return true;
  }

  const kode = buatKode();
  const sebelumnya = tertunda.get(senderNumber);
  tertunda.set(senderNumber, {
    aksi,
    jid: sasaran.jid,
    nama: namaTarget,
    nominal,
    catatan,
    kode,
    dibuat: Date.now()
  });

  const saldoSesudah = aksi === 'isi' ? saldoKini + nominal : saldoKini - nominal;

  let teks = aksi === 'isi'
    ? `⚠️ *KONFIRMASI TAMBAH SALDO*\n`
    : `⚠️ *KONFIRMASI TARIK SALDO*\n`;
  teks += `━━━━━━━━━━━━━━━━━━━━\n`;
  teks += `👤 Nama: *${namaTarget}*\n`;
  teks += `📱 Akun: ${sasaran.jid}\n`;
  teks += `💳 Saldo sekarang: ${rupiah(saldoKini)}\n`;
  teks += `${aksi === 'isi' ? '➕' : '➖'} ${aksi === 'isi' ? 'Ditambah' : 'Ditarik'}: *${rupiah(nominal)}*\n`;
  teks += `💰 Saldo jadi: *${rupiah(saldoSesudah)}*\n`;
  if (catatan) teks += `📝 ${aksi === 'isi' ? 'Catatan' : 'Alasan'}: ${catatan}\n`;
  teks += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  teks += `*Periksa namanya dulu.* Kalau sudah benar, ketik:\n`;
  teks += `\`.saldook ${kode}\`\n\n`;
  teks += `_Berlaku 2 menit. Abaikan saja kalau salah._`;
  if (sebelumnya) {
    teks += `\n\n_Catatan: permintaan sebelumnya (kode ${sebelumnya.kode}) dibatalkan dan diganti yang ini._`;
  }

  await sock.sendMessage(jid, { text: teks });
  return true;
}

/** Dipakai uji: kosongkan permintaan tertunda. */
export function resetSesiSaldo() {
  tertunda.clear();
}

/** Dipakai uji: berapa permintaan yang sedang menunggu. */
export function jumlahSesiSaldo() {
  return tertunda.size;
}
