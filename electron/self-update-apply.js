// 自更新助手进程（2026-11-12，方案 A+B 的落地执行者）。
//
// ── 运行方式 ─────────────────────────────────────────────────────────────
// 由 src/self-update.js 在更新就绪后以 detached 方式拉起：
//   QQ Agent.exe（ELECTRON_RUN_AS_NODE=1）electron/self-update-apply.js --pid <应用pid>
// 也就是「exe 当 node 用」。它与应用不同进程，因此可以在应用退出之后、
// 没有任何文件锁的环境里完成替换 —— 这是 Windows 上唯一可靠的整包替换时机。
//
// ── 两种模式（读根目录 .update-pending 标记决定）──────────────────────────
//   patch：staging 里有 manifest.json + 相对 resources/app 的文件树。
//          逐文件备份到 .update-old/app/ 再覆盖；deletions 列表里的文件删除。
//          失败时用备份回滚已应用的文件。
//   full ：staging 是整包布局（QQ Agent.exe / resources / …）。
//          根目录里与 staging 冲突的条目先挪进 .update-old/，再把 staging 条目
//          移进根目录。用户数据目录（resources/app/data、plugin-data）若存在于
//          旧目录，会被合并回来（打包布局的数据在根目录 data/，本就不受影响，
//          这里是给开发/特殊布局兜底）。
//
// ── 成功收尾 ─────────────────────────────────────────────────────────────
// 写 .update-result.json → 清掉 .update-pending → 若标记声明 electron 则拉起
// 新 exe。旧的 .update-old 由新进程启动时的 janitor（runJanitor）清理 ——
// 助手自己不能删：full 模式下助手还跑在旧 exe 的镜像上，删不掉它。
//
// 本模块不 import electron，纯 node 可跑可单测；janitor 也从这里导出，
// 由 electron/main.js 在启动早期调用（清理上一次更新的残留）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {
  UPDATE_ARTIFACTS as A, isValidPending,
  isHelperLive, readHelperPid, refreshHelperLock, clearHelperLock
} from '../src/self-update.js';

const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;   // 超过 24h 的待应用标记视为残留
const PID_WAIT_TIMEOUT_MS = 30 * 60 * 1000;       // 应用迟迟不退出（用户改主意），助手最多等 30 分钟
const PID_WAIT_INTERVAL_MS = 500;
// 等 pending 标记落盘的上限。src/self-update.js 现在是「先拉起助手、成功后写标记」
// （B2：spawn 失败必须可感知），助手可能比标记早几毫秒启动 —— 这点窗口不能吃掉。
const PENDING_WAIT_MS = 10 * 1000;
const PENDING_WAIT_INTERVAL_MS = 200;
// 锁心跳周期。为什么要有心跳（2026-11-12 QA 第二轮 P1）：主进程判"助手是否还活着"
// 不能只看 pid —— 助手被强杀后 pid 会被系统复用给无关进程，只看存活就永久锁死更新。
// 心跳给出一条独立证据："这个 pid 的人还在按时打卡"。主进程侧阈值见
// HELPER_LOCK_STALE_MS（10 分钟 = 120 个周期，足够容忍 GC/磁盘卡顿）。
// 5 秒而不是 60 秒：助手可能只活十几秒（用户立刻退出），刷新太慢就白心跳了。
const HELPER_HEARTBEAT_MS = 5 * 1000;

const logLine = (message) => {
  try { console.log(`[self-update-apply] ${message}`); } catch { /* ignore */ }
};

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function rmRf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
}

/** 读待应用标记；不存在/坏 JSON/缺字段都按 null 处理。判定口径与 src/self-update.js 的 isValidPending 一致。 */
export function readPending(rootDir) {
  const file = path.join(rootDir, A.pending);
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isValidPending(obj) ? obj : null;
  } catch { return null; }
}

/**
 * 等 pending 标记出现（最多 PENDING_WAIT_MS）。
 * 存在的理由：父进程改成「先拉起助手、成功后再写标记」之后，助手有极小概率
 * 比标记更早跑到这里。旧代码读到 null 就直接退出 —— 那等于把更新静默丢掉。
 * 真没有标记（正常情况下的误触发）也只是多等 10 秒后退出，不影响正确性。
 */
