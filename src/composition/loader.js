// 启动组合加载器（0.4.9.2 引入）
//
// 扫描 APP_ROOT/overrides/<层目录>/composition.json，按 order 升序叠加，
// 返回一张组件表交给 createApp({ components })。不修改任何出厂源码即可替换实现。
//
// 清单格式（对齐 0.5，但只支持 replace —— 洛版的组件是类实例，
// 包装单个方法请在自己的工厂里做，本加载器不提供 wrap 语义）：
//
//   {
//     "version": 1,
//     "id": "my-setup",
//     "order": 20,
//     "enabled": true,
//     "components": {
//       "core.prompt.system": { "module": "./impl.mjs", "export": "systemPrompt" },
//       "data.messages": "./store.mjs"            // 简写 = 默认导出
//     }
//   }
//
// 安全边界：路径必须落在本层目录内、不接受绝对路径 / 目录穿越 / 符号链接；
// 模块只接受 .js/.mjs/.cjs；导出必须是函数。任何一条不满足都明确抛错，不静默降级。
// 注意：启动组合是原生代码，信任等级等同于直接改源码。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_LAYERS = 64;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MODULE_EXT = new Set(['.js', '.mjs', '.cjs']);
const LAYER_ID = /^[A-Za-z0-9_-]{1,64}$/;

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/** 逐段检查符号链接，防止启动后换目录绕过范围。 */
function safeFilePath(layerDir, relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 512) return null;
  if (path.isAbsolute(relative) || /[\\%:\x00-\x1f?#]/.test(relative)) return null;
  if (relative.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  let current = layerDir;
  try {
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) return null;
    }
    if (!isInside(layerDir, current)) return null;
    if (!fs.statSync(current).isFile()) return null;
    return current;
  } catch {
    return null;
  }
}

function readManifest(layerDir) {
  const file = path.join(layerDir, 'composition.json');
  let raw;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('composition.json 不是普通文件');
    if (stat.size > MAX_MANIFEST_BYTES) throw new Error('composition.json 超过 64 KiB');
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;   // 没有清单 = 不是一层，跳过
    throw error;
  }
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;   // 允许 BOM
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`composition.json 不是合法 JSON：${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('composition.json 必须是对象');
  }
  if (manifest.version !== 1) {
    throw new Error(`不支持的清单版本 ${JSON.stringify(manifest.version)}（当前只接受 1）`);
  }
  if (typeof manifest.id !== 'string' || !LAYER_ID.test(manifest.id)) {
    throw new Error('清单 id 缺失或非法（只允许字母数字下划线短横线，1-64 字符）');
  }
  return manifest;
}

/**
 * 加载所有启用的覆盖层。
 *
 * @param {object} options
 * @param {string} options.appRoot 应用根目录（含 overrides/）
 * @param {Function} [options.log]
 * @param {Function} [options.warn] 层加载失败时的报告出口（默认同 log）
 * @returns {Promise<{components: Record<string, Function>, layers: Array, errors: Array}>}
 */
export async function loadComposition({ appRoot, log = console.log, warn = null } = {}) {
  const report = { components: {}, layers: [], errors: [] };
  if (typeof appRoot !== 'string' || !appRoot) return report;
  const root = path.join(appRoot, 'overrides');
  let entries;
  try {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return report;
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return report;   // 没有 overrides/ = 没有层，正常
  }

  const layers = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const layerDir = path.join(root, entry.name);
    try {
      const manifest = readManifest(layerDir);
      if (!manifest) continue;
      if (manifest.enabled === false) {
        report.layers.push({ dir: entry.name, id: manifest.id, order: manifest.order ?? 100, enabled: false });
        continue;
      }
      layers.push({ dir: entry.name, layerDir, manifest, order: Number(manifest.order) || 100 });
    } catch (error) {
      report.errors.push({ dir: entry.name, error: `清单无效：${error.message}` });
    }
  }

  if (layers.length > MAX_LAYERS) {
    throw new Error(`启用层数 ${layers.length} 超过上限 ${MAX_LAYERS}`);
  }
  // 相同 order 按目录名字符序，保证结果稳定。
  layers.sort((a, b) => (a.order - b.order) || a.dir.localeCompare(b.dir));

  const seen = new Set();
  for (const { dir, layerDir, manifest, order } of layers) {
    if (seen.has(manifest.id)) {
      report.errors.push({ dir, error: `层 id 重复：${manifest.id}` });
      continue;
    }
    seen.add(manifest.id);

    const decls = manifest.components ?? {};
    if (typeof decls !== 'object' || Array.isArray(decls)) {
      report.errors.push({ dir, error: 'components 必须是对象' });
      continue;
    }

    const applied = [];
    for (const [key, decl] of Object.entries(decls)) {
      const spec = typeof decl === 'string' ? { module: decl } : decl;
      if (!spec || typeof spec !== 'object' || typeof spec.module !== 'string') {
        report.errors.push({ dir, key, error: '组件声明必须是路径字符串或 { module, export }' });
        continue;
      }
      const file = safeFilePath(layerDir, spec.module.replace(/^\.\//, ''));
      if (!file) {
        report.errors.push({ dir, key, error: `模块路径非法或不存在：${spec.module}` });
        continue;
      }
      if (!MODULE_EXT.has(path.extname(file).toLowerCase())) {
        report.errors.push({ dir, key, error: `模块必须是 .js/.mjs/.cjs：${spec.module}` });
        continue;
      }
      try {
        const mod = await import(pathToFileURL(file).href);
        const name = typeof spec.export === 'string' && spec.export ? spec.export : 'default';
        const impl = mod[name];
        if (typeof impl !== 'function') {
          report.errors.push({ dir, key, error: `导出 ${name} 不是函数` });
          continue;
        }
        report.components[key] = impl;
        applied.push(key);
      } catch (error) {
        report.errors.push({ dir, key, error: `模块加载失败：${error.message}` });
      }
    }
    report.layers.push({ dir, id: manifest.id, order, enabled: true, components: applied });
    log?.(`[composition] 已加载层 ${manifest.id}（${dir}，order=${order}）：${applied.join(', ') || '无组件'}`);
  }

  for (const item of report.errors) {
    const message = `[composition] 层 ${item.dir}${item.key ? ` / ${item.key}` : ''} 加载失败：${item.error}`;
    if (typeof warn === 'function') warn(message);
    else log?.(message);
  }
  return report;
}
