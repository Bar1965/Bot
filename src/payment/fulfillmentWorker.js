/**
 * Fulfillment Worker
 * Runs as a background loop. Picks PENDING/FAILED jobs from fulfillment_jobs,
 * claims & delivers digital products via WhatsApp (Baileys), and handles retries.
 *
 * Call startFulfillmentWorker(sock) once the WhatsApp socket is ready.
 * Call stopFulfillmentWorker() on disconnect.
 */
import * as db from '../../database.js';
import { barisGaransiAktif, barisKlaimGaransi } from '../utils/pesanGaransi.js';
import { pasangSocketNotif, notifikasiOwner } from '../utils/notifOwner.js';
import { susunBuktiTransaksi, susunPermintaanUlasan, susunNotifPenjualanOwner } from '../handlers/testimoni.js';
import { jamWib, tanggalPanjangWib } from '../utils/waktu.js';

/**
 * Sesudah barang sampai: pajang bukti transaksi di grup pembeli, lalu tanyakan
 * ulasannya ke pembeli lewat japri.
 *
 * Dipanggil TANPA await dari jalur pengiriman. Kegagalan di sini tidak boleh
 * menjatuhkan job yang sudah DELIVERED — mengulang job berarti mengirim
 * kredensial kedua kalinya untuk satu pembayaran.
 *
 * Yang diposting ke grup hanya fakta penjualan dengan nomor disamarkan. Bot
 * tidak pernah mengarang bintang atau komentar atas nama pembeli; testimoni
 * hanya ada kalau orangnya sendiri membalas pesan di bawah ini.
 */
async function umumkanDanMintaUlasan(job, orderDetails, customerJid, deliveryResult) {
  const itemPertama = orderDetails?.items?.[0] || null;
  const namaProduk = itemPertama?.produk_nama || null;
  const produkKode = itemPertama?.produk_kode || null;
  const jumlah = Number(itemPertama?.qty) || 1;
  const otomatis = String(itemPertama?.delivery_type || '').toUpperCase() === 'AUTO';
  const jidPembeli = orderDetails?.customer_nomor || job.customer_number;
  const total = Number(orderDetails?.payment_amount || orderDetails?.total || 0);
  const sekarang = new Date();
  const tanggal = tanggalPanjangWib(sekarang);
  const jam = jamWib(sekarang);

  // Lama pengiriman = sejak job diantrekan (pembayaran lunas) sampai sekarang.
  const durasiMs = Number(job?.created_at) ? Date.now() - Number(job.created_at) : 0;

  let settings = null;
  try { settings = await db.getSettings(); } catch (_) {}

  // 1. Bukti transaksi ke grup pembeli — tanpa nama pembeli, tanpa sisa stok.
  try {
    const grupPembeli = settings?.buyerGroupId;
    if (sockRef && grupPembeli) {
      await sockRef.sendMessage(grupPembeli, {
        text: susunBuktiTransaksi({
          namaProduk, jid: jidPembeli, otomatis, jam, tanggal, jumlah, total,
          orderId: job.order_id, durasiMs
        })
      });
    }
  } catch (e) {
    console.error(`[FULFILLMENT] Bukti transaksi tidak terkirim: ${e.message}`);
  }

  // 2. Notifikasi penjualan lengkap untuk OWNER. Sebelum ini owner hanya tahu
  //    ada penjualan dari feed publik yang sengaja disamarkan — tidak tahu
  //    siapa pembelinya, dan tidak tahu stoknya tinggal berapa.
  try {
    const tujuan = settings?.transactionGroupId || settings?.ownerJid || settings?.ownerNumber;
    if (sockRef && tujuan && String(tujuan).includes('@')) {
      let sisaStok = null;
      try {
        if (produkKode) sisaStok = await db.getAvailableItemsCount(produkKode);
      } catch (_) {}

      let refPembayaran = null;
      try {
        const trx = await db.getQuery(
          'SELECT provider_transaction_id FROM payment_transactions WHERE order_id = ? ORDER BY rowid DESC LIMIT 1',
          [job.order_id]
        );
        refPembayaran = trx?.provider_transaction_id || null;
      } catch (_) {}

      await sockRef.sendMessage(tujuan, {
        text: susunNotifPenjualanOwner({
          namaProduk, produkKode,
          namaPembeli: orderDetails?.customer_nama,
          jid: jidPembeli,
          jumlah, total,
          metode: refPembayaran ? 'QRIS otomatis (Casaku)' : null,
          tanggal, jam,
          sisaStok,
          stokSebelum: Number.isFinite(Number(sisaStok)) ? Number(sisaStok) + jumlah : null,
          orderId: job.order_id,
          refPembayaran,
          durasiMs,
          otomatis
        })
      });
    }
  } catch (e) {
    console.error(`[FULFILLMENT] Notifikasi penjualan ke owner gagal: ${e.message}`);
  }

  // 3. Permintaan ulasan ke pembeli. Hanya untuk produk yang benar-benar sudah
  //    di tangan — pesanan MANUAL yang masih menunggu admin belum layak ditanya
  //    "gimana pesananmu?".
  try {
    if (!sockRef || !deliveryResult?.itemsText) return;
    await sockRef.sendMessage(customerJid, {
      text: susunPermintaanUlasan({
        namaProduk,
        namaPembeli: orderDetails?.customer_nama || null
      })
    });
  } catch (e) {
    console.error(`[FULFILLMENT] Permintaan ulasan tidak terkirim: ${e.message}`);
  }
}