export async function waitForPendingMarker(rootDir, timeoutMs = PENDING_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = readPending(rootDir);
    if (pending) return pending;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, PENDING_WAIT_INTERVAL_MS));
  }
}


export function clearPending(rootDir) {
  try { fs.rmSync(path.join(rootDir, A.pending), { force: true }); } catch { /* ignore */ }
}

/** 测试/工具用：直接写一份 pending 标记（生产链路是 src/self-update.js 的 writePending）。 */
export function writePendingForTest(rootDir, data) {
  fs.writeFileSync(path.join(rootDir, A.pending), JSON.stringify({ ...data, createdAt: Date.now() }), 'utf8');
}

/** 等 pid 退出（轮询 kill(pid,0)）；超时返回 false。 */
export async function waitForPidExit(pid, timeoutMs = PID_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }   // ESRCH = 已退出
    await new Promise((r) => setTimeout(r, PID_WAIT_INTERVAL_MS));
  }
  return false;
}

/**
 * patch 模式：把 staging 里的文件按 manifest 逐个覆盖到 appDir。
 * 覆盖前先备份原文件到 backupDir；出错时回滚本轮已覆盖的文件后抛出。
 */
export async function applyPatchFromStaging({ staging, appDir, backupDir }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8'));
  const toPosix = (rel) => String(rel).split('/').join(path.sep);
  const applied = [];   // {dest, backedUpTo|null, deleted:true?}
  try {
    for (const rel of manifest.deletions || []) {
      const dest = path.join(appDir, toPosix(rel));
      if (fs.existsSync(dest)) {
        const bak = path.join(backupDir, toPosix(rel));
        fs.mkdirSync(path.dirname(bak), { recursive: true });
        fs.renameSync(dest, bak);
        applied.push({ dest, backedUpTo: bak });
      }
    }
    for (const item of manifest.files || []) {
      const src = path.join(staging, toPosix(item.path));
      const dest = path.join(appDir, toPosix(item.path));
      if (item.sha256) {
        const actual = await sha256File(src);
        if (String(item.sha256).toLowerCase() !== actual) {
          throw new Error(`补丁文件校验失败：${item.path}`);
        }
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      let backedUpTo = null;
      if (fs.existsSync(dest)) {
        backedUpTo = path.join(backupDir, toPosix(item.path));
        fs.mkdirSync(path.dirname(backedUpTo), { recursive: true });
        fs.renameSync(dest, backedUpTo);
      }
      fs.copyFileSync(src, dest);
      applied.push({ dest, backedUpTo });
    }
  } catch (error) {
    // 回滚：有备份的还原备份，没有备份（新建文件）的删掉
    for (const record of applied.reverse()) {
      try {
        if (record.backedUpTo) fs.renameSync(record.backedUpTo, record.dest);
        else fs.rmSync(record.dest, { force: true });
      } catch { /* 回滚本身失败只能记录 */ }
    }
    throw error;
  }
  return { files: (manifest.files || []).length, deletions: (manifest.deletions || []).length, version: manifest.version };
}

/** 递归把 srcDir 里的文件补进 destDir（已存在的不动）。 */
function mergeMissing(srcDir, destDir) {
  let entries = [];
  try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      mergeMissing(src, dest);
    } else if (!fs.existsSync(dest)) {
      try { fs.copyFileSync(src, dest); } catch { /* 尽力而为 */ }
    }
  }
}

/**
 * 纵深防御：无论打包是否失误，staging 里绝不可带用户数据目录（data / plugin-data）。
 * 这些目录在打包布局下位于 resources/app/data（与 release-preflight 的排除口径对齐），
 * 也可能被部署者用 QQ_AGENT_DATA_DIR 重定向到根级。先把它们从 staging 抹掉，
 * 后面 rename 整包时才不会用包的空/默认 data 覆盖用户的运行时数据。
 */
