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

bagian('20. Kepemilikan pesanan: @lid vs nomor HP');
// `.garansi` dan `.review` memakai ini untuk memutuskan apakah penanya benar
// pemilik pesanan. Mayoritas baris orders tersimpan sebagai @lid sementara
// pengirim yang sama di DM datang sebagai nomor HP, jadi perbandingan
// huruf-per-huruf menolak pembeli yang sah.
const LID_A = '59837887057934@lid';
const HP_A = '628111222333@s.whatsapp.net';
const LID_B = '11111111111111@lid';
const HP_B = '628999888777@s.whatsapp.net';

await db.catatPetaLid(LID_A, '628111222333');

cek('JID sama persis', (await db.samaOrangnya(HP_A, HP_A)) === true);
cek('nomor sama, sufiks perangkat beda', (await db.samaOrangnya('628111222333:12@s.whatsapp.net', HP_A)) === true);
cek('dua nomor berbeda ditolak', (await db.samaOrangnya(HP_A, HP_B)) === false);
cek('@lid terpetakan cocok dengan nomornya', (await db.samaOrangnya(LID_A, HP_A)) === true);
cek('urutan dibalik tetap cocok', (await db.samaOrangnya(HP_A, LID_A)) === true);
cek('@lid terpetakan vs nomor LAIN ditolak', (await db.samaOrangnya(LID_A, HP_B)) === false);
cek('@lid BELUM terpetakan ditolak, bukan ditebak', (await db.samaOrangnya(LID_B, HP_B)) === false);
cek('dua @lid berbeda tanpa peta ditolak', (await db.samaOrangnya(LID_A, LID_B)) === false);
cek('kosong ditolak', (await db.samaOrangnya('', HP_A)) === false);
cek('null ditolak', (await db.samaOrangnya(null, LID_A)) === false);

// Dua @lid berbeda milik orang yang sama (ganti perangkat) harus dikenali.
await db.catatPetaLid(LID_B, '628111222333');
cek('dua @lid berbeda, nomor sama -> orang yang sama', (await db.samaOrangnya(LID_A, LID_B)) === true);

bagian('21. Stempel waktu database dibaca sebagai UTC, ditampilkan WIB');
const { keWaktu, tanggalJamWib, tanggalWib, tanggalPanjangWib } =
  await import(REPO + 'src/utils/waktu.js');

// Bentuk yang dihasilkan CURRENT_TIMESTAMP SQLite: UTC, tanpa penanda zona.
const UTC_STR = '2026-09-13 03:55:38';
const d = keWaktu(UTC_STR);
cek('string SQLite terbaca sebagai UTC', d.toISOString() === '2026-09-13T03:55:38.000Z', d?.toISOString());
cek('ditampilkan sebagai 10.55 WIB, bukan 03.55', tanggalJamWib(UTC_STR).includes('10.55.38'), tanggalJamWib(UTC_STR));

// Pesanan dini hari WIB: 2026-09-13 01:00 WIB = 2026-09-12 18:00 UTC.
// Dibaca mentah, tanggalnya mundur sehari menjadi 12 September.
cek('tanggal dini hari tidak mundur sehari', tanggalWib('2026-09-12 18:00:00').includes('13/9/2026'), tanggalWib('2026-09-12 18:00:00'));

cek('epoch milidetik (angka) terbaca', keWaktu(1789000000000) instanceof Date);
cek('epoch milidetik (string angka) terbaca', keWaktu('1789000000000') instanceof Date);
cek('string ISO ber-zona tidak digeser lagi', keWaktu('2026-09-13T03:55:38.000Z').toISOString() === '2026-09-13T03:55:38.000Z');
cek('null -> null', keWaktu(null) === null);
cek('teks ngawur -> null', keWaktu('bukan tanggal') === null);
cek('tampilan null memakai cadangan', tanggalJamWib(null) === '-');
cek('tanggal panjang WIB terbentuk', tanggalPanjangWib(UTC_STR).includes('2026'));

bagian('22. Jam kedaluwarsa QRIS dipaku ke WIB');
const { jamWib } = await import(REPO + 'src/utils/waktu.js');

// expiredAt dari Casaku bisa datang sebagai epoch milidetik ATAU string API.
// Kalau stringnya tanpa penanda zona, bentuknya sama persis dengan keluaran
// SQLite dan ikut meleset 7 jam — padahal labelnya di tagihan tertulis "WIB".
const EPOCH_UJI = Date.UTC(2026, 8, 13, 10, 40, 0);
cek('epoch milidetik -> jam WIB', jamWib(EPOCH_UJI) === '17.40', jamWib(EPOCH_UJI));
cek('string tanpa zona dibaca UTC, bukan lokal', jamWib('2026-09-13 10:40:00') === '17.40', jamWib('2026-09-13 10:40:00'));
cek('string ISO ber-zona tidak digeser dua kali', jamWib('2026-09-13T10:40:00.000Z') === '17.40', jamWib('2026-09-13T10:40:00.000Z'));
cek('nilai kosong memakai cadangan', jamWib(null) === '-');

bagian('23. Imbalan pembelian sama rata di semua jalur bayar');
const PEMBELANJA = '628777000111';
await db.getOrCreateCustomer(PEMBELANJA, 'Pembeli Uji');

