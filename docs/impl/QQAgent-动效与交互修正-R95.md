# QQAgent 洛版 v0.4.7 · 动效与交互修正落地（R95）

> 上游依据：`QQAgent-全界面动效与交互审计-R95.md`（同目录，65764 B）
> 本轮性质：**把审计报告里确认的修正项落到代码**，不改功能、不改视觉风格、不动 HTML 结构
> 目标目录：`C:\Users\Administrator\Desktop\洛版QQ-Agent-v0.4.7\resources\app\`

---

## 0. 摘要

审计报告给出 21 条发现（M-01 … M-21）。本轮把其中**有实际收益、且零风险**的 14 组改动落到代码，
其余 7 条属"一致性/美观"或"需要重新设计"的，明确列为不做（见 §6），不做静默省略。

| 项 | 值 |
|---|---|
| 改动组数 | **14 组**（R1 … R14） |
| 涉及文件 | `ui/style.css`、`ui/app/00-core.js`（`index.html` **零改动**） |
| 补丁规模 | 17 hunk / **+92 −56 行** |
| 补丁指纹 | `6b0508c59c7d5bcc1b264902926b4110`（17693 B，可复现） |
| 断言总数 | **109 项全绿**（静态 37 + 真实浏览器 72） |
| `@keyframes` | 36 → **34** |
| `cursor: not-allowed` | 8 → **13** |
| 声明 `pageIn` 的选择器 | 由「`.view.active` + `#usage-page` 双层 + 4 个死选择器」→ **恰好 3 个，全部有效** |

### 文件指纹

| 文件 | 基线 | 改后 |
|---|---|---|
| `ui/style.css` | 388221 B / 7519 行 / LF / `7ba1850769f4426d6f4b107911b19bfb` | **391729 B / 7544 行 / LF / `2350576479abf0eda1e178df53cdf637`** |
| `ui/app/00-core.js` | 57849 B / 1101 行 / CRLF / `4a7acb4753657b8c918f6f9efbf41d0a` | **58600 B / 1112 行 / CRLF / `d75ff2f1484d1e91e305e4a4b9b9e340`** |
| `ui/index.html` | 29234 B / `abdcb0a2d62c7e7133c4f8d6b02cb054` | **未改动（哈希一致）** |

---

## 1. 方法与纪律

沿用 R94 建立的四条硬纪律，本轮一条没松：

1. **按字节处理，绝不 text 模式。** 任何 `text=True` / `'r'` 读取都会把 CRLF 规范化成 LF，
   补丁随即失效并报"different line endings"。`style.css` 是 LF、`00-core.js` 是 CRLF，
   两个文件的 EOL 必须各自保持原样。
2. **每处替换必须精确命中恰好 1 次。** `apply.py` 的 `rep()` 命中 0 次或 >1 次都直接 `sys.exit(1)`
   并打印未命中的原文，不猜、不模糊匹配。
3. **先全量校验基线，再全内存替换，最后一次性落盘。** 14 组替换全部在内存里完成才写文件——
   避免上一轮出现过的"`style.css` 已落盘、JS 步骤失败"的半成品状态。
4. **落盘后自检。** 大小 / 行尾风格 / 花括号平衡三项，任一不过即报错。

本轮新增一条：

5. **验证必须带正向控制。** 只断言"某东西不存在"是弱证据（选择器写错了也会"不存在"）。
   每个"删除类"断言都配一个"同一检测器能检出确实存在的东西"的对照——
   例如验 `.model-modal-overlay` 在 reduce 下**保留**动画名，用来证明检测器不是恒返回 `none`。

### 脚本

| 脚本 | 作用 |
|---|---|
| `_r95/extract.py` | 手写 CSS 扫描器（剥注释保行号 + 花括号栈记录 `@media`/`@supports`/`@keyframes` 上下文），产出 `out/*.txt` |
| `_r95/apply.py` | 落盘脚本，14 组替换，命中数强校验 |
| `_r95/verify.py` | 静态验证，**先剥注释再断言**（37 项） |
| `_r95/browser/test.js` | Edge + puppeteer-core 真实引擎验证（72 项） |

---

## 2. 逐条修正

### R1 · M-01 · reduce 清单 7 条里 4 条是死选择器 —— **本轮收益最大的一条**

**原状**（`style.css` L342 起的 `@media (prefers-reduced-motion: reduce)` 内）：

