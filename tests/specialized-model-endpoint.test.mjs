// 〔图片/视频专用模型的路由〕—— 0.4.9.2 外部反馈 bug 回归
//
// 反馈：设置专用视频/图片模型后，会话里读到图/视频，请求拿着**专用模型的
// 模型名**发往**主模型的 baseUrl**，导致会话失败报错。
// 根因：旧实现 `api = { ...api, model: forced }` 只换名、不换端点 ——
// 专用模型配在别的服务商上时必然 404/400。
// 修复：resolveSpecializedRoute 按模型名在 providers 注册表里找归属，
// 命中就连 baseUrl / apiKey / 协议 / provider 一起切。
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSpecializedRoute } from '../src/llm.js';

const IMG_MSG = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } }, { type: 'text', text: '这是什么' }] };
const TXT_MSG = { role: 'user', content: '早' };
const VIDEO_MSG = { role: 'user', content: [{ type: 'video_url', video_url: { url: 'data:video/mp4;base64,yyy' } }] };

const MAIN = { baseUrl: 'https://main.example.com/v1', apiKey: 'main-key', model: 'text-main', provider: 'main-p' };

const CFG = {
  api: { provider: 'main-p', model: 'text-main', visionModel: 'vision-pro', videoModel: 'video-pro' },
  providers: [
    { id: 'main-p', baseURL: 'https://main.example.com/v1', models: ['text-main', 'vision-lite'] },
    { id: 'vision-p', baseURL: 'https://vision.example.com/v1', models: ['vision-pro'], apiProtocol: 'openai' },
    { id: 'video-p', baseURL: 'https://video.example.com/v1', models: ['video-pro'], apiProtocol: 'openai' }
  ],
  dshProviderKeys: { 'vision-p': 'vision-key', 'video-p': 'video-key' }
};

test('带图 + 专用模型在别的服务商 → 连 baseUrl/Key/协议一起切', () => {
  const { api, forced } = resolveSpecializedRoute([IMG_MSG], CFG, { ...MAIN });
  assert.equal(forced, 'vision-pro');
  assert.equal(api.baseUrl, 'https://vision.example.com/v1');
  assert.equal(api.apiKey, 'vision-key');
  assert.equal(api.model, 'vision-pro');
  assert.equal(api.provider, 'vision-p');
});

test('带视频 → 优先切 videoModel（视频优先于图片）', () => {
  const { api, forced } = resolveSpecializedRoute([VIDEO_MSG], CFG, { ...MAIN });
  assert.equal(forced, 'video-pro');
  assert.equal(api.baseUrl, 'https://video.example.com/v1');
  assert.equal(api.apiKey, 'video-key');
});

test('专用模型就在主端点上 → 只换名，不冲掉现有 Key（账号池场景）', () => {
  const pool = { ...MAIN, apiKey: 'pool-picked-key' };
  const cfg = { ...CFG, api: { ...CFG.api, visionModel: 'vision-lite' } }; // vision-lite 归 main-p 托管
  const { api, forced } = resolveSpecializedRoute([IMG_MSG], cfg, pool);
  assert.equal(forced, 'vision-lite');
  assert.equal(api.model, 'vision-lite');
  assert.equal(api.baseUrl, 'https://main.example.com/v1');
  assert.equal(api.apiKey, 'pool-picked-key', '主端点命中时不应覆盖账号池挑好的 Key');
});

test('模型名不在任何提供商注册表里 → 保持旧行为（只换名）', () => {
  const cfg = { ...CFG, providers: CFG.providers.filter((p) => p.id !== 'vision-p') };
  const { api, forced } = resolveSpecializedRoute([IMG_MSG], cfg, { ...MAIN });
  assert.equal(forced, 'vision-pro');
  assert.equal(api.model, 'vision-pro');
  assert.equal(api.baseUrl, 'https://main.example.com/v1');
});

test('提供商记录缺 baseURL → 只换名，不切出坏端点', () => {
  const cfg = { ...CFG, providers: CFG.providers.map((p) => (p.id === 'vision-p' ? { ...p, baseURL: '' } : p)) };
  const { api } = resolveSpecializedRoute([IMG_MSG], cfg, { ...MAIN });
  assert.equal(api.model, 'vision-pro');
  assert.equal(api.baseUrl, 'https://main.example.com/v1');
});

test('没有媒体部件 → 不切专用模型', () => {
  const { forced } = resolveSpecializedRoute([TXT_MSG], CFG, { ...MAIN });
  assert.equal(forced, '');
});

test('专用模型与主模型同名 → 原样返回', () => {
  const cfg = { ...CFG, api: { ...CFG.api, visionModel: 'text-main' } };
  const { forced, api } = resolveSpecializedRoute([IMG_MSG], cfg, { ...MAIN });
  assert.equal(forced, '');
  assert.equal(api.model, 'text-main');
});

test('apiKey 在 dshProviderKeys 缺失时回落提供商记录的明文', () => {
  const cfg = { ...CFG, dshProviderKeys: {} , providers: CFG.providers.map((p) => (p.id === 'vision-p' ? { ...p, apiKey: 'plain-key' } : p)) };
  const { api } = resolveSpecializedRoute([IMG_MSG], cfg, { ...MAIN });
  assert.equal(api.apiKey, 'plain-key');
});
