import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { createServer } from 'http';

import { config } from './config.js';
import * as db from './database.js';
import { initWebSocket } from './websocket.js';
import { handleCasakuWebhook } from './src/payment/webhookHandler.js';
import { authenticateJWT } from './src/routes/authMiddleware.js';

// Modular Route Controllers
import authRoutes from './src/routes/authRoutes.js';
import productRoutes from './src/routes/productRoutes.js';
import orderRoutes from './src/routes/orderRoutes.js';
import customerRoutes from './src/routes/customerRoutes.js';
import analyticsRoutes from './src/routes/analyticsRoutes.js';
import settingRoutes from './src/routes/settingRoutes.js';
import chatRoutes from './src/routes/chatRoutes.js';
import featureRoutes from './src/routes/featureRoutes.js';

const app = express();

// Sesi / Status Bot Global yang dishare dari index.js & bot.js
export const botState = {
  status: 'OFFLINE', // OFFLINE, CONNECTING, ONLINE
  lastReconnect: null,
  whatsappConnected: false,
  sock: null, // Instansi soket Baileys
  reconnectCount: 0,
  lastDisconnectReason: null,
  lastCredUpdate: null,
  lastSentTimestamp: null,
  pendingQueueCount: 0,
  signalKeysOk: true
};

// ====================================================================
// CASAKU & MIDTRANS PAYMENT WEBHOOKS (RAW BODY PARSING MUST BE FIRST)
// ====================================================================
app.post(
  '/api/payment/webhook/casaku',
  express.raw({ type: 'application/json' }),
  handleCasakuWebhook
);

// Legacy dispatcher to support existing configured callback URLs
app.post(
  '/api/payment/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res, next) => {
    // If Casaku signature header is present, dispatch to Casaku handler
    if (req.headers['x-casaku-signature'] || req.headers['x-signature'] || req.headers['x-callback-signature']) {
      return handleCasakuWebhook(req, res);
    }
    // Otherwise, parse json and process with Midtrans handler
    try {
      if (Buffer.isBuffer(req.body)) {
        req.body = JSON.parse(req.body.toString('utf8'));
      }
    } catch (e) {}
    return processMidtransWebhook(req, res);
  }
);

app.post('/api/payment/webhook/midtrans', async (req, res) => {
  return processMidtransWebhook(req, res);
});

