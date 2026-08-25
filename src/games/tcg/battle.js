/**
 * ARENA KARTU MONSTER — MESIN PERTARUNGAN 3V3 & PVE MENARA
 */

import { getKartu, statKartu, ELEMEN, pengaliElemen, SKILL, STAT_RARITY, costKartu } from './cards.js';

// ============================================================
// STATE DUEL PVP AKTIF
// ============================================================

export const activeTcgDuels = new Map(); // key: targetJid -> duelData

export function getActiveDuel(targetJid) {
  return activeTcgDuels.get(targetJid) || null;
}

export function setTcgDuel(targetJid, duelData) {
  activeTcgDuels.set(targetJid, duelData);
}

export function deleteTcgDuel(targetJid) {
  const d = activeTcgDuels.get(targetJid);
  if (d?.timeout) clearTimeout(d.timeout);
  activeTcgDuels.delete(targetJid);
}

// ============================================================
// SIMULATOR COMBAT 3V3 (BEST OF 3)
// ============================================================

const fmt = (n) => Number(n || 0).toLocaleString('id-ID');

/**
 * Mensimulasikan pertarungan 1 kartu vs 1 kartu
 */
function duelSatuSlot(slotIdx, itemA, itemB, nameA, nameB) {
  if (!itemA && !itemB) {
    return { winner: 0, text: `⚔️ *Ronde ${slotIdx}:* Kedua sisi tidak memasang kartu (Seri).` };
  }
  if (!itemA) {
    const cardB = getKartu(itemB.card_id);
    return { winner: 2, text: `⚔️ *Ronde ${slotIdx}:* ${nameA} tidak memasang kartu di slot ini! ${nameB} (*${cardB?.nama || itemB.card_id}*) menang mutlak.` };
  }
  if (!itemB) {
    const cardA = getKartu(itemA.card_id);
    return { winner: 1, text: `⚔️ *Ronde ${slotIdx}:* ${nameB} tidak memasang kartu di slot ini! ${nameA} (*${cardA?.nama || itemA.card_id}*) menang mutlak.` };
  }

  const cardA = getKartu(itemA.card_id);
  const cardB = getKartu(itemB.card_id);
  if (!cardA || !cardB) {
    return { winner: 0, text: `⚔️ *Ronde ${slotIdx}:* Terjadi kesalahan data kartu.` };
  }

  const statA = statKartu(cardA, itemA.card_lv || 1);
  const statB = statKartu(cardB, itemB.card_lv || 1);

  let hpA = statA.hp;
  let hpB = statB.hp;
  const maxHpA = statA.hp;
  const maxHpB = statB.hp;

  const elA = ELEMEN[cardA.elemen];
  const elB = ELEMEN[cardB.elemen];

  let multElemenA = pengaliElemen(cardA.elemen, cardB.elemen);
  let multElemenB = pengaliElemen(cardB.elemen, cardA.elemen);

  // Skill Pusaran: Abaikan kerugian elemen
  if (cardA.skill === 'PUSARAN' && multElemenA < 1.0) multElemenA = 1.0;
  if (cardB.skill === 'PUSARAN' && multElemenB < 1.0) multElemenB = 1.0;

  // Skill Penindas: +25% damage vs lower rarity
  const costA = costKartu(cardA);
  const costB = costKartu(cardB);
  const penindasA = (cardA.skill === 'PENINDAS' && costA > costB) ? 1.25 : 1.0;
  const penindasB = (cardB.skill === 'PENINDAS' && costB > costA) ? 1.25 : 1.0;

  let turn = 1;
  const maxTurns = 8;
  const log = [];

  log.push(
    `⚔️ *RONDE ${slotIdx}*\n` +
    `  👤 ${nameA}: ${elA.emoji} *${cardA.nama}* (Lv.${statA.level}) [HP: ${fmt(hpA)} | ATK: ${fmt(statA.atk)}]\n` +
    `  👤 ${nameB}: ${elB.emoji} *${cardB.nama}* (Lv.${statB.level}) [HP: ${fmt(hpB)} | ATK: ${fmt(statB.atk)}]`
  );

  if (multElemenA > 1.0) {
    log.push(`  ✨ ${cardA.nama} unggul elemen atas ${cardB.nama} (+35% DMG)!`);
  } else if (multElemenB > 1.0) {
    log.push(`  ✨ ${cardB.nama} unggul elemen atas ${cardA.nama} (+35% DMG)!`);
  }

  while (hpA > 0 && hpB > 0 && turn <= maxTurns) {
    // 1. Serangan A -> B
    let dmgModA = multElemenA * penindasA;
    if (turn === 1 && cardA.skill === 'GERHANA') dmgModA *= 1.40; // Gerhana +40% turn 1
    if (cardA.skill === 'BARA_ABADI') dmgModA *= (1 + (turn - 1) * 0.15); // Bara Abadi +15%/turn
    if (cardA.skill === 'BALAS_DENDAM' && (hpA / maxHpA) < 0.30) dmgModA *= 1.30;

    let varianceA = 0.90 + Math.random() * 0.20;
    let rawDmgA = Math.round(statA.atk * dmgModA * varianceA);

    // Perisai Air pertahanan B
    if (turn === 1 && cardB.skill === 'PERISAI_AIR') {
      rawDmgA = Math.round(rawDmgA * 0.50);
    }

    // Sambaran Ganda A
    const doubleA = (cardA.skill === 'SAMBARAN_GANDA' && Math.random() < 0.25);
    if (doubleA) rawDmgA = Math.round(rawDmgA * 1.8);

    hpB = Math.max(0, hpB - rawDmgA);

    if (hpB <= 0) break;

    // 2. Serangan B -> A
    let dmgModB = multElemenB * penindasB;
    if (turn === 1 && cardB.skill === 'GERHANA') dmgModB *= 1.40;
    if (cardB.skill === 'BARA_ABADI') dmgModB *= (1 + (turn - 1) * 0.15);
    if (cardB.skill === 'BALAS_DENDAM' && (hpB / maxHpB) < 0.30) dmgModB *= 1.30;

    let varianceB = 0.90 + Math.random() * 0.20;
    let rawDmgB = Math.round(statB.atk * dmgModB * varianceB);

    if (turn === 1 && cardA.skill === 'PERISAI_AIR') {
      rawDmgB = Math.round(rawDmgB * 0.50);
    }

    const doubleB = (cardB.skill === 'SAMBARAN_GANDA' && Math.random() < 0.25);
    if (doubleB) rawDmgB = Math.round(rawDmgB * 1.8);

    hpA = Math.max(0, hpA - rawDmgB);

    // Skill Penyembuhan
    if (cardA.skill === 'PENYEMBUHAN' && hpA > 0) {
      hpA = Math.min(maxHpA, hpA + Math.round(maxHpA * 0.10));
    }
    if (cardB.skill === 'PENYEMBUHAN' && hpB > 0) {
      hpB = Math.min(maxHpB, hpB + Math.round(maxHpB * 0.10));
    }

    turn++;
  }

  let winner = 0;
  let winnerText = '';
  if (hpA > 0 && hpB <= 0) {
    winner = 1;
    winnerText = `  🏆 Pemenang Ronde ${slotIdx}: *${nameA}* (${cardA.nama} sisa HP: ${fmt(hpA)})`;
  } else if (hpB > 0 && hpA <= 0) {
    winner = 2;
    winnerText = `  🏆 Pemenang Ronde ${slotIdx}: *${nameB}* (${cardB.nama} sisa HP: ${fmt(hpB)})`;
  } else {
    // Seri atau timeout
    if (hpA > hpB) {
      winner = 1;
      winnerText = `  🏆 Pemenang Ronde ${slotIdx}: *${nameA}* (Unggul sisa HP)`;
    } else if (hpB > hpA) {
      winner = 2;
      winnerText = `  🏆 Pemenang Ronde ${slotIdx}: *${nameB}* (Unggul sisa HP)`;
    } else {
      winner = 0;
      winnerText = `  ⚖️ Ronde ${slotIdx}: *SERI*`;
    }
  }

  log.push(winnerText);
  return { winner, text: log.join('\n') };
}

