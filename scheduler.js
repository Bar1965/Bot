import fs from 'fs';
import path from 'path';
import * as db from './database.js';
import { botState } from './server.js';

let lastBackupTime = 0;
let schedulerSock = null;
let schedulerStarted = false;
const backupRetentionDays = Math.max(1, Number.parseInt(process.env.BACKUP_RETENTION_DAYS || '14', 10) || 14);

function removeExpiredBackups(backupsDir) {
  const cutoff = Date.now() - backupRetentionDays * 24 * 60 * 60 * 1000;
  const backupPattern = /^shop_backup_\d{8}_\d{6}\.db$/;
  let removed = 0;
  for (const filename of fs.readdirSync(backupsDir)) {
    if (!backupPattern.test(filename)) continue;
    const filePath = path.join(backupsDir, filename);
    const stats = fs.statSync(filePath);
    if (stats.isFile() && stats.mtimeMs < cutoff) {
      fs.unlinkSync(filePath);
      removed += 1;
    }
  }
  return removed;
}

// Fungsi untuk melakukan backup database secara manual maupun otomatis
export async function backupDatabase() {
  try {
    await db.initDb();
    const backupsDir = path.resolve('./backups');
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
    fs.copyFileSync(path.resolve('./shop.db'), backupFile);
    const removedBackups = removeExpiredBackups(backupsDir);
    
    await db.addLog('SYSTEM', `Database backup berhasil dibuat: ${backupFile} (retensi ${backupRetentionDays} hari, ${removedBackups} file lama dihapus)`);
    console.log(`[BACKUP] Database cadangan disimpan ke ${backupFile}; ${removedBackups} file lama dihapus.`);
    return backupFile;
  } catch (err) {
    try {
      await db.initDb();
      await db.addLog('ERROR', `Gagal mencadangkan database: ${err.message}`);
    } catch (logError) {
      console.error('[BACKUP LOG ERROR]', logError.message);
    }
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

    // 3. PROSES ABANDONED CART RECOVERY (Keranjang Tertinggal > 2 Jam)
    try {
      const abandonedCarts = await db.getAbandonedCarts(2);
      for (const cart of abandonedCarts) {
        try {
          const cartMsg = `🛒 Halo Kak *${cart.customer_nama}*!\n\nKeranjang belanja Anda masih menunggu:\n${cart.items_summary}\n\n💰 Total: *Rp${cart.total.toLocaleString('id-ID')}*\n\nKetik *checkout* untuk melanjutkan pembayaran, atau *batal* jika ingin membatalkan. 🙏`;
          await sock.sendMessage(cart.customer_nomor, { text: cartMsg });
          await db.markCartReminderSent(cart.order_id);
          console.log(`[SCHEDULER] Abandoned cart reminder terkirim untuk ${cart.order_id}`);
        } catch (err) {
          console.error(`[SCHEDULER ERROR] Gagal kirim abandoned cart reminder ${cart.order_id}:`, err.message);
        }
      }
    } catch (err) {
      console.error("[SCHEDULER ERROR] Gagal proses abandoned cart:", err.message);
    }
  } catch (err) {
    console.error("[SCHEDULER ERROR] Gagal mengeksekusi automasi order:", err.message);
  }
}

// Fungsi Laporan Penjualan Harian Otomatis
async function sendDailySalesReport(sock) {
  if (!sock || !botState.whatsappConnected) return;
  
  try {
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];
    const report = await db.getDailySalesReport(dateStr);
    
    let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *LAPORAN PENJUALAN HARIAN*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📅 Tanggal: *${today.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}*\n\n`;
    msg += `📦 Total Pesanan Selesai: *${report.total_orders}*\n`;
    msg += `💰 Total Omzet: *Rp${report.total_revenue.toLocaleString('id-ID')}*\n\n`;
    
    if (report.topProducts.length > 0) {
      msg += `🏆 *Produk Terlaris Hari Ini:*\n`;
      report.topProducts.forEach((p, i) => {
        msg += `${i + 1}. ${p.nama} (\`${p.produk_kode}\`) — ${p.total_qty} terjual (Rp${p.total_sales.toLocaleString('id-ID')})\n`;
      });
      msg += `\n`;
    }
    
    if (report.lowStockProducts.length > 0) {
      msg += `🟡 *Stok Menipis:*\n`;
      report.lowStockProducts.forEach(p => {
        msg += `• ${p.nama} (\`${p.kode}\`) — Sisa: ${p.stok} pcs\n`;
      });
      msg += `\n`;
    }
    
    if (report.outOfStockProducts.length > 0) {
      msg += `🔴 *Stok Habis:*\n`;
      report.outOfStockProducts.forEach(p => {
        msg += `• ${p.nama} (\`${p.kode}\`)\n`;
      });
      msg += `\n`;
    }
    
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    
    // Kirim ke log group atau owner
    const settings = await db.getSettings();
    const targetJid = settings.logGroupId || settings.transactionGroupId || settings.ownerNumber;
    if (targetJid) {
      await sock.sendMessage(targetJid, { text: msg });
      console.log(`[SCHEDULER] Laporan harian terkirim ke ${targetJid}`);
    }
  } catch (err) {
    console.error('[SCHEDULER ERROR] Gagal kirim laporan harian:', err.message);
  }
}

