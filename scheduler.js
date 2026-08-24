import fs from 'fs';
import path from 'path';
import * as db from './database.js';
import { botState } from './server.js';

let lastBackupTime = 0;
let schedulerSock = null;
let schedulerStarted = false;
let cachedPrayerTimes = null;
let cachedPrayerDate = "";
let cachedTimezone = "Asia/Jakarta";
let lastAlertedPrayer = "";
const backupRetentionDays = Math.max(1, Number.parseInt(process.env.BACKUP_RETENTION_DAYS || '14', 10) || 14);

function removeExpiredBackups(backupsDir) {
  const cutoff = Date.now() - backupRetentionDays * 24 * 60 * 60 * 1000;
  const backupPattern = /^shop_backup_\d{8}_\d{6}\.db$/;
  let removed = 0;

  const validBackups = [];
  for (const filename of fs.readdirSync(backupsDir)) {
    if (!backupPattern.test(filename)) continue;
    const filePath = path.join(backupsDir, filename);
    try {
      const stats = fs.statSync(filePath);
      if (stats.isFile()) {
        validBackups.push({ filename, filePath, mtimeMs: stats.mtimeMs });
      }
    } catch (_) {}
  }

  // Urutkan dari yang paling baru ke paling lama
  validBackups.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const MAX_BACKUPS = 15; // Simpan maksimal 15 file backup terbaru
  validBackups.forEach((b, index) => {
    // Hapus jika sudah melewati batas retensi hari ATAU berada di luar 15 file terbaru
    if (b.mtimeMs < cutoff || index >= MAX_BACKUPS) {
      try {
        fs.unlinkSync(b.filePath);
        removed += 1;
      } catch (_) {}
    }
  });

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
    try {
      await db.runQuery("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch (e) {}
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
    // 0. CASAKU AUTOMATED PAYMENT RECONCILIATION & EXPIRY
    try {
      const expiredCount = await db.expireStaleOrders(15);
      if (expiredCount > 0) {
        console.log(`[SCHEDULER] Casaku: ${expiredCount} order PENDING kedaluwarsa (15 menit) & stok dikembalikan.`);
      }
      const { reconcileStaleOrders } = await import('./src/payment/paymentService.js');
      const recoveredCount = await reconcileStaleOrders();
      if (recoveredCount > 0) {
        console.log(`[SCHEDULER] Casaku: ${recoveredCount} order PENDING berhasil dipulihkan via reconciliation.`);
      }
    } catch (casakuErr) {
      console.error('[SCHEDULER] Casaku automation error:', casakuErr.message);
    }

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
    const wibNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const dateStr = wibNow.toISOString().split('T')[0];
    const report = await db.getDailySalesReport(dateStr);
    
    let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *LAPORAN PENJUALAN HARIAN*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📅 Tanggal: *${wibNow.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}*\n\n`;
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
let isFirstFreeGamesCheck = true;
const notifiedFreeGameIds = new Set();

async function checkFreeGamesAlerts(sock) {
  if (!sock || !botState.whatsappConnected) return;
  try {
    const { fetchFreeGames } = await import('./entertainmentHandler.js');
    const res = await fetchFreeGames('pc');
    if (!res.success || !res.games || res.games.length === 0) return;

    // Saat startup bot pertama kali, tandai game lama yang ada agar tidak di-spam
    if (isFirstFreeGamesCheck) {
      isFirstFreeGamesCheck = false;
      res.games.forEach(g => notifiedFreeGameIds.add(g.id));
      console.log(`[SCHEDULER] Auto Free Games Alert diinisialisasi (${res.games.length} game terdaftar, cek otomatis tiap 6 jam).`);
      return;
    }

    // Filter game gratis yang benar-benar BARU rilis
    const newFreeGames = res.games.filter(g => !notifiedFreeGameIds.has(g.id));
    if (newFreeGames.length === 0) {
      console.log('[SCHEDULER] Pengecekan 6 Jam Free Games: Tidak ada game baru yang gratis.');
      return;
    }

    // Ambil daftar seluruh grup WhatsApp aktif
    let targetGroupJids = [];
    try {
      const participatingGroups = await sock.groupFetchAllParticipating();
      targetGroupJids = Object.keys(participatingGroups || {});
    } catch (fetchErr) {
      const dbGroups = await db.allQuery("SELECT jid FROM group_settings");
      targetGroupJids = dbGroups.map(g => g.jid);
    }
    targetGroupJids = Array.from(new Set(targetGroupJids));

    if (targetGroupJids.length === 0) return;

    for (const game of newFreeGames.slice(0, 3)) {
      notifiedFreeGameIds.add(game.id);

      const platformIcon = game.platforms?.includes('Steam') ? '🎮' :
                           game.platforms?.includes('Epic') ? '🎁' :
                           game.platforms?.includes('GOG') ? '🕹️' : '⚔️';
      const worthStr = game.worth && game.worth !== 'N/A' ? `~${game.worth}~ ➡️ *GRATIS (Rp0)*` : '*GRATIS (Rp0)*';
      const endDateStr = game.end_date && game.end_date !== 'N/A' ? game.end_date.split(' ')[0] : 'Selama persediaan ada';

      let alertMsg = `📢 *PERINGATAN GAME GRATIS BARU (FREE GAME ALERT)* 📢\n`;
      alertMsg += `_Ada game PC keren yang baru saja GRATIS 100%! Klaim & simpan selamanya!_\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      alertMsg += `${platformIcon} *${game.title}*\n`;
      alertMsg += `💰 Harga Normal: ${worthStr}\n`;
      alertMsg += `🕹️ Platform: *${game.platforms || 'PC'}*\n`;
      alertMsg += `⏳ Batas Klaim: *${endDateStr}*\n\n`;
      alertMsg += `🔗 *Klaim Sekarang:* ${game.open_giveaway_url || game.gamerpower_url}\n\n`;
      alertMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 _Dapatkan terus update game gratis dari Akbar Store Bot!_`;

      for (const groupJid of targetGroupJids) {
          try {
            // Check group settings toggle
            const gSettings = await db.getGroupSettings(groupJid);
            const features = gSettings.features_config || {};
            if (features.freegames !== true) {
               continue; // Default OFF if not enabled by admin
            }

            // Fetch metadata to tag all
            let mentions = [];
            let tagAllBlock = '';
            try {
               const metadata = await sock.groupMetadata(groupJid);
               mentions = metadata.participants.map(p => p.id);
               tagAllBlock = '\n\n' + mentions.map(m => `@${m.split('@')[0]}`).join(' ');
            } catch (e) {
               // Ignore if bot is not admin or metadata fails
            }

            await sock.sendMessage(groupJid, { text: alertMsg + tagAllBlock, mentions: mentions });
            console.log(`[SCHEDULER] Auto Free Game Alert terkirim ke grup ${groupJid}: ${game.title}`);
          } catch (gErr) {
            console.error(`[SCHEDULER] Gagal kirim free game alert ke ${groupJid}:`, gErr.message);
          }
        }
    }
  } catch (err) {
    console.error('[SCHEDULER ERROR] Gagal periksa free games alert:', err.message);
  }
}

// Fungsi Pemicu Kuis Otomatis Grup Terjadwal
async function processAutoQuiz(sock) {
  if (!sock || !botState.whatsappConnected) return;
  try {
    const settings = await db.getSettings();
    if (settings.autoQuizEnabled !== "true") {
      console.log("[SCHEDULER] Auto-Quiz dilewati karena dinonaktifkan di pengaturan.");
      return;
    }

    const groups = await db.allQuery("SELECT jid FROM group_settings WHERE bot_mode = 'all'");
    if (groups.length === 0) return;

    const { triggerAutoQuiz } = await import('./funHandler.js');
    for (const group of groups) {
      await triggerAutoQuiz(sock, group.jid);
      console.log(`[SCHEDULER] Auto-Quiz terkirim ke grup: ${group.jid}`);
    }
  } catch (err) {
    console.error('[SCHEDULER AUTO QUIZ ERROR]', err.message);
  }
}

async function processAutoSholat(sock) {
  if (!sock || !botState.whatsappConnected) return;

  try {
    const settings = await db.getSettings();
    if (settings.autoSholatEnabled !== "true") {
      return;
    }

    const city = settings.sholatCity || "Jakarta";
    const now = new Date();

    // Dapatkan tanggal hari ini dalam zona waktu target
    const todayStr = new Intl.DateTimeFormat('sv-SE', { timeZone: cachedTimezone }).format(now);

    // Jika ganti hari atau cache kosong, ambil jadwal sholat harian
    if (cachedPrayerDate !== todayStr || !cachedPrayerTimes) {
      const { getPrayerTimes } = await import('./mediaHandler.js');
      const res = await getPrayerTimes(city);
      if (res.success && res.timings) {
        cachedPrayerTimes = res.timings;
        cachedPrayerDate = todayStr;
        cachedTimezone = res.meta?.timezone || "Asia/Jakarta";
        console.log(`[SCHEDULER] Berhasil memuat jadwal sholat harian untuk kota ${city} (${cachedTimezone}) tanggal ${todayStr}`);
      } else {
        console.error('[SCHEDULER] Gagal mengambil jadwal sholat:', res.message);
        return;
      }
    }

    // Hitung ulang waktu sekarang menggunakan zona waktu target yang valid dari API
    const currentHourMin = new Intl.DateTimeFormat('en-GB', { 
      timeZone: cachedTimezone, 
      hour: '2-digit', 
      minute: '2-digit', 
      hour12: false 
    }).format(now);

    const obligatoryPrayers = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

    for (const prayer of obligatoryPrayers) {
      let prayerTime = cachedPrayerTimes[prayer];
      if (!prayerTime) continue;

      prayerTime = prayerTime.split(' ')[0].trim();

      if (currentHourMin === prayerTime) {
        const alertKey = `${todayStr}:${prayer}`;
        if (lastAlertedPrayer === alertKey) {
          continue;
        }

        lastAlertedPrayer = alertKey;

        const friendlyName = {
          'Fajr': 'Subuh',
          'Dhuhr': 'Dzuhur',
          'Asr': 'Ashar',
          'Maghrib': 'Maghrib',
          'Isha': 'Isya'
        }[prayer];

        let msg = `🕌 *PENGINGAT ADZAN & JADWAL SHOLAT* 🕌\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        msg += `Telah memasuki waktu sholat *${friendlyName}* untuk wilayah *${city.toUpperCase()}* dan sekitarnya.\n`;
        msg += `🕒 Waktu: *${prayerTime}*\n\n`;
        msg += `_“Sesungguhnya shalat itu adalah kewajiban yang ditentukan waktunya atas orang-orang yang beriman.” (QS. An-Nisa: 103)_\n\n`;
        msg += `Mari sejenak menghentikan aktivitas, bersuci, dan menunaikan ibadah sholat. 🙏`;

        // Kirim notifikasi ke SEMUA grup tempat bot bergabung (yang fiturnya aktif)
        let targetGroupJids = [];
        try {
          const participatingGroups = await sock.groupFetchAllParticipating();
          targetGroupJids = Object.keys(participatingGroups || {});
        } catch (fetchErr) {
          console.error('[SCHEDULER] Gagal fetch grup aktif, menggunakan fallback database:', fetchErr.message);
          const dbGroups = await db.allQuery("SELECT jid FROM group_settings");
          targetGroupJids = dbGroups.map(g => g.jid);
        }

        targetGroupJids = Array.from(new Set(targetGroupJids));

        for (const targetJid of targetGroupJids) {
          try {
            // Cek pengaturan grup
            const gSettings = await db.getGroupSettings(targetJid);
            if (gSettings.auto_sholat === 0 || gSettings.auto_sholat === false) {
              continue; // Skip jika fitur dimatikan di grup ini
            }
            await sock.sendMessage(targetJid, { text: msg });
            console.log(`[SCHEDULER] Notifikasi Adzan ${friendlyName} terkirim ke grup ${targetJid}`);
          } catch (gErr) {
            console.error(`[SCHEDULER] Gagal mengirim adzan ke grup ${targetJid}:`, gErr.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('[SCHEDULER AUTO SHOLAT ERROR]', err.message);
  }
}

// Pembersih otomatis file media chat inbox (public/uploads/chat_media/)
// Hanya menghapus file yang percakapannya sudah idle, bukan ADMIN takeover,
// dan lebih tua dari 8 jam. Buffer 30 menit untuk mitigasi race condition.
async function cleanupChatMedia() {
  try {
    const CHAT_MEDIA_DIR = path.resolve('./public/uploads/chat_media');
    if (!fs.existsSync(CHAT_MEDIA_DIR)) return;

    const now = Date.now();
    const CUTOFF_MS       = 8 * 60 * 60 * 1000;  // 8 jam — usia minimum sebelum boleh dihapus
    const SAFE_WINDOW_MS  = 30 * 60 * 1000;       // 30 menit — buffer mitigasi race condition

    const cutoffTimestamp     = now - CUTOFF_MS;
    const safeWindowTimestamp = now - SAFE_WINDOW_MS;

    // 1. Query DB satu kali — ambil semua path yang boleh dihapus
    //    (percakapan idle, bukan ADMIN, tidak ada pesan baru dengan path yang sama)
    const orphanedPaths = await db.getOrphanedMediaPaths(cutoffTimestamp);

    // Semua basename yang masih dirujuk messages, apa pun umur/statusnya. Sebuah file
    // hanya "yatim sungguhan" kalau namanya tidak ada di sini sama sekali.
    const referencedBasenames = new Set(
      (await db.getReferencedMediaPaths()).map(p => path.basename(p))
    );

    // 2. Bangun Set of basenames untuk lookup O(1) saat scan folder
    //    Normalisasi basename mengatasi perbedaan format path DB:
    //    - bot.js simpan: ./public/uploads/chat_media/X.jpg
    //    - server.js simpan: /uploads/chat_media/X.jpg
    const deletableBasenames = new Set(orphanedPaths.map(p => path.basename(p)));

    // 3. Scan folder dan tentukan file mana yang akan dihapus
    const files = fs.readdirSync(CHAT_MEDIA_DIR);
    const deletedBasenames = [];
    let freedBytes = 0;

    for (const filename of files) {
      const filePath = path.join(CHAT_MEDIA_DIR, filename);
      let stats;
      try {
        stats = fs.statSync(filePath);
      } catch (_) {
        continue; // File sudah dihapus proses lain, lewati
      }
      if (!stats.isFile()) continue;

      // ATURAN 1: File yang dimodifikasi dalam 30 menit terakhir TIDAK BOLEH disentuh —
      // mencegah penghapusan file yang baru di-download bot tapi belum sempat masuk DB.
      if (stats.mtimeMs > safeWindowTimestamp) continue;

      // ATURAN 2: Hapus kalau (a) percakapannya sudah idle & bukan ADMIN takeover —
      // yaitu masuk daftar orphan dari DB, ATAU (b) file itu tidak punya baris messages
      // sama sekali dan sudah lewat 8 jam.
      // PENTING: syarat (b) TIDAK boleh memakai !isOrphanInDb. File dalam percakapan
      // ADMIN sengaja dikecualikan dari daftar orphan, jadi negasinya justru akan
      // menghapus persis file yang mau dilindungi.
      const isOrphanInDb  = deletableBasenames.has(filename);
      const isTrulyOrphan = !referencedBasenames.has(filename) && stats.mtimeMs < cutoffTimestamp;

      if (isOrphanInDb || isTrulyOrphan) {
        try {
          freedBytes += stats.size;
          fs.unlinkSync(filePath);
          deletedBasenames.push(filename);
        } catch (e) {
          console.error(`[CLEANUP] ⚠️ Gagal hapus ${filename}:`, e.message);
        }
      }
    }

    // 4. Nullify media_path di DB agar dashboard tidak load URL yang sudah tidak ada
    if (deletedBasenames.length > 0) {
      const deletedSet = new Set(deletedBasenames);
      // Filter hanya path dari DB yang base name-nya berhasil dihapus
      const pathsToNullify = orphanedPaths.filter(p => deletedSet.has(path.basename(p)));
      if (pathsToNullify.length > 0) {
        await db.nullifyMediaPaths(pathsToNullify);
      }

      const freedMB = (freedBytes / (1024 * 1024)).toFixed(2);
      console.log(`[CLEANUP] 🗑️ Media chat dibersihkan: ${deletedBasenames.length} file dihapus, ${freedMB} MB dibebaskan.`);
      try {
        await db.addLog('SYSTEM', `Auto-cleanup media chat: ${deletedBasenames.length} file dihapus, ${freedMB} MB dibebaskan.`);
      } catch (_) {}
    } else {
      console.log(`[CLEANUP] ✅ Tidak ada media chat yang perlu dibersihkan.`);
    }
  } catch (err) {
    console.error('[CLEANUP ERROR] Gagal membersihkan media chat:', err.message);
  }
}

// Pembersih folder kerja media (tmp/). mediaHandler menulis file sementara di sini
// dan biasanya menghapusnya sendiri, tapi kalau prosesnya mati di tengah jalan
// (ffmpeg timeout, bot di-restart) file-nya tertinggal selamanya: folder ini tidak
// pernah disapu oleh cleanupChatMedia. Hanya file lebih tua dari 8 jam yang dihapus,
// jadi job media yang sedang berjalan mustahil terganggu. Subfolder tidak disentuh
// (mis. tmp/bot-runtime/ yang menyimpan log).
function cleanupTmpDir() {
  try {
    const TMP_DIR = path.resolve('./tmp');
    if (!fs.existsSync(TMP_DIR)) return;

    const cutoffTimestamp = Date.now() - 8 * 60 * 60 * 1000;
    let deleted = 0;
    let freedBytes = 0;

    for (const filename of fs.readdirSync(TMP_DIR)) {
      const filePath = path.join(TMP_DIR, filename);
      let stats;
      try { stats = fs.statSync(filePath); } catch (_) { continue; }
      if (!stats.isFile()) continue;
      if (stats.mtimeMs >= cutoffTimestamp) continue;
      try {
        fs.unlinkSync(filePath);
        deleted++;
        freedBytes += stats.size;
      } catch (_) {}
    }

    if (deleted > 0) {
      const freedMB = (freedBytes / (1024 * 1024)).toFixed(2);
      console.log(`[CLEANUP] 🗑️ Sisa file media di tmp/ dibersihkan: ${deleted} file, ${freedMB} MB dibebaskan.`);
    }
  } catch (err) {
    console.error('[CLEANUP ERROR] Gagal membersihkan tmp/:', err.message);
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

  // Jalankan pengecekan jadwal sholat pertama kali setelah 15 detik
  setTimeout(() => processAutoSholat(schedulerSock), 15000);

  // Jalankan cleanup media chat pertama kali setelah 60 detik bot online
  setTimeout(() => cleanupChatMedia(), 60000);

  // Sapu sisa file kerja di tmp/ 65 detik setelah online
  setTimeout(() => cleanupTmpDir(), 65000);

  // Set interval pengecekan order setiap 5 menit
  setInterval(() => {
    processOrderAutomation(schedulerSock);
  }, 5 * 60 * 1000);

  // Set interval pengecekan Free Game Alert setiap 6 jam
  setInterval(() => {
    checkFreeGamesAlerts(schedulerSock);
  }, 6 * 60 * 60 * 1000);

  // Set interval pembersihan otomatis media chat + folder kerja setiap 8 jam
  setInterval(() => {
    cleanupChatMedia();
    cleanupTmpDir();
  }, 8 * 60 * 60 * 1000);

  // Set interval pengecekan backup database setiap 1 jam
  setInterval(() => {
    const now = Date.now();
    // Jika sudah lewat 24 jam sejak backup terakhir
    if (now - lastBackupTime >= 24 * 60 * 60 * 1000) {
      backupDatabase();
      lastBackupTime = now;
    }
  }, 60 * 60 * 1000);

  // Set interval pengecekan laporan harian (kirim 1x sehari pada jam 21:00 WIB)
  let lastDailyReportDate = '';
  setInterval(() => {
    const wibNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const today = wibNow.toISOString().slice(0, 10);
    const wibHours = wibNow.getUTCHours();
    const wibMinutes = wibNow.getUTCMinutes();
    if (wibHours === 21 && wibMinutes < 5 && lastDailyReportDate !== today) {
      lastDailyReportDate = today;
      sendDailySalesReport(schedulerSock);
    }
  }, 60 * 1000);

  // Set interval pembagian bunga bank harian (2% tiap jam 00:05 WIB)
  let lastBankInterestDate = '';
  setInterval(async () => {
    try {
      const wibNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
      const today = wibNow.toISOString().slice(0, 10);
      const wibHours = wibNow.getUTCHours();
      const wibMinutes = wibNow.getUTCMinutes();
      if (wibHours === 0 && wibMinutes < 10 && lastBankInterestDate !== today) {
        lastBankInterestDate = today;
        const totalAccounts = await db.applyDailyBankInterest(0.02);
        if (totalAccounts > 0) {
          console.log(`[BANK INTEREST] Berhasil membagikan bunga harian 2% ke ${totalAccounts} akun nasabah bank.`);
        }
      }
    } catch (e) {
      console.error('[BANK INTEREST] Gagal membagikan bunga harian:', e.message);
    }
  }, 60 * 1000);

  // Set interval kuis otomatis grup setiap 1 jam
  setInterval(() => {
    processAutoQuiz(schedulerSock);
  }, 1 * 60 * 60 * 1000);

  // Set interval pengecekan waktu sholat otomatis setiap 1 menit (60 detik)
  setInterval(() => {
    processAutoSholat(schedulerSock);
  }, 60 * 1000);

  // Jalankan backup database pertama kali saat scheduler mulai
  backupDatabase();
  lastBackupTime = Date.now();
}

export { sendDailySalesReport };
