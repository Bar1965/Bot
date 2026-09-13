/**
 * UJI ASAP KELOLA PRODUK DARI WHATSAPP
 *
 * Menguji dua hal yang tidak butuh sesi WhatsApp sama sekali:
 *   1. src/database/produkAdminDb.js — sunting sebagian kolom, pengaman stok
 *      produk AUTO, dan penghapusan produk berikut dampaknya.
 *   2. src/handlers/storeWizard.js — seluruh percakapan `.tokobaru`, dijalankan
 *      lewat pencegat yang sama yang dipakai bot, dengan sock palsu.
 *
 * Pakai:
 *   node scripts/produkAdminSmokeTest.mjs
 *
 * KEAMANAN: skrip pindah ke direktori sementara SEBELUM memuat lapisan database,
 * karena `connection.js` membuka './shop.db' relatif terhadap direktori kerja.
 * Tanpa itu, menjalankan uji ini dari akar repo akan menyuntikkan data uji ke
 * database produksi pemilik bot.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';

const AKAR = path.resolve(import.meta.dirname, '..');
const REPO = pathToFileURL(AKAR).href + '/';

const kotakPasir = fs.mkdtempSync(path.join(os.tmpdir(), 'produk-uji-'));
process.chdir(kotakPasir);
console.log(`Kotak pasir: ${kotakPasir}`);

// Nilai boneka untuk variabel yang diwajibkan config.js. Sengaja TIDAK memuat
// `.env` sungguhan: uji ini tidak butuh satu pun kredensial asli.
process.env.JWT_SECRET ||= 'uji-asap-bukan-rahasia-sungguhan';
process.env.ADMIN_USER ||= 'ujiasap';
process.env.ADMIN_PASSWORD_HASH ||= '$2b$10$0000000000000000000000000000000000000000000000000000';

// Impor HARUS sesudah chdir — lihat catatan keamanan di atas.
const db = await import(REPO + 'database.js');
const { mulaiWizardProduk, checkStoreWizardSession, adaSesiToko, hapusSesiToko } =
  await import(REPO + 'src/handlers/storeWizard.js');

await db.openDb();
await db.initDb();

// ============================================================
// PERANCAH
// ============================================================

let lulus = 0;
let gagal = 0;

function cek(nama, kondisi, detail = '') {
  if (kondisi) {
    lulus++;
    console.log(`  OK    ${nama}`);
  } else {
    gagal++;
    console.log(`  GAGAL ${nama}${detail ? ' -> ' + detail : ''}`);
  }
}

function bagian(judul) {
  console.log(`\n== ${judul} ==`);
}

const terkirim = [];
const sock = {
  sendMessage: async (jid, isi) => {
    terkirim.push({ jid, teks: isi.text || isi.caption || '' });
    return { key: { id: 'uji' } };
  }
};
const teksTerakhir = () => (terkirim.length ? terkirim[terkirim.length - 1].teks : '');
const semuaTeks = () => terkirim.map(t => t.teks).join('\n');

const JID = '628111111111@s.whatsapp.net';
const PENGIRIM = '628111111111@s.whatsapp.net';
const pesanPalsu = (teks) => ({ message: { conversation: teks } });

/** Kirim satu jawaban ke wizard, persis seperti bot.js memanggilnya. */
const jawab = (teks) => checkStoreWizardSession(sock, pesanPalsu(teks), PENGIRIM, JID, teks);

// ============================================================
// 1. PEMBACA NILAI
// ============================================================

bagian('1. Parser harga ala Indonesia');
cek('50rb -> 50000', db.parseHargaIndonesia('50rb') === 50000);
cek('50.000 -> 50000', db.parseHargaIndonesia('50.000') === 50000);
cek('Rp 85.000 -> 85000', db.parseHargaIndonesia('Rp 85.000') === 85000);
cek('120ribu -> 120000', db.parseHargaIndonesia('120ribu') === 120000);
cek('1jt -> 1000000', db.parseHargaIndonesia('1jt') === 1000000);
cek('teks ngawur -> null', db.parseHargaIndonesia('abc') === null);
cek('kosong -> null', db.parseHargaIndonesia('') === null);

