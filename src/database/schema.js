import { openDb, getDb, runQuery, getQuery, allQuery } from './connection.js';
import { config } from '../../config.js';

export async function initDb() {
  if (!getDb()) {
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

  // Jalankan migrasi kolom brand_category, variant_type, duration (multi-variant support)
  try {
    await runQuery("ALTER TABLE products ADD COLUMN brand_category TEXT");
  } catch (e) {}
  try {
    await runQuery("ALTER TABLE products ADD COLUMN variant_type TEXT");
  } catch (e) {}
  try {
    await runQuery("ALTER TABLE products ADD COLUMN duration TEXT");
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
      order_id TEXT NOT NULL,
      customer_nomor TEXT NOT NULL,
      produk_kode TEXT,
      rating INTEGER NOT NULL,
      comment TEXT,
      review_reminder_sent INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(order_id)
    )
  `);
  try { await runQuery("ALTER TABLE reviews ADD COLUMN review_reminder_sent INTEGER DEFAULT 0"); } catch (e) {}
  try { await runQuery("ALTER TABLE reviews ADD COLUMN produk_kode TEXT"); } catch (e) {}

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
  // Kolom ini dipakai updateGroupSettings({ features_config }) untuk sakelar
  // per-fitur per-grup (.freegames, .tcg). Sebelumnya kolomnya tidak pernah
  // dibuat, sehingga setiap sakelar melapor sukses tapi nilainya hilang.
  try {
    await runQuery(`ALTER TABLE group_settings ADD COLUMN features_config TEXT DEFAULT '{}'`);
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
      jailed_until DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migrasi kolom baru untuk game_profiles jika tabel sudah ada
  try { await runQuery("ALTER TABLE game_profiles ADD COLUMN bank_points INTEGER DEFAULT 0"); } catch (e) { /* ignore if exists */ }
  try { await runQuery("ALTER TABLE game_profiles ADD COLUMN last_robbed_at DATETIME"); } catch (e) { /* ignore if exists */ }
  try { await runQuery("ALTER TABLE game_profiles ADD COLUMN last_rob_time DATETIME"); } catch (e) { /* ignore if exists */ }
  try { await runQuery("ALTER TABLE game_profiles ADD COLUMN jailed_until DATETIME"); } catch (e) { /* ignore if exists */ }

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

  // Seed / update sample variant products for Netflix & Spotify and enrich existing products
  try {
    const netflixCheck = await getQuery("SELECT COUNT(*) as count FROM products WHERE UPPER(brand_category) = 'NETFLIX' OR UPPER(kode) LIKE 'NET%'");
    if (!netflixCheck || netflixCheck.count === 0) {
      const defaultVariants = [
        { kode: 'NET-SH-7D', nama: 'Netflix Sharing 7 Hari', harga: 12000, stok: 15, deskripsi: '1 Profil Privat 4K Ultra HD, Anti-Screen Limit, All Device', gambar: '', delivery_type: 'MANUAL', brand_category: 'Netflix', variant_type: 'Sharing (1 Profil)', duration: '7 Hari' },
        { kode: 'NET-SH-14D', nama: 'Netflix Sharing 14 Hari', harga: 20000, stok: 8, deskripsi: '1 Profil Privat 4K Ultra HD, Garansi Penuh, All Device', gambar: '', delivery_type: 'MANUAL', brand_category: 'Netflix', variant_type: 'Sharing (1 Profil)', duration: '14 Hari' },
        { kode: 'NET-SH-30D', nama: 'Netflix Sharing 30 Hari', harga: 35000, stok: 10, deskripsi: '1 Profil Privat 4K Ultra HD, Garansi 30 Hari, All Device', gambar: '', delivery_type: 'MANUAL', brand_category: 'Netflix', variant_type: 'Sharing (1 Profil)', duration: '30 Hari' },
        { kode: 'NET-PV-30D', nama: 'Netflix Private 30 Hari', harga: 150000, stok: 4, deskripsi: '1 Akun Full Milik Anda (5 Profil), 5 Device Simultan, Bebas Buat Profil & PIN', gambar: '', delivery_type: 'MANUAL', brand_category: 'Netflix', variant_type: 'Private (1 Akun Full)', duration: '30 Hari' }
      ];
      for (const v of defaultVariants) {
        await runQuery(
          "INSERT OR IGNORE INTO products (kode, nama, harga, stok, deskripsi, gambar, delivery_type, brand_category, variant_type, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [v.kode, v.nama, v.harga, v.stok, v.deskripsi, v.gambar, v.delivery_type, v.brand_category, v.variant_type, v.duration]
        );
      }
    }
  } catch (e) {}

  try {
    await runQuery("UPDATE products SET brand_category = 'Microsoft Office', variant_type = '1 Tahun', duration = '12 Bulan' WHERE kode = 'OFFICE' AND (brand_category IS NULL OR brand_category = '')");
    await runQuery("UPDATE products SET brand_category = 'Apple Music', variant_type = 'Individual', duration = '6 Bulan' WHERE kode = 'APPLEMUSIC' AND (brand_category IS NULL OR brand_category = '')");
    await runQuery("UPDATE products SET brand_category = 'Adobe Express', variant_type = 'Premium', duration = '12 Bulan' WHERE kode = 'ADOBE' AND (brand_category IS NULL OR brand_category = '')");
    await runQuery("UPDATE products SET brand_category = 'Google Gemini', variant_type = 'Gemini Pro + 5TB', duration = '18 Bulan' WHERE kode = 'GEMINI' AND (brand_category IS NULL OR brand_category = '')");
  } catch (e) {}

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

  // Migrate orders table: add Casaku payment columns & warranty
  try { await runQuery("ALTER TABLE orders ADD COLUMN payment_amount INTEGER DEFAULT 0"); } catch(e) {}
  try { await runQuery("ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT 'PENDING'"); } catch(e) {}
  try { await runQuery("ALTER TABLE orders ADD COLUMN fulfillment_status TEXT DEFAULT 'PENDING'"); } catch(e) {}
  try { await runQuery("ALTER TABLE orders ADD COLUMN expired_at INTEGER"); } catch(e) {}
  try { await runQuery("ALTER TABLE orders ADD COLUMN casaku_transaction_id TEXT"); } catch(e) {}
  try { await runQuery("ALTER TABLE orders ADD COLUMN qr_string TEXT"); } catch(e) {}
  try { await runQuery("ALTER TABLE orders ADD COLUMN warranty_until INTEGER"); } catch(e) {}
  try { await runQuery("ALTER TABLE orders ADD COLUMN updated_at INTEGER"); } catch(e) {}
  try { await runQuery("ALTER TABLE orders ADD COLUMN review_reminder_sent INTEGER DEFAULT 0"); } catch(e) {}
  try { await runQuery("ALTER TABLE orders ADD COLUMN coupon_code TEXT"); } catch(e) {}
  try { await runQuery("ALTER TABLE orders ADD COLUMN discount_amount INTEGER DEFAULT 0"); } catch(e) {}
  try { await runQuery("ALTER TABLE orders ADD COLUMN coupon_redeemed INTEGER DEFAULT 0"); } catch(e) {}

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
      qr_string TEXT,
      created_at INTEGER NOT NULL,
      paid_at INTEGER,
      FOREIGN KEY(order_id) REFERENCES orders(order_id),
      UNIQUE(provider, provider_transaction_id)
    )
  `);
  try { await runQuery("ALTER TABLE payment_transactions ADD COLUMN qr_string TEXT"); } catch(e) {}

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
  await runQuery("CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_nomor)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(produk_kode)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_product_items_code_status ON product_items(produk_kode, status)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_product_items_order ON product_items(order_id)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_customer_warnings_jid ON customer_warnings(jid)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_banned_users_expires ON banned_users(expires_at)");

  // Tabel Statistik Game Undercover (win rate per kubu, streak, aksi spesial)
  await runQuery(`
    CREATE TABLE IF NOT EXISTS undercover_stats (
      customer_jid TEXT PRIMARY KEY,
      games_played INTEGER DEFAULT 0,
      games_won INTEGER DEFAULT 0,
      times_civilian INTEGER DEFAULT 0,
      wins_civilian INTEGER DEFAULT 0,
      times_impostor INTEGER DEFAULT 0,
      wins_impostor INTEGER DEFAULT 0,
      times_neutral INTEGER DEFAULT 0,
      wins_neutral INTEGER DEFAULT 0,
      mrwhite_guess_win INTEGER DEFAULT 0,
      jester_win INTEGER DEFAULT 0,
      sheriff_kills INTEGER DEFAULT 0,
      assassin_kills INTEGER DEFAULT 0,
      detective_correct INTEGER DEFAULT 0,
      win_streak INTEGER DEFAULT 0,
      best_streak INTEGER DEFAULT 0,
      points_won INTEGER DEFAULT 0,
      last_played DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await runQuery("CREATE INDEX IF NOT EXISTS idx_undercover_stats_played ON undercover_stats(games_played)");

  // Tabel Power-Up / Buff Pemain (toko poin `.tukar`).
  // Satu baris per (jid, buff_type) — beli ulang memperpanjang durasi atau
  // menambah jatah pakai, bukan membuat baris baru.
  await runQuery(`
    CREATE TABLE IF NOT EXISTS user_buffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      buff_type TEXT NOT NULL,
      multiplier REAL DEFAULT 1,
      uses_left INTEGER DEFAULT 0,
      expires_at INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(jid, buff_type)
    )
  `);
  await runQuery("CREATE INDEX IF NOT EXISTS idx_user_buffs_jid ON user_buffs(jid)");
  // Buang buff kedaluwarsa yang tertinggal dari sesi sebelumnya.
  await runQuery("DELETE FROM user_buffs WHERE expires_at IS NOT NULL AND expires_at < ?", [Date.now()]);

  // Cleanup & Migration untuk mencegah NULL/NaN/Non-Integer points/xp di database
  await runQuery("UPDATE game_profiles SET points = 0 WHERE points IS NULL OR typeof(points) != 'integer' OR points < 0 OR points > 1000000");
  await runQuery("UPDATE game_profiles SET xp = 0 WHERE xp IS NULL OR typeof(xp) != 'integer' OR xp < 0");
  await runQuery("UPDATE game_profiles SET level = 1 WHERE level IS NULL OR typeof(level) != 'integer' OR level < 1");
  await runQuery("UPDATE game_profiles SET games_played = 0 WHERE games_played IS NULL OR typeof(games_played) != 'integer' OR games_played < 0");
  await runQuery("UPDATE game_profiles SET games_won = 0 WHERE games_won IS NULL OR typeof(games_won) != 'integer' OR games_won < 0");
  await runQuery("UPDATE game_profiles SET daily_streak = 0 WHERE daily_streak IS NULL OR typeof(daily_streak) != 'integer' OR daily_streak < 0");
  await runQuery("UPDATE loyalty SET points = 0 WHERE points IS NULL OR typeof(points) != 'integer' OR points < 0");
  await runQuery("UPDATE loyalty SET total_spent = 0 WHERE total_spent IS NULL OR typeof(total_spent) != 'integer' OR total_spent < 0");

  // Tabel Arena Kartu Monster (TCG). Import dinamis mengikuti konvensi repo
  // untuk memutus siklus: tcgDb.js mengimpor gamesDb.js.
  const { initTcgSchema } = await import('./tcgDb.js');
  await initTcgSchema();
}