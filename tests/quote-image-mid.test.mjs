// 引用一条带图消息时，必须把「被引用消息自己」的编号带进引用块（0.4.9.3）
//
// 用户报障原话：「她还是说图没收到」。根因不是看图工具坏了，而是模型
// 在引用块里只看到 `[引用 张三：[图片]]`，手上没有编号，压根没法调
// get_message_images。合并转发早有 fwdMid，纯图片一直没有。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickQuoteMid, segmentsToText } from '../src/onebot.js';

test('纯图片引用：给出被引用消息的 mid', () => {
  assert.equal(pickQuoteMid(123456, [{ type: 'image', data: { file: 'a.jpg' } }]), '123456');
});

test('图文混合引用也给 mid', () => {
  const segs = [
    { type: 'text', data: { text: '帮我看看这个' } },
    { type: 'image', data: { file: 'a.jpg' } }
  ];
  assert.equal(pickQuoteMid('-1668521248', segs), '-1668521248', '负数 mid 也要原样保留');
});

test('纯文本引用不给 mid（别让模型拿引用号乱试工具）', () => {
  assert.equal(pickQuoteMid(123, [{ type: 'text', data: { text: '在吗' } }]), null);
  assert.equal(pickQuoteMid(123, '纯文本消息'), null);
  assert.equal(pickQuoteMid(123, null), null);
});

test('合并转发的 fwdMid 优先，不被图片覆盖', () => {
  const segs = [{ type: 'image', data: {} }, { type: 'forward', data: { id: 'fwd' } }];
  assert.equal(pickQuoteMid(999, segs, '888'), '888');
});

test('畸形输入不抛异常、不编造编号', () => {
  for (const segs of [undefined, null, {}, [null, undefined], [{ type: null }]]) {
    assert.equal(pickQuoteMid(123, segs), null);
  }
  assert.equal(pickQuoteMid(null, [{ type: 'image' }]), null);
  assert.equal(pickQuoteMid('  ', [{ type: 'image' }]), null);
});

test('引用块真的把 #编号 显示出来（模型才拿得到）', async () => {
  const out = await segmentsToText(
    [{ type: 'reply', data: { id: '123456' } }],
    {
      resolveReply: async () => ({
        sender: '张三', senderId: '789', mid: '123456', text: '[图片]'
      })
    }
  );
  assert.match(out, /#123456/, '引用块必须带编号');
  assert.match(out, /张三\(QQ:789\)/);
  assert.match(out, /\[图片\]/);
});

test('没有 mid 时引用块不出现 #（保持旧文案）', async () => {
  const out = await segmentsToText(
    [{ type: 'reply', data: { id: '123' } }],
    { resolveReply: async () => ({ sender: '张三', text: '在吗' }) }
  );
  assert.doesNotMatch(out, /#/);
  assert.match(out, /在吗/);
});
