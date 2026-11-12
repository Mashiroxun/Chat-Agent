// 思考模式适配 Skill 入口。
//
// 通过 4 个能力接入核心，**不碰网络、不自己做重试**：
//   llm.request-params   往请求体加本渠道的思考参数
//   llm.response         从响应里提取思考内容
//   llm.usage            统计思考 token
//   llm.retry-advisor    网关拒绝思考参数时，建议"摘掉这些字段重发一次"
//
// 为什么重试要交给 llm.js 执行：如果 Skill 自己再发一次请求，就会绕开
// 超时预算、abort 信号、重试次数上限、日志和计费统计 —— 变成"悄悄多打一次 API"。
// 所以这里只返回"请摘掉这些字段"的建议，动作由核心执行。

import {
  detectDialect, buildThinkingParams, stripThinkingParams, looksLikeThinkingRejection,
  extractReasoning, extractReasoningTokens, THINKING_BODY_KEYS, DIALECT_LABELS
} from './dialects.js';

let cfg = () => ({});
let log = () => {};

export function setup(api) {
  cfg = api.config;
  log = api.log;
}

/** 合法的思考模式取值。写错了以前会**静默不生效**，很难排查。 */
const VALID_MODES = new Set(['off', 'auto', 'on']);

/** orchestrator 传来的本轮思考意图档（src/thinking-route.js）。 */
const ROUTE_TIERS = new Set(['off', 'light', 'full']);
// 档位标签仅用于旧版「本轮档位」提示（2026-11-12 已移除——它随档位变化会击穿
// userPrompt 稳定区前缀缓存，详见 promptSections 内注释）。保留导出供自检页/调试用。
export const ROUTE_LABELS = { off: '不思考', light: '轻思考', full: '按默认' };

/** 「按次覆盖」只在显式 off/on 时算数；auto 是主设置的默认占位，不算覆盖。 */
function explicitOverride(context) {
  const raw = String(context?.thinkingMode ?? '').trim().toLowerCase();
  return VALID_MODES.has(raw) && raw !== 'auto' ? raw : undefined;
}

/**
 * 把本轮「任务多重」的意图翻译成当前模型/网关方言能表达的 mode + effort。
 *
 * 为什么这层要放在插件里、而不是 orchestrator 直接写 thinkingMode：
 *   · 同一个 light 档，商汤是 reasoning_effort:low、DeepSeek/GLM 只能用
 *     thinking:{type:'disabled'}（它们没有强度字段）、generic 干脆一个字都不能发；
 *   · 让编排器去认方言会重复 dialects.js 的规则表，换模型/换网关又要改两处。
 *   编排器只说"这轮活儿轻"，参数由本插件（方言的所有者）决定。
 *
 * 三条安全边界：
 *   ① 用户主设置显式选了 off/on、或调用方已有按次覆盖（回复裁判的 off），一律不路由；
 *   ② full = 完全不干预，与原 auto 行为逐字节一致（复杂任务不冒降质风险）；
 *   ③ 方言不支持对应能力时宁可退回原行为，也绝不给不支持 on 的网关强行开思考。
 *
 * 返回的是**新的 api 对象**，不改原对象；resolveThinkingRequest 从 api 里读
 * thinkingEffort/budget，所以改写 api 就能同时覆盖 mode 和 effort，无需改它的签名。
 */
