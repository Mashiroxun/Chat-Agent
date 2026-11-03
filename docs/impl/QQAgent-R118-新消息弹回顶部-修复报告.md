# QQAgent R118 修复报告：新消息到达时右栏被弹回顶部

- 日期：2026-10-14
- 备份 tag：`R118-20261014-172218`（两份安装同 tag）
- 改动文件：`ui/app/15-chat-chrome.js`（两份安装，改后 md5 一致）
- 补丁：`r118-fixes.patch`
- 状态：代码完成、语法校验通过，**待重启后真机验证**

## 症状

用户展开靠下方的会话卡阅读时，一旦有新消息（新会话）到达，右栏直接弹到最上面，阅读位置丢失。

## 根因链

1. 新会话到达 → SSE `session-start` → `loadSessions()` + 自动跟随 `selectSession(新id)`（02，`state.autoFollowRunning`）。
2. `selectSession` → `renderSessionDetail(新id)` → 本层包裹层发现 `#cc-cards` 里**没有这个新会话的卡**（`refreshCards` 只更新已有卡，不建新卡）→ 走回退分支 `applyRight(true)` 全量重建。
3. `applyRightInner` 里 `DETAIL.innerHTML = ''`（`#session-detail` = `.detail-pane`，`overflow-y:auto`，**右栏滚动容器**）→ scrollTop 清零 → 重建后新卡按时间倒序插在最顶 → **视野被弹回顶部**。
4. 左栏同病：`reconcileRows` 把"最近有会话"的聊天行 `insertBefore` 到最顶，滚动容器 `#session-list`（`.list-pane`）内容整体下移。

## 修复（滚动锚定 + 高度补偿）

新增模块级账本 `ccLastChat`（fillLeft 每次渲染后更新）区分「同聊天刷新」与「切聊天」：

1. **右栏**（`applyRightInner`）：函数开头记录 `sdTop0/sdH0`；重建完成且 `autoFoldTick` 之后（折叠态变化也改高度），若 `ccLastChat === st.chat`（同聊天）且原来不在顶部（scrollTop>4），按 `scrollHeight` 增量把 scrollTop 补偿回去——**同样的内容还在眼前**。本来就在顶部则不恢复：新卡出现在顶部即所见（聊天式跟随）。
2. **左栏**（`fillLeft`）：同一套补偿，滚动容器换成 `LIST`（#session-list）。切了聊天（`ccLastChat !== st.chat`）不恢复——那份位置属于另一个聊天的列表。
3. 自动跟随的选择切换不变（新会话照常展开在顶部），只是**不再抢用户的视野**。

## 语义核对

| 场景 | 行为 |
|---|---|
| 同聊天新会话到达（自动跟随） | 右栏/左栏阅读位置不动；新卡在顶部展开 ✅ |
| 用户本来就在顶部 | 保持顶部，新卡即所见 ✅ |
| 切换聊天对象（pickChat） | 不恢复旧滚动，新列表从顶开始 ✅ |
| 会话结束自动收起卡（autoFoldTick） | 高度变化计入 delta，位置仍稳 ✅ |
| 搜索过滤（fillLeft） | 列表变短时 scrollTop 被浏览器 clamp，无异常 ✅ |

## 验证与回滚

- `node --check` 两份通过；`md5sum` 两份一致。
- 回滚：`cp 15-chat-chrome.js.bak-R118-20261014-172218 15-chat-chrome.js`（两份安装同 tag），或 `patch -R` 应用 `r118-fixes.patch`。
- **待重启验证**：展开靠下的卡片 → 群里有新消息时视野应保持原地（左右栏都不跳）；停在顶部时新卡正常出现在最上面；切聊天后列表从顶部开始。
