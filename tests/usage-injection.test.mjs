// 用量统计注入测试（0.4.9.3，0.4.9.4 补数据目录隔离）
//
// data.usage 用 provider hook 实现：只覆盖两个主入口（buildUsageStats /
// buildUsageBreakdown），30 处调用点零改动。
// 这里锁住「默认不接管 / 覆盖生效 / 只覆盖一个方法另一个走默认 / 可恢复」。
//
// ⚠️⚠️ 数据目录隔离（0.4.9.4 / B1，2026-11-14 修）—— 改动前必读
//     `src/config.js` 的 DATA_DIR 与 `src/usage-stats.js` 的 USAGE_DAILY_FILE
//     都是**模块加载时**求值的常量。下面 `buildUsageStats({range:'7'})` 走的是
//     真实实现，它内部会 pruneUsageDaily() + saveUsageDaily() 真的写盘
//     （src/usage-stats.js:1122-1125 → :510 mkdirSync / :512 writeFileSync）。
//     所以旧版本（静态 import + 不设 env）跑一次测试，就把**真实数据目录**的
//     usage-daily.json 覆盖成 57 B / days:{} —— 实测本机
//     resources/app/data/usage-daily.json 就是这么被写成 57 B 的，
//     而且 :514 的 catch{} 把写失败也吞了，整个过程完全无声。
//
//     修法与 tests/avatar-cache.test.mjs:13-20 完全一致：
//       ① 先 mkdtempSync 建临时目录 → ② 写 process.env.QQ_AGENT_DATA_DIR
//       → ③ **之后**才 await import() 业务模块（静态 import 会被提升到
//       env 赋值之前执行，等于没修）→ ④ after() 里删掉临时目录。
//
//     验收方式（别只看测试绿）：跑测试前后对
//       <安装目录>/data/usage-daily.json
//       <安装目录>/resources/app/data/usage-daily.json
//     取 md5 + mtime，必须完全不变。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-usage-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

// ↓ 必须动态 import：DATA_DIR / USAGE_DAILY_FILE 在模块求值时就被定死了
const {
  setUsageProvider, hasUsageProvider,
  buildUsageStats, buildUsageBreakdown,
} = await import('../src/usage-stats.js');

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

test('数据目录已隔离到临时目录（否则下面三个用例会写真实数据）', () => {
  assert.equal(process.env.QQ_AGENT_DATA_DIR, tmp);
  assert.ok(tmp.startsWith(os.tmpdir()), '临时目录必须落在系统 tmp 下');
  assert.ok(fs.statSync(tmp).isDirectory(), '临时目录必须存在且是目录');
});

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
