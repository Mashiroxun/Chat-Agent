// 协议端进程托管：无窗口启动 SnowLuma，把它的控制台输出接进软件。
//
// ── 为什么需要这个模块（2026-10-27，R125）────────────────────────────────
// 0.4.8.9 按 SnowLuma EULA 5.4 把协议端移出了安装包（不随包分发、不再托管），
// 用户改成自己下载、双击 launcher.bat 启动 —— 代价是桌面上常驻一个 cmd 窗口，
// 里面滚动着 SnowLuma 的全部日志。用户的原话是「这东西能不能移到软件内」。
//
// 本模块只做三件事，边界很清楚：
//   ① **启动**用户自己那份 SnowLuma（用它自带的 node.exe 跑 index.mjs），
//      `windowsHide: true` → 没有黑窗口；
//   ② 把 stdout/stderr 收成环形缓冲，经 SSE 推给连接页（这就是原来的 cmd 内容）；
//   ③ 停止 / 状态 / 退出清理。
//
// ── 与 EULA 的边界（别越线）───────────────────────────────────────────────
//   · **不随包分发**：目录由用户指定，模块只读它的 index.mjs / node.exe 路径；
//   · **不改它的文件**：不写 config、不改 webui.json、不注入 EULA 同意环境变量
//     （0.4.8.x 曾注入 SNOWLUMA_ACCEPT_EULA=1 —— 那是替用户签字，本模块不做）；
//   · 用户不点「启动」就什么都不发生（autoLaunch 默认关）。
//
// ── 为什么日志要在这里截，而不是去 tail logs/*.log ───────────────────────
// SnowLuma 自己会写 logs/snowluma-YYYY-MM-DD.log，但那是**落盘日志**：
//   · 用户要的是"原来 cmd 里滚的那些行"，含启动早期的 WebUI 地址、密码、注入进度；
//   · 文件是按天追加的，tail 要处理轮转、编码、半行；
//   · 由本进程 spawn 的 stdout 天然带时序，且能立刻知道"进程死了"。
// 所以主路径是 pipe；`readLogFile()` 只是给"用户自己启动的那份"留的只读补充。

import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 环形缓冲上限：够回溯一次启动全过程，又不会把内存吃穿（单行截断 2000 字符）。 */
const MAX_LINES = 800;
/** SSE 批量推送间隔：SnowLuma 一秒能刷十几行，逐行 emit 会把 SSE 打成流水。 */
const FLUSH_MS = 120;
/** 单次 flush 最多推多少行（超出的下一拍继续）。 */
const FLUSH_MAX = 60;
const MAX_LINE_CHARS = 2000;

/** 终端颜色码：cmd 里好看，塞进 <pre> 就是一堆乱码。 */
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** 发行包入口的候选名：2.x 是 index.mjs，早期/精简包可能只有 index.js。 */
const ENTRY_NAMES = ['index.mjs', 'index.js'];

/** 在一层目录里找入口文件，找不到返回 null。 */
function entryIn(dir) {
  for (const name of ENTRY_NAMES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return { dir, indexFile: p, entryName: name };
  }
  return null;
}

/**
 * 这个目录能不能用来启动 SnowLuma。
 *
 * 判据放宽到「有 index.mjs / index.js」，并且**允许往下钻一层**：
 * Windows 上解压 `SnowLuma-vX-win-x64.zip` 极容易解出
 * `SnowLuma-vX-win-x64\SnowLuma-vX-win-x64\index.mjs` 这种双层目录，
 * 用户按资源管理器里看到的路径填进来是最自然的行为 —— 这时直接判"不是
 * SnowLuma 目录"会让人一脸问号（他明明看到 index.mjs 就在里面）。
 */
