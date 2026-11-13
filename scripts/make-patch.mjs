#!/usr/bin/env node
// 补丁包生成（方案 B，2026-11-12）：日常小修复不再让用户下几十 MB 全量包重装。
//
// ── 做什么 ────────────────────────────────────────────────────────────────
// 对比「基线 tag（默认最后一个版本 tag）..HEAD」之间变化的**分发内容**，
// 打成几百 KB 的 patch-<版本>.zip + manifest.json（文件清单 + 每文件 sha256），
// 与全量包一起传到 GitHub Release assets 即可。客户端（src/self-update.js）
// 会优先尝试补丁：manifest.base === 用户当前版本时直接应用，秒下秒装；
// 基线不符自动回退全量包，所以漏发/多发补丁都不会把用户卡死。
//
// ── 约定（客户端按这个名字找资产，改了要两边同步）──────────────────────────
//   全量：<版本>.zip                （如 0.4.9.4.zip —— 与现有发布习惯一致）
//   补丁：patch-<版本>.zip          （如 patch-0.4.9.4.zip）
//   两者均可带同名 .sha256 兄弟资产（GitHub digest 字段缺失时的校验来源）。
//
// ── 用法（在 app 目录，即 git 仓库根）────────────────────────────────────
//   node scripts/make-patch.mjs                  # 基线 = 最后一个 tag
//   node scripts/make-patch.mjs --from v0.4.9.3  # 显式指定基线
//   node scripts/make-patch.mjs --out ../dist    # 指定输出目录（默认 dist/）
//   node scripts/make-patch.mjs --force          # 工作区有未提交改动时也继续（不推荐）
//
// 退出码：0 = 成功；1 = 有致命问题（工作区不干净 / 依赖变更等，应发全量包）。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');            // resources/app（= git 仓库根）
const OUT_DEFAULT = path.join(APP_DIR, 'dist');

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const FROM = argOf('--from');
const OUT_DIR = path.resolve(argOf('--out') || OUT_DEFAULT);
const FORCE = args.includes('--force');

