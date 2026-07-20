import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { createServer } from 'http';

import { config } from './config.js';
import * as db from './database.js';
import { reloadBotSettings, checkAndNotifySubscribers, startBot } from './bot.js';
import { backupDatabase } from './scheduler.js';
import { initWebSocket, broadcastToAdmins } from './websocket.js';
import * as chatManager from './chatManager.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sesi / Status Bot Global yang dishare dari index.js
export const botState = {
  status: 'OFFLINE', // OFFLINE, CONNECTING, ONLINE
  lastReconnect: null,
  whatsappConnected: false,
  sock: null // Instansi soket Baileys
};

// Pastikan direktori upload ada
const ensureDirExists = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};
ensureDirExists('./public/uploads/products');
ensureDirExists('./public/receipts');

// --- SETUP MULTER UNTUK FILE UPLOADS ---

// Storage gambar produk
const productStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, './public/uploads/products');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const code = (req.body.kode || 'PROD').toUpperCase().replace(/[^A-Z0-9]/g, '');
    cb(null, `${code}_${Date.now()}${ext}`);
  }
});
const uploadProduct = multer({ storage: productStorage });

// Storage QRIS
const qrisStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureDirExists('./public/uploads');
    cb(null, './public/uploads');
  },
  filename: (req, file, cb) => {
    cb(null, 'qris.png'); // Selalu menimpa qris.png lama
  }
});
const uploadQris = multer({ storage: qrisStorage });

// --- MIDDLEWARE AUTENTIKASI JWT ---

function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.split(' ')[1]; // Bearer <token>
    jwt.verify(token, config.jwtSecret, (err, user) => {
      if (err) {
        return res.status(403).json({ success: false, message: "Token kadaluarsa atau tidak valid." });
      }
      req.user = user;
      next();
    });
  } else {
    res.status(401).json({ success: false, message: "Akses ditolak. Token tidak ditemukan." });
  }
}

// Middleware untuk memverifikasi hak akses peran (Roles)
function authorizeRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ 
        success: false, 
        message: `Akses ditolak. Peran Anda (${req.user ? req.user.role : 'None'}) tidak memiliki izin.` 
      });
    }
    next();
  };
}

// Serve file statis di folder public
app.use(express.static('public'));

// Serve gambar bukti transfer dan upload secara aman
app.use('/receipts', express.static('public/receipts'));
app.use('/uploads', express.static('public/uploads'));

