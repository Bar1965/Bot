import sqlite3 from 'sqlite3';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

const sqlite = sqlite3.verbose();
const dbFile = './shop.db';

let db;

// Membungkus method-method database dalam Promise agar bisa menggunakan async/await
export function openDb() {
  return new Promise((resolve, reject) => {
    db = new sqlite.Database(dbFile, (err) => {
      if (err) {
        console.error('Gagal membuka database:', err.message);
        reject(err);
      } else {
        console.log('Terhubung ke database SQLite.');
        resolve();
      }
    });
  });
}

export function runQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

export function getQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

export function allQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Inisialisasi skema tabel database
export async function initDb() {
  await openDb();

  // 1. Tabel Settings (Dinamis)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // 2. Tabel Users (CS, Admin, Owner)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL
    )
  `);

  // 3. Tabel Subscriptions (Notifikasi Stok Pelanggan)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_nomor TEXT NOT NULL,
      produk_kode TEXT NOT NULL,
      UNIQUE(customer_nomor, produk_kode)
    )
  `);

  // 4. Tabel Produk (ditambahkan kolom gambar, delivery_type)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS products (
      kode TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      harga INTEGER NOT NULL,
      stok INTEGER NOT NULL,
      deskripsi TEXT,
      gambar TEXT,
      delivery_type TEXT DEFAULT 'MANUAL'
    )
  `);

  // Jalankan migrasi kolom gambar
  try {
    await runQuery("ALTER TABLE products ADD COLUMN gambar TEXT");
  } catch (e) {
    // Abaikan jika kolom sudah ada
  }

  // Jalankan migrasi kolom delivery_type
  try {
    await runQuery("ALTER TABLE products ADD COLUMN delivery_type TEXT DEFAULT 'MANUAL'");
  } catch (e) {
    // Abaikan jika kolom sudah ada
  }

  // 5. Tabel product_items (Kredensial Stok Digital Siap Kirim)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS product_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produk_kode TEXT NOT NULL,
      data_content TEXT NOT NULL,
      status TEXT DEFAULT 'READY',
      order_id TEXT,
      used_at DATETIME,
      FOREIGN KEY(produk_kode) REFERENCES products(kode)
    )
  `);

  // 6. Tabel Customer
  await runQuery(`
    CREATE TABLE IF NOT EXISTS customers (
      nomor TEXT PRIMARY KEY,
      nama TEXT
    )
  `);

  // 7. Tabel Orders (ditambahkan kolom reminder_sent, payment_link, midtrans_status)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      customer_nomor TEXT NOT NULL,
      total INTEGER DEFAULT 0,
      status TEXT NOT NULL,
      reminder_sent INTEGER DEFAULT 0,
      payment_link TEXT,
      midtrans_status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(customer_nomor) REFERENCES customers(nomor)
    )
  `);

  // Jalankan migrasi kolom reminder_sent
  try {
    await runQuery("ALTER TABLE orders ADD COLUMN reminder_sent INTEGER DEFAULT 0");
  } catch (e) {
    // Abaikan jika kolom sudah ada
  }

  // Jalankan migrasi kolom payment_link
  try {
    await runQuery("ALTER TABLE orders ADD COLUMN payment_link TEXT");
  } catch (e) {
    // Abaikan jika kolom sudah ada
  }

  // Jalankan migrasi kolom midtrans_status
  try {
    await runQuery("ALTER TABLE orders ADD COLUMN midtrans_status TEXT");
  } catch (e) {
    // Abaikan jika kolom sudah ada
  }

  // 8. Tabel Order Items
  await runQuery(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      produk_kode TEXT NOT NULL,
      qty INTEGER NOT NULL,
      harga INTEGER NOT NULL,
      subtotal INTEGER NOT NULL,
      FOREIGN KEY(order_id) REFERENCES orders(order_id),
      FOREIGN KEY(produk_kode) REFERENCES products(kode)
    )
  `);

  // 9. Tabel Logs Aktivitas Sistem
  await runQuery(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Masukkan pengaturan default ke tabel settings jika kosong
  const settingsCount = await getQuery("SELECT COUNT(*) as count FROM settings");
  if (settingsCount.count === 0) {
    console.log("Mengisi pengaturan default ke database...");
    const defaultSettings = config.defaults;
    for (const [key, val] of Object.entries(defaultSettings)) {
      await runQuery("INSERT INTO settings (key, value) VALUES (?, ?)", [key, val.toString()]);
    }
  }

  // Masukkan pengguna default (Owner, Admin, CS) jika kosong
  const usersCount = await getQuery("SELECT COUNT(*) as count FROM users");
  if (usersCount.count === 0) {
    console.log("Mengisi pengguna default ke database...");
    const defaultUsers = [
      { username: 'owner', password: 'owner123', role: 'Owner' },
      { username: 'admin', password: 'admin123', role: 'Admin' },
      { username: 'cs', password: 'cs123', role: 'CS' }
    ];
    for (const u of defaultUsers) {
      const hash = bcrypt.hashSync(u.password, 10);
      await runQuery("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", [u.username, hash, u.role]);
    }
    console.log("Pengguna default berhasil dibuat (owner/owner123, admin/admin123, cs/cs123).");
  }

  // Masukkan data contoh jika tabel produk kosong
  const rowCount = await getQuery("SELECT COUNT(*) as count FROM products");
  if (rowCount.count === 0) {
    console.log("Database produk kosong. Memasukkan produk contoh...");
    const sampleProducts = [
      { kode: 'NET01', nama: 'Netflix Premium', harga: 45000, stok: 12, deskripsi: 'Premium 1 Bulan (Shared/Private)', gambar: '', delivery_type: 'MANUAL' },
      { kode: 'SP01', nama: 'Spotify Premium', harga: 20000, stok: 8, deskripsi: 'Premium 1 Bulan', gambar: '', delivery_type: 'MANUAL' },
      { kode: 'CV01', nama: 'Canva Pro', harga: 15000, stok: 2, deskripsi: 'Pro 1 Bulan Invite Link', gambar: '', delivery_type: 'MANUAL' },
      { kode: 'YT01', nama: 'YouTube Premium', harga: 25000, stok: 0, deskripsi: 'Premium 1 Bulan No Ads', gambar: '', delivery_type: 'MANUAL' }
    ];

    for (const p of sampleProducts) {
      await runQuery(
        "INSERT INTO products (kode, nama, harga, stok, deskripsi, gambar, delivery_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [p.kode, p.nama, p.harga, p.stok, p.deskripsi, p.gambar, p.delivery_type]
      );
    }
    console.log("Produk contoh berhasil dimasukkan.");
  }
}

