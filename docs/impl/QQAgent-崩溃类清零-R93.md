# QQ Agent 洛版 v0.4.7 · R93 崩溃/闪退/闪烁/卡界面 专项清零报告

- 日期：2026-10-12 晚（R92 之后）
- 工程文件（唯一改动对象）：`C:\Users\Administrator\Desktop\洛版QQ-Agent-v0.4.7\resources\app\`
- 基线备份：`_backup-r93-20261012-213150\`（89 文件 + `_baseline-md5.txt`）
- 补丁：`r93-fixes.patch` = **38,639 B / 5 文件 / 26 hunk**（`git -c core.autocrlf=false diff --no-index --binary --no-prefix`，正向/反向双验证通过）
- 范围：**只做"闪退 / 崩溃 / 莫名其妙闪烁 / 卡界面"这一类**。G 盘那份安装版按用户要求不处理。
- 上游状态：R76→R92 已结案 31 文件；本轮是在其之上针对本类症状的**专项复查 + 补修**。

---

## 〇 一句话结论

**这类症状的可修部分已全部修完（10 项 / 5 文件）。** 剩下的只有 1 项：原生硬崩溃
`0xC0000005` —— 它需要 WinDbg + 符号才能定位，**本轮把它从"未知"降级为"有明确结论"**：
3 个 dump 全部来自 **2026-10-11 12:52 之前构建的 exe**，而当前洛版的 exe 正是 12:52 那个构建，
此后 1 天多**零新增 dump**（详见 §四）。

---

## 一、本轮修的 10 项

### A 类 · 看门狗误判 → 用户眼里的「闪退 / 窗口自己消失 / 任务栏闪烁」

这一类的机制是：看门狗以为界面死了 → `old.destroy() + createWindow()` → 任务栏按钮
消失又出现、窗口凭空重建。R76 已关掉 `backgroundThrottling` 掐掉主因，但**还有三条假阳性路径**：

| # | 问题 | 修法 | 位置 |
|---|---|---|---|
| A1 | **`'hung'` 分支完全不看窗口状态**。窗口被遮挡 / 缩在托盘 / 系统刚休眠回来时，一次 `executeJavaScript` 4 秒超时就累计，**连续 2 次（≈10 秒）就拆窗**。重建出的新窗口会走 `ready-to-show` 的 `show()+focus()` → 缩托盘的用户被凭空弹回前台、全屏游戏里的用户被抢焦点 —— 就是"莫名其妙闪烁" | 新增 `windowJudgeable()`：可见性不成立时**不动手**；阈值 2 → 3（≈15 秒）；动手前**再做一次确认探针**，回话即判为瞬时抖动、放弃重建 | `electron/main.js` |
| A2 | **探针查不到"被别的窗口遮挡"**。崩溃报告里的 P1 项（加 `visibilityState`/occlusion）**至今没做** —— main.js 里 `isOccluded`/`visibilityState` 命中数都是 0 | 探针 JS 增加第三段：页面自报 `document.visibilityState === 'hidden' \|\| document.hidden`；`hidden` 为真时看门狗不下任何判断 | `electron/main.js` |
| A3 | **休眠恢复 / 锁屏解锁后没有宽限期**（全文 `powerMonitor` 命中数 = 0）。这两个时刻系统暂停过渲染进程定时器，恢复瞬间的一次超时会被当成僵死 → 拆窗。用户看到"睡醒回来窗口自己消失了一下" | 挂 `powerMonitor` 的 `resume`（静默 8s）/ `unlock-screen`（静默 4s），期间不判断且清零计数 | `electron/main.js` |

### B 类 · 窗口抢焦点 → 「闪烁」

| # | 问题 | 修法 | 位置 |
|---|---|---|---|
| B1 | **最小化后被重载「自己跳出来」**。R76 只挡了 `windowHidden`（点 ✕ 缩托盘），**漏了用户按最小化按钮**那条路：看门狗重载 / `did-fail-load` 重试成功后 `did-finish-load` 仍会 `show()`，而 `show()` 会把最小化窗口**恢复并抢焦点** | `did-finish-load` 增加 `isMinimized()` 守卫 | `electron/main.js` |
| B2 | **每次重载都 `show()` 一次**。`show()` 自带"激活并抢焦点"语义，而重载是看门狗自救/重试的正常动作，不该有可见副作用 | 新增 `windowEverShown` 标志：已显示过的窗口不再重复 `show()`，首次亮相仍由该处兜底（防 `ready-to-show` 未触发） | `electron/main.js` |

### C 类 · 卡界面

| # | 问题 | 修法 | 位置 |
|---|---|---|---|
| C1 | **`/api/chats` 每 15 秒同步读上千个会话文件**。`getChatMeta()` 走 `#state()`，对**不在 LRU 缓存（上限 120）里**的会话一律 `readFileSync + JSON.parse` 一整份；而 `/api/chats`（routes.js:3288）与 list-chats 工具（tools.js:552）都是**对磁盘上每个会话**循环调用。实测有 2277 个会话文件的实例、单群存档可达 1MB → 主进程每 15 秒同步读+解析上千个文件，事件循环被占满，**窗口 / HTTP / agent 一起卡住** | 新增元信息缓存，以 **`(mtimeMs, size)`** 当版本号：文件没变直接返回（一次 `statSync`，比 read+parse 便宜两三个数量级），变了自然失效；上限 4000，`invalidate()` 同步清 | `src/store.js` |
| C2 | **实例锁同步 spawn powershell**（最长 5s）。这段是**同步**跑在 `createApp()` 里、**建窗之前** → 双击后几百毫秒到 5 秒见不到窗口 | ① 加 `tasklist` 廉价预筛（30~80ms，硬崩溃后最常见的"PID 被无关程序复用"一步就能下结论）；② CIM 超时 5000 → 2500ms；③ 同一次抢锁内身份查询加记忆（原来两轮各查一次） | `src/instance-lock.js` |
| C3 | **身份查不了时的"双击没反应"**。`lockIsLive()` 在探测不可用（非 Windows / powershell 被安全策略拦 / 子进程被禁）时退回"PID 活着就算活着"—— 硬崩溃留下的锁 + PID 被无关程序复用，正好落在这条路上 → 新实例被拒，用户看到"双击没反应，提示已在运行但界面上根本没有" | 新增**锁心跳**：持有者每 60 秒刷新锁里的 `hb`；身份查不了时，若 `hb` 已陈旧 > 10 分钟即判残留锁接管。旧锁（无 `hb`）维持原语义 | `src/instance-lock.js` |
| C4 | **后台白烧 CPU/GPU**（R78-12 的落地）。R76 关掉 `backgroundThrottling` 是对的，代价是页面隐藏/被遮挡时 **19 处 `animation: … infinite`** 照样全速跑（骨架 shimmer、各类 spinner、`?` 主题的 VHS 扫描线 / chaosBgSpin 18s 等 11 处装饰动画）→ 笔记本耗电、集显机与合成器抢资源、偶发掉帧"看着像闪了一下" | 页面不可见时给 `<html>` 挂 `.qa-bg`，CSS 把**装饰性 infinite 动画**统一 `animation-play-state: paused`；恢复即继续。可见状态逐帧不变 | `ui/app/00-core.js` + `ui/style.css` |

