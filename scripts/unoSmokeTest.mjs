/**
 * Smoke Test for UNO WhatsApp
 *
 * Seluruh aturan UNO ditulis sebagai fungsi murni di kartu.js dan index.js
 * justru supaya berkas ini bisa menjalankannya sungguhan — tanpa socket
 * WhatsApp dan tanpa satu pun tulisan ke database. Tidak ada logika permainan
 * yang ditulis ulang di dalam test ini; kalau aturannya berubah, test ini yang
 * jatuh, bukan diam-diam tetap hijau.
 */
import assert from 'assert';
import {
  buatDeck, kocok, bolehDimainkan, kartuLegalDi, adaKartuLegal,
  efekKartu, labelKartu, labelAtas, bacaWarna, warnaTerbanyak,
  nilaiKartu, nilaiTangan, isLiar
} from '../src/games/uno/kartu.js';
import {
  indeksBerikut, terapkanKartu, lewatiGiliran, isiUlangDeck,
  ambilDariDeck, batasKreditNyata, samaJid,
  bacaAturan, bolehSekarang, legalSekarang, adaLegalSekarang,
  serapTumpukan, hitungSkorRonde
} from '../src/games/uno/index.js';
import { putuskanLangkahBot, pilihWarnaBot, isBotUno, BOT_UNO } from '../src/games/uno/ai.js';

console.log('🎴 MEMULAI SMOKE TEST UNO WHATSAPP...');

const A = 'a@s.whatsapp.net';
const B = 'b@s.whatsapp.net';
const C = 'c@s.whatsapp.net';

const K = (warna, simbol) => ({ warna, simbol });

function sesiUji(over = {}) {
  const players = over.players || [A, B, C];
  const tangan = new Map();
  for (const p of players) tangan.set(p, []);
  return {
    players,
    tangan,
    deck: [],
    buang: [K('M', '0')],
    atas: K('M', '0'),
    warnaAktif: 'M',
    arah: 1,
    idxAktif: 0,
    turnSeq: 1,
    buyIn: 50,
    ...over,
    ...(over.tangan ? { tangan: over.tangan } : {})
  };
}

// ─── 1. Komposisi deck ───────────────────────────────────────────
console.log('1. Memeriksa komposisi deck standar 108 kartu...');
{
  const deck = buatDeck();
  assert.strictEqual(deck.length, 108, 'Deck UNO harus 108 kartu');

  for (const w of ['M', 'K', 'H', 'B']) {
    const perWarna = deck.filter(k => k.warna === w);
    assert.strictEqual(perWarna.length, 25, `Tiap warna harus 25 kartu (${w})`);
    assert.strictEqual(perWarna.filter(k => k.simbol === '0').length, 1, 'Hanya ada satu kartu 0 per warna');
    for (const n of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      assert.strictEqual(perWarna.filter(k => k.simbol === n).length, 2, `Angka ${n} harus dua per warna`);
    }
    for (const a of ['S', 'R', 'D2']) {
      assert.strictEqual(perWarna.filter(k => k.simbol === a).length, 2, `Aksi ${a} harus dua per warna`);
    }
  }
  assert.strictEqual(deck.filter(k => k.simbol === 'W').length, 4, 'Harus ada 4 Wild');
  assert.strictEqual(deck.filter(k => k.simbol === 'W4').length, 4, 'Harus ada 4 Wild +4');
  assert.strictEqual(deck.filter(k => k.warna === null).length, 8, 'Kartu liar tidak boleh punya warna awal');

  const dikocok = kocok(deck);
  assert.strictEqual(dikocok.length, 108, 'Mengocok tidak boleh mengubah jumlah kartu');
}
console.log('✅ 1. Komposisi deck 100% valid');

