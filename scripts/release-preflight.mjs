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
  { name: '使用说明-排障.txt', desc: '排障笔记，非发布内容' },
  // 改代码前的整目录备份（含 QQ Agent.exe.orig 等）。2026-11-12 实测每个包
  // 白带 180MB —— 发布包里塞一份旧版 exe，既浪费体积又可能被当成可用程序。
  { name: 'backup', desc: '旧的整目录备份（含 .orig 旧 exe），不进发布包' },
  // 自更新（2026-11-12，P3-6）的残留物。它们**正好都在安装根**：用户机器上跑过一次
  // 应用内更新之后再来打包，就会把旧 exe（.update-old）或半套 147MB 的新包
  // （.update-staging / .update-download）静默压进发布包 —— 体积翻倍，而且
  // .update-old 里是上一版的 exe，收包人拿到手可能误以为那是可用的程序。
  { name: '.update-old', desc: '自更新替换时挪开的旧文件（含旧 exe），不是发布内容' },
  { name: '.update-staging', desc: '自更新解压出的新版本文件（可能半套），不是发布内容' },
  { name: '.update-download', desc: '自更新下载中的 zip（可能上百 MB），不是发布内容' },
  { name: '.update-pending', desc: '自更新待应用标记，发布包里绝不能带' },
  { name: '.update-result.json', desc: '自更新应用结果（含本机路径），发布包里绝不能带' },
  { name: '.update-helper.lock', desc: '自更新助手进程锁（本机 pid），发布包里绝不能带' }
];