export function shapeThinkingApi(api = {}, context = {}) {
  const base = { ...api };
  const route = context?.thinkingRoute;
  if (!route || route.routed === false || !ROUTE_TIERS.has(route.tier)) return base;

  const perCall = explicitOverride(context);
  const userMode = String(api?.thinkingMode ?? '').trim().toLowerCase();
  const userExplicit = VALID_MODES.has(userMode) && userMode !== 'auto';
  if (perCall || userExplicit) return base;
  if (route.tier === 'full') {
    // 2026-11-12 实测（api.deepseek.com / deepseek-flash，同前缀对照 7 探针）：
    // DeepSeek 的缓存键 = 消息前缀 + **思考开关（是否带 reasoning_effort）**——
    // light 发 effort:low、full 不发参数，就是两个缓存命名空间；群聊里 light 占
    // 绝大多数，每个 full 轮都是该命名空间的冷启动（实测单次命中跌到 11%）。
    // 另两条实测结论：两种命名空间**并存互不驱逐**（回切立即命中）；effort 取值
    // （low/medium/high）不分键。所以 full 档显式发 effort:'high'——方言表里
    // medium 本就映射到 high，'high' 即本插件词表的最高常规档，≈ 平台默认强度
    // ——即可与 light 共享同一命名空间，档位翻转零缓存成本。
    // ⚠️ 只对 deepseek 生效：openai-o/xai 默认 medium、sensenova 默认档偏高，
    //    给它们显式发档会单方面改变平台默认思考强度，未实测不冒这个险。
    const det = detectDialect({ baseUrl: api?.baseUrl || '', model: api?.model || '' });
    if (det.dialect === 'deepseek' && det.supports.includes('effort')) {
      return { ...base, thinkingMode: 'on', thinkingEffort: 'high' };
    }
    return base;
  }

  const det = detectDialect({ baseUrl: api?.baseUrl || '', model: api?.model || '' });
  const supports = new Set(det.supports || []);

  if (route.tier === 'off') {
    if (supports.has('off')) return { ...base, thinkingMode: 'off', thinkingEffort: '' };
    // 该模型**不支持关闭思考**（GLM-5.3+、Kimi K3、qwen4）：退化为最低强度档。
    // 比"什么都不发、走平台默认的 max"省得多，也不会因为发 disabled 被 400。
    if (supports.has('effort')) return { ...base, thinkingMode: 'on', thinkingEffort: 'low' };
    return base;   // generic / local-openai：保持不发参数
  }

  // light：能降档就降档；不能降档但能明确关闭，就关闭（比平台默认的高思考省）；
  // 两者都不支持就一点不动 —— 尤其不能对只支持 on 的方言发 mode:on 把思考打开。
  // ⚠️ 只看 effort，不要求同时有 on：Kimi K3 这类「始终思考、只能调强度」的模型
  //    supports 只有 ['effort']，若要求 on 会让它的 light 档静默变成不发参数。
  if (supports.has('effort')) {
    return { ...base, thinkingMode: 'on', thinkingEffort: 'low' };
  }
  if (supports.has('off')) {
    return { ...base, thinkingMode: 'off', thinkingEffort: '' };
  }
  return base;
}

/**
 * 把 messages 里的私有 `_reasoning` 按方言落到协议字段（历史思考内容回传）。
 *
 * 为什么需要它（2026-10-24 修）：
 *   DeepSeek V3.2+/V4.x 的 thinking 协议规定 —— **请求带 tools 时，每一条历史
 *   assistant 消息的 reasoning_content 都必须原样回传**（包括没执行工具调用的轮次），
 *   否则工具循环第二轮直接 400：
 *     The `reasoning_content` in the thinking mode must be passed back to the API.
 *   实测触发点：2026-10-17 DeepSeek 静默把 deepseek-flash 换成 V4.1 Flash 1017 之后，
 *   原本跑了 5 天 0 次的错误开始零星出现（历史里一旦有 assistant 就踩雷）。
 *
 * 为什么用私有字段 `_reasoning` 中转、而不是直接写 reasoning_content：
 *   同一个会话可能换端点/换方言（账号池、备选模型）。直接写标准字段的话，
 *   发给 OpenAI / Claude 等严格网关会因未知字段 400；
 *   私有字段由这里按方言决定保留还是丢弃，llm.js 发送前还会兜底清洗。
 *
 * 为什么「不带 tools 就不回传」：
 *   官方规则是「带 tools 必须回传，不带 tools 可选且忽略」—— 后者回传只是
 *   白付 reasoning 的 token（一次工具循环的思考内容常有几百 token），没有收益。
 */
function applyHistoryReasoning(body, dialect) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return body;
  const hasPrivate = messages.some((m) => m && typeof m === 'object' && !Array.isArray(m) && '_reasoning' in m);
  if (!hasPrivate) return body;

  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const passBack = hasTools && dialect === 'deepseek';

  return {
    ...body,
    messages: messages.map((m) => {
      if (!m || typeof m !== 'object' || Array.isArray(m) || !('_reasoning' in m)) return m;
      const { _reasoning, ...rest } = m;
      if (passBack && typeof _reasoning === 'string' && _reasoning.trim()) {
        return { ...rest, reasoning_content: _reasoning };
      }
      return rest;
    })
  };
}

