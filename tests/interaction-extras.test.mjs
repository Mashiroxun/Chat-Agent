// 互动扩展（0.4.9.3）：表情语义解析、名片点赞频控、群荣誉读取
//
// 这三块的共同点是"都往外伸手"——表情要点到正确的号上、点赞不能变成骚扰、
// 荣誉读取要能识别空数据。所以测试重点不在 happy path，而在边界。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-extras-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { buildToolDefs, executeTool } = await import('../src/tools.js');
const defs = buildToolDefs();

// 一份最小的系统表情目录：/赞 与 /微笑
// 注意：OneBotClient.call() 返回的是**已解包**的 data，mock 也要按这个形状给，
// 否则测试会替实现掩盖掉"多剥了一层"的错误。
const FACE_PACKS = {
  packs: [
    { pack_name: '基础', emojis: [
      { q_sid: '76', q_des: '/赞' },
      { q_sid: '14', q_des: '/微笑' },
      { q_sid: '178', q_des: '/捂脸' }
    ] }
  ]
};

function makeCtx({ kind = 'group', honors = null, signed = [] } = {}) {
  const calls = { react: [], recall: [], like: [], honor: [], signed: [] };
  const ctx = {
    chatKey: `${kind}:100`,
    kind,
    chatId: '100',
    selfId: '100086',
    selfNickname: '测试机器人',
    botName: '测试机器人',
    onebot: {
      fetchSysFaces: async () => FACE_PACKS,
      searchSysFaces: async () => ({ faces: [] }),
      sendLike: async (userId, times) => { calls.like.push({ userId, times }); return { status: 'ok' }; },
      getGroupHonor: async (gid, type) => {
        calls.honor.push({ gid, type });
        return honors ?? { current_talkative: null, talkative_list: [], performer_list: [], legend_list: [], emotion_list: [], strong_newbie_list: [] };
      },
      getGroupSignedList: async (gid) => { calls.signed.push({ gid }); return signed; }
    },
    sender: {
      react: async (chatKey, messageId, emojiId) => { calls.react.push({ chatKey, messageId, emojiId }); },
      recall: async (chatKey, messageId) => { calls.recall.push({ chatKey, messageId }); }
    },
    store: {
      findByMid: (_ck, mid) => (String(mid) === '12345' ? { mid: '12345', self: true } : null),
      activeMembers: () => [{ userId: '789', name: '张三' }],
      recent: () => []
    },
    memory: null, reminders: null, videoReader: null,
    session: { id: 's1', sent: [], trigger: [] },
    emit: () => {}
  };
  return { ctx, calls };
}

async function call(ctx, tool, args) {
  const r = await executeTool(defs, ctx, tool, JSON.stringify(args));
  let body = r.content;
  try { body = JSON.parse(r.content); } catch { /* 纯文本 */ }
  return { isError: r.isError === true, body };
}

// ── 表情语义解析 ─────────────────────────────────────────────

test('传中文名：按名字翻成 QQ 表情编号', async () => {
  const { ctx, calls } = makeCtx();
  const { isError, body } = await call(ctx, 'react_message', { messageId: 12345, emoji: '微笑' });
  assert.equal(isError, false);
  assert.equal(calls.react[0].emojiId, '14', '/微笑 对应 q_sid=14');
  assert.equal(body.emojiId, '14');
});

test('内置别名优先且与目录一致', async () => {
  const { ctx, calls } = makeCtx();
  await call(ctx, 'react_message', { messageId: 12345, emoji: '赞' });
  assert.equal(calls.react[0].emojiId, '76');
});

test('目录里没有的名字：拒绝，不瞎猜编号', async () => {
  const { ctx, calls } = makeCtx();
  const { isError, body } = await call(ctx, 'react_message', { messageId: 12345, emoji: '量子纠缠' });
  assert.equal(isError, true);
  assert.equal(calls.react.length, 0);
  assert.match(String(body), /不认识这个表情/);
});

test('目录取不到时，纯数字编号仍可用（不依赖索引）', async () => {
  const { ctx, calls } = makeCtx();
  ctx.onebot.fetchSysFaces = async () => { throw new Error('network down'); };
  const { isError } = await call(ctx, 'react_message', { messageId: 12345, emoji: '178' });
  assert.equal(isError, false);
  assert.equal(calls.react[0].emojiId, '178');
});

// ── 名片点赞 ────────────────────────────────────────────────

test('点赞：默认一次', async () => {
  const { ctx, calls } = makeCtx();
  const { isError, body } = await call(ctx, 'like_user', { userId: 789 });
  assert.equal(isError, false);
  assert.deepEqual(calls.like, [{ userId: 789, times: 1 }]);
  assert.equal(body.liked, true);
});

