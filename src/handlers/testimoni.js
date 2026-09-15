/**
 * TESTIMONI & BUKTI TRANSAKSI — PENYUSUN TEKS MURNI
 *
 * Berkas ini hanya menyusun teks dan mengurai balasan. Ia TIDAK menyentuh
 * database, socket WhatsApp, atau pesanan — semua data sudah disiapkan oleh
 * pemanggilnya. Karena itu seluruh isinya bisa diuji tanpa sesi WhatsApp;
 * lihat scripts/testimoniSmokeTest.mjs.
 *
 * ── Dua hal yang sengaja DIPISAH ────────────────────────────────────────────
 *
 * 1. BUKTI TRANSAKSI — catatan penjualan otomatis. Isinya fakta: produk apa
 *    terjual, jam berapa, ke nomor yang disamarkan. Bot yang menulisnya, dan
 *    bot tidak berpura-pura jadi pembeli.
 *
 * 2. TESTIMONI — kalimat pembeli sendiri, beserta bintangnya. HANYA muncul
 *    kalau orangnya betul-betul membalas.
 *
 * Menggabungkan keduanya — misalnya bot otomatis menulis "⭐⭐⭐⭐⭐ mantap!"
 * atas nama setiap pembeli — akan membuat seluruh testimoni di toko ini tidak
 * bernilai, termasuk yang asli. Jadi tidak ada satu pun fungsi di sini yang
 * mengarang rating atau komentar.
 */

const MAKS_KOMENTAR = 300;
const MAKS_TESTIMONI_TAMPIL = 10;

/** ⭐⭐⭐⭐⭐ — selalu 5 lambang, yang kosong pakai bintang redup. */
export function bintang(rating) {
  const n = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  return '⭐'.repeat(n) + '☆'.repeat(5 - n);
}

/**
 * Menyamarkan nomor untuk dipajang di grup: 628••••4821.
 *
 * Bukti transaksi dibaca semua anggota grup, jadi nomor lengkap pembeli tidak
 * boleh ikut tercetak. Yang ditampilkan cukup untuk pemiliknya mengenali
 * transaksinya sendiri, tidak cukup untuk orang lain menghubunginya.
 *
 * Identitas @lid tidak memuat nomor HP sama sekali, jadi angkanya tidak bisa
 * dipakai — untuk itu yang ditampilkan hanya label netral.
 */
export function samarkanNomor(jid) {
  const teks = String(jid || '').trim();
  if (!teks) return 'Pelanggan';
  if (teks.includes('@lid')) return 'Pelanggan terverifikasi';

  const angka = teks.split('@')[0].replace(/\D/g, '');
  if (angka.length < 7) return 'Pelanggan';
  return `${angka.slice(0, 3)}••••${angka.slice(-4)}`;
}

/**
 * Mengurai balasan permintaan ulasan: "5", "5 mantap cepet", "4. lumayan".
 * Mengembalikan null kalau bukan balasan ulasan yang sah.
 */
export function uraiBalasanUlasan(teks) {
  const bersih = String(teks || '').trim();
  const cocok = bersih.match(/^([1-5])(?:[.,\s]+([\s\S]+))?$/);
  if (!cocok) return null;

  const rating = Number(cocok[1]);
  const komentar = String(cocok[2] || '').trim().slice(0, MAKS_KOMENTAR);
  return { rating, komentar };
}

/**
 * Pesan yang dikirim ke pembeli setelah barangnya sampai.
 *
 * Sengaja TIDAK meminta pembeli mengetik Order ID. Perintah lama
 * `.review ORD-20260726-4489 5 bagus` mengharuskan itu, dan hasilnya nol ulasan
 * selama tiga bulan toko ini berjalan. Sekarang cukup balas satu angka.
 */
export function susunPermintaanUlasan({ namaProduk, namaPembeli } = {}) {
  const sapaan = namaPembeli ? `Kak *${namaPembeli}*` : 'Kak';
  const produk = namaProduk ? `*${namaProduk}*` : 'pesanan kamu';

  let t = `🙏 Gimana ${produk}, ${sapaan}?\n\n`;
  t += `Balas *1* sampai *5* untuk kasih bintang:\n`;
  t += `_1 = kecewa · 5 = puas banget_\n\n`;
  t += `Boleh sekalian tulis komentarnya, contoh:\n`;
  t += `*5 cepet banget, akunnya langsung jalan*\n\n`;
  t += `_Ulasan kamu tampil di_ \`.testi\` _dan membantu pembeli lain._`;
  return t;
}

