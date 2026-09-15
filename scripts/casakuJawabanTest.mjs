/**
 * UJI PENGURAI JAWABAN CASAKU
 *
 * Menjaga satu bug yang mematikan SELURUH jalur uang toko ini tanpa suara.
 *
 * Casaku membungkus jawabannya:
 *
 *     { "status": 200, "data": { "transactionId": "...", "qr_string": "..." } }
 *
 * Kode lama membaca `res.data.transactionId` — satu tingkat terlalu dangkal.
 * Akibatnya, saat Casaku menjawab 200 dengan QRIS yang benar-benar sah, bot
 * melemparnya sebagai galat berbunyi "Casaku API error (200)" dan membatalkan
 * pesanan pelanggan. Pada 15 September 2026 kejadian itu terekam apa adanya di
 * log owner: jawaban sukses lengkap dengan qr_string dan payment_url, ditolak.
 *
 * Bug keduanya lebih dalam lagi: `checkCasakuStatus` memulangkan amplopnya,
 * sehingga pemanggil yang memeriksa `statusData.status === 'paid'` sebenarnya
 * membandingkan ANGKA 200 dengan string 'paid'. Rekonsiliasi karena itu tidak
 * pernah bisa menemukan pembayaran yang sudah lunas — dan karena bot ini jalan
 * di laptop rumah tanpa domain (webhook masuk mustahil), penarikan status
 * berkala adalah satu-satunya cara uang dibukukan.
 *
 * Seluruh contoh JSON di bawah DISALIN APA ADANYA dari log owner.
 *
 * Pakai:
 *   node scripts/casakuJawabanTest.mjs
 *
 * Tidak menyentuh jaringan, database, atau sesi WhatsApp.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const AKAR = path.resolve(import.meta.dirname, '..');
const REPO = pathToFileURL(AKAR).href + '/';

let lulus = 0;
let gagal = 0;
function cek(nama, kondisi, detail = '') {
  if (kondisi) { lulus++; console.log(`  OK    ${nama}`); }
  else { gagal++; console.log(`  GAGAL ${nama}${detail !== '' ? ' -> ' + detail : ''}`); }
}
const bagian = (j) => console.log(`\n== ${j} ==`);

// ── Jawaban sungguhan dari Casaku, disalin dari log 15 September 2026 ────────

const SUKSES = {
  status: 200,
  data: {
    transactionId: 'ORD-7300c7d6-a345-4da1-b08d-ccf32a73b723',
    originalAmount: 35000,
    totalAmount: 35000,
    uniqueNominal: 0,
    useUniqueCode: true,
    packageIds: ['id.dana'],
    expiredInMinutes: 15,
    qrType: 'dynamic',
    paymentMethod: 'qris',
    useQris: true,
    qr_string: '00020101021226570011ID.DANA.WWW011893600915300025313902090002531390303UMI51440014ID.CO.QRIS.WWW0215ID10254666221110303UMI520450455303360540835000.005802ID5911Akbar Store600434926105251256304AF69',
    status: 'pending',
    payment_url: 'https://pay.casaku.id/pay?trx=ORD-7300c7d6-a345-4da1-b08d-ccf32a73b723'
  }
};

const LISTENER_OFFLINE = {
  status: 403,
  message: 'Tidak dapat membuat transaksi karena aplikasi listener sedang offline. Buka aplikasi Casaku di HP Anda.'
};

const BELUM_LANGGANAN = {
  status: 403,
  message: 'Silakan langganan di https://casaku.id/pricing'
};

// Modul memakai https sungguhan, jadi casakuRequest dicegat lewat https.request.
const https = await import('https');
const aslinya = https.default.request;

let jawabanBerikutnya = { http: 200, body: SUKSES };

https.default.request = function (options, cb) {
  const pendengar = {};
  const res = {
    statusCode: jawabanBerikutnya.http,
    on(ev, fn) { pendengar[ev] = fn; return res; }
  };
  const req = {
    on() { return req; },
    setTimeout() { return req; },
    write() { return req; },
    end() {
      setImmediate(() => {
        cb(res);
        if (pendengar.data) pendengar.data(JSON.stringify(jawabanBerikutnya.body));
        if (pendengar.end) pendengar.end();
      });
      return req;
    },
    destroy() { return req; }
  };
  return req;
};

process.env.CASAKU_LICENSE_KEY ||= 'uji-bukan-kunci-sungguhan';
process.env.CASAKU_QRIS_ID ||= 'UJI-QRIS-ID';

const casaku = await import(REPO + 'src/payment/casakuProvider.js');

console.log('\n╔══════════════════════════════════════════════════════╗');
console.log('║  UJI PENGURAI JAWABAN CASAKU                         ║');
console.log('╚══════════════════════════════════════════════════════╝');

// ============================================================
bagian('1. Jawaban SUKSES yang dulu ditolak');

jawabanBerikutnya = { http: 200, body: SUKSES };
let hasil = null;
let lemparan = null;
try { hasil = await casaku.createCasakuQris({ orderId: 'ORD-UJI', subtotal: 35000 }); }
catch (e) { lemparan = e; }

cek('tidak dilempar sebagai galat', lemparan === null, lemparan?.message);
cek('transactionId terbaca dari dalam bungkus',
  hasil?.transactionId === 'ORD-7300c7d6-a345-4da1-b08d-ccf32a73b723', String(hasil?.transactionId));
cek('qr_string terbaca', String(hasil?.qrString || '').startsWith('00020101'), String(hasil?.qrString).slice(0, 20));
cek('nominal yang harus dibayar terbaca', hasil?.totalAmount === 35000, String(hasil?.totalAmount));
cek('kode unik terbaca dari uniqueNominal', hasil?.uniqueCode === 0, String(hasil?.uniqueCode));
cek('payment_url ikut terbawa', String(hasil?.paymentUrl || '').includes('pay.casaku.id'), String(hasil?.paymentUrl));
cek('masa berlaku terisi', Number(hasil?.expiredAt) > Date.now(), String(hasil?.expiredAt));

// ============================================================
bagian('2. Aplikasi Casaku di HP offline — HTTP 200 tapi isinya 403');

jawabanBerikutnya = { http: 200, body: LISTENER_OFFLINE };
lemparan = null;
try { await casaku.createCasakuQris({ orderId: 'ORD-UJI-2', subtotal: 35000 }); }
catch (e) { lemparan = e; }

cek('tetap ditolak walau HTTP-nya 200', lemparan !== null);
cek('pesannya menyuruh buka aplikasi di HP',
  /buka aplikasi casaku di hp/i.test(lemparan?.message || ''), lemparan?.message);
cek('pesannya bukan tumpahan JSON', !String(lemparan?.message).includes('{'), lemparan?.message);

// ============================================================
bagian('3. Langganan belum aktif');

jawabanBerikutnya = { http: 403, body: BELUM_LANGGANAN };
lemparan = null;
try { await casaku.createCasakuQris({ orderId: 'ORD-UJI-3', subtotal: 35000 }); }
catch (e) { lemparan = e; }

cek('ditolak', lemparan !== null);
cek('pesannya menyebut langganan', /langganan/i.test(lemparan?.message || ''), lemparan?.message);
cek('pesannya menyebut alamat perpanjangannya',
  String(lemparan?.message).includes('casaku.id/pricing'), lemparan?.message);

// ============================================================
bagian('4. Sukses tapi tanpa qr_string tetap ditolak');

jawabanBerikutnya = { http: 200, body: { status: 200, data: { transactionId: 'ORD-TANPA-QR' } } };
lemparan = null;
try { await casaku.createCasakuQris({ orderId: 'ORD-UJI-4', subtotal: 1000 }); }
catch (e) { lemparan = e; }
cek('transaksi tanpa qr_string ditolak', lemparan !== null, 'lolos padahal tidak ada QR');
cek('pesannya menyebut qr_string', /qr_string/i.test(lemparan?.message || ''), lemparan?.message);

// ============================================================
bagian('5. checkCasakuStatus memulangkan ISI, bukan amplop');

jawabanBerikutnya = { http: 200, body: { status: 200, data: { status: 'paid', amount: 35000 } } };
const st = await casaku.checkCasakuStatus('ORD-UJI');
cek('status terbaca "paid", bukan angka 200', st?.status === 'paid', JSON.stringify(st));
cek('perbandingan yang dipakai paymentService cocok', st?.status === 'paid');
cek('nominalnya ikut terbawa', st?.amount === 35000, String(st?.amount));

// Bentuk tanpa bungkus harus tetap jalan — endpoint lain belum tentu membungkus.
jawabanBerikutnya = { http: 200, body: { status: 'pending' } };
const st2 = await casaku.checkCasakuStatus('ORD-UJI');
cek('bentuk tanpa bungkus tetap terbaca', st2?.status === 'pending', JSON.stringify(st2));

// Status yang belum lunas TIDAK boleh terbaca sebagai lunas.
jawabanBerikutnya = { http: 200, body: { status: 200, data: { status: 'expired' } } };
const st3 = await casaku.checkCasakuStatus('ORD-UJI');
cek('expired tidak dianggap lunas', st3?.status === 'expired' && st3?.status !== 'paid', JSON.stringify(st3));

// ============================================================
bagian('6. Galat check-status tetap dilempar');

jawabanBerikutnya = { http: 200, body: LISTENER_OFFLINE };
lemparan = null;
try { await casaku.checkCasakuStatus('ORD-UJI'); } catch (e) { lemparan = e; }
cek('isi 403 dilempar walau HTTP 200', lemparan !== null);
cek('pesannya tetap bisa ditindaklanjuti',
  /buka aplikasi casaku di hp/i.test(lemparan?.message || ''), lemparan?.message);

https.default.request = aslinya;

console.log('\n════════════════════════════════════════');
console.log(`Pemeriksaan : ${lulus + gagal}`);
console.log(`Lulus       : ${lulus}`);
console.log(`Gagal       : ${gagal}`);
console.log('════════════════════════════════════════');
process.exit(gagal ? 1 : 0);
