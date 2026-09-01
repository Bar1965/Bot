/**
 * UJI ASAP UNDERCOVER
 *
 * AGENTS.md bilang proyek ini tidak bisa diuji tanpa sesi WhatsApp tertaut.
 * Untuk Undercover itu tidak sepenuhnya benar — persis seperti Arena Kartu:
 * satu-satunya yang dibutuhkan handler dari `sock` adalah `sendMessage`, dan
 * lapisan datanya SQLite biasa. Keduanya bisa dipalsukan.
 *
 * Berkas ini menjalankan permainan Undercover sungguhan dari lobi sampai game
 * berakhir — lewat handler yang sama yang dipakai pemain — di atas database
 * sementara, lalu memeriksa hasilnya benar-benar terjadi. Fitur baru (Ronde
 * Anonim, Sidang Terakhir, Bisikan Arwah, Misi Rahasia, Si Mabuk, Pasar Gelap,
 * Trust Score) diuji terpisah supaya tidak bergantung undian modifier.
 *
 * Pakai:
 *   node scripts/undercoverSmokeTest.mjs
 *
 * KEAMANAN: skrip pindah ke direktori sementara SEBELUM memuat lapisan
 * database, karena `connection.js` membuka './shop.db' relatif terhadap
 * direktori kerja. Tanpa itu, menjalankan uji ini dari akar repo akan
 * menyuntikkan data uji ke database produksi pemilik bot.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';

const AKAR = path.resolve(import.meta.dirname, '..');
const REPO = pathToFileURL(AKAR).href + '/';

const kotakPasir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercover-uji-'));
process.chdir(kotakPasir);
console.log(`Kotak pasir: ${kotakPasir}`);

process.env.JWT_SECRET ||= 'uji-asap-bukan-rahasia-sungguhan';
process.env.ADMIN_USER ||= 'ujiasap';
process.env.ADMIN_PASSWORD_HASH ||= '$2b$10$0000000000000000000000000000000000000000000000000000';

// Impor HARUS sesudah chdir — lihat catatan keamanan di atas.
const db = await import(REPO + 'database.js');
const uc = await import(REPO + 'src/games/undercover.js');
const { activeUndercoverGames } = uc;
const { clearSessionTimer, getPlayerRoleData, isCivilianRole, buildWordMask, revealRandomLetter } =
  await import(REPO + 'src/games/undercover/state.js');
const { pickRoundModifier, startAnonCluePhase, startTrialPhase, clueLeaksSecret } =
  await import(REPO + 'src/games/undercover/flow.js');
const { computeTrustScores, buildTrustBoard, buildDeadliestClue } =
  await import(REPO + 'src/games/undercover/stats.js');
const { ROUND_MODIFIERS, MODIFIER_MIN_ROUND, MODIFIER_MIN_ALIVE, MISSION_DEFS } =
  await import(REPO + 'src/games/undercover/constants.js');

await db.openDb();
await db.initDb();

// ============================================================
// PERANCAH
// ============================================================
const terkirim = [];
const sock = {
  sendMessage: async (jid, isi) => {
    terkirim.push({ jid, teks: isi.text || isi.caption || '' });
    return { key: { id: 'uji' } };
  }
};

const GRUP = '120363000000000000@g.us';
const PEMAIN = Array.from({ length: 7 }, (_, i) => `62811100000${i}@s.whatsapp.net`);

const pesan = () => ({ key: { remoteJid: GRUP }, message: { conversation: 'x' } });

let periksa = 0;
const gagal = [];
const diam = process.argv.includes('--ringkas');

function harus(label, syarat, detail = '') {
  periksa++;
  if (!syarat) {
    gagal.push({ label, err: detail || 'syarat tidak terpenuhi' });
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  } else if (!diam) {
    console.log(`  ✓ ${label}`);
  }
}

function harusMemuat(label, teks, pola) {
  const ok = pola instanceof RegExp ? pola.test(teks) : String(teks).includes(pola);
  harus(label, ok, ok ? '' : `tidak menemukan ${pola} di: ${String(teks).slice(0, 200)}`);
}

const teksTerakhir = () => (terkirim.at(-1)?.teks || '');
const semuaTeks = (mulai) => terkirim.slice(mulai).map(t => t.teks).join('\n');

async function seedPoin() {
  for (const p of PEMAIN) await db.addGamePoints(p, 5000);
}

/** Petunjuk aman: tidak pernah membocorkan kata rahasia & lolos semua modifier. */
function buatPetunjuk(session, idx) {
  const uniq = `zqxr${session.round}p${session.cluePass || 1}n${idx}`;
  // Estafet mewajibkan berbagi 1 kata dengan petunjuk sebelumnya; kata "benda"
  // dipakai semua pemain supaya rantainya selalu nyambung.
  if (session.modifier?.key === 'ESTAFET') return `benda ${uniq}`;
  return uniq;
}