// ─── 2. Aturan legalitas ─────────────────────────────────────────
console.log('2. Menguji aturan kartu mana yang boleh dimainkan...');
{
  const atas = K('M', '7');
  assert.ok(bolehDimainkan(K('M', '3'), atas, 'M'), 'Warna sama harus boleh');
  assert.ok(bolehDimainkan(K('B', '7'), atas, 'M'), 'Simbol sama harus boleh');
  assert.ok(!bolehDimainkan(K('B', '3'), atas, 'M'), 'Beda warna & beda simbol harus ditolak');
  assert.ok(bolehDimainkan(K(null, 'W'), atas, 'M'), 'Wild selalu boleh');
  assert.ok(bolehDimainkan(K(null, 'W4'), atas, 'M'), 'Wild +4 selalu boleh');

  // Setelah Wild, yang mengikat adalah WARNA PILIHAN, bukan kartu liarnya.
  const atasLiar = K(null, 'W');
  assert.ok(bolehDimainkan(K('H', '5'), atasLiar, 'H'), 'Warna pilihan harus mengikat');
  assert.ok(!bolehDimainkan(K('B', '5'), atasLiar, 'H'), 'Warna lain harus ditolak setelah Wild');
  assert.ok(!bolehDimainkan(K('B', 'W'), atasLiar, 'H') === false, 'Wild tetap boleh di atas Wild');

  const tangan = [K('M', '3'), K('B', '9'), K(null, 'W')];
  assert.strictEqual(kartuLegalDi(tangan, atas, 'M').length, 2, 'Harus ada tepat 2 kartu legal');
  assert.ok(adaKartuLegal(tangan, atas, 'M'), 'adaKartuLegal harus true');
  assert.ok(!adaKartuLegal([K('B', '9')], atas, 'M'), 'adaKartuLegal harus false kalau tidak ada yang cocok');
}
console.log('✅ 2. Aturan legalitas 100% valid');

// ─── 3. Efek kartu & arah putaran ────────────────────────────────
console.log('3. Menguji efek kartu aksi...');
{
  assert.deepStrictEqual(efekKartu(K('M', '5'), 3), { lewati: false, tarik: 0, balik: false }, 'Kartu angka tidak berefek');
  assert.strictEqual(efekKartu(K('M', 'S'), 3).lewati, true, 'Skip melewati satu pemain');
  assert.strictEqual(efekKartu(K('M', 'D2'), 3).tarik, 2, '+2 menarik dua kartu');
  assert.strictEqual(efekKartu(K(null, 'W4'), 3).tarik, 4, '+4 menarik empat kartu');
  assert.strictEqual(efekKartu(K('M', 'R'), 3).balik, true, 'Balik membalik arah di meja 3 pemain');

  // Aturan resmi: di meja 2 pemain, Balik berlaku seperti Skip.
  const dua = efekKartu(K('M', 'R'), 2);
  assert.strictEqual(dua.balik, false, 'Balik tidak membalik arah di meja 2 pemain');
  assert.strictEqual(dua.lewati, true, 'Balik di meja 2 pemain harus melewati lawan');

  // Putaran maju & mundur harus membungkus dengan benar.
  assert.strictEqual(indeksBerikut(2, 1, 3), 0, 'Maju dari indeks terakhir kembali ke 0');
  assert.strictEqual(indeksBerikut(0, -1, 3), 2, 'Mundur dari indeks 0 ke indeks terakhir');
  assert.strictEqual(indeksBerikut(0, 1, 3, 2), 2, 'Melangkah dua kali');
  assert.strictEqual(indeksBerikut(0, -1, 2, 2), 0, 'Skip di meja 2 pemain mengembalikan giliran ke pemain sama');
}
console.log('✅ 3. Efek kartu & arah putaran 100% valid');

