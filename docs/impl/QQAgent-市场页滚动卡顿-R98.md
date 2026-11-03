# QQAgent 洛版 v0.4.7 · 市场页滚动卡顿（R98）

> 起因：用户 ——「下载界面滑动查看插件的时候奇卡务必」。
> 目标目录：`C:\Users\Administrator\Desktop\洛版QQ-Agent-v0.4.7\resources\app\`

---

## 0. 摘要

**根因**：`.mk-card` 上那条 `backdrop-filter: blur(14px) saturate(1.25)`。
它让 149 张技能卡**各自成为一个常驻合成层** —— 实测本页合成层从 6 个炸到 **86 个**
（其中 **80 个**来自这一个选择器）。

而本项目是**软件渲染**：`electron/main.js` 第 25 行 `app.disableHardwareAcceleration()`，
第 68-69 行再补 `--disable-gpu` + `--disable-software-rasterizer`。
没有 GPU 进程，每个 backdrop 层每帧都要在 **CPU** 上把背后区域读回来、做 14px 高斯模糊；
滚动时背后内容每帧都变，模糊结果**完全无法缓存** —— 于是"滑动查看插件"奇卡无比。

| 项 | 值 |
|---|---|
| 改动组数 | **1 组**（只删 2 行 `backdrop-filter`） |
| 涉及文件 | `ui/style.css`（`index.html` 与全部 JS **零改动**） |
| 补丁规模 | **+20 −3 行** / 2501 B / 1 个 hunk |
| 补丁指纹 | `73f0980c36a7f0f85015f9e7d5177dad`（正向 + 反向 + 可复现，三重校验） |
| 断言总数 | **55 项全绿**（静态 33 + 真实浏览器 22） |
| 合成层 | **86 → 6（−93%）** |
| 视觉影响 | **像素级无差异**（平均通道差 0.01%，差异 >8 的像素 **0.00%**） |

### 文件指纹

| 文件 | 改前（R97 终点） | 改后（R98） |
|---|---|---|
| `ui/style.css` | 397939 B / 7614 行 / LF / `9b048338e9c39fb2d2116a2cbf4f3fda` | **399348 B / 7631 行 / LF / `b3912ffbdb8d5f67c09dc1ac33e52917`** |
| `ui/index.html` | `abdcb0a2d62c…` | **未改动（哈希一致）** |
| `ui/app/16-market.js` | — | **未改动** |

---

## 1. 怎么定位的

### ① 截图 → 源码

「下载」页 = `#view-skillmarket` / `#view-pluginmarket`，由 `ui/app/16-market.js` 渲染
（数据来自后端 `GET /api/market/list`）。列表用 `innerHTML = list.map(...).join('')`
一次性铺 149 张卡 —— 没有虚拟滚动。

先排除三类常见嫌疑：

- **滚动监听**：`16-market.js` 里**没有** scroll 监听。全项目只有两处：
  `00-core.js:1012`（document 级，收起下拉）与 `02-sse-sessions.js:286`（消息列表无限滚动），
  都与市场页无关。
- **鼠标动画**：`.mk-card:hover` 只有 `translateY(-2px)`，纯 CSS，无 mousemove 脚本。
- **`closeAll()` 的开销**：`00-core.js:1012` 那条 document 级 scroll 监听每次滚动都会调
  `closeAll()`，里面有两个全文档 `querySelectorAll`。**实测单价 0.5 µs/次**
  （DOM 2123 元素）→ 60 次/秒滚动时占用 **0.03 ms/s**。**排除**。

### ② 第一眼就看到的可疑项

```css
.mk-card {
  background: color-mix(in srgb, var(--card) 70%, transparent);
  -webkit-backdrop-filter: blur(14px) saturate(1.25);   /* ← 149 张卡 */
  backdrop-filter: blur(14px) saturate(1.25);
  ...
}
```

而且 —— **项目自己早就写下了铁律**（`style.css` 第 2994-2996 行）：

