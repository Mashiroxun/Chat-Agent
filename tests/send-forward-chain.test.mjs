// sendForward / recall 走真实 SendQueue 闸门链的集成测试（2026-11-11）。
//
// 之前测这两个新动作都只 mock 了 `ctx.sender.sendForward`，等于把
// 白名单硬闸、限流、留档、onSent 整条链跳过了。这里用**真实 SendQueue**
// 跑一遍，确认新动作没有绕开任何一道老闸。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-send-forward-'));
process.env.QQ_AGENT_DATA_DIR = TMP;
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ version: 1 }), 'utf8');

const { SendQueue } = await import('../src/sender.js');
const { setConfigProvider } = await import('../src/config.js');

let cfg = {};
function useConfig(patch = {}) {
  cfg = {
    allow: { groups: ['100'], private: ['200'] },
    deny: {},
    allowAllWhenEmpty: false,
    send: { maxPerMinute: 80, maxPerHour: 1000, dedupeWindowMs: 0 },
    ...patch
  };
  setConfigProvider(() => cfg);
}
after(() => setConfigProvider(null));

function makeSender() {
  const calls = { forward: [], deleted: [], appended: [], recalled: [], sent: [] };
  const onebot = {
    sendForwardMsg: async (kind, id, messages, opts) => {
      calls.forward.push({ kind, id, messages, opts });
      return { message_id: 123456 };
    },
    deleteMsg: async (mid) => { calls.deleted.push(mid); return {}; }
  };
  const store = {
    appendSelf: (chatKey, entry) => calls.appended.push({ chatKey, entry }),
    markRecalled: (chatKey, mid) => calls.recalled.push({ chatKey, mid })
  };
  const q = new SendQueue({ onebot, store, onSent: (e) => calls.sent.push(e), log: () => {} });
  return { q, calls };
}

const NODES = [
  { type: 'node', data: { uin: '789', qq: '789', name: '张三', content: [{ type: 'text', text: '第一句' }] } },
  { type: 'node', data: { uin: '100086', qq: '100086', name: '我', content: [{ type: 'text', text: '第二句' }] } }
];

test('sendForward：白名单内走完整闸门链，payload / 留档 / onSent 都对', async () => {
  useConfig();
  const { q, calls } = makeSender();
  const data = await q.sendForward('group:100', NODES, { summary: '2 条聊天记录', source: '聊天记录' });
  assert.deepEqual(data, { message_id: 123456 });
  assert.equal(calls.forward.length, 1);
  const f = calls.forward[0];
  assert.equal(f.kind, 'group');
  assert.equal(f.id, '100');
  assert.equal(f.messages, NODES, '节点数组原样透传，不能被改写');
  assert.equal(f.opts.summary, '2 条聊天记录');
  assert.equal(f.opts.source, '聊天记录');
  assert.equal(calls.appended.length, 1);
  assert.equal(calls.appended[0].chatKey, 'group:100');
  assert.match(calls.appended[0].entry.text, /^\[合并转发\] 2 条聊天记录/);
  assert.equal(calls.appended[0].entry.mid, 123456);
  assert.equal(calls.sent.length, 1);
  assert.match(calls.sent[0].text, /\[合并转发\] 2 条/);
});

test('sendForward：群聊 payload 是 message_type=group + 数字 group_id', async () => {
  useConfig();
  const { q, calls } = makeSender();
  // 直接看 onebot 层收到的东西：SendQueue 把 kind/id 传给 OneBotClient.sendForwardMsg
  assert.equal(calls.forward.length, 0);
  await q.sendForward('group:100', NODES, {});
  assert.equal(calls.forward[0].kind, 'group');
  assert.equal(typeof calls.forward[0].id, 'string');
  assert.equal(Number(calls.forward[0].id), 100);
});

