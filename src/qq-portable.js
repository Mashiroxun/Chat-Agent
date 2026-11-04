// 便携 QQ 进程管理（0.4.9.3：从 app.js 外提）
//
// 便携 QQ 与用户日常 QQ 完全隔离：独立安装目录 + 独立 user-data-dir。
// 绝不 taskkill QQ.exe 全名 —— 只杀路径匹配 runtime/qq-portable 的进程。
//
// 外提原因：这套东西（20 个函数、约 640 行）跟主流程无关，只依赖 ROOT / log / emit，
// 却一直占着 createApp 的体积。提出来之后可以单独测试，app.js 也少 600 行。
//
// 状态都在闭包里：qqPortableLogs / qqPortableProc / qqProcListCache / localQqCache /
// qqSetupState 等，多实例互不干扰。

import fsModule from 'node:fs';
import pathModule from 'node:path';
import netModule from 'node:net';
import { spawn as spawnModule, execFile as execFileModule } from 'node:child_process';
import { getConfig as getConfigModule, ROOT as ROOTModule } from './config.js';

/**
 * 便携 QQ 进程管理。
 *
 * 所有系统依赖都可以从参数替换（默认是真实实现）——函数体里仍然直接写 fs / path /
 * spawn / execFile / ROOT / getConfig，靠参数同名遮蔽，所以搬过来的 600 行一行没改。
 * 这样测试里可以塞假 fs 和假 spawn，不碰真实进程与磁盘。
 */
