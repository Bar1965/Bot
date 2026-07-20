import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState, 
  downloadMediaMessage,
  jidNormalizedUser,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';

import { config } from './config.js';
import * as db from './database.js';
import { botState, createMidtransTransaction } from './server.js';

// Setup Logger
const logger = P({ level: 'info' });

let sock = null;
let botSettings = {};

// Fungsi untuk memuat ulang pengaturan bot dari SQLite
export async function reloadBotSettings() {
  try {
    botSettings = await db.getSettings();
    console.log("Pengaturan bot berhasil diperbarui dari database.");
  } catch (err) {
    console.error("Gagal memuat pengaturan bot dari DB:", err.message);
  }
}

// Fungsi Helper untuk mengirim log sistem (DB & Log Group WhatsApp)
async function logToSystem(type, text) {
  console.log(`[${type}] ${text}`);
  // Catat ke tabel log SQLite
  await db.addLog(type, text);

  // Jika WA terkoneksi dan ada Log Group terdaftar
  if (sock && botState.whatsappConnected && botSettings.logGroupId) {
    try {
      await sock.sendMessage(botSettings.logGroupId, { text: `📢 *LOG [${type}]:*\n${text}` });
    } catch (err) {
      console.error('Gagal mengirim log ke WhatsApp Log Group:', err.message);
    }
  }
}

