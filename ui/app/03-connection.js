// 〔连接页签〕—— M9 拆分第 4 段
// 2026-10-23：由「SnowLuma 页」改写为「连接页」（协议端解耦重构）。
'use strict';

/* ── 这一页为什么长这样 ───────────────────────────────────────────────────
 * 2026-10-23 之前，SnowLuma 随包分发、由本软件启动 / 注入 / 托管，所以这一页
 * 是一整套「启动管线」（QQ → SnowLuma → OneBot），光按钮就 18 个。
 *
 * 但 SnowLuma 的 EULA 5.4 明确禁止把它的专有原生组件并入第三方安装包、也禁止
 * 用自动化脚本部署。于是分工改成：
 *   · 协议端（SnowLuma 或 NapCat，二选一）= 用户自己安装、自己启动；
 *   · QQ Agent = 纯 OneBot v11 客户端，只负责连上 ws/http 端点。
 *
 * 这一页因此只剩三件事，也正是用户真正需要知道的：
 *   ① 现在连上没有（状态）；
 *   ② 没连上该装什么、怎么配（协议端指引，两张卡）；
 *   ③ 端点地址 / 令牌在哪儿改（端点设置，默认折叠）。
 *
 * 日志只留「应用日志」：协议端的日志归协议端自己（SnowLuma 控制台 / NapCat
 * 控制台），我们拿不到，也不该假装能拿到 —— 旧版三块日志面板里有两块是
 * 内置 SnowLuma 的 stdout，随托管一起消失了。
 *
 * 样式沿用 .snowluma-* / .sl-* 类名（style.css 里那一大段仍然有效）：
 * 换的只是内容与 id，没必要为了改名再动一遍 CSS。
 */

/* 折叠区展开态：页面每 15 秒被 startListPoller 重建一次（quiet），
   不记住的话用户刚展开日志、一转眼就自己合上了。
   ⚠️ 端点设置里可能有用户正在输入的地址，所以 quiet 刷新**只改状态文字**、
   绝不重绘整页（见 updateConnectionLive）—— 这是旧版「注入目标输入框打一半
   被重置」那个坑的通用解法。 */
let connLogsOpen = false;
let connAdvOpen = false;
/* 2026-10-24 重设计追加：
   · connSetupOpen —— 「装一个协议端」折叠区的手动开合态。null = 用户还没动过，
     按连接状态自动定（没连上默认展开，连上默认收起）；
   · connLogsCache —— 最近一次拿到的日志。手动「重新检测」只重读 /api/status、
     不重新拉日志，但 updateConnectionLive 需要日志参数来维护日志面板。 */
let connSetupOpen = null;
let connLogsCache = { logs: [], level: 'info' };
/* 2026-10-27（R125）协议端进程托管：
   · connProcOpen —— 「协议端进程」折叠区开合态（null = 按连接状态自动定）；
   · connProcCache —— { status, logs }：SSE 实时追加，重绘时用它还原面板。 */
let connProcOpen = null;
let connProcCache = { status: null, logs: [] };
/* 2026-10-27（R126/R128）接入状态缓存：
   · connOnboardCache —— 最近一次 /api/protocol/onboard 的结果（阶段 + 进程表）。
   单独缓存是因为这个接口要登录控制台再列进程（1~3 秒），不能塞进 /api/status
   那种每 15 秒刷一次的路径里。单卡（R128）只用它算"用户处境"。 */
let connOnboardCache = null;

/** 协议端进程状态 → 一句话 + 配色（徽标/按钮可用态都从这里取）。 */
function connProcView(proc) {
  const st = proc || {};
  if (!st.supported) return { cls: 'off', text: '仅 Windows 支持', running: false, canStart: false };
  if (st.running) return { cls: 'ok', text: `运行中 · pid ${st.pid}`, running: true, canStart: false };
  if (st.launching) return { cls: 'warn', text: '正在启动…', running: false, canStart: false };
  if (st.exit && st.exit.code !== 0) return { cls: 'warn', text: `已退出（code ${st.exit.code ?? '-'}）`, running: false, canStart: true };
  return { cls: 'off', text: '未由本软件启动', running: false, canStart: true };
}

/** 协议端日志 → 面板文本（与「应用日志」同一套时间/等级格式）。 */
function connProcLogText(logs) {
  const arr = Array.isArray(logs) ? logs : [];
  const text = arr.map((e) => {
    const t = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false });
    const lv = String(e.level || 'stdout') === 'stderr' ? 'ERR ' : 'OUT ';
    return `[${t}] ${lv} ${e.text}`;
  }).join('\n') || '暂无输出 —— 点「无窗口启动」后，SnowLuma 的控制台内容会出现在这里';
  return { arr, text };
}

/** 把 /api/status 压成一个视图对象，渲染与局部更新共用同一份判断。 */
function connView(s) {
  const proto = (s && s.protocol) || {};
  const ob = (s && s.onebot) || {};
  const connected = !!ob.connected;
  const portOpen = !!proto.portOpen;
  const selfId = String((ob.self && ob.self.userId) || '');
  const nick = String((ob.self && ob.self.nickname) || '');
  const connectedAt = Number(ob.connectedAt) || 0;
  const diag = String(ob.diagnosis || '');
  // 三层口径：连上 = 绿；端口开着但没连上 = 橙（多半是令牌/账号）；端口没开 = 灰。
  const overall = connected ? 'ok' : (portOpen ? 'warn' : 'off');
  const overallText = connected ? '机器人工作中' : (portOpen ? '等待连接' : '协议端未运行');
  return { proto, ob, connected, portOpen, selfId, nick, connectedAt, diag, overall, overallText };
}

/** 应用日志 → 面板文本。空态文案与旧版一致（'暂无日志' 触发 .is-empty 居中样式）。 */
function connLogText(appLogsData) {
  const arr = (appLogsData && appLogsData.logs) || [];
  const text = arr.map((e) => {
    const t = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false });
    const lv = String(e.level || 'info').toUpperCase().padEnd(5);
    return `[${t}] [${lv}] [${e.module || '-'}] ${e.text}`;
  }).join('\n') || '暂无日志';
  return { arr, text };
}

/** 三种状态的"人话结论"：连上 / 端口通了但没连上 / 端口没开。
    这一页 99% 的使用场景是"为什么连不上、我该先做什么"，所以结论必须自己把
    下一步说出来，而不是把后端诊断原样甩给人。 */
function connVerdict(v) {
  if (v.connected) {
    return {
      cls: 'is-ok',
      title: '机器人工作中',
      sub: `已经用「${v.nick || '机器人'}」${v.selfId ? `（${v.selfId}）` : ''}收发群消息。协议端那头断开的话，这一页会自动变回来。`
    };
  }
  if (v.portOpen) {
    return {
      cls: 'is-warn',
      title: '端口通了，但还没连上',
      sub: '最常见的是令牌不一致，或机器人 QQ 还没登录 —— 检查下面「端点地址与令牌」里的令牌，以及协议端里登录的账号。'
    };
  }
  return {
    cls: 'is-off',
    title: '没检测到协议端在运行',
    sub: '先启动 SnowLuma / NapCat 并登录机器人 QQ；如果它开在别的端口，到「端点地址与令牌」里改。还没装过就按下面的步骤来。'
  };
}

