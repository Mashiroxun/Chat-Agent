# QQAgent 长期运行后「用量界面卡加载」诊断与修复（R112）

- 日期：2026-10-14
- 目标版本：`G:\QQagent\`（v0.4.8 部署目录，今天 09:58 启动，正常运行约 4.5 小时后触发）
- 同步修改：`C:\Users\Administrator\Desktop\洛版QQ-Agent-v0.4.8\`（开发树，改完随下次打包生效）
- 修复代号：R112

## 1. 症状

用户反馈：QQAgent **长期运行后**，点开「用量」界面一直卡加载，最终卡死（见当时截图）。
同一台机器、同一份安装（`G:\QQagent`）上可复现。

## 2. 证据（来自 `G:\QQagent\data\logs\qq-agent-2026-10-14.log`）

关键现象——**前端持续报错，后端毫发无伤**：

```
14:16:01 [ERROR] [renderer] [渲染进程报错] TypeError: Failed to fetch (…/02-sse-sessions.js:224)
14:16:04 同上 … 14:16:44、14:17:58、14:18:22 … 一直持续到 14:51+
（此后每隔几秒就报一次，涵盖会话列表轮询路径 02-sse-sessions.js:224 = loadSessions）
```

对照实测（问题当场仍在发生时）：

| 对象 | 方法 | 结果 |
|---|---|---|
| 渲染进程 | `fetch('/api/sessions?limit=1048576')` | **Failed to fetch**（连续） |
| 宿主机进程 | `curl http://127.0.0.1:3210/api/usage/stats` | HTTP 200，2ms，正常 |
| 宿主机进程 | `curl …/api/usage/stats?force=1` | HTTP 200，334ms，正常 |
| 宿主机进程 | `curl …/api/sessions?limit=1048576` | HTTP 200，1.4MB / 62ms，正常 |

用例：**服务端完全健康，只是渲染进程访问不到服务端。** curl 是完全独立的新连接，不受影响——
两个事实合在一起，把根因指向 **渲染进程（Chromium）侧的 socket 池**，而不是服务端代码或后端数据。

时间线旁证：当天启动 4 次（00:12 / 09:39 / 09:44 / 09:58），故障发生在 09:58 那次启动后约 4.4 小时——
完全符合"长期运行"这个触发条件的描述；主进程在 14:16 前后**没有任何**看门狗重载/重建/崩溃记录。

## 3. 根因

Node 的 `http.createServer()` 不设置 `keepAliveTimeout` 时，默认 **5 秒**关闭空闲的 keep-alive socket；
而 Chromium/Electron 渲染进程维护的是"连接池"：空闲 socket 不主动关闭，**下次请求继续复用**。
于是形成一个"时差竞态"：

```
服务端 keepAliveTimeout(5s) 到 → Node 主动关闭 socket（发 FIN/RST）
渲染进程不知道 → 5秒内这个 socket 被下次请求复用（本地回环上很快）
→ Chromium 拿着一条已被对端关闭的连接写请求 → ERR_CONNECTION_RESET
→ fetch() 抛 TypeError: "Failed to fetch"
```

为什么表现为"**卡**加载"而不是"报错"：

- 用量页的统计请求走的是 `Promise.all([api('/api/usage/stats'), api('/api/status')])`；
  复用半死 socket 的请求有时直接 reset（报 Failed to fetch），有时挂起（等待一个永远等不到的响应，
  实际已被 15s 的 AbortSignal 超时兜住）；
- 单次瞬时失败不会自愈：**Chromium 不会主动把这条坏 socket 从池里踢掉**，后续请求继续踩同一块坑，
  重试也踩，于是每 15 秒一次的轮询在日志里刷出连续的 `Failed to fetch`——
  直到用户重启，渲染进程重建 socket 池才恢复。这就是"只能重启"体感的来源。

次要放大器：`connectSSE()` 没有单例保护，若长运行中被再次调用（重建窗口、重复 init），
会叠加出多条永久 SSE 连接，逐步吃满 Chromium 对 127.0.0.1 的 6 条 socket 上限，
让上述故障提前、加重。

