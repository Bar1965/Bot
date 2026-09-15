/**
 * UJI ASAP TESTIMONI & BUKTI TRANSAKSI
 *
 * Dua hal yang sengaja DIPISAH, dan uji ini menjaga pemisahannya:
 *
 *   BUKTI TRANSAKSI — catatan penjualan otomatis. Bot yang menulis, isinya
 *                     fakta, nomor pembeli disamarkan.
 *   TESTIMONI       — bintang dan kalimat pembeli sendiri. HANYA ada kalau
 *                     orangnya betul-betul membalas.
 *
 * Yang paling dijaga: tidak ada satu pun jalur yang bisa memasukkan ulasan
 * tanpa pembeli mengetiknya, dan angka "1" saat pelanggan sedang membuka
 * katalog tidak boleh diam-diam jadi rating bintang satu.
 *
 * Pakai:
 *   node scripts/testimoniSmokeTest.mjs
 *
 * KEAMANAN: skrip pindah ke direktori sementara SEBELUM memuat lapisan
 * database, karena `connection.js` membuka './shop.db' relatif terhadap
 * direktori kerja.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';

const AKAR = path.resolve(import.meta.dirname, '..');
const REPO = pathToFileURL(AKAR).href + '/';

const kotakPasir = fs.mkdtempSync(path.join(os.tmpdir(), 'testi-uji-'));
process.chdir(kotakPasir);
console.log(`Kotak pasir: ${kotakPasir}`);

process.env.JWT_SECRET ||= 'uji-asap-bukan-rahasia-sungguhan';
process.env.ADMIN_USER ||= 'ujiasap';
process.env.ADMIN_PASSWORD_HASH ||= '$2b$10$0000000000000000000000000000000000000000000000000000';

const db = await import(REPO + 'database.js');
const t = await import(REPO + 'src/handlers/testimoni.js');
const { createCustomerHandler } = await import(REPO + 'src/handlers/customerHandler.js');

await db.openDb();
await db.initDb();

let lulus = 0;
let gagal = 0;

function cek(nama, kondisi, detail = '') {
  if (kondisi) { lulus++; console.log(`  OK    ${nama}`); }
  else { gagal++; console.log(`  GAGAL ${nama}${detail !== '' ? ' -> ' + detail : ''}`); }
}
const bagian = (j) => console.log(`\n== ${j} ==`);

const terkirim = [];
const sock = {
  sendMessage: async (tujuan, isi) => { terkirim.push({ tujuan, teks: isi.text || isi.caption || '' }); return { key: { id: 'uji' } }; }
};
const handleCustomerMessage = createCustomerHandler({
  sock,
  botSettings: { ownerJid: '628900000000@s.whatsapp.net' },
  sendInteractiveButtons: async (s, tujuan, opsi) => { terkirim.push({ tujuan, teks: opsi?.text || '' }); }
});
const teksTerakhir = () => (terkirim.length ? terkirim[terkirim.length - 1].teks : '');

const PEMBELI = '628777000001@s.whatsapp.net';
const GRUP = '120363000000000000@g.us';

const ketik = async (teks, pengirim = PEMBELI, dariGrup = false, jid = null) => {
  terkirim.length = 0;
  await handleCustomerMessage(jid || (dariGrup ? GRUP : pengirim), pengirim,
    { message: { conversation: teks }, pushName: 'Pembeli Uji' }, teks, dariGrup,
    { isAdmin: false, isOwner: false, isStoreAdmin: false });
  return teksTerakhir();
};

// ============================================================
bagian('1. bintang & samarkanNomor');

cek('5 bintang penuh', t.bintang(5) === '⭐⭐⭐⭐⭐');
cek('3 bintang + 2 redup', t.bintang(3) === '⭐⭐⭐☆☆');
cek('nilai di luar jangkauan dijepit', t.bintang(99) === '⭐⭐⭐⭐⭐' && t.bintang(-1) === '☆☆☆☆☆');
cek('bukan angka jadi kosong', t.bintang('abc') === '☆☆☆☆☆');

cek('nomor disamarkan di tengah', t.samarkanNomor('6287712345678@s.whatsapp.net') === '628••••5678',
  t.samarkanNomor('6287712345678@s.whatsapp.net'));
cek('nomor asli tidak bocor utuh', !t.samarkanNomor('6287712345678@s.whatsapp.net').includes('7712345'));
cek('@lid tidak dipakai sebagai nomor', !/\d{4}/.test(t.samarkanNomor('59837887057934@lid')),
  t.samarkanNomor('59837887057934@lid'));
cek('kosong tetap aman', t.samarkanNomor('') === 'Pelanggan');
cek('angka terlalu pendek tidak dipajang', t.samarkanNomor('123@s.whatsapp.net') === 'Pelanggan');

// ============================================================
bagian('2. uraiBalasanUlasan — hanya 1-5 yang diterima');

cek('angka saja', t.uraiBalasanUlasan('5')?.rating === 5);
cek('angka + komentar', t.uraiBalasanUlasan('4 lumayan cepat')?.komentar === 'lumayan cepat');
cek('pakai titik pemisah', t.uraiBalasanUlasan('3. biasa aja')?.komentar === 'biasa aja');
cek('spasi berlebih dibersihkan', t.uraiBalasanUlasan('  5   mantap  ')?.rating === 5);
cek('0 ditolak', t.uraiBalasanUlasan('0') === null);
cek('6 ditolak', t.uraiBalasanUlasan('6') === null);
cek('angka dua digit ditolak', t.uraiBalasanUlasan('12') === null);
cek('kalimat biasa ditolak', t.uraiBalasanUlasan('halo kak') === null);
cek('kosong ditolak', t.uraiBalasanUlasan('') === null);
cek('komentar sangat panjang dipotong', (t.uraiBalasanUlasan('5 ' + 'a'.repeat(900))?.komentar || '').length <= 300);

// ============================================================
bagian('3. Bukti transaksi — fakta, bukan karangan');

const bukti = t.susunBuktiTransaksi({
  namaProduk: 'Apple Music 6 Bulan', jid: '6287712345678@s.whatsapp.net', otomatis: true, jam: '17:42'
});
cek('menyebut produknya', bukti.includes('Apple Music 6 Bulan'));
cek('nomor disamarkan', bukti.includes('628••••5678'));
cek('menyebut jamnya', bukti.includes('17:42'));
cek('menyebut pengiriman otomatis', bukti.includes('otomatis'));
cek('TIDAK mengarang bintang', !bukti.includes('⭐'), bukti);
cek('TIDAK mengarang komentar pembeli', !/"/.test(bukti), bukti);

const buktiManual = t.susunBuktiTransaksi({ namaProduk: 'X', jid: PEMBELI, otomatis: false });
cek('produk manual disebut apa adanya', buktiManual.includes('manual'));
const buktiBanyak = t.susunBuktiTransaksi({ namaProduk: 'X', jid: PEMBELI, jumlah: 3 });
cek('jumlah lebih dari satu ditulis', buktiBanyak.includes('×3'), buktiBanyak);

// ============================================================
bagian('4. Layar testimoni kosong tidak mengarang contoh');

const kosong = t.susunDaftarTestimoni([], {});
cek('mengaku belum ada ulasan', kosong.includes('Belum ada ulasan'));
cek('tidak menampilkan bintang palsu', !kosong.includes('⭐'), kosong);

// ============================================================
bagian('5. Alur nyata: pesanan terkirim -> pembeli membalas bintang');

await db.addProduct('UJI-TES', 'Produk Testi', 25000, 0, 'Deskripsi.', '', 'MANUAL', '', '', 'Testi Brand', 'Premium', '1 Bulan');
await db.addProductItemsBatch('UJI-TES', ['akun-testi@mail.com|sandi']);
await db.getOrCreateCustomer(PEMBELI, 'Pembeli Uji');
await db.runQuery("UPDATE customers SET profile_completed = 1 WHERE nomor = ?", [PEMBELI]);

const ORDER = 'ORD-UJI-TESTI-1';
await db.runQuery(
  "INSERT INTO orders (order_id, customer_nomor, total, status, fulfillment_status, created_at) VALUES (?, ?, ?, 'COMPLETED', 'DELIVERED', datetime('now'))",
  [ORDER, PEMBELI, 25000]
);
await db.runQuery(
  "INSERT INTO order_items (order_id, produk_kode, qty, harga, subtotal) VALUES (?, 'UJI-TES', 1, 25000, 25000)",
  [ORDER]
);

const menunggu = await db.getPesananMenungguUlasan(PEMBELI);
cek('pesanan terkirim terdeteksi menunggu ulasan', menunggu?.order_id === ORDER, String(menunggu?.order_id));
cek('produknya ikut terbawa', menunggu?.produk_kode === 'UJI-TES', String(menunggu?.produk_kode));

const balasan = await ketik('5 cepet banget, akunnya langsung jalan');
cek('balasan bintang dijawab', balasan.length > 0, balasan.slice(0, 60));
cek('ucapan terima kasih memuat bintang', balasan.includes('⭐⭐⭐⭐⭐'), balasan.slice(0, 80));
cek('komentarnya dikutip balik', balasan.includes('cepet banget'), balasan.slice(0, 120));

const tersimpan = await db.getReviewByOrder(ORDER);
cek('ulasan tersimpan di database', Boolean(tersimpan));
cek('ratingnya benar', tersimpan?.rating === 5, String(tersimpan?.rating));
cek('komentarnya utuh', String(tersimpan?.comment).includes('akunnya langsung jalan'), tersimpan?.comment);
cek('kode produk ikut tersimpan', tersimpan?.produk_kode === 'UJI-TES', String(tersimpan?.produk_kode));

// Satu pesanan hanya boleh diulas sekali.
const lagi = await db.getPesananMenungguUlasan(PEMBELI);
cek('pesanan yang sudah diulas tidak ditanya lagi', lagi === null, String(lagi?.order_id));

// ============================================================
bagian('6. Ulasan hanya lahir dari balasan pembeli');

const ringkas1 = await db.getRingkasanTestimoni();
cek('baru ada satu ulasan', ringkas1.jumlah === 1, String(ringkas1.jumlah));

// Pengiriman berikutnya TIDAK boleh menambah ulasan dengan sendirinya.
const ORDER2 = 'ORD-UJI-TESTI-2';
await db.runQuery(
  "INSERT INTO orders (order_id, customer_nomor, total, status, fulfillment_status, created_at) VALUES (?, ?, ?, 'COMPLETED', 'DELIVERED', datetime('now'))",
  [ORDER2, PEMBELI, 25000]
);
await db.runQuery("INSERT INTO order_items (order_id, produk_kode, qty, harga, subtotal) VALUES (?, 'UJI-TES', 1, 25000, 25000)", [ORDER2]);
const ringkas2 = await db.getRingkasanTestimoni();
cek('pesanan baru tidak menambah ulasan sendiri', ringkas2.jumlah === 1, String(ringkas2.jumlah));

// ============================================================
bagian('7. Angka di katalog TIDAK boleh jadi rating');

// Pembeli punya ORDER2 yang menunggu ulasan. Begitu ia membuka katalog,
// angka yang diketik harus berarti nomor produk, bukan bintang.
await ketik('.list');
const setelahAngka = await ketik('1');
cek('angka sesudah .list membuka produk, bukan menyimpan rating',
  !setelahAngka.includes('Makasih ulasannya'), setelahAngka.slice(0, 80));
const masihMenunggu = await db.getPesananMenungguUlasan(PEMBELI);
cek('pesanan kedua masih menunggu ulasan', masihMenunggu?.order_id === ORDER2, String(masihMenunggu?.order_id));
const ringkas3 = await db.getRingkasanTestimoni();
cek('tidak ada ulasan siluman yang tercatat', ringkas3.jumlah === 1, String(ringkas3.jumlah));

// ============================================================
bagian('8. Angka di GRUP tidak pernah jadi rating');

const diGrup = await ketik('5', PEMBELI, true);
cek('angka telanjang di grup diabaikan', diGrup === '' || !diGrup.includes('Makasih ulasannya'), diGrup.slice(0, 60));
cek('ulasan tetap satu', (await db.getRingkasanTestimoni()).jumlah === 1);

// ============================================================
bagian('9. Layar .testi menampilkan ulasan asli');

const layarTesti = await ketik('.testi');
cek('.testi dijawab', layarTesti.length > 0);
cek('menampilkan bintangnya', layarTesti.includes('⭐⭐⭐⭐⭐'), layarTesti.slice(0, 120));
cek('menampilkan komentar pembeli', layarTesti.includes('cepet banget'), layarTesti.slice(0, 200));
cek('menampilkan nama produk', layarTesti.includes('Produk Testi'), layarTesti.slice(0, 200));
cek('menampilkan rata-rata', /5\.0\/5/.test(layarTesti), layarTesti.slice(0, 120));

// ============================================================
bagian('10. Rating muncul di halaman produk');

const peta = await db.getRatingProduk(['UJI-TES']);
cek('rating per produk terbaca', peta.get('UJI-TES')?.jumlah === 1, JSON.stringify([...peta]));
cek('rata-ratanya benar', peta.get('UJI-TES')?.rataRata === 5);

const baris = t.barisRating(5, 1);
cek('baris rating menyebut bintang & jumlah', baris.includes('⭐') && baris.includes('1 ulasan'), baris);
cek('produk tanpa ulasan tidak menampilkan 0.0', t.barisRating(0, 0) === '', t.barisRating(0, 0));

// Nomornya dicari dari teks katalog yang baru tampil — urutan katalog
// ditentukan data, dan sandbox ini juga berisi produk contoh bawaan initDb.
const katalog = await ketik('.list');
const barisNomor = katalog.split('\n').filter(b => /^\*\d+\.\*/.test(b.trim()));
const idxTesti = barisNomor.findIndex(b => /testi brand/i.test(b));
cek('merek Testi Brand ada di katalog', idxTesti >= 0, barisNomor.join(' | ').slice(0, 160));
const halaman = await ketik(String(idxTesti + 1));
cek('halaman produk yang dibuka benar', halaman.includes('TESTI BRAND'), halaman.slice(0, 60));
cek('halaman produk memuat baris rating', halaman.includes('/5'), halaman.slice(0, 160));
cek('baris rating ada di dua baris teratas',
  halaman.split('\n').slice(0, 2).join(' ').includes('/5'), halaman.split('\n').slice(0, 2).join(' | '));

