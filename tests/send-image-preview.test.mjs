/**
 * 发网图预览 ≠ 已发送（2026-10-27 修，R-SendImage-Preview）
 *
 * 现场：群里让机器人"发张波奇酱的图"，过程面板显示
 *   工具 发网图 url=… preview=true → 这张图（image/jpeg，约 490KB）…
 *   工具 发网图 · 1 张图片已作为图像输入注入模型
 *   已发送到 QQ · [消息 · send_image]
 *   finish：已发言，自动收尾（省一轮）
 * 而 QQ 群里一张图都没有。
 *
 * 根因是两处各自"看起来合理"的条件叠在一起：
 *   ① src/tools.js 的预览分支正常返回（没报错），但没有声明"这次没发出去"；
 *   ② src/orchestrator.js 的补记逻辑只看「发送类工具 + 没报错 + session.sent 没增长」，
 *      预览三条全中 → 补记一条 `[消息 · send_image]` → 本批 delivered=true →
 *      触发"发言即收尾"，模型再没机会调第二次 send_image(url)。
 *
 * 这三条契约任何一条被改回去，图就又会"发不出去但显示已发送"，而且**没有任何报错**，
 * 所以用静态断言钉住（都是几行的条件，风险低但要防手滑）。
 *
 * 运行：node --test tests/send-image-preview.test.mjs   （在 resources/app 目录下）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const read = (p) => readFileSync(join(APP, p), 'utf8');

const TOOLS = read('src/tools.js');
const ORCH = read('src/orchestrator.js');

/** 截出 send_image 的 `if (isPreview) { … }` 分支正文（到真发路径的注释为止）。 */
function previewBranch() {
  const start = TOOLS.indexOf('if (isPreview) {');
  assert.ok(start > 0, 'send_image 里找不到 isPreview 分支');
  const end = TOOLS.indexOf('// 传 url 而不是只传 base64', start);
  assert.ok(end > start, '找不到预览分支的结束标记（真发路径注释被改名了？）');
  return TOOLS.slice(start, end);
}

test('预览分支的两条返回路径都声明 delivered:false', () => {
  const body = previewBranch();
  // 只数代码行：上面那段解释性注释里也写着 delivered:false，不能算进来
  const code = body.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const hits = code.match(/delivered:\s*false/g) || [];
  assert.equal(hits.length, 2,
    `预览分支应有 2 处 delivered:false（视觉不支持 / 视觉支持各一条），实际 ${hits.length} 处`);
  // 回归防线：不能再出现"裸 ok(...)"的预览返回 —— 那正是补记误判的入口
  assert.ok(!/return ok\(/.test(code), '预览分支不能再直接 return ok(...)，必须带 delivered:false');
});

test('预览返回的文案明确告诉模型"还没有发出去"', () => {
  const body = previewBranch();
  assert.match(body, /还没有发出去/, '预览结果必须说明图未发送，否则模型会把预览当已发');
  assert.match(body, /不要带 preview/, '必须提示下一次调用不带 preview 才是真发');
});

test('编排器补记"已发送"时必须排除 delivered:false', () => {
  const idx = ORCH.indexOf('result.delivered !== false');
  assert.ok(idx > 0, 'orchestrator 补记条件缺少 result.delivered !== false（预览会被当成已发言）');
  // 该条件必须在补记块内、且在 isDeliverTool 判定之前
  const block = ORCH.slice(idx - 600, idx + 400);
  assert.match(block, /isDeliverTool\(name, autoEndExtra\)/, 'delivered 条件与补记块不在同一处');
  assert.match(block, /session\.sent\.push/, 'delivered 条件应紧邻补记 session.sent 的代码');
});

test('自动收尾仍然只认 session.sent 真实增长', () => {
  // 预览不再补记后，delivered 自然为 false；这条守住"别为了修 bug 改成只看工具名"
  const idx = ORCH.indexOf('const delivered = session.sent.length > sentBeforeBatch;');
  assert.ok(idx > 0, '自动收尾的 delivered 判定被改动了，请确认仍然以 session.sent 为准');
});
