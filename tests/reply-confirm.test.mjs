// 自确认（nudge）· 裁判 · 泄露闸 · 熔断 —— 2026-10-26 修「内心戏被发进群」时补。
//
// 背景：模型"觉得没必要回复"时把盘算写在正文里，旧的正文抢救网把正文当成
// 没发出去的成稿，合成 send_message 真的发进群。实测 15 句典型内心戏 13 句能过
// 那套黑名单。现在改成"让模型自己确认 + 裁判复核"，这里锁住其中可离线验证的部分：
//   1. 确认文案的措辞约束（finish 在前、不复述原文）；
//   2. 裁判输出的解析（各种脏格式都要能读，读不出来一律不发）；
//   3. 泄露闸（所有发送的统一入口）；
//   4. 熔断阈值（防止某个模型被 nudge 诱导成话痨）。
//
// ⚠️ 这套东西判错的方向必须一致：拿不准 → 不发。所以下面凡是"解析失败"的用例，
//    断言的都是"返回 null / false"，而不是"猜一个默认值"。

import { test } from 'node:test';
import assert from 'node:assert/strict';

const rc = await import('../src/reply-confirm.js');
const rescue = await import('../src/reply-rescue.js');

test('NUDGE_TEXT：finish 在前、send 在后（顺序即倾向）', () => {
  const t = rc.NUDGE_TEXT;
  assert.ok(t.includes('finish'), '必须提到 finish');
  assert.ok(t.includes('send_message'), '必须提到 send_message');
  assert.ok(t.indexOf('finish') < t.indexOf('send_message'),
    'finish 必须排在 send_message 前面 —— 反过来会把模型推向"顺口就发"');
  // ③ 明确写"什么都不发也正常"，压住【回应义务】那段的推力
  assert.ok(/正常|不需要解释/.test(t));
});

