// 用量统计（成本看板）：按天 / 按会话 / 按群聚合 data/sessions/*.json 的用量。
//
// 本文件原本是 src/app.js 尾部的 1400 行模块级代码（2026-11-04 拆分，R165）。
// 与 createApp 无闭包耦合 —— 只依赖 config / llm / model-prices / usage-ledger
// 这几个纯函数模块，因此可以整体搬出，app.js 通过 import 使用。
//
// ── 数据源（三层，缺一层都能算，只是精度不同）──────────────────────────────
//   ① sessions/*.json        会话留档（真相源，逐条扫，带缓存）
//   ② usage-daily.json       逐日累计（跨天补齐，避免重复解析大文件）
//   ③ usage-archived-days.json  已归档天的快照（超过保留期的天不再逐条扫）
// 缓存类（usageRowsCache / usageArchive / usageStatsCache）都是模块级单例：
// 同一进程内只此一份，测试可用 resetUsageStatsCache() 清空。
//
// ⚠️ 这里的 3 小时结果缓存（USAGE_STATS_CACHE_TTL_MS）是「顶栏数字停住不动」
//    历史事故的根因之一：桌宠卡片等需要实时的调用方请走 sessions.todayUsage()，
//    不要读这里（见 app.js getUsageToday 的注释）。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { cacheHitRate } from './llm.js';
import {
  isPeakHour, priceAt, resolveModelPrice, modelLabel, splitModelLabel,
  remoteOverrideCount, UNKNOWN_VENDOR
} from './model-prices.js';
import {
  usageLedgerTotals, listUsageLedgerDays, ledgerDayKey, usageLedgerPrunedRecords
} from './usage-ledger.js';

/**
 * 成本看板数据：按天 / 按会话 / 按群聚合最近 N 天的用量。
 *
 * 数据源是 data/sessions/*.json（会话留档），每个会话对象里已有
 * usage.{promptTokens, completionTokens, cachedTokens} 与 chatKey / model / rounds。
 * 没有历史汇总文件也能算 —— 直接扫留档即可。
 */
/**
 * 解析时间范围参数。
 *   'today' → 今天 00:00 起
 *   '24h'   → 最近 24 小时（滚动窗口，可能跨天）
 *   '3'|'7'|'14'|'30' → 最近 N 个自然日
 */
function resolveRange(raw) {
  const s = String(raw || '7').trim().toLowerCase();
  const now = Date.now();
  if (s === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return { mode: 'today', start: d.getTime(), end: now, label: '今天' };
  }
  if (s === '24h') {
    return { mode: '24h', start: now - 24 * 60 * 60 * 1000, end: now, label: '最近 24 小时' };
  }
  // 前端"全部"按钮：不设起始时间。曾经静默回落"近 7 天"（Number('all')||7），
  // 用户以为在看全量历史实际被截断 —— 与"求和一致"的产品口径冲突。
  if (s === 'all') {
    return { mode: 'all', start: 0, end: now, label: '全部' };
  }
  const n = Math.min(30, Math.max(1, Number(s) || 7));
  // 按自然日：从 N-1 天前的 0 点算起，保证"7 天"是 7 个完整日历日
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return { mode: 'days', start: d.getTime() - (n - 1) * 24 * 60 * 60 * 1000, end: now, label: `最近 ${n} 天` };
}

/** 本地时区的 YYYY-MM-DD（用于按天分桶）。 */
export function dayKeyOf(ts) {
  const d = new Date(Number(ts) || 0);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * 收集时间窗内的所有"调用行"。
 * 每行是一次真实 API 调用（有 raw 时）或一次会话聚合（无 raw 时），
 * 都带自己的 token、发生时刻、模型、所属会话。
 */
// ── 用量行缓存 ──
// collectUsageRows 要遍历并 JSON.parse 全部会话文件。实测 300 个文件 / 25MB 时
// 单次约 200ms，而前端每 15 秒轮询一次、stats 与 breakdown 还各扫一遍。
// 会话文件是"结束写一次、之后不再改"，所以缓存很安全。
//
// 失效策略（双保险，任一条命中就重算）：
//   1. 目录快照变化：文件数或目录 mtime 变了（新增/删除会话）
//   2. TTL 到期：20 秒。兜住"内容被改写但目录快照不变"这类边缘情况。
//      原来是 5 秒，但轮询间隔 4 秒、用户切页签的时机又很随机，
//      导致切过去时缓存经常刚好过期 → 每次都走 200ms 的冷启动（"黑一下"）。
//      用量统计不是实时数据，20 秒的新鲜度完全够用。
//      另外前端还有一层：切过去先用上次数据立即渲染，不等网络。
//
// ⚠️ 数据量增长后的实测（2026-09-17，真实部署 2144 个会话 / 172MB）：
//    全量 parse 需要 ~1.9s —— 20 秒 TTL 到期后的每次重算都会把主进程
//    event loop 阻塞近 2 秒，期间 HTTP/SSE/消息处理全部排队 —— 前端表现
//    就是"用量页卡住、整个控制台无响应"。两条治理（同步进 collectUsageRows）：
//    A. **增量解析**：目录快照没变时复用上一轮解析结果（不只 TTL 内 ——
//       sig 相同就复用，只是重做时间窗过滤与派生字段），冷启动只在
//       真有新会话落盘时才发生。TTL 仍然保留，兜"内容被改写"的边缘情况。
//    B. **流式分片解析**：真要冷启动时，把 172MB 的同步 parse 拆成
//       每 50 个文件一让步（setImmediate）的异步流水线 —— 单次让步前的
//       阻塞 <100ms，消息处理/界面请求不再被长阻塞。
//      会话文件"结束写一次、之后不改"的语义不变，A 的复用与原缓存同样安全。
const usageRowsCache = { key: '', at: 0, rows: null, win: null };
const USAGE_CACHE_TTL_MS = 20000;
// 已解析会话的档案（增量解析的持久层）：sig（目录快照）→ 每会话的展开行/计数。
// 与 usageRowsCache 的区别：后者是"某个时间窗的最终 rows"，前者是
// "全部会话的原始素材" —— 换 range 时不必重新读盘。
const usageArchive = { sig: '', at: 0, sessions: null };   // sessions: Map(file -> {rows[], searchCount, toolCounts})
// 让步前最多同步解析的文件数（B 方案的切片粒度）
const USAGE_PARSE_CHUNK = 50;
// 让步前最多同步 stat 的文件数（档案命中时只剩 stat，粒度可以粗一些）
const USAGE_STAT_CHUNK = 400;

/** 目录快照：文件数 + 目录 mtime。成本低（一次 stat），足以捕捉增删。 */
function sessionsDirSignature() {
  const dir = path.join(DATA_DIR, 'sessions');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const st = fs.statSync(dir);
    return files.length + ':' + st.mtimeMs + ':' + files.reduce((a, f) => a + f.length, 0);
  } catch {
    return '';
  }
}

/**
 * 读盘解析单个会话文件 → { rows, searchCount, toolCounts, started }。
 * 纯函数（不含时间窗过滤）：窗口过滤在 collectUsageRows 里做 —— 这样
 * 换 range（今天/7天/全部）时可以完全复用这份解析结果。
 */
function parseUsageSessionFile(dir, f) {
  const out = { rows: [], searchCount: 0, toolCounts: Object.create(null), started: 0, mtime: 0, size: -1 };
  try {
    const fp = path.join(dir, f);
    const st = fs.statSync(fp);
    out.mtime = st.mtimeMs;
    // size 与 mtime 一起当"这个文件没变过"的判据：NTFS 的 mtime 粒度是 100ns，
    // 单独用 mtime 已经够稳；多存一个 size 是白送的保险（同一个 mtime 刻度内
    // 被改写且长度恰好相同 —— 概率极低但不是零）。
    out.size = st.size;
    const s = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const started = Number(s.startedAt) || 0;
    out.started = started;
    if (!started) return out;
    out.searchCount = Number(s.webSearchCount) || 0;
    // 逐次调用展开：每条 message.raw 有独立的 usage / created / model
    const exactRows = [];
    for (const m of (s.messages || [])) {
      const name = m && m.toolCall && m.toolCall.name;
      if (name) out.toolCounts[String(name)] = (out.toolCounts[String(name)] || 0) + 1;
      const raw = m?.raw;
      if (!raw || typeof raw !== 'object') continue;
      const ru = raw.usage || {};
      const rp = Number(ru.prompt_tokens) || 0;
      const rc = Number(ru.completion_tokens) || 0;
      if (!rp && !rc) continue;
      const at = Number(raw.created) ? Number(raw.created) * 1000 : started;
      exactRows.push({
        promptTokens: rp,
        completionTokens: rc,
        cachedTokens: Number(ru.prompt_tokens_details?.cached_tokens) || 0,
        at,
        model: String(raw.model || s.model || '') || '(未知)'
      });
    }
    if (exactRows.length) {
      for (const c of exactRows) {
        out.rows.push({ ...c, vendor: String(s.vendor || ''), chatKey: String(s.chatKey || '(未知)'), sessionId: s.id, exact: true });
      }
    } else {
      const u = s.usage || {};
      const p = Number(u.promptTokens) || 0;
      const c = Number(u.completionTokens) || 0;
      if (p || c) {
        out.rows.push({
          promptTokens: p,
          completionTokens: c,
          cachedTokens: Number(u.cachedTokens) || 0,
          at: started,
          model: String(s.model || '') || '(未知)',
          chatKey: String(s.chatKey || '(未知)'),
          vendor: String(s.vendor || ''),
          sessionId: s.id,
          exact: false
        });
      }
    }
  } catch { /* 坏文件跳过（与旧行为一致） */ }
  return out;
}

