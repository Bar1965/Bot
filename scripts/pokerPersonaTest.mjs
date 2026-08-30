// ─── 🧪 UJI MESIN KEPUTUSAN & KEPRIBADIAN AI POKER ───────────────
//
//     node scripts/pokerPersonaTest.mjs
//
// Berkas ini hanya mengimpor pokerAi.js, evaluator.js, dan deck.js — TIDAK
// menyentuh database maupun bot.js, jadi aman dijalankan kapan saja tanpa
// mengganggu sesi WhatsApp yang sedang hidup.
//
// Uji ini lahir dari pengukuran nyata: AI lama melipat 74,7% tangan di preflop,
// dan PRO, PASSIVE, serta CALL_STATION menghasilkan angka yang praktis identik
// (selisih 0,5 poin) karena 4 dari 7 bot menjalankan jalur kode yang sama.
// Gerbang 4 di bawah akan langsung GAGAL pada kode lama — itu memang tujuannya.
import { createDeck, shuffleDeck } from '../src/games/poker/deck.js';
import { evaluate7Cards, compareScores } from '../src/games/poker/evaluator.js';
import {
  BOT_NAMES, PERSONA, CHART, fastEval, handPercentile,
  decideAction, detectDraws, classifyMade, waktuBerpikir
} from '../src/games/poker/pokerAi.js';