```
⚠️ 本项目 main.js 关掉了硬件加速（软件渲染）：
   这里刻意不用 backdrop-filter，也不给这些元素加 animation。
```

全站 `backdrop-filter` 只出现在**市场页**这三处（第 7216/7237/7268 行），
其余各页一律遵守该铁律（弹窗遮罩甚至显式写了 `backdrop-filter: none`，第 5721 行）。
**r104 给市场页加毛玻璃时，破了这条自己定的规矩。**

### ③ 三次仪器自我否定（这段是本轮最有价值的部分）

怀疑归怀疑，**得量出来**。我试了三个指标，前两个都**自己先被证伪**：

| 仪器 | 结果 | 结论 |
|---|---|---|
| **rAF 帧间隔** | 有无 backdrop-filter **都是 16.6ms**，`>33ms` 帧 **0 个** | **失灵**。rAF 只反映**主线程**；backdrop 模糊在**光栅/合成线程**，主线程看不见 |
| **CDP screencast 帧率** | 四个变体**全是 1.2 fps** | **失灵**。headless 下 screencast 被节流。**灵敏度对照（600 张卡）也是 1.2 fps** → 它分辨不出"贵"和"不贵" |
| **tracing RasterTask 总时长** | 有 backdrop-filter **549ms**，关掉后 **7167ms** | **会反向误导**。有 backdrop-filter 时卡片各自成层、内容被缓存 → 光栅反而更少；这个指标量的是"光栅"，不是"合成" |

> ⚠️ 第二次尤其关键：**如果我没加那个 600 张卡的灵敏度对照，就会拿一个盲仪器的"没差别"当结论。**

### ④ 换成直接的结构指标：合成图层数

用 CDP `LayerTree` 域数合成层 —— 这是**可直接计数的事实**，没有时序噪声，
而且正好命中项目铁律里那句"避免常驻合成层"。

**只切换一个变量**（`backdrop-filter`），其余全同：

| 变体 | 合成图层数 |
|---|---|
| ① 原样（三处都有 backdrop-filter） | **86** |
| ② **只关 `.mk-card`** | **6** |
| ③ 只关工具栏（`.mk-search` + `.mk-filter-panel`） | 84 |
| ④ 三处全关 | 4 |

拆解：卡片贡献 **80** 层（86−6），工具栏贡献 **2** 层（86−84），基础 **4** 层。
**`backdrop-filter` 一出现，层数就爆；与模糊半径无关**（把半径从 14px 加到 24px，层数仍是 86）。

---

## 2. 为什么这会"奇卡无比"

软件渲染下，每个 backdrop 层每帧的代价是：

1. 把该元素**背后区域**从帧缓冲读回来（一张卡 ≈ 1030×76 px ≈ 313 KB）；
2. 在 **CPU** 上做 14px 高斯模糊（可分离核 ≈ 2×14 抽头 × 78k px ≈ 220 万次乘加）；
3. 再与半透明卡底混合、合成。

可见卡片约 7~8 张 → 每帧 ≈ 1800 万次乘加 + 2.5 MB 内存搬运；
**而且滚动时背后内容每帧都在变，模糊结果一帧都不能复用**。
按 60fps 算需要 ~11 亿次/秒的 CPU 浮点 —— 单核不可能跟上。

（对照：`.mk-search` / `.mk-filter-panel` 那 2 个层**不随列表滚动**，
背后是静态渐变，模糊结果可缓存 → 对滚动**零开销**。所以它们留着。）

---

## 3. 修法：为什么只删两行

```css
.mk-card {
  display: flex; align-items: center; gap: 13px;
  padding: 12px 14px;
  background: color-mix(in srgb, var(--card) 70%, transparent);   /* 保留 */
  border: 1px solid var(--line); border-radius: var(--r);          /* 保留 */
  transition: border-color .12s, background .12s, transform .18s ease;  /* 保留 */
}
```