// Rp50.000 -> 50 Akbar Poin (10 per Rp10.000) dan 5 Poin Loyalty (1 per Rp10.000).
const poinSatu = await db.awardPurchasePoints(PEMBELANJA, 50000, 'ORD-UJI-1');
cek('Akbar Poin dihitung 10 per Rp10.000', poinSatu === 50, poinSatu);

const profilSatu = await db.getGameProfile(PEMBELANJA);
cek('Akbar Poin masuk ke game_profiles', profilSatu.points === 50, profilSatu.points);

const loyalSatu = await db.getLoyalty(PEMBELANJA);
cek('Poin Loyalty ikut bertambah', loyalSatu.points === 5, loyalSatu.points);
cek('total_spent ikut tercatat', loyalSatu.total_spent === 50000, loyalSatu.total_spent);

// Jalur `.paid` sudah lewat updateOrderStatus, yang menambah Poin Loyalty
// sendiri. Tanpa penanda ini jalur itu menghitung Loyalty dua kali.
const poinDua = await db.awardPurchasePoints(PEMBELANJA, 50000, 'ORD-UJI-2', { sertakanLoyalty: false });
cek('Akbar Poin tetap diberikan tanpa loyalty', poinDua === 50, poinDua);

const profilDua = await db.getGameProfile(PEMBELANJA);
cek('Akbar Poin bertambah jadi 100', profilDua.points === 100, profilDua.points);

const loyalDua = await db.getLoyalty(PEMBELANJA);
cek('Poin Loyalty TIDAK dobel', loyalDua.points === 5, loyalDua.points);
cek('total_spent tidak dobel', loyalDua.total_spent === 50000, loyalDua.total_spent);

// Di bawah ambang: tidak ada poin, dan tidak boleh melempar.
const poinTiga = await db.awardPurchasePoints(PEMBELANJA, 9999, 'ORD-UJI-3');
cek('belanja di bawah Rp10.000 tidak berpoin', poinTiga === 0, poinTiga);

// points NULL dulu bisa terjadi lewat SQL lama `points = points + ?` di
// markTransactionPaid: hasilnya NULL lagi, jadi poin pelanggan HILANG, bukan
// sekadar tidak bertambah. COALESCE harus menyembuhkannya.
const PEMILIK_NULL = '628777000222';
await db.getOrCreateCustomer(PEMILIK_NULL, 'Profil Nullan');
await db.runQuery("INSERT OR REPLACE INTO game_profiles (customer_jid, points, xp) VALUES (?, NULL, NULL)", [PEMILIK_NULL]);
await db.awardPurchasePoints(PEMILIK_NULL, 30000, 'ORD-UJI-4');
const profilNull = await db.getGameProfile(PEMILIK_NULL);
cek('profil dengan points NULL tidak jadi NULL lagi', profilNull.points === 30, profilNull.points);

// Nominal aneh tidak boleh menulis NaN ke database.
const poinEmpat = await db.awardPurchasePoints(PEMBELANJA, 'bukan angka', 'ORD-UJI-5');
cek('nominal bukan angka -> 0 poin', poinEmpat === 0, poinEmpat);
const profilEmpat = await db.getGameProfile(PEMBELANJA);
cek('poin tidak jadi NaN', profilEmpat.points === 100, profilEmpat.points);

bagian('24. Penjaga menu mode jualan memakai registry, bukan salinan alias');
const { resolveCategoryId, kategoriDisembunyikanModeJualan, buildCommandMenu, KATEGORI_MODE_JUALAN } =
  await import(REPO + 'commandRegistry.js');

// Daftar alias yang DULU ditulis tangan di customerHandler sebagai penjaga.
const PENJAGA_LAMA = ['3', '4', '6', '7', '8', 'downloader', 'media', 'hiburan',
  'game', 'games', 'fun', 'pdf', 'premium', 'sosial', 'social'];

// Setiap alias yang mengurai ke kategori tersembunyi HARUS tertangkap penjaga.
// Kalau tidak, buildCommandMenu mengembalikan null di mode jualan dan pelanggan
// jatuh ke cabang yang salah. Ini yang dulu terjadi pada 13 alias.
const ALIAS_SEMUA = ['1', 'jualan', 'produk', 'katalog', 'list', 'shop', 'store',
  '2', 'transaksi', 'bayar', 'order', 'checkout', 'payment',
  '3', 'game', 'games', 'gaming', 'arcade', 'play', 'mabar', 'permainan',
  '4', 'media', 'downloader', 'tools', 'download', 'alat',
  '5', 'poin', 'reward', 'bank', 'ekonomi', 'saldo', 'level',
  '6', 'premium', 'vip', 'ai', 'gemini',
  '7', 'pdf', 'dokumen', 'ocr',
  '8', 'hiburan', 'fun', 'sosial', 'social',
  '9', 'admin', 'owner', 'pengaturan', 'setting'];

const bocorLama = ALIAS_SEMUA.filter(a =>
  kategoriDisembunyikanModeJualan(resolveCategoryId(a)) && !PENJAGA_LAMA.includes(a));
cek('penjaga tulisan tangan memang bocor (13 alias)', bocorLama.length === 13, bocorLama.join(','));

// Penjaga sekarang: satu pertanyaan ke registry, jadi tidak bisa melenceng.
const bocorBaru = ALIAS_SEMUA.filter(a => {
  const kat = resolveCategoryId(a);
  return kategoriDisembunyikanModeJualan(kat) && !kategoriDisembunyikanModeJualan(kat);
});
cek('penjaga berbasis registry tidak bocor', bocorBaru.length === 0, bocorBaru.join(','));

