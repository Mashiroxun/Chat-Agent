#!/usr/bin/env node
// 发布前体检（只读，不写盘、不改任何文件）。
//
// 为什么需要它：这个软件是**打包成 zip 分发**的，而安装目录里同时住着两份东西 ——
//   ① 程序本体（exe / resources / 各 dll）
//   ② 运行时数据 data/（API Key、QQ 号、群白名单、聊天记录、日志、
//      render-config.json 的 sandbox:false、render-gpu-off.flag ……）
// 只要打包时手一抖把 ② 带进去：
//   · 收包人一开就是"关渲染沙箱"的降级状态（桌宠勉强能显示，但安全纵深没了）；
//   · 更糟的是 API Key / QQ 号 / 群白名单 / 聊天记录直接泄露给收到包的人。
// 这类事故不会报错、不会有日志，只能靠打包前跑一遍这个脚本。
//
// 用法（在任意目录）：
//   node resources/app/scripts/release-preflight.mjs
//   node resources/app/scripts/release-preflight.mjs --json    # 给 CI / 别的脚本吃
// 退出码：0 = 可以打包；1 = 有 FATAL 项，先处理再打。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');               // resources/app
const ROOT = path.resolve(APP_DIR, '..', '..');         // 安装根（QQ Agent.exe 所在）

const findings = [];
const seen = new Set();
const rel = (target) => String(target).split(path.sep).join('/');
const add = (level, target, message, hint) => {
  const key = `${level}|${rel(target)}|${message}`;
  if (seen.has(key)) return;                    // 同一条被多条规则命中时只报一次
  seen.add(key);
  findings.push({ level, target: rel(target), message, hint });
};

/**
 * 安装根下**绝对不能进包**的东西。
 * 判据一律用"存在即报"，因为这些东西本机存在是正常的（软件正在跑），
 * 它们的问题不在"存在"，而在"被一起压进 zip"。
 */
const ROOT_MUST_EXCLUDE = [
  { name: 'data', desc: '运行时数据（API Key / QQ 号 / 群白名单 / 聊天记录 / 日志 / 渲染配置）' },
  { name: 'dev-sandbox', desc: '开发期沙箱调试目录' },
  { name: '使用说明-排障.txt', desc: '排障笔记，非发布内容' }
];

/** app 目录内不进包的东西（同样是"本机存在正常、但会污染分发"）。 */
const APP_MUST_EXCLUDE = [
  { name: '.workbuddy', desc: '本项目的智能体工作目录（含对话与记忆）' },
  { name: 'plugin-data', desc: '插件运行时数据' },
  { name: '__vision-repro.mjs', desc: '临时复现脚本' }
];

/** 打包必须保留的文件（缺了就是打不出能用的包）。 */
const REQUIRED = [
  'QQ Agent.exe',
  'resources/app/package.json',
  'resources/app/electron/main.js',
  'resources/app/electron/render-policy.js',
  'resources/app/electron/desktop-pet.js',
  'resources/app/ui/index.html',
  'resources/app/plugins/desktop-pet/index.js',
  'resources/app/src/app.js',
  'resources/app/builtin-modules.json'
];

// ── 1. 安装根残留 ──────────────────────────────────────────────────────────
for (const item of ROOT_MUST_EXCLUDE) {
  if (fs.existsSync(path.join(ROOT, item.name))) {
    add('EXCLUDE', item.name, item.desc, '打包命令里必须排除；不要删（本机还在用）');
  }
}
// 通配型残留：*.flag / *.bak-* / *.lnk / 测试-*.bat / data-probe*
for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
  const name = entry.name;
  const is = (re) => re.test(name);
  if (is(/\.flag$/i)) add('EXCLUDE', name, '运行时渲染/调试开关文件', '打包时排除');
  if (is(/\.bak-/i)) add('EXCLUDE', name, '备份文件（改代码时留下的）', '打包时排除，或确认无用后删除');
  if (is(/\.lnk$/i)) add('EXCLUDE', name, '快捷方式，指向的是本机路径', '打包时排除');
  if (is(/^测试-.*\.bat$/i)) add('EXCLUDE', name, '排障脚本，收包人双击会关掉安全沙箱', '打包时排除');
  if (is(/^data[-_]?probe/i)) add('EXCLUDE', name, '排障用的临时数据目录', '打包时排除');
}

// ── 2. app 目录内不该带的东西 ──────────────────────────────────────────────
for (const item of APP_MUST_EXCLUDE) {
  if (fs.existsSync(path.join(APP_DIR, item.name))) {
    add('EXCLUDE', `resources/app/${item.name}`, item.desc, '打包时排除');
  }
}
// 代码目录里的备份副本：plugins/ 与 skills/ 下混进 *.bak 会被指纹校验当成"占名顶替"
function walkForBackups(dir, depth = 0) {
  if (depth > 4) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walkForBackups(full, depth + 1); continue; }
    if (/\.(bak|orig|rej)(-|$)/i.test(entry.name) || /~$/.test(entry.name)) {
      add('EXCLUDE', path.relative(ROOT, full), '代码备份副本', '打包时排除（会污染插件指纹校验）');
    }
  }
}
walkForBackups(path.join(APP_DIR, 'plugins'));
walkForBackups(path.join(APP_DIR, 'skills'));
walkForBackups(path.join(APP_DIR, 'electron'));
walkForBackups(path.join(APP_DIR, 'src'));

// ── 3. 必需文件 ────────────────────────────────────────────────────────────
for (const rel of REQUIRED) {
  if (!fs.existsSync(path.join(ROOT, rel))) add('FATAL', rel, '缺少必需文件，打出来的包跑不起来', '确认打包源完整');
}

