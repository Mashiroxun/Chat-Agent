# 洛版 QQ-Agent v0.4.7 —— 全界面动效与鼠标交互审计（R95）

> 范围：`C:\Users\Administrator\Desktop\洛版QQ-Agent-v0.4.7\resources\app\ui\`
> 对象：**全部界面的全部动画** + **全部鼠标点击交互细节**（含 hover / press / focus / 禁用 / 光标 / 拖拽 / JS 驱动动效）
> 基线：r94 之后（`_backup-r94-20261012-214836`），本次**只审计、不改动任何文件**
> 数据来源：`_r95/extract.py` 机器扫描 + 人工逐条核对 CSS/JS 原文

---

## 0. 摘要

一句话结论：**动效体系本身是健康的、成体系的**（令牌化、进出分速、三段式按压、reduce 兜底、后台暂停都有），
问题不在"缺动效"，而在**三层历史叠加导致的覆盖失效**——
`原版规则 → 皮肤统一层（L5200+）→ `?` 主题层（L3856+）` 三套规则互不感知，
产生了 **6 类共 21 处失效/半失效的动效声明**，其中 2 处会真实影响观感（reduce 模式下仍会闪位移、用量页双层入场叠加），
其余为死代码与一致性问题。

机器扫描总量：

| 指标 | 数量 |
|---|---|
| CSS 规则块 | **2059** |
| `@keyframes` | **36** |
| `animation*` 声明 | **74** |
| `transition*` 声明 | **122** |
| `:hover` 规则 | **148** |
| `:active` 规则 | **29** |
| `:focus` / `:focus-visible` 规则 | **29** |
| `:disabled` | **10** |
| `:checked` | **11** |
| `:nth-child`（阶梯/错位用） | **30** |
| `cursor:` 声明 | **135**（pointer 107 / not-allowed 8 / default 7 / grab 4 / grabbing 4 / progress 3 / help 1） |
| `will-change` 声明 | **9**（其中 1 处挂在死选择器上） |
| `animation: … infinite` | **20** 处 |

**未发现**：闪退/崩溃相关的动效路径（R94 已清）、无限递归重绘、动画导致的死循环。
**新发现 2 个真实观感缺陷**（M-01、M-04）+ **19 项一致性/死代码问题**。

---

## 1. 方法与覆盖度

### 1.1 扫描方式

手写 CSS 扫描器 `_r95/extract.py`（不依赖任何第三方库）：

- 先去注释（**保留行号**，便于报告定位）
- 用花括号栈维护 `@media` / `@supports` / `@keyframes` 上下文
- 逐规则块抽取 `animation*` / `transition*` / 伪类 / `cursor` / 自定义属性
- 输出 7 份清单到 `_r95/out/`：`keyframes.txt` `animations.txt` `transitions.txt` `interactions.txt` `cursors.txt` `tokens.txt` `stats.txt`

```
rules=2059 keyframes=36
```

### 1.2 已逐条核对的源码

| 文件 | 关键范围 |
|---|---|
| `ui/style.css`（388221 B / 7519 行，LF） | 全量（扫描）+ L1-380、L548-710、L800-850、L1540-1600、L1880-2040、L2500-2700、L2875-2890、L3835-3852、L3900-4140、L4405-4415、L5800-5970、L6000-6100、L6440-6570、L7040-7300、L7400-7520 精读 |
| `ui/app/00-core.js` | L22 `__qaBeat`、L32-34 `qa-bg`、L500-543 chaos 层与点击粒子、L592-641 loading 壳、L703-741 `renderBanner`、L757-809 `switchTab`、L1055-1101 焦点自愈 |
| `ui/app/01-boot.js` | L130-182（`scheduleSessionRender` 80ms 合批） |
| `ui/app/02-sse-sessions.js` | L120-160（qq-portable-log 500ms 防抖）、L230-360（`startStatusPoller` / `attachScrollLoader` / `startListPoller`）、L398-480（`isNew` 判定）、L595-615（`startWaitTicker` 100ms） |
| `ui/app/04-archive-usage.js` | L20-34（`seenChatKeys`）、L357（滚动位置补偿）、L621-646（骨架屏） |
| `ui/app/06-settings-render.js` | L200-224（`moveMenuInd`）、L1636-1711（模块卡拖拽） |
| `ui/app/08-modals.js` | L130-256（`closeModelModal` / `modelModalShell`）、L280-292（先关后开） |
| `ui/app/13-doctor.js` | L422（进度条 width）、L4320-4345（`startDevPolling`） |
| `ui/app/14-chrome.js` | L295-365（侧栏宽度 / 用量维度）、L800-870（`openBigPage` / `closeBigPageThen`）、L905-985（`is-starting` 启动链）、L1188-1190（`syncIdentity` 3s） |
| `ui/app/16-market.js` | L398-436（`marketToast`） |
| `ui/tooltip.js` / `ui/desktop.js` / `ui/index.html` | 全量 |

---

## 2. 动效基础设施

### 2.1 令牌表（`style.css` L223-255）

**时长（9 档）**

| 令牌 | 值 | 语义 | 出处注释 |
|---|---|---|---|
| `--dur-instant` | 50ms | 激活/展开态，观感等同"瞬" | PCL2 用 10ms |
| `--dur-tap` | 80ms | 按压收缩 | PCL2 `MyButton` MouseDown |
| `--dur-hover` | 100ms | 悬停**进入** | PCL2 `animationColorIn` |
| `--dur-fast` | 120ms | 即时反馈（旧档） | — |
| `--dur-base` | 180ms | 颜色/边框变化 | — |
| `--dur-leave` | 200ms | 悬停**离开** | PCL2 `animationColorOut` |
| `--dur-slow` | 260ms | 位移、展开收起 | — |
| `--dur-slower` | 360ms | 模态框、页面转场 | — |
| `--dur-cancel` | 700ms | 按下后划走取消的慢回弹 | PCL2 MouseLeave |

**缓动（4 + 1）**

| 令牌 | 值 | 用途 |
|---|---|---|
| `--ease-out-quart` | `cubic-bezier(.25,1,.5,1)` | 入场、悬浮抬升 |
| `--ease-in` | `cubic-bezier(.4,0,1,1)` | 收回/退出（离场用加速曲线） |
| `--ease-in-out` | `cubic-bezier(.4,0,.2,1)` | 颜色/背景这类对称变化 |
| `--ease-spring` | `cubic-bezier(.34,1.56,.64,1)` | 弹窗、按压（轻微过冲） |
| `--ease-chaos` | `cubic-bezier(.15,2.2,.25,1)` | **仅 `?` 主题定义 —— 全文件 0 次引用（死令牌，见 M-14）** |

**其他**

| 令牌 | dark / light | `?` 主题 |
|---|---|---|
| `--shift-sm / md / lg` | 4 / 8 / 12 px | **24 / 48 / 96 px** |
| `--lift` | `0 0 0 0 transparent` | `4px 4px 0 rgba(255,61,242,.4)` |
| `--lift-sm` | `0 0 0 0 transparent` | `2px 2px 0 rgba(61,229,255,.35)` |
| `--lift-lg` | `0 18px 50px rgba(0,0,0,.5)` | `8px 8px 0 rgba(255,210,61,.45)` |
| `--stagger` | 25ms | 25ms |

> ⚠️ `--lift` / `--lift-sm` 在 dark/light 下是**全透明**——这是 R83 扁平化改造的刻意结果。
> 后果：所有 `box-shadow: var(--lift), var(--paper-edge)` 形式的悬停"抬升"在暗/亮主题下**不产生视觉变化**，
> 只靠 `--paper-edge`（一条 1px 内高光）撑着。`?` 主题下才恢复硬阴影。（M-02）

### 2.2 "进入快 / 离开慢" 的纯 CSS 实现（L257-302）

这是整套动效里最精巧的一处，**不需要 JS**：

```css
/* 默认态 = 离开档（200ms）—— 鼠标移出时回落到它 */
a, button, input, textarea, select, summary, [role='button'], [role='tab'], .clickable {
  transition: background-color var(--dur-leave) var(--ease-in-out),
              border-color     var(--dur-leave) var(--ease-in-out),
              color            var(--dur-leave) var(--ease-in-out),
              box-shadow       var(--dur-leave) var(--ease-in-out),
              transform        var(--dur-slow)  var(--ease-out-quart),
              opacity          var(--dur-leave) var(--ease-in-out);
}
/* :hover = 进入档（100ms）—— 必须整条重写，不能只写 transition-duration */
a:hover, button:hover, … { transition: … var(--dur-hover) … }
```

原理：CSS 的 `transition` 取"变化发生**之后**"计算出的那套值。
进入时 `:hover` 命中 → 100ms（快）；离开时 `:hover` 失效 → 回落默认规则 → 200ms（慢）。
注释里明确警告了"只写 `transition-duration` 会按属性个数对齐顺序、增删属性即错位"——**这是踩过坑的写法，不要改**。

覆盖到的元素：`a / button / input / textarea / select / summary / [role='button'] / [role='tab'] / .clickable`（9 类）。

### 2.3 主题切换平滑过渡（L304-320）

`body, .topbar, .settings-menu, .model-modal, .usage-card, .tier-bar, .tier-param, .usage-table th, .usage-table td`
只过渡 `background-color / border-color / color`（`--dur-slow` 260ms `--ease-in-out`），
**刻意不过渡 `transform`** —— 注释说明否则所有元素会一起抖动。✅ 正确。

### 2.4 全局基础过渡的"意外覆盖"风险

`.btn`（L2077）、`#tabs .nav-item`（L5927）、`.sn-item`（L6070）等**重写了整条 transition**，
所以它们的"离开档"是 `--dur-leave`（与全局一致）✓；
但改造层的 `.launch`（L6032）、`.mini-btn`（L6052）、`.idbar-refresh`（L6013）用的是
`background .16s cubic-bezier(.22,1,.36,1)` —— **脱离令牌体系**（M-08）。

---

## 3. 三套主题的动效分叉