function stripUserDirs(dir) {
  for (const name of ['data', 'plugin-data']) {
    rmRf(path.join(dir, name));
  }
  // 打包布局下数据在 resources/app/ 下；同样剔除，避免随整包 resources 替换进来。
  const appDir = path.join(dir, 'resources', 'app');
  if (fs.existsSync(appDir)) {
    for (const name of ['data', 'plugin-data']) rmRf(path.join(appDir, name));
  }
}

/** 把上一次安装里的用户数据目录整体覆盖回新安装（用户优先，绝不丢失）。 */
function preserveUserDir(backupDir, rootDir, rel) {
  const oldDir = path.join(backupDir, rel);
  if (!fs.existsSync(oldDir)) return;
  const newDir = path.join(rootDir, rel);
  rmRf(newDir);
  fs.mkdirSync(newDir, { recursive: true });
  mergeMissing(oldDir, newDir);   // 此刻 newDir 为空，等价于把用户数据整体复制回来
}

/** full 包必须具备的条目（相对 staging 根）。缺一个就说明包结构不对。 */
export const REQUIRED_FULL_ENTRIES = [
  'QQ Agent.exe',
  'resources/app/package.json',
  'resources/app/electron/main.js'
];

/**
 * full 模式的包结构校验（B8，2026-11-12 审查）。
 *
 * 为什么必须在 rename 之前校验：full 替换是**逐条目挪走旧文件**，一旦开始就没有
 * "撤销"以外的退路。历史事故的形态是"多了/少了一层目录"（比如压缩工具把整包
 * 套进了 `QQ Agent/` 子目录，或者只压了 resources/）—— 那样替换完成后安装根
 * 里没有 exe，用户双击就是一个空文件夹。这里先看清结构，不合格就原地抛错，
 * 一个文件都不动（调用方只清理 staging 之外的东西，见 runAsHelper 的 catch）。
 *
 * @param {string} staging 解压后的整包目录
 * @throws {Error} 结构不完整 / package.json 坏 / 声明的 main 不存在
 */
export function assertFullPackageStructure(staging) {
  const missing = REQUIRED_FULL_ENTRIES.filter((rel) => !fs.existsSync(path.join(staging, ...rel.split('/'))));
  if (missing.length) {
    throw new Error(`更新包结构不完整（缺少 ${missing.join('、')}）：可能是压缩时多了或少了一层目录，`
      + '已中止替换，现有文件未做任何改动');
  }
  const pkgPath = path.join(staging, 'resources', 'app', 'package.json');
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (error) {
    throw new Error(`更新包里的 resources/app/package.json 无法解析（${String(error?.message ?? error)}），已中止替换`);
  }
  const main = String(pkg?.main || '').trim();
  if (!main) {
    throw new Error('更新包的 package.json 没有 main 字段（Electron 起不来），已中止替换');
  }
  if (!fs.existsSync(path.join(staging, 'resources', 'app', ...main.split('/')))) {
    throw new Error(`更新包的 package.json 声明的入口（${main}）在包里不存在，已中止替换`);
  }
  return { main };
}

/**
 * full 模式：staging 是整包布局，逐条目与安装根对位替换。
 * 冲突条目先挪进 .update-old/（rename 同卷即时完成），再移入 staging 条目。
 * 返回 { moved:number, entries:[{name, backedUp}] }；entries 是回滚必需的账本
 * （backedUp:false 的条目是"新版本独有"，回滚时必须删掉，见 rollbackFull）。
 * 出错时由调用方执行回滚。
 *
 * ── 用户数据保护（2026-11-12 复查修订）────────────────────────────────────
 * 数据目录（data / plugin-data）既可能在根级（QQ_AGENT_DATA_DIR 重定向时），
 * 也可能在 resources/app/ 下（默认 ROOT=resources/app）。full 是整包替换，
 * 必须先 stripUserDirs 把包里的数据目录剔掉，再用 preserveUserDir 把旧版本
 * 的用户数据整体覆盖回新安装 —— 否则新包自带的空/默认 data 会把用户数据覆盖掉。
 */
