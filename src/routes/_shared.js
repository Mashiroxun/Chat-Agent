// 路由层共享件（2026-11-04 拆分自 routes.js 的 createRoutes 巨型闭包）。
//
// ── 为什么独立成一个文件 ───────────────────────────────────────────────────
// 拆分前 routes.js 是一个 5248 行的函数，所有 handler 都靠同一个闭包拿
// bodyOf / skillRuntimeContext / createForgeProgress。按域拆成多个模块后，
// 这些跨域共享的东西必须有唯一出处 —— 否则又会出现"两份实现慢慢漂移"
// （本项目的记忆检索就吃过这个亏，见 skills/memory-recall/index.js 头注释）。
//
// ── 归属原则 ──────────────────────────────────────────────────────────────
//   · 只有一个域用的辅助函数 → 放进那个域自己的模块，别放这里
//   · 两个及以上域用的 → 放这里，并在下面注明有谁在用
//   · 工厂函数（makeXxx）接收 deps/emit 而不是 import 全局单例 ——
//     保持可测试，也避免模块级状态在拆分后变得不可追踪

import { getConfig } from '../config.js';
import { skillManager } from '../skills/manager.js';
import { effectiveVisionEnabled } from '../vision-scan.js';
import { acquireForgeDraftLock } from '../forge-draft-lock.js';

// ── 草稿级写入互斥（2026-10-28 审计修）───────────────────────────────────────
//
// 前端有 forgeBusy/upgradeBusy 两道界面守卫，但那只是**界面层**：刷新页面、
// 开两个窗口、或直接打接口都能绕过去。草稿是磁盘上的一堆文件，两个请求同时
// 往里写就是"谁后落盘谁说了算" —— 结果清单里的文件与闸门结论对不上，而闸门
// 结论正是用户点「安装」的依据。
//
// 锁本身在 src/forge-draft-lock.js（纯内存、无 IO，可单测）；这里只负责
// 把它和 HTTP 响应对接起来：拿不到锁就回 409，拿到就在响应结束时自动释放。
// 使用方：routes/forge.js（draft / adapt / upgrade / upgrade-install 等）。

/**
 * 取锁；拿不到就直接回 409 并返回 false，调用方 `return;` 即可。
 * @returns {boolean} true = 已持有锁（响应结束自动释放）
 */
export function lockForgeDraft(res, json, draftId, kind) {
  const lock = acquireForgeDraftLock(draftId, kind);
  if (lock.busy) {
    const secs = Math.max(0, Math.round((Date.now() - lock.busy.since) / 1000));
    json(res, 409, {
      ok: false,
      busy: true,
      error: `这个草稿正在被「${lock.busy.kind}」处理（已 ${secs} 秒）—— 等它结束后再试。`
        + '同时发两个改写请求会让草稿内容与闸门结论对不上。'
    });
    return false;
  }
  // 挂在响应结束上而不是包 try/finally：handler 里有多处 return，
  // 逐个包裹容易漏；finish/close 一定能触发（含异常被上层转成 500 的情况）。
  res.once('finish', lock.release);
  res.once('close', lock.release);
  return true;
}

// ── 状态接口热路径的短超时保护 ─────────────────────────────────────────
// /api/status 是渲染层启动轮询的热路径（秒级），任何子调用拖过 5s 都会让渲染层
// 掐断请求、表现为"状态接口没回"/启动卡死。qqPortableStatus 内部会跑 reg query +
// powershell 枚举盘符 + 进程枚举，在部分机器（杀软拦截 reg.exe / 盘符多）上可能要
// 几十秒；超时即返回降级值，绝不阻塞整条状态接口。慢探测仍在后台跑完并填充 30s 缓存，
// 下轮轮询自然拿到真实数据。
// 使用方：routes/system.js（/api/status）、routes/protocol.js（qq-portable 状态）。
export const QQ_PORTABLE_DEGRADED = {
  ready: false, running: false, pid: null, dir: null, dataDir: null,
  setup: {}, source: 'unknown', portableInstalled: false, degraded: true
};

