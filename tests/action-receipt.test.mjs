// 互动类工具的动作回执（0.4.9.3）
//
// 背景：原来 send_message 只回 { sent, messageIds }，模型不知道 @ 的是谁、
// 引用的是哪条。@ 填了个不在群里的号、或协议端把 @ 吃掉时，它同样不知道，
// 下一轮就按"我已经叫过他了"继续说话 —— 与 send_poke 的指向问题是同一类。
//
// 这里锁住 actionLanding() 的契约：落点必须结构化、认不出人的 @ 必须能被识别。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-receipt-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { buildToolDefs, executeTool } = await import('../src/tools.js');
const defs = buildToolDefs();

function makeCtx({ members = [], recent = [] } = {}) {
  const calls = [];
  let seq = 0;
  const ctx = {
    chatKey: 'group:100',
    kind: 'group',
    chatId: '100',
    selfId: '100086',
    selfNickname: '测试机器人',
    botName: '测试机器人',
    sender: {
      sendTextBatch: async (chatKey, messages, opts) => {
        calls.push({ chatKey, messages, opts });
        return {
          sent: messages.map((text) => ({ text, messageId: `m${++seq}`, at: '12:00' })),
          failed: []
        };
      }
    },
    store: {
      activeMembers: () => members,
      recent: () => recent
    },
    memory: null,
    reminders: null,
    videoReader: null,
    session: { id: 's1', sent: [], trigger: [] },
    emit: () => {}
  };
  return { ctx, calls };
}

async function callSend(ctx, args) {
  const r = await executeTool(defs, ctx, 'send_message', JSON.stringify(args));
  let body = r.content;
  try { body = JSON.parse(r.content); } catch { /* 错误文案 */ }
  return { isError: r.isError === true, body };
}

test('@ 到已知成员：回执带上 userId 与展示名', async () => {
  const { ctx } = makeCtx({ members: [{ userId: '789', name: '张三' }] });
  const { body } = await callSend(ctx, { messages: '在吗', atUserId: 789 });

  assert.equal(body.sent, 1);
  assert.deepEqual(body.chat, { kind: 'group', id: '100' });
  assert.equal(body.at.userId, 789);
  assert.equal(body.at.name, '张三');
  assert.equal(body.at.label, '张三(QQ:789)');
  assert.equal(body.at.resolved, true, '认得出来的人才算 @ 成功');
});

test('@ 到认不出的号：resolved 必须是 false，模型据此判断 @ 可能没生效', async () => {
  const { ctx } = makeCtx({ members: [], recent: [] });
  const { body } = await callSend(ctx, { messages: '在吗', atUserId: 999 });

  assert.equal(body.at.userId, 999);
  assert.equal(body.at.name, null);
  assert.equal(body.at.label, 'QQ:999');
  assert.equal(body.at.resolved, false);
});

test('昵称回落到最近记录', async () => {
  const { ctx } = makeCtx({ members: [], recent: [{ self: false, senderId: '791', senderName: '王五' }] });
  const { body } = await callSend(ctx, { messages: '早', atUserId: 791 });
  assert.equal(body.at.name, '王五');
  assert.equal(body.at.resolved, true);
});

test('不带 @ 时必须回 null，不能是空串或空对象', async () => {
  const { ctx } = makeCtx();
  const { body } = await callSend(ctx, { messages: '随便说说' });
  assert.equal(body.at, null);
  assert.equal(body.replyTo, null);
});

test('引用某条消息：replyTo 回字符串 id，保证多轮后还能核对引的是哪条', async () => {
  const { ctx, calls } = makeCtx();
  const { body } = await callSend(ctx, { messages: '接上句', replyToMessageId: 12345 });
  assert.equal(body.replyTo, '12345');
  assert.equal(calls[0].opts.replyToMessageId, 12345, '原值仍按数字传给 sender');
});

test('@ 只挂在第一条上，但回执对整批都有效', async () => {
  const { ctx, calls } = makeCtx({ members: [{ userId: '789', name: '张三' }] });
  const { body } = await callSend(ctx, { messages: ['第一句', '第二句'], atUserId: 789 });
  assert.equal(body.sent, 2);
  assert.deepEqual(calls[0].messages, ['第一句', '第二句']);
  assert.equal(body.at.resolved, true);
});
