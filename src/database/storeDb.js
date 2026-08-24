import { runQuery, getQuery, allQuery, withTransaction, formatPhoneNumber, normalizePhoneDigits, isPhoneMatch } from './connection.js';

import { addLog, generateOrderId, addLoyaltyPoints } from './userDb.js';
import { addCustomerBalance, deductCustomerBalance } from './gamesDb.js';


// --- FUNGSI SUBSCRIPTIONS (NOTIFIKASI STOK) ---

export async function addSubscription(customerNomor, productKode) {
  try {
    await runQuery(
      "INSERT OR IGNORE INTO subscriptions (customer_nomor, produk_kode) VALUES (?, ?)",
      [customerNomor, productKode.toUpperCase()]
    );
    await addLog("SYSTEM", `Pelanggan ${customerNomor} berlangganan notifikasi untuk produk ${productKode.toUpperCase()}`);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

export async function getSubscribers(productKode) {
  const code = productKode.toUpperCase();
  const rows = await allQuery("SELECT customer_nomor FROM subscriptions WHERE produk_kode = ?", [code]);
  return rows;
}

export async function getAndClearSubscribers(productKode) {
  const code = productKode.toUpperCase();
  // Ambil semua subscriber
  const rows = await allQuery("SELECT customer_nomor FROM subscriptions WHERE produk_kode = ?", [code]);
  // Hapus dari database
  await runQuery("DELETE FROM subscriptions WHERE produk_kode = ?", [code]);
  return rows.map(r => r.customer_nomor);
}


// --- FUNGSI MANAJEMEN PRODUK & KREDENSIAL ---

export function getBrandEmoji(brand) {
  const b = (brand || '').toLowerCase();
  if (b.includes('netflix')) return '🎬';
  if (b.includes('spotify')) return '🎵';
  if (b.includes('youtube')) return '📺';
  if (b.includes('canva')) return '🎨';
  if (b.includes('disney')) return '🏰';
  if (b.includes('chatgpt') || b.includes('openai') || b.includes('gemini') || b.includes('ai')) return '🤖';
  if (b.includes('capcut')) return '✂️';
  if (b.includes('prime') || b.includes('amazon')) return '📦';
  if (b.includes('apple')) return '🍎';
  if (b.includes('adobe')) return '🖌️';
  if (b.includes('office') || b.includes('microsoft')) return '📑';
  return '📦';
}

export async function getGroupedCatalog() {
  const allProducts = await allQuery("SELECT * FROM products ORDER BY brand_category ASC, harga ASC");
  if (!allProducts || allProducts.length === 0) return [];

  const groupsMap = new Map();

  for (const p of allProducts) {
    let brandKey = (p.brand_category || '').trim();
    if (!brandKey) {
      const firstWord = (p.nama || '').trim().split(/\s+/)[0];
      brandKey = firstWord || p.kode;
    }
    const normalizedKey = brandKey.toUpperCase();

    if (!groupsMap.has(normalizedKey)) {
      groupsMap.set(normalizedKey, {
        brand: brandKey,
        icon: getBrandEmoji(brandKey),
        variants: [],
        min_price: p.harga,
        max_price: p.harga,
        total_stock: 0,
        durations: new Set(),
        types: new Set()
      });
    }

    const group = groupsMap.get(normalizedKey);
    group.variants.push(p);
    group.total_stock += (p.stok || 0);
    if (p.harga < group.min_price) group.min_price = p.harga;
    if (p.harga > group.max_price) group.max_price = p.harga;
    if (p.duration) group.durations.add(p.duration);
    if (p.variant_type) group.types.add(p.variant_type);
  }

  return Array.from(groupsMap.values()).map(g => ({
    ...g,
    durations: Array.from(g.durations),
    types: Array.from(g.types),
    is_multi: g.variants.length > 1
  }));
}

export async function getProductVariants(query) {
  const q = String(query || '').trim().toUpperCase();
  if (!q) return { exactProduct: null, variants: [] };

  // 1. Cek jika query adalah kode produk yang persis
  const exact = await getQuery("SELECT * FROM products WHERE UPPER(kode) = ?", [q]);
  
  // 2. Cari semua produk yang punya brand_category sama atau nama mengandung kata kunci
  const variants = await allQuery(
    "SELECT * FROM products WHERE UPPER(brand_category) = ? OR UPPER(brand_category) LIKE ? OR UPPER(nama) LIKE ? OR UPPER(kode) LIKE ? ORDER BY variant_type ASC, harga ASC",
    [q, `%${q}%`, `%${q}%`, `%${q}%`]
  );

  return {
    exactProduct: exact || null,
    variants: variants || []
  };
}

export async function getProducts() {
  return await allQuery("SELECT * FROM products ORDER BY brand_category ASC, harga ASC");
}

export async function getProductByKode(kode) {
  return await getQuery("SELECT * FROM products WHERE UPPER(kode) = ?", [kode.toUpperCase()]);
}

export async function addProduct(
  kode, nama, harga, stok, deskripsi, gambar = "", delivery_type = "MANUAL", 
  oldKode = "", petunjuk = "", brand_category = null, variant_type = null, duration = null
) {
  const normalizedKode = String(kode || '').trim().toUpperCase();
  const normalizedNama = String(nama || '').trim();
  if (!/^[A-Z0-9_-]{2,40}$/.test(normalizedKode)) {
    throw new Error('Kode produk tidak valid.');
  }
  if (normalizedNama.length < 1 || normalizedNama.length > 120) {
    throw new Error('Nama produk harus berisi 1-120 karakter.');
  }
  if (!Number.isInteger(harga) || harga < 0 || harga > 1_000_000_000) {
    throw new Error('Harga produk tidak valid.');
  }
  if (!Number.isInteger(stok) || stok < 0 || stok > 1_000_000) {
    throw new Error('Stok produk tidak valid.');
  }
  if (!['MANUAL', 'AUTO'].includes(delivery_type)) {
    throw new Error('Tipe pengiriman produk tidak valid.');
  }
  let finalStok = stok;
  const newKodeUpper = normalizedKode;

  // Jika kode produk diubah (oldKode diset dan berbeda dengan kode baru)
  if (oldKode && oldKode.toUpperCase() !== newKodeUpper) {
    const oldUpper = oldKode.toUpperCase();
    await runQuery("UPDATE product_items SET produk_kode = ? WHERE produk_kode = ?", [newKodeUpper, oldUpper]);
    await runQuery("UPDATE order_items SET produk_kode = ? WHERE produk_kode = ?", [newKodeUpper, oldUpper]);
    await runQuery("UPDATE subscriptions SET produk_kode = ? WHERE produk_kode = ?", [newKodeUpper, oldUpper]);
    await runQuery("UPDATE wishlist SET produk_kode = ? WHERE produk_kode = ?", [newKodeUpper, oldUpper]);
    await runQuery("UPDATE flash_sales SET produk_kode = ? WHERE produk_kode = ?", [newKodeUpper, oldUpper]);
    await runQuery("UPDATE products SET kode = ? WHERE kode = ?", [newKodeUpper, oldUpper]);
  }

  if (delivery_type === 'AUTO') {
    finalStok = await getAvailableItemsCount(newKodeUpper);
  }

  const res = await runQuery(
    "INSERT OR REPLACE INTO products (kode, nama, harga, stok, deskripsi, gambar, delivery_type, petunjuk, brand_category, variant_type, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [newKodeUpper, normalizedNama, harga, finalStok, deskripsi, gambar, delivery_type, petunjuk, brand_category, variant_type, duration]
  );
  await addLog("SYSTEM", `Produk diperbarui/ditambahkan: ${newKodeUpper} - ${nama} (Stok: ${finalStok}, Tipe: ${delivery_type})`);
  return res;
}

export async function deleteProduct(kode) {
  const res = await runQuery("DELETE FROM products WHERE kode = ?", [kode.toUpperCase()]);
  await addLog("SYSTEM", `Produk dengan kode ${kode.toUpperCase()} dihapus.`);
  return res;
}

export async function updateProductStock(kode, stok) {
  if (!Number.isInteger(stok) || stok < 0 || stok > 1_000_000) {
    throw new Error('Stok produk tidak valid.');
  }
  const res = await runQuery(
    "UPDATE products SET stok = ? WHERE kode = ?",
    [stok, kode.toUpperCase()]
  );
  await addLog("SYSTEM", `Stok produk ${kode.toUpperCase()} diubah menjadi ${stok} pcs.`);
  return res;
}

export async function updateProductPrice(kode, harga) {
  if (!Number.isInteger(harga) || harga < 0 || harga > 1_000_000_000) {
    throw new Error('Harga produk tidak valid.');
  }
  const res = await runQuery(
    "UPDATE products SET harga = ? WHERE kode = ?",
    [harga, kode.toUpperCase()]
  );
  await addLog("SYSTEM", `Harga produk ${kode.toUpperCase()} diubah menjadi Rp${harga}.`);
  return res;
}


// --- FUNGSI KREDENSIAL VOUCHER / AKUN DIGITAL (AUTO-DELIVERY) ---

export async function addProductItems(kode, itemsArray) {
  const code = kode.toUpperCase();
  if (!Array.isArray(itemsArray) || itemsArray.length === 0 || itemsArray.length > 1000 || itemsArray.some(item => typeof item !== 'string' || item.trim().length === 0 || item.length > 5000)) {
    throw new Error('Daftar kredensial tidak valid.');
  }
  for (const item of itemsArray) {
    if (item.trim()) {
      await runQuery(
        "INSERT INTO product_items (produk_kode, data_content, status) VALUES (?, ?, 'READY')",
        [code, item.trim()]
      );
    }
  }
  // Update stok otomatis pada produk utama
  const readyCount = await getAvailableItemsCount(code);
  await runQuery("UPDATE products SET stok = ? WHERE kode = ?", [readyCount, code]);
  await addLog("SYSTEM", `Berhasil mengimpor ${itemsArray.length} kredensial digital untuk produk ${code}. Stok terupdate: ${readyCount} pcs.`);
  return readyCount;
}

export async function getAvailableItemsCount(kode) {
  const res = await getQuery(
    "SELECT COUNT(*) as count FROM product_items WHERE produk_kode = ? AND status = 'READY'",
    [kode.toUpperCase()]
  );
  return res.count || 0;
}

export async function getProductItems(kode) {
  return await allQuery(
    "SELECT * FROM product_items WHERE produk_kode = ? ORDER BY status ASC, id DESC",
    [kode.toUpperCase()]
  );
}

export async function deleteProductItem(id) {
  const item = await getQuery("SELECT produk_kode FROM product_items WHERE id = ?", [id]);
  const res = await runQuery("DELETE FROM product_items WHERE id = ?", [id]);
  
  if (item) {
    // Sinkronisasi stok produk
    const readyCount = await getAvailableItemsCount(item.produk_kode);
    await runQuery("UPDATE products SET stok = ? WHERE kode = ?", [readyCount, item.produk_kode]);
  }
  return res;
}

// Fungsi utama untuk mengklaim voucher digital saat order dibayar (settlement)
export async function claimAndDeliverItems(orderId) {
  return withTransaction(async () => {
    // Ambil rincian produk bertipe otomatis yang dibeli dalam order ini
    const itemsPurchased = await allQuery(`
      SELECT oi.produk_kode, oi.qty, p.delivery_type, p.nama as produk_nama, p.petunjuk, p.duration, p.variant_type 
      FROM order_items oi 
      JOIN products p ON oi.produk_kode = p.kode 
      WHERE oi.order_id = ?
    `, [orderId]);

    const deliveredData = {};
    let itemsText = '';
    let manualCount = 0;
    let maxWarrantyMs = 0;

    for (const item of itemsPurchased) {
      // Hitung masa garansi dari durasi
      const durStr = (item.duration || '').toLowerCase();
      let itemWarrantyMs = 30 * 24 * 60 * 60 * 1000; // default 30 hari
      if (durStr.includes('7')) itemWarrantyMs = 7 * 24 * 60 * 60 * 1000;
      else if (durStr.includes('14')) itemWarrantyMs = 14 * 24 * 60 * 60 * 1000;
      else if (durStr.includes('60') || durStr.includes('2 bulan')) itemWarrantyMs = 60 * 24 * 60 * 60 * 1000;
      else if (durStr.includes('90') || durStr.includes('3 bulan')) itemWarrantyMs = 90 * 24 * 60 * 60 * 1000;
      else if (durStr.includes('tahun') || durStr.includes('12 bulan')) itemWarrantyMs = 365 * 24 * 60 * 60 * 1000;
      if (itemWarrantyMs > maxWarrantyMs) maxWarrantyMs = itemWarrantyMs;

      if (item.delivery_type === 'AUTO') {
        // Ambil kredensial siap pakai secara idempoten
        // 1. Ambil item yang SUDAH pernah di-claim untuk order ini (idempotent recovery saat retry)
        let readyItems = await allQuery(
          "SELECT id, data_content FROM product_items WHERE produk_kode = ? AND order_id = ? AND status = 'USED'",
          [item.produk_kode, orderId]
        );
        // 2. Jika belum mencukupi, ambil dari status RESERVED untuk order ini
        if (readyItems.length < item.qty) {
          const reservedItems = await allQuery(
            "SELECT id, data_content FROM product_items WHERE produk_kode = ? AND status = 'RESERVED' AND order_id = ? LIMIT ?",
            [item.produk_kode, orderId, item.qty - readyItems.length]
          );
          readyItems = readyItems.concat(reservedItems);
        }
        // 3. Fallback jika masih kurang, ambil dari status READY
        if (readyItems.length < item.qty) {
          const fallbackItems = await allQuery(
            "SELECT id, data_content FROM product_items WHERE produk_kode = ? AND status = 'READY' LIMIT ?",
            [item.produk_kode, item.qty - readyItems.length]
          );
          readyItems = readyItems.concat(fallbackItems);
        }

        const creds = readyItems.map(ri => ri.data_content);
        deliveredData[item.produk_kode] = {
          produk_nama: item.produk_nama,
          petunjuk: item.petunjuk || '',
          duration: item.duration || '',
          variant_type: item.variant_type || '',
          credentials: creds
        };

        itemsText += `📦 *${item.produk_nama.toUpperCase()}* (Qty: ${item.qty})\n`;
        if (item.duration) itemsText += `⏱️ *Masa Aktif:* ${item.duration}\n`;
        itemsText += `🔑 *Kredensial / Voucher Akun:*\n`;
        creds.forEach((c, idx) => {
          itemsText += `   [${idx + 1}] \`\`\`${c}\`\`\`\n`;
        });
        if (item.petunjuk && item.petunjuk.trim()) {
          itemsText += `\n📖 *Panduan Penggunaan:*\n${item.petunjuk.trim()}\n`;
        }
        itemsText += `\n`;

        // Tandai kredensial sebagai USED
        for (const ri of readyItems) {
          await runQuery(
            "UPDATE product_items SET status = 'USED', order_id = ?, used_at = datetime('now') WHERE id = ?",
            [orderId, ri.id]
          );
        }

        // Sinkronisasi sisa stok produk utama
        const sisaStok = await getAvailableItemsCount(item.produk_kode);
        await runQuery("UPDATE products SET stok = ? WHERE kode = ?", [sisaStok, item.produk_kode]);
      } else {
        manualCount++;
        itemsText += `📦 *${item.produk_nama.toUpperCase()}* (Qty: ${item.qty})\n`;
        itemsText += `👨‍💼 _Produk bertipe MANUAL — Tim Admin Toko akan segera mengirimkan akun/kredensial ke chat ini._\n\n`;
      }
    }

    // Update tanggal masa garansi pada pesanan
    const warrantyUntil = Date.now() + (maxWarrantyMs > 0 ? maxWarrantyMs : 30 * 24 * 60 * 60 * 1000);
    await runQuery(`UPDATE orders SET warranty_until = ? WHERE order_id = ?`, [warrantyUntil, orderId]);

    return {
      success: true,
      deliveredData,
      itemsText: itemsText.trim(),
      manualItems: manualCount > 0,
      warrantyUntil
    };
  });
}


// --- FUNGSI PESANAN & SCHEDULER HELPER ---

export async function getActiveCart(customerNomor) {
  let cart = await getQuery("SELECT * FROM orders WHERE customer_nomor = ? AND status = 'CART'", [customerNomor]);
  if (!cart) {
    const orderId = generateOrderId();
    await runQuery("INSERT INTO orders (order_id, customer_nomor, total, status) VALUES (?, ?, 0, 'CART')", [orderId, customerNomor]);
    cart = await getQuery("SELECT * FROM orders WHERE order_id = ?", [orderId]);
  }
  return cart;
}

export async function addToCart(customerNomor, productKode, qty) {
  if (!Number.isInteger(qty) || qty <= 0) {
    return { success: false, message: "Jumlah produk harus berupa bilangan bulat minimal 1." };
  }
  const product = await getProductByKode(productKode);
  if (!product) {
    return { success: false, message: `Produk dengan kode *${productKode}* tidak ditemukan.` };
  }

  // Jika produk bertipe AUTO, validasi stok berdasarkan product_items READY
  let availableStock = product.stok;
  if (product.delivery_type === 'AUTO') {
    availableStock = await getAvailableItemsCount(productKode);
  }

  if (availableStock < qty) {
    return { success: false, message: `Stok tidak mencukupi. Sisa stok *${product.nama}* saat ini: ${availableStock}` };
  }

  const cart = await getActiveCart(customerNomor);
  const orderId = cart.order_id;

  let activePrice = product.harga;
  const activeFlashSale = await getActiveFlashSale(product.kode);
  if (activeFlashSale) {
    activePrice = activeFlashSale.harga_flash;
  }

  const existingItem = await getQuery(
    "SELECT * FROM order_items WHERE order_id = ? AND produk_kode = ?",
    [orderId, product.kode]
  );

  if (existingItem) {
    const newQty = existingItem.qty + qty;
    if (availableStock < newQty) {
      return { success: false, message: `Gagal menambahkan. Jumlah di keranjang (${newQty}) melebihi stok (${availableStock}).` };
    }
    const newSubtotal = newQty * activePrice;
    await runQuery(
      "UPDATE order_items SET qty = ?, subtotal = ?, harga = ? WHERE id = ?",
      [newQty, newSubtotal, activePrice, existingItem.id]
    );
  } else {
    const subtotal = qty * activePrice;
    await runQuery(
      "INSERT INTO order_items (order_id, produk_kode, qty, harga, subtotal) VALUES (?, ?, ?, ?, ?)",
      [orderId, product.kode, qty, activePrice, subtotal]
    );
  }

  await updateOrderTotal(orderId);
  return {
    success: true,
    productName: product.nama,
    qty: qty,
    subtotal: qty * activePrice,
    isFlashSale: !!activeFlashSale
  };
}

export async function getCartDetails(customerNomor) {
  const cart = await getQuery("SELECT * FROM orders WHERE customer_nomor = ? AND status = 'CART'", [customerNomor]);
  if (!cart) {
    return { order_id: null, items: [], total: 0 };
  }

  const items = await allQuery(`
    SELECT oi.*, p.nama as produk_nama 
    FROM order_items oi 
    JOIN products p ON oi.produk_kode = p.kode 
    WHERE oi.order_id = ?
  `, [cart.order_id]);

  return {
    order_id: cart.order_id,
    items,
    total: cart.total
  };
}

async function updateOrderTotal(orderId) {
  const result = await getQuery("SELECT SUM(subtotal) as total FROM order_items WHERE order_id = ?", [orderId]);
  const rawTotal = result.total || 0;
  
  const order = await getQuery("SELECT discount_amount FROM orders WHERE order_id = ?", [orderId]);
  const discount = order ? (order.discount_amount || 0) : 0;
  
  const finalTotal = Math.max(0, rawTotal - discount);
  await runQuery("UPDATE orders SET total = ? WHERE order_id = ?", [finalTotal, orderId]);
}

export async function checkoutCart(customerNomor) {
  return withTransaction(async () => {
  const cart = await getQuery("SELECT * FROM orders WHERE customer_nomor = ? AND status = 'CART'", [customerNomor]);
  if (!cart) {
    return { success: false, message: "Anda tidak memiliki keranjang belanja aktif." };
  }

  const items = await allQuery("SELECT * FROM order_items WHERE order_id = ?", [cart.order_id]);
  if (items.length === 0) {
    return { success: false, message: "Keranjang belanja Anda masih kosong." };
  }

  const reservedManual = [];
  try {
    for (const item of items) {
      const product = await getProductByKode(item.produk_kode);
      if (!product) {
        throw new Error(`Produk ${item.produk_kode} tidak ditemukan.`);
      }

      if (product.delivery_type === 'AUTO') {
        const reserveResult = await runQuery(
          "UPDATE product_items SET status = 'RESERVED', order_id = ? WHERE id IN (SELECT id FROM product_items WHERE produk_kode = ? AND status = 'READY' LIMIT ?)",
          [cart.order_id, item.produk_kode, item.qty]
        );
        if (reserveResult.changes !== item.qty) {
          throw new Error(`Stok *${product.nama}* tidak mencukupi (Tersisa: ${await getAvailableItemsCount(item.produk_kode)}).`);
        }
      } else {
        const reserveResult = await runQuery(
          "UPDATE products SET stok = stok - ? WHERE kode = ? AND stok >= ?",
          [item.qty, item.produk_kode, item.qty]
        );
        if (reserveResult.changes !== 1) {
          throw new Error(`Stok *${product.nama}* tidak mencukupi (Tersisa: ${product.stok}).`);
        }
        await runQuery("UPDATE order_items SET stock_reserved = 1 WHERE order_id = ? AND produk_kode = ?", [cart.order_id, item.produk_kode]);
        reservedManual.push({ produkKode: item.produk_kode, qty: item.qty });
      }
    }
  } catch (err) {
    for (const item of reservedManual) {
      await runQuery("UPDATE products SET stok = stok + ? WHERE kode = ?", [item.qty, item.produkKode]);
    }
    await runQuery("UPDATE product_items SET status = 'READY', order_id = NULL WHERE order_id = ? AND status = 'RESERVED'", [cart.order_id]);
    return { success: false, message: `Checkout gagal. ${err.message}` };
  }

  await runQuery(
    "UPDATE orders SET status = 'WAITING_PAYMENT' WHERE order_id = ?",
    [cart.order_id]
  );

  await addLog("ORDER", `Order dibuat: ${cart.order_id} oleh customer ${customerNomor}`);
  const orderDetails = await getOrderDetails(cart.order_id);
  return {
    success: true,
    order: orderDetails
  };
  });
}

export async function updateOrderPaymentLink(orderId, paymentLink, midtransStatus = "pending") {
  return await runQuery(
    "UPDATE orders SET payment_link = ?, midtrans_status = ? WHERE order_id = ?",
    [paymentLink, midtransStatus, orderId]
  );
}

export async function createDepositOrder(orderId, customerNomor, total) {
  return await runQuery(
    "INSERT OR IGNORE INTO orders (order_id, customer_nomor, total, status) VALUES (?, ?, ?, 'WAITING_PAYMENT')",
    [orderId, customerNomor, total]
  );
}

export async function settleDepositOrder(orderId, customerNomor, total, midtransStatus = 'settlement') {
  return withTransaction(async () => {
    const result = await runQuery(
      "UPDATE orders SET status = 'COMPLETED', midtrans_status = ? WHERE order_id = ? AND customer_nomor = ? AND total = ? AND status = 'WAITING_PAYMENT'",
      [midtransStatus, orderId, customerNomor, total]
    );
    if (result.changes === 1) {
      await addCustomerBalance(customerNomor, total);
    }
    return result.changes === 1;
  });
}

export async function cancelActiveOrder(customerNomor) {
  const activeOrder = await getQuery(
    "SELECT * FROM orders WHERE customer_nomor = ? AND status IN ('CART', 'WAITING_PAYMENT')",
    [customerNomor]
  );

  if (!activeOrder) {
    return { success: false, message: "Tidak ada pesanan aktif yang bisa dibatalkan." };
  }

  // (Pengembalian stok produk sekarang ditangani secara otomatis di updateOrderStatus jika status pesanan dibatalkan)

  await updateOrderStatus(activeOrder.order_id, 'CANCELLED');
  await addLog("ORDER", `Order dibatalkan: ${activeOrder.order_id} oleh customer`);
  return { success: true, orderId: activeOrder.order_id, prevStatus: activeOrder.status };
}

export async function getOrderDetails(orderId) {
  const order = await getQuery(`
    SELECT o.*, c.nama as customer_nama 
    FROM orders o 
    JOIN customers c ON o.customer_nomor = c.nomor 
    WHERE o.order_id = ?
  `, [orderId]);

  if (!order) return null;

  const items = await allQuery(`
    SELECT oi.*, p.nama as produk_nama, p.delivery_type 
    FROM order_items oi 
    JOIN products p ON oi.produk_kode = p.kode 
    WHERE oi.order_id = ?
  `, [orderId]);

  return {
    ...order,
    items
  };
}

export async function getCustomerLastOrder(customerNomor) {
  return await getQuery(
    "SELECT * FROM orders WHERE customer_nomor = ? ORDER BY created_at DESC LIMIT 1",
    [customerNomor]
  );
}

export async function getAllOrders() {
  const orders = await allQuery(`
    SELECT o.*, c.nama as customer_nama 
    FROM orders o 
    JOIN customers c ON o.customer_nomor = c.nomor 
    ORDER BY o.created_at DESC
  `);
  
  const result = [];
  for (const order of orders) {
    const items = await allQuery(`
      SELECT oi.*, p.nama as produk_nama, p.delivery_type 
      FROM order_items oi 
      JOIN products p ON oi.produk_kode = p.kode 
      WHERE oi.order_id = ?
    `, [order.order_id]);
    result.push({
      ...order,
      items
    });
  }
  return result;
}

export async function updateOrderStatus(orderId, status, paymentStatus = null) {
  return withTransaction(async () => {
  const order = await getQuery("SELECT * FROM orders WHERE order_id = ?", [orderId]);
  if (!order) return { success: false, message: "Order ID tidak ditemukan." };

  const oldStatus = order.status;
  const newStatus = status;
  const isPaidStatus = (s) => s === 'PAID' || s === 'COMPLETED';

  if (!['CART', 'WAITING_PAYMENT', 'WAITING_CONFIRMATION', 'PAID', 'COMPLETED', 'CANCELLED'].includes(newStatus)) {
    return { success: false, message: "Status order tidak valid." };
  }

  if (!isPaidStatus(oldStatus) && isPaidStatus(newStatus) && order.coupon_code && !order.coupon_redeemed) {
    const couponResult = await runQuery(
      "UPDATE coupons SET used_count = used_count + 1 WHERE code = ? AND (max_uses = 0 OR used_count < max_uses)",
      [order.coupon_code]
    );
    if (couponResult.changes !== 1) {
      return { success: false, message: "Kupon pada order ini sudah tidak tersedia." };
    }
    await runQuery("UPDATE orders SET coupon_redeemed = 1 WHERE order_id = ?", [orderId]);
  }

  // Jika berubah dari BELUM BAYAR ke SUDAH BAYAR, kurangi stok produk MANUAL & Tambah Poin Loyalitas
  if (!isPaidStatus(oldStatus) && isPaidStatus(newStatus)) {
    const items = await allQuery("SELECT * FROM order_items WHERE order_id = ?", [orderId]);
    for (const item of items) {
      const product = await getProductByKode(item.produk_kode);
      if (product && product.delivery_type === 'MANUAL' && !item.stock_reserved) {
        await runQuery(
          "UPDATE products SET stok = stok - ? WHERE kode = ?",
          [item.qty, item.produk_kode]
        );
        await runQuery("UPDATE order_items SET stock_reserved = 1 WHERE id = ?", [item.id]);
      }
    }
    
    // Tambah Poin Loyalitas
    if (order.total > 0) {
      await addLoyaltyPoints(order.customer_nomor, order.total);
    }
  }

  // Jika berubah dari SUDAH BAYAR ke BATAL/BELUM BAYAR, kembalikan stok produk MANUAL
  if (oldStatus !== newStatus && !isPaidStatus(newStatus)) {
    const items = await allQuery("SELECT * FROM order_items WHERE order_id = ?", [orderId]);
    for (const item of items) {
      const product = await getProductByKode(item.produk_kode);
      if (product && product.delivery_type === 'MANUAL' && item.stock_reserved) {
        await runQuery(
          "UPDATE products SET stok = stok + ? WHERE kode = ?",
          [item.qty, item.produk_kode]
        );
      }
    }
    await runQuery("UPDATE order_items SET stock_reserved = 0 WHERE order_id = ?", [orderId]);
    await runQuery("UPDATE product_items SET status = 'READY', order_id = NULL, used_at = NULL WHERE order_id = ? AND status = 'RESERVED'", [orderId]);
  }

  await runQuery("UPDATE orders SET status = ?, midtrans_status = COALESCE(?, midtrans_status) WHERE order_id = ?", [status, paymentStatus, orderId]);
  await addLog("ORDER", `Status Order ${orderId} diubah dari ${order.status} ke ${status}`);
  return { success: true, customerNomor: order.customer_nomor };
  });
}

// Menghapus 1 order dan rincian belanjaannya dari database
export async function deleteOrder(orderId) {
  const order = await getQuery("SELECT * FROM orders WHERE order_id = ?", [orderId]);
  if (!order) return { success: false, message: "Order ID tidak ditemukan." };

  if (['WAITING_PAYMENT', 'WAITING_CONFIRMATION'].includes(order.status)) {
    await updateOrderStatus(orderId, 'CANCELLED');
  }
  await runQuery("DELETE FROM order_items WHERE order_id = ?", [orderId]);
  await runQuery("DELETE FROM orders WHERE order_id = ?", [orderId]);
  await addLog("ORDER", `Order ID ${orderId} berhasil dihapus dari database.`);
  return { success: true, message: `Order ${orderId} berhasil dihapus.` };
}

// Membersihkan riwayat order secara massal (berdasarkan filter: CANCELLED_CART, COMPLETED, atau ALL)
export async function clearOrders(filter = 'ALL') {
  let queryOrders = "";
  let params = [];

  if (filter === 'CANCELLED_CART') {
    queryOrders = "SELECT order_id FROM orders WHERE status IN ('CANCELLED', 'CART', 'WAITING_PAYMENT')";
  } else if (filter === 'COMPLETED') {
    queryOrders = "SELECT order_id FROM orders WHERE status = 'COMPLETED'";
  } else {
    queryOrders = "SELECT order_id FROM orders";
  }

  const targetOrders = await allQuery(queryOrders, params);
  const ids = targetOrders.map(o => o.order_id);

  if (ids.length === 0) {
    return { success: true, count: 0, message: "Tidak ada transaksi yang memenuhi kriteria pembersihan." };
  }

  for (const id of ids) {
    const order = await getQuery("SELECT status FROM orders WHERE order_id = ?", [id]);
    if (order && ['WAITING_PAYMENT', 'WAITING_CONFIRMATION'].includes(order.status)) {
      await updateOrderStatus(id, 'CANCELLED');
    }
    await runQuery("DELETE FROM order_items WHERE order_id = ?", [id]);
    await runQuery("DELETE FROM orders WHERE order_id = ?", [id]);
  }

  await addLog("ORDER", `Pembersihan riwayat order (${filter}): ${ids.length} transaksi dihapus.`);
  return { success: true, count: ids.length, message: `Berhasil menghapus ${ids.length} transaksi.` };
}


// --- AUTOMATION SCHEDULER QUERIES ---

// Mengambil order yang menunggu pembayaran selama lebih dari 30 menit (belum diingatkan)
export async function getPendingReminders() {
  return await allQuery(`
    SELECT o.*, c.nama as customer_nama 
    FROM orders o 
    JOIN customers c ON o.customer_nomor = c.nomor 
    WHERE o.status = 'WAITING_PAYMENT' 
      AND o.reminder_sent = 0 
      AND o.created_at <= datetime('now', '-30 minutes')
  `);
}

export async function setReminderSent(orderId) {
  return await runQuery("UPDATE orders SET reminder_sent = 1 WHERE order_id = ?", [orderId]);
}

// Mengambil order yang menunggu pembayaran selama lebih dari 24 jam (untuk dibatalkan otomatis)
export async function getExpiredOrders() {
  return await allQuery(`
    SELECT o.*, c.nama as customer_nama 
    FROM orders o 
    JOIN customers c ON o.customer_nomor = c.nomor 
    WHERE o.status = 'WAITING_PAYMENT' 
      AND o.created_at <= datetime('now', '-24 hours')
  `);
}


// --- FUNGSI KUPON & DISKON ---
export async function addCoupon(code, type, value, minOrder = 0, maxUses = 0, expiresAt = null) {
  const normalizedCode = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,40}$/.test(normalizedCode)) {
    throw new Error('Kode kupon tidak valid.');
  }
  if (!['percent', 'fixed'].includes(type)) {
    throw new Error('Tipe kupon tidak valid.');
  }
  if (!Number.isInteger(value) || value <= 0 || (type === 'percent' && value > 100)) {
    throw new Error('Nilai kupon tidak valid.');
  }
  if (!Number.isInteger(minOrder) || minOrder < 0 || !Number.isInteger(maxUses) || maxUses < 0) {
    throw new Error('Batas kupon tidak valid.');
  }
  await runQuery(
    "INSERT INTO coupons (code, type, value, min_order, max_uses, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    [normalizedCode, type, value, minOrder, maxUses, expiresAt]
  );
  await addLog("SYSTEM", `Kupon baru ditambahkan: ${normalizedCode} (${type} ${value})`);
}

