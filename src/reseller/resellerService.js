/**
 * Reseller Lapak Service — Premium 2.0
 * Allows Premium users to create, list, and sell their own digital product listings.
 */
import * as db from '../../database.js';

/**
 * Handle lapak commands: .lapak, .lapak add, .lapak list, .lapak buy, .lapak del
 */
export async function handleLapakCommand({ sock, jid, senderNumber, messageObj, args, cleanCmd, isPremium, premiumTier }) {
  const subCmd = (args[1] || '').toLowerCase();

  // ─── .lapak / .lapak list — List active lapak products ───────
  if (!subCmd || subCmd === 'list') {
    const products = await db.getResellerProducts();
    if (products.length === 0) {
      await sock.sendMessage(jid, {
        text: `🛍️ *LAPAK KOMUNITAS RESELLER*\n\nBelum ada produk lapak aktif saat ini.\n\n👑 *Khusus Member Premium:* Ketik *.lapak add [nama] [harga] [stok] [isi_produk]* untuk membuka lapak jualan Anda!`
      }, { quoted: messageObj });
      return true;
    }

    const lines = products.map(p => {
      return `🔹 *[#${p.id}] ${p.nama}*\n   💰 Harga: *Rp${p.harga.toLocaleString('id-ID')}* | 📦 Stok: *${p.stok}*\n   👤 Penjual: ${p.seller_nama || 'Member'} (wa.me/${p.seller_jid.split('@')[0]})\n   👉 Beli: \`.lapak buy ${p.id}\``;
    });

    const msg = [
      `🛍️ *LAPAK KOMUNITAS RESELLER* (${products.length})`,
      `_Beli produk digital langganan dari sesama member toko!_`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      lines.join('\n\n'),
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `💡 *Cara Beli:* Ketik \`.lapak buy [ID]\` (pembayaran via Saldo Toko).`,
      isPremium ? `👑 *Buka Lapak:* Ketik \`.lapak add [nama] [harga] [stok] [isi_produk]\`` : `⭐ *Upgrade Premium:* Ketik \`.premium\` untuk membuka lapak jualan Anda sendiri!`
    ].join('\n\n');

    await sock.sendMessage(jid, { text: msg }, { quoted: messageObj });
    return true;
  }

  // ─── .lapak add — Buka lapak jualan (Khusus Premium) ────────
  if (subCmd === 'add' || subCmd === 'jual') {
    if (!isPremium) {
      await sock.sendMessage(jid, {
        text: `⚠️ *AKSES DITOLAK — FITUR KHUSUS PREMIUM*\n\nHanya Member Premium yang diizinkan memposting & menjual produk di Lapak Komunitas.\n\n👑 Ketik *.premium* untuk upgrade sekarang!`
      }, { quoted: messageObj });
      return true;
    }

    // Format: .lapak add [nama] [harga] [stok] [isi_produk]
    // Contoh: .lapak add Canva 1 Bulan 15000 5 user:pass123
    const nama = args[2];
    const harga = parseInt(args[3]);
    const stok = parseInt(args[4]);
    const isiProduk = args.slice(5).join(' ');

    if (!nama || isNaN(harga) || isNaN(stok) || !isiProduk) {
      await sock.sendMessage(jid, {
        text: `❌ *Format Salah!*\n\n📌 *Format:* \`.lapak add [Nama_Produk] [Harga] [Stok] [Isi_Produk/Akun]\`
\n*Contoh:* \`.lapak add Canva_Pro 15000 3 email@canva.com:pass123\`

_Catatan: Gunakan underscore (_) untuk nama produk yang terdiri dari beberapa kata._`
      }, { quoted: messageObj });
      return true;
    }

    if (harga < 1000) {
      await sock.sendMessage(jid, { text: `⚠️ Harga produk minimal Rp1.000.` }, { quoted: messageObj });
      return true;
    }

    const sellerName = messageObj?.pushName || 'Reseller';
    const cleanNama = nama.replace(/_/g, ' ');
    const res = await db.createResellerProduct(senderNumber, sellerName, cleanNama, harga, stok, isiProduk);

    await sock.sendMessage(jid, {
      text: `🎉 *LAPAK BERHASIL DIBUKA!* 🎉\n\n🆔 *Lapak ID:* #${res.id}\n📦 Produk: *${res.nama}*\n💰 Harga: *Rp${res.harga.toLocaleString('id-ID')}*\n📊 Stok: *${res.stok} pcs*\n\n_Produk Anda sudah aktif di \`.lapak list\`! Setiap ada yang membeli, saldo Anda akan otomatis bertambah (dipotong 2% admin fee toko)._`
    }, { quoted: messageObj });
    return true;
  }

  // ─── .lapak buy [ID] — Beli produk dari lapak ──────────────
  if (subCmd === 'buy' || subCmd === 'beli') {
    const lapakId = parseInt(args[2]);
    if (isNaN(lapakId)) {
      await sock.sendMessage(jid, { text: `❌ Format: \`.lapak buy [ID]\` (contoh: \`.lapak buy 1\`)` }, { quoted: messageObj });
      return true;
    }

    const buyRes = await db.buyResellerProduct(senderNumber, lapakId);
    if (!buyRes.success) {
      await sock.sendMessage(jid, { text: `❌ ${buyRes.message}` }, { quoted: messageObj });
      return true;
    }

    // Send item content to buyer
    const buyerMsg = [
      `🎉 *PEMBELIAN LAPAK BERHASIL!* 🎉`,
      `📦 Produk: *${buyRes.item.nama}* (Lapak #${buyRes.item.id})`,
      `💰 Harga: *Rp${buyRes.item.harga.toLocaleString('id-ID')}*`,
      `👤 Penjual: *${buyRes.item.seller_nama || 'Reseller'}*`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━`,
      `🎁 *ISI PRODUK / AKUN:*`,
      `\`\`\`${buyRes.isiProduk}\`\`\``,
      `━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `_Terima kasih telah berbelanja di Lapak Komunitas!_`
    ].join('\n');

    await sock.sendMessage(jid, { text: buyerMsg }, { quoted: messageObj });

    // Notify seller via DM
    try {
      const sellerJid = buyRes.item.seller_jid.includes('@') ? buyRes.item.seller_jid : `${buyRes.item.seller_jid.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
      const notifySellerMsg = `🔔 *LAPAK ANDA TERJUAL!* 🔔\n\n📦 Produk *${buyRes.item.nama}* (Lapak #${buyRes.item.id}) telah dibeli oleh wa.me/${senderNumber.split('@')[0]}.\n\n💸 Saldo +*Rp${buyRes.sellerPayout.toLocaleString('id-ID')}* (98% dari Rp${buyRes.item.harga.toLocaleString('id-ID')}) telah otomatis ditambahkan ke akun toko Anda!`;
      await sock.sendMessage(sellerJid, { text: notifySellerMsg });
    } catch (sErr) {}

    return true;
  }

  return false;
}
