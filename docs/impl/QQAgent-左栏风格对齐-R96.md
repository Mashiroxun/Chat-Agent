# QQAgent 洛版 v0.4.7 · 会话设置左栏风格对齐（R96）

> 起因：用户指出「会话设置」全屏页左栏（`选择会话` / `扩展` / `全部设置` 那一栏）
> 与整体风格不符。
> 目标目录：`C:\Users\Administrator\Desktop\洛版QQ-Agent-v0.4.7\resources\app\`

---

## 0. 摘要

先说结论：**不是"这一栏设计得不好"，而是它漏了一次版本同步。**

会话设置页左栏（`#bp-setup-left`）和聊天模式页左栏（`#cc-left` / `#cc-actions`）
用的是**同一批类名**（`.bp-sec` / `.bp-nav` / `.bp-nav-t` / `.bp-act` / `.bp-radio`），
但 r34 / r91 那套「逐值照原型」的覆写当时只加给了聊天模式那一栏，
会话设置这一栏没拿到 —— 于是**同一个 `.bp-act` 在两页呈现不同**。

另外发现一个图标抄漏：「打开完整设置页」只抄了齿轮的**第一段 path**（内圆），
15px 下渲染成 4.4px 的小圈，看着像个列表圆点。

| 项 | 值 |
|---|---|
| 改动组数 | **6 组**（S1–S4 + J1–J2） |
| 涉及文件 | `ui/style.css`、`ui/app/14-chrome.js`（`index.html` **零改动**） |
| 补丁规模 | **+30 −5 行** / 6014 B |
| 补丁指纹 | `f90a241cd9f602a623880635ba389489`（可复现） |
| 断言总数 | **52 项全绿**（静态 25 + 真实浏览器对照实验 27） |

### 文件指纹

| 文件 | 改前 | 改后 |
|---|---|---|
| `ui/style.css` | 391729 B / 7544 行 / LF / `2350576479abf0eda1e178df53cdf637` | **393391 B / 7564 行 / LF / `ff2f337396f19eb656e8cd5091219aed`** |
| `ui/app/14-chrome.js` | 67714 B / 1191 行 / LF / `dca555c6c8e14ef602f57b628dfdbb58` | **68786 B / 1196 行 / LF / `4e74848cdf0080ba97404aba4ea94334`** |
| `ui/index.html` | 29234 B / `abdcb0a2d62c7e7133c4f8d6b02cb054` | **未改动（哈希一致）** |

---

## 1. 怎么定位的

截图只能看到"感觉不对"，说不清哪里不对。所以走了四步，每一步都留证据：

**① 截图 → 源码**
截图上三个标题（`选择会话` / `扩展` / `全部设置`）+ 三条行（技能 / 插件 / 打开完整设置页）。
按文案 grep 定位到 `app/14-chrome.js` 的 `renderSetupNav()`（L432-467）。
页面容器是 `index.html:386` 的 `<aside class="bp-left" id="bp-setup-left">`。

**② 找出"同族的兄弟"**
全站还有另一个全屏页左栏 —— 聊天模式（`#cc-left` / `#cc-actions`，由 `15-chat-chrome.js` 产出），
它用**完全相同的类名**。这就是理想的对照组：同一批类，两处呈现。

**③ 用真实 CSS 并排渲染**
搭一个测试页，把三栏并排画出来（A = 截图那一栏 / B = 聊天模式左栏 / C = 主左栏列表头），
`addStyleTag` 注入**真实 `style.css` 字节**。渲染图 `before-baseline.png`。

**④ 逐值实测计算样式**
`getComputedStyle` 导出 fontSize / gap / padding / radius / height + 盒模型，量化差异。

### 实测结果（改前）

| 元素 | fontSize | gap | padding | radius | height |
|---|---|---|---|---|---|
| **A** `#bp-setup-left .bp-act` | **12.5px** | **8px** | `0 10px` | **6px** | 34px |
| **B** `#cc-actions .bp-act` | **13px** | **9px** | `0 10px 0 8px` | **5px** | 34px |
| B `#cc-left .bp-nav` | 13px | 10px | `0 10px 0 8px` | 5px | 36px |
| C `.list-head-btn` | 11.5px | — | `0 9px` | 5px | 24px |

**同一个类 `.bp-act`，两页四个值全不同。** 而 B / C 的值彼此一致 —— 说明 A 是掉队的那一个。

