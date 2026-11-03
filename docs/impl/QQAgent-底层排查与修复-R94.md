# 洛版 QQ-Agent v0.4.7 · 底层排查与修复 R94

> 目标（用户原话）：**从底层排查所有可能会导致「闪退 / 崩溃 / 任务栏图标莫名其妙亮起来 / 会话界面莫名其妙重新加载」等问题。**
>
> 范围：只针对桌面 `洛版QQ-Agent-v0.4.7\resources\app`（G 盘安装版不管）。
> 基线：`_backup-r93-20261012-213150`（90 文件全树）+ `_backup-r94-20261012-214836`（本轮 3 文件）。
> 结论：**本轮定位 6 处真实缺陷并全部修复**；另有 7 项属"已知不可修/待产品决策"，见 §6。

---

## 1. 排查方法：四类症状 × 逐层枚举

不看单个文件，而是**按症状反推触发路径**，把整棵树里所有能产生该症状的调用点全部列出来，再逐个判定"是否会真的发生、是否已被既有守卫挡住"。

| 层 | 枚举对象 |
|---|---|
| ① 窗口生命周期 | `show / focus / hide / destroy / createWindow / setSkipTaskbar / maximize / minimize / setOpacity / setIcon` |
| ② 导航与重载 | 主进程 `webContents.reload / loadURL`、渲染进程 `location.reload`、SSE 重连、全量 `innerHTML` 重建 |
| ③ 进程退出 | `app.exit / app.quit / process.exit / uncaughtException / unhandledRejection / render-process-gone / child-process-gone` |
| ④ 定时器 | 全部 `setInterval / setTimeout`（渲染侧 62 处）与主进程看门狗 |

---

## 2. 症状 A —— 闪退 / 崩溃

### 2.1 枚举结果

| 位置 | 行为 | 判定 |
|---|---|---|
| `main.js:198` `uncaughtException` → `app.exit(1)` | 主进程任何同步异常 = 立刻结束进程 | ⚠️ 见 R94-3 / R94-4 |
| `main.js:625` 托盘「强制退出」→ `app.exit(0)` | 用户主动 | 正常 |
| `main.js:249 / 616 / 1107 / 1108 / 1134 / 1153` `app.quit()` | 正常退出链 | 正常 |
| `src/server.js:9 / 15` `process.exit(1)` | **headless 入口专用**，Electron 路径不走这里 | 正常 |
| `src/instance-lock.js:313` `process.exit(1)`（30s 保险丝） | 仅 SIGINT/SIGTERM 后优雅退出挂死时 | 正常 |
| `render-process-gone` → `loadURL` ≤5 次 | 渲染崩溃自愈 | 正常 |
| `child-process-gone` → 仅记日志 | 不自杀 | 正常 |
| GPU 致命链（R44：GPU 进程被杀 → Chromium "Goodbye" 自杀） | `disableHardwareAcceleration()` + `--disable-gpu` + `--disable-software-rasterizer` 从源头掐断 | 已闭合 |
| 全项目 `new BrowserWindow` 计数 | **1 处**（`main.js:828`） | 无幽灵窗口 |
| `flashFrame / requestUserAttention / Notification / setOverlayIcon / setThumbarButtons` | **0 处** | 不存在主动"点亮任务栏"的 API 调用 |

### 2.2 R94-3：托盘菜单回调里的裸 `core.` 解引用 —— 一条潜在的"闪退"路径

`createTray()` 的三个回调里直接解引用 `core`：

```js
{ label: '暂停 / 恢复', click: () => core?.orchestrator.setPaused(!core.orchestrator.paused) },  // 后半段没有可选链
checked: !!core.getConfig().server?.autoStart,
click: (item) => { core.updateConfig({ ... }); ... }
```

`core?.orchestrator` 会短路，但**同一表达式里紧接着的 `!core.orchestrator.paused` 不会**；后两处更是完全没有可选链。托盘菜单回调抛出的异常在 Electron 里就是 `uncaughtException` —— 而那个 handler 直接 `app.exit(1)`。也就是说：启动/退出竞态下 `core` 一旦不可用，用户点一下托盘菜单就会**整个进程消失**。

**修复**：三处全部改为 `core?.` / `core?.orchestrator?.` / `core?.updateConfig?.(...)`，并各自包一层 `try/catch`。宁可这一项点不动，也不能把进程带走。

### 2.3 R94-4：logger 绑定之前，所有关键日志落空 —— "闪退但日志里什么都没有"

`bindCoreLogger()` 要等 `app.whenReady()` 才跑，在那之前 `coreLogger` 恒为 `null`：

