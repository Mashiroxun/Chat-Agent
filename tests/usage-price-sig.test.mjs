// B4 验证测试（0.4.9.4，2026-11-14）—— priceSig 进入日快照判据 + 改价后缓存自愈
//
// 覆盖三条交付判据（对应 audit/12-incomplete-status-report.md §B4）：
//   ① 日快照判据包含 priceSig：sig 匹配但价格指纹陈旧的日子**必须**离开快路径，
//      进重算/对齐路径（可观测证据：跑完后该日 priceSig 被对齐为当前值。
//      B3 的计数补正只就地改 searchCount/toolCounts，绝不碰 priceSig，
//      所以「priceSig 变了」是"走过重算路径"的干净判据）；
//   ② pricingLocked 的老日子改价后**不重算成本**，只对齐 sig + priceSig
//      （诚实保留旧成本，不谎称已按新价重算）；
//   ③ 改自定义单价后**不点刷新**，下一次统计内生效（快照 priceSig 对齐到新指纹）。
//
// ⚠️ 数据目录隔离（与 tests/usage-injection.test.mjs 的 B1 修法一致）：
//    先 mkdtempSync → 写 QQ_AGENT_DATA_DIR → **之后**才动态 import。
//    本文件只允许写到系统 tmp 下的临时目录，绝不碰真实 data/。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-price-sig-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

// ↓ 必须动态 import：DATA_DIR / USAGE_DAILY_FILE 在模块求值时就被定死了
const usageStats = await import('../src/usage-stats.js');
const hook = usageStats.__testUsageDaily();
const USAGE_DAILY_FILE = hook.USAGE_DAILY_FILE;

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

// 两个已完结日（相对"今天"稳定：昨天与前天）
const DAY_LOCKED = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
const DAY_STALE  = (() => { const d = new Date(); d.setDate(d.getDate() - 2); return d.toISOString().slice(0, 10); })();

// 空归档（tmp 下没有 sessions/）时 historySignatureOf 恒为 h2:0:0（src 内实现）
const EMPTY_ARCHIVE_SIG = 'h2:0:0';

function writeDaily(days) {
  fs.writeFileSync(USAGE_DAILY_FILE,
    JSON.stringify({ version: 2, savedAt: Date.now(), days }, null, 1), 'utf8');
}
function readDaily() {
  return JSON.parse(fs.readFileSync(USAGE_DAILY_FILE, 'utf8')).days;
}
// 最小合法聚合体：下游所有字段访问都是 Number(x)||0 防御式（src/usage-stats.js:1413+）
const Agg = (cost) => ({
  totals: {
    runs: 10, totalTokens: 500, promptTokens: 300, completionTokens: 200,
    cachedTokens: 0, cost,
  },
});

test('数据目录已隔离到临时目录', () => {
  assert.ok(USAGE_DAILY_FILE.startsWith(tmp), `USAGE_DAILY_FILE 必须落在 tmp 下：${USAGE_DAILY_FILE}`);
  assert.ok(tmp.startsWith(os.tmpdir()));
});

test('① pricingLocked 老日子：改价后不重算成本，只对齐 sig + priceSig', async () => {
  // 老迁移日子：sig/priceSig 双双陈旧 + pricingLocked 标记 + 旧成本 1.23
  writeDaily({
    [DAY_LOCKED]: { sig: 'stale-sig', priceSig: 'stale-price', pricingLocked: true, aggregates: Agg(1.23) },
  });
  const result = await hook.buildUsageStatsWithSnapshots({ range: 'all' });
  assert.ok(result && typeof result === 'object', '统计主流程应正常返回');

  const day = readDaily()[DAY_LOCKED];
  assert.ok(day, '日子必须仍在快照里（绝不塌缩）');
  assert.equal(day.aggregates?.totals?.cost, 1.23, '旧成本必须诚实保留，不得重算/清零');
  assert.notEqual(day.sig, 'stale-sig', 'sig 应对齐到当前归档状态');
  assert.ok(day.priceSig && day.priceSig !== 'stale-price', 'priceSig 应对齐为当前价格指纹');
  // 空归档下对齐目标就是 h2:0:0
  assert.equal(day.sig, EMPTY_ARCHIVE_SIG, '空归档时 sig 对齐为 h2:0:0');
});

