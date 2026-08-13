const fs = require('fs');
let content = fs.readFileSync('src/handlers/customerHandler.js', 'utf8');

const missingPart = \      await logToSystem('PAYMENT', \\\📸 Bukti transfer diterima untuk Order ID *\\\* dari customer *\\\*. Bukti disimpan secara lokal.\\\);
      return;
    }
  }

  // ==========================================
  // UTILITY & BUSINESS COMMANDS
  // ==========================================
  if (cleanCmd === 'rvo' || cleanCmd === 'readviewonce' || cleanCmd === 'viewonce') {
    const quotedMsg = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quotedMsg) {
      await sock.sendMessage(jid, { text: '⚠️ Silakan balas (reply) pesan View Once dengan perintah .rvo' });
      return;
    }
    
    const viewOnceMsg = quotedMsg.viewOnceMessageV2?.message || quotedMsg.viewOnceMessageV2Extension?.message;
    if (!viewOnceMsg) {
      await sock.sendMessage(jid, { text: '⚠️ Pesan yang dibalas bukan pesan View Once (Sekali Lihat).' });
      return;
    }

    await react('⏳');
    try {
      const isImage = !!viewOnceMsg.imageMessage;
      const mediaMsg = isImage ? viewOnceMsg.imageMessage : viewOnceMsg.videoMessage;
      const stream = await downloadContentFromMessage(mediaMsg, isImage ? 'image' : 'video');
      
      let buffer = Buffer.from([]);
      for await(const chunk of stream) {
          buffer = Buffer.concat([buffer, chunk]);
      }

      const caption = mediaMsg.caption ? \\\📝 *Caption Asli:*\\\\n\\\\\\ : '';
      await sock.sendMessage(jid, 
        isImage ? { image: buffer, caption } : { video: buffer, caption }, 
        { quoted: m }
      );
      await react('✅');
    } catch (err) {
      await sock.sendMessage(jid, { text: \\\❌ Gagal mengambil pesan View Once: \\\\\\ });
      await react('❌');
    }
    return;
  }

  if (cleanCmd === 'cekresi') {
    const kurir = args[1];
    const resi = args[2];
    if (!kurir || !resi) {
      await sock.sendMessage(jid, { text: '⚠️ Format salah. Gunakan: \.cekresi <kurir> <nomor_resi>\\\\\nContoh: \.cekresi jnt JP1234567890\' });
      return;
    }
    await react('⏳');
    setTimeout(async () => {
      await sock.sendMessage(jid, { text: \\\📦 *STATUS PENGIRIMAN (MOCK)*\\\\n\\\\n*Kurir:* \\\\\\\n*Resi:* \\\\\\\n*Status:* DELIVERED\\\\n*Penerima:* Yth. Bp/Ibu\\\\n*Tanggal:* \\\\\\\n\\\\n*(Catatan: Ini adalah data simulasi karena API Key asli belum dikonfigurasi)*\\\ });
      await react('✅');
    }, 1500);
    return;
  }

  if (cleanCmd === 'removebg' || cleanCmd === 'rbg') {
    await react('⏳');
    setTimeout(async () => {
      await sock.sendMessage(jid, { text: \\\⚠️ *Fitur Belum Aktif*\\\\nFitur hapus background membutuhkan konfigurasi API Key remove.bg. Hubungi owner untuk mengaktifkannya.\\\ });
      await react('❌');
    }, 1000);
    return;
  }

  if (cleanCmd === 'tourl') {
    await react('⏳');
    setTimeout(async () => {
      await sock.sendMessage(jid, { text: \\\⚠️ *Fitur Belum Aktif*\\\\nFitur ini sedang dalam penyesuaian API upload (Telegra.ph / ImgBB).\\\ });
      await react('❌');
    }, 1000);
    return;
  }

  if (cleanCmd === 'lens' || cleanCmd === 'imagesearch') {
    const quotedMedia = m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
    const directMedia = m.message?.imageMessage;
    const hasImage = !!(quotedMedia || directMedia);

    if (!hasImage) {
      await sock.sendMessage(jid, { text: '⚠️ Kirim foto dengan caption \.lens\ atau balas/reply sebuah foto dengan perintah \.lens\ untuk mencari produk.' });
      return;
    }
    
    await react('⏳');
    setTimeout(async () => {
      await sock.sendMessage(jid, { text: \\\🔍 *HASIL PENCARIAN GOOGLE LENS (MOCK)*\\\\n\\\\nIni sepertinya adalah barang dari katalog kami: *Produk Terkait*\\\\nJika Anda ingin membelinya, silakan ketik \.beli produk\\\\\n\\\\n_(Catatan: Fitur ini menggunakan MOCK karena API Key Lens belum tersedia)\\\ }, { quoted: m });
      await react('✅');
    }, 1500);
    return;
  }

  if (cleanCmd === 'brat') {
    const textToBrat = args.slice(1).join(' ');
    if (!textToBrat) {
      await sock.sendMessage(jid, { text: '⚠️ Format salah. Gunakan: \.brat <teks>\' });
      return;
    }
    await react('⏳');
    try {
      const { createCanvas } = await import('@napi-rs/canvas');
      const canvas = createCanvas(500, 500);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#8bc34a'; // brat green
      ctx.fillRect(0, 0, 500, 500);
      ctx.fillStyle = 'black';
      ctx.font = 'bold 50px "Arial"';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      const words = textToBrat.split(' ');
      let line = '';
      const lines = [];
      for (let i = 0; i < words.length; i++) {
        const testLine = line + words[i] + ' ';
        const metrics = ctx.measureText(testLine);
        if (metrics.width > 400 && i > 0) {
          lines.push(line);
          line = words[i] + ' ';
        } else {
          line = testLine;
        }
      }
      lines.push(line);
      
      const lineHeight = 60;
      const totalHeight = lines.length * lineHeight;
      let startY = (500 - totalHeight) / 2 + (lineHeight / 2);
      
      for (const l of lines) {
        ctx.fillText(l.trim(), 250, startY);
        startY += lineHeight;
      }
      
      const buffer = await canvas.encode('png');
      await sock.sendMessage(jid, { image: buffer, caption: 'Brat Summer ✨' }, { quoted: m });
      await react('✅');
    } catch (err) {
      await sock.sendMessage(jid, { text: \\\⚠️ *Fitur Brat Gagal:* \\\\\\\n\\\\nPastikan @napi-rs/canvas terinstall atau API generator brat aktif.\\\ });
      await react('❌');
    }
    return;
  }

  // FAQ OTOMATIS — cek kemiripan keyword sebelum balas 'tidak dikenal'
  if (!isFromGroup && !textLower.startsWith('/')) {
    const faqMatch = await db.findFaqMatch(text);
    if (faqMatch) {
      await sock.sendMessage(jid, { text: faqMatch.answer });
      return;
    }
  }

}
}\;

// We find the exact place to truncate and append.
const cutoff = \      // Kirim info ke Grup Transaksi WhatsApp jika diatur
      if (botSettings.transactionGroupId) {
        const groupMsg = \\\====================================\;

// Just find the start of the cutoff block in the broken file
// Actually, it's easier to find the string "await sock.sendMessage(botSettings.transactionGroupId, { "
const splitIndex = content.lastIndexOf("await sock.sendMessage(botSettings.transactionGroupId, {");

// Wait, the file is broken. Let's just fix it.
