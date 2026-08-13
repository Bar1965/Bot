const fs = require('fs');

function patchHandler(file, anchor, checkCode) {
    let content = fs.readFileSync(file, 'utf8');
    if (content.includes(anchor) && !content.includes(checkCode)) {
        content = content.replace(anchor, checkCode + '\n' + anchor);
        fs.writeFileSync(file, content);
        console.log('Patched ' + file);
    } else {
        console.log('Skipped ' + file);
    }
}

// 1. premiumHandler.js
patchHandler('premiumHandler.js', 
  "if (['ai', 'gemini', 'tanyaai', 'askai'].includes(cmd)) {",
  \  const groupSettings = isFromGroup ? await db.getGroupSettings(jid) : {};
  if (isFromGroup && groupSettings.features_config && groupSettings.features_config.ai === false) return false;\
);

// 2. customerHandler.js
patchHandler('src/handlers/customerHandler.js',
  "if (cleanCmd === 'rvo' || cleanCmd === 'readviewonce' || cleanCmd === 'viewonce') {",
  \  const groupSettings = isFromGroup ? await db.getGroupSettings(jid) : {};
  if (isFromGroup && (cleanCmd === 'rvo' || cleanCmd === 'readviewonce' || cleanCmd === 'viewonce') && groupSettings.features_config && groupSettings.features_config.rvo === false) return;\
);

patchHandler('src/handlers/customerHandler.js',
  "if (cleanCmd === 'lens' || cleanCmd === 'imagesearch') {",
  \  if (isFromGroup && (cleanCmd === 'lens' || cleanCmd === 'imagesearch') && groupSettings.features_config && groupSettings.features_config.lens === false) return;\
);

patchHandler('src/handlers/customerHandler.js',
  "if (cleanCmd === 'brat') {",
  \  if (isFromGroup && cleanCmd === 'brat' && groupSettings.features_config && groupSettings.features_config.brat === false) return;\
);

// 3. groupAdminHandler.js
// Wait, totalchat and sponsor are in groupAdminHandler
patchHandler('src/handlers/groupAdminHandler.js',
  "if (isGroup && cleanCmd === 'totalchat') {",
  \  if (isGroup && cleanCmd === 'totalchat' && currentSettings.features_config && currentSettings.features_config.totalchat === false) return true;\
);

patchHandler('src/handlers/groupAdminHandler.js',
  "if (isGroup && cleanCmd === 'sponsor') {",
  \  if (isGroup && cleanCmd === 'sponsor' && currentSettings.features_config && currentSettings.features_config.sponsor === false) return true;\
);

