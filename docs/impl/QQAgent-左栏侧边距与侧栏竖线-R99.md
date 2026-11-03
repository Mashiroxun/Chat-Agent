# QQ Agent 洛版 v0.4.7 —— 左栏侧边距统一 与 侧栏右缘竖线（R99）

- **本轮范围**：用户一次性提了 3 件事，本轮完成前 2 件（A / B），第 3 件（更新报告）待定内容源。
- **改动文件**：`resources/app/ui/style.css`（唯一）
- **基线**：`399348 B / 7631 行 / LF / md5 b3912ffbdb8d5f67c09dc1ac33e52917`（= R98 终点）
- **现盘**：`401731 B / 7661 行 / LF / md5 37352607a7563025ddf69ee1fccfc22d`
- **补丁**：`r99-ab-fixes.patch` —— `4328 B / md5 fbbfe889c9a470ff129bfbf7dbdf3cce / +32 −2 / 3 个 hunk`
- **备份**：`_backup-r99-20261013-000600/`（项目根目录下）

---

## 0. 一句话结论

| # | 用户诉求 | 状态 | 改了什么 |
|---|---|---|---|
| **A** | 保证这俩侧边距大小一致 | ✅ 完成 | `#cc-left / #cc-actions` 补 `padding: 0 2px`；`.bp-left` 补 `scrollbar-gutter: stable` |
| **B** | 参考其他界面在这边加个竖线分隔 | ✅ 完成 | `.sidebar` 的 `border-right` 从 `--line` 换成 `--line-str`（对比度 Δ15.9 → Δ33.0） |
| **C** | 这个地方我希望可以放更新报告方便用户查看 | ⏸ 待定 | 需要先定「更新报告」的内容从哪来（见 §5） |

---

## 1. R99-A：两个全屏页左栏的侧边距

### 1.1 用户给的两张图是哪两个界面

| 图 | 界面 | 左栏元素 | 容器 |
|---|---|---|---|
| `u1`（371×1033） | **会话选择**（全屏页 mode-chat） | `#cc-search-wrap` + `#cc-left` + `#cc-actions` | `#session-list.list-pane`，宽 **262** |
| `u2`（367×933） | **会话设置**（全屏页 mode-setup） | `.bp-sec-row` / `.su-empty` / `.bp-act` / `.bp-nav` | `#bp-setup-left.bp-left`，宽 **216** |

两张图都是窗口左缘的 1:1 裁切。先反推缩放系数：u1 里搜索框上下边框在 y=14 与 y=63 → 高 50 物理 px；`.bp-search` 的 CSS 高是 40px → **缩放 = 1.25（Windows 125%）**。之后所有物理像素都按 ÷1.25 换算回 CSS px。

> ⚠️ 一处量测陷阱：搜索框有 `border-radius: 5px`，**最上面那一行边框的亮段是从左边 5px 处才开始的**（实测 x=24，而真实左缘 ≈17.8）。第一版探测按 x=24 当左缘算，得出「内缩 4.8px」的假结果。按圆角修正后才与 CSS 口径对上。

### 1.2 实测：改前两栏的左右内缩（相对各自容器）

| 元素 | 会话选择 `#session-list`（262） | 会话设置 `#bp-setup-left`（216） | 差 |
|---|---|---|---|
| 行容器（`.bp-nav` / `.bp-act`） 左 / 右 | **0 / 10** | **2 / 2** | 左 −2，右 +8 |
| 分区标题 `.bp-sec` 左 / 右 | **7 / 14** | **9 / 6** | 左 −2，右 +8 |
| 搜索框 `.bp-search` 左 / 右 | 2 / 12 | —— | —— |

规律很干净：**会话选择那一栏的同一批控件，整体比会话设置那一栏左移 2px、右扩 8px。**

### 1.3 根因：两栏的容器内边距不同

用的是**同一批类名**（`.bp-sec` / `.bp-nav` / `.bp-nav-t` / `.bp-act` / `.bp-radio`，r96 已经把这批值对齐过），差的是**父容器的水平内边距**：

