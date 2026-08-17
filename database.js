import sqlite3 from 'sqlite3';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

const sqlite = sqlite3.verbose();
const dbFile = './shop.db';

let db;
let transactionQueue = Promise.resolve();

// Membungkus method-method database dalam Promise agar bisa menggunakan async/await
export function openDb() {
  return new Promise((resolve, reject) => {
    db = new sqlite.Database(dbFile, (err) => {
      if (err) {
        console.error('Gagal membuka database:', err.message);
        reject(err);
      } else {
        db.configure('busyTimeout', 5000);
        console.log('Terhubung ke database SQLite.');
        resolve();
      }
    });
  });
}

export async function withTransaction(callback) {
  const transaction = transactionQueue.then(async () => {
    await runQuery('BEGIN IMMEDIATE');
    try {
      const result = await callback();
      await runQuery('COMMIT');
      return result;
    } catch (error) {
      try {
        await runQuery('ROLLBACK');
      } catch (rollbackError) {
        console.error('Gagal membatalkan transaksi SQLite:', rollbackError.message);
      }
      throw error;
    }
  });
  transactionQueue = transaction.catch(() => undefined);
  return transaction;
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
  if (!db) {
    await openDb();
  }

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
      role TEXT NOT NULL,
      two_factor_secret TEXT,
      two_factor_enabled INTEGER DEFAULT 0
    )
  `);
  try { await runQuery("ALTER TABLE users ADD COLUMN two_factor_secret TEXT"); } catch (e) {}
  try { await runQuery("ALTER TABLE users ADD COLUMN two_factor_enabled INTEGER DEFAULT 0"); } catch (e) {}

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

  // Jalankan migrasi kolom petunjuk penggunaan
  try {
    await runQuery("ALTER TABLE products ADD COLUMN petunjuk TEXT");
  } catch (e) {
    // Abaikan jika kolom sudah ada
  }

  // Jalankan migrasi kolom prodseller_id (link ke ProdSeller API supplier)
  try {
    await runQuery("ALTER TABLE products ADD COLUMN prodseller_id TEXT");
  } catch (e) {
    // Abaikan jika kolom sudah ada
  }

  // Jalankan migrasi kolom notifikasi restock/harga
  try {
    await runQuery("ALTER TABLE products ADD COLUMN last_price REAL");
  } catch (e) {}
  try {
    await runQuery("ALTER TABLE products ADD COLUMN last_stock_status INTEGER");
  } catch (e) {}

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
      nama TEXT,
      balance INTEGER DEFAULT 0,
      referral_code TEXT,
      referred_by TEXT,
      role TEXT DEFAULT 'MEMBER',
      account_status TEXT DEFAULT 'ACTIVE',
      profile_completed INTEGER DEFAULT 0,
      registered_at DATETIME,
      last_seen_at DATETIME
    )
  `);

  try { await runQuery("ALTER TABLE customers ADD COLUMN balance INTEGER DEFAULT 0"); } catch (e) {}
  try { await runQuery("ALTER TABLE customers ADD COLUMN referral_code TEXT"); } catch (e) {}
  try { await runQuery("ALTER TABLE customers ADD COLUMN referred_by TEXT"); } catch (e) {}
  try { await runQuery("ALTER TABLE customers ADD COLUMN role TEXT DEFAULT 'MEMBER'"); } catch (e) {}
  try { await runQuery("ALTER TABLE customers ADD COLUMN account_status TEXT DEFAULT 'ACTIVE'"); } catch (e) {}
  try { await runQuery("ALTER TABLE customers ADD COLUMN profile_completed INTEGER DEFAULT 0"); } catch (e) {}
  try { await runQuery("ALTER TABLE customers ADD COLUMN registered_at DATETIME"); } catch (e) {}
  try { await runQuery("ALTER TABLE customers ADD COLUMN last_seen_at DATETIME"); } catch (e) {}

  // 6b. Tabel Reviews / Rating Produk
  await runQuery(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      customer_nomor TEXT NOT NULL,
      produk_kode TEXT,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 6c. Tabel Flash Sale
  await runQuery(`
    CREATE TABLE IF NOT EXISTS flash_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produk_kode TEXT UNIQUE NOT NULL,
      harga_flash INTEGER NOT NULL,
      end_time DATETIME NOT NULL
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

  // 10. Tabel Peringatan Pelanggan (Anti-Spam & Moderasi)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS customer_warnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 11. Tabel Riwayat Broadcast Restok
  await runQuery(`
    CREATE TABLE IF NOT EXISTS broadcast_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_code TEXT NOT NULL,
      total_subscribers INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME
    )
  `);

  // 12. Tabel Banned Users
  await runQuery(`
    CREATE TABLE IF NOT EXISTS banned_users (
      jid TEXT PRIMARY KEY,
      reason TEXT,
      banned_by TEXT,
      expires_at INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  try {
    await runQuery("ALTER TABLE banned_users ADD COLUMN expires_at INTEGER");
  } catch (e) {}

  // 12b. Tabel Moderators (user yang bisa pakai perintah .ban/.unban atas izin Owner)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS moderators (
      jid TEXT PRIMARY KEY,
      added_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migrasi: tambah ownerJid ke settings (untuk mapping LID -> phone owner)
  try {
    const ownerJidSetting = await getQuery("SELECT value FROM settings WHERE key = 'ownerJid'");
    if (!ownerJidSetting) {
      await runQuery("INSERT INTO settings (key, value) VALUES ('ownerJid', '')");
    }
  } catch(e) {}

  // 12. Tabel Pengaturan Moderasi Per-Grup
  await runQuery(`
    CREATE TABLE IF NOT EXISTS group_chat_stats (group_jid TEXT, participant_jid TEXT, msg_count INTEGER DEFAULT 0, PRIMARY KEY (group_jid, participant_jid))
  `);
  await runQuery(`
    CREATE TABLE IF NOT EXISTS group_settings (
      jid TEXT PRIMARY KEY,
      welcome_enabled INTEGER DEFAULT 1,
      welcome_msg TEXT,
      goodbye_enabled INTEGER DEFAULT 1,
      goodbye_msg TEXT,
      anti_link INTEGER DEFAULT 0,
      bot_mode TEXT DEFAULT 'all',
      auto_sholat INTEGER DEFAULT 1,
      levelup_enabled INTEGER DEFAULT 1,
      auto_dl_enabled INTEGER DEFAULT 1
    )
  `);
  await runQuery(`
    CREATE TABLE IF NOT EXISTS menfess_sessions (
      id TEXT PRIMARY KEY,
      sender_jid TEXT NOT NULL,
      target_jid TEXT NOT NULL,
      status TEXT DEFAULT 'ACTIVE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_reply_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  try {
    await runQuery(`ALTER TABLE group_settings ADD COLUMN anti_link INTEGER DEFAULT 0`);
  } catch (e) {}
  try {
    await runQuery(`ALTER TABLE group_settings ADD COLUMN bot_mode TEXT DEFAULT 'all'`);
  } catch (e) {}
  try {
    await runQuery(`ALTER TABLE group_settings ADD COLUMN auto_sholat INTEGER DEFAULT 1`);
  } catch (e) {}
  try {
    await runQuery(`ALTER TABLE group_settings ADD COLUMN levelup_enabled INTEGER DEFAULT 1`);
  } catch (e) {}
  try {
    await runQuery(`ALTER TABLE group_settings ADD COLUMN auto_dl_enabled INTEGER DEFAULT 1`);
  } catch (e) {}

  // 13. Tabel coupons
  await runQuery(`
    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      value INTEGER NOT NULL,
      min_order INTEGER DEFAULT 0,
      max_uses INTEGER DEFAULT 0,
      used_count INTEGER DEFAULT 0,
      expires_at DATETIME,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 14. Tabel reviews
  await runQuery(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      customer_nomor TEXT NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      review_reminder_sent INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(order_id)
    )
  `);

  // 15. Tabel referrals
  await runQuery(`
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_nomor TEXT NOT NULL,
      referred_nomor TEXT NOT NULL,
      reward_claimed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(referred_nomor)
    )
  `);

  // 16. Tabel faqs
  await runQuery(`
    CREATE TABLE IF NOT EXISTS faqs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keywords TEXT NOT NULL,
      answer TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 17. Tabel loyalty
  await runQuery(`
    CREATE TABLE IF NOT EXISTS loyalty (
      customer_nomor TEXT PRIMARY KEY,
      points INTEGER DEFAULT 0,
      total_spent INTEGER DEFAULT 0,
      tier TEXT DEFAULT 'Bronze'
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS game_profiles (
      customer_jid TEXT PRIMARY KEY,
      points INTEGER DEFAULT 0,
      bank_points INTEGER DEFAULT 0,
      xp INTEGER DEFAULT 0,
      level INTEGER DEFAULT 1,
      games_played INTEGER DEFAULT 0,
      games_won INTEGER DEFAULT 0,
      daily_claimed_at TEXT,
      daily_streak INTEGER DEFAULT 0,
      last_robbed_at DATETIME,
      last_rob_time DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migrasi kolom baru untuk game_profiles jika tabel sudah ada
  try { await runQuery("ALTER TABLE game_profiles ADD COLUMN bank_points INTEGER DEFAULT 0"); } catch (e) { /* ignore if exists */ }
  try { await runQuery("ALTER TABLE game_profiles ADD COLUMN last_robbed_at DATETIME"); } catch (e) { /* ignore if exists */ }
  try { await runQuery("ALTER TABLE game_profiles ADD COLUMN last_rob_time DATETIME"); } catch (e) { /* ignore if exists */ }

  // Tabel AFK Users
  await runQuery(`
    CREATE TABLE IF NOT EXISTS afk_users (
      jid TEXT PRIMARY KEY,
      reason TEXT,
      time INTEGER
    )
  `);


  // 18. Tabel bundles
  await runQuery(`
    CREATE TABLE IF NOT EXISTS bundles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nama TEXT NOT NULL,
      produk_list TEXT NOT NULL,
      harga_bundle INTEGER NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 19. Tabel wishlist
  await runQuery(`
    CREATE TABLE IF NOT EXISTS wishlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_nomor TEXT NOT NULL,
      produk_kode TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(customer_nomor, produk_kode)
    )
  `);

  // 20. Tabel RPG Characters
  await runQuery(`
    CREATE TABLE IF NOT EXISTS rpg_characters (
      jid TEXT PRIMARY KEY,
      class TEXT DEFAULT 'Warrior',
      hp INTEGER DEFAULT 100,
      max_hp INTEGER DEFAULT 100,
      mp INTEGER DEFAULT 50,
      max_mp INTEGER DEFAULT 50,
      attack INTEGER DEFAULT 15,
      defense INTEGER DEFAULT 10,
      speed INTEGER DEFAULT 10,
      gold INTEGER DEFAULT 0,
      dungeon_floor INTEGER DEFAULT 1,
      last_battle_at DATETIME,
      last_heal_at DATETIME,
      in_battle INTEGER DEFAULT 0,
      battle_state TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  try { await runQuery("ALTER TABLE rpg_characters ADD COLUMN in_battle INTEGER DEFAULT 0"); } catch (e) {}
  try { await runQuery("ALTER TABLE rpg_characters ADD COLUMN battle_state TEXT"); } catch (e) {}

  // 21. Tabel RPG Inventory
  await runQuery(`
    CREATE TABLE IF NOT EXISTS rpg_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      item_id TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      UNIQUE(jid, item_id)
    )
  `);

  // 22. Tabel RPG Items Master
  await runQuery(`
    CREATE TABLE IF NOT EXISTS rpg_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      effect TEXT,
      price_gold INTEGER DEFAULT 0,
      rarity TEXT DEFAULT 'Common',
      description TEXT
    )
  `);

  // 23. Tabel RPG Battle Log
  await runQuery(`
    CREATE TABLE IF NOT EXISTS rpg_battle_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      enemy_name TEXT NOT NULL,
      floor INTEGER NOT NULL,
      result TEXT NOT NULL,
      gold_gained INTEGER DEFAULT 0,
      xp_gained INTEGER DEFAULT 0,
      item_dropped TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 24. Tabel Premium Users
  await runQuery(`
    CREATE TABLE IF NOT EXISTS premium_users (
      jid TEXT PRIMARY KEY,
      tier TEXT DEFAULT 'Silver',
      expires_at DATETIME NOT NULL,
      activated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      activated_by TEXT DEFAULT 'SELF',
      auto_renew INTEGER DEFAULT 0
    )
  `);

  // 25. Tabel Premium Benefits Log
  await runQuery(`
    CREATE TABLE IF NOT EXISTS premium_benefits_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      benefit_type TEXT NOT NULL,
      value TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 26. Tabel RPG Equipment Slots
  await runQuery(`
    CREATE TABLE IF NOT EXISTS rpg_equipment (
      jid TEXT PRIMARY KEY,
      weapon_id TEXT DEFAULT NULL,
      armor_id TEXT DEFAULT NULL,
      helmet_id TEXT DEFAULT NULL,
      accessory_id TEXT DEFAULT NULL,
      FOREIGN KEY(jid) REFERENCES rpg_characters(jid)
    )
  `);

  // 26b. Tabel RPG Persistent Active Battle (State Battle Simpan di DB)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS rpg_active_battle (
      jid TEXT PRIMARY KEY,
      monster_id TEXT NOT NULL,
      monster_name TEXT NOT NULL,
      monster_emoji TEXT DEFAULT '👾',
      monster_hp INTEGER NOT NULL,
      monster_max_hp INTEGER NOT NULL,
      monster_attack INTEGER NOT NULL,
      monster_defense INTEGER NOT NULL,
      player_hp INTEGER NOT NULL,
      player_max_hp INTEGER NOT NULL,
      player_mp INTEGER NOT NULL,
      player_max_mp INTEGER NOT NULL,
      floor INTEGER NOT NULL,
      turn INTEGER DEFAULT 0,
      status_effects TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 26c. Tabel RPG Equipment Enhancement (+1..+5)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS rpg_equipment_upgrade (
      jid TEXT NOT NULL,
      slot TEXT NOT NULL,
      item_id TEXT NOT NULL,
      enhance_level INTEGER DEFAULT 0,
      bonus_attack INTEGER DEFAULT 0,
      bonus_defense INTEGER DEFAULT 0,
      PRIMARY KEY (jid, slot)
    )
  `);

  // 27. Tabel RPG Monsters Master (Database based monsters)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS rpg_monsters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      emoji TEXT DEFAULT '👾',
      min_floor INTEGER DEFAULT 1,
      max_floor INTEGER DEFAULT 30,
      is_boss INTEGER DEFAULT 0,
      hp INTEGER NOT NULL,
      attack INTEGER NOT NULL,
      defense INTEGER NOT NULL,
      gold_reward INTEGER NOT NULL,
      xp_reward INTEGER NOT NULL,
      drop_item_id TEXT DEFAULT NULL
    )
  `);

  // 28. Tabel RPG Economy Log (Audit Trail Inflow/Outflow)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS rpg_economy_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      item_id TEXT,
      reason TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 29. Tabel RPG Gacha Banners & Pool
  await runQuery(`
    CREATE TABLE IF NOT EXISTS rpg_gacha_banners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cost_gold INTEGER NOT NULL,
      is_active INTEGER DEFAULT 1
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS rpg_gacha_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      banner_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      rarity TEXT NOT NULL,
      weight INTEGER NOT NULL,
      FOREIGN KEY(banner_id) REFERENCES rpg_gacha_banners(id)
    )
  `);

  // 30. Tabel RPG World Boss & Damage Contribution
  await runQuery(`
    CREATE TABLE IF NOT EXISTS rpg_world_boss (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      emoji TEXT DEFAULT '👹',
      hp INTEGER NOT NULL,
      max_hp INTEGER NOT NULL,
      attack INTEGER NOT NULL,
      defense INTEGER NOT NULL,
      week INTEGER NOT NULL,
      status TEXT DEFAULT 'ACTIVE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS rpg_boss_damage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      boss_id INTEGER NOT NULL,
      jid TEXT NOT NULL,
      total_damage INTEGER DEFAULT 0,
      last_attack_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(boss_id, jid)
    )
  `);

  // 32. Tabel Suit Challenges (Multiplayer)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS suit_challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenger_jid TEXT NOT NULL,
      challenged_jid TEXT NOT NULL,
      group_jid TEXT NOT NULL,
      bet INTEGER NOT NULL,
      challenger_choice TEXT DEFAULT NULL,
      challenged_choice TEXT DEFAULT NULL,
      status TEXT DEFAULT 'PENDING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  try {
    await runQuery("ALTER TABLE customers ADD COLUMN referral_code TEXT");
  } catch (e) {}

  try {
    await runQuery("ALTER TABLE orders ADD COLUMN review_reminder_sent INTEGER DEFAULT 0");
  } catch (e) {}

  try {
    await runQuery("ALTER TABLE orders ADD COLUMN coupon_code TEXT");
  } catch (e) {}

  // Tabel Group Rentals (Invited Only)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS group_rentals (
      group_jid TEXT PRIMARY KEY,
      expires_at DATETIME,
      added_by TEXT
    )
  `);

  try {
    await runQuery("ALTER TABLE orders ADD COLUMN discount_amount INTEGER DEFAULT 0");
  } catch (e) {}
  try {
    await runQuery("ALTER TABLE orders ADD COLUMN coupon_redeemed INTEGER DEFAULT 0");
  } catch (e) {}
  try {
    await runQuery("ALTER TABLE order_items ADD COLUMN stock_reserved INTEGER DEFAULT 0");
  } catch (e) {}

  // Masukkan pengaturan default ke tabel settings jika belum ada
  const defaultSettings = config.defaults;
  for (const [key, val] of Object.entries(defaultSettings)) {
    const existing = await getQuery("SELECT value FROM settings WHERE key = ?", [key]);
    if (!existing) {
      await runQuery("INSERT INTO settings (key, value) VALUES (?, ?)", [key, val.toString()]);
    }
  }

  // Masukkan pengguna default (Owner, Admin, CS) jika kosong
  const usersCount = await getQuery("SELECT COUNT(*) as count FROM users");
  if (usersCount.count === 0) {
    console.log("Mengisi pengguna default ke database...");
    await runQuery(
      "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'Owner')",
      [config.adminUser, config.adminPasswordHash]
    );
    console.log(`Pengguna admin dari environment berhasil dibuat (${config.adminUser}).`);
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

  // Perbarui petunjuk penggunaan pada produk yang sudah ada (misal: APPLEMUSIC, ADOBE, GEMINI)
  const userInstructionsMap = [
    {
      keywords: ['APPLEMUSIC', 'APM01', 'APPLE MUSIC'],
      petunjuk: `🍎 *Apple Music (Up to 6 Months)*

📌 *User Requirements*

✅ Apple ID required (new or existing).
✅ Works on both Android & iPhone.

⚠️ If you encounter a region restriction or region mismatch error, connect to an Indian VPN and try again.
⚠️ If you've already used Apple's 1-month free trial, you'll receive up to 5 months instead of 6.
⚠️ Subscription remains active for the benefit period.`
    },
    {
      keywords: ['ADB01', 'ADOBE', 'ADOBEEXPRESS', 'ADOBE EXPRESS'],
      petunjuk: `🎨 *Adobe Express Premium (12 Months)*

📌 *User Requirements*

✅ Adobe account required (new or existing).
✅ No payment method required.
✅ Existing Adobe Premium users can also redeem (subscription extension depends on Adobe policy).

⚠️ If you encounter a region restriction or region mismatch error, connect to an Indian VPN and try again.

❌ Non-transferable.
❌ Cannot be exchanged for cash.`
    },
    {
      keywords: ['GEMINI01', 'GEMINI', 'GEMINIPRO', 'GEMINI PRO'],
      petunjuk: `🚀 *ACTIVATE YOUR 18-MONTH GEMINI PRO + 5TB STORAGE IN 3 EASY STEPS* 🚀

Got your activation link? Follow these quick steps to unlock your premium benefits instantly — no password, OTP, or payment details required.

✅ *STEP 1: CHECK YOUR GOOGLE ACCOUNT*

Make sure you’re logged into the personal Google account where you want the benefits activated.

⚠️ *Important:*
• Workspace, school, or business accounts are NOT supported
• If your account is already in another Google Family Group, leave it first: g.co/yourfamily

✅ *STEP 2: OPEN THE ACTIVATION LINK*

Click the unique activation link provided by our bot.

You’ll automatically be redirected to the official Google invitation page.

✅ *STEP 3: ACCEPT THE INVITATION*

Tap “Join Family” or “Accept Invitation”.

🎉 *That’s it! Your account will be upgraded instantly.*

You can now enjoy:
✔ Gemini Advanced / Gemini Pro Features
✔ 5TB Google Drive Storage
✔ Premium Google AI Tools

📌 Open Google Drive to confirm the storage upgrade and open Gemini to start using advanced AI features instantly.`
    }
  ];

  for (const item of userInstructionsMap) {
    for (const kw of item.keywords) {
      await runQuery(
        "UPDATE products SET petunjuk = ? WHERE (kode = ? OR UPPER(nama) LIKE ?) AND (petunjuk IS NULL OR petunjuk = '')",
        [item.petunjuk, kw, `%${kw}%`]
      );
    }
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

  // --- CASAKU PAYMENT SYSTEM MIGRATION ---

  // Migrate orders table: add Casaku payment columns
  try { await runQuery("ALTER TABLE orders ADD COLUMN payment_amount INTEGER DEFAULT 0"); } catch(e) {}
  try { await runQuery("ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT 'PENDING'"); } catch(e) {}
  try { await runQuery("ALTER TABLE orders ADD COLUMN fulfillment_status TEXT DEFAULT 'PENDING'"); } catch(e) {}
  try { await runQuery("ALTER TABLE orders ADD COLUMN expired_at INTEGER"); } catch(e) {}
  try { await runQuery("ALTER TABLE orders ADD COLUMN casaku_transaction_id TEXT"); } catch(e) {}

  // payment_transactions table
  await runQuery(`
    CREATE TABLE IF NOT EXISTS payment_transactions (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'casaku',
      provider_transaction_id TEXT,
      expected_amount INTEGER NOT NULL,
      received_amount INTEGER,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at INTEGER NOT NULL,
      paid_at INTEGER,
      FOREIGN KEY(order_id) REFERENCES orders(order_id),
      UNIQUE(provider, provider_transaction_id)
    )
  `);

  // payment_webhooks table (full audit trail)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS payment_webhooks (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'casaku',
      transaction_id TEXT,
      signature TEXT,
      payload TEXT,
      received_at INTEGER NOT NULL,
      processed_at INTEGER,
      processing_status TEXT NOT NULL DEFAULT 'RECEIVED'
    )
  `);

  // fulfillment_jobs table
  await runQuery(`
    CREATE TABLE IF NOT EXISTS fulfillment_jobs (
      job_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      customer_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(order_id) REFERENCES orders(order_id)
    )
  `);

  // Indexes for performance
  await runQuery("CREATE INDEX IF NOT EXISTS idx_payment_transactions_order ON payment_transactions(order_id)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_payment_transactions_provider_txid ON payment_transactions(provider, provider_transaction_id)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_fulfillment_jobs_status ON fulfillment_jobs(status)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status)");

  // --- PREMIUM 2.0 & RESELLER MIGRATION ---

  // Tabel Reseller Products (.lapak)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS reseller_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seller_jid TEXT NOT NULL,
      seller_nama TEXT,
      nama TEXT NOT NULL,
      harga INTEGER NOT NULL,
      stok INTEGER NOT NULL DEFAULT 1,
      isi_produk TEXT NOT NULL,
      status TEXT DEFAULT 'ACTIVE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(seller_jid) REFERENCES customers(nomor)
    )
  `);

  // Tabel AI Usage Logs (.ai daily limit control)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS ai_usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      UNIQUE(jid, usage_date)
    )
  `);

  // Tabel User Wishlists (notifikasi restock otomatis)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS user_wishlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      produk_kode TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(jid, produk_kode)
    )
  `);

  // Tabel Premium Monthly Claims (.claimvoucher)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS premium_monthly_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      claim_month TEXT NOT NULL,
      claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(jid, claim_month)
    )
  `);

  await runQuery("CREATE INDEX IF NOT EXISTS idx_reseller_status ON reseller_products(status)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_ai_usage_jid_date ON ai_usage_logs(jid, usage_date)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_wishlist_produk ON user_wishlists(produk_kode)");

  // --- PREMIUM 2.0 & RESELLER MIGRATION ---

  // Tabel Reseller Products (.lapak)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS reseller_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seller_jid TEXT NOT NULL,
      seller_nama TEXT,
      nama TEXT NOT NULL,
      harga INTEGER NOT NULL,
      stok INTEGER NOT NULL DEFAULT 1,
      isi_produk TEXT NOT NULL,
      status TEXT DEFAULT 'ACTIVE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(seller_jid) REFERENCES customers(nomor)
    )
  `);

  // Tabel AI Usage Logs (.ai daily limit control)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS ai_usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      UNIQUE(jid, usage_date)
    )
  `);

  // Tabel User Wishlists (notifikasi restock otomatis)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS user_wishlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      produk_kode TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(jid, produk_kode)
    )
  `);

  // Tabel Premium Monthly Claims (.claimvoucher)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS premium_monthly_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      claim_month TEXT NOT NULL,
      claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(jid, claim_month)
    )
  `);

  await runQuery("CREATE INDEX IF NOT EXISTS idx_reseller_status ON reseller_products(status)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_ai_usage_jid_date ON ai_usage_logs(jid, usage_date)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_wishlist_produk ON user_wishlists(produk_kode)");

  // --- FINANCIAL & POINTS SECURITY ENGINE ---

  // Financial Logs (Full audit trail for IDR balance changes)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS financial_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_nomor TEXT NOT NULL,
      type TEXT NOT NULL, -- 'DEPOSIT', 'PURCHASE', 'PAYOUT', 'REFUND', 'BONUS'
      amount INTEGER NOT NULL,
      source TEXT,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Point Logs (Full audit trail for Akbar Poin)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS point_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_nomor TEXT NOT NULL,
      type TEXT NOT NULL, -- 'EARN_PURCHASE', 'EARN_DAILY', 'EARN_REFERRAL', 'DEDUCT_REDEEM', 'DEDUCT_PREMIUM'
      points INTEGER NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Referral Verifications (First-purchase lock)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS referral_verifications (
      referrer_nomor TEXT NOT NULL,
      referred_nomor TEXT NOT NULL PRIMARY KEY,
      status TEXT DEFAULT 'PENDING_FIRST_PURCHASE',
      points_awarded INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      unlocked_at DATETIME
    )
  `);

  await runQuery("CREATE INDEX IF NOT EXISTS idx_financial_customer ON financial_logs(customer_nomor)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_point_logs_customer ON point_logs(customer_nomor)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_referral_referrer ON referral_verifications(referrer_nomor)");

  // Cleanup & Migration untuk mencegah NULL/NaN/Non-Integer points/xp di database
  await runQuery("UPDATE game_profiles SET points = 0 WHERE points IS NULL OR typeof(points) != 'integer' OR points < 0 OR points > 1000000");
  await runQuery("UPDATE game_profiles SET xp = 0 WHERE xp IS NULL OR typeof(xp) != 'integer' OR xp < 0");
  await runQuery("UPDATE game_profiles SET level = 1 WHERE level IS NULL OR typeof(level) != 'integer' OR level < 1");
  await runQuery("UPDATE game_profiles SET games_played = 0 WHERE games_played IS NULL OR typeof(games_played) != 'integer' OR games_played < 0");
  await runQuery("UPDATE game_profiles SET games_won = 0 WHERE games_won IS NULL OR typeof(games_won) != 'integer' OR games_won < 0");
  await runQuery("UPDATE game_profiles SET daily_streak = 0 WHERE daily_streak IS NULL OR typeof(daily_streak) != 'integer' OR daily_streak < 0");
  await runQuery("UPDATE loyalty SET points = 0 WHERE points IS NULL OR typeof(points) != 'integer' OR points < 0");
  await runQuery("UPDATE loyalty SET total_spent = 0 WHERE total_spent IS NULL OR typeof(total_spent) != 'integer' OR total_spent < 0");
}


