const fs = require('fs');

let content = fs.readFileSync('src/handlers/groupAdminHandler.js', 'utf8');
content = content.replace(/\\\\\\/g, '\');
content = content.replace(/\\\\\$/g, '$');
fs.writeFileSync('src/handlers/groupAdminHandler.js', content);
