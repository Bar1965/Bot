import express from 'express';
import * as db from '../../database.js';
import { checkAndNotifySubscribers } from '../../bot.js';
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
    res.status(500).json({ success: false, message: err.message });
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
    res.json({ success: true, message: "Produk berhasil disimpan." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
  }
});

// Owner dan Admin bisa menghapus produk
router.delete('/products/:kode', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { kode } = req.params;
    await db.deleteProduct(kode);
    res.json({ success: true, message: "Produk berhasil dihapus." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Owner dan Admin bisa melihat list item kredensial stok digital
router.get('/products/:kode/items', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { kode } = req.params;
    const items = await db.getProductItems(kode);
    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
    const updatedStock = await db.addProductItems(kode, items);
    res.json({ success: true, message: `Berhasil menambahkan ${items.length} kredensial stok.`, stock: updatedStock });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Owner dan Admin bisa menghapus satu kredensial stok digital
router.delete('/products/items/:id', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { id } = req.params;
    await db.deleteProductItem(id);
    res.json({ success: true, message: "Item kredensial berhasil dihapus." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