```js
function logCritical(module, text) {
  try { coreLogger?.error(module, text); } catch { }   // null → 什么都不做
  try { console.error(`[${module}] ${text}`); } catch { }  // 打包版没有终端接管 stdout
}
```

而 `main.js` 里**在 ready 之前就会调它**——例如 `resolveDataDir()` 的 catch。于是"启动阶段闪退"在 `data/logs/` 里一行都不会有。r93 那轮定位原生硬崩溃（0xC0000005）时，最费时间的一步正是这个：日志看着正常，崩溃现场零证据。

**修复**：新增 `fallbackLog(level, module, text)`，在 `coreLogger` 尚未绑定时同步追加到 `<DATA_DIR>/logs/boot-fallback.log`；logger 一旦绑上就自动让位（不会产生重复行）。

关键设计点：**刻意不用 `__dirname`** —— 它在 `main.js` 下方才声明，而本函数可能被更早的代码调到，引用它就是 TDZ `ReferenceError`。路径改为现算：

```js
const base = process.env.QQ_AGENT_DATA_DIR
  || (app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), dataDirName())
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', dataDirName()));
```

---

## 3. 症状 B —— 任务栏图标莫名其妙亮起来

### 3.1 枚举结果（`electron/main.js`）

| 调用 | 行号 | 是否用户意图 |
|---|---|---|
| `show()` | 588（showWindow）/ 885（ready-to-show）/ 917（did-finish-load）/ 1081（whenReady 复用窗口） | 前三个需守卫 |
| `focus()` | 592（showWindow）/ 921（did-finish-load）/ 1083（whenReady） | ⚠️ 921 见 R94-1 |
| `setSkipTaskbar(false)` | 591 / 1082 | 配对 `hide()` 的注销 |
| `setSkipTaskbar(true)` | 1015（close → 缩托盘） | 正确 |
| `hide()` | 1016 | 正确 |
| `destroy()` | 398（`rebuildWindow`） | 看门狗专用 |
| `createWindow()` | 401 / 594 / 1087 | — |
| `maximize()` | 648（IPC）/ 1038（还原存档） | 正确 |
| `minimize()` | 641（IPC） | 正确 |

已存在的守卫（r93 落地）：`windowHidden`（缩托盘不弹）、`windowJudgeable()`（隐藏/最小化/被遮挡时不下僵死结论）、`isMinimized()` 早退、`windowEverShown`（不重复 `show()`）。

### 3.2 R94-1：看门狗**重建窗口**后仍会抢一次焦点 ← 本轮核心修复

```js
// createWindow() 内部
let firstFinish = true;                    // ← 每建一次窗口就复活
...
if (firstFinish) { firstFinish = false; mainWindow?.focus(); }
```

r93 引入的 `windowEverShown` 只挡住了**多余的 `show()`**，但 `focus()` 走的是另一个局部标志。看门狗重建窗口走的是 `destroy() + createWindow()`，于是：

> 重建 → 新窗口 → `ready-to-show` → `show()` → `did-finish-load` → `firstFinish === true` → `focus()`

**每次看门狗重建都会抢一次焦点。** 用户在全屏游戏里时，这一下在 Windows 上就表现为任务栏图标闪一下——正是群友报的"莫名其妙亮起来"。r93 把重建频率压低了（阈值 2→3 + 复核探针 + `windowJudgeable`），但**这条路径本身没被切断**。

**修复**：把 per-window 的 `firstFinish` 换成**模块级** `focusedOnce`，焦点整进程只给一次：

```js
let focusedOnce = false;   // 模块级，跨窗口重建存活
...
if (!focusedOnce) { focusedOnce = true; mainWindow?.focus(); }
```

`showWindow()`（托盘双击 / 再次启动 = 用户明确要窗口）里同时置位 `focusedOnce = true`，所以"用户主动唤出"这条正常路径不受影响。

---

## 4. 症状 C —— 会话界面莫名其妙重新加载 / 卡界面

### 4.1 枚举结果

**主进程侧（真·页面重载）**

| 触发 | 行号 | 频率 | 判定 |
|---|---|---|---|
| `webContents.reload()` | 420 | 连续 12 次 boot 探测失败（≈60s）后 1 次 | 合理自愈 |
| `loadURL`（did-fail-load 重试） | 935 | 2s→4s→8s→16s，≤5 次 | 合理 |
| `loadURL`（render-process-gone） | 947 | 1.5s 后，≤5 次 | 合理 |
| `loadURL`（首屏 / whenReady 复用） | 976 / 1084 | 各 1 次 | 合理 |

