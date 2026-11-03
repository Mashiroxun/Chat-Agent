// thinking 历史回传（DeepSeek V3.2+/V4.x 协议）—— 2026-10-24 修 400 时补。
//
// 背景：请求带 tools 时，DeepSeek 要求每条历史 assistant 的 reasoning_content
// 原样回传，否则工具循环第二轮 400：
//   The `reasoning_content` in the thinking mode must be passed back to the API.
// 0.4.9.0 之前 assistantEntry 只保留 content/tool_calls/raw，reasoning 被丢弃；
// retry-advisor 的词表也不认这句话，于是既不重试也不补数据，直接走 fallback。
//
// 覆盖三件事：
//   1. looksLikeThinkingRejection 认得「必须回传」型错误，且不误报模型名/Key 类错误；
//   2. applyHistoryReasoning 只在 deepseek + 带 tools 时落 reasoning_content，其余方言丢弃；
//   3. stripPrivateMessageFields 发送前清掉 `_` 前缀字段，且不破坏 orchestrator 复用的 messages。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-thinking-test-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const dialects = await import('../plugins/thinking-adapters/dialects.js');
const adapters = await import('../plugins/thinking-adapters/index.js');
const llm = await import('../src/llm.js');
const history = await import('../src/reasoning-history.js');

const REAL_ERROR = 'The `reasoning_content` in the thinking mode must be passed back to the API. '
  + '(request_id: 89e3c6b8-ff0c-4765-a986-dfecb43012ba)';

test('looksLikeThinkingRejection：认得「必须回传」型（曾经漏判的根本原因）', () => {
  assert.equal(dialects.looksLikeThinkingRejection(REAL_ERROR), true);
  // 无反引号变体也要认
  assert.equal(dialects.looksLikeThinkingRejection(
    'reasoning_content in the thinking mode must be passed back to the API'), true);
  // 中文表述
  assert.equal(dialects.looksLikeThinkingRejection('reasoning_content 必须回传给 API'), true);
});

test('looksLikeThinkingRejection：不误报非思考类错误', () => {
  // 模型名里带 thinking：以前加宽词表时踩过的误报，必须继续挡住
  assert.equal(dialects.looksLikeThinkingRejection('invalid model name: deepseek-thinking'), false);
  assert.equal(dialects.looksLikeThinkingRejection('Invalid API key provided'), false);
  assert.equal(dialects.looksLikeThinkingRejection('insufficient balance'), false);
});

test('looksLikeThinkingRejection：原有「参数不合法」型仍然认（回归）', () => {
  assert.equal(dialects.looksLikeThinkingRejection('{"error":{"message":"thinking: invalid parameter"}}'), true);
  assert.equal(dialects.looksLikeThinkingRejection("'reasoning_effort' is not supported"), true);
});

test('applyHistoryReasoning：deepseek + 带 tools -> 落成 reasoning_content', () => {
  const body = {
    tools: [{ type: 'function', function: { name: 'send_message' } }],
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }], _reasoning: '先想一下' },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' }
    ]
  };
  const out = adapters.internals.applyHistoryReasoning(body, 'deepseek');
  const asst = out.messages[2];
  assert.equal(asst.reasoning_content, '先想一下');
  assert.equal('_reasoning' in asst, false);
  // 其余消息原样
  assert.equal(out.messages[0].content, 'sys');
  assert.equal(out.messages[3].role, 'tool');
  // 不可变：原 body 里的私有字段还在（orchestrator 后续轮次还要用）
  assert.equal(body.messages[2]._reasoning, '先想一下');
});

test('applyHistoryReasoning：不带 tools -> 丢弃（官方规则：可选且忽略）', () => {
  const body = {
    messages: [{ role: 'assistant', content: 'x', _reasoning: '思考' }]
  };
  const out = adapters.internals.applyHistoryReasoning(body, 'deepseek');
  assert.equal('_reasoning' in out.messages[0], false);
  assert.equal('reasoning_content' in out.messages[0], false);
});