/**
 * （异步）刷新"已解析档案"到当前目录快照。
 * 只重读**变化过的文件**（新文件 + mtime/size 变了的文件），其余复用 ——
 * 2144 个文件只有几个新增时，重读量从 172MB 降到几 MB。
 * 解析按 USAGE_PARSE_CHUNK 分片、片间 setImmediate 让步，不长阻塞事件循环。
 *
 * ⚠️ 2026-09-22 修：这里曾经有一行"前置复用条件"，只有目录签名前两段
 *    （文件数 : 目录 mtime）完全一致才肯以旧档案为底，否则 `prev = new Map()`
 *    —— 于是**每落一个新会话文件就把已解析的整份档案全部丢弃、全量重解析**。
 *    机器人正常运行时新会话每几分钟落一个，等于这个增量缓存从未生效过。
 *    实测（800 文件 / 121MB 合成数据）：增量解析 5ms，被整体丢弃后 2157ms，
 *    而用量页"点今日"走的正是这条路径 —— 这就是"加载非常久"的直接原因。
 *
 *    那行条件本来是想兜"目录被换掉/清空"的场景，但下面**逐文件**比对
 *    (mtime, size) 已经覆盖了它：文件被删就不在 files 列表里、被改写则
 *    mtime/size 必变。所以现在无条件以现有档案为底，稳定性由逐文件判据保证。
 */
async function refreshUsageArchive(dir, files, sig) {
  // ⚠️ 这里**故意不做** "sig 相同就直接返回" 的短路（2026-09-22 实测踩到）：
  //    sessionsDirSignature 只是「文件数 : 目录 mtime : 文件名总长」，
  //    而会话文件是**原地改写**的（会话跑完 #persist 落盘、运行中节流保存），
  //    NTFS 下改写文件内容不会动父目录的 mtime —— 于是"内容变了但签名没变"
  //    会让档案一直沿用旧的解析结果。实测：把一个会话从 4 次调用改写成 40 次，
  //    档案里仍然是 4 —— 而且只要目录没有增删文件，这个错值就**永远**不修正。
  //    多付的代价只是一次"每文件一次 stat"的扫描（1200 文件 ≈ 5ms）；
  //    真正省钱的判据是下面逐文件的 (mtime, size) 比对，那是零读盘的。
  const prev = usageArchive.sessions || new Map();
  const next = new Map();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const old = prev.get(f);
    let st;
    try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
    if (old && old.mtime === st.mtimeMs && old.size === st.size) {
      next.set(f, old);   // 文件没变：复用上次的解析结果（零读盘）
      // 纯 stat 的批次也可能很长（上万文件），同样分片让步
      if ((i + 1) % USAGE_STAT_CHUNK === 0) await new Promise((r) => setImmediate(r));
      continue;
    }
    next.set(f, parseUsageSessionFile(dir, f));
    // 分片让步：单文件最大 ~1MB，50 个一批的同步解析 < 100ms
    if ((i + 1) % USAGE_PARSE_CHUNK === 0) await new Promise((r) => setImmediate(r));
  }
  usageArchive.sessions = next;
  usageArchive.sig = sig;
  usageArchive.at = Date.now();
  return next;
}

/**
 * 后台预热用量档案（2026-09-22）。
 *
 * 用量统计的第一道工序是把全部会话文件 JSON.parse 一遍（实测 1200 文件 /
 * 170MB ≈ 3.1 秒）。不预热的话，**每次启动后第一次打开用量页都要等这 3 秒**，
 * 用户看到的就是"点今日加载非常久"—— 而这 3 秒完全可以在启动后闲置时先付掉。
 *
 * 由 start() 在启动 8 秒后调用：那时插件加载、价格表、遥测都已就位，档案解析
 * 又是分片让步的，不会长阻塞事件循环。没有任何会话文件（全新安装）直接跳过。
 *
 * @returns {Promise<{files:number, ms:number}|null>}
 */
export async function warmUsageArchive() {
  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  if (!files.length) return null;
  const t0 = Date.now();
  const archive = await refreshUsageArchive(dir, files, sessionsDirSignature());
  return { files: archive.size, ms: Date.now() - t0 };
}

/**
 * 历史文件指纹：只统计"已完结"的会话文件（最后写盘时刻早于今天 0 点）。
 *
 * 为什么日快照判据不用目录签名（sessionsDirSignature）：目录签名含目录 mtime，
 * 机器人每结束一个新会话就落一个新文件 → 签名必变。旧判据下签名一变，
 * **全部历史日快照同时失效** → 每次统计把窗口内每一天从档案全量重算
 * （每天遍历全部会话行 + 逐行计价，同步无让步），数据量大时事件循环被
 * 阻塞数秒、所有接口排队 —— 长期使用后"用量页卡死在加载界面"的根因。
 *
 * 而已完结文件（会话写完一次后不再改写）的集合对历史日是稳定的：
 * 新增会话只影响"今天"（今天永远实时聚合、不进快照）。指纹不变 →
 * 历史快照持续有效；清理/删除旧会话文件会改变指纹 → 相关快照正确失效。
 * 每天 0 点跨越会让指纹变一次（昨天写完的文件被纳入）→ 一天仅重算一次。
 *
 * 指纹从已解析档案派生（每文件 mtime 在 refreshUsageArchive 时已 stat），
 * 零额外 IO。格式带 h: 前缀，与旧目录签名天然不同 —— 旧快照首次统计时
 * 自动失效重算一遍，随即迁移成新格式，无需专门迁移代码。
 */
function historySignatureOf(archive, todayStartMs) {
  let count = 0, mtimeSum = 0;
  for (const parsed of archive.values()) {
    if (!parsed || !parsed.mtime || parsed.mtime >= todayStartMs) continue;
    count++;
    mtimeSum += parsed.mtime;
  }
  // ⚠️（2026-10-17）h: → h2: 是一次性快照作废：账本补差修好之后
  // （"已知覆盖"不再拿账本总量顶数、补差改按会话粒度生成），旧快照的
  // 口径与新算法不同。改前缀让全部历史日按新算法重算一遍，随后迁移成
  // 新格式；算不出数据的日子会走"保留旧值 + 对齐新签名"的自愈路径，
  // 不会把仅存的快照抹成 0。
  return `h2:${count}:${mtimeSum}`;
}

