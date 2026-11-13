// 启动状态读写（启动链重写第一步「收编」，2026-11-13）。
//
// 这里只放**零项目内依赖**的函数：路径计算、交接标记、render-config、
// render-health（连续健康启动计数）、boot-diag 追加、GPU 关闭标记、实例锁交还。
// 所有外部状态（数据目录、当前时间、
// 是否为重启子进程、PID）一律由调用方显式传入 —— 本模块不读任何环境变量、
// 不 import src/config.js / src/instance-lock.js / src/logger.js 等任何项目内模块，
// 保证 electron/main.js 的静态求值期不新增任何副作用、不固化 DATA_DIR。
//
// 行为与收编前 electron/main.js 里的本地实现逐字等价：日志文案、写入顺序、
// 「失败只 log / 返回 false、绝不抛」的口径都原样保留。回归护栏见
// tests/boot-state.test.mjs 与 tests/self-update-module-graph.test.mjs。
import fs from 'node:fs';
import path from 'node:path';

/** 交接标记有效期上限（毫秒）。超时的残留标记按不存在处理。 */
export const RELAUNCH_HANDOVER_MS = 15_000;

/**
 * 交接标记文件路径。dataDir 为空时返回空串，调用方据此跳过（与原实现一致）。
 * @param {string} dataDir 数据目录。
 * @returns {string} .relaunch-handover 的绝对路径；无目录时为 ''。
 */
export function handoverPath(dataDir) {
  return dataDir ? path.join(dataDir, '.relaunch-handover') : '';
}

/**
 * 写交接标记（relaunch 前调用）。写不进去不影响重启，只是少一层保护。
 * 失败只 console.log，异常被吞掉，绝不向上抛。
 * @param {string} dataDir 数据目录。
 * @param {string} reason 重启原因（进入日志文案与标记内容）。
 * @param {number} [now] 注入的时间戳；不传则在 mkdir 之后取 Date.now()。
 * @param {number} [pid] 注入的进程号；不传则取 process.pid。
 * @returns {void}
 */
export function writeHandover(dataDir, reason, now, pid = process.pid) {
  const file = handoverPath(dataDir);
  if (!file) {
    console.log(`[relaunch] 交接标记跳过（${reason}）：数据目录未就绪`);
    return;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const at = typeof now === 'number' ? now : Date.now();
    fs.writeFileSync(file, JSON.stringify({ pid, at, reason }));
    console.log(`[relaunch] 已写交接标记（${reason}）→ ${file}`);
  } catch (error) {
    console.log(`[relaunch] 交接标记写入失败（${reason}）：${error?.message ?? error}`);
  }
}

/**
 * 读交接标记：新鲜 + 本进程不是重启接收方，才算「要拦的双击」。
 *   ① 新鲜（now - at <= maxAgeMs）：残留标记不能把用户永久锁在门外；
 *   ② isRelaunchChild 为 true 时它就是交接接收方，标记是通行证不是路障。
 * 坏 JSON / 文件不存在 / 任何读取异常一律返回 null（不抛）。
 * @param {string} dataDir 数据目录。
 * @param {{ isRelaunchChild?: boolean, now?: number, maxAgeMs?: number }} [options]
 *   显式注入的判定输入：子进程身份、当前时间、新鲜度上限。真实调用点**不传
 *   now**；仅单测注入 now 来钉死新鲜度，避免依赖真实时钟。
 * @returns {object|null} 有效的标记对象，或 null。
 */
export function readHandover(dataDir, options = {}) {
  const { isRelaunchChild = false, now, maxAgeMs = RELAUNCH_HANDOVER_MS } = options ?? {};
  if (isRelaunchChild) return null;
  const file = handoverPath(dataDir);
  if (!file) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 与旧实现同一取样位置：readFileSync + JSON.parse 之后才取 Date.now()。
    // 显式注入 now 时仍按注入值（单测可测性不损失）；不传时绝不在函数入口取样，
    // 否则 15s 新鲜度边界会被 IO 耗时带偏（F2）。护栏见
    // tests/boot-state.test.mjs 的「取样点护栏」用例。
    const effectiveNow = typeof now === 'number' ? now : Date.now();
    const at = Number(obj?.at) || 0;
    if (!at || effectiveNow - at > maxAgeMs) return null;
    console.log(`[relaunch] 读到交接标记（${obj?.reason || '未知'}，${effectiveNow - at}ms 前）：本进程让路`);
    return obj;
  } catch { return null; }
}

/**
 * 清交接标记（新进程窗口真正起来后调用）。文件不存在也算成功。
 * @param {string} dataDir 数据目录。
 * @returns {void}
 */
export function clearHandover(dataDir) {
  const file = handoverPath(dataDir);
  if (!file) return;
  try { fs.unlinkSync(file); } catch { /* 不存在就算了 */ }
}

