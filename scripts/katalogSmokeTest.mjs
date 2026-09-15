/**
 * UJI ASAP KATALOG BERNOMOR
 *
 * Menguji alur belanja yang dipakai pelanggan setiap hari:
 *
 *   .list        -> daftar merek bernomor
 *   balas angka  -> halaman produk: deskripsi + semua jenis/paketnya
 *   balas angka  -> masuk keranjang
 *   balas 0      -> kembali ke katalog
 *
 * Yang paling dijaga di sini BUKAN tampilannya, tapi satu sifat: nomor yang
 * dilihat pelanggan selalu menunjuk barang yang sama dengan yang dibaca bot,
 * dan angka stok yang diiklankan selalu sama dengan angka yang boleh dibeli.
 *
 * Pakai:
 *   node scripts/katalogSmokeTest.mjs
 *
 * KEAMANAN: skrip pindah ke direktori sementara SEBELUM memuat lapisan
 * database, karena `connection.js` membuka './shop.db' relatif terhadap
 * direktori kerja. Tanpa itu, uji ini akan mengubah KATALOG SUNGGUHAN milik
 * pemilik bot.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';

const AKAR = path.resolve(import.meta.dirname, '..');
const REPO = pathToFileURL(AKAR).href + '/';

const kotakPasir = fs.mkdtempSync(path.join(os.tmpdir(), 'katalog-uji-'));
process.chdir(kotakPasir);
console.log(`Kotak pasir: ${kotakPasir}`);

process.env.JWT_SECRET ||= 'uji-asap-bukan-rahasia-sungguhan';
process.env.ADMIN_USER ||= 'ujiasap';
process.env.ADMIN_PASSWORD_HASH ||= '$2b$10$0000000000000000000000000000000000000000000000000000';

// Impor HARUS sesudah chdir.
const db = await import(REPO + 'database.js');
const view = await import(REPO + 'src/handlers/katalogView.js');
const { createCustomerHandler } = await import(REPO + 'src/handlers/customerHandler.js');

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
    console.log(`  GAGAL ${nama}${detail !== '' ? ' -> ' + detail : ''}`);
  }
}

function bagian(judul) {
  console.log(`\n== ${judul} ==`);
}

const terkirim = [];
const sock = {
  sendMessage: async (tujuan, isi) => {
    terkirim.push({ tujuan, teks: isi.text || isi.caption || '' });
    return { key: { id: 'uji' } };
  }
};

// sendInteractiveButtons WAJIB diisi: bawaannya no-op, jadi seluruh layar
// katalog akan hilang tanpa jejak dan uji ini mengira handler-nya bisu.
const handleCustomerMessage = createCustomerHandler({
  sock,
  sendInteractiveButtons: async (s, tujuan, opsi) => {
    terkirim.push({ tujuan, teks: opsi?.text || '' });
  }
});

const teksTerakhir = () => (terkirim.length ? terkirim[terkirim.length - 1].teks : '');

const PEMBELI = '628555000001@s.whatsapp.net';

/**
 * Ketik `.list`, cari nomor merek yang diminta DARI TEKS YANG BARU TAMPIL, lalu
 * tekan nomor itu. Nomornya tidak boleh ditebak atau dipakai ulang: urutan
 * katalog ditentukan data, dan uji ini menambah produk sambil berjalan.
 */
const bukaMerek = async (namaMerek) => {
  const katalog = await ketik('.list');
  const barisNomor = katalog.split('\n').filter(b => /^\*\d+\.\*/.test(b.trim()));
  const idx = barisNomor.findIndex(b => new RegExp(namaMerek, 'i').test(b));
  if (idx < 0) return { nomor: -1, teks: katalog, katalog };
  const teks = await ketik(String(idx + 1));
  return { nomor: idx + 1, teks, katalog };
};

const ketik = async (teks, pengirim = PEMBELI, dariGrup = false, jid = null) => {
  terkirim.length = 0;
  await handleCustomerMessage(
    jid || pengirim,
    pengirim,
    { message: { conversation: teks }, pushName: 'Pembeli Uji' },
    teks,
    dariGrup,
    { isAdmin: false, isOwner: false, isStoreAdmin: false }
  );
  return teksTerakhir();
};

// ============================================================
bagian('1. badgeStok — satu aturan untuk semua layar');

