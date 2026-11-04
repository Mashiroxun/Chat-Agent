// 路由域：自检与体检：doctor 报告、扫描、模型逐个审
//
// 本文件由 src/routes.js 拆分而来（2026-11-04，R164）。**handler 代码逐字节原样搬运**，
// 只换了所在文件与函数外壳 —— 拆分的目的只是把 5248 行的单一函数按域切开，
// 不改任何一条路由的行为。新增路由请按域放进对应文件，不要再往 routes.js 里堆。
import { skillRuntimeContext } from './_shared.js';
import { spawn } from 'node:child_process';
import { getConfig, updateConfig } from '../config.js';
import { chatCompletion, chatCompletionWithRetry, resolveApiKey } from '../llm.js';
import { assistantHistoryEntry } from '../reasoning-history.js';
import { logger } from '../logger.js';
import { skillManager } from '../skills/manager.js';
import { toOpenAiTools, executeTool } from '../tools.js';
// 探测结果的"可对外"视图：删掉两枚令牌，只留有无标记。
// 令牌不越过 HTTP 边界的保证在这个纯函数里，路由只负责调它。

export function doctorRoutes(deps, shared) {
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
      method: 'GET', pattern: '/api/doctor',
      handler: async ({ res, json }) => {
        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.report', ctx);
        if (!providers.length) {
          return json(res, 200, {
            ok: false, available: false,
            // 2026-10-20 修：原文案写「设置 → 插件」，但「插件」是顶部一个独立页签、
            // 并不在设置里；self-doctor 属于插件页里的那个条目。
            error: '「系统自检」插件未启用（顶部「插件」页 → self-doctor）'
          });
        }
        try {
          // run=force 时强制重扫；默认 5 分钟内复用上次结果（与插件内逻辑一致）
          const force = false;
          const out = providers[0].fn({ run: force });
          const report = out?.report || null;
          return json(res, 200, { ok: true, available: true, report, text: out?.text || '' });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `自检执行失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/doctor/run',
      handler: async ({ req, res, json }) => {
        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.report', ctx);
        if (!providers.length) {
          return json(res, 200, { ok: false, available: false, error: '「系统自检」插件未启用' });
        }
        // body 可选：{ project: true } 时附带全项目扫描
        let body = {};
        try { body = (await bodyOf(req)) || {}; } catch { body = {}; }
        try {
          const out = providers[0].fn({ run: true, project: body.project === true });
          return json(res, 200, { ok: true, available: true, report: out?.report || null, text: out?.text || '' });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `自检执行失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 忽略 / 恢复体检单上的条目（self-doctor 的 doctor.ack 能力）。
      // 为什么需要这条路：体检单的问题都是从磁盘现状推导的，用户自查后确认某条
      // 无妨，原先没有任何地方能标记"我知道了"—— 下次体检原样回来，一直挂在警告位。
      // 忽略清单落盘在 self-doctor 自己的 plugin-data 下，跨重启生效，可随时恢复。
      method: 'POST', pattern: '/api/doctor/ack',
      handler: async ({ req, res, json }) => {
        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.ack', ctx);
        if (!providers.length) {
          return json(res, 200, { ok: false, available: false, error: '「系统自检」插件未启用' });
        }
        let body = {};
        try { body = (await bodyOf(req)) || {}; } catch { body = {}; }
        try {
          // body: { action: 'ignore'|'restore'|'restore-all', items: [{area,id}] }
          const out = providers[0].fn({
            action: String(body.action || 'ignore'),
            items: Array.isArray(body.items) ? body.items : []
          });
          return json(res, 200, { ok: true, available: true, acked: out?.acked || [] });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `忽略操作失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 全项目静态扫描（self-doctor 的 doctor.scan-project 能力）。
      // 与 /api/doctor 分开：这个明显更慢（~200ms），不该被页面轮询带着跑。
      method: 'POST', pattern: '/api/doctor/scan-project',
      handler: async ({ req, res, json }) => {
        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.scan-project', ctx);
        if (!providers.length) {
          return json(res, 200, { ok: false, available: false, error: '「系统自检」插件未启用' });
        }
        let body = {};
        try { body = (await bodyOf(req)) || {}; } catch { body = {}; }
        try {
          const out = providers[0].fn({
            rule: body.rule ? String(body.rule) : undefined,
            dir: body.dir ? String(body.dir) : undefined
          });
          return json(res, 200, { ok: true, available: true, result: out?.result || null, text: out?.text || '' });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `项目扫描失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 前缀缓存哨兵（self-doctor 的 doctor.cache-sentinel 能力）。
      // 取数 + 静态前缀体检，**不调模型** —— 分析由前端拿文本再走 /api/doctor/ask，
      // 这样"看数"免费、"让模型解读"才花 token，两者可以分开点。
      // 比 reload 慢（要读 24 个 session + 十几个插件源码，实测约 300ms），
      // 所以只由按钮触发，不进页面轮询。
      method: 'POST', pattern: '/api/doctor/cache-sentinel',
      handler: async ({ req, res, json }) => {
        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.cache-sentinel', ctx);
        if (!providers.length) {
          return json(res, 200, { ok: false, available: false, error: '「系统自检」未启用（顶部「插件」页 → self-doctor）' });
        }
        let body = {};
        try { body = (await bodyOf(req)) || {}; } catch { body = {}; }
        try {
          const out = providers[0].fn({ limit: Number(body.limit) || 16 });
          return json(res, 200, { ok: true, available: true, sentinel: out?.sentinel || null, text: out?.text || '' });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `哨兵取数失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 自检专用模型的配置读取。
      // key 用 hasApiKey 布尔（sanitizeConfig 已自动脱敏），前端要显示明文走下面的 key 端点。
      method: 'GET', pattern: '/api/doctor/config',      handler: async ({ res, json }) => {
        const cfg = getConfig();
        const d = cfg.doctorApi || {};
        return json(res, 200, {
          ok: true,
          config: {
            enabled: d.enabled === true,
            baseUrl: String(d.baseUrl || ''),
            model: String(d.model || ''),
            hasApiKey: Boolean(String(d.apiKey || '').trim())
          },
          // 全局那份（供前端展示"跟随全局"时的实际值，不暴露 key）
          global: {
            baseUrl: String(cfg.api?.baseUrl || ''),
            model: String(cfg.api?.model || ''),
            hasApiKey: Boolean(resolveApiKey(cfg))
          }
        });
      }
    },
    {
      // 自检专用配置写入：只 patch doctorApi 这一段，不碰全局 api。
      // ⚠️ apiKey 留空 = 保留原值（前端永远拿不到明文，不能靠"回传原值"来不修改）。
      method: 'POST', pattern: '/api/doctor/config',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const patch = {};
        if (body.enabled !== undefined) patch.enabled = body.enabled === true;
        if (body.baseUrl !== undefined) patch.baseUrl = String(body.baseUrl || '').trim();
        if (body.model !== undefined) patch.model = String(body.model || '').trim();
        // 空串 / 掩码 = 不修改；要清空得显式传 clearApiKey:true
        const rawKey = String(body.apiKey ?? '').trim();
        if (body.clearApiKey === true) patch.apiKey = '';
        else if (rawKey && rawKey !== '******') patch.apiKey = rawKey;
        if (!Object.keys(patch).length) return json(res, 400, { ok: false, error: '没有可写入的字段' });

        updateConfig({ doctorApi: patch });
        const d = getConfig().doctorApi || {};
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
      // 自检专用 Key 明文读取：与 /api/search-key、/api/onebot-token 同一套来源校验
      // （keyEndpointAllowed —— 只放行控制台来源，挡的是外部网页冒用 127.0.0.1）。
      method: 'GET', pattern: '/api/doctor/config-key',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const d = getConfig().doctorApi || {};
        return json(res, 200, { apiKey: String(d.apiKey || ''), hasApiKey: Boolean(String(d.apiKey || '').trim()) });
      }
    },
    {
      // 对话式排查（工具循环版）：模型不再"盲答体检单"，而是可以**自己去读**项目文件与日志。
      //
      // 为什么改成工具循环：原来只把一张预先算好的体检单文本塞进 system prompt，模型是"盲"的 ——
      // 体检单没覆盖的问题（某插件为何没加载、昨天 3 点报了什么错）它只能猜或说"不知道"。
      // 而项目里其实什么都有：源码、日志、插件数据。差的就是"让它自己去读"的能力。
      //
      // 分工：**工具层（doctor.tools 能力，由 self-doctor 插件提供）负责"给证据"**，
      //       **本层负责"调模型 + 跑循环"**，模型只负责判断与组织语言。
      //       核心仍然不 import 那个插件 —— 只按能力名问它要工具定义。
      //
      // 只读保证：工具定义里压根没有写/删/执行类工具；插件侧的沙箱（白名单目录 + realpath
      // 校验 + 后缀白名单 + 字节/行数限额）是第二道闸。本层不额外造文件访问能力。
      method: 'POST', pattern: '/api/doctor/ask',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const question = String(body.question || '').trim();
        if (!question) return json(res, 400, { ok: false, error: '缺少 question' });
        if (question.length > 2000) return json(res, 400, { ok: false, error: '问题过长（上限 2000 字）' });
        // ── 附加上下文（2026-10-23）──────────────────────────────────────
        // 为什么单独开一个字段而不是放宽 question：2000 字是给**人手输入**设的
        // 防呆（避免把一整篇文章粘进来），但哨兵的整份快照是程序生成的、
        // 动辄两三千字，塞进 question 就会被这条校验直接打回
        // （现场表现：点「哨兵分析」→ ⚠ 请求失败：问题过长（上限 2000 字））。
        // 分开之后两边各管各的：提问仍然 ≤2000，上下文单独放到 12000。
        const contextText = String(body.context || '').trim();
        if (contextText.length > 12000) {
          return json(res, 400, { ok: false, error: '附加上下文过长（上限 12000 字）' });
        }
        // 数据在前、指令在后：模型对消息末尾的指令更敏感，反过来容易"读完数据忘了要干什么"。
        const userContent = contextText ? `${contextText}\n\n${question}` : question;

        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.report', ctx);
        if (!providers.length) {
          return json(res, 200, { ok: false, available: false, error: '「系统自检」插件未启用' });
        }
        let reportText = '';
        try { reportText = providers[0].fn({ run: false })?.text || ''; } catch { /* 用空报告兜底 */ }

        // ── 取证工具（可选能力）：插件没提供 doctor.tools 时自动降级为"只有体检单"的老行为 ──
        // 这样即使装了旧版 self-doctor，这条接口也不会 500，只是少了"自己去看"的能力。
        let toolDefs = [];
        let toolCtx = null;
        try {
          const toolProviders = skillManager.getCapabilityProviders('doctor.tools', ctx);
          if (toolProviders.length) {
            const out = toolProviders[0].fn({});
            toolDefs = Array.isArray(out?.defs) ? out.defs : [];
            toolCtx = out?.ctx || null;
          }
        } catch (error) {
          logger.warn('doctor', `取证工具加载失败，降级为纯体检单模式：${String(error?.message ?? error)}`);
          toolDefs = [];
        }
        // 只放行 doctor_ 前缀的工具 —— 兜住"插件不小心把写文件工具也报上来"的情况。
        // 这是第三道闸（前两道：插件沙箱、本层不造能力）：白名单前缀 + 显式排除非只读名。
        toolDefs = toolDefs.filter((d) => {
          const id = String(d?.id || d?.name || '');
          if (!id.startsWith('doctor_')) return false;
          return !/(write|delete|remove|exec|spawn|kill|mkdir|rename|move|chmod)/i.test(id);
        });

        const cfg = getConfig();
        // ── 选哪套凭据 ──────────────────────────────────────────────────
        // doctorApi.enabled=true 且填了 model 时用自检专用（隔离，不走账号池）；
        // 否则跟随全局 api（与原行为一致）。
        // ⚠️ 传了 overrides 就绕开账号池与专用模型切换（见 llm.js:323），
        //    这正是"独立配置"该有的隔离语义 —— 用户在自检页指定什么就用什么。
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
            error: useOwn
              ? '自检专用模型未填 model（自检页 → 模型设置）'
              : '尚未配置聊天模型（设置 → 模型与搜索 → 模型 API）'
          });
        }
        if (useOwn && !overrides.baseUrl) {
          return json(res, 200, { ok: false, available: true, error: '自检专用端点未填 Base URL' });
        }

        const hasTools = toolDefs.length > 0;
        const sys = [
          '你是 QQ Agent 的运行期诊断助手。你只做**只读分析**：解释问题、给出根因假设与证据、指出下一步去哪儿看。',
          '你没有修改任何文件的能力，也不要建议直接改核心代码 —— 建议要落到"用户在 UI 的哪一页调什么"。',
          '',
          '下面是刚刚生成的系统体检单（确定性检查结果，可信）：',
          '────────',
          reportText || '（体检单为空：可能插件刚启用还没跑过）',
          '────────'
        ];
        if (hasTools) {
          sys.push(
            '',
            '你还可以**自己去读项目里的真实文件**（源码 / 日志 / 插件数据）来核实。可用工具：',
            toolDefs.map((d) => `  · ${d.id}：${String(d.description || '').split('\n')[0]}`).join('\n'),
            '使用要求：',
            '  1) 先想清楚"要验证什么"，再决定查哪个文件 —— 不要漫无目的地列目录。',
            '  2) 体检单与工具读到的内容冲突时，**以文件内容为准**（体检单是静态规则，文件是事实）。',
            '  3) 引用证据要给出**具体位置**（文件路径 + 行号 / 日志时间戳），不要只说"日志里好像有"。',
            '  4) 工具最多调用若干轮，够用就停 —— 拿到证据就直接给结论，不要为了显得勤奋而多查。',
            '  5) 工具报错（越界/不存在/被拒）是正常反馈，换个路径再试或如实说明，不要反复重试同一个。'
          );
        }
        sys.push(
          '',
          '回答要求：先给结论（一句话），再给依据（引用你**实际读到**的内容与位置），最后给可执行的动作。',
          '不确定就说不确定。**绝对不要编造你没读过的日志内容或代码行** —— 没查到的就说没查到。'
        );

        try {
          // overrides 为 null 时跟随全局 api（与原行为一致）；非 null 时用自检专用配置。
          // 超时用 AbortSignal（chatCompletion 不接受 timeoutMs —— 只有 signal 能中断）。
          const ac = new AbortController();
          // 总预算 180s：比原来的 120s 放宽，因为现在可能要跑若干轮工具。
          const timer = setTimeout(() => ac.abort(new Error('诊断请求超时（180s）')), 180000);

          const messages = [
            { role: 'system', content: sys.join('\n') },
            { role: 'user', content: userContent }
          ];
          const openAiTools = hasTools ? toOpenAiTools(toolDefs) : undefined;
          // 轮次上限：每轮可并行多个工具调用，6 轮足够"查文件→看日志→再确认"这种三跳推理，
          // 又不会让失控的模型无限烧 token。实测 5 轮偏紧（模型查到一半就被截断），故留 6。
          const MAX_ROUNDS = 6;
          const trace = [];        // 给 UI 看的工具调用轨迹（谁、参数、结果摘要）
          let answer = '';
          let rounds = 0;

          try {
            for (let round = 0; round < MAX_ROUNDS; round++) {
              rounds = round + 1;
              // ── 收口提醒（学 orchestrator 的"剩余轮次提醒"）──
              // 没有它时实测模型会**一直查**：日志有几千行，它翻到第 5 轮还在 grep，
              // 最后给不出结论（真跑过一次：5 轮 10 次工具调用，最终回答为空）。
              // 倒数第 2 轮起明确告诉它"该收口了"，逼它把已经读到的证据组织成答案。
              // 只在有工具时加 —— 没工具的单轮模式本来就会直接出正文。
              const left = MAX_ROUNDS - round;
              if (hasTools && left <= 2 && left > 0) {
                messages.push({
                  role: 'user',
                  content: `【系统提醒】取证轮次只剩 ${left} 轮。请**立刻停止调用工具**，用你已经读到的内容直接给出结论。`
                    + `如果证据不足以回答，就如实说明"已查到的部分是什么、还缺什么"，不要继续翻找。`
                });
              }
              const r = await chatCompletionWithRetry({
                messages,
                tools: openAiTools,
                temperature: 0.2,
                signal: ac.signal,
                overrides,
                // ⚠️ 取证场景必须关思考，理由与 /api/doctor/triage 完全相同（见该处注释）：
                //    deepseek-flash 等服务端强制思考的模型，reasoning token 从 max_tokens 里扣，
                //    不关的话每轮都在为"想"付费 —— 而取证要的是"读文件"，推理反而是噪声。
                //    日志实证：triage 关了 → mt=1200 正常工作；ask 没关 → mt=0 且 reasoning 全额计费。
                skillContext: { thinkingMode: 'off' },
                tag: `doctor-ask:r${round}`
              });
              // ⚠️ chatCompletion 返回 { message: { content, tool_calls } }，顶层没有 content。
              const msg = r?.message || {};
              const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

              if (!calls.length) {
                // 没有工具调用 = 模型认为证据够了，这一轮的正文就是答案。
                answer = typeof msg.content === 'string' ? msg.content : '';
                break;
              }

              // 把 assistant 这一轮（含 tool_calls）回填进历史 —— 不回填的话下一轮
              // 请求会缺 tool 消息对应的 tool_call_id，OpenAI 协议直接 400。
              messages.push(assistantHistoryEntry(msg, { tool_calls: calls }));
              for (const call of calls) {
                if (ac.signal.aborted) break;
                const name = call?.function?.name || '';
                const argsRaw = call?.function?.arguments ?? '{}';
                let args = {};
                try { args = JSON.parse(argsRaw); } catch { args = { _raw: argsRaw }; }
                const result = await executeTool(toolDefs, toolCtx, name, argsRaw);
                const text = typeof result.content === 'string'
                  ? result.content
                  : (Array.isArray(result.content)
                    ? result.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
                    : String(result.content ?? ''));
                messages.push({
                  role: 'tool',
                  tool_call_id: call.id,
                  name,
                  content: text
                });
                trace.push({
                  round: rounds,
                  tool: name,
                  args,
                  isError: !!result.isError,
                  summary: text.replace(/\s+/g, ' ').slice(0, 200),
                  bytes: text.length
                });
              }
            }
          } finally {
            clearTimeout(timer);
          }

          if (!String(answer).trim()) {
            // 到轮次上限还没收口（模型一直在查不写结论）—— 用最后一次工具轨迹说明情况，
            // 而不是返回空字符串让用户面对一片空白。这种情况已加"收口提醒"缓解，
            // 但小模型仍偶发，所以兜底文案要**告诉用户下一步怎么办**，而不是只报个失败。
            if (trace.length) {
              const used = [...new Set(trace.map((t) => t.tool))].join('、');
              answer = `（模型在 ${MAX_ROUNDS} 轮取证后仍未给出结论。它已调用 ${trace.length} 次工具：${used}。`
                + `可以追问"直接给结论"，或缩小问题范围——比如指定文件名/时间段，减少它需要翻找的范围。）`;
            } else {
              answer = '（模型没有返回内容）';
            }
          }
          return json(res, 200, {
            ok: true, available: true, answer, model: modelName,
            ownConfig: useOwn, cachedReport: Boolean(reportText),
            toolsEnabled: hasTools, toolCount: toolDefs.length,
            rounds, trace
          });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `模型调用失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 模型逐个审（triage）：把静态扫描的候选交给模型，读**该文件真实源码**判断真伪。
      //
      // 为什么在这里（而不是插件里）调模型：LLM 访问是本层（routes.js）的职责 ——
      // 插件层保持零 LLM 依赖，只负责扫/分组/读源码/拼 prompt（doctor.triage 能力）。
      // 这样"换成别的模型渠道/加缓存/billing tag"都只需动这一处。
      //
      // 成本控制：按文件分组（多命中合成一次调用）、只审 warning+、串行、可中断。
      // 流式推进：每审完一个文件就往 SSE 推一条进度，UI 实时刷新（不必干等全部完成）。
      method: 'POST', pattern: '/api/doctor/triage',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.triage', ctx);
        if (!providers.length) {
          return json(res, 200, { ok: false, available: false, error: '「系统自检」插件未启用（或版本过旧，缺 doctor.triage 能力）' });
        }

        // ① 准备待审批（插件侧：扫描 + 分组 + 读源码 + 拼 prompt，不碰模型）
        let prep;
        try { prep = providers[0].fn({ severities: body.severities }); } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `准备待审批失败：${String(error?.message ?? error)}` });
        }
        if (!prep.batches.length) {
          return json(res, 200, {
            ok: true, available: true, verdicts: {}, stats: { ...prep.stats, reviewed: 0, failed: 0 },
            note: '没有 warning 及以上的候选，无需模型介入'
          });
        }

        // ② 选凭据（与 /api/doctor/ask 完全同源，保证"模型设置"对两者都生效）
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
            error: useOwn ? '自检专用模型未填 model（自检页 → 模型设置）' : '尚未配置聊天模型（设置 → 模型与搜索 → 模型 API）'
          });
        }

        // ③ 串行逐个审（串行 = 成本可控 + 可中途中断；并发会让费用和限流都不可控）
        const rawReplies = {};
        let reviewed = 0, failed = 0, aborted = false;
        const maxCalls = Math.max(1, Math.min(Number(body.maxCalls) || 60, 200));   // 硬上限
        const queue = prep.batches.slice(0, maxCalls);
        for (const batch of queue) {
          if (req.destroyed || res.writableEnded) { aborted = true; break; }   // 客户端断开就停
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(new Error('单文件审阅超时（60s）')), 60000);
          try {
            const r = await chatCompletion({
              messages: [
                { role: 'system', content: batch.sys },
                { role: 'user', content: batch.user }
              ],
              temperature: 0,
              signal: ac.signal,
              overrides,
              maxTokens: 1200,
              // ⚠️ 判分类请求**必须**关思考。不关的话 thinking-adapters 会给 body 加上
              //    reasoning 参数，而 DeepSeek 系推理模型的 reasoning token 从 max_tokens
              //    里扣 —— 实测 maxTokens:1200 时 reasoning 就吃掉 1200，finish_reason=length、
              //    content 为空字符串。表现是"审阅完成但一条结论都没有"，静默失败。
              //    thinking-adapters 已为此提供了官方的按次覆盖口子（context.thinkingMode）。
              skillContext: { thinkingMode: 'off' },
              tag: 'doctor-triage'
            });
            // ⚠️ 必须同时看 message.content 和顶层 content —— chatCompletion 返回的是
            //    { message: {content}, finishReason, usage, ... }，顶层没有 content。
            //    只取 r.content 会永远拿到 undefined，表现为"审阅完成但零结论"。
            const text = r?.message?.content || r?.content || '';
            // 空正文 = 这次没判出东西（多半是被 reasoning 吃光了 max_tokens），
            // 记为失败而不是"成功但无结论"，否则问题会被静默吞掉。
            if (!String(text).trim()) {
              failed++;
              try {
                emit?.('doctor-triage', {
                  file: batch.file,
                  error: `模型返回空正文（finishReason=${r?.finishReason || '?'}，可能是思考 token 吃光了 max_tokens）`,
                  done: reviewed + failed, total: queue.length
                });
              } catch { /* ignore */ }
              continue;
            }
            rawReplies[batch.file] = text;
            reviewed++;
            // 进度推送：UI 可实时看到审到哪了（不必干等全部审完）
            try { emit?.('doctor-triage', { file: batch.file, done: reviewed + failed, total: queue.length }); } catch { /* 推送失败不影响结果 */ }
          } catch (error) {
            failed++;
            try { emit?.('doctor-triage', { file: batch.file, error: String(error?.message ?? error), done: reviewed + failed, total: queue.length }); } catch { /* ignore */ }
          } finally {
            clearTimeout(timer);
          }
        }

        // ④ 解析 + 合并（解析逻辑归插件 —— 输出格式的所有权在定义 prompt 的那一方）
        const parseProviders = skillManager.getCapabilityProviders('doctor.triage-parse', ctx);
        const parsed = parseProviders.length
          ? parseProviders[0].fn({ batches: queue, replies: rawReplies })
          : { files: {}, entries: [] };

        return json(res, 200, {
          ok: true, available: true, model: modelName, ownConfig: useOwn,
          verdicts: parsed.files,               // { 文件相对路径: [{index, verdict, reason}] }
          entries: parsed.entries,              // 扁平 [{key, verdict, reason}]，UI 标注用
          stats: { ...prep.stats, reviewed, failed, aborted, capped: prep.batches.length > maxCalls }
        });
      }
    },
  ];
}
