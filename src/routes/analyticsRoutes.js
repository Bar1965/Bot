import express from 'express';
import * as db from '../../database.js';
import { botState } from '../../server.js';
import {
  authenticateJWT,
  authorizeRoles
} from './authMiddleware.js';

const router = express.Router();

// Hanya Owner yang berhak melihat statistik finansial toko
router.get('/stats', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json({
      success: true,
      stats: {
        ...stats,
        botStatus: botState.status
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Hanya Owner yang memiliki akses halaman Analitik
router.get('/analytics', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const data = await db.getAnalyticsData();
    res.json({ success: true, analytics: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Grafik timeline pendapatan harian
router.get('/analytics/timeline', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const data = await db.getDailySalesTimeline(days);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Top produk terlaris
router.get('/analytics/top-products', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const data = await db.getTopProducts(limit);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Top pelanggan terbaik
router.get('/analytics/top-customers', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const data = await db.getTopCustomers(limit);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// KPI Summary cards
router.get('/analytics/summary', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const data = await db.getAnalyticsSummary();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Heatmap data untuk kalender
router.get('/analytics/heatmap', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const now = new Date();
    const year = parseInt(req.query.year) || now.getFullYear();
    const month = parseInt(req.query.month) || (now.getMonth() + 1);
    const data = await db.getSalesHeatmap(year, month);
    res.json({ success: true, data, year, month });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Export data penjualan ke CSV
router.get('/analytics/export', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 90;
    const timeline = await db.getDailySalesTimeline(days);
    const topProducts = await db.getTopProducts(20);
    const topCustomers = await db.getTopCustomers(20);

    let csv = 'LAPORAN PENJUALAN\n\n';
    csv += 'PENDAPATAN HARIAN\n';
    csv += 'Tanggal,Pendapatan (Rp),Jumlah Order\n';
    timeline.forEach(r => {
      csv += `${r.date},${r.revenue},${r.order_count}\n`;
    });

    csv += '\nPRODUK TERLARIS\n';
    csv += 'Kode,Nama Produk,Qty Terjual,Revenue (Rp),Jumlah Order\n';
    topProducts.forEach(p => {
      csv += `${p.kode},"${p.nama}",${p.total_qty},${p.total_revenue},${p.order_count}\n`;
    });

    csv += '\nPELANGGAN TERBAIK\n';
    csv += 'Nomor WA,Nama,Total Order,Total Belanja (Rp),Terakhir Order\n';
    topCustomers.forEach(c => {
      csv += `${c.nomor},"${c.nama}",${c.total_orders},${c.total_spent},${c.last_order_at}\n`;
    });

    const filename = `laporan-penjualan-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv); // BOM untuk Excel
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
