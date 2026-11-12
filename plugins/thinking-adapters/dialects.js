// 思考/推理参数方言表。
//
// 为什么需要"方言"这一层：同一件事（让模型先思考再回答）在各家的参数名完全不同，
// 而且**发错参数会被网关直接 400 拒绝**，不是被忽略。常见写法：
//   DeepSeek 思考模型   thinking: { type: 'enabled' | 'disabled' }
//   Qwen / 通义         enable_thinking: true / false（+ thinking_budget）
//   智谱 GLM            thinking: { type: 'enabled' }
//   OpenAI o 系 / GPT-5 reasoning_effort: 'low'|'medium'|'high'
//   OpenRouter          reasoning: { effort } 或 reasoning: { max_tokens }
//   Claude 兼容端点      thinking: { type: 'enabled', budget_tokens }
//   Gemini 兼容端点      extra_body.google.thinking_config.thinking_budget
//   Ollama / vLLM 本地   think: true（部分版本）+ 不支持就别发
//
// 识别依据：模型 id 前缀 + 域名。两者都可能命中，域名优先（同一模型在不同网关行为不同）。

/** 本地/自建端点：不发花哨参数，避免把自建网关打挂。 */
const LOCAL_HOSTS = /^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|host\.docker\.internal)$/i;

/**
 * 规则表：从上往下第一个命中的决定方言。
 *   test      命中条件（模型正则 + 域名正则）
 *   dialect   方言名
 *   supports  该方言能表达哪些控制（off/on/effort/budget）
 */
