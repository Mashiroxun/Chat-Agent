# QQAgent R125 · 群友报「启动卡 45 秒」代码审查报告

日期：2026-10-14
源：群内截图（错误卡片 + 9 行 bootLogs，19:21:46 → 19:22:33）
报告不直接改代码，按 P0/P1/P2 列出 11 条发现 + 最小修复建议。

## 一、错误卡片是怎么来的

群友看到的卡片由 `00-core.js` 三段拼成：

| 段 | 代码位置 | 来源 |
|---|---|---|
| 标题「界面没能启动完成」 | `00-core.js:710` | showBootFailure 内联文本 |
| 副标题「控制台服务 45 秒内没有响应…后端多半是正常在跑的，通常是页面这一侧没能连上它」 | `00-core.js:713` | 同上 |
| 日志框（9 行） | `00-core.js:670 + 716` | bootLogs 后 12 条 / setLoadingStatus push |
| 「重新加载界面」按钮 | `00-core.js:717-722` | location.reload() |

启动探测链 `11-init.js:50 → bootLoop() → pollUntilReady() → api('/api/status', { signal: AbortSignal.timeout(5000) })`，每 6 秒轮一次，**45 秒后**返回 `'timeout'` → `showBootFailure()`。

控制台服务启动链 `main.js:1145-1166 → createApp() → core.start() → listenOn(3210+) → console-port 落盘 → createWindow(port)`，HTTP server.listen 一回调就 resolve 真实端口，再 `await createWindow(port)` 拉起窗口；窗口内部立即走 11-init.js → bootLoop() 探测。

主进程看门狗 `main.js:510-585`，5 秒一问 `probePage(mainWindow)`，连续 12 次 bootMisses（60 秒）才 `healIfStuck('看门狗：启动未就绪', 'boot')`（R92 把阈值从 5 抬到 12，治慢机器被反复打断）。

## 二、关键发现（按风险排序）

### 🔴 P0-1：bootLoop 的 45s 阈值与文案不符——"控制台服务没响应" 是错的

`showBootFailure` 文案是「控制台服务 45 秒内没有响应」，但 `pollUntilReady` 实际只探测 **/api/status** 这一个接口。两者差异：

- **控制台服务（HTTP server）没起来**：`/api/status` 会报 `ECONNREFUSED`（拒绝连接）—— 这是真"控制台服务没响应"
- **HTTP 起了但 /api/status 慢**（R113 之前版本 + OneBot 卡 + listQqProcesses 慢）：HTTP 服务**明明活着**，但 `/api/status` 5 秒超时—— 错误文案说"控制台服务没响应"是错的

正确做法：探针应**先** ping 一个零依赖的极简接口（如 `/` 或 `/api/version` 或 `/api/ping`），**确认 HTTP 起来了**再去看 `/api/status`。把"HTTP 不可达"和"HTTP 起来了但 /api/status 慢"分成两类，前者提示端口/服务问题，后者提示业务接口问题——**用户的自救路径完全不同**。

**最小修复**：在 `00-core.js` 加一个 `pingConsole()` 调 `/api/version`（或新增一个 `/api/ping` 路由），bootLoop 每轮先 ping 再 status；bootLogs 区分两种失败。

### 🔴 P0-2：bootLoop 错误后没有任何降级路径

错误卡片只有"重新加载界面"按钮（`00-core.js:722`），`location.reload()` 重走一遍 bootLoop → 45 秒后又回到错误卡片。这是**死循环**——群友截屏时已经在 90+ 秒位置。

群友能自救的方式几乎为 0：
- 没有"打开主进程日志目录"按钮
- 没有"忽略错误先进完整控制台"按钮（让用户至少能进界面看 settings / 看状态）
- 没有"复制错误详情"按钮
- 没有"端口 / 路径 / 数据目录"显示

`main.js:1183-1196` 在**主进程启动失败**时是有原生错误框 + "打开日志目录"按钮的，但**渲染端启动失败**走的是另一条路，没继承这个能力。

**最小修复**：`showBootFailure` 改造成带 3 个按钮的小面板：
- 重新加载界面（已有）
- 打开主进程日志目录（IPC 通知主进程 `shell.openPath(dataDir + '/logs')`）
- 复制错误详情（把 bootLogs + 当前时间 + 真实端口 `lastPort` 写进剪贴板，方便群友发到群里）

### 🔴 P0-3：错误卡片到主进程看门狗自救之间有 15 秒空档

`bootLoop` 45 秒显示错误卡片；`bootWatchdog` 阈值 12 次 × 5 秒 = 60 秒才第一次 `healIfStuck`（R92 把阈值从 5 抬到 12，治慢机器被反复打断）。