bagian('2. Validasi kode produk');
cek('net01 diterima & di-uppercase', db.validasiKodeProduk('net01').nilai === 'NET01');
cek('kode berspasi ditolak', db.validasiKodeProduk('NET 01').ok === false);
cek('kode satu huruf ditolak', db.validasiKodeProduk('N').ok === false);

bagian('3. Alias nama field');
cek('price -> harga', db.resolveFieldProduk('price') === 'harga');
cek('brand -> kategori', db.resolveFieldProduk('brand') === 'kategori');
cek('foto -> gambar', db.resolveFieldProduk('foto') === 'gambar');
cek('field ngawur -> null', db.resolveFieldProduk('warna') === null);

// ============================================================
// 2. LAPISAN DATABASE
// ============================================================

const KODE = 'UJI01';

bagian('4. Buat produk MANUAL');
await db.addProduct(KODE, 'Produk Uji', 50000, 7, 'deskripsi uji', '', 'MANUAL', '', '', 'UJI', null, '1 Bulan');
let p = await db.getProductByKode(KODE);
cek('produk tersimpan', !!p);
cek('mode MANUAL', p.delivery_type === 'MANUAL');
cek('stok 7', p.stok === 7);
cek('kategori & durasi tersimpan', p.brand_category === 'UJI' && p.duration === '1 Bulan');

bagian('5. Sunting sebagian kolom tidak menimpa kolom lain');
const e1 = await db.updateProductFields(KODE, { harga: '75rb' });
p = await db.getProductByKode(KODE);
cek('harga jadi 75000', e1.success && p.harga === 75000);
cek('nama tidak ikut terhapus', p.nama === 'Produk Uji', `nama=${p.nama}`);
cek('deskripsi tidak ikut terhapus', p.deskripsi === 'deskripsi uji');
cek('kategori tidak ikut terhapus', p.brand_category === 'UJI');
cek('stok tidak ikut ternol', p.stok === 7, `stok=${p.stok}`);
cek('riwayat lama->baru terbaca', e1.perubahan[0].lama === 50000 && e1.perubahan[0].baru === 75000);

cek('field ngawur ditolak', (await db.updateProductFields(KODE, { warna: 'merah' })).alasan === 'FIELD_TIDAK_DIKENAL');
cek('harga ngawur ditolak', (await db.updateProductFields(KODE, { harga: 'abc' })).alasan === 'NILAI_TIDAK_VALID');
cek('produk tidak ada ditolak', (await db.updateProductFields('GAIB', { harga: 1000 })).alasan === 'TIDAK_ADA');
cek('mode selain AUTO/MANUAL ditolak', (await db.updateProductFields(KODE, { mode: 'SEMI' })).alasan === 'NILAI_TIDAK_VALID');
cek('gambar bukan URL ditolak', (await db.updateProductFields(KODE, { gambar: 'gambar.jpg' })).alasan === 'NILAI_TIDAK_VALID');
cek('gambar /uploads/ diterima', (await db.updateProductFields(KODE, { gambar: '/uploads/products/UJI01_1.jpg' })).success === true);

bagian('6. Stok produk MANUAL boleh diketik');
const s1 = await db.setManualStock(KODE, 12);
p = await db.getProductByKode(KODE);
cek('berhasil & stok jadi 12', s1.success && p.stok === 12);
cek('stok minus ditolak', (await db.setManualStock(KODE, -1)).alasan === 'ANGKA_TIDAK_VALID');

bagian('7. Pindah ke AUTO menyetel ulang stok dari kredensial');
const e2 = await db.updateProductFields(KODE, { mode: 'AUTO' });
p = await db.getProductByKode(KODE);
cek('mode jadi AUTO', e2.success && p.delivery_type === 'AUTO');
cek('stok ikut hitungan kredensial (0)', p.stok === 0, `stok=${p.stok}`);

bagian('8. BUG YANG DIPERBAIKI: .stock pada produk AUTO');
const s2 = await db.setManualStock(KODE, 10);
cek('ditolak, bukan ditimpa', s2.success === false, JSON.stringify(s2));
cek('alasannya PRODUK_AUTO', s2.alasan === 'PRODUK_AUTO');
p = await db.getProductByKode(KODE);
cek('stok tetap 0, bukan 10 palsu', p.stok === 0, `stok=${p.stok}`);

