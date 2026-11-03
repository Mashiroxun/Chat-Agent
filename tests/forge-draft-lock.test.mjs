// 草稿写锁的行为约束（2026-10-28 审计修）。
//
// 这些用例存在的理由：锁是"多一道防线"的东西 —— 出错的两种方式都很隐蔽：
//   · 太紧：正常串行操作被拒（用户看到"草稿被占用"却没人占用），
//   · 太松：等于没加（两个请求照旧同时写）；
//   · 释放不干净：一次适配之后这个草稿永久不可写（要重启应用）。
// 全是纯内存逻辑，直接测比开 HTTP 稳。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireForgeDraftLock, forgeDraftLockHolder, __resetForgeDraftLocks
} from '../src/forge-draft-lock.js';

test.beforeEach(() => __resetForgeDraftLocks());

test('第一次能拿到，同一草稿第二次被拒并报出占用者', () => {
  const a = acquireForgeDraftLock('draft-1', '适配');
  assert.equal(typeof a.release, 'function');
  const b = acquireForgeDraftLock('draft-1', '安装');
  assert.equal(b.busy?.kind, '适配');
  assert.equal(b.release, undefined);
});

test('释放之后同一个草稿可以再取（串行操作不被误伤）', () => {
  const a = acquireForgeDraftLock('draft-1', '适配');
  a.release();
  assert.equal(forgeDraftLockHolder('draft-1'), null);
  const b = acquireForgeDraftLock('draft-1', '安装');
  assert.equal(typeof b.release, 'function');
  b.release();
});

test('重复释放是幂等的，且不会误删别人持有的锁', () => {
  const a = acquireForgeDraftLock('draft-1', '适配');
  a.release();
  a.release();                                   // 第二次不该抛
  const b = acquireForgeDraftLock('draft-1', '安装');
  assert.equal(typeof b.release, 'function');
  a.release();                                   // 旧句柄再释放一次：不能把 b 的锁删掉
  assert.equal(forgeDraftLockHolder('draft-1')?.kind, '安装');
});

test('不同草稿互不影响（两个草稿可以同时起草）', () => {
  const a = acquireForgeDraftLock('draft-1', '适配');
  const b = acquireForgeDraftLock('draft-2', '适配');
  assert.equal(typeof b.release, 'function');
  a.release();
  b.release();
});

test('没有 draftId（新建草稿）时直接放行，且 release 无副作用', () => {
  for (const empty of ['', '   ', null, undefined]) {
    const a = acquireForgeDraftLock(empty, '起草');
    assert.equal(typeof a.release, 'function');
    assert.equal(a.busy, undefined);
    a.release();
  }
  assert.equal(forgeDraftLockHolder(''), null);
});

test('draftId 归一化：前后空格视为同一份草稿（否则空格就能绕锁）', () => {
  const a = acquireForgeDraftLock(' draft-1 ', '适配');
  const b = acquireForgeDraftLock('draft-1', '安装');
  assert.equal(b.busy?.kind, '适配');
  a.release();
  assert.equal(forgeDraftLockHolder('draft-1'), null);
});