**实际效果**：群友看到错误卡片后**还要盯着 15 秒**主进程才反应过来——这 15 秒里错误卡片是死页面，鼠标能动但什么也不发生。

更糟的是 `healIfStuck('boot')` 走 `webContents.reload()`（不是销毁重建），reload 后又 45 秒错误卡片——**总 90+ 秒**才完成一轮自愈尝试。

**最小修复**：`showBootFailure` 触发的同时通过 IPC 通知主进程「我已经判定失败了，缩短你的等待阈值到 1-2 次」（`bootMisses = 10`），让看门狗**立刻** reload。或者干脆改成：错误卡片显示后 `setTimeout(3000, () => location.reload())` 自动重试一次，第二次仍失败就停留给用户看。

### 🟠 P1-1：bootLogs 只活在 DOM 里，主进程日志里看不到

`main.js:372 harvestBootDiagnostics` 是在看门狗**判定要动手**时才抓 bootLogs 写主进程日志。

意味着：群友截图发来的主进程日志**只看到** 3 条看门狗记录 + 启动链记录，**完全看不到**「服务还没响应 × 8」这条最关键的失败原因——和这个错误卡片的注释说明完全吻合（`main.js:367-371`：以前只存在于 DOM 里，2026-09-23 实测群友发来主进程日志时根本看不到）。

**但 harvestBootDiagnostics 仍没覆盖到「showBootFailure 已显示但看门狗还没动手」这 15 秒**。**最小修复**：错误卡片显示时主动 `ipcRenderer.send('boot-failure', bootLogs)`，主进程 `ipcMain.on('boot-failure', (e, logs) => logCritical('boot', logs))` 写日志——**主进程日志和群友截图的时间线就能对齐**了。

### 🟠 P1-2：`/api/status` 慢会让 bootLoop 误判"控制台服务没响应"

R113（2026-10-14 已合 0.4.8.x）给 listQqProcesses 加了 3 秒 TTL + 在途共享，`/api/status` 从 1.5s 降到 50ms。但 R113 之前的版本（0.4.7 / 部分 0.4.8 早期）**没拿到 R113**——群友装的如果不是 0.4.8.1 之后的版本，`/api/status` 慢到 1.5s 起步，加上 setLoadingStatus 内部还有 5 秒超时 + 1 秒间隔 = 累积后 45 秒判定。

**群友不知道自己装的是哪个版本**——这本身是个体验问题。

**最小修复**：在 `pollUntilReady` 里给"响应但没数据"和"完全超时"区分开；前者在 bootLogs 标"接口慢但不致命"，后者标"控制台服务可能没起"。

### 🟠 P1-3：错误卡片的 9 行 bootLogs 不带时间戳间隔

群友截图的日志是 `[19:21:46] 正在启动` → `[19:21:51] 已等待 5 秒` → `[19:21:57] 已等待 11 秒` —— 间隔 5/6/6/6/6/6/6/6 秒。**但 19:21:46 与 19:21:51 之间的 5 秒是"一次 pollUntilReady 的 5s 超时"，不是"5 秒没动作"**。

从日志看不出来是「单次 5s 超时」还是「5 秒空档」。`setLoadingStatus` 用 `toLocaleTimeString`（`00-core.js:668`）精确到秒，加上 5s timeout + 1s 间隔会自然形成 6 秒步长——**但群友看就是"没反应"**。

**最小修复**：在 bootLogs 行尾标 `+0ms`（启动瞬间）/ `+5.0s`（第一次超时）/ `+11.0s`（第二次超时），让群友一眼能看出"卡 6 秒是因为 5s 超时 + 1s 间隔"。

### 🟡 P2-1：`pollUntilReady` 不区分 ECONNREFUSED 和 TimeoutError

两种原因用户自救路径完全不同：

| 错误 | 真实原因 | 用户能做的 |
|---|---|---|
| `ECONNREFUSED` | HTTP 端口没起（被占 / 启动失败） | 关掉占端口的程序 / 重启 / 重装 |
| `TimeoutError` | HTTP 起了但 /api/status 慢 | 等（业务接口慢）/ 看 OneBot 状态 |

现在两者都被 `setLoadingStatus` 包成同一句「服务还没响应：请求超时（5 秒无响应）」，**群友看到这种文字根本没法判断**。

**最小修复**：`api()` catch 里（`00-core.js:625-638`）加 `e.message === 'Failed to fetch'` 单独转译为「控制台服务拒绝连接（端口可能没起）」；TimeoutError 转译为「服务响应太慢」。

### 🟡 P2-2：多个 QQ Agent.exe 并存没有"端口冲突"显式提示

