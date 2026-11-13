// 应用内自更新服务（2026-11-12，方案 A+B）。
//
// ── 解决什么问题 ─────────────────────────────────────────────────────────
// 原来 /api/update-check 只给一个「去下载」链接，用户要去 GitHub 手动下几十 MB
// 的 zip、解压、重装。而日常小修复改的几乎全是 resources/app 里的 JS ——
// 全量包里 95% 是根本没变的 Electron 运行时。
//
// ── 两条更新通道 ─────────────────────────────────────────────────────────
//   patch（方案 B）：release 资产里的 patch-<版本>.zip（scripts/make-patch.mjs 生成），
//     只含两次发布之间变化的文件 + manifest.json（清单 + 每文件 sha256），
//     几百 KB，秒下秒校验。仅当 manifest.base === 当前安装版本时可用。
//   full（方案 A）：全量 <版本>.zip（整包布局，含 exe/resources），patch 不存在
//     或 base 不匹配时回退到它。改动集中但下载量大，走同一套流程。
//
// ── 为什么「下载时不替换、重启后由助手进程替换」────────────────────────────
// 应用正在运行时，exe 与已加载的 dll 在 Windows 上不可覆盖（共享冲突），
// 热替换必然半途而废。所以这里只做：下载 → 校验 → 解压到 staging → 写
// .update-pending 标记 → 拉起助手进程（electron/self-update-apply.js，以
// ELECTRON_RUN_AS_NODE=1 跑，纯 node）。助手等本进程退出后执行替换，再拉起
// 新版。替换全程发生在进程之外，没有文件锁问题；失败可整体回滚。
//
// ── 安全边界 ─────────────────────────────────────────────────────────────
//   · zip 只解到 staging，随后逐项校验路径不得逃出 staging（防 zip-slip）；
//   · patch 的 manifest 路径逐条校验：相对路径、无 ..、绝不触碰 data/ 与
//     plugin-data/（用户数据永不进补丁）；
//   · zip 包整体 sha256 校验（GitHub asset digest 字段 / 同名 .sha256 资产）；
//     **两者都拿不到就拒绝更新**（不再"告警后放行"）；
//   · 下载有停滞检测（60 秒无新字节即中止）与最多 2 次重试，续传留作后续；
//   · 每个补丁文件在覆盖前先备份到 .update-old，出错可回滚。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
// 落盘统一走 atomic-write（pending 标记被写坏 = 助手进程读到 null 直接退出，
// 或者更糟：读到半截 JSON 后按"坏标记"处理，把上一次下载的 staging 当成本次的）。
import { atomicWriteJson } from './atomic-write.js';
// 进程镜像名探测（tasklist）复用 process-image.js 里那一份实现 —— 为什么是复用而不是
// 再写一份：instance-lock.js 为同一个"PID 被复用"问题已经踩过一遍坑并修好了，
// 两份"什么算同一个进程"迟早漂移，而漂移的代价是"更新按钮永久点不动"。
// ⚠️ 这里**绝不能静态 import instance-lock.js**：它会连带求值 config.js，而
//    electron/main.js 静态 import 本模块时，ESM 会在 main.js 任何一行代码执行之前
//    把整条依赖链求值完毕 —— DATA_DIR 就此被固化成 resources/app/data（headless
//    布局），因为 main.js 里设置 QQ_AGENT_DATA_DIR 的 resolveDataDir() 是运行时
//    才跑的。**求值本身就是副作用**，「只为算个常量、加载期没副作用」是错的。
//    后果：单实例锁与日志目录指错地方，首启 data/ 全新的机器上还会复活
//    「解压后双击打不开」的自愈竞态。这也是 processImageName 必须放在零项目内
//    依赖的 process-image.js 里的原因。
import { processImageName } from './process-image.js';

// ── 更新工件名（与 electron/self-update-apply.js 必须保持一致）──────────────
export const UPDATE_ARTIFACTS = {
  pending: '.update-pending',       // 待应用标记（JSON）：type/staging/rootDir/appDir/exe/electron
  staging: '.update-staging',       // 解压后的新文件
  download: '.update-download',     // 下载中的 zip
  old: '.update-old',               // 替换时挪开的旧文件（新进程启动后由 janitor 清理）
  result: '.update-result.json',    // 助手进程写的应用结果（janitor 读后删除并落日志）
  // 助手单实例锁（P2-1，2026-11-12 QA 回归发现）：与 pending **独立**存在。
  // 为什么不能靠 pending 判重：cancel() 会删掉 pending，于是 apply() 认为"没有待应用更新"，
  // 拉起第二个助手；两个助手共用同一个 .update-staging —— patch 会把已打补丁的文件当原件
  // 备份（原版永久丢失），full 会把后一个的 ok:false 覆盖前一个的 ok:true（成功记成失败）。
  helper: '.update-helper.lock'
};

// 更新源 API：可被 config.update.releaseApi 覆盖（私有仓库/自建源）。
export const DEFAULT_RELEASE_API = 'https://api.github.com/repos/Mashiroxun/Chat-Agent/releases/latest';

/** 下载停滞判定：单次读取超过这个时长没有新字节就 abort（B6，2026-11-12 审查）。 */
export const STALL_TIMEOUT_MS = 60 * 1000;

/**
 * pending 标记对象是否**合法**（口径唯一来源）。
 *
 * 为什么放在这里：两个进程都在读这个标记 —— 本进程（判断"是否已有待应用更新"）
 * 和助手进程（electron/self-update-apply.js 的 readPending）。两边对"坏标记"的
 * 判定必须完全一致，否则会出现"这边认为没有、那边认为有"，或者反过来的死锁。
 * 助手已经 import 本模块，所以判定收在这里不会产生循环依赖。
 *
 * @param {*} obj
 * @returns {boolean}
 */
export function isValidPending(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.type !== 'patch' && obj.type !== 'full') return false;
  if (!obj.staging || !obj.rootDir || !obj.appDir) return false;
  return true;
}

/**
 * 若锁里有**存活的**助手，抛错拒绝；否则返回锁里的 pid（可能是陈旧锁的 pid，null=无锁）。
 *
 * 单独抽成导出函数有两个原因：① spawnHelper 与将来其它入口共用同一句错误文案；
 * ② 它能在测试里被直接覆盖（真起一个子进程当"活着的助手"，比伪造 isPidAlive 更可信）。
 *
 * @param {string} rootDir
 * @returns {number|null}
 * @throws {Error} 已有存活助手
 */
