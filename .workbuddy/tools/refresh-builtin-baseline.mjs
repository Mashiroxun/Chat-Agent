#!/usr/bin/env node
/**
 * 重算内置模块基线指纹 → builtin-modules.json
 *
 * 为什么需要它：内置模块（plugins/ 与 skills/ 下随包分发的那些）在准入闸里按
 * 「目录名在内置清单 + 文件指纹与基线一致」才免检放行。文件一变，指纹就失配，
 * 下一轮热重扫会把它当"占名顶替"拦下 —— 报错文案写的是"触碰高危能力"，
 * 非常误导（2026-10-08、2026-10-28 两次踩坑）。
 *
 * 应用内两条用户确认过的路径（harness → 升级扩展 / 自动修复）落地后会自动重算
 * （见 src/plugin-loader.js 的 refreshBuiltinEntry）。**手工改**内置模块没有这个
 * 闭环，所以要在改完之后跑一次本脚本。
 *
 * 口径必须与 src/plugin-loader.js 的 walkModuleFiles / refreshBuiltinEntry 一致：
 *   · 递归整目录，深度上限 8
 *   · 跳过 node_modules 与**以 . 开头**的文件/目录
 *   · 每个文件取 sha1 十六进制前 16 位
 * ⚠️ 备份文件别放在模块目录里：`index.js.bak-xxx` 不以 . 开头，会被算进指纹，
 *    以后删掉备份就又失配一次。备份请放到 data/code-backups/。
 *
 * 用法：
 *   node .workbuddy/tools/refresh-builtin-baseline.mjs            重算所有不一致的模块（写盘）
 *   node .workbuddy/tools/refresh-builtin-baseline.mjs --check    只检查，不写盘（退出码 1 = 有不一致）
 *   node .workbuddy/tools/refresh-builtin-baseline.mjs extension-forge ...   只重算指定目录
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');          // <app>/.workbuddy/tools → <app>
const BASELINE_FILE = path.join(APP_ROOT, 'builtin-modules.json');

function walkModuleFiles(dir, root = dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkModuleFiles(p, root, out, depth + 1);
    else out.push(path.relative(root, p).replace(/\\/g, '/'));
  }
  return out;
}

function fingerprint(modDir) {
  const files = {};
  for (const rel of walkModuleFiles(modDir)) {
    try {
      files[rel] = crypto.createHash('sha1')
        .update(fs.readFileSync(path.join(modDir, rel))).digest('hex').slice(0, 16);
    } catch { /* 读不了的不记账：下次会因"基线缺文件"失败，方向是安全的 */ }
  }
  return files;
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const only = args.filter((a) => !a.startsWith('--'));

let doc;
try { doc = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); }
catch (e) { console.error(`读不到基线 ${BASELINE_FILE}：${e.message}`); process.exit(2); }
const modules = Array.isArray(doc?.modules) ? doc.modules : [];
if (!modules.length) { console.error('基线里没有任何模块，拒绝写入。'); process.exit(2); }

let mismatched = 0, updated = 0, missing = 0;
for (const m of modules) {
  const dir = String(m?.dir ?? '').trim();
  if (!dir) continue;
  if (only.length && !only.includes(dir)) continue;
  const sub = m?.kind === 'skill' ? 'skills' : 'plugins';
  const modDir = path.join(APP_ROOT, sub, dir);
  if (!fs.existsSync(modDir)) { console.log(`! ${dir}：目录不存在（${sub}/${dir}）`); missing += 1; continue; }

  const cur = fingerprint(modDir);
  const prev = m.files || {};
  const ka = Object.keys(prev).sort(), kb = Object.keys(cur).sort();
  const same = ka.length === kb.length && ka.every((k, i) => k === kb[i] && prev[k] === cur[k]);
  if (same) continue;

  mismatched += 1;
  const added = kb.filter((k) => !(k in prev));
  const removed = ka.filter((k) => !(k in cur));
  const changed = kb.filter((k) => k in prev && prev[k] !== cur[k]);
  console.log(`~ ${dir}：+${added.length} -${removed.length} ~${changed.length}`
    + `${added.length ? `  新增[${added.join(', ')}]` : ''}`
    + `${removed.length ? `  缺失[${removed.join(', ')}]` : ''}`
    + `${changed.length ? `  改动[${changed.join(', ')}]` : ''}`);
  if (checkOnly) continue;

  m.files = cur;
  updated += 1;
}

if (checkOnly) {
  console.log(mismatched ? `\n共 ${mismatched} 个模块与基线不一致（未写盘，加 -- 去掉 --check 才会修）` : '\n全部一致');
  process.exit(mismatched ? 1 : 0);
}
if (!updated) { console.log(mismatched ? '\n没有可写的改动' : '\n全部一致，无需重算'); process.exit(0); }

// 原子写：先写临时文件再 rename —— 半截 JSON 会让准入闸 fail-closed 拦下所有模块
const tmp = `${BASELINE_FILE}.tmp-${process.pid}`;
try {
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, BASELINE_FILE);
} catch (e) {
  try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  console.error(`写基线失败：${e.message}`);
  process.exit(2);
}
console.log(`\n已重算 ${updated} 个模块并写回 builtin-modules.json${missing ? `（另有 ${missing} 个目录不存在，已跳过）` : ''}`);
console.log('提示：正在运行的实例需要重启，或在「自检 → 重新扫描」触发一次热重扫才会重新加载。');
