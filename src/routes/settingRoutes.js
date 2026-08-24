import express from 'express';
import fs from 'fs';
import os from 'os';
import * as db from '../../database.js';
import { botState } from '../../server.js';
import { reloadBotSettings, startBot } from '../../bot.js';
import { backupDatabase, startScheduler } from '../../scheduler.js';
import {
  authenticateJWT,
  authorizeRoles,
  uploadQris
} from './authMiddleware.js';

const router = express.Router();

// Bot Status (Semua role terautentikasi)
router.get('/bot-status', authenticateJWT, (req, res) => {
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

// Endpoint Kesehatan & Integritas Sesi Bot
router.get('/bot/health', authenticateJWT, (req, res) => {
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

// Settings (Owner Only)
router.get('/settings', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const settings = await db.getSettings();
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/settings', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    await db.updateSettings(req.body);
    await reloadBotSettings();
    res.json({ success: true, message: "Pengaturan berhasil diperbarui." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/settings/qris', authenticateJWT, authorizeRoles('Owner'), uploadQris.single('qris'), async (req, res) => {
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

// Manual backup download
router.get('/settings/backup', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
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

// Reset Sesi WhatsApp secara paksa
router.post('/settings/session/reset', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    console.log("[SYSTEM] Owner memicu reset sesi WhatsApp...");
    await db.addLog("SYSTEM", "Owner memicu reset sesi WhatsApp secara paksa.");
    
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

    const sessionFolder = './session';
    if (fs.existsSync(sessionFolder)) {
      fs.rmSync(sessionFolder, { recursive: true, force: true });
    }

    res.json({ success: true, message: "Sesi WhatsApp berhasil direset. Silakan scan ulang QR code baru yang muncul di server." });

    setTimeout(() => {
      startBot((newSock) => startScheduler(newSock));
    }, 2000);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Logs (Owner Only)
router.get('/logs', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
  try {
    const filter = req.query.type || "ALL";
    const logs = await db.getLogs(filter);
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Broadcast
router.get('/broadcast/history', authenticateJWT, authorizeRoles('Owner', 'Admin'), async (req, res) => {
  try {
    const history = await db.getBroadcastHistoryList();
    res.json({ success: true, history });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/broadcast', authenticateJWT, authorizeRoles('Owner'), async (req, res) => {
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

export default router;