// --- FUNGSI USERS / AKUN ---

export async function getUsers() {
  return await allQuery("SELECT username, role FROM users ORDER BY role DESC, username ASC");
}

export async function getUserByUsername(username) {
  return await getQuery("SELECT * FROM users WHERE username = ?", [username.toLowerCase()]);
}

export async function addUser(username, password, role) {
  const hash = bcrypt.hashSync(password, 10);
  const res = await runQuery(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    [username.toLowerCase(), hash, role]
  );
  await addLog("SYSTEM", `Akun pengguna baru ditambahkan: ${username.toLowerCase()} (${role})`);
  return res;
}

export async function updateUserPassword(username, newPassword) {
  const hash = bcrypt.hashSync(newPassword, 10);
  const res = await runQuery(
    "UPDATE users SET password_hash = ? WHERE username = ?",
    [hash, username.toLowerCase()]
  );
  await addLog("SYSTEM", `Password untuk akun pengguna ${username.toLowerCase()} berhasil diganti.`);
  return res;
}

export async function deleteUser(username) {
  const res = await runQuery("DELETE FROM users WHERE username = ?", [username.toLowerCase()]);
  await addLog("SYSTEM", `Akun pengguna ${username.toLowerCase()} dihapus.`);
  return res;
}

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

export async function getAndClearSubscribers(productKode) {
  const code = productKode.toUpperCase();
  // Ambil semua subscriber
  const rows = await allQuery("SELECT customer_nomor FROM subscriptions WHERE produk_kode = ?", [code]);
  // Hapus dari database
  await runQuery("DELETE FROM subscriptions WHERE produk_kode = ?", [code]);
  return rows.map(r => r.customer_nomor);
}

// --- FUNGSI LOGS ---

export async function addLog(type, message) {
  try {
    await runQuery("INSERT INTO logs (type, message) VALUES (?, ?)", [type.toUpperCase(), message]);
  } catch (err) {
    console.error("Gagal menambahkan log:", err.message);
  }
}

export async function getLogs(typeFilter = "") {
  if (typeFilter && typeFilter !== "ALL") {
    return await allQuery("SELECT * FROM logs WHERE type = ? ORDER BY timestamp DESC LIMIT 200", [typeFilter.toUpperCase()]);
  }
  return await allQuery("SELECT * FROM logs ORDER BY timestamp DESC LIMIT 200");
}