**渲染进程侧（`location.reload`）**：仅 2 处，且都是用户主动
- `ui/app/00-core.js:654` —— 启动失败卡片上的「重新加载界面」按钮
- `ui/app/07-settings-events.js:1389` —— 「预览演示模式」开关（写哈希后重载）

**渲染进程侧（视觉上的"列表整块重建"）**

| 位置 | 行为 | 判定 |
|---|---|---|
| `renderSessionList()`（`box.innerHTML = …`） | 02-sse-sessions.js:208/305/626/886、10-feedback.js:558、00-preview.js:577 | 非 quiet 调用才全量重建；quiet 路径已有 `sessionsSig` 短路（BUG-13） |
| `loadSessions()` 非 quiet | 02:10（session-start）、02:64（session-end）、00-core:782（切到会话页）、11-init:88（首启） | 低频，合理 |
| `refreshStatus()` | **13 个调用点**，见下 | ⚠️ 见 R94-2 |
| `syncIdentity()` | `setInterval(…, 3000)` + 包装在 refreshStatus 后 | 已有 `lastIdent` 签名（R80/BUG-14），安全 |
| 定时器 | `__qaBeat` 1000ms、`statusPollTimer`/`listPoller`（15s，下限 1s）、`waitTicker` 100ms（无元素即自清）、`consolidateTicker`、`runUpdateCheck` 3600s、previewTick 5000ms | 正常 |

`refreshStatus()` 的 13 个调用点：`01-boot:109`、`02:11`（session-start）、`02:66`（session-end）、`02:78`（**chat-update，每条消息都发**）、`02:126`（onebot-status）、`02:129`（status）、`02:130`（snowluma-status）、`02:131`（qq-portable-status）、`02:244`（状态轮询）、`02:349`（停在设置页）、`04:133`、`07:274`、`11-init:85`、`14-chrome:955/971`。

### 4.2 R94-2：`refreshStatus()` 没有变更检测 —— 每轮无条件重写整条顶栏

```js
async function refreshStatus() {
  state.status = await api('/api/status');
  ...
  dot.className = ...            // #onebot-dot
  label.textContent = ...        // #onebot-label
  label.title = ...
  $('#model-label').textContent = ...
  $('#usage-label').textContent = ...
  $('#search-count-label').textContent = ...
  $('#pause-btn').textContent = ...
  renderBanner();                // ← 横幅可见时 innerHTML 整块重建
  updateReadinessDots(s);        // ← 4 个圆点各写 className + title
}
```

**值一字未变也照样写。** 而它被 13 个地方调用，其中 `chat-update` 是**每条聊天消息都触发一次**。同一文件里的 `syncIdentity()` 早就做了签名短路（R80/BUG-14），`loadSessions()` 也做了（BUG-13）——**只有 `refreshStatus()` 被漏掉了**。

最直观的后果在 `renderBanner()`：

```js
banner.innerHTML = html;   // 每次调用都把两个按钮和它们的 click 监听器一起重造
```

暂停中、或一直没连上 OneBot 时，横幅每 15 秒（设置页可调到 1 秒）**闪一次**。

**修复（两处）**

1. `ui/app/01-boot.js` —— `refreshStatus()` 增加写入签名：签名只取"参与渲染的标量"（不含对象引用，否则每轮必变），成本/命中率取整后再入签名（浮点末位抖动不该算变化）；`updateReadinessDots` 依赖的"配置是否齐全"那几个字段也一并入签名，否则用户在设置页填好地址/模型后圆点 3 要等下一次 status 变化才亮。`state.*` 仍然每轮更新（其它模块读它），**只有 DOM 那一层被短路**。

2. `ui/app/00-core.js` —— `renderBanner()` 增加内容签名 `lastBannerHtml`：html 串不变就不动 DOM（按钮与监听器原地保留）；横幅隐藏时清空签名，不赌"隐藏期间 DOM 没被动过"。

### 4.3 R94-5：`harvestBootDiagnostics()` 的 3 秒悬空定时器

```js
const info = await Promise.race([
  wc.executeJavaScript(...),
  new Promise((res) => setTimeout(() => res(null), 3000))   // 秒回也不清
]);
```

与 `probePage` 的 `raceTimer` 同一笔账（R80/R79-4 已经修过那边）。已加 `diagTimer` + `finally { clearTimeout }`。

---

## 5. 症状 D —— 卡界面（既有守卫复核）