// 不进补丁的目录（与 release-preflight 的排除口径一致：这些内容不属于分发代码，
// 或属于运行时数据 —— patch 的 manifest 校验也会拒绝触碰 data/ 与 plugin-data/）
const EXCLUDE_TOP = new Set([
  'data', 'plugin-data', 'node_modules', 'docs', 'dist', '.workbuddy', '.git'
]);

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function git(...args_) {
  const { stdout } = await execFileP('git', args_, { cwd: APP_DIR, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// ── 1. 基线 tag ────────────────────────────────────────────────────────────
let base = FROM;
if (!base) {
  try {
    const out = await git('describe', '--tags', '--abbrev=0');
    base = out.trim();
  } catch {
    die('找不到任何 git tag 作为基线（仓库还没有发过版）；用 --from <tag> 显式指定');
  }
}
try {
  await git('rev-parse', '--verify', `${base}^{commit}`);
} catch {
  die(`基线 ${base} 不存在（git rev-parse 失败）`);
}

// ── 2. 变更清单 ────────────────────────────────────────────────────────────
//
// ⚠️ 先检查工作区是否干净（E2，2026-11-12 审查）。变更清单只来自
// `git diff base..HEAD`，**未提交的改动不会出现在补丁里** —— 打包结果是
// "看起来成功、装上却什么都没变"，最坏情况是补丁只带了一半改动，装上直接起不来。
// 这个功能本身就是未提交状态（新增文件全是 ??）时最容易踩，所以默认拦下来。
if (!FORCE) {
  const statusOut = await git('status', '--porcelain');
  const dirty = statusOut.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (dirty.length) {
    console.error(`✗ 工作区有 ${dirty.length} 个未提交改动 —— 补丁的变更清单只取 ${FROM || '基线tag'}..HEAD，`);
    console.error('  未提交的文件会被静默漏掉（补丁装上等于没改）。先 git commit，或加 --force 跳过本检查。');
    for (const line of dirty.slice(0, 10)) console.error(`    ${line}`);
    if (dirty.length > 10) console.error(`    … 还有 ${dirty.length - 10} 个`);
    process.exit(1);
  }
}

const [changedOut, deletedOut] = await Promise.all([
  git('diff', '--name-only', '--diff-filter=ACMRT', `${base}..HEAD`),
  git('diff', '--name-only', '--diff-filter=D', `${base}..HEAD`)
]);
const toPosixList = (text) => text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const changed = toPosixList(changedOut);
const deleted = toPosixList(deletedOut);

// 排除非分发内容；git 输出一定是 POSIX 相对路径
const inDistribution = (rel) => {
  const top = rel.split('/')[0];
  if (EXCLUDE_TOP.has(top)) return false;
  return !rel.startsWith('.');
};
const patchFiles = changed.filter(inDistribution);
const patchDeletions = deleted.filter(inDistribution);
const skipped = [...changed, ...deleted].filter((rel) => !inDistribution(rel));

// ── 3. 依赖/入口变更检查：补丁包带不了 node_modules ─────────────────────────
// package.json 的 version 字段变化是发版的正常动作（必须进补丁，客户端靠它
// 判定"已更新"）；但 dependencies / engines / type / main 变了就无解 ——
// 新代码 import 新依赖而用户机器上没有，装上补丁 = 直接起不来。
// 用 -U0 只看真正增删的行：默认上下文里出现这些键名会造成误报（2026-11-12
// 实测：v0.4.9.2..HEAD 的 engines/type/main 行只是 context，被整段 diff 命中）。
const pkgDiff = await git('diff', '-U0', `${base}..HEAD`, '--', 'package.json');
const depKeys = ['"dependencies"', '"devDependencies"', '"engines"', '"type"', '"main"', '"imports"', '"exports"'];
const changedLines = pkgDiff.split(/\r?\n/)
  .filter((line) => /^[+-]/.test(line) && !/^\+\+\+|^---/.test(line));
const depChanged = depKeys.filter((key) => changedLines.some((line) => line.includes(key)));
if (depChanged.length) {
  console.error(`✗ package.json 的 ${depChanged.join(' / ')} 在 ${base}..HEAD 之间有变化 ——`);
  console.error('  补丁包无法带 node_modules，依赖变更必须发全量包。');
  console.error('  若只是 version 号变了（depKeys 误报），可把依赖变更挪到下一次全量发布。');
  process.exit(1);
}

if (!patchFiles.length && !patchDeletions.length) {
  console.log(`基线 ${base}..HEAD 之间没有分发内容的变化，无需补丁。`);
  process.exit(0);
}

// ── 4. 版本号：补丁的 version 取自 HEAD 的 package.json ────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
if (!version) die('package.json 缺少 version 字段');
if (version === String(base).replace(/^v/i, '')) {
  console.error(`✗ HEAD 的 version（${version}）与基线 tag（${base}）相同 —— 客户端永远不会提示这个"更新"。`);
  console.error('  先 bump version（package.json + version.json 同步改）再打补丁。');
  process.exit(1);
}

// ── 5. 组装 staging ────────────────────────────────────────────────────────
const staging = path.join(OUT_DIR, 'patch-staging');
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

for (const rel of patchFiles) {
  const src = path.join(APP_DIR, ...rel.split('/'));
  if (!fs.existsSync(src)) die(`变更文件在磁盘上不存在：${rel}（工作区未提交？先 commit）`);
  const dest = path.join(staging, ...rel.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// manifest：文件清单 + 每文件 sha256（客户端逐文件校验后才允许覆盖）
const { createHash } = await import('node:crypto');
const manifest = {
  type: 'patch',
  version,
  base: String(base).replace(/^v/i, ''),
  createdAt: new Date().toISOString(),
  files: patchFiles.map((rel) => {
    const abs = path.join(staging, ...rel.split('/'));
    const buf = fs.readFileSync(abs);
    return { path: rel, sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length };
  }),
  deletions: patchDeletions
};
fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

// ── 6. 打 zip（系统 tar，与 release-preflight 建议的打包方式同源）───────────
// Windows 上显式用 System32 的 bsdtar：PATH 里混着 Git Bash 的 GNU tar 时，
// GNU tar 既不支持 zip 也不认 C:\ 路径（"Cannot connect to C:"，2026-11-12 实测）。
function resolveTarBinary() {
  if (process.platform === 'win32') {
    const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sysTar)) return sysTar;
  }
  return 'tar';
}
const zipName = `patch-${version}.zip`;
const zipPath = path.join(OUT_DIR, zipName);
fs.rmSync(zipPath, { force: true });
await execFileP(resolveTarBinary(), ['-a', '-c', '-f', zipPath, '-C', staging, '.'], { windowsHide: true });

// ── 7. 校验和（GitHub digest 字段缺失时的兜底校验来源）──────────────────────
const zipBuf = fs.readFileSync(zipPath);
const zipSha = createHash('sha256').update(zipBuf).digest('hex');
fs.writeFileSync(`${zipPath}.sha256`, `${zipSha}  ${zipName}\n`, 'utf8');

// ── 报告 ───────────────────────────────────────────────────────────────────
console.log(`补丁包已生成：${zipPath}`);
console.log(`  大小 ${(zipBuf.length / 1024).toFixed(1)}KB，sha256 ${zipSha.slice(0, 16)}…`);
console.log(`  基线 ${base} → ${version}；${patchFiles.length} 个文件变更，${patchDeletions.length} 个删除`);
for (const rel of patchFiles) console.log(`    + ${rel}`);
for (const rel of patchDeletions) console.log(`    - ${rel}`);
if (skipped.length) {
  console.log(`  已跳过（非分发内容）${skipped.length} 个：${skipped.slice(0, 8).join('、')}${skipped.length > 8 ? ' …' : ''}`);
}
console.log('\n发版动作清单：');
console.log(`  1. 把 ${zipName} 与 ${zipName}.sha256 上传到 GitHub Release（tag v${version}）assets`);
console.log(`  2. 全量包 ${version}.zip 照旧上传（补丁 base 不符的用户自动回退到它）`);
console.log(`  3. 推 version.json 到仓库（更新源），必要时 purge jsDelivr 缓存`);
