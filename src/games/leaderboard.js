/**
 * PAPAN PERINGKAT TERPADU — `.lb [kategori]`
 *
 * Dulu `.rank` / `.top` cuma menampilkan satu papan (Akbar Poin), sementara
 * papan lain tersebar sebagai perintah sendiri-sendiri (`.raidtop`,
 * `.lelangtop`, `.undercover top`) yang tidak pernah ditemukan pemain. File ini
 * jadi satu pintu untuk semuanya.
 *
 * Dua aturan yang dipegang:
 *
 * 1. **Papan yang sudah punya rumah sendiri di-DELEGASIKAN, bukan digambar
 *    ulang.** `.lb raid` memanggil handler `.raidtop` yang asli. Menyalin
 *    format ke sini berarti dua tempat yang harus diperbarui setiap kali
 *    papannya berubah, dan salah satunya pasti ketinggalan.
 * 2. **Selalu tampilkan posisi si penanya.** Papan peringkat yang cuma
 *    menampilkan 10 besar tidak berarti apa-apa buat pemain peringkat 23.
 *    Karena itu query mengambil 50 baris, menampilkan 10, dan mencari posisi
 *    pengirim di sisanya.
 */

import * as db from '../../database.js';
import { send } from './helpers.js';

const AMBIL = 50;   // diambil dari DB, dipakai untuk mencari posisi pengirim
const TAMPIL = 10;  // yang benar-benar ditulis di layar

const MEDALI = ['🥇', '🥈', '🥉'];

function fmt(n) {
  return Math.round(Number(n) || 0).toLocaleString('id-ID');
}

function posisi(i) {
  return MEDALI[i] || `*${i + 1}.*`;
}

// ─── KATALOG KATEGORI ────────────────────────────────────────────────
export const KATEGORI_PAPAN = {
  poin: {
    alias: ['poin', 'point', 'points', 'duit', 'uang', 'dompet'],
    judul: '💰 AKBAR POIN',
    tagline: 'Dompet paling tebal di Akbar Store',
    mode: 'poin',
    baris: (r) => `${fmt(r.points)} Poin · Lv.${r.level}`
  },
  level: {
    alias: ['lvl', 'level', 'xp', 'rank', 'pangkat'],
    judul: '⭐ LEVEL & XP',
    tagline: 'Yang paling rajin naik pangkat',
    mode: 'level',
    baris: (r) => `Lv.${r.level} · ${fmt(r.xp)} XP`
  },
  kaya: {
    alias: ['kaya', 'sultan', 'harta', 'total', 'kekayaan'],
    judul: '👑 TOTAL KEKAYAAN',
    tagline: 'Dompet + brankas bank digabung',
    mode: 'kaya',
    baris: (r) => `${fmt(r.total_harta)} Poin _(dompet ${fmt(r.points)} + bank ${fmt(r.bank_points)})_`
  },
  menang: {
    alias: ['menang', 'win', 'wins', 'juara', 'kemenangan'],
    judul: '🏆 KEMENANGAN GAME',
    tagline: 'Paling sering keluar sebagai pemenang',
    mode: 'menang',
    baris: (r) => {
      const wr = r.games_played > 0 ? Math.round((r.games_won / r.games_played) * 100) : 0;
      return `${fmt(r.games_won)} menang dari ${fmt(r.games_played)} main _(${wr}%)_`;
    }
  },
  streak: {
    alias: ['streak', 'daily', 'beruntun', 'absen'],
    judul: '🔥 STREAK HARIAN',
    tagline: 'Paling setia klaim `.daily` tanpa putus',
    mode: 'streak',
    baris: (r) => `${fmt(r.daily_streak)} hari beruntun · ${fmt(r.points)} Poin`
  },
  tcg: {
    alias: ['tcg', 'kartu', 'arena', 'monster', 'koleksi'],
    judul: '🃏 ARENA KARTU MONSTER',
    tagline: 'Kolektor kartu & pendaki menara tertinggi',
    ambil: (limit) => db.getTcgLeaderboard(limit),
    baris: (r) => `${fmt(r.jenis_kartu)} jenis kartu · ${fmt(r.total_kartu)} total · menara lantai ${fmt(r.lantai)}`
  },
  tcgrank: {
    alias: ['tcgrank', 'peringkat', 'elo', 'tier', 'duelis'],
    judul: '⚔️ PERINGKAT ARENA (MUSIM BERJALAN)',
    tagline: 'Poin duel & sparring musim ini — direset lunak tiap 30 hari',
    ambil: (limit) => db.getTcgRankLeaderboard(limit),
    baris: (r) => {
      const t = db.tcgTier(r.poin);
      const main = (r.menang || 0) + (r.kalah || 0) + (r.seri || 0);
      const wr = main > 0 ? Math.round((r.menang / main) * 100) : 0;
      return `${t.emoji} ${t.nama} · ${fmt(r.poin)} poin · ${r.menang}M-${r.kalah}K _(${wr}%)_`;
    }
  },
  abadi: {
    alias: ['abadi', 'endless', 'void', 'menara'],
    judul: '🌌 MENARA ABADI',
    tagline: 'Lantai terdalam yang pernah ditembus — tidak ada puncaknya',
    ambil: (limit) => db.getTcgAbadiLeaderboard(limit),
    baris: (r) => `lantai *${fmt(r.lantai)}* · ${fmt(r.percobaan)} percobaan`
  },
  tcgstreak: {
    alias: ['tcgstreak', 'beruntunarena', 'absenarena', 'streakarena'],
    judul: '🔥 BERUNTUN HARIAN ARENA',
    tagline: 'Paling setia klaim `.tcg daily` tanpa putus',
    ambil: (limit) => db.getTcgStreakLeaderboard(limit),
    baris: (r) => `${fmt(r.streak)} hari beruntun · rekor ${fmt(r.terpanjang)} · ${fmt(r.total_klaim)} klaim`
  },
  chat: {
    alias: ['chat', 'aktif', 'ngobrol', 'gacor', 'cerewet'],
    judul: '💬 PALING AKTIF DI GRUP INI',
    tagline: 'Dihitung dari jumlah pesan di grup ini saja',
    grupSaja: true,
    ambil: (limit, ctx) => db.getChatLeaderboard(ctx.jid, limit),
    baris: (r) => `${fmt(r.msg_count)} pesan`
  },
  raid: {
    alias: ['raid', 'worldboss', 'bos', 'boss'],
    judul: '🐉 RAID WORLD BOSS',
    delegasi: 'raid'
  },
  lelang: {
    alias: ['lelang', 'auction', 'kotak', 'misteri'],
    judul: '📦 LELANG KOTAK MISTERI',
    delegasi: 'lelang'
  },
  undercover: {
    alias: ['undercover', 'sus', 'uc', 'impostor'],
    judul: '🕵️ UNDERCOVER',
    delegasi: 'undercover'
  }
};

