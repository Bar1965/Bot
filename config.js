import dotenv from 'dotenv';
dotenv.config();

// Validasi env var wajib. Jika salah satu belum diset, hentikan aplikasi
// daripada diam-diam memakai kredensial default yang sudah publik (bocor di repo/riwayat git).
const requiredEnvVars = ['JWT_SECRET', 'ADMIN_USER', 'ADMIN_PASSWORD_HASH'];
const missingEnvVars = requiredEnvVars.filter(key => !process.env[key]);
if (missingEnvVars.length > 0) {
  console.error(`❌ FATAL: Environment variable wajib belum diset: ${missingEnvVars.join(', ')}`);
  console.error('   Set nilai ini di file .env sebelum menjalankan bot (lihat .env.example).');
  process.exit(1);
}

export const config = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET,
  adminUser: process.env.ADMIN_USER,
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH,
  // Origin yang diizinkan untuk koneksi WebSocket (pisahkan koma jika lebih dari satu).
  // Default: false (tolak semua origin lintas domain) jika tidak diset.
  corsOrigin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()) : false,


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

Setelah transfer, harap kirim BUKTI TRANSFER (berupa gambar/screenshot) langsung ke chat ini.`,

    // Pengaturan Moderasi Grup & Anti-Spam (WhatsApp Bot v2)
    antiSpamEnabled: "true",
    spamThreshold: 5,
    spamWindow: 5000,
    antiLinkEnabled: "true",
    blockedDomains: "chat.whatsapp.com,bit.ly,tinyurl,t.me,discord.gg",
    allowedDomains: "tokopedia.com,shopee.co.id,bukalapak.com",
    kickAfterWarnings: 3,
    welcomeEnabled: "true",
    welcomeMessage: "👋 Selamat datang di grup! Ketik *list* atau *menu* untuk melihat produk toko kami.",
    goodbyeEnabled: "true",
    goodbyeMessage: "👋 Sampai jumpa!",

    // Persyaratan Wajib Join Grup Sebelum Beli
    requireGroupJoin: "true",
    groupInviteLink: "",

    // Fitur Kuis Otomatis Terjadwal (Spam Preventer)
    autoQuizEnabled: "false",

    // Fitur Jadwal Sholat & Adzan Otomatis Grup
    autoSholatEnabled: "true",
    sholatCity: "Jakarta",

    // Anti-Ban & Human-Like Typing Delay
    humanDelayEnabled: "true"
  },

  // ============================================================
  // CASAKU PAYMENT GATEWAY (QRIS Otomatis via Android Helper)
  // Set nilai-nilai ini di file .env (jangan di-commit ke Git):
  //   CASAKU_LICENSE_KEY=xxx
  //   CASAKU_WEBHOOK_SECRET=xxx
  //   CASAKU_QRIS_ID=xxx
  //   CASAKU_PACKAGE_IDS=id.dana        (pisah koma jika lebih dari satu)
  //   CASAKU_QR_EXPIRY_MINUTES=15
  // ============================================================
  casaku: {
    licenseKey: process.env.CASAKU_LICENSE_KEY || '',
    webhookSecret: process.env.CASAKU_WEBHOOK_SECRET || '',
    qrisId: process.env.CASAKU_QRIS_ID || '',
    packageIds: process.env.CASAKU_PACKAGE_IDS || 'id.dana',
    expiryMinutes: parseInt(process.env.CASAKU_QR_EXPIRY_MINUTES || '15', 10),
  }
};
