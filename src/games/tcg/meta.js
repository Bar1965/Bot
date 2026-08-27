/**
 * ARENA KARTU MONSTER — LAYAR RETENSI
 *
 * Peringkat musiman, gelar, tonggak koleksi, misi mingguan, Menara Abadi, dan
 * barter duplikat. Semua yang menjawab pertanyaan "sudah punya semuanya, terus
 * ngapain?" — pertanyaan yang sebelumnya tidak punya jawaban di arena ini.
 *
 * Dipisah dari `index.js` yang sudah 2300+ baris. Router-nya tetap satu di
 * sana; berkas ini hanya menyediakan badan perintahnya.
 */

import * as db from '../../../database.js';
import { send, isOnCooldown } from '../helpers.js';
import { tcgKey } from './identity.js';
import { getKartu, normalisasiIdKartu, STAT_RARITY, TOTAL_KARTU, ELEMEN } from './cards.js';
import { simulate3v3, dekAbadi, TOWER_FLOORS } from './battle.js';

const fmt = (n) => Number(n || 0).toLocaleString('id-ID');
const GARIS = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

/** Bar progres teks. Dipakai di banyak layar, jadi satu definisi saja. */
function bar(nilai, target, lebar = 10) {
  const t = Math.max(1, target);
  const isi = Math.max(0, Math.min(lebar, Math.round((nilai / t) * lebar)));
  return '▰'.repeat(isi) + '▱'.repeat(lebar - isi);
}

// ============================================================
// PENCATAT AKSI
// ============================================================

/**
 * SATU-SATUNYA jalur pelaporan aktivitas arena.
 *
 * Misi harian diundi tiap hari dan misi mingguan menghitung aksi yang sama
 * dengan pengelompokan berbeda. Kalau pemanggil harus memilih sendiri mana yang
 * relevan, cepat atau lambat akan ada jalur yang hanya melapor ke salah satu.
 * Panggil ini dari mana pun aksi benar-benar terjadi, dan biarkan kedua sistem
 * memutuskan apakah aksi itu berarti untuk mereka.
 *
 * Sengaja tidak pernah melempar: kegagalan mencatat misi tidak boleh
 * menggagalkan pertarungan yang sudah dimainkan pemain.
 */
export async function catatAksi(key, aksi, jumlah = 1) {
  try {
    await db.tcgCatatProgresMisi(key, aksi, jumlah);
  } catch (e) {
    console.error(`[TCG] Gagal mencatat misi harian ${aksi}:`, e?.message || e);
  }
  try {
    await db.tcgCatatMingguan(key, aksi, jumlah);
  } catch (e) {
    console.error(`[TCG] Gagal mencatat misi mingguan ${aksi}:`, e?.message || e);
  }
}

/** Baris gelar untuk dipasang di header layar lain. Kosong kalau tidak ada. */
export async function barisGelar(key) {
  try {
    const g = await db.tcgGelarAktif(key);
    return g ? `${g}` : '';
  } catch (e) {
    return '';
  }
}

// ============================================================
// PERINGKAT & MUSIM
// ============================================================

export function labelTier(tier) {
  return `${tier.emoji} ${tier.nama}`;
}

/**
 * Pengumuman hadiah akhir musim.
 *
 * Dibayar malas saat pemain pertama kali menyentuh peringkat di musim baru,
 * jadi teks ini bisa muncul menempel di layar apa pun — termasuk di tengah
 * hasil duel. Itu disengaja: hadiah yang dibayar diam-diam sama saja dengan
 * tidak ada.
 */
export function teksHadiahMusim(h) {
  if (!h) return '';
  return [
    '',
    GARIS,
    `🏁 *MUSIM ${h.musim} SELESAI!*`,
    `Peringkat akhirmu: *${labelTier(h.tier)}* (${fmt(h.poin)} poin · ${h.menang}M-${h.kalah}K)`,
    h.teks?.length ? `🎁 Hadiah: ${h.teks.join(' · ')}` : '',
    h.gelar ? `🏷️ Gelar baru: *${h.gelar}* — pasang dengan \`.tcg gelar\`` : '',
    `↩️ Poin musim baru: *${fmt(h.poinBaru)}* _(reset lunak)_`
  ].filter(Boolean).join('\n');
}