export function probeLaunchDir(dir) {
  // path.resolve 顺带规范掉 `C://a//b`、相对路径、结尾反斜杠 —— 否则日志里会
  // 显示成双斜杠（实测用户从别处复制路径时常带），看着像程序出错。
  const raw = String(dir || '').trim();
  if (!raw) return { ok: false, reason: '还没填目录' };
  let d = raw;
  try { d = path.resolve(raw); } catch { /* 非法路径原样用于报错 */ }
  if (!isDir(d)) return { ok: false, reason: '目录不存在' };

  let hit = entryIn(d);
  if (!hit) {
    // 只往下钻一层，而且**只在外层目录名本身就像 SnowLuma 时**才钻。
    // 为什么加这个前提：不加的话，用户误填 `C:\Users\x\Desktop` 也会被"猜"到
    // 桌面上那个 SnowLuma 目录，返回成功 —— 界面上看不出自己填错了，
    // 桌面上同时放了两个版本时还会挑错。宁可说"这个目录里没有 index.mjs"，
    // 让他把路径指到真正的发行包目录（或它的上一层同名目录）。
    if (/snowluma/i.test(path.basename(d))) {
      for (const e of safeReaddir(d)) {
        if (!e.isDirectory()) continue;
        if (/^(node_modules|\.git|config|data|logs|native|client)$/i.test(e.name)) continue;
        hit = entryIn(path.join(d, e.name));
        if (hit) break;
      }
    }
  }
  if (!hit) {
    return { ok: false, reason: `这个目录里没有 ${ENTRY_NAMES.join(' / ')}（不是 SnowLuma 目录？）` };
  }

  const nodeExe = path.join(hit.dir, 'node.exe');
  const hasOwnNode = fs.existsSync(nodeExe);
  return {
    ok: true,
    dir: hit.dir,
    indexFile: hit.indexFile,
    entryName: hit.entryName,
    nodeExe: hasOwnNode ? nodeExe : '',
    hasOwnNode,
    // 目录里有没有它自己的 package.json（用来提示"这是不是完整发行包"）
    hasManifest: fs.existsSync(path.join(hit.dir, 'package.json'))
  };
}

/**
 * 找一个可用的 node 运行时。
 *
 * ⚠️ 这里有个 Electron 特有的坑，必须写死：**`process.execPath` 在 Electron 主进程里
 * 是 `QQ Agent.exe`，不是 node**。早期实现拿它兜底，等于用"再启动一个 QQ Agent"
 * 去跑 index.mjs —— 用户看到的是"点了启动，弹出一个新窗口/什么都没发生"，
 * 而且不会报错（新实例自己也会去抢实例锁）。所以：
 *   · 非 Electron（headless `node src/server.js`）才允许用 process.execPath；
 *   · Electron 里只认目录自带的 node.exe，或系统 PATH 里真的装了 Node.js。
 *
 * @returns {{cmd:string, env:object, label:string}|null}
 */
export function resolveNodeRuntime(probe, { isElectron = Boolean(process.versions.electron), findNode = null } = {}) {
  if (!probe || !probe.ok) return null;
  if (probe.hasOwnNode) return { cmd: probe.nodeExe, env: {}, label: '目录自带 node.exe' };
  if (!isElectron) return { cmd: process.execPath, env: {}, label: '当前 node' };
  const sys = typeof findNode === 'function' ? findNode() : findSystemNode();
  if (sys) return { cmd: sys, env: {}, label: '系统安装的 Node.js' };
  return null;
}

