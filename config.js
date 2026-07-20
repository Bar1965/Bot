import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET || 'super_secret_key_whatsapp_sales_bot',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', // hash default untuk "admin123"

  // Pengaturan default awal yang akan dimasukkan ke tabel 'settings' database saat pertama kali dijalankan.
  // Setelah itu, nilai-nilai ini dapat diubah langsung secara dinamis melalui Web Dashboard.
  defaults: {
    storeName: "🛒 DIGITAL SHOP",
    
    // Nomor WA Admin utama untuk deteksi perintah kelola order / stok.
    // Format lengkap dipisah koma (misal: "6283170183637@s.whatsapp.net,628123456789@s.whatsapp.net")
    adminNumbers: "6283170183637@s.whatsapp.net",

    // Nomor WA Owner utama untuk perintah eksklusif /stats dan /broadcast
    ownerNumber: "6283170183637@s.whatsapp.net",

    // JID Grup WhatsApp untuk koordinasi Transaksi Admin
    transactionGroupId: "",

    // JID Grup WhatsApp untuk Log Monitoring (Opsional)
    logGroupId: "",

    // JID Grup WhatsApp Utama Pembeli (tempat customer ketik list/buy/checkout)
    buyerGroupId: "",

    // Batas stok minimal untuk status produk "Hampir Habis" (🟡 Low)
    lowStockLimit: 3,

    // Jeda waktu pengiriman pesan broadcast (dalam milidetik)
    broadcastDelay: 3000,

    // Lokasi file QRIS pembayaran
    qrisImagePath: "./public/uploads/qris.png",

    // Kredensial Midtrans Payment Gateway
    midtransServerKey: "",
    midtransClientKey: "",
    midtransSandboxMode: "true",

    // Instruksi pembayaran alternatif
    paymentInstructions: `💳 ALTERNATIF PEMBAYARAN:
- Bank BCA: 1234567890 a/n Akbar Shop
- Bank Mandiri: 0987654321 a/n Akbar Shop

Setelah transfer, harap kirim BUKTI TRANSFER (berupa gambar/screenshot) langsung ke chat ini.`
  }
};
