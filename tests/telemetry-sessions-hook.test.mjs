// 集成回归：新装用户跑完第一次会话就应出现在遥测里，不必等 6 小时定时器。
//
// 这是「下载多、遥测少」的核心链路：telemetry-totals.json 由 #bumpTodayUsage
// 在会话结束时首次写出；写出成功后必须立刻触发一次 report()。
// 用真实 SessionRegistry 走完 create → finish，而不是只测 telemetry.js 的导出。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-tel-hook-'));
process.env.QQ_AGENT_DATA_DIR = TMP;
fs.mkdirSync(TMP, { recursive: true });

const REAL_FETCH = globalThis.fetch;
const requests = [];
globalThis.fetch = async (url, opts) => {
  requests.push({ url, body: JSON.parse(opts.body) });
  return { ok: true, status: 200 };
};

const { SessionRegistry } = await import('../src/sessions.js');
const PKG_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

after(() => {
  globalThis.fetch = REAL_FETCH;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
});

async function waitFor(fn, ms = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

function finishOneSession(reg) {
  const s = reg.create({ chatKey: 'test-chat', trigger: 'message', triggerSummary: 'hello' });
  s.usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 0, calls: 1 };
  s.messages = [{ raw: { usage: { prompt_tokens: 100, completion_tokens: 20 } } }];
  reg.finish(s.id, 'done');
  reg.flushIndexCache();
}

test('首次写出 totals 后立刻上报一次，payload 版本与累计调用数正确', async () => {
  const reg = new SessionRegistry(0);
  finishOneSession(reg);

  const totals = path.join(TMP, 'telemetry-totals.json');
  assert.ok(fs.existsSync(totals), '会话结束应创建 telemetry-totals.json');
  await waitFor(() => requests.length > 0);
  assert.equal(requests.length, 1, '应立刻发一次，而不是等 6 小时');
  assert.equal(requests[0].body.calls, 1);
  assert.equal(requests[0].body.version, PKG_VERSION);
  assert.equal(typeof requests[0].body.installId, 'string');
  const last = JSON.parse(fs.readFileSync(path.join(TMP, 'telemetry-last.json'), 'utf8'));
  assert.equal(last.ok, true);
});

test('后续会话不再重复上报（totals 已存在 + 进程内去重）', async () => {
  const reg = new SessionRegistry(0);
  finishOneSession(reg);
  await waitFor(() => requests.length > 0, 300);
  assert.equal(requests.length, 1, '第二个会话不应再打网络');
});