bagian('9. Stok AUTO diisi lewat kredensial');
const b1 = await db.addProductItemsBatch(KODE, ['uji1@mail.com|pass1', 'uji2@mail.com|pass2', 'uji3@mail.com|pass3']);
p = await db.getProductByKode(KODE);
cek('3 kredensial masuk', b1.success && b1.addedCount === 3);
cek('stok tersinkron jadi 3', p.stok === 3, `stok=${p.stok}`);

bagian('10. Penghapusan produk');
let imp = await db.getProductDeleteImpact(KODE);
cek('3 kredensial READY terhitung', imp.ready === 3);
cek('belum ada order aktif', imp.orderAktif.length === 0);

await db.runQuery("INSERT OR REPLACE INTO orders (order_id, customer_nomor, total, status) VALUES (?, ?, ?, 'WAITING_PAYMENT')", ['UJI-ORDER-1', JID, 75000]);
await db.runQuery("INSERT INTO order_items (order_id, produk_kode, qty, harga, subtotal) VALUES (?, ?, 1, 75000, 75000)", ['UJI-ORDER-1', KODE]);
const d1 = await db.deleteProductWithItems(KODE);
cek('ditolak saat ada order berjalan', d1.success === false && d1.alasan === 'ADA_TRANSAKSI');
cek('produk masih ada', !!(await db.getProductByKode(KODE)));

await db.runQuery("DELETE FROM order_items WHERE order_id = ?", ['UJI-ORDER-1']);
await db.runQuery("DELETE FROM orders WHERE order_id = ?", ['UJI-ORDER-1']);
// Satu kredensial ditandai USED: baris itu bukti garansi, tidak boleh ikut hilang.
await db.runQuery("UPDATE product_items SET status = 'USED' WHERE produk_kode = ? AND id = (SELECT MIN(id) FROM product_items WHERE produk_kode = ?)", [KODE, KODE]);
const d2 = await db.deleteProductWithItems(KODE);
cek('penghapusan berhasil', d2.success === true, JSON.stringify(d2));
cek('produk hilang', !(await db.getProductByKode(KODE)));
const sisaReady = await db.getQuery("SELECT COUNT(*) n FROM product_items WHERE produk_kode = ? AND status = 'READY'", [KODE]);
const sisaUsed = await db.getQuery("SELECT COUNT(*) n FROM product_items WHERE produk_kode = ? AND status = 'USED'", [KODE]);
cek('kredensial READY ikut terhapus', sisaReady.n === 0);
cek('kredensial USED tetap disimpan', sisaUsed.n === 1);

// ============================================================
// 3. WIZARD .tokobaru
// ============================================================

bagian('11. Pencegat wizard diam saat tidak ada sesi');
terkirim.length = 0;
cek('pesan biasa diteruskan (false)', (await jawab('halo bang')) === false);
cek('tidak ada balasan liar', terkirim.length === 0);

bagian('12. Wizard jalur AUTO sampai produk jadi');
terkirim.length = 0;
await mulaiWizardProduk(sock, JID, PENGIRIM);
cek('sesi aktif', adaSesiToko(JID, PENGIRIM) === true);
cek('pertanyaan kode muncul', teksTerakhir().includes('KODE PRODUK'));

cek('kode diterima', (await jawab('WIZ01')) === true);
cek('lanjut ke nama', teksTerakhir().includes('NAMA PRODUK'));

await jawab('Netflix Wizard 1 Bulan');
cek('lanjut ke harga', teksTerakhir().includes('HARGA JUAL'));

await jawab('bukan angka');
cek('harga ngawur ditolak & tetap di langkah harga', teksTerakhir().includes('Harga harus berupa angka'));

await jawab('50rb');
cek('lanjut ke kategori', teksTerakhir().includes('KATEGORI'));

await jawab('NETFLIX');
cek('lanjut ke durasi', teksTerakhir().includes('DURASI'));