export async function deleteCoupon(code) {
  const res = await runQuery("DELETE FROM coupons WHERE code = ?", [code.toUpperCase()]);
  return res.changes > 0;
}

export async function getCoupon(code) {
  return await getQuery("SELECT * FROM coupons WHERE code = ? AND is_active = 1", [code.toUpperCase()]);
}

export async function getAllCoupons() {
  return await allQuery("SELECT * FROM coupons ORDER BY created_at DESC");
}

export async function incrementCouponUsage(code) {
  await runQuery("UPDATE coupons SET used_count = used_count + 1 WHERE code = ?", [code.toUpperCase()]);
}

export async function applyCouponToOrder(orderId, couponCode, discountAmount) {
  await runQuery("UPDATE orders SET coupon_code = ?, discount_amount = ? WHERE order_id = ?", [couponCode, discountAmount, orderId]);
  await updateOrderTotal(orderId);
}


// --- FUNGSI REVIEW & RATING ---
export async function addReview(orderId, customerNomor, rating, comment) {
  await runQuery(
    "INSERT OR REPLACE INTO reviews (order_id, customer_nomor, rating, comment) VALUES (?, ?, ?, ?)",
    [orderId, customerNomor, rating, comment || '']
  );
  await addLog("REVIEW", `Review diterima untuk Order ${orderId}: ${rating} bintang`);
}

