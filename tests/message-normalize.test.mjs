// 消息规整的两类翻车修复（2026-10-27，均来自真实群里发出来的事故）：
//   1. 模型传 JSON 数组但内层引号没转义 → 整串原样发进群
//      （实例：2026-10-26 13:41 五条分句整串直发，内层 "当时视角" 没转义）
//   2. 模型把换行写成双重转义的 \n → 字面反斜杠+n 发进群
//      （实例：2026-10-22 18:13 "涨价合理\n排队票你替我拿了"）
// 修复点都在 normalizeMessageList 的统一入口（util.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { normalizeMessageList, repairJsonArray } = await import('../src/util.js');

// ── 真实事故 #1：内层引号未转义的数组（逐字还原 2026-10-26 群B id=1059）──────
test('normalizeMessageList: 内层引号未转义的 JSON 数组被容错拆分', () => {
  const bad =
    '["这题现在没标准答案 学界吵了几十年", "主流看法：不完全是懦弱 更多是误判+算政治账", ' +
    '"以为日本只想占东三省 不会南下 结果算错", "加上当时中央的指令 他自己也扛不住", ' +
    '"事后看就是大错特错 但这属于"当时视角"和"事后视角"的差别"]';
  const out = normalizeMessageList(bad);
  assert.equal(out.length, 5);
  assert.equal(out[0], '这题现在没标准答案 学界吵了几十年');
  assert.equal(out[4], '事后看就是大错特错 但这属于"当时视角"和"事后视角"的差别');
});

test('normalizeMessageList: 正常 JSON 数组不受影响', () => {
  assert.deepEqual(normalizeMessageList('["a","b"]'), ['a', 'b']);
});

test('normalizeMessageList: 普通字符串数组照常', () => {
  assert.deepEqual(normalizeMessageList(['你好', '在吗']), ['你好', '在吗']);
  assert.deepEqual(normalizeMessageList('单条'), ['单条']);
});

test('repairJsonArray: 无法修复时返回 null（保持原字符串路径）', () => {
  assert.equal(repairJsonArray('不是数组'), null);
  assert.equal(repairJsonArray('[完全没法解析的"),]'), null);
  assert.equal(repairJsonArray('["干净的"]'), null); // 没改任何东西 → null
});

test('repairJsonArray: 键值对象形态的冒号闭合不被误转义', () => {
  const out = repairJsonArray('[{"text":"他说"你好"了"}]');
  assert.deepEqual(out, [{ text: '他说"你好"了' }]);
});

// ── 真实事故 #2：双重转义的 \n（逐字还原 2026-10-22 群A id=1026）────────────
test('normalizeMessageList: 字面 \\n 还原为真实换行', () => {
  const out = normalizeMessageList('三勺就三勺，涨价合理\\n排队票你替我拿了 别忘了');
  assert.equal(out.length, 1);
  assert.equal(out[0], '三勺就三勺，涨价合理\n排队票你替我拿了 别忘了');
});

test('normalizeMessageList: 已带真实换行的文本不误伤字面 \\n', () => {
  const src = '第一行\\n这是代码演示';
  const withRealNewline = '第一行\n第二行 \\n 保留';
  assert.equal(normalizeMessageList(withRealNewline)[0], withRealNewline);
  assert.ok(normalizeMessageList(src)[0].includes('\n'));
});
