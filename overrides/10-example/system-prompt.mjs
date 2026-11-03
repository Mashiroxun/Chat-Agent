// 示例层：在系统提示词末尾追加一段规则。
//
// 用法：把同目录 composition.json 的 "enabled" 改成 true，完整退出程序再启动。
// 关掉：改回 false，或直接删掉整个 10-example 目录。
//
// 注意：注入的函数必须保持原实现的参数与返回值契约 —— 这里只是"原样调用 + 追加一段"，
// 是最安全的写法。完全重写提示词构造器也能跑，但要自己保证参数形状不变。

import { buildSystemPrompt as original } from '../../src/prompt.js';

export function systemPrompt(ctx) {
  const base = original(ctx);
  return `${base}\n\n【示例层】这段文字来自 overrides/10-example，删掉该目录即消失。`;
}