/** 系统 PATH 里有没有 node（Windows 用 where，其它平台用 which）。同步、带超时。 */
function findSystemNode() {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(finder, ['node'], {
      windowsHide: true,
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const first = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch { /* 没装 / 不可用 */ }
  return '';
}

/**
 * @param {object} deps
 * @param {Function} deps.getConfig       () => config
 * @param {Function} deps.updateConfig    (patch) => config
 * @param {Function} deps.emit            (type, payload) => void（SSE 广播）
 * @param {Function} deps.log             (msg) => void（应用日志）
 * @param {Function} [deps.detectDir]     () => Promise<string> 自动找目录（注入以便单测）
 * @param {Function} [deps.spawnImpl]     注入 child_process.spawn（单测用假实现）
 * @param {Function} [deps.findNodeOverride] () => string 注入"系统 node 路径"（单测用）
 */
export function createProtocolLauncher({
  getConfig = () => ({}),
  updateConfig = (x) => x,
  emit = () => {},
  log = () => {},
  detectDir = null,
  spawnImpl = nodeSpawn,
  findNodeOverride = null,
  isElectron = undefined
} = {}) {
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  let launching = false;
  let stopping = false;
  let startedAt = 0;
  let lastDir = '';
  /** 上一次退出信息：{ code, signal, at, reason } */
  let lastExit = null;
  /** @type {Array<{ts:number, level:string, text:string}>} */
  const lines = [];
  let pending = [];
  let flushTimer = null;

  function pushLine(text, level = 'stdout') {
    const raw = stripAnsi(String(text ?? '')).replace(/\r/g, '').trimEnd();
    if (!raw.trim()) return;
    const row = {
      ts: Date.now(),
      level: level === 'stderr' ? 'stderr' : 'stdout',
      text: raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}…` : raw
    };
    lines.push(row);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    pending.push(row);
    if (!flushTimer) {
      flushTimer = setTimeout(flush, FLUSH_MS);
      flushTimer.unref?.();
    }
  }

  function flush() {
    flushTimer = null;
    if (!pending.length) return;
    const batch = pending.slice(0, FLUSH_MAX);
    pending = pending.slice(FLUSH_MAX);
    emit('protocol-log', { lines: batch });
    if (pending.length) {
      flushTimer = setTimeout(flush, FLUSH_MS);
      flushTimer.unref?.();
    }
  }

  /**
   * 按行切分流。
   *
   * ⚠️ 必须跨 chunk 缓冲：Node 的 `data` 事件只保证"来了一块字节"，不保证
   * 在换行处断开。直接对每个 chunk 做 split 会把一行日志切成两截
   * （实测 SnowLuma 的启动横幅和 JSON 输出都会这样碎掉），面板里看着像乱码。
   * 尾部没有换行的那一段留在 buf 里，等下一块拼上；进程退出时 flush 兜底。
   */
  function makeLineSplitter(level) {
    let buf = '';
    const emitLine = (line) => pushLine(line, level);
    return {
      feed(chunk) {
        buf += chunk;
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() ?? '';
        for (const line of parts) emitLine(line);
        // 极端情况：某行一直不换行（进度条刷 \r），别让 buf 无限增长
        if (buf.length > MAX_LINE_CHARS * 2) {
          emitLine(buf);
          buf = '';
        }
      },
      end() {
        if (buf) { emitLine(buf); buf = ''; }
      }
    };
  }

  function launcherCfg() {
    const c = getConfig() || {};
    return c.protocol?.launcher || {};
  }

  function status() {
    const cfgDir = String(launcherCfg().dir || '').trim();
    return {
      running: Boolean(child && !child.killed),
      pid: child?.pid ?? null,
      dir: lastDir || cfgDir,
      configuredDir: cfgDir,
      startedAt: startedAt || null,
      autoLaunch: launcherCfg().autoLaunch === true,
      launching,
      stopping,
      exit: lastExit,
      supported: process.platform === 'win32'
    };
  }

  function logs(limit = 300) {
    const n = Math.max(1, Math.min(MAX_LINES, Number(limit) || 300));
    return lines.slice(-n);
  }

  function saveDir(dir) {
    const v = String(dir || '').trim();
    updateConfig({ protocol: { launcher: { dir: v } } });
    return v;
  }

  async function resolveDir(dirOverride) {
    const explicit = String(dirOverride || '').trim();
    if (explicit) return explicit;
    const cfgDir = String(launcherCfg().dir || '').trim();
    if (cfgDir) return cfgDir;
    if (typeof detectDir === 'function') {
      try {
        const found = await detectDir();
        if (found) return String(found);
      } catch { /* 探测失败不该挡住手动指定 */ }
    }
    return '';
  }

  /**
   * 启动协议端。
   * @param {{dir?: string, auto?: boolean}} opts
   */
  async function launch({ dir = '', auto = false } = {}) {
    if (process.platform !== 'win32') {
      return { ok: false, error: '只有 Windows 版支持无窗口启动协议端（SnowLuma 的原生模块只发布了 Windows 构建）。' };
    }
    if (launching) return { ok: false, error: '正在启动中，稍等一下' };
    if (child && !child.killed) {
      return { ok: true, alreadyRunning: true, pid: child.pid, dir: lastDir };
    }
    if (stopping) return { ok: false, error: '正在停止，稍等一下' };

    const wanted = await resolveDir(dir);
    const probe = probeLaunchDir(wanted);
    if (!probe.ok) {
      const msg = !wanted
        ? '还没指定 SnowLuma 目录：填一下它装在哪（里面有 index.mjs 的那一层），或者点「自动查找」。'
        : `${wanted} 用不了：${probe.reason}`;
      pushLine(`[启动失败] ${msg}`, 'stderr');
      return { ok: false, error: msg };
    }

    // 目录一确认就落盘：下次启动 / 自动拉起不用再找
    if (String(launcherCfg().dir || '') !== probe.dir) saveDir(probe.dir);

    // node 运行时：自带 > 系统 Node.js；Electron 里**绝不能**用 process.execPath
    // （那是 QQ Agent.exe，见 resolveNodeRuntime 的注释）
    const runtime = resolveNodeRuntime(probe, {
      findNode: findNodeOverride,
      // 真实运行时由 process.versions.electron 判定；单测可显式覆盖
      ...(isElectron === undefined ? {} : { isElectron })
    });
    if (!runtime) {
      const msg = '这个 SnowLuma 目录里没有 node.exe，系统里也没找到 Node.js。'
        + '请下载 SnowLuma 官方发行包（zip 解压后自带 node.exe），或先安装 Node.js 后再试。'
        + '注意：QQ Agent 自带的运行时不满足 SnowLuma 的 node 版本要求，不能拿来顶替。';
      pushLine(`[启动失败] ${msg}`, 'stderr');
      return { ok: false, error: msg };
    }

    launching = true;
    try {
      const c = spawnImpl(runtime.cmd, [probe.indexFile], {
        cwd: probe.dir,
        // stdin 不给：SnowLuma 没有交互式输入，给了反而可能被它的 readline 卡住
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,   // ← 用户要的就是这一行：没有黑窗口
        detached: false,     // 跟随本进程退出：pipe 断了日志就没意义了
        env: {
          ...process.env,
          NO_COLOR: '1',       // 别输出 ANSI 色码（<pre> 里会变成乱码）
          FORCE_COLOR: '0'
        }
      });
      child = c;
      startedAt = Date.now();
      lastDir = probe.dir;
      lastExit = null;

      pushLine(`[托管] SnowLuma 启动中（${runtime.label}）：${runtime.cmd} ${probe.indexFile}`, 'stdout');
      pushLine(`[托管] 工作目录 ${probe.dir}`, 'stdout');
      if (!probe.hasOwnNode) {
        pushLine('[托管] 提示：这个发行包里没有 node.exe，本次用系统 Node.js 启动；'
          + '若之后报版本不符，换官方完整发行包（自带 node.exe）最稳。', 'stderr');
      }
      if (auto) pushLine('[托管] 本次是随 QQ Agent 自动启动（设置里的「自动启动协议端」）', 'stdout');

      c.stdout?.setEncoding?.('utf8');
      c.stderr?.setEncoding?.('utf8');
      const outSplit = makeLineSplitter('stdout');
      const errSplit = makeLineSplitter('stderr');
      c.stdout?.on('data', (d) => outSplit.feed(String(d)));
      c.stderr?.on('data', (d) => errSplit.feed(String(d)));
      c.on('error', (error) => {
        pushLine(`[托管] 启动失败：${error?.message ?? error}`, 'stderr');
        log(`[protocol] 启动失败：${error?.message ?? error}`);
      });
      c.on('exit', (code, signal) => {
        outSplit.end();
        errSplit.end();
        child = null;
        stopping = false;
        lastExit = { code: code ?? null, signal: signal ?? null, at: Date.now() };
        pushLine(`[托管] SnowLuma 进程已退出（code=${code ?? '-'} signal=${signal ?? '-'}）`, 'stderr');
        log(`[protocol] SnowLuma 退出 code=${code ?? '-'} signal=${signal ?? '-'}`);
        emit('protocol-status', status());
      });

      emit('protocol-status', status());
      log(`[protocol] 已无窗口启动 SnowLuma（pid=${c.pid}, dir=${probe.dir}）`);
      return { ok: true, launched: true, pid: c.pid, dir: probe.dir, hasOwnNode: probe.hasOwnNode };
    } catch (error) {
      const msg = String(error?.message ?? error);
      pushLine(`[托管] 启动失败：${msg}`, 'stderr');
      return { ok: false, error: msg };
    } finally {
      launching = false;
    }
  }

  /** 停止（只停本进程拉起的那个；用户自己开的窗口不动）。 */
  async function stop() {
    if (!child || child.killed) return { ok: true, stopped: false, reason: '不是本软件启动的，没有可停的进程' };
    const pid = child.pid;
    stopping = true;
    try {
      // Windows 上 SIGTERM 对 Node 子进程够用，但 SnowLuma 可能挂了辅助子进程，
      // /t 连子孙一起收，避免留下孤儿进程占着 3001 端口。
      if (process.platform === 'win32') {
        await new Promise((resolve) => {
          const killer = spawnImpl('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
          killer.on('exit', resolve);
          killer.on('error', resolve);
        });
      } else {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }
      pushLine('[托管] 已请求停止 SnowLuma', 'stdout');
      return { ok: true, stopped: true, pid };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    } finally {
      // exit 事件里会清 child；这里兜一层，避免 exit 没来（进程已被别人杀）
      setTimeout(() => { if (child && child.killed) child = null; }, 3000).unref?.();
    }
  }

  /** 应用退出时调用：别把协议端留在后台（pipe 已断，日志接不上）。 */
  function dispose() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!child || child.killed) return;
    try {
      if (process.platform === 'win32') {
        spawnImpl('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).unref?.();
      } else {
        child.kill('SIGTERM');
      }
    } catch { /* 退出流程里不抛 */ }
    child = null;
  }

  return { status, logs, launch, stop, dispose, saveDir, pushLine };
}
