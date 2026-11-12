// 按触发类型分流「本轮需要多重的思考」。
//
// 背景（2026-11-12）：缓存稳态命中约 90% 之后，开销大头转到输出，而输出的
// ~90% 是 reasoning token —— 当前网关默认开思考且档位偏高，**拍一拍、纯图片、
// 接一句闲聊也在烧几百 reasoning token**。但一刀切把 api.thinkingMode 改成 off
// 会让被 @ 的复杂请求明显降质，所以改成「按本轮触发内容给一个意图档」。
//
// 这里只输出**意图**（off / light / full / passthrough），刻意不碰 mode/effort：
//   · 什么参数能关思考、什么参数能降档，是模型/网关方言的事，归
//     plugins/thinking-adapters 管（同一个意图在 generic 方言上就是不发参数）；
//   · 本模块保持纯函数、零依赖，方便单测和拿历史会话存档做离线标定。
//
// 判定只吃「发请求前就确定」的信号，绝不依赖模型本轮回了什么 —— 这样分流结果
// 在一轮工具循环里是稳定的，不会出现第 1 轮 off、第 2 轮突然 on 的抖动。
//
// ⚠️ 偏向保守：拿不准时宁可给 full（保持原有 auto 行为，只是这轮没省到），
//    也不要误给 off（可能让该思考的请求降质）。降本是收益，答非所问是事故。

/** 意图档位。passthrough = 本轮不路由，完全按主设置/按次覆盖走。 */
export const ROUTE_TIERS = Object.freeze({
  PASSTHROUGH: 'passthrough',
  OFF: 'off',
  LIGHT: 'light',
  FULL: 'full'
});

export const DEFAULT_THRESHOLDS = Object.freeze({
  shortChatter: 8,   // 去标记后 ≤ 8 字符且无召唤/媒体/问句 → 纯附和
  longText: 120,     // 单条实质文本 ≥ 120 字符 → 复杂
  longTotal: 160     // 触发批合计 ≥ 160 字符 → 复杂
});

// 明确要「动脑 / 动工具」的请求。命中即回到 full（不干预），宁可少省一点。
// 刻意不含「吗 / 吧 / 啊」这类语气词：群里绝大多数是角色扮演闲聊，命中率太高。
const TASK_RE = /(?:帮我|麻烦|请(?:帮|问|给|查|写|解释|分析)|查一下|查查|搜一下|搜索|查找|找一下|算一下|计算|写一篇|写段|写代码|代码|脚本|总结|汇总|翻译|解释一下|为什么|为啥|怎么回事|怎么办|怎么处理|怎么|如何|区别|对比|列出|列个|计划|安排|提醒|定时|设个闹钟|设置|生成|画一张|分析|推理|证明|推荐|有多少|多少钱|几点|有没有|能不能|可以吗|什么意思|是什么|对不对)/;

// 从文本里剥掉协议标记，得到「人真正打出来的字」。
// 目的：@小鲸鱼[AI](QQ:10001) 这种名字不该被算成"内容"，否则一条纯 @
// 会被当成有实质文本，误判成 light 而漏掉本该 off 的轻互动。
function stripMarkup(text) {
  return String(text ?? '')
    // 引用块要允许一层嵌套方括号：名字里常见 "[AI]"，写成 [^\]]* 会在
    // "[引用 小鲸鱼[AI]…" 处提前收尾，被引用的正文反而泄漏进实质文本。
    .replace(/\[引用(?:[^\[\]]|\[[^\]]*\])*\]/g, '')
    .replace(/\(QQ:\d+\)/gi, '')
    .replace(/@[^\s，,。!?！？;；]{1,40}/g, '') // @提及段（到空白或标点为止）
    .replace(/\[(?:图片|表情\d*|语音|视频|动画表情|戳一戳|合并转发[^\]]*)\]/g, '')
    .replace(/\[[^\]]{1,12}\]/g, '')            // 其它短 CQ 标记兜底
    .replace(/\s+/g, '')
    .trim();
}

function collectSignals({ triggerEntries, atMe, tierInfo, proactive, kind }, thresholds) {
  const entries = Array.isArray(triggerEntries) ? triggerEntries : [];
  let hasQuote = false;
  let imageCount = 0;
  let faceCount = 0;
  let hasAt = Boolean(atMe);
  let poke = String(tierInfo?.reason || '') === '拍了拍我';
  const plainParts = [];
  const lens = [];

  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const raw = String(e.text ?? '');
    if (/\[引用/.test(raw) || e.reply) hasQuote = true;
    if (e.atSelf === true) hasAt = true;
    // 与 resolveContextTier / #strongCallIn 同口径：入库真值优先，正则兜底带尾部边界。
    if (e.isPoke && (e.pokeSelf === true
      || (e.pokeSelf == null && /拍了拍\s*我\s*$/.test(raw)))) poke = true;
    for (const m of (Array.isArray(e.media) ? e.media : [])) {
      if (!m || typeof m !== 'object') continue;
      if (m.kind === 'image') imageCount += 1;
      if (m.kind === 'face') faceCount += 1;
    }
    const plain = stripMarkup(raw);
    if (plain) plainParts.push(plain);
    lens.push(plain.length);
  }

  const plain = plainParts.join('');
  return {
    poke,
    hasAt,
    hasQuote,
    hasImage: imageCount > 0,
    imageCount,
    faceCount,
    hasMedia: imageCount > 0 || faceCount > 0,
    plain,
    plainLength: plain.length,
    maxTextLength: lens.length ? Math.max(...lens) : 0,
    hasQuestion: /[?？]/.test(plain),
    taskWord: TASK_RE.test(plain),
    contextCount: Number(tierInfo?.count) || 0,
    proactive: Boolean(proactive),
    isPrivate: kind === 'private',
    thresholds
  };
}

