# QQAgent R124 · 发网图"预览被当成已发送"修复报告

> 版本：0.4.9.1（运行目录 `G:\QQagent\resources\app`）
> 日期：2026-10-27
> 现象：让机器人发网图，过程面板显示"已发送到 QQ · [消息 · send_image]"，但 QQ 群里一张图都没有

---

## 一、现场还原（07:46 那次会话）

日志 `data/logs/qq-agent-2026-10-27.log` 只有 **两次** LLM 调用：

| 时间 | 调用 | 说明 |
|---|---|---|
| 07:46:56 | 第 1 次（msgs=2） | 模型拿到群消息，调 `search_images` 搜图 |
| 07:46:58 | 第 2 次（msgs=4） | 模型看到搜图结果，调 `send_image(url, preview=true)` |
| — | **没有第 3 次** | 会话在这里就结束了 |

面板上的顺序：

1. `工具 发网图 url=… preview=true → 这张图（image/jpeg，约 490KB）…`
2. `工具 发网图 · 1 张图片已作为图像输入注入模型`
3. `已发送到 QQ · 07:46:59 [消息 · send_image]`
4. `finish：已发言，自动收尾（省一轮）`

模型本来打算"看完图再发"，但**没等到下一轮就被收尾了**。

## 二、根因：两处各自合理的条件叠在一起

### ① 编排器把"预览"补记成了"已发言"

`src/orchestrator.js` 有一段补记逻辑（2026-10-21 为插件工具加的）：

```js
if (!result.isError
  && session.sent.length === sentBeforeCall
  && isDeliverTool(name, autoEndExtra)
  && !reportsNothingSent(result.content)) {
  session.sent.push({ type: 'tool', text: `[消息 · send_image]` });
}
```

`send_image(url, preview=true)` 恰好三条全中：

- 是发送类工具（`media` + `send` 前缀 → `isDeliverTool` 返回 true）
- 预览成功，没报错
- 预览分支**本来就不该**往 `session.sent` 记账

于是被补记成一条 `[消息 · send_image]` —— 界面上那句"已发送到 QQ"就是它。

### ② "发言即收尾"据此判定已交付

```js
const delivered = session.sent.length > sentBeforeBatch;   // ← 被①喂成 true
if (callsAllSend && noError && delivered) {
  finish = true;
  session.finishReason = '已发言，自动收尾（省一轮）';
}
```

`send_image` 是本批唯一工具（`callsAllSend=true`），补记又让 `delivered=true`，
**会话当场收尾**，模型再没机会调第二次 `send_image(url)`。

一句话：**预览 → 被当成发言 → 提前收尾 → 真发那一步永远不执行。**

## 三、修复（两处，共 4 行有效改动）

### 1. `src/tools.js` — 预览分支显式声明"没发出去"

两条返回路径（视觉支持 / 视觉不支持）都加上 `delivered: false`：

```js
return { ...ok(`…注意：这次只是预览，图还没有发出去 —— 觉得合适就再调一次 send_image(url)（不要带 preview）才真的发…`), delivered: false };
return { content: imageParts(`…这次只是预览，图还没有发出去 —— 觉得合适就立刻再调一次 send_image(url)（不要带 preview）发出去：`, [...]), delivered: false };
```

文案同时补了"还没有发出去 / 不要带 preview"，避免模型把预览当已发。

### 2. `src/orchestrator.js` — 补记条件排除预览

```js
if (!result.isError
  && result.delivered !== false      // ← 新增
  && session.sent.length === sentBeforeCall
  ...
```

`executeTool` 直接返回工具对象的原样结果，自定义字段不会被丢弃，所以这个约定是通的。

### 修复后的链路

| 场景 | 结果 |
|---|---|
| `send_image(preview=true)` | 不补记 → `delivered=false` → 不收尾 → 模型进入下一轮 |
| `send_image(url)` 真发 | 工具自己 push `session.sent` → 补记跳过 → `delivered=true` → 正常收尾 |
| 预览失败（404 / 非图片） | `isError=true` → 不补记 → 不收尾 |
| 同批 preview + send_message | 文字发出即收尾（模型行为，非本次问题） |

## 四、验证

新增 `tests/send-image-preview.test.mjs`（4 条静态契约，防回归）：

- 预览分支两条返回都必须带 `delivered:false`，且不能再出现裸 `return ok(...)`
- 预览文案必须包含"还没有发出去""不要带 preview"
- 编排器补记条件必须含 `result.delivered !== false`，且紧邻 `session.sent.push`
- 自动收尾仍以 `session.sent` 真实增长为准（防止把 bug 修成"只看工具名"）

全量测试：**147 通过 / 0 失败**（`node --test tests/*.test.mjs`）。

## 五、生效与后续

- **必须重启 QQ Agent** 才生效（`src/` 不热重载，UI 才热重载）。
- 备份：`src/tools.js.bak-20261027-sendimg`、`src/orchestrator.js.bak-20261027-sendimg`。
- ⚠️ 这次改的是**运行目录**（`G:\QQagent\resources\app`），不是打包源。
  覆盖安装 / 用打包器重出安装包会把这两处改动冲掉 —— 下次发版前记得同步。
- 若重启后模型"预览完仍不真发"（轻量模型可能直接收尾），下一步可加一条"预览后未真发"的
  nudge：本批只有 preview 时，在 tool 结果后补一句"图还没发，继续"。