| 维度 | `dark`（默认） | `light` | `?`（混沌/VHS） |
|---|---|---|---|
| 时长令牌 | 全套 9 档 | 同 dark | **同 dark，未改写** |
| 缓动 | 4 条 | 同 | 4 条 + `--ease-chaos`（未引用） |
| 入场曲线 | `ease-out-quart` / `ease-spring` | 同 | **`steps()` 抽帧**（28 处） |
| 页面入场位移 | `--shift-sm` 4px | 4px | **24px** |
| 悬停抬升 | 无（`--lift` 透明） | 无 | 硬阴影 `4px 4px 0` |
| 卡片静态倾角 | 无 | 无 | `rotate(-1.4deg)` 等（L3981-3989） |
| 持续装饰动画 | 无 | 无 | `chaosBgSpin 18s` / `chaosBrandJitter .9s` / `chaosTrack 7s` / `chaosTabHop 1.1s` / `chaosTabUnder 2s` / `chaosBlink` ×4 / `chaosLoadSpin 1s` / `chaosScan .7s` / `chaosBtnShake .45s`（hover 时） |
| 点击反馈 | 无 | 无 | **每次点击爆 3~5 个「？」粒子**（L4129-4140 + `00-core.js` L526-543） |
| 滚动驱动 | — | — | — |

`?` 主题的 `steps()` 分布：`steps(24)` `steps(14)` `steps(3)` `steps(5, end)` `steps(4, end)` `steps(5)` `steps(2, jump-none)` `steps(8)` `steps(6)` `steps(7, end)` `steps(3, end)` `steps(6, end)` `steps(2, end)` —— 共 **28 处**，全部为"抽帧跳切"（VHS 观感），这是**设计意图**，不是性能妥协。

`?` 主题 JS 层（`00-core.js`）：

```js
// L513-523：主题切走即移除 #chaos-vhs，零残留
function syncChaosLayers(on) { … }
// L526-543：点击爆粒子（每次 3~5 个，850ms 后 remove）
document.addEventListener('click', (e) => {
  if (document.documentElement.getAttribute('data-theme') !== '?') return;
  const n = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) { /* span.chaos-pop + --dx/--dy/--rot 随机 */ }
}, { passive: true });
```

---

## 4. 逐界面动效清单

图例：**入场** = 元素出现时；**悬停** = `:hover`；**按压** = `:active`；**焦点** = `:focus-visible`；**持续** = infinite 动画。

### 4.1 启动加载壳 `#loading-overlay`（`index.html` L112-127）

| 项 | 实现 | 值 |
|---|---|---|
| 持续 | `.loading-spinner { animation: spin 0.9s linear infinite }` | L553-559 |
| `?` 主题持续 | `chaosLoadSpin 1s steps(8) infinite`（旋转 1080° + 变色） | L4067-4072 |
| 隐藏 | JS：`loadingOverlay.style.transition='opacity .25s ease'` → `opacity=0` → 300ms 后 `remove()` | `00-core.js` L605-612 |
| 状态文本 | `setLoadingStatus()` 每次追加一行到 `.loading-logs`（保留末 12 行），**无动画** | L599-603 |
| 失败兜底 | `showBootFailure()` 重建 `.loading-card` innerHTML，**无动画** | L635+ |
| 后台暂停 | `html.qa-bg .loading-spinner` → `animation-play-state: paused` ✓ | L7497 |

⚠️ 唯一的**内联 transition**（`.25s ease`，非令牌）在这里。

### 4.2 顶栏 `#topbar`

| 元素 | 悬停 | 按压 | 焦点 | 备注 |
|---|---|---|---|---|
| `.win-btn`（最小化/最大化/关闭） | `background rgba(255,255,255,.18)`，`--dur-fast` | `rgba(255,255,255,.28)` | `outline 2px solid rgba(255,255,255,.7); offset -2px` | `cursor: default`（对齐 Windows）；关闭键 hover 变红 `#e04a4a` / active `#c93f3f` |
| `#tabs .nav-item`（**5 项一级导航**） | `bg rgba(255,255,255,.16)`，**进入 100ms** | `transform: scale(.955)` + `transition-duration: var(--dur-tap)×3` | **无** ⚠️ | 默认 200ms（离开）；`.active` 走 `--dur-instant` 50ms（"近乎即时"） |
| `#tabs .nav-btn`（"确认金句"，默认 hidden） | `bg rgba(255,255,255,.28)` | `transform: scale(.96)` | 无 | 保留自旧体系 |
| `.readiness-dots` | `box-shadow: var(--inset-edge)`（值不变 → 视觉无变化） | — | — | `cursor: pointer` |
| `.rdot` | — | — | — | `transition: background var(--dur-base) ease, box-shadow var(--dur-base) ease`；`.on` 绿点发光；`.wait` 呼吸 `breathe 1.8s infinite` |
| `.dot-on` | — | — | — | 静态绿点 + `0 0 6px var(--green)` |
| `#banner` | — | — | — | `animation: banner-rise .22s cubic-bezier(.22,1,.36,1)`；**只播一次**（JS 只 toggle `.hidden`，不重建） |

`?` 主题顶栏额外：
- `.tab.active` → `chaosTabHop 1.1s steps(3) infinite`（持续蹦极）
- `.tab.active::after` → 4px 色差下划线 + `chaosTabUnder 2s steps(5) infinite`
- `.brand` → `chaosBrandJitter .9s steps(3) infinite`（RGB 色差抖动）
- `#topbar { transform: rotate(-.4deg) }`（静态倾角）
- `[data-theme='?'] .tab { transition: none }`（L4030）—— 抽帧主题下不用过渡

> ⚠️ `.tab` 的整套悬停/按压/选中样式（L826-844、L5299-5308、L5932-5950 部分）**全部不可见**：
> 11 个 `.tab` 都在 `.tab-pool { display: none !important }`（L5963）里，只作 `switchTab` 的身份锚点。
> 真实视觉由 5 个 `.nav-item` 承担。**这是 index.html L62-66 明确注释过的架构，不是 bug**，
> 但读 CSS 时会误以为顶栏有两套按钮。（M-11）

### 4.3 左栏 `#sidebar`

| 元素 | 入场 | 悬停 | 按压 | 焦点 |
|---|---|---|---|---|
| `.avatar` / `.idbar-refresh` | — | `.avwrap:hover .idbar-refresh { opacity: 1 }`，`opacity .16s cubic-bezier(.22,1,.36,1)` | — | `.idbar-refresh:focus-visible { opacity: 1 }` ✓ |
| `.launch`（一键启动） | — | `background rgba(79,146,255,.12)`，`.16s cubic-bezier(.22,1,.36,1)` | `transform: scale(.985)`，`transform .12s …` | 无 |
| `.launch.is-starting` | `cursor: progress` | — | — | — |
| `.mini-btn` | — | `rgba(127,127,127,.14)`，`.16s` | `scale(.97)`，`.12s` | 无 |
| `.sn-item`（二级导航） | — | `background: var(--hover)`，**进入 100ms** | `scale(.985)` + `--dur-tap` | 无 ⚠️ |
| `.sn-item.on` | — | — | — | `transition: … var(--dur-instant)` 50ms（近乎即时） |
| `.sn-item.is-off` | `cursor: default` | `background: transparent`（悬停无反馈） | — | — |
| `.settings-menu-item` | — | `color: var(--text); box-shadow: var(--inset-edge)` | `scale(.985)` | 无 |
| `.settings-menu-ind` | **JS 滑动** | — | — | — |

`.settings-menu-ind`（滑动指示条）是本项目最完整的 JS 动画，`06-settings-render.js` L205-224：

```js
ind.classList.add('no-anim');        // 关掉 top/height 过渡
ind.style.top = menuIndPrevTop+'px'; // 先把条放到旧位置
void ind.offsetHeight;               // 强制 reflow：让起点成为样式事实
ind.classList.remove('no-anim');     // 重新打开过渡
ind.style.top = top + 'px';          // 滑向新位置
```

CSS：`transition: top .26s var(--ease-out-quart), height .26s var(--ease-out-quart), opacity var(--dur-base) var(--ease-in-out)`；
`.no-anim` 时只保留 `opacity` 过渡。逻辑正确 ✅。

### 4.4 会话页 `#view-sessions`

| 项 | 实现 |
|---|---|
| 容器入场 | `.view.active { animation: pageIn var(--dur-slow) var(--ease-out-quart) }`（L1963） |
| 新会话项 | `.session-item.new-item { animation: itemIn var(--dur-slow) var(--ease-out-quart) }`（L1955，`opacity 0→1` + `translateY(-5px)→none`） |
| 悬停 | `.session-item:hover { background: var(--hover) }`，`--dur-base` |
| 按压 | 无 `:active`（列表项靠选中态表达） |
| 等待中 | `.session-wait[data-until]` 文本由 `startWaitTicker` **每 100ms** 改写（`等待中 · 12.3s`） |
| `?` 主题 | 奇数项 `chaosCutL .5s steps(4,end)` / 偶数项 `chaosCutR` / `3n` 项 `chaosCutY .55s steps(5,end)`；静态倾角 `rotate(.6deg)` / `rotate(-.7deg)`；悬停 `translateX(18px) rotate(1.6deg) scale(1.03)`（奇）/ `translateX(12px) rotate(-1.6deg)`（偶），`transform .15s steps(2,end)` |

⚠️ **`isNew` 判定（`02-sse-sessions.js` L434 + L480）**：`state.seenSessionIds` 在 render **之后**统一 `add` 全部 id。
所以**首帧所有会话都带 `.new-item`** → 首次进会话页整列同时播 `itemIn`（260ms）。
会话数多时（如 100 条）会有 100 个元素同时动画。属"首屏一次性入场"，非 bug，但值得知道。

### 4.5 存档页 `#view-chats`

