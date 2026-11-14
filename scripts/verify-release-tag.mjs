#!/usr/bin/env node
// 发版一致性校验（2026-11-14 新增）：打 tag 之前/之后都必须过这一关。
//
// ── 解决什么问题 ─────────────────────────────────────────────────────────
// 客户端的"发现新版本"只有一条路：读 main 分支上的 version.json
//   https://fastly.jsdelivr.net/gh/Mashiroxun/Chat-Agent@main/version.json
// 它**不读 GitHub Release，也不读 tag**。由此产生一个很难自查的故障：
//   · 在特性分支上打了 tag、发了 Release —— 用户端毫无反应；
//   · tag 打了但 version.json 忘了 bump —— 用户端永远显示"已是最新"；
//   · package.json 与 version.json 版本不一致 —— 客户端拿自己的版本
//     去比更新源，判定"我比源还新"，同样不提示。
// 三种情况在 GitHub 页面上看起来都"发布成功了"，只有收包人能证明它没生效。
// 所以把判据前移：这些条件不满足，脚本直接退 1，不许发版。
// release-preflight.mjs 的"版本一致性"只查 ① 本地两个 JSON 对不对得上，
// 查不到"tag 到底在不在 main 上"——本脚本补的正是这一环，两者不重叠。
//
// ── 用法 ─────────────────────────────────────────────────────────────────
//   node scripts/verify-release-tag.mjs                    # 用 HEAD 上的唯一 tag
//   node scripts/verify-release-tag.mjs --tag v0.4.9.5     # 显式指定
//   node scripts/verify-release-tag.mjs --main-ref main    # 本机没 fetch 过 origin/main 时
//   node scripts/verify-release-tag.mjs --print-prev --tag v0.4.9.5
//                                                          # 只打印补丁基线（供 CI 取用）
//   node scripts/verify-release-tag.mjs --allow-unmerged   # 只告警（不推荐）
//     注意：它**只放行"tag 是否并入 main"这一条祖先检查**，不放行第 3.5 节的
//     "main 上的版本是否已推进到本 tag"。后者仍会 FATAL —— main 版本不一致就等于
//     用户收不到更新，那一步的放行票不发给任何人。
// 退出码：0 = 可以发布；1 = 有 FATAL 项。
//
// ── 三条硬约束（改动时不要放宽）────────────────────────────────────────────
//   ① tag 指向的提交必须已在 main 历史里。否则 main 上的 version.json 仍旧版，
//      用户端读到的就是旧版本号 —— 这是"发了版但没人收到更新"的第一大原因。
//   ② 版本的唯一真源是 tag 去掉 v 前缀；package.json 与 version.json 都必须等于它。
//   ③ 版本必须大于上一个 tag。同号重发在客户端语义上是"没有更新"。
//
// ── 2026-11 修订（每条都对应一次真实／可复现的静默失效）──────────────────────
//   · 版本字段缺失独立报 FATAL：以前 `pkgVer && pkgVer !== versionOfTag` 会在字段为空时
//     整条跳过，version.json 写成 "" 或键名写成 "Version" 都能全绿 —— 而客户端把空版本
//     当 0，永不提示更新。与 release-preflight 的口径对齐。
//   · 取不到 main 引用改为 fatal：浅克隆（fetch-depth: 1）或默认分支改名时，这条核心判据
//     以前只 warn，脚本照样输出"可以发布"—— 三条硬约束里最重要的一条被静默跳过。
//   · tag 不存在时短路第 3/4 节：以前会额外报"不在 main 历史里""本次视为首个版本"，
//     两条都与事实相反，把真正原因（tag 不存在）淹掉。
//   · 新增"main 上的版本必须等于 tag 版本"：一天连发两版时，补发旧 tag 仍能通过祖先检查，
//     但用户端已读到更新的版本号 → 点更新 → compareSemver 判"已是最新" → 静默失效。
//   · 基线改成"枚举父提交上可达的版本 tag 并取数值最大"，不再用 git describe：
//     describe --match 是 fnmatch，`*` 会吞掉 `-hotfix`（实测选中 v0.4.9.4-hotfix，
//     manifest.base 直接变成 "0.4.9.4-hotfix"，任何客户端都对不上）；而且 describe
//     取"最近"而非"最高"，backport 场景会选错基线。
//   · 新增 CHANGELOG 条目检查（WARN 级）：CHANGELOG 无任何脚本盯着，实测已漂移 ——
//     0.4.9.4 发版时最新条目仍停在 0.4.9.3，版本说明只活在 version.json 的 notes 里。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');            // resources/app（= git 仓库根）

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const problems = [];
const warns = [];
const fatals = [];
const fatal = (message, hint) => fatals.push({ message, hint });
const warn = (message, hint) => warns.push({ message, hint });
const note = (message) => problems.push(message);

