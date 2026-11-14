// 模型身份归一化 —— **全库唯一实现**（0.4.9.4 / B5）。
//
// ── 为什么要有这个文件 ────────────────────────────────────────────────
// 归一化这件事以前在五个地方各写一套，规则互不一致：
//   ① src/model-prices.js 的 resolveOfficialPrice（去 provider 前缀，前缀白名单只认 / - @ :）
//   ② src/model-prices.js 的 matchPriceTable     （startsWith **无分隔符边界**）
//   ③ src/model-prices.js 的 modelLabel/splitModelLabel（复合键用全角「：」，①的白名单不认）
//   ④ ui/vendor/price-match.js                   （②的浏览器镜像）
//   ⑤ src/model-vision-docs.js 的 norm/modelKeys  （保留内部空格、去首尾斜杠、复合键用 |||）
// 结果：「同一个模型」在不同代码路径下被认成不同的键 —— 模型名带 `/`、带空格、
// 带全角冒号、或渠道名是中文时，静默套错价或静默 0 元，且界面不报错。
//
// 现在 ①②③⑤ 全部 import 本文件；④ 因为浏览器取不到 src/ 目录（静态服务根是
// <安装目录>/ui），只能保留镜像副本，但由 tests/model-key.test.mjs 用同一批样例
// 断言两边输出逐字相同。改这里就必须同步改 ui/vendor/price-match.js。
//
// ── 设计约束（改动前必读）─────────────────────────────────────────────
// 1. normalizeModelId **不做小写化**。价格表/能力表的键各自有大小写约定
//    （OFFICIAL_PRICES 全小写、PROVIDER_DOCS 里有 'a6api|||DeepSeek-V4-Flash-0731'
//    这种混合大小写），在归一化层统一小写会把后者悄悄改成另一批键。
//    需要小写比较的调用方自己 `.toLowerCase()`。
// 2. `-` `.` `_` **不是**「渠道：模型」的分隔符。`deepseek-v4-flash`、
//    `glm-5.3`、`mimo-v2.5-pro` 里的这些字符是模型名本身的一部分。
//    只有 `：` / `:` 才是标签分隔符；`/` 是 provider 前缀（由 bareModelId 处理）。
// 3. 前缀命中的边界字符集**不含 `.`**。含 `.` 会让 `glm-5` 命中 `glm-5.3`
//    （价格表里两者单价差 2 倍：4/18 vs 8/28），即在修 bug 的同时引入新的错价。
//    见 prefixHit 注释与 tests/model-key.test.mjs 的边界用例。

/** modelLabel() 产出的标签分隔符（全角冒号，避免与 id 里的半角符号混淆）。 */
const LABEL_SEP_FULL = '：';

/**
 * 前缀命中的合法边界字符。
 *
 * 不含 `.`：`.` 是版本号分隔（glm-5 → glm-5.3 是两个不同商品），把它算作边界
 * 会让「查不到 glm-5.4 的价」静默回落成 glm-5 的价 —— 那是错价，比查不到更糟。
 * 含 `_`：模型 id 里 `_` 只会出现在自造的变体名里，把它当边界不会跨商品。
 */
const SEP_CHARS = '/-@:_';

/**
 * 归一化模型 id / 渠道名：去首尾空白、全角冒号转半角、连续空白压成一个空格。
 *
 * 刻意**不做**的事：不小写化（见文件头约束 1）、不删内部空格（`qwen 3.8 max`
 * 与 `qwen3.8-max` 是两个不同的键，前者是用户手填、后者是官方 id）。
 *
 * @param {*} value 任意值（null/undefined/数字都会被安全转成字符串）
 * @returns {string} 归一化结果；输入为空时返回空串
 */
export function normalizeModelId(value) {
  return String(value ?? '')
    .replace(/：/g, ':')          // 全角冒号 → 半角（只影响标签，不影响大小写）
    .trim()
    .replace(/\s+/g, ' ');        // 连续空白（含 \u3000 全角空格）压成一个半角空格
}

