// 表情目录拿不到时的降级契约（2026-11-11）。
//
// 独立成文件的原因：表情目录是 tools.js 的**模块级缓存**（成功 1 小时 / 失败 5 分钟），
// 同一个进程里一旦被建立或被标记失败，后续用例就看不到真实分支了。node --test
// 每个文件独立进程，所以这里专测「目录不可用」这一条路。
//
// ⚠️ 也正因为缓存是模块级的，**本文件内的用例共享同一份冷却状态**：
//    第一个触发失败的用例会把 faceIndexFailAt 写进模块，之后的用例永远处于冷却期。
//    所以这里统一用一个 SHARED 计数器 + prime() 显式建立失败状态，
//    断言一律写「累计调用次数」，不假设自己是第一个跑的。
//
// 修之前的行为：每次 react_message 都重新请求 fetch_sys_faces 并等满超时，
// 文案统一说「不认识这个表情」——模型会挨个换名字重试，每次都再等一轮超时。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildToolDefs, executeTool } = await import('../src/tools.js');
const defs = buildToolDefs();

const SHARED = { calls: 0, ctx: null };

function makeCtx() {
  return {
    kind: 'group', chatId: '100', chatKey: 'group:100',
    selfId: '100086', selfNickname: '机器人', botName: '机器人',
    session: { pastStateCount: 0 },
    store: {
      findByMid: () => ({ self: true, senderId: '100086', senderName: '我', text: 'x' }),
      activeMembers: () => [],
      recent: () => []
    },
    sender: { react: async () => ({ ok: true }) },
    onebot: {
      fetchSysFaces: async () => { SHARED.calls += 1; throw new Error('OneBot fetch_sys_faces 超时（15 秒未完成）'); }
    }
  };
}

function sharedCtx() {
  if (!SHARED.ctx) SHARED.ctx = makeCtx();
  return SHARED.ctx;
}

async function call(ctx, args) {
  const r = await executeTool(defs, ctx, 'react_message', JSON.stringify(args));
  return { isError: r.isError === true, raw: String(r.content ?? '') };
}

/** 建立一次「目录不可用」状态；已经处于冷却期时不会新增协议端调用。 */
async function prime() {
  return call(sharedCtx(), { messageId: 0, emoji: '笑' });
}

test('目录不可用：不瞎猜表情，明确让模型改用编号', async () => {
  const { isError, raw } = await prime();

  assert.equal(isError, true);
  assert.equal(SHARED.calls, 1, '首次要真的打一次协议端，不能凭空判定不可用');
  assert.match(raw, /读不到表情目录/, '要说明是目录的问题，不是名字的问题');
  assert.match(raw, /不要反复换中文名重试/, '要明确阻止模型换名字重来');
  assert.match(raw, /\d+\s*=\s*赞/, '要给出可直接用的编号');
});

test('目录不可用后短期不再重试：连续点三次仍只打一次协议端', async () => {
  await prime();
  const before = SHARED.calls;
  const ctx = sharedCtx();

  await call(ctx, { messageId: 1, emoji: '笑' });
  await call(ctx, { messageId: 2, emoji: '哭' });
  await call(ctx, { messageId: 3, emoji: '无语' });

  assert.equal(SHARED.calls, before, '失败要缓存 5 分钟，不能让每次点表情都等一轮超时');
  assert.equal(before, 1, '整个进程里目录请求只发生过一次');
});

test('目录不可用时数字编号照常可用（不依赖目录）', async () => {
  await prime();
  const before = SHARED.calls;
  const ctx = sharedCtx();

  let reacted = null;
  ctx.sender.react = async (_ck, _mid, emojiId) => { reacted = emojiId; };
  const { isError } = await call(ctx, { messageId: 2, emoji: '178' });

  assert.equal(isError, false);
  assert.equal(reacted, '178');
  assert.equal(SHARED.calls, before, '数字编号不应再触发目录请求');
});
