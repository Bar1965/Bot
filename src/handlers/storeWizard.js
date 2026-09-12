/**
 * WIZARD TOKO — bikin produk lewat tanya-jawab di WhatsApp.
 *
 * `.addproduk` sekali ketik menuntut admin hafal urutan sembilan kolom yang
 * dipisah tanda `|`. Dari HP itu tidak realistis, jadi `.tokobaru` menuntun
 * langkah demi langkah.
 *
 * KENAPA MODUL SENDIRI, BUKAN DI groupAdminHandler:
 * groupAdminHandler pulang di baris pertamanya kalau pesan tidak diawali prefix
 * (`. / #`). Jawaban wizard justru teks biasa ("Netflix 1 Bulan"), jadi
 * pencegatnya harus duduk di kepala rantai router di bot.js — sejajar dengan
 * checkPdfMergeSession — bukan di dalam handler yang sudah menolaknya lebih dulu.
 *
 * Modul ini sengaja TIDAK mengimpor bot.js. Ia diimpor OLEH bot.js, jadi impor
 * balik akan menutup siklus (AGENTS.md §16).
 */

import fs from 'fs';
import path from 'path';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import * as db from '../../database.js';

// Sesi aktif per (chat, pengirim). Hanya di memori: wizard yang menggantung saat
// bot restart lebih baik hilang daripada hidup lagi entah di langkah mana.
const sesiToko = new Map();

// Sesi yang didiamkan lebih lama dari ini dianggap ditinggalkan. Tanpa ini,
// sekali admin lupa mengetik `batal`, setiap chat berikutnya ditelan wizard.
const BATAS_DIAM_MS = 10 * 60 * 1000;

const GARIS = '━━━━━━━━━━━━━━━━━━━━';

// Kata kendali yang berlaku di semua langkah.
const KATA_BATAL = ['batal', 'cancel', 'stop', 'keluar'];
const KATA_LEWATI = ['lewati', 'skip', 'kosong', '-'];

function kunciSesi(jid, senderNumber) {
  return `${jid}|${senderNumber}`;
}

function ambilSesi(jid, senderNumber) {
  const kunci = kunciSesi(jid, senderNumber);
  const sesi = sesiToko.get(kunci);
  if (!sesi) return null;
  if (Date.now() - sesi.terakhirAktif > BATAS_DIAM_MS) {
    sesiToko.delete(kunci);
    return null;
  }
  return sesi;
}

export function hapusSesiToko(jid, senderNumber) {
  return sesiToko.delete(kunciSesi(jid, senderNumber));
}

export function adaSesiToko(jid, senderNumber) {
  return !!ambilSesi(jid, senderNumber);
}

/**
 * Urutan langkah pembuatan produk. `opsional: true` berarti boleh dilewati.
 * Langkah `stok` dan `kredensial` saling menggantikan tergantung mode kirim,
 * itu diatur di lanjutkanLangkah().
 */