export function applyFullFromStaging({ staging, rootDir, backupDir }) {
  // ⚠️ 结构校验必须在 rmRf(backupDir) **之前**：清掉 .update-old 之后再发现包不对，
  // 连上一次更新的备份都没了（B8）。
  assertFullPackageStructure(staging);
  rmRf(backupDir);
  fs.mkdirSync(backupDir, { recursive: true });
  stripUserDirs(staging);
  const moved = [];
  const entries = fs.readdirSync(staging, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(staging, entry.name);
    const dest = path.join(rootDir, entry.name);
    if (fs.existsSync(dest)) {
      fs.renameSync(dest, path.join(backupDir, entry.name));
      moved.push({ name: entry.name, backedUp: true });
    } else {
      moved.push({ name: entry.name, backedUp: false });
    }
    fs.renameSync(src, dest);
  }
  // 用户数据兜底：根级与 resources/app 级都护（位置取决于部署方式）。
  for (const rel of ['data', 'plugin-data', 'resources/app/data', 'resources/app/plugin-data']) {
    preserveUserDir(backupDir, rootDir, rel);
  }
  return { moved: moved.length, entries: moved };
}

/**
 * full 失败回滚：把 .update-old 里的条目挪回根目录，并删掉"新版本独有"的条目。
 *
 * ⚠️ 为什么必须回收新增条目（A2，2026-11-12 审查）：applyFullFromStaging 会记录
 * `backedUp:false`（旧安装里根本没有这个条目，比如新版本新增的 `locales/` 或
 * 改了名的 `resources/app.asar`）。回滚只还原备份的话，这些新条目会留在安装根里，
 * 和回滚后的旧 exe/resources 混在一起 —— 典型表现是"回滚了但还是起不来"。
 *
 * @param {{rootDir:string, backupDir:string, moved?:Array<{name:string,backedUp:boolean}>}} input
 * @returns {{restored:number, removed:number, complete:boolean}}
 *          complete=false 表示仍有条目没能回滚（要让人知道这是"部分回滚"）
 */
export function rollbackFull({ rootDir, backupDir, moved = [] }) {
  let entries = [];
  let readFailed = false;
  try { entries = fs.readdirSync(backupDir, { withFileTypes: true }); } catch { readFailed = true; }
  let restored = 0;
  let failed = 0;
  for (const entry of entries) {
    const bak = path.join(backupDir, entry.name);
    const dest = path.join(rootDir, entry.name);
    try {
      if (fs.existsSync(dest)) rmRf(dest);
      fs.renameSync(bak, dest);
      restored += 1;
    } catch { failed += 1; }
  }
  // 新增条目：旧安装里没有 → 回滚时必须删掉，否则新文件与旧目录混在一起。
  // "本来就不存在"的条目不算回收成功（P3-3）：旧写法直接把 rmRf 的 true 计进 removed，
  // 于是日志里的"回收 N 个"会虚高（rmRf 对不存在的路径也返回 true），排障时误判。
  let removed = 0;
  for (const record of Array.isArray(moved) ? moved : []) {
    if (!record || record.backedUp !== false || !record.name) continue;
    const target = path.join(rootDir, record.name);
    if (!fs.existsSync(target)) continue;
    if (rmRf(target)) removed += 1;
    else failed += 1;
  }
  return { restored, removed, complete: !readFailed && failed === 0 };
}


function writeResult(rootDir, data) {
  try {
    fs.writeFileSync(path.join(rootDir, A.result), JSON.stringify({ ...data, at: Date.now() }, null, 2), 'utf8');
  } catch { /* ignore */ }
}

/** 启动新应用（仅 electron 打包/开发模式下；headless 由用户手动启动）。 */
function relaunchApp(exe) {
  try {
    // ⚠️ 助手进程自身是以 ELECTRON_RUN_AS_NODE=1 跑的（exe 当 node 用），spawn 的
    // 默认 env 会把这个变量原样继承下去 —— 新 exe 一启动就会以纯 node 模式运行，
    // GUI 应用根本起不来（2026-11-12 复查发现的致命 bug）。必须显式清掉再拉起。
    // 其余环境变量（QQ_AGENT_PROFILE / QQ_AGENT_DATA_DIR 等）原样保留：
    // 多实例场景下更新重启后必须还落在原来的 profile 上。
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe), env, windowsHide: false });
    child.unref();
    return true;
  } catch (error) {
    logLine(`拉起新版本失败（${String(error?.message ?? error)}），请手动启动`);
    return false;
  }
}