export async function collectUsageRows({ range }) {
  const win = resolveRange(range);
  // 命中缓存就直接返回（注意 rows 会被调用方改写字段，所以必须给副本）
  const sig = sessionsDirSignature() + '@' + String(range);
  if (usageRowsCache.rows && usageRowsCache.key === sig
      && (Date.now() - usageRowsCache.at) < USAGE_CACHE_TTL_MS) {
    return {
      // 深拷贝：曾经 slice() 只是浅拷贝，调用方往行对象上写字段（如 dayKey）
      // 会写穿到缓存对象；当前写入恰好幂等无害，但承诺的"防污染"并不成立
      rows: usageRowsCache.rows.map((r) => ({ ...r })),
      win: win || usageRowsCache.win,
      searchCount: usageRowsCache.searchCount || 0,
      toolCounts: { ...(usageRowsCache.toolCounts || {}) }
    };
  }

  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { rows: [], win, searchCount: 0, toolCounts: {} }; }

  // ── 数据量治理（2026-09-17，见"用量行缓存"注释的 A/B 方案）──
  // 档案层增量解析 + 分片让步；时间窗过滤只对窗口内的素材做。
  const archive = await refreshUsageArchive(dir, files, sig.split('@')[0]);

  const rows = [];
  // 会话级计数：搜索次数、各工具的调用次数。
  // 注意这些是"次数"不是"成本"：搜索通常是资源包或免费的，
  // 所以只列数量、绝不参与成本计算（用户明确要求）。
  let searchCount = 0;
  const toolCounts = Object.create(null);

  for (const f of files) {
    const parsed = archive.get(f);
    if (!parsed || !parsed.started) continue;
    // 这个会话是否落在时间窗口内（工具/搜索计数按会话归属，没有独立时间戳）
    if (parsed.started >= win.start && parsed.started <= win.end) {
      searchCount += parsed.searchCount || 0;
      for (const [name, n] of Object.entries(parsed.toolCounts)) {
        toolCounts[name] = (toolCounts[name] || 0) + n;
      }
    }
    // 逐次调用行：窗口内才收进 rows（行自带 at，可精确到调用时刻）
    for (const r of parsed.rows) {
      if (r.at < win.start || r.at > win.end) continue;
      rows.push(r);
    }
  }

  // ── 账本兜底：补回被 keepFiles 裁掉的会话的用量 ──────────────────
  //
  // 会话文件是可裁剪的（config.json 的 store.keepSessionFiles，默认 120），
  // 文件一删，它携带的用量就再也读不到了 —— 统计会被冻结在"最近 N 个会话"上，
  // 用户看到的现象是"今日 200 次运行，页面只算 120 次"。
  //
  // 补差分两层，全部以**按会话 id 去重**为前提：
  //   ① 逐会话补行：账本里"文件已不在"的会话，每条转一行统计行
  //      （带 chatKey/model/vendor/calls，见 ledgerSessionRow）——
  //      按会话、按模型、调用次数、成本全部恢复；
  //   ② 按天聚合补差：① 之后与权威真值（账本 / 跨天归档 / usage-today.json
  //      逐字段取最大，见 authoritativeGapForDay）仍有差距的
  //      （账本漏记、账本建立之前的日子），再补一条聚合行。
  {
    const onDiskIds = new Set(files.map((f) => f.replace(/\.json$/, '')));
    const ledgerDayInWin = (dayKey) => {
      const d0 = new Date(`${dayKey}T00:00:00`);
      if (isNaN(d0.getTime())) return false;
      const d1 = new Date(d0.getTime());
      d1.setDate(d1.getDate() + 1);
      return d1.getTime() - 1 >= win.start && d0.getTime() <= win.end;
    };
    // ① 逐会话补行（被裁掉的会话）
    for (const dayKey of listUsageLedgerDays()) {
      if (!ledgerDayInWin(dayKey)) continue;
      for (const rec of usageLedgerPrunedRecords(dayKey, onDiskIds)) {
        rows.push(ledgerSessionRow(rec));
      }
    }
    // 已进 rows 的覆盖量（按天；runs 按去重后的会话数计 —— 真值侧的
    // runs 是会话数，两边必须同口径，否则次数补差永远算不平）
    const coveredByDay = new Map();
    const seenSessions = new Set();
    for (const r of rows) {
      const day = ledgerDayKey(r.at);
      const cur = coveredByDay.get(day) || { promptTokens: 0, completionTokens: 0, cachedTokens: 0, webSearchCount: 0, runs: 0 };
      cur.promptTokens += Number(r.promptTokens) || 0;
      cur.completionTokens += Number(r.completionTokens) || 0;
      cur.cachedTokens += Number(r.cachedTokens) || 0;
      const sk = `${day}|${String(r.sessionId || '')}`;
      if (r.sessionId && !seenSessions.has(sk)) { seenSessions.add(sk); cur.runs += 1; }
      coveredByDay.set(day, cur);
    }
    // 搜索次数是会话级计数（没有独立时间戳，按会话归属），单独按天记一份
    for (const f of files) {
      const parsed = archive.get(f);
      if (!parsed || !parsed.started) continue;
      if (parsed.started < win.start || parsed.started > win.end) continue;
      const day = ledgerDayKey(parsed.started);
      const cur = coveredByDay.get(day) || { promptTokens: 0, completionTokens: 0, cachedTokens: 0, webSearchCount: 0, runs: 0 };
      cur.webSearchCount += parsed.searchCount || 0;
      coveredByDay.set(day, cur);
    }
    // ② 按天聚合补差（① 之后仍对不上账的部分）
    const { days: ledgerByDay } = usageLedgerTotals(ledgerDayInWin);
    const doneDays = new Set();
    // 归档日也要进循环：账本是从"启用那一天"起记的，更早的跨天归档只存在于
    // usage-archived-days.json 里 —— 只遍历账本的日就等于永远看不到它们。
    for (const dayKey of new Set([...ledgerByDay.keys(), ...Object.keys(loadArchivedUsageDays())])) {
      if (!ledgerDayInWin(dayKey)) continue;
      const gap = authoritativeGapForDay(coveredByDay, ledgerByDay, dayKey);
      if (!gap) continue;
      rows.push(ledgerGapRow(dayKey, gap));
      searchCount += gap.webSearchCount;
      doneDays.add(dayKey);
    }
    // 账本日里**没有今天**时（账本刚建立、或跨天后第一段时间），当天权威值
    // 仍在 usage-today.json 里 —— 单独为它补一次，否则「今日」卡片会一直
    // 显示残缺值，而这正是用户报的"估算根本不更新"。
    {
      const todayFile = loadUsageTodayFile();
      if (todayFile && !doneDays.has(todayFile.dayKey) && ledgerDayInWin(todayFile.dayKey)) {
        const gap = authoritativeGapForDay(coveredByDay, new Map(), todayFile.dayKey);
        if (gap) {
          rows.push(ledgerGapRow(todayFile.dayKey, gap));
          searchCount += gap.webSearchCount;
        }
      }
    }
    // ②-b 工具调用计数补回（2026-10-19）
    //
    // 上面第一圈的 toolCounts 只来自**磁盘上还存在的**会话文件。keepSessionFiles
    // （默认 120）一裁，调用明细就只剩"最近 120 个会话"—— 实测 120 个文件只覆盖
    // 5 小时，弹窗却写"近 7 天共 157 次"，而单日账本里就有上千次调用。
    //
    // 账本自 2026-10-19 起记录 toolCounts，这里把"文件已不在磁盘上"的会话补回来，
    // 与上面 token 的补差（authoritativeGapForDay）同一口径：
    // 文件在的用文件（带逐次明细），文件不在的用账本（只有计数），两边不重叠。
    {
      const onDiskIds = new Set(files.map((f) => f.replace(/\.json$/, '')));
      for (const [dayKey, dayAgg] of ledgerByDay) {
        if (!ledgerDayInWin(dayKey)) continue;
        // 快路径：该日账本里一条工具计数都没有（全是改造前的老行）→ 直接跳过，
        // 免得为了"补 0 条"去读一遍整天的账本文件。
        if (!dayAgg?.toolCounts || !Object.keys(dayAgg.toolCounts).length) continue;
        for (const rec of usageLedgerPrunedRecords(dayKey, onDiskIds)) {
          // 以日粒度判断窗口不够精确：同一天里跨窗口边界的会话要按 startedAt 再滤一次
          const st = Number(rec.startedAt) || Number(rec.endedAt) || 0;
          if (st && (st < win.start || st > win.end)) continue;
          const tc = rec.toolCounts;
          if (!tc || typeof tc !== 'object') continue;   // 老账本行没有这个字段
          for (const [name, n] of Object.entries(tc)) {
            const c = Number(n) || 0;
            if (c > 0) toolCounts[String(name)] = (toolCounts[String(name)] || 0) + c;
          }
        }
      }
    }
  }
  // 模型身份 = 渠道 + 模型 id。
  // 渠道取**会话自己记录的** vendor（创建会话时由当时的配置派生）。
  // 老会话没这个字段 → 标为「未知渠道」，绝不拿当前配置去倒推历史 ——
  // 用户很可能早就换过渠道了，猜出来的结果是错的。
  for (const r of rows) {
    r.vendor = String(r.vendor || '').trim() || UNKNOWN_VENDOR;
    r.modelKey = modelLabel(r.vendor, r.model);
  }
  // 写缓存：存的是"清洗完的 rows"，取用时给副本避免调用方污染
  // ⚠️ rows 里的对象来自档案层（可能被多个 range 的缓存共享引用）——
  //    上面 vendor/modelKey 的改写是幂等的，但调用方还会写 dayKey，
  //    所以缓存里也存一份浅拷贝行（同 range 复用时的防污染，与旧行为一致）。
  usageRowsCache.key = sig;
  usageRowsCache.at = Date.now();
  usageRowsCache.rows = rows.map((r) => ({ ...r }));
  usageRowsCache.win = win;
  usageRowsCache.searchCount = searchCount;
  usageRowsCache.toolCounts = { ...toolCounts };
  return { rows, win, searchCount, toolCounts };
}

// ── 按日快照（2026-09-19）──────────────────────────────────────────
//
// 问题：collectUsageRows 即使有档案层缓存，冷启动（2144 文件 / 172MB）仍要
// 全量流式解析；"今天之前的每一天"的数据是**不可变的**（会话结束写一次、
// 之后不改），每次打开用量页都从头统计它们是纯浪费。
//
// 方案：把"已完结自然日"（今天之前）的聚合结果固化到
// data/usage-daily.json。读取路径优先快照；只有快照缺失/失效的日才回退
// 到"从档案聚合"。写快照时机：每次统计完顺手补齐（异步、不阻塞响应）。
//
// 有效性判据：每条日快照带生成时的目录快照 sig。sig 没变 → 该日必然没
// 新增会话（会话文件不改写），直接用。sig 变了 → 重算该日（分片解析会
// 复用 mtime 相同的旧解析结果，增量代价很小）。"今天"永远不进快照。
//
// ⚠️ 成本口径：快照存 costOfRows 聚合结果。价格表（自定义价/远程价）变化
//    会让历史成本跟着变 —— 快照固定的是"生成当时的计价"。这是刻意取舍：
//    量级收益（秒→毫秒）远大于"改价后历史成本不联动"的小误差；想重算
//    任何一天，删掉快照文件对应条目即可。
const USAGE_DAILY_FILE = path.join(DATA_DIR, 'usage-daily.json');
// 跨天归档（sessions.js 的 #archiveDayUsage 写的**独立文件**）。
// ⚠️ 它与 usage-daily.json 是两回事，别混：usage-daily 存的是"按日聚合快照"，
//    这个存的是 usage-today.json 那个单槽文件在跨零点时被顶下来的**上一日权威总量**。
const USAGE_ARCHIVED_FILE = path.join(DATA_DIR, 'usage-archived-days.json');
const USAGE_DAILY_VERSION = 1;

function loadUsageDaily() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_DAILY_FILE, 'utf8'));
    if (parsed?.version === USAGE_DAILY_VERSION && parsed.days && typeof parsed.days === 'object') {
      return parsed.days;
    }
  } catch { /* 无文件/坏文件 = 全部重算 */ }
  return {};
}

function saveUsageDaily(days) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${USAGE_DAILY_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: USAGE_DAILY_VERSION, savedAt: Date.now(), days }, null, 1), 'utf8');
    fs.renameSync(tmp, USAGE_DAILY_FILE);
  } catch { /* 快照写失败只是慢一点，绝不能影响统计主流程 */ }
}

/**
 * 已完结自然日列表：从窗口起点（或快照里最早的日）到昨天。
 * 今天永远实时算（数据还在长）。
 */
function completedDayKeys(fromTs) {
  const out = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  // 昨天的 0 点（今天之前最后一个已完结日）
  d.setDate(d.getDate() - 1);
  const start = new Date(Number(fromTs) || 0);
  start.setHours(0, 0, 0, 0);
  while (d.getTime() >= start.getTime()) {
    out.push(dayKeyOf(d.getTime()));
    d.setDate(d.getDate() - 1);
  }
  return out;
}

