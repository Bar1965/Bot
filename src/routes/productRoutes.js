import express from 'express';
import * as db from '../../database.js';
import { checkAndNotifySubscribers } from '../../bot.js';
import { pesanErrorAman } from './responErr.js';
import {
  authenticateJWT,
  authorizeRoles,
  uploadProduct
} from './authMiddleware.js';

const router = express.Router();

// Semua role diizinkan membaca produk
router.get('/products', authenticateJWT, async (req, res) => {
  try {
    const products = await db.getProducts();
    res.json({ success: true, products });
  } catch (err) {
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'PRODUCT') });
  }
});

// Owner dan Admin bisa menulis/edit produk
router.post('/products', authenticateJWT, authorizeRoles('Owner', 'Admin'), uploadProduct.single('gambar'), async (req, res) => {
  try {
    const { kode, nama, harga, stok, deskripsi, delivery_type, old_kode, petunjuk, brand_category, variant_type, duration } = req.body;
    if (!kode || !nama || harga === undefined || harga === '' || stok === undefined || stok === '') {
      return res.status(400).json({ success: false, message: "Kolom kode, nama, harga, dan stok wajib diisi." });
    }

    const normalizedKode = String(kode).trim().toUpperCase();
    const normalizedNama = String(nama).trim();
    const parsedHarga = Number(harga);
    const parsedStok = Number(stok);
    const deliveryType = String(delivery_type || 'MANUAL').toUpperCase();
    if (!/^[A-Z0-9_-]{2,40}$/.test(normalizedKode)) {
      return res.status(400).json({ success: false, message: "Kode produk hanya boleh berisi huruf, angka, garis bawah, atau tanda hubung (2-40 karakter)." });
    }
    if (normalizedNama.length < 1 || normalizedNama.length > 120) {
      return res.status(400).json({ success: false, message: "Nama produk harus berisi 1-120 karakter." });
    }
    if (!Number.isInteger(parsedHarga) || parsedHarga < 0 || parsedHarga > 1_000_000_000) {
      return res.status(400).json({ success: false, message: "Harga produk harus berupa bilangan bulat antara 0 dan 1.000.000.000." });
    }
    if (!Number.isInteger(parsedStok) || parsedStok < 0 || parsedStok > 1_000_000) {
      return res.status(400).json({ success: false, message: "Stok produk harus berupa bilangan bulat antara 0 dan 1.000.000." });
    }
    if (!['MANUAL', 'AUTO'].includes(deliveryType)) {
      return res.status(400).json({ success: false, message: "Tipe pengiriman produk tidak valid." });
    }

    let gambarUrl = "";
    if (req.file) {
      gambarUrl = `/uploads/products/${req.file.filename}`;
    } else if (req.body.gambar_existing) {
      const existing = String(req.body.gambar_existing).trim();
      if (/^\/uploads\/products\/[a-zA-Z0-9_.-]+$/.test(existing)) {
        gambarUrl = existing;
      }
    }

    // Dicatat SEBELUM addProduct, karena addProduct memakai INSERT OR REPLACE —
    // sesudahnya tidak ada lagi cara membedakan produk baru dari penyuntingan.
    const sudahAdaSebelumnya = Boolean(await db.getProductByKode(normalizedKode));

    await db.addProduct(
      normalizedKode,
      normalizedNama,
      parsedHarga,
      parsedStok,
      String(deskripsi || '').slice(0, 5000), 
      gambarUrl, 
      deliveryType, 
      String(old_kode || '').trim(), 
      String(petunjuk || '').slice(0, 5000),
      brand_category ? String(brand_category).trim() : null,
      variant_type ? String(variant_type).trim() : null,
      duration ? String(duration).trim() : null
    );
    await checkAndNotifySubscribers(normalizedKode, parsedStok);

    // Produk baru lewat dashboard diumumkan sama seperti lewat WhatsApp.
    // Penyuntingan produk lama TIDAK — menyimpan perubahan deskripsi bukan kabar.
    if (!sudahAdaSebelumnya) {
      try {
        const tersimpan = await db.getProductByKode(normalizedKode);
        const { antrekanProdukBaru } = await import('../handlers/siaranStok.js');
        antrekanProdukBaru({
          kode: normalizedKode, nama: normalizedNama,
          harga: parsedHarga, stok: tersimpan?.stok ?? parsedStok
        });
      } catch (siaranErr) {
        console.warn('[SIARAN] Gagal mengantre produk baru:', siaranErr.message);
      }
    }

    res.json({ success: true, message: "Produk berhasil disimpan." });
  } catch (err) {
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'PRODUCT') });
  }
});

// Owner dan Admin bisa memicu broadcast restok produk
router.post('/products/:kode/restock-broadcast', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { kode } = req.params;
    const { triggerRestockBroadcast } = await import('../../bot.js');
    const result = await triggerRestockBroadcast(kode);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'PRODUCT') });
  }
});