test('② 日快照判据包含 priceSig：sig 匹配但价格指纹陈旧 → 离开快路径', async () => {
  // 与上一用例同轮数据不同日：sig 与当前 historySig 精确匹配（伪装成"命中"），
  // 但 priceSig 陈旧。若判据漏掉 priceSig，该日会走快路径、对象原样保留
  // （priceSig 永远停在 'stale-price'）；判据正确则必进重算/对齐路径并重建条目。
  writeDaily({
    [DAY_STALE]: { sig: EMPTY_ARCHIVE_SIG, priceSig: 'stale-price', aggregates: Agg(2.34) },
  });
  await hook.buildUsageStatsWithSnapshots({ range: 'all' });

  const day = readDaily()[DAY_STALE];
  assert.ok(day, '日子必须仍在快照里');
  assert.equal(day.aggregates?.totals?.cost, 2.34, '成本沿用快照（空归档下不产生新数据）');
  assert.ok(day.priceSig && day.priceSig !== 'stale-price',
    'priceSig 陈旧的日子必须被重新对齐 —— 证明 priceSig 参与了快照判据');
});

test('③ 改自定义单价后不点刷新，下一次统计内 priceSig 对齐到新指纹', async () => {
  // 自带夹具（前面用例的 writeDaily 会整体覆盖 days）：
  // 一条历史日，价格指纹设为陈旧值 → 第一轮统计后对齐到"当前指纹 P_A"
  writeDaily({
    [DAY_LOCKED]: { sig: EMPTY_ARCHIVE_SIG, priceSig: 'stale-price', aggregates: Agg(1.23) },
  });
  // 第一轮：无 config.json → 价格指纹为 nocfg 形态；统计后快照记录它
  await hook.buildUsageStatsWithSnapshots({ range: 'all' });
  const pA = readDaily()[DAY_LOCKED]?.priceSig;
  assert.ok(pA, '第一轮后快照应带价格指纹');

  // "改价"：写入 config.json（priceSignature 取其 mtime:size）
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ customPrice: { 'gpt-x': 0.5 } }), 'utf8');

  // 第二轮：不点刷新、不开 force，仅再次统计
  await hook.buildUsageStatsWithSnapshots({ range: 'all' });
  const afterDays = readDaily();
  assert.notEqual(afterDays[DAY_LOCKED]?.priceSig, pA, '改价后同一次统计内快照必须换到新价格指纹');
  assert.equal(afterDays[DAY_LOCKED]?.aggregates?.totals?.cost, 1.23, '改价不引发历史成本漂移（空归档诚实保留）');
});

test('④ buildUsageStats 变价后整体入口可正常工作（缓存重置不炸主流程）', async () => {
  // buildUsageStats 在价格指纹变化时调 resetUsageStatsCache()（B4 第 3 处改动）。
  // 这里做行为冒烟：连续两次统计（中间再改一次价）都应正常返回完整对象。
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ customPrice: { 'gpt-y': 0.7 } }), 'utf8');
  const r1 = await usageStats.buildUsageStats({ range: '7', force: true });
  assert.ok(r1 && typeof r1 === 'object', '第一次统计应正常返回');
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ customPrice: { 'gpt-y': 0.9, extra: 1 } }), 'utf8');
  const r2 = await usageStats.buildUsageStats({ range: '7', force: true });
  assert.ok(r2 && typeof r2 === 'object', '改价后第二次统计应正常返回（缓存重置路径无异常）');
});

test('⑤ 幂等：同状态下连续统计，成本不漂移', async () => {
  const c1 = readDaily()[DAY_LOCKED]?.aggregates?.totals?.cost;
  await hook.buildUsageStatsWithSnapshots({ range: 'all' });
  const c2 = readDaily()[DAY_LOCKED]?.aggregates?.totals?.cost;
  assert.equal(c2, c1, '连续统计成本必须分毫不差');
});