/** 结论块右上角的时间戳：这一页会被 SSE / 轮询悄悄刷新，不给个时间用户不知道是不是新的。 */
function connClock() {
  return '检测于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/** 两步引导：算出"现在该做哪一步"。纯函数，UI 只读它，不自己判断。 */
function connGuide(v, proc, ob) {
  const dir = String((proc && (proc.dir || proc.configuredDir)) || '');
  const running = Boolean(proc && proc.running) || Boolean(v.portOpen);
  const injected = String((ob && ob.stage) || '') === 'ready';
  // ⚠️ 第二步的"完成"只认 OneBot 真连上，不认"注入成功"：
  //    注入完到 OneBot 起来之间有 1~5 秒，那几秒里若把步骤条画成绿色，
  //    用户会以为已经能用了，然后发现群里没反应。
  const done = Boolean(v.connected);
  const steps = [
    {
      title: '准备并启动协议端',
      done: running,
      hint: running ? '正在运行' : (dir ? '已填目录，还没启动' : '还没指定目录')
    },
    {
      title: '接入机器人 QQ',
      done,
      hint: done ? '已接入'
        : injected ? '已注入，等 OneBot 连上'
          : running ? '协议端在跑，还差这一步' : '等协议端启动'
    }
  ];
  const current = steps.findIndex((s) => !s.done);
  return { steps, current: current === -1 ? steps.length : current, allDone: current === -1 };
}

/** 步骤条：两枚 + 状态点。只做展示，不做交互。 */
function connStepsHtml(guide) {
  const items = guide.steps.map((s, i) => {
    const cls = s.done ? 'is-done' : (i === guide.current ? 'is-current' : '');
    return `<li class="${cls}">`
      + `<span class="conn-step-dot">${s.done ? '✓' : (i + 1)}</span>`
      + `<span class="conn-step-name">${esc(s.title)}</span>`
      + `<span class="conn-step-hint">${esc(s.hint)}</span>`
      + '</li>';
  }).join('');
  return `<ol class="conn-steps">${items}</ol>`;
}

/**
 * 连接页。
 *
 * ── 这一版为什么长这样（2026-10-27，R127）──────────────────────────────
 * 之前是「状态 + 装协议端 + 协议端进程 + 一键接入 + 端点设置 + 应用日志」六块平铺，
 * 光按钮就 10 个。对新用户来说，真正要回答的只有两个问题：
 *   「现在什么状态」「我下一步点哪」。
 * 所以改成：
 *   ① 顶部一张状态卡（结论 + 三条事实）；
 *   ② 没连上时给一条**两步引导**，只展开当前卡住的那一步（另一步折叠成一行）；
 *   ③ 连上之后引导整块收成一行"已就绪"，其余（进程/日志/端点/诊断）全部折叠。
 * 老用户要的东西一个没删，只是默认收起来了。
 */
/* ── 单卡模式（2026-10-27，R128）──────────────────────────────────────────
 *
 * 上一版把八块折叠成四块，但**还是在跟用户讲技术**：步骤条、协议端、注入、OneBot。
 * 对完全不懂的人，正确的做法是只给三样东西：一个表情、一句话、一个按钮。
 *
 * 所以这一版把整套状态机藏起来，对外只暴露 13 种"人话处境"，每种配一个动作。
 * 用户点一次，前端自己往下推（启动 → 等端口 → 登录 → 注入），只在**必须他本人**
 * 的地方停下来问一句（密码、同意条款、登录 QQ、选号）。
 *
 * 技术细节一个没删，全在「高级设置」里 —— 但那是个默认合上的折叠。
 */

/** 把内部阶段归一成"用户处境"。UI 只认这 13 个字符串。 */
function connAutoStage(v, proc, ob) {
  const stage = String((ob && ob.stage) || '');
  const dir = String((proc && (proc.dir || proc.configuredDir)) || '');
  const running = Boolean(proc && proc.running) || Boolean(v.portOpen);

  // ① 已经能用 —— 不管内部还残留什么阶段
  if (v.connected) return 'ok';
  if (stage === 'ready') return 'ok';

  // ② 需要用户本人做点什么的，优先于"进程状态"（进程可能在跑，但就是卡在密码/同意上）
  if (stage === 'need-password' || stage === 'locked' || stage === 'need-totp'
    || stage === 'consent' || stage === 'must-change' || stage === 'pick') return stage;
  if (stage === 'no-qq') return 'need-qq';
  if (stage === 'can-inject' || stage === 'wrong-target') return 'can-connect';

  // ③ 兜底：只看本机看得见的东西
  if (!dir) return 'no-component';
  if (proc && proc.launching) return 'starting';
  if (!running) return 'not-running';
  if (stage === 'booting' || stage === 'stopped' || !stage) return 'starting';
  return 'checking';
}

/** 每种处境一个线性图标（Feather 风格，stroke 由 CSS 控制颜色）。
    用 SVG 而不是 emoji：Windows 的彩色 emoji 在深色底上是个实心色块，
    边缘发虚、大小不受控，和整套 UI 的细线条完全不搭。 */
const AUTO_ICON_PATHS = {
  ok: '<path d="M20 6L9 17l-5-5"/>',
  'no-component': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  'not-running': '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><path d="M12 2v10"/>',
  starting: '<path d="M21 12a9 9 0 1 1-6.22-8.56"/>',
  'need-password': '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2"/><path d="M18 5l3 3"/><path d="M15 8l2 2"/>',
  'need-qq': '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 12.5 3 8.5 8.5 0 0 1 21 11.5z"/>',
  pick: '<path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  consent: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h6"/>',
  'can-connect': '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  checking: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'
};

/** 图标渲染。stage 决定图形，cls 决定配色。 */
function connIcon(stage, cls) {
  const path = AUTO_ICON_PATHS[stage] || AUTO_ICON_PATHS.alert;
  const spin = stage === 'starting' ? ' is-spin' : '';
  return `<div class="auto-icon ${cls}${spin}" id="conn-auto-icon">`
    + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" `
    + `stroke-linecap="round" stroke-linejoin="round">${path}</svg></div>`;
}

/** 头像底色：按 QQ 号取一个固定渐变，同一个号永远是同一个颜色。
    2026-10-27（R132）：这层渐变从"头像本体"降级成**兜底**——上方叠真实 QQ 头像
    （connAvatarUrl），图没加载出来/加载失败时才露出它 + 昵称首字。 */
const CONN_AVATAR_GRADIENTS = [
  ['#4f8cff', '#7b5cff'], ['#22c55e', '#0ea5e9'], ['#f59e0b', '#ef4444'],
  ['#06b6d4', '#3b82f6'], ['#a855f7', '#ec4899'], ['#14b8a6', '#22c55e']
];
function connAvatarStyle(uin) {
  let h = 0;
  for (const ch of String(uin || '0')) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  const g = CONN_AVATAR_GRADIENTS[h % CONN_AVATAR_GRADIENTS.length];
  return `background:linear-gradient(135deg,${g[0]},${g[1]})`;
}

/**
 * 机器人 QQ 的真实头像地址（官方 CDN 直链）。
 *
 * 与全站同一套：15-chat-chrome.js 的 qqAvatarUrl、14-chrome.js 的侧栏头像、
 * 05-memory-settings.js 的记忆卡片都直连 q1.qlogo.cn —— CSP 的 img-src 早已放行
 * `http: https:`，不需要走本地代理，也不需要缓存（CDN 自己带 ETag）。
 *
 * ⚠️ 这里**只能**用 `g?b=qq&nk=` 这个个人接口。群头像走 `p.qlogo.cn/gh/`，
 *    拿群号套个人接口会 404（15-chat-chrome.js 里踩过）。
 * ⚠️ QQ 号不是 5~12 位纯数字时返回空串 —— 由调用方退回首字 + 渐变兜底，
 *    不要把脏值拼进 URL（CDN 会回一张 100×100 的默认企鹅，比兜底更难看）。
 */
function connAvatarUrl(uin) {
  const id = String(uin || '').trim();
  if (!/^\d{5,12}$/.test(id)) return '';
  // s=140 而不是全站列表用的 100：卡片头像显示 44px，高分屏要 88px，
  // 140 留了余量又不像 s=640 那样白拉 20 KB。
  return `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=140`;
}

/**
 * 头像加载失败的兜底：藏掉 <img>，露出底下那层渐变 + 昵称首字。
 *
 * ⚠️ 不能写内联 onerror —— CSP 是 `script-src 'self'`，内联事件处理器会被拦掉
 *    （05-memory-settings.js / 15-chat-chrome.js 都踩过同一个坑）。
 * ⚠️ 监听必须用**捕获**：img 的 error 事件不冒泡，挂在容器上的普通监听收不到。
 * ⚠️ 挂在 #connection-page 上而不是 .auto-page：后者会被 connAutoRepaint()
 *    整个换掉，绑在它上面的监听每次重绘都会丢；#connection-page 是长期容器。
 */
function bindConnAvatarFallback() {
  const host = $('#connection-page');
  if (!host || host.__cxAvBound) return;
  host.__cxAvBound = true;
  host.addEventListener('error', (e) => {
    const im = e.target;
    if (!im || im.tagName !== 'IMG' || !im.classList.contains('cx-av-img')) return;
    im.style.display = 'none';
  }, true);
}

/** 在线时长 → 人话。刚连上时说"刚刚上线"，别显示"已在线 0 分钟"。 */
function connUptime(ms) {
  const t = Number(ms) || 0;
  if (!t) return '';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return '刚刚上线';
  const min = Math.floor(sec / 60);
  if (min < 60) return `已在线 ${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `已在线 ${hr} 小时${min % 60 ? ` ${min % 60} 分` : ''}`;
  return `已在线 ${Math.floor(hr / 24)} 天 ${hr % 24} 小时`;
}

/** 每种处境的人话文案 + 主按钮。title/sub 会同时写进 #conn-verdict-title/sub。 */
const CONN_AUTO_COPY = {
  ok: {
    emoji: '✅', cls: 'is-ok', title: '机器人已上线',
    // 2026-10-27（R129）：这一句原来为空，工作台版里标题下面直接跳指标格，太突兀。
    // 填一句"现在能干什么"，顺带把"为什么群里没反应"的常见误解（白名单）说清楚。
    sub: '协议端与 OneBot 都已就绪。群消息会实时进「会话」页，白名单群里 @ 它才会回复。',
    btn: ''
  },
  'no-component': {
    emoji: '📦', cls: 'is-warn',
    title: '还差一个软件要装',
    sub: '它叫「SnowLuma」，是个独立小软件，专门负责跟 QQ 打交道。我没法替你装，跟着下面三步走就行。',
    btn: ''
  },
  'not-running': {
    emoji: '😴', cls: 'is-warn',
    title: '机器人还没上线',
    sub: '组件装好了，只是没在跑。点下面这个按钮，我来启动它。',
    btn: '一键连接'
  },
  starting: {
    emoji: '⏳', cls: 'is-warn',
    title: '正在启动…',
    sub: '第一次启动要几秒，别急，我会自己往下走。',
    btn: ''
  },
  'need-password': {
    emoji: '🔑', cls: 'is-warn',
    title: '还差一个密码',
    sub: '连接组件的登录密码。第一次用时它会显示在启动窗口里，填一次就记住。',
    btn: '连接'
  },
  locked: {
    emoji: '⏰', cls: 'is-warn',
    title: '试太多次，被暂时锁了',
    sub: '等 15 分钟再试。这期间别反复点 —— 越点锁得越久。',
    btn: '好'
  },
  'need-totp': {
    emoji: '🔐', cls: 'is-warn',
    title: '需要动态验证码',
    sub: '那个组件开了两步验证，这一步只能你本人在它的控制台里做。',
    btn: '打开它的控制台'
  },
  consent: {
    emoji: '📄', cls: 'is-warn',
    title: '需要你本人同意条款',
    sub: '连接组件第一次运行要先同意它的用户协议。这一步只能你自己点。',
    btn: '打开它的控制台'
  },
  'must-change': {
    emoji: '🔑', cls: 'is-warn',
    title: '需要先改一个密码',
    sub: '那个组件要求先改掉初始密码。打开它的控制台改一次，回来把新密码填这儿。',
    btn: '打开它的控制台'
  },
  'need-qq': {
    emoji: '💬', cls: 'is-warn',
    title: '请先登录 QQ',
    sub: '在这台电脑上登录你要当机器人的那个号（建议用小号）。登录好回来点一下。',
    btn: '我登录好了'
  },
  pick: {
    emoji: '👥', cls: 'is-warn',
    title: '有两个以上的 QQ 在登录',
    sub: '选你要当机器人的那个号 —— 选错了它会用那个号在群里说话。',
    btn: '用这个号'
  },
  'can-connect': {
    emoji: '🔗', cls: 'is-warn',
    title: '可以连接了',
    sub: '点一下，把机器人接到 QQ 上。',
    btn: '连接'
  },
  checking: { emoji: '🔍', cls: 'is-off', title: '正在检查…', sub: '', btn: '' },
  error: { emoji: '⚠️', cls: 'is-warn', title: '出了点问题', sub: '', btn: '重试' }
};

/** 需要用户给东西时，卡片中间那块输入区。 */
function connAutoBody(stage, ob, proc, procDir) {
  if (stage === 'need-password') {
    return `
        <div class="auto-field">
          <input type="password" id="conn-onboard-pw" placeholder="连接组件的登录密码" autocomplete="new-password" value="" />
        </div>`;
  }
  if (stage === 'pick') {
    const list = (ob && ob.processes) || [];
    return `
        <div class="conn-pick-list auto-pick">
          ${list.map((p) => `
            <label class="conn-pick-item">
              <input type="radio" name="conn-onboard-pid" value="${p.pid}"${p.injected ? ' checked' : ''} />
              <span class="conn-pick-main">${esc(p.nickname || '未登录的 QQ')}${p.uin ? ` <em>${esc(p.uin)}</em>` : ''}</span>
              <span class="conn-pick-meta">${p.injected ? '已在用' : '未接入'}</span>
            </label>`).join('')}
        </div>`;
  }
  if (stage === 'no-component') {
    // 桌面版：第 3 步给「选择文件夹」（系统对话框），用户不用抄路径。
    // 网页版没有这个桥，退回手动填 + 自动查找。
    const hasPicker = typeof window.qqaDesktop?.pickDirectory === 'function';
    return `
        <div class="auto-steps">
          <div class="auto-step">
            <span class="auto-step-no">1</span>
            <div class="auto-step-main">
              <div class="auto-step-title">下载</div>
              <div class="auto-step-desc">点开下载页，找名字里带 <code>win-x64</code> 的那个 zip（几十 MB）。</div>
              <button class="btn btn-small" data-auto-download>打开下载页</button>
            </div>
          </div>
          <div class="auto-step">
            <span class="auto-step-no">2</span>
            <div class="auto-step-main">
              <div class="auto-step-title">解压</div>
              <div class="auto-step-desc">右键那个 zip →「全部解压缩」。放桌面就行。</div>
            </div>
          </div>
          <div class="auto-step">
            <span class="auto-step-no">3</span>
            <div class="auto-step-main">
              <div class="auto-step-title">告诉我它在哪</div>
              <div class="auto-step-desc">选解压出来的那一层文件夹 —— 里面应该能看到 <code>index.mjs</code> 和 <code>node.exe</code>。</div>
              ${hasPicker ? `
              <div class="sl-adv-row">
                <button class="btn btn-small btn-primary" data-auto-pick>选择文件夹</button>
                <button class="btn btn-small" data-auto-find>帮我找</button>
              </div>` : `
              <div class="auto-field">
                <input type="text" id="conn-proc-dir" value="${esc(procDir)}" placeholder="把解压后的文件夹路径填这里" />
                <button class="btn btn-small" id="conn-proc-find">帮我找</button>
              </div>`}
            </div>
          </div>
        </div>`;
  }
  return '';
}

/**
 * 整页：页头 + 状态卡 + 协议端卡 + 四个折叠。
 *
 * ── 这一版为什么长这样（2026-10-27，R129「连接工作台」）────────────────
 * R128 把这一页压成"一张 620px 居中的卡 + 一句人话"，对新用户确实友好，
 * 但它和整套 PCL 扁平 UI 是两种视觉语言，摆在一起就是"没做完"：
 *   · 全站内容列 940px、左对齐、1px 描边分层、9px 圆角；这里 620px 居中、
 *     16px 圆角、整卡染色 —— 1280px 的窗口里两侧各空 330px；
 *   · 全站每页都有标题行，这一页没有，卡片直接贴顶；
 *   · 状态、端点、协议端、日志四类信息里只有状态在明处，其余全在「高级设置」里，
 *     用户想知道"到底连的哪个地址"得先点开折叠。
 *
 * 所以改成工作台：页头（标题 + 总状态 + 重新检测）→ 状态卡（结论 / 身份 /
 * 四项连接事实 / 引导体 / 主按钮）→ 协议端卡（进程状态 + 启停 + 目录 + 自启）
 * → 四个折叠（协议端日志 / 端点与令牌 / 应用日志 / 诊断）。
 *
 * 人话文案（CONN_AUTO_COPY）和引导体（connAutoBody）一行没改 —— 换的只是
 * 它们被摆在哪、用什么视觉承载。
 *
 * ⚠️ 结构可以改，**id 与 data-* 锚点不能改**：bindConnectionPage / connApplyProc /
 *    connAutoApply / connRecheck 全靠它们做局部更新，少一个就会出现
 *    "日志在滚但按钮还是灰的"这种半截状态。
 */
function renderConnectionPage(v, appLogsData, procData) {
  const { proto, connected, portOpen, selfId, nick, connectedAt, diag, overall, overallText } = v;
  const wsUrl = String(proto.wsUrl || '');
  const httpUrl = String(proto.httpUrl || '');
  const appLog = connLogText(appLogsData);
  const level = (appLogsData && appLogsData.level) || 'info';
  const proc = procData && procData.status ? procData.status : null;
  const procView = connProcView(proc);
  const procLog = connProcLogText(procData && procData.logs);
  const procDir = String((proc && (proc.dir || proc.configuredDir)) || '');
  const procAuto = Boolean(proc && proc.autoLaunch);
  const stage = connAutoStage(v, proc, connOnboardCache);
  const copy = CONN_AUTO_COPY[stage] || CONN_AUTO_COPY.error;
  const isOk = stage === 'ok';
  const uptime = isOk ? connUptime(connectedAt) : '';
  const avatarText = String(nick || '机').trim().slice(0, 1) || '机';
  const avUrl = connAvatarUrl(selfId);
  const selfText = connected
    ? `${esc(nick || '已登录')}${selfId ? ` <em>${esc(selfId)}</em>` : ''}`
    : '<span class="cx-dim">未连接</span>';

  return `
      <div class="auto-page cx-page">
        <header class="cx-head">
          <div class="cx-head-main">
            <h2 class="cx-head-title">连接</h2>
            <span class="cx-head-sub">协议端与机器人 QQ 的通信状态</span>
          </div>
          <div class="cx-head-acts">
            <span class="sl-chip is-${overall}" id="conn-chip"><i class="sl-chip-dot"></i><span id="conn-chip-text">${esc(overallText)}</span></span>
            <button class="btn btn-small" id="conn-recheck-btn" type="button" title="重新读一次连接状态">重新检测</button>
          </div>
        </header>

        <section class="cx-card cx-state ${copy.cls}" id="conn-auto-card">
          <div class="cx-state-top">
            <div class="cx-state-mark">
              ${isOk
                ? `<div class="auto-avatar" style="${connAvatarStyle(selfId)}">`
                  + `<span class="cx-av-fb">${esc(avatarText)}</span>`
                  + (avUrl ? `<img class="cx-av-img" src="${esc(avUrl)}" alt="" loading="eager" decoding="async" referrerpolicy="no-referrer" />` : '')
                  + '</div><i class="auto-avatar-dot" title="在线"></i>'
                : connIcon(stage, copy.cls)}
            </div>
            <div class="cx-state-id">
              <div class="conn-verdict ${copy.cls}" id="conn-verdict">
                <div class="conn-verdict-main">
                  <div class="conn-verdict-title" id="conn-verdict-title">${esc(copy.title)}</div>
                </div>
              </div>
              ${isOk && (nick || selfId) ? `
              <div class="auto-id" id="conn-auto-id">
                <b>${esc(nick || '机器人')}</b>
                ${selfId ? `<span class="auto-id-sep">·</span><span>${esc(selfId)}</span>` : ''}
                ${uptime ? `<i>${esc(uptime)}</i>` : ''}
              </div>` : ''}
            </div>
          </div>

          <div class="conn-verdict-sub" id="conn-verdict-sub">${esc(copy.sub)}</div>

          <div class="cx-metrics">
            <div class="cx-metrics-head">
              <span>连接详情</span>
              <em id="conn-port-meta">${connClock()}</em>
            </div>
            <div class="cx-metrics-grid">
              <div class="cx-metric">
                <span class="cx-metric-k">收消息（WebSocket）</span>
                <code class="cx-metric-v" id="conn-ws" title="${esc(wsUrl || '')}">${esc(wsUrl || '（未设置）')}</code>
              </div>
              <div class="cx-metric">
                <span class="cx-metric-k">发消息（HTTP）</span>
                <code class="cx-metric-v" id="conn-http" title="${esc(httpUrl || '')}">${esc(httpUrl || '（未设置）')}</code>
              </div>
              <div class="cx-metric">
                <span class="cx-metric-k">机器人账号</span>
                <span class="cx-metric-v" id="conn-self">${selfText}</span>
              </div>
              <div class="cx-metric">
                <span class="cx-metric-k">WS 端口</span>
                <span class="cx-metric-v" id="conn-port-state">${portOpen ? '<span class="cx-ok">监听中</span>' : '<span class="cx-dim">未监听</span>'}</span>
              </div>
            </div>
          </div>

          <div class="cx-state-body" id="conn-auto-body">${connAutoBody(stage, connOnboardCache, proc, procDir)}</div>

          <div class="cx-state-foot">
            ${copy.btn ? `<button class="btn btn-primary cx-primary" id="conn-auto-btn" type="button" data-auto-go>${esc(copy.btn)}</button>` : ''}
            <span class="auto-note" id="conn-check-note"></span>
          </div>
        </section>

        <section class="cx-card cx-proc">
          <div class="cx-proc-head">
            <h3 class="cx-card-title">协议端</h3>
            <span class="conn-proc-chip is-${procView.cls}" id="conn-proc-chip">${esc(procView.text)}</span>
            <div class="cx-proc-acts">
              <!-- 「打开控制台」只在指定过目录后出现：没装的人点它只会打开一个
                   http://localhost:5099 的死链，还得自己判断"是不是我哪里做错了"。 -->
              ${procDir ? `<button class="btn btn-mini" type="button" data-console-open="snowluma" title="用默认浏览器打开协议端的 WebUI">打开控制台</button>` : ''}
              <button class="btn btn-small" id="conn-proc-start"${procView.canStart ? '' : ' disabled'}>启动</button>
              <button class="btn btn-small" id="conn-proc-stop2"${procView.running ? '' : ' disabled'}>停止</button>
            </div>
          </div>
          <div class="cx-proc-meta">
            <span class="cx-proc-k">程序位置</span>
            <span class="cx-proc-dir" id="conn-proc-state" title="${esc(procDir || '')}">${esc(procDir || '还没指定目录')}</span>
            <label class="cx-switch" title="下次启动 QQ Agent 时自动拉起协议端">
              <!-- R136：补上 sw 类 —— 全站"打勾才启用"的选项统一画成滑动开关
                   （style.css「开关（switch）」一节），R131 漏了它，落回原生勾选框。
                   只改外观：id / checked / change 处理器（bindConnProc）原样工作。 -->
              <input type="checkbox" class="sw" id="conn-proc-auto"${procAuto ? ' checked' : ''} />
              <span>随 QQ Agent 自动启动</span>
            </label>
          </div>
          <!-- 这一行是协议端所有操作的反馈位（启动 / 停止 / 查找 / 刷新 / 打开控制台）。
               ⚠️ 它必须存在：bindConnProc 里的 hint() 一直写 #conn-proc-hint，
               但 R125~R131 的渲染里从来没有这个节点 —— 结果是点「启动」失败、
               点「停止」失败、点「刷新」都毫无反馈，用户只会以为按钮坏了。 -->
          <div class="cx-proc-hint" id="conn-proc-hint"></div>
        </section>

        <div class="cx-adv">
          <details class="cx-fold" id="conn-proc"${connProcOpen ? ' open' : ''}>
            <summary>协议端日志<span class="cx-fold-sub">SnowLuma / NapCat 控制台的输出</span></summary>
            <div class="cx-fold-body">
              <div class="cx-fold-bar">
                <span id="conn-proc-meta">最近 ${procLog.arr.length} 条${proc && proc.pid ? ` · pid ${proc.pid}` : ''}</span>
                <button class="btn btn-mini" id="conn-proc-refresh" type="button" title="重新拉一次进程状态与日志">刷新</button>
              </div>
              <pre class="snowluma-logs-view${procLog.arr.length ? '' : ' is-empty'}" id="conn-proc-log">${esc(procLog.text)}</pre>
            </div>
          </details>

          <details class="cx-fold" id="conn-adv"${connAdvOpen ? ' open' : ''}>
            <summary>端点地址与令牌<span class="cx-fold-sub">换了端口、加了令牌才需要动</span></summary>
            <div class="cx-fold-body">
              <div class="field-row">
                <div class="field"><label>WebSocket 地址（收消息）</label>
                  <input type="text" id="conn-wsurl" value="${esc(wsUrl)}" placeholder="ws://127.0.0.1:3001" /></div>
                <div class="field"><label>HTTP 地址（发消息）</label>
                  <input type="text" id="conn-httpurl" value="${esc(httpUrl)}" placeholder="http://127.0.0.1:3000" /></div>
                <div class="field"><label>WebSocket 令牌</label>
                  <div style="display:flex;gap:8px">
                    <input type="password" id="conn-wstoken" value="${esc(proto.hasAccessToken ? '******' : '')}" placeholder="没设令牌就留空" autocomplete="new-password" style="flex:1" />
                    <button class="btn btn-small" id="conn-wstoken-toggle" type="button">显示</button>
                  </div></div>
                <div class="field"><label>HTTP 令牌（与 WS 不同时才填）</label>
                  <div style="display:flex;gap:8px">
                    <input type="password" id="conn-httptoken" value="${esc(proto.hasHttpAccessToken ? '******' : '')}" placeholder="留空 = 与 WS 相同" autocomplete="new-password" style="flex:1" />
                    <button class="btn btn-small" id="conn-httptoken-toggle" type="button">显示</button>
                  </div></div>
              </div>
              <div class="sl-adv-row">
                <button class="btn btn-small" id="conn-autofill-btn" title="直接读连接组件的配置文件，把端点与令牌填好并立刻重连">自动读取配置</button>
                <button class="btn btn-small btn-primary" id="conn-save-btn" title="保存地址与令牌，并立刻用新地址重连">保存并重连</button>
                <button class="btn btn-small" id="conn-test-btn" title="重新读一次状态">测试连接</button>
                <span class="sl-hint" id="conn-save-hint"></span>
              </div>
            </div>
          </details>

          <details class="cx-fold" id="conn-logs"${connLogsOpen ? ' open' : ''}>
            <summary>应用日志<span class="cx-fold-sub">出问题才需要看</span></summary>
            <div class="cx-fold-body">
              <div class="cx-fold-bar">
                <span>最近 ${appLog.arr.length} 条 · 同时落盘 data/logs/</span>
                <span class="cx-fold-bar-r">
                  <label class="sl-level" for="app-log-level">
                    <span>写进文件的详细程度</span>
                    <select id="app-log-level" title="只有达到这个详细程度的日志才会写进文件">
                      ${['debug', 'info', 'warn', 'error'].map((x) =>
                        `<option value="${x}" ${level === x ? 'selected' : ''}>${x}</option>`).join('')}
                    </select>
                  </label>
                  <button class="btn btn-mini" id="app-logs-refresh-btn" type="button" title="重新拉取最近日志">刷新</button>
                </span>
              </div>
              <pre class="snowluma-logs-view${appLog.arr.length ? '' : ' is-empty'}" id="conn-logs-view">${esc(appLog.text)}</pre>
            </div>
          </details>

          <details class="cx-fold" id="conn-diag-fold">
            <summary>诊断详情<span class="cx-fold-sub">反馈问题前先看这里</span></summary>
            <div class="cx-fold-body">
              <div class="conn-diag-text" id="conn-diag">${esc(connected ? '连接正常，能收发群消息' : (diag || '还没连上'))}</div>
              <div class="sl-adv-row" style="margin-top:8px">
                <button class="btn btn-small" id="conn-copy-diag" title="把连接状态和最近可疑日志复制成一段文字">复制诊断信息</button>
                <span class="sl-hint" id="conn-copy-hint"></span>
              </div>
            </div>
          </details>
        </div>
      </div>`;
}

/** quiet 刷新：只改状态文字与日志，不碰输入框、不重建整页。 */
function updateConnectionLive(v, appLogsData, procData) {
  const chip = $('#conn-chip');
  if (chip) chip.className = `sl-chip is-${v.overall}`;
  const chipText = $('#conn-chip-text');
  if (chipText) chipText.textContent = v.overallText;

  // 结论块：配色与两行文案一起换
  const verdict = connVerdict(v);
  const verdictBox = $('#conn-verdict');
  if (verdictBox) verdictBox.className = `conn-verdict ${verdict.cls}`;
  const verdictTitle = $('#conn-verdict-title');
  if (verdictTitle) verdictTitle.textContent = verdict.title;
  const verdictSub = $('#conn-verdict-sub');
  if (verdictSub) verdictSub.textContent = verdict.sub;
  // 手动检测的结论只活到下一次状态变化为止，避免留着一句过时的话
  const note = $('#conn-check-note');
  if (note) note.textContent = '';

  const meta = $('#conn-port-meta');
  if (meta) meta.textContent = connClock();
  const portState = $('#conn-port-state');
  if (portState) {
    portState.innerHTML = v.portOpen
      ? '<span style="color:var(--green)">端口在监听</span>'
      : '<span class="sl-adv-dim">端口未监听</span>';
  }
  const ws = $('#conn-ws');
  if (ws) ws.textContent = String(v.proto.wsUrl || '（未设置）');
  const http = $('#conn-http');
  if (http) http.textContent = String(v.proto.httpUrl || '（未设置）');

  const self = $('#conn-self');
  if (self) {
    self.innerHTML = v.connected
      ? `${esc(v.nick || '已登录')}${v.selfId ? ` <em style="opacity:.65;font-style:normal">${esc(v.selfId)}</em>` : ''}`
      : '<span class="sl-adv-dim">未连接</span>';
  }
  const diag = $('#conn-diag');
  if (diag) {
    diag.textContent = v.connected
      ? '连接正常，能收发群消息'
      : (v.diag || '还没连上 —— 先确认协议端在运行、机器人 QQ 已登录');
  }

  // 日志：内容没变就不动 DOM（避免滚动位置与文本选择被无谓重置）
  const pre = $('#conn-logs-view');
  if (pre) {
    const { text, arr } = connLogText(appLogsData);
    if (pre.textContent !== text) {
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
      pre.textContent = text;
      pre.classList.toggle('is-empty', !arr.length);
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    }
  }

  // 协议端进程面板（2026-10-27）：状态徽标、按钮可用态、日志滚动
  if (procData) connApplyProc(procData);
  // 单卡：状态/文案/按钮跟着刷新（阶段变了才整卡重绘）
  connAutoApply(v, procData);
}

/**
 * 把协议端进程状态刷进已渲染的面板。
 * 单独抽出来是因为它有**三个**调用方：整页渲染后的初次绑定、15 秒 quiet 刷新、
 * 以及 SSE 的 protocol-log / protocol-status 事件 —— 三处必须走同一套 DOM 更新，
 * 否则会出现"日志在滚但按钮还是灰的"这种半截状态。
 */
function connApplyProc(procData) {
  const proc = procData && procData.status ? procData.status : null;
  if (!proc) return;
  connProcCache = { status: proc, logs: (procData && procData.logs) || connProcCache.logs || [] };
  const view = connProcView(proc);
  const chip = $('#conn-proc-chip');
  if (chip) {
    chip.className = `conn-proc-chip is-${view.cls}`;
    chip.textContent = view.text;
  }
  const startBtn = $('#conn-proc-start');
  if (startBtn) startBtn.disabled = !view.canStart;
  // 两个停止入口：步骤 1 卡片里一枚（引导态）、折叠区里一枚（已就绪态），
  // 同一套动作，所以两枚一起改状态
  for (const sel of ['#conn-proc-stop', '#conn-proc-stop2']) {
    const b = $(sel);
    if (b) b.disabled = !view.running;
  }
  const stateText = $('#conn-proc-state');
  if (stateText) {
    // 2026-10-27（R129）：这一行**只放目录**。状态由 #conn-proc-chip 表达 ——
    // 早先两处都写「状态 · 目录」，同一句话在一张卡里出现两遍。
    const dir = String(proc.dir || proc.configuredDir || '');
    stateText.textContent = dir || '还没指定目录';
    stateText.title = dir || '';
  }
  const auto = $('#conn-proc-auto');
  if (auto) auto.checked = Boolean(proc.autoLaunch);
  const dirInput = $('#conn-proc-dir');
  // 输入框里正打着字就别覆盖（老坑：15 秒刷新把用户输入重置）
  if (dirInput && document.activeElement !== dirInput) {
    dirInput.value = String(proc.dir || proc.configuredDir || '');
  }
  const meta = $('#conn-proc-meta');
  if (meta) meta.textContent = `最近 ${(procData.logs || []).length} 条${proc.pid ? ` · pid ${proc.pid}` : ''}`;
  connRenderProcLog(procData.logs);
}

/** 只重绘日志 pre（内容相同就不动，保住滚动位置与选中文本）。 */
function connRenderProcLog(logs) {
  const pre = $('#conn-proc-log');
  if (!pre) return;
  const { text, arr } = connProcLogText(logs);
  if (pre.textContent === text) return;
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
  pre.textContent = text;
  pre.classList.toggle('is-empty', !arr.length);
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

/**
 * SSE 收到一批协议端日志：追加进缓存并只重绘日志面板。
 * 上限与后端一致（800 行），避免长时间挂着页面把内存吃满。
 */
function connAppendProtocolLog(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  if (!arr.length) return;
  const merged = connProcCache.logs.concat(arr);
  connProcCache.logs = merged.length > 800 ? merged.slice(merged.length - 800) : merged;
  connRenderProcLog(connProcCache.logs);
  const meta = $('#conn-proc-meta');
  if (meta) {
    const pid = connProcCache.status?.pid;
    meta.textContent = `最近 ${connProcCache.logs.length} 条${pid ? ` · pid ${pid}` : ''}`;
  }
}

/** 手动「重新检测」：只重读一次状态并把结论写回页面。
    不重建整页 —— 端点设置里可能正有用户输入一半的地址（老坑）。 */
async function connRecheck(btn) {
  if (!btn || btn.disabled) return;
  const note = $('#conn-check-note');
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '检测中…';
  try {
    let s = await api('/api/status').catch(() => null);
    if (!s) { if (note) note.textContent = '读不到状态：后端没有应答。'; return; }
    let nv = connView(s);

    // 2026-10-24：端口通了但仍没连上，最常见的不是"账号没登录"，而是**令牌没填**
    // （SnowLuma 每个账号随机生成一对，两枚还不一样）。这一步先替用户去协议端的
    // config/onebot_<QQ号>.json 里读一次 —— 读到了就连上了，省掉他去 WebUI 抄两串
    // 43 位字符串。已经是通的、或端口没开都不试（避免无谓的 PowerShell 探测）。
    let fillNote = '';
    if (!nv.connected && nv.portOpen) {
      const filled = await api('/api/protocol/autofill', {
        method: 'POST',
        body: JSON.stringify({})
      }).catch(() => null);
      if (filled && filled.applied) {
        s = await api('/api/status').catch(() => s);
        nv = connView(s);
        fillNote = `✓ 已自动读取协议端配置（账号 ${filled.uin || '?'}）`;
      } else if (filled && filled.found === false) {
        fillNote = '没找到 SnowLuma 的配置文件';
      } else if (filled && filled.found && !filled.applied) {
        fillNote = filled.reason || '端点与令牌已是最新';
      }
    }

    updateConnectionLive(nv, connLogsCache);
    if (note) {
      note.textContent = nv.connected
        ? `${fillNote ? `${fillNote}，` : ''}✓ 已连上（${nv.nick || '机器人'}）`
        : nv.portOpen
          ? (fillNote
            ? `${fillNote} —— 仍然没连上，检查机器人 QQ 是否已登录。`
            : '端口通了，但仍没连上 —— 检查令牌，以及机器人 QQ 是否已登录。')
          : '端口还是没监听 —— 确认协议端已经启动、端口没填错。';
    }
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

async function loadConnectionPage({ quiet = false } = {}) {
  const boxEarly = $('#connection-page');
  if (!boxEarly) return;

  // 骨架先行：进页签时接口要跑一瞬，空容器就是"黑屏"。
  // 只在还没有正式内容时铺（quiet 刷新不动它，避免闪烁）。
  if (!boxEarly.querySelector('.auto-page') && !boxEarly.querySelector('.snowluma-error-card')) {
    boxEarly.innerHTML = `
      <div class="snowluma-page-card">
        <h2>连接</h2>
        <div class="sk-block">${'<div class="sk-row"></div>'.repeat(6)}</div>
        <div class="hint" style="margin-top:10px">正在读取连接状态…</div>
      </div>`;
  }

  const [status, appLogsData, procData] = await Promise.all([
    api('/api/status').catch(() => null),
    api('/api/logs?limit=200').catch(() => ({ logs: [], level: 'info' })),
    // 协议端进程（2026-10-27）：状态 + 最近日志。失败就当没这功能，不影响连接页本身。
    api('/api/protocol/process?limit=300').catch(() => null)
  ]);

  const box = $('#connection-page');
  if (!box) return;   // 页面已被切走

  if (!status) {
    // 只有非 quiet 才把错误卡顶上去：轮询期间的偶发失败不该把已经渲染好的
    // 页面（可能正被用户读着）换成错误页。旧版这里也是同样的口径。
    if (!quiet) {
      box.innerHTML = `
        <div class="snowluma-page-card snowluma-error-card">
          <h2>连接</h2>
          <div class="empty-hint">⚠️ 状态读取失败（后端没有应答）。检查服务是否在运行，然后重试。</div>
          <button class="btn btn-small" id="conn-error-retry-btn" style="margin-top:10px">重试</button>
        </div>`;
      $('#conn-error-retry-btn')?.addEventListener('click', () => loadConnectionPage());
    }
    return;
  }

  const v = connView(status);
  connLogsCache = appLogsData || connLogsCache;   // 手检时复用，免得为刷新状态再拉一次日志
  // 单卡重绘要用的现场（阶段变化时 connAutoRepaint 靠它重建整卡）
  connLastV = v;
  connLastAppLogs = appLogsData || connLastAppLogs;
  if (procData) connLastProcData = procData;

  if (quiet && box.querySelector('.auto-page')) {
    updateConnectionLive(v, appLogsData, procData);
    return;
  }

  box.innerHTML = renderConnectionPage(v, appLogsData, procData);
  bindConnectionPage(box, v, appLogsData, procData);
  // 接入状态要登录控制台再列进程（1~3 秒），不挡首屏：
  // 先按上次缓存渲染，这里异步补一次真实状态。
  if (!quiet) connLoadOnboard({ quiet: true }).catch(() => {});
}

/**
 * 协议端进程面板的事件绑定（2026-10-27，R125）。
 *
 * 为什么不复用「应用日志」那套：那块是只读的；这块有三个会改服务端状态的动作
 * （启动 / 停止 / 自动启动开关），每个都要把"正在做"和"结果"写回按钮与提示，
 * 混在一起会让两边都难读。
 */
function bindConnProc(procData) {
  const panel = $('#conn-proc');
  if (!panel) return;
  connProcCache = {
    status: (procData && procData.status) || null,
    logs: (procData && procData.logs) || []
  };
  panel.addEventListener('toggle', () => { connProcOpen = panel.open; });

  const hint = (msg) => {
    const h = $('#conn-proc-hint');
    if (h) h.textContent = msg || '';
  };
  /**
   * 当前该用哪个目录启动。
   *
   * ⚠️ 不能只读 `#conn-proc-dir` 输入框：那个输入框只在**网页版**（没有
   * `window.qqaDesktop.pickDirectory`）才渲染。桌面版走的是「选择文件夹」系统对话框，
   * 选完只落盘、不留输入框 —— 只读输入框的话，用户明明选过目录，再点「启动」
   * 还会被告知"先填目录"，而且永远填不了。
   */
  const dirVal = () => {
    const typed = String($('#conn-proc-dir')?.value || '').trim();
    if (typed) return typed;
    const st = connProcCache.status || {};
    return String(st.dir || st.configuredDir || '').trim();
  };
  const refresh = async () => {
    const d = await api('/api/protocol/process?limit=300').catch(() => null);
    if (d && d.ok) connApplyProc(d);
    return d;
  };
  /** 跑一个会改状态的请求：按钮禁用 + 文案回填 + 结束刷新。 */
  const run = async (btn, busyText, fn) => {
    if (!btn || btn.disabled) return;
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyText;
    try {
      await fn();
    } finally {
      btn.textContent = old;
      // 结束后按最新状态重算可用态（而不是盲目恢复可用）
      connApplyProc(connProcCache);
    }
  };

  // ⚠️ 「帮我找」不在这里绑（R135 修双绑）：#conn-proc-find 只出现在状态卡的
  // 三步引导里（connAutoBody 网页版分支），bindAutoCard 的事件委托已经处理它
  // （connFindDir：落盘目录 + 自动推进）。这里再绑一次的话，点一下会跑两遍
  // /api/protocol/detect，还把两处提示（#conn-proc-hint 与 #conn-check-note）
  // 各写一遍、互相覆盖。

  $('#conn-proc-start')?.addEventListener('click', (e) => run(e.currentTarget, '启动中…', async () => {
    const dir = dirVal();
    if (!dir) {
      // 没装的人最可能点这里。别只说"先填目录"——他连目录是什么都还不知道，
      // 直接把他引回上面那三步里的最后一步。
      hint('还没有协议端目录 —— 先按上面的第 3 步点「选择文件夹」（或「帮我找」）指定 SnowLuma 解压后的位置');
      return;
    }
    hint('正在无窗口启动…（几秒后日志会开始滚动）');
    const r = await api('/api/protocol/process/launch', {
      method: 'POST',
      body: JSON.stringify({ dir })
    }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    if (r && r.ok) {
      hint(`已启动（pid ${r.pid || '?'}）—— 等它打印 WebUI 地址与 OneBot 端口，连上后本页会自动变绿`);
      if (r.status) connApplyProc({ status: r.status, logs: connProcCache.logs });
    } else {
      hint(`启动失败：${(r && r.error) || '未知原因'}`);
    }
    await refresh();
    // 协议端起来了 → 「一键接入」那块的阶段也变了（stopped → booting/need-password），
    // 顺手刷一次，省得用户还要再点一次"重新检测"
    connLoadOnboard({ quiet: true }).catch(() => {});
  }));

  $('#conn-proc-stop')?.addEventListener('click', (e) => run(e.currentTarget, '停止中…', async () => {
    hint('正在停止…');
    const r = await api('/api/protocol/process/stop', { method: 'POST', body: '{}' })
      .catch((err) => ({ ok: false, error: String(err?.message || err) }));
    hint(r && r.ok ? '已停止（机器人会随之离线）' : `停止失败：${(r && r.error) || '未知原因'}`);
    await refresh();
    connLoadOnboard({ quiet: true }).catch(() => {});
  }));

  // 折叠区里那枚「停止协议端」：与上面同一套动作（两个入口，避免用户为了停一下
  // 还得先让页面回到"未启动"状态）
  $('#conn-proc-stop2')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '停止中…';
    try {
      const r = await api('/api/protocol/process/stop', { method: 'POST', body: '{}' })
        .catch((err) => ({ ok: false, error: String(err?.message || err) }));
      if (!r || !r.ok) hint(`停止失败：${(r && r.error) || '未知原因'}`);
    } finally {
      btn.textContent = old;
      await refresh();
      connLoadOnboard({ quiet: true }).catch(() => {});
    }
  });

  $('#conn-proc-auto')?.addEventListener('change', async (e) => {
    const on = Boolean(e.currentTarget.checked);
    hint(on ? '下次启动 QQ Agent 时会自动拉起协议端' : '已关闭自动启动');
    const r = await api('/api/protocol/process/config', {
      method: 'POST',
      body: JSON.stringify({ autoLaunch: on })
    }).catch(() => null);
    if (r && r.status) connApplyProc({ status: r.status, logs: connProcCache.logs });
    else e.currentTarget.checked = !on;   // 保存失败就回弹，别让界面说谎
  });

  $('#conn-proc-refresh')?.addEventListener('click', (e) => run(e.currentTarget, '刷新中…', async () => {
    await refresh();
    hint('已刷新');
  }));
}