| 项 | 实现 |
|---|---|
| 容器入场 | `#usage-page` 类同构：`.view.active` 的 `pageIn`（`#chats-page` 选择器**不存在**，见 M-03） |
| 新群聊项 | `.chat-item.new-item { animation: itemIn … }`（同 L1955） |
| 未读行 | `.chat-item.unread-row { animation: itemIn var(--dur-slow) var(--ease-out-quart) }`（L2018） |
| 悬停 | `background: var(--hover)` |
| 引用选中 | JS toggle `.quote-selected`（`04-archive-usage.js` L242），CSS 提供选中态 |
| 滚动加载 | `attachScrollLoader('chat-detail', …)`：120ms 节流**带尾随调用**，距底 <400px 触发，追加而非全量重建 |
| 滚动位置补偿 | `detail.scrollTop = prevTop + delta`（L357）——加载更多后保持阅读位置 |
| 骨架屏 | `.sk-line` / `.sk-row` / `.sk-col` / `.sk-chart`，见 4.16 |

### 4.6 用量页 `#view-usage`

| 项 | 实现 |
|---|---|
| **双层入场** ⚠️ | 外层 `.view.active`（L1963）+ 内层 `#usage-page`（L1960）**同时**播 `pageIn 260ms` → 视觉"二次到位"（M-04） |
| 卡片悬停 | `.usage-card:hover { transform: translateY(-2px); box-shadow: var(--lift-lg), var(--paper-edge) }`，`--dur-slow`；`.accent:hover` 是 `-3px` |
| 卡片按压 | 无 |
| 图例圆点 | `.uc-dot:hover { fill: var(--accent) }`；`.uc-bar-row:hover { background: var(--hover) }`；`:focus-visible { outline: 2px solid var(--accent); offset -2px }` |
| 表格行 | `.usage-table.clickable tbody tr:hover { background: var(--hover); box-shadow: inset 0 1px 3px var(--depth) }`；`:active { background: var(--active) }`；`tr:hover td:first-child { box-shadow: inset 2px 0 0 var(--accent) }`（左侧强调条） |
| "更多" | `.usage-card.clickable:hover .uc-more { opacity: 1 }`，`--dur-base` |
| 进度条 | `.tb-bar i { animation: barGrow var(--dur-slower) var(--ease-out-quart) }`（从 `width: 0` 生长） |
| `?` 主题 | `.usage-card` 奇数/偶数/`.accent` 三套 3D 猛起（`rotateY(±22deg)` + `translateY(-16px)` + `scale(1.1)`），`transform .18s steps(3,end)`；`.tb-bar i` → `chaosBarBoom .7s steps(6,end)`（`scaleY` 爆炸） |
| 骨架屏 | 见 4.16 |

### 4.7 记忆页 `#view-memory`

| 项 | 实现 |
|---|---|
| 卡片悬停 | `.mem-card:hover { background: var(--layer-2); transform: translateY(-1px); box-shadow: var(--lift), var(--paper-edge), inset 0 0 0 1px color-mix(accent 45%) }`，`transform --dur-fast` |
| 卡片按压 | `.mem-card:active { transform: translateY(0) }` |
| 成员芯片 | `.member-chip:hover { color: var(--accent); box-shadow: var(--lift), var(--paper-edge) }`；`:active { box-shadow: var(--inset-edge) }` |
| 成员表 | `.member-table tr { animation: itemIn var(--dur-base) var(--ease-out-quart) }`；`:hover { background-color/color var(--dur-fast) }` |
| `?` 主题 | `.member-table tr` 奇/偶 → `chaosCutL` / `chaosCutR .45s steps(4,end)`；`#view-memory #memory-detail { transform: rotate(-.4deg) }` |
| 合并进度 | `consolidateTicker = setInterval(...)`（`05-memory-settings.js` L39）驱动文本更新 |

### 4.8 技能页 / 插件页 `#view-skills` / `#view-plugins`

**模块卡拖拽排序**是本项目最复杂的交互（`06-settings-render.js` L1636-1711）：

| 阶段 | DOM/样式变化 |
|---|---|
| `pointerdown`（左缘 26px 热区内，非按钮） | 记录 `offX/offY`（抓取点偏移，**不是中心对齐**——注释记录"曾用中心对齐，一拖起卡片就跳到鼠标正下方，像被甩了一下"） |
| 超过 5px 阈值 | `beginDrag()`：克隆 `.mcard-ghost`（`left/top/width/height` + `transformOrigin = ${offX}px ${offY}px`）、原卡加 `.mcard-src`、其余卡加 `.mcard-shifting`、`grid` 加 `.mdrag-active`、`document.body.style.cursor = 'grabbing'` |
| `pointermove` | `swapTo(idx)`：目标卡 `style.transform = translate(dx, dy)` 滑到拖卡原槽位 |
| `pointerup`（提交） | **零过渡落位**：`c.style.transition='none'` → `grid.appendChild(c)` → 清 inline transform → `void grid.offsetWidth` 强制 reflow → 恢复 `transition` |

> 注释（L1695-1701）记录了 r38 的坑：`appendChild` 移动已有节点时浏览器会把**重挂前**的样式当过渡起点，
> 导致松手后卡再滑一遍（实测同卡上有 2 个 `CSSTransition(transform)` 跑约 100ms）。
> 现在的"一帧内钉死"写法是**正确解法，不要简化**。

| 项 | 实现 |
|---|---|
| 卡悬停 | `.mcard:hover { transform: translateY(-1px); box-shadow: var(--lift) }` |
| 抓手 | `.mcard:hover .mcard-grip { opacity: .8 }`；`.mcard-grip:hover { opacity: 1; color: var(--accent) }`；`:active { cursor: grabbing }`；`cursor: grab` |
| 信任/齿轮/删除 | `.mcard-trust:hover { background: var(--layer-3); border-color/color: var(--accent) }`；`:active { translateY(1px) }`；`.mcard-gear:hover { background: var(--accent); color: var(--on-accent) }`；`.mcard-del:hover { background: var(--red) }` |
| 新增卡 | `.addmod-big:hover { border-color: var(--accent) }` + **悬停换内容**：`.addmod-label { opacity: 0 }` / `.addmod-hover-label { opacity: 1 }`（`--dur-fast`） |
| 骨架 | `.sk-block > .sk-row` ×5~8 |

### 4.9 市场页 `#view-skillmarket` / `#view-pluginmarket`（`16-market.js`）

| 项 | 实现 |
|---|---|
| 刷新按钮 | `.mk-refresh`：`color/border-color/background .12s`；`:hover` 变 `--accent-hi` 系 |
| 卡片 | `.mk-card { border-color/background .12s, transform .18s ease }`；`:hover { transform: translateY(-2px) }` + 边框/底变色；`.mk-installed:hover { transform: none }`（已安装不抬升） |
| 卡片内图标块 | `.mk-card:hover .mk-tile { color: var(--fg); background: … }`（`.mk-tile { color/background .12s }`） |
| 按钮 | `.mk-btn { color/border-color/background .12s }`；`:hover:not(:disabled)` 变 `--accent-hi`；`:disabled { cursor: default; opacity: .55 }`；`.mk-btn-done` 终态 |
| 加载 | `.mk-spin { animation: mk-spin .7s linear infinite }` |
| 轻提示 | `.mk-toast`：`transform: translate(-50%, 14px)` → `.on` 时 `translate(-50%, 0)` + `opacity 0→1`，`opacity .18s, transform .18s`；JS `3200ms` 后摘 `.on`（`marketToast()`） |
| 搜索/筛选 | `.mk-search input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft) }`；`.mk-select:focus` 同 |

### 4.10 工具页 `#view-harness`（Doctor / 开发订单，`13-doctor.js`）

| 项 | 实现 |
|---|---|
| 子导航 | `.doctor-sub { color/background .15s }`；`:hover { color: var(--text); background: var(--layer-1) }` |
| 折叠体 | `.doctor-sub-body { min-height .2s var(--ease-out-quart) }`；`#view-harness .doctor-subs + .hint` 同 |
| 芯片 | `.doctor-chip { background/border-color .12s }`；`:hover { background: var(--hover); border-color: var(--accent) }` |
| 修复项 | `.fix-item { border-color/background .15s }`；`:hover { background: var(--hover) }` |
| 模式按钮 | `.forge-mode { border-color/color/background .15s }`；`:hover { color: var(--text); border-color: var(--accent) }` |
| 拖放区 | `.is-over` 由 `dragover`/`dragleave` 切换（L2325-2329、L2578-2582） |
| 三诊进度条 | `.doctor-triage-prog i { width .3s ease }`，宽度由 SSE `doctor-triage` 事件驱动（L422 内联 `style="width:${pct}%"`） |
| 折叠面板 | `.doctor-trace > summary:hover`、`.doctor-chip:hover`、`.module-note > summary { background-color/color .16s ease }` + `.mn-chev { transform .18s ease }` |
| 输入焦点 | `.doctor-chat-input textarea:focus` / `.doctor-cfg-row input:focus` / `.devorder-composer input:focus` → `outline: none; border-color: var(--accent)` |
| 下拉箭头 | `.bp-chev`（实为 `#cc-cards` 的）与 `.mn-chev` 用 `transform: rotate(±180deg)` 表达展开 |
| 轮询 | `startDevPolling()`：`setTimeout` 自续期，`polling` 布尔单实例守卫，`ticks > 72000`（~10 小时）兜底 |
| 自动滚动 | 贴底时才 `scrollTop = scrollHeight`，否则"原地不动（别把回看历史的用户弹走）"（L3971-3972） |

### 4.11 SnowLuma 页 `#view-snowluma`（`03-snowluma.js`）

| 项 | 实现 |
|---|---|
| 日志 | `pre.scrollTop = pre.scrollHeight`（仅在原本贴底时），`is-empty` 类切换 |
| 节点脉冲 | `.sl-node.is-wait .sl-node-idx { animation: sl-pulse 1.6s ease-in-out infinite }`（`box-shadow` 橙色扩散环） |
| 节点链接 | `.sl-node.is-on` 绿 / `.is-next`/`.is-wait` 橙（**静态色，无过渡**） |
| 刷新节流 | `qq-portable-log` SSE 事件 → **500ms trailing-edge 防抖**（`02-sse-sessions.js` L136-142，修 UI-26 的"每行日志全页重绘"） |
| 轮询刷新 | `listPoller` 每 `refreshIntervalMs()`（默认 15000）`loadSnowlumaPage({ quiet: true })` |
| 诊断线索 | `.sl-diag-clues summary:hover { color: var(--text) }`；`.sl-diag-item:nth-child(odd)` 静态底色 |
| 链接按钮 | `.sl-link-btn:hover { text-decoration: underline }` |