/**
 * Mensimulasikan pertandingan Best-of-3 antara 2 Dek
 */
export function simulate3v3(deckA, deckB, nameA = 'Pemain A', nameB = 'Pemain B') {
  let scoreA = 0;
  let scoreB = 0;
  const roundReports = [];

  for (let slot = 1; slot <= 3; slot++) {
    const res = duelSatuSlot(slot, deckA[slot], deckB[slot], nameA, nameB);
    roundReports.push(res.text);
    if (res.winner === 1) scoreA++;
    else if (res.winner === 2) scoreB++;
  }

  let matchWinner = 0; // 0: seri, 1: A, 2: B
  if (scoreA > scoreB) matchWinner = 1;
  else if (scoreB > scoreA) matchWinner = 2;

  return {
    scoreA,
    scoreB,
    matchWinner,
    winnerName: matchWinner === 1 ? nameA : (matchWinner === 2 ? nameB : 'SERI'),
    roundReports
  };
}

// ============================================================
// DAFTAR 30 LANTAI PVE: MENARA PENJAGA MONSTER
// ============================================================

export const TOWER_FLOORS = [
  // Tier 1: Pemula (Lantai 1 - 5)
  {
    floor: 1,
    nama: 'Hutan Permulaan',
    rewardKeping: 30,
    rewardShards: { rarity: 'COMMON', jumlah: 2 },
    deck: {
      1: { card_id: 'CMN01', card_lv: 1 }, // Tikus Bara
      2: { card_id: 'CMN04', card_lv: 1 }, // Katak Rawa
      3: { card_id: 'CMN07', card_lv: 1 }  // Burung Angin
    }
  },
  {
    floor: 2,
    nama: 'Lembah Pasir',
    rewardKeping: 35,
    rewardShards: { rarity: 'COMMON', jumlah: 3 },
    deck: {
      1: { card_id: 'CMN03', card_lv: 1 }, // Kadal Pasir
      2: { card_id: 'CMN10', card_lv: 1 }, // Tupai Kejut
      3: { card_id: 'CMN13', card_lv: 1 }  // Kelelawar Gua
    }
  },
  {
    floor: 3,
    nama: 'Rawa Beracun',
    rewardKeping: 40,
    rewardShards: { rarity: 'COMMON', jumlah: 4 },
    deck: {
      1: { card_id: 'CMN05', card_lv: 2 }, // Ubur Kecil
      2: { card_id: 'CMN08', card_lv: 2 }, // Rusa Padang
      3: { card_id: 'CMN02', card_lv: 1 }  // Kunang Api
    }
  },
  {
    floor: 4,
    nama: 'Gua Kegelapan',
    rewardKeping: 45,
    rewardShards: { rarity: 'COMMON', jumlah: 5 },
    deck: {
      1: { card_id: 'CMN14', card_lv: 2 }, // Gagak Kelam
      2: { card_id: 'CMN11', card_lv: 2 }, // Belut Setrum
      3: { card_id: 'CMN06', card_lv: 2 }  // Ikan Batu
    }
  },
  {
    floor: 5,
    nama: '⭐ Penjaga Rimba (Mini Boss)',
    rewardKeping: 80,
    rewardShards: { rarity: 'RARE', jumlah: 2 },
    deck: {
      1: { card_id: 'RAR01', card_lv: 2 }, // Harimau Bara
      2: { card_id: 'CMN09', card_lv: 3 }, // Ular Sawah
      3: { card_id: 'RAR03', card_lv: 2 }  // Buaya Lumpur
    }
  },

  // Tier 2: Petualang Menengah (Lantai 6 - 10)
  {
    floor: 6,
    nama: 'Puncak Angin Puyuh',
    rewardKeping: 50,
    rewardShards: { rarity: 'RARE', jumlah: 1 },
    deck: {
      1: { card_id: 'RAR06', card_lv: 2 }, // Elang Badai
      2: { card_id: 'RAR07', card_lv: 2 }, // Merak Angin
      3: { card_id: 'CMN12', card_lv: 3 }  // Kunang Petir
    }
  },
  {
    floor: 7,
    nama: 'Danau Karang Es',
    rewardKeping: 55,
    rewardShards: { rarity: 'RARE', jumlah: 1 },
    deck: {
      1: { card_id: 'RAR04', card_lv: 2 }, // Beruang Salju
      2: { card_id: 'RAR05', card_lv: 2 }, // Kura Karang
      3: { card_id: 'CMN16', card_lv: 3 }  // Semut Merah
    }
  },
  {
    floor: 8,
    nama: 'Padang Halilintar',
    rewardKeping: 60,
    rewardShards: { rarity: 'RARE', jumlah: 2 },
    deck: {
      1: { card_id: 'RAR09', card_lv: 2 }, // Kuda Petir
      2: { card_id: 'RAR10', card_lv: 2 }, // Landak Setrum
      3: { card_id: 'RAR02', card_lv: 2 }  // Banteng Api
    }
  },
  {
    floor: 9,
    nama: 'Hutan Kabut Malam',
    rewardKeping: 65,
    rewardShards: { rarity: 'RARE', jumlah: 2 },
    deck: {
      1: { card_id: 'RAR11', card_lv: 3 }, // Serigala Kabut
      2: { card_id: 'RAR12', card_lv: 3 }, // Panther Malam
      3: { card_id: 'RAR08', card_lv: 2 }  // Rajawali Puncak
    }
  },
  {
    floor: 10,
    nama: '🔥 PENGUASA KAWAH (BOS BESAR 1)',
    rewardKeping: 150,
    rewardShards: { rarity: 'EPIC', jumlah: 2 },
    deck: {
      1: { card_id: 'EPC01', card_lv: 2 }, // Golem Lahar
      2: { card_id: 'RAR01', card_lv: 3 }, // Harimau Bara
      3: { card_id: 'EPC02', card_lv: 2 }  // Garuda Bara
    }
  },

  // Tier 3: Jawara (Lantai 11 - 15)
  {
    floor: 11,
    nama: 'Samudra Leviatan',
    rewardKeping: 75,
    rewardShards: { rarity: 'RARE', jumlah: 3 },
    deck: {
      1: { card_id: 'EPC04', card_lv: 2 }, // Leviatan Muda
      2: { card_id: 'RAR03', card_lv: 3 }, // Buaya Lumpur
      3: { card_id: 'CMN05', card_lv: 4 }  // Ubur Kecil
    }
  },
  {
    floor: 12,
    nama: 'Sarang Ratu Lebah',
    rewardKeping: 80,
    rewardShards: { rarity: 'RARE', jumlah: 3 },
    deck: {
      1: { card_id: 'EPC06', card_lv: 2 }, // Ratu Lebah
      2: { card_id: 'EPC05', card_lv: 2 }, // Siluman Angin
      3: { card_id: 'RAR07', card_lv: 3 }  // Merak Angin
    }
  },
  {
    floor: 13,
    nama: 'Kuil Petir Abadi',
    rewardKeping: 85,
    rewardShards: { rarity: 'EPIC', jumlah: 1 },
    deck: {
      1: { card_id: 'EPC07', card_lv: 3 }, // Raksasa Petir
      2: { card_id: 'RAR09', card_lv: 3 }, // Kuda Petir
      3: { card_id: 'RAR10', card_lv: 3 }  // Landak Setrum
    }
  },
  {
    floor: 14,
    nama: 'Jurang Bayang Rimba',
    rewardKeping: 90,
    rewardShards: { rarity: 'EPIC', jumlah: 1 },
    deck: {
      1: { card_id: 'EPC08', card_lv: 3 }, // Bayangan Rimba
      2: { card_id: 'EPC03', card_lv: 3 }, // Naga Rawa
      3: { card_id: 'RAR12', card_lv: 4 }  // Panther Malam
    }
  },
  {
    floor: 15,
    nama: '🌊 PENGUASA PANTAI SELATAN (BOS BESAR 2)',
    rewardKeping: 200,
    rewardShards: { rarity: 'LEGENDARY', jumlah: 1 },
    deck: {
      1: { card_id: 'LGD02', card_lv: 2 }, // Ratu Laut Selatan
      2: { card_id: 'EPC04', card_lv: 3 }, // Leviatan Muda
      3: { card_id: 'RAR05', card_lv: 4 }  // Kura Karang
    }
  },

  // Tier 4: Legendaris (Lantai 16 - 20)
  {
    floor: 16,
    nama: 'Puncak Nusantara',
    rewardKeping: 100,
    rewardShards: { rarity: 'EPIC', jumlah: 2 },
    deck: {
      1: { card_id: 'LGD03', card_lv: 2 }, // Garuda Nusantara
      2: { card_id: 'EPC02', card_lv: 3 }, // Garuda Bara
      3: { card_id: 'EPC05', card_lv: 3 }  // Siluman Angin
    }
  },
  {
    floor: 17,
    nama: 'Kawah Semeru Mengamuk',
    rewardKeping: 110,
    rewardShards: { rarity: 'EPIC', jumlah: 2 },
    deck: {
      1: { card_id: 'LGD04', card_lv: 2 }, // Petir Semeru
      2: { card_id: 'EPC07', card_lv: 3 }, // Raksasa Petir
      3: { card_id: 'RAR09', card_lv: 4 }  // Kuda Petir
    }
  },
  {
    floor: 18,
    nama: 'Kuil Rangda Angker',
    rewardKeping: 120,
    rewardShards: { rarity: 'EPIC', jumlah: 2 },
    deck: {
      1: { card_id: 'LGD05', card_lv: 2 }, // Rangda Kelam
      2: { card_id: 'EPC08', card_lv: 4 }, // Bayangan Rimba
      3: { card_id: 'EPC01', card_lv: 4 }  // Golem Lahar
    }
  },
  {
    floor: 19,
    nama: 'Gerbang Krakatau',
    rewardKeping: 130,
    rewardShards: { rarity: 'EPIC', jumlah: 3 },
    deck: {
      1: { card_id: 'EPC01', card_lv: 4 }, // Golem Lahar
      2: { card_id: 'EPC02', card_lv: 4 }, // Garuda Bara
      3: { card_id: 'LGD03', card_lv: 3 }  // Garuda Nusantara
    }
  },
  {
    floor: 20,
    nama: '🌋 NAGA KRAKATAU PURBA (BOS BESAR 3)',
    rewardKeping: 300,
    rewardShards: { rarity: 'LEGENDARY', jumlah: 2 },
    deck: {
      1: { card_id: 'LGD01', card_lv: 3 }, // Naga Krakatau
      2: { card_id: 'LGD04', card_lv: 3 }, // Petir Semeru
      3: { card_id: 'EPC01', card_lv: 4 }  // Golem Lahar
    }
  },

  // Tier 5: Mitologi (Lantai 21 - 30)
  {
    floor: 21,
    nama: 'Alam Hampa Void',
    rewardKeping: 150,
    rewardShards: { rarity: 'LEGENDARY', jumlah: 1 },
    deck: {
      1: { card_id: 'LGD05', card_lv: 3 },
      2: { card_id: 'LGD02', card_lv: 3 },
      3: { card_id: 'EPC08', card_lv: 4 }
    }
  },
  {
    floor: 22,
    nama: 'Badai Petir Surgawi',
    rewardKeping: 160,
    rewardShards: { rarity: 'LEGENDARY', jumlah: 1 },
    deck: {
      1: { card_id: 'LGD04', card_lv: 4 },
      2: { card_id: 'LGD03', card_lv: 4 },
      3: { card_id: 'EPC07', card_lv: 5 }
    }
  },
  {
    floor: 23,
    nama: 'Laut Gelap Abadi',
    rewardKeping: 170,
    rewardShards: { rarity: 'LEGENDARY', jumlah: 1 },
    deck: {
      1: { card_id: 'LGD02', card_lv: 4 },
      2: { card_id: 'LGD01', card_lv: 4 },
      3: { card_id: 'EPC04', card_lv: 5 }
    }
  },
  {
    floor: 24,
    nama: 'Gerbang Langit',
    rewardKeping: 180,
    rewardShards: { rarity: 'LEGENDARY', jumlah: 2 },
    deck: {
      1: { card_id: 'LGD03', card_lv: 4 },
      2: { card_id: 'LGD04', card_lv: 4 },
      3: { card_id: 'EPC06', card_lv: 5 }
    }
  },
  {
    floor: 25,
    nama: '⚡ SANG HYANG PETIR (DEWA PETIR)',
    rewardKeping: 400,
    rewardShards: { rarity: 'MYTHIC', jumlah: 1 },
    deck: {
      1: { card_id: 'MYT02', card_lv: 3 }, // Sang Hyang Petir
      2: { card_id: 'LGD04', card_lv: 4 },
      3: { card_id: 'LGD01', card_lv: 4 }
    }
  },
  {
    floor: 26,
    nama: 'Lembah Kegelapan Mutlak',
    rewardKeping: 200,
    rewardShards: { rarity: 'LEGENDARY', jumlah: 2 },
    deck: {
      1: { card_id: 'LGD05', card_lv: 5 },
      2: { card_id: 'LGD02', card_lv: 5 },
      3: { card_id: 'LGD03', card_lv: 4 }
    }
  },
  {
    floor: 27,
    nama: 'Singgasana Kematian',
    rewardKeping: 220,
    rewardShards: { rarity: 'LEGENDARY', jumlah: 2 },
    deck: {
      1: { card_id: 'MYT03', card_lv: 3 }, // Voidreaper
      2: { card_id: 'LGD05', card_lv: 5 },
      3: { card_id: 'LGD01', card_lv: 4 }
    }
  },
  {
    floor: 28,
    nama: 'Kawah Neraka Suci',
    rewardKeping: 240,
    rewardShards: { rarity: 'LEGENDARY', jumlah: 2 },
    deck: {
      1: { card_id: 'MYT01', card_lv: 3 }, // Barong Agni
      2: { card_id: 'MYT02', card_lv: 3 }, // Sang Hyang Petir
      3: { card_id: 'LGD04', card_lv: 4 }
    }
  },
  {
    floor: 29,
    nama: 'Penjaga Batas Dimensi',
    rewardKeping: 260,
    rewardShards: { rarity: 'LEGENDARY', jumlah: 3 },
    deck: {
      1: { card_id: 'MYT03', card_lv: 4 },
      2: { card_id: 'MYT01', card_lv: 4 },
      3: { card_id: 'LGD03', card_lv: 5 }
    }
  },
  {
    floor: 30,
    nama: '👑 PUNCAK DEWA: BARONG AGNI (FINAL BOSS)',
    rewardKeping: 1000,
    rewardShards: { rarity: 'MYTHIC', jumlah: 3 },
    deck: {
      1: { card_id: 'MYT01', card_lv: 5 }, // Barong Agni Lv. 5
      2: { card_id: 'MYT02', card_lv: 5 }, // Sang Hyang Petir Lv. 5
      3: { card_id: 'MYT03', card_lv: 5 }  // Voidreaper Lv. 5
    }
  }
];

export function getTowerFloor(floorNum) {
  return TOWER_FLOORS.find(f => f.floor === floorNum) || null;
}
