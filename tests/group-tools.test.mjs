// 新增的四个查询/转发工具（0.4.9.3）
//
// 共同的坑在「返回结构不确定」：协议端对公告、系统消息的返回形状各实现不一，
// 所以这三个只读工具都必须能在空数据/异形数据下给出可读结论，而不是抛异常
// 或者把 undefined 塞给模型。forward_recent 的重点则是跨会话转发那道白名单闸。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-newtools-'));
process.env.QQ_AGENT_DATA_DIR = TMP;
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ version: 1 }), 'utf8');

const { buildToolDefs, executeTool } = await import('../src/tools.js');
const defs = buildToolDefs();

function makeCtx({ kind = 'group', notices = [], sysMsgs = [], reactions = [], history = [] } = {}) {
  const calls = { forward: [] };
  const ctx = {
    chatKey: `${kind}:100`,
    kind,
    chatId: '100',
    selfId: '100086',
    selfNickname: '测试机器人',
    botName: '测试机器人',
    onebot: {
      getGroupNotice: async () => notices,
      getGroupSystemMsg: async () => sysMsgs,
      getMsgEmojiLikes: async () => reactions
    },
    sender: {
      sendForward: async (chatKey, nodes, opts) => { calls.forward.push({ chatKey, nodes, opts }); return { message_id: 'fw1' }; }
    },
    store: {
      recent: () => history,
      findByMid: () => null,
      activeMembers: () => [],
      listChats: () => []
    },
    memory: null, reminders: null, videoReader: null,
    session: { id: 's1', sent: [], trigger: [] },
    emit: () => {}
  };
  return { ctx, calls };
}

async function call(ctx, tool, args = {}) {
  const r = await executeTool(defs, ctx, tool, JSON.stringify(args));
  let body = r.content;
  try { body = JSON.parse(r.content); } catch { /* 纯文本 */ }
  return { isError: r.isError === true, body };
}

// ── 群公告 ────────────────────────────────────────────────

test('群公告：私聊直接拒绝', async () => {
  const { ctx } = makeCtx({ kind: 'private' });
  const { isError, body } = await call(ctx, 'group_notice');
  assert.equal(isError, true);
  assert.match(String(body), /只有群聊/);
});

test('群公告：没有公告时给出人话，而不是空对象', async () => {
  const { ctx } = makeCtx({ notices: [] });
  const { isError, body } = await call(ctx, 'group_notice');
  assert.equal(isError, false);
  assert.equal(body.count, 0);
  assert.match(body.note, /没有设置公告/);
});

test('群公告：SnowLuma 真实形状（正文在 message.text，图片在 message.images）', async () => {
  // 2026-11-11 协议端实测结构。旧实现只读顶层 text/content/images，
  // 结果是「接口 200、5 条公告正文全空、图片数全 0」，静默失效。
  const { ctx } = makeCtx({
    notices: [{
      notice_id: 'abc',
      sender_id: 1829346737,
      publish_time: 1700000000,
      send_to_new_members: true,
      message: { text: '本群禁止发广告', image: [{ id: '1' }], images: [{ id: '1' }, { id: '2' }] }
    }]
  });
  const { isError, body } = await call(ctx, 'group_notice');
  assert.equal(isError, false);
  assert.equal(body.count, 1);
  assert.equal(body.notices[0].text, '本群禁止发广告', '正文必须取到，不能是空串');
  assert.equal(body.notices[0].imageCount, 2);
  assert.equal(body.notices[0].newMemberNotice, true);
  assert.ok(body.notices[0].time, 'publish_time 要转成本地时间');
});

test('群公告：正文里的 HTML 实体要还原，别让模型念 &nbsp;', async () => {
  const { ctx } = makeCtx({
    notices: [{ message: { text: '第一行&#10;第二行&nbsp;结束&amp;继续' }, send_to_new_members: false }]
  });
  const { body } = await call(ctx, 'group_notice');
  assert.equal(body.notices[0].text, '第一行\n第二行 结束&继续');
  assert.ok(!body.notices[0].text.includes('&nbsp;'));
});

test('群公告：异形返回（顶层 text / 对象包一层）也不能崩', async () => {
  const { ctx } = makeCtx();
  ctx.onebot.getGroupNotice = async () => ({ notices: [{ text: '包了一层的公告', images: [] }] });
  const { isError, body } = await call(ctx, 'group_notice');
  assert.equal(isError, false);
  assert.equal(body.count, 1);
  assert.equal(body.notices[0].text, '包了一层的公告');
});

test('群公告：条数多时只给前 5 条，但 total 要报真实总数', async () => {
  const { ctx } = makeCtx({ notices: Array.from({ length: 12 }, (_, i) => ({ message: { text: `公告${i}` } })) });
  const { body } = await call(ctx, 'group_notice');
  assert.equal(body.count, 5);
  assert.equal(body.total, 12);
  assert.match(body.note, /共 12 条/);
});

// ── 群系统消息 ────────────────────────────────────────────

test('群系统消息：空列表说清"没有"，不返回 undefined', async () => {
  const { ctx } = makeCtx({ sysMsgs: [] });
  const { body } = await call(ctx, 'group_system_msg');
  assert.equal(body.count, 0);
  assert.match(body.note, /没有/);
});

