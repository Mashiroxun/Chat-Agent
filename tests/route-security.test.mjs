// 路由层 / 信息泄露剩余项的回归网（2026-11-16 审计修）。
// 覆盖：sessions 默认 limit、trustedPlugins 信任闸旁路、fix target containment、
// bundle inspect 路径拒绝、llm 错误脱敏、LAN 服务商默认拒绝、forge 目标锁互斥。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'route-sec-'));
process.env.QQ_AGENT_DATA_DIR = TMP;   // 必须在动态 import 之前设定

const {
  DEFAULT_CONFIG, updateConfig, getConfig, withTrustedPluginGrant
} = await import('../src/config.js');
const { forgeTargetLockKey, acquireForgeDraftLock, __resetForgeDraftLocks } = await import('../src/forge-draft-lock.js');
const { checkFixTargetContainment } = await import('../src/routes/fix.js');
const { inspectBundle } = await import('../src/bundle.js');
const { sessionsRoutes } = await import('../src/routes/sessions.js');
const { validateProviderBaseUrl } = await import('../src/providers.js');
const { listModels } = await import('../src/llm.js');

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

test('sessions 默认 limit 收敛到 200，传更大值仍被封顶', async () => {
  let seen = null;
  const routes = sessionsRoutes({
    sessions: { listSummaries: (n) => { seen = n; return []; }, listKnownChats: () => [] }
  }, {});
  const route = routes.find((r) => r.pattern === '/api/sessions');
  assert.ok(route, '缺少 /api/sessions 路由');
  const call = (qs = '') => route.handler({
    res: {}, json: (_res, _code, body) => body, url: new URL(`http://localhost/api/sessions${qs}`)
  });
  assert.deepEqual(await call(), { sessions: [], knownChats: [] });
  assert.equal(seen, 200, '默认必须是 200');
  await call('?limit=999999');
  assert.equal(seen, 200, '超限仍应封顶 200');
});

test('trustedPlugins：非数组 / 非法 id / 无一次性授予的新增都被吞掉', () => {
  updateConfig({ trustedPlugins: [] });
  const cur = () => getConfig().trustedPlugins;
  assert.deepEqual(cur(), []);

  updateConfig({ trustedPlugins: { evil: true } });       // 非数组
  assert.deepEqual(cur(), []);
  updateConfig({ trustedPlugins: ['../evil'] });          // 路径穿越
  assert.deepEqual(cur(), []);
  updateConfig({ trustedPlugins: [123] });                // 元素类型非法
  assert.deepEqual(cur(), []);
  updateConfig({ trustedPlugins: ['looks-legit'] });      // 格式合法但无授予
  assert.deepEqual(cur(), []);

  // 只有 trust 路由那种带一次性授予的写入才生效
  withTrustedPluginGrant('looks-legit', () => updateConfig({ trustedPlugins: ['looks-legit'] }));
  assert.deepEqual(cur(), ['looks-legit']);
  // 普通设置保存不能动白名单（脱敏整包回传场景）
  updateConfig({ store: { maxMessagesPerChat: 42 } });
  assert.deepEqual(cur(), ['looks-legit']);
});

test('forge 目标锁：rollback 与 upgrade-install 按 <kind>:<dir> 互斥', () => {
  __resetForgeDraftLocks();
  assert.equal(forgeTargetLockKey('plugin', 'my-plugin'), 'plugin:my-plugin');
  assert.equal(forgeTargetLockKey('plugin', '../evil'), '', '非法目录名不应产生锁键');
  const key = forgeTargetLockKey('plugin', 'my-plugin');
  const a = acquireForgeDraftLock(key, '升级安装(目标)');
  assert.ok(a.release, '第一次应拿到锁');
  const b = acquireForgeDraftLock(key, '回滚');
  assert.ok(b.busy, '同一目标上第二次必须被拒绝');
  a.release();
  const c = acquireForgeDraftLock(key, '回滚');
  assert.ok(c.release, '释放后应可再取');
  c.release();
  __resetForgeDraftLocks();
});