function cariKategori(teks) {
  const k = String(teks || '').toLowerCase().trim();
  if (!k) return null;
  for (const [id, def] of Object.entries(KATEGORI_PAPAN)) {
    if (id === k || def.alias.includes(k)) return { id, def };
  }
  return null;
}

// ─── MENU KATEGORI ───────────────────────────────────────────────────

async function tampilkanMenu(sock, jid, senderNumber, messageObj) {
  const cuplikan = await db.getProfileLeaderboard('poin', 3);
  const teratas = cuplikan.length > 0
    ? cuplikan.map((r, i) => `${posisi(i)} *${r.customer_nama}* — ${fmt(r.points)} Poin`).join('\n')
    : '_Belum ada pemain yang tercatat._';

  const daftar = [
    ['`.lb poin`', '💰 Akbar Poin terbanyak'],
    ['`.lb lvl`', '⭐ Level & XP tertinggi'],
    ['`.lb kaya`', '👑 Dompet + bank digabung'],
    ['`.lb menang`', '🏆 Kemenangan game terbanyak'],
    ['`.lb streak`', '🔥 Streak `.daily` terpanjang'],
    ['`.lb raid`', '🐉 Pemburu World Boss'],
    ['`.lb lelang`', '📦 Juragan lelang paling untung'],
    ['`.lb undercover`', '🕵️ Raja deduksi'],
    ['`.lb tcg`', '🃏 Kolektor kartu & menara'],
    ['`.lb peringkat`', '⚔️ Peringkat duel arena musim ini'],
    ['`.lb abadi`', '🌌 Menara Abadi terdalam'],
    ['`.lb tcgstreak`', '🔥 Beruntun harian arena'],
    ['`.lb chat`', '💬 Paling aktif di grup ini']
  ].map(([c, d]) => `▫️ ${c} — ${d}`).join('\n');

  await send(sock, jid, messageObj,
`🏆 *PAPAN PERINGKAT AKBAR STORE* 📊
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔝 *Sorotan — Poin Terbanyak:*
${teratas}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 *SEMUA KATEGORI:*
${daftar}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 Ketik salah satu di atas untuk melihat 10 besarnya lengkap dengan posisimu sendiri.`,
    {
      buttons: [
        { type: 'reply', text: '💰 Poin', id: '.lb poin' },
        { type: 'reply', text: '⭐ Level', id: '.lb lvl' },
        { type: 'reply', text: '🐉 Raid', id: '.lb raid' },
        { type: 'reply', text: '📦 Lelang', id: '.lb lelang' },
        { type: 'reply', text: '👤 Profilku', id: '.poin' }
      ]
    });
  return true;
}

