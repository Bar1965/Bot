/**
 * STOK INPUT — membaca pesan `.addstock` menjadi daftar kredensial.
 *
 * Murni teks: tidak menyentuh database maupun socket, supaya bisa diuji tanpa
 * menyalakan bot (AGENTS.md §15a). Logikanya dulu ditulis langsung di dalam
 * groupAdminHandler dan tidak ada satu pun yang menjaganya, sampai bentuk
 * penempelan yang paling wajar diam-diam membuang satu kredensial.
 */

/**
 * Memisah pesan `.addstock` menjadi kode produk dan daftar kredensialnya.
 *
 * Bentuk yang diterima, ketiganya sama sahnya:
 *
 *   .addstock GEMINI                         -> minta panduan, items kosong
 *   .addstock GEMINI https://…/redeem?code=A -> satu kredensial
 *   .addstock GEMINI                         -> banyak kredensial
 *   https://…/redeem?code=A
 *   https://…/redeem?code=B
 *
 *   .addstock GEMINI https://…/redeem?code=A -> TIGA kredensial, bukan dua
 *   https://…/redeem?code=B
 *   https://…/redeem?code=C
 *
 * Bentuk terakhir itulah yang dulu rusak: begitu ada baris kedua, baris
 * perintahnya ikut dibaca sebagai perintah saja dan kredensial yang menempel di
 * sana hilang tanpa pesan apa pun. Ringkasannya tetap berbunyi "berhasil", cuma
 * angkanya satu lebih sedikit daripada yang ditempel — dan angka itu tidak ada
 * pembandingnya di layar, jadi tidak ada yang bisa menyadarinya.
 *
 * Spasi di dalam satu baris TIDAK memisah kredensial: "akun@mail.com | sandi 123"
 * adalah satu kredensial utuh. Pemisahnya hanya baris baru.
 */
export function uraiBarisAddstock(text) {
  const baris = String(text || '')
    .split('\n')
    .map(b => b.trim())
    .filter(Boolean);

  if (baris.length === 0) return { kode: '', items: [] };

  const token = baris[0].split(/\s+/);
  const kode = (token[1] || '').toUpperCase();

  const items = [];
  const sisaBarisPertama = token.slice(2).join(' ').trim();
  if (sisaBarisPertama) items.push(sisaBarisPertama);
  items.push(...baris.slice(1));

  return { kode, items };
}
