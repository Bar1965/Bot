/**
 * KATALOG KARTU ARENA MONSTER
 *
 * ============================================================
 * ATURAN INTI: ANGGARAN DAYA
 * ============================================================
 * Di mesin duel ini yang menentukan menang-kalah bukan ATK saja dan bukan HP
 * saja, melainkan HASIL KALI keduanya. A mengalahkan B tepat ketika
 * HP_A/ATK_B > HP_B/ATK_A, yang identik dengan ATK_A x HP_A > ATK_B x HP_B.
 *
 * Karena itu tiap rarity diberi satu ANGGARAN DAYA (`daya` di STAT_RARITY), dan
 * tiap kartu bebas membelanjakannya sesuka hati antara ATK, HP, dan KRITIS
 * selama hasil kalinya tetap di anggaran. Itulah sebabnya 60 kartu bisa punya
 * 60 angka yang berbeda tanpa satu pun yang secara mentah lebih kuat.
 *
 * `periksaKeseimbangan()` di bawah menjaga janji itu: kalau ada kartu yang
 * meleset lebih dari TOLERANSI_DAYA dari anggarannya, peringatan muncul di
 * konsol saat bot menyala. Jalankan `node scripts/tcgBalance.mjs` setiap kali
 * kamu mengubah angka — jangan pernah menebak.
 *
 * ============================================================
 * KENAPA DULU TERASA DATAR
 * ============================================================
 * Versi sebelumnya menghitung stat dari rarity x peran, dan cuma ada 5 peran.
 * Akibatnya 46 kartu hanya menghasilkan 23 profil stat: empat Common berbagi
 * 130/385, empat lagi berbagi 150/335, tiga berbagi 75/670. Pemain
 * menanyakannya langsung di grup: "apa cuma raritynya aja?".
 *
 * Sekarang ATK, HP, dan KRITIS ditulis satu per satu di tiap baris katalog.
 * Peran tidak lagi menjadi sumber angka — ia diturunkan DARI angka (lihat
 * `getPeran`), jadi tetap muncul sebagai label yang membantu pemain membaca
 * kartu, tapi tidak lagi memaksa kartu-kartu jadi kembar.
 */

// --- Roda elemen: tiap elemen mengungguli dua, dikalahkan dua ---
export const ELEMEN = {
  API:   { nama: 'Api',   emoji: '🔥', unggul: ['ANGIN', 'DARK'] },
  ANGIN: { nama: 'Angin', emoji: '🍃', unggul: ['DARK', 'AIR'] },
  DARK:  { nama: 'Dark',  emoji: '🌑', unggul: ['AIR', 'PETIR'] },
  AIR:   { nama: 'Air',   emoji: '💧', unggul: ['PETIR', 'API'] },
  PETIR: { nama: 'Petir', emoji: '⚡', unggul: ['API', 'ANGIN'] }
};

/**
 * Ayunan elemen 1,13/0,89 — selisih unggul vs lemah = 1,27x.
 *
 * Perjalanan angka ini: 1,35/0,75 (ayunan 1,80x) membuat pemain berkata "Ah
 * menang ele", lalu diturunkan ke 1,20/0,85 (1,41x). Simulasi menunjukkan 1,41x
 * MASIH terlalu besar, dan bukti paling telak datang dari memisahkan pertemuan
 * serarity menjadi dua kelompok:
 *
 *   elemen netral   55 pertemuan   3,6% sudah ditentukan   49,1% seru
 *   ada yg unggul  340 pertemuan  66,8% sudah ditentukan    1,5% seru
 *
 * Artinya stat dan skill sudah sangat seimbang; yang membuat duel diputuskan
 * sebelum ronde pertama adalah undian elemen. Karena pemain TIDAK bisa melihat
 * dek lawan sebelum PvP, undian itu bukan strategi — itu lotre.
 *
 * CATATAN yang dulu salah di berkas ini: pengali elemen hanya menyentuh ATK,
 * bukan HP. Jadi ayunan elemen berlaku penuh pada DAYA — 1,27x sekarang,
 * dibandingkan satu tingkat rarity yang bernilai 1,37x daya. Keunggulan elemen
 * kini bernilai sedikit DI BAWAH satu tingkat rarity: cukup untuk membuat
 * penempatan penting, tidak cukup untuk membatalkan hasil gacha.
 */
export const PENGALI_UNGGUL = 1.13;
export const PENGALI_NETRAL = 1.00;
export const PENGALI_LEMAH = 0.89;

export function pengaliElemen(penyerang, bertahan) {
  if (penyerang === bertahan) return PENGALI_NETRAL;
  if (ELEMEN[penyerang]?.unggul.includes(bertahan)) return PENGALI_UNGGUL;
  if (ELEMEN[bertahan]?.unggul.includes(penyerang)) return PENGALI_LEMAH;
  return PENGALI_NETRAL;
}

// ============================================================
// KRITIS — SUMBU STAT KETIGA
// ============================================================
/**
 * Kritis bukan sekadar hiasan; ia menambal cacat paling besar mesin ini.
 *
 * Varian damage lama cuma +/-10%, sementara satu duel cuma 3-8 pukulan. Varian
 * sekecil itu saling meniadakan sepanjang duel, jadi pihak yang dayanya lebih
 * tinggi menang hampir selalu. Simulasi 1.035 matchup mencatat 76,5% pertemuan
 * praktis SUDAH DITENTUKAN sebelum ronde pertama (satu sisi menang >95%), dan
 * cuma 6,5% yang benar-benar bisa jatuh ke dua arah.
 *
 *   keunggulan daya lawan   ->  peluang menang pihak lebih kuat
 *   +10%  varian +/-10%          99,9%
 *   +10%  kritis 15% x1,75       91,1%
 *
 * Melebarkan varian jadi +/-18% hampir tidak menolong (97,5%) karena tetap
 * meniadakan diri. Kritis menolong karena ia ekor gemuk: satu pukulan kritis
 * memindahkan hasil, tidak dirata-ratakan habis.
 *
 * Kritis DIBAYAR dari anggaran daya. ATK efektif sebuah kartu adalah
 * atk x (1 + 0,75 x kritis), dan HP-nya dipotong supaya hasil kalinya tetap
 * pas. Tanpa aturan ini kartu ber-kritis tinggi jadi lebih kuat secara gratis.
 */
export const KRIT_DMG = 1.75;

// --- Statistik acuan per rarity ---
//
// `atk` dan `hp` di sini BUKAN lagi stat kartu mana pun; keduanya cuma titik
// acuan "kartu Seimbang teoretis" yang dipakai `getPeran` untuk menamai peran,
// dan `daya` = atk x hp adalah anggaran yang wajib dipatuhi setiap kartu.
export const STAT_RARITY = {
  COMMON:    { atk: 100, hp: 500,  daya: 50000,  bintang: 1, label: 'Common' },
  RARE:      { atk: 117, hp: 585,  daya: 68400,  bintang: 2, label: 'Rare' },
  EPIC:      { atk: 137, hp: 690,  daya: 94500,  bintang: 3, label: 'Epic' },
  LEGENDARY: { atk: 161, hp: 805,  daya: 129600, bintang: 4, label: 'Legendary' },
  MYTHIC:    { atk: 190, hp: 950,  daya: 180500, bintang: 5, label: 'Mythic' }
};

export const MAKS_LEVEL = 5;
export const KENAIKAN_PER_LEVEL = 0.08; // +8% ATK & HP tiap level

// ============================================================
// PERAN — SEKARANG LABEL, BUKAN SUMBER ANGKA
// ============================================================
/**
 * Peran dibaca dari rasio ATK kartu terhadap ATK acuan rarity-nya. Membalik
 * arah ini penting: dulu peran MENGHASILKAN stat (5 peran -> 5 profil stat per
 * rarity), sekarang stat menghasilkan peran (60 stat -> label yang cocok).
 *
 * Ambangnya sengaja dibuat lebar supaya nama peran tidak berubah-ubah gara-gara
 * penyetelan angka kecil.
 */
export const PERAN = {
  PENYERGAP: { nama: 'Penyergap', emoji: '⚔️', min: 1.40, teks: 'ATK sangat tinggi, tapi rapuh' },
  PENYERANG: { nama: 'Penyerang', emoji: '🗡️', min: 1.18, teks: 'Agresif, menekan sejak awal' },
  SEIMBANG:  { nama: 'Seimbang',  emoji: '⚖️', min: 0.92, teks: 'Serba bisa, tanpa kelemahan jelas' },
  PETAHAN:   { nama: 'Petahan',   emoji: '🛡️', min: 0.78, teks: 'Tahan lama, menang di ronde panjang' },
  PENJAGA:   { nama: 'Penjaga',   emoji: '🏰', min: 0,    teks: 'Tembok — sangat sulit dijatuhkan' }
};