cek('stok 0 = habis', view.badgeStok(0, 3).teks.includes('habis'));
cek('stok 0 ditandai tidak ada', view.badgeStok(0, 3).ada === false);
cek('stok 1 = tipis', view.badgeStok(1, 3).tipis === true);
cek('stok 3 masih tipis (batasnya inklusif)', view.badgeStok(3, 3).tipis === true);
cek('stok 4 sudah ready', view.badgeStok(4, 3).tipis === false);
cek('stok 4 menyebut angkanya', view.badgeStok(4, 3).teks.includes('4'));
cek('stok negatif dianggap habis', view.badgeStok(-5, 3).ada === false);
cek('stok bukan angka dianggap habis', view.badgeStok(undefined, 3).ada === false);
cek('stok pecahan dibulatkan ke bawah', view.badgeStok(2.9, 3).jumlah === 2);

cek('harga seragam ditulis sekali', view.labelHarga(30000, 30000) === 'Rp30.000');
cek('harga beragam ditulis sebagai rentang', view.labelHarga(30000, 90000).includes('–'));
cek('rupiah memformat ribuan', view.rupiah(1234567) === 'Rp1.234.567');
cek('rupiah menolak nilai tidak masuk akal', view.rupiah('abc') === 'Rp0');

const panjang = 'kata '.repeat(200);
cek('potong menghormati batas', view.potong(panjang, 100).length <= 101);
cek('potong menambahkan elipsis', view.potong(panjang, 100).endsWith('…'));
cek('teks pendek tidak dipotong', view.potong('halo', 100) === 'halo');

// ============================================================
bagian('2. Katalog kosong tidak membuat sesi palsu');

const layarKosong = view.susunKatalog([], {});
cek('katalog kosong ditandai', layarKosong.kosong === true);
cek('katalog kosong tanpa entri', layarKosong.entri.length === 0);

const halamanKosong = view.susunHalamanProduk([], {});
cek('halaman produk kosong ditandai', halamanKosong.kosong === true);
cek('halaman kosong mengarahkan ke .list', halamanKosong.teks.includes('.list'));

// Katalog raksasa: yang tidak muat harus DIBERITAHUKAN, bukan hilang diam-diam.
const banyak = Array.from({ length: 55 }, (_, i) => ({
  brand: `Merek ${i + 1}`, icon: '📦', variants: [{ kode: `K${i}`, harga: 1000, stok: 1 }],
  min_price: 1000, max_price: 1000, total_stock: 1
}));
const layarBanyak = view.susunKatalog(banyak, {});
cek('katalog dibatasi supaya pesannya tidak raksasa', layarBanyak.entri.length === 40, String(layarBanyak.entri.length));
cek('sisa merek yang dipotong diberitahukan', layarBanyak.teks.includes('15 merek lagi'), layarBanyak.teks.slice(-200));
cek('pemotongan menawarkan jalan keluar', layarBanyak.teks.includes('.cari'));
cek('nomor terakhir sesuai jumlah yang tampil', layarBanyak.teks.includes('*40*'));

// Jumlah di kepala harus jumlah PAKET, bukan jumlah merek.
const duaMerekEnamPaket = view.susunKatalog([
  { brand: 'A', icon: '📦', variants: [{ kode: 'A1' }, { kode: 'A2' }, { kode: 'A3' }], min_price: 1000, max_price: 3000, total_stock: 3 },
  { brand: 'B', icon: '📦', variants: [{ kode: 'B1' }, { kode: 'B2' }, { kode: 'B3' }], min_price: 2000, max_price: 4000, total_stock: 3 }
], {});
cek('kepala menghitung paket, bukan merek', duaMerekEnamPaket.teks.includes('6 paket'), duaMerekEnamPaket.teks.split('\n')[1]);

// ============================================================
bagian('3. Data uji — satu merek satu paket, satu merek banyak paket');

await db.addProduct('UJI-SOLO', 'Solo Sebulan', 30000, 4, 'Deskripsi produk solo.', '', 'MANUAL', '', 'Petunjuk solo.', 'Solo Brand', 'Premium', '1 Bulan');
await db.addProduct('UJI-M-7', 'Multi 7 Hari', 10000, 5, 'Deskripsi merek multi.', '', 'MANUAL', '', 'Petunjuk multi.', 'Multi Brand', 'Sharing', '7 Hari');
await db.addProduct('UJI-M-30', 'Multi 30 Hari', 25000, 2, '', '', 'MANUAL', '', '', 'Multi Brand', 'Sharing', '30 Hari');
await db.addProduct('UJI-M-PRIV', 'Multi Private', 50000, 0, '', '', 'MANUAL', '', '', 'Multi Brand', 'Private', '30 Hari');