// ─── 4. Penerapan kartu ke meja (jalur sungguhan) ────────────────
console.log('4. Menguji terapkanKartu pada meja sungguhan...');
{
  // Kartu angka: giliran maju satu, tidak ada korban.
  const s = sesiUji();
  const h = terapkanKartu(s, K('M', '5'));
  assert.strictEqual(s.idxAktif, 1, 'Kartu angka memajukan giliran satu langkah');
  assert.strictEqual(s.warnaAktif, 'M', 'Warna aktif mengikuti kartu');
  assert.strictEqual(h.korban, null, 'Kartu angka tidak punya korban');
  assert.strictEqual(s.buang.length, 2, 'Kartu yang dimainkan masuk tumpukan buangan');
  assert.strictEqual(s.atas.simbol, '5', 'Kartu atas ikut berubah');
}
{
  // Skip: pemain berikutnya dilewati.
  const s = sesiUji();
  const h = terapkanKartu(s, K('M', 'S'));
  assert.strictEqual(h.korban, B, 'Korban Skip adalah pemain berikutnya');
  assert.strictEqual(s.idxAktif, 2, 'Skip melompati satu pemain');
}
{
  // Balik di meja 3 pemain: arah berubah, giliran mundur.
  const s = sesiUji();
  terapkanKartu(s, K('M', 'R'));
  assert.strictEqual(s.arah, -1, 'Arah harus terbalik');
  assert.strictEqual(s.idxAktif, 2, 'Giliran mundur ke pemain terakhir');
}
{
  // +2: korban benar-benar menerima dua kartu dari deck.
  const s = sesiUji({ deck: [K('B', '1'), K('B', '2'), K('B', '3')] });
  const h = terapkanKartu(s, K('M', 'D2'));
  assert.strictEqual(h.korban, B, 'Korban +2 adalah pemain berikutnya');
  assert.strictEqual(s.tangan.get(B).length, 2, 'Korban harus menerima 2 kartu');
  assert.strictEqual(h.ditarik.length, 2, 'Laporan jumlah kartu tertarik harus tepat');
  assert.strictEqual(s.idxAktif, 2, 'Korban +2 kehilangan gilirannya');
  assert.strictEqual(s.deck.length, 1, 'Kartu diambil dari deck');
}
{
  // Wild: warna aktif mengikuti pilihan pemain, bukan kartu.
  const s = sesiUji();
  terapkanKartu(s, K(null, 'W'), 'B');
  assert.strictEqual(s.warnaAktif, 'B', 'Warna aktif harus mengikuti pilihan');
  assert.strictEqual(s.idxAktif, 1, 'Wild biasa tidak melewati siapa pun');
}
{
  // Wild +4: korban menarik empat dan dilewati.
  const s = sesiUji({ deck: [K('B', '1'), K('B', '2'), K('B', '3'), K('B', '4'), K('B', '5')] });
  const h = terapkanKartu(s, K(null, 'W4'), 'H');
  assert.strictEqual(s.warnaAktif, 'H', 'Warna +4 harus mengikuti pilihan');
  assert.strictEqual(s.tangan.get(B).length, 4, 'Korban +4 menarik 4 kartu');
  assert.strictEqual(s.idxAktif, 2, 'Korban +4 kehilangan giliran');
  assert.strictEqual(h.tarik, 4, 'Efek tarik harus 4');
}
{
  // Meja 2 pemain: Skip mengembalikan giliran ke pemain yang sama.
  const s = sesiUji({ players: [A, B] });
  terapkanKartu(s, K('M', 'S'));
  assert.strictEqual(s.idxAktif, 0, 'Di meja 2 pemain, Skip berarti main lagi');
}
{
  // lewatiGiliran memajukan satu langkah tanpa menyentuh kartu atas.
  const s = sesiUji();
  const atasSebelum = s.atas;
  lewatiGiliran(s);
  assert.strictEqual(s.idxAktif, 1, 'lewatiGiliran memajukan giliran');
  assert.strictEqual(s.atas, atasSebelum, 'lewatiGiliran tidak boleh mengubah kartu atas');
}
console.log('✅ 4. Penerapan kartu ke meja 100% valid');

// ─── 5. Deck habis & daur ulang ──────────────────────────────────
console.log('5. Menguji daur ulang tumpukan buangan...');
{
  const wildTerpakai = K('M', 'W'); // Wild yang tadinya dipilih jadi merah
  wildTerpakai.simbol = 'W';
  const s = sesiUji({
    deck: [],
    buang: [K('B', '4'), K('H', '2'), wildTerpakai, K('K', '9')]
  });
  const ditarik = ambilDariDeck(s, 2);
  assert.strictEqual(ditarik.length, 2, 'Harus tetap bisa menarik 2 kartu setelah daur ulang');
  assert.strictEqual(s.buang.length, 1, 'Hanya kartu teratas yang tertinggal di tumpukan buangan');
  assert.strictEqual(s.buang[0].simbol, '9', 'Kartu teratas harus dipertahankan');

  // Wild yang didaur ulang WAJIB kehilangan warna pilihannya.
  const semua = [...s.deck, ...ditarik];
  const wildDidaur = semua.find(k => isLiar(k));
  assert.ok(wildDidaur, 'Wild harus ikut kembali ke deck');
  assert.strictEqual(wildDidaur.warna, null, 'Wild yang didaur ulang harus kehilangan warnanya');
}
{
  // Deck & buangan benar-benar habis → menarik mengembalikan array kosong,
  // bukan menggantung atau melempar.
  const s = sesiUji({ deck: [], buang: [K('M', '0')] });
  assert.strictEqual(isiUlangDeck(s), false, 'Tidak ada yang bisa didaur ulang');
  assert.strictEqual(ambilDariDeck(s, 3).length, 0, 'Menarik dari deck kosong menghasilkan 0 kartu');
}
console.log('✅ 5. Daur ulang tumpukan buangan 100% valid');

