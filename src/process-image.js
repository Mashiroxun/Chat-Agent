// 进程镜像名探测（tasklist）——**零项目内依赖**模块。
//
// ⚠️ 为什么必须单独成一个文件，且绝不能 import 任何本项目模块：
//   electron/main.js 会静态 import src/self-update.js，而 ESM 的静态 import 在
//   main.js 任何一行代码执行**之前**就把整条依赖链求值完毕。QQ_AGENT_DATA_DIR
//   （桌面版让数据目录 = <exe>/data）却是在 main.js 的 resolveDataDir() 里
//   **运行时**才设置的。只要这条链上碰到 src/config.js，DATA_DIR 就会在模块
//   求值期被固化成 resources/app/data（headless 布局）：单实例锁文件与日志目录
//   全部指错地方，首启 data/ 全新的机器上还会复活「解压后双击打不开」的自愈竞态。
//   任何静态的项目内依赖都可能把 config.js 拖进来 —— **求值本身就是副作用**，
//   「只为算个常量、模块加载期没有副作用」是错的。所以本模块只准依赖 node:
//   内置模块；谁要用这份判定，就直接 import 本文件，别绕经 instance-lock.js。
//
// R93：先花很小的代价问一次**镜像名**（tasklist，通常 30~80ms）。
//
// 为什么要分两步：R76 的实现一上来就 `Get-CimInstance`，而 powershell 冷启动
// 要 300~800ms（超时上限 5s）。这段是**同步**跑在 `createApp()` 里、**建窗之前**，
// 所以"上次崩溃留下锁 + 那个 PID 恰好被系统复用"时，用户双击后要干等几百
// 毫秒到 5 秒才见到窗口 —— 与"双击半天不出窗"是同一笔账。
//
// 而绝大多数情况下（PID 被**无关程序**复用，正是硬崩溃后最常见的场景）镜像名
// 就对不上，第一步即可下结论，根本不需要惊动 powershell。
//
// 返回 null 表示"查不到"（非 Windows / tasklist 不可用 / PID 不在列表里），
// 调用方据此回退到 CIM 全量查询 —— 不改变任何判定语义，只是把快路径提前。
//
// 2026-11-12：instance-lock.js 与 src/self-update.js 的助手锁复用同一份
// （都是"PID 被复用"问题，见 self-update.js 的 isHelperLive 注释）。
// **不要再写第二份实现**：两份判定迟早漂移。
import { execFileSync } from 'node:child_process';

export function processImageName(pid) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('tasklist', [
      '/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'
    ], { timeout: 1500, windowsHide: true, encoding: 'utf8' });
    // 命中时形如："QQ Agent.exe","1234","Console","1","188,788 K"
    // 未命中时 tasklist 输出的是本地化的"没有运行的任务…"提示，正则自然不匹配。
    const m = String(out).match(/"([^"]+)"/);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}