// Kategori tersembunyi memang membuat buildCommandMenu mengembalikan null —
// itulah yang dulu menjatuhkan pelanggan ke menu warisan.
cek('kategori tersembunyi -> null di mode jualan', buildCommandMenu('gaming', { salesMode: true }) === null);
cek('kategori tampil -> tetap berisi teks', typeof buildCommandMenu('jualan', { salesMode: true }) === 'string');
cek('tanpa sufiks -> beranda menu, tidak pernah null', typeof buildCommandMenu('all', { salesMode: true }) === 'string');
cek('mode all: tidak ada kategori yang tersembunyi', ALIAS_SEMUA.every(a => typeof buildCommandMenu(a, { salesMode: false }) === 'string'));
cek('daftar kategori mode jualan ada 4', KATEGORI_MODE_JUALAN.length === 4, KATEGORI_MODE_JUALAN.join(','));

bagian('25. Masa garansi dibaca dari angka+satuan, bukan potongan teks');
const { masaGaransiMs } = await import(REPO + 'src/utils/pesanGaransi.js');
const HARI_MS = 86400000;
const garansiHari = (d) => masaGaransiMs(d) / HARI_MS;

// Empat produk toko ini SALAH hitung dengan pencocokan potongan teks yang lama.
cek('"12 Bulan" -> 360 hari, bukan 60', garansiHari('12 Bulan') === 360, garansiHari('12 Bulan'));
cek('"6 Bulan" -> 180 hari, bukan 30', garansiHari('6 Bulan') === 180, garansiHari('6 Bulan'));
cek('"18 Bulan" -> 540 hari, bukan 30', garansiHari('18 Bulan') === 540, garansiHari('18 Bulan'));
cek('"1 Tahun" -> 365 hari', garansiHari('1 Tahun') === 365, garansiHari('1 Tahun'));
// Yang dulu kebetulan benar harus tetap benar.
cek('"7 Hari" -> 7 hari', garansiHari('7 Hari') === 7);
cek('"14 Hari" -> 14 hari', garansiHari('14 Hari') === 14);
cek('"30 Hari" -> 30 hari', garansiHari('30 Hari') === 30);
cek('"3 Bulan" -> 90 hari', garansiHari('3 Bulan') === 90);
cek('"17 Hari" tidak dibaca jadi 7', garansiHari('17 Hari') === 17, garansiHari('17 Hari'));
cek('kosong -> 30 hari (perilaku lama dipertahankan)', garansiHari('') === 30);
cek('"Lifetime" -> 30 hari (kebijakan owner, bukan urusan parser)', garansiHari('Lifetime') === 30);
cek('salah ketik besar dibatasi 10 tahun', garansiHari('9999 Bulan') === 3650, garansiHari('9999 Bulan'));

bagian('26. Tanggal kedaluwarsa polos berarti AKHIR hari WIB');
const { akhirHariWib } = await import(REPO + 'src/utils/waktu.js');
const kuponHabis = akhirHariWib('2026-12-31');
cek('tanggal polos -> 16:59:59 UTC (= 23.59.59 WIB)',
  kuponHabis.toISOString().startsWith('2026-12-31T16:59:59'), kuponHabis.toISOString());
// Pukul 10 pagi WIB tanggal 31 Des = 03:00Z. Kupon harus MASIH hidup.
cek('kupon masih hidup siang hari terakhir',
  kuponHabis.getTime() > Date.parse('2026-12-31T03:00:00Z'));
// new Date() mentah memberi 00:00Z, yaitu 07.00 WIB -> sudah mati sejak pagi.
cek('cara lama memang mematikannya pukul 07.00 WIB',
  new Date('2026-12-31').getTime() < Date.parse('2026-12-31T03:00:00Z'));
cek('nilai ber-jam diteruskan apa adanya',
  akhirHariWib('2026-12-31T05:00:00Z').toISOString() === '2026-12-31T05:00:00.000Z');
cek('kosong -> null', akhirHariWib('') === null);

bagian('27. Job pengiriman idempoten per pesanan');
const ORDER_FJ = 'ORD-FJ-UJI';
await db.getOrCreateCustomer('628999000111', 'Uji Job');
await db.runQuery("INSERT OR REPLACE INTO orders (order_id, customer_nomor, total, status) VALUES (?, ?, ?, 'WAITING_PAYMENT')",
  [ORDER_FJ, '628999000111', 50000]);
await db.createFulfillmentJob(ORDER_FJ, '628999000111');
await db.createFulfillmentJob(ORDER_FJ, '628999000111');
const jobs = await db.allQuery("SELECT job_id FROM fulfillment_jobs WHERE order_id = ?", [ORDER_FJ]);
cek('dua panggilan -> tetap SATU job', jobs.length === 1, `${jobs.length} job: ${jobs.map(j => j.job_id).join(', ')}`);
cek('job_id tidak mengandung stempel waktu', jobs[0].job_id === `FJ-${ORDER_FJ}`, jobs[0].job_id);