/* ── 单卡的交互：一次点击自己往下推 ──────────────────────────────────────
 *
 * 用户点「一键连接」后，前端循环调 /api/protocol/onboard 看现在卡在哪，
 * 能自己做的（启动进程 / 登录 / 注入）直接做掉，只在"必须他本人"的地方停下。
 * 为什么放在前端而不是后端一个长请求：每一小步都要能立刻改文案（"正在启动…"
 * → "正在连接 QQ…"），长请求期间页面只能干等。
 */
let connLastV = null;
let connLastAppLogs = null;
let connLastProcData = null;
let connLastStage = '';
let connAutoPw = '';

const connSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 整卡重绘（阶段变化时用；比逐字段改 DOM 可靠）。 */
function connAutoRepaint() {
  if (!connLastV) return;
  const page = document.querySelector('.auto-page');
  if (!page) return;
  const holder = document.createElement('div');
  holder.innerHTML = renderConnectionPage(connLastV, connLastAppLogs, connLastProcData);
  const fresh = holder.firstElementChild;
  if (!fresh) return;
  page.replaceWith(fresh);
  bindConnectionPage(fresh, connLastV, connLastAppLogs, connLastProcData);
  const pw = $('#conn-onboard-pw');
  if (pw && connAutoPw) pw.value = connAutoPw;
}

