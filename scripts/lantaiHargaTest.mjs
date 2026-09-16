/**
 * UJI LANTAI HARGA
 *
 * Toko ini punya TIGA potongan yang bisa menempel pada satu pesanan sekaligus:
 * flash sale, kupon, dan diskon premium. Sebelum lantai harga dipasang,
 * ketiganya dijumlahkan tanpa batas bawah selain nol — dan barangnya tetap
 * terkirim untuk harga berapa pun yang tersisa.
 *
 * Bagian 1-3 menguji matematikanya langsung (murni, tanpa database).
 * Bagian 4 membangun keranjang sungguhan dengan ketiga diskon menempel dan
 * memeriksa angka yang BENAR-BENAR tersimpan di tabel orders.
 *
 * Pakai:
 *   node scripts/lantaiHargaTest.mjs
 *
 * KEAMANAN: pindah ke direktori sementara SEBELUM memuat lapisan database,
 * karena connection.js membuka './shop.db' relatif terhadap direktori kerja.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';

const AKAR = path.resolve(import.meta.dirname, '..');
const REPO = pathToFileURL(AKAR).href + '/';

const kotakPasir = fs.mkdtempSync(path.join(os.tmpdir(), 'lantai-uji-'));
process.chdir(kotakPasir);
console.log(`Kotak pasir: ${kotakPasir}`);

process.env.JWT_SECRET ||= 'uji-asap-bukan-rahasia-sungguhan';
process.env.ADMIN_USER ||= 'ujiasap';
process.env.ADMIN_PASSWORD_HASH ||= '$2b$10$0000000000000000000000000000000000000000000000000000';

const L = await import(REPO + 'src/utils/lantaiHarga.js');
const db = await import(REPO + 'database.js');

await db.openDb();
await db.initDb();

let lulus = 0;
let gagal = 0;
function cek(nama, kondisi, detail = '') {
  if (kondisi) { lulus++; console.log(`  OK    ${nama}`); }
  else { gagal++; console.log(`  GAGAL ${nama}${detail !== '' ? ' -> ' + detail : ''}`); }
}
const bagian = (j) => console.log(`\n== ${j} ==`);

// ============================================================
bagian('1. Menghitung lantainya');

cek('40% dari Rp50.000 = Rp20.000',
  L.hitungLantaiHarga({ totalKatalog: 50000, rawTotal: 50000, persenMinimal: 40, minimalRupiah: 1000 }) === 20000);

// Flash sale sudah memangkas rawTotal; lantainya TETAP dihitung dari harga
// katalog, kalau tidak flash sale lolos sepenuhnya dari aturan ini.
cek('flash sale tidak mengecilkan lantainya',
  L.hitungLantaiHarga({ totalKatalog: 50000, rawTotal: 30000, persenMinimal: 40, minimalRupiah: 1000 }) === 20000,
  String(L.hitungLantaiHarga({ totalKatalog: 50000, rawTotal: 30000, persenMinimal: 40, minimalRupiah: 1000 })));

// ...tapi lantainya tidak boleh MENAIKKAN total. Flash sale yang sengaja
// dipasang di bawah lantai adalah keputusan owner sendiri.
cek('flash sale di bawah lantai tidak menaikkan harga kembali',
  L.hitungLantaiHarga({ totalKatalog: 50000, rawTotal: 15000, persenMinimal: 40, minimalRupiah: 1000 }) === 15000,
  String(L.hitungLantaiHarga({ totalKatalog: 50000, rawTotal: 15000, persenMinimal: 40, minimalRupiah: 1000 })));

cek('nominal minimal menang untuk barang murah',
  L.hitungLantaiHarga({ totalKatalog: 2000, rawTotal: 2000, persenMinimal: 40, minimalRupiah: 1000 }) === 1000,
  String(L.hitungLantaiHarga({ totalKatalog: 2000, rawTotal: 2000, persenMinimal: 40, minimalRupiah: 1000 })));

cek('barang lebih murah dari nominal minimal: lantai = harganya sendiri',
  L.hitungLantaiHarga({ totalKatalog: 500, rawTotal: 500, persenMinimal: 40, minimalRupiah: 1000 }) === 500);

cek('persen 0: yang tersisa cuma nominal minimal',
  L.hitungLantaiHarga({ totalKatalog: 50000, rawTotal: 50000, persenMinimal: 0, minimalRupiah: 1000 }) === 1000);

cek('persen 100: tidak boleh ada diskon sama sekali',
  L.hitungLantaiHarga({ totalKatalog: 50000, rawTotal: 50000, persenMinimal: 100, minimalRupiah: 0 }) === 50000);

cek('keranjang kosong -> lantai 0', L.hitungLantaiHarga({ totalKatalog: 0, rawTotal: 0 }) === 0);
cek('nilai sampah tidak melempar', L.hitungLantaiHarga({ totalKatalog: 'x', rawTotal: null }) === 0);
cek('persen di luar akal dijepit',
  L.hitungLantaiHarga({ totalKatalog: 10000, rawTotal: 10000, persenMinimal: 999, minimalRupiah: 0 }) === 10000);
cek('persen negatif dijepit ke 0',
  L.hitungLantaiHarga({ totalKatalog: 10000, rawTotal: 10000, persenMinimal: -50, minimalRupiah: 0 }) === 0);
cek('tanpa setelan, bawaannya 40% / Rp1.000',
  L.hitungLantaiHarga({ totalKatalog: 50000, rawTotal: 50000 }) === 20000);

// ============================================================
bagian('2. Menerapkan lantainya — potongan yang dipangkas, bukan pesanan');

const aman = L.terapkanLantaiHarga({ rawTotal: 50000, diskonKupon: 5000, diskonPremium: 2500, lantai: 20000 });
cek('diskon wajar dibiarkan apa adanya', aman.total === 42500 && aman.kenaLantai === false, JSON.stringify(aman));
cek('tidak ada yang dipangkas', aman.dipangkas.kupon === 0 && aman.dipangkas.premium === 0);

// Kupon 100% + premium: dulu ini menghasilkan Rp0.
const nol = L.terapkanLantaiHarga({ rawTotal: 50000, diskonKupon: 50000, diskonPremium: 5000, lantai: 20000 });
cek('kupon 100% + premium TIDAK bisa mencapai nol', nol.total === 20000, JSON.stringify(nol));
// Kupon dipangkas 50.000 -> 25.000; bersama premium Rp5.000 potongannya jadi
// Rp30.000, tepat menyisakan lantai Rp20.000.
cek('yang dipangkas kuponnya', nol.dipangkas.kupon === 25000, String(nol.dipangkas.kupon));
cek('kupon yang tersisa + premium = potongan yang menyisakan lantai',
  nol.diskonKupon === 25000, String(nol.diskonKupon));
cek('diskon premium DIPERTAHANKAN utuh — pelanggan sudah membayarnya',
  nol.diskonPremium === 5000 && nol.dipangkas.premium === 0, JSON.stringify(nol));
cek('angka yang dipulangkan konsisten: subtotal - potongan = total',
  50000 - nol.diskonKupon - nol.diskonPremium === nol.total,
  `${nol.diskonKupon} + ${nol.diskonPremium} vs ${nol.total}`);

// Kalau premium SENDIRIAN pun menembus lantai, barulah premium ikut dipangkas.
const premiumBesar = L.terapkanLantaiHarga({ rawTotal: 50000, diskonKupon: 0, diskonPremium: 45000, lantai: 20000 });
cek('premium sendirian pun tidak boleh menembus lantai', premiumBesar.total === 20000, JSON.stringify(premiumBesar));
cek('barulah premium yang dipangkas', premiumBesar.dipangkas.premium === 15000, String(premiumBesar.dipangkas.premium));

cek('tanpa diskon sama sekali, total = subtotal',
  L.terapkanLantaiHarga({ rawTotal: 50000, lantai: 20000 }).total === 50000);

// Lantai yang lebih tinggi dari subtotal dijepit, bukan menaikkan harga.
const lantaiKetinggian = L.terapkanLantaiHarga({ rawTotal: 10000, diskonKupon: 9000, diskonPremium: 0, lantai: 99999 });
cek('lantai di atas subtotal tidak menaikkan total', lantaiKetinggian.total === 10000, JSON.stringify(lantaiKetinggian));

cek('diskon negatif diperlakukan sebagai nol',
  L.terapkanLantaiHarga({ rawTotal: 10000, diskonKupon: -500, lantai: 4000 }).total === 10000);

// ============================================================
bagian('3. Tidak ada kombinasi yang bisa menembus lantainya');

let tembus = 0;
let menaikkan = 0;
for (let subtotal = 1000; subtotal <= 100000; subtotal += 7000) {
  for (const persen of [0, 20, 40, 60, 100]) {
    for (const kupon of [0, subtotal / 2, subtotal, subtotal * 2]) {
      for (const prem of [0, subtotal / 4, subtotal]) {
        const lantai = L.hitungLantaiHarga({ totalKatalog: subtotal, rawTotal: subtotal, persenMinimal: persen, minimalRupiah: 1000 });
        const h = L.terapkanLantaiHarga({ rawTotal: subtotal, diskonKupon: kupon, diskonPremium: prem, lantai });
        if (h.total < lantai) tembus++;
        if (h.total > subtotal) menaikkan++;
      }
    }
  }
}
cek('tidak satu pun dari 900 kombinasi menembus lantai', tembus === 0, `${tembus} tembus`);
cek('tidak satu pun membuat pembeli membayar LEBIH dari subtotal', menaikkan === 0, `${menaikkan} naik`);

// ============================================================
bagian('4. Keranjang sungguhan — flash sale + kupon + premium sekaligus');

const PEMBELI = '628999000111@s.whatsapp.net';
await db.addProduct('UJI-LANTAI', 'Produk Uji Lantai', 50000, 0, '', '', 'AUTO', '', '', 'Uji', null, '1 Bulan');
await db.addProductItemsBatch('UJI-LANTAI', ['akunA@mail.com|p1', 'akunB@mail.com|p2', 'akunC@mail.com|p3']);
await db.getOrCreateCustomer?.(PEMBELI, 'Uji Lantai');

const keranjang = await db.addToCart(PEMBELI, 'UJI-LANTAI', 1);
cek('produk masuk keranjang', keranjang.success === true, JSON.stringify(keranjang));

let order = await db.getQuery("SELECT * FROM orders WHERE customer_nomor = ? AND status = 'CART'", [PEMBELI]);
cek('harga penuh dulu: Rp50.000', order.total === 50000, String(order.total));

// Kupon 90%.
await db.addCoupon('UJI90', 'percent', 90, 0, 0, null);
await db.applyCouponToOrder(order.order_id, 'UJI90', 45000);
order = await db.getQuery("SELECT * FROM orders WHERE order_id = ?", [order.order_id]);
cek('kupon 90% sendirian sudah tertahan lantai 40%', order.total === 20000, String(order.total));
cek('potongan kupon yang TERSIMPAN ikut dipangkas, bukan cuma totalnya',
  order.discount_amount === 30000, String(order.discount_amount));
cek('baris-barisnya masih menjumlah: 50.000 - 30.000 = 20.000',
  50000 - order.discount_amount - (order.premium_discount || 0) === order.total,
  `${order.discount_amount} / ${order.premium_discount} / ${order.total}`);

// Tambahkan diskon premium di atasnya.
await db.runQuery("UPDATE orders SET premium_discount = ? WHERE order_id = ?", [15000, order.order_id]);
await db.applyCouponToOrder(order.order_id, 'UJI90', 45000);
order = await db.getQuery("SELECT * FROM orders WHERE order_id = ?", [order.order_id]);
cek('kupon + premium tetap tertahan di Rp20.000', order.total === 20000, String(order.total));
cek('premium dipertahankan utuh', order.premium_discount === 15000, String(order.premium_discount));
cek('kuponlah yang mengalah', order.discount_amount === 15000, String(order.discount_amount));

// Lalu flash sale di atas semuanya.
await db.setFlashSale('UJI-LANTAI', 25000, 5);
await db.addToCart(PEMBELI, 'UJI-LANTAI', 1);
order = await db.getQuery("SELECT * FROM orders WHERE order_id = ?", [order.order_id]);
cek('flash sale + kupon + premium: total TIDAK nol', order.total > 0, String(order.total));
cek('flash sale + kupon + premium: tetap >= lantai Rp20.000 (dihitung dari harga katalog)',
  order.total >= 20000, `total ${order.total}`);
cek('konsistensi akhir: subtotal - potongan = total',
  (await db.getQuery("SELECT SUM(subtotal) t FROM order_items WHERE order_id = ?", [order.order_id])).t
    - order.discount_amount - order.premium_discount === order.total,
  JSON.stringify(order));

// Lantai boleh dilonggarkan owner, dan efeknya harus langsung terasa.
await db.updateSettings({ lantaiHargaPersen: 10, lantaiHargaMinimal: 1000 });
await db.applyCouponToOrder(order.order_id, 'UJI90', 45000);
order = await db.getQuery("SELECT * FROM orders WHERE order_id = ?", [order.order_id]);
cek('lantai dilonggarkan ke 10%: potongan lebih besar diizinkan', order.total < 20000, String(order.total));
cek('tetapi tidak pernah nol', order.total >= 1000, String(order.total));

console.log(`\n${'='.repeat(50)}`);
console.log(`HASIL: ${lulus} lulus, ${gagal} gagal`);
console.log('='.repeat(50));

try {
  fs.rmSync(kotakPasir, { recursive: true, force: true });
} catch {
  // Berkas database kadang masih terkunci di Windows.
}

process.exit(gagal > 0 ? 1 : 0);
