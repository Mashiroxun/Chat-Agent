// 模型 API 报错的"说人话"规则测试（2026-11-04，R169）
//
// 背景：用户在会话页看到整串英文 JSON ——
//   模型 API HTTP 400: {"error":{"message":"safety check failed",
//   "type":"failed_precondition_error","code":"9"}}
// 根因是 error-l10n 的 CASES 里没有"内容审查"这一类，10 条规则全不匹配就退回原文。
//
// 这里锁两件事：
//   ① 该错误必须被识别成"被内容审核拦下了"（带四段中文文案）
//   ② 新规则**不能抢占别的错误** —— 规则表是按顺序第一条命中即返回，
//      插错位置会让参数错误/模型名错误等全部被误判成内容审查。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { explainApiError, extractServerMessage } from '../src/error-l10n.js';

const body = (obj) => JSON.stringify(obj);
const explain = (status, obj) => explainApiError({
  status,
  text: body(obj),
  model: 'test-model',
  message: `模型 API HTTP ${status}：${body(obj)}`,
});

test('safety check failed 被识别为内容审核，且给出四段中文', () => {
  const h = explain(400, {
    error: { message: 'safety check failed', type: 'failed_precondition_error', code: '9' }
  });
  assert.ok(h, '必须命中某条规则（不能退回原文）');
  assert.equal(h.title, '被内容审核拦下了');
  assert.match(h.what, /审核|审查/);
  assert.match(h.fix, /换|渠道/);
  assert.equal(h.target, null, '没有对应设置页，不应给跳转目标');
});

test('各类内容审查措辞都能认出来', () => {
  const samples = [
    'content filter triggered',
    'blocked by content policy',
    'flagged by the safety system',
    'moderation blocked',
    'sensitive content detected',
    '内容审核未通过',
    '请求触发内容安全策略',
  ];
  for (const m of samples) {
    const h = explain(400, { error: { message: m } });
    assert.equal(h?.title, '被内容审核拦下了', `未识别：${m}`);
  }
});

test('不误伤：参数 / 模型名 / 限流 / 权限仍各归其位', () => {
  const cases = [
    [400, { error: { message: "Unsupported parameter: 'temperature'" } }, '模型不认这个参数'],
    [400, { error: { message: 'Model not found: DS v41f' } }, '模型名填错了'],
    [429, { error: { message: 'Rate limit exceeded' } }, '请求太频繁了'],
    [401, { error: { message: 'Invalid API key' } }, 'API Key 不对'],
    [403, { error: { message: 'Forbidden' } }, '这个 Key 没权限'],
    [500, { error: { message: 'Internal server error' } }, null],
  ];
  for (const [status, obj, expectTitle] of cases) {
    const h = explain(status, obj);
    assert.notEqual(h?.title, '被内容审核拦下了', `被误判为内容审查：${JSON.stringify(obj)}`);
    if (expectTitle) assert.equal(h?.title, expectTitle, JSON.stringify(obj));
  }
});

test('403 的内容审查不能被「Key 没权限」抢先', () => {
  // 规则表按顺序第一条命中即返回；③（权限）的判据是 status===403，
  // 内容审查若排在它后面就会被吃掉，给用户指错方向（实测出现过）。
  const h = explain(403, { msg: '内容审核未通过，请修改后重试', code: 40003 });
  assert.equal(h?.title, '被内容审核拦下了');
});

test('不误伤：含 sensitive / flagged 但不属于审查的句子', () => {
  // 这两句是特意构造的边界：关键词出现了，但语义不是内容审查
  const samples = [
    'flagged as invalid param, please check field names',
    'sensitive information must not be included in system prompt',
  ];
  for (const m of samples) {
    const h = explain(400, { error: { message: m } });
    assert.notEqual(h?.title, '被内容审核拦下了', `误伤：${m}`);
  }
});

test('extractServerMessage 能从各家形状里抠出 message', () => {
  assert.equal(extractServerMessage('{"error":{"message":"safety check failed"}}'), 'safety check failed');
  assert.equal(extractServerMessage('{"message":"x"}'), 'x');
  assert.equal(extractServerMessage('{"error":"plain text error"}'), 'plain text error');
  // 非 JSON（HTML 错误页 / 纯文本）：剥标签压成一行返回，交给上层拼提示
  assert.equal(extractServerMessage('<html><body>502 Bad Gateway</body></html>'), '502 Bad Gateway');
  assert.equal(extractServerMessage('not json at all'), 'not json at all');
});

// ── 2026-11-11：纯文本模型收到带图请求 ───────────────────────────────
// 真机日志 20 次 [real:...] 400，原有规则一条都不命中 → 用户只看到英文 JSON。
test('模型只支持文本输入：给出可操作的中文解释', () => {
  const h = explain(400, {
    error: {
      message: 'model only supports text input; image, video and audio is not supported',
      type: 'invalid_request_error', code: '3'
    }
  });
  assert.ok(h, '必须命中，不能退回英文原文');
  assert.equal(h.title, '带图请求被服务商拒了');
  assert.match(h.what, /图片|视频/);
  // 2026-11-11 更正：主模型其实是原生多模态，不能再劝用户「换个能看图的模型」
  // 或断言「当前模型只接受文字」，那会把人引到完全错误的排查方向。
  assert.match(h.what, /不一定说明模型不能看图/);
  assert.doesNotMatch(h.fix, /把主模型换成多模态模型/);
  assert.match(h.fix, /视频输入/);
  assert.equal(h.target, 'settings-api');
});

test('④b 不抢占内容审核 / 上下文超长 / 参数错误 / 限流', () => {
  const cases = [
    [400, 'safety check failed', '被内容审核拦下了'],
    [400, 'context length exceeded', '上下文太长了'],
    [400, "Unsupported parameter: 'temperature'", '模型不认这个参数'],
    [429, 'rate limit exceeded', '请求太频繁了'],
  ];
  for (const [status, message, title] of cases) {
    const h = explain(status, { error: { message } });
    assert.equal(h?.title, title, `被 ④b 抢走：${message}`);
  }
});