const LANGKAH = [
  {
    id: 'kode',
    tanya: () =>
      `1️⃣ *KODE PRODUK*\n\nKetik kode singkat yang unik untuk produk ini.\n` +
      `Huruf, angka, \`-\` dan \`_\` saja, 2-40 karakter.\n\n_Contoh:_ \`NET01\`, \`SPOTIFY-3B\``,
    terima: async (sesi, teks) => {
      const cek = db.validasiKodeProduk(teks);
      if (!cek.ok) return { ok: false, message: cek.message };
      const sudahAda = await db.getProductByKode(cek.nilai);
      if (sudahAda) {
        return {
          ok: false,
          message:
            `Kode *${cek.nilai}* sudah dipakai produk *${sudahAda.nama}*.\n\n` +
            `Pakai kode lain, atau sunting yang lama dengan \`.editproduk ${cek.nilai} harga 50000\`.`
        };
      }
      sesi.data.kode = cek.nilai;
      return { ok: true };
    }
  },
  {
    id: 'nama',
    tanya: (sesi) =>
      `2️⃣ *NAMA PRODUK* (kode: \`${sesi.data.kode}\`)\n\n` +
      `Nama yang dilihat pembeli di katalog.\n\n_Contoh:_ Netflix Premium 1 Bulan`,
    terima: async (sesi, teks) => {
      const cek = db.validasiFieldProduk('nama', teks);
      if (!cek.ok) return { ok: false, message: cek.message };
      sesi.data.nama = cek.nilai;
      return { ok: true };
    }
  },
  {
    id: 'harga',
    tanya: () =>
      `3️⃣ *HARGA JUAL*\n\nKetik angkanya saja.\n\n_Boleh ditulis:_ \`50000\`, \`50.000\`, atau \`50rb\``,
    terima: async (sesi, teks) => {
      const cek = db.validasiFieldProduk('harga', teks);
      if (!cek.ok) return { ok: false, message: cek.message };
      sesi.data.harga = cek.nilai;
      return { ok: true };
    }
  },
  {
    id: 'kategori',
    opsional: true,
    tanya: () =>
      `4️⃣ *KATEGORI / BRAND* _(boleh dilewati)_\n\n` +
      `Dipakai untuk mengelompokkan produk di katalog.\n\n_Contoh:_ NETFLIX, SPOTIFY, CANVA\n\n` +
      `Ketik \`lewati\` kalau tidak perlu.`,
    terima: async (sesi, teks) => {
      const cek = db.validasiFieldProduk('kategori', teks);
      if (!cek.ok) return { ok: false, message: cek.message };
      sesi.data.kategori = cek.nilai;
      return { ok: true };
    }
  },
  {
    id: 'durasi',
    opsional: true,
    tanya: () =>
      `5️⃣ *DURASI / MASA AKTIF* _(boleh dilewati)_\n\n` +
      `Dipakai juga untuk menghitung masa garansi.\n\n_Contoh:_ 1 Bulan, 30 Hari, 1 Tahun\n\n` +
      `Ketik \`lewati\` kalau produk ini tanpa masa aktif.`,
    terima: async (sesi, teks) => {
      const cek = db.validasiFieldProduk('durasi', teks);
      if (!cek.ok) return { ok: false, message: cek.message };
      sesi.data.durasi = cek.nilai;
      return { ok: true };
    }
  },
  {
    id: 'deskripsi',
    opsional: true,
    tanya: () =>
      `6️⃣ *DESKRIPSI* _(boleh dilewati)_\n\n` +
      `Keterangan singkat yang dibaca pembeli.\n\n_Contoh:_ Sharing 1 profil, garansi penuh 30 hari.\n\n` +
      `Ketik \`lewati\` kalau tidak perlu.`,
    terima: async (sesi, teks) => {
      const cek = db.validasiFieldProduk('deskripsi', teks);
      if (!cek.ok) return { ok: false, message: cek.message };
      sesi.data.deskripsi = cek.nilai;
      return { ok: true };
    }
  },
  {
    id: 'mode',
    tanya: () =>
      `7️⃣ *MODE PENGIRIMAN*\n\n` +
      `Ketik *AUTO* atau *MANUAL*.\n\n` +
      `⚡ *AUTO* — bot mengirim sendiri akun/voucher dari stok begitu pembayaran lunas. ` +
      `Ini yang bikin toko jalan tanpa kamu pegang HP.\n` +
      `👨‍💼 *MANUAL* — kamu yang kirim sendiri setelah ada notifikasi.`,
    terima: async (sesi, teks) => {
      const cek = db.validasiFieldProduk('mode', teks);
      if (!cek.ok) return { ok: false, message: cek.message };
      sesi.data.mode = cek.nilai;
      return { ok: true };
    }
  },
  {
    id: 'stok',
    // Hanya untuk produk MANUAL. Produk AUTO stoknya dihitung dari kredensial.
    tanya: () => `8️⃣ *JUMLAH STOK*\n\nKetik jumlah stok awal produk MANUAL ini.\n\n_Contoh:_ \`10\``,
    terima: async (sesi, teks) => {
      const angka = parseInt(String(teks).replace(/[^\d]/g, ''), 10);
      if (!Number.isInteger(angka) || angka < 0 || angka > 1000000) {
        return { ok: false, message: 'Stok harus bilangan bulat 0 sampai 1.000.000.' };
      }
      sesi.data.stok = angka;
      return { ok: true };
    }
  },
  {
    id: 'kredensial',
    opsional: true,
    // Hanya untuk produk AUTO.
    tanya: () =>
      `8️⃣ *ISI STOK AKUN / VOUCHER* _(boleh dilewati)_\n\n` +
      `Tempel akunnya, *satu per baris*. Satu baris = satu stok.\n\n` +
      `_Contoh:_\n\`\`\`akun1@gmail.com|pass123\nakun2@gmail.com|pass456\`\`\`\n\n` +
      `Ketik \`lewati\` kalau mau diisi nanti pakai \`.addstock\`.`,
    terima: async (sesi, teks) => {
      const baris = String(teks)
        .split('\n')
        .map(b => b.trim())
        .filter(b => b.length > 0 && b.length <= 5000);
      if (baris.length === 0) {
        return { ok: false, message: 'Belum ada baris akun yang terbaca. Tempel minimal satu baris, atau ketik `lewati`.' };
      }
      sesi.data.kredensial = baris;
      return { ok: true };
    }
  },
  {
    id: 'gambar',
    opsional: true,
    terimaGambar: true,
    tanya: () =>
      `9️⃣ *GAMBAR PRODUK* _(boleh dilewati)_\n\n` +
      `Kirim langsung fotonya ke chat ini, atau tempel URL gambar.\n\n` +
      `Ketik \`lewati\` kalau tidak pakai gambar.`,
    terima: async (sesi, teks) => {
      const cek = db.validasiFieldProduk('gambar', teks);
      if (!cek.ok) return { ok: false, message: cek.message };
      sesi.data.gambar = cek.nilai;
      return { ok: true };
    }
  }
];