// Retry delays in milliseconds: 10s, 30s, 2m, 5m, 15m
const RETRY_DELAYS = [10_000, 30_000, 120_000, 300_000, 900_000];
const MAX_ATTEMPTS = RETRY_DELAYS.length + 1; // 6 attempts total before MANUAL_REVIEW
const POLL_INTERVAL = 5_000; // Check for new jobs every 5 seconds

let workerRunning = false;
let workerTimer = null;
let sockRef = null;

export function startFulfillmentWorker(sock) {
  sockRef = sock;
  // Satu-satunya tempat socket diserahkan ke modul latar belakang yang lain.
  // paymentService berjalan dari scheduler dan tidak memegang socket sendiri.
  pasangSocketNotif(sock, () => db.getSettings());
  if (workerRunning) return;
  workerRunning = true;
  console.log('[FULFILLMENT] Worker started.');
  scheduleNextPoll(0);
}

export function stopFulfillmentWorker() {
  workerRunning = false;
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = null;
  console.log('[FULFILLMENT] Worker stopped.');
}

/**
 * Kirim peringatan ke DM Owner. Sebelumnya kegagalan pengiriman hanya muncul
 * sebagai console.error — kalau terminal tidak sedang dilihat, order yang gagal
 * kirim hilang begitu saja padahal customer sudah membayar.
 */
function scheduleNextPoll(delay = POLL_INTERVAL) {
  if (!workerRunning) return;
  workerTimer = setTimeout(async () => {
    try {
      await processJobs();
    } catch (err) {
      console.error('[FULFILLMENT] Worker poll error:', err.message);
    }
    scheduleNextPoll(POLL_INTERVAL);
  }, delay);
}

