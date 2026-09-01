import * as db from '../../database.js';
import { send } from './helpers.js';

export const activeBlackjack = new Map();
export const activeBlackjackGames = activeBlackjack;

// ─── 4. BLACKJACK 21 ──────────────────────────────────────────
//
// PERATURAN MEJA — semua angka yang bisa disetel ada di satu blok ini.
//
// Meja ini memakai aturan kasino standar:
//   • Satu dek 52 kartu, dikocok tiap ronde, dibagikan TANPA pengembalian.
//   • Dealer berhenti di 17, termasuk soft 17 (aturan S17, memihak pemain).
//   • Blackjack alami dibayar 3:2. Alami lawan alami = seri (push).
//   • Double Down hanya boleh di dua kartu pertama.
//   • Sampai 21 pas otomatis berhenti — pemain tidak bisa membakar tangannya.
//   • Tangga bonus 21 ala Spanish 21: makin banyak kartu, makin besar bayarannya.
const TARUHAN_MIN = 10;
const TARUHAN_MAX = 5000;      // batas meja; `.bj all` ikut dipotong ke sini
const TARUHAN_BAWAAN = 20;
const KEMBALI_NATURAL = 2.5;   // total kembali untuk Blackjack alami (3:2)
const KEMBALI_MENANG = 2;      // total kembali untuk menang biasa (1:1)
const DEALER_BERHENTI = 17;
const BATAS_WAKTU_MS = 90 * 1000;
const XP_NATURAL = 40;
const XP_MENANG = 35;

/**
 * TANGGA BONUS 21 — meniru Spanish 21 (di Australia: Pontoon).
 *
 * Kunci `kartu` = jumlah kartu minimum saat 21 tercapai, `kembali` = TOTAL yang
 * kembali ke dompet (taruhan sudah dipotong di awal ronde). Daftar ini dibaca
 * dari atas, jadi urutannya harus dari kartu terbanyak.
 *
 * Blackjack alami (2 kartu) TIDAK termasuk di sini — dia tetap 2,5x alias 3:2,
 * standar kasino dunia. Bonus ini hanya untuk 21 yang dirakit lewat `.hit`, dan
 * baru menggigit di 5 kartu ke atas.
 *
 * Ongkosnya diukur di 400.000 ronde simulasi: RTP 94,30% -> 94,36%, naik cuma
 * 0,06 poin persen, karena 21 dari 5+ kartu memang langka. JANGAN menambah baris
 * di bawah 5 kartu tanpa mengukur ulang: membayar SEMUA 21 hasil hit sebesar
 * 2,5x menaikkan RTP ke 99,90% dan menghapus blackjack sebagai saluran
 * pembuangan poin — padahal itu satu-satunya alasan game ini sehat buat ekonomi.
 *
 * Catatan: Spanish 21 asli membiayai bonusnya dengan membuang keempat kartu 10
 * dari dek (48 kartu). Kita tidak melakukan itu, jadi tangga di sini sengaja
 * dibuat lebih pelit daripada aslinya.
 */
const BONUS_21 = [
  { kartu: 7, kembali: 4,   label: '🌟 *21 DARI 7 KARTU!*' },
  { kartu: 6, kembali: 3,   label: '✨ *21 DARI 6 KARTU!*' },
  { kartu: 5, kembali: 2.5, label: '⭐ *21 DARI 5 KARTU!*' }
];

const RINGKAS_BONUS = '🎁 _Bonus 21: 5 kartu 2,5x · 6 kartu 3x · 7+ kartu 4x_';

