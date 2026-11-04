// 目标渠道注入测试（0.4.9.3）
//
// llm.target：控制"本次请求用哪个 baseUrl / key / 协议"。
// 用途是按群切渠道、故障转移、灰度。返回对象必须带非空 baseUrl，否则回落默认。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setApiProvider, hasApiProvider, __effectiveApiForTest } from '../src/llm.js';

test('默认不接管', () => {
  setApiProvider(null);
  assert.equal(hasApiProvider(), false);
});

test('注入后 effectiveApi 返回注入对象', () => {
  const target = { baseUrl: 'https://custom.example/v1', apiKey: 'k', model: 'm', protocol: 'openai' };
  setApiProvider(() => target);
  try {
    assert.equal(hasApiProvider(), true);
    assert.equal(__effectiveApiForTest(), target);
  } finally {
    setApiProvider(null);
  }
});

test('缺 baseUrl 时回落默认解析', () => {
  setApiProvider(() => ({ apiKey: 'k' }));   // 没有 baseUrl
  try {
    const r = __effectiveApiForTest();
    assert.notEqual(r.apiKey, 'k', '不应采用缺 baseUrl 的注入结果');
    assert.equal(typeof r, 'object');
  } finally {
    setApiProvider(null);
  }
});

test('baseUrl 为空白串也回落', () => {
  setApiProvider(() => ({ baseUrl: '   ', apiKey: 'k' }));
  try {
    const r = __effectiveApiForTest();
    assert.notEqual(r.apiKey, 'k');
  } finally {
    setApiProvider(null);
  }
});

test('传 null 恢复默认；非函数被忽略', () => {
  setApiProvider(() => ({ baseUrl: 'https://x/v1' }));
  setApiProvider(null);
  assert.equal(hasApiProvider(), false);

  setApiProvider('not-a-function');
  assert.equal(hasApiProvider(), false);
  setApiProvider(null);
});