export const MODEL_RULES = [
  // 本地端点优先（域名命中就不管模型名了）
  { dialect: 'ollama', host: LOCAL_HOSTS, model: null, supports: ['off', 'on'] },
  { dialect: 'local-openai', host: LOCAL_HOSTS, model: null, supports: [] },

  // DeepSeek 官方同时支持「开关」和「强度」（2026-11-12 按官方文档补 effort）。
  //   OpenAI 格式：thinking:{type:'enabled'|'disabled'} 控制开关，
  //                reasoning_effort:'low'|'high'|'max' 控制强度（⚠️ 没有 medium）
  //   Responses API：reasoning:{effort:'none'|'low'|'high'|'max'}，none = 关闭
  // 之前这里只登记了 off/on，导致分流里的 light 档（想降档）只能退化成
  // "完全关思考" —— 实测 reasoning 直接归零、回复明显变干。补上 effort 后，
  // light 会发 reasoning_effort:low，既能省又不至于零思考。
  { dialect: 'deepseek', host: /deepseek\.com$/i, model: /deepseek.*(reasoner|thinking|v4|v3\.\d)/i, supports: ['off', 'on', 'effort'] },
  { dialect: 'deepseek', host: /deepseek\.com$/i, model: /deepseek/i, supports: ['off', 'on', 'effort'] },
  // ── 千问（阿里云百炼 / DashScope）────────────────────────────────────
  // qwen4 起改用 reasoning_effort（low/medium/xhigh，默认 xhigh），且官方明确
  // **reasoning_effort 与 thinking_budget 不能同时设置**；qwen3.5~3.8 仍用
  // enable_thinking + thinking_budget（1~32768）。两代参数不通用，必须分开。
  { dialect: 'qwen4', host: /(dashscope|aliyuncs)\.com$/i, model: /qwen4/i, supports: ['on', 'effort'] },
  { dialect: 'qwen', host: /(dashscope|aliyuncs)\.com$/i, model: /qwen/i, supports: ['off', 'on', 'budget'] },
  { dialect: 'qwen4', host: null, model: /^qwen4/i, supports: ['on', 'effort'] },
  { dialect: 'qwen', host: null, model: /^(qwen|qwq)/i, supports: ['off', 'on', 'budget'] },

  // ── 智谱 GLM ────────────────────────────────────────────────────────
  // GLM-5.3 起**强制思考**：thinking.type 只接受 enabled，传 disabled 直接报错
  // （官方迁移文档原话：需要把 disabled 改成 enabled 并把 reasoning_effort 设为 low）。
  // 所以 5.3+ 单独成方言，off 只能退化到 low，不能发 disabled。
  // GLM-5.2 及更早仍可关闭，但其 reasoning_effort 实际只有 high/max 两档有效
  // （low/medium 会被供应商映射到 high），所以低档统一给 high，不硬发 low 免得被 400。
  { dialect: 'glm-forced', host: /bigmodel\.cn$/i, model: /glm-5\.[3-9]|glm-[6-9]/i, supports: ['on', 'effort'] },
  { dialect: 'glm', host: /bigmodel\.cn$/i, model: /glm/i, supports: ['off', 'on', 'effort'] },
  { dialect: 'glm-forced', host: null, model: /glm-5\.[3-9]|glm-[6-9]/i, supports: ['on', 'effort'] },
  { dialect: 'glm', host: null, model: /glm-(z|4|5)/i, supports: ['off', 'on', 'effort'] },

  // ── Kimi（月之暗面）─────────────────────────────────────────────────
  // K3 系列（kimi-k3 / k3.1-pro）**始终思考**，没有 thinking 参数，只能用顶层
  // reasoning_effort: low/high/max（默认 max）；且 temperature/top_p 被**固定为
  // 1.0 / 0.95**，显式传别的值会报错 —— 必须 omitTemperature，否则 400。
  // K2.x 反过来：用 thinking.type 开关，不认识 reasoning_effort。
  // ⚠️ 官方还提示"切换 effort 档位会破坏前缀缓存命中"，分流对它格外伤缓存。
  { dialect: 'kimi-k3', host: /(moonshot\.(cn|ai)|platform\.kimi\.)/i, model: /kimi-k3/i, supports: ['effort'] },
  { dialect: 'kimi-k2', host: /(moonshot\.(cn|ai)|platform\.kimi\.)/i, model: /kimi/i, supports: ['off', 'on'] },
  { dialect: 'kimi-k3', host: null, model: /^kimi-k3/i, supports: ['effort'] },
  { dialect: 'kimi-k2', host: null, model: /^kimi-k2/i, supports: ['off', 'on'] },

  // ── 小米 MiMo ───────────────────────────────────────────────────────
  // 官方原话：「当前暂不支持自定义调节推理投入档位：参数设为 none 时关闭推理，
  // 其余合法取值均开启推理」。所以只登记 off，on 一律不发参数（发了也不生效）。
  { dialect: 'mimo', host: /mimo\.mi\.com$/i, model: /mimo/i, supports: ['off'] },
  { dialect: 'mimo', host: null, model: /^mimo/i, supports: ['off'] },
  { dialect: 'openai-o', host: /openai\.com$/i, model: /^(o[1-9]|gpt-5)/i, supports: ['effort'] },
  { dialect: 'openai-o', host: null, model: /^(o[1-9](-|$)|gpt-5)/i, supports: ['effort'] },
  { dialect: 'anthropic', host: /(anthropic|claude)\./i, model: /claude/i, supports: ['off', 'on', 'budget'] },
  { dialect: 'anthropic', host: null, model: /claude/i, supports: ['off', 'on', 'budget'] },
  { dialect: 'gemini', host: /(googleapis|generativelanguage)\./i, model: /gemini/i, supports: ['off', 'on', 'budget'] },
  { dialect: 'gemini', host: null, model: /gemini/i, supports: ['off', 'on', 'budget'] },
  { dialect: 'openrouter', host: /openrouter\.ai$/i, model: /./, supports: ['effort', 'budget'] },
  { dialect: 'xai', host: /x\.ai$/i, model: /grok/i, supports: ['effort'] },
  // 商汤日日新 6.8（token.sensenova.cn）：默认开思考且档位偏高，闲聊也照烧几百
  // reasoning token。平台接受 reasoning_effort: low/medium/high/xhigh/none，
  // 其中 none = 关闭思考。实测坑（2026-09，40+ 请求）：thinking 的字符串形态
  // 一律 400，object 形态 {type:'disabled'} 才有效；'max' 在 flash-lite 上 400。
  // 这里只发平台明确接受的取值，auto 模式仍然什么都不发（保持原行为）。
  { dialect: 'sensenova', host: /sensenova\.cn$/i, model: /sensenova/i, supports: ['off', 'on', 'effort'] },
  // 同一网关换用别家模型时，模型名不再含 sensenova，上面那条精确规则会失配。
  // 商汤平台对 deepseek / kimi / mimo 等同样用 reasoning_effort 控制（none 关闭、
  // low~high 调节），补一条同网关兜底，避免换模型后 off 变成空操作。
  // glm 有 host:null 规则走自己的 glm 方言，这里故意不覆盖，保持它原有的
  // thinking.type 行为。未逐模型实测：不认该字段时 retry-advisor 会摘掉后重发。
  { dialect: 'sensenova', host: /sensenova\.cn$/i, model: /^(deepseek|kimi|mimo)/i, supports: ['off', 'on', 'effort'] },
  // 中转站常见：模型名带 deepseek/qwen 前缀但域名是自己的 —— 上面 host:null 的规则已覆盖
  { dialect: 'generic', host: null, model: /./, supports: [] }
];