// ─── RENDER SATU PAPAN ───────────────────────────────────────────────

async function tampilkanPapan(sock, jid, senderNumber, messageObj, id, def, ctx) {
  if (def.grupSaja && !ctx.isFromGroup) {
    await send(sock, jid, messageObj, `⚠️ Papan *${def.judul}* hanya tersedia di dalam grup.`);
    return true;
  }

  const rows = def.ambil
    ? await def.ambil(AMBIL, ctx)
    : await db.getProfileLeaderboard(def.mode, AMBIL);

  if (!rows || rows.length === 0) {
    await send(sock, jid, messageObj,
      `*${def.judul}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nBelum ada data yang tercatat untuk kategori ini.\n\n👉 Ketik \`.lb\` untuk melihat kategori lain.`);
    return true;
  }

  const mentions = [];
  const namaTampil = (r) => {
    const digits = String(r.customer_jid || '').split('@')[0];
    if (r.customer_nama && r.customer_nama !== 'Member') return r.customer_nama;
    mentions.push(r.customer_jid);
    return `@${digits}`;
  };

  const baris = rows.slice(0, TAMPIL)
    .map((r, i) => `${posisi(i)} *${namaTampil(r)}*\n     ${def.baris(r)}`)
    .join('\n');

  // Posisi pengirim: inti dari papan peringkat buat pemain di luar 10 besar.
  const idxSaya = rows.findIndex(r => r.customer_jid === senderNumber);
  let barisSaya;
  if (idxSaya >= 0 && idxSaya < TAMPIL) {
    barisSaya = `✅ *Posisimu:* peringkat *${idxSaya + 1}* — kamu ada di papan atas!`;
  } else if (idxSaya >= 0) {
    barisSaya = `📍 *Posisimu:* peringkat *${idxSaya + 1}* — ${def.baris(rows[idxSaya])}`;
  } else {
    barisSaya = `📍 *Posisimu:* belum masuk *${AMBIL} besar* di kategori ini.`;
  }

  await send(sock, jid, messageObj,
`*${def.judul}*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_${def.tagline}_

${baris}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${barisSaya}
💡 Ketik \`.lb\` untuk melihat kategori lainnya.`,
    {
      mentions,
      buttons: [
        { type: 'reply', text: '📋 Semua Kategori', id: '.lb' },
        { type: 'reply', text: '👤 Profilku', id: '.poin' }
      ]
    });
  return true;
}

// ─── ROUTER ──────────────────────────────────────────────────────────

export async function handleLeaderboardCommand(sock, jid, senderNumber, messageObj, args, { isFromGroup = false, isAdmin = false, isOwner = false } = {}) {
  const arg = args[1];
  if (!arg) return await tampilkanMenu(sock, jid, senderNumber, messageObj);

  const ketemu = cariKategori(arg);
  if (!ketemu) {
    const semua = Object.keys(KATEGORI_PAPAN).map(k => `\`${k}\``).join(' · ');
    await send(sock, jid, messageObj,
      `⚠️ Kategori papan *${arg}* tidak dikenal.\n\n📋 *Pilihan:* ${semua}\n\n👉 Ketik \`.lb\` untuk daftar lengkapnya.`);
    return true;
  }

  const { id, def } = ketemu;

  // Papan yang sudah punya handler sendiri dipanggil langsung, supaya
  // formatnya tidak pernah bercabang dua.
  if (def.delegasi === 'raid') {
    const { handleRaidCommand } = await import('./raidBoss.js');
    return await handleRaidCommand(sock, jid, senderNumber, messageObj, ['raidtop'], 'raidtop', isFromGroup, isAdmin, isOwner);
  }
  if (def.delegasi === 'lelang') {
    const { handleAuctionCommand } = await import('./mysteryAuction.js');
    return await handleAuctionCommand(sock, jid, senderNumber, messageObj, ['lelangtop'], 'lelangtop', isFromGroup, isAdmin, isOwner);
  }
  if (def.delegasi === 'undercover') {
    const { handleUndercover } = await import('./undercover.js');
    return await handleUndercover(sock, jid, senderNumber, messageObj, ['undercover', 'top'], 'undercover', isFromGroup);
  }

  return await tampilkanPapan(sock, jid, senderNumber, messageObj, id, def, { jid, isFromGroup });
}
