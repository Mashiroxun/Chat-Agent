// 0.4.9.3 新增工具的「协议端真实返回形状」契约测试。
//
// 为什么要单独一份：之前两轮 bug（call() 解包、qq vs uin、公告正文在 message.text）
// 全是同一个病根 —— 测试桩按「我们以为的形状」造数据，断言跟实现错得一模一样，
// 接口 200、功能却静默失效，测试还全绿。
//
// 本文件的 fixture 全部来自 2026-11-11 对 SnowLuma 2.1.1 的**真实只读探测**，
// 字段名 / 嵌套层级 / 值类型保持一致，仅把真实群号、昵称、公告正文换成示例值。
// 协议端升级导致形状变化时，这里会第一时间红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-real-shapes-'));
process.env.QQ_AGENT_DATA_DIR = TMP;
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ version: 1 }), 'utf8');

const { buildToolDefs, executeTool } = await import('../src/tools.js');
const defs = buildToolDefs();

// ── 协议端实测 fixture ────────────────────────────────────────────
// _get_group_notice → Array<{ notice_id, sender_id, publish_time,
//                             send_to_new_members, message:{ text, image, images } }>
const REAL_NOTICES = [
  {
    notice_id: 'df831f120000000098a0e66aaf650c00',
    sender_id: 1829346737,
    publish_time: 1793499288,
    send_to_new_members: false,
    message: { text: '第一行&#10;第二行&nbsp;结束&amp;继续', image: [], images: [] }
  },
  {
    notice_id: 'df831f120000000098a0e66aaf650c01',
    sender_id: 1829346737,
    publish_time: 1793499200,
    send_to_new_members: true,
    message: { text: '新成员请看群规', image: [{ id: 'img1' }], images: [{ id: 'img1' }, { id: 'img2' }] }
  }
];

// get_group_system_msg → Array<{ group_id, group_name, request_id, requester_uin,
//                               requester_nick, invitor_uin, invitor_nick,
//                               message, checked, flag }>
const REAL_SYS_MSGS = [{
  group_id: 2153083512,
  group_name: '示例群',
  request_id: 1793264934684295,
  requester_uin: 10001,
  requester_nick: '小鲸鱼',
  invitor_uin: 3100919560,
  invitor_nick: '二鸟清风',
  message: '',
  checked: true,
  flag: 'slreq:1:1793264934684295'
}];

// get_msg_emoji_likes → Array<{ emoji_id, emoji_type, count,
//                               last_reaction_time, users:[{ user_id }] }>
// ⚠️ 真实字段是 user_id，不是 uin —— 工具里两个都兼容才对。
const REAL_REACTIONS = [{
  emoji_id: '462',
  emoji_type: 1,
  count: 2,
  last_reaction_time: 1794382903,
  users: [{ user_id: 10001 }, { user_id: 10002 }]
}];

// get_group_honor_info → Object（不是 { data }），字段全在顶层
const REAL_HONOR = {
  group_id: 987654321,
  current_talkative: null,
  talkative_list: [],
  performer_list: [],
  legend_list: [],
  emotion_list: [],
  strong_newbie_list: []
};
// get_group_signed_list → Array<{ user_id, nick, time, rank }>（不是 { data: [] }）
const REAL_SIGNED = [{ user_id: 2596451551, nick: 'Mfuan001', time: 1794326916, rank: 1 }];