/**
 * 工具链升档：模型一旦决定调工具，后续「消化工具结果、决定发不发言」明显
 * 比首轮的轻互动更需要推理。分流判定只吃触发批、看不到这一步，所以由编排器
 * 在首轮结束后补一次升级（off → light，只升一档，不回到 full 以免成本反弹）。
 *
 * 返回 null 表示无需升档（light / full / passthrough 都保持原样）。
 * 保持纯函数，方便单测与以后改成"按已用轮数逐级升档"。
 */
export function escalateForTools(route) {
  if (!route || route.tier !== ROUTE_TIERS.OFF || route.routed === false) return null;
  return {
    ...route,
    tier: ROUTE_TIERS.LIGHT,
    reason: `${route.reason} → 工具链升档`
  };
}

/**
 * 计算本轮思考意图档。
 *
 * @param {object}  o
 * @param {Array}   o.triggerEntries  触发批消息（store 条目）
 * @param {boolean} o.atMe            orchestrator 已权威判定的「是否在叫我」
 * @param {object}  o.tierInfo        resolveContextTier 的结果 {tier,count,reason}
 * @param {boolean} o.proactive       主动机会（冷场开话题）
 * @param {string}  o.kind            'group' | 'private'
 * @param {boolean} o.enabled         总开关（cfg.api.thinkingRoute，默认 true）
 * @param {boolean} o.allowOff        是否允许 off 档（cfg.api.thinkingRouteAllowOff，默认 true）；
 *                                    false = 灰度模式，off 一律升为 light（只降档、不关思考）
 * @param {string}  o.baseMode        主设置 api.thinkingMode；非 auto 视为用户显式选择
 * @param {object}  o.thresholds      可选阈值覆盖
 * @returns {{tier:string, reason:string, routed:boolean, signals:object}}
 */
export function routeThinking({
  triggerEntries = [],
  atMe = false,
  tierInfo = null,
  proactive = false,
  kind = 'group',
  enabled = true,
  allowOff = true,
  baseMode = 'auto',
  thresholds = {}
} = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const signals = collectSignals({ triggerEntries, atMe, tierInfo, proactive, kind }, th);
  const mode = String(baseMode ?? '').trim().toLowerCase();
  // 灰度：关思考的风险比降档大，留一个不改源码就能把 off 全升成 light 的口子。
  const off = (reason) => (allowOff
    ? { tier: ROUTE_TIERS.OFF, reason, routed: true, signals }
    : { tier: ROUTE_TIERS.LIGHT, reason: `${reason}（灰度：off→light）`, routed: true, signals });

  // ① 用户在主设置里明确选了 off / on —— 那是全局意图，分流不许覆盖。
  //    开关关闭同理。两者都返回 passthrough，插件侧完全保持旧逻辑。
  if (!enabled) {
    return { tier: ROUTE_TIERS.PASSTHROUGH, reason: '分流开关关闭', routed: false, signals };
  }
  if (mode && mode !== 'auto') {
    return { tier: ROUTE_TIERS.PASSTHROUGH, reason: `主设置显式 ${mode}`, routed: false, signals };
  }

  // ② 复杂请求：保持原行为（auto = 不发参数，平台默认档），一分钱不多花、质量不冒险。
  //    注意 longText/longTotal 只看**去标记后的实质文本**，长 @ 名字不算。
  if (signals.taskWord) {
    return { tier: ROUTE_TIERS.FULL, reason: '命中任务/检索意图词', routed: true, signals };
  }
  if (signals.maxTextLength >= th.longText || signals.plainLength >= th.longTotal) {
    return { tier: ROUTE_TIERS.FULL, reason: '长文本', routed: true, signals };
  }
  if (signals.imageCount >= 2 || (signals.hasQuote && signals.plainLength >= 60)) {
    return { tier: ROUTE_TIERS.FULL, reason: '多图/长引用', routed: true, signals };
  }

  // ③ 主动机会的触发批是空的，但它要自己判断「该不该开口、抛什么话题」，
  //    不能落到下面"无实质文本 → off"那条（否则冷场开场白会变得很生硬）。
  if (signals.proactive) {
    return { tier: ROUTE_TIERS.LIGHT, reason: '主动机会（要判断说不说、聊什么）', routed: true, signals };
  }

  // ④ 轻互动：拍一拍、纯表情、极短附和 —— 只需要「接一句」或发个表情，
  //    不需要先在心里推演一遍要不要说话。这是省 reasoning 的主力。
  if (signals.poke) return off('拍一拍轻召唤');
  // ⚠️ 有图片就不能 off：看图要先判断"要不要调取图工具、图里是什么"，
  //    一刀切关思考会让模型直接跳过图片。纯表情/空文本才走这条。
  if (!signals.plain && !signals.hasQuote && !signals.hasAt && !signals.hasImage) {
    return off('纯表情/无实质文本');
  }
  if (!signals.isPrivate
    && signals.plainLength <= th.shortChatter
    && !signals.hasAt && !signals.hasQuote && !signals.hasImage
    && !signals.hasQuestion) {
    return off('极短附和');
  }

  // ⑤ 其余（@ 一般问答、引用、单图、私聊、随机接话）→ 轻思考。
  //    插件侧会按方言能力翻译成 effort=low；方言不支持降档时再退回 off / 不干预。
  return {
    tier: ROUTE_TIERS.LIGHT,
    reason: '常规对话',
    routed: true,
    signals
  };
}
