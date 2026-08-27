/**
 * ARENA KARTU MONSTER — MESIN PERTARUNGAN 3V3 & PVE MENARA
 *
 * Mesin ini tidak tahu nama skill apa pun. Ia hanya membaca field angka dari
 * SKILL di cards.js (lihat daftar field di sana). Menambah skill baru cukup
 * dilakukan di katalog; file ini tidak perlu disentuh lagi.
 */

import {
  getKartu, statKartu, ELEMEN, pengaliElemen, SKILL,
  costKartu, sinergiDek, PENGALI_UNGGUL, KRIT_DMG
} from './cards.js';

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

const MAKS_GILIRAN = 8;
const VARIAN_ATAS = 1.10;
const VARIAN_BAWAH = 0.90;
// `stabil` dulu memakai 0,98-1,10 dan itu diam-diam adalah buff damage +4%,
// bukan kestabilan. Sekarang benar-benar stabil (rata-rata tetap 1,00) dan
// harganya jujur: peluang kritisnya dipotong separuh di `hitungPukulan`.
const VARIAN_STABIL_ATAS = 1.03;
const VARIAN_STABIL_BAWAH = 0.97;
// Ambang untuk field `eksekusi` — damage tambahan saat HP LAWAN sudah tipis.
const AMBANG_EKSEKUSI = 0.35;

/**
 * Menyiapkan satu petarung lengkap dengan bonus skill pasif dan bonus sinergi
 * dek. Semua pengali stat diselesaikan di sini supaya loop serangan hanya
 * berurusan dengan angka jadi.
 */
function buatPetarung(item, nama, sinergi) {
  const kartu = getKartu(item.card_id);
  if (!kartu) return null;

  const dasar = statKartu(kartu, item.card_lv || 1);
  const sk = kartu.skill ? SKILL[kartu.skill] : null;
  const bonusAtk = (1 + (sk?.atkBonus || 0)) * (1 + (sinergi?.atk || 0));
  const bonusHp = (1 + (sk?.hpBonus || 0)) * (1 + (sinergi?.hp || 0));
  const hp = Math.round(dasar.hp * bonusHp);

  return {
    kartu,
    nama,
    sk,
    level: dasar.level,
    cost: costKartu(kartu),
    atk: Math.round(dasar.atk * bonusAtk),
    // Kritis kartu + tambahan dari skill. Dibatasi 85% supaya tidak ada
    // kombinasi yang membuat kritis jadi keadaan normal.
    kritis: Math.max(0, Math.min(0.85, (dasar.kritis || 0) + (sk?.kritBonus || 0))),
    kritDmg: KRIT_DMG + (sk?.kritDmg || 0),
    hp,
    maxHp: hp,
    // HP tanpa dijepit di 0. Hanya dipakai untuk memisahkan hasil ketika kedua
    // kartu tumbang di ronde yang sama.
    hpAsli: hp,
    elemenMult: 1,
    perisaiTerpakai: false,
    lewatiGiliran: false,
    pelemahTerpakai: false,
    nyawaCadangan: sk?.bertahanMati === true,
    selamatDariMaut: false,
    // Penyembuhan dikumpulkan dulu di sini, baru dibayarkan di akhir ronde.
    // Lihat `terapkanPulih` untuk alasannya.
    pulihTertunda: 0,
    kritisTerjadi: 0,
    racunMasuk: 0 // porsi HP maks yang hilang tiap akhir ronde
  };
}

/**
 * Menghitung SATU pukulan tanpa menyentuh objek mana pun.
 *
 * Semua angka diambil dari `snap` — potret kondisi di AWAL ronde — supaya kedua
 * kartu benar-benar memukul serentak. Kalau nilai dibaca langsung dari objek,
 * yang dihitung belakangan akan melihat HP lawan yang sudah berkurang dan
 * keuntungan "siapa duluan" masuk lewat pintu belakang.
 */