```css
/* 会话设置那一栏 */
.bp-left { width: 216px; flex: 0 0 216px; min-height: 0; overflow-y: auto; padding: 2px 2px 8px; }
/*                                                        ↑ 左右各 2px          */

/* 会话选择那一栏 */
#session-list 是 .list-pane —— 它自己**没有内边距**（第 901 行那条规则里没有 padding）
#cc-left / #cc-actions 是 15-chat-chrome.js 用 createElement 插进去的两个**裸 div**
  → 里面的 .bp-nav / .bp-act 是 width:100%，于是贴到容器的 0
```

右侧那 8px 的差还有第二个来源：`#session-list` 在「滚动条贴边」名单里

```css
#session-list, #chat-list, .detail-pane, .settings-pane, .snowluma-pane, .modal-list {
  scrollbar-gutter: stable;                              /* 无条件预留 10px 滚动条槽 */
  --pane-gutter-bleed: calc(var(--scrollbar-w, 10px) + 2px);
}
```

而 `.bp-left` **不在**名单里 —— 同一页右侧的 `.bp-scroll`（设置表单那栏）早在 r96 就补了 `scrollbar-gutter: stable`（第 2862 行），**左栏漏了**。这正是 r96 抓过的那类问题（「内容溢出 → 出现滚动条 → 内容盒窄一个槽宽 → 整栏内容左跳 10px」）。

### 1.4 改动（2 处）

```css
/* ① 给两个裸 div 补上 2px 左右内边距，对齐 .bp-left */
#cc-left, #cc-actions { padding: 0 2px; }

/* ② 给会话设置左栏补滚动条槽，对齐 #session-list */
.bp-left { ... padding: 2px 2px 8px; scrollbar-gutter: stable; }
```

**没有动搜索框**：它的外层 `#cc-search-wrap` 本来就有 `padding: 2px 2px 0`（R97 加的 sticky 挡板，`background: var(--page-bg)` 挡住滚上去的会话项），一直落在 2px 上。这一点很关键 —— 如果把 2px 挪到 `#session-list` 上、把 `#cc-search-wrap` 的 padding 摘掉，挡板就会窄 4px，滚动时两侧各露 2px 的会话项。所以选择「加给子元素」而不是「加给父容器」。

顺带一提，`padding: 0 2px` 本来就是本工程的既有约定 —— 主舞台左栏里的列表也是这么写的：`.sidebar > .list-pane { padding: 0 2px; }`。

### 1.5 改后实测（浏览器重渲染，与真机口径一致）

| 元素 | 会话选择 | 会话设置 | 一致？ |
|---|---|---|---|
| 行容器 左 / 右 | **2 / 12** | **2 / 12** | ✅ |
| 分区标题 `.bp-sec` 左 / 右 | **9 / 16** | **9 / 16** | ✅ |
| 搜索框 左 / 右 | 2 / 12 | —— | 与行容器右缘对齐 ✅ |
| r96 的「+ 与计数右缘齐平」 | —— | **22 / 22** | ✅（改前 12 / 12，两边同时右移 10px，仍齐平） |

> r96 那条对齐没被破坏：`.bp-sec-row` 的 `margin-right: 10px` 与 `.bp-act` 的 `padding-right: 10px` 都建在同一个容器坐标上，加了槽之后两边同时右移 10px。

---

## 2. R99-B：侧栏右缘的竖线

### 2.1 先确认红圈圈的是哪条线

对 `u3.png`（harness 页，1715×1037）做逐列亮度扫描，在安静区（y∈[200,700]）里找「整列亮于底色」的列：

```
底色均值 29.84
x = 219  亮度 44.16  Δ=14.32   跨满整屏 y∈[0,1036]   ← 就是这条
```

x=219 物理 px ÷ 1.25 = **175.2 CSS px**，而 `.sidebar.is-nav { --side-w: 176px }` —— 1px 边框正好落在 x∈[175,176]。

再看亮度：`--line = rgba(255,255,255,.07)` 压在 `--page-bg #1b1c20` 上，手算亮度 = 44.04，**实测 44.16**。两条独立证据都指向：

```css
.sidebar { ... border-right: 1px solid var(--line); ... }
```