export async function tampilRank(sock, jid, messageObj, key, arg) {
  const sub = String(arg || '').toLowerCase();

  if (['top', 'papan', 'lb', 'board'].includes(sub)) {
    const papan = await db.getTcgRankLeaderboard(10);
    const musim = db.tcgMusimSekarang();
    if (!papan.length) {
      await send(sock, jid, messageObj,
        `🏆 *PERINGKAT ARENA — MUSIM ${musim.nomor}*\n\nBelum ada yang bertanding musim ini.\nJadilah yang pertama: \`.tcg duel @member\` atau \`.tcg spar lawan\`.`);
      return true;
    }
    const medali = ['🥇', '🥈', '🥉'];
    const baris = papan.map((r, i) => {
      const t = db.tcgTier(r.poin);
      const nama = r.customer_nama || r.customer_jid.split('@')[0];
      return `${medali[i] || `${i + 1}.`} *${nama}* — ${t.emoji} ${fmt(r.poin)}\n   └ ${r.menang}M · ${r.kalah}K · ${r.seri}S`;
    });
    await send(sock, jid, messageObj, [
      `🏆 *PERINGKAT ARENA — MUSIM ${musim.nomor}*`,
      `Hari ke-${musim.hariKe}/${db.TCG_MUSIM_HARI} · sisa *${musim.sisaHari} hari*`,
      '',
      ...baris,
      '',
      '_Ketik `.tcg rank` untuk melihat posisimu sendiri._'
    ].join('\n'));
    return true;
  }

  const r = await db.tcgGetRank(key, { umumkan: true });
  const gelar = await barisGelar(key);
  const sisaSpar = await db.tcgSisaSparBerperingkat(key);

  const teks = [
    '🏆 *PERINGKAT ARENA*',
    gelar ? `🏷️ ${gelar}` : '',
    `Musim *${r.musim}* · hari ke-${r.hariKe}/${db.TCG_MUSIM_HARI} · sisa *${r.sisaHari} hari*`,
    '',
    `${labelTier(r.tier)} — *${fmt(r.poin)} poin*`,
    r.tierBerikutnya
      ? `   └ ${bar(r.poin - r.tier.min, r.tierBerikutnya.min - r.tier.min)} kurang *${fmt(r.tierBerikutnya.kurang)}* poin ke ${labelTier(r.tierBerikutnya)}`
      : '   └ _Kamu sudah di puncak klasemen tier._',
    '',
    `📊 ${r.menang}M · ${r.kalah}K · ${r.seri}S dari *${r.main}* laga _(winrate ${r.winrate}%)_`,
    `📈 Tertinggi musim ini: *${fmt(r.tertinggi)}*`,
    r.beruntun >= 2 ? `🔥 Sedang beruntun *${r.beruntun} kemenangan*!` : '',
    '',
    GARIS,
    '*Cara naik poin:*',
    `⚔️ \`.tcg duel @member\` — laga berperingkat penuh (maks ${db.TCG_RANK_MAKS_PASANGAN}× per lawan/hari)`,
    `🥊 \`.tcg spar lawan\` — setengah bobot, sisa *${sisaSpar}/${db.TCG_RANK_MAKS_SPAR}* hari ini`,
    '',
    '_Akhir musim: hadiah sesuai tier, lalu poin direset lunak (separuh jarak dari 1000)._',
    '_Papan peringkat: `.tcg rank top`_',
    teksHadiahMusim(r.hadiahMusimLalu)
  ].filter(Boolean).join('\n');

  await send(sock, jid, messageObj, teks);
  return true;
}

// ============================================================
// GELAR
// ============================================================