// --- FUNGSI SETTINGS ---

export async function getSettings() {
  const rows = await allQuery("SELECT * FROM settings");
  const settings = {};
  rows.forEach(r => {
    if (r.key === 'lowStockLimit' || r.key === 'broadcastDelay') {
      settings[r.key] = parseInt(r.value);
    } else {
      settings[r.key] = r.value;
    }
  });
  return settings;
}

export async function getSetting(key) {
  const row = await getQuery("SELECT value FROM settings WHERE key = ?", [key]);
  if (!row) return null;
  if (key === 'lowStockLimit' || key === 'broadcastDelay') {
    return parseInt(row.value);
  }
  return row.value;
}

export async function updateSettings(settingsObj) {
  for (const [key, val] of Object.entries(settingsObj)) {
    await runQuery("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, val.toString()]);
  }
  await addLog("SYSTEM", "Konfigurasi sistem diperbarui dari Dashboard Admin.");
  return true;
}

// --- FUNGSI MANAJEMEN PRODUK & KREDENSIAL ---

export async function getProducts() {
  return await allQuery("SELECT * FROM products");
}

export async function getProductByKode(kode) {
  return await getQuery("SELECT * FROM products WHERE kode = ?", [kode.toUpperCase()]);
}

export async function addProduct(kode, nama, harga, stok, deskripsi, gambar = "", delivery_type = "MANUAL") {
  let finalStok = stok;
  if (delivery_type === 'AUTO') {
    finalStok = await getAvailableItemsCount(kode);
  }
  const res = await runQuery(
    "INSERT OR REPLACE INTO products (kode, nama, harga, stok, deskripsi, gambar, delivery_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [kode.toUpperCase(), nama, harga, finalStok, deskripsi, gambar, delivery_type]
  );
  await addLog("SYSTEM", `Produk diperbarui/ditambahkan: ${kode.toUpperCase()} - ${nama} (Stok: ${finalStok}, Tipe: ${delivery_type})`);
  return res;
}

export async function deleteProduct(kode) {
  const res = await runQuery("DELETE FROM products WHERE kode = ?", [kode.toUpperCase()]);
  await addLog("SYSTEM", `Produk dengan kode ${kode.toUpperCase()} dihapus.`);
  return res;
}

export async function updateProductStock(kode, stok) {
  const res = await runQuery(
    "UPDATE products SET stok = ? WHERE kode = ?",
    [stok, kode.toUpperCase()]
  );
  await addLog("SYSTEM", `Stok produk ${kode.toUpperCase()} diubah menjadi ${stok} pcs.`);
  return res;
}

export async function updateProductPrice(kode, harga) {
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
  // Ambil rincian produk bertipe otomatis yang dibeli dalam order ini
  const itemsPurchased = await allQuery(`
    SELECT oi.produk_kode, oi.qty, p.delivery_type, p.nama as produk_nama 
    FROM order_items oi 
    JOIN products p ON oi.produk_kode = p.kode 
    WHERE oi.order_id = ?
  `, [orderId]);

  const deliveredData = {};

  for (const item of itemsPurchased) {
    if (item.delivery_type === 'AUTO') {
      // Ambil kredensial siap pakai
      const readyItems = await allQuery(
        "SELECT id, data_content FROM product_items WHERE produk_kode = ? AND status = 'READY' LIMIT ?",
        [item.produk_kode, item.qty]
      );

      deliveredData[item.produk_kode] = {
        produk_nama: item.produk_nama,
        credentials: readyItems.map(ri => ri.data_content)
      };

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
    }
  }

  return deliveredData;
}

// --- FUNGSI PELANGGAN (TIER DINAMIS) ---

export async function getOrCreateCustomer(nomor, nama) {
  const existing = await getQuery("SELECT * FROM customers WHERE nomor = ?", [nomor]);
  if (existing) {
    if (nama && existing.nama !== nama) {
      await runQuery("UPDATE customers SET nama = ? WHERE nomor = ?", [nama, nomor]);
    }
    return { nomor, nama: nama || existing.nama };
  } else {
    await runQuery("INSERT INTO customers (nomor, nama) VALUES (?, ?)", [nomor, nama || "Pelanggan"]);
    await addLog("SYSTEM", `Pelanggan baru terdaftar: ${nama || 'Pelanggan'} (${nomor})`);
    return { nomor, nama: nama || "Pelanggan" };
  }
}

export async function getCustomersWithTiers() {
  const rows = await allQuery(`
    SELECT 
      c.nomor, 
      c.nama, 
      COUNT(CASE WHEN o.status = 'COMPLETED' THEN 1 END) as total_orders,
      COALESCE(SUM(CASE WHEN o.status = 'COMPLETED' THEN o.total ELSE 0 END), 0) as total_spend
    FROM customers c
    LEFT JOIN orders o ON c.nomor = o.customer_nomor
    GROUP BY c.nomor
  `);

  return rows.map(r => {
    let tier = "Normal";
    if (r.total_orders >= 15) tier = "VIP";
    else if (r.total_orders >= 7) tier = "Gold";
    else if (r.total_orders >= 3) tier = "Silver";
    
    return {
      ...r,
      tier
    };
  });
}

export async function getCustomerDetails(nomor) {
  const customer = await getQuery("SELECT * FROM customers WHERE nomor = ?", [nomor]);
  if (!customer) return null;

  const stats = await getQuery(`
    SELECT 
      COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as total_orders,
      COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN total ELSE 0 END), 0) as total_spend
    FROM orders
    WHERE customer_nomor = ?
  `, [nomor]);

  let tier = "Normal";
  if (stats.total_orders >= 15) tier = "VIP";
  else if (stats.total_orders >= 7) tier = "Gold";
  else if (stats.total_orders >= 3) tier = "Silver";

  const orders = await allQuery("SELECT * FROM orders WHERE customer_nomor = ? ORDER BY created_at DESC", [nomor]);

  return {
    ...customer,
    total_orders: stats.total_orders,
    total_spend: stats.total_spend,
    tier,
    orders
  };
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

  const existingItem = await getQuery(
    "SELECT * FROM order_items WHERE order_id = ? AND produk_kode = ?",
    [orderId, product.kode]
  );

  if (existingItem) {
    const newQty = existingItem.qty + qty;
    if (availableStock < newQty) {
      return { success: false, message: `Gagal menambahkan. Jumlah di keranjang (${newQty}) melebihi stok (${availableStock}).` };
    }
    const newSubtotal = newQty * product.harga;
    await runQuery(
      "UPDATE order_items SET qty = ?, subtotal = ? WHERE id = ?",
      [newQty, newSubtotal, existingItem.id]
    );
  } else {
    const subtotal = qty * product.harga;
    await runQuery(
      "INSERT INTO order_items (order_id, produk_kode, qty, harga, subtotal) VALUES (?, ?, ?, ?, ?)",
      [orderId, product.kode, qty, product.harga, subtotal]
    );
  }

  await updateOrderTotal(orderId);
  return {
    success: true,
    productName: product.nama,
    qty: qty,
    subtotal: qty * product.harga
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
  const total = result.total || 0;
  await runQuery("UPDATE orders SET total = ? WHERE order_id = ?", [total, orderId]);
}

export async function checkoutCart(customerNomor) {
  const cart = await getQuery("SELECT * FROM orders WHERE customer_nomor = ? AND status = 'CART'", [customerNomor]);
  if (!cart) {
    return { success: false, message: "Anda tidak memiliki keranjang belanja aktif." };
  }

  const items = await allQuery("SELECT * FROM order_items WHERE order_id = ?", [cart.order_id]);
  if (items.length === 0) {
    return { success: false, message: "Keranjang belanja Anda masih kosong." };
  }

  for (const item of items) {
    const product = await getProductByKode(item.produk_kode);
    let availableStock = product ? product.stok : 0;
    
    if (product && product.delivery_type === 'AUTO') {
      availableStock = await getAvailableItemsCount(item.produk_kode);
    }

    if (!product || availableStock < item.qty) {
      return {
        success: false,
        message: `Checkout gagal. Stok *${product ? product.nama : item.produk_kode}* tidak mencukupi (Tersisa: ${product ? availableStock : 0}).`
      };
    }
  }

  // (Pemotongan stok produk MANUAL sekarang dilakukan saat status berubah menjadi PAID/COMPLETED di updateOrderStatus)

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
}

export async function updateOrderPaymentLink(orderId, paymentLink, midtransStatus = "pending") {
  return await runQuery(
    "UPDATE orders SET payment_link = ?, midtrans_status = ? WHERE order_id = ?",
    [paymentLink, midtransStatus, orderId]
  );
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

  await runQuery("UPDATE orders SET status = 'CANCELLED' WHERE order_id = ?", [activeOrder.order_id]);
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

export async function updateOrderStatus(orderId, status) {
  const order = await getQuery("SELECT * FROM orders WHERE order_id = ?", [orderId]);
  if (!order) return { success: false, message: "Order ID tidak ditemukan." };

  const oldStatus = order.status;
  const newStatus = status;
  const isPaidStatus = (s) => s === 'PAID' || s === 'COMPLETED';

  // Jika berubah dari BELUM BAYAR ke SUDAH BAYAR, kurangi stok produk MANUAL
  if (!isPaidStatus(oldStatus) && isPaidStatus(newStatus)) {
    const items = await allQuery("SELECT * FROM order_items WHERE order_id = ?", [orderId]);
    for (const item of items) {
      const product = await getProductByKode(item.produk_kode);
      if (product && product.delivery_type === 'MANUAL') {
        await runQuery(
          "UPDATE products SET stok = stok - ? WHERE kode = ?",
          [item.qty, item.produk_kode]
        );
      }
    }
  }

  // Jika berubah dari SUDAH BAYAR ke BATAL/BELUM BAYAR, kembalikan stok produk MANUAL
  if (isPaidStatus(oldStatus) && !isPaidStatus(newStatus)) {
    const items = await allQuery("SELECT * FROM order_items WHERE order_id = ?", [orderId]);
    for (const item of items) {
      const product = await getProductByKode(item.produk_kode);
      if (product && product.delivery_type === 'MANUAL') {
        await runQuery(
          "UPDATE products SET stok = stok + ? WHERE kode = ?",
          [item.qty, item.produk_kode]
        );
      }
    }
  }

  await runQuery("UPDATE orders SET status = ? WHERE order_id = ?", [status, orderId]);
  await addLog("ORDER", `Status Order ${orderId} diubah dari ${order.status} ke ${status}`);
  return { success: true, customerNomor: order.customer_nomor };
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

// --- FUNGSI ANALYTICS & STATS ---

export async function getStats() {
  const prodCount = await getQuery("SELECT COUNT(*) as count FROM products");
  const custCount = await getQuery("SELECT COUNT(*) as count FROM customers");
  const pendingCount = await getQuery("SELECT COUNT(*) as count FROM orders WHERE status = 'WAITING_CONFIRMATION'");
  const completedCount = await getQuery("SELECT COUNT(*) as count FROM orders WHERE status = 'COMPLETED'");
  const revenue = await getQuery("SELECT SUM(total) as sum FROM orders WHERE status = 'COMPLETED'");
  
  return {
    products: prodCount.count,
    customers: custCount.count,
    pendingOrders: pendingCount.count,
    completedOrders: completedCount.count,
    totalRevenue: revenue.sum || 0
  };
}

export async function getAnalyticsData() {
  const revenueToday = await getQuery("SELECT SUM(total) as sum FROM orders WHERE status = 'COMPLETED' AND date(created_at) = date('now')");
  const revenueWeek = await getQuery("SELECT SUM(total) as sum FROM orders WHERE status = 'COMPLETED' AND date(created_at) >= date('now', '-7 days')");
  const revenueMonth = await getQuery("SELECT SUM(total) as sum FROM orders WHERE status = 'COMPLETED' AND date(created_at) >= date('now', '-30 days')");

  const topProducts = await allQuery(`
    SELECT p.nama, SUM(oi.qty) as total_sold
    FROM order_items oi
    JOIN products p ON oi.produk_kode = p.kode
    JOIN orders o ON oi.order_id = o.order_id
    WHERE o.status = 'COMPLETED'
    GROUP BY p.kode
    ORDER BY total_sold DESC
    LIMIT 5
  `);

  const peakHours = await allQuery(`
    SELECT strftime('%H', created_at) as hour, COUNT(*) as count
    FROM orders
    WHERE status = 'COMPLETED'
    GROUP BY hour
    ORDER BY hour ASC
  `);

  const dailyRevenue = await allQuery(`
    SELECT date(created_at) as date, SUM(total) as total
    FROM orders
    WHERE status = 'COMPLETED' AND date(created_at) >= date('now', '-7 days')
    GROUP BY date
    ORDER BY date ASC
  `);

  return {
    revenueToday: revenueToday.sum || 0,
    revenueWeek: revenueWeek.sum || 0,
    revenueMonth: revenueMonth.sum || 0,
    topProducts,
    peakHours,
    dailyRevenue
  };
}

export async function getAllCustomers() {
  return await allQuery("SELECT * FROM customers");
}

function generateOrderId() {
  const date = new Date();
  const dateStr = date.getFullYear().toString() +
                  (date.getMonth() + 1).toString().padStart(2, '0') +
                  date.getDate().toString().padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `ORD-${dateStr}-${rand}`;
}