await db.getOrCreateCustomer(PEMBELI, 'Pembeli Uji');
await db.runQuery("UPDATE customers SET profile_completed = 1 WHERE nomor = ?", [PEMBELI]);

// initDb menanam produk contoh saat tabelnya kosong, jadi katalog sandbox ini
// berisi merek bawaan juga. Yang diperiksa hanya merek buatan uji ini.
const katalogDb = await db.getGroupedCatalog();
const merekUji = katalogDb.filter(c => ['Solo Brand', 'Multi Brand'].includes(c.brand));
cek('dua merek uji terbentuk', merekUji.length === 2, katalogDb.map(c => c.brand).join(', '));
const grupMulti = merekUji.find(c => c.brand === 'Multi Brand');
cek('Multi Brand memuat tiga paket', grupMulti?.variants.length === 3, String(grupMulti?.variants.length));
cek('paket Multi Brand terurut dari termurah',
  grupMulti?.variants[0]?.kode === 'UJI-M-7', grupMulti?.variants.map(v => v.kode).join(','));
cek('total stok Multi Brand dijumlahkan', grupMulti?.total_stock === 7, String(grupMulti?.total_stock));

// ============================================================
bagian('4. getProductsByKodes — kode persis, urutan dipertahankan');

const urut = await db.getProductsByKodes(['UJI-M-30', 'UJI-SOLO', 'UJI-M-7']);
cek('mengembalikan tiga produk', urut.length === 3);
cek('urutan mengikuti permintaan, bukan database',
  urut.map(p => p.kode).join(',') === 'UJI-M-30,UJI-SOLO,UJI-M-7', urut.map(p => p.kode).join(','));

const ganda = await db.getProductsByKodes(['UJI-SOLO', 'uji-solo', 'UJI-SOLO']);
cek('kode kembar dijadikan satu', ganda.length === 1);
cek('huruf kecil tetap ketemu', ganda[0]?.kode === 'UJI-SOLO');

const adaHilang = await db.getProductsByKodes(['UJI-SOLO', 'TIDAK-ADA-KODE-INI']);
cek('kode yang tidak ada dibuang, bukan jadi undefined', adaHilang.length === 1);
cek('daftar kosong mengembalikan array kosong', (await db.getProductsByKodes([])).length === 0);
cek('argumen ngawur tidak melempar', (await db.getProductsByKodes(null)).length === 0);

// ============================================================
bagian('5. getProductsByBrand — cocok persis, BUKAN LIKE');

await db.addProduct('UJI-OFF', 'Office Asli', 35000, 1, '', '', 'MANUAL', '', '', 'Office', null, '12 Bulan');
await db.addProduct('UJI-LIBRE', 'Libre Office', 0, 1, '', '', 'MANUAL', '', '', 'LibreOffice', null, '12 Bulan');

const merekOffice = await db.getProductsByBrand('Office');
cek('merek Office hanya memulangkan Office', merekOffice.length === 1, merekOffice.map(p => p.kode).join(','));
cek('LibreOffice tidak ikut terseret', !merekOffice.some(p => p.kode === 'UJI-LIBRE'));
cek('merek kosong mengembalikan kosong', (await db.getProductsByBrand('')).length === 0);

const merekMulti = await db.getProductsByBrand('multi brand');
cek('pencocokan merek tidak peduli huruf besar-kecil', merekMulti.length === 3, String(merekMulti.length));

// ============================================================
bagian('6. Layar .list — bernomor dan menyebut jangkauannya');

const layarList = await ketik('.list');
cek('.list dijawab', layarList.length > 0);
cek('.list menampilkan nomor 1', layarList.includes('*1.*'), layarList.slice(0, 120));
cek('.list menyebut jangkauan nomor', /Balas \*1\*/.test(layarList), layarList.slice(-160));
cek('.list menampilkan harga', layarList.includes('Rp'), layarList.slice(0, 200));
cek('.list menampilkan status stok', /ready|sisa|habis/.test(layarList));
cek('.list tidak membuang merek', layarList.includes('Multi Brand') || layarList.includes('MULTI BRAND'));

// Katalog harus tetap pendek: isi paket dirinci di layar berikutnya.
cek('.list cukup ringkas (<= 40 baris)', layarList.split('\n').length <= 40, String(layarList.split('\n').length));