| 机制 | 位置 | 状态 |
|---|---|---|
| 看门狗 5s 一轮，常驻不解除武装 | `main.js:472` | 已就绪 |
| 探针四态 `ready / boot / hung / gone` + `__qaBeat` 心跳 + `document.visibilityState` | `main.js:305` | 已就绪（r93） |
| `hung`：`windowJudgeable` + 连续 3 次 + 动手前 1200ms 复核 | `main.js:517` | 已就绪（r93） |
| `boot`：连续 12 次（≈60s，与页面自身 45s `showBootFailure` 对齐）才重载 | `main.js:550` | 已就绪 |
| 休眠恢复 8s / 解锁 4s 静默期（`powerMonitor`） | `main.js:1057` | 已就绪（r93） |
| 后台降载：19 处 infinite 动画在隐藏时 `animation-play-state: paused` | `style.css` 末尾 + `00-core.js:32` | 已就绪（r93） |
| `store.getChatMeta()` 按 `(mtimeMs, size)` 缓存（原来每 15s 对**每个**磁盘会话 `readFileSync + JSON.parse`） | `src/store.js` | 已就绪（r93） |
| 单实例锁：`tasklist` 廉价预筛 + CIM 2500ms + 记忆 + 60s 心跳 / 10min 陈腐阈值 | `src/instance-lock.js` | 已就绪（r93） |

---

## 6. 本轮修的 6 项（一览）

| 编号 | 症状类 | 文件 | 改动 |
|---|---|---|---|
| **R94-1** | 任务栏亮起 | `electron/main.js` | `firstFinish`（每窗口）→ `focusedOnce`（每进程）；看门狗重建后不再抢焦点 |
| **R94-2** | 界面重载 / 卡界面 | `ui/app/01-boot.js` | `refreshStatus()` 增加写入签名，未变则整层跳过 DOM 写入 |
| **R94-2b** | 闪烁 | `ui/app/00-core.js` | `renderBanner()` 增加内容签名，未变则不重建 `innerHTML` |
| **R94-3** | 闪退 | `electron/main.js` | 托盘菜单 3 个回调全部可选链 + try/catch（原可把进程带走） |
| **R94-4** | 闪退无证据 | `electron/main.js` | 新增 `fallbackLog()`：logger 绑定前的关键日志同步落盘 |
| **R94-5** | 卡界面 | `electron/main.js` | `harvestBootDiagnostics()` 的 3s 定时器补 `clearTimeout` |

改动面：**3 个文件 / 15 处替换 / 11 个 diff hunk / 14286 字节补丁**。`src/**` 与 `ui/style.css` 本轮**零改动**。

---

## 7. 验证证据（4 组，全部实跑）

### 7.1 补丁正反向 md5 双验 ✅

```
baseline = _backup-r94-20261012-214836
patch    = r94-fixes.patch   14286 bytes   hunks=11  files=3
  fwd OK  electron/main.js   ddb7cdcdd2c6a1360a7323d70fd7447f == ddb7cdcdd2c6a1360a7323d70fd7447f
  fwd OK  ui/app/01-boot.js  4da69a7be55bea0851ec623d81a58e5b == 4da69a7be55bea0851ec623d81a58e5b
  fwd OK  ui/app/00-core.js  4a7acb4753657b8c918f6f9efbf41d0a == 4a7acb4753657b8c918f6f9efbf41d0a
  rev OK  electron/main.js   12a27c9acd7893c0b3048aeafc3fd49c == 12a27c9acd7893c0b3048aeafc3fd49c
  rev OK  ui/app/01-boot.js  8ffb1e2a4def50c0ab7e7cbd77353d0a == 8ffb1e2a4def50c0ab7e7cbd77353d0a
  rev OK  ui/app/00-core.js  bc9c8a784ff6e61bcbed406457f65ba5 == bc9c8a784ff6e61bcbed406457f65ba5
VERIFY PASS
```

### 7.2 端到端 DOM 验证（真实 Chromium，10/10 PASS）✅

用本机 Edge(Chromium) + puppeteer-core 打开**真实控制台页面**（隔离数据目录 + 隔离端口 3412 起后端），用 `MutationObserver` 实测 DOM 变更次数：

| 断言 | 结果 |
|---|---|
| 检测器阳性对照：把**相同值**再写一次会被抓到 | PASS（n=1） |
| **幂等**：状态未变时连刷 3 次 → 7 个节点**零** DOM 变更 | PASS（total=0） |
| 阳性对照：暂停后确有变更（不能把界面改成不刷新） | PASS（total=15） |
| 阳性对照：暂停后横幅可见 | PASS |
| 阳性对照：暂停后按钮文案 = 恢复 | PASS |
| **幂等（暂停态）**：再刷 3 次 → 零变更（`renderBanner` 签名生效） | PASS（total=0） |
| 阳性对照：恢复后横幅不再显示"已暂停" | PASS |
| 阳性对照：恢复后按钮文案 = 暂停 | PASS |
| 心跳 `__qaBeat` 仍在递增（看门狗依赖它） | PASS |
| 页面无未捕获异常 | PASS |