/**
 * Jalankan game sampai selesai tanpa menunggu satu pun timer asli.
 * Mengembalikan jumlah langkah yang dipakai.
 */
async function mainkanSampaiTamat(batas = 400) {
  let langkah = 0;
  while (activeUndercoverGames.has(GRUP) && langkah < batas) {
    langkah++;
    const s = activeUndercoverGames.get(GRUP);
    clearSessionTimer(s); // uji ini menggerakkan fase secara manual

    if (s.status === 'CLUE_PHASE') {
      const giliran = s.alivePlayers[s.turnIndex];
      if (!giliran) break;
      const idx = s.players.findIndex(p => p === giliran);
      await uc.handleUndercoverClue(sock, GRUP, giliran, pesan(), buatPetunjuk(s, idx));
      continue;
    }

    if (s.status === 'ANON_CLUE_PHASE') {
      const belum = s.alivePlayers.find(p => !s.anonSubmitted?.has(p));
      if (!belum) break;
      const idx = s.players.findIndex(p => p === belum);
      await uc.handleUndercoverAnonClue(sock, belum, belum, pesan(), buatPetunjuk(s, idx));
      continue;
    }

    if (s.status === 'DISCUSSION_PHASE') {
      await uc.handleUndercoverContinue(sock, GRUP, s.host, pesan(), false, true);
      continue;
    }

    if (s.status === 'VOTING_PHASE') {
      // Semua menumpuk suara ke satu orang supaya tidak pernah seri.
      const korban = s.alivePlayers[0];
      const cadangan = s.alivePlayers[1];
      const pemilih = s.alivePlayers.find(p => !s.votes.has(p));
      if (!pemilih) break;
      const target = pemilih === korban ? cadangan : korban;
      await uc.handleUndercoverVote(sock, GRUP, pemilih, pesan(), target);
      continue;
    }

    if (s.status === 'TRIAL_PHASE') {
      const juri = s.alivePlayers.find(p => p !== s.trialAccused && !s.trialVotes?.has(p));
      if (!juri) break;
      await uc.handleTrialVote(sock, GRUP, juri, pesan(), 'GUILTY');
      continue;
    }

    if (s.status === 'MR_WHITE_GUESS') {
      await uc.handleMrWhiteGuess(sock, GRUP, s.mrWhiteGuessPending, pesan(), 'jawabanpastisalah');
      continue;
    }

    break;
  }
  return langkah;
}

async function bukaGamePenuh({ pemain = PEMAIN, taruhan = 30 } = {}) {
  await uc.handleUndercover(sock, GRUP, pemain[0], pesan(), ['undercover', String(taruhan)], 'undercover', true);
  for (const p of pemain.slice(1)) {
    await uc.handleUndercover(sock, GRUP, p, pesan(), ['joinundercover'], 'joinundercover', true);
  }
  await uc.handleUndercover(sock, GRUP, pemain[0], pesan(), ['startundercover'], 'startundercover', true);
  // Semua memilih tema 1 -> resolveCategoryVote langsung jalan saat suara penuh.
  for (const p of pemain) {
    await uc.handleCategoryVote(sock, GRUP, p, pesan(), '1');
  }
  return activeUndercoverGames.get(GRUP);
}

function bersihkanSesi() {
  const s = activeUndercoverGames.get(GRUP);
  if (s) clearSessionTimer(s);
  activeUndercoverGames.delete(GRUP);
}