### 4.12 设置页 `#view-settings`

| 项 | 实现 |
|---|---|
| 容器入场 | `.view.active` 的 `pageIn`（`#settings-page` 选择器**不存在**） |
| **阶梯入场** | `.settings-pane > *` → `animation: pageIn var(--dur-slow) var(--ease-out-quart) both` + `animation-delay: calc(var(--i,0) * var(--stagger))`；`--i` 由 `:nth-child(1..8)` 给 0~7 → 步进 **25ms**，最大延迟 **175ms**（L1547-1566） |
| 左栏指示条 | 见 4.3（`.settings-menu-ind` 的 JS 滑动，`top/height .26s`） |
| 左栏项 | `.settings-menu-item:hover { color: var(--text); box-shadow: var(--inset-edge) }`；`:active { scale(.985) }`；`.active { background: var(--sel-bg); color: var(--accent) }` |
| 折叠面板 | `.collapsible > summary:hover { color: var(--text) }`；`.collapsible[open] > *:not(summary) { animation: pageIn var(--dur-base) var(--ease-out-quart) }`；`.fold-sub { grid-template-rows .3s var(--ease-in-out) }`（展开动画） |
| 开关 | `input.sw`：`background-color .18s var(--ease-out-quart) !important`；`::after { transform .18s }`；`:checked::after { transform: translateX(18px) }`；`:hover { border-color: var(--accent) }`；`:disabled { opacity: .4; cursor: not-allowed }`；`:focus-visible { outline: 2px solid var(--accent); offset 2px }`；`:checked { animation: none }`（显式关掉勾选弹跳，见 M-16） |
| 复选框 | `.checkbox-row input[type=checkbox]:checked { animation: checkPop var(--dur-base) var(--ease-spring) }`（`scale .85 → 1.18 → 1`） |
| 自定义下拉 `.sel` | `.sel-head:hover { border-color: var(--accent) }`；`.sel-arrow { transform var(--dur-fast) var(--ease-in) }`（**离场用 ease-in** ✓）；`.sel.open .sel-arrow { var(--dur-base) var(--ease-out-quart) }`；`.sel-menu { transform var(--dur-fast) var(--ease-in), visibility 0s linear var(--dur-fast) }`（延迟隐藏，让过渡播完）；`.sel-menu.open { transform .2s var(--ease-out-quart) }`；`.sel-opt:hover`；`.sel-disabled .sel-head { cursor: not-allowed }` |
| 档位按钮 | `.tier-btn:hover { background: var(--hover) }`；`:active { scale(.97) }`；`.on { animation: checkPop var(--dur-slow) var(--ease-spring) }` |
| 滑块 | `.tier-slider`（`grab`/`grabbing`，`thumb:hover scale(1.12)`、`:active scale(1.02)`、`:focus-visible box-shadow 0 0 0 4px`）；`.vslider2`（同构，`vs2-thumb::after` 放大，`vs2-disabled cursor: not-allowed`） |
| 主题选项 | `.theme-option:hover { transform: translateY(-2px); box-shadow: var(--lift-sm) }`，`--dur-slow` |
| 色板 | `.swatch { transform var(--dur-base) var(--ease-out-quart) }`；**`:hover { transform: scale(1.12) }` 被 L5670 覆盖为 `none`（M-10）** |
| 颜色输入 | `input[type="color"]:hover { border-color: var(--accent) }` |
| 表单焦点 | `.field input:focus / textarea:focus / select:focus { box-shadow: var(--inset-edge), 0 0 0 2px color-mix(accent 45%) }`；皮肤层再压一次 `input[type='text']:focus { outline: 0; border-color: var(--accent); box-shadow: none }` |
| 底栏链接 | `.settings-foot .sf-link { color var(--dur-base) var(--ease-in-out) }`；`:hover { color: var(--accent-hi) }`；`:active { opacity: .7 }` |
| 快速设置行 | `.settings-quick .sq-row:hover { background: var(--hover) }` + `:hover .sq-t { color: var(--text) }` |
| 保存反馈 | `07-settings-events.js` L980-1012：给按钮/输入/区块写 `style.boxShadow` 高亮，**2000ms 后清空**（内联，非令牌） |
| 变动提示 | `.dirty-glow` **已整体置空**（L330-331，`background-image: none; animation: none`），JS 仍保留调用（M-17） |

### 4.13 反馈页（`10-feedback.js`）

| 项 | 实现 |
|---|---|
| 步骤切换 | `nextBtn/backBtn/submitBtn` 的 `.hidden` 类切换（无动画） |
| 自动保存 | `saveTimer` 防抖 |
| 关闭 | `setTimeout(() => overlay.remove(), 1600)` |
| 图片删除 | `.fb-img .fb-img-del { cursor: pointer }` |
| 二维码 | `.q-check input { cursor: pointer }` |
| 问卷容器 | `qc.classList.remove('hidden')` / `add('hidden')` |

### 4.14 全屏页 `#bigpage`（`14-chrome.js`）

| 项 | 实现 |
|---|---|
| 打开 | `bigpage.hidden = false` + `classList.toggle('mode-chat'/'mode-setup')` —— **无入场动画**（`display` 硬切） |
| 关闭 | `bigpage.hidden = true` —— **无退场动画** |
| `closeBigPageThen(tab)` | 必须 `setTimeout(…, 0)`：`15-chat-chrome.js` 的 `MutationObserver` 会在**微任务**里还原 tab，宏任务才能落在它后面（注释记录 r95 实测："打开完整设置页"点完停在会话首页） |
| 卡片折叠 | `#cc-cards .bp-card.collapsed .bp-chev { transform: rotate(-180deg) }`（`.2s var(--ease-out-quart)`）；`.collapsed .bs-cb { display: none }`（**硬切，无高度过渡**） |
| 卡头悬停 | `#cc-cards .bp-ch:hover { background: var(--hover) }` |
| 工具卡展开 | `.ts-more { opacity .55; opacity .15s/background .15s var(--ease-out-quart) }`；`.ts-more:hover` 与 `.ts-open .ts-more { opacity: 1 }` |
| 隐藏块 | `.cc-hide { display: none !important }`（`15-chat-chrome.js` L185-187 / L826-828 切换） |

### 4.15 弹窗族

| 弹窗 | 入场 | 退场 | 备注 |
|---|---|---|---|
| `.model-modal-overlay` | `fadeIn var(--dur-base) var(--ease-in-out)` | `.closing` → `fadeOut var(--dur-base) var(--ease-in-out) forwards` + `pointer-events: none` | 关闭 400ms 兜底 `setTimeout` + `animationend` 一次性监听（`done` 标志防重复） |
| `.model-modal` | `popIn var(--dur-slow) var(--ease-spring)`（`translateY(12px) scale(.97)` → 55% 过冲 → `none`） | `.closing .model-modal` → `popOut var(--dur-base) var(--ease-in-out) forwards` | 打开后 `setTimeout(0)` 聚焦首个输入框 |
| `.modal-overlay` / `.modal` | `fadeIn` / `popIn var(--dur-slow) var(--ease-spring)` | — | L2322-2350 |
| `.model-dd`（两栏模型下拉） | `popIn var(--dur-base) var(--ease-out-quart)` | — | 内含 `.mdd-prov:hover` / `.mp-row:hover` |
| `.sel-menu` | `transform .2s var(--ease-out-quart)` | `transform var(--dur-fast) var(--ease-in), visibility 0s linear var(--dur-fast)` | 延迟隐藏 |
| `.upload-toast` | `popIn var(--dur-slow, .3s) ease` | — | 右上角，**不自动消失**，只能手动关 |
| `.mk-toast` | `.on` 切换（`opacity/transform .18s`） | 3200ms 后摘 `.on` | 居中底部 |
| `.app-tip`（自绘气泡） | `opacity var(--dur-fast) var(--ease-out-quart), transform var(--dur-fast) var(--ease-out-quart)`，`translateY(3px)` → `none` | 同 | 450ms 延迟弹出；`pointer-events: none`（否则气泡自己反复触发 mouseover/mouseout 造成闪烁） |
| `.chaos-pop` | `chaosPopFly .8s steps(6, end) forwards` | 850ms 后 `remove()` | 仅 `?` 主题 |

**弹窗叠加的时序纪律**（`08-modals.js`）：
- `closeModelModal` 派发 `qa-close` → 让 Promise 型对话框 settle
- `scheduleOpenModelManage` 用 **420ms**（= 400ms 兜底 + 20ms 余量）等退场动画走完再开下一个
- Esc 监听挂**捕获阶段**（`true`），避免与 `14-chrome.js` 的冒泡级 Esc（关全屏页）打架 → 一次 Esc 关两层
- 焦点陷阱 `registerFocusTrap` 集中在**文档级**一份，只拦最上层弹窗

### 4.16 骨架屏（跨 5 个界面）

| 类 | 动画 | 位置 |
|---|---|---|
| `.sk-line::after` / `.sk-row::after` | `shimmer 1.4s var(--ease-in-out) infinite` | L3424 |
| `.sk-col` | `skPulse 1.5s ease-in-out infinite`（`opacity .4 → .95`） | L3449 |
| `.sk-col:nth-child(3n+1/3n+2/4n)` | `animation-delay: .18s / .36s / .52s`（**错峰脉动**） | L3455-3457 |
| `.sk-chart::after` | `shimmer 1.6s var(--ease-in-out) infinite` | L3459 |
| `?` 主题 | `chaosScan .7s steps(6) infinite`（`translateX(-130%) skewX(-30deg)` → `250%`，色差斜扫） | L4072-4083 |

使用方：`03-snowluma.js` L42、`04-archive-usage.js` L632-646、`06-settings-render.js` L1806、`13-doctor.js` L690/981/3698。

### 4.17 托盘

**无任何 UI 动画**（`electron/main.js` 的 `Tray` 菜单）。与动效相关的只有：
- `showWindow()` 里的 `focusedOnce` 一次性聚焦（R94-1，防止看门狗重建窗口后抢焦点）
- `setSkipTaskbar(true/false)` 的切换（显示/隐藏任务栏图标，无过渡）