function makeCtx(overrides = {}) {
  const calls = { forward: [] };
  const ctx = {
    chatKey: 'group:100',
    kind: 'group',
    chatId: '100',
    selfId: '100086',
    selfNickname: '测试机器人',
    botName: '测试机器人',
    onebot: {
      getGroupNotice: async () => REAL_NOTICES,
      getGroupSystemMsg: async () => REAL_SYS_MSGS,
      getMsgEmojiLikes: async () => REAL_REACTIONS,
      getGroupHonor: async () => REAL_HONOR,
      getGroupSignedList: async () => REAL_SIGNED,
      fetchSysFaces: async () => ({ packs: [] })
    },
    sender: {
      sendForward: async (chatKey, nodes, opts) => { calls.forward.push({ chatKey, nodes, opts }); return { message_id: 'fw1' }; }
    },
    store: {
      recent: () => overrides.history ?? [],
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

// ── 群公告 ────────────────────────────────────────────────────────

test('真实公告形状：正文、图片数、新成员标识、时间、总数全部取到', async () => {
  const { ctx } = makeCtx();
  const { isError, body } = await call(ctx, 'group_notice');
  assert.equal(isError, false);
  assert.equal(body.count, 2);
  assert.equal(body.total, 2);
  assert.equal(body.notices[0].text, '第一行\n第二行 结束&继续', 'HTML 实体要还原');
  assert.equal(body.notices[0].imageCount, 0);
  assert.equal(body.notices[0].newMemberNotice, false);
  assert.ok(body.notices[0].time, 'publish_time 要转成本地时间');
  assert.equal(body.notices[1].text, '新成员请看群规');
  assert.equal(body.notices[1].imageCount, 2, '图片在 message.images 里');
  assert.equal(body.notices[1].newMemberNotice, true);
});

// ── 群系统消息 ────────────────────────────────────────────────────

test('真实系统消息形状：字段原样保留，count 是总数', async () => {
  const { ctx } = makeCtx();
  const { isError, body } = await call(ctx, 'group_system_msg');
  assert.equal(isError, false);
  assert.equal(body.count, 1);
  assert.equal(body.items[0].requester_nick, '小鲸鱼');
  assert.equal(body.items[0].requester_uin, 10001);
  assert.equal(body.items[0].checked, true);
});

// ── 表情回应 ──────────────────────────────────────────────────────

test('真实表情回应形状：users 里的 user_id 要解析成 QQ 号', async () => {
  const { ctx } = makeCtx();
  const { isError, body } = await call(ctx, 'msg_reactions', { messageId: '#-105389447' });
  assert.equal(isError, false);
  assert.equal(body.count, 1);
  assert.equal(body.reactions[0].emojiId, '462');
  assert.equal(body.reactions[0].count, 2);
  assert.deepEqual(body.reactions[0].users, ['10001', '10002']);
});

// ── 荣誉 / 打卡 ───────────────────────────────────────────────────

test('真实荣誉+打卡形状：打卡数组应该数出 1 人，不是 0', async () => {
  const { ctx } = makeCtx();
  const { isError, body } = await call(ctx, 'group_highlights');
  assert.equal(isError, false);
  assert.equal(body.signed, 1, 'get_group_signed_list 返回的是数组，不是 {data:[]}');
  assert.ok(body.honor, 'get_group_honor_info 返回对象，字段在顶层');
  assert.equal(body.honor.talkative_list.length, 0);
  assert.match(body.note, /没有荣誉数据/);
});

test('只看打卡时文案不能串成荣誉榜说法', async () => {
  const { ctx } = makeCtx();
  const { body } = await call(ctx, 'group_highlights', { part: 'sign' });
  assert.equal(body.signed, 1);
  assert.ok(body.honor === undefined, 'part=sign 不该去取荣誉');
  assert.match(body.note, /今天签到/);
  assert.doesNotMatch(body.note, /最活跃/);
});

// ── 合并转发 ──────────────────────────────────────────────────────

test('真实存档条目 → 转发节点必须带 SnowLuma 认得的 uin', async () => {
  const { ctx, calls } = makeCtx({
    history: [
      { self: false, senderId: '2596451551', senderName: 'Mfuan001', text: '群友说的话' },
      { self: true, senderId: 'self', senderName: '我', text: '我回的一句' }
    ]
  });
  const { isError, body } = await call(ctx, 'forward_recent', { count: 10 });
  assert.equal(isError, false);
  assert.equal(body.count, 2);
  const nodes = calls.forward[0].nodes;
  // SnowLuma parseForwardNodes(): toPositiveInt(nodeData.user_id ?? nodeData.uin)
  assert.equal(nodes[0].data.uin, '2596451551');
  assert.equal(nodes[0].data.qq, '2596451551');
  assert.notEqual(nodes[0].data.uin, ctx.selfId);
  assert.equal(nodes[0].data.name, 'Mfuan001');
  assert.equal(nodes[0].data.content[0].text, '群友说的话');
  assert.equal(nodes[1].data.uin, '100086');
  assert.equal(nodes[1].data.content[0].text, '我回的一句');
  // 契约：节点里不能有 undefined / null，协议端会把它们当异常字段
  for (const n of nodes) {
    const d = n.data;
    assert.equal(n.type, 'node');
    for (const [k, v] of Object.entries(d)) {
      assert.ok(v !== undefined && v !== null, `节点字段 ${k} 不该是 ${v}`);
    }
    assert.match(d.uin, /^\d+$/, 'uin 必须是纯数字字符串，toPositiveInt 才吃得下');
  }
});