// ─── 6. Ekonomi poin (anti mesin cetak poin) ─────────────────────
console.log('6. Menguji batas hadiah terhadap taruhan bot...');
{
  // 4 manusia, tanpa bot: seluruh pot boleh dibayarkan.
  const s = sesiUji({ buyIn: 50, potManusia: 200, potBot: 0 });
  assert.strictEqual(batasKreditNyata(s), 200, 'Pot murni manusia boleh dibayar penuh');
}
{
  // 1 manusia + 5 bot: pot terlihat 300, tapi cuma 50 poin nyata yang masuk.
  // Hadiah dibatasi 50 (manusia) + 50 (maksimal 1:1 dari taruhan bot) = 100.
  const s = sesiUji({ buyIn: 50, potManusia: 50, potBot: 250 });
  assert.strictEqual(batasKreditNyata(s), 100, 'Taruhan bot hanya boleh dibayar 1:1 terhadap taruhan sendiri');
  assert.ok(batasKreditNyata(s) < 300, 'Meja lawan bot tidak boleh jadi mesin cetak poin');
}
console.log('✅ 6. Batas hadiah 100% valid');

// ─── 7. Otak bot ─────────────────────────────────────────────────
console.log('7. Menguji keputusan bot...');
{
  // Bot tidak boleh memilih kartu ilegal.
  for (let i = 0; i < 200; i++) {
    const deck = kocok(buatDeck());
    const tangan = deck.slice(0, 7);
    const atas = deck.find(k => !isLiar(k));
    const langkah = putuskanLangkahBot(tangan, atas, atas.warna, { kartuLawanBerikut: 5 });
    if (langkah.aksi === 'main') {
      assert.ok(bolehDimainkan(langkah.kartu, atas, atas.warna), 'Bot tidak boleh memainkan kartu ilegal');
      assert.strictEqual(tangan[langkah.indeks], langkah.kartu, 'Indeks yang dilaporkan bot harus menunjuk kartunya');
      if (isLiar(langkah.kartu)) {
        assert.ok(['M', 'K', 'H', 'B'].includes(langkah.warna), 'Bot wajib memilih warna untuk kartu liar');
      }
    } else {
      assert.ok(!adaKartuLegal(tangan, atas, atas.warna), 'Bot hanya boleh menarik kalau memang tidak ada kartu legal');
    }
  }
}
{
  // Lawan tinggal 1 kartu → bot harus menyerang, bukan membuang angka.
  const tangan = [K('M', '3'), K('M', 'D2'), K('M', '8')];
  const langkah = putuskanLangkahBot(tangan, K('M', '5'), 'M', { kartuLawanBerikut: 1 });
  assert.strictEqual(langkah.kartu.simbol, 'D2', 'Bot harus menimpuk +2 saat lawan hampir habis');
}
{
  // Lawan masih tebal → kartu liar disimpan, bukan dihambur.
  const tangan = [K(null, 'W4'), K('M', '3')];
  const langkah = putuskanLangkahBot(tangan, K('M', '5'), 'M', { kartuLawanBerikut: 6 });
  assert.strictEqual(langkah.kartu.simbol, '3', 'Bot harus menyimpan Wild +4 saat belum mendesak');
}
{
  // Terjepit: cuma punya kartu liar → tetap harus main, bukan menarik.
  const langkah = putuskanLangkahBot([K(null, 'W')], K('B', '5'), 'B', { kartuLawanBerikut: 3 });
  assert.strictEqual(langkah.aksi, 'main', 'Kartu liar selalu bisa dimainkan');
  assert.ok(langkah.warna, 'Warna harus tetap dipilih');
}
{
  assert.strictEqual(pilihWarnaBot([K('H', '1'), K('H', '2'), K('B', '3')]), 'H', 'Bot memilih warna yang paling banyak dipegang');
  assert.ok(['M', 'K', 'H', 'B'].includes(pilihWarnaBot([], 'K')), 'Tangan kosong tetap menghasilkan warna sah');
  assert.ok(BOT_UNO.every(b => isBotUno(b.id)), 'Semua bot harus dikenali sebagai @ai supaya tidak pernah dibayar poin');
}
console.log('✅ 7. Keputusan bot 100% valid');