const URUT_PERAN = ['PENYERGAP', 'PENYERANG', 'SEIMBANG', 'PETAHAN', 'PENJAGA'];

export function getPeran(card) {
  if (!card) return PERAN.SEIMBANG;
  const acuan = STAT_RARITY[card.rarity]?.atk || STAT_RARITY.COMMON.atk;
  const rasio = (card.atk || acuan) / acuan;
  for (const kunci of URUT_PERAN) {
    if (rasio >= PERAN[kunci].min) return PERAN[kunci];
  }
  return PERAN.PENJAGA;
}

/**
 * ATK efektif = ATK yang sudah memperhitungkan sumbangan kritis. Inilah angka
 * yang dipakai untuk mengukur daya, bukan ATK mentah.
 */
export function atkEfektif(atk, kritis = 0) {
  return atk * (1 + (KRIT_DMG - 1) * (kritis || 0));
}

export function statKartu(card, level = 1) {
  const acuan = STAT_RARITY[card?.rarity] || STAT_RARITY.COMMON;
  const lv = Math.max(1, Math.min(MAKS_LEVEL, Math.floor(level) || 1));
  const pengali = Math.pow(1 + KENAIKAN_PER_LEVEL, lv - 1);
  const atk = Math.round((card?.atk || acuan.atk) * pengali);
  const hp = Math.round((card?.hp || acuan.hp) * pengali);
  const kritis = card?.kritis || 0;
  return {
    atk,
    hp,
    kritis,
    level: lv,
    // CP = satu angka pembanding lintas peran. Pemain memintanya sejak awal:
    // "masing masing kartu ada CP tersendiri gitu". Dibagi 100 supaya terbaca
    // (Common Lv.1 ~ 500, Mythic Lv.5 ~ 3.300) alih-alih ratusan ribu.
    cp: Math.round(atkEfektif(atk, kritis) * hp / 100)
  };
}

/** Seluruh tangga Lv.1..Lv.5 sekaligus — dipakai untuk pratinjau naik level. */
export function tanggaLevel(card) {
  const out = [];
  for (let lv = 1; lv <= MAKS_LEVEL; lv++) out.push(statKartu(card, lv));
  return out;
}

export function costKartu(card) {
  if (!card) return 0;
  return STAT_RARITY[card.rarity]?.bintang || 1;
}

// ============================================================
// SKILL — SETIAP KARTU PUNYA SATU
// ============================================================
/**
 * Skill dideskripsikan sebagai DATA, bukan cabang `if` di mesin pertarungan.
 * Mesin membaca field di bawah ini, jadi menambah skill baru cukup menambah
 * satu baris di sini — tidak perlu menyentuh battle.js lagi.
 *
 * Field yang dikenali mesin:
 *   atkBonus     ATK dasar +X
 *   hpBonus      HP maksimal +X
 *   tahan        Damage yang diterima -X
 *   tembus       Abaikan X bagian dari `tahan` lawan
 *   hindar       Peluang X serangan lawan meleset total
 *   duri         Pantulkan X dari damage yang diterima ke penyerang
 *   serap        Pulih X dari HP MAKS SENDIRI tiap kali pukulan mendarat
 *   racun        Lawan kehilangan X HP maksimalnya tiap akhir ronde
 *   regen        Pulih X HP maksimal tiap akhir ronde
 *   setrum       Peluang X membuat lawan kehilangan giliran berikutnya
 *   stabil       Varian damage nyaris hilang, tapi peluang kritis dipotong 50%
 *   waspada      Kebal terhadap bonus `bukaan` milik lawan
 *   bukaan       Serangan pada ronde pertama +X
 *   perisaiAwal  Damage PERTAMA yang diterima -X
 *   ganda        Peluang X menyerang dua kali dalam satu giliran
 *   menumpuk     Damage +X tiap ronde, menumpuk
 *   abaikanLemah Kerugian elemen dinaikkan kembali ke netral
 *   nekat        { ambang, bonus } — damage +bonus saat HP SENDIRI di bawah ambang
 *   penindas     Damage +X terhadap kartu berbintang lebih rendah
 *   kritBonus    Peluang kritis +X
 *   kritDmg      Pengali kritis +X (di atas KRIT_DMG)
 *   antiKrit     Peluang kritis lawan -X
 *   pelemah      Setelah pukulan pertama, ATK lawan -X permanen
 *   eksekusi     Damage +X saat HP LAWAN di bawah 35%
 *   bertahanMati Sekali per duel, selamat di 1 HP dari serangan mematikan
 *
 * -------- CATATAN PENYETELAN (dari turnamen 46 kartu, ~200 duel/pasangan) --------
 * `hindar` adalah efek terkuat per poin di mesin ini: ia membatalkan serangan
 * BESERTA seluruh efek sampingannya (racun, setrum, serap, duri, kritis). Tiap
 * kartu ber-`hindar` menempati puncak pita rarity-nya — Rajawali 46,3% dan Elang
 * 43,9% (dua teratas Rare), Garuda Nusantara 85,3% (teratas Legendary), Burung
 * Angin 30,5% (teratas Common). Semuanya diturunkan.
 *
 * Sebaliknya `nekat` adalah kelas terlemah: bonusnya baru menyala saat kartu
 * sudah kalah, jadi jarang membalikkan keadaan. Amuk (34,4-35,9%) dan Balas
 * Dendam (57,5%) menghuni dasar pita masing-masing. Keduanya dinaikkan, dan
 * ambangnya digeser supaya menyala lebih awal.
 */