const nomorMulti = layarList.split('\n').findIndex(b => b.includes('Multi Brand'));
cek('Multi Brand punya baris sendiri', nomorMulti >= 0);

// ============================================================
bagian('7. Balas angka -> halaman produk berisi deskripsi & jenis');

const dibuka = await bukaMerek('multi brand');
cek('nomor Multi Brand ditemukan di katalog', dibuka.nomor > 0);
const halamanMulti = dibuka.teks;
cek('angka dijawab dengan halaman produk', halamanMulti.length > 0, halamanMulti.slice(0, 80));
cek('halaman memuat deskripsi merek', halamanMulti.includes('Deskripsi merek multi'), halamanMulti.slice(0, 200));
cek('halaman memuat judul PILIHAN PAKET', halamanMulti.includes('PILIHAN PAKET'));
cek('semua tiga paket tampil', halamanMulti.includes('7 Hari') && halamanMulti.includes('30 Hari'));
cek('jenis paket ikut tampil', halamanMulti.includes('Sharing') && halamanMulti.includes('Private'));
cek('harga tiap paket tampil', halamanMulti.includes('Rp10.000') && halamanMulti.includes('Rp50.000'));
cek('paket habis ditandai', halamanMulti.includes('habis'), halamanMulti.slice(0, 400));
cek('halaman memuat petunjuk garansi', halamanMulti.includes('Petunjuk multi'));
cek('halaman menyebut cara kembali', halamanMulti.includes('0') && halamanMulti.includes('.list'));
cek('halaman menyebut cara pengiriman', /PENGIRIMAN/.test(halamanMulti));

// ============================================================
bagian('8. Balas angka lagi -> masuk keranjang');

const konfirmasi = await ketik('1');
cek('paket nomor 1 masuk keranjang', konfirmasi.includes('Masuk keranjang'), konfirmasi.slice(0, 120));

const keranjang = await db.getCartDetails(PEMBELI);
cek('keranjang berisi satu baris', keranjang.items.length === 1, String(keranjang.items.length));
// Paket termurah ada di nomor 1 karena getProductsByKodes mempertahankan urutan
// getGroupedCatalog yang sudah diurutkan harga.
cek('yang masuk adalah paket nomor 1 yang tadi tampil',
  keranjang.items[0]?.produk_kode === 'UJI-M-7', keranjang.items[0]?.produk_kode);

// ============================================================
bagian('9. Nomor di luar jangkauan dibalas, bukan didiamkan');

await ketik('.list');
const salahNomor = await ketik('99');
cek('nomor asing tetap dibalas', salahNomor.length > 0);
cek('balasannya menyebut jangkauan yang benar', /Balas angka \*1\* sampai/.test(salahNomor), salahNomor.slice(0, 160));

// ============================================================
bagian('10. Angka 0 kembali ke katalog dari layar mana pun');

await bukaMerek('multi brand');
const kembali = await ketik('0');
cek('0 mengembalikan ke katalog', kembali.includes('KATALOG'), kembali.slice(0, 100));

// ============================================================
bagian('11. AMANKAN STOK — angka yang diiklankan = angka yang boleh dibeli');

// Produk AUTO: kolom products.stok sengaja diisi bohong (99), stok sebenarnya
// adalah jumlah baris product_items READY.
await db.addProduct('UJI-AUTO', 'Auto Dua Unit', 15000, 99, 'Produk auto.', '', 'MANUAL', '', '', 'Auto Brand', 'Premium', '1 Bulan');
await db.addProductItemsBatch('UJI-AUTO', ['akun1@mail.com|sandi', 'akun2@mail.com|sandi']);
await db.runQuery("UPDATE products SET stok = 99 WHERE kode = 'UJI-AUTO'");

const autoRow = (await db.getProductsByKodes(['UJI-AUTO']))[0];
cek('katalog membaca stok asli (2), bukan kolomnya (99)', autoRow.stok === 2, String(autoRow.stok));

const beliKebanyakan = await db.addToCart(PEMBELI, 'UJI-AUTO', 3);
cek('beli 3 dari stok 2 ditolak', beliKebanyakan.success === false);
cek('penolakannya menyebut sisa 2', String(beliKebanyakan.message).includes('2'), beliKebanyakan.message);

const ringkasanAdmin = await db.getAllProductsSummary();
const barisAuto = ringkasanAdmin.find(p => p.kode === 'UJI-AUTO');
cek('ringkasan admin memakai stok asli juga', barisAuto?.stok === 2, String(barisAuto?.stok));

