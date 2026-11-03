# QQAgent R114 修复：会话选择界面「新对话出现就刷新、页面闪烁」

- 日期：2026-10-14
- 症状：有新对话（会话）出现时，「会话选择」界面（全屏页 mode-chat 选择器）整体刷新，导致页面闪烁。
- 根因：选择器左右两栏都是**整块 innerHTML 重建**，而它们被包在 `renderSessionList` / `renderSessionDetail` 外面——会话页每次刷新（SSE session-start/update/end、轮询）都会把整个选择器推倒重画。

## 1. 两个刷新源（都已修）

### 左栏（聊天对象列表）—— `fillLeft()`

- 旧实现：`W_LIST.innerHTML = <整串 HTML>`（导航 + 全部聊天行 + 章节头 + 空态）。
- 触发频率：被包在 `renderSessionList` 外面（15-chat-chrome.js 文件末 wrap），**每次SSE事件/轮询数据变化都会跑**。
- 后果：容器滚动位置清零（整列跳一下）、悬停/选中态闪、头像 img 重新加载。
- 新实现：**骨架一次建成**（buildStatic 里：页面头 + 3 个 nav + 群聊/私聊头 + 两个行容器 + 空态提示，全为 W_LIST 直接子节点——`#cc-left > .bp-sec:first-child` 的间距覆写不受影响），`fillLeft()` 改为增量 reconcile：
  - nav 只切 `.on` class；
  - 聊天行按 `data-chat` 复用节点，`data-sig` 内容指纹（key/name/last/active/total）没变**完全不动 DOM**，变了只重建那一行，新增行只插一个节点，消失的行移除；
  - 章节头/空态常驻只切 `hidden`；
  - 滚动位置、悬停态天然保住。

### 右栏（会话卡）—— `renderSessionDetail` 包裹层

- 旧链路：02 的 `renderSessionDetail` 每次内容变化都 `#session-detail.innerHTML = 整串`（而 #session-detail 就是选择器的 DETAIL，装着 `#cc-cards` 骨架）→ 包裹层检测到骨架没了 → `applyRight(true)` **全量重建整个右栏 + 再调一次 fillLeft**。新会话 auto-follow 选中/消息流式更新都会走这条 → 满屏闪。
- 新链路（会话页 + 骨架健在时）：
  1. 调用前把 DETAIL 里的本层节点（全带 `data-cc`）摘进离屏 `HOLD`，02 的整块覆盖就只清掉它自己上一轮的节点；
  2. 调用后把 02 的新节点收进**当前会话**的卡体（卡不存在则创建并折叠其它卡），骨架按原顺序挂回；
  3. 滚动恢复：快照 DETAIL 与卡体的 scrollTop/是否贴底，运行中且贴底则跟随，否则原样保留（02 在空 DETAIL 上算出的 scrollTop 不可信）；
  4. `fresh` 为空（02 指纹未变提前返回 / 渲染抛错）→ 内容保持原样，不清空；
  5. 骨架没了 / 没有当前会话 / 任何异常 → 回退旧的全量 `applyRight(true)`。

## 2. 验证

- [x] 两份安装 `node --check` 全过；两份文件逐字节一致
- [x] 无 `W_LIST.innerHTML` 残留代码；CSS 无结构依赖（已核实 `.bp-sec/.bp-nav/.bp-row/.bp-empty` 全为类选择器，唯一直接子选择器 `#cc-left > .bp-sec:first-child` 仍成立）
- [ ] **重启后真机验证**：
  - 群里来新消息 → 选择器左栏只在原位置前插/更新对应行，滚动位置不动、不闪；
  - 运行中会话输出持续刷新 → 右栏只换当前卡内容，其余卡片不动；
  - 搜索框过滤、切换存档/记忆页、关闭再进选择器，行为不变；
  - 02 的 JSON 模式 / 删除会话 / 折叠面板，在卡体迁移后仍工作。

## 3. 备份与回滚

- 备份 tag：`R114-20261014-161040`（`ui/app/15-chat-chrome.js.bak-R114-20261014-161040`，两份安装各一，与改动前逐字节一致）
- 补丁：`r114-fixes.patch`（6 hunk）
- 回滚 = 用 .bak 覆盖回去。

## 4. 生效方式

`ui/app/15-chat-chrome.js` 在渲染进程加载时生效——**重启应用**（与 R112/R113 一并生效）。

## 5. 影响面

| 改动 | 风险 | 说明 |
|---|---|---|
| 左栏增量 reconcile | 低 | 只改渲染方式；DOM 结构与类名不变；搜索/选中/点击委托全部复用 |
| 右栏包裹层 | 中低 | 稳态路径完全跳过全量重建；骨架缺失/异常/非会话页均走旧路径；滚动用快照恢复；02 提前返回已探测（fresh 为空不清空） |