export function assertNoLiveHelper(rootDir) {
  const pid = readHelperPid(rootDir);
  if (isHelperLive(rootDir)) {
    throw new Error(`已有更新助手在等待应用退出（pid=${pid}）；如长时间无变化，可在设置页点「检查更新」重试`);
  }
  return pid;
}

/** 资产命名约定：全量 <版本>.zip；补丁 patch-<版本>.zip；两者可带 .sha256 兄弟资产。 */
export const FULL_ASSET_RE = /^(?!patch-).+\.zip$/i;
export const PATCH_ASSET_RE = /^patch-.+\.zip$/i;

// ── 助手单实例锁（P2-1）────────────────────────────────────────────────────
// 锁文件放安装根，与 pending 独立：pending 表达"有更新待应用"，锁表达"有个助手进程
// 正活着等应用退出"。后者才是"不能再拉一个助手"的判据 —— cancel() 会删 pending，
// 但绝不能因此允许第二个助手进来（两个助手共用 staging，会互相毁掉备份）。
// 全部判定函数都由本模块导出：助手进程（electron/self-update-apply.js）与 janitor
// 复用同一套口径，免得两边各写一份"什么算存活"慢慢漂移。

/** 锁文件绝对路径。 */
export function helperLockPath(rootDir) {
  return path.join(rootDir, UPDATE_ARTIFACTS.helper);
}

/**
 * 锁心跳的"陈腐"阈值：超过这么久没刷新 = 助手不在了（或彻底卡死）。
 *
 * ⚠️ 残余风险（已知并接受）：机器休眠 > 10 分钟会停心跳，醒来那一瞬间理论上可能被判
 * stale。取向是"宁可十分钟后能自愈，也不要永久锁死"—— 见 isHelperLive 的注释，
 * 这条判定存在的全部意义就是给"PID 被复用"一个确定的止血时间。
 */
export const HELPER_LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * pid 是否存活。
 * Windows 上要注意：对"别人的进程"调 kill(pid, 0) 会抛 EPERM —— 那代表**进程存在**，
 * 只是没权限发信号，必须当成存活；只有 ESRCH（进程不存在）才算死亡。
 * 判错方向是致命的：把活着的助手当死锁 → 拉起第二个助手 → 就是 P2-1 那个事故。
 *
 * ⚠️ 但"活着"≠"是我们的助手"（见 isHelperLive）：PID 会被系统复用。
 * @param {number|string} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!n || !Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return String(error?.code || '') === 'EPERM';
  }
}

/**
 * 读锁文件，统一成 { pid, at, image }；不存在 / 坏 JSON / 无合法 pid → null（当作"无锁"）。
 * @param {string} rootDir
 * @returns {{pid:number, at:number, image:string}|null}
 */
export function readHelperLock(rootDir) {
  try {
    const obj = JSON.parse(fs.readFileSync(helperLockPath(rootDir), 'utf8'));
    const pid = Number(obj?.pid);
    if (!pid || !Number.isFinite(pid) || pid <= 0) return null;
    return {
      pid,
      at: Number(obj?.at) || 0,
      image: String(obj?.image || '').toLowerCase()
    };
  } catch { return null; }
}

/**
 * 读锁里记录的助手 pid；文件不存在 / 坏 JSON / 没有合法 pid 一律返回 null（当作"无锁"）。
 * @param {string} rootDir
 * @returns {number|null}
 */
export function readHelperPid(rootDir) {
  const lock = readHelperLock(rootDir);
  return lock ? lock.pid : null;
}

/**
 * 写锁（原子写，避免半截 JSON 被当成"无锁"）。
 *
 * schema = { pid, image, at }：
 *   · image 记的是**可执行文件名**（主进程与助手是同一个 execPath，不需要查进程表），
 *     用来识别"PID 被别的程序复用"；
 *   · at 是心跳时间戳，由助手每 5 秒 refreshHelperLock 推进一次 —— 它**有真实消费方**
 *     （isHelperLive 的第 3 条），不是"只写不读"的摆设。
 *
 * @param {string} rootDir
 * @param {number} pid
 * @param {object} [overrides] 测试用：覆盖 image / at，模拟"PID 被别的程序复用"等场景
 * @returns {boolean}
 */
export function writeHelperLock(rootDir, pid, overrides = {}) {
  return atomicWriteJson(helperLockPath(rootDir), {
    pid: Number(pid),
    image: path.basename(process.execPath).toLowerCase(),
    at: Date.now(),
    ...(overrides && typeof overrides === 'object' ? overrides : {})
  }, 2);
}

/**
 * 刷新锁心跳（只动 `at`）。助手进程每 5 秒调一次。
 * **只刷自己的锁**：pid 不符（锁被别的助手接管 / 已被删）就停手，绝不踩别人的锁。
 * @param {string} rootDir
 * @param {number} pid
 * @returns {boolean}
 */
export function refreshHelperLock(rootDir, pid) {
  const lock = readHelperLock(rootDir);
  if (!lock) return false;
  if (Number(lock.pid) !== Number(pid)) return false;
  return atomicWriteJson(helperLockPath(rootDir), { pid: lock.pid, image: lock.image, at: Date.now() }, 2);
}

// 镜像名探测的可替换点（与 instance-lock.js 的 __setIdentityProbeForTest 同一约定）：
// 生产走 process-image.js 里那份 tasklist 实现；单测注入假实现，免得每条用例都去起
// tasklist（几十毫秒 × N）还要受平台差异摆布。
let imageProbe = processImageName;

/** 测试接缝：替换镜像名探测实现，返回还原函数。 */
export function __setHelperImageProbeForTest(fn) {
  const prev = imageProbe;
  imageProbe = typeof fn === 'function' ? fn : processImageName;
  return () => { imageProbe = prev; };
}

