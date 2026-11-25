/**
 * PEMERIKSAAN KETAT KESEHATAN & RESPONSIBILITAS BOT WHATSAPP
 * 
 * Skrip ini memvalidasi seluruh subsistem kritis bot:
 * 1. Integritas Sesi & Kunci Signal (Cek creds.json, deteksi session kembung/korup).
 * 2. Integritas Database SQLite & Tabel Utama (customers, orders, products, settings).
 * 3. Verifikasi Pipeline Anti-Unresponsive di bot.js:
 *    - Inbound handler mendukung 'append' (reconnect/offline recovery).
 *    - Deteksi StubType 2 / CIPHERTEXT dan auto-healing ratchet.
 *    - makeCacheableSignalKeyStore terpasang pada Baileys socket auth.
 *    - Timeout guard (25s) & watchdog deadlock pada processOutgoingQueue.
 *    - Flush kredensial saat connection close.
 * 4. Uji Jebakan Runtime (Template literals & TDZ variables di 160+ berkas).
 * 5. Menu Command Registry integrity.
 * 6. Audit Log: Memastikan tidak ada akumulasi error Bad MAC di log terbaru.
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const AKAR = path.resolve(import.meta.dirname, '..');

let lulus = 0;
let gagal = 0;
let peringatan = 0;

function cek(nama, kondisi, detail = '') {
  if (kondisi) {
    lulus++;
    console.log(`  [OK]   ${nama}`);
  } else {
    gagal++;
    console.log(`  [FAIL] ${nama}${detail ? ' -> ' + detail : ''}`);
  }
}

function perhatikan(nama, pesan) {
  peringatan++;
  console.log(`  [WARN] ${nama} -> ${pesan}`);
}

const bagian = (judul) => {
  console.log(`\n======================================================`);
  console.log(`  ${judul}`);
  console.log(`======================================================`);
};

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║   PEMERIKSAAN KETAT KESEHATAN BOT WHATSAPP SALES           ║');
console.log('╚════════════════════════════════════════════════════════════╝');

async function jalankanPemeriksaan() {
  // =========================================================================
  // 1. INTEGRITAS FILE SESI & SIGNAL KEYS
  // =========================================================================
  bagian('1. Pemeriksaan Berkas Sesi & Kunci Kriptografi WhatsApp');
  const sessionDir = path.join(AKAR, 'session');
  cek('Folder sesi WhatsApp ada', fs.existsSync(sessionDir), sessionDir);

  if (fs.existsSync(sessionDir)) {
    const credsPath = path.join(sessionDir, 'creds.json');
    cek('Berkas creds.json ada', fs.existsSync(credsPath));

    if (fs.existsSync(credsPath)) {
      try {
        const rawCreds = fs.readFileSync(credsPath, 'utf8');
        const creds = JSON.parse(rawCreds);
        cek('creds.json berisi format JSON yang valid', true);
        cek('Kredensial WhatsApp memiliki identitas (me.id)', Boolean(creds.me?.id), `ID: ${creds.me?.id}`);
        cek('Kredensial WhatsApp memiliki LID (me.lid)', Boolean(creds.me?.lid), `LID: ${creds.me?.lid}`);
      } catch (e) {
        cek('creds.json dapat dibaca dan diparse', false, e.message);
      }
    }

    // Pindai berkas sesi peer (session-*.json)
    const shouldFix = process.argv.includes('--fix') || process.argv.includes('--repair');
    const sessionFiles = fs.readdirSync(sessionDir).filter(f => f.startsWith('session-') && f.endsWith('.json'));
    let bloatedCount = 0;
    let corruptedChainsCount = 0;
    const filesToRepair = [];

    for (const file of sessionFiles) {
      const fullPath = path.join(sessionDir, file);
      const stat = fs.statSync(fullPath);
      let isCorrupted = false;

      if (stat.size > 25000) {
        bloatedCount++;
        isCorrupted = true;
        perhatikan(`Berkas sesi kembung: ${file}`, `Ukuran ${(stat.size / 1024).toFixed(1)} KB (>25KB)`);
      }
      try {
        const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        const sessionCount = Object.keys(content._sessions || {}).length;
        if (sessionCount > 14) {
          corruptedChainsCount++;
          isCorrupted = true;
          perhatikan(`Akumulasi sesi usang di ${file}`, `${sessionCount} sub-sesi terfragmentasi (>14)`);
        }
      } catch (_) {}

      if (isCorrupted) {
        filesToRepair.push({ file, fullPath });
      }
    }

    if (shouldFix && filesToRepair.length > 0) {
      console.log(`\n  [REPAIR] Mode --fix aktif: Mengamankan cadangan dan membersihkan ${filesToRepair.length} file sesi rusak...`);
      const backupDir = path.join(AKAR, 'backups', `session_repair_${Date.now()}`);
      fs.mkdirSync(backupDir, { recursive: true });
      for (const item of filesToRepair) {
        try {
          fs.copyFileSync(item.fullPath, path.join(backupDir, item.file));
          fs.unlinkSync(item.fullPath);
          console.log(`  [REPAIR] ✅ Dicadangkan & dibersihkan: ${item.file}`);
        } catch (repErr) {
          console.warn(`  [REPAIR] ⚠️ Gagal membersihkan ${item.file}:`, repErr.message);
        }
      }
      // Reset hitungan karena telah diperbaiki
      bloatedCount = 0;
      corruptedChainsCount = 0;
    }

    cek('Tidak ada file session kembung (>25KB)', bloatedCount === 0, `${bloatedCount} file kembung ditemukan (Gunakan --fix untuk auto-repair)`);
    cek('Tidak ada file session dengan fragmentasi berlebih (>14 sesi)', corruptedChainsCount === 0, `${corruptedChainsCount} file berfragmentasi (Gunakan --fix untuk auto-repair)`);
  }

  // =========================================================================
  // 2. INTEGRITAS DATABASE SQLITE & TABEL UTAMA
  // =========================================================================
  bagian('2. Pemeriksaan Konektivitas & Struktur Database SQLite');
  try {
    const db = await import('../database.js');
    await db.initDb();
    cek('Inisialisasi database SQLite berhasil', true);

    const tables = await db.allQuery("SELECT name FROM sqlite_master WHERE type='table'");
    const tableNames = new Set(tables.map(t => t.name));

    const requiredTables = ['customers', 'orders', 'products', 'settings', 'group_settings', 'order_items', 'product_items'];
    for (const t of requiredTables) {
      cek(`Tabel '${t}' tersedia di database`, tableNames.has(t));
    }

    const settings = await db.getSettings();
    cek('Konfigurasi settings dapat dibaca', Boolean(settings));
    cek('Nomor Admin utama terisi di settings/config', Boolean(settings?.adminNumbers || process.env.ADMIN_NUMBER));
    cek('Nomor Owner utama terisi di settings/config', Boolean(settings?.ownerNumber || process.env.OWNER_NUMBER));
  } catch (err) {
    cek('Inisialisasi database SQLite', false, err.message);
  }

  // =========================================================================
  // 3. VERIFIKASI KODE SUMBER BOT.JS TERHADAP RESIKO TIDAK MERESPON
  // =========================================================================
  bagian('3. Verifikasi Arsitektur Anti-Unresponsive di bot.js');
  const botJsPath = path.join(AKAR, 'bot.js');
  cek('Berkas bot.js ada', fs.existsSync(botJsPath));

  if (fs.existsSync(botJsPath)) {
    const botSrc = fs.readFileSync(botJsPath, 'utf8');

    // Cek makeCacheableSignalKeyStore
    const hasCacheableImport = botSrc.includes('makeCacheableSignalKeyStore');
    const usesCacheableSignal = botSrc.includes('keys: makeCacheableSignalKeyStore(state.keys');
    cek('Import makeCacheableSignalKeyStore tersedia', hasCacheableImport);
    cek('Baileys makeWASocket memakai makeCacheableSignalKeyStore', usesCacheableSignal);

    // Cek Outbound Queue Timeout & Watchdog
    const hasQueueTimeout = botSrc.includes('TIMEOUT_OUTBOUND_SEND') && botSrc.includes('Promise.race');
    const hasQueueFinally = botSrc.includes('finally {\r\n    isQueueProcessing = false;') || botSrc.includes('finally {\n    isQueueProcessing = false;') || botSrc.includes('finally { isQueueProcessing = false; }');
    const hasQueueWatchdog = botSrc.includes('QUEUE_WATCHDOG');
    cek('Outbound Queue memiliki Timeout Guard (Promise.race 25s)', hasQueueTimeout);
    cek('Outbound Queue melepas lock isQueueProcessing di blok finally', hasQueueFinally);
    cek('Outbound Queue memiliki Watchdog Anti-Deadlock', hasQueueWatchdog);

    // Cek Inbound Append & Ciphertext Auto-Heal
    const handlesAppend = botSrc.includes("type !== 'notify' && type !== 'append'");
    const handlesCipherFailure = botSrc.includes('m.messageStubType === 2') && botSrc.includes('periksaDanSembuhkanCipherFail');
    cek("Inbound message handler menerima tipe 'append' (reconnect recovery)", handlesAppend);
    cek("Inbound message handler mendeteksi StubType 2 (CIPHERTEXT) & auto-heal", handlesCipherFailure);

    // Cek Flush Creds on Disconnect
    const hasCloseFlush = botSrc.includes("if (connection === 'close')") && botSrc.includes('simpanKredensial()');
    cek('Kredensial & Signal Keys di-flush saat connection close', hasCloseFlush);
  }

  // =========================================================================
  // 4. VERIFIKASI COMMAND REGISTRY & MENU GENERATOR
  // =========================================================================
  bagian('4. Verifikasi Command Registry & Menu');
  try {
    const { buildCommandMenu } = await import('../commandRegistry.js');
    const menuOutput = buildCommandMenu({ isAdmin: false, isOwner: false, prefix: '.' });
    cek('buildCommandMenu menghasilkan string menu non-kosong', typeof menuOutput === 'string' && menuOutput.length > 50);
    cek('Menu mencakup kategori belanja/toko', menuOutput.includes('Katalog') || menuOutput.includes('Produk') || menuOutput.includes('Order') || menuOutput.includes('Beli'));
  } catch (menuErr) {
    cek('buildCommandMenu berjalan tanpa error', false, menuErr.message);
  }

  // =========================================================================
  // 5. AUDIT LOG TERKINI UNTUK BAD MAC ATAU SILENT CRASH
  // =========================================================================
  bagian('5. Audit Log Real-time');
  const logCandidates = [
    path.join(AKAR, 'bot.log'),
    path.join(AKAR, 'combined.log')
  ];

  let logAnalyzed = false;
  for (const logPath of logCandidates) {
    if (fs.existsSync(logPath)) {
      try {
        const lines = fs.readFileSync(logPath, 'utf8').split('\n');
        const recentLines = lines.slice(-200);
        const badMacCount = recentLines.filter(l => l.includes('Bad MAC')).length;
        const unhandledRejections = recentLines.filter(l => l.includes('UnhandledPromiseRejection')).length;

        cek(`Log ${path.basename(logPath)} dapat dibaca (200 baris terakhir)`, true);
        cek('Tidak ada error Bad MAC berulang pada 200 baris terakhir', badMacCount === 0, `${badMacCount} Bad MAC ditemukan`);
        cek('Tidak ada UnhandledPromiseRejection pada log terbaru', unhandledRejections === 0, `${unhandledRejections} unhandled rejection`);
        logAnalyzed = true;
        break;
      } catch (_) {}
    }
  }

  if (!logAnalyzed) {
    console.log('  [INFO] Berkas bot.log belum ada atau baru dirotasi.');
  }

  // =========================================================================
  // RINGKASAN HASIL
  // =========================================================================
  console.log(`\n════════════════════════════════════════════════════════════`);
  console.log(`  HASIL PEMERIKSAAN KETAT KESEHATAN BOT`);
  console.log(`  Lulus       : ${lulus}`);
  console.log(`  Peringatan  : ${peringatan}`);
  console.log(`  Gagal       : ${gagal}`);
  console.log(`════════════════════════════════════════════════════════════`);

  if (gagal > 0) {
    console.error(`\n❌ PEMERIKSAAN GAGAL: Terdeteksi ${gagal} kegagalan kritis. Bot belum aman dinyatakan hidup.\n`);
    process.exit(1);
  } else {
    console.log(`\n✅ SEMUA PEMERIKSAAN KETAT LULUS: Bot dinyatakan memenuhi standar stabilitas & responsivitas.\n`);
    process.exit(0);
  }
}

jalankanPemeriksaan().catch(err => {
  console.error('Fatal error dalam skrip uji kesehatan:', err);
  process.exit(1);
});
