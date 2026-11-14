// 模型身份归一化的回归测试（0.4.9.4 / B5）。
//
// 锁三件事：
//   1. 四个纯函数在「脏名字」上的行为符合约定（尤其前缀边界不许跨版本号）；
//   2. src/model-key.js 与浏览器镜像 ui/vendor/price-match.js **逐字一致**
//      —— 这两份是复制关系（浏览器取不到 src/），没有任何机制能阻止它们分叉，
//      只能靠这个测试兜；
//   3. src/model-prices.js#matchPriceTable 与镜像 matchPriceTable 对同一张价格表
//      给出完全相同的结果（匹配顺序 / matched 字段都要一致）。
//
// 这些文件都**不读数据目录**，所以本测试不需要 QQ_AGENT_DATA_DIR 隔离。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as canon from '../src/model-key.js';
import * as mirror from '../ui/vendor/price-match.js';
import { matchPriceTable as srcMatch, listOfficialPrices } from '../src/model-prices.js';

// ── 覆盖面用的脏名字样本（真实用户会遇到的全部形态）──
const NAMES = [
  'deepseek-v4-flash',                    // 裸 id
  'deepseek-v4-flash-0731',               // 日期快照
  'sensenova-6.8-flash-lite',             // 本机真实模型（不在官方表里）
  'token.sensenova.cn：deepseek-v4-flash', // 全角冒号 + 带点 host（真实渠道名）
  'token.sensenova.cn:deepseek-v4-flash',  // 半角冒号同义写法
  'A6API：glm-5.3-flash',                  // 中文/大写渠道 + 全角
  '中文渠道：model-x',                     // 纯中文渠道
  'vendor: model',                         // 半角冒号 + 空格
  'vendor:model',
  '127.0.0.1:3000:gpt-4',                  // 渠道是带端口的 host（半角冒号出现两次）
  'z-ai/glm-5.3',                          // provider 前缀
  'z-ai/glm-5.3:free',                     // 前缀 + id 自带半角冒号
  'deepseek-ai/deepseek-v4-pro-0813',
  'accounts/x/models/y',                   // 多斜杠
  '/leading-slash-model',
  'trailing-slash/',
  '  model  ',                             // 首尾空白
  'qwen 3.8 max',                          // 内部空格（不是同 id 的另一种写法）
  'glm-5.3',
  'glm-50',
  'glm-5',
  'glm-5-turbo',
  '',
  '   ',
  null,
  undefined,
];

test('normalizeModelId：去空白 / 全角冒号转半角 / **不小写化**', () => {
  assert.equal(canon.normalizeModelId('  A6API：GLM-5.3  '), 'A6API:GLM-5.3');
  assert.equal(canon.normalizeModelId('qwen   3.8   max'), 'qwen 3.8 max');
  assert.equal(canon.normalizeModelId(null), '');
  assert.equal(canon.normalizeModelId(undefined), '');
  assert.equal(canon.normalizeModelId(0), '0');
  // 不小写化是刻意约定：价格表同时存在全小写与混合大小写的键
  assert.equal(canon.normalizeModelId('DeepSeek-V4-Flash'), 'DeepSeek-V4-Flash');
});

test('splitModelLabel：全角优先，半角仅在像渠道标签时才拆', () => {
  // 全角（modelLabel 产出的唯一形态）—— 与旧实现完全一致
  assert.deepEqual(canon.splitModelLabel('token.sensenova.cn：deepseek-v4-flash'),
    { vendor: 'token.sensenova.cn', model: 'deepseek-v4-flash' });
  assert.deepEqual(canon.splitModelLabel('中文渠道：model-x'),
    { vendor: '中文渠道', model: 'model-x' });

  // 裸 id 不许被拆（`-` `.` 都不是标签分隔符，这是行为等价性的底线）
  assert.deepEqual(canon.splitModelLabel('deepseek-v4-flash'),
    { vendor: '', model: 'deepseek-v4-flash' });
  assert.deepEqual(canon.splitModelLabel('glm-5.3'),
    { vendor: '', model: 'glm-5.3' });

  // 半角冒号 + 空格
  assert.deepEqual(canon.splitModelLabel('vendor: model'),
    { vendor: 'vendor', model: 'model' });

  // provider 前缀里的半角冒号（z-ai/glm-5.3:free）不算标签：冒号前有 '/'
  assert.deepEqual(canon.splitModelLabel('z-ai/glm-5.3:free'),
    { vendor: '', model: 'z-ai/glm-5.3:free' });

  // 渠道是带端口的 host：取**最后**一个冒号，否则 vendor 会被拆成 127.0.0.1
  assert.deepEqual(canon.splitModelLabel('127.0.0.1:3000:gpt-4'),
    { vendor: '127.0.0.1:3000', model: 'gpt-4' });

  // 协议头不拆
  assert.deepEqual(canon.splitModelLabel('http://host/model'),
    { vendor: '', model: 'http://host/model' });

  // 边界输入
  assert.deepEqual(canon.splitModelLabel(''), { vendor: '', model: '' });
  assert.deepEqual(canon.splitModelLabel(null), { vendor: '', model: '' });
  assert.deepEqual(canon.splitModelLabel(undefined), { vendor: '', model: '' });
  assert.deepEqual(canon.splitModelLabel(':leading'), { vendor: '', model: ':leading' });
});

