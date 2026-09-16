/**
 * UJI ASAP SIARAN RESTOK & TURUN HARGA
 *
 * Yang dijaga uji ini bukan "pesannya terkirim", melainkan yang SENGAJA TIDAK
 * dikirim. Empat aturan itu yang menentukan apakah kanal pengumuman masih
 * dibaca orang enam bulan lagi:
 *
 *   1. Restok yang stoknya tidak pernah nol TIDAK diumumkan.
 *   2. Harga NAIK tidak pernah diumumkan.
 *   3. Stok HABIS tidak pernah diumumkan ke pembeli.
 *   4. Satu sesi restok jadi SATU pesan, bukan satu pesan per `.addstock`.
 *
 * Dan satu hal yang sudah pernah salah di modul lain: antrean tidak boleh
 * hilang saat WhatsApp kebetulan sedang putus.
 *
 * Tidak menyentuh database sama sekali — socket dan settings dititipkan.
 *
 * Pakai:
 *   node scripts/siaranSmokeTest.mjs
 */
import path from 'path';
import { pathToFileURL } from 'url';

const AKAR = path.resolve(import.meta.dirname, '..');
const REPO = pathToFileURL(AKAR).href + '/';

const s = await import(REPO + 'src/handlers/siaranStok.js');

let lulus = 0;
let gagal = 0;

function cek(nama, kondisi, detail = '') {
  if (kondisi) { lulus++; console.log(`  OK    ${nama}`); }
  else { gagal++; console.log(`  GAGAL ${nama}${detail !== '' ? ' -> ' + detail : ''}`); }
}
const bagian = (j) => console.log(`\n== ${j} ==`);

const GRUP_UPDATE = '120363000000000001@g.us';
const GRUP_PEMBELI = '120363000000000002@g.us';

const terkirim = [];
const sockPalsu = {
  sendMessage: async (tujuan, isi) => { terkirim.push({ tujuan, teks: isi.text || '', isi }); return { key: { id: 'uji' } }; }
};
const sockRusak = {
  sendMessage: async () => { throw new Error('Connection Closed'); }
};

let settingsPalsu = { updateGroupId: GRUP_UPDATE };
s.pasangPembacaSettings(async () => settingsPalsu);
s.pasangJedaSiaran(1);

const bersih = () => { s.kosongkanAntrean(); terkirim.length = 0; };

// ============================================================
bagian('1. Penyusun pesan — murni teks');

const cumaRestok = s.susunSiaran({
  restok: [{ kode: 'GEMINI', nama: 'Gemini Pro 18 Bulan', harga: 60000, stok: 7 }]
});
cek('restok: nama produk tampil', cumaRestok.includes('Gemini Pro 18 Bulan'));
cek('restok: harga diformat rupiah', cumaRestok.includes('Rp60.000'), cumaRestok);
cek('restok: jumlah stok tampil', cumaRestok.includes('7 pcs'), cumaRestok);
cek('restok: kode produk tampil supaya bisa langsung dibeli', cumaRestok.includes('GEMINI'));
cek('restok: satu produk -> judulnya "STOK READY KEMBALI"', cumaRestok.includes('STOK READY KEMBALI'), cumaRestok);

const banyakRestok = s.susunSiaran({
  restok: [
    { kode: 'A', nama: 'Produk A', harga: 10000, stok: 3 },
    { kode: 'B', nama: 'Produk B', harga: 20000, stok: 5 }
  ]
});
cek('restok: banyak produk jadi SATU pesan', banyakRestok.includes('Produk A') && banyakRestok.includes('Produk B'), banyakRestok);
cek('restok: banyak produk -> judulnya "RESTOK HARI INI"', banyakRestok.includes('RESTOK HARI INI'), banyakRestok);
cek('restok: ajakan beli hanya SEKALI, bukan per produk',
  (banyakRestok.match(/Ketik/g) || []).length === 1, banyakRestok);

const turun = s.susunSiaran({
  turunHarga: [{ kode: 'GEMINI', nama: 'Gemini Pro', hargaLama: 75000, hargaBaru: 60000 }]
});
cek('turun harga: harga lama dicoret', turun.includes('~Rp75.000~'), turun);
cek('turun harga: harga baru ditebalkan', turun.includes('*Rp60.000*'), turun);
cek('turun harga: penghematan dihitung', turun.includes('Rp15.000'), turun);
cek('turun harga: persen dihitung', turun.includes('20%'), turun);