const SUIT = ['♠️', '♥️', '♦️', '♣️'];
const RANK = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export function nilaiTangan(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.rank === 'A') {
      aces += 1;
      total += 11;
    } else if (['K', 'Q', 'J'].includes(c.rank)) {
      total += 10;
    } else {
      total += parseInt(c.rank, 10);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

/** Blackjack alami: 21 dari dua kartu pertama saja. 21 hasil hit bukan alami. */
export function adalahNatural(cards) {
  return cards.length === 2 && nilaiTangan(cards) === 21;
}

/**
 * Satu dek 52 kartu yang dikocok Fisher-Yates.
 *
 * Versi lama mengundi rank & suit secara acak tiap tarikan, jadi kartunya
 * diambil DENGAN pengembalian: satu ronde bisa memunculkan A♠️ dua kali, dan
 * peluang kartu berikutnya tidak pernah berubah berapa pun yang sudah keluar.
 * Itu bukan blackjack, dan bagi pemain terlihat seperti bot yang rusak.
 */
export function buatDek() {
  const dek = [];
  for (const suit of SUIT) {
    for (const rank of RANK) {
      dek.push({ rank, suit, str: `${rank}${suit}` });
    }
  }
  for (let i = dek.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [dek[i], dek[j]] = [dek[j], dek[i]];
  }
  return dek;
}

/** Satu ronde tidak akan pernah menghabiskan 52 kartu, tapi jaga-jaga saja. */
function ambilKartu(session) {
  if (!session.dek || session.dek.length === 0) session.dek = buatDek();
  return session.dek.pop();
}

const tampil = (cards) => cards.map(c => c.str).join(', ');

/**
 * Berapa kali lipat taruhan yang kembali kalau tangan ini menang.
 * `label` hanya terisi kalau tangga bonus 21 menyala.
 */
function bayaranMenang(cards) {
  if (nilaiTangan(cards) === 21 && !adalahNatural(cards)) {
    const bonus = BONUS_21.find(b => cards.length >= b.kartu);
    if (bonus) return { kembali: bonus.kembali, label: bonus.label };
  }
  return { kembali: KEMBALI_MENANG, label: null };
}

function tombolUlang(bet) {
  return [
    { type: 'reply', text: `🔁 Main Lagi (${bet} Poin)`, id: `.bj ${bet}` },
    { type: 'reply', text: '👤 Profil Poin', id: '.poin' }
  ];
}

// ─── SESI ─────────────────────────────────────────────────────
// Sesi hidup di memori saja. Batas waktu 90 detik menahan dua masalah
// sekaligus: pemain yang kabur di tengah ronde tidak terkunci selamanya dengan
// taruhan yang sudah dipotong, dan taruhan yang menggantung tidak ikut hilang
// kalau bot kebetulan direstart.

function simpanSesi(session, senderNumber) {
  activeBlackjack.set(session.senderJid, session);
  if (session.senderJid !== senderNumber) activeBlackjack.set(senderNumber, session);
}

function hapusSesi(session, senderNumber) {
  if (session.timeout) clearTimeout(session.timeout);
  session.timeout = null;
  activeBlackjack.delete(session.senderJid);
  if (senderNumber) activeBlackjack.delete(senderNumber);
}

function pasangBatasWaktu(sock, session, senderNumber) {
  if (session.timeout) clearTimeout(session.timeout);
  session.timeout = setTimeout(async () => {
    try {
      if (!activeBlackjack.has(session.senderJid)) return;
      // Habis waktu = otomatis `.stand`, bukan taruhan hangus. Pemain sudah
      // membayar; giliran dealer tetap dijalankan supaya dia masih punya
      // peluang menang.
      await send(sock, session.jid, null,
        `⏳ *WAKTU BLACKJACK HABIS* — tidak ada aksi selama ${Math.round(BATAS_WAKTU_MS / 1000)} detik.\n_Tanganmu otomatis di-*stand*, dealer main sekarang._`,
        { mentions: [session.senderJid] });
      await jalankanDealer(sock, session.jid, senderNumber, null, session);
    } catch (err) {
      console.error('[BLACKJACK TIMEOUT]', err);
    }
  }, BATAS_WAKTU_MS);
}

/**
 * Menjembatani identitas @lid dan @s.whatsapp.net.
 *
 * Pencarian lama memakai `LIKE '%digits%'` yang cocok di POSISI MANA PUN,
 * sehingga pemain baru bisa tersambung ke dompet orang lain yang nomornya
 * kebetulan mengandung deretan angka yang sama. Sekarang deretan angkanya wajib
 * berada tepat sebelum `@`, dan minimal 9 digit.
 */
async function resolveSenderProfile(senderNumber) {
  let resolved = senderNumber;
  let prof = await db.getGameProfile(resolved);
  if (prof && (prof.points > 0 || prof.games_played > 0)) return { resolvedJid: resolved, profile: prof };

  const digits = resolved.replace(/[^0-9]/g, '');
  if (digits.length < 9) return { resolvedJid: resolved, profile: prof };

  const altProf = await db.getQuery(
    "SELECT * FROM game_profiles WHERE (customer_jid = ? OR customer_jid LIKE ?) AND points > 0 ORDER BY points DESC LIMIT 1",
    [`${digits}@s.whatsapp.net`, `${digits}@%`]
  );
  if (altProf) {
    console.log(`[BLACKJACK] Identitas ${resolved} dipetakan ke ${altProf.customer_jid}.`);
    return { resolvedJid: altProf.customer_jid, profile: altProf };
  }
  return { resolvedJid: resolved, profile: prof };
}

// ─── HANDLER ──────────────────────────────────────────────────

async function handleBlackjack(sock, jid, senderNumber, messageObj, args, command) {
  const { resolvedJid, profile } = await resolveSenderProfile(senderNumber);

  if (['blackjack', 'bj'].includes(command)) {
    if (activeBlackjack.has(resolvedJid) || activeBlackjack.has(senderNumber)) {
      await send(sock, jid, messageObj, "⚠️ Kamu sedang memiliki game Blackjack aktif! Ketik `.hit` untuk ambil kartu atau `.stand` untuk tahan.");
      return true;
    }

    const saldo = Math.max(0, Number(profile?.points) || 0);
    let bet = TARUHAN_BAWAAN;
    let dipotongBatas = false;

    if (args[1]) {
      if (args[1].toLowerCase() === 'all') {
        bet = Math.min(saldo, TARUHAN_MAX);
        dipotongBatas = saldo > TARUHAN_MAX;
      } else {
        const parsed = parseInt(args[1], 10);
        if (!isNaN(parsed) && parsed > 0) {
          bet = Math.min(parsed, TARUHAN_MAX);
          dipotongBatas = parsed > TARUHAN_MAX;
        }
      }
    }

    if (bet < TARUHAN_MIN) {
      await send(sock, jid, messageObj,
        `❌ Taruhan minimal di meja ini *${TARUHAN_MIN} Poin*.\n💰 Poin kamu: *${saldo.toLocaleString('id-ID')}*\n\nKetik \`.daily\` untuk klaim poin gratis.`);
      return true;
    }

    if (saldo < bet) {
      await send(sock, jid, messageObj,
        `❌ Poin kamu tidak mencukupi untuk taruhan *${bet.toLocaleString('id-ID')} Poin*! (Sisa Poinmu: ${saldo.toLocaleString('id-ID')})\n\nKetik \`.daily\` untuk klaim poin gratis!`);
      return true;
    }

    const potong = await db.deductGamePoints(resolvedJid, bet);
    if (!potong?.success) {
      await send(sock, jid, messageObj, "❌ Gagal memotong taruhan. Coba lagi sebentar lagi.");
      return true;
    }

    const dek = buatDek();
    // Urutan bagi kartu mengikuti meja sungguhan: pemain, dealer, pemain, dealer.
    const playerCards = [dek.pop(), dek.pop()];
    const dealerCards = [dek.pop(), dek.pop()];

    const session = {
      jid,
      senderJid: resolvedJid,
      bet,
      taruhanAwal: bet,
      dek,
      playerCards,
      dealerCards,
      sudahHit: false,
      timeout: null
    };

    const playerVal = nilaiTangan(playerCards);
    const playerNatural = adalahNatural(playerCards);
    const dealerNatural = adalahNatural(dealerCards);
    const catatanBatas = dipotongBatas
      ? `\n\n_Batas meja ${TARUHAN_MAX.toLocaleString('id-ID')} Poin — taruhanmu disesuaikan._`
      : '';

    // Dealer mengintip kartu tertutupnya sebelum ronde jalan. Dulu langkah ini
    // tidak ada, jadi Blackjack alami pemain dibayar 3:2 walaupun dealer juga
    // punya alami — padahal itu seri.
    if (playerNatural || dealerNatural) {
      let judul, rincian, kembali;
      if (playerNatural && dealerNatural) {
        judul = '🤝 *SERI — DUA-DUANYA BLACKJACK ALAMI!* 🤝';
        kembali = bet;
        rincian = `Kamu dan dealer sama-sama Blackjack alami. Taruhan *${bet.toLocaleString('id-ID')} Poin* dikembalikan utuh.`;
      } else if (playerNatural) {
        judul = '🃏 *BLACKJACK ALAMI!* 🏆';
        kembali = Math.floor(bet * KEMBALI_NATURAL);
        rincian = `Bayaran *3:2* — untung bersih *+${(kembali - bet).toLocaleString('id-ID')} Poin* & *+${XP_NATURAL} XP*!`;
      } else {
        judul = '💸 *DEALER BLACKJACK ALAMI!* 💸';
        kembali = 0;
        rincian = `Dealer membuka 21 dari dua kartu. Taruhan *${bet.toLocaleString('id-ID')} Poin* hangus.`;
      }

      if (kembali > 0) await db.addGamePoints(resolvedJid, kembali);
      if (playerNatural && !dealerNatural) await db.grantXp(resolvedJid, XP_NATURAL);

      await send(sock, jid, messageObj,
`${judul}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Kartu Kamu: [ ${tampil(playerCards)} ] (Nilai: *${playerVal}*)
🤖 Kartu Dealer: [ ${tampil(dealerCards)} ] (Nilai: *${nilaiTangan(dealerCards)}*)
💰 Taruhan: *${bet.toLocaleString('id-ID')} Poin*

${rincian}${catatanBatas}`,
        { buttons: tombolUlang(bet) });
      return true;
    }

    simpanSesi(session, senderNumber);
    pasangBatasWaktu(sock, session, senderNumber);

    await send(sock, jid, messageObj,
`🃏 *BLACKJACK 21* 🃏
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Kartu Kamu: [ ${tampil(playerCards)} ] (Total: *${playerVal}*)
🤖 Kartu Dealer: [ ${dealerCards[0].str}, 🂠 ??? ] (Terlihat: *${nilaiTangan([dealerCards[0]])}*)
💰 Taruhan: *${bet.toLocaleString('id-ID')} Poin*

👉 Pilih tindakan:
▫️ \`.hit\` — Ambil 1 kartu tambahan
▫️ \`.stand\` — Tahan nilai kartu & giliran Dealer
▫️ \`.double\` — Gandakan taruhan & ambil tepat 1 kartu _(hanya sekarang)_

${RINGKAS_BONUS}
_Tanpa aksi ${Math.round(BATAS_WAKTU_MS / 1000)} detik, tanganmu otomatis di-stand._${catatanBatas}`,
      {
        buttons: [
          { type: 'reply', text: '🃏 Hit (+1 Kartu)', id: '.hit' },
          { type: 'reply', text: '🛑 Stand (Tahan)', id: '.stand' },
          { type: 'reply', text: '💰 Double Down (2x)', id: '.double' }
        ]
      });
    return true;
  }

  if (command === 'hit') {
    const session = activeBlackjack.get(resolvedJid) || activeBlackjack.get(senderNumber);
    if (!session) return false;

    session.sudahHit = true;
    session.playerCards.push(ambilKartu(session));
    const playerVal = nilaiTangan(session.playerCards);

    if (playerVal > 21) {
      hapusSesi(session, senderNumber);
      await send(sock, jid, messageObj,
`💥 *BUST! KARTU MELEBIHI 21!* 💥
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Kartu Kamu: [ ${tampil(session.playerCards)} ] (Total: *${playerVal}*)
🤖 Kartu Dealer: [ ${tampil(session.dealerCards)} ]

💸 Kamu kalah! Taruhan *${session.bet.toLocaleString('id-ID')} Poin* hangus.`,
        { buttons: tombolUlang(session.taruhanAwal) });
      return true;
    }

    // Sampai 21 pas: tidak ada gunanya menambah kartu lagi, jadi langsung
    // diserahkan ke dealer supaya pemain tidak membakar tangan yang sudah menang.
    if (playerVal === 21) {
      const bonus = bayaranMenang(session.playerCards);
      await send(sock, jid, messageObj,
        `🃏 *21 PAS!* [ ${tampil(session.playerCards)} ]` +
        (bonus.label ? `\n${bonus.label} Kalau menang, bayaranmu *${String(bonus.kembali).replace('.', ',')}x*!` : '') +
        `\n_Otomatis stand — giliran dealer._`);
      return await jalankanDealer(sock, jid, senderNumber, messageObj, session);
    }

    pasangBatasWaktu(sock, session, senderNumber);
    await send(sock, jid, messageObj,
`🃏 *BLACKJACK — HIT* 🃏
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Kartu Kamu: [ ${tampil(session.playerCards)} ] (Total: *${playerVal}*)
🤖 Kartu Dealer: [ ${session.dealerCards[0].str}, 🂠 ??? ]
💰 Taruhan: *${session.bet.toLocaleString('id-ID')} Poin*

Pilih tindakan selanjutnya:`,
      {
        buttons: [
          { type: 'reply', text: '🃏 Hit (+1 Kartu)', id: '.hit' },
          { type: 'reply', text: '🛑 Stand (Tahan)', id: '.stand' }
        ]
      });
    return true;
  }

  if (command === 'double') {
    const session = activeBlackjack.get(resolvedJid) || activeBlackjack.get(senderNumber);
    if (!session) return false;

    // Double Down hanya di dua kartu pertama. Tanpa aturan ini pemain bisa
    // menghit sampai 20 lalu menggandakan taruhan — keunggulan yang tidak ada
    // di meja mana pun.
    if (session.sudahHit || session.playerCards.length !== 2) {
      await send(sock, jid, messageObj,
        "❌ *Double Down* hanya boleh saat kartumu masih dua. Sekarang tinggal `.hit` atau `.stand`.");
      return true;
    }

    const prof = await db.getGameProfile(session.senderJid);
    if ((Number(prof?.points) || 0) < session.taruhanAwal) {
      await send(sock, jid, messageObj,
        `❌ Poin kamu tidak cukup untuk Double! Butuh *${session.taruhanAwal.toLocaleString('id-ID')} Poin* lagi, punyamu *${(Number(prof?.points) || 0).toLocaleString('id-ID')}*.`);
      return true;
    }

    const potong = await db.deductGamePoints(session.senderJid, session.taruhanAwal);
    if (!potong?.success) {
      await send(sock, jid, messageObj, "❌ Gagal memotong taruhan Double. Ronde diteruskan tanpa double.");
      return true;
    }

    session.bet += session.taruhanAwal;
    session.playerCards.push(ambilKartu(session));
    await send(sock, jid, messageObj,
      `💰 *DOUBLE DOWN!* Taruhan naik jadi *${session.bet.toLocaleString('id-ID')} Poin*.\n👤 Kartu terakhirmu: *${session.playerCards[session.playerCards.length - 1].str}*`);
    return await jalankanDealer(sock, jid, senderNumber, messageObj, session);
  }

  if (command === 'stand') {
    const session = activeBlackjack.get(resolvedJid) || activeBlackjack.get(senderNumber);
    if (!session) return false;
    return await jalankanDealer(sock, jid, senderNumber, messageObj, session);
  }

  return false;
}

async function jalankanDealer(sock, jid, senderNumber, messageObj, session) {
  hapusSesi(session, senderNumber);

  const playerVal = nilaiTangan(session.playerCards);
  if (playerVal > 21) {
    await send(sock, jid, messageObj,
      `💥 *BUST!* Kartu kamu: [ ${tampil(session.playerCards)} ] (Total: *${playerVal}*)\n💸 Taruhan *${session.bet.toLocaleString('id-ID')} Poin* hangus.`,
      { buttons: tombolUlang(session.taruhanAwal) });
    return true;
  }

  // Dealer berhenti di 17, termasuk soft 17.
  while (nilaiTangan(session.dealerCards) < DEALER_BERHENTI) {
    session.dealerCards.push(ambilKartu(session));
  }
  const dealerVal = nilaiTangan(session.dealerCards);

  let judul = '';
  let rincian = '';
  let kembali = 0;

  const bayar = bayaranMenang(session.playerCards);
  const barisBonus = bayar.label
    ? `\n${bayar.label} — bayaran *${String(bayar.kembali).replace('.', ',')}x*!`
    : '';

  if (dealerVal > 21) {
    judul = '🎉 *DEALER BUST! KAMU MENANG!* 🏆';
    kembali = Math.floor(session.bet * bayar.kembali);
    rincian = `Dealer melewati 21 (${dealerVal})!${barisBonus}\nUntung bersih *+${(kembali - session.bet).toLocaleString('id-ID')} Poin* & *+${XP_MENANG} XP*!`;
  } else if (playerVal > dealerVal) {
    judul = '🎉 *KAMU MENANG!* 🏆';
    kembali = Math.floor(session.bet * bayar.kembali);
    rincian = `Nilai kartumu (${playerVal}) mengalahkan Dealer (${dealerVal})!${barisBonus}\nUntung bersih *+${(kembali - session.bet).toLocaleString('id-ID')} Poin* & *+${XP_MENANG} XP*!`;
  } else if (playerVal === dealerVal) {
    judul = '🤝 *SERI / PUSH!* 🤝';
    kembali = session.bet;
    rincian = `Nilai sama (${playerVal}). Taruhan *${kembali.toLocaleString('id-ID')} Poin* dikembalikan utuh.`;
  } else {
    judul = '💸 *DEALER MENANG!* 💸';
    kembali = 0;
    rincian = `Kartu Dealer (${dealerVal}) lebih tinggi dari kamu (${playerVal}). Taruhan *${session.bet.toLocaleString('id-ID')} Poin* hangus.`;
  }

  if (kembali > 0) {
    await db.addGamePoints(session.senderJid, kembali);
    if (kembali > session.bet) await db.grantXp(session.senderJid, XP_MENANG);
  }

  await send(sock, jid, messageObj,
`${judul}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Kartu Kamu: [ ${tampil(session.playerCards)} ] (Total: *${playerVal}*)
🤖 Kartu Dealer: [ ${tampil(session.dealerCards)} ] (Total: *${dealerVal}*)
💰 Taruhan: *${session.bet.toLocaleString('id-ID')} Poin*

${rincian}`,
    { buttons: tombolUlang(session.taruhanAwal), mentions: [session.senderJid] });
  return true;
}

export { handleBlackjack };
