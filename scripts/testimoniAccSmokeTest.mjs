// scripts/testimoniAccSmokeTest.mjs
// Pengujian alur Grup Testimoni dan Konfirmasi Cepat "done" oleh Admin Toko / Owner

import assert from 'assert';
import { extractOrderIdFromMessage } from '../src/handlers/groupAdminHandler.js';
import { samarkanNomor } from '../src/handlers/testimoni.js';
import { tanggalWib, jamWib } from '../src/utils/waktu.js';

let cekHitung = 0;
let lulusHitung = 0;

function uji(nama, kondisi) {
  cekHitung++;
  try {
    assert.ok(kondisi, nama);
    lulusHitung++;
    console.log(`  OK    ${nama}`);
  } catch (err) {
    console.error(`  FAIL  ${nama}: ${err.message}`);
  }
}

console.log('\n╔══════════════════════════════════════════════════════╗');
console.log('║  UJI SMOKE: ALUR TESTIMONI & QUICK REPLY "DONE"      ║');
console.log('╚══════════════════════════════════════════════════════╝\n');

// ==========================================
// 1. Ekstraksi Order ID dari Pesan Bukti Transfer
// ==========================================
console.log('== 1. Ekstraksi Order ID dari caption testimoni ==');

const captionTestimoniFormat = `📸 *TESTIMONI / BUKTI PEMBAYARAN MASUK* 📸
━━━━━━━━━━━━━━━━━━
🧾 *Order ID:* ORD-20261006-9988
👤 *Pelanggan:* Budi (0812-xxxx-7890)
💰 *Total Transaksi:* Rp50.000
📅 *Waktu:* 06/10/2026 10:30 WIB

📦 *Pesanan:*
• Netflix Premium 1 Bulan (NET01) x1

⏳ *Status:* Menunggu Konfirmasi (Admin cukup reply \`done\` untuk ACC)
━━━━━━━━━━━━━━━━━━
✨ _Terima kasih atas kepercayaannya berbelanja di toko kami!_ 🙏`;

const mockQuotedMsg = {
  message: {
    extendedTextMessage: {
      text: "done",
      contextInfo: {
        stanzaId: "MSG-001",
        participant: "6281234567890@s.whatsapp.net",
        quotedMessage: {
          imageMessage: {
            caption: captionTestimoniFormat
          }
        }
      }
    }
  }
};

const id1 = extractOrderIdFromMessage(['done'], mockQuotedMsg);
uji('Mengekstrak ORD-20261006-9988 dari caption bertanda bintang *Order ID:*', id1 === 'ORD-20261006-9988');

// Variasi 2: Format Deposit ID
const captionDepositFormat = `📸 *TESTIMONI / BUKTI PEMBAYARAN MASUK* 📸
━━━━━━━━━━━━━━━━━━
🧾 *Deposit ID:* DEP-20261006-1122
👤 *Pelanggan:* Agus (0852-xxxx-1234)
💰 *Total Transaksi:* Rp100.000
...`;
const mockDepositMsg = {
  message: {
    conversation: {
      contextInfo: {
        quotedMessage: {
          imageMessage: {
            caption: captionDepositFormat
          }
        }
      }
    }
  }
};
const id2 = extractOrderIdFromMessage(['done'], mockDepositMsg);
uji('Mengekstrak DEP-20261006-1122 dari caption deposit', id2 === 'DEP-20261006-1122');

// Variasi 3: Di-input manual via argumen .done ORD-123
const id3 = extractOrderIdFromMessage(['.done', 'ord-manual-7788'], null);
uji('Mengekstrak dari argumen langsung .done <id>', id3 === 'ORD-MANUAL-7788');

// Variasi 4: Quoted message di dalam ephemeralMessage / viewOnce
const mockViewOnceMsg = {
  message: {
    extendedTextMessage: {
      contextInfo: {
        quotedMessage: {
          viewOnceMessage: {
            message: {
              imageMessage: {
                caption: captionTestimoniFormat
              }
            }
          }
        }
      }
    }
  }
};
const id4 = extractOrderIdFromMessage(['done'], mockViewOnceMsg);
uji('Mengekstrak dari quoted pesan bertipe viewOnceMessage', id4 === 'ORD-20261006-9988');

// Variasi 5: Caption tanpa Order ID sama sekali (misal hanya "BUKTI TRANSFER BCA")
const mockRandomMsg = {
  message: {
    extendedTextMessage: {
      contextInfo: {
        quotedMessage: {
          imageMessage: {
            caption: "BUKTI TRANSFER DARI BCA\nTERIMA KASIH MAS"
          }
        }
      }
    }
  }
};
const id5 = extractOrderIdFromMessage(['done'], mockRandomMsg);
uji('Menolak caption tanpa Order ID (tidak salah mengenali BUKTI)', id5 === null);