/** 各方言的可读名称（UI 展示）。 */
export const DIALECT_LABELS = {
  deepseek: 'DeepSeek 思考',
  qwen: '通义千问思考（开关+预算）',
  qwen4: '通义千问推理强度',
  glm: '智谱 GLM 思考',
  'glm-forced': '智谱 GLM（强制思考）',
  'kimi-k3': 'Kimi K3 推理强度',
  'kimi-k2': 'Kimi K2 思考',
  mimo: '小米 MiMo 思考',
  'openai-o': 'OpenAI 推理强度',
  anthropic: 'Claude 思考预算',
  gemini: 'Gemini 思考',
  openrouter: 'OpenRouter reasoning',
  xai: 'xAI 推理强度',
  ollama: 'Ollama 本地',
  'local-openai': '自建 OpenAI 兼容端点',
  sensenova: '商汤 SenseNova 思考强度',
  generic: '通用（不发送思考参数）'
};

export function hostOf(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    // 不带协议的写法（127.0.0.1:1234/v1）也尽量解析
    try { return new URL(`http://${raw}`).hostname.toLowerCase(); } catch { return ''; }
  }
}

export function isLocalEndpoint(baseUrl) {
  const host = hostOf(baseUrl);
  return Boolean(host) && LOCAL_HOSTS.test(host);
}

export function isOllamaEndpoint(baseUrl) {
  const host = hostOf(baseUrl);
  return Boolean(host) && LOCAL_HOSTS.test(host);
}

/**
 * 识别方言。返回 { dialect, label, supports, reason }。
 *
 * ⚠️ 必须**两轮匹配**（先域名、后模型名）来落实"域名优先"：
 *   规则表里 `host: null` 的模型名规则（如 claude / gemini / qwen）排在
 *   具体网关规则（openrouter）之前，单轮"从上往下第一个命中"会让
 *   `openrouter.ai` + `anthropic/claude-3.5-sonnet` 被判成 anthropic 直连，
 *   于是发出 `thinking:{...}` 而不是 OpenRouter 的 `reasoning:{...}` ——
 *   网关 400，思考模式实际失效（还要多打一次 API 去降级重试）。
 */
export function detectDialect({ baseUrl = '', model = '' } = {}) {
  const host = hostOf(baseUrl) || String(baseUrl || '').toLowerCase();
  const id = String(model || '');
  const match = (rule) => {
    if (rule.host && !rule.host.test(host)) return false;
    if (rule.model && !rule.model.test(id)) return false;
    return true;
  };
  const hit = MODEL_RULES.find((r) => r.host && match(r))     // 第一轮：域名优先
    ?? MODEL_RULES.find((r) => !r.host && match(r));          // 第二轮：再看模型名
  if (hit) {
    return {
      dialect: hit.dialect,
      label: DIALECT_LABELS[hit.dialect] || hit.dialect,
      supports: [...hit.supports],
      reason: `${hit.host ? `域名 ${host}` : '模型名'} 命中规则 ${hit.dialect}`
    };
  }
  return { dialect: 'generic', label: DIALECT_LABELS.generic, supports: [], reason: '未命中任何方言规则' };
}

const EFFORT_ALLOWED = new Set(['minimal', 'low', 'medium', 'high']);