export const SKILL = {
  // ---------- Tingkat Common: satu efek pasif kecil ----------
  NALURI_BUAS:    { nama: 'Naluri Buas',    teks: 'ATK dasar +10%',                               atkBonus: 0.10 },
  URAT_BAJA:      { nama: 'Urat Baja',      teks: 'HP maksimal +10%',                             hpBonus: 0.10 },
  KULIT_TEBAL:    { nama: 'Kulit Tebal',    teks: 'Damage yang diterima -10%',                    tahan: 0.10 },
  // 0,16 -> 0,09: dua Common ber-Gesit menempati puncak pita Common.
  GESIT:          { nama: 'Gesit',          teks: '11% peluang menghindari serangan',             hindar: 0.11 },
  DURI_KECIL:     { nama: 'Duri Kecil',     teks: 'Pantulkan 7,5% damage yang diterima',          duri: 0.075 },
  GIGIT_LAPAR:    { nama: 'Gigit Lapar',    teks: 'Pulih 3% HP maks tiap pukulan mendarat',       serap: 0.03 },
  // Waspada praktis mati: ia cuma melawan `bukaan`, yang dimiliki 4 kartu dari
  // 60. Bayang Kecil tercatat 17,2% — terburuk di permainan, 7 poin di bawah
  // Common terlemah berikutnya. Bagian tahannya dinaikkan 0,05 -> 0,09.
  WASPADA:        { nama: 'Waspada',        teks: 'Kebal serangan pembuka, damage diterima -9%',  waspada: true, tahan: 0.09 },
  // `stabil` dulu diam-diam adalah buff damage +4% (varian 0,98-1,10, rata-rata
  // 1,04) padahal teksnya cuma menjanjikan "stabil". Sekarang jujur: varian
  // nyaris nol DAN kritis dipotong separuh, ditebus atkBonus 0,04 -> 0,07.
  BIDIKAN_TENANG: { nama: 'Bidikan Tenang', teks: 'Damage nyaris tanpa varian, ATK +11% (kritis -50%)', stabil: true, atkBonus: 0.11 },
  MATA_TAJAM:     { nama: 'Mata Tajam',     teks: 'Peluang kritis +13%',                          kritBonus: 0.13 },
  CANGKANG_KERAS: { nama: 'Cangkang Keras', teks: 'Peluang kritis lawan -8%, damage diterima -4%', antiKrit: 0.08, tahan: 0.04 },
  SENGAT_KECIL:   { nama: 'Sengat Kecil',   teks: 'Lawan -2% HP maks tiap ronde, ATK +3%',        racun: 0.02, atkBonus: 0.03 },

  // ---------- Tingkat Rare: efek yang sama, tapi bergigi ----------
  BENTENG:        { nama: 'Benteng',        teks: 'Damage yang diterima -14%',                    tahan: 0.14 },
  PEMBUKA:        { nama: 'Pembuka',        teks: 'Ronde pertama +35% damage, ATK +5%',           bukaan: 0.35, atkBonus: 0.05 },
  TAJI_RACUN:     { nama: 'Taji Racun',     teks: 'Lawan kehilangan 4,5% HP maks tiap ronde',     racun: 0.045 },
  PENGISAP:       { nama: 'Pengisap',       teks: 'Pulih 3,8% HP maks tiap pukulan mendarat',     serap: 0.038 },
  SAYAP_ANGIN:    { nama: 'Sayap Angin',    teks: '13% peluang menghindari serangan',             hindar: 0.13 },
  PEMECAH:        { nama: 'Pemecah',        teks: 'Tembus 60% pertahanan lawan, ATK +12%',        tembus: 0.60, atkBonus: 0.12 },
  // <50%/+12% -> <55%/+22%: menyala lebih awal dan benar-benar terasa.
  AMUK:           { nama: 'Amuk',           teks: '+28% damage saat HP di bawah 55%',             nekat: { ambang: 0.55, bonus: 0.28 } },
  SETRUM_KEJUT:   { nama: 'Setrum Kejut',   teks: '14% peluang lawan kehilangan giliran',         setrum: 0.14 },
  TAJI_PATAH:     { nama: 'Taji Patah',     teks: 'ATK lawan -15% setelah pukulan pertama',       pelemah: 0.15 },
  NYALI_TERAKHIR: { nama: 'Nyali Terakhir', teks: 'Sekali per duel, bertahan di 1 HP',            bertahanMati: true },
  INCARAN:        { nama: 'Incaran',        teks: '+38% damage saat HP lawan di bawah 35%',       eksekusi: 0.38 },

  // ---------- Tingkat Epic: efek penentu ----------
  PERISAI_AIR:    { nama: 'Perisai Air',    teks: 'Damage pertama -70%, damage diterima -9%',     perisaiAwal: 0.70, tahan: 0.09 },
  SAMBARAN_GANDA: { nama: 'Sambaran Ganda', teks: '25% peluang menyerang dua kali',               ganda: 0.25 },
  BARA_ABADI:     { nama: 'Bara Abadi',     teks: '+10% damage tiap ronde, menumpuk',             menumpuk: 0.10 },
  // `abaikanLemah` saja adalah skill mati di sekitar 60% pertemuan — ia cuma
  // berguna ketika kartunya sedang rugi elemen. Diberi nilai dasar tetap.
  PUSARAN:        { nama: 'Pusaran',        teks: 'Abaikan kerugian elemen, ATK +13%',            abaikanLemah: true, atkBonus: 0.13 },
  BALAS_DENDAM:   { nama: 'Balas Dendam',   teks: '+48% damage saat HP di bawah 45%',             nekat: { ambang: 0.45, bonus: 0.48 } },
  // regen adalah PERSEN DARI HP MAKS, jadi nilainya meledak di badan bertahan.
  // Naga Rawa (Epic) tercatat 77,5% — di atas dua Legendary. 0,10 -> 0,07.
  PENYEMBUHAN:    { nama: 'Penyembuhan',    teks: 'Pulih 5% HP tiap akhir ronde',                 regen: 0.05 },
  // Mati total di pertemuan serarity, kuat di Menara. Diberi nilai dasar.
  PENINDAS:       { nama: 'Penindas',       teks: '+15% damage lawan berbintang lebih rendah, ATK +23%', penindas: 0.15, atkBonus: 0.23 },
  TAPAK_GUNUNG:   { nama: 'Tapak Gunung',   teks: 'Damage diterima -15%, tembus 40% pertahanan',  tahan: 0.15, tembus: 0.40 },
  RACUN_RIMBA:    { nama: 'Racun Rimba',    teks: 'Lawan -3% HP maks/ronde, pulih 3,5% HP/pukulan', racun: 0.03, serap: 0.035 },
  TARING_GUNTUR:  { nama: 'Taring Guntur',  teks: 'Peluang kritis +12%, kritis 25% lebih keras',  kritBonus: 0.12, kritDmg: 0.25 },
  SELUBUNG_LEAK:  { nama: 'Selubung Leak',  teks: 'Peluang kritis lawan -18%, damage diterima -10%', antiKrit: 0.18, tahan: 0.10 },

  // ---------- Khusus puncak: satu kartu, satu skill ----------
  //
  // Sebelumnya TIGA dari lima Legendary berbagi `PENINDAS`, dan dua dari tiga
  // Mythic memakai skill yang juga dipegang kartu rarity lebih rendah. Kartu
  // paling langka di permainan justru yang paling tidak terasa istimewa.
  // Skill di bawah ini masing-masing hanya dimiliki satu kartu.
  TARIAN_BADAI:   { nama: 'Tarian Badai',   teks: '14% peluang menghindar, ATK +8%',              hindar: 0.14, atkBonus: 0.08 },
  KUTUKAN_RANGDA: { nama: 'Kutukan Rangda', teks: 'Lawan -4,5% HP maks/ronde, damage diterima -7%', racun: 0.045, tahan: 0.07 },
  RAHANG_KALA:    { nama: 'Rahang Kala',    teks: '+65% damage saat HP lawan di bawah 35%, kritis +14%', eksekusi: 0.65, kritBonus: 0.14 },
  LAHAR_PURBA:    { nama: 'Lahar Purba',    teks: 'Damage diterima -18%, sekali bertahan di 1 HP', tahan: 0.18, bertahanMati: true },
  BISA_BLORONG:   { nama: 'Bisa Blorong',   teks: 'Lawan -4% HP maks/ronde dan ATK-nya -12%',     racun: 0.04, pelemah: 0.12 },
  SAYAP_JATAYU:   { nama: 'Sayap Jatayu',   teks: '10% menghindar, pulih 3,5% HP tiap ronde',     hindar: 0.10, regen: 0.035 },
  GLEDEK_SELO:    { nama: 'Gledek Selo',    teks: '21% lawan kehilangan giliran, kritis +12%',    setrum: 0.21, kritBonus: 0.12 },
  // menumpuk BERBUNGA: +12%/ronde jadi +48% di ronde ke-5, dan digabung isap
  // darah 12% membuat Barong Agni 95,1% di turnamen — 7 poin di atas Mythic
  // lain. 10% + 10% menempatkannya sejajar dengan saudara-saudaranya.
  API_SUCI:       { nama: 'Api Suci',       teks: '+11,5% damage tiap ronde, pulih 3,5% HP/pukulan', menumpuk: 0.115, serap: 0.035 },
  MURKA_PETIR:    { nama: 'Murka Petir',    teks: '19% serang dua kali, 15% lawan kehilangan giliran', ganda: 0.19, setrum: 0.15 },
  GERHANA:        { nama: 'Gerhana',        teks: 'Serangan pertama +60% damage, ATK +6%',        bukaan: 0.60, atkBonus: 0.06 },
  // Regen di badan Penjaga: 8% dari 1.185 HP = 95 HP per ronde, lebih besar
  // dari damage rata-rata sebagian besar Common. Turnamen mencatat kartu ini di
  // 96,7% — angka "wajib punya". 5% menahannya tetap tangguh tanpa tak terkalahkan.
  PUSARAN_ABADI:  { nama: 'Pusaran Abadi',  teks: 'Abaikan kerugian elemen, pulih 5% HP/ronde',   abaikanLemah: true, regen: 0.05 },
  SANGKAKALA:     { nama: 'Sangkakala',     teks: 'Ronde pertama +30% damage, 15% menghindar',    bukaan: 0.30, hindar: 0.15 },

  // --- Tiga skill Mythic tambahan (v3.7) ---
  //
  // Sengaja dipilih dari mekanik yang BELUM dipegang satu pun Mythic. Sebelum
  // ini kelima Mythic memakai bukaan, menumpuk, ganda, regen, dan hindar; tidak
  // ada satu pun yang memakai duri, tembus, atau pelemah. Menambah Mythic yang
  // mekaniknya mengulang yang sudah ada cuma menambah panjang katalog, bukan
  // menambah pilihan.
  OTOT_KAWAT:     { nama: 'Otot Kawat',     teks: 'Damage diterima -16%, pantulkan 12% damage',    tahan: 0.16, duri: 0.12 },
  BERKAH_PANEN:   { nama: 'Berkah Panen',   teks: 'Pulih 5,5% HP tiap ronde, +9% damage tiap ronde', regen: 0.055, menumpuk: 0.09 },
  // `tembus` sempat dipakai di sini dan hasilnya buruk: ia hanya mengurangi
  // `tahan` LAWAN, dan sebagian besar kartu tidak punya `tahan` sama sekali,
  // jadi separuh skill ini mati melawan mayoritas katalog. Terukur 38% — jauh di
  // bawah Mythic lain. Racun selalu berlaku, dan lilitan yang memeras napas juga
  // lebih masuk akal untuk naga penyangga bumi daripada menembus baju zirah.
  LILITAN_ANTABOGA: { nama: 'Lilitan Antaboga', teks: 'ATK lawan -17%, lawan -3,5% HP maks/ronde',   pelemah: 0.17, racun: 0.035 }
};