```css
.model-modal,
.usage-card,
.tier-btn,
.toast,                    /* ← 这个类不存在 */
[class*='itemIn'],         /* ← 按类名子串匹配，真实类名不含此子串 */
[class*='popIn'],
[class*='slideIn'] {
  animation: none !important;
  transform: none !important;
}
```

**证据**：真实类名是 `new-item` / `upload-toast` / `model-dd`，都不含 `itemIn`/`popIn`/`slideIn`
子串，三条 `[class*=]` 永远不命中；`.toast` 全仓不存在（真实是 `.mk-toast` / `.upload-toast`）。

**这有多严重？** 浏览器实测正常模式下的 `animation-name`：

| 目标 | 正常模式动画 | 旧清单是否覆盖 |
|---|---|---|
| `.model-modal` | `popIn` | ✅ |
| `.modal` | `popIn` | ❌ |
| `.upload-toast` | `popIn` | ❌ |
| `.model-dd` | `popIn` | ❌ |
| `.session-item.new-item` | `itemIn` | ❌ |
| `.chat-item.new-item` | `itemIn` | ❌ |
| `.member-table tr` | `itemIn` | ❌ |
| `.collapsible[open] > *:not(summary)` | `pageIn` | ❌ |
| `.usage-card` | 无 | — |
| `.tier-btn` | 无 | — |

**8 个确实在播位移动画的目标里，旧清单只挡住了 1 个。** 另外 7 个只被通配符的
`animation-duration: 1ms !important` 压成"1 帧跳变"——位移依然发生，只是发生在 1ms 内。
对前庭功能障碍用户来说，1ms 的 12px 位移跳变和 180ms 的一样难受。

**改法**：换成 10 个真实类名（`.model-modal` / `.modal` / `.usage-card` / `.tier-btn` /
`.upload-toast` / `.model-dd` / `.session-item.new-item` / `.chat-item.new-item` /
`.member-table tr` / `.collapsible[open] > *:not(summary)`）。

> ⚠️ **刻意不含 `.model-modal-overlay`。** 它的退场靠 `.closing` 的
> `animation: fadeOut ... forwards`，一旦 `animation: none`，遮罩会**保持全不透明**
> 直到 400ms 的 JS 兜底才消失——比现在更糟。它的时长已被通配符压到 1ms，
> 那才是正确的"瞬间消失"。这条写进了代码注释，防止后人"顺手补全"。

**验证**：10 个目标在 reduce 下 `animation-name === 'none'` 且 `transform === 'none'`（20 项断言）；
正向控制——正常模式下其中 8 个确实在播动画（证明检测器有区分力）；
反向控制——`.model-modal-overlay` 在 reduce 下 `animation-name` 仍为 `fadeIn`、时长 `0.001s`。

---

### R2 · M-17 · `.dirty-glow` 空转兜底规则

**原状**：

```css
.dirty-glow,
.dirty-glow-out { background-image: none; animation: none; }
```

**证据**：`grep -rn "dirty-glow\|dirtyEls" app/` 全仓 **0 个 add/remove 调用**——
`07-settings-events.js` 的 `markDirty` 早已不再收集 `dirtyEls`，只剩说明注释。
原注释写的"JS 里仍有 add/remove 调用"**与事实不符**。

**改法**：整条删除，注释改写为准确描述，并留下警告：
> 若将来要恢复这个提示：**不要用半透明逐帧动画**，透明分层窗口下必然糊成残影。

**验证**：剥注释后 `.dirty-glow` 活动规则 = 0；含注释 = 1（说明文字）。

---

### R3 / R4 · M-12 · 关键帧内缓动写成字面量

**原状**：`@keyframes popIn` / `pageIn` 的 `0%` / `55%` 帧里直接写了
`cubic-bezier(.25, 1, .5, 1)` 和 `cubic-bezier(.34, 1.56, .64, 1)`，
而这两个值正是 `--ease-out-quart` / `--ease-spring` 的定义——**同一份曲线在文件里存了两份**。

**改法**：改成 `var(--ease-out-quart)` / `var(--ease-spring)`。
今后改令牌即可全局生效，不会再出现"令牌改了、关键帧没改"的漂移。

**验证**：剥注释后 `cubic-bezier(.34, 1.56, .64, 1)` 仅剩 1 处（令牌定义本身）、
`cubic-bezier(.25, 1, .5, 1)` 仅剩 1 处。

---

### R5 / R6 · M-21 · 两个零引用关键帧

