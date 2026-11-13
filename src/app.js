// 总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
// Electron 主进程与 headless 服务器都从这里启动。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig, updateConfig, ROOT, DATA_DIR, isChatAllowed, setConfigProvider } from './config.js';
// 版本迁移：处理跨版本升级后残留的旧插件目录/配置引用（详见该文件头部注释）。
// 必须在 reloadSkills 之前跑 —— 插件扫描读的就是 config.trustedPlugins。
import { runUpgrades } from './upgrade.js';
// QQ 版本 vs 协议端声明的只读核对（r132）：面向大众分发后用户 QQ 版本各异，
// 版本错开时登录被拒/接口异常且排查方向极易跑偏 —— 状态接口和启动日志里必须能看见。
import { OneBotClient, segmentsToText, extractMediaFromSegments, expandForwardNodes, fetchForwardNodes, pickQuoteMid } from './onebot.js';
// 协议端配置探测（2026-10-24）：令牌是 SnowLuma 按账号随机生成的，让新用户
// 从 WebUI 手抄两串 43 位字符串是首次配置最容易失败的一步 —— 这里直接读它的
// 配置文件把端点与令牌填好。只读，且令牌不出进程（对外的 publicView 会删掉）。
import { detectProtocol, publicView as protocolDetectView } from './protocol-detect.js';
import { createProtocolLauncher } from './protocol-launcher.js';
import { createWebuiClient } from './protocol-webui.js';
import { createProtocolOnboard } from './protocol-onboard.js';
// isAtMe 是「是否被艾特」的唯一权威实现（含 QQ 号判定，见 prompt.js 注释）。
// 这里曾经就地抄过一份只认名字的判定，结果群昵称改了就漏判 —— 统一走权威实现。
import { isAtMe, setPromptProviders } from './prompt.js';
import { ChatStore } from './store.js';
import { MemoryStore } from './memory.js';
import { cacheIncomingImages } from './image-cache.js';
import { SendQueue } from './sender.js';
import { SessionRegistry } from './sessions.js';
import { Orchestrator } from './orchestrator.js';
import { ReminderStore } from './reminders.js';
import { VideoReader } from './video-reader.js';
import { cacheHitRate, estimateCost, setApiProvider } from './llm.js';
import { initPriceFeed, stopPriceFeed } from './price-feed.js';
import { startTelemetryLoop, stopTelemetryLoop } from './telemetry.js';
import { startCacheWarm, loadPersistedPrefix, seedPrefixFromSessions, warmOnce, markCurrentShapeWarmed } from './cache-warm.js';
import { diskPressure, diskPressureText } from './disk-space.js';
import { loadPlugins, watchPlugins, setOnebotClient, PLUGINS_DIR, SKILLS_DIR } from './plugin-loader.js';
// 启动组合（0.4.9.2）：组件装配改为查表，见 src/composition/factories.js。
// 不传 components 时全部回落到洛版原实现，行为与 0.4.9.1 一致。
import { createQqPortable } from './qq-portable.js';
import { setFetchProvider } from './safe-fetch.js';
import { createFactories, defaultFactories, listComponentKeys } from './composition/factories.js';
import { createCompositionLifecycle } from './composition/lifecycle.js';
// 工具集批量静默期：重扫期间 N 个插件会逐个注册工具，中间态一律不发给模型，
// 扫描结束一次性生效。详见 tool-registry.js「批量加载静默期」注释。
import { beginToolsetBatch, endToolsetBatch } from './tool-registry.js';
import { registerHarness } from './harness/index.js';
import { skillManager, setSkillManager } from './skills/manager.js';
// 插件界面契约：常量 / 路径规则 / URL 拼装 / CSP 全部来自这一份，
// 前端（06-settings-render.js）与插件侧（api.panel）也 import 同一份 ——
// 三处各写一遍的时候，任何一处改动漏掉另一处都表现为"按钮点了白屏"且不报错。
import { PANEL_ROUTE_PREFIX, PANEL_DATA_SEGMENT, PANEL_FILE_TYPES, panelCsp } from './skills/panel.js';
import { extractCandidateUrls, dispatchMediaLinks } from './media-links.js';
import { createRoutes } from './routes.js';
// 应用内自更新服务（2026-11-12，方案 A+B）：/api/update-apply 三条路由的后端。
// 纯 node 模块（不 import electron），headless 下同样可用（仅少「自动退出」一步）。
import { createSelfUpdateService } from './self-update.js';
// 桌宠 HTTP 适配器：只处理 /api/desktop-pet/*，且挂在控制台鉴权 + 同源检查之后。
import { handleDesktopPetRequest } from './desktop-pet-api.js';
import { createPetChat } from './pet-chat.js';
import * as instanceLockModule from './instance-lock.js';
import { logger, setLogger } from './logger.js';
import { startCommunitySync, isGloballyBlocked, FIXED_PRICE_FEED_URL } from './community.js';
import { noteMuted, noteUnmuted } from './ban-state-client.js';
import { buildUsageStats, buildUsageBreakdown, collectUsageRows, dayKeyOf, warmUsageArchive, setUsageProvider } from './usage-stats.js';

// 全局 fetch（undici）默认连接建立超时只有 10 秒，openrouter.ai 这类海外端点
// 握手慢时会直接报 "Connect Timeout Error ... timeout: 10000ms"（注意这不是
// 请求超时——那是 llm.js 里 180 秒的 AbortSignal）。这里放宽到 30 秒。
// 动态导入 + 容错：undici 与 Electron 内置 Node 不兼容时只退回默认超时，绝不崩主进程。
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ connect: { timeout: 30_000 } }));
} catch (error) {
  console.warn('[net] 全局连接超时设置失败（使用 undici 默认值 10s）:', error?.message ?? error);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '..', 'ui');

// ── 插件界面（`/plugin-panel/<id>/…`）──────────────────────────────────────
// 契约（常量、路径规则、URL 拼装、CSP）全在 src/skills/panel.js —— 这里只负责
// "把磁盘上的文件按那套规则吐出去"。以前这份扩展名表在这里另写了一份，与前端
// 各自演进，所以现在统一 import。

// ── 白名单判断：委托给 config.js 的 isChatAllowed（全库唯一实现） ──────────
// 之前 allowed() 与发送侧闸各写一套，移除白名单后"发言"侧没同步 —— 现在统一走一份。
// 保留本函数名/签名，调用方无需改动。
function allowed(kind, id, cfg) {
  return isChatAllowed(kind, id, cfg);
}

// ── 版本更新检查 ─────────────────────────────────────────────────────
// 由后端代取而不是前端直连：绕过 CORS，且失败信息能统一回给 UI。
// 更新源（2026-11-04 改；2026-11-05 仓库转公开后匿名可读）：
// 自己的 GitHub 仓库，发版时把 version.json 一起推上去即可。
// 可被 config.update.checkUrl 覆盖 —— 私有仓库的 raw 链接匿名读不到（404），
// 那种情况要么把仓库设公开，要么另建一个只放 version.json 的公开仓库再填到这里。
// 国内直连 raw.githubusercontent.com 不稳（2026-11-05 实测返回 500），
// 默认改用 jsDelivr 镜像，国内可达。私有仓库 / 想换源仍可用 config.update.checkUrl 覆盖。
// ⚠️ jsDelivr 的 @main 引用有 12 小时缓存（2026-11-05 实测：purge 接口报 finished
//    但各节点仍返回旧内容）。发版后若要立即生效，先调一次：
//      https://purge.jsdelivr.net/gh/Mashiroxun/Chat-Agent@main/version.json
//    或改用 tag 引用（@v0.4.9.3），缓存 key 随 tag 变化，天然绕过旧缓存。
const UPDATE_INFO_URL = 'https://fastly.jsdelivr.net/gh/Mashiroxun/Chat-Agent@main/version.json';

function localVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch { return '0.0.0'; }
}

/**
 * 逐段数字比较；返回 1 / 0 / -1。非数字段按 0 处理。
 *
 * ⚠️ 段数必须取两侧的**最大值**（2026-10-16 第二轮审查修）：本项目的版本号是
 *    四段（package.json 现为 0.4.8.7），而线上 version.json 只有三段（0.4.0）。
 *    原实现写死 `i < 3`，只比前三段 —— 一旦线上改用四段、且变化只发生在第四段
 *    （0.4.8.5 → 0.4.8.6），比较结果恒为 0，`hasUpdate` 永远是 false，
 *    用户收不到任何更新提示。按 max(len) 走：两侧都是三段时行为与原来完全一致，
 *    四段版本也不会再漏判。
 */
