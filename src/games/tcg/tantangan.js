/**
 * ARENA KARTU MONSTER — LAYAR TANTANGAN (GAUNTLET & BOS GRUP)
 *
 * Dua mode yang menjawab dua cacat berbeda:
 *
 *   GAUNTLET menjawab "pemain cuma pernah butuh 3 kartu". Tiga pertarungan
 *   berurutan per pekan, kartu yang sudah bertarung terkunci sampai pekan
 *   berikutnya. Tamat sekali = sembilan kartu terawat.
 *
 *   BOS GRUP menjawab "semua konten arena bisa dimainkan sendirian". Satu
 *   kantong HP milik grup yang cuma tumbang kalau cukup banyak orang memukul.
 *
 * Router-nya tetap satu di `index.js`; berkas ini hanya menyediakan badan
 * perintahnya, mengikuti pola `meta.js`.
 */

import * as db from '../../../database.js';
import { send } from '../helpers.js';
import { getKartu, STAT_RARITY, ELEMEN } from './cards.js';
import {
  simulate3v3, dekGauntlet, GAUNTLET_TAHAP,
  ringkasPenjaga, saranCounter, elemenDek,
  bosPekan, hitungSeranganBos, BOS_PENGALI_UNGGUL, BOS_PENGALI_LEMAH
} from './battle.js';
import { catatAksi } from './meta.js';

const fmt = (n) => Number(n || 0).toLocaleString('id-ID');
const GARIS = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

function bar(nilai, target, lebar = 12) {
  const t = Math.max(1, target);
  const isi = Math.max(0, Math.min(lebar, Math.round((nilai / t) * lebar)));
  return '▰'.repeat(isi) + '▱'.repeat(lebar - isi);
}

/** Kartu yang sedang terpasang di dek, sebagai daftar id. */
function idDek(deck) {
  return [1, 2, 3].map(s => deck?.[s]?.card_id).filter(Boolean);
}

function teksHadiah(h) {
  const bagian = [`${fmt(h.keping)} Keping`];
  for (const s of h.serpihan || []) {
    bagian.push(`${s.jumlah} Serpihan ${STAT_RARITY[s.rarity]?.label || s.rarity}`);
  }
  return bagian.join(' · ');
}


// ============================================================
// GAUNTLET PEKANAN
// ============================================================

export async function kelolaGauntlet(sock, jid, messageObj, key, aksiArg, pushName) {
  const aksi = String(aksiArg || '').toLowerCase();
  const state = await db.tcgGetGauntlet(key);

  // `.tcg gauntlet dek` — susun otomatis dari kartu yang MASIH boleh dipakai.
  // Tanpa jalan pintas ini, tahap 2 dan 3 berubah jadi pekerjaan mengetik:
  // pemain harus membuka koleksi, mengingat sembilan id, lalu memasang satu
  // per satu sambil menghindari kartu yang sudah terkunci.
  if (['dek', 'deck', 'auto', 'autodek', 'susun'].includes(aksi)) {
    return await susunDekGauntlet(sock, jid, messageObj, key, state);
  }

  if (['lawan', 'gas', 'fight', 'mulai'].includes(aksi)) {
    return await lawanGauntlet(sock, jid, messageObj, key, state, pushName);
  }

  const tuntas = state.tuntas;
  const tahapBerikut = Math.min(GAUNTLET_TAHAP, state.berikutnya);
  const lawan = dekGauntlet(state.minggu, tahapBerikut);
  const counter = saranCounter(lawan.deck);
  const hadiah = db.TCG_GAUNTLET_HADIAH[tahapBerikut - 1];

  const terkunci = state.kartuTerpakai
    .map(id => getKartu(id))
    .filter(Boolean)
    .map(k => `${ELEMEN[k.elemen].emoji} ${k.nama}`);

  const baris = [
    '🏟️ *GAUNTLET PEKANAN*',
    '_Tiga pertarungan. Kartu yang sudah bertarung tidak boleh dipakai lagi._',
    '',
    `📅 Pekan: *${state.minggu}*`,
    `📊 Kemajuan: ${bar(state.tahap, GAUNTLET_TAHAP, 3)} *${state.tahap}/${GAUNTLET_TAHAP} tahap*`,
    `🎟️ Sisa percobaan: *${state.sisaPercobaan}/${db.TCG_GAUNTLET_PERCOBAAN}*`,
    ''
  ];

  if (tuntas) {
    baris.push(
      '🏆 *PEKAN INI SUDAH TUNTAS.*',
      'Ketiga lawan sudah kamu jatuhkan. Gauntlet baru terbuka Senin depan dengan tiga lawan berbeda.',
      '',
      terkunci.length ? `🔒 Kartu yang kamu pakai pekan ini:\n   ${terkunci.join(', ')}` : ''
    );
  } else if (state.sisaPercobaan <= 0) {
    baris.push(
      '🚫 *PERCOBAAN PEKAN INI HABIS.*',
      `Kamu berhenti di tahap *${state.tahap}/${GAUNTLET_TAHAP}*. Coba lagi Senin depan.`
    );
  } else {
    baris.push(
      `🎯 *TAHAP ${tahapBerikut}/${GAUNTLET_TAHAP} — ${lawan.nama}*`,
      `   └ Dek Lv.${lawan.level}${lawan.skala > 1 ? ` · kekuatan ×${lawan.skala.toFixed(2)}` : ''}`,
      ...ringkasPenjaga(lawan.deck),
      counter ? `   └ 💡 Unggul melawan mereka: ${counter}` : '',
      `   └ 🎁 Hadiah: ${teksHadiah(hadiah)}`,
      ''
    );
    if (terkunci.length) {
      baris.push(`🔒 *Terkunci pekan ini:* ${terkunci.join(', ')}`, '');
    }
    baris.push(
      GARIS,
      '➜ `.tcg gauntlet dek` — susun otomatis dari kartu yang masih boleh',
      '➜ `.tcg gauntlet lawan` — bertarung sekarang'
    );
  }

  baris.push(
    '',
    '_Kalah tidak mengunci kartu — yang terpakai cuma satu percobaan._',
    `_Tuntas 3 tahap: bonus +${fmt(db.TCG_GAUNTLET_BONUS_TUNTAS)} Keping._`
  );

  await send(sock, jid, messageObj, baris.filter(Boolean).join('\n'));
  return true;
}