### D 类 · 视觉层序（UI-11）

| # | 问题 | 修法 | 位置 |
|---|---|---|---|
| D1 | **弹窗被右下角警示卡压住**。`.banner` 是 610，而 `.modal-overlay` 只有 **100**、`.model-modal-overlay` 只有 **200** → 弹窗打开时右下角那张卡仍浮在最上面，模态语义被破坏。而且 `.banner` 的注释写着"低于模态（1000+）"—— **与实际相反**，后来人会被误导 | 两个遮罩抬到 **900 / 910**（高于 610/600/90/70，仍低于 `.loading-overlay` 999 与两类 toast 9998/9999），保持"加载遮罩盖住弹窗、提示盖住一切"的原意；注释改成与实现一致 | `ui/style.css` |

### E 类 · 崩溃取证

| # | 内容 | 修法 | 位置 |
|---|---|---|---|
| E1 | crashpad 注解只有一个 `version`。上次定位原生崩溃时，最费时间的一步是**先确认用户装的是不是同一个构建**（只能靠反复比对文件时间戳和体积） | `globalExtra` 扩充：electron / node / chrome 版本、arch、dataDir、instance、noSandbox。下次拿到 dump 一眼排除"版本不一致" | `electron/main.js` |

---

## 二、验证结果（全部实跑，不靠印象）

### 1. 补丁双向验证
```
[正向] patch --forward  rc=0 -> 5 文件 md5 与现盘全等  PASS
[反向] patch -R         rc=0 -> 5 文件 md5 与基线全等  PASS
```