async function processJobs() {
  const jobs = await db.getPendingFulfillmentJobs();
  if (jobs.length === 0) return;

  for (const job of jobs) {
    // Job PROCESSING hanya bisa muncul di sini kalau proses mati di tengah
    // pengiriman. Notifikasinya dikirim setelah semua guard di bawah, bukan di
    // sini, supaya job yang belum waktunya retry tidak memberi kabar berulang
    // setiap poll.
    const dipulihkanDariGantung = job.status === 'PROCESSING';

    if (job.attempts > 0) {
      const delayIndex = Math.min(job.attempts - 1, RETRY_DELAYS.length - 1);
      const updatedAtMs = typeof job.updated_at === 'string'
        ? new Date(job.updated_at).getTime()
        : (job.updated_at > 1e11 ? job.updated_at : job.updated_at * 1000);
      const retryAfter = updatedAtMs + RETRY_DELAYS[delayIndex];
      if (Date.now() < retryAfter) continue; // Not yet time to retry
    }

    if (job.attempts >= MAX_ATTEMPTS) {
      await db.updateFulfillmentJob(job.job_id, 'MANUAL_REVIEW', 'Max retry attempts reached');
      console.warn(`[FULFILLMENT] Job ${job.job_id} → MANUAL_REVIEW after ${job.attempts} attempts.`);
      await notifikasiOwner(
        `🚨 *PENGIRIMAN GAGAL TOTAL*\n\nOrder *${job.order_id}* menyerah setelah ${job.attempts} percobaan dan butuh penanganan manual.\n\n📱 Customer: ${job.customer_number}\n💡 Kirim manual lalu tandai lunas dengan .paid`
      );
      continue;
    }

    if (dipulihkanDariGantung) {
      console.warn(`[FULFILLMENT] Job ${job.job_id} tersangkut di PROCESSING — kemungkinan bot restart saat mengirim. Diambil ulang.`);
      await notifikasiOwner(
        `🔄 *PENGIRIMAN DIPULIHKAN*\n\nOrder *${job.order_id}* tersangkut di tengah pengiriman (bot restart) dan sekarang dikirim ulang otomatis.\n\n📱 Customer: ${job.customer_number}`
      );
    }

    await processJob(job);
  }
}

