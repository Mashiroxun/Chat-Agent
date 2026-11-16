// 2026-11-15：思考档分流改为「默认关闭、显式开启才生效」的回归防线。
//
// 要钉死三件事：
//   ① DEFAULT_CONFIG 里默认是 false（deepMerge 会让没存过该字段的用户也拿到 false）；
//   ② 纯函数默认不启用，显式 enabled:true 才判档；
//   ③ 存量配置里由旧版默认勾选带出来的 true 只被归零一次，之后用户手动
//      勾选写入的 true 不会被迁移清掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { DEFAULT_CONFIG } = await import('../src/config.js');
const { routeThinking, ROUTE_TIERS } = await import('../src/thinking-route.js');
const { UPGRADES, runUpgrades } = await import('../src/upgrade.js');

const UPGRADE_ID = 'thinking-route-opt-in';
const complexEntry = { text: '帮我查一下这周哪个模型最便宜', isPoke: false, atSelf: false, media: [], reply: null };

test('DEFAULT_CONFIG.api.thinkingRoute 默认关闭', () => {
  assert.equal(DEFAULT_CONFIG.api.thinkingRoute, false);
});

test('纯函数默认不启用；显式 enabled:true 才分流', () => {
  const off = routeThinking({ triggerEntries: [complexEntry] });
  assert.equal(off.tier, ROUTE_TIERS.PASSTHROUGH);
  assert.equal(off.routed, false);
  assert.match(off.reason, /分流开关关闭/);

  const on = routeThinking({ triggerEntries: [complexEntry], enabled: true });
  assert.equal(on.tier, ROUTE_TIERS.FULL);
  assert.equal(on.routed, true);
});

/** 内存版 saveConfig：只合并 api 子对象，避免碰真实 config.json。 */
function memoryConfig(initial) {
  let cfg = structuredClone(initial);
  return {
    get: () => cfg,
    saveConfig: (mutator) => {
      const patch = mutator(cfg) || {};
      if (patch.api) cfg.api = { ...(cfg.api || {}), ...patch.api };
      return cfg;
    }
  };
}

test('迁移项只把历史 true 归零，false / 缺字段一律不动', () => {
  const up = UPGRADES.find((u) => u.id === UPGRADE_ID);
  assert.ok(up, '迁移项必须注册');
  assert.equal(UPGRADES.filter((u) => u.id === UPGRADE_ID).length, 1, '幂等账本的 id 必须唯一');

  const cases = [
    { initial: { api: { thinkingRoute: true } }, expected: false, changed: 1 },
    { initial: { api: { thinkingRoute: false } }, expected: false, changed: 0 },
    { initial: { api: {} }, expected: undefined, changed: 0 }
  ];
  for (const c of cases) {
    const m = memoryConfig(c.initial);
    const r = up.run({ log: () => {}, saveConfig: m.saveConfig });
    assert.equal(m.get().api.thinkingRoute, c.expected);
    assert.equal(r.changed.length, c.changed);
  }
});

test('迁移一次性：执行过后用户手动写入的 true 不再被清', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-upgrade-route-'));
  try {
    const m = memoryConfig({ api: { thinkingRoute: true } });
    const opts = { dataDir: dir, log: () => {}, saveConfig: m.saveConfig };

    const first = runUpgrades(opts);
    assert.ok(first.ran.some((x) => x.id === UPGRADE_ID), '首次启动应执行迁移');
    assert.equal(m.get().api.thinkingRoute, false, '历史默认勾选带出来的 true 应归零');

    // 模拟用户在设置页手动勾选并保存
    m.get().api.thinkingRoute = true;

    const second = runUpgrades(opts);
    assert.ok(second.skipped.includes(UPGRADE_ID), '第二次启动应跳过已执行的迁移');
    assert.equal(m.get().api.thinkingRoute, true, '用户手动开启必须保留');
    assert.ok(fs.existsSync(path.join(dir, 'upgrade-state.json')), '幂等账本应落盘');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