// --- FUNGSI USERS / AKUN ---

export async function getUsers() {
  return await allQuery("SELECT username, role FROM users ORDER BY role DESC, username ASC");
}

export async function getUserByUsername(username) {
  return await getQuery("SELECT * FROM users WHERE username = ?", [username.toLowerCase()]);
}

export async function setTwoFactorSecret(username, secret) {
  return await runQuery(
    "UPDATE users SET two_factor_secret = ?, two_factor_enabled = 0 WHERE username = ?",
    [secret, username.toLowerCase()]
  );
}

export async function setTwoFactorEnabled(username, enabled) {
  return await runQuery(
    "UPDATE users SET two_factor_enabled = ? WHERE username = ?",
    [enabled ? 1 : 0, username.toLowerCase()]
  );
}

export async function disableTwoFactor(username) {
  return await runQuery(
    "UPDATE users SET two_factor_secret = NULL, two_factor_enabled = 0 WHERE username = ?",
    [username.toLowerCase()]
  );
}

export async function addUser(username, password, role) {
  const normalizedUsername = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,40}$/.test(normalizedUsername)) {
    throw new Error('Username harus 3-40 karakter dan hanya boleh berisi huruf, angka, garis bawah, atau tanda hubung.');
  }
  if (String(password || '').length < 8 || String(password || '').length > 200) {
    throw new Error('Password harus berisi 8-200 karakter.');
  }
  if (!['Owner', 'Admin', 'CS'].includes(role)) {
    throw new Error('Role pengguna tidak valid.');
  }
  const hash = bcrypt.hashSync(password, 10);
  const res = await runQuery(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    [normalizedUsername, hash, role]
  );
  await addLog("SYSTEM", `Akun pengguna baru ditambahkan: ${normalizedUsername} (${role})`);
  return res;
}