// ============================================================
// 1. LAYAR INFORMASI (tanpa sesi)
// ============================================================
console.log('\n════ 1. LAYAR INFORMASI ════');
await seedPoin();

let i = terkirim.length;
await uc.handleUndercover(sock, GRUP, PEMAIN[0], pesan(), ['undercover', 'role'], 'undercover', true);
harusMemuat('panduan peran tampil', teksTerakhir(), 'PANDUAN LENGKAP PERAN');
harusMemuat('panduan menyebut Si Mabuk', teksTerakhir(), 'Si Mabuk');
harusMemuat('panduan menyebut Sidang Terakhir', teksTerakhir(), 'Sidang Terakhir');

await uc.handleUndercover(sock, GRUP, PEMAIN[0], pesan(), ['undercover', 'card'], 'undercover', true);
harusMemuat('toko kartu tampil', teksTerakhir(), 'TOKO KARTU AKSI');

await uc.handleUndercover(sock, GRUP, PEMAIN[0], pesan(), ['undercover', 'top'], 'undercover', true);
harusMemuat('papan peringkat tampil', teksTerakhir(), 'PAPAN PERINGKAT');

await uc.handleUndercover(sock, GRUP, PEMAIN[0], pesan(), ['undercover', 'stats'], 'undercover', true);
harusMemuat('statistik tampil', teksTerakhir(), 'AGEN UNDERCOVER');

await uc.handleUndercover(sock, GRUP, PEMAIN[0], pesan(), ['undercover', 'misi'], 'undercover', true);
harusMemuat('misi menolak di luar sesi', teksTerakhir(), 'tidak sedang berada di sesi');

// ============================================================
// 2. LOBI, TARUHAN & PEMBATALAN
// ============================================================
console.log('\n════ 2. LOBI & REFUND ════');
const poinAwal = (await db.getGameProfile(PEMAIN[0])).points;
await uc.handleUndercover(sock, GRUP, PEMAIN[0], pesan(), ['undercover', '50'], 'undercover', true);
harusMemuat('lobi terbuka', teksTerakhir(), 'LOBBY UNDERCOVER');
harus('sesi tercatat', activeUndercoverGames.has(GRUP));

await uc.handleUndercover(sock, GRUP, PEMAIN[1], pesan(), ['joinundercover'], 'joinundercover', true);
harusMemuat('pemain kedua gabung', teksTerakhir(), 'berhasil bergabung');

await uc.handleUndercover(sock, GRUP, PEMAIN[1], pesan(), ['undercover', 'cancel'], 'undercover', true);
harusMemuat('non-host tidak boleh membatalkan', teksTerakhir(), 'Hanya pembuat lobi');

await uc.handleUndercover(sock, GRUP, PEMAIN[0], pesan(), ['undercover', 'cancel'], 'undercover', true);
harusMemuat('host membatalkan lobi', teksTerakhir(), 'berhasil dibatalkan');
harus('sesi terhapus setelah cancel', !activeUndercoverGames.has(GRUP));
harus('taruhan belum dipotong di lobi', (await db.getGameProfile(PEMAIN[0])).points === poinAwal,
  `poin ${ (await db.getGameProfile(PEMAIN[0])).points } vs ${poinAwal}`);

// ============================================================
// 3. GAME PENUH 7 PEMAIN DARI LOBI SAMPAI TAMAT
// ============================================================
console.log('\n════ 3. GAME PENUH 7 PEMAIN ════');
i = terkirim.length;
let sesi = await bukaGamePenuh();
harus('peran terbagi', !!sesi && sesi.playerRoles.size === 7, `size=${sesi?.playerRoles?.size}`);
harus('ronde 1 dimulai', sesi.round === 1 && ['CLUE_PHASE', 'ANON_CLUE_PHASE'].includes(sesi.status), `status=${sesi?.status}`);
harus('taruhan dipotong', sesi.buyInCharged === true);
harus('semua dapat misi rahasia', sesi.players.every(p => !!getPlayerRoleData(sesi, p)?.mission));
harusMemuat('DM misi terkirim', semuaTeks(i), 'MISI RAHASIA PERSONAL');

