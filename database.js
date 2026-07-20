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

  // 10. Tabel Conversations (Live Chat State)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS conversations (
      customer_jid TEXT PRIMARY KEY,
      conversation_state TEXT DEFAULT 'BOT', -- 'BOT', 'ADMIN', 'CLOSED', 'ARCHIVED'
      assigned_admin_id TEXT,
      last_read_message_id TEXT,
      last_read_at INTEGER DEFAULT 0, -- Timestamp pesan terakhir dibaca admin
      last_message_text TEXT,
      last_activity INTEGER DEFAULT 0, -- Status aktivitas terakhir untuk sorting
      internal_notes TEXT,
      labels TEXT DEFAULT '', -- CSV labels: e.g. "VIP,Priority"
      is_pinned INTEGER DEFAULT 0,
      draft_text TEXT,
      FOREIGN KEY(customer_jid) REFERENCES customers(nomor)
    )
  `);

  // 11. Tabel Messages (Chat History)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      customer_jid TEXT NOT NULL,
      sender TEXT NOT NULL, -- 'customer' atau 'admin'
      message_type TEXT NOT NULL, -- 'text', 'image', 'file', 'audio', 'video'
      message TEXT,
      media_path TEXT,
      quoted_id TEXT,
      timestamp INTEGER NOT NULL,
      status TEXT DEFAULT 'sent' -- 'sent', 'delivered', 'read'
    )
  `);
  await runQuery("CREATE INDEX IF NOT EXISTS idx_messages_customer ON messages(customer_jid)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)");
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

export async function addProduct(kode, nama, harga, stok, deskripsi, gambar = "", delivery_type = "MANUAL", oldKode = "") {
  let finalStok = stok;
  const newKodeUpper = kode.toUpperCase();

  // Jika kode produk diubah (oldKode diset dan berbeda dengan kode baru)
  if (oldKode && oldKode.toUpperCase() !== newKodeUpper) {
    const oldUpper = oldKode.toUpperCase();
    await runQuery("UPDATE product_items SET produk_kode = ? WHERE produk_kode = ?", [newKodeUpper, oldUpper]);
    await runQuery("UPDATE order_items SET produk_kode = ? WHERE produk_kode = ?", [newKodeUpper, oldUpper]);
    await runQuery("UPDATE products SET kode = ? WHERE kode = ?", [newKodeUpper, oldUpper]);
  }

  if (delivery_type === 'AUTO') {
    finalStok = await getAvailableItemsCount(newKodeUpper);
  }

  const res = await runQuery(
    "INSERT OR REPLACE INTO products (kode, nama, harga, stok, deskripsi, gambar, delivery_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [newKodeUpper, nama, harga, finalStok, deskripsi, gambar, delivery_type]
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

// Menghapus 1 order dan rincian belanjaannya dari database
export async function deleteOrder(orderId) {
  const order = await getQuery("SELECT * FROM orders WHERE order_id = ?", [orderId]);
  if (!order) return { success: false, message: "Order ID tidak ditemukan." };

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

// --- LOGIKA CHAT / PERCAKAPAN (LIVE CHAT) ---

export async function getOrCreateConversation(customerJid) {
  let customer = await getQuery("SELECT * FROM customers WHERE nomor = ?", [customerJid]);
  if (!customer) {
    const customerName = "Pelanggan";
    await runQuery("INSERT INTO customers (nomor, nama) VALUES (?, ?)", [customerJid, customerName]);
  }
  
  let conv = await getQuery("SELECT * FROM conversations WHERE customer_jid = ?", [customerJid]);
  if (!conv) {
    await runQuery(`
      INSERT INTO conversations (customer_jid, conversation_state, last_activity) 
      VALUES (?, 'BOT', ?)
    `, [customerJid, Date.now()]);
    conv = await getQuery("SELECT * FROM conversations WHERE customer_jid = ?", [customerJid]);
  }
  return conv;
}

export async function getConversationsList() {
  const sql = `
    SELECT 
      c.nomor as customer_jid,
      c.nama as customer_nama,
      cv.conversation_state,
      cv.assigned_admin_id,
      cv.last_read_message_id,
      cv.last_read_at,
      cv.last_message_text,
      cv.last_activity,
      cv.internal_notes,
      cv.labels,
      cv.is_pinned,
      cv.draft_text,
      (
        SELECT COUNT(*) FROM messages m 
        WHERE m.customer_jid = c.nomor 
          AND m.sender = 'customer' 
          AND m.timestamp > cv.last_read_at
      ) as unread_count
    FROM customers c
    JOIN conversations cv ON c.nomor = cv.customer_jid
    ORDER BY cv.is_pinned DESC, cv.last_activity DESC
  `;
  return await allQuery(sql);
}

export async function getConversationMessages(customerJid, limit = 100) {
  const sql = `
    SELECT * FROM messages 
    WHERE customer_jid = ? 
    ORDER BY timestamp ASC 
    LIMIT ?
  `;
  return await allQuery(sql, [customerJid, limit]);
}

export async function saveChatMessage({ id, customerJid, sender, messageType, message, mediaPath, quotedId, timestamp, status = 'sent' }) {
  await getOrCreateConversation(customerJid);

  await runQuery(`
    INSERT OR REPLACE INTO messages (id, customer_jid, sender, message_type, message, media_path, quoted_id, timestamp, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, customerJid, sender, messageType, message, mediaPath, quotedId, timestamp, status]);

  let lastMsgText = message;
  if (messageType === 'image') lastMsgText = '📷 Gambar';
  else if (messageType === 'video') lastMsgText = '🎥 Video';
  else if (messageType === 'audio') lastMsgText = '🎙️ Pesan Suara';
  else if (messageType === 'file') lastMsgText = '📄 Dokumen';

  await runQuery(`
    UPDATE conversations 
    SET last_message_text = ?, last_activity = ?
    WHERE customer_jid = ?
  `, [lastMsgText, timestamp, customerJid]);

  if (sender !== 'customer') {
    await runQuery(`
      UPDATE conversations 
      SET last_read_at = ?
      WHERE customer_jid = ?
    `, [timestamp, customerJid]);
  }
}

export async function updateConversationState(customerJid, state, adminId = null) {
  await getOrCreateConversation(customerJid);
  await runQuery(`
    UPDATE conversations 
    SET conversation_state = ?, assigned_admin_id = ?
    WHERE customer_jid = ?
  `, [state, adminId, customerJid]);
}

export async function updateConversationNotes(customerJid, notes) {
  await getOrCreateConversation(customerJid);
  await runQuery(`
    UPDATE conversations 
    SET internal_notes = ?
    WHERE customer_jid = ?
  `, [notes, customerJid]);
}

export async function updateConversationLabels(customerJid, labels) {
  await getOrCreateConversation(customerJid);
  await runQuery(`
    UPDATE conversations 
    SET labels = ?
    WHERE customer_jid = ?
  `, [labels, customerJid]);
}

export async function updateConversationPin(customerJid, isPinned) {
  await getOrCreateConversation(customerJid);
  await runQuery(`
    UPDATE conversations 
    SET is_pinned = ?
    WHERE customer_jid = ?
  `, [isPinned ? 1 : 0, customerJid]);
}

export async function updateConversationReadStatus(customerJid, timestamp = Date.now()) {
  await getOrCreateConversation(customerJid);
  await runQuery(`
    UPDATE conversations 
    SET last_read_at = ?
    WHERE customer_jid = ?
  `, [timestamp, customerJid]);
}

export async function updateMessageStatus(messageId, status) {
  await runQuery(`
    UPDATE messages 
    SET status = ?
    WHERE id = ?
  `, [status, messageId]);
}