export async function updateUserPassword(username, newPassword) {
  if (String(newPassword || '').length < 8 || String(newPassword || '').length > 200) {
    throw new Error('Password harus berisi 8-200 karakter.');
  }
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

export async function addProduct(kode, nama, harga, stok, deskripsi, gambar = "", delivery_type = "MANUAL", oldKode = "", petunjuk = "") {
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
    "INSERT OR REPLACE INTO products (kode, nama, harga, stok, deskripsi, gambar, delivery_type, petunjuk) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [newKodeUpper, normalizedNama, harga, finalStok, deskripsi, gambar, delivery_type, petunjuk]
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
    SELECT oi.produk_kode, oi.qty, p.delivery_type, p.nama as produk_nama, p.petunjuk 
    FROM order_items oi 
    JOIN products p ON oi.produk_kode = p.kode 
    WHERE oi.order_id = ?
  `, [orderId]);

    const deliveredData = {};

    for (const item of itemsPurchased) {
      if (item.delivery_type === 'AUTO') {
        // Ambil kredensial siap pakai
        let readyItems = await allQuery(
        "SELECT id, data_content FROM product_items WHERE produk_kode = ? AND status = 'RESERVED' AND order_id = ? LIMIT ?",
        [item.produk_kode, orderId, item.qty]
      );
        if (readyItems.length < item.qty) {
          const fallbackItems = await allQuery(
          "SELECT id, data_content FROM product_items WHERE produk_kode = ? AND status = 'READY' LIMIT ?",
          [item.produk_kode, item.qty - readyItems.length]
        );
          readyItems = readyItems.concat(fallbackItems);
        }

        deliveredData[item.produk_kode] = {
          produk_nama: item.produk_nama,
          petunjuk: item.petunjuk || '',
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
  });
}

// --- FUNGSI PELANGGAN (TIER DINAMIS) ---

export async function getOrCreateCustomer(nomor, nama) {
  const existing = await getQuery("SELECT * FROM customers WHERE nomor = ?", [nomor]);
  if (existing) {
    // Hanya perbarui nama jika pendaftaran profil belum diselesaikan (.daftar)
    if (nama && existing.nama !== nama && Number(existing.profile_completed || 0) === 0) {
      await runQuery("UPDATE customers SET nama = ? WHERE nomor = ?", [nama, nomor]);
    }
    await runQuery("UPDATE customers SET last_seen_at = CURRENT_TIMESTAMP WHERE nomor = ?", [nomor]);
    return { nomor, nama: Number(existing.profile_completed || 0) === 1 ? existing.nama : (nama || existing.nama) };
  } else {
    await runQuery("INSERT INTO customers (nomor, nama, last_seen_at) VALUES (?, ?, CURRENT_TIMESTAMP)", [nomor, nama || "Pelanggan"]);
    await addLog("SYSTEM", `Pelanggan baru terdaftar: ${nama || 'Pelanggan'} (${nomor})`);
    return { nomor, nama: nama || "Pelanggan" };
  }
}

function calculateCustomerTier(totalOrders) {
  if (totalOrders >= 15) return 'PLATINUM';
  if (totalOrders >= 7) return 'GOLD';
  if (totalOrders >= 3) return 'SILVER';
  return 'BRONZE';
}

export async function registerCustomer(nomor, nama) {
  const cleanName = String(nama || '').trim().replace(/\s+/g, ' ');
  if (cleanName.length < 2 || cleanName.length > 40) {
    throw new Error('Nama harus berisi 2-40 karakter.');
  }
  await getOrCreateCustomer(nomor, cleanName);
  await runQuery(`
    UPDATE customers
    SET nama = ?, profile_completed = 1, registered_at = COALESCE(registered_at, CURRENT_TIMESTAMP), last_seen_at = CURRENT_TIMESTAMP
    WHERE nomor = ?
  `, [cleanName, nomor]);
  await addLog('CUSTOMER', `Member mendaftar: ${cleanName} (${nomor})`);
  return getCustomerMembershipProfile(nomor);
}

export async function isCustomerRegistered(nomor) {
  if (!nomor) return false;
  const row = await getQuery("SELECT profile_completed FROM customers WHERE nomor = ?", [nomor]);
  return row && Number(row.profile_completed) === 1;
}

export async function getCustomerMembershipProfile(nomor) {
  const customer = await getQuery('SELECT * FROM customers WHERE nomor = ?', [nomor]);
  if (!customer) return null;
  const [stats, gameProfile, loyalty] = await Promise.all([
    getQuery(`
      SELECT COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) AS total_orders,
             COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN total ELSE 0 END), 0) AS total_spend
      FROM orders WHERE customer_nomor = ?
    `, [nomor]),
    getQuery('SELECT * FROM game_profiles WHERE customer_jid = ?', [nomor]),
    getQuery('SELECT * FROM loyalty WHERE customer_nomor = ?', [nomor])
  ]);
  return {
    ...customer,
    role: (customer.role && customer.role !== 'null') ? customer.role : 'MEMBER',
    total_orders: stats?.total_orders || 0,
    total_spend: stats?.total_spend || 0,
    tier: calculateCustomerTier(stats?.total_orders || 0),
    game_points: gameProfile?.points || 0,
    game_xp: gameProfile?.xp || 0,
    game_level: gameProfile?.level || 1,
    game_streak: gameProfile?.daily_streak || 0,
    loyalty_points: loyalty?.points || 0
  };
}

export async function updateCustomerRole(nomor, role) {
  const normalizedRole = String(role || '').toUpperCase();
  if (!['MEMBER', 'ADMIN'].includes(normalizedRole)) {
    throw new Error('Role valid: MEMBER atau ADMIN. Role OWNER hanya diatur dari konfigurasi sistem.');
  }
  const result = await runQuery("UPDATE customers SET role = ? WHERE nomor = ?", [normalizedRole, nomor]);
  if (!result.changes) throw new Error('Member tidak ditemukan.');
  await addLog('CUSTOMER', `Role member ${nomor} diubah menjadi ${normalizedRole}`);
  return getCustomerMembershipProfile(nomor);
}

export async function updateCustomerAccountStatus(nomor, status) {
  const normalizedStatus = String(status || '').toUpperCase();
  if (!['ACTIVE', 'INACTIVE', 'BANNED'].includes(normalizedStatus)) {
    throw new Error('Status valid: ACTIVE, INACTIVE, atau BANNED.');
  }
  const result = await runQuery("UPDATE customers SET account_status = ? WHERE nomor = ?", [normalizedStatus, nomor]);
  if (!result.changes) throw new Error('Member tidak ditemukan.');
  await addLog('CUSTOMER', `Status member ${nomor} diubah menjadi ${normalizedStatus}`);
  return getCustomerMembershipProfile(nomor);
}

export async function getCustomersWithTiers() {
  const rows = await allQuery(`
    SELECT 
      c.nomor, 
      c.nama, 
      c.role,
      c.account_status,
      c.profile_completed,
      c.registered_at,
      COUNT(CASE WHEN o.status = 'COMPLETED' THEN 1 END) as total_orders,
      COALESCE(SUM(CASE WHEN o.status = 'COMPLETED' THEN o.total ELSE 0 END), 0) as total_spend
    FROM customers c
    LEFT JOIN orders o ON c.nomor = o.customer_nomor
    GROUP BY c.nomor
  `);

  return rows.map(r => {
    return {
      ...r,
      tier: calculateCustomerTier(r.total_orders || 0)
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

  const tier = calculateCustomerTier(stats.total_orders || 0);

  const orders = await allQuery("SELECT * FROM orders WHERE customer_nomor = ? ORDER BY created_at DESC", [nomor]);

  return {
    ...customer,
    total_orders: stats.total_orders,
    total_spend: stats.total_spend,
    tier,
    orders
  };
}

export async function getCustomerVoucherHistory(customerNomor) {
  const orders = await allQuery(`
    SELECT order_id, total, status, created_at 
    FROM orders 
    WHERE customer_nomor = ? AND status IN ('COMPLETED', 'PAID')
    ORDER BY created_at DESC 
    LIMIT 10
  `, [customerNomor]);

  if (!orders || orders.length === 0) return [];

  const history = [];
  for (const order of orders) {
    const items = await allQuery(`
      SELECT oi.produk_kode, oi.qty, p.nama as produk_nama, p.petunjuk 
      FROM order_items oi 
      JOIN products p ON oi.produk_kode = p.kode 
      WHERE oi.order_id = ?
    `, [order.order_id]);

    const credentials = await allQuery(`
      SELECT produk_kode, data_content, used_at 
      FROM product_items 
      WHERE order_id = ?
    `, [order.order_id]);

    history.push({
      order_id: order.order_id,
      total: order.total,
      status: order.status,
      created_at: order.created_at,
      items,
      credentials
    });
  }

  return history;
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

// --- FUNGSI PERINGATAN MODERASI (CUSTOMER WARNINGS) ---

export async function addCustomerWarning(jid, reason) {
  await runQuery(
    "INSERT INTO customer_warnings (jid, reason) VALUES (?, ?)",
    [jid, reason]
  );
  const countObj = await getQuery("SELECT COUNT(*) as count FROM customer_warnings WHERE jid = ?", [jid]);
  const total = countObj ? countObj.count : 1;
  await addLog("MODERATION", `Peringatan (${total}x) diberikan kepada ${jid}: ${reason}`);
  return total;
}

export async function getCustomerWarningsCount(jid) {
  const row = await getQuery("SELECT COUNT(*) as count FROM customer_warnings WHERE jid = ?", [jid]);
  return row ? row.count : 0;
}

export async function clearCustomerWarnings(jid) {
  await runQuery("DELETE FROM customer_warnings WHERE jid = ?", [jid]);
  await addLog("MODERATION", `Peringatan untuk ${jid} berhasil dibersihkan.`);
}

// --- FUNGSI RIWAYAT BROADCAST RESTOK ---

export async function createBroadcastHistory(productCode, totalSubscribers) {
  const res = await runQuery(
    "INSERT INTO broadcast_history (product_code, total_subscribers, success_count, failed_count, started_at) VALUES (?, ?, 0, 0, CURRENT_TIMESTAMP)",
    [productCode, totalSubscribers]
  );
  return res.lastID;
}

export async function updateBroadcastHistory(id, successCount, failedCount) {
  await runQuery(
    "UPDATE broadcast_history SET success_count = ?, failed_count = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?",
    [successCount, failedCount, id]
  );
}

export async function getBroadcastHistoryList() {
  return await allQuery("SELECT * FROM broadcast_history ORDER BY started_at DESC LIMIT 50");
}

// --- FUNGSI PENGATURAN MODERASI PER-GRUP ---

export async function getGroupSettings(jid) {
  const row = await getQuery("SELECT * FROM group_settings WHERE jid = ?", [jid]);
  if (!row) {
    const defaults = config.defaults;
    return {
      jid,
      welcome_enabled: defaults.welcomeEnabled === "true" ? 1 : 0,
      welcome_msg: defaults.welcomeMessage,
      goodbye_enabled: defaults.goodbyeEnabled === "true" ? 1 : 0,
      goodbye_msg: defaults.goodbyeMessage,
      anti_link: 0,
      bot_mode: 'all',
      auto_sholat: 1,
      levelup_enabled: 1,
      auto_dl_enabled: 1
    };
  }
  return { 
    ...row, 
    bot_mode: row.bot_mode || 'all', 
    auto_sholat: row.auto_sholat !== undefined ? row.auto_sholat : 1,
    levelup_enabled: row.levelup_enabled !== undefined ? row.levelup_enabled : 1,
    auto_dl_enabled: row.auto_dl_enabled !== undefined ? row.auto_dl_enabled : 1
  };
}

export async function updateGroupSettings(jid, settingsObj) {
  const current = await getGroupSettings(jid);
  const updated = { ...current, ...settingsObj };
  await runQuery(
    "INSERT OR REPLACE INTO group_settings (jid, welcome_enabled, welcome_msg, goodbye_enabled, goodbye_msg, anti_link, bot_mode, auto_sholat, levelup_enabled, auto_dl_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      jid, 
      updated.welcome_enabled ? 1 : 0, 
      updated.welcome_msg, 
      updated.goodbye_enabled ? 1 : 0, 
      updated.goodbye_msg, 
      updated.anti_link ? 1 : 0, 
      updated.bot_mode || 'all', 
      updated.auto_sholat !== undefined ? updated.auto_sholat : 1,
      updated.levelup_enabled !== undefined ? (updated.levelup_enabled ? 1 : 0) : 1,
      updated.auto_dl_enabled !== undefined ? (updated.auto_dl_enabled ? 1 : 0) : 1
    ]
  );
  await addLog("SYSTEM", `Pengaturan grup ${jid} diperbarui dari Web Dashboard/Bot.`);
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

// --- FUNGSI REFERRAL ---
export async function generateReferralCode(customerNomor) {
  const existing = await getQuery("SELECT referral_code FROM customers WHERE nomor = ?", [customerNomor]);
  if (existing && existing.referral_code) return existing.referral_code;
  
  const code = 'REF-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  await runQuery("UPDATE customers SET referral_code = ? WHERE nomor = ?", [code, customerNomor]);
  return code;
}

export async function getReferralByCode(code) {
  return await getQuery("SELECT * FROM customers WHERE referral_code = ?", [code.toUpperCase()]);
}

export async function addReferral(referrerNomor, referredNomor) {
  try {
    await runQuery(
      "INSERT INTO referrals (referrer_nomor, referred_nomor) VALUES (?, ?)",
      [referrerNomor, referredNomor]
    );
    await addLog("REFERRAL", `Referral: ${referredNomor} direferensikan oleh ${referrerNomor}`);
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

export async function getReferralStats(customerNomor) {
  const count = await getQuery(
    "SELECT COUNT(*) as total FROM referrals WHERE referrer_nomor = ?", [customerNomor]
  );
  const claimed = await getQuery(
    "SELECT COUNT(*) as total FROM referrals WHERE referrer_nomor = ? AND reward_claimed = 1", [customerNomor]
  );
  return { totalReferred: count?.total || 0, rewardsClaimed: claimed?.total || 0 };
}

export async function claimReferralRewardCount(referrerNomor, countToClaim) {
  const unclaimedList = await allQuery(
    "SELECT id FROM referrals WHERE referrer_nomor = ? AND reward_claimed = 0 LIMIT ?",
    [referrerNomor, countToClaim * 3]
  );
  for (const item of unclaimedList) {
    await runQuery("UPDATE referrals SET reward_claimed = 1 WHERE id = ?", [item.id]);
  }
}

// --- FUNGSI FAQ OTOMATIS ---
export async function addFaq(keywords, answer) {
  const res = await runQuery(
    "INSERT INTO faqs (keywords, answer) VALUES (?, ?)",
    [keywords.toLowerCase(), answer]
  );
  await addLog("SYSTEM", `FAQ baru ditambahkan: ${keywords}`);
  return res.lastID;
}

export async function deleteFaq(id) {
  const res = await runQuery("DELETE FROM faqs WHERE id = ?", [id]);
  return res.changes > 0;
}

export async function getAllFaqs() {
  return await allQuery("SELECT * FROM faqs ORDER BY id ASC");
}

export async function findFaqMatch(text) {
  const faqs = await allQuery("SELECT * FROM faqs");
  const textLower = text.toLowerCase();
  for (const faq of faqs) {
    const keywords = faq.keywords.split(',').map(k => k.trim());
    for (const keyword of keywords) {
      if (textLower.includes(keyword) && keyword.length >= 3) {
        return faq;
      }
    }
  }
  return null;
}

// --- FUNGSI LOYALTY POINTS ---
export async function getLoyalty(customerNomor) {
  let row = await getQuery("SELECT * FROM loyalty WHERE customer_nomor = ?", [customerNomor]);
  if (!row) {
    await runQuery("INSERT INTO loyalty (customer_nomor, points, total_spent, tier) VALUES (?, 0, 0, 'Bronze')", [customerNomor]);
    row = { customer_nomor: customerNomor, points: 0, total_spent: 0, tier: 'Bronze' };
  }
  row.points = Math.max(0, Math.floor(Number(row.points) || 0));
  row.total_spent = Math.max(0, Math.floor(Number(row.total_spent) || 0));
  return row;
}

export async function addLoyaltyPoints(customerNomor, orderTotal) {
  const pointsEarned = Math.floor(orderTotal / 10000);
  await getLoyalty(customerNomor);
  await runQuery(
    "UPDATE loyalty SET points = COALESCE(points, 0) + ?, total_spent = COALESCE(total_spent, 0) + ? WHERE customer_nomor = ?",
    [pointsEarned, orderTotal, customerNomor]
  );
  
  // Update tier
  const updated = await getLoyalty(customerNomor);
  let newTier = 'Bronze';
  if (updated.points >= 151) newTier = 'Gold';
  else if (updated.points >= 51) newTier = 'Silver';
  
  if (newTier !== updated.tier) {
    await runQuery("UPDATE loyalty SET tier = ? WHERE customer_nomor = ?", [newTier, customerNomor]);
  }
  
  return { pointsEarned, totalPoints: updated.points, tier: newTier };
}

export async function redeemLoyaltyPoints(customerNomor, pointsToRedeem) {
  const loyalty = await getLoyalty(customerNomor);
  if (loyalty.points < pointsToRedeem) {
    return { success: false, message: `Poin tidak cukup. Saldo poin Anda: ${loyalty.points}` };
  }
  await runQuery(
    "UPDATE loyalty SET points = MAX(0, COALESCE(points, 0) - ?) WHERE customer_nomor = ?",
    [pointsToRedeem, customerNomor]
  );
  const discountValue = pointsToRedeem * 500; // 1 poin = Rp500
  return { success: true, discount: discountValue, remainingPoints: Math.max(0, loyalty.points - pointsToRedeem) };
}

// --- FUNGSI GAME, XP, DAN REWARD HARIAN ---
const MAX_POINTS = 1_000_000; // Hard cap untuk mencegah nilai gila

export async function getGameProfile(customerJid) {
  await runQuery(
    "INSERT OR IGNORE INTO game_profiles (customer_jid, points, bank_points, xp, level, games_played, games_won, daily_streak) VALUES (?, 0, 0, 0, 1, 0, 0, 0)",
    [customerJid]
  );
  let profile = await getQuery("SELECT * FROM game_profiles WHERE customer_jid = ?", [customerJid]);
  if (!profile) {
    profile = { customer_jid: customerJid, points: 0, bank_points: 0, xp: 0, level: 1, games_played: 0, games_won: 0, daily_streak: 0 };
  }

  const rawPoints = Number(profile.points);
  const rawBank = Number(profile.bank_points);
  const safePoints = (!isFinite(rawPoints) || isNaN(rawPoints)) ? 0 : Math.max(0, Math.min(MAX_POINTS, Math.floor(rawPoints)));
  const safeBank = (!isFinite(rawBank) || isNaN(rawBank)) ? 0 : Math.max(0, Math.min(MAX_POINTS, Math.floor(rawBank)));
  const safeXp = Math.max(0, Math.floor(Number(profile.xp) || 0));
  const safeLevel = Math.max(1, Math.floor(Number(profile.level) || 1));
  const safePlayed = Math.max(0, Math.floor(Number(profile.games_played) || 0));
  const safeWon = Math.max(0, Math.floor(Number(profile.games_won) || 0));
  const safeStreak = Math.max(0, Math.floor(Number(profile.daily_streak) || 0));

  // Auto-heal DB jika ada data NULL/NaN/tak terbatas
  if (profile.points !== safePoints || profile.bank_points !== safeBank || profile.xp !== safeXp || profile.level !== safeLevel || 
      profile.games_played !== safePlayed || profile.games_won !== safeWon || profile.daily_streak !== safeStreak) {
    await runQuery(
      `UPDATE game_profiles SET points = ?, bank_points = ?, xp = ?, level = ?, games_played = ?, games_won = ?, daily_streak = ? WHERE customer_jid = ?`,
      [safePoints, safeBank, safeXp, safeLevel, safePlayed, safeWon, safeStreak, customerJid]
    );
    profile.points = safePoints;
    profile.bank_points = safeBank;
    profile.xp = safeXp;
    profile.level = safeLevel;
    profile.games_played = safePlayed;
    profile.games_won = safeWon;
    profile.daily_streak = safeStreak;
  }

  return profile;
}

export async function updateGameProfile(customerJid, data = {}) {
  await getGameProfile(customerJid);
  if (data.points !== undefined && data.points !== null) {
    const rawVal = Number(data.points);
    if (!isNaN(rawVal) && isFinite(rawVal)) {
      const safePoints = Math.max(0, Math.min(MAX_POINTS, Math.floor(rawVal)));
      await runQuery(
        "UPDATE game_profiles SET points = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_jid = ?",
        [safePoints, customerJid]
      );
    } else {
      console.warn(`[POINTS PROTECTION] Blocked invalid points update (${data.points}) for ${customerJid}`);
    }
  }
  if (data.xp !== undefined && data.xp !== null) {
    const rawVal = Number(data.xp);
    if (!isNaN(rawVal) && isFinite(rawVal)) {
      const safeXp = Math.max(0, Math.floor(rawVal));
      await runQuery(
        "UPDATE game_profiles SET xp = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_jid = ?",
        [safeXp, customerJid]
      );
    }
  }
  return await getGameProfile(customerJid);
}

export async function updateLastRobTime(customerJid) {
  await runQuery("UPDATE game_profiles SET last_rob_time = CURRENT_TIMESTAMP WHERE customer_jid = ?", [customerJid]);
}

export async function updateLastRobbedAt(customerJid) {
  await runQuery("UPDATE game_profiles SET last_robbed_at = CURRENT_TIMESTAMP WHERE customer_jid = ?", [customerJid]);
}

export async function bankDeposit(customerJid, amount) {
  const safeAmount = Math.max(0, Math.floor(Number(amount)));
  if (safeAmount <= 0) return { success: false, reason: 'INVALID_AMOUNT' };
  
  const result = await dbAction(async (db) => {
    return new Promise((resolve, reject) => {
      db.run("BEGIN TRANSACTION", (err) => { if (err) reject(err); });
      db.run(`UPDATE game_profiles SET points = points - ?, bank_points = COALESCE(bank_points, 0) + ? WHERE customer_jid = ? AND points >= ?`, 
        [safeAmount, safeAmount, customerJid, safeAmount], 
        function (err) {
          if (err) { db.run("ROLLBACK"); return reject(err); }
          if (this.changes === 0) {
            db.run("ROLLBACK");
            return resolve({ success: false, reason: 'INSUFFICIENT_FUNDS' });
          }
          db.run("COMMIT", (err) => { if (err) reject(err); else resolve({ success: true }); });
      });
    });
  });
  return result;
}

export async function bankWithdraw(customerJid, amount, taxRate = 0.02) {
  const safeAmount = Math.max(0, Math.floor(Number(amount)));
  if (safeAmount <= 0) return { success: false, reason: 'INVALID_AMOUNT' };
  
  const receivedAmount = Math.floor(safeAmount * (1 - taxRate));
  
  const result = await dbAction(async (db) => {
    return new Promise((resolve, reject) => {
      db.run("BEGIN TRANSACTION", (err) => { if (err) reject(err); });
      db.run(`UPDATE game_profiles SET bank_points = bank_points - ?, points = COALESCE(points, 0) + ? WHERE customer_jid = ? AND bank_points >= ?`, 
        [safeAmount, receivedAmount, customerJid, safeAmount], 
        function (err) {
          if (err) { db.run("ROLLBACK"); return reject(err); }
          if (this.changes === 0) {
            db.run("ROLLBACK");
            return resolve({ success: false, reason: 'INSUFFICIENT_FUNDS' });
          }
          db.run("COMMIT", (err) => { if (err) reject(err); else resolve({ success: true, received: receivedAmount }); });
      });
    });
  });
  return result;
}

export async function transferPoints(senderJid, targetJid, amount, taxRate = 0.01) {
  const safeAmount = Math.max(0, Math.floor(Number(amount)));
  if (safeAmount <= 0) return { success: false, reason: 'INVALID_AMOUNT' };
  
  const receivedAmount = Math.floor(safeAmount * (1 - taxRate));
  
  await getGameProfile(senderJid);
  await getGameProfile(targetJid);

  const result = await dbAction(async (db) => {
    return new Promise((resolve, reject) => {
      db.run("BEGIN TRANSACTION", (err) => { if (err) reject(err); });
      
      db.run(`UPDATE game_profiles SET points = points - ? WHERE customer_jid = ? AND points >= ?`, 
        [safeAmount, senderJid, safeAmount], 
        function (err) {
          if (err) { db.run("ROLLBACK"); return reject(err); }
          if (this.changes === 0) {
            db.run("ROLLBACK");
            return resolve({ success: false, reason: 'INSUFFICIENT_FUNDS' });
          }
          
          db.run(`UPDATE game_profiles SET points = COALESCE(points, 0) + ? WHERE customer_jid = ?`, 
            [receivedAmount, targetJid], 
            function (err2) {
              if (err2) { db.run("ROLLBACK"); return reject(err2); }
              db.run("COMMIT", (err3) => { if (err3) reject(err3); else resolve({ success: true, received: receivedAmount }); });
          });
      });
    });
  });
  return result;
}


/**
 * Add points atomically to game_profile using a SQLite transaction.
 */
export async function addGamePoints(customerJid, amount) {
  const safeAmount = Math.floor(Number(amount));
  if (isNaN(safeAmount) || !isFinite(safeAmount) || safeAmount <= 0) {
    return await getGameProfile(customerJid);
  }
  return withTransaction(async () => {
    await getGameProfile(customerJid);
    await runQuery(
      `UPDATE game_profiles
       SET points = MIN(${MAX_POINTS}, COALESCE(points, 0) + ?), updated_at = CURRENT_TIMESTAMP
       WHERE customer_jid = ?`,
      [safeAmount, customerJid]
    );
    return await getGameProfile(customerJid);
  });
}

/**
 * Deduct points atomically from game_profile using a SQLite transaction.
 */
export async function deductGamePoints(customerJid, amount) {
  const safeAmount = Math.floor(Number(amount));
  if (isNaN(safeAmount) || !isFinite(safeAmount) || safeAmount <= 0) {
    return { success: false, reason: 'INVALID_AMOUNT' };
  }
  return withTransaction(async () => {
    // Attempt the atomic update directly first
    const updateResult = await runQuery(
      `UPDATE game_profiles
       SET points = points - ?, updated_at = CURRENT_TIMESTAMP
       WHERE customer_jid = ? AND points >= ?`,
      [safeAmount, customerJid, safeAmount]
    );

    const profile = await getGameProfile(customerJid);
    
    // If no rows were changed, either the profile didn't exist or points < safeAmount
    if (updateResult.changes === 0) {
      return { success: false, reason: 'INSUFFICIENT_POINTS', currentPoints: profile.points || 0 };
    }

    return { success: true, newPoints: profile.points, profile: profile };
  });
}

export async function awardGamePoints(customerJid, points, won = false) {
  const rawPts = Number.parseInt(points, 10);
  const safePoints = (!isFinite(rawPts) || isNaN(rawPts)) ? 0 : Math.max(0, Math.min(1000, rawPts));
  return withTransaction(async () => {
    await getGameProfile(customerJid);
    await runQuery(
      `UPDATE game_profiles
       SET points = COALESCE(points, 0) + ?, xp = COALESCE(xp, 0) + ?, games_played = COALESCE(games_played, 0) + 1,
           games_won = COALESCE(games_won, 0) + ?, updated_at = CURRENT_TIMESTAMP
       WHERE customer_jid = ?`,
      [safePoints, safePoints, won ? 1 : 0, customerJid]
    );
    const profile = await getGameProfile(customerJid);
    const level = Math.floor(profile.xp / 100) + 1;
    if (level !== profile.level) {
      await runQuery("UPDATE game_profiles SET level = ? WHERE customer_jid = ?", [level, customerJid]);
      profile.level = level;
    }
    return { ...profile, earned: safePoints };
  });
}

export async function claimGameDaily(customerJid, today, reward = 25) {
  return withTransaction(async () => {
    const profile = await getGameProfile(customerJid);
    if (profile.daily_claimed_at === today) {
      return { success: false, message: 'Hadiah harian sudah diklaim hari ini.', profile };
    }
    const yesterday = new Date(`${today}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const streak = profile.daily_claimed_at === yesterday.toISOString().slice(0, 10)
      ? Number(profile.daily_streak || 0) + 1
      : 1;
    const streakBonus = Math.min(50, Math.max(0, streak - 1) * 5);
    const safeReward = (!isFinite(Number(reward)) || isNaN(Number(reward))) ? 25 : Math.max(0, Math.floor(Number(reward)));
      const totalReward = safeReward + streakBonus;
    await runQuery(
      `UPDATE game_profiles
       SET points = COALESCE(points, 0) + ?, xp = COALESCE(xp, 0) + ?, daily_claimed_at = ?, daily_streak = ?, updated_at = CURRENT_TIMESTAMP
       WHERE customer_jid = ?`,
      [totalReward, totalReward, today, streak, customerJid]
    );
    const updated = await getGameProfile(customerJid);
    const level = Math.floor(updated.xp / 100) + 1;
    await runQuery("UPDATE game_profiles SET level = ? WHERE customer_jid = ?", [level, customerJid]);
    updated.level = level;
    return { success: true, reward: totalReward, streak, profile: updated };
  });
}