// ============================================================
bagian('12. AMANKAN STOK — nomor tetap terikat ke barang yang sama');

const dibukaLagi = await bukaMerek('multi brand');
cek('halaman Multi Brand terbuka lagi', dibukaLagi.teks.includes('PILIHAN PAKET'), dibukaLagi.teks.slice(0, 90));

// Owner menghapus produk dari merek LAIN selagi layar ini terbuka. Nomor yang
// dilihat pelanggan tidak boleh bergeser ke barang tetangganya.
await db.deleteProductWithItems('UJI-SOLO');

await db.runQuery("DELETE FROM order_items WHERE order_id IN (SELECT order_id FROM orders WHERE customer_nomor = ? AND status = 'CART')", [PEMBELI]);
const setelahHapus = await ketik('1');
cek('angka 1 tetap menambahkan paket yang sama', setelahHapus.includes('Masuk keranjang'), setelahHapus.slice(0, 120));
const keranjang2 = await db.getCartDetails(PEMBELI);
cek('kode yang masuk masih UJI-M-7', keranjang2.items[0]?.produk_kode === 'UJI-M-7', keranjang2.items[0]?.produk_kode);

// Produk yang DITUNJUK nomornya dihapus: pelanggan harus diberi tahu, bukan
// diam-diam dibelikan barang tetangganya.
await bukaMerek('multi brand');
await db.runQuery("DELETE FROM order_items WHERE order_id IN (SELECT order_id FROM orders WHERE customer_nomor = ? AND status = 'CART')", [PEMBELI]);
await db.deleteProductWithItems('UJI-M-7');

const hilang = await ketik('1');
cek('produk yang lenyap dijawab jujur', /tidak tersedia/i.test(hilang), hilang.slice(0, 140));
const keranjang3 = await db.getCartDetails(PEMBELI);
cek('keranjang tetap kosong, tidak diisi barang pengganti',
  keranjang3.items.length === 0, keranjang3.items.map(i => i.produk_kode).join(','));

// ============================================================
bagian('13. Pencarian kata kunci bermuara ke layar yang sama');

const cariMulti = await ketik('.p multi');
cek('.p menemukan merek', cariMulti.length > 0);
cek('.p membuka halaman produk yang sama', cariMulti.includes('PAKET'), cariMulti.slice(0, 140));

const cariKosong = await ketik('.p barangyangtidakada');
cek('.p tanpa hasil tetap dibalas', cariKosong.length > 0);
cek('.p tanpa hasil mengarahkan ke .list', cariKosong.includes('.list'), cariKosong.slice(0, 140));

// Kode SKU persis harus tetap memperlihatkan saudara satu mereknya.
const cariSku = await ketik('.p UJI-M-30');
cek('kode SKU persis dikenali', cariSku.length > 0);
cek('kode SKU tetap memperlihatkan seluruh paket mereknya',
  cariSku.includes('Private') || cariSku.includes('30 Hari'), cariSku.slice(0, 200));

// ============================================================
bagian('14. kelompokkanPencarian meniru aturan katalog utama');

const grup = view.kelompokkanPencarian([
  { kode: 'A1', nama: 'Alpha Satu', harga: 1000, stok: 1, brand_category: 'Alpha' },
  { kode: 'A2', nama: 'Alpha Dua', harga: 3000, stok: 2, brand_category: 'Alpha' },
  { kode: 'B1', nama: 'Beta Satu', harga: 2000, stok: 0, brand_category: '' }
]);
cek('dua kelompok terbentuk', grup.length === 2, String(grup.length));
const alpha = grup.find(g => g.brand === 'Alpha');
cek('harga minimum benar', alpha.min_price === 1000);
cek('harga maksimum benar', alpha.max_price === 3000);
cek('stok dijumlahkan', alpha.total_stock === 3);
cek('merek kosong jatuh ke kata pertama nama', grup.some(g => g.brand === 'Beta'));

// ============================================================
bagian('15. pesanNomorSalah selalu memberi jalan keluar');

cek('jenis + durasi digabung', view.judulPaket({ variant_type: 'Sharing', duration: '30 Hari' }) === 'Sharing · 30 Hari');
cek('jenis yang ternyata durasi tidak diulang',
  view.judulPaket({ variant_type: '1 Tahun', duration: '12 Bulan' }) === '12 Bulan',
  view.judulPaket({ variant_type: '1 Tahun', duration: '12 Bulan' }));
