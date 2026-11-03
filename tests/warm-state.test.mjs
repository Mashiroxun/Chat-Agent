// 预热状态重置测试（0.4.9.3）
//
// resetWarmState 是这轮新加的：五个 Map/Set 之前散在模块顶部，没有重置入口，
// 测试之间会互相污染（上个用例预热过的 shape，下个用例直接命中缓存）。
// 这里锁住「重置后全部归零」这个契约。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resetWarmState, warmStateSnapshot } from '../src/cache-warm.js';

test('初始快照各计数为数字', () => {
  const snap = warmStateSnapshot();
  for (const k of ['warmed', 'tiers', 'earlyDone', 'lastOk', 'pending']) {
    assert.equal(typeof snap[k], 'number', `${k} 应该是数字`);
  }
  assert.equal(typeof snap.timerActive, 'boolean');
});

test('重置后全部归零', () => {
  resetWarmState();
  const snap = warmStateSnapshot();
  assert.deepEqual(
    { warmed: snap.warmed, tiers: snap.tiers, earlyDone: snap.earlyDone, lastOk: snap.lastOk, pending: snap.pending },
    { warmed: 0, tiers: 0, earlyDone: 0, lastOk: 0, pending: 0 },
  );
  assert.equal(snap.timerActive, false);
});

test('重复调用幂等', () => {
  resetWarmState();
  resetWarmState();
  const snap = warmStateSnapshot();
  assert.equal(snap.warmed + snap.tiers + snap.earlyDone + snap.lastOk + snap.pending, 0);
});