export async function getGameLeaderboard(limit = 10) {
  const safeLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
  return await allQuery(
    `SELECT g.customer_jid, COALESCE(g.points, 0) AS points, COALESCE(g.level, 1) AS level, COALESCE(g.games_won, 0) AS games_won, COALESCE(g.games_played, 0) AS games_played,
            COALESCE(c.nama, 'Member') AS customer_nama
     FROM game_profiles g
     INNER JOIN customers c ON c.nomor = g.customer_jid
     WHERE c.profile_completed = 1
     ORDER BY COALESCE(g.points, 0) DESC, COALESCE(g.level, 1) DESC, COALESCE(g.games_won, 0) DESC
     LIMIT ?`,
    [safeLimit]
  );
}

export async function resetGameLeaderboard() {
  // 1. Hapus profile game dari user yang belum mendaftar (.daftar)
  await runQuery(`
    DELETE FROM game_profiles
    WHERE customer_jid NOT IN (
      SELECT nomor FROM customers WHERE profile_completed = 1
    )
  `);

  // 2. Reset semua poin, XP, level, dan streak untuk member terdaftar
  const result = await runQuery(`
    UPDATE game_profiles
    SET points = 0, xp = 0, level = 1, games_played = 0, games_won = 0,
        daily_streak = 0, daily_claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
  `);

  await addLog("ADMIN", `Leaderboard game di-reset bersih (${result.changes} member di-reset).`);
  return { success: true, resetCount: result.changes };
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
     FROM orders WHERE status = 'COMPLETED' AND DATE(created_at) = ?`, [dateStr]
  );
  const topProducts = await allQuery(
    `SELECT oi.produk_kode, p.nama, SUM(oi.qty) as total_qty, SUM(oi.subtotal) as total_sales
     FROM order_items oi
     JOIN orders o ON oi.order_id = o.order_id
     JOIN products p ON oi.produk_kode = p.kode
     WHERE o.status = 'COMPLETED' AND DATE(o.created_at) = ?
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

// --- FUNGSI SALDO & DEPOSIT ---
export async function getCustomerBalance(customerNomor) {
  const row = await getQuery("SELECT balance FROM customers WHERE nomor = ?", [customerNomor]);
  return row ? (row.balance || 0) : 0;
}



// --- FUNGSI REFERRAL ---
export async function getOrCreateReferralCode(customerNomor, name = 'Pelanggan') {
  let customer = await getQuery("SELECT referral_code FROM customers WHERE nomor = ?", [customerNomor]);
  if (customer && customer.referral_code) {
    return customer.referral_code;
  }
  const cleanName = (name || 'USER').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 5) || 'USER';
  const randNum = Math.floor(100 + Math.random() * 900);
  const refCode = `REF-${cleanName}${randNum}`;
  await runQuery("UPDATE customers SET referral_code = ? WHERE nomor = ?", [refCode, customerNomor]);
  return refCode;
}

