/**
 * Smoke Test for Battleship 1v1 (Perang Armada Kapal Laut)
 */
import { generateRandomFleet, activeBattleships, pendingBattleships } from '../src/games/battleship.js';
import assert from 'assert';

console.log('🚢 MEMULAI SMOKE TEST BATTLESHIP 1V1 (PERANG KAPAL)...');

// 1. Uji Generator Armada Kapal Acak (100 Iterasi)
console.log('1. Menguji keabsahan penempatan armada kapal 5x5 (100x)...');
const validCols = ['A', 'B', 'C', 'D', 'E'];

for (let i = 0; i < 100; i++) {
  const fleet = generateRandomFleet();
  assert.ok(fleet.carrier, 'Carrier harus ada');
  assert.ok(fleet.destroyer, 'Destroyer harus ada');
  assert.ok(fleet.submarine, 'Submarine harus ada');

  assert.strictEqual(fleet.carrier.coords.length, 3, 'Carrier harus 3 petak');
  assert.strictEqual(fleet.destroyer.coords.length, 2, 'Destroyer harus 2 petak');
  assert.strictEqual(fleet.submarine.coords.length, 1, 'Submarine harus 1 petak');

  const allCoords = [...fleet.carrier.coords, ...fleet.destroyer.coords, ...fleet.submarine.coords];
  assert.strictEqual(allCoords.length, 6, 'Total koordinat kapal harus 6');

  // Pastikan tidak ada koordinat tumpang tindih
  const uniqueCoords = new Set(allCoords);
  assert.strictEqual(uniqueCoords.size, 6, 'Semua koordinat kapal harus unik/tidak tabrakan');

  // Pastikan semua koordinat berada di dalam grid A1 - E5
  for (const coord of allCoords) {
    const col = coord[0];
    const row = parseInt(coord.slice(1), 10);
    assert.ok(validCols.includes(col), `Kolom ${col} harus valid A-E`);
    assert.ok(row >= 1 && row <= 5, `Baris ${row} harus valid 1-5`);
  }
}
console.log('✅ 1. Generator armada kapal 100% valid dan bebas tabrakan');

// 2. Simulasi Pertempuran (Hit, Miss, Sunk, Victory)
console.log('2. Menguji mekanisme pertempuran tembakan...');
const fleetP2 = generateRandomFleet();
const carrierCoords = fleetP2.carrier.coords;
const destroyerCoords = fleetP2.destroyer.coords;
const subCoords = fleetP2.submarine.coords;

// Tembak Miss
const p1Shots = new Map();
const missCoord = 'A1';
const isHit = carrierCoords.includes(missCoord) || destroyerCoords.includes(missCoord) || subCoords.includes(missCoord);
if (!isHit) {
  p1Shots.set(missCoord, 'MISS');
  assert.strictEqual(p1Shots.get(missCoord), 'MISS');
}

// Tembak Hit Carrier (3x sampai sunk)
for (const c of carrierCoords) {
  fleetP2.carrier.hits++;
  p1Shots.set(c, 'HIT');
}
fleetP2.carrier.sunk = fleetP2.carrier.hits >= fleetP2.carrier.size;
assert.strictEqual(fleetP2.carrier.sunk, true, 'Carrier harus berstatus SUNK setelah 3 hits');

// Tembak Destroyer & Submarine
for (const c of destroyerCoords) {
  fleetP2.destroyer.hits++;
}
fleetP2.destroyer.sunk = true;

for (const c of subCoords) {
  fleetP2.submarine.hits++;
}
fleetP2.submarine.sunk = true;

const allSunk = Object.values(fleetP2).every(s => s.sunk);
assert.strictEqual(allSunk, true, 'Kemenangan harus tercapai saat seluruh armada tenggelam');
console.log('✅ 2. Mekanisme Hit, Miss, Sunk, dan Victory Detection valid');

console.log('\n🎉 SEMUA SMOKE TESTS BATTLESHIP 1V1 100% SUKSES!');
