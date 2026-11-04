// 提示词片段注入测试（0.4.9.3）
//
// core.prompt.pastState / core.prompt.anchor 是**用户消息**里【过去状态】段的构造逻辑。
// 用户消息每轮都变、按全价计费，所以"历史怎么选"直接影响成本。
//
// 契约：同步、形状不对就回落默认、可恢复。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  setPromptProviders, promptProviderState,
  anchorChunkFor, buildPastState,
} from '../src/prompt.js';

const fakeStore = {
  recent: () => [],
};

test('默认不接管', () => {
  setPromptProviders({});
  assert.deepEqual(promptProviderState(), { pastState: false, anchor: false });
});

test('覆盖 anchor 后 anchorChunkFor 走注入实现', () => {
  setPromptProviders({ anchor: (max) => max * 3 });
  try {
    assert.equal(anchorChunkFor(10), 30);
  } finally {
    setPromptProviders({});
  }
});

test('anchor 返回值非法时回落默认', () => {
  const normal = anchorChunkFor(80);
  setPromptProviders({ anchor: () => 'not-a-number' });
  try {
    assert.equal(anchorChunkFor(80), normal, '非法返回值应回落');
  } finally {
    setPromptProviders({});
  }
  setPromptProviders({ anchor: () => 0 });
  try {
    assert.equal(anchorChunkFor(80), normal, '0 也算非法（chunk 至少 1）');
  } finally {
    setPromptProviders({});
  }
});

test('覆盖 pastState 后 buildPastState 走注入实现', () => {
  setPromptProviders({ pastState: () => ({ text: '注入的过去状态', count: 3, messages: [] }) });
  try {
    const r = buildPastState(fakeStore, 'group:1', { limit: 10 });
    assert.equal(r.text, '注入的过去状态');
    assert.equal(r.count, 3);
  } finally {
    setPromptProviders({});
  }
});

test('pastState 形状不对时回落默认（不把半成品塞进提示词）', () => {
  setPromptProviders({ pastState: () => ({ count: 1 }) });   // 缺 text
  try {
    const r = buildPastState(fakeStore, 'group:1', { limit: 0 });
    assert.equal(typeof r.text, 'string', '应回落到默认实现');
  } finally {
    setPromptProviders({});
  }
});

test('只覆盖一个不影响另一个', () => {
  setPromptProviders({ anchor: () => 42 });
  try {
    assert.deepEqual(promptProviderState(), { pastState: false, anchor: true });
    assert.equal(anchorChunkFor(10), 42);
    const r = buildPastState(fakeStore, 'group:1', { limit: 0 });
    assert.equal(typeof r.text, 'string', 'pastState 仍走默认');
  } finally {
    setPromptProviders({});
  }
});