/** 当前生效的思考请求（UI / 排障用）。 */
export function resolveThinkingRequest(api = null, modeOverride = undefined) {
  const s = cfg();
  // 设置页「思考强度」：api.thinkingMode/Effort/Budget 是模型 API 区的口径，
  // 与本插件自身设置并存 —— api.* 优先（那是用户在主设置页明确选的），
  // 没设置过（undefined）才回落插件设置（技能页表单）。
  const userMode = String(api?.thinkingMode ?? '').trim().toLowerCase();
  const fallbackMode = String(s.mode || 'auto').trim().toLowerCase();
  // 优先级：调用方按次覆盖 > api.thinkingMode（设置页） > 插件设置 > auto
  const rawMode = String((modeOverride !== undefined ? modeOverride : (VALID_MODES.has(userMode) ? userMode : fallbackMode)) ?? '').trim().toLowerCase();
  const modeValid = VALID_MODES.has(rawMode);
  if (!modeValid) {
    // 不再静默：明确告诉用户配置值无效，并回落到 auto（安全的默认）
    log(`思考模式取值无效（${JSON.stringify(rawMode || '(空)')}），已按 auto 处理；可选值：off / auto / on`);
  }
  const mode = modeValid ? rawMode : 'auto';
  const det = detectDialect({ baseUrl: api?.baseUrl || '', model: api?.model || '' });
  const eff = String(api?.thinkingEffort ?? s.effort ?? '').trim().toLowerCase();
  const budget = Number(api?.thinkingBudget) > 0 ? Number(api.thinkingBudget) : (Number(s.budget) || 0);
  const built = buildThinkingParams({
    mode,
    dialect: det.dialect,
    effort: ['low', 'medium', 'high'].includes(eff) ? eff : '',
    budget
  });
  return {
    mode,
    modeRaw: rawMode,
    modeValid,
    warning: modeValid ? '' : `思考模式取值无效（${rawMode || '空'}），已按 auto 处理；可选 off / auto / on`,
    dialect: det.dialect,
    dialectLabel: det.label,
    supports: det.supports,
    applied: built.applied,
    params: built.params,
    omitTemperature: built.omitTemperature,
    reason: det.reason
  };
}

export const providers = {
  // ── 请求参数 ──
  'llm.request-params': ({ body, api, context }) => {
    // context.thinkingMode 允许调用方为**这一次请求**覆盖模式（'off' 表示别思考）。
    // 典型场景：回复安全网的裁判、其它分类/判定类调用 —— 它们不需要思考，
    // 开着思考只会多烧一轮 reasoning token 还更慢。
    // 这是"按次覆盖"，不改用户配置，下一次正常对话仍然按配置走。
    // api.thinkingMode（设置页-模型 API「思考强度」）同样按次传入，优先于插件自身设置。
    //
    // 2026-11-12 分流：主对话的 skillContext.thinkingRoute 是「本轮任务多重」的意图，
    // 由 shapeThinkingApi 按方言翻译成 mode/effort。⚠️ 不能写成原来的
    // `context?.thinkingMode ?? api?.thinkingMode` —— 编排器传下来的 thinkingMode
    // 恒为 'auto'（主设置默认值），`??` 不会回落，会把翻译结果整个压掉、分流静默失效。
    // 所以只有**显式 off/on** 才算按次覆盖，auto 让位给分流。
    const shaped = shapeThinkingApi(api, context);
    const override = explicitOverride(context);
    const req = resolveThinkingRequest(shaped, override ?? shaped.thinkingMode);
    // 历史思考内容回传：与本次是否发送 thinking 参数无关 ——
    // mode=auto 且模型默认思考时，上游照样会要求回传（这正是本次 400 的现场）。
    const withHistory = applyHistoryReasoning(body, req.dialect);
    if (!req.applied) {
      // 不应用时也要告诉调用方"如需降级请摘掉这些键"，但不动 body
      return { body: withHistory, thinking: { applied: false, mode: req.mode, dialect: req.dialect } };
    }
    const next = { ...withHistory, ...req.params };
    return {
      body: next,
      omitTemperature: req.omitTemperature,
      thinking: { applied: true, mode: req.mode, dialect: req.dialect, keys: THINKING_BODY_KEYS }
    };
  },

  // ── 响应加工 ──
  'llm.response': ({ result }) => {
    const reasoning = extractReasoning(result.message);
    if (!reasoning) return {};
    return { result: { reasoning } };
  },

  // ── usage 附加统计 ──
  'llm.usage': ({ usage }) => {
    const n = extractReasoningTokens(usage);
    return n ? { reasoningTokens: n } : {};
  },

  // ── 降级建议 ──
  // 只在错误文本确实在抱怨思考字段时才建议重试，避免把普通 400（例如
  // 模型名写错、Key 无效）也重试一遍，白白多花一次调用。
  'llm.retry-advisor': ({ body, errorText }) => {
    if (!looksLikeThinkingRejection(errorText)) return null;
    const keys = THINKING_BODY_KEYS.filter((k) => k in body);
    if (!keys.length) {
      // 「必须回传 reasoning_content」型：问题在**历史消息**，不在请求参数。
      // mode=auto（不发 thinking 参数）时这里必然无参数可摘 —— 摘参数也治不了，
      // 只能把根因写进日志，避免只看到一句原始 400 却不知道往哪查。
      if (/reasoning[\s_-]*content/i.test(String(errorText || ''))) {
        log('上游要求回传历史 reasoning_content，但请求里没有思考参数可摘（问题在历史消息，不在参数）；'
          + '已由 applyHistoryReasoning 在下一轮修补，本次不重试');
      }
      return null;
    }
    log(`网关拒绝思考参数（命中字段：${keys.join(', ')}），摘掉后重试一次`);
    return {
      body: stripThinkingParams(body),
      reason: `网关不支持思考参数（${keys.join('/')}），已去掉后重试`
    };
  },

  // ── 方言识别（给 UI / 其它模块用） ──
  'model.thinking-detect': ({ baseUrl, model }) => detectDialect({ baseUrl, model })
};

