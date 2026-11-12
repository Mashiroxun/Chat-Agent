// 缓存观测层修正（2026-11-12）。
//
// 两件事：
//   1. cache-guard 的系统提示漂移判定改为**按群分桶** —— 原来全局单槽，
//      多群交替时"换群"被误判成"系统提示漂移"。实测 14 天 80 条记录，
//      而会话存档里真实相邻 systemPrompt 差异只有 3 次（假阳性 96%）。
//   2. self-doctor 的缓存告警加最小样本门槛 —— 重启当天十几轮就报
//      "未命中率 26.4%"，样本涨到 48 次后自己回落到 16%。
//
// 这两项都只影响观测，不影响请求内容；测试要守住"不多报、不漏报"。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-cache-obs-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const guard = await import('../plugins/cache-guard/index.js');
const doctor = await import('../src/harness/doctor/index.js');

guard.setup({ config: () => ({}), log: () => {}, registerTool: () => {} });

const mkSys = (head, sec = '内容稳定不变的一段说明，用来占够长度触发指纹计算。') =>
  `${head}\n▸ 身份\n${sec}\n▸ 指令\n${sec}`;

const feed = (chatKey, system) => guard.hooks['before-llm-messages']({
  chatKey,
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: '【引导说明】\n\n【本次唤醒】说点什么' }
  ]
});
const snap = () => guard.providers['cache.snapshot']();

test('cache-guard：多群交替不再把"换群"误报成漂移', () => {
  const A = mkSys('A 群的核心头部');
  const B = mkSys('B 群的核心头部');
  feed('group:1', A);            // 首见 A，只登记
  feed('group:2', B);            // 首见 B —— 旧实现在这里就会报一条漂移
  feed('group:1', A);            // 回到 A，内容没变
  feed('group:2', B);
  feed('group:1', A);
  assert.equal(snap().drift.length, 0, '换群不应产生漂移记录');
});

test('cache-guard：同一个群系统提示真变了才报，且只报该群', () => {
  feed('group:1', mkSys('A 群的核心头部', '这一段的措辞被改了，长度也不同。'));
  const d = snap().drift;
  assert.equal(d.length, 1);
  assert.equal(d[0].chatKey, 'group:1');
  assert.ok(Array.isArray(d[0].sections) && d[0].sections.length > 0);
});

test('cache-guard：快照暴露按群分桶，且旧版单槽不会被当成某群基线', () => {
  const s = snap();
  assert.ok(s.lastSystemByChat && typeof s.lastSystemByChat === 'object');
  assert.ok(s.lastSystemByChat['group:1']);
  assert.ok(s.lastSystemByChat['group:2']);
  // 旧存档迁移进来的桶用特殊名字，任何真实 groupKey 都查不到它
  assert.equal(s.lastSystemByChat['(旧版单槽)'], undefined);
  // 全局 lastSystem 仍保留（报表「最近一次采得」用）
  assert.ok(s.lastSystem?.hash);
});

test('assessCacheDay：样本充足才升级为告警', () => {
  // 未命中率正常
  assert.equal(doctor.assessCacheDay({ prompt: 200000, cached: 180000, calls: 20 }).level, 'ok');
  // 未命中 25%，样本充足 → 真告警
  assert.equal(doctor.assessCacheDay({ prompt: 200000, cached: 150000, calls: 20 }).level, 'high');
  // 未命中 40%，但只有 4 次调用 / 50k token → 样本不足，降级提示
  const small = doctor.assessCacheDay({ prompt: 50000, cached: 30000, calls: 4 });
  assert.equal(small.level, 'low-sample');
  assert.equal(small.enoughSample, false);
  assert.ok(Math.abs(small.miss - 0.4) < 1e-9);
  // token 够、调用次数不够（一次 20 万 token 的长会话）→ 仍算样本不足
  assert.equal(doctor.assessCacheDay({ prompt: 200000, cached: 150000, calls: 3 }).level, 'low-sample');
  // 没有样本
  assert.equal(doctor.assessCacheDay({}).level, 'ok');
  assert.equal(doctor.assessCacheDay({ prompt: 0, calls: 0 }).level, 'ok');
});
