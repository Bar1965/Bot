/**
 * Payment Service — Vendor-agnostic abstraction layer.
 * bot.js calls this; never calls casakuProvider directly.
 */
import * as casaku from './casakuProvider.js';
import * as db from '../../database.js';
import { notifikasiOwner } from '../utils/notifOwner.js';

/**
 * Order yang sudah pernah dilaporkan ke owner, supaya alarm tidak diulang tiap
 * 45 detik selama order itu masih macet. Isinya hilang saat bot di-restart, dan
 * itu disengaja: sesudah restart owner memang perlu diingatkan lagi.
 */
const sudahDiperingatkan = new Set();

/**
 * Casaku bilang LUNAS, tapi kita gagal membukukannya.
 *
 * Ini keadaan terburuk yang bisa dialami toko: uang pembeli sudah masuk, produk
 * tidak dikirim. Sebelum ini TIDAK ADA APA-APA yang terjadi — kedua pemanggil
 * hanya memeriksa `result.success` lalu diam. Rekonsiliasi mengulang order yang
 * sama tiap 45 detik selamanya tanpa satu pun tanda, sampai pembelinya sendiri
 * yang mengeluh.
 *
 * Penyebab yang paling mungkin adalah TRANSACTION_NOT_FOUND: kolom
 * orders.casaku_transaction_id terisi tapi baris payment_transactions-nya tidak
 * pernah tertulis, jadi pencarian lewat provider_transaction_id gagal selamanya.
 *
 * ALREADY_PAID tidak dilaporkan — itu wajar, cuma dua rekonsiliasi berbarengan.
 */
export async function laporGagalSettle(order, result) {
  if (!result || result.reason === 'ALREADY_PAID') return;
  if (sudahDiperingatkan.has(order.order_id)) return;
  sudahDiperingatkan.add(order.order_id);

  const rincian = result.reason === 'AMOUNT_MISMATCH'
    ? `Nominal tercatat Rp${Number(result.expected || 0).toLocaleString('id-ID')}, yang dicocokkan Rp${Number(result.received || 0).toLocaleString('id-ID')}.`
    : `Kode masalah: ${result.reason || 'TIDAK_DIKETAHUI'}.`;

  const pesan =
    `🚨 *UANG MASUK TAPI PESANAN TIDAK BISA DILUNASKAN*\n\n` +
    `Casaku sudah menyatakan order ini *LUNAS*, tetapi bot gagal membukukannya, jadi produknya *belum terkirim*.\n\n` +
    `🧾 Order: ${order.order_id}\n` +
    `📱 Pelanggan: ${order.customer_nomor || '-'}\n` +
    `💸 Nominal: Rp${Number(order.payment_amount || order.total || 0).toLocaleString('id-ID')}\n\n` +
    `${rincian}\n\n` +
    `⚠️ *Uang pembeli sudah masuk.* Periksa order ini, lalu kirim produknya lewat *.paid ${order.order_id}*`;

  await notifikasiOwner(pesan);
  try {
    await db.addLog('PAYMENT', `🚨 Order ${order.order_id} LUNAS di Casaku tapi gagal dibukukan (${result.reason}).`);
  } catch (_) {}
}

/**
 * Create a Casaku QRIS payment for an existing WAITING_PAYMENT order.
 * Returns { qrString, totalAmount, expiredAt, orderId }
 */
export async function createPayment(orderId, subtotal) {
  const qrisData = await casaku.createCasakuQris({ orderId, subtotal });

  // Masa berlaku yang DICATAT harus sama dengan yang DIMINTA ke Casaku.
  //
  // Dulu angka 15 dipaku di sini sementara Casaku diberi tahu
  // CASAKU_QR_EXPIRY_MINUTES. Kalau owner menyetel 30, Casaku menjaga QR-nya
  // hidup 30 menit, tapi `expired_at` di database tertulis 15 — dan penyapu
  // kedaluwarsa membatalkan pesanannya di menit ke-15 sementara QRIS-nya masih
  // bisa dibayar setengah jam penuh. Uang masuk ke pesanan yang sudah CANCELLED.
  const menitBerlaku = casaku.getCasakuConfig().expiryMinutes;
  await db.createCasakuTransaction(
    orderId,
    qrisData.transactionId,
    qrisData.totalAmount,
    menitBerlaku,
    qrisData.qrString
  );

  return {
    orderId,
    transactionId: qrisData.transactionId,
    qrString: qrisData.qrString,
    totalAmount: qrisData.totalAmount,
    uniqueCode: qrisData.uniqueCode,
    expiredAt: qrisData.expiredAt,
  };
}

/**
 * Cancel an order's payment (call Casaku cancel endpoint and release stock in DB).
 */