/** Balasan setelah ulasan tersimpan. */
export function susunTerimaKasihUlasan({ rating, komentar } = {}) {
  let t = `🎉 *Makasih ulasannya!*\n\n${bintang(rating)}  (${rating}/5)\n`;
  if (komentar) t += `_"${komentar}"_\n`;
  t += `\nUlasan kamu sekarang tampil di \`.testi\`.`;
  if (Number(rating) <= 2) {
    // Rating rendah tidak boleh cuma dicatat lalu didiamkan. Pembeli yang
    // kecewa dan merasa tidak didengar akan bercerita di tempat lain.
    t += `\n\n😔 Maaf pengalamannya kurang. Ketik \`.garansi\` kalau ada masalah dengan akunnya — owner akan cek langsung.`;
  }
  return t;
}

/** Rp60.000 */
function rupiah(nilai) {
  const n = Number(nilai);
  if (!Number.isFinite(n)) return 'Rp0';
  return 'Rp' + Math.round(n).toLocaleString('id-ID');
}

/**
 * Bukti transaksi untuk dipajang di GRUP PEMBELI.
 *
 * Dibuat lebih rinci karena rincian itulah yang meyakinkan — "ada yang beli"
 * gampang dikarang, "produk ini, jam segini, sampai dalam 1 detik, nomor
 * pesanan ORD-xxx" tidak.
 *
 * Tapi dua hal SENGAJA tidak ikut, dan jangan ditambahkan:
 *
 *   • Nama & nomor pembeli. Ini dibaca seluruh anggota grup. Nomor disamarkan,
 *     nama tidak ditampilkan sama sekali — pembeli tidak pernah setuju
 *     identitasnya dipajang hanya karena ia belanja.
 *   • Sisa stok. Itu angka dagang milik owner, dan memajangnya tiap transaksi
 *     memberi tahu semua orang berapa banyak barang yang dipegang toko.
 *
 * Keduanya tetap dikirim ke owner lewat susunNotifPenjualanOwner().
 */
export function susunBuktiTransaksi({
  namaProduk, jid, otomatis = true, jam, tanggal, jumlah = 1, total, orderId, durasiMs
} = {}) {
  const qty = Math.max(1, Math.trunc(Number(jumlah) || 1));

  let t = `🧾 *TRANSAKSI BERHASIL*\n`;
  t += `━━━━━━━━━━━━━━━\n`;
  t += `🛍️ *${namaProduk || 'Produk digital'}*\n`;
  t += `📊 ${qty} pcs`;
  if (Number(total) > 0) t += ` · 💰 *${rupiah(total)}*`;
  t += `\n`;
  t += `👤 ${samarkanNomor(jid)}\n`;
  if (tanggal || jam) t += `📅 ${[tanggal, jam ? `${jam} WIB` : ''].filter(Boolean).join(' · ')}\n`;

  const durasi = formatDurasi(durasiMs);
  if (otomatis) {
    t += durasi ? `⚡ Dikirim otomatis dalam *${durasi}*\n` : `⚡ Dikirim otomatis, tanpa nunggu admin\n`;
  } else {
    t += `👨‍💼 Dikirim manual oleh admin\n`;
  }
  if (orderId) t += `🆔 \`${orderId}\`\n`;

  t += `━━━━━━━━━━━━━━━\n`;
  t += `_Ketik_ \`.list\` _untuk lihat katalog._`;
  return t;
}

/**
 * Notifikasi penjualan untuk OWNER — bukan untuk grup pembeli.
 *
 * Di sini semuanya boleh tampil: nama pembeli, nomornya, sisa stok, nomor
 * rujukan pembayaran. Tujuannya satu — owner tahu apa yang terjual dan apakah
 * ada yang perlu direstok, tanpa membuka dashboard.
 *
 * Sisa stok ditulis "2 pcs (dari 3)" supaya terbaca sebagai penurunan, bukan
 * angka lepas; dan kalau habis, peringatannya ikut menyebut perintah restoknya.
 */
