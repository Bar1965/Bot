import { PDFDocument } from 'pdf-lib';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import fs from 'fs/promises';
import path from 'path';
import * as db from '../../database.js';

// Session state untuk pdfmerge
const mergeSessions = new Map();

export async function handlePdfCommands(sock, m, senderNumber, jid, cmd, args, isFromGroup, groupSettings, isPrefixCmd) {
  const isPrefix = isPrefixCmd !== undefined ? isPrefixCmd : true;
  if (!isPrefix) return false;

  const PDF_COMMANDS = ['pdfmerge', 'pdfsplit', 'img2pdf', 'pdf2txt'];
  if (!PDF_COMMANDS.includes(cmd)) {
    return false;
  }

  const premiumTier = await db.getPremiumTier(senderNumber);
  const isPremium = premiumTier !== 'Free';
  if (!isPremium) {
    await sock.sendMessage(jid, { text: '⛔ *Akses Ditolak!*\nFitur PDF Tools ini khusus untuk pengguna *Premium*.\n\nKetik `.sewabot` untuk mendaftar.' }, { quoted: m });
    return true;
  }

  const messageObj = m;
  const quotedMedia = messageObj?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage || messageObj?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.documentMessage;
  const directMedia = messageObj?.message?.imageMessage || messageObj?.message?.documentMessage;
  const hasMedia = !!(quotedMedia || directMedia);

  const getMediaMessage = () => {
    return { message: messageObj?.message?.extendedTextMessage?.contextInfo?.quotedMessage || messageObj?.message?.imageMessage?.contextInfo?.quotedMessage || messageObj?.message?.documentMessage?.contextInfo?.quotedMessage || messageObj?.message?.videoMessage?.contextInfo?.quotedMessage || messageObj?.message };
  };

  switch (cmd) {
    case 'pdfmerge':
      if (args[0] === 'cancel' || args[0] === 'batal') {
        const session = mergeSessions.get(senderNumber);
        if (session) {
          clearTimeout(session.timeout);
          mergeSessions.delete(senderNumber);
          await sock.sendMessage(jid, { text: '🛑 Sesi penggabungan PDF berhasil dibatalkan.' }, { quoted: m });
        } else {
          await sock.sendMessage(jid, { text: '⚠️ Tidak ada sesi penggabungan PDF aktif.' }, { quoted: m });
        }
        return true;
      }

      if (args[0] === 'done') {
        const session = mergeSessions.get(senderNumber);
        if (!session || session.files.length === 0) {
          await sock.sendMessage(jid, { text: '⚠️ Anda belum mengirim file PDF apapun untuk digabung. Mulai dengan ketik `.pdfmerge` lalu kirim PDF-nya.' }, { quoted: m });
          return true;
        }
        
        await sock.sendMessage(jid, { text: '_⏳ Sedang menggabungkan ' + session.files.length + ' file PDF..._' }, { quoted: m });
        
        try {
          const mergedPdf = await PDFDocument.create();
          for (const buffer of session.files) {
            const pdf = await PDFDocument.load(buffer);
            const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
            copiedPages.forEach((page) => mergedPdf.addPage(page));
          }
          const mergedPdfBytes = await mergedPdf.save();
          await sock.sendMessage(jid, {
            document: Buffer.from(mergedPdfBytes),
            mimetype: 'application/pdf',
            fileName: 'merged_ilovepdf_bot.pdf',
            caption: '✅ Ini file gabungan PDF Anda Kak!'
          }, { quoted: m });
        } catch (err) {
          console.error('[PDF_MERGE_ERR]', err);
          await sock.sendMessage(jid, { text: '❌ Gagal menggabungkan PDF: ' + err.message }, { quoted: m });
        }
        
        clearTimeout(session.timeout);
        mergeSessions.delete(senderNumber);
        return true;
      }
      
      // Jika mode pdfmerge belum aktif
      if (!mergeSessions.has(senderNumber)) {
        mergeSessions.set(senderNumber, {
          files: [],
          timeout: setTimeout(() => {
            mergeSessions.delete(senderNumber);
            sock.sendMessage(jid, { text: '⚠️ Sesi penggabungan PDF telah berakhir karena timeout (5 menit).' });
          }, 5 * 60 * 1000)
        });
        await sock.sendMessage(jid, { text: '📁 *Mode PDF Merge Diaktifkan*\n\nSilakan kirimkan file-file PDF yang ingin digabung SATU PER SATU ke sini (Maks. 15 File).\n\n• Jika sudah selesai kirim: *.pdfmerge done*\n• Untuk membatalkan: *.pdfmerge cancel*' }, { quoted: m });
        return true;
      }
      return true;

    case 'pdfsplit':
      if (!hasMedia) {
        await sock.sendMessage(jid, { text: '💡 *CARA PAKAI*\n\nReply file PDF dengan perintah:\n`.pdfsplit 1` (Ambil halaman 1 saja)\n`.pdfsplit 1-3` (Ambil halaman 1 sampai 3)' }, { quoted: m });
        return true;
      }
      try {
        await sock.sendMessage(jid, { text: '_⏳ Sedang memotong PDF..._' }, { quoted: m });
        const mediaMsg = getMediaMessage();
        const buffer = await downloadMediaMessage(mediaMsg, 'buffer', {});
        
        const range = args.join('');
        let startPage = 1, endPage = 1;
        if (range.includes('-')) {
          const parts = range.split('-');
          startPage = parseInt(parts[0]) || 1;
          endPage = parseInt(parts[1]) || startPage;
        } else {
          startPage = parseInt(range) || 1;
          endPage = startPage;
        }

        const pdfDoc = await PDFDocument.load(buffer);
        const totalPages = pdfDoc.getPageCount();

        if (startPage < 1 || startPage > totalPages || endPage > totalPages || startPage > endPage) {
          await sock.sendMessage(jid, { text: `⚠️ Range halaman tidak valid! PDF ini hanya memiliki ${totalPages} halaman.` }, { quoted: m });
          return true;
        }

        const newPdf = await PDFDocument.create();
        const indices = [];
        for (let i = startPage - 1; i < endPage; i++) indices.push(i);
        
        const copiedPages = await newPdf.copyPages(pdfDoc, indices);
        copiedPages.forEach((page) => newPdf.addPage(page));
        
        const splitPdfBytes = await newPdf.save();
        await sock.sendMessage(jid, {
          document: Buffer.from(splitPdfBytes),
          mimetype: 'application/pdf',
          fileName: `split_pages_${startPage}-${endPage}.pdf`,
          caption: '✅ PDF Anda berhasil dipotong!'
        }, { quoted: m });
      } catch (err) {
        console.error('[PDF_SPLIT_ERR]', err);
        await sock.sendMessage(jid, { text: '❌ Gagal memotong PDF: ' + err.message }, { quoted: m });
      }
      return true;

    case 'img2pdf':
      if (!hasMedia) {
        await sock.sendMessage(jid, { text: '💡 *CARA PAKAI*\n\nReply gambar dengan perintah `.img2pdf` untuk mengubahnya menjadi file PDF.' }, { quoted: m });
        return true;
      }
      try {
        await sock.sendMessage(jid, { text: '_⏳ Sedang mengonversi gambar ke PDF..._' }, { quoted: m });
        const mediaMsg = getMediaMessage();
        const buffer = await downloadMediaMessage(mediaMsg, 'buffer', {});
        
        const pdfDoc = await PDFDocument.create();
        let image;
        
        try {
          // Coba JPG dulu
          image = await pdfDoc.embedJpg(buffer);
        } catch(e) {
          // Jika gagal, coba PNG
          image = await pdfDoc.embedPng(buffer);
        }
        
        const page = pdfDoc.addPage([image.width, image.height]);
        page.drawImage(image, {
          x: 0,
          y: 0,
          width: image.width,
          height: image.height,
        });

        const pdfBytes = await pdfDoc.save();
        await sock.sendMessage(jid, {
          document: Buffer.from(pdfBytes),
          mimetype: 'application/pdf',
          fileName: 'converted_image.pdf',
          caption: '✅ Gambar berhasil diubah ke PDF!'
        }, { quoted: m });
      } catch (err) {
        console.error('[IMG2PDF_ERR]', err);
        await sock.sendMessage(jid, { text: '❌ Gagal mengonversi gambar: ' + err.message }, { quoted: m });
      }
      return true;

    case 'pdf2txt':
      if (!hasMedia) {
        await sock.sendMessage(jid, { text: '💡 *CARA PAKAI*\n\nReply dokumen PDF dengan perintah `.pdf2txt` untuk mengekstrak seluruh teks di dalamnya dengan cepat (khusus PDF digital).' }, { quoted: m });
        return true;
      }
      try {
        await sock.sendMessage(jid, { text: '_⏳ Mengekstrak teks dari PDF..._' }, { quoted: m });
        const mediaMsg = getMediaMessage();
        const buffer = await downloadMediaMessage(mediaMsg, 'buffer', {});
        
        const data = await pdfParse(buffer);
        let extractedText = data.text.trim();
        
        if (!extractedText || extractedText.length < 5) {
          extractedText = "⚠️ Teks tidak ditemukan atau PDF merupakan hasil scan (gambar). Silakan gunakan perintah *.ocr* pada PDF scan.";
        }
        
        // Kirim teks (jika terlalu panjang potong per 4000 karakter, tapi kita potong sederhana aja)
        if (extractedText.length > 4000) {
           extractedText = extractedText.substring(0, 3900) + '...\n\n_(Teks dipotong karena terlalu panjang)_';
        }

        await sock.sendMessage(jid, { text: `📄 *EKSTRAKSI PDF (pdf-parse)*\n\n${extractedText}` }, { quoted: m });
      } catch (err) {
        console.error('[PDF2TXT_ERR]', err);
        await sock.sendMessage(jid, { text: '❌ Gagal mengekstrak PDF: ' + err.message }, { quoted: m });
      }
      return true;
  }
  return false;
}