// ============================================================
// KATALOG 60 KARTU
// ============================================================
/**
 * Susunannya sengaja simetris supaya tidak ada elemen yang kelas dua:
 *
 *   Common 4 · Rare 3 · Epic 2 · Legendary 2 · Mythic 1   — untuk SETIAP elemen
 *
 * Dulu hanya API, PETIR, dan DARK yang punya Mythic, dan Legendary cuma satu
 * per elemen. Pemain yang menyukai AIR atau ANGIN tidak pernah punya tangga
 * yang lengkap. Sekarang semua elemen punya jalur yang sama panjangnya.
 *
 * Tiap baris membawa `atk`, `hp`, dan `kritis` sendiri — tidak ada dua kartu
 * yang angkanya sama. Yang dijaga tetap sama cuma hasil kalinya (lihat
 * `periksaKeseimbangan`).
 */
export const KARTU = [
  // ---------- COMMON (20) — 4 per elemen ----------
  { id: 'CMN01', nama: 'Tikus Bara',        rarity: 'COMMON', elemen: 'API',   atk: 152, hp:  300, kritis: 0.14, skill: 'NALURI_BUAS' },
  { id: 'CMN02', nama: 'Kunang Api',        rarity: 'COMMON', elemen: 'API',   atk: 144, hp:  305, kritis: 0.18, skill: 'GESIT' },
  { id: 'CMN03', nama: 'Kadal Pasir',       rarity: 'COMMON', elemen: 'API',   atk:  92, hp:  520, kritis: 0.06, skill: 'KULIT_TEBAL' },
  { id: 'CMN16', nama: 'Semut Merah',       rarity: 'COMMON', elemen: 'API',   atk:  98, hp:  480, kritis: 0.08, skill: 'URAT_BAJA' },
  { id: 'CMN04', nama: 'Katak Rawa',        rarity: 'COMMON', elemen: 'AIR',   atk:  85, hp:  565, kritis: 0.05, skill: 'URAT_BAJA' },
  { id: 'CMN05', nama: 'Ubur Kecil',        rarity: 'COMMON', elemen: 'AIR',   atk:  72, hp:  675, kritis: 0.04, skill: 'DURI_KECIL' },
  { id: 'CMN06', nama: 'Ikan Batu',         rarity: 'COMMON', elemen: 'AIR',   atk:  78, hp:  620, kritis: 0.05, skill: 'KULIT_TEBAL' },
  { id: 'CMN17', nama: 'Kepiting Karang',   rarity: 'COMMON', elemen: 'AIR',   atk:  76, hp:  625, kritis: 0.07, skill: 'DURI_KECIL' },
  { id: 'CMN07', nama: 'Burung Angin',      rarity: 'COMMON', elemen: 'ANGIN', atk: 133, hp:  340, kritis: 0.15, skill: 'GESIT' },
  { id: 'CMN08', nama: 'Rusa Padang',       rarity: 'COMMON', elemen: 'ANGIN', atk: 104, hp:  445, kritis: 0.10, skill: 'BIDIKAN_TENANG' },
  { id: 'CMN09', nama: 'Ular Sawah',        rarity: 'COMMON', elemen: 'ANGIN', atk: 127, hp:  360, kritis: 0.12, skill: 'GIGIT_LAPAR' },
  { id: 'CMN18', nama: 'Capung Sawah',      rarity: 'COMMON', elemen: 'ANGIN', atk: 140, hp:  310, kritis: 0.20, skill: 'MATA_TAJAM' },
  { id: 'CMN10', nama: 'Tupai Kejut',       rarity: 'COMMON', elemen: 'PETIR', atk: 136, hp:  335, kritis: 0.13, skill: 'NALURI_BUAS' },
  { id: 'CMN11', nama: 'Belut Setrum',      rarity: 'COMMON', elemen: 'PETIR', atk:  96, hp:  490, kritis: 0.09, skill: 'DURI_KECIL' },
  { id: 'CMN12', nama: 'Kunang Petir',      rarity: 'COMMON', elemen: 'PETIR', atk: 148, hp:  320, kritis: 0.08, skill: 'BIDIKAN_TENANG' },
  { id: 'CMN19', nama: 'Tokek Batu',        rarity: 'COMMON', elemen: 'PETIR', atk: 101, hp:  475, kritis: 0.06, skill: 'CANGKANG_KERAS' },
  { id: 'CMN13', nama: 'Kelelawar Gua',     rarity: 'COMMON', elemen: 'DARK',  atk: 158, hp:  290, kritis: 0.11, skill: 'GIGIT_LAPAR' },
  { id: 'CMN14', nama: 'Gagak Kelam',       rarity: 'COMMON', elemen: 'DARK',  atk: 122, hp:  380, kritis: 0.10, skill: 'WASPADA' },
  { id: 'CMN15', nama: 'Bayang Kecil',      rarity: 'COMMON', elemen: 'DARK',  atk:  82, hp:  580, kritis: 0.07, skill: 'WASPADA' },
  { id: 'CMN20', nama: 'Lipan Bayang',      rarity: 'COMMON', elemen: 'DARK',  atk: 129, hp:  355, kritis: 0.13, skill: 'SENGAT_KECIL' },

  // ---------- RARE (15) — 3 per elemen ----------
  { id: 'RAR01', nama: 'Harimau Bara',      rarity: 'RARE', elemen: 'API',   atk: 158, hp:  390, kritis: 0.14, skill: 'AMUK' },
  { id: 'RAR02', nama: 'Banteng Api',       rarity: 'RARE', elemen: 'API',   atk: 103, hp:  630, kritis: 0.07, skill: 'PEMECAH' },
  { id: 'RAR13', nama: 'Komodo Bara',       rarity: 'RARE', elemen: 'API',   atk:  89, hp:  740, kritis: 0.05, skill: 'TAJI_PATAH' },
  { id: 'RAR03', nama: 'Buaya Lumpur',      rarity: 'RARE', elemen: 'AIR',   atk: 107, hp:  610, kritis: 0.06, skill: 'PENGISAP' },
  { id: 'RAR04', nama: 'Beruang Salju',     rarity: 'RARE', elemen: 'AIR',   atk:  87, hp:  760, kritis: 0.05, skill: 'BENTENG' },
  { id: 'RAR05', nama: 'Kura Karang',       rarity: 'RARE', elemen: 'AIR',   atk:  95, hp:  700, kritis: 0.04, skill: 'TAJI_PATAH' },
  { id: 'RAR06', nama: 'Elang Badai',       rarity: 'RARE', elemen: 'ANGIN', atk: 178, hp:  345, kritis: 0.16, skill: 'SAYAP_ANGIN' },
  { id: 'RAR07', nama: 'Merak Angin',       rarity: 'RARE', elemen: 'ANGIN', atk: 119, hp:  530, kritis: 0.11, skill: 'PEMBUKA' },
  { id: 'RAR08', nama: 'Rajawali Puncak',   rarity: 'RARE', elemen: 'ANGIN', atk: 149, hp:  405, kritis: 0.17, skill: 'INCARAN' },
  { id: 'RAR09', nama: 'Kuda Petir',        rarity: 'RARE', elemen: 'PETIR', atk: 151, hp:  415, kritis: 0.12, skill: 'SETRUM_KEJUT' },
  { id: 'RAR10', nama: 'Landak Setrum',     rarity: 'RARE', elemen: 'PETIR', atk:  91, hp:  720, kritis: 0.06, skill: 'DURI_KECIL' },
  { id: 'RAR14', nama: 'Kijang Halilintar', rarity: 'RARE', elemen: 'PETIR', atk: 166, hp:  360, kritis: 0.20, skill: 'MATA_TAJAM' },
  { id: 'RAR11', nama: 'Serigala Kabut',    rarity: 'RARE', elemen: 'DARK',  atk: 172, hp:  360, kritis: 0.13, skill: 'TAJI_RACUN' },
  { id: 'RAR12', nama: 'Panther Malam',     rarity: 'RARE', elemen: 'DARK',  atk: 181, hp:  340, kritis: 0.15, skill: 'AMUK' },
  { id: 'RAR15', nama: 'Musang Gaib',       rarity: 'RARE', elemen: 'DARK',  atk: 114, hp:  560, kritis: 0.09, skill: 'NYALI_TERAKHIR' },

  // ---------- EPIC (10) — 2 per elemen ----------
  { id: 'EPC01', nama: 'Golem Lahar',       rarity: 'EPIC', elemen: 'API',   atk: 104, hp:  875, kritis: 0.05, skill: 'BARA_ABADI' },
  { id: 'EPC02', nama: 'Garuda Bara',       rarity: 'EPIC', elemen: 'API',   atk: 179, hp:  480, kritis: 0.13, skill: 'BALAS_DENDAM' },
  { id: 'EPC03', nama: 'Naga Rawa',         rarity: 'EPIC', elemen: 'AIR',   atk: 126, hp:  710, kritis: 0.08, skill: 'PENYEMBUHAN' },
  { id: 'EPC04', nama: 'Leviatan Muda',     rarity: 'EPIC', elemen: 'AIR',   atk: 138, hp:  635, kritis: 0.10, skill: 'PUSARAN' },
  { id: 'EPC05', nama: 'Siluman Angin',     rarity: 'EPIC', elemen: 'ANGIN', atk: 207, hp:  400, kritis: 0.18, skill: 'GESIT' },
  { id: 'EPC06', nama: 'Ratu Lebah',        rarity: 'EPIC', elemen: 'ANGIN', atk: 134, hp:  650, kritis: 0.11, skill: 'RACUN_RIMBA' },
  { id: 'EPC07', nama: 'Raksasa Petir',     rarity: 'EPIC', elemen: 'PETIR', atk: 121, hp:  745, kritis: 0.06, skill: 'TAPAK_GUNUNG' },
  { id: 'EPC09', nama: 'Naga Halilintar',   rarity: 'EPIC', elemen: 'PETIR', atk: 186, hp:  445, kritis: 0.19, skill: 'TARING_GUNTUR' },
  { id: 'EPC08', nama: 'Bayangan Rimba',    rarity: 'EPIC', elemen: 'DARK',  atk: 213, hp:  400, kritis: 0.15, skill: 'BALAS_DENDAM' },
  { id: 'EPC10', nama: 'Leak Bayangan',     rarity: 'EPIC', elemen: 'DARK',  atk: 110, hp:  835, kritis: 0.04, skill: 'SELUBUNG_LEAK' },

  // ---------- LEGENDARY (10) — 2 per elemen, skill unik ----------
  { id: 'LGD01', nama: 'Naga Krakatau',     rarity: 'LEGENDARY', elemen: 'API',   atk: 211, hp:  555, kritis: 0.14, skill: 'PENINDAS' },
  { id: 'LGD07', nama: 'Naga Merapi',       rarity: 'LEGENDARY', elemen: 'API',   atk: 124, hp: 1000, kritis: 0.06, skill: 'LAHAR_PURBA' },
  { id: 'LGD02', nama: 'Ratu Laut Selatan', rarity: 'LEGENDARY', elemen: 'AIR',   atk: 122, hp: 1025, kritis: 0.05, skill: 'PERISAI_AIR' },
  { id: 'LGD08', nama: 'Nyi Blorong',       rarity: 'LEGENDARY', elemen: 'AIR',   atk: 196, hp:  605, kritis: 0.12, skill: 'BISA_BLORONG' },
  { id: 'LGD03', nama: 'Garuda Nusantara',  rarity: 'LEGENDARY', elemen: 'ANGIN', atk: 248, hp:  455, kritis: 0.20, skill: 'TARIAN_BADAI' },
  { id: 'LGD09', nama: 'Jatayu Perkasa',    rarity: 'LEGENDARY', elemen: 'ANGIN', atk: 140, hp:  865, kritis: 0.09, skill: 'SAYAP_JATAYU' },
  { id: 'LGD04', nama: 'Petir Semeru',      rarity: 'LEGENDARY', elemen: 'PETIR', atk: 207, hp:  560, kritis: 0.16, skill: 'SAMBARAN_GANDA' },
  { id: 'LGD10', nama: 'Kala Gledek',       rarity: 'LEGENDARY', elemen: 'PETIR', atk: 163, hp:  735, kritis: 0.11, skill: 'GLEDEK_SELO' },
  { id: 'LGD05', nama: 'Rangda Kelam',      rarity: 'LEGENDARY', elemen: 'DARK',  atk: 144, hp:  850, kritis: 0.08, skill: 'KUTUKAN_RANGDA' },
  { id: 'LGD06', nama: 'Batara Kala',       rarity: 'LEGENDARY', elemen: 'DARK',  atk: 232, hp:  490, kritis: 0.18, skill: 'RAHANG_KALA' },

  // ---------- MYTHIC (5) — satu untuk SETIAP elemen ----------
  { id: 'MYT01', nama: 'Barong Agni',       rarity: 'MYTHIC', elemen: 'API',   atk: 245, hp:  675, kritis: 0.12, skill: 'API_SUCI' },
  { id: 'MYT04', nama: 'Naga Baruna',       rarity: 'MYTHIC', elemen: 'AIR',   atk: 146, hp: 1185, kritis: 0.06, skill: 'PUSARAN_ABADI' },
  { id: 'MYT05', nama: 'Sang Hyang Bayu',   rarity: 'MYTHIC', elemen: 'ANGIN', atk: 193, hp:  845, kritis: 0.14, skill: 'SANGKAKALA' },
  { id: 'MYT02', nama: 'Sang Hyang Petir',  rarity: 'MYTHIC', elemen: 'PETIR', atk: 292, hp:  530, kritis: 0.22, skill: 'MURKA_PETIR' },
  { id: 'MYT03', nama: 'Kala Rau',          rarity: 'MYTHIC', elemen: 'DARK',  atk: 251, hp:  640, kritis: 0.17, skill: 'GERHANA' },
  { id: 'MYT06', nama: 'Gatotkaca',         rarity: 'MYTHIC', elemen: 'PETIR', atk: 155, hp: 1115, kritis: 0.06, skill: 'OTOT_KAWAT' },
  { id: 'MYT07', nama: 'Dewi Sri',          rarity: 'MYTHIC', elemen: 'ANGIN', atk: 168, hp: 1005, kritis: 0.09, skill: 'BERKAH_PANEN' },
  { id: 'MYT08', nama: 'Antaboga',          rarity: 'MYTHIC', elemen: 'DARK',  atk: 205, hp:  820, kritis: 0.10, skill: 'LILITAN_ANTABOGA' }
];

