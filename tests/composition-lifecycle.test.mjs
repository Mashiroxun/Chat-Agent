// 启动组合生命周期测试（0.4.9.3 / 2026-11-04）
//
// 覆盖：逆序释放、注销、幂等、错误隔离、signal、已停止后拒绝登记。
// 外加一个集成用例：验证 console.routes 层能拿到 lifecycle 并登记清理。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCompositionLifecycle } from '../src/composition/lifecycle.js';
import { createRoutes } from '../src/routes.js';

test('清理函数按登记的逆序执行（LIFO）', async () => {
  const lc = createCompositionLifecycle();
  const order = [];
  lc.onStop(() => order.push('a'));
  lc.onStop(() => order.push('b'));
  lc.onStop(() => order.push('c'));
  await lc.close();
  assert.deepEqual(order, ['c', 'b', 'a']);
});

test('支持异步清理函数', async () => {
  const lc = createCompositionLifecycle();
  const order = [];
  lc.onStop(async () => { await Promise.resolve(); order.push('async'); });
  lc.onStop(() => order.push('sync'));
  await lc.close();
  assert.deepEqual(order, ['sync', 'async']);
});

test('onStop 返回的注销函数能撤销登记', async () => {
  const lc = createCompositionLifecycle();
  let called = 0;
  const off = lc.onStop(() => { called += 1; });
  off();
  off(); // 重复注销不应报错
  await lc.close();
  assert.equal(called, 0);
});

test('close() 幂等，清理只跑一次', async () => {
  const lc = createCompositionLifecycle();
  let n = 0;
  lc.onStop(() => { n += 1; });
  const p1 = lc.close();
  const p2 = lc.close();
  assert.equal(p1, p2, '应返回同一个 promise');
  await p1;
  await p2;
  assert.equal(n, 1);
});

test('单个清理抛错不阻断其它，最后聚合', async () => {
  const lc = createCompositionLifecycle();
  const done = [];
  lc.onStop(() => { done.push('first'); });
  lc.onStop(() => { throw new Error('boom'); });
  lc.onStop(() => { done.push('last'); });
  await assert.rejects(lc.close(), (e) => e instanceof AggregateError && e.errors.length === 1);
  assert.deepEqual(done, ['last', 'first'], '抛错的那个前后都要继续执行');
});

test('close() 会 abort signal', async () => {
  const lc = createCompositionLifecycle();
  assert.equal(lc.signal.aborted, false);
  const closing = lc.close();
  assert.equal(lc.signal.aborted, true);
  await closing;
});

test('cancel() 只中断，不执行清理', () => {
  const lc = createCompositionLifecycle();
  let n = 0;
  lc.onStop(() => { n += 1; });
  lc.cancel();
  assert.equal(lc.signal.aborted, true);
  assert.equal(n, 0);
});

test('已停止后 onStop 拒绝登记；非函数参数报 TypeError', async () => {
  const lc = createCompositionLifecycle();
  assert.throws(() => lc.onStop('not-a-function'), TypeError);
  await lc.close();
  assert.throws(() => lc.onStop(() => {}), /已停止/);
});

// ── 集成：覆盖层通过 deps 拿到 lifecycle ────────────────────────────
function baseDeps(extra = {}) {
  return {
    store: {}, memory: {}, sessions: {}, onebot: {}, orchestrator: {},
    emit() {}, log() {},
    readBody: async () => ({}), authorize: () => true,
    ...extra,
  };
}

test('console.routes 层能拿到 lifecycle 并登记清理', async () => {
  const lc = createCompositionLifecycle();
  let disposed = 0;
  const routes = createRoutes(baseDeps({
    lifecycle: lc,
    components: {
      'console.routes': (deps) => {
        assert.equal(deps.lifecycle, lc, '层应该拿到同一个 lifecycle');
        deps.lifecycle.onStop(() => { disposed += 1; });
        return [{ method: 'GET', pattern: '/api/lifecycle-test', handler: () => 'ok' }];
      },
    },
  }));
  assert.equal(routes[0].pattern, '/api/lifecycle-test');
  assert.equal(disposed, 0, '登记时不执行');
  await lc.close();
  assert.equal(disposed, 1, 'close 时执行层的清理函数');
});
