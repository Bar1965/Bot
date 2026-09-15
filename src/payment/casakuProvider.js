/**
 * Casaku API v2 Provider
 * Handles all direct HTTP calls to api.casaku.id
 */
import https from 'https';
import { config } from '../../config.js';

const CASAKU_BASE = 'https://api.casaku.id';

// Bot ini melayani pelanggan yang sedang menunggu balasan di WhatsApp; lebih baik
// gagal cepat dengan pesan jelas daripada menggantung tanpa suara.
const BATAS_WAKTU_MS = 20_000;

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
    let selesai = false;
    const sekali = (fn) => (arg) => { if (selesai) return; selesai = true; fn(arg); };
    const beres = sekali(resolve);
    const gagal = sekali(reject);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          beres({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          beres({ status: res.statusCode, data });
        }
      });
    });

    // BATAS WAKTU. Tanpa ini, koneksi yang tersambung lalu menggantung membuat
    // Promise ini TIDAK PERNAH selesai: `await createPayment(...)` di dalam
    // checkout menggantung selamanya, blok try/catch-nya tidak pernah jalan, dan
    // pelanggan tidak menerima apa pun — bukan QRIS, bukan pesan gagal. Node
    // tidak memasang batas waktu apa pun sendiri untuk https.request.
    req.setTimeout(BATAS_WAKTU_MS, () => {
      req.destroy(new Error(`Casaku tidak menjawab dalam ${BATAS_WAKTU_MS / 1000} detik`));
    });

    req.on('error', gagal);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Casaku MEMBUNGKUS jawabannya: { status, data: { ...isi sungguhan... } }.
 *
 * Inilah yang selama ini mematikan seluruh jalur pembayaran toko. Kode lama
 * membaca `res.data.transactionId`, padahal transactionId ada satu tingkat
 * lebih dalam di `res.data.data.transactionId`. Jadi bahkan saat Casaku
 * menjawab 200 dengan QRIS yang sah lengkap dengan qr_string dan payment_url,
 * pemeriksaannya gagal, pesanan pelanggan dibatalkan, dan log menulis
 * "Casaku API error (200)" — galat yang berisi jawaban sukses.
 *
 * Bentuk tanpa bungkus tetap didukung, karena tidak semua endpoint membungkus
 * dan menebak salah satunya berarti mematikan jalur uang lagi.
 */
function isiJawaban(body) {
  if (body && typeof body === 'object' && body.data && typeof body.data === 'object') {
    return body.data;
  }
  return body;
}

/**
 * Kode status yang SESUNGGUHNYA. Casaku pernah menjawab HTTP 200 dengan
 * `{"status":403,"message":"...listener sedang offline..."}` di dalamnya, jadi
 * status HTTP saja tidak cukup untuk menyimpulkan berhasil.
 */
function kodeJawaban(httpStatus, body) {
  const dalam = Number(body?.status);
  return Number.isFinite(dalam) ? dalam : Number(httpStatus);
}

/**
 * Pesan galat yang bisa ditindaklanjuti owner, bukan tumpahan JSON.
 *
 * Dua kegagalan paling sering di toko ini punya jalan keluar yang jelas, dan
 * jalan keluarnya harus ikut tertulis — owner membaca pesan ini di WhatsApp,
 * bukan membuka berkas log.
 */
function pesanGagalCasaku(httpStatus, body) {
  const kode = kodeJawaban(httpStatus, body);
  const pesan = String(body?.message || '').trim();

  if (/listener/i.test(pesan) || /aplikasi casaku/i.test(pesan)) {
    return 'Aplikasi Casaku di HP sedang OFFLINE. Buka aplikasi Casaku di HP, tunggu statusnya hijau, lalu coba lagi.';
  }
  if (/langganan|subscribe|pricing/i.test(pesan)) {
    return 'Langganan Casaku belum aktif. Perpanjang di https://casaku.id/pricing, lalu coba lagi.';
  }
  if (kode === 401 || kode === 403) {
    return `Casaku menolak permintaan (${kode})${pesan ? `: ${pesan}` : ''}. Periksa CASAKU_LICENSE_KEY dan CASAKU_QRIS_ID.`;
  }
  return `Casaku gagal (${kode})${pesan ? `: ${pesan}` : `: ${JSON.stringify(body).slice(0, 200)}`}`;
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
  const kode = kodeJawaban(res.status, res.data);
  const d = isiJawaban(res.data);

  if (kode !== 200 || !d?.transactionId) {
    throw new Error(pesanGagalCasaku(res.status, res.data));
  }

  // qr_string WAJIB ada. Tanpa itu pelanggan menerima "QRIS siap" tanpa kode
  // yang bisa dipindai, dan pesanannya menggantung sampai kedaluwarsa.
  const qrString = d.qr_string || d.qrString;
  if (!qrString) {
    throw new Error(`Casaku memulangkan transaksi ${d.transactionId} tanpa qr_string.`);
  }

  return {
    transactionId: d.transactionId,
    qrString,
    // totalAmount adalah nominal yang HARUS dibayar pelanggan. Kalau Casaku
    // menambahkan kode unik, angkanya berbeda dari subtotal — memakai subtotal
    // membuat pembayaran tidak pernah cocok saat rekonsiliasi.
    totalAmount: d.totalAmount ?? d.amount ?? subtotal,
    uniqueCode: d.uniqueNominal ?? d.uniqueCode ?? 0,
    expiredAt: d.expiredAt || (Date.now() + cfg.expiryMinutes * 60 * 1000),
    paymentUrl: d.payment_url || d.paymentUrl || null,
  };
}

/**
 * Check the status of a transaction (reconciliation fallback).
 * Returns: { status: 'pending'|'paid'|'expired'|'cancel', amount }
 */
export async function checkCasakuStatus(transactionId) {
  const res = await casakuRequest('POST', '/api/generate/check-status', { transactionId });
  const kode = kodeJawaban(res.status, res.data);
  if (kode !== 200) {
    throw new Error(pesanGagalCasaku(res.status, res.data));
  }

  // Bungkusnya HARUS dibuka di sini.
  //
  // Dulu fungsi ini memulangkan `res.data`, yaitu amplopnya: { status: 200,
  // data: { status: 'paid', ... } }. Pemanggilnya memeriksa
  // `statusData.status === 'paid'` — dan yang dibacanya adalah ANGKA 200,
  // tidak pernah string 'paid'. Jadi rekonsiliasi tidak pernah bisa menemukan
  // satu pun pembayaran yang sudah lunas.
  //
  // Bot ini jalan di laptop rumah tanpa domain, jadi webhook masuk mustahil dan
  // penarikan status berkala inilah SATU-SATUNYA cara pembayaran dibukukan.
  // Selama bungkusnya tidak dibuka, tidak ada uang yang pernah bisa masuk.
  return isiJawaban(res.data);
}

/**
 * Cancel a pending transaction.
 * Best-effort: caller should handle errors gracefully.
 */
export async function cancelCasakuTransaction(transactionId) {
  try {
    const res = await casakuRequest('POST', '/api/generate/cancel-status', { transactionId });
    return { success: kodeJawaban(res.status, res.data) === 200, data: isiJawaban(res.data) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export { getCasakuConfig };
