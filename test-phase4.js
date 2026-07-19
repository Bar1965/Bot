import * as db from './database.js';

async function runTest() {
  console.log("=== MEMULAI INTEGRASI TEST PHASE 4 (AUTO-DELIVERY) ===");

  try {
    // 1. Inisialisasi DB
    await db.initDb();

    // 2. Tambah produk contoh dengan tipe AUTO
    const testProductCode = 'NET_AUTO_TEST';
    await db.addProduct(testProductCode, 'Netflix Auto Delivery Test', 45000, 0, 'Auto Delivery Test Product', '', 'AUTO');
    console.log(`✅ Produk tipe AUTO '${testProductCode}' berhasil dibuat.`);

    // 3. Tambahkan voucher stok
    const sampleVouchers = [
      'user1@test.com|pass123',
      'user2@test.com|pass456',
      'user3@test.com|pass789'
    ];
    await db.addProductItems(testProductCode, sampleVouchers);
    
    // Cek apakah stok terupdate di produk utama
    const product = await db.getProductByKode(testProductCode);
    console.log(`✅ Kredensial di-import. Sisa stok dihitung otomatis: ${product.stok} (Ekspektasi: 3)`);
    if (product.stok !== 3) {
      throw new Error("Gagal: Stok tidak cocok setelah impor voucher.");
    }

    // 4. Buat order pembeli
    const customer = await db.getOrCreateCustomer('62899999999@s.whatsapp.net', 'Budi Test');
    
    // Pastikan cart bersih
    await db.runQuery("DELETE FROM order_items WHERE order_id IN (SELECT order_id FROM orders WHERE customer_nomor = ?)", [customer.nomor]);
    await db.runQuery("DELETE FROM orders WHERE customer_nomor = ?", [customer.nomor]);

    // Tambah item ke keranjang (qty = 2)
    const cartRes = await db.addToCart(customer.nomor, testProductCode, 2);
    if (!cartRes.success) {
      throw new Error(`Gagal tambah keranjang: ${cartRes.message}`);
    }
    console.log("✅ Berhasil menambahkan 2 pcs ke keranjang.");

    // Checkout
    const checkoutRes = await db.checkoutCart(customer.nomor);
    if (!checkoutRes.success) {
      throw new Error(`Gagal checkout: ${checkoutRes.message}`);
    }
    const order = checkoutRes.order;
    console.log(`✅ Berhasil checkout. Order ID: ${order.order_id}, Status: ${order.status} (Ekspektasi: WAITING_PAYMENT)`);

    // 5. Simulasikan Settlement Pembayaran (seperti yang dilakukan Webhook Midtrans)
    console.log("⚡ Mensimulasikan pembayaran settlement (PAID & AUTO-SEND)...");
    
    // Ubah status ke PAID
    await db.updateOrderStatus(order.order_id, 'PAID');
    
    // Pemicu claim dan pengiriman voucher
    const claims = await db.claimAndDeliverItems(order.order_id);
    
    // Set order status ke COMPLETED (karena tipe AUTO)
    await db.updateOrderStatus(order.order_id, 'COMPLETED');

    console.log("🎁 Hasil Pengiriman Otomatis (Claims):", JSON.stringify(claims, null, 2));

    // Verifikasi hasil
    const delivered = claims[testProductCode];
    if (!delivered || delivered.credentials.length !== 2) {
      throw new Error("Gagal: Jumlah kredensial yang dikirim tidak cocok.");
    }
    
    if (delivered.credentials[0] !== 'user1@test.com|pass123' || delivered.credentials[1] !== 'user2@test.com|pass456') {
      throw new Error("Gagal: Kredensial yang terkirim salah urutan / tidak sesuai.");
    }
    console.log("✅ Kredensial yang dikirim tepat (user1 dan user2).");

    // Cek sisa stok produk utama
    const productAfter = await db.getProductByKode(testProductCode);
    console.log(`✅ Sisa stok produk di database setelah claim: ${productAfter.stok} (Ekspektasi: 1)`);
    if (productAfter.stok !== 1) {
      throw new Error("Gagal: Sisa stok tidak terupdate dengan benar.");
    }

    // Cek status voucher di database
    const itemsDb = await db.getProductItems(testProductCode);
    const usedItems = itemsDb.filter(i => i.status === 'USED');
    const readyItems = itemsDb.filter(i => i.status === 'READY');
    
    console.log(`✅ Voucher berstatus USED: ${usedItems.length} (Ekspektasi: 2)`);
    console.log(`✅ Voucher berstatus READY: ${readyItems.length} (Ekspektasi: 1)`);

    if (usedItems.length !== 2 || readyItems.length !== 1) {
      throw new Error("Gagal: Status item di database tidak sinkron.");
    }

    // Bersihkan data uji coba
    await db.runQuery("DELETE FROM product_items WHERE produk_kode = ?", [testProductCode]);
    await db.runQuery("DELETE FROM products WHERE kode = ?", [testProductCode]);
    await db.runQuery("DELETE FROM order_items WHERE order_id = ?", [order.order_id]);
    await db.runQuery("DELETE FROM orders WHERE order_id = ?", [order.order_id]);
    await db.runQuery("DELETE FROM customers WHERE nomor = ?", [customer.nomor]);

    console.log("\n⭐️ INTEGRASI TEST PHASE 4 BERHASIL 100% TANPA KENDALA! ⭐️");
    process.exit(0);

  } catch (err) {
    console.error("\n❌ INTEGRASI TEST GAGAL:", err.message);
    process.exit(1);
  }
}

runTest();
