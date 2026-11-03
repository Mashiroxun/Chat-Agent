# QQAgent R116 修复报告：会话卡片点击无法展开

- 日期：2026-10-14
- 备份 tag：`R116-20261014-164531`
- 改动文件：`ui/app/15-chat-chrome.js`（两份安装：`G:\QQagent\resources\app` 运行版 + 桌面 `洛版QQ-Agent-v0.4.8\resources\app` 开发树，改后 md5 一致）
- 补丁：`r116-fixes.patch`
- 状态：代码已完成、语法校验通过，**待重启应用后真机验证**

## 症状

用户截图：会话选择界面中，一条运行中的卡片（`16:41:13 · 0 轮 · 用时 2.7s`，带「中止」pill）处于折叠态，点击卡头无反应，展不开。

## 根因

R114 包裹层（`window.renderSessionDetail` 外挂）把「建卡体 + 去折叠」整段放在 `if (!body)` 里，而 `if (!body)` 又嵌在 `if (fresh.length)` 里：

```js
if (fresh.length) {
  var body = selCard.querySelector('.bs-cb');
  if (!body) {                       // ← 卡体已存在时为假
    ... 建 body、折叠其他卡 ...
    selCard.classList.remove('collapsed');   // ← 永远不会执行
  }
  ... 填内容 ...
}
```

点击路径还原（运行中卡片必然复现）：

1. 会话开始运行 → `autoFoldTick()` 检测到 idle→active 迁移，该卡无卡体 → `selectSession(s.id)` → 卡体建立、卡片展开。`runSeen` 记账。
2. 用户手动折叠该卡（点已展开卡头 → `classList.add('collapsed')`，**不经过 selectSession**）。此时卡体仍在。
3. 用户再点折叠的卡头 → `selectSession(sid)` → 02 的 `selectSession` 会先把 `lastDetailFp` 重置为 null，`renderSessionDetail` 正常重渲染 → 包裹层 `fresh` 非空 → 但 `!body` 为假 → **`remove('collapsed')` 被跳过** → 卡片保持折叠，内容却刷新进了看不见的卡体里 → 「点了没反应」。

次要同源场景：SSE/轮询抢先渲染过同一会话、内容指纹未变（02 的 `lastDetailFp === fp` 去重）→ `fresh` 为空 → 整段跳过。

**本质：折叠/展开是选择语义，却被绑在了「卡体是否新建」「02 是否重渲染」这些渲染细节上。**

## 修复（三处）

1. 模块级新增 `var ccPendingExpand = null;`——记录「用户主动选中的 sid」。
2. 包裹层 ③ 块重构为 `madeBody / wantExpand`：
   ```js
   var body = selCard.querySelector('.bs-cb');
   var madeBody = !body;
   if (madeBody) { ...建 body、折叠其他卡（语义不变）... }
   var wantExpand = ccPendingExpand === sel;
   if (wantExpand) ccPendingExpand = null;      // 一次性消费
   if (wantExpand || madeBody) selCard.classList.remove('collapsed');
   if (fresh.length) { ...填内容... }
   ```
   **展开与「卡体是否存在」「02 是否重渲染」完全解耦**；`fresh` 仍只负责内容填充。
3. `window.selectSession` 包裹层内、调用原函数**之前**：
   ```js
   ccPendingExpand = arguments[0];
   ```
   （02 的 `selectSession` 先写 `state.currentSessionId` 再渲染，包裹层里 `ccPendingExpand === sel` 必然对上。）

## 语义核对（无行为倒退）

| 路径 | 折叠态行为 |
|---|---|
| 轮询/SSE 刷新（不经 selectSession） | `ccPendingExpand` 为 null → 用户手动折叠的卡保持折叠 ✅ |
| `autoFoldTick` | 只在 idle→active **迁移**且无卡体时 `selectSession`（建卡必展开，同旧语义）；无迁移不动 ✅ |
| 02 自动跟随 | 有 `!state.currentSessionId` / active.id 变化守卫，不反复抢开 ✅ |
| `refreshCards`（R115） | 只更新卡头签名内容，不动折叠态 ✅ |
| 用户点折叠卡（本次修复目标） | 必展开 ✅ |
| 用户点已展开卡 | 仍只折叠，不触发 selectSession ✅ |

## 验证

- `node --check`：两份安装均通过。
- `diff` / `md5sum`：两份安装逐字节一致。
- **待用户重启后验证**：① 运行中/已结束卡片点击均可展开；② 手动折叠的非选中卡不被轮询抢开；③ 折叠→点击→展开→再折叠循环稳定。

## 回滚

任一份安装执行：`cp 15-chat-chrome.js.bak-R116-20261014-164531 15-chat-chrome.js`（或 `patch -R` 应用 `r116-fixes.patch`）。
