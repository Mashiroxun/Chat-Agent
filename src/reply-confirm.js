// 发言自确认（nudge）· 裁判 · 泄露闸 · 熔断 —— 全部是纯逻辑，方便逐条测。
//
// ── 这组东西解决什么 ──────────────────────────────────────────────────────
// 背景（2026-10-26 反馈）：模型"觉得没必要回复"时，会把盘算写在正文里；而
// reply-rescue 那张"正文抢救网"会把正文当成没发出去的成稿，合成一条
// send_message 真的发进群 —— 群友看到的就是机器人的内心戏。实测 15 句典型
// 内心戏里 13 句会被它发出去（黑名单只覆盖了极少数说法）。
//
// 为什么不是"把黑名单写得更全"：文本层没有区分力。用 129 条真实发出去的话
// 做对照，一版"必须有问号/第二人称/与触发消息承接"的严格闸门只有 22% 通过 ——
// 收紧到这个程度，真正该救的成稿也一起被拒；放松一点，内心戏又漏出去。
// 所以换维度：**不猜文本，让模型自己确认，再让裁判复核**。
//
// ── 四件套 ────────────────────────────────────────────────────────────────
//   1. NUDGE_TEXT      模型没调工具就收尾时，追加一次"要说就原样发、只是思考就 finish"
//   2. buildJudgeMessages / parseVerdict  模型选了"发"之后，由裁判做最后一道二分类
//   3. looksLikeLeak   系统提示/密钥泄露闸（所有发送都要过，见 tools.js send_message）
//   4. breakerOpenUntil / globalBreach    熔断：防"这个模型整体被 nudge 诱导成话痨"
//
// ── 失败方向必须一致 ──────────────────────────────────────────────────────
// 这里每个函数在"拿不准"时都往"不发/不启用"一侧倒（fail-closed）。判错的代价
// 是"少说一句"（用户感觉和没被叫到一样），而不是"把内心戏发进群"（事故）。

/**
 * 追加给模型的确认消息。
 *
 * 措辞的三个硬约束（改之前先读）：
 *   ① finish 在前、send 在后。"顺口就能发"会把模型推向发送，顺序反过来才偏保守。
 *   ② **不复述原文**。复述等于告诉它"稿子我给你备好了，按发送吧"，等于用提示词
 *      制造新的误发源 —— 那比原来的正则更难查。
 *   ③ 明确写"什么都不发也是正常结果"，否则"回应义务"那段会把它顶成必须说话。
 */
export const NUDGE_TEXT = [
  '【收尾确认】上一轮你没有调用任何工具，正文只留在思考里，群里没有任何人看到。',
  '如果那段正文只是你的判断、盘算或自言自语，现在调用 finish 结束这次处理 —— 什么都不发是完全正常的，不需要解释。',
  '只有当那句话确实是要对群友说的，才调用 send_message 把它发出去；原样发，不要润色、不要补充说明、不要顺带多聊一句。',
  '两条路选一条，不要都不选。'
].join('\n');

/**
 * 空输出专用确认（bug 清单 A1，2026-10-27）：
 * 某轮 completionTokens>0 但正文 0 字、也没有 tool_calls —— 旧逻辑里
 * nudgeDecision 的 hasBody 前置直接把它判成"没有要发的东西"→ 会话 noreply，
 * 群里的人什么都收不到（实测会话 mvpytymd-…：模型烧了 175 token 纯思考）。
 * 推理型模型/换网关后这类空输出会变多，核心必须自己兜一轮。
 */
export const EMPTY_NUDGE_TEXT = [
  '【空输出确认】上一轮你没有任何输出：正文是空的，也没有调用任何工具 —— 群里没有人看到任何东西。',
  '如果你有想说的话，现在调用 send_message 发出去（原样发，不要润色、不要补充说明）。',
  '如果确实这轮没什么可说的，调用 finish 结束这次处理 —— 什么都不发是完全正常的。',
  '两条路选一条，不要都不选。'
].join('\n');

export const JUDGE_SYSTEM = [
  '你是群聊发言复核器，不是聊天参与者。判断"候选句"是模型要对群友说的话，还是它自己的思考。',
  '对群友说的话：有明确的接收对象或承接群里的内容，带信息、态度或情绪。',
  '自言自语：在权衡要不要回、评价话题、描述自己的动作、复述规则或计划。',
  '拿不准一律判 false（宁可这轮不说话，也不能把内心戏发进群）。',
  '只输出 JSON，不要任何其它文字：{"say":true,"why":"20字以内"}'
].join('\n');

/**
 * 裁判的输入。刻意只给三样：本轮收到的消息、最近几条上下文、候选句。
 * 给多了（系统提示、角色卡、完整历史）它就变成"再跑一次对话"，又慢又贵，
 * 而且会被角色设定带跑 —— 这里只需要一个"这是对谁说的话"的判定。
 */
export function buildJudgeMessages({ candidate = '', trigger = '', recent = [] } = {}) {
  const clips = (v, n) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n);
  const context = (Array.isArray(recent) ? recent : []).slice(-5)
    .map((m) => (typeof m === 'string' ? m : `${m?.senderName ?? ''}：${m?.text ?? ''}`))
    .filter(Boolean)
    .map((s) => clips(s, 80))
    .join('\n');
  return [
    { role: 'system', content: JUDGE_SYSTEM },
    {
      role: 'user',
      content: [
        `【本轮收到的消息】\n${clips(trigger, 400) || '（无）'}`,
        `【最近聊天】\n${context || '（无）'}`,
        `【候选句】\n${clips(candidate, 300)}`
      ].join('\n\n')
    }
  ];
}