async function susunDekGauntlet(sock, jid, messageObj, key, state) {
  if (state.tuntas) {
    await send(sock, jid, messageObj, '🏆 Gauntlet pekan ini sudah tuntas — tidak ada tahap yang perlu disusun.');
    return true;
  }

  const tahapBerikut = Math.min(GAUNTLET_TAHAP, state.berikutnya);
  const lawan = dekGauntlet(state.minggu, tahapBerikut);

  // Elemen lawan dipakai sebagai sasaran counter, bukan cuma daya mentah.
  // Dek lawan bisa memuat lebih dari satu elemen; yang dijadikan sasaran adalah
  // yang pertama — memilih satu sasaran nyata lebih berguna daripada
  // merata-ratakan semuanya jadi netral.
  const sasaran = elemenDek(lawan.deck)[0] || null;

  const res = await db.tcgAutoBuildDeck(key, {
    lawanElemen: sasaran,
    kecuali: state.kartuTerpakai
  });

  if (!res.success) {
    const pesan = {
      KOLEKSI_KOSONG: '📭 Kamu belum punya kartu apa pun. Ketik `.tcg mulai` dulu.',
      KARTU_TERSISA_HABIS: '🔒 Semua kartumu sudah terpakai di tahap sebelumnya.\n\n_Gauntlet memang menuntut koleksi yang lebar — kumpulkan kartu baru lewat `.tcg gacha`, lalu coba lagi pekan depan._',
      SEMUA_KARTU_EKSPEDISI: '🧭 Semua kartumu sedang pergi ekspedisi. Klaim dulu dengan `.tcg ekspedisi klaim`.',
      TIDAK_DAPAT_DISUSUN: '⚠️ Tidak ada kombinasi yang bisa disusun dari kartu yang tersisa.'
    }[res.reason] || '❌ Gagal menyusun dek Gauntlet.';
    await send(sock, jid, messageObj, pesan);
    return true;
  }

  const slot = res.deck.map(c => {
    const el = ELEMEN[c.elemen] || { emoji: '✨' };
    return `*Slot ${c.slot}:* ${el.emoji} *${c.nama}* (Lv.${c.level}) · ${c.cost}★ · ⚡${fmt(c.power)}`;
  });

  await send(sock, jid, messageObj, [
    `🤖 *DEK GAUNTLET TAHAP ${tahapBerikut} TERPASANG*`,
    GARIS,
    sasaran
      ? `Disusun untuk menghadapi ${ELEMEN[sasaran].emoji} *${ELEMEN[sasaran].nama}*, dari kartu yang belum terkunci:`
      : 'Disusun dari kartu yang belum terkunci:',
    '',
    ...slot,
    '',
    `⭐ Total: *${res.totalCost}/${res.maxCost}★* · ⚔️ Power: *${fmt(res.totalPower)}*`,
    '',
    '➜ Lanjut: `.tcg gauntlet lawan`'
  ].join('\n'));
  return true;
}

