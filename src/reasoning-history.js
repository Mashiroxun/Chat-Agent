// assistant 历史的「思考原文」回传 —— DeepSeek V3.2+/V4.x thinking 协议。
//
// 协议要求：**请求带 tools 时，每一条历史 assistant 消息的 reasoning_content
// 必须原样回传**（包括没执行工具调用的轮次），否则工具循环第二轮直接 400：
//   The `reasoning_content` in the thinking mode must be passed back to the API.
// 不带 tools 的请求回传可选、会被忽略。
//
// 为什么需要这个模块：
//   本项目有 5 处各自手写的工具循环（群聊 orchestrator、控制台 4 条路由、
//   开发工单 executor），过去都只挑 role/content/tool_calls 三个字段，
//   reasoning 被丢掉。2026-10-17 DeepSeek 静默把 deepseek-flash 换成
//   V4.1 Flash 1017 后开始严格执行该协议，于是零星出现 400 + 切备用模型。
//
// 设计：
//   · 这里只负责把思考原文存成**私有字段 `_reasoning`**；
//   · thinking-adapters 在发请求前按方言决定是否落成 reasoning_content
//     （非 deepseek 方言直接丢弃，避免未知字段把严格网关打 400）；
//   · llm.js 的 stripPrivateMessageFields 在发送前兜底清洗 `_` 前缀字段。
//   三层配合的结果：只有 deepseek 方言 + 带 tools 的请求会真的带上它。

/**
 * 构建一条 assistant 历史条目（自动附带思考原文）。
 *
 * @param {object} msg   模型响应里的 message（含 content / tool_calls / reasoning_content）
 * @param {object} extra 额外字段（如 raw、或调用方改写过的 tool_calls）
 */
export function assistantHistoryEntry(msg, extra = {}) {
  const entry = {
    role: 'assistant',
    content: msg?.content ?? null,
    tool_calls: msg?.tool_calls,
    ...extra
  };
  const reasoning = typeof msg?.reasoning_content === 'string' ? msg.reasoning_content : '';
  // 原样保存：协议要求 verbatim，不 trim、不改写（只判空）
  if (reasoning.trim()) entry._reasoning = reasoning;
  return entry;
}

/**
 * 给已构建好的条目补上思考原文。
 *
 * 用于"条目的 content/tool_calls 被调用方改写过"的场景（如 inline tool calls
 * 会让正文清空、tool_calls 换成合成 id），此时不能直接用 assistantHistoryEntry。
 *
 * @param {object} entry    目标条目（就地修改并返回）
 * @param {object} msg      模型响应里的 message
 * @param {string} fallback 备选来源（如 Skill 归一化后的 result.reasoning）
 */
export function attachReasoning(entry, msg, fallback = '') {
  const fromMsg = typeof msg?.reasoning_content === 'string' ? msg.reasoning_content : '';
  const reasoning = fromMsg.trim() ? fromMsg : (typeof fallback === 'string' ? fallback : '');
  if (reasoning && reasoning.trim()) entry._reasoning = reasoning;
  return entry;
}