export function susunNotifPenjualanOwner({
  namaProduk, produkKode, namaPembeli, jid, jumlah = 1, total, metode,
  tanggal, jam, sisaStok, stokSebelum, orderId, refPembayaran, durasiMs, otomatis = true
} = {}) {
  const qty = Math.max(1, Math.trunc(Number(jumlah) || 1));
  const nomor = String(jid || '').split('@')[0].replace(/\D/g, '');
  const lewatLid = String(jid || '').includes('@lid');

  let t = `🎉 *PENJUALAN BARU*\n`;
  t += `━━━━━━━━━━━━━━━\n`;
  t += `👤 Pembeli: *${String(namaPembeli || '').trim() || 'Pelanggan'}*\n`;
  // wa.me hanya kalau nomornya memang nomor HP. Identitas @lid bukan nomor —
  // menjadikannya tautan menghasilkan chat ke nomor acak milik orang lain.
  if (!lewatLid && nomor.length >= 8) t += `   wa.me/${nomor}\n`;
  else t += `   _(dari grup — nomornya tidak terbaca)_\n`;
  t += `🛍️ Produk: *${namaProduk || '-'}*${produkKode ? ` (\`${produkKode}\`)` : ''}\n`;
  t += `📊 Jumlah: *${qty}x*\n`;
  t += `💰 Total: *${rupiah(total)}*\n`;

  t += `\n── Info tambahan ──\n`;
  if (tanggal || jam) t += `📅 ${[tanggal, jam ? `pukul ${jam} WIB` : ''].filter(Boolean).join(' ')}\n`;
  if (metode) t += `🏦 Metode: ${metode}\n`;

  if (Number.isFinite(Number(sisaStok))) {
    const sisa = Number(sisaStok);
    const sebelum = Number.isFinite(Number(stokSebelum)) ? Number(stokSebelum) : sisa + qty;
    t += `📦 Sisa stok: *${sisa} pcs* (dari ${sebelum})\n`;
    if (sisa === 0) t += `   🔴 *HABIS* — restok: \`.addstock ${produkKode || '<kode>'}\`\n`;
    else if (sisa <= 3) t += `   🟡 Menipis — siapkan restok\n`;
  }

  const durasi = formatDurasi(durasiMs);
  t += otomatis
    ? `⚡ Terkirim otomatis${durasi ? ` dalam ${durasi}` : ''}\n`
    : `👨‍💼 Menunggu dikirim manual\n`;
  if (orderId) t += `🆔 Order: \`${orderId}\`\n`;
  if (refPembayaran) t += `🔗 Ref bayar: \`${refPembayaran}\`\n`;

  return t;
}

/** "3 detik", "2 menit", "1 jam" — durasi pengiriman dari milidetik. */
export function formatDurasi(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const detik = Math.round(n / 1000);
  if (detik < 60) return `${Math.max(1, detik)} detik`;
  const menit = Math.round(detik / 60);
  if (menit < 60) return `${menit} menit`;
  const jam = Math.round(menit / 60);
  if (jam < 24) return `${jam} jam`;
  return `${Math.round(jam / 24)} hari`;
}

/** "2 menit lalu", "kemarin", "3 hari lalu". */
export function formatSejak(epochMs, sekarang = Date.now()) {
  const n = Number(epochMs);
  if (!Number.isFinite(n) || n <= 0) return '';
  const selisih = sekarang - n;
  if (selisih < 60_000) return 'barusan';
  const d = formatDurasi(selisih);
  return d ? `${d} lalu` : '';
}

/**
 * Layar `.testi` — dan tugasnya BUKAN memamerkan bintang.
 *
 * Pembeli produk digital tidak bertanya "bagus tidak barangnya". Mereka
 * bertanya "ini penipu bukan". Yang menjawab pertanyaan itu adalah catatan
 * bahwa barangnya memang terkirim, berulang kali, dalam hitungan detik — dan
 * bahwa yang mengirim adalah bot, bukan admin yang bisa menghilang.
 *
 * Maka urutan layarnya: angka pengiriman dulu, riwayat pengiriman, baru kata
 * pembeli, lalu alasan struktural kenapa penipuan tidak mungkin di sini.
 *
 * Toko yang belum pernah mengirim apa pun TIDAK boleh mengarang angka. Layar
 * ini mengakuinya apa adanya lalu tetap menjawab ketakutannya lewat jaminan
 * yang memang berlaku sejak hari pertama.
 */
