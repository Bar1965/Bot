/**
 * ARENA KARTU MONSTER — MESIN PERTARUNGAN 3V3 & PVE MENARA
 *
 * Mesin ini tidak tahu nama skill apa pun. Ia hanya membaca field angka dari
 * SKILL di cards.js (lihat daftar field di sana). Menambah skill baru cukup
 * dilakukan di katalog; file ini tidak perlu disentuh lagi.
 */

import {
  getKartu, statKartu, KARTU, ELEMEN, pengaliElemen, SKILL, skillEfektif,
  costKartu, sinergiDek, PENGALI_UNGGUL, KRIT_DMG, pengalahElemen, MAKS_BIAYA_DEK
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
function buatPetarung(item, nama, sinergi, efek = null, sisiPemain = true) {
  const kartu = getKartu(item.card_id);
  if (!kartu) return null;

  const dasar = statKartu(kartu, item.card_lv || 1);
  // R kartu ikut lewat `item`, sama seperti `card_lv`. `skillEfektif` menjamin
  // R1 mengembalikan objek SKILL yang asli, jadi kartu tanpa R berperilaku persis
  // seperti sebelum fitur ini ada.
  const sk = skillEfektif(kartu, item.refine || 1);
  // `skala` hanya dipakai penjaga Menara Abadi. Lantainya tidak punya ujung,
  // sedangkan katalog kartu punya — tanpa pengali ini, lantai 200 akan memakai
  // penjaga yang persis sama kuatnya dengan lantai 31.
  //
  // Sengaja dikalikan ke ATK dan HP dengan angka yang sama: hasil kali ATK×HP
  // adalah daya sebenarnya di duel giliran-bergantian (AGENTS.md §12r), jadi
  // menaikkan keduanya sama besar menaikkan daya tanpa menggeser peran kartu.
  // Lantai-lantai awal Menara Abadi sengaja memakai skala DI BAWAH 1 — penjaga
  // di sana bernilai 13★ melawan dek pemain yang dibatasi 10★, jadi tanpa
  // peredam itu lantai pertamanya sudah lebih berat daripada bos akhir Menara.
  const skala = Number(item.skala) > 0 ? Number(item.skala) : 1;
  // Modifier lantai Menara Abadi. Efek yang memukul pemain dan efek yang
  // memperkuat penjaga sengaja dipisah lewat sisiPemain: satu modifier hanya
  // boleh menyentuh satu sisi. Kalau sebuah modifier memukul dua-duanya, kurva
  // kesulitan Abadi yang sudah diukur tidak bisa dibaca lagi.
  const modAtk = sisiPemain ? (1 + (efek?.atkPemain || 0)) : 1;
  const modHp = sisiPemain ? 1 : (1 + (efek?.hpPenjaga || 0));

  const bonusAtk = (1 + (sk?.atkBonus || 0)) * (1 + (sinergi?.atk || 0)) * skala * modAtk;
  const bonusHp = (1 + (sk?.hpBonus || 0)) * (1 + (sinergi?.hp || 0)) * skala * modHp;
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
    kritis: Math.max(0, Math.min(0.85, (dasar.kritis || 0) + (sk?.kritBonus || 0) + (sisiPemain ? (efek?.kritPemain || 0) : 0))),
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
    racunMasuk: 0, // porsi HP maks yang hilang tiap akhir ronde (dari skill)
    // Dua field di bawah HANYA diisi modifier lantai Menara Abadi. Racun lantai
    // dipisah dari racunMasuk karena skill racun MENIMPA nilainya (lihat
    // terapkanPukulan), jadi menaruh keduanya di satu field membuat racun lantai
    // hilang begitu lawan memakai skill racun.
    racunLantai: sisiPemain ? (efek?.racunPemain || 0) : 0,
    perisaiLantai: sisiPemain ? null : (efek?.perisaiPenjaga || null)
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

  // Perisai modifier lantai: penjaga meredam serangan yang TIDAK unggul elemen,
  // selama beberapa ronde awal saja. Serangan unggul sengaja tidak diredam —
  // kalau semuanya ditahan, modifier ini cuma jadi bonus HP dan tidak mengajari
  // apa pun soal counter elemen.
  if (l.perisaiLantai && giliran <= l.perisaiLantai.ronde && p.elemenMult <= 1) {
    dmg *= (1 - l.perisaiLantai.potong);
  }

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
  //
  // `pulihSetelahMaut` adalah imbalan R untuk skill yang isinya cuma saklar
  // benar/salah dan karena itu tidak punya angka untuk diskalakan. Bernilai
  // NOL di R1, jadi baris ini tidak mengubah perilaku apa pun sampai pemiliknya
  // benar-benar menyisipkan duplikat.
  if (l.hp <= 0 && l.nyawaCadangan) {
    l.nyawaCadangan = false;
    l.selamatDariMaut = true;
    const pulih = Math.round(l.maxHp * (l.sk?.pulihSetelahMaut || 0));
    l.hp = Math.max(1, pulih);
    l.hpAsli = l.hp;
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
  const racunTotal = (x.racunMasuk || 0) + (x.racunLantai || 0);
  if (racunTotal) {
    const luka = Math.round(x.maxHp * racunTotal);
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
function duelSatuSlot(slotIdx, itemA, itemB, nameA, nameB, sinergiA, sinergiB, diam = false, efek = null) {
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

  const A = buatPetarung(itemA, nameA, sinergiA, efek, true);
  const B = buatPetarung(itemB, nameB, sinergiB, efek, false);
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
  // Modifier lantai Menara Abadi. Selalu null di duel PvP, spar, dan Menara
  // Penjaga — mesin ini dipakai lima tempat dan hanya satu yang punya modifier.
  const efek = opts.modifier?.efek || null;
  const sinergiA = sinergiDek(deckA);
  const sinergiB = sinergiDek(deckB);

  let scoreA = 0;
  let scoreB = 0;
  const roundReports = [];

  for (let slot = 1; slot <= 3; slot++) {
    const res = duelSatuSlot(slot, deckA[slot], deckB[slot], nameA, nameB, sinergiA, sinergiB, diam, efek);
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
      1: { card_id: 'MYT03', card_lv: 3 }, // Kala Rau
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
      3: { card_id: 'MYT03', card_lv: 5 }  // Kala Rau Lv. 5
    }
  }
];

export function getTowerFloor(floorNum) {
  return TOWER_FLOORS.find(f => f.floor === floorNum) || null;
}


// ============================================================
// MENARA ABADI: LANTAI TANPA UJUNG SESUDAH LANTAI 30
// ============================================================

/**
 * Menara Penjaga punya 30 lantai dan itu memang seharusnya berakhir — ia adalah
 * kurikulum, bukan tempat tinggal. Masalahnya, sesudah lantai 30 tidak ada
 * apa pun lagi: pemain paling rajin justru yang paling cepat kehabisan.
 *
 * Menara Abadi mengisi lubang itu. Penjaganya dibangkitkan dari nomor lantai,
 * bukan disimpan sebagai daftar, jadi ia tidak pernah habis dan tidak menambah
 * satu baris pun ke katalog kartu.
 *
 * TIGA HAL YANG MEMBUATNYA ADIL:
 *
 * 1. **Deterministik.** Lantai 47 selalu menghadirkan penjaga yang sama untuk
 *    semua orang. Kalau diacak, pemain akan mengulang lantai sampai dapat
 *    undian mudah, dan angka lantai berhenti berarti apa-apa di papan peringkat.
 * 2. **Elemen berputar.** Tiap lantai condong ke satu elemen yang berganti tiap
 *    lantai, jadi dek tunggal tidak bisa menembus selamanya — pemain harus
 *    merawat lebih dari tiga kartu.
 * 3. **Kekuatannya tumbuh, hadiahnya tidak.** Lihat `tcgHadiahAbadi`.
 */
const ABADI_ELIT = KARTU.filter(k => k.rarity === 'LEGENDARY' || k.rarity === 'MYTHIC');
const ABADI_ELEMEN_URUT = Object.keys(ELEMEN);
const ABADI_PER_ELEMEN = ABADI_ELEMEN_URUT.reduce((acc, e) => {
  acc[e] = ABADI_ELIT.filter(k => k.elemen === e).map(k => k.id);
  return acc;
}, {});

/**
 * Kurva kesulitan Menara Abadi. Angka-angka ini DIUKUR, bukan dikira-kira:
 * skrip kalibrasi mencari dek 10★ level 5 TERBAIK untuk tiap lantai (dari
 * 31.390 dek legal, dengan counter elemen) lalu menghitung persentase menangnya
 * atas 400 simulasi.
 *
 *   lantai  1 → 99 %      lantai 25 → 63 %      lantai 40 →  9 %
 *   lantai 10 → 95 %      lantai 30 → 32 %      lantai 50 →  1 %
 *   lantai 20 → 93 %      lantai 35 → 43 %
 *
 * Dua puluh lantai pertama memang longgar — itu putaran kemenangan untuk pemain
 * yang baru menamatkan lantai 30, bukan ujian. Pertandingan yang sebenarnya ada
 * di lantai 25-45, dan angka itu diukur dengan counter-pick sempurna tiap
 * lantai; pemain yang memakai satu dek untuk semuanya akan berhenti jauh lebih
 * cepat.
 *
 * `skala` bergerak halus dan `card_lv` bergerak lambat (tiap 12 lantai) dengan
 * sengaja. Versi pertama menaikkan level tiap 5-6 lantai dan hasilnya adalah
 * tembok: lantai 19 menang 85 %, lantai 20 menang 16 %, hanya karena penjaganya
 * naik satu level.
 */
export const ABADI_SKALA_AWAL = 0.86;
export const ABADI_SKALA_PER_LANTAI = 0.016;
export const ABADI_LANTAI_PER_LEVEL = 12;

/**
 * Pengacak deterministik 32-bit.
 *
 * WAJIB `Math.imul`, bukan `*`. Perkalian biasa di JavaScript memakai double,
 * jadi hasil dua bilangan 32-bit melewati 2^53 dan bit-bit rendahnya —
 * satu-satunya yang dipakai oleh `% panjang` di bawah — dibulatkan jadi nol.
 * Versi pertama fungsi ini memakai `*` dan menghasilkan nama lantai yang sama
 * persis untuk SETIAP lantai.
 */
function acakLantai(lantai, benih) {
  let h = (Math.imul(lantai, 2654435761) + Math.imul(benih, 40503)) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Nama lantai. Sengaja dirakit dari dua daftar pendek, bukan disimpan satu per
 * satu: lantainya tak terhingga, jadi daftar nama apa pun akan kehabisan.
 */
const ABADI_AWALAN = ['Kabut', 'Bayang', 'Gerbang', 'Palung', 'Menara', 'Lorong', 'Puing', 'Nyala'];
const ABADI_AKHIRAN = ['Tanpa Nama', 'Yang Runtuh', 'Sang Fajar', 'Keheningan', 'Bara Purba', 'Langit Retak', 'Sunyi Abadi', 'Arus Balik'];

export function namaLantaiAbadi(lantai) {
  const a = ABADI_AWALAN[acakLantai(lantai, 7) % ABADI_AWALAN.length];
  const b = ABADI_AKHIRAN[acakLantai(lantai, 11) % ABADI_AKHIRAN.length];
  return `${a} ${b}`;
}

/**
 * Dek penjaga untuk satu lantai Menara Abadi.
 * @param {number} lantai nomor lantai abadi (1 = lantai pertama sesudah Menara)
 */
export function dekAbadi(lantai) {
  const n = Math.max(1, Math.floor(Number(lantai) || 1));

  const level = Math.min(5, 2 + Math.floor((n - 1) / ABADI_LANTAI_PER_LEVEL));
  const skala = ABADI_SKALA_AWAL + (n - 1) * ABADI_SKALA_PER_LANTAI;

  const elemen = ABADI_ELEMEN_URUT[(n - 1) % ABADI_ELEMEN_URUT.length];
  const inti = ABADI_PER_ELEMEN[elemen] || [];
  const luar = ABADI_ELIT.filter(k => k.elemen !== elemen).map(k => k.id);

  const dipakai = new Set();
  const ambil = (daftar, benih) => {
    const sisa = daftar.filter(id => !dipakai.has(id));
    if (!sisa.length) return null;
    const id = sisa[acakLantai(n, benih) % sisa.length];
    dipakai.add(id);
    return id;
  };

  // Dua kartu bertema, satu penyimpang. Tiga-tiganya setema akan membuat lantai
  // ini kalah telak oleh satu dek pengalah elemen dan sisanya jadi hafalan;
  // satu slot di luar tema memaksa dek pemain tetap punya jawaban lain.
  const ids = [ambil(inti, 1), ambil(inti, 2), ambil(luar, 3)].filter(Boolean);

  const deck = {};
  ids.forEach((id, i) => { deck[i + 1] = { card_id: id, card_lv: level, skala }; });

  return { lantai: n, nama: namaLantaiAbadi(n), level, skala, elemen, deck };
}


// ============================================================
// PRATINJAU PENJAGA — LIHAT DULU, BARU SUSUN DEK
// ============================================================

/**
 * Sebelum ini, Menara Penjaga hanya memberi tahu nama lantai dan hadiahnya.
 * Dek penjaganya rahasia, jadi counter elemen mustahil dan pemain baru tahu
 * lawannya SESUDAH stamina terpakai. Itu bukan kesulitan, itu ketidaktahuan:
 * yang diuji cuma "sudah pernah kalah di sini atau belum".
 *
 * Membuka pratinjau tidak membuat Menara jadi mudah — mesin tempurnya tetap
 * sama. Yang berubah, kekalahan sekarang bisa dipelajari.
 */
export function ringkasPenjaga(deck) {
  return [1, 2, 3]
    .map(s => {
      const item = deck?.[s];
      if (!item) return null;
      const k = getKartu(item.card_id);
      if (!k) return null;
      const el = ELEMEN[k.elemen] || { emoji: '✨' };
      return `   ${s}. ${el.emoji} *${k.nama}* Lv.${item.card_lv || 1} · ${costKartu(k)}★`;
    })
    .filter(Boolean);
}

/** Elemen unik yang dipakai satu dek. */
export function elemenDek(deck) {
  return [...new Set(
    [1, 2, 3]
      .map(s => deck?.[s] && getKartu(deck[s].card_id))
      .filter(Boolean)
      .map(k => k.elemen)
  )];
}

/**
 * Saran counter: elemen apa yang benar-benar unggul melawan dek ini.
 *
 * Sengaja menyebut ELEMEN, bukan kartu — menyebut kartu berarti memberi jawaban
 * jadi, menyebut elemen berarti memberi arah dan pemain tetap memilih sendiri
 * dari koleksinya.
 *
 * VERSI PERTAMA FUNGSI INI MEMBERI SARAN YANG JUSTRU MERUGIKAN, dan cacatnya
 * ada dua sekaligus:
 *
 * 1. Ia meng-UNION `pengalahElemen` atas himpunan elemen UNIK dek lawan. Dek
 *    Menara Abadi selalu berbentuk 2 kartu setema + 1 penyimpang (lihat
 *    `dekAbadi`), jadi elemen yang cuma mengalahkan SATU kartu penyimpang tetap
 *    ikut disarankan walaupun ia lemah melawan DUA kartu inti. Diukur atas
 *    lantai 1-200, 147 lantai (73,5%) menyarankan minimal satu elemen yang
 *    nilai bersihnya di bawah 1 — merugikan, bukan menolong.
 * 2. Ia MEMBUANG kandidat yang kebetulan berelemen sama dengan salah satu kartu
 *    penjaga. Justru di situlah counter terbaik sering berada: 27% lantai
 *    menyembunyikan jawaban terbaiknya sendiri.
 *
 * Sekarang tiap kandidat dinilai atas KETIGA slot, bukan atas himpunan unik,
 * dan nilainya adalah rasio "seberapa keras aku memukul" dibagi "seberapa keras
 * aku dipukul". Rasio, bukan selisih, karena kedua arah sama pentingnya: elemen
 * yang memukul keras tapi juga dipukul keras bukan counter.
 *
 * Yang disarankan hanya kandidat dengan nilai bersih DI ATAS 1. Kalau tidak ada
 * satu pun, fungsi ini mengembalikan string kosong — lebih baik diam daripada
 * menyuruh pemain membawa elemen yang tidak menolong.
 */
export function saranCounter(deck) {
  const lawan = [1, 2, 3]
    .map(s => deck?.[s] && getKartu(deck[s].card_id))
    .filter(Boolean);
  if (!lawan.length) return '';

  const nilai = Object.keys(ELEMEN).map(e => {
    const menyerang = lawan.reduce((t, k) => t + pengaliElemen(e, k.elemen), 0) / lawan.length;
    const diserang = lawan.reduce((t, k) => t + pengaliElemen(k.elemen, e), 0) / lawan.length;
    return { elemen: e, bersih: menyerang / (diserang || 1) };
  }).sort((a, b) => b.bersih - a.bersih);

  // Ambang 1,001 supaya selisih pembulatan tidak lolos jadi "counter".
  const layak = nilai.filter(n => n.bersih > 1.001).slice(0, 2);
  if (!layak.length) return '';
  return layak.map(n => `${ELEMEN[n.elemen].emoji} ${ELEMEN[n.elemen].nama}`).join(' / ');
}


// ============================================================
// MODIFIER LANTAI MENARA ABADI
// ============================================================

/**
 * Masalah yang dijawab bagian ini: sesudah `.tcg autodek` ada, menyusun dek
 * bukan lagi keputusan. Bot menghitung kombinasi 3 kartu terkuat dari seluruh
 * koleksi, memasangnya, selesai — dan jawaban itu SAMA untuk setiap lantai.
 * Padahal seluruh tantangan arena ini hidup di penyusunan dek: pertarungannya
 * sendiri berjalan otomatis tanpa satu pun keputusan pemain.
 *
 * Modifier mengembalikan keputusan itu dengan cara yang tidak bisa dijawab satu
 * dek: tiap lantai memasang aturan berbeda, sebagian di antaranya justru
 * melarang jawaban terbaik. Dek 10★ terkuat tidak berguna di lantai yang
 * membatasi 8★, dan counter elemen terbaik tidak berguna di lantai yang
 * menyegel elemen itu.
 *
 * TIGA ATURAN YANG MEMBUATNYA ADIL:
 *
 * 1. **Deterministik.** Sama seperti nama dan penjaganya, modifier diturunkan
 *    dari nomor lantai. Lantai 43 memasang aturan yang sama untuk semua orang,
 *    selamanya. Kalau diacak, pemain akan mengulang sampai dapat aturan mudah.
 * 2. **Terlihat sebelum bertarung.** `.tcg abadi` menampilkannya lengkap dengan
 *    akibatnya. Modifier tersembunyi hanya akan terasa seperti bot curang.
 * 3. **Baru mulai di lantai 10.** Kurva kesulitan Abadi sudah diukur (lihat
 *    ABADI_SKALA_AWAL); sembilan lantai pertama tetap persis seperti hasil
 *    kalibrasi itu, sebagai tempat pemain mengenali sistemnya tanpa dihukum.
 *
 * Satu modifier hanya boleh memukul SATU sisi — pemain saja, atau penjaga saja.
 * Modifier yang menyentuh keduanya membuat efeknya tidak bisa dihitung lagi.
 */
export const MODIFIER_ABADI = [
  {
    id: 'KABUT_RACUN',
    nama: 'Kabut Beracun',
    emoji: '☠️',
    teks: 'Kartumu kehilangan 5% HP maks tiap akhir ronde.',
    efek: { racunPemain: 0.05 }
  },
  {
    id: 'PERISAI_PENJAGA',
    nama: 'Perisai Penjaga',
    emoji: '🛡️',
    teks: 'Serangan yang TIDAK unggul elemen dipotong 35% selama 2 ronde pertama.',
    efek: { perisaiPenjaga: { ronde: 2, potong: 0.35 } }
  },
  {
    id: 'SEGEL_ELEMEN',
    nama: 'Segel Elemen',
    emoji: '🚫',
    teks: 'Satu elemen pengalah penjaga disegel — tidak boleh ada di dekmu.',
    efek: { laranganElemen: true }
  },
  {
    id: 'ANGGARAN_KETAT',
    nama: 'Anggaran Ketat',
    emoji: '💰',
    teks: 'Batas biaya dek dipangkas jadi 8★.',
    efek: { batasBintang: 8 }
  },
  {
    id: 'PANGGILAN',
    nama: 'Panggilan Elemen',
    emoji: '📯',
    teks: 'Dekmu wajib memuat minimal 1 kartu elemen yang diminta.',
    efek: { wajibElemen: true }
  },
  {
    id: 'GRAVITASI',
    nama: 'Gravitasi Berat',
    emoji: '🪨',
    teks: 'ATK seluruh kartumu -12%.',
    efek: { atkPemain: -0.12 }
  },
  {
    id: 'TANGAN_DINGIN',
    nama: 'Tangan Dingin',
    emoji: '❄️',
    teks: 'Peluang kritis kartumu turun 10 poin persen.',
    efek: { kritPemain: -0.10 }
  },
  {
    id: 'BENTENG',
    nama: 'Benteng Penjaga',
    emoji: '🏯',
    teks: 'HP penjaga +18%.',
    efek: { hpPenjaga: 0.18 }
  }
];

export const ABADI_MODIFIER_MULAI = 10;

/**
 * Indeks modifier sebuah lantai, dengan jaminan tidak pernah sama dengan
 * lantai tepat di bawahnya.
 *
 * Rantainya sengaja dihitung ulang dari lantai pertama bermodifier, bukan
 * sekadar membandingkan undian mentah dua lantai. Percobaan pertama memakai
 * cara pendek itu dan masih menghasilkan tiga lantai berturut-turut dengan
 * aturan yang sama: lantai yang undiannya sudah digeser bisa mendarat tepat di
 * undian mentah lantai berikutnya, dan perbandingan mentah tidak melihatnya.
 * Iterasinya murah dan hasilnya tetap deterministik.
 */
function indeksModifier(n) {
  let prev = -1;
  for (let i = ABADI_MODIFIER_MULAI; i <= n; i++) {
    let idx = acakLantai(i, 23) % MODIFIER_ABADI.length;
    if (idx === prev) idx = (idx + 1) % MODIFIER_ABADI.length;
    prev = idx;
  }
  return prev;
}

/**
 * Modifier untuk satu lantai Abadi, atau null kalau lantainya masih bersih.
 * Elemen yang disegel/diminta ikut diselesaikan di sini supaya pemanggil tidak
 * perlu tahu cara menurunkannya — dan supaya elemen yang tampil di layar
 * pratinjau dijamin sama dengan yang divalidasi saat bertarung.
 */
export function modifierAbadi(lantai) {
  const n = Math.max(1, Math.floor(Number(lantai) || 1));
  if (n < ABADI_MODIFIER_MULAI) return null;

  const dasar = MODIFIER_ABADI[indeksModifier(n)];
  const elemenPenjaga = ABADI_ELEMEN_URUT[(n - 1) % ABADI_ELEMEN_URUT.length];
  const efek = { ...dasar.efek };
  let teks = dasar.teks;
  let elemen = null;

  if (efek.laranganElemen === true) {
    // Yang disegel adalah salah satu elemen PENGALAH penjaga, bukan elemen acak.
    // Menyegel elemen sembarangan sering tidak terasa apa-apa; menyegel jalan
    // termudah memaksa pemain menang tanpa counter andalannya.
    const pengalah = pengalahElemen(elemenPenjaga);
    elemen = pengalah.length
      ? pengalah[acakLantai(n, 29) % pengalah.length]
      : ABADI_ELEMEN_URUT[acakLantai(n, 29) % ABADI_ELEMEN_URUT.length];
    efek.laranganElemen = elemen;
    teks = `Elemen ${ELEMEN[elemen].emoji} *${ELEMEN[elemen].nama}* disegel — tidak boleh ada di dekmu.`;
  }

  if (efek.wajibElemen === true) {
    elemen = ABADI_ELEMEN_URUT[acakLantai(n, 31) % ABADI_ELEMEN_URUT.length];
    efek.wajibElemen = elemen;
    teks = `Dek wajib memuat minimal 1 kartu ${ELEMEN[elemen].emoji} *${ELEMEN[elemen].nama}*.`;
  }

  return { id: dasar.id, nama: dasar.nama, emoji: dasar.emoji, teks, efek, elemen };
}

/**
 * Memeriksa dek pemain terhadap syarat penyusunan sebuah modifier.
 * Mengembalikan { boleh, alasan } dengan alasan sudah berupa kalimat siap kirim.
 *
 * Syarat penyusunan sengaja diperiksa DI LUAR mesin tempur: melarang elemen
 * atau membatasi bintang bukan efek pertarungan, itu aturan pendaftaran. Kalau
 * dicampur ke dalam simulasi, pemain akan kehilangan stamina untuk pertarungan
 * yang sebenarnya tidak pernah boleh dimulai.
 */
export function periksaSyaratModifier(deck, modifier) {
  if (!modifier?.efek) return { boleh: true };
  const kartu = [1, 2, 3].map(s => deck?.[s] && getKartu(deck[s].card_id)).filter(Boolean);
  const efek = modifier.efek;

  if (efek.laranganElemen) {
    const melanggar = kartu.filter(k => k.elemen === efek.laranganElemen);
    if (melanggar.length) {
      const el = ELEMEN[efek.laranganElemen];
      return {
        boleh: false,
        alasan: `${el.emoji} Elemen *${el.nama}* disegel di lantai ini, tapi dekmu memakai *${melanggar.map(k => k.nama).join(', ')}*.`
      };
    }
  }

  if (efek.wajibElemen) {
    const ada = kartu.some(k => k.elemen === efek.wajibElemen);
    if (!ada) {
      const el = ELEMEN[efek.wajibElemen];
      return {
        boleh: false,
        alasan: `📯 Lantai ini menuntut minimal 1 kartu ${el.emoji} *${el.nama}* di dekmu.`
      };
    }
  }

  if (efek.batasBintang) {
    const total = kartu.reduce((t, k) => t + costKartu(k), 0);
    if (total > efek.batasBintang) {
      return {
        boleh: false,
        alasan: `💰 Batas biaya dek di lantai ini *${efek.batasBintang}★*, dekmu sekarang *${total}★*.`
      };
    }
  }

  return { boleh: true };
}


// ============================================================
// GAUNTLET PEKANAN — TIGA PERTARUNGAN, KARTU TIDAK BOLEH DIULANG
// ============================================================

/**
 * Cacat paling lama arena ini: pemain hanya pernah butuh TIGA kartu bagus.
 * Katalognya 60 kartu, tapi tidak ada satu pun konten yang menuntut kartu
 * keempat — dan sejak `.tcg jualsemua` ada, menyempitkan koleksi justru
 * menguntungkan.
 *
 * Gauntlet adalah jawabannya: tiga pertarungan berurutan dalam satu pekan, dan
 * kartu yang sudah bertarung TIDAK boleh dipakai lagi di tahap berikutnya.
 * Sekali tamat butuh sembilan kartu terawat, bukan tiga. Lawannya menguat tiap
 * tahap, jadi sembilan kartu itu juga tidak boleh asal ada.
 *
 * Deknya deterministik per pekan: semua orang di semua grup menghadapi tiga
 * lawan yang sama persis sepanjang pekan itu, jadi hasilnya bisa dibandingkan
 * dan tidak ada yang bisa mengulang sampai dapat undian mudah.
 */
export const GAUNTLET_TAHAP = 3;

/**
 * VERSI PERTAMA PROFIL INI RUSAK, dan cara rusaknya layak dicatat.
 *
 * Dulu tiap tahap memilih 3 kartu dari kolam rarity tinggi TANPA batas biaya
 * bintang, lalu dikalikan skala sampai 1,10 — sementara pemain dikunci di
 * MAKS_BIAYA_DEK (10 bintang). Hasil pengukuran: dek lawan tahap 3 bernilai
 * 12-14 bintang tergantung undian pekan, dan pada pekan 24 Agustus 2026 dek
 * terbaik yang mungkin ada (koleksi 60 kartu penuh Lv.5) cuma menang 10%.
 * Hadiah tahap 3 praktis tidak akan pernah dibayar ke siapa pun.
 *
 * Sekarang lawan memakai ANGGARAN YANG SAMA dengan pemain. Aturannya jadi bisa
 * dibaca pemain — 'dia main dengan batas yang sama denganku' — dan
 * kesulitannya naik lewat LEVEL kartu, satu-satunya sumbu yang bisa dinaikkan
 * bertahap tanpa mengubah aturan mainnya.
 *
 * Medan skala sengaja dikembalikan ke 1,00 di ketiga tahap. Skala adalah
 * peredam yang dipakai Menara Abadi (ABADI_SKALA_AWAL) HANYA karena penjaganya
 * melampaui anggaran pemain; begitu anggarannya disamakan, tidak ada yang perlu
 * diredam maupun dilebihkan. Menaikkannya lagi tanpa harness kalibrasi seperti
 * scripts/tcgAbadiKalibrasi.mjs adalah menebak, dan umpan balik Gauntlet
 * bersifat pekanan — satu tebakan salah merusak satu pekan penuh.
 */
const GAUNTLET_PROFIL = [
  { nama: 'Penantang', level: 3, skala: 1.00, rarity: ['RARE', 'EPIC', 'LEGENDARY'] },
  { nama: 'Panglima', level: 4, skala: 1.00, rarity: ['EPIC', 'LEGENDARY', 'MYTHIC'] },
  { nama: 'Juara Pekan', level: 5, skala: 1.00, rarity: ['EPIC', 'LEGENDARY', 'MYTHIC'] }
];

/** Benih 32-bit dari teks (kunci pekan). FNV-1a — cukup untuk memilih kartu. */
function benihTeks(teks) {
  let h = 2166136261 >>> 0;
  const t = String(teks || '');
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function dekGauntlet(kunciPekan, tahap) {
  const t = Math.min(GAUNTLET_TAHAP, Math.max(1, Math.floor(Number(tahap) || 1)));
  const profil = GAUNTLET_PROFIL[t - 1];
  const benih = benihTeks(`${kunciPekan}#${t}`);

  const kolam = KARTU.filter(k => profil.rarity.includes(k.rarity));
  const cadangan = KARTU.filter(k => !profil.rarity.includes(k.rarity));
  const dipakai = new Set();

  // Anggaran bintang ditegakkan slot per slot, dan tiap slot yang belum terisi
  // disisakan minimal 1 bintang — kalau tidak, dua kartu mahal di awal membuat
  // slot ketiga mustahil diisi dan lawan bertarung dengan dek dua kartu.
  let biaya = 0;
  const ids = [];
  for (let slot = 0; slot < 3; slot++) {
    const sisaSlot = 2 - slot;
    const muat = (k) => (biaya + costKartu(k) + sisaSlot) <= MAKS_BIAYA_DEK;
    // Kolam utama dulu; kalau tidak ada yang muat, turun ke rarity lain supaya
    // deknya tetap tiga kartu penuh, bukan dua.
    let sisa = kolam.filter(k => !dipakai.has(k.id) && muat(k));
    if (!sisa.length) sisa = cadangan.filter(k => !dipakai.has(k.id) && muat(k));
    if (!sisa.length) break;
    // Lawan tidak cuma patuh anggaran, ia juga MEMILIH DENGAN BAIK. Undian bebas
    // dari seluruh kolam menghasilkan dek acak-acakan: diukur, dek pemain
    // terbaik menang 100% di ketiga tahap. Dibatasi ke beberapa kartu terkuat
    // yang muat, lawan jadi setara dek yang disusun sungguh-sungguh, dan
    // kesulitannya kembali datang dari LEVEL — sumbu yang memang bertahap.
    // Tetap ada undian di antara yang terkuat supaya tiap pekan tidak sama.
    sisa = sisa.slice().sort((a, x) => dayaKartu(x, profil.level) - dayaKartu(a, profil.level));
    const pilihan = sisa.slice(0, Math.min(4, sisa.length));
    const k = pilihan[acakLantai(benih, 3 + slot * 2) % pilihan.length];
    dipakai.add(k.id);
    ids.push(k.id);
    biaya += costKartu(k);
  }

  const deck = {};
  ids.forEach((id, i) => { deck[i + 1] = { card_id: id, card_lv: profil.level, skala: profil.skala }; });

  return { tahap: t, nama: profil.nama, level: profil.level, skala: profil.skala, biaya, deck };
}


// ============================================================
// BOS ARENA GRUP — SATU LAWAN BERSAMA
// ============================================================

/**
 * Semua konten Arena sampai sekarang bersifat sendirian: menara, gerbang,
 * ekspedisi, bahkan duel pun cuma dua orang. Grup yang ramai dan grup yang sepi
 * memainkan permainan yang persis sama.
 *
 * Bos Arena adalah satu-satunya konten yang hasilnya ditentukan bersama: satu
 * kantong HP raksasa milik grup, dipukul siapa pun yang punya dek, dan baru
 * tumbang kalau cukup banyak orang ikut. Hadiahnya dibagi menurut sumbangan
 * damage, jadi ikut memukul selalu berarti sesuatu meski bukan yang terkuat.
 *
 * PERBEDAAN PENTING dari mesin duel: di sini ayunan elemen jauh lebih besar
 * (x1,5 lawan x0,7, bukan x1,13 lawan x0,89). Alasannya, bos tidak balas
 * memukul — satu-satunya keputusan yang tersisa adalah "kartu apa yang kamu
 * bawa". Kalau ayunannya sekecil di duel, keputusan itu tidak akan terasa dan
 * yang menang cuma yang koleksinya paling tebal.
 */
export const BOS_PENGALI_UNGGUL = 1.5;
export const BOS_PENGALI_LEMAH = 0.7;

const BOS_AWALAN = ['Naga', 'Raksasa', 'Titan', 'Leviathan', 'Garuda', 'Kalajengking', 'Kraken', 'Behemoth'];
const BOS_AKHIRAN = ['Palung Hitam', 'Bara Purba', 'Badai Utara', 'Rimba Mati', 'Langit Runtuh', 'Sunyi Beku', 'Kabut Merah', 'Gerbang Akhir'];

/** Data bos untuk satu pekan. Deterministik: semua grup melawan bos yang sama. */
export function bosPekan(kunciPekan) {
  const benih = benihTeks(String(kunciPekan));
  const nama = `${BOS_AWALAN[acakLantai(benih, 13) % BOS_AWALAN.length]} ${BOS_AKHIRAN[acakLantai(benih, 17) % BOS_AKHIRAN.length]}`;
  const elemen = ABADI_ELEMEN_URUT[acakLantai(benih, 19) % ABADI_ELEMEN_URUT.length];
  return { nama, elemen };
}

/**
 * Daya satu kartu di level tertentu. Rumusnya sama persis dengan yang dipakai
 * `tcgAutoBuildDeck` supaya "kartu terkuat" berarti hal yang sama di dua tempat.
 */
export function dayaKartu(kartu, level = 1) {
  const st = statKartu(kartu, level);
  return Math.round((st.atk * 2.2) + (st.hp * 0.9) + ((st.kritis || 0) * 500));
}

/**
 * Damage satu serangan ke bos. Mengembalikan total plus rincian per kartu
 * supaya laporannya bisa menunjukkan kartu mana yang unggul elemen — itu yang
 * mengajari pemain mengganti dek, bukan angka totalnya.
 */
export function hitungSeranganBos(deck, elemenBos) {
  const rincian = [];
  let total = 0;

  for (const slot of [1, 2, 3]) {
    const item = deck?.[slot];
    if (!item) continue;
    const kartu = getKartu(item.card_id);
    if (!kartu) continue;

    let mult = 1;
    if (ELEMEN[kartu.elemen]?.unggul.includes(elemenBos)) mult = BOS_PENGALI_UNGGUL;
    else if (ELEMEN[elemenBos]?.unggul.includes(kartu.elemen)) mult = BOS_PENGALI_LEMAH;

    const dasar = dayaKartu(kartu, item.card_lv || 1);
    const varian = 0.92 + Math.random() * 0.16;
    const dmg = Math.max(1, Math.round(dasar * mult * varian));
    total += dmg;
    rincian.push({ nama: kartu.nama, elemen: kartu.elemen, mult, dmg });
  }

  return { total, rincian };
}
