// 路由域：开发工单：会话快照、收发、配置
//
// 本文件由 src/routes.js 拆分而来（2026-11-04，R164）。**handler 代码逐字节原样搬运**，
// 只换了所在文件与函数外壳 —— 拆分的目的只是把 5248 行的单一函数按域切开，
// 不改任何一条路由的行为。新增路由请按域放进对应文件，不要再往 routes.js 里堆。
import { skillRuntimeContext } from './_shared.js';
import { getConfig, updateConfig } from '../config.js';
import { resolveApiKey } from '../llm.js';
import { skillManager } from '../skills/manager.js';
// 探测结果的"可对外"视图：删掉两枚令牌，只留有无标记。
// 令牌不越过 HTTP 边界的保证在这个纯函数里，路由只负责调它。

export function devRoutes(deps, shared) {
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
      method: 'GET', pattern: '/api/dev/snapshot',
      handler: async ({ res, json, url }) => {
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('dev.snapshot', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「开发工单」插件未启用（顶部「插件」页 → dev-orders）' });
        try {
          // selected 透传：选中会话若不在服务端截断的最新 100 条里，由插件兜底追加，
          // 否则前端"选中项不在列表就复位"会每秒把用户选中清掉（2026-10-15 回归修复）。
          const selected = String(url.searchParams.get('selected') || '');
          return json(res, 200, { available: true, ...provs[0].fn({ selected }) });
        } catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      method: 'POST', pattern: '/api/dev/whitelist',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const action = String(body.action || '');
        const cap = action === 'add' ? 'dev.whitelist-add' : (action === 'remove' ? 'dev.whitelist-remove' : '');
        if (!cap) return json(res, 400, { ok: false, error: 'action 必须是 add / remove' });
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders(cap, ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「开发工单」插件未启用' });
        try { return json(res, 200, { available: true, ...provs[0].fn({ qq: body.qq }) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 本机对着一个会话说话（会并进同一个开发会话；回复留在页面，不发 QQ）。
      method: 'POST', pattern: '/api/dev/send',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('dev.send', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「开发工单」插件未启用' });
        try { return json(res, 200, { available: true, ...provs[0].fn({ id: body.id, text: body.text }) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 本机开一个新会话（可带第一句话）。
      method: 'POST', pattern: '/api/dev/new',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('dev.new-session', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「开发工单」插件未启用' });
        try { return json(res, 200, { available: true, ...provs[0].fn({ text: body.text }) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 归档一个会话（QQ 侧对等的命令是「退出开发」）。
      method: 'POST', pattern: '/api/dev/close',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('dev.close', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「开发工单」插件未启用' });
        try { return json(res, 200, { available: true, ...provs[0].fn({ id: body.id }) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 重开旧工单（2026-10-09 加）：归档的工单回到 active，带着追加式上下文继续干。
      // QQ 侧对应「开发#6」。
      method: 'POST', pattern: '/api/dev/reopen',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('dev.reopen', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「开发工单」插件未启用' });
        try { return json(res, 200, { available: true, ...provs[0].fn({ id: body.id }) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 中止正在跑的那一轮（2026-10-08 加）。
      // 没有它的话，跑飞的一轮最长要等 turnTimeoutSec（默认 1 小时），而且调度是全局单飞
      // —— 那一轮不结束，**所有**会话都排队，界面只显示"模型正在干活…"，用户以为卡死。
      method: 'POST', pattern: '/api/dev/abort',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('dev.abort', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「开发工单」插件未启用' });
        try { return json(res, 200, { available: true, ...provs[0].fn({ id: body.id }) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 永久删除一个会话（含开发记录与对话历史；沙箱产出文件保留）。
      method: 'POST', pattern: '/api/dev/delete',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('dev.delete', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「开发工单」插件未启用' });
        try { return json(res, 200, { available: true, ...provs[0].fn({ id: body.id }) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 「开发工单」专用模型配置（与自检页同款：patch devApi 段；apiKey 留空=保留原值）。
      method: 'GET', pattern: '/api/dev/config',      handler: async ({ res, json }) => {
        const cfg = getConfig();
        const d = cfg.devApi || {};
        return json(res, 200, {
          ok: true,
          config: {
            enabled: d.enabled === true,
            baseUrl: String(d.baseUrl || ''),
            model: String(d.model || ''),
            hasApiKey: Boolean(String(d.apiKey || '').trim())
          },
          global: {
            baseUrl: String(cfg.api?.baseUrl || ''),
            model: String(cfg.api?.model || ''),
            hasApiKey: Boolean(resolveApiKey(cfg))
          },
          doctorApi: {
            enabled: (cfg.doctorApi || {}).enabled === true,
            model: String((cfg.doctorApi || {}).model || '')
          }
        });
      }
    },
    {
      method: 'POST', pattern: '/api/dev/config',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const patch = {};
        if (body.enabled !== undefined) patch.enabled = body.enabled === true;
        if (body.baseUrl !== undefined) patch.baseUrl = String(body.baseUrl || '').trim();
        if (body.model !== undefined) patch.model = String(body.model || '').trim();
        const rawKey = String(body.apiKey ?? '').trim();
        if (body.clearApiKey === true) patch.apiKey = '';
        else if (rawKey && rawKey !== '******') patch.apiKey = rawKey;
        if (!Object.keys(patch).length) return json(res, 400, { ok: false, error: '没有可写入的字段' });

        updateConfig({ devApi: patch });
        const d = getConfig().devApi || {};
        return json(res, 200, {
          ok: true,
          config: {
            enabled: d.enabled === true,
            baseUrl: String(d.baseUrl || ''),
            model: String(d.model || ''),
            hasApiKey: Boolean(String(d.apiKey || '').trim())
          }
        });
      }
    },
    {
      // 开发专用 Key 明文读取：与 /api/doctor/config-key 同一套来源校验（只放行控制台）。
      method: 'GET', pattern: '/api/dev/config-key',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const d = getConfig().devApi || {};
        return json(res, 200, { apiKey: String(d.apiKey || ''), hasApiKey: Boolean(String(d.apiKey || '').trim()) });
      }
    },
    {
      // 对话视图：增量读一个会话的"开发记录"（transcript）。
      // from = 不透明游标（插件侧语义是**字节偏移**，前端原样回传 nextFrom）；跑单时每秒拉一次，
      //   开销只有新增的那一段（2026-10-15 前是整文件重读，文件一大就把主线程拖死）。
      // before = 「载入更早」：往前翻一页（此时忽略 from）。
      method: 'GET', pattern: '/api/dev/detail',
      handler: async ({ res, json, url }) => {
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('dev.order-detail', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「开发工单」插件未启用' });
        try {
          const id = String(url.searchParams.get('id') || '');
          const from = Number(url.searchParams.get('from') || 0) || 0;
          const before = Number(url.searchParams.get('before') || 0) || 0;
          return json(res, 200, { available: true, ...provs[0].fn({ id, from, before }) });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
  ];
}