---

## 5. 鼠标交互细节总表

### 5.1 悬停（148 条）—— 按行为分类

| 行为模式 | 代表选择器 | 时长 |
|---|---|---|
| **背景色变化**（最常见） | `.session-item:hover`、`.chat-item:hover`、`.mm-model:hover`、`.pick-item:hover`、`.sel-opt:hover`、`.icon-btn:hover`、`.sq-row:hover`、`.fix-item:hover`、`.bp-row:hover` | `--dur-base` 或 `--dur-fast` |
| **背景 + 内高光** | `.member-chip:hover`、`.settings-menu-item:hover`、`.mm-prov:hover`、`.model-modal-close:hover`、`.mdd-prov:hover`、`.mp-row:hover` | `--dur-base` |
| **背景 + 抬升**（`translateY`） | `.nav-btn:hover (-1px)`、`.mem-card:hover (-1px)`、`.mcard:hover (-1px)`、`.usage-card:hover (-2px)`、`.usage-card.accent:hover (-3px)`、`.theme-option:hover (-2px)`、`.mk-card:hover (-2px)` | `--dur-slow` / `--dur-base` |
| **放大** | `.swatch:hover scale(1.12)`（**失效**）、`.tier-slider thumb:hover scale(1.12)`、`.vs2-thumb:hover::after scale(1.1)` | `--dur-base` / `--dur-fast` |
| **颜色变化** | `.list-head-btn:hover (→red)`、`.bl-global-toggle:hover (→red)`、`.mm-del:hover`、`.bp-del:hover`、`.ic-del:hover (→red)`、`.devorder-wl-del:hover (#c53030)`、`.sf-link:hover (→accent-hi)` | `--dur-base` / `--dur-fast` |
| **下划线** | `.ut-link:hover`、`.sl-link-btn:hover`、`.linklike:hover`、`.link:hover`、`.sf-link-hot:hover` | — |
| **透明度** | `.tool-category-header:hover (0.8)`、`.mcard:hover .mcard-grip (0.8)`、`.uc-more (1)`、`.ts-more (1)`、`.idbar-refresh (1)` | `--dur-fast` / `--dur-base` |
| **悬停换内容** | `.addmod-big:hover .addmod-label (0→)` / `.addmod-hover-label (→1)` | `--dur-fast` |
| **变红（危险）** | `.win-btn-close:hover (#e04a4a)`、`.btn-danger:hover`、`.mcard-del:hover` | `--dur-fast` / `--dur-leave` |
| **变蓝（强调）** | `.btn:hover`、`.btn-primary:hover`、`.launch:hover`、`.mini-btn:hover`、`.sn-item:hover` | `--dur-hover` / `.16s` |

### 5.2 按压（29 条）—— 三段式 vs 单段

**完整三段式（`--dur-tap` 80ms / `--dur-cancel` 700ms 取消回弹）—— 仅 3 处：**

| 选择器 | 按下 | 取消（划走） |
|---|---|---|
| `.btn:active` / `.btn:active:not(:hover)` | `transform: scale(.955)` + `transition-duration: var(--dur-tap)×6` | `transform: none` + 全属性 `--dur-cancel` |
| `#tabs .nav-item:active` / `:active:not(:hover)` | `scale(.955)` + `--dur-tap`×3 | `none` + `--dur-cancel` |
| `.sn-item:active` / `:active:not(:hover)` | `scale(.985)` + `--dur-tap`×2 | `none` + `--dur-cancel` |

**单段按压（26 处，无取消回弹）：**

`.win-btn:active`、`.win-btn-close:active`、`.nav-btn:active`、`#tabs .nav-btn:active`、`.tab:active`、`.list-head-btn:active`、`.session-abort/retry-btn:active`、`.mem-card:active`、`.member-chip:active`、`.settings-menu-item:active`、`.model-modal-close:active`、`.usage-table tr:active`、`.tier-btn:active`、`.btn-danger:active`、`.model-pick-btn:active`、`.icon-btn:active`、`.tier-slider thumb:active`、`.vs2-thumb:active`、`.mcard-grip:active`、`.mcard-trust:active`、`.launch:active`、`.mini-btn:active`、`.sf-link:active`、`[data-theme='?'] .btn:active`、`[data-theme='?'] .nav-btn:active`、`.checkbox-row input[type=checkbox]`

### 5.3 焦点（29 条）

**有 `:focus-visible` 的（12 处）：**
`.win-btn`、`.btn`、`input.sw`、`.tool-warn`（橙色）、`.uc-bar-row`、全局 `:focus-visible { outline: 2px solid var(--accent); offset 2px; border-radius 4px }`（L3315）、`.tier-slider:focus-visible::-webkit-slider-thumb`、`.vslider2:focus-visible`、`.vslider2 .vs2-thumb:focus-visible::after`、`.mcard`、`.module-note > summary`、`.idbar-refresh`

**有 `:focus`（非 visible）的（15 处）：**
`#test-send-text`、`.model-rows-table input`、`.field input/textarea/select`、`.ma-toolbar input`、`.pc-row input[type=number]`、`.bp-in/.bp-out/.bp-cached`、`.tier-param input/textarea`、`.qa-input`、`.fi-adapt-input`、`.mig-input`、`.doctor-chat-input textarea`、`.doctor-cfg-row input`、`.fix-card textarea`/`.fix-input`、`input[type='text'/'number'/'password'/'search'/'time']/textarea/select`（皮肤层统一压平）、`.mk-search input`、`.mk-select`、`.devorder-composer input`

**⚠️ 完全没有焦点环的关键可交互元素（M-06）：**
`.sn-item`、`.settings-menu-item`、`.sel-head`、`.pick-item`、`.mm-prov`、`.theme-option`、`.mcard-trust` / `.mcard-gear` / `.mcard-del`、`.tab`、`#tabs .nav-item`、`.tier-btn`、`.icon-btn`、`.mk-card`、`.mk-btn`、`.doctor-chip`、`.doctor-sub`、`.fix-item`、`.launch`、`.mini-btn`、`.bp-ch`、`.sn-item`

### 5.4 禁用（10 条）与光标

| 光标 | 使用处 |
|---|---|
| `not-allowed`（5） | `.btn:disabled`、`.tool-checkbox-box`（`input:disabled +`）、`input.sw:disabled`、`.sel-disabled .sel-head`、`.pc-row input[type=number]:disabled`、`.vslider2.vs2-disabled`、`.vs2-high/low[aria-disabled='true']` |
| `default`（5） | `.mcard-trust:disabled`、`.mcard-del:disabled`、`.mini-btn[disabled]`、`.mk-btn:disabled`、`.sn-item.is-off`、`.chat-status .session-status` |
| `grab`（4） | `.tier-slider::-webkit-slider-thumb`、`.tier-slider::-moz-range-thumb`、`.vslider2 .vs2-thumb`、`.mcard-grip` |
| `grabbing`（4） | `.tier-slider thumb:active`、`.vs2-thumb:active`、`.mcard-grip:active`、`.mdrag-active .mcard` |
| `progress`（3） | `input.sw[data-pending]`、`.launch.is-starting` |
| `help`（1） | `.tool-warn` |
| `pointer`（107） | 所有可点击面 |
| `default`（`.win-btn`） | **刻意**对齐 Windows 原生标题栏按钮 |

> ⚠️ **禁用态两套光标**：`not-allowed`（`.btn`/`input.sw`/`.pc-row input`）vs `default`（`.mcard-*`/`.mini-btn`/`.mk-btn`/`.sn-item.is-off`）。语义相同、表现不同。（M-07）

### 5.5 全局点击/指针监听（非 CSS 的交互逻辑）

| 监听 | 位置 | 作用 |
|---|---|---|
| `click`（capture=false, passive） | `00-core.js` L526 | `?` 主题爆粒子 |
| `pointerdown`（capture=true） | `00-core.js` L1074 | 记录待聚焦的可编辑元素 + 点击坐标 |
| `pointerup`（capture=true）→ `setTimeout(check, 0)` | `00-core.js` L1100 | **焦点自愈**：若点击后 `activeElement` 不是目标，`requestAnimationFrame` 里再给一拍，仍不对则 `console.error` 详细诊断（目标/坐标/命中元素/抢焦点者/`userSelect` 链）并强制 `focus()` |
| `mouseover`/`mouseout`/`focusin`/`focusout`（capture=true） | `tooltip.js` L117-127 | 摘 `title` → 450ms 后弹自绘气泡；离开时还原 `title` |
| `mousedown`/`wheel`/`scroll`/`resize` | `tooltip.js` L129-132 | 只收气泡，**不动 `title`**（注释记录踩坑：动了就会在 ~1s 后冒原生黄条） |
| `dblclick` on `#topbar` | `desktop.js` | 双击空白处最大化/还原（排除 `button/input/select/textarea/a/.top-status`） |
| `pointerdown/move/up/cancel` on `.mcard` | `06-settings-render.js` L1714+ | 拖拽排序 |
| `dragover`/`dragleave`/`drop` | `08-modals.js` L487-492、`09-community.js` L796、`13-doctor.js` L2325/2578 | 拖放热区 `.persona-drop-hot` / `.module-drop-hot` / `.is-over` |
| `scroll`（节流 120ms + 尾随） | `02-sse-sessions.js` L275 | 加载更多（距底 <400px） |

---

## 6. JS 驱动的动效（非 CSS）

### 6.1 定时器清单