**线一直都在，只是太淡了**（Δ14，肉眼基本看不见）—— 所以用户会说「想在这边加个竖线分隔」。

### 2.2 改动（1 处）

```css
.sidebar { ... border-right: 1px solid var(--line-str); ... }
```

选 `--line-str` 而不是新造令牌，依据是本文件自己的令牌注释（第 46-47 行）：

```
--line:     rgba(255, 255, 255, .07);  /* 面的 1px 描边 */
--line-str: rgba(255, 255, 255, .15);  /* 控件描边（要更清楚） */
```

原值是「面的描边」，而这里要的是一条**看得见的分隔线**，取「要更清楚」的那一档。亮色主题同样成立（`[data-theme='light']` 的 `--line-str: rgba(0,0,0,.16)` 也更深）。

> ⚠️ 这条 border 属于 `.sidebar` 本身，**九个页面共用** —— 换色是全局一致的，不是只改 harness 页。这一点是有意的：r96 处理「同一批控件在两个页面呈现不同」时就是按「统一」做的。

### 2.3 校验：实测亮度 vs 手算（四个组合全对）

| | 底色 | 线（实测） | Δ | 手算 | 判定 |
|---|---|---|---|---|---|
| 改前 `--line` · 暗色 | 28.16 | **44.04**（x=175） | 15.88 | 44.04 | ✅ 完全一致 |
| 改前 `--line` · 亮色 | 240.56 | **221.44**（x=175） | 19.12 | 221.30 | ✅ |
| 改后 `--line-str` · 暗色 | 28.16 | **61.16**（x=175） | **33.00** | 62.20 | ✅ |
| 改后 `--line-str` · 亮色 | 240.56 | **201.44**（x=175） | **39.12** | 202.10 | ✅ |

**灵敏度反转自证**：把 `.sidebar` 的 `border-right` 整条摘掉后，同一区间亮度 `28.16 ~ 28.16，Δ0.00` —— 证明量到的确实是这条 border，不是别的东西。

> 亮色主题的判定要反过来：`rgba(0,0,0,a)` 压浅底，线是**最暗**的那一列。第一版探测按「取最亮列」判，报了 3 个假失败，已修正。

---

## 3. 校验汇总

| 套件 | 断言数 | 结果 |
|---|---|---|
| `verify.py`（静态：指纹 / 新值 / 注释配平 / 防回归 / 逐行 diff 分类） | 39 | ✅ 全通过 |
| `browser.js`（运行时：内缩一致性 / 灵敏度反转 / 竖线亮度 / 防回归） | 39 | ✅ 全通过 |
| `mkpatch.py`（正向 / 反向 / 可复现 三重） | 3 | ✅ 全通过 |

**防回归清单**（本次必须没碰到的）：

- R97-B1 `#session-list` 的 `border: 0` / `border-radius: 0` —— 运行时实测 `border 0px 0px 0px 0px`、`radius 0px`
- R97-B2 `.bp-search` 的 `--field-bg` 底 + `--line-str` 描边 + `:focus-within` 光晕 —— 运行时实测 `1px rgba(255,255,255,0.15)`、`rgb(29,30,35)`
- R97-B3 焦点环（带 `input.` 前缀那条）
- R98 `.mk-card` 无 `backdrop-filter`
- `#cc-search-wrap { padding: 2px 2px 0; background: var(--page-bg) }`（sticky 挡板）
- `.sidebar > .list-pane { padding: 0 2px }`
- `.model-modal-left` 的 `border-right` 仍是 `--line`（**只该改 `.sidebar`**）
- 第 2836 行的「滚动条贴边」名单、第 2862 行的 `.bp-scroll` 规则
- `#cc-right-head` 没被误加 padding

---

## 4. 交付物