/**
 * 助手进程主入口：等应用退出 → 应用更新 → 重启 → 清标记 → 退出。
 * @param {string[]} [argv]      命令行参数（默认 process.argv；测试可传）
 * @param {{pendingWaitMs?:number, heartbeatMs?:number}} [opts] 只给测试用：
 *        pendingWaitMs 默认 10s（等 pending 落盘），heartbeatMs 默认 5s（锁心跳周期）。
 */
export async function runAsHelper(argv = process.argv, opts = {}) {
  const pidIdx = argv.indexOf('--pid');
  const pid = pidIdx >= 0 ? Number(argv[pidIdx + 1]) : null;
  // 安装根由调用方显式传入（self-update.js spawnHelper）。路径推断不可靠：
  // 打包布局 appDir=<root>/resources/app，脚本在 electron/ 下，倒推层数随布局漂移。
  const rootIdx = argv.indexOf('--root');
  const rootDir = rootIdx >= 0 ? argv[rootIdx + 1] : '';
  if (!rootDir || !fs.existsSync(rootDir)) {
    logLine('缺少有效的 --root 参数，退出');
    return 1;
  }

  // 防御性单实例检查（P2-1，2026-11-12 QA 回归）：锁里是**另一个仍存活**的助手 →
  // 立刻退出，绝不重复执行替换。正常情况下父进程已经拦住了，这里是"父进程被绕过 /
  // 手动重复拉起 / 锁文件被人为改写"时的最后一道闸。注意：这里不能动别人的锁。
  // "存活"必须用 isHelperLive（pid+心跳+镜像），与主进程同一口径 —— 两边各判各的
  // 正是上一轮事故的形态。
  const lockedPid = readHelperPid(rootDir);
  if (lockedPid && lockedPid !== process.pid && isHelperLive(rootDir)) {
    logLine(`已有另一个更新助手在运行（pid=${lockedPid}），本次退出以避免重复替换`);
    return 1;
  }

  // 锁心跳（2026-11-12 QA 第二轮 P1）：从进入等待到替换完成、直到进程退出，
  // 全程每 5 秒把锁里的 at 推进一次。三段时间（等 pending / 等应用退出 / 真正替换）
  // 都覆盖到，所以挂在 applyOnce 外层而不是里面某一段。
  // unref：这个定时器只是"给别的进程看的信号"，不该拖住退出流程。
  const heartbeat = setInterval(() => {
    refreshHelperLock(rootDir, process.pid);
  }, opts.heartbeatMs ?? HELPER_HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    return await applyOnce({ rootDir, pid, pendingWaitMs: opts.pendingWaitMs });
  } finally {
    // 三条出口（成功 / 失败 / 等 pid 超时）都必须停心跳并放锁，否则应用会永远被判
    // "助手还在"（直到 10 分钟心跳过期才自愈）。
    clearInterval(heartbeat);
    if (clearHelperLock(rootDir, process.pid)) logLine('已释放更新助手锁');
  }
}

/**
 * 真正干活的这一段（从等 pending 到拉起新版本）。单独拆出来是为了让 runAsHelper
 * 能用 try/finally 统一放锁 —— 里面有 3 个 return 出口，逐个补 clearHelperLock 太容易漏。
 * @param {{rootDir:string, pid:number|null, pendingWaitMs?:number}} opts
 */
