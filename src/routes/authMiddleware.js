import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { config } from '../../config.js';

export const authCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 24 * 60 * 60 * 1000,
  path: '/'
};

const loginAttempts = new Map();

// Periodic cleanup of expired login attempts to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  for (const [ip, attempts] of loginAttempts.entries()) {
    const valid = attempts.filter(ts => now - ts < windowMs);
    if (valid.length === 0) {
      loginAttempts.delete(ip);
    } else {
      loginAttempts.set(ip, valid);
    }
  }
}, 30 * 60 * 1000);

export function getCookieValue(req, name) {
  const cookies = req.headers.cookie?.split(';') || [];
  const prefix = `${name}=`;
  const entry = cookies.find(cookie => cookie.trim().startsWith(prefix));
  return entry ? decodeURIComponent(entry.trim().slice(prefix.length)) : null;
}

export function isLoginAllowed(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 5;
  const recent = (loginAttempts.get(ip) || []).filter(timestamp => now - timestamp < windowMs);
  if (recent.length === 0) {
    loginAttempts.delete(ip);
  } else {
    loginAttempts.set(ip, recent);
  }
  return recent.length < maxAttempts;
}

export function recordLoginAttempt(ip) {
  const attempts = loginAttempts.get(ip) || [];
  attempts.push(Date.now());
  loginAttempts.set(ip, attempts);
}

export function resetLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function encodeBase32(buffer) {
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

export function decodeBase32(value) {
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

export function verifyTotp(secret, token) {
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

export const ensureDirExists = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};
ensureDirExists('./public/uploads/products');
ensureDirExists('./public/uploads/chat_media');
ensureDirExists('./public/receipts');

// --- MULTER STORAGE ---
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

const qrisStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureDirExists('./public/uploads');
    cb(null, './public/uploads');
  },
  filename: (req, file, cb) => {
    cb(null, 'qris.png');
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

export const uploadProduct = multer({
  storage: productStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: imageUploadFilter
});

export const uploadQris = multer({
  storage: qrisStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: qrisUploadFilter
});

export function authenticateJWT(req, res, next) {
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

export function authorizeRoles(...roles) {
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