`listenOn`（`app.js:1999-2013`）已经能拿到 EADDRINUSE 自动 +1，console-port 落盘（`app.js:2043-2046`）。但：
- 用户**不知道**自己开了多个实例
- 群友如果装了 0.4.8（开发树旧版）+ 0.4.8.2（运行版新版）两个独立实例，basePort 都是 3210，第二个会自动 +1 到 3211
- M1 修过"幽灵窗口"（`main.js:1148-1166`），但**没修**"用户视角的端口冲突提示"

**最小修复**：M1 之后，createWindow 之前加 `fs.readFileSync('console-port', 'utf8')` 读取上次端口，**对比本次实际端口**：
- 一致 → 正常
- 不致 → 弹原生提示 "检测到你装了 N 个 QQ Agent 实例，本实例使用端口 3211（其他实例在 3210）"（注意：MEMORY 提到这是固定现象，2 个实例都跑得起来；提示只是告知）

### 🟡 P2-3：core.start() 内部没时间统计

用户报"卡很久"时，开发者**完全不知道**是 listen 慢、skill load 慢、还是 snowluma 拉起慢。

`app.js:2016` 整段 start() 函数里没有 `console.time('core.start')` / `console.timeEnd('core.start')`，每个子段（`listenOn` / `reloadSkills` / `launchSnowluma` / `isPortOpen` 循环）也没单独计时——**R113 调试时是手动 console.log 加的，验证完就删了**。

**最小修复**：在 `app.js:2016` 函数首尾加 `console.time('core.start')` / `console.timeEnd('core.start')`，子段加 `console.time('skill.load')` / `console.timeEnd('skill.load')` 等。**零业务风险**，纯加观测。群友复现时主进程日志直接打出"core.start 总 12.3s，skill.load 用了 9.8s"——定位快 10 倍。

### 🟡 P2-4：bootLoop 失败时主进程不知道自己失败

`pollUntilReady` 返回 `'timeout'` → `showBootFailure` 跑（`00-core.js:734-737`）→ **只动 DOM**。主进程的 `core.lastPort` / HTTP server 都活着，但**没有 IPC 通知**主进程"渲染端判我超时了"。

主进程的看门狗要等自己的 12 次（60s）才反应过来——和 P0-3 是同一个问题的两端。

**最小修复**：`showBootFailure` 里加 `if (window.electronAPI?.bootFailure) window.electronAPI.bootFailure(bootLogs.slice(-12))`，主进程 `ipcMain.handle` 收到后写日志 + 把 `bootMisses` 抬到阈值附近，立刻 reload。

### 🟡 P2-5：错误卡片的"重新加载界面"按钮的 `location.reload()` 没用过 6 秒冷却

如果群友狂点"重新加载界面"按钮（`00-core.js:722`），每次都触发 bootLoop 重置 + 5s 等待。如果 1 秒点 5 次，**主线程事件循环被 5 个 bootLoop 共占**——反而让响应更慢。

**最小修复**：按钮加 6 秒 disabled 状态 + 文案变化"6 秒后重试"。

## 三、根因分类（一句话总结）

按问题归类：

1. **探测不准（P0-1 + P1-2 + P2-1）**：bootLoop 的 45s 阈值是把"HTTP 不可达"和"HTTP 可达但 /api/status 慢"两类问题混在一起判定 + 文案
2. **自愈路径缺失（P0-2 + P0-3 + P1-1 + P2-4 + P2-5）**：错误卡片是死页面 + 看门狗慢 + 主进程日志缺关键证据
3. **观测盲区（P2-3）**：core.start() 内部无时间统计，无法快速定位慢在哪一段

## 四、建议路径（不要求立刻全做）

**第 1 优先级（5 分钟 / 30 行内可解）**：
- P0-1：bootLoop 加 pingConsole 区分 HTTP 不可达 vs 业务慢
- P2-1：api() catch 把 ECONNREFUSED 和 TimeoutError 分开文案
- P2-3：core.start() 加 console.time/console.timeEnd
- P2-5：按钮 6s 冷却

**第 2 优先级（30 分钟 / 跨文件）**：
- P0-2：showBootFailure 改造成 3 按钮面板（reload / 打开日志 / 复制详情）
- P0-3：showBootFailure 触发时 IPC 通知主进程缩阈值
- P1-1：bootLogs 通过 IPC 写入主进程日志
- P2-2：多实例端口冲突显式提示

**第 3 优先级（排期）**：
- P1-3：bootLogs 行尾带相对时间戳
- P2-4：bootLoop 失败时主进程立刻知道

## 五、备份与回滚

**本轮未改代码**。审查报告交付，等你选优先级 + 决定是临时缓解还是 R126 一次做完。

如果想立刻做 P2-3（30 秒可改 3 行），告诉我，我直接改 + node --check + 让你重启验证。其他都建议打包 0.4.8.3 一并出。