function hitungPukulan(p, l, giliran, snapP, snapL) {
  // Menghindar: serangan hangus seluruhnya, tidak ada efek sampingan apa pun.
  if (l.sk?.hindar && Math.random() < l.sk.hindar) return { meleset: true, dmg: 0 };

  let mod = p.elemenMult;
  if (p.sk?.penindas && p.cost > l.cost) mod *= (1 + p.sk.penindas);
  if (giliran === 1 && p.sk?.bukaan && !l.sk?.waspada) mod *= (1 + p.sk.bukaan);
  if (p.sk?.menumpuk) mod *= (1 + (giliran - 1) * p.sk.menumpuk);
  if (p.sk?.nekat && (snapP / p.maxHp) < p.sk.nekat.ambang) mod *= (1 + p.sk.nekat.bonus);
  if (p.sk?.eksekusi && (snapL / l.maxHp) < AMBANG_EKSEKUSI) mod *= (1 + p.sk.eksekusi);

  // Kritis: peluang kartu sendiri dikurangi `antiKrit` lawan.
  let peluangKrit = p.kritis - (l.sk?.antiKrit || 0);
  if (p.sk?.stabil) peluangKrit *= 0.5;
  const kritis = peluangKrit > 0 && Math.random() < peluangKrit;
  if (kritis) mod *= p.kritDmg;

  const atas = p.sk?.stabil ? VARIAN_STABIL_ATAS : VARIAN_ATAS;
  const bawah = p.sk?.stabil ? VARIAN_STABIL_BAWAH : VARIAN_BAWAH;
  let dmg = p.atk * mod * (bawah + Math.random() * (atas - bawah));

  // Pertahanan pasif lawan, bisa ditembus sebagian oleh `tembus`.
  let tahan = l.sk?.tahan || 0;
  if (p.sk?.tembus) tahan *= (1 - p.sk.tembus);
  if (tahan > 0) dmg *= (1 - tahan);

  return { meleset: false, kritis, dmg };
}

/**
 * Menerapkan satu pukulan yang sudah dihitung, beserta seluruh efek
 * sampingannya. Dipanggil setelah KEDUA sisi selesai menghitung.
 */
function terapkanPukulan(p, l, pukulan) {
  if (pukulan.meleset) return;

  let dmg = pukulan.dmg;
  // Perisai sekali pakai: hanya untuk damage pertama yang diterima.
  if (l.sk?.perisaiAwal && !l.perisaiTerpakai) {
    dmg *= (1 - l.sk.perisaiAwal);
    l.perisaiTerpakai = true;
  }

  dmg = Math.max(1, Math.round(dmg));
  if (pukulan.kritis) p.kritisTerjadi++;
  l.hpAsli -= dmg;
  l.hp = Math.max(0, l.hp - dmg);

  // Nyali Terakhir: sekali per duel, serangan mematikan menyisakan 1 HP.
  if (l.hp <= 0 && l.nyawaCadangan) {
    l.nyawaCadangan = false;
    l.selamatDariMaut = true;
    l.hp = 1;
    l.hpAsli = 1;
  }

  // Isap darah dihitung dari HP MAKS PENGISAP, bukan dari damage yang diberikan.
  //
  // Versi lama (dmg x serap) punya cacat struktural: nilainya adalah
  // dmg x serap / hp_sendiri, jadi makin kecil badan kartunya makin besar
  // manfaatnya. Kelelawar Gua (158 ATK / 290 HP) memanen 87,1% di antara sesama
  // Common dari skill Common biasa, sementara skill yang sama di badan Petahan
  // nyaris tidak terasa. Basis HP maks membuat manfaatnya identik untuk semua
  // bentuk kartu: tiap pukulan mengembalikan porsi yang sama dari nyawa sendiri.
  if (p.sk?.serap) {
    p.pulihTertunda += Math.round(p.maxHp * p.sk.serap);
  }
  if (l.sk?.duri) {
    const balik = Math.round(dmg * l.sk.duri);
    p.hpAsli -= balik;
    p.hp = Math.max(0, p.hp - balik);
    if (p.hp <= 0 && p.nyawaCadangan) {
      p.nyawaCadangan = false;
      p.selamatDariMaut = true;
      p.hp = 1;
      p.hpAsli = 1;
    }
  }
  if (p.sk?.racun) {
    l.racunMasuk = p.sk.racun;
  }
  if (p.sk?.setrum && Math.random() < p.sk.setrum) {
    l.lewatiGiliran = true;
  }
  // Pelemah hanya sekali per duel — kalau menumpuk tiap pukulan, satu skill
  // Rare bisa membuat ATK lawan nyaris nol di ronde ketiga.
  if (p.sk?.pelemah && !p.pelemahTerpakai) {
    p.pelemahTerpakai = true;
    l.atk = Math.max(1, Math.round(l.atk * (1 - p.sk.pelemah)));
  }
}