await jawab('lewati');
cek('durasi bisa dilewati', teksTerakhir().includes('DESKRIPSI'));

await jawab('Sharing 1 profil');
cek('lanjut ke mode kirim', teksTerakhir().includes('MODE PENGIRIMAN'));

await jawab('AUTO');
cek('AUTO melompati langkah stok, minta kredensial', teksTerakhir().includes('ISI STOK AKUN'));

await jawab('akunA@mail.com|pass1\nakunB@mail.com|pass2');
cek('lanjut ke gambar', teksTerakhir().includes('GAMBAR PRODUK'));

await jawab('lewati');
cek('sampai ringkasan konfirmasi', teksTerakhir().includes('PERIKSA DULU SEBELUM DISIMPAN'));
cek('ringkasan menyebut 2 stok akun', teksTerakhir().includes('2 pcs siap kirim'));

cek('jawaban selain YA tidak menyimpan', (await jawab('mungkin')) === true);
cek('belum tersimpan', !(await db.getProductByKode('WIZ01')));

await jawab('YA');
const wiz = await db.getProductByKode('WIZ01');
cek('produk tersimpan', !!wiz);
cek('nama benar', wiz?.nama === 'Netflix Wizard 1 Bulan');
cek('harga 50rb terbaca 50000', wiz?.harga === 50000);
cek('mode AUTO', wiz?.delivery_type === 'AUTO');
cek('kategori tersimpan', wiz?.brand_category === 'NETFLIX');
cek('durasi dilewati -> kosong', !wiz?.duration);
cek('stok ikut 2 kredensial', wiz?.stok === 2, `stok=${wiz?.stok}`);
cek('sesi dibersihkan', adaSesiToko(JID, PENGIRIM) === false);
cek('pesan akhir bilang siap jual otomatis', semuaTeks().includes('siap jual otomatis'));

bagian('13. Wizard menolak kode yang sudah dipakai');
terkirim.length = 0;
await mulaiWizardProduk(sock, JID, PENGIRIM);
await jawab('WIZ01');
cek('kode ganda ditolak', teksTerakhir().includes('sudah dipakai'));
await jawab('batal');
cek('batal menghentikan sesi', adaSesiToko(JID, PENGIRIM) === false);
cek('pesan pembatalan muncul', teksTerakhir().includes('dibatalkan'));

bagian('14. Wizard jalur MANUAL');
terkirim.length = 0;
await mulaiWizardProduk(sock, JID, PENGIRIM);
await jawab('WIZ02');
await jawab('Produk Manual');
await jawab('25000');
await jawab('lewati');
await jawab('lewati');
await jawab('lewati');
await jawab('MANUAL');
cek('MANUAL meminta jumlah stok', teksTerakhir().includes('JUMLAH STOK'));
await jawab('9');
await jawab('lewati');
await jawab('YA');
const wiz2 = await db.getProductByKode('WIZ02');
cek('produk MANUAL tersimpan', !!wiz2);
cek('mode MANUAL', wiz2?.delivery_type === 'MANUAL');
cek('stok 9 tersimpan', wiz2?.stok === 9, `stok=${wiz2?.stok}`);

bagian('15. Perintah lain membatalkan wizard, tidak menelannya');
terkirim.length = 0;
await mulaiWizardProduk(sock, JID, PENGIRIM);
const diteruskan = await checkStoreWizardSession(sock, pesanPalsu('.menu'), PENGIRIM, JID, '.menu');
cek('pesan berprefix diteruskan (false)', diteruskan === false);
cek('sesi dibuang', adaSesiToko(JID, PENGIRIM) === false);
cek('admin diberi tahu', semuaTeks().includes('dibatalkan'));

bagian('16. Langkah wajib tidak bisa dilewati');
terkirim.length = 0;
await mulaiWizardProduk(sock, JID, PENGIRIM);
await jawab('lewati');
cek('kode wajib diisi', teksTerakhir().includes('wajib diisi'));
hapusSesiToko(JID, PENGIRIM);

// ============================================================
// 4. STOK TIDAK BOLEH TERKUNCI SAAT QRIS GAGAL DIBUAT
// ============================================================