| 周期 | 位置 | 做什么 | 是否产生视觉变化 |
|---|---|---|---|
| **1000ms** | `00-core.js` L22 | `window.__qaBeat++`（看门狗心跳） | ❌ 纯计数 |
| **100ms** | `02-sse-sessions.js` L607 | 改写 `.session-wait` 文本（`等待中 · 12.3s`） | ✅ **文本宽度变化 → 可能挤动相邻元素** |
| **80ms** | `01-boot.js` L160 | `scheduleSessionRender` 合批（列表 + 详情） | ✅ 全量重绘 |
| **500ms** | `02-sse-sessions.js` L139 | `qq-portable-log` 防抖重绘 | ✅ |
| **3000ms** | `14-chrome.js` L1188 | `syncIdentity`（头像/昵称/状态同步） | ✅（R94 已加值签名短路） |
| **5000ms** | `00-preview.js` L1070 | `pvTick`（仅预览模式，模拟数据推进） | ✅ |
| **15000ms**（可配） | `02-sse-sessions.js` L341 | `listPoller`：按当前页刷会话/存档/SnowLuma/用量/状态 | ✅ |
| **3600000ms** | `11-init.js` L52 | `runUpdateCheck` | ⚠️ 可能出更新提示 |
| 自续期 | `02-sse-sessions.js` L245 | `statusPollTimer`（每次重读 `ui.refreshMs`） | ✅ |
| 自续期 | `13-doctor.js` L4336 | `startDevPolling`（订单页，`ticks>72000` 兜底） | ✅ |
| `setInterval` | `05-memory-settings.js` L39 | `consolidateTicker`（合并进度） | ✅ |
| `requestAnimationFrame` | `00-core.js` L1086 | 焦点自愈的第二拍 | ❌ |

**唯一使用 `requestAnimationFrame` 的地方是焦点自愈**（不是动画）。`01-boot.js` L150-153 有明确注释解释为什么**不用** rAF 做渲染合批：
> 窗口被遮挡/最小化时 Chromium 会完全停发 rAF，渲染全部积压到切回前台才一次性出现 —— 用户看到的就是"不手动刷新就不更新"。

### 6.2 类切换清单（驱动 CSS 动画）

| 类 | 切换者 | 触发什么 |
|---|---|---|
| `.new-item` | `02-sse-sessions.js` L434 / `04-archive-usage.js` L23 | `itemIn` 入场 |
| `.unread-row` | `04-archive-usage.js` L25 | `itemIn` 入场 |
| `.session-waiting-row` | `02-sse-sessions.js` L450 | 等待行样式 |
| `.closing` | `08-modals.js` L160 | `fadeOut` + `popOut` 退场 |
| `.switching`（body） | `00-core.js` L777-780 | 110ms 内关掉非活动视图的**全部过渡** |
| `.qa-bg`（html） | `00-core.js` L33 | 后台暂停 21 组 infinite 动画 |
| `.mdrag-active` / `.mcard-src` / `.mcard-shifting` / `.mcard-ghost` | `06-settings-render.js` L1648-1684 | 拖拽三态 |
| `.is-starting` | `14-chrome.js` L925/964 | `cursor: progress` |
| `.no-anim` | `06-settings-render.js` L215/219 | 指示条瞬移 |
| `.on`（`.mk-toast` / `.sn-item` / `.tier-btn` / `.theme-option` / `.rdot` / `.sn-item`） | 多处 | 选中/显示态 |
| `.hidden`（`#banner`） | `00-core.js` L721 | 横幅显隐（入场只播一次） |
| `.is-maximized` | `desktop.js` L41 | 图标切换（`ico-max` ↔ `ico-restore`） |
| `.logged-in` | `14-chrome.js` L1094/1097 | 头像两层切换 |
| `.folded` | `07-settings-events.js` L670/678、`09-community.js` L412 | 折叠 |
| `.collapsed` / `.ts-open` / `.cc-hide` | `15-chat-chrome.js` | 卡片折叠/工具卡展开/整块隐藏 |
| `.is-over` / `.persona-drop-hot` / `.module-drop-hot` | 拖放 | 热区高亮 |
| `.quote-selected` | `04-archive-usage.js` L242 | 金句勾选 |
| `.active` / `.on`（导航） | `00-core.js` L764/783、`14-chrome.js` L1119 | 选中态 |

### 6.3 `switchTab` 的入场重触发技巧（`00-core.js` L781-791）

```js
$$('.view').forEach((v) => {
  const on = v.id === `view-${name}`;
  v.classList.toggle('active', on);
  if (on) {
    v.style.animation = 'none';
    void v.offsetWidth;   // 强制 reflow
    v.style.animation = '';   // 类名"重新加上"才会重播
  }
});
```

CSS 动画只在类名**重新加上**时播放；`display:none → flex` 本身也会重启动画，
这里的显式 reflow 是双保险（且对 `#usage-page` 这类内层容器无效，见 M-04）。

### 6.4 滚动行为

| 容器 | 行为 |
|---|---|
| `#session-list` / `#chat-detail` | 距底 <400px 追加一页；`chat-detail` 有 `scrollTop` 补偿保持阅读位置 |
| `.sel-menu`（下拉） | 打开时 `menu.scrollTop = cur.offsetTop - menu.clientHeight/2 + cur.offsetHeight/2`（当前项居中） |
| SnowLuma 日志 | 仅原本贴底才跟随 |
| Doctor 聊天 | 仅 `how === 'bottom'` 才贴底，否则 `pend.top` 原地不动 |
| 开发订单 | 换块时 `scrollTop = 0` |
| `scroll-behavior` | 全局未设 `smooth`；`reduce` 模式下显式 `auto !important` |

---

## 7. 全局抑制层

### 7.1 `prefers-reduced-motion: reduce`（L341-364）

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
    scroll-behavior: auto !important;
  }
  .model-modal, .usage-card, .tier-btn, .toast,
  [class*='itemIn'], [class*='popIn'], [class*='slideIn'] {
    animation: none !important;
    transform: none !important;
  }
  .settings-pane > * { animation-delay: 0ms !important; }
}
```

✅ 做得对的地方：
- 通配符把时长压到 1ms，`scroll-behavior` 强制 `auto`
- 阶梯入场 `animation-delay` 归零（注释解释：否则元素要先隐形 175ms，比没有动画更难受）
- `transform: none !important` 连 `:hover` 的位移一起抹掉

⚠️ 问题（**M-01**）：第二组的 7 个选择器里 **4 个永不匹配** ——
`.toast`（类名不存在，实际是 `.mk-toast` / `.upload-toast`）、
`[class*='itemIn']`、`[class*='popIn']`、`[class*='slideIn']`（按**类名子串**匹配，而类名是 `new-item` / `.model-modal` / `.upload-toast`，不含这些子串）。
后果：`.session-item.new-item`（itemIn，位移 -5px）、`.upload-toast`（popIn，位移 12px）、
`.model-dd`（popIn）、`.collapsible[open] > *`（pageIn）、`.member-table tr`（itemIn）
在 reduce 模式下仍会播位移，只是被通配符压成 **1 帧闪一下**，而不是彻底不位移。

### 7.2 后台暂停 `html.qa-bg`（L7478-7520 + `00-core.js` L32-34）

```js
document.addEventListener('visibilitychange', () => {
  document.documentElement.classList.toggle('qa-bg', document.hidden === true);
});
```

CSS 侧用 `animation-play-state: paused` 暂停 **21 组选择器**。

**逐条比对结果：与全部 20 处 `infinite` 动画一一对应，无遗漏** ✅

| infinite 动画 | 承载选择器 | qa-bg 覆盖 |
|---|---|---|
| `spin 0.9s` | `.loading-spinner` | ✓ |
| `breathe 1.8s` | `.rdot.wait` / `.dot-wait` | ✓✓ |
| `shimmer 1.4s / 1.6s` | `.sk-line::after` / `.sk-row::after` / `.sk-chart::after` | ✓✓ |
| `skPulse 1.5s` | `.sk-col` | ✓ |
| `sl-pulse 1.6s` | `.sl-node.is-wait .sl-node-idx` | ✓ |
| `mk-spin .7s` | `.mk-spin` | ✓ |
| `chaosBgSpin 18s` | `? .app-shell::before` | ✓ |
| `chaosTrack 7s` | `#chaos-vhs .vhs-track` | ✓ |
| `chaosBrandJitter .9s` | `? .brand` | ✓ |
| `chaosTabHop 1.1s` | `? .tab.active` | ✓ |
| `chaosTabUnder 2s` | `? .tab.active::after` | ✓ |
| `chaosBlink .7s/1.7s/1.2s` | `? .dot-wait` / `.dot-on` / `.unread-pill` / `.status-badge` | ✓✓✓✓ |
| `chaosLoadSpin 1s` | `? .loading-spinner` | ✓ |
| `chaosScan .7s` | `? .sk-line::after` / `.sk-row::after` | ✓ |
| `chaosBtnShake .45s` | `? .btn:hover` / `.nav-btn:hover` / `.icon-btn:hover` | 不覆盖（hover 态在后台不存在）✅ 合理 |

> 这是 R93（R78-12 落地）的成果，做法克制：**只暂停 `infinite` 的装饰动画，不碰 `fadeIn`/`popIn` 这类有限入场动画**
> （注释解释：暂停有限动画会让它在恢复后接着播尾巴，观感是"迟到的入场"）。
> 回退方式明确：删掉 CSS 这一段 + `00-core.js` 那 4 行监听，无其他耦合。✅

### 7.3 切页挂起 `body.switching`（L1967-1974 + `00-core.js` L774-780）

```css
body.switching .view:not(.active),
body.switching .view:not(.active) * { transition: none !important; }
```

110ms 挂载窗口内把**非活动视图**及其后代的过渡全关掉 ——
防止旧页残留的悬停态/浮层过渡在切换瞬间闪一下。
活动视图自身的 `animation`（入场）不受影响。✅

### 7.4 滚动驱动动画（L955-963，全项目唯一）

```css
@supports (animation-timeline: scroll()) {
  .list-head::after {
    animation: listHeadSeam 1ms linear both;
    animation-timeline: scroll(nearest);
    animation-range: 1px 24px;      /* 滚动超过 24px 即完全亮起 */
  }
}
```

`.list-head::after` 基础态是 `opacity: 0; pointer-events: none`（L953-957）。
旧版 Chromium 上 `@supports` 不成立 → 分隔线永远不亮（渐进增强的降级路径）✅

---

## 8. 发现的问题

### P1 —— 会真实影响观感