export async function getCustomerByReferral(code) {
  return await getQuery("SELECT * FROM customers WHERE UPPER(referral_code) = UPPER(?)", [(code || '').trim()]);
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
  return await getQuery("SELECT * FROM customers WHERE nomor = ?", [nomor]);
}

// --- FUNGSI ANALITIK LANJUTAN ---

/**
 * Data pendapatan per hari untuk grafik timeline
 * @param {number} days - Jumlah hari terakhir (default: 30)
 */
export async function getDailySalesTimeline(days = 30) {
  return await allQuery(`
    SELECT 
      date(created_at) as date, 
      SUM(total) as revenue,
      COUNT(*) as order_count
    FROM orders
    WHERE status = 'COMPLETED' 
      AND date(created_at) >= date('now', '-' || ? || ' days')
    GROUP BY date(created_at)
    ORDER BY date ASC
  `, [days]);
}

/**
 * Top produk berdasarkan qty terjual dan revenue
 * @param {number} limit
 */
export async function getTopProducts(limit = 10) {
  return await allQuery(`
    SELECT 
      p.kode,
      p.nama,
      SUM(oi.qty) as total_qty,
      SUM(oi.subtotal) as total_revenue,
      COUNT(DISTINCT oi.order_id) as order_count
    FROM order_items oi
    JOIN products p ON oi.produk_kode = p.kode
    JOIN orders o ON oi.order_id = o.order_id
    WHERE o.status = 'COMPLETED'
    GROUP BY p.kode
    ORDER BY total_revenue DESC
    LIMIT ?
  `, [limit]);
}

/**
 * Top pelanggan berdasarkan total belanja
 * @param {number} limit
 */
export async function getTopCustomers(limit = 10) {
  return await allQuery(`
    SELECT 
      c.nomor,
      c.nama,
      COUNT(o.order_id) as total_orders,
      SUM(o.total) as total_spent,
      MAX(o.created_at) as last_order_at
    FROM customers c
    JOIN orders o ON c.nomor = o.customer_nomor
    WHERE o.status = 'COMPLETED'
    GROUP BY c.nomor
    ORDER BY total_spent DESC
    LIMIT ?
  `, [limit]);
}

/**
 * KPI summary untuk analytics dashboard
 */
export async function getAnalyticsSummary() {
  const [omzetBulanIni, omzetBulanLalu, avgOrder, repeatBuyers, totalCompleted, totalCustomers] = await Promise.all([
    getQuery(`SELECT COALESCE(SUM(total), 0) as val FROM orders WHERE status='COMPLETED' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`),
    getQuery(`SELECT COALESCE(SUM(total), 0) as val FROM orders WHERE status='COMPLETED' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', date('now', '-1 month'))`),
    getQuery(`SELECT COALESCE(AVG(total), 0) as val FROM orders WHERE status='COMPLETED'`),
    getQuery(`SELECT COUNT(*) as val FROM (SELECT customer_nomor FROM orders WHERE status='COMPLETED' GROUP BY customer_nomor HAVING COUNT(*) > 1)`),
    getQuery(`SELECT COUNT(*) as val FROM orders WHERE status='COMPLETED'`),
    getQuery(`SELECT COUNT(*) as val FROM customers`),
  ]);

  const omzetIni = omzetBulanIni.val || 0;
  const omzetLalu = omzetBulanLalu.val || 0;
  const growthPct = omzetLalu > 0 ? ((omzetIni - omzetLalu) / omzetLalu * 100).toFixed(1) : null;

  return {
    omzetBulanIni: omzetIni,
    omzetBulanLalu: omzetLalu,
    growthPct,
    avgOrderValue: Math.round(avgOrder.val || 0),
    repeatBuyers: repeatBuyers.val || 0,
    totalCompleted: totalCompleted.val || 0,
    totalCustomers: totalCustomers.val || 0,
    repeatRate: totalCustomers.val > 0 ? ((repeatBuyers.val / totalCustomers.val) * 100).toFixed(1) : '0.0',
  };
}

