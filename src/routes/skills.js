// 路由域：插件与工具：加载 / 信任 / 导入 / 配置 / 工具面板
//
// 本文件由 src/routes.js 拆分而来（2026-11-04，R164）。**handler 代码逐字节原样搬运**，
// 只换了所在文件与函数外壳 —— 拆分的目的只是把 5248 行的单一函数按域切开，
// 不改任何一条路由的行为。新增路由请按域放进对应文件，不要再往 routes.js 里堆。
import { skillRuntimeContext } from './_shared.js';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, updateConfig, getConfigWriteBlock, deepMerge as deepMergeConfig } from '../config.js';
import { initPriceFeed } from '../price-feed.js';
import { effectiveVisionEnabled } from '../vision-scan.js';
import { logger } from '../logger.js';
import { skillManager } from '../skills/manager.js';
import { getSkillConfig, setSkillConfig, setSkillEnabled, listConfiguredSkillIds } from '../skills/config.js';
import { availabilityOf, listTools, CATEGORY_META } from '../tool-registry.js';
import { FIXED_PRICE_FEED_URL } from '../community.js';
import { importModules } from '../module-import.js';
import { SKILLS_DIR, PLUGINS_DIR, isBuiltinModuleDir } from '../plugin-loader.js';
// 探测结果的"可对外"视图：删掉两枚令牌，只留有无标记。
// 令牌不越过 HTTP 边界的保证在这个纯函数里，路由只负责调它。