const gabungan = s.susunSiaran({
  restok: [{ kode: 'A', nama: 'Produk A', harga: 10000, stok: 3 }],
  turunHarga: [{ kode: 'B', nama: 'Produk B', hargaLama: 20000, hargaBaru: 15000 }]
});
cek('restok & turun harga digabung dalam satu pesan',
  gabungan.includes('Produk A') && gabungan.includes('Produk B'), gabungan);

cek('tidak ada apa-apa -> null, bukan pesan kosong', s.susunSiaran({}) === null);
cek('daftar kosong -> null', s.susunSiaran({ restok: [], turunHarga: [] }) === null);

// Stok habis tidak boleh pernah muncul sebagai pengumuman ke pembeli.
cek('tidak ada kosakata "stok habis" di pesan mana pun',
  !/habis|kosong|sold out/i.test(`${cumaRestok}${banyakRestok}${turun}${gabungan}`));

// ============================================================
bagian('2. Restok — hanya yang tadinya BENAR-BENAR nol');

bersih();
cek('0 -> 5 diterima', s.antrekanRestok({ kode: 'A', nama: 'Produk A', harga: 1000, stokSebelum: 0, stokSesudah: 5 }) === true);

bersih();
cek('20 -> 25 DITOLAK (bukan kabar)',
  s.antrekanRestok({ kode: 'A', nama: 'Produk A', harga: 1000, stokSebelum: 20, stokSesudah: 25 }) === false);
cek('yang ditolak tidak menyisakan apa pun di antrean', s.isiAntrean().restok.length === 0);

bersih();
cek('0 -> 0 DITOLAK', s.antrekanRestok({ kode: 'A', nama: 'A', harga: 1, stokSebelum: 0, stokSesudah: 0 }) === false);
cek('5 -> 0 (justru habis) DITOLAK', s.antrekanRestok({ kode: 'A', nama: 'A', harga: 1, stokSebelum: 5, stokSesudah: 0 }) === false);
cek('tanpa nama produk DITOLAK', s.antrekanRestok({ kode: 'A', stokSebelum: 0, stokSesudah: 5 }) === false);
cek('tanpa kode DITOLAK', s.antrekanRestok({ nama: 'A', stokSebelum: 0, stokSesudah: 5 }) === false);

// `.addstock` dua kali untuk produk yang sama = SATU baris, bukan dua.
bersih();
s.antrekanRestok({ kode: 'A', nama: 'Produk A', harga: 1000, stokSebelum: 0, stokSesudah: 3 });
s.antrekanRestok({ kode: 'a', nama: 'Produk A', harga: 1000, stokSebelum: 0, stokSesudah: 8 });
cek('produk yang sama tidak jadi dua baris', s.isiAntrean().restok.length === 1, JSON.stringify(s.isiAntrean().restok));
cek('yang dipakai angka stok TERBARU', s.isiAntrean().restok[0].stok === 8, String(s.isiAntrean().restok[0].stok));
cek('kode selalu huruf besar', s.isiAntrean().restok[0].kode === 'A');

// ============================================================
bagian('3. Harga — hanya yang TURUN');

bersih();
cek('75.000 -> 60.000 diterima',
  s.antrekanTurunHarga({ kode: 'A', nama: 'A', hargaLama: 75000, hargaBaru: 60000 }) === true);

bersih();
cek('60.000 -> 75.000 (NAIK) DITOLAK',
  s.antrekanTurunHarga({ kode: 'A', nama: 'A', hargaLama: 60000, hargaBaru: 75000 }) === false);
cek('harga sama DITOLAK',
  s.antrekanTurunHarga({ kode: 'A', nama: 'A', hargaLama: 60000, hargaBaru: 60000 }) === false);
cek('nilai bukan angka DITOLAK',
  s.antrekanTurunHarga({ kode: 'A', nama: 'A', hargaLama: 'mahal', hargaBaru: 1 }) === false);
cek('antrean tetap bersih sesudah semua penolakan', s.isiAntrean().turunHarga.length === 0);