/**
 * 「数据元年」——最早**可能**有数据的自然日 0 点。
 *
 * 为什么需要它（2026-09-22）：'all' 范围给 completedDayKeys 传的起点是 0，
 * 于是从 1970-01-01 一路枚举到昨天 —— 实测 20718 个空日。代价有三层：
 *   1. 枚举本身要遍历两万多次（13ms，还算便宜）；
 *   2. 每个空日都会生成一条快照写进 usage-daily.json → 文件被灌到 9.95MB，
 *      而这份文件**每次统计**都要 JSON.parse 一遍（≈65ms）；
 *   3. 更糟的是 days 维度会吐 20718 个数据点，前端折线图直接画两万个点。
 *
 * 取两侧较小值，宁可保守（算早不算晚，绝不把真有数据的日子切掉）：
 *   ① 档案里最早一个会话的开始时刻；
 *   ② 日快照里最早一个"确有数据"（runs 或 token 非零）的日。
 * 两边都拿不到 → 返回 0，等于不做任何下限（老行为），安全兜底。
 */
function usageDataFloorMs(archive, snapshotDays) {
  let floorMs = Infinity;
  for (const parsed of archive.values()) {
    const t = Number(parsed?.started) || 0;
    if (t > 0 && t < floorMs) floorMs = t;
  }
  // ⚠️ 账本也要计入数据元年！否则会出现：会话文件被裁光后档案层的最早
  //    会话已经是很近的日子，但账本里还有更早的日子 —— 按档案算出的
  //    下限会把那些日子判成"元年之前"并裁掉，历史数据凭空消失。
  for (const dayKey of listUsageLedgerDays()) {
    const t = new Date(`${dayKey}T00:00:00`).getTime();
    if (Number.isFinite(t) && t < floorMs) floorMs = t;
  }
  // 日键是 YYYY-MM-DD，字典序即时间序，不必逐条 new Date（两万条 Date 解析不便宜）
  let floorKey = '';
  for (const [dayKey, snap] of Object.entries(snapshotDays || {})) {
    const t = snap?.aggregates?.totals;
    if (!t) continue;
    if (!((Number(t.runs) || 0) > 0 || (Number(t.totalTokens) || 0) > 0)) continue;
    if (!floorKey || dayKey < floorKey) floorKey = dayKey;
  }
  if (floorKey) {
    const k = new Date(floorKey + 'T00:00:00').getTime();
    if (!isNaN(k) && k < floorMs) floorMs = k;
  }
  if (!isFinite(floorMs)) return 0;
  const d = new Date(floorMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 裁掉日快照里"数据元年"之前的日（只会是空日）与未来日。
 *
 * 保守三条，确保它永远不会删掉真实数据：
 *   ① 元年拿不到（0 / 非有限数）→ 一条都不裁；
 *   ② 只裁 **严格早于** 元年的日 —— 元年当天及以后原样保留；
 *   ③ 只裁字典序比较这一天（不做任何数值猜测）。
 * 被裁掉的日子如果将来真有数据，会作为"快照缺失"被正常重算，不会丢。
 *
 * @returns {number} 实际裁掉的条数（>0 时需要回写快照）
 */
function pruneUsageDaily(snapshotDays, floorMs) {
  if (!floorMs || !isFinite(floorMs)) return 0;
  const floorKey = dayKeyOf(floorMs);
  // 同上：未来日判据用 setDate(+1)，避免夏令时切换日 +24h 落到昨天。
  const tmr = new Date();
  tmr.setDate(tmr.getDate() + 1);
  const tomorrowKey = dayKeyOf(tmr.getTime());
  let removed = 0;
  for (const dayKey of Object.keys(snapshotDays)) {
    if (dayKey < floorKey || dayKey > tomorrowKey) { delete snapshotDays[dayKey]; removed++; }
  }
  return removed;
}

/**
 * 读 data/usage-today.json —— **当天**用量的权威值。
 *
 * ⚠️ 这是用量统计最重要的一块拼图（用户报"估算根本不更新"）：
 * 会话文件会被 keepFiles 裁掉、账本只从启用那天起记，所以两者都覆盖不了
 * 「今天早些时候」的历史。而 usage-today.json 是 #bumpTodayUsage 在每次会话
 * 结束时**累加**写下的当天总量，它**永远不被裁剪**，是当天唯一完整可信的数。
 *
 * 有了它，即使今天有 85% 的会话文件已被删除，统计也能对齐到真值 ——
 * 缺的量作为"归档补差"计入，而不是让用户对着一个偏小的数字反复刷新。
 *
 * @returns {null | {dayKey:string, promptTokens:number, completionTokens:number,
 *                   totalTokens:number, cachedTokens:number, runs:number, webSearchCount:number}}
 */
function loadUsageTodayFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
    if (parsed?.dayKey && typeof parsed.dayKey === 'string') {
      return {
        dayKey: parsed.dayKey,
        promptTokens: Number(parsed.promptTokens) || 0,
        completionTokens: Number(parsed.completionTokens) || 0,
        totalTokens: Number(parsed.totalTokens) || 0,
        cachedTokens: Number(parsed.cachedTokens) || 0,
        runs: Number(parsed.runs) || 0,
        webSearchCount: Number(parsed.webSearchCount) || 0,
      };
    }
  } catch { /* 无文件 = 今天还没用量 */ }
  return null;
}

/**
 * 跨天归档的每日权威总量（data/usage-archived-days.json）。
 *
 * ⚠️（2026-10-17 补完 报告3 M2 的另一半）这个文件此前**只写不读**：
 *   sessions.js 的 #archiveDayUsage 把 usage-today.json 被顶下来的旧槽位按天写进去，
 *   而下面 authoritativeGapForDay 的注释早就把它列为"权威总量来源③" —— 代码里却
 *   从来没打开过它。于是那段归档等于白写，注释与实现对不上（这正是报告点的问题）。
 *   这里补上读取：账本没覆盖到的日子，用归档里的权威值补差。
 *
 * 缓存按 (mtimeMs,size) 失效：本函数在补差循环里会被逐日调用，不能每天都读一次盘。
 * 文件不存在是**常态**（还没发生过跨天归档），不是错误。
 */
let archivedDaysCache = { sig: '', days: {} };

function loadArchivedUsageDays() {
  let sig;
  try {
    const st = fs.statSync(USAGE_ARCHIVED_FILE);
    sig = `${st.mtimeMs}:${st.size}`;
  } catch { return {}; }                       // 没有归档文件 = 没什么可补
  if (archivedDaysCache.sig === sig) return archivedDaysCache.days;
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_ARCHIVED_FILE, 'utf8'));
    const days = parsed?.days && typeof parsed.days === 'object' ? parsed.days : {};
    archivedDaysCache = { sig, days };
    return days;
  } catch { return {}; }                       // 坏文件：当作没有，且不缓存（下次重试）
}

/** 归档里某一天的权威总量；没有该天返回 null。 */
function archivedDayTotals(dayKey) {
  const d = loadArchivedUsageDays()[dayKey];
  if (!d || typeof d !== 'object') return null;
  return {
    promptTokens: Number(d.promptTokens) || 0,
    completionTokens: Number(d.completionTokens) || 0,
    totalTokens: Number(d.totalTokens) || 0,
    cachedTokens: Number(d.cachedTokens) || 0,
    runs: Number(d.runs) || 0,
    webSearchCount: Number(d.webSearchCount) || 0,
  };
}

/**
 * 算出某一天"已经进统计行的量"与权威真值之间还差多少。
 *
 * 三个数据源取**逐字段最大值**作为真值：
 *   ① 用量账本 —— 按天留档、跨天也准（启用那天起）
 *   ② usage-archived-days.json —— 跨零点归档的权威总量
 *   ③ usage-today.json —— 当天总量（仅当天匹配时）
 *
 * ⚠️（2026-10-17）"已知覆盖"只认**调用方已经放进 rows 的量** ——
 * coveredByDay 必须已含账本逐会话补行。曾经的实现把账本当日总量同时
 * 当成"已知覆盖"（known = max(文件覆盖, 账本总量)）和"真值"
 * （truth = 账本总量）→ gap 恒等于 0 → 补差永远不触发。用户报的
 * "今日 200 次运行只算 120 次"就是这么来的：账本明明记全了，
 * 却因为对账逻辑自相矛盾，一行都补不回去。
 *
 * @param {Map<string, object>} coveredByDay 已进 rows 的覆盖量（按天，含 runs=去重会话数）
 * @param {Map<string, object>} ledgerByDay   账本汇总量
 * @param {string} dayKey
 * @returns {{promptTokens:number,completionTokens:number,cachedTokens:number,
 *            webSearchCount:number,runs:number}|null} 无差距返回 null
 */