| 关键帧 | 引用数 | 说明 |
|---|---|---|
| `@keyframes slideInRight` | **0** | 抽屉/面板滑入，从未使用 |
| `@keyframes ddIn` | **0** | 下拉落入；`.model-dd` 实际用的是 `popIn` |

**改法**：两条定义删除。

**验证**：浏览器解析出的关键帧表长度 = **34**（36 − 2）；
`slideInRight` / `ddIn` 均不在表中；正向控制——`pageIn` / `popIn` / `chaosCutY` / `chaosPopFly` 仍在。

---

### R7 · M-03 + M-04 · 页面入场：4 个死选择器 + 用量页"二次到位"

**原状**：

```css
.page, .settings-section, #usage-page, #chats-page, #settings-page {
  animation: pageIn var(--dur-slow) var(--ease-out-quart);
}
.view.active {
  animation: pageIn var(--dur-slow) var(--ease-out-quart);
}
```

**证据**：`.page` / `.settings-section` / `#chats-page` / `#settings-page`
在 `index.html` 与 `app/*.js` 里**出现次数都是 0**（设置页真身是
`#settings-form.settings-pane`，见 `index.html:280`；存档页是 `#view-chats > #chat-detail`）。

**唯一真正会命中的 `#usage-page` 是 `.view` 的子容器**——它跟着外层 `.view.active`
一起播 `pageIn`，两层同时上浮淡入，视觉上就是"二次到位"的顿挫感。

**改法**：整组塌缩为一条 `.view.active`。子容器不再自己播。

**验证**（浏览器）：
- `.view.active` → `pageIn`，时长 `0.26s`（= `--dur-slow`）✅
- `#view-usage`（非 active）→ `none` ✅
- **`#usage-page` → `none`**（R7 核心）✅
- 给 `#view-usage` 加上 `active` 后：外层 → `pageIn`，而 `#usage-page` **依旧是 `none`** ✅
- 静态：解析全表后，声明 `pageIn` 的选择器**恰好 3 个**——`.view.active`、
  `.settings-pane > *`（阶梯，保留）、`.collapsible[open] > *:not(summary)`（折叠，保留）。
  无 `#usage-page`、无任何死选择器。

> 更正审计报告 M-04 的措辞：原文建议"`#usage-page` 从 L1960 的选择器组里去掉"，
> 但 `#usage-page` 是那组里**唯一活着**的选择器，把它摘掉等于什么都没做。
> 正确做法是整组塌缩，只留 `.view.active`。

---

### R8 · M-03 + M-14 · `?` 主题入场：5 个里 4 个死选择器 + 死 `will-change`

**原状**：

```css
[data-theme='?'] .page,
[data-theme='?'] .settings-section,
[data-theme='?'] #usage-page,
[data-theme='?'] #chats-page,
[data-theme='?'] #settings-page { animation: chaosCutY .5s steps(4, end); will-change: transform; }
```

**后果**：`?` 主题下**存档页、设置页、技能页、插件页、工具页全部没有抽帧入场**，
与其它页观感不统一——这显然是当初写这组选择器想要的效果，只是没生效。

**改法**：一条覆盖全部一级页：

```css
[data-theme='?'] .view.active { animation: chaosCutY .5s steps(4, end); }
```

> ⚠️ **刻意不带 `will-change`。** `.view` 是整页大容器，永久 `will-change: transform`
> 等于永久提层，与本项目"软件渲染下避免长期提层"的铁律冲突
> （见 `input.sw` 那段的说明）。动画期间浏览器自己会提层，不需要常驻。

**验证**（浏览器）：
- `?` 主题下 `.view.active` → `chaosCutY`，时长 `0.5s` ✅
- `will-change` 计算值 = `auto`（未常驻）✅
- 正向控制——**设置页在 `?` 主题下，加 `active` 后确实开始播 `chaosCutY`**（原先完全没入场）✅
- 负向控制——设置页未加 `active` 时 = `none` ✅

---

### R9 · M-10 · `.swatch:hover` 被改造层整条覆盖

**原状**：`L3342` 有 `.swatch:hover { transform: scale(1.12); }`，
但文件后半"6. 开关"改造层的 `.swatch:hover { transform: none; }` 同特异性（0-2-0）、
源顺序更靠后，**永远生效**——前一条从未起过作用。

**改法**：删除前一条（换成说明注释），保留改造层那条。