function cariLangkah(id) {
  return LANGKAH.find(l => l.id === id) || null;
}

/**
 * Tentukan langkah berikutnya, dengan melompati langkah yang tidak relevan untuk
 * mode kirim yang dipilih. Mengembalikan null kalau sudah habis (siap konfirmasi).
 */
function langkahBerikutnya(sesi) {
  let idx = LANGKAH.findIndex(l => l.id === sesi.langkah);
  for (let i = idx + 1; i < LANGKAH.length; i++) {
    const l = LANGKAH[i];
    if (l.id === 'stok' && sesi.data.mode !== 'MANUAL') continue;
    if (l.id === 'kredensial' && sesi.data.mode !== 'AUTO') continue;
    return l;
  }
  return null;
}

function ringkasan(sesi) {
  const d = sesi.data;
  const baris = [
    `${GARIS}`,
    `🧾 *PERIKSA DULU SEBELUM DISIMPAN*`,
    `${GARIS}`,
    `• *Kode:* \`${d.kode}\``,
    `• *Nama:* ${d.nama}`,
    `• *Harga:* Rp${(d.harga || 0).toLocaleString('id-ID')}`,
    `• *Kategori:* ${d.kategori || '_(kosong)_'}`,
    `• *Durasi:* ${d.durasi || '_(kosong)_'}`,
    `• *Deskripsi:* ${d.deskripsi || '_(kosong)_'}`,
    `• *Mode kirim:* ${d.mode === 'AUTO' ? '⚡ AUTO (kirim sendiri)' : '👨‍💼 MANUAL'}`
  ];

  if (d.mode === 'AUTO') {
    const n = (d.kredensial || []).length;
    baris.push(`• *Stok akun:* ${n > 0 ? `${n} pcs siap kirim` : '_(belum diisi)_'}`);
  } else {
    baris.push(`• *Stok:* ${d.stok ?? 0} pcs`);
  }
  baris.push(`• *Gambar:* ${d.gambar ? '✅ ada' : '_(kosong)_'}`);
  baris.push(GARIS);
  baris.push(`Ketik *YA* untuk menyimpan, atau *batal* untuk membuang.`);
  return baris.join('\n');
}

async function kirimLangkah(sock, jid, sesi) {
  const langkah = cariLangkah(sesi.langkah);
  if (!langkah) return;
  // Nomor langkah sudah tertulis di tiap pertanyaan. Menghitungnya lagi dari
  // indeks array akan meleset, karena 'stok' dan 'kredensial' menempati posisi
  // yang sama dan hanya salah satu yang pernah dijalankan.
  const jejak = '_Ketik `batal` kapan saja untuk berhenti._';
  await sock.sendMessage(jid, { text: `${langkah.tanya(sesi)}\n\n${jejak}` });
}

/**
 * Mulai wizard pembuatan produk. Dipanggil `.tokobaru` dari groupAdminHandler,
 * yang sudah melewati guard Admin Toko / Owner lebih dulu.
 */
export async function mulaiWizardProduk(sock, jid, senderNumber) {
  const sesi = {
    jenis: 'PRODUK_BARU',
    langkah: LANGKAH[0].id,
    data: {},
    terakhirAktif: Date.now()
  };
  sesiToko.set(kunciSesi(jid, senderNumber), sesi);

  await sock.sendMessage(jid, {
    text:
      `${GARIS}\n🏪 *BIKIN PRODUK BARU*\n${GARIS}\n\n` +
      `Saya tuntun sembilan langkah. Jawab satu per satu di chat ini.\n\n` +
      `• \`lewati\` — lompati pertanyaan yang boleh kosong\n` +
      `• \`batal\` — berhenti tanpa menyimpan apa pun\n\n` +
      `_Tidak ada yang tersimpan sampai kamu menekan konfirmasi di akhir._`
  });
  await kirimLangkah(sock, jid, sesi);
  return true;
}