export async function tampilGelar(sock, jid, messageObj, key, arg) {
  const sub = String(arg || '').trim();
  const hasil = await db.tcgPeriksaGelar(key, TOTAL_KARTU);

  if (sub) {
    const res = await db.tcgPasangGelar(key, sub);
    if (res.success && res.dilepas) {
      await send(sock, jid, messageObj, '🏷️ Gelar dilepas. Namamu kembali polos.');
      return true;
    }
    if (!res.success) {
      await send(sock, jid, messageObj, [
        `❌ Kamu belum punya gelar \`${sub.toUpperCase()}\`.`,
        '',
        'Ketik `.tcg gelar` untuk melihat daftar gelar dan syaratnya.'
      ].join('\n'));
      return true;
    }
    await send(sock, jid, messageObj, `🏷️ Gelar terpasang: *${res.nama}*\n\n_Muncul di menu, hasil duel, dan papan peringkat._`);
    return true;
  }

  const punya = hasil.semua.filter(g => g.punya);
  const belum = hasil.semua.filter(g => !g.punya);

  const barisPunya = punya.length
    ? punya.map(g => `${hasil.aktif === g.id ? '🔸' : '▫️'} *${g.nama}* — \`.tcg gelar ${g.id.toLowerCase()}\``)
    : ['_Belum ada. Mainkan arena dan gelar akan terbuka sendiri._'];

  // Yang belum terbuka ditampilkan lengkap dengan syaratnya — sebuah daftar
  // gelar terkunci tanpa syarat hanya memberi tahu pemain bahwa ada sesuatu
  // yang dia lewatkan, tanpa memberi tahu caranya.
  const barisBelum = belum.slice(0, 10).map(g => `🔒 ${g.nama} — _${g.petunjuk}_`);

  await send(sock, jid, messageObj, [
    '🏷️ *GELAR ARENA*',
    `Terbuka: *${punya.length}/${hasil.semua.length}*`,
    hasil.baru.length ? `\n🎉 *BARU TERBUKA:* ${hasil.baru.map(g => g.nama).join(', ')}` : '',
    '',
    '*Milikmu:*',
    ...barisPunya,
    '',
    '*Belum terbuka:*',
    ...(barisBelum.length ? barisBelum : ['_Semua gelar sudah kamu kumpulkan. Luar biasa._']),
    belum.length > 10 ? `_…dan ${belum.length - 10} gelar lainnya._` : '',
    '',
    GARIS,
    '`.tcg gelar <id>` — pasang · `.tcg gelar lepas` — copot'
  ].filter(Boolean).join('\n'));
  return true;
}

// ============================================================
// TONGGAK KOLEKSI
// ============================================================

export async function tampilTonggak(sock, jid, messageObj, key, arg) {
  const sub = String(arg || '').toLowerCase();

  if (['klaim', 'ambil', 'claim'].includes(sub)) {
    const res = await db.tcgKlaimTonggak(key);
    if (!res.success) {
      await send(sock, jid, messageObj,
        `📭 Belum ada tonggak baru yang bisa diklaim.\nJenis kartumu sekarang: *${res.unik}/${TOTAL_KARTU}*.`);
      return true;
    }
    await send(sock, jid, messageObj, [
      '🏛️ *TONGGAK KOLEKSI TERKLAIM*',
      '',
      ...res.rincian.map(r => `• *${r.unik} jenis kartu* — ${r.teks.join(' · ')}`),
      '',
      `💠 Total Keping: *+${fmt(res.totalKeping)}* (Saldo: *${fmt(res.kepingTotal)}*)`
    ].join('\n'));
    return true;
  }

  const t = await db.tcgGetTonggak(key);
  const baris = t.daftar.map(x => {
    const tanda = x.diklaim ? '✅' : (x.tercapai ? '🎁' : '⬜');
    const isi = [
      x.keping ? `${fmt(x.keping)} Keping` : '',
      ...(x.serpihan || []).map(s => `${s.jumlah} Serpihan ${s.rarity}`),
      ...(x.item || []).map(i => `${db.tcgGetRansumDef(i.id)?.nama || i.id} ×${i.jumlah}`)
    ].filter(Boolean).join(' · ');
    return `${tanda} *${x.unik} jenis* — ${isi}`;
  });

  await send(sock, jid, messageObj, [
    '🏛️ *TONGGAK KOLEKSI*',
    'Hadiah sekali seumur hidup untuk jumlah *jenis* kartu — duplikat tidak dihitung.',
    '',
    `📚 Koleksimu: *${t.unik}/${TOTAL_KARTU}* jenis`,
    `   └ ${bar(t.unik, TOTAL_KARTU, 14)}`,
    '',
    ...baris,
    '',
    GARIS,
    t.adaKlaim
      ? '🎁 *Ada tonggak siap diklaim!* Ketik `.tcg tonggak klaim`'
      : (t.berikutnya
        ? `➡️ Tonggak berikutnya di *${t.berikutnya.unik} jenis* — kurang *${t.berikutnya.unik - t.unik}* lagi.`
        : '👑 _Semua tonggak sudah kamu raih._')
  ].join('\n'));
  return true;
}

