// 路由域：系统状态：启动组合、状态、用量、版本、日志
//
// 本文件由 src/routes.js 拆分而来（2026-11-04，R164）。**handler 代码逐字节原样搬运**，
// 只换了所在文件与函数外壳 —— 拆分的目的只是把 5248 行的单一函数按域切开，
// 不改任何一条路由的行为。新增路由请按域放进对应文件，不要再往 routes.js 里堆。
import { skillRuntimeContext, withStatusTimeout, QQ_PORTABLE_DEGRADED, updateFeedState } from './_shared.js';
import { getConfig, DATA_DIR } from '../config.js';
import { estimateCost, cacheHitRate } from '../llm.js';
import { todayKey } from '../util.js';
import { logger } from '../logger.js';
import { buildPluginUsage } from '../plugin-usage.js';
import { getAvatar, AVATAR_SIZES } from '../avatar-cache.js';
// 探测结果的"可对外"视图：删掉两枚令牌，只留有无标记。
// 令牌不越过 HTTP 边界的保证在这个纯函数里，路由只负责调它。

export function systemRoutes(deps, shared) {
  const {
    store, memory, sessions, onebot, orchestrator,
    emit, log,
    // app.js 内部的过程/状态
    localVersion, compareSemver, UPDATE_INFO_URL,
    sanitizeConfig, keyEndpointAllowed, sanitizeProvider,
    // r92：删掉 authorize 的死解构 —— 本文件从未用它，鉴权实际在 app.js
    // 统一执行。留着它会误导后来者以为某条路由漏鉴权。
    readBody,
    qqPortableStatus, qqPortableLogs, launchPortableQQ, stopPortableQQ,
    showPortableQQ, setupPortableQQFromLocal,
    visionScan,
    buildUsageStats, buildUsageBreakdown,
    reloadSkills,
    // 协议端配置探测（见 app.js autoFillProtocol）
    autoFillProtocol, detectProtocol,
    // 协议端进程托管（无窗口启动 + 日志，见 src/protocol-launcher.js）
    protocolLauncher,
    // 协议端「一键接入」向导（登录控制台 → 挑号 → 注入，见 src/protocol-onboard.js）
    protocolOnboard
  } = deps;
  const { bodyOf } = shared;

  return [
    {
      method: 'GET', pattern: '/api/status',
      handler: async ({ res, json }) => {
        const dayKey = todayKey();
        const usage = sessions.todayUsage(dayKey);
        const cfgNow = getConfig();
        const cost = estimateCost(usage, { model: cfgNow.api?.model });
        // 协议端（OneBot v11）运行判定用 WS 端口是否在监听。
        // 协议端由用户自行安装运行（SnowLuma / NapCat 任选其一），本软件只负责连。
        const obWsPort = (() => {
          try {
            const u = new URL(String(getConfig().protocol?.wsUrl || 'ws://127.0.0.1:3001'));
            return u.port ? Number(u.port) : 3001;
          } catch { return 3001; }
        })();
        const obPortOpen = await deps.isPortOpen('127.0.0.1', obWsPort);
        // 诊断：把"连不上"拆成用户能看懂的原因（给 UI 就绪度体检用）。
        let onebotDiagnosis = '';
        if (!onebot.connected) {
          if (!obPortOpen) onebotDiagnosis = `协议端未运行或未监听 WS 端口：请确认你安装的 SnowLuma 或 NapCat 已在运行（当前 ${String(getConfig().protocol?.wsUrl || '') || '未设置地址'}）`;
          else if (String(onebot.lastConnectError || '').includes('401')) onebotDiagnosis = '连接密码不一致（OneBot 访问令牌）：正在自动重试；若持续出现，去「设置 → 连接 QQ」重新填写访问令牌';
          else onebotDiagnosis = onebot.lastConnectError ? `连接失败：${String(onebot.lastConnectError).slice(0, 120)}` : '协议端已在运行，等待 OneBot 就绪（QQ 登录后数秒内会自动连上）…';
        }
        // 给可能很慢的便携 QQ 探测套短超时，避免拖垮整条状态接口（定义见上方 withStatusTimeout）。
        const qqPortable = await withStatusTimeout(qqPortableStatus(), QQ_PORTABLE_DEGRADED, 1500);
        return json(res, 200, {
          // 运维脚本不必再去猜 /api/version：状态接口自己带上实际安装版本
          //（dataDir 本就在返回体末尾）。localVersion() 只读一次本地 package.json，
          // 秒级轮询热路径上开销可忽略。
          version: localVersion(),
          degraded: !!qqPortable?.degraded,
          onebot: {
            connected: onebot.connected,
            everConnected: onebot.everConnected,
            // 本次上线时刻：连接页算"已在线 2 小时 14 分"用。没连上就是 null。
            connectedAt: onebot.connectedAt || null,
            error: onebot.lastConnectError,
            diagnosis: onebotDiagnosis,
            self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
          },
          protocol: {
            wsUrl: String(getConfig().protocol?.wsUrl || ''),
            httpUrl: String(getConfig().protocol?.httpUrl || ''),
            // WS 端口是否在监听（协议端是否在跑）。与 connected 分开：
            // 端口开着但连不上 = 令牌/账号问题；端口没开 = 协议端没起来。
            portOpen: obPortOpen
          },
          // 协议端进程托管状态（2026-10-27）：连接页据此显示「由本软件启动 / 已停止」
          // 与那枚「无窗口启动」按钮。没有 launcher 时给 null，UI 自动隐藏那一节。
          protocolProcess: protocolLauncher ? protocolLauncher.status() : null,
          qqPortable,
          orchestrator: orchestrator.statusSummary(),
          usage,
          cost,
          cacheHitRate: cacheHitRate(usage),
          webSearchCount: usage.webSearchCount || 0,
          paused: orchestrator.paused,
          pauseReason: orchestrator.pauseReason ?? null,
          dataDir: DATA_DIR
        });
      }
    },
    {
      method: 'GET', pattern: '/api/usage/stats',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || url.searchParams.get('days') || '7');
          // force=1：绕过 3 小时结果缓存，当场重算（用户点「刷新」时前端带这个参数）。
          // 统计结果本身有缓存，但"用户明确要求现在算"必须被尊重 —— 否则那个刷新
          // 按钮按下去没反应，比慢更让人困惑。
          const force = ['1', 'true', 'yes', 'force'].includes(
            String(url.searchParams.get('force') || '').trim().toLowerCase());
          const stats = await buildUsageStats({ range: raw, force });
          return json(res, 200, { ok: true, range: raw, ...stats });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/usage/plugins',
      // 「按插件」统计：token 归因到插件与具体功能 + 对缓存命中率的影响。
      // 口径见 src/plugin-usage.js 头部注释（估算值；调用明细来自会话文件的
      // message.toolCall，会话被裁剪后只覆盖磁盘上还在的部分）。
      handler: async ({ res, json, url }) => {
        try {
          const range = String(url.searchParams.get('range') || '7');
          const result = buildPluginUsage({ range, context: skillRuntimeContext() });
          return json(res, 200, { ok: true, ...result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/usage/breakdown',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || '7');
          const dim = String(url.searchParams.get('dim') || '');
          const key = String(url.searchParams.get('key') || '');
          const by = String(url.searchParams.get('by') || '');
          const r = await buildUsageBreakdown({ range: raw, dim, key, by });
          return json(res, 200, { ok: true, ...r });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/version',
      handler: async ({ res, json }) => json(res, 200, { version: localVersion() })
    },
    {
      method: 'GET', pattern: '/api/update-check',
      handler: async ({ res, json }) => {
        const current = localVersion();
        // 更新源可配置（2026-11-04）：config.update.checkUrl 优先，留空用内置默认。
        // disabled=true 时直接返回，不发起任何网络请求（离线部署用）。
        const updateCfg = getConfig().update ?? {};
        if (updateCfg.disabled) {
          return json(res, 200, { ok: true, current, latest: current, hasUpdate: false, disabled: true });
        }
        const checkUrl = String(updateCfg.checkUrl || UPDATE_INFO_URL || '').trim();
        if (!checkUrl) {
          return json(res, 200, { ok: false, current, error: '未配置更新源地址' });
        }
        try {
          const r = await fetch(checkUrl, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const info = await r.json();
          const latest = String(info.version || '');
          if (!latest) throw new Error('version.json 缺少 version 字段');
          // 远端比本地还低 = 更新源没跟着发版推进。此时 hasUpdate 必然 false，
          // 光看它和"已是最新"分不开（2026-10-23 实测：远端 0.4.0 / 本地 0.4.8.9）。
          // 单独给 stale 字段，UI 可以据此提示"更新源未更新"而不是"已是最新"。
          const stale = compareSemver(latest, current) < 0;
          if (stale && !updateFeedState.staleWarned) {
            updateFeedState.staleWarned = true;
            logger.warn('update', `更新源版本（${latest}）落后于当前安装（${current}）：version.json 需要随发版更新，否则新版本永远不会被提示`);
          }
          return json(res, 200, {
            ok: true, current, latest,
            hasUpdate: compareSemver(latest, current) > 0,
            stale,
            staleHint: stale
              ? `更新源版本（${latest}）低于当前安装（${current}）：服务器上的 version.json 尚未推进，因此不会提示更新`
              : '',
            url: String(info.url || 'https://kondius.cn/qq-agent'),
            notes: String(info.notes || '')
          });
        } catch (error) {
          return json(res, 200, { ok: false, current, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 最近的日志（UI 日志页签首次加载）
      method: 'GET', pattern: '/api/logs',
      handler: async ({ res, json, url }) => {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        return json(res, 200, { logs: logger.recent(limit), level: logger.getLevel() });
      }
    },
    {
      // 调整最低落盘级别（debug/info/warn/error）
      method: 'POST', pattern: '/api/logs/level',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const level = String(body.level || 'info');
        logger.setLevel(level);
        return json(res, 200, { ok: true, level: logger.getLevel() });
      }
    },
    {
      // QQ 头像本地缓存伺服（2026-11-04）：记忆卡片等处的头像不再直连
      // q1.qlogo.cn（每次渲染 DNS+TLS+CDN 往返，CDN 又不给长期缓存头，慢），
      // 改走这里：先读磁盘缓存（src/avatar-cache.js），未命中才出网拉一次。
      // 只认 5~12 位纯数字 QQ 号与固定尺寸档，其它一律 404 —— UI 侧本来就有
      // 首字兜底，404 触发 img 的 error 事件正好走兜底。
      // 浏览器缓存 7 天：本地回环虽然快，但 max-age 让重复渲染连请求都不发。
      // 2026-11-05 审查修复：method 用 '*' 才能同时接住 GET / HEAD —— 分发器
      //   （src/app.js:1381）是按 method 严格相等的，写 'GET' 时 handler 里的
      //   HEAD 分支永远走不到；尺寸校验移到路由层，不再用 Number(x)||100
      //   把非法值悄悄洗成默认档；响应补 nosniff。
      method: '*', pattern: /^\/api\/avatar\/(\d{5,12})$/,
      handler: async ({ res, json, match, url, method }) => {
        if (method !== 'GET' && method !== 'HEAD') {
          return json(res, 405, { ok: false, error: '仅支持 GET / HEAD' });
        }
        const raw = url.searchParams.get('s');
        const s = raw === null ? 100 : Number(raw);   // 没传才默认；空串/NaN/0 都落入下面的 404
        if (!AVATAR_SIZES.has(s)) return json(res, 404, { ok: false, error: '头像尺寸不支持' });
        const r = await getAvatar(match[1], s);
        if (!r) return json(res, 404, { ok: false, error: '头像不可用' });
        res.writeHead(200, {
          'content-type': r.contentType,
          'content-length': r.buffer.length,
          'cache-control': 'private, max-age=604800',
          'x-content-type-options': 'nosniff'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(r.buffer);
        return;
      }
    },
  ];
}
