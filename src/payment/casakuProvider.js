/**
 * Casaku API v2 Provider
 * Handles all direct HTTP calls to api.casaku.id
 */
import https from 'https';
import { config } from '../../config.js';

const CASAKU_BASE = 'https://api.casaku.id';

function getCasakuConfig() {
  return {
    licenseKey: process.env.CASAKU_LICENSE_KEY || config.casaku?.licenseKey || '',
    webhookSecret: process.env.CASAKU_WEBHOOK_SECRET || config.casaku?.webhookSecret || '',
    qrisId: process.env.CASAKU_QRIS_ID || config.casaku?.qrisId || '',
    packageIds: (process.env.CASAKU_PACKAGE_IDS || config.casaku?.packageIds || 'id.dana')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    expiryMinutes: parseInt(process.env.CASAKU_QR_EXPIRY_MINUTES || '15', 10),
  };
}

function casakuRequest(method, path, body = null) {
  const cfg = getCasakuConfig();
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.casaku.id',
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-license-key': cfg.licenseKey,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Create a dynamic QRIS transaction via Casaku API v2.
 * Returns { transactionId, qrString, totalAmount, expiredAt, uniqueCode }
 */
export async function createCasakuQris({ orderId, subtotal }) {
  const cfg = getCasakuConfig();
  if (!cfg.licenseKey || !cfg.qrisId) {
    throw new Error('CASAKU_LICENSE_KEY atau CASAKU_QRIS_ID belum dikonfigurasi di .env');
  }

  const payload = {
    qr_id: cfg.qrisId,
    amount: subtotal,
    useUniqueCode: true,
    packageIds: cfg.packageIds,
    expiredInMinutes: cfg.expiryMinutes,
    qrType: 'dynamic',
    paymentMethod: 'qris',
    useQris: true,
    prefix: 'ORD',
  };

  const res = await casakuRequest('POST', '/api/generate/v2/qris', payload);

  if (res.status !== 200 || !res.data?.transactionId) {
    throw new Error(`Casaku API error (${res.status}): ${JSON.stringify(res.data)}`);
  }

  const d = res.data;
  return {
    transactionId: d.transactionId,
    qrString: d.qr_string || d.qrString,
    totalAmount: d.totalAmount || d.amount,
    uniqueCode: d.uniqueCode || 0,
    expiredAt: d.expiredAt || (Date.now() + cfg.expiryMinutes * 60 * 1000),
  };
}

/**
 * Check the status of a transaction (reconciliation fallback).
 * Returns: { status: 'pending'|'paid'|'expired'|'cancel', amount }
 */
export async function checkCasakuStatus(transactionId) {
  const res = await casakuRequest('POST', '/api/generate/check-status', { transactionId });
  if (res.status !== 200) {
    throw new Error(`Casaku check-status error (${res.status}): ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

/**
 * Cancel a pending transaction.
 * Best-effort: caller should handle errors gracefully.
 */
export async function cancelCasakuTransaction(transactionId) {
  try {
    const res = await casakuRequest('POST', '/api/generate/cancel-status', { transactionId });
    return { success: res.status === 200, data: res.data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export { getCasakuConfig };
