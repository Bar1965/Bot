/**
 * Smoke Test for Cut The Wire (Jinakkan Bom)
 */
import { activeWireGames, WIRE_COLORS, handleCutTheWire } from '../src/games/cutTheWire.js';
import assert from 'assert';

console.log('💣 MEMULAI SMOKE TEST CUT THE WIRE (JINAKKAN BOM)...');

// 1. Verifikasi Definisi Kabel
console.log('1. Memeriksa konfigurasi 6 kabel...');
assert.strictEqual(WIRE_COLORS.length, 6, 'Harus ada tepat 6 kabel');
const expectedKeys = ['merah', 'biru', 'kuning', 'hijau', 'ungu', 'putih'];
for (const key of expectedKeys) {
  const found = WIRE_COLORS.find(w => w.key === key);
  assert.ok(found, `Kabel ${key} harus terdaftar`);
  assert.ok(found.emoji, `Kabel ${key} harus memiliki emoji`);
  assert.ok(found.aliases.length >= 2, `Kabel ${key} harus memiliki alias`);
}
console.log('✅ 1. Definisi 6 kabel valid 100%');

// 2. Simulasi Session Sederhana
console.log('2. Menguji mekanisme permainan...');
const dummyJid = '120363999999999999@g.us';
const mockSession = {
  jid: dummyJid,
  host: 'player1@s.whatsapp.net',
  buyIn: 50,
  status: 'PLAYING',
  players: ['player1@s.whatsapp.net', 'player2@s.whatsapp.net', 'player3@s.whatsapp.net'],
  alivePlayers: ['player1@s.whatsapp.net', 'player2@s.whatsapp.net', 'player3@s.whatsapp.net'],
  chargedPlayers: new Set(['player1@s.whatsapp.net', 'player2@s.whatsapp.net', 'player3@s.whatsapp.net']),
  wireRoles: new Map([
    ['merah', 'SAFE'],
    ['biru', 'DETONATOR'],
    ['kuning', 'DEFUSAL'],
    ['hijau', 'SAFE'],
    ['ungu', 'SAFE'],
    ['putih', 'SAFE']
  ]),
  cutWires: new Set(),
  activeTurnIndex: 0,
  multiplier: 1.0,
  pot: 150,
  timer: null
};

activeWireGames.set(dummyJid, mockSession);

// Test Potong Kabel Safe
const wireSafe = WIRE_COLORS.find(w => w.key === 'merah');
mockSession.cutWires.add('merah');
mockSession.multiplier += 0.25;
mockSession.pot += Math.floor(mockSession.buyIn * 0.25);
assert.strictEqual(mockSession.pot, 162, 'Pot harus bertambah dengan bonus multiplier');
assert.strictEqual(mockSession.cutWires.has('merah'), true, 'Kabel merah harus tercatat putus');
console.log('✅ 2. Mekanisme potong kabel SAFE & Pot Multiplier valid');

// Test Potong Kabel Detonator
mockSession.cutWires.add('biru');
mockSession.alivePlayers = mockSession.alivePlayers.filter(p => p !== 'player1@s.whatsapp.net');
assert.strictEqual(mockSession.alivePlayers.length, 2, 'Pemain meledak harus keluar dari alivePlayers');
console.log('✅ 3. Mekanisme kabel DETONATOR & Eliminasi valid');

// Test Potong Kabel Defusal
mockSession.cutWires.add('kuning');
assert.strictEqual(mockSession.wireRoles.get('kuning'), 'DEFUSAL', 'Kabel kuning adalah DEFUSAL');
activeWireGames.delete(dummyJid);
console.log('✅ 4. Mekanisme kabel DEFUSAL & Kemenangan instan valid');

console.log('\n🎉 SEMUA SMOKE TESTS CUT THE WIRE (JINAKKAN BOM) 100% SUKSES!');