// ─── 8. Identitas pemain & tampilan ──────────────────────────────
console.log('8. Menguji pencocokan JID dan label...');
{
  assert.ok(samaJid('628111@s.whatsapp.net', '628111@c.us'), 'Beda domain harus dianggap sama');
  assert.ok(samaJid('628111:12@s.whatsapp.net', '628111@s.whatsapp.net'), 'Sufiks perangkat harus diabaikan');
  assert.ok(samaJid('08111111111@s.whatsapp.net', '628111111111@s.whatsapp.net'), 'Awalan 0 disamakan dengan 62');
  assert.ok(!samaJid(A, B), 'Dua pemain berbeda tidak boleh cocok');

  assert.strictEqual(labelKartu(K('M', '7')), '🔴 7', 'Label kartu angka');
  assert.strictEqual(labelKartu(K('H', 'D2')), '🟢 +2', 'Label kartu +2');
  assert.strictEqual(labelKartu(K(null, 'W4')), '🃏 Wild +4', 'Label Wild +4');
  assert.ok(labelAtas(K(null, 'W'), 'B').includes('Biru'), 'Kartu liar harus menampilkan warna aktifnya');

  assert.strictEqual(bacaWarna('MERAH'), 'M', 'Warna boleh diketik huruf besar');
  assert.strictEqual(bacaWarna('ijo'), 'H', 'Alias sehari-hari harus dikenali');
  assert.strictEqual(bacaWarna('ungu'), null, 'Warna tidak sah harus ditolak');

  assert.strictEqual(warnaTerbanyak([K('B', '1'), K('B', '2'), K('M', '3')]), 'B', 'Warna terbanyak harus tepat');
  assert.strictEqual(nilaiKartu(K(null, 'W4')), 50, 'Kartu liar bernilai 50');
  assert.strictEqual(nilaiKartu(K('M', 'S')), 20, 'Kartu aksi bernilai 20');
  assert.strictEqual(nilaiKartu(K('M', '7')), 7, 'Kartu angka bernilai angkanya');
  assert.strictEqual(nilaiTangan([K(null, 'W'), K('M', 'S'), K('M', '7')]), 77, 'Total nilai tangan harus tepat');
}
console.log('✅ 8. Identitas pemain & tampilan 100% valid');

// ─── 9. Simulasi ronde penuh ─────────────────────────────────────
console.log('9. Menjalankan 300 ronde penuh untuk mencari kebuntuan...');
{
  let totalGiliran = 0;
  for (let ronde = 0; ronde < 300; ronde++) {
    const players = [A, B, C];
    const deck = kocok(buatDeck());
    const tangan = new Map();
    for (const p of players) tangan.set(p, deck.splice(-7, 7));

    let pembuka = null;
    for (let i = deck.length - 1; i >= 0; i--) {
      if (!isLiar(deck[i])) { pembuka = deck.splice(i, 1)[0]; break; }
    }

    const s = {
      players, tangan, deck,
      buang: [pembuka], atas: pembuka, warnaAktif: pembuka.warna,
      arah: 1, idxAktif: 0, turnSeq: 1, buyIn: 50
    };

    let giliran = 0;
    let pemenang = null;
    while (giliran < 800) {
      giliran++;
      const aktif = s.players[s.idxAktif];
      const h = s.tangan.get(aktif);
      const langkah = putuskanLangkahBot(h, s.atas, s.warnaAktif, { kartuLawanBerikut: 5 });

      if (langkah.aksi === 'tarik') {
        const [baru] = ambilDariDeck(s, 1);
        if (!baru) { lewatiGiliran(s); continue; }
        h.push(baru);
        if (!bolehDimainkan(baru, s.atas, s.warnaAktif)) { lewatiGiliran(s); continue; }
        const l2 = putuskanLangkahBot(h, s.atas, s.warnaAktif, { kartuLawanBerikut: 5 });
        if (l2.aksi !== 'main') { lewatiGiliran(s); continue; }
        h.splice(l2.indeks, 1);
        terapkanKartu(s, l2.kartu, l2.warna);
      } else {
        h.splice(langkah.indeks, 1);
        terapkanKartu(s, langkah.kartu, langkah.warna);
      }

      if (h.length === 0) { pemenang = aktif; break; }
    }

    totalGiliran += giliran;
    assert.ok(pemenang, `Ronde ${ronde} harus punya pemenang, bukan buntu (berhenti di giliran ${giliran})`);

    // Invarian: tidak ada kartu yang hilang atau tercipta sepanjang ronde.
    const beredar = s.deck.length + s.buang.length + s.players.reduce((t, p) => t + s.tangan.get(p).length, 0);
    assert.strictEqual(beredar, 108, `Jumlah kartu harus tetap 108 (ronde ${ronde}, dapat ${beredar})`);

    // Warna aktif harus selalu sah.
    assert.ok(['M', 'K', 'H', 'B'].includes(s.warnaAktif), 'Warna aktif harus selalu salah satu dari 4 warna');
  }
  console.log(`   rata-rata ${Math.round(totalGiliran / 300)} giliran per ronde`);
}
console.log('✅ 9. 300 ronde penuh selesai tanpa buntu & tanpa kartu hilang');

