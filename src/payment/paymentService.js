/**
 * Payment Service — Vendor-agnostic abstraction layer.
 * bot.js calls this; never calls casakuProvider directly.
 */
import * as casaku from './casakuProvider.js';
import * as db from '../../database.js';

/**
 * Create a Casaku QRIS payment for an existing WAITING_PAYMENT order.
 * Returns { qrString, totalAmount, expiredAt, orderId }
 */
export async function createPayment(orderId, subtotal) {
  const qrisData = await casaku.createCasakuQris({ orderId, subtotal });

  // Persist transaction to DB
  await db.createCasakuTransaction(
    orderId,
    qrisData.transactionId,
    qrisData.totalAmount,
    15
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
  if (casakuTransactionId) {
    await casaku.cancelCasakuTransaction(casakuTransactionId);
  }
  // DB cancel & stock release handled by cancelActiveOrder in database.js
}

/**
 * Reconciliation: check stale PENDING orders against Casaku status API.
 * Call this periodically (e.g. every 5 minutes) for orders PENDING > 3 minutes.
 */
export async function reconcileStaleOrders() {
  const stale = await db.getStalePendingOrders(3);
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
          await db.createFulfillmentJob(order.order_id, order.customer_nomor);
          recovered++;
          console.log(`[PAYMENT] Reconciliation recovered order ${order.order_id}`);
        }
      }
    } catch (err) {
      console.error(`[PAYMENT] Reconciliation check failed for ${order.order_id}:`, err.message);
    }
  }
  return recovered;
}
