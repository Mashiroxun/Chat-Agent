// 安全护栏的回归网（0.4.9.3）
//
// 这两个模块的共同特征是「出错不报错，只是悄悄放行」：
//   · isPrivateIp 判错 → SSRF 防护形同虚设
//   · normalizeToolOutput 漏了 → 一条超长返回能把上下文撑爆
//   · 熔断失效 → 一个坏扩展可以无限拖垮整轮对话
// 所以这里基本全是否向用例：每条防护规则配一个"必须被拦住"的输入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-guard-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { isPrivateIp, isLoopbackIp, validateFetchUrl, normalizeDomain } = await import('../src/safe-fetch.js');
const {
  normalizeToolOutput, guardToolExecute, breakerStateOf, resetBreakers, TOOL_GUARD
} = await import('../src/tool-guard.js');

// ── isPrivateIp：SSRF 的第一道闸 ─────────────────────────────

test('内网 IPv4 全部判为私有', () => {
  const priv = [
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.254', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '100.127.255.255', '0.0.0.0', '198.18.0.1',
    '224.0.0.1', '239.255.255.255', '255.255.255.255'
  ];
  for (const ip of priv) assert.equal(isPrivateIp(ip), true, `${ip} 应判为内网`);
});

test('公网地址不能误判', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '223.5.5.5', '172.32.0.1', '100.63.255.255']) {
    assert.equal(isPrivateIp(ip), false, `${ip} 是公网，不该被拦`);
  }
});

test('IPv6 内网段全部判为私有', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12::3', 'fe80::1', 'fec0::1', '2001:db8::1', 'ff02::1']) {
    assert.equal(isPrivateIp(ip), true, `${ip} 应判为内网`);
  }
  assert.equal(isPrivateIp('2606:4700:4700::1111'), false, '公网 IPv6 不该被拦');
});

test('IPv4-mapped 与 6to4 内嵌的内网地址也要拦住', () => {
  // ::ffff:127.0.0.1 是经典的绕过写法，只看前缀会漏
  assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateIp('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateIp('2002:7f00:0001::'), true);   // 6to4 内嵌 127.0.0.1
});

test('空值与非法输入默认拒绝（fail-closed）', () => {
  assert.equal(isPrivateIp(''), true, '空串必须当作不安全');
  assert.equal(isPrivateIp(null), true);
  assert.equal(isPrivateIp(undefined), true);
});

// ── validateFetchUrl：协议与主机双重校验 ─────────────────────

test('内网目标与非 http(s) 协议必须被拒', async () => {
  const bad = [
    'http://127.0.0.1/',
    'http://localhost:3000/x',
    'http://10.0.0.1/a',
    'http://192.168.1.1/',
    'file:///etc/passwd',
    'ftp://example.com/x',
    'gopher://example.com/'
  ];
  for (const u of bad) {
    await assert.rejects(() => validateFetchUrl(u), undefined, `应拒绝：${u}`);
  }
});

// ── allowLoopback：只为本机服务开一道窄门（2026-11-11 反馈核查） ──
// 背景：插件调本机 Ollama(11434) / OneBot(3000) 被 SSRF 闸拦住，
// 旧办法只能开 allowPrivateImageHosts —— 那个开关会把整张 LAN 和
// 169.254.169.254 一起放开，代价太大。这道窄门只认环回。

test('isLoopbackIp 只认环回，不认 LAN / 链路本地 / 元数据', () => {
  for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackIp(ip), true, `${ip} 应判为环回`);
  }
  for (const ip of ['10.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '::', 'fe80::1', 'fc00::1', '8.8.8.8',
    // 6to4 里内嵌 127.x 是异常形态：isPrivateIp 已判内网，这里刻意
    // **不**当环回，allowLoopback 也就不会把它放行，方向更安全。
    '2002:7f00:0001::', '', null]) {
    assert.equal(isLoopbackIp(ip), false, `${ip} 不是环回`);
  }
});

test('默认仍拦环回（新开关不改变旧行为）', async () => {
  await assert.rejects(() => validateFetchUrl('http://127.0.0.1:11434/api/tags'));
  await assert.rejects(() => validateFetchUrl('http://[::1]:3210/api/status'));
});

test('allowLoopback=true 放行本机服务', async () => {
  for (const u of [
    'http://127.0.0.1:11434/api/tags',
    'http://127.1.2.3:3000/',
    'http://[::1]:3210/api/status',
    'http://[::ffff:127.0.0.1]:8080/'
  ]) {
    const r = await validateFetchUrl(u, { allowLoopback: true });
    assert.ok(r?.url, `应放行：${u}`);
  }
});

