// 启动组合工厂表（0.4.9.2 引入）
//
// 目的：把 src/app.js 里原本 8 处 `new Xxx()` 的硬编码装配改成查表，
// 让这些组件可以被启动组合（overrides 层 / 显式传入）替换，而不必改源码。
//
// 设计约束：
//   1. 键名对齐 0.5 的组件表（data.messages / core.send / core.orchestrator / transport …），
//      便于两边的覆盖层互相搬。
//   2. 默认值全部指向洛版原实现，不传 components 时行为与 0.4.9.1 完全一致。
//   3. 工厂签名统一为 (deps) => instance，deps 至少包含 { cfg, log }。
//   4. 不在这里做任何副作用（不写盘、不起定时器），只负责构造。

import { ChatStore } from '../store.js';
import { MemoryStore } from '../memory.js';
import { SessionRegistry } from '../sessions.js';
import { OneBotClient } from '../onebot.js';
import { SendQueue } from '../sender.js';
import { ReminderStore } from '../reminders.js';
import { VideoReader } from '../video-reader.js';
import { Orchestrator } from '../orchestrator.js';

/** 默认组件表：与 0.5 的 bundled/runtime-defaults/components.js 键名保持一致。 */
export const defaultFactories = {
  // ── 数据仓 ────────────────────────────────────────────────
  'data.messages': ({ cfg }) => new ChatStore(cfg.store?.maxMessagesPerChat ?? 0), // 0 = 不限
  'data.memory': () => new MemoryStore(),
  'data.sessions': ({ cfg }) => new SessionRegistry(cfg.store?.keepSessionFiles ?? 0), // 0 = 不限
  'data.reminders': () => new ReminderStore(),

  // ── 传输与发送 ─────────────────────────────────────────────
  'transport': ({ cfg, onEvent }) => new OneBotClient({
    wsUrl: cfg.protocol?.wsUrl,
    httpUrl: cfg.protocol?.httpUrl,
    accessToken: cfg.protocol?.accessToken,
    httpToken: cfg.protocol?.httpAccessToken || cfg.protocol?.accessToken,
    onEvent,
  }),

  'core.send': ({ onebot, store, log, components }) => new SendQueue({
    onebot,
    store,
    components,
    onSent: ({ chatKey, text }) => log(`[发送 -> ${chatKey}] ${String(text).slice(0, 60)}`),
    log,
  }),

  // ── 媒体 ──────────────────────────────────────────────────
  'core.media': ({ onebot }) => new VideoReader(onebot),

  // ── 编排 ──────────────────────────────────────────────────
  // components 继续往下传，orchestrator 内部据此解析 14 个细粒度策略。
  'core.orchestrator': ({ store, memory, sender, sessions, onebot, emit, reminders, videoReader, components }) =>
    new Orchestrator({ store, memory, sender, sessions, onebot, emit, reminders, videoReader, components }),
};

/**
 * 合并默认表与显式传入的覆盖，并校验每个条目都是可调用的工厂。
 *
 * @param {Record<string, Function>} [selected] 显式覆盖（通常来自启动组合层）
 * @returns {Record<string, Function>}
 */
export function createFactories(selected = {}) {
  if (selected != null && typeof selected !== 'object') {
    throw new TypeError('启动组合 components 必须是对象');
  }
  const table = { ...defaultFactories, ...(selected ?? {}) };
  for (const [key, factory] of Object.entries(table)) {
    if (typeof factory !== 'function') {
      throw new TypeError(`启动组合组件 ${key} 必须是函数`);
    }
  }
  return table;
}

/** 供诊断使用：当前生效的组件键列表。 */
export function listComponentKeys(table = defaultFactories) {
  return Object.keys(table).sort();
}