/** app 目录内不进包的东西（同样是"本机存在正常、但会污染分发"）。 */
const APP_MUST_EXCLUDE = [
  { name: '.workbuddy', desc: '本项目的智能体工作目录（含对话与记忆）' },
  // ⚠️ 数据实际位置：config.js 的 ROOT = resources/app，故 DATA_DIR = resources/app/data。
  // 这里必须把 resources/app/data 排除，否则打包会把本机 API Key / 会话 / 记忆 /
  // 聊天记录 / config.json 一起塞进分发包（既泄露又污染收包人的数据）。
  // （根级 data 的检查见 ROOT_MUST_EXCLUDE：仅当用 QQ_AGENT_DATA_DIR 把数据重定向
  //  到安装根时才命中；默认布局下数据在 resources/app/data，根级没有 data。）
  { name: 'data', desc: '运行时数据（API Key / 会话 / 记忆 / 聊天记录 / 配置）；实际位于 resources/app/data' },
  { name: 'plugin-data', desc: '插件运行时数据' },
  // docs/ 是版本历史 / 验证报告 / 架构分析这类内部资料（1.8MB）。
  // 不进包：既是体积浪费，里面的分析文档还带本机绝对路径。
  // 注意与 doc/（单数，面向插件开发者的接口文档）区分，后者仍随包分发。
  { name: 'docs', desc: '开发内部资料（历史/验证/分析），不对外分发' },
  // make-patch.mjs 的输出目录（patch zip / staging）：发布资产单独上传，不进全量包
  { name: 'dist', desc: '补丁包产物目录（scripts/make-patch.mjs 输出）' }
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
  'resources/app/builtin-modules.json',
  // 运行时依赖的第三方包（2026-11-12 补）：这三个是**分发包起不来的确定性根因** ——
  // 打包命令漏带 node_modules 里的任何一个，收包人双击就是 ENOENT / MODULE_NOT_FOUND，
  // 而这一层错误在主进程起来之前就发生，连日志都没有。
  //   js-yaml  → 配置/前端数据解析
  //   undici   → 运行时 HTTP（fetch 的 Node 实现）
  //   ws       → 控制台/协议端的 WebSocket
  'resources/app/node_modules/js-yaml',
  'resources/app/node_modules/undici',
  'resources/app/node_modules/ws'
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
  if (is(/\.orig$/i)) add('EXCLUDE', name, '备份文件（.orig：patch/替换前的原件）', '打包时排除，或确认无用后删除');
  if (is(/\.rej$/i)) add('EXCLUDE', name, 'patch 冲突残留（.rej）', '打包时排除');
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
// ui 也是整目录进包的前端资源 —— 曾经漏扫，两个 580KB 的 style.css.bak-* 一直
// 躺在那里没人报，白占 1.16MB 分发包体积，还可能被误认为有效样式表。
walkForBackups(path.join(APP_DIR, 'ui'));

// ── 3. 必需文件 ────────────────────────────────────────────────────────────
for (const rel of REQUIRED) {
  if (!fs.existsSync(path.join(ROOT, rel))) add('FATAL', rel, '缺少必需文件，打出来的包跑不起来', '确认打包源完整');
}

// ── 4. 敏感内容扫描（只看会被打进包的文本源码）──────────────────────────────
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md', '.txt', '.yml', '.yaml']);
// 注意 'docs' 是复数：原先只写了 'doc'（插件开发文档），docs/ 那 1.8MB
// 历史与验证资料一直在被全量扫描，还报出一堆本机路径噪音。
const SCAN_SKIP_DIRS = new Set(['node_modules', 'data', '.workbuddy', 'plugin-data', '.git', 'doc', 'docs']);
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

// ── 5. 版本一致性（反馈第 11 条）────────────────────────────────────────────
// 症状：日志里反复出现"更新源版本落后于当前安装"，用户永远收不到新版本提示。
// 成因有两类，脚本只能查第一类；第二类必须靠发版动作保证（见文末提醒）：
//   ① 本地漏改：package.json 与 version.json 不一致 / notes 为空 / 更新日志没条目
//   ② 远程 CDN 缓存：更新源走 jsDelivr 的 @main，实测约 12 小时才刷新
function readJsonSafe(target) {
  try { return JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch (error) {
    add('FATAL', target, `读不到或不是合法 JSON：${error?.message || error}`, '检查文件是否存在、编码是否为 UTF-8');
    return null;
  }
}

const pkgDoc = readJsonSafe(path.join(APP_DIR, 'package.json'));
const verDoc = readJsonSafe(path.join(APP_DIR, 'version.json'));
const pkgVer = String(pkgDoc?.version || '').trim();
const verVer = String(verDoc?.version || '').trim();
if (pkgDoc && !pkgVer) add('FATAL', 'resources/app/package.json', '缺少 version 字段', '更新检查靠它比对，必须有');
if (verDoc && !verVer) add('FATAL', 'resources/app/version.json', '缺少 version 字段', '更新检查靠它比对，必须有');
if (pkgVer && verVer && pkgVer !== verVer) {
  add('FATAL', 'resources/app/version.json',
    `版本号与 package.json 不一致（${verVer} ≠ ${pkgVer}）`,
    '两者必须同时改；否则客户端会一直以为自己比更新源新，不再提示升级');
}
if (verDoc && !String(verDoc.notes || '').trim()) {
  add('WARN', 'resources/app/version.json', 'notes 为空：更新弹窗里没有变更说明', '写上本版摘要（会直接展示给用户）');
}
if (pkgVer) {
  try {
    const chrome = fs.readFileSync(path.join(APP_DIR, 'ui/app/14-chrome.js'), 'utf8');
    if (!chrome.includes(`version: '${pkgVer}'`) && !chrome.includes(`version: "${pkgVer}"`)) {
      add('WARN', 'resources/app/ui/app/14-chrome.js',
        `首页更新日志里没有 ${pkgVer} 的条目`, '补一条 STAGE_CHANGELOG，否则用户看不到本版改了什么');
    }
  } catch { /* 文件缺失已由 REQUIRED 覆盖 */ }
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

if (pkgVer) {
  // 这条不是代码能"检查"出来的：远程 version.json 真的落后，本地也看不出来。
  // 只能把动作写在发版流程里，否则用户端会一直读 CDN 上的旧文件（反馈第 11 条）。
  console.log(`\n提醒：更新源走 jsDelivr 的 @main，实测约 12 小时才刷新。发版（${pkgVer}）后请：`);
  console.log(`   curl "https://purge.jsdelivr.net/gh/<owner>/<repo>@main/version.json"`);
  console.log('   或把引用改成 @v' + pkgVer + ' 这类 tag —— 否则用户端仍会读到旧 version.json。');
}
console.log(FATAL.length ? '\n结论：✗ 不能打包' : '\n结论：✓ 可以打包（记得按上面的排除清单）');
process.exit(FATAL.length ? 1 : 0);