// Memory set untuk melacak ID game gratis yang sudah pernah dikirim notifikasinya
const notifiedFreeGameIds = new Set();

async function checkFreeGamesAlerts(sock) {
  if (!sock) return;
  try {
    const { fetchFreeGames } = await import('./entertainmentHandler.js');
    const res = await fetchFreeGames('pc');
    if (!res.success || !res.games || res.games.length === 0) return;

    // Filter game gratis baru yang bernilai tinggi (misal dari Steam, Epic, GOG)
    const newFreeGames = res.games.filter(g => !notifiedFreeGameIds.has(g.id));
    if (newFreeGames.length === 0) return;

    const targetJid = process.env.NOTIFICATION_JID || process.env.ADMIN_JID;
    if (!targetJid) return;

    for (const game of newFreeGames.slice(0, 3)) {
      notifiedFreeGameIds.add(game.id);

      const platformIcon = game.platforms?.includes('Steam') ? '🎮' :
                           game.platforms?.includes('Epic') ? '🎁' :
                           game.platforms?.includes('GOG') ? '🕹️' : '⚔️';
      const worthStr = game.worth && game.worth !== 'N/A' ? `~${game.worth}~ ➡️ *GRATIS (Rp0)*` : '*GRATIS (Rp0)*';
      const endDateStr = game.end_date && game.end_date !== 'N/A' ? game.end_date.split(' ')[0] : 'Selama persediaan ada';

      let alertMsg = `🔥 *FREE GAME ALERT (${game.platforms || 'PC'})* 🔥\n`;
      alertMsg += `_Ada game PC keren yang lagi GRATIS 100%! Klaim & simpan selamanya!_\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      alertMsg += `${platformIcon} *${game.title}*\n`;
      alertMsg += `💰 Harga Normal: ${worthStr}\n`;
      alertMsg += `🕹️ Platform: *${game.platforms || 'PC'}*\n`;
      alertMsg += `⏳ Batas Klaim: *${endDateStr}*\n\n`;
      alertMsg += `🔗 *Klaim Sekarang:* ${game.open_giveaway_url || game.gamerpower_url}\n\n`;
      alertMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 _Dapatkan terus update game gratis dari Akbar Store Bot!_`;

      await sock.sendMessage(targetJid, { text: alertMsg });
      console.log(`[SCHEDULER] Free Game Alert terkirim: ${game.title}`);
    }
  } catch (err) {
    console.error('[SCHEDULER ERROR] Gagal periksa free games alert:', err.message);
  }
}

// Pemicu scheduler utama (diekspor untuk index.js)
export function startScheduler(sock) {
  schedulerSock = sock;
  if (schedulerStarted) return;
  schedulerStarted = true;
  console.log("=== Scheduler Otomatisasi Sistem Diaktifkan ===");

  // Jalankan pengecekan order pertama kali setelah 10 detik bot online
  setTimeout(() => processOrderAutomation(schedulerSock), 10000);

  // Jalankan pengecekan Free Games pertama kali setelah 20 detik bot online
  setTimeout(() => checkFreeGamesAlerts(schedulerSock), 20000);

  // Set interval pengecekan order setiap 5 menit
  setInterval(() => {
    processOrderAutomation(schedulerSock);
  }, 5 * 60 * 1000);

  // Set interval pengecekan Free Game Alert setiap 6 jam
  setInterval(() => {
    checkFreeGamesAlerts(schedulerSock);
  }, 6 * 60 * 60 * 1000);

  // Set interval pengecekan backup database setiap 1 jam
  setInterval(() => {
    const now = Date.now();
    // Jika sudah lewat 24 jam sejak backup terakhir
    if (now - lastBackupTime >= 24 * 60 * 60 * 1000) {
      backupDatabase();
      lastBackupTime = now;
    }
  }, 60 * 60 * 1000);

  // Set interval pengecekan laporan harian (setiap jam, kirim saat jam 21:00)
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 21 && now.getMinutes() < 5) {
      sendDailySalesReport(schedulerSock);
    }
  }, 5 * 60 * 1000);

  // Jalankan backup database pertama kali saat scheduler mulai
  backupDatabase();
  lastBackupTime = Date.now();
}

export { sendDailySalesReport };