function authoritativeGapForDay(coveredByDay, ledgerByDay, dayKey) {
  const c = coveredByDay.get(dayKey) || { promptTokens: 0, completionTokens: 0, cachedTokens: 0, webSearchCount: 0, runs: 0 };
  const num = (v) => Number(v) || 0;
  const todayFile = loadUsageTodayFile();
  const candidates = [
    ledgerByDay.get(dayKey) || null,
    archivedDayTotals(dayKey),
    (todayFile && todayFile.dayKey === dayKey) ? todayFile : null,
  ].filter(Boolean);
  if (!candidates.length) return null;
  const truth = {
    promptTokens: Math.max(...candidates.map((x) => num(x.promptTokens))),
    completionTokens: Math.max(...candidates.map((x) => num(x.completionTokens))),
    cachedTokens: Math.max(...candidates.map((x) => num(x.cachedTokens))),
    runs: Math.max(...candidates.map((x) => num(x.runs))),
    webSearchCount: Math.max(...candidates.map((x) => num(x.webSearchCount))),
  };
  const gapPrompt = Math.max(0, truth.promptTokens - num(c.promptTokens));
  const gapCompletion = Math.max(0, truth.completionTokens - num(c.completionTokens));
  const gapRuns = Math.max(0, truth.runs - num(c.runs));
  if (!gapPrompt && !gapCompletion && !gapRuns) return null;
  return {
    promptTokens: gapPrompt,
    completionTokens: gapCompletion,
    cachedTokens: Math.max(0, truth.cachedTokens - num(c.cachedTokens)),
    webSearchCount: Math.max(0, truth.webSearchCount - num(c.webSearchCount)),
    runs: gapRuns,
  };
}

/** 构造一条"来自账本/归档"的补差行（at 落在当天末尾，计价按兜底价）。 */
function ledgerGapRow(dayKey, gap) {
  const at = new Date(`${dayKey}T23:59:59`).getTime();
  return {
    promptTokens: gap.promptTokens,
    completionTokens: gap.completionTokens,
    cachedTokens: gap.cachedTokens,
    at: Number.isFinite(at) ? at : Date.now(),
    // 这一行代表的会话数。costOfRows 的 runs 按行的 runs 累加，补差行不带
    // runs 会按 1 计 —— "调用次数"照样对不上（200 次运行只算 120 次的
    // 另一半原因）。纯 token 差价的补差行 runs 为 0，不影响计数。
    runs: Number(gap.runs) || 0,
    model: '(已归档会话)',
    vendor: UNKNOWN_VENDOR,
    chatKey: '(已归档会话)',
    sessionId: '',
    exact: false,
    fromLedger: true,
  };
}

/**
 * 把一条账本记录转成统计行：一个被裁掉的会话 = 一行。
 *
 * 为什么必须逐会话转行、而不是按天合成一行：
 *   ① 次数：costOfRows 的 runs 按行累加，按天合成的一行只代表 1 次调用；
 *   ② 归属：chatKey / model / vendor / calls 都在账本记录里，逐会话转行
 *      才能让"按会话 / 按模型"两张表把补回来的量归到真正的群和模型上，
 *      而不是全塞进"(已归档会话) / 未知渠道"这种糊涂账。
 *
 * @param {object} rec 账本记录（usage-ledger.js 的 ledgerRecordOf 产出）
 */
function ledgerSessionRow(rec) {
  return {
    promptTokens: Number(rec?.promptTokens) || 0,
    completionTokens: Number(rec?.completionTokens) || 0,
    cachedTokens: Number(rec?.cachedTokens) || 0,
    at: Number(rec?.endedAt) || Date.now(),
    runs: Number(rec?.calls) || 1,      // 该会话真实的 LLM 调用次数
    model: String(rec?.model || '') || '(未知)',
    vendor: String(rec?.vendor || ''),
    chatKey: String(rec?.chatKey || '(未知)'),
    sessionId: String(rec?.id || ''),
    exact: false,
    fromLedger: true,
  };
}

/**
 * 从档案层聚合出"某一个自然日"的统计（不使用快照 —— 这是重算路径）。
 * 返回与 buildUsageStats 的 days/chats/models 三段同构的聚合体。
 */
function aggregateDayFromArchive(archive, dayKey) {
  const dayStart = new Date(dayKey + 'T00:00:00');
  if (isNaN(dayStart.getTime())) return null;
  // ⚠️ 不能写死 +24h 夏令时切换日会错 1 小时（本地 23h 或 25h 的一天），
  // 那一天的尾巴或开头会被漏掉 / 多算。用 setDate(+1) 让 Date 自己处理日界线。
  const dayEndDate = new Date(dayStart.getTime());
  dayEndDate.setDate(dayEndDate.getDate() + 1);
  const dayEnd = dayEndDate.getTime() - 1;
  if (!isFinite(dayEnd)) return null;
  const rows = [];
  let searchCount = 0;
  const toolCounts = Object.create(null);
  // 会话文件已覆盖的量（按天），供账本补差用
  const coveredByDay = new Map();
  for (const parsed of archive.values()) {
    if (!parsed || !parsed.started) continue;
    if (parsed.started >= dayStart.getTime() && parsed.started <= dayEnd) {
      searchCount += parsed.searchCount || 0;
      for (const [name, n] of Object.entries(parsed.toolCounts)) {
        toolCounts[name] = (toolCounts[name] || 0) + n;
      }
    }
    for (const r of (parsed.rows || [])) {
      if (r.at >= dayStart.getTime() && r.at <= dayEnd) rows.push(r);
    }
  }
  for (const r of rows) {
    const cur = coveredByDay.get(dayKey) || { promptTokens: 0, completionTokens: 0, cachedTokens: 0, webSearchCount: 0 };
    cur.promptTokens += Number(r.promptTokens) || 0;
    cur.completionTokens += Number(r.completionTokens) || 0;
    cur.cachedTokens += Number(r.cachedTokens) || 0;
    coveredByDay.set(dayKey, cur);
  }
  // 搜索次数是会话级计数，上面已经按会话累加过一次，这里按天记一次供补差
  {
    let s = 0;
    for (const parsed of archive.values()) {
      if (parsed?.started >= dayStart.getTime() && parsed.started <= dayEnd) s += parsed.searchCount || 0;
    }
    // ⚠️（2026-10-17 修崩溃）**不能直接 coveredByDay.get(dayKey).webSearchCount = s**：
    //    上面的累加循环只在 rows 非空时才 set(dayKey, …)，所以"这一天没有任何会话记录"
    //    （归档为空 / 该日无会话文件）时 map 里没有这个 key，get() 返回 undefined，
    //    赋值直接抛 TypeError: Cannot set properties of undefined (setting 'webSearchCount')。
    //    而"归档为空"恰恰是会话文件被外部清空后的常态 —— 于是快照路径每次必抛、
    //    被 buildUsageStats 的 catch 回落到实时聚合，表现为用量页按天只剩今天、
    //    下钻 0 行、成本 0。参考包（洛版修复版）同位置有同样的问题。
    const cur = coveredByDay.get(dayKey)
      || { promptTokens: 0, completionTokens: 0, cachedTokens: 0, webSearchCount: 0 };
    cur.webSearchCount = s;
    coveredByDay.set(dayKey, cur);
  }
  // 账本补差：会话文件被 keepFiles 裁掉的会话，其用量在这里补回来。
  // 不补的话统计会被冻结在"最近 N 个会话文件"上（用户报"200 次只算 120 次"）。
  // 与 collectUsageRows 同构：先逐会话补行，再按天对账补聚合差。
  {
    // ① 逐会话补行：账本里"文件已不在磁盘"的会话，每条转一行
    const onDiskIds = new Set([...archive.keys()].map((f) => f.replace(/\.json$/, '')));
    const pushed = [];
    for (const rec of usageLedgerPrunedRecords(dayKey, onDiskIds)) {
      const row = ledgerSessionRow(rec);
      rows.push(row);
      pushed.push(row);
    }
    // ② 覆盖量把刚补的行并进去。runs 必须**无条件**按去重会话数重算
    //    （不能只在裁了文件的日子算）—— 真值侧的 runs 是会话数，两边
    //    不同口径会让次数补差永远算不平，没裁文件的日子也会补出幽灵次数。
    {
      const cur = coveredByDay.get(dayKey)
        || { promptTokens: 0, completionTokens: 0, cachedTokens: 0, webSearchCount: 0, runs: 0 };
      // ⚠️ 上面建 coveredByDay 时没有 runs 字段，直接 += 会得到 NaN，
      //    而 num(NaN)=0 → 次数补差把整天的量再补一遍（实测 runs 翻倍）。
      if (!Number.isFinite(Number(cur.runs))) cur.runs = 0;
      const seen = new Set();
      for (const r of rows) {
        if (!r.sessionId || seen.has(r.sessionId)) continue;
        seen.add(r.sessionId);
        cur.runs += 1;
      }
      for (const k of ['promptTokens', 'completionTokens', 'cachedTokens']) {
        cur[k] += pushed.reduce((n, r) => n + (Number(r[k]) || 0), 0);
      }
      coveredByDay.set(dayKey, cur);
    }
    // ③ 与权威真值仍有差距的（账本漏记 / 账本建立之前的日子）再补一条聚合行
    const { days: ledgerByDay } = usageLedgerTotals((d) => d === dayKey);
    const gap = authoritativeGapForDay(coveredByDay, ledgerByDay, dayKey);
    if (gap) {
      rows.push(ledgerGapRow(dayKey, gap));
      searchCount += gap.webSearchCount;
    }
  }
  for (const r of rows) {
    r.vendor = String(r.vendor || '').trim() || UNKNOWN_VENDOR;
    r.modelKey = modelLabel(r.vendor, r.model);
  }
  const totals = costOfRows(rows);
  const chats = groupBy(rows, 'chatKey', 0);
  const models = groupBy(rows, 'modelKey', 0).map((m) => {
    const { vendor, model } = splitModelLabel(m.key);
    return { ...m, vendor, model };
  });
  return { totals, chats, models, searchCount, toolCounts };
}