**M-01｜reduce 模式的"停动画"清单 4/7 是死选择器**
- 位置：`style.css` L341-364
- 死选择器：`.toast`（类名不存在）、`[class*='itemIn']`、`[class*='popIn']`、`[class*='slideIn']`
- 后果：前庭功能障碍用户在 reduce 模式下，列表新条目/上传提示/下拉/折叠面板仍会"1 帧闪一下"位移
- 修法：把三个属性选择器换成真实类名 —— `.session-item.new-item, .chat-item.new-item, .upload-toast, .model-dd, .collapsible[open] > *:not(summary), .member-table tr, .modal, .model-modal-overlay`；`.toast` 换成 `.mk-toast`

**M-02｜`--lift` / `--lift-sm` 在 dark/light 下全透明 → 悬停"抬升"无视觉变化**
- 位置：`style.css` L1/L114（令牌定义）；引用处 30+ 条（`.nav-btn:hover`、`.mem-card:hover`、`.member-chip:hover`、`.mcard:hover`、`.theme-option:hover`、`.btn:hover`、`.model-pick-btn:hover`、`.model-modal-close:hover`、`.mm-del:hover`、`.bp-del:hover`、`.mcard-trust:hover` …）
- 后果：暗/亮主题下，这些元素的悬停反馈只剩 `--paper-edge` 那一条 1px 内高光（在深底上几乎不可见）；真正被感知到的只有背景/文字色变化
- 性质：**R83 扁平化改造的刻意结果**，不是回归。但审计上必须记录：**"抬升"这一层动效在 2/3 主题下是空转的**
- 可选修法：给 `--lift` / `--lift-sm` 在 dark/light 下补一条极淡的真实阴影（如 `0 1px 2px rgba(0,0,0,.28)`），保留扁平观感又恢复悬停层次

**M-03｜`#settings-page` / `#chats-page` / `.page` / `.settings-section` 四个选择器全部不存在于 DOM**
- 位置：`style.css` L1960-1962、L4018-4022、L1569-1582（`.settings-section` 的 10 条规则）、L4022（`will-change`）
- 证据：`index.html` 与 `ui/app/*.js` 中 `settings-page` / `chats-page` / `class="page"` / `settings-section` **各 0 次命中**；设置页真实容器是 `#settings-form.settings-pane`（`index.html` L280）
- 后果：
  - `?` 主题下**存档页 / 设置页 / 技能 / 插件 / 工具页没有** `chaosCutY` 跳切入场（只有 `.view.active` 的通用 `pageIn`）→ `?` 主题的入场语言在这几页不统一
  - `L1960` 那一组 5 个选择器只有 `#usage-page` 活着
  - `.settings-section` 的阶梯入场（L1569-1582，8 条 `--i` + 2 条 `animation`）**完全空转**（设置页的阶梯来自 `.settings-pane > *`）
- 修法：删掉 4 个死选择器；若确实想让设置页/存档页在 `?` 主题下跳切，改成 `[data-theme='?'] #view-settings, [data-theme='?'] #view-chats`

**M-04｜用量页双层 `pageIn` 叠加**
- 位置：`style.css` L1963（`.view.active`）+ L1960（`#usage-page`）；DOM：`index.html` L229 `<section id="view-usage" class="view">` → L241 `<div id="usage-page" class="usage-pane">`
- 现象：每次进入用量页，外层 section 与内层容器**同时**播 `pageIn 260ms var(--ease-out-quart)`（各 `translateY(4px)` → 过冲 → `none`）→ 视觉上是"两段到位"的顿挫，位移叠加约 8px
- 修法：`#usage-page` 从 L1960 的选择器组里去掉（它的入场交给外层 `.view.active`）

### P2 —— 一致性问题

**M-05｜三段式按压只覆盖 3 个控件**
- 完整实现：`.btn`（L2077-2135）、`#tabs .nav-item`（L5927-5950）、`.sn-item`（L6070-6097）
- 其余 **26 处 `:active` 只有单段 `transform`**，没有 `--dur-cancel` 的取消回弹 → 按下后把指针划走，回落速度与新按钮不一致（实测差异：80ms vs 700ms）
- 修法：至少给同类高频控件（`.nav-btn`、`.tab`、`.settings-menu-item`、`.icon-btn`、`.list-head-btn`、`.launch`、`.mini-btn`、`.mk-btn`）补 `:active:not(:hover)` 的 `--dur-cancel` 段

**M-06｜20 个关键可交互元素没有焦点环**
- 清单：`.sn-item`、`.settings-menu-item`、`.sel-head`、`.pick-item`、`.mm-prov`、`.theme-option`、`.mcard-trust` / `.mcard-gear` / `.mcard-del`、`.tab`、`#tabs .nav-item`、`.tier-btn`、`.icon-btn`、`.mk-card`、`.mk-btn`、`.doctor-chip`、`.doctor-sub`、`.fix-item`、`.launch`、`.mini-btn`、`.bp-ch`
- 后果：键盘 Tab 到这些元素时**没有任何可见焦点指示**（WCAG 2.4.7 不达标）
- 修法：L3315 的全局 `:focus-visible` 已经存在，但被这些元素的 `outline: none`（部分）或未声明覆盖；统一补 `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`

**M-07｜禁用态两套光标**
- `not-allowed`：`.btn:disabled`、`.tool-checkbox-box`、`input.sw:disabled`、`.pc-row input:disabled`、`.sel-disabled .sel-head`、`.vslider2.vs2-disabled`
- `default`：`.mcard-trust:disabled`、`.mcard-del:disabled`、`.mini-btn[disabled]`、`.mk-btn:disabled`、`.sn-item.is-off`
- 修法：统一（建议 `not-allowed`，`.win-btn` 的 `default` 例外保留并补注释）

**M-08｜61 处硬编码时长脱离令牌**
- `.12s`×16（市场页 `.mk-*` 系、`.mcard-trust`）、`.15s`×17（Doctor 页、`#cc-cards .ts-more`、`.devorder-row`）、`.16s`×7（改造层 `.launch`/`.mini-btn`/`.idbar-refresh`/`.bp-clear`/`.bp-row`/`.module-note > summary`）、`.18s`×11（`input.sw` 系、`.mk-card`/`.mk-toast`、`.model-dd`）、`.2s`×5（`.sel-menu.open`、`.settings-menu-ind`、`.bp-chev`、`.doctor-sub-body`）、`.26s`×2、`.3s`×2、`0s`×1
- 后果：调 `--dur-*` 无法全局生效，观感会分叉
- 修法：批量替换为最近的令牌档（`.12s`→`--dur-fast`、`.15s`→`--dur-base`? 需逐处判断，建议一次只改一类）

**M-09｜`input.sw` 的过渡写了 4 遍，2 遍带 `!important`**
- L2493（`!important`）、L2529、L5581、L5643（`!important`）
- 值恰好都是 180ms（= `--dur-base`），**视觉无差**，但任何单处修改都可能不生效
- 修法：只保留一处（建议 L5643 那对 `!important` 或 L5581 的令牌版），其余删除

**M-10｜`.swatch:hover { transform: scale(1.12) }` 被皮肤层覆盖为 `none`**
- L3350（原版）vs L5670（改造层），同特异性（0,2,0），后者在后 → 生效
- 后果：色板悬停**没有**放大反馈（`transition: transform var(--dur-base)` 也因此空转）
- 修法：删掉 L3350 的 `transform: scale(1.12)`，或删掉 L5670 的 `transform: none`

**M-11｜`.tab` 体系的全部悬停/按压/选中样式不可见（架构性，非 bug）**
- 11 个 `.tab` 在 `.tab-pool { display: none !important }`（L5963）里，只作 `switchTab` 的身份锚点
- 死规则：`.tab:hover`（L828）、`.tab:active`（L5300）、`.tab.active`（L826）、`#tabs .nav-btn:hover/active`（L843-844，此组因"确认金句"按钮可见而部分生效）
- 性质：`index.html` L62-66 明确注释过的设计。审计上记录即可，**不建议删**（删了 `switchTab` 的 `.active` 清理与 `tabOrder` 键集会少一半）

**M-12｜`--ease-spring` 在 keyframes 里用字面量，改令牌不影响入场曲线**
- 令牌引用 5 处：`.model-modal`(L1954)、`.tier-btn.on`(L1991)、`.mm-model input:checked`(L2018)、`.checkbox-row input:checked`(L2032)、`.modal`(L2350)
- keyframes 内字面量 3 处：`popIn` 55%(L1895)、`pageIn` 55%(L1906)、`ddIn` 55%(L1921) —— 全部写 `cubic-bezier(.34, 1.56, .64, 1)`
- 后果：改 `--ease-spring` 不会影响三条最重要的入场曲线的过冲手感
- 修法：`@keyframes` 内允许用 `var()`（Chromium 支持），替换为 `var(--ease-spring)`

**M-13｜`--ease-chaos` 是死令牌**
- 定义于 L3919（`[data-theme='?']`），**全文件 0 次引用**（grep 只命中定义行）
- 修法：要么删，要么给 `?` 主题的 `transition` 用上（现在 `?` 主题全走 `steps()`，这条贝塞尔曲线确实没位置）

**M-14｜`[data-theme='?'] #settings-page { will-change: transform }` 是死声明**
- 位置：L4022。`#settings-page` 不存在 → 这条 `will-change` 永远不生效
- 后果：无害（`will-change` 在死选择器上不产生合成层），但属噪声

**M-15｜`?` 主题点击粒子无数量上限**
- 位置：`00-core.js` L526-543
- 每次点击爆 3~5 个 `span.chaos-pop`，每个带 `will-change: transform, opacity` + `chaosPopFly .8s steps(6, end) forwards`，850ms 后 `remove()`
- 连点 50 次 ≈ 200 个 fixed 定位合成层同时存在 → `?` 主题下快速连点会掉帧
- 修法：加一个在飞粒子计数（如 >40 就不再生成），或改用单个 canvas 层

**M-16｜`.checkbox-row input.sw:checked { animation: none }` 与复选框的 `checkPop` 语义分裂**
- 开关（`sw`）：`:checked` 显式 `animation: none`（L2546），只有 `background-color/background-position` 过渡
- 复选框（`checkbox`）：`:checked` 播 `checkPop`（`scale .85 → 1.18 → 1`，`--dur-base --ease-spring`，L2029）
- 性质：刻意区分（开关是滑块位移，复选框是打勾弹跳），但两处语义都是"勾选"，审计记录

