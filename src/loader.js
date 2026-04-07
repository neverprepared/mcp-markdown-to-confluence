import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as pathResolve, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

function tryResolveFile(filePath) {
  // Direct .js extension
  if (existsSync(filePath + '.js')) {
    return pathToFileURL(filePath + '.js').href;
  }
  // Directory with index.js
  if (existsSync(filePath + '/index.js')) {
    return pathToFileURL(filePath + '/index.js').href;
  }
  // Directory with package.json (module or main field)
  if (existsSync(filePath + '/package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(filePath + '/package.json', 'utf-8'));
      const entry = pkg.module || pkg.main;
      if (entry) {
        const resolved = pathResolve(filePath, entry);
        if (existsSync(resolved)) {
          return pathToFileURL(resolved).href;
        }
      }
    } catch (err) {
      // Non-fatal: if package.json is unparseable we simply can't resolve this path.
      process.stderr.write(`[loader] Failed to parse package.json at ${filePath}: ${err?.message ?? err}\n`);
    }
  }
  return null;
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.json')) {
    return nextLoad(url, { ...context, importAttributes: { type: 'json' } });
  }
  return nextLoad(url, context);
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'ERR_UNSUPPORTED_DIR_IMPORT') {
      // Try from the error's resolved URL
      if (err.url) {
        const resolved = tryResolveFile(fileURLToPath(err.url));
        if (resolved) return { url: resolved, shortCircuit: true };
      }

      // Try from parent for relative specifiers
      if (specifier.startsWith('.') && context.parentURL) {
        const parentPath = dirname(fileURLToPath(context.parentURL));
        const resolved = tryResolveFile(pathResolve(parentPath, specifier));
        if (resolved) return { url: resolved, shortCircuit: true };
      }
    }
    throw err;
  }
}