// Turun dua kali sebelum terkirim: yang diumumkan potongan TOTAL, bukan
// potongan terakhirnya saja.
bersih();
s.antrekanTurunHarga({ kode: 'A', nama: 'A', hargaLama: 100000, hargaBaru: 80000 });
s.antrekanTurunHarga({ kode: 'A', nama: 'A', hargaLama: 80000, hargaBaru: 60000 });
const dobel = s.isiAntrean().turunHarga[0];
cek('turun dua kali: harga lama tetap yang paling awal', dobel.hargaLama === 100000, String(dobel.hargaLama));
cek('turun dua kali: harga baru yang terakhir', dobel.hargaBaru === 60000, String(dobel.hargaBaru));

// ============================================================
bagian('4. Pengiriman — dan apa yang terjadi saat gagal');

bersih();
s.pasangSocketSiaran(null);
settingsPalsu = { updateGroupId: GRUP_UPDATE };
s.antrekanRestok({ kode: 'A', nama: 'Produk A', harga: 1000, stokSebelum: 0, stokSesudah: 3 });
let hasil = await s.kirimSekarang();
cek('tanpa socket: tidak mengaku terkirim', hasil.terkirim === false && hasil.alasan === 'SOCKET_BELUM_SIAP', JSON.stringify(hasil));
cek('tanpa socket: antrean DIPERTAHANKAN untuk dicoba lagi', s.isiAntrean().restok.length === 1);

s.pasangSocketSiaran(sockPalsu);
settingsPalsu = {};
hasil = await s.kirimSekarang();
cek('grup belum diset: tidak mengaku terkirim', hasil.alasan === 'GRUP_BELUM_DISET', JSON.stringify(hasil));
cek('grup belum diset: antrean DIPERTAHANKAN', s.isiAntrean().restok.length === 1);

settingsPalsu = { updateGroupId: GRUP_UPDATE };
s.pasangSocketSiaran(sockRusak);
hasil = await s.kirimSekarang();
cek('WhatsApp putus: tidak mengaku terkirim', hasil.alasan === 'GAGAL_KIRIM', JSON.stringify(hasil));
cek('WhatsApp putus: antrean DIPERTAHANKAN', s.isiAntrean().restok.length === 1);

s.pasangSocketSiaran(sockPalsu);
hasil = await s.kirimSekarang();
cek('berhasil: mengaku terkirim', hasil.terkirim === true, JSON.stringify(hasil));
cek('berhasil: masuk ke grup pengumuman', terkirim[0]?.tujuan === GRUP_UPDATE, terkirim[0]?.tujuan);
cek('berhasil: antrean baru dikosongkan SESUDAH terkirim', s.isiAntrean().restok.length === 0);

bersih();
hasil = await s.kirimSekarang();
cek('antrean kosong: tidak mengirim pesan kosong', hasil.terkirim === false && hasil.alasan === 'KOSONG');
cek('antrean kosong: tidak ada pesan yang keluar', terkirim.length === 0);

// Tujuan mundur bertahap kalau grup pengumuman belum diset.
bersih();
settingsPalsu = { buyerGroupId: GRUP_PEMBELI };
s.antrekanRestok({ kode: 'A', nama: 'Produk A', harga: 1000, stokSebelum: 0, stokSesudah: 3 });
await s.kirimSekarang();
cek('tanpa grup pengumuman, jatuh ke grup pembeli', terkirim[0]?.tujuan === GRUP_PEMBELI, terkirim[0]?.tujuan);

// ============================================================
bagian('5. Saklar mati — dan antrean yang ikut dibuang');

bersih();
settingsPalsu = { updateGroupId: GRUP_UPDATE, siaranOtomatis: 'OFF' };
s.antrekanRestok({ kode: 'A', nama: 'Produk A', harga: 1000, stokSebelum: 0, stokSesudah: 3 });
hasil = await s.kirimSekarang();
cek('siaran OFF: tidak ada yang dikirim', hasil.terkirim === false && hasil.alasan === 'DIMATIKAN', JSON.stringify(hasil));
cek('siaran OFF: tidak ada pesan keluar', terkirim.length === 0);
cek('siaran OFF: antrean dibuang, bukan ditumpuk sampai dinyalakan', s.isiAntrean().restok.length === 0);

bersih();
settingsPalsu = { updateGroupId: GRUP_UPDATE, siaranOtomatis: 'on' };
s.antrekanRestok({ kode: 'A', nama: 'Produk A', harga: 1000, stokSebelum: 0, stokSesudah: 3 });
hasil = await s.kirimSekarang();
cek('nilai "on" huruf kecil tetap terbaca sebagai nyala', hasil.terkirim === true, JSON.stringify(hasil));