test('allowLoopback=true 时 LAN / 元数据 / .local 仍必须被拒', async () => {
  const bad = [
    'http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.31.255.254/',
    'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/',
    'http://0.0.0.0/', 'http://[fd12::3]/', 'http://[fe80::1]/',
    'http://foo.local/', 'http://a.localhost/'
  ];
  for (const u of bad) {
    await assert.rejects(() => validateFetchUrl(u, { allowLoopback: true }), undefined, `不该放行：${u}`);
  }
});

test('allowPrivate=true 的全放行语义没被新开关改坏', async () => {
  const r = await validateFetchUrl('http://192.168.1.1/', { allowPrivate: true });
  assert.ok(r?.url);
});

test('normalizeDomain 去掉协议与路径', () => {
  assert.equal(normalizeDomain('https://a.b.com/x/y?z=1'), 'a.b.com');
  assert.equal(normalizeDomain('a.b.com'), 'a.b.com');
});

// ── normalizeToolOutput：防止一条返回撑爆上下文 ──────────────

test('返回 undefined / null 视为失败的扩展实现', () => {
  for (const v of [undefined, null]) {
    const r = normalizeToolOutput(v);
    assert.equal(r.isError, true);
    assert.match(String(r.content), /没有返回内容/);
  }
});

test('超长文本被截断，并在末尾说明原因', () => {
  const long = 'x'.repeat(TOOL_GUARD.maxContentChars + 5000);
  const r = normalizeToolOutput({ content: long });
  // 截断是"保留前 limit 字符 + 附加一句说明"，所以总长会略超上限，
  // 断言要按真实行为写，否则测的是自己的想象。
  assert.ok(r.content.length <= TOOL_GUARD.maxContentChars + 120, `实际 ${r.content.length}`);
  assert.match(r.content, /已截断/);
  assert.ok(r.content.startsWith('xxx'), '应保留前部内容');
});

test('parts 总量超限时追加护栏提示', () => {
  const parts = Array.from({ length: 4 }, () => ({ type: 'text', text: 'y'.repeat(TOOL_GUARD.maxContentChars) }));
  const r = normalizeToolOutput({ content: parts });
  const last = r.content[r.content.length - 1];
  assert.equal(typeof last.text, 'string');
  assert.match(last.text, /护栏/);
});

test('正常返回原样透传，不篡改字段', () => {
  const r = normalizeToolOutput({ content: 'ok', delivered: false, extra: 1 });
  assert.equal(r.content, 'ok');
  assert.equal(r.delivered, false);
  assert.equal(r.extra, 1);
});

// ── guardToolExecute：超时与熔断 ────────────────────────────

test('执行超时被护栏中止，并计入失败', async () => {
  resetBreakers();
  const oldTimeout = TOOL_GUARD.timeoutMs;
  TOOL_GUARD.timeoutMs = 30;
  try {
    const wrapped = guardToolExecute(() => new Promise(() => {}), 'slow-ext', 'slow_tool');
    const r = await wrapped({}, {});
    assert.equal(r.isError, true);
    assert.match(String(r.content), /超时/);
  } finally {
    TOOL_GUARD.timeoutMs = oldTimeout;
  }
});

test('连续失败达到阈值后熔断，且不再调用原函数', async () => {
  resetBreakers();
  let calls = 0;
  const boom = guardToolExecute(() => { calls += 1; throw new Error('炸了'); }, 'bad-ext', 'bad_tool');

  for (let i = 0; i < TOOL_GUARD.failThreshold; i++) {
    const r = await boom({}, {});
    assert.equal(r.isError, true);
  }
  const before = calls;
  assert.equal(breakerStateOf('bad-ext').open, true, '应已熔断');

  const after = await boom({}, {});
  assert.equal(calls, before, '熔断期间不该再调用原函数');
  assert.match(String(after.content), /熔断/);
});

test('一次成功会清零失败计数', async () => {
  resetBreakers();
  let n = 0;
  const flaky = guardToolExecute(() => {
    n += 1;
    if (n < 3) throw new Error('暂时失败');
    return { content: '好了' };
  }, 'flaky-ext', 'flaky_tool');

  assert.equal((await flaky({}, {})).isError, true);
  assert.equal((await flaky({}, {})).isError, true);
  const ok = await flaky({}, {});
  assert.equal(ok.isError, undefined);
  assert.equal(breakerStateOf('flaky-ext').fails, 0, '成功后计数必须归零');
});
