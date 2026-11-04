// 路由域：市场与人设：模块市场、人设市场、共享黑名单
//
// 本文件由 src/routes.js 拆分而来（2026-11-04，R164）。**handler 代码逐字节原样搬运**，
// 只换了所在文件与函数外壳 —— 拆分的目的只是把 5248 行的单一函数按域切开，
// 不改任何一条路由的行为。新增路由请按域放进对应文件，不要再往 routes.js 里堆。
import { skillRuntimeContext } from './_shared.js';
import { getConfig, updateConfig } from '../config.js';
import { logger } from '../logger.js';
import { skillManager } from '../skills/manager.js';
import { getGlobalBlocklist, updateGlobalBlocklist } from '../community.js';
import {
  listAccounts, removeAccount, loginAccount, publishModule,
  verifyInstallCodes, downloadModuleZip, listMarketItems, clearMarketListCache,
  listPersonaItems, fetchPersonaPrompt
} from '../market.js';
// 探测结果的"可对外"视图：删掉两枚令牌，只留有无标记。
// 令牌不越过 HTTP 边界的保证在这个纯函数里，路由只负责调它。

export function marketRoutes(deps, shared) {
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
      // 列表：⚠️ 刻意**不含 prompt 正文**（官网整包 3.7MB / 70 万字，
      // 一屏 123 张卡全带正文必卡）。只回元信息 + promptLength。
      method: 'GET', pattern: '/api/persona-market/list',
      handler: async ({ res, json }) => {
        try {
          const r = await listPersonaItems();
          return json(res, 200, { ok: true, categories: r.categories, items: r.items });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 单条正文：用户点开一张卡（预览 / 试用 / 应用）时才取。
      method: 'GET', pattern: /^\/api\/persona-market\/item\/([^/]+)$/,
      handler: async ({ res, json, match }) => {
        // 参数非法用 400，别用 502：502 是"上游失败"的语义，正文却写着"人设 id 非法"，
        // 前端按状态码分流时会把它当成市场不可用（体检 F4）。
        const pid = decodeURIComponent(match[1]);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(pid).trim())) {
          return json(res, 400, { ok: false, error: '人设 id 非法' });
        }
        try {
          const r = await fetchPersonaPrompt(pid);
          if (!r) return json(res, 404, { ok: false, error: '没找到这个人设' });
          return json(res, 200, { ok: true, item: r });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 应用（= 安装）：把正文落成一条自定义人设。
      // ⚠️ 幂等：同一 id 重复应用时**覆盖**同名旧条目，不追加 —— 否则用户
      //   每次点「应用」都会多一条，"这个人设"能装出五份一模一样的。
      //   落点用 customPersonas，不动 persona.roleText —— 当前生效的人设由
      //   设置页自己管，市场只负责"往库里放"，语义更干净。
      method: 'POST', pattern: '/api/persona-market/apply',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const id = String(body?.id || '').trim();
        const applyNow = body?.applyNow === true;      // true = 落库后立刻切成当前人设
        try {
          const item = await fetchPersonaPrompt(id);
          const list = Array.isArray(getConfig().customPersonas) ? [...getConfig().customPersonas] : [];
          const entry = {
            id,                                   // 记来源，市场卡片才能显示"已应用"
            name: String(body?.name || item.title || item.id).trim().slice(0, 50),
            text: item.prompt,
            source: 'market',
            sourceId: id,
            appliedAt: new Date().toISOString()
          };
          const at = list.findIndex((p) => p && (p.sourceId === id || p.marketId === id));
          if (at >= 0) list[at] = { ...list[at], ...entry };
          else list.push(entry);
          const patch = { customPersonas: list };
          // 立即生效：只改 roleText / customRules，不动 botName ——
          //   名字是账号身份，@ 判定与存档称呼都依赖它，换名会串。
          if (applyNow) {
            patch.persona = { ...(getConfig().persona || {}), roleText: item.prompt };
          }
          updateConfig(patch);
          return json(res, 200, {
            ok: true,
            id,
            index: at >= 0 ? at : list.length - 1,
            appliedNow: !!applyNow,
            promptLength: item.prompt.length
          });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/persona-templates',
      handler: async ({ res, json }) => {
        const { PERSONAS } = await import('../personas.js');
        const builtins = Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, text: p.text, builtin: true }));
        const customs = (getConfig().customPersonas || []).map((p, i) => ({
          id: `custom_${i}`, name: p.name, text: p.text, customRules: p.customRules || '', builtin: false
        }));
        return json(res, 200, { templates: [...builtins, ...customs] });
      }
    },
    {
      method: 'POST', pattern: '/api/persona-templates',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const name = String(body.name ?? '').trim().slice(0, 50);
        const text = String(body.text ?? '').trim();
        if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
        const customRules = String(body.customRules ?? '').trim();

        // ── 带 id = 修改已有的自定义人设（2026-10-22 新增，供人设卡上的「编辑」用）──
        // 只认 custom_N：内置人设的正文写死在 src/personas.js 里，改不了。
        const editId = String(body.id ?? '').trim();
        if (editId) {
          const m = /^custom_(\d+)$/.exec(editId);
          if (!m) return json(res, 400, { ok: false, error: '内置人设不能修改（可以另存为自定义人设）' });
          const idx = Number(m[1]);
          const list = [...(getConfig().customPersonas || [])];
          const old = list[idx];
          if (!old) return json(res, 404, { ok: false, error: '这个人设已经不存在了，请刷新列表' });
          const entry = { ...old, name, text };
          if (customRules) entry.customRules = customRules;
          else delete entry.customRules;
          list[idx] = entry;

          const patch = { customPersonas: list };
          // ⚠️ 改的正是**当前生效**的那套 → 必须同步 persona.roleText / customRules。
          // 否则界面上显示的是新人设，机器人却还拿着旧正文说话（与删除接口
          // 2026-10-16 修的是同一类问题：语义放服务端，随同一次 updateConfig 落盘）。
          if (String(old.text ?? '') && String(old.text) === String(getConfig().persona?.roleText ?? '')) {
            patch.persona = { ...(getConfig().persona || {}), roleText: text };
            // 2026-10-23 修复：清空「额外规矩」时也要把当前生效人设上的旧规则一起清掉。
            //   旧写法是 `if (customRules) patch.persona.customRules = customRules;`，
            //   清空那次不进这个分支，而 patch.persona 是从旧对象展开的 —— 旧规则原样留下。
            //   症状：模板里已经删掉的规矩，仍在每轮注入提示词（界面显示已清空，行为没变）。
            //   显式写空串而不是 delete：updateConfig 是深合并，delete 删不掉已存在的键。
            patch.persona.customRules = customRules || '';
          }
          updateConfig(patch);
          return json(res, 200, { ok: true, id: editId, appliedNow: !!patch.persona });
        }

        const entry = { name, text };
        if (customRules) entry.customRules = customRules;
        const next = [...(getConfig().customPersonas || []), entry];
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true, templates: next });
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/persona-templates\/(custom_\d+)$/,
      handler: async ({ res, json, match }) => {
        const idx = Number(match[1].replace('custom_', ''));
        const list = getConfig().customPersonas || [];
        const removed = list[idx];
        const next = list.filter((_, i) => i !== idx);
        const patch = { customPersonas: next };
        // ⚠️（2026-10-16 外部审查 #5）被删的正是**当前生效**的那套时，原实现只过滤
        //    customPersonas，不动 config.persona.roleText —— 于是界面显示"未选人设"，
        //    机器人却继续拿被删掉的角色卡说话，前后不一致且极难排查。
        //    UI 侧本来也想复位（07-settings-events.js 的删除处理器），但它操作的
        //    #cfg-roletext / #cfg-customrules 早已随人设编辑器搬进弹窗、不在 DOM 里，
        //    存在性守卫把那段变成了空操作 —— 所以语义放服务端，随同一次 updateConfig 落盘。
        if (removed && String(removed.text ?? '')
          && String(removed.text) === String(getConfig().persona?.roleText ?? '')) {
          const { PERSONAS } = await import('../personas.js');
          patch.persona = { ...(getConfig().persona || {}), roleText: PERSONAS.xiaojingyu?.text || '' };
        }
        updateConfig(patch);
        return json(res, 200, { ok: true, resetPersona: !!patch.persona });
      }
    },
    {
      method: 'GET', pattern: '/api/community/blocklist',
      handler: async ({ res, json }) => json(res, 200, { ok: true, ids: getGlobalBlocklist() })
    },
    {
      method: 'POST', pattern: '/api/community/blocklist',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids : [];
        try {
          const { ids: actual, warning } = await updateGlobalBlocklist(ids, { mode: String(body?.mode || 'replace') });
          emit('status', { communityBlocklistUpdated: true });
          return json(res, 200, { ok: true, ids: actual, warning: warning || '' });
        } catch (error) {
          return json(res, 502, { ok: false, error: `云端屏蔽名单更新失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/market/accounts',
      handler: async ({ res, json }) => {
        const accounts = listAccounts().map((a) => ({ username: a.username, savedAt: a.savedAt }));
        return json(res, 200, { ok: true, accounts });
      }
    },
    {
      // r105 搬运（自 v0.4.5）：市场列表（应用内「市场」页）：代理官网 GET /skills | /plugins。
      // 为什么要代理：浏览器直连会被 CORS 拦，与其它市场端点走同一条 marketFetch 通道。
      // 返回 { ok, categories, items }；items 已在 market.js 做过字段白名单裁剪。
      method: 'GET', pattern: '/api/market/list',
      handler: async ({ req, res, json, url }) => {
        const kind = url?.searchParams?.get('kind') === 'plugin' ? 'plugin' : 'skill';
        // force=1 = 跳过内存与磁盘列表缓存（装完/删完点「刷新」时前端会带上）
        const force = url?.searchParams?.get('force') === '1';
        if (force) clearMarketListCache(kind);
        try {
          const r = await listMarketItems(kind, { force });
          return json(res, 200, { ok: true, kind, categories: r.categories, items: r.items });
        } catch (error) {
          // 2026-10-20：原来这里只回 502、**一个字都不落日志** —— 用户报"市场加载不出来"
          // 时后台干干净净，事后完全无法复盘（是 DNS / WAF 挡了 / 上游 5xx / 超时？）。
          // 现在把原因写进应用日志（「工具 → 连接 → 应用日志」能看到）。
          logger.warn('market', `市场列表拉取失败：${kind} · ${String(error?.message ?? error)}`);
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 登录 / 注册。mode: login | register。注册三要素：登录 ID + 展示用户名 + 密码。
      // 成功后凭据自动落盘。
      method: 'POST', pattern: '/api/market/login',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        try {
          const r = await loginAccount({
            loginId: String(body?.loginId || ''),
            displayName: String(body?.displayName || ''),
            password: String(body?.password || ''),
            mode: body?.mode === 'register' ? 'register' : 'login'
          });
          return json(res, 200, { ok: true, account: r.account, accounts: r.accounts.map((a) => ({ username: a.username, savedAt: a.savedAt })) });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 登出（删本地凭据 + 吊销远端 token）
      method: 'POST', pattern: '/api/market/logout',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const username = String(body?.username || '');
        if (!username) return json(res, 400, { ok: false, error: '缺少 username' });
        const accounts = await removeAccount(username);
        return json(res, 200, { ok: true, accounts: accounts.map((a) => ({ username: a.username, savedAt: a.savedAt })) });
      }
    },
    {
      // 发布一个已安装的 skill/plugin 到市场（待审核）。
      // body: { kind: 'skill'|'plugin', id, displayName, description, accountUsername }
      method: 'POST', pattern: '/api/market/publish',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const kind = body?.kind === 'plugin' ? 'plugin' : 'skill';
        const id = String(body?.id || '');
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
          return json(res, 400, { ok: false, error: `无效的 ${kind} id：${id}` });
        }
        const acc = listAccounts().find((a) => a.username === String(body?.accountUsername || ''));
        if (!acc) return json(res, 401, { ok: false, error: '请先选择一个已登录的账号' });
        try {
          const r = await publishModule({
            kind, id,
            displayName: String(body?.displayName || ''),
            description: String(body?.description || ''),
            token: acc.token,
            // 2026-10-17：kondius.cn 发布端点加人机验证，前端弹完滑块把 param 透传
            captchaVerifyParam: String(body?.captchaVerifyParam || '')
          });
          return json(res, 200, {
            ok: true, item: r.item || null,
            renamedTo: r.renamedTo || null,
            note: r.note || ''
          });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 口令批量校验：body { codes: [...] } → 每个口令的条目摘要
      method: 'POST', pattern: '/api/market/verify',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const codes = (Array.isArray(body?.codes) ? body.codes : [body?.code])
          .map((c) => String(c ?? '').trim().toUpperCase())
          .filter((c) => /^[A-Z0-9]{1,32}$/.test(c))
          .slice(0, 30);
        if (!codes.length) return json(res, 400, { ok: false, error: '没有有效的口令' });
        try {
          const results = await verifyInstallCodes(codes);
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 口令安装：body { code, entry }（entry = verify 阶段拿到的条目，含服务器判定的 type）。
      // 类型路由由服务器 entry.type 决定：技能页输插件口令也会归到插件。
      //
      // ⚠️ 2026-10-22 语义变更：**这条路由不再落盘**。
      //    流程改为：下载 → 导入扩展锻造台暂存区 → 拍快照 → 过五道闸门 → 返回"待确认"。
      //    真正写 skills/ / plugins/ 的是 /api/forge/install，且必须带人工确认票据。
      //
      //    为什么必须改：旧实现只做结构与清单预检就直落模块目录，五道闸门一道没跑、
      //    人工确认一步没有 —— 用户点一下"安装"等于把整台机器交给一份没人看过的代码。
      //    而闸门结论本身也不该自动换出安装许可（静态扫描是启发式的，见 gate.js 头注释）。
      //    现在"安装"这个词只保留给「人确认过的那一次落盘」。
      method: 'POST', pattern: '/api/market/install',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const code = String(body?.code || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4,12}$/.test(code)) return json(res, 400, { ok: false, error: '口令格式无效' });

        const ctx = skillRuntimeContext();
        const impProv = skillManager.getCapabilityProviders('forge.import-zip', ctx)[0];
        const canConfirm = skillManager.getCapabilityProviders('forge.confirm-ticket', ctx).length > 0;
        if (!impProv || !canConfirm) {
          // 锻造台是内置模块（kind='core'），正常不会缺席；缺席或版本过旧时宁可整单取消，
          // 也不退回"直装" —— 那正好是最该被删掉的那条旁路。
          return json(res, 503, {
            ok: false, available: false,
            error: impProv
              ? '扩展锻造台版本过旧（缺少「确认票据」能力，需重启应用）—— 安装已取消，没有任何文件落盘。'
              : '扩展锻造台未就绪（内置模块异常）—— 安装已取消，没有任何文件落盘。'
          });
        }

        let dl;
        try {
          dl = await downloadModuleZip({ code, verified: body?.entry || null });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }

        const name = String(dl.entry?.name || dl.ident || code);
        let out;
        try {
          out = impProv.fn({ zipBase64: dl.buffer.toString('base64'), zipName: `${dl.ident || code}.zip` });
        } catch (error) {
          return json(res, 500, { ok: false, error: `导入暂存区失败：${String(error?.message ?? error)}` });
        }
        if (!out?.ok) {
          return json(res, 200, { ok: false, rejected: !!out?.rejected, error: out?.error || '导入暂存区失败' });
        }

        // 适配前快照：之后模型改了什么、你确认的是哪一版，都靠它对比（失败不阻断）
        try {
          skillManager.getCapabilityProviders('forge.snapshot', ctx)[0]?.fn({ draftId: out.draftId, label: 'pre' });
        } catch { /* ignore */ }

        // 来源留痕：草稿列表里要能认出"这是市场口令 X 下载的"
        try {
          skillManager.getCapabilityProviders('forge.save-meta', ctx)[0]?.fn({
            draftId: out.draftId,
            source: 'market',
            originName: name,
            originCode: code,
            requirement: `市场口令 ${code} 下载：${name}（${dl.type === 'plugin' ? '插件' : '技能'}）`
          });
        } catch { /* 元数据写失败只影响展示，不阻断 */ }

        let gate = null;
        try { gate = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId: out.draftId }) || null; }
        catch (error) { gate = { ok: false, error: String(error?.message ?? error) }; }

        log('info', `[market] 口令 ${code} 已导入锻造台暂存区（草稿 ${out.draftId}，`
          + `${gate?.ok ? '闸门通过' : `闸门阻断 ${gate?.blocking ?? '?'} 项`}），等待人工确认`);

        return json(res, 200, {
          ok: true,
          pending: true,                    // ← 前端据此区分"已安装"与"待确认"
          draftId: out.draftId,
          kind: out.kind || dl.type,
          id: dl.ident || out.draftId,
          name,
          files: out.files,
          skipped: out.skipped,
          gate,
          message: '已下载到「扩展锻造台」暂存区，还没写进 skills/ plugins —— '
            + '去 harness → 扩展锻造台 核对闸门结论、确认安装。'
        });
      }
    },
  ];
}