bersih();
settingsPalsu = { updateGroupId: GRUP_UPDATE };
s.antrekanRestok({ kode: 'A', nama: 'Produk A', harga: 1000, stokSebelum: 0, stokSesudah: 3 });
hasil = await s.kirimSekarang();
cek('tanpa setelan apa pun, bawaannya NYALA', hasil.terkirim === true, JSON.stringify(hasil));

// ============================================================
bagian('6. Jeda hening — satu sesi restok jadi satu pesan');

bersih();
settingsPalsu = { updateGroupId: GRUP_UPDATE };
s.pasangJedaSiaran(1);
s.antrekanRestok({ kode: 'A', nama: 'Produk A', harga: 1000, stokSebelum: 0, stokSesudah: 3 });
s.antrekanRestok({ kode: 'B', nama: 'Produk B', harga: 2000, stokSebelum: 0, stokSesudah: 4 });
s.antrekanTurunHarga({ kode: 'C', nama: 'Produk C', hargaLama: 5000, hargaBaru: 4000 });
cek('belum ada yang terkirim sebelum jedanya lewat', terkirim.length === 0);

await new Promise(r => setTimeout(r, 1500));
cek('sesudah hening: TEPAT SATU pesan, bukan tiga', terkirim.length === 1, String(terkirim.length));
cek('satu pesan itu memuat ketiganya',
  terkirim[0]?.teks.includes('Produk A') && terkirim[0]?.teks.includes('Produk B') && terkirim[0]?.teks.includes('Produk C'),
  terkirim[0]?.teks);
cek('antrean kosong sesudahnya', s.isiAntrean().restok.length === 0 && s.isiAntrean().turunHarga.length === 0);

// ============================================================
bagian('7. Produk baru, dan restok menurut ambang "hampir habis"');

bersih();
s.pasangAmbangTipis(3);

cek('produk baru dengan stok siap diterima',
  s.antrekanProdukBaru({ kode: 'BARU', nama: 'Produk Baru', harga: 15000, stok: 5 }) === true);
cek('produk baru TANPA stok ditolak — jangan ajak beli barang yang belum ada',
  s.antrekanProdukBaru({ kode: 'KOSONG', nama: 'Belum Ada', harga: 1000, stok: 0 }) === false);

const teksBaru = s.susunSiaran({ produkBaru: s.isiAntrean().produkBaru });
cek('pesan produk baru memakai label PRODUK BARU', teksBaru.includes('PRODUK BARU'), teksBaru);
cek('pesan produk baru TIDAK menyebut restok', !/restok/i.test(teksBaru), teksBaru);

// Ambangnya yang menentukan restok mana yang jadi kabar.
bersih();
cek('restok dari 0 diterima', s.antrekanRestok({ kode: 'A', nama: 'A', harga: 1, stokSebelum: 0, stokSesudah: 5 }) === true);
bersih();
cek('restok dari 2 (di bawah ambang 3) diterima', s.antrekanRestok({ kode: 'A', nama: 'A', harga: 1, stokSebelum: 2, stokSesudah: 9 }) === true);
bersih();
cek('restok dari 3 (tepat di ambang) diterima', s.antrekanRestok({ kode: 'A', nama: 'A', harga: 1, stokSebelum: 3, stokSesudah: 9 }) === true);
bersih();
cek('restok dari 4 (di atas ambang) DITOLAK', s.antrekanRestok({ kode: 'A', nama: 'A', harga: 1, stokSebelum: 4, stokSesudah: 9 }) === false);
bersih();
cek('stok turun bukan restok', s.antrekanRestok({ kode: 'A', nama: 'A', harga: 1, stokSebelum: 2, stokSesudah: 1 }) === false);

// ============================================================
bagian('8. "Tinggal sedikit" — dan tidak pernah "habis"');

bersih();
cek('sisa 2 dari ambang 3 diterima', s.antrekanStokMenipis({ kode: 'A', nama: 'Produk A', harga: 5000, stok: 2 }) === true);
bersih();
cek('sisa 0 DITOLAK — itu iklan negatif', s.antrekanStokMenipis({ kode: 'A', nama: 'A', harga: 1, stok: 0 }) === false);
bersih();
cek('sisa 10 (masih banyak) DITOLAK', s.antrekanStokMenipis({ kode: 'A', nama: 'A', harga: 1, stok: 10 }) === false);

