// 路由注入测试（0.4.9.3）
//
// 覆盖 console.routes 的三件事：能追加、能覆盖内置、坏形状不炸。
// 同时锁住 pattern 的两种写法（字符串精确匹配 / 正则 exec）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRoutes } from '../src/routes.js';

function baseDeps(extra = {}) {
  return {
    store: {}, memory: {}, sessions: {}, onebot: {}, orchestrator: {},
    emit() {}, log() {},
    readBody: async () => ({}),
    authorize: () => true,
    ...extra,
  };
}

const json = (res, code, body) => ({ code, body });

test('不传 components 时只返回内置路由', () => {
  const routes = createRoutes(baseDeps());
  assert.ok(routes.length > 100, `内置路由应有 100+ 条，实际 ${routes.length}`);
  assert.ok(routes.some((r) => r.pattern === '/api/composition'));
});

test('层路由能追加新 pattern', () => {
  const extra = [{ method: 'GET', pattern: '/api/my-thing', handler: () => 'mine' }];
  const routes = createRoutes(baseDeps({
    components: { 'console.routes': () => extra },
  }));
  assert.equal(routes[0].pattern, '/api/my-thing');
  assert.equal(routes[0].handler(), 'mine');
});

test('层路由排在内置前面，同 pattern 可覆盖', () => {
  const extra = [{ method: 'GET', pattern: '/api/composition', handler: () => 'overridden' }];
  const routes = createRoutes(baseDeps({
    components: { 'console.routes': () => extra },
  }));
  assert.equal(routes[0].pattern, '/api/composition');
  assert.equal(routes[0].handler(), 'overridden', '层路由应排在内置前面先匹配');
});

test('支持 RegExp pattern', () => {
  const extra = [{ method: 'GET', pattern: /^\/api\/regex\/\d+$/, handler: () => 'regex' }];
  const routes = createRoutes(baseDeps({
    components: { 'console.routes': () => extra },
  }));
  assert.ok(routes[0].pattern instanceof RegExp);
  assert.equal(routes[0].handler(), 'regex');
});

test('形状不合法的条目被跳过，合法条目仍生效', () => {
  const extra = [
    { method: 'GET', pattern: '/api/ok', handler: () => 'ok' },
    { method: 'GET' },                                   // 缺 pattern / handler
    { method: 'GET', pattern: '/api/no-handler' },        // 缺 handler
    { method: 'GET', pattern: 123, handler: () => 'x' },  // pattern 类型错
  ];
  const routes = createRoutes(baseDeps({
    components: { 'console.routes': () => extra },
  }));
  assert.equal(routes[0].pattern, '/api/ok');
  assert.ok(!routes.some((r) => r.pattern === '/api/no-handler'));
});

test('层组件返回非数组时回落到内置', () => {
  const builtin = createRoutes(baseDeps());
  const routes = createRoutes(baseDeps({
    components: { 'console.routes': () => 'not-an-array' },
  }));
  assert.equal(routes.length, builtin.length);
});

test('层组件抛错时回落到内置，不中断启动', () => {
  const builtin = createRoutes(baseDeps());
  const routes = createRoutes(baseDeps({
    components: { 'console.routes': () => { throw new Error('boom'); } },
  }));
  assert.equal(routes.length, builtin.length);
});

test('层组件不是函数时忽略', () => {
  const builtin = createRoutes(baseDeps());
  const routes = createRoutes(baseDeps({
    components: { 'console.routes': 'not-a-function' },
  }));
  assert.equal(routes.length, builtin.length);
});
