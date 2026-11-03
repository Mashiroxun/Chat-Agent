// 桌宠「直接对话」（src/pet-chat.js）单测 —— 2026-10-24 第三版：只连主人自己的会话。
//
// 这条窗口现在**没有会话选择器**：它只认一个会话 —— `private:<机器人自己的 QQ 号>`。
// 测试要钉住的正是这条边界：
//   1. 主人会话 key 的推导（onebot.selfId → private:<id>）与持久化；
//   2. 拿不到 QQ 号时明确报错，**不**退化成"往某个群发"；
//   3. 发送只走 injectOwnerMessage(ownerKey)，消息以「主人」身份进去；
//   4. 历史来自这条会话自己的存档；捕获回复按时间插回；旧状态（选过群）一律迁移。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-petchat3-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { createPetChat } = await import('../src/pet-chat.js');

const SELF_ID = '100086';
const OWNER_KEY = `private:${SELF_ID}`;
const IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

let serial = 0;

function makeStore(rows = []) {
  return {
    _rows: rows,
    _appended: [],
    _appendedSelf: [],
    listChats() { return ['group:918273655', 'group:918273645']; },
    getChatMeta() { return { total: 0, unread: 0, lastTs: 0 }; },
    recent() { return this._rows.slice(-60); },
    appendIncoming(k, entry) {
      this._appended.push({ chatKey: k, entry });
      const row = { id: this._rows.length + 1, ...entry, self: false };
      this._rows.push(row);
      return row;   // 真实 store 也返回写入的条目（injectOwnerMessage 要拿它的 id）
    },
    // 真实 store 的 appendSelf（store.js）：机器人自己说的话，self:true、已读、返回条目
    appendSelf(k, entry) {
      this._appendedSelf.push({ chatKey: k, entry });
      const row = { id: this._rows.length + 1, mid: null, senderId: 'self', senderName: '我', reply: null, media: [], ...entry, self: true, read: true };
      this._rows.push(row);
      return row;
    }
  };
}

function makeOrchestrator(reply = { ok: true, ran: true, items: [{ type: 'text', text: '在看你啊。', at: 40 }], entryId: 1 }) {
  const calls = [];
  return {
    onebot: { selfId: SELF_ID },
    calls,
    async getChatName() { return '某个群'; },
    async injectOwnerMessage(chatKey, msg) {
      calls.push({ chatKey, msg });
      return typeof reply === 'function' ? reply() : reply;
    }
  };
}

function makeChat({ orchestrator = makeOrchestrator(), store = makeStore(), selfId = '' } = {}) {
  const file = path.join(TMP, `pet-chat-${++serial}.json`);
  const chat = createPetChat({
    deps: {
      orchestrator,
      store,
      stateFile: file,
      selfId,
      catalog: () => [{ id: 'st-1', desc: '震惊' }],
      image: async () => IMAGE
    }
  });
  return { chat, file, orchestrator, store };
}

test('主人会话 = private:<机器人自己的 QQ 号>，且落盘记住', async () => {
  const { chat, file } = makeChat();
  const snap = await chat.snapshot();
  assert.equal(snap.chatKey, OWNER_KEY);
  assert.equal(snap.chatName, '私聊 · 主人');
  assert.equal(snap.notice, '');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.ownerChatKey, OWNER_KEY);
  // 快照里**不该**出现任何群 —— 这个窗口不给人选群的机会
  assert.equal(snap.chats, undefined);
});

test('拿不到 QQ 号（协议端没连）：明确提示，不往群里发', async () => {
  const orchestrator = makeOrchestrator();
  orchestrator.onebot = { selfId: '' };
  const { chat } = makeChat({ orchestrator, selfId: '' });
  const snap = await chat.snapshot();
  assert.equal(snap.chatKey, '');
  assert.match(snap.notice, /还没拿到机器人的 QQ 号/);
  const r = await chat.send({ text: '在吗' });
  assert.equal(r.ok, false);
  assert.match(r.error, /还没拿到机器人的 QQ 号/);
  assert.equal(orchestrator.calls.length, 0, '拿不到身份时绝不去调 injectOwnerMessage');
});