test('bareModelId：取最后一段，去掉首尾斜杠', () => {
  assert.equal(canon.bareModelId('z-ai/glm-5.3'), 'glm-5.3');
  assert.equal(canon.bareModelId('deepseek-ai/deepseek-v4-pro-0813'), 'deepseek-v4-pro-0813');
  assert.equal(canon.bareModelId('accounts/x/models/y'), 'y');
  assert.equal(canon.bareModelId('/leading-slash-model'), 'leading-slash-model');
  assert.equal(canon.bareModelId('trailing-slash/'), 'trailing-slash');
  assert.equal(canon.bareModelId('glm-5.3'), 'glm-5.3');
  assert.equal(canon.bareModelId(''), '');
});

test('prefixHit：必须有分隔符边界（B5 修的核心 bug）', () => {
  // ① 该命中的
  assert.equal(canon.prefixHit('glm-5', 'glm-5'), true);
  assert.equal(canon.prefixHit('glm-5-turbo', 'glm-5'), true);        // '-' 边界
  assert.equal(canon.prefixHit('glm-5:free', 'glm-5'), true);         // ':' 边界
  assert.equal(canon.prefixHit('glm-5@2026', 'glm-5'), true);         // '@' 边界
  assert.equal(canon.prefixHit('glm-5_x', 'glm-5'), true);            // '_' 边界

  // ② 不许命中的（旧 startsWith 会在这里错）
  assert.equal(canon.prefixHit('glm-50', 'glm-5'), false, 'glm-50 不是 glm-5 的变体');
  assert.equal(canon.prefixHit('gpt-40', 'gpt-4'), false);
  assert.equal(canon.prefixHit('glm-5.3', 'glm-5'), false, '`.` 是版本号分隔，不跨商品');
  assert.equal(canon.prefixHit('glm-5.3-flash', 'glm-5'), false);

  // ③ 乱输入
  assert.equal(canon.prefixHit('', 'glm-5'), false);
  assert.equal(canon.prefixHit('glm-5', ''), false);
  assert.equal(canon.prefixHit(null, undefined), false);
});

test('镜像 ui/vendor/price-match.js 与 src/model-key.js 逐字一致', () => {
  for (const name of NAMES) {
    assert.equal(
      mirror.normalizeModelId(name), canon.normalizeModelId(name),
      `normalizeModelId 分叉：${JSON.stringify(name)}`,
    );
    assert.deepEqual(
      mirror.splitModelLabel(name), canon.splitModelLabel(name),
      `splitModelLabel 分叉：${JSON.stringify(name)}`,
    );
    assert.equal(
      mirror.bareModelId(name), canon.bareModelId(name),
      `bareModelId 分叉：${JSON.stringify(name)}`,
    );
  }

  const targets = ['glm-5', 'glm-5.3', 'glm-5.3-flash', 'deepseek-v4-flash',
    'deepseek-v4-flash-0731', 'gpt-4', 'qwen3.8-max', ''];
  for (const candidate of NAMES) {
    for (const target of targets) {
      assert.equal(
        mirror.prefixHit(candidate, target), canon.prefixHit(candidate, target),
        `prefixHit 分叉：${JSON.stringify([candidate, target])}`,
      );
    }
  }
});

test('matchPriceTable：后端与镜像对同一张价格表结果完全相同', () => {
  const table = listOfficialPrices();
  assert.ok(table.length > 100, '价格表规模异常，测试前提不成立');

  const probes = [
    ...NAMES,
    'glm-5.3', 'glm-5.3-flash', 'glm-5', 'glm-50', 'glm-5.4',
    'deepseek-chat', 'deepseek-v4-flash', 'deepseek-v4-flash-0731',
    'z-ai/glm-5.3-flash', 'A6API：glm-5.3-flash',
    'qwen3.8-max-0902', 'qwen3.8-max-9999', 'gpt-4', 'gpt-40',
  ];

  for (const probe of probes) {
    const a = srcMatch(probe, table);
    const b = mirror.matchPriceTable(probe, table);
    assert.deepEqual(b, a, `matchPriceTable 分叉：${JSON.stringify(probe)}`);
  }
});

test('matchPriceTable：边界修复不会跨版本号（回归锁）', () => {
  const table = listOfficialPrices();
  // 精确命中，不受前缀规则影响
  assert.equal(srcMatch('glm-5.3', table)?.matched, 'glm-5.3');
  // 表里没有 glm-5.4 → 必须查不到，而不是回落成 glm-5（4/18）的价
  assert.equal(srcMatch('glm-5.4', table), null, 'glm-5.4 不许被 glm-5 命中');
  // glm-50 同理
  assert.equal(srcMatch('glm-50', table), null, 'glm-50 不许被 glm-5 命中');
  // provider 前缀 + 全角渠道标签都要能命中
  assert.equal(srcMatch('z-ai/glm-5.3-flash', table)?.matched, 'glm-5.3-flash');
  assert.equal(srcMatch('A6API：glm-5.3-flash', table)?.matched, 'glm-5.3-flash');
  // 空值
  assert.equal(srcMatch('', table), null);
  assert.equal(srcMatch(null, table), null);
});
