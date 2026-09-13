import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { config } from '../../config.js';
import * as db from '../../database.js';
import { pesanErrorAman } from './responErr.js';
import {
  authCookieOptions,
  isLoginAllowed,
  recordLoginAttempt,
  resetLoginAttempts,
  encodeBase32,
  verifyTotp,
  authenticateJWT,
  authorizeRoles
} from './authMiddleware.js';

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    // `req.body || {}` karena Express 5 meninggalkan body undefined saat tidak
    // ada parser yang cocok (mis. Content-Type: text/plain). Tanpa ini
    // destrukturisasinya melempar, dan penangkap di bawah dulu memulangkan pesan
    // internal mentah ke klien yang BELUM login.
    const { username, password, otp } = req.body || {};
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

    resetLoginAttempts(clientIp);

    const authenticatedUser = user || { username: config.adminUser, role: 'Owner' };

    // `iatMs` adalah waktu terbit berpresisi MILIDETIK. Klaim `iat` bawaan hanya
    // berpresisi detik, sehingga pemeriksaan pencabutan di authMiddleware tidak
    // bisa membedakan token yang lahir pada detik yang sama dengan pencabutannya.
    const token = jwt.sign(
      { username: authenticatedUser.username, role: authenticatedUser.role, iatMs: Date.now() },
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
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'AUTH') });
  }
});

router.post('/logout', authenticateJWT, async (req, res) => {
  // Menghapus cookie saja tidak mencabut apa pun — token yang sudah disalin keluar
  // browser tetap sah sampai 24 jamnya habis. Menaikkan epoch membuat SEMUA token
  // lama akun ini langsung ditolak, termasuk yang dipegang perangkat lain.
  try {
    await db.bumpTokenEpoch(req.user.username);
  } catch (err) {
    console.error('[AUTH] Gagal mencabut token saat logout:', err.message);
  }
  res.clearCookie('auth_token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/'
  });
  res.json({ success: true });
});

router.get('/session', authenticateJWT, (req, res) => {
  res.json({ success: true, user: req.user });
});

router.get('/2fa/status', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const user = await db.getUserByUsername(req.user.username);
    res.json({ success: true, enabled: Boolean(user?.two_factor_enabled), hasSecret: Boolean(user?.two_factor_secret) });
  } catch (err) {
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'AUTH') });
  }
});

router.post('/2fa/setup', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
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
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'AUTH') });
  }
});

router.post('/2fa/enable', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const user = await db.getUserByUsername(req.user.username);
    if (!user?.two_factor_secret) return res.status(400).json({ success: false, message: "Buat setup 2FA terlebih dahulu." });
    if (!verifyTotp(user.two_factor_secret, req.body.code)) {
      return res.status(400).json({ success: false, message: "Kode authenticator tidak valid." });
    }
    await db.setTwoFactorEnabled(user.username, true);
    res.json({ success: true, message: "2FA berhasil diaktifkan untuk akun Owner." });
  } catch (err) {
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'AUTH') });
  }
});

router.post('/2fa/disable', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const user = await db.getUserByUsername(req.user.username);
    if (!user?.two_factor_secret || !verifyTotp(user.two_factor_secret, req.body.code)) {
      return res.status(400).json({ success: false, message: "Kode authenticator tidak valid." });
    }
    await db.disableTwoFactor(user.username);
    res.json({ success: true, message: "2FA berhasil dinonaktifkan." });
  } catch (err) {
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'AUTH') });
  }
});

// User Management (Owner Only)
router.get('/users', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const users = await db.getUsers();
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'AUTH') });
  }
});

router.post('/users', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
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
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'AUTH') });
  }
});

router.put('/users/:username', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const { password } = req.body;
    const { username } = req.params;
    if (!password || String(password).length < 8 || String(password).length > 200) {
      return res.status(400).json({ success: false, message: "Password baru wajib diisi." });
    }

    await db.updateUserPassword(username, password);
    // updateUserPassword menaikkan epoch token, jadi sesi lama akun itu ikut mati.
    res.json({ success: true, message: `Password untuk akun ${username} berhasil diubah. Sesi lamanya dicabut.` });
  } catch (err) {
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'AUTH') });
  }
});

router.delete('/users/:username', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const { username } = req.params;
    if (username.toLowerCase() === req.user.username.toLowerCase()) {
      return res.status(400).json({ success: false, message: "Anda tidak dapat menghapus akun Anda sendiri." });
    }

    await db.deleteUser(username);
    // deleteUser sudah menaikkan epoch token akun tersebut, jadi sesi yang sedang
    // berjalan milik akun ini langsung mati — bukan menunggu 24 jam.
    res.json({ success: true, message: `Akun ${username} berhasil dihapus. Sesi aktifnya langsung dicabut.` });
  } catch (err) {
    res.status(500).json({ success: false, message: pesanErrorAman(err, 'AUTH') });
  }
});

export default router;
