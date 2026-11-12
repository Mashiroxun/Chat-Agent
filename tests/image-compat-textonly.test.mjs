// 服务端回「只支持文本」时 → 必须降级重试（2026-11-11）。
//
// 真机证据：qq-agent-2026-11-06/07.log 里 20 次 [real:...] 请求 400，
// 错误正文 "model only supports text input; image, video and audio is not supported"。
// image-compat 的 isImageRejection 只认 image_url / invalid image 这类「格式」措辞，
// 一个字都匹配不上 → 顾问返回 null → 整轮对话什么都没发出去。
// 这里锁死：认得出来、摘得干净、不误伤别的 400。
//
// ⚠️ 更正（同日实测）：这句错误**不能**说明模型是纯文本模型。
//    sensenova-6.8-flash-lite 是原生多模态模型，合法 PNG(base64) 实测 HTTP 200。
//    所以本文件测的是「服务端说不接受时怎么救回整轮」这个兜底行为，
//    不是模型能力判定；降级只发生在已经 400 之后，不会主动关掉看图。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { internals, providers, setup } from '../plugins/image-compat/index.js';

const { isImageRejection, stripImageParts, hasMediaParts, hasImageParts } = internals;

const REAL_400 = '{"error":{"message":"model only supports text input; image, video and audio is not supported","type":"invalid_request_error","code":"3"}}';

const withImage = () => ({
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '这张图里是什么' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }
    ]
  }]
});

setup({ config: () => ({}), log: () => {} });

test('真机 400 原文必须被识别（这是整轮对话失败的根因）', () => {
  assert.equal(isImageRejection(400, REAL_400), true);
});

test('各家「服务端不接受媒体输入」的措辞都能认', () => {
  const samples = [
    'model only supports text input; image, video and audio is not supported',
    'this model does not support image inputs',
    'image input is not supported by this model',
    'text-only model cannot handle vision',
    '该模型不支持图片输入',
    '仅支持文本输入',
  ];
  for (const s of samples) {
    assert.equal(isImageRejection(400, s), true, `未识别：${s}`);
  }
});

test('原有「格式/编码」类拒绝仍识别（415/422 不回归）', () => {
  const samples = [
    'image_url is invalid',
    'invalid image data',
    'unsupported image format',
    'must be a base64 encoded image',
  ];
  for (const s of samples) assert.equal(isImageRejection(415, s), true, `漏识别：${s}`);
});

test('不误伤无关 400 与非 4xx：不能为它们白重试一次', () => {
  const cases = [
    'The supported API model names are deepseek-flash, but you passed DS v41f',
    'Incorrect API key provided',
    'context length exceeded',
    'rate limit exceeded',
    'safety check failed',
  ];
  for (const s of cases) assert.equal(isImageRejection(400, s), false, `误判：${s}`);
  assert.equal(isImageRejection(200, REAL_400), false);
  assert.equal(isImageRejection(500, REAL_400), false);
  assert.equal(isImageRejection(429, REAL_400), false);
});

test('剥除：image_url 与 video_url 一起摘掉，否则重试会再 400 一次', () => {
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: '看看这个' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,BBB' } }
    ]
  }];
  const out = stripImageParts(messages);
  assert.ok(out);
  const content = out[0].content;
  assert.equal(content.some((p) => p.type === 'image_url' || p.type === 'video_url'), false);
  assert.equal(content[0].text, '看看这个');
  const note = content.at(-1).text;
  assert.match(note, /1 张图片/);
  assert.match(note, /1 段视频/);
  assert.match(note, /不要假装看过图/, '占位说明要防止模型照着配文编画面');
  assert.equal(messages[0].content.length, 3, '不能就地改动调用方的 messages');
});

test('剥除：没有媒体时返回 null（别白重试一次）', () => {
  assert.equal(stripImageParts([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]), null);
  assert.equal(stripImageParts([{ role: 'user', content: '纯文本' }]), null);
});

test('hasMediaParts 认 video_url，历史名 hasImageParts 保持可用', () => {
  const onlyVideo = [{ role: 'user', content: [{ type: 'video_url', video_url: { url: 'x' } }] }];
  assert.equal(hasMediaParts(onlyVideo), true);
  assert.equal(hasImageParts(onlyVideo), true);
  assert.equal(hasMediaParts([{ role: 'user', content: '纯文本' }]), false);
});

test('端到端：真实 400 + 带图 body → 顾问给出可重试的请求体', async () => {
  const r = await providers['llm.retry-advisor']({
    body: withImage(), errorText: REAL_400, status: 400
  });
  assert.ok(r, '必须给降级建议，否则整轮对话直接 400 失败');
  assert.match(String(r.reason), /摘掉|重试/);
  const flat = JSON.stringify(r.body.messages);
  assert.equal(flat.includes('image_url'), false, '重试体里不能还留着图片');
  assert.equal(flat.includes('这张图里是什么'), true, '文字部分要原样保留');
});

test('端到端：无关 400 不降级', async () => {
  const r = await providers['llm.retry-advisor']({
    body: withImage(), errorText: 'Incorrect API key provided', status: 400
  });
  assert.equal(r, null);
});

test('端到端：只有视频、没有图片时也会降级', async () => {
  const body = {
    messages: [{ role: 'user', content: [{ type: 'video_url', video_url: { url: 'x' } }] }]
  };
  const r = await providers['llm.retry-advisor']({ body, errorText: REAL_400, status: 400 });
  assert.ok(r);
  assert.equal(JSON.stringify(r.body.messages).includes('video_url'), false);
});