test('群系统消息：有数据时原样给出前 10 条', async () => {
  const { ctx } = makeCtx({ sysMsgs: Array.from({ length: 20 }, (_, i) => ({ requester_uin: i + 1 })) });
  const { body } = await call(ctx, 'group_system_msg');
  assert.equal(body.count, 20);
  assert.equal(body.items.length, 10, '最多回 10 条，别把整页塞进上下文');
});

// ── 表情回应明细 ──────────────────────────────────────────

test('表情回应：没人点时的提示', async () => {
  const { ctx } = makeCtx({ reactions: [] });
  const { body } = await call(ctx, 'msg_reactions', { messageId: 12345 });
  assert.equal(body.count, 0);
  assert.match(body.note, /还没有人点表情/);
});

test('表情回应：解析编号/数量/用户，用户数截断', async () => {
  const { ctx } = makeCtx({
    reactions: [{ emoji_id: '76', count: 3, users: Array.from({ length: 30 }, (_, i) => ({ uin: 1000 + i })) }]
  });
  const { body } = await call(ctx, 'msg_reactions', { messageId: '#12345' });
  assert.equal(body.reactions[0].emojiId, '76');
  assert.equal(body.reactions[0].count, 3);
  assert.equal(body.reactions[0].users.length, 10);
});

test('表情回应：漏传 messageId 时拒绝', async () => {
  const { ctx } = makeCtx();
  const { isError } = await call(ctx, 'msg_reactions', {});
  assert.equal(isError, true);
});

// ── 合并转发 ──────────────────────────────────────────────

test('合并转发：节点顺序与历史一致，且发言人身份用协议端认得的 uin', async () => {
  // 2026-11-11 抓到的真 bug：只写 data.qq 时 SnowLuma 的 parseForwardNodes
  // 读的是 data.user_id / data.uin，qq 被静默忽略 → 所有话都挂到机器人自己名下。
  const history = [
    { self: false, senderId: '789', senderName: '张三', text: '第一句' },
    { self: true, senderId: 'self', senderName: '我', text: '第二句' }
  ];
  const { ctx, calls } = makeCtx({ history });
  const { isError, body } = await call(ctx, 'forward_recent', { count: 10 });

  assert.equal(isError, false);
  assert.equal(body.count, 2);
  const nodes = calls.forward[0].nodes;
  assert.equal(nodes[0].data.content[0].text, '第一句');
  assert.equal(nodes[0].data.uin, '789', '必须有 uin，SnowLuma 只认这个');
  assert.equal(nodes[0].data.qq, '789', '兼容其它 OneBot 实现，两个键同值');
  assert.notEqual(nodes[0].data.uin, ctx.selfId, '群友的话绝不能挂到机器人名下');
  assert.equal(nodes[0].data.name, '张三');
  assert.equal(nodes[1].data.content[0].text, '第二句');
  assert.equal(nodes[1].data.uin, '100086', '自己发的消息要填机器人自己的号');
  assert.equal(nodes[1].data.qq, '100086');
});

test('合并转发：每条节点都带非零 uin，且与 qq 一致', async () => {
  const history = Array.from({ length: 6 }, (_, i) => ({
    self: i === 3, senderId: `1000${i}`, senderName: `成员${i}`, text: `第${i}句`
  }));
  const { ctx, calls } = makeCtx({ history });
  await call(ctx, 'forward_recent', { count: 6 });
  const nodes = calls.forward[0].nodes;
  assert.equal(nodes.length, 6);
  for (const n of nodes) {
    assert.ok(n.data.uin && n.data.uin !== '0', 'uin 不能为空或 0');
    assert.equal(n.data.qq, n.data.uin);
  }
  assert.equal(nodes[3].data.uin, ctx.selfId);
});

test('合并转发：空白会话报错，不发空卡片', async () => {
  const { ctx, calls } = makeCtx({ history: [] });
  const { isError } = await call(ctx, 'forward_recent', { count: 5 });
  assert.equal(isError, true);
  assert.equal(calls.forward.length, 0);
});

test('合并转发：跨会话目标格式不对时拒绝', async () => {
  const { ctx, calls } = makeCtx({ history: [{ self: false, senderId: '1', senderName: 'a', text: 'x' }] });
  const { isError, body } = await call(ctx, 'forward_recent', { targetChatKey: '随便写的' });
  assert.equal(isError, true);
  assert.match(String(body), /group:群号/);
  assert.equal(calls.forward.length, 0);
});

test('合并转发：同会话时不走跨会话校验', async () => {
  const { ctx, calls } = makeCtx({ history: [{ self: false, senderId: '1', senderName: 'a', text: 'x' }] });
  const { isError } = await call(ctx, 'forward_recent', { targetChatKey: 'group:100' });
  assert.equal(isError, false, '目标就是当前会话，不该被跨会话开关拦住');
  assert.equal(calls.forward[0].chatKey, 'group:100');
});

test('合并转发：长文本被截断，避免单个节点撑爆卡片', async () => {
  const { ctx, calls } = makeCtx({ history: [{ self: false, senderId: '1', senderName: 'a', text: 'x'.repeat(5000) }] });
  await call(ctx, 'forward_recent', { count: 1 });
  assert.ok(calls.forward[0].nodes[0].data.content[0].text.length <= 2000);
});