// ============================================================
// GELAR — SUBJUDUL INGGRIS UNTUK DUA TIER TERATAS
// ============================================================
/**
 * Nama kartu tetap Nusantara; yang berbahasa Inggris hanya GELAR-nya.
 *
 * Alasannya bukan selera. Rangka game ini sudah berbahasa Inggris sejak awal
 * (Common ... Mythic, Gauntlet, Void), sementara nama makhluknya lokal — itu
 * formula yang sama dipakai gacha besar: chrome Inggris, nama diri lokal.
 * Menerjemahkan nama kartunya justru MEMBALIK tangga rarity: `Ember Rat`
 * terdengar internasional sedangkan `Batara Kala` tetap lokal karena ia nama
 * diri yang tidak punya terjemahan. Tier murah jadi terdengar lebih megah
 * daripada endgame.
 *
 * Karena itu gelar SENGAJA hanya dipasang di LEGENDARY dan MYTHIC. Ia bukan
 * hiasan merata — ketiadaannya di Common..Epic adalah penanda tier, sama
 * kerjanya seperti warna bingkai kartu.
 *
 * Tiap gelar ditambatkan ke skill atau stat kartunya, bukan dikarang lepas:
 * Kala Rau menelan gerhana (skill GERHANA), Jatayu bertahan dan tidak jatuh
 * (HP 865, tertinggi kedua di tier-nya), Sang Hyang Petir membelah langit
 * (ATK 292, tertinggi di seluruh katalog).
 *
 * Ditulis terpisah dari tabel katalog dengan sengaja: tabel itu sejajar kolom
 * supaya angka ATK/HP/KRITIS bisa dibaca sekilas dan dibanding-banding, dan
 * menyelipkan kalimat panjang ke tiap baris akan menghancurkan gunanya.
 */