export function withStatusTimeout(promise, fallback, ms = 1500) {
  // 真 promise 失败时也走降级值，避免 race 里留下未处理的 rejection。
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

// 更新源健康状态（2026-10-23 体检）：远端 version.json 落后于当前安装版本时，
// 「hasUpdate=false」和「已经是最新」长得一模一样 —— 源荒废了也不会有人发现。
// 这里只在同一次进程里告警一次，避免用户每开一次设置页就刷一条日志。
// 使用方：routes/system.js（/api/version、/api/update-check）。
export const updateFeedState = { staleWarned: false };

/**
 * 请求体读取（容错：没 body 当空对象）。
 * 但 readBody 明确标记的可暴露错误（400 非法 JSON / 413 过大）必须透传，
 * 否则会从"应返回 400"退化成静默当成空 patch。
 * @param {(req: import('node:http').IncomingMessage) => Promise<any>} readBody app.js 注入
 */
export function makeBodyOf(readBody) {
  return (req) => readBody(req).catch((e) => { if (e?.expose) throw e; return {}; });
}

/**
 * Skill 可用性判断的运行期上下文。
 * 必须和 orchestrator 用同一份输入，否则会出现
 * "设置页说可用、运行时空工具列表"的口径分裂。
 *
 * 使用方：几乎所有读工具/技能可用性的路由（doctor / skills / tools / dev /
 * forge / plugin-tool / prompt-preview），拆分前是全文件引用最广的辅助函数（62 处）。
 */
export function skillRuntimeContext() {
  const cfg = getConfig();
  return {
    skills: skillManager,
    toolsCfg: cfg.tools || {},
    // 与 orchestrator 同款判定（现在走同一个函数，别再各写一遍 ——
    // 曾经这里只看主模型，漏掉「识图模型」那条路，见 R135）
    visionEnabled: effectiveVisionEnabled(cfg),
    searchEnabled: cfg.webSearch?.enabled !== false,
    runtimeContext: {
      model: cfg.api?.model || '',
      provider: cfg.api?.provider || '',
      source: 'api'
    }
  };
}

/**
 * 长任务进度推送（2026-10-27）：给"让模型改草稿"这类分钟级请求画进度条用。
 *
 * 背景：/api/forge/adapt 与 /api/forge/upgrade 一次请求能跑好几分钟（适配最长
 * 2 段 × 240s，升级含自动修复轮最长 8 分钟），期间界面只有一行「正在适配…」，
 * 用户无从判断它是在跑还是已经卡死 —— 只能反复刷新、重开。这里在每个真实节点
 * emit 一条 forge-progress（走 /api/events 的 SSE，与「模型逐个审」的
 * doctor-triage 同一套机制），前端据此画"步骤点 + 百分比条 + 当前在做什么"。
 *
 * ⚠️ 两条纪律（维护时别破坏）：
 *  1. 只陈述**已经发生**的事（读完几个文件、第几轮、刚改了哪个文件）。绝不给
 *     "还剩多久 / 还剩几轮" —— 模型什么时候收工，后端同样不知道，编出来就是骗人。
 *     所以这里的百分比是"节点锚点"，不是时间估算，别把它当倒计时用。
 *  2. 百分比只由真实节点推进，且**只许涨不许跌**（模型可能反复读写同一文件，
 *     进度条回退看着像出错）。节点之间几十秒的空白由前端秒表补视觉动感，后端不掺水。
 *
 * @param {(event: string, payload: any) => void} emit SSE 推送（app.js 注入）
 * @returns 工厂：makeProgress(job, draftId, opts) 返回可直接调用的 progress 函数
 * 使用方：routes/forge.js（adapt / upgrade / draft）。
 */
export function makeCreateForgeProgress(emit) {
  return function createForgeProgress(job, draftId, opts = {}) {
    const t0 = Date.now();
    const maxRounds = opts.maxRounds || 12;
    const maxSegments = opts.maxSegments || 1;
    // 阶段 → 进度锚点。模型段（round / tool / tool-done / segment / fix）没有固定锚点，
    // 由下面公式按轮次插值 —— 那才是真正耗时的部分，必须让它动起来。
    const PHASE_PCT = { prepare: 6, gate: 14, env: 18, tools: 20, 'model-start': 22, gate2: 92, diff: 96 };
    // 阶段 → 第几步：前端画"①读包 ②过闸门 ③模型改 ④重跑闸门 ⑤出对比"，done=5 表示全勾完
    const PHASE_STEP = {
      prepare: 0, gate: 1, env: 1, tools: 1, 'model-start': 2,
      round: 2, tool: 2, 'tool-done': 2, segment: 2, fix: 2,
      gate2: 3, diff: 4, done: 5, error: -1
    };
    const TOOL_VERB = {
      forge_write_file: '改写', forge_read_file: '读取',
      forge_list_files: '列出文件', forge_delete_file: '删除'
    };
    // 进度状态：handler 直接读写（progress.st.round = n 之类），emit 时统一带上
    // fixIdx：升级路线的"自动修复轮"序号（>0 表示正在补改闸门阻断项）
    const st = { round: 0, seg: 1, toolIdx: 0, changed: 0, blocking: 0, fixIdx: 0 };
    let lastPct = 0;

    const progress = (phase, extra = {}) => {
      let pct = PHASE_PCT[phase];
      if (pct == null) {
        // 模型段：22% 起步，按"已跑轮次 + 轮内第几个工具"插值到上限。
        // 单轮按 6 次工具调用估满（够覆盖绝大多数"读一遍 + 改几处"的轮）。
        const perRound = 66 / maxRounds;
        const inRound = Math.min(1, st.toolIdx / 6);
        const byRound = Math.round(22 + Math.max(0, st.round - 1 + inRound) * perRound);
        // 封顶：正常段 88%，自动修复轮 95%（后面还要留给 diff / done 往上走）。
        // 每次事件**至少比上一次多 1%** —— 两次工具调用之间常常隔几十秒，
        // 让它这段时间里还在慢慢爬，而不是死在同一格上让人以为卡住。
        // （升级路线最长 8 分钟，修复轮要是卡在 92% 一动不动，等于没做进度条。）
        const cap = st.fixIdx ? 95 : 88;
        pct = Math.min(cap, Math.max(byRound, lastPct + 1));
      }
      if (phase === 'done' || phase === 'error') pct = 100;
      else { lastPct = Math.max(lastPct, Math.min(99, pct)); pct = lastPct; }
      try {
        emit?.('forge-progress', {
          job, draftId, phase, step: PHASE_STEP[phase] ?? 2, percent: pct,
          round: st.round, maxRounds, seg: st.seg, maxSegments,
          elapsedMs: Date.now() - t0, changed: st.changed, blocking: st.blocking,
          ...extra
        });
      } catch { /* 推送失败绝不能影响任务本身 */ }
    };
    progress.st = st;
    /** 一轮开始：重置轮内工具计数并推一条"第 n 轮"。 */
    progress.beginRound = (n) => {
      st.round = n; st.toolIdx = 0;
      progress('round', { label: `第 ${n}/${maxRounds} 轮：模型在读代码、想改法` });
    };
    /** 一次工具调用开始：只报"要动哪个文件"，不报结果（结果还没出来）。 */
    progress.beginTool = (name, path = '') => {
      st.toolIdx += 1;
      const verb = TOOL_VERB[name] || '调用工具';
      progress('tool', { label: `${verb}${path ? ` ${path}` : ''}`, file: path, tool: name });
    };
    /** 一次工具调用结束：写/删成功才计入"已改 N 处"（读文件不算改动）。 */
    progress.endTool = (name, path = '', ok = true) => {
      if ((name === 'forge_write_file' || name === 'forge_delete_file') && ok) st.changed += 1;
      const verb = TOOL_VERB[name] || '调用工具';
      progress('tool-done', {
        label: ok ? `已${verb}${path ? ` ${path}` : ''}` : `${verb}${path ? ` ${path}` : ''} 失败`,
        file: path, tool: name, ok
      });
    };
    return progress;
  };
}