async function applyOnce({ rootDir, pid, pendingWaitMs }) {
  const pending = await waitForPendingMarker(rootDir, pendingWaitMs ?? PENDING_WAIT_MS);
  if (!pending) {
    logLine('没有有效的 .update-pending 标记，退出');
    return 1;
  }
  logLine(`待应用更新 type=${pending.type} → v${pending.targetVersion || '?'}`);

  if (pid && Number.isFinite(pid)) {
    logLine(`等待应用进程（pid=${pid}）退出…`);
    const exited = await waitForPidExit(pid);
    if (!exited) {
      writeResult(rootDir, { ok: false, type: pending.type, error: '应用进程 30 分钟未退出，助手放弃（标记已清理，可重新发起更新）' });
      clearPending(rootDir);
      return 1;
    }
  }

  const backupDir = path.join(rootDir, A.old);
  // 回滚账本：full 替换过程中"新版本独有"的条目记在这里（backedUp:false），
  // 回滚时必须删掉它们（A2）。替换本身失败时这里可能是空的 —— 那样就只还原备份。
  let fullEntries = [];
  try {
    if (pending.type === 'patch') {
      const summary = await applyPatchFromStaging({
        staging: pending.staging,
        appDir: pending.appDir,
        backupDir: path.join(backupDir, 'app')
      });
      writeResult(rootDir, { ok: true, type: 'patch', ...summary, message: `补丁已应用（${summary.files} 个文件）` });
    } else {
      const summary = applyFullFromStaging({ staging: pending.staging, rootDir, backupDir });
      fullEntries = summary.entries || [];
      writeResult(rootDir, { ok: true, type: 'full', moved: summary.moved, message: `全量替换完成（${summary.moved} 个条目）` });
    }
    logLine('更新应用完成');
  } catch (error) {
    logLine(`应用失败：${String(error?.message ?? error)}`);
    // full 失败尝试回滚；patch 的回滚在 applyPatchFromStaging 内部已完成
    if (pending.type === 'full') {
      const rb = rollbackFull({ rootDir, backupDir, moved: fullEntries });
      // rolledBackPartial=true：仍有条目没回滚成功，安装目录可能处在"半旧半新"。
      // janitor（A1）据此保留 .update-old 备份，绝不按"成功清理"处理。
      writeResult(rootDir, {
        ok: false,
        type: 'full',
        error: String(error?.message ?? error),
        rolledBack: rb.restored,
        rolledBackRemoved: rb.removed,
        rolledBackPartial: !rb.complete
      });
      logLine(`已回滚 ${rb.restored} 个条目、回收 ${rb.removed} 个新增条目${rb.complete ? '' : '（部分回滚：仍有条目未能还原，备份保留在 .update-old）'}`);
    } else {
      writeResult(rootDir, { ok: false, type: 'patch', error: String(error?.message ?? error) });
    }
    rmRf(pending.staging);
    clearPending(rootDir);
    if (pending.electron && pending.exe && fs.existsSync(pending.exe)) relaunchApp(pending.exe);
    return 1;
  }

  rmRf(pending.staging);
  clearPending(rootDir);
  if (pending.electron && pending.exe && fs.existsSync(pending.exe)) {
    relaunchApp(pending.exe);
  } else {
    logLine('非 electron 环境：请手动启动应用完成更新');
  }
  return 0;
}

/**
 * 判定结果文件里的「部分回滚」标记。
 *
 * 为什么不能只写 `=== true`（P3-3，2026-11-12 QA 回归）：结果文件是**跨版本契约**，
 * 可能被手改、也可能由别的程序写入 `"true"` / `1`。旧写法只认布尔 true，于是
 * `rolledBackPartial: "true"` 会被当成"上次更新成功"→ janitor 把 .update-old 删掉，
 * 而实际处于半回滚状态 —— 这是"删掉唯一能救回安装目录的东西"，方向必须反过来：
 * 认出任何"看起来是 true"的写法都按部分回滚处理。
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isRolledBackPartial(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    return s === 'true' || s === '1';
  }
  return false;
}

/**
 * janitor：应用启动早期调用（electron/main.js）。清理上一次更新留下的残骸，
 * 并把上次的应用结果回给调用方（main.js 落日志）。
 * 只做同步、尽力而为的操作，绝不让它阻塞或搞崩启动链。
 */