/**
 * render-config.json 路径。dataDir 为空时返回空串。
 * @param {string} dataDir 数据目录。
 * @returns {string} 绝对路径；无目录时为 ''。
 */
export function renderConfigPath(dataDir) {
  return dataDir ? path.join(dataDir, 'render-config.json') : '';
}

/**
 * 读 render-config.json：读不到 / 坏 JSON / 非对象一律当作 {}。
 * @param {string} dataDir 数据目录。
 * @returns {object} 解析出的配置对象，或 {}。
 */
export function readRenderConfig(dataDir) {
  const file = renderConfigPath(dataDir);
  try {
    if (!file) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

/**
 * 浅合并写 render-config.json：读旧值 → 浅合并 → mkdir(dirname) → writeFileSync。
 * 任何异常（含目录不可写）返回 false，**不抛**。
 * @param {string} dataDir 数据目录。
 * @param {object} patch 要合并的字段。
 * @returns {boolean} 写入成功为 true，失败为 false。
 */
export function patchRenderConfig(dataDir, patch) {
  const file = renderConfigPath(dataDir);
  try {
    if (!file) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...readRenderConfig(dataDir), ...patch }, null, 2));
    return true;
  } catch { return false; }
}

// ── render-health.json（连续健康启动计数，2026-11-13 第二轮「改判据」）──────
//
// 它存在的唯一目的：让**误降级**的机器自己爬回来。渲染沙箱一旦因为连续崩溃被
// 写成 sandbox:false，那条降级是持久的，而且此前没有任何反悔通道（本机 data
// 里就躺着一条 2026-11-05 写下的、之后稳定跑了 8 天的降级）。要不要撤销属于
// 「跨多次启动」的判断，必须有个地方记账，跨进程只能落文件。
//
// 与 render-config.json 同一口径：读失败返回默认值、写失败返回 false、绝不抛。

/** render-health.json 的默认内容（文件缺失 / 坏 JSON 时的兜底）。返回新对象，避免调用方改到共享引用。 */
function defaultRenderHealth() {
  return {
    version: 1,
    consecutiveHealthyBoots: 0,
    gpuCrashEver: false,
    lastHealthyAt: '',
    lastDowngradeAt: ''
  };
}

/**
 * render-health.json 路径。dataDir 为空时返回空串。
 * @param {string} dataDir 数据目录。
 * @returns {string} 绝对路径；无目录时为 ''。
 */
export function renderHealthPath(dataDir) {
  return dataDir ? path.join(dataDir, 'render-health.json') : '';
}

/**
 * 读 render-health.json：缺失 / 坏 JSON / 非对象 / 字段类型不对，一律回落默认值。
 *
 * 为什么每个字段都单独校验：这份文件是「自动撤销降级」的唯一证据源，一个
 * `consecutiveHealthyBoots: "5"`（字符串）或 NaN 就足以把判定骗过去。这里先把
 * 脏值归一成安全默认；判定侧（render-policy.js 的 shouldRevokeCrashCompat）
 * 还会再用 Number.isFinite 兜一层 —— 两道防线是刻意的，判定函数不能假设
 * 调用方一定传进来干净数据。
 * @param {string} dataDir 数据目录。
 * @returns {{version: number, consecutiveHealthyBoots: number, gpuCrashEver: boolean, lastHealthyAt: string, lastDowngradeAt: string}}
 */
export function readRenderHealth(dataDir) {
  const fallback = defaultRenderHealth();
  const file = renderHealthPath(dataDir);
  try {
    if (!file) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return fallback;
    return {
      version: Number.isFinite(parsed.version) ? parsed.version : fallback.version,
      consecutiveHealthyBoots: Number.isFinite(parsed.consecutiveHealthyBoots)
        ? Math.max(0, Math.floor(parsed.consecutiveHealthyBoots))
        : fallback.consecutiveHealthyBoots,
      gpuCrashEver: parsed.gpuCrashEver === true,
      lastHealthyAt: typeof parsed.lastHealthyAt === 'string' ? parsed.lastHealthyAt : fallback.lastHealthyAt,
      lastDowngradeAt: typeof parsed.lastDowngradeAt === 'string' ? parsed.lastDowngradeAt : fallback.lastDowngradeAt
    };
  } catch { return fallback; }
}

/**
 * 浅合并写 render-health.json：读旧值 → 归一 → 合并 → mkdir(dirname) → writeFileSync。
 *
 * 两条硬约定（都不是可选的细节）：
 *   · `gpuCrashEver` **只增不减**：一旦为 true，patch 里传 false 也写不回去。
 *     它记录的是「这台机器见过 GPU 崩溃」这个历史事实，不是可以翻转的开关。
 *   · `consecutiveHealthyBoots` 永远落成非负整数（脏值归零），避免写出
 *     NaN / "5" / -1 把后续判定带偏。
 * 任何异常（含目录不可写）返回 false，**不抛**。
 * @param {string} dataDir 数据目录。
 * @param {object} patch 要合并的字段。
 * @returns {boolean} 写入成功为 true，失败为 false。
 */
