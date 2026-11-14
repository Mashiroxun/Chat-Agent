// 在价格表里匹配模型（供前端用本地数据算，不依赖接口往返）。
//
// ⚠️⚠️ 本文件是 src/model-key.js + src/model-prices.js#matchPriceTable 的
//     **浏览器镜像副本**，改动必须同步三处：
//       src/model-key.js           ← 规则唯一来源（normalizeModelId / splitModelLabel
//                                     / bareModelId / prefixHit）
//       src/model-prices.js        ← 后端 matchPriceTable
//       ui/vendor/price-match.js   ← 本文件
//     之所以不能直接 import：静态服务根目录是 <安装目录>/ui（src/app.js 的 UI_DIR），
//     浏览器的 `/vendor/x.js` 只能取到 ui/vendor/ 下的文件，取不到 src/。
//     `tests/model-key.test.mjs` 会把同一批样例同时喂给两边并断言输出逐字相同 ——
//     那个测试挂了说明这里和后端分叉了，**不要改测试，改这里**。
//     （0.4.9.4 / B5 之前没有这个测试，两边确实分叉了：这里的前缀匹配没有分隔符边界，
//       `glm-50` 会命中 `glm-5`，而且比对的是带 provider 前缀的整串。）
//
// 匹配顺序：精确 → 去 provider 前缀 → 带边界的最长前缀。

/** 前缀命中的合法边界字符。**不含 `.`** —— `.` 是版本号分隔（glm-5 ≠ glm-5.3）。 */
const SEP_CHARS = '/-@:_';

/**
 * 归一化模型 id / 渠道名：去首尾空白、全角冒号转半角、连续空白压成一个空格。
 * 刻意不小写化（价格表分别有全小写与混合大小写的键）。
 * @param {*} value
 * @returns {string}
 */
export function normalizeModelId(value) {
  return String(value ?? '')
    .replace(/：/g, ':')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * 把「渠道：模型 id」拆回两半。分隔符判定顺序见 src/model-key.js 的同名函数。
 * @param {*} label
 * @returns {{vendor: string, model: string}}
 */
export function splitModelLabel(label) {
  const s = String(label ?? '');

  const full = s.indexOf('：');
  if (full > 0) {
    return { vendor: s.slice(0, full).trim(), model: s.slice(full + 1).trim() };
  }

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
 * 去掉 provider 前缀：z-ai/glm-5.3 → glm-5.3。
 * @param {*} id
 * @returns {string}
 */
export function bareModelId(id) {
  const s = normalizeModelId(id).replace(/^[/\\]+|[/\\]+$/g, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 && i < s.length - 1 ? s.slice(i + 1) : s;
}

/**
 * 带分隔符边界的前缀命中：命中处后面必须是结尾或 SEP_CHARS 之一。
 * @param {string} candidate
 * @param {string} target
 * @returns {boolean}
 */
export function prefixHit(candidate, target) {
  const c = String(candidate ?? '');
  const t = String(target ?? '');
  if (!c || !t) return false;
  if (c === t) return true;
  if (!c.startsWith(t)) return false;
  if (c.length === t.length) return true;
  return SEP_CHARS.includes(c.charAt(t.length));
}

/**
 * 在价格表（数组，元素含 id 字段）里匹配模型。
 *
 * @param {string} modelId 模型 id（可带 provider 前缀，如 z-ai/glm-5.3）
 * @param {Array} table 价格表数组
 * @returns {object|null} 命中条目（含 id/in/out/cached/peak/image/src/matched），未命中返回 null
 */
export function matchPriceTable(modelId, table) {
  const { model: bare0 } = splitModelLabel(String(modelId ?? ''));
  const raw = normalizeModelId(bare0).toLowerCase();
  if (!raw) return null;
  const list = table || [];

  const exact = list.find((x) => normalizeModelId(x?.id).toLowerCase() === raw);
  if (exact) return { ...exact, matched: exact.id };

  const bare = bareModelId(raw);
  if (bare !== raw) {
    const hit = list.find((x) => normalizeModelId(x?.id).toLowerCase() === bare);
    if (hit) return { ...hit, matched: hit.id };
  }

  let best = null;
  for (const x of list) {
    const xid = normalizeModelId(x?.id).toLowerCase();
    if (prefixHit(bare, xid) && (!best || xid.length > String(best.id).length)) best = x;
  }
  if (best) return { ...best, matched: best.id };
  return null;
}