export function runJanitor(rootDir, log = logLine) {
  const summary = { result: null, cleanedOld: false, clearedStalePending: false, keptOld: false, clearedHelperLock: false };
  // 1) 上次更新的结果：读出来给日志，然后删掉
  const resultFile = path.join(rootDir, A.result);
  try {
    if (fs.existsSync(resultFile)) {
      summary.result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      fs.rmSync(resultFile, { force: true });
    }
  } catch { /* 坏文件直接删 */ try { fs.rmSync(resultFile, { force: true }); } catch { /* ignore */ } }
  // 2) 旧版本备份（助手跑在旧镜像上删不掉，只能由新进程收尾）
  //
  // ⚠️ 只有**确认上次更新成功**才删（A1，2026-11-12 审查）。旧实现无条件 rmRf：
  //    更新失败 → 回滚了一部分 / 助手还没写完结果文件就崩了 → 新进程一启动
  //    就把唯一的一份旧文件备份删掉，事故现场直接销毁，用户再也回不去。
  //    读不出结果（没有文件/坏 JSON）同样按"未成功"处理 —— 保留成本只是占盘，
  //    删错的成本是安装目录再也修不回来。
  const oldDir = path.join(rootDir, A.old);
  // 部分回滚（任何"看起来是 true"的写法）一律按未成功处理（P3-3）。
  const partial = isRolledBackPartial(summary.result?.rolledBackPartial);
  const updateSucceeded = summary.result?.ok === true && !partial;
  try {
    if (fs.existsSync(oldDir)) {
      if (updateSucceeded) {
        summary.cleanedOld = rmRf(oldDir);
      } else {
        summary.keptOld = true;
        log('上次更新未成功（或没有可信的结果记录），保留 .update-old 备份待人工处理；'
          + '确认新版本可用后可手动删除该目录');
      }
    }
  } catch { /* ignore */ }
  // 3) 超龄的待应用标记（助手挂了/超时放弃以外的残留）：清掉，避免永远挡住新更新
  try {
    const pendingFile = path.join(rootDir, A.pending);
    if (fs.existsSync(pendingFile)) {
      const stat = fs.statSync(pendingFile);
      if (Date.now() - stat.mtimeMs > PENDING_MAX_AGE_MS) {
        rmRf(path.join(rootDir, A.staging));
        fs.rmSync(pendingFile, { force: true });
        summary.clearedStalePending = true;
      }
    }
  } catch { /* ignore */ }
  // 4) 陈旧助手锁（配合 P2-1）：锁不再代表一个活着的助手 → 清掉。
  //    这里必须用 isHelperLive（pid + 心跳 + 镜像名），**不是** isPidAlive：助手被强杀后
  //    pid 会被系统复用给无关进程，只看存活就永远清不掉（2026-11-12 QA 第二轮 P1）。
  //    活着的助手绝不动（上一个助手可能还在等旧 pid 退出）。
  try {
    const lockPid = readHelperPid(rootDir);
    if (lockPid && !isHelperLive(rootDir)) {
      summary.clearedHelperLock = clearHelperLock(rootDir, lockPid);
    }
  } catch { /* ignore */ }
  if (summary.result) {
    const r = summary.result;
    // P3-2：ok:true 且 rolledBackPartial:true 时，上面已经打过「保留 .update-old 备份」，
    // 这里不能再打「上次更新成功」—— 两句话自相矛盾，排障的人会以为是两个不同事件。
    const success = r.ok === true && !partial;
    const line = success
      ? `上次更新成功：${r.type} → v${r.version || r.message || ''}（${r.message || ''}）`
      : `上次更新失败：${r.error || '未知原因'}${r.rolledBack ? `（已回滚 ${r.rolledBack} 项）` : ''}`
        + `${partial ? '（部分回滚：仍有条目未还原，.update-old 已保留）' : ''}`;
    log(line);
  }
  return summary;
}

// 直接被当作脚本运行（ELECTRON_RUN_AS_NODE=1 exe self-update-apply.js --pid N）时执行。
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  runAsHelper().then((code) => process.exit(code)).catch((error) => {
    logLine(`助手异常退出：${String(error?.stack || error)}`);
    process.exit(1);
  });
}