/**
 * Data heatmap per hari dalam sebulan
 * @param {number} year
 * @param {number} month (1-12)
 */
export async function getSalesHeatmap(year, month) {
  const paddedMonth = String(month).padStart(2, '0');
  return await allQuery(`
    SELECT 
      date(created_at) as date,
      COUNT(*) as order_count,
      COALESCE(SUM(total), 0) as revenue
    FROM orders
    WHERE status = 'COMPLETED'
      AND strftime('%Y', created_at) = ?
      AND strftime('%m', created_at) = ?
    GROUP BY date(created_at)
    ORDER BY date ASC
  `, [String(year), paddedMonth]);
}

/**
 * Fitur Ban / Unban User
 */
export async function banUser(jid, reason = '', bannedBy = 'system', expiresAt = null) {
  if (!jid) return false;
  const clean = jid.trim();
  await runQuery(
    `INSERT OR REPLACE INTO banned_users (jid, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)`,
    [clean, reason, bannedBy, expiresAt]
  );
  return true;
}

export async function unbanUser(jid) {
  if (!jid) return false;
  const clean = jid.trim();
  const digits = clean.replace(/[^0-9]/g, '');
  await runQuery(
    `DELETE FROM banned_users WHERE jid = ? OR (length(?) > 6 AND jid LIKE '%' || ? || '%')`,
    [clean, digits, digits]
  );
  return true;
}

export async function isUserBanned(jid) {
  if (!jid) return false;
  const clean = jid.trim();
  const digits = clean.replace(/[^0-9]/g, '');
  const row = await getQuery(
    `SELECT * FROM banned_users WHERE jid = ? OR (length(?) > 6 AND jid LIKE '%' || ? || '%')`,
    [clean, digits, digits]
  );
  if (!row) return false;

  // Hapus otomatis jika ban sudah kedaluwarsa
  if (row.expires_at) {
    const expiresAt = Number(row.expires_at);
    if (Date.now() > expiresAt) {
      await runQuery(`DELETE FROM banned_users WHERE jid = ?`, [row.jid]);
      return false;
    }
  }
  return true;
}

/**
 * Moderator System — User yang diberi izin Owner untuk pakai .ban/.unban
 */
export async function addModerator(jid, addedBy = 'owner') {
  if (!jid) return false;
  await runQuery(
    `INSERT OR REPLACE INTO moderators (jid, added_by) VALUES (?, ?)`,
    [jid.trim(), addedBy]
  );
  return true;
}

export async function removeModerator(jid) {
  if (!jid) return false;
  const clean = jid.trim();
  const digits = clean.replace(/[^0-9]/g, '');
  await runQuery(
    `DELETE FROM moderators WHERE jid = ? OR (length(?) > 6 AND jid LIKE '%' || ? || '%')`,
    [clean, digits, digits]
  );
  return true;
}

export async function isModerator(jid) {
  if (!jid) return false;
  const clean = jid.trim();
  const digits = clean.replace(/[^0-9]/g, '');
  const row = await getQuery(
    `SELECT * FROM moderators WHERE jid = ? OR (length(?) > 6 AND jid LIKE '%' || ? || '%')`,
    [clean, digits, digits]
  );
  return row ? true : false;
}

export async function listModerators() {
  return await allQuery(`SELECT jid, added_by, created_at FROM moderators ORDER BY created_at ASC`);
}

// Memperbarui status terakhir (harga & stok) sebuah produk untuk notifikasi
export async function updateProductLastState(kode, lastPrice, lastStockStatus) {
  return await runQuery(
    `UPDATE products SET last_price = ?, last_stock_status = ? WHERE kode = ?`,
    [lastPrice, lastStockStatus, kode]
  );
}

// ============================================================
// --- FUNGSI PREMIUM USERS ---
// ============================================================

export async function getPremiumUser(jid) {
  const row = await getQuery(
    "SELECT * FROM premium_users WHERE jid = ? AND expires_at > datetime('now')",
    [jid]
  );
  return row || null;
}

export async function getPremiumTier(jid) {
  const premium = await getPremiumUser(jid);
  return premium ? premium.tier : 'Free';
}

export async function grantPremium(jid, tier, days, activatedBy = 'ADMIN') {
  const validTiers = ['Silver', 'Gold', 'Diamond'];
  if (!validTiers.includes(tier)) throw new Error(`Tier tidak valid: ${tier}`);
  const safeDays = Math.max(1, Math.min(365, Number.parseInt(days, 10) || 30));

  // Cek apakah sudah premium, extend dari waktu expire
  const existing = await getQuery("SELECT expires_at FROM premium_users WHERE jid = ?", [jid]);
  let newExpiry;
  if (existing && new Date(existing.expires_at) > new Date()) {
    newExpiry = new Date(existing.expires_at);
    newExpiry.setDate(newExpiry.getDate() + safeDays);
  } else {
    newExpiry = new Date();
    newExpiry.setDate(newExpiry.getDate() + safeDays);
  }

  await runQuery(
    `INSERT INTO premium_users (jid, tier, expires_at, activated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET tier = ?, expires_at = ?, activated_by = ?, activated_at = CURRENT_TIMESTAMP`,
    [jid, tier, newExpiry.toISOString(), activatedBy, tier, newExpiry.toISOString(), activatedBy]
  );
  return { tier, expiresAt: newExpiry, days: safeDays };
}

export async function revokePremium(jid) {
  const result = await runQuery("DELETE FROM premium_users WHERE jid = ?", [jid]);
  return result.changes > 0;
}

export async function listPremiumUsers() {
  return await allQuery(
    `SELECT p.jid, p.tier, p.expires_at, p.activated_at, p.activated_by,
            COALESCE(c.nama, 'Member') AS nama
     FROM premium_users p
     LEFT JOIN customers c ON c.nomor = p.jid
     WHERE p.expires_at > datetime('now')
     ORDER BY p.tier DESC, p.expires_at ASC`
  );
}

export async function logPremiumBenefit(jid, benefitType, value) {
  await runQuery(
    "INSERT INTO premium_benefits_log (jid, benefit_type, value) VALUES (?, ?, ?)",
    [jid, benefitType, String(value || '')]
  );
}

export async function cleanExpiredPremium() {
  const result = await runQuery(
    "DELETE FROM premium_users WHERE expires_at <= datetime('now')"
  );
  return result.changes;
}

// ============================================================
// --- FUNGSI MULTIPLAYER SUIT CHALLENGE ---
// ============================================================

export async function createSuitChallenge(challengerJid, challengedJid, groupJid, bet) {
  const safeBet = Math.max(0, Math.floor(Number(bet) || 0));
  return withTransaction(async () => {
    // Kurangi poin penantang
    await getGameProfile(challengerJid);
    await runQuery(
      "UPDATE game_profiles SET points = MAX(0, COALESCE(points, 0) - ?), updated_at = CURRENT_TIMESTAMP WHERE customer_jid = ?",
      [safeBet, challengerJid]
    );

    // Buat data tantangan
    const res = await runQuery(
      `INSERT INTO suit_challenges (challenger_jid, challenged_jid, group_jid, bet, status)
       VALUES (?, ?, ?, ?, 'PENDING')`,
      [challengerJid, challengedJid, groupJid, safeBet]
    );
    return res.lastID;
  });
}

export async function getSuitChallengeById(challengeId) {
  return await getQuery("SELECT * FROM suit_challenges WHERE id = ?", [challengeId]);
}

export async function getPendingSuitChallenge(userJid) {
  // Mencari tantangan aktif di mana pengguna terlibat dan belum menentukan pilihan
  return await getQuery(
    `SELECT * FROM suit_challenges 
     WHERE status = 'PENDING' 
       AND (
         (challenger_jid = ? AND challenger_choice IS NULL) OR 
         (challenged_jid = ? AND challenged_choice IS NULL)
       )
     ORDER BY created_at DESC LIMIT 1`,
    [userJid, userJid]
  );
}

export async function saveSuitChoice(challengeId, userJid, choice) {
  const challenge = await getSuitChallengeById(challengeId);
  if (!challenge || challenge.status !== 'PENDING') return false;

  if (challenge.challenger_jid === userJid) {
    await runQuery("UPDATE suit_challenges SET challenger_choice = ? WHERE id = ?", [choice, challengeId]);
  } else if (challenge.challenged_jid === userJid) {
    // Kurangi poin penantang yang ditantang saat mengirim pilihan pertama kali (sebagai tanda menyetujui taruhan)
    if (challenge.challenged_choice === null) {
      const safeBet = Math.max(0, Math.floor(Number(challenge.bet) || 0));
      await runQuery(
        "UPDATE game_profiles SET points = MAX(0, COALESCE(points, 0) - ?), updated_at = CURRENT_TIMESTAMP WHERE customer_jid = ?",
        [safeBet, userJid]
      );
    }
    await runQuery("UPDATE suit_challenges SET challenged_choice = ? WHERE id = ?", [choice, challengeId]);
  } else {
    return false;
  }
  return await getSuitChallengeById(challengeId);
}

export async function completeSuitChallenge(challengeId, status) {
  await runQuery("UPDATE suit_challenges SET status = ? WHERE id = ?", [status, challengeId]);
}

export async function refundSuitChallenge(challengeId, refundChallenger = true, refundChallenged = true) {
  const challenge = await getSuitChallengeById(challengeId);
  if (!challenge) return;

  await withTransaction(async () => {
    const safeBet = Math.max(0, Math.floor(Number(challenge.bet) || 0));
    if (refundChallenger) {
      await runQuery(
        "UPDATE game_profiles SET points = COALESCE(points, 0) + ?, updated_at = CURRENT_TIMESTAMP WHERE customer_jid = ?",
        [safeBet, challenge.challenger_jid]
      );
    }
    if (refundChallenged && challenge.challenged_choice !== null) {
      await runQuery(
        "UPDATE game_profiles SET points = COALESCE(points, 0) + ?, updated_at = CURRENT_TIMESTAMP WHERE customer_jid = ?",
        [safeBet, challenge.challenged_jid]
      );
    }
    await runQuery("UPDATE suit_challenges SET status = 'REFUNDED' WHERE id = ?", [challengeId]);
  });
}

// --- AFK MANAGEMENT SYSTEM ---
export async function setAfk(jid, reason = 'Tanpa alasan') {
  const time = Date.now();
  await runQuery(
    "INSERT OR REPLACE INTO afk_users (jid, reason, time) VALUES (?, ?, ?)",
    [jid, reason, time]
  );
  return { jid, reason, time };
}

export async function getAfk(jid) {
  return await getQuery("SELECT * FROM afk_users WHERE jid = ?", [jid]);
}

export async function removeAfk(jid) {
  const afk = await getAfk(jid);
  if (afk) {
    await runQuery("DELETE FROM afk_users WHERE jid = ?", [jid]);
  }
  return afk;
}

// Memory Cooldown Map untuk Chat XP (+10 XP max per 30 detik per user)
const xpCooldowns = new Map();

/**
 * Mendapatkan gelar rank berdasarkan level
 */
export function getRankBadgeTitle(level) {
  if (level >= 50) return 'Sultan Legendaris 👑';
  if (level >= 30) return 'Penguasa Grup ⚔️';
  if (level >= 20) return 'Sepuh Kasepuhan 💎';
  if (level >= 15) return 'Bintang Grup 🌟';
  if (level >= 10) return 'Member Elit 🥇';
  if (level >= 5) return 'Member Aktif 🥈';
  return 'Warga Baru 🥉';
}

/**
 * Menambahkan XP per pesan di grup & mengecek peningkatan level
 */
export async function addMessageXp(customerJid, xpAmount = 10) {
  const now = Date.now();
  const lastXpTime = xpCooldowns.get(customerJid) || 0;
  if (now - lastXpTime < 30000) {
    return { leveledUp: false };
  }
  xpCooldowns.set(customerJid, now);

  const profile = await getGameProfile(customerJid);
  const oldXp = profile.xp || 0;
  const oldLevel = profile.level || 1;
  const newXp = oldXp + xpAmount;
  const newLevel = Math.floor(newXp / 100) + 1;

  await runQuery(
    "UPDATE game_profiles SET xp = ?, level = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_jid = ?",
    [newXp, newLevel, customerJid]
  );

  const titleBadge = getRankBadgeTitle(newLevel);
  const leveledUp = newLevel > oldLevel;

  return {
    leveledUp,
    oldLevel,
    newLevel,
    titleBadge,
    xp: newXp,
    profile: { ...profile, xp: newXp, level: newLevel }
  };
}

// ============================================================
// CASAKU PAYMENT SYSTEM HELPER FUNCTIONS
// ============================================================

/**
 * Get the most recent order (WAITING_PAYMENT or CART) for a customer including items.
 */