export function susunLayarTesti({ bukti, ulasan, ringkasUlasan, sekarang = Date.now() } = {}) {
  const b = bukti || { jumlah: 0, rataMs: 0, terakhirMs: 0, terbaru: [] };
  const daftarUlasan = (Array.isArray(ulasan) ? ulasan : []).slice(0, 3);
  const totalUlasan = Number(ringkasUlasan?.jumlah) || 0;
  const rata = Number(ringkasUlasan?.rataRata) || 0;

  const jaminan = [
    '🔒 *KENAPA TIDAK BISA DITIPU DI SINI*',
    '• Akun dikirim *bot*, otomatis beberapa detik setelah bayar — bukan admin yang ketik manual',
    '• Bayar lewat *QRIS resmi*, bukan transfer ke rekening pribadi',
    '• Ada *garansi*: ketik `.garansi` kalau akunnya bermasalah',
    '• Stok yang tampil di `.list` adalah akun yang benar-benar ada'
  ].join('\n');

  // ── Toko yang belum punya catatan pengiriman DAN belum punya ulasan ──────
  //
  // Catatan pengiriman bisa kosong walau pesanannya sungguhan: pesanan yang
  // dikonfirmasi manual oleh admin tidak selalu meninggalkan job DELIVERED.
  // Karena itu layar hanya benar-benar kosong kalau ulasannya juga tidak ada —
  // menyembunyikan ulasan asli hanya karena penghitung pengiriman nol adalah
  // membuang satu-satunya bukti yang justru ditulis pembeli sendiri.
  if (b.jumlah === 0 && totalUlasan === 0) {
    let t = `🛡️ *JAMINAN TOKO INI*\n`;
    t += `━━━━━━━━━━━━━━━\n`;
    t += `Belum ada pengiriman yang bisa ditampilkan di sini.\n\n`;
    t += `_Angkanya tidak akan pernah dikarang — begitu ada pesanan pertama yang terkirim, catatannya muncul otomatis di layar ini._\n\n`;
    t += jaminan;
    return t;
  }

  let t = b.jumlah > 0 ? `🛡️ *BUKTI PENGIRIMAN TOKO INI*\n` : `🛡️ *TESTIMONI PEMBELI*\n`;
  t += `━━━━━━━━━━━━━━━\n`;
  if (b.jumlah > 0) {
    t += `✅ *${b.jumlah} pesanan* sudah terkirim\n`;
    const rataTeks = formatDurasi(b.rataMs);
    if (rataTeks) t += `⚡ Rata-rata *${rataTeks}* dari bayar sampai akun diterima\n`;
    const sejak = formatSejak(b.terakhirMs, sekarang);
    if (sejak) t += `🕒 Pengiriman terakhir: *${sejak}*\n`;
  }
  if (totalUlasan > 0 && rata > 0) {
    t += `${bintang(rata)} *${rata.toFixed(1)}/5* dari ${totalUlasan} ulasan pembeli\n`;
  }

  if (b.terbaru.length > 0) {
    t += `\n📬 *PENGIRIMAN TERAKHIR*\n`;
    for (const p of b.terbaru.slice(0, 6)) {
      const nama = String(p.nama_produk || '').trim() || 'Produk digital';
      const durasi = formatDurasi(Number(p.updated_at) - Number(p.created_at));
      const jumlah = Number(p.qty) > 1 ? ` ×${p.qty}` : '';
      t += `• ${nama}${jumlah}\n`;
      t += `  ${samarkanNomor(p.customer_number)}${durasi ? ` · ⚡ ${durasi}` : ''}\n`;
    }
  }

  if (daftarUlasan.length > 0) {
    t += `\n💬 *KATA PEMBELI*\n`;
    for (const u of daftarUlasan) {
      const nama = String(u.nama_pembeli || '').trim() || samarkanNomor(u.customer_nomor);
      const komentar = String(u.comment || '').trim();
      t += `${bintang(u.rating)} *${nama}*`;
      t += komentar ? `\n"${komentar.slice(0, MAKS_KOMENTAR)}"\n` : `\n`;
    }
    if (totalUlasan > daftarUlasan.length) {
      t += `_…dan ${totalUlasan - daftarUlasan.length} ulasan lain._\n`;
    }
  }

  t += `\n━━━━━━━━━━━━━━━\n${jaminan}`;
  return t;
}

/**
 * Satu baris rating untuk ditempel di halaman produk.
 * Mengembalikan string kosong kalau produknya belum punya ulasan — lebih baik
 * tidak menampilkan apa pun daripada menampilkan "0.0/5" pada barang baru.
 */
export function barisRating(rataRata, jumlah) {
  const n = Number(jumlah) || 0;
  const r = Number(rataRata);
  if (n <= 0 || !Number.isFinite(r) || r <= 0) return '';
  return `${bintang(r)} ${r.toFixed(1)}/5 · ${n} ulasan`;
}
