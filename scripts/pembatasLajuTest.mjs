/**
 * UJI PEMBATAS LAJU & TANGGA TIER PREMIUM
 *
 * Dua hal yang diminta owner: "kasih aja limit buat downloader dll" dan "kalau
 * mau naik premium minimal 3k".
 *
 * Yang dijaga di sini:
 *   • Rem semburan benar-benar menahan, dan peringatannya TIDAK ikut jadi spam.
 *   • Jendelanya geser, bukan ember per menit — celah "habiskan di detik 59,
 *     habiskan lagi di detik 61" tidak boleh ada.
 *   • Tangga tier naik terus: harga, jatah unduhan, jatah AI, laju.
 *   • Perunggu Rp3.000 benar-benar paket termurah.
 *
 * Murni memori dan objek; tidak menyentuh database maupun WhatsApp.
 *
 * Pakai:
 *   node scripts/pembatasLajuTest.mjs
 */
import path from 'path';
import { pathToFileURL } from 'url';

const AKAR = path.resolve(import.meta.dirname, '..');
const REPO = pathToFileURL(AKAR).href + '/';

process.env.JWT_SECRET ||= 'uji-asap-bukan-rahasia-sungguhan';
process.env.ADMIN_USER ||= 'ujiasap';
process.env.ADMIN_PASSWORD_HASH ||= '$2b$10$0000000000000000000000000000000000000000000000000000';

const L = await import(REPO + 'src/utils/pembatasLaju.js');
const { PREMIUM_TIERS, getPremiumBenefits } = await import(REPO + 'premiumHandler.js');

let lulus = 0, gagal = 0;
function cek(nama, kondisi, detail = '') {
  if (kondisi) { lulus++; console.log(`  OK    ${nama}`); }
  else { gagal++; console.log(`  GAGAL ${nama}${detail !== '' ? ' -> ' + detail : ''}`); }
}
const bagian = (j) => console.log(`\n== ${j} ==`);

const T0 = 1_700_000_000_000;

// ============================================================
bagian('1. Rem semburan menahan pada hitungan yang benar');

L.kosongkanJejak();
const JID = '628111@s.whatsapp.net';

let hasil;
for (let i = 1; i <= 8; i++) {
  hasil = L.periksaLaju(JID, 8, T0 + i * 100);
  if (i < 8) cek(`perintah ke-${i} lolos`, hasil.boleh === true, JSON.stringify(hasil));
}
cek('perintah ke-8 (tepat di batas) masih lolos', hasil.boleh === true, JSON.stringify(hasil));
cek('sisa jatah jadi nol', hasil.sisa === 0, String(hasil.sisa));

const ke9 = L.periksaLaju(JID, 8, T0 + 900);
cek('perintah ke-9 DITOLAK', ke9.boleh === false, JSON.stringify(ke9));
cek('diberi tahu berapa detik lagi', ke9.tungguDetik > 0 && ke9.tungguDetik <= 60, String(ke9.tungguDetik));
cek('penolakan pertama memang diberi tahu', ke9.perluBeriTahu === true);

// Peringatannya sendiri tidak boleh jadi spam.
const ke10 = L.periksaLaju(JID, 8, T0 + 1000);
const ke11 = L.periksaLaju(JID, 8, T0 + 1100);
cek('penolakan kedua TIDAK diberi tahu lagi', ke10.perluBeriTahu === false, JSON.stringify(ke10));
cek('penolakan ketiga juga tidak', ke11.perluBeriTahu === false);
cek('tapi tetap ditolak', ke10.boleh === false && ke11.boleh === false);

// ============================================================
bagian('2. Jendelanya GESER, bukan ember per menit');

L.kosongkanJejak();
// Habiskan jatah di awal.
for (let i = 0; i < 8; i++) L.periksaLaju(JID, 8, T0 + i * 100);
cek('masih tertahan pada detik ke-59', L.periksaLaju(JID, 8, T0 + 59_000).boleh === false);

// Ember per menit akan membuka penuh di sini. Jendela geser tidak.
cek('detik ke-61 TIDAK langsung membuka jatah penuh',
  L.periksaLaju(JID, 8, T0 + 61_000).boleh === true, 'yang tertua memang sudah lewat, satu slot terbuka');

L.kosongkanJejak();
for (let i = 0; i < 8; i++) L.periksaLaju(JID, 8, T0 + i * 100);
// Lewat satu jendela penuh sejak yang TERAKHIR: semuanya bebas.
const jauh = L.periksaLaju(JID, 8, T0 + 120_000);
cek('sesudah satu menit penuh hening, jatahnya kembali', jauh.boleh === true && jauh.dipakai === 1,
  JSON.stringify(jauh));

// ============================================================
bagian('3. Batasnya per orang, bukan per bot');

L.kosongkanJejak();
const A = '628111@s.whatsapp.net';
const B = '628222@s.whatsapp.net';
for (let i = 0; i < 8; i++) L.periksaLaju(A, 8, T0 + i * 100);
cek('A tertahan', L.periksaLaju(A, 8, T0 + 900).boleh === false);
cek('B tidak ikut kena', L.periksaLaju(B, 8, T0 + 900).boleh === true);

