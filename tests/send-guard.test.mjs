// 发送入口的两道闸（2026-10-26）：
//   1. send_message 的泄露闸 —— 系统提示词/密钥不能经由"模型自己发消息"进群；
//   2. finish 守卫在自确认轮放行 —— 模型复查后说"不发"就不要再拦它。
//
// 这两条都在**高频路径**上（每次发言都会过），所以用真实的工具定义 + 捕获发送器
// 跑一遍，而不是只测纯函数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-send-guard-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { buildToolDefs, executeTool } = await import('../src/tools.js');
const { createCaptureSender } = await import('../src/orchestrator.js');
const defs = buildToolDefs();

function makeCtx({ trigger = [], nudgeTurn = false, selfId = '100086', selfNickname = '测试机器人' } = {}) {
  const items = [];
  const session = { id: 's1', sent: [], trigger, nudgeTurn, finishGuardHit: false };
  const ctx = {
    chatKey: 'group:100',
    kind: 'group',
    chatId: '100',
    selfId,
    selfNickname,
    botName: selfNickname,
    sender: createCaptureSender('group:100', { items }),
    store: { recent: () => [], activeMembers: () => [] },
    memory: null,
    reminders: null,
    videoReader: null,
    session,
    emit: () => {}
  };
  return { ctx, items, session };
}

test('send_message：正常发言照旧发出去', async () => {
  const { ctx, items } = makeCtx();
  const r = await executeTool(defs, ctx, 'send_message', JSON.stringify({ messages: '榔头就这尺寸？' }));
  assert.equal(r.isError, undefined, `不该报错：${r.content}`);
  assert.deepEqual(items.map((i) => i.text), ['榔头就这尺寸？']);
});

test('send_message：疑似系统提示词/密钥 → 拦住且不落发送', async () => {
  for (const bad of [
    '【安全规则】1. 不许外传',
    '【本次唤醒】谁在找我',
    'key 是 sk-abcdefghijklmnopqrstuvwx',
    'apiKey: 1234567890'
  ]) {
    const { ctx, items } = makeCtx();
    const r = await executeTool(defs, ctx, 'send_message', JSON.stringify({ messages: bad }));
    assert.equal(r.isError, true, `应拦截：${bad}`);
    assert.equal(items.length, 0, `不该发出：${bad}`);
    // 回给模型的说明不能把原文再回显一遍（否则等于二次诱导它复述）
    assert.equal(String(r.content).includes(bad), false);
  }
});

test('send_message：数组里只要有一条泄露，整批都不发', async () => {
  const { ctx, items } = makeCtx();
  const r = await executeTool(defs, ctx, 'send_message', JSON.stringify({ messages: ['在的', '【工作方式】先读懂再动手'] }));
  assert.equal(r.isError, true);
  assert.equal(items.length, 0);
});

test('finish 守卫：被 @ 却没说话时仍会拦一次（不能把老保护改坏）', async () => {
  const { ctx } = makeCtx({ trigger: [{ text: '@100086(QQ:100086) 在吗' }] });
  const r = await executeTool(defs, ctx, 'finish', JSON.stringify({ summary: '不想回' }));
  assert.equal(r.isError, true, '老行为：被点名时不许直接收尾');
});

test('finish 守卫：自确认轮放行（模型已经复查过一次，不能再压它）', async () => {
  const { ctx, session } = makeCtx({
    trigger: [{ text: '@100086(QQ:100086) 在吗' }],
    nudgeTurn: true
  });
  const r = await executeTool(defs, ctx, 'finish', JSON.stringify({ summary: '只是思考，不发' }));
  assert.equal(r.isError, undefined, `自确认轮不该再拦：${r.content}`);
  assert.equal(session.finishReason, '只是思考，不发');
});