// ============================================================
bagian('11. Ulasan bertahan walau pesanannya dibersihkan');

await db.runQuery('DELETE FROM order_items WHERE order_id = ?', [ORDER]);
await db.runQuery('DELETE FROM orders WHERE order_id = ?', [ORDER]);

const setelahHapus = await db.getTestimoniTerbaru(10);
cek('ulasan tidak ikut hilang', setelahHapus.length === 1, String(setelahHapus.length));
cek('nama produknya masih terbaca', setelahHapus[0]?.nama_produk === 'Produk Testi', String(setelahHapus[0]?.nama_produk));

// ============================================================
bagian('12. addReview menjepit nilai yang tidak masuk akal');

await db.addReview('ORD-UJI-JEPIT', PEMBELI, 99, 'nilai ngawur', 'UJI-TES');
const jepit = await db.getReviewByOrder('ORD-UJI-JEPIT');
cek('rating di atas 5 dijepit jadi 5', jepit?.rating === 5, String(jepit?.rating));
await db.addReview('ORD-UJI-JEPIT2', PEMBELI, -3, '', 'UJI-TES');
cek('rating negatif dijepit jadi 1', (await db.getReviewByOrder('ORD-UJI-JEPIT2'))?.rating === 1);

// ============================================================
console.log('\n════════════════════════════════════════');
console.log(`Pemeriksaan : ${lulus + gagal}`);
console.log(`Lulus       : ${lulus}`);
console.log(`Gagal       : ${gagal}`);
console.log('════════════════════════════════════════');

try { fs.rmSync(kotakPasir, { recursive: true, force: true }); } catch {}
process.exit(gagal ? 1 : 0);
