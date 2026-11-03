# QQAgent 洛版 v0.4.7 · 左栏线框清除 + 输入框焦点反馈（R97）

> 起因：用户对「会话选择」全屏页截图圈出左栏 ——「注意周围的一圈线框，可以美化一下」。
> 目标目录：`C:\Users\Administrator\Desktop\洛版QQ-Agent-v0.4.7\resources\app\`

---

## 0. 摘要

用户看到的「一圈线框」是一个**真实的缺陷**，不是审美问题：

左栏 `#session-list` 有一条 r34 时期留下的「平铺」覆写，注释白纸黑字写着
「无背景 / 无投影 / 无圆角」，但**四条里漏了描边** —— 皮肤层给 `.list-pane` 设的
`border: 1px solid var(--line)` 没被清掉。底色既然已经清成 `transparent`，
那圈 1px 直角描边就成了**这一栏唯一还看得见的东西**：一根方框把整栏围在页面底色上。

顺着「输入框反馈」这条线又挖出一个**更严重的问题**：R95 那一轮补的
4 条 `:focus-visible` 焦点环，**只有 1 条真正生效**。另外 2 条（挂在
`<input type="text">` 上的 `.fi-adapt-input` / `.mig-input`）一直是**死的** ——
被皮肤层一条特异性更高的规则压掉了。本轮一并修好。

| 项 | 值 |
|---|---|
| 改动组数 | **3 组**（B1 线框 / B2 搜索框 / B3 焦点环） |
| 涉及文件 | `ui/style.css`（`index.html` 与全部 JS **零改动**） |
| 补丁规模 | **+57 −7 行** / 7364 B / 3 个 hunk |
| 补丁指纹 | `f3a20393457ed623503240572f3575af`（正向 + 反向 + 可复现，三重校验） |
| 断言总数 | **133 项全绿**（静态 70 + 真实浏览器对照实验 63） |
| 附带取证 | 真实 Tab 键探针：不可见 **9/16 → 6/16**；三族归因实验定案 |

### 文件指纹

| 文件 | 改前（R96 终点） | 改后（R97） |
|---|---|---|
| `ui/style.css` | 393391 B / 7564 行 / LF / `ff2f337396f19eb656e8cd5091219aed` | **397939 B / 7614 行 / LF / `9b048338e9c39fb2d2116a2cbf4f3fda`** |
| `ui/index.html` | 29234 B / `abdcb0a2d62c7e7133c4f8d6b02cb054` | **未改动（哈希一致）** |
| `ui/app/14-chrome.js` | 67714 B / `4e74848cdf0080ba97404aba4ea94334` | **未改动（哈希一致）** |
| `ui/app/15-chat-chrome.js` | — / `6ed4342bc9a7…` | **未改动（哈希一致）** |

---

## 1. B1 · 那一圈线框：根因

### 病灶

`style.css` 里那条把左栏「平铺」的规则（改前 L6212）：

```css
/* ⚠️ 照原型 .bp-left 把左栏**平铺**：… 无背景 / 无投影 / 无圆角 … */
.bp-mode-chat > #session-list {
  width: 262px;
  background: transparent;
  border-radius: 0;
  box-shadow: none;
}
```

注释声称「无背景 / 无投影 / 无圆角」，代码也确实清了这三样 —— **但没清描边**。
于是皮肤层那条 `.list-pane { border: 1px solid var(--line) }` 原样存活。

**为什么偏偏这一处这么显眼？** 三个因素叠加：

1. **底色是透明的** —— 其余面板有底色时，描边只是「面的边缘」；这里没有面，
   描边就成了**唯一的可见物**，一根悬空的方框。
2. **直角** —— 本页其余的面都是圆角（右栏 `.bp-card` 5px、搜索框 5px、圆点导航 5px），
   一根 1px 直角方框在一堆圆角里格外扎眼。
3. **右边多凸 10px** —— 本栏在「滚动条贴边」名单里（L2836 `scrollbar-gutter: stable`），
   内容盒右侧留了 ≈10px 滚动条槽，而描边画在**边框盒**上，
   右竖线比内容右缘再外凸 10px，整圈看着更歪。

