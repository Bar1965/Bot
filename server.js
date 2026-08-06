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
import { backupDatabase, startScheduler } from './scheduler.js';
import { initWebSocket, broadcastToAdmins } from './websocket.js';
import * as chatManager from './chatManager.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const authCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 24 * 60 * 60 * 1000,
  path: '/'
};
const loginAttempts = new Map();

function getCookieValue(req, name) {
  const cookies = req.headers.cookie?.split(';') || [];
  const prefix = `${name}=`;
  const entry = cookies.find(cookie => cookie.trim().startsWith(prefix));
  return entry ? decodeURIComponent(entry.trim().slice(prefix.length)) : null;
}

function isLoginAllowed(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 5;
  const recent = (loginAttempts.get(ip) || []).filter(timestamp => now - timestamp < windowMs);
  loginAttempts.set(ip, recent);
  return recent.length < maxAttempts;
}

function recordLoginAttempt(ip) {
  const attempts = loginAttempts.get(ip) || [];
  attempts.push(Date.now());
  loginAttempts.set(ip, attempts);
}

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value) {
  const normalized = String(value || '').replace(/=+$/g, '').toUpperCase();
  let bits = 0;
  let current = 0;
  const output = [];
  for (const character of normalized) {
    const index = base32Alphabet.indexOf(character);
    if (index < 0) return null;
    current = (current << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((current >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function verifyTotp(secret, token) {
  if (!secret || !/^\d{6}$/.test(String(token || '').trim())) return false;
  const key = decodeBase32(secret);
  if (!key) return false;
  const submitted = String(token).trim();
  const currentStep = Math.floor(Date.now() / 1000 / 30);
  for (let offset = -1; offset <= 1; offset += 1) {
    const counter = Buffer.alloc(8);
    counter.writeBigInt64BE(BigInt(currentStep + offset));
    const digest = crypto.createHmac('sha1', key).update(counter).digest();
    const dynamicOffset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[dynamicOffset] & 0x7f) << 24)
      | ((digest[dynamicOffset + 1] & 0xff) << 16)
      | ((digest[dynamicOffset + 2] & 0xff) << 8)
      | (digest[dynamicOffset + 3] & 0xff);
    const expected = String(binary % 1_000_000).padStart(6, '0');
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(submitted))) return true;
  }
  return false;
}

// Sesi / Status Bot Global yang dishare dari index.js & bot.js
export const botState = {
  status: 'OFFLINE', // OFFLINE, CONNECTING, ONLINE
  lastReconnect: null,
  whatsappConnected: false,
  sock: null, // Instansi soket Baileys
  reconnectCount: 0,
  lastDisconnectReason: null,
  lastCredUpdate: null,
  lastSentTimestamp: null,
  pendingQueueCount: 0,
  signalKeysOk: true
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
const imageUploadFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.mimetype)) {
    return cb(new Error('Format gambar harus JPG, PNG, atau WebP.'));
  }
  cb(null, true);
};
const qrisUploadFilter = (req, file, cb) => {
  if (!['image/jpeg', 'image/png'].includes(file.mimetype)) {
    return cb(new Error('Format QRIS harus JPG atau PNG.'));
  }
  cb(null, true);
};
const uploadProduct = multer({
  storage: productStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: imageUploadFilter
});
const uploadQris = multer({
  storage: qrisStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: qrisUploadFilter
});

// --- MIDDLEWARE AUTENTIKASI JWT ---