/**
 * 把某一天的聚合体摊平成 days 维度的一条记录。
 *
 * 抽成模块级是因为快照路径与回落实时路径都要用，两边的字段约定必须一致。
 *
 * 做两件必须做的事：
 *  ① 重算派生比率 cacheHitRate / peakRatio —— 它们是「比率」不是「量」，
 *     跨日相加没有意义，聚合时一律先归零再在此处按当天自身重算
 *     （见 buildUsageStatsWithSnapshots 里 totals 的归零骨架）。
 *  ② 补 key 字段 —— chats / models 维度都有 key，前端下钻与横向条形图统一按
 *     key 取值；days 曾经只给 day，把 days 接进 usageBars 时 x.key 会是 undefined。
 *
 * @param {string} dayKey  'YYYY-MM-DD'
 * @param {object} aggTotals 该日的聚合体（costOfRows 的返回或 groupBy 的返回）
 */
function withDerived(dayKey, aggTotals) {
  const t = { ...(aggTotals || {}) };
  const prompt = Number(t.promptTokens) || 0;
  const peak = Number(t.peakTokens) || 0;
  const offPeak = Number(t.offPeakTokens) || 0;
  t.cacheHitRate = prompt ? Math.min(1, (Number(t.cachedTokens) || 0) / prompt) : 0;
  t.peakRatio = (peak + offPeak) ? peak / (peak + offPeak) : 0;
  // key 在前：保证不会被 aggTotals 里同名残留字段覆盖
  return { ...t, key: dayKey, day: dayKey };
}

/**
 * 快照加速版统计：days 维度全部走快照 + 今天实时聚合。
 * 其余维度（chats/models/totals）= 各日快照聚合 + 今天实时。
 * 任一需要的日快照缺失/失效 → 重算该日并回写快照。
 *
 * @returns {Promise<{stats: object, usedSnapshotDays: number, recomputedDays: number}>}
 */
async function buildUsageStatsWithSnapshots({ range = '7' } = {}) {
  const win = resolveRange(range);
  const todayKey = dayKeyOf(Date.now());
  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { files = []; }
  const dirSig = sessionsDirSignature();
  const archive = await refreshUsageArchive(dir, files, dirSig);
  // 日快照有效性判据 = 历史文件指纹（不是目录签名，原因见 historySignatureOf 注释）
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const historySig = historySignatureOf(archive, todayStart.getTime());

  // 需要的已完结日：窗口起点到昨天；快照里已有的更早日子只在 all 模式需要
  const snapshotDays = loadUsageDaily();
  // ⚠️ 顺序要紧：先读出快照（数据元年的判据之一），再算起点、再枚举日。
  //
  // 起点 = 「窗口起点」与「数据元年」的**较晚者**。两条同时要满足：
  //   ① 'all' 不能给 0 —— 那会从 1970-01-01 枚举两万多个空日（见元年函数注释）；
  //   ② 元年之前的日子必然是空的，枚举出来只会在快照里写一批空条目、
  //      下一次调用又按"空日裁剪"删掉 —— 一边写一边删，**每次统计都重算那几个空日**。
  //      实测（R49 / usage-daily-test 抓到的）：只有 3 天数据的部署上，
  //      7 天窗口会稳定地每次重算 3 个空日，等于把刚修好的性能又还回去一部分。
  //      枚举与裁剪用同一个下限，"写什么"就等于"留什么"，churn 自然消失。
  // 元年拿不到（= 整份数据里一条会话都没有）：'all' 干脆一天都不枚举，
  // 其他范围退回窗口起点（Math.max(start, 0) 即起点本身）。
  const floorMs = usageDataFloorMs(archive, snapshotDays);
  const fromTs = win.mode === 'all'
    ? (floorMs || Infinity)
    : Math.max(win.start, floorMs);
  const wantedDays = completedDayKeys(fromTs);
  let recomputed = 0;

  // days 维度：每日一条聚合（快照优先，缺失则重算）
  // 先攒 { dayKey, totals } 原始对，等 totals/withDerived 定义好之后再摊平
  // （见下方注释：摊平时必须重算派生比率、补 key 字段）。
  const byDayRaw = [];
  const needDays = [];
  for (const dayKey of wantedDays) {
    const snap = snapshotDays[dayKey];
    if (snap && snap.sig === historySig && snap.aggregates) {
      byDayRaw.push({ dayKey, totals: snap.aggregates.totals });
    } else {
      needDays.push(dayKey);
    }
  }
  for (const dayKey of needDays) {
    const agg = aggregateDayFromArchive(archive, dayKey);
    // ⚠️（2026-10-17）重算"算不出数据"时**不能拿零去覆盖已有快照**。
    //    触发场景：会话文件被外部清空（用户点了「清空已结束的会话记录」）→
    //    归档为空 → 所有历史日的 sig 全部失配进 needDays → 每个都重算出全零，
    //    若照旧写回 snapshotDays 再 saveUsageDaily，磁盘上那几天的真实聚合值
    //    就被永久抹成 0 了。快照本身是这些天唯一的凭据，必须保住。
    const aggHasData = agg
      && ((Number(agg.totals?.runs) || 0) > 0 || (Number(agg.totals?.totalTokens) || 0) > 0);
    if (!aggHasData) {
      const prev = snapshotDays[dayKey];
      if (prev?.aggregates) {
        byDayRaw.push({ dayKey, totals: prev.aggregates.totals });
        // ⚠️（2026-10-17 N9）**把签名一起对齐到当前归档状态** —— 让快照"自愈"。
        //
        //    只保住数据还不够：只要 sig 不更新，这个日子下一轮统计仍会进 needDays、
        //    再算一次、再判定"算不出数据"，陷入**每轮都重算**的循环。数据是保住了，
        //    但快路径永远回不来（每次打开用量页都要把整个窗口的天数过一遍）。
        //
        //    为什么这样对齐是安全的：
        //      · historySig 是"**已完结会话文件**的 数量: mtime 之和"。
        //        归档为空（会话被清空/删除）时它恒为 `h:0:0` —— 在归档回到非空前，
        //        任何一天都不可能算出数据，所以"这份快照在当前状态下已是最终值"成立。
        //      · 一旦归档恢复/新增（用户补回文件、或明天又有会话完结），
        //        historySig 立刻变 → 快照重新失配 → 正常走重算路径并覆盖。
        //        也就是说对齐只**推迟**重算，不会**阻止**重算。
        snapshotDays[dayKey] = { sig: historySig, aggregates: prev.aggregates };
      }
      continue;
    }
    byDayRaw.push({ dayKey, totals: agg.totals });
    snapshotDays[dayKey] = { sig: historySig, aggregates: agg };
    recomputed++;
  }

  // 今天（窗口含今天才需要）：实时聚合
  const includesToday = win.end >= new Date(todayKey + 'T00:00:00').getTime();
  let todayAgg = null;
  if (includesToday) {
    todayAgg = aggregateDayFromArchive(archive, todayKey);
  }

  // ⚠️ 把今天补进 days（2026-10-16 修复「按天」图表空白）。
  //
  // 背景：completedDayKeys() 从**昨天** 0 点开始往回枚举（见该函数里明写的
  // `setDate(-1)`），所以 `today` 永远不会进 wantedDays —— 这是设计，今天走
  // 实时聚合、不进日快照。而 days 维度只在 wantedDays 循环里 push，于是今天的
  // 数据**从来没进过 days 维度**。
  //
  // 为什么这是个 bug：下面 chats / models / totals **三个维度都合并了
  // todayAgg**，唯独 days 漏了。后果是顶部卡片（读 totals）数字在动，
  // 而「按天」图表（读 days）显示「这段时间没有记录」——同一份数据两个口径。
  // 只要某天的数据全在当天产生且当天没过完，图表就是空的。
  //
  // 曾经这里把展开写在 byDay.sort() 前后两次、且摊平的是聚合体原对象；
  // 现在统一在 withDerived 里做，日期升序也只排一次。
  if (todayAgg) byDayRaw.push({ dayKey: todayKey, totals: todayAgg.totals });

  // 合并各维度：已完结日快照 + 今天实时
  const mergeGroups = (groupsList) => {
    const map = new Map();
    for (const groups of groupsList) {
      for (const g of groups || []) {
        const key = String(g.key ?? '');
        // ⚠️（2026-10-17 修重复计数）建桶时必须把**所有被累加的字段**归零：
        //    旧实现只归零 runs/exactCalls/cost，而下面累加循环一共加 11 个字段
        //    （cost/peakCost/offPeakCost/peakTokens/offPeakTokens/promptTokens/
        //    completionTokens/cachedTokens/totalTokens/runs/exactCalls）——
        //    漏掉的 8 个会随 `{ ...g }` 原样进桶、再被累加循环加第二遍，
        //    导致每个键"首次出现"的日贡献翻倍（实测 7 日模型表虚高 35%、
        //    会话表虚高 75%、单日范围整表翻倍）。总量与"按天"表不走这里，不受影响。
        if (!map.has(key)) map.set(key, {
          key, ...g,
          cost: 0, peakCost: 0, offPeakCost: 0,
          peakTokens: 0, offPeakTokens: 0,
          promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0,
          runs: 0, exactCalls: 0,
        });
        const t = map.get(key);
        t.cost += Number(g.cost) || 0;
        t.peakCost += Number(g.peakCost) || 0;
        t.offPeakCost += Number(g.offPeakCost) || 0;
        t.peakTokens += Number(g.peakTokens) || 0;
        t.offPeakTokens += Number(g.offPeakTokens) || 0;
        t.promptTokens += Number(g.promptTokens) || 0;
        t.completionTokens += Number(g.completionTokens) || 0;
        t.cachedTokens += Number(g.cachedTokens) || 0;
        t.totalTokens += Number(g.totalTokens) || 0;
        t.runs += Number(g.runs) || 0;
        t.exactCalls += Number(g.exactCalls) || 0;
      }
    }
    let out = [...map.values()];
    out.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
    return out;
  };

  const snapAggs = [...wantedDays].map((k) => snapshotDays[k]?.aggregates).filter(Boolean);
  const totalsAggs = snapAggs.map((a) => a.totals);
  if (todayAgg) totalsAggs.push(todayAgg.totals);
  // ⚠️ 曾经首元素走 `{ ...t }` 分支（把聚合体的**全部**字段原样带进来），
  // 后续元素才走固定字段累加。后果：单日范围的 totals 字段集与多日不同
  // （多出来的 cacheHitRate/peakRatio/hasPeakModel 在单日时是原值、
  // 多日时被丢弃后重算），前端拿到两种形状的对象。
  // 现在统一形状：先铺一份全零骨架，再逐日累加固定的可加字段。
  const TOTAL_ZERO = {
    cost: 0, peakCost: 0, offPeakCost: 0, peakTokens: 0, offPeakTokens: 0,
    promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0,
    runs: 0, exactCalls: 0, hasPeakModel: false,
    cacheHitRate: 0, peakRatio: 0,
  };
  const totals = totalsAggs.reduce((acc, t) => ({
    cost: acc.cost + (Number(t?.cost) || 0),
    peakCost: acc.peakCost + (Number(t?.peakCost) || 0),
    offPeakCost: acc.offPeakCost + (Number(t?.offPeakCost) || 0),
    peakTokens: acc.peakTokens + (Number(t?.peakTokens) || 0),
    offPeakTokens: acc.offPeakTokens + (Number(t?.offPeakTokens) || 0),
    promptTokens: acc.promptTokens + (Number(t?.promptTokens) || 0),
    completionTokens: acc.completionTokens + (Number(t?.completionTokens) || 0),
    cachedTokens: acc.cachedTokens + (Number(t?.cachedTokens) || 0),
    totalTokens: acc.totalTokens + (Number(t?.totalTokens) || 0),
    runs: acc.runs + (Number(t?.runs) || 0),
    exactCalls: acc.exactCalls + (Number(t?.exactCalls) || 0),
    hasPeakModel: acc.hasPeakModel || Boolean(t?.hasPeakModel),
    cacheHitRate: 0,   // 派生比率，循环后重算
    peakRatio: 0,
  }), { ...TOTAL_ZERO });
  // 派生比率不能相加，重算
  totals.cacheHitRate = totals.promptTokens ? Math.min(1, totals.cachedTokens / totals.promptTokens) : 0;
  totals.peakRatio = (totals.peakTokens + totals.offPeakTokens) ? totals.peakTokens / (totals.peakTokens + totals.offPeakTokens) : 0;

  // byDay 的每一条也是从聚合体摊平的，聚合体里的 cacheHitRate/peakRatio 是
  // 上面那张全零骨架带来的 0 —— 必须在入表前按该日自身的 token 重算，
  // 否则「按天」表的命中率列会整列显示 0%。
  const byDay = byDayRaw
    .map((x) => withDerived(x.dayKey, x.totals))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const chats = mergeGroups([...snapAggs.map((a) => a.chats), ...(todayAgg ? [todayAgg.chats] : [])]);
  const models = mergeGroups([...snapAggs.map((a) => a.models), ...(todayAgg ? [todayAgg.models] : [])])
    .map((m) => {
      const { vendor, model } = splitModelLabel(m.key);
      return { ...m, vendor, model };
    });
  let searchCount = snapAggs.reduce((a, x) => a + (x.searchCount || 0), 0) + (todayAgg?.searchCount || 0);
  const toolCounts = {};
  for (const a of snapAggs) {
    for (const [k, v] of Object.entries(a.toolCounts || {})) toolCounts[k] = (toolCounts[k] || 0) + v;
  }
  for (const [k, v] of Object.entries(todayAgg?.toolCounts || {})) toolCounts[k] = (toolCounts[k] || 0) + v;

  // 快照回写（有新增/失效重算的日子才写）
  // 顺带裁掉数据元年之前的空日：老版本被 'all' 范围灌进来的两万条空日
  // 就靠这一句自愈（正常运行时每次统计都过一遍，裁剪本身是字符串比较，可忽略）。
  const prunedDays = pruneUsageDaily(snapshotDays, floorMs);
  if (recomputed > 0 || needDays.length > 0 || prunedDays > 0) {
    // 只保留窗口需要的 + 已有的（不清老数据——删掉将来还得重算）
    saveUsageDaily(snapshotDays);
  }

  return {
    stats: {
      range: String(range),
      rangeLabel: win.label,
      mode: win.mode,
      totals,
      searchCount: searchCount || 0,
      toolCounts: toolCounts || {},
      days: byDay,
      chats,
      models
    },
    recomputedDays: recomputed,
    prunedDays,
    usedSnapshotDays: wantedDays.length - recomputed
  };
}