const AKSI_SAH = ['FOLD', 'CHECK', 'CALL', 'RAISE', 'ALLIN'];
const persona = Object.keys(PERSONA);
let gagal = 0;
const catat = (ok, judul, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${judul}${detail ? ' — ' + detail : ''}`);
  if (!ok) gagal++;
};

console.log('🤖 UJI MESIN KEPUTUSAN AI POKER\n');

// ── GERBANG 1: chart 169 tangan utuh ──────────────────────────────
// Kalau satu entri hilang atau dobel, SELURUH model persentil bohong dan
// tiap keputusan preflop ikut salah tanpa satu pun error muncul.
{
  const daftar = CHART.split(' ').filter(Boolean);
  const unik = new Set(daftar);
  const kombo = daftar.reduce((t, h) => t + (h.length === 2 ? 6 : h[2] === 's' ? 4 : 12), 0);
  catat(daftar.length === 169 && unik.size === 169 && kombo === 1326,
    'GERBANG 1  Chart 169 tangan utuh',
    `${daftar.length} entri, ${unik.size} unik, ${kombo} kombo (harus 169/169/1326)`);
  catat(handPercentile([{ rank: 14, suit: 's' }, { rank: 14, suit: 'h' }]) < 1,
    'GERBANG 1b AA masuk 1% teratas');
  catat(handPercentile([{ rank: 7, suit: 's' }, { rank: 2, suit: 'h' }]) > 95,
    'GERBANG 1c 72o ada di dasar chart');
}

// ── GERBANG 2: fastEval ekuivalen dengan evaluator resmi ──────────
// fastEval dipakai ribuan kali per keputusan. Kalau urutannya menyimpang
// sedikit saja dari evaluate7Cards, bot menilai tangannya sendiri dengan
// aturan yang berbeda dari aturan showdown.
{
  const N = 20000;
  let bedaUrutan = 0;
  for (let i = 0; i < N; i++) {
    const d = shuffleDeck(createDeck());
    const A = d.slice(0, 7), B = d.slice(7, 14);
    const lama = compareScores(evaluate7Cards(A).score, evaluate7Cards(B).score);
    const fa = fastEval(A), fb = fastEval(B);
    const baru = fa > fb ? 1 : fa < fb ? -1 : 0;
    if (lama !== baru) bedaUrutan++;
  }
  catat(bedaUrutan === 0, 'GERBANG 2  fastEval ekuivalen evaluate7Cards',
    `${bedaUrutan} beda urutan dari ${N.toLocaleString('id-ID')} pasang`);
}

// ── GERBANG 3: invarian aksi ──────────────────────────────────────
// Ini gerbang TERPENTING. Engine diam-diam mengubah aksi tak sah jadi CALL,
// jadi bug apa pun di sini muncul sebagai "bot mainnya aneh", bukan error.
{
  let n = 0, langgar = 0;
  const contoh = [];
  for (const fase of ['PREFLOP', 'FLOP', 'TURN', 'RIVER']) {
    for (const toCall of [0, 3, 10, 20, 50, 90]) {
      for (const myStack of [0, 7, 20, 50, 200]) {
        for (const p of persona) {
          for (let i = 0; i < 40; i++) {
            const d = shuffleDeck(createDeck());
            const hole = [d.pop(), d.pop()];
            const board = fase === 'PREFLOP' ? [] : d.splice(0, fase === 'FLOP' ? 3 : fase === 'TURN' ? 4 : 5);
            const ctx = {
              persona: p, fase, hole, board, pot: 60, toCall, minRaise: 10, bigBlind: 10,
              myStack, effStack: myStack, nOpp: 1 + (i % 4), playersBehind: i % 8,
              inPosition: i % 2 === 0, isSmallBlind: i % 5 === 0,
              adaRaise: toCall > 10, adaRaisePreflop: toCall > 10, akuAgresor: i % 3 === 0
            };
            const k = decideAction(ctx);
            n++;
            const maks = Math.max(0, myStack - toCall);
            let salah = null;
            if (!k || !AKSI_SAH.includes(k.action)) salah = 'aksi tidak sah';
            else if (k.action === 'FOLD' && toCall === 0) salah = 'FOLD padahal gratis';
            else if (k.action === 'ALLIN' && myStack <= 0) salah = 'ALLIN tanpa chip';
            else if (k.action === 'RAISE') {
              if (!Number.isInteger(k.amount)) salah = 'amount bukan bilangan bulat';
              else if (k.amount < ctx.minRaise) salah = 'raise di bawah minimum';
              else if (k.amount > maks) salah = 'raise melebihi sisa chip';
            }
            if (salah) { langgar++; if (contoh.length < 3) contoh.push(`${fase} toCall=${toCall} stack=${myStack} ${p}: ${salah}`); }
          }
        }
      }
    }
  }
  catat(langgar === 0, 'GERBANG 3  Invarian aksi',
    `${langgar} pelanggaran dari ${n.toLocaleString('id-ID')} keputusan${contoh.length ? ' | ' + contoh.join(' ; ') : ''}`);
}

// ── GERBANG 4: kepribadian benar-benar terpisah ───────────────────
// Dua bot yang statistiknya sama artinya pemain tidak akan pernah bisa
// membedakan mereka, berapa lama pun dia bermain.
{
  const N = 3000;
  const profil = {};
  for (const p of persona) {
    const c = { FOLD: 0, CHECK: 0, CALL: 0, RAISE: 0, ALLIN: 0 };
    for (let i = 0; i < N; i++) {
      const d = shuffleDeck(createDeck());
      const fase = ['PREFLOP', 'FLOP', 'TURN', 'RIVER'][i % 4];
      const hole = [d.pop(), d.pop()];
      const board = fase === 'PREFLOP' ? [] : d.splice(0, fase === 'FLOP' ? 3 : fase === 'TURN' ? 4 : 5);
      const k = decideAction({
        persona: p, fase, hole, board, pot: 60, toCall: 20, minRaise: 10, bigBlind: 10,
        myStack: 200, effStack: 200, nOpp: 1, playersBehind: 2, inPosition: false,
        isSmallBlind: false, adaRaise: true, adaRaisePreflop: true, akuAgresor: false
      });
      c[k.action]++;
    }
    profil[p] = AKSI_SAH.map(a => (c[a] / N) * 100);
  }
  let terdekat = Infinity, pasangan = '';
  for (let i = 0; i < persona.length; i++) {
    for (let j = i + 1; j < persona.length; j++) {
      const d = profil[persona[i]].reduce((t, v, k) => t + Math.abs(v - profil[persona[j]][k]), 0);
      if (d < terdekat) { terdekat = d; pasangan = `${persona[i]} vs ${persona[j]}`; }
    }
  }
  catat(terdekat >= 15, 'GERBANG 4  Kepribadian terpisah',
    `pasangan termirip ${pasangan} berjarak ${terdekat.toFixed(1)} poin (minimal 15)`);
}

// ── GERBANG 5: fold-rate ikut HARGA ───────────────────────────────
// Inti keluhan "gampang banget fold": bot lama melipat dengan frekuensi yang
// sama entah diminta bayar 3 atau 90, karena tidak pernah melihat pot odds.
{
  const N = 2500;
  const rate = [];
  for (const toCall of [3, 20, 90]) {
    let f = 0;
    for (let i = 0; i < N; i++) {
      const d = shuffleDeck(createDeck());
      const k = decideAction({
        persona: 'PROFESOR', fase: 'FLOP', hole: [d.pop(), d.pop()], board: d.splice(0, 3),
        pot: 60, toCall, minRaise: 10, bigBlind: 10, myStack: 300, effStack: 300,
        nOpp: 1, playersBehind: 0, inPosition: true, isSmallBlind: false,
        adaRaise: true, adaRaisePreflop: true, akuAgresor: false
      });
      if (k.action === 'FOLD') f++;
    }
    rate.push((f / N) * 100);
  }
  catat(rate[0] < rate[1] && rate[1] < rate[2],
    'GERBANG 5  Fold-rate naik monoton terhadap harga',
    `bayar 3: ${rate[0].toFixed(1)}% · 20: ${rate[1].toFixed(1)}% · 90: ${rate[2].toFixed(1)}%`);
  catat(rate[0] < 25, 'GERBANG 5b Tidak melipat saat harganya murah',
    `fold ${rate[0].toFixed(1)}% saat pot odds cuma 5%`);
}

// ── GERBANG 6: draw dikenali (bot lama menganggapnya high card) ────
{
  const D = createDeck(); const c = id => D.find(x => x.id === id);
  const oesd = detectDraws([c('8s'), c('9h')], [c('6c'), c('7d'), c('Kh')]);
  const fd = detectDraws([c('As'), c('7s')], [c('Ks'), c('4s'), c('9h')]);
  const nihil = detectDraws([c('2s'), c('7h')], [c('Kc'), c('9d'), c('4h')]);
  const papanSaja = detectDraws([c('2c'), c('7d')], [c('Ks'), c('4s'), c('9s')]);
  catat(oesd.straightOuts === 8, 'GERBANG 6  Open-ended dikenali', `${oesd.outs} outs`);
  catat(fd.flushDraw && fd.outs === 9, 'GERBANG 6b Flush draw dikenali', `${fd.outs} outs`);
  catat(nihil.outs === 0, 'GERBANG 6c Tangan tanpa draw tidak dikarang');
  catat(!papanSaja.flushDraw, 'GERBANG 6d Draw milik papan bukan draw kita');
}

// ── GERBANG 7: pasangan milik papan dibedakan dari top pair ───────
{
  const D = createDeck(); const c = id => D.find(x => x.id === id);
  const top = classifyMade([c('Ks'), c('Ah')], [c('Kc'), c('9d'), c('4h'), c('2s'), c('5c')]);
  const punyaPapan = classifyMade([c('7h'), c('3d')], [c('Kc'), c('Ks'), c('9d'), c('2s'), c('5c')]);
  const mainPapan = classifyMade([c('2c'), c('3d')], [c('9c'), c('10d'), c('Jh'), c('Qs'), c('Kc')]);
  catat(top.tipe === 'toppair' && top.kicker === 14, 'GERBANG 7  Top pair + kicker benar', `kicker ${top.kicker}`);
  catat(punyaPapan.tipe === 'boardpair', 'GERBANG 7b Pasangan milik papan ditandai', punyaPapan.tipe);
  catat(mainPapan.mainPapan === true, 'GERBANG 7c "Main papan" terdeteksi');
}

// ── GERBANG 8: waktu berpikir masuk akal & bervariasi ─────────────
{
  const amb = a => { const v = []; for (let i = 0; i < 4000; i++) v.push(waktuBerpikir({ aksi: a, tipis: a === 'FOLD' ? 0.1 : 0.6, fase: 'FLOP', tempo: 1 })); v.sort((x, y) => x - y); return v; };
  const f = amb('FOLD'), c = amb('CALL');
  const med = v => v[v.length >> 1];
  const dalamBatas = [...f, ...c].every(v => v >= 600 && v <= 6000);
  catat(dalamBatas, 'GERBANG 8  Waktu berpikir dalam 0,6-6 detik');
  catat(med(f) < med(c), 'GERBANG 8b Fold lebih cepat daripada call',
    `median fold ${med(f)} ms vs call ${med(c)} ms`);
}

// ── Tabel kalibrasi (bukan gerbang, untuk mata owner) ─────────────
console.log('\n📊 PROFIL TIAP BOT (bayar 20 ke pot 60, 1 lawan)\n');
console.log('   bot            gaya                 FOLD   CALL  RAISE  ALLIN');
for (const b of BOT_NAMES) {
  const c = { FOLD: 0, CHECK: 0, CALL: 0, RAISE: 0, ALLIN: 0 };
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const d = shuffleDeck(createDeck());
    const fase = ['PREFLOP', 'FLOP', 'TURN', 'RIVER'][i % 4];
    const hole = [d.pop(), d.pop()];
    const board = fase === 'PREFLOP' ? [] : d.splice(0, fase === 'FLOP' ? 3 : fase === 'TURN' ? 4 : 5);
    c[decideAction({
      persona: b.persona, fase, hole, board, pot: 60, toCall: 20, minRaise: 10, bigBlind: 10,
      myStack: 200, effStack: 200, nOpp: 1, playersBehind: 2, inPosition: false,
      isSmallBlind: false, adaRaise: true, adaRaisePreflop: true, akuAgresor: false
    }).action]++;
  }
  const pct = a => ((c[a] / N) * 100).toFixed(1).padStart(5);
  console.log(`   ${b.julukan.padEnd(14)} ${b.persona.padEnd(20)} ${pct('FOLD')}% ${pct('CALL')}% ${pct('RAISE')}% ${pct('ALLIN')}%`);
}

console.log(`\n${gagal === 0 ? '🎉 SEMUA GERBANG LULUS!' : `💥 ${gagal} GERBANG GAGAL`}`);
if (gagal > 0) process.exit(1);
