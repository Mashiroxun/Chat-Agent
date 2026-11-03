// 〔视觉能力判定〕—— R135 回归：主模型看不了图时，识图模型要能把它救回来
//
// 这一组测的是 effectiveVisionEnabled()：`api.visionModel` 这条配置路径
// 在 2026-10-27 之前**从来没有任何判定读过**，只有 llm.js 发请求时才会切模型，
// 于是"主模型 pro + 识图模型 flash"这套本来就为看图设计的组合被判成不能看图。
import test from 'node:test';
import assert from 'node:assert/strict';

import { effectiveVisionEnabled, modelImageVerdict } from '../src/vision-scan.js';

// 用内置资料表里确定存在的两条：V4-Pro 明确不能看图，V4-Flash 能看。
const PROVIDER = 'opencode-go';
const TEXT_ONLY = 'deepseek-v4-pro';
const WITH_VISION = 'deepseek-v4-flash';

const cfgOf = (patch = {}) => ({ api: { provider: PROVIDER, model: TEXT_ONLY, visionModel: '', ...patch } });

test('前提：内置资料表认定 pro 不能看图、flash 能看', () => {
  assert.equal(modelImageVerdict(PROVIDER, TEXT_ONLY), 'no-vision');
  assert.equal(modelImageVerdict(PROVIDER, WITH_VISION), 'vision');
});

test('纯文本主模型 + 没填识图模型 → 不能看图', () => {
  assert.equal(effectiveVisionEnabled(cfgOf()), false);
});

test('纯文本主模型 + 识图模型填了能看图的模型 → **能看图**（本次修复的核心）', () => {
  assert.equal(effectiveVisionEnabled(cfgOf({ visionModel: WITH_VISION })), true);
});

test('能看图的主模型 + 识图模型留空 → 能看图', () => {
  assert.equal(effectiveVisionEnabled(cfgOf({ model: WITH_VISION })), true);
});

test('两个模型都不能看图 → 不能看图', () => {
  assert.equal(
    effectiveVisionEnabled(cfgOf({ visionModel: TEXT_ONLY })),
    false,
    '识图模型也必须过 no-vision 判定（这里主/识图都填 pro）'
  );
});

test('识图模型没探测过（unknown）→ 保持开关（不武断阻断）', () => {
  assert.equal(
    effectiveVisionEnabled(cfgOf({ visionModel: 'some-unlisted-model-xyz' })),
    true,
    'unknown 不该被当成 no-vision'
  );
});

test('主模型没探测过（unknown）→ 保持开关', () => {
  assert.equal(effectiveVisionEnabled(cfgOf({ model: 'some-unlisted-model-xyz' })), true);
});

test('全局开关 api.vision === false 时，识图模型填了也不开', () => {
  assert.equal(effectiveVisionEnabled(cfgOf({ vision: false, visionModel: WITH_VISION })), false);
});

test('配置缺字段时不崩（api 为空 / 全空）', () => {
  assert.equal(effectiveVisionEnabled({}), false);
  assert.equal(effectiveVisionEnabled({ api: {} }), false);
  assert.equal(effectiveVisionEnabled(null), false);
});

test('visionModel 带首尾空格也能识别', () => {
  assert.equal(effectiveVisionEnabled(cfgOf({ visionModel: `  ${WITH_VISION}  ` })), true);
});