test('sendForward：白名单外的群被 #ensureAllowed 拦下，绝不外发', async () => {
  useConfig();
  const { q, calls } = makeSender();
  await assert.rejects(() => q.sendForward('group:999', NODES, {}), /不在白名单内/);
  assert.equal(calls.forward.length, 0);
  assert.equal(calls.appended.length, 0);
  assert.equal(calls.sent.length, 0, '被拦下的动作不能触发 onSent');
});

test('sendForward：deny 一票否决，allow 里也拦得住', async () => {
  useConfig({ deny: { group: ['100'] } });
  const { q, calls } = makeSender();
  await assert.rejects(() => q.sendForward('group:100', NODES, {}), /不在白名单内/);
  assert.equal(calls.forward.length, 0);
});

test('sendForward：私聊走 private 分支，不塞 group_id', async () => {
  useConfig();
  const { q, calls } = makeSender();
  await q.sendForward('private:200', NODES, {});
  assert.equal(calls.forward[0].kind, 'private');
  assert.equal(calls.forward[0].id, '200');
  assert.equal(calls.appended[0].chatKey, 'private:200');
});

test('sendForward：占用发送配额，超限时被 #checkRate 拦下', async () => {
  useConfig({ send: { maxPerMinute: 1, maxPerHour: 1000, dedupeWindowMs: 0 } });
  const { q, calls } = makeSender();
  await q.sendForward('group:100', NODES, {});
  await assert.rejects(() => q.sendForward('group:100', NODES, {}), /发送频率超限/);
  assert.equal(calls.forward.length, 1, '第二次不能真的发出去');
});

test('OneBotClient.sendForwardMsg：payload 字段名必须和 SnowLuma 参数表对得上', async () => {
  // SnowLuma index.mjs:12330 的 params：
  //   messages / message / message_type / group_id / user_id /
  //   ...forwardPreviewParams = { source, summary, prompt, news }
  // 写成别的名字（比如 target_id、content）不会被参数层拒绝，
  // 而是走到业务层才报「message/messages is required」—— 又一个静默坑。
  const { OneBotClient } = await import('../src/onebot.js');
  const c = new OneBotClient({ wsUrl: '', httpUrl: '', accessToken: '', httpToken: '' });
  const seen = [];
  c.call = async (action, payload) => { seen.push({ action, payload }); return { message_id: 1 }; };

  await c.sendForwardMsg('group', '100', NODES, { summary: '2 条', source: '聊天记录' });
  assert.equal(seen[0].action, 'send_forward_msg');
  const p = seen[0].payload;
  assert.equal(p.message_type, 'group');
  assert.equal(p.group_id, 100, 'group_id 必须是数字');
  assert.equal(p.user_id, undefined);
  assert.equal(p.messages, NODES);
  assert.equal(p.summary, '2 条');
  assert.equal(p.source, '聊天记录');
  assert.ok(Object.keys(p).every((k) =>
    ['messages', 'message_type', 'group_id', 'user_id', 'source', 'summary', 'prompt', 'news'].includes(k)),
  `payload 里出现了 SnowLuma 不认的字段：${Object.keys(p).join(',')}`);

  await c.sendForwardMsg('private', '200', NODES, {});
  const q = seen[1].payload;
  assert.equal(q.message_type, 'private');
  assert.equal(q.user_id, 200);
  assert.equal(q.group_id, undefined);
});

test('recall：不占发送配额，且主动在本地标记已撤回', async () => {
  useConfig({ send: { maxPerMinute: 1, maxPerHour: 1000, dedupeWindowMs: 0 } });
  const { q, calls } = makeSender();
  await q.sendForward('group:100', NODES, {});   // 配额用满
  await q.recall('group:100', 123456);            // 撤回不该被限流卡住
  assert.equal(calls.deleted.length, 1);
  assert.equal(calls.deleted[0], 123456);
  assert.deepEqual(calls.recalled, [{ chatKey: 'group:100', mid: 123456 }]);
  assert.match(calls.appended[1].entry.text, /\[撤回\]/);
  assert.equal(calls.sent.length, 2);
});