async function lawanGauntlet(sock, jid, messageObj, key, state, pushName) {
  if (state.tuntas) {
    await send(sock, jid, messageObj, '🏆 Gauntlet pekan ini sudah tuntas. Lawan baru terbuka Senin depan.');
    return true;
  }
  if (state.sisaPercobaan <= 0) {
    await send(sock, jid, messageObj, [
      '🎟️ *Percobaan Gauntlet pekan ini habis.*',
      `Kamu berhenti di tahap *${state.tahap}/${GAUNTLET_TAHAP}*.`,
      '',
      '_Jatahnya kembali penuh tiap Senin._'
    ].join('\n'));
    return true;
  }

  const deck = await db.tcgGetDeck(key);
  const idKu = idDek(deck);
  if (idKu.length < 3) {
    // Tiga slot WAJIB terisi. Slot kosong memang mengalah di mesin tempur, tapi
    // skor 2-1 tetap kemenangan sah — jadi dek 2 kartu bisa menuntaskan Gauntlet
    // dengan enam kartu saja, dan itu membatalkan seluruh alasan mode ini ada.
    await send(sock, jid, messageObj, [
      idKu.length === 0
        ? '⚠️ Dekmu masih kosong.'
        : `⚠️ Dekmu baru terisi *${idKu.length}/3 slot*.`,
      '',
      'Gauntlet menuntut *tiga slot penuh* di setiap tahap — itulah sebabnya tuntas satu pekan butuh sembilan kartu, bukan tiga.',
      '',
      '➜ `.tcg gauntlet dek` — susun otomatis dari kartu yang belum terkunci',
      '➜ `.tcg pasang <1-3> <id>` — atur sendiri'
    ].join('\n'));
    return true;
  }

  // Aturan inti Gauntlet. Diperiksa SEBELUM percobaan dipotong — melanggar
  // aturan penyusunan bukan kekalahan, jadi tidak boleh memakan jatah.
  const bentrok = idKu.filter(id => state.kartuTerpakai.includes(id));
  if (bentrok.length) {
    const nama = bentrok.map(id => getKartu(id)?.nama || id).join(', ');
    await send(sock, jid, messageObj, [
      '🔒 *KARTU SUDAH TERPAKAI DI TAHAP SEBELUMNYA*',
      '',
      `Dekmu memakai: *${nama}*`,
      '',
      'Gauntlet menuntut wajah baru tiap tahap. Ganti dengan kartu lain, atau ketik `.tcg gauntlet dek` untuk menyusunnya otomatis.'
    ].join('\n'));
    return true;
  }

  const tahap = Math.min(GAUNTLET_TAHAP, state.berikutnya);
  const lawan = dekGauntlet(state.minggu, tahap);

  const pakai = await db.tcgPakaiPercobaanGauntlet(key);
  if (!pakai.success) {
    await send(sock, jid, messageObj, '🎟️ Percobaan Gauntlet keburu habis. Coba lagi Senin depan.');
    return true;
  }

  const namaKu = pushName || 'Kamu';
  const sim = simulate3v3(deck, lawan.deck, namaKu, lawan.nama);

  if (sim.matchWinner !== 1) {
    const counter = saranCounter(lawan.deck);
    await send(sock, jid, messageObj, [
      `💀 *GAGAL DI TAHAP ${tahap}/${GAUNTLET_TAHAP}* — ${lawan.nama}`,
      '',
      ...sim.sinergiReport,
      '',
      ...sim.roundReports,
      '',
      GARIS,
      `❌ *KALAH (Skor ${sim.scoreA} - ${sim.scoreB})*`,
      counter ? `💡 _Yang unggul melawan mereka: ${counter}._` : '',
      `🎟️ Sisa percobaan: *${pakai.sisa}/${db.TCG_GAUNTLET_PERCOBAAN}*`,
      '',
      '_Kartu yang kalah tidak ikut terkunci — kamu boleh memakainya lagi._'
    ].filter(Boolean).join('\n'));
    return true;
  }

  const menang = await db.tcgMenangGauntlet(key, tahap, idKu);
  if (!menang.success) {
    await send(sock, jid, messageObj, '⚠️ Kemajuan Gauntlet berubah di tengah jalan. Cek ulang dengan `.tcg gauntlet`.');
    return true;
  }

  await catatAksi(key, 'GAUNTLET', 1);

  const kunci = menang.kartuTerpakai
    .map(id => getKartu(id))
    .filter(Boolean)
    .map(k => `${ELEMEN[k.elemen].emoji} ${k.nama}`)
    .join(', ');

  const ekor = menang.tuntas
    ? [
        '',
        '🏆 *GAUNTLET PEKAN INI TUNTAS!*',
        `🎁 Bonus tuntas: *+${fmt(menang.bonusTuntas)} Keping*`,
        '',
        '_Tiga lawan baru menunggu Senin depan, dan seluruh kartumu terbuka lagi._'
      ]
    : [
        '',
        `➜ Tahap berikutnya: *${menang.tahap + 1}/${GAUNTLET_TAHAP}* — ketik \`.tcg gauntlet\``,
        '_Ingat: kartu di atas sekarang terkunci sampai pekan depan._'
      ];

  await send(sock, jid, messageObj, [
    `✅ *TAHAP ${tahap}/${GAUNTLET_TAHAP} DITAKLUKKAN!* — ${lawan.nama}`,
    '',
    ...sim.sinergiReport,
    '',
    ...sim.roundReports,
    '',
    GARIS,
    `🎉 *MENANG (Skor ${sim.scoreA} - ${sim.scoreB})*`,
    `🎁 +${fmt(menang.keping)} Keping${menang.serpihan?.length ? ' · ' + menang.serpihan.map(s => `${s.jumlah} Serpihan ${STAT_RARITY[s.rarity]?.label || s.rarity}`).join(' · ') : ''}`,
    `💠 Saldo Keping: *${fmt(menang.sisaKeping)}*`,
    `🔒 Terkunci: ${kunci}`,
    ...ekor
  ].join('\n'));
  return true;
}