/** 阶段没变时只改文字，避免 15 秒一次的轮询把整页重绘（会闪）。 */
function connAutoApply(v, procData) {
  if (!v) return;
  connLastV = v;
  if (procData) connLastProcData = procData;
  const proc = (connLastProcData && connLastProcData.status) || null;
  const stage = connAutoStage(v, proc, connOnboardCache);
  if (stage !== connLastStage) {
    connLastStage = stage;
    connAutoRepaint();
    return;
  }
  const copy = CONN_AUTO_COPY[stage] || CONN_AUTO_COPY.error;
  const card = $('#conn-auto-card');
  if (!card) return;
  const t = $('#conn-verdict-title');
  if (t && t.textContent !== copy.title) t.textContent = copy.title;
  const sub = $('#conn-verdict-sub');
  if (sub && sub.textContent !== copy.sub) sub.textContent = copy.sub;
  // 在线时长会随时间变：15 秒一次的轮询顺带把它刷新掉，否则"已在线 3 分钟"
  // 会一直停在页面刚打开时的那个数
  const uptimeEl = $('#conn-auto-id i');
  if (uptimeEl) {
    const next = connUptime(v.connectedAt);
    if (next && uptimeEl.textContent !== next) uptimeEl.textContent = next;
  }
}

/** 拉一次接入状态并刷新单卡。 */
async function connLoadOnboard({ quiet = false } = {}) {
  const ob = await api('/api/protocol/onboard').catch(() => null);
  connOnboardCache = (ob && ob.available !== false) ? ob : null;
  connAutoApply(connLastV, connLastProcData);
  return ob;
}