// --- API AUTHENTICATION (MULTI-ROLE) ---

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: "Username dan password harus diisi." });
    }

    const user = await db.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ success: false, message: "Username atau password salah." });
    }

    const passwordMatched = bcrypt.compareSync(password, user.password_hash);
    if (!passwordMatched) {
      return res.status(401).json({ success: false, message: "Username atau password salah." });
    }

    // Buat token JWT dengan payload username dan role
    const token = jwt.sign(
      { username: user.username, role: user.role }, 
      config.jwtSecret, 
      { expiresIn: '24h' }
    );

    return res.json({ 
      success: true, 
      token, 
      username: user.username, 
      role: user.role 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- API MONITORING & STATS ---

// Diizinkan untuk semua role yang telah login
app.get('/api/bot-status', authenticateJWT, (req, res) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memoryUsage = ((totalMem - freeMem) / totalMem * 100).toFixed(1);
  const loadAvg = os.loadavg();
  const cpuUsage = loadAvg[0] ? (loadAvg[0] * 10).toFixed(1) : "0.0";

  res.json({
    success: true,
    bot: {
      status: botState.status,
      lastReconnect: botState.lastReconnect,
      whatsappConnected: botState.whatsappConnected
    },
    system: {
      memoryUsage: `${memoryUsage}%`,
      cpuUsage: `${cpuUsage}%`,
      uptime: `${(os.uptime() / 3600).toFixed(1)} jam`,
      platform: `${os.platform()} (${os.arch()})`
    }
  });
});

// Hanya Owner yang berhak melihat statistik finansial toko
app.get('/api/stats', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json({
      success: true,
      stats: {
        ...stats,
        botStatus: botState.status
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Hanya Owner yang memiliki akses halaman Analitik
app.get('/api/analytics', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const data = await db.getAnalyticsData();
    res.json({ success: true, analytics: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- API MANAJEMEN PRODUK ---

// Semua role diizinkan membaca produk
app.get('/api/products', authenticateJWT, async (req, res) => {
  try {
    const products = await db.getProducts();
    res.json({ success: true, products });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Owner dan Admin bisa menulis/edit produk
app.post('/api/products', authenticateJWT, authorizeRoles('Owner', 'Admin'), uploadProduct.single('gambar'), async (req, res) => {
  try {
    const { kode, nama, harga, stok, deskripsi, delivery_type } = req.body;
    if (!kode || !nama || !harga || !stok) {
      return res.status(400).json({ success: false, message: "Kolom kode, nama, harga, dan stok wajib diisi." });
    }

    let gambarUrl = req.body.gambar_existing || "";
    if (req.file) {
      gambarUrl = `/uploads/products/${req.file.filename}`;
    }

    await db.addProduct(kode, nama, parseInt(harga), parseInt(stok), deskripsi, gambarUrl, delivery_type || 'MANUAL');
    await checkAndNotifySubscribers(kode, parseInt(stok));
    res.json({ success: true, message: "Produk berhasil disimpan." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Owner dan Admin bisa menghapus produk
app.delete('/api/products/:kode', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { kode } = req.params;
    await db.deleteProduct(kode);
    res.json({ success: true, message: "Produk berhasil dihapus." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Owner dan Admin bisa melihat list item kredensial stok digital
app.get('/api/products/:kode/items', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { kode } = req.params;
    const items = await db.getProductItems(kode);
    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Owner dan Admin bisa menambahkan massal kredensial stok digital
app.post('/api/products/:kode/items', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { kode } = req.params;
    const { items } = req.body; // array string
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "Kredensial wajib diset dalam bentuk array." });
    }
    const updatedStock = await db.addProductItems(kode, items);
    res.json({ success: true, message: `Berhasil menambahkan ${items.length} kredensial stok.`, stock: updatedStock });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Owner dan Admin bisa menghapus satu kredensial stok digital
app.delete('/api/products/items/:id', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { id } = req.params;
    await db.deleteProductItem(id);
    res.json({ success: true, message: "Item kredensial berhasil dihapus." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- API MANAJEMEN ORDERS (PEMROSESAN & NOTIFIKASI WA) ---

// Semua role diizinkan melihat tabel orders
app.get('/api/orders', authenticateJWT, async (req, res) => {
  try {
    const orders = await db.getAllOrders();
    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Pengolahan order action (pembatasan berdasarkan role di dalam handler)
app.post('/api/orders/:orderId/action', authenticateJWT, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { action } = req.body; // approve, complete, reject
    const userRole = req.user.role;

    if (!['approve', 'complete', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: "Aksi tidak dikenal." });
    }

    // Batasan role untuk tindakan order:
    // CS hanya boleh menandai selesai (complete).
    if (userRole === 'CS' && action !== 'complete') {
      return res.status(403).json({ 
        success: false, 
        message: "Akses Ditolak. Customer Service hanya memiliki izin untuk menandai pesanan selesai (COMPLETED)." 
      });
    }

    let nextStatus = "";
    let customerMessage = "";

    if (action === 'approve') {
      nextStatus = "PAID";
      customerMessage = `🔔 *INFO PESANAN (Order: ${orderId})*
      
Pembayaran Anda telah *DITERIMA* dan diverifikasi oleh admin. Pesanan Anda saat ini sedang diproses. Harap menunggu informasi selanjutnya. Terima kasih!`;
    } else if (action === 'complete') {
      nextStatus = "COMPLETED";
      customerMessage = `🔔 *INFO PESANAN (Order: ${orderId})*
      
Pesanan Anda telah *SELESAI* diproses / dikirimkan oleh admin!
Silakan cek akun/detail pesanan Anda. Jika ada kendala, hubungi admin. Terima kasih telah berbelanja! 🙏`;
    } else if (action === 'reject') {
      nextStatus = "CANCELLED";
      customerMessage = `🔔 *INFO PESANAN (Order: ${orderId})*
      
Mohon maaf, pesanan Anda dengan Order ID *${orderId}* telah *DIBATALKAN* oleh admin. Jika Anda sudah mentransfer, silakan hubungi admin di chat ini untuk konfirmasi manual.`;
    }

    // Update status di SQLite
    const updateRes = await db.updateOrderStatus(orderId, nextStatus);
    if (!updateRes.success) {
      return res.status(400).json({ success: false, message: updateRes.message });
    }

    // Kirim notifikasi WA otomatis jika bot terkoneksi
    let waSent = false;
    if (botState.sock && botState.whatsappConnected) {
      try {
        await botState.sock.sendMessage(updateRes.customerNomor, { text: customerMessage });
        waSent = true;
      } catch (err) {
        console.error(`Gagal mengirim notifikasi WA ke pelanggan untuk order ${orderId}:`, err.message);
      }
    }

    res.json({ 
      success: true, 
      message: `Pesanan berhasil di-update ke status *${nextStatus}*.`,
      waNotified: waSent 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint menghapus 1 order (Admin & Owner)
app.delete('/api/orders/:orderId', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const result = await db.deleteOrder(orderId);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint pembersihan riwayat order massal (Admin & Owner)
app.post('/api/orders/clear', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { filter } = req.body;
    const result = await db.clearOrders(filter || 'ALL');
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- API MANAJEMEN CUSTOMERS ---

// Owner dan Admin bisa melihat daftar customer
app.get('/api/customers', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const customers = await db.getCustomersWithTiers();
    res.json({ success: true, customers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Owner dan Admin bisa melihat detail customer
app.get('/api/customers/:nomor', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const details = await db.getCustomerDetails(req.params.nomor);
    if (!details) {
      return res.status(404).json({ success: false, message: "Customer tidak ditemukan." });
    }
    res.json({ success: true, customer: details });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- API SETTINGS & QRIS (KHUSUS OWNER) ---

app.get('/api/settings', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const settings = await db.getSettings();
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/settings', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    await db.updateSettings(req.body);
    await reloadBotSettings();
    res.json({ success: true, message: "Pengaturan berhasil diperbarui." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/settings/qris', authenticateJWT, authorizeRoles('Owner'), uploadQris.single('qris'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Gambar QRIS wajib diupload." });
    }
    await db.addLog("SYSTEM", "Gambar QRIS pembayaran diperbarui via Web Dashboard.");
    res.json({ success: true, message: "Gambar QRIS pembayaran berhasil diperbarui." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint untuk memicu manual backup database
app.get('/api/settings/backup', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const backupFile = backupDatabase();
    if (backupFile && fs.existsSync(backupFile)) {
      res.download(backupFile, 'shop_backup.db');
    } else {
      res.status(500).json({ success: false, message: "Gagal membuat file cadangan database." });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- API LOGS (KHUSUS OWNER) ---

app.get('/api/logs', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const filter = req.query.type || "ALL";
    const logs = await db.getLogs(filter);
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- API BROADCAST (KHUSUS OWNER) ---

app.post('/api/broadcast', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const { message, targetTier, delay } = req.body;
    if (!message) {
      return res.status(400).json({ success: false, message: "Pesan broadcast wajib diisi." });
    }

    const broadcastDelay = parseInt(delay) || 3000;
    const customers = await db.getCustomersWithTiers();
    
    // Filter berdasarkan target tier
    const targetCustomers = targetTier === 'ALL' 
      ? customers 
      : customers.filter(c => c.tier.toUpperCase() === targetTier.toUpperCase());

    if (targetCustomers.length === 0) {
      return res.status(400).json({ success: false, message: `Tidak ada pelanggan dengan kriteria tier *${targetTier}*` });
    }

    // Jalankan broadcast di background dengan delay acak
    runBroadcastInBackground(targetCustomers, message, broadcastDelay);

    res.json({ 
      success: true, 
      message: `Proses siaran (broadcast) dimulai di background untuk *${targetCustomers.length}* pelanggan.`,
      targetCount: targetCustomers.length
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Fungsi pembantu broadcast background dengan jeda acak (+ 0 s.d 4 detik)
async function runBroadcastInBackground(customers, messageText, delayMs) {
  await db.addLog("BROADCAST", `Memulai siaran pesan ke ${customers.length} pelanggan dengan jeda acak.`);
  let successCount = 0;

  for (const c of customers) {
    if (botState.sock && botState.whatsappConnected) {
      try {
        await botState.sock.sendMessage(c.nomor, { text: messageText });
        successCount++;
        // Hitung jeda acak: delay dasar + antara 0 s.d 4000 md
        const randomDelay = Math.floor(Math.random() * 4001) + delayMs;
        console.log(`[BROADCAST] Terkirim ke ${c.nomor}. Menunggu ${randomDelay} ms...`);
        await new Promise(resolve => setTimeout(resolve, randomDelay));
      } catch (err) {
        console.error(`Gagal kirim broadcast ke nomor ${c.nomor}:`, err.message);
        await db.addLog("ERROR", `Gagal kirim broadcast ke ${c.nomor}: ${err.message}`);
      }
    } else {
      console.warn(`Soket WhatsApp tidak siap. Broadcast dihentikan.`);
      await db.addLog("ERROR", "Broadcast terhenti karena koneksi bot terputus.");
      break;
    }
  }

  await db.addLog("BROADCAST", `Selesai menyiarkan pesan. Sukses terkirim ke ${successCount}/${customers.length} pelanggan.`);
}

// --- API MANAJEMEN PENGGUNA (KHUSUS OWNER) ---

app.get('/api/users', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const users = await db.getUsers();
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/users', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password || !role) {
      return res.status(400).json({ success: false, message: "Semua kolom (username, password, role) wajib diisi." });
    }
    if (!['Owner', 'Admin', 'CS'].includes(role)) {
      return res.status(400).json({ success: false, message: "Role tidak valid." });
    }

    const existing = await db.getUserByUsername(username);
    if (existing) {
      return res.status(400).json({ success: false, message: "Username sudah terdaftar." });
    }

    await db.addUser(username, password, role);
    res.json({ success: true, message: `Akun ${username} (${role}) berhasil ditambahkan.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/users/:username', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const { password } = req.body;
    const { username } = req.params;
    if (!password) {
      return res.status(400).json({ success: false, message: "Password baru wajib diisi." });
    }

    await db.updateUserPassword(username, password);
    res.json({ success: true, message: `Password untuk akun ${username} berhasil diubah.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/users/:username', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const { username } = req.params;
    if (username.toLowerCase() === req.user.username.toLowerCase()) {
      return res.status(400).json({ success: false, message: "Anda tidak dapat menghapus akun Anda sendiri." });
    }

    await db.deleteUser(username);
    res.json({ success: true, message: `Akun ${username} berhasil dihapus.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint untuk mereset sesi WhatsApp secara paksa (Owner Only)
app.post('/api/settings/session/reset', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    console.log("[SYSTEM] Owner memicu reset sesi WhatsApp...");
    await db.addLog("SYSTEM", "Owner memicu reset sesi WhatsApp secara paksa.");
    
    // Matikan socket lama jika ada
    if (botState.sock) {
      try {
        botState.sock.logout();
      } catch (e) {
        botState.sock.end();
      }
    }
    
    botState.status = 'OFFLINE';
    botState.whatsappConnected = false;
    botState.sock = null;

    // Hapus folder sesi secara aman
    const sessionFolder = './session';
    if (fs.existsSync(sessionFolder)) {
      fs.rmSync(sessionFolder, { recursive: true, force: true });
    }

    res.json({ success: true, message: "Sesi WhatsApp berhasil direset. Silakan scan ulang QR code baru yang muncul di server." });

    // Hubungkan kembali di background
    setTimeout(() => {
      startBot();
    }, 2000);

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- METODE INTEGRASI LIVE CHAT & MEDIA UPLOADS ---

// Folder upload media obrolan
ensureDirExists('./public/uploads/chat_media');
const chatMediaStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, './public/uploads/chat_media');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const hash = crypto.randomBytes(8).toString('hex');
    cb(null, `chat_${Date.now()}_${hash}${ext}`);
  }
});

const ALLOWED_MIMES_EXTS = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/gif': ['gif'],
  'application/pdf': ['pdf'],
  'application/zip': ['zip'],
  'application/x-zip-compressed': ['zip'],
  'application/vnd.android.package-archive': ['apk'],
  'video/mp4': ['mp4'],
  'audio/mpeg': ['mp3'],
  'audio/mp3': ['mp3'],
  'audio/wav': ['wav'],
  'audio/x-wav': ['wav'],
  'audio/ogg': ['ogg'],
  'audio/m4a': ['m4a'],
  'audio/x-m4a': ['m4a']
};

const uploadChatMedia = multer({
  storage: chatMediaStorage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB Max Global limit
  },
  fileFilter: (req, file, cb) => {
    const fileMime = file.mimetype;
    const fileExt = path.extname(file.originalname).toLowerCase().replace('.', '');
    const allowedExts = ALLOWED_MIMES_EXTS[fileMime];
    
    if (!allowedExts || !allowedExts.includes(fileExt)) {
      return cb(new Error(`Tipe berkas tidak diizinkan: Ekstensi .${fileExt} dengan MIME ${fileMime} tidak cocok.`));
    }
    cb(null, true);
  }
});

// Rute untuk mengunggah media chat (MIME + Extension + Size check)
app.post('/api/chats/media', authenticateJWT, (req, res) => {
  uploadChatMedia.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Tidak ada berkas yang diunggah." });
    }

    const filepath = req.file.path.replace(/\\/g, '/');
    const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
    const size = req.file.size;

    // Batasan ukuran spesifik per tipe file
    let maxSize = 5 * 1024 * 1024; // Default 5MB
    if (['png', 'jpg', 'jpeg', 'gif'].includes(ext)) maxSize = 10 * 1024 * 1024; // 10MB
    else if (ext === 'pdf') maxSize = 20 * 1024 * 1024; // 20MB
    else if (['zip', 'apk'].includes(ext)) maxSize = 100 * 1024 * 1024; // 100MB
    else if (ext === 'mp4') maxSize = 50 * 1024 * 1024; // 50MB
    else if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) maxSize = 20 * 1024 * 1024; // 20MB

    if (size > maxSize) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
      return res.status(400).json({ 
        success: false, 
        message: `Berkas terlalu besar. Batas ukuran untuk file .${ext} adalah ${(maxSize / (1024 * 1024))}MB.` 
      });
    }

    const relativeUrl = `/uploads/chat_media/${req.file.filename}`;
    res.json({ success: true, url: relativeUrl, path: filepath });
  });
});

// Endpoint mengambil daftar chat
app.get('/api/chats', authenticateJWT, async (req, res) => {
  try {
    const list = await db.getConversationsList();
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint mengambil riwayat pesan per customer
app.get('/api/chats/:nomor/messages', authenticateJWT, async (req, res) => {
  try {
    const { nomor } = req.params;
    const messages = await db.getConversationMessages(nomor);
    res.json({ success: true, data: messages });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint mengirim pesan dari dashboard
app.post('/api/chats/:nomor/send', authenticateJWT, async (req, res) => {
  try {
    const { nomor } = req.params;
    const { messageType, message, mediaPath, quotedId } = req.body;

    if (!messageType) {
      return res.status(400).json({ success: false, message: "messageType wajib diisi." });
    }

    const result = await chatManager.enqueueOutgoingMessage({
      customerJid: nomor,
      messageType,
      message,
      mediaPath,
      quotedId,
      adminUsername: req.user.username
    });

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint mengubah status Take Over percakapan
app.post('/api/chats/:nomor/takeover', authenticateJWT, async (req, res) => {
  try {
    const { nomor } = req.params;
    const { state } = req.body; // 'BOT', 'ADMIN', 'CLOSED', 'ARCHIVED'

    if (!['BOT', 'ADMIN', 'CLOSED', 'ARCHIVED'].includes(state)) {
      return res.status(400).json({ success: false, message: "State tidak valid." });
    }

    await db.updateConversationState(nomor, state, state === 'BOT' ? null : req.user.username);
    await db.addLog('SYSTEM', `Admin ${req.user.username} mengubah status chat ${nomor} menjadi ${state}`);

    // Siarkan pembaruan ke Socket.IO
    broadcastToAdmins('conversation_state_changed', {
      customer_jid: nomor,
      conversation_state: state,
      assigned_admin_id: state === 'BOT' ? null : req.user.username
    });

    res.json({ success: true, message: `Status percakapan diubah ke ${state}.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint menandai chat telah dibaca oleh admin (reset unread)
app.post('/api/chats/:nomor/read', authenticateJWT, async (req, res) => {
  try {
    const { nomor } = req.params;
    await db.updateConversationReadStatus(nomor);
    
    // Siarkan pembaruan unread ke Socket.IO
    broadcastToAdmins('conversation_read', {
      customer_jid: nomor
    });

    res.json({ success: true, message: "Status unread berhasil di-reset." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint mengubah internal notes customer
app.post('/api/chats/:nomor/notes', authenticateJWT, async (req, res) => {
  try {
    const { nomor } = req.params;
    const { notes } = req.body;
    
    await db.updateConversationNotes(nomor, notes);
    await db.addLog('CHAT', `Admin ${req.user.username} memperbarui internal note untuk ${nomor}`);

    // Siarkan ke Socket.IO
    broadcastToAdmins('conversation_notes_updated', {
      customer_jid: nomor,
      internal_notes: notes
    });

    res.json({ success: true, message: "Catatan internal berhasil diperbarui." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint mengubah labels customer
app.post('/api/chats/:nomor/labels', authenticateJWT, async (req, res) => {
  try {
    const { nomor } = req.params;
    const { labels } = req.body; // e.g. "VIP,Priority"
    
    await db.updateConversationLabels(nomor, labels);
    await db.addLog('CHAT', `Admin ${req.user.username} mengubah label customer ${nomor} menjadi: ${labels}`);

    // Siarkan ke Socket.IO
    broadcastToAdmins('conversation_labels_updated', {
      customer_jid: nomor,
      labels
    });

    res.json({ success: true, message: "Label customer berhasil diperbarui." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint mengubah pin chat status
app.post('/api/chats/:nomor/pin', authenticateJWT, async (req, res) => {
  try {
    const { nomor } = req.params;
    const { isPinned } = req.body;

    await db.updateConversationPin(nomor, isPinned);

    // Siarkan ke Socket.IO
    broadcastToAdmins('conversation_pin_updated', {
      customer_jid: nomor,
      is_pinned: isPinned ? 1 : 0
    });

    res.json({ success: true, message: `Status pin chat diubah.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- METODE INTEGRASI MIDTRANS & WEBHOOK ---

// Fungsi Helper untuk membuat transaksi Midtrans Snap
export async function createMidtransTransaction(order) {
  const serverKey = await db.getSetting('midtransServerKey');
  const sandboxMode = await db.getSetting('midtransSandboxMode');
  
  if (!serverKey) {
    console.warn("[MIDTRANS] Server Key tidak diset. Pembayaran otomatis dilewati.");
    return null;
  }

  const isSandbox = sandboxMode !== "false";
  const baseUrl = isSandbox 
    ? 'https://app.sandbox.midtrans.com/snap/v1/transactions'
    : 'https://app.midtrans.com/snap/v1/transactions';

  const authHeader = 'Basic ' + Buffer.from(serverKey + ':').toString('base64');
  const cleanPhone = order.customer_nomor.split('@')[0];

  const payload = {
    transaction_details: {
      order_id: order.order_id,
      gross_amount: order.total
    },
    credit_card: {
      secure: true
    },
    customer_details: {
      first_name: order.customer_nama,
      phone: cleanPhone
    },
    expiry: {
      unit: "minutes",
      duration: 30
    }
  };

  try {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (res.ok && data.redirect_url) {
      await db.updateOrderPaymentLink(order.order_id, data.redirect_url, 'pending');
      return data;
    } else {
      console.error("[MIDTRANS ERROR] Gagal membuat transaksi:", data);
      return null;
    }
  } catch (err) {
    console.error("[MIDTRANS ERROR] Gagal menghubungi Midtrans Snap:", err.message);
    return null;
  }
}

// Endpoint Webhook untuk menerima notifikasi dari Midtrans (Public Access)
app.post('/api/payment/webhook', async (req, res) => {
  try {
    const notification = req.body;
    const { order_id, status_code, gross_amount, signature_key, transaction_status } = notification;

    if (!order_id || !status_code || !gross_amount || !signature_key) {
      return res.status(400).json({ success: false, message: "Payload tidak lengkap." });
    }

    const serverKey = await db.getSetting('midtransServerKey');
    if (!serverKey) {
      return res.status(500).json({ success: false, message: "Midtrans Server Key belum diatur di database." });
    }

    // Validasi Signature resmi Midtrans: SHA512(order_id + status_code + gross_amount + server_key)
    const signatureSource = order_id + status_code + gross_amount + serverKey;
    const calculatedSignature = crypto.createHash('sha512').update(signatureSource).digest('hex');

    if (calculatedSignature !== signature_key) {
      console.warn(`[MIDTRANS WEBHOOK WARNING] Tanda tangan tidak cocok untuk order ${order_id}!`);
      await db.addLog("ERROR", `Peringatan Keamanan: Signature webhook Midtrans tidak cocok untuk Order ID ${order_id}.`);
      return res.status(403).json({ success: false, message: "Signature tidak valid." });
    }

    console.log(`[MIDTRANS WEBHOOK] Signature valid. Order ID: ${order_id}. Status: ${transaction_status}`);

    const order = await db.getOrderDetails(order_id);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order ID tidak ditemukan." });
    }

    // Hanya proses jika status saat ini sedang menunggu pembayaran
    if (order.status === 'WAITING_PAYMENT') {
      if (transaction_status === 'settlement' || transaction_status === 'capture') {
        // Pembayaran Sukses!
        await db.updateOrderStatus(order_id, 'PAID');
        await db.addLog("PAYMENT", `Pembayaran lunas terverifikasi via Midtrans untuk Order ID ${order_id}.`);

        let waSent = false;
        let deliveredItemsMsg = "";
        let hasAutoDelivery = false;

        // Cek jika produk bertipe AUTO (Auto-Send)
        const claims = await db.claimAndDeliverItems(order_id);
        const productCodes = Object.keys(claims);

        if (productCodes.length > 0) {
          hasAutoDelivery = true;
          // Format pesan kredensial otomatis
          deliveredItemsMsg = `🎁 *PENGIRIMAN PRODUK OTOMATIS*\n\nTerima kasih! Pembayaran Anda telah kami terima dan terverifikasi secara otomatis oleh sistem.\n\nBerikut adalah detail produk digital Anda:\n`;
          
          for (const code of productCodes) {
            const itemClaim = claims[code];
            deliveredItemsMsg += `\n*${itemClaim.produk_nama}* (\`${code}\`):\n`;
            itemClaim.credentials.forEach((cred) => {
              deliveredItemsMsg += `👉 \`${cred}\`\n`;
            });
          }

          deliveredItemsMsg += `\n_Silakan simpan detail di atas. Hubungi CS jika menemui kendala login atau penggunaan. Selamat menikmati!_`;
          
          // Ubah status order langsung ke COMPLETED karena produk sudah dikirim otomatis
          await db.updateOrderStatus(order_id, 'COMPLETED');
        } else {
          // Jika MANUAL, beri notifikasi standar
          deliveredItemsMsg = `🔔 *INFO PESANAN (Order: ${order_id})*
      
Pembayaran Anda telah *DITERIMA* dan terverifikasi secara otomatis oleh sistem. Pesanan Anda saat ini sedang diproses manual oleh admin kami. Harap menunggu. Terima kasih!`;
        }

        // Kirim notifikasi WA ke pelanggan
        if (botState.sock && botState.whatsappConnected) {
          try {
            await botState.sock.sendMessage(order.customer_nomor, { text: deliveredItemsMsg });
            waSent = true;
          } catch (err) {
            console.error(`[WEBHOOK ERROR] Gagal mengirim pesan WA ke pelanggan:`, err.message);
          }
        }

        return res.json({ 
          success: true, 
          message: "Status pembayaran berhasil diperbarui.", 
          orderStatus: hasAutoDelivery ? 'COMPLETED' : 'PAID',
          waSent 
        });

      } else if (transaction_status === 'expire' || transaction_status === 'cancel' || transaction_status === 'deny') {
        // Pembayaran Batal / Kadaluarsa
        await db.updateOrderStatus(order_id, 'CANCELLED');
        await db.addLog("ORDER", `Order ID ${order_id} dibatalkan otomatis oleh Webhook Midtrans (Status: ${transaction_status}).`);

        const cancelMsg = `🔔 *PEMBERITAHUAN PEMBATALAN PEMBAYARAN*

Pesanan Anda dengan Order ID *${order_id}* telah dibatalkan karena link pembayaran telah kedaluwarsa atau transaksi ditolak.

Silakan lakukan pemesanan ulang (ketik *menu*) jika Anda masih berminat membeli produk. Terima kasih.`;

        if (botState.sock && botState.whatsappConnected) {
          try {
            await botState.sock.sendMessage(order.customer_nomor, { text: cancelMsg });
          } catch (err) {
            console.error(`Gagal mengirim pembatalan WA ke pelanggan:`, err.message);
          }
        }

        return res.json({ success: true, message: "Order berhasil dibatalkan otomatis." });
      }
    }

    res.json({ success: true, message: "Webhook diterima, status order saat ini tidak dimodifikasi." });

  } catch (err) {
    console.error("[WEBHOOK ERROR]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Server global instance
let serverInstance = null;

// Inisialisasi start server
export function startServer() {
  const port = config.port;
  serverInstance = createServer(app);
  
  // Bind Socket.IO ke server
  initWebSocket(serverInstance);

  serverInstance.listen(port, () => {
    console.log(`=== Dashboard Admin Web Berjalan di http://localhost:${port} ===`);
  }).on('error', (err) => {
    console.error(`Gagal menjalankan server di port ${port}:`, err.message);
  });
}