/**
 * 锁是否代表一个**真的还在跑**的更新助手。
 *
 * 为什么不能只看 pid 存活（P1，2026-11-12 QA 第二轮实测）：
 * 助手被安软/任务管理器/断电强杀后锁文件会残留，而 Windows 很快把那个 PID 复用给
 * 任何无关进程（explorer.exe、甚至用户自己）—— 只看 kill(pid,0) 就永远返回"活着"，
 * 于是 apply() 与 cancel() **双双永久拒绝**，报错还是误导人的"请先退出应用完成本次
 * 更新"，而退出根本没有用。`src/instance-lock.js` 头部注释把这个坑写了两遍，
 * 这里是同一个坑的第二次出现。所以判定升级为三条独立证据：
 *
 *   1. pid 存活 —— 覆盖绝大多数情况（强杀后 pid 立刻消失，次日就自愈）；
 *   2. 心跳新鲜（at 在 HELPER_LOCK_STALE_MS 内）—— 覆盖"pid 被复用且探测不可用"；
 *   3. 镜像名一致 —— 覆盖"pid 被别的程序复用"（查得到才判，查不到跳过）。
 *
 * 第 3 条"查不到就跳过"是刻意的：fail-open 会放进第二个助手（毁备份），
 * fail-closed 会永久锁死（这次的事故），两者都不可接受；跳过 + 心跳是一条折中，
 * 最坏情况也只是 10 分钟后自愈。
 *
 * @param {string} rootDir
 * @returns {boolean}
 */
export function isHelperLive(rootDir) {
  const lock = readHelperLock(rootDir);
  if (!lock) return false;                                    // 没有锁 = 没有助手
  if (!isPidAlive(lock.pid)) return false;                    // 进程没了
  if (!lock.at || Date.now() - lock.at > HELPER_LOCK_STALE_MS) return false;   // 心跳停了
  if (lock.image) {
    let actual = null;
    try { actual = imageProbe(lock.pid); } catch { actual = null; }
    // 查得到且对不上 = PID 被无关程序复用（不是我们的助手）。查不到就跳过这一条。
    if (actual && String(actual).toLowerCase() !== lock.image) return false;
  }
  return true;
}

/**
 * 删锁（best effort，永不抛）。
 * @param {string} rootDir
 * @param {number} [onlyPid] 只在锁属于这个 pid 时才删（助手用它，避免误删别人刚写的锁）
 * @returns {boolean}
 */
export function clearHelperLock(rootDir, onlyPid = null) {
  const file = helperLockPath(rootDir);
  try {
    if (onlyPid !== null && onlyPid !== undefined) {
      const current = readHelperPid(rootDir);
      if (current !== null && Number(current) !== Number(onlyPid)) return false;
    }
    fs.rmSync(file, { force: true });
    return true;
  } catch { return false; }
}


/** 从 release API 地址解析 owner/repo（构造兜底下载链接用）。 */
export function parseRepoFromApi(apiUrl) {
  const m = /github\.com\/repos\/([^/]+)\/([^/]+)\//i.exec(String(apiUrl || ''));
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * 从 release JSON 里挑资产。
 *   patch：名字匹配 patch-*.zip 的资产（多只取第一个，按 GitHub 返回序）；
 *   full ：优先带 win-x64 的 zip，其次唯一的 zip；patch-* 永远不算 full。
 * 每项返回 { name, url, size, digest }，digest 形如 'sha256:<hex>'（GitHub 新字段，可为 null）。
 */
export function pickUpdateAssets(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const pick = (re, preferWin64) => {
    const list = assets.filter((a) => re.test(String(a?.name || '')));
    if (!list.length) return null;
    const chosen = preferWin64
      ? (list.find((a) => /win-x64/i.test(String(a.name))) || list[0])
      : list[0];
    return {
      name: String(chosen.name),
      url: String(chosen.browser_download_url || ''),
      size: Number(chosen.size) || 0,
      digest: String(chosen.digest || '').trim() || null
    };
  };
  return {
    latest: String(release?.tag_name || '').replace(/^v/i, ''),
    patch: pick(PATCH_ASSET_RE, false),
    full: pick(FULL_ASSET_RE, true),
    // 兄弟校验和资产：patch-<ver>.zip.sha256 之类
    shaSiblings: new Set(assets.filter((a) => /\.sha256$/i.test(String(a?.name || ''))).map((a) => String(a.name)))
  };
}

/** 布局探测：打包安装（appDir=<root>/resources/app 且 root 有 QQ Agent.exe）返回 root；开发检出返回 appDir 本身。 */
export function resolveRootDir(appDir) {
  try {
    const parent = path.dirname(appDir);
    const candidate = path.dirname(parent);
    if (path.basename(appDir) === 'app'
      && path.basename(parent) === 'resources'
      && fs.existsSync(path.join(candidate, 'QQ Agent.exe'))) {
      return candidate;
    }
  } catch { /* 探测失败按开发布局处理 */ }
  return appDir;
}

/** 递归收集 dir 下全部文件，rel 为 POSIX 相对路径。 */
export function walkCollect(dir, baseDir = dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkCollect(abs, baseDir, out);
    else if (entry.isFile()) out.push({ abs, rel: path.relative(baseDir, abs).split(path.sep).join('/') });
  }
  return out;
}

/**
 * staging 逃逸检查（zip-slip 防线）：每个解压出的文件 rel 必须是干净的相对路径。
 * 返回违规列表；空数组 = 通过。
 */
export function findEscapePaths(files) {
  const bad = [];
  for (const f of files) {
    // 绝对路径（含 Windows 盘符如 C:\…）或含父目录回溯/空段都视为逃逸。
    if (path.isAbsolute(f.rel)) bad.push(f.rel);
    const segs = f.rel.split('/');
    if (segs.some((seg) => seg === '..' || seg === '' || /^[A-Za-z]:/.test(seg))) bad.push(f.rel);
  }
  return bad;
}