// ==========================================
// 2. Regex Quick Reply "done"
// ==========================================
console.log('\n== 2. Deteksi teks Quick Reply "done" ==');

const regexQuickReply = /^(done|selesai|acc|paid|terima|konfirmasi|konfirm)\b/i;

uji('Mendeteksi "done" huruf kecil', regexQuickReply.test('done'));
uji('Mendeteksi "Done" huruf besar awal', regexQuickReply.test('Done'));
uji('Mendeteksi "DONE" kapital semua', regexQuickReply.test('DONE'));
uji('Mendeteksi "acc"', regexQuickReply.test('acc'));
uji('Mendeteksi "Acc"', regexQuickReply.test('Acc'));
uji('Mendeteksi "paid"', regexQuickReply.test('paid'));
uji('Mendeteksi "selesai"', regexQuickReply.test('selesai'));
uji('Mendeteksi "konfirm"', regexQuickReply.test('konfirm'));
uji('Mendeteksi "konfirmasi"', regexQuickReply.test('konfirmasi'));
uji('Mendeteksi "done bro"', regexQuickReply.test('done bro'));
uji('Menolak kata acak yang berawalan mirip mis. "konfirmasikeren"', !regexQuickReply.test('konfirmasikeren'));
uji('Menolak teks percakapan biasa "halo bro apa kabar"', !regexQuickReply.test('halo bro apa kabar'));

// ==========================================
// 3. Penyamaran Nomor di Testimoni Grup & Waktu
// ==========================================
console.log('\n== 3. Penyamaran nomor pelanggan publik & format waktu ==');

const nomorAsli = '6281234567890@s.whatsapp.net';
const disamarkan = samarkanNomor(nomorAsli);

uji('Nomor tidak kosong', disamarkan.length > 0);
uji('Nomor asli 6281234567890 tidak bocor utuh', !disamarkan.includes('6281234567890'));
uji('Mengandung karakter penyamar ••••', disamarkan.includes('••••'));

const tglDefault = tanggalWib();
const jamDefault = jamWib();
uji('tanggalWib() tanpa argumen menghasilkan tanggal bukan strip', tglDefault !== '-' && tglDefault.length > 5);
uji('jamWib() tanpa argumen menghasilkan jam bukan strip', jamDefault !== '-' && jamDefault.includes('.'));

// ==========================================
// 4. Generator Kartu Visual Struk & Reputasi
// ==========================================
console.log('\n== 4. Generator Kartu Visual Struk & Reputasi ==');
const { createTransactionReceiptCard, createStoreReputationCard } = await import('../cardGenerator.js');

const strukBuf = await createTransactionReceiptCard({
  orderId: 'ORD-20261008-9988',
  customerName: 'Budi Santoso',
  customerNumber: '628••••7890',
  totalAmount: 50000,
  items: [{ produk_nama: 'Netflix Premium 1 Bulan', qty: 1 }],
  dateStr: '08/10/2026',
  timeStr: '15.30',
  storeName: 'Akbar Store'
});
uji('Kartu struk transaksi berhasil dibuat (Buffer non-kosong)', Buffer.isBuffer(strukBuf) && strukBuf.length > 5000);

const depStrukBuf = await createTransactionReceiptCard({
  orderId: 'DEP-20261008-1122',
  customerName: 'Siti Rahma',
  customerNumber: '628••••1122',
  totalAmount: 100000,
  isDeposit: true,
  dateStr: '08/10/2026',
  timeStr: '15.35',
  storeName: 'Akbar Store'
});
uji('Kartu struk deposit saldo berhasil dibuat (Buffer non-kosong)', Buffer.isBuffer(depStrukBuf) && depStrukBuf.length > 5000);

const repBuf = await createStoreReputationCard({
  storeName: 'Akbar Store',
  totalOrders: 50,
  deliverySpeed: '3 Detik',
  averageRating: 4.9,
  totalReviews: 45,
  recentReviews: [
    { nama_pembeli: 'Budi', rating: 5, comment: 'Sangat cepat!' }
  ]
});
uji('Kartu reputasi toko berhasil dibuat (Buffer non-kosong)', Buffer.isBuffer(repBuf) && repBuf.length > 5000);

console.log('\n════════════════════════════════════════');
console.log(`Pemeriksaan : ${cekHitung}`);
console.log(`Lulus       : ${lulusHitung}`);
console.log(`Gagal       : ${cekHitung - lulusHitung}`);
console.log('════════════════════════════════════════\n');

if (cekHitung !== lulusHitung) {
  process.exit(1);
} else {
  process.exit(0);
}
