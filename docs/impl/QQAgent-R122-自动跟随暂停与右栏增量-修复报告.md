# QQAgent R122 修复报告：用户接管暂停自动跟随 + 右栏增量 reconcile + 卡体自愈

- 日期：2026-10-14
- 回合同号：R122（接 R116~R121 会话选择界面系列）
- 背景：用户对逐条打补丁失去耐心，要求对会话选择界面做**系统性 UI 代码审查**；审查报告（分级 P0×2 / P1×2 / P2×6）交付后用户答复"你看看怎么修吧"，委托实施。本报告覆盖按审查建议顺序落地的 **B（自动跟随用户接管暂停）→ C（补漏）** 两组共 8 处改动。
- 改动文件（唯一）：`ui/app/15-chat-chrome.js`（两份安装同步：`G:\QQagent\resources\app` 运行版 + `C:\Users\Administrator\Desktop\洛版QQ-Agent-v0.4.8\resources\app` 开发树，改后 md5 一致：`aaa8790950c846d35d811310d6914e0d`）
- 备份 tag：`R122-20261014-180052`（两份安装同 tag，`.bak-` 文件在原目录）
- 补丁：`r122-fixes.patch`（备份 → 当前，413 行）
- 校验：`node --input-type=module --check < ui/app/15-chat-chrome.js` 两份均通过；`骂人特化版QQ-Agent` 未动

---

## 一、本轮解决的问题（对应用户反馈与审查结论）

| 编号 | 问题 | 来源 |
|---|---|---|
| P1-4 → B | 用户正在读旧会话，每个新会话到达都把当前选中切走（自动跟随抢选择） | 用户"展开靠下卡片阅读时新消息到达会弹到最上面"的深层根因之一；审查 P1-4 |
| P0-2 → C2 | 新会话卡只在全量重建（自动跟随触发）时才出现在右栏；短会话/被暂停时左右栏计数不一致 | 审查 P0-2 |
| P1-3 → C1 | 慢接口 >200ms 的占位清空会销毁用户展开卡的卡体 → "账在卡亡"：账本说该展开，卡却是空的折叠态 | R121 遗留漏洞 |
| C3 | 滚动锚点 TTL 5s 太紧（慢接口下恢复前就过期）；入口③ 该重抓时不抓 | R119 补强 |
| C5 | 手风琴收起别的卡时**销毁**卡体 → 用户马上又点开要重拉详情、闪「加载中…」 | R121 顺手补漏 |
| P2-6 | 同一 tick 里 fillLeft 双跑（列表包裹层一次 + applyRightInner 末尾一次） | 审查 P2-6 |
| — | `collectSessionNodes` 取「#cc-cards 第一个 .bs-cb」当选中卡内容；用户展开卡体排在选中卡前面时**内容整体调包** | 本轮新发现（R121 引入的潜在缺陷） |

## 二、B 组：自动跟随「用户接管」暂停（CC_PAUSE_MS）

**规则**：用户手动选择（点右栏卡头 / 点左栏聊天对象）后 60 秒内，**系统发起**的 `selectSession` 直接跳过 —— 选择留在用户正在读的会话上；新会话卡照常出现在列表里（靠 C2 增量补卡），只是不抢选择。暂停窗口从最后一次手动选择起算，用户持续操作就顺延。

**实现**：
- 模块级 `CC_PAUSE_MS = 60000` / `ccUserPickAt = 0` / `ccFromUserClick = null`；
- 点击处理与 `pickChat` 置 `ccUserPickAt = Date.now()`，点卡的置 `ccFromUserClick = sid`；
- `selectSession` 包裹层顶部拦截：
  ```js
  var fromUser = ccFromUserClick === arguments[0];
  ccFromUserClick = null;
  if (!fromUser && arguments[0] && arguments[0] !== state.currentSessionId &&
      Date.now() - ccUserPickAt < CC_PAUSE_MS) {
    return null;
  }
  ```
  放行两种情况：① 用户自己点出来的（`ccFromUserClick` 刚被点击处理置上）；② 选回当前已选中的会话（无切换，无干扰）。
- `autoFoldTick` 对「运行中非选中卡」的 `selectSession(s.id)` 同样受此约束（系统调用方）——运行中的会话不再把用户正在读的卡顶掉。

## 三、C2：右栏增量 reconcile（refreshCards 重写）

