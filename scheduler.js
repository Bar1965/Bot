import fs from 'fs';
import path from 'path';
import * as db from './database.js';
import { botState } from './server.js';

let lastBackupTime = 0;

// Fungsi untuk melakukan backup database secara manual maupun otomatis
export function backupDatabase() {
  try {
    const backupsDir = './backups';
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }

    // Format nama file cadangan: shop_backup_YYYYMMDD_HHMMSS.db
    const now = new Date();
    const dateStr = now.getFullYear().toString() +
                    (now.getMonth() + 1).toString().padStart(2, '0') +
                    now.getDate().toString().padStart(2, '0');
    const timeStr = now.getHours().toString().padStart(2, '0') +
                    now.getMinutes().toString().padStart(2, '0') +
                    now.getSeconds().toString().padStart(2, '0');

    const backupFile = path.join(backupsDir, `shop_backup_${dateStr}_${timeStr}.db`);
    fs.copyFileSync('./shop.db', backupFile);
    
    db.addLog('SYSTEM', `Database backup berhasil dibuat secara otomatis: ${backupFile}`);
    console.log(`[BACKUP] Database cadangan disimpan ke ${backupFile}`);
    return backupFile;
  } catch (err) {
    db.addLog('ERROR', `Gagal mencadangkan database: ${err.message}`);
    console.error('[BACKUP ERROR]', err.message);
    return null;
  }
}

// Menjalankan pengecekan order tertunda (Reminder & Expired)
async function processOrderAutomation(sock) {
  if (!sock || !botState.whatsappConnected) {
    console.log("[SCHEDULER] Lewati automasi order karena WhatsApp offline.");
    return;
  }

  console.log("[SCHEDULER] Menjalankan pengecekan pengingat & kedaluwarsa transaksi...");

  try {
    // 1. PROSES AUTO-REMINDER PEMBAYARAN (30 Menit)
    const pendingReminders = await db.getPendingReminders();
    for (const order of pendingReminders) {
      try {
        const reminderMsg = `Halo *${order.customer_nama}*,

Kami ingin mengingatkan bahwa pesanan Anda dengan Order ID *${order.order_id}* masih menunggu pembayaran sebesar *Rp${order.total.toLocaleString('id-ID')}*.

Harap segera transfer ke QRIS / petunjuk rekening kami agar pesanan dapat langsung kami kerjakan.

Ketik *batal* atau *cancel* jika Anda ingin membatalkan pesanan ini. Terima kasih!`;

        await sock.sendMessage(order.customer_nomor, { text: reminderMsg });
        await db.setReminderSent(order.order_id);
        
        await db.addLog('SYSTEM', `Mengirimkan pengingat pembayaran otomatis (30 menit) ke ${order.customer_nomor} untuk Order ID ${order.order_id}`);
        console.log(`[SCHEDULER] Auto-Reminder terkirim untuk ${order.order_id}`);
      } catch (err) {
        console.error(`[SCHEDULER ERROR] Gagal mengirim reminder untuk ${order.order_id}:`, err.message);
      }
    }

    // 2. PROSES AUTO-CANCEL TRANSAKSI EXPIRY (24 Jam)
    const expiredOrders = await db.getExpiredOrders();
    for (const order of expiredOrders) {
      try {
        // Update status ke CANCELLED (secara otomatis mengembalikan stok produk ke database)
        await db.updateOrderStatus(order.order_id, 'CANCELLED');

        const expiredMsg = `🔔 *PEMBERITAHUAN PEMBATALAN OTOMATIS*

Mohon maaf, pesanan Anda dengan Order ID *${order.order_id}* telah *DIBATALKAN* secara otomatis oleh sistem karena kami tidak menerima konfirmasi pembayaran dalam waktu 24 jam.

Stok produk telah dikembalikan ke inventori. Silakan ketik *menu* jika Anda ingin melakukan pemesanan ulang. Terima kasih.`;

        await sock.sendMessage(order.customer_nomor, { text: expiredMsg });
        await db.addLog('ORDER', `Order ID ${order.order_id} dibatalkan otomatis oleh scheduler karena kedaluwarsa 24 jam.`);
        console.log(`[SCHEDULER] Auto-Cancel berhasil diproses untuk ${order.order_id}`);
      } catch (err) {
        console.error(`[SCHEDULER ERROR] Gagal membatalkan order expired ${order.order_id}:`, err.message);
      }
    }

  } catch (err) {
    console.error("[SCHEDULER ERROR] Gagal mengeksekusi automasi order:", err.message);
  }
}

// Pemicu scheduler utama (diekspor untuk index.js)
export function startScheduler(sock) {
  console.log("=== Scheduler Otomatisasi Sistem Diaktifkan ===");

  // Jalankan pengecekan order pertama kali setelah 10 detik bot online
  setTimeout(() => processOrderAutomation(sock), 10000);

  // Set interval pengecekan order setiap 5 menit
  setInterval(() => {
    processOrderAutomation(sock);
  }, 5 * 60 * 1000);

  // Set interval pengecekan backup database setiap 1 jam
  setInterval(() => {
    const now = Date.now();
    // Jika sudah lewat 24 jam sejak backup terakhir
    if (now - lastBackupTime >= 24 * 60 * 60 * 1000) {
      backupDatabase();
      lastBackupTime = now;
    }
  }, 60 * 60 * 1000);

  // Jalankan backup database pertama kali saat scheduler mulai
  backupDatabase();
  lastBackupTime = Date.now();
}
