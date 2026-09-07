/**
 * Smoke Test for Fishing & Relic Explorer (Overhauled with SQLite DB)
 */
import * as db from '../database.js';
import assert from 'assert';

console.log('🎣 MEMULAI SMOKE TEST OVERHAULED FISHING & RELIC EXPLORER...');

await db.initDb();

const testUser = '6289999999999@s.whatsapp.net';

// 1. Bersihkan Data Tes Sebelumnya
await db.clearFishFromBasket(testUser);
// Statistik ikut dibersihkan, kalau tidak rekor `heaviest_weight` dari run
// sebelumnya bikin uji rekor baru di langkah 5 gagal saat tes dijalankan ulang.
await db.resetFishingStats(testUser);
const initialBasket = await db.getFishingBasket(testUser);
assert.strictEqual(initialBasket.length, 0, 'Keranjang awal harus kosong');
console.log('✅ 1. Reset keranjang awal berhasil');

// 2. Uji Tambah Ikan ke Keranjang DB (addFishToBasket)
const testFish1 = {
  name: 'Ikan Gurame',
  icon: '🐠',
  rarity: 'Uncommon',
  weight: 4.5,
  price: 57,
  spotName: 'Danau Tenang',
  isChest: false
};

const testChest = {
  name: 'Peti Emas Karun Atlantis',
  icon: '👑',
  rarity: 'Treasure',
  weight: 25.0,
  price: 1000,
  spotName: 'Palung Atlantis',
  isChest: true
};

await db.addFishToBasket(testUser, testFish1);
await db.addFishToBasket(testUser, testChest);

const basketAfterAdd = await db.getFishingBasket(testUser);
assert.strictEqual(basketAfterAdd.length, 2, 'Keranjang harus berisi 2 item');
assert.strictEqual(basketAfterAdd[0].fish_name, 'Ikan Gurame', 'Nama ikan harus cocok');
assert.strictEqual(basketAfterAdd[1].fish_name, 'Peti Emas Karun Atlantis', 'Nama peti harus cocok');
console.log('✅ 2. Penyimpanan ikan & peti ke SQLite DB berhasil');

// 3. Uji Jual Ikan (clearFishFromBasket hanya menghapus ikan, mempertahankan peti)
await db.clearFishFromBasket(testUser);
const basketAfterSell = await db.getFishingBasket(testUser);
assert.strictEqual(basketAfterSell.length, 1, 'Hanya peti yang tersisa setelah jual ikan');
assert.strictEqual(basketAfterSell[0].is_chest, 1, 'Item yang tersisa harus berupa peti');
console.log('✅ 3. Logika jual ikan & pemisahan peti karun valid');

// 4. Uji Buka Peti Karun (removeChestFromBasket)
const poppedChest = await db.removeChestFromBasket(testUser);
assert.ok(poppedChest, 'Harus berhasil mengeluarkan peti');
assert.strictEqual(poppedChest.fish_name, 'Peti Emas Karun Atlantis', 'Peti yang dibuka harus sesuai');

const basketFinal = await db.getFishingBasket(testUser);
assert.strictEqual(basketFinal.length, 0, 'Keranjang harus kosong setelah peti dibuka');
console.log('✅ 4. Pengambilan & pembukaan peti karun valid');

// 5. Uji Statistik & Rekor Ikan Terberat (updateFishingStats & getFishingLeaderboard)
const stat1 = await db.updateFishingStats(testUser, {
  fishName: 'Ikan Tuna Sirip Biru',
  weight: 28.5,
  earned: 350,
  isChest: false
});
assert.strictEqual(stat1.isNewRecord, true, 'Tangkapan pertama harus jadi rekor baru');
assert.strictEqual(stat1.heaviestWeight, 28.5, 'Bobot terberat harus 28.5 Kg');

const stat2 = await db.updateFishingStats(testUser, {
  fishName: 'Ikan Lele Kecil',
  weight: 2.1,
  earned: 15,
  isChest: false
});
assert.strictEqual(stat2.isNewRecord, false, 'Tangkapan lebih kecil tidak memecahkan rekor');
assert.strictEqual(stat2.heaviestWeight, 28.5, 'Rekor terberat harus tetap 28.5 Kg');

const leaderboard = await db.getFishingLeaderboard();
assert.ok(leaderboard.length > 0, 'Leaderboard harus memiliki data');
console.log('✅ 5. Statistik & Leaderboard ikan terberat valid 100%');

// 6. Jual ikan & buka peti TIDAK boleh dihitung sebagai tangkapan baru
await db.updateFishingStats(testUser, { earned: 120 });                // seperti `.jualikan`
await db.updateFishingStats(testUser, { isChest: true, earned: 900 }); // seperti `.bukapeti`
const statsAkhir = (await db.getFishingLeaderboard()).find(r => r.user_jid === testUser);
assert.strictEqual(statsAkhir.total_caught, 2, 'Jual ikan & buka peti tidak menambah total tangkapan');
assert.strictEqual(statsAkhir.chests_opened, 1, 'Peti yang dibuka tetap tercatat');
assert.strictEqual(statsAkhir.total_earned, 350 + 15 + 120 + 900, 'Pendapatan tetap terakumulasi');
console.log('✅ 6. Jual ikan & buka peti tidak mengembungkan total tangkapan');

// Bersih-bersih: JID tes ini palsu, jangan sampai ikut nangkring di papan
// peringkat `.mancingtop` yang dilihat pemain sungguhan.
await db.clearFishFromBasket(testUser);
await db.resetFishingStats(testUser);

console.log('\n🎉 SEMUA SMOKE TESTS OVERHAULED FISHING 100% SUKSES!');