/** 用配置解析价格（成本只与实际调用的模型有关，与当前选中模型无关）。 */
/**
 * 取某次调用的单价。
 *
 * 按「渠道：模型 id」优先查 —— 用户可以为某个渠道下的模型单独定价
 * （A6API 的 GLM-5.3-Flash 与 OpenRouter 的可能是两个价）。
 * 查不到再退回裸模型 id（通用价），最后才是全局兜底。
 *
 * ⚠️ 必须与前端展示/批量编辑用的身份一致，否则用户设的渠道价永远不会生效。
 */
function priceOf(model, vendor) {
  const cfg = getConfig();
  if (vendor) {
    const byVendor = resolveModelPrice(modelLabel(vendor, model), cfg);
    // 命中自定义价才算数；否则退回通用价（避免渠道名干扰官方表匹配）
    if (byVendor.source === 'custom') return byVendor;
  }
  return resolveModelPrice(model, cfg);
}

/** 对一批行计价，返回总额与峰谷拆分。 */
function costOfRows(rows) {
  const cfg = getConfig();
  let cost = 0, peakCost = 0, offPeakCost = 0, peakTokens = 0, offPeakTokens = 0;
  let promptTokens = 0, completionTokens = 0, cachedTokens = 0, exactCalls = 0, hasPeakModel = false;
  for (const r of rows) {
    const p = priceOf(r.model, r.vendor);
    if (p.peak) hasPeakModel = true;
    const tier = p.peak ? priceAt({ in: p.in, out: p.out, cached: p.cached, peak: p.peak }, r.at) : p;
    const prompt = Number(r.promptTokens) || 0;
    const completion = Number(r.completionTokens) || 0;
    const cached = Math.min(Number(r.cachedTokens) || 0, prompt);
    const fresh = Math.max(0, prompt - cached);
    const c = (fresh / 1_000_000) * tier.in + (cached / 1_000_000) * tier.cached + (completion / 1_000_000) * tier.out;
    cost += c;
    const tk = prompt + completion;
    if (isPeakHour(r.at)) { peakCost += c; peakTokens += tk; } else { offPeakCost += c; offPeakTokens += tk; }
    promptTokens += prompt;
    completionTokens += completion;
    cachedTokens += cached;
    if (r.exact) exactCalls += 1;
  }
  return {
    cost, peakCost, offPeakCost, peakTokens, offPeakTokens,
    promptTokens, completionTokens, cachedTokens,
    totalTokens: promptTokens + completionTokens,
    cacheHitRate: promptTokens ? Math.min(1, cachedTokens / promptTokens) : 0,
    peakRatio: (peakTokens + offPeakTokens) ? peakTokens / (peakTokens + offPeakTokens) : 0,
    exactCalls, hasPeakModel,
    // runs = 这些行代表的 LLM 调用总数。会话文件行每次调用一行（runs 缺省 1）；
    // 账本补行带真实 calls（见 ledgerSessionRow）—— 不累加它，被裁掉的会话
    // 在"模型调用次数"里永远少算（"200 次运行只算 120 次"的一半原因）。
    runs: rows.reduce((n, r) => n + (Number(r?.runs) || 1), 0)
  };
}

