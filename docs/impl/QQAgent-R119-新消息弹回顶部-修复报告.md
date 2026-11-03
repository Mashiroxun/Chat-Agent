# QQAgent R119 修复报告：新消息到达仍弹回顶部（R118 未命中的路径）

- 日期：2026-10-14
- 备份 tag：`R119-20261014-173223`（两份安装同 tag）
- 改动文件：`ui/app/15-chat-chrome.js`（两份安装，改后 md5 一致）
- 补丁：`r119-fixes.patch`
- 状态：代码完成、语法校验通过，**待重启后真机验证**

## 症状

R118 部署（17:22）并重启（17:26）后实测：展开靠下的卡片，新消息到达时右栏**仍然**直接弹到最上面。

## R118 为什么没挡住（日志 + 代码走查）

时间线证明修复是在线的（17:26:26 重启），所以是路径没覆盖到。真正路径：

1. 新会话到达 → SSE `session-start` → `loadSessions()` → `renderSessionList()` 包裹层 → `fillLeft()`（左栏已锚，没问题）。
2. `autoFollowRunning` 默认 **true**（00-core.js:279）→ 自动跟随 `selectSession(新会话id)`。
3. 02 的 `selectSession` → `loadSessionDetail(新id)` → `renderSessionDetail(新id)` → **本层详情包裹层的回退分支**：`#cc-cards` 里还没有这个新会话的卡 → `selCard` 为 null → 回退：
   ```js
   var rFull = rd.apply(this, arguments);   // ← 02 先写 detail.innerHTML：
   try { applyRight(true); } catch (e) {}   //   #cc-cards 连骨架被清掉，
   return rFull;                            //   DETAIL.scrollTop 同时归零
   ```
4. **R118 的锚点抓在 `applyRightInner` 入口——晚了一步**：此时 02 已经清完，`sdTop0` 抓到的是 0，`sdTop0 > 4` 不成立 → 恢复被跳过 → 重建后新卡插顶 → 视野弹回顶部。

另有一条同源路径：详情接口 >200ms 时 02 的延迟占位（`selectSession` 里的 `hintTimer`）同样会清空 DETAIL，锚点同样抓不到。

## 修复：早锚晚补（三个抓锚入口 + 统一补偿）

模块级 `ccAnchor {top, h, chat, at}` + `captureScrollAnchor(force)` / `restoreScrollAnchor()`：

| 入口 | 位置 | 作用 |
|---|---|---|
| ① 包裹层回退分支 | `rd.apply` **之前** | 主路径：新会话 + 自动跟随。在 02 清空前抓住真实阅读位置 |
| ② `selectSession` 包裹层 | `sc.apply` 之前，`force=true` | 覆盖慢接口 >200ms 延迟占位的清空路径；用户新动作永远重抓 |
| ③ `applyRightInner` 入口 | 非强制 | sync/activate 等直接调用方；**不覆盖** ①/② 已抓的新锚点 |

消费：`applyRightInner` 末尾、`autoFoldTick()` 之后 `restoreScrollAnchor()`——按 `scrollHeight` 增量补偿（新卡插顶 + 自动展开的高度都算进去）。

守卫：**同一聊天 + 5 秒内 + 原本不在顶部**（scrollTop>4）。切了聊天 / 陈年锚点一律丢弃；在顶部则不恢复，新卡出现在顶部即所见（聊天式跟随）。`force` 只跳过“沿用新锚点”的快捷判断，聊天/页面/顶部守卫始终生效——切聊天走 pickChat 时 `ccLastChat !== st.chat` 天然挡住。

## 语义核对

| 场景 | 行为 |
|---|---|
| 同聊天新会话到达（自动跟随） | 阅读位置不动，新卡在顶部展开 ✅ |
| 慢接口（>200ms 占位清空） | selectSession 入口已锚 → 落地后补偿恢复 ✅ |
| 接口失败 | 02 写「加载失败」→ R117 重建 → 入口②的锚点仍在 → 恢复 ✅ |
| 切换聊天对象 | 不锚不恢复，新列表从顶开始 ✅ |
| 用户本来就在顶部 | 保持顶部，新卡即所见 ✅ |

## 验证与回滚

- `node --check` 两份通过；`md5sum` 两份一致（`2b74e947…`）。
- 回滚：`cp 15-chat-chrome.js.bak-R119-20261014-173223 15-chat-chrome.js`（两份同 tag），或 `patch -R` 应用 `r119-fixes.patch`。
- **待重启验证**：展开靠下卡片 → 新消息到达时视野保持原地（不再弹顶）；顶部时新卡正常出现；慢网络/失败场景同样不跳。