对照原型：`QQAgent-主界面原型-v2.html` 第 552-555 行 `.bp-left` 只有
`width / flex / overflow / padding`，**没有任何 border** —— 这圈描边纯属实现时的遗漏。

### 修法

```css
.bp-mode-chat > #session-list {
  width: 262px;
  background: transparent;
  border: 0;                 /* ← r97 补上 */
  border-radius: 0;
  box-shadow: none;
}
```

只加一行 `border: 0`，其余三行原样不动（平铺语义未变）。同时在注释里写清了
漏项原因与那三条「为什么显眼」的分析，避免后人再把这一行删掉。

### 唯一的几何副作用（已量化并断言）

`box-sizing: border-box` 下，去掉 1px 描边**不改边框盒宽度**（仍 262px），
但内容盒会**长 2px** —— 于是栏内所有流式子元素宽度统一 **+2px**：

| 元素 | 改前 | 改后 | 差 |
|---|---|---|---|
| `#session-list`（边框盒） | 262 | 262 | **0** |
| `.bp-search` | 246 | 248 | +2 |
| 搜索框内 `input` | 244 | 246 | +2 |
| `.bp-nav` | 250 | 252 | +2 |
| `.bp-act` | 250 | 252 | +2 |
| `.bp-empty` | 250 | 252 | +2 |
| 绝对定位的放大镜 / 清空按钮 | — | — | **0**（不参与流式布局） |

这是**本轮唯一预期的几何变化**，已写成显式断言（C5–C10），
并在逐值差分里对每个栏内元素逐一核对 —— 没有任何非预期的宽度漂移。

---

## 2. B2 · 搜索框美化（4 处）

改前 `.bp-search` 是**一个空心方框**：

```css
/* 改前 */
.bp-search {
  background: var(--page-bg);              /* ① 和父容器同色 → 没有"面" */
  border: 1px solid var(--line);           /* ② 最弱一档描边（.07） */
  box-shadow: 0 1px 3px rgba(0,0,0,.16);   /* ③ 全站唯一带投影的输入框 */
  /* ④ 没有任何焦点态 */
}
```

四处问题：

| # | 问题 | 修法 |
|---|---|---|
| ① | 底色 = `--page-bg`，**和它自己的父容器同色** —— 整个框是"空的"，只剩一圈描边 | → `--field-bg`（`#1d1e23`），比页面底色亮一档，框有了"面" |
| ② | 描边用 `--line`（.07），是令牌注释里专门留给「**面的** 1px 描边」的最弱一档 | → `--line-str`（.15），令牌注释写的是「**控件**描边（要更清楚）」 |
| ③ | 全站唯一给输入框加投影的地方 —— 与 R82/R83 皮肤层确立的「静态面不再浮起」相矛盾 | → 去掉 `box-shadow`，把投影让给焦点环 |
| ④ | **零焦点反馈** —— `.bp-search input` 同时写了 `border: 0` 和 `outline: 0`，皮肤层那条 `:focus { border-color: var(--accent) }` 只换颜色、宽度是 0，根本画不出来 | → 补 `:focus-within`（accent 描边 + `--accent-soft` 3px 光晕），取值与全站 `.mk-search input:focus` 对齐 |

```css
/* 改后 */
.bp-search {
  position: relative; height: 40px; margin-bottom: 6px;
  display: flex; align-items: center;
  background: var(--field-bg); border: 1px solid var(--line-str); border-radius: 5px;
  box-shadow: none;
  transition: border-color var(--dur-base) var(--ease-in-out),
              box-shadow  var(--dur-base) var(--ease-in-out);
}
.bp-search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
```

**为什么用 `:focus-within` 而不是 `:focus`？** 搜索框里还有放大镜和「清空」按钮。
焦点落在清空按钮上时，容器同样应该点亮 —— 这是「整个搜索槽获得焦点」的语义。
已写成断言 B12（聚焦清空按钮 → 容器点亮）。

**没有动的地方**：外层 `#cc-search-wrap` 仍保持 `background: var(--page-bg)` + `sticky`
（断言 2-17/2-18）。它是滚动挡板 —— 会话列表滚上去时要被它挡住，
底色必须是页面底色；改它会把挡板弄成半透明，滚动时露出底下的会话项。