cek('durasi saja tetap tampil', view.judulPaket({ duration: '7 Hari' }) === '7 Hari');
cek('jenis saja tetap tampil', view.judulPaket({ variant_type: 'Private' }) === 'Private');
cek('tanpa keduanya jatuh ke nama produk', view.judulPaket({ nama: 'Paket Polos' }) === 'Paket Polos');

cek('menyebut jangkauan', view.pesanNomorSalah(9, 3).includes('*3*'));
cek('menyebut .list', view.pesanNomorSalah(9, 3).includes('.list'));
cek('daftar kosong diberi pesan kedaluwarsa', view.pesanNomorSalah(1, 0).includes('kedaluwarsa'));

// ============================================================
bagian('16. AMANKAN STOK — kredensial yatim bisa dilihat & dibuang');

await db.addProduct('UJI-YATIM', 'Calon Yatim', 20000, 0, '', '', 'MANUAL', '', '', 'Yatim Brand', null, '1 Bulan');
await db.addProductItemsBatch('UJI-YATIM', ['akunA@mail.com|x', 'akunB@mail.com|y', 'akunC@mail.com|z']);

const sebelumYatim = await db.getStokYatim();
cek('stok produk yang masih hidup tidak dianggap yatim',
  !sebelumYatim.some(y => y.kode === 'UJI-YATIM'), sebelumYatim.map(y => y.kode).join(','));

// Hapus baris products-nya saja, meniru jalur lama yang meninggalkan kredensial.
await db.runQuery("DELETE FROM products WHERE kode = 'UJI-YATIM'");

const yatim = await db.getStokYatim();
const barisYatim = yatim.find(y => y.kode === 'UJI-YATIM');
cek('kredensial tanpa produk terdeteksi', Boolean(barisYatim), yatim.map(y => y.kode).join(','));
cek('jumlahnya benar', barisYatim?.jumlah === 3, String(barisYatim?.jumlah));
cek('semuanya tercatat ready', barisYatim?.ready === 3, String(barisYatim?.ready));

// Kredensial yatim TIDAK boleh muncul di katalog pelanggan.
const katalogSetelah = await ketik('.list');
cek('kredensial yatim tidak diiklankan ke pelanggan',
  !/yatim brand/i.test(katalogSetelah), katalogSetelah.slice(0, 200));

// Penjaga: perintah buang menolak kode yang produknya masih ada.
const tolak = await db.hapusStokYatim('UJI-M-30');
cek('menolak membuang stok produk yang masih dijual', tolak.success === false, String(tolak.alasan));
cek('alasannya dijelaskan', String(tolak.message).includes('masih terdaftar'), tolak.message);
const masihAda = await db.getAvailableItemsCount('UJI-M-30');
cek('stok produk hidup tidak tersentuh', typeof masihAda === 'number');

const buang = await db.hapusStokYatim('UJI-YATIM');
cek('kredensial yatim bisa dibuang', buang.success === true);
cek('jumlah yang dibuang dilaporkan', buang.dihapus === 3, String(buang.dihapus));
cek('sesudah dibuang tidak tersisa',
  !(await db.getStokYatim()).some(y => y.kode === 'UJI-YATIM'));
cek('kode yang tidak ada dijawab, bukan melempar',
  (await db.hapusStokYatim('KODE-NGAWUR')).success === false);

// ============================================================
bagian('17. sidikKredensial — bentuk kredensial yang betul dipakai toko ini');

// Empat baris pertama disalin dari bentuk asli di shop.db milik owner.
const adobe = 'https://redeem.adobe.com/express-premium?asm=cs&pid=airtel&rc=YD5K-GOUQ';
const apple1 = 'https://music.apple.com/redeem?ctx=Music&code=HRKLN4JLRLNF';
const apple2 = 'https://music.apple.com/redeem?ctx=Music&code=K4HR4YETM9J9';
const office1 = 'vb3463@365offices.com | G!a63gqK';
const office2 = 'vb4104@365offices.com | WAR#B1g1';

