// 用量统计注入测试（0.4.9.3）
//
// data.usage 用 provider hook 实现：只覆盖两个主入口（buildUsageStats /
// buildUsageBreakdown），30 处调用点零改动。
// 这里锁住「默认不接管 / 覆盖生效 / 只覆盖一个方法另一个走默认 / 可恢复」。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  setUsageProvider, hasUsageProvider,
  buildUsageStats, buildUsageBreakdown,
} from '../src/usage-stats.js';

test('默认不接管', () => {
  setUsageProvider(null);
  assert.equal(hasUsageProvider(), false);
});

test('覆盖 buildUsageStats 后调用走 provider', async () => {
  let got = null;
  setUsageProvider({ buildUsageStats: (opts) => { got = opts; return { injected: true }; } });
  try {
    const r = await buildUsageStats({ range: '30', force: true });
    assert.deepEqual(r, { injected: true });
    assert.deepEqual(got, { range: '30', force: true }, 'provider 应收到原样的 opts');
  } finally {
    setUsageProvider(null);
  }
});

test('只覆盖一个方法时，另一个仍走默认实现', async () => {
  setUsageProvider({ buildUsageStats: () => ({ injected: true }) });
  try {
    assert.deepEqual(await buildUsageStats({ range: '7' }), { injected: true });
    // breakdown 没被覆盖，应走默认（返回带 rows/win 的对象，而不是抛错）
    const bd = await buildUsageBreakdown({ range: '7', dim: 'day' });
    assert.equal(typeof bd, 'object');
    assert.notDeepEqual(bd, { injected: true });
  } finally {
    setUsageProvider(null);
  }
});

test('传 null 恢复默认实现，且不会自递归', async () => {
  setUsageProvider({ buildUsageStats: () => ({ injected: true }) });
  setUsageProvider(null);
  const r = await buildUsageStats({ range: '7' });
  assert.equal(typeof r, 'object');
  assert.notDeepEqual(r, { injected: true }, '应回到真实实现');
});

test('传非对象被忽略', () => {
  setUsageProvider('not-an-object');
  assert.equal(hasUsageProvider(), false);
  setUsageProvider(null);
});
