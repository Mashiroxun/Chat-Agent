// recall_message：撤回自己的消息（0.4.9.3）
//
// 协议端（delete_msg）只认 message_id、不问消息是谁的 —— 也就是说
// "能不能撤"这件事完全靠上层挡。这个测试存在的唯一目的就是守住那道闸：
// 一旦有人把 entry.self 判断删掉，模型就获得了删别人发言的能力。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-recall-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { buildToolDefs, executeTool } = await import('../src/tools.js');
const defs = buildToolDefs();

function makeCtx(entries = {}) {
  const recalls = [];
  const ctx = {
    chatKey: 'group:100',
    kind: 'group',
    chatId: '100',
    selfId: '100086',
    selfNickname: '测试机器人',
    botName: '测试机器人',
    sender: {
      recall: async (chatKey, messageId) => { recalls.push({ chatKey, messageId }); }
    },
    store: {
      findByMid: (_ck, mid) => entries[String(mid)] || null,
      activeMembers: () => [],
      recent: () => Object.keys(entries).map((m) => ({ mid: m }))
    },
    memory: null,
    reminders: null,
    videoReader: null,
    session: { id: 's1', sent: [], trigger: [] },
    emit: () => {}
  };
  return { ctx, recalls };
}

async function callRecall(ctx, args) {
  const r = await executeTool(defs, ctx, 'recall_message', JSON.stringify(args));
  let body = r.content;
  try { body = JSON.parse(r.content); } catch { /* 错误文案 */ }
  return { isError: r.isError === true, body };
}

test('撤回自己发的消息：正常执行', async () => {
  const { ctx, recalls } = makeCtx({ 12345: { mid: '12345', self: true, senderName: '我' } });
  const { isError, body } = await callRecall(ctx, { messageId: 12345 });

  assert.equal(isError, false);
  assert.deepEqual(recalls, [{ chatKey: 'group:100', messageId: '12345' }]);
  assert.equal(body.recalled, true);
  assert.equal(body.messageId, '12345');
});

test('撤别人的消息：必须拒绝，且不发任何请求', async () => {
  const { ctx, recalls } = makeCtx({ 12345: { mid: '12345', self: false, senderName: '张三' } });
  const { isError, body } = await callRecall(ctx, { messageId: 12345 });

  assert.equal(isError, true);
  assert.equal(recalls.length, 0, '越权请求绝不能发出去');
  assert.match(String(body), /只能撤回你自己发的消息/);
  assert.match(String(body), /张三/);
});

test('回执要提醒"撤回不等于没发生"', async () => {
  const { ctx } = makeCtx({ 12345: { mid: '12345', self: true } });
  const { body } = await callRecall(ctx, { messageId: 12345 });
  assert.match(body.text, /不会让他忘掉/);
});

test('带 # 前缀的 id 也能用', async () => {
  const { ctx, recalls } = makeCtx({ 12345: { mid: '12345', self: true } });
  const { isError } = await callRecall(ctx, { messageId: '#12345' });
  assert.equal(isError, false);
  assert.equal(recalls[0].messageId, '12345');
});

test('消息不存在：拒绝', async () => {
  const { ctx, recalls } = makeCtx({});
  const { isError } = await callRecall(ctx, { messageId: 99999 });
  assert.equal(isError, true);
  assert.equal(recalls.length, 0);
});

test('漏传 messageId：拒绝', async () => {
  const { ctx, recalls } = makeCtx({});
  const { isError } = await callRecall(ctx, {});
  assert.equal(isError, true);
  assert.equal(recalls.length, 0);
});