设计过程并排渲染了 5 个变体（`r97-variants.png` / `r97-search-zoom.png` /
`r97-search-zoom2.png`）后才定稿。

---

## 3. B3 · 顺带挖出：R95 的焦点环 4 条里死了 3 条

R95（R12）在文件末尾补过一段「键盘可达性」焦点环：

```css
/* 改前（R95 版） */
.fi-adapt-input:focus-visible,
.mig-input:focus-visible,
.fix-card textarea:focus-visible,
.fix-input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

那段注释的自我诊断是：「基础规则写了 `outline: none`，特异性与 `:focus-visible`
相同（0-1-0）、源顺序更靠后，于是把焦点环抹掉」。**这个诊断只对了一半。**

真正压掉焦点环的是**皮肤层第 5570 行**：

```css
/* style.css L5570，皮肤层，本轮未改动 */
input[type='text']:focus,
input[type='number']:focus,
input[type='password']:focus,
… {
  outline: 0;                    /* ← 它自己就写着 outline: 0 */
  border-color: var(--accent);
  box-shadow: none;
}
```

特异性算术：

| 选择器 | 特异性 | 结果 |
|---|---|---|
| `input[type='text']:focus`（皮肤层 L5570） | **(0,2,1)** | 赢 |
| `.fi-adapt-input:focus-visible`（R95） | **(0,2,0)** | **输 → 焦点环画不出来** |
| `.mig-input:focus-visible`（R95） | **(0,2,0)** | **输 → 焦点环画不出来** |
| `.fix-card textarea:focus-visible`（R95） | (0,2,0) | 赢 —— textarea 的全局 focus 只有 (0,1,1) |
| `.fix-input:focus-visible`（R95） | (0,2,0) | 赢 —— **侥幸**，见下 |

所以 4 条里：**2 条死**（`.fi-adapt-input` / `.mig-input`），
1 条本就生效（`.fix-card textarea`），1 条侥幸活着（`.fix-input`）。

> **`.fix-input` 为什么侥幸活着？** 它的真实标记是 `<input class="fix-input">`，
> **没有 `type` 属性**。属性选择器 `input[type='text']` 看的是「属性在不在」，
> 不匹配它 —— 于是皮肤层那条压不到它，`.fix-input:focus-visible` 得以存活。
> 这不是设计，是运气。（我第一版探针擅自给它补了 `type="text"`，
> 反而把它误判成"坏"的 —— 教训记在第 6 节。）

### 修法

只给前两条各加一个 `input` 类型选择器，把特异性从 (0,2,0) **提到 (0,2,1)**，
与皮肤层那条**打平**；本块在文件最末尾，同分靠源顺序取胜 → 焦点环恢复：

```css
/* 改后（R97） */
input.fi-adapt-input:focus-visible,
input.mig-input:focus-visible,
.fix-card textarea:focus-visible,
.fix-input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

**约束**：本块必须保持是**文件最后一条规则** —— 同分靠源顺序取胜的前提就是它。
已写成断言（3-15「该焦点环块仍是文件最后一条规则」）。

**没有改皮肤层源码**：L5570 那条 `outline: 0` 逐字节保留（断言 3-2/3-3），
本轮靠特异性覆盖，不是删源码 —— 这样皮肤层对其他元素的行为完全不受影响。

---

## 4. 统一病因：为什么全站输入框的焦点反馈普遍失效

修 B3 时发现这不是孤立问题，而是**一条系统性缺陷**。定案的三个环节：

### 环节① —— 所有 input 的描边宽度被清零

```css
/* style.css L389，文件很靠前 */
button,
input:not([type='checkbox']):not([type='radio']),
select,
textarea { border: none; }
```

`input:not([type='checkbox']):not([type='radio'])` 的特异性是 **(0,2,1)** ——
比绝大多数类规则还高。**每一个** input 的描边宽度都被它清零了。

### 环节② —— 皮肤层的焦点反馈只剩「换描边颜色」

L5570 那条 `:focus` 只做 `border-color: var(--accent)`，而描边宽度是 0
（被环节①清零）→ **换一个 0 宽描边的颜色 = 什么都看不见**。

### 环节③ —— 各族想补光晕时，全部撞墙