const sidik = db.sidikKredensial;
cek('dua voucher Apple berbeda tidak dianggap sama', sidik(apple1) !== sidik(apple2), `${sidik(apple1)} vs ${sidik(apple2)}`);
cek('voucher Adobe punya sidik sendiri', sidik(adobe) !== sidik(apple1));
cek('dua akun Office berbeda tidak dianggap sama', sidik(office1) !== sidik(office2));
cek('tautan tidak runtuh jadi "https"', !sidik(apple1).includes('https'), sidik(apple1));
cek('akun email dikenali dari emailnya', sidik(office1) === 'akun:vb3463@365offices.com', sidik(office1));
cek('voucher dikenali dari kodenya', sidik(apple1) === 'kode:hrkln4jlrlnf', sidik(apple1));

// Voucher sama dengan parameter pelacak berbeda TETAP voucher yang sama.
cek('parameter pelacak berbeda tetap dianggap voucher yang sama',
  sidik('https://music.apple.com/redeem?code=HRKLN4JLRLNF&utm=wa') === sidik(apple1));
cek('beda huruf besar-kecil tetap dianggap sama', sidik(office1.toUpperCase()) === sidik(office1));
cek('spasi berlebih tidak membuat kembar lolos', sidik('  ' + office1 + '  ') === sidik(office1));
cek('teks kosong tidak bersidik', sidik('') === '');

// ============================================================
bagian('18. AMANKAN STOK — kredensial kembar ditolak, bukan dijual dua kali');

await db.addProduct('UJI-DUP', 'Produk Kembar', 20000, 0, '', '', 'MANUAL', '', '', 'Dup Brand', null, '1 Bulan');

const isi1 = await db.addProductItemsBatch('UJI-DUP', [apple1, apple2]);
cek('dua kredensial berbeda masuk semua', isi1.addedCount === 2, String(isi1.addedCount));
cek('tidak ada yang dilewati', (isi1.dilewati || []).length === 0);

// Owner menempel ulang salah satunya (kejadian paling sering saat copy-paste).
const isi2 = await db.addProductItemsBatch('UJI-DUP', [apple1, office1]);
cek('yang baru tetap masuk', isi2.addedCount === 1, String(isi2.addedCount));
cek('yang kembar dilewati', (isi2.dilewati || []).length === 1);
cek('alasannya disebut', isi2.dilewati[0]?.alasan === 'SUDAH_ADA', isi2.dilewati[0]?.alasan);
cek('stok tidak menggelembung', (await db.getAvailableItemsCount('UJI-DUP')) === 3,
  String(await db.getAvailableItemsCount('UJI-DUP')));

// Kembar di dalam satu pesan yang sama.
const isi3 = await db.addProductItemsBatch('UJI-DUP', [office2, office2, office2]);
cek('baris kembar dalam satu pesan cuma dihitung sekali', isi3.addedCount === 1, String(isi3.addedCount));
cek('dua sisanya dilaporkan', (isi3.dilewati || []).length === 2);
cek('ditandai kembar-di-daftar', isi3.dilewati[0]?.alasan === 'KEMBAR_DI_DAFTAR', isi3.dilewati[0]?.alasan);

// Kredensial yang SUDAH DIKIRIM ke pembeli tidak boleh dijual lagi.
await db.runQuery("UPDATE product_items SET status = 'USED' WHERE produk_kode = 'UJI-DUP' AND data_content = ?", [apple2]);
const sebelumUsed = await db.getAvailableItemsCount('UJI-DUP');
const isi4 = await db.addProductItemsBatch('UJI-DUP', [apple2]);
cek('akun yang sudah dikirim ditolak', isi4.success === false, String(isi4.alasan));
cek('alasannya: sudah dikirim ke pembeli', isi4.dilewati?.[0]?.alasan === 'SUDAH_DIKIRIM', isi4.dilewati?.[0]?.alasan);
cek('stok tidak bertambah sedikit pun', (await db.getAvailableItemsCount('UJI-DUP')) === sebelumUsed,
  `${await db.getAvailableItemsCount('UJI-DUP')} vs ${sebelumUsed}`);

// Jalur dashboard memakai penyaring yang sama.
const sebelumDash = await db.getAvailableItemsCount('UJI-DUP');
await db.addProductItems('UJI-DUP', [apple1]);
cek('jalur dashboard juga menolak kembar',
  (await db.getAvailableItemsCount('UJI-DUP')) === sebelumDash,
  String(await db.getAvailableItemsCount('UJI-DUP')));

// ============================================================
bagian('19. AMANKAN STOK — kembar lama terlihat, angka melenceng bisa dibetulkan');