async function processJob(job) {
  console.log(`[FULFILLMENT] Processing job ${job.job_id} for order ${job.order_id} (attempt ${job.attempts + 1})`);

  try {
    // Mark as PROCESSING without double-incrementing attempts
    if (db.setFulfillmentJobProcessing) {
      await db.setFulfillmentJobProcessing(job.job_id);
    } else {
      await db.updateFulfillmentJob(job.job_id, 'PROCESSING', null);
    }

    // Special handling for Deposit Top-up orders
    if (job.order_id.startsWith('DEP-')) {
      const orderDetails = await db.getOrderDetails(job.order_id);
      const customerJid = job.customer_number.includes('@')
        ? job.customer_number
        : `${job.customer_number.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

      const customerProfile = await db.getCustomerMembershipProfile(job.customer_number);
      let depMsg = `🎉 *TOP UP SALDO DEPOSIT BERHASIL!* 🎉\n\n`;
      depMsg += `🆔 *Deposit ID:* ${job.order_id}\n`;
      depMsg += `💰 *Nominal Top Up:* Rp${(orderDetails?.payment_amount || orderDetails?.total || 0).toLocaleString('id-ID')}\n`;
      depMsg += `💳 *Total Saldo Sekarang:* Rp${(customerProfile?.balance || 0).toLocaleString('id-ID')}\n\n`;
      depMsg += `_Saldo telah otomatis ditambahkan ke akun toko Anda dan siap digunakan untuk bertransaksi! Terima kasih. 🙏_`;

      if (!sockRef) throw new Error('WhatsApp socket not available');
      await sockRef.sendMessage(customerJid, { text: depMsg });

      await db.updateFulfillmentJob(job.job_id, 'DELIVERED', null);
      await db.runQuery(`UPDATE orders SET fulfillment_status = 'DELIVERED' WHERE order_id = ?`, [job.order_id]);
      console.log(`[FULFILLMENT] Deposit Job ${job.job_id} → DELIVERED ✅`);
      return;
    }

    // Claim digital product items from inventory
    const deliveryResult = await db.claimAndDeliverItems(job.order_id);

    if (deliveryResult && deliveryResult.outOfStock) {
      const details = deliveryResult.outOfStockDetails;
      throw new Error(`STOK KOSONG: Produk ${details?.nama || details?.kode} butuh ${details?.needed} akun, tetapi hanya tersedia ${details?.found}. Mohon segera restok dengan: .addstock ${details?.kode}`);
    }

    if (!deliveryResult || (!deliveryResult.itemsText && !deliveryResult.manualItems)) {
      throw new Error('No items to deliver or claimAndDeliverItems returned empty');
    }

    // Get order details for message formatting
    const orderDetails = await db.getOrderDetails(job.order_id);
    const customerJid = job.customer_number.includes('@')
      ? job.customer_number
      : `${job.customer_number.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    // Build delivery message
    let deliveryMsg = `🎉 *PEMBAYARAN BERHASIL DIKONFIRMASI!* 🎉\n`;
    deliveryMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    deliveryMsg += `📦 *Order ID:* \`${job.order_id}\`\n`;
    deliveryMsg += `💰 *Total Dibayar:* *Rp${(orderDetails?.payment_amount || orderDetails?.total || 0).toLocaleString('id-ID')}*\n`;
    deliveryMsg += barisGaransiAktif(deliveryResult.warrantyUntil);
    deliveryMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    deliveryMsg += `🎁 *RINCIAN KREDENSIAL & AKUN:*\n\n`;

    if (deliveryResult.itemsText) {
      deliveryMsg += deliveryResult.itemsText;
    } else {
      deliveryMsg += `👨‍💼 _Pesanan Anda sedang diproses oleh Tim Admin Toko. Kredensial akan segera dikirimkan ke chat ini._\n\n`;
    }

    const appUrl = process.env.APP_URL;
    deliveryMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (appUrl) {
      deliveryMsg += `🌐 *Invoice Online:* ${appUrl}/pay/${job.order_id}\n`;
    }
    deliveryMsg += barisKlaimGaransi(job.order_id);
    deliveryMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    deliveryMsg += `_Terima kasih telah mempercayakan kebutuhan digital Anda kepada Akbar Store! 🙏_`;

    // Send via Baileys
    if (!sockRef) throw new Error('WhatsApp socket not available');

    await sockRef.sendMessage(customerJid, { text: deliveryMsg });

    // Mark as DELIVERED
    await db.updateFulfillmentJob(job.job_id, 'DELIVERED', null);
    await db.runQuery(
      `UPDATE orders SET fulfillment_status = 'DELIVERED' WHERE order_id = ?`,
      [job.order_id]
    );
    console.log(`[FULFILLMENT] Job ${job.job_id} → DELIVERED ✅`);

    // Bukti transaksi + permintaan ulasan. SENGAJA di luar jalur uang: kedua
    // pesan ini tidak boleh membuat pengiriman yang sudah berhasil dianggap
    // gagal lalu diulang. Barangnya sudah di tangan pembeli — kalau posting ke
    // grup gagal, yang hilang cuma postingan.
    umumkanDanMintaUlasan(job, orderDetails, customerJid, deliveryResult)
      .catch(e => console.error(`[FULFILLMENT] Bukti/ulasan gagal (tidak fatal): ${e.message}`));

  } catch (err) {
    const nextAttempt = job.attempts + 1;
    const status = nextAttempt >= MAX_ATTEMPTS ? 'MANUAL_REVIEW' : 'FAILED';
    await db.updateFulfillmentJob(job.job_id, status, err.message);
    await db.runQuery(
      `UPDATE orders SET fulfillment_status = ? WHERE order_id = ?`,
      [status, job.order_id]
    );
    console.error(`[FULFILLMENT] Job ${job.job_id} FAILED (attempt ${nextAttempt}): ${err.message}`);
    if (status === 'MANUAL_REVIEW') {
      console.error(`[FULFILLMENT] ⚠️ Job ${job.job_id} needs MANUAL REVIEW — check order ${job.order_id}`);
      await notifikasiOwner(
        // Sebutkan jalan keluarnya. Tanpa baris terakhir ini, owner tahu ada yang
        // rusak tapi tidak tahu bot punya cara mencoba lagi.
        `🚨 *PENGIRIMAN BUTUH PENANGANAN MANUAL*\n\nOrder *${job.order_id}* gagal dikirim otomatis setelah ${MAX_ATTEMPTS} percobaan.\n\n📱 Customer: ${job.customer_number}\n❌ Penyebab: ${err.message}\n\n🔁 *Setelah sebabnya diperbaiki* (mis. stok diisi ulang dengan \`.addstock\`), suruh bot mencoba lagi:\n\`.kirimulang ${job.order_id}\``
      );
    }
  }
}