// Global Body Parsing Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve Static Pages & Assets
app.get('/', (req, res) => res.sendFile(path.resolve('public/index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.resolve('public/index.html')));
app.get('/login.html', (req, res) => res.sendFile(path.resolve('public/login.html')));
app.get('/pay/:orderId', (req, res) => res.sendFile(path.resolve('public/pay.html')));
app.use('/uploads/products', express.static(path.resolve('public/uploads/products')));
app.get('/uploads/qris.png', (req, res) => res.sendFile(path.resolve('public/uploads/qris.png')));
app.use('/receipts', authenticateJWT, express.static(path.resolve('public/receipts')));

// ====================================================================
// MOUNT MODULAR API ROUTERS
// ====================================================================
app.use('/api', authRoutes);
app.use('/api', productRoutes);
app.use('/api', orderRoutes);
app.use('/api', customerRoutes);
app.use('/api', analyticsRoutes);
app.use('/api', settingRoutes);
app.use('/api', chatRoutes);
app.use('/api', featureRoutes);

// ====================================================================
// MIDTRANS INTEGRATION & WEBHOOK HANDLER
// ====================================================================
export async function createMidtransTransaction(order) {
  const serverKey = await db.getSetting('midtransServerKey');
  const sandboxMode = await db.getSetting('midtransSandboxMode');
  
  if (!serverKey) {
    console.warn("[MIDTRANS] Server Key tidak diset. Pembayaran otomatis dilewati.");
    return null;
  }

  const isSandbox = sandboxMode !== "false";
  const baseUrl = isSandbox 
    ? 'https://app.sandbox.midtrans.com/snap/v1/transactions'
    : 'https://app.midtrans.com/snap/v1/transactions';

  const authHeader = 'Basic ' + Buffer.from(serverKey + ':').toString('base64');
  const cleanPhone = order.customer_nomor.split('@')[0];

  const payload = {
    transaction_details: {
      order_id: order.order_id,
      gross_amount: order.total
    },
    credit_card: {
      secure: true
    },
    customer_details: {
      first_name: order.customer_nama,
      phone: cleanPhone
    },
    expiry: {
      unit: "minutes",
      duration: 30
    }
  };

  try {
    if (String(order.order_id).startsWith('DEP-')) {
      await db.createDepositOrder(order.order_id, order.customer_nomor, order.total);
    }
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (res.ok && data.redirect_url) {
      await db.updateOrderPaymentLink(order.order_id, data.redirect_url, 'pending');
      return data;
    } else {
      console.error("[MIDTRANS ERROR] Gagal membuat transaksi:", data);
      return null;
    }
  } catch (err) {
    console.error("[MIDTRANS ERROR] Gagal menghubungi Midtrans Snap:", err.message);
    return null;
  }
}

async function processMidtransWebhook(req, res) {
  try {
    const notification = req.body || {};
    const { order_id, status_code, gross_amount, signature_key, transaction_status } = notification;

    if (!order_id || !status_code || !gross_amount || !signature_key) {
      return res.status(400).json({ success: false, message: "Payload tidak lengkap." });
    }

    const serverKey = await db.getSetting('midtransServerKey');
    if (!serverKey) {
      return res.status(500).json({ success: false, message: "Midtrans Server Key belum diatur di database." });
    }

    const signatureSource = order_id + status_code + gross_amount + serverKey;
    const calculatedSignature = crypto.createHash('sha512').update(signatureSource).digest('hex');

    const calcBuf = Buffer.from(calculatedSignature, 'utf8');
    const sigBuf = Buffer.from(signature_key, 'utf8');

    if (calcBuf.length !== sigBuf.length || !crypto.timingSafeEqual(calcBuf, sigBuf)) {
      console.warn(`[MIDTRANS WEBHOOK WARNING] Tanda tangan tidak cocok untuk order ${order_id}!`);
      await db.addLog("ERROR", `Peringatan Keamanan: Signature webhook Midtrans tidak cocok untuk Order ID ${order_id}.`);
      return res.status(403).json({ success: false, message: "Signature tidak valid." });
    }

    console.log(`[MIDTRANS WEBHOOK] Signature valid. Order ID: ${order_id}. Status: ${transaction_status}`);

    const order = await db.getOrderDetails(order_id);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order ID tidak ditemukan." });
    }

    if (String(order_id).startsWith('DEP-')) {
      if (Number(order.total) !== Number(gross_amount)) {
        return res.status(400).json({ success: false, message: "Nominal deposit tidak cocok." });
      }
      if (transaction_status === 'settlement' || transaction_status === 'capture') {
        const settled = await db.settleDepositOrder(order_id, order.customer_nomor, order.total, transaction_status);
        if (settled && botState.sock && botState.whatsappConnected) {
          await botState.sock.sendMessage(order.customer_nomor, {
            text: `Deposit sebesar *Rp${Number(order.total).toLocaleString('id-ID')}* berhasil masuk ke saldo Anda.`
          });
        }
        return res.json({ success: true, message: settled ? "Deposit berhasil ditambahkan." : "Deposit sudah diproses sebelumnya." });
      }
      if (['expire', 'cancel', 'deny'].includes(transaction_status)) {
        await db.updateOrderStatus(order_id, 'CANCELLED');
        return res.json({ success: true, message: "Deposit dibatalkan." });
      }
      return res.json({ success: true, message: "Webhook deposit diterima." });
    }

    if (order.status === 'WAITING_PAYMENT') {
      if (transaction_status === 'settlement' || transaction_status === 'capture') {
        await db.updateOrderStatus(order_id, 'PAID', transaction_status);
        await db.addLog("PAYMENT", `Pembayaran lunas terverifikasi via Midtrans untuk Order ID ${order_id}.`);

        let waSent = false;
        let deliveredItemsMsg = "";
        let hasAutoDelivery = false;

        const localClaimsRes = await db.claimAndDeliverItems(order_id);
        const deliveredData = localClaimsRes?.deliveredData || {};
        const localCodes = Object.keys(deliveredData);

        if (localCodes.length > 0) {
          hasAutoDelivery = true;
          deliveredItemsMsg = `🎁 *PENGIRIMAN PRODUK DIGITAL*\n\nTerima kasih! Pembayaran Anda telah kami terima dan terverifikasi otomatis (Midtrans).\n\nBerikut adalah detail pesanan Anda:\n\n`;
          
          if (localClaimsRes.itemsText) {
            deliveredItemsMsg += localClaimsRes.itemsText;
          } else {
            for (const code of localCodes) {
              const item = deliveredData[code];
              deliveredItemsMsg += `🔑 *${item.produk_nama}* (\`${code}\`):\n`;
              if (item.credentials && item.credentials.length > 0) {
                item.credentials.forEach((cred, i) => { deliveredItemsMsg += `   ${i+1}. \`\`\`${cred}\`\`\`\n`; });
              } else {
                deliveredItemsMsg += `   ⚠️ Stok habis, admin akan mengirimkan manual.\n`;
              }
              if (item.petunjuk) deliveredItemsMsg += `\n${item.petunjuk}\n`;
              deliveredItemsMsg += `\n`;
            }
          }

          deliveredItemsMsg += `\n━━━━━━━━━━━━━━━━━━\n_Simpan detail ini baik-baik. Hubungi CS jika ada kendala._`;
          
          const localOk = localCodes.every(k => deliveredData[k].credentials && deliveredData[k].credentials.length > 0);
          if (localOk) {
            await db.updateOrderStatus(order_id, 'COMPLETED');
            await db.addLog('ORDER', `✅ Order *${order_id}* auto-completed via Midtrans Webhook.`);
          } else {
            await db.updateOrderStatus(order_id, 'PROCESSING');
            await db.addLog('ORDER', `⚠️ Order *${order_id}* terbayar tapi stok habis, status set ke PROCESSING.`);
          }
        } else {
          deliveredItemsMsg = `🔔 *INFO PESANAN (Order: ${order_id})*\n\nPembayaran Anda telah *DITERIMA* dan terverifikasi otomatis. Pesanan Anda sedang diproses manual oleh admin kami. Harap menunggu.`;
        }

        if (botState.sock && botState.whatsappConnected) {
          try {
            await botState.sock.sendMessage(order.customer_nomor, { text: deliveredItemsMsg });
            waSent = true;
          } catch (err) {
            console.error(`[WEBHOOK ERROR] Gagal mengirim pesan WA ke pelanggan:`, err.message);
          }
        }

        return res.json({ 
          success: true, 
          message: "Status pembayaran berhasil diperbarui.", 
          orderStatus: hasAutoDelivery ? 'COMPLETED' : 'PAID',
          waSent 
        });

      } else if (transaction_status === 'expire' || transaction_status === 'cancel' || transaction_status === 'deny') {
        await db.updateOrderStatus(order_id, 'CANCELLED', transaction_status);
        await db.addLog("ORDER", `Order ID ${order_id} dibatalkan otomatis oleh Webhook Midtrans (Status: ${transaction_status}).`);

        const cancelMsg = `🔔 *PEMBERITAHUAN PEMBATALAN PEMBAYARAN*\n\nPesanan Anda dengan Order ID *${order_id}* telah dibatalkan karena link pembayaran telah kedaluwarsa atau transaksi ditolak.\n\nSilakan lakukan pemesanan ulang (ketik *menu*) jika Anda masih berminat membeli produk. Terima kasih.`;

        if (botState.sock && botState.whatsappConnected) {
          try {
            await botState.sock.sendMessage(order.customer_nomor, { text: cancelMsg });
          } catch (err) {
            console.error(`Gagal mengirim pembatalan WA ke pelanggan:`, err.message);
          }
        }

        return res.json({ success: true, message: "Order berhasil dibatalkan otomatis." });
      }
    }

    res.json({ success: true, message: "Webhook diterima, status order saat ini tidak dimodifikasi." });

  } catch (err) {
    console.error("[WEBHOOK ERROR]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// Server global instance
let serverInstance = null;

// Inisialisasi start server
export async function startServer() {
  await db.initDb();
  const port = config.port;
  serverInstance = createServer(app);
  
  // Bind Socket.IO ke server
  initWebSocket(serverInstance);

  serverInstance.listen(port, () => {
    console.log(`=== Dashboard Admin Web Berjalan di http://localhost:${port} ===`);
  }).on('error', (err) => {
    console.error(`Gagal menjalankan server di port ${port}:`, err.message);
  });
  return serverInstance;
}
