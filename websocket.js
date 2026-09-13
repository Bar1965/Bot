import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import * as db from './database.js';

let io = null;

export function initWebSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: config.corsOrigin,
      methods: ["GET", "POST"],
      credentials: true
    },

    pingTimeout: 60000,
    pingInterval: 25000,
    connectTimeout: 45000
  });

  // Middleware Autentikasi JWT
  io.use(async (socket, next) => {
    // Ambil token dari handshake auth, headers, atau cookie sesi dashboard.
    const cookieHeader = socket.handshake.headers?.cookie || '';
    const sessionCookie = cookieHeader
      .split(';')
      .map(cookie => cookie.trim())
      .find(cookie => cookie.startsWith('auth_token='));
    let cookieToken = null;
    if (sessionCookie) {
      try {
        cookieToken = decodeURIComponent(sessionCookie.slice('auth_token='.length));
      } catch (e) {
        cookieToken = sessionCookie.slice('auth_token='.length);
      }
    }
    const token = socket.handshake.auth?.token || socket.handshake.headers?.token || cookieToken;
    if (!token) {
      return next(new Error("Authentication error: Token missing"));
    }

    let decoded;
    try {
      decoded = jwt.verify(token, config.jwtSecret);
    } catch (err) {
      return next(new Error("Authentication error: Invalid token"));
    }

    // Socket ini menyiarkan SELURUH percakapan pelanggan ke dashboard secara
    // langsung. Kalau hanya tanda tangan JWT yang diperiksa, token yang sudah
    // dicabut (logout, ganti password, akun dihapus) masih bisa membuka koneksi
    // ini dan ikut menyimak — pintu belakang dari pemeriksaan di authMiddleware.
    try {
      const username = String(decoded?.username || '').toLowerCase();
      const validAfter = await db.getTokenEpoch(username);
      if (validAfter && Number(decoded.iatMs || 0) < validAfter) {
        return next(new Error("Authentication error: Session revoked"));
      }
      const akun = await db.getUserByUsername(username);
      if (akun) decoded.role = akun.role;
      else if (username !== String(config.adminUser || '').toLowerCase()) {
        return next(new Error("Authentication error: Account removed"));
      }
    } catch (err) {
      console.error('[WS] Gagal memeriksa status token:', err.message);
      return next(new Error("Authentication error: Session check failed"));
    }

    socket.user = decoded;
    next();
  });

  // Pencabutan token diperiksa ULANG secara berkala, bukan cuma saat jabat tangan.
  //
  // Pemeriksaan di middleware di atas hanya berjalan sekali, saat koneksi dibuka.
  // Socket yang sudah terlanjur terbuka terus menyiarkan SELURUH percakapan
  // pelanggan — 231 nomor WhatsApp beserta isi chatnya — bahkan setelah akunnya
  // dihapus, passwordnya diganti, atau sesinya di-logout. Selama tab dashboard
  // itu tidak ditutup, pencabutan aksesnya tidak berarti apa-apa.
  const PERIKSA_ULANG_MS = 60_000;
  const pemeriksaSesi = setInterval(async () => {
    let soketAktif;
    try {
      soketAktif = await io.in('admin').fetchSockets();
    } catch (err) {
      return;
    }
    for (const s of soketAktif) {
      const username = String(s.user?.username || '').toLowerCase();
      if (!username) continue;
      try {
        const validAfter = await db.getTokenEpoch(username);
        if (validAfter && Number(s.user?.iatMs || 0) < validAfter) {
          console.warn(`[WS] Sesi '${username}' dicabut — koneksi diputus.`);
          s.emit('session_revoked', { reason: 'Sesi Anda dicabut. Silakan login ulang.' });
          s.disconnect(true);
          continue;
        }
        const akun = await db.getUserByUsername(username);
        if (!akun && username !== String(config.adminUser || '').toLowerCase()) {
          console.warn(`[WS] Akun '${username}' sudah tidak ada — koneksi diputus.`);
          s.emit('session_revoked', { reason: 'Akun Anda sudah tidak ada.' });
          s.disconnect(true);
        }
      } catch (err) {
        // Gagal memeriksa BUKAN alasan memutus koneksi yang mungkin sah; dicoba
        // lagi pada putaran berikutnya.
        console.error('[WS] Gagal memeriksa ulang sesi:', err.message);
      }
    }
  }, PERIKSA_ULANG_MS);
  if (typeof pemeriksaSesi.unref === 'function') pemeriksaSesi.unref();

  io.on('connection', (socket) => {
    console.log(`[WS] Admin '${socket.user.username}' terhubung (${socket.id})`);
    
    // Bergabung ke room 'admin' untuk siaran terfokus
    socket.join('admin');

    // Menangani event pengetikan dari admin (typing/composing)
    socket.on('admin_typing', async (data = {}) => {
      const { customerJid, isTyping } = data;
      if (!customerJid) return;
      // Siarkan pengetikan ke admin lain di dashboard
      socket.to('admin').emit('admin_typing_status', { 
        customerJid, 
        adminUsername: socket.user.username, 
        isTyping: !!isTyping 
      });

      // Kirim status pengetikan (composing/paused) ke WhatsApp customer melalui Baileys
      import('./bot.js').then(async (m) => {
        await m.triggerPresenceUpdate(customerJid, isTyping ? 'composing' : 'paused');
      }).catch(err => {
        console.error("[WS] Gagal memicu status pengetikan WA:", err.message);
      });
    });

    socket.on('disconnect', () => {
      console.log(`[WS] Admin '${socket.user.username}' terputus`);
    });
  });

  return io;
}

export function broadcastToAdmins(event, data) {
  if (io) {
    io.to('admin').emit(event, data);
  }
}