// Owner dan Admin bisa menghapus produk
// Tombol Hapus di dashboard memakai penjaga yang SAMA dengan `.delproduk`.
//
// Dulu route ini memanggil db.deleteProduct(), yaitu satu baris
// `DELETE FROM products WHERE kode = ?` tanpa pemeriksaan apa pun. Tiga
// akibatnya:
//
//   1. Produk yang kredensialnya sedang RESERVED untuk pesanan yang menunggu
//      pembayaran tetap terhapus — pembeli membayar, lalu tidak ada yang dikirim.
//   2. Seluruh baris product_items ditinggalkan YATIM (tidak ada ON DELETE
//      CASCADE di skema). Membuat ulang produk dengan kode yang sama kemudian
//      MENGHIDUPKAN kembali kredensial lama itu, termasuk yang sudah pernah
//      terjual.
//   3. Baris USED — satu-satunya bukti apa yang pernah dikirim ke pembeli, yang
//      dipakai klaim `.garansi` — ikut kehilangan induknya.
//
// deleteProductWithItems menolak selama masih ada RESERVED atau pesanan aktif,
// menyapu subscriptions/wishlist, dan sengaja MENYIMPAN baris USED.
router.delete('/products/:kode', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { kode } = req.params;
    const hasil = await db.deleteProductWithItems(kode);

    if (!hasil.success) {
      if (hasil.alasan === 'TIDAK_ADA') {
        return res.status(404).json({ success: false, message: hasil.message });
      }
      const im = hasil.impact || {};
      const daftar = (im.orderAktif || []).map(o => `${o.order_id} (${o.status})`).join(', ');
      return res.status(409).json({
        success: false,
        message: `Produk ini masih terikat transaksi berjalan: ${im.reserved || 0} kredensial terkunci` +
                 (daftar ? `, pesanan aktif: ${daftar}` : '') +
                 '. Selesaikan atau batalkan dulu pesanannya.',
        impact: { reserved: im.reserved || 0, ready: im.ready || 0, used: im.used || 0, orderAktif: im.orderAktif || [] }
      });
    }

    res.json({ success: true, message: "Produk berhasil dihapus." });
  } catch (err) {
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'PRODUCT') });
  }
});

// Owner dan Admin bisa melihat list item kredensial stok digital
router.get('/products/:kode/items', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { kode } = req.params;
    const items = await db.getProductItems(kode);
    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'PRODUCT') });
  }
});

// Owner dan Admin bisa menambahkan massal kredensial stok digital
router.post('/products/:kode/items', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { kode } = req.params;
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "Kredensial wajib diset dalam bentuk array." });
    }
    if (items.length > 1000 || items.some(item => typeof item !== 'string' || item.trim().length === 0 || item.length > 5000)) {
      return res.status(400).json({ success: false, message: "Maksimal 1.000 kredensial, masing-masing 1-5.000 karakter." });
    }
    // Yang dilaporkan adalah yang BENAR-BENAR masuk. Kalimat lama memakai
    // items.length — jumlah yang dikirim dari textarea — sehingga kredensial
    // yang ditolak karena kembar tetap ikut terhitung di layar. Owner menutup
    // dialognya dengan yakin stoknya naik 50, padahal naik 40.
    const hasil = await db.addProductItems(kode, items);
    const dilewati = hasil.dilewati?.length || 0;
    let pesan = `Berhasil menambahkan ${hasil.addedCount} kredensial stok.`;
    if (dilewati > 0) {
      const sudahDikirim = hasil.dilewati.filter(d => d.alasan === 'SUDAH_DIKIRIM').length;
      pesan += ` ${dilewati} dilewati karena kembar`;
      pesan += sudahDikirim > 0
        ? ` (${sudahDikirim} di antaranya sudah pernah dikirim ke pembeli).`
        : '.';
    }
    // Restok lewat dashboard diperlakukan sama dengan lewat WhatsApp: kalau
    // produknya tadinya benar-benar kosong, grup ikut dikabari. Aturan "hanya
    // dari nol" ditegakkan di dalam antrekanRestok, bukan di sini.
    try {
      const produk = await db.getProductByKode(kode);
      const { antrekanRestok } = await import('../handlers/siaranStok.js');
      antrekanRestok({
        kode, nama: produk?.nama, harga: produk?.harga,
        stokSebelum: hasil.readyCountSebelum, stokSesudah: hasil.readyCount
      });
    } catch (siaranErr) {
      console.warn('[SIARAN] Gagal mengantre pengumuman restok:', siaranErr.message);
    }

    res.json({ success: true, message: pesan, stock: hasil.readyCount, added: hasil.addedCount, skipped: dilewati });
  } catch (err) {
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'PRODUCT') });
  }
});

// Owner dan Admin bisa menghapus satu kredensial stok digital
router.delete('/products/items/:id', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { id } = req.params;
    await db.deleteProductItem(id);
    res.json({ success: true, message: "Item kredensial berhasil dihapus." });
  } catch (err) {
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'PRODUCT') });
  }
});

export default router;