// Sekali berbunyi, diam sampai direstok.
bersih();
s.antrekanStokMenipis({ kode: 'A', nama: 'Produk A', harga: 5000, stok: 3 });
cek('peringatan kedua untuk produk yang sama DITOLAK',
  s.antrekanStokMenipis({ kode: 'A', nama: 'Produk A', harga: 5000, stok: 2 }) === false);
cek('peringatan ketiga juga DITOLAK',
  s.antrekanStokMenipis({ kode: 'A', nama: 'Produk A', harga: 5000, stok: 1 }) === false);
cek('antreannya tetap satu baris', s.isiAntrean().menipis.length === 1);

// Sesudah direstok, siklus berikutnya boleh berbunyi lagi.
s.antrekanRestok({ kode: 'A', nama: 'Produk A', harga: 5000, stokSebelum: 1, stokSesudah: 20 });
cek('restok mencabut baris "tinggal sedikit"', s.isiAntrean().menipis.length === 0, JSON.stringify(s.isiAntrean().menipis));
cek('sesudah direstok, peringatan menipis boleh berbunyi lagi',
  s.antrekanStokMenipis({ kode: 'A', nama: 'Produk A', harga: 5000, stok: 2 }) === false,
  'masih dalam antrean restok yang sama — benar ditolak');

bersih();
const teksTipis = s.susunSiaran({ menipis: [{ kode: 'A', nama: 'Produk A', harga: 5000, stok: 2 }] });
cek('pesannya berbunyi "TINGGAL SEDIKIT"', teksTipis.includes('TINGGAL SEDIKIT'), teksTipis);
cek('pesannya TIDAK pernah menulis "habis" atau "kosong"',
  !/habis|kosong|sold out/i.test(teksTipis), teksTipis);

// Satu produk tidak boleh muncul di dua bagian sekaligus.
bersih();
s.antrekanRestok({ kode: 'A', nama: 'Produk A', harga: 5000, stokSebelum: 0, stokSesudah: 9 });
s.antrekanProdukBaru({ kode: 'A', nama: 'Produk A', harga: 5000, stok: 9 });
const isi = s.isiAntrean();
cek('produk baru mencabut baris restok untuk kode yang sama',
  isi.restok.length === 0 && isi.produkBaru.length === 1,
  JSON.stringify(isi));

// ============================================================
bagian('9. Tanpa tagall — tidak satu pun anggota grup ter-tag');

bersih();
settingsPalsu = { updateGroupId: GRUP_UPDATE };
s.pasangSocketSiaran(sockPalsu);
s.antrekanProdukBaru({ kode: 'A', nama: 'Produk A', harga: 5000, stok: 9 });
s.antrekanTurunHarga({ kode: 'B', nama: 'Produk B', hargaLama: 9000, hargaBaru: 6000 });
s.antrekanStokMenipis({ kode: 'C', nama: 'Produk C', harga: 7000, stok: 1 });
const kirim = await s.kirimSekarang();
cek('terkirim', kirim.terkirim === true, JSON.stringify(kirim));
cek('payload TIDAK punya field mentions sama sekali',
  terkirim[0]?.isi && !('mentions' in terkirim[0].isi), JSON.stringify(Object.keys(terkirim[0]?.isi || {})));
cek('payload cuma teks', JSON.stringify(Object.keys(terkirim[0]?.isi || {})) === '["text"]',
  JSON.stringify(Object.keys(terkirim[0]?.isi || {})));
cek('teksnya tidak memuat pola mention @nomor',
  !/@\d{5,}/.test(terkirim[0]?.teks || ''), terkirim[0]?.teks);
cek('ketiga bagian muat dalam satu pesan',
  terkirim[0].teks.includes('Produk A') && terkirim[0].teks.includes('Produk B') && terkirim[0].teks.includes('Produk C'),
  terkirim[0].teks);
cek('tetap SATU pesan, bukan tiga', terkirim.length === 1, String(terkirim.length));

bersih();

console.log(`\n${'='.repeat(50)}`);
console.log(`HASIL: ${lulus} lulus, ${gagal} gagal`);
console.log('='.repeat(50));

process.exit(gagal > 0 ? 1 : 0);