/** git 输出统一 trim；失败抛错由调用方决定怎么处理。 */
function git(...argv) {
  return execFileSync('git', argv, {
    cwd: APP_DIR,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024
  }).trim();
}

function tryGit(...argv) {
  try { return { ok: true, out: git(...argv) }; }
  catch (error) { return { ok: false, out: '', error }; }
}

function readJson(target) {
  try { return JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch { return null; }
}

/** 读某个引用上的文件并解析为 JSON；取不到或不是合法 JSON 时返回 null。 */
function readJsonAt(ref, file) {
  const res = tryGit('show', `${ref}:${file}`);
  if (!res.ok) return null;
  try { return JSON.parse(res.out); }
  catch { return null; }
}

/** 只读文件开头若干字节；用于 436KB 级的 CHANGELOG，不值得整读。 */
function readHeadText(target, bytes) {
  try {
    const fd = fs.openSync(target, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const read = fs.readSync(fd, buf, 0, bytes, 0);
      return buf.toString('utf8', 0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;      // 文件不存在 / 无权限：由调用方决定是否静默跳过
  }
}

// ── 版本号解析：必须与客户端 src/app.js 的 compareSemver 完全同构 ───────────
// 坑（2026-11-14 实测）：本项目版本号是**四段式**（0.4.9.4），而线上 version.json
// 历史上只有三段（0.4.0）。客户端为此把段数改成取 max(len) 逐段比较 —— 本脚本若
// 写死三段，第一件事就是把 v0.4.9.4 判成"非规范 tag"直接拒绝发布。
// 所以这里照搬同一套语义：按 . 切段、逐段 parseInt（非数字按 0）、段数取两侧最大值。
// 校验口径一旦与客户端分裂，"本地全绿、用户收不到"就会重新出现。
function isValidVersion(value) {
  const s = String(value || '').trim();
  return /^v?\d+(?:\.\d+)+$/.test(s);      // 至少两段，且每段都是纯数字
}

function splitVersion(value) {
  return String(value || '').trim().replace(/^v/i, '').split('.')
    .map((x) => parseInt(x, 10) || 0);
}

function cmpSemver(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * 基线相邻性分三档（2026-11-14 修订）：跨段发布（0.4.9.x → 0.4.10.0）时 v0.4.9.3
 * 恰恰就是上一版，其用户能正常吃补丁 —— 报 warn 属误报，而常态误报会稀释其它真警告。
 *   'adjacent' 前缀相同、末段差 1  → 静默
 *   'gap'      前缀相同、末段跳号  → warn（真信号：中间版本可能没打 tag）
 *   'cross'    前缀不同（跨段发布）→ note 一行事实，不占警告位
 * 段数不同的情况（三段 vs 四段）按 0 补齐到等长再比。
 */
function compareBaselineAdjacency(prev, cur) {
  const n = Math.max(prev.length, cur.length);
  const a = [...prev, ...Array(n - prev.length).fill(0)];
  const b = [...cur, ...Array(n - cur.length).fill(0)];
  const samePrefix = a.slice(0, n - 1).every((v, i) => v === b[i]);
  if (!samePrefix) return 'cross';          // 跨段：正常 minor/major 发布
  const gap = b[n - 1] - a[n - 1];
  if (gap === 1) return 'adjacent';
  return 'gap';                             // 同前缀但跳号
}

/**
 * 兼容矩阵里两个 tag 同父提交时也要挑对：枚举所有可达 tag → 只认版本形态 → 取数值最大。
 * 不枚举 describe 的原因见第 4 节的注释（fnmatch 吞 -hotfix、describe 取"最近"而非"最高"）。
 */
function pickPrevVersionTag(commitish) {
  const listed = tryGit('tag', '--list', '--merged', commitish);
  if (!listed.ok || !listed.out) return '';
  let best = '';
  let bestV = null;
  for (const name of listed.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (!isValidVersion(name)) continue;        // baseline / hotfix-x / v0.4.9.4-hotfix 天然出局
    const v = splitVersion(name);
    if (!bestV || cmpSemver(v, bestV) > 0) { best = name; bestV = v; }
  }
  return best;
}

// ── 1. 定位 tag ───────────────────────────────────────────────────────────
// 优先级：--tag 参数 > CI 的 GITHUB_REF_NAME（仅当它真的是 tag）> HEAD 上的唯一 tag。
// CI 在 workflow_dispatch 下 GITHUB_REF_NAME 是分支名，所以必须靠 --tag 覆盖。
let tag = String(argOf('--tag') || '').trim();
if (!tag) {
  const refName = String(process.env.GITHUB_REF_NAME || '').trim();
  const refType = String(process.env.GITHUB_REF_TYPE || '').trim();
  if (refName && refType === 'tag') tag = refName;
}
if (!tag) {
  const exact = tryGit('describe', '--tags', '--exact-match', 'HEAD');
  if (exact.ok) tag = exact.out;
}
if (!tag) {
  fatal('无法确定要校验的 tag：HEAD 上没有唯一 tag，也没传 --tag',
    '在 CI 里用 --tag "$TAG" 显式传入；本机先 git tag v<版本> 再跑');
}

// tagExists 提升为外层布尔：第 3 节（是否已合并）与第 4 节（上一个 tag）都必须
// 先确认 tag 真的存在。否则 rev-parse 失败会被误读成"不在 main 历史里"，
// describe 失败会被误读成"首个版本"，真正的原因（tag 不存在）反而被淹掉。
let tagExists = false;
if (tag) {
  const verified = tryGit('rev-parse', '--verify', `refs/tags/${tag}^{commit}`);
  if (!verified.ok) {
    fatal(`tag ${tag} 不存在（git rev-parse 失败）`, '先 git tag 再 push；不是给已有提交补 tag');
  } else {
    tagExists = true;
    note(`tag            ${tag}`);
    note(`tag 指向提交    ${verified.out.slice(0, 7)}`);
  }
}

// ── --print-prev：把"补丁基线"这一个算法交给本脚本独占 ────────────────────
// 流水线里原先用一段 bash（tag --list + grep + sort -V）重复实现同一件事，两份实现
// 只要有一处判据不同（历史教训：--match 的 fnmatch 与 isValidVersion 不等价），
// verify 报的基线和 make-patch 用的基线就会悄悄分叉。所以这里提供一个只输出基线的模式：
// stdout 只会有「一个 tag 名」或「一个空行」，不夹杂任何其它文字，供 CI 直接取用。
// 用 fs.writeSync 而不是 process.stdout.write：后面紧接 process.exit()，走管道时
// 异步写有概率被截断（与文末 FATAL 输出用 exitCode 的理由相同）。
const printPrevOnly = args.includes('--print-prev');
if (printPrevOnly) {
  if (!tag || !tagExists) {
    fs.writeSync(2, `--print-prev: tag ${tag || '(未指定)'} 不存在或无法确定，拒绝输出基线\n`);
    process.exit(1);
  }
  const prev = pickPrevVersionTag(`refs/tags/${tag}^{commit}^`);
  fs.writeSync(1, `${prev}\n`);      // 无更早版本时就是空行，调用方按"首个版本"处理
  process.exit(0);
}

// ── 2. 版本号三处一致 ────────────────────────────────────────────────────
const versionOfTag = String(tag || '').replace(/^v/i, '').trim();
const semverOk = isValidVersion(versionOfTag);
const semver = semverOk ? splitVersion(versionOfTag) : null;
if (tag && !semverOk) {
  fatal(`tag 名 ${tag} 不是 <主>.<次>.<修订>[.<构建>] 形式（如 v0.4.9.4）`,
    '客户端按点分段做数字比较，非规范 tag 会被判成"没有更新"');
}
// tag 必须带 v 前缀（2026-11-14）：既有 tag 全部是 v 开头，客户端也会剥前缀，
// 但混用会让工具链（tag 枚举 / describe / 人工命令）行为分歧。这里直接钉死，
// 成本为零，省掉下一次"为什么补丁基线是另一个"。
if (tag && !/^v/i.test(tag)) {
  fatal(`tag ${tag} 缺少 v 前缀`, '既有 tag 全部是 v<版本>；统一前缀，否则工具链与人工命令容易走岔');
}

const pkgDoc = readJson(path.join(APP_DIR, 'package.json'));
const verDoc = readJson(path.join(APP_DIR, 'version.json'));
const pkgVer = String(pkgDoc?.version || '').trim();
const verVer = String(verDoc?.version || '').trim();

if (!pkgDoc) fatal('读不到 package.json', '检查文件是否存在、是否为合法 JSON');
if (!verDoc) fatal('读不到 version.json', '它是更新源的唯一载体，必须存在');
// 字段缺失必须独立报 FATAL，而不是靠下面的"版本不等"来判断：
// 以前写成 `pkgVer && pkgVer !== versionOfTag`，字段为空时整条跳过 ——
// version.json 写成 "version": "" 或键名写成 "Version" 都能全绿，
// 而客户端把空版本当 0，永不提示更新。与 release-preflight 的口径对齐。
// （文件本身读不到时已经报过 FATAL，这里不再重复报"缺字段"，避免误导。）
if (pkgDoc && !pkgVer) {
  fatal('package.json 缺少 version 字段', '更新检查靠它比对，必须有');
}
if (verDoc && !verVer) {
  fatal('version.json 缺少 version 字段', '它是更新源唯一载体；空值会让客户端把版本当 0，永不提示更新');
}
// tag 缺失时不再往下比版本：否则 versionOfTag 是空串，会额外冒出两条
// "package.json 版本 ≠ 空版本" 的 FATAL，把真正的原因（没找到 tag）淹掉。
if (tag && pkgVer && pkgVer !== versionOfTag) {
  fatal(`package.json 版本（${pkgVer}）≠ tag 版本（${versionOfTag}）`, '改 package.json 的 version 后重新提交并重打 tag');
}
if (tag && verVer && verVer !== versionOfTag) {
  fatal(`version.json 版本（${verVer}）≠ tag 版本（${versionOfTag}）`,
    'version.json 是用户端唯一读到的版本来源；不同步等于"发了版但用户看不到"');
}
if (pkgVer && verVer && pkgVer === verVer && pkgVer === versionOfTag) {
  note(`版本一致        package.json = version.json = ${versionOfTag}`);
}

// notes 为空只影响更新弹窗的阅读体验，不阻断发布（与 release-preflight 口径一致）。
if (verDoc && !String(verDoc.notes || '').trim()) {
  warn('version.json 的 notes 为空：更新弹窗里没有变更说明', '写上本版摘要，它会直接展示给用户');
}

// CHANGELOG 没有任何脚本盯着，实测已经漂移（0.4.9.4 发版时最新条目仍停在 0.4.9.3），
// 版本说明只活在 version.json 的 notes 里。这里只做 WARN 级提示：
// CHANGELOG 不是发布的硬依赖，缺条目不该拦发布，但也不该悄悄漂下去。
// 只读前 8KB（该文件 436KB）：新版本条目必然在文件顶部，整读纯属浪费。
// 只认**标题行**：正文里写一句"为即将发布的 0.4.9.4 做准备"不该算有本版条目（实测过这种
// false-pass）；末尾用 (?![\d.]) 而不是 \b —— \b 在 "0.4.9.4" 后紧跟中文时会失效，
// 而且 0.4.9.41 也不该被 0.4.9.4 命中。
if (tag && isValidVersion(versionOfTag)) {
  const changelogHead = readHeadText(path.join(APP_DIR, 'CHANGELOG.md'), 8 * 1024);
  const escapedVer = versionOfTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRe = new RegExp(`^#{1,3}\\s+v?${escapedVer}(?![\\d.])`, 'm');
  // 补发旧 tag 时跳过这条检查：CHANGELOG 只读顶部 8KB，而旧版本条目在文件深处
  // （实测 v0.4.9.2 的条目标题在 119KB 处）。搜不到不代表没有 —— 补发场景硬报就是
  // 必然误报，而"必然误报的警告"等于没有警告（本脚本第 3.5 节明确支持补发）。
  const topHeading = changelogHead ? /^#{1,3}\s+v?(\d+(?:\.\d+)+)/m.exec(changelogHead) : null;
  const topVer = topHeading && isValidVersion(topHeading[1]) ? splitVersion(topHeading[1]) : null;
  const isBackfill = Boolean(topVer && semver && cmpSemver(semver, topVer) < 0);
  if (changelogHead && !isBackfill && !headingRe.test(changelogHead)) {
    warn(`CHANGELOG.md 里没有 ${versionOfTag} 的条目（需以 \`## ${versionOfTag}\` 这样的标题行开头）`,
      '补一条，否则版本说明只存在于 version.json 的 notes');
  }
}

// ── 3. tag 是否已在 main 历史里（本脚本的核心）─────────────────────────────
// 这一条查不出来，前面所有一致性检查都会给出"通过"的假象：
// 本地两个 JSON 都对，但用户在 GitHub 上看到的主分支快照仍是旧版本。
const allowUnmerged = args.includes('--allow-unmerged');
const mainRefArg = String(argOf('--main-ref') || '').trim();
const candidates = mainRefArg ? [mainRefArg] : ['origin/main', 'main'];
let mainRef = null;
for (const cand of candidates) {
  if (tryGit('rev-parse', '--verify', `${cand}^{commit}`).ok) { mainRef = cand; break; }
}

if (!mainRef) {
  // 这里以前只 warn，于是脚本在浅克隆（fetch-depth: 1）或默认分支改名时照样输出
  // "可以发布" —— 三条硬约束里最重要的一条被静默跳过，属于 fail-open。
  const message = `取不到 main 分支引用（试过 ${candidates.join(' / ')}），无法校验 tag 是否已合并；浅克隆请用 fetch-depth: 0`;
  const hint = '本机先 git fetch origin main；CI 里 checkout 必须 fetch-depth: 0（补丁基线依赖完整历史）';
  if (allowUnmerged) warn(message, hint);
  else fatal(message, hint);
} else if (tagExists) {
  const isAncestor = tryGit('merge-base', '--is-ancestor', `refs/tags/${tag}^{commit}`, mainRef);
  if (isAncestor.ok) {
    note(`已并入主分支    ${mainRef}`);
  } else {
    const message = `tag ${tag} 指向的提交不在 ${mainRef} 历史里：main 上的 version.json 仍是旧版本，用户端不会提示更新`;
    const hint = '先把该提交合并/推到 main（git push origin HEAD:main 或走 PR），再重新打 tag；已发的 Release 需要删掉重发';
    if (allowUnmerged) warn(message, hint);
    else fatal(message, hint);
  }
}

// ── 3.5 main 上的版本必须就是这个 tag 的版本 ───────────────────────────────
// 只判"tag 提交是 main 的祖先"不够：一天连发两版时，补发旧 tag 仍能通过祖先检查，
// 但用户端已经读到更新的版本号 —— 点"一键更新"时客户端按 version.json 判断
// "我比源还新"，直接显示"已是最新"，而 Release 里挂了旧补丁，静默失效。
// 反过来，main 上的版本尚未推进到本 tag，说明 tag 是在未合并的提交上打的，
// 或者 version.json 忘了推上 main —— 用户同样收不到更新。
if (mainRef && tagExists && semver) {
  const mainVerDoc = readJsonAt(mainRef, 'version.json');
  const mainPkgDoc = readJsonAt(mainRef, 'package.json');
  const mainVer = String(mainVerDoc?.version || '').trim();
  const mainPkgVer = String(mainPkgDoc?.version || '').trim();
  if (!isValidVersion(mainVer) || !isValidVersion(mainPkgVer)) {
    // 读取/解析失败只 warn：可能是 ref 上确实没有这两个文件（历史提交、浅克隆），
    // 不能因此拦死发版流程。
    warn(`读不到 ${mainRef} 上的 version.json / package.json 版本（或格式不合法）：已跳过"main 版本是否已推进"检查`,
      '确认 git show ' + mainRef + ':version.json 能读到内容；浅克隆请用 fetch-depth: 0');
  } else {
    if (mainPkgVer !== mainVer) {
      warn(`${mainRef} 上 package.json（${mainPkgVer}）与 version.json（${mainVer}）不一致`,
        'main 上这两处必须同步，否则用户端读到的版本与本地包不一致');
    }
    const mainDiff = cmpSemver(splitVersion(mainVer), semver);
    if (mainDiff === 0) {
      note(`main 版本一致    ${mainRef}:version.json = ${mainVer}`);
    } else if (mainDiff > 0) {
      fatal(`main 上的版本（${mainVer}）已高于本 tag（${versionOfTag}）：补发旧 tag 会让用户端指向一个没有 Release 的版本`,
        '补发旧版本必须在 main 上把 version.json 回退到该版本（会打断已发的新版），否则请改发新的、递增的版本号');
    } else {
      fatal(`main 上的版本（${mainVer}）尚未推进到本 tag（${versionOfTag}）：tag 未合并或 version.json 未推上 main`,
        '把 bump 过 version.json 的提交推到 main（git push origin HEAD:main 或走 PR）后再打 tag');
    }
  }
}

// ── 4. 必须比上一个 tag 更新 ──────────────────────────────────────────────
// 客户端用 compareSemver 比较，同号或更小都判定"没有更新"，Release 建得再漂亮也无效。
// 基线用"父提交上可达的版本 tag 里最大的那个"，不用 describe（2026-11-14 修订）：
//   ① describe --match 是 fnmatch/wildmatch，`*` 会把 `-hotfix` 一起吞掉 ——
//      实测 `--match 'v[0-9]*'` 与 `--match 'v[0-9]*.[0-9]*'` 都会选中 v0.4.9.4-hotfix。
//      后果是 manifest.base 变成 "0.4.9.4-hotfix"，任何客户端都对不上 → 全员回退全量包；
//      有全量包时无声无息，没有时直接落进"只有补丁"的硬错误窗口。
//   ② describe 取的是"最近"的 tag，而补丁基线要的是"前一个版本"（数值最大），
//      backport / 回移提交上两者会分歧。
let prevTag = tagExists ? pickPrevVersionTag(`refs/tags/${tag}^{commit}^`) : '';
const prevSemver = prevTag && isValidVersion(prevTag) ? splitVersion(prevTag) : null;

// depChanged 决定"能不能发补丁"：补丁包带不了 node_modules，也带不了入口字段变更。
// 提升为外层变量，成功输出分支要用它来避免"必须发全量包"与"补丁基线为 X"自相矛盾。
let depChanged = false;
if (prevTag) {
  if (!prevSemver) {
    // pickPrevVersionTag 已按 isValidVersion 过滤，正常不会走到这里；留着是防御。
    // 文案只描述真正被跳过的东西：被跳过的是"版本序关系"（递增 / 同号 / 倒退），
    // 而依赖变更检查与基线的形态无关，在下面照常执行。
    warn(`上一个 tag（${prevTag}）不是版本形态，版本序关系（递增/同号/倒退）检查已跳过`,
      '基线 tag 必须是 v<主>.<次>.<修订> 形态；请人工确认本版版本号确实大于它');
  } else if (semver) {
    const diff = cmpSemver(semver, prevSemver);
    if (diff === 0) {
      fatal(`版本与上一个 tag（${prevTag}）相同`, '同号重发在客户端语义上是"没有更新"，请 bump 版本');
    } else if (diff < 0) {
      fatal(`版本 ${versionOfTag} 低于上一个 tag（${prevTag}）`, '版本号必须递增，否则用户端会判定更新源落后');
    } else {
      note(`版本递增        ${prevTag} → ${tag}`);
    }
  }
  // 补丁基线相邻性（2026-11-14）：manifest.base 严格等于用户当前版本才可应用，
  // 所以基线一旦漂移（本机 fetch 没拉到上一版 tag、tag 枚举退回到更早的版本），
  // 补丁对这些中间版本的用户全部无效，而"版本递增"检查照样是绿的。
  // 独立于上面的 if/else 链判断 —— 塞进递增分支会被"递增成立"直接吃掉。
  // 三档处理见 compareBaselineAdjacency 的注释：只有"同前缀跳号"才是真信号。
  // 仅在版本确实递增时判（同号/倒退已被上面 FATAL，不需要再来一条噪声）。
  if (semver && prevSemver && cmpSemver(semver, prevSemver) > 0) {
    const adjacency = compareBaselineAdjacency(prevSemver, semver);
    if (adjacency === 'gap') {
      warn(`补丁基线（${prevTag}）与当前版本（${versionOfTag}）同前缀但末段跳号，中间版本可能没打 tag`,
        'manifest.base 只对恰好等于它的安装生效；先 git fetch --tags --force origin 确认本地 tag 齐全，齐全后仍如此才说明中间版本没发过补丁。中间版本用户会自动回退全量包');
    } else if (adjacency === 'cross') {
      // 跨段发布是常态，不该占警告位；但要让维护者看见"这一版补丁覆盖不到多数用户"。
      note(`跨版本段发布    ${prevTag} → ${versionOfTag}（补丁只覆盖 ${prevTag} 用户，其余走全量）`);
    }
  }
  const depDiff = tryGit('diff', '-U0', `${prevTag}..${tag}`, '--', 'package.json');
  if (depDiff.ok && depDiff.out) {
    const depKeys = ['"dependencies"', '"devDependencies"', '"engines"', '"type"', '"main"', '"imports"', '"exports"'];
    const changed = depDiff.out.split(/\r?\n/)
      .filter((line) => /^[+-]/.test(line) && !/^\+\+\+|^---/.test(line));
    const hit = depKeys.filter((key) => changed.some((line) => line.includes(key)));
    if (hit.length) {
      depChanged = true;
      warn(`本版改动了 package.json 的 ${hit.join(' / ')} 字段：必须发全量包，补丁会被 make-patch 拒绝`,
        '这不只是依赖问题：入口 main / 模块类型 type / engines 变了，补丁覆盖过去会让新旧两半对不上；请照常上传 <版本>.zip');
    }
  }
} else if (tagExists) {
  note('上一个 tag       （无，本次视为首个版本：只能发全量包）');
}

// ── 报告 ─────────────────────────────────────────────────────────────────
process.stdout.write('\n发版一致性校验\n');
for (const line of problems) process.stdout.write(`  · ${line}\n`);
if (warns.length) {
  process.stdout.write('\n警告（不阻断发布）\n');
  for (const item of warns) {
    process.stdout.write(`  ! ${item.message}\n`);
    if (item.hint) process.stdout.write(`    → ${item.hint}\n`);
  }
}
if (fatals.length) {
  process.stdout.write('\n不允许发布\n');
  for (const item of fatals) {
    process.stdout.write(`  ✗ ${item.message}\n`);
    if (item.hint) process.stdout.write(`    → ${item.hint}\n`);
  }
  process.stdout.write('\n');
  // 用 exitCode 而不是 process.exit()：stdout 是管道时写入是异步的，
  // 立即 exit 有概率把最后几行（恰恰是 FATAL 原因）截掉，CI 日志里只剩半截。
  process.exitCode = 1;
  // 顶层没有未完成的异步操作（git 全部走 execFileSync），事件循环自然收尾。
} else {
  process.stdout.write('\n可以发布。后续动作：\n');
  process.stdout.write(`  1. git push origin ${tag}   # 触发补丁流水线（.github/workflows/release-patch.yml），产出 draft Release\n`);
  process.stdout.write(`  2. 本机打全量包并上传 Release：${versionOfTag}.zip，再 gh release edit ${tag} --draft=false 发布\n`);
  if (depChanged) {
    // 有依赖/入口字段变动时 make-patch 必然拒绝，先说"补丁基线为 X"会自相矛盾。
    process.stdout.write('  3. 本版需发全量包（补丁不适用）：package.json 的依赖/入口字段有变动，流水线只建 draft Release\n');
  } else if (prevTag && !prevSemver) {
    // 基线 tag 不是版本形态时绝不能播报"补丁基线为 X"：manifest.base 只认纯数字段，
    // 这样的基线会让所有客户端都对不上，补丁通道等于不可用。
    process.stdout.write(`  3. 基线 tag ${prevTag} 不是版本形态，补丁通道不可用：本版请发全量包\n`);
  } else if (prevTag) {
    process.stdout.write(`  3. 补丁基线为 ${prevTag}：只有该版本用户能直接吃补丁，更早的版本走全量\n`);
  }
  process.stdout.write('\n');
}