/** 打开连接组件的控制台（EULA 要求"同意条款/改密码"必须用户本人操作）。 */
async function connOpenConsole() {
  const bridge = window.qqaDesktop?.openProtocolConsole;
  if (typeof bridge === 'function') {
    try {
      const r = await bridge('snowluma');
      return r?.ok ? '已用默认浏览器打开它的控制台' : `没打开：${r?.error || '未知原因'}`;
    } catch { /* 落到复制 */ }
  }
  try {
    await navigator.clipboard.writeText('http://localhost:5099');
    return '已复制控制台地址，粘贴到浏览器打开';
  } catch {
    return '控制台地址：http://localhost:5099';
  }
}

/**
 * 自动推进：能自己做的做完，卡住就停。
 * @param {string} pw 用户刚填的控制台密码（没有就传空）
 */
async function connAutopilot(pw = '') {
  const btn = $('#conn-auto-btn');
  const oldText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '正在处理…'; }
  const note = $('#conn-check-note');
  try {
    for (let i = 0; i < 30; i++) {
      const s = await api('/api/protocol/onboard').catch(() => null);
      if (!s || s.available === false) break;
      connOnboardCache = s;
      connAutoApply(connLastV, connLastProcData);

      if (s.stage === 'ready') break;

      if (s.stage === 'stopped') {
        if (note) note.textContent = '正在启动连接组件…';
        const r = await api('/api/protocol/process/launch', { method: 'POST', body: JSON.stringify({}) })
          .catch(() => null);
        if (!r || !r.ok) {
          if (note) note.textContent = `启动失败：${(r && r.error) || '未知原因'}`;
          break;
        }
        await connSleep(1600);
        continue;
      }

      if (s.stage === 'booting') {
        if (note) note.textContent = '等它的控制台就绪…';
        await connSleep(1500);
        continue;
      }

      if (s.stage === 'can-inject' || s.stage === 'wrong-target') {
        if (note) note.textContent = '正在把机器人接到 QQ 上…';
        await api('/api/protocol/onboard/connect', {
          method: 'POST',
          body: JSON.stringify({ password: pw })
        }).catch(() => null);
        await connSleep(900);
        continue;
      }

      // 剩下的都是"必须用户本人"：密码 / 同意条款 / 改密码 / 登录 QQ / 选号
      break;
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
    await connLoadOnboard({ quiet: true });
    if (typeof refreshStatus === 'function') refreshStatus();
    if (note) setTimeout(() => { if (note.textContent) note.textContent = ''; }, 4000);
  }
}