export async function getReviewByOrder(orderId) {
  return await getQuery("SELECT * FROM reviews WHERE order_id = ?", [orderId]);
}

export async function getProductReviews(produkKode) {
  return await allQuery(
    `SELECT r.*, oi.produk_kode FROM reviews r 
     JOIN order_items oi ON r.order_id = oi.order_id 
     WHERE oi.produk_kode = ? ORDER BY r.created_at DESC LIMIT 10`,
    [produkKode.toUpperCase()]
  );
}

export async function getAverageRating(produkKode) {
  const row = await getQuery(
    `SELECT AVG(r.rating) as avg_rating, COUNT(r.id) as total_reviews FROM reviews r 
     JOIN order_items oi ON r.order_id = oi.order_id 
     WHERE oi.produk_kode = ?`,
    [produkKode.toUpperCase()]
  );
  return row || { avg_rating: 0, total_reviews: 0 };
}

export async function getOrdersNeedingReviewReminder() {
  return await allQuery(
    `SELECT o.order_id, o.customer_nomor, c.nama as customer_nama 
     FROM orders o 
     JOIN customers c ON o.customer_nomor = c.nomor
     LEFT JOIN reviews r ON o.order_id = r.order_id
     WHERE o.status = 'COMPLETED' 
     AND o.review_reminder_sent = 0 
     AND r.id IS NULL
     AND o.created_at <= datetime('now', '-24 hours')`
  );
}