test('发送：只以「主人」身份进这条专属会话', async () => {
  const { chat, orchestrator } = makeChat();
  const r = await chat.send({ text: '今天想吃鱼' });
  assert.equal(r.ok, true, r.error);
  assert.equal(orchestrator.calls.length, 1);
  assert.equal(orchestrator.calls[0].chatKey, OWNER_KEY);
  assert.equal(orchestrator.calls[0].msg.text, '今天想吃鱼');
  assert.equal(r.state.messages.at(-1).text, '在看你啊。');
  assert.equal(r.state.messages.at(-1).role, 'bot');
});

test('历史来自这条会话自己的存档（跨重启保留），并按角色映射', async () => {
  const store = makeStore([
    { id: 1, ts: 10, senderId: 'owner', senderName: '主人', text: '在吗', self: false },
    { id: 2, ts: 20, senderId: 'self', senderName: '', text: '在的呀', self: true }
  ]);
  const { chat } = makeChat({ store });
  const snap = await chat.snapshot();
  assert.deepEqual(snap.messages.map((m) => m.role), ['me', 'bot']);
  assert.equal(snap.messages[0].text, '在吗');
  assert.equal(snap.messages[1].text, '在的呀');
});

test('贴纸：捕获到的表情补 data URL 后再进消息流', async () => {
  const { chat } = makeChat({
    orchestrator: makeOrchestrator({ ok: true, ran: true, items: [{ type: 'sticker', id: 'st-1', desc: '震惊', at: 45 }] })
  });
  const r = await chat.send({ text: '来一个表情' });
  const last = r.state.messages.at(-1);
  assert.equal(last.stickers.length, 1);
  assert.equal(last.stickers[0].dataUrl, IMAGE);
});

// ── 2026-10-24 回归：捕获回复必须落档，否则重启后窗口只剩用户消息（实测翻车）──

test('回复落档：捕获的回复按 appendSelf 写进存档，标签与真实出站一致', async () => {
  const store = makeStore();
  const { chat } = makeChat({
    store,
    orchestrator: makeOrchestrator({
      ok: true, ran: true,
      items: [
        { type: 'text', text: '在看你啊。', at: 40 },
        { type: 'sticker', id: 'st-1', desc: '震惊', at: 41 },
        { type: 'image', dataUrl: IMAGE, at: 42 },
        { type: 'poke', at: 43 }          // 没有窗口形态，也不该留档
      ]
    })
  });
  const r = await chat.send({ text: '在干嘛' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(store._appendedSelf.map((x) => x.entry.text), [
    '在看你啊。',
    '[表情包:震惊]',
    '[图片]'
  ], '文本原样、表情/图片用与 sender.js 相同的标签；poke 不留档');
  assert.ok(store._appendedSelf.every((x) => x.chatKey === OWNER_KEY), '只写主人专属会话');

  // 同进程内不双份：存档版被按条目 id 跳过，窗口里每个回复只出现一次
  const roles = r.state.messages.map((m) => m.role);
  assert.equal(roles.filter((x) => x === 'bot').length, 3, '文本 + 表情 + 图片各一条');
});

test('重启还原：新进程（captured 为空）从存档读出全部回复，表情画占位', async () => {
  // 模拟"上一进程留下的存档"：用户消息 + 机器人回复（appendSelf 落的档）
  const store = makeStore([
    { id: 1, ts: 10, senderId: 'owner', senderName: '主人', text: '喵~', self: false },
    { id: 2, ts: 20, senderId: 'self', senderName: '我', text: '在看你啊。', self: true },
    { id: 3, ts: 30, senderId: 'self', senderName: '我', text: '[表情包:震惊]', self: true }
  ]);
  const { chat } = makeChat({ store });
  const snap = await chat.snapshot();
  assert.deepEqual(snap.messages.map((m) => m.role), ['me', 'bot', 'bot']);
  assert.equal(snap.messages[1].text, '在看你啊。');
  // 表情标签 → 占位卡（dataUrl 为空时界面画 ［震惊］），不再是裸文本行
  assert.equal(snap.messages[2].text, '');
  assert.equal(snap.messages[2].stickers.length, 1);
  assert.equal(snap.messages[2].stickers[0].desc, '震惊');
});

test('没跑起来（并发/暂停）：回报原因，且不卡住后续发送', async () => {
  const { chat, orchestrator } = makeChat({
    orchestrator: makeOrchestrator({ ok: false, ran: false, error: '这条会话正在运行中' })
  });
  const r = await chat.send({ text: '在吗' });
  assert.equal(r.ok, false);
  assert.match(r.error, /正在运行中/);
  const r2 = await chat.send({ text: '还在吗' });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /正在运行中/, '第二次应该真的又发了一次');
  assert.equal(orchestrator.calls.length, 2);
});

test('并发：第二条要等第一条回来', async () => {
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const orchestrator = makeOrchestrator(async () => { await gate; return { ok: true, ran: true, items: [] }; });
  const { chat } = makeChat({ orchestrator });
  const first = chat.send({ text: '一' });
  const second = await chat.send({ text: '二' });
  assert.equal(second.ok, false);
  assert.match(second.error, /还在回复中/);
  release();
  await first;
  assert.equal(orchestrator.calls.length, 1);
});

test('v1 旧状态迁移：原来选了群的，一律改回主人专属会话', async () => {
  const file = path.join(TMP, 'pet-chat-legacy.json');
  fs.writeFileSync(file, JSON.stringify({ chatKey: 'group:918273655' }), 'utf8');
  const chat = createPetChat({
    deps: { orchestrator: makeOrchestrator(), store: makeStore(), stateFile: file, catalog: () => [], image: async () => '' }
  });
  const snap = await chat.snapshot();
  assert.equal(snap.chatKey, OWNER_KEY, '旧选择（群）必须作废');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.v, 2);
  assert.equal(onDisk.ownerChatKey, OWNER_KEY);
  assert.equal(onDisk.chatKey, undefined, '不再保存群选择');
});

