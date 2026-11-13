// 启动期模块求值图的回归护栏（2026-11-12，第三轮修复引入的启动回归）。
//
// 背景：electron/main.js 静态 import src/self-update.js。若 self-update.js 又静态
// import src/instance-lock.js，后者会 import src/config.js —— 而 ESM 静态 import 在
// main.js 任何一行代码执行**之前**就整条链求值完毕，此时 main.js 里运行时才设置
// QQ_AGENT_DATA_DIR 的 resolveDataDir() 还没跑，DATA_DIR 会被固化成
// resources/app/data（headless 布局）。后果：单实例锁、日志目录全部指错地方，
// 首启 data/ 全新时还会复活「解压后双击打不开」的自愈竞态。
//
// 这条护栏盯住**唯一那条静态路径**：求值图里不能出现 config.js。用静态扫描
// （不执行任何被扫模块）实现，跨平台、不吃环境变量，且回归时必定变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_REL = 'src/config.js';

/** 读取仓库内文件源码（相对仓库根）。 */
function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * 剥掉行注释与块注释，但完整保留字符串内容（含字符串里的 // 与引号）。
 * 保留换行，否则多行 import 语句会被拼坏。
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  let out = '';
  let state = 'code';   // code | line | block | ' | " | `
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1] ?? '';
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { state = c; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; } else { out += ' '; }
      i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    // 字符串内部：原样保留，处理反斜杠转义，遇到配对引号才退出。
    if (c === '\\') { out += c + n; i += 2; continue; }
    out += c;
    if (c === state) state = 'code';
    i += 1;
  }
  return out;
}

/** 抽出源码里所有相对**静态** import / re-export 的 specifier（动态 import() 不属于求值期）。 */
function relativeStaticSpecifiers(src) {
  const specs = new Set();
  const FROM_RE = /\b(?:import|export)\s+[^;]*?\bfrom\s*['"](\.[^'"]+)['"]/g;
  const BARE_RE = /\bimport\s*['"](\.[^'"]+)['"]/g;
  for (const re of [FROM_RE, BARE_RE]) {
    let m;
    while ((m = re.exec(src)) !== null) specs.add(m[1]);
  }
  return [...specs];
}

/** 从 entry 出发递归解析相对静态 import，返回可达文件集合与边表。 */
function collectGraph(entry) {
  const visited = new Set();
  const edges = new Map();
  const stack = [entry];
  while (stack.length) {
    const rel = stack.pop();
    if (visited.has(rel)) continue;
    visited.add(rel);
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const src = stripComments(fs.readFileSync(abs, 'utf8'));
    const deps = [];
    for (const spec of relativeStaticSpecifiers(src)) {
      if (!/\.(?:m?js|cjs)$/.test(spec)) continue;
      const depAbs = path.resolve(path.dirname(abs), spec);
      if (!fs.existsSync(depAbs)) continue;
      const depRel = path.relative(ROOT, depAbs).split(path.sep).join('/');
      deps.push(depRel);
      if (!visited.has(depRel)) stack.push(depRel);
    }
    edges.set(rel, deps);
  }
  return { visited, edges };
}

/** 统计 entry 到 target 的静态路径条数（带环保护）。 */
function countPaths(edges, entry, target) {
  let count = 0;
  const walk = (node, seen) => {
    if (node === target) { count += 1; return; }
    if (seen.has(node)) return;
    const next = new Set(seen);
    next.add(node);
    for (const dep of edges.get(node) ?? []) walk(dep, next);
  };
  walk(entry, new Set());
  return count;
}

test('src/self-update.js 不得静态 import instance-lock.js（求值期固化 DATA_DIR 的唯一入口）', () => {
  const src = stripComments(readSrc('src/self-update.js'));
  assert.doesNotMatch(
    src,
    /\bfrom\s*['"]\.\/instance-lock\.js['"]/,
    'self-update.js 一旦静态 import instance-lock.js，就会把 config.js 拖进 electron/main.js 的求值期'
  );
});

test('import src/self-update.js 的静态求值图不触及 src/config.js', () => {
  const { visited } = collectGraph('src/self-update.js');
  assert.ok(
    !visited.has(CONFIG_REL),
    `求值图里出现了 ${CONFIG_REL}（相关文件：${[...visited].filter((f) => /instance-lock|config/.test(f)).join(', ')}）`
  );
});

test('electron/main.js 的静态求值图通往 src/config.js 的路径数为 0', () => {
  const { visited, edges } = collectGraph('electron/main.js');
  const paths = countPaths(edges, 'electron/main.js', CONFIG_REL);
  assert.equal(paths, 0, `仍有 ${paths} 条静态路径通往 ${CONFIG_REL}`);
  assert.ok(!visited.has(CONFIG_REL));
  // 守住入口仍在，防止把整条自更新链改成动态加载来"绕过"断言。
  assert.ok(visited.has('src/self-update.js'), 'main.js 仍应静态 import self-update.js');
  console.log(`[module-graph] electron/main.js 可达文件数 = ${visited.size}；通往 ${CONFIG_REL} 的路径数 = ${paths}`);
});

test('src/process-image.js 不得引入任何项目内相对依赖', () => {
  const src = stripComments(readSrc('src/process-image.js'));
  assert.deepEqual(
    relativeStaticSpecifiers(src),
    [],
    'process-image.js 一旦有项目内静态依赖，就可能把 config.js 带回求值图'
  );
});