export function promptSections(context = {}) {
  // ⚠️ 必须吃 context（2026-10-16 第二轮审查修）。
  //
  // 原来是**无参**调用 resolveThinkingRequest()：detectDialect 拿到
  // {baseUrl:'', model:''} → 恒判 generic → 段里写「当前思考模式：auto
  // （通用（不发送思考参数））」。而运行时 llm.request-params 用的是真实
  // 端点（可能是 DeepSeek / 通义 / GLM…），参数照样在发 —— 于是提示词里
  // 是一句**与事实相反**的描述，模型会误以为本轮没有思考。
  //
  // 为什么不改成"静态段只留稳定信息、删掉模式与方言"：
  // 本段 id 是 'thinking-note'，已被 prompt.js 的 VOLATILE_SECTION_IDS
  // 收进易变白名单，orchestrator 恒以 deferVolatile:true 调用 —— 它本来
  // 就被渲染到**用户提示词末尾**，不占系统提示前缀、不影响缓存命中。
  // 所以这里该追求的是"说得准"，不是"不说"。
  //
  // context 由 orchestrator 的 skillContext 提供（model / baseUrl /
  // thinkingMode / thinkingEffort / thinkingBudget，口径与 llm.js 的
  // effectiveApi() 一致）；context 缺失时各项回落插件自身配置。
  //
  // ⚠️⚠️ 显示口径必须是**静态配置**，绝不能吃 thinkingRoute / 按次覆盖
  // （2026-11-12 回归修，推翻上面 2026-10-16 的旧结论）：
  //   本段虽属 VOLATILE_SECTION_IDS（不进系统提示），但 buildUserPrompt 把易变块
  //   **前置**在 userPrompt 稳定区第 3 段（【当前状态说明】，2026-10-12 方向B，
  //   依据"78/78 字节相同"——那是分流上线前的观测）。分流上线后 promptSections
  //   也吃了 route → light 档 mode 显示 on、full 档显示 auto → 每次 light↔full
  //   翻转这段都变几个字 → 缓存断点落在第 3 段 → 其后【记忆】【场景】【过去状态】
  //   全部重算。实测：某轮 light→full，命中率 92%→13%（cached 2048/15927）。
  //   所以这里只描述用户配置的静态模式；每轮真实的思考参数由 llm.request-params
  //   里的 shapeThinkingApi（带 route）控制——那才是行为层，提示词无需逐轮复述。
  //   代价：light 轮里这段说的「auto」与实际发的 effort:low 不完全一致，可接受
  //   （模型不基于这句话做任何决策，它只是背景说明）。
  const shaped = shapeThinkingApi({
    baseUrl: context.baseUrl || '',
    model: context.model || '',
    thinkingMode: context.thinkingMode,
    thinkingEffort: context.thinkingEffort,
    thinkingBudget: context.thinkingBudget
  }, {});   // ← 空上下文：不吃路由、不吃按次覆盖，保证段内容逐字节稳定
  const req = resolveThinkingRequest(shaped, shaped.thinkingMode);
  if (req.mode === 'off') return [];
  return [{
    // ⚠️ id 必须与 plugin.json 里那条**完全相同**（2026-09-20 修）。
    //    原来是 'thinking-active' 而 manifest 是 'thinking-note'，于是
    //    skillManager.getPromptSections 的按-id-去重认不出它们讲的是同一件事，
    //    系统提示里「▸ 思考输出」出现两遍（一遍基础规则、一遍带当前模式），
    //    每次调用白付约 100 字符。
    //    同 id 后由 manager 的去重逻辑保证**后者（本条，信息更全）胜出**；
    //    而当 mode === 'off'（上面提前 return）时，manifest 里那条仍然生效，
    //    所以"关闭思考时仍有一句基本说明"的行为保持不变。
    id: 'thinking-note',
    title: '思考输出',
    priority: 30,
    content: `当前思考模式：${req.mode}（${req.dialectLabel}）。思考内容不会发送给群友，只有调用发送工具才会真正发言。`
  }];
}

export function available() {
  return { ok: true };
}

export const internals = {
  DIALECT_LABELS, THINKING_BODY_KEYS, detectDialect, buildThinkingParams,
  stripThinkingParams, looksLikeThinkingRejection, extractReasoning,
  extractReasoningTokens, extractThinkingTokens: extractReasoningTokens,
  applyHistoryReasoning
};