/** 流式 sha256；大文件不进内存。 */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 解析 .sha256 文本（'hex  filename' / 纯 hex 都认）。 */
export function parseSha256Text(text) {
  const m = /\b([a-f0-9]{64})\b/i.exec(String(text || ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * 解析 release 资产里的 digest 字段，返回规范化的小写 hex；认不出返回 null。
 *
 * 为什么要"认不出"而不是"原样用"（P3-4，2026-11-12 QA 回归）：
 * 旧实现只认严格小写前缀 `sha256:`，于是 `SHA256:<hex>`（GitHub 上游改过大小写、
 * 自建源常这么写）和裸 64 位 hex 会被判成"没有校验和"而**永久拒绝更新** ——
 * 方向是安全的，但把合法的自建源挡在门外，用户只能手动装。
 * 现在统一 toLowerCase 后比较，并接受三种形态：sha256:<hex> / SHA256:<hex> / <hex>。
 *
 * @param {*} digest
 * @returns {string|null}
 */
export function parseDigestSha256(digest) {
  const raw = String(digest ?? '').trim();
  if (!raw) return null;
  const m = /^(?:sha256:)?([a-f0-9]{64})$/i.exec(raw);
  return m ? m[1].toLowerCase() : null;
}

/**
 * 把多个 AbortSignal 合成一个（任一 abort 即 abort）。
 *
 * 为什么不用现成的 `AbortSignal.any`：它要求 Node ≥ 20.3，而 package.json 只声明
 * `engines.node >= 20.0.0`，Electron 里的 node 版本也随发行版变化 —— 一旦缺失就是
 * "下载永远抛 TypeError"，比没有超时更糟。所以这里自带兜底实现。
 * @param {AbortSignal[]} signals
 * @returns {AbortSignal}
 */
function anySignal(signals) {
  const valid = (Array.isArray(signals) ? signals : [signals]).filter(Boolean);
  if (!valid.length) return new AbortController().signal;
  if (valid.length === 1) return valid[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(valid);
  const ctrl = new AbortController();
  for (const signal of valid) {
    if (signal.aborted) { ctrl.abort(signal.reason); break; }
    signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  }
  return ctrl.signal;
}

/**
 * 带超时的 fetch（跟随重定向、禁止缓存）。
 * @param {string} url
 * @param {number} ms              单次请求的超时
 * @param {{signal?: AbortSignal}} [extra] 额外信号（下载时用于停滞检测与用户取消）
 */
function fetchWithTimeout(url, ms, extra = {}) {
  const signal = extra.signal ? anySignal([extra.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  return fetch(url, { redirect: 'follow', cache: 'no-store', signal });
}

/**
 * 校验 zip：优先 GitHub digest 字段，其次同名 .sha256 资产。
 *
 * ⚠️ 两者都拿不到时必须**拒绝**（2026-11-12 审查修订）：旧实现是 `log('warn', …)`
 * 然后放行 —— 只要发布方没带 digest（GitHub 的 digest 字段是新加的，老 release /
 * 自建源大多为空），任何镜像污染 / 半截下载 / 中间人都能直接走到"解压并覆盖用户
 * 安装目录"这一步。信任链少一环等于没有，宁可让用户手动装。
 *
 * @param {{asset:{name:string,url:string,digest:string|null}, localSha:string,
 *          picked:{shaSiblings?:Set<string>}, log?:function}} input
 * @returns {Promise<void>} 抛出即表示不可信，调用方必须中止更新
 */
export async function verifyZip({ asset, localSha, picked, log = () => {} }) {
  const shaSiblings = picked?.shaSiblings instanceof Set ? picked.shaSiblings : new Set();
  let expected = parseDigestSha256(asset?.digest);
  if (!expected && asset?.name && shaSiblings.has(`${asset.name}.sha256`)) {
    try {
      const r = await fetchWithTimeout(`${asset.url}.sha256`, 15000);
      if (r.ok) expected = parseSha256Text(await r.text());
    } catch (error) {
      // 拉不到校验和文件不是"放行"，下面统一按"没有校验和"拒绝。
      log('warn', `[self-update] 拉取 ${asset.name}.sha256 失败（${String(error?.message ?? error)}）`);
    }
  }
  if (!expected) {
    throw new Error('发布包未提供可用校验和（digest 与 .sha256 均缺失），出于安全考虑已中止更新；请改用「去下载」手动安装');
  }
  if (expected !== String(localSha || '').toLowerCase()) {
    throw new Error(`校验和不匹配（期望 ${expected.slice(0, 12)}…，实际 ${String(localSha).slice(0, 12)}…）：包可能损坏或被篡改`);
  }
}

/**
 * patch manifest 校验（方案 B 的安全闸）。
 * 返回 { manifest, files:[{rel,abs,sha256}], deletions:[rel] }。
 * base 与当前版本不符时抛 { fallbackToFull: true } —— 调用方据此回退全量包。
 * 绝不允许触碰用户数据目录（data/、plugin-data/）与 node_modules。
 */
export function validatePatchManifest(stagingDir, currentVersion) {
  const manifestPath = path.join(stagingDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (String(manifest.type || '') !== 'patch') throw new Error('manifest.json type 不是 patch');
  if (String(manifest.base || '') !== String(currentVersion)) {
    const err = new Error(`补丁基线（${manifest.base}）与当前安装（${currentVersion}）不符`);
    err.fallbackToFull = true;
    throw err;
  }
  const safeRel = (rel) => {
    const s = String(rel || '');
    if (!s || path.isAbsolute(s)) throw new Error(`manifest 里有非相对路径：${s}`);
    const segs = s.split('/');
    if (segs.some((seg) => seg === '' || seg === '..' || seg === '.')) throw new Error(`manifest 里有可疑路径：${s}`);
    const top = segs[0];
    if (top === 'data' || top === 'plugin-data' || top === 'node_modules') {
      throw new Error(`manifest 不允许触碰 ${top}/：${s}`);
    }
    return s;
  };
  const list = Array.isArray(manifest.files) ? manifest.files : [];
  const deletions = (Array.isArray(manifest.deletions) ? manifest.deletions : []).map((rel) => safeRel(rel));
  // 允许"仅删除"的合法补丁（files 为空但 deletions 非空）；两者都为空才拒绝。
  if (!list.length && !deletions.length) throw new Error('manifest 既没有文件变更也没有删除项');
  const files = list.map((item) => {
    const rel = safeRel(item.path);
    const abs = path.join(stagingDir, ...rel.split('/'));
    if (!fs.existsSync(abs)) throw new Error(`补丁文件缺失：${rel}`);
    return { rel, abs, sha256: String(item.sha256 || '').toLowerCase() };
  });
  return { manifest, files, deletions };
}

/**
 * 解析 tar 可执行文件。Windows 上必须用系统自带的 bsdtar（System32\tar.exe）：
 * 它才支持 zip 格式，且正确处理 C:\ 路径。PATH 里若混着 GNU tar（Git Bash 等），
 * GNU tar 既解不了 zip，还会把 "C:\..." 当成远程主机（"Cannot connect to C:"）。
 */
function resolveTarBinary() {
  if (process.platform === 'win32') {
    const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sysTar)) return sysTar;
  }
  return 'tar';
}

/** 用系统 tar 解 zip（Windows 10 1803+ 自带 bsdtar，支持 zip；跨平台兜底一致）。 */
function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    execFile(resolveTarBinary(), ['-xf', zipPath, '-C', destDir], { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        const msg = String(stderr || error.message || '');
        reject(new Error(msg.includes('ENOENT') || error.code === 'ENOENT'
          ? '系统缺少 tar（Windows 10 1803+ 自带）；解压更新包失败'
          : `解压失败：${msg.slice(0, 200)}`));
        return;
      }
      resolve();
    });
  });
}

function rmRf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
}

