# QQAgent R125 · 协议端无窗口启动（把 SnowLuma 的黑窗口收进软件）

> 版本：0.4.9.1（运行目录 `G:\QQagent\resources\app`）
> 日期：2026-10-27
> 需求：0.4.8.9 把 SnowLuma 移出安装包后，用户改成自己双击 `launcher.bat` 启动，
> 桌面上就常驻一个 cmd 窗口。要把它收进软件。

---

## 一、方案选型

| 方案 | 结论 | 原因 |
|---|---|---|
| A. 软件 spawn 用户那份 SnowLuma，`windowsHide` + 接管 stdout | **采用** | 窗口彻底消失；日志就是原来 cmd 里的内容，实时、带时序 |
| B. 只 tail `logs/snowluma-*.log` | 否 | 窗口还在；文件按天追加，要处理轮转/半行；启动早期的 WebUI 地址、密码可能还没落盘 |
| C. 改 `launcher.bat` 用 VBS 隐藏窗口 | 否 | 要改用户的文件；窗口只是藏起来，日志还是看不到 |

A 的关键点：**不是重新内置协议端**。目录由用户指定，程序只读它的 `index.mjs` 路径，
不复制、不修改、不打包。

## 二、改动清单

### 新增 `src/protocol-launcher.js`（约 330 行）

- `probeLaunchDir(dir)`：校验目录（必须有 `index.mjs`），顺带判断有没有自带 `node.exe`
- `launch({dir, auto})`：`spawn(nodeExe, [index.mjs], { cwd, windowsHide: true, stdio: ['ignore','pipe','pipe'], detached: false })`
- `stop()`：Windows 走 `taskkill /pid <pid> /t /f`（连子孙一起收，避免孤儿占 3001）
- `dispose()`：应用退出时回收（管道随主进程断开，留着就是"看不见日志的孤儿"）
- 日志：环形缓冲 800 行 + 120ms 批量 SSE（`protocol-log`）+ ANSI 剥离 + 单行 2000 字截断

### 改 `src/config.js`

`protocol` 下新增：

```js
launcher: { dir: '', autoLaunch: false }
```

`autoLaunch` 默认 **false** —— 用户不点就什么都不发生。

### 改 `src/app.js`

- 创建 `protocolLauncher`，`detectDir` 复用现成的 `detectProtocol()`（先看运行中的进程，再扫盘）
- `start()`：`autoLaunch === true` 时异步拉起（不阻塞启动路径，OneBot 有重连兜底）
- `stop()`：`protocolLauncher.dispose()`

