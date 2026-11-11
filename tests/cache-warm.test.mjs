// 缓存预热契约测试（2026-11-11）。
//
// 起因：外部反馈包里有「保活失败：模型输出为空，可能 completion 预算被 reasoning
// 吃光」。核查后确认那条文案出自洛版补丁层，主仓库没有；但主仓库确实会在
// max_tokens=1 时拿到 finish_reason=length + 空正文 —— 这是**故意的**，保活
// 只要写缓存、不要它说话，而且只看 usage、不看正文。
//
// 真正要防的是「以后有人把保活改成走 chatCompletionWithRetry」：那个包装器有
// 「空正文 + finish_reason=length → 升 max_tokens 重试一次」的兜底，一旦套到
// 保活上，每次保活都会白打第二发、输出预算从 1 涨到 4096×4，还毫无收益。
// 所以这里锁死三件事：空正文不影响 ok、只发一次、max_tokens 恒为 1。
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-cache-warm-'));
process.env.QQ_AGENT_DATA_DIR = TMP;
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
// 让 loadPersistedPrefix() 有样本，避免 buildWarmPayload() 走自建分支（它会
// 实例化整套 prompt / skillManager，与本测试要验的无关）。
fs.writeFileSync(path.join(TMP, 'cache-warm-prefix.json'), JSON.stringify({
  system: '测试用系统提示', toolNames: [], savedAt: Date.now()
}), 'utf8');

const { setConfigProvider } = await import('../src/config.js');
const cw = await import('../src/cache-warm.js');

let cfg = {};
function useConfig(patch = {}) {
  cfg = {
    api: {
      model: 'test-model',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      provider: ''
    },
    providers: [],
    tools: {},
    cacheWarm: {
      enabled: true,
      intervalMin: 10,
      preCall: true,
      preCallGapSec: 0,
      warmDedupSec: 0,
      quietHours: []
    },
    ...patch
  };
  setConfigProvider(() => cfg);
}
after(() => { setConfigProvider(null); mock.restoreAll(); });

const SYSTEM = '测试用系统提示';
const REAL_BODY = {
  model: 'test-model',
  stream: false,
  messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: '真实调用的历史块' }
  ],
  tools: [{ type: 'function', function: { name: 'send_message', parameters: { type: 'object' } } }],
  tool_choice: 'auto'
};
const API = { baseUrl: 'https://example.invalid/v1', apiKey: 'sk-test', model: 'test-model' };

/** 拦截真实网络：返回「推理把额度吃光」的标准 OpenAI 响应。 */
function mockUpstream({ status = 200, cached = 6912 } = {}) {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    const payload = status === 200
      ? {
        choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '' } }],
        usage: {
          prompt_tokens: 7070,
          completion_tokens: 1,
          total_tokens: 7071,
          prompt_tokens_details: { cached_tokens: cached }
        },
        model: 'test-model'
      }
      : { error: { message: 'model only supports text input' } };
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
      headers: { get: () => 'application/json' }
    };
  });
  return calls;
}

function reset() {
  cw.resetWarmState();
  mock.restoreAll();
}

test('warmOnce：finish_reason=length + 空正文时仍然成功，且只发一发', async () => {
  reset();
  useConfig();
  const calls = mockUpstream();
  cw.loadPersistedPrefix();
  cw.captureRealBody({ body: REAL_BODY, api: API });

  const logs = [];
  const r = await cw.warmOnce({ force: true, log: (s) => logs.push(s) });

  assert.equal(r.ok, true, `保活不应因空正文失败：${r.reason}`);
  assert.equal(r.mode, 'shape-real-body');
  assert.equal(r.prompt, 7070);
  assert.equal(r.cached, 6912, 'usage 的 prompt_tokens_details.cached_tokens 要被归一化出来');
  assert.equal(calls.length, 1, '不能触发空正文升额重试（那会白打第二发）');
  assert.equal(calls[0].body.max_tokens, 1, '保活输出上限恒为 1');
  assert.ok(logs.some((l) => l.includes('已保活前缀')));
});

test('warmOnce：sameBody 逐字节复用真实消息，且不污染采集到的样本', async () => {
  reset();
  useConfig();
  const calls = mockUpstream();
  cw.loadPersistedPrefix();
  const snap = cw.captureRealBody({ body: REAL_BODY, api: API });

  await cw.warmOnce({ force: true });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.messages, REAL_BODY.messages, 'messages 必须原样，不增不减不替换尾部');
  assert.equal(calls[0].body.model, REAL_BODY.model);
  assert.equal(calls[0].body.max_tokens, 1);
  // 老 bug：sameBody 直传引用时 max_tokens=1 会被写回 lastRealBody，
  // 之后所有真实调用都只剩 1 个 token 的输出上限。
  assert.equal(snap.body.max_tokens, undefined, '采集快照不能被保活改写');
  assert.equal(REAL_BODY.max_tokens, undefined, '调用方持有的原对象也不能被改写');
});

test('warmBeforeRealCall：同样不因空正文重试，返回 ok:true', async () => {
  reset();
  useConfig();
  const calls = mockUpstream();
  cw.loadPersistedPrefix();
  const sample = cw.captureRealBody({ body: REAL_BODY, api: API });

  const r = await cw.warmBeforeRealCall({ sample });

  assert.equal(r.ok, true, `调用前预热不应因空正文失败：${r.reason}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.max_tokens, 1);
  assert.equal(r.cached, 6912);
});

test('warmOnce：上游 4xx 时返回 ok:false 且不抛出（保活绝不影响主流程）', async () => {
  reset();
  useConfig();
  mockUpstream({ status: 400 });
  cw.loadPersistedPrefix();
  cw.captureRealBody({ body: REAL_BODY, api: API });

  const r = await cw.warmOnce({ force: true });

  assert.equal(r.ok, false);
  assert.match(String(r.reason), /HTTP 400/);
});

test('warmOnce：未启用 / 静默时段直接跳过，一发都不发', async () => {
  reset();
  useConfig({ cacheWarm: { enabled: false, quietHours: [] } });
  const calls = mockUpstream();
  cw.loadPersistedPrefix();
  cw.captureRealBody({ body: REAL_BODY, api: API });
  const off = await cw.warmOnce({ force: true });
  assert.equal(off.ok, false);
  assert.match(off.reason, /未启用/);

  useConfig({ cacheWarm: { enabled: true, quietHours: [new Date().getHours()] } });
  const quiet = await cw.warmOnce({ force: true });
  assert.equal(quiet.ok, false);
  assert.match(quiet.reason, /静默时段/);
  assert.equal(calls.length, 0, '跳过时不能产生任何请求');
});