### P3 —— 纯死代码

**M-17｜`.dirty-glow` 已置空但 JS 仍保留调用**
- CSS：L330-331 `background-image: none; animation: none`（注释说明原"流动的浅黄渐变"在透明分层窗口上被逐帧 alpha 混合成"黄色的一坨"，已整体移除）
- JS：`07-settings-events.js` L212-215 保留调用与说明注释
- 修法：删 CSS 两行 + JS 的 add/remove 调用（对应早先清单里的 UI-18）

**M-18｜`.usage-table.clickable tbody tr:hover td:first-child` 与 `tr:hover` 重复表达同一意图**
- L1979-1983：`tr:hover td:first-child { box-shadow: inset 2px 0 0 var(--accent) }`（左侧强调条）
- L3154：`tr:hover { background: var(--hover); box-shadow: inset 0 1px 3px var(--depth) }`
- 两者叠加（一个给首格左侧条、一个给整行背景），**不冲突**，但视觉上是"左侧条 + 行内阴影"双层，值得知道

**M-19｜`.tab` 相关的死规则（同 M-11）**
- `.tab::before { display: none }`（L826）、`.tab.active`、`.tab:hover`、`.tab:active`、`#tabs .nav-btn:hover`（部分死）

**M-20｜`.win-btn` 的 `cursor: default` 缺注释**
- L649。对齐 Windows 原生标题栏（箭头指针）是刻意的，但 CSS 里没写原因；`desktop.js` 里有解释。建议在 CSS 补一行注释，免得后人"顺手改成 pointer"

**M-21｜2 个 `@keyframes` 定义了但从未被引用**
- `slideInRight`（L1910）：全仓仅 1 次命中（定义行本身），0 处 `animation: … slideInRight`
- `ddIn`（L1917）：同上（注释里还写着"下拉弹出仍保持零时长感"，但下拉实际用的是 `popIn`，见 L2883 `.model-dd { animation: popIn var(--dur-base) var(--ease-out-quart) }`）
- 后果：无害，但会误导后人以为下拉有专用曲线
- 修法：删两条 keyframes（共 12 行）；若确实想给 `.model-dd` 用 `ddIn` 的 `-7px` 起点，把 L2883 的 `popIn` 换成 `ddIn`

---

## 9. 建议与优先级

| 优先级 | 项 | 改动量 | 收益 |
|---|---|---|---|
| **P1** | M-01 reduce 死选择器 → 换真实类名 | 1 处 CSS（7 行） | 无障碍真实生效；reduce 用户不再闪位移 |
| **P1** | M-04 用量页去掉内层 `pageIn` | 1 处 CSS（1 个选择器） | 消除"二次到位"顿挫 |
| **P1** | M-03 删 4 个死选择器（含 `?` 主题组与 `will-change`） | 3 处 CSS（约 15 行） | 消除 `?` 主题入场语言不统一；删 10 条空转规则 |
| **P2** | M-06 补 20 处 `:focus-visible` | 1 处 CSS（1 条组合规则） | WCAG 2.4.7 达标 |
| **P2** | M-05 补 8 处 `:active:not(:hover)` | 1 处 CSS（约 30 行） | 按压手感全局一致 |
| **P2** | M-10 删 `.swatch:hover` 死声明 | 1 行 | 消除覆盖困惑 |
| **P2** | M-12 keyframes 内 3 处 `var(--ease-spring)` | 3 行 | 令牌真正统一 |
| **P2** | M-07 禁用态光标统一 | 5 行 | 一致性 |
| **P3** | M-13 删 `--ease-chaos` / M-14 删死 `will-change` / M-17 删 `.dirty-glow` / M-19 删死 `.tab` 规则 / M-21 删 2 个未引用 keyframes | 约 32 行 | 纯清理，视觉零变化 |
| **P3** | M-08 61 处硬编码时长令牌化 | 较大 | 后续调参能全局生效（**建议分批，每批一类**） |
| **P3** | M-15 `?` 主题粒子加计数上限 | `00-core.js` 约 5 行 | 消除 `?` 主题连点掉帧 |
| **P3** | M-09 `input.sw` 4 份过渡合并为 1 份 | 3 行 | 消除互相压制 |
| **P3** | M-16 记录（不改）| — | 开关/复选框勾选动效刻意区分，仅备案 |
| **P3** | M-18 记录（不改）| — | 表格行双层反馈不冲突，仅备案 |

**最便宜的安全胜利（零视觉变化，可立刻做）：**
M-03（删死选择器）+ M-10（删死声明）+ M-13/M-14/M-17/M-19/M-21（删死代码）——
全部是"删掉永不生效的声明"，改完用真机逐主题截图对比可证明**逐像素不变**。

---

## 附录 A：36 个 `@keyframes` 全表

| 名称 | 行 | 动的属性 | 用途 |
|---|---|---|---|
| `spin` | 560 | `rotate(360deg)` | `.loading-spinner` |
| `listHeadSeam` | 964 | `opacity 0→1` | 滚动驱动列表头 |
| `fadeIn` | 1884 | `opacity` | 弹窗遮罩入场 |
| `popIn` | 1887 | `opacity + translateY(12px) scale(.97)` → 55% 过冲 → `none` | 弹窗/下拉/上传提示入场 |
| `itemIn` | 1897 | `opacity + translateY(-5px)` | 列表新条目 |
| `checkPop` | 1898 | `scale .85 → 1.18 → 1` | 勾选/档位选中 |
| `pageIn` | 1899 | `translateY(var(--shift-sm))` → 55% `-1px` 过冲 → `none` | 页面/分区/折叠体入场 |
| `slideInRight` | 1908 | `translateX(16px)` | 抽屉（**当前无引用**） |
| `breathe` | 1910 | `opacity 1 → .55 → 1` | 状态点呼吸 |
| `shimmer` | 1912 | `translateX(100%)` | 骨架微光 |
| `ddIn` | 1914 | `translateY(-7px) scale(.97)` → 55% 过冲 | 下拉（**当前无引用**） |
| `popOut` | 1943 | `translateY(10px) scale(.97)` + `opacity 0` | 弹窗退场 |
| `fadeOut` | 1946 | `opacity 1→0` | 遮罩退场 |
| `skPulse` | 3458 | `opacity .4 → .95` | 骨架柱脉动 |
| `barGrow` | 3848 | `width: 0 !important` | 进度条生长 |
| `chaosBgSpin` | 3942 | `rotate + scale + translate` 4 段 | `?` 背景漂移（18s steps(24)） |
| `chaosTrack` | 3961 | `translateY(0→140vh)` | VHS 追踪带（7s steps(14)） |
| `chaosBrandJitter` | 3972 | `translate + skewX + text-shadow` | 品牌 RGB 抖动（.9s steps(3)） |
| `chaosCutIn` | 3989 | `scale(.3) rotate(-12deg)` → `scale(1.25)` → `scale(.9)` → `none` | `?` 弹窗三帧跳切 |
| `chaosCutL` | 3997 | `translateX(-140%) skewX(-14deg)` → `4%` → `none` | `?` 左切 |
| `chaosCutR` | 3998 | `translateX(140%) skewX(14deg)` → `-4%` → `none` | `?` 右切 |
| `chaosCutY` | 3999 | `translateY(110px) scale(.5)` → `-14px scale(1.1)` → `none` | `?` 纵向跳切 |
| `chaosCheckCut` | 4000 | `scale(.1) rotate(-270deg)` → `scale(2.4) rotate(45deg)` → `scale(1)` | `?` 勾选 |
| `chaosTabHop` | 4032 | `translateY(0/-6px/+2px)` | `?` 页签蹦极（1.1s steps(3) ∞） |
| `chaosTabUnder` | 4046 | `scaleX(1/.6/1.2/.8)` + `translateX` | `?` 页签下划线（2s steps(5) ∞） |
| `chaosBlink` | 4056 | `opacity 1→.2` + `scale 1→1.7` | `?` 状态点频闪 |
| `chaosLoadSpin` | 4067 | `rotate 0→1080deg` + `scale 1→1.4→1` + 变色 | `?` 加载（1s steps(8) ∞） |
| `chaosScan` | 4079 | `translateX(-130%) skewX(-30deg)` → `250%` | `?` 骨架斜扫（.7s steps(6) ∞） |
| `chaosBtnShake` | 4100 | `rotate(±7deg) scale(1.06~1.14)` | `?` 按钮摇摆（.45s steps(4) ∞） |
| `chaosFlip` | 4108 | `rotateX(0→360deg) scale(1.1)` | `?` 主按钮翻跟斗（.6s steps(7,end)） |
| `chaosBarBoom` | 4121 | `width:0` + `scaleY(.2→2.2→1)` | `?` 进度条爆炸（.7s steps(6,end)） |
| `chaosPopFly` | 4135 | `translate(--dx,--dy) rotate(--rot) scale` 3 段 | `?` 点击粒子（.8s steps(6,end) forwards） |
| `icShake` | 4410 | `translateX(0/-3px/+3px)` | 输入校验失败抖动（.3s） |
| `banner-rise` | 5836 | `translateY(8px)` + `opacity` | 横幅入场（.22s） |
| `sl-pulse` | 7045 | `box-shadow` 橙色扩散环 | SnowLuma 等待节点（1.6s ∞） |
| `mk-spin` | 7285 | `rotate(360deg)` | 市场加载（.7s ∞） |

> 未被引用的 keyframes：`slideInRight`(1908)、`ddIn`(1914) —— 定义了但 style.css / ui/*.js 里无 `animation: … slideInRight|ddIn` 声明。

## 附录 B：复现命令

```bash
cd "C:/Users/Administrator/WorkBuddy AI/2026-10-12-21-11-32"
"C:/Users/Administrator/.workbuddy-ai/binaries/python/versions/3.13.12/python.exe" _r95/extract.py
# → rules=2059 keyframes=36，输出到 _r95/out/*.txt
```

---

*报告生成：R95 · 只审计未改动 · 所有行号均可在 `resources/app/ui/style.css`（LF / 7519 行）与 `resources/app/ui/app/*.js` 中直接定位*