export function skillsRoutes(deps, shared) {
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
      method: 'GET', pattern: '/api/config',
      handler: async ({ res, json }) => json(res, 200, sanitizeConfig(getConfig()))
    },
    {
      // 完整系统提示词预览：按**当前**插件/技能/工具启用状态组装（没开的不出现），
      // 供设置-工具与技能页和技能页右侧预览共用。走后端而不是前端拼：组装逻辑
      // 就是运行时的 buildSystemPrompt + getToolAvailability，前端另写一份迟早漂移。
      // 注意 skillContext 与 orchestrator 同构（visionEnabled/searchEnabled/toolsCfg），
      // 否则预览和实际运行的口径会分裂。
      //
      // POST + 可选 overrides：前端自动保存有 600ms 防抖，用户刚点的开关还没落盘；
      // 调用方把"当前工具面板状态"随请求发来，这里先 deepMerge 到临时副本上组装
      // （绝不写回 currentConfig），预览就能立即反映未保存的开关。
      method: '*', pattern: '/api/prompt-preview',
      handler: async ({ req, res, json }) => {
        const cfg = getConfig();
        let overrides = {};
        try {
          if (req.method === 'POST') overrides = (await bodyOf(req)) || {};
        } catch { overrides = {}; }
        const effective = Object.keys(overrides).length
          ? deepMergeConfig(structuredClone(cfg), structuredClone(overrides))
          : cfg;
        const skillContext = {
          skills: skillManager,
          toolsCfg: effective.tools || {},
          visionEnabled: effectiveVisionEnabled(effective),
          searchEnabled: effective.webSearch?.enabled !== false,
          runtimeContext: { model: effective.api?.model || '', provider: effective.api?.provider || '', source: 'api' },
          // ⚠️ 必须与 orchestrator 的 skillContext **同口径**（2026-10-16 修）：
          //    thinking-adapters 的 promptSections(context) 要从这里取 model/baseUrl/
          //    thinking* 才能写出与真实请求一致的"当前思考模式/方言"。原先这里只给了
          //    runtimeContext.model，插件读不到 → 预览里恒显示"通用（不发送思考参数）"，
          //    而真实运行用的是 DeepSeek/通义等 —— 正是本路由注释要消灭的
          //    "预览与实际发给模型的不符"。
          model: effective.api?.model || '',
          provider: effective.api?.provider || '',
          baseUrl: effective.api?.baseUrl || '',
          thinkingMode: effective.api?.thinkingMode,
          thinkingEffort: effective.api?.thinkingEffort,
          thinkingBudget: effective.api?.thinkingBudget
        };
        const { buildSystemPrompt, renderVolatileSections } = await import('../prompt.js');
        const { buildToolDefs } = await import('../tools.js');
        const { getToolAvailability } = await import('../tool-registry.js');
        // 可用工具清单与 orchestrator 同一口径（tools.js 的 def → OpenAI 函数名）
        const tools = buildToolDefs()
          .filter((d) => getToolAvailability(d.id, skillContext).enabled)
          .map((d) => ({ id: d.id, name: d.name, description: d.description, category: d.category }));
        // ⚠️ 必须与 orchestrator 的**真实组装口径**一致（方案 A，2026-10-11）：
        //    易变片段已从系统提示拆出、改注入用户提示词末尾。预览若仍把易变片段
        //    混在 systemPrompt 里，用户看到的就与实际发给模型的不符。
        //    这里把两部分**分别**给出：systemPrompt（实际系统提示）+ 尾注说明。
        const volatileOut = { sections: [] };
        const systemPrompt = buildSystemPrompt({ skillContext, deferVolatile: true, volatileOut });
        const volatileNote = renderVolatileSections(volatileOut.sections);
        return json(res, 200, {
          systemPrompt,
          // 易变片段（思考模式/系统自检/开发模式）实际拼在用户提示词末尾，单独返回供预览
          volatileNote,
          tools
        });
      }
    },
    {
      method: 'GET', pattern: '/api/skills',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const baseList = skillManager.list(context);
        // 2026-10-22：给每条补「是不是随应用分发的内置模块」，前端「下载 → 技能 / 插件」
        // 据此做"来源"筛选（内置 / 第三方分开，方便管理自己后来装的那些）。
        // ⚠️ 刻意算在这里、而不是 manager.status 里：plugin-loader 已经 import 了
        //   skills/manager（加载模块要用），manager 再反向 import plugin-loader 就成了
        //   循环依赖；routes 本来两边都引，是安全的落点。
        // dir 形如 `skills/calculator` / `plugins/ban-state`，取最后一段即目录名。
        for (const it of baseList) {
          it.builtin = isBuiltinModuleDir(String(it.dir || '').split('/').pop());
        }
        // uninstalled：配置里还有 skills.<id> 段、但磁盘上已经没有这个条目
        // （删目录后的配置残留）。UI 显示成"已配置但未安装"，并提供一键清理。
        const installedIds = new Set(baseList.map((s) => s.id));
        const uninstalled = listConfiguredSkillIds()
          .filter((id) => !installedIds.has(id))
          .map((id) => {
            const c = getConfig()?.skills?.[id] || {};
            return {
              id,
              enabled: c.enabled !== false,
              hasSettings: Object.keys(c).some((k) => k !== 'enabled')
            };
          });
        // ── 工具调用性合并（2026-10-19）────────────────────────────────
        // "加载成功 + 开关打开 + 生效中" ≠ "模型调得到它的工具"：单工具开关、
        // 分类开关、requiresVision、send_to 独立开关……任何一档都能把工具
        // 静默拦在模型列表外。此前只有 /api/tools/availability 一页能看到，
        // 模块页的卡片毫不知情 —— 用户看到"生效中"，实际一个工具都调不到。
        // 这里按 skillId 聚合可用性，给每个有工具的模块挂上 callability。
        let bySkill = null;
        try {
          bySkill = new Map();
          for (const a of availabilityOf(context)) {
            if (!a.skillId) continue;
            const agg = bySkill.get(a.skillId) || { callables: 0, blocked: [] };
            if (a.enabled) agg.callables += 1;
            else agg.blocked.push({ id: a.id, code: a.code, reason: a.reason });
            bySkill.set(a.skillId, agg);
          }
        } catch { bySkill = null; }   // 诊断失败不影响主列表
        const skills = baseList.map((s) => {
          if (!bySkill || !Array.isArray(s.toolIds) || !s.toolIds.length) return s;
          const agg = bySkill.get(s.id) || { callables: 0, blocked: [] };
          return {
            ...s,
            callability: {
              total: s.toolIds.length,
              callables: agg.callables,
              blocked: agg.blocked
            }
          };
        });
        return json(res, 200, {
          skills,
          summary: skillManager.summary(context),
          capabilities: skillManager.capabilities.list().sort(),
          uninstalled
        });
      }
    },
    {
      // 手动重扫磁盘：UI「刷新」按钮的后端动作。
      // 之前刷新只读内存注册表，watcher 丢事件（目录删除重建 / 网络盘 / 杀软）
      // 时新插件永远进不来。这里走 app.reloadSkills()：重扫 + 激活 + 刷工具 + 重建 watcher。
      method: 'POST', pattern: '/api/skills/reload',
      handler: async ({ res, json }) => {
        if (typeof reloadSkills !== 'function') {
          return json(res, 500, { ok: false, error: '核心未提供 reloadSkills（请升级或检查启动方式）' });
        }
        try {
          const result = await reloadSkills({ reason: 'manual' });
          const context = skillRuntimeContext();
          return json(res, 200, {
            ok: true,
            loaded: result.loaded.map((r) => r.id),
            failed: result.failed.map((r) => ({ id: r.id, error: r.error })),
            pruned: result.pruned,
            skills: skillManager.list(context),
            summary: skillManager.summary(context),
            capabilities: skillManager.capabilities.list().sort()
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: `重扫失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 信任一个模块并立即重试加载（2026-10-07 新增）。
      //
      // 为什么需要它：准入闸拦下第三方模块后，用户若只能自己去改 data/config.json 的
      // trustedPlugins 数组，那体验等于"根本用不了自己写的插件"—— 于是闸门会被
      // 绕过或被整体关掉。这里给一次点击的入口。
      //
      // ⚠️ 严格限定「只能信任当前**确实因高危能力被拒**的模块」：
      //   否则这个接口就退化成一个万能放行口（配合任意 id 猜测，
      //   可以把某个第三方模块悄悄标成可信，而界面上看不出差别）。
      //   判据：它必须已注册在 skillManager.errors 里，且错误文本带本次闸门的标记。
      // 登记后立刻 reloadSkills()，用户点完就能看到结果，不用手动点刷新。
      method: 'POST', pattern: '/api/skills/trust',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req).catch(() => ({}));
        // ⚠️ 宽容取 id：这个接口的调用方有三类 —— UI 按钮（id=<目录名>）、
        //   用户脚本、以及**模型直接构造的请求**（收包人场景：缺陷报告由 AI
        //   代测提交，模型猜字段名 skillId/dir/dirName 或干脆不带 body）。
        //   旧版对后两类只回「缺少 id」—— 不教正确写法，调用方反复换字段重试，
        //   体感就是"信任要 id、id 要信任"的死循环（2026-10-10 用户二次确认）。
        //   宽容别名不影响安全性：下面仍有三路 find、"触碰了高危能力"前置校验、
        //   只登记目录名三道闸守着。
        const raw = String(body?.id ?? body?.skillId ?? body?.dir ?? body?.dirName ?? body?.moduleName ?? '').trim();
        if (!raw) {
          return json(res, 400, {
            ok: false,
            error: '缺少 id —— POST body 应为 JSON：{"id": "<扩展目录名>"}'
              + '（目录名取 GET /api/skills 对应条目 dir 字段的最后一段，如 "comfyui-image"）。'
          });
        }
        const norm = raw.replace(/\\/g, '/');
        const base = path.basename(norm);

        // ⚠️ 判据**不能靠猜 `skillManager.errors` 的键**（2026-10-08 修，用户报障）。
        //   历史：2026-10-07 这里从 `s.dir`（`plugins/xxx`）改成 basename，以为就对了 ——
        //   但那个假设是错的：`errors` 的键是 **manifest.id**（清单里自己声明的 id），
        //   而界面传来的是**目录名**。二者平时相等，可一旦安装时目录名冲突，安装器会给
        //   目录递增后缀（`meme-tracker` → `meme-tracker_1`，见"永不覆盖"策略），
        //   而清单里的 id 不变 → 两者分叉：`errors['meme-tracker']` 明明在，
        //   按目录名查 `meme-tracker_1` 却永远查不到 → 永远回
        //   "当前不是因高危能力被拦截"，用户怎么点都信任不了。
        //   现在改成回**注册表**找这张卡片自己那一条（界面就是用它渲染的，`dir` 一定对得上），
        //   读它的 `loadError` —— 与界面决定"要不要显示信任按钮"用的是**同一个字段**。
        let row = null;
        try {
          const rows = skillManager.list(skillRuntimeContext()) || [];
          row = rows.find((r) => String(r.dir || '').replace(/\\/g, '/') === norm)
            || rows.find((r) => path.basename(String(r.dir || '').replace(/\\/g, '/')) === base)
            || rows.find((r) => String(r.id || '') === base)
            || null;
        } catch { row = null; }
        if (!row) {
          return json(res, 400, { ok: false, error: `找不到模块「${raw}」（可能已被移除，刷新列表后再试）。` });
        }

        // 前置校验：它此刻必须正处于「因高危能力被拦」的状态
        const errText = String(row.loadError || '')
          || String(skillManager.errors?.get?.(String(row.id || '')) ?? '')
          || String(skillManager.errors?.get?.(base) ?? '');
        const TRUST_MARK = '触碰了高危能力';
        if (!errText.includes(TRUST_MARK)) {
          return json(res, 400, {
            ok: false,
            error: `模块「${row.name || row.id}」当前不是因高危能力被拦截（无法作为信任对象）。`
              + '若它因其它原因加载失败，请先解决那个原因。'
          });
        }
        // 只登记**目录名**：id 写在第三方可编辑的清单文件里，当作信任判据的话，
        // 攻击者把清单 id 改成别人已信任的名字即可免检（实测确实能过）。
        // 目录名是磁盘上的一级目录名，第三方装进来时无法自选（冲突会递增后缀）。
        // ⚠️ `checkPluginTrust` 也按这个目录名匹配（plugin-loader 的 dirName），
        //   所以这里必须是**目录名**，不能是 row.id。
        const id = path.basename(String(row.dir || base).replace(/\\/g, '/')) || base;
        const ids = Array.isArray(getConfig().trustedPlugins) ? getConfig().trustedPlugins.map(String) : [];
        if (!ids.includes(id)) {
          updateConfig({ trustedPlugins: [...ids, id] });
          logger.info('routes', `用户主动信任模块：${id}（准入闸要求显式确认；清单 id=${row.id}）`);
        }

        // 立刻重试，让结果当场可见
        let result = null;
        if (typeof reloadSkills === 'function') {
          try { result = await reloadSkills({ reason: 'trust' }); } catch (error) {
            return json(res, 500, { ok: false, error: `已登记信任，但重载失败：${String(error?.message ?? error)}` });
          }
        }
        // 失败清单里的 id 是 **manifest.id**，可能不等于目录名 —— 两种都比一次。
        const failRow = (result?.failed || [])
          .find((f) => String(f.id) === id || String(f.id) === String(row.id || ''));
        const context = skillRuntimeContext();
        return json(res, 200, {
          ok: true,
          trusted: id,
          stillFailing: failRow ? (failRow.error || '仍然失败') : null,
          skills: skillManager.list(context),
          summary: skillManager.summary(context)
        });
      }
    },
    {
      // 本地导入：用户把 zip 包 / 整个文件夹拖进技能页或插件页（或走「导入本地文件」按钮）。
      // body: { kind: 'skill'|'plugin', paths?: [本机绝对路径], zipBase64?: string, zipName?: string }
      //   · paths     —— Electron 里直接从拖放的 File 反查出来的真实路径（前端不过手文件内容）
      //   · zipBase64 —— 浏览器/远程打开时的退路（没有本机路径可用，只能传字节）
      // 装完立刻 reloadSkills()，让新条目当场出现在页面上（不用再手动点刷新）。
      method: 'POST', pattern: '/api/skills/import',
      handler: async ({ req, res, json }) => {
        // zip 的 base64 比原文件大约 1/3，给到 12MB（硬上限 16MB 见 app.js）
        const raw = await readBody(req, { maxBytes: 12 * 1024 * 1024 }).catch((e) => {
          if (e?.expose) throw e;
          return {};
        });
        const body = raw && typeof raw === 'object' ? raw : {};
        const kind = body?.kind === 'plugin' ? 'plugin' : 'skill';
        const paths = Array.isArray(body?.paths) ? body.paths.map(String).filter(Boolean) : [];
        const zipBase64 = typeof body?.zipBase64 === 'string' ? body.zipBase64 : '';
        if (!paths.length && !zipBase64) {
          return json(res, 400, { ok: false, error: '没有可导入的内容' });
        }
        let result;
        try {
          result = await importModules({ paths, zipBase64, zipName: String(body?.zipName || ''), kind });
        } catch (e) {
          return json(res, 400, { ok: false, error: String(e?.message ?? e) });
        }
        if (!result.installed.length) {
          return json(res, 400, { ok: false, error: result.errors[0]?.error || '导入失败', errors: result.errors });
        }
        log('info', `[skill] 本地导入：${result.installed.map((r) => `${r.kind}s/${r.id}`).join('、')}`);
        // 重扫 + 激活 + 刷工具，并重建目录监听（新目录必须重新 watch 才能热重载）
        let reload = null;
        try {
          if (typeof reloadSkills === 'function') reload = await reloadSkills({ reason: 'import' });
        } catch (e) {
          log('warn', `[skill] 导入后重扫失败：${String(e?.message ?? e)}`);
        }
        const context = skillRuntimeContext();
        return json(res, 200, {
          ok: true,
          installed: result.installed.map((r) => ({ kind: r.kind, id: r.id, dir: r.dir, files: r.files })),
          errors: result.errors,
          skills: skillManager.list(context),
          summary: skillManager.summary(context),
          reloaded: Boolean(reload)
        });
      }
    },
    {
      // 清理"已配置但未安装"的残留配置段：删掉 config.skills.<id>。
      // body: { ids: [id...] }，只删传入的 id，且要求该 id 当前确实不在注册表里
      //（防止把正在运行的 Skill 配置误删）。
      method: 'POST', pattern: '/api/skills/cleanup',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
        if (!ids.length) return json(res, 400, { ok: false, error: '缺少 ids' });
        const installed = new Set(skillManager.list().map((s) => s.id));
        const removable = ids.filter((id) => !installed.has(id));
        if (!removable.length) {
          return json(res, 400, { ok: false, error: '没有可清理的条目（都处于已安装状态）' });
        }
        const skillsCfg = getConfig()?.skills || {};
        const next = { ...skillsCfg };
        for (const id of removable) delete next[id];
        // deepMerge 传 {} 删不掉已有键，必须用 __replace__ 整体替换
        updateConfig({ skills: { __replace__: next } });
        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          removed: removable,
          skipped: ids.filter((id) => installed.has(id)),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 删除一个 Skill / 插件：把它的整个目录从磁盘移除，然后热重扫。
      // 不可逆操作（前端有二次确认），后端仍做**路径安全校验**：
      //   ① 目标目录必须位于 skills/ 或 plugins/ 根目录**之内**（防路径穿越 / 误删项目其它文件）；
      //   ② 目标必须是真实存在的目录。
      // 顺序刻意是"先删目录 → 再注销 → 清配置残留 → 重扫"：
      // 即使后面某步失败，磁盘上也不会残留一个"半死"模块。
      method: 'DELETE', pattern: /^\/api\/skills\/([^/]+)$/,
      handler: async ({ res, json, match }) => {
        const id = decodeURIComponent(match[1]);
        const skill = skillManager.registry.get(id);
        if (!skill) return json(res, 404, { ok: false, error: `模块不存在：${id}` });

        // 用加载器记录的绝对目录（skill.dir）判定归属，不信任前端传来的任何路径。
        const absDir = path.resolve(String(skill.dir || ''));
        const isInside = (root) => {
          const rel = path.relative(root, absDir);
          return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
        };
        if (![SKILLS_DIR, PLUGINS_DIR].some(isInside)) {
          return json(res, 400, {
            ok: false,
            error: `拒绝删除：目标不在 skills/ 或 plugins/ 目录内（${skill.relDir || absDir}）`
          });
        }
        if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
          return json(res, 404, { ok: false, error: `目录不存在：${skill.relDir || absDir}` });
        }

        try {
          fs.rmSync(absDir, { recursive: true, force: true });
        } catch (error) {
          // 目录被占用（插件起了子进程 / 原生模块句柄未释放）时最常见，如实回报
          return json(res, 500, { ok: false, error: `删除目录失败：${String(error?.message ?? error)}` });
        }

        // 注销：deactivate + dispose + 回收该模块注册的工具与能力
        skillManager.unregister(id, { reason: 'deleted' });

        // 顺带清掉 config.skills.<id> 残留段（否则它会变成"已配置但未安装"的幽灵条目）
        try {
          const skillsCfg = getConfig()?.skills || {};
          if (Object.prototype.hasOwnProperty.call(skillsCfg, id)) {
            const next = { ...skillsCfg };
            delete next[id];
            // deepMerge 传对象删不掉已有键，必须用 __replace__ 整体替换（同 cleanup 路由）
            updateConfig({ skills: { __replace__: next } });
          }
        } catch { /* 配置清理失败不影响"目录已删除"这一事实 */ }

        // 热重扫：重建 watcher，并让列表立刻反映删除（目录净减时 watcher 会丢事件）
        try {
          if (typeof reloadSkills === 'function') await reloadSkills({ reason: 'delete' });
        } catch { /* 忽略：注册表上面已手动注销 */ }

        emit('status', { configUpdated: true });
        const context = skillRuntimeContext();
        return json(res, 200, {
          ok: true,
          id,
          dir: skill.relDir || '',
          skills: skillManager.list(context),
          summary: skillManager.summary(context),
          capabilities: skillManager.capabilities.list().sort(),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 单个 Skill：切开关 / 改设置。两个动作分开处理，避免"改了设置顺手把我开着的关了"。
      method: 'POST', pattern: /^\/api\/skills\/([^/]+)$/,
      handler: async ({ req, res, json, match }) => {
        const id = decodeURIComponent(match[1]);
        const body = await bodyOf(req);
        const context = skillRuntimeContext();
        const skill = skillManager.registry.get(id);
        if (!skill) return json(res, 404, { ok: false, error: `Skill 不存在：${id}` });

        // 1) 开关（先写配置，再跑生命周期；顺序不能反 ——
        //    activate 里读配置必须已经生效，否则 Skill 会以为自己是关闭的）
        if (body.enabled !== undefined) {
          setSkillEnabled(id, !!body.enabled);
          if (body.enabled) skillManager.activate(id, context);
          else skillManager.deactivate(id, context);
        }

        // 2) 设置（只允许改 manifest 声明过的键，防止前端塞垃圾字段进配置）
        if (body.settings && typeof body.settings === 'object') {
          const allowed = new Set([
            ...Object.keys(skill.manifest.settings || {}),
            ...Object.keys(skill.manifest.configSchema || {})
          ]);
          const schema = skill.manifest.configSchema || {};
          const current = getSkillConfig(id, skill.manifest.settings || {});
          const patch = {};
          for (const [k, v] of Object.entries(body.settings)) {
            if (!allowed.has(k)) continue;
            // 密文字段：收到脱敏占位符或空串 = "不修改"。
            // 不这么做的话，用户只是打开表单点了保存，Cookie/Key 就被覆盖成 '******'。
            if (schema[k]?.secret && (v === '******' || String(v ?? '').trim() === '')) continue;
            patch[k] = v;
          }
          if (Object.keys(patch).length) setSkillConfig(id, patch);
        }

        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          skill: skillManager.status(id, context),
          // ⚠️ 响应里的 settings 必须用脱敏视图（settingsView）：
          //    曾经直接回 getSkillConfig（明文），保存一次设置就把
          //    apiKey / Cookie 原文发回浏览器，与 GET 列表的脱敏口径相反。
          settings: skillManager.settingsView(id),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 开关配置总览：给设置页渲染"技能"区块
      method: 'GET', pattern: '/api/skills/capabilities',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const caps = skillManager.capabilities.list().sort();
        return json(res, 200, {
          capabilities: caps.map((c) => ({
            name: c,
            ...skillManager.explainCapability(c, context)
          }))
        });
      }
    },
    {
      // 工具可用性总览：明确告诉 UI "这个工具为什么没生效"
      method: 'GET', pattern: '/api/tools/availability',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const availability = availabilityOf(context);
        const defs = new Map(listTools().map((t) => [t.id, t]));
        return json(res, 200, {
          categories: CATEGORY_META,
          tools: availability.map((a) => ({
            id: a.id,
            category: defs.get(a.id)?.category || 'system',
            skillId: a.skillId,
            enabled: a.enabled,
            code: a.code,
            reason: a.reason
          }))
        });
      }
    },
    {
      method: 'POST', pattern: '/api/config',
      handler: async ({ req, res, json }) => {
        const patch = await readBody(req);
        const next = updateConfig(patch);
        store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 0);
        sessions?.setKeepFiles?.(next.store?.keepSessionFiles ?? 0);
        if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
        initPriceFeed(FIXED_PRICE_FEED_URL);
        emit('status', { configUpdated: true });
        // ⚠️ 必须脱敏：updateConfig 返回的是内存里的活配置对象，含明文 apiKey /
        //    accessToken / dshProviderKeys。GET /api/config 一直是脱敏的，
        //    这里漏掉会让"任何一次保存设置"把全部明文密钥回传给浏览器。
        //
        // 2026-10-28：本次启动如果没能读出原配置文件（被占用/权限），updateConfig 会
        // **只改内存、不落盘**（否则会拿默认值覆盖用户原有配置）。这种情况下不能回
        // 一个和成功一样的 {ok:true} —— 用户会以为存好了，重启才发现全变了。带上
        // saved:false + warning，让界面如实说出来。
        const blocked = getConfigWriteBlock();
        return json(res, 200, {
          ok: true,
          saved: !blocked,
          ...(blocked ? {
            warning: `配置已生效但没能写入磁盘（本次启动读取原配置失败：${blocked.code}）。`
              + '为免覆盖你原有的配置，这次只改了内存 —— 重启应用后请重新保存一次。'
          } : {}),
          config: sanitizeConfig(next)
        });
      }
    },
    {
      method: 'GET', pattern: '/api/tools',
      handler: async ({ res, json }) => {
        const { listTools } = await import('../tool-registry.js');
        const tools = listTools().map((t) => ({
          id: t.id, name: t.name, description: t.description, category: t.category,
          icon: t.icon, defaultEnabled: t.defaultEnabled, requiresVision: t.requiresVision, requiresSearch: t.requiresSearch
        }));
        return json(res, 200, { tools });
      }
    },
    {
      // ── 插件面板内的「用户操作」通道（2026-10-18）──────────────────────
      // 背景：插件面板是**只读静态页**（安全模型见 src/skills/panel.js），
      // 群友反馈"表情库里的表情没法自己编辑"——备注/标签只能让机器人在聊天里改。
      // 这条通道让面板把"用户明确点的保存"转发成一次工具调用。
      //
      // 安全三道（缺一不可）：
      //   ① 来源校验 keyEndpointAllowed —— 只放行控制台自己（挡外部网页冒用 127.0.0.1）；
      //   ② 工具白名单 —— 只放"不发送消息、不读群上下文、只动插件自己数据"的工具；
      //      发送类（send_message/sticker__send_sticker）、读群类一律不在此列；
      //   ③ 工具必须真实注册且可执行。
      method: 'POST', pattern: '/api/plugin-tool',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { ok: false, error: '请求来源不被信任' });
        // 白名单：目前只有表情库面板需要（写备注 / 删除 / 恢复收藏表情）。
        // 新增工具前先问自己：它会不会发消息？会不会读群聊天？会不会改全局配置？
        // 任一为"会"，就不要加进来。
        const ALLOWED = new Set([
          'sticker__note',
          'sticker__delete_sticker',
          'sticker__restore_sticker',
          'sticker__list_deleted_stickers'
        ]);
        const body = await bodyOf(req);
        const name = String(body?.name || '');
        const args = body?.args && typeof body.args === 'object' ? body.args : {};
        if (!ALLOWED.has(name)) return json(res, 403, { ok: false, error: '该工具不允许从面板调用' });
        try {
          const { getTool } = await import('../tool-registry.js');
          const def = getTool(name);
          if (!def || typeof def.execute !== 'function') {
            return json(res, 404, { ok: false, error: '工具不存在或当前不可用' });
          }
          const r = await def.execute({}, args);
          if (r && r.isError) return json(res, 200, { ok: false, error: String(r.content || '执行失败') });
          return json(res, 200, { ok: true, result: String(r?.content ?? '') });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
  ];
}