bagian('28. Kupon: ditebus sekali, dan tidak menyandera pesanan');
await db.runQuery("INSERT OR REPLACE INTO coupons (code, type, value, min_order, max_uses, used_count, is_active) VALUES ('UJISEKALI', 'percent', 10, 0, 1, 0, 1)");
const pesananKupon = { order_id: ORDER_FJ, coupon_code: 'UJISEKALI', coupon_redeemed: 0 };
const tebus1 = await db.tebusKupon(pesananKupon);
cek('penebusan pertama berhasil', tebus1.ditebus === true && tebus1.habis === false);
const kuponRow = await db.getQuery("SELECT used_count FROM coupons WHERE code = 'UJISEKALI'");
cek('used_count naik jadi 1', kuponRow.used_count === 1, kuponRow.used_count);
// Pesanan KEDUA yang memakai kupon sama: kuotanya sudah habis.
const tebus2 = await db.tebusKupon({ order_id: 'ORD-LAIN', coupon_code: 'UJISEKALI', coupon_redeemed: 0 });
cek('penebusan kedua dilaporkan habis', tebus2.habis === true && tebus2.ditebus === false);
const kuponRow2 = await db.getQuery("SELECT used_count FROM coupons WHERE code = 'UJISEKALI'");
cek('used_count TIDAK melewati max_uses', kuponRow2.used_count === 1, kuponRow2.used_count);
// Sudah ditebus -> dilewati, bukan dihitung lagi.
const tebus3 = await db.tebusKupon({ order_id: ORDER_FJ, coupon_code: 'UJISEKALI', coupon_redeemed: 1 });
cek('pesanan yang sudah ditebus dilewati', tebus3.ditebus === false && tebus3.habis === false);

bagian('29. updateOrderStatus menulis payment_status saat pesanan jadi lunas');
await db.updateOrderStatus(ORDER_FJ, 'PAID');
const ordLunas = await db.getQuery("SELECT status, payment_status FROM orders WHERE order_id = ?", [ORDER_FJ]);
cek('status jadi PAID', ordLunas.status === 'PAID', ordLunas.status);
cek('payment_status ikut jadi PAID', ordLunas.payment_status === 'PAID', String(ordLunas.payment_status));
// Inilah penjaga yang dipakai markTransactionPaid; kalau tetap PENDING, webhook
// yang terlambat akan melunaskan ulang pesanan yang sudah di-`.paid`.

bagian('30. .batal memilih pesanan yang sama dengan yang QRIS-nya dibatalkan');
const PELANGGAN_B = '628999000222';
await db.getOrCreateCustomer(PELANGGAN_B, 'Uji Batal');
await db.runQuery("INSERT OR REPLACE INTO orders (order_id, customer_nomor, total, status, created_at) VALUES ('ORD-LAMA', ?, 10000, 'WAITING_PAYMENT', '2026-09-01 00:00:00')", [PELANGGAN_B]);
await db.runQuery("INSERT OR REPLACE INTO orders (order_id, customer_nomor, total, status, created_at) VALUES ('ORD-BARU', ?, 10000, 'CART', '2026-09-10 00:00:00')", [PELANGGAN_B]);
const dipilih = await db.getOrderUntukDibatalkan(PELANGGAN_B);
cek('WAITING_PAYMENT didahulukan dari CART yang lebih baru', dipilih.order_id === 'ORD-LAMA', dipilih.order_id);

bagian('31. Pecahan pada harga bersatuan');
// "12,5rb" berarti Rp12.500. Dulu pemisahnya dibuang lebih dulu sehingga
// menjadi 125 x 1000 = Rp125.000 — sepuluh kali lipat, tanpa peringatan.
cek('12,5rb -> 12500', db.parseHargaIndonesia('12,5rb') === 12500, db.parseHargaIndonesia('12,5rb'));
cek('12.5rb -> 12500', db.parseHargaIndonesia('12.5rb') === 12500, db.parseHargaIndonesia('12.5rb'));
cek('1,5jt -> 1500000', db.parseHargaIndonesia('1,5jt') === 1500000, db.parseHargaIndonesia('1,5jt'));
cek('2,25jt -> 2250000', db.parseHargaIndonesia('2,25jt') === 2250000, db.parseHargaIndonesia('2,25jt'));
cek('0,5rb -> 500', db.parseHargaIndonesia('0,5rb') === 500, db.parseHargaIndonesia('0,5rb'));
// Pemisah ribuan TANPA satuan harus tetap dibuang seperti semula.
cek('50.000 tetap 50000', db.parseHargaIndonesia('50.000') === 50000);
cek('1.250.000 tetap 1250000', db.parseHargaIndonesia('1.250.000') === 1250000, db.parseHargaIndonesia('1.250.000'));
cek('50rb tetap 50000', db.parseHargaIndonesia('50rb') === 50000);

bagian('32. Bukti transfer tidak melepas stok yang masih dikunci');
const KODE_BUKTI = 'UJIBUKTI';
const PEMBELI_BUKTI = '628999000333';
await db.getOrCreateCustomer(PEMBELI_BUKTI, 'Uji Bukti');
await db.addProduct(KODE_BUKTI, 'Produk Uji Bukti', 20000, 5, 'uji', '', 'MANUAL', '', '', null, null, '30 Hari');
await db.addToCart(PEMBELI_BUKTI, KODE_BUKTI, 2);
const coBukti = await db.checkoutCart(PEMBELI_BUKTI);
cek('checkout berhasil', coBukti.success === true, coBukti.message);
const stokSesudahCheckout = (await db.getProductByKode(KODE_BUKTI)).stok;
cek('stok MANUAL berkurang saat checkout', stokSesudahCheckout === 3, stokSesudahCheckout);