function normalizeEffort(effort, supports) {
  if (!supports.includes('effort')) return '';
  const e = String(effort || '').trim().toLowerCase();
  return EFFORT_ALLOWED.has(e) ? e : '';
}

/**
 * 构造要合并进请求体的参数。
 *
 * 返回 { params, omitTemperature, applied }：
 *   params           直接 Object.assign 进 body
 *   omitTemperature  该方言下思考与 temperature 互斥（OpenAI o / DeepSeek 思考），
 *                    调用方需要删掉 temperature，否则被 400 顶回来
 *   applied          本次是否真的加了参数（false 时 UI 显示"未应用"）
 */
export function buildThinkingParams({ mode = 'auto', dialect = 'generic', effort = '', budget = 0 } = {}) {
  const supports = (MODEL_RULES.find((r) => r.dialect === dialect)?.supports) || [];
  const m = String(mode || 'auto').toLowerCase();
  const params = {};
  let omitTemperature = false;
  let applied = false;

  const b = Math.max(0, Number(budget) || 0);
  const eff = normalizeEffort(effort, supports);

  switch (dialect) {
    case 'deepseek': {
      // 与 glm 拆开（2026-11-12）：DeepSeek 官方有强度档，GLM 没有，不能共用分支。
      // reasoning_effort 只接受 low / high / max：
      //   medium 向上取 high —— 降档的目的是省 token，不是降质，拿不准时多思考一点；
      //   minimal 向下取 low（官方没有更低档）；max 不在本插件的 allowed 集合里。
      if (m === 'off') {
        params.thinking = { type: 'disabled' };
        applied = true;
      } else if (m === 'on' && eff) {
        params.reasoning_effort = (eff === 'minimal' || eff === 'low') ? 'low' : 'high';
        applied = true;
      } else if (m === 'on') {
        params.thinking = { type: 'enabled' };
        applied = true;
      }
      if (applied) omitTemperature = true;
      break;
    }
    case 'glm': {
      // GLM-5.2 及更早：能关思考，也能给强度 —— 但强度实际只有 high / max 两档
      // 真正生效（官方与网关的一致口径：low、medium 一律映射到 high，xhigh 映射到 max）。
      // 本插件的 effort 词表是 minimal/low/medium/high，所以统一给 high：
      // 发 low 虽然不报错，但等于没降档，反而让日志和界面显得"降了"。
      if (m === 'off') { params.thinking = { type: 'disabled' }; applied = true; }
      else if (m === 'on' && eff) { params.reasoning_effort = 'high'; applied = true; }
      else if (m === 'on') { params.thinking = { type: 'enabled' }; applied = true; }
      if (applied) omitTemperature = true;
      break;
    }
    case 'glm-forced': {
      // GLM-5.3+：强制思考，发 thinking.disabled 会直接报错。
      // off 只能退化到最低档 low；官方迁移文档也是这么建议的。
      if (m === 'off') { params.reasoning_effort = 'low'; applied = true; }
      else if (m === 'on' && eff) {
        params.reasoning_effort = (eff === 'minimal' || eff === 'low') ? 'low' : 'high';
        applied = true;
      } else if (m === 'on') { params.thinking = { type: 'enabled' }; applied = true; }
      if (applied) omitTemperature = true;
      break;
    }
    case 'qwen': {
      if (m === 'on') { params.enable_thinking = true; applied = true; }
      else if (m === 'off') { params.enable_thinking = false; applied = true; }
      if (applied && b > 0) params.thinking_budget = b;
      break;
    }
    case 'qwen4': {
      // qwen4 起改用 reasoning_effort，取值 low / medium / xhigh（默认 xhigh）；
      // 官方明确 reasoning_effort 与 thinking_budget 不能同时设置，所以这里不碰 budget。
      // off 没有关闭档，退化到最低的 low。
      if (m === 'off') { params.reasoning_effort = 'low'; applied = true; }
      else if (m === 'on') {
        params.reasoning_effort = eff === 'high' ? 'xhigh' : (eff === 'medium' ? 'medium' : 'low');
        applied = true;
      }
      break;
    }
    case 'kimi-k3': {
      // K3 始终思考、没有关闭档；且 temperature / top_p 被固定为 1.0 / 0.95，
      // **显式传别的值会报错**。所以不管哪一档都必须摘掉 temperature。
      // ⚠️ 调用方只在 applied=true 时才带回 omitTemperature，所以 auto 档
      //    也要把 applied 置真（params 为空，body 内容不变）。
      if (m === 'off') { params.reasoning_effort = 'low'; applied = true; }
      else if (m === 'on') {
        params.reasoning_effort = (eff === 'medium' || eff === 'high') ? 'high' : 'low';
        applied = true;
      }
      omitTemperature = true;
      applied = true;
      break;
    }
    case 'kimi-k2': {
      // K2.x 用 thinking 开关，不认识 reasoning_effort。
      // 其 temperature 同样被固定（思考 1.0 / 非思考 0.6），传别的值报错。
      if (m === 'on') { params.thinking = { type: 'enabled' }; applied = true; }
      else if (m === 'off') { params.thinking = { type: 'disabled' }; applied = true; }
      omitTemperature = true;
      applied = true;
      break;
    }
    case 'mimo': {
      // 小米 MiMo：官方「暂不支持自定义推理投入档位」—— 只有 none 能关思考，
      // 其余取值一律开启且无差别。所以 on 不发参数，off 发 none。
      if (m === 'off') { params.reasoning_effort = 'none'; applied = true; }
      break;
    }
    case 'openai-o': {
      if (m === 'on') { params.reasoning_effort = eff || 'medium'; applied = true; }
      else if (m === 'off' && eff) { params.reasoning_effort = 'minimal'; applied = true; }
      if (applied) omitTemperature = true;
      break;
    }
    case 'xai': {
      if (m === 'on') { params.reasoning_effort = eff || 'medium'; applied = true; }
      break;
    }
    case 'sensenova': {
      // off 用平台明确接受的 'none' 关闭思考；on 默认 low（不发 max/xhigh，实测会 400）。
      // 不动 temperature：关掉思考后采样参数重新生效，删掉会悄悄改变回复风格。
      if (m === 'off') { params.reasoning_effort = 'none'; applied = true; }
      else if (m === 'on') { params.reasoning_effort = eff || 'low'; applied = true; }
      break;
    }
    case 'anthropic': {
      if (m === 'on') {
        params.thinking = { type: 'enabled' };
        if (b > 0) params.thinking.budget_tokens = b;
        applied = true;
      } else if (m === 'off') {
        params.thinking = { type: 'disabled' };
        applied = true;
      }
      break;
    }
    case 'gemini': {
      const cfg = {};
      if (m === 'on') cfg.thinking_budget = b > 0 ? b : -1;      // -1 = 动态思考
      else if (m === 'off') cfg.thinking_budget = 0;
      if (Object.keys(cfg).length) {
        params.extra_body = { google: { thinking_config: cfg } };
        applied = true;
      }
      break;
    }
    case 'openrouter': {
      if (m === 'on') {
        params.reasoning = b > 0 ? { max_tokens: b } : { effort: eff || 'medium' };
        applied = true;
      } else if (m === 'off') {
        params.reasoning = { effort: 'minimal' };
        applied = true;
      }
      break;
    }
    case 'ollama': {
      // Ollama 的 think 参数只在新版本支持，且网关常拒绝未知字段 ——
      // 只在明确要求开启时才发
      if (m === 'on') { params.think = true; applied = true; }
      break;
    }
    default:
      // generic / local-openai：不发任何思考参数。宁可没有思考，
      // 也不要因为多发一个未知字段把用户的网关打 400。
      break;
  }

  return { params, omitTemperature, applied };
}

