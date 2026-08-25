/**
 * KATALOG KARTU ARENA MONSTER
 *
 * Statistik dasar sengaja hanya berjarak 2,5x dari Common ke Mythic.
 * Keunggulan elemen (1,35x) plus keberuntungan (0,85-1,15) membuat kartu Common
 * ber-keunggulan tetap bisa mengalahkan Epic ber-kerugian. Itu yang menjaga
 * pemain baru tidak menyerah — rarity memperluas pilihan, bukan menutup pintu.
 */

// --- Roda elemen: tiap elemen mengungguli dua, dikalahkan dua ---
export const ELEMEN = {
  API:   { nama: 'Api',   emoji: '🔥', unggul: ['ANGIN', 'DARK'] },
  ANGIN: { nama: 'Angin', emoji: '🍃', unggul: ['DARK', 'AIR'] },
  DARK:  { nama: 'Dark',  emoji: '🌑', unggul: ['AIR', 'PETIR'] },
  AIR:   { nama: 'Air',   emoji: '💧', unggul: ['PETIR', 'API'] },
  PETIR: { nama: 'Petir', emoji: '⚡', unggul: ['API', 'ANGIN'] }
};

export const PENGALI_UNGGUL = 1.35;
export const PENGALI_NETRAL = 1.00;
export const PENGALI_LEMAH = 0.75;

export function pengaliElemen(penyerang, bertahan) {
  if (penyerang === bertahan) return PENGALI_NETRAL;
  if (ELEMEN[penyerang]?.unggul.includes(bertahan)) return PENGALI_UNGGUL;
  if (ELEMEN[bertahan]?.unggul.includes(penyerang)) return PENGALI_LEMAH;
  return PENGALI_NETRAL;
}

// --- Statistik dasar per rarity (level 1) ---
export const STAT_RARITY = {
  COMMON:    { atk: 100, hp: 500,  bintang: 1, label: 'Common' },
  RARE:      { atk: 130, hp: 620,  bintang: 2, label: 'Rare' },
  EPIC:      { atk: 165, hp: 780,  bintang: 3, label: 'Epic' },
  LEGENDARY: { atk: 210, hp: 950,  bintang: 4, label: 'Legendary' },
  MYTHIC:    { atk: 260, hp: 1150, bintang: 5, label: 'Mythic' }
};

export const KENAIKAN_PER_LEVEL = 0.08; // +8% ATK & HP tiap level

export function statKartu(card, level = 1) {
  const dasar = STAT_RARITY[card.rarity] || STAT_RARITY.COMMON;
  const lv = Math.max(1, Math.min(5, Math.floor(level) || 1));
  const pengali = Math.pow(1 + KENAIKAN_PER_LEVEL, lv - 1);
  return {
    atk: Math.round(dasar.atk * pengali),
    hp: Math.round(dasar.hp * pengali),
    level: lv
  };
}

export function costKartu(card) {
  if (!card) return 0;
  return STAT_RARITY[card.rarity]?.bintang || 1;
}

// --- Skill: hanya Epic ke atas. Semuanya tanpa status rumit ---
export const SKILL = {
  GERHANA:        { nama: 'Gerhana',        teks: 'Serangan pertama +40% damage' },
  PERISAI_AIR:    { nama: 'Perisai Air',    teks: 'Damage pertama yang diterima -50%' },
  SAMBARAN_GANDA: { nama: 'Sambaran Ganda', teks: '25% peluang menyerang dua kali' },
  BARA_ABADI:     { nama: 'Bara Abadi',     teks: '+15% damage tiap ronde, menumpuk' },
  PUSARAN:        { nama: 'Pusaran',        teks: 'Abaikan kerugian elemen' },
  BALAS_DENDAM:   { nama: 'Balas Dendam',   teks: '+30% damage saat HP di bawah 30%' },
  PENYEMBUHAN:    { nama: 'Penyembuhan',    teks: 'Pulih 10% HP tiap akhir ronde' },
  PENINDAS:       { nama: 'Penindas',       teks: '+25% damage lawan rarity lebih rendah' }
};

