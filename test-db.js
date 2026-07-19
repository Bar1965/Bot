import * as db from './database.js';

async function runTest() {
  console.log("=== MEMULAI UJI COBA DATABASE ===");
  try {
    // 1. Inisialisasi DB
    await db.initDb();
    console.log("✅ Inisialisasi database berhasil!");

    // 2. Tampilkan daftar produk
    const products = await db.getProducts();
    console.log(`\n📦 Daftar Produk (${products.length}):`);
    products.forEach(p => {
      console.log(`- [${p.kode}] ${p.nama} | Harga: Rp${p.harga} | Stok: ${p.stok} | Deskripsi: ${p.deskripsi}`);
    });

    // 3. Buat Pelanggan Uji Coba
    const nomorTest = "6289999999999@s.whatsapp.net";
    const customer = await db.getOrCreateCustomer(nomorTest, "Budi Pembeli");
    console.log(`\n👤 Pelanggan dibuat/didapatkan:`, customer);

    // 4. Tambah ke keranjang
    console.log("\n🛒 Menambahkan Netflix Premium (NET01) sebanyak 2 pcs ke keranjang...");
    const cartRes = await db.addToCart(nomorTest, "NET01", 2);
    console.log("Hasil add to cart:", cartRes);

    // Tampilkan isi keranjang
    const cartDetails = await db.getCartDetails(nomorTest);
    console.log("\n🛒 Isi Keranjang Saat Ini:", JSON.stringify(cartDetails, null, 2));

    // 5. Checkout
    console.log("\n🧾 Melakukan Checkout...");
    const checkoutRes = await db.checkoutCart(nomorTest);
    if (checkoutRes.success) {
      console.log("✅ Checkout Berhasil!");
      console.log("Detail Pesanan:", JSON.stringify(checkoutRes.order, null, 2));
    } else {
      console.error("❌ Checkout Gagal:", checkoutRes.message);
    }

    // Cek sisa stok produk setelah checkout (seharusnya tidak berkurang di checkout)
    let prod = await db.getProductByKode("NET01");
    console.log(`\n📦 Stok NET01 setelah checkout: ${prod.stok} (Ekspektasi: 12 - tidak berkurang di checkout)`);

    // Simulasikan pembayaran lunas (konfirmasi status PAID)
    console.log("\n⚡ Mengubah status pesanan ke PAID (Pembayaran Diterima)...");
    await db.updateOrderStatus(checkoutRes.order.order_id, 'PAID');
    prod = await db.getProductByKode("NET01");
    console.log(`📦 Stok NET01 setelah status PAID: ${prod.stok} (Ekspektasi: 10)`);

    // Simulasikan pembatalan oleh admin/system setelah status PAID
    console.log("\n❌ Mengubah status pesanan ke CANCELLED (Dibatalkan)...");
    await db.updateOrderStatus(checkoutRes.order.order_id, 'CANCELLED');
    prod = await db.getProductByKode("NET01");
    console.log(`📦 Stok NET01 setelah status CANCELLED: ${prod.stok} (Ekspektasi: 12 - dikembalikan)`);

    console.log("\n=== SEMUA UJI COBA DATABASE BERHASIL! ===");
  } catch (err) {
    console.error("\n❌ Uji coba database gagal dengan error:", err);
  } finally {
    process.exit(0);
  }
}

runTest();