function compareSemver(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/* createApp 产生的所有 appLog 函数（模块级 WeakSet）。
   用于识别"调用方传入的 log 是不是上一次 createApp 留下的 appLog"，
   防止监听器链式递归（见 createApp 内的递归护栏注释）。 */
const appLogFns = new WeakSet();

export function createApp({ log = console.log, desktopPetHost = null, components = {}, composition = null, lifecycle: injectedLifecycle = null } = {}) {
  // 启动组合生命周期（0.4.9.3）：覆盖层组件可以登记清理函数，stop() 时逆序执行。
  // 允许外部注入（测试用 / 多实例共管）；不传则每个 createApp 独享一份。
  const lifecycle = injectedLifecycle ?? createCompositionLifecycle();
  // 启动组合注入（0.4.9.3）：这两项必须在读配置之前生效，所以放在最前面。
  // 不传时是 no-op，行为与之前完全一致。
  if (typeof components['runtime.config'] === 'function') {
    setConfigProvider(components['runtime.config']);
  }
  if (components['runtime.plugins']) {
    setSkillManager(components['runtime.plugins']);
  }
  if (typeof components['runtime.fetch'] === 'function') {
    setFetchProvider(components['runtime.fetch']);
  }
  // 日志出口（0.4.9.3）：可换成外部日志系统；接口不对时忽略并警告。
  if (components['runtime.logger']) {
    setLogger(components['runtime.logger']);
  }
  // 目标渠道（0.4.9.3）：llm.target —— 本次请求用哪个 baseUrl/key/协议。
  if (typeof components['llm.target'] === 'function') {
    setApiProvider(components['llm.target']);
  }
  // 提示词片段（0.4.9.3）：用户消息里【过去状态】段的构造逻辑。
  // 两个都必须是同步函数 —— 返回 Promise 会让提示词里出现 "[object Promise]"。
  if (components['core.prompt.pastState'] || components['core.prompt.anchor']) {
    setPromptProviders({
      pastState: components['core.prompt.pastState'],
      anchor: components['core.prompt.anchor'],
    });
  }
  const cfg = getConfig();

  // 桌面伙伴：能力按"已激活的插件"取用 —— 插件没装/被禁用时返回 null，
  // 整个桌宠链路（API、事件转发、窗口）降级为无操作，不影响群聊。
  function getDesktopPetService() {
    try {
      return skillManager.getCapabilityProviders('desktop.pet.service', {})[0]?.fn?.() || null;
    } catch { return null; }
  }

  // 桌宠「今日用量」卡片：**与主界面顶栏完全同一数据口**（2026-10-24 修）。
  // 曾经走 buildUsageStats({ range: 'today' })，实测两个数字并排一比对不上
  // （用户截图：顶栏 375 次运行 vs 桌宠卡 350 次运行），根因有两个：
  //   ① 口径不同 —— 统计模块的 totals.runs 是「LLM 调用次数」（一轮一次，
  //      一个会话 N 轮算 N）；而顶栏 /api/status 的 usage.runs 是「会话运行
  //      次数」（一个非零消耗会话 +1）。卡片文案抄了顶栏的「今日：N 次运行」，
  //      数字却是另一套口径。
  //   ② 3 小时结果缓存 —— buildUsageStats 的结果缓存（USAGE_STATS_CACHE_TTL_MS）
  //      对 'today' 同样生效，卡片每 5 秒的“刷新”没传 force，永远在读同一份
  //      最多 3 小时前的快照 —— 数字停在几小时前不动，比口径差异更迷惑。
  // 改为直接读 sessions.todayUsage()（usage-today.json + 运行中会话，实时、O(1)）
  // + estimateCost + cacheHitRate，与 /api/status 顶栏逐字段同源 —— 卡片与顶栏
  // 从此一字不差。旧版多行卡片时代的 chats/models 字段已随其卡片一并移除
  // （现行一行式卡片从不读，pushUsage 的判型兜底也已同步删除）。
  async function getUsageToday() {
    try {
      const usage = sessions.todayUsage(dayKeyOf(Date.now()));
      const cost = estimateCost(usage, { model: getConfig().api?.model });
      return {
        ok: true,
        range: 'today',
        totals: {
          runs: Number(usage.runs) || 0,
          promptTokens: Number(usage.promptTokens) || 0,
          completionTokens: Number(usage.completionTokens) || 0,
          totalTokens: Number(usage.totalTokens) || 0,
          cachedTokens: Number(usage.cachedTokens) || 0,
          cacheHitRate: cacheHitRate(usage),
          cost: Number(cost?.cost) || 0,
        },
        searchCount: Number(usage.webSearchCount) || 0,
      };
    } catch (error) { return { ok: false, error: String(error?.message || error) }; }
  }

  // 桌宠「开发工单」对话框：包装 dev-orders 的只读/发送能力。
  // ⚠️ 只在插件激活时拿得到提供者；未启用时返回 available:false，由界面提示去插件页开启。
  function devApi() {
    const call = (cap, args) => {
      let fn = null;
      try { fn = skillManager.getCapabilityProviders(cap, {})[0]?.fn || null; } catch { fn = null; }
      if (!fn) return { ok: false, available: false, error: '「开发工单」插件未启用（顶部「插件」页 → dev-orders）' };
      try { return { available: true, ...fn(args) }; }
      catch (error) { return { ok: false, available: true, error: String(error?.message || error) }; }
    };
    return {
      snapshot: (selected = '') => call('dev.snapshot', { selected }),
      detail: (id, from = 0) => call('dev.order-detail', { id, from }),
      send: (id, text) => call('dev.send', { id, text }),
      newSession: (text = '') => call('dev.new-session', { text }),
      closeSession: (id) => call('dev.close', { id })
    };
  }
  // 桌宠「直接对话」：把用户在桌面小窗里打的一句话，以「主人」身份送进真实的
  // QQ 会话流水线（orchestrator.injectOwnerMessage），回复被 capture 接住、不真的发去 QQ。
  // 懒创建 —— 只在用户真的打开对话窗时才建，控制台/群聊链路上零额外开销。
  let petChat = null;
  function chatApi() {
    try {
      if (!petChat) petChat = createPetChat({
        log: (text) => log(`[pet-chat] ${text}`),
        deps: { orchestrator, store }
      });
      return petChat;
    } catch (error) {
      log(`[pet-chat] 初始化失败：${String(error?.message || error)}`);
      return null;
    }
  }
  // Electron 主进程独占此随机凭据，并通过 webRequest 只注入当前控制台窗口的 API 请求。
  // 不写入 HTML / preload / 配置文件，避免把 server.token 暴露给页面或其他本机进程。
  const rendererAuthToken = randomBytes(32).toString('hex');

  // 详尽日志：把 createApp 的 log 接到分级日志系统（落盘 + 内存缓冲 + SSE）。
  // 关键：logger 的 mirrorConsole 已经会走 console，所以这里**只写 logger、不再调原 log**，
  // 否则 appLog → logger.info → console(log) → 若 log 又被指回 appLog 就会无限递归（selftest 就是这么挂的）。
  // logger.mirrorConsole = true 时 console 输出不丢；调用方传入的自定义 log（如测试的静默 log）
  // 通过 logger 的 onLog 监听器另行转发，不经过 console。
  const appLog = (...args) => {
    logger.info('app', ...args);
  };
  // 把调用方传入的 log（如 Electron 的 console.log 或测试的静默 log）挂到 logger 的监听器上，
  // 与 mirrorConsole 解耦：mirrorConsole 管 console，监听器管调用方的 log。
  //
  // ⚠️ 递归护栏（15GB 日志事故根因）：
  //   若调用方传入的 log 本身就是上一次 createApp 留下的 appLog
  //   （同进程内二次 createApp：Electron 重启核心 / 测试串行多轮），
  //   监听器链会形成 appLog→logger→监听器→appLog 的无限递归，
  //   每轮递归给文本再包一层 [app] 前缀 —— 一条日志膨胀成几千条、
  //   每条带几千个 [app] 前缀，几个小时内日志文件就能写到 15GB。
  //   这里用 WeakSet 识别"这个 log 是不是 appLog"，是则跳过挂载。
  // r92：持有退订函数。原实现把 logger.onLog 的返回值直接丢掉 —— 同进程二次
  // createApp（Electron 重启核心 / 测试串行多轮）时旧监听器仍在：每条日志
  // 广播 N 份、持有上一个 app 的 log 闭包（可能指向已销毁的窗口）。
  let unsubscribeAppLog = null;
  if (!appLogFns.has(log)) {
    unsubscribeAppLog = logger.onLog((entry) => {
      try { log(`[${entry.module}] ${entry.text}`); } catch { /* ignore */ }
    });
  }
  appLogFns.add(appLog);
  // 关掉 logger 的 console 镜像，避免与上面的监听器重复打印（调用方 log 通常就是 console.log）。
  logger.mirrorConsole = false;
  // 后续内部调用统一指向 appLog（关键事件落盘 + 走调用方 log）
  log = appLog;
  // 启动时清理过期日志文件
  logger.prune();

  // ── 进程单实例锁（防止桌面端 + headless 双开导致重复回复群消息）──
  // 与 Electron 的 requestSingleInstanceLock 互补：那只管 Electron 进程之间，
  // 这里管"同一数据目录下任何形态的 QQ Agent 核心"（含 node src/server.js）。
  const { acquireInstanceLock, releaseInstanceLock } = instanceLockModule;
  const lockResult = acquireInstanceLock();
  if (!lockResult.ok) {
    // 不抛异常上抛让进程退出 —— 创建期的失败应当让整个启动失败。
    throw new Error(`[单实例] ${lockResult.reason}。如需多开测试，请用不同的 QQ_AGENT_DATA_DIR。`);
  }
  /* 抢到锁后立刻注册退出清理：正常 exit / SIGINT / SIGTERM 都会释放锁文件。
     曾经只在 stop() 里释放 —— 进程被直接杀掉（任务管理器结束、控制台叉掉）
     时锁文件残留，下次启动要靠"PID 已死"探测才能清掉，多一层失败面。 */
  instanceLockModule.registerLockCleanup();
  const sseClients = new Set();

  /**
   * 端口探测（**永不 reject**，失败一律 resolve(false)）。
   *
   * 为什么强调这一点（2026-10-17 加固）：这是 OneBot WS 端口就绪轮询的公共前置探测。
   * 端口值来自 `config.protocol.wsUrl`（用户/协议端自己可能写坏）。实测
   * `net.Socket.connect(99999 / -1 / NaN)` 会**同步抛** RangeError → Promise executor
   * 抛 = 这个 Promise **reject** → 顺着 await 往外冒，轮询回调的 try/catch 会表现为
   * 每 2 秒一行异常日志（快速恢复等于没了）。
   * "端口写坏了"只应该等于"没开"，绝不该等于"功能全废"。
   */
  let pluginWatcher = null;        // 开发模式热重载 watcher（stop() 时要 close，否则句柄泄漏）
  let obPortPollTimer = null;      // OneBot WS 端口就绪轮询（stop() 时要 clear，start() 里赋值）
  let diskPatrolTimer = null;      // 数据盘空间巡检（stop() 时要 clear，start() 里赋值）
  // 事件出口（0.4.9.3）：core.events 可以接管，但**第三个参数是原实现 next**。
  //   · 想旁路观察（记日志/镜像/统计）：调 next(type, payload) 再返回
  //   · 想完全接管（过滤/改写）：不调 next
  // 这样「忘了转发导致桌宠和界面收不到事件」是一个显式选择，而不是静默事故。
  const emitBase = (type, payload) => {
    // 桌宠只关心"连接状态 / 会话状态"这几类事件（用于状态气泡与成就统计）。
    // 这是直接调用，不是插件 hook —— 桌宠抛错绝不能影响群聊主链路。
    if (type === 'onebot-status' || type === 'status' || String(type).startsWith('session-')) {
      try { getDesktopPetService()?.onCoreEvent?.(type, payload); } catch { /* 桌宠异常不影响群聊 */ }
    }
    // 说明：这里曾经先走一个进程内事件总线（createEventBus），但全项目**没有任何订阅者**，
    // 属于纯空转；更糟的是它给人"存在进程内订阅者"的错觉。真正的消费者只有 SSE。
    let line = null;
    if (type === 'session-update' && payload?.sessionId) {
      try {
        // peek：只序列化、不修改，不需要 get() 那份全量 structuredClone
        // （运行中的会话每次更新都广播，克隆大会话会拖慢事件投递）
        const s = sessions?.peek(payload.sessionId);
        if (s) {
          line = `event: ${type}\ndata: ${JSON.stringify({
            sessionId: s.id,
            chatKey: s.chatKey,
            startedAt: s.startedAt,
            status: s.status,
            waitUntil: s.waitUntil ?? null,
            activity: s.activity ?? '',
            webSearchCount: s.webSearchCount ?? 0,
            rounds: s.rounds ?? 0,
            usage: s.usage ?? null,
            trigger: s.triggerSummary ?? '',
            triggerSummary: s.triggerSummary ?? '',
            messages: s.messages ?? [],
            // sent/finishReason/error/endedAt 必须随 SSE 推下去：
            // 曾经载荷里没有它们，"已发送到 QQ"徽标只能等 HTTP 轮询带回来；
            // 而会话一结束轮询就不再拉详情（只刷 running/waiting），
            // 用户只能手动刷新才看得到最终发言 —— 这就是"详情更新不及时"。
            sent: s.sent ?? [],
            finishReason: s.finishReason ?? null,
            error: s.error ?? null,
            endedAt: s.endedAt ?? null
          })}\n\n`;
        }
      } catch { /* 失败就退回原 payload */ }
    }
    if (!line) line = `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of sseClients) {
      // 同步异常 + 已经不可写的连接都要清理，否则集合只增不减、每次都白写
      if (res.writableEnded || res.destroyed) { sseClients.delete(res); continue; }
      try {
        res.write(line);
      } catch {
        sseClients.delete(res);
      }
    }
  };

  // 层接管时把原实现作为 next 传进去，避免"忘了转发 = 事件断流"。
  const emit = typeof components['core.events'] === 'function'
    ? (type, payload) => components['core.events'](type, payload, emitBase)
    : emitBase;

  // ── 便携 QQ 进程管理（0.4.9.3：已外提到 src/qq-portable.js）──────────
  // 状态（qqPortableLogs / qqPortableProc / 各种缓存）都在模块闭包里，
  // 这里只是拿到门面方法。emit 必须已经定义，所以放在它之后。
  const {
    isPortOpen, qqPortableStatus, qqPortableLogs,
    launchPortableQQ, stopPortableQQ, showPortableQQ, setupPortableQQFromLocal,
  } = createQqPortable({ log, emit });


  // ── 组件（0.4.9.2：改为启动组合查表）────────────────────────────────
  // 原来这里是 8 个 `new Xxx()`。现在统一走 factories 表：
  //   · 不传 components 时，表里每一项都指向洛版原实现 —— 行为与 0.4.9.1 完全一致
  //   · 传了 components 时，同键名的工厂会覆盖默认实现，不必改本文件
  // 键名对齐 0.5 的组件表（data.* / core.* / transport），两边覆盖层可互相搬。
  const visionScan = { running: false };   // 模型图片输入能力扫描的运行状态
  const factories = createFactories(components);
  const componentKeys = listComponentKeys(factories);

  const store = factories['data.messages']({ cfg, log, lifecycle });
  const memory = factories['data.memory']({ cfg, log, lifecycle });
  const sessions = factories['data.sessions']({ cfg, log, lifecycle });
  // OneBot WS 端口（从 protocol.wsUrl 推导，供端口就绪轮询使用）。
  function protocolWsPort() {
    try {
      const u = new URL(String(getConfig().protocol?.wsUrl || 'ws://127.0.0.1:3001'));
      if (u.port) return Number(u.port);
    } catch { /* ignore */ }
    return 3001;
  }
  const onebot = factories['transport']({
    cfg,
    log,
    lifecycle,
    onEvent: (event) => handleOneBotEvent(event).catch((error) => log('[ingest] 处理事件出错:', error?.message ?? error)),
  });
  setOnebotClient(onebot);
  const sender = factories['core.send']({ cfg, log, onebot, store, components, lifecycle });
  const reminders = factories['data.reminders']({ cfg, log, lifecycle });
  // 用量统计（0.4.9.3）：默认工厂返回 null（不接管）；层覆盖后返回服务对象才设置。
  // 这里必须判空 —— 把默认实现注册成 provider 会让它自己调自己（无限递归）。
  const usageService = factories['data.usage']({ cfg, log, lifecycle });
  if (usageService) setUsageProvider(usageService);
  const videoReader = factories['core.media']({ cfg, log, onebot, lifecycle });
  const orchestrator = factories['core.orchestrator']({
    cfg, log, store, memory, sender, sessions, onebot, emit, reminders, videoReader, components, lifecycle,
  });

  // ── 协议端进程托管（2026-10-27，R125）────────────────────────────────────
  // 用户自己装的 SnowLuma 双击启动会常驻一个 cmd 窗口；这里改成由本软件
  // `windowsHide` 拉起，把它的 stdout/stderr 经 SSE 送进连接页（见 src/protocol-launcher.js）。
  // 边界：不随包分发、不改它的文件、不代签 EULA；用户不点「启动」就什么都不发生。
  const protocolLauncher = createProtocolLauncher({
    getConfig,
    updateConfig,
    emit,
    log,
    // 「自动查找」用现成的探测：它先看正在跑的进程，再扫盘，找到的目录最可信
    detectDir: async () => {
      const hit = await detectProtocol({ isPortOpen });
      return hit?.found ? hit.dir : '';
    }
  });

  // ── 协议端「一键接入」（2026-10-27，R126）────────────────────────────────
  // 注入 = 把 SnowLuma 的组件挂进 QQ 进程。原本要用户自己去 5099 控制台登录、
  // 翻进程表、挑号、点注入；这里把它收成一次点击。
  // 合规边界见 src/protocol-webui.js 顶部：只调它自己的 WebUI API，不写它的文件，
  // 不代签协议、不代改密码 —— 需要用户本人表态的步骤一律停下来引导。
  const protocolWebui = createWebuiClient();
  const protocolOnboard = createProtocolOnboard({
    getConfig,
    updateConfig,
    launcher: protocolLauncher,
    client: protocolWebui,
    isPortOpen,
    emit,
    log
  });

  /**
   * 把协议端（SnowLuma）配置文件里的端点/令牌填进 config，并立即重连。
   *
   * 什么时候用（2026-10-24）：
   *   · 首次启动、两个令牌都为空 → 启动后自动跑一次（见 start() 里的首次探测）；
   *   · 连接页「自动读取协议端配置」/「装好并登录了，重新检测」→ 手动触发。
   *
   * 三条硬约束：
   *   ① **只补空字段**（force 除外）：用户手填过令牌就以用户为准，绝不被探测结果覆盖；
   *   ② 地址只在"当前端口没开、探测到的端口在开"时才改 —— 避免把特意指向
   *      另一个实例（NapCat / 双开 / 改过端口）的地址改回默认；
   *   ③ 返回值不含令牌（它要经 /api 回到渲染层），失败只给原因不抛。
   *
   * @param {{force?: boolean, dir?: string}} opts
   */
  async function autoFillProtocol({ force = false, dir = '' } = {}) {
    const cur = getConfig().protocol || {};
    const hit = await detectProtocol({ dir: dir || undefined, isPortOpen });
    if (!hit.found) return { ok: false, found: false, reason: hit.reason };

    const next = {};
    // 当前 WS 端口没开、而探测到的那份在开 → 说明地址也填错了，一并纠正
    const curPortOpen = await isPortOpen('127.0.0.1', protocolWsPort());
    if (!curPortOpen && hit.wsPortOpen) {
      if (hit.wsUrl) next.wsUrl = hit.wsUrl;
      if (hit.httpUrl) next.httpUrl = hit.httpUrl;
    }
    const curWs = String(cur.accessToken || '').trim();
    const curHttp = String(cur.httpAccessToken || '').trim();
    if (hit.accessToken && (force || !curWs)) next.accessToken = hit.accessToken;
    // ⚠️ HTTP 令牌必须单独填：OneBotClient 的兜底是 `httpAccessToken || accessToken`，
    //    只在那两枚恰好相同时才成立。SnowLuma 默认两枚**不同**，拿 WS 那枚顶上照样 401
    //    （本次排障就是这么来的）。
    if (hit.httpAccessToken && (force || !curHttp)) next.httpAccessToken = hit.httpAccessToken;

    const view = protocolDetectView(hit);
    if (!Object.keys(next).length) {
      return { ok: true, ...view, applied: false, reason: '端点与令牌已是最新，无需改动' };
    }
    const saved = updateConfig({ protocol: next });
    // 只记路径与账号，不记令牌
    log(`[onebot] 已从协议端配置自动填充端点（账号 ${hit.uin || '未知'}，来源 ${hit.dir}）`);
    try {
      await onebot.setEndpoint({
        wsUrl: saved.protocol?.wsUrl,
        httpUrl: saved.protocol?.httpUrl,
        accessToken: saved.protocol?.accessToken,
        httpToken: saved.protocol?.httpAccessToken
      });
    } catch (error) {
      // 配置已落盘，只是本次重连没跑起来 —— 如实说，别假装成功
      return { ok: true, ...view, applied: false, reason: `已保存，但重连没跑起来：${error?.message ?? error}` };
    }
    return { ok: true, ...view, applied: true, changed: Object.keys(next) };
  }

  // 远程价格表固定为官网公开地址；不从用户配置读取，避免被页面/配置篡改。
  initPriceFeed(FIXED_PRICE_FEED_URL);

  // 云端统一屏蔽名单：启动先用 data 缓存，后台同步；网络失败不影响本地拦截。
  const communitySyncTimer = startCommunitySync(log);
  communitySyncTimer.unref?.();

  // 前缀缓存保活：默认开启（2026-10-15 用户要求；会主动联网，开关改动无需重启）。
  // 放在这里是为了让它在 orchestrator / 插件加载之前就位 —— 保活构造前缀要用到
  // skillManager 的当前状态，而它晚于本行加载；所以首次 tick 延迟 20 秒兜住。
  const cacheWarm = startCacheWarm(log);

  // 启动即预热（2026-09-20）：保活原先只能等"本次运行"构造出前缀才知道要预热什么，
  // 于是**每个会话的第一次调用永远赶不上预热**（实测 11:12:17 首次调用命中 32%，
  // 而预热 11:12:34 才发出）。这里在启动时载入上次运行落盘的前缀，直接暖一次 ——
  // 第一条群消息的调用就能命中。插件还没加载完，所以延迟 15 秒等 skillManager 就位。
  //
  // ⚠️ R1（2026-10-12）：重启后第一条**仍然会掉**（实测 cached=3200 = 20%）。
  //    原因不是"没预热"，而是**预热的前缀形状与真实调用不同**：
  //    loadPersistedPrefix 载入的是「上次运行」的 system+tools，而本次运行的
  //    代码/工具集可能已经变了（如刚改过 prompt.js / 装了新扩展）→ 预热写的是
  //    旧形状的缓存，真实调用用的是新形状 → 必然错位一次。
  //    修法：预热完成后把**预热用的形状**登记为「已预热形状」，并让真实运行的
  //    noteRealPrompt 在形状变化时自动补一次预热（见 cache-warm.js 的
  //    noteShapeChange）。这样重启后的第一枪落在「上一次真实形状」上，
  //    第二枪时形状已对齐。
  {
    const bootWarm = setTimeout(async () => {
      try {
        // 优先用落盘的前缀；没有（首次安装/刚清过数据）就从会话存档里借一份。
        // 少了这条兜底，"启动预热"在第一次重启后永远没有样本 —— 而第一次调用
        // 恰恰是最需要它的那一次。
        const ok = loadPersistedPrefix() || seedPrefixFromSessions();
        if (!ok) return;
        const r = await warmOnce({ log });
        if (r.ok) {
          markCurrentShapeWarmed();   // R1：登记"这份形状已预热"，避免重复预热
          if (r.dedup) log(`[cache-warm] 启动预热跳过（${r.reason}）`);
          else log(`[cache-warm] 启动预热完成（${r.prompt} tok，命中 ${r.cached}）`);
        }
      } catch { /* 启动预热失败不影响任何功能 */ }
    }, 15000);
    bootWarm.unref?.();
  }

  // OneBot 连接状态推送
  onebot.onStatus((status) => emit('onebot-status', status));

  // ── 入站事件处理 ──
  let atNameCache = new Map(); // groupId:userId -> name
  async function resolveAtName(groupId, userId) {
    const key = `${groupId}:${userId}`;
    if (atNameCache.has(key)) return atNameCache.get(key);
    try {
      const info = await onebot.getGroupMemberInfo(groupId, userId);
      const name = info?.card || info?.nickname || null;
      if (name) {
        atNameCache.set(key, String(name));
        if (atNameCache.size > 500) atNameCache.clear(); // 简单防膨胀
        return String(name);
      }
    } catch { /* ignore */ }
    return null;
  }

  async function resolveReply(messageId) {
    try {
      const msg = await onebot.getMsg(messageId);
      const senderName = msg?.sender?.card || msg?.sender?.nickname || '';
      let text = '';
      let quoteCap = 120;
      let fwdMid = null;
      if (Array.isArray(msg?.message)) {
        // 2026-10-21：以前这里只有 text 段原样透传，其余一律 `[类型名]` —— 于是引用
        // 一条合并转发时，引用块里出现的是字面量 `[forward]`。模型看不懂这个英文占位，
        // 只看见"forward"就以为手上有条没展开的转发，转头拿**外层消息**的 mid 去调
        // read_forward（引用块里并没有给被引用消息的 mid），协议端当然拉不到 →
        // 用户看到的是「展开失败：OneBot get_forward_msg 失败：retcode=100」。
        // 现在统一走 segmentsToText，占位符与正文同口径：[图片]/[表情]/[合并转发聊天记录]。
        // includeReply:false 是为了不递归（被引用的消息里可能还有引用）。
        text = await segmentsToText(msg.message, { includeReply: false });
        // 07:57 再补一层：被引用的那条本身是合并转发时，只给占位符仍然没用 ——
        // 模型知道"这儿有条转发"，却拿不到它的 mid（引用块只带正文），只能拿外层消息
        // 去试 read_forward，试一次失败一次。就地展开塞进引用块，模型直接读到内容，
        // 根本不用调工具。展开不了（转发被服务端丢了）就保留占位符，退路仍是 read_forward。
        if (msg.message.some((s) => String(s?.type ?? '') === 'forward')) {
          try {
            // 4s 上限：这是 ingest 热路径，协议端要是卡住，不能连带把整条入库队列拖死。
            const nodes = await fetchForwardNodes(onebot, messageId, msg.message, 4000);
            const ex = await expandForwardNodes(nodes);
            // 引用块是拼在一行里的（`[引用 名字(QQ:x)：正文]`），换行会把整条消息的行结构拆散，
            // 所以展开出来的多条节点压成一行，用「 / 」隔开。
            if (ex?.text) {
              text = ex.text.replace(/\s*\n\s*/g, ' / ');
              quoteCap = 300;
              // 08:05 又踩一次：内容截到 300 字以后，模型看到「共 6 条」还想看全，
              // 但它手上只有**引用者**那条的 #数字，拿去展开必然"不是合并转发"。
              // 把**被引用消息自己**的 mid 带回引用块，模型要展开时填这个才对得上。
              fwdMid = String(messageId);
            }
          } catch { /* 保留占位符 */ }
        }
      } else if (typeof msg?.message === 'string') {
        text = msg.message;
      }
      // senderId 一并带回：引用块显示为 名字(QQ:xxx)，与发言人标签同口径 ——
      // 没有它，模型分不清引用的是"哪个张三"。
      // mid：以前只在「被引用的那条本身是合并转发且展开成功」时才给，纯图片引用
      //   一律没有编号 → 模型看见 `[引用 张三：[图片]]` 却拿不到消息号，没法调
      //   get_message_images，只能回一句「图没收到」（0.4.9.1 起的用户报障）。
      //   现在凡是被引用的消息里带图片，就把**被引用那条自己**的编号带进引用块；
      //   纯文本仍不给，避免模型拿着引用号去乱试工具。判定抽成 pickQuoteMid 便于回归。
      return { sender: String(senderName), senderId: String(msg?.sender?.user_id ?? ''), mid: pickQuoteMid(messageId, msg?.message, fwdMid), text: String(text).slice(0, quoteCap) };
    } catch {
      return null;
    }
  }

  async function ingestMessage(kind, id, event) {
    const cfgNow = getConfig();
    if (!allowed(kind, id, cfgNow)) return; // 白名单外的聊天完全不记录

    const segments = Array.isArray(event.message) ? event.message : null;
    const senderId = String(event.sender?.user_id ?? event.user_id ?? '');
    const senderName = String(event.sender?.card || event.sender?.nickname || senderId || '');

    // 2026-10-29：**本条消息自己**有没有艾特机器人 —— 只看 at 段，不看拍平后的正文。
    // 为什么必须单独算：合并转发会被展开成正文塞进 text，里面别人的 "@机器人"
    // 也跟着进来了。只用 isAtMe(text) 判的话，禁言期群友随手转发一条含 @ 的聊天记录
    // 就会被当成"被艾特"而开口说话（0.4.9.0 实测反馈）。
    // null = 没有段结构（CQ 字符串入站），下游退回文本判定。
    const selfQq = String(onebot.selfId ?? '').trim();
    const atSelf = segments
      ? segments.some((s) => String(s?.type ?? '') === 'at' && String(s?.data?.qq ?? '') === selfQq)
      : null;

    // 屏蔽名单：被屏蔽群员的消息直接丢弃 —— 不存档、不触发会话、不进提示词背景。
    // 放在最前面：连合并转发展开这种网络请求都不值得为它做。
    // 两道屏蔽：全局（所有群+私聊）优先，其次按群。
    if (senderId) {
      const globalBlocked = isGloballyBlocked(senderId);
      if (globalBlocked) return;
      if (kind === 'group' && (cfgNow.blocklist?.[id] || []).some((x) => String(x) === senderId)) return;
    }
    const media = segments ? extractMediaFromSegments(segments) : [];

    let text;
    if (segments) {
      text = await segmentsToText(segments, {
        resolveReply: (mid) => resolveReply(mid),
        resolveAtName: (qq) => kind === 'group' ? resolveAtName(id, qq) : null,
        // 语音转写（`media.transcribe`）要用它去 get_record 取音频
        onebot
      });
    } else {
      text = String(event.raw_message ?? event.message ?? '').trim();
    }

    // 合并转发：占位符 → 展开真实内容（模型要读懂、看懂转发的聊天记录）
    // ⚠️ 别退回"只传 message_id"（2026-10-21 又踩了一次）：本机协议端（SnowLuma/NapCat）的
    // get_forward_msg 只在 message_id > 0 时才替我们解析 forward 段 id，负数 id
    // （QQ NT 里很常见）会被原样当 res_id 去拉 → "payload is empty"，转发全挂。
    // fetchForwardNodes 会优先用 forward 段自带的 id（等价于协议端内部解析，
    // 不受正负限制），拿不到才退回 message_id。详见 onebot.js 该函数注释。
    // 媒体里的 url 此时是新鲜的，一并收进 media（取图/金句都能用）。
    // 展开失败时占位符留在存档里，模型可用 read_forward 工具稍后重试。
    // ⚠️ 2026-10-21：判据**必须**看"这条消息自己的段里有没有 forward"，不能用
    //    `text.includes('[合并转发')`。引用块现在会把被引用转发的正文就地内联，
    //    于是"引用了一条转发"的普通消息，text 里同样含 `[合并转发 共N条]` ——
    //    用文本判据会让它每次白跑一趟 fetchForwardNodes，再被 NOT_FORWARD 守卫拒掉，
    //    日志里留一句误导性的"展开合并转发失败"（21 日 07:57:08 / 07:59:38 实证）。
    const hasOwnForward = Array.isArray(segments)
      && segments.some((s) => String(s?.type ?? '') === 'forward');
    if (hasOwnForward && event.message_id != null) {
      try {
        const nodes = await fetchForwardNodes(onebot, event.message_id, segments);
        const ex = await expandForwardNodes(nodes);
        if (ex && ex.text) {
          text = ex.text;
          if (ex.media?.length) media.push(...ex.media);
        }
      } catch (e) {
        // ⚠️ 2026-10-21：这里原先只有一句笼统的"展开合并转发失败"，把两类完全不同的
        //    故障混成了一条日志，排查时指不到真原因。实测两类：
        //    ① NOT_FORWARD —— 我们自己的判据问题（已在上面用 hasOwnForward 修掉，
        //       现在走到这里基本不可能；留着分支是为了万一复发能一眼认出来）；
        //    ② retcode=100 / "payload is empty" —— **上游协议端拿不到长消息内容**。
        //       合并转发的长消息在服务器侧有保留期，过期或无权读取就返回空载荷
        //       （协议端侧 SsoRecvLongMsg 的 result.payload 为空，我们改不动）。
        //       这类失败重试也没用，话术要让用户知道"是这条转发读不了"，而不是"程序坏了"。
        const errMsg = String(e?.message ?? e);
        if (e?.code === 'NOT_FORWARD') {
          log(`[ingest] 展开合并转发被跳过（判据判定为非转发，属预期）: ${errMsg}`);
        } else if (e?.retcode === 100 || /payload is empty/i.test(errMsg)) {
          log(`[ingest] 合并转发内容读不到（协议端返回空载荷：该转发可能已过期或当前账号无权读取）: ${errMsg}`);
        } else {
          log(`[ingest] 展开合并转发失败（保留占位符）: ${errMsg}`);
        }
      }
    }

    if (!text && !media.length) return;

    // ── 图片入库缓存 ──
    // QQ(NTQQ) 的图片下载链接带 rkey 签名，**几分钟内就失效**（实测入库 48 秒后
    // get_message_images 去下载就 400，官方错误体 "download url has expired"）——
    // 模型只能回"这张读不出来"。入库这一刻 url 是新鲜的，所以在这里就地排队下载
    // （image-cache.js 后台串行，不阻塞 ingest），看图工具优先读本地缓存。
    if (media.length) {
      try { cacheIncomingImages(`${kind}:${id}`, event.message_id, media); } catch { /* 缓存失败不影响入库 */ }
    }

    // ── 指令禁言：群内任何人 @机器人 + 发送指定指令 → 该群暂时固定 1 档（仅艾特）──
    // 在存档前处理：指令本身也要留档（让机器人知道被禁言了），但先设置禁言状态。
    if (kind === 'group') {
      maybeTriggerCommandMute(id, text, event, atSelf);
    }

    store.appendIncoming(`${kind}:${id}`, {
      mid: event.message_id,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      text: text || '[图片]' ,
      media,
      atSelf
    });
    // 「收到消息」事件点（onMessage 钩子）：**每条**消息都经过这里 ——
    // 确定性扩展（反撤回缓存、开发工单的「开发 xxx」识别）不能依赖"参与度判定放行"
    // 这个不确定条件（2026-10-08：这条调用原先缺失 —— 反撤回的 onMessage 一直在空转，
    // 开发工单的指令也只有在"恰好被唤醒"时才可能被看见）。
    // send：把"话筒"递给插件（开发模式的回信直接走统一发送队列：限频/去重/切分/留档）。
    try {
      await skillManager.runHook('onMessage', {
        event,
        chatKey: `${kind}:${id}`,
        senderId,
        senderName,
        text: text || '',
        // 契约字段（CORE-PATCH.md）：onebot/sender/store/log/sendSegments —— 与 onRecall 同款。
        onebot,
        sender,
        store,
        log,
        sendSegments: (k, id2, segs) => onebot.sendSegments(k, id2, segs),
        // opts 可选透传（如 { dedupe: false }）—— 给"进度提示"这类本就该重复的内容用。
        // 不传时行为与以前完全一致（走默认去重）。
        send: (messages, opts) => sender.sendTextBatch(`${kind}:${id}`, Array.isArray(messages) ? messages : [String(messages)], opts || {})
      });
    } catch { /* 单个钩子出错由管理器隔离并记日志，这里不阻断 ingest */ }
    // ── 开发模式让路：由 dev-orders 提供 dev.route 能力表态 ──
    // 这条消息若已被开发会话接走（白名单 + 开发模式中），普通人格不再插嘴：
    // 标记已读（与"不响应"路径同款）、只广播 chat-update（消息照常留档、UI 可见）。
    let handledByDev = false;
    try {
      const ck = `${kind}:${id}`;
      const provs = skillManager.getCapabilityProviders('dev.route', { chatKey: ck, senderId });
      for (const p of provs) {
        try {
          if (p?.fn?.({ chatKey: ck, senderId, senderName, text: text || '', mid: event.message_id })?.handled === true) {
            handledByDev = true;
            break;
          }
        } catch { /* 单个 provider 出错不影响其它 */ }
      }
    } catch { /* 没装插件就无感 */ }
    if (handledByDev) {
      store.markAllRead(`${kind}:${id}`);
      emit('chat-update', `${kind}:${id}`);
      return;
    }
    emit('chat-update', `${kind}:${id}`);
    orchestrator.onIncoming(`${kind}:${id}`);

    // 链接媒体转发（确定性）：刻意不 await —— 百兆级下载/上传不能卡住 ingest 热路径。
    // 内部已把错误全部收口（含 provider 抛错），这里再挂一次 catch 只为防漏网。
    forwardLinkedMedia(kind, id, text).catch((e) => log(`[media] 链接转发失败：${e?.message ?? e}`));
  }

  /**
   * 指令禁言：检测"@机器人 + 指定指令"，命中则把该群响应档位暂时固定为 1 档。
   * 禁言状态写入 config.commandMute.active[群号] = 到期时间戳（0 = 直到手动解除）。
   */
  function maybeTriggerCommandMute(groupId, text, event, atSelf = null) {
    const cm = getConfig().commandMute;
    // ⚠️ 2026-10-29：默认值必须是**开**（=== false 才关）。
    //    原来写的是 `cm.enabled !== true`，而前端保存时缺省是 true、老配置里
    //    根本没有 enabled 字段 —— 结果这些机器上禁言指令**永久失效**，
    //    控制台也看不出来（开关显示是开的）。这正是"偶尔失效"的主要来源。
    if (!cm || cm.enabled === false) return;
    const command = String(cm.command || '').trim();
    if (!command) return;
    // 必须同条消息里既 @机器人 又含指令。
    // ⚠️ atSelf 是入库时按 **at 段** 判出来的真值（见 ingestMessage）：合并转发的
    //    正文里别人的 @ 不算数。只有拿不到段结构（atSelf === null）才退回文本判定。
    const atMe = atSelf === true || (atSelf === null && isAtMe(text, {
      selfId: onebot.selfId,
      botName: getConfig().persona?.botName || '',
      selfNickname: getConfig().persona?.selfNickname || onebot.selfNickname || ''
    }));
    if (!atMe) return;
    if (!text.includes(command)) return;
    // 设置禁言：durationMin>0 则到期时间戳，否则 0（直到手动解除）
    const durationMs = Math.max(0, Number(cm.durationMin) || 0) * 60000;
    const until = durationMs > 0 ? Date.now() + durationMs : 0;
    // 2026-10-17（报告3 M4）：改走 updateConfig 的**函数式入口** —— 读当前 active
    // 与写回同一个同步块，结构上不可能被并发的另一次禁言/解禁覆盖。
    // （原写法读 getConfig() 与 updateConfig() 之间也没有 await，本就不竞态；
    //   换成函数式入口是为了让"原子"由接口保证，而不是靠调用点的写法。）
    updateConfig((cfg) => ({
      commandMute: { active: { __replace__: { ...(cfg.commandMute?.active || {}), [String(groupId)]: until } } }
    }));
    const untilStr = until ? new Date(until).toLocaleTimeString('zh-CN', { hour12: false }) : '直到手动解除';
    log(`[指令禁言] 群 ${groupId} 已被「${command}」禁言，响应档位临时固定为 1 档（仅艾特），${untilStr} 解除`);
    emit('chat-update', `group:${groupId}`);
  }

  // ── 链接媒体转发（确定性触发） ──────────────────────────────────────────

  /**
   * 确定性触发：消息里出现 B站/抖音链接 → 下载并转发。
   *
   * 与 LLM 型（注册工具）的区别正在这里：插件开着，条件满足就一定会跑，
   * 模型想忽略也忽略不掉 —— 整条链路上没有任何"让模型决定"的环节。
   *
   * 一个提供者都不在（插件未装/未启用）时立刻返回 —— 零网络请求、零副作用。
   * 调度细节（候选链接提取、多提供者协商、失败文案）在 src/media-links.js，
   * 那部分是纯逻辑、可被测试直接驱动；这里只负责从 skillManager 取提供者。
   */
  async function forwardLinkedMedia(kind, id, text) {
    const providers = skillManager.getCapabilityProviders('media.download');
    if (!providers.length) return;
    // 调度逻辑可被启动组合替换（0.4.9.2，键名 core.media.forward）；缺省用原实现。
    await (components['core.media.forward'] ?? dispatchMediaLinks)({
      urls: extractCandidateUrls(text),
      providers,
      ctx: { onebot, sender, kind, chatId: id, text },
      log
    });
  }

  async function ingestPoke(event) {    // OneBot v11: notice_type=notify, sub_type=poke；群拍 target_id，私聊拍自己
    const isGroup = event.group_id != null;
    const id = isGroup ? String(event.group_id) : String(event.user_id);
    const cfgNow = getConfig();
    if (!allowed(isGroup ? 'group' : 'private', id, cfgNow)) return;

    const operatorId = String(event.user_id ?? '');
    // 自己拍的拍（send_poke 的 OneBot 回显）不触发处理——与 message_sent 同理，发送时已留档
    // ⚠️ 2026-10-16：判定用**事件自带的 self_id**（优先），回落到 onebot.selfId。
    // 存档实证（2026-10-15）：onebot.selfId 曾不等于机器人真实 QQ（get_login_info
    // 在协议端慢启动/切号期间拿到的是别的账号或空值）—— 后果是双向的：
    //   ① 真被拍时文案写成"X 拍了拍 机器人名"而不是"我"，拍一拍召唤识别不到；
    //   ② 若 selfId 恰好是群里某个普通成员的 QQ，**群友拍那个人时文案变成
    //      "X 拍了拍 我"**，机器人误以为在拍自己、按 1 档响应 —— 用户反馈的
    //     "拍别人时机器人总会认为在拍自己"。self_id 是每条事件自带的真值，
    //     不依赖连接期的全局查询，才是"这次是谁的视角"的权威来源。
    const evSelfId = String(event.self_id ?? '') || onebot.selfId;
    if (operatorId && operatorId === evSelfId) return;
    // 屏蔽名单对拍一拍同样生效（操作者是被屏蔽群员则丢弃）：全局优先，其次按群
    if (operatorId) {
      if (isGloballyBlocked(operatorId)) return;
      if (isGroup && (cfgNow.blocklist?.[id] || []).some((x) => String(x) === operatorId)) return;
    }
    const targetId = String(event.target_id ?? event.user_id ?? '');
    const selfId = evSelfId;
    // 拍一拍也要记下真实群名片：原先这里硬编码"（拍一拍事件）"，
    // 会覆盖同一 QQ 在普通消息里的真实昵称 —— 记忆整理时取名字会拿到这个占位符，
    // 导致"某群友的名字叫（拍一拍事件）"这种脏数据。
    const chatKeyNow = `${isGroup ? 'group' : 'private'}:${id}`;
    let operatorName = isGroup ? ((await resolveAtName(id, operatorId)) || '') : '';
    if (!operatorName) {
      const prior = (store.recent(chatKeyNow, { limit: 500 }) || [])
        .find((m) => !m.self && String(m.senderId) === operatorId
          && String(m.senderName || '') && String(m.senderName) !== '（拍一拍事件）');
      operatorName = prior ? String(prior.senderName) : operatorId;
    }
    // 目标名字同样补齐（被拍者的群名片；解析不到就留 QQ 号，formatEntry 会拼 (QQ:xxx)）
    const targetName = (isGroup && String(targetId) !== String(selfId))
      ? ((await resolveAtName(id, targetId)) || targetId)
      : targetId;
    // 展示名：管理员备注 > 群名片（与消息历史同口径）
    const notes = cfgNow.memberNotes || {};
    const opLabel = notes[operatorId] || operatorName || operatorId;
    // 私聊里"用户拍机器人"没有 target_id 时回落 user_id（= 操作者），文案会变成
    // "拍了拍自己" —— 1v1 场景下能收到的拍一拍只可能是拍机器人，直接按"拍我"处理。
    const pokeSelf = isGroup ? String(targetId) === String(selfId) : true;
    const tgtLabel = pokeSelf
      ? '我'
      : (notes[targetId] || targetName || targetId);
    // 文案统一为「X 拍了拍 Y」视角（机器人被拍时 Y=我）。
    // 旧文案"你拍了拍（来自 张三）"视角混乱（读起来像"我拍了别人"），
    // 是机器人被拍时识别错乱的主因。名字带 QQ 号，与发言人标签同口径。
    const opWithId = String(operatorId) ? `${opLabel}(QQ:${operatorId})` : opLabel;
    const tgtWithId = (pokeSelf || !String(targetId)) ? tgtLabel : `${tgtLabel}(QQ:${targetId})`;
    // 群内"自己拍自己"（target_id 缺失回落成操作者，或真的自拍）→ "拍了拍自己"；
    // 私聊没有群自拍语义 —— 缺 target_id 时回落值就是操作者，但 1v1 里能收到的
    // 拍一拍只可能是拍机器人，走"拍了拍 我"分支（pokeSelf 已置 true）。
    const text = (operatorId === targetId && isGroup)
      ? `[拍一拍] ${opWithId} 拍了拍自己`
      : `[拍一拍] ${opWithId} 拍了拍 ${tgtWithId}`;
    // 拍一拍是"轻量召唤"信号：作为触发批发给模型（isPoke 标记让档位判定
    // 按 1 档响应），但**不进【过去状态】历史**——buildPastState 会跳过 isPoke，
    // 存档里只留一条轻量记录（聊天记录页仍可见，模型历史里不出现）。
    // ⚠️ 2026-10-16：同时落 pokeSelf 真值标记 —— 档位判定（"是不是拍我"）从此
    // 不靠正则猜文本（被拍者名字以"我"开头时会误判），以入库时的身份判定为准。
    store.appendIncoming(chatKeyNow, {
      mid: null,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId: operatorId,
      senderName: operatorName,
      text,
      media: [],
      isPoke: true,
      pokeSelf
    });
    emit('chat-update', `${isGroup ? 'group' : 'private'}:${id}`);
    orchestrator.onIncoming(`${isGroup ? 'group' : 'private'}:${id}`);
  }

  async function handleOneBotEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.post_type === 'message' || event.post_type === 'message_sent') {
      // 自己发的消息（message_sent / self_id 相同）不触发处理（发送时已自行记录）
      // ⚠️ 2026-10-16：判定优先用事件自带的 self_id（每条事件的权威"这是谁的
      // 视角"），回落到 onebot.selfId —— 后者来自连接时的 get_login_info，
      // 在协议端慢启动/切号期间可能为空或指向别的账号，用错时机器人的
      // 发言会被当群友消息入库、真群友的消息反被丢弃（与拍一拍同一根因）。
      const evSelfId = String(event.self_id ?? '') || onebot.selfId;
      if (String(event.user_id ?? event.sender?.user_id ?? '') === evSelfId) return;
      if (event.message_type === 'group' && event.group_id != null) return ingestMessage('group', String(event.group_id), event);
      if (event.message_type === 'private' && event.user_id != null) return ingestMessage('private', String(event.user_id), event);
      return;
    }
    if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
      return ingestPoke(event);
    }
    // 撤回事件：群撤回 group_recall / 好友撤回 friend_recall
    // 用户撤回的消息，后续会话不再发给大模型（从存档里标记/删除）。
    if (event.post_type === 'notice' && (event.notice_type === 'group_recall' || event.notice_type === 'friend_recall')) {
      return handleRecall(event);
    }
    // 群禁言通知（2026-10-22 F2）：OneBot group_ban —— 机器人自己被禁言/解禁的
    // **权威事件源**。此前这条通知到达 app 后被当"不关心的事件"直接丢弃，
    // ban-state 插件的两条写入来源（协议层通知 / 发送被拒兜底）双双落空，
    // 唯一的查询兜底又被缓存架空 —— 2026-10-22 实测禁言 10 分钟烧 19.5 万 token。
    if (event.post_type === 'notice' && event.notice_type === 'group_ban' && event.group_id != null) {
      return handleGroupBan(event);
    }
    // 未识别的 notice / request：记一条 debug 落盘（默认级别 info 过滤掉，零噪音；
    // 排障时把日志级别调到 debug 就能看见）。**静默丢弃是这次排查最大的障碍** ——
    // group_ban 被丢了一年都没人发现，同类 bug（通知到了、没人处理、无痕迹）
    // 从此在日志里可见。meta_event（心跳）除外，那条没有排查价值。
    if ((event.post_type === 'notice' || event.post_type === 'request') && event.post_type !== 'meta_event') {
      logger.debug('app',
        `未处理的事件：post_type=${event.post_type}`
        + ` notice_type=${event.notice_type ?? '-'} sub_type=${event.sub_type ?? '-'}`
        + ` group_id=${event.group_id ?? '-'} user_id=${event.user_id ?? '-'}`);
    }
    // meta/心跳等事件忽略
  }

  /**
   * 处理群禁言通知（OneBot v11: notice_type=group_ban）。
   *
   * 协议端（SnowLuma）的转换口径（to-notice.ts convertGroupMute）：
   *   sub_type = duration > 0 ? 'ban' : 'lift_ban'，duration 为禁言秒数。
   *   注意 OneBot v11 原语义里「ban 且 duration=0」也是解禁，一并按解禁处理。
   *
   * 只认 **user_id === self_id** 的通知 —— 群友被禁言与机器人无关，
   * 误把自己标成禁言会让整个群停止回复（2026-10-22 报告 P0 级风险）。
   * self_id 用事件自带值优先，回落 onebot.selfId（与 message / poke 同口径，
   * 慢启动/切号期间 get_login_info 可能为空或指向别的账号）。
   */
  function handleGroupBan(event) {
    const evSelfId = String(event.self_id ?? '') || onebot.selfId;
    const userId = String(event.user_id ?? '');
    if (userId && userId !== evSelfId) {
      logger.debug('app', `群 ${event.group_id} 的禁言通知与机器人无关（user_id=${userId}），忽略`);
      return;
    }
    const chatKey = `group:${String(event.group_id)}`;
    const duration = Number(event.duration) || 0;
    const isBan = event.sub_type === 'ban' && duration > 0;
    try {
      if (isBan) {
        noteMuted(chatKey, duration);
        logger.info('app', `群 ${event.group_id} 机器人被禁言 ${duration} 秒，已记录禁言状态（期间跳过处理）`);
      } else {
        noteUnmuted(chatKey);
        logger.info('app', `群 ${event.group_id} 机器人禁言解除，已恢复正常处理`);
      }
    } catch (error) {
      // ban-state 插件缺失/坏了不该影响事件处理本身（查询兜底仍在）
      logger.warn('app', `禁言状态写入失败（${chatKey}）：${error?.message ?? error}`);
    }
  }

  /** 处理消息撤回：把对应 mid 的存档消息标记为已撤回（后续提示词过滤掉）。 */
  function handleRecall(event) {
    const isGroup = event.notice_type === 'group_recall';
    const chatKey = isGroup ? `group:${String(event.group_id)}` : `private:${String(event.user_id)}`;
    const mid = event.message_id;
    if (mid == null) return;
    const marked = store.markRecalled(chatKey, mid);
    if (marked) {
      log(`[撤回] ${chatKey} 消息 #${mid} 已被撤回，后续不再发给模型`);
      emit('chat-update', chatKey);
    }
    // onRecall 钩子：反撤回插件在这里把撤回的消息原文重发回群（2026-10-08 补的触发点）。
    // 无论 store 里有没有标记成功都要发 —— 插件的缓存与 store 是两套记录。
    // ⚠️ ctx 必须带齐 onebot/sender/store/log/sendSegments（2026-10-08 修）：
    //   之前只传了 { chatKey, mid, event }，而 runHook 原样透传 ctx，于是
    //   anti-recall 的 sendSegmentsSafe 三级回退全落空（ctx.onebot.call 抛
    //   TypeError 被 catch 吞掉）→ 撤回时机器人毫无反应。见 CORE-PATCH.md 的契约。
    //   段发送用 onebot.sendSegments —— SendQueue **没有**同名方法（只有
    //   sendMedia/sendTextBatch），按 CORE-PATCH 原文写 sender.sendSegments 会 undefined。
    try {
      skillManager.runHook('onRecall', {
        event, chatKey, mid, onebot, sender, store, log,
        sendSegments: (kind, id2, segs) => onebot.sendSegments(kind, id2, segs)
      }).catch(() => {});
    } catch { /* ignore */ }
  }

  // ── HTTP API ──
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      log('[http] 处理出错:', error?.message ?? error);
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      } catch { /* ignore */ }
    });
  });

  function json(res, code, data) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  // ── 请求体读取 ──────────────────────────────────────────────────────────
  // 抛出的错误必须是**可暴露的 HTTP 错误**（带 .expose 标记），由 /api 分发层
  // 统一转成 4xx。否则：JSON.parse 异常会冒成 500；"超限直接 throw" 会让没读完的
  // socket 变脏 —— 客户端连接池下次复用这条连接就是 ECONNRESET。
  const MAX_BODY_BYTES = 2 * 1024 * 1024;
  const HARD_BODY_LIMIT = 16 * 1024 * 1024;   // 超此值不再排空，直接断链
  function httpError(status, message) {
    const e = new Error(message);
    e.expose = true;
    e.status = status;
    return e;
  }

  async function readBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > HARD_BODY_LIMIT) {
        req.destroy();
        throw httpError(413, '请求体过大');
      }
      if (size > maxBytes) {
        tooLarge = true;          // 继续读干净（内容丢弃），保证连接可复用
        chunks.length = 0;
        continue;
      }
      chunks.push(chunk);
    }
    if (tooLarge) throw httpError(413, `请求体过大（上限 ${Math.round(maxBytes / 1024)}KB）`);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw httpError(400, '请求体不是合法 JSON');
    }
  }

  // ── 来源校验（CSRF / DNS rebinding 防护）────────────────────────────────
  // 服务只监听回环，但**浏览器里的任意网页都能向 127.0.0.1 发简单请求**，
  // 而 CORS 只挡"读响应"、挡不住"副作用"（改配置、暂停、重置数据…）。
  // 所以所有 /api/* 都必须来自回环 Host；带 Origin/Referer 时必须同源。
  function isLoopbackHostHeader(host) {
    return /^127\.0\.0\.1(:\d+)?$/.test(host)
      || /^localhost(:\d+)?$/.test(host)
      || /^\[::1\](:\d+)?$/.test(host);
  }

  /** 请求是否带了「可归属来源」信息（Origin 或 Referer 或 Sec-Fetch-Site）。 */
  function hasProvenance(req) {
    if (String(req.headers.origin ?? '')) return true;
    if (String(req.headers.referer ?? '')) return true;
    // ⚠️ 2026-10-17 补：**本应用自己把 Referer 掐掉了**。
    //   静态服务器给控制台页面发的是 `referrer-policy: no-referrer`
    //   （见本文件 2818/2863 两处），所以页面里发的同源 fetch **永远不带 Referer**；
    //   而同源 GET 也不带 Origin。于是"页面 fetch 有来源信息"这个前提在这里并不成立
    //   （原注释写的就是这个假设，它已经被同一份代码里的 referrer-policy 推翻了）。
    //   Sec-Fetch-Site 是浏览器强制标注的请求来源类别：页面脚本改不了、不受
    //   referrer-policy 影响、curl 默认也不会发 —— 正好补上"请求确实出自我们自己的页面"。
    //   安全性没有放宽：本机进程本来就能伪造 Referer（伪造 Sec-Fetch-Site 同理），
    //   这里仍要再过 originAllowed() 的回环 Host 校验；密钥端点的强凭据是
    //   keyEndpointAllowed() 里那个进程私有的渲染进程凭据。
    if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'same-origin') return true;
    return false;
  }

  /**
   * @param {boolean} [opts.readOnly] 传入true 时表示这是一个**只读**请求
   *   （GET/HEAD）。无来源信息时，只读请求放行、有副作用的请求拒绝。
   *
   * ⚠️ 2026-10-07 审查修正：原实现对"无来源信息"一律放行，
   *   理由写的是「留空 = 只监听 127.0.0.1」——**这个推理是错的**：
   *   回环绑定只挡远程，**不挡本机上的任何进程**（非管理员即可）。
   *   于是 `curl http://127.0.0.1:3210/api/api-key` 能读走明文主 API Key
   *   （curl 不发 Origin/Referer → 命中最后一行放行），
   *   /api/reset-data（删库）、/api/config（改配置）同理。
   *
   *   现在的规则：无来源信息（curl / 本机脚本 / 地址栏直达）时，
   *   **只有只读请求放行**，任何有副作用的请求（POST/PUT/DELETE/PATCH）
   *   一律拒绝。这样既关掉了本机进程的越权面，
   *   又不影响控制台正常使用 —— 页面里的 fetch 虽然是同源，
   *   但浏览器会带 Referer（有来源信息），走的是上面两条正常校验。
   */
  /**
   * 控制台令牌校验（0.4.9.3）。
   *
   * `?token=` 为外部脚本保留（无头调用方不好加请求头），但它比请求头危险得多：
   * URL 会进浏览器历史、代理日志、以及任何外链的 Referer。所以命中时记一条
   * 一次性警告 —— 不改变行为，只给信号。
   */
  let urlTokenWarned = false;
  function consoleTokenMatches(req, token) {
    if (!token) return false;
    if (req.headers['x-console-token'] === token) return true;
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return false; }
    if (url.searchParams.get('token') !== token) return false;
    if (!urlTokenWarned) {
      urlTokenWarned = true;
      logger.warn('server', '检测到用 ?token= 传控制台令牌：URL 会留在浏览器历史与代理日志里，建议改用 x-console-token 请求头');
    }
    return true;
  }

  function originAllowed(req, opts = {}) {
    const host = String(req.headers.host ?? '');
    if (!isLoopbackHostHeader(host)) return false;
    const origin = String(req.headers.origin ?? '');
    if (origin) {
      try {
        const u = new URL(origin);
        return isLoopbackHostHeader(u.host) && u.host === host;
      } catch { return false; }
    }
    const referer = String(req.headers.referer ?? '');
    if (referer) {
      try { return new URL(referer).host === host; } catch { return false; }
    }
    // 无来源信息（curl / 本机脚本 / 地址栏直达）
    const method = String(req.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return true;
    if (opts.readOnly) return true;
    // 收包人报告（bug 清单 E3，2026-10-27）：配了 server.token 的外部脚本带
    // x-console-token 调 POST，仍被这里 403 —— 注释里写的"两条正路"其实
    // 只通了一条（Origin 同源）。token 本身就是"本机可信进程"的凭据
    // （与 authorize 同口径），值匹配即放行写请求；没配 token 时行为不变。
    try {
      const token = String(getConfig().server?.token ?? '');
      if (token && consoleTokenMatches(req, token)) return true;
      // 渲染进程凭据（主进程 webRequest 注入，每启动随机、不落盘不进 DOM），
      // 桌宠等本机上下文走它 —— 与 keyEndpointAllowed ① 同口径。
      if (rendererAuthToken && req.headers['x-console-token'] === rendererAuthToken) return true;
    } catch { /* URL 解析失败按无凭据处理 */ }
    return false;
  }
  // ── 外部脚本调用口径（收包人报告 P3 问"为什么 POST 全 403"）──────────────
  // 这是上面的**有意设计**（2026-10-07 安全审查：回环绑定挡不住本机其它进程，
  // 无来源的写请求一律拒绝）。脚本要调写接口，三条正路：
  //   1. 带 `Origin: http://127.0.0.1:<实际端口>` 头（回环同源即过；实际端口
  //      看 <DATA_DIR>/console-port，多安装并存时不一定等于 config.server.port）；
  //   2. 配置 server.token 后，外部脚本带 `x-console-token: <token>` 头或 ?token= 参数
  //      （E3 修：值匹配即放行，**不再额外要求 Origin 同源** —— 旧实现两条都要
  //      满足，等于 token 路线永远走不通）；
  //   3. GET/HEAD 只读请求无来源也放行，脚本探测无需任何头。
  // Electron 控制台的随机凭据由主进程通过 webRequest 注入，不暴露到渲染页面。

  function authorize(req) {
    const token = String(getConfig().server?.token ?? '');
    if (!token) return true;
    return consoleTokenMatches(req, token)
      || req.headers['x-console-token'] === rendererAuthToken;
  }

  // ── 配置脱敏 ────────────────────────────────────────────────────────────
  // 凡是字段名命中这些模式的，值一律替换为空串（保留"有/无"的 hasXxx 标记）。
  // 覆盖：apiKey / api_key / accessToken / httpAccessToken / token / secret / password / cookie …
  // ⚠️ cookie 必须在内：media-download 插件的 bilibiliCookie / douyinCookie
  //    是登录凭据，曾经 pattern 不认导致 /api/config 明文返回。
  const SECRET_KEY_PATTERN = /(apikey|api_key|accesstoken|access_token|communitykey|cookie|secret|password|privatekey|private_key)/i;
  // 形如 apiKeyFrom 的字段存的是"密钥来源标识"（如 manual），不是密钥本身，不要脱敏
  const SECRET_KEY_EXCLUDE = /from$/i;

  function sanitizeConfig(cfg) {
    const out = JSON.parse(JSON.stringify(cfg ?? {}));
    const seen = new WeakSet();

    const walk = (node) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object') { walk(value); continue; }
        if (SECRET_KEY_EXCLUDE.test(key)) continue;
        // 已生成的 hasXxx 布尔标记本身也会被 apikey 模式匹配到，
        // 不排除就会连锁生成 hasHasXxx
        if (/^has/i.test(key) && typeof value === 'boolean') continue;
        if (SECRET_KEY_PATTERN.test(key)) {
          // ⚠️ 必须"删除字段"而不是"置为空串"。
          // 前端保存设置时会把整个 config 展开成 patch 回传（...c.webSearch?.deepseek），
          // 若这里留一个空串，deepMerge 会拿空串覆盖掉服务端保存的真 Key ——
          // 表现为：用户点一次"保存设置"，所有搜索 Key 就被静默清空。
          // 删掉字段则展开时不会带上该键，服务端原值得以保留。
          delete node[key];
          const flagName = `has${key.charAt(0).toUpperCase()}${key.slice(1)}`;
          node[flagName] = Boolean(String(value ?? '').trim());
        }
      }
    };
    walk(out);

    // 密钥集合整体清空（不逐 key 暴露存在性）
    if (out.dshProviderKeys && typeof out.dshProviderKeys === 'object') {
      const has = {};
      for (const [k, v] of Object.entries(out.dshProviderKeys)) has[k] = Boolean(String(v ?? '').trim());
      out.dshProviderKeys = {};
      out.dshProviderKeyPresence = has;
    }

    // 提供商列表：删掉 key 字段（同样不能置空串，否则回传时覆盖真实 Key），补 hasKey
    if (Array.isArray(out.providers)) {
      for (const p of out.providers) {
        const real = (cfg?.dshProviderKeys || {})[p.id] || p.apiKey;
        delete p.apiKey;
        p.hasKey = Boolean(String(real ?? '').trim());
      }
    }
    // 顶层 api：walk 已生成 hasApiKey，这里补一个简写的 hasKey 供旧代码读取
    if (out.api) out.api.hasKey = out.api.hasApiKey ?? Boolean(String(cfg?.api?.apiKey ?? '').trim());

    return out;
  }

  // ── 明文密钥端点守卫 ────────────────────────────────────────────────────
  /**
   * 这是本地单机程序，控制台就在本机浏览器打开，「显示密钥」是用户自己的操作，
   * 不该被禁用。真正的风险来自**外部网页**冒用浏览器读 127.0.0.1（CSRF /
   * DNS rebinding）—— 所以防线是「校验请求来源」。
   *
   * ⚠️ 历史实现里有一句 `if (req.headers['x-console-token']) return true`：
   *    只看"有没有这个头"、不看值，等于任何人加个头就能读明文密钥。
   *    已删除 —— 来源校验交由 originAllowed() 统一负责。
   */
  function keyEndpointAllowed(req) {
    // ① 渲染进程凭据：主进程用 webRequest 注入，进程私有（每次启动随机 32 字节）、
    //    不落盘、不进 DOM、不进 preload。这是控制台自己的最强凭据，**必须独立判定**。
    //    ⚠️ 2026-10-17 修（本次 bug 的根因）：这条判断原先被写在下面对 `if (token)` 的
    //    分支里 —— `config.server.token` 为空（默认值，也是 Electron 控制台的常态）时
    //    整段被跳过，于是**最强的凭据从头到尾没被看过一眼**，只能落到 hasProvenance()。
    //    而静态服务器给控制台页面发 referrer-policy: no-referrer，同源 GET 又不带
    //    Origin ⇒ 控制台里所有密钥端点恒 403：协议端「控制台密码」永远是
    //    「读取失败（后端没有应答）」，设置页的「显示 API Key」同理。
    //    修前沙箱实测：带渲染进程凭据的请求 403（见 _luofix/t-verify-keyendpoint.mjs）。
    if (rendererAuthToken && req.headers['x-console-token'] === rendererAuthToken) return true;

    // ② 用户自配的 server.token（给外部脚本用；也可放在 ?token= 上）。
    const token = String(getConfig().server?.token ?? '');
    if (token && consoleTokenMatches(req, token)) return true;
    // ⚠️ 这里**不能**退化成 originAllowed 的"无来源即放行"（见上面 originAllowed 注释）：
    //   明文密钥端点全是只读 GET，若跟着放行，本机任意进程 curl 一下就能读走主 API Key。
    //   也没必要退化 —— ①② 已经覆盖了控制台（渲染进程凭据）和脚本（server.token）两条正路；
    //   剩下的 ③ 只是"没有配置 token、又从浏览器里打开控制台"的兜底。
    //    ⚠️ 2026-10-21 修（体检 F5）：③ 不能默认生效 —— Origin / Referer / Sec-Fetch-Site
    //    都是**客户端可自由设置**的请求头，本机任意进程伪造一个同源 Origin 就能读走
    //    明文凭据（实测：带 `Origin: http://127.0.0.1:<port>` 请求密钥读取端点
    //    返回 200 + 明文）。
    //    ①② 已经覆盖了"控制台"与"脚本"两条正路，这一层没有存在的必要；
    //    外部浏览器要读密钥 → 先配 server.token 带 x-console-token，或显式打开
    //    server.allowBrowserKeyRead（默认 false，自己承担本机其他进程可读的风险）。
    if (getConfig().server?.allowBrowserKeyRead === true) {
      return hasProvenance(req) && originAllowed(req);
    }
    return false;
  }

  /**
   * 提供商对象脱敏：去掉明文 apiKey，只留 hasKey。
   * upsertProvider / addModelsToProvider / removeModelFromProvider 的返回值都带
   * 明文 key（来自 withResolvedKey），不能直接 json 给前端。
   */
  function sanitizeProvider(p) {
    if (!p || typeof p !== 'object') return p;
    const { apiKey, ...rest } = p;
    return { ...rest, apiKey: '', hasKey: Boolean(String(apiKey ?? '').trim()) };
  }

  // 声明式路由表（src/routes.js）：把所有依赖一次性注入。
  // 路由 handler 通过闭包取用这些依赖，handleHttp 只负责匹配分发。
  // 自更新服务（2026-11-12）：一个 createApp 实例一份（job 状态在服务闭包里）。
  // electron/main.js 通过 components['app.quit'] 注入退出钩子，路由层直接读 components。
  const selfUpdate = createSelfUpdateService({ appDir: ROOT, log, getConfig, localVersion, compareSemver });

  const apiRoutes = createRoutes({
    store, memory, sessions, onebot, orchestrator,
    emit, log,
    localVersion, compareSemver, UPDATE_INFO_URL,
    selfUpdate,
    // electron/main.js 注入的进程能力（含 app.quit）——/api/app/quit 靠它触发
    // 真正的退出链路；headless/测试不传时路由会明确告知"手动退出"。
    components,
    sanitizeConfig, keyEndpointAllowed, sanitizeProvider,
    readBody, authorize,
    qqPortableStatus, qqPortableLogs, launchPortableQQ, stopPortableQQ,
    showPortableQQ, setupPortableQQFromLocal,
    visionScan, isPortOpen,
    buildUsageStats, buildUsageBreakdown,
    reloadSkills,
    // 协议端配置探测（连接页「自动读取」/ 首次启动兜底）
    autoFillProtocol, detectProtocol,
    // 协议端进程托管（连接页「无窗口启动」/ 日志面板）
    protocolLauncher,
    // 协议端「一键接入」（连接页注入向导）
    protocolOnboard,
    // 启动组合（0.4.9.3）：console.routes 可追加/覆盖路由表；composition 供 /api/composition 查询
    components,
    composition,
    lifecycle
  });

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    // SSE
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      if (!originAllowed(req)) return json(res, 403, { error: '请求来源不被信任' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write(`event: hello\ndata: {}\n\n`);
      sseClients.add(res);
      // 心跳：半开 TCP（拔网线 / NAT 超时，没有 FIN）不会触发 req 'close'，
      // 少了心跳这些客户端会永久留在 sseClients 里，之后每次 emit 都白写一遍。
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* 下面 error/close 会清理 */ }
      }, 15000);
      heartbeat.unref?.();
      const cleanup = () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      };
      // 异步写错误不会走 try/catch，必须显式兜住，否则会变成 uncaughtException
      res.on('error', cleanup);
      res.on('close', cleanup);
      req.on('close', cleanup);
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      // 来源校验：挡住"恶意网页借浏览器打 127.0.0.1"（CSRF / DNS rebinding）。
      // 必须在 authorize 之后、路由分发之前。
      if (!originAllowed(req)) {
        return json(res, 403, { error: '请求来源不被信任（仅接受本机控制台的同源请求）' });
      }
      const method = req.method;

      // 桌宠接口：必须留在上面 authorize + originAllowed 之后 —— 它复用控制台
      // 鉴权与同源口径，屏幕截图只进桌面上下文，不额外开口子。
      if (pathname.startsWith('/api/desktop-pet/')) {
        try {
          await handleDesktopPetRequest({ req, res, url, readBody, json, desktopHost: desktopPetHost, emit });
        } catch (error) {
          log('[desktop-pet] API 处理失败：', error?.message ?? error);
          if (!res.headersSent) json(res, error?.status || error?.statusCode || 500, { ok: false, error: String(error?.message || '桌宠操作失败') });
          else if (!res.writableEnded) res.end();
        }
        return;
      }

      // 声明式路由分发（路由表在 src/routes.js）
      try {
        for (const route of apiRoutes) {
          if (route.method !== '*' && route.method !== method) continue;
          let match = null;
          if (typeof route.pattern === 'string') {
            if (route.pattern !== pathname) continue;
          } else {
            match = route.pattern.exec(pathname);
            if (!match) continue;
          }
          return await route.handler({ req, res, url, pathname, method, match, json });
        }
      } catch (error) {
        // readBody 等抛出的"可暴露错误"统一转 4xx；其余记日志、返回 500 而不是让连接挂掉
        if (error?.expose && Number.isInteger(error.status)) {
          return json(res, error.status, { error: String(error.message || '请求无效') });
        }
        log(`[api] ${method} ${pathname} 处理失败：${error?.stack ?? error?.message ?? error}`);
        return json(res, 500, { error: '服务器内部错误' });
      }
      return json(res, 404, { error: `未知 API：${method} ${pathname}` });
    }


    // 静态 UI
    if (req.method === 'GET') {
      // 路径穿越防护：
      // 旧实现 file.replace(/\.\./g,'') 只删字面 ".." —— "/....//" 删完仍还原出 ".."，
      // 且 startsWith 校验在 path.join 之后做（顺序颠倒），形同虚设。
      // 正确做法：先 URL 解码 → 规范化 → 拼接 → 用 path.relative 判断跳出界。
      let decoded;
      try {
        decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
      // 去掉前导斜杠后按 / 与 \ 切段，逐段校验
      const segs = decoded.replace(/^([/\\])+/, '').split(/[/\\]+/);
      // 逐段过滤：拒绝空段、"."、".."、以及任何含控制字符的段
      let blocked = false;
      const clean = [];
      for (const seg of segs) {
        if (seg === '' || seg === '.') continue;      // 空段/当前目录，忽略
        if (seg === '..') { blocked = true; break; }  // 任何 .. 直接拒绝，不做消解
        if (/[\x00-\x1f]/.test(seg)) { blocked = true; break; }
        clean.push(seg);
      }
      if (blocked || clean.length === 0) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      // ── 插件自带页面：/plugin-panel/<id>/…（只读）───────────────────────
      // 这是"插件能在控制台里放自己界面"的唯一出口。完整契约见 src/skills/panel.js；
      // 插件在 plugin.json 的 configSchema 里声明 { type: 'action', panel: 'panel/x.html' }，
      // 加载时被规范成 manifest.panels（含校验好的 URL），设置弹窗据此渲染按钮。
      //
      // 两个根，都**只读**：
      //   /plugin-panel/<id>/…        → <APP_ROOT>/plugins/<id>/… 或 <APP_ROOT>/skills/<id>/…
      //   /plugin-panel/<id>/@data/…  → <DATA_DIR>/plugin-data/<id>/…
      // 后者是插件运行时数据的出口：api.storage 写进去的东西，页面 fetch 出来用。
      // 没有它，插件想给页面喂数据就只能塞一份静态副本，每次变化都要重新生成。
      //
      // 安全（五道）：
      //   ① 来源校验：只有本机控制台同源 / 无来源的 GET 能过（同 /api 的口径）。
      //      ⚠️ 与 /ui 的静态分支不同 —— 那边是应用自身资源，这里可能带插件运行时数据，
      //         不能让"恶意网页借浏览器读 127.0.0.1"顺手读走。
      //   ② id 只允许 [A-Za-z0-9._-] 且必须真实存在于 plugins/ 或 skills/ 下。
      //      上面已按 / \ 切过段，所以 id 里不可能带路径分隔符。
      //   ③ 其余段沿用同一套校验（拒 .. / 控制字符）。
      //   ④ 扩展名白名单（PANEL_FILE_TYPES）：不做通用文件下载器。
      //   ⑤ realpath 二次确认 —— 挡符号链接/目录联接指向目录外，这是 path.relative 挡不住的。
      if (clean[0] === PANEL_ROUTE_PREFIX.slice(1) && clean.length >= 3) {
        if (!originAllowed(req)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }
        const panelId = clean[1];
        const rest = clean.slice(2);
        const fromData = rest[0] === PANEL_DATA_SEGMENT;
        if (fromData) rest.shift();
        const idOk = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(panelId);
        let root = null;
        if (idOk && rest.length) {
          if (fromData) {
            root = path.join(DATA_DIR, 'plugin-data', panelId);
          } else {
            for (const base of [PLUGINS_DIR, SKILLS_DIR]) {
              const cand = path.join(base, panelId);
              try { if (fs.statSync(cand).isDirectory()) { root = cand; break; } } catch { /* 试下一个 */ }
            }
          }
        }
        // realpath 一把过：既确认存在，又消掉符号链接
        let realRoot = null;
        let realFile = null;
        if (root) {
          try {
            realRoot = fs.realpathSync(root);
            realFile = fs.realpathSync(path.join(root, ...rest));
          } catch { /* 不存在 → 走下面 404 */ }
        }
        const inside = Boolean(realRoot && realFile)
          && (realFile === realRoot || realFile.startsWith(realRoot + path.sep));
        const panelType = inside ? PANEL_FILE_TYPES[path.extname(realFile).toLowerCase()] : null;
        if (!panelType) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }
        try {
          const data = fs.readFileSync(realFile);
          const headers = { 'content-type': panelType, 'cache-control': 'no-cache' };
          if (panelType.startsWith('text/html')) {
            // CSP 由 panelCsp() 统一给出（见 src/skills/panel.js 的注释：
            // script-src 'self' 禁内联脚本、frame-ancestors 'self' 允许被设置弹窗嵌）。
            headers['content-security-policy'] = panelCsp();
            headers['x-content-type-options'] = 'nosniff';
            headers['referrer-policy'] = 'no-referrer';
          }
          res.writeHead(200, headers);
          res.end(data);
          return;
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }
      }

      const fullPath = path.join(UI_DIR, ...clean);
      // 二次校验：解析后的路径必须仍在 UI_DIR 内
      const relCheck = path.relative(UI_DIR, fullPath);
      if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      try {
        const data = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };
        const headers = { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' };
        if (ext === '.html') {
          // CSP 用 HTTP 头再声明一次：header 里的 frame-ancestors 才生效
          // （meta 版本会被浏览器忽略该指令），同时给不解析 meta 的场景兜底。
          // ⚠️ 口径必须与 index.html 的 meta 版本**逐条一致** —— 双份 CSP 是
          //    取交集执行的：2026-10-17 人机验证接入时只改了 meta、漏了这份头，
          //    script-src 少了 kondius.cn，结果 SDK 脚本被头拦死，滑块永远
          //    "加载失败"（界面出现脚本错误 toast 就是它）。改 meta 时务必同步这里。
          headers['content-security-policy'] = [
            "default-src 'self'",
            // 桌宠页（/desktop-pet/pet.html）要跑 Live2D：Cubism Core 是 WebAssembly，
            // 必须放行 wasm-unsafe-eval。**只对这一个路径**开口子 —— 注意它不等于
            // JavaScript 的 'unsafe-eval'（那条仍然全线禁止，PixiJS 用随包的
            // unsafe-eval 替代实现绕开 eval，见 ui/desktop-pet/vendor/）。
            clean.join('/') === 'desktop-pet/pet.html'
              ? "script-src 'self' 'wasm-unsafe-eval'"
              : "script-src 'self' https://kondius.cn https://o.alicdn.com",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: http: https:",
            "media-src 'self' data: blob:",
            "connect-src 'self' https://kondius.cn",
            "font-src 'self' data:",
            // ⚠️ 'self' 不能省（2026-10-18）：插件自带页面（表情库 viewer.html 等）
            //    是同源 http://127.0.0.1:port/plugin-panel/... 的 iframe，只写 https:
            //    会让「查看收藏的表情」等入口直接 ERR_BLOCKED_BY_CSP。
            //    与 ui/index.html 的 meta 版本必须逐条一致（双份 CSP 取交集）。
            "frame-src 'self' https:",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'"
          ].join('; ');
          headers['x-content-type-options'] = 'nosniff';
          headers['referrer-policy'] = 'no-referrer';
        }
        res.writeHead(200, headers);
        res.end(data);
        return;
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    res.writeHead(404);
    res.end();
  }

  // ── 启停 ──
  // DSH 自动导入已移除：模型目录改为在设置页手动维护（见 /api/providers 相关接口）。

  // ── 启停 ──
  async function listenOn(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      // R112：localhost 长连接下 Node 默认 keepAliveTimeout(5s) 比 Chromium 空闲
      // socket 复用窗口短 —— 服务端先关了 socket，渲染进程还拿它复用，触发
      // ERR_CONNECTION_RESET，前端表现为"Failed to fetch"（curl 是新连接不受影响）。
      // 这正是"长期运行后用量页/会话列表反复卡加载"的根因。把服务端保活时间抬到
      // Chromium 空闲超时之上，避免"服务端已关、客户端还在用"的半死 socket。
      server.keepAliveTimeout = 61000;
      server.headersTimeout = 65000;
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        // 0.4.9.3：回环绑定挡不住本机其它程序。没配 server.token 时，
        // 任何进程都能调写接口（发消息、改配置、读聊天记录）。这里只告警，
        // 不擅自自动生成 —— 那会让已有外部脚本突然 401/403。
        if (!String(getConfig().server?.token ?? '')) {
          logger.warn('server', `控制台未设置 server.token：本机任意进程均可调用 127.0.0.1:${port} 的写接口，建议在设置页配置一个`);
        }
        resolve(port); // 必须把实际端口传回去，Electron 壳要用它加载页面
      });
    });
  }

  async function start() {
    // ── 版本迁移（必须排在插件扫描之前）──────────────────────────────────
    // 为什么排第一：老用户升级后，旧版被删掉的插件目录可能还在（免安装覆盖路径
    // 只写新文件、不删旧文件），而 config.trustedPlugins 里指向它的引用也还在
    // —— 信任闸按目录名直接放行，残留插件就会照常加载、与新插件抢同名能力。
    // reloadSkills 读的正是这份 trustedPlugins，晚一步处理等于白做。
    // 同步、开销极小（几次 stat，最多写一次 config）；内部已逐项隔离失败。
    try {
      runUpgrades({ log });
    } catch (error) {
      log(`[upgrade] ⚠️ 迁移流程异常（不影响启动）：${error?.message ?? error}`);
    }

    // ── 启动顺序（2026-09-18 按耗时画像重排）────────────────────────────
    // 旧顺序的瓶颈：HTTP → 遥测 → Skill加载(串行import) → 协议端启动(最长20s等端口)
    //              → OneBot连接 → 就绪。Skill 与协议端互不依赖却串行，
    //             白白把两段等待加在一起。协议端改由用户自行运行后，启动路径只余
    //             HTTP → 遥测 → Skill 加载 → OneBot 连接。会话索引的磁盘对账
    //             （reconcileInBackground）
    //         在 HTTP 起来后就排上，不占启动关键路径。
    const basePort = Number(getConfig().server?.port) || 3210;
    // ── 粘性端口（2026-10-27，群友反馈"重启后壁纸消失"的根因之一）──────────
    // 控制台页面 origin = http://127.0.0.1:<实际端口>，渲染进程的 localStorage
    // （壁纸选择、界面本地状态）按 origin 隔离 —— 端口从 3210 漂到 3211 的那次
    // 启动，localStorage 就是全新的空库，壁纸选择随之"消失"。
    // 所以优先复用**上次实际监听**的端口（console-port 落盘值）：它背后挂着
    // 用户全部的界面本地状态。basePort 空闲时也不例外 —— 状态稳定比端口号
    // "归位"重要。（上次端口被占/没落过盘，才退回 basePort 起步的逐个试听。）
    let lastPort = 0;
    try { lastPort = Number(fs.readFileSync(path.join(DATA_DIR, 'console-port'), 'utf8').trim()) || 0; } catch { /* 首次启动/文件坏 */ }
    const portCandidates = [];
    if (lastPort >= 1024 && lastPort <= 65535) portCandidates.push(lastPort);
    for (let p = basePort; p < basePort + 10; p++) portCandidates.push(p);
    let port = null;
    let lastError = null;
    for (const p of [...new Set(portCandidates)]) {
      try {
        port = await listenOn(p);
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== 'EADDRINUSE') throw error;
      }
    }
    if (port == null) throw lastError ?? new Error('无法监听端口');

    // 实际端口落盘（收包人报告 P4）：多安装并存时 basePort 起步逐个 +10 试听，
    // 实际端口往往 ≠ config.server.port（配置里写 3210、实际在 3211）——
    // 外部脚本/运维无从得知。写到 <DATA_DIR>/console-port（一行数字），
    // 每次启动覆盖；故意**不**在退出时删除 —— 应用没起时脚本还能读到
    // "上次端口"作为猜测起点，比没有强。
    try {
      fs.writeFileSync(path.join(DATA_DIR, 'console-port'), String(port), 'utf8');
      log(`[api] 控制台实际端口 ${port} 已写入 ${path.join(DATA_DIR, 'console-port')}`);
    } catch (e) { log(`[api] ⚠️ 端口落盘失败（不影响使用）：${e?.message ?? e}`); }

    // 匿名用量遥测：启动 90 秒后发第一次，之后每 6 小时一次；失败静默不影响使用
    startTelemetryLoop(log);

    // 会话索引后台对账：启动读的是毫秒级缓存，这里异步补扫磁盘修正差异
    // （缓存缺失的新文件/外部删除的文件）。不 await —— 不挡任何启动步骤。
    sessions.reconcileInBackground();

    // 用量档案预热：首次打开用量页的卡顿来自"冷 parse 全部会话文件"
    //（2290 个 / 178MB 实测 1.3~1.9 秒）。启动后台先预热一次（collectUsageRows
    // 内部分片让步，不阻塞事件循环），用户点开用量页时档案已就绪，
    // 只剩窗口过滤（毫秒级）。不 await；失败静默（用量页会自己再算）。
    collectUsageRows({ range: '7' }).catch(() => {});

    const skillsReady = (async () => {
      try {
        const pluginResult = await reloadSkills({ reason: 'boot' });
        const okCount = pluginResult.loaded.length;
        const failCount = pluginResult.failed.length;
        if (okCount > 0) log(`[skill] 已加载 ${okCount} 个 Skill`);
        for (const f of pluginResult.failed) {
          log(`[skill] ❌ ${f.id || '(未知)'}：${f.error}`);
        }
        if (failCount > 0) log(`[skill] ${failCount} 个 Skill 加载失败`);

        const toolCount = orchestrator.refreshToolDefs();
        log(`[skill] 工具集已刷新：${toolCount} 个工具`);

        // 热重载日志：reloadSkills({reason:'boot'}) 里已经把 watcher 建好了
        // （默认开 config.extensions.hotReload，QQ_AGENT_DEV=1 可强制打开）
        if (pluginWatcher) {
          // 明确告知"落地的代码会被执行"，让用户知道这个行为的边界
          log('[skill] 热重载已启用：放入 plugins/ 或 skills/ 的目录会自动加载并执行'
            + '（要关闭请设 config.extensions.hotReload=false）');
        } else {
          log('[skill] 热重载未启用（config.extensions.hotReload=false）：改动后需重启');
        }
      } catch (error) {
        log('[skill] 加载失败:', error?.message ?? error);
      }
    })();

    // R81（BUG-10 轻量版）：出窗不死等 Skill 加载。
    // 原实现会等协议端就绪（最长 20 秒）才返回，而 main.js 是 core.start()
    // 完成后才 createWindow —— 那段时间用户连窗口都没有。协议端就绪只影响
    // OneBot 首连，而首连失败有现成兜底：connectLoop 退避重试 + 2 秒一次的
    // 端口就绪轮询（端口一通立即 reconnect）。所以启动关键路径只给 Skill
    // 加载留 5 秒宽限，到点继续，连接恢复交给轮询。
    const SKILL_GRACE_MS = 5000;
    let skillGraceTimer = null;
    const boundedSkillsReady = Promise.race([
      skillsReady,
      new Promise((resolve) => {
        skillGraceTimer = setTimeout(() => {
          log(`[skill] 初始化超过 ${SKILL_GRACE_MS / 1000} 秒，先继续打开控制台；插件加载仍在后台等待。`);
          resolve('skills-grace-timeout');
        }, SKILL_GRACE_MS);
      }),
    ]);
    await boundedSkillsReady;
    if (skillGraceTimer) clearTimeout(skillGraceTimer);

    // ── 协议端自动拉起（2026-10-27，R125）──────────────────────────────────
    // 只有用户显式勾了「随 QQ Agent 启动协议端」才走这里（默认关）：
    // 协议端仍是用户自己的程序，本软件只是替他按下"启动"，不代签任何协议。
    // 不 await —— SnowLuma 起来要几秒，启动关键路径不该等它；OneBot 有
    // connectLoop 退避重连 + 2 秒端口轮询兜底，端口一通就会自己连上。
    if (getConfig().protocol?.launcher?.autoLaunch === true) {
      protocolLauncher.launch({ auto: true })
        .then((r) => { if (!r.ok) log(`[protocol] 自动启动协议端失败：${r.error}`); })
        .catch((e) => log(`[protocol] 自动启动协议端异常：${e?.message ?? e}`));
    }

    await onebot.connect();

    // ── 首次启动自动读取协议端配置（2026-10-24）──────────────────────────────
    // 协议端自 10-23 起由用户自行安装，令牌是 SnowLuma 按账号随机生成的；让新用户
    // 从 WebUI 抄两串 43 位随机字符，是首次配置最容易卡死的一步（现象：端口通了但
    // 401，页面只会说"令牌不一致"，用户根本不知道该去哪找）。
    //
    // 只在**两个令牌都为空**时跑：这是"从没配过"的可靠信号；用户手填过任何一枚，
    // 就说明他会配，此时静默探测反而可能把对的值覆盖成错的。
    // 异步、不 await —— 探测要 spawn 一次 PowerShell（实测约 0.8 秒），不能挡住开窗。
    const shouldAutoFill = () => {
      const p = getConfig().protocol || {};
      return !String(p.accessToken || '').trim() && !String(p.httpAccessToken || '').trim();
    };
    let lastAutoFillAt = 0;
    const runAutoFill = async (why) => {
      lastAutoFillAt = Date.now();
      try {
        const r = await autoFillProtocol();
        if (r?.applied) log(`[onebot] ${why}：已自动读取协议端配置并重连（账号 ${r.uin || '未知'}）`);
        else if (r?.found) log(`[onebot] ${why}：探测到协议端配置，与当前设置一致`);
        else log(`[onebot] ${why}：${r?.reason || '未找到协议端配置'}`);
      } catch (error) {
        // 探测是"锦上添花"：失败一律不影响连接，用户还能手动填
        log('[onebot] 自动读取协议端配置失败（已忽略）：', error?.message ?? error);
      }
    };
    if (shouldAutoFill()) setTimeout(() => void runAutoFill('首次启动'), 0);

    // ── OneBot 端口就绪轮询（2026-09-19）────────────────────────────────────
    // WS 3001 只有「QQ 登录 → Hook 检出 → OneBot 实例拉起」后才监听。常见时序：
    // QQ Agent 先启动（此时 3001 未开）→ connectLoop 吃 ECONNREFUSED → 退避
    // 涨到 30 秒 → 用户在这中间扫码登录 → 3001 开了，但下一次重试可能还要等
    // 二十多秒，用户看到的就是"登录了半天连不上 / 重启就好了"。
    // 这里加一个主动轮询：每 2 秒探一次 WS 端口，端口一开立即触发重连（走
    // connectLoop 的代际互斥，不会产生并发连接）。已连接后轮询自动停止；
    // 断线（协议端重启等）时轮询自动恢复 —— 恢复延迟从"最多 30 秒"降到
    // "最多 2 秒 + 一次连接建立"。
    const obWsPort = protocolWsPort();
    // r92（R78-3）：边沿触发。原实现端口开着就每 2 秒无条件 reconnect()，而
    // reconnect 会清零 onebot 的指数退避 —— 端口已开但连接失败（如 token 未
    // 就绪）时，3s→6s→12s→24s→30s 的退避完全失效，被钉死在 2 秒一轮，
    // 协议端侧日志里全是永不收敛的 unauthorized 尝试。只在"关→开"的
    // 边沿触发一次重连，之后交给 onebot 自己的退避循环。
    let obPortWasOpen = false;
    // 2026-10-20（S4 补）：首轮探测只建立基线，不能当成"关→开"边沿。
    // 冷启动时进程已经是连接状态、obPortWasOpen 初值为 false，若不区分，
    // 第一次探测就会误判为"端口刚开"而白重连一次（还会清掉一次退避）。
    let obPortEdgePrimed = false;
    obPortPollTimer = setInterval(async () => {
      // 整段兜住异常（2026-10-17 加固）：这是个 async 定时器回调，里面抛出的异常
      // 没人 await → 变成 unhandledRejection。主进程那条兜底只记日志、**不退出**
      // （electron/main.js:243），所以一旦这里每 2 秒抛一次，用户看到的就是
      // "窗口还在、但什么都不工作"的半死状态，日志里刷满同一条。宁可单轮失败。
      try {
      // ── 2026-10-20（S4 修）：已连接时也要更新端口边沿状态 ─────────────────
      // 旧写法是 `if (onebot.connected) return;` —— obPortWasOpen 只在"未连接"
      // 分支里更新。若协议端在一个轮询周期内快速重启（端口关→开），而 QQ Agent 的
      // socket 还没收到 close（TCP 半开，connected 仍为 true），这次边沿就被永久
      // 吞掉，只能等 onebot 自己的退避（最长 30 秒）或 TCP 超时 —— 与下面注释承诺的
      // "恢复延迟最多 2 秒"不符。connected 时顺手探一次端口，成本是一次本机 connect。
      if (onebot.connected) {
        const stillOpen = await isPortOpen('127.0.0.1', obWsPort);
        // 2026-10-20（S4 补）：只是"把状态记下来"还不够 —— 记下来不等于处理了。
        // 端口关过一次又开（协议端重启 / 换端口前的短暂关闭），说明手里这条 socket
        // 连的已经是上一代进程，边沿必须在**这里**消费掉，否则要等 TCP 自己超时
        // 才发现断线。reconnect 内部有连接代际互斥（onebot.js:143），不会双连。
        if (obPortEdgePrimed && stillOpen && !obPortWasOpen) {
          // 协议端重启过（端口关→开）：旧 socket 连的已是上一代进程，立即重连
          // （reconnect 内部有连接代际互斥，不会双连）。
          onebot.reconnect();
        }
        obPortWasOpen = stillOpen;
        obPortEdgePrimed = true;
        return;
      }
      // 注：曾经在这里做「selfId 自动学习 botQQ」，已移除（2026-10-15 三次调整）——
      // selfId 只是「当前占用 OneBot 端口的账号」，双号在线时会抓到个人号（实测
      // 个人号被学成了机器人）。botQQ 现在只有两个可靠来源：
      //   ① 用户在页面「注入目标」显式输入/点选；
      //   ② QQ Agent 自己启动的 QQ 注入成功后，把 probe-login 读到的 uin 记下来
      //     （协议端自行管理账号注入）。
      const open = await isPortOpen('127.0.0.1', obWsPort);
      obPortEdgePrimed = true;   // 未连接分支自己就在处理边沿，从此开始按边沿判定
      if (open && !obPortWasOpen && !onebot.connected) {
        // 端口从关到开：协议端就绪（QQ 登录完成 / 协议端刚拉起）。
        // 若这时还没配令牌（典型时序：先开 Agent，再去装/登录 SnowLuma），先试一次
        // 自动读取 —— 否则只会拿空令牌去撞 401，撞到用户自己去翻配置为止。
        // 30 秒冷却：协议端反复重启时，别每次都 spawn 一遍 PowerShell。
        if (shouldAutoFill() && Date.now() - lastAutoFillAt > 30000) {
          // 探测成功会自己走 setEndpoint → reconnect；失败时下面这条 reconnect
          // 负责恢复，两条路径都有连接代际互斥兜底，不会双连。
          void runAutoFill('检测到协议端启动');
        }
        // 立即重连（reconnect 会重置退避，秒级恢复）。
        onebot.reconnect();
      }
      obPortWasOpen = open;
      } catch (error) {
        try { log('[onebot] 端口轮询异常（已忽略，2 秒后继续）:', error?.message ?? error); } catch { /* ignore */ }
      }
    }, 2000);
    obPortPollTimer.unref?.();

    // ── WS 就绪后的账号信息兜底（2026-09-19）
    // 协议端重启/换号后，QQ Agent 侧的 WS 可能先于 OneBot 实例完全就绪连上，
    // open 时的 get_login_info 失败 → selfInfo 恒空 → UI"检测不到账号"。
    // onebot.js 里已有 15 秒延迟补拉；这里再挂一道 45 秒后的终检：
    // 连着但仍没有 selfInfo 就强制补一次并广播状态（长期运行的兜底，幂等）。
    setTimeout(() => {
      if (!onebot.connected || onebot.selfInfo) return;
      onebot.call('get_login_info').then((info) => {
        if (info) {
          onebot.selfInfo = info;
          emit('onebot-status', { connected: true, everConnected: true, error: '' });
          log('[onebot] 账号信息延迟恢复成功');
        }
      }).catch(() => { /* 仍失败：连接层已尽力，UI 状态如实反映 */ });
    }, 45_000).unref?.();
    if (getConfig().proactive?.enabled) orchestrator.startProactiveLoop();
    orchestrator.startReminderLoop();   // 提醒（闹钟）调度：到点往群里发提醒
    log(`控制台已就绪：http://127.0.0.1:${port}`);

    // ── 用量档案后台预热（2026-09-22）────────────────────────────────────
    // 首次打开用量页要先把全部会话文件解析一遍（实测 170MB ≈ 3.1 秒）——
    // 启动后闲置时先付掉，用户点「今日」就不用等。延迟 8 秒避开启动高峰
    // （插件加载 / 价格表 / 遥测都挤在头几秒），解析本身分片让步不阻塞事件循环。
    const usageWarmTimer = setTimeout(() => {
      warmUsageArchive()
        .then((r) => { if (r) log(`[usage] 用量档案已后台预热（${r.files} 个会话，${r.ms}ms）`); })
        .catch((error) => log(`[usage] 后台预热失败（首次打开用量页时会现场重算）：${error?.message ?? error}`));
    }, 8000);
    usageWarmTimer.unref?.();

    // ── 数据盘空间巡检（2026-10-16 外部审查 #9）──────────────────────────
    // 应用本体原来没有任何磁盘满处理：写不进去时只会看到一串次级错误，真正的
    // "盘满了"反而不见。这里启动时查一次 + 每小时一次，水位过低就记警告/错误；
    // critical 档另由 image-cache.js 的 enabled() 停止写入（见 disk-space.js）。
    const diskCheck = () => {
      // 同步定时器回调**必须**自己兜异常（2026-10-17 加固）：这里抛出去没有任何
      // try/catch 能接住，直接变成 uncaughtException → 主进程弹窗后 app.exit(1)。
      // diskPressure() 内部要 statfs / 查盘，权限、卷被卸载、网络盘掉线都可能抛 ——
      // 「磁盘巡检失败」绝不该等于「整个程序退出」。
      try {
        const level = diskPressure();
        if (level === 'ok') return;
        const text = diskPressureText();
        if (level === 'critical') log(`[disk] 🔴 ${text} —— 已暂停图片缓存写入，请清理空间`);
        else log(`[disk] 🟡 ${text} —— 建议清理（图片缓存 TTL 3 天 + 总量闸 2GB）`);
      } catch (error) {
        // 同上：catch 里也不许再抛（log 失败 → 这里的抛出就是 uncaughtException）
        try { log(`[disk] 磁盘巡检异常（已忽略，不影响运行）: ${error?.message ?? error}`); } catch { /* ignore */ }
      }
    };
    diskCheck();
    // 注意：赋值给外层 let，不能用 const（会遮蔽，stop() 里的 clearInterval 永远清不到）
    diskPatrolTimer = setInterval(diskCheck, 60 * 60 * 1000);
    diskPatrolTimer.unref?.();
    log(`OneBot 协议端: ws=${getConfig().protocol?.wsUrl} http=${getConfig().protocol?.httpUrl}`);
    log(`模型: ${getConfig().api.model || '（未设置，请在设置里选择）'} @ ${getConfig().api.baseUrl}`);
    return port;
  }

  // ── Skill 重扫：UI「刷新」按钮的唯一后端入口 ──────────────────────────
  // 之前「刷新」只重读内存注册表（GET /api/skills），不碰磁盘 —— watcher 丢事件
  // （目录删除重建后 fs.watch 句柄失效、网络盘、杀毒软件）时，点多少次刷新都
  // 看不到新插件。这里把"重扫磁盘 + 激活 + 刷工具 + 重建 watcher"做成一个
  // 幂等函数，启动流程和手动重扫共用，行为完全一致。
  async function reloadSkills({ reason = 'manual', result: preloaded = null } = {}) {
    // ── 批量加载静默期（2026-10-23）───────────────────────────────────────
    // loadSkillRoot 是**串行**加载（并行 import 时两个 Skill 抢同一 id 顺序不
    // 确定），而每个插件的 setup() 在 import 期间就把工具注册进表。于是 N 个
    // 带工具的插件会产生 N 次工具集增长：35 → 38 → 41 → 44 …
    // 群聊活跃时每一级增长都可能被某个请求看到 = 一次 17k 全价重算。
    // "新加插件后缓存爆炸"就是这个 —— 不是插件让前缀变大，是中间态被看见了。
    //
    // 包进 batch 后：中间态一律沿用旧集合，endToolsetBatch() 把所有桶标脏，
    // 下一次请求立即按最终集合重建基线。N 次折叠成 1 次，且"装完就能用"
    // 的体验不变（延迟上限 = 一次重扫耗时）。
    beginToolsetBatch();
    try {
      // r92：watcher 的 runReload 已经 loadPlugins 过一遍（它的 result 通过
      // onReload 传进来）—— 原实现这里无视入参再 loadPlugins 一遍，每个插件的
      // setup() 实跑两遍（import(url?t=) 两次）：日志洪水、插件副作用双跑
      // （计时器/计数/通知）、工具集反复重建导致系统提示重建 → 前缀缓存断裂 ×N。
      // 手动/接口入口没有预载结果，照常全量扫。
      const result = preloaded || await loadPlugins({ log });
      // 内置工具链（自检/修复/锻造台/开发工单）：不走插件目录，由核心直接注册。
      // 放在 loadPlugins 之后、激活循环之前 —— 它同样需要参与 activate 与工具刷新。
      try { registerHarness({ skillManager, log }); } catch (error) { log(`[harness] 注册失败：${error?.message ?? error}`); }
      for (const st of skillManager.list()) {
        if (st.enabled && st.loaded) {
          try { skillManager.activate(st.id); } catch (error) { log(`[skill] 激活 ${st.id} 失败：${error?.message ?? error}`); }
        }
      }
      try { orchestrator.refreshToolDefs(); } catch { /* 刷新失败不影响主流程 */ }

      // watcher 自愈：fs.watch 监听的目录被删除再重建后收不到任何事件，
      // 这里关掉旧的重新建。热重载关闭时保持关闭（尊重用户配置）。
      const hotReloadOn = process.env.QQ_AGENT_DEV === '1'
        || getConfig().extensions?.hotReload !== false;
      try { pluginWatcher?.close?.(); } catch { /* ignore */ }
      pluginWatcher = null;
      if (hotReloadOn) {
        // r92：新 watcher 继承一段静默期 —— 原实现重建后 quietUntil=0，而重扫
        // 自己会 import/触碰 skill 目录里的文件，晚到的事件会立刻再触发一轮
        // 全量重扫（旧 watcher 花 2.5s 建的静默期随 close 一起作废）。
        pluginWatcher = watchPlugins({ log, quietMs: 2500, onReload: (r) => reloadSkills({ reason: 'watch', result: r }) });
      }

      if (reason !== 'boot') {
        log(`[skill] 重扫完成（${reason}）：${result.loaded.length} 成功，${result.failed.length} 失败`
          + (result.pruned?.length ? `，卸载 ${result.pruned.length} 个已删除的 Skill` : ''));
        emit('status', { configUpdated: true });
      }
      return result;
    } finally {
      // 必须放 finally：加载中途抛异常时也要放开静默期，否则工具集永久冻结
      // （虽然 tool-registry 里还有 30s 超时兜底，但那是最后一道保险）。
      const released = endToolsetBatch();
      // absorbed = 本轮扫描被折叠掉的中间变化次数，每一次原本都是一次
      // 全前缀重算（实测 17k tok）。这条日志是"装插件到底省了几次击穿"的凭据。
      if (released && released.absorbed > 0) {
        log(`[tools-batch] 重扫结束：折叠 ${released.absorbed} 次中间工具集变化`
          + `（原本各击穿一次前缀缓存），${released.scopes} 个会话桶待下次请求按最终集合生效`);
      }
    }
  }

  async function stop() {
    // 启动组合资源（0.4.9.3）：先让覆盖层组件停掉自己登记的定时器/订阅/句柄。
    // 放在**最前面** —— 组件清理时可能还要访问 onebot / store，这些此时都还活着。
    // 清理失败绝不能阻断退出路径（单实例锁必须释放），所以整段包起来只记日志。
    try {
      await lifecycle.close();
    } catch (error) {
      log?.(`[composition] 资源清理失败：${error?.message ?? error}`);
    }
    // 先停掉热重载 watcher：否则 stop() 之后文件变动仍会触发重载 + 广播
    try { pluginWatcher?.close?.(); } catch { /* ignore */ }
    pluginWatcher = null;
    // r92：退订本次 createApp 挂的日志监听器（见上方 onLog 注释）
    try { unsubscribeAppLog?.(); } catch { /* ignore */ }
    unsubscribeAppLog = null;
    await orchestrator.abortAll();
    orchestrator.stopReminderLoop();
    // 主动发言循环也要停（2026-09-26 补）：此前只停了 reminderLoop，
    // proactiveTimer 在 stop() 后仍会继续 tick，headless 下进程不死就一直调度。
    try { orchestrator.stopProactiveLoop(); } catch { /* ignore */ }
    // 回收全部 Skill 实例：插件自己的 setInterval/落盘定时器（health-system
    // 的状态衰减等）此前从不 dispose —— 句柄泄漏 + 退出窗口可能写坏数据文件。
    try { skillManager.disposeAll({ reason: 'shutdown' }); } catch { /* ignore */ }
    if (communitySyncTimer) clearInterval(communitySyncTimer);
    try { cacheWarm?.stop?.(); } catch { /* ignore */ }
    if (obPortPollTimer) clearInterval(obPortPollTimer);
    if (diskPatrolTimer) clearInterval(diskPatrolTimer);
    // 退出前停掉遥测与价格表轮询（2026-09-25 补）：headless 模式 stop() 后进程若
    // 继续存活，这两个定时器会照常发起网络请求。
    try { stopTelemetryLoop(); } catch { /* ignore */ }
    try { stopPriceFeed(); } catch { /* ignore */ }
    // 索引缓存立刻落盘：正常运行中靠防抖（5s），退出前必须写一次，
    // 否则最后的会话变动丢失、下次启动要靠后台对账补（慢路径）
    sessions.flushIndexCache();
    // 消息存档的延迟落盘也要立刻兑现（报告3 M5）：saveChat 现在按会话节流 300ms，
    // 退出前不 flush 就会丢掉"刚看到消息就关程序"那最后几百毫秒的聊天记录。
    try { store.flushPendingSaves(); } catch { /* 退出路径上不再抛 */ }
    // 关闭所有 SSE 长连接，避免 server.close() 一直等它们
    for (const c of [...sseClients]) {
      try { c.end(); } catch { /* ignore */ }
    }
    sseClients.clear();
    onebot.close();
    // 协议端进程（2026-10-27）：只回收**本软件拉起的**那个 —— 用户自己开的窗口
    // 不动。必须停：stdout 管道随主进程断开，留着它就成了"看不见日志的孤儿进程"，
    // 下次启动还会占着 3001 端口，表现为"连上了旧实例"。
    try { protocolLauncher.dispose(); } catch { /* 退出路径上不再抛 */ }
    server.close();
    // 便携 QQ：默认保留运行（避免误杀用户登录态），如需清理可在 UI 手动关闭
    // try { await stopPortableQQ(); } catch { /* ignore */ }
    // 释放单实例锁（下次启动才能再抢到）
    releaseInstanceLock();
  }

  return {
    server, onebot, store, memory, sender, sessions, orchestrator, start, stop, emit, getConfig, updateConfig, getRendererAuthToken: () => rendererAuthToken, launchPortableQQ, stopPortableQQ, qqPortableStatus, reloadSkills,
    // 启动组合生命周期（0.4.9.3）：外部也能登记清理函数，或检查 signal
    lifecycle,
    // 2026-10-24：桌宠宿主（electron/desktop-pet.js）要反向调用这三个，但一直
    // 没有挂在返回值上 —— 主进程侧 `core?.xxx?.()` 全是 undefined，
    // 于是「模型已加载」上报、角色预览、动作预览、屏幕观察、今日用量卡片、开发工单
    // 全部静默失效，表现为桌面上的角色好好的、控制台永远停在"正在加载"。
    // bindHost 是幂等的，这里多一条从 reconcileService 来的绑定不会重复。
    getDesktopPetService, getUsageToday, devApi,
    // 2026-10-24：双击桌宠的第二个落点 —— 一对一私聊（文字 + 表情包）。
    // 同样走闭包延迟取值：core 建好之前主进程拿到的是 null，窗口自己会退回"不可用"。
    chatApi
  };
}