/** 明确列出本 Skill 会往请求体里加的键（降级重试时要把它们摘掉）。 */
export const THINKING_BODY_KEYS = ['thinking', 'enable_thinking', 'thinking_budget', 'reasoning_effort', 'reasoning', 'think', 'extra_body'];

/** 从请求体里摘掉思考相关字段（降级重试用）。 */
export function stripThinkingParams(body = {}) {
  const out = { ...body };
  for (const k of THINKING_BODY_KEYS) delete out[k];
  return out;
}

/**
 * 判断错误文本是否在抱怨"思考参数不被支持"。
 * 要兼容三种字段写法：reasoning_effort / ReasoningEffort / "reasoning effort"
 * （商汤就是回 `field ReasoningEffort invalid` 的驼峰写法，只认下划线会漏判）。
 *
 * ⚠️ 判据不能太宽：早先用「只要文本里出现 thinking 且出现 invalid」，
 * 于是 `invalid model name: deepseek-thinking` 这种**模型名错误**也会被当成
 * "思考参数被拒" → 白白多打一次 API（还会把有用的错误信息掩盖掉）。
 * 现在要求字段名与拒绝词出现在**同一个片段**里，且片段看起来在说"参数/字段"。
 *
 * 2026-10 补「必须回传」型（DeepSeek V3.2+/V4.x thinking 协议）：
 *   The `reasoning_content` in the thinking mode must be passed back to the API.
 * 它不属于"参数不合法"（摘 thinking 参数救不了，问题在历史消息），但确实在说
 * "思考模式与请求历史不匹配"，必须被识别出来 —— 否则 retry-advisor 静默返 null，
 * 日志里只剩一句原始 400，排查时完全看不出根因。
 */
