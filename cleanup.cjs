const fs = require('fs');

function fixNewlines(file) {
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace(/\\nif \(/g, '\nif (');
    fs.writeFileSync(file, content);
}

fixNewlines('premiumHandler.js');
fixNewlines('src/handlers/customerHandler.js');
fixNewlines('src/handlers/groupAdminHandler.js');

let groupAdmin = fs.readFileSync('src/handlers/groupAdminHandler.js', 'utf8');
// Fix the literal slashes back to normal backticks and template strings
groupAdmin = groupAdmin.replace(/\\\\\/g, '\');
groupAdmin = groupAdmin.replace(/\\\\n/g, '\\n');
groupAdmin = groupAdmin.replace(/\\\\\\$/g, '$');
fs.writeFileSync('src/handlers/groupAdminHandler.js', groupAdmin);

console.log('Fixed syntax errors');
