#!/usr/bin/env node
// 启动组合预检（0.4.9.2）
//
//   node scripts/check-composition.mjs
//
// 只读清单、不执行层代码，所以它能告诉你"会加载哪些层、谁覆盖谁"，
// 但不能代替真实启动验证（导出是不是函数、参数对不对，只有真启动才知道）。
//
// 退出码：0 = 无错误；1 = 有错误（清单非法 / 路径非法 / 模块缺失）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OVERRIDES = path.join(APP_ROOT, 'overrides');
const MODULE_EXT = new Set(['.js', '.mjs', '.cjs']);
const LAYER_ID = /^[A-Za-z0-9_-]{1,64}$/;

const errors = [];
const warnings = [];

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function checkFile(layerDir, relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 512) return { ok: false, reason: '路径为空或过长' };
  if (path.isAbsolute(relative)) return { ok: false, reason: '不接受绝对路径' };
  if (/[\\%:\x00-\x1f?#]/.test(relative)) return { ok: false, reason: '路径含非法字符（含反斜杠）' };
  if (relative.split('/').some((part) => !part || part === '.' || part === '..')) return { ok: false, reason: '路径含 . / .. 段' };
  let current = layerDir;
  try {
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) return { ok: false, reason: '路径含符号链接' };
    }
    if (!isInside(layerDir, current)) return { ok: false, reason: '路径越出层目录' };
    if (!fs.statSync(current).isFile()) return { ok: false, reason: '不是普通文件' };
  } catch {
    return { ok: false, reason: '文件不存在' };
  }
  if (!MODULE_EXT.has(path.extname(current).toLowerCase())) return { ok: false, reason: '只接受 .js/.mjs/.cjs' };
  return { ok: true, file: current };
}

function readManifest(layerDir) {
  const file = path.join(layerDir, 'composition.json');
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error('composition.json 是符号链接');
  if (stat.size > 64 * 1024) throw new Error('composition.json 超过 64 KiB');
  const raw = fs.readFileSync(file, 'utf8');
  const manifest = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('清单必须是对象');
  if (manifest.version !== 1) throw new Error(`不支持的清单版本 ${JSON.stringify(manifest.version)}（只接受 1）`);
  if (typeof manifest.id !== 'string' || !LAYER_ID.test(manifest.id)) throw new Error('id 缺失或非法（字母数字下划线短横线，1-64 字符）');
  return manifest;
}

function main() {
  console.log(`应用根目录：${APP_ROOT}`);
  console.log(`覆盖层目录：${OVERRIDES}\n`);

  if (!fs.existsSync(OVERRIDES)) {
    console.log('没有 overrides/ 目录 —— 使用全部出厂实现。');
    return;
  }

  const layers = [];
  for (const entry of fs.readdirSync(OVERRIDES, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const layerDir = path.join(OVERRIDES, entry.name);
    const manifestFile = path.join(layerDir, 'composition.json');
    if (!fs.existsSync(manifestFile)) {
      warnings.push(`${entry.name}：目录存在但没有 composition.json，已忽略`);
      continue;
    }
    try {
      const manifest = readManifest(layerDir);
      const decls = manifest.components ?? {};
      if (typeof decls !== 'object' || Array.isArray(decls)) throw new Error('components 必须是对象');
      const resolved = [];
      for (const [key, decl] of Object.entries(decls)) {
        const spec = typeof decl === 'string' ? { module: decl } : decl;
        if (!spec || typeof spec !== 'object' || typeof spec.module !== 'string') {
          errors.push(`${entry.name} / ${key}：组件声明必须是路径字符串或 { module, export }`);
          continue;
        }
        const checked = checkFile(layerDir, spec.module.replace(/^\.\//, ''));
        if (!checked.ok) {
          errors.push(`${entry.name} / ${key}：${spec.module} —— ${checked.reason}`);
          continue;
        }
        resolved.push({ key, module: spec.module, export: typeof spec.export === 'string' && spec.export ? spec.export : 'default' });
      }
      layers.push({ dir: entry.name, manifest, resolved, order: Number(manifest.order) || 100 });
    } catch (error) {
      errors.push(`${entry.name}：清单无效 —— ${error.message}`);
    }
  }

  if (!layers.length) {
    console.log('没有可用的层 —— 使用全部出厂实现。');
  } else {
    layers.sort((a, b) => (a.order - b.order) || a.dir.localeCompare(b.dir));
    const ids = new Map();
    for (const layer of layers) {
      if (ids.has(layer.manifest.id)) {
        errors.push(`层 id 重复：${layer.manifest.id}（${ids.get(layer.manifest.id)} 与 ${layer.dir}）`);
      }
      ids.set(layer.manifest.id, layer.dir);
    }

    console.log('加载顺序（order 小的先加载，后加载的同键覆盖先加载的）：\n');
    layers.forEach((layer, index) => {
      const state = layer.manifest.enabled === false ? '【已停用】' : '';
      console.log(`  ${index + 1}. ${layer.dir}  id=${layer.manifest.id}  order=${layer.order} ${state}`);
      if (!layer.resolved.length) console.log('     （没有组件声明）');
      for (const item of layer.resolved) {
        console.log(`     · ${item.key}  ←  ${item.module}${item.export === 'default' ? '' : ` [${item.export}]`}`);
      }
    });

    // 最终归属：每个键最后被哪一层拿到
    const owner = new Map();
    for (const layer of layers) {
      if (layer.manifest.enabled === false) continue;
      for (const item of layer.resolved) owner.set(item.key, layer);
    }
    console.log('\n重启后实际生效的组件：\n');
    if (!owner.size) console.log('  （无 —— 全部走出厂实现）');
    for (const [key, layer] of [...owner.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const shadowed = layers.filter((l) => l !== layer && l.manifest.enabled !== false && l.resolved.some((r) => r.key === key));
      const note = shadowed.length ? `（覆盖了 ${shadowed.map((l) => l.manifest.id).join('、')}）` : '';
      console.log(`  ${key.padEnd(28)} ← ${layer.manifest.id} ${note}`);
    }
  }

  console.log('');
  for (const message of warnings) console.log(`警告：${message}`);
  if (errors.length) {
    for (const message of errors) console.log(`错误：${message}`);
    console.log(`\n共 ${errors.length} 个错误 —— 启动时这些层/组件会被跳过（桌面版继续按出厂实现启动）。`);
    process.exitCode = 1;
  } else {
    console.log('预检通过：清单与路径均合法。（导出是否为函数、参数是否匹配，仍需真实启动验证）');
  }
}

main();