| 文件 | 说明 |
|---|---|
| `r99-ab-fixes.patch` | 4328 B / `fbbfe889…` / +32 −2 / 3 hunk，三重校验通过 |
| `r99-ab-columns.png` | 四联图：聊天模式 × 会话设置 × 改前/改后，蓝/红虚线标出内容左缘(2px)/右缘(12px) |
| `r99-b-divider.png` | 竖线亮度剖面图（硬证据）+ harness 页实景对照 |
| `r99-b-harness.png` | harness 页改前/改后全景 |
| `apply.py` / `verify.py` / `browser.js` / `mkpatch.py` / `probe-*.js` / `shots*.js` | 全套可复跑脚本 |
| `u1~u4.png` | 用户截图的留档 |

应用方式：在 `resources/app/` 下执行 `patch --binary -p1 -i r99-ab-fixes.patch`。

---

## 5. 待决策：R99-C「更新报告」放在会话选择页的空白处

`u4` 那个位置是主舞台的 `#view-sessions > .stage-empty`：

```html
<div class="stage-empty">
  <div class="bs-hint" id="stage-hint">…可关闭的 MyHint…</div>
  <div class="stage-note">…← 会话 · 存档 · 记忆 —— 都在左下角的「会话选择」里…</div>
</div>
```

`.stage-note { margin: auto 0 }` 把它垂直居中，四周全是空白 —— 用户想在这里放「更新报告」。

**已经查清的事实**（决定怎么实现之前必须先定这个）：

1. 项目里**没有任何 changelog / 更新日志文件**（根目录、`resources/app`、`ui/` 全找过）。
2. 但**已有更新检查链路**：`GET /api/update-check` 返回 `{ ok, current, latest, hasUpdate, url, notes }`，其中 `notes` 就是线上 `version.json` 里的发版说明（`src/routes.js:3197`、`src/app.js:63`）。
3. 线上那份 `version.json` 现在实际是：

   ```json
   { "version": "0.4.0",
     "url": "https://kondius.cn/qq-agent/QQ-Agent-V0.4-Preview-Setup.exe",
     "notes": "v0.4 Preview: 覆盖升级自动备份并还原用户数据（配置/记忆/聊天记录/登录态），升级不再丢数据" }
   ```

   注意：**线上版本 0.4.0 < 本地 0.4.7**，所以现在 `hasUpdate` 恒为 false，这段 notes 永远不会被现有 UI 显示出来。
4. 现有 UI 只在「设置 → 应用」区块用到它，且**只用 `latest / current / url`，没用 `notes`**（`07-settings-events.js:1161`）。

所以「更新报告」有三种做法，**需要用户拍板**：

| 方案 | 内容从哪来 | 优点 | 缺点 |
|---|---|---|---|
| **① 本地更新日志**（推荐） | 新建一份本地数据文件（如 `ui/changelog.json`：`[{version, date, items[]}]`），洛版作者自己维护 | 离线永远可见、内容完全可控、可写洛版自己的改动 | 需要一份初始内容 |
| **② 接线上 `notes`** | 复用 `/api/update-check` 的 `notes` + `/api/version` | 零新增文件，发版时改 `version.json` 即可 | 断网就空；线上版本号低于本地时语义别扭；现在只有一句 v0.4.0 的话 |
| **③ ①+②** | 本地为主，线上有新版时追加一行「发现新版本 vX，去下载」 | 兼顾 | 实现量最大 |

**还需要一并定的**：这块内容是「常驻卡片」还是「可折叠/可关闭」（`.stage-empty` 里已经有一个可关闭的 `.bs-hint`，两个可关闭的东西叠在一起会有点乱）。

---

## 6. 遗留（与本轮无关，未动）

- **R97 遗留**：`.bp-sec-row`「选择会话」是否提升为标题（字重 600 / opacity 1）—— R96 提出，仍待定。
- **R97 遗留**：全站还有约 6 个输入框族没有可见焦点反馈（`.qa-input` / `.ic-input` / `.model-rows-table input` / `.forge-input textarea` / `.tp-row .tp-num` / 裸 `input[type=text]`）。
- **R98 遗留**：市场页滚动的真实手感需要用户在真机上确认（headless 量不到窗口呈现帧率）。
- 既有排期：M-02 / M-05 / M-08 / M-16 / M-09 / M-11 / M-15；BUG-07（需 PDB + cdb）；BUG-08（`hotReload: true` 默认值）。