// ============================================================
// BOS ARENA GRUP
// ============================================================

export async function kelolaBos(sock, jid, messageObj, key, aksiArg, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, [
      '👹 *BOS ARENA* hanya hidup di dalam grup.',
      '',
      'Bosnya milik grup, bukan milik pemain: HP-nya satu untuk semua dan cuma tumbang kalau cukup banyak orang ikut memukul.',
      '',
      '_Buka grup yang arenanya aktif, lalu ketik `.tcg bos`._'
    ].join('\n'));
    return true;
  }

  const aksi = String(aksiArg || '').toLowerCase();

  // Bereskan dulu bos yang hadiahnya menggantung: sudah tumbang tapi belum
  // sempat dibayar (bot mati di antara dua transaksi), atau pekannya sudah lewat
  // sementara ia masih hidup. Dua-duanya dulu berarti sumbangan sepekan penuh
  // satu grup hangus tanpa satu Keping pun, tanpa jalan pemulihan selain SQL.
  const tertunda = await db.tcgBosBelumDibereskan(jid);
  const laporanTertunda = [];
  for (const t of tertunda) {
    const bagi = await db.tcgBagiHadiahBos(jid, t.minggu);
    if (!bagi.success || !bagi.bagian?.length) continue;
    const rincian = bagi.bagian
      .map(b => `   • @${b.ownerJid.split('@')[0]} — *${fmt(b.keping)} Keping*`)
      .join('\n');
    laporanTertunda.push({
      teks: [
        bagi.tumbang
          ? `🏁 *HADIAH ${String(t.nama).toUpperCase()} DIBAYARKAN* _(tertunda)_`
          : `⏳ *PEKAN ${t.minggu} DITUTUP — ${String(t.nama).toUpperCase()} SELAMAT`,
        bagi.tumbang
          ? ''
          : `Grup sempat mengikis *${Math.round(bagi.porsiKerusakan * 100)}%* HP-nya. Hadiah dibayar sebanding kerusakan itu.`,
        rincian
      ].filter(Boolean).join('\n'),
      mentions: bagi.bagian.map(b => b.ownerJid)
    });
  }
  for (const l of laporanTertunda) {
    await send(sock, jid, messageObj, l.teks, { mentions: l.mentions });
  }

  const info = bosPekan(db.tcgKunciPekan());
  const bos = await db.tcgGetBos(jid, info);

  if (!bos) {
    await send(sock, jid, messageObj, '⚠️ Gagal memanggil Bos Arena. Coba lagi sebentar lagi.');
    return true;
  }

  if (['serang', 'gas', 'pukul', 'attack', 'hit'].includes(aksi)) {
    return await serangBos(sock, jid, messageObj, key, bos);
  }

  const papan = await db.tcgPapanBos(jid, bos.minggu);
  const jatah = await db.tcgSisaJatahBos(key);
  const saya = papan.find(p => p.owner_jid === key);
  const el = ELEMEN[bos.elemen] || { emoji: '✨', nama: bos.elemen };

  const mentions = [];
  const barisPapan = papan.slice(0, 5).map((p, i) => {
    mentions.push(p.owner_jid);
    const medali = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
    return `${medali} @${p.owner_jid.split('@')[0]} — *${fmt(p.damage)}* _(${p.serangan}x)_`;
  });

  if (!bos.hidup) {
    await send(sock, jid, messageObj, [
      `☠️ *${bos.nama.toUpperCase()} SUDAH TUMBANG PEKAN INI*`,
      GARIS,
      `${el.emoji} Elemen: *${el.nama}* · ${bos.penantang} penantang · ${fmt(bos.hp_maks)} HP`,
      '',
      barisPapan.length ? '🏅 *PEMUKUL TERBESAR:*' : '',
      ...barisPapan,
      '',
      '_Bos baru bangun tiap Senin dengan nama, elemen, dan HP yang berbeda._'
    ].filter(Boolean).join('\n'), { mentions });
    return true;
  }

  const persen = Math.max(0, Math.round((bos.hp / Math.max(1, bos.hp_maks)) * 100));
  const counter = [...Object.keys(ELEMEN)]
    .filter(e => ELEMEN[e].unggul.includes(bos.elemen))
    .map(e => `${ELEMEN[e].emoji} ${ELEMEN[e].nama}`)
    .join(' / ');

  await send(sock, jid, messageObj, [
    `👹 *${bos.nama.toUpperCase()}*`,
    `_Bos Arena pekan ${bos.minggu} — milik grup ini._`,
    '',
    `${el.emoji} Elemen: *${el.nama}*`,
    `❤️ ${bar(bos.hp, bos.hp_maks)} *${persen}%*`,
    `   └ *${fmt(bos.hp)}* / ${fmt(bos.hp_maks)} HP`,
    `👥 Penantang: *${bos.penantang}* · total ${fmt(bos.totalSerangan)} serangan`,
    '',
    `⚔️ Sumbanganmu: *${fmt(saya?.damage || 0)}* damage _(${saya?.serangan || 0}x)_`,
    `🎟️ Jatah seranganmu hari ini: *${jatah.sisa}/${db.TCG_BOS_JATAH_HARIAN}*`,
    '',
    counter ? `💡 *Bawa ${counter}* — unggul elemen memukul ×${BOS_PENGALI_UNGGUL} di sini, yang lemah cuma ×${BOS_PENGALI_LEMAH}.` : '',
    '',
    barisPapan.length ? '🏅 *PAPAN SUMBANGAN:*' : '_Belum ada yang memukul. Jadilah yang pertama._',
    ...barisPapan,
    '',
    GARIS,
    '➜ `.tcg bos serang` — pukul dengan dek aktifmu',
    '',
    '_HP bos bertambah tiap ada penantang baru, jadi bos di grup ramai memang lebih besar — dan hadiahnya juga._',
    '_Hadiah dibagi menurut sumbangan damage saat bos tumbang._'
  ].filter(Boolean).join('\n'), { mentions });
  return true;
}

