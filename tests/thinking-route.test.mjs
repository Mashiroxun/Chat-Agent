// 思考档分流（2026-11-12）——按触发类型决定本轮要不要思考、要多重。
//
// 覆盖三件事：
//   1. src/thinking-route.js 的意图判定：轻互动 off / 常规 light / 复杂 full /
//      用户显式设置与总开关 passthrough；
//   2. plugins/thinking-adapters 的 shapeThinkingApi：同一意图在不同方言上的
//      安全翻译（不支持的能力一律不硬发参数）；
//   3. 端到端 llm.request-params：尤其验证「orchestrator 传下来的
//      thinkingMode 恒为 auto」不会把分流结果压掉 —— 这是最可能静默失效的点。

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { routeThinking, escalateForTools, ROUTE_TIERS, DEFAULT_THRESHOLDS } = await import('../src/thinking-route.js');
const adapters = await import('../plugins/thinking-adapters/index.js');

const SN = { baseUrl: 'https://token.sensenova.cn/v1', model: 'sensenova-6.8-flash-lite' };
const DS = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' };
const GLM = { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.2' };
const GENERIC = { baseUrl: 'https://example.com/v1', model: 'some-unknown-model' };

const apiOf = (o) => ({
  ...o,
  thinkingMode: 'auto',
  thinkingEffort: '',
  thinkingBudget: 0
});
const entry = (text, extra = {}) => ({
  text, isPoke: false, atSelf: false, media: [], reply: null, ...extra
});
const at = (o = {}) => ({ atMe: true, tierInfo: { tier: 1, count: 20, reason: '被艾特' }, ...o });

// ── 1. 意图判定 ──────────────────────────────────────────────────────────

test('拍一拍 → off（20/121 的历史会话，reasoning 白烧最多的一档）', () => {
  const r = routeThinking({
    triggerEntries: [entry('[拍一拍] 某某(QQ:2674128) 拍了拍我', { isPoke: true, pokeSelf: true })],
    tierInfo: { tier: 1, count: 20, reason: '拍了拍我' }
  });
  assert.equal(r.tier, ROUTE_TIERS.OFF);
  assert.equal(r.routed, true);
  assert.match(r.reason, /拍一拍/);
});

test('纯表情 / 空文本 → off', () => {
  const r = routeThinking({ triggerEntries: [entry('[表情5]', { media: [{ kind: 'face', faceId: '5' }] })] });
  assert.equal(r.tier, ROUTE_TIERS.OFF);
  assert.equal(r.signals.plain, '');
});

test('极短附和 → off；带 @ 或问号就不是附和', () => {
  assert.equal(routeThinking({ triggerEntries: [entry('666')] }).tier, ROUTE_TIERS.OFF);
  assert.equal(routeThinking({ triggerEntries: [entry('妈的')] }).tier, ROUTE_TIERS.OFF);
  assert.equal(routeThinking(at({ triggerEntries: [entry('@小鲸鱼[AI](QQ:10001) 嗯')] })).tier,
    ROUTE_TIERS.LIGHT);
  assert.equal(routeThinking({ triggerEntries: [entry('在吗？')] }).tier, ROUTE_TIERS.LIGHT);
});

test('纯图片不判 off：看图要先决定要不要调取图工具', () => {
  const r = routeThinking({ triggerEntries: [entry('[图片]', { media: [{ kind: 'image' }] })] });
  assert.equal(r.tier, ROUTE_TIERS.LIGHT);
  assert.equal(r.signals.hasImage, true);
});

test('常规 @ / 单图 / 引用 / 主动机会 / 私聊 → light', () => {
  assert.equal(routeThinking(at({ triggerEntries: [entry('@小鲸鱼[AI](QQ:10001) 锐评梁文峰')] })).tier,
    ROUTE_TIERS.LIGHT);
  assert.equal(routeThinking({ proactive: true, triggerEntries: [] }).tier, ROUTE_TIERS.LIGHT);
  assert.equal(routeThinking({ kind: 'private', triggerEntries: [entry('嗯')] }).tier, ROUTE_TIERS.LIGHT);
  const quoted = routeThinking({ triggerEntries: [entry('[引用 小鲸鱼[AI](QQ:10001)：那你娶他吧]@小鲸鱼[AI](QQ:10001) 那你该叫我妈了')] });
  assert.equal(quoted.tier, ROUTE_TIERS.LIGHT);
});

test('复杂信号 → full（保持原行为，不冒降质风险）', () => {
  assert.equal(routeThinking({ triggerEntries: [entry('帮我查一下这周哪个模型最便宜')] }).tier,
    ROUTE_TIERS.FULL);
  assert.equal(routeThinking({ triggerEntries: [entry('甲'.repeat(130))] }).tier,
    ROUTE_TIERS.FULL);
  assert.equal(routeThinking({
    triggerEntries: [
      entry('[图片]', { media: [{ kind: 'image' }] }),
      entry('[图片]', { media: [{ kind: 'image' }] })
    ]
  }).tier, ROUTE_TIERS.FULL);
});

test('引用块里嵌套的 [AI] 不会让被引正文泄漏进实质文本', () => {
  const r = routeThinking({
    triggerEntries: [entry('[引用 小鲸鱼[AI](QQ:10001)：那你娶他吧]@小鲸鱼[AI](QQ:10001) 嗯')]
  });
  assert.ok(!r.signals.plain.includes('那你娶他吧'));
  assert.equal(r.signals.plain.length <= DEFAULT_THRESHOLDS.shortChatter, true);
  // 但带 @ 仍不该判 off（明确召唤）
  assert.equal(routeThinking({
    atMe: true,
    triggerEntries: [entry('[引用 小鲸鱼[AI](QQ:10001)：那你娶他吧]@小鲸鱼[AI](QQ:10001) 嗯')]
  }).tier, ROUTE_TIERS.LIGHT);
});

test('主设置显式 off/on、总开关 false → passthrough（一键回滚）', () => {
  const args = { triggerEntries: [entry('666')] };
  assert.equal(routeThinking({ ...args, baseMode: 'off' }).tier, ROUTE_TIERS.PASSTHROUGH);
  assert.equal(routeThinking({ ...args, baseMode: 'on' }).tier, ROUTE_TIERS.PASSTHROUGH);
  assert.equal(routeThinking({ ...args, enabled: false }).tier, ROUTE_TIERS.PASSTHROUGH);
  assert.equal(routeThinking({ ...args, baseMode: 'off' }).routed, false);
  // auto 才是分流的生效范围
  assert.equal(routeThinking({ ...args, baseMode: 'auto' }).tier, ROUTE_TIERS.OFF);
});

test('灰度开关 allowOff=false：off 一律升为 light，且理由里可追溯', () => {
  const cases = [
    { triggerEntries: [entry('666')] },
    { triggerEntries: [entry('[拍一拍] 拍了拍我', { isPoke: true, pokeSelf: true })], tierInfo: { tier: 1, count: 20, reason: '拍了拍我' } },
    { triggerEntries: [entry('[表情5]', { media: [{ kind: 'face' }] })] }
  ];
  for (const args of cases) {
    const r = routeThinking({ ...args, allowOff: false });
    assert.equal(r.tier, ROUTE_TIERS.LIGHT);
    assert.match(r.reason, /灰度：off→light/);
    assert.equal(routeThinking({ ...args, allowOff: true }).tier, ROUTE_TIERS.OFF);
  }
});

test('escalateForTools：只把 off 升一档到 light，其余保持，且不改原对象', () => {
  const off = { tier: 'off', reason: '拍一拍轻召唤', routed: true };
  const up = escalateForTools(off);
  assert.equal(up.tier, ROUTE_TIERS.LIGHT);
  assert.match(up.reason, /工具链升档/);
  assert.equal(off.tier, 'off');                    // 纯函数，不改入参
  for (const tier of ['light', 'full', 'passthrough']) {
    assert.equal(escalateForTools({ tier, routed: tier !== 'passthrough' }), null);
  }
  assert.equal(escalateForTools(null), null);
  assert.equal(escalateForTools({ tier: 'off', routed: false }), null);
});

// ── 2. 方言翻译 ──────────────────────────────────────────────────────────

test('shapeThinkingApi：商汤 light → on+low，off → off，full → 原样', () => {
  const base = apiOf(SN);
  const light = adapters.shapeThinkingApi(base, { thinkingRoute: { tier: 'light', routed: true } });
  assert.equal(light.thinkingMode, 'on');
  assert.equal(light.thinkingEffort, 'low');
  const off = adapters.shapeThinkingApi(base, { thinkingRoute: { tier: 'off', routed: true } });
  assert.equal(off.thinkingMode, 'off');
  const full = adapters.shapeThinkingApi(base, { thinkingRoute: { tier: 'full', routed: true } });
  assert.deepEqual(full, base);
});

test('shapeThinkingApi：DeepSeek 有强度档 → light 发 low，不再退化成关思考', () => {
  const route = { thinkingRoute: { tier: 'light', routed: true } };
  const shaped = adapters.shapeThinkingApi(apiOf(DS), route);
  assert.equal(shaped.thinkingMode, 'on');
  assert.equal(shaped.thinkingEffort, 'low');
  const req = adapters.resolveThinkingRequest(shaped, shaped.thinkingMode);
  assert.equal(req.params.reasoning_effort, 'low');
});

test('shapeThinkingApi：DeepSeek full → 显式 effort:high，与 light 共享缓存命名空间', () => {
  // 2026-11-12 实测：DeepSeek 缓存键含思考开关（是否带 reasoning_effort），
  // full 不发参数 = 与 light 分属两个命名空间，翻转即冷启动（实测命中跌到 11%）。
  // full 显式发 effort:'high'（方言表 medium 本就映射 high，≈ 默认强度）后并档。
  const shaped = adapters.shapeThinkingApi(apiOf(DS), { thinkingRoute: { tier: 'full', routed: true } });
  assert.equal(shaped.thinkingMode, 'on');
  assert.equal(shaped.thinkingEffort, 'high');
  const req = adapters.resolveThinkingRequest(shaped, shaped.thinkingMode);
  assert.equal(req.params.reasoning_effort, 'high');
  assert.equal(req.omitTemperature, true);        // 思考模式与 temperature 互斥
  // 用户显式选择 / 按次覆盖时，full 不插手
  const explicit = { ...apiOf(DS), thinkingMode: 'off' };
  assert.deepEqual(
    adapters.shapeThinkingApi(explicit, { thinkingRoute: { tier: 'full', routed: true } }), explicit);
  // 其余 effort 方言不跟进（openai-o/xai 默认 medium、sensenova 默认偏高，未实测）
  const snFull = adapters.shapeThinkingApi(apiOf(SN), { thinkingRoute: { tier: 'full', routed: true } });
  assert.equal(snFull.thinkingMode, 'auto');
  assert.equal(snFull.thinkingEffort, '');
});

test('deepseek 方言：官方只认 low/high/max，medium→high、minimal→low', () => {
  const B = adapters.internals.buildThinkingParams;
  assert.deepEqual(B({ mode: 'on', dialect: 'deepseek', effort: 'low' }).params, { reasoning_effort: 'low' });
  assert.deepEqual(B({ mode: 'on', dialect: 'deepseek', effort: 'minimal' }).params, { reasoning_effort: 'low' });
  assert.deepEqual(B({ mode: 'on', dialect: 'deepseek', effort: 'medium' }).params, { reasoning_effort: 'high' });
  assert.deepEqual(B({ mode: 'on', dialect: 'deepseek', effort: 'high' }).params, { reasoning_effort: 'high' });
  // 没有 effort 时仍走开关；off 仍用 thinking.type
  assert.deepEqual(B({ mode: 'on', dialect: 'deepseek' }).params, { thinking: { type: 'enabled' } });
  assert.deepEqual(B({ mode: 'off', dialect: 'deepseek' }).params, { thinking: { type: 'disabled' } });
  // GLM-5.2 的强度只有 high/max 真正生效（low/medium 被供应商映射到 high），
  // 所以低档统一给 high —— 发 low 不报错但等于没降档
  assert.deepEqual(B({ mode: 'on', dialect: 'glm', effort: 'low' }).params, { reasoning_effort: 'high' });
});

test('GLM-5.3 强制思考：off 退化为 low，绝不发 thinking.disabled', () => {
  const GLM53 = { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3' };
  const shaped = adapters.shapeThinkingApi(apiOf(GLM53), { thinkingRoute: { tier: 'off', routed: true } });
  assert.equal(shaped.thinkingMode, 'on');            // 关不掉 → 退化为最低强度档
  assert.equal(shaped.thinkingEffort, 'low');
  const req = adapters.resolveThinkingRequest(shaped, shaped.thinkingMode);
  assert.equal(req.params.reasoning_effort, 'low');
  assert.equal(req.params.thinking, undefined);       // 发 disabled 会被 400
  // 5.2 仍可关闭
  const req52 = adapters.resolveThinkingRequest(
    adapters.shapeThinkingApi(apiOf(GLM), { thinkingRoute: { tier: 'off', routed: true } }), 'off');
  assert.deepEqual(req52.params, { thinking: { type: 'disabled' } });
  // generic 完全不动
  const g = apiOf(GENERIC);
  assert.deepEqual(adapters.shapeThinkingApi(g, { thinkingRoute: { tier: 'light', routed: true } }), g);
  assert.deepEqual(adapters.shapeThinkingApi(g, { thinkingRoute: { tier: 'off', routed: true } }), g);
});

test('Kimi K3：temperature 固定 1.0，auto 档也必须摘掉（否则 400）', () => {
  const K3 = { baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3' };
  for (const tier of ['off', 'light', 'full']) {
    const shaped = adapters.shapeThinkingApi(apiOf(K3), { thinkingRoute: { tier, routed: true } });
    const req = adapters.resolveThinkingRequest(shaped, shaped.thinkingMode);
    assert.equal(req.omitTemperature, true, `${tier} 档必须摘 temperature`);
  }
  // off 不能关思考（K3 无关闭档）→ 退化到 low
  const off = adapters.resolveThinkingRequest(
    adapters.shapeThinkingApi(apiOf(K3), { thinkingRoute: { tier: 'off', routed: true } }), 'off');
  assert.equal(off.params.reasoning_effort, 'low');
  // light → low；high 强度 → high
  const light = adapters.resolveThinkingRequest(
    adapters.shapeThinkingApi(apiOf(K3), { thinkingRoute: { tier: 'light', routed: true } }), 'on');
  assert.equal(light.params.reasoning_effort, 'low');
  assert.equal(adapters.internals.buildThinkingParams({
    mode: 'on', dialect: 'kimi-k3', effort: 'high'
  }).params.reasoning_effort, 'high');
});

test('Kimi K2 / 千问 qwen4 / 小米 MiMo：各自只发官方接受的字段', () => {
  const B = adapters.internals.buildThinkingParams;
  // K2.x 用 thinking 开关，temperature 同样固定
  assert.deepEqual(B({ mode: 'off', dialect: 'kimi-k2' }).params, { thinking: { type: 'disabled' } });
  assert.equal(B({ mode: 'off', dialect: 'kimi-k2' }).omitTemperature, true);
  // qwen3 用 enable_thinking + budget；qwen4 改用 reasoning_effort，且不与 budget 并存
  assert.deepEqual(B({ mode: 'off', dialect: 'qwen' }).params, { enable_thinking: false });
  assert.deepEqual(B({ mode: 'on', dialect: 'qwen', budget: 512 }).params, { enable_thinking: true, thinking_budget: 512 });
  assert.deepEqual(B({ mode: 'off', dialect: 'qwen4' }).params, { reasoning_effort: 'low' });
  assert.deepEqual(B({ mode: 'on', dialect: 'qwen4', effort: 'high' }).params, { reasoning_effort: 'xhigh' });
  assert.deepEqual(B({ mode: 'on', dialect: 'qwen4', budget: 512, effort: 'low' }).params, { reasoning_effort: 'low' });
  // 小米 MiMo 只有 none 能关，档位不生效
  assert.deepEqual(B({ mode: 'off', dialect: 'mimo' }).params, { reasoning_effort: 'none' });
  assert.deepEqual(B({ mode: 'on', dialect: 'mimo', effort: 'low' }).params, {});
});

test('shapeThinkingApi：用户显式设置、按次覆盖、passthrough 一律不路由', () => {
  const route = { thinkingRoute: { tier: 'off', routed: true } };
  const explicit = { ...apiOf(SN), thinkingMode: 'on', thinkingEffort: 'high' };
  assert.deepEqual(adapters.shapeThinkingApi(explicit, route), explicit);
  // 回复安全网裁判：skillContext:{thinkingMode:'off'} 必须原样保持
  const perCall = { ...route, thinkingMode: 'off' };
  assert.equal(adapters.shapeThinkingApi(apiOf(SN), perCall).thinkingMode, 'auto');
  assert.equal(adapters.shapeThinkingApi(apiOf(SN), route).thinkingMode, 'off');
  assert.equal(
    adapters.shapeThinkingApi(apiOf(SN), { thinkingRoute: { tier: 'passthrough', routed: false } }).thinkingMode,
    'auto'
  );
});

// ── 3. 端到端请求参数 ────────────────────────────────────────────────────

const params = (api, context) => adapters.providers['llm.request-params']({
  body: { messages: [{ role: 'user', content: 'x' }] },
  api,
  context
});

test('端到端：主对话传 thinkingMode:"auto" 时分流仍生效（防静默失效）', () => {
  // orchestrator 的 skillContext 恒带 thinkingMode=cfg.api.thinkingMode（'auto'），
  // 旧写法 `context?.thinkingMode ?? api?.thinkingMode` 会用这个 auto 压掉一切。
  const ctx = {
    ...apiOf(SN),
    thinkingMode: 'auto',
    thinkingRoute: { tier: 'light', routed: true, reason: '常规对话' }
  };
  const out = params(apiOf(SN), ctx);
  assert.equal(out.body.reasoning_effort, 'low');
  assert.equal(out.thinking.applied, true);

  const off = params(apiOf(SN), { ...ctx, thinkingRoute: { tier: 'off', routed: true } });
  assert.equal(off.body.reasoning_effort, 'none');
});

test('端到端：按次覆盖 off（裁判）优先级高于分流，且不误开思考', () => {
  const out = params(apiOf(SN), {
    ...apiOf(SN),
    thinkingMode: 'off',
    thinkingRoute: { tier: 'full', routed: true }
  });
  assert.equal(out.body.reasoning_effort, 'none');
});

test('端到端：full 与 passthrough 都保持不发参数（与原 auto 逐字节一致）', () => {
  const base = apiOf(SN);
  for (const route of [
    { thinkingRoute: { tier: 'full', routed: true } },
    { thinkingRoute: { tier: 'passthrough', routed: false } },
    {}
  ]) {
    const out = params(base, { ...base, thinkingMode: 'auto', ...route });
    assert.equal(out.body.reasoning_effort, undefined);
    assert.equal(out.thinking.applied, false);
  }
});

test('promptSections 文案不随分流档位变化（2026-11-12 缓存回归修），段 id 仍是易变的 thinking-note', () => {
  const sections = adapters.promptSections({
    ...apiOf(SN),
    thinkingMode: 'auto',
    thinkingRoute: { tier: 'light', routed: true, reason: '常规对话' }
  });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].id, 'thinking-note');
  // ⚠️ 段内容必须**逐字节稳定**：易变块被前置在 userPrompt 稳定区第 3 段
  //   （【当前状态说明】），档位注一旦随 light↔full 翻转，缓存断点就落在
  //   第 3 段，其后【记忆】【场景】【过去状态】全部重算（实测 92%→13%）。
  //   模型的实际思考量由 shapeThinkingApi 的 API 参数控制，与提示词无关。
  assert.doesNotMatch(sections[0].content, /本轮档位/);
  // 档位不同（light vs full）产生的文案必须完全一致，保证前缀缓存不破
  const fullSections = adapters.promptSections({
    ...apiOf(SN),
    thinkingMode: 'auto',
    thinkingRoute: { tier: 'full', routed: true, reason: '复杂任务' }
  });
  assert.equal(sections[0].content, fullSections[0].content);
  // off 路由也**不再**让动态段消失：段的存在性同样必须逐轮稳定（否则 off↔light
  // 翻转时第 3 段整段增删，击穿其后所有内容）。实际关思考由 API 参数完成。
  const offSections = adapters.promptSections({
    ...apiOf(SN),
    thinkingMode: 'auto',
    thinkingRoute: { tier: 'off', routed: true }
  });
  assert.equal(offSections.length, 1);
  assert.equal(offSections[0].content, sections[0].content);
});