// Fungsi untuk mengirim pesan massal notifikasi stok saat produk ready kembali
export async function checkAndNotifySubscribers(kode, newStock) {
  try {
    if (newStock > 0) {
      const subscribers = await db.getAndClearSubscribers(kode);
      if (subscribers.length > 0) {
        const product = await db.getProductByKode(kode);
        const msg = `🎉 *STOK READY KEMBALI!*

Halo, produk *${product.nama}* (\`${kode.toUpperCase()}\`) yang Anda tunggu-tunggu saat ini sudah tersedia kembali!

Stok ready saat ini: *${newStock}* pcs.
Segera lakukan pemesanan dengan mengetik:
👉 *beli ${kode.toUpperCase()} 1*

Jangan sampai kehabisan lagi ya!`;

        // Kirim ke semua pelanggan yang berlangganan
        for (const num of subscribers) {
          if (sock && botState.whatsappConnected) {
            try {
              await sock.sendMessage(num, { text: msg });
              await logToSystem('SYSTEM', `Mengirimkan pemberitahuan stok ready ke ${num} untuk produk ${kode.toUpperCase()}`);
              // Tambahkan jeda 1 detik untuk menghindari pemblokiran WA
              await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (err) {
              console.error(`Gagal kirim notif stok ke ${num}:`, err.message);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("Gagal memproses notifikasi pelanggan:", err.message);
  }
}

// Fungsi Helper untuk mengirim QRIS dengan fallback dinamis
async function sendQris(jid, captionText) {
  try {
    const qrisPath = botSettings.qrisImagePath || config.defaults.qrisImagePath;
    if (fs.existsSync(qrisPath)) {
      await sock.sendMessage(jid, { 
        image: { url: qrisPath }, 
        caption: captionText 
      });
    } else {
      const warningText = `⚠️ *Gambar QRIS Toko belum disiapkan oleh Admin.*\n\n${captionText}\n\n${botSettings.paymentInstructions || config.defaults.paymentInstructions}`;
      await sock.sendMessage(jid, { text: warningText });
    }
  } catch (err) {
    console.error('Gagal mengirim gambar QRIS:', err);
    await sock.sendMessage(jid, { text: captionText });
  }
}

// Inisialisasi koneksi WhatsApp (Diekspor untuk index.js)
export async function startBot(onSocketReady) {
  // Pastikan DB terinisialisasi
  await db.initDb();
  // Muat pengaturan toko awal dari DB
  await reloadBotSettings();

  // Folder sesi WA
  const sessionFolder = './session';
  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

  // Ambil versi terbaru WhatsApp Web dari Baileys, fallback ke versi stabil 2.3000.1035194821
  let waVersion = [2, 3000, 1035194821];
  try {
    const { version: latestVersion, isLatest } = await fetchLatestBaileysVersion();
    waVersion = latestVersion;
    console.log(`Menghubungkan menggunakan WA Web v${waVersion.join('.')}, Terkini: ${isLatest}`);
  } catch (err) {
    console.warn("Gagal mengambil versi WA Web terbaru, menggunakan versi fallback:", waVersion.join('.'));
  }

  // Bersihkan socket lama jika ada untuk mencegah kebocoran sesi
  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.end();
    } catch (e) {
      // Abaikan error
    }
  }

  sock = makeWASocket({
    auth: state,
    version: waVersion,
    logger: P({ level: 'silent' }),
    browser: ['Windows', 'Chrome', '110.0.5481.177']
  });

  // Hubungkan event updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      botState.status = 'CONNECTING';
      botState.whatsappConnected = false;
      console.log('Silakan scan QR Code di bawah untuk menghubungkan bot:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      botState.status = 'OFFLINE';
      botState.whatsappConnected = false;
      botState.sock = null;

      const statusCode = lastDisconnect?.error instanceof Boom 
        ? lastDisconnect.error.output?.statusCode 
        : null;
        
      const shouldReconnect = 
        statusCode !== DisconnectReason.loggedOut && 
        statusCode !== DisconnectReason.connectionReplaced;
      
      console.log(`Koneksi terputus. Alasan: ${statusCode}. Reconnect: ${shouldReconnect}`);
      
      if (shouldReconnect) {
        await logToSystem('SYSTEM', `Koneksi WhatsApp terputus (Status: ${statusCode}). Mencoba menghubungkan kembali dalam 5 detik...`);
        setTimeout(() => startBot(onSocketReady), 5000);
      } else {
        if (statusCode === DisconnectReason.connectionReplaced) {
          console.warn("⚠️ Koneksi ditolak (405 Connection Replaced). Kemungkinan bot dijalankan ganda atau sesi aktif di tempat lain.");
          await logToSystem('SYSTEM', '⚠️ Koneksi ditolak (405 Connection Replaced). Pastikan tidak ada instance bot lain yang berjalan.');
        } else {
          console.warn("⚠️ Sesi terputus permanen (logged out) atau tidak valid. Silakan scan ulang.");
          await logToSystem('SYSTEM', '⚠️ Sesi WhatsApp terputus permanen (Logged Out). Harap lakukan reset sesi melalui Web Dashboard.');
        }
      }
    } else if (connection === 'open') {
      botState.status = 'ONLINE';
      botState.whatsappConnected = true;
      botState.sock = sock;
      botState.lastReconnect = Date.now();

      console.log('=== WhatsApp Sales Bot Berhasil Online ===');
      await logToSystem('SYSTEM', '🟢 Bot WhatsApp Sales sekarang ONLINE dan siap memproses order!');
      
      // Beritahu index.js bahwa soket siap digunakan oleh server Express
      if (onSocketReady) {
        onSocketReady(sock);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Monitor status online/mengetik dari customer
  sock.ev.on('presence.update', async (update) => {
    const { id, presences } = update;
    if (presences) {
      const keys = Object.keys(presences);
      if (keys.length > 0) {
        const presenceData = presences[keys[0]];
        const presenceStatus = presenceData?.lastKnownPresence;
        import('./websocket.js').then((ws) => {
          ws.broadcastToAdmins('customer_presence_updated', {
            customerJid: id,
            status: presenceStatus === 'available' ? 'online' : (presenceStatus === 'composing' ? 'typing' : 'offline'),
            lastSeen: Date.now()
          });
        }).catch(err => {});
      }
    }
  });

  // Monitor centang/status pesan terkirim (delivered/read)
  sock.ev.on('messages.update', async (updates) => {
    for (const u of updates) {
      if (u.update.status) {
        const statusMap = {
          2: 'delivered',
          3: 'read',
          4: 'read'
        };
        const newStatus = statusMap[u.update.status];
        if (newStatus) {
          await db.updateMessageStatus(u.key.id, newStatus);
          import('./websocket.js').then((ws) => {
            ws.broadcastToAdmins('message_status_updated', {
              realId: u.key.id,
              customerJid: jidNormalizedUser(u.key.remoteJid),
              status: newStatus
            });
          }).catch(err => {});
        }
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (type !== 'notify') return;

      for (const m of messages) {
        if (!m.message) continue;

        const jid = m.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        const sender = m.key.participant || jid;
        const senderNormalized = jidNormalizedUser(sender);
        const isFromMe = m.key.fromMe;

        if (isFromMe) continue;

        const msgText = (
          m.message.conversation || 
          m.message.extendedTextMessage?.text || 
          m.message.imageMessage?.caption || 
          ""
        ).trim();

        // Ambil daftar admin dinamis dari pengaturan database, bersihkan format input (lidded JID support)
        const admins = (botSettings.adminNumbers || "").split(',')
          .map(n => {
            let clean = n.trim().replace('+', '');
            if (clean && !clean.includes('@')) {
              clean = clean + '@s.whatsapp.net';
            }
            return clean;
          });
        const isAdmin = admins.includes(senderNormalized);

        console.log(`[DEBUG_MSG] Grup: ${isGroup} (${jid}), Pengirim: ${senderNormalized}, Text: "${msgText}", Admin: ${isAdmin}`);

        // Ambil status percakapan (Take Over check)
        const conv = await db.getOrCreateConversation(senderNormalized);
        const isTakenOver = conv.conversation_state === 'ADMIN';

        if (!isGroup) {
          // Download media jika ada
          let mediaPath = '';
          if (m.message.imageMessage || m.message.videoMessage || m.message.documentMessage || m.message.audioMessage) {
            try {
              const buffer = await downloadMediaMessage(m, 'buffer', {});
              const mimeType = m.message.imageMessage?.mimetype || m.message.videoMessage?.mimetype || m.message.documentMessage?.mimetype || m.message.audioMessage?.mimetype || '';
              const ext = mimeType.split('/').pop().split(';')[0];
              const filename = `chat_recv_${Date.now()}_${Math.floor(1000 + Math.random()*9000)}.${ext === 'vnd.android.package-archive' ? 'apk' : ext}`;
              mediaPath = `./public/uploads/chat_media/${filename}`;
              fs.writeFileSync(mediaPath, buffer);
            } catch (err) {
              console.error("Gagal mendownload media pesan masuk:", err.message);
            }
          }

          const messageType = m.message.imageMessage ? 'image' : 
                              (m.message.videoMessage ? 'video' : 
                              (m.message.audioMessage ? 'audio' : 
                              (m.message.documentMessage ? 'file' : 'text')));

          const messageContent = m.message.conversation || 
                                 m.message.extendedTextMessage?.text || 
                                 m.message.imageMessage?.caption || 
                                 m.message.videoMessage?.caption || 
                                 m.message.documentMessage?.caption || 
                                 '';

          import('./chatManager.js').then(async (chat) => {
            await chat.saveIncomingMessage({
              id: m.key.id,
              customerJid: senderNormalized,
              messageType,
              message: messageContent,
              mediaPath,
              quotedId: m.message.extendedTextMessage?.contextInfo?.stanzaId || '',
              timestamp: (m.messageTimestamp * 1000) || Date.now()
            });
          }).catch(err => console.error("Gagal menyimpan pesan masuk ke DB:", err));

          // Jika pesan dimulai dengan '/' dan pengirim adalah Admin, proses sebagai perintah admin/owner (buka /getjid untuk semua)
          if (msgText.startsWith('/getjid')) {
            await handleGroupMessage(jid, senderNormalized, m, msgText, isAdmin);
          } else if (msgText.startsWith('/') && isAdmin) {
            await handleGroupMessage(jid, senderNormalized, m, msgText, isAdmin);
          } else {
            // Jika chat sedang diambil alih admin (Take Over), bot diam
            if (isTakenOver) {
              console.log(`[BOT] Percakapan dengan ${senderNormalized} sedang diambil alih admin. Auto-reply dinonaktifkan.`);
            } else {
              // Menangani Pesan DM Pelanggan
              await handleCustomerMessage(jid, senderNormalized, m, msgText, false);
            }
          }
        } else {
          // Menangani Pesan Grup (Grup Transaksi / Log / Grup Utama Pembeli)
          if (jid === mainBuyerGroupJid) {
            // /getjid tetap bisa digunakan di grup pembeli untuk menemukan JID
            if (msgText.startsWith('/getjid')) {
              await handleGroupMessage(jid, senderNormalized, m, msgText, isAdmin);
            } else {
              // Jika pesan datang dari grup utama pembeli, proses perintah pelanggan
              await handleCustomerMessage(jid, senderNormalized, m, msgText, true);
            }
          } else {
            await handleGroupMessage(jid, senderNormalized, m, msgText, isAdmin);
          }
        }
      }
    } catch (err) {
      console.error('Error saat memproses pesan masuk:', err);
    }
  });
}

// ==========================================
// LOGIKA PESAN PELANGGAN (DM & GRUP UTAMA)
// ==========================================
async function handleCustomerMessage(jid, senderNumber, messageObj, text, isFromGroup = false) {
  const textLower = text.toLowerCase();
  const customerName = messageObj.pushName || "Pelanggan";
  await db.getOrCreateCustomer(senderNumber, customerName);

  // Periksa apakah perintah butuh privasi (transaksi personal)
  const isPrivateCommand = 
    /^(beli|buy)\s+/i.test(textLower) ||
    textLower === 'cart' || 
    textLower === 'keranjang' || 
    textLower === 'checkout' || 
    textLower === 'bayar' || 
    textLower === 'cancel' || 
    textLower === 'batal' || 
    textLower === 'status';

  const responseJid = (isFromGroup && isPrivateCommand) ? senderNumber : jid;

  // Fungsi kirim notifikasi redirect di grup pembeli
  const sendRedirectNotice = async () => {
    if (isFromGroup && isPrivateCommand) {
      const mentionJid = senderNumber.split('@')[0];
      await sock.sendMessage(jid, { 
        text: `⚠️ *Keamanan Transaksi:* Halo @${mentionJid}, demi keamanan informasi belanja & link pembayaran Anda, rincian transaksi telah kami kirimkan langsung ke *Chat Pribadi (DM)* Anda. Silakan periksa pesan masuk dari nomor bot ini.`,
        mentions: [senderNumber]
      });
    }
  };

  // 1. HELP / MENU / BANTUAN
  if (textLower === 'help' || textLower === 'menu' || textLower === 'bantuan') {
    const welcomeMessage = `━━━━━━━━━━━━━━━━━━
🏪 *SELAMAT DATANG DI ${botSettings.storeName || config.defaults.storeName}*
━━━━━━━━━━━━━━━━━━

Halo *${customerName}*, berikut adalah daftar perintah yang bisa Anda gunakan:

📌 *PERINTAH UTAMA:*
• *list* / *produk* : Melihat katalog produk & status stok kami.
• *beli [KODE] [JUMLAH]* : Memasukkan produk ke keranjang.
  _(Contoh: beli NET01 2)_
• *keranjang* / *cart* : Melihat isi keranjang belanja Anda saat ini.
• *checkout* / *bayar* : Melanjutkan ke pembayaran dengan QRIS.
• *status* : Mengecek status transaksi terakhir Anda.
• *batal* / *cancel* : Membatalkan pesanan yang sedang berjalan.
• *notify [KODE]* : Mendaftar notifikasi jika produk sedang habis.
• *bantuan* / *help* : Menampilkan menu petunjuk ini.

💡 _Setelah melakukan checkout, cukup kirim foto BUKTI TRANSFER langsung ke chat ini untuk konfirmasi pembayaran otomatis._
━━━━━━━━━━━━━━━━━━`;
    await sock.sendMessage(responseJid, { text: welcomeMessage });
    return;
  }

  // 2. LIST / PRODUK
  if (textLower === 'list' || textLower === 'produk') {
    const products = await db.getProducts();
    if (products.length === 0) {
      await sock.sendMessage(responseJid, { text: "Saat ini belum ada produk yang terdaftar di sistem." });
      return;
    }

    let msg = `━━━━━━━━━━━━━━━━━━
📦 *DAFTAR PRODUK*
━━━━━━━━━━━━━━━━━━\n\n`;

    const limit = botSettings.lowStockLimit || config.defaults.lowStockLimit;
    for (const p of products) {
      let stockStatus = "";
      if (p.stok === 0) {
        stockStatus = "🔴 *Habis* (Ketik `notify " + p.kode + "` untuk dikabari)";
      } else if (p.stok <= limit) {
        stockStatus = `🟡 *Hampir Habis* (Sisa: ${p.stok})`;
      } else {
        stockStatus = `🟢 *Ready* (Stok: ${p.stok})`;
      }

      msg += `${stockStatus} *${p.nama}*
Kode : \`${p.kode}\`
Harga : Rp${p.harga.toLocaleString('id-ID')}
Deskripsi : ${p.deskripsi || '-'}\n\n`;
    }

    msg += `━━━━━━━━━━━━━━━━━━
Ketik perintah berikut untuk membeli:
*beli [KODE] [JUMLAH]*
_(Contoh: beli NET01 1)_`;

    await sock.sendMessage(responseJid, { text: msg });
    return;
  }

  // 3. BELI [KODE] [JUMLAH]
  const buyRegex = /^(beli|buy)\s+(\w+)(?:\s+(\d+))?$/i;
  if (buyRegex.test(text)) {
    const match = text.match(buyRegex);
    const code = match[2].toUpperCase();
    const qty = match[3] ? parseInt(match[3]) : 1;

    if (qty <= 0) {
      await sock.sendMessage(responseJid, { text: "⚠️ Jumlah produk yang dibeli minimal *1*." });
      await sendRedirectNotice();
      return;
    }

    const res = await db.addToCart(senderNumber, code, qty);
    if (!res.success) {
      await sock.sendMessage(responseJid, { text: `❌ ${res.message}` });
      await sendRedirectNotice();
      return;
    }

    const successMsg = `✅ *Berhasil ditambahkan ke keranjang!*
    
*${res.productName}*
Jumlah: ${res.qty} pcs
Subtotal: *Rp${res.subtotal.toLocaleString('id-ID')}*

Ketik *keranjang* atau *cart* untuk melihat detail belanjaan Anda, atau ketik *checkout* untuk langsung melakukan pembayaran.`;

    await sock.sendMessage(responseJid, { text: successMsg });
    await sendRedirectNotice();
    return;
  }

  // 4. KERANJANG / CART
  if (textLower === 'cart' || textLower === 'keranjang') {
    const cart = await db.getCartDetails(senderNumber);
    if (cart.items.length === 0) {
      await sock.sendMessage(responseJid, { text: "🛒 *Keranjang belanja Anda masih kosong.*\nKetik *produk* untuk melihat produk yang tersedia." });
      await sendRedirectNotice();
      return;
    }

    let msg = `━━━━━━━━━━━━━━━━━━
🛒 *KERANJANG BELANJA*
━━━━━━━━━━━━━━━━━━
Order ID: *${cart.order_id}*

`;

    cart.items.forEach((item, idx) => {
      msg += `${idx + 1}. *${item.produk_nama}* (\`${item.produk_kode}\`)
   ${item.qty} x Rp${item.harga.toLocaleString('id-ID')} = *Rp${item.subtotal.toLocaleString('id-ID')}*\n\n`;
    });

    msg += `━━━━━━━━━━━━━━━━━━
*Total Belanja:* *Rp${cart.total.toLocaleString('id-ID')}*
━━━━━━━━━━━━━━━━━━
Ketik *checkout* untuk melanjutkan ke pembayaran, atau *batal* untuk mengosongkan keranjang.`;

    await sock.sendMessage(responseJid, { text: msg });
    await sendRedirectNotice();
    return;
  }

  // 5. CHECKOUT / BAYAR
  if (textLower === 'checkout' || textLower === 'bayar') {
    const res = await db.checkoutCart(senderNumber);
    if (!res.success) {
      await sock.sendMessage(responseJid, { text: `❌ ${res.message}` });
      await sendRedirectNotice();
      return;
    }

    const order = res.order;
    const itemsText = order.items.map(item => `- ${item.produk_nama} (x${item.qty})`).join('\n');

    // Coba buat transaksi Midtrans
    let midtransRes = null;
    try {
      midtransRes = await createMidtransTransaction(order);
    } catch (err) {
      console.error("[BOT] Gagal memicu Midtrans, beralih ke manual QRIS:", err.message);
    }

    if (midtransRes && midtransRes.redirect_url) {
      // Jika Midtrans aktif, kirim link pembayaran instan
      const invoiceMsg = `━━━━━━━━━━━━━━━━━━
🧾 *TAGIHAN PEMBAYARAN INSTAN*
━━━━━━━━━━━━━━━━━━
Order ID: *${order.order_id}*
Nama: *${order.customer_nama}*
Status: *WAITING_PAYMENT*

*Rincian Belanja:*
${itemsText}

💸 *TOTAL YANG HARUS DIBAYAR:*
👉 *Rp${order.total.toLocaleString('id-ID')}*

🔗 *LINK PEMBAYARAN INSTAN (MIDTRANS):*
${midtransRes.redirect_url}

_Anda dapat membayar menggunakan QRIS, GoPay, ShopeePay, OVO, Virtual Account Bank (BCA, Mandiri, BNI, BRI), atau gerai ritel (Alfamart/Indomaret) melalui link di atas._

⚠️ _Masa berlaku link pembayaran ini adalah *30 menit*. Setelah membayar, sistem akan memproses pesanan secara otomatis._
━━━━━━━━━━━━━━━━━━`;
      await sock.sendMessage(responseJid, { text: invoiceMsg });
    } else {
      // Fallback ke QRIS manual jika Midtrans Server Key belum diset
      const invoiceMsg = `━━━━━━━━━━━━━━━━━━
🧾 *TAGIHAN PEMBAYARAN MANUAL*
━━━━━━━━━━━━━━━━━━
Order ID: *${order.order_id}*
Nama: *${order.customer_nama}*
Status: *WAITING_PAYMENT*

*Rincian Belanja:*
${itemsText}

💸 *TOTAL YANG HARUS DIBAYAR:*
👉 *Rp${order.total.toLocaleString('id-ID')}*

*CARA PEMBAYARAN:*
1. Scan QRIS yang tertera di gambar atas.
2. Pastikan nominal transfer pas sebesar *Rp${order.total.toLocaleString('id-ID')}*.
3. Setelah transfer berhasil, harap kirimkan foto/screenshot *BUKTI TRANSFER* langsung ke chat ini.
━━━━━━━━━━━━━━━━━━`;
      await sendQris(responseJid, invoiceMsg);
    }

    await logToSystem('ORDER', `🛍️ Customer *${order.customer_nama}* (wa.me/${senderNumber.split('@')[0]}) melakukan checkout untuk Order ID *${order.order_id}* sebesar Rp${order.total.toLocaleString('id-ID')}`);
    await sendRedirectNotice();
    return;
  }

  // 6. CANCEL / BATAL
  if (textLower === 'cancel' || textLower === 'batal') {
    const res = await db.cancelActiveOrder(senderNumber);
    if (!res.success) {
      await sock.sendMessage(responseJid, { text: `⚠️ ${res.message}` });
      await sendRedirectNotice();
      return;
    }

    await sock.sendMessage(responseJid, { text: `✅ *Pesanan Anda (${res.orderId}) berhasil dibatalkan.*\nKeranjang/tagihan telah dikosongkan dan stok dikembalikan.` });
    await logToSystem('ORDER', `❌ Order ID *${res.orderId}* dibatalkan oleh customer.`);
    await sendRedirectNotice();
    return;
  }

  // 7. STATUS
  if (textLower === 'status') {
    const lastOrder = await db.getCustomerLastOrder(senderNumber);
    if (!lastOrder) {
      await sock.sendMessage(responseJid, { text: "Anda belum pernah melakukan pemesanan di toko kami." });
      await sendRedirectNotice();
      return;
    }

    const details = await db.getOrderDetails(lastOrder.order_id);
    let statusTranslate = details.status;
    
    switch (details.status) {
      case 'CART': statusTranslate = '🛒 Keranjang Belanja'; break;
      case 'WAITING_PAYMENT': statusTranslate = '⏳ Menunggu Pembayaran'; break;
      case 'WAITING_CONFIRMATION': statusTranslate = '🔍 Menunggu Verifikasi Admin'; break;
      case 'PAID': statusTranslate = '🟢 Pembayaran Diterima (Sedang Diproses)'; break;
      case 'COMPLETED': statusTranslate = '✅ Selesai'; break;
      case 'CANCELLED': statusTranslate = '❌ Dibatalkan'; break;
    }

    let msg = `━━━━━━━━━━━━━━━━━━
📊 *STATUS PESANAN*
━━━━━━━━━━━━━━━━━━
Order ID: *${details.order_id}*
Tanggal: ${new Date(details.created_at).toLocaleString('id-ID')}
Total: *Rp${details.total.toLocaleString('id-ID')}*
Status: *${statusTranslate}*

*Item yang dipesan:*
`;

    details.items.forEach(item => {
      msg += `- ${item.produk_nama} (x${item.qty})\n`;
    });
    
    msg += `━━━━━━━━━━━━━━━━━━`;
    await sock.sendMessage(responseJid, { text: msg });
    await sendRedirectNotice();
    return;
  }

  // 8. NOTIFY [KODE] (BERLANGGANAN NOTIFIKASI STOK)
  const notifyRegex = /^(notify|notif|hubungi)\s+(\w+)$/i;
  if (notifyRegex.test(text)) {
    const match = text.match(notifyRegex);
    const code = match[2].toUpperCase();
    const p = await db.getProductByKode(code);
    if (!p) {
      await sock.sendMessage(responseJid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
      return;
    }
    if (p.stok > 0) {
      await sock.sendMessage(responseJid, { 
        text: `🟢 Produk *${p.nama}* (\`${code}\`) saat ini sedang tersedia (Stok: ${p.stok} pcs).\nSilakan langsung pesan dengan mengetik:\n*beli ${code} 1*` 
      });
      return;
    }

    // Daftarkan ke subscriptions
    await db.addSubscription(senderNumber, code);
    const confirmMsg = `✅ *Pemberitahuan Stok Aktif!*

Kami akan otomatis mengirimkan pesan WhatsApp ke nomor ini begitu produk *${p.nama}* (\`${code}\`) sudah ready kembali. Terima kasih!`;
    await sock.sendMessage(responseJid, { text: confirmMsg });
    return;
  }

  // 9. MENERIMA FOTO BUKTI TRANSFER (DISIMPAN SECARA BERTIKAT YYYY/MM)
  if (messageObj.message.imageMessage) {
    const lastOrder = await db.getCustomerLastOrder(senderNumber);
    if (lastOrder && lastOrder.status === 'WAITING_PAYMENT') {
      console.log('Bukti pembayaran terdeteksi. Mengunduh media...');
      const buffer = await downloadMediaMessage(messageObj, 'buffer', {});

      // Buat struktur direktori bertingkat YYYY/MM
      const date = new Date(lastOrder.created_at);
      const year = date.getFullYear().toString();
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const dirPath = `./public/receipts/${year}/${month}`;
      
      // Pastikan direktori folder YYYY/MM ada
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      // Simpan bukti transfer secara lokal ke folder receipts/YYYY/MM/[ORDER_ID].jpg
      const filePath = path.join(dirPath, `${lastOrder.order_id}.jpg`);
      fs.writeFileSync(filePath, buffer);
      console.log(`Bukti transfer berhasil disimpan di: ${filePath}`);

      // Ubah status order di DB menjadi WAITING_CONFIRMATION
      await db.updateOrderStatus(lastOrder.order_id, 'WAITING_CONFIRMATION');
      const orderDetails = await db.getOrderDetails(lastOrder.order_id);

      // Konfirmasi ke customer
      const confirmText = `✅ *Bukti transfer Anda telah kami terima!*
      
Pembayaran untuk Order ID *${lastOrder.order_id}* sedang diverifikasi oleh admin. Kami akan memberikan notifikasi otomatis jika status pesanan berubah. Terima kasih!`;
      await sock.sendMessage(jid, { text: confirmText });

      // Kirim info ke Grup Transaksi WhatsApp jika diatur
      if (botSettings.transactionGroupId) {
        const groupMsg = `━━━━━━━━━━━━━━━━━━
📥 *BUKTI PEMBAYARAN BARU*
━━━━━━━━━━━━━━━━━━
Order ID: *${orderDetails.order_id}*
Nama: *${orderDetails.customer_nama}*
No WA: wa.me/${senderNumber.split('@')[0]}
Total Belanja: *Rp${orderDetails.total.toLocaleString('id-ID')}*
Status: *WAITING_CONFIRMATION*

*Item:*
${orderDetails.items.map(item => `- ${item.produk_nama} (\`${item.produk_kode}\`) x${item.qty}`).join('\n')}
━━━━━━━━━━━━━━━━━━
⚙️ *PERINTAH ADMIN (Balas di grup ini):*
• \`/paid ${orderDetails.order_id}\` : Konfirmasi pembayaran
• \`/done ${orderDetails.order_id}\` : Pesanan selesai diproses
• \`/cancel ${orderDetails.order_id}\` : Batalkan pesanan
━━━━━━━━━━━━━━━━━━`;

        await sock.sendMessage(botSettings.transactionGroupId, { 
          image: buffer, 
          caption: groupMsg 
        });
      }
      
      await logToSystem('PAYMENT', `📸 Bukti transfer diterima untuk Order ID *${lastOrder.order_id}* dari customer *${orderDetails.customer_nama}*. Bukti disimpan secara lokal.`);
      return;
    }
  }

  // Jika pesan tidak dikenali dan bukan command (hanya balas di DM agar tidak spam grup)
  if (!isFromGroup && !textLower.startsWith('/') && !buyRegex.test(text) && !notifyRegex.test(text)) {
    await sock.sendMessage(jid, { text: "Saya tidak memahami perintah tersebut. Silakan ketik *menu* atau *help* untuk petunjuk penggunaan." });
  }
}

// ==========================================
// LOGIKA PESAN GRUP (ADMIN GROUP / GET JID)
// ==========================================
async function handleGroupMessage(jid, senderNumber, messageObj, text, isAdmin) {
  if (text.startsWith('/getjid')) {
    await sock.sendMessage(jid, { 
      text: `ID Chat/Grup ini adalah:\n\`${jid}\`\n\nID Anda adalah:\n\`${senderNumber}\`\n\nSilakan salin ID di atas dan masukkan ke pengaturan Web Dashboard jika ini adalah Grup Transaksi atau Grup Log.` 
    });
    return;
  }

  if (text.startsWith('/')) {
    if (!isAdmin) return;

    const isOwner = senderNumber === botSettings.ownerNumber;
    const args = text.split(' ');
    const cmd = args[0].toLowerCase();

    // ==========================================
    // PERINTAH KHUSUS OWNER
    // ==========================================
    if (cmd === '/owner') {
      await sock.sendMessage(jid, { text: `👑 *PEMILIK BOT:*\nPemilik bot utama adalah wa.me/${(botSettings.ownerNumber || '').split('@')[0]}` });
      return;
    }

    if (cmd === '/stats') {
      if (!isOwner) {
        await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Pemilik (Owner) bot." });
        return;
      }
      const stats = await db.getStats();
      const statsText = `📊 *STATISTIK TOKO DIGITAL*
      
• Total Jenis Produk: *${stats.products}*
• Total Pelanggan: *${stats.customers}*
• Total Pesanan Selesai: *${stats.completedOrders}*
• Total Omset Penjualan: *Rp${stats.totalRevenue.toLocaleString('id-ID')}*`;
      await sock.sendMessage(jid, { text: statsText });
      return;
    }

    if (cmd === '/broadcast') {
      if (!isOwner) {
        await sock.sendMessage(jid, { text: "❌ Perintah ini hanya dapat dijalankan oleh Pemilik (Owner) bot." });
        return;
      }
      const broadcastMsg = args.slice(1).join(' ');
      if (!broadcastMsg) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `/broadcast [PESAN]`" });
        return;
      }
      
      const delayVal = botSettings.broadcastDelay || config.defaults.broadcastDelay;
      const customers = await db.getAllCustomers();
      await sock.sendMessage(jid, { text: `📢 Memulai broadcast ke *${customers.length}* pelanggan dengan jeda acak...` });
      
      let success = 0;
      for (const c of customers) {
        if (botState.whatsappConnected && sock) {
          try {
            await sock.sendMessage(c.nomor, { text: `📢 *PENGUMUMAN TOKO:*\n\n${broadcastMsg}` });
            success++;
            
            // Hitung delay acak
            const randomDelay = Math.floor(Math.random() * 4001) + delayVal;
            await new Promise(resolve => setTimeout(resolve, randomDelay)); 
          } catch (err) {
            console.error(`Gagal kirim broadcast ke ${c.nomor}:`, err.message);
          }
        } else {
          break;
        }
      }
      await sock.sendMessage(jid, { text: `✅ *Broadcast selesai!*\nBerhasil dikirim ke *${success}/${customers.length}* pelanggan.` });
      await logToSystem('BROADCAST', `📢 Siaran pesan selesai dikirim ke ${success}/${customers.length} pelanggan oleh Owner.`);
      return;
    }

    // ==========================================
    // PERINTAH ADMIN & TRANSAKSI
    // ==========================================
    if (cmd === '/paid') {
      const orderId = args[1]?.toUpperCase();
      if (!orderId) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `/paid ORD-YYYYMMDD-XXXX`" });
        return;
      }

      const res = await db.updateOrderStatus(orderId, 'PAID');
      if (!res.success) {
        await sock.sendMessage(jid, { text: `❌ Gagal: ${res.message}` });
        return;
      }

      await sock.sendMessage(jid, { text: `✅ Order ID *${orderId}* berhasil diubah ke status *PAID*. Pelanggan telah dinotifikasi.` });
      
      const notifCustomer = `🔔 *INFO PESANAN (Order: ${orderId})*
      
Pembayaran Anda telah *DITERIMA* dan diverifikasi. Pesanan sedang dalam proses pengerjaan oleh admin kami. Harap menunggu hingga produk dikirimkan. Terima kasih!`;
      await sock.sendMessage(res.customerNomor, { text: notifCustomer });
      await logToSystem('PAYMENT', `💸 Order ID *${orderId}* dikonfirmasi PAID oleh admin (wa.me/${senderNumber.split('@')[0]})`);
      return;
    }

    if (cmd === '/done') {
      const orderId = args[1]?.toUpperCase();
      if (!orderId) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `/done ORD-YYYYMMDD-XXXX`" });
        return;
      }

      const res = await db.updateOrderStatus(orderId, 'COMPLETED');
      if (!res.success) {
        await sock.sendMessage(jid, { text: `❌ Gagal: ${res.message}` });
        return;
      }

      await sock.sendMessage(jid, { text: `✅ Order ID *${orderId}* ditandai *COMPLETED*. Pelanggan telah dinotifikasi.` });

      const notifCustomer = `🔔 *INFO PESANAN (Order: ${orderId})*
      
Pesanan Anda telah *SELESAI* diproses / dikirimkan oleh admin!
Silakan cek akun/detail pesanan Anda. Jika ada kendala, hubungi admin. Terima kasih telah berbelanja! 🙏`;
      await sock.sendMessage(res.customerNomor, { text: notifCustomer });
      await logToSystem('ORDER', `✅ Order ID *${orderId}* ditandai COMPLETED oleh admin.`);
      return;
    }

    if (cmd === '/cancel') {
      const orderId = args[1]?.toUpperCase();
      if (!orderId) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `/cancel ORD-YYYYMMDD-XXXX`" });
        return;
      }

      const res = await db.updateOrderStatus(orderId, 'CANCELLED');
      if (!res.success) {
        await sock.sendMessage(jid, { text: `❌ Gagal: ${res.message}` });
        return;
      }

      await sock.sendMessage(jid, { text: `✅ Order ID *${orderId}* berhasil dibatalkan dan stok produk telah dikembalikan.` });

      const notifCustomer = `🔔 *INFO PESANAN (Order: ${orderId})*
      
Mohon maaf, pesanan Anda dengan Order ID *${orderId}* telah *DIBATALKAN* oleh admin. Jika Anda sudah melakukan pembayaran, silakan hubungi admin di chat ini untuk konfirmasi manual.`;
      await sock.sendMessage(res.customerNomor, { text: notifCustomer });
      await logToSystem('ORDER', `❌ Order ID *${orderId}* dibatalkan oleh admin.`);
      return;
    }

    if (cmd === '/stock') {
      const code = args[1]?.toUpperCase();
      const stock = parseInt(args[2]);

      if (!code || isNaN(stock)) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `/stock [KODE] [STOK_BARU]`\nContoh: `/stock NET01 15`" });
        return;
      }

      const p = await db.getProductByKode(code);
      if (!p) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
        return;
      }

      await db.updateProductStock(code, stock);
      await sock.sendMessage(jid, { text: `📦 Stok *${p.nama}* (\`${code}\`) berhasil diperbarui menjadi *${stock}* pcs.` });
      await logToSystem('SYSTEM', `📦 Stok produk *${code}* diperbarui menjadi *${stock}* oleh admin.`);
      
      // Picu notifikasi stok ready jika stok baru > 0
      await checkAndNotifySubscribers(code, stock);
      return;
    }

    if (cmd === '/price') {
      const code = args[1]?.toUpperCase();
      const price = parseInt(args[2]);

      if (!code || isNaN(price)) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `/price [KODE] [HARGA_BARU]`\nContoh: `/price NET01 50000`" });
        return;
      }

      const p = await db.getProductByKode(code);
      if (!p) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
        return;
      }

      await db.updateProductPrice(code, price);
      await sock.sendMessage(jid, { text: `💸 Harga *${p.nama}* (\`${code}\`) berhasil diperbarui menjadi *Rp${price.toLocaleString('id-ID')}*.` });
      await logToSystem('SYSTEM', `💸 Harga produk *${code}* diperbarui menjadi Rp${price} oleh admin.`);
      return;
    }

    if (cmd === '/out') {
      const code = args[1]?.toUpperCase();
      if (!code) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `/out [KODE]`" });
        return;
      }

      const p = await db.getProductByKode(code);
      if (!p) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
        return;
      }

      await db.updateProductStock(code, 0);
      await sock.sendMessage(jid, { text: `🔴 Produk *${p.nama}* (\`${code}\`) ditandai sebagai *Habis* (stok diset ke 0).` });
      await logToSystem('SYSTEM', `🔴 Produk *${code}* diset habis oleh admin.`);
      return;
    }

    if (cmd === '/ready') {
      const code = args[1]?.toUpperCase();
      if (!code) {
        await sock.sendMessage(jid, { text: "⚠️ Format salah. Gunakan: `/ready [KODE]`" });
        return;
      }

      const p = await db.getProductByKode(code);
      if (!p) {
        await sock.sendMessage(jid, { text: `❌ Produk dengan kode *${code}* tidak ditemukan.` });
        return;
      }

      await db.updateProductStock(code, 10);
      await sock.sendMessage(jid, { text: `🟢 Produk *${p.nama}* (\`${code}\`) ditandai *Ready* kembali dengan isi stok standar (10 pcs).` });
      await logToSystem('SYSTEM', `🟢 Produk *${code}* diset ready (stok 10) oleh admin.`);
      
      // Picu notifikasi stok ready jika stok baru > 0
      await checkAndNotifySubscribers(code, 10);
      return;
    }

    if (cmd === '/addproduct') {
      const rawArgs = args.slice(1).join(' ');
      const parts = rawArgs.split('|').map(p => p.trim());
      
      if (parts.length < 5) {
        const errorHelp = `⚠️ Format salah. Gunakan pemisah vertikal (\`|\`):\n\`/addproduct [KODE] | [NAMA_PRODUK] | [HARGA] | [STOK] | [DESKRIPSI]\`\n\n_Contoh:_\n\`/addproduct NET02 | Netflix 2 Bulan | 85000 | 5 | Sharing 1 Profil\``;
        await sock.sendMessage(jid, { text: errorHelp });
        return;
      }

      const codePart = parts[0].split(' ');
      const code = codePart[0].toUpperCase();
      
      const nama = parts[1];
      const harga = parseInt(parts[2]);
      const stok = parseInt(parts[3]);
      const deskripsi = parts[4];

      if (isNaN(harga) || isNaN(stok)) {
        await sock.sendMessage(jid, { text: "❌ Gagal. Harga dan Stok harus berupa angka/nominal." });
        return;
      }

      await db.addProduct(code, nama, harga, stok, deskripsi, "");
      const successText = `🆕 *PRODUK BARU BERHASIL DITAMBAHKAN!*
      
• Kode: \`${code}\`
• Nama: *${nama}*
• Harga: Rp${harga.toLocaleString('id-ID')}
• Stok: ${stok} pcs
• Deskripsi: ${deskripsi}`;
      await sock.sendMessage(jid, { text: successText });
      await logToSystem('SYSTEM', `🆕 Produk baru ditambahkan oleh admin: ${code} - ${nama}`);
      
      // Picu notifikasi jika stok baru > 0
      await checkAndNotifySubscribers(code, stok);
      return;
    }
  }
}

// Fungsi eksternal untuk memicu status online/mengetik di WhatsApp
export async function triggerPresenceUpdate(jid, presence) {
  if (botState.whatsappConnected && sock) {
    try {
      await sock.sendPresenceUpdate(presence, jid);
    } catch (err) {
      console.error(`[BOT] Gagal mengirim presence update ke ${jid}:`, err.message);
    }
  }
}
