// 路由域：数据管理：打包 / 接收 / 移植 / 重置 / 背景
//
// 本文件由 src/routes.js 拆分而来（2026-11-04，R164）。**handler 代码逐字节原样搬运**，
// 只换了所在文件与函数外壳 —— 拆分的目的只是把 5248 行的单一函数按域切开，
// 不改任何一条路由的行为。新增路由请按域放进对应文件，不要再往 routes.js 里堆。
import { skillRuntimeContext } from './_shared.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getConfig, updateConfig, DATA_DIR } from '../config.js';
import { skillManager } from '../skills/manager.js';
import { setSkillEnabled } from '../skills/config.js';
import { applyImport, rollbackImport, listBackups } from '../migrate.js';
import {
  listBundleOptions, exportBundle, inspectBundle, moduleZipOf,
  dataDirOf, discardBundle
} from '../bundle.js';
// 探测结果的"可对外"视图：删掉两枚令牌，只留有无标记。
// 令牌不越过 HTTP 边界的保证在这个纯函数里，路由只负责调它。

export function bundleRoutes(deps, shared) {
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
      method: 'POST', pattern: '/api/migrate/rollback',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const rebuildChat = async (chatKey) => {
          const ctx = skillRuntimeContext();
          const provs = skillManager.getCapabilityProviders('memory.rebuild', ctx);
          if (!provs.length || typeof provs[0].fn !== 'function') return null;
          const out = provs[0].fn({ chatKey });
          return out?.ok ? { mode: out.mode, added: out.added, chunks: out.chunks } : null;
        };
        try {
          const report = await rollbackImport(body.backupId, {
            storeInvalidate: (chatKey) => { try { store?.invalidate(chatKey); } catch { /* ignore */ } },
            memoryInvalidate: (chatKey) => { try { memory?.invalidate(chatKey); } catch { /* ignore */ } },
            rebuildChat
          });
          return json(res, report.ok ? 200 : 400, report);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/migrate/backups',
      handler: async ({ res, json }) => {
        try {
          return json(res, 200, { ok: true, backups: listBackups() });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/bundle/options',
      handler: async ({ res, json }) => {
        try { return json(res, 200, listBundleOptions()); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      method: 'POST', pattern: '/api/bundle/export',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        try {
          const r = exportBundle({
            modules: Array.isArray(body.modules) ? body.modules : [],
            data: body.data,
            note: body.note,
            appVersion: String(localVersion() || '')
          });
          return json(res, r.ok ? 200 : 400, r);
        } catch (error) {
          return json(res, 500, { ok: false, error: `打包失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 打开导出目录。固定路径、不接受任何用户参数 —— 没有路径穿越面。
      method: 'POST', pattern: '/api/bundle/reveal',
      handler: async ({ res, json }) => {
        try {
          const dir = listBundleOptions().exportsDir;
          spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
          return json(res, 200, { ok: true, dir });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 读包：{ path } 优先（存档包动辄几十 MB，本机直接读盘比 upload 实在），
      // { zipBase64 } 兜底给小包 / 拖拽。只解到临时区，不装任何东西。
      method: 'POST', pattern: '/api/bundle/inspect',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        try {
          const base64 = typeof body.zipBase64 === 'string' ? body.zipBase64 : '';
          const r = inspectBundle({
            filePath: String(body.path || ''),
            buffer: base64 ? Buffer.from(base64, 'base64') : null
          });
          return json(res, r.ok ? 200 : 400, r);
        } catch (error) {
          return json(res, 500, { ok: false, error: `读取失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 把包里的扩展送进锻造台暂存区（**不安装**，只产出草稿 + 闸门结论）
      method: 'POST', pattern: '/api/bundle/stage',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const bundleId = String(body.bundleId || '');
        const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
        if (!bundleId || !keys.length) return json(res, 400, { ok: false, error: '缺少 bundleId / keys' });

        const ctx = skillRuntimeContext();
        const imp = skillManager.getCapabilityProviders('forge.import-zip', ctx)[0];
        if (!imp) return json(res, 200, { ok: false, available: false, error: '扩展锻造台未就绪（内置模块异常）' });

        const drafts = [];
        for (const key of keys) {
          const zip = moduleZipOf(bundleId, key);
          if (!zip) { drafts.push({ key, ok: false, error: '模块缺失或为空' }); continue; }
          let out;
          try { out = imp.fn({ zipBase64: zip.toString('base64'), zipName: `${key.replace(':', '-')}.zip` }); }
          catch (error) { drafts.push({ key, ok: false, error: String(error?.message ?? error) }); continue; }
          if (!out?.ok) { drafts.push({ key, ok: false, rejected: !!out?.rejected, error: out?.error || '导入暂存区失败' }); continue; }

          try { skillManager.getCapabilityProviders('forge.snapshot', ctx)[0]?.fn({ draftId: out.draftId, label: 'pre' }); } catch { /* 快照失败不阻断 */ }
          try {
            skillManager.getCapabilityProviders('forge.save-meta', ctx)[0]?.fn({
              draftId: out.draftId,
              source: 'bundle',
              originName: String(key).split(':')[1] || '',
              requirement: `接收整包导入：${String(key)}`
            });
          } catch { /* 元数据失败只影响展示 */ }

          let gate = null;
          try { gate = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId: out.draftId }) || null; }
          catch (error) { gate = { ok: false, error: String(error?.message ?? error) }; }
          drafts.push({ key, ok: true, draftId: out.draftId, gate });
        }
        log('info', `[bundle] 解包登台：${drafts.filter((d) => d.ok).length}/${keys.length} 个扩展进入暂存区（bundle ${bundleId}）`);
        return json(res, 200, { ok: true, drafts });
      }
    },
    {
      // 一次确认，批量安装。
      // 每个草稿仍然单独签票（票据绑内容摘要、一次性、10 分钟）—— 批量省的只是"点几次"，
      // 不是"验不验"。带上 keyEndpointAllowed：只有控制台发起的请求能签票。
      method: 'POST', pattern: '/api/bundle/install',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, {
            ok: false,
            error: '确认安装只能从控制台窗口发起（当前请求没有控制台凭据）。'
              + '用外部浏览器打开控制台的话，先在设置里配置「服务 token」，再用 控制台地址?token=<你的token> 打开。'
          });
        }
        const body = await bodyOf(req);
        const items = Array.isArray(body.items) ? body.items : [];
        const enable = body.enable === true;   // 装完是否直接启用（默认不启）
        const ctx = skillRuntimeContext();
        const conf = skillManager.getCapabilityProviders('forge.confirm-ticket', ctx)[0];
        const inst = skillManager.getCapabilityProviders('forge.install', ctx)[0];
        if (!conf || !inst) {
          return json(res, 200, { ok: false, available: false, error: '扩展锻造台版本过旧（缺少「确认票据」能力）—— 请重启应用后再试' });
        }

        const results = [];
        let installed = 0;
        for (const it of items) {
          const draftId = String(it?.draftId || '');
          if (!draftId) continue;
          const ticket = conf.fn({ draftId, human: true });
          if (!ticket?.ok) { results.push({ draftId, ok: false, error: ticket?.error || '签票失败' }); continue; }
          let out;
          try {
            out = inst.fn({ draftId, confirmIssues: it?.confirmIssues === true, approvalToken: ticket.approvalToken });
          } catch (error) { out = { ok: false, error: String(error?.message ?? error) }; }
          if (out?.ok) {
            installed += 1;
            // 与 /api/forge/install 同口径：默认装成"关闭"，由用户决定何时启用。
            // 整包场景下用户已经在清单里挑过一遍，界面上给了"装完直接启用"开关。
            try { setSkillEnabled(out.id, enable === true); } catch { /* 写配置失败不算安装失败 */ }
          }
          results.push({ draftId, ok: !!out?.ok, id: out?.id, dir: out?.dir, error: out?.error });
        }
        if (installed) {
          try { await reloadSkills({ reason: 'bundle-install' }); } catch { /* 重扫失败不影响安装结果 */ }
        }
        log('info', `[bundle] 批量安装：${installed}/${results.length} 成功（${enable ? '已启用' : '装后关闭'}）`);
        return json(res, 200, { ok: installed > 0, installed, total: results.length, results });
      }
    },
    {
      // 导入包里的数据（会话存档 / 群友印象 / 统计…）。落地逻辑与 migrate.applyImport 同一套：
      // 先备份、可回滚、导入的历史消息一律置已读。
      method: 'POST', pattern: '/api/bundle/import-data',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const dir = dataDirOf(String(body.bundleId || ''));
        if (!fs.existsSync(dir)) return json(res, 400, { ok: false, error: '解包临时区已失效（可能被清理），请重新选择包' });
        const rebuildChat = async (chatKey) => {
          const ctx = skillRuntimeContext();
          const provs = skillManager.getCapabilityProviders('memory.rebuild', ctx);
          if (!provs.length || typeof provs[0].fn !== 'function') return null;
          const out = provs[0].fn({ chatKey });
          return out?.ok ? { mode: out.mode, added: out.added, chunks: out.chunks } : null;
        };
        try {
          const report = await applyImport(dir, body.selection || {}, {
            storeInvalidate: (chatKey) => { try { store?.invalidate(chatKey); } catch { /* ignore */ } },
            memoryInvalidate: (chatKey) => { try { memory?.invalidate(chatKey); } catch { /* ignore */ } },
            rebuildChat
          });
          return json(res, report.ok ? 200 : 400, report);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/bundle/discard',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        try { return json(res, 200, discardBundle(body.bundleId)); }
        catch (error) { return json(res, 500, { ok: false, error: String(error?.message ?? error) }); }
      }
    },
    {
      method: 'POST', pattern: '/api/open-data-dir',
      handler: async ({ res, json }) => {
        try {
          spawn('explorer.exe', [DATA_DIR], { detached: true, stdio: 'ignore' }).unref();
          return json(res, 200, { ok: true, dir: DATA_DIR });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 界面背景图（R40 外观个性化）。
      // 图片由 Electron 主进程经原生文件对话框选好后**复制**进 data/ui/ 下，
      // 这里只按 config.ui.bgImage 记录的文件名把它读出来 —— 不接受任何路径参数，
      // 所以不存在"传 ../../ 读任意文件"的穿越面。
      // ⚠️ 必须走同源 HTTP（img-src 'self'），file:// 图片会被 Chromium 拦下。
      // ⚠️ 路径必须带 /api/ 前缀 —— app.js 只对 /api/* 做路由表分发，
      //    其余路径一律走 ui/ 静态文件（会 404）。
      method: 'GET', pattern: '/api/ui-bg',
      handler: async ({ res }) => {
        const name = String(getConfig().ui?.bgImage || '').trim();
        const extOk = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
        const ext = path.extname(name).toLowerCase();
        if (!name || !extOk[ext] || /[/\\]/.test(name)) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('No background');
          return;
        }
        const file = path.join(DATA_DIR, 'ui', name);
        // 二次校验：解析后必须仍在 data/ui/ 内（防配置被写进奇怪的值）
        const rel = path.relative(path.join(DATA_DIR, 'ui'), file);
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }
        try {
          const data = fs.readFileSync(file);
          res.writeHead(200, { 'content-type': extOk[ext], 'cache-control': 'no-cache' });
          res.end(data);
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('No background');
        }
      }
    },
    {
      method: 'POST', pattern: '/api/reset-data',
      handler: async ({ res, json }) => {
        try {
          // 安全闸：只允许重置"看起来确实是数据目录"的路径。
          // QQ_AGENT_DATA_DIR 被误设成 C:\ 或用户目录时，无闸直接 rmSync 就是删盘。
          const resolved = path.resolve(DATA_DIR);
          const looksLikeDataDir = path.basename(resolved).toLowerCase().startsWith('data')
            || fs.existsSync(path.join(resolved, 'config.json'));
          if (!looksLikeDataDir || resolved === path.parse(resolved).root) {
            return json(res, 400, { ok: false, error: `数据目录不像 QQ Agent 数据目录，已拒绝重置：${resolved}` });
          }

          await orchestrator.abortAll();
          onebot.close();

          // 删前先备份：同级带时间戳的副本，出问题还能捞回来；备份失败则中止重置。
          let backupDir = '';
          try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            backupDir = `${resolved}.backup-${stamp}`;
            fs.cpSync(resolved, backupDir, { recursive: true, force: true });
          } catch (error) {
            return json(res, 500, { ok: false, error: `备份失败，已中止重置：${String(error?.message ?? error)}` });
          }

          // 只清内容，不删目录本身（目录可能被占用/是挂载点）；
          // 跳过 qq-agent.lock —— 那是本进程活着的凭证，删了会让第二个实例误判无锁启动。
          for (const name of fs.readdirSync(resolved)) {
            if (name === 'qq-agent.lock') continue;
            fs.rmSync(path.join(resolved, name), { recursive: true, force: true });
          }
          const { loadConfig } = await import('../config.js');
          updateConfig(loadConfig());
          return json(res, 200, { ok: true, backupDir, message: `已重置为初始形态（原数据已备份到 ${backupDir}），请重启应用` });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
  ];
}