> 注释里写明了：若确实想要放大反馈，**正确做法是删掉改造层那条 `transform: none`**，
> 而不是在前面加回来。

**验证**（浏览器）：`page.hover()` 真实悬停后 `transform === 'none'`，
悬停前后一致（`none -> none`）；正向控制——`.swatch.on` 有选中视觉（`border-color: rgb(42,128,227)`）。
静态：剥注释后 `.swatch:hover` 活动规则**恰好 1 条**，内容为 `transform: none;`。

---

### R10 · M-13 · `--ease-chaos` 死令牌

`--ease-chaos: cubic-bezier(.15, 2.2, .25, 1);` —— 全文件 **0 次引用**。
`?` 主题的动效全部走 `steps()` 抽帧，用不上贝塞尔曲线。删除。

---

### R11 · M-07 · 禁用态光标统一为 `not-allowed`

5 处 `cursor: default` → `cursor: not-allowed`：

| 选择器 | 说明 |
|---|---|
| `.mcard-trust:disabled` | 模型卡"信任"按钮 |
| `.mcard-del:disabled` | 模型卡删除按钮 |
| `.mini-btn[disabled]` | 小按钮 |
| `.sn-item.is-off` | 会话项"已关闭"态 |
| `.mk-btn:disabled` | 市场按钮 |

**验证**（浏览器）：5 个元素的 `getComputedStyle().cursor` 全部 = `not-allowed` ✅；
正向控制——未禁用元素不是 `not-allowed`（实测 `pointer`），证明没有过度施加。
静态：`cursor: not-allowed` 由 8 → **13**；`cursor: default` 仅剩 2 处源码
（`.win-btn` 与 `.chat-status .session-status`）。

> 附注：`.win-btn` 的 `cursor: default`（L670）实际上被皮肤层 L5293 的
> `cursor: pointer` 覆盖，运行时是 `pointer`。源码计数与实际计算值不是一回事，
> 浏览器验证里已避开这个坑。

---

### R12 · M-06（更正后）· 4 个输入框被基础规则压掉了焦点环

> **先更正审计报告的一处判断错误。** 报告 M-06 原写"20 个关键可交互元素没有焦点环"，
> 这是**错的**。复核 `style.css` L3314-3318 发现有一条全局兜底：
> ```css
> :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
> ```
> 它覆盖了全站绝大多数元素。**真正被压掉的只有 4 个输入框**——
> 它们在**基础**规则里写了 `outline: none`，与 `:focus-visible` 同特异性（0-1-0）
> 但源顺序更靠后，于是把焦点环整个抹掉；各自的 `:focus` 只把边框改成 `--muted`
> （低对比度，键盘用户几乎看不见）。

**改法**：在文件**末尾**补回焦点环（必须写在它们之后才能生效）：