/** 主按钮：按当前处境分派。 */
async function connAutoGo() {
  const v = connLastV;
  const proc = (connLastProcData && connLastProcData.status) || null;
  const stage = connAutoStage(v, proc, connOnboardCache);
  const note = $('#conn-check-note');
  const say = (msg) => { if (note) note.textContent = msg || ''; };

  if (stage === 'no-component') {
    // 这一步的主按钮已经取消（卡片里是三步引导，各自带按钮），这里只兜底
    window.open(CONN_DOWNLOAD_URL, '_blank', 'noopener');
    say('下载解压好之后，回来点「选择文件夹」');
    return;
  }
  if (stage === 'need-password') {
    const pw = String($('#conn-onboard-pw')?.value || '').trim();
    if (!pw) { say('先把这个密码填上'); return; }
    connAutoPw = pw;
    // R135 修「填了密码点连接，什么都没发生」：旧实现直接进 connAutopilot，
    // 而它的循环只在 can-inject / wrong-target 阶段才带密码调 connect ——
    // need-password 阶段第一轮就 break，密码根本没提交给后端。
    // 后端 connect({password}) 本来就支持"带密码连一次"（存密码 + 解除退避），
    // 所以这里先把密码提交，再让 autopilot 接着推进到 ready。
    const r = await api('/api/protocol/onboard/connect', {
      method: 'POST',
      body: JSON.stringify({ password: pw })
    }).catch((err) => ({ ok: false, message: String(err?.message || err) }));
    if (r && r.ok === false && r.message) say(`密码没通过：${r.message}`);
    await connAutopilot(pw);
    return;
  }
  if (stage === 'pick') {
    const el = document.querySelector('input[name="conn-onboard-pid"]:checked');
    const pid = el ? Number(el.value) : 0;
    if (!pid) { say('先选一个 QQ'); return; }
    const r = await api('/api/protocol/onboard/connect', {
      method: 'POST',
      body: JSON.stringify({ pid })
    }).catch(() => null);
    if (r && r.ok) say('已接入');
    else say((r && r.message) || '接入没成功');
    await connLoadOnboard({ quiet: true });
    if (typeof refreshStatus === 'function') refreshStatus();
    return;
  }
  if (stage === 'consent' || stage === 'must-change' || stage === 'need-totp') {
    say(await connOpenConsole());
    return;
  }
  if (stage === 'need-qq' || stage === 'error' || stage === 'locked') {
    await connLoadOnboard({ quiet: true });
    if (typeof refreshStatus === 'function') refreshStatus();
    return;
  }
  // not-running / can-connect / checking
  await connAutopilot('');
}

