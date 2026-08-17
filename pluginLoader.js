import fs from 'fs';
import path from 'path';

const pluginsMap = new Map();

export async function loadPlugins() {
  pluginsMap.clear();
  const pluginsDir = './plugins';
  
  if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
  }

  const files = fs.readdirSync(pluginsDir).filter(file => file.endsWith('.js'));
  let loadedCount = 0;

  for (const file of files) {
    try {
      const pluginPath = `./plugins/${file}`;
      const pluginModule = await import(`${pluginPath}?v=${Date.now()}`);
      
      if (pluginModule.default && pluginModule.default.name && pluginModule.default.handler) {
        pluginsMap.set(pluginModule.default.name, pluginModule.default);
        loadedCount++;
      }
    } catch (err) {
      console.error(`[PLUGIN_LOADER] Gagal memuat plugin ${file}:`, err.message);
    }
  }

  console.log(`[PLUGIN_LOADER] Berhasil memuat ${loadedCount} plugin modular dari ${pluginsDir}`);
  return loadedCount;
}

export async function executePlugin(cleanCmd, context) {
  const isPrefix = context?.isPrefixCmd !== undefined 
    ? context.isPrefixCmd 
    : (context?.msgText?.startsWith('.') || context?.msgText?.startsWith('/') || context?.msgText?.startsWith('#'));
  if (!isPrefix) return false;

  for (const [name, plugin] of pluginsMap.entries()) {
    if (plugin.commands && plugin.commands.includes(cleanCmd)) {
      try {
        const handled = await plugin.handler(context);
        if (handled !== false) return true;
      } catch (err) {
        console.error(`[PLUGIN_EXEC_ERR] Error saat mengeksekusi plugin ${name}:`, err.message);
      }
    }
  }
  return false;
}