const kataWarga = sesi.pair.civilian;
const langkah = await mainkanSampaiTamat();
harus('game selesai tanpa menggantung', !activeUndercoverGames.has(GRUP), `langkah=${langkah}`);
const penutup = semuaTeks(i);
harusMemuat('rekap akhir dibongkar', penutup, 'REKAP LENGKAP PERMAINAN');
harusMemuat('kata warga dibuka', penutup, kataWarga);
harusMemuat('trust score tampil', penutup, 'TRUST SCORE AKHIR GAME');
harusMemuat('hasil misi tampil', penutup, 'HASIL MISI RAHASIA');
bersihkanSesi();

// ============================================================
// 4. GAME KECIL 3 PEMAIN (tanpa sidang, tanpa peran netral penuh)
// ============================================================
console.log('\n════ 4. GAME MINIMAL 3 PEMAIN ════');
i = terkirim.length;
sesi = await bukaGamePenuh({ pemain: PEMAIN.slice(0, 3), taruhan: 10 });
harus('3 pemain dapat peran', sesi.playerRoles.size === 3);
await mainkanSampaiTamat();
harus('game 3 pemain selesai', !activeUndercoverGames.has(GRUP));
bersihkanSesi();

// ============================================================
// 5. RONDE ANONIM
// ============================================================
console.log('\n════ 5. RONDE ANONIM ════');
sesi = await bukaGamePenuh({ pemain: PEMAIN.slice(0, 5) });
clearSessionTimer(sesi);
sesi.round = 2;
sesi.cluePass = 1;
i = terkirim.length;
await startAnonCluePhase(sock, GRUP, null);
harus('fase anonim aktif', sesi.status === 'ANON_CLUE_PHASE');
harusMemuat('instruksi anonim terkirim', semuaTeks(i), 'RONDE ANONIM');

// Petunjuk yang membocorkan kata rahasia harus ditolak.
const pemainAnon = sesi.alivePlayers[0];
i = terkirim.length;
await uc.handleUndercoverAnonClue(sock, pemainAnon, pemainAnon, pesan(), getPlayerRoleData(sesi, pemainAnon).word);
harusMemuat('anon menolak bocoran kata', teksTerakhir(), 'DILARANG menyebutkan kata rahasia');
harus('bocoran tidak tercatat', !sesi.anonSubmitted.has(pemainAnon));