## 4. 修复（3 处，6 个文件；两份安装各一套）

### 4.1 根因修复 —— 服务端抬保活时间（`src/app.js`）

```diff
       server.once('error', reject);
+      // R112：Node 默认 keepAliveTimeout(5s) 比 Chromium 空闲 socket 复用窗口短 ——
+      // 服务端先关了 socket，渲染进程还拿它复用，触发 ERR_CONNECTION_RESET（前端
+      // "Failed to fetch"，curl 不受影响）。抬到 61s/65s，服务端不再比客户端先关。
+      server.keepAliveTimeout = 61000;
+      server.headersTimeout = 65000;
       server.listen(port, '127.0.0.1', () => {
```

### 4.2 加固 —— SSE 单例 + 自愈入口（`ui/app/02-sse-sessions.js`）

- `connectSSE()` 已有健康连接时不再重复创建（`sseConn` 模块级单例）；
- 新增 `reconnectSSE()`：关闭旧连接再建一条，把坏 socket 交还浏览器丢弃。

### 4.3 兜底 —— 渲染端网络自愈看门狗（`ui/app/00-core.js`）

- `api()` 的 catch 里识别网络层失败（`TypeError: Failed to fetch` 等）；
- 连续 4 次失败（20 秒窗口计数归零）且 5 分钟内没自愈过 → 触发一次自愈：
  先 `reconnectSSE()`（轻量，多数到这里就好了），800ms 后探针复查，**仍失败才 `location.reload()`**
  （让 Chromium 整体丢一次坏 socket 池）。探针已恢复则不打扰用户。

> 注意：超时/中止（TimeoutError/AbortError）不计入自愈，避免功能变慢被误判为网络故障。

## 5. 备份与可回滚

两份安装均在修改前整体备份，备份 tag：`R112-20261014-151715`，如
`…/resources/app/src/app.js.bak-R112-20261014-151715`（共 6 个 .bak 文件，与改动前逐字节一致）。
回滚 = 把对应 `.bak-R112-20261014-151715` 覆盖回去。

## 6. 验证状态

- [x] 6 个改动文件 `node --check` 语法校验全部通过
- [x] diff 复核：改动仅为上述 3 处，无附带修改
- [ ] **重启应用后真机验证**（下述）
  - 连续运行 4 小时以上，中途反复开合用量页 / 会话页 / 存档页；
  - 当日日志不应再出现连续的 `Failed to fetch (… 02-sse-sessions.js:224)`；
  - 用量页在打开后 15 秒内出数；即使遇故障应停在"加载失败 + 重新加载"而不是永远转圈；
  - 若复现连续失败：数分钟内日志仍干净，且界面在 800ms ~ 数秒内自动恢复（自愈生效）。

## 7. 生效方式与注意

1. **需要重启才生效**：`src/app.js`（服务端）改动在下次启动生效；`ui/app/*.js` 改动在渲染进程下次加载生效。
   当前正在跑的进程仍是旧代码。
2. 本次只改了 `G:\QQagent`（用户实际运行的那份）和桌面 `洛版QQ-Agent-v0.4.8`（开发树/下一版打包用）。
   `骂人特化版QQ-Agent`（独立 user-data-dir、多进程）**未动**。
3. 遗留观察项：若抬保活后仍偶发 `Failed to fetch`，可评估把 `useSession` 的 EventSource 断开重连策略
   从"自动重连"改为"退避重连"，避免主进程重启/关机后渲染端空转刷屏。

## 8. 影响面评估

| 改动 | 风险 | 说明 |
|---|---|---|
| `keepAliveTimeout/headersTimeout` | 极低 | 仅延长服务端保活窗口，多保留几条本机空闲连接，无可感副作用 |
| SSE 单例 | 低 | 行为等价（防空连接叠加）；`reconnectSSE` 只被自愈看门狗显式调用 |
| 网络自愈看门狗 | 低 | 仅在"连续网络失败"时生效，且已排除超时/中止误伤；单个浏览器标签页的 `location.reload` 是最坏事态，远好于永久卡死 |
