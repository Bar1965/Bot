import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as db from '../../database.js';
import * as chatManager from '../../chatManager.js';
import { broadcastToAdmins } from '../../websocket.js';
import {
  authenticateJWT,
  ensureDirExists
} from './authMiddleware.js';

const router = express.Router();

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
    fileSize: 100 * 1024 * 1024
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

// Mengunggah media chat
router.post('/chats/media', authenticateJWT, (req, res) => {
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

    let maxSize = 5 * 1024 * 1024;
    if (['png', 'jpg', 'jpeg', 'gif'].includes(ext)) maxSize = 10 * 1024 * 1024;
    else if (ext === 'pdf') maxSize = 20 * 1024 * 1024;
    else if (['zip', 'apk'].includes(ext)) maxSize = 100 * 1024 * 1024;
    else if (ext === 'mp4') maxSize = 50 * 1024 * 1024;
    else if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) maxSize = 20 * 1024 * 1024;

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

// Mengambil media chat yang dilindungi autentikasi
router.get('/chats/media/:filename', authenticateJWT, (req, res) => {
  const mediaRoot = path.resolve('public/uploads/chat_media');
  const filename = path.basename(req.params.filename);
  const mediaPath = path.join(mediaRoot, filename);
  if (!mediaPath.startsWith(`${mediaRoot}${path.sep}`) || !fs.existsSync(mediaPath)) {
    return res.status(404).json({ success: false, message: "Media tidak ditemukan." });
  }
  res.sendFile(mediaPath);
});

// Daftar percakapan
router.get('/chats', authenticateJWT, async (req, res) => {
  try {
    const list = await db.getConversationsList();
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Riwayat pesan
router.get('/chats/:nomor/messages', authenticateJWT, async (req, res) => {
  try {
    const { nomor } = req.params;
    const messages = await db.getConversationMessages(nomor);
    res.json({ success: true, data: messages });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Mengirim pesan dari dashboard
router.post('/chats/:nomor/send', authenticateJWT, async (req, res) => {
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

// Mengubah status takeover (BOT, ADMIN, CLOSED, ARCHIVED)
router.post('/chats/:nomor/takeover', authenticateJWT, async (req, res) => {
  try {
    const { nomor } = req.params;
    const { state } = req.body;

    if (!['BOT', 'ADMIN', 'CLOSED', 'ARCHIVED'].includes(state)) {
      return res.status(400).json({ success: false, message: "State tidak valid." });
    }

    await db.updateConversationState(nomor, state, state === 'BOT' ? null : req.user.username);
    await db.addLog('SYSTEM', `Admin ${req.user.username} mengubah status chat ${nomor} menjadi ${state}`);

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

// Menandai chat telah dibaca (reset unread)
router.post('/chats/:nomor/read', authenticateJWT, async (req, res) => {
  try {
    const { nomor } = req.params;
    await db.updateConversationReadStatus(nomor);
    
    broadcastToAdmins('conversation_read', {
      customer_jid: nomor
    });

    res.json({ success: true, message: "Status unread berhasil di-reset." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Mengubah internal notes
router.post('/chats/:nomor/notes', authenticateJWT, async (req, res) => {
  try {
    const { nomor } = req.params;
    const { notes } = req.body;
    
    await db.updateConversationNotes(nomor, notes);
    await db.addLog('CHAT', `Admin ${req.user.username} memperbarui internal note untuk ${nomor}`);

    broadcastToAdmins('conversation_notes_updated', {
      customer_jid: nomor,
      internal_notes: notes
    });

    res.json({ success: true, message: "Catatan internal berhasil diperbarui." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Mengubah labels
router.post('/chats/:nomor/labels', authenticateJWT, async (req, res) => {
  try {
    const { nomor } = req.params;
    const { labels } = req.body;
    
    await db.updateConversationLabels(nomor, labels);
    await db.addLog('CHAT', `Admin ${req.user.username} mengubah label customer ${nomor} menjadi: ${labels}`);

    broadcastToAdmins('conversation_labels_updated', {
      customer_jid: nomor,
      labels
    });

    res.json({ success: true, message: "Label customer berhasil diperbarui." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Mengubah pin
router.post('/chats/:nomor/pin', authenticateJWT, async (req, res) => {
  try {
    const { nomor } = req.params;
    const { isPinned } = req.body;

    await db.updateConversationPin(nomor, isPinned);

    broadcastToAdmins('conversation_pin_updated', {
      customer_jid: nomor,
      is_pinned: isPinned ? 1 : 0
    });

    res.json({ success: true, message: `Status pin chat diubah.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