// ─── 10. Aturan rumah opsional: pembacaan perintah ───────────────
console.log('10. Menguji pembacaan aturan rumah dari perintah...');
{
  const bawaan = bacaAturan(['.uno']);
  assert.strictEqual(bawaan.buyIn, 50, 'Taruhan bawaan 50');
  assert.strictEqual(bawaan.tumpuk, false, 'Penumpukan mati secara bawaan');
  assert.strictEqual(bawaan.penalti, false, 'Penalti UNO mati secara bawaan');
  assert.strictEqual(bawaan.targetSkor, 0, 'Meja bawaan cuma satu ronde');

  assert.strictEqual(bacaAturan(['.uno', '200']).buyIn, 200, 'Angka pertama dibaca sebagai taruhan');
  assert.strictEqual(bacaAturan(['.uno', '5']).buyIn, 20, 'Taruhan di bawah minimum dinaikkan ke 20');
  assert.strictEqual(bacaAturan(['.uno', '999999999']).buyIn, 100000, 'Taruhan di atas maksimum dipotong');

  const keras = bacaAturan(['.uno', '75', 'tumpuk', 'penalti', 'skor', '300']);
  assert.strictEqual(keras.buyIn, 75, 'Taruhan tetap terbaca walau diikuti aturan lain');
  assert.strictEqual(keras.tumpuk, true, 'Kata `tumpuk` menyalakan penumpukan');
  assert.strictEqual(keras.penalti, true, 'Kata `penalti` menyalakan penalti UNO');
  assert.strictEqual(keras.targetSkor, 300, 'Angka setelah `skor` jadi target');

  // Angka sesudah "skor" adalah target, BUKAN taruhan — ini yang paling mudah salah.
  const tanpaTaruhan = bacaAturan(['.uno', 'skor', '500']);
  assert.strictEqual(tanpaTaruhan.buyIn, 50, 'Angka milik `skor` tidak boleh dibaca sebagai taruhan');
  assert.strictEqual(tanpaTaruhan.targetSkor, 500, 'Target skor terbaca');

  assert.strictEqual(bacaAturan(['.uno', 'skor']).targetSkor, 300, 'Kata `skor` tanpa angka memakai 300');
  assert.strictEqual(bacaAturan(['.uno', 'TUMPUK']).tumpuk, true, 'Aturan boleh diketik huruf besar');
  assert.strictEqual(bacaAturan(['.uno', 'stack']).tumpuk, true, 'Alias bahasa Inggris dikenali');
}
console.log('✅ 10. Pembacaan aturan rumah 100% valid');

