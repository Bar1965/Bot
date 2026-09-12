/**
 * KELOLA PRODUK DARI WHATSAPP — tanpa membuka dashboard.
 *
 * storeDb.js sudah punya addProduct/addProductItemsBatch, tapi keduanya dirancang
 * untuk form dashboard yang selalu mengirim SEMUA kolom sekaligus. Mengetik dari
 * HP butuh yang sebaliknya: sunting satu kolom, sisanya jangan disentuh. Modul ini
 * berisi bagian itu, plus pengaman-pengaman yang hanya relevan saat perintahnya
 * datang dari chat.
 *
 * Tidak ada yang mengimpor file ini dari dalam src/database/ selain index.js,
 * jadi tidak menutup siklus impor (AGENTS.md §16).
 */

import { runQuery, getQuery, allQuery, withTransaction } from './connection.js';
import { addLog } from './userDb.js';
import { getProductByKode, getAvailableItemsCount } from './storeDb.js';

// Kolom produk yang boleh disunting dari WhatsApp, lengkap dengan nama kolom SQL
// dan labelnya. Daftar ini SEKALIGUS jadi whitelist: nama kolom yang masuk ke
// query tidak pernah berasal dari ketikan admin, hanya dari kunci di sini.
export const FIELD_PRODUK = {
  nama:      { kolom: 'nama',           label: 'Nama produk' },
  harga:     { kolom: 'harga',          label: 'Harga' },
  deskripsi: { kolom: 'deskripsi',      label: 'Deskripsi' },
  petunjuk:  { kolom: 'petunjuk',       label: 'Petunjuk pakai' },
  kategori:  { kolom: 'brand_category', label: 'Kategori/brand' },
  varian:    { kolom: 'variant_type',   label: 'Tipe varian' },
  durasi:    { kolom: 'duration',       label: 'Durasi' },
  mode:      { kolom: 'delivery_type',  label: 'Mode kirim' },
  gambar:    { kolom: 'gambar',         label: 'Gambar' },
};

// Alias yang wajar diketik admin dari HP, dipetakan ke kunci resmi di atas.
const ALIAS_FIELD_PRODUK = {
  name: 'nama', judul: 'nama', title: 'nama',
  price: 'harga', hrg: 'harga',
  desc: 'deskripsi', description: 'deskripsi', ket: 'deskripsi', keterangan: 'deskripsi',
  panduan: 'petunjuk', tutorial: 'petunjuk', carapakai: 'petunjuk',
  brand: 'kategori', category: 'kategori', kat: 'kategori',
  variant: 'varian', tipe: 'varian',
  duration: 'durasi', masa: 'durasi', lama: 'durasi',
  delivery: 'mode', kirim: 'mode', pengiriman: 'mode',
  image: 'gambar', foto: 'gambar', gbr: 'gambar',
};

/**
 * Terjemahkan nama field yang diketik admin menjadi kunci resmi FIELD_PRODUK.
 * Mengembalikan null kalau tidak dikenal, supaya pemanggil bisa menampilkan daftar
 * field yang benar alih-alih diam-diam menyunting kolom yang salah.
 */
export function resolveFieldProduk(nama) {
  const k = String(nama || '').trim().toLowerCase();
  if (!k) return null;
  if (FIELD_PRODUK[k]) return k;
  const alias = ALIAS_FIELD_PRODUK[k];
  return alias && FIELD_PRODUK[alias] ? alias : null;
}

/**
 * Baca harga yang diketik manusia: "50000", "50.000", "Rp 50.000", "50rb", "1jt".
 * Mengembalikan null kalau tidak bisa dibaca sebagai bilangan bulat.
 */
