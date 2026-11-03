# QQ Agent 启动卡 45 秒 · R125 修复实施报告（→ 0.4.8.3）

> 配套审查报告：`QQAgent-R125-启动卡45秒-代码审查报告.md`
> 改动基准：运行版 `G:\QQagent\resources\app`（开发树已落后，不回灌）
> 备份 tag：`R125-20261014`（6 个 `.bak` 文件）

## 一、根因（一句话）

旧 `bootLoop` 只探 `/api/status` 一个接口，把「HTTP 端口拒绝连接（控制台服务真没起）」和「HTTP 起了但 `/api/status` 慢（旧版本慢接口 / OneBot 卡）」混成同一种失败；且 45 秒一到直接 `return` 渲染死卡片——**后端只要晚于 45 秒就绪，用户就只能手动刷新**，这就是群友"卡很久"的来源。

## 二、修复清单（11 条发现全部落地）

| 原分级 | 发现 | 落地方式 | 文件 |
|---|---|---|---|
| P0-1 | 只探 `/api/status`，两类故障混判 | `pollUntilReady` 失败时补 `pingConsole()`（打 `/api/version`），返回 ok/fail/**giveup** 三态；卡片文案按 `lastConsoleAlive` 区分"端口没起 / 服务在跑但没就绪" | 00-core.js |
| P0-2 | 错误卡片只有"重新加载"单按钮 | 改为三按钮面板：重新加载界面 / 打开日志目录 / 复制错误详情 | 00-core.js + preload.cjs + main.js |
| P0-3 | 45s 卡片 vs 60s 看门狗有 15s 空档 | **改为就地自愈**：45s 后只亮卡片、后台继续轮询，后端恢复即 `hideLoading()` 原地继续（比"缩阈值/3s 自动重载"更稳，不会造成重载循环） | 00-core.js |
| P1-1 | bootLogs 主进程看不到 | `showBootFailure` 里 `qqaDesktop.reportBootFailure(...)` → 主进程 `ipcMain.on('boot-failure')` → `logCritical('boot', ...)` 落盘 | 00-core.js + preload.cjs + main.js |
| P1-3 | bootLogs 无相对时间戳 | 每行带 `+Xs` 偏移（如 `[19:21:46 +0.0s]`）；失败卡片日志实时滚动 | 00-core.js |
| P2-1 | ECONNREFUSED 与 TimeoutError 文案未分 | `api()` 网络层失败（Failed to fetch / NetworkError）转译为"连不上控制台服务（网络层失败…）"，与超时分家 | 00-core.js |
| P2-2 | 端口冲突无提示 | `core.start()` 内检测 `port !== basePort` 时记日志"端口从 X 顺延到 Y：已被占用（多实例并存）" | app.js |
| P2-3 | `core.start()` 无耗时统计 | 加 `[boot]` 分级日志：端口监听 / Skill·插件加载 / SnowLuma 拉起 / OneBot 首连 / 总账（毫秒） | app.js |
| P2-4 | bootLoop 失败主进程不知 | 同 P1-1（`reportBootFailure`） | 三文件联动 |
| P2-5 | 重新加载按钮无冷却 | 点击后禁用 + `重新加载界面（6s）` 倒计时，6s 后才真正 `location.reload()`，防手抖连点把刚起来的页面刷掉 | 00-core.js |

## 三、关键设计决策

**P0-3 用"就地自愈"取代"缩看门狗阈值"**：原审查建议缩 `bootMisses` 阈值或 3s 自动重载。实际落地时改为 `bootLoop` 在 45 秒后**不放弃、继续后台轮询**，一旦 `/api/status` 返回 200 立即收起卡片继续走。理由：
- 自愈在后端就绪后 ~6 秒内完成，比"等看门狗 60s 重载"更快、体感更顺；
- 不会像 3s 自动重载那样在后端持续不可达时陷入重载循环；
- 看门狗的 60s 重载作为兜底仍有效（前端自愈基本先一步收尾，看门狗很少被触发），R92 的慢机器保护没有被削弱。

## 四、改动文件与位置

- `ui/app/00-core.js`
  - `setLoadingStatus`：bootLogs 加 `+Xs` 相对时间戳，同步刷新失败卡片日志
  - 新增 `failureLogEl` 引用；`hideLoading` 收尾时断开引用
  - 新增 `pingConsole()` + `lastConsoleAlive`
  - `pollUntilReady`：ok/fail/**giveup** 三态
  - `showBootFailure`：三按钮面板（重新加载带 6s 冷却 / 打开日志目录 / 复制错误详情）+ 上报主进程
  - `bootLoop`：上限 120→240，45s 后只亮卡片继续轮询
- `src/app.js`：`core.start()` 内 `[boot]` 分级耗时日志 + 端口顺延日志（上一轮已落）
- `electron/preload.cjs`：新增 `openLogDir` / `reportBootFailure`（不接收渲染进程参数，安全边界不变）
- `electron/main.js`：`ipcMain.handle('boot:open-log-dir')`（`shell.openPath` 打开 `data/logs`）+ `ipcMain.on('boot-failure')`（`logCritical` 落盘）
- `package.json`：`version` → `0.4.8.3`
- `ui/app/14-chrome.js`：`STAGE_CHANGELOG[0]` 置顶 0.4.8.3（5 条面向用户口径，旧条目保留）

## 五、校验与打包

- 语法校验（全过）：`00-core.js`、`app.js`、`preload.cjs`、`main.js`、`14-chrome.js`
- 版本号核对：`package.json` 与 `STAGE_CHANGELOG[0]` 均为 `0.4.8.3`
- 打包：`python make-portable.py --src G:/QQagent --version 0.4.8.3`
  （默认 ref 取桌面 `洛版QQagent 0.4.8.2.exe`）
- 产物：`C:\Users\Administrator\Desktop\洛版QQagent 0.4.8.3.exe`
- **待解包核对**：EXE → `resources/payload.7z` → 文件，确认 6 个改动文件在包内且版本号正确。

## 六、待用户真机验证

1. 故意让后端晚于 45s 就绪（如机器卡、OneBot 慢连）：45s 后应出现失败卡片，且**后台自动恢复**进控制台，无需手动刷新；
2. 失败卡片两类文案分离：端口没起时提示"连不上控制台服务 / 打开日志目录排查"，服务在跑时提示"后端还在就绪中 / 后台重试中"；
3. 三按钮可用：重新加载（6s 冷却）、打开日志目录（弹出 `data/logs`）、复制错误详情（剪贴板含 bootLogs）；
4. 主进程日志（`data/logs/qq-agent-*.log`）里能看到 `[boot] ...` 耗时行与 `[启动失败卡片]` 上报行；
5. 多实例并存时提示端口顺延而非静默失败。