// ============================================================
bagian('4. Nilai yang tidak masuk akal tidak boleh mengunci siapa pun');

L.kosongkanJejak();
cek('batas 0 = tanpa rem', L.periksaLaju(A, 0, T0).boleh === true);
cek('batas negatif = tanpa rem', L.periksaLaju(A, -5, T0).boleh === true);
cek('batas bukan angka = tanpa rem', L.periksaLaju(A, 'banyak', T0).boleh === true);
cek('jid kosong tidak melempar', L.periksaLaju('', 8, T0).boleh === true);
cek('jid null tidak melempar', L.periksaLaju(null, 8, T0).boleh === true);

// ============================================================
bagian('5. Tangga tier — Perunggu Rp3.000 paket termurah');

const urut = ['Perunggu', 'Silver', 'Gold', 'Diamond'];
cek('Perunggu ada', Boolean(PREMIUM_TIERS.Perunggu));
cek('harganya Rp3.000', PREMIUM_TIERS.Perunggu?.priceRp === 3000, String(PREMIUM_TIERS.Perunggu?.priceRp));
cek('Perunggu termurah dari semua tier',
  Math.min(...Object.values(PREMIUM_TIERS).map(t => t.priceRp)) === 3000);

for (let i = 1; i < urut.length; i++) {
  const bawah = PREMIUM_TIERS[urut[i - 1]];
  const atas = PREMIUM_TIERS[urut[i]];
  cek(`${urut[i]} lebih mahal dari ${urut[i - 1]}`, atas.priceRp > bawah.priceRp,
    `${bawah.priceRp} vs ${atas.priceRp}`);
  cek(`${urut[i]}: jatah unduhan lebih besar`, atas.benefits.mediaDailyLimit > bawah.benefits.mediaDailyLimit);
  cek(`${urut[i]}: jatah AI lebih besar`, atas.benefits.aiDailyLimit > bawah.benefits.aiDailyLimit);
  cek(`${urut[i]}: laju fun lebih besar`, atas.benefits.funPerMinute > bawah.benefits.funPerMinute);
}

// Gratisan harus di bawah tier termurah pada SETIAP sumbu, kalau tidak
// Perunggu tidak punya alasan dibeli sama sekali.
const gratis = getPremiumBenefits('Free');
const perunggu = PREMIUM_TIERS.Perunggu.benefits;
cek('gratisan: jatah unduhan di bawah Perunggu', gratis.mediaDailyLimit < perunggu.mediaDailyLimit,
  `${gratis.mediaDailyLimit} vs ${perunggu.mediaDailyLimit}`);
cek('gratisan: jatah AI di bawah Perunggu', gratis.aiDailyLimit < perunggu.aiDailyLimit);
cek('gratisan: laju fun di bawah Perunggu', gratis.funPerMinute < perunggu.funPerMinute,
  `${gratis.funPerMinute} vs ${perunggu.funPerMinute}`);
// Angka yang dipilih owner sendiri (16 Sep 2026): 7, bukan 8. Dipatok di sini
// supaya tidak diam-diam bergeser lagi tanpa ada yang memutuskan.
cek('laju gratisan dipatok 7 per menit', gratis.funPerMinute === 7, String(gratis.funPerMinute));
cek('gratisan: jeda unduhan lebih lama', gratis.mediaCooldownSec > perunggu.mediaCooldownSec);

// Perunggu tidak boleh mematikan Silver yang harganya hampir dua kali lipat.
cek('diskon belanja tetap milik Silver ke atas',
  perunggu.shopDiscountPct === 0 && PREMIUM_TIERS.Silver.benefits.shopDiscountPct > 0);
cek('akses reseller tetap milik Silver ke atas',
  perunggu.resellerAccess === false && PREMIUM_TIERS.Silver.benefits.resellerAccess === true);

// Setiap tier wajib punya semua sumbu yang dibaca kode pemanggil.
for (const [nama, t] of Object.entries(PREMIUM_TIERS)) {
  for (const kunci of ['aiDailyLimit', 'mediaDailyLimit', 'mediaCooldownSec', 'funPerMinute']) {
    cek(`${nama} punya ${kunci}`, Number.isFinite(Number(t.benefits[kunci])),
      String(t.benefits[kunci]));
  }
}
for (const kunci of ['aiDailyLimit', 'mediaDailyLimit', 'mediaCooldownSec', 'funPerMinute']) {
  cek(`gratisan punya ${kunci}`, Number.isFinite(Number(gratis[kunci])), String(gratis[kunci]));
}

// Tier yang tidak dikenal harus jatuh ke gratisan, bukan ke undefined yang
// nantinya jadi `undefined >= batas` dan meloloskan semua orang.
const asing = getPremiumBenefits('TierKarangan');
cek('tier tak dikenal jatuh ke jatah gratisan', asing.mediaDailyLimit === gratis.mediaDailyLimit);
cek('dan lajunya juga', asing.funPerMinute === gratis.funPerMinute);

console.log(`\n${'='.repeat(50)}`);
console.log(`HASIL: ${lulus} lulus, ${gagal} gagal`);
console.log('='.repeat(50));

process.exit(gagal > 0 ? 1 : 0);
