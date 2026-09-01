// ─── 🕵️ UNDERCOVER — BARREL ─────────────────────────────────────────
// Isi game sudah dipecah ke `src/games/undercover/` (constants, state, flow,
// roles, abilities, cards, stats). File ini sengaja dipertahankan sebagai
// jembatan tipis supaya seluruh import lama tetap jalan tanpa diubah:
//   • src/games/index.js   — router perintah game
//   • bot.js               — restoreUndercoverSessions saat boot
//   • src/games/leaderboard.js — delegasi `.lb undercover`
//
// Jangan menambahkan logika apa pun di sini; tambahkan di modul yang sesuai.

export * from './undercover/index.js';
