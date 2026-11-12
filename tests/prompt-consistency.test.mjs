// 系统提示的「规则自洽」契约（2026-11-11）
//
// 背景：同一份系统提示里曾经同时存在两组互斥表述，而且都活了很久：
//   ① securityRules「唯一例外是管理端明确开放的能力（当前只有壁纸工具）」
//      vs toolProtocol 举例 sticker__send_sticker / qqSceneRules 让调 get_message_images
//      —— 模型能看到十几个插件工具，安全段却说"只有壁纸"，规则在撒谎。
//   ② qqSceneRules「看图是默认动作，不是"想看才看"的可选项」
//      vs imageReactionRules「**默认不看图**，只有三种情况才看」
//      —— 一个说必看、一个说默认不看，模型只能折中，行为不稳定。
//
// 为什么这类问题比"规则缺失"更值得锁：模型对系统提示的服从度建立在一致性上。
// 一旦它发现某条规则与事实/其它规则冲突，会连带降低对**整段**的信任 ——
// 这正是 securityRules 自己注释里写的"一条与事实相反的安全规则很危险"。
//
// 2026-11-11 晚还做了一次分层重构：风格类规则（参与度 / 该不该开口 / 引用偏好 /
// 记忆习惯 / 拍一拍撤回 / 看图反应）整体下沉到 personas.js 的 baseStyleRules，
// 系统提示只留"任何人格都成立"的规则。下面有两条专门守这个分层。
//
// 这些是纯文本断言（不 import 业务模块），因为要防的正是"措辞被改回去"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../src/prompt.js', import.meta.url), 'utf8');
const PER = fs.readFileSync(new URL('../src/personas.js', import.meta.url), 'utf8');

// 只检查**字符串字面量**，不检查注释。
// 理由：修复注释里会引用旧措辞说明"原来写的是什么"，用整份源码做否定断言
// 会被自己的注释绊倒 —— 那测的是注释，不是提示词内容。
const literalsOf = (src) => src
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');
const LITERALS = literalsOf(SRC);
const PER_LITERALS = literalsOf(PER);

test('安全段不再声称"唯一例外是壁纸工具"（与插件工具现实矛盾）', () => {
  assert.doesNotMatch(LITERALS, /唯一例外是管理端明确开放的能力/);
  assert.doesNotMatch(LITERALS, /当前只有壁纸工具/);
  // 改成按能力类别描述后，必须保留"工具列表里没有就是不存在"这条硬规则
  assert.match(LITERALS, /工具列表里没有的能力，就是不存在/);
});

test('安全段列举的已开放能力覆盖到实际会发给模型的几类', () => {
  for (const cat of ['换壁纸', '表情', '画图', '联网']) {
    assert.ok(LITERALS.includes(cat), `安全段应提到「${cat}」这一类，否则又变成与事实不符`);
  }
});

test('看图口径唯一：系统提示不再替人设判断风格', () => {
  // 「看图是默认动作」与「默认不看图」互斥，两边都不许出现
  assert.doesNotMatch(LITERALS, /看图是默认动作/);
  assert.doesNotMatch(PER_LITERALS, /看图是默认动作/);
  assert.doesNotMatch(LITERALS, /不是"想看才看"的可选项/);

  // 分层后：风格判断在系统提示里应为 0 次，人设基座里恰好 1 次
  const inPrompt = (LITERALS.match(/默认不看图/g) || []).length;
  const inPersona = (PER_LITERALS.match(/默认不看图/g) || []).length;
  assert.equal(inPrompt, 0, '系统提示应只放通用规则，不该再有看图风格判断');
  assert.equal(inPersona, 1, '「默认不看图」应只在 personas.js 的风格基座里出现一次');
});

test('风格规则下沉后人设层确实带上了它们（避免迁丢）', () => {
  // 这些段曾长期住在系统提示里，搬迁时最容易漏；用段标题做存在性断言。
  // 【看到图之后】原段标题带后缀（"（最容易露馅的地方，仔细看）"），故只匹配前缀。
  for (const key of ['【说话与分寸】', '【引用与点名：只在必要时用】', '【轻量记忆】', '【拍一拍与撤回】', '【看到图之后']) {
    assert.ok(PER_LITERALS.includes(key), `人设基座缺少段落：${key}`);
  }
  // 系统提示侧不该再出现这些段的**本体**。
  // 注意不能简单查「【看到图之后】」—— 系统提示里有一句"见【行为风格】段的
  // 【看到图之后】"属于跨段指引，是允许的；故这里查带后缀的段标题。
  for (const key of ['【该说/不该说】', '【引用与点名：只在必要时用】', '【轻量记忆】', '【拍一拍与撤回】', '【看到图之后（']) {
    assert.ok(!LITERALS.includes(key), `系统提示里仍残留风格段：${key}`);
  }
});

test('系统提示里不写名字（名字是运行时事实，用户随时能改）', () => {
  // ① 不用名字断言身份：「你是「X」」
  assert.doesNotMatch(LITERALS, /你是「\$\{cfg\.botName\}」/);
  // ② 也不写「你的名字是「X」」—— botName 与 QQ 昵称 / 群名片同源，用户随时能改；
  //    写进 system（每轮原样重发）会让改完名字的模型继续自称旧名。
  assert.doesNotMatch(LITERALS, /你的名字是/);
  // ③ 但必须给替代锚点，否则模型不知道"我是谁"
  assert.match(LITERALS, /身份、称呼与说话方式以【角色设定】为准/);
  // ④ {botName} 占位符仍要保留：那是 systemPromptOverride 模板给用户自己用的
  assert.match(LITERALS, /replaceAll\('\{botName\}'/);
});

test('systemPromptOverride 分支也要带平台约束与汇报禁令', () => {
  // override 只该替换人格/风格，不能让用户丢掉"Markdown 会乱码""不许汇报式总结"
  const a = SRC.indexOf('const override = ');
  const b = SRC.indexOf('// ── 分层（2026-11-11 定稿）');
  const seg = (a >= 0 && b > a) ? SRC.slice(a, b) : '';
  assert.ok(seg.length > 0, '找不到 override 分支切片');
  assert.match(seg, /qqPlatformRules\(\)/, 'override 分支缺平台约束');
  assert.match(seg, /reportBan\(\)/, 'override 分支缺汇报禁令');
});

test('拼装时不能把数组当字符串塞进 parts（会被 join 成逗号拼接）', () => {
  // replyObligationRules() 返回**数组**。写成 `replyObligationRules(),` 作为 parts 元素时，
  // parts.join('\n') 会先对它调用 String(array) → 两条规则粘成一行、中间多个逗号：
  //   「…也算回应。,- 多人同时叫你时…」
  // 2026-11-11 重构时真的踩了：语法检查全绿、测试全过，只有把渲染结果导出来才看见。
  const bare = (LITERALS.match(/(?<!\.\.\.)replyObligationRules\(\),/g) || []).length;
  assert.equal(bare, 0, `有 ${bare} 处未展开的 replyObligationRules()，会被 join 成逗号拼接`);
  const spread = (LITERALS.match(/\.\.\.replyObligationRules\(\),/g) || []).length;
  assert.ok(spread >= 1, '至少默认分支要用 ...replyObligationRules() 展开');
});

test('发送禁令与工具协议不重复陈述"文本输出不会发送"', () => {
  const hits = LITERALS.match(/不会发送到 QQ/g) || [];
  assert.ok(hits.length <= 1, `"不会发送到 QQ" 出现了 ${hits.length} 次，应只保留一处权威表述`);
});