bagian('17. Order gagal bayar melepas kembali kredensial AUTO');
const KODE_R = 'RSV01';
await db.addProduct(KODE_R, 'Produk Reservasi', 30000, 0, '', '', 'AUTO', '', '', null, null, null);
await db.addProductItemsBatch(KODE_R, ['resv1@mail.com|p1', 'resv2@mail.com|p2']);
cek('2 kredensial READY tersedia', (await db.getAvailableItemsCount(KODE_R)) === 2);

const PEMBELI = '628222222222@s.whatsapp.net';
await db.runQuery("INSERT OR IGNORE INTO customers (nomor, nama) VALUES (?, ?)", [PEMBELI, 'Pembeli Uji']);
const tambah = await db.addToCart(PEMBELI, KODE_R, 1);
cek('masuk keranjang', tambah.success === true, JSON.stringify(tambah));

const co = await db.checkoutCart(PEMBELI);
cek('checkout berhasil', co.success === true, JSON.stringify(co));
const orderId = co.order?.order_id;
cek('1 kredensial terkunci RESERVED', (await db.getAvailableItemsCount(KODE_R)) === 1);

// Inilah sebabnya pembatalan harus eksplisit: createCasakuTransaction yang gagal
// tidak pernah mengisi expired_at, dan penyapu 15 menit membandingkan NULL.
const ordSebelum = await db.getQuery("SELECT expired_at FROM orders WHERE order_id = ?", [orderId]);
cek('expired_at masih NULL (QRIS belum sempat dibuat)', ordSebelum.expired_at === null, `nilai=${ordSebelum.expired_at}`);
await db.expireStaleOrders(15);
cek('penyapu 15 menit TIDAK melepasnya', (await db.getAvailableItemsCount(KODE_R)) === 1,
  'kalau ini berubah, catatan di customerHandler perlu diperbarui');

// Yang dilakukan blok catch di customerHandler saat QRIS gagal dibuat.
await db.updateOrderStatus(orderId, 'CANCELLED');
cek('pembatalan mengembalikan kredensial jadi READY', (await db.getAvailableItemsCount(KODE_R)) === 2,
  `sisa=${await db.getAvailableItemsCount(KODE_R)}`);
const ordSesudah = await db.getQuery("SELECT status FROM orders WHERE order_id = ?", [orderId]);
cek('order berstatus CANCELLED', ordSesudah.status === 'CANCELLED');

bagian('18. Mencetak QRIS dua kali menelantarkan yang pertama');
// Alasan `.pay` di customerHandler sekarang memakai ulang QRIS yang masih hidup
// alih-alih selalu mencetak baru. Bagian ini mengunci PERILAKUNYA, supaya kalau
// createCasakuTransaction suatu saat jadi idempoten, catatan di sana ikut diperbarui.
const ORD = 'ORD-UJI-QRIS';
await db.runQuery("DELETE FROM payment_transactions WHERE order_id = ?", [ORD]);
await db.runQuery("INSERT OR REPLACE INTO orders (order_id, customer_nomor, total, status) VALUES (?, ?, ?, 'WAITING_PAYMENT')", [ORD, PEMBELI, 1000]);

await db.createCasakuTransaction(ORD, 'TRX-PERTAMA', 1127, 15, 'QRSTRING-PERTAMA');
const ord1 = await db.getQuery("SELECT casaku_transaction_id, payment_amount, qr_string, expired_at FROM orders WHERE order_id = ?", [ORD]);
cek('QRIS pertama tercatat di order', ord1.casaku_transaction_id === 'TRX-PERTAMA');
cek('nominal berkode unik tersimpan', ord1.payment_amount === 1127);
cek('qr_string tersimpan untuk dipakai ulang', ord1.qr_string === 'QRSTRING-PERTAMA');
cek('expired_at di masa depan', Number(ord1.expired_at) > Date.now());

// Inilah syarat yang dibaca `.pay` sebelum memutuskan mencetak ulang atau tidak.
const masihHidup = !!(ord1.casaku_transaction_id && ord1.qr_string && ord1.expired_at && Number(ord1.expired_at) > Date.now());
cek('syarat "QRIS masih hidup" terpenuhi -> .pay wajib pakai ulang', masihHidup === true);

