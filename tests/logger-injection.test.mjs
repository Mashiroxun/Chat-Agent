// 日志出口注入测试（0.4.9.3）
//
// logger 用 let + live binding 导出，29 个文件都是 `import { logger }` 直用。
// 这里锁住「能换、能恢复、形状不对不生效」三条契约。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { logger, setLogger } from '../src/logger.js';

test('替换后 logger 指向新实例', () => {
  const original = logger;
  const hits = [];
  const fake = {
    debug() {}, info(...a) { hits.push(a); }, warn() {}, error() {},
  };
  try {
    setLogger(fake);
    assert.equal(logger, fake);
    logger.info('mod', 'hello');
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0], ['mod', 'hello']);
  } finally {
    setLogger(original);
  }
});

test('传 null 恢复默认 Logger', () => {
  const original = logger;
  try {
    setLogger(null);
    assert.notEqual(logger, original);
    assert.equal(logger.constructor.name, 'Logger');
  } finally {
    setLogger(original);
  }
});

test('缺少必需方法的实例被忽略', () => {
  const original = logger;
  try {
    setLogger({ info() {} });          // 缺 debug / warn / error
    assert.equal(logger, original, '不应该换成残缺实例');
  } finally {
    setLogger(original);
  }
});

test('完整接口的实例可接受（含额外方法）', () => {
  const original = logger;
  const fake = { debug() {}, info() {}, warn() {}, error() {}, recent: () => [] };
  try {
    setLogger(fake);
    assert.equal(logger, fake);
  } finally {
    setLogger(original);
  }
});