/** Semua pukulan yang dilepaskan `p` di ronde ini, belum diterapkan. */
function rencanakanGiliran(p, l, giliran, snapP, snapL) {
  if (p.lewatiGiliran) {
    p.lewatiGiliran = false;
    return [];
  }
  const daftar = [hitungPukulan(p, l, giliran, snapP, snapL)];
  if (p.sk?.ganda && Math.random() < p.sk.ganda) {
    daftar.push(hitungPukulan(p, l, giliran, snapP, snapL));
  }
  return daftar;
}

/**
 * Satu ronde penuh, SERENTAK.
 *
 * Versi lama menjalankan giliran bergantian, dan itu adalah keunggulan raksasa:
 * di pertandingan cermin, pihak yang memukul duluan menang 74,7% — angka yang
 * ditentukan `Math.random()` di pemilihan inisiatif, bukan oleh pemain. Dengan
 * resolusi serentak angka itu turun ke 50,4%, dan keunggulan 10% daya berubah
 * dari 99,9% (praktis pasti) menjadi 69,6% (masih diunggulkan, masih bisa
 * kalah). Satu tingkat rarity tetap menentukan di 98%, jadi hasil gacha tidak
 * kehilangan artinya.
 */
function jalankanRonde(A, B, giliran) {
  const snapA = A.hp;
  const snapB = B.hp;
  const pukulanA = rencanakanGiliran(A, B, giliran, snapA, snapB);
  const pukulanB = rencanakanGiliran(B, A, giliran, snapB, snapA);
  for (const pk of pukulanA) terapkanPukulan(A, B, pk);
  for (const pk of pukulanB) terapkanPukulan(B, A, pk);
  // Penyembuhan dibayarkan SETELAH kedua sisi selesai memukul.
  terapkanPulih(A);
  terapkanPulih(B);
}

/**
 * Membayarkan isap darah yang tertunda.
 *
 * Ini bukan kerapian, ini perbaikan bug. Kalau penyembuhan dibayar di dalam
 * `terapkanPukulan`, urutan pemanggilan bocor jadi keunggulan: sisi yang
 * dihitung belakangan menyembuhkan diri SETELAH menerima damage (selalu
 * terpakai penuh), sementara sisi pertama menyembuhkan diri saat masih penuh
 * (terbuang oleh batas HP maks). Lebih parah lagi, penyembuhan itu bisa
 * MENGHIDUPKAN kartu yang HP-nya sudah nol di ronde yang sama.
 *
 * Akibatnya terukur dan brutal: Kelelawar Gua sebagai dek B menang 100% atas
 * dirinya sendiri sebagai dek A. Menunda pembayaran ke akhir ronde, ditambah
 * syarat masih hidup, membuat kedua sisi diperlakukan sama persis.
 */
function terapkanPulih(x) {
  const pulih = x.pulihTertunda;
  x.pulihTertunda = 0;
  if (pulih <= 0 || x.hp <= 0) return;
  x.hp = Math.min(x.maxHp, x.hp + pulih);
  x.hpAsli = Math.min(x.maxHp, x.hpAsli + pulih);
}

/** Regen dan racun diselesaikan bersamaan di akhir ronde. */
function akhirRonde(x) {
  if (x.hp <= 0) return;
  if (x.sk?.regen) {
    const pulih = Math.round(x.maxHp * x.sk.regen);
    x.hp = Math.min(x.maxHp, x.hp + pulih);
    x.hpAsli = Math.min(x.maxHp, x.hpAsli + pulih);
  }
  if (x.racunMasuk) {
    const luka = Math.round(x.maxHp * x.racunMasuk);
    x.hpAsli -= luka;
    x.hp = Math.max(0, x.hp - luka);
  }
}