export async function getLastOrderByCustomer(customerNomor) {
  const order = await getQuery(
    `SELECT o.*, c.nama as customer_nama
     FROM orders o
     JOIN customers c ON o.customer_nomor = c.nomor
     WHERE o.customer_nomor = ? AND o.status IN ('WAITING_PAYMENT', 'CART')
     ORDER BY o.created_at DESC LIMIT 1`,
    [customerNomor]
  );
  if (!order) return null;
  const items = await allQuery(
    `SELECT oi.*, p.nama as produk_nama, p.delivery_type
     FROM order_items oi
     JOIN products p ON oi.produk_kode = p.kode
     WHERE oi.order_id = ?`,
    [order.order_id]
  );
  return { ...order, items };
}

/**
 * Create a Casaku payment transaction record after generating a QRIS.
 * @param {string} orderId
 * @param {string} casakuTransactionId - provider_transaction_id from Casaku
 * @param {number} expectedAmount - total + unique code
 * @param {number} expiryMinutes
 */
export async function createCasakuTransaction(orderId, casakuTransactionId, expectedAmount, expiryMinutes = 15) {
  const now = Date.now();
  const expiredAt = now + expiryMinutes * 60 * 1000;
  const txId = `PT-${orderId}-${now}`;

  await withTransaction(async () => {
    await runQuery(
      `INSERT INTO payment_transactions (id, order_id, provider, provider_transaction_id, expected_amount, status, created_at)
       VALUES (?, ?, 'casaku', ?, ?, 'PENDING', ?)`,
      [txId, orderId, casakuTransactionId, expectedAmount, now]
    );
    await runQuery(
      `UPDATE orders SET payment_amount = ?, payment_status = 'PENDING', casaku_transaction_id = ?, expired_at = ?, status = 'WAITING_PAYMENT' WHERE order_id = ?`,
      [expectedAmount, casakuTransactionId, expiredAt, orderId]
    );
  });

  return { txId, expiredAt };
}

/**
 * Atomically mark an order as PAID. Returns true only if the order was transitioned
 * from PENDING to PAID (i.e. not already processed). Ensures idempotency.
 * @param {string} casakuTransactionId
 * @param {number} receivedAmount
 * @returns {{ success: boolean, orderId: string|null, customerNumber: string|null }}
 */
export async function markTransactionPaid(casakuTransactionId, receivedAmount) {
  return withTransaction(async () => {
    const tx = await getQuery(
      `SELECT pt.*, o.customer_nomor, o.payment_status, o.expected_amount
       FROM payment_transactions pt
       JOIN orders o ON pt.order_id = o.order_id
       WHERE pt.provider_transaction_id = ? AND pt.provider = 'casaku'`,
      [casakuTransactionId]
    );

    if (!tx) return { success: false, reason: 'TRANSACTION_NOT_FOUND', orderId: null, customerNumber: null };
    if (tx.status === 'PAID') return { success: false, reason: 'ALREADY_PAID', orderId: tx.order_id, customerNumber: tx.customer_nomor };
    if (tx.expected_amount !== receivedAmount) return { success: false, reason: 'AMOUNT_MISMATCH', orderId: tx.order_id, customerNumber: tx.customer_nomor, expected: tx.expected_amount, received: receivedAmount };

    const now = Date.now();
    // Atomic PENDING → PAID using WHERE guard
    const result = await runQuery(
      `UPDATE orders SET payment_status = 'PAID', status = 'COMPLETED', updated_at = ? WHERE order_id = ? AND payment_status = 'PENDING'`,
      [now, tx.order_id]
    );

    if (result.changes === 0) return { success: false, reason: 'ALREADY_PAID', orderId: tx.order_id, customerNumber: tx.customer_nomor };

    await runQuery(
      `UPDATE payment_transactions SET status = 'PAID', received_amount = ?, paid_at = ? WHERE id = ?`,
      [receivedAmount, now, tx.id]
    );

    // Top-up deposit handling: credit customer balance
    if (tx.order_id.startsWith('DEP-')) {
      await addCustomerBalance(tx.customer_nomor, tx.expected_amount, 'DEPOSIT', `Top-up deposit via QRIS #${tx.order_id}`);
      await addLog('BALANCE', `💰 Auto-deposit Rp${tx.expected_amount.toLocaleString('id-ID')} berhasil via Casaku QRIS untuk ${tx.customer_nomor}`);
    } else {
      // Award 10 Poin per Rp10.000 spent for real product purchases
      const pointsAwarded = Math.floor(receivedAmount / 10000) * 10;
      if (pointsAwarded > 0) {
        await runQuery(
          `INSERT INTO game_profiles (customer_jid, points, xp) VALUES (?, ?, ?)
           ON CONFLICT(customer_jid) DO UPDATE SET points = points + ?, xp = xp + ?`,
          [tx.customer_nomor, pointsAwarded, pointsAwarded, pointsAwarded, pointsAwarded]
        );
        await runQuery(
          `INSERT INTO point_logs (customer_nomor, type, points, description) VALUES (?, 'EARN_PURCHASE', ?, ?)`,
          [tx.customer_nomor, pointsAwarded, `Poin dari belanja QRIS Order #${tx.order_id}`]
        );
      }
      // Unlock referral reward (50 Poin) if this is customer's first purchase >= Rp10.000
      try {
        await verifyAndRewardReferral(tx.customer_nomor, receivedAmount);
      } catch (refErr) {}
    }

    return { success: true, reason: 'PAID', orderId: tx.order_id, customerNumber: tx.customer_nomor, isDeposit: tx.order_id.startsWith('DEP-') };
  });
}



/**
 * Create a fulfillment job after payment is confirmed.
 */
export async function createFulfillmentJob(orderId, customerNumber) {
  const now = Date.now();
  const jobId = `FJ-${orderId}-${now}`;
  await runQuery(
    `INSERT OR IGNORE INTO fulfillment_jobs (job_id, order_id, customer_number, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'PENDING', 0, ?, ?)`,
    [jobId, orderId, customerNumber, now, now]
  );
  return jobId;
}

/**
 * Get all PENDING or FAILED fulfillment jobs (for worker pickup and recovery after restart).
 */
export async function getPendingFulfillmentJobs() {
  return allQuery(
    `SELECT fj.*, o.payment_amount, o.casaku_transaction_id
     FROM fulfillment_jobs fj
     JOIN orders o ON fj.order_id = o.order_id
     WHERE fj.status IN ('PENDING', 'FAILED')
     ORDER BY fj.created_at ASC`
  );
}

/**
 * Update a fulfillment job's status, attempts, and optional error.
 */
export async function updateFulfillmentJob(jobId, status, lastError = null) {
  await runQuery(
    `UPDATE fulfillment_jobs SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE job_id = ?`,
    [status, lastError, Date.now(), jobId]
  );
}

/**
 * Log a received webhook event for audit purposes.
 */
export async function logWebhookEvent(transactionId, signature, payload, processingStatus = 'RECEIVED') {
  const now = Date.now();
  const id = `WH-${transactionId}-${now}`;
  await runQuery(
    `INSERT INTO payment_webhooks (id, provider, transaction_id, signature, payload, received_at, processing_status)
     VALUES (?, 'casaku', ?, ?, ?, ?, ?)`,
    [id, transactionId || 'unknown', signature || '', JSON.stringify(payload), now, processingStatus]
  );
  return id;
}

/**
 * Update webhook log processing status after handling.
 */
export async function updateWebhookStatus(webhookLogId, processingStatus) {
  await runQuery(
    `UPDATE payment_webhooks SET processing_status = ?, processed_at = ? WHERE id = ?`,
    [processingStatus, Date.now(), webhookLogId]
  );
}

/**
 * Expire stale PENDING orders older than given minutes. Releases RESERVED product_items.
 */
export async function expireStaleOrders(expiryMinutes = 15) {
  const cutoff = Date.now() - expiryMinutes * 60 * 1000;
  const staleOrders = await allQuery(
    `SELECT order_id FROM orders WHERE payment_status = 'PENDING' AND status = 'WAITING_PAYMENT' AND expired_at < ?`,
    [Date.now()]
  );

  for (const order of staleOrders) {
    await withTransaction(async () => {
      // Release reserved product_items back to READY
      await runQuery(
        `UPDATE product_items SET status = 'READY', order_id = NULL WHERE order_id = ? AND status = 'RESERVED'`,
        [order.order_id]
      );
      // Restore manual stock items
      const manualItems = await allQuery(
        `SELECT oi.produk_kode, oi.qty FROM order_items oi WHERE oi.order_id = ? AND oi.stock_reserved = 1`,
        [order.order_id]
      );
      for (const item of manualItems) {
        await runQuery(`UPDATE products SET stok = stok + ? WHERE kode = ?`, [item.qty, item.produk_kode]);
      }
      // Mark order expired
      await runQuery(
        `UPDATE orders SET payment_status = 'EXPIRED', status = 'CANCELLED', updated_at = ? WHERE order_id = ?`,
        [Date.now(), order.order_id]
      );
      await runQuery(
        `UPDATE payment_transactions SET status = 'EXPIRED' WHERE order_id = ? AND status = 'PENDING'`,
        [order.order_id]
      );
    });
  }

  return staleOrders.length;
}

/**
 * Get stale PENDING orders for reconciliation check (older than thresholdMinutes).
 */
export async function getStalePendingOrders(thresholdMinutes = 3) {
  const cutoff = Date.now() - thresholdMinutes * 60 * 1000;
  return allQuery(
    `SELECT o.order_id, o.casaku_transaction_id, o.customer_nomor, o.payment_amount, o.created_at
     FROM orders o
     WHERE o.payment_status = 'PENDING' AND o.status = 'WAITING_PAYMENT'
     AND o.casaku_transaction_id IS NOT NULL
     AND o.created_at < ?`,
    [cutoff]
  );
}

// ============================================================
// PREMIUM 2.0 & RESELLER HELPER FUNCTIONS
// ============================================================

/**
 * Get AI usage count today for a user.
 */
export async function getAiUsageToday(jid) {
  const todayStr = new Date().toISOString().split('T')[0];
  const row = await getQuery(
    "SELECT count FROM ai_usage_logs WHERE jid = ? AND usage_date = ?",
    [jid, todayStr]
  );
  return row ? row.count : 0;
}

/**
 * Increment AI usage count today for a user.
 */
export async function incrementAiUsage(jid) {
  const todayStr = new Date().toISOString().split('T')[0];
  await runQuery(
    `INSERT INTO ai_usage_logs (jid, usage_date, count) VALUES (?, ?, 1)
     ON CONFLICT(jid, usage_date) DO UPDATE SET count = count + 1`,
    [jid, todayStr]
  );
  return await getAiUsageToday(jid);
}

/**
 * Add product to user's wishlist.
 */
export async function addWishlist(jid, produkKode) {
  try {
    await runQuery(
      "INSERT INTO user_wishlists (jid, produk_kode) VALUES (?, ?)",
      [jid, produkKode.toUpperCase()]
    );
    return { success: true };
  } catch (err) {
    return { success: false, message: "Produk sudah ada di wishlist Anda." };
  }
}

/**
 * Remove product from user's wishlist.
 */
export async function removeWishlist(jid, produkKode) {
  const res = await runQuery(
    "DELETE FROM user_wishlists WHERE jid = ? AND produk_kode = ?",
    [jid, produkKode.toUpperCase()]
  );
  return { success: res.changes > 0 };
}

/**
 * Get all user JIDs who wishlisted a product.
 */
export async function getWishlistSubscribers(produkKode) {
  const rows = await allQuery(
    "SELECT jid FROM user_wishlists WHERE produk_kode = ?",
    [produkKode.toUpperCase()]
  );
  return rows.map(r => r.jid);
}

/**
 * Create a new reseller product listing.
 */
export async function createResellerProduct(sellerJid, sellerNama, nama, harga, stok, isiProduk) {
  const res = await runQuery(
    `INSERT INTO reseller_products (seller_jid, seller_nama, nama, harga, stok, isi_produk)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sellerJid, sellerNama, nama, harga, stok, isiProduk]
  );
  return { id: res.lastID, sellerJid, nama, harga, stok };
}

/**
 * Get active reseller products list.
 */
export async function getResellerProducts() {
  return await allQuery(
    "SELECT * FROM reseller_products WHERE status = 'ACTIVE' AND stok > 0 ORDER BY id DESC"
  );
}

/**
 * Buy a product from a reseller lapak. Transfers 98% of total amount to seller's balance (2% admin fee).
 */
export async function buyResellerProduct(buyerJid, lapakId) {
  return withTransaction(async () => {
    const item = await getQuery(
      "SELECT * FROM reseller_products WHERE id = ? AND status = 'ACTIVE' AND stok > 0",
      [lapakId]
    );

    if (!item) {
      return { success: false, message: "Produk lapak tidak ditemukan atau stok habis." };
    }

    if (item.seller_jid === buyerJid) {
      return { success: false, message: "Anda tidak bisa membeli produk dari lapak Anda sendiri." };
    }

    const buyer = await getCustomerMembershipProfile(buyerJid);
    if ((buyer?.balance || 0) < item.harga) {
      return { success: false, message: `Saldo Anda tidak cukup (Harga: Rp${item.harga.toLocaleString('id-ID')}, Saldo Anda: Rp${(buyer?.balance || 0).toLocaleString('id-ID')}). Ketik .deposit untuk isi saldo.` };
    }

    // Deduct buyer balance
    await runQuery("UPDATE customers SET balance = balance - ? WHERE nomor = ?", [item.harga, buyerJid]);

    // Calculate 98% seller payout (2% admin fee)
    const sellerPayout = Math.floor(item.harga * 0.98);
    await runQuery("UPDATE customers SET balance = balance + ? WHERE nomor = ?", [sellerPayout, item.seller_jid]);

    // Deduct stock
    const newStock = item.stok - 1;
    const newStatus = newStock <= 0 ? 'SOLD_OUT' : 'ACTIVE';
    await runQuery("UPDATE reseller_products SET stok = ?, status = ? WHERE id = ?", [newStock, newStatus, lapakId]);

    await addLog("RESELLER", `Lapak #${lapakId} (${item.nama}) dibeli oleh ${buyerJid}. Seller ${item.seller_jid} terima Rp${sellerPayout.toLocaleString('id-ID')}`);

    return {
      success: true,
      item,
      sellerPayout,
      isiProduk: item.isi_produk
    };
  });
}