### 改 `src/routes.js`

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/protocol/process` | 状态 + 最近日志 |
| POST | `/api/protocol/process/launch` | 无窗口启动（可带 dir） |
| POST | `/api/protocol/process/stop` | 停止（只停本软件拉起的） |
| POST | `/api/protocol/process/config` | 保存目录 / 自动启动开关 |
| GET | `/api/protocol/process/logs` | 只取日志 |

`/api/status` 增加 `protocolProcess` 字段。

### 改 `ui/app/03-connection.js` + `02-sse-sessions.js` + `style.css`

连接页新增「协议端进程：交给本软件启动（不再弹黑窗口）」折叠区：

- 目录输入 + 「自动查找」
- 「无窗口启动」/「停止」
- 「随 QQ Agent 自动启动」勾选框
- 实时日志面板（就是原来 cmd 的内容）+ 「打开控制台」

SSE 事件 `protocol-log` 只追加日志，**不重拉整页**（否则会把用户正在读的滚动位置顶掉）；
`protocol-status` 才触发状态刷新。

### 改 `src/protocol-detect.js`

`publicView()` 增加 `dir` 字段 —— 连接页「自动查找」要用它预填目录（不是秘密，界面上本来就允许手填）。

## 三、EULA 边界（这次特意守住的三条）

1. **不随包分发**：安装包里没有 `snowluma/` 目录，目录由用户指定；
2. **不改它的文件**：不写 `config/`、不接管 WebUI 密码；
3. **不代签协议**：0.4.8.x 的 `SNOWLUMA_ACCEPT_EULA=1` / `SNOWLUMA_ACCEPT_PRIVACY=1`
   没有恢复 —— 用户的 `config/consent.json` 已经存在（他自己同意过）。

## 四、顺带修掉的一个真实缺陷

写测试时发现的：Node 的 `data` 事件不保证在换行处断开，原来的实现按 chunk 直接 `split`，
一行日志会被切成两截（SnowLuma 的启动横幅、JSON 输出尤其明显）。已改成跨 chunk 行缓冲，
进程退出时 flush 残余。

## 五、测试

新增 `tests/protocol-launcher.test.mjs`（10 条）：

- 目录没有 `index.mjs` → 拒绝启动，且不 spawn 任何进程
- 启动参数断言：`windowsHide === true`、`stdio` pipe、`cwd` 指向用户目录、`detached === false`
- 目录里没有 `node.exe` → 用当前进程的 node 兜底
- stdout 分片重组（`'第一行\n第二'` + `'行\n'` → 两条完整日志）
- stderr 标级 + ANSI 剥离
- 超长行截断
- `taskkill /pid <pid> /t /f` 参数正确
- 没启动过就 stop：不误杀
- 进程退出后状态回落 + 广播 `protocol-status`
- `dispose()` 回收子进程

全量：**157 通过 / 0 失败**（`node --test tests/*.test.mjs`）。

## 六、实测记录（2026-10-27 08:36，真实 SnowLuma）

用 `node src/server.js` 起了一个 headless 核心（不启 Electron 窗口），直接打接口验证：

```
POST /api/protocol/process/launch {"dir":"C:\\Users\\Administrator\\Desktop\\SnowLuma-v2.1.1-win-x64"}
→ {"ok":true,"launched":true,"pid":15776,"hasOwnNode":true}

GET /api/protocol/process  （8 秒后）
[托管] SnowLuma 启动中：…\node.exe …\index.mjs
[托管] 工作目录 C:\Users\Administrator\Desktop\SnowLuma-v2.1.1-win-x64
08:36:25 INFO [App] SnowLuma starting
08:36:25 INFO [App] Node integrity: pid=2548, process=Medium (RID=8192); EXE=unlabeled
08:36:25 INFO [WebUI] login rate-limit keyed by: socket peer (default)
08:36:25 INFO [WebUI] listening http://127.0.0.1:5099

netstat → 127.0.0.1:5099 LISTENING（pid 2548）

POST /api/protocol/process/stop
→ {"ok":true,"stopped":true,"pid":15776}
netstat → 5099 已释放；tasklist → SnowLuma 的 node 进程全部消失
```

两点值得记下来：

1. **没有黑窗口**，日志（含 WebUI 地址）全部进了接口 —— 就是原来 cmd 里的内容；
2. SnowLuma 的真实监听进程（pid 2548）和 spawn 出来的外层进程（pid 15776）**不是同一个**
   （它会自己再拉一层）。所以停止必须走 `taskkill /t`，只杀外层会留下占着 5099 的孤儿 ——
   实测 `/t` 能把整棵树收干净。

## 七、怎么切过去（需要重启一次）

**目录已经帮你预填好了**（`G:\QQagent\data\config.json` 的 `protocol.launcher.dir`
写的是 `C:\Users\Administrator\Desktop\SnowLuma-v2.1.1-win-x64`，原文件备份为
`config.json.bak-20261027-r125`），所以：

1. 确认现在那个 cmd 窗口已经关掉（关掉 = 机器人离线）；
2. 启动 QQ Agent（我刚试过，测试时起的进程都已清理干净，当前没有实例在跑）；
3. 打开「工具 → 连接」，展开「协议端进程」；
4. 目录应该已经填好，直接点「**无窗口启动**」；
5. 日志会开始滚（WebUI 地址、密码、OneBot 端口都在里面）；
   等它把 QQ 注入、OneBot 起来，页面顶部会自动变成「机器人工作中」；
6. 想让以后开机即用，勾上「随 QQ Agent 自动启动」。

> 中途想退回黑窗口：关掉软件（会连带停掉托管的进程），双击原来的 `launcher.bat` 即可。
> 两条路互斥 —— 同时开两个实例会抢 3001 端口。

## 八、分发合规与"别人也能用"（2026-10-27 二次加固）

### 8.1 安装包里确实还藏着 SnowLuma

`C:\Users\Administrator\Desktop\打包器\payload\payload.7z`（10-22 的载荷）里有
`resources\app\snowluma\` —— **8 个目录 / 43 个文件 / 解压后 110 MB**。
0.4.9 的运行目录早就没有它了，但打包器直接用这份 7z 出包，所以打出来照样会带。

已从载荷删除：

```
7za d payload.7z "resources\app\snowluma" -r
→ Delete: 8 folders, 43 files, 110 MiB
→ Archive: 113 MB → 97 MB，7za t 校验通过
备份：payload.7z.bak-before-nosnowluma
```

> ⚠️ 这份载荷本身也过期了（10-22，不含 0.4.9.1 和今天两个修复）。**发版前请重新生成**
> （README 里的命令：`7za a -t7z -m0|lzma2 -mx=9 payload.7z ".\win-unpacked\*" -x!"*.pdb"`，
> 并排除 `data/`、`dev-sandbox/`）。现在删 snowluma 的意义是"万一误用旧载荷，也不会违规"。

### 8.2 修掉一个会让"别人的 SnowLuma"跑偏的 bug

原来的 node 兜底写的是 `process.execPath`：

```js
const nodeExe = probe.hasOwnNode ? probe.nodeExe : process.execPath;   // ← 错的
```

`process.execPath` 在 Electron 主进程里是 **`QQ Agent.exe`**，不是 node。用户如果下到的是
不带 `node.exe` 的发行包，这一行等于"再启动一个 QQ Agent 去跑 index.mjs" ——
表现是点了启动没反应，或弹出第二个实例去抢单实例锁，而且**不报错**。

现在按这个顺序解析（`resolveNodeRuntime`）：

1. 目录自带 `node.exe` → 用它（官方发行包都是这种，最稳）；
2. 非 Electron（headless）→ 才允许用 `process.execPath`；
3. Electron → 查系统 PATH 里的 `node`（`where node`）；
4. 都没有 → **明确报错**，告诉用户去下官方完整发行包，绝不拿 exe 顶替。

### 8.3 兼容真实下载形态

| 场景 | 处理 |
|---|---|
| 解压多出一层：`SnowLuma-x64\SnowLuma-x64\index.mjs` | 自动下钻一层（**仅当外层目录名像 snowluma**，避免误填桌面也被"猜对"） |
| 老发行包只有 `index.js` | 也认（入口候选 `index.mjs` / `index.js`） |
| 路径带空格 / 中文（`D:\工具\SnowLuma 2.1`） | spawn 走数组参数、不开 shell，实测正常 |
| 装好了但还没登录过（没有 `config/onebot_*.json`） | 「自动查找」也返回目录，能直接点启动 |
| 用 NapCat | 不接管，继续用它自己的启动器（文案已写明） |
| 首次启动要同意 EULA / 登录 QQ | 不代签，日志里会打印 WebUI 地址，用户点「打开控制台」自己操作（文案已写明） |

### 8.4 文案同步

- `README.md`：三处"不分发、不启动"改成"不分发、不打包；启动由用户点一下触发（可选）"，
  并说明这只是替你按下启动键，不改文件、不代签协议。
- `使用说明.txt`：第 2 步加了 a/b 两种启动方式（launcher.bat / 无窗口启动），
  并注明 NapCat 不走这条路。
- 连接页：「协议端进程」那节加了下载入口、`index.mjs`/`node.exe` 的辨识提示、
  "首次要去控制台同意条款"的提醒。

### 8.5 测试

`tests/protocol-launcher.test.mjs` 从 10 条扩到 **17 条**，新增的重点是"别人的机器上会不会坏"：

- Electron 里没有 `node.exe` 也没有系统 node → 拒绝启动，**一个进程都不 spawn**
- Electron 里没有 `node.exe` 但有系统 Node.js → 用系统那个
- `resolveNodeRuntime` 在 Electron 下**永远不会**返回 `process.execPath`
- 解压多一层自动下钻；目录名不像 snowluma 时**不**下钻
- `index.js` 老包能启动
- 路径含空格与中文：不开 shell、cwd 正确

全量：**164 通过 / 0 失败**。

## 九、风险与回退

- **协议端生命周期变了**：以前 cmd 窗口是独立的，关软件不影响它；现在由软件拉起的会
  跟着软件退出。这是刻意的 —— 管道断了就收不到日志，留着只会变成看不见的孤儿进程。
  用户自己开的窗口仍然不受影响。
- **日志量**：SnowLuma 高峰时一秒十几行，后端 120ms 合批、前端只重绘 `pre`，
  实测不会卡；如果以后觉得吵，可以在 UI 加"只看 warn/error"过滤（本次没做，避免过度设计）。
- 回退：`git` 不适用（无仓库），改动前未单独备份这三个文件，但全部是**新增**逻辑 +
  少量插入点，删掉 `protocol-launcher.js` 与对应的 5 处引用即可回到原状。
  关键插入点：`src/app.js` 的 `createProtocolLauncher` / `autoLaunch` / `dispose`、
  `src/routes.js` 的 5 条路由与 `protocolProcess` 字段、`ui/app/03-connection.js` 的
  `connProc*` 系列函数。
