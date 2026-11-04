// 人设句子级补丁测试（2026-11-04，R168）
//
// 背景：用户生效的人设是 config.persona.roleText 的一份**副本**，源码里改
// PERSONAS 不会同步过去。R167 调"看图反应"时就因此失效（用户反馈"依旧有"）。
// PERSONA_TEXT_PATCHES 用来给老副本打补丁，这里锁住它的四个契约：
//   ① 命中旧句 → 换成新句
//   ② 幂等（重复调用不叠加）
//   ③ 用户改过这句 → 一个字都不动
//   ④ 边界（undefined / 空串 / 畸形补丁）不抛异常

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyPersonaTextPatches } from '../src/config.js';
import { PERSONA_TEXT_PATCHES, PERSONAS } from '../src/personas.js';

const SAMPLE = [
  '# 角色卡',
  '',
  '你不是恒定音色。真人说话会漂。开口前随手定个档：',
  '',
  '- **兴奋档**——被夸、群里在吵架、看到好图好梗。话多、夹梗，可以连发两三条，语气上扬。',
  '- **日常档**——普通闲聊。短、接话、偶尔冒泡。',
].join('\n');

test('命中旧句时替换成新句', () => {
  const out = applyPersonaTextPatches(SAMPLE);
  assert.ok(!out.includes('看到好图好梗'), '旧激励句应被移除');
  assert.ok(out.includes('图是气氛不是话题'), '新说明应出现');
  assert.ok(out.includes('- **日常档**'), '其余内容不受影响');
});

test('幂等：重复应用不会再变化', () => {
  const once = applyPersonaTextPatches(SAMPLE);
  const twice = applyPersonaTextPatches(once);
  assert.equal(twice, once);
});

test('用户改过这句时不动（个性化优先）', () => {
  const customized = SAMPLE.replace('看到好图好梗', '看到好图好梗（我喜欢这个设定）');
  const out = applyPersonaTextPatches(customized);
  assert.equal(out, customized, '整句不匹配就不应替换');
});

test('非字符串与畸形补丁不抛异常', () => {
  for (const v of [undefined, null, '', 0]) {
    assert.doesNotThrow(() => applyPersonaTextPatches(v));
  }
  const weird = [
    { id: 'empty-from', from: '', to: 'X' },
    { id: 'bad-type', from: 1, to: 'X' },
    null,
  ];
  assert.equal(applyPersonaTextPatches('abc', weird), 'abc', '空 from / 畸形项应跳过');
});

test('补丁表本身格式正确', () => {
  assert.ok(Array.isArray(PERSONA_TEXT_PATCHES) && PERSONA_TEXT_PATCHES.length > 0);
  const ids = new Set();
  for (const p of PERSONA_TEXT_PATCHES) {
    assert.equal(typeof p.id, 'string');
    assert.ok(p.id.length > 0, 'id 不能为空');
    assert.ok(!ids.has(p.id), `id 重复：${p.id}`);
    ids.add(p.id);
    assert.equal(typeof p.from, 'string');
    assert.equal(typeof p.to, 'string');
    assert.ok(p.from.length >= 10, 'from 太短，容易误伤正常内容');
    assert.notEqual(p.from, p.to, 'from 与 to 相同等于没改');
  }
});

test('补丁不会把新模板改回旧版（方向正确）', () => {
  const newest = PERSONAS.xiaojingyu.text;
  assert.equal(applyPersonaTextPatches(newest), newest, '最新模板应原样返回');
  assert.ok(newest.includes('图是气氛不是话题'), '最新模板应已包含补丁后的说法');
});
