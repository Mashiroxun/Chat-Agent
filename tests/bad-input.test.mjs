// 0.4.9.3 新增工具的畸形输入契约（2026-11-11 模糊测试补）。
//
// 505 次畸形调用抓到 6 类问题：messageId 传对象会变成 "[object Object]"
// 继续往协议端跑、错误文案里印出字面量 "undefined"、表情回应用户列表里
// 混进 "" 和 "[object Object]"。这里把修法锁住，防止以后又退化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-bad-input-'));
process.env.QQ_AGENT_DATA_DIR = TMP;
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ version: 1 }), 'utf8');

const { buildToolDefs, executeTool } = await import('../src/tools.js');
const defs = buildToolDefs();

function makeCtx({ found = { self: true, senderName: '我' }, reactions = [] } = {}) {
  const calls = { react: [], recall: [], likes: [] };
  const ctx = {
    chatKey: 'group:100', kind: 'group', chatId: '100',
    selfId: '100086', selfNickname: '测试机器人', botName: '测试机器人',
    onebot: {
      fetchSysFaces: async () => ({ packs: [] }),
      getMsgEmojiLikes: async (mid) => { calls.likes.push(mid); return reactions; },
      sendLike: async () => ({})
    },
    sender: {
      react: async (...a) => { calls.react.push(a); return {}; },
      recall: async (...a) => { calls.recall.push(a); return {}; }
    },
    store: {
      findByMid: () => found,
      recent: () => [], activeMembers: () => [], listChats: () => []
    },
    memory: null, reminders: null, videoReader: null,
    session: { id: 's1', sent: [], trigger: [] }, emit: () => {}
  };
  return { ctx, calls };
}

async function call(ctx, tool, args) {
  const r = await executeTool(defs, ctx, tool, JSON.stringify(args));
  let body = r.content;
  try { body = JSON.parse(r.content); } catch { /* 纯文本 */ }
  return { isError: r.isError === true, body };
}

// ── messageId 格式校验 ────────────────────────────────────────────

test('react_message：messageId 是对象时必须拒绝，且绝不发请求', async () => {
  const { ctx, calls } = makeCtx();
  const { isError, body } = await call(ctx, 'react_message', { messageId: {}, emoji: 'like' });
  assert.equal(isError, true);
  assert.match(String(body), /数字编号/);
  assert.equal(calls.react.length, 0);
  assert.doesNotMatch(String(body), /\[object Object\]/);
});

test('recall_message：messageId 是数组时必须拒绝，且绝不删消息', async () => {
  const { ctx, calls } = makeCtx();
  const { isError } = await call(ctx, 'recall_message', { messageId: [1, 2] });
  assert.equal(isError, true);
  assert.equal(calls.recall.length, 0);
});

test('msg_reactions：messageId 畸形时不能拿去问协议端', async () => {
  const { ctx, calls } = makeCtx({ reactions: [{ emoji_id: '76', count: 1, users: [] }] });
  const { isError } = await call(ctx, 'msg_reactions', { messageId: { a: 1 } });
  assert.equal(isError, true);
  assert.equal(calls.likes.length, 0, '不能把 "[object Object]" 发给协议端');
});

test('负数 messageId 必须放行（QQ 的 message_id 是有符号 int32）', async () => {
  const { ctx, calls } = makeCtx();
  const { isError, body } = await call(ctx, 'react_message', { messageId: '#-105389447', emoji: 'like' });
  assert.equal(isError, false, `不该报错：${JSON.stringify(body)}`);
  assert.equal(body.messageId, '-105389447');
  assert.equal(calls.react[0][1], '-105389447');
});

// ── 错误文案 ──────────────────────────────────────────────────────

test('like_user：没传 userId 时错误文案不能印出字面量 undefined', async () => {
  const { ctx } = makeCtx();
  const { isError, body } = await call(ctx, 'like_user', {});
  assert.equal(isError, true);
  assert.match(String(body), /没传/);
  assert.doesNotMatch(String(body), /undefined/);
});

// ── 协议返回的脏值 ────────────────────────────────────────────────

test('msg_reactions：users 里的 null / {} 不能变成 "" 或 "[object Object]"', async () => {
  const { ctx } = makeCtx({
    reactions: [{ emoji_id: '462', count: 2, users: [null, {}, { user_id: 10001 }, 'oops'] }]
  });
  const { isError, body } = await call(ctx, 'msg_reactions', { messageId: 123 });
  assert.equal(isError, false);
  assert.deepEqual(body.reactions[0].users, ['10001']);
  assert.doesNotMatch(JSON.stringify(body), /\[object Object\]/);
});

test('msg_reactions：全脏的回应数组要落成「没有人点表情」，count 与列表对齐', async () => {
  const { ctx } = makeCtx({ reactions: [null, {}] });
  const { isError, body } = await call(ctx, 'msg_reactions', { messageId: 123 });
  assert.equal(isError, false);
  assert.equal(body.count, 0);
  assert.match(body.note, /还没有人点表情/);
});