export const GELAR = {
  // --- LEGENDARY ---
  LGD01: 'The Island That Burned',        // Naga Krakatau
  LGD07: 'The Mountain That Never Sleeps', // Naga Merapi - skill LAHAR_PURBA
  LGD02: 'Empress of the Southern Tide',  // Ratu Laut Selatan
  LGD08: 'Coils of the Golden Serpent',   // Nyi Blorong - sisik emas
  LGD03: 'Wings Over the Archipelago',    // Garuda Nusantara
  LGD09: 'The Wing That Would Not Fall',  // Jatayu Perkasa - HP 865
  LGD04: 'Twin Bolts of the Highest Peak', // Petir Semeru - SAMBARAN_GANDA
  LGD10: 'The Thunder That Splits Stone', // Kala Gledek - skill GLEDEK_SELO
  LGD05: 'Mother of All Curses',          // Rangda Kelam - KUTUKAN_RANGDA
  LGD06: 'Devourer of Time',              // Batara Kala - dewa waktu

  // --- MYTHIC ---
  MYT01: 'Sacred Flame of the Guardian',  // Barong Agni - skill API_SUCI
  MYT04: 'Tide of the Endless Deep',      // Naga Baruna - HP 1185 tertinggi
  MYT05: 'Breath of the First Storm',     // Sang Hyang Bayu - SANGKAKALA
  MYT02: 'Fury of the Splitting Sky',     // Sang Hyang Petir - ATK 292
  MYT03: 'The Eclipse Devourer'           // Kala Rau - skill GERHANA
  ,
  MYT06: 'Sinews of Wire, Bones of Iron', // Gatotkaca - otot kawat balung wesi
  MYT07: 'Mother of the Golden Harvest',  // Dewi Sri - dewi padi
  MYT08: 'The Serpent That Holds the World' // Antaboga - naga penyangga bumi
};

// Ditempel ke objek kartunya supaya seluruh layar cukup membaca `kartu.gelar`
// dan tidak perlu tahu peta ini ada. Kartu tanpa gelar bernilai `undefined`,
// jadi setiap pemakainya WAJIB menjaganya di balik pengecekan.
for (const k of KARTU) {
  if (GELAR[k.id]) k.gelar = GELAR[k.id];
}

// ============================================================
// PENJAGA ANGGARAN
// ============================================================
/**
 * Berapa jauh sebuah kartu boleh meleset dari anggaran rarity-nya. 5% dipilih
 * karena pembulatan HP ke kelipatan 5 saja sudah menggeser sampai ~1%, jadi
 * angka di bawah itu akan berisik tanpa sebab.
 */
// ============================================================
// REFINE (R1-R5) — SUMBU KETIGA, MENAIKKAN SKILL BUKAN STAT
// ============================================================
/**
 * Duplikat kartu yang sama disisipkan untuk menaikkan R. Yang naik adalah
 * ANGKA SKILL-nya, tidak pernah ATK atau HP.
 *
 * Kenapa skill dan bukan stat: seluruh katalog berdiri di atas satu janji,
 * yaitu `atk x hp = daya` yang sama untuk tiap rarity, dijaga
 * `periksaKeseimbangan()`. Menaikkan stat lewat R akan meruntuhkan janji itu
 * dan membuat pemeriksa anggaran berteriak di setiap kartu ber-R tinggi.
 * Menskalakan skill tidak menyentuh anggaran sama sekali.
 *
 * Dan ternyata di situlah tier META/biasa/lewati lahir dengan sendirinya,
 * tanpa satu angka pun perlu dipilih tangan. Diukur lewat adu penuh sesama
 * rarity (60 ulangan tiap pasangan, paparan elemen tiap kartu terbukti sama
 * rata di 1,009-1,010 jadi bukan undian elemen):
 *
 *   MYTHIC       Kala Rau 60%  ..  Barong Agni 41%   (selisih 20 poin)
 *   LEGENDARY    Naga Merapi 57%  ..  Naga Krakatau 45%
 *   EPIC         Bayangan Rimba 54%  ..  Siluman Angin 42%
 *
 * Ketimpangan itu SUDAH ADA sebelum R diperkenalkan — cuma tidak terlihat.
 * R melipatgandakannya: skill yang menskala keras (Gerhana +60% jadi +120%)
 * melesat, skill datar (`HP maks +10%`) tetap datar. Itu yang membuat sebagian
 * kartu layak dikejar dan sebagian tidak, tanpa pernah menulis daftar tier.
 *
 * ATURAN YANG TIDAK BOLEH DILANGGAR: R1 WAJIB identik dengan hari ini.
 * `skillEfektif(kartu, 1)` harus mengembalikan angka yang persis sama dengan
 * `SKILL[kartu.skill]`, supaya seluruh keseimbangan yang sudah diukur — kurva
 * Menara Abadi, kalibrasi Gauntlet, HP Bos — tidak bergeser sedikit pun saat
 * fitur ini menyala. Uji asap mengunci ini.
 */
export const MAKS_REFINE = 5;

// R1 tidak menskalakan apa pun; R5 melipatduakan. Naik rata 0,25 tiap tingkat.
export const REFINE_SKALA = [1.00, 1.25, 1.50, 1.75, 2.00];

/**
 * Batas atas tiap koefisien sesudah diskalakan.
 *
 * Tanpa ini beberapa koefisien jadi merusak, bukan sekadar kuat: `hindar` yang
 * dilipatduakan membuat duel jadi lotre lempar koin, dan `tahan` yang menumpuk
 * dengan `perisaiAwal` bisa membuat kartu praktis kebal di ronde pembuka.
 * Angka-angka ini adalah langit-langit, bukan target — sebagian besar kartu
 * tidak pernah menyentuhnya bahkan di R5.
 */
const BATAS_SKILL = {
  atkBonus: 0.60, hpBonus: 0.60, tahan: 0.40, hindar: 0.30,
  duri: 0.25, serap: 0.10, regen: 0.12, racun: 0.09,
  setrum: 0.35, ganda: 0.50, pelemah: 0.35, eksekusi: 1.30,
  bukaan: 1.20, menumpuk: 0.25, kritBonus: 0.30, kritDmg: 0.60,
  tembus: 0.70, antiKrit: 0.40, penindas: 0.35, perisaiAwal: 0.90
};

/**
 * Skill yang isinya HANYA saklar benar/salah tidak punya angka untuk
 * diskalakan, jadi R tidak akan berarti apa-apa untuk pemiliknya. `Nyali
 * Terakhir` (Musang Gaib) adalah satu-satunya kartu seperti itu.
 *
 * Ia diberi imbalan terpisah: sesudah bertahan di 1 HP, ia memulihkan sebagian
 * HP maks. Sengaja bernilai NOL di R1 supaya kartu itu berperilaku persis
 * seperti hari ini sampai pemiliknya benar-benar menyisipkan duplikat.
 *
 * DUA JEBAKAN, keduanya tertangkap `scripts/tcgTierMeter.mjs` pada percobaan
 * pertama dan keduanya merusak tangga rarity:
 *
 *   1. Imbalan ini sempat diberikan ke SEMUA skill ber-`bertahanMati`. Lahar
 *      Purba (Naga Merapi) sudah punya `tahan: 0,18` yang menskala, jadi ia
 *      menerima dua imbalan sekaligus dan melompat ke 67% melawan MYTHIC R1 —
 *      Legendary R5 mengalahkan rarity di atasnya. Sekarang imbalan ini hanya
 *      diberikan kalau kartu itu benar-benar tidak punya angka lain untuk
 *      diskalakan.
 *   2. Besarnya sempat sampai 0,26 di R5. Itu membuat Musang Gaib (RARE)
 *      menang 63% melawan EPIC R1. Diturunkan ke 0,16.
 */
const PULIH_MAUT_PER_R = [0, 0.04, 0.08, 0.12, 0.16];

/** Apakah skill ini punya satu saja angka yang bisa diskalakan R. */
function punyaAngkaSkala(sk) {
  if (sk.nekat) return true;
  return Object.keys(BATAS_SKILL).some(k => typeof sk[k] === 'number');
}