// --- 44 kartu: 16 Common, 12 Rare, 8 Epic, 5 Legendary, 3 Mythic ---
export const KARTU = [
  // ---------- COMMON (16) ----------
  { id: 'CMN01', nama: 'Tikus Bara',      rarity: 'COMMON', elemen: 'API' },
  { id: 'CMN02', nama: 'Kunang Api',      rarity: 'COMMON', elemen: 'API' },
  { id: 'CMN03', nama: 'Kadal Pasir',     rarity: 'COMMON', elemen: 'API' },
  { id: 'CMN04', nama: 'Katak Rawa',      rarity: 'COMMON', elemen: 'AIR' },
  { id: 'CMN05', nama: 'Ubur Kecil',      rarity: 'COMMON', elemen: 'AIR' },
  { id: 'CMN06', nama: 'Ikan Batu',       rarity: 'COMMON', elemen: 'AIR' },
  { id: 'CMN07', nama: 'Burung Angin',    rarity: 'COMMON', elemen: 'ANGIN' },
  { id: 'CMN08', nama: 'Rusa Padang',     rarity: 'COMMON', elemen: 'ANGIN' },
  { id: 'CMN09', nama: 'Ular Sawah',      rarity: 'COMMON', elemen: 'ANGIN' },
  { id: 'CMN10', nama: 'Tupai Kejut',     rarity: 'COMMON', elemen: 'PETIR' },
  { id: 'CMN11', nama: 'Belut Setrum',    rarity: 'COMMON', elemen: 'PETIR' },
  { id: 'CMN12', nama: 'Kunang Petir',    rarity: 'COMMON', elemen: 'PETIR' },
  { id: 'CMN13', nama: 'Kelelawar Gua',   rarity: 'COMMON', elemen: 'DARK' },
  { id: 'CMN14', nama: 'Gagak Kelam',     rarity: 'COMMON', elemen: 'DARK' },
  { id: 'CMN15', nama: 'Bayang Kecil',    rarity: 'COMMON', elemen: 'DARK' },
  { id: 'CMN16', nama: 'Semut Merah',     rarity: 'COMMON', elemen: 'API' },

  // ---------- RARE (12) ----------
  { id: 'RAR01', nama: 'Harimau Bara',    rarity: 'RARE', elemen: 'API' },
  { id: 'RAR02', nama: 'Banteng Api',     rarity: 'RARE', elemen: 'API' },
  { id: 'RAR03', nama: 'Buaya Lumpur',    rarity: 'RARE', elemen: 'AIR' },
  { id: 'RAR04', nama: 'Beruang Salju',   rarity: 'RARE', elemen: 'AIR' },
  { id: 'RAR05', nama: 'Kura Karang',     rarity: 'RARE', elemen: 'AIR' },
  { id: 'RAR06', nama: 'Elang Badai',     rarity: 'RARE', elemen: 'ANGIN' },
  { id: 'RAR07', nama: 'Merak Angin',     rarity: 'RARE', elemen: 'ANGIN' },
  { id: 'RAR08', nama: 'Rajawali Puncak', rarity: 'RARE', elemen: 'ANGIN' },
  { id: 'RAR09', nama: 'Kuda Petir',      rarity: 'RARE', elemen: 'PETIR' },
  { id: 'RAR10', nama: 'Landak Setrum',   rarity: 'RARE', elemen: 'PETIR' },
  { id: 'RAR11', nama: 'Serigala Kabut',  rarity: 'RARE', elemen: 'DARK' },
  { id: 'RAR12', nama: 'Panther Malam',   rarity: 'RARE', elemen: 'DARK' },

  // ---------- EPIC (8) — mulai punya skill ----------
  { id: 'EPC01', nama: 'Golem Lahar',     rarity: 'EPIC', elemen: 'API',   skill: 'BARA_ABADI' },
  { id: 'EPC02', nama: 'Garuda Bara',     rarity: 'EPIC', elemen: 'API',   skill: 'BALAS_DENDAM' },
  { id: 'EPC03', nama: 'Naga Rawa',       rarity: 'EPIC', elemen: 'AIR',   skill: 'PENYEMBUHAN' },
  { id: 'EPC04', nama: 'Leviatan Muda',   rarity: 'EPIC', elemen: 'AIR',   skill: 'PUSARAN' },
  { id: 'EPC05', nama: 'Siluman Angin',   rarity: 'EPIC', elemen: 'ANGIN', skill: 'PUSARAN' },
  { id: 'EPC06', nama: 'Ratu Lebah',      rarity: 'EPIC', elemen: 'ANGIN', skill: 'PENYEMBUHAN' },
  { id: 'EPC07', nama: 'Raksasa Petir',   rarity: 'EPIC', elemen: 'PETIR', skill: 'BALAS_DENDAM' },
  { id: 'EPC08', nama: 'Bayangan Rimba',  rarity: 'EPIC', elemen: 'DARK',  skill: 'BALAS_DENDAM' },

  // ---------- LEGENDARY (5) ----------
  { id: 'LGD01', nama: 'Naga Krakatau',      rarity: 'LEGENDARY', elemen: 'API',   skill: 'PENINDAS' },
  { id: 'LGD02', nama: 'Ratu Laut Selatan',  rarity: 'LEGENDARY', elemen: 'AIR',   skill: 'PERISAI_AIR' },
  { id: 'LGD03', nama: 'Garuda Nusantara',   rarity: 'LEGENDARY', elemen: 'ANGIN', skill: 'PENINDAS' },
  { id: 'LGD04', nama: 'Petir Semeru',       rarity: 'LEGENDARY', elemen: 'PETIR', skill: 'SAMBARAN_GANDA' },
  { id: 'LGD05', nama: 'Rangda Kelam',       rarity: 'LEGENDARY', elemen: 'DARK',  skill: 'PENINDAS' },

  // ---------- MYTHIC (3) ----------
  { id: 'MYT01', nama: 'Barong Agni',        rarity: 'MYTHIC', elemen: 'API',   skill: 'BARA_ABADI' },
  { id: 'MYT02', nama: 'Sang Hyang Petir',   rarity: 'MYTHIC', elemen: 'PETIR', skill: 'SAMBARAN_GANDA' },
  { id: 'MYT03', nama: 'Voidreaper',         rarity: 'MYTHIC', elemen: 'DARK',  skill: 'GERHANA' }
];

const PETA_KARTU = new Map(KARTU.map(k => [k.id, k]));
const PETA_RARITY = KARTU.reduce((acc, k) => {
  (acc[k.rarity] = acc[k.rarity] || []).push(k);
  return acc;
}, {});

export function getKartu(id) {
  return PETA_KARTU.get(String(id || '').toUpperCase()) || null;
}

export function getKartuByRarity(rarity) {
  return PETA_RARITY[rarity] || [];
}

export function cariKartu(kataKunci) {
  const q = String(kataKunci || '').toLowerCase().trim();
  if (!q) return [];
  return KARTU.filter(k => k.id.toLowerCase() === q || k.nama.toLowerCase().includes(q));
}

export const PETA_COST = KARTU.reduce((acc, k) => {
  acc[k.id] = STAT_RARITY[k.rarity]?.bintang || 1;
  return acc;
}, {});

export const TOTAL_KARTU = KARTU.length;