/**
 * Simpan produk hasil wizard. Urutannya penting: addProduct dulu, baru kredensial,
 * karena addProductItemsBatch menolak kode yang produknya belum ada dan sekaligus
 * yang menyetel ulang kolom stok untuk produk AUTO.
 */
async function simpanProduk(sock, jid, sesi) {
  const d = sesi.data;
  const stokAwal = d.mode === 'AUTO' ? 0 : (d.stok ?? 0);

  await db.addProduct(
    d.kode,
    d.nama,
    d.harga,
    stokAwal,
    d.deskripsi || '',
    d.gambar || '',
    d.mode,
    '',
    '',
    d.kategori || null,
    null,
    d.durasi || null
  );

  let jumlahKredensial = 0;
  if (d.mode === 'AUTO' && Array.isArray(d.kredensial) && d.kredensial.length > 0) {
    const hasil = await db.addProductItemsBatch(d.kode, d.kredensial);
    if (!hasil.success) {
      await sock.sendMessage(jid, {
        text: `⚠️ Produk *${d.kode}* tersimpan, tapi stok akunnya gagal masuk: ${hasil.message}\n\nCoba isi ulang dengan \`.addstock ${d.kode}\`.`
      });
    } else {
      jumlahKredensial = hasil.readyCount;
    }
  }

  const siapJual = d.mode === 'AUTO' ? jumlahKredensial > 0 : stokAwal > 0;
  let pesan =
    `${GARIS}\n✅ *PRODUK BARU TERSIMPAN*\n${GARIS}\n` +
    `📦 *${d.nama}* (\`${d.kode}\`)\n` +
    `💸 Rp${(d.harga || 0).toLocaleString('id-ID')}\n` +
    `🚀 Mode kirim: *${d.mode}*\n`;

  if (d.mode === 'AUTO') {
    pesan += `🔑 Stok akun siap kirim: *${jumlahKredensial} pcs*\n`;
  } else {
    pesan += `📊 Stok: *${stokAwal} pcs*\n`;
  }
  pesan += `${GARIS}\n`;

  if (siapJual) {
    pesan += d.mode === 'AUTO'
      ? `⚡ Produk ini sudah *siap jual otomatis*. Begitu pembayaran lunas, akun dikirim sendiri ke pembeli.\n\n`
      : `✅ Produk sudah tampil di katalog dan siap dipesan.\n\n`;
  } else {
    pesan += d.mode === 'AUTO'
      ? `⚠️ Stok masih kosong, jadi produk belum bisa dibeli. Isi dengan:\n\`.addstock ${d.kode}\`\n\n`
      : `⚠️ Stok masih 0, jadi produk belum bisa dibeli. Isi dengan:\n\`.stock ${d.kode} 10\`\n\n`;
  }

  pesan += `💡 _Ubah kapan saja:_ \`.editproduk ${d.kode} harga 55000\``;
  if (!d.gambar) pesan += `\n🖼️ _Pasang gambar:_ kirim foto dengan caption \`.setgambar ${d.kode}\``;

  await sock.sendMessage(jid, { text: pesan });
  await db.addLog('SYSTEM', `Produk ${d.kode} (${d.nama}) dibuat lewat wizard WhatsApp.`);
}

/**
 * Simpan foto yang dikirim admin ke public/uploads/products dan kembalikan path
 * webnya. Penamaannya mengikuti multer di authMiddleware.js supaya berkas dari
 * WhatsApp dan dari dashboard duduk di satu folder dengan pola yang sama.
 */
export async function simpanGambarProduk(messageObj, kode) {
  const buffer = await downloadMediaMessage(messageObj, 'buffer', {});
  if (!buffer || buffer.length === 0) {
    throw new Error('Gambar gagal diunduh dari WhatsApp.');
  }
  const dir = './public/uploads/products';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const kodeBersih = String(kode || 'PROD').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'PROD';
  const namaBerkas = `${kodeBersih}_${Date.now()}.jpg`;
  fs.writeFileSync(path.join(dir, namaBerkas), buffer);
  return `/uploads/products/${namaBerkas}`;
}