const cacheSkill = new Map();

/**
 * Skill sebuah kartu setelah diskalakan tingkat R-nya.
 *
 * Hasilnya di-cache karena simulasi tempur memanggilnya puluhan ribu kali
 * dalam satu kalibrasi, dan objek yang dikembalikan TIDAK BOLEH diubah oleh
 * pemanggilnya — ia dibagi pakai antar semua petarung dengan skill dan R yang
 * sama.
 */
export function skillEfektif(kartu, refine = 1) {
  const id = kartu?.skill;
  if (!id || !SKILL[id]) return null;

  const r = Math.max(1, Math.min(MAKS_REFINE, Math.floor(refine) || 1));
  const kunci = `${id}_${r}`;
  const tersimpan = cacheSkill.get(kunci);
  if (tersimpan) return tersimpan;

  const asli = SKILL[id];
  // R1 mengembalikan objek ASLINYA, bukan salinan. Itu disengaja: kalau suatu
  // saat penskalaan ini rusak, R1 tetap tidak mungkin ikut bergeser.
  if (r === 1) { cacheSkill.set(kunci, asli); return asli; }

  const skala = REFINE_SKALA[r - 1];
  const hasil = { ...asli, refine: r };

  for (const [k, batas] of Object.entries(BATAS_SKILL)) {
    if (typeof asli[k] === 'number') hasil[k] = Math.min(batas, asli[k] * skala);
  }
  // `nekat` bersarang: ambang HP-nya tetap, cuma besar bonusnya yang naik.
  if (asli.nekat) {
    hasil.nekat = { ambang: asli.nekat.ambang, bonus: Math.min(1.00, asli.nekat.bonus * skala) };
  }
  // Hanya untuk skill yang benar-benar tidak punya angka lain — lihat catatan
  // di atas PULIH_MAUT_PER_R.
  if (asli.bertahanMati === true && !punyaAngkaSkala(asli)) {
    hasil.pulihSetelahMaut = PULIH_MAUT_PER_R[r - 1];
  }

  cacheSkill.set(kunci, hasil);
  return hasil;
}

/** Teks skill yang sudah memuat angka R-nya, untuk ditampilkan ke pemain. */
export function teksSkill(kartu, refine = 1) {
  const sk = skillEfektif(kartu, refine);
  if (!sk) return '';
  const r = Math.max(1, Math.min(MAKS_REFINE, Math.floor(refine) || 1));
  if (r === 1) return sk.teks;

  // Teks skill ditulis tangan dan memuat angkanya di dalam kalimat, jadi ia
  // tidak bisa dihitung ulang otomatis. Yang ditampilkan adalah kelipatannya
  // — jujur dan tidak mungkin melenceng dari angka yang benar-benar dipakai.
  return `${sk.teks}  _(efek x${REFINE_SKALA[r - 1].toFixed(2).replace('.', ',')})_`;
}

/**
 * Angka skill yang SEBENARNYA berlaku di tingkat R tertentu, dirangkum jadi
 * satu baris pendek.
 *
 * Ini bukan hiasan — ini satu-satunya cara pemain bisa membandingkan R2 dengan
 * R3 sebelum membakar duplikatnya. Teks skill di katalog ditulis tangan dan
 * angkanya menyatu di dalam kalimat ("Pulih 5,5% HP tiap ronde"), jadi ia
 * TIDAK BISA dihitung ulang untuk R yang lebih tinggi. Merangkum koefisiennya
 * sendiri adalah satu-satunya cara yang mustahil melenceng dari angka yang
 * benar-benar dipakai mesin tempur, karena keduanya membaca objek yang sama.
 *
 * Urutannya sengaja tetap (mengikuti LABEL_EFEK), supaya membandingkan dua
 * tingkat R berarti membandingkan dua baris yang bentuknya sama persis.
 */
const LABEL_EFEK = [
  ['atkBonus', (v) => `ATK +${persenEfek(v)}`],
  ['hpBonus', (v) => `HP +${persenEfek(v)}`],
  ['bukaan', (v) => `pukulan pertama +${persenEfek(v)}`],
  ['menumpuk', (v) => `+${persenEfek(v)} damage/ronde`],
  ['ganda', (v) => `serang 2x ${persenEfek(v)}`],
  ['eksekusi', (v) => `eksekusi +${persenEfek(v)}`],
  ['penindas', (v) => `penindas +${persenEfek(v)}`],
  ['kritBonus', (v) => `kritis +${persenEfek(v)}`],
  ['kritDmg', (v) => `kritis ${persenEfek(v)} lebih keras`],
  ['tahan', (v) => `damage diterima -${persenEfek(v)}`],
  ['hindar', (v) => `hindar ${persenEfek(v)}`],
  ['perisaiAwal', (v) => `damage pertama -${persenEfek(v)}`],
  ['antiKrit', (v) => `kritis lawan -${persenEfek(v)}`],
  ['duri', (v) => `pantul ${persenEfek(v)}`],
  ['tembus', (v) => `tembus ${persenEfek(v)}`],
  ['pelemah', (v) => `ATK lawan -${persenEfek(v)}`],
  ['setrum', (v) => `lawan hilang giliran ${persenEfek(v)}`],
  ['racun', (v) => `racun ${persenEfek(v)}/ronde`],
  ['regen', (v) => `pulih ${persenEfek(v)}/ronde`],
  ['serap', (v) => `isap ${persenEfek(v)}/pukulan`],
  ['pulihSetelahMaut', (v) => `bangkit ${persenEfek(v)} HP`]
];

function persenEfek(v) {
  const p = v * 100;
  // Koefisien sekecil 3,5% jadi tidak berarti kalau dibulatkan ke bilangan
  // bulat, dan justru di angka-angka kecil itulah selisih antar tingkat R
  // paling sulit dilihat.
  return `${(Math.round(p * 10) / 10).toString().replace('.', ',')}%`;
}

export function ringkasEfekSkill(kartu, refine = 1) {
  const sk = skillEfektif(kartu, refine);
  if (!sk) return '';
  const bagian = [];
  for (const [kunci, tulis] of LABEL_EFEK) {
    if (typeof sk[kunci] === 'number' && sk[kunci] > 0) bagian.push(tulis(sk[kunci]));
  }
  if (sk.nekat) bagian.push(`di HP rendah +${persenEfek(sk.nekat.bonus)}`);
  if (sk.abaikanLemah) bagian.push('abaikan rugi elemen');
  if (sk.bertahanMati) bagian.push('sekali bertahan di 1 HP');
  return bagian.join(' · ');
}

/**
 * Tangga R1-R5 lengkap dengan angka tiap tingkat. Sepasangan dengan
 * `tanggaLevel`, dan dipakai layar kartu supaya pemain bisa melihat sejauh apa
 * duplikatnya akan membawa kartu itu SEBELUM ia membakar satu pun.
 */
export function tanggaRefine(kartu) {
  const hasil = [];
  for (let r = 1; r <= MAKS_REFINE; r++) {
    hasil.push({ refine: r, skala: REFINE_SKALA[r - 1], efek: ringkasEfekSkill(kartu, r) });
  }
  return hasil;
}

export const TOLERANSI_DAYA = 0.05;

/**
 * @returns {Array<{id, nama, rarity, daya, anggaran, deviasi}>} kartu yang keluar batas
 */
export function periksaKeseimbangan(daftar = KARTU) {
  const keluar = [];
  for (const k of daftar) {
    const anggaran = STAT_RARITY[k.rarity]?.daya;
    if (!anggaran) continue;
    const daya = atkEfektif(k.atk, k.kritis) * k.hp;
    const deviasi = daya / anggaran - 1;
    if (Math.abs(deviasi) > TOLERANSI_DAYA) {
      keluar.push({ id: k.id, nama: k.nama, rarity: k.rarity, daya, anggaran, deviasi });
    }
  }
  return keluar;
}

// Peringatan saat bot menyala. Sengaja TIDAK melempar: katalog yang sedikit
// meleset masih bisa dimainkan, dan mematikan bot karena angka kartu adalah
// harga yang jauh lebih mahal daripada satu baris merah di log.
{
  const keluar = periksaKeseimbangan();
  if (keluar.length) {
    console.warn(
      `[TCG] ${keluar.length} kartu keluar dari anggaran daya (>${TOLERANSI_DAYA * 100}%): ` +
      keluar.map(k => `${k.id} ${(k.deviasi * 100).toFixed(1)}%`).join(', ')
    );
  }
}