// Inilah yang terjadi saat pelanggan mengirim foto bukti transfer.
await db.updateOrderStatus(coBukti.order.order_id, 'WAITING_CONFIRMATION');
const stokSesudahBukti = (await db.getProductByKode(KODE_BUKTI)).stok;
cek('stok TIDAK dikembalikan saat menunggu verifikasi', stokSesudahBukti === 3, stokSesudahBukti);
const reservedMasih = await db.getQuery("SELECT stock_reserved FROM order_items WHERE order_id = ?", [coBukti.order.order_id]);
cek('tanda stock_reserved tetap menyala', reservedMasih.stock_reserved === 1, reservedMasih.stock_reserved);

// Pembatalan sungguhan tetap harus mengembalikannya.
await db.updateOrderStatus(coBukti.order.order_id, 'CANCELLED');
const stokSesudahBatal = (await db.getProductByKode(KODE_BUKTI)).stok;
cek('pembatalan tetap mengembalikan stok', stokSesudahBatal === 5, stokSesudahBatal);

bagian('33. Penjaga hapus produk mengenal pesanan yang SUDAH DIBAYAR');
const KODE_PAID = 'UJIPAID';
const PEMBELI_PAID = '628999000444';
await db.getOrCreateCustomer(PEMBELI_PAID, 'Uji Paid');
await db.addProduct(KODE_PAID, 'Produk Uji Paid', 30000, 5, 'uji', '', 'MANUAL', '', '', null, null, '30 Hari');
await db.addToCart(PEMBELI_PAID, KODE_PAID, 1);
const coPaid = await db.checkoutCart(PEMBELI_PAID);
await db.updateOrderStatus(coPaid.order.order_id, 'PAID');
const dampak = await db.getProductDeleteImpact(KODE_PAID);
cek('pesanan berstatus PAID terhitung sebagai transaksi aktif',
  dampak.orderAktif.some(o => o.status === 'PAID'), JSON.stringify(dampak.orderAktif));
const hapus = await db.deleteProductWithItems(KODE_PAID);
cek('penghapusan ditolak selama ada pesanan PAID', hapus.success === false && hapus.alasan === 'ADA_TRANSAKSI', JSON.stringify(hapus));

bagian('34. Penyapu 24 jam memakai umur TAGIHAN, bukan umur keranjang');
const kolom = await db.allQuery("PRAGMA table_info(orders)");
cek('kolom waiting_since ada', kolom.some(k => k.name === 'waiting_since'));
const ordBaru = await db.getQuery("SELECT waiting_since FROM orders WHERE order_id = ?", [coPaid.order.order_id]);
cek('checkout menstempel waiting_since', Boolean(ordBaru.waiting_since), String(ordBaru.waiting_since));
// Keranjang lahir 3 hari lalu, tagihannya baru terbit barusan -> JANGAN disapu.
await db.runQuery("UPDATE orders SET status='WAITING_PAYMENT', created_at = datetime('now','-3 days'), waiting_since = CURRENT_TIMESTAMP WHERE order_id = ?", [coPaid.order.order_id]);
const kedaluwarsa = await db.getExpiredOrders();
cek('keranjang lama + tagihan baru TIDAK ikut disapu',
  !kedaluwarsa.some(o => o.order_id === coPaid.order.order_id), kedaluwarsa.map(o => o.order_id).join(','));
// Tagihan yang memang sudah 25 jam -> harus disapu.
await db.runQuery("UPDATE orders SET waiting_since = datetime('now','-25 hours') WHERE order_id = ?", [coPaid.order.order_id]);
const kedaluwarsa2 = await db.getExpiredOrders();
cek('tagihan lewat 24 jam tetap disapu',
  kedaluwarsa2.some(o => o.order_id === coPaid.order.order_id), kedaluwarsa2.map(o => o.order_id).join(','));

bagian('35. Pengiriman yang macet punya jalan pulang');
const ORD_MACET = 'ORD-MACET-UJI';
const PEMBELI_MACET = '628999000555';
await db.getOrCreateCustomer(PEMBELI_MACET, 'Uji Macet');
await db.runQuery("INSERT OR REPLACE INTO orders (order_id, customer_nomor, total, status, payment_status) VALUES (?, ?, 60000, 'COMPLETED', 'PAID')", [ORD_MACET, PEMBELI_MACET]);
await db.createFulfillmentJob(ORD_MACET, PEMBELI_MACET);
// Persis keadaan yang ditinggalkan worker setelah menyerah.
await db.runQuery("UPDATE fulfillment_jobs SET status = 'MANUAL_REVIEW', attempts = 6, last_error = 'STOK KOSONG' WHERE order_id = ?", [ORD_MACET]);

const antreanSebelum = await db.getPendingFulfillmentJobs();
cek('job MANUAL_REVIEW memang tidak pernah diambil worker',
  !antreanSebelum.some(j => j.order_id === ORD_MACET));

const ulang = await db.resetFulfillmentJob(ORD_MACET);
cek('antre ulang berhasil', ulang.success === true && ulang.alasan === 'DIANTRE_ULANG', JSON.stringify(ulang));
cek('status lama dilaporkan apa adanya', ulang.statusLama === 'MANUAL_REVIEW', ulang.statusLama);

const jobUlang = await db.getQuery("SELECT status, attempts, last_error FROM fulfillment_jobs WHERE order_id = ?", [ORD_MACET]);
cek('job kembali PENDING', jobUlang.status === 'PENDING', jobUlang.status);
cek('hitungan percobaan direset', jobUlang.attempts === 0, jobUlang.attempts);
cek('galat lama dibersihkan', jobUlang.last_error === null, String(jobUlang.last_error));