function ambilPesanGambar(m) {
  return m?.message?.imageMessage
    ? m
    : (m?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage
        ? { ...m, message: m.message.extendedTextMessage.contextInfo.quotedMessage }
        : null);
}

/**
 * Pencegat jawaban wizard. Dipasang di kepala rantai router bot.js, sejajar
 * dengan checkPdfMergeSession.
 *
 * Mengembalikan true HANYA kalau pesan ini benar-benar dimakan sebagai jawaban
 * wizard. Semua jalur lain mengembalikan false supaya pesan mengalir normal —
 * termasuk saat tidak ada sesi sama sekali, yang merupakan keadaan 99,9% pesan.
 */
export async function checkStoreWizardSession(sock, m, senderNumber, jid, msgText) {
  const sesi = ambilSesi(jid, senderNumber);
  if (!sesi) return false;

  const teksMentah = String(msgText || '');
  const teks = teksMentah.trim();
  const teksKecil = teks.toLowerCase();

  // Perintah ber-prefix bukan jawaban wizard. Daripada menelannya (dan membuat
  // admin merasa botnya macet), wizard mundur dan pesannya diteruskan normal.
  if (/^[./#]/.test(teks)) {
    hapusSesiToko(jid, senderNumber);
    await sock.sendMessage(jid, {
      text: `ℹ️ Wizard produk dibatalkan karena kamu mengetik perintah lain.\n\n_Ketik \`.tokobaru\` untuk mulai lagi dari awal._`
    });
    return false;
  }

  sesi.terakhirAktif = Date.now();

  if (KATA_BATAL.includes(teksKecil)) {
    hapusSesiToko(jid, senderNumber);
    await sock.sendMessage(jid, { text: '🚫 Wizard dibatalkan. Tidak ada produk yang disimpan.' });
    return true;
  }

  // Tahap konfirmasi akhir.
  if (sesi.langkah === 'KONFIRMASI') {
    if (['ya', 'y', 'ok', 'oke', 'simpan', 'lanjut'].includes(teksKecil)) {
      hapusSesiToko(jid, senderNumber);
      try {
        await simpanProduk(sock, jid, sesi);
      } catch (err) {
        console.error('[STORE_WIZARD] Gagal menyimpan produk:', err.message);
        await sock.sendMessage(jid, { text: `❌ Gagal menyimpan produk: ${err.message}` });
      }
      return true;
    }
    await sock.sendMessage(jid, { text: 'Ketik *YA* untuk menyimpan, atau *batal* untuk membuang.' });
    return true;
  }

  const langkah = cariLangkah(sesi.langkah);
  if (!langkah) {
    hapusSesiToko(jid, senderNumber);
    return false;
  }

  // Langkah gambar menerima foto, bukan cuma teks.
  const pesanGambar = langkah.terimaGambar ? ambilPesanGambar(m) : null;
  if (pesanGambar) {
    try {
      sesi.data.gambar = await simpanGambarProduk(pesanGambar, sesi.data.kode);
      await sock.sendMessage(jid, { text: '🖼️ Gambar tersimpan.' });
    } catch (err) {
      console.error('[STORE_WIZARD] Gagal menyimpan gambar:', err.message);
      await sock.sendMessage(jid, { text: `⚠️ Gambar gagal disimpan: ${err.message}\n\nKetik \`lewati\` untuk melanjutkan tanpa gambar.` });
      return true;
    }
  } else if (KATA_LEWATI.includes(teksKecil)) {
    if (!langkah.opsional) {
      await sock.sendMessage(jid, { text: '⚠️ Langkah ini wajib diisi, tidak bisa dilewati.' });
      return true;
    }
  } else {
    if (!teks) return true;
    // Kredensial sengaja memakai teks mentah: pembatas antar akun adalah baris baru.
    const isian = langkah.id === 'kredensial' ? teksMentah : teks;
    const hasil = await langkah.terima(sesi, isian);
    if (!hasil.ok) {
      await sock.sendMessage(jid, { text: `⚠️ ${hasil.message}\n\n_Coba ketik ulang, atau \`batal\` untuk berhenti._` });
      return true;
    }
  }

  const berikutnya = langkahBerikutnya(sesi);
  if (berikutnya) {
    sesi.langkah = berikutnya.id;
    await kirimLangkah(sock, jid, sesi);
  } else {
    sesi.langkah = 'KONFIRMASI';
    await sock.sendMessage(jid, { text: ringkasan(sesi) });
  }
  return true;
}