export function patchRenderHealth(dataDir, patch) {
  const file = renderHealthPath(dataDir);
  try {
    if (!file) return false;
    const current = readRenderHealth(dataDir);
    const merged = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
    // 显式重建五个规范字段：未知键不落盘（v1 schema 之外的东西不该被这个版本写出去）。
    const next = {
      version: Number.isFinite(merged.version) ? merged.version : current.version,
      consecutiveHealthyBoots: Number.isFinite(merged.consecutiveHealthyBoots)
        ? Math.max(0, Math.floor(merged.consecutiveHealthyBoots))
        : 0,
      gpuCrashEver: current.gpuCrashEver === true || merged.gpuCrashEver === true,
      lastHealthyAt: typeof merged.lastHealthyAt === 'string' ? merged.lastHealthyAt : current.lastHealthyAt,
      lastDowngradeAt: typeof merged.lastDowngradeAt === 'string' ? merged.lastDowngradeAt : current.lastDowngradeAt
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
    return true;
  } catch { return false; }
}

/**
 * boot-diag.log 路径。dataDir 为空时返回空串。
 * @param {string} dataDir 数据目录。
 * @returns {string} 绝对路径；无目录时为 ''。
 */
export function bootDiagPath(dataDir) {
  return dataDir ? path.join(dataDir, 'boot-diag.log') : '';
}

/**
 * 追加一行 boot-diag 日志。不做 mkdir（与原实现一致）。
 *
 * ⚠️ 异常契约：**本函数不吞异常**。裸调用时若目标不可写（如目标是目录 /
 * 父路径是普通文件）会抛 EISDIR / ENOTDIR。旧实现是内联语句，始终包在
 * main.js 调用点的 try/catch（空 catch）里，所以启动链永不抛。
 * **调用方必须自己包 try/catch**；main.js 的两个调用点均已如此。
 * 单测 `tests/boot-state.test.mjs` 有「裸调用会抛」用例固定住这个契约。
 * @param {string} dataDir 数据目录；为空时直接跳过，绝不写相对路径文件。
 * @param {string} line 含结尾换行的完整日志行。
 * @returns {void}
 */
export function appendBootDiag(dataDir, line) {
  const file = bootDiagPath(dataDir);
  if (!file) return;
  fs.appendFileSync(file, line);
}

/**
 * render-gpu-off.flag 路径。dataDir 为空时返回空串。
 * @param {string} dataDir 数据目录。
 * @returns {string} 绝对路径；无目录时为 ''。
 */
export function gpuOffFlagPath(dataDir) {
  return dataDir ? path.join(dataDir, 'render-gpu-off.flag') : '';
}

/**
 * 覆盖写 render-gpu-off.flag。不做 mkdir（与原实现一致）。
 *
 * ⚠️ 异常契约：**本函数不吞异常**。裸调用时若目标不可写会抛 EISDIR /
 * ENOTDIR。旧实现是内联语句，始终包在 main.js 调用点的 try/catch（空 catch）
 * 里，所以启动链永不抛。**调用方必须自己包 try/catch**；main.js 的调用点
 * 已如此。单测 `tests/boot-state.test.mjs` 有「裸调用会抛」用例固定住契约。
 * @param {string} dataDir 数据目录；为空时直接跳过，绝不写相对路径文件。
 * @param {string} line 含结尾换行的完整标记内容。
 * @returns {void}
 */
export function writeGpuOffFlag(dataDir, line) {
  const file = gpuOffFlagPath(dataDir);
  if (!file) return;
  fs.writeFileSync(file, line);
}

/**
 * 重启前主动交还实例锁：只删**自己**的锁（PID 比对），不是自己的绝不碰。
 * 锁不存在 / 读不出 / 坏 JSON / 删不掉都不抛，返回 false、不阻断重启。
 * @param {string} dataDir 数据目录。
 * @param {number} pid 本进程 PID；与锁内 pid 不等时绝不删除。
 * @param {string} [reason] 重启原因（进入日志文案）。
 * @returns {boolean} 返回是否删除。旧内联实现为 void（返回 undefined），
 *   当前 main.js 的 3 个调用点均为 try/catch 且均不消费返回值；此处保留
 *   boolean 仅为可测性，第二步重构请勿把它当成新的控制流信号。
 */
export function releaseOwnLock(dataDir, pid, reason = '') {
  if (!dataDir) return false;
  const lockPath = path.join(dataDir, 'qq-agent.lock');
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (Number(parsed?.pid) !== pid) return false;      // 不是自己的锁：不碰
    fs.unlinkSync(lockPath);
    console.log(`[relaunch] 已交还实例锁（${reason}），重启进程不会撞锁`);
    return true;
  } catch { /* 锁不存在 / 读不出 / 删不掉：都不该阻断重启 */ return false; }
}