// ─── 11. Penumpukan +2/+4 ────────────────────────────────────────
console.log('11. Menguji aturan penumpukan +2/+4...');
{
  // Tanpa aturan tumpuk, +2 langsung dieksekusi seperti biasa.
  const biasa = sesiUji({ deck: [K('B', '1'), K('B', '2')] });
  terapkanKartu(biasa, K('M', 'D2'));
  assert.strictEqual(biasa.tangan.get(B).length, 2, 'Tanpa aturan tumpuk, korban langsung menarik');
  assert.strictEqual(biasa.idxAktif, 2, 'Tanpa aturan tumpuk, korban langsung dilewati');
}
{
  // Dengan aturan tumpuk, korban TIDAK menarik dan diberi giliran menimpa.
  const s = sesiUji({ aturan: { tumpuk: true }, tumpukan: { jumlah: 0, jenis: null }, deck: [K('B', '1'), K('B', '2')] });
  const h = terapkanKartu(s, K('M', 'D2'));
  assert.strictEqual(s.tangan.get(B).length, 0, 'Korban belum menarik apa pun');
  assert.strictEqual(s.idxAktif, 1, 'Korban mendapat giliran untuk menimpa');
  assert.strictEqual(s.tumpukan.jumlah, 2, 'Tumpukan tercatat 2');
  assert.strictEqual(h.menumpuk, 2, 'Hasil melaporkan besarnya tumpukan');

  // Hanya kartu sejenis yang boleh menimpa.
  assert.ok(bolehSekarang(s, K('H', 'D2')), '+2 warna lain boleh menimpa +2');
  assert.ok(!bolehSekarang(s, K('M', '5')), 'Kartu biasa tidak boleh saat tumpukan berjalan');
  assert.ok(!bolehSekarang(s, K(null, 'W4')), '+4 tidak boleh menimpa +2 (aturan ketat)');
  assert.ok(!bolehSekarang(s, K(null, 'W')), 'Wild polos tidak boleh menimpa tumpukan');

  // Menimpa: tumpukan bertambah, korban berikutnya yang ditagih.
  terapkanKartu(s, K('H', 'D2'));
  assert.strictEqual(s.tumpukan.jumlah, 4, 'Menimpa +2 membuat tumpukan jadi 4');
  assert.strictEqual(s.idxAktif, 2, 'Giliran berpindah ke calon korban berikutnya');
}
{
  // Yang tidak bisa menimpa menelan seluruh tumpukan lalu kehilangan giliran.
  const s = sesiUji({
    aturan: { tumpuk: true },
    tumpukan: { jumlah: 6, jenis: 'D2' },
    idxAktif: 1,
    deck: [K('B', '1'), K('B', '2'), K('B', '3'), K('B', '4'), K('B', '5'), K('B', '6'), K('B', '7')]
  });
  const h = serapTumpukan(s);
  assert.strictEqual(h.korban, B, 'Yang menelan adalah pemain aktif');
  assert.strictEqual(s.tangan.get(B).length, 6, 'Seluruh tumpukan ditelan sekaligus');
  assert.strictEqual(s.tumpukan.jumlah, 0, 'Tumpukan direset setelah ditelan');
  assert.strictEqual(s.idxAktif, 2, 'Yang menelan kehilangan gilirannya');
}
{
  // Bot ikut patuh: saat tumpukan berjalan, dia hanya boleh menimpa sejenis.
  const tangan = [K('M', '5'), K('H', 'D2'), K(null, 'W4')];
  const langkah = putuskanLangkahBot(tangan, K('M', 'D2'), 'M', { tumpukJenis: 'D2' });
  assert.strictEqual(langkah.aksi, 'main', 'Bot harus menimpa kalau punya kartunya');
  assert.strictEqual(langkah.kartu.simbol, 'D2', 'Bot hanya boleh memilih +2');

  const buntu = putuskanLangkahBot([K('M', '5'), K(null, 'W')], K('M', 'D2'), 'M', { tumpukJenis: 'D2' });
  assert.strictEqual(buntu.aksi, 'tarik', 'Bot menyerah menarik kalau tidak punya kartu penimpa');
}
console.log('✅ 11. Aturan penumpukan 100% valid');

// ─── 12. Skor ronde ──────────────────────────────────────────────
console.log('12. Menguji penghitungan skor ronde...');
{
  const tangan = new Map();
  tangan.set(A, []);                                   // pemenang, tangan habis
  tangan.set(B, [K('M', '7'), K('H', 'S')]);           // 7 + 20 = 27
  tangan.set(C, [K(null, 'W4'), K('B', '3')]);         // 50 + 3 = 53
  const s = sesiUji({ tangan });

  const { rincian, total } = hitungSkorRonde(s, A);
  assert.strictEqual(total, 80, 'Pemenang memanen 27 + 53 = 80 poin');
  assert.strictEqual(rincian.length, 2, 'Rincian hanya berisi lawan');
  assert.strictEqual(rincian.find(r => r.pemain === B).nilai, 27, 'Nilai tangan B harus 27');
  assert.strictEqual(rincian.find(r => r.pemain === C).sisa, 2, 'Jumlah sisa kartu C harus 2');
}
console.log('✅ 12. Penghitungan skor ronde 100% valid');