export function parseHargaIndonesia(teks) {
  let s = String(teks ?? '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^rp\.?\s*/, '').replace(/\s+/g, '');

  let pengali = 1;
  const satuan = s.match(/(ribu|rb|juta|jt|k)$/);
  if (satuan) {
    pengali = ['rb', 'ribu', 'k'].includes(satuan[1]) ? 1000 : 1000000;
    s = s.slice(0, -satuan[1].length);
  }

  // Titik dan koma di Indonesia adalah pemisah ribuan, bukan desimal.
  s = s.replace(/[.,]/g, '');
  if (!/^\d+$/.test(s)) return null;

  const angka = Number(s) * pengali;
  if (!Number.isSafeInteger(angka)) return null;
  return angka;
}

/**
 * Validasi satu nilai field produk. Mengembalikan { ok, nilai, message }.
 * Nilai yang lolos sudah dalam bentuk siap tulis ke kolom SQL.
 */
export function validasiFieldProduk(field, nilaiMentah) {
  const teks = String(nilaiMentah ?? '').trim();

  switch (field) {
    case 'nama': {
      if (teks.length < 1 || teks.length > 120) {
        return { ok: false, message: 'Nama produk harus 1-120 karakter.' };
      }
      return { ok: true, nilai: teks };
    }
    case 'harga': {
      const angka = parseHargaIndonesia(teks);
      if (angka === null) {
        return { ok: false, message: 'Harga harus berupa angka. Contoh: 50000, 50.000, atau 50rb.' };
      }
      if (angka < 0 || angka > 1000000000) {
        return { ok: false, message: 'Harga di luar batas wajar (0 sampai 1.000.000.000).' };
      }
      return { ok: true, nilai: angka };
    }
    case 'deskripsi':
    case 'petunjuk': {
      if (teks.length > 2000) {
        return { ok: false, message: FIELD_PRODUK[field].label + ' maksimal 2000 karakter.' };
      }
      return { ok: true, nilai: teks };
    }
    case 'kategori':
    case 'varian':
    case 'durasi': {
      if (teks.length > 60) {
        return { ok: false, message: FIELD_PRODUK[field].label + ' maksimal 60 karakter.' };
      }
      // Kolom ini boleh kosong: null lebih jujur daripada string kosong, karena
      // katalog mengelompokkan berdasarkan ada/tidaknya nilai.
      return { ok: true, nilai: teks || null };
    }
    case 'mode': {
      const mode = teks.toUpperCase();
      if (!['AUTO', 'MANUAL'].includes(mode)) {
        return { ok: false, message: 'Mode kirim hanya boleh AUTO atau MANUAL.' };
      }
      return { ok: true, nilai: mode };
    }
    case 'gambar': {
      if (!teks) return { ok: true, nilai: '' };
      const valid = teks.startsWith('/uploads/') || /^https?:\/\//i.test(teks);
      if (!valid) {
        return { ok: false, message: 'Gambar harus berupa URL http(s) atau path /uploads/...' };
      }
      if (teks.length > 500) {
        return { ok: false, message: 'Alamat gambar terlalu panjang.' };
      }
      return { ok: true, nilai: teks };
    }
    default:
      return { ok: false, message: 'Field produk tidak dikenal.' };
  }
}

/**
 * Validasi kode produk. Aturannya sengaja sama persis dengan addProduct() di
 * storeDb.js — kalau dilonggarkan di sini, wizard akan menerima kode yang lalu
 * ditolak saat penyimpanan.
 */
export function validasiKodeProduk(kode) {
  const code = String(kode || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,40}$/.test(code)) {
    return { ok: false, message: 'Kode produk hanya boleh huruf, angka, - dan _ (2-40 karakter). Contoh: NET01' };
  }
  return { ok: true, nilai: code };
}

/**
 * Setel stok produk MANUAL dari WhatsApp.
 *
 * Stok produk AUTO BUKAN angka yang boleh ditulis tangan: nilainya adalah jumlah
 * baris product_items berstatus READY, dan addToCart/checkoutCart membaca hitungan
 * itu, bukan kolom products.stok. Menulis "10" ke produk AUTO yang kredensialnya
 * kosong hanya membuat katalog memajang stok yang langsung dibantah sendiri begitu
 * pelanggan menekan beli. Jadi di sini ditolak, bukan ditimpa.
 */
export async function setManualStock(kode, stok) {
  const code = String(kode || '').trim().toUpperCase();
  const product = await getProductByKode(code);
  if (!product) {
    return { success: false, alasan: 'TIDAK_ADA', message: `Produk *${code}* tidak ditemukan.` };
  }
  if (!Number.isInteger(stok) || stok < 0 || stok > 1000000) {
    return { success: false, alasan: 'ANGKA_TIDAK_VALID', message: 'Stok harus bilangan bulat 0 sampai 1.000.000.' };
  }
  if (product.delivery_type === 'AUTO') {
    const readyCount = await getAvailableItemsCount(code);
    return {
      success: false,
      alasan: 'PRODUK_AUTO',
      product,
      readyCount,
      message: `Produk *${product.nama}* bertipe *AUTO*: stoknya dihitung dari kredensial tersimpan (sekarang *${readyCount} pcs*), bukan diketik manual.`
    };
  }

  await runQuery("UPDATE products SET stok = ? WHERE kode = ?", [stok, code]);
  await addLog("SYSTEM", `Stok produk ${code} diubah menjadi ${stok} pcs via WhatsApp.`);
  return { success: true, product, stok };
}

/**
 * Sunting sebagian kolom produk tanpa menyentuh kolom lain.
 *
 * addProduct() memakai INSERT OR REPLACE, jadi memanggilnya untuk "edit" akan
 * mengosongkan setiap kolom yang tidak ikut dikirim. Fungsi ini menulis hanya
 * kolom yang benar-benar diubah.
 *
 * `fields` memakai kunci ramah-admin (nama, harga, kategori, mode, ...), bukan
 * nama kolom SQL. Lihat FIELD_PRODUK.
 */