test('applyHistoryReasoning：非 deepseek 方言 -> 一律丢弃（避免未知字段 400）', () => {
  const body = {
    tools: [{ type: 'function', function: { name: 'f' } }],
    messages: [{ role: 'assistant', content: 'x', _reasoning: '思考' }]
  };
  for (const dialect of ['openai-o', 'anthropic', 'qwen', 'generic']) {
    const out = adapters.internals.applyHistoryReasoning(body, dialect);
    assert.equal('_reasoning' in out.messages[0], false, dialect);
    assert.equal('reasoning_content' in out.messages[0], false, dialect);
  }
});

test('applyHistoryReasoning：没有私有字段时返回原 body 引用（零开销）', () => {
  const body = { tools: [], messages: [{ role: 'user', content: 'x' }] };
  assert.equal(adapters.internals.applyHistoryReasoning(body, 'deepseek'), body);
});

test('stripPrivateMessageFields：发送前清掉 _ 前缀字段，且不破坏原数组', () => {
  const messages = [
    { role: 'assistant', content: '', _reasoning: '思考', tool_calls: [{ id: 'c1' }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' }
  ];
  const out = llm.stripPrivateMessageFields({ model: 'm', messages });
  assert.equal('_reasoning' in out.messages[0], false);
  assert.equal(out.messages[0].tool_calls.length, 1);
  assert.equal(out.messages[1].content, 'ok');
  // ⚠️ 原数组必须保留 _reasoning：orchestrator 的 messages 在工具循环里复用，
  //    就地删除会让后续轮次无 reasoning 可回传（等于没修）。
  assert.equal(messages[0]._reasoning, '思考');
});

test('stripPrivateMessageFields：无私有字段时原样返回', () => {
  const body = { messages: [{ role: 'user', content: 'x' }] };
  assert.equal(llm.stripPrivateMessageFields(body), body);
});

test('端到端拼装：assistant 思考 -> 下一轮请求体（有 reasoning_content、无私有字段）', () => {
  // 模拟 orchestrator 工具循环：第一轮 assistant 存了 _reasoning
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '查天气' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }], _reasoning: '需要调用天气工具' },
    { role: 'tool', tool_call_id: 'c1', content: '{"c":18}' }
  ];
  const withParams = adapters.internals.applyHistoryReasoning(
    { model: 'deepseek-flash', tools: [{ type: 'function', function: { name: 'f' } }], messages },
    'deepseek');
  const finalBody = llm.stripPrivateMessageFields(withParams);

  assert.equal(finalBody.messages[2].reasoning_content, '需要调用天气工具');
  assert.equal('_reasoning' in finalBody.messages[2], false);
  // 整个请求体里不允许出现任何 `_` 开头字段
  for (const m of finalBody.messages) {
    assert.equal(Object.keys(m).some((k) => k.startsWith('_')), false);
  }
});

test('assistantHistoryEntry：带思考的轮次自动附 _reasoning，不带则不加', () => {
  const msg = { content: '', tool_calls: [{ id: 'c1' }], reasoning_content: '先查再答' };
  const entry = history.assistantHistoryEntry(msg);
  assert.equal(entry.role, 'assistant');
  assert.equal(entry._reasoning, '先查再答');
  assert.deepEqual(entry.tool_calls, msg.tool_calls);

  // 模型没思考（reasoning_content 为空/缺失）时不产生私有字段
  const plain = history.assistantHistoryEntry({ content: 'hi' });
  assert.equal('_reasoning' in plain, false);

  // extra 可覆盖 tool_calls（inline 解析会换合成 id）
  const rewritten = history.assistantHistoryEntry(msg, { tool_calls: [{ id: 'inline_0_0' }] });
  assert.equal(rewritten.tool_calls[0].id, 'inline_0_0');
});

test('attachReasoning：msg 优先，缺失时用 Skill 归一化的 fallback', () => {
  const entry = { role: 'assistant', content: '' };
  history.attachReasoning(entry, { reasoning_content: '来自 msg' }, '来自 fallback');
  assert.equal(entry._reasoning, '来自 msg');

  const entry2 = { role: 'assistant', content: '' };
  history.attachReasoning(entry2, { content: '' }, '来自 fallback');
  assert.equal(entry2._reasoning, '来自 fallback');

  // 两处都没有：不产生字段
  const entry3 = { role: 'assistant', content: '' };
  history.attachReasoning(entry3, { content: '' }, '');
  assert.equal('_reasoning' in entry3, false);
});