### 2. 改动面
基线 89 文件 → **改动恰好 5 个，新增 0 个**（无夹带）：
`electron/main.js`、`src/instance-lock.js`、`src/store.js`、`ui/app/00-core.js`、`ui/style.css`

### 3. 静态校验
```
node --check       main.js / instance-lock.js / store.js / 00-core.js   4/4 PASS
行尾（对比基线）   CRLF 3 个、LF 2 个，逐文件一致                        5/5 PASS
编码               5 个改动文件 U+FFFD=0、BOM=0                          PASS
style.css 配平     { 2110  } 2110                                        PASS
```

### 4. 后端无头冒烟（隔离数据目录 + 独立端口 3399）
```
/api/status 200  /api/chats 200  /api/sessions 200  /api/config 200  /api/doctor 200
/api/chats 连打 5 次 → 12/12/12/12/12 字节，稳定无报错
23 Skill 全部加载，端口正常写入 console-port
```

### 5. 实例锁判定链（4 个场景实跑）
| 场景 | 期望 | 实测 |
|---|---|---|
| ① 残留锁 / PID 已死 | 接管启动 | ✅ 1.34s 启动 |
| ② 活 PID / 心跳陈旧 20 分钟 | 接管启动（**本轮新增逻辑**） | ✅ 1.34s 启动 |
| ③ 活 PID / 心跳新鲜 | 拒绝启动（保护真正在跑的实例） | ✅ 拒绝 |
| ④ v2 旧锁（无 `hb` 字段） | 拒绝启动（**旧行为不变**） | ✅ 拒绝 |

> 说明：本机沙箱禁止 spawn 子进程（`tasklist`/`powershell` 均返回 `EBUSY`），所以身份探测
> 在测试里一律返回 null —— 这恰好把测试聚焦到"身份查不了"这条路上，也就是 C3 新增的
> 心跳兜底。真实运行时两个探测都能用，走的还会更快。

---

## 三、为什么这些会表现为「闪退 / 崩溃 / 闪烁 / 卡界面」（机制串一遍）

```
窗口被遮挡 / 最小化 / 系统休眠
        │
        ├─ 渲染定时器被节流或暂停（心跳 __qaBeat 停摆）
        │        │
        │        └─ 看门狗：可见性判据不成立 → 【A1/A2/A3 修】不动手
        │           旧逻辑：直接判僵死 → destroy + createWindow
        │                                  ├─ 任务栏按钮消失又出现  = "闪烁"
        │                                  ├─ 新窗口 show()+focus()  = "自己弹出来"
        │                                  └─ 用户观感              = "它自己崩了"
        │
        └─ 重载 / 重试成功 → did-finish-load → show()
                 ├─ 最小化的窗口被恢复 + 抢焦点  【B1 修】
                 └─ 每次都抢一次焦点             【B2 修】

主进程被同步 IO 占满
        ├─ /api/chats 每 15s 读上千会话文件  【C1 修】
        └─ 实例锁 spawn powershell 最长 5s    【C2 修】→ 双击后迟迟不出窗
```

---

## 四、BUG-07 原生硬崩溃：本轮结论

### 时间线（本轮实测）

| 事件 | 时间 | 用的哪个 exe |
|---|---|---|
| dump `8213e33b` | 10-11 **10:41** | `G:\QQagent\QQ Agent.exe`（**旧构建**） |
| dump `2aca3511` | 10-11 **12:30** | `洛版…\setup.exe`（**旧构建**） |
| dump `a25308c6` | 10-11 **12:39** | 同上（**旧构建**） |
| **G 盘 exe 重新构建** | 10-11 **12:52** | md5 `7c6194ea262b` |
| **桌面安装包重新构建** | 10-11 **13:58** | md5 `c953480042c2` |
| 当前洛版文件夹内 `QQ Agent.exe` | — | md5 `7c6194ea262b` = **12:52 那个构建** |
| 之后的 dump | **无** | — |

### 结论

1. **3 次崩溃全部发生在 12:52 之前构建的 exe 上**（10:41 那次是 G 盘旧 exe；12:30/12:39 是旧 setup.exe）。
2. **当前洛版用的正是 12:52 重新构建的那个 exe，此后 1 天多零新增 dump。**
3. 三次崩溃**同构**：异常码 `0xC0000005`（READ 访问冲突），`ExceptionAddress = Rip = exe+0x37BF0CA`，
   崩溃指令 `movzx eax, byte ptr [rcx+0xb]`，且**前一条是 `test rcx,rcx / je`（有空指针检查）**
   → 指针非空但已失效，属悬空/越界/堆损坏形态。