export async function updateProductFields(kode, fields = {}) {
  const code = String(kode || '').trim().toUpperCase();
  const product = await getProductByKode(code);
  if (!product) {
    return { success: false, alasan: 'TIDAK_ADA', message: `Produk *${code}* tidak ditemukan.` };
  }

  const setSql = [];
  const params = [];
  const perubahan = [];

  for (const [rawField, rawNilai] of Object.entries(fields)) {
    const field = resolveFieldProduk(rawField);
    if (!field) {
      return { success: false, alasan: 'FIELD_TIDAK_DIKENAL', fieldSalah: rawField };
    }
    const cek = validasiFieldProduk(field, rawNilai);
    if (!cek.ok) {
      return { success: false, alasan: 'NILAI_TIDAK_VALID', fieldSalah: field, message: cek.message };
    }
    setSql.push(`${FIELD_PRODUK[field].kolom} = ?`);
    params.push(cek.nilai);
    perubahan.push({
      field,
      label: FIELD_PRODUK[field].label,
      lama: product[FIELD_PRODUK[field].kolom],
      baru: cek.nilai
    });
  }

  if (setSql.length === 0) {
    return { success: false, alasan: 'KOSONG', message: 'Tidak ada yang diubah.' };
  }

  params.push(code);
  await runQuery(`UPDATE products SET ${setSql.join(', ')} WHERE kode = ?`, params);

  // Pindah ke AUTO berarti stok tampilan harus ikut hitungan kredensial. Kalau
  // tidak, katalog memajang sisa angka mode MANUAL yang sudah tidak berarti apa-apa.
  const modeBaru = perubahan.find(p => p.field === 'mode')?.baru;
  let readyCount = null;
  if (modeBaru === 'AUTO') {
    readyCount = await getAvailableItemsCount(code);
    await runQuery("UPDATE products SET stok = ? WHERE kode = ?", [readyCount, code]);
  }

  await addLog("SYSTEM", `Produk ${code} disunting via WhatsApp: ${perubahan.map(p => p.label).join(', ')}.`);
  const produkBaru = await getProductByKode(code);
  return { success: true, product: produkBaru, perubahan, readyCount };
}

/**
 * Pasang gambar produk. Dipakai `.setgambar` setelah file tersimpan ke
 * public/uploads/products/, jadi yang masuk ke sini sudah berupa path web.
 */
export async function setProductImage(kode, gambar) {
  return await updateProductFields(kode, { gambar });
}

/**
 * Hitung akibat penghapusan sebuah produk SEBELUM benar-benar dihapus, supaya
 * admin melihat apa yang akan hilang dan perintahnya bisa menolak ketika masih
 * ada transaksi berjalan.
 */
export async function getProductDeleteImpact(kode) {
  const code = String(kode || '').trim().toUpperCase();
  const product = await getProductByKode(code);
  if (!product) return null;

  const ready = await getQuery("SELECT COUNT(*) as n FROM product_items WHERE produk_kode = ? AND status = 'READY'", [code]);
  const reserved = await getQuery("SELECT COUNT(*) as n FROM product_items WHERE produk_kode = ? AND status = 'RESERVED'", [code]);
  const used = await getQuery("SELECT COUNT(*) as n FROM product_items WHERE produk_kode = ? AND status = 'USED'", [code]);

  // Order yang belum selesai: menghapus produknya membuat checkout dan pengiriman
  // kehilangan acuan harga/nama di tengah jalan.
  const orderAktif = await allQuery(`
    SELECT DISTINCT o.order_id, o.status
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.order_id
    WHERE oi.produk_kode = ? AND o.status IN ('CART', 'WAITING_PAYMENT', 'WAITING_CONFIRMATION', 'PROCESSING')
  `, [code]);

  return {
    product,
    ready: ready?.n || 0,
    reserved: reserved?.n || 0,
    used: used?.n || 0,
    orderAktif: orderAktif || []
  };
}

/**
 * Hapus produk beserta kredensial READY-nya.
 *
 * Item berstatus USED sengaja DIBIARKAN: baris itu adalah catatan apa yang pernah
 * dikirim ke pembeli, dan klaim garansi masih mengacu ke sana. Yang ikut disapu
 * hanya lampiran non-transaksional (langganan notifikasi, wishlist, flash sale)
 * yang tanpa produknya cuma jadi penunjuk kode mati.
 */
export async function deleteProductWithItems(kode) {
  const code = String(kode || '').trim().toUpperCase();
  const impact = await getProductDeleteImpact(code);
  if (!impact) {
    return { success: false, alasan: 'TIDAK_ADA', message: `Produk *${code}* tidak ditemukan.` };
  }
  if (impact.reserved > 0 || impact.orderAktif.length > 0) {
    return { success: false, alasan: 'ADA_TRANSAKSI', impact };
  }

  return withTransaction(async () => {
    await runQuery("DELETE FROM product_items WHERE produk_kode = ? AND status = 'READY'", [code]);
    await runQuery("DELETE FROM subscriptions WHERE produk_kode = ?", [code]);
    await runQuery("DELETE FROM wishlist WHERE produk_kode = ?", [code]);
    await runQuery("DELETE FROM flash_sales WHERE produk_kode = ?", [code]);
    await runQuery("DELETE FROM products WHERE kode = ?", [code]);
    await addLog("SYSTEM", `Produk ${code} (${impact.product.nama}) dihapus via WhatsApp beserta ${impact.ready} kredensial READY.`);
    return { success: true, impact };
  });
}