原来右栏新会话只能等全量重建才出现。现在 `refreshCards` 每次刷新都把 `#cc-cards` 同步成 `sessionsOf(st.chat)` 的真实内容：
- ① 卡头就地更新（R115 的 `data-head` 签名守卫，内容没变不碰 DOM）；
- ② 删卡（列表里没有的 remove）；
- ③ 补卡（新建 `.bp-card.collapsed` 无卡体，按 `startedAt` 倒序插入）+ 按 `sessionsOf` 顺序重排（只移动节点，展开态/卡体原生保留）；
- ④ `.bp-empty` hidden 切换；
- ⑤ `autoFoldTick()`；
- ⑥ DETAIL 滚动补偿（补卡插顶会把下面内容推下去，同左栏套路）。

配套：`autoFoldTick()` 移出 `if (fresh.length)` 门（C4）——02 指纹未变提前返回时也要做运行态迁移检测；`renderSessionDetail` 包裹层按参数定位卡片 `sel = (arguments[0] && arguments[0].id) || state.currentSessionId || null`——为「非选中卡」补内容提供落点。

## 四、C1/P1-3：卡体自愈（"账在卡亡"修复）

`applyRightInner` 的还原循环从「遍历 keepBodies」改为「**遍历账本 ccUserExpanded**」：
- sid 在新列表且非选中 → 保证展开；
- `keepBodies[sid]` 有 → 挂回原卡体（R121 原路径）；
- 没有 → 建「加载中…」占位盒 + 后台 `api('/api/sessions/'+sid)`，回来后 `window.renderSessionDetail(s)` 按参数定位填回**同一张卡**（不抢当前选择）；拉取失败就停在占位，用户可重点卡头重试。

配套新发现修复：`collectSessionNodes` 之前必须先摘走用户展开卡体（原顺序下，若展开卡体在 DOM 里排在选中卡前面，选中的卡的节点会被拎错 → 选中卡与被保留卡**内容调包**）。

## 五、C3：滚动锚点补强

- TTL 5000 → 15000ms（提取常量 `CC_ANCHOR_TTL`）：慢接口场景从抓锚到恢复跨多步异步，5 秒太紧；
- 入口③（applyRightInner 入口）精化：**骨架健在**（`#cc-cards` 还在，scrollTop 实时有效）→ `force` 重抓；**骨架已失**（被占位/重建清空）→ 非强制，沿用 ①② 的好锚点。

## 六、C5 + P2-6

- **C5**：点击处理的手风琴把被收起卡体 `park` 进离帧容器 `ccBodyHold`（打 `dataset.ccOwner` 标记）而非销毁；重新点开该卡时 `pullParkedBody(sid)` 原样捞回 —— 不重拉详情、不闪「加载中…」。`ccBodyHold` 每次全量重建快照时整体清空，park 卡体最多存活到下次重建，之后按账本走 keepBodies / 占位+重填，语义不断。
- **P2-6**：`applyRightInner` 末尾 `fillLeft()` 改为仅 `st.chat !== chatAtEntry`（入口处记账）时调用 —— 同一 tick 里 `renderSessionList` 包裹层已跑过一次 fillLeft + refreshCards，双 fillLeft 白跑一轮 reconcile。

## 七、改动明细（applyRightInner 注释序号同步重排）

① R121 快照块（前移，防调包）→ ② collectSessionNodes → ②′ giveBack AUX → ③ 重建骨架 → ④ 会话卡 → ⑤ skinTools → ⑤′ autoFoldTick → C1 还原循环 → restoreScrollAnchor → ⑥ 点击处理（C5 park + loadingBody/pullParkedBody）→ P2-6 条件 fillLeft。

新增模块级：`CC_ANCHOR_TTL`；新增工具函数 `loadingBody()` / `pullParkedBody(sid)`。

## 八、验证状态与风险

**未验证**：本轮全部依赖真机重启后用户场景回归。重点验证项：
1. 读旧卡时新消息到达：不被抢选择、不跳顶、不自动收起（B + C3）；
2. 右栏新会话卡即时出现，左右栏计数一致（C2）；
3. 慢接口（详情 >200ms）后展开态自愈：不留在「账在卡亡」的折叠空卡（C1）；
4. 手风琴来回切换不闪「加载中…」（C5）；
5. 切换聊天对象时左栏选中态正常刷新（P2-6 的条件 fire 路径）。

**已知边界**：A 组（右栏增量 reconcile 根治，可退役 R118~R121 大部分补丁）仍排期；R122 的补丁链继续叠在既有补丁链之上，A 组落地前复杂度维持。

**回滚**：任一份安装 `cp 15-chat-chrome.js.bak-R122-20261014-180052 15-chat-chrome.js` 即可（重启生效）。