export function looksLikeThinkingRejection(text) {
  const t = String(text || '');
  if (!t) return false;

  // (?<![-\w]) —— 字段名必须是**独立词**。
  // 这条挡住的正是 `invalid model name: deepseek-thinking`：那里的 thinking
  // 是模型名的一部分（前面是连字符），不是参数名，不该触发降级重试。
  const FIELD = '(?<![-\\w])(?:thinking|reasoning[\\s_-]*effort|reasoning[\\s_-]*content|enable[\\s_-]*thinking|budget[\\s_-]*tokens|include[\\s_-]*thoughts|extra_body|思考)';
  const REFUSAL = '(?:invalid|unknown|unrecognized|unsupported|not\\s+support(?:ed)?|unexpected|unused|must\\s+be\\s+passed\\s+back|passed\\s+back|未知|不支持|无效|无法识别|多余)';

  // 1) 「字段 X 不合法」/「X 是未知参数」——字段名与拒绝词在同一小段内
  const near = new RegExp(`${FIELD}[^。.\\n]{0,24}${REFUSAL}|${REFUSAL}[^。.\\n]{0,24}${FIELD}`, 'i');
  if (near.test(t)) return true;

  // 2) 引号形态：「'thinking' is not supported」——字段名被引号包起来
  const quoted = new RegExp(`["'\`]${FIELD}["'\`][^。.\\n]{0,24}${REFUSAL}`, 'i');
  if (quoted.test(t)) return true;

  // 3) 「必须回传」型：reasoning_content 与 passed back 可能隔着
  //    "in the thinking mode "（20+ 字符），超出上面的 24 字符窗口，独立成条。
  return /reasoning[\s_-]*content/i.test(t) && /passed\s+back|必须.{0,8}回传|回传.{0,8}API/i.test(t);
}

/** 提取思考内容。各家的字段名与结构都不一样。 */
export function extractReasoning(message) {
  if (!message || typeof message !== 'object') return '';
  const candidates = [
    message.reasoning_content,
    message.reasoning,
    message.thinking,
    message.thoughts
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  // OpenRouter：reasoning_details 是数组，元素可能是字符串或对象
  if (Array.isArray(message.reasoning_details)) {
    const joined = message.reasoning_details
      .map((d) => (typeof d === 'string' ? d : (d?.text ?? d?.summary ?? '')))
      .filter(Boolean)
      .join('\n');
    if (joined.trim()) return joined;
  }
  // 部分网关把思考塞进 content 的 details 数组
  if (Array.isArray(message.content)) {
    const joined = message.content
      .filter((p) => p?.type === 'thinking' || p?.type === 'reasoning')
      .map((p) => p?.thinking ?? p?.text ?? '')
      .filter(Boolean)
      .join('\n');
    if (joined.trim()) return joined;
  }
  return '';
}

/** 思考消耗的 token（各家的上报位置不同）。 */
export function extractReasoningTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const n = usage.completion_tokens_details?.reasoning_tokens
    ?? usage.reasoning_tokens
    ?? usage.output_tokens_details?.reasoning_tokens
    ?? 0;
  return Number(n) || 0;
}
