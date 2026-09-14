/**
 * UJI ASAP SALDO DEPOSIT (PERINTAH OWNER)
 *
 * Menguji satu-satunya jalur di bot ini yang bisa MENCETAK saldo dari nol.
 * Setiap pengaman diuji terpisah, dan setiap kegagalan diuji dengan memeriksa
 * saldo SESUDAHNYA — bukan cuma pesan balasannya. Pesan boleh berbohong; angka
 * di database tidak.
 *
 * Pakai:
 *   node scripts/saldoAdminSmokeTest.mjs
 *
 * KEAMANAN: skrip pindah ke direktori sementara SEBELUM memuat lapisan database,
 * karena `connection.js` membuka './shop.db' relatif terhadap direktori kerja.
 * Tanpa itu, uji ini akan mengubah SALDO SUNGGUHAN di database pemilik bot.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';

const AKAR = path.resolve(import.meta.dirname, '..');
const REPO = pathToFileURL(AKAR).href + '/';

const kotakPasir = fs.mkdtempSync(path.join(os.tmpdir(), 'saldo-uji-'));
process.chdir(kotakPasir);
console.log(`Kotak pasir: ${kotakPasir}`);

process.env.JWT_SECRET ||= 'uji-asap-bukan-rahasia-sungguhan';
process.env.ADMIN_USER ||= 'ujiasap';
process.env.ADMIN_PASSWORD_HASH ||= '$2b$10$0000000000000000000000000000000000000000000000000000';

// Impor HARUS sesudah chdir.
const db = await import(REPO + 'database.js');
const { handleSaldoOwner, resetSesiSaldo, jumlahSesiSaldo } =
  await import(REPO + 'src/handlers/saldoAdmin.js');

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
const teksTerakhir = () => (terkirim.length ? terkirim[terkirim.length - 1].teks : '');
const kirimKe = (jid) => terkirim.filter(t => t.tujuan === jid);

const OWNER = '628111000001@s.whatsapp.net';
const BUKAN_OWNER = '628222000002@s.whatsapp.net';
const PEMBELI = '628333000003@lid';
const CHAT = OWNER;

/** Panggil handler persis seperti groupAdminHandler memanggilnya. */
const jalankan = (teks, pengirim = OWNER) => {
  const args = teks.trim().split(/\s+/);
  const cleanCmd = args[0].replace(/^[./#]/, '').toLowerCase();
  return handleSaldoOwner({ sock, jid: CHAT, senderNumber: pengirim, args, cleanCmd });
};

const saldoDari = (jid) => db.getCustomerBalance(jid);

/** Ambil kode konfirmasi dari pesan rincian terakhir. */
const ambilKode = () => {
  const cocok = teksTerakhir().match(/\.saldook ([A-Z2-9]{5})/);
  return cocok ? cocok[1] : null;
};

// Owner ditetapkan lewat tabel settings, sama seperti bot sungguhan.
await db.runQuery("INSERT OR REPLACE INTO settings (key, value) VALUES ('ownerNumber', ?)", [OWNER]);
await db.runQuery("INSERT OR REPLACE INTO settings (key, value) VALUES ('ownerJid', ?)", [OWNER]);

await db.getOrCreateCustomer(PEMBELI, 'Pembeli Uji');
await db.getOrCreateCustomer(BUKAN_OWNER, 'Bukan Owner');

// ============================================================
bagian('1. Gerbang owner');

// Cache settings di userDb punya TTL; pastikan terbaca lebih dulu.
const setelan = await db.getSettings();
cek('ownerNumber terbaca dari settings', setelan.ownerNumber === OWNER, String(setelan.ownerNumber));

terkirim.length = 0;
await jalankan('.isisaldo ' + PEMBELI + ' 50000', BUKAN_OWNER);
cek('bukan owner ditolak', teksTerakhir().includes('hanya untuk *Owner*'), teksTerakhir().slice(0, 60));
cek('saldo tidak berubah sedikit pun', (await saldoDari(PEMBELI)) === 0, await saldoDari(PEMBELI));

for (const perintah of ['.tariksaldo', '.ceksaldo', '.totalsaldo', '.saldook']) {
  terkirim.length = 0;
  await jalankan(`${perintah} ${PEMBELI} 1000 alasan`, BUKAN_OWNER);
  cek(`${perintah} juga ditolak untuk bukan owner`, teksTerakhir().includes('hanya untuk *Owner*'));
}

terkirim.length = 0;
await jalankan('.totalsaldo', OWNER);
cek('owner diterima', teksTerakhir().includes('SALDO PELANGGAN YANG DIPEGANG TOKO'), teksTerakhir().slice(0, 60));

// ============================================================
bagian('2. Identitas: tidak menebak, tidak membuat akun hantu');

terkirim.length = 0;
await jalankan('.isisaldo 628999888777 50000');
cek('nomor tak dikenal ditolak', teksTerakhir().includes('tidak dikenali'), teksTerakhir().slice(0, 70));

const sebelumHantu = await db.getQuery("SELECT COUNT(*) n FROM customers");
terkirim.length = 0;
await jalankan('.isisaldo 628999888777@lid 50000');
cek('JID yang belum terdaftar ditolak', teksTerakhir().includes('belum terdaftar'), teksTerakhir().slice(0, 70));
const sesudahHantu = await db.getQuery("SELECT COUNT(*) n FROM customers");
cek('tidak ada baris pelanggan baru yang dibuat', sebelumHantu.n === sesudahHantu.n, `${sebelumHantu.n} -> ${sesudahHantu.n}`);

// ============================================================
bagian('3. Konfirmasi wajib — perintah saja tidak mengubah apa pun');

resetSesiSaldo();
terkirim.length = 0;
await jalankan(`.isisaldo ${PEMBELI} 100rb`);
cek('bot meminta konfirmasi', teksTerakhir().includes('KONFIRMASI TAMBAH SALDO'));
cek('nama pelanggan ikut ditampilkan', teksTerakhir().includes('Pembeli Uji'));
cek('saldo sesudah ditampilkan', teksTerakhir().includes('Saldo jadi'));
cek('saldo BELUM berubah', (await saldoDari(PEMBELI)) === 0, await saldoDari(PEMBELI));
cek('ada satu permintaan tertunda', jumlahSesiSaldo() === 1, jumlahSesiSaldo());

const kodeBenar = ambilKode();
cek('kode konfirmasi tercetak', Boolean(kodeBenar), String(kodeBenar));

terkirim.length = 0;
await jalankan('.saldook SALAH');
cek('kode salah ditolak', teksTerakhir().includes('Kode konfirmasi salah'));
cek('saldo tetap nol setelah kode salah', (await saldoDari(PEMBELI)) === 0, await saldoDari(PEMBELI));
cek('permintaan masih tertunda', jumlahSesiSaldo() === 1);

terkirim.length = 0;
await jalankan(`.saldook ${kodeBenar}`);
cek('kode benar dieksekusi', teksTerakhir().includes('SALDO DITAMBAHKAN') || kirimKe(CHAT).some(t => t.teks.includes('SALDO DITAMBAHKAN')));
cek('saldo bertambah TEPAT 100.000', (await saldoDari(PEMBELI)) === 100000, await saldoDari(PEMBELI));
cek('pelanggan diberi tahu', kirimKe(PEMBELI).some(t => t.teks.includes('SALDO DEPOSIT ANDA BERTAMBAH')));

// ============================================================
bagian('4. Kode sekali pakai');

terkirim.length = 0;
await jalankan(`.saldook ${kodeBenar}`);
cek('kode yang sama ditolak kedua kali', teksTerakhir().includes('Tidak ada permintaan'));
cek('saldo TIDAK bertambah dua kali', (await saldoDari(PEMBELI)) === 100000, await saldoDari(PEMBELI));
cek('tidak ada sisa permintaan', jumlahSesiSaldo() === 0);

// ============================================================
bagian('5. Permintaan baru membatalkan yang lama');

resetSesiSaldo();
await jalankan(`.isisaldo ${PEMBELI} 10000`);
const kodeLama = ambilKode();
terkirim.length = 0;
await jalankan(`.isisaldo ${PEMBELI} 20000`);
const kodeBaru = ambilKode();
cek('kode barunya berbeda', kodeLama !== kodeBaru, `${kodeLama} / ${kodeBaru}`);
cek('bot memberitahu yang lama dibatalkan', teksTerakhir().includes('dibatalkan dan diganti'));

terkirim.length = 0;
await jalankan(`.saldook ${kodeLama}`);
cek('kode lama tidak berlaku lagi', teksTerakhir().includes('Kode konfirmasi salah'));
cek('saldo belum berubah', (await saldoDari(PEMBELI)) === 100000, await saldoDari(PEMBELI));

await jalankan(`.saldook ${kodeBaru}`);
cek('kode baru memakai nominal yang BARU (20.000)', (await saldoDari(PEMBELI)) === 120000, await saldoDari(PEMBELI));

// ============================================================
bagian('6. Pembacaan nominal');

resetSesiSaldo();
for (const [teks, harap] of [['50rb', 50000], ['50.000', 50000], ['12,5rb', 12500], ['1jt', 1000000]]) {
  terkirim.length = 0;
  await jalankan(`.isisaldo ${PEMBELI} ${teks}`);
  const cocok = teksTerakhir().includes(`*Rp${harap.toLocaleString('id-ID')}*`);
  cek(`"${teks}" dibaca sebagai Rp${harap.toLocaleString('id-ID')}`, cocok, teksTerakhir().slice(0, 90));
}

resetSesiSaldo();
terkirim.length = 0;
await jalankan(`.isisaldo ${PEMBELI} abc`);
cek('nominal ngawur ditolak', teksTerakhir().includes('tidak terbaca'));
terkirim.length = 0;
await jalankan(`.isisaldo ${PEMBELI} 2000000000`);
cek('di atas 1 miliar ditolak', teksTerakhir().includes('terlalu besar'));
cek('tidak ada yang tertunda setelah nominal ditolak', jumlahSesiSaldo() === 0);

// ============================================================
bagian('7. Penarikan: wajib beralasan, tidak boleh minus');

resetSesiSaldo();
const saldoSebelumTarik = await saldoDari(PEMBELI);
terkirim.length = 0;
await jalankan(`.tariksaldo ${PEMBELI} 10000`);
cek('penarikan tanpa alasan ditolak', teksTerakhir().includes('wajib disertai alasan'));
cek('tidak ada yang tertunda', jumlahSesiSaldo() === 0);

terkirim.length = 0;
await jalankan(`.tariksaldo ${PEMBELI} 999999999 kebanyakan`);
cek('menarik melebihi saldo ditolak', teksTerakhir().includes('tidak cukup'), teksTerakhir().slice(0, 70));
cek('saldo utuh', (await saldoDari(PEMBELI)) === saldoSebelumTarik, await saldoDari(PEMBELI));

terkirim.length = 0;
await jalankan(`.tariksaldo ${PEMBELI} 20rb salah input nominal`);
cek('penarikan sah minta konfirmasi', teksTerakhir().includes('KONFIRMASI TARIK SALDO'));
cek('alasan ikut ditampilkan', teksTerakhir().includes('salah input nominal'));
const kodeTarik = ambilKode();

terkirim.length = 0;
await jalankan(`.saldook ${kodeTarik}`);
cek('saldo berkurang tepat 20.000', (await saldoDari(PEMBELI)) === saldoSebelumTarik - 20000, await saldoDari(PEMBELI));
cek('pelanggan diberi tahu koreksinya', kirimKe(PEMBELI).some(t => t.teks.includes('KOREKSI SALDO DEPOSIT')));
cek('alasannya ikut terkirim ke pelanggan', kirimKe(PEMBELI).some(t => t.teks.includes('salah input nominal')));

// ============================================================
bagian('8. Jejak audit jujur');

const jejak = await db.riwayatSaldo(PEMBELI, 20);
cek('ada catatan penambahan manual', jejak.some(r => r.type === 'DEPOSIT_MANUAL'), jejak.map(r => r.type).join(','));
cek('penarikan dicatat ADJUSTMENT, bukan PURCHASE', jejak.some(r => r.type === 'ADJUSTMENT'), jejak.map(r => r.type).join(','));
cek('tidak ada penarikan yang menyamar jadi pembelian', !jejak.some(r => r.type === 'PURCHASE'), jejak.map(r => r.type).join(','));
const barisTarik = jejak.find(r => r.type === 'ADJUSTMENT');
cek('siapa yang melakukannya ikut tercatat', String(barisTarik?.source || '').startsWith('OWNER:'), String(barisTarik?.source));
cek('alasannya ikut tersimpan', String(barisTarik?.description || '').includes('salah input nominal'), String(barisTarik?.description));

// ============================================================
bagian('9. Saldo tidak akan pernah minus');

const saldoKini = await saldoDari(PEMBELI);
const tarikLangsung = await db.tarikSaldoOwner(PEMBELI, saldoKini + 1, 'coba bikin minus', OWNER);
cek('tarikSaldoOwner menolak melebihi saldo', tarikLangsung.success === false, JSON.stringify(tarikLangsung));
cek('saldo tetap utuh', (await saldoDari(PEMBELI)) === saldoKini, await saldoDari(PEMBELI));

const habis = await db.tarikSaldoOwner(PEMBELI, saldoKini, 'kosongkan', OWNER);
cek('boleh menarik PAS sejumlah saldonya', habis.success === true && habis.newBalance === 0, JSON.stringify(habis));
cek('nominal nol ditolak', (await db.tarikSaldoOwner(PEMBELI, 0, 'nol', OWNER)).success === false);
cek('nominal minus ditolak', (await db.tarikSaldoOwner(PEMBELI, -5000, 'minus', OWNER)).success === false);
cek('saldo berhenti di nol, tidak minus', (await saldoDari(PEMBELI)) === 0, await saldoDari(PEMBELI));

// ============================================================
bagian('10. Laporan total');

await db.addCustomerBalance(PEMBELI, 75000, 'DEPOSIT_MANUAL', 'uji total');
const ringkas = await db.totalSaldoPelanggan();
cek('total mencakup saldo pelanggan', ringkas.total >= 75000, ringkas.total);
cek('jumlah pemilik saldo dihitung', ringkas.jumlahPemilik >= 1, ringkas.jumlahPemilik);
cek('daftar teratas terisi', ringkas.teratas.length >= 1, ringkas.teratas.length);

terkirim.length = 0;
await jalankan(`.ceksaldo ${PEMBELI}`);
cek('.ceksaldo menampilkan saldo', teksTerakhir().includes('SALDO PELANGGAN'));
cek('.ceksaldo menampilkan riwayat', teksTerakhir().includes('perubahan terakhir'));

console.log(`\n${'='.repeat(50)}`);
console.log(`HASIL: ${lulus} lulus, ${gagal} gagal`);
console.log('='.repeat(50));

try {
  fs.rmSync(kotakPasir, { recursive: true, force: true });
} catch {
  // Berkas database kadang masih terkunci di Windows; biarkan OS yang menyapu.
}

process.exit(gagal > 0 ? 1 : 0);