await db.createCasakuTransaction(ORD, 'TRX-KEDUA', 1456, 15, 'QRSTRING-KEDUA');
const baris = await db.allQuery("SELECT provider_transaction_id, status FROM payment_transactions WHERE order_id = ? ORDER BY created_at", [ORD]);
const ord2 = await db.getQuery("SELECT casaku_transaction_id, payment_amount FROM orders WHERE order_id = ?", [ORD]);
cek('dua baris payment_transactions terbentuk', baris.length === 2, `jumlah=${baris.length}`);
cek('yang pertama tetap PENDING (telantar)', baris[0]?.provider_transaction_id === 'TRX-PERTAMA' && baris[0]?.status === 'PENDING');
cek('order hanya menunjuk yang kedua', ord2.casaku_transaction_id === 'TRX-KEDUA');
cek('nominal ikut berubah -> pembayar QR lama tidak dikenali', ord2.payment_amount === 1456,
  'rekonsiliasi mencari Rp1.456 sementara pembeli membayar Rp1.127');

await db.runQuery("DELETE FROM payment_transactions WHERE order_id = ?", [ORD]);
await db.runQuery("DELETE FROM orders WHERE order_id = ?", [ORD]);

bagian('19. Teks garansi sama di semua jalur pengiriman');
const { barisGaransiAktif, barisKlaimGaransi, penutupGaransi } =
  await import(REPO + 'src/utils/pesanGaransi.js');

const besok = Date.now() + 30 * 24 * 60 * 60 * 1000;
cek('tanpa garansi -> string kosong', barisGaransiAktif(null) === '');
cek('tanggal ngawur -> string kosong', barisGaransiAktif('bukan tanggal') === '');
cek('ada garansi -> menyebut tanggalnya', barisGaransiAktif(besok).includes('Garansi Aktif Hingga'));
cek('tanpa orderId -> string kosong', barisKlaimGaransi('') === '');
cek('ajakan klaim menyebut perintah + order id', barisKlaimGaransi('ORD-X').includes('.garansi ORD-X'));
cek('penutup menggabungkan keduanya',
  penutupGaransi('ORD-X', besok).includes('Garansi Aktif Hingga') &&
  penutupGaransi('ORD-X', besok).includes('.garansi ORD-X'));

// Klaim yang sesungguhnya: pengiriman menulis warranty_until, jadi `.garansi`
// punya sesuatu untuk dibaca — di jalur otomatis MAUPUN jalur `.paid`.
const KODE_G = 'GAR01';
await db.addProduct(KODE_G, 'Produk Garansi', 10000, 0, '', '', 'AUTO', '', '', null, null, '30 Hari');
await db.addProductItemsBatch(KODE_G, ['gar1@mail.com|p1']);
await db.runQuery("INSERT OR IGNORE INTO customers (nomor, nama) VALUES (?, ?)", [PEMBELI, 'Pembeli Uji']);
await db.addToCart(PEMBELI, KODE_G, 1);
const coG = await db.checkoutCart(PEMBELI);
const idG = coG.order?.order_id;
const kirim = await db.claimAndDeliverItems(idG);
cek('pengiriman berhasil', kirim?.success === true);
cek('warrantyUntil dikembalikan ke pemanggil', Number(kirim?.warrantyUntil) > Date.now());
const ordG = await db.getQuery("SELECT warranty_until FROM orders WHERE order_id = ?", [idG]);
cek('warranty_until tersimpan di order -> .garansi bisa membacanya',
  Number(ordG?.warranty_until) > Date.now(), `nilai=${ordG?.warranty_until}`);

console.log(`\n${'='.repeat(50)}`);
console.log(`HASIL: ${lulus} lulus, ${gagal} gagal`);
console.log('='.repeat(50));

try {
  fs.rmSync(kotakPasir, { recursive: true, force: true });
} catch {
  // Berkas database kadang masih terkunci di Windows; biarkan OS yang menyapu.
}

process.exit(gagal > 0 ? 1 : 0);