export async function cancelPayment(orderId, casakuTransactionId) {
  if (!casakuTransactionId) return { ok: true, adaQris: false };

  // Hasilnya DIPERIKSA. cancelCasakuTransaction menelan galatnya sendiri dan
  // memulangkan { success: false }, dan dulu nilai itu dibuang begitu saja —
  // sehingga `.batal` membatalkan pesanan di database sambil MEMBIARKAN QRIS-nya
  // hidup di Casaku. QR itu masih ada di riwayat chat pembeli, masih bisa
  // di-scan, dan rekonsiliasi hanya melihat pesanan berstatus WAITING_PAYMENT —
  // jadi kalau dia terlanjur membayar, tidak ada satu pun jalur yang melihatnya.
  const hasil = await casaku.cancelCasakuTransaction(casakuTransactionId);
  if (!hasil.success) {
    const sebab = hasil.error || JSON.stringify(hasil.data);
    console.error(`[PAYMENT] Gagal membatalkan QRIS ${casakuTransactionId} untuk ${orderId}: ${sebab}`);
    try {
      await db.addLog('PAYMENT', `⚠️ QRIS order ${orderId} GAGAL dibatalkan di Casaku — QR lama mungkin masih bisa dibayar.`);
    } catch (_) {}
    await notifikasiOwner(
      `⚠️ *QRIS LAMA MUNGKIN MASIH HIDUP*\n\n` +
      `Pesanan *${orderId}* sudah dibatalkan di bot, tetapi permintaan pembatalan ke Casaku gagal.\n\n` +
      `Sebab: ${sebab}\n\n` +
      `Kalau pembeli terlanjur men-scan QR lamanya, uang itu TIDAK akan terdeteksi otomatis. ` +
      `Cek dashboard Casaku untuk transaksi *${casakuTransactionId}*.`
    );
    return { ok: false, adaQris: true, sebab };
  }

  return { ok: true, adaQris: true };
  // Pembatalan di database dan pelepasan stok ditangani cancelActiveOrder.
}

/**
 * Reconciliation: check stale PENDING orders against Casaku status API.
 * Call this periodically for orders PENDING > thresholdSeconds.
 */
export async function reconcileStaleOrders(thresholdSeconds = 45) {
  const stale = await db.getStalePendingOrders(thresholdSeconds);
  let recovered = 0;
  for (const order of stale) {
    if (!order.casaku_transaction_id) continue;
    try {
      const statusData = await casaku.checkCasakuStatus(order.casaku_transaction_id);
      if (statusData?.status === 'paid') {
        const result = await db.markTransactionPaid(
          order.casaku_transaction_id,
          order.payment_amount
        );
        if (result.success) {
          sudahDiperingatkan.delete(order.order_id);
          await db.createFulfillmentJob(order.order_id, order.customer_nomor);
          recovered++;
          console.log(`[PAYMENT] Reconciliation recovered order ${order.order_id}`);
        } else {
          await laporGagalSettle(order, result);
        }
      }
    } catch (err) {
      console.error(`[PAYMENT] Reconciliation check failed for ${order.order_id}:`, err.message);
    }
  }
  return recovered;
}

/**
 * On-Demand Reconciliation: Check specific order directly against Casaku status API.
 * Used when customer types .status, .cekbayar, or sends payment proof.
 */
export async function reconcileSingleOrder(orderId) {
  if (!orderId) return { success: false, reason: 'NO_ORDER_ID' };
  const order = await db.getOrderDetails(orderId);
  if (!order || !order.casaku_transaction_id) {
    return { success: false, reason: 'NO_CASAKU_TRANSACTION' };
  }
  if (order.payment_status === 'PAID' || order.status === 'COMPLETED') {
    return { success: true, reason: 'ALREADY_PAID', status: 'paid', order };
  }

  try {
    const statusData = await casaku.checkCasakuStatus(order.casaku_transaction_id);
    if (statusData?.status === 'paid') {
      const amountToVerify = order.payment_amount || order.total;
      const result = await db.markTransactionPaid(
        order.casaku_transaction_id,
        amountToVerify
      );
      if (result.success) {
        sudahDiperingatkan.delete(order.order_id);
        await db.createFulfillmentJob(order.order_id, order.customer_nomor);
        console.log(`[PAYMENT] On-demand check recovered order ${order.order_id} as PAID!`);
        return { success: true, reason: 'JUST_PAID', status: 'paid', order };
      }
      await laporGagalSettle(order, result);
      return { success: false, reason: result.reason, status: 'paid' };
    }
    return { success: false, status: statusData?.status || 'pending', reason: 'NOT_PAID_YET' };
  } catch (err) {
    console.error(`[PAYMENT] On-demand check failed for ${orderId}:`, err.message);
    return { success: false, reason: 'API_ERROR', error: err.message };
  }
}