export function createQqPortable({
  log = console.log,
  emit = () => {},
  fs = fsModule,
  path = pathModule,
  net = netModule,
  spawn = spawnModule,
  execFile = execFileModule,
  ROOT = ROOTModule,
  getConfig = getConfigModule,
} = {}) {
  function isPortOpen(host, port, timeoutMs = 800) {
    return new Promise((resolve) => {
      const p = Number(port);
      const h = String(host ?? '').trim();
      if (!Number.isInteger(p) || p < 1 || p > 65535 || !h) { resolve(false); return; }
      const socket = new net.Socket();
      let settled = false;
      let guard = null;
      const done = (result) => {
        if (settled) return;
        settled = true;
        if (guard) clearTimeout(guard);
        try { socket.destroy(); } catch { /* ignore */ }
        resolve(result);
      };
      try {
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        socket.once('close', () => { if (guard) clearTimeout(guard); });
        // 双保险：个别异常 socket 状态可能既不 error 也不 timeout（半开连接）。
        // 到点直接判"没开" —— 探测本身绝不能成为卡住调用方的那一环。
        guard = setTimeout(() => done(false), timeoutMs + 500);
        guard.unref?.();
        socket.connect(p, h);
      } catch {
        done(false);
      }
    });
  }


  // ── 便携 QQ 进程管理 ──
  // 便携 QQ 与用户日常 QQ 完全隔离：独立安装目录 + 独立 user-data-dir。
  // 绝不 taskkill QQ.exe 全名——只杀路径匹配 runtime/qq-portable 的进程。
  const qqPortableLogs = [];
  let qqPortableProc = null;
  let qqPortableLaunching = false;   // 便携 QQ 启动互斥标记（防连点「启动 QQ」并发拉起）

  function qqPortableDir() {
    return path.join(ROOT, 'runtime', 'qq-portable');
  }

  function qqPortableDataDir() {
    return path.join(ROOT, 'runtime', 'qq-portable-data');
  }

  function qqPortableExe() {
    return path.join(qqPortableDir(), 'QQ.exe');
  }

  function pushQqLog(text, stream = 'stdout') {
    const line = { at: Date.now(), stream, text: String(text ?? '').replace(/\r?\n$/, '') };
    if (!line.text) return;
    qqPortableLogs.push(line);
    if (qqPortableLogs.length > 500) qqPortableLogs.splice(0, qqPortableLogs.length - 500);
    emit('qq-portable-log', line);
  }

  /** 检查便携 QQ 是否已安装 */
  function qqPortableReady() {
    return fs.existsSync(qqPortableExe());
  }

  /** 列出所有 QQ.exe 进程，返回 [{ pid, path }]（Windows only） */
  /**
   * 列出所有 QQ.exe 进程，返回 [{ pid, path }]（Windows only）。
   *
   * ── 这里踩过一个很隐蔽的坑，务必别再改回去 ──────────────────────────
   * 原来首选 `wmic process ... /format:csv`。它有两个问题：
   *
   * 1. **编码**：wmic 按**系统 ANSI 代码页（中文系统是 GBK）**输出，
   *    而 Node 按 UTF-8 读 —— 路径里的中文会变成乱码。
   *    实测：`qq-agent - 副本` → `qq-agent - ????`。
   *    于是拿乱码路径去和真实路径比，**永远比不上**，
   *    表现就是"QQ 明明在跑，界面却说未启动"。
   *    ⚠️ 纯英文路径下这个 bug 完全不暴露，所以特别难查。
   * 2. **CSV**：路径里有逗号就会错位。
   * 3. 而且 wmic 在 Win11 24H2+ 已被移除，本来也不能当主路径。
   *
   * 现在改用 PowerShell + **显式强制 UTF-8 输出** + JSON。
   * ⚠️ 只写 PowerShell 是不够的：PS 5.1 默认同样按 ANSI 输出，
   *    必须带上 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`
   *    （这行是实测对比出来的，去掉就又是乱码）。
   * 用 JSON 而不是 CSV，顺带解决逗号错位。
   */
  // R113：listQqProcesses 的短 TTL 缓存 + 在途共享。
  //
  // 背景（用户 2026-10-14 实测复现）：用量页报「用量加载失败：请求超时（15 秒无响应）」。
  // 逐接口计时发现根因不在统计接口（/api/usage/stats 实测 2ms，force 重算也只要 0.26s），
  // 而在 /api/status —— 它每轮要 spawn 一次 PowerShell 查 QQ 进程列表（本机单次
  // CIM 查询 ~1.5s：PS 5.1 启动 + CIM 冷缓存）。而 /api/status 是秒级轮询（渲染端
  // 15s 轮询 + 每次 SSE 事件都 refreshStatus + 用量页的 Promise.all 也带它），
  // 机器再忙一点（图片缓存/模型调用/全量重扫同时跑）就顶穿前端 15s 超时，
  // 整个 Promise.all 连带统计接口一起挂 → 用户看到"用量页一直加载失败"。
  //
  // 3 秒 TTL：UI 状态显示允许 3 秒陈旧；在途共享避免并发调用叠出多个 PowerShell
  // （force=true 只给"刚装完 QQ 要立刻看到结果"这类显式场景用）。
  //
  // ── 2026-11-04（R170）：加 stale-while-revalidate ──────────────────────
  // 实测（bench_status）：缓存命中 5.7ms，但 TTL 一过期就 **735ms**（首次冷启 1161ms）。
  // 而渲染端是 15s 轮询 —— 意味着每轮轮询都必然跨过 3s TTL、吃一次几百毫秒的
  // 同步 spawn。机器一忙就顶穿前端 15s 超时，把整条 Promise.all 拖挂
  // （10-14 那次"用量页一直加载失败"就是这么来的）。
  //
  // 现在分三段：
  //   age < 3s              → 直接返回（与以前一致）
  //   3s ≤ age < 30s        → **立即返回旧值**，同时后台静默刷新（不阻塞调用方）
  //   age ≥ 30s 或首次     → 同步查（兜底，保证不会无限期拿不到真值）
  // 效果：轮询路径恒定为几毫秒；状态最多滞后一个刷新周期（几百毫秒），
  // 而不是让每个请求去等 PowerShell。
  let qqProcListCache = { at: 0, rows: null };
  let qqProcListInFlight = null;
  const QQ_PROC_LIST_TTL = 3000;
  /** 陈旧上限：超过它就必须同步查（避免后台刷新一直失败时永远吃旧值）。 */
  const QQ_PROC_LIST_STALE_MAX = 30000;

  /** 后台刷新：复用 in-flight 槽位，失败静默（下次调用会再试）。 */
  function kickProcListRefresh() {
    if (qqProcListInFlight) return;
    qqProcListInFlight = __listQqProcessesOnce()
      .then((rows) => { qqProcListCache = { at: Date.now(), rows }; return rows; })
      .catch(() => null)
      .finally(() => { qqProcListInFlight = null; });
  }

  async function listQqProcesses({ force = false } = {}) {
    if (process.platform !== 'win32') return [];
    const now = Date.now();
    if (!force) {
      const age = now - qqProcListCache.at;
      if (qqProcListCache.rows && age < QQ_PROC_LIST_TTL) {
        return qqProcListCache.rows;
      }
      // 陈旧但还能用：先给旧值，后台补新值 —— 调用方不再等 PowerShell。
      if (qqProcListCache.rows && age < QQ_PROC_LIST_STALE_MAX) {
        kickProcListRefresh();
        return qqProcListCache.rows;
      }
      if (qqProcListInFlight) return qqProcListInFlight;   // 已在查 → 共用这一次，别叠 spawn
    }
    const p = __listQqProcessesOnce()
      .then((rows) => { qqProcListCache = { at: Date.now(), rows }; return rows; });
    qqProcListInFlight = p;
    try { return await p; } finally { qqProcListInFlight = null; }
  }

  /** 真正干活的单次查询（无缓存）。空结果也缓存 3s —— 失败的 spawn 同样是慢操作。 */
  async function __listQqProcessesOnce() {
    if (process.platform !== 'win32') return [];
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
          + 'Get-CimInstance Win32_Process -Filter "name=\'QQ.exe\'" | '
          // r105 搬运（自 v0.4.5）：连 CommandLine 一起取 —— 本机 QQ 模式下机器人的
          //   QQ 和用户自己的 QQ 是同一个 exe 路径，靠命令行里的 --user-data-dir 区分。
          + 'Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'
      ], { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      const txt = String(stdout).trim();
      if (!txt) return [];
      const data = JSON.parse(txt);
      const arr = Array.isArray(data) ? data : [data];
      return arr
        .map((p) => ({
          pid: Number(p.ProcessId),
          path: String(p.ExecutablePath ?? ''),
          cmd: String(p.CommandLine ?? '')   // r105 搬运：命令行，用于识别「机器人那份 QQ」
        }))
        .filter((p) => p.pid > 0);
    } catch {
      // 查不到就当没有。**不要**在这里退回 wmic —— 它给的乱码路径会导致
      // "误判为别的 QQ"或"漏判本机的便携 QQ"，比返回空更糟。
      return [];
    }
  }

  /** 检查便携 QQ 是否在运行（按路径匹配，不碰用户 QQ） */
  async function qqPortableRunningPid() {
    // 1) 本进程拉起过的那个：spawn 时就拿到 pid 了，不用查系统 ——
    //    最快，也不受任何编码/权限问题影响。
    if (qqPortableProc && !qqPortableProc.killed) {
      try {
        process.kill(qqPortableProc.pid, 0);   // signal 0 = 只探测存活
        return qqPortableProc.pid;
      } catch { /* 已退出，往下走 */ }
    }
    // 2) 查系统：覆盖"上次启动的 QQ 还在跑，但应用重启过"的情况
    //    r105 搬运（自 v0.4.5 r90 判据）：我们启动 QQ 时一定带
    //    --user-data-dir=<runtime/qq-portable-data>，命令行里含这个数据目录的
    //    就是机器人那份 —— 与 exe 在哪儿无关（本机 QQ 模式下机器人和用户的
    //    QQ 是同一个 exe 路径，只按路径匹配会永远显示"未运行"）。
    //    便携模式旧行为（按安装目录前缀匹配）保留为兜底。
    const procs = await listQqProcesses();
    const dataDir = qqPortableDataDir().toLowerCase();
    const byData = procs.find((p) => p.cmd && p.cmd.toLowerCase().includes(dataDir));
    if (byData) return byData.pid;
    const portableDir = qqPortableDir().toLowerCase();
    const byPath = procs.find((p) => p.path.toLowerCase().startsWith(portableDir));
    return byPath?.pid ?? null;
  }

  /**
   * 启动机器人的 QQ（r105 搬运，自 v0.4.5 r90/r100 版本）。
   *
   * ── r90 语义 ────────────────────────────────────────────────────────
   * 便携副本优先；没有便携副本时**直接用本机已装的 QQ**（不再强制复制
   * 1~2GB）。隔离靠 --user-data-dir：不管 exe 在哪儿，登录数据都写进
   * runtime/qq-portable-data，与用户日常 QQ 互不干扰。
   */
  async function launchPortableQQ() {
    // 便携 QQ 的做法是「复制本机 QQNT 目录 + 带 --user-data-dir 启动」，而 QQNT 本身
    // 只有 Windows 版。Linux/macOS 上直接说清楚，别让用户对着 spawn 失败发呆。
    if (process.platform !== 'win32') {
      return { ok: false, error: '「一键便携 QQ」仅支持 Windows —— QQNT 没有 Linux/macOS 版。Linux 上请改用外部 OneBot 协议端（如 NapCat / LLOneBot）。' };
    }
    const target = await resolveQqTarget();
    if (!target.exe) {
      return {
        ok: false,
        error: '没找到可用的 QQ：既没有便携副本，也没在本机检测到已安装的 QQ —— 请先安装新版 QQ（QQNT）'
      };
    }
    if (!fs.existsSync(target.exe)) {
      return { ok: false, error: `QQ 主程序不见了：${target.exe} —— QQ 可能已被卸载或挪走，重装后重试` };
    }
    // 启动互斥：连点「启动 QQ」时，第一次还在 spawn，第二次直接拒绝
    if (qqPortableLaunching) {
      pushQqLog('QQ 正在启动中，忽略重复的启动请求');
      return { ok: true, alreadyRunning: true, launching: true };
    }
    const existingPid = await qqPortableRunningPid();
    if (existingPid) {
      pushQqLog(`机器人的 QQ 已在运行（pid=${existingPid}），无需重复启动`);
      return { ok: true, alreadyRunning: true, pid: existingPid };
    }

    // 本机模式：用户自己的 QQ 可能正在跑。我们不拦（QQ 带不同 --user-data-dir
    // 一般能再开一个实例），但先把话说在前面，免得"没反应"时无从下手。
    if (target.source === 'local') {
      const others = (await listQqProcesses())
        .filter((p) => p.path && p.path.toLowerCase() === target.exe.toLowerCase());
      if (others.length) {
        pushQqLog(
          `注意：你电脑上的 QQ 正在运行（pid=${others.map((o) => o.pid).join(',')}）。`
          + '机器人的 QQ 会**另开一个窗口**登录，和你的 QQ 是两套数据，不会顶掉你。',
          'stdout'
        );
      }
    }

    qqPortableLaunching = true;
    try {
      const exe = target.exe;
      const dataDir = qqPortableDataDir();
      fs.mkdirSync(dataDir, { recursive: true });

      try {
        const child = spawn(exe, [`--user-data-dir=${dataDir}`], {
          cwd: target.dir,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: false, // QQ 需要显示窗口让用户扫码
          detached: true
        });
        qqPortableProc = child;
        child.unref();
        pushQqLog(
          target.source === 'local'
            ? `用你电脑里的 QQ 启动机器人（pid=${child.pid}），登录数据单独放：${dataDir}`
            : `便携 QQ 启动中（pid=${child.pid}），数据目录：${dataDir}`
        );
        child.stdout?.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushQqLog(line, 'stdout');
          }
        });
        child.stderr?.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushQqLog(line, 'stderr');
          }
        });
        child.on('exit', (code, signal) => {
          qqPortableProc = null;
          pushQqLog(`便携 QQ 进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, 'stderr');
          emit('qq-portable-status', { running: false, pid: null });
        });
        child.on('error', (error) => {
          pushQqLog(`便携 QQ 启动失败：${error?.message ?? error}`, 'stderr');
        });
        emit('qq-portable-status', { running: true, pid: child.pid });
        return { ok: true, launched: true, pid: child.pid };
      } catch (error) {
        pushQqLog(`便携 QQ 启动失败：${error?.message ?? error}`, 'stderr');
        return { ok: false, error: String(error?.message ?? error) };
      }
    } finally {
      qqPortableLaunching = false;
    }
  }

  /** 关闭便携 QQ（只杀路径匹配的 PID，绝不碰用户 QQ） */
  async function stopPortableQQ() {
    const pid = await qqPortableRunningPid();
    if (!pid) {
      pushQqLog('便携 QQ 未在运行');
      return { ok: true, stopped: false, reason: 'not_running' };
    }
    try {
      process.kill(pid, 'SIGTERM');
      pushQqLog(`已请求关闭便携 QQ（pid=${pid}）`);
      // 等待进程退出
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const still = await qqPortableRunningPid();
        if (!still) {
          pushQqLog('便携 QQ 已退出');
          emit('qq-portable-status', { running: false, pid: null });
          return { ok: true, stopped: true, pid };
        }
      }
      // 还没退，强制 kill
      process.kill(pid, 'SIGKILL');
      pushQqLog(`便携 QQ 已强制结束（pid=${pid}）`);
      emit('qq-portable-status', { running: false, pid: null });
      return { ok: true, stopped: true, pid, forced: true };
    } catch (error) {
      pushQqLog(`关闭便携 QQ 失败：${error?.message ?? error}`, 'stderr');
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * QQ 内核状态摘要（r105 搬运，自 v0.4.5 r90 版本）。
   * `ready` = **有能启动的 QQ**：便携副本装了 ✔ 或本机检测到 QQ ✔。
   * `source` 告诉前端当前走的是哪一种（'portable' | 'local' | 'none'）。
   * @param {{force?: boolean}} opts ?force=1 跳过本机 QQ 探测的 30s 缓存
   */
  async function qqPortableStatus(opts = {}) {
    const pid = await qqPortableRunningPid();
    const target = await resolveQqTarget(opts);
    return {
      ready: target.exe !== null,
      running: pid !== null,
      pid,
      dir: target.dir || qqPortableDir(),
      dataDir: qqPortableDataDir(),
      // r52：一键安装的实时进度（前端轮询 /api/status 读这里显示「复制中 n/m」）
      setup: { ...qqSetupState },
      // r89/r90：探测到本机 QQ（= 用户日常用的那个 QQ）时的路径
      localQqDir: target.source === 'local' ? target.dir : null,
      // r90：'portable' 用独立副本 / 'local' 用本机 QQ / 'none' 都没有
      source: target.source,
      // 独立副本装没装 —— 决定 UI 要不要显示「装一份独立副本（可选）」
      portableInstalled: qqPortableReady(),
      // r132：版本核对（status: 'ok' | 'mismatch' | 'unknown'，detail 带下一步话术）
    };
  }

  /* ── r105 搬运（自 v0.4.5）：本机 QQ 探测 + 一键安装便携 QQ ─────────── */

  /**
   * 解析「机器人实际要启动的那份 QQ」（r90 核心）。
   * 便携副本优先，本机已装的 QQ 直接算通过。
   * @returns {{dir:string|null, exe:string|null, source:'portable'|'local'|'none'}}
   */
  async function resolveQqTarget(opts = {}) {
    if (qqPortableReady()) {
      return { dir: qqPortableDir(), exe: qqPortableExe(), source: 'portable' };
    }
    const local = await detectLocalQqDir(opts);
    if (local) {
      return { dir: local, exe: path.join(local, 'QQ.exe'), source: 'local' };
    }
    return { dir: null, exe: null, source: 'none' };
  }

  const qqSetupState = { running: false, step: '', done: 0, total: 0, error: null, ok: false };

  // /api/status 是秒级轮询，而探测要 spawn 两次 reg query + 若干 existsSync。
  // 30s 内复用上次结果（force 可跳过缓存，给"刚装完 QQ"的场景用）。
  let localQqCache = { at: 0, dir: null };
  const LOCAL_QQ_TTL = 30000;

  /** 定位本机已安装的 QQNT（带 30s 缓存）：注册表 Uninstall\QQ 优先，常见路径兜底。
   *  r-fix：并发去重 —— 探测可能要几秒，期间多次 /api/status 轮询不应各自重新 spawn
   *  数十个 reg 进程；首个探测在飞时，后续调用复用同一结果。 */
  let localQqInFlight = null;
  async function detectLocalQqDir(opts = {}) {
    const now = Date.now();
    if (!opts?.force && localQqCache.at && now - localQqCache.at < LOCAL_QQ_TTL) {
      return localQqCache.dir;
    }
    if (opts?.force) {
      // force（"刚装完 QQ 就来点安装"）：跳过缓存与去重，强制重新探测一次
      const found = await detectLocalQqDirOnce();
      localQqCache = { at: now, dir: found };
      return found;
    }
    if (!localQqInFlight) {
      localQqInFlight = detectLocalQqDirOnce().finally(() => { localQqInFlight = null; });
    }
    const found = await localQqInFlight;
    localQqCache = { at: now, dir: found };
    return found;
  }

  /** 注册表里可能记录 QQNT 安装位置的键（覆盖 64 位 / WOW6432Node / 当前用户三种视图） */
  const QQ_REG_KEYS = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKLM\\SOFTWARE\\Tencent\\QQNT',
    'HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\QQNT',
    'HKCU\\SOFTWARE\\Tencent\\QQNT'
  ];
  const QQ_REG_VALUES = ['InstallLocation', 'DisplayIcon', 'InstallDir', 'InstallPath', 'Path'];

  /** 由环境变量推出的 QQNT 常见目录。
   *  ⚠️ 一律不写死盘符：ProgramFiles / LOCALAPPDATA / SystemDrive 都是运行时取的，
   *     所以系统装在哪个盘、QQ 装的是"全机器"还是"仅当前用户"都能覆盖到。 */
  function envBasedQqDirs() {
    const out = [];
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]) {
      if (root) out.push(path.join(root, 'Tencent', 'QQNT'));
    }
    if (process.env.LOCALAPPDATA) out.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Tencent', 'QQNT'));
    const sysDrive = process.env.SystemDrive || 'C:';
    out.push(path.join(sysDrive, 'Tencent', 'QQNT'));
    return out;
  }

  /** 枚举本机硬盘盘符（如 ['C:\\','D:\\']）。失败返回空数组 —— 探测整体不该因此失败。 */
  async function listFixedDrives() {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { stdout } = await promisify(execFile)('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
          + 'Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root'
      ], { timeout: 6000, windowsHide: true });
      // 只保留盘符形式（如 C:\ 或 D:\）。映射的网络驱动器路径会被这里滤掉 ——
      // 对断开的网络盘做 existsSync 可能长时间阻塞，不值得为它冒险。
      return String(stdout).split(/\r?\n/)
        .map((x) => x.trim())
        .filter((x) => /^[A-Za-z]:[\\/]?$/.test(x));
    } catch { return []; }
  }

  /** 兜底候选目录：环境变量优先，再枚举盘符拼（都不写死盘符）。 */
  async function qqDirFallbacks() {
    const out = envBasedQqDirs();
    for (const drive of await listFixedDrives()) {
      out.push(path.join(drive, 'Program Files', 'Tencent', 'QQNT'));
      out.push(path.join(drive, 'Program Files (x86)', 'Tencent', 'QQNT'));
      out.push(path.join(drive, 'Tencent', 'QQNT'));
    }
    return out;
  }

  /** 整体安全网：任何一次探测都不得无限挂起。超时直接给降级值（null=未找到），
   *  不抛异常、不阻塞调用方 —— 调用方（/api/status / 缓存填充）会按"未找到"优雅降级。 */
  function withOverallTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
    return Promise.race([
      Promise.resolve(promise).then(
        (v) => { clearTimeout(timer); return v; },
        () => { clearTimeout(timer); return null; }
      ),
      timeout
    ]);
  }

  /** 探测一次本机 QQNT 安装目录（无缓存）。
   *
   *  ⚠️ 这里**不允许**再出现写死盘符的路径（原实现硬编码了 C:\\ / D:\\ 五条，
   *     换台机器、或把 QQ 装到别的盘/用户目录就整个失效）。
   *     现在按「注册表 → 环境变量 → 枚举盘符」三级兜底，只拼相对片段 Tencent\\QQNT。
   *
   *  r-fix：原实现**串行**跑 6×5=30 次 reg query、单次超时 8s，
   *  杀软拦截 reg.exe / 注册表响应慢的机器上最坏 30×8s≈4 分钟，
   *  既拖垮 /api/status（已在上层用 1.5s 兜底），又让后台 30s 缓存迟迟拿不到真值。
   *  现改为**并行**探测 + 单次超时收紧到 2.5s，整体再套 6s 安全网（见 detectLocalQqDirOnceImpl）。 */
  async function detectLocalQqDirOnce() {
    return withOverallTimeout(detectLocalQqDirOnceImpl(), 6000);
  }

  async function detectLocalQqDirOnceImpl() {
    // QQNT 只有 Windows 版：注册表（HKLM/HKCU）、Get-PSDrive、%ProgramFiles% 全是
    // Windows 语义，非 Windows 上直接短路，别白跑三次 reg query 再返回 null。
    if (process.platform !== 'win32') return null;
    const candidates = [];
    // ── ① 注册表：三种视图都查（原实现只查 WOW6432Node，64 位安装与"仅当前用户"
    //       两种安装方式都查不到）。改为并行，单次超时 2.5s，最坏 2.5s 收口 ──
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const REG_TIMEOUT = 2500;
      const probes = QQ_REG_KEYS.flatMap((key) =>
        QQ_REG_VALUES.map((val) =>
          execFileAsync('reg', ['query', key, '/v', val], { timeout: REG_TIMEOUT, windowsHide: true })
            .then(({ stdout }) => {
              const m = /REG_SZ\s+(.+)/.exec(String(stdout));
              return m ? m[1].trim() : null;
            })
            .catch(() => null)
        )
      );
      for (const r of await Promise.all(probes)) if (r) candidates.push(r);
    } catch { /* reg 不可用就走路径探测 */ }
    // ── ② + ③ 环境变量 / 盘符枚举 ──
    for (const base of await qqDirFallbacks()) candidates.push(base);
    for (const raw of candidates) {
      if (!raw) continue;
      // DisplayIcon 形如 "X:\dir\QQ.exe,0" → 取目录；InstallLocation 本就是目录
      let dir = String(raw).replace(/,0$/, '').trim().replace(/^"|"$/g, '');
      if (/QQ\.exe$/i.test(dir)) dir = path.dirname(dir);
      if (dir && fs.existsSync(path.join(dir, 'QQ.exe'))) return dir;
    }
    return null;
  }

  /** 源目录的 QQ.exe 是否在运行（按完整路径匹配，不碰其它 QQ） */
  async function qqRunningFromDir(dir) {
    try {
      const procs = await listQqProcesses();
      const exe = path.join(dir, 'QQ.exe').toLowerCase();
      return procs.find((p) => p.path && p.path.toLowerCase() === exe) || null;
    } catch { return null; }
  }

  /** 顶层逐条复制（fs.promises.cp 无进度回调，按顶层条目打点） */
  async function copyDirWithProgress(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    qqSetupState.total = entries.length;
    let done = 0;
    for (const ent of entries) {
      await fs.promises.cp(path.join(src, ent.name), path.join(dst, ent.name), { recursive: true, force: true });
      done++;
      qqSetupState.done = done;
      qqSetupState.step = ent.name;
      pushQqLog(`[一键安装] ${done}/${entries.length} ${ent.name}`);
    }
  }

  /** 唤起便携 QQ 主窗口（NTQQ 启动后不自动弹窗，新手找不到登录入口）。
   *  按 pid 枚举它名下**有标题的顶层窗口**（隐藏的也要枚举 —— NTQQ「关闭窗口」
   *  是 SW_HIDE），最小化的 SW_RESTORE、隐藏的 SW_SHOW，再 SetForegroundWindow 置前。 */
  async function showPortableQQ() {
    if (process.platform !== 'win32') {
      return { ok: false, error: '仅支持 Windows' };
    }
    const pid = await qqPortableRunningPid();
    if (!pid) {
      pushQqLog('便携 QQ 未在运行，无法唤起窗口');
      return { ok: false, error: '便携 QQ 未在运行 —— 请先启动 QQ' };
    }
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const ps = [
      '$target = ' + pid,
      'Add-Type -TypeDefinition @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class QQWin {',
      '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
      '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);',
      '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
      '  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);',
      '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
      '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
      '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
      '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
      '}',
      '"@',
      '$script:found = 0',
      '$cb = [QQWin+EnumProc]{ param($h, $l)',
      '  $wpid = [uint32]0',
      '  [QQWin]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null',
      '  if ($wpid -eq $target -and [QQWin]::GetWindowTextLength($h) -gt 0) {',
      '    if ([QQWin]::IsIconic($h)) { [QQWin]::ShowWindow($h, 9) | Out-Null }',
      '    elseif (-not [QQWin]::IsWindowVisible($h)) { [QQWin]::ShowWindow($h, 8) | Out-Null }',
      '    [QQWin]::SetForegroundWindow($h) | Out-Null',
      '    $script:found++',
      '  }',
      '  $true',
      '}',
      '[QQWin]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null',
      'Write-Output "FOUND $($script:found)"'
    ].join('\n');
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command', ps
      ], { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 });
      const m = /FOUND\s+(\d+)/.exec(String(stdout));
      const found = m ? Number(m[1]) : 0;
      if (found > 0) {
        pushQqLog(`已唤起便携 QQ 窗口（pid=${pid}，命中 ${found} 个窗口）`);
        return { ok: true, shown: found, pid };
      }
      pushQqLog(`未找到便携 QQ 的窗口（pid=${pid}）—— 可能还在启动`, 'stderr');
      return { ok: false, error: '没找到 QQ 的窗口 —— 刚启动的话 QQ 可能还在初始化，稍等几秒再试' };
    } catch (error) {
      pushQqLog(`唤起便携 QQ 窗口失败：${error?.message ?? error}`, 'stderr');
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * 一键安装便携 QQ（r52/r105）：从本机已安装的 QQNT 复制一份。
   * 复制本机安装目录即完成安装。**源目录只读**，绝不写用户 QQ 一个字节。
   * @param {{sourceDir?: string}} opts
   */
  async function setupPortableQQFromLocal(opts = {}) {
    if (qqSetupState.running) {
      return { ok: false, error: '正在安装中，请等当前安装完成（看下方日志的复制进度）' };
    }
    if (qqPortableReady()) {
      return { ok: true, alreadyInstalled: true };
    }
    // force：用户刚装完 QQ 就来点安装，别拿 30s 前的"没找到"糊弄他
    const sourceDir = String(opts?.sourceDir || '').trim() || await detectLocalQqDir({ force: true });
    if (!sourceDir) {
      return {
        ok: false,
        error: '没找到本机安装的 QQ（需要装过新版 QQ/QQNT）。也可以看下方日志里的说明手动指定目录'
      };
    }
    if (!fs.existsSync(path.join(sourceDir, 'QQ.exe'))) {
      return { ok: false, error: `这个目录里没有 QQ.exe：${sourceDir}` };
    }
    const busy = await qqRunningFromDir(sourceDir);
    if (busy) {
      return {
        ok: false,
        needExit: true,
        error: `本机 QQ 正在运行（pid=${busy.pid}）：请先完全退出 QQ（包括托盘图标）再点安装`
      };
    }
    qqSetupState.running = true;
    qqSetupState.done = 0; qqSetupState.total = 0;
    qqSetupState.error = null; qqSetupState.ok = false;
    qqSetupState.step = '准备复制';
    pushQqLog(`一键安装：从 ${sourceDir} 复制便携 QQ 到 ${qqPortableDir()}（源目录只读）`);
    try {
      await copyDirWithProgress(sourceDir, qqPortableDir());
      qqSetupState.running = false;
      qqSetupState.ok = true;
      qqSetupState.step = '完成';
      pushQqLog('[一键安装] 便携 QQ 安装完成 ✓ 可点「单独启动 QQ」了');
      return { ok: true, installed: true, dir: qqPortableDir() };
    } catch (error) {
      qqSetupState.running = false;
      qqSetupState.error = String(error?.message ?? error);
      pushQqLog(`一键安装失败：${qqSetupState.error}`, 'stderr');
      const busyHint = /EBUSY|EPERM|EACCES/i.test(qqSetupState.error)
        ? ' —— 多半是 QQ 还在运行或有文件被占用：完全退出 QQ 后重试'
        : '';
      return { ok: false, error: '安装失败：' + qqSetupState.error + busyHint };
    }
  }

  return {
    isPortOpen,
    qqPortableStatus,
    qqPortableLogs,
    launchPortableQQ,
    stopPortableQQ,
    showPortableQQ,
    setupPortableQQFromLocal,
    // 测试用入口：内部纯函数/状态，不参与运行时契约，不要在外面依赖它们
    __internals: {
      qqPortableDir,
      qqPortableDataDir,
      qqPortableExe,
      pushQqLog,
      qqPortableReady,
      listQqProcesses,
      qqPortableRunningPid,
    },
  };
}