/** 引号归一化 + 去代码围栏，模型经常把 JSON 包在 ``` 里或用中文引号。 */
function normalizeJsonText(text) {
  return String(text ?? '')
    .replace(/```[a-z]*\s*/gi, '')
    .replace(/```/g, '')
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .trim();
}

/**
 * 解析裁判输出。返回 { say, why } 或 null。
 * null 一律由调用方当作"不发"处理 —— 解析不出来就别赌。
 */
export function parseVerdict(text) {
  const raw = normalizeJsonText(text);
  if (!raw) return null;
  let obj = null;
  try { obj = JSON.parse(raw); } catch { /* 下面再抠 */ }
  if (!obj) {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    try { obj = JSON.parse(raw.slice(first, last + 1)); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  let say = obj.say;
  if (typeof say === 'string') {
    const s = say.trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === '1') say = true;
    else if (s === 'false' || s === 'no' || s === '0') say = false;
  }
  if (typeof say !== 'boolean') return null;
  return { say, why: String(obj.why ?? '').slice(0, 40) };
}

/**
 * 系统提示词 / 内部配置 / 密钥的泄露特征。
 *
 * 只匹配**结构性强、正常聊天不会出现**的形态，不做泛化 —— 误伤一次就是让机器人
 * 该说话时闭嘴。覆盖 prompt.js 里各段的可识别首句，以及模型复述时最常带的结构标记。
 */
export const LEAK_PATTERNS = [
  /【安全规则/, /【工作方式/, /【过去状态/, /【本次唤醒/, /【此刻状态/, /【引导说明/,
  /你是[「"']?(?:一个|一位)?QQ\s*群/i, /你没有本地工具/,
  /^#\s*(?:角色|人设|设定)\s*[:：]/m,
  /^\s*(?:system|assistant)\s*[:：]\s/im,
  /(?:apiKey|api_key|accessToken|Authorization)\s*[:=]/i,
  /sk-[A-Za-z0-9]{16,}/
];

export function looksLikeLeak(text) {
  const s = String(text ?? '');
  if (!s) return false;
  return LEAK_PATTERNS.some((re) => re.test(s));
}

/**
 * 这句里有没有"对外"的痕迹 —— 只用于**熔断统计**，绝不用于单条消息的放行判断。
 * 单条判断交给裁判（模型语义），这里只是给"这个群是不是被诱导成话痨"提供一个粗糙计数器。
 */
export function outwardHit(text) {
  const t = String(text ?? '');
  if (!t) return false;
  if (/[?？]/.test(t)) return true;
  if (/你|您|大家|各位/.test(t)) return true;
  return /(?:吗|呢|啥|怎么|为什么|几点)[。！!？?]?$/.test(t.trim());
}

export const BREAKER = {
  suspectStreak: 3,        // 连续 N 次"短句 + 无对外痕迹"的补发 → 认为被诱导
  openMs: 60 * 60 * 1000,  // 该群冷却 1 小时
  globalMinTriggers: 40,   // 全局统计的最小样本
  globalRatio: 0.05        // 补发/唤醒 超过 5% → 全局关掉自确认
};

/**
 * 这一轮要不要触发自确认。抽成纯函数是因为它有 5 个前置条件，
 * 写在 orchestrator 里既难读也没法逐条验证（少一个条件就是一次死循环或一次白烧）。
 *
 * @param {boolean} [emptyNudge=false] 空输出也追问（A1，2026-10-27）。
 *   false 时保持旧语义：正文空 → no-body 直接安静。true 时空正文也会 go
 *   （why='empty'，调用方据此换用 EMPTY_NUDGE_TEXT），只有 off/used/轮次/熔断
 *   这些真正的护栏还能拦住它 —— 否则"模型烧了预算却零输出"永远没人兜底。
 *
 * @returns {{go:boolean, why:string, shadow:boolean}}
 *   go=false 时 why 是原因（off / no-body / already-used / no-round-left / breaker），
 *   用于日志分流：只有 breaker 值得打日志，其余都是常态。
 */
export function nudgeDecision({ mode = 'on', hasBody = false, used = false, round = 0, maxRounds = 12, open = true, emptyNudge = false } = {}) {
  const m = String(mode || 'on').trim().toLowerCase();
  if (m === 'off') return { go: false, why: 'off', shadow: false };
  if (!hasBody && !emptyNudge) return { go: false, why: 'no-body', shadow: false };
  if (used) return { go: false, why: 'already-used', shadow: false };
  if (Number(round) + 1 >= Number(maxRounds)) return { go: false, why: 'no-round-left', shadow: false };
  if (!open) return { go: false, why: 'breaker', shadow: false };
  return { go: true, why: hasBody ? '' : 'empty', shadow: m === 'shadow' };
}

/** 该群是否需要进入冷却。返回 0 = 不需要。 */
export function breakerOpenUntil({ suspectStreak = 0, now = Date.now() } = {}) {
  return Number(suspectStreak) >= BREAKER.suspectStreak ? Number(now) + BREAKER.openMs : 0;
}

/** 全局是否该关掉自确认。样本不足时永不触发。 */
export function globalBreach({ triggers = 0, sends = 0 } = {}) {
  const t = Number(triggers) || 0;
  const s = Number(sends) || 0;
  if (t < BREAKER.globalMinTriggers) return false;
  return s / t > BREAKER.globalRatio;
}

/** 本地日界（熔断统计按天归零）。 */
export function dayKeyOf(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
