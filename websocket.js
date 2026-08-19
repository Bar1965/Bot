import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

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
  io.use((socket, next) => {
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

    try {
      const decoded = jwt.verify(token, config.jwtSecret);
      socket.user = decoded;
      next();
    } catch (err) {
      return next(new Error("Authentication error: Invalid token"));
    }
  });

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
