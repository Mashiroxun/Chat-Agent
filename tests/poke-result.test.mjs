// send_poke 的回执（0.4.9.3）
//
// 背景：事件流里的文案是「[拍一拍] 张三(QQ:789) 拍了拍 我」，方向是【对方→自己】；
// 而 send_poke 是【自己→对方】。旧回执只有 `{ poked: true }`，两段信息叠在同一
// 上下文里，模型会把刚发出去的那一拍认成"有人在拍我"，再对着自己的动作回应一遍。
//
// 这里锁住三件事：方向必须显式给出、目标身份必须带回来、拍自己不能写成"你拍对方"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-poke-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { buildToolDefs, executeTool } = await import('../src/tools.js');
const defs = buildToolDefs();

function makeCtx({ kind = 'group', chatId = '100', selfId = '100086', members = [], recent = [] } = {}) {
  const pokes = [];
  const ctx = {
    chatKey: `${kind}:${chatId}`,
    kind,
    chatId,
    selfId,
    selfNickname: '测试机器人',
    botName: '测试机器人',
    sender: { poke: async (chatKey, target) => { pokes.push({ chatKey, target }); } },
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
  return { ctx, pokes };
}

async function callPoke(ctx, args) {
  const r = await executeTool(defs, ctx, 'send_poke', JSON.stringify(args));
  let body = r.content;
  try { body = JSON.parse(r.content); } catch { /* 错误文案不是 JSON */ }
  return { isError: r.isError === true, body };
}

test('群聊拍指定成员：回执带方向与目标身份', async () => {
  const { ctx, pokes } = makeCtx({ members: [{ userId: '789', name: '张三' }] });
  const { isError, body } = await callPoke(ctx, { targetUserId: 789 });

  assert.equal(isError, false);
  assert.deepEqual(pokes, [{ chatKey: 'group:100', target: 789 }], '拍一拍应真的发出去');
  assert.equal(body.poked, true);
  assert.equal(body.direction, 'self→target', '方向必须显式给出，否则模型会认成被拍');
  assert.deepEqual(body.chat, { kind: 'group', id: '100' });
  assert.equal(body.target.userId, 789);
  assert.equal(body.target.name, '张三');
  assert.equal(body.target.isSelf, false);
  assert.match(body.text, /你拍对方/, '一句话要把方向说死');
  assert.match(body.text, /不是对方拍你/);
});

test('活跃成员里没有时，昵称回落到最近的会话记录', async () => {
  const { ctx } = makeCtx({
    members: [],
    recent: [{ self: false, senderId: '791', senderName: '王五' }]
  });
  const { body } = await callPoke(ctx, { targetUserId: 791 });
  assert.equal(body.target.name, '王五');
  assert.match(body.text, /王五\(QQ:791\)/);
});

test('两边都取不到昵称时只给 QQ 号，不编名字', async () => {
  const { ctx } = makeCtx({ members: [], recent: [] });
  const { body } = await callPoke(ctx, { targetUserId: 792 });
  assert.equal(body.target.name, null);
  assert.match(body.text, /QQ:792/);
  assert.equal(String(body.text).includes('undefined'), false);
});

test('拍自己：文案不能说「你拍对方」', async () => {
  const { ctx } = makeCtx({ selfId: '100086' });
  const { body } = await callPoke(ctx, { targetUserId: 100086 });
  assert.equal(body.target.isSelf, true);
  assert.match(body.text, /拍了拍自己/);
  assert.equal(body.text.includes('你拍对方'), false, '自拍是另一种方向，不能套用对方文案');
});

test('私聊不传 targetUserId：回执补上对方 QQ，不能是空目标', async () => {
  const { ctx, pokes } = makeCtx({ kind: 'private', chatId: '790', members: [] });
  const { isError, body } = await callPoke(ctx, {});

  assert.equal(isError, false);
  assert.deepEqual(pokes, [{ chatKey: 'private:790', target: null }], '私聊仍按 null 发，由协议端取会话对侧');
  assert.equal(body.target.userId, 790, '回执必须让模型知道拍了谁');
  assert.equal(body.chat.kind, 'private');
});

test('群聊漏传 targetUserId：拒绝并给出可选成员', async () => {
  const { ctx, pokes } = makeCtx({ members: [{ userId: '789', name: '张三' }] });
  const { isError, body } = await callPoke(ctx, {});

  assert.equal(isError, true);
  assert.equal(pokes.length, 0, '参数不全时不该发出去');
  assert.match(String(body), /必须传 targetUserId/);
  assert.match(String(body), /张三：789/);
});

test('非法 QQ 号：拒绝且不发', async () => {
  const { ctx, pokes } = makeCtx({});
  const { isError, body } = await callPoke(ctx, { targetUserId: '张三' });
  assert.equal(isError, true);
  assert.equal(pokes.length, 0);
  assert.match(String(body), /正整数的 QQ 号/);
});