// ── 4. 敏感内容扫描（只看会被打进包的文本源码）──────────────────────────────
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md', '.txt', '.yml', '.yaml']);
const SCAN_SKIP_DIRS = new Set(['node_modules', 'data', '.workbuddy', 'plugin-data', '.git', 'doc']);
const SECRET_RULES = [
  { re: /(sk-[A-Za-z0-9]{16,})/g, label: '疑似 API Key（sk- 开头）' },
  { re: /(?:api[_-]?key|apikey|token|secret|password)\s*[:=]\s*['"]([A-Za-z0-9_\-]{20,})['"]/gi, label: '疑似硬编码密钥' }
];

/**
 * 明显是占位符/测试假值就别报 FATAL 了。
 * 依据：单元测试里必须写"看起来像密钥"的字符串来验泄漏检测本身
 * （tests/reply-confirm.test.mjs 就有一条 `sk-abcdefghijklmnopqrstuvwx`），
 * 全按 FATAL 报会让体检失去可信度 —— 人会开始习惯性忽略它。
 */
function isPlaceholder(value) {
  const s = String(value || '');
  if (!s) return true;
  if (/^(?:abc|xyz|123|012|foo|bar|test|dummy|fake|sample|example|placeholder|your)/i.test(s)) return true;
  if (/^(?:a{4,}|x{4,}|0{4,}|1{4,})/i.test(s)) return true;
  // 单调递增的字母表片段（abcdefghijklmnopqrstuvwxyz…）
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i + 8 < s.length; i += 1) {
    if (alphabet.includes(s.slice(i, i + 8).toLowerCase())) return true;
  }
  return false;
}
const LOCAL_PATH_RULES = [
  { re: /[A-Za-z]:[\\/]+QQagent/gi, label: '本机绝对路径（<盘符>:\\QQagent）' }
];
let scannedFiles = 0;
const scannedHits = new Map();

function scanFile(file) {
  if (path.resolve(file) === path.resolve(fileURLToPath(import.meta.url))) return;   // 自身含匹配规则文本，跳过
  let text = '';
  try {
    const stat = fs.statSync(file);
    if (stat.size > 2 * 1024 * 1024) return;              // 超大文件跳过（多为数据）
    text = fs.readFileSync(file, 'utf8');
  } catch { return; }
  if (!text || text.includes('\u0000')) return;           // 二进制
  scannedFiles += 1;
  for (const rule of SECRET_RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      if (isPlaceholder(m[1])) continue;
      const hit = `${rule.label}: ${m[1].slice(0, 8)}…`;
      if (!scannedHits.has(hit)) scannedHits.set(hit, path.relative(ROOT, file));
    }
  }
  for (const rule of LOCAL_PATH_RULES) {
    rule.re.lastIndex = 0;
    if (rule.re.test(text)) {
      const hit = `${rule.label}`;
      if (!scannedHits.has(hit)) scannedHits.set(hit, path.relative(ROOT, file));
    }
  }
}

function walkForScan(dir, depth = 0) {
  if (depth > 8) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SCAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walkForScan(full, depth + 1); continue; }
    if (TEXT_EXT.has(path.extname(entry.name).toLowerCase())) scanFile(full);
  }
}
walkForScan(APP_DIR);

for (const [hit, file] of scannedHits) {
  // 源码里写死的本机路径属于"能跑但不该发"，密钥属于"绝对不能发"
  const level = hit.startsWith('疑似') ? 'FATAL' : 'WARN';
  add(level, file, hit, level === 'FATAL' ? '把密钥挪到 data/config.json（不入包）后重扫' : '改成相对路径或从配置读');
}

// ── 输出 ───────────────────────────────────────────────────────────────────
const FATAL = findings.filter((f) => f.level === 'FATAL');
const EXCLUDE = findings.filter((f) => f.level === 'EXCLUDE');
const WARN = findings.filter((f) => f.level === 'WARN');

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ root: ROOT, scannedFiles, findings, ok: FATAL.length === 0 }, null, 2));
  process.exit(FATAL.length === 0 ? 0 : 1);
}

console.log(`发布前体检  根目录=${ROOT}`);
console.log(`已扫描源码文件 ${scannedFiles} 个（跳过 node_modules / data / 二进制）\n`);

if (FATAL.length) {
  console.log(`✗ FATAL ${FATAL.length} 项 —— 先处理再打包：`);
  for (const f of FATAL) console.log(`   · ${f.target}  ${f.message}  → ${f.hint}`);
  console.log('');
}
if (EXCLUDE.length) {
  console.log(`! 必须排除 ${EXCLUDE.length} 项（本机存在是正常的，问题是别压进 zip）：`);
  for (const f of EXCLUDE) console.log(`   · ${f.target}  ${f.message}`);
  console.log('');
}
if (WARN.length) {
  console.log(`~ 建议检查 ${WARN.length} 项：`);
  for (const f of WARN) console.log(`   · ${f.target}  ${f.message}  → ${f.hint}`);
  console.log('');
}

console.log('打包时请显式排除（示例，Windows 自带 tar 可用）：');
// 列出**全部**待排除项（含通配命中的 *.flag / *.bak-* / 测试-*.bat），
// 否则照抄示例打出来的包仍然带着排障残留。
const excl = findings
  .filter((f) => f.level === 'EXCLUDE')
  .map((f) => `--exclude "${f.target}"`)
  .join(' ');
console.log(`   tar -a -c -f QQAgent-release.zip ${excl} -C "${ROOT}" .`);

console.log(FATAL.length ? '\n结论：✗ 不能打包' : '\n结论：✓ 可以打包（记得按上面的排除清单）');
process.exit(FATAL.length ? 1 : 0);