只删 `-webkit-backdrop-filter` 与 `backdrop-filter` 两行。理由：

1. **"玻璃感"的真正来源是半透明卡底，不是模糊。** `color-mix(in srgb, var(--card) 70%, transparent)`
   让卡片背后的氛围底透出来 —— 这一条不建层、零成本，留着。
2. **模糊在这一页几乎是无用功**：卡片背后是 `.market-page::before` 铺的**极淡径向渐变**，
   几乎就是纯色 —— **对几乎纯色的背景做模糊 ≈ 什么都没变**。
3. 工具栏那两处**保留**（2 个静态层，对滚动零开销），改动面最小。

---

## 4. 为什么"视觉没变"是可证的

同一页面、同一滚动位置，用**真实的两份 CSS**（备份 / 现盘）各渲染一张，逐像素比：

| 指标 | 值 |
|---|---|
| 平均通道差 | **0.037 / 255 = 0.01%** |
| 差异 >8 的像素 | **0.00%** |
| 差异热力图 | 全黑（`r98-diff.png`） |

**换句话说：这一改，屏幕上什么都不会变，但合成层少了 80 个。**

> ⚠️ 顺带一个方法论坑：我第一版对照用的是 `*{backdrop-filter:none !important}` 这种
> "一刀切"覆盖，量出平均差 0.94/255、3.94% 的像素差异 >8 —— **那是假象**。
> 因为 `backdrop-filter` 会创建 stacking context，对 `*` 一刀切会**改变全页的绘制顺序**。
> 换回"真实两份 CSS"后差异归零。**单变量对照必须只动那一个变量。**

---

## 5. 刻意没动的地方

| 对象 | 为什么不动 |
|---|---|
| `.mk-search` / `.mk-filter-panel` 的 `backdrop-filter` | 不随列表滚动、背后静态 → 模糊可缓存，**对滚动零开销**；只占 2 层。保留 r104 的设计意图 |
| `.market-page::before` 氛围底（两条 radial-gradient） | 静态层，铺一次；它正是卡片半透明感要透出的东西 |
| `.mk-card` 的半透明卡底 / 描边 / 圆角 / 悬停 `translateY(-2px)` | 与卡顿无关，且是 r104 的设计。已逐字段断言"其余声明与备份逐字节相同" |
| `00-core.js:1012` 的 `closeAll()` | 实测 0.03 ms/s，**不是问题**。不动它（改它反而引入回归风险） |
| `16-market.js` | 149 条数据一次性渲染**没有**造成卡顿（去掉玻璃后光栅能并行跟上）。不引入虚拟滚动这种大改 |

---

## 6. 验证证据

### 静态断言 33 项全绿（`verify.py`）

- **文件完整性**：纯 LF / 字节数 / md5 / 行数 / 花括号配平 / 注释词法（未闭合 0、游离 `*/` 0）
- **核心断言**：`.mk-card` 已无标准与 `-webkit-` 前缀的 backdrop-filter；
  **反向对照**：备份里确实有，且值就是 `blur(14px) saturate(1.25)`
- **未误伤**：逐字段比对，`.mk-card` 恰好只少了这 2 条声明，其余与备份**逐字节相同**
- **工具栏零改动**：两处的值与备份逐字节相同
- **未越界**：`index.html` 哈希一致、`@keyframes` 数仍为 34、`.mk-card` 只有 1 条规则

### 浏览器断言 22 项全绿（`browser.js`，真实 Edge + 应用同款 flags）