// ============================================================
// MISI MINGGUAN
// ============================================================

export async function tampilMingguan(sock, jid, messageObj, key, arg) {
  const sub = String(arg || '').toLowerCase();

  if (['klaim', 'ambil', 'claim'].includes(sub)) {
    const res = await db.tcgKlaimMisiMingguan(key);
    if (!res.success) {
      await send(sock, jid, messageObj, '📭 Belum ada misi mingguan selesai yang bisa diklaim.\n\nCek `.tcg mingguan`.');
      return true;
    }
    await send(sock, jid, messageObj, [
      '📆 *HADIAH MISI MINGGUAN TERKLAIM*',
      '',
      ...res.rincian.map(r => `• ${r.nama}\n   └ ${r.teks.join(' · ')}`),
      '',
      `💠 Total Keping: *+${fmt(res.totalKeping)}* (Saldo: *${fmt(res.kepingTotal)}*)`
    ].join('\n'));
    return true;
  }

  const m = await db.tcgGetMisiMingguan(key);
  const baris = m.daftar.map(x => {
    const tanda = x.diklaim ? '✅' : (x.selesai ? '🎁' : '⬜');
    const isi = [
      x.hadiah.keping ? `${fmt(x.hadiah.keping)} Keping` : '',
      ...(x.hadiah.serpihan || []).map(s => `${s.jumlah} Serpihan ${s.rarity}`),
      ...(x.hadiah.item || []).map(i => `${db.tcgGetRansumDef(i.id)?.nama || i.id} ×${i.jumlah}`)
    ].filter(Boolean).join(' · ');
    return `${tanda} ${x.emoji} *${x.nama}*\n   └ ${bar(x.progres, x.target)} ${x.progres}/${x.target}\n   └ ${isi}`;
  });

  const bonusTanda = m.bonusDiklaim ? '✅' : (m.bonusSiap ? '🎁' : '⬜');
  const bonusIsi = [
    `${fmt(db.TCG_MISI_MINGGUAN_BONUS.keping)} Keping`,
    ...(db.TCG_MISI_MINGGUAN_BONUS.serpihan || []).map(s => `${s.jumlah} Serpihan ${s.rarity}`),
    ...(db.TCG_MISI_MINGGUAN_BONUS.item || []).map(i => `${db.tcgGetRansumDef(i.id)?.nama || i.id} ×${i.jumlah}`)
  ].join(' · ');

  await send(sock, jid, messageObj, [
    '📆 *MISI MINGGUAN ARENA*',
    `Mulai Senin ${m.minggu} · sisa *${m.sisaHari} hari*`,
    '',
    ...baris,
    '',
    `${bonusTanda} 🏅 *Bonus Tuntas Mingguan* (${m.jumlahSelesai}/${m.daftar.length})`,
    `   └ ${bonusIsi}`,
    '',
    GARIS,
    m.adaKlaim
      ? '🎁 *Ada yang siap diklaim!* Ketik `.tcg mingguan klaim`'
      : '_Progres mingguan terisi otomatis dari aktivitas harianmu._'
  ].join('\n'));
  return true;
}

// ============================================================
// MENARA ABADI
// ============================================================

