import { AsyncLocalStorage } from 'async_hooks';
import sqlite3 from 'sqlite3';

const sqlite = sqlite3.verbose();
const dbFile = './shop.db';

let db;
let transactionQueue = Promise.resolve();

// Membungkus method-method database dalam Promise agar bisa menggunakan async/await
export function openDb() {
  return new Promise((resolve, reject) => {
    db = new sqlite.Database(dbFile, (err) => {
      if (err) {
        console.error('Gagal membuka database:', err.message);
        reject(err);
      } else {
        db.configure('busyTimeout', 5000);
        console.log('Terhubung ke database SQLite.');
        resolve();
      }
    });
  });
}

export function getDb() {
  return db;
}

// Penanda "sedang di dalam transaksi" harus per-konteks-async, BUKAN boolean global.
// Dengan boolean global, pemanggil lain yang kebetulan masuk saat transaksi milik orang lain
// sedang menunggu await akan ikut mengambil jalur pintas nested: query-nya berjalan TANPA
// BEGIN sendiri, di dalam transaksi orang lain, dan ikut terhapus kalau transaksi itu
// ROLLBACK — padahal pemanggilnya sudah terlanjur menerima {success:true}.
// AsyncLocalStorage hanya terlihat oleh rantai await milik pemanggil yang sama.
const txContext = new AsyncLocalStorage();

export async function withTransaction(callback) {
  // Benar-benar nested: dipanggil dari dalam callback transaksi yang sedang berjalan.
  if (txContext.getStore()) {
    return await callback();
  }

  const transaction = transactionQueue.then(() => txContext.run({ active: true }, async () => {
    await runQuery('BEGIN IMMEDIATE');
    try {
      const result = await callback();
      await runQuery('COMMIT');
      return result;
    } catch (error) {
      try {
        await runQuery('ROLLBACK');
      } catch (rollbackError) {
        console.error('Gagal membatalkan transaksi SQLite:', rollbackError.message);
      }
      throw error;
    }
  }));
  transactionQueue = transaction.catch(() => undefined);
  return transaction;
}

export function runQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

export function getQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

export function allQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

export function normalizePhoneDigits(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/[^0-9]/g, '');
  if (digits.startsWith('08')) {
    digits = '628' + digits.slice(2);
  }
  return digits;
}

export function isPhoneMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const digA = normalizePhoneDigits(a);
  const digB = normalizePhoneDigits(b);
  if (!digA || !digB) return false;
  if (digA === digB) return true;
  if (digA.length >= 7 && digB.length >= 7) {
    return digA.endsWith(digB) || digB.endsWith(digA);
  }
  return false;
}

export function formatPhoneNumber(nomor) {
  if (!nomor) return '';
  let clean = nomor.replace(/[^0-9]/g, '');
  if (clean.startsWith('0')) {
    clean = '62' + clean.slice(1);
  }
  return clean;
}