| 组 | 内容 | 关键数据 |
|---|---|---|
| A | **备份 CSS 对照**（问题应真实存在） | 合成层 **86**；带 backdrop-filter 的元素 **151**（149 卡 + 2 工具栏） |
| B | 现盘 CSS（问题应消失） | 合成层 **6**；带 backdrop-filter 的元素 **2**；**下降 93%** |
| C | 工具栏玻璃刻意保留 | 两处与备份计算值**完全一致** |
| D | 视觉设计原样保留 | 卡底仍半透明 `color(srgb .141 .145 .169 / .7)`、描边、圆角 9px、悬停过渡都在 |
| E | 几何零回归 | 卡片 **1030×92** 不变；卡片数 149；列表总高 **16711** 不变 |
| F | **注入反转自证** | 把 backdrop-filter 人为注回 `.mk-card` → 合成层**立刻回升到 86** → B2 不是恒真断言 |

### 仪器可信度（本轮反复自证）

- `LayerTree` 层数：**有/无 backdrop-filter 是 6 vs 86**，且**注入回去立刻回到 86**（F 组）—— 仪器灵敏。
- rAF / screencast 两个仪器**被自己的灵敏度对照证伪**，已弃用（见第 1 节③）。

---

## 7. 复现命令

```bash
# 应用 / 反向回滚（在 resources/app 下执行）
patch --binary -p1    -i r98-fixes.patch
patch --binary -p1 -R -i r98-fixes.patch

# 从备份直接回滚
cp _backup-r98-20261012-234830/resources/app/ui/style.css resources/app/ui/style.css

# 验证
python _r98/verify.py     # 静态 33 项
node   _r98/browser.js    # 浏览器 22 项（需 Edge）
node   _r98/probe-scope.js  # 复核"最小修法范围"（86/6/84/4 层）
node   _r98/probe-ba.js     # 重出对照图
```

> node 脚本需设 `NODE_PATH=C:\Users\Administrator\.workbuddy-ai\binaries\node\workspace\node_modules`

### 产物清单（`_r98/`）

| 文件 | 说明 |
|---|---|
| `r98-fixes.patch` | 补丁，2501 B / `73f0980c36a7f0f85015f9e7d5177dad` |
| `r98-static-verify.log` / `r98-browser-verify.log` | 55 项验证日志 |
| `r98-patch-verify.log` | 补丁三重校验 |
| `r98-layers.log` / `r98-layers-appflags.log` | 合成层 + tracing Top-N（含阳性对照） |
| `r98-scope.log` | 最小修法范围（86/6/84/4）+ closeAll 单价 |
| `r98-fps.log` | **失灵仪器的证据**（含 600 卡灵敏度对照） |
| `r98-scroll.log` | rAF 指标失灵的证据 |
| `r98-visual.log` / `r98-ba.log` | 像素差（含"一刀切覆盖"假象的记录） |
| `r98-before-after.png` | **改前改后对照图**（86 层 / 6 层 / 差异热力图） |
| `r98-before.png` / `r98-after.png` / `r98-diff.png` | 单帧与差异图 |
| `_backup-r98-20261012-234830/` | 改动前备份（在项目根） |

---

## 8. 结论

用户报的"滑动查看插件奇卡无比"是**一条真缺陷**，而且**违反了项目自己写下的铁律**：

r104 给 `.mk-card` 加毛玻璃时用了 `backdrop-filter`，而本项目是软件渲染
（`main.js` 明确关掉硬件加速 + GPU 进程）—— 149 张卡各自成为一个常驻合成层，
滚动时每帧都要在 CPU 上重做 14px 高斯模糊，且结果一帧都不能缓存。

**修法只删两行**：合成层 **86 → 6（−93%）**，而屏幕像素**完全没有变化**
（平均差 0.01%，差异 >8 的像素 0%）。"玻璃感"由半透明卡底继续提供。

55 项断言全绿（含备份 CSS 对照 + 注入反转自证），补丁双向逐字节可逆、可复现，
`index.html` 与全部 JS 零改动。

**遗留**：headless 环境**无法**复现"窗口呈现"的帧率（rAF 恒 60Hz、screencast 被节流），
所以本轮给的是**结构证据**（合成层数）而非直接帧率证据 —— 需要你在真机上滑一下确认手感。