const antreanSesudah = await db.getPendingFulfillmentJobs();
cek('worker sekarang mengambilnya lagi', antreanSesudah.some(j => j.order_id === ORD_MACET));

// Pesanan lunas yang job-nya hilang sama sekali (kasus yatim) juga harus tertolong.
const ORD_YATIM = 'ORD-YATIM-UJI';
await db.runQuery("INSERT OR REPLACE INTO orders (order_id, customer_nomor, total, status, payment_status) VALUES (?, ?, 20000, 'COMPLETED', 'PAID')", [ORD_YATIM, PEMBELI_MACET]);
const yatim = await db.resetFulfillmentJob(ORD_YATIM);
cek('pesanan tanpa job dibuatkan job baru', yatim.success === true && yatim.alasan === 'JOB_BARU', JSON.stringify(yatim));
cek('order asing ditolak', (await db.resetFulfillmentJob('ORD-TIDAK-ADA')).success === false);

bagian('36. Langganan restok hanya dihapus kalau notifikasinya terkirim');
const KODE_LANGGAN = 'UJILANGGAN';
await db.addProduct(KODE_LANGGAN, 'Produk Uji Langganan', 15000, 0, 'uji', '', 'MANUAL', '', '', null, null, '30 Hari');
const PEMINTA = ['628900000001@lid', '628900000002@lid', '628900000003@lid'];
for (const j of PEMINTA) await db.runQuery("INSERT INTO subscriptions (produk_kode, customer_nomor) VALUES (?, ?)", [KODE_LANGGAN, j]);
cek('tiga peminta terdaftar', (await db.getSubscribers(KODE_LANGGAN)).length === 3);

// Hanya dua yang berhasil dikirimi.
const dihapus = await db.hapusLanggananTerkirim(KODE_LANGGAN, [PEMINTA[0], PEMINTA[1]]);
cek('dua baris terhapus', dihapus === 2, dihapus);
const sisa = await db.getSubscribers(KODE_LANGGAN);
cek('yang gagal TETAP berlangganan', sisa.length === 1 && sisa[0].customer_nomor === PEMINTA[2], JSON.stringify(sisa));
cek('daftar kosong tidak menghapus apa pun', (await db.hapusLanggananTerkirim(KODE_LANGGAN, [])) === 0);
cek('sesudahnya masih tersisa satu', (await db.getSubscribers(KODE_LANGGAN)).length === 1);

bagian('37. Pengingat keranjang dan pengingat bayar tidak lagi berebut satu kolom');
const kolomOrders = await db.allQuery("PRAGMA table_info(orders)");
cek('kolom cart_reminder_sent ada', kolomOrders.some(k => k.name === 'cart_reminder_sent'));

const PEMBELI_R = '628900000009';
await db.getOrCreateCustomer(PEMBELI_R, 'Uji Reminder');
const KODE_PENGINGAT = 'UJIREMIND';
await db.addProduct(KODE_PENGINGAT, 'Produk Uji Reminder', 25000, 9, 'uji', '', 'MANUAL', '', '', null, null, '30 Hari');
await db.addToCart(PEMBELI_R, KODE_PENGINGAT, 1);
const cartR = await db.getQuery("SELECT order_id FROM orders WHERE customer_nomor = ? AND status = 'CART'", [PEMBELI_R]);

// Keranjangnya di-nudge lebih dulu — ini yang dulu mematikan pengingat bayarnya.
await db.markCartReminderSent(cartR.order_id);
const setelahNudge = await db.getQuery("SELECT reminder_sent, cart_reminder_sent FROM orders WHERE order_id = ?", [cartR.order_id]);
cek('nudge keranjang menandai kolomnya sendiri', setelahNudge.cart_reminder_sent === 1, setelahNudge.cart_reminder_sent);
cek('penanda pengingat bayar TIDAK ikut menyala', (setelahNudge.reminder_sent || 0) === 0, setelahNudge.reminder_sent);

await db.checkoutCart(PEMBELI_R);
await db.runQuery("UPDATE orders SET waiting_since = datetime('now','-31 minutes') WHERE order_id = ?", [cartR.order_id]);
const pengingat = await db.getPendingReminders();
cek('pesanan tetap berhak atas pengingat pembayaran',
  pengingat.some(o => o.order_id === cartR.order_id), pengingat.map(o => o.order_id).join(','));

bagian('38. Premium kedaluwarsa dibaca sama oleh SEMUA fungsi');
const PREM = '628900000777@lid';
await db.getOrCreateCustomer(PREM, 'Uji Premium');
// Masa aktif berakhir SATU JAM LALU, tapi masih di tanggal kalender yang sama.
// Inilah bentuk yang dulu lolos: expires_at disimpan ISO ('...T...Z'), dan
// dibandingkan mentah sebagai teks, 'T' (0x54) selalu > ' ' (0x20) pada indeks
// ke-10, jadi untuk tanggal yang sama perbandingannya SELALU benar.
const habisSejamLalu = new Date(Date.parse(new Date().toISOString()) - 3600_000).toISOString();
await db.runQuery("INSERT OR REPLACE INTO premium_users (jid, tier, expires_at, activated_by) VALUES (?, 'Gold', ?, 'UJI')", [PREM, habisSejamLalu]);