| 族 | 自己的 `:focus` | 特异性 | 结局 |
|---|---|---|---|
| `.qa-input` | L4505 有，补 `box-shadow` 光晕 | (0,2,0) | 被皮肤层 (0,2,1) **压掉**（特异性） |
| `.model-rows-table input` | L1740 有，补 `box-shadow` 光晕 | (0,2,1) | 同分但**更早**，被皮肤层**压掉**（源顺序） |
| `.ic-input` | **没有** `:focus` 规则 | — | 压根没补 |

### 归因实验（`probe-focus3.js`，真实 Tab 键驱动）

| 用例 | 操作 | 结果 | 结论 |
|---|---|---|---|
| A1 | `.qa-input` 现状 | ✘ 画不出来 | — |
| A2 | 同名 `.qa-input:focus`（0,2,0）**追加到文件末尾** | ✘ **仍画不出来** | 病因 = **特异性** |
| A3 | 提权 `input.qa-input:focus`（0,2,1）追加到末尾 | ✔ **立刻画出** | 修法方向对 |
| B1 | `.model-rows-table input` 现状 | ✘ 画不出来 | — |
| B2 | 同名 `.model-rows-table input:focus`（0,2,1）追加到末尾 | ✔ **立刻画出** | 病因 = **源顺序** |
| C1 | `.ic-input` 现状 | ✘ 画不出来 | — |
| C2 | 提权 `input.ic-input:focus`（0,2,1）追加到末尾 | ✔ **立刻画出** | 病因 = **缺规则** |
| D1 | `.ic-input` + `input.ic-input{border:1.5px solid green}`（0,1,1） | ✘ 仍 0px | 坐实环节①：**(0,1,1) 压不过 L389 的 (0,2,1)** |
| D2 | `.ic-input` + `input[type="text"].ic-input{…}`（0,2,1） | ✔ 描边回来 | 必须 ≥ (0,2,1) 才能重新加描边 |

A2 vs A3 是**关键对照**：同一份规则，只差一个 `input.` 前缀，
放到**同一个位置**（文件末尾），一个不画一个画 —— 差异只能来自特异性，不可能来自源顺序。

**修法模板（已在本轮验证两次）**：给 `:focus` 规则加类型选择器把特异性提到 (0,2,1)，
或改用 `:focus-within` 挂在外层容器上（本轮 B2 用的就是后者）。

---

## 5. 故意没动的地方（护栏）

### `.sidebar > .list-pane`（主窗口左栏，L5993）

它**长得几乎一模一样** —— 也是 `background: transparent` + 存活下来的
`border: 1px solid var(--line)`。但**不能一起改**：

```css
.sidebar > .list-pane {
  background: transparent;
  border-radius: var(--r);        /* ← 保留了圆角 */
  …
}
```

它**明确保留了 `border-radius: var(--r)`**。一个圆角描边只有在**有描边时才有意义** ——
保留圆角就等于声明「这条描边是故意的」。而 `.bp-mode-chat > #session-list`
把 `border-radius` 设成了 `0`（彻底压平），说明它压根没打算要描边。

两处的差异恰好就是 `border-radius: 0` vs `var(--r)`。所以**只改聊天模式那一栏**。
已在渲染图 `r97-mainwin.png` 里确认主窗口左栏的圆角描边正常，并写成护栏断言
（静态第 4 节 5 项 + 浏览器 D 组）—— 防止后人「顺手」把主窗口也清了。

### 其余不动项

- 皮肤层 L5570 的 `outline: 0` —— 逐字节保留（靠特异性覆盖，不删源码）
- `#cc-search-wrap` 的 `--page-bg` + `sticky` —— 滚动挡板语义
- 皮肤层 `.list-pane { border: 1px solid var(--line) }`（L5325）—— 同上
- 所有 `@keyframes`（34 条，数量未变）

---

## 6. 验证证据

### 静态断言 70 项全绿（`verify.py`）

分 8 节：文件完整性 / B1 / B2 / B3 / 回归护栏 / 令牌存在性 / 反向对照 / 未越界。

其中几条值得单独说：

- **证明问题真实存在**：断言 1-3 检查**备份**里那条规则**没有**清描边 ——
  即先用基线证明缺陷存在，再用现盘证明已修，而不是只测「现在有 `border: 0`」。
