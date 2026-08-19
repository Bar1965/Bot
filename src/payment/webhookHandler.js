/**
 * Casaku Webhook Handler
 * Must be mounted BEFORE express.json() with express.raw() body parser.
 *
 * Security:
 * - HMAC-SHA256 on raw body using CASAKU_WEBHOOK_SECRET
 * - crypto.timingSafeEqual for constant-time comparison
 * - Edge cases: missing signature, malformed hex, wrong length → 401
 * - Duplicate (already processed) → 200 no-op (prevents Casaku retry)
 * - Amount mismatch → 200 + log REJECTED (prevents unnecessary retry)
 * - Internal server error → 500 (triggers Casaku retry)
 */
import crypto from 'crypto';
import * as db from '../../database.js';

const WEBHOOK_SECRET = () => process.env.CASAKU_WEBHOOK_SECRET || '';

function verifySignature(rawBody, signatureHeader) {
  const secret = WEBHOOK_SECRET();
  if (!secret) {
    console.error('[WEBHOOK] CASAKU_WEBHOOK_SECRET tidak dikonfigurasi!');
    return false;
  }

  if (!signatureHeader || typeof signatureHeader !== 'string') return false;

  let signatureBuffer;
  try {
    // Guard against malformed/non-hex signature
    if (!/^[0-9a-fA-F]+$/.test(signatureHeader)) return false;
    signatureBuffer = Buffer.from(signatureHeader, 'hex');
  } catch {
    return false;
  }

  const expectedBuffer = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest();

  if (signatureBuffer.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}

export async function handleCasakuWebhook(req, res) {
  const rawBody = req.body; // Buffer from express.raw()
  const signatureHeader = req.headers['x-casaku-signature'] || req.headers['x-signature'] || '';

  // Step 1: Log receipt immediately (best effort, don't let log error crash handler)
  let webhookLogId = null;
  let parsedPayload = null;

  try {
    parsedPayload = JSON.parse(rawBody.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  try {
    webhookLogId = await db.logWebhookEvent(
      parsedPayload?.transactionId,
      signatureHeader,
      parsedPayload,
      'RECEIVED'
    );
  } catch (logErr) {
    console.error('[WEBHOOK] Failed to log webhook receipt:', logErr.message);
  }

  // Step 2: Verify HMAC signature
  const signatureValid = verifySignature(rawBody, signatureHeader);
  if (!signatureValid) {
    console.warn('[WEBHOOK] Signature INVALID:', signatureHeader?.substring(0, 10), '...');
    if (webhookLogId) {
      try { await db.updateWebhookStatus(webhookLogId, 'REJECTED'); } catch {}
    }
    return res.status(401).json({ error: 'Invalid signature' });
  }

  if (webhookLogId) {
    try { await db.updateWebhookStatus(webhookLogId, 'VERIFIED'); } catch {}
  }

  // Step 3: Validate required fields
  const { transactionId, amount, status } = parsedPayload;
  if (!transactionId || !amount || status !== 'paid') {
    console.warn('[WEBHOOK] Missing fields or status not paid:', { transactionId, amount, status });
    if (webhookLogId) {
      try { await db.updateWebhookStatus(webhookLogId, 'REJECTED'); } catch {}
    }
    // Return 200 to prevent Casaku from retrying non-payment webhooks
    return res.status(200).json({ received: true, processed: false, reason: 'not_paid_status' });
  }

  // Step 4: Idempotency check + amount validation + atomic PAID
  let result;
  try {
    result = await db.markTransactionPaid(transactionId, amount);
  } catch (err) {
    console.error('[WEBHOOK] DB error during markTransactionPaid:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (result.reason === 'TRANSACTION_NOT_FOUND') {
    console.warn('[WEBHOOK] Transaction not found:', transactionId);
    if (webhookLogId) {
      try { await db.updateWebhookStatus(webhookLogId, 'REJECTED'); } catch {}
    }
    return res.status(200).json({ received: true, processed: false, reason: 'transaction_not_found' });
  }

  if (result.reason === 'ALREADY_PAID') {
    console.log('[WEBHOOK] Duplicate webhook, already paid:', transactionId);
    if (webhookLogId) {
      try { await db.updateWebhookStatus(webhookLogId, 'DUPLICATE'); } catch {}
    }
    return res.status(200).json({ received: true, processed: false, reason: 'duplicate' });
  }

  if (result.reason === 'AMOUNT_MISMATCH') {
    console.warn('[WEBHOOK] Amount mismatch:', { expected: result.expected, received: result.received });
    if (webhookLogId) {
      try { await db.updateWebhookStatus(webhookLogId, 'REJECTED'); } catch {}
    }
    // Return 200 to prevent retry loop for wrong amount
    return res.status(200).json({ received: true, processed: false, reason: 'amount_mismatch' });
  }

  // Step 5: Queue fulfillment job (async — do NOT await delivery here)
  if (result.success) {
    try {
      await db.createFulfillmentJob(result.orderId, result.customerNumber);
      if (webhookLogId) {
        try { await db.updateWebhookStatus(webhookLogId, 'PROCESSED'); } catch {}
      }
      console.log(`[WEBHOOK] Payment confirmed. Order: ${result.orderId}, fulfillment job queued.`);

      // Broadcast event ke Admin Dashboard secara real-time
      import('../../websocket.js').then(ws => {
        ws.broadcastToAdmins('order:paid', {
          orderId: result.orderId,
          amount: amount,
          customerNumber: result.customerNumber,
          timestamp: Date.now()
        });
      }).catch(() => {});
    } catch (err) {
      console.error('[WEBHOOK] Failed to create fulfillment job:', err.message);
      // Still return 200 — payment IS marked PAID in DB. Worker will recover on restart.
    }
  }

  // Step 6: Return 200 immediately — do NOT await WhatsApp delivery in webhook handler
  return res.status(200).json({ received: true, processed: true });
}
