// 路由域：协议端：探测 / 托管进程 / 一键接入 / QQ 便携版
//
// 本文件由 src/routes.js 拆分而来（2026-11-04，R164）。**handler 代码逐字节原样搬运**，
// 只换了所在文件与函数外壳 —— 拆分的目的只是把 5248 行的单一函数按域切开，
// 不改任何一条路由的行为。新增路由请按域放进对应文件，不要再往 routes.js 里堆。
import { getConfig, updateConfig } from '../config.js';
// 探测结果的"可对外"视图：删掉两枚令牌，只留有无标记。
// 令牌不越过 HTTP 边界的保证在这个纯函数里，路由只负责调它。
import { publicView as protocolDetectView } from '../protocol-detect.js';

export function protocolRoutes(deps, shared) {
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
      method: 'POST', pattern: '/api/qq-portable/launch',
      handler: async ({ res, json }) => {
        try {
          const result = await launchPortableQQ();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/qq-portable/stop',
      handler: async ({ res, json }) => {
        try {
          const result = await stopPortableQQ();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/qq-portable/logs',
      handler: async ({ res, json }) => json(res, 200, { logs: qqPortableLogs.slice(-200) })
    },
    {
      // r105 搬运（自 v0.4.5 r48）：唤起便携 QQ 主窗口
      method: 'POST', pattern: '/api/qq-portable/show',
      handler: async ({ res, json }) => {
        try {
          const result = await showPortableQQ();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // r105 搬运（自 v0.4.5 r52）：一键安装便携 QQ —— 从本机已安装的 QQNT 复制。
      // body 可带 { sourceDir }（注册表/常见路径都找不到时的手动兜底），一般为空。
      // 复制以分钟计，前端轮询 /api/status 的 qqPortable.setup 显示进度。
      method: 'POST', pattern: '/api/qq-portable/setup',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const result = await setupPortableQQFromLocal(body || {});
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // r105 搬运（自 v0.4.5 r90）：?force=1 跳过「本机 QQ 探测」的 30s 缓存
      method: 'GET', pattern: '/api/qq-portable/status',
      handler: async ({ res, json, url }) => {
        const force = String(url?.searchParams?.get('force') || '') === '1';
        return json(res, 200, await qqPortableStatus({ force }));
      }
    },
    {
      method: 'GET', pattern: '/api/onebot/groups',
      handler: async ({ res, json }) => {
        try {
          const list = await onebot.call('get_group_list');
          const groups = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) }));
          return json(res, 200, { groups });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/onebot/friends',
      handler: async ({ res, json }) => {
        try {
          const list = await onebot.call('get_friend_list');
          const friends = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((f) => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id) }));
          return json(res, 200, { friends });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 协议端配置探测（只读，2026-10-24）──────────────────────────────────
      // 给连接页用：告诉 UI「能不能自动填、填的是哪个账号、端口在不在」。
      // 典型调用时机是"装好并登录了，重新检测"——先让它试自动填，再报结论。
      //
      // ⚠️ 响应里**没有令牌**：detectProtocol 的原始结果带明文，必须过 publicView。
      //    这条是令牌不越过 HTTP 边界的关键，改动时别把 hit 直接 json 出去。
      method: 'GET', pattern: '/api/protocol/detect',
      handler: async ({ res, json }) => {
        const hit = await detectProtocol({ isPortOpen });
        return json(res, 200, protocolDetectView(hit));
      }
    },
    {
      // 自动填端点/令牌（2026-10-24）────────────────────────────────────────
      // 与「保存并重连」走**同一条**落盘 + setEndpoint 路径，不另写一套连接逻辑。
      // 口径：
      //   · force=true  → 手动点「自动读取协议端配置」，以探测结果为准覆盖；
      //   · 不带 force  → 启动兜底，只补空字段（用户手填过的值不动）。
      // body 可带 dir（"我知道装在哪"），留空则由探测自己找。
      method: 'POST', pattern: '/api/protocol/autofill',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const dir = String(body.dir || '').trim();
        const r = await autoFillProtocol({ force: body.force === true, dir });
        return json(res, 200, r);
      }
    },
    {
      // 协议端端点：保存并立即生效（2026-10-23，协议端解耦配套）。
      //
      // 为什么需要专用端点：协议端现在由用户自行安装（SnowLuma / NapCat），端点
      // 地址与令牌是用户第一次配置就要填的；而 OneBotClient 在构造时快照了
      // wsUrl/httpUrl/令牌，改配置不重建连接就等于没改。以前只能"改完重启应用"，
      // 对刚装好协议端的人是一次莫名其妙的重启。这里把"落配置 + 换端点重连"
      // 合成一步。
      //
      // 令牌口径与设置页一致：空串 / '******' = 保持原值不变（脱敏回传的常态），
      // 只有真的输入了新明文才更新 —— 否则"保存一次地址就把令牌清空"。
      method: 'POST', pattern: '/api/protocol/apply',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const next = {};
        if (typeof body.wsUrl === 'string' && body.wsUrl.trim()) {
          const v = body.wsUrl.trim();
          if (!/^wss?:\/\//i.test(v)) return json(res, 400, { ok: false, error: 'WebSocket 地址要以 ws:// 或 wss:// 开头' });
          next.wsUrl = v;
        }
        if (typeof body.httpUrl === 'string' && body.httpUrl.trim()) {
          const v = body.httpUrl.trim();
          if (!/^https?:\/\//i.test(v)) return json(res, 400, { ok: false, error: 'HTTP 地址要以 http:// 或 https:// 开头' });
          next.httpUrl = v.replace(/\/+$/, '');
        }
        const wsToken = String(body.accessToken ?? '').trim();
        if (wsToken && wsToken !== '******') next.accessToken = wsToken;
        const httpToken = String(body.httpAccessToken ?? '').trim();
        if (httpToken && httpToken !== '******') next.httpAccessToken = httpToken;
        // 清空令牌要显式传 clearTokens —— 避免"空输入框"被当成"我要清空"。
        if (body.clearAccessToken === true) next.accessToken = '';
        if (body.clearHttpAccessToken === true) next.httpAccessToken = '';

        if (!Object.keys(next).length) {
          return json(res, 400, { ok: false, error: '没有要保存的改动' });
        }
        const cfg = updateConfig({ protocol: next });
        try {
          await onebot.setEndpoint({
            wsUrl: cfg.protocol?.wsUrl,
            httpUrl: cfg.protocol?.httpUrl,
            accessToken: cfg.protocol?.accessToken,
            httpToken: cfg.protocol?.httpAccessToken
          });
        } catch (e) {
          // 配置已经落盘（下次启动仍会用新值），只是本次重连没跑起来 —— 如实说
          return json(res, 200, { ok: true, applied: false, error: String(e?.message || e) });
        }
        return json(res, 200, {
          ok: true,
          applied: true,
          protocol: {
            wsUrl: String(cfg.protocol?.wsUrl || ''),
            httpUrl: String(cfg.protocol?.httpUrl || '')
          }
        });
      }
    },
    {
      // ── 协议端进程：无窗口启动 / 停止 / 日志（2026-10-27，R125）────────────
      //
      // 背景：协议端按 EULA 移出安装包后，用户改成自己双击 launcher.bat 启动，
      // 于是桌面上常驻一个 cmd 窗口。这组接口让本软件用 windowsHide 拉起**用户
      // 自己那份** SnowLuma，并把它的控制台输出接进连接页。
      //
      // 三条边界（改动时别越线）：
      //   · 不随包分发：目录由用户在 UI 里指定，服务端只读它的 index.mjs 路径；
      //   · 不改它的文件：不写 config/、不代签 EULA（0.4.8.x 的 SNOWLUMA_ACCEPT_EULA 已删除）；
      //   · 只停本进程拉起的那个：用户自己开着的窗口不受影响。
      method: 'GET', pattern: '/api/protocol/process',
      handler: async ({ res, json, url }) => {
        if (!protocolLauncher) return json(res, 200, { ok: false, supported: false, error: '进程托管未启用' });
        const limit = Number(url.searchParams.get('limit') || 300);
        return json(res, 200, {
          ok: true,
          status: protocolLauncher.status(),
          logs: protocolLauncher.logs(limit)
        });
      }
    },
    {
      method: 'POST', pattern: '/api/protocol/process/launch',
      handler: async ({ req, res, json }) => {
        if (!protocolLauncher) return json(res, 500, { ok: false, error: '进程托管未启用' });
        const body = await bodyOf(req);
        const dir = String(body.dir || '').trim();
        if (dir) protocolLauncher.saveDir(dir);
        const r = await protocolLauncher.launch({ dir });
        return json(res, r.ok ? 200 : 400, { ...r, status: protocolLauncher.status() });
      }
    },
    {
      method: 'POST', pattern: '/api/protocol/process/stop',
      handler: async ({ res, json }) => {
        if (!protocolLauncher) return json(res, 500, { ok: false, error: '进程托管未启用' });
        const r = await protocolLauncher.stop();
        return json(res, r.ok ? 200 : 400, { ...r, status: protocolLauncher.status() });
      }
    },
    {
      // 只改配置（目录 / 自动启动），不启动进程 —— 用户先填路径、之后自己按启动
      method: 'POST', pattern: '/api/protocol/process/config',
      handler: async ({ req, res, json }) => {
        if (!protocolLauncher) return json(res, 500, { ok: false, error: '进程托管未启用' });
        const body = await bodyOf(req);
        const patch = {};
        if (typeof body.dir === 'string') patch.dir = body.dir.trim();
        if (typeof body.autoLaunch === 'boolean') patch.autoLaunch = body.autoLaunch;
        if (patch.dir !== undefined) protocolLauncher.saveDir(patch.dir);
        if (patch.autoLaunch !== undefined) updateConfig({ protocol: { launcher: { autoLaunch: patch.autoLaunch } } });
        return json(res, 200, { ok: true, status: protocolLauncher.status() });
      }
    },
    {
      method: 'GET', pattern: '/api/protocol/process/logs',
      handler: async ({ res, json, url }) => {
        if (!protocolLauncher) return json(res, 200, { ok: false, logs: [] });
        return json(res, 200, { ok: true, logs: protocolLauncher.logs(Number(url.searchParams.get('limit') || 300)) });
      }
    },
    {
      // ── 协议端「一键接入」向导（2026-10-27，R126）──────────────────────────
      //
      // 这几条是"注入"傻瓜化的全部后端：探测当前卡在哪 → 提交密码 → 注入。
      //
      // 合规边界（改之前先读 src/protocol-webui.js 顶部那份）：
      //   · 只调 SnowLuma 自己的 WebUI API，等价于用户在它界面上点；
      //   · 不写它的任何文件；不代签协议、不代改密码；
      //   · 密码只存在本地 config（sanitizeConfig 已脱敏），响应里**永不回明文**。
      method: 'GET', pattern: '/api/protocol/onboard',
      handler: async ({ res, json }) => {
        if (!protocolOnboard) return json(res, 200, { ok: false, available: false });
        try {
          const s = await protocolOnboard.status();
          return json(res, 200, { ok: true, available: true, ...s });
        } catch (error) {
          return json(res, 200, { ok: false, available: true, stage: 'error', message: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/protocol/onboard/connect',
      handler: async ({ req, res, json }) => {
        if (!protocolOnboard) return json(res, 500, { ok: false, error: '接入向导未启用' });
        const body = await bodyOf(req);
        try {
          const r = await protocolOnboard.connect({
            password: String(body.password || ''),
            pid: Number(body.pid) || 0
          });
          return json(res, r.ok ? 200 : 200, r);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 只存密码（用户先填、稍后再点接入；也让"密码填错了"能单独纠正）
      method: 'POST', pattern: '/api/protocol/onboard/password',
      handler: async ({ req, res, json }) => {
        if (!protocolOnboard) return json(res, 500, { ok: false, error: '接入向导未启用' });
        const body = await bodyOf(req);
        const pw = String(body.password || '');
        if (!pw) return json(res, 400, { ok: false, error: '密码不能为空' });
        protocolOnboard.savePassword(pw);
        protocolOnboard.forgetToken();
        return json(res, 200, { ok: true, hasPassword: true });
      }
    },
    {
      method: 'POST', pattern: '/api/protocol/onboard/forget',
      handler: async ({ res, json }) => {
        if (!protocolOnboard) return json(res, 500, { ok: false, error: '接入向导未启用' });
        protocolOnboard.forgetToken();
        return json(res, 200, { ok: true });
      }
    },
    {
      // OneBot 令牌明文读取：控制台「显示」按钮专用（与 /api/search-key 同一套来源校验）。
      // 必须有这个端点：配置经 sanitizeConfig 脱敏后前端只拿得到掩码，
      // 用户想"看一眼现有令牌"只能走这里。
      method: 'GET', pattern: '/api/onebot-token',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const which = String(url.searchParams.get('which') || '');
        const proto = getConfig().protocol || {};
        if (which === 'ws') return json(res, 200, { token: String(proto.accessToken || '') });
        if (which === 'http') return json(res, 200, { token: String(proto.httpAccessToken || proto.accessToken || '') });
        return json(res, 400, { error: `未知令牌类型：${which}` });
      }
    },
  ];
}