- **皮肤层零改动**：断言 3-3 逐字节比对 L5570 那条规则与备份完全相同。
- **令牌阳性对照**：断言 5-8 查一个**不存在**的令牌必须查不到，
  证明前面 7 条令牌断言不是恒真。
- **反向对照**：断言 6-1/6-2 确认被删掉的旧投影 `0 1px 3px rgba(0,0,0,.16)`
  和 `.bp-search` 里的 `--page-bg` 已从非注释代码中消失。

### 浏览器断言 63 项全绿（`browser.js`，真实 Edge）

分 7 组，全部跑在**真实渲染的 Edge** 上，不是静态解析：

| 组 | 内容 | 关键数据 |
|---|---|---|
| A | **备份 CSS 对照**（问题应真实存在） | A7：备份里聚焦搜索框 → **零视觉变化** |
| B | 现盘 CSS（问题应消失） | B9 `border-color: rgb(61,139,253)`；B10 `rgba(61,139,253,.16) 0 0 0 3px` |
| C | 几何 / 同栏元素零回归 | C3 边框盒仍 262px；C5–C10 每个 +2px 逐一核对 |
| D | 逐值差分（现盘 vs 备份） | 每个栏内元素差异全部在预期内 |
| E | 过渡断言（不杀过渡的页面） | E4 对照：备份 `all 0s ease` → 现盘 `border-color, box-shadow 0.18s cubic-bezier(.4,0,.2,1)` |
| F | **注入反转自证**（检测器灵敏度） | F1 人为加回 1px 红框 → 检测器抓到 |
| G | B3 焦点环（真实 Tab 键） | G-fi-1 改前 `none/0` → G-fi-2 改后 `solid/2` |

**E 组必须用「不杀过渡的页面」单独测**：探针为了稳定测量会注入
`transition: none !important`，那样就测不到过渡本身 —— 所以过渡断言另起一页。

**F 组是检测器的自证**：人为把缺陷（1px 红框 / 改错的底色）注回去，
如果检测器抓不到，说明前面的「已修」断言可能是恒真的。抓到才算数。

### 附带取证：真实 Tab 键探针（`probe-focus-tab.js`）

16 个输入族逐一用**真实 `Tab` 键**驱动焦点，判定「聚焦是否肉眼可见」：

| | 改前（备份 CSS） | 改后（现盘 CSS） |
|---|---|---|
| 不可见 | **9 / 16** | **6 / 16** |
| 修好的 | — | ① `.bp-search input`、⑤ `.fi-adapt-input`、⑥ `.mig-input` |

（净改善 3 个 —— 正好是本轮修的 3 处。）

### 本轮踩过的三个探针陷阱（方法论，值得记）

1. **`el.focus()` 不触发 `:focus-visible`** —— Chromium 对脚本发起的焦点通常
   不匹配 `:focus-visible`。我前两版探针用 `el.focus()`，把 R95 那批修复
   **误判成"无反馈"**，差点冤枉了 R95。必须用 `page.keyboard.press('Tab')` 走真实键盘路径。
2. **属性选择器看的是「属性在不在」，不是语义** —— 我擅自给 `.fix-input`
   补了 `type="text"`，于是 `input[type='text']:focus` 意外命中，把它误判成"坏"的。
   真实标记是 `<input class="fix-input">`，**没有 type 属性**。标记必须逐字符照抄真实 DOM。
3. **静态容器的投影会被误读成焦点变化** —— `.bp-search` 原本有个**常驻**投影，
   我第一版「容器有投影 ≠ none 就算可见」的判据，在备份 CSS 下也判它"可见"。
   必须在**聚焦前**先取一次容器的静态值，只认真正的增量。

> 三条教训指向同一件事：**当"修复不生效"时，先怀疑测量工具，再怀疑修复本身。**

---

## 7. 遗留待办：还有 6 个输入族没有可见焦点反馈

第 4 节的系统性缺陷**没有在本轮全部修完**（超出用户这一轮的请求范围），
剩余部分已量化：