/** 按某个字段分组后各自计价。 */
function groupBy(rows, field, limit = 0) {
  const map = new Map();
  for (const r of rows) {
    const k = String(r[field] ?? '(未知)');
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  let out = [...map.entries()].map(([key, list]) => ({ key, ...costOfRows(list) }));
  out.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
  if (limit) out = out.slice(0, limit);
  return out;
}

/** 主统计：按天 / 按会话 / 按模型三个维度。
 * 2026-09-19 起优先走"按日快照"路径（历史日聚合固化在 data/usage-daily.json，
 * 只实时算今天），快照层出错时自动回落到旧的实时聚合 —— 用量页绝不能白屏。
 *
 * 2026-09-22 加三道闸（长期使用后"用量页卡死在加载"的治理之三）：
 *   1. 结果缓存 3 小时（用户要求）：见下方 USAGE_STATS_CACHE_TTL_MS 注释。
 *   2. 微缓存 5 秒：前端轮询 + SSE 事件都会打到这里，5 秒内的重复请求直接复用。
 *      （已被第 1 条覆盖，保留是因为它先于结果缓存判定、命中更快，也兜住
 *        "force 重算后立刻又被轮询打一次"的情况。）
 *   3. 防重入：同一 range 的统计在跑时，后续请求搭同一趟车（共享同一 Promise），
 *      避免多个统计叠加着阻塞事件循环。 */
const USAGE_STATS_MICRO_TTL_MS = 5000;

/**
 * 结果缓存 TTL（2026-09-22，用户要求）。
 *
 * 用户原话："用量界面点今日的时候会加载非常久 …… 我认为可以改成 3 小时自动
 * 统计一次，外加用户手动刷新的时候统计。"
 *
 * 为什么值得缓存整个结果：统计本身不贵了（档案增量解析 + 快照），但**入口太多**
 * —— 15 秒轮询、SSE 事件、切页签、来回点时间范围按钮，每个入口都会把
 * 「读目录 → 增量解析 → 逐日聚合 → 逐行计价 → 读 10MB 快照」重走一遍。
 * 缓存整个结果，这些入口全部退化成一次 Map.get。
 *
 * 语义要点：
 *   - 命中时 `computedAt` **保持真正算出来的时刻**，前端据此显示"数据更新于 HH:MM"
 *     —— 新鲜度是可见的，不会假装数字是刚算的。
 *   - force=true（用户点了「刷新」）跳过缓存重新统计并覆盖缓存。
 *   - 想调新鲜度：改这一个常量即可（单位毫秒）。
 */
const USAGE_STATS_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const usageStatsCache = new Map();   // `${range}#${价格指纹}` -> { at, stats }
const usageStatsInflight = new Map(); // 同上 key -> Promise（每个 key 各有各的在途统计）
let usageStatsMicro = { key: '', at: 0, stats: null };

/** 清空统计结果缓存（测试用；也留给将来"重置用量统计"这类操作）。 */
export function resetUsageStatsCache() {
  usageStatsCache.clear();
  usageStatsInflight.clear();
  usageStatsMicro = { key: '', at: 0, stats: null };
  // 行缓存与档案也要清（2026-11-03 补）：
  // 之前只清了上面三个，usageRowsCache / usageArchive 还留着旧数据 ——
  // 「重置用量统计」之后界面显示的还是重置前的内容，测试之间也会互相污染。
  usageRowsCache.key = '';
  usageRowsCache.at = 0;
  usageRowsCache.rows = null;
  usageRowsCache.win = null;
  usageArchive.sig = '';
  usageArchive.at = 0;
  usageArchive.sessions = null;
}

/**
 * 计价输入的价格指纹。
 *
 * ⚠️ 为什么缓存 key 必须带它（曾经的 bug）：
 * 3 小时结果缓存的 key 原本只有 range，用户在设置里改了自定义单价之后，
 * 用量页的成本数字 3 小时内纹丝不动 —— 而这恰恰是最需要立刻生效的场景
 * （用户改价就是想看新口径）。价格指纹一变，缓存 key 就变，缓存自动失效。
 *
 * 取的是「真正影响计价的两处」：
 *   ① data/config.json 里的自定义价（mtime + 字节长度，够用且便宜）
 *   ② 远程价表 setRemotePrices 的条目数（远程价刷新会改变条目数）
 * 不做深度哈希：config.json 很小，而计价本身只在重算时发生。
 */
function priceSignature() {
  let cfgSig = '';
  try {
    const st = fs.statSync(path.join(DATA_DIR, 'config.json'));
    cfgSig = `${st.mtimeMs}:${st.size}`;
  } catch { cfgSig = 'nocfg'; }
  return `${cfgSig}|${remoteOverrideCount()}`;
}

export async function buildUsageStats({ range = '7', force = false } = {}) {
  const rangeKey = String(range);
  // 缓存键带上价格指纹：改单价后旧缓存自动作废（见 priceSignature 注释）
  const key = `${rangeKey}#${priceSignature()}`;
  // force 必须**同时**绕过两层缓存。踩过的坑：微缓存判定写在前面却没看 force，
  // 于是"点刷新"在两次请求间隔 <5 秒时直接吃微缓存 —— 结果是刷新按钮按下去
  // 数字纹丝不动（实测 computedAt 完全不变），比慢更让人困惑。
  if (!force) {
    // ① 5 秒微缓存（先判，命中最快：轮询 + SSE 事件风暴不再叠加统计）
    if (usageStatsMicro.stats && usageStatsMicro.key === key
        && Date.now() - usageStatsMicro.at < USAGE_STATS_MICRO_TTL_MS) {
      return usageStatsMicro.stats;
    }
    // ② 3 小时结果缓存
    const cached = usageStatsCache.get(key);
    if (cached && Date.now() - cached.at < USAGE_STATS_CACHE_TTL_MS) {
      usageStatsMicro = { key, at: Date.now(), stats: cached.stats };
      return cached.stats;
    }
  }
  // ③ 防重入：同 key 正在算就搭同一趟车。
  // ⚠️ 曾经这里是**单个全局槽**（let usageStatsInflight），key 不同就直接
  // 新开一个 Promise 覆盖掉前一个 —— 于是切 range 时前后两个 range 会
  // 同时全量重算，把刚做的缓存优化全还回去（大档案下表现为卡顿）。
  // 改成 Map：每个 key 各有各的在途 Promise，互不覆盖。
  const inflight = usageStatsInflight.get(key);
  if (inflight) return infight;
  const promise = (async () => {
    let stats = null;
    try {
      const r = await buildUsageStatsWithSnapshots({ range });
      if (r.stats && r.stats.totals) stats = r.stats;
    } catch (error) {
      console.warn('[usage] 快照统计路径失败，回落实时聚合：', error?.message ?? error);
    }
    if (!stats) {
      const { rows, win, searchCount, toolCounts } = await collectUsageRows({ range });
      const totals = costOfRows(rows);
      // 单日/24小时场景下"按天"没有意义（只有一行），由前端决定是否隐藏
      // 按天分桶需要 dayKey 字段
      for (const r of rows) r.dayKey = dayKeyOf(r.at);
      const byDay = win.mode === 'days'
        ? groupBy(rows, 'dayKey')
            // 与快照路径同构：补 key 字段 + 重算派生比率（groupBy 不带 cacheHitRate）
            .map((x) => withDerived(x.key, x))
            .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
        : [];
      const chats = groupBy(rows, 'chatKey', 0);
      // 不截断：截断会让"各行成本之和 ≠ 总成本"，用户核对时会困惑。
      // 行数多时由前端滚动容器处理。
      const models = groupBy(rows, 'modelKey', 0).map((m) => {
        const { vendor, model } = splitModelLabel(m.key);
        return { ...m, vendor, model };
      });
      stats = {
        range: String(range),
        rangeLabel: win.label,
        mode: win.mode,
        totals,
        // 次数类统计：只看数量，不参与成本计算
        searchCount: searchCount || 0,
        toolCounts: toolCounts || {},
        days: byDay,
        chats,
        models
      };
    }
    // 真正算出来的时刻：前端靠它显示"数据更新于 HH:MM"。缓存复用时不会被改写。
    stats.computedAt = Date.now();
    return stats;
  })();
  usageStatsInflight.set(key, promise);
  try {
    const stats = await promise;
    usageStatsCache.set(key, { at: Date.now(), stats });
    usageStatsMicro = { key, at: Date.now(), stats };
    // key 里带了价格指纹，用户每改一次价就多一组条目。虽然 TTL 判定期会
    // 让过期条目自然失效（get 时不看它、但它还占着 Map），但长时间反复改价
    // 仍会攒下垃圾。这里顺手裁掉已过期的，只保留 range 数量级的条目。
    if (usageStatsCache.size > 32) {
      const now = Date.now();
      for (const [k, v] of usageStatsCache) {
        if (now - v.at >= USAGE_STATS_CACHE_TTL_MS) usageStatsCache.delete(k);
      }
    }
    return stats;
  } finally {
    // 只清自己这一条，别把别的 range 的在途统计误清掉
    if (usageStatsInflight.get(key) === promise) usageStatsInflight.delete(key);
  }
}

/**
 * 下钻明细：在某个维度取某个值，再按另一个维度展开。
 *   dim/key 定位子集，by 决定展开方式
 * 例：dim=chat&key=group:123&by=model → 该群下各模型的成本
 */
export async function buildUsageBreakdown({ range = '7', dim = '', key = '', by = '' } = {}) {
  const { rows, win } = await collectUsageRows({ range });
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  // dim/by 为 model 时按复合身份匹配（模型 + 供应商）
  const fieldOf = (d) => (d === 'day' ? 'dayKey' : d === 'model' ? 'modelKey' : 'chatKey');
  const subset = dim ? rows.filter((r) => String(r[fieldOf(dim)] ?? '') === key) : rows;
  // 同样不截断：保证明细各项之和 = 该子集总成本
  const groups = groupBy(subset, fieldOf(by) || 'chatKey', 0);
  const sum = costOfRows(subset);
  // 峰谷信息跟随子集（弹窗外部上方展示用）
  return {
    range: String(range),
    dim, key, by,
    totals: sum,
    showPeak: sum.hasPeakModel && (sum.peakCost > 0 || sum.offPeakCost > 0),
    rows: groups.map((g) => ({
      key: g.key,
      cost: g.cost,
      promptTokens: g.promptTokens,
      completionTokens: g.completionTokens,
      cachedTokens: g.cachedTokens,
      totalTokens: g.totalTokens,
      cacheHitRate: g.cacheHitRate,
      runs: g.runs,
      exactCalls: g.exactCalls
    }))
  };
}

// ── 测试钩子（仅测试 import；生产代码不得依赖）──────────────────────

export function __testUsageDaily() {
  return {
    buildUsageStatsWithSnapshots,
    buildUsageStats,
    buildUsageBreakdown,
    collectUsageRows,
    loadUsageDaily,
    saveUsageDaily,
    completedDayKeys,
    aggregateDayFromArchive,
    // 2026-09-22 新增（R68）：数据元年下限 / 快照裁剪 / 结果缓存 / 后台预热
    usageDataFloorMs,
    pruneUsageDaily,
    resetUsageStatsCache,
    warmUsageArchive,
    sessionsDirSignature,
    USAGE_STATS_CACHE_TTL_MS,
    USAGE_DAILY_FILE
  };
}
