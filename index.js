import dotenv from 'dotenv';
dotenv.config();

import { startBot } from './bot.js';
import { startServer } from './server.js';
import { startScheduler } from './scheduler.js';

async function main() {
  console.log("=========================================");
  console.log("🚀 MENGAKTIFKAN WHATSAPP SALES SYSTEM v1.0");
  console.log("=========================================");

  try {
    // 1. Jalankan Express Web Server terlebih dahulu agar Admin Dashboard bisa diakses
    // meskipun WhatsApp Bot masih mencoba terhubung atau meminta scan QR code.
    await startServer();

    // 2. Jalankan WhatsApp Bot di background dan aktifkan Scheduler otomatisasi setelah online
    await startBot((sock) => {
      startScheduler(sock);
    });

  } catch (err) {
    console.error("❌ Gagal mengaktifkan sistem utama:", err.message);
    process.exit(1);
  }
}

main();