export async function kelolaAbadi(sock, jid, messageObj, key, aksiArg) {
  const tower = await db.tcgGetTower(key);
  const totalLantai = TOWER_FLOORS.length;

  // Gerbang masuk: Menara Abadi adalah lanjutan, bukan jalur alternatif. Membuka
  // keduanya sekaligus akan membuat pemain baru mengabaikan 30 lantai yang
  // justru mengajari mereka elemen, sinergi, dan biaya bintang.
  if ((tower.highest_floor || 0) < totalLantai) {
    const sisa = totalLantai - (tower.highest_floor || 0);
    await send(sock, jid, messageObj, [
      '🌌 *MENARA ABADI* masih tersegel.',
      '',
      `Taklukkan dulu seluruh *${totalLantai} lantai* Menara Penjaga.`,
      `📍 Lantaimu sekarang: *${tower.highest_floor || 0}/${totalLantai}* — kurang *${sisa} lantai* lagi.`,
      '',
      'Lanjutkan dengan `.tcg menara lawan`.'
    ].join('\n'));
    return true;
  }

  const abadi = await db.tcgGetAbadi(key);
  const energi = await db.tcgGetEnergi(key);
  const target = abadi.berikutnya;
  const lantai = dekAbadi(target);
  const aksi = String(aksiArg || '').toLowerCase();

  if (!['lawan', 'gas', 'fight', 'naik'].includes(aksi)) {
    const hadiah = db.tcgHadiahAbadi(target);
    const isiHadiah = [
      `${fmt(hadiah.keping)} Keping`,
      ...hadiah.serpihan.map(s => `${s.jumlah} Serpihan ${STAT_RARITY[s.rarity].label}`)
    ].join(' · ');

    const penjaga = [1, 2, 3]
      .map(s => lantai.deck[s] && getKartu(lantai.deck[s].card_id))
      .filter(Boolean)
      .map(k => `${ELEMEN[k.elemen].emoji} ${k.nama}`)
      .join(', ');

    await send(sock, jid, messageObj, [
      '🌌 *MENARA ABADI*',
      '_Tidak ada puncaknya. Yang dikejar bukan tamat, tapi seberapa dalam._',
      '',
      `🕳️ Lantai terdalammu: *${abadi.lantai}*`,
      `🎯 Berikutnya: *Lantai ${target}* — _${lantai.nama}_`,
      `   └ Penjaga Lv.${lantai.level} · kekuatan ×${lantai.skala.toFixed(2)} · condong ${ELEMEN[lantai.elemen].emoji} *${ELEMEN[lantai.elemen].nama}*`,
      `   └ ${penjaga}`,
      `   └ Hadiah: ${isiHadiah}`,
      '',
      `⚡ Stamina Menara: *${energi.menara}/${db.TCG_MAX_STAMINA_MENARA}*`,
      '',
      GARIS,
      '➜ `.tcg abadi lawan` untuk menantang.',
      '',
      '_Elemen penjaga berputar tiap lantai — satu dek tidak akan cukup selamanya._',
      '_Kalah tidak menurunkan lantai, tapi tetap memakai stamina._',
      '_Papan terdalam: `.lb abadi`_'
    ].join('\n'));
    return true;
  }

  if (energi.menara <= 0) {
    await send(sock, jid, messageObj, [
      `⚡ Stamina Menara habis (0/${db.TCG_MAX_STAMINA_MENARA}).`,
      '',
      `_Terisi sendiri +1 tiap ${Math.round(db.TCG_REGEN_MENARA_MS / 3600000)} jam. Punya Ransum Pendaki? Cek \`.tcg ransum\`._`
    ].join('\n'));
    return true;
  }

  const deck = await db.tcgGetDeck(key);
  if (!deck[1] && !deck[2] && !deck[3]) {
    await send(sock, jid, messageObj, '⚠️ Dek kamu masih kosong!\nPasang kartu dulu dengan `.tcg pasang <1-3> <id>`.');
    return true;
  }

  const namaKu = messageObj?.pushName || 'Kamu';
  const sim = simulate3v3(deck, lantai.deck, namaKu, `Penjaga ${lantai.nama}`);

  // Stamina dipakai lebih dulu, apa pun hasilnya. Percobaan yang gagal tetap
  // memakan sumber daya yang sedang dijatah — kalau kalah itu gratis, tidak ada
  // alasan untuk menyiapkan dek sama sekali.
  const pakai = await db.tcgPakaiStamina(key, 1);
  if (!pakai?.success && pakai?.reason === 'STAMINA_HABIS') {
    await send(sock, jid, messageObj, '⚡ Stamina Menara keburu habis. Coba lagi setelah terisi.');
    return true;
  }

  if (sim.matchWinner !== 1) {
    await db.tcgCatatGagalAbadi(key);
    const lawanElemen = [...new Set(
      [1, 2, 3].map(s => lantai.deck[s] && getKartu(lantai.deck[s].card_id)).filter(Boolean).map(k => k.elemen)
    )];
    await send(sock, jid, messageObj, [
      `💀 *GAGAL DI LANTAI ABADI ${target}*`,
      `📍 _${lantai.nama}_ · penjaga Lv.${lantai.level} ×${lantai.skala.toFixed(2)}`,
      '',
      ...sim.sinergiReport,
      '',
      ...sim.roundReports,
      '',
      GARIS,
      `❌ *KEKALAHAN (Skor ${sim.scoreA} - ${sim.scoreB})*`,
      `💡 _Penjaga di sini kuat di elemen ${lawanElemen.map(e => ELEMEN[e].nama).join('/')}. Ganti dek dengan \`.tcg pasang\`._`,
      `⚡ Sisa Stamina: *${pakai?.sisaStamina ?? 0}/${db.TCG_MAX_STAMINA_MENARA}*`,
      '',
      `🕳️ Lantai terdalammu tetap *${abadi.lantai}* — kekalahan tidak menurunkannya.`
    ].join('\n'));
    return true;
  }

  const maju = await db.tcgMajuAbadi(key, target);
  if (!maju.success) {
    await send(sock, jid, messageObj, '⚠️ Progres Menara Abadi berubah di tengah jalan. Coba `.tcg abadi` lagi.');
    return true;
  }

  // Kemenangan Abadi juga menghitung misi MENARA. Tanpa ini, pemain yang sudah
  // menamatkan 30 lantai tidak akan pernah bisa menuntaskan misi harian
  // "menangkan 1 pertarungan Menara" — tidak ada lantai tersisa untuk dimenangkan.
  await catatAksi(key, 'MENARA', 1);
  await catatAksi(key, 'ABADI', 1);

  const rekorBaru = target > abadi.lantai;
  await send(sock, jid, messageObj, [
    `🌌 *LANTAI ABADI ${target} DITEMBUS!*`,
    `📍 _${lantai.nama}_ · penjaga Lv.${lantai.level} ×${lantai.skala.toFixed(2)}`,
    '',
    ...sim.sinergiReport,
    '',
    ...sim.roundReports,
    '',
    GARIS,
    `🎉 *KAMU MENANG (Skor ${sim.scoreA} - ${sim.scoreB})*`,
    `🎁 ${maju.teks.join(' · ')}`,
    `⚡ Sisa Stamina: *${pakai?.sisaStamina ?? 0}/${db.TCG_MAX_STAMINA_MENARA}*`,
    rekorBaru ? `\n🕳️ *REKOR BARU:* lantai terdalam *${target}*` : ''
  ].filter(Boolean).join('\n'));
  return true;
}