test('附件：路径原样交给 injectOwnerMessage，回来后按条目 id 记住文件名', async () => {
  // 桩 orchestrator 这次要**真的写存档**（和真实 injectOwnerMessage 一样），
  // 否则快照里看不到自己这句话，就验不出"附件名按条目 id 挂回气泡"。
  const store = makeStore();
  const orchestrator = {
    onebot: { selfId: SELF_ID },
    calls: [],
    async getChatName() { return '某个群'; },
    async injectOwnerMessage(chatKey, msg) {
      this.calls.push({ chatKey, msg });
      const entry = store.appendIncoming(chatKey, {
        mid: 'console-test', ts: Date.now(), senderId: 'owner', senderName: '主人',
        text: msg.text || '[文件]', media: []
      });
      return { ok: true, ran: true, items: [], entryId: entry?.id ?? null };
    }
  };
  const { chat } = makeChat({ orchestrator, store });
  const r = await chat.send({ text: '看看这个', files: [{ path: 'D:////tmp////b.png', name: 'b.png', size: 2048 }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(orchestrator.calls.length, 1);
  // 只过路径与名字：文件内容由后端按需读，渲染进程不碰字节
  assert.deepEqual(orchestrator.calls[0].msg.files, [{ path: 'D:////tmp////b.png', name: 'b.png', size: 2048 }]);
  assert.ok(r.entryId, '要把存档条目 id 带回给界面');

  const snap = await chat.snapshot();
  const mine = snap.messages.filter((m) => m.role === 'me');
  assert.equal(mine.length, 1, '自己这句话在存档里');
  assert.deepEqual(mine[0].files, [{ name: 'b.png', size: 2048 }], '附件名要能画在气泡下面');
});

test('附件：空文本也能发（只发文件）', async () => {
  const { chat, orchestrator } = makeChat();
  const r = await chat.send({ text: '', files: [{ path: 'D://tmp//a.log', name: 'a.log' }] });
  assert.equal(r.ok, true, r.error);
  assert.equal(orchestrator.calls[0].msg.text, '');
  assert.equal(orchestrator.calls[0].msg.files.length, 1);
});

test('附件：超过 8 个只取前 8 个（与后端上限对齐）', async () => {
  const { chat, orchestrator } = makeChat();
  const many = Array.from({ length: 12 }, (_, i) => ({ path: `D://tmp//f${i}.txt`, name: `f${i}.txt` }));
  const r = await chat.send({ text: '一堆文件', files: many });
  assert.equal(r.ok, true);
  assert.equal(orchestrator.calls[0].msg.files.length, 8);
});