test('fix target containment：拒绝 ../、绝对路径与符号链接逃逸', () => {
  assert.equal(checkFixTargetContainment(null).ok, true);
  assert.equal(checkFixTargetContainment({ file: 'src/app.js' }).ok, true);
  assert.equal(checkFixTargetContainment({ file: '../secret.txt' }).ok, false);
  assert.equal(checkFixTargetContainment({ file: 'a/../../b.js' }).ok, false);
  assert.equal(checkFixTargetContainment({ file: '/etc/passwd' }).ok, false);
  assert.equal(checkFixTargetContainment({ file: 'C:/Windows/win.ini' }).ok, false);
  assert.equal(checkFixTargetContainment({ file: 123 }).ok, false);

  // data 作用域：_tmp 内指向外部文件的软链必须被 realpath 拦下
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-out-'));
  try {
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'x');
    const link = path.join(TMP, 'escape-link');
    try {
      fs.symlinkSync(secret, link, 'file');
      // 某些 Windows 环境（无开发者模式）symlinkSync 不报错但也没真的建出链接
      if (fs.existsSync(link)) {
        assert.equal(checkFixTargetContainment({ scope: 'data', file: 'escape-link' }).ok, false);
      }
    } catch (e) {
      // 无权限建软链时跳过该子用例，其余路径断言仍然有效
      if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
    }
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('bundle inspect：目录外路径一律拒绝，错误不回显绝对路径', () => {
  const outside = path.join(os.tmpdir(), 'outside-bundle.zip');
  fs.writeFileSync(outside, 'not a zip');
  try {
    for (const p of [outside, '/etc/passwd', path.join(TMP, 'missing.zip'), '..' + path.sep + 'secret.zip']) {
      const r = inspectBundle({ filePath: p });
      assert.equal(r.ok, false, `应拒绝：${p}`);
      assert.ok(!String(r.error).includes(p), `错误不应回显路径：${r.error}`);
      assert.ok(!/([A-Za-z]:\\|\/etc\/)/.test(r.error), `错误不应含绝对路径：${r.error}`);
    }
    // 允许目录内的文件能走到包解析阶段（而不是被路径闸拒绝）
    const exportsDir = path.join(TMP, 'exports');
    fs.mkdirSync(exportsDir, { recursive: true });
    const inside = path.join(exportsDir, 'sample.zip');
    fs.writeFileSync(inside, 'not a real zip');
    const r = inspectBundle({ filePath: inside });
    assert.equal(r.ok, false);
    assert.ok(!r.error.includes('不在允许的目录内'), '合法目录内的文件应通过路径闸');
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('llm 错误脱敏：不回显内部地址与响应片段，保留状态码/错误类型', async () => {
  updateConfig({ api: { baseUrl: 'https://internal-secret.invalid/v1', apiKey: 'k', model: 'm' } });
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('SERVER_SECRET_MARKER', { status: 400, statusText: 'Bad Request' });
    await assert.rejects(() => listModels(), (e) => {
      const msg = String(e?.message ?? e);
      return msg.includes('400') && !msg.includes('internal-secret.invalid') && !msg.includes('SERVER_SECRET_MARKER');
    });
    globalThis.fetch = async () => new Response('INTERNAL_BODY_SECRET', { status: 200 });
    await assert.rejects(() => listModels(), (e) => {
      const msg = String(e?.message ?? e);
      return msg.includes('JSON') && !msg.includes('INTERNAL_BODY_SECRET') && !msg.includes('internal-secret.invalid');
    });
  } finally {
    globalThis.fetch = orig;
  }
});

test('LAN 服务商端点默认拒绝，显式开启后才放行', async () => {
  assert.equal(DEFAULT_CONFIG.server.allowLanProviders, false, '默认必须收紧');
  await assert.rejects(() => validateProviderBaseUrl('http://192.168.1.50:11434/v1'));
  updateConfig({ server: { allowLanProviders: true } });
  try { await validateProviderBaseUrl('http://192.168.1.50:11434/v1'); }
  finally { updateConfig({ server: { allowLanProviders: false } }); }
});