/** Baris deskripsi satu petarung untuk laporan ronde. */
function barisPetarung(p) {
  const el = ELEMEN[p.kartu.elemen];
  const skl = p.sk ? ` · _${p.sk.nama}_` : '';
  const krit = p.kritis > 0 ? ` | KRIT: ${Math.round(p.kritis * 100)}%` : '';
  return `  👤 ${p.nama}: ${el.emoji} *${p.kartu.nama}* (Lv.${p.level}) [HP: ${fmt(p.hp)} | ATK: ${fmt(p.atk)}${krit}]${skl}`;
}

/**
 * Menentukan pemenang satu slot.
 *
 * Karena kedua kartu kini memukul serentak, TUMBANG BERSAMAAN jadi hasil yang
 * lumrah — dan itu butuh pemutus. Keduanya, baik saat tumbang bersamaan maupun
 * saat 8 ronde habis, memakai ukuran yang sama: PERSEN HP, bukan angka mentah.
 *
 * Dua percobaan sebelumnya gagal justru karena memakai angka mentah:
 *
 *   "kartu lebih murah bertahan" — niatnya mengganti bonus inisiatif lama
 *   sebagai kompensasi dek hemat. Kartu murah ber-ATK besar lalu memancing
 *   tumbang bersamaan dan memanen kemenangan gratis dari rarity di atasnya.
 *   Kompensasi dek hemat sudah ditangani Pasukan Ramping; jangan dibayar dua kali.
 *
 *   "luka mentah paling ringan" — terdengar netral, ternyata memihak keras ke
 *   kartu ber-HP kecil. Kartu 290 HP paling banter kelebihan luka satu pukulan
 *   lawan, sementara kartu 675 HP bisa kelebihan jauh lebih besar hanya karena
 *   badannya besar. Kelelawar Gua melonjak ke 90,3% di antara sesama Common
 *   gara-gara ini — bukan karena kartunya kuat, tapi karena badannya kecil.
 *
 * Persen menanyakan pertanyaan yang benar: siapa yang lebih dekat ke kemenangan.
 */
function tentukanPemenang(A, B) {
  const matiA = A.hp <= 0;
  const matiB = B.hp <= 0;
  if (!matiA && matiB) return { winner: 1, sebab: 'KO' };
  if (matiA && !matiB) return { winner: 2, sebab: 'KO' };
  if (matiA && matiB) {
    const lukaA = A.hpAsli / A.maxHp;
    const lukaB = B.hpAsli / B.maxHp;
    if (lukaA !== lukaB) return { winner: lukaA > lukaB ? 1 : 2, sebab: 'RINGAN' };
    return { winner: 0, sebab: 'SERI' };
  }
  const sisaA = A.hp / A.maxHp;
  const sisaB = B.hp / B.maxHp;
  if (sisaA > sisaB) return { winner: 1, sebab: 'SISA' };
  if (sisaB > sisaA) return { winner: 2, sebab: 'SISA' };
  return { winner: 0, sebab: 'SERI' };
}

/**
 * Mensimulasikan pertarungan 1 kartu vs 1 kartu
 */