### 右边缘对齐实测（改前）

以面板右边缘为基准，三个不同缩进：

| 元素 | 右边缘 inset |
|---|---|
| `+` 按钮（`.bp-add`） | **6px** |
| 计数（`N 个 · M 生效`） | **12px** |
| 行悬停底（`.bp-act`） | 2px |

`+` 按钮比计数多出 6px —— 一栏里右侧三条基准线，视觉上就是"没对齐"。

---

## 2. 逐条修正

### S1 · `+` 按钮右边缘对齐行内容

```css
/* 改前 */
.bp-sec.bp-sec-row { display: flex; align-items: center; }
/* 改后 */
.bp-sec.bp-sec-row { display: flex; align-items: center; margin-right: 10px; }
```

`.bp-sec` 的右边距是 4px（逐值照原型，**不动**），而 `.bp-act` 的右内边距是 10px。
本行是唯一带 `+` 按钮的分区标题，把它单独对齐到行内容即可。
`+` 是 r60 后加的（「用户要求在这一页直接加群聊/私聊」），当时没跟行内边距对过。

**效果**：`addInset` 6 → 12，与 `cntInset` 12 齐平。

### S2 · `+` 按钮圆角 4 → 5

同栏的行（`.bp-act`）与同族的 `.list-head-btn` 都是 5。

> ⚠️ **这条我一开始判错了，已更正。** 我最初还想给它补 `transition`，理由是
> "探针实测 `transition: none 0s`"。后来发现那是我自己在探针里注入的
> `*{transition:none !important}` 造成的**假象** —— 去掉注入后实测它**本来就有**
> 全局按钮过渡层（`0.2s / --ease-in-out`）。所以过渡没动，只改圆角。

### S3 · 会话设置左栏补齐「逐值照原型」覆写 —— **核心**

```css
/* ── r96：会话设置页左栏（#bp-setup-left）逐值对齐原型 ──
   它和聊天模式左栏（#cc-left / #cc-actions）用的是**同一批类名**，
   但上面那套「逐值照原型」的覆写当时只加给了聊天模式那一栏，本栏漏了。
   后果：同一个 .bp-act 在聊天模式是 13px / gap 9 / radius 5，
   在会话设置页却是 12.5px / gap 8 / radius 6 —— 同一批控件在两个全屏页
   左栏呈现不同，看着像"没跟上版本"。
   这里补齐同一组值，不新造样式。 */
#bp-setup-left .bp-nav { height: 36px; gap: 10px; padding: 0 10px 0 8px; border-radius: 5px; }
#bp-setup-left .bp-nav-t { font-size: 13.5px; }
#bp-setup-left .bp-act { height: 34px; gap: 9px; padding: 0 10px 0 8px; border-radius: 5px; font-size: 13px; }
```

三条规则**与 `#cc-left` / `#cc-actions` 那三条逐字一致** —— 这是可静态验证的
（`verify.py` 直接比对两处规则的声明文本）。高度刻意不动（34 / 36 本来就对）。

### S4 · 空态文案左内边距 10 → 8

```css
/* 改前 */ .su-empty { padding: 2px 10px 10px; ... }
/* 改后 */ .su-empty { padding: 2px 8px 10px; ... }
```

与 `.bp-act` 的左内边距（8px）一致 —— 空态文案、行图标从此落在同一条左基准线上。

### J1 · `SUB_ICON` 补 `settings`（完整齿轮）

**这是最显眼的一处。** 顶栏导航「设置」项的图标是**两段 path**（内圆 + 齿轮外圈），
而「打开完整设置页」只抄了第一段：

```js
// 改前（14-chrome.js:464）—— 只有内圆
'<svg viewBox="0 0 24 24"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/></svg>'
```

`M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z` 是半径 3.5 的圆，在 24 viewBox 里
按 15px 渲染 → 直径只有 **4.4px**，看着就是个列表圆点 `◦`，
和上面 ✦ 技能 / 🧩 插件 的真图标完全不是一路。

改法：把完整齿轮加进 `SUB_ICON`（与顶栏同一枚），再引用它：