// ============================================================
// BARTER DUPLIKAT
// ============================================================

/**
 * Tawaran barter yang sedang menunggu, kunci = JID sasaran.
 *
 * Sama seperti duel: disimpan di memori, bukan di database. Tawaran yang
 * menggantung sesudah bot mati justru berbahaya — pemain bisa menerima barter
 * yang dia sudah lupa pernah ditawarkan, dengan kartu yang sudah berubah.
 */
const barterTertunda = new Map();
const BARTER_TIMEOUT_MS = 120000;

function hapusBarter(targetKey) {
  const t = barterTertunda.get(targetKey);
  if (t?.timeout) clearTimeout(t.timeout);
  barterTertunda.delete(targetKey);
}

function labelKartu(id) {
  const k = getKartu(id);
  if (!k) return id;
  return `${ELEMEN[k.elemen].emoji} *${k.nama}* (${k.id}) ${STAT_RARITY[k.rarity].label} ${'★'.repeat(STAT_RARITY[k.rarity].bintang)}`;
}

export async function tawarBarter(sock, jid, messageObj, senderKey, args, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, '❌ Barter hanya bisa dilakukan di dalam grup — supaya semua orang melihat pertukarannya.');
    return true;
  }

  const mention = messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
  const kartuKu = normalisasiIdKartu(args.find(a => getKartu(normalisasiIdKartu(a))) || '');
  const kartuDia = normalisasiIdKartu(
    args.filter(a => getKartu(normalisasiIdKartu(a)))[1] || ''
  );

  if (!mention || !getKartu(kartuKu) || !getKartu(kartuDia)) {
    const sisa = await db.tcgSisaKuotaBarter(senderKey);
    await send(sock, jid, messageObj, [
      '🤝 *BARTER KARTU*',
      '',
      'Format: `.tcg barter @member <kartu_kamu> <kartu_dia>`',
      'Contoh: `.tcg barter @budi RAR03 EPC05`',
      '',
      '*Aturannya:*',
      '• Hanya *duplikat* yang bisa dibarter (kamu harus punya ≥2 salinan).',
      '  Kartu terakhir dari satu jenis tidak akan pernah bisa hilang dari koleksimu.',
      '• Level kartu tidak ikut pindah — yang berpindah kartunya saja.',
      `• Kuota *${db.TCG_BARTER_KUOTA_HARIAN}* barter per hari. Sisa hari ini: *${sisa}*.`,
      '',
      '_Cek duplikatmu dengan `.tcg koleksi`._'
    ].join('\n'));
    return true;
  }

  const targetKey = tcgKey(mention);
  if (targetKey === senderKey) {
    await send(sock, jid, messageObj, '❌ Barter dengan diri sendiri tidak menghasilkan apa-apa.');
    return true;
  }

  const [sisaA, sisaB] = await Promise.all([
    db.tcgSisaKuotaBarter(senderKey),
    db.tcgSisaKuotaBarter(targetKey)
  ]);
  if (sisaA <= 0) {
    await send(sock, jid, messageObj, `🚫 Kuota barter harianmu habis (${db.TCG_BARTER_KUOTA_HARIAN}/hari). Coba lagi besok.`);
    return true;
  }
  if (sisaB <= 0) {
    await send(sock, jid, messageObj, `🚫 Kuota barter harian @${targetKey.split('@')[0]} sudah habis hari ini.`, { mentions: [targetKey] });
    return true;
  }

  const punyaA = await db.tcgPunyaDuplikat(senderKey, kartuKu);
  if (!punyaA.bisa) {
    await send(sock, jid, messageObj, [
      `❌ Kamu tidak punya *duplikat* ${getKartu(kartuKu).nama} (punya: ${punyaA.qty}).`,
      '',
      '_Barter hanya memindahkan salinan lebih. Salinan terakhir selalu tinggal bersamamu._'
    ].join('\n'));
    return true;
  }

  const punyaB = await db.tcgPunyaDuplikat(targetKey, kartuDia);
  if (!punyaB.bisa) {
    await send(sock, jid, messageObj,
      `❌ @${targetKey.split('@')[0]} tidak punya duplikat ${getKartu(kartuDia).nama} (punya: ${punyaB.qty}).`,
      { mentions: [targetKey] });
    return true;
  }

  hapusBarter(targetKey);
  const namaPenawar = messageObj?.pushName || senderKey.split('@')[0];
  const timeout = setTimeout(() => hapusBarter(targetKey), BARTER_TIMEOUT_MS);
  barterTertunda.set(targetKey, { senderKey, targetKey, kartuKu, kartuDia, namaPenawar, jid, timeout });

  await send(sock, jid, messageObj, [
    '🤝 *TAWARAN BARTER KARTU*',
    '',
    `👤 *${namaPenawar}* memberikan:`,
    `   └ ${labelKartu(kartuKu)}`,
    '',
    `🎯 @${targetKey.split('@')[0]} memberikan:`,
    `   └ ${labelKartu(kartuDia)}`,
    '',
    GARIS,
    `👉 @${targetKey.split('@')[0]}, ketik \`.tcg deal\` untuk setuju, atau \`.tcg batal\` untuk menolak.`,
    `_Tawaran hangus dalam ${Math.round(BARTER_TIMEOUT_MS / 1000)} detik. Keduanya kehilangan 1 kuota barter harian._`
  ].join('\n'), { mentions: [targetKey, senderKey] });
  return true;
}