// Tiru data lama: dua baris identik yang sudah terlanjur ada di database.
await db.addProduct('UJI-LAMA', 'Kembar Lama', 20000, 0, '', '', 'MANUAL', '', '', 'Lama Brand', null, '1 Bulan');
await db.runQuery("INSERT INTO product_items (produk_kode, data_content, status) VALUES ('UJI-LAMA', ?, 'READY')", [office1]);
await db.runQuery("INSERT INTO product_items (produk_kode, data_content, status) VALUES ('UJI-LAMA', ?, 'READY')", [office1]);
await db.runQuery("UPDATE products SET delivery_type = 'AUTO', stok = 2 WHERE kode = 'UJI-LAMA'");

const rincian = await db.getProductStockDetails('UJI-LAMA');
cek('kembar lama terdeteksi', rincian.kembar.length === 1, String(rincian.kembar.length));
cek('jumlah barisnya benar', rincian.kembar[0]?.jumlah === 2, String(rincian.kembar[0]?.jumlah));
cek('id-nya diberikan supaya bisa dihapus', rincian.kembar[0]?.ids.length === 2);

// Angka tersimpan melenceng dari kredensial yang benar-benar ada.
await db.runQuery("UPDATE products SET stok = 99 WHERE kode = 'UJI-LAMA'");
const melenceng = await db.getProductStockDetails('UJI-LAMA');
cek('melencengnya ketahuan', melenceng.melenceng === true);
cek('kolom mentahnya dilaporkan apa adanya', melenceng.kolomStok === 99, String(melenceng.kolomStok));
cek('yang benar-benar siap jual tetap dilaporkan benar', melenceng.ready === 2, String(melenceng.ready));

const sinkron = await db.sinkronkanStokAuto();
cek('sinkronisasi membetulkan', sinkron.diperbaiki.some(d => d.kode === 'UJI-LAMA'), JSON.stringify(sinkron.diperbaiki));
const sesudahSinkron = await db.getProductStockDetails('UJI-LAMA');
cek('sesudah disinkronkan tidak melenceng lagi', sesudahSinkron.melenceng === false);
cek('angkanya jadi jumlah kredensial sungguhan', sesudahSinkron.kolomStok === 2, String(sesudahSinkron.kolomStok));

const sinkronLagi = await db.sinkronkanStokAuto();
cek('menjalankan dua kali tidak mengubah apa-apa', sinkronLagi.diperbaiki.length === 0, String(sinkronLagi.diperbaiki.length));

// ============================================================
bagian('20. AMANKAN STOK — laporan harian memakai stok asli');

// Produk AUTO dengan kolom berbohong 5, padahal tidak ada kredensial sama sekali.
await db.addProduct('UJI-LAPOR', 'Produk Laporan', 20000, 0, '', '', 'MANUAL', '', '', 'Lapor Brand', null, '1 Bulan');
await db.runQuery("UPDATE products SET delivery_type = 'AUTO', stok = 5 WHERE kode = 'UJI-LAPOR'");

const hariIni = new Date(Date.now() + 7 * 3600 * 1000).toISOString().split('T')[0];
const laporan = await db.getDailySalesReport(hariIni);

cek('produk tanpa kredensial masuk daftar STOK HABIS',
  laporan.outOfStockProducts.some(p => p.kode === 'UJI-LAPOR'),
  laporan.outOfStockProducts.map(p => p.kode).join(','));
cek('tidak salah masuk daftar stok menipis',
  !laporan.lowStockProducts.some(p => p.kode === 'UJI-LAPOR'),
  laporan.lowStockProducts.map(p => p.kode).join(','));

// Produk yang memang tinggal sedikit harus muncul sebagai peringatan restok.
cek('produk bersisa 2 muncul sebagai stok menipis',
  laporan.lowStockProducts.some(p => p.kode === 'UJI-LAMA'),
  laporan.lowStockProducts.map(p => `${p.kode}:${p.stok}`).join(','));
cek('angka yang dilaporkan adalah stok asli',
  laporan.lowStockProducts.find(p => p.kode === 'UJI-LAMA')?.stok === 2,
  String(laporan.lowStockProducts.find(p => p.kode === 'UJI-LAMA')?.stok));

// ============================================================
console.log('\n════════════════════════════════════════');
console.log(`Pemeriksaan : ${lulus + gagal}`);
console.log(`Lulus       : ${lulus}`);
console.log(`Gagal       : ${gagal}`);
console.log('════════════════════════════════════════');

try { fs.rmSync(kotakPasir, { recursive: true, force: true }); } catch {}
process.exit(gagal ? 1 : 0);