// Fungsi hook untuk mendeteksi PDF masuk jika mode merge aktif
export async function checkPdfMergeSession(sock, m, senderNumber, jid) {
  if (mergeSessions.has(senderNumber)) {
    const directMedia = m?.message?.documentMessage;
    if (directMedia && directMedia.mimetype === 'application/pdf') {
      try {
        const session = mergeSessions.get(senderNumber);
        if (session.files.length >= 15) {
          await sock.sendMessage(jid, { text: '⚠️ Batas maksimal penggabungan adalah 15 file PDF. Ketik *.pdfmerge done* untuk menggabungkan.' }, { quoted: m });
          return true;
        }

        const buffer = await downloadMediaMessage(m, 'buffer', {});
        if (buffer && buffer.length > 25 * 1024 * 1024) {
          await sock.sendMessage(jid, { text: '❌ Ukuran file PDF terlalu besar (maksimal 25MB per file).' }, { quoted: m });
          return true;
        }

        session.files.push(buffer);
        // Refresh timeout 5 menit lagi
        clearTimeout(session.timeout);
        session.timeout = setTimeout(() => {
          mergeSessions.delete(senderNumber);
          sock.sendMessage(jid, { text: '⚠️ Sesi penggabungan PDF telah berakhir karena timeout (5 menit).' });
        }, 5 * 60 * 1000);

        await sock.sendMessage(jid, { text: `✅ PDF #${session.files.length} diterima! Kirim file lainnya, ketik *.pdfmerge done* jika selesai, atau *.pdfmerge cancel* untuk membatalkan.` }, { quoted: m });
      } catch (e) {
        await sock.sendMessage(jid, { text: '❌ Gagal mengunduh PDF: ' + e.message }, { quoted: m });
      }
      return true; // Berhenti memproses command lain
    }
  }
  return false;
}