- **真实 Tab 键实测**：16 个族里仍有 **6 个**聚焦后零视觉变化 ——
  `.qa-input`、`.ic-input`、`.model-rows-table input`、`.forge-input textarea`、
  `.tp-row .tp-num`、裸 `input[type='text']`。
- **源码普查**（`probe-inputs2.js`）：`app/*.js` 里共 **211** 处
  `input/textarea/select` 标记 → 去重 **63 种**签名（含祖先上下文）；
  其中 **17 种签名 / 206 个标记中的 51 个**没有可见焦点。

这些是**同一类缺陷**（都是第 4 节那条链路的受害者），修法模板本轮已两次验证。
但涉及面较广（跨 10+ 个 JS 文件产出的控件），建议**单开一轮**统一处理，
而不是塞进 R97。

**另有一条未决问题**（R96 提出、仍待作者确认）：
「会话选择」作为分区标题却与子分区同款（`.bp-sec`，12px / weight 400 / opacity .6），
是否要给该栏第一行单独提权（weight 600 / opacity 1）—— 属信息层级设计，需作者拍板。

---

## 8. 复现命令

```bash
# 应用 / 反向回滚（在 resources/app 下执行）
patch --binary -p1    -i r97-fixes.patch
patch --binary -p1 -R -i r97-fixes.patch

# 从备份直接回滚
cp _backup-r97-20261012-231646/resources/app/ui/style.css resources/app/ui/style.css

# 验证
python  _r97/verify.py                              # 静态 70 项
node    _r97/browser.js                             # 浏览器 63 项（需 Edge）
CSS_SRC=bak node _r97/probe-focus-tab.js            # Tab 焦点探针（改前）
CSS_SRC=cur node _r97/probe-focus-tab.js            # Tab 焦点探针（改后）
node    _r97/probe-focus3.js                        # 三族归因实验
node    _r97/probe-ba.js                            # 生成改前改后对照图
```

> 运行 node 脚本需设 `NODE_PATH=C:\Users\Administrator\.workbuddy-ai\binaries\node\workspace\node_modules`

### 产物清单（`_r97/`）

| 文件 | 说明 |
|---|---|
| `r97-fixes.patch` | 补丁，7364 B / `f3a20393457ed623503240572f3575af` |
| `r97-static-verify.log` | 静态 70 项日志 |
| `r97-browser-verify.log` | 浏览器 63 项日志 |
| `r97-patch-verify.log` | 补丁三重校验日志 |
| `r97-focus-tab-before.log` / `-after.log` | Tab 焦点探针改前改后 |
| `r97-focus3.log` | 三族归因实验 |
| `r97-before-after.png` | **改前改后对照图**（3 行：线框 / 搜索框焦点 / 焦点环） |
| `r97-before.png` / `r97-after.png` | 单帧截图 |
| `r97-mainwin.png` | 主窗口左栏（护栏：圆角描边应保留） |
| `r97-variants.png` / `r97-search-zoom*.png` | 设计变体比选 |
| `_backup-r97-20261012-231646/` | 改动前备份（在项目根） |

---

## 9. 结论

用户圈的「那一圈线框」是**一条真实缺陷**：平铺覆写清了三样、漏了第四样
（描边），而底色透明让这圈描边成了唯一可见物。加一行 `border: 0` 修好。

顺这条线挖出的**更严重的问题**是：R95 补的 4 条焦点环里 **3 条不生效**，
原因是特异性算术 —— 皮肤层 `input[type='text']:focus` (0,2,1) 压掉了
`.fi-adapt-input:focus-visible` (0,2,0)，而且它自己就写着 `outline: 0`。

再往下追，发现这是**一条系统性缺陷**：文件前部一条 (0,2,1) 的
`input:not(...){border:none}` 清零了所有 input 的描边，
而皮肤层的焦点反馈**只剩**"换描边颜色" → 全站输入框的焦点反馈普遍画不出来。
本轮用归因实验把这条链路完整定案，并验证了修法模板（提特异性 / 用 `:focus-within`）。

3 组改动全部落在「补齐遗漏」上，没有新造任何视觉语言，没有改任何 JS 与 HTML。
133 项断言全绿（含备份 CSS 对照 + 注入反转自证），补丁双向逐字节可逆、可复现。
剩余 6 个输入族的问题已量化，建议单开一轮。