const PETA_KARTU = new Map(KARTU.map(k => [k.id, k]));
const PETA_RARITY = KARTU.reduce((acc, k) => {
  (acc[k.rarity] = acc[k.rarity] || []).push(k);
  return acc;
}, {});

/**
 * Menormalkan ID kartu yang diketik manusia menjadi bentuk katalog.
 *
 * Log pemain nyata menunjukkan `rar6` dan `CMN1` ditolak mentah-mentah padahal
 * maksudnya jelas — nomor satu digit dan nol di depan yang hilang adalah dua
 * kesalahan ketik paling sering. Normalisasi ditaruh di dalam `getKartu` supaya
 * SEMUA perintah (pasang, kartu, naik, jual, serpih) ikut memaafkan, bukan
 * hanya yang kebetulan diperbaiki satu per satu.
 */
export function normalisasiIdKartu(teks) {
  const q = String(teks || '').trim().toUpperCase().replace(/\s+/g, '');
  const m = q.match(/^(CMN|RAR|EPC|LGD|MYT)0*(\d{1,2})$/);
  return m ? `${m[1]}${m[2].padStart(2, '0')}` : q;
}

export function getKartu(id) {
  return PETA_KARTU.get(normalisasiIdKartu(id)) || null;
}

/** Elemen mana saja yang mengungguli `elemen` — dipakai untuk saran counter. */
export function pengalahElemen(elemen) {
  return Object.keys(ELEMEN).filter(e => ELEMEN[e].unggul.includes(elemen));
}

export function getKartuByRarity(rarity) {
  return PETA_RARITY[rarity] || [];
}

export function cariKartu(kataKunci) {
  const q = String(kataKunci || '').toLowerCase().trim();
  if (!q) return [];
  // ID yang cocok persis selalu menang telak — kalau tidak, `.tcg kartu RAR01`
  // bisa ikut menyeret kartu lain yang namanya kebetulan mengandung "rar01".
  const langsung = getKartu(q);
  if (langsung) return [langsung];
  return KARTU.filter(k => k.nama.toLowerCase().includes(q));
}

export const PETA_COST = KARTU.reduce((acc, k) => {
  acc[k.id] = STAT_RARITY[k.rarity]?.bintang || 1;
  return acc;
}, {});

export const TOTAL_KARTU = KARTU.length;

// ============================================================
// SINERGI DEK — BONUS DARI KOMPOSISI, BUKAN DARI RARITY
// ============================================================
/**
 * Anggaran dek adalah MAKS_BIAYA_DEK bintang. Sebelum ada sinergi, tidak ada
 * alasan untuk tidak menghabiskannya: kartu termahal selalu menang di slotnya,
 * jadi "dek terbaik" selalu tiga kartu termahal yang muat. Common dan Rare
 * praktis jadi sampah begitu pemain punya satu Legendary.
 *
 * PASUKAN_RAMPING membalik itu: setiap bintang yang TIDAK terpakai dibayar
 * kembali sebagai RAMPING_PER_BINTANG ATK dan HP untuk seluruh dek. Simulasi
 * 3v3 mengonfirmasi ini bekerja — dek 6★ berisi tiga Rare menang 48,2% melawan
 * dek 10★ berisi Mythic + Legendary. Anggaran berubah dari batas atas menjadi
 * mata uang.
 *
 * Sinergi lain menumpuk di atasnya, tapi sebagian saling meniadakan menurut
 * definisi (SATU_PADU vs DUO_SELARAS vs TRI_ELEMEN).
 *
 * Sinergi hanya menyala kalau ketiga slot terisi — slot kosong sudah kalah
 * otomatis di rondenya, dan aturan ini menambah alasan untuk mengisinya.
 */

/**
 * Anggaran bintang satu dek. Ditaruh di sini karena ini aturan kartu, bukan
 * aturan penyimpanan; `TCG_MAX_DECK_COST` di tcgDb.js mengambil nilainya dari
 * sini supaya validasi dek dan perhitungan sinergi tidak pernah berbeda.
 */
export const MAKS_BIAYA_DEK = 10;

/**
 * Ganti rugi per bintang yang tidak terpakai, dengan batas atas.
 *
 * Batasnya penting: tanpa itu, dek tiga Common (3★, sisa 7★) mendapat bonus
 * terbesar di permainan, dan karena lawan PvE punya dek yang tetap dan bisa
 * dihafal, dek sampah ber-counter-elemen akan menghabisi bos terakhir.
 * Dengan batas 5★, hadiah terbesar jatuh ke dek yang menyisakan ruang secukupnya
 * (6-7★), bukan ke dek yang isinya seadanya.
 */
export const RAMPING_PER_BINTANG = 0.05;
export const RAMPING_MAKS_BINTANG = 5;

export const SINERGI = [
  {
    id: 'SATU_PADU',
    nama: 'Satu Padu',
    emoji: '🔗',
    syarat: 'Ketiga kartu satu elemen',
    atk: 0.15,
    hp: 0,
    cek: (k) => new Set(k.map(c => c.elemen)).size === 1
  },
  {
    id: 'TRI_ELEMEN',
    nama: 'Tri Elemen',
    emoji: '🌈',
    syarat: 'Ketiga kartu beda elemen',
    atk: 0,
    hp: 0.12,
    cek: (k) => new Set(k.map(c => c.elemen)).size === 3
  },
  {
    id: 'DUO_SELARAS',
    nama: 'Duo Selaras',
    emoji: '🤝',
    syarat: 'Tepat dua kartu satu elemen',
    atk: 0.07,
    hp: 0,
    cek: (k) => new Set(k.map(c => c.elemen)).size === 2
  },
  {
    id: 'RANTAI_TAKDIR',
    nama: 'Rantai Takdir',
    emoji: '🌀',
    syarat: 'Elemen membentuk rantai unggul A ▸ B ▸ C',
    atk: 0.10,
    hp: 0,
    cek: (k) => {
      const e = k.map(c => c.elemen);
      if (new Set(e).size !== 3) return false;
      const urutan = [
        [e[0], e[1], e[2]], [e[0], e[2], e[1]], [e[1], e[0], e[2]],
        [e[1], e[2], e[0]], [e[2], e[0], e[1]], [e[2], e[1], e[0]]
      ];
      return urutan.some(([a, b, c]) =>
        ELEMEN[a]?.unggul.includes(b) && ELEMEN[b]?.unggul.includes(c)
      );
    }
  },
  {
    id: 'FORMASI_SEIMBANG',
    nama: 'Formasi Seimbang',
    emoji: '⚖️',
    syarat: 'Ketiga kartu beda bintang',
    atk: 0.08,
    hp: 0.08,
    cek: (k) => new Set(k.map(c => costKartu(c))).size === 3
  }
];

/**
 * @param {Array} kartuList daftar objek kartu (harus 3 kartu valid)
 * @returns {{atk:number, hp:number, sisaBintang:number, aktif:Array}}
 */
export function hitungSinergi(kartuList) {
  const kartu = (kartuList || []).filter(Boolean);
  if (kartu.length !== 3) return { atk: 0, hp: 0, sisaBintang: 0, aktif: [] };

  const aktif = SINERGI.filter(s => {
    try { return s.cek(kartu); } catch { return false; }
  });

  const biaya = kartu.reduce((t, c) => t + costKartu(c), 0);
  const sisaBintang = Math.max(0, MAKS_BIAYA_DEK - biaya);
  const sisaDibayar = Math.min(sisaBintang, RAMPING_MAKS_BINTANG);
  const ramping = sisaDibayar * RAMPING_PER_BINTANG;

  if (ramping > 0) {
    aktif.unshift({
      id: 'PASUKAN_RAMPING',
      nama: 'Pasukan Ramping',
      emoji: '🪶',
      syarat: `Sisa ${sisaBintang}★ anggaran dek (dibayar ${sisaDibayar}★)`,
      atk: ramping,
      hp: ramping
    });
  }

  return {
    atk: aktif.reduce((t, s) => t + s.atk, 0),
    hp: aktif.reduce((t, s) => t + s.hp, 0),
    sisaBintang,
    aktif
  };
}

/**
 * Sinergi dari objek dek {1:{card_id},2:...,3:...} apa adanya dari database.
 */
export function sinergiDek(deck) {
  const kartu = [1, 2, 3].map(s => (deck?.[s] ? getKartu(deck[s].card_id) : null));
  return hitungSinergi(kartu);
}
