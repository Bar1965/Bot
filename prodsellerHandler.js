/**
 * prodsellerHandler.js
 * Handler untuk integrasi ProdSeller API sebagai supplier produk digital otomatis.
 */

import * as nodeHttp from 'http';
import * as nodeHttps from 'https';
import * as db from './database.js';

const API_KEY  = process.env.PRODSELLER_API_KEY || '';
const BASE_URL = process.env.PRODSELLER_BASE_URL || 'http://51.77.244.194/v1';

function apiRequest(method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    if (!API_KEY || API_KEY === 'psk_YOUR_NEW_KEY_HERE') {
      return reject(new Error('PRODSELLER_API_KEY belum dikonfigurasi di .env'));
    }
    const url = new URL(`${BASE_URL}${path}`);
    const lib = url.protocol === 'https:' ? nodeHttps : nodeHttp;
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'X-API-Key': API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...extraHeaders
      },
      timeout: 30000
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          else resolve(parsed);
        } catch {
          reject(new Error(`Response bukan JSON: ${data.slice(0, 100)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout ke ProdSeller API')); });
    if (payload) req.write(payload);
    req.end();
  });
}

export async function fetchProducts() {
  const res = await apiRequest('GET', '/products');
  return res.products || [];
}

export async function fetchBalance() {
  return await apiRequest('GET', '/balance');
}

export async function createOrder(productId, quantity = 1, idempotencyKey = '') {
  return await apiRequest(
    'POST', '/orders',
    { productId, quantity },
    idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}
  );
}

export async function getOrderStatus(prodsellerOrderId) {
  return await apiRequest('GET', `/orders/${prodsellerOrderId}`);
}

export async function deliverViaProdSeller(botOrderId, orderItems) {
  const delivered = {};
  const errors = [];
  const prodsellerItems = orderItems.filter(item => item.prodseller_id);

  for (const item of prodsellerItems) {
    const { produk_kode, produk_nama, prodseller_id, qty, petunjuk } = item;
    const idempotencyKey = `${botOrderId}_${produk_kode}`.slice(0, 100);
    try {
      console.log(`[PRODSELLER] Ordering ${qty}x "${produk_nama}" (PS ID: ${prodseller_id})...`);
      const orderRes = await createOrder(prodseller_id, qty, idempotencyKey);
      let keys = [];
      if (Array.isArray(orderRes.deliveredKeys)) keys = orderRes.deliveredKeys;
      else if (orderRes.deliveredKey) keys = [orderRes.deliveredKey];

      await db.saveProdsellerOrder({
        order_id: botOrderId,
        prodseller_order_id: orderRes.orderId || null,
        produk_kode,
        prodseller_product_id: prodseller_id,
        quantity: qty,
        amount_usd: orderRes.amount || null,
        delivered_keys: keys,
        status: keys.length > 0 ? 'DELIVERED' : 'PENDING',
        error_message: null
      });

      delivered[produk_kode] = { produk_nama: produk_nama || produk_kode, keys, petunjuk: petunjuk || null };
      console.log(`[PRODSELLER] SUCCESS: ${keys.length} key(s) for ${produk_kode}`);
    } catch (err) {
      console.error(`[PRODSELLER] FAILED for ${produk_kode}:`, err.message);
      await db.saveProdsellerOrder({
        order_id: botOrderId,
        prodseller_order_id: null,
        produk_kode,
        prodseller_product_id: prodseller_id,
        quantity: qty,
        amount_usd: null,
        delivered_keys: null,
        status: 'FAILED',
        error_message: err.message
      });
      errors.push({ produk_kode, produk_nama, error: err.message });
    }
  }
  return { delivered, errors };
}

export function formatProductList(products) {
  if (!products || products.length === 0) return '❌ Tidak ada produk tersedia di ProdSeller saat ini.';
  let msg = `🏪 *DAFTAR PRODUK PRODSELLER*\n━━━━━━━━━━━━━━━━━━\n\n`;
  products.forEach((p, i) => {
    const stock = p.inStock ? '✅ Tersedia' : '❌ Habis';
    const price = p.price != null ? `$${Number(p.price).toFixed(2)} USD` : 'N/A';
    const pubPrice = p.publicPrice != null ? ` _(normal: $${Number(p.publicPrice).toFixed(2)})_` : '';
    msg += `${i + 1}. *${p.name}*\n   💰 ${price}${pubPrice}  |  ${stock}\n   🆔 \`${p.id}\`\n\n`;
  });
  msg += `━━━━━━━━━━━━━━━━━━\n_Gunakan .setpsid [KODE] [ID] untuk link ke produk bot_`;
  return msg;
}

// Mengecek perubahan harga & stok untuk trigger notifikasi otomatis
export async function getProdSellerUpdates() {
  const priceDrops = [];
  const restocks = [];

  try {
    const apiProducts = await fetchProducts();
    const localProducts = await db.allQuery("SELECT * FROM products WHERE prodseller_id IS NOT NULL");
    
    if (!apiProducts || apiProducts.length === 0 || !localProducts || localProducts.length === 0) {
      return { priceDrops, restocks };
    }

    const apiMap = {};
    apiProducts.forEach(p => { apiMap[p.id] = p; });

    for (const lp of localProducts) {
      const ap = apiMap[lp.prodseller_id];
      if (!ap) continue;

      const currentPrice = ap.price != null ? Number(ap.price) : 0;
      const currentStockStatus = ap.inStock ? 1 : 0;
      
      const lastPrice = lp.last_price != null ? Number(lp.last_price) : currentPrice;
      const lastStockStatus = lp.last_stock_status != null ? lp.last_stock_status : currentStockStatus;

      // Cek Price Drop
      if (currentPrice < lastPrice && lp.last_price != null) {
        priceDrops.push({
          kode: lp.kode,
          nama: lp.nama,
          oldPrice: lastPrice,
          newPrice: currentPrice
        });
      }

      // Cek Restock (dari 0 ke 1)
      if (currentStockStatus === 1 && lastStockStatus === 0) {
        restocks.push({
          kode: lp.kode,
          nama: lp.nama,
          price: currentPrice
        });
      }

      // Update DB if changed
      if (currentPrice !== lp.last_price || currentStockStatus !== lp.last_stock_status) {
        await db.updateProductLastState(lp.kode, currentPrice, currentStockStatus);
      }
    }
  } catch (err) {
    console.error("[PRODSELLER] Gagal mengecek update otomatis:", err.message);
  }

  return { priceDrops, restocks };
}

