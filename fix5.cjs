const fs = require('fs');
let lines = fs.readFileSync('src/handlers/customerHandler.js', 'utf8');

lines = lines.replace('\.beli produk\', '\\\\.beli produk\\\');

fs.writeFileSync('src/handlers/customerHandler.js', lines);
console.log('Fixed backticks');
