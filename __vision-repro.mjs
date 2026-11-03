// 复现用户反馈：主模型 = pro（纯文本），识图模型 = flash（支持图片）
// 期望：看图应该可用（llm.js 会把带图请求切到 visionModel）
// 实际：orchestrator / routes 的 visionEnabled 只看主模型 → false → 工具被剔除
import { builtinVisionResults } from './src/model-vision-docs.js';

const provider = process.env.PROV || 'opencode-go';
const main = process.env.MAIN || 'deepseek-v4-pro';
const vision = process.env.VIS || 'deepseek-v4-flash';

const doc = builtinVisionResults([{ id: provider, models: [main, vision] }]);
const keyOf = (m) => `${provider}|||${m}`;

const mainVerdict = doc[keyOf(main)]?.verdict ?? 'unknown';
const visionVerdict = doc[keyOf(vision)]?.verdict ?? 'unknown';

// 现在的表达式（orchestrator.js:1659 原样抄来）
const visionEnabledNow = true && mainVerdict !== 'no-vision';

console.log('provider          :', provider);
console.log('主模型            :', main, '→', mainVerdict);
console.log('识图模型          :', vision, '→', visionVerdict);
console.log('');
console.log('现在的 visionEnabled          :', visionEnabledNow, visionEnabledNow ? '(可用)' : '(被关掉 ← BUG)');
const shouldBe = mainVerdict !== 'no-vision' || visionVerdict !== 'no-vision';
console.log('应该的 visionEnabled          :', shouldBe, shouldBe ? '(可用)' : '(被关掉)');
console.log('');
console.log('main doc note  :', doc[keyOf(main)]?.note?.slice(0, 90) || '（无内置条目）');
console.log('vision doc note:', doc[keyOf(vision)]?.note?.slice(0, 90) || '（无内置条目）');