4. 本轮已确认崩溃偏移落在 `.text`（VA `0x1000` ~ `0x948A95A`，ImageBase `0x140000000`），
   即 `VA = 0x1437BF0CA`。
5. **无法进一步定位的原因**：本机没有 `cdb`/`WinDbg`，且该构建的 PDB（`electron.exe.pdb`）
   不随包分发 → 拿不到函数名。
6. **本轮能做的已做**：把构建/环境标识写进 crashpad 注解（E1），下次真崩了可一眼排除
   "用户装的是旧版"这条分支。

### 如果要彻底闭环，需要（按性价比）

| 优先级 | 动作 |
|---|---|
| P0 | 装 Debugging Tools for Windows（`cdb`），对 3 个 dump 跑 `.ecxr` + `!analyze -v` + `ln <base>+0x37BF0CA`；PDB 需向构建者索取（这是唯一能拿到函数名的路径） |
| P1 | 对复现用户开 PageHeap（`gflags /p /enable "QQ Agent.exe" /full`）抓第一现场 |
| P2 | 排查第三方注入模块 —— dump 的模块表里有 `SogouPY.ime`(28.8MB)、`SogouTSF.ime`、`PicFace64.dll`、`ichat_bundle64.dll`，以及**固定基址 `0x10000000`（无 ASLR）的 `Resource.dll`**。固定基址注入是"指针非空但失效"的经典来源 |
| P3 | 用标准 electron-builder 结构打对照版，交崩溃用户对比一周 |

> 注：dump 仍在 `%APPDATA%\qq-agent\Crashpad\reports\`（3 个 × 34.7MB），未删除。

---

## 五、本轮**没有**动的（明确挂账，不是漏修）

| 项 | 为什么不动 |
|---|---|
| BUG-08 生产 `hotReload: true` | 产品决策：关了就没有实时改插件的能力 |
| UI-18 人设 6 处残留 | 需要你拍板保留哪套文案 |
| UI-06/23/27 皮肤层（两套皮肤叠加 / `:root` 三处重复定义 / 拟物残留） | 属皮肤重构，需要独立轮次 + 视觉验证。**注意**：本轮 C4 只暂停了后台动画，**没有**动皮肤层本身 |
| R78-8 `saveChat` 全量 `JSON.stringify` + 同步写盘 | 改 append-only JSONL 是大重构 |
| R78-9 `atomic-write.js` 死代码 | 零引用，删文件收益仅美观 |

---

## 六、启动后怎么验（3 条，最快）

1. **窗口不再自己跳出来**：把窗口最小化，挂着不动 2 分钟 —— 不应自己恢复。
   再把窗口缩到托盘，同样挂 2 分钟 —— 不应弹回前台。
2. **睡一觉回来不闪**：让电脑睡眠 → 唤醒 —— 窗口应原样在，不应重建/闪一下。
3. **后台不烧 CPU**：任务管理器看 `QQ Agent.exe`，切到别的全屏窗口挂 1 分钟，
   CPU 占用应明显低于改前（装饰动画已暂停）。

日志里可以对照这几行：
- `[看门狗] 静默 8s：系统从睡眠恢复`（A3 生效）
- `[看门狗] 心跳停摆为瞬时抖动（复核已恢复），不重建窗口`（A1 生效）
- `[看门狗] 页面无应答为瞬时抖动（复核已恢复），不重建窗口`（A1 生效）

---

## 七、回退方式

| 想回退 | 怎么做 |
|---|---|
| 全部回退 | 用 `_backup-r93-20261012-213150\` 覆盖 `resources/app/` 下对应 5 个文件；或对现盘执行 `patch -p1 -R < r93-fixes.patch` |
| 只回退后台动画暂停 | 删 `ui/style.css` 末尾「r93：后台不再白烧 CPU/GPU」整段 + `ui/app/00-core.js` 里那段 `visibilitychange` 监听 |
| 只回退 z-index | `.modal-overlay` 改回 `100`、`.model-modal-overlay` 改回 `200` |

**本轮改动需重启 app 生效**（改的是主进程与 UI 层）。
