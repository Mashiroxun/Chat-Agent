// react_message：给消息点表情（0.4.9.3）
//
// 这个工具存在的理由是「别人发图不该被评价」。它必须做到两件事：
//   1. 真的只点表情，不产生发言；
//   2. 回执说清「你没有发言」，否则下一轮模型会以为自己已经说过话了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-react-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { buildToolDefs, executeTool } = await import('../src/tools.js');
const defs = buildToolDefs();

function makeCtx({ known = ['12345'], members = [] } = {}) {
  const reacts = [];
  const ctx = {
    chatKey: 'group:100',
    kind: 'group',
    chatId: '100',
    selfId: '100086',
    selfNickname: '测试机器人',
    botName: '测试机器人',
    sender: {
      react: async (chatKey, messageId, emojiId) => { reacts.push({ chatKey, messageId, emojiId }); }
    },
    store: {
      findByMid: (_ck, mid) => (known.includes(String(mid)) ? { mid: String(mid), text: '[图片]' } : null),
      activeMembers: () => members,
      recent: () => known.map((m) => ({ mid: m }))
    },
    memory: null,
    reminders: null,
    videoReader: null,
    session: { id: 's1', sent: [], trigger: [] },
    emit: () => {}
  };
  return { ctx, reacts };
}

async function callReact(ctx, args) {
  const r = await executeTool(defs, ctx, 'react_message', JSON.stringify(args));
  let body = r.content;
  try { body = JSON.parse(r.content); } catch { /* 错误文案 */ }
  return { isError: r.isError === true, body };
}

test('正常点表情：只调 react，不产生任何发言', async () => {
  const { ctx, reacts } = makeCtx();
  const { isError, body } = await callReact(ctx, { messageId: 12345 });

  assert.equal(isError, false);
  assert.deepEqual(reacts, [{ chatKey: 'group:100', messageId: '12345', emojiId: '76' }]);
  assert.equal(body.reacted, true);
  assert.equal(body.emojiId, '76', '不传 emoji 时默认赞');
  assert.deepEqual(body.chat, { kind: 'group', id: '100' });
});

test('回执必须声明"没有发言"，避免模型误以为自己说过话', async () => {
  const { ctx } = makeCtx();
  const { body } = await callReact(ctx, { messageId: '12345' });
  assert.match(body.text, /并没有发言/);
});

test('带 # 前缀的 id 也能用', async () => {
  const { ctx, reacts } = makeCtx();
  const { isError } = await callReact(ctx, { messageId: '#12345' });
  assert.equal(isError, false);
  assert.equal(reacts[0].messageId, '12345');
});

test('直接给数字编号时原样透传', async () => {
  const { ctx, reacts } = makeCtx();
  const { body } = await callReact(ctx, { messageId: 12345, emoji: '178' });
  assert.equal(reacts[0].emojiId, '178');
  assert.equal(body.emojiId, '178');
});

test('不认识的表情名：拒绝，且不发请求', async () => {
  const { ctx, reacts } = makeCtx();
  const { isError, body } = await callReact(ctx, { messageId: 12345, emoji: '笑哭' });
  assert.equal(isError, true);
  assert.equal(reacts.length, 0);
  assert.match(String(body), /不认识这个表情/);
});

test('消息不存在：拒绝并给出可见 id', async () => {
  const { ctx, reacts } = makeCtx({ known: ['999'] });
  const { isError, body } = await callReact(ctx, { messageId: 12345 });
  assert.equal(isError, true);
  assert.equal(reacts.length, 0);
  assert.match(String(body), /找不到消息/);
});

test('漏传 messageId：拒绝', async () => {
  const { ctx, reacts } = makeCtx();
  const { isError } = await callReact(ctx, {});
  assert.equal(isError, true);
  assert.equal(reacts.length, 0);
});
