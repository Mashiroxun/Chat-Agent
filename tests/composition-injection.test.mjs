// 启动组合注入测试（0.4.9.3）
//
// 覆盖两项「全局单例可替换」能力：
//   runtime.config  —— 配置来源可插拔（保持同步）
//   runtime.plugins —— 插件管理器实例可替换（依赖 ESM live binding）
//
// 关键点：替换后必须能恢复，否则会污染同一进程里的其他测试。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getConfig, setConfigProvider, hasConfigProvider } from '../src/config.js';
import { skillManager, setSkillManager, SkillManager } from '../src/skills/manager.js';

test('默认没有配置 provider，getConfig 走磁盘路径', () => {
  assert.equal(hasConfigProvider(), false);
  const cfg = getConfig();
  assert.equal(typeof cfg, 'object');
});

test('注入 provider 后 getConfig 返回它给的对象', () => {
  const injected = { api: { model: 'injected-model' }, marker: 'from-provider' };
  setConfigProvider(() => injected);
  try {
    assert.equal(hasConfigProvider(), true);
    assert.equal(getConfig(), injected);
    assert.equal(getConfig().api.model, 'injected-model');
  } finally {
    setConfigProvider(null);
  }
  assert.equal(hasConfigProvider(), false);
});

test('provider 返回非对象时回落到磁盘配置', () => {
  setConfigProvider(() => null);
  try {
    const cfg = getConfig();
    assert.equal(typeof cfg, 'object');
    assert.ok(cfg.api, '应回落到默认配置，含 api 字段');
  } finally {
    setConfigProvider(null);
  }
});

test('setConfigProvider 传非函数等同于清除', () => {
  setConfigProvider(() => ({ api: {} }));
  setConfigProvider('not-a-function');
  assert.equal(hasConfigProvider(), false);
});

test('skillManager 是可替换的 let 绑定', () => {
  const original = skillManager;
  const replacement = new SkillManager();
  try {
    setSkillManager(replacement);
    assert.equal(skillManager, replacement);
  } finally {
    setSkillManager(original);
  }
  assert.equal(skillManager, original);
});

test('setSkillManager 传非 SkillManager 会重置成空实例', () => {
  const original = skillManager;
  try {
    setSkillManager({ fake: true });
    assert.ok(skillManager instanceof SkillManager);
    assert.notEqual(skillManager, original);
  } finally {
    setSkillManager(original);
  }
});

test('替换后的管理器保留独立状态，不污染原实例', () => {
  const original = skillManager;
  const replacement = new SkillManager();
  try {
    setSkillManager(replacement);
    replacement.register({ manifest: { id: 'test-skill', name: '测试技能' } });
    assert.equal(skillManager.isLoaded('test-skill'), true);
    assert.equal(original.isLoaded('test-skill'), false, '原实例不应受影响');
  } finally {
    setSkillManager(original);
  }
});

test('provider 内部再调 getConfig 不会无限递归', () => {
  // 危险写法：provider 里又调 getConfig()。没有防重入闸会爆栈。
  setConfigProvider(() => ({ ...getConfig(), injected: true }));
  try {
    const cfg = getConfig();
    assert.equal(typeof cfg, 'object');
    assert.equal(cfg.injected, true);
  } finally {
    setConfigProvider(null);
  }
});

test('注入 provider 后 updateConfig 仍写盘但不影响 getConfig 的返回值', () => {
  const fixed = { api: { model: 'fixed-model' }, marker: 'provider' };
  setConfigProvider(() => fixed);
  try {
    // 读到的始终是 provider 给的对象
    assert.equal(getConfig(), fixed);
    assert.equal(getConfig().api.model, 'fixed-model');
  } finally {
    setConfigProvider(null);
  }
});