/**
 * Claim monthly free voucher/bonus balance for premium users.
 */
export async function claimMonthlyVoucher(jid, amount = 10000) {
  const now = new Date();
  const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const existing = await getQuery(
    "SELECT id FROM premium_monthly_claims WHERE jid = ? AND claim_month = ?",
    [jid, monthStr]
  );

  if (existing) {
    return { success: false, message: `Anda sudah mengklaim voucher bulanan untuk bulan ${monthStr}.` };
  }

  await withTransaction(async () => {
    await runQuery(
      "INSERT INTO premium_monthly_claims (jid, claim_month) VALUES (?, ?)",
      [jid, monthStr]
    );
    await runQuery(
      "UPDATE customers SET balance = balance + ? WHERE nomor = ?",
      [amount, jid]
    );
    await addLog("PREMIUM", `Voucher bulanan Rp${amount.toLocaleString('id-ID')} diklaim oleh ${jid} (${monthStr})`);
  });

  return { success: true, amount, monthStr };
}

// ============================================================
// FINANCIAL & POINTS SECURITY ENGINE HELPER FUNCTIONS
// ============================================================

/**
 * Atomically deduct customer balance using SQLite WHERE guard.
 * Prevents double-spending & negative balance.
 */
export async function deductCustomerBalance(customerNomor, amount, description = 'PEMBELIAN_PRODUK') {
  const safeAmount = Math.floor(Number(amount));
  if (isNaN(safeAmount) || safeAmount <= 0 || !isFinite(safeAmount)) {
    return { success: false, reason: 'INVALID_AMOUNT', message: 'Nominal tidak valid.' };
  }

  return withTransaction(async () => {
    const result = await runQuery(
      `UPDATE customers SET balance = balance - ? WHERE nomor = ? AND balance >= ?`,
      [safeAmount, customerNomor, safeAmount]
    );

    if (result.changes === 0) {
      const cust = await getQuery("SELECT balance FROM customers WHERE nomor = ?", [customerNomor]);
      return {
        success: false,
        reason: 'INSUFFICIENT_BALANCE',
        currentBalance: cust?.balance || 0,
        message: `Saldo tidak cukup (Butuh: Rp${safeAmount.toLocaleString('id-ID')}, Saldo Anda: Rp${(cust?.balance || 0).toLocaleString('id-ID')}).`
      };
    }

    await runQuery(
      `INSERT INTO financial_logs (customer_nomor, type, amount, source, description) VALUES (?, 'PURCHASE', ?, 'SYSTEM', ?)`,
      [customerNomor, safeAmount, description]
    );

    const updated = await getQuery("SELECT balance FROM customers WHERE nomor = ?", [customerNomor]);
    return { success: true, newBalance: updated.balance };
  });
}

/**
 * Atomically add customer balance (for deposits/refunds/reseller payout).
 */
export async function addCustomerBalance(customerNomor, amount, source = 'DEPOSIT', description = 'Top Up Deposit Saldo') {
  const safeAmount = Math.floor(Number(amount));
  if (isNaN(safeAmount) || safeAmount <= 0 || !isFinite(safeAmount)) {
    return { success: false, reason: 'INVALID_AMOUNT' };
  }

  return withTransaction(async () => {
    // Ensure customer record exists
    await getCustomerMembershipProfile(customerNomor);

    await runQuery(
      `UPDATE customers SET balance = balance + ? WHERE nomor = ?`,
      [safeAmount, customerNomor]
    );

    await runQuery(
      `INSERT INTO financial_logs (customer_nomor, type, amount, source, description) VALUES (?, ?, ?, ?, ?)`,
      [customerNomor, source, safeAmount, source, description]
    );

    const updated = await getQuery("SELECT balance FROM customers WHERE nomor = ?", [customerNomor]);
    return { success: true, newBalance: updated.balance };
  });
}

/**
 * Atomically deduct customer Akbar Poin.
 */
export async function deductCustomerPoints(customerNomor, pointsToDeduct, description = 'TUKAR_POIN') {
  const safePoints = Math.floor(Number(pointsToDeduct));
  if (isNaN(safePoints) || safePoints <= 0 || !isFinite(safePoints)) {
    return { success: false, reason: 'INVALID_POINTS' };
  }

  return withTransaction(async () => {
    await getGameProfile(customerNomor);
    const result = await runQuery(
      `UPDATE game_profiles SET points = MAX(0, COALESCE(points, 0) - ?) WHERE customer_jid = ? AND COALESCE(points, 0) >= ?`,
      [safePoints, customerNomor, safePoints]
    );

    if (result.changes === 0) {
      const prof = await getGameProfile(customerNomor);
      return { success: false, reason: 'INSUFFICIENT_POINTS', currentPoints: prof?.points || 0 };
    }

    await runQuery(
      `INSERT INTO point_logs (customer_nomor, type, points, description) VALUES (?, 'DEDUCT_REDEEM', ?, ?)`,
      [customerNomor, safePoints, description]
    );

    const updated = await getGameProfile(customerNomor);
    return { success: true, newPoints: updated.points };
  });
}

/**
 * Award Akbar Poin for real purchase (10 Poin / Rp10.000 spent via QRIS).
 */
export async function awardPurchasePoints(customerNomor, orderTotal) {
  const pointsEarned = Math.floor(orderTotal / 10000) * 10;
  if (pointsEarned <= 0) return 0;

  await withTransaction(async () => {
    await runQuery(
      `INSERT INTO game_profiles (customer_jid, points, xp) VALUES (?, ?, ?)
       ON CONFLICT(customer_jid) DO UPDATE SET points = COALESCE(points, 0) + ?, xp = COALESCE(xp, 0) + ?`,
      [customerNomor, pointsEarned, pointsEarned, pointsEarned, pointsEarned]
    );
    await runQuery(
      `INSERT INTO point_logs (customer_nomor, type, points, description) VALUES (?, 'EARN_PURCHASE', ?, ?)`,
      [customerNomor, pointsEarned, `Poin dari belanja Rp${orderTotal.toLocaleString('id-ID')}`]
    );
  });

  return pointsEarned;
}

/**
 * Register referral pair with first-purchase lock.
 */
export async function registerReferral(referrerNomor, referredNomor) {
  if (referrerNomor === referredNomor) return { success: false, message: 'Tidak bisa referral diri sendiri.' };
  try {
    await runQuery(
      `INSERT INTO referral_verifications (referrer_nomor, referred_nomor, status) VALUES (?, ?, 'PENDING_FIRST_PURCHASE')`,
      [referrerNomor, referredNomor]
    );
    return { success: true };
  } catch {
    return { success: false, message: 'Nomor ini sudah terdaftar referral.' };
  }
}

/**
 * Verify first purchase and unlock referral reward (50 Poin to referrer).
 */
export async function verifyAndRewardReferral(referredNomor, purchaseAmount) {
  if (purchaseAmount < 10000) return null; // Must be min Rp10.000 purchase

  return withTransaction(async () => {
    const ref = await getQuery(
      `SELECT * FROM referral_verifications WHERE referred_nomor = ? AND status = 'PENDING_FIRST_PURCHASE'`,
      [referredNomor]
    );

    if (!ref) return null;

    const rewardPoints = 50;
    await runQuery(
      `UPDATE referral_verifications SET status = 'UNLOCKED', points_awarded = ?, unlocked_at = CURRENT_TIMESTAMP WHERE referred_nomor = ?`,
      [rewardPoints, referredNomor]
    );

    await runQuery(
      `INSERT INTO game_profiles (customer_jid, points, xp) VALUES (?, ?, ?)
       ON CONFLICT(customer_jid) DO UPDATE SET points = COALESCE(points, 0) + ?, xp = COALESCE(xp, 0) + ?`,
      [ref.referrer_nomor, rewardPoints, rewardPoints, rewardPoints, rewardPoints]
    );

    await runQuery(
      `INSERT INTO point_logs (customer_nomor, type, points, description) VALUES (?, 'EARN_REFERRAL', ?, ?)`,
      [ref.referrer_nomor, rewardPoints, `Referral bonus dari ${referredNomor} (belanja pertama Rp${purchaseAmount.toLocaleString('id-ID')})`]
    );

    return { referrerNomor: ref.referrer_nomor, rewardPoints };
  });
}

/**
 * Redeem points for a discount coupon.
 */
export async function redeemPointsForCoupon(customerNomor, couponTier) {
  const couponConfig = {
    5: { points: 100, discountPct: 5, minOrder: 20000 },
    10: { points: 250, discountPct: 10, minOrder: 35000 },
    20: { points: 500, discountPct: 20, minOrder: 50000 }
  }[couponTier];

  if (!couponConfig) return { success: false, message: 'Pilihan kupon tidak valid. Pilih: 5, 10, atau 20.' };

  const deductRes = await deductCustomerPoints(customerNomor, couponConfig.points, `TUKAR_KUPON_${couponConfig.discountPct}%`);
  if (!deductRes.success) {
    return { success: false, message: `Poin Anda tidak cukup (Butuh: ${couponConfig.points} Poin).` };
  }

  // Generate unique coupon code
  const code = `POIN${couponConfig.discountPct}-${Math.floor(1000 + Math.random() * 9000)}`;
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await runQuery(
    `INSERT INTO coupons (code, discount_percent, min_order_amount, expires_at, is_used)
     VALUES (?, ?, ?, ?, 0)`,
    [code, couponConfig.discountPct, couponConfig.minOrder, expiresAt]
  );

  return {
    success: true,
    code,
    discountPct: couponConfig.discountPct,
    minOrder: couponConfig.minOrder,
    remainingPoints: deductRes.newPoints
  };
}

// ==============================================================================
// 10. GROUP RENTALS (INVITED ONLY)
// ==============================================================================

export async function addGroupRental(groupJid, days, addedBy) {
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  await runQuery(
    "INSERT OR REPLACE INTO group_rentals (group_jid, expires_at, added_by) VALUES (?, ?, ?)",
    [groupJid, expiresAt, addedBy]
  );
  return expiresAt;
}

export async function getGroupRental(groupJid) {
  return await getQuery("SELECT * FROM group_rentals WHERE group_jid = ?", [groupJid]);
}

export async function getExpiredGroupRentals() {
  const now = new Date().toISOString();
  return await allQuery("SELECT * FROM group_rentals WHERE expires_at <= ?", [now]);
}

export async function removeGroupRental(groupJid) {
  return await runQuery("DELETE FROM group_rentals WHERE group_jid = ?", [groupJid]);
}
export async function incrementGroupChatStats(groupJid, participantJid) {
  const query = `
    INSERT INTO group_chat_stats (group_jid, participant_jid, msg_count)
    VALUES (?, ?, 1)
    ON CONFLICT(group_jid, participant_jid) DO UPDATE SET msg_count = msg_count + 1
  `;
  return await runQuery(query, [groupJid, participantJid]);
}

export async function getTopGroupChatStats(groupJid, limit = 10) {
  return await allQuery("SELECT participant_jid, msg_count FROM group_chat_stats WHERE group_jid = ? ORDER BY msg_count DESC LIMIT ?", [groupJid, limit]);
}


// --- FUNGSI SESI MENFESS 2-ARAH (ANONYMOUS CHAT) ---

export async function createMenfessSession(sessionId, senderJid, targetJid) {
  await runQuery(
    "INSERT INTO menfess_sessions (id, sender_jid, target_jid, status) VALUES (?, ?, ?, 'ACTIVE')",
    [sessionId, senderJid, targetJid]
  );
  return { id: sessionId, sender_jid: senderJid, target_jid: targetJid, status: 'ACTIVE' };
}

export async function getMenfessSession(sessionId) {
  return await getQuery("SELECT * FROM menfess_sessions WHERE id = ?", [sessionId]);
}

export async function getActiveMenfessByParticipant(userJid) {
  return await getQuery(
    "SELECT * FROM menfess_sessions WHERE (sender_jid = ? OR target_jid = ?) AND status = 'ACTIVE' ORDER BY last_reply_at DESC LIMIT 1",
    [userJid, userJid]
  );
}

export async function updateMenfessLastReply(sessionId) {
  return await runQuery(
    "UPDATE menfess_sessions SET last_reply_at = CURRENT_TIMESTAMP WHERE id = ?",
    [sessionId]
  );
}

export async function closeMenfessSession(sessionId) {
  return await runQuery(
    "UPDATE menfess_sessions SET status = 'CLOSED' WHERE id = ?",
    [sessionId]
  );
}