> 注：第一项是方法论要求的"**验证器必须先阳性对照**"——先证明这套探针确实抓得到"值没变也写 DOM"这件事（旧代码的行为），后面那些 0 才有意义。测试环境里 OneBot 必然未连接，所以"恢复暂停"后横幅切换成「🔌 OneBot 未连接」而非隐藏，这是期望行为。

### 7.3 `fallbackLog` 真身单测（5/5 PASS）✅

从 `main.js` 里**按大括号配对抠出真实源码**（只把 `import.meta.url` 换成字面量），用桩跑：

| 场景 | 结果 |
|---|---|
| `QQ_AGENT_DATA_DIR` 已设 | 落 `<DIR>/logs/boot-fallback.log`，行格式正确 |
| 打包版 + env 未设 | 落 `<exeDir>/data/logs/boot-fallback.log` |
| 开发版 + env 未设 | 落 `<appDir>/data/logs/boot-fallback.log` |
| 写盘必失败（`EACCES`） | **不抛出**（不拖累调用方） |
| `coreLogger` 已绑定 | 兜底通道**零调用**（不产生重复行） |
| 源码中不含 `__dirname` | 确认（无 TDZ 风险） |

### 7.4 收尾核验 ✅

```
① 改动面一致（相对 r93 基线恰好 6 个文件 = r93 的 5 个 + 本轮新增 1 个；added=0）  True
② 换行/编码一致（CRLF/bareLF/BOM/U+FFFD 全对齐基线）                              True
③ 改动落点完整（18 条关键字断言全中）                                             True
FINAL PASS
```

外加：3 个文件 `node --check` 全部 PASS。

---

## 8. 仍然存在的（不可修 / 待决策，与 r93 报告一致）

| 项 | 为什么现在不动 |
|---|---|
| BUG-07 原生硬崩溃 `exe+0x37BF0CA` 的符号 | 本机无 cdb/WinDbg，发行包只带 `resource.pdb`、**没有 `electron.exe.pdb`** → 拿不到函数名。已确认崩溃落在 `.text`（VA `0x1437BF0CA`），指令 `movzx eax, byte ptr [rcx+0xb]`，前有 `test rcx,rcx / je` → 非空但无效指针（悬垂/越界/堆损坏）。r93 已把版本/electron/node/chrome/arch/dataDir 写进 crashpad 注解 |
| BUG-08 `hotReload` 默认值 | 产品决策 |
| UI-18 人格残留文案 / UI-06·23·27 皮肤层 | 产品/设计决策 |
| R78-8 `saveChat` 追加式 | 改动面大，收益不明确 |
| R78-9 `atomic-write.js` 死代码 | 清理项，非缺陷 |
| 约 3.5MB 可剥离的 A/B 重复 `.node` | 体积优化，与稳定性无关 |

---

## 9. 文件与回滚

**改动的 3 个文件**
```
resources/app/electron/main.js        72596 B / 1207 行（CRLF）
resources/app/ui/app/01-boot.js        9476 B /  182 行（CRLF）
resources/app/ui/app/00-core.js       57849 B / 1101 行（CRLF）
```

**基线备份**
```
洛版QQ-Agent-v0.4.7/_backup-r94-20261012-214836/{electron/main.js, ui/app/01-boot.js, ui/app/00-core.js}
```

**补丁（已正反向验证）**
```
_r94/r94-fixes.patch        14286 B / 11 hunks / 3 files
  正向：patch --binary -p0 -i r94-fixes.patch       （在备份副本上打 → 等于现文件）
  反向：patch --binary -R -p0 -i r94-fixes.patch    （在现文件副本上打 → 等于备份）
```

**回滚一行**
```bash
cd "C:\Users\Administrator\Desktop\洛版QQ-Agent-v0.4.7\resources\app"
patch --binary -R -p0 -i "<...>\_r94\r94-fixes.patch"
```

**验证脚本（全部可重跑）**
```
_r94/backup.py         基线备份
_r94/apply.py          字节级改写（15 处，二进制模式保 CRLF）
_r94/gen_verify.py     生成补丁 + 正反向 md5 双验
_r94/dom_test.cjs      端到端 DOM 验证（Edge + puppeteer-core）
_r94/fallback_test.cjs fallbackLog 真身单测
_r94/final_check.py    改动面 / 换行 / 落点 收尾核验
```
