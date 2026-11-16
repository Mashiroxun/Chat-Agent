// 遥测上报状态与「首次用量就绪即上报」（2026-11-15，拟并入 0.4.9.5）。
//
// 回归背景：原先只有「启动 90 秒」+「每 6 小时」两次机会，成功时又不写日志，
// 所以「日志里没有失败记录」根本不能证明链路正常，也没法区分「还没用」和「发不出去」。
// 本测试固定住：payload 结构不变、零调用仍不请求、结果落盘、失败后首发提前。
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-telemetry-'));
process.env.QQ_AGENT_DATA_DIR = TMP;
fs.mkdirSync(TMP, { recursive: true });

const { report, reportOnFirstUsage, lastReportState, firstReportDelayMs } = await import('../src/telemetry.js');

const TOTALS = path.join(TMP, 'telemetry-totals.json');
const LAST = path.join(TMP, 'telemetry-last.json');
const REAL_FETCH = globalThis.fetch;
const PKG_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function withTotals(calls) {
  fs.writeFileSync(TOTALS, JSON.stringify({
    calls, promptTokens: 1000, completionTokens: 200, totalTokens: 1200,
    toolCounts: { send_message: 3 }
  }), 'utf8');
}

beforeEach(() => {
  withTotals(12);
  try { fs.rmSync(LAST, { force: true }); } catch { /* 不存在 */ }
  globalThis.fetch = async () => ({ ok: true, status: 200 });
});

after(() => {
  globalThis.fetch = REAL_FETCH;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
});

test('上报成功：payload 结构不变，状态记为 ok:true', async () => {
  let hit = null;
  globalThis.fetch = async (url, opts) => { hit = { url, opts }; return { ok: true, status: 200 }; };
  await report();
  assert.ok(hit, '应发起一次 POST');
  assert.equal(hit.opts.method, 'POST');
  assert.ok(hit.opts.signal, '应带超时信号');
  const body = JSON.parse(hit.opts.body);
  assert.equal(body.calls, 12);
  assert.equal(body.inputTokens, 1000);
  assert.equal(body.outputTokens, 200);
  assert.equal(body.totalTokens, 1200);
  assert.equal(body.tools.send_message, 3);
  assert.equal(typeof body.installId, 'string');
  assert.equal(body.version, PKG_VERSION);
  assert.equal(lastReportState().ok, true);
});

test('零调用：不发请求，状态记为 no-usage（口径不放宽）', async () => {
  withTotals(0);
  let n = 0;
  globalThis.fetch = async () => { n += 1; return { ok: true, status: 200 }; };
  await report();
  assert.equal(n, 0);
  assert.equal(lastReportState().ok, null);
  assert.equal(lastReportState().reason, 'no-usage');
});

test('HTTP 非 2xx：状态记为 ok:false / http，并触发首发提前', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await report();
  const s = lastReportState();
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'http');
  assert.equal(s.httpStatus, 503);
  assert.equal(firstReportDelayMs(), 15000);
});

test('网络异常：状态记为 ok:false / network，错误摘要被截断且不带本地路径', async () => {
  globalThis.fetch = async () => { throw new Error('fetch failed'); };
  await report();
  const s = lastReportState();
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'network');
  assert.equal(s.error, 'fetch failed');
  assert.ok(!s.error.includes(TMP));
});

test('首发延迟：上次失败 15 秒，上次成功或状态缺失 90 秒', () => {
  fs.writeFileSync(LAST, JSON.stringify({ at: new Date().toISOString(), ok: false, reason: 'network' }), 'utf8');
  assert.equal(firstReportDelayMs(), 15000);
  fs.writeFileSync(LAST, JSON.stringify({ at: new Date().toISOString(), ok: true }), 'utf8');
  assert.equal(firstReportDelayMs(), 90000);
  fs.rmSync(LAST, { force: true });
  assert.equal(firstReportDelayMs(), 90000);
});

test('reportOnFirstUsage：进程内只触发一次，避免每个会话都打网络', async () => {
  let n = 0;
  globalThis.fetch = async () => { n += 1; return { ok: true, status: 200 }; };
  assert.equal(await reportOnFirstUsage(), true);
  assert.equal(await reportOnFirstUsage(), false);
  assert.equal(n, 1);
});