function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = bearerToken || getCookieValue(req, 'auth_token');
  if (token) {
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

// Serve hanya halaman dashboard dan aset yang memang bersifat publik.
app.get('/', (req, res) => res.sendFile(path.resolve('public/index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.resolve('public/index.html')));
app.get('/login.html', (req, res) => res.sendFile(path.resolve('public/login.html')));
app.use('/uploads/products', express.static(path.resolve('public/uploads/products')));
app.get('/uploads/qris.png', (req, res) => res.sendFile(path.resolve('public/uploads/qris.png')));
app.get('/api/chats/media/:filename', authenticateJWT, (req, res) => {
  const mediaRoot = path.resolve('public/uploads/chat_media');
  const filename = path.basename(req.params.filename);
  const mediaPath = path.join(mediaRoot, filename);
  if (!mediaPath.startsWith(`${mediaRoot}${path.sep}`) || !fs.existsSync(mediaPath)) {
    return res.status(404).json({ success: false, message: "Media tidak ditemukan." });
  }
  res.sendFile(mediaPath);
});

// Bukti transfer wajib dilindungi autentikasi dashboard.
app.use('/receipts', authenticateJWT, express.static(path.resolve('public/receipts')));

// --- API AUTHENTICATION (MULTI-ROLE) ---

app.post('/api/login', async (req, res) => {
  try {
    const { username, password, otp } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return res.status(400).json({ success: false, message: "Username dan password harus diisi." });
    }
    const normalizedUsername = username.trim();
    if (normalizedUsername.length > 80 || password.length > 200) {
      return res.status(400).json({ success: false, message: "Data login tidak valid." });
    }

    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    if (!isLoginAllowed(clientIp)) {
      return res.status(429).json({ success: false, message: "Terlalu banyak percobaan login. Coba lagi dalam 15 menit." });
    }
    recordLoginAttempt(clientIp);

    const user = await db.getUserByUsername(normalizedUsername);
    const isConfiguredAdmin = normalizedUsername === config.adminUser;
    if (!user && !isConfiguredAdmin) {
      return res.status(401).json({ success: false, message: "Username atau password salah." });
    }

    const passwordMatched = isConfiguredAdmin
      ? bcrypt.compareSync(password, config.adminPasswordHash)
      : bcrypt.compareSync(password, user.password_hash);
    if (!passwordMatched) {
      return res.status(401).json({ success: false, message: "Username atau password salah." });
    }

    if (user && Number(user.two_factor_enabled) === 1 && !verifyTotp(user.two_factor_secret, otp)) {
      return res.status(401).json({
        success: false,
        requiresTwoFactor: true,
        message: otp ? "Kode authenticator tidak valid atau sudah kedaluwarsa." : "Masukkan kode 6 digit dari aplikasi authenticator."
      });
    }

    loginAttempts.delete(clientIp);

    const authenticatedUser = user || { username: config.adminUser, role: 'Owner' };

    // Buat token JWT dengan payload username dan role
    const token = jwt.sign(
      { username: authenticatedUser.username, role: authenticatedUser.role },
      config.jwtSecret, 
      { expiresIn: '24h' }
    );

    res.cookie('auth_token', token, authCookieOptions);
    return res.json({ 
      success: true, 
      username: authenticatedUser.username,
      role: authenticatedUser.role
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/logout', authenticateJWT, (req, res) => {
  res.clearCookie('auth_token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/'
  });
  res.json({ success: true });
});

app.get('/api/session', authenticateJWT, (req, res) => {
  res.json({ success: true, user: req.user });
});

app.get('/api/2fa/status', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const user = await db.getUserByUsername(req.user.username);
    res.json({ success: true, enabled: Boolean(user?.two_factor_enabled), hasSecret: Boolean(user?.two_factor_secret) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/2fa/setup', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const user = await db.getUserByUsername(req.user.username);
    if (!user) return res.status(404).json({ success: false, message: "Akun Owner tidak ditemukan." });
    if (Number(user.two_factor_enabled) === 1) {
      return res.status(400).json({ success: false, message: "2FA sudah aktif pada akun ini." });
    }
    const secret = encodeBase32(crypto.randomBytes(20));
    await db.setTwoFactorSecret(user.username, secret);
    const label = encodeURIComponent(`Akbar Store:${user.username}`);
    const otpauthUri = `otpauth://totp/${label}?secret=${secret}&issuer=Akbar%20Store`;
    res.json({ success: true, secret, otpauthUri, message: "Secret 2FA dibuat. Tambahkan ke aplikasi authenticator lalu verifikasi kodenya." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/2fa/enable', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const user = await db.getUserByUsername(req.user.username);
    if (!user?.two_factor_secret) return res.status(400).json({ success: false, message: "Buat setup 2FA terlebih dahulu." });
    if (!verifyTotp(user.two_factor_secret, req.body.code)) {
      return res.status(400).json({ success: false, message: "Kode authenticator tidak valid." });
    }
    await db.setTwoFactorEnabled(user.username, true);
    res.json({ success: true, message: "2FA berhasil diaktifkan untuk akun Owner." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/2fa/disable', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const user = await db.getUserByUsername(req.user.username);
    if (!user?.two_factor_secret || !verifyTotp(user.two_factor_secret, req.body.code)) {
      return res.status(400).json({ success: false, message: "Kode authenticator tidak valid." });
    }
    await db.disableTwoFactor(user.username);
    res.json({ success: true, message: "2FA berhasil dinonaktifkan." });
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

// Endpoint Kesehatan & Integritas Sesi Bot (Phase 6 Implementation)
app.get('/api/bot/health', authenticateJWT, (req, res) => {
  const sessionFolder = './session';
  const hasSession = fs.existsSync(sessionFolder) && fs.readdirSync(sessionFolder).length > 0;

  res.json({
    success: true,
    bot: {
      status: botState.status,
      socket: botState.whatsappConnected ? 'OPEN' : (botState.status === 'CONNECTING' ? 'CONNECTING' : 'CLOSED'),
      session: hasSession ? 'VALID' : 'MISSING',
      lastCredUpdate: botState.lastCredUpdate ? new Date(botState.lastCredUpdate).toISOString() : null,
      pendingQueue: botState.pendingQueueCount || 0,
      reconnectCount: botState.reconnectCount || 0,
      lastDisconnectReason: botState.lastDisconnectReason || null,
      lastSent: botState.lastSentTimestamp ? new Date(botState.lastSentTimestamp).toISOString() : null,
      signalKeys: botState.signalKeysOk ? 'OK' : 'ERROR'
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

// --- ANALYTICS LANJUTAN ---

// Grafik timeline pendapatan harian
app.get('/api/analytics/timeline', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const data = await db.getDailySalesTimeline(days);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Top produk terlaris
app.get('/api/analytics/top-products', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const data = await db.getTopProducts(limit);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Top pelanggan terbaik
app.get('/api/analytics/top-customers', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const data = await db.getTopCustomers(limit);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// KPI Summary cards
app.get('/api/analytics/summary', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const data = await db.getAnalyticsSummary();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Heatmap data untuk kalender
app.get('/api/analytics/heatmap', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const now = new Date();
    const year = parseInt(req.query.year) || now.getFullYear();
    const month = parseInt(req.query.month) || (now.getMonth() + 1);
    const data = await db.getSalesHeatmap(year, month);
    res.json({ success: true, data, year, month });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Export data penjualan ke CSV
app.get('/api/analytics/export', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 90;
    const timeline = await db.getDailySalesTimeline(days);
    const topProducts = await db.getTopProducts(20);
    const topCustomers = await db.getTopCustomers(20);

    let csv = 'LAPORAN PENJUALAN\n\n';
    csv += 'PENDAPATAN HARIAN\n';
    csv += 'Tanggal,Pendapatan (Rp),Jumlah Order\n';
    timeline.forEach(r => {
      csv += `${r.date},${r.revenue},${r.order_count}\n`;
    });

    csv += '\nPRODUK TERLARIS\n';
    csv += 'Kode,Nama Produk,Qty Terjual,Revenue (Rp),Jumlah Order\n';
    topProducts.forEach(p => {
      csv += `${p.kode},"${p.nama}",${p.total_qty},${p.total_revenue},${p.order_count}\n`;
    });

    csv += '\nPELANGGAN TERBAIK\n';
    csv += 'Nomor WA,Nama,Total Order,Total Belanja (Rp),Terakhir Order\n';
    topCustomers.forEach(c => {
      csv += `${c.nomor},"${c.nama}",${c.total_orders},${c.total_spent},${c.last_order_at}\n`;
    });

    const filename = `laporan-penjualan-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv); // BOM untuk Excel
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
    const { kode, nama, harga, stok, deskripsi, delivery_type, old_kode, petunjuk } = req.body;
    if (!kode || !nama || harga === undefined || harga === '' || stok === undefined || stok === '') {
      return res.status(400).json({ success: false, message: "Kolom kode, nama, harga, dan stok wajib diisi." });
    }

    const normalizedKode = String(kode).trim().toUpperCase();
    const normalizedNama = String(nama).trim();
    const parsedHarga = Number(harga);
    const parsedStok = Number(stok);
    const deliveryType = String(delivery_type || 'MANUAL').toUpperCase();
    if (!/^[A-Z0-9_-]{2,40}$/.test(normalizedKode)) {
      return res.status(400).json({ success: false, message: "Kode produk hanya boleh berisi huruf, angka, garis bawah, atau tanda hubung (2-40 karakter)." });
    }
    if (normalizedNama.length < 1 || normalizedNama.length > 120) {
      return res.status(400).json({ success: false, message: "Nama produk harus berisi 1-120 karakter." });
    }
    if (!Number.isInteger(parsedHarga) || parsedHarga < 0 || parsedHarga > 1_000_000_000) {
      return res.status(400).json({ success: false, message: "Harga produk harus berupa bilangan bulat antara 0 dan 1.000.000.000." });
    }
    if (!Number.isInteger(parsedStok) || parsedStok < 0 || parsedStok > 1_000_000) {
      return res.status(400).json({ success: false, message: "Stok produk harus berupa bilangan bulat antara 0 dan 1.000.000." });
    }
    if (!['MANUAL', 'AUTO'].includes(deliveryType)) {
      return res.status(400).json({ success: false, message: "Tipe pengiriman produk tidak valid." });
    }

    let gambarUrl = req.body.gambar_existing || "";
    if (req.file) {
      gambarUrl = `/uploads/products/${req.file.filename}`;
    }

    await db.addProduct(normalizedKode, normalizedNama, parsedHarga, parsedStok, String(deskripsi || '').slice(0, 5000), gambarUrl, deliveryType, String(old_kode || '').trim(), String(petunjuk || '').slice(0, 5000));
    await checkAndNotifySubscribers(normalizedKode, parsedStok);
    res.json({ success: true, message: "Produk berhasil disimpan." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Owner dan Admin bisa memicu broadcast restok produk
app.post('/api/products/:kode/restock-broadcast', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { kode } = req.params;
    const { triggerRestockBroadcast } = await import('./bot.js');
    const result = await triggerRestockBroadcast(kode);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Owner dan Admin bisa melihat riwayat broadcast restok
app.get('/api/broadcast/history', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const history = await db.getBroadcastHistoryList();
    res.json({ success: true, history });
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
    if (items.length > 1000 || items.some(item => typeof item !== 'string' || item.trim().length === 0 || item.length > 5000)) {
      return res.status(400).json({ success: false, message: "Maksimal 1.000 kredensial, masing-masing 1-5.000 karakter." });
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

    const currentOrder = await db.getOrderById(orderId);
    if (!currentOrder) {
      return res.status(404).json({ success: false, message: "Order ID tidak ditemukan." });
    }
    const allowedStatuses = {
      approve: ['WAITING_CONFIRMATION'],
      complete: ['PAID'],
      reject: ['WAITING_PAYMENT', 'WAITING_CONFIRMATION']
    };
    if (!allowedStatuses[action].includes(currentOrder.status)) {
      return res.status(409).json({
        success: false,
        message: `Aksi ${action} tidak dapat dilakukan saat status order ${currentOrder.status}.`
      });
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

app.patch('/api/customers/:nomor/role', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const profile = await db.updateCustomerRole(req.params.nomor, req.body.role);
    res.json({ success: true, customer: profile });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.patch('/api/customers/:nomor/status', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const profile = await db.updateCustomerAccountStatus(req.params.nomor, req.body.status);
    res.json({ success: true, customer: profile });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
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
    const backupFile = await backupDatabase();
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

// --- API BROADCAST (KHUSUS OWNER - KE GRUP WHATSAPP) ---

app.post('/api/broadcast', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const { message, delay } = req.body;
    if (typeof message !== 'string' || !message.trim() || message.length > 4000) {
      return res.status(400).json({ success: false, message: "Pesan broadcast wajib diisi." });
    }

    if (!botState.sock || !botState.whatsappConnected) {
      return res.status(400).json({ success: false, message: "Koneksi WhatsApp bot belum terhubung." });
    }

    const broadcastDelay = delay === undefined || delay === '' ? 3000 : Number(delay);
    if (!Number.isInteger(broadcastDelay) || broadcastDelay < 0 || broadcastDelay > 60_000) {
      return res.status(400).json({ success: false, message: "Jeda broadcast harus berupa bilangan bulat 0-60.000 ms." });
    }
    
    // Ambil daftar grup yang diikuti oleh bot
    let targetGroupJids = [];
    const settings = await db.getSettings();
    if (settings.buyerGroupId) {
      targetGroupJids.push(settings.buyerGroupId);
    } else {
      try {
        const groups = await botState.sock.groupFetchAllParticipating();
        targetGroupJids = Object.keys(groups);
      } catch (e) {
        console.error("[BROADCAST] Gagal mengambil daftar grup:", e.message);
      }
    }

    if (targetGroupJids.length === 0) {
      return res.status(400).json({ success: false, message: "Bot belum bergabung ke grup WhatsApp manapun untuk siaran broadcast." });
    }

    // Jalankan broadcast di background dengan delay acak
    runBroadcastInBackground(targetGroupJids, message, broadcastDelay);

    res.json({ 
      success: true, 
      message: `Proses siaran (broadcast) dimulai di background untuk *${targetGroupJids.length}* Grup WhatsApp.`,
      targetCount: targetGroupJids.length
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Fungsi pembantu broadcast background ke Grup WhatsApp
async function runBroadcastInBackground(groupJids, messageText, delayMs) {
  await db.addLog("BROADCAST", `Memulai siaran pesan ke ${groupJids.length} Grup WhatsApp dengan jeda acak.`);
  let successCount = 0;

  for (const jid of groupJids) {
    if (botState.sock && botState.whatsappConnected) {
      try {
        await botState.sock.sendMessage(jid, { text: `📢 *PENGUMUMAN RESMI TOKO:*\n\n${messageText}` });
        successCount++;
        const randomDelay = Math.floor(Math.random() * 2000) + delayMs;
        console.log(`[BROADCAST] Terkirim ke grup ${jid}. Menunggu ${randomDelay} ms...`);
        await new Promise(resolve => setTimeout(resolve, randomDelay));
      } catch (err) {
        console.error(`Gagal kirim broadcast ke grup ${jid}:`, err.message);
        await db.addLog("ERROR", `Gagal kirim broadcast ke grup ${jid}: ${err.message}`);
      }
    } else {
      console.warn(`Soket WhatsApp tidak siap. Broadcast dihentikan.`);
      await db.addLog("ERROR", "Broadcast terhenti karena koneksi bot terputus.");
      break;
    }
  }

  await db.addLog("BROADCAST", `Selesai menyiarkan pesan ke ${successCount}/${groupJids.length} Grup WhatsApp.`);
}

// --- API KUPON & DISKON ---
app.get('/api/coupons', authenticateJWT, async (req, res) => {
  try {
    const coupons = await db.getAllCoupons();
    res.json({ success: true, coupons });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/coupons', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { code, type, value, min_order, max_uses, expires_at } = req.body;
    if (!code || !type || value === undefined) {
      return res.status(400).json({ success: false, message: "Kode, tipe (percent/fixed), dan nilai wajib diisi." });
    }
    const normalizedCode = String(code).trim().toUpperCase();
    const normalizedType = String(type).trim().toLowerCase();
    const parsedValue = Number(value);
    const parsedMinOrder = min_order === undefined || min_order === '' ? 0 : Number(min_order);
    const parsedMaxUses = max_uses === undefined || max_uses === '' ? 0 : Number(max_uses);
    if (!/^[A-Z0-9_-]{3,40}$/.test(normalizedCode)) {
      return res.status(400).json({ success: false, message: "Kode kupon hanya boleh berisi huruf, angka, garis bawah, atau tanda hubung (3-40 karakter)." });
    }
    if (!['percent', 'fixed'].includes(normalizedType)) {
      return res.status(400).json({ success: false, message: "Tipe kupon harus percent atau fixed." });
    }
    if (!Number.isInteger(parsedValue) || parsedValue <= 0 || (normalizedType === 'percent' && parsedValue > 100)) {
      return res.status(400).json({ success: false, message: "Nilai kupon tidak valid." });
    }
    if (!Number.isInteger(parsedMinOrder) || parsedMinOrder < 0 || !Number.isInteger(parsedMaxUses) || parsedMaxUses < 0) {
      return res.status(400).json({ success: false, message: "Minimum order dan batas penggunaan harus bilangan bulat positif atau nol." });
    }
    await db.addCoupon(normalizedCode, normalizedType, parsedValue, parsedMinOrder, parsedMaxUses, expires_at || null);
    res.json({ success: true, message: `Kupon ${normalizedCode} berhasil dibuat!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/coupons/:code', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const deleted = await db.deleteCoupon(req.params.code);
    res.json({ success: true, deleted, message: deleted ? "Kupon berhasil dihapus." : "Kupon tidak ditemukan." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- API FAQ OTOMATIS ---
app.get('/api/faqs', authenticateJWT, async (req, res) => {
  try {
    const faqs = await db.getAllFaqs();
    res.json({ success: true, faqs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/faqs', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const { keywords, answer } = req.body;
    if (typeof keywords !== 'string' || typeof answer !== 'string' || !keywords.trim() || !answer.trim() || keywords.length > 500 || answer.length > 5000) {
      return res.status(400).json({ success: false, message: "Keywords dan Jawaban wajib diisi." });
    }
    const id = await db.addFaq(keywords, answer);
    res.json({ success: true, id, message: "FAQ berhasil ditambahkan!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/faqs/:id', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const deleted = await db.deleteFaq(req.params.id);
    res.json({ success: true, deleted, message: deleted ? "FAQ berhasil dihapus." : "FAQ tidak ditemukan." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- API REFERRALS ---
app.get('/api/referrals', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const referrals = await db.allQuery(
      `SELECT r.*, c1.nama as referrer_nama, c2.nama as referred_nama 
       FROM referrals r 
       LEFT JOIN customers c1 ON r.referrer_nomor = c1.nomor
       LEFT JOIN customers c2 ON r.referred_nomor = c2.nomor
       ORDER BY r.created_at DESC`
    );
    res.json({ success: true, referrals });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

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
    if (!/^[a-zA-Z0-9_-]{3,40}$/.test(String(username).trim()) || String(password).length < 8 || String(password).length > 200) {
      return res.status(400).json({ success: false, message: "Username harus 3-40 karakter dan password minimal 8 karakter." });
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
    if (!password || String(password).length < 8 || String(password).length > 200) {
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
      startBot((newSock) => startScheduler(newSock));
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
    if (String(order.order_id).startsWith('DEP-')) {
      await db.createDepositOrder(order.order_id, order.customer_nomor, order.total);
    }
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

    if (String(order_id).startsWith('DEP-')) {
      if (Number(order.total) !== Number(gross_amount)) {
        return res.status(400).json({ success: false, message: "Nominal deposit tidak cocok." });
      }
      if (transaction_status === 'settlement' || transaction_status === 'capture') {
        const settled = await db.settleDepositOrder(order_id, order.customer_nomor, order.total, transaction_status);
        if (settled && botState.sock && botState.whatsappConnected) {
          await botState.sock.sendMessage(order.customer_nomor, {
            text: `Deposit sebesar *Rp${Number(order.total).toLocaleString('id-ID')}* berhasil masuk ke saldo Anda.`
          });
        }
        return res.json({ success: true, message: settled ? "Deposit berhasil ditambahkan." : "Deposit sudah diproses sebelumnya." });
      }
      if (['expire', 'cancel', 'deny'].includes(transaction_status)) {
        await db.updateOrderStatus(order_id, 'CANCELLED');
        return res.json({ success: true, message: "Deposit dibatalkan." });
      }
      return res.json({ success: true, message: "Webhook deposit diterima." });
    }

    // Hanya proses jika status saat ini sedang menunggu pembayaran
    if (order.status === 'WAITING_PAYMENT') {
      if (transaction_status === 'settlement' || transaction_status === 'capture') {
        // Pembayaran Sukses!
        await db.updateOrderStatus(order_id, 'PAID', transaction_status);
        await db.addLog("PAYMENT", `Pembayaran lunas terverifikasi via Midtrans untuk Order ID ${order_id}.`);

        // ══════════════════════════════════════════════════════════
        // AUTO-DELIVERY via WEBHOOK: Local
        // ══════════════════════════════════════════════════════════
        let waSent = false;
        let deliveredItemsMsg = "";
        let hasAutoDelivery = false;

        // 1. Deliver LOCAL (AUTO)
        const localClaims = await db.claimAndDeliverItems(order_id);
        const localCodes = Object.keys(localClaims);

        if (localCodes.length > 0) {
          hasAutoDelivery = true;
          deliveredItemsMsg = `🎁 *PENGIRIMAN PRODUK DIGITAL*\n\nTerima kasih! Pembayaran Anda telah kami terima dan terverifikasi otomatis (Midtrans).\n\nBerikut adalah detail pesanan Anda:\n\n`;
          
          // Format Local Items
          for (const code of localCodes) {
            const item = localClaims[code];
            deliveredItemsMsg += `🔑 *${item.produk_nama}* (\`${code}\`):\n`;
            if (item.credentials.length > 0) {
              item.credentials.forEach((cred, i) => { deliveredItemsMsg += `   ${i+1}. ${cred}\n`; });
            } else {
              deliveredItemsMsg += `   ⚠️ Stok habis, admin akan mengirimkan manual.\n`;
            }
            if (item.petunjuk) deliveredItemsMsg += `\n${item.petunjuk}\n`;
            deliveredItemsMsg += `\n`;
          }

          deliveredItemsMsg += `━━━━━━━━━━━━━━━━━━\n_Simpan detail ini baik-baik. Hubungi CS jika ada kendala._`;
          
          // Cek kelengkapan
          const localOk = localCodes.every(k => localClaims[k].credentials.length > 0);
          if (localOk) {
            await db.updateOrderStatus(order_id, 'COMPLETED');
            await db.addLog('ORDER', `✅ Order *${order_id}* auto-completed via Midtrans Webhook.`);
          } else {
            await db.updateOrderStatus(order_id, 'PROCESSING');
            await db.addLog('ORDER', `⚠️ Order *${order_id}* terbayar tapi stok habis, status set ke PROCESSING.`);
          }
        } else {
          // MANUAL
          deliveredItemsMsg = `🔔 *INFO PESANAN (Order: ${order_id})*
      
Pembayaran Anda telah *DITERIMA* dan terverifikasi otomatis. Pesanan Anda sedang diproses manual oleh admin kami. Harap menunggu.`;
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
        await db.updateOrderStatus(order_id, 'CANCELLED', transaction_status);
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
export async function startServer() {
  await db.initDb();
  const port = config.port;
  serverInstance = createServer(app);
  
  // Bind Socket.IO ke server
  initWebSocket(serverInstance);

  serverInstance.listen(port, () => {
    console.log(`=== Dashboard Admin Web Berjalan di http://localhost:${port} ===`);
  }).on('error', (err) => {
    console.error(`Gagal menjalankan server di port ${port}:`, err.message);
  });
  return serverInstance;
}