```js
var SUB_ICON = {
  ...
  snowluma: 'M12 3v18M4 7l16 10M20 7L4 17',
  /* r96：与顶栏导航「设置」项（index.html #tabs 的 data-top="settings"）**同一枚**图标。
     它是两段 path（内圆 + 齿轮外圈）；此前「打开完整设置页」只抄了第一段内圆，… */
  settings: '<内圆子路径> <齿轮外圈子路径>'
};
```

> **没有手抄。** 应用脚本在运行时从 `index.html` 里正则抓出顶栏「设置」项的
> 两段 `d`，拼好后写进 `SUB_ICON.settings` —— 保证与它**逐字节一致**，
> 零转录风险。`verify.py` 里也再做一次逐字节比对（用 `index.html` 现抓的值）。

### J2 · 「打开完整设置页」改用完整齿轮

```js
'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + SUB_ICON.settings +
'" stroke-linejoin="round" stroke-linecap="round"/></svg>' +
```

---

## 3. 验证证据

### 3.1 静态验证（25 项，0 失败）

`verify.py`，日志 `static-verify.log`。要点：

- 文件指纹 / 花括号平衡 2116:2116 / 两文件均无 CR / `index.html` 哈希未变
- S1–S4 每条规则的**精确文本**匹配
- **S3 的跨栏一致性**：`#bp-setup-left .bp-act` 与 `#cc-actions .bp-act` 的声明
  **逐字一致**（三条都比了）
- **J1 的图标一致性**：`SUB_ICON.settings` 与 `index.html` 现抓的顶栏设置图标
  **逐字节一致**；齿轮含 2 个子路径
- **正向控制**：`SUB_ICON.sessions` / `SUB_ICON.skills` 都只含 1 个子路径
  —— 证明"子路径计数"有区分力，不是恒等于 2
- **反向控制**：`.bp-sec.bp-sec-row` 之外那条通用 `.bp-sec` 未被改动
  —— 确认没有把 `margin-right: 10px` 泄漏给其它分区标题

### 3.2 浏览器验证（27 项，0 失败）—— 用备份 CSS 做对照实验

`browser.js`，日志 `browser-verify.log`。**Edge `Edg/155.0.4283.45`** + `puppeteer-core@25.13.0`。

这一轮用的是**对照实验**，而不是"只看改后的值对不对"：

| 组 | 内容 | 项数 |
|---|---|---|
| A | 加载**备份 CSS** → 断言两栏 `.bp-act` **不一致**（问题真实存在） | 5 |
| B | 加载**现盘 CSS** → 断言两栏 `.bp-act` / `.bp-nav` **逐值一致** | 9 |
| C | 逐项 diff：`12.5px→13px` / `8px→9px` / `6px→5px` / `10px→8px` | 7 |
| D | 齿轮 2 个子路径 + 正向控制 | 2 |
| E | 反向控制：聊天模式栏、主左栏列表头、高度均未受影响 | 4 |

A 组是关键：**如果只验"改后一致"，一个恒真的选择器也能骗过测试**。
先证明"备份下确实不一致"，才能说"是这次改动修好了它"。

实测输出（节选）：

```
── A. 对照：备份 CSS（修复前）──
     .bp-act  会话设置页 12.5px / gap 8px / r 6px / pad 0px 10px 0px 10px
     .bp-act  聊天模式页 13px / gap 9px / r 5px / pad 0px 10px 0px 8px
[OK] A1 备份下：两栏 .bp-act 不一致（问题真实存在）
[OK] A4 备份下：+ 与计数右边缘不齐（inset 6 vs 12）

── B. 现盘 CSS（修复后）──
     .bp-act  会话设置页 13px / gap 9px / r 5px / pad 0px 10px 0px 8px
[OK] B1 两栏 .bp-act 逐值一致
[OK] B8 + 与计数右边缘齐平（inset 12 = 12）
```

### 3.3 补丁验证

```
正向：基线 + r96-fixes.patch  →  md5 ff2f3373… / 4e74848c…  ✔ 与现盘一致
反向：现盘 − r96-fixes.patch  →  md5 2350576479… / dca555c6…  ✔ 与基线一致
可复现：两次独立生成逐字节相同（cmp 通过）
```

### 3.4 渲染对比

| 图 | 说明 |
|---|---|
| `r96-before.png` | 改前并排（A / B / C 三栏） |
| `r96-after.png` | 改后并排 |
| `r96-align.png` | 改后单栏 3× 放大 + 红色参考线（在 `+` 按钮右边缘）—— 参考线同时切过 `+` 的右边缘与「8 个 · 4 生效」的右边缘 |