const profilPrem = await db.getPremiumUser(PREM);
cek('getPremiumUser: sudah TIDAK aktif', !profilPrem, JSON.stringify(profilPrem));

const daftarPrem = await db.listPremiumUsers();
cek('listPremiumUsers: tidak lagi mendaftarkannya sebagai aktif',
  !daftarPrem.some(u => u.jid === PREM), JSON.stringify(daftarPrem.map(u => u.jid)));

await db.cleanExpiredPremium();
const sesudahSapu = await db.getQuery("SELECT jid FROM premium_users WHERE jid = ?", [PREM]);
cek('cleanExpiredPremium benar-benar menyapunya', !sesudahSapu, JSON.stringify(sesudahSapu));

// Yang MASIH aktif jangan ikut tersapu.
const masihSejam = new Date(Date.parse(new Date().toISOString()) + 3600_000).toISOString();
await db.runQuery("INSERT OR REPLACE INTO premium_users (jid, tier, expires_at, activated_by) VALUES (?, 'Gold', ?, 'UJI')", [PREM, masihSejam]);
await db.cleanExpiredPremium();
cek('premium yang masih hidup tidak ikut disapu', Boolean(await db.getPremiumUser(PREM)));

bagian('39. Cookie cacat tidak menjatuhkan server');
const { getCookieValue } = await import(REPO + 'src/routes/authMiddleware.js');
const reqPalsu = (nilai) => ({ headers: { cookie: `auth_token=${nilai}` } });
// decodeURIComponent melempar URIError pada urutan persen yang cacat.
cek('persen cacat -> null, bukan lemparan', getCookieValue(reqPalsu('%E0%A4%A'), 'auth_token') === null);
cek('persen tunggal -> null', getCookieValue(reqPalsu('%'), 'auth_token') === null);
cek('cookie normal tetap terbaca', getCookieValue(reqPalsu('abc123'), 'auth_token') === 'abc123');
cek('nilai ter-encode tetap ter-decode', getCookieValue(reqPalsu('a%20b'), 'auth_token') === 'a b');
cek('tanpa cookie -> null', getCookieValue({ headers: {} }, 'auth_token') === null);

bagian('40. Menempel banyak tautan penukaran sekaligus');

const { uraiBarisAddstock } = await import(REPO + 'src/handlers/stokInput.js');

const L1 = 'https://music.apple.com/redeem?ctx=Music&code=AAAA1111';
const L2 = 'https://music.apple.com/redeem?ctx=Music&code=BBBB2222';
const L3 = 'https://music.apple.com/redeem?ctx=Music&code=CCCC3333';

const kosong = uraiBarisAddstock('.addstock APPLE');
cek('kode terbaca walau tanpa kredensial', kosong.kode === 'APPLE', kosong.kode);
cek('tanpa kredensial -> daftar kosong', kosong.items.length === 0, JSON.stringify(kosong.items));

const satuBaris = uraiBarisAddstock(`.addstock apple ${L1}`);
cek('kode selalu jadi huruf besar', satuBaris.kode === 'APPLE', satuBaris.kode);
cek('satu tautan di baris perintah terbaca', satuBaris.items.length === 1 && satuBaris.items[0] === L1,
  JSON.stringify(satuBaris.items));

const multiBaris = uraiBarisAddstock(`.addstock APPLE\n${L1}\n${L2}`);
cek('tautan di baris-baris bawah terbaca semua', multiBaris.items.length === 2,
  JSON.stringify(multiBaris.items));

// INI regresinya. Bentuk campuran — tautan pertama ikut terbawa ke baris
// perintah, sisanya turun sendiri — dulu MEMBUANG tautan pertama tanpa pesan
// apa pun, dan ringkasannya tetap berbunyi "berhasil".
const campuran = uraiBarisAddstock(`.addstock APPLE ${L1}\n${L2}\n${L3}`);
cek('campuran: SEMUA tautan terbaca, tidak ada yang hilang',
  campuran.items.length === 3, `${campuran.items.length}: ${JSON.stringify(campuran.items)}`);
cek('campuran: tautan di baris perintah ikut masuk',
  campuran.items[0] === L1, campuran.items[0]);

const adaKosong = uraiBarisAddstock(`.addstock APPLE\n${L1}\n\n   \n${L2}\n`);
cek('baris kosong tidak jadi kredensial hantu', adaKosong.items.length === 2,
  JSON.stringify(adaKosong.items));

// Spasi di DALAM satu baris bukan pemisah: sandi boleh mengandung spasi.
const berspasi = uraiBarisAddstock('.addstock APPLE akun@mail.com | sandi ada spasi');
cek('spasi dalam satu baris tidak memecah kredensial',
  berspasi.items.length === 1 && berspasi.items[0] === 'akun@mail.com | sandi ada spasi',
  JSON.stringify(berspasi.items));

cek('teks kosong tidak melempar', uraiBarisAddstock('').items.length === 0);
cek('teks null tidak melempar', uraiBarisAddstock(null).kode === '');

// ── Jalur dashboard harus MELAPORKAN yang benar-benar masuk ────────────────
await db.addProduct('UJI-REDEEM', 'Uji Tautan Penukaran', 25000, 0, '', '', 'AUTO', '', '', 'Uji', null, '1 Bulan');

