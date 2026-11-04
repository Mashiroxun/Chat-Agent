// 路由域：自动修复：提案 / 应用 / 验证 / 回滚 / 导出
//
// 本文件由 src/routes.js 拆分而来（2026-11-04，R164）。**handler 代码逐字节原样搬运**，
// 只换了所在文件与函数外壳 —— 拆分的目的只是把 5248 行的单一函数按域切开，
// 不改任何一条路由的行为。新增路由请按域放进对应文件，不要再往 routes.js 里堆。
import { skillRuntimeContext } from './_shared.js';
import fs from 'node:fs';
import { getConfig } from '../config.js';
import { chatCompletion, resolveApiKey } from '../llm.js';
import { logger } from '../logger.js';
import { skillManager } from '../skills/manager.js';
// 探测结果的"可对外"视图：删掉两枚令牌，只留有无标记。
// 令牌不越过 HTTP 边界的保证在这个纯函数里，路由只负责调它。

export function fixRoutes(deps, shared) {
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
      method: 'GET', pattern: '/api/fix/status',
      handler: async ({ res, json }) => {
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.status', ctx);
        if (!provs.length) {
          return json(res, 200, {
            ok: true, available: false,
            error: '「自动修复」模块未注册（自检 → 自动修复 页可查看状态）'
          });
        }
        try { return json(res, 200, { ok: true, available: true, ...(provs[0].fn({}) || {}) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      method: 'GET', pattern: '/api/fix/list',
      handler: async ({ res, json, url }) => {
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.list', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        const status = String(url.searchParams.get('status') || '');
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        try { return json(res, 200, { ok: true, available: true, ...(provs[0].fn({ status, limit }) || {}) }); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      method: 'GET', pattern: '/api/fix/detail',
      handler: async ({ res, json, url }) => {
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.detail', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        const fixId = String(url.searchParams.get('fixId') || '');
        if (!fixId) return json(res, 400, { ok: false, error: '缺少 fixId' });
        try { return json(res, 200, { available: true, ...(provs[0].fn({ fixId }) || {}) }); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 闸①之前：只出一条**提案**。不写任何真实文件，本接口也绝不落盘改动。
      method: 'POST', pattern: '/api/fix/propose',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const promptProvs = skillManager.getCapabilityProviders('fix.prompt', ctx);
        const createProvs = skillManager.getCapabilityProviders('fix.create', ctx);
        if (!promptProvs.length || !createProvs.length) {
          return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用（或未开启自动修复）' });
        }
        // ① 拼 prompt（插件侧读文件片段，核心不懂路径规则）
        let p;
        try {
          p = promptProvs[0].fn({
            question: String(body.question || ''),
            answer: String(body.answer || ''),
            target: body.target || null,
            extraNote: String(body.extraNote || '')
          });
        } catch (error) { return json(res, 500, { ok: false, error: `准备提案失败：${String(error?.message ?? error)}` }); }
        if (!p?.ok) return json(res, 200, { ok: false, available: true, error: p?.error || '无法准备提案' });

        // ② 选凭据（与 /api/doctor/ask 完全同源：doctorApi 开关对这里也生效）
        const cfg = getConfig();
        const d = cfg.doctorApi || {};
        const useOwn = d.enabled === true && String(d.model || '').trim();
        const overrides = useOwn ? {
          baseUrl: String(d.baseUrl || cfg.api?.baseUrl || ''),
          apiKey: String(d.apiKey || '').trim() || resolveApiKey(cfg),
          model: String(d.model).trim()
        } : null;
        const modelName = useOwn ? overrides.model : cfg.api?.model;
        if (!modelName) {
          return json(res, 200, {
            ok: false, available: true,
            error: useOwn ? '自检专用模型未填 model（harness → 模型设置）' : '尚未配置聊天模型（设置 → 模型与搜索 → 模型 API）'
          });
        }

        try {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(new Error('提案请求超时（120s）')), 120000);
          let text = '';
          try {
            const r = await chatCompletion({
              messages: [{ role: 'system', content: p.sys }, { role: 'user', content: p.user }],
              temperature: 0.2,
              maxTokens: 2400,
              signal: ac.signal,
              overrides,
              // ⚠️ 与 triage / ask 同理：deepseek 系推理模型的 reasoning token 从 max_tokens 里扣，
              //    不关思考会出现"提案解析出 0 条"的静默失败。
              skillContext: { thinkingMode: 'off' },
              tag: 'fix-propose'
            });
            text = r?.message?.content || r?.content || '';
          } finally { clearTimeout(timer); }

          if (!String(text).trim()) {
            return json(res, 200, { ok: false, available: true, error: '模型返回空正文（可能思考 token 吃光了 max_tokens）' });
          }
          const parseProvs = skillManager.getCapabilityProviders('fix.parse', ctx);
          if (!parseProvs.length) return json(res, 200, { ok: false, error: '插件缺少 fix.parse 能力' });
          const parsed = parseProvs[0].fn({ text });
          if (!parsed?.ok) return json(res, 200, { ok: false, available: true, error: `提案解析失败：${parsed?.error}`, raw: String(text).slice(0, 2000) });

          const made = createProvs[0].fn({
            question: body.question, answer: body.answer, target: body.target,
            proposal: parsed.proposal, model: modelName
          });
          if (!made?.ok) return json(res, 200, { ok: false, available: true, error: made?.error || '创建工单失败' });
          return json(res, 200, {
            ok: true, available: true, model: modelName, ownConfig: useOwn,
            noChange: !!made.noChange,
            // ⚠️ 2026-10-28 修（审计 M4）：不再返回 approvalToken —— 否则 propose→apply
            //    可由任何 HTTP 客户端一条链路自动完成，人工闸①形同虚设。
            //    票据改由 /api/fix/approve 在人工点击「批准并应用」时现签。
            fixId: made.fixId,
            record: made.record, summary: made.summary,
            files: p.files || []
          });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `模型调用失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 闸① 的换票：人工点「批准并应用」时现签一张一次性票据（10 分钟有效）。
      // 与 apply 分成两步是刻意的 —— 见 fix/index.js 的 fix.approve 注释（审计 M4）。
      method: 'POST', pattern: '/api/fix/approve',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.approve', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        try { return json(res, 200, provs[0].fn({ fixId: body.fixId }) || { ok: false }); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 闸①：必须带一次性批准令牌。令牌错/过期/用过 → 拒绝且什么都不做。
      method: 'POST', pattern: '/api/fix/apply',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.apply', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        try {
          const out = provs[0].fn({ fixId: body.fixId, approvalToken: body.approvalToken, extraNote: body.extraNote });
          return json(res, out?.ok ? 200 : (out?.code === 403 ? 403 : 200), out || { ok: false });
        } catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      method: 'POST', pattern: '/api/fix/gate',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.gate', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        try { return json(res, 200, provs[0].fn({ fixId: body.fixId }) || { ok: false }); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 自验（沙箱真跑）。原始产物由插件落盘，这里只把汇总回给前端。
      method: 'POST', pattern: '/api/fix/verify',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.verify', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        try {
          const out = provs[0].fn({ fixId: body.fixId });
          try { emit?.('fix-verify', { fixId: body.fixId, ...(out?.verify || {}) }); } catch { /* 推送失败不影响结果 */ }
          return json(res, 200, out || { ok: false });
        } catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 闸②的「重跑」：同一版本再跑一遍，不改码，限次。
      method: 'POST', pattern: '/api/fix/rerun',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.rerun', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        try { return json(res, 200, provs[0].fn({ fixId: body.fixId }) || { ok: false }); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 闸②的「通过」：快照 → 写真实文件（唯一允许写真实路径的地方）。
      method: 'POST', pattern: '/api/fix/commit',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.commit', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        try {
          const out = provs[0].fn({ fixId: body.fixId });
          // 落了 plugins/ 下的改动会被 fs.watch 热重载；核心改动需要重启才生效
          if (out?.ok) {
            try { reloadSkills?.(); } catch { /* ignore */ }
            try { emit?.('fix-committed', { fixId: body.fixId, needsRestart: !!out.needsRestart }); } catch { /* ignore */ }
          }
          return json(res, 200, out || { ok: false });
        } catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      method: 'POST', pattern: '/api/fix/rollback',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.rollback', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        try {
          const out = provs[0].fn({ fixId: body.fixId });
          if (out?.ok) { try { reloadSkills?.(); } catch { /* ignore */ } }
          return json(res, 200, out || { ok: false });
        } catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      method: 'POST', pattern: '/api/fix/discard',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.discard', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        try { return json(res, 200, provs[0].fn({ fixId: body.fixId, reason: body.reason }) || { ok: false }); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 删一笔审计。deleteSnapshot 必须显式给 —— 快照是回滚的唯一依据，不能顺手删掉。
      method: 'DELETE', pattern: '/api/fix',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.delete', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        if (!body.fixId) return json(res, 400, { ok: false, error: '缺少 fixId' });
        try { return json(res, 200, provs[0].fn({ fixId: body.fixId, deleteSnapshot: body.deleteSnapshot === true }) || { ok: false }); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      method: 'POST', pattern: '/api/fix/prune',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.prune', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        try { return json(res, 200, provs[0].fn(body) || { ok: false }); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 导出报告。format=docx 返回二进制流（前端 fetch 成 blob 下载）；format=md 返回 JSON。
      method: 'POST', pattern: '/api/fix/export',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('fix.export', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「自动修复」插件未启用' });
        if (!body.fixId) return json(res, 400, { ok: false, error: '缺少 fixId' });
        // 导出前先让模型写一份"叙事"（可选）：body.narrate !== false 时尝试
        if (body.narrate !== false) {
          try {
            const rp = skillManager.getCapabilityProviders('fix.report-prompt', ctx)[0]?.fn({ fixId: body.fixId });
            const sp = skillManager.getCapabilityProviders('fix.report-save', ctx)[0];
            if (rp?.ok && sp) {
              const cfg2 = getConfig();
              const d2 = cfg2.doctorApi || {};
              const own2 = d2.enabled === true && String(d2.model || '').trim();
              const ov2 = own2 ? {
                baseUrl: String(d2.baseUrl || cfg2.api?.baseUrl || ''),
                apiKey: String(d2.apiKey || '').trim() || resolveApiKey(cfg2),
                model: String(d2.model).trim()
              } : null;
              const ac2 = new AbortController();
              const t2 = setTimeout(() => ac2.abort(new Error('报告叙事超时（120s）')), 120000);
              try {
                const r = await chatCompletion({
                  messages: [{ role: 'system', content: rp.sys }, { role: 'user', content: rp.user }],
                  temperature: 0.3, maxTokens: 2000, signal: ac2.signal, overrides: ov2,
                  skillContext: { thinkingMode: 'off' }, tag: 'fix-report'
                });
                const txt = r?.message?.content || r?.content || '';
                if (txt) sp.fn({ fixId: body.fixId, text: txt });
              } finally { clearTimeout(t2); }
            }
          } catch (error) {
            logger.warn('fix', `报告叙事失败，导出退化为基础报告：${String(error?.message ?? error)}`);
          }
        }
        try {
          const out = provs[0].fn({ fixId: body.fixId, format: body.format === 'docx' ? 'docx' : 'md' });
          if (!out?.ok) return json(res, 200, out || { ok: false });
          if (out.format === 'docx' && out.buffer) {
            const buf = Buffer.isBuffer(out.buffer) ? out.buffer : Buffer.from(out.buffer);
            res.writeHead(200, {
              'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'content-disposition': `attachment; filename="${encodeURIComponent(out.filename)}"`,
              'content-length': String(buf.length)
            });
            res.end(buf);
            return undefined;
          }
          return json(res, 200, { ok: true, format: 'md', filename: out.filename, markdown: out.markdown });
        } catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
  ];
}