export async function markReviewReminderSent(orderId) {
  await runQuery("UPDATE orders SET review_reminder_sent = 1 WHERE order_id = ?", [orderId]);
}


// --- FUNGSI BUNDLING PRODUK ---
export async function addBundle(nama, produkList, hargaBundle) {
  const res = await runQuery(
    "INSERT INTO bundles (nama, produk_list, harga_bundle) VALUES (?, ?, ?)",
    [nama, JSON.stringify(produkList), hargaBundle]
  );
  await addLog("SYSTEM", `Bundle baru ditambahkan: ${nama}`);
  return res.lastID;
}

export async function deleteBundle(id) {
  const res = await runQuery("DELETE FROM bundles WHERE id = ?", [id]);
  return res.changes > 0;
}

export async function getActiveBundles() {
  const rows = await allQuery("SELECT * FROM bundles WHERE is_active = 1 ORDER BY id ASC");
  return rows.map(r => ({ ...r, produk_list: JSON.parse(r.produk_list) }));
}

export async function getBundleById(id) {
  const row = await getQuery("SELECT * FROM bundles WHERE id = ? AND is_active = 1", [id]);
  if (row) row.produk_list = JSON.parse(row.produk_list);
  return row;
}


// --- FUNGSI WISHLIST ---
export async function addToWishlist(customerNomor, produkKode) {
  try {
    await runQuery(
      "INSERT OR IGNORE INTO wishlist (customer_nomor, produk_kode) VALUES (?, ?)",
      [customerNomor, produkKode.toUpperCase()]
    );
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

export async function removeFromWishlist(customerNomor, produkKode) {
  const res = await runQuery(
    "DELETE FROM wishlist WHERE customer_nomor = ? AND produk_kode = ?",
    [customerNomor, produkKode.toUpperCase()]
  );
  return res.changes > 0;
}

export async function getWishlist(customerNomor) {
  return await allQuery(
    `SELECT w.*, p.nama, p.harga, p.stok FROM wishlist w 
     JOIN products p ON w.produk_kode = p.kode 
     WHERE w.customer_nomor = ? ORDER BY w.created_at DESC`,
    [customerNomor]
  );
}


// --- FUNGSI RIWAYAT PESANAN ---
export async function getCustomerOrderHistory(customerNomor, limit = 5) {
  return await allQuery(
    `SELECT o.order_id, o.total, o.status, o.discount_amount, o.coupon_code, o.created_at,
     GROUP_CONCAT(oi.produk_kode || ' x' || oi.qty, ', ') as items_summary
     FROM orders o
     LEFT JOIN order_items oi ON o.order_id = oi.order_id
     WHERE o.customer_nomor = ?
     GROUP BY o.order_id
     ORDER BY o.created_at DESC LIMIT ?`,
    [customerNomor, limit]
  );
}


// --- FUNGSI PENCARIAN PRODUK ---
export async function searchProducts(keyword) {
  return await allQuery(
    "SELECT * FROM products WHERE nama LIKE ? OR deskripsi LIKE ? OR kode LIKE ?",
    [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`]
  );
}


// --- FUNGSI LAPORAN PENJUALAN ---
export async function getDailySalesReport(dateStr) {
  const orders = await allQuery(
    `SELECT COUNT(*) as total_orders, COALESCE(SUM(total), 0) as total_revenue 
     FROM orders WHERE status = 'COMPLETED' AND DATE(created_at, '+7 hours') = ?`, [dateStr]
  );
  const topProducts = await allQuery(
    `SELECT oi.produk_kode, p.nama, SUM(oi.qty) as total_qty, SUM(oi.subtotal) as total_sales
     FROM order_items oi
     JOIN orders o ON oi.order_id = o.order_id
     JOIN products p ON oi.produk_kode = p.kode
     WHERE o.status = 'COMPLETED' AND DATE(o.created_at, '+7 hours') = ?
     GROUP BY oi.produk_kode ORDER BY total_qty DESC LIMIT 5`, [dateStr]
  );
  const lowStockProducts = await allQuery(
    "SELECT kode, nama, stok FROM products WHERE stok <= 3 AND stok > 0 ORDER BY stok ASC"
  );
  const outOfStockProducts = await allQuery(
    "SELECT kode, nama FROM products WHERE stok = 0"
  );
  return { ...orders[0], topProducts, lowStockProducts, outOfStockProducts };
}


// --- FUNGSI FLASH SALE ---
export async function setFlashSale(produkKode, hargaFlash, durationHours = 2) {
  const endTime = new Date(Date.now() + durationHours * 3600000).toISOString();
  await runQuery(
    "INSERT OR REPLACE INTO flash_sales (produk_kode, harga_flash, end_time) VALUES (?, ?, ?)",
    [produkKode.toUpperCase(), hargaFlash, endTime]
  );
  return endTime;
}

export async function getActiveFlashSale(produkKode) {
  const now = new Date().toISOString();
  return await getQuery(
    "SELECT * FROM flash_sales WHERE produk_kode = ? AND end_time > ?",
    [produkKode.toUpperCase(), now]
  );
}

export async function getAllActiveFlashSales() {
  const now = new Date().toISOString();
  return await allQuery(
    `SELECT fs.*, p.nama, p.harga as harga_asli, p.stok FROM flash_sales fs
     JOIN products p ON fs.produk_kode = p.kode
     WHERE fs.end_time > ? ORDER BY fs.end_time ASC`,
    [now]
  );
}

export async function endFlashSale(produkKode) {
  const res = await runQuery("DELETE FROM flash_sales WHERE produk_kode = ?", [produkKode.toUpperCase()]);
  return res.changes > 0;
}

export async function getAbandonedCarts(hoursThreshold = 2) {
  return await allQuery(
    `SELECT o.order_id, o.customer_nomor, o.total, c.nama as customer_nama,
     GROUP_CONCAT(p.nama || ' (x' || oi.qty || ')', ', ') as items_summary
     FROM orders o
     JOIN customers c ON o.customer_nomor = c.nomor
     JOIN order_items oi ON o.order_id = oi.order_id
     JOIN products p ON oi.produk_kode = p.kode
     WHERE o.status = 'CART' 
     AND o.created_at <= datetime('now', '-' || ? || ' hours')
     AND o.reminder_sent = 0
     GROUP BY o.order_id`,
    [hoursThreshold]
  );
}

export async function markCartReminderSent(orderId) {
  await runQuery("UPDATE orders SET reminder_sent = 1 WHERE order_id = ?", [orderId]);
}


// --- FUNGSI ALIAS & KOMPATIBILITAS ---

/**
 * Alias untuk getOrderDetails — dipanggil dari bot.js (.invoice & .review)
 */
export async function getOrderById(orderId) {
  return await getOrderDetails(orderId);
}

/**
 * Ambil data customer by nomor (tanpa create). Alias dari getOrCreateCustomer
 * tapi hanya READ — tidak membuat record baru jika tidak ada.
 */
export async function getCustomer(nomor) {
  if (!nomor) return null;
  const fullClean = String(nomor).replace(/:[0-9]+@/, '@').trim();
  return await getQuery("SELECT * FROM customers WHERE nomor = ? OR nomor = ?", [nomor, fullClean]);
}

/**
 * Cari data customer berdasarkan nomor JID atau digit telepon
 */
export async function getCustomerByPhone(nomor) {
  if (!nomor) return null;
  const fullClean = String(nomor).replace(/:[0-9]+@/, '@').trim();
  const digits = normalizePhoneDigits(nomor);

  let row = await getQuery("SELECT * FROM customers WHERE nomor = ? OR nomor = ?", [nomor, fullClean]);
  if (row) return row;

  if (digits && digits.length >= 7) {
    const allCust = await allQuery("SELECT * FROM customers");
    for (const c of allCust) {
      if (isPhoneMatch(c.nomor, digits)) return c;
    }
  }
  return null;
}