test('同一个人同一天第二次：必须拒绝，且不再发请求', async () => {
  const { ctx, calls } = makeCtx();
  // 频控是模块级的，用没被别的用例点过的号，自己制造"第一次 → 第二次"
  const first = await call(ctx, 'like_user', { userId: 792 });
  assert.equal(first.isError, false, '第一次应当成功');

  const { isError, body } = await call(ctx, 'like_user', { userId: 792 });
  assert.equal(isError, true);
  assert.equal(calls.like.length, 1, '去重发生在本地，不能靠协议端拦');
  assert.match(String(body), /今天已经给/);
});

test('不能给自己点赞', async () => {
  const { ctx, calls } = makeCtx();
  const { isError } = await call(ctx, 'like_user', { userId: 100086 });
  assert.equal(isError, true);
  assert.equal(calls.like.length, 0);
});

test('times 超上限时被夹到 10', async () => {
  const { ctx, calls } = makeCtx();
  await call(ctx, 'like_user', { userId: 791, times: 999 });
  assert.equal(calls.like[0].times, 10);
});

// ── 群荣誉 / 打卡 ────────────────────────────────────────────

test('私聊里调群荣誉：直接拒绝', async () => {
  const { ctx } = makeCtx({ kind: 'private' });
  const { isError, body } = await call(ctx, 'group_highlights', {});
  assert.equal(isError, true);
  assert.match(String(body), /只有群聊/);
});

test('荣誉数据为空：要说清"没有"，别让模型硬聊', async () => {
  const { ctx } = makeCtx();
  const { isError, body } = await call(ctx, 'group_highlights', { part: 'honor' });
  assert.equal(isError, false);
  assert.match(body.note, /暂时没有荣誉数据/);
});

test('有荣誉数据时给正常提示', async () => {
  const { ctx } = makeCtx({
    honors: { current_talkative: { user_id: 789, nickname: '张三', description: '' }, talkative_list: [], performer_list: [], legend_list: [], emotion_list: [], strong_newbie_list: [] }
  });
  const { body } = await call(ctx, 'group_highlights', { part: 'honor' });
  assert.match(body.note, /最活跃/);
  assert.equal(body.honor.current_talkative.nickname, '张三');
});

test('只看打卡时不请求荣誉接口', async () => {
  const { ctx, calls } = makeCtx({ signed: [{ user_id: 1 }, { user_id: 2 }] });
  const { body } = await call(ctx, 'group_highlights', { part: 'sign' });
  assert.equal(calls.honor.length, 0, 'part=sign 不该顺带打荣誉');
  assert.equal(body.signed, 2);
});

test('同一个人跨群也只点一次（名片赞是给这个人的，不是给群的）', async () => {
  const a = makeCtx();
  const b = makeCtx();
  b.ctx.chatKey = 'group:200';
  b.ctx.chatId = '200';

  const first = await call(a.ctx, 'like_user', { userId: 793 });
  assert.equal(first.isError, false, '第一次应当成功');

  const second = await call(b.ctx, 'like_user', { userId: 793 });
  assert.equal(second.isError, true, '换个群不该绕过频控');
  assert.equal(b.calls.like.length, 0);
});

test('只看打卡时，文案不能提"最活跃"（那是荣誉榜的说法）', async () => {
  const { ctx } = makeCtx({ signed: [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }] });
  const { body } = await call(ctx, 'group_highlights', { part: 'sign' });
  assert.match(body.note, /打卡/);
  assert.equal(String(body.note).includes('最活跃'), false);
});

test('轻量动作必须声明 delivered:false，否则会被补记成"发了消息"', async () => {
  // 这三个工具的 category 都是 messaging，会被 isDeliverTool 判成投递工具；
  // 它们又不往 session.sent 里记，若不明说，编排器会把它们补记成一条发言，
  // 进而触发"发言即收尾"，模型再没机会补话。
  const cases = [
    ['react_message', { messageId: 12345 }],
    ['recall_message', { messageId: 12345 }],
    ['like_user', { userId: 794 }]
  ];
  for (const [tool, args] of cases) {
    const { ctx } = makeCtx();
    const r = await executeTool(defs, ctx, tool, JSON.stringify(args));
    assert.equal(r.isError === true, false, tool + ' 不该报错');
    assert.equal(r.delivered, false, tool + ' 不是发言，必须显式声明');
  }
});

test('荣誉榜每个榜单最多 5 条（防止大群把上下文塞满）', async () => {
  const big = Array.from({ length: 40 }, (_, i) => ({ user_id: i + 1, nickname: 'u' + i }));
  const { ctx } = makeCtx({
    honors: { current_talkative: null, talkative_list: big, performer_list: big, legend_list: big, emotion_list: big, strong_newbie_list: big }
  });
  const { body } = await call(ctx, 'group_highlights', { part: 'honor' });
  for (const k of ['talkative_list', 'performer_list', 'legend_list', 'emotion_list', 'strong_newbie_list']) {
    assert.equal(body.honor[k].length, 5, k + ' 应截断到 5 条');
  }
});