function duelSatuSlot(slotIdx, itemA, itemB, nameA, nameB, sinergiA, sinergiB, diam = false) {
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

  const A = buatPetarung(itemA, nameA, sinergiA);
  const B = buatPetarung(itemB, nameB, sinergiB);
  if (!A || !B) {
    return { winner: 0, text: `⚔️ *Ronde ${slotIdx}:* Terjadi kesalahan data kartu.` };
  }

  A.elemenMult = pengaliElemen(A.kartu.elemen, B.kartu.elemen);
  B.elemenMult = pengaliElemen(B.kartu.elemen, A.kartu.elemen);

  // Pusaran dan sejenisnya: kerugian elemen dinaikkan kembali ke netral.
  if (A.sk?.abaikanLemah && A.elemenMult < 1) A.elemenMult = 1;
  if (B.sk?.abaikanLemah && B.elemenMult < 1) B.elemenMult = 1;

  // Mode diam: sparring dan ekspedisi menjalankan banyak pertarungan sekaligus
  // dan tidak boleh menghasilkan satu pun baris laporan. Merakit string di sana
  // hanya membuang waktu untuk teks yang langsung dibuang.
  const log = [];
  if (!diam) {
    log.push(`⚔️ *RONDE ${slotIdx}*`, barisPetarung(A), barisPetarung(B));
    // Persentasenya DIHITUNG dari PENGALI_UNGGUL, bukan ditulis manual. Angka
    // 35% dulu tertanam di teks ini, jadi begitu pengali elemen disetel ulang
    // laporan duel akan berbohong tanpa ada yang menyadarinya.
    const bonusElemenTeks = `+${Math.round((PENGALI_UNGGUL - 1) * 100)}% DMG`;
    if (A.elemenMult > 1) {
      log.push(`  ✨ ${A.kartu.nama} unggul elemen atas ${B.kartu.nama} (${bonusElemenTeks})!`);
    } else if (B.elemenMult > 1) {
      log.push(`  ✨ ${B.kartu.nama} unggul elemen atas ${A.kartu.nama} (${bonusElemenTeks})!`);
    }
  }

  let giliran = 1;
  while (A.hp > 0 && B.hp > 0 && giliran <= MAKS_GILIRAN) {
    jalankanRonde(A, B, giliran);
    if (A.hp <= 0 || B.hp <= 0) break;

    akhirRonde(A);
    akhirRonde(B);
    if (A.hp <= 0 || B.hp <= 0) break;

    giliran++;
  }

  const hasil = tentukanPemenang(A, B);
  if (diam) return { winner: hasil.winner, text: '' };

  for (const x of [A, B]) {
    if (x.selamatDariMaut) log.push(`  💀 ${x.kartu.nama} bertahan di 1 HP — _${x.sk.nama}_!`);
    if (x.kritisTerjadi > 0) log.push(`  💥 ${x.kartu.nama} melepas ${x.kritisTerjadi} pukulan kritis!`);
  }

  const menang = hasil.winner === 1 ? A : (hasil.winner === 2 ? B : null);
  const namaMenang = hasil.winner === 1 ? nameA : nameB;
  if (!menang) {
    log.push(`  ⚖️ Ronde ${slotIdx}: *SERI*`);
  } else if (hasil.sebab === 'KO') {
    log.push(`  🏆 Pemenang Ronde ${slotIdx}: *${namaMenang}* (${menang.kartu.nama} sisa HP: ${fmt(menang.hp)})`);
  } else if (hasil.sebab === 'RINGAN') {
    log.push(`  🏆 Pemenang Ronde ${slotIdx}: *${namaMenang}* (tumbang bersamaan — luka ${menang.kartu.nama} lebih ringan)`);
  } else {
    log.push(`  🏆 Pemenang Ronde ${slotIdx}: *${namaMenang}* (unggul sisa HP: ${Math.round(menang.hp / menang.maxHp * 100)}%)`);
  }

  return { winner: hasil.winner, text: log.join('\n') };
}

/** Ringkasan sinergi satu sisi untuk ditempel di laporan pertandingan. */
export function ringkasSinergi(nama, sinergi) {
  if (!sinergi?.aktif?.length) return `🔻 ${nama}: _tanpa sinergi dek_`;
  const daftar = sinergi.aktif.map(s => `${s.emoji} ${s.nama}`).join(' + ');
  const efek = [];
  if (sinergi.atk > 0) efek.push(`ATK +${Math.round(sinergi.atk * 100)}%`);
  if (sinergi.hp > 0) efek.push(`HP +${Math.round(sinergi.hp * 100)}%`);
  return `🔹 ${nama}: ${daftar} (${efek.join(', ')})`;
}

/**
 * Mensimulasikan pertandingan Best-of-3 antara 2 Dek
 */
export function simulate3v3(deckA, deckB, nameA = 'Pemain A', nameB = 'Pemain B', opts = {}) {
  const diam = opts.diam === true;
  const sinergiA = sinergiDek(deckA);
  const sinergiB = sinergiDek(deckB);

  let scoreA = 0;
  let scoreB = 0;
  const roundReports = [];

  for (let slot = 1; slot <= 3; slot++) {
    const res = duelSatuSlot(slot, deckA[slot], deckB[slot], nameA, nameB, sinergiA, sinergiB, diam);
    if (!diam) roundReports.push(res.text);
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
    roundReports,
    sinergiA,
    sinergiB,
    sinergiReport: diam ? [] : [ringkasSinergi(nameA, sinergiA), ringkasSinergi(nameB, sinergiB)]
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