/**
 * 把「渠道：模型 id」拆回两半。拆不开时 vendor 为空串、model 为原串。
 *
 * 分隔符判定顺序（不可交换，否则带端口的渠道名会被拆坏）：
 *   1. 先找**全角** `：` —— 这是 modelLabel() 唯一会产出的分隔符，歧义最小。
 *   2. 没有全角冒号时，再看**半角** `:`，且必须同时满足：
 *      · 位置 > 0（开头就是冒号不算标签）
 *      · 冒号前不含 `/`（`z-ai/glm-5.3:free` 里的 `:` 是 id 的一部分，不是渠道）
 *      · 不是 `://` 协议头
 *      · 取**最后一个**冒号 —— `127.0.0.1:3000:gpt-4` 这种「渠道是带端口的 host」
 *        才不会把 vendor 拆成 `127.0.0.1`、model 拆成 `3000:gpt-4`。
 *
 * @param {*} label 「渠道：模型 id」或裸模型 id
 * @returns {{vendor: string, model: string}}
 */
export function splitModelLabel(label) {
  const s = String(label ?? '');

  // ① 全角冒号：与旧实现完全一致（旧实现就是 indexOf('：')），零回归。
  const full = s.indexOf(LABEL_SEP_FULL);
  if (full > 0) {
    return { vendor: s.slice(0, full).trim(), model: s.slice(full + 1).trim() };
  }

  // ② 半角冒号：只在「看起来像渠道标签」时才算分隔符。
  const half = s.lastIndexOf(':');
  if (half > 0) {
    const before = s.slice(0, half);
    const after = s.slice(half + 1);
    const isScheme = s.slice(half, half + 3) === '://';
    if (!isScheme && !before.includes('/') && after.trim()) {
      return { vendor: before.trim(), model: after.trim() };
    }
  }

  return { vendor: '', model: s.trim() };
}

/**
 * 去掉 provider 前缀：`z-ai/glm-5.3` → `glm-5.3`。
 *
 * 取**最后**一段（多个斜杠时取最右），并先剥掉首尾斜杠/反斜杠 ——
 * 与 src/model-vision-docs.js 旧 modelKeys() 的 `replace(/^\/+|\/+$/g,'')`
 * 口径一致。旧 resolveOfficialPrice 用的是**第一个**斜杠之后的全部内容，
 * 只对单斜杠 id 等价；多斜杠 id（如 `accounts/x/models/y`）取最后一段更合理。
 *
 * @param {*} id 可能带 provider 前缀的模型 id
 * @returns {string} 去掉前缀后的 id；无前缀时返回归一化后的原值
 */
export function bareModelId(id) {
  const s = normalizeModelId(id).replace(/^[/\\]+|[/\\]+$/g, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 && i < s.length - 1 ? s.slice(i + 1) : s;
}

/**
 * 带分隔符边界的前缀命中判断。
 *
 * 与裸 `startsWith` 的区别（这是 B5 要修的第二个 bug）：
 *   裸 startsWith：`glm-50` 命中 `glm-5`、`gpt-40` 命中 `gpt-4` → 静默套错价。
 *   本函数：命中处后面必须是字符串结尾或 SEP_CHARS 之一，否则不算命中。
 *
 * ⚠️ SEP_CHARS **不含 `.`**，所以 `glm-5.3` 不会被 `glm-5` 命中 —— 这是刻意
 * 保留的「版本号不跨商品」语义，别为了「匹配更宽松」把 `.` 加进去。
 *
 * @param {string} candidate 待匹配的（已去前缀的）模型 id
 * @param {string} target    价格表 / 能力表里的键
 * @returns {boolean}
 */
export function prefixHit(candidate, target) {
  const c = String(candidate ?? '');
  const t = String(target ?? '');
  if (!c || !t) return false;
  if (c === t) return true;
  if (!c.startsWith(t)) return false;
  if (c.length === t.length) return true;              // 理论上不可达（上面已判等）
  return SEP_CHARS.includes(c.charAt(t.length));
}
