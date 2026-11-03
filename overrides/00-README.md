# overrides/ —— 启动组合（0.4.9.2 新增）

这个目录让**不改出厂源码**就能替换底层实现。

放一个子目录 + 一份 `composition.json`，重启后生效；删掉目录重启即完全恢复。
不装任何层时，行为和 0.4.9.1 一模一样（235 个单元测试逐条对过）。

---

## 最小例子

```
overrides/
  20-my-setup/
    composition.json
    system-prompt.mjs
```

`composition.json`：

```json
{
  "version": 1,
  "id": "my-setup",
  "order": 20,
  "enabled": true,
  "components": {
    "core.prompt.system": { "module": "./system-prompt.mjs", "export": "systemPrompt" }
  }
}
```

`system-prompt.mjs`：

```js
import { buildSystemPrompt as original } from '../../src/prompt.js';

// 参数与返回值必须和原实现一致，否则整条链路会出问题。
export function systemPrompt(ctx) {
  return original(ctx) + '\n\n【额外规则】每周五晚上不主动说话。';
}
```

重启后日志里会出现：

```
[composition] 已加载层 my-setup（20-my-setup，order=20）：core.prompt.system
```

---

## 可替换的组件（23 个）

键名与 0.5 的组件表一致，两边的层可以互相搬。

### 运行环境（注入点，不是构造工厂）

| 键 | 签名 | 说明 |
|---|---|---|
| `runtime.config` | `() => 配置对象` | 配置来源。**必须同步返回**，形状同 `DEFAULT_CONFIG`。返回非对象时回落到读磁盘。 |
| `runtime.plugins` | `SkillManager 实例` | 插件管理器。替换后全项目 232 处 `skillManager.xxx()` 自动看到新实例（ESM live binding）。 |
| `console.routes` | `(deps) => 路由数组` | 追加/覆盖 HTTP 路由。返回 `[{ method, pattern, handler }]`，**排在内置 176 条前面**，同 pattern 会覆盖内置。 |

`console.routes` 的例子——给面板加一条自己的接口：

```js
// overrides/20-my-api/routes.mjs
export default function myRoutes() {
  return [{
    method: 'GET',
    pattern: '/api/my-thing',
    handler: async ({ res, json }) => json(res, 200, { ok: true, hello: 'world' }),
  }];
}
```

```json
{
  "version": 1,
  "id": "my-api",
  "order": 20,
  "enabled": true,
  "components": {
    "console.routes": { "module": "./routes.mjs", "export": "default" }
  }
}
```

### 数据仓

| 键 | 原实现 | 说明 |
|---|---|---|
| `data.messages` | `src/store.js` `ChatStore` | 消息存档 |
| `data.memory` | `src/memory.js` `MemoryStore` | 群友长期印象 |
| `data.sessions` | `src/sessions.js` `SessionRegistry` | 会话运行记录 |
| `data.reminders` | `src/reminders.js` `ReminderStore` | 提醒任务 |

### 传输与发送

| 键 | 原实现 | 说明 |
|---|---|---|
| `transport` | `src/onebot.js` `OneBotClient` | OneBot 连接 |
| `core.send` | `src/sender.js` `SendQueue` | 发送队列（限频/存档/防刷屏） |
| `core.media` | `src/video-reader.js` `VideoReader` | 视频读取 |

### 编排

| 键 | 原实现 | 说明 |
|---|---|---|
| `core.orchestrator` | `src/orchestrator.js` `Orchestrator` | 主业务链 |

### 策略（细粒度）

| 键 | 原实现 | 说明 |
|---|---|---|
| `core.prompt.system` | `prompt.js` `buildSystemPrompt` | 系统提示词 |
| `core.prompt.user` | `prompt.js` `buildUserPrompt` | 用户提示词 |
| `core.prompt.persona` | `config.js` `personaForChat` | 按会话取人设 |
| `core.wake.resolve` | `prompt.js` `resolveContextTier` | 响应档位判定 |
| `core.reply.rescue` | `reply-rescue.js` `rescueUnsentReply` | 发送失败补救 |
| `core.session.retryable` | `llm.js` `isRetryableError` | 重试判定 |
| `llm.complete` | `llm.js` `chatCompletionWithRetry` | 模型调用 |
| `core.tools.bundle` | `tools.js` `buildToolDefs` | 工具列表 |
| `core.tools.parseInline` | `orchestrator.js` `parseInlineToolCalls` | 内联工具调用解析 |
| `core.media.forward` | `media-links.js` `dispatchMediaLinks` | 媒体链接转发 |
| `core.text.plain` | `md-to-plain.js` `mdToPlain` | Markdown → 纯文本 |
| `core.text.split` | `md-to-plain.js` `splitForQQ` | 长文切分 |

---

## 清单字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `version` | 是 | 目前只接受 `1` |
| `id` | 是 | 字母数字下划线短横线，1–64 字符，全目录唯一 |
| `order` | 否 | 数字，默认 100；**小的先加载**，后加载的同键覆盖先加载的 |
| `enabled` | 否 | `false` = 跳过这一层（保留文件，方便临时关掉） |
| `components` | 是 | `{ "键名": "./文件.mjs" }` 或 `{ "键名": { "module": "./文件.mjs", "export": "名字" } }` |

组件值写成字符串 = 用该模块的**默认导出**。

---

## 约束与边界

- **路径**：必须在层目录内。绝对路径、`..`、符号链接、URL 编码一律拒绝。
- **模块**：只接受 `.js` / `.mjs` / `.cjs`。
- **导出**：必须是函数，否则该条跳过并报错。
- **层数**：最多 64 层，单份清单最多 64 KiB。
- **生效时机**：启动时绑定。改完要**完整退出并重启**，热重载不会重新装配。
- **失败处理**：清单非法 → 该层跳过并在日志里写明原因；桌面版继续按出厂实现启动，headless 版直接退出（避免"看起来起来了其实少一层"）。

---

## 安全提醒

**启动组合里写的是原生代码，信任等级等同于直接改源码。**

它不走插件的权限模型，也不受市场安装器管控。只放自己写的、或完全看懂了来源的层。
普通插件仍然走 `plugins/` 和 `skills/`，那里才有权限闸和指纹校验。

---

## 预检（不启动程序）

```bash
node scripts/check-composition.mjs
```

列出所有层、生效顺序、每个组件的来源链，以及冲突和错误。
**它只读清单、不执行层代码**，所以不能代替真实启动验证。

---

## 想加一个界面页？

**不要走覆盖层。** 这一版只开放了后端装配，UI 层没有做可替换。

加页照原来的写法：

1. `ui/index.html` 里加一个 `<button class="nav-item" data-tab="my-page">`
2. 同文件加一个 `<section data-tab="my-page" hidden>`
3. 新建 `ui/app/21-my-page.js`，在 `11-init.js` 里加 `<script>`

样式、主题、切换逻辑都会自动继承，随时可以删干净。
