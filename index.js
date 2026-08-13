import dotenv from 'dotenv';
dotenv.config();

import { startBot } from './bot.js';
import { startServer } from './server.js';
import { startScheduler } from './scheduler.js';

import fs from 'fs';
import path from 'path';

// --- GLOBAL WATCHDOG & SELF-HEALING EXCEPTION HANDLER ---
process.on('uncaughtException', (err) => {
  console.error('[WATCHDOG] ⚠️ Uncaught Exception terdeteksi!');
  console.error(err.stack || err);
  // Optional: process.exit(1) if you want PM2 to restart it. For now we log explicitly.
});

process.on('unhandledRejection', (reason) => {
  console.error('[WATCHDOG] ⚠️ Unhandled Rejection terdeteksi!');
  console.error(reason?.stack || reason);
});

// Periodic Temp Folder Cleaner (Tiap 1 Jam)
setInterval(() => {
  try {
    const tmpDir = path.join(process.cwd(), 'tmp');
    if (fs.existsSync(tmpDir)) {
      const files = fs.readdirSync(tmpDir);
      const now = Date.now();
      let cleaned = 0;
      for (const file of files) {
        const filePath = path.join(tmpDir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > 30 * 60 * 1000) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      }
      if (cleaned > 0) console.log(`[WATCHDOG] 🧹 Berhasil membersihkan ${cleaned} file temporary lama.`);
    }
  } catch (e) {}
}, 60 * 60 * 1000);

async function main() {
  console.log("=========================================");
  console.log("🚀 MENGAKTIFKAN WHATSAPP SALES SYSTEM v1.0");
  console.log("=========================================");

  try {
    await startServer();
    await startBot((sock) => {
      startScheduler(sock);
    });
  } catch (err) {
    console.error("❌ Gagal mengaktifkan sistem utama:", err.message);
    process.exit(1);
  }
}

main();

