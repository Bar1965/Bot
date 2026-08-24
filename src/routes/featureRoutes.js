import express from 'express';
import * as db from '../../database.js';
import {
  authenticateJWT,
  authorizeRoles
} from './authMiddleware.js';

const router = express.Router();

// Coupons
router.get('/coupons', authenticateJWT, async (req, res) => {
  try {
    const coupons = await db.getAllCoupons();
    res.json({ success: true, coupons });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/coupons', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { code, type, value, min_order, max_uses, expires_at } = req.body;
    if (!code || !type || value === undefined) {
      return res.status(400).json({ success: false, message: "Kode, tipe (percent/fixed), dan nilai wajib diisi." });
    }
    const normalizedCode = String(code).trim().toUpperCase();
    const normalizedType = String(type).trim().toLowerCase();
    const parsedValue = Number(value);
    const parsedMinOrder = min_order === undefined || min_order === '' ? 0 : Number(min_order);
    const parsedMaxUses = max_uses === undefined || max_uses === '' ? 0 : Number(max_uses);
    if (!/^[A-Z0-9_-]{3,40}$/.test(normalizedCode)) {
      return res.status(400).json({ success: false, message: "Kode kupon hanya boleh berisi huruf, angka, garis bawah, atau tanda hubung (3-40 karakter)." });
    }
    if (!['percent', 'fixed'].includes(normalizedType)) {
      return res.status(400).json({ success: false, message: "Tipe kupon harus percent atau fixed." });
    }
    if (!Number.isInteger(parsedValue) || parsedValue <= 0 || (normalizedType === 'percent' && parsedValue > 100)) {
      return res.status(400).json({ success: false, message: "Nilai kupon tidak valid." });
    }
    if (!Number.isInteger(parsedMinOrder) || parsedMinOrder < 0 || !Number.isInteger(parsedMaxUses) || parsedMaxUses < 0) {
      return res.status(400).json({ success: false, message: "Minimum order dan batas penggunaan harus bilangan bulat positif atau nol." });
    }
    await db.addCoupon(normalizedCode, normalizedType, parsedValue, parsedMinOrder, parsedMaxUses, expires_at || null);
    res.json({ success: true, message: `Kupon ${normalizedCode} berhasil dibuat!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/coupons/:code', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const deleted = await db.deleteCoupon(req.params.code);
    res.json({ success: true, deleted, message: deleted ? "Kupon berhasil dihapus." : "Kupon tidak ditemukan." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// FAQs
router.get('/faqs', authenticateJWT, async (req, res) => {
  try {
    const faqs = await db.getAllFaqs();
    res.json({ success: true, faqs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/faqs', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { keywords, answer } = req.body;
    if (typeof keywords !== 'string' || typeof answer !== 'string' || !keywords.trim() || !answer.trim() || keywords.length > 500 || answer.length > 5000) {
      return res.status(400).json({ success: false, message: "Keywords dan Jawaban wajib diisi." });
    }
    const id = await db.addFaq(keywords, answer);
    res.json({ success: true, id, message: "FAQ berhasil ditambahkan!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/faqs/:id', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const deleted = await db.deleteFaq(req.params.id);
    res.json({ success: true, deleted, message: deleted ? "FAQ berhasil dihapus." : "FAQ tidak ditemukan." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Referrals
router.get('/referrals', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const referrals = await db.allQuery(
      `SELECT r.*, c1.nama as referrer_nama, c2.nama as referred_nama 
       FROM referrals r 
       LEFT JOIN customers c1 ON r.referrer_nomor = c1.nomor
       LEFT JOIN customers c2 ON r.referred_nomor = c2.nomor
       ORDER BY r.created_at DESC`
    );
    res.json({ success: true, referrals });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