/**
 * 创建自更新服务。一个 createApp 实例一份（job 状态闭包持有，不落模块级单例）。
 * @param {object} opts
 * @param {string} opts.appDir       resources/app 目录（config.ROOT）
 * @param {function} opts.log        (level, message) 项目日志出口
 * @param {function} opts.getConfig  读 config（update.releaseApi / update.mirrorPrefix / update.disabled）
 * @param {function} opts.localVersion
 * @param {function} opts.compareSemver
 */
export function createSelfUpdateService({ appDir, log = () => {}, getConfig = () => ({}), localVersion, compareSemver }) {
  const rootDir = resolveRootDir(appDir);
  const isPackagedInstall = rootDir !== appDir;   // 开发检出（无 QQ Agent.exe 的 app 根）不做全量替换
  const A = UPDATE_ARTIFACTS;
  const abs = (name) => path.join(rootDir, name);

  let job = { state: 'idle', mode: null, stage: '', message: '', received: 0, total: 0, latest: '', error: '', startedAt: null, finishedAt: null };

  const setStage = (stage, message) => {
    job.stage = stage;
    job.state = stage;   // state 与 stage 同步推进：UI 轮询按 state 分支渲染进度
    if (message) job.message = message;
    log('info', `[self-update] ${stage}${message ? `：${message}` : ''}`);
  };
  const fail = (error) => {
    job.state = 'error';
    job.error = String(error?.message ?? error);
    job.finishedAt = Date.now();
    log('error', `[self-update] 失败：${job.error}`);
  };

  // 取消与停滞检测共用的信号源：downloadZip 每次尝试注册一个 controller，
  // cancel() 直接 abort 它 —— 不必等下一次进度回报才知道用户点了取消。
  let activeAbort = null;
  // 本次更新是否被 cancel() 叫停：置 true 后流水线里的任何报错都按"已取消"收场，
  // 不能让它以 error 状态覆盖掉用户看到的 cancel 结果。
  let cancelRequested = false;

  /** 拉最新 release：先走 GitHub API；失败则按命名约定构造下载 URL 兜底（api.github.com 不可达时仍能更新）。 */
  async function resolveRelease(currentVersion) {
    const cfg = getConfig().update ?? {};
    const apiUrl = String(cfg.releaseApi || DEFAULT_RELEASE_API).trim();
    const mirror = String(cfg.mirrorPrefix || '').trim();
    const withMirror = (url) => (mirror ? mirror + url : url);
    try {
      const r = await fetchWithTimeout(apiUrl, 10000);
      if (r.ok) {
        const picked = pickUpdateAssets(await r.json());
        if (picked.latest && (picked.patch || picked.full)) return { ...picked, constructed: false, withMirror };
      }
      log('warn', '[self-update] release API 不可用，按命名约定构造下载地址兜底');
    } catch (error) {
      log('warn', `[self-update] release API 请求失败（${String(error?.message ?? error)}），改用约定地址兜底`);
    }
    // 兜底：version.json 的版本 + 固定命名约定。此时校验和只能靠 .sha256 兄弟资产。
    const repo = parseRepoFromApi(apiUrl);
    if (!repo) throw new Error('release API 不可用且无法从其地址解析出仓库（检查 config.update.releaseApi）');
    // 更新源版本号：直接复用 checkUrl 的 version.json（system.js 同款默认）。
    const checkUrl = String(cfg.checkUrl || 'https://fastly.jsdelivr.net/gh/Mashiroxun/Chat-Agent@main/version.json').trim();
    const vr = await fetchWithTimeout(checkUrl, 10000);
    if (!vr.ok) throw new Error(`更新源不可达（HTTP ${vr.status}）`);
    const info = await vr.json();
    const latest = String(info.version || '');
    if (!latest) throw new Error('更新源 version.json 缺少 version 字段');
    if (compareSemver(latest, currentVersion) <= 0) return { latest, hasUpdate: false, patch: null, full: null, constructed: true, withMirror };
    const base = `https://github.com/${repo.owner}/${repo.repo}/releases/download/v${latest}`;
    // ⚠️ 这里**不**套镜像前缀：镜像化统一由 apply() 里的 mirrorAsset() 做一次。
    // 以前 withMirror 只在这一处兜底 URL 上生效，而真正的下载/校验走的是
    // asset.url —— mirrorPrefix 配了等于没配（E1，2026-11-12 审查）。
    const dl = (name) => `${base}/${name}`;
    return {
      latest,
      hasUpdate: true,
      patch: { name: `patch-${latest}.zip`, url: dl(`patch-${latest}.zip`), size: 0, digest: null },
      full: { name: `${latest}.zip`, url: dl(`${latest}.zip`), size: 0, digest: null },
      shaSiblings: new Set([`patch-${latest}.zip.sha256`, `${latest}.zip.sha256`]),
      constructed: true,
      withMirror
    };
  }

  /**
   * 下载前的磁盘空间预检（E5）。
   * disk-space 走**动态 import**：本模块也被助手进程（纯 node）import，
   * 静态引入会把 config.js → DATA_DIR 那一串副作用带进助手进程。
   * 探测失败一律不拦（disk-space 的口径：取不到就当 'ok'）。
   */
  async function assertDiskSpace(asset) {
    let pressure = 'ok';
    let free = null;
    try {
      const mod = await import('./disk-space.js');
      pressure = mod.diskPressure();
      free = mod.dataDirFreeBytes();
    } catch (error) {
      log('warn', `[self-update] 磁盘空间探测失败（${String(error?.message ?? error)}），跳过预检`);
      return;
    }
    if (pressure !== 'critical') return;
    const freeMb = free === null ? null : Math.round(free / 1048576);
    const needMb = asset.size ? Math.round((asset.size / 1048576) * 2) : null;   // 包 + 解压/staging 余量
    throw new Error(`磁盘剩余空间不足${freeMb === null ? '' : `（仅剩 ${freeMb}MB）`}`
      + `${needMb === null ? '' : `，本次更新大约需要 ${needMb}MB`}：请先清理磁盘（或把 data 目录搬到空间更大的盘）后重试`);
  }

  /** Sleep（重试退避用）。 */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * 单次下载尝试。`attempt` 只用于日志与错误文案。
   *
   * 停滞检测：60 秒没有任何新字节就 abort。旧的 12 小时总超时对"连接建立了但
   * 一个字节都不来"这种情况几乎等于没有超时（用户看到进度条永远停在 0%），
   * 而 12 小时总超时又必须留着 —— 慢网下全量包确实要下很久。
   *
   * 续传（HTTP Range）留作后续：需要服务端支持、需要校验分段完整性，
   * 本轮只做"失败整包重下 + 重试前清空下载目录"。
   */
  async function downloadOnce(asset, stage, attempt) {
    const dlDir = abs(A.download);
    rmRf(dlDir);
    fs.mkdirSync(dlDir, { recursive: true });
    const dest = path.join(dlDir, asset.name.replace(/[\\/:*?"<>|]/g, '_'));
    if (attempt > 1) log('info', `[self-update] 第 ${attempt} 次尝试下载 ${asset.name}（已清空下载缓存，不续传）`);

    const ctrl = new AbortController();
    activeAbort = ctrl;
    const stallMs = STALL_TIMEOUT_MS;
    const startedAt = Date.now();
    let lastDataAt = startedAt;
    let stalled = false;
    const stallTimer = setInterval(() => {
      if (Date.now() - lastDataAt > stallMs) { stalled = true; ctrl.abort(); }
    }, Math.min(5000, stallMs));
    if (typeof stallTimer.unref === 'function') stallTimer.unref();

    try {
      const res = await fetchWithTimeout(asset.url, 12 * 60 * 60 * 1000, { signal: ctrl.signal });
      if (!res.ok) {
        const error = new Error(`下载失败：HTTP ${res.status}（${asset.name}）`);
        error.status = res.status;
        // 4xx（除 408/429）是"这个地址要不到东西"，重试没有意义。
        error.retryable = !(res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429);
        throw error;
      }
      job.total = Number(res.headers.get('content-length')) || asset.size || 0;
      job.received = 0;
      let lastPct = -1;
      const hash = createHash('sha256');
      const out = fs.createWriteStream(dest);
      await pipeline(Readable.fromWeb(res.body), async function* (source) {
        for await (const chunk of source) {
          lastDataAt = Date.now();
          hash.update(chunk);
          job.received += chunk.length;
          const pct = job.total ? Math.floor((job.received / job.total) * 100) : 0;
          if (pct !== lastPct) { lastPct = pct; setStage(stage, `${pct}%（${(job.received / 1048576).toFixed(1)}MB）`); }
          yield chunk;
        }
      }, out);
      await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });
      return { dest, sha256: hash.digest('hex') };
    } catch (error) {
      if (stalled) {
        const e = new Error(`下载停滞：${Math.round(stallMs / 1000)} 秒没有收到新数据（${asset.name}），已中止本次尝试`);
        e.retryable = true;
        e.stalled = true;
        throw e;
      }
      // 落盘类错误（ENOSPC/EPERM/EACCES）重试也不会好，别白等 8 秒。
      if (error?.code && /^E(NOSPC|PERM|ACCES|ROFS|ISDIR|NOENT)$/.test(String(error.code))) {
        error.retryable = false;
        throw error;
      }
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') error.retryable = true;
      if (error?.retryable === undefined) {
        // fetch 的网络层失败是 TypeError: fetch failed —— 这类才值得重试。
        error.retryable = true;
      }
      throw error;
    } finally {
      clearInterval(stallTimer);
      if (activeAbort === ctrl) activeAbort = null;
      if (cancelRequested) rmRf(dlDir);   // 用户取消：别把半截 zip 留在盘上
    }
  }

  /**
   * 下载 zip（带进度回报 + 停滞检测 + 最多 2 次重试）。
   * 只重试网络类失败；校验/解压失败由调用方处理（重下同一个坏包没有意义）。
   */
  async function downloadZip(asset, stage) {
    await assertDiskSpace(asset);
    const backoff = [0, 2000, 6000];   // 第 1 次立即、第 2 次退避 2s、第 3 次退避 6s
    let lastError = null;
    for (let attempt = 1; attempt <= backoff.length; attempt += 1) {
      if (backoff[attempt - 1]) {
        log('warn', `[self-update] 下载失败（第 ${attempt - 1} 次尝试）：${String(lastError?.message ?? lastError)}；`
          + `${backoff[attempt - 1] / 1000} 秒后重试（第 ${attempt} 次）`);
        await sleep(backoff[attempt - 1]);
      }
      if (cancelRequested) throw new Error('更新已取消');
      try {
        return await downloadOnce(asset, stage, attempt);
      } catch (error) {
        lastError = error;
        if (cancelRequested) throw error;
        if (error?.retryable === false || attempt === backoff.length) throw error;
      }
    }
    throw lastError ?? new Error('下载失败（未知原因）');
  }

  /**
   * 校验 zip 的闭包包装：真正的判定在模块级 verifyZip（可单独单测，不出网）。
   * 以前这里是"两者皆无则放行并告警"，现在改成抛错（B5，2026-11-12 审查）。
   */
  function verifyDownloadedZip(asset, localSha, picked) {
    return verifyZip({ asset, localSha, picked, log });
  }

  /** 写待应用标记（助手进程的唯一输入）。 */
  function writePending(data) {
    // 原子写：半截 JSON 会让助手进程读到 null 直接退出，或者让本进程误判
    // "已有待应用更新" 而永远挡住后续更新（B3，2026-11-12 审查）。
    const ok = atomicWriteJson(abs(A.pending), { ...data, createdAt: Date.now() }, 2);
    if (!ok) throw new Error(`写入待应用标记失败（${abs(A.pending)}）：磁盘可能已满或无写权限`);
  }

  function pendingExists() {
    try { return fs.existsSync(abs(A.pending)); } catch { return false; }
  }

  /** 读 pending 标记；不存在 / 坏 JSON / 结构不合法一律 null（判定口径见 isValidPending）。 */
  function readPendingMarker() {
    try {
      const obj = JSON.parse(fs.readFileSync(abs(A.pending), 'utf8'));
      return isValidPending(obj) ? obj : null;
    } catch { return null; }
  }

  function clearPendingMarker() {
    try { fs.rmSync(abs(A.pending), { force: true }); } catch { /* 尽力而为 */ }
  }

  /**
   * 拉起助手进程：等本进程退出后执行替换并重启。ELECTRON_RUN_AS_NODE=1 让 exe 以纯 node 跑助手脚本。
   *
   * 必须 async 且**等到 spawn 真的成功**（B1，2026-11-12 审查）：旧实现 spawn 后立刻
   * 打日志"已拉起（pid=undefined）"，然后照常写 pending 并进入 ready —— 用户以为更新
   * 已就绪、退出应用，结果什么都不会发生（pending 残留，下次启动 janitor 才清掉）。
   * `'error'` 事件（ENOENT/EPERM/被杀软拦截）以前完全没人监听，是 Node 里的
   * uncaughtException 来源之一。
   *
   * 单实例（P2-1，2026-11-12 QA 回归）：锁里有存活的助手 → 直接拒绝，不再拉第二个。
   * 两个助手共用 .update-staging 的后果：patch 把已打补丁的文件当原件备份（原版永久
   * 丢失）、full 把后一个的 ok:false 覆盖前一个的 ok:true（成功记成失败）。
   *
   * @returns {Promise<number>} 助手进程 pid
   */
  async function spawnHelper() {
    const helperScript = path.join(appDir, 'electron', 'self-update-apply.js');
    if (!fs.existsSync(helperScript)) throw new Error('找不到助手脚本 electron/self-update-apply.js');

    const lockedPid = assertNoLiveHelper(rootDir);
    // 陈旧锁（写锁的助手已死）：清掉再写，否则留着会让人误以为还有助手在跑。
    if (lockedPid) clearHelperLock(rootDir);

    const child = spawn(process.execPath, [helperScript, '--pid', String(process.pid), '--root', rootDir], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const pid = Number(child.pid);
    if (!pid || !Number.isFinite(pid)) throw new Error('助手进程拉起后没有有效 pid（更新已中止，未留下待应用标记）');
    // 先写锁再 unref：锁写不进去就不该继续（否则"没有锁的助手"等于没有单实例保护）。
    if (!writeHelperLock(rootDir, pid)) {
      try { process.kill(pid); } catch { /* 已经退了就算了 */ }
      throw new Error(`无法写入更新助手锁文件（${helperLockPath(rootDir)}）：磁盘可能已满或无写权限，更新已中止`);
    }
    child.unref();
    log('info', `[self-update] 助手进程已拉起（pid=${pid}），等待应用退出后执行替换`);
    return pid;
  }

  // ── 对外接口：apply / status / cancel / capability ──────────────────────
  // ⚠️ 这些方法会被解构使用（src/routes/system.js 里是 `deps.selfUpdate.apply()`
  //    这种形式没问题，但 UI/测试可能 const { status } = service）。所以内部一律
  //    调局部函数，不能用 this.xxx —— 解构后 this 是 undefined（E4，2026-11-12 审查）。
  function capability() {
    return {
      available: true,
      fullSupported: isPackagedInstall,   // 开发检出只支持补丁
      rootDir,
      isPackagedInstall
    };
  }

  /** 更新源镜像化：downloadZip 与 verifyZip 必须用**同一个** URL，否则校验的是别处的包（E1）。 */
  function mirrorAsset(asset, picked) {
    if (!asset || typeof picked?.withMirror !== 'function') return asset;
    return { ...asset, url: picked.withMirror(String(asset.url || '')) };
  }

  return {
    /** 是否具备执行条件（供 UI 预判：不可用时按钮退回「去下载」链接）。 */
    capability,

    /** 启动一次更新（异步流水线，立即返回；进度走 status()）。 */
    async apply() {
      if (getConfig().update?.disabled) return { ok: false, error: '更新检查已在设置中关闭' };
      if (job.state === 'preparing' || job.state === 'downloading' || job.state === 'extracting' || job.state === 'validating') {
        return { ok: false, error: '已有更新在进行中' };
      }
      // pending 标记处理（B4 + 2026-11-12 QA 第二轮的 P2 残骸）。
      //
      // 两种"文件在但不该挡住我们"的情况，都必须能自愈：
      //   ① 内容不是合法对象（写入被打断 / 手改坏）→ 清掉继续（B4）；
      //   ② 合法但**助手已经死了**（被安软 taskkill / 断电）→ 残骸，清掉继续。
      //      旧实现只认"有标记就拒绝"，而 UI 里没有取消入口，用户按提示"重启应用"
      //      毫无作用（没有助手会去应用它），只能等 24 小时后 janitor 清超龄标记 ——
      //      等于整整一天点不动更新。
      if (pendingExists()) {
        const marker = readPendingMarker();
        if (marker) {
          const helperPid = Number(marker.helperPid);
          if (helperPid && !isHelperLive(rootDir)) {
            log('warn', `[self-update] ${A.pending} 指向的助手（pid=${helperPid}）已不在运行，`
              + '判定为上次更新留下的残骸，清理后继续本次更新');
            clearPendingMarker();
            clearHelperLock(rootDir);
          } else {
            return {
              ok: false,
              error: '已有待应用的更新：更新助手正在等待应用退出；如长时间无变化，可在设置页点「检查更新」重试'
            };
          }
        } else {
          log('warn', `[self-update] 发现残留的 ${A.pending}（内容无效，可能是上次写入被打断），已清除后继续本次更新`);
          clearPendingMarker();
        }
      }
      const current = localVersion();
      // 助手单实例（P2-1）：pending 可能已被 cancel 删掉，但助手还在等应用退出。
      // 这里提前拦一次是"早失败"——否则用户要等 147MB 全量包下完才在 spawnHelper 处
      // 撞到同一条错误。权威判定仍在 spawnHelper（TOCTOU 窗口用锁兜住）。
      try {
        assertNoLiveHelper(rootDir);
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
      cancelRequested = false;
      job = { state: 'preparing', mode: null, stage: 'preparing', message: '正在获取版本信息…', received: 0, total: 0, latest: '', error: '', startedAt: Date.now(), finishedAt: null };

      // 流水线整体异步跑，HTTP 响应立即返回，UI 轮询 status。
      (async () => {
        try {
          const picked = await resolveRelease(current);
          job.latest = picked.latest;
          if (picked.hasUpdate === false || compareSemver(picked.latest, current) <= 0) {
            job.state = 'idle'; job.stage = 'idle'; job.message = '已是最新'; job.finishedAt = Date.now();
            return;
          }
          // release 有 tag 但一个 zip 资产都没有（assets 传漏/还在传）：明确报错，
          // 否则下面 asset 为 null 进 downloadZip 会抛 "Cannot read properties of null"。
          if (!picked.patch && !picked.full) {
            fail('发布版里还没有可用的更新包（zip 资产缺失），请稍后再试或改用「去下载」手动安装');
            return;
          }
          // 选通道：优先 patch；manifest 校验发现 base 不符 → 回退 full。
          let mode = picked.patch ? 'patch' : 'full';
          if (mode === 'full' && !isPackagedInstall) {
            fail('当前是开发检出布局，不支持全量替换（打包安装才可用）；请发布补丁包或手动更新');
            return;
          }
          // 镜像化一次，下载与校验都用这个 URL（E1）。patch/full 通道切换时也要重新镜像。
          let asset = mirrorAsset(mode === 'patch' ? picked.patch : picked.full, picked);
          let staging = abs(A.staging);
          rmRf(staging);

          // 两轮：第一轮 patch，manifest 基线不符时第二轮换 full。
          // （下载层面的"最多 2 次重试"在 downloadZip 内部，别和这里混。）
          for (let round = 1; round <= 2; round++) {
            setStage('downloading', `正在下载 ${asset.name}…`);
            job.mode = mode;
            const { dest, sha256 } = await downloadZip(asset, 'downloading');
            setStage('validating', '校验下载包…');
            await verifyDownloadedZip(asset, sha256, picked);

            fs.mkdirSync(staging, { recursive: true });
            setStage('extracting', '正在解压…');
            await extractZip(dest, staging);
            rmRf(abs(A.download));

            const escaped = findEscapePaths(walkCollect(staging));
            if (escaped.length) {
              rmRf(staging);
              throw new Error(`解压内容包含可疑路径（${escaped[0]}），已中止更新`);
            }

            if (mode === 'patch') {
              setStage('validating', '校验补丁清单…');
              let validated;
              try {
                validated = validatePatchManifest(staging, current);
              } catch (error) {
                rmRf(staging);
                if (error?.fallbackToFull && picked.full && isPackagedInstall) {
                  log('warn', '[self-update] 补丁与当前版本不匹配，回退全量包');
                  mode = 'full';
                  asset = mirrorAsset(picked.full, picked);
                  staging = abs(A.staging);
                  continue;   // 第二轮：下载全量
                }
                throw error;
              }
              // 逐文件校验 sha256（staging 内文件对得上 manifest 才允许覆盖）
              for (const file of validated.files) {
                const actual = await sha256File(file.abs);
                if (file.sha256 && actual !== file.sha256) {
                  rmRf(staging);
                  throw new Error(`补丁文件校验失败：${file.rel}`);
                }
              }
            }
            break;   // 本轮成功
          }

          // ⚠️ 顺序：先拉起助手（失败就抛，此时**不留** pending），成功后才写标记、
          // 才进入 ready（B2，2026-11-12 审查）。旧顺序正好相反 —— 助手 spawn 失败时
          // 用户看到的仍是"已就绪，退出应用即生效"，退出后什么都不会发生。
          // 助手侧对"标记还没落盘"有等待窗口（见 self-update-apply.js 的 waitForPendingMarker）。
          const helperPid = await spawnHelper();
          writePending({
            type: mode,
            staging,
            rootDir,
            appDir,
            targetVersion: picked.latest,
            exe: process.execPath,
            electron: Boolean(process.versions.electron),
            helperPid
          });
          job.state = 'ready';
          job.stage = 'ready';
          job.message = mode === 'patch'
            ? `补丁 v${picked.latest} 已就绪，退出应用后自动完成更新并重启`
            : `全量更新 v${picked.latest} 已就绪，退出应用后自动完成替换并重启`;
          job.finishedAt = Date.now();
        } catch (error) {
          // 用户主动取消时不要把状态翻回 error：那会让 UI 显示"更新失败"，
          // 而实际是用户自己点的取消（B7）。
          if (cancelRequested) {
            job = {
              state: 'idle', mode: null, stage: 'idle', message: '已取消更新',
              received: 0, total: 0, latest: job.latest, error: '', startedAt: null, finishedAt: Date.now()
            };
            log('info', '[self-update] 更新已取消');
            return;
          }
          fail(error);
        }
      })();

      return { ok: true, started: true };
    },

    /**
     * 取消本次更新（B7，2026-11-12 审查）。
     * 以前没有任何取消入口：用户在设置页点了「一键更新」，下到一半想放弃只能等
     * 40 分钟 UI 超时，且 staging / 下载缓存一直占着盘。
     * 清理三样东西：.update-staging、.update-download、pending 标记；正在下载则先 abort。
     *
     * ⚠️ 助手存活时**拒绝取消**（P2-1，2026-11-12 QA 回归）：旧实现删掉 pending 就返回
     * ok，于是下一次 apply() 认为"没有待应用更新"，又拉起一个助手 —— 两个助手共用
     * 同一个 staging，patch 会话把已打补丁的文件当原件备份（原版永久丢失）、full 会话
     * 用后一个的 ok:false 覆盖前一个的 ok:true。既然改不回来（助手是进程外、手里已有
     * 标记副本），就明确拒绝，别给出"已取消"的假象。
     *
     * 判"助手存活"用 isHelperLive（pid + 心跳 + 镜像），不是裸 isPidAlive：
     * 否则 PID 被别的程序复用时会永久拒绝取消（P1，2026-11-12 QA 第二轮）。
     */
    cancel() {
      const lockedPid = readHelperPid(rootDir);
      if (isHelperLive(rootDir)) {
        return {
          ok: false,
          error: `更新助手已在等待应用退出（pid=${lockedPid}），无法取消：`
            + '如需放弃本次更新，请先退出应用（助手会完成更新后自动重启）；'
            + '若退出后仍失败，重新打开应用即可在设置页点「检查更新」重试'
        };
      }
      cancelRequested = true;
      if (activeAbort) {
        try { activeAbort.abort(); } catch { /* 已经结束的请求，忽略 */ }
        activeAbort = null;
      }
      rmRf(abs(A.staging));
      rmRf(abs(A.download));
      clearPendingMarker();
      clearHelperLock(rootDir);   // 陈旧锁（助手已死）一并清掉，别挡住下一次更新
      job = {
        state: 'idle', mode: null, stage: 'idle', message: '已取消更新',
        received: 0, total: 0, latest: job.latest, error: '', startedAt: null, finishedAt: Date.now()
      };
      log('info', '[self-update] 已取消更新（已清理 staging / 下载缓存 / 待应用标记 / 陈旧助手锁）');
      return { ok: true };
    },

    /** UI 轮询用的进度快照。 */
    status() {
      return {
        ok: true,
        state: job.state,
        mode: job.mode,
        stage: job.stage,
        message: job.message,
        received: job.received,
        total: job.total,
        latest: job.latest,
        error: job.error,
        ...capability()
      };
    }
  };
}