async function serangBos(sock, jid, messageObj, key, bos) {
  if (!bos.hidup) {
    await send(sock, jid, messageObj, `☠️ *${bos.nama}* sudah tumbang pekan ini. Bos baru bangun Senin depan.`);
    return true;
  }

  const jatah = await db.tcgSisaJatahBos(key);
  if (jatah.sisa <= 0) {
    await send(sock, jid, messageObj, [
      `🎟️ *Jatah seranganmu hari ini habis* (${db.TCG_BOS_JATAH_HARIAN}/${db.TCG_BOS_JATAH_HARIAN}).`,
      '',
      '_Jatah kembali penuh besok pagi. Bos hidup sampai Minggu — masih ada waktu._'
    ].join('\n'));
    return true;
  }

  const deck = await db.tcgGetDeck(key);
  if (!idDek(deck).length) {
    await send(sock, jid, messageObj, '⚠️ Dekmu masih kosong! Pasang kartu dulu dengan `.tcg autodek`.');
    return true;
  }

  const pukulan = hitungSeranganBos(deck, bos.elemen);
  const hasil = await db.tcgSerangBos(jid, key, pukulan.total);

  if (!hasil.success) {
    const pesan = {
      JATAH_HABIS: '🎟️ Jatah seranganmu hari ini keburu habis.',
      SUDAH_TUMBANG: `☠️ *${bos.nama}* sudah tumbang lebih dulu oleh pemain lain!`,
      BOS_TIDAK_ADA: '⚠️ Bos pekan ini tidak ditemukan. Ketik `.tcg bos` untuk memanggilnya.'
    }[hasil.reason] || '❌ Serangan gagal diproses.';
    await send(sock, jid, messageObj, pesan);
    return true;
  }

  await catatAksi(key, 'BOS', 1);

  const rincian = pukulan.rincian.map(r => {
    const el = ELEMEN[r.elemen] || { emoji: '✨' };
    const tanda = r.mult > 1 ? ' ✨unggul' : (r.mult < 1 ? ' 🔻lemah' : '');
    return `   ${el.emoji} ${r.nama}: *${fmt(r.dmg)}*${tanda}`;
  });

  const persen = Math.max(0, Math.round((hasil.hp / Math.max(1, hasil.hpMaks)) * 100));

  const kepala = [
    `⚔️ *SERANGAN KE ${bos.nama.toUpperCase()}*`,
    GARIS,
    ...rincian,
    '',
    `💥 Total damage: *${fmt(hasil.damage)}*`,
    hasil.penantangBaru ? `👥 _Kamu penantang baru — HP bos bertambah ${fmt(db.TCG_BOS_HP_PER_PENANTANG)}._` : '',
    ''
  ];

  if (!hasil.tumbang) {
    await send(sock, jid, messageObj, [
      ...kepala,
      `❤️ ${bar(hasil.hp, hasil.hpMaks)} *${persen}%*`,
      `   └ *${fmt(hasil.hp)}* / ${fmt(hasil.hpMaks)} HP`,
      '',
      `📊 Sumbanganmu: *${fmt(hasil.damageSaya)}* damage _(${hasil.seranganSaya}x)_`,
      `🎟️ Sisa jatah hari ini: *${hasil.sisaJatah}/${db.TCG_BOS_JATAH_HARIAN}*`
    ].filter(Boolean).join('\n'));
    return true;
  }

  // --- BOS TUMBANG ---
  const bagi = await db.tcgBagiHadiahBos(jid, bos.minggu);
  const mentions = [];
  const barisHadiah = [];

  if (bagi.success) {
    for (const b of bagi.bagian) {
      mentions.push(b.ownerJid);
      const serp = b.serpihan.map(s => `${s.jumlah} ${STAT_RARITY[s.rarity]?.label || s.rarity}`).join(' + ');
      barisHadiah.push(
        `${b.puncak ? '👑' : '•'} @${b.ownerJid.split('@')[0]} — *${fmt(b.keping)} Keping* · ${serp}` +
        `\n     _${fmt(b.damage)} damage (${Math.round(b.porsi * 100)}%)_`
      );
    }
  }

  await send(sock, jid, messageObj, [
    ...kepala,
    '☠️ ' + GARIS,
    `🎉 *${bos.nama.toUpperCase()} TUMBANG!*`,
    `Pukulan terakhir oleh @${key.split('@')[0]}.`,
    '',
    `👥 ${hasil.penantang} penantang · ${fmt(hasil.hpMaks)} HP diratakan.`,
    '',
    bagi.success ? `🎁 *PEMBAGIAN HADIAH* _(kolam ${fmt(bagi.kolam)} Keping)_` : '',
    ...barisHadiah,
    '',
    '_Bos berikutnya bangun Senin depan dengan nama dan elemen berbeda._'
  ].filter(Boolean).join('\n'), { mentions: [...new Set([...mentions, key])] });
  return true;
}