---

## 4. 我在这一轮犯的两个方法论错误（都已更正）

这两条都值得记下来，因为它们是**假阳性**的典型来源：

**① 采样计算样式时没杀过渡 → 读到中间帧。**
`.bp-act` / `.bp-add` 带 `color` / `border-color` 过渡（0.2s）。
首次样式解析会从初值动画到目标值，直接采样会读到中间值。
实测两个颜色都恰好停在目标值的 **42.3%**（`rgb(54,54,54)` / `rgb(65,68,72)`），
一度被误判成"配色错误 / 令牌失效"。
**正确做法：采样前先注入 `*,*::before,*::after{transition:none !important}`。**

**② 然后我又被自己的修复手段骗了一次。**
加了过渡杀手之后，探针报 `.bp-add { transition: none 0s }`，
我据此判定"这个按钮没有过渡"，差点给它补一条 —— 实际上它**本来就有**
全局按钮过渡层，`none` 是杀手造成的假象。
**教训：用来做测量的手段，本身要先验证不会改变被测对象。**

（这两条已写进工作区 `MEMORY.md` 的「环境坑」一节。）

---

## 5. 交付物

| 文件 | 说明 |
|---|---|
| `QQAgent-左栏风格对齐-R96.md` | 本文件 |
| `r96-fixes.patch` | +30 −5 / 6014 B / `f90a241cd9f602a623880635ba389489` |
| `r96_apply.py` / `r96_verify.py` / `r96_browser.js` | 复现脚本 |
| `r96-static-verify.log` / `r96-browser-verify.log` | 验证日志 |
| `r96-before.png` / `r96-after.png` / `r96-align.png` | 渲染对比 |
| `_backup-r96-20261012-225529/` | 改动前备份（2 文件，在项目根） |

### 复现命令

```bash
python r96_verify.py                                  # 静态 25 项
node  r96_browser.js                                  # 浏览器 27 项（需 Edge）

# 从基线重新应用 / 反向回滚（在 resources/app 下）
patch -p1 --binary    < r96-fixes.patch
patch -p1 -R --binary < r96-fixes.patch

# 从备份直接回滚
cp _backup-r96-20261012-225529/style.css      resources/app/ui/style.css
cp _backup-r96-20261012-225529/app/14-chrome.js resources/app/ui/app/14-chrome.js
```

---

## 6. 顺带记录：还有一处我没动

**「选择会话」是分区标题，但用了和它自己的子分区完全相同的样式。**

`选择会话` / `扩展` / `全部设置` 三条都是 `.bp-sec`（12px / weight 400 / opacity .6），
彼此没有层级差。主左栏的标题用的是 `.list-head`（11.8px / **weight 600** / 无 opacity）。

但我**没有改**，理由：
1. `.bp-sec` 的 `margin: 18px 4px 4px 7px` 与 12px / opacity .6 是「逐值照原型」的
   （注释在 `style.css:6228`，r34 时逐值对过 PCL 原型第 556 行），动它有回归风险；
2. 在聊天模式那一栏，`.bp-sec` 全是真分区标题（页面 / 群聊 / 私聊 / 快捷操作），
   没有"页面标题"的角色 —— 也就是说 `.bp-sec` 的语义本身是一致的，
   只是会话设置页把第一个分区当成了页面标题用；
3. 这属于**信息层级设计**，不是"掉队"，应该单独一轮和作者确认后再动。

如果确实要加层级，建议方向是给该栏第一行（`.bp-sec-row`）单独提权
（weight 600 / opacity 1），而不是改 `.bp-sec` 本身 —— 这样不会波及聊天模式那一栏。

---

## 7. 结论

用户看到的"风格不符"，根因是**会话设置页左栏漏了一次版本同步**：
同一批类名，聊天模式那一栏拿到了「逐值照原型」的覆写，这一栏没有。

6 组改动全部落在**让两个同族左栏用同一套值**上，没有新造任何样式。
52 项断言全绿（含备份 CSS 对照实验），补丁双向逐字节可逆、可复现，
`index.html` 零改动。

最显眼的一处其实是纯 bug：「打开完整设置页」的齿轮图标被抄漏了一半，
只剩内圆，渲染成了一个小圆点。
