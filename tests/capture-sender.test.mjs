// 捕获发送器（orchestrator.createCaptureSender）单测 —— 2026-10-24。
//
// 它是「从控制台插话」的安全边界：模型的每一次"发送"都必须被接住，
// 既不落到 OneBot，也不写"自己说过"的存档。这里逐条钉住接口与副作用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-capture-sender-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { createCaptureSender, CONSOLE_SENDER_ID, CONSOLE_SENDER_NAME } = await import('../src/orchestrator.js');

function sink() {
  const items = [];
  return { items, sender: createCaptureSender('group:123', { items }) };
}

test('发送身份：不是任何真实 QQ 号，也不是"自己"', () => {
  assert.equal(CONSOLE_SENDER_ID, 'owner');
  assert.equal(CONSOLE_SENDER_NAME, '主人');
  // store.js 用 senderId === 'self' 表示机器人自己说的 —— 不能撞
  assert.notEqual(CONSOLE_SENDER_ID, 'self');
});

test('sendTextBatch：逐条接住，返回结构与 SendQueue 同构', async () => {
  const { items, sender } = sink();
  const out = await sender.sendTextBatch('group:123', ['第一句', '第二句']);
  assert.equal(out.failed.length, 0, 'capture 模式下没有"发送失败"');
  assert.equal(out.sent.length, 2);
  assert.deepEqual(out.sent.map((s) => s.text), ['第一句', '第二句']);
  assert.equal(out.sent[0].deduped, false, 'send_message 工具要按 deduped 过滤，这里必须显式 false');
  assert.equal(typeof out.sent[0].at, 'number');
  assert.deepEqual(items.map((i) => i.type), ['text', 'text']);
  assert.equal(items[0].chatKey, 'group:123');
});

test('sendTextBatch：空内容不进消息流（与真实发送器一致）', async () => {
  const { items, sender } = sink();
  const out = await sender.sendTextBatch('group:123', ['  ', '有内容']);
  assert.equal(out.sent.length, 1);
  assert.equal(items.length, 1);
});

test('sendSticker：接住表情，回一个可用的 message_id 形状', async () => {
  const { items, sender } = sink();
  const out = await sender.sendSticker('group:123', { id: 'st-9', desc: '笑了' });
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'sticker');
  assert.equal(items[0].id, 'st-9');
  assert.equal(items[0].desc, '笑了');
  assert.ok('message_id' in out, 'sticker 插件会读 result.message_id');
});

test('图片 / 媒体 / 拍一拍都有对应形态，不会把回合卡死', async () => {
  const { items, sender } = sink();
  assert.equal((await sender.sendImage('group:123', { url: 'https://x/y.png', dataUrl: 'data:image/png;base64,AA' })).ok, true);
  assert.equal((await sender.sendMedia('group:123', [{ type: 'text', data: { text: 'hi' } }])).ok, true);
  assert.equal((await sender.poke('group:123', 12345)).ok, true);
  assert.equal((await sender.sendSegments('group:123', [])).ok, true);
  // sendSegments 是 sendMedia 的别名（真实 SendQueue 也是这个关系），所以会各记一条
  assert.deepEqual(items.map((i) => i.type), ['image', 'media', 'media']);
  assert.equal(items[0].dataUrl, 'data:image/png;base64,AA');
});

test('不写存档：capture 只收进 items，没有 appendSelf 之类的副作用', async () => {
  const { items, sender } = sink();
  await sender.sendTextBatch('group:123', ['一句话']);
  // 唯一的状态变化就是 items 多了一条 —— 没有第二个出口
  assert.equal(items.length, 1);
  const before = fs.readdirSync(TMP).length;
  await sender.sendSticker('group:123', { id: 'st-1' });
  await sender.sendTextBatch('group:123', ['又一句']);
  assert.equal(fs.readdirSync(TMP).length, before, '不该往磁盘写任何东西');
});

test('capture 收集器缺失时不炸（防御：items 不是数组就当只读）', async () => {
  const sender = createCaptureSender('group:1', null);
  const out = await sender.sendTextBatch('group:1', ['hi']);
  assert.equal(out.sent.length, 1);
});