// ─── 13. Simulasi ronde bertumpuk ────────────────────────────────
console.log('13. Menjalankan 200 ronde dengan aturan penumpukan menyala...');
{
  let tumpukanTerbesar = 0;
  for (let ronde = 0; ronde < 200; ronde++) {
    const players = [A, B, C];
    const deck = kocok(buatDeck());
    const tangan = new Map();
    for (const p of players) tangan.set(p, deck.splice(-7, 7));

    let pembuka = null;
    for (let i = deck.length - 1; i >= 0; i--) {
      if (!isLiar(deck[i])) { pembuka = deck.splice(i, 1)[0]; break; }
    }

    const s = {
      players, tangan, deck,
      buang: [pembuka], atas: pembuka, warnaAktif: pembuka.warna,
      arah: 1, idxAktif: 0, turnSeq: 1, buyIn: 50,
      aturan: { tumpuk: true }, tumpukan: { jumlah: 0, jenis: null }
    };

    let giliran = 0;
    let pemenang = null;
    while (giliran < 1200) {
      giliran++;
      const aktif = s.players[s.idxAktif];
      const h = s.tangan.get(aktif);
      const konteks = { kartuLawanBerikut: 5, ...(s.tumpukan.jumlah > 0 ? { tumpukJenis: s.tumpukan.jenis } : {}) };
      const langkah = putuskanLangkahBot(h, s.atas, s.warnaAktif, konteks);

      if (langkah.aksi === 'tarik') {
        if (s.tumpukan.jumlah > 0) {
          tumpukanTerbesar = Math.max(tumpukanTerbesar, s.tumpukan.jumlah);
          serapTumpukan(s);
          continue;
        }
        const [baru] = ambilDariDeck(s, 1);
        if (!baru) { lewatiGiliran(s); continue; }
        h.push(baru);
        if (!bolehSekarang(s, baru)) { lewatiGiliran(s); continue; }
        const l2 = putuskanLangkahBot(h, s.atas, s.warnaAktif, konteks);
        if (l2.aksi !== 'main') { lewatiGiliran(s); continue; }
        h.splice(l2.indeks, 1);
        terapkanKartu(s, l2.kartu, l2.warna);
      } else {
        h.splice(langkah.indeks, 1);
        terapkanKartu(s, langkah.kartu, langkah.warna);
      }

      // Meniru penutupan ronde di mesin permainan: kartu penutup yang berupa
      // +2/+4 tetap ditagihkan sebelum ronde ditutup.
      if (h.length === 0) { pemenang = aktif; serapTumpukan(s); break; }
    }

    assert.ok(pemenang, `Ronde bertumpuk ${ronde} harus punya pemenang (berhenti di giliran ${giliran})`);
    const beredar = s.deck.length + s.buang.length + s.players.reduce((t, p) => t + s.tangan.get(p).length, 0);
    assert.strictEqual(beredar, 108, `Jumlah kartu harus tetap 108 (ronde bertumpuk ${ronde}, dapat ${beredar})`);
    assert.strictEqual(s.tumpukan.jumlah, 0, 'Ronde tidak boleh berakhir dengan tumpukan menggantung');
  }
  console.log(`   tumpukan terbesar yang pernah terjadi: +${tumpukanTerbesar}`);
}
console.log('✅ 13. 200 ronde bertumpuk selesai tanpa buntu & tanpa kartu hilang');

console.log('\n🎉 SEMUA SMOKE TESTS UNO 100% SUKSES!');

// uno/index.js -> ../helpers.js -> bot.js -> mediaHandler.js, dan mediaHandler
// menembakkan `pip install -U yt-dlp` (timeout 120 detik) saat di-import.
// Tanpa exit eksplisit, test yang sudah lulus tetap menggantung menunggunya.
process.exit(0);
