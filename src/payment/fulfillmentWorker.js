/**
 * Fulfillment Worker
 * Runs as a background loop. Picks PENDING/FAILED jobs from fulfillment_jobs,
 * claims & delivers digital products via WhatsApp (Baileys), and handles retries.
 *
 * Call startFulfillmentWorker(sock) once the WhatsApp socket is ready.
 * Call stopFulfillmentWorker() on disconnect.
 */
import * as db from '../../database.js';

// Retry delays in milliseconds: 10s, 30s, 2m, 5m, 15m
const RETRY_DELAYS = [10_000, 30_000, 120_000, 300_000, 900_000];
const MAX_ATTEMPTS = RETRY_DELAYS.length + 1; // 6 attempts total before MANUAL_REVIEW
const POLL_INTERVAL = 5_000; // Check for new jobs every 5 seconds

let workerRunning = false;
let workerTimer = null;
let sockRef = null;

export function startFulfillmentWorker(sock) {
  sockRef = sock;
  if (workerRunning) return;
  workerRunning = true;
  console.log('[FULFILLMENT] Worker started.');
  scheduleNextPoll(0);
}

export function stopFulfillmentWorker() {
  workerRunning = false;
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = null;
  console.log('[FULFILLMENT] Worker stopped.');
}

function scheduleNextPoll(delay = POLL_INTERVAL) {
  if (!workerRunning) return;
  workerTimer = setTimeout(async () => {
    try {
      await processJobs();
    } catch (err) {
      console.error('[FULFILLMENT] Worker poll error:', err.message);
    }
    scheduleNextPoll(POLL_INTERVAL);
  }, delay);
}

async function processJobs() {
  const jobs = await db.getPendingFulfillmentJobs();
  if (jobs.length === 0) return;

  for (const job of jobs) {
    // Check if this job should be retried yet based on attempts and last update
    if (job.attempts > 0) {
      const delayIndex = Math.min(job.attempts - 1, RETRY_DELAYS.length - 1);
      const retryAfter = job.updated_at + RETRY_DELAYS[delayIndex];
      if (Date.now() < retryAfter) continue; // Not yet time to retry
    }

    if (job.attempts >= MAX_ATTEMPTS) {
      await db.updateFulfillmentJob(job.job_id, 'MANUAL_REVIEW', 'Max retry attempts reached');
      console.warn(`[FULFILLMENT] Job ${job.job_id} → MANUAL_REVIEW after ${job.attempts} attempts.`);
      continue;
    }

    await processJob(job);
  }
}

async function processJob(job) {
  console.log(`[FULFILLMENT] Processing job ${job.job_id} for order ${job.order_id} (attempt ${job.attempts + 1})`);

  try {
    // Mark as PROCESSING
    await db.updateFulfillmentJob(job.job_id, 'PROCESSING', null);

    // Special handling for Deposit Top-up orders
    if (job.order_id.startsWith('DEP-')) {
      const orderDetails = await db.getOrderDetails(job.order_id);
      const customerJid = job.customer_number.includes('@')
        ? job.customer_number
        : `${job.customer_number.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

      const customerProfile = await db.getCustomerMembershipProfile(job.customer_number);
      let depMsg = `🎉 *TOP UP SALDO DEPOSIT BERHASIL!* 🎉\n\n`;
      depMsg += `🆔 *Deposit ID:* ${job.order_id}\n`;
      depMsg += `💰 *Nominal Top Up:* Rp${(orderDetails?.payment_amount || orderDetails?.total || 0).toLocaleString('id-ID')}\n`;
      depMsg += `💳 *Total Saldo Sekarang:* Rp${(customerProfile?.balance || 0).toLocaleString('id-ID')}\n\n`;
      depMsg += `_Saldo telah otomatis ditambahkan ke akun toko Anda dan siap digunakan untuk bertransaksi! Terima kasih. 🙏_`;

      if (!sockRef) throw new Error('WhatsApp socket not available');
      await sockRef.sendMessage(customerJid, { text: depMsg });

      await db.updateFulfillmentJob(job.job_id, 'DELIVERED', null);
      await db.runQuery(`UPDATE orders SET fulfillment_status = 'DELIVERED' WHERE order_id = ?`, [job.order_id]);
      console.log(`[FULFILLMENT] Deposit Job ${job.job_id} → DELIVERED ✅`);
      return;
    }

    // Claim digital product items from inventory
    const deliveryResult = await db.claimAndDeliverItems(job.order_id);


    if (!deliveryResult || (!deliveryResult.itemsText && !deliveryResult.manualItems)) {
      throw new Error('No items to deliver or claimAndDeliverItems returned empty');
    }

    // Get order details for message formatting
    const orderDetails = await db.getOrderDetails(job.order_id);
    const customerJid = job.customer_number.includes('@')
      ? job.customer_number
      : `${job.customer_number.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    // Build delivery message
    let deliveryMsg = `✅ *PEMBAYARAN BERHASIL DIKONFIRMASI!* ✅\n\n`;
    deliveryMsg += `📦 *Order ID:* ${job.order_id}\n`;
    deliveryMsg += `💰 *Jumlah Dibayar:* Rp${(orderDetails?.payment_amount || 0).toLocaleString('id-ID')}\n\n`;
    deliveryMsg += `━━━━━━━━━━━━━━━━━━━━\n`;
    deliveryMsg += `🎁 *PRODUK DIGITAL ANDA:*\n`;
    deliveryMsg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (deliveryResult.itemsText) {
      // AUTO delivery type — has digital content
      deliveryMsg += deliveryResult.itemsText;
    } else {
      // MANUAL delivery type — notify admin will send
      deliveryMsg += `_Pesanan Anda sedang diproses oleh Admin. Produk akan segera dikirimkan ke chat ini._`;
    }

    deliveryMsg += `\n\n━━━━━━━━━━━━━━━━━━━━\n`;
    deliveryMsg += `_Terima kasih sudah berbelanja! 🙏_\n`;
    deliveryMsg += `_Simpan pesan ini sebagai bukti pembelian._`;

    // Send via Baileys
    if (!sockRef) throw new Error('WhatsApp socket not available');

    await sockRef.sendMessage(customerJid, { text: deliveryMsg });

    // Mark as DELIVERED
    await db.updateFulfillmentJob(job.job_id, 'DELIVERED', null);
    await db.runQuery(
      `UPDATE orders SET fulfillment_status = 'DELIVERED' WHERE order_id = ?`,
      [job.order_id]
    );
    console.log(`[FULFILLMENT] Job ${job.job_id} → DELIVERED ✅`);

  } catch (err) {
    const nextAttempt = job.attempts + 1;
    const status = nextAttempt >= MAX_ATTEMPTS ? 'MANUAL_REVIEW' : 'FAILED';
    await db.updateFulfillmentJob(job.job_id, status, err.message);
    await db.runQuery(
      `UPDATE orders SET fulfillment_status = ? WHERE order_id = ?`,
      [status, job.order_id]
    );
    console.error(`[FULFILLMENT] Job ${job.job_id} FAILED (attempt ${nextAttempt}): ${err.message}`);
    if (status === 'MANUAL_REVIEW') {
      console.error(`[FULFILLMENT] ⚠️ Job ${job.job_id} needs MANUAL REVIEW — check order ${job.order_id}`);
    }
  }
}