const impor1 = await db.addProductItems('UJI-REDEEM', [L1, L2, L3]);
cek('dashboard: addedCount = jumlah yang benar-benar masuk', impor1.addedCount === 3, String(impor1.addedCount));
cek('dashboard: readyCount ikut dipulangkan', impor1.readyCount === 3, String(impor1.readyCount));
cek('dashboard: tidak ada yang dilewati', impor1.dilewati.length === 0, JSON.stringify(impor1.dilewati));

// Tautan yang sama dengan parameter pelacak berbeda tetap voucher yang sama.
const L1Pelacak = `${L1}&utm_source=wa`;
const impor2 = await db.addProductItems('UJI-REDEEM', [L1Pelacak, 'https://music.apple.com/redeem?ctx=Music&code=DDDD4444']);
cek('dashboard: kembar dilaporkan, bukan disembunyikan', impor2.addedCount === 1 && impor2.dilewati.length === 1,
  `masuk ${impor2.addedCount}, dilewati ${impor2.dilewati.length}`);
cek('dashboard: parameter pelacak tidak membuat voucher lama jadi "baru"',
  impor2.dilewati[0]?.alasan === 'SUDAH_ADA', impor2.dilewati[0]?.alasan);

bagian('41. Pemain lama tidak disuruh mendaftar ulang');

// Reset toko mengosongkan `customers` tanpa menyentuh `game_profiles`. Gerbang
// registrasi lalu mengunci 165 profil di luar — datanya utuh, orangnya tidak
// bisa masuk. Salah satunya level 286 dengan 66.850 poin di bank.
const VETERAN = '111222333444555@lid';
const PEMULA = '555444333222111@lid';
const ASING = '999888777666555@lid';

await db.runQuery(
  "INSERT OR REPLACE INTO game_profiles (customer_jid, points, bank_points, xp, level, games_played, games_won, daily_streak) VALUES (?, 110, 7514, 0, 119, 340, 100, 0)",
  [VETERAN]
);
// Profil yang terlanjur dibuat getOrCreateGameProfile tapi belum pernah dipakai.
await db.runQuery(
  "INSERT OR REPLACE INTO game_profiles (customer_jid, points, bank_points, xp, level, games_played, games_won, daily_streak) VALUES (?, 0, 0, 0, 1, 0, 0, 0)",
  [PEMULA]
);

cek('veteran belum terdaftar sebelum dipulihkan',
  !(await db.getQuery('SELECT nomor FROM customers WHERE nomor = ?', [VETERAN])));

const pulih = await db.pulihkanMemberLama(VETERAN);
cek('veteran dipulihkan', pulih !== null, JSON.stringify(pulih));
cek('levelnya dilaporkan apa adanya', pulih?.level === 119, String(pulih?.level));
cek('poin banknya dilaporkan', pulih?.bank === 7514, String(pulih?.bank));
cek('barisnya benar-benar ada di customers',
  Boolean(await db.getQuery('SELECT nomor FROM customers WHERE nomor = ?', [VETERAN])));

const barisVeteran = await db.getQuery('SELECT * FROM customers WHERE nomor = ?', [VETERAN]);
cek('rolenya MEMBER, bukan sesuatu yang istimewa', barisVeteran.role === 'MEMBER', barisVeteran.role);
cek('profile_completed 0 — namanya masih bisa dibetulkan lewat .daftar',
  Number(barisVeteran.profile_completed) === 0, String(barisVeteran.profile_completed));

cek('profilnya TIDAK disentuh — poinnya utuh',
  (await db.getQuery('SELECT points, bank_points, level FROM game_profiles WHERE customer_jid = ?', [VETERAN])).bank_points === 7514);

cek('dipanggil dua kali tidak menggandakan apa pun', (await db.pulihkanMemberLama(VETERAN)) === null);

// Profil kosong bukan bukti keanggotaan.
cek('profil yang belum pernah dipakai TIDAK diloloskan', (await db.pulihkanMemberLama(PEMULA)) === null);
cek('dan tidak dibuatkan baris customers',
  !(await db.getQuery('SELECT nomor FROM customers WHERE nomor = ?', [PEMULA])));

// Orang yang memang belum pernah menyentuh bot tetap harus mendaftar.
cek('yang sama sekali tanpa profil game ditolak', (await db.pulihkanMemberLama(ASING)) === null);
cek('nomor kosong tidak melempar', (await db.pulihkanMemberLama('')) === null);
cek('null tidak melempar', (await db.pulihkanMemberLama(null)) === null);

// `.daftar` sesudahnya harus tetap bisa membetulkan namanya.
await db.registerCustomer(VETERAN, 'Nama Asli');
const sesudahDaftar = await db.getQuery('SELECT nama, profile_completed FROM customers WHERE nomor = ?', [VETERAN]);
cek('.daftar tetap bisa membetulkan nama "Pemain Lama"', sesudahDaftar.nama === 'Nama Asli', sesudahDaftar.nama);
cek('dan menandainya sebagai lengkap', Number(sesudahDaftar.profile_completed) === 1);
cek('poin gamenya TETAP utuh sesudah .daftar',
  (await db.getQuery('SELECT bank_points FROM game_profiles WHERE customer_jid = ?', [VETERAN])).bank_points === 7514);

console.log(`\n${'='.repeat(50)}`);
console.log(`HASIL: ${lulus} lulus, ${gagal} gagal`);
console.log('='.repeat(50));

try {
  fs.rmSync(kotakPasir, { recursive: true, force: true });
} catch {
  // Berkas database kadang masih terkunci di Windows; biarkan OS yang menyapu.
}

process.exit(gagal > 0 ? 1 : 0);