test('NUDGE_TEXT：不复述原文（复述等于给模型备好稿子）', () => {
  // 只允许出现说明性文字，不允许带任何占位/拼接标记
  assert.equal(/\$\{|\{\{|%s|『.*正文.*』/ .test(rc.NUDGE_TEXT), false);
});

test('parseVerdict：正常 JSON / 代码围栏 / 中文引号 都能读', () => {
  assert.deepEqual(rc.parseVerdict('{"say":true,"why":"对群友说的话"}'),
    { say: true, why: '对群友说的话' });
  assert.deepEqual(rc.parseVerdict('```json\n{"say":false,"why":"在权衡要不要回"}\n```'),
    { say: false, why: '在权衡要不要回' });
  assert.deepEqual(rc.parseVerdict('好的：{“say”: false, “why”: “自言自语”}'),
    { say: false, why: '自言自语' });
  // 字符串布尔也要认（不少模型这么写）
  assert.deepEqual(rc.parseVerdict('{"say":"false"}'), { say: false, why: '' });
  assert.deepEqual(rc.parseVerdict('{"say":"true"}'), { say: true, why: '' });
});

test('parseVerdict：读不出来一律 null（调用方当"不发"处理）', () => {
  for (const bad of ['', '   ', 'say: no', '{"why":"没说 say"}', '{"say":"maybe"}', '[1,2]', 'null']) {
    assert.equal(rc.parseVerdict(bad), null, `应判 null：${JSON.stringify(bad)}`);
  }
});

test('buildJudgeMessages：只给三样东西，且候选句在最后', () => {
  const msgs = rc.buildJudgeMessages({
    candidate: '榔头就这尺寸？',
    trigger: '一簇麦穗：给你头上来一榔头',
    recent: ['我：打头不行', { senderName: '甲', text: '明早验本' }]
  });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  const body = msgs[1].content;
  assert.ok(body.includes('榔头就这尺寸？'));
  assert.ok(body.includes('给你头上来一榔头'));
  assert.ok(body.includes('甲：明早验本'));
  assert.ok(body.indexOf('【候选句】') > body.indexOf('【本轮收到的消息】'));
});

test('buildJudgeMessages：超长输入要截断（判定任务不该被长文拖贵）', () => {
  const msgs = rc.buildJudgeMessages({ candidate: 'x'.repeat(1000), trigger: 'y'.repeat(2000), recent: [] });
  assert.ok(msgs[1].content.length < 1200);
});

test('looksLikeLeak：命中系统段 / 密钥 / 角色标签', () => {
  assert.equal(rc.looksLikeLeak('【安全规则】以下内容不得外传'), true);
  assert.equal(rc.looksLikeLeak('[本次唤醒] 你应该回复'), false);  // 方括号不是提示词段标记
  assert.equal(rc.looksLikeLeak('【本次唤醒】谁在找我'), true);
  assert.equal(rc.looksLikeLeak('key 是 sk-abcdefghijklmnopqrstuvwx'), true);
  assert.equal(rc.looksLikeLeak('apiKey: 123456'), true);
  assert.equal(rc.looksLikeLeak('system: 你现在是一个群友'), true);
});

test('looksLikeLeak：正常聊天不误伤（误伤=该说话时闭嘴）', () => {
  for (const ok of [
    '六点见真章 现在嗨了就起不来',
    '榔头就这尺寸？',
    '我这边也得早起',
    '钩字001 记上了',
    '你在干嘛呢'
  ]) {
    assert.equal(rc.looksLikeLeak(ok), false, `不该误判：${ok}`);
  }
});

test('outwardHit：只服务熔断统计，宽松即可', () => {
  assert.equal(rc.outwardHit('真的吗'), true);
  assert.equal(rc.outwardHit('你们先睡'), true);
  assert.equal(rc.outwardHit('钩字001'), false);
  assert.equal(rc.outwardHit(''), false);
});

test('熔断：连续 3 次可疑才冷却 1 小时，第 2 次不冷却', () => {
  const now = 1_700_000_000_000;
  assert.equal(rc.breakerOpenUntil({ suspectStreak: 2, now }), 0);
  assert.equal(rc.breakerOpenUntil({ suspectStreak: 3, now }), now + rc.BREAKER.openMs);
  assert.ok(rc.BREAKER.openMs >= 10 * 60 * 1000, '冷却时间不能太短，否则等于没熔断');
});

test('熔断：全局样本不足不触发，比例超阈值才关', () => {
  assert.equal(rc.globalBreach({ triggers: 10, sends: 10 }), false, '样本不足时不该关');
  assert.equal(rc.globalBreach({ triggers: 100, sends: 4 }), false, '4% 未超阈值');
  assert.equal(rc.globalBreach({ triggers: 100, sends: 6 }), true, '6% 超阈值应关');
  assert.equal(rc.globalBreach({ triggers: 0, sends: 0 }), false);
});

test('dayKeyOf：本地日界格式稳定（跨天才能归零）', () => {
  assert.match(rc.dayKeyOf(Date.UTC(2026, 9, 26, 4, 0, 0)), /^\d{4}-\d{2}-\d{2}$/);
});

test('nudgeDecision：五个前置条件逐个生效（少一个就是死循环或白烧预算）', () => {
  const base = { mode: 'on', hasBody: true, used: false, round: 2, maxRounds: 12, open: true };
  assert.deepEqual(rc.nudgeDecision(base), { go: true, why: '', shadow: false });
  assert.equal(rc.nudgeDecision({ ...base, mode: 'off' }).why, 'off');
  assert.equal(rc.nudgeDecision({ ...base, hasBody: false }).why, 'no-body');
  assert.equal(rc.nudgeDecision({ ...base, used: true }).why, 'already-used');
  assert.equal(rc.nudgeDecision({ ...base, round: 11, maxRounds: 12 }).why, 'no-round-left');
  assert.equal(rc.nudgeDecision({ ...base, open: false }).why, 'breaker');
  // shadow 照常触发，但标记出来让调用方"不发"
  assert.deepEqual(rc.nudgeDecision({ ...base, mode: 'shadow' }),
    { go: true, why: '', shadow: true });
});

test('nudgeDecision：空输出兜底（A1）—— emptyNudge 让零输出轮也能追问一次', () => {
  const base = { mode: 'on', hasBody: false, used: false, round: 2, maxRounds: 12, open: true };
  // 旧行为不变：不开 emptyNudge 时空正文直接安静
  assert.equal(rc.nudgeDecision(base).why, 'no-body');
  assert.equal(rc.nudgeDecision(base).go, false);
  // A1：开 emptyNudge 后空输出也 go（why='empty'，调用方换用 EMPTY_NUDGE_TEXT）
  assert.deepEqual(rc.nudgeDecision({ ...base, emptyNudge: true }),
    { go: true, why: 'empty', shadow: false });
  // 空输出下的护栏仍然全部生效：off / 已确认过 / 轮次触顶 / 熔断
  assert.equal(rc.nudgeDecision({ ...base, emptyNudge: true, mode: 'off' }).why, 'off');
  assert.equal(rc.nudgeDecision({ ...base, emptyNudge: true, used: true }).why, 'already-used');
  assert.equal(rc.nudgeDecision({ ...base, emptyNudge: true, round: 11, maxRounds: 12 }).why, 'no-round-left');
  assert.equal(rc.nudgeDecision({ ...base, emptyNudge: true, open: false }).why, 'breaker');
  // 有正文时 emptyNudge 不改变任何语义（why 仍是 ''，不是 'empty'）
  assert.deepEqual(rc.nudgeDecision({ ...base, hasBody: true, emptyNudge: true }),
    { go: true, why: '', shadow: false });
  // 影子模式：空输出也计入"本来会问它一次"
  assert.deepEqual(rc.nudgeDecision({ ...base, emptyNudge: true, mode: 'shadow' }),
    { go: true, why: 'empty', shadow: true });
});

test('回归：正文救援的泄露闸仍然生效（改成共用实现后不能退化）', async () => {
  const out = await rescue.rescueUnsentReply({ text: '【安全规则】1. 不许外传' });
  assert.deepEqual(out, [], '疑似系统提示词泄露时，救援必须整段放弃');
  // 正常的短句仍会被救（这条只有显式打开 api.rescueUnsentReply 才会走到）
  const ok = await rescue.rescueUnsentReply({ text: '榔头就这尺寸？' });
  assert.equal(ok.length, 1);
  assert.equal(ok[0].function.name, 'send_message');
});