i = terkirim.length;
for (const p of [...sesi.alivePlayers]) {
  const idx = sesi.players.findIndex(x => x === p);
  await uc.handleUndercoverAnonClue(sock, p, p, pesan(), buatPetunjuk(sesi, idx));
}
harus('fase anonim lanjut ke diskusi', sesi.status === 'DISCUSSION_PHASE', `status=${sesi.status}`);
const papanAnon = semuaTeks(i);
harusMemuat('papan anonim tayang', papanAnon, 'PAPAN PETUNJUK ANONIM');
// Papan sengaja tetap mencantumkan daftar pemain hidup (dibutuhkan untuk
// `.vote [1-N]`), yang penting BARIS PETUNJUKNYA tidak beratribusi.
const barisPetunjuk = papanAnon.split(String.fromCharCode(10)).filter(b => /^[A-H]\. _"/.test(b));
harus('petunjuk anonim berlabel huruf', barisPetunjuk.length >= 5, `baris=${barisPetunjuk.length}`);
harus('baris petunjuk tidak menempel nama siapa pun',
  barisPetunjuk.every(b => !b.includes('@')), barisPetunjuk.join(' | '));
harus('setoran ganda ditolak', await (async () => {
  const p = sesi.alivePlayers[0];
  const sebelum = terkirim.length;
  sesi.status = 'ANON_CLUE_PHASE';
  await uc.handleUndercoverAnonClue(sock, p, p, pesan(), 'zqxlagi');
  sesi.status = 'DISCUSSION_PHASE';
  return semuaTeks(sebelum).includes('sudah menyetor petunjuk');
})());
bersihkanSesi();

// ============================================================
// 6. SIDANG TERAKHIR
// ============================================================
console.log('\n════ 6. SIDANG TERAKHIR ════');
sesi = await bukaGamePenuh({ pemain: PEMAIN.slice(0, 5) });
clearSessionTimer(sesi);
const terdakwa = sesi.alivePlayers[0];
i = terkirim.length;
await startTrialPhase(sock, GRUP, null, terdakwa, 3);
harus('fase sidang aktif', sesi.status === 'TRIAL_PHASE');
harusMemuat('pengumuman sidang', semuaTeks(i), 'SIDANG TERAKHIR DIBUKA');

i = terkirim.length;
await uc.handleTrialVote(sock, GRUP, terdakwa, pesan(), 'GUILTY');
harusMemuat('terdakwa tidak boleh ikut vonis', teksTerakhir(), 'Terdakwa tidak boleh');

// Mayoritas BEBAS -> eksekusi batal, semua tetap hidup.
const jumlahHidup = sesi.alivePlayers.length;
i = terkirim.length;
for (const p of sesi.alivePlayers.filter(p => p !== terdakwa)) {
  await uc.handleTrialVote(sock, GRUP, p, pesan(), 'INNOCENT');
}
harusMemuat('vonis bebas diumumkan', semuaTeks(i), 'TERDAKWA DIBEBASKAN');
harus('tidak ada yang mati saat bebas',
  activeUndercoverGames.get(GRUP)?.alivePlayers.length === jumlahHidup,
  `hidup=${activeUndercoverGames.get(GRUP)?.alivePlayers.length} vs ${jumlahHidup}`);

// Sekarang vonis BERSALAH -> terdakwa benar-benar gugur.
const sesi2 = activeUndercoverGames.get(GRUP);
clearSessionTimer(sesi2);
const terdakwa2 = sesi2.alivePlayers[0];
const hidupSebelum = sesi2.alivePlayers.length;
await startTrialPhase(sock, GRUP, null, terdakwa2, 3);
for (const p of sesi2.alivePlayers.filter(p => p !== terdakwa2)) {
  await uc.handleTrialVote(sock, GRUP, p, pesan(), 'GUILTY');
}
const sesiAkhir = activeUndercoverGames.get(GRUP);
harus('vonis bersalah mengeksekusi',
  !sesiAkhir || sesiAkhir.alivePlayers.length === hidupSebelum - 1,
  `hidup=${sesiAkhir?.alivePlayers?.length} vs ${hidupSebelum}`);
bersihkanSesi();

// ============================================================
// 7. BISIKAN ARWAH
// ============================================================
console.log('\n════ 7. BISIKAN ARWAH ════');
sesi = await bukaGamePenuh({ pemain: PEMAIN.slice(0, 5) });
clearSessionTimer(sesi);
const hidup = sesi.alivePlayers[0];
i = terkirim.length;
await uc.handleGhostWhisper(sock, hidup, hidup, pesan(), 'coba bisik');
harusMemuat('pemain hidup tidak boleh membisik', teksTerakhir(), 'hanya untuk pemain yang sudah GUGUR');

// Bunuh satu pemain secara manual lewat jalur resmi (killPlayer via vote engine
// terlalu berbelit di sini; cukup keluarkan dari alivePlayers seperti killPlayer).
const { killPlayer } = await import(REPO + 'src/games/undercover/flow.js');
const arwah = sesi.alivePlayers.at(-1);
killPlayer(sesi, arwah);
sesi.ghostWhisperRound = sesi.round;
sesi.ghostWhisperers = new Set();

i = terkirim.length;
await uc.handleGhostWhisper(sock, arwah, arwah, pesan(), 'satu dua tiga empat lima enam tujuh delapan');
harusMemuat('bisikan kepanjangan ditolak', teksTerakhir(), 'terlalu panjang');

await uc.handleGhostWhisper(sock, arwah, arwah, pesan(), 'curigai nomor 3');
harusMemuat('bisikan berangka ditolak', teksTerakhir(), 'tidak boleh memuat angka');

await uc.handleGhostWhisper(sock, arwah, arwah, pesan(), sesi.pair.civilian);
harusMemuat('bisikan bocor kata ditolak', teksTerakhir(), 'tidak boleh memuat kata rahasia');

i = terkirim.length;
await uc.handleGhostWhisper(sock, arwah, arwah, pesan(), 'jangan percaya yang pertama');
harusMemuat('bisikan sah tayang di grup', semuaTeks(i), 'BISIKAN DARI ALAM BAKA');
harus('bisikan tercatat', sesi.ghostWhisperers.size === 1);

i = terkirim.length;
await uc.handleGhostWhisper(sock, arwah, arwah, pesan(), 'sekali lagi coba');
harusMemuat('bisikan kedua di ronde sama ditolak', teksTerakhir(), 'sudah membisikkan sesuatu');
bersihkanSesi();

// ============================================================
// 8. MISI RAHASIA & PASAR GELAP
// ============================================================
console.log('\n════ 8. MISI & PASAR GELAP ════');
sesi = await bukaGamePenuh({ pemain: PEMAIN.slice(0, 6) });
clearSessionTimer(sesi);
// Peran netral diundi, jadi ulangi lobi sampai Mr. White benar-benar muncul —
// tanpa itu jalur Pasar Gelap tidak pernah tersentuh uji.
for (let coba = 0; coba < 30; coba++) {
  if (sesi.players.some(p => getPlayerRoleData(sesi, p).role === 'MRWHITE')) break;
  bersihkanSesi();
  sesi = await bukaGamePenuh({ pemain: PEMAIN.slice(0, 6) });
  clearSessionTimer(sesi);
}

const orang = sesi.players[0];
await uc.handleShowMission(sock, orang, orang, pesan());
harusMemuat('misi bisa dibaca ulang', teksTerakhir(), 'MISI RAHASIA PERSONALMU');
harus('misi yang dibagi valid',
  sesi.players.every(p => MISSION_DEFS.some(m => m.key === getPlayerRoleData(sesi, p).mission.key)));
harus('misi bertarget tidak menunjuk diri sendiri',
  sesi.players.every(p => {
    const m = getPlayerRoleData(sesi, p).mission;
    return !m.targetJid || m.targetJid !== p;
  }));

const mrWhite = sesi.players.find(p => getPlayerRoleData(sesi, p).role === 'MRWHITE');
const bukanMrWhite = sesi.players.find(p => getPlayerRoleData(sesi, p).role !== 'MRWHITE');
await uc.handleBlackMarket(sock, bukanMrWhite, bukanMrWhite, pesan());
harusMemuat('pasar gelap tolak non-Mr.White', teksTerakhir(), 'hanya melayani Mr. White');

if (mrWhite) {
  const poinSebelum = (await db.getGameProfile(mrWhite)).points;
  await uc.handleBlackMarket(sock, mrWhite, mrWhite, pesan());
  harusMemuat('pasar gelap membuka huruf', teksTerakhir(), 'TRANSAKSI PASAR GELAP');
  const poinSesudah = (await db.getGameProfile(mrWhite)).points;
  harus('poin Mr. White terpotong', poinSesudah < poinSebelum, `${poinSebelum} -> ${poinSesudah}`);
  harus('huruf pribadi tidak bocor ke papan publik',
    (sesi.revealedLetters || []).length === 0,
    `revealedLetters=${JSON.stringify(sesi.revealedLetters)}`);
  await uc.handleBlackMarket(sock, mrWhite, mrWhite, pesan());
  await uc.handleBlackMarket(sock, mrWhite, mrWhite, pesan());
  harusMemuat('jatah pasar gelap dibatasi', teksTerakhir(), 'Jatah Pasar Gelap habis');
} else {
  harus('Mr. White muncul dalam 30 percobaan lobi', false, 'jalur Pasar Gelap tidak teruji');
}
bersihkanSesi();

// ============================================================
// 9. UNIT: MODIFIER, MASK HURUF, TRUST SCORE
// ============================================================
console.log('\n════ 9. UNIT LOGIKA ════');
harus('semua modifier punya key unik',
  new Set(ROUND_MODIFIERS.map(m => m.key)).size === ROUND_MODIFIERS.length);

const sesiPalsu = { round: 1, alivePlayers: [1, 2, 3], modifier: null };
for (let n = 0; n < 300; n++) {
  const m = pickRoundModifier(sesiPalsu);
  if ((MODIFIER_MIN_ROUND[m.key] || 0) > 1 || (MODIFIER_MIN_ALIVE[m.key] || 0) > 3) {
    harus('modifier ronde 1 tidak melanggar pagar', false, `bocor: ${m.key}`);
    break;
  }
}
harus('pagar modifier ronde 1 aman', true);

const sesiRonde4 = { round: 4, alivePlayers: [1, 2, 3, 4, 5], modifier: null };
const terlihat = new Set();
for (let n = 0; n < 500; n++) terlihat.add(pickRoundModifier(sesiRonde4).key);
harus('Ronde Anonim bisa keluar di ronde 4', terlihat.has('ANON'));

const sesiKata = { pair: { civilian: 'KOPI SUSU' }, revealedLetters: [] };
harus('mask awal tertutup semua', buildWordMask(sesiKata) === '_ _ _ _   _ _ _ _', `hasil="${buildWordMask(sesiKata)}"`);
for (let n = 0; n < 20; n++) revealRandomLetter(sesiKata);
harus('semua huruf akhirnya terbuka', !buildWordMask(sesiKata).includes('_'), buildWordMask(sesiKata));
harus('revealRandomLetter berhenti saat habis', revealRandomLetter(sesiKata) === -1);
harus('spasi tidak pernah ikut dibuka', sesiKata.revealedLetters.every(idx => 'KOPI SUSU'[idx] !== ' '));

harus('clueLeaksSecret menangkap kata utuh', clueLeaksSecret('ini kopi enak', 'KOPI'));
harus('clueLeaksSecret menangkap potongan', clueLeaksSecret('rasanya seperti indomie goreng', 'INDOMIE'));
harus('clueLeaksSecret tidak asal tuduh', !clueLeaksSecret('minuman panas pagi hari', 'INDOMIE'));

const sesiTrust = {
  players: ['a', 'b', 'c'],
  alivePlayers: ['a'],
  playerRoles: new Map([
    ['a', { role: 'CIVILIAN', clueLog: [{ round: 1, text: 'aman' }] }],
    ['b', { role: 'UNDERCOVER', clueLog: [{ round: 1, text: '(Melewatkan giliran / Skip)' }] }],
    ['c', { role: 'CIVILIAN', clueLog: [{ round: 1, text: 'aman' }] }]
  ]),
  voteHistory: [
    { round: 1, voter: 'a', target: 'b' },
    { round: 1, voter: 'c', target: 'a' }
  ],
  eliminations: [{ round: 1, jid: 'b', votes: 3 }],
  pair: { civilian: 'X', undercover: 'Y' },
  playerLabels: ['A', 'B', 'C']
};
const skor = computeTrustScores(sesiTrust);
harus('trust score urut menurun', skor[0].score >= skor.at(-1).score);
harus('penuduh penyamar unggul dari yang salah tuduh',
  skor.find(s => s.jid === 'a').score > skor.find(s => s.jid === 'c').score,
  JSON.stringify(skor));
harus('trust score dibatasi 0-100', skor.every(s => s.score >= 0 && s.score <= 100));
harusMemuat('papan trust terbentuk', buildTrustBoard(sesiTrust), 'TRUST SCORE AKHIR GAME');
harusMemuat('petunjuk mematikan terbentuk', buildDeadliestClue(sesiTrust), 'PETUNJUK PALING MEMATIKAN');

// ============================================================
// 10. SI MABUK & SPLIT WORD (undian, jadi dipaksa berulang)
// ============================================================
console.log('\n════ 10. SI MABUK & SPLIT WORD ════');
let ketemuMabuk = false;
let ketemuSplit = false;
for (let percobaan = 0; percobaan < 25 && (!ketemuMabuk || !ketemuSplit); percobaan++) {
  const s = await bukaGamePenuh({ pemain: PEMAIN });
  if (!s) break;
  clearSessionTimer(s);

  const mabuk = s.players.find(p => getPlayerRoleData(s, p).role === 'DRUNK');
  if (mabuk && !ketemuMabuk) {
    ketemuMabuk = true;
    const rd = getPlayerRoleData(s, mabuk);
    harus('Si Mabuk memegang kata berbeda dari warga', rd.word !== s.pair.civilian);
    harus('Si Mabuk bukan memegang kata penyamar', rd.word !== s.pair.undercover);
    harus('Si Mabuk tetap dihitung kubu warga', isCivilianRole('DRUNK'));
    harus('Si Mabuk hanya muncul di 7+ pemain', s.players.length >= 7);
  }
  if (s.pair.undercover2 && !ketemuSplit) {
    ketemuSplit = true;
    const penyamar = s.players.filter(p => {
      const r = getPlayerRoleData(s, p).role;
      return ['UNDERCOVER', 'ASSASSIN', 'FRAMER', 'SABOTEUR'].includes(r);
    });
    const kata = new Set(penyamar.map(p => getPlayerRoleData(s, p).word));
    harus('split word memberi 2 kata berbeda', kata.size === 2, JSON.stringify([...kata]));
  }
  bersihkanSesi();
}
harus('Si Mabuk pernah terundi dalam 25 percobaan', ketemuMabuk);
harus('Split Word pernah terundi dalam 25 percobaan', ketemuSplit);

// ============================================================
// 11. PERSISTENSI STATE (save -> JSON -> restore)
// ============================================================
console.log(String.fromCharCode(10) + '════ 11. PERSISTENSI ════');
const { saveUndercoverSessions } = await import(REPO + 'src/games/undercover/state.js');
sesi = await bukaGamePenuh({ pemain: PEMAIN.slice(0, 5) });
clearSessionTimer(sesi);
sesi.voteHistory.push({ round: 1, voter: sesi.players[0], target: sesi.players[1], weight: 1 });
sesi.eliminations.push({ round: 1, jid: sesi.players[1], votes: 3 });
sesi.ghostWhisperers.add(sesi.players[2]);
sesi.trialAccused = sesi.players[3];
sesi.trialVotes.set(sesi.players[0], 'GUILTY');
sesi.revealedLetters.push(0);
sesi.blackMarketBuys = 1;
sesi.anonBoard = ['satu', 'dua'];
sesi.anonSubmitted.add(sesi.players[0]);
saveUndercoverSessions();

const berkas = path.join(process.cwd(), 'data', 'undercover_state.json');
harus('berkas state tertulis', fs.existsSync(berkas));
const tersimpan = JSON.parse(fs.readFileSync(berkas, 'utf-8'))[0];
harus('voteHistory tersimpan', tersimpan.voteHistory.length === 1);
harus('eliminations tersimpan', tersimpan.eliminations.length === 1);
harus('ghostWhisperers jadi array', Array.isArray(tersimpan.ghostWhisperers) && tersimpan.ghostWhisperers.length === 1);
harus('trialVotes jadi array pasangan', Array.isArray(tersimpan.trialVotes) && tersimpan.trialVotes[0][1] === 'GUILTY');
harus('anonSubmitted jadi array', Array.isArray(tersimpan.anonSubmitted) && tersimpan.anonSubmitted.length === 1);
harus('revealedLetters tersimpan', tersimpan.revealedLetters[0] === 0);
harus('blackMarketBuys tersimpan', tersimpan.blackMarketBuys === 1);
harus('chargedPlayers tersimpan', Array.isArray(tersimpan.chargedPlayers) && tersimpan.chargedPlayers.length === 5);
harus('misi ikut tersimpan di playerRoles',
  Object.values(tersimpan.playerRoles).every(r => !!r.mission));
harus('kata kedua penyamar ikut tersimpan', 'undercover2' in tersimpan.pair);
bersihkanSesi();

// ============================================================
// HASIL
// ============================================================
console.log('\n════════════════════════════════');
console.log(`Pemeriksaan: ${periksa} | Gagal: ${gagal.length}`);
if (gagal.length > 0) {
  console.log('\n❌ KEGAGALAN:');
  for (const g of gagal) console.log(`  • ${g.label}\n    ${g.err}`);
  process.exit(1);
}
console.log('✅ Semua pemeriksaan lolos.');
process.exit(0);
