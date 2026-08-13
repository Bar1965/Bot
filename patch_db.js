const fs = require('fs');
let content = fs.readFileSync('database.js', 'utf8');

const target = \export async function getExpiredGroupRentals() {\;
const replacement = \export async function getGroupRental(groupJid) {
  return await getQuery("SELECT * FROM group_rentals WHERE group_jid = ?", [groupJid]);
}

export async function getExpiredGroupRentals() {\;

if (content.includes(target)) {
  content = content.replace(target, replacement);
  fs.writeFileSync('database.js', content);
  console.log("Patched database.js successfully!");
} else {
  console.log("Failed to patch database.js");
}