```css
.fi-adapt-input:focus-visible,
.mig-input:focus-visible,
.fix-card textarea:focus-visible,
.fix-input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

**验证**（浏览器）：4 个元素程序化聚焦后 `el.matches(':focus-visible') === true`，
`outline-style === 'solid'`、`outline-width === '2px'`（12 项断言）。

---

### R13 · 新增 · `?` 主题点击粒子无上限

**原状**（`00-core.js`）：每次点击爆 3~5 个 `.chaos-pop`，850ms 后回收，**没有任何节流**。

**问题**：每个粒子都是 `position: fixed` + `will-change: transform, opacity`
（见 `style.css` 的 `.chaos-pop`）——**每个粒子都是一个常驻合成层**。
在 `?` 主题下快速连点 50 次会瞬间堆出约 200 个常驻合成层，合成器按不住，
表现为连点期间掉帧——正是"看着像闪了一下"的来源之一。

**改法**：加上"在飞粒子"上限：

```js
const CHAOS_POP_MAX = 48;
let chaosPopAlive = 0;
document.addEventListener('click', (e) => {
  if (document.documentElement.getAttribute('data-theme') !== '?') return;
  if (chaosPopAlive >= CHAOS_POP_MAX) return;
  const n = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    /* …原样… */
    document.body.appendChild(el);
    chaosPopAlive++;
    setTimeout(() => { el.remove(); chaosPopAlive--; }, 850);
  }
}, { passive: true });
```

上限取 48 的理由：单击最多爆 5 个，48 足够容纳任何正常操作节奏，
只有"按住连点"才会被截流；被截流时**只少几个装饰粒子**，不影响任何功能。

**验证**（浏览器，从真实 `00-core.js` 提取 933 字节代码块注入）：
- 60 次连续点击后，在飞粒子数 = **48** ✅
- 理论上限推导：守卫在**生成前**判断，故最大 = 47 + 5 = 52，实测 48 ✅
- 无上限时应为 180~300，实测 48 ✅
- 正向控制——起始无残留粒子；粒子数 ≥ 48 证明 handler 确实在跑（不是"因为没生效所以为 0"）

---

### R14 · M-03 · `.settings-section` 阶梯入场块（9 条规则）

**原状**（`style.css` 基线 L1571-1585）：8 条 `--i` + 1 条 `animation`，
R91 加的，注释写"阶梯入场扩展到设置分区"。

**证据**：`.settings-section` 在 `index.html` 与 `app/*.js` 里**引用数为 0**——
设置页真身是 `#settings-form.settings-pane`（`index.html:280`）。R91 加它时应该是照着旧结构写的。

**改法**：整块删除（换成说明注释）。真正生效的阶梯是 `.settings-pane > *`，保留。

**验证**：静态——剥注释后 `settings-section` 活动规则 = 0；
浏览器——`@keyframes` 之外，解析表里不存在任何含 `settings-section` 的选择器。

---

## 3. 验证证据

### 3.1 静态验证（37 项，0 失败）

`_r95/verify.py`，日志 `_r95/browser/static-verify.log`。

关键机制：**先剥 CSS 注释再断言**（注释用等长空格替换，保留 `\r\n` 与行号）。
不这么做会出现假失败——例如 R9 的说明注释里就写着 `.swatch:hover { transform: scale(1.12) }`，
R14 的注释里写着 `.settings-section`，直接字符串计数会把它们当成"没删干净"。

覆盖：文件指纹 / 花括号平衡 2113:2113 / 无裸 LF / `index.html` 哈希未变 /
`@keyframes`=34 / 死选择器归零 / 死令牌归零 / `.swatch:hover` 唯一 /
`pageIn` 声明者分析 / reduce 清单整块精确匹配 / 光标计数 / 焦点环块 / JS 计数变量。

### 3.2 浏览器验证（72 项，0 失败）

`_r95/browser/test.js`，日志 `_r95/browser/browser-verify.log`。
**Edge `Edg/155.0.4283.45`** + `puppeteer-core@25.13.0`（headless）。

设计：样式表用 `addStyleTag` 注入**真实文件字节**（避开中文路径 URL 编码问题）；
测试页 DOM 忠实复刻真实结构（被测的 `.swatch` / `.collapsible` / `.member-table` /
`.chaos-pop` 等类在真机上都由 JS 生成，不在静态 HTML 里）。

| 组 | 内容 | 项数 |
|---|---|---|
| A | 解析完整性：1956 条样式规则、无空选择器、关键帧表 | 7 |
| B | R7 页面入场（含正/负向控制） | 8 |
| C | R9 色板悬停 | 3 |
| D | R1 reduce 模式（10 目标 × 2 属性 + 3 控制） | 23 |
| E | R11 禁用光标（5 + 1 控制） | 6 |
| F | R12 焦点环（4 × 3） | 12 |
| G | R8 `?` 主题入场（含负向控制） | 7 |
| H | R13 粒子上限（含提取自真实 JS 的代码块） | 5 |

### 3.3 补丁验证（双向逐字节）

```
正向：基线 + r95-fixes.patch  →  md5 2350576479abf0eda1e178df53cdf637  ✔ 与改后一致
反向：改后 − r95-fixes.patch  →  md5 7ba1850769f4426d6f4b107911b19bfb  ✔ 与基线一致
可复现：两次独立生成补丁逐字节相同（cmp 通过，md5 6b0508c59c7d5bcc1b264902926b4110）
```

CRLF 未被打乱：`00-core.js` 正反两向 md5 均精确复原——若行尾被规范化，这一步必然失败。

---

## 4. 收益量化

| 指标 | 前 | 后 | 说明 |
|---|---|---|---|
| reduce 下真正"不位移"的元素 | **1 / 8** | **8 / 8** | R1；前庭功能障碍用户的直接体验 |
| 页面入场播放层数（用量页） | 2 层（二次到位） | **1 层** | R7 |
| `?` 主题有入场的一级页 | 6 / 11（4 个死选择器 + 漏网） | **11 / 11** | R8 |
| 零引用关键帧 | 2 | **0** | R5/R6 |
| 死令牌 | 1 | **0** | R10 |
| 空转规则块 | 2 块（`.dirty-glow` / `.settings-section`） | **0** | R2/R14 |
| `?` 主题连点峰值合成层 | ~200 | **≤ 52** | R13 |
| 禁用态光标一致性 | 8/13 | **13/13** | R11 |
| 键盘焦点环缺口 | 4 个输入框 | **0** | R12 |

---

## 5. 交付物

| 文件 | 位置 | 说明 |
|---|---|---|
| `QQAgent-动效与交互修正-R95.md` | 本文件 | 落地报告 |
| `r95-fixes.patch` | 同目录 | 17 hunk / +92 −56 / 17693 B |
| `QQAgent-全界面动效与交互审计-R95.md` | 同目录 | 上游审计（65764 B） |
| `r95_apply.py` / `r95_verify.py` / `r95_browser_test.js` | 同目录 | 复现脚本 |
| `r95-static-verify.log` / `r95-browser-verify.log` | 同目录 | 验证日志 |
| `_backup-r95-20261012-223029/` | 项目根 | 改动前备份（2 文件） |

### 复现命令

```bash
# 1) 静态验证（37 项）
python r95_verify.py

# 2) 浏览器验证（72 项，需要 Edge）
node r95_browser_test.js

# 3) 从基线重新应用（在 resources/app 下）
patch -p1 --binary < r95-fixes.patch

# 4) 反向回滚（在 resources/app 下）
patch -p1 -R --binary < r95-fixes.patch

# 5) 从备份直接回滚
cp _backup-r95-20261012-223029/ui/style.css        resources/app/ui/style.css
cp _backup-r95-20261012-223029/ui/app/00-core.js   resources/app/ui/app/00-core.js
```

> `patch -p1` 而非 `-p0`：补丁头是 `a/ui/...` → `b/ui/...`，`-p1` 正好剥掉一层。

---

## 6. 本轮明确不做

以下 7 条来自审计报告，**有意不做**，不是遗漏：

| 编号 | 内容 | 不做的理由 |
|---|---|---|
| M-02 | `--lift` / `--lift-sm` 在 dark/light 下透明 | R83 的**有意设计**，改了会破坏已定稿的视觉 |
| M-05 | 给另外 8 个控件补 `:active:not(:hover)` 取消回弹 | 需要逐个定曲线，属"手感设计"，宜单独一轮 |
| M-08 | 61 处硬编码时长迁到令牌 | 纯一致性收益，改动面大（跨 61 处），建议**按类分批**做 |
| M-09 | 合并 4 处重复的 `input.sw` transition | 需要重排皮肤层顺序，风险与收益不成比例 |
| M-11 | `?` 主题 28 处 `steps()` 参数不统一 | 抽帧感是刻意的"不统一"，统一了反而不抽象 |
| M-15 | 9 处 `will-change` 中 3 处可能常驻 | 需逐个判断是否真常驻，宜配合性能采样做 |
| M-16 | 148 处 `:hover` 中约 30 处时长未走令牌 | 同 M-08，随 M-08 一起做 |

### 仍未处理的历史 backlog（与动效无关，需另开一轮）

| 编号 | 内容 | 前置条件 |
|---|---|---|
| BUG-07 | 符号级崩溃定位 | 需要该 build 的 **PDB** + `cdb`/WinDbg |
| BUG-08 | `hotReload: true` 默认值 | 需确认作者意图（默认开热重载是刻意的还是笔误） |
| UI-06 / 23 / 27 | 皮肤层遗留 | 需先定稿皮肤规范 |
| R78-8 | `saveChat` 仅追加 | 涉及数据写入语义，需作者决策 |

---

## 7. 结论

审计报告里**有实际收益、且零风险**的 14 组改动已全部落地，109 项断言（静态 37 + 真实浏览器 72）
全绿，补丁双向逐字节可逆、可复现。

`index.html` 零改动，无新增依赖，无功能变更，无视觉风格变更——
纯"让已经写下的意图真正生效"。

最大的两条实质收益：
1. **reduce 模式从"只挡住 1/8"变成"挡住 8/8"**（R1）——对前庭功能障碍用户是真实的可访问性改善；
2. **用量页入场从 2 层变 1 层**（R7）——消除了用户可感知的"二次到位"顿挫。

其余 7 条审计发现与 4 条历史 backlog 已列明不做理由与前置条件，可据此排下一轮。