export async function terimaBarter(sock, jid, messageObj, senderKey, isFromGroup) {
  if (!isFromGroup) return true;

  const tawaran = barterTertunda.get(senderKey);
  if (!tawaran || tawaran.jid !== jid) {
    await send(sock, jid, messageObj, '❌ Tidak ada tawaran barter yang ditujukan untukmu saat ini.');
    return true;
  }
  hapusBarter(senderKey);

  if (isOnCooldown(`tcgbarter:${senderKey}`, 3000)) return true;

  // Diperiksa ulang tepat sebelum menukar: di antara tawaran dan persetujuan,
  // salah satu pihak bisa saja menjual, meleburkan, atau membarterkan kartunya.
  const [sisaA, sisaB] = await Promise.all([
    db.tcgSisaKuotaBarter(tawaran.senderKey),
    db.tcgSisaKuotaBarter(senderKey)
  ]);
  if (sisaA <= 0 || sisaB <= 0) {
    await send(sock, jid, messageObj, '🚫 Barter batal: kuota harian salah satu pihak sudah habis.');
    return true;
  }

  const hasil = await db.tcgTukarKartu(tawaran.senderKey, tawaran.kartuKu, senderKey, tawaran.kartuDia);
  if (!hasil.success) {
    await send(sock, jid, messageObj, [
      '❌ Barter batal.',
      '',
      hasil.reason === 'DUPLIKAT_HABIS'
        ? `_${hasil.jid === senderKey ? 'Kamu' : tawaran.namaPenawar} sudah tidak punya duplikat ${getKartu(hasil.kartu)?.nama || hasil.kartu}._`
        : '_Terjadi kesalahan saat menukar._'
    ].join('\n'));
    return true;
  }

  await catatAksi(tawaran.senderKey, 'BARTER', 1);
  await catatAksi(senderKey, 'BARTER', 1);

  const namaPenerima = messageObj?.pushName || senderKey.split('@')[0];
  await send(sock, jid, messageObj, [
    '🤝 *BARTER BERHASIL!*',
    '',
    `*${tawaran.namaPenawar}* menerima:`,
    `   └ ${labelKartu(tawaran.kartuDia)}`,
    '',
    `*${namaPenerima}* menerima:`,
    `   └ ${labelKartu(tawaran.kartuKu)}`,
    '',
    GARIS,
    `_Sisa kuota barter hari ini: ${tawaran.namaPenawar} ${sisaA - 1}, ${namaPenerima} ${sisaB - 1}._`,
    '_Level kartu tidak ikut pindah — kartu baru mulai dari level yang sudah kalian punya._'
  ].join('\n'), { mentions: [tawaran.senderKey, senderKey] });
  return true;
}

export async function tolakBarter(sock, jid, messageObj, senderKey) {
  const tawaran = barterTertunda.get(senderKey);
  if (!tawaran) {
    await send(sock, jid, messageObj, '❌ Tidak ada tawaran barter yang menunggu jawabanmu.');
    return true;
  }
  hapusBarter(senderKey);
  await send(sock, jid, messageObj, `🙅 Tawaran barter dari *${tawaran.namaPenawar}* ditolak.`);
  return true;
}

/** Dipakai router `index.js` untuk memutuskan arti `.tcg batal`. */
export function adaBarterMenunggu(targetKey) {
  return barterTertunda.has(targetKey);
}
