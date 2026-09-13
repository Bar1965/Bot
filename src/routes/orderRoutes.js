import express from 'express';
import * as db from '../../database.js';
import { botState } from '../../server.js';
import { pesanErrorAman } from './responErr.js';
import {
  authenticateJWT,
  authorizeRoles
} from './authMiddleware.js';

const router = express.Router();

// Public Invoice API
router.get('/pay/:orderId', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    if (!orderId || !/^[a-zA-Z0-9_-]+$/.test(orderId)) {
      return res.status(400).json({ success: false, message: "Format Order ID tidak valid." });
    }
    const invoice = await db.getOrderPublicInvoice(orderId);
    if (!invoice) {
      return res.status(404).json({ success: false, message: "Pesanan tidak ditemukan." });
    }
    res.json({ success: true, invoice });
  } catch (err) {
    console.error("Error getOrderPublicInvoice:", err);
    res.status(500).json({ success: false, message: "Terjadi kesalahan pada server." });
  }
});

// Semua role diizinkan melihat tabel orders
router.get('/orders', authenticateJWT, async (req, res) => {
  try {
    const orders = await db.getAllOrders();
    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'ORDER') });
  }
});

// Pengolahan order action (pembatasan berdasarkan role di dalam handler)
router.post('/orders/:orderId/action', authenticateJWT, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { action } = req.body || {}; // approve, complete, reject
    const userRole = req.user.role;

    if (!['approve', 'complete', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: "Aksi tidak dikenal." });
    }

    const currentOrder = await db.getOrderById(orderId);
    if (!currentOrder) {
      return res.status(404).json({ success: false, message: "Order ID tidak ditemukan." });
    }
    const allowedStatuses = {
      approve: ['WAITING_CONFIRMATION'],
      complete: ['PAID'],
      reject: ['WAITING_PAYMENT', 'WAITING_CONFIRMATION']
    };
    if (!allowedStatuses[action].includes(currentOrder.status)) {
      return res.status(409).json({
        success: false,
        message: `Aksi ${action} tidak dapat dilakukan saat status order ${currentOrder.status}.`
      });
    }

    if (userRole === 'CS' && action !== 'complete') {
      return res.status(403).json({ 
        success: false, 
        message: "Akses Ditolak. Customer Service hanya memiliki izin untuk menandai pesanan selesai (COMPLETED)." 
      });
    }

    let nextStatus = "";
    let customerMessage = "";

    if (action === 'approve') {
      nextStatus = "PAID";
      customerMessage = `🔔 *INFO PESANAN (Order: ${orderId})*\n\nPembayaran Anda telah *DITERIMA* dan diverifikasi oleh admin. Pesanan Anda saat ini sedang diproses. Harap menunggu informasi selanjutnya. Terima kasih!`;
    } else if (action === 'complete') {
      nextStatus = "COMPLETED";
      customerMessage = `🔔 *INFO PESANAN (Order: ${orderId})*\n\nPesanan Anda telah *SELESAI* diproses / dikirimkan oleh admin!\nSilakan cek akun/detail pesanan Anda. Jika ada kendala, hubungi admin. Terima kasih telah berbelanja! 🙏`;
    } else if (action === 'reject') {
      nextStatus = "CANCELLED";
      customerMessage = `🔔 *INFO PESANAN (Order: ${orderId})*\n\nMohon maaf, pesanan Anda dengan Order ID *${orderId}* telah *DIBATALKAN* oleh admin. Jika Anda sudah mentransfer, silakan hubungi admin di chat ini untuk konfirmasi manual.`;
    }

    const updateRes = await db.updateOrderStatus(orderId, nextStatus);
    if (!updateRes.success) {
      return res.status(400).json({ success: false, message: updateRes.message });
    }

    let waSent = false;
    if (botState.sock && botState.whatsappConnected) {
      try {
        await botState.sock.sendMessage(updateRes.customerNomor, { text: customerMessage });
        waSent = true;
      } catch (err) {
        console.error(`Gagal mengirim notifikasi WA ke pelanggan untuk order ${orderId}:`, err.message);
      }
    }

    res.json({ 
      success: true, 
      message: `Pesanan berhasil di-update ke status *${nextStatus}*.`,
      waNotified: waSent 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'ORDER') });
  }
});

// Endpoint menghapus 1 order (Admin & Owner)
router.delete('/orders/:orderId', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const result = await db.deleteOrder(orderId);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'ORDER') });
  }
});

// Endpoint pembersihan riwayat order massal — OWNER SAJA.
//
// Ini perintah paling merusak di seluruh dashboard: `clearOrders('ALL')` menghapus
// SETIAP baris `orders` dan `order_items` tanpa soft-delete, tanpa cadangan, tanpa
// jalur pengembalian. Yang hilang bukan cuma daftar pesanan, tapi seluruh dasar
// perhitungan omzet, produk terlaris, dan riwayat belanja tiap pelanggan.
//
// Dua cacat yang diperbaiki di sini:
//   1. `authorizeRoles('Owner', 'Admin')` — peran Admin boleh MENGHAPUS seluruh
//      riwayat penjualan, padahal untuk sekadar MELIHAT omzet di /api/stats dan
//      /api/analytics dia harus Owner. Wewenang menghapus tidak boleh melebihi
//      wewenang membaca.
//   2. Gagal-terbuka: `validFilters.includes(req.body.filter) ? ... : 'ALL'`.
//      Body kosong, salah ketik nama filter, Content-Type salah, atau permintaan
//      yang tidak sengaja terkirim SEMUANYA jatuh ke 'ALL' — pilihan paling
//      merusak dijadikan nilai bawaan. Sekarang gagal-tertutup: filter tidak
//      dikenal ditolak 400, dan 'ALL' wajib disertai kalimat konfirmasi persis.
router.post('/orders/clear', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const KALIMAT_KONFIRMASI = 'HAPUS SEMUA RIWAYAT';
    const validFilters = ['ALL', 'CANCELLED_CART', 'COMPLETED'];
    const filter = String(req.body?.filter || '').trim().toUpperCase();

    if (!validFilters.includes(filter)) {
      return res.status(400).json({
        success: false,
        message: `Filter wajib salah satu dari: ${validFilters.join(', ')}.`
      });
    }

    if (filter === 'ALL' && String(req.body?.confirm || '').trim() !== KALIMAT_KONFIRMASI) {
      return res.status(400).json({
        success: false,
        message: `Penghapusan SELURUH riwayat wajib disertai konfirmasi. Kirim confirm: "${KALIMAT_KONFIRMASI}".`
      });
    }

    const result = await db.clearOrders(filter, req.user?.username || 'unknown');
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'ORDER') });
  }
});

export default router;