/** SnowLuma 下载页（官方发行包）。放常量是为了 UI 里两处引用不会写岔。 */
const CONN_DOWNLOAD_URL = 'https://github.com/SnowLuma/SnowLuma/releases';

/**
 * 「选择文件夹」：调系统对话框让用户点选，而不是手抄路径。
 *
 * 为什么这条比什么都重要：让完全不懂的人照着 `C:\Users\xxx\Desktop\SnowLuma-v2.1.1-win-x64`
 * 手动敲一遍，反斜杠、版本号、解压多一层目录 —— 任何一处错都表现为"填了没反应"，
 * 而他根本不知道自己错在哪。点选文件夹把这件事变成"用鼠标点两下"。
 */
async function connPickFolder(btn) {
  const note = $('#conn-check-note');
  const say = (m) => { if (note) note.textContent = m || ''; };
  const bridge = window.qqaDesktop?.pickDirectory;
  if (typeof bridge !== 'function') { say('网页版弹不出文件夹选择框，请手动填路径'); return; }
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '等你选…';
  try {
    const r = await bridge('选择 SnowLuma 解压后的那个文件夹');
    if (!r || r.canceled) return;
    if (!r.ok) { say(r.error || '选不了这个文件夹'); return; }
    say('已选好，正在检查…');
    // 先落盘再试跑：目录不对（没有 index.mjs）会在启动这一步报出来，
    // 报错文案是"这个目录里没有 index.mjs"，够他判断自己是不是选错层了。
    await api('/api/protocol/process/config', { method: 'POST', body: JSON.stringify({ dir: r.dir }) })
      .catch(() => null);
    await connAutopilot('');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/** 「帮我找」：先看正在跑的进程，再扫常见安装位置。 */
async function connFindDir(btn) {
  const note = $('#conn-check-note');
  const say = (m) => { if (note) note.textContent = m || ''; };
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '找着呢…';
  try {
    const r = await api('/api/protocol/detect').catch(() => null);
    if (r && r.dir) {
      say(`找到了：${r.dir}`);
      await api('/api/protocol/process/config', { method: 'POST', body: JSON.stringify({ dir: r.dir }) })
        .catch(() => null);
      await connAutopilot('');
      return;
    }
    say('没找到 —— 先按上面三步装好，再点一次');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/** 单卡内的事件（委托，避免每次重绘重复绑定）。 */
function bindAutoCard() {
  const card = $('#conn-auto-card');
  if (!card) return;
  card.onclick = (e) => {
    if (e.target.closest('[data-auto-go]')) { connAutoGo(); return; }
    if (e.target.closest('[data-auto-download]')) {
      window.open(CONN_DOWNLOAD_URL, '_blank', 'noopener');
      const note = $('#conn-check-note');
      if (note) note.textContent = '下载解压好之后，回来点「选择文件夹」';
      return;
    }
    const pick = e.target.closest('[data-auto-pick]');
    if (pick) { connPickFolder(pick); return; }
    const find = e.target.closest('#conn-proc-find') || e.target.closest('[data-auto-find]');
    if (find) { connFindDir(find); return; }
  };
  card.oninput = (e) => {
    if (e.target.id === 'conn-onboard-pw') connAutoPw = e.target.value;
  };
  // 填完目录（失焦/回车）就直接往下走：用户不需要再找一次"确定"
  card.onchange = async (e) => {
    if (e.target.id !== 'conn-proc-dir') return;
    const dir = String(e.target.value || '').trim();
    if (!dir) return;
    await api('/api/protocol/process/config', { method: 'POST', body: JSON.stringify({ dir }) }).catch(() => null);
    await connAutopilot('');
  };
}

function bindConnectionPage(box, v, appLogsData, procData) {
  // 机器人头像的失败兜底（2026-10-27，R132）：一次绑定，之后所有重绘共用
  bindConnAvatarFallback();
  // ── 手动重新检测（页头一枚 + 安装说明底部一枚，同一套逻辑）──
  $('#conn-recheck-btn')?.addEventListener('click', (e) => connRecheck(e.currentTarget));
  $('#conn-setup-recheck')?.addEventListener('click', (e) => connRecheck(e.currentTarget));
  // 安装说明的开合态要记住，否则下一次渲染会被"按连接状态自动决定"覆盖掉
  const setup = $('#conn-setup');
  if (setup) setup.addEventListener('toggle', () => { connSetupOpen = setup.open; });
  // 协议端进程面板（2026-10-27）：开合态 + 启动/停止/自动查找/自动启动
  bindConnProc(procData);
  // 单卡的主按钮与输入（事件委托，重绘后不用重新绑）
  bindAutoCard();

  // ── 协议端控制台（WebUI）：打开 / 复制 ──
  // 「打开」走 preload 的 openProtocolConsole(which)：只传枚举键，地址由主进程写死。
  // 网页版控制台没有这个桥，就退回"复制地址"，别让按钮点了没反应。
  for (const btn of $$('[data-console-open]')) {
    btn.addEventListener('click', async () => {
      // 反馈位优先用协议端卡里那一行（#conn-proc-hint），回退到父元素里的
      // [data-console-hint]（旧结构留下的约定）。两者都没有就静默 —— 那是旧版
      // "点了没反应"的来源，所以新结构一定给 #conn-proc-hint。
      const hint = $('#conn-proc-hint') || btn.parentElement?.querySelector('[data-console-hint]');
      const bridge = window.qqaDesktop?.openProtocolConsole;
      if (typeof bridge !== 'function') {
        // 网页版没有桌面桥，退回复制地址。旧实现只从父元素的 [data-console-copy]
        // 取地址 —— 协议端卡的结构里根本没有那个元素，于是**复制了空串**还提示
        // "已复制"，用户粘贴出来是空的。这里兜底到协议端 WebUI 的默认地址
        // （与 connOpenConsole 的剪贴板回退同一地址）。
        const url = btn.parentElement?.querySelector('[data-console-copy]')?.dataset.consoleCopy || 'http://localhost:5099';
        try {
          await navigator.clipboard.writeText(url);
          if (hint) hint.textContent = '已复制，粘贴到浏览器打开';
        } catch {
          if (hint) hint.textContent = '请手动选中地址复制';
        }
        return;
      }
      btn.disabled = true;
      try {
        const r = await bridge(btn.dataset.consoleOpen || '');
        if (hint) hint.textContent = r?.ok ? '已用默认浏览器打开' : `没打开：${r?.error || '未知原因'}`;
      } catch (e) {
        if (hint) hint.textContent = `没打开：${(e && e.message) || e}`;
      } finally {
        btn.disabled = false;
      }
    });
  }
  for (const btn of $$('[data-console-copy]')) {
    btn.addEventListener('click', async () => {
      const hint = btn.parentElement?.querySelector('[data-console-hint]');
      try {
        await navigator.clipboard.writeText(btn.dataset.consoleCopy || '');
        if (hint) hint.textContent = '已复制';
      } catch {
        if (hint) hint.textContent = '复制失败，请手动选中地址';
      }
    });
  }

  // ── 折叠区展开态 ──
  const adv = $('#conn-adv');
  if (adv) adv.addEventListener('toggle', () => { connAdvOpen = adv.open; });
  const logs = $('#conn-logs');
  if (logs) {
    logs.addEventListener('toggle', () => { connLogsOpen = logs.open; });
    // 用户手点 summary 展开时贴底：他想看的是"最后发生了什么"。
    // ⚠️ 监听 summary 的 click 而不是 details 的 toggle —— toggle 在程序化
    //    open 时也会触发（旧版踩过：15 秒重建后把阅读位置又拽回末尾）。
    logs.querySelector('summary')?.addEventListener('click', () => {
      requestAnimationFrame(() => {
        const pre = $('#conn-logs-view');
        if (pre && logs.open) pre.scrollTop = pre.scrollHeight;
      });
    });
  }

  // ── 自动读取协议端配置（2026-10-24）──
  // 直接读 SnowLuma 的 config/onebot_<QQ号>.json，拿到端口和两枚令牌后落盘 + 重连。
  // 手动触发带 force：以协议端当前配置为准覆盖（用户点这个按钮就是这个意思）。
  // 令牌不会回传到页面（后端 publicView 已删除），所以这里只显示账号与结果。
  const autofillBtn = $('#conn-autofill-btn');
  if (autofillBtn) autofillBtn.addEventListener('click', async () => {
    const hint = $('#conn-save-hint');
    const oldText = autofillBtn.textContent;
    autofillBtn.disabled = true;
    autofillBtn.textContent = '读取中…';
    if (hint) hint.textContent = '';
    try {
      const r = await api('/api/protocol/autofill', {
        method: 'POST',
        body: JSON.stringify({ force: true })
      });
      if (hint) {
        if (r && r.applied) hint.textContent = `✓ 已读取（账号 ${r.uin || '?'}），正在用新端点重连…`;
        else if (r && r.found) hint.textContent = r.reason || '已读取，但无需改动';
        else hint.textContent = (r && r.reason) || '没找到协议端配置';
      }
      if (r && r.applied) setTimeout(() => loadConnectionPage({ quiet: true }), 1200);
    } catch (e) {
      if (hint) hint.textContent = `读取失败：${e.message}`;
    } finally {
      autofillBtn.disabled = false;
      autofillBtn.textContent = oldText;
    }
  });

  // ── 保存端点（保存 + 立刻重连，不用重启）──
  const saveBtn = $('#conn-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const hint = $('#conn-save-hint');
    const wsUrl = String($('#conn-wsurl')?.value || '').trim();
    const httpUrl = String($('#conn-httpurl')?.value || '').trim();
    const wsToken = String($('#conn-wstoken')?.value || '').trim();
    const httpToken = String($('#conn-httptoken')?.value || '').trim();
    if (!wsUrl || !httpUrl) {
      if (hint) hint.textContent = '两个地址都要填（默认 ws://127.0.0.1:3001 与 http://127.0.0.1:3000）';
      return;
    }
    saveBtn.disabled = true;
    const oldText = saveBtn.textContent;
    saveBtn.textContent = '保存中…';
    if (hint) hint.textContent = '';
    try {
      const r = await api('/api/protocol/apply', {
        method: 'POST',
        body: JSON.stringify({ wsUrl, httpUrl, accessToken: wsToken, httpAccessToken: httpToken })
      });
      if (r && r.ok) {
        if (hint) {
          hint.textContent = r.applied === false
            ? `已保存，但重连没跑起来：${r.error || '未知原因'} —— 重启应用后一定生效`
            : '✓ 已保存，正在用新地址重连…';
        }
        setTimeout(() => loadConnectionPage({ quiet: true }), 1200);
      } else if (hint) {
        hint.textContent = `保存失败：${(r && r.error) || '未知错误'}`;
      }
    } catch (e) {
      if (hint) hint.textContent = `保存失败：${e.message}`;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = oldText;
    }
  });

  // ── 测试连接：重读状态并给一句人话结论（不新增后端接口）──
  const testBtn = $('#conn-test-btn');
  if (testBtn) testBtn.addEventListener('click', async () => {
    const hint = $('#conn-save-hint');
    testBtn.disabled = true;
    const oldText = testBtn.textContent;
    testBtn.textContent = '测试中…';
    try {
      const s = await api('/api/status').catch(() => null);
      if (!s) {
        if (hint) hint.textContent = '读不到状态：后端没有应答';
      } else {
        const nv = connView(s);
        updateConnectionLive(nv, appLogsData);
        if (hint) {
          hint.textContent = nv.connected
            ? `✓ 已连上（${nv.nick || '机器人'}）`
            : (nv.portOpen
              ? '端口是通的，但 OneBot 还没连上 —— 多半是令牌不一致，或机器人 QQ 还没登录'
              : `端口没监听：${nv.proto.wsUrl || '（未设置）'} —— 确认协议端在运行、端口没填错`);
        }
      }
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = oldText;
    }
  });

  // ── 令牌显示 / 隐藏（明文走 /api/onebot-token，与设置页同一条）──
  const wireTokenToggle = (btnId, inputId, which) => {
    const btn = $(btnId);
    const inp = $(inputId);
    if (!btn || !inp) return;
    btn.addEventListener('click', async () => {
      if (btn.dataset.on === '1') {
        inp.value = '******';
        btn.dataset.on = '0';
        btn.textContent = '显示';
        return;
      }
      try {
        const r = await api(`/api/onebot-token?which=${which}`);
        inp.value = String((r && r.token) || '');
        btn.dataset.on = '1';
        btn.textContent = '隐藏';
      } catch (e) {
        const hint = $('#conn-save-hint');
        if (hint) hint.textContent = `读取令牌失败：${e.message}`;
      }
    });
  };
  wireTokenToggle('#conn-wstoken-toggle', '#conn-wstoken', 'ws');
  wireTokenToggle('#conn-httptoken-toggle', '#conn-httptoken', 'http');

  // ── 应用日志：级别切换 + 手动刷新 ──
  const levelSel = $('#app-log-level');
  if (levelSel) levelSel.addEventListener('change', async () => {
    try {
      const r = await api('/api/logs/level', { method: 'POST', body: JSON.stringify({ level: levelSel.value }) });
      if (r && r.level) levelSel.value = r.level;
      loadConnectionPage({ quiet: true });
    } catch (e) {
      qaAlert(`设置日志级别失败：${e.message}`);
    }
  });
  $('#app-logs-refresh-btn')?.addEventListener('click', () => loadConnectionPage());

  // ── 复制诊断信息（反馈用）：全部来自本页已取到的状态与日志，不新增请求 ──
  const copyBtn = $('#conn-copy-diag');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const hint = $('#conn-copy-hint');
    const { arr } = connLogText(appLogsData);
    const CLUE_RE = /error|fail|失败|EADDR|ECONN|EACCES|refuse|denied|timeout|超时|断开|异常|invalid|token|令牌/i;
    const clues = arr
      .filter((e) => CLUE_RE.test(String(e.text || '')))
      .slice(-5)
      .map((e) => `  [${new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false })}] ${String(e.text).slice(0, 140)}`);
    const lines = [
      '[QQ Agent 连接诊断] ' + new Date().toLocaleString('zh-CN', { hour12: false }),
      '结论: ' + (v.connected ? '已连接' : (v.portOpen ? '端口在监听但未连上' : '协议端未运行 / 端口未监听')),
      'WS 地址: ' + (v.proto.wsUrl || '（未设置）'),
      'HTTP 地址: ' + (v.proto.httpUrl || '（未设置）'),
      '端口监听: ' + (v.portOpen ? '是' : '否'),
      'OneBot: ' + (v.connected ? `已连接 ${v.nick || ''} ${v.selfId || ''}`.trim() : '未连接'),
      '后端诊断: ' + (v.diag || '（无）'),
      '最近可疑日志:',
      ...(clues.length ? clues : ['  （无）'])
    ].join('\n');
    try {
      await navigator.clipboard.writeText(lines);
      if (hint) hint.textContent = '已复制，可直接粘贴反馈 ✓';
    } catch (e) {
      if (hint) hint.textContent = `复制失败：${(e && e.message) || e}`;
    }
  });
}
