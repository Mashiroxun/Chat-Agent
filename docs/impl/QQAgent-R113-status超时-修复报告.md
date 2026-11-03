# QQAgent R113 追加修复：用量页「请求超时」根因与修复

> 背景：2026-10-14 15:41 用户复现「用量页加载失败：请求超时（15 秒无响应）」。
> 注意此时应用已于 15:31 重启过 —— **R112 的 keep-alive 修复已生效**，
> 但页面仍然超时，说明这是**另一条根因**（与 socket 重置的 "Failed to fetch" 是两回事）。

## 1. 定位过程：逐接口计时

问题当场对运行中的服务实测三次：

| 接口 | 耗时 | 说明 |
|---|---|---|
| `/api/usage/stats?range=7` | **2ms** | 缓存命中，正常 |
| `/api/usage/stats?range=7&force=1` | **0.25–0.29s** | 当场重算，正常 |
| `/api/status` | **1.44–1.79s** | ❌ 慢点在这 |

统计接口是健康的 —— 问题在 `/api/status`。而用量页 `loadUsageView` 的写法是：

```js
const [stats, st] = await Promise.all([
  api(usageStatsUrl(range, hard), { timeoutMs: 15000 }),
  api('/api/status', { timeoutMs: 15000 })     // ← 这一个拖后腿
]);
```

`Promise.all` 里任何一个 15s 超时，整页就显示"用量加载失败"——**统计接口本身没问题，是被 status 拖死的**。

## 2. 根因：/api/status 每轮都 spawn 一次 PowerShell

`/api/status` handler → `qqPortableStatus()` → `qqPortableRunningPid()` → `listQqProcesses()`：

```js
const { stdout } = await execFileAsync('powershell', [
  '-NoProfile', '-NonInteractive', '-Command',
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
    + 'Get-CimInstance Win32_Process -Filter "name=\'QQ.exe\'" | ...'
], { timeout: 20000, ... });
```

**每次调用都起一个 powershell 进程做 CIM 查询，没有任何缓存**。本机单次实测 ~1.5s
（PS 5.1 启动 + CIM 冷查询）。而 `/api/status` 的调用频率极高：

1. 渲染端状态轮询：每 `ui.refreshMs`（默认 15s）一次；
2. **每个 SSE 事件**（session-start / session-end / chat-update）都会 `refreshStatus()` ——
   群消息频繁时这条路径被密集触发；
3. 用量页 Promise.all 里自己也要一次。

平时 status 就 1.5s；一旦机器同时忙别的（图片缓存写盘、模型 API 调用、全量重扫），
这 1.5s 会成倍放大 → 顶穿 15s 前端超时 → 用户看到"用量页一直加载失败"。

## 3. 修复（R113，src/app.js，两份安装各一套）

给 `listQqProcesses()` 加 **3 秒 TTL 缓存 + 在途共享**（复用项目里 `localQqCache` 30s TTL 的同款模式）：

```js
let qqProcListCache = { at: 0, rows: null };
let qqProcListInFlight = null;
const QQ_PROC_LIST_TTL = 3000;

async function listQqProcesses({ force = false } = {}) {
  if (process.platform !== 'win32') return [];
  const now = Date.now();
  if (!force) {
    if (qqProcListCache.rows && now - qqProcListCache.at < QQ_PROC_LIST_TTL) return qqProcListCache.rows;
    if (qqProcListInFlight) return qqProcListInFlight;   // 已在查 → 共用，不叠 spawn
  }
  const p = __listQqProcessesOnce().then((rows) => { qqProcListCache = { at: Date.now(), rows }; return rows; });
  qqProcListInFlight = p;
  try { return await p; } finally { qqProcListInFlight = null; }
}
```

原函数体改名 `__listQqProcessesOnce()` 不动。

**调用点评估**（一共 3 处）：

| 行 | 场景 | 3s 陈旧可否接受 |
|---|---|---|
| ~492 | `qqPortableRunningPid`（/api/status 热路径） | ✅ 就是要缓存的目标 |
| ~539 | 启动便携 QQ 前的"其它 QQ 在跑"提示 | ✅ 提示文案，无所谓 3s |
| ~788 | `qqRunningFromDir`（安装流程探测） | ✅ 非 tight loop，3s 内会再探到 |

`force=true` 参数保留（预留给"刚装完 QQ 要立刻看到结果"的显式场景）。

## 4. 效果与验证

- `/api/status` 预期从 ~1500ms 降到 **~5ms**（缓存命中），用量页 Promise.all 不再是瓶颈；
- 即使缓存未命中触发一次 spawn（每 3s 最多一次），1.5s 也远低于 15s 超时线；
- 语法校验：两份 `node --input-type=module --check` 均通过；
- **待真机验证**：重启后打开用量页应立即出数；用量页挂着 5 分钟不应再出现"请求超时"；
  日志里也不应再出现"用量加载失败"。
- 备份：tag `R113-20261014-155447`（两份 `src/app.js.bak-R113-20261014-155447`）。

## 5. 与 R112 的关系（分清两条线）

| 现象 | 根因 | 修复 |
|---|---|---|
| 渲染进程持续 `Failed to fetch`（curl 正常） | Node keep-alive 5s 超时 → Chromium 复用死 socket | R112：`keepAliveTimeout=61s / headersTimeout=65s` |
| 用量页「请求超时（15 秒无响应）」 | `/api/status` 每轮 spawn PowerShell 查进程（~1.5s） | R113：进程列表 3s TTL + 在途共享 |
