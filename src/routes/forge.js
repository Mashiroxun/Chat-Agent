// 路由域：扩展锻造：起草 / 适配 / 闸门 / 安装 / 升级
//
// 本文件由 src/routes.js 拆分而来（2026-11-04，R164）。**handler 代码逐字节原样搬运**，
// 只换了所在文件与函数外壳 —— 拆分的目的只是把 5248 行的单一函数按域切开，
// 不改任何一条路由的行为。新增路由请按域放进对应文件，不要再往 routes.js 里堆。
import { skillRuntimeContext, lockForgeDraft } from './_shared.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getConfig } from '../config.js';
import { chatCompletionWithRetry, resolveApiKey } from '../llm.js';
import { assistantHistoryEntry } from '../reasoning-history.js';
import { logger } from '../logger.js';
import { skillManager } from '../skills/manager.js';
import { setSkillEnabled } from '../skills/config.js';
import { PLUGINS_DIR } from '../plugin-loader.js';
import { toOpenAiTools, executeTool } from '../tools.js';
// 探测结果的"可对外"视图：删掉两枚令牌，只留有无标记。
// 令牌不越过 HTTP 边界的保证在这个纯函数里，路由只负责调它。

export function forgeRoutes(deps, shared) {
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
  const { bodyOf, createForgeProgress } = shared;

  return [
    {
      // 状态：插件是否启用 + 暂存区里有哪些草稿
      method: 'GET', pattern: '/api/forge',
      handler: async ({ res, json }) => {
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.list', ctx);
        if (!provs.length) {
          return json(res, 200, {
            ok: false, available: false,
            error: '「扩展锻造台」插件未启用（顶部「插件」页 → extension-forge）'
          });
        }
        try {
          const out = provs[0].fn({}) || {};
          return json(res, 200, { ok: true, available: true, drafts: out.drafts || [] });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `读取草稿列表失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 读一个草稿的全部文件内容（给 UI 展示生成的代码）
      method: 'POST', pattern: '/api/forge/read',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.read-draft', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          return json(res, 200, { available: true, ...provs[0].fn({ draftId: body.draftId }) });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 导入第三方扩展包：zip → 暂存区 → 拍快照 → 过闸门。**不安装**。
      //
      // 与 /api/skills/import 的关键差别：那条是"校验后直接落地、落地即执行"，
      // 这条只把内容读进暂存区，让人先看过。第三方代码不该有"导入即运行"的旁路。
      //
      // 快照（forge.snapshot）是给后面的"适配"用的 —— 有了适配前的底片，
      // 才能算出模型到底改了什么并展示 diff。这是第三方场景下最重要的透明度保障。
      method: 'POST', pattern: '/api/forge/import',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const zipBase64 = typeof body.zipBase64 === 'string' ? body.zipBase64 : '';
        if (!zipBase64) return json(res, 400, { ok: false, error: '没有收到 zip 内容' });
        // 导入会把 zip 解到暂存区，与正在进行的适配/升级互斥（body.draftId 为空时自动放行）
        if (!lockForgeDraft(res, json, body.draftId, '导入')) return;

        const ctx = skillRuntimeContext();
        const impProv = skillManager.getCapabilityProviders('forge.import-zip', ctx)[0];
        if (!impProv) {
          return json(res, 200, {
            ok: false, available: false,
            error: '「扩展锻造台」插件未启用（顶部「插件」页 → extension-forge）'
          });
        }

        let out;
        try {
          out = impProv.fn({ zipBase64, zipName: String(body.zipName || '') });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `导入失败：${String(error?.message ?? error)}` });
        }
        if (!out.ok) {
          return json(res, 200, { ok: false, available: true, rejected: !!out.rejected, error: out.error });
        }

        // 拍适配前快照（失败不阻断 —— 没有快照只是后面看不到 diff）
        try {
          skillManager.getCapabilityProviders('forge.snapshot', ctx)[0]?.fn({ draftId: out.draftId, label: 'pre' });
        } catch { /* ignore */ }

        // 跑闸门：让用户一眼看到"这个包现在能不能直接装"
        let gate = null;
        try {
          gate = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId: out.draftId }) || null;
        } catch (error) { gate = { ok: false, error: String(error?.message ?? error) }; }

        return json(res, 200, {
          ok: true, available: true,
          draftId: out.draftId, zipName: out.zipName, kind: out.kind,
          files: out.files, skipped: out.skipped, gate
        });
      }
    },
    {
      // 适配：把导入的（或任何）草稿交给模型改到"能装上、装完能工作"。
      //
      // 约束（界面上选的「清单为主 + 代码最小修补」）：
      //   · 优先改清单（apiVersion / entry / name / tools 声明 / permissions / requires）
      //   · 代码只在"不改就跑不起来"时做最小修补，且每处必须能说出"不改会怎么坏"
      //   · **不许借适配之名重写业务逻辑** —— 那等于把别人的扩展变成另一个东西
      //
      // 完成后重跑闸门 + 算 diff，把"改了什么"如实回给前端。
      method: 'POST', pattern: '/api/forge/adapt',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const draftId = String(body.draftId || '').trim();
        if (!draftId) return json(res, 400, { ok: false, error: '缺少 draftId' });
        const note = String(body.note || '').trim().slice(0, 1000);
        // 适配是一次几分钟的多轮写操作 —— 必须独占总个草稿（见 lockForgeDraft）
        if (!lockForgeDraft(res, json, draftId, '适配')) return;

        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.draft', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });

        // ── 适配的预算口径（改这里之前先读这条）─────────────────────────────
        // · 单段墙 240s（保持原值）；一段用满且**有进展**时自动续一段，最多 2 段
        //   （总计与起草路线"首轮 + 自动修复 2 轮"同量级）。这是 2026-10-16 的修复：
        //   原实现"单段 240s 对不封顶的多轮工作量"，第三方大包必现超时。
        // · 无进展（请求全挂死/端点不通）**不续段**：那种情况下续段只是把同一笔
        //   预算再烧一遍，保持直接报错（错误文案与旧版一致）。
        // · ⚠️ 改这里的任何数字，必须同步 ui/app/13-doctor.js 里适配按钮的客户端超时
        //   （560000ms ≈ 前置闸门 + 2×240s + 后置闸门/diff + 余量）。三层（客户端 /
        //   本段墙 / llm.js 单请求 180s）互有耦合，注释互指，别让它们再次漂移。
        const ADAPT_SEGMENT_MS = 240000;
        const ADAPT_MAX_SEGMENTS = 2;
        const ADAPT_MAX_ROUNDS = 12;

        const t0 = Date.now();
        let round = 0;              // 跨段累计轮次（1 起；日志 tag 与进度都用它）
        let seg = 1;                // 当前段（续段时 +1）
        let timedOut = false;       // 段墙中止但**有进展**（进度已保留，可再次点击继续）
        let noProgressWall = false; // 段墙中止且**毫无进展**（环境问题，按失败处理）
        let summary = '';
        const trace = [];
        let lastError = null;
        // 闸门结论（进度要报"还剩几项阻断"，故提前声明：否则前两条进度事件会撞上
        // let 的暂时性死区，被进度工具里的 try/catch 静默吞掉）
        let gate = null;

        // 进度推送：与 /api/forge/upgrade 共用同一套（工厂与纪律见 createForgeProgress）
        const progress = createForgeProgress('adapt', draftId, {
          maxRounds: ADAPT_MAX_ROUNDS, maxSegments: ADAPT_MAX_SEGMENTS
        });
        progress('prepare', { label: '读取草稿内容' });

        // ── 收集上下文：草稿内容 + 当前闸门结论 + 本地环境简报 ──
        let draftFiles = [];
        try {
          const rd = skillManager.getCapabilityProviders('forge.read-draft', ctx)[0]?.fn({ draftId }) || {};
          draftFiles = Array.isArray(rd.files) ? rd.files : [];
        } catch { /* ignore */ }
        if (!draftFiles.length) return json(res, 200, { ok: false, available: true, error: '草稿不存在或为空' });
        progress('prepare', { label: `草稿读出 ${draftFiles.length} 个文件`, files: draftFiles.length });

        gate = null;
        try { gate = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId }) || null; } catch { /* ignore */ }
        progress.st.blocking = Number(gate?.blocking || 0);
        progress('gate', {
          label: `跑第一遍安全闸门${gate?.blocking ? `（发现 ${gate.blocking} 项阻断）` : '（无阻断）'}`
        });

        let env = null;
        try { env = skillManager.getCapabilityProviders('forge.env', ctx)[0]?.fn({}) || null; } catch { /* ignore */ }
        progress('env', { label: '收集本机环境（可装的字段、可用的 API）' });

        // 工具集（写回草稿用；draftId 已给定，模型不用自己管草稿）
        let toolDefs = [], toolCtx = null;
        try {
          const out = provs[0].fn({ draftId }) || {};
          toolDefs = Array.isArray(out.defs) ? out.defs : [];
          toolCtx = out.ctx || null;
          progress('tools', { label: '装载写入工具（模型用它改草稿）' });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `写工具加载失败：${String(error?.message ?? error)}` });
        }

        // 凭据（与起草同源）
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
          return json(res, 200, { ok: false, available: true, error: '尚未配置聊天模型（设置 → 模型与搜索 → 模型 API）' });
        }

        // 闸门问题清单（就是"要修什么"）
        const issueText = (gate?.issues || []).length
          ? gate.issues.map((i, n) => {
            const lv = i.level === 'block' ? '⛔阻断' : (i.level === 'confirm' ? '⚠️需确认' : '💡提示');
            return `${n + 1}. [${lv}] ${i.title}${i.why ? `\n     原因：${i.why}` : ''}`;
          }).join('\n')
          : '（没有发现问题 —— 这个包可以直接装）';

        // 提示词体积：单文件仍截 12K 字符，但**整包总量封顶 12 万字符** ——
        // 超过时优先保留"清单 + 入口"（装不装得上就看它们），其余文件只列名，
        // 由模型用 forge_read_file 按需读取（工具本来就在工具集里）。
        // 目的：超大第三方包不再把每一轮都拖成"天价慢请求"，把预算花在刀刃上。
        const PROMPT_FILE_CHARS = 12000;
        const PROMPT_TOTAL_CHARS = 120000;
        const promptRankOf = (p) => (/^(skill|plugin)\.json$/i.test(p) ? 0 : (/(^|\/)index\.(js|mjs|cjs)$/i.test(p) ? 1 : 2));
        const promptParts = [];
        const promptOmitted = [];
        let promptChars = 0;
        for (const f of [...draftFiles].sort((a, b) => promptRankOf(a.path) - promptRankOf(b.path) || String(a.path).localeCompare(String(b.path)))) {
          const piece = `── ${f.path} ──\n${String(f.content).slice(0, PROMPT_FILE_CHARS)}`;
          if (promptParts.length && promptChars + piece.length > PROMPT_TOTAL_CHARS) { promptOmitted.push(f.path); continue; }
          promptParts.push(piece);
          promptChars += piece.length;
        }
        const fileText = promptParts.join('\n\n')
          + (promptOmitted.length
            ? `\n\n（为控制请求体积，以下 ${promptOmitted.length} 个文件未附正文，可用 forge_read_file 按需读取：\n${promptOmitted.map((p) => `  ${p}`).join('\n')}）`
            : '');

        const sys = [
          '你在**适配**一个别人写好的 QQ Agent 扩展，让它能在本机正常安装与工作。',
          '',
          '── 铁律（先读这条）──',
          '你的任务是**适配**，不是**重写**。这份代码是别人写的，作者的原意必须保住。',
          '  1. **优先改清单**（skill.json / plugin.json）：apiVersion、entry、name、description、',
          '     tools 声明、permissions、requires —— 绝大多数"装不上"都能靠改清单解决。',
          '  2. **代码只在"不改就跑不起来"时动**，且只做**最小必要修补**。',
          '  3. **绝对不要**借适配之名重构、优化、美化、或改掉它的业务逻辑。',
          '     如果你觉得必须大改代码才能用，**停下来如实说明**，不要硬改。',
          '  4. 每处代码改动都要能说出"不改会怎么坏"。说不出来就别改。',
          '',
          '── 本地环境（改之前必须对齐这些）──',
          '清单必须有：id（[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}）、name、apiVersion: 1、entry。',
          `本地 createSkillApi 提供的成员：${(env?.knownApis || []).join(' / ')}`,
          `本地认的权限只有：${(env?.knownPermissions || []).join(' / ')}`,
          `本机已装的扩展 id（撞车会被自动加 _1，但写死 id 的代码会错位）：${(env?.existingIds || []).slice(0, 40).join('、') || '（无）'}`,
          '',
          '── 注册样板（补写 / 修补工具注册时照抄结构，键名一个都不能错）──',
          '```js',
          'api.registerTool({',
          "  id: 'tool_id',                    // 必须与清单 tools[].id 一字不差",
          "  name: '工具名',",
          "  description: '给模型看的一句话说明',",
          '  parameters: { /* 与清单 tools[].parameters 一致 */ },',
          '  async execute(ctx, args) {        // ⚠️ 回调键名是 execute —— 写成 handler /',
          "    return { content: '结果文本' };  //    run / callback 等任何别的名字，工具都会",
          '  }                                 //    注册失败，整个扩展加载失败',
          '});',
          '```',
          '原包如果用的是别的框架风格（如 handler 键名），必须改成上面的 execute 形态 ——',
          '这是本机运行时的硬契约，闸门与加载器都按它校验。',
          '',
          '── 当前闸门结论（要修的就是这些）──',
          issueText,
          '',
          '── 草稿当前内容 ──',
          fileText,
          '',
          '── 怎么改 ──',
          '用工具把**改好的完整文件**写回去（forge_write_file 是覆盖写，不是追加）。',
          '改完用一段话说明：改了哪几个文件、每处为什么改、有没有你无法确定的地方。',
          '如果这个包根本没法安全适配（比如核心逻辑依赖一个本机没有的 API），',
          '就**明说做不到**并说明原因 —— 这比硬改出一个跑不了的东西诚实得多。',
          note ? `\n── 用户的补充说明 ──\n${note}` : ''
        ].join('\n');

        try {
          const messages = [
            { role: 'system', content: sys },
            { role: 'user', content: `请把这个扩展适配到本机环境（草稿 ${draftId}）。` }
          ];
          const openAiTools = toOpenAiTools(toolDefs);
          progress('model-start', { label: '把草稿、闸门结论和本机环境交给模型' });

          segments: for (; seg <= ADAPT_MAX_SEGMENTS; seg++) {
            const ac = new AbortController();
            const segStart = Date.now();
            const timer = setTimeout(() => ac.abort(new Error(`适配超时（${ADAPT_SEGMENT_MS / 1000}s）`)), ADAPT_SEGMENT_MS);
            let wallHit = false;
            try {
              while (round < ADAPT_MAX_ROUNDS) {
                // 提醒：轮次/时间任一接近枯竭就打招呼 —— 模型对时间没有感知，
                // 不告诉它"还剩多少"，它会把预算花在细节上（2026-10-16 升级为时间提醒）。
                const leftRounds = ADAPT_MAX_ROUNDS - round;
                const leftSec = Math.max(0, Math.round((ADAPT_SEGMENT_MS - (Date.now() - segStart)) / 1000));
                if (leftRounds <= 2 || leftSec <= 60) {
                  const tips = [];
                  if (leftRounds <= 2) tips.push(`总轮次只剩 ${leftRounds} 轮`);
                  if (leftSec <= 60) tips.push(`本段剩余时间约 ${leftSec} 秒`);
                  if (seg >= ADAPT_MAX_SEGMENTS) tips.push('之后不再续段');
                  messages.push({
                    role: 'user',
                    content: `【系统提醒】${tips.join('；')}。请立刻停止调用工具，用一段话说明你改了什么、为什么改；优先保证闸门阻断项已清零。`
                  });
                }
                round += 1;
                progress.beginRound(round);
                const r = await chatCompletionWithRetry({
                  messages,
                  tools: openAiTools,
                  temperature: 0.2,
                  signal: ac.signal,
                  overrides,
                  skillContext: { thinkingMode: 'off' },
                  tag: `forge-adapt:r${round}`
                });
                const msg = r?.message || {};
                const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
                if (!calls.length) { summary = typeof msg.content === 'string' ? msg.content : ''; break segments; }
                messages.push(assistantHistoryEntry(msg, { tool_calls: calls }));
                for (const call of calls) {
                  if (ac.signal.aborted) break;
                  const name = call?.function?.name || '';
                  const argsRaw = call?.function?.arguments ?? '{}';
                  let args = {};
                  try { args = JSON.parse(argsRaw); } catch { args = { _raw: argsRaw }; }
                  const fileHint = String(args?.path || '').trim();
                  progress.beginTool(name, fileHint);
                  const result = await executeTool(toolDefs, toolCtx, name, argsRaw);
                  const text = typeof result.content === 'string' ? result.content : String(result.content ?? '');
                  messages.push({ role: 'tool', tool_call_id: call.id, name, content: text });
                  trace.push({ round, tool: name, args, isError: !!result.isError, summary: text.replace(/\s+/g, ' ').slice(0, 200) });
                  // 只有"写/删"算真落地 —— 读文件不算改动，报多了会让用户以为改坏了很多东西
                  progress.endTool(name, fileHint, !result.isError);
                }
              }
            } catch (error) {
              lastError = error;
              // 段墙（ac 被 abort）或"单请求超时"（180s，防重复计费不重试）—— 两者都算
              // "本段被时间打断"，交给下面统一决定：有进展就续段 / 交付现场，无进展原样报错。
              // 其它错误（网络/端点/配置/坏响应）原样上抛，保持旧语义。
              const isTimeoutLike = ac.signal.aborted || /模型请求超时|适配超时/.test(String(error?.message ?? error));
              if (!isTimeoutLike) throw error;
              wallHit = true;
            } finally {
              clearTimeout(timer);
            }

            if (!wallHit) break;                          // 段内正常收尾（拿到总结/轮次用满）→ 不续段
            if (!trace.length) { noProgressWall = true; break; }   // 毫无进展 → 环境问题，不续段
            timedOut = true;                              // 有进展但时间用尽 → 进度保留
            if (seg >= ADAPT_MAX_SEGMENTS || round >= ADAPT_MAX_ROUNDS) break;
            progress.st.seg = seg;
            progress('segment', {
              label: `第 ${seg} 段时间用尽，接着跑第 ${seg + 1} 段（已改的 ${progress.st.changed} 处都保留着）`
            });
            messages.push({
              role: 'user',
              content: '（系统）上一段因时间用尽而中止。请基于当前草稿继续修改：优先清除闸门阻断项，每轮尽量一次把要改的文件写全。'
            });
          }

          // 请求全挂死（一段都没跑动）→ 保持旧行为：直接报错，不做任何"完成"假象。
          if (noProgressWall) throw lastError ?? new Error(`适配超时（${ADAPT_SEGMENT_MS / 1000}s）`);

          // 总结缺省：没给收尾说明时，给界面一段可读的话（不再回空串）
          if (!summary) {
            summary = timedOut
              ? `（本轮时间用尽：已完成 ${round} 轮、改动已保留在草稿里。可再次点击「让模型适配到本机」从当前草稿接着改。）`
              : `（已完成 ${round} 轮，模型未给出总结 —— 请查看下方 diff 与闸门结论。）`;
          }

          // 改完 / 时间用尽但**有进展**：都要重跑闸门 + 算 diff —— 超时也要交付"现场"
          let gate2 = null, diff = null;
          progress('gate2', { label: '改完了，重跑一遍安全闸门' });
          try { gate2 = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId }) || null; } catch { /* ignore */ }
          progress('diff', { label: '对比改动（改了哪几个文件）' });
          try { diff = skillManager.getCapabilityProviders('forge.diff', ctx)[0]?.fn({ draftId, label: 'pre' }) || null; } catch { /* ignore */ }
          progress('done', {
            label: timedOut ? '本轮时间用尽，进度已保留' : '适配完成',
            blocking: Number(gate2?.blocking || 0)
          });

          // 落一条结果日志：耗时/轮次/改动数/阻断数 —— 复盘不靠猜（配合 llm.js 的失败日志）
          try {
            const sm = diff?.summary || {};
            const changedFiles = Number(sm.added || 0) + Number(sm.changed || 0) + Number(sm.removed || 0);
            logger.info('forge-adapt', `草稿 ${draftId} ${timedOut ? '分段超时中止（有进展，进度已保留）' : '完成'}：${round} 轮 / ${Math.round((Date.now() - t0) / 1000)}s，改动 ${changedFiles} 个文件，闸门阻断 ${gate2?.blocking ?? '?'} 项`);
          } catch { /* 日志失败不影响结果 */ }

          return json(res, 200, {
            ok: true, available: true,
            draftId, summary, model: modelName, rounds: round, trace, timedOut,
            gateBefore: gate, gate: gate2, diff
          });
        } catch (error) {
          // 进度条要收尾：不推这一条，前端会一直停在"正在适配"，比报错本身更折磨人。
          progress('error', { label: '适配失败', error: String(error?.message ?? error) });
          // 失败也要留痕（含已跑轮次与耗时）—— 用户问"卡在哪"时，日志能自证
          try {
            logger.warn('forge-adapt', `草稿 ${draftId} 适配失败：${String(error?.message ?? error)}（已跑 ${round} 轮 / ${Math.round((Date.now() - t0) / 1000)}s）`);
          } catch { /* ignore */ }
          return json(res, 500, { ok: false, available: true, error: `适配失败：${String(error?.message ?? error)}`, rounds: round });
        }
      }
    },
    {
      // 起草：模型用写工具把草稿写进暂存区（多轮工具循环，复用 /api/doctor/ask 的模式）
      //
      // 与「对话排查」的关键差别：那个是**只读**的，这个是**写**的 ——
      // 但写盘被插件的 confinement 关在暂存区内，出不了 plugin-data/extension-forge/staging/。
      // 起草完成后**不自动安装** —— 必须用户在前面点确认（见下面 /api/forge/install）。
      method: 'POST', pattern: '/api/forge/draft',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        // 修改模式（带 draftId）下 requirement 允许为空 —— 原始需求从草稿元数据里取，
        // 输入框里装的是"本轮补充说明"（note）。新建模式 requirement 仍然必填。
        const requirement = String(body.requirement || '').trim();
        const note = String(body.note || '').trim().slice(0, 1000);
        const reviseDraftId = body.draftId ? String(body.draftId).trim() : '';
        if (!requirement && !reviseDraftId) return json(res, 400, { ok: false, error: '缺少 requirement' });
        if (requirement.length > 2000) return json(res, 400, { ok: false, error: '需求描述过长（上限 2000 字）' });
        // 「继续修改」是在已有草稿上重写（reviseDraftId 非空）—— 必须和适配/安装互斥。
        // 新建草稿时还没有 id，不会冲突，acquire 会直接放行。
        if (reviseDraftId && !lockForgeDraft(res, json, reviseDraftId, '起草')) return;

        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.draft', ctx);
        if (!provs.length) {
          return json(res, 200, {
            ok: false, available: false,
            error: '「扩展锻造台」插件未启用（顶部「插件」页 → extension-forge）'
          });
        }

        // 工具集 + 运行环境（含 draftId）
        let toolDefs = [], toolCtx = null, draftId = '';
        try {
          const out = provs[0].fn({ draftId: reviseDraftId || null }) || {};
          toolDefs = Array.isArray(out.defs) ? out.defs : [];
          toolCtx = out.ctx || null;
          draftId = out.draftId || '';
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `起草工具加载失败：${String(error?.message ?? error)}` });
        }
        if (!toolDefs.length) return json(res, 500, { ok: false, available: true, error: '锻造台没有提供写工具' });

        // 凭据（与自检页同源：doctorApi 开关对这里也生效，因为它就是"这套模型配置"）
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

        // ── 修改模式上下文（draftId 已给定）──────────────────────────────────
        // 起草接口天然支持"在同一个草稿上继续写"（forge.draft 的 draftId 参数 + 覆盖写），
        // 但"从零起草"的教学 prompt 会把修改轮带偏 —— 模型需要的是问题清单，不是格式课。
        // 这里喂给它三样东西：现有文件清单、上一轮闸门问题明细、原始需求。
        let reviseCtx = null;
        if (reviseDraftId) {
          let draftFiles = [];
          try {
            const rd = skillManager.getCapabilityProviders('forge.read-draft', ctx)[0]?.fn({ draftId: reviseDraftId }) || {};
            draftFiles = Array.isArray(rd.files) ? rd.files.map((f) => f.path) : [];
          } catch { /* ignore */ }
          if (!draftFiles.length) {
            return json(res, 200, { ok: false, available: true, error: `草稿 ${reviseDraftId} 不存在或为空（可能已被丢弃）` });
          }
          let gate = null;
          try { gate = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId: reviseDraftId }) || null; } catch { /* ignore */ }
          let meta = null;
          try { meta = skillManager.getCapabilityProviders('forge.load-meta', ctx)[0]?.fn({ draftId: reviseDraftId }) || null; } catch { /* ignore */ }
          reviseCtx = {
            files: draftFiles,
            gate,
            // 原始需求：草稿元数据优先（跨会话持久化），前端回传兜底（老草稿可能没有元数据）
            requirement: String(meta?.requirement || requirement || '')
          };
        }

        // ── 起草的三块内部构件 ──
        // 抽成局部函数的原因：闸门失败后要**自动修复**（把问题清单喂回去重跑），
        // 修复轮的 sys 与工具循环必须能在同一请求内复用 —— 复制粘贴两份迟早分叉。

        /** 金标准示例（few-shot）：给模型看"好扩展长什么样"，比十条规则更有效。 */
        const buildGoldenSection = () => {
          try {
            const exDir = [
              // 内置化之后示例住在 src/harness/forge/examples（2026-10-28 R130 搬的家）
              path.join(path.dirname(PLUGINS_DIR), 'src', 'harness', 'forge', 'examples'),
              // 旧安装形态仍可能留着 plugins/ 那份，两个都探一次：找不到再退空串
              path.join(PLUGINS_DIR, 'extension-forge', 'examples')
            ].find((dir) => fs.existsSync(path.join(dir, 'golden-skill.js'))) || '';
            const j = fs.readFileSync(path.join(exDir, 'golden-skill.json'), 'utf8').trim();
            const js = fs.readFileSync(path.join(exDir, 'golden-skill.js'), 'utf8').trim();
            return [
              '',
              '── 金标准示例（照这个水准与风格写）──',
              '下面是一个真实可跑、五道闸门全过的技能。学它的**味道**：description 具体到触发场景、',
              'execute 先校验参数且错误信息告诉用户怎么改、返回短小、零危险依赖。',
              '（示例本身也遵守全部禁区 —— 不要模仿示例里没出现的写法。）',
              '── golden-skill.json ──',
              j,
              '── golden-skill.js（入口 index.js）──',
              js,
              ''
            ].join('\n');
          } catch {
            return '';   // 示例缺失只降质量，不阻塞起草
          }
        };

        /** 修改/修复轮 sys：草稿现状 + 最新闸门问题清单 + 原始需求。 */
        const buildReviseSys = (gateNow, noteNow) => {
          let files = [];
          try {
            const rd = skillManager.getCapabilityProviders('forge.read-draft', ctx)[0]?.fn({ draftId }) || {};
            files = Array.isArray(rd.files) ? rd.files.map((f) => f.path) : [];
          } catch { /* 读失败时文件清单为空，模型按问题清单自行判断 */ }
          let requirement0 = '';
          try {
            const meta = skillManager.getCapabilityProviders('forge.load-meta', ctx)[0]?.fn({ draftId }) || null;
            requirement0 = String(meta?.requirement || requirement || '');
          } catch { requirement0 = requirement; }

          const issues = (gateNow?.issues || []);
          const issueText = issues.length
            ? issues.map((i, n) => {
              const lv = i.level === 'block' ? '⛔阻断' : (i.level === 'confirm' ? '⚠️需确认' : '💡提示');
              const snip = i.snippet ? `\n   片段：\n   ${String(i.snippet).slice(0, 800).replace(/\n/g, '\n   ')}` : '';
              return `${n + 1}. [${lv}] ${i.title}${i.why ? `\n   原因：${i.why}` : ''}${snip}`;
            }).join('\n')
            : '（上一轮没有留下结构化结论 —— 请自己读文件找问题）';

          return [
            '你是 QQ Agent 的扩展锻造师。暂存区里已有一个扩展草稿，你的任务是**在这个草稿上继续修改**，把它修到能用、能过闸门。',
            '',
            '── 草稿现状 ──',
            `draftId：${draftId}`,
            '文件（改之前先用 forge_read_file 读，不要凭想象改）：',
            ...files.map((p) => `  ${p}`),
            '',
            '── 这个扩展的原始需求 ──',
            requirement0 || '（没有记录 —— 从草稿内容与问题清单推断它该做什么）',
            '',
            '── 上一轮闸门结论（要修的就是这些）──',
            issueText,
            ...(noteNow ? ['', '── 用户本轮的补充说明（优先按这个改）──', noteNow] : []),
            '',
            '── 修改纪律 ──',
            '1. **不要推倒重来**：保留已写对的部分，只修问题。',
            '2. forge_write_file 是**覆盖写**，必须写**完整文件**，不是补丁片段。',
            '3. 需要删文件用 forge_delete_file，不要留死文件。',
            '4. 仍然不要写会被闸门一票否决的东西：child_process / execSync / spawn /',
            '   process.exit() / 读 account.json 等凭据 / 路径带 .. / 生成 .exe .bat .sh 等文件。',
            '5. 尽量把"⚠️需确认"的项也一并修掉（如 eval / fetch）—— 拿不准就保留并在说明里讲清用途。',
            '6. 改完用一段话说明改了什么、为什么。不要再调工具 —— 闸门与确认由界面负责。',
            '',
            '── 格式底线（闸门会查）──',
            '清单：id（[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}）/ name / version / apiVersion: 1 / entry / description；',
            'tools[].id 必须与 registerTool 的 id 一致；permissions 只认 web_fetch；enabledByDefault 固定 false。'
          ].join('\n');
        };

        /** 新建轮 sys：格式教学 + 金标准示例 + 禁区 + 工作方式 + 计划 + 需求。 */
        const buildCreateSys = (req, planText) => [
          '你是 QQ Agent 的扩展锻造师。你的工作是把用户的需求变成一份**可用的扩展**（技能或插件），',
          '写好草稿文件，交给闸门检查，最后由用户确认安装。',
          '',
          '── 你能做什么 ──',
          '用工具把文件写进**当前草稿**（暂存区）。写进去不会立刻生效 —— 要用户确认后才安装。',
          '所以你只管把文件写对，不需要考虑"会不会影响正在运行的系统"。',
          '',
          '── 两种扩展的区别（先判断用户要哪一种）──',
          '· **技能（skill）**：用 skill.json + index.js。适合"给模型新增一个能调用的工具"，',
          '  例如查询、计算、读某个数据源。模型会因为 prompt.when 描述的场景而主动调用。',
          '· **插件（plugin）**：用 plugin.json + index.js。适合"改变系统行为"，',
          '  例如拦截消息、改写回复、提供能力给别的扩展。靠 providers / hooks 工作。',
          '  绝大多数需求应该是**技能** —— 除非用户明确说要改变行为而不是加工具。',
          '',
          '── skill.json 的格式（照抄字段名，值按需改）──',
          JSON.stringify({
            id: 'my-tool', name: '我的工具', version: '1.0.0', apiVersion: 1,
            category: 'utility',
            description: '一句话说明这个扩展做什么（会显示在扩展列表里）',
            author: 'AI 生成',
            // ⚠️ 固定写 false：自创扩展**装完默认是关闭的**，用户去扩展列表里亲自开启。
            //    这是刻意的安全默认 —— 生成的代码会真的在本机执行，
            //    "装上了但还没开"给了人一个在它生效前再看一眼的机会。
            //    （即使这里写成 true，安装时也会被强制关掉，见 /api/forge/install。）
            enabledByDefault: false,
            entry: 'index.js',
            settings: {},
            configSchema: {},
            prompt: {
              when: '当用户……时（描述调用场景，这段会进系统提示词）',
              examples: ['示例请求 1', '示例请求 2'],
              instruction: '调用 my_tool 工具，参数……'
            },
            tools: [{
              id: 'my_tool', name: '我的工具', description: '工具做什么',
              category: 'system', icon: '🔧',
              parameters: {
                type: 'object',
                properties: { input: { type: 'string', description: '参数说明' } },
                required: ['input']
              }
            }]
          }, null, 2),
          '',
          '── index.js 的格式（技能）──',
          '```js',
          'export function register(api) {',
          '  api.registerTool({',
          "    id: 'my_tool',            // 必须与 skill.json 里 tools[].id 一致",
          "    name: '我的工具',",
          "    description: '工具做什么（模型靠这句话决定何时调用）',",
          '    parameters: { /* 与清单里一致 */ },',
          '    async execute(ctx, args) {',
          "      return { content: '给模型看的文本结果' };",
          '      // 失败时：return { content: \'错误：...\', isError: true };',
          '    }',
          '  });',
          '}',
          '```',
          '可用的 api：`api.registerTool(def)`、`api.config()`（读清单 settings 里声明的配置）、',
          '`api.log(...)` / `api.warn(...)` / `api.error(...)`、`api.isSkillActive(id)`、',
          '`api.capability(name, args)`（软依赖别的扩展提供的能力）。',
          buildGoldenSection(),
          // plan-then-write：计划是模型在计划轮**自己定的方向**，对"自己说过的话"的
          // 服从性远高于对外部规则 —— 这正是单独跑一轮计划的价值所在。
          ...(planText ? [
            '',
            '── 已批准的起草计划（上一轮定下的方向，动笔必须与它一致；',
            '   确实发现计划有硬伤才允许偏离，且必须在收尾说明里讲清为什么）──',
            planText,
            ''
          ] : []),
          '── ⛔ 绝对不要写的（会被闸门一票否决，白费一轮）──',
          '· `child_process` / `execSync` / `spawn` —— shell 执行，禁止',
          '· `process.exit()` —— 会杀掉整个应用，禁止',
          '· 读 `account.json` / `.env` 等凭据文件 —— 禁止',
          '· 路径里出现 `..` —— 禁止',
          '· 生成 `.exe` / `.bat` / `.sh` 等文件 —— 禁止（只允许 js/json/md/txt/css/html）',
          '',
          '── ⚠️ 会被标红要求用户确认的（尽量避开，能不用就不用）──',
          '· `eval` / `new Function`（若确实要算表达式，务必先用正则把入参限制成数字与运算符）',
          '· `fetch` / 联网（除非需求本身就要联网，且要写进 permissions: ["web_fetch"]）',
          '· `fs.unlinkSync` 等删除操作（不要删文件）',
          '· 读 `process.env`（环境变量里有机密；要配置用 api.config()）',
          '· 动态 `import(变量)`（所有静态检查都会失效；用静态 import 或 import 字符串字面量）',
          '· 向 `plugins/` / `skills/` / `config.json` 等应用路径写文件（等于自装后门，会被拦下）',
          '· `setInterval` 不配 `clearInterval`（定时器泄漏；创建与清理要成对出现）',
          '',
          '── 工作方式 ──',
          '1. 先想清楚要几个文件。正常情况**只需要 2 个**：清单 + index.js。不要过度设计。',
          '2. 用 forge_write_file 把文件写进去。写完可以用 forge_read_file 读回来确认。',
          '3. 不确定用户意图时，**先按最合理的假设做出来** —— 不要停下来追问，这里没有对话轮次，',
          '   返工靠用户看完说明点"继续修改"。',
          '4. 全部写完后给用户的说明**固定三段、假设放最前面**（很多用户不会写提示词，',
          '   你的假设就是他唯一能核对的东西 —— 必须一眼看到）：',
          '   ❶ ❓假设：最多 2 条，每条一行，只列影响功能方向的关键决定（参数怎么触发、数据从哪来等）；',
          '   ❷ 做了什么（一两句话，说清装上后怎么用）；',
          '   ❸ 需要注意什么（比如要联网、要在哪里开启）。',
          '   不要再调用工具 —— 闸门与确认由界面负责。',
          '5. 收尾时**提醒一句**：它装完是**关闭状态**，要去顶部的「技能」/「插件」页里手动开启才会生效。',
          '',
          '── 需求 ──',
          req
        ].join('\n');

        /**
         * 跑一轮"模型 + 写工具"循环（240s 自杀钟）。
         * 返回 { summary, rounds, trace }；summary 为空表示轮次耗尽模型没给收尾话。
         */
        const runDraftLoop = async (sysText, userText, tagPrefix) => {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(new Error('起草超时（240s）')), 240000);
          const messages = [
            { role: 'system', content: sysText },
            { role: 'user', content: userText }
          ];
          const openAiTools = toOpenAiTools(toolDefs);
          const MAX_ROUNDS = 8;
          const trace = [];
          let summary = '';
          let rounds = 0;

          try {
            for (let round = 0; round < MAX_ROUNDS; round++) {
              rounds = round + 1;
              const left = MAX_ROUNDS - round;
              if (left <= 2 && left > 0) {
                messages.push({
                  role: 'user',
                  content: `【系统提醒】起草轮次只剩 ${left} 轮。请立刻停止调用工具，用一段话说明你写了什么、有什么假设。`
                });
              }
              const r = await chatCompletionWithRetry({
                messages,
                tools: openAiTools,
                temperature: 0.2,
                signal: ac.signal,
                overrides,
                // 起草要写代码，思考有帮助 —— 但服务端强制思考时 reasoning 会吃 max_tokens，
                // 且这里有多轮兜底（没工具调用时正文才重要），所以关掉换取确定性。
                skillContext: { thinkingMode: 'off' },
                tag: `${tagPrefix}:r${round}`
              });
              const msg = r?.message || {};
              const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
              if (!calls.length) {
                summary = typeof msg.content === 'string' ? msg.content : '';
                break;
              }
              messages.push(assistantHistoryEntry(msg, { tool_calls: calls }));
              for (const call of calls) {
                if (ac.signal.aborted) break;
                const name = call?.function?.name || '';
                const argsRaw = call?.function?.arguments ?? '{}';
                let args = {};
                try { args = JSON.parse(argsRaw); } catch { args = { _raw: argsRaw }; }
                const result = await executeTool(toolDefs, toolCtx, name, argsRaw);
                const text = typeof result.content === 'string' ? result.content : String(result.content ?? '');
                messages.push({ role: 'tool', tool_call_id: call.id, name, content: text });
                trace.push({
                  round: rounds, tool: name, args,
                  isError: !!result.isError,
                  summary: text.replace(/\s+/g, ' ').slice(0, 200)
                });
              }
            }
          } finally {
            clearTimeout(timer);
          }
          return { summary, rounds, trace };
        };

        try {
          // ── plan-then-write（仅新建模式）：先让模型出一份 3-5 行起草计划 ──
          // 为什么单独一轮：模型"上来就写"最容易写错方向（工具怎么拆、放几个），
          // 方向错了修复轮极贵。用一次极小的调用（30s 自杀钟、无工具）把方向定下来，
          // 起草轮再被自己批准的计划约束。计划失败/为空 → 退回直接起草，不阻塞。
          let plan = '';
          if (!reviseCtx) {
            try {
              const ac = new AbortController();
              const timer = setTimeout(() => ac.abort(new Error('计划超时（30s）')), 30000);
              try {
                const rp = await chatCompletionWithRetry({
                  messages: [
                    { role: 'system', content: '你是 QQ Agent 的扩展锻造师。用户会给你一个扩展需求，你**只输出起草计划**，不写任何代码、不调用任何工具。' },
                    { role: 'user', content: `需求：${requirement}\n\n输出 3-5 行计划，覆盖：\n1. 扩展类型（技能/插件）与建议 id\n2. 工具数量与各自职责（一行一个）\n3. 关键假设（最多 2 条，❓开头）\n只输出计划本身，不要寒暄、不要输出代码。` }
                  ],
                  temperature: 0.2,
                  signal: ac.signal,
                  overrides,
                  skillContext: { thinkingMode: 'off' },
                  tag: 'forge-plan'
                });
                plan = typeof rp?.message?.content === 'string' ? rp.message.content.trim().slice(0, 1200) : '';
              } finally {
                clearTimeout(timer);
              }
            } catch { /* 计划失败不阻塞起草 */ }
          }

          // 首轮：修改模式喂闸门问题清单 + 补充说明；新建模式喂教学 prompt + 计划 + 需求
          const first = await runDraftLoop(
            reviseCtx ? buildReviseSys(reviseCtx.gate, note) : buildCreateSys(requirement, plan),
            reviseCtx ? (note || '请按上面的闸门问题清单修复这个草稿。') : requirement,
            'forge-draft'
          );
          let summary = first.summary;
          let rounds = first.rounds;
          const trace = [...first.trace];

          // 原始需求持久化 —— 修改轮 / 跨会话打开老草稿时，模型才知道"当初要做什么"。
          // 只在新草稿时写：修改轮需求没变（变化的部分走 note），重写反而可能覆盖掉更早的记录。
          if (!reviseCtx && draftId) {
            try {
              skillManager.getCapabilityProviders('forge.save-meta', ctx)[0]?.fn({ draftId, requirement });
            } catch { /* 元数据失败不影响起草结果 */ }
          }

          // 起草完立刻跑闸门 —— 让用户看到的是"已经检查过的"草稿
          const gateProv = skillManager.getCapabilityProviders('forge.gate', ctx)[0];
          const runGate = () => {
            try { return gateProv ? gateProv.fn({ draftId }) : null; }
            catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
          };
          let gate = runGate();

          // ── 自动修复：把平台的反馈回路转起来 ──
          // 闸门有 ⛔阻断 项时不再等用户点"继续修改"——问题清单本来就是修复 prompt，
          // 模型看到行号和原因就能修。上限 2 轮 + 总时限 8 分钟（防无限循环烧钱）。
          // confirm 项不算失败 —— 那是留给用户的放行决定，机器不该替人点头。
          let autoFixAttempts = 0;
          const fixDeadline = Date.now() + 8 * 60000;
          while (gate && Number(gate.blocking) > 0 && autoFixAttempts < 2 && Date.now() < fixDeadline) {
            autoFixAttempts += 1;
            const fix = await runDraftLoop(
              buildReviseSys(gate, ''),
              '请按上面的闸门问题清单修复这个草稿。逐项修，修完不要再调工具。',
              `forge-autofix${autoFixAttempts}`
            );
            trace.push(...fix.trace);
            rounds += fix.rounds;
            if (fix.summary) summary = fix.summary;
            gate = runGate();
          }

          // 升级目标（「升级扩展」创建的草稿才有）。必须在响应里回传：
          // 「继续修改」会给已有的升级草稿重写入代码，前端拿不到 upgradeOf 就会
          // 把安装按钮退回"确认安装"，进而走 /api/forge/install（同名递增、绝不覆盖），
          // 把已装扩展复制成 sq-self-2 —— 与「暂存区草稿列表」那次是同一个坑。
          let upgradeOf = null;
          try {
            const m = skillManager.getCapabilityProviders('forge.load-meta', ctx)[0]?.fn({ draftId });
            if (m?.upgradeOf && m.upgradeTargetExists !== false) upgradeOf = m.upgradeOf;
          } catch { /* 老草稿没有 meta —— 正常 */ }

          return json(res, 200, {
            ok: true, available: true,
            draftId, summary, model: modelName, rounds,
            trace, gate, autoFixAttempts, plan, upgradeOf
          });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `起草失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 重跑闸门（用户手改过草稿、或只想复核时）
      method: 'POST', pattern: '/api/forge/gate',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.gate', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          const gate = provs[0].fn({ draftId: body.draftId });
          // 草稿是不是「升级扩展」创建的升级草稿（upgradeOf = { kind, dir, id, version }）。
          // 打开草稿的视图靠它区分「新装」与「覆盖更新」—— 按钮文案与实际走的
          // 安装端点（install 的同名递增 vs upgrade-install 的备份+覆盖）都由它决定。
          // ⚠️ 目标已被卸载时按 null 处理（与 forge.list 同一把尺子），否则会出现
          //    "列表说待安装、点开说可覆盖更新、点下去报升级目标不存在"。
          let upgradeOf = null;
          try {
            const m = skillManager.getCapabilityProviders('forge.load-meta', ctx)[0]
              ?.fn({ draftId: body.draftId });
            if (m?.upgradeOf && m.upgradeTargetExists !== false) upgradeOf = m.upgradeOf;
          } catch { /* 老草稿没有 meta —— 正常 */ }
          return json(res, 200, { available: true, gate, upgradeOf });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 签发「人工确认票据」—— 安装的唯一钥匙。
      //
      // 为什么单独一条路由，而不是让 install 自己判断"是不是人在点"：
      //   后端看不见"人"，它能看见的只有"这个请求是不是控制台自己发的"。
      //   而那正是 keyEndpointAllowed 在判的事（渲染进程私有的 32 字节凭据，
      //   由主进程 webRequest 注入、不落盘、不进 DOM；或用户自配的 server.token）——
      //   本机其它进程与外部网页都拿不到。签票与用票分开，票再绑内容摘要，
      //   于是"人看到的那份 == 将要落盘的那份"才成立。
      method: 'POST', pattern: '/api/forge/confirm',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, {
            ok: false,
            error: '确认安装只能从控制台窗口发起（当前请求没有控制台凭据）。'
              + '用外部浏览器打开控制台的话，先在设置里配置「服务 token」，'
              + '再用 控制台地址?token=<你的token> 打开 —— 那道凭据就是"人在现场"的依据。'
          });
        }
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.confirm-ticket', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」未就绪' });
        try {
          const out = provs[0].fn({
            draftId: body.draftId,
            digest: String(body.digest || ''),
            // 走到这里 = 控制台里有人点了按钮。这不是"系统自动确认"，
            // 而是"能拿到控制台私有凭据的那一端说人点了"。
            human: true
          });
          if (out?.ok) {
            log('info', `[forge] 人工确认：草稿 ${String(body.draftId)}（摘要 ${String(out.digest || '').slice(0, 12)}…，10 分钟内有效）`);
          }
          return json(res, 200, { available: true, ...out });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 安装：把放行过的草稿搬进 skills/ 或 plugins/（之后热重载自动装载）
      //
      // ⚠️ 插件内部会**再跑一次闸门** —— 不信任"前端说它检查过了"。
      //    闸门结论与安装之间隔着人工确认，期间草稿可能被改动。
      // ⚠️ 还必须带 /api/forge/confirm 签发的票据：闸门通过 ≠ 有人同意装。
      method: 'POST', pattern: '/api/forge/install',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        // 安装会按当前草稿内容落地 + 备份原版：草稿同时在改会让"闸门结论"与
        // "真正装进去的东西"不是同一份（前端有守卫，这里兜后端/多窗口）。
        if (!lockForgeDraft(res, json, body.draftId, '安装')) return;
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.install', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        // 兜底：确认票据能力必须存在。缺了说明跑的是旧版锻造台（plugins/ 下还留着旧副本，
        // 或应用没重启）—— 那种 install 不验票，不能让它承载"人工确认"这条链路。
        if (!skillManager.getCapabilityProviders('forge.confirm-ticket', ctx).length) {
          return json(res, 503, {
            ok: false,
            error: '扩展锻造台版本过旧（缺少「确认票据」能力）—— 请重启应用后再安装。本次未做任何改动。'
          });
        }
        try {
          const out = provs[0].fn({
            draftId: body.draftId,
            confirmIssues: body.confirmIssues === true,
            approvalToken: String(body.approvalToken || '')
          });

          // ── 装上之后**强制置为关闭** ──────────────────────────────────
          //
          // 为什么在核心做、而不是交给插件或靠模型自觉：
          //   1. 模型写清单时基本会照抄提示词模板，它给不给 enabledByDefault:false 不可靠；
          //      写配置是"无论生成物怎么写都生效"的那条路。
          //   2. 配置的优先级高于清单（`isSkillEnabledInConfig`：有配置看配置，没配置才看清单），
          //      所以写一条 `skills.<id>.enabled = false` 就能盖过清单里写死的 true。
          //   3. 写 skills 配置本来就是**核心的职责**（UI 的开关走的也是 setSkillEnabled），
          //      插件不该去动别家扩展的配置。
          //
          // 语义：这不是"禁用这个扩展"，而是"装好后先别跑，等你亲自开"。
          //      用户去扩展列表点一下开启即可，之后一切照旧。
          let autoDisabled = false;
          if (out?.ok && out.id) {
            try {
              setSkillEnabled(out.id, false);
              autoDisabled = true;
            } catch { /* 写配置失败不该让安装整体算失败，如实告诉前端即可 */ }
          }

          return json(res, 200, { available: true, ...out, autoDisabled });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 丢弃草稿
      method: 'POST', pattern: '/api/forge/discard',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        // 丢弃是破坏性的：正在适配/升级时把草稿删掉，那条请求会继续往同一个
        // draftId 写文件，"删掉的草稿自己复活"（前端也有守卫，这里兜后端）。
        if (!lockForgeDraft(res, json, body.draftId, '丢弃')) return;
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.discard', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          return json(res, 200, { available: true, ...provs[0].fn({ draftId: body.draftId }) });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 已装扩展清单（可升级对象）。不读内存注册表读磁盘清单 —— 升级要对的是"目录里的版本"
      method: 'GET', pattern: '/api/forge/installed',
      handler: async ({ res, json }) => {
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.installed', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try { return json(res, 200, { available: true, ...provs[0].fn({}) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 以某个已装扩展为底，复制进暂存区作为升级草稿
      method: 'POST', pattern: '/api/forge/upgrade-start',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.upgrade-start', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          return json(res, 200, {
            available: true,
            ...provs[0].fn({ kind: body.kind, dir: body.dir })
          });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 对话升级：模型读草稿副本、按用户的升级要求修改，改完自动跑闸门 + 对比原版
      method: 'POST', pattern: '/api/forge/upgrade',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const draftId = String(body.draftId || '').trim();
        const note = String(body.note || '').trim().slice(0, 2000);
        if (!draftId) return json(res, 400, { ok: false, error: '缺少 draftId' });
        if (!note) return json(res, 400, { ok: false, error: '缺少升级要求（note）' });
        // 与适配同一把锁：升级也是一次几分钟的多轮写操作
        if (!lockForgeDraft(res, json, draftId, '升级')) return;

        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.draft', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });

        // ── 收集上下文：草稿现状 + 原版信息 + 本地环境 ──
        // 进度推送（与 /api/forge/adapt 同一套工厂；纪律见 createForgeProgress）
        // 升级这条路线总预算 8 分钟（首轮 240s + 最多 2 轮自动修复），没有进度反馈时
        // 用户只能对着一行"正在升级…"干等 —— 设置页的「🔧 自动适配」就是走这里。
        const progress = createForgeProgress('upgrade', draftId, { maxRounds: 8 });
        progress('prepare', { label: '读取草稿内容' });
        let draftFiles = [];
        try {
          const rd = skillManager.getCapabilityProviders('forge.read-draft', ctx)[0]?.fn({ draftId }) || {};
          draftFiles = Array.isArray(rd.files) ? rd.files : [];
        } catch { /* ignore */ }
        if (!draftFiles.length) return json(res, 200, { ok: false, available: true, error: '草稿不存在或为空' });
        progress('prepare', { label: `草稿读出 ${draftFiles.length} 个文件`, files: draftFiles.length });

        let meta = null;
        try { meta = skillManager.getCapabilityProviders('forge.load-meta', ctx)[0]?.fn({ draftId }) || null; } catch { /* ignore */ }
        const up = meta?.upgradeOf || null;
        progress('prepare', { label: `认出升级目标：${up?.id || '未记录'}` });

        let env = null;
        try { env = skillManager.getCapabilityProviders('forge.env', ctx)[0]?.fn({}) || null; } catch { /* ignore */ }
        progress('env', { label: '收集本机环境（可用 API、已装扩展）' });

        let toolDefs = [], toolCtx = null;
        try {
          const out = provs[0].fn({ draftId }) || {};
          toolDefs = Array.isArray(out.defs) ? out.defs : [];
          toolCtx = out.ctx || null;
          progress('tools', { label: '装载写入工具（模型用它改草稿）' });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `写工具加载失败：${String(error?.message ?? error)}` });
        }

        const cfg = getConfig();
        const d = cfg.doctorApi || {};
        const useOwn = d.enabled === true && String(d.model || '').trim();
        const overrides = useOwn ? {
          baseUrl: String(d.baseUrl || cfg.api?.baseUrl || ''),
          apiKey: String(d.apiKey || '').trim() || resolveApiKey(cfg),
          model: String(d.model).trim()
        } : null;
        const modelName = useOwn ? overrides.model : cfg.api?.model;
        if (!modelName) return json(res, 200, { ok: false, available: true, error: '尚未配置聊天模型（设置 → 模型与搜索 → 模型 API）' });

        // 草稿全文（总量截断 —— 大扩展靠文件清单 + forge_read_file 兜底）
        let budget = 40000;
        const fileText = draftFiles.map((f) => {
          const content = String(f.content || '').slice(0, Math.max(0, budget));
          budget -= content.length;
          return `── ${f.path} ──\n${content}${String(f.content || '').length > content.length ? '\n…（已截断）' : ''}`;
        }).join('\n\n');

        const sys = [
          '你在**升级**一个已安装的 QQ Agent 扩展。暂存区里已有一份它的完整副本（草稿），',
          '你的任务是按用户的要求修改这份副本 —— 改完后由闸门检查、用户确认，才会覆盖安装回原位。',
          '',
          '── 扩展现状 ──',
          up ? `目标扩展：${up.id}（${up.kind === 'plugin' ? '插件' : '技能'}）当前版本 v${up.version || '?'}，目录 ${up.dir}` : '（缺少升级目标信息）',
          '草稿文件：',
          ...draftFiles.map((f) => `  ${f.path}`),
          '',
          '── 草稿当前内容 ──',
          fileText,
          '',
          '── 本地环境（改之前必须对齐）──',
          `本地 createSkillApi 提供的成员：${(env?.knownApis || []).join(' / ')}`,
          `本地认的权限只有：${(env?.knownPermissions || []).join(' / ')}`,
          `本机已装的扩展 id：${(env?.existingIds || []).slice(0, 40).join('、') || '（无）'}`,
          '',
          '── 升级纪律（违反会造成真实损失）──',
          '1. **manifest.id 绝对不能改** —— id 变了等于装了个新扩展：旧配置、启用状态、',
          '   会话里的调用习惯全部失联。这是升级场景的铁律。',
          '2. version 按语义递增：小修 +0.0.1，新增能力 +0.1.0，大改 +1.0.0。',
          '3. **工具向后兼容**：已有工具的 id 与参数结构尽量保持；新增随意，改旧签名要慎重。',
          '4. 不要写会被闸门一票否决的东西：child_process / execSync / spawn / process.exit() /',
          '   读 account.json 等凭据 / 路径带 .. / 生成 .exe .bat .sh 等文件。',
          '5. forge_write_file 是覆盖写，必须写**完整文件**；不要的文件用 forge_delete_file 删。',
          '6. **清单字段一个都不能丢**：重写 skill.json / plugin.json 时**逐字段对照上面的原文**，',
          '   必填：id / name / version / apiVersion: 1 / entry / description / enabledByDefault: false。',
          '   丢任何一个（最常见是 apiVersion）都会被闸门结构检查一票否决 —— 不要凭记忆重打清单。',
          '7. 改完用一段话说明：改了什么、为什么、版本号为什么这么递增。',
          '   不要再调工具 —— 闸门与确认由界面负责。',
          '',
          '── 用户的升级要求 ──',
          note
        ].join('\n');

        try {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(new Error('升级超时（240s）')), 240000);
          const messages = [
            { role: 'system', content: sys },
            { role: 'user', content: note }
          ];
          const openAiTools = toOpenAiTools(toolDefs);
          const MAX_ROUNDS = 8;
          const trace = [];
          let summary = '';
          let rounds = 0;
          progress('model-start', { label: '把草稿和你的要求交给模型' });

          /**
           * 一段"模型 + 写工具"循环。首轮与自动修复轮共用同一 messages 上下文
           * （模型记得自己改过什么），但各有独立的 240s 自杀钟（signal 注入）。
           */
          const runLoop = async (tagPrefix, signal) => {
            for (let round = 0; round < MAX_ROUNDS; round++) {
              rounds += 1;
              progress.beginRound(rounds);
              const left = MAX_ROUNDS - round;
              if (left <= 2 && left > 0) {
                messages.push({
                  role: 'user',
                  content: `【系统提醒】本轮轮次只剩 ${left} 轮。请立刻停止调用工具，用一段话说明你改了什么、为什么改。`
                });
              }
              const r = await chatCompletionWithRetry({
                messages,
                tools: openAiTools,
                temperature: 0.2,
                signal,
                overrides,
                skillContext: { thinkingMode: 'off' },
                tag: `${tagPrefix}:r${round}`
              });
              const msg = r?.message || {};
              const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
              if (!calls.length) { summary = typeof msg.content === 'string' ? msg.content : ''; break; }
              messages.push(assistantHistoryEntry(msg, { tool_calls: calls }));
              for (const call of calls) {
                if (signal.aborted) break;
                const name = call?.function?.name || '';
                const argsRaw = call?.function?.arguments ?? '{}';
                let args = {};
                try { args = JSON.parse(argsRaw); } catch { args = { _raw: argsRaw }; }
                const result = await executeTool(toolDefs, toolCtx, name, argsRaw);
                const text = typeof result.content === 'string' ? result.content : String(result.content ?? '');
                messages.push({ role: 'tool', tool_call_id: call.id, name, content: text });
                trace.push({ round: rounds, tool: name, args, isError: !!result.isError, summary: text.replace(/\s+/g, ' ').slice(0, 200) });
                progress.endTool(name, String(args?.path || '').trim(), !result.isError);
              }
            }
          };

          try {
            await runLoop('forge-upgrade', ac.signal);
          } finally {
            clearTimeout(timer);
          }

          // 改完：跑闸门 + 与已装原版对比（"更新了什么"）
          const runGateDiff = () => {
            let g = null, df = null;
            try { g = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId }) || null; } catch { /* ignore */ }
            try { df = skillManager.getCapabilityProviders('forge.compare-installed', ctx)[0]?.fn({ draftId }) || null; } catch { /* ignore */ }
            return { gate: g, diff: df };
          };
          progress('gate2', { label: '改完了，跑一遍安全闸门、和原版对比' });
          let { gate, diff } = runGateDiff();
          progress.st.blocking = Number(gate?.blocking || 0);

          // ── 自动修复：升级路径与 draft 同款反馈回路 ──
          // 闸门有 ⛔阻断 时把问题清单喂回同一上下文重跑（模型记得自己刚改了什么），
          // 上限 2 轮 / 总时限 8 分钟。confirm 项不算失败 —— 那是留给用户的放行决定。
          let autoFixAttempts = 0;
          const fixDeadline = Date.now() + 8 * 60000;
          while (gate && Number(gate.blocking) > 0 && autoFixAttempts < 2 && Date.now() < fixDeadline) {
            autoFixAttempts += 1;
            progress.st.blocking = Number(gate?.blocking || 0);
            progress.st.fixIdx = autoFixAttempts;   // 让进度条知道"这是在补改，不是从头再来"
            progress('fix', {
              label: `闸门还有 ${gate.blocking} 项阻断，让模型再改一轮（第 ${autoFixAttempts} 次自动修复）`
            });
            const issueText = (gate.issues || [])
              .map((i, n) => `${n + 1}. [${i.level === 'block' ? '⛔阻断' : i.level === 'confirm' ? '⚠️需确认' : '💡提示'}] ${i.title}${i.why ? ` —— ${String(i.why).slice(0, 300).replace(/\n/g, ' ')}` : ''}`)
              .join('\n');
            messages.push({
              role: 'user',
              content: `【系统】闸门仍有 ${gate.blocking} 项阻断，请逐项修复。要点：forge_write_file 是覆盖写（必须写完整文件）；`
                + `manifest.id 绝对不能改；清单必填字段（id / name / version / apiVersion: 1 / entry / description / enabledByDefault: false）一个都不能丢。\n`
                + `${issueText}\n修完用一句话说明改了什么，不要再调工具。`
            });
            const ac2 = new AbortController();
            const t2 = setTimeout(() => ac2.abort(new Error('修复轮超时（240s）')), 240000);
            try {
              await runLoop(`forge-upgrade-fix${autoFixAttempts}`, ac2.signal);
            } catch { break; }   // 修复轮 LLM 失败就停，别死循环
            finally { clearTimeout(t2); }
            ({ gate, diff } = runGateDiff());
          }
          progress.st.blocking = Number(gate?.blocking || 0);
          progress('diff', { label: '和已装原版对比（更新了什么）' });
          progress('done', {
            label: gate && Number(gate.blocking) > 0 ? `改完了，闸门还剩 ${gate.blocking} 项阻断` : '升级/适配完成'
          });

          return json(res, 200, {
            ok: true, available: true,
            draftId, summary, model: modelName, rounds, trace,
            gate, diff, autoFixAttempts
          });
        } catch (error) {
          // 进度条要收尾：不推这一条，前端会一直停在"正在升级"，比报错本身更折磨人。
          progress('error', { label: '升级/适配失败', error: String(error?.message ?? error) });
          return json(res, 500, { ok: false, available: true, error: `升级失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 草稿 vs 已装原版的逐文件 diff（zip 升级路径：导入后先看"更新了什么"）
      method: 'POST', pattern: '/api/forge/compare',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.compare-installed', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          return json(res, 200, { available: true, ...provs[0].fn({ draftId: body.draftId }) });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 升级落地：备份原版 → 覆盖安装（id 一致性 + 闸门由插件强制校验）
      method: 'POST', pattern: '/api/forge/upgrade-install',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        // 与 install 同理：落地前必须确保草稿没在被改写
        if (!lockForgeDraft(res, json, body.draftId, '升级安装')) return;
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.upgrade-install', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        if (!skillManager.getCapabilityProviders('forge.confirm-ticket', ctx).length) {
          return json(res, 503, {
            ok: false,
            error: '扩展锻造台版本过旧（缺少「确认票据」能力）—— 请重启应用后再升级。本次未做任何改动。'
          });
        }
        try {
          return json(res, 200, {
            available: true,
            ...provs[0].fn({
              draftId: body.draftId,
              kind: body.kind,
              dir: body.dir,
              confirmIssues: body.confirmIssues === true,
              // 覆盖已装扩展比装新的更不可逆，同样要人工确认票据（见 /api/forge/confirm）
              approvalToken: String(body.approvalToken || '')
            })
          });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 回滚：恢复到最近一次升级前的备份
      method: 'POST', pattern: '/api/forge/rollback',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.rollback', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          return json(res, 200, { available: true, ...provs[0].fn({ kind: body.kind, dir: body.dir }) });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
  ];
}